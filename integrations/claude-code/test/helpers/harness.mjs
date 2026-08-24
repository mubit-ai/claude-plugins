// @ts-check
/**
 * Shared test harness for the `mubit-memory` Claude Code plugin.
 *
 * Constraints, mirroring the plugin itself:
 *   - Node >= 20 built-ins only. Zero dependencies, no test framework.
 *   - No real network, no Docker, no real Mubit. The whole suite must run in < 10s.
 *   - Every test gets its own `${CLAUDE_PLUGIN_DATA}` under a temp dir.
 *
 * Read this file before writing a test. Everything you need is here; do not
 * invent a second harness.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync,
  writeFileSync, readdirSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to `integrations/claude-code/`. */
export const PLUGIN_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Absolute path to the repo root (five levels up from this file). */
export const REPO_ROOT = resolve(PLUGIN_ROOT, '../..');

const _cleanups = [];
process.on('exit', () => {
  for (const fn of _cleanups.splice(0)) { try { fn(); } catch { /* best effort */ } }
});

// ---------------------------------------------------------------------------
// Temp state
// ---------------------------------------------------------------------------

/**
 * Fresh temp directory, removed when the test process exits.
 * @param {string} [prefix]
 * @returns {string}
 */
export function tempDir(prefix = 'mubit-cc-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  _cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A fresh `${CLAUDE_PLUGIN_DATA}` root with the §7 directory skeleton pre-created.
 * Pass the result as `MUBIT_CC_DATA_DIR` (and `CLAUDE_PLUGIN_DATA`).
 * @returns {string}
 */
export function makeDataDir() {
  const dir = tempDir('mubit-cc-data-');
  for (const sub of ['sessions', 'runs', 'status', 'breaker', 'policy', 'logs', 'tmp']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return dir;
}

/**
 * A fresh fake project directory. Optionally `git init`s it so run-id strategies
 * that shell out to git have something real to find.
 * @param {{git?: boolean, branch?: string, files?: Record<string,string>}} [opts]
 * @returns {string}
 */
export function makeProjectDir(opts = {}) {
  const dir = tempDir('mubit-cc-proj-');
  for (const [rel, body] of Object.entries(opts.files ?? {})) {
    const p = join(dir, rel);
    mkdirSync(resolve(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
  if (opts.git) {
    const run = (args) => spawnSyncQuiet('git', args, dir);
    run(['init', '-q']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);
    run(['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(dir, '.gitkeep'), '');
    run(['add', '-A']);
    run(['commit', '-qm', 'init']);
    if (opts.branch) run(['checkout', '-qb', opts.branch]);
  }
  return dir;
}

function spawnSyncQuiet(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, stdio: 'ignore' });
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * A complete, deterministic environment for a hook or lib under test.
 * Everything the plugin reads is pinned so a test never depends on the
 * developer's shell.
 *
 * @param {object} o
 * @param {string} o.dataDir       `${CLAUDE_PLUGIN_DATA}` (see makeDataDir)
 * @param {string} [o.endpoint]    Mubit base URL — usually `server.url`
 * @param {string} [o.apiKey]
 * @param {string} [o.projectDir]  `${CLAUDE_PROJECT_DIR}`
 * @param {string} [o.pluginRoot]  `${CLAUDE_PLUGIN_ROOT}`; defaults to this plugin. The
 *   sibling `integrations/codex` suite passes its own root — every other caller wants the
 *   default, and passing one is the only way the two suites can share this file.
 * @param {Record<string,string>} [o.extra] any MUBIT_CC_* / CLAUDE_PLUGIN_OPTION_* overrides
 * @returns {Record<string,string>}
 */
export function baseEnv(o) {
  const env = {
    // Inherit only what Node itself needs; everything else is explicit.
    PATH: process.env.PATH ?? '',
    HOME: o.dataDir,
    NODE_OPTIONS: '',
    TZ: 'UTC',

    CLAUDE_PLUGIN_ROOT: o.pluginRoot ?? PLUGIN_ROOT,
    CLAUDE_PLUGIN_DATA: o.dataDir,
    CLAUDE_PROJECT_DIR: o.projectDir ?? o.dataDir,

    MUBIT_CC_DATA_DIR: o.dataDir,
    MUBIT_ENDPOINT: o.endpoint ?? 'https://mubit.example.com',
    MUBIT_API_KEY: o.apiKey ?? 'mbt_test_0123456789abcdef_deadbeefcafebabe0123456789abcdef',
    MUBIT_CC_LOG_LEVEL: 'error',
    // Tests must never inherit the MCP server's poisoned default (§4.3).
    MUBIT_DEFAULT_SESSION_ID: '',
  };
  return { ...env, ...(o.extra ?? {}) };
}

/**
 * Run `fn` with `process.env` temporarily patched. Restores on return or throw.
 * Use for in-process lib tests; hooks get their env through `runHook`.
 * @template T
 * @param {Record<string,string|undefined>} patch
 * @param {() => T} fn
 * @returns {T}
 */
export function withEnv(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Fake Mubit
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RecordedRequest
 * @property {string} method
 * @property {string} path      pathname only, no query
 * @property {URLSearchParams} query
 * @property {Record<string,string>} headers
 * @property {any} body         parsed JSON when possible, else the raw string
 * @property {string} raw
 * @property {number} at        Date.now() at receipt
 */

/**
 * @typedef {object} RouteReply
 * @property {number} [status]   default 200
 * @property {any}    [json]     serialized as JSON
 * @property {string} [text]     sent verbatim (use for GET /v2/core/health -> "OK")
 * @property {number} [delayMs]  server-side stall, for budget/timeout tests
 * @property {boolean} [hang]    never respond (socket held open)
 */

/**
 * Stand up a fake Mubit on 127.0.0.1:0.
 *
 * Routes are keyed `"<METHOD> <pathname>"`. A value may be:
 *   - a RouteReply object            → same reply every time
 *   - an array of RouteReply         → replies in order; the last repeats
 *   - a function (req) => RouteReply → computed per call
 *
 * Unrouted requests get 404 `{"error":"no route"}` and are still recorded, so
 * "the hook called something it should not have" is always visible.
 *
 * @param {Record<string, RouteReply|RouteReply[]|((r: RecordedRequest) => RouteReply)>} [routes]
 * @returns {Promise<{
 *   url: string, port: number, requests: RecordedRequest[],
 *   route(key: string, reply: any): void,
 *   calls(method: string, path: string): RecordedRequest[],
 *   lastCall(method: string, path: string): RecordedRequest|undefined,
 *   countOf(method: string, path: string): number,
 *   assertCalled(method: string, path: string, times?: number): void,
 *   assertNotCalled(method: string, path: string): void,
 *   reset(): void,
 *   close(): Promise<void>,
 * }>}
 */
export async function fakeMubit(routes = {}) {
  /** @type {RecordedRequest[]} */
  const requests = [];
  const table = { ...defaultRoutes(), ...routes };
  /** @type {Map<string, number>} */
  const cursor = new Map();

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      /** @type {RecordedRequest} */
      const rec = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: /** @type {any} */ (req.headers),
        raw,
        body: safeJson(raw),
        at: Date.now(),
      };
      requests.push(rec);

      const key = `${rec.method} ${rec.path}`;
      let entry = table[key];
      if (typeof entry === 'function') entry = entry(rec);
      if (Array.isArray(entry)) {
        const i = cursor.get(key) ?? 0;
        cursor.set(key, i + 1);
        entry = entry[Math.min(i, entry.length - 1)];
      }
      /** @type {RouteReply} */
      const reply = entry ?? { status: 404, json: { error: 'no route', route: key } };

      const send = () => {
        if (reply.hang) return; // deliberately never answer
        const status = reply.status ?? 200;
        if (typeof reply.text === 'string') {
          res.writeHead(status, { 'content-type': 'text/plain' });
          res.end(reply.text);
        } else {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(reply.json ?? {}));
        }
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs).unref?.();
      else send();
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // Unref the listening handle. A test that fails before its `await server.close()` would
  // otherwise leave an open handle, keep the test process alive, and hang the whole run —
  // and in a suite written before the implementation, *every* test fails. The server still
  // serves normally while anything else keeps the loop alive, which is the entire lifetime
  // of a test that is awaiting a request.
  server.unref();
  const port = /** @type {any} */ (server.address()).port;
  const api = {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    route(key, reply) { table[key] = reply; cursor.delete(key); },
    calls(method, path) { return requests.filter((r) => r.method === method && r.path === path); },
    lastCall(method, path) { return api.calls(method, path).at(-1); },
    countOf(method, path) { return api.calls(method, path).length; },
    assertCalled(method, path, times) {
      const n = api.countOf(method, path);
      if (times === undefined) {
        assert.ok(n > 0, `expected at least one ${method} ${path}; saw: ${api.summary()}`);
      } else {
        assert.equal(n, times, `expected ${times}x ${method} ${path}, got ${n}; saw: ${api.summary()}`);
      }
    },
    assertNotCalled(method, path) {
      assert.equal(api.countOf(method, path), 0,
        `expected NO ${method} ${path}; saw: ${api.summary()}`);
    },
    summary() { return requests.map((r) => `${r.method} ${r.path}`).join(', ') || '(none)'; },
    reset() { requests.length = 0; cursor.clear(); },
    close() { return new Promise((r) => server.close(() => r(undefined))); },
  };
  _cleanups.push(() => server.close());
  return api;
}

/** Happy-path replies for every route the plugin knows how to call. */
export function defaultRoutes() {
  return {
    'GET /v2/core/health': { text: 'OK' },
    'POST /v2/control/agents/register': { json: { success: true } },
    'POST /v2/control/agents/heartbeat': { json: { success: true } },
    'POST /v2/control/ingest': {
      json: { accepted: true, job_id: 'job_test_1', deduplicated: false, status: 'queued' },
    },
    'GET /v2/control/ingest/jobs/job_test_1': {
      json: { job_id: 'job_test_1', run_id: 'r', status: 'completed', done: true, error: '' },
    },
    'POST /v2/control/query': { json: queryResponse() },
    'POST /v2/control/context': { json: contextResponse() },
    'POST /v2/control/outcome': { json: { success: true, reinforcement_count: 1, updated_confidence: 0.7 } },
    'POST /v2/control/checkpoint': { json: { success: true, checkpoint_id: 'ckpt_test_1', token_estimate: 3400 } },
    'POST /v2/control/reflect': {
      json: {
        lessons: [{ lesson_id: 'les_1', content: 'When X, do Y.', lesson_type: 'failure', scope: 'run', importance: 'high' }],
        summary: 'ok', confidence: 0.71, degraded: false, lessons_stored: 1,
      },
    },
    'POST /v2/control/lessons': {
      json: {
        lessons: [
          { lesson_id: 'les_g1', content: 'Run the migration before starting the server.', lesson_type: 'rule', scope: 'global', importance: 'high' },
        ],
      },
    },
    'POST /v2/control/memory_health': { json: { healthy: true } },
    'POST /v2/control/diagnose': { json: { findings: [] } },
    // The pin refresh the detached drainer makes in its tail (`lib/pins.mjs`). Answering it
    // here rather than in each drain fixture keeps a 404 out of every suite that spawns a
    // drain for some other reason — an unrouted request is recorded AND counts as a failure
    // against the breaker, which would make the pin refresh look like an instance fault.
    'POST /v2/control/variables/list': { json: { variables: [] } },
    'POST /v2/control/variables/set': { json: { success: true } },
    'POST /v2/control/variables/delete': { json: { success: true } },
  };
}

/**
 * A realistic `AgentQueryResponse`. `reference_id` — not `id` — is what feeds
 * `RecordOutcome.entry_ids` (control.proto).
 * @param {Partial<{evidence: any[], routing_summary: string}>} [over]
 */
export function queryResponse(over = {}) {
  return {
    final_answer: '',
    confidence: 0.6,
    mode: 'direct_bypass',
    degraded: false,
    consulted_runs: [],
    routing_summary: 'direct_bypass',
    signals: {},
    citations: [],
    evidence: [
      evidence({ id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule', score: 0.91,
        content: 'Ingest returns when queued, not when stored; poll the job.' }),
      evidence({ id: 'e2', reference_id: 'ref_lesson_1', entry_type: 'lesson', score: 0.84,
        content: 'A job stays queued until indexing completes.' }),
      evidence({ id: 'e3', reference_id: 'ref_fact_1', entry_type: 'fact', score: 0.55,
        content: 'IngestAccepted.status is always "queued" on success.' }),
    ],
    ...over,
  };
}

/** @param {Partial<Record<string, any>>} over */
export function evidence(over = {}) {
  return {
    id: 'e0', content: 'content', source: 'agent', score: 0.5, run_id: 'cc-test-0000',
    entry_type: 'fact', metadata_json: '{}', retrieval_mode: 'semantic_search',
    reference_id: 'ref_0', referenceable: true, origin_entry_type: '',
    is_stale: false, superseded_by: '', explain_info: '', knowledge_confidence: 0.5,
    ...over,
  };
}

/** @param {Partial<Record<string, any>>} over */
export function contextResponse(over = {}) {
  return {
    context_block: '## Active rules\n- Poll the ingest job.\n',
    token_estimate: 42,
    sources: ['ref_rule_1'],
    budget_used: 42, budget_remaining: 1458,
    section_summaries: [{ section: 'active_rules', count: 1 }],
    source_counts_by_entry_type: { rule: 1 },
    source_counts_by_retrieval_mode: { semantic_search: 1 },
    evidence_candidates_considered: 3,
    evidence_dropped_by_budget: 0,
    exact_references_surfaced: 1,
    empty_reason: '',
    ...over,
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }

// ---------------------------------------------------------------------------
// Running hooks
// ---------------------------------------------------------------------------

/**
 * @typedef {object} HookResult
 * @property {number|null} code    process exit code — the plugin must ALWAYS be 0
 * @property {string} stdout
 * @property {string} stderr
 * @property {any} json            parsed stdout, or `undefined` when stdout was empty
 * @property {number} ms           wall clock
 * @property {string|null} signal  the signal that killed it, when `killAfterMs` took it away
 */

/**
 * Spawn a hook exactly the way Claude Code does: a fresh node process, the
 * payload on stdin, JSON on stdout.
 *
 * Defaults to `hooks/src/<name>.mjs` so you can iterate without rebuilding.
 * Set `target: 'dist'` (or `MUBIT_CC_TEST_TARGET=dist`) to run the shipped bundle.
 *
 * `killAfterMs` SIGKILLs the hook that many milliseconds in, which is the only way to
 * reproduce what the host actually does: under `--print` Claude Code tears the session down
 * about a second into `SessionEnd` — a cancellation, not a timeout, so no budget on either
 * side of the boundary saves the work. A hook whose work has to outlive its process can only
 * be tested by taking the process away. The kill is best-effort: a hook that already handed
 * its work over and exited is simply not there to receive it, which is the passing case.
 *
 * `root` names the plugin whose `hooks/` to run, defaulting to this one. It is what lets
 * the sibling `integrations/codex` suite drive its own two-line entry points through this
 * function instead of forking it — the spawn, the stdin protocol and the contract assertions
 * are identical, and a second copy of them would be a second thing to keep true.
 *
 * @param {string} name  e.g. 'capture', 'prompt-recall'
 * @param {object} payload  the stdin JSON (see fixtures.mjs)
 * @param {{env?: Record<string,string>, args?: string[], timeoutMs?: number,
 *          target?: 'src'|'dist', stdinRaw?: string, killAfterMs?: number,
 *          root?: string}} [opts]
 * @returns {Promise<HookResult>}
 */
export async function runHook(name, payload, opts = {}) {
  const root = opts.root ?? PLUGIN_ROOT;
  const target = opts.target ?? (process.env.MUBIT_CC_TEST_TARGET === 'dist' ? 'dist' : 'src');
  const script = target === 'dist'
    ? join(root, 'hooks', 'dist', `${name}.mjs`)
    : join(root, 'hooks', 'src', `${name}.mjs`);
  if (!existsSync(script)) {
    throw new Error(
      `hooks/${target}/${name}.mjs does not exist yet under ${root}.\n` +
      `That is the red state: write it, then re-run this test.`);
  }
  const started = Date.now();
  const child = spawn(process.execPath, [script, ...(opts.args ?? [])], {
    env: opts.env ?? baseEnv({ dataDir: makeDataDir(), pluginRoot: root }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const raw = opts.stdinRaw ?? JSON.stringify(payload ?? {});
  child.stdin.end(raw);

  const killAt = Number(opts.killAfterMs) > 0 ? Number(opts.killAfterMs) : 0;
  const killer = killAt
    ? setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, killAt)
    : null;

  const done = await new Promise((res, rej) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); rej(new Error(`hook ${name} exceeded ${opts.timeoutMs ?? 15000}ms`)); },
      opts.timeoutMs ?? 15000);
    const stop = () => { clearTimeout(t); if (killer) clearTimeout(killer); };
    child.on('close', (c, s) => { stop(); res({ code: c, signal: s ?? null }); });
    child.on('error', (e) => { stop(); rej(e); });
  });

  return {
    code: done.code, signal: done.signal, stdout: out, stderr: err, ms: Date.now() - started,
    json: out.trim() ? safeJson(out.trim()) : undefined,
  };
}

/**
 * The cost of starting `node` and doing nothing, measured now. Best of three, because the
 * quantity wanted is the floor, not the average.
 *
 * Every hook budget in this suite is asserted against a *spawned child*, so every measurement
 * carries this term whether or not anyone accounts for it. Measuring it beats the constant
 * `failure.test.mjs:53` uses (`NODE_STARTUP_ALLOWANCE_MS = 900`) for the same reason a measured
 * anything beats a guessed one: it is right on a fast machine and on a loaded one.
 *
 * @returns {number} ms
 */
function bareSpawnMs() {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const started = Date.now();
    spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    samples.push(Date.now() - started);
  }
  return Math.min(...samples);
}

/**
 * Assert a hook's own cost stayed inside its budget, without letting the test runner's load
 * cast the deciding vote.
 *
 * Two things corrupt a naive `assert.ok(r.ms < BUDGET)` here, and they compound:
 *
 *   1. **`npm test` is its own load.** `node --test` takes a glob and runs the suite's files
 *      concurrently, each spawning hooks of its own. Measured during three concurrent suites,
 *      one `capture` run ranged 180-957 ms — on identical code that costs 100 ms idle. A single
 *      sample reports the machine, not the hook.
 *   2. **Most of the number is not the hook.** Starting `node` costs ~47 ms idle here before
 *      the hook's first statement. `capture` costs ~100 ms, so its own share is ~53 ms —
 *      which is the ~40 ms §5.4 actually budgets, plus change.
 *
 * So the measurement is the best of a few samples *minus the spawn floor measured under the
 * same conditions*, and `budgetMs` means "what this hook may add on top of starting node".
 * Under the 3× load above that difference stayed within 93-310 ms while the raw wall clock
 * passed 950 ms — noisy, because parsing a bundle contends for CPU differently than spawning
 * does, but no longer a lottery.
 *
 * The fast path costs nothing: a first sample already under budget returns immediately, which
 * is every run on an idle machine. Only a miss pays for resampling and for measuring the floor.
 *
 * This is a guard-rail against a gross regression — a sleep, a retry loop, a directory walk —
 * and not a stopwatch. It is *not* what stops a hook dialing the network: the tests that care
 * assert `server.requests.length === 0`, which is exact and cannot be talked out of by a fast
 * local socket.
 *
 * `resample` must run the hook in a *fresh* data dir; the correctness assertions have already
 * been made against the first run and must not see a second one's writes.
 *
 * @param {string} label            e.g. 'capture --stop'
 * @param {number} budgetMs         allowed cost above a bare `node` spawn
 * @param {number} firstMs          the run the test already made
 * @param {() => Promise<number>} resample
 * @param {number} [extraSamples]
 */
export async function assertWithinBudget(label, budgetMs, firstMs, resample, extraSamples = 2) {
  if (firstMs < budgetMs) return;
  const samples = [firstMs];
  for (let i = 0; i < extraSamples; i++) samples.push(await resample());

  const best = Math.min(...samples);
  const floor = bareSpawnMs();
  const own = best - floor;
  assert.ok(own < budgetMs,
    `${label} cost ${own}ms above a bare node spawn; budget is ${budgetMs}ms. `
    + `Best of ${samples.length} samples was ${best}ms (${samples.map((m) => `${m}ms`).join(', ')}) `
    + `against a ${floor}ms spawn floor measured just now. Contention inflates both terms, so a `
    + 'difference this large is the hook, not the runner.');
}
/**
 * Assert the universal hook contract: exit 0, and stdout is either empty or
 * parseable JSON. Every hook in this plugin satisfies this in every mode,
 * including every failure mode (§4.9).
 * @param {HookResult} r
 */
export function assertHookContract(r) {
  assert.equal(r.code, 0, `hook must exit 0, got ${r.code}. stderr:\n${r.stderr}`);
  if (r.stdout.trim()) {
    assert.notEqual(typeof r.json, 'string',
      `stdout must be JSON, got:\n${r.stdout}`);
  }
}

// ---------------------------------------------------------------------------
// The MCP server, over real stdio
// ---------------------------------------------------------------------------

/**
 * Drive the plugin's MCP server over real newline-delimited JSON-RPC — build-guide §8.
 *
 * Everything else in this file stubs the server out: `test/launch.test.mjs` swaps
 * `./server.js` for a module that snapshots `process.env`, which is the right tool for the
 * launcher's ordering guarantee and says nothing about what the *server* then does with
 * those values. The allowlist is only observable here, at `tools/list`, because filtering
 * happens inside the bundle at registration time. That gap is how a server which ignores
 * `MUBIT_MCP_TOOLS` shipped past 650 green tests.
 *
 * Runs `mcp/dist/index.js` — the committed bundle `.mcp.json` actually points at, not
 * `mcp/src/launch.mjs`. The bundle is the product; there is no build step at install time.
 *
 * `initialize` first, then every step in order, collected by JSON-RPC id. A step's failure
 * is returned rather than thrown: `tools/call` failing is a result some tests assert on,
 * and only the caller knows which.
 *
 * `init` is the whole `initialize` result, not just `serverInfo`: `instructions` rides in
 * the same object and is the only Mubit context a subagent or a tool-search session gets,
 * so `test/mcp-instructions.test.mjs` reads it from here (`mcpListTools` narrows to the
 * server identity and would drop it).
 *
 * @param {{extra?: Record<string,string>, endpoint?: string, dataDir?: string,
 *          runId?: string, steps?: Array<{method: string, params?: any}>,
 *          timeoutMs?: number, root?: string}} [opts]
 * @returns {Promise<{init: any, results: Array<{result?: any, error?: any}>, stderr: string}>}
 */
export async function mcpDrive(opts = {}) {
  const root = opts.root ?? PLUGIN_ROOT;
  const entry = join(root, 'mcp', 'dist', 'index.js');
  if (!existsSync(entry)) {
    throw new Error(`mcp/dist/index.js does not exist yet: ${entry}\n  Run \`npm run build\`.`);
  }

  const env = baseEnv({
    dataDir: opts.dataDir ?? makeDataDir(),
    pluginRoot: root,
    // No network by default: port 1 is where nothing listens. A caller that needs the
    // server to actually reach something passes a `fakeMubit` url instead.
    endpoint: opts.endpoint ?? 'http://127.0.0.1:1',
    apiKey: 'mbt_test_0123456789abcdef_deadbeefcafebabe0123456789abcdef',
    extra: {
      // The launcher refuses to import the server at all if deriveRunId throws, and a
      // per-directory derivation over a temp dir is a git call this test does not need.
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: opts.runId ?? 'mcp-surface-test-run',
      ...(opts.extra ?? {}),
    },
  });

  const steps = opts.steps ?? [];
  const child = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const timeoutMs = opts.timeoutMs ?? 15_000;

  let buf = '', stderr = '', settled = false;
  child.stderr.on('data', (d) => { stderr += d; });

  return new Promise((res, rej) => {
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      fn(v);
    };
    const fail = (why) => finish(rej, new Error(`${why}\n  server stderr:\n${stderr || '(silent)'}`));
    const timer = setTimeout(() => fail(`MCP server did not answer within ${timeoutMs}ms`), timeoutMs);
    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

    // A bundle Node cannot parse dies here rather than answering — the failure a test that
    // imports the source can never see.
    child.on('error', (e) => fail(`could not spawn the MCP server: ${e.message}`));
    child.on('close', (code) => fail(`the MCP server exited (code ${code}) before answering`));

    let init = null;
    const results = new Array(steps.length).fill(null);
    let outstanding = steps.length;

    child.stdout.on('data', (d) => {
      buf += d;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        // Anything on stdout that is not a JSON-RPC frame is itself the bug: on a stdio
        // transport that channel carries the protocol and one stray byte breaks the host.
        try { msg = JSON.parse(line); } catch { return fail(`the server wrote non-protocol bytes to stdout: ${line}`); }

        if (msg.id === 1) {
          init = msg.result ?? null;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          if (!steps.length) return finish(res, { init, results, stderr });
          steps.forEach((s, i) => send({ jsonrpc: '2.0', id: i + 2, method: s.method, params: s.params ?? {} }));
        } else if (typeof msg.id === 'number' && msg.id >= 2) {
          const i = msg.id - 2;
          if (i < 0 || i >= results.length || results[i] !== null) continue;
          results[i] = { result: msg.result, error: msg.error };
          if (--outstanding === 0) finish(res, { init, results, stderr });
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mubit-plugin-test', version: '1' },
      },
    });
  });
}

/**
 * What the server advertises at `tools/list` — the surface a model is handed.
 *
 * No network: the endpoint is port 1, where nothing listens. `tools/list` is answered from
 * the server's local tool table, so no request is ever made. The API key is a fixture the
 * launcher only has to find non-empty, and the data dir is a fresh temp tree — a test that
 * resolved the real one would write its fixture config into the developer's own install.
 *
 * @param {{extra?: Record<string,string>, timeoutMs?: number, root?: string}} [opts]
 *   `extra` overrides env (e.g. `MUBIT_MCP_TOOLS`) for this launch only; `root` picks which
 *   plugin's `mcp/dist/index.js` to launch.
 * @returns {Promise<{server: any, tools: any[], names: string[], stderr: string}>}
 */
export async function mcpListTools(opts = {}) {
  const { init, results, stderr } = await mcpDrive({
    ...opts,
    steps: [{ method: 'tools/list' }],
  });
  const { result, error } = results[0] ?? {};
  if (!result) {
    throw new Error(`tools/list failed: ${JSON.stringify(error ?? null)}\n`
      + `  server stderr:\n${stderr || '(silent)'}`);
  }
  const tools = result.tools ?? [];
  return { server: init?.serverInfo ?? null, tools, names: tools.map((t) => t.name).sort(), stderr };
}

/**
 * Invoke one tool for real and hand back both the tool result and, through the caller's
 * `fakeMubit`, everything the server put on the wire to answer it.
 *
 * This is the only helper that lets the server reach a network, and that is the point:
 * `mcpListTools` proves what is *advertised*, and nothing here proved what a write
 * actually *sends*. Point `endpoint` at a `fakeMubit` and assert on `server.lastCall(...)`.
 *
 * A tool that fails is returned, not thrown — `isError` and `text` carry the server's own
 * account of it, which several tests assert on directly.
 *
 * @param {string} name  the tool, e.g. `mubit_learned`
 * @param {Record<string, any>} [args]  the tool's arguments
 * @param {{extra?: Record<string,string>, endpoint?: string, dataDir?: string,
 *          runId?: string, timeoutMs?: number, root?: string}} [opts]
 * @returns {Promise<{server: any, result: any, error: any, text: string, json: any,
 *                   isError: boolean, stderr: string}>}
 */
export async function mcpCallTool(name, args = {}, opts = {}) {
  const { init, results, stderr } = await mcpDrive({
    ...opts,
    steps: [{ method: 'tools/call', params: { name, arguments: args } }],
  });
  const { result, error } = results[0] ?? {};
  const text = (result?.content ?? []).map((c) => c?.text ?? '').join('\n');
  let json = null;
  try { json = JSON.parse(text); } catch { /* a tool may answer prose; callers use `text` */ }
  return {
    server: init?.serverInfo ?? null,
    result: result ?? null,
    error: error ?? null,
    text,
    json,
    isError: result?.isError === true,
    stderr,
  };
}

// ---------------------------------------------------------------------------
// Importing the modules under test
// ---------------------------------------------------------------------------

let _bust = 0;

/**
 * Import a `lib/` module fresh (bypassing the ESM cache) so tests that mutate
 * env or the data dir see a clean module.
 *
 * Throws a pointed error when the module has not been written yet — that is the
 * expected red state at the start of each mini-project.
 *
 * @param {string} file  e.g. 'config.mjs'
 * @returns {Promise<any>}
 */
export async function lib(file) {
  const p = join(PLUGIN_ROOT, 'lib', file);
  if (!existsSync(p)) {
    throw new Error(`lib/${file} does not exist yet — write it, then re-run.`);
  }
  return import(`${new URL(`file://${p}`).href}?fresh=${_bust++}`);
}

/** Same, for anything outside `lib/` (e.g. 'bin/statusline.src.mjs'). */
export async function mod(relPath) {
  const p = join(PLUGIN_ROOT, relPath);
  if (!existsSync(p)) throw new Error(`${relPath} does not exist yet — write it, then re-run.`);
  return import(`${new URL(`file://${p}`).href}?fresh=${_bust++}`);
}

// ---------------------------------------------------------------------------
// Filesystem assertions
// ---------------------------------------------------------------------------

/** @param {string} p @returns {any} */
export function readJsonFile(p) { return JSON.parse(readFileSync(p, 'utf8')); }

/** Every `*.json` under a directory, parsed. Missing dir → []. */
export function readJsonDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, path: join(dir, f), json: readJsonFile(join(dir, f)) }));
}

/** Spool files for a run, oldest first. */
export function spoolFiles(dataDir, runId) {
  const dir = join(dataDir, 'runs', runId, 'spool');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

/** The single run directory created under a data dir (fails if 0 or >1). */
export function soleRunId(dataDir) {
  const dir = join(dataDir, 'runs');
  const runs = existsSync(dir) ? readdirSync(dir) : [];
  assert.equal(runs.length, 1, `expected exactly one run dir, got [${runs.join(', ')}]`);
  return runs[0];
}

/** Poll `fn` until it returns truthy or `ms` elapses. For detached drains. */
export async function waitFor(fn, ms = 3000, step = 25) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${ms}ms`);
    await new Promise((r) => setTimeout(r, step));
  }
}

export { assert };
