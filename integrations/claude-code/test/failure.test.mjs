// @ts-check
/**
 * `failure.test.mjs` — the failure surface of the `mubit-memory` Claude Code plugin.
 *
 * Written FIRST, before any implementation exists, on the principle that the happy path
 * is a handful of assertions while the failure surface is where the bugs live — and it is
 * the failure surface that decides whether a user keeps the plugin installed.
 *
 * The 29 cases below enumerate that surface in order: every transport fault, every
 * malformed input, every contended lock and every policy verdict the plugin can meet.
 * Each carries a comment naming the behaviour it protects, because most of these
 * assertions look arbitrary until you know which real-world failure produced them.
 *
 * RED STATE: until `lib/*.mjs` and `hooks/src/*.mjs` are written, these fail with
 * "lib/x.mjs does not exist yet" / "hooks/src/x.mjs does not exist yet" from the
 * harness. That is correct and expected. Do not weaken a test to make it pass.
 *
 * Constraints (mirroring the plugin): Node >= 20 built-ins only, no framework, no
 * network, no Docker, no real Mubit, whole suite in seconds. Breaker windows and
 * cooldowns are driven through `MUBIT_CC_BREAKER_*` set to tiny values — never by
 * sleeping out a real 120 s cooldown.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';

import {
  assertHookContract, baseEnv, fakeMubit, lib, makeDataDir, queryResponse,
  readJsonDir, readJsonFile, runHook, spoolFiles, waitFor,
} from './helpers/harness.mjs';
import * as fx from './helpers/fixtures.mjs';

// ---------------------------------------------------------------------------
// Shared constants and helpers
// ---------------------------------------------------------------------------

/**
 * Every hook test pins `runStrategy: static` so the run id is knowable from the
 * test rather than derived through `lib/runid.mjs`. That keeps a *drain* failure
 * from being reported as a *run-id* failure.
 */
const RUN = 'cc-failtest-0001';

/**
 * A spawned `node` process costs ~30-60 ms of startup before the hook's own budget
 * even begins. The two budget assertions below allow for it explicitly rather than
 * pretending the wall clock of a child process is the hook's internal clock.
 */
const NODE_STARTUP_ALLOWANCE_MS = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake Mubit that is torn down when the test ends. `close()` is fire-and-forget:
 * Node >= 19 closes idle keep-alive connections on `close()`, and a deliberately
 * hung request has already had its socket destroyed by the aborting client, so
 * nothing is left holding the event loop open.
 * @param {any} t
 * @param {Record<string, any>} [routes]
 */
async function server(t, routes = {}) {
  const srv = await fakeMubit(routes);
  t.after(() => { srv.close(); });
  return srv;
}

/**
 * A URL that is guaranteed to refuse connections: bind a real listener to get a
 * port the OS just handed out, then close it. Deterministic ECONNREFUSED, no
 * guessing at "probably nothing is on 9". Used by the ECONNREFUSED cases below.
 */
async function deadEndpoint() {
  const srv = await fakeMubit();
  const { url } = srv;
  await srv.close();
  return url;
}

/**
 * The complete, deterministic hook environment. Cold-start grace defaults to 0 so
 * a failure test sees the failure glyph rather than `warming` (the cold-start case turns
 * it back on deliberately). Log level `warn` so "logs once" assertions see warn+error and
 * nothing else.
 * @param {{dataDir: string, endpoint?: string, runId?: string, extra?: Record<string,string>}} o
 */
function hookEnv(o) {
  return baseEnv({
    dataDir: o.dataDir,
    endpoint: o.endpoint,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: o.runId ?? RUN,
      MUBIT_CC_COLDSTART_GRACE_MS: '0',
      MUBIT_CC_LOG_LEVEL: 'warn',
      ...(o.extra ?? {}),
    },
  });
}

/**
 * Resolve a `Config` from exactly the same env the hooks get, so an in-process lib
 * assertion and a hook assertion in the same test are talking about the same
 * endpoint, the same data dir, and therefore the same breaker file.
 * @param {Record<string,string>} env
 */
async function cfgFrom(env) {
  const { loadConfig } = await lib('config.mjs');
  return loadConfig(env);
}

/** The one network primitive, on a route with no required fields and no `mode`. */
async function probe(cfg, http, over = {}) {
  return http.request(cfg, 'POST', '/v2/control/lessons',
    { run_id: RUN, scope: 'global', limit: 5 }, over);
}

/**
 * Write `n` spool items straight to the §7 layout (`runs/<run_id>/spool/*.json`),
 * one file per item. Deliberately does not go through `lib/spool.mjs`: a drain test
 * should fail because the drain is wrong, not because the spooler is missing.
 */
function seedSpool(dataDir, runId, n, over = {}) {
  const dir = join(dataDir, 'runs', runId, 'spool');
  mkdirSync(dir, { recursive: true });
  const paths = [];
  for (let i = 0; i < n; i++) {
    const p = join(dir, `${1765000000000 + i}-seed${String(i).padStart(2, '0')}.json`);
    writeFileSync(p, JSON.stringify(fx.spoolItem({
      item_id: `cc-seed-${i}`, text: `seeded item ${i}`, ...over,
    })));
    paths.push(p);
  }
  return paths;
}

/** Files quarantined by a non-retryable 4xx (§5.5 step 6, §7). */
function rejectedFiles(dataDir, runId) {
  const dir = join(dataDir, 'runs', runId, 'spool', 'rejected');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
}

/**
 * The breaker state file is `breaker/<sha256(endpoint).slice(0,12)>.json`. The test
 * reads whichever single file is there rather than recomputing the hash, so a change
 * of hash encoding is not a spurious test failure. Missing file = never recorded.
 */
function breakerFile(dataDir) {
  const found = readJsonDir(join(dataDir, 'breaker'));
  return found.length ? found[0].json : { state: '', failures: [], timeoutStreak: 0 };
}

/** Cached `direct_bypass` policy verdicts (§5.2). Denials only; grants never cached. */
function policyFiles(dataDir) {
  return readJsonDir(join(dataDir, 'policy'));
}

/** Status-line marker, `status/<run_id>.json` (§4.8). */
function marker(dataDir, runId = RUN) {
  const p = join(dataDir, 'status', `${runId}.json`);
  return existsSync(p) ? readJsonFile(p) : null;
}

/** Ring log lines (§4.8). Level is pinned to `warn` so info/debug noise cannot inflate this. */
function logLines(dataDir) {
  const p = join(dataDir, 'logs', 'mubit-cc.log');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
}

