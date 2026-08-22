// @ts-check
/**
 * `hooks/src/capture.mjs` — PostToolUse / PostToolUseFailure / Stop / SubagentStop (§5.4).
 *
 * One script, four modes by argv: none, `--failure`, `--stop`, `--subagent`.
 *
 * Two properties dominate this file:
 *
 *  1. **Zero network.** Capture runs on every single tool call. The only outbound work it
 *     ever does is `spawnDetached('drain')`, and only when a trigger fires. That is what
 *     makes "detached" cheap — naively re-spawning yourself detached on every PostToolUse
 *     pays node's startup twice per tool call.
 *  2. **Every item carries an `intent`.** §1.5: the server classifies cheaply when an item
 *     arrives with an intent set, and otherwise falls back to an LLM round trip *per item*.
 *     An item without an intent is not a cosmetic problem, it is a bill.
 *
 * Tests that need a known run directory pin `MUBIT_CC_RUN_STRATEGY=static`; the first two
 * use the default `per-directory` strategy so run-dir derivation is exercised too.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  runHook, assertHookContract, assertWithinBudget, fakeMubit, baseEnv, makeDataDir,
  makeProjectDir, spoolFiles, soleRunId, readJsonFile, tempDir,
} from './helpers/harness.mjs';
import {
  postToolUse, postToolUseFailure, stop, subagentStop,
  PROMPT_ID, SESSION_ID, TOOL_USE_ID, SECRETS,
} from './helpers/fixtures.mjs';

const RUN_ID = 'cc-test-0000';
const STAGED_PROMPT = 'why is the ingest job stuck in queued?';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

const SCRATCH = tempDir('mubit-cc-capture-');

/**
 * Preload that records the argv/env of every node process launched under this env —
 * including the detached child, which inherits `{...process.env}` (§4.9).
 */
const SPY = join(SCRATCH, 'spawn-spy.cjs');
writeFileSync(SPY, `const fs = require('node:fs');
const out = process.env.MUBIT_TEST_SPY_FILE;
if (out) {
  try {
    fs.appendFileSync(out, JSON.stringify({
      argv: process.argv.slice(1),
      detached: process.env.MUBIT_CC_DETACHED || '',
      at: Date.now(),
    }) + '\\n');
  } catch {}
}
`);

function spyLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Every detached drain launched during a run, in order. */
function drainSpawns(file) {
  return spyLines(file).filter((l) => basename(String(l.argv?.[0] ?? '')) === 'drain.mjs');
}

function withSpy(env) {
  const file = join(SCRATCH, `spy-${randomUUID()}.jsonl`);
  return { file, env: { ...env, NODE_OPTIONS: `--require ${SPY}`, MUBIT_TEST_SPY_FILE: file } };
}

/** Env with a pinned run id, so state can be seeded before the hook runs. */
function staticEnv(dataDir, server, extra = {}) {
  return baseEnv({
    dataDir,
    endpoint: server.url,
    projectDir: dataDir,
    extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN_ID, ...extra },
  });
}

const runDir = (dataDir) => join(dataDir, 'runs', RUN_ID);

/**
 * Hold the drain lock ourselves so any detached drain exits at step 1 without dialing.
 * Keeps "capture issues zero HTTP" an assertion about capture, not a race with its child.
 */
function holdDrainLock(dataDir) {
  mkdirSync(runDir(dataDir), { recursive: true });
  writeFileSync(join(runDir(dataDir), 'drain.lock'),
    JSON.stringify({ pid: process.pid, ts: Date.now() }));
}

/** The staged prompt `Stop` does not carry (§5.3). */
function seedTurn(dataDir, over = {}) {
  const dir = join(runDir(dataDir), 'turns');
  mkdirSync(dir, { recursive: true });
  const turn = {
    prompt: STAGED_PROMPT,
    prompt_id: PROMPT_ID,
    session_id: SESSION_ID,
    started_at: Date.now(),
    recalled: ['ref_rule_1'],
    ...over,
  };
  writeFileSync(join(dir, `${PROMPT_ID}.json`), JSON.stringify(turn));
  return join(dir, `${PROMPT_ID}.json`);
}

