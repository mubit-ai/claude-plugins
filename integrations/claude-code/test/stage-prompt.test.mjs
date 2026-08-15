// @ts-check
/**
 * `hooks/src/stage-prompt.mjs` — UserPromptSubmit, fast path (§5.3).
 *
 * Budget < 25 ms, zero network. It exists because the `Stop` payload carries
 * `last_assistant_message` but **not** the prompt that produced it: without staging, every
 * captured turn would be half a conversation. It is also the drain's user-paced trigger —
 * a new prompt arriving is exactly when the previous turn's captures are complete.
 *
 * The interesting part is that it shares `runs/<run_id>/turns/<prompt_id>.json` with
 * `prompt-recall`, which fills `recalled` in the same file on the same event. Both
 * orderings must end with a file carrying the prompt AND the recalled ids; neither hook
 * may clobber the other's field. That is the race §5.3 calls out, and it is the reason
 * both hooks are specified as read-modify-write-atomic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  runHook, assertHookContract, fakeMubit, baseEnv, makeDataDir, readJsonFile, tempDir,
} from './helpers/harness.mjs';
import { userPromptSubmit, spoolItem, PROMPT_ID, SESSION_ID } from './helpers/fixtures.mjs';

const RUN_ID = 'cc-test-0000';
const PROMPT = 'why is the ingest job stuck in queued?';

// Wall-clock ceiling. Real target is <25ms; this is a guard-rail against a network call
// sneaking onto the fast path, not a stopwatch.
const BUDGET_MS = 400;

// ---------------------------------------------------------------------------

const SCRATCH = tempDir('mubit-cc-stage-');
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

function drainSpawns(file) {
  return spyLines(file).filter((l) => basename(String(l.argv?.[0] ?? '')) === 'drain.mjs');
}

function withSpy(env) {
  const file = join(SCRATCH, `spy-${randomUUID()}.jsonl`);
  return { file, env: { ...env, NODE_OPTIONS: `--require ${SPY}`, MUBIT_TEST_SPY_FILE: file } };
}

async function waitForSpawn(file, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = drainSpawns(file);
    if (s.length) return s;
    if (Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
}

function staticEnv(dataDir, server, extra = {}) {
  return baseEnv({
    dataDir,
    endpoint: server.url,
    projectDir: dataDir,
    extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN_ID, ...extra },
  });
}

const runDir = (dataDir) => join(dataDir, 'runs', RUN_ID);
const turnPath = (dataDir) => join(runDir(dataDir), 'turns', `${PROMPT_ID}.json`);

/** Hold the drain lock so a triggered drain records its spawn and then exits without dialing. */
function holdDrainLock(dataDir) {
  mkdirSync(runDir(dataDir), { recursive: true });
  writeFileSync(join(runDir(dataDir), 'drain.lock'),
    JSON.stringify({ pid: process.pid, ts: Date.now() }));
}

/** @param {string} dataDir @param {number} n @param {number} [ageMs] */
function seedSpool(dataDir, n, ageMs = 0) {
  const dir = join(runDir(dataDir), 'spool');
  mkdirSync(dir, { recursive: true });
  const base = Date.now() - ageMs;
  for (let i = 0; i < n; i++) {
    const ts = base + i;
    const p = join(dir, `${ts}-${String(i).padStart(6, '0')}.json`);
    writeFileSync(p, JSON.stringify(spoolItem({ item_id: `cc-seed-${i}` })));
    const secs = ts / 1000;
    utimesSync(p, secs, secs);
  }
}

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

// §5.3 step 1 — the staged turn file, and nothing on the wire.
test('stage-prompt: writes turns/<prompt_id>.json and issues zero HTTP', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  const r = await runHook('stage-prompt', userPromptSubmit({ prompt: PROMPT }), {
    env: staticEnv(dataDir, server),
  });

  assertHookContract(r);
  assert.deepEqual(r.json, { suppressOutput: true });
  assert.equal(server.requests.length, 0,
    `stage-prompt is the zero-network fast path; saw: ${server.summary()}`);
  assert.ok(r.ms < BUDGET_MS, `stage-prompt took ${r.ms}ms; budget is <25ms (§5.3)`);

  const turn = readJsonFile(turnPath(dataDir));
  assert.equal(turn.prompt, PROMPT);
  assert.equal(turn.prompt_id, PROMPT_ID);
  assert.equal(turn.session_id, SESSION_ID);
  assert.equal(typeof turn.started_at, 'number');
  assert.ok(Math.abs(turn.started_at - Date.now()) < 60_000, 'started_at must be a recent ms timestamp');
  assert.deepEqual(turn.recalled, [], 'prompt-recall fills `recalled` in this same file');
});