/**
 * `drain.mjs` is detached and takes its payload through a file, not stdin
 * (§4.9 `spawnDetached`). The payload goes on both channels so the test pins the
 * behaviour, not the plumbing.
 */
async function runDrain(dataDir, env, payload, args = []) {
  const p = join(dataDir, 'tmp', `${randomUUID()}.json`);
  mkdirSync(join(dataDir, 'tmp'), { recursive: true });
  writeFileSync(p, JSON.stringify(payload));
  return runHook('drain', payload, { env, args: [...args, '--payload', p] });
}

/** The `mode` of every `POST /v2/control/query` the server saw, in order. */
function queryModes(srv) {
  return srv.calls('POST', '/v2/control/query').map((c) => c.body?.mode);
}

/**
 * Rung 1 (`direct_bypass`) is refused by instance policy; rung 2 (`agent_routed`)
 * works. This is the server `the instance's direct-search policy disabled`.
 */
function policyGatedQuery(reply = {}) {
  return (r) => {
    const mode = r.body?.mode;
    if (mode === 'direct_bypass' || mode === 'direct') {
      return {
        status: 403,
        json: { error: 'permission_denied', message: 'direct data-plane bypass is disabled by policy' },
        ...reply,
      };
    }
    return { json: queryResponse({ routing_summary: 'agent_routed' }) };
  };
}

/** Recursively chmod a tree. Used to simulate a read-only `${CLAUDE_PLUGIN_DATA}`. */
function chmodTree(dir, mode) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) chmodTree(join(dir, e.name), mode);
  }
  chmodSync(dir, mode);
}

// ===========================================================================
// Transport failures
// ===========================================================================

describe('transport failures', () => {
  // "Nothing listening" must be a *typed* state, not an exception — §4.7's table maps
  // ECONNREFUSED/ENOTFOUND/EHOSTUNREACH/ECONNRESET to `unreachable`. And nothing may be
  // lost: §5.5 "all failures leave the spool intact for the next drain."
  test('nothing listening (ECONNREFUSED) -> unreachable, exit 0, JSON stdout, items stay spooled', async (t) => {
    const dataDir = makeDataDir();
    const endpoint = await deadEndpoint();
    const env = hookEnv({ dataDir, endpoint });
    const cfg = await cfgFrom(env);
    const http = await lib('http.mjs');

    const r = await probe(cfg, http);
    assert.equal(r.ok, false, 'request() must never throw; it returns a typed failure (§4.2)');
    assert.equal(r.state, 'unreachable');
    assert.equal(breakerFile(dataDir).state, 'unreachable');

    seedSpool(dataDir, RUN, 3);
    const drained = await runDrain(dataDir, env, fx.stop());
    assertHookContract(drained);
    assert.equal(spoolFiles(dataDir, RUN).length, 3,
      'a transport failure must NOT unlink spool files — they are the next drain\'s work');

    const recall = await runHook('prompt-recall', fx.userPromptSubmit(), { env });
    assertHookContract(recall);
    assert.notEqual(recall.json, undefined, 'stdout must be valid JSON even with the server gone');
  });

  // §5.5 step 6: "5xx / network -> recordFailure(state); LEAVE the spool files in place."
  // Contrast with the 422 case below, which quarantines the batch instead.
  test('500 on /v2/control/ingest -> server_error and the spool is left alone', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t, {
      'POST /v2/control/ingest': { status: 500, json: { error: 'internal' } },
    });
    const env = hookEnv({ dataDir, endpoint: srv.url });
    seedSpool(dataDir, RUN, 3);

    const res = await runDrain(dataDir, env, fx.stop());
    assertHookContract(res);

    srv.assertCalled('POST', '/v2/control/ingest');
    assert.equal(spoolFiles(dataDir, RUN).length, 3, 'a 5xx is retryable; the batch must survive');
    assert.deepEqual(rejectedFiles(dataDir, RUN), [], 'a 5xx must never quarantine a batch');
    assert.equal(breakerFile(dataDir).state, 'server_error');
  });

  // §4.7: "5xx, or unparseable body on a JSON route -> server_error". A reverse proxy
  // returning an HTML error page with a 200 is the common shape of this in the wild.
  test('non-JSON body on a JSON route -> server_error, and no unhandled rejection', async (t) => {
    /** @type {any[]} */
    const rejections = [];
    const onRejection = (e) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    t.after(() => { process.off('unhandledRejection', onRejection); });

    const dataDir = makeDataDir();
    const srv = await server(t, {
      'POST /v2/control/lessons': { status: 200, text: '<html><body>502 Bad Gateway</body></html>' },
    });
    const env = hookEnv({ dataDir, endpoint: srv.url });
    const cfg = await cfgFrom(env);
    const http = await lib('http.mjs');

    const r = await probe(cfg, http);
    assert.equal(r.ok, false);
    assert.equal(r.state, 'server_error');
    assert.equal(breakerFile(dataDir).state, 'server_error');

    await new Promise((r2) => setImmediate(r2));
    assert.deepEqual(rejections, [], 'a garbage body must be caught, not surfaced as an unhandled rejection');
  });
});

// ===========================================================================
// Auth
// ===========================================================================

describe('auth is the one error the user can fix', () => {
  // §4.7: "auth_failed is sticky and does NOT feed the failure-count breaker — opening a
  // breaker on a 401 hides the one error the user can actually fix." Five 401s in a row
  // with threshold 5 is the exact shape that would open a naive breaker.
  test('401 on /v2/control/query -> auth_failed, breaker failures unchanged, marker shows auth', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t, {
      'POST /v2/control/query': { status: 401, json: { error: 'unauthorized' } },
      'POST /v2/control/lessons': { status: 401, json: { error: 'unauthorized' } },
    });
    const env = hookEnv({
      dataDir, endpoint: srv.url,
      extra: { MUBIT_CC_BREAKER_THRESHOLD: '5', MUBIT_CC_BREAKER_WINDOW_MS: '300000' },
    });
    const cfg = await cfgFrom(env);
    const http = await lib('http.mjs');
    const breaker = await lib('breaker.mjs');

    for (let i = 0; i < 5; i++) {
      const r = await probe(cfg, http);
      assert.equal(r.ok, false);
      assert.equal(r.state, 'auth_failed', `call ${i + 1} must classify 401 as auth_failed`);
    }

    const b = breakerFile(dataDir);
    assert.deepEqual(b.failures ?? [], [], '401 must not append to the breaker failure window');
    assert.equal(breaker.allowRequest(cfg), true,
      'five 401s must not open the breaker — the user needs the next request to fail loudly');
    assert.equal(b.state, 'auth_failed');

    const res = await runHook('prompt-recall', fx.userPromptSubmit(), { env });
    assertHookContract(res);
    assert.equal(marker(dataDir)?.state, 'auth_failed', 'the status line pins to ✖ auth until a success clears it');
  });
});