/** The one spool file an invocation is allowed to write. */
function soleItem(dataDir, runId) {
  const files = spoolFiles(dataDir, runId);
  assert.equal(files.length, 1, `expected exactly one spool file, got ${files.length}`);
  return readJsonFile(files[0]);
}

/** §1.3 + §1.5: the fields no item may ever be missing. */
function assertRequiredItemFields(item) {
  assert.equal(typeof item.item_id, 'string');
  assert.ok(item.item_id.length > 0, 'item_id is REQUIRED (§1.3) — a missing one is a 422');
  assert.equal(item.content_type, 'text', 'content_type is REQUIRED (§1.3)');
  assert.equal(typeof item.intent, 'string');
  assert.ok(item.intent.length > 0,
    'intent is ALWAYS set (§1.5) — omitting it costs one server-side LLM call per item');
  assert.notEqual(item.intent, 'unclassified',
    '"unclassified" is the LLM fallback trigger, not a classification');
  assert.equal(item.source, 'agent');
  assert.ok(['low', 'medium', 'high'].includes(item.importance), `bad importance ${item.importance}`);
  assert.equal(typeof item.text, 'string');
  assert.ok(item.text.length > 0);
  assert.ok(Array.isArray(item.env_tags));
  assert.equal(typeof item.metadata_json, 'string', 'metadata_json goes on the wire as a string');
  JSON.parse(item.metadata_json);
  // Seconds, as in the §5.4 example and the `spoolItem` fixture.
  assert.equal(typeof item.occurrence_time, 'number');
  assert.ok(Math.abs(item.occurrence_time - Date.now() / 1000) < 600,
    `occurrence_time ${item.occurrence_time} is not a recent unix timestamp in seconds`);
}

// What `capture` may cost on top of starting node — `assertWithinBudget` measures that floor
// rather than assuming it.
//
// The §5.4 target is 40 ms of work and the idle measurement is ~53 ms, so 800 is fifteen times
// the real cost. It is set from the other end: with four suites running at once the figure was
// seen at 456 ms, because parsing a bundle contends for CPU in a way subtracting the spawn
// floor cannot fully remove. A budget under that measures the machine. This is a guard-rail
// against a gross regression — a sleep, a retry loop, a directory walk — and not a stopwatch;
// the zero-network claim is asserted exactly, by request count, and does not lean on it.
const BUDGET_MS = 800;

/**
 * A fake Mubit whose listening socket is closed even when the test fails — otherwise an
 * open handle keeps the test process alive and the whole run hangs.
 * @param {any} t @param {any} [routes]
 */
async function mubit(t, routes) {
  const server = await fakeMubit(routes);
  t.after(() => server.close());
  return server;
}

// ---------------------------------------------------------------------------

// §5.4 — PostToolUse writes exactly one spool file, shaped as §5.4, and dials nothing.
test('capture: PostToolUse writes exactly one correctly shaped spool item and issues zero HTTP', async (t) => {
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir({ files: { 'Cargo.toml': '[package]\nname = "x"\n' } });
  const server = await mubit(t);
  const r = await runHook('capture', postToolUse(), {
    env: baseEnv({ dataDir, endpoint: server.url, projectDir }),
  });

  assertHookContract(r);
  assert.deepEqual(r.json, { suppressOutput: true }, 'stdout is {"suppressOutput":true} in every mode');
  assert.equal(server.requests.length, 0,
    `capture must issue ZERO HTTP requests; saw: ${server.summary()}`);
  await assertWithinBudget('capture', BUDGET_MS, r.ms, async () => (await runHook(
    'capture', postToolUse(),
    { env: baseEnv({ dataDir: makeDataDir(), endpoint: server.url, projectDir }) },
  )).ms);

  const item = soleItem(dataDir, soleRunId(dataDir));
  assertRequiredItemFields(item);
  // "<tool>(<params>) -> <capped output>"
  assert.match(item.text, /^Edit\(/);
  assert.ok(item.text.includes(') -> '), `text must be "<tool>(<params>) -> <output>": ${item.text}`);
  assert.ok(item.text.includes('lib.rs'), 'params must be rendered into the text');
  assert.ok(item.text.includes('Applied 1 edit to src/lib.rs'), 'tool output must be rendered');
  assert.ok(item.env_tags.includes('tool:claude-code'));

  const meta = JSON.parse(item.metadata_json);
  assert.equal(meta.tool, 'Edit');
  assert.equal(meta.tool_use_id, TOOL_USE_ID);
});

// §5.4 — "item_id is stable per tool call so a retried drain deduplicates."
test('capture: item_id is derived from tool_use_id and stable across invocations', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  const env = baseEnv({ dataDir, endpoint: server.url });

  await runHook('capture', postToolUse(), { env });
  await runHook('capture', postToolUse(), { env });
  const runId = soleRunId(dataDir);
  const twice = spoolFiles(dataDir, runId).map((f) => readJsonFile(f).item_id);
  assert.equal(twice.length, 2, 'each invocation writes its own spool file');
  assert.equal(twice[0], twice[1],
    'the same tool call must yield the same item_id — that is what makes a retried drain a no-op');

  await runHook('capture', postToolUse({ tool_use_id: 'toolu_01ZZZZZZZZZZZZZZZZZZZZZZ' }), { env });
  const all = new Set(spoolFiles(dataDir, runId).map((f) => readJsonFile(f).item_id));
  assert.equal(all.size, 2, 'a different tool call must yield a different item_id');
});