// §5.3 — race, ordering A: stage first, then recall. Recall must merge, not overwrite.
test('stage-prompt then prompt-recall: the turn file keeps both the prompt and the recalled ids', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  const env = staticEnv(dataDir, server);
  const payload = userPromptSubmit({ prompt: PROMPT });

  assertHookContract(await runHook('stage-prompt', payload, { env }));
  assertHookContract(await runHook('prompt-recall', payload, { env }));

  const turn = readJsonFile(turnPath(dataDir));
  assert.equal(turn.prompt, PROMPT, 'prompt-recall must not clobber the staged prompt');
  assert.ok(Array.isArray(turn.recalled) && turn.recalled.length > 0,
    `expected recalled reference_ids, got ${JSON.stringify(turn.recalled)}`);
  assert.ok(turn.recalled.includes('ref_rule_1'),
    'recalled carries reference_id — not id — because that is what feeds RecordOutcome.entry_ids');
});

// §5.3 — race, ordering B: recall lands first. Staging must merge, not overwrite.
test('prompt-recall then stage-prompt: the turn file keeps both the prompt and the recalled ids', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  const env = staticEnv(dataDir, server);
  const payload = userPromptSubmit({ prompt: PROMPT });

  assertHookContract(await runHook('prompt-recall', payload, { env }));
  assertHookContract(await runHook('stage-prompt', payload, { env }));

  const turn = readJsonFile(turnPath(dataDir));
  assert.equal(turn.prompt, PROMPT);
  assert.ok(Array.isArray(turn.recalled) && turn.recalled.includes('ref_rule_1'),
    `stage-prompt clobbered the recalled ids: ${JSON.stringify(turn.recalled)}`);
});

// §5.3 step 2 — count trigger: spoolStats().count >= batchMaxItems.
test('stage-prompt: spawns a drain when the item-count trigger fires', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  holdDrainLock(dataDir);
  seedSpool(dataDir, 3);
  const { env, file } = withSpy(staticEnv(dataDir, server, { MUBIT_CC_BATCH_MAX_ITEMS: '2' }));

  const r = await runHook('stage-prompt', userPromptSubmit({ prompt: PROMPT }), { env });
  assertHookContract(r);

  const spawns = await waitForSpawn(file);
  assert.equal(spawns.length, 1, '3 spooled items against batchMaxItems=2 must spawn exactly one drain');
  assert.equal(spawns[0].detached, '1');
});

// §5.3 step 2 — age trigger: spoolStats().oldestMs >= batchMaxAgeMs. A quiet session still
// gets its captures flushed on the next prompt.
test('stage-prompt: spawns a drain when the oldest-item age trigger fires', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  holdDrainLock(dataDir);
  seedSpool(dataDir, 1, 60_000);
  const { env, file } = withSpy(staticEnv(dataDir, server, {
    MUBIT_CC_BATCH_MAX_ITEMS: '32',
    MUBIT_CC_BATCH_MAX_AGE_MS: '1000',
  }));

  const r = await runHook('stage-prompt', userPromptSubmit({ prompt: PROMPT }), { env });
  assertHookContract(r);

  const spawns = await waitForSpawn(file);
  assert.equal(spawns.length, 1, 'a 60s-old spool item against maxAge=1000ms must spawn one drain');
});

// §5.3 step 2 — neither trigger fires: no drain, and still nothing on the wire.
test('stage-prompt: spawns no drain when neither trigger fires', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  holdDrainLock(dataDir);
  seedSpool(dataDir, 1);
  const { env, file } = withSpy(staticEnv(dataDir, server, {
    MUBIT_CC_BATCH_MAX_ITEMS: '32',
    MUBIT_CC_BATCH_MAX_AGE_MS: '30000',
  }));

  const r = await runHook('stage-prompt', userPromptSubmit({ prompt: PROMPT }), { env });
  assertHookContract(r);
  await new Promise((res) => setTimeout(res, 250));

  assert.equal(drainSpawns(file).length, 0,
    'one fresh item is neither 32 items nor 30s old — no drain');
  assert.equal(server.requests.length, 0, `saw unexpected HTTP: ${server.summary()}`);
});

// §5.3 — "Failure: swallow everything; the cost is one Q&A pair." An unwritable data dir
// must not turn into a failed hook, and certainly not into a blocked prompt.
test('stage-prompt: exits 0 with valid JSON when the data dir is unwritable', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root: permissions are unenforceable');
    return;
  }
  const dataDir = makeDataDir();
  const server = await mubit(t);
  const dir = runDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const before = statSync(dir).mode;
  chmodSync(dir, 0o555);
  try {
    const r = await runHook('stage-prompt', userPromptSubmit({ prompt: PROMPT }), {
      env: staticEnv(dataDir, server),
    });
    assertHookContract(r);
    assert.deepEqual(r.json, { suppressOutput: true });
    assert.equal(existsSync(turnPath(dataDir)), false, 'nothing could be written — that is the whole cost');
    assert.equal(server.requests.length, 0);
  } finally {
    chmodSync(dir, before);
  }
});