// ===========================================================================
// "A timeout is not a verdict."
// ===========================================================================

describe('a timeout is not a verdict', () => {
  // §4.7: "A single AbortError sets no state — it increments timeoutStreak and leaves the
  // reported state unchanged." A cold cache, a laptop waking from sleep and a `cargo build`
  // hogging the CPU all produce exactly one timeout against a perfectly healthy server.
  test('one timeout leaves the reported state unchanged and only bumps timeoutStreak', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t, {
      'POST /v2/control/lessons': [{ json: { lessons: [] } }, { hang: true }],
    });
    const env = hookEnv({ dataDir, endpoint: srv.url, extra: { MUBIT_CC_TIMEOUT_MS: '150' } });
    const cfg = await cfgFrom(env);
    const http = await lib('http.mjs');

    const ok = await probe(cfg, http);
    assert.equal(ok.ok, true);
    assert.equal(breakerFile(dataDir).state, 'ready');

    const timedOut = await probe(cfg, http);
    assert.equal(timedOut.ok, false);
    assert.notEqual(timedOut.state, 'unreachable', 'a timeout is not a connection refusal');
    assert.notEqual(timedOut.state, 'server_error', 'a timeout is not a server fault');

    const b = breakerFile(dataDir);
    assert.equal(b.state, 'ready', 'one AbortError must NOT change the reported connection state');
    assert.equal(b.timeoutStreak, 1);
  });

  // §4.7: "Only timeoutStreak >= 3 escalates, and only to not_responding, never to
  // unreachable or server_error." §10 renders that as `◌ slow`, not `✖ unreachable`.
  test('three consecutive timeouts escalate to not_responding and never to unreachable', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t, { 'POST /v2/control/lessons': { hang: true } });
    const env = hookEnv({ dataDir, endpoint: srv.url, extra: { MUBIT_CC_TIMEOUT_MS: '100' } });
    const cfg = await cfgFrom(env);
    const http = await lib('http.mjs');

    for (const n of [1, 2]) {
      const r = await probe(cfg, http);
      assert.equal(r.ok, false);
      const mid = breakerFile(dataDir);
      assert.notEqual(mid.state, 'not_responding', `timeout ${n} must not escalate; the threshold is 3`);
      assert.notEqual(mid.state, 'unreachable');
      assert.notEqual(mid.state, 'server_error');
    }

    const third = await probe(cfg, http);
    assert.equal(third.ok, false);
    const b = breakerFile(dataDir);
    assert.equal(b.state, 'not_responding', 'three timeouts is "slow", the only state a timeout can produce');
    assert.ok(b.timeoutStreak >= 3, `timeoutStreak should be >= 3, got ${b.timeoutStreak}`);
  });

  // The streak has to be *consecutive*, otherwise a slow machine accumulates timeouts all
  // day and eventually reports a healthy server as not responding (§4.7).
  test('one timeout then a success resets timeoutStreak to 0', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t, {
      'POST /v2/control/lessons': [{ hang: true }, { json: { lessons: [] } }],
    });
    const env = hookEnv({ dataDir, endpoint: srv.url, extra: { MUBIT_CC_TIMEOUT_MS: '120' } });
    const cfg = await cfgFrom(env);
    const http = await lib('http.mjs');

    const timedOut = await probe(cfg, http);
    assert.equal(timedOut.ok, false);
    assert.equal(breakerFile(dataDir).timeoutStreak, 1);

    const ok = await probe(cfg, http);
    assert.equal(ok.ok, true);
    const b = breakerFile(dataDir);
    assert.equal(b.timeoutStreak, 0, 'a success resets the streak; only consecutive timeouts escalate');
    assert.equal(b.state, 'ready');
  });
});

// ===========================================================================
// Circuit breaker
// ===========================================================================

describe('circuit breaker', () => {
  // §4.7: "5 failures in a 300 s window opens for a 120 s cooldown." An open breaker that
  // still dials is not a breaker — the whole point is to stop paying the round trip.
  test('five failures inside the window open the breaker and the next request never dials', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t, { 'POST /v2/control/lessons': { status: 500, json: { error: 'boom' } } });
    const env = hookEnv({
      dataDir, endpoint: srv.url,
      extra: {
        MUBIT_CC_BREAKER_THRESHOLD: '5',
        MUBIT_CC_BREAKER_WINDOW_MS: '300000',
        MUBIT_CC_BREAKER_COOLDOWN_MS: '60000',
      },
    });
    const cfg = await cfgFrom(env);
    const http = await lib('http.mjs');
    const breaker = await lib('breaker.mjs');

    for (let i = 0; i < 5; i++) assert.equal((await probe(cfg, http)).ok, false);
    assert.equal(srv.countOf('POST', '/v2/control/lessons'), 5);
    assert.equal(breaker.allowRequest(cfg), false, 'five failures inside the window must open the breaker');

    srv.reset();
    const shortCircuited = await probe(cfg, http);
    assert.equal(shortCircuited.ok, false);
    assert.equal(srv.requests.length, 0,
      'an OPEN breaker must short-circuit in-process: zero requests may reach the server');
  });

  // §4.7: "After cooldown exactly one half-open probe dials." Two is a thundering herd on
  // an instance that has just come back up.
  test('after the cooldown exactly one half-open probe dials and a concurrent call short-circuits', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t, {
      'POST /v2/control/lessons': [
        { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 },
        { json: { lessons: [] }, delayMs: 150 },
      ],
    });
    const env = hookEnv({
      dataDir, endpoint: srv.url,
      extra: {
        MUBIT_CC_BREAKER_THRESHOLD: '5',
        MUBIT_CC_BREAKER_WINDOW_MS: '300000',
        MUBIT_CC_BREAKER_COOLDOWN_MS: '80',
        MUBIT_CC_TIMEOUT_MS: '2000',
      },
    });
    const cfg = await cfgFrom(env);
    const http = await lib('http.mjs');
    const breaker = await lib('breaker.mjs');

    for (let i = 0; i < 5; i++) await probe(cfg, http);
    assert.equal(breaker.allowRequest(cfg), false);

    srv.reset();
    // reset() clears the route cursor as well as the request log, rewinding the array above
    // back to its first 500 — so without this the half-open probe is answered by a sixth
    // failure and the success reply is unreachable. Re-point the route explicitly. (The
    // half-open-probe-closes-the-breaker case uses the same table and passes only because it
    // never resets.)
    srv.route('POST /v2/control/lessons', { json: { lessons: [] }, delayMs: 150 });
    await sleep(140); // cooldown elapsed, breaker is half-open

    const [a, b] = await Promise.all([probe(cfg, http), probe(cfg, http)]);
    assert.equal(srv.requests.length, 1,
      'exactly one half-open probe may dial; the concurrent call must short-circuit');
    assert.equal([a.ok, b.ok].filter(Boolean).length, 1, 'exactly one of the two calls carried a real response');
  });

  // §4.7: "success closes and clears `failures`". A breaker that recovers but keeps its
  // old failures re-opens on the very next blip.
  test('a successful half-open probe closes the breaker and clears failures', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t, {
      'POST /v2/control/lessons': [
        { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 },
        { json: { lessons: [] } },
      ],
    });
    const env = hookEnv({
      dataDir, endpoint: srv.url,
      extra: {
        MUBIT_CC_BREAKER_THRESHOLD: '5',
        MUBIT_CC_BREAKER_WINDOW_MS: '300000',
        MUBIT_CC_BREAKER_COOLDOWN_MS: '80',
      },
    });
    const cfg = await cfgFrom(env);
    const http = await lib('http.mjs');
    const breaker = await lib('breaker.mjs');

    for (let i = 0; i < 5; i++) await probe(cfg, http);
    assert.equal(breaker.allowRequest(cfg), false);

    await sleep(140);
    const recovered = await probe(cfg, http);
    assert.equal(recovered.ok, true);

    const b = breakerFile(dataDir);
    assert.deepEqual(b.failures ?? [], [], 'a closing breaker must clear the failure window');
    assert.equal(b.state, 'ready');
    assert.ok(!b.openedAt, `openedAt must be cleared when the breaker closes, got ${b.openedAt}`);
    assert.equal(breaker.allowRequest(cfg), true);
  });
});