// §5.4 + §4.5 — a failed approach is the highest-value thing a coding agent can remember,
// so PostToolUseFailure is intent:"trace" at importance:"high".
test('capture --failure: FAILED text, intent "trace", importance "high"', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  const r = await runHook('capture', postToolUseFailure(), {
    env: baseEnv({ dataDir, endpoint: server.url }),
    args: ['--failure'],
  });

  assertHookContract(r);
  assert.deepEqual(r.json, { suppressOutput: true });
  assert.equal(server.requests.length, 0, `capture must issue ZERO HTTP requests; saw: ${server.summary()}`);

  const item = soleItem(dataDir, soleRunId(dataDir));
  assertRequiredItemFields(item);
  assert.equal(item.intent, 'trace');
  assert.equal(item.importance, 'high');
  // "<tool>(<params>) FAILED: <capped error>"
  assert.match(item.text, /^Bash\(/);
  assert.ok(item.text.includes(' FAILED: '), `text must carry FAILED: ${item.text}`);
  assert.ok(item.text.includes('E0433'), 'the error text is the payload');
});

// §5.4 — Stop carries `last_assistant_message` but NOT the prompt, so the Q&A pair is
// assembled from the staged turn file; §4.5 classifies the pair as a `task_result`.
test('capture --stop: task_result carrying both the staged prompt and the assistant message', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  holdDrainLock(dataDir);
  const turnPath = seedTurn(dataDir);
  const { env } = withSpy(staticEnv(dataDir, server));

  const r = await runHook('capture', stop(), { env, args: ['--stop'] });

  assertHookContract(r);
  assert.deepEqual(r.json, { suppressOutput: true });
  await assertWithinBudget('capture --stop', BUDGET_MS, r.ms, async () => {
    const d = makeDataDir();
    holdDrainLock(d);
    seedTurn(d);
    return (await runHook('capture', stop(),
      { env: withSpy(staticEnv(d, server)).env, args: ['--stop'] })).ms;
  });

  const item = soleItem(dataDir, RUN_ID);
  assertRequiredItemFields(item);
  assert.equal(item.intent, 'task_result');
  assert.equal(item.importance, 'medium');
  // "Q: <staged prompt>\n\nA: <capped assistant message>"
  assert.ok(item.text.startsWith('Q: '), `text must start with "Q: ": ${item.text}`);
  assert.ok(item.text.includes(STAGED_PROMPT), 'the staged prompt is half the conversation');
  assert.ok(item.text.includes('\n\nA: '), `text must separate Q and A: ${JSON.stringify(item.text)}`);
  assert.ok(item.text.includes('The job stays queued until'), 'the assistant message is the other half');
  assert.ok(!item.text.includes('sub_01HZXK8Q9N7M'), 'a top-level Stop is not a subagent turn');

  // §5.4 step 8 — the turn file gains the end markers without losing what was staged.
  const turn = readJsonFile(turnPath);
  assert.equal(typeof turn.ended_at, 'number');
  assert.equal(turn.outcome_pending, true);
  assert.equal(turn.prompt, STAGED_PROMPT, 'capture must not clobber the staged prompt');
  assert.deepEqual(turn.recalled, ['ref_rule_1'], 'capture must not clobber the recalled ids');
});

// §5.4 step 8 — `--stop` ALWAYS spawns a drain, and always with `--with-outcome <prompt_id>`:
// the turn is over, so this is the moment its attribution can be recorded.
test('capture --stop: always spawns a drain with --with-outcome <prompt_id>', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  holdDrainLock(dataDir);
  seedTurn(dataDir);
  const { env, file } = withSpy(staticEnv(dataDir, server));

  const r = await runHook('capture', stop(), { env, args: ['--stop'] });
  assertHookContract(r);

  const spawns = await waitForSpawn(file);
  assert.equal(spawns.length, 1, 'exactly one drain, even though no batch trigger fired');
  assert.ok(spawns[0].argv.includes('--with-outcome'), `drain argv: ${JSON.stringify(spawns[0].argv)}`);
  assert.equal(spawns[0].argv[spawns[0].argv.indexOf('--with-outcome') + 1], PROMPT_ID);
  assert.equal(spawns[0].detached, '1');
});

// §5.4 step 8 — plain PostToolUse spawns a drain ONLY when a trigger fires. Spawning one
// per tool call would pay node's startup twice for every tool the model touches.
test('capture: PostToolUse spawns no drain until a batch trigger fires', async (t) => {
  const server = await mubit(t);

  // No trigger: one fresh item, batchMaxItems 32.
  const quiet = makeDataDir();
  holdDrainLock(quiet);
  const a = withSpy(staticEnv(quiet, server));
  const r1 = await runHook('capture', postToolUse(), { env: a.env });
  assertHookContract(r1);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(drainSpawns(a.file).length, 0, 'no trigger fired, so no drain may be spawned');
  assert.equal(server.requests.length, 0, `capture must issue ZERO HTTP requests; saw: ${server.summary()}`);

  // Count trigger: batchMaxItems 1 means this capture's own item trips it.
  const busy = makeDataDir();
  holdDrainLock(busy);
  const b = withSpy(staticEnv(busy, server, { MUBIT_CC_BATCH_MAX_ITEMS: '1' }));
  const r2 = await runHook('capture', postToolUse(), { env: b.env });
  assertHookContract(r2);
  const spawns = await waitForSpawn(b.file);
  assert.equal(spawns.length, 1, 'the count trigger must spawn exactly one drain');
  assert.equal(spawns[0].detached, '1');
});

/** The child is a separate process; give it a moment to record itself. */
async function waitForSpawn(file, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = drainSpawns(file);
    if (s.length) return s;
    if (Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// §4.5 — a SubagentStop is attributed to the subagent's own agent_id, not the parent's.
// The batch-level agent_id cannot carry it, so it rides on the item.
test('capture --subagent: attributes the item to the subagent agent_id', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  seedTurn(dataDir);
  const r = await runHook('capture', subagentStop(), {
    env: staticEnv(dataDir, server),
    args: ['--subagent'],
  });

  assertHookContract(r);
  assert.equal(server.requests.length, 0, `capture must issue ZERO HTTP requests; saw: ${server.summary()}`);
  const item = soleItem(dataDir, RUN_ID);
  assertRequiredItemFields(item);
  assert.equal(item.intent, 'task_result');
  assert.ok(item.text.startsWith('Q: '));
  assert.ok(item.text.includes('Found three call sites'));
  assert.ok(JSON.stringify(item).includes('sub_01HZXK8Q9N7M'),
    `the subagent's own agent_id must appear on the item: ${item.metadata_json}`);
});

// §4.4 — self-reference suppression. Without it the plugin records its own traffic,
// recalls it, then records the recall.
test('capture: a self-referential tool call drops silently', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  const env = staticEnv(dataDir, server);

  const mcp = await runHook('capture', postToolUse({
    tool_name: 'mcp__plugin_mubit-memory_mubit__mubit_recall',
    tool_input: { query: 'ingest job stuck' },
  }), { env });
  assertHookContract(mcp);
  assert.deepEqual(mcp.json, { suppressOutput: true });

  const bash = await runHook('capture', postToolUse({
    tool_name: 'Bash',
    tool_input: { command: `curl -s ${server.url}/v2/control/context` },
    tool_use_id: 'toolu_01SELFREFERENCE000000000',
  }), { env });
  assertHookContract(bash);

  assert.equal(spoolFiles(dataDir, RUN_ID).length, 0,
    'self-referential captures must be dropped, silently and without spooling');
  assert.equal(server.requests.length, 0);
});