// ===========================================================================
// Budgets
// ===========================================================================

describe('budgets are hard deadlines', () => {
  // §5.2: recall runs under a 1500 ms internal budget on a hook that fires before EVERY
  // prompt. Waiting for a slow server is a user-visible stall, so the budget wins and the
  // prompt proceeds with no memory.
  test('a response slower than the recall budget still emits {"suppressOutput":true} within budget+100ms', async (t) => {
    const dataDir = makeDataDir();
    const budgetMs = 300;
    const serverDelayMs = 5000;
    const srv = await server(t, {
      'POST /v2/control/query': { json: queryResponse(), delayMs: serverDelayMs },
      'POST /v2/control/context': { json: {}, delayMs: serverDelayMs },
    });
    const env = hookEnv({
      dataDir, endpoint: srv.url,
      extra: { MUBIT_CC_RECALL_BUDGET_MS: String(budgetMs), MUBIT_CC_TIMEOUT_MS: '4000' },
    });

    const res = await runHook('prompt-recall', fx.userPromptSubmit(), { env });
    assertHookContract(res);
    assert.deepEqual(res.json, { suppressOutput: true },
      'a blown budget injects nothing — "I found nothing" wastes tokens and teaches the model to distrust the channel');
    assert.ok(res.ms < serverDelayMs,
      `the hook must abort rather than wait out the server (${res.ms}ms vs a ${serverDelayMs}ms response)`);
    assert.ok(res.ms < budgetMs + 100 + NODE_STARTUP_ALLOWANCE_MS,
      `expected the hook back within ${budgetMs}+100ms (+${NODE_STARTUP_ALLOWANCE_MS}ms node startup), took ${res.ms}ms`);
  });

  // §5.2 step 3: "RUNG 2 — ... Skip when < 500ms of budget remains." Rung 2 costs an LLM
  // call (§1.8); starting one you cannot finish spends the call and injects nothing.
  test('rung 2 is skipped when under 500ms of budget remains, and the hook still lands inside its budget', async (t) => {
    const dataDir = makeDataDir();
    const budgetMs = 900;
    const srv = await server(t, {
      'POST /v2/control/query': policyGatedQuery({ delayMs: 700 }),
    });
    const env = hookEnv({
      dataDir, endpoint: srv.url,
      extra: { MUBIT_CC_RECALL_BUDGET_MS: String(budgetMs), MUBIT_CC_TIMEOUT_MS: '2000' },
    });

    const res = await runHook('prompt-recall', fx.userPromptSubmit(), { env });
    assertHookContract(res);
    assert.deepEqual(res.json, { suppressOutput: true });

    const modes = queryModes(srv);
    assert.deepEqual(modes, ['direct_bypass'],
      `rung 1 burned 700ms of a ${budgetMs}ms budget, so rung 2 must be skipped; saw ${JSON.stringify(modes)}`);
    assert.ok(res.ms < budgetMs + 100 + NODE_STARTUP_ALLOWANCE_MS,
      `expected the hook back within ${budgetMs}+100ms (+${NODE_STARTUP_ALLOWANCE_MS}ms node startup), took ${res.ms}ms`);
  });
});

// ===========================================================================
// Hostile stdin
// ===========================================================================

describe('hostile stdin', () => {
  /** Every hook that Claude Code can hand a payload to (§3.2). */
  const REGISTERED = [
    { name: 'session-start', args: [] },
    { name: 'prompt-recall', args: [] },
    { name: 'stage-prompt', args: [] },
    { name: 'capture', args: [] },
    { name: 'capture', args: ['--stop'] },
    { name: 'checkpoint', args: ['--pre'] },
    { name: 'session-end', args: [] },
  ];

  // §4.9: "Reads stdin to EOF and JSON.parses it (malformed → emit {} and exit 0)."
  // Exit-code discipline: this plugin never exits 2 and never exits non-zero — a memory
  // layer has no business blocking a prompt.
  test('malformed stdin -> every hook exits 0, emits {}, logs once, dials nothing', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t);
    const env = hookEnv({ dataDir, endpoint: srv.url });

    for (const { name, args } of REGISTERED) {
      const res = await runHook(name, null, { env, args, stdinRaw: 'not json' });
      assertHookContract(res);
      assert.deepEqual(res.json, {}, `${name} ${args.join(' ')} must emit exactly {} on malformed stdin`);
    }
    assert.equal(srv.requests.length, 0,
      'a hook with no usable payload has nothing to say to Mubit; it must not dial');

    const solo = makeDataDir();
    const soloEnv = hookEnv({ dataDir: solo, endpoint: srv.url });
    await runHook('prompt-recall', null, { env: soloEnv, stdinRaw: 'not json' });
    assert.equal(logLines(solo).length, 1,
      'exactly one log line at warn+ — a parse failure is worth one line, not a loop');
  });

  // Claude Code can close stdin without writing (§4.9 reads to EOF). Empty is not "{}",
  // it is zero bytes, and `JSON.parse("")` throws.
  test('empty stdin -> every hook exits 0, emits {}, logs once, dials nothing', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t);
    const env = hookEnv({ dataDir, endpoint: srv.url });

    for (const { name, args } of REGISTERED) {
      const res = await runHook(name, null, { env, args, stdinRaw: '' });
      assertHookContract(res);
      assert.deepEqual(res.json, {}, `${name} ${args.join(' ')} must emit exactly {} on empty stdin`);
    }
    assert.equal(srv.requests.length, 0);

    const solo = makeDataDir();
    const soloEnv = hookEnv({ dataDir: solo, endpoint: srv.url });
    await runHook('prompt-recall', null, { env: soloEnv, stdinRaw: '' });
    assert.equal(logLines(solo).length, 1);
  });
});