// §4.4 stage 2 — a denied path is dropped entirely, not scrubbed.
test('capture: a denylisted path drops silently', async (t) => {
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir({ files: { '.env': `OPENAI_API_KEY=${SECRETS.openaiKey}\n` } });
  const server = await mubit(t);
  const r = await runHook('capture', postToolUse({
    tool_name: 'Read',
    tool_input: { file_path: join(projectDir, '.env') },
    tool_output: { type: 'text', text: `OPENAI_API_KEY=${SECRETS.openaiKey}` },
  }), {
    env: baseEnv({
      dataDir, endpoint: server.url, projectDir,
      extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN_ID },
    }),
  });

  assertHookContract(r);
  assert.deepEqual(r.json, { suppressOutput: true });
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 0, '.env is on the denylist (§4.4)');
});

// §5.4 — zero HTTP in EVERY mode. Capture's only outbound work is spawnDetached('drain'),
// and we hold the drain lock so that child exits before dialing anything.
test('capture: issues zero HTTP requests in all four modes', async (t) => {
  const server = await mubit(t);
  const modes = [
    { args: [], payload: postToolUse() },
    { args: ['--failure'], payload: postToolUseFailure() },
    { args: ['--stop'], payload: stop() },
    { args: ['--subagent'], payload: subagentStop() },
  ];

  for (const m of modes) {
    const dataDir = makeDataDir();
    holdDrainLock(dataDir);
    seedTurn(dataDir);
    const r = await runHook('capture', m.payload, { env: staticEnv(dataDir, server), args: m.args });
    assertHookContract(r);
    assert.deepEqual(r.json, { suppressOutput: true },
      `mode ${m.args.join(' ') || '(none)'} must emit {"suppressOutput":true}`);
  }

  // Give any detached child time to prove it does not dial while another drainer holds the lock.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(server.requests.length, 0,
    `capture must issue ZERO HTTP requests in every mode; saw: ${server.summary()}`);
});

// §5.4 — "every step is individually try/caught: a redaction crash drops the item rather
// than sending it unredacted." Hostile input must cost the item, never the tool call.
test('capture: hostile tool_input drops the item rather than spooling it unredacted', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);

  /** @type {any} */
  let deep = { leaf: SECRETS.openaiKey };
  for (let i = 0; i < 800; i++) deep = { [`k${i}`]: deep };

  const hostile = postToolUse({
    tool_name: 'Bash',
    tool_input: {
      command: `echo ${SECRETS.githubToken}`,
      deep,
      huge: 'A'.repeat(2 * 1024 * 1024),
      nope: null,
      count: Number.NaN,
      flags: [true, false, 12, null, { nested: SECRETS.awsKey }],
      buf: { type: 'Buffer', data: Array.from({ length: 4096 }, (_, i) => i % 256) },
    },
    tool_output: { type: 'text', text: `token=${SECRETS.mubitKey}` },
    tool_use_id: 'toolu_01HOSTILE0000000000000A',
  });

  const r = await runHook('capture', hostile, { env: staticEnv(dataDir, server) });

  assertHookContract(r);
  assert.deepEqual(r.json, { suppressOutput: true });
  assert.equal(server.requests.length, 0);

  const files = spoolFiles(dataDir, RUN_ID);
  assert.ok(files.length <= 1, 'at most one item per invocation, dropped or not');
  for (const f of files) {
    const raw = readFileSync(f, 'utf8');
    for (const [name, secret] of Object.entries({
      openai: SECRETS.openaiKey, github: SECRETS.githubToken,
      aws: SECRETS.awsKey, mubit: SECRETS.mubitKey,
    })) {
      assert.ok(!raw.includes(secret), `spooled item leaked the ${name} secret`);
    }
    assertRequiredItemFields(JSON.parse(raw));
  }
});