// ===========================================================================
// A read-only ${CLAUDE_PLUGIN_DATA}
// ===========================================================================

describe('a read-only ${CLAUDE_PLUGIN_DATA}', () => {
  // §4.6: "claimOnce returns true on a non-EEXIST error — proceed on marker failure. The
  // marker prevents a *double* flush; a read-only or full ${CLAUDE_PLUGIN_DATA} must not be
  // able to prevent the flush entirely. Losing the batch is worse than sending it twice,
  // and the per-batch idempotency_key makes a double send a server-side no-op anyway."
  test('read-only data dir -> hooks still exit 0 and claimOnce returns true', async (t) => {
    if (process.getuid?.() === 0) {
      t.skip('running as root: permission bits are not enforced, so this scenario cannot be staged');
      return;
    }

    const dataDir = makeDataDir();
    const srv = await server(t);
    const env = hookEnv({ dataDir, endpoint: srv.url });
    // Resolve config while the dir is still writable — the config cache is not what is
    // under test here, the marker and the hook contract are.
    const cfg = await cfgFrom(env);
    const spool = await lib('spool.mjs');

    chmodTree(dataDir, 0o500);
    t.after(() => { try { chmodTree(dataDir, 0o700); } catch { /* best effort */ } });

    assert.equal(spool.claimOnce(cfg, RUN, `flushed-${fx.SESSION_ID}`), true,
      'a marker that cannot be written must not veto the flush');

    for (const { name, args, payload } of [
      { name: 'capture', args: [], payload: fx.postToolUse() },
      { name: 'stage-prompt', args: [], payload: fx.userPromptSubmit() },
      { name: 'session-end', args: [], payload: fx.sessionEnd() },
    ]) {
      const res = await runHook(name, payload, { env, args });
      assertHookContract(res);
    }
  });
});

// ===========================================================================
// Spool integrity
// ===========================================================================

describe('spool integrity', () => {
  // §4.6: file-per-item exists precisely so "partial writes [are] self-evident
  // (unparseable → unlink)". One half-written file must not wedge every later batch.
  test('a truncated JSON spool file is unlinked by readBatch and the rest of the batch still sends', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t);
    const env = hookEnv({ dataDir, endpoint: srv.url });
    const cfg = await cfgFrom(env);

    seedSpool(dataDir, RUN, 3);
    const truncated = join(dataDir, 'runs', RUN, 'spool', '1765000009999-torn.json');
    writeFileSync(truncated, '{"item_id":"cc-torn","content_type":"te');

    const { readBatch } = await lib('spool.mjs');
    const batch = readBatch(cfg, RUN, 32);
    assert.equal(batch.length, 3, 'readBatch must return the parseable items and skip the torn one');
    assert.equal(existsSync(truncated), false, 'the unparseable file must be unlinked, not left to poison every drain');

    const res = await runDrain(dataDir, env, fx.stop());
    assertHookContract(res);
    srv.assertCalled('POST', '/v2/control/ingest', 1);
    assert.equal(srv.lastCall('POST', '/v2/control/ingest')?.body?.items?.length, 3);
    assert.equal(spoolFiles(dataDir, RUN).length, 0, 'a 2xx commits the batch');
  });

  // §5.5 step 6: "4xx other than 408/429 → the payload is bad, not the server: move the
  // batch to spool/rejected/ and log. Retrying a 422 forever is how a spool becomes
  // unbounded."
  test('a 422 from ingest quarantines the batch in spool/rejected/ and never retries it', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t, {
      'POST /v2/control/ingest': { status: 422, json: { error: 'missing field `content_type`' } },
    });
    const env = hookEnv({ dataDir, endpoint: srv.url });
    seedSpool(dataDir, RUN, 3);

    const first = await runDrain(dataDir, env, fx.stop());
    assertHookContract(first);
    srv.assertCalled('POST', '/v2/control/ingest', 1);
    assert.equal(spoolFiles(dataDir, RUN).length, 0, 'the rejected batch must leave the live spool');
    assert.ok(rejectedFiles(dataDir, RUN).length > 0, 'the rejected batch must land in spool/rejected/');

    const second = await runDrain(dataDir, env, fx.stop());
    assertHookContract(second);
    srv.assertCalled('POST', '/v2/control/ingest', 1);
    assert.ok(rejectedFiles(dataDir, RUN).length > 0, 'quarantined batches stay quarantined');
  });
});

// ===========================================================================
// Pre-flight guards
// ===========================================================================

describe('pre-flight guards', () => {
  // §1.1 / §4.2: "POST /v2/control/query has a per-route 256 KiB body limit
  // ... blowing that cap produces a 413 that looks like a server
  // fault to the breaker." Five oversized prompts would otherwise open the breaker on an
  // entirely healthy instance.
  test('an oversized /v2/control/query body is caught pre-flight and never dialed', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t);
    const env = hookEnv({ dataDir, endpoint: srv.url });
    const cfg = await cfgFrom(env);
    const { postQuery } = await lib('http.mjs');

    const r = await postQuery(cfg, {
      run_id: RUN,
      agent_id: 'claude-code-4f21ab',
      query: 'x'.repeat(300 * 1024), // comfortably over the 256 KiB per-route cap
      mode: 'direct_bypass',
      direct_lane: 'semantic_search',
      evidence_only: true,
      budget: 'low',
      limit: 8,
    });

    assert.equal(r.ok, false, 'the 256 KiB assertion must fail the call, not throw');
    assert.equal(srv.requests.length, 0,
      'a body over the per-route cap must never leave the machine; a 413 would be misread as server_error');
    assert.deepEqual(breakerFile(dataDir).failures ?? [], [],
      'a client-side size rejection is not evidence the server is unhealthy');
  });

  // §4.3: MUBIT_DEFAULT_SESSION_ID defaults to the literal "default" in the MCP server,
  // collapsing every user, project and machine into one
  // run. lib/http.mjs is the backstop: it "refuses to send run_id === 'default', logging an
  // error and dropping the request."
  test('run_id "default" is refused pre-flight and logged as an error', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t);
    const env = hookEnv({ dataDir, endpoint: srv.url, extra: { MUBIT_CC_LOG_LEVEL: 'error' } });
    const cfg = await cfgFrom(env);
    const http = await lib('http.mjs');

    const raw = await http.request(cfg, 'POST', '/v2/control/ingest', {
      run_id: 'default', agent_id: 'claude-code-4f21ab',
      idempotency_key: 'cc-x-1', parallel: true, items: [fx.spoolItem()],
    });
    assert.equal(raw.ok, false, 'request() must refuse "default" outright');
    assert.equal(srv.requests.length, 0, 'nothing may be written into the shared "default" run');

    const typed = await http.postIngest(cfg, {
      run_id: 'default', agent_id: 'claude-code-4f21ab',
      idempotency_key: 'cc-x-2', parallel: true, items: [fx.spoolItem()],
    });
    assert.equal(typed.ok, false, 'the typed wrapper must not bypass the guard');
    assert.equal(srv.requests.length, 0);

    const logged = logLines(dataDir);
    assert.ok(logged.length > 0, 'the guard must log at error — a silently dropped request is undebuggable');
    assert.ok(logged.some((l) => l.includes('default')),
      `expected a log line naming the poisoned run id; saw:\n${logged.join('\n')}`);
  });

  // §5.2: only `direct_bypass` and `direct` select the direct lane. Any other value is
  // accepted on the wire and answered without complaint, so a typo is invisible from the
  // outside: the prompt still gets a response, just from the slower path, and nothing
  // anywhere says why. The guard therefore lives here, where the typo is still visible.
  test('a mode literal outside {direct_bypass, direct, agent_routed} is rejected pre-flight and dials nothing', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t);
    const env = hookEnv({ dataDir, endpoint: srv.url, extra: { MUBIT_CC_LOG_LEVEL: 'error' } });
    const cfg = await cfgFrom(env);
    const { postQuery } = await lib('http.mjs');

    const base = {
      run_id: RUN, agent_id: 'claude-code-4f21ab', query: 'why is the ingest job stuck in queued?',
      direct_lane: 'semantic_search', evidence_only: true, budget: 'low', limit: 8,
    };

    // The exact typos that silently cost an LLM call per prompt, forever, with no error.
    for (const mode of ['direct-bypass', 'DirectBypass', 'directbypass', 'semantic_search', 'bypass']) {
      const r = await postQuery(cfg, { ...base, mode });
      assert.equal(r.ok, false, `mode ${JSON.stringify(mode)} must be rejected before dialing`);
    }
    assert.equal(srv.requests.length, 0,
      'a bad mode literal must never reach the server, where it would silently become agent_routed');
    assert.ok(logLines(dataDir).length > 0, 'a rejected mode literal must log at error');

    // Positive control: the two literals the ladder actually uses still go out.
    const rung1 = await postQuery(cfg, { ...base, mode: 'direct_bypass' });
    assert.equal(rung1.ok, true);
    const rung2 = await postQuery(cfg, { ...base, mode: 'agent_routed' });
    assert.equal(rung2.ok, true, 'rung 2 is a legitimate mode — the guard catches typos, not the ladder');
    assert.equal(srv.countOf('POST', '/v2/control/query'), 2);
  });
});

// ===========================================================================
// Drain lock
// ===========================================================================

describe('drain lock', () => {
  // §5.5 step 1: "acquireDrainLock(); null → another drainer is live, exit 0. Single
  // drainer." Two concurrent drainers double-send the same batch and race the unlink.
  test('two drainers race the O_EXCL lock and exactly one proceeds', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t);
    const env = hookEnv({ dataDir, endpoint: srv.url });
    const cfg = await cfgFrom(env);
    const { acquireDrainLock, releaseDrainLock } = await lib('spool.mjs');

    const held = acquireDrainLock(cfg, RUN);
    assert.ok(held, 'the first drainer must get the lock');
    assert.equal(acquireDrainLock(cfg, RUN), null, 'a second drainer must be turned away with null');

    seedSpool(dataDir, RUN, 3);
    const blocked = await runDrain(dataDir, env, fx.stop());
    assertHookContract(blocked);
    srv.assertNotCalled('POST', '/v2/control/ingest');
    assert.equal(spoolFiles(dataDir, RUN).length, 3, 'the blocked drainer must leave the batch for the live one');

    releaseDrainLock(held);
    const [a, b] = await Promise.all([
      runDrain(dataDir, env, fx.stop()),
      runDrain(dataDir, env, fx.stop()),
    ]);
    assertHookContract(a);
    assertHookContract(b);
    srv.assertCalled('POST', '/v2/control/ingest', 1);
    assert.equal(spoolFiles(dataDir, RUN).length, 0);
  });

  // §7: "A drain.lock older than 60 s is assumed orphaned (its owner was SIGKILLed with the
  // terminal) and stolen ... a stuck lock silently stops all capture, which is worse than a
  // rare double drain that the idempotency_key absorbs."
  test('a drain.lock older than 60s is stolen and the drain proceeds', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t);
    const env = hookEnv({ dataDir, endpoint: srv.url });
    const cfg = await cfgFrom(env);

    const staleLock = (runId) => {
      const dir = join(dataDir, 'runs', runId);
      mkdirSync(dir, { recursive: true });
      // 999999 is above the default macOS/Linux pid ceiling, so `process.kill(pid, 0)`
      // throws ESRCH and the owner is provably gone.
      writeFileSync(join(dir, 'drain.lock'), JSON.stringify({ pid: 999999, ts: Date.now() - 61_000 }));
      return join(dir, 'drain.lock');
    };

    seedSpool(dataDir, RUN, 3);
    staleLock(RUN);
    const res = await runDrain(dataDir, env, fx.stop());
    assertHookContract(res);
    srv.assertCalled('POST', '/v2/control/ingest', 1);
    assert.equal(spoolFiles(dataDir, RUN).length, 0, 'a stolen lock must not cost the batch');

    const libRun = `${RUN}-lib`;
    staleLock(libRun);
    const { acquireDrainLock } = await lib('spool.mjs');
    assert.ok(acquireDrainLock(cfg, libRun), 'acquireDrainLock must steal a lock past its 60 s TTL');
  });
});

// ===========================================================================
// Cold start
// ===========================================================================

describe('cold start', () => {
  // §4.7: "within coldStartGraceMs (default 20 000 ms) of the run's first SessionStart,
  // failures are recorded but the status line shows ◍ warming ... A user who just ran
  // whose instance is still starting should not be told their memory is broken for the
  // first seconds it spends warming up."
  test('a failure inside the cold-start grace shows warming, not a failure glyph', async (t) => {
    const endpoint = await deadEndpoint();

    // Inside the grace window.
    const warm = makeDataDir();
    const warmEnv = hookEnv({
      dataDir: warm, endpoint,
      extra: { MUBIT_CC_COLDSTART_GRACE_MS: '20000', MUBIT_CC_TIMEOUT_MS: '500' },
    });
    assertHookContract(await runHook('session-start', fx.sessionStart(), { env: warmEnv }));
    assertHookContract(await runHook('prompt-recall', fx.userPromptSubmit(), { env: warmEnv }));

    const warmMarker = marker(warm);
    assert.ok(warmMarker, 'SessionStart must write a marker even when the server is gone');
    assert.ok(
      warmMarker.state === 'warming' || warmMarker.cold_start_until > Date.now(),
      `expected warming (or an unexpired cold_start_until); got ${JSON.stringify(warmMarker)}`,
    );

    // Outside it — the contrast is what makes the assertion above mean anything.
    const cold = makeDataDir();
    const coldEnv = hookEnv({
      dataDir: cold, endpoint,
      extra: { MUBIT_CC_COLDSTART_GRACE_MS: '0', MUBIT_CC_TIMEOUT_MS: '500' },
    });
    assertHookContract(await runHook('session-start', fx.sessionStart(), { env: coldEnv }));
    assertHookContract(await runHook('prompt-recall', fx.userPromptSubmit(), { env: coldEnv }));

    const coldMarker = marker(cold);
    assert.ok(coldMarker, 'the marker must exist with the grace window disabled too');
    assert.notEqual(coldMarker.state, 'warming', 'with no grace window the real failure state must surface');
    assert.ok(!(coldMarker.cold_start_until > Date.now()),
      'a zero grace window must not leave cold_start_until in the future');
  });
});

// ===========================================================================
// The three-rung policy ladder
// ===========================================================================

/**
 * Rung 2 is opt-in as of the rung-1-only default (§5.2). The first three cases below are about
 * the *ladder* — that a 403 is a verdict rather than a fault, is cached, and re-probes on expiry
 * — so they ask for the fallback explicitly and keep testing exactly what they always tested.
 */
const FALLBACK_ON = { MUBIT_CC_RECALL_FALLBACK: 'agent_routed' };

describe('the policy ladder — a 403 on rung 1 is a verdict, not a fault', () => {
  // §5.2: "a 403 on rung 1 is not a failure — it is a policy verdict that gets cached and
  // descends the ladder, and it must not touch the breaker or the auth_failed state."
  // This is the server the instance's direct-search policy disabled: an ordinary,
  // supported instance configuration, not a broken one.
  test('403 permission_denied on rung 1 falls to rung 2 without touching the breaker or auth state', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t, { 'POST /v2/control/query': policyGatedQuery() });
    const env = hookEnv({ dataDir, endpoint: srv.url, extra: FALLBACK_ON });

    const res = await runHook('prompt-recall', fx.userPromptSubmit(), { env });
    assertHookContract(res);

    assert.deepEqual(queryModes(srv), ['direct_bypass', 'agent_routed'],
      'the denial must descend the ladder, not abort recall');
    srv.assertNotCalled('POST', '/v2/control/context'); // rung 3 is opt-in only (§1.8)

    const b = breakerFile(dataDir);
    assert.deepEqual(b.failures ?? [], [], 'a policy verdict is not a transport failure');
    assert.notEqual(b.state, 'auth_failed', 'a deliberate rung-1 probe being refused is not an auth problem');

    const cached = policyFiles(dataDir);
    assert.equal(cached.length, 1, 'the verdict must be cached to policy/<endpoint_hash>.json');
    assert.equal(cached[0].json.direct_bypass, 'denied');
    assert.equal(cached[0].json.ttl_ms, 86_400_000, 'the cached denial carries the documented 24h TTL');
    assert.ok(cached[0].json.observed_at > 0);
  });

  // §1.8: "A permission_denied is an instance-level policy fact, not a per-request outcome;
  // re-probing direct_bypass on every prompt burns a round trip forever."
  test('after a cached denial the next prompt goes straight to rung 2 without re-probing rung 1', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t, { 'POST /v2/control/query': policyGatedQuery() });
    const env = hookEnv({ dataDir, endpoint: srv.url, extra: FALLBACK_ON });

    assertHookContract(await runHook('prompt-recall', fx.userPromptSubmit({ prompt_id: 'p_first' }), { env }));
    assert.deepEqual(queryModes(srv), ['direct_bypass', 'agent_routed']);

    srv.reset();
    assertHookContract(await runHook('prompt-recall', fx.userPromptSubmit({ prompt_id: 'p_second' }), { env }));
    assert.deepEqual(queryModes(srv), ['agent_routed'],
      'a valid cached denial must skip rung 1 entirely — one wasted round trip per prompt, forever, otherwise');
  });

  // §5.2: "On expiry the hook re-probes rung 1 once — an operator who flips
  // the instance's direct-search policy back on gets the free path back within a day, with no
  // reinstall."
  test('a cached denial older than MUBIT_CC_POLICY_TTL_MS re-probes rung 1 exactly once', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t, { 'POST /v2/control/query': policyGatedQuery() });
    const env = hookEnv({ dataDir, endpoint: srv.url, extra: { ...FALLBACK_ON, MUBIT_CC_POLICY_TTL_MS: '86400000' } });

    // Let the plugin write its own cache entry, so the test never has to guess the
    // endpoint-hash filename.
    assertHookContract(await runHook('prompt-recall', fx.userPromptSubmit({ prompt_id: 'p_1' }), { env }));
    const cached = policyFiles(dataDir);
    assert.equal(cached.length, 1);

    // Age the verdict past its TTL.
    const expired = { ...cached[0].json, observed_at: Date.now() - 90_000_000, ttl_ms: 86_400_000 };
    writeFileSync(cached[0].path, JSON.stringify(expired));

    srv.reset();
    assertHookContract(await runHook('prompt-recall', fx.userPromptSubmit({ prompt_id: 'p_2' }), { env }));
    const modes = queryModes(srv);
    assert.equal(modes.filter((m) => m === 'direct_bypass').length, 1,
      `an expired verdict re-probes rung 1 exactly once; saw ${JSON.stringify(modes)}`);
    assert.deepEqual(modes, ['direct_bypass', 'agent_routed']);
  });

  // §5.2: "Only a 401/403 on a rung the plugin did not deliberately probe means auth is
  // broken." A 401 is never a policy verdict — caching it would hide a revoked key for 24h.
  test('401 on rung 1 is auth_failed, is never cached as a policy verdict, and does not descend the ladder', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t, {
      'POST /v2/control/query': { status: 401, json: { error: 'unauthorized' } },
    });
    const env = hookEnv({ dataDir, endpoint: srv.url, extra: FALLBACK_ON });

    const res = await runHook('prompt-recall', fx.userPromptSubmit(), { env });
    assertHookContract(res);
    assert.deepEqual(res.json, { suppressOutput: true });

    assert.equal(srv.countOf('POST', '/v2/control/query'), 1,
      'a 401 is a hard failure: give up, do not spend an LLM call on rung 2');
    assert.deepEqual(policyFiles(dataDir), [],
      'a 401 must never be cached as a policy verdict — that would hide a revoked key for 24h');
    assert.equal(breakerFile(dataDir).state, 'auth_failed');
  });

  // §5.2: "A 'granted' verdict is not cached: rung 1 succeeding is self-evident and caching
  // it would only add a stale-state failure mode."
  test('a successful rung 1 writes nothing to policy/ — grants are never cached', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t); // default routes: query succeeds
    const env = hookEnv({ dataDir, endpoint: srv.url, extra: FALLBACK_ON });

    const res = await runHook('prompt-recall', fx.userPromptSubmit(), { env });
    assertHookContract(res);

    assert.deepEqual(queryModes(srv), ['direct_bypass'],
      'rung 1 is the primary path and costs zero LLM calls; nothing below it should run');
    srv.assertNotCalled('POST', '/v2/control/context');
    assert.deepEqual(policyFiles(dataDir), [], 'grants are never cached');
  });
});

// ===========================================================================
// Session end
// ===========================================================================

describe('session end', () => {
  // §5.7: "best-effort throughout — a failed reflect is logged and shown in the marker as
  // `reflect: failed`, never surfaced as a blocking error." The drain must still commit:
  // §1.4 says a lost reflect costs scope promotion for that session's lessons, not the
  // captures themselves.
  test('a failing reflect at SessionEnd is logged, marked failed, exits 0, and the drain still commits', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t, {
      'POST /v2/control/reflect': { status: 500, json: { error: 'llm provider unavailable' } },
    });
    const env = hookEnv({ dataDir, endpoint: srv.url });
    seedSpool(dataDir, RUN, 3);

    const res = await runHook('session-end', fx.sessionEnd(), { env });
    assertHookContract(res);

    // The body runs in a detached child by default — the host cancels this hook on the way
    // out, so its work has to outlive it. What that work does on a failing reflect is
    // unchanged, which is what the rest of this test asserts.
    await waitFor(() => marker(dataDir)?.reflect?.status === 'failed', 12_000);

    srv.assertCalled('POST', '/v2/control/ingest', 1);
    assert.equal(spoolFiles(dataDir, RUN).length, 0,
      'the drain must commit before reflect is even attempted — a failed reflect cannot cost captures');
    srv.assertCalled('POST', '/v2/control/reflect');

    const m = marker(dataDir);
    assert.ok(m, 'SessionEnd must leave a marker behind');
    assert.equal(m.reflect?.status, 'failed', 'the marker is where a failed reflect is reported (§4.8)');
    assert.ok(logLines(dataDir).length > 0, 'a failed reflect must be logged');
  });

  // §4.7's rule, applied to the one caller that dials *wider* than the configured default:
  // "a timeout is not a verdict." `lib/http.mjs` exempts a caller who squeezed its deadline
  // below `cfg.timeoutMs`, because a 400 ms slice learns nothing about a healthy server. The
  // reflect is the mirror image — it is LLM-backed, so it dials wide on purpose — and the
  // exemption does not cover it: inline it dials exactly the 4000 ms default, which is not
  // *less than* the default, so its abort lands in `recordFailure(… 'not_responding')`.
  //
  // Five of those inside the window open the breaker for the cooldown, and the breaker gates
  // the ingest drain. So a merely slow reflect escalates into captures stopping altogether —
  // the client's own patience, laundered into a verdict about the server.
  //
  // Both routes below stall, which is what makes the failure window readable at all: §5.7's
  // idle heartbeat runs *after* reflect, and `recordSuccess` empties `failures` outright — so
  // against a server that answers the heartbeat, the buggy and the fixed tree leave byte-
  // identical state and no assertion here could tell them apart. Stalling the heartbeat too
  // does not merely hide it: the heartbeat dials 1000 ms, *tighter* than the 4000 ms default,
  // so its own abort is already exempt and records nothing either way. What is left in the
  // window is exactly the one call under test.
  test('a reflect that outruns its own deadline is not evidence about the server', async (t) => {
    const dataDir = makeDataDir();
    const srv = await server(t, {
      // Comfortably past the inline 4000 ms slice, so the client aborts rather than the server
      // answering slowly — an abort is the only thing this test is about.
      'POST /v2/control/reflect': { delayMs: 8000, json: { lessons: [], lessons_stored: 0 } },
      'POST /v2/control/agents/heartbeat': { delayMs: 2000, json: { ok: true } },
    });
    // Inline, so the deadline under test is the 4000 ms one the host's ceiling still decides.
    const env = hookEnv({
      dataDir, endpoint: srv.url, extra: { MUBIT_CC_SESSION_END_DETACH: '0' },
    });
    seedSpool(dataDir, RUN, 1);

    const res = await runHook('session-end', fx.sessionEnd(), { env });
    assertHookContract(res);

    const m = marker(dataDir);
    assert.equal(m?.reflect?.status, 'failed',
      'the marker still reports the failure — this is about the breaker, not about hiding it');

    const { readBreaker } = await lib('breaker.mjs');
    const cfg = await cfgFrom(env);
    assert.deepEqual(readBreaker(cfg).failures, [],
      'a deadline this client chose is not evidence about the server');
  });
});
