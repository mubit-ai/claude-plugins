// @ts-check
/**
 * `hooks/src/capture.mjs` — PostToolUse / PostToolUseFailure / Stop / StopFailure /
 * SubagentStop (§5.4).
 *
 * One script, five modes by argv: none, `--failure`, `--stop`, `--stop-failure`,
 * `--subagent`.
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
  postToolUse, postToolUseFailure, postToolUseLegacyOutput, stop, stopFailure, subagentStop,
  PROMPT_ID, SESSION_ID, TOOL_USE_ID, SECRETS, RECORDED_RESPONSES,
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

/**
 * The standing guard for defect F1.
 *
 * A tool item is `"<tool>(<params>) -> <output>"`. For a year every shipped item ended at
 * the arrow, because capture read `payload.tool_output` and the host sends `tool_response`:
 * the plugin recorded that a file had been read and never what was in it. Nothing caught it,
 * because the only payload the tests had ever seen was one the tests wrote themselves.
 *
 * So: any item whose text reaches the arrow must carry something after it. Call this
 * wherever a fixture supplies a tool result — an empty tail there is F1, returned.
 */
function assertNonEmptyTail(item) {
  assert.ok(!/->\s*$/.test(item.text),
    `captured item ends at the arrow with no tool output — that is defect F1: ${JSON.stringify(item.text)}`);
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
  assertNonEmptyTail(item);
  assert.ok(item.env_tags.includes('tool:claude-code'));

  const meta = JSON.parse(item.metadata_json);
  assert.equal(meta.tool, 'Edit');
  assert.equal(meta.tool_use_id, TOOL_USE_ID);
  // The host calls it `duration_ms`; `execution_time_ms` is the older name and the one the
  // wire metadata keeps. Reading only the old one dated every capture at 0ms.
  assert.equal(meta.execution_time_ms, 42, 'the host sends duration_ms, not execution_time_ms');
});

// F1 — the host's field is `tool_response`. Every shipped memory read
// `Read(file_path=X) -> ` because capture read a name nothing ever sends.
test('capture: the tool result arrives as tool_response and lands in the item text', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  const r = await runHook('capture', postToolUse(), { env: staticEnv(dataDir, server) });

  assertHookContract(r);
  const item = soleItem(dataDir, RUN_ID);
  assertRequiredItemFields(item);
  assertNonEmptyTail(item);
  assert.ok(item.text.includes('Applied 1 edit to src/lib.rs'),
    `tool_response must be rendered after the arrow: ${JSON.stringify(item.text)}`);
});

// F1 — `tool_output` is the older host's name for the same thing. Keeping it as a fallback
// costs one `??`, and nothing is gained by making an old payload shape fail.
test('capture: the legacy tool_output field is still read as a fallback', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  const payload = postToolUseLegacyOutput();
  assert.equal(payload.tool_response, undefined, 'the legacy fixture must not also carry tool_response');

  const r = await runHook('capture', payload, { env: staticEnv(dataDir, server) });

  assertHookContract(r);
  const item = soleItem(dataDir, RUN_ID);
  assertRequiredItemFields(item);
  assertNonEmptyTail(item);
  assert.ok(item.text.includes('Applied 1 edit to src/lib.rs'),
    `tool_output must still be rendered after the arrow: ${JSON.stringify(item.text)}`);
});

// F1, standing regression — the six `tool_response` shapes taken off real transcripts. No
// two of them look alike, and the renderer has to find the payload in all of them.
test('capture: every recorded tool_response shape renders something after the arrow', async (t) => {
  const server = await mubit(t);

  for (const [tool, rec] of Object.entries(RECORDED_RESPONSES)) {
    const dataDir = makeDataDir();
    const r = await runHook('capture', postToolUse({
      tool_name: tool,
      tool_input: rec.tool_input,
      tool_response: rec.tool_response,
      tool_use_id: `toolu_01RECORDED${tool}`,
    }), { env: staticEnv(dataDir, server) });

    assertHookContract(r);
    const item = soleItem(dataDir, RUN_ID);
    assertRequiredItemFields(item);
    assertNonEmptyTail(item);
    assert.ok(item.text.includes(rec.expect),
      `${tool}: the recorded response's payload is missing from the item: ${JSON.stringify(item.text)}`);
  }
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

// ---------------------------------------------------------------------------
// The used-signal (§5.5) — the half of precision nothing measured
// ---------------------------------------------------------------------------

/** A turn as `prompt-recall` leaves it: ids to attribute, and the terms it injected. */
function seedRecalledTurn(dataDir, terms, over = {}) {
  return seedTurn(dataDir, {
    recalled: ['ref_rule_1'],
    recall: {
      at: Date.now() - 3000, rung: 1, sources: 1, tokens: 40, chars: 160,
      dropped: 0, empty_reason: '', terms,
    },
    ...over,
  });
}

// §5.5: the plugin cannot see whether the model READ the injected block — only whether the
// reply carries the memory's own vocabulary. So Stop records the evidence it found, not a
// verdict: the matched terms, the size of the set it searched, and the method that produced
// them, so a later reader knows what the number meant.
test('capture --stop: records which injected memory terms the reply echoed', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  holdDrainLock(dataDir);
  const turnPath = seedRecalledTurn(dataDir, ['idempotency', 'quarantine', 'hamming']);
  const { env } = withSpy(staticEnv(dataDir, server));

  const r = await runHook('capture', stop({
    last_assistant_message:
      'The batch is deduplicated server-side because the idempotency key is stable, '
      + 'so the retry is a no-op rather than a second quarantine.',
  }), { env, args: ['--stop'] });

  assertHookContract(r);
  const ev = readJsonFile(turnPath).used_evidence;
  assert.ok(ev && typeof ev === 'object', `no used-signal was recorded: ${JSON.stringify(readJsonFile(turnPath))}`);
  assert.equal(ev.used, true);
  assert.ok(typeof ev.method === 'string' && ev.method.length > 0,
    'the method has to be named on the record — a bare 1 or 0 is unreadable a version later');
  assert.deepEqual(ev.terms.sort(), ['idempotency', 'quarantine'],
    'the evidence is the terms that matched, not just how many');
  assert.equal(ev.matched, 2);
  assert.equal(ev.candidates, 3, 'the denominator is on the record too');
  assert.equal(typeof ev.at, 'number');
});

// §5.5: "injected and ignored" is the case the whole finding is about, so it is recorded
// positively rather than by absence. §4.4: it is recorded WITHOUT the reply — the turn file
// holds only terms that recall already staged and scrubbed, so nothing the assistant said
// can land here.
test('capture --stop: a reply that echoes nothing records the absence, and no fragment of the reply', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  holdDrainLock(dataDir);
  const turnPath = seedRecalledTurn(dataDir, ['idempotency', 'quarantine']);
  const { env } = withSpy(staticEnv(dataDir, server));

  const r = await runHook('capture', stop({
    last_assistant_message:
      `I pushed the branch with ${SECRETS.githubToken} in the remote URL; the pipeline is green.`,
  }), { env, args: ['--stop'] });

  assertHookContract(r);
  const staged = readJsonFile(turnPath);
  assert.equal(staged.used_evidence.used, false,
    'an ignored injection must be recorded, not left as silence');
  assert.equal(staged.used_evidence.matched, 0);
  assert.deepEqual(staged.used_evidence.terms, []);
  assert.equal(staged.used_evidence.candidates, 2);

  const raw = readFileSync(turnPath, 'utf8');
  assert.ok(!raw.includes(SECRETS.githubToken),
    `the turn file carries a credential from the reply:\n${raw}`);
  assert.ok(!raw.includes('pipeline'),
    'the used-signal must record what it looked FOR, never what the assistant said');
});

// A turn staged before this existed, or one where recall was off: there is no term set, so
// there is no signal. Recording `used: false` here would be a measurement of nothing, and
// the drain would read it as "the memory was ignored".
test('capture --stop: a turn with no staged recall record gets no used-signal at all', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  holdDrainLock(dataDir);
  const turnPath = seedTurn(dataDir);            // no `recall` key at all
  const { env } = withSpy(staticEnv(dataDir, server));

  const r = await runHook('capture', stop(), { env, args: ['--stop'] });

  assertHookContract(r);
  const staged = readJsonFile(turnPath);
  assert.equal(staged.used_evidence, undefined,
    `an unmeasurable turn must stay unmeasured: ${JSON.stringify(staged.used_evidence)}`);
  assert.equal(typeof staged.ended_at, 'number', 'the end markers are written either way');
  assert.equal(staged.outcome_pending, true);
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

// ---------------------------------------------------------------------------
// `--stop-failure` — the turn the API killed
// ---------------------------------------------------------------------------

/**
 * The fifth mode, and the one whose whole job is to make a *later* decision possible.
 *
 * The host's own registry, read out of Claude Code 2.1.235 the way the constants in
 * `hook-output.test.mjs` are:
 *
 *     StopFailure: {summary: "When the turn ends due to an API error",
 *       description: "Fires **instead of Stop** when an API error (rate limit, auth failure,
 *       etc.) ended the turn. Fire-and-forget — hook output and exit codes are ignored."}
 *
 * "Instead of Stop" is the fact the whole ticket turns on. `capture --stop` is the only thing
 * in this plugin that ever writes `ended_at` / `outcome_pending`, so on a rate-limited turn
 * nothing closed the turn file at all: it sat there holding `recalled` ids, half-written,
 * with no record anywhere that the turn had died or why. `--stop-failure` closes it and
 * stamps `api_error` — and `lib/outcome.mjs` reads that stamp and posts nothing.
 *
 * The mark has to be a key of its own rather than `outcome: "failure"`, which is what the
 * build guide's §5.5 originally called for ("On a StopFailure turn: outcome 'failure',
 * signal -0.3"). That row is exactly the one this ticket overturns: -0.3 against the
 * recalled ids says the *memory* was wrong, and a rate limit is not evidence about memory.
 */

/** A turn as `stage-prompt` + `prompt-recall` leave it, with terms staged to match against. */
const seedTermedTurn = (dataDir, over = {}) => seedTurn(dataDir, {
  recall: {
    at: Date.now() - 3000, rung: 1, sources: 1, tokens: 40, chars: 160,
    dropped: 0, empty_reason: '', terms: ['indexing', 'queued'],
  },
  ...over,
});

// THE test for this ticket, on capture's side of the wire: the turn is closed, the error is
// on the record, and nothing that could attribute it was started.
test('capture --stop-failure: closes the turn, stamps the API error, and starts no attribution', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  holdDrainLock(dataDir);
  const turnPath = seedTurn(dataDir);
  const { env, file } = withSpy(staticEnv(dataDir, server));

  const r = await runHook('capture', stopFailure(), { env, args: ['--stop-failure'] });

  assertHookContract(r);
  // "Fire-and-forget — hook output and exit codes are ignored", and `StopFailure` is absent
  // from the host's `hookEventName` union, so there is no channel to say anything on even if
  // there were something to say. `hook-output.test.mjs` pins the same shape against the host.
  assert.deepEqual(r.json, { suppressOutput: true });
  await assertWithinBudget('capture --stop-failure', BUDGET_MS, r.ms, async () => {
    const d = makeDataDir();
    holdDrainLock(d);
    seedTurn(d);
    return (await runHook('capture', stopFailure(),
      { env: withSpy(staticEnv(d, server)).env, args: ['--stop-failure'] })).ms;
  });

  const turn = readJsonFile(turnPath);
  assert.equal(turn.api_error, 'rate_limit',
    'without the stamp nothing downstream can tell a rate-limited turn from a completed one');
  assert.equal(typeof turn.ended_at, 'number',
    'Stop does not fire on this turn, so if --stop-failure does not close it nothing ever will');
  assert.equal(turn.outcome_pending, true,
    'the turn is a candidate for the outcome decision like any other; suppression is the '
    + 'decision\'s job, not a matter of hiding the turn from it');
  assert.equal(turn.prompt, STAGED_PROMPT, 'the staged prompt must survive the close');
  assert.deepEqual(turn.recalled, ['ref_rule_1'],
    'the recalled ids must survive: they are what a LATER, real outcome would attribute');

  // A turn that died on a rate limit produced no episode. "Q: fix the bug\n\nA: " is the
  // half-a-conversation this suite already has a name for, and paying to store and recall it
  // is worse than not having it.
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 0,
    'an API-killed turn is not a memory; spooling it bills for storing a truncated answer');

  assert.equal(server.requests.length, 0, `capture must issue ZERO HTTP requests; saw: ${server.summary()}`);
  await new Promise((res) => setTimeout(res, 250));
  assert.deepEqual(drainSpawns(file), [],
    'unlike --stop, this mode must NOT force a drain: the only reason --stop always drains '
    + 'is to carry --with-outcome, and this turn has no outcome to carry');
});

// The mark is the host's value, copied through. The taxonomy is not a list this plugin can
// keep: 2.1.235 ships ten values plus a feature-flagged eleventh (`account_on_hold`, behind
// `fOr()`), so the same host is right about the list on one account and wrong on another.
// That is why the registration carries no matcher — and why the mark is whatever arrived.
test('capture --stop-failure: records the error value the host sent, in or out of the taxonomy', async (t) => {
  const server = await mubit(t);

  /** @type {Array<{name: string, over: Record<string, any>, expect: string}>} */
  const rows = [
    { name: 'the common one', over: { error: 'rate_limit' }, expect: 'rate_limit' },
    { name: 'the taxonomy\'s own catch-all', over: { error: 'unknown' }, expect: 'unknown' },
    // Present only where `fOr()` is on. A hard-coded matcher list would silently drop this
    // turn on the accounts that have it.
    { name: 'the feature-flagged eleventh', over: { error: 'account_on_hold' }, expect: 'account_on_hold' },
    // The list the plugin was handed is a snapshot of one host build. A value it has never
    // heard of must still close the turn and still suppress the outcome.
    { name: 'a value added after this plugin shipped', over: { error: 'context_window_exceeded' }, expect: 'context_window_exceeded' },
    // The host itself defaults a missing one on the way to the matcher (`e.error ?? "unknown"`),
    // so an absent field is `unknown` here too rather than an empty mark that reads as "no
    // API error at all" — which would put the turn straight back into the outcome path.
    { name: 'no error field at all', over: { error: undefined }, expect: 'unknown' },
  ];

  for (const row of rows) {
    const dataDir = makeDataDir();
    holdDrainLock(dataDir);
    const turnPath = seedTurn(dataDir);

    const r = await runHook('capture', stopFailure(row.over), {
      env: staticEnv(dataDir, server), args: ['--stop-failure'],
    });

    assertHookContract(r);
    assert.equal(readJsonFile(turnPath).api_error, row.expect,
      `${row.name}: the stamp must carry the host's value, or the outcome decision reads the wrong turn`);
  }
});

// §5.5's used-signal measures whether the reply carried the injected memory's vocabulary.
// A reply the API cut off mid-sentence has no denominator — `max_output_tokens` is literally
// "the answer stopped early" — so measuring it would manufacture a `used: false` that
// `decideOutcome` reads as "the model ignored the memory". Left unmeasured on purpose.
test('capture --stop-failure: leaves the used-signal unmeasured even with terms staged', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  holdDrainLock(dataDir);
  const turnPath = seedTermedTurn(dataDir);

  const r = await runHook('capture', stopFailure({
    error: 'max_output_tokens',
    last_assistant_message: 'The indexing queue is still draining, so the job stays qu',
  }), { env: staticEnv(dataDir, server), args: ['--stop-failure'] });

  assertHookContract(r);
  const turn = readJsonFile(turnPath);
  assert.equal(turn.used_evidence, undefined,
    'a truncated reply is unmeasurable, not unused — recording `used: false` here would '
    + `report the memory as ignored: ${JSON.stringify(turn.used_evidence)}`);
  assert.equal(turn.api_error, 'max_output_tokens');
  assert.equal(turn.outcome_pending, true);
});

// The spool is still real work and still deserves to be sent — the model's API fell over,
// not Mubit's. So the ordinary batch trigger still applies; what never happens is the
// `--with-outcome` drain that only `--stop` fires.
test('capture --stop-failure: a batch trigger still drains, but never with --with-outcome', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  holdDrainLock(dataDir);
  seedTurn(dataDir);
  // One captured tool call already in the spool, and a batch size of 1 so it is over the line.
  const { env, file } = withSpy(staticEnv(dataDir, server, { MUBIT_CC_BATCH_MAX_ITEMS: '1' }));
  assertHookContract(await runHook('capture', postToolUse(), { env }));

  const r = await runHook('capture', stopFailure(), { env, args: ['--stop-failure'] });
  assertHookContract(r);

  const spawns = await waitForSpawn(file);
  assert.ok(spawns.length >= 1, 'a full batch must still be drained; the API error is the model\'s, not Mubit\'s');
  for (const s of spawns) {
    assert.ok(!s.argv.includes('--with-outcome'),
      `no drain from this path may carry attribution: ${JSON.stringify(s.argv)}`);
  }
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

/**
 * F2 — the tool set is the host's, not the plugin's.
 *
 * `hooks.json` now matches every tool, so what is worth remembering is decided here, in
 * code, where it can be tested. `Agent` — a delegated investigation, among the highest-value
 * episodes there is — was still reaching the old allowlist, but only because the host tests
 * a matcher against a tool's former names too and so kept matching `Agent` against the
 * long-dead `Task`. The plugin was relying on a compatibility table it does not own and
 * cannot inspect. `TodoWrite` is the model rewriting its own checklist and carries no
 * memory at all.
 */
test('capture: an Agent dispatch is captured and a TodoWrite is skipped', async (t) => {
  const server = await mubit(t);

  const kept = makeDataDir();
  const a = await runHook('capture', postToolUse({
    tool_name: 'Agent',
    tool_input: { description: 'Explore the matcher', subagent_type: 'Explore' },
    tool_response: { isAsync: true, status: 'async_launched', agentId: 'aa1ef5c824d2b98' },
    tool_use_id: 'toolu_01AGENTDISPATCH000000000',
  }), { env: staticEnv(kept, server) });
  assertHookContract(a);
  const item = soleItem(kept, RUN_ID);
  assertRequiredItemFields(item);
  assertNonEmptyTail(item);
  assert.match(item.text, /^Agent\(/, 'a subagent dispatch is an episode worth keeping');

  const dropped = makeDataDir();
  const b = await runHook('capture', postToolUse({
    tool_name: 'TodoWrite',
    tool_input: { todos: [{ content: 'fix the matcher', status: 'in_progress' }] },
    tool_response: { newTodos: [{ content: 'fix the matcher', status: 'in_progress' }] },
    tool_use_id: 'toolu_01TODOWRITE00000000000A',
  }), { env: staticEnv(dropped, server) });
  assertHookContract(b);
  assert.deepEqual(b.json, { suppressOutput: true }, 'a skipped tool is still silent to the host');
  assert.equal(spoolFiles(dropped, RUN_ID).length, 0,
    'TodoWrite carries no memory — it must be skipped in code now that the matcher lets it through');
});

// F2 — the whole skip list, each name and the reason it earns no memory. These arrive now
// only because the matcher stopped filtering; every one of them is bookkeeping, or a
// duplicate of something already captured. Anything NOT on this list is kept, including
// tools that did not exist when it was written — that is the point of the inversion, so the
// `kept` half below is the half that matters.
test('capture: every tool on the skip list is dropped, and its neighbours are not', async (t) => {
  const server = await mubit(t);

  const skipped = ['TodoWrite', 'EnterPlanMode', 'ExitPlanMode', 'ToolSearch',
    'ListAgents', 'TaskList', 'CronList', 'Monitor', 'ScheduleWakeup', 'StructuredOutput'];
  for (const tool of skipped) {
    const dataDir = makeDataDir();
    const r = await runHook('capture', postToolUse({
      tool_name: tool,
      tool_input: { q: 'x' },
      tool_response: { success: true },
      tool_use_id: `toolu_01SKIP${tool}`,
    }), { env: staticEnv(dataDir, server) });
    assertHookContract(r);
    assert.equal(spoolFiles(dataDir, RUN_ID).length, 0, `${tool} must be skipped`);
  }

  // `AskUserQuestion` is first on purpose: it is the closest call on the list and the one a
  // future tidy-up will reach for. Its result carries what the human chose and what they
  // turned down — §4.5's `feedback`, and the one fact no amount of reading the codebase
  // reproduces.
  const kept = ['AskUserQuestion', 'ReportFindings', 'CronCreate', 'CronDelete',
    'EnterWorktree', 'ExitWorktree', 'LSP', 'Workflow',
    'TaskCreate', 'TaskUpdate', 'TaskStop', 'Skill', 'SendMessage', 'Artifact',
    'TaskOutput', 'mcp__github__create_issue'];
  for (const tool of kept) {
    const dataDir = makeDataDir();
    const r = await runHook('capture', postToolUse({
      tool_name: tool,
      tool_input: { q: 'x' },
      tool_response: { success: true },
      tool_use_id: `toolu_01KEEP${tool}`,
    }), { env: staticEnv(dataDir, server) });
    assertHookContract(r);
    assert.equal(spoolFiles(dataDir, RUN_ID).length, 1, `${tool} must be captured`);
  }
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

/**
 * §4.4 — the same suppression for the tool that reads a background task's output.
 *
 * `isSelfReference` named `BashOutput` and then read `input.command`, which a `BashOutput`
 * input has never carried: it identifies its subject by handle (`task_id`/`bash_id`), so the
 * branch was dead for exactly the tool it named. What a background-task read CAN carry is
 * whatever the model typed — the output `filter`, or the name it gave the task.
 */
test('capture: a self-referential BashOutput drops silently', async (t) => {
  const server = await mubit(t);

  for (const [why, tool_input] of [
    ['a filter hunting our env vars', { bash_id: 'bash_1', filter: 'MUBIT_API_KEY' }],
    ['a task named after us', { task_id: 'mubit-drain', block: false, timeout: 30000 }],
  ]) {
    const dataDir = makeDataDir();
    const r = await runHook('capture', postToolUse({
      tool_name: 'BashOutput',
      tool_input,
      tool_response: { stdout: 'ok', stderr: '', interrupted: false },
      tool_use_id: 'toolu_01BASHOUTPUTSELFREF00000',
    }), { env: staticEnv(dataDir, server) });
    assertHookContract(r);
    assert.deepEqual(r.json, { suppressOutput: true });
    assert.equal(spoolFiles(dataDir, RUN_ID).length, 0, `BashOutput with ${why} must be dropped`);
  }

  // …and an ordinary background-task read is still kept. A handle is not a self-reference.
  const kept = makeDataDir();
  const ok = await runHook('capture', postToolUse({
    tool_name: 'BashOutput',
    tool_input: { bash_id: 'bash_12', filter: 'error' },
    tool_response: { stdout: 'error: E0433', stderr: '', interrupted: false },
    tool_use_id: 'toolu_01BASHOUTPUTKEEP00000000',
  }), { env: staticEnv(kept, server) });
  assertHookContract(ok);
  assert.equal(spoolFiles(kept, RUN_ID).length, 1,
    'a background-task read of an unrelated shell is ordinary tool output');
});

// §4.4 stage 2 — a denied path is dropped entirely, not scrubbed.
test('capture: a denylisted path drops silently', async (t) => {
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir({ files: { '.env': `OPENAI_API_KEY=${SECRETS.openaiKey}\n` } });
  const server = await mubit(t);
  const r = await runHook('capture', postToolUse({
    tool_name: 'Read',
    tool_input: { file_path: join(projectDir, '.env') },
    tool_response: { type: 'text', text: `OPENAI_API_KEY=${SECRETS.openaiKey}` },
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
    tool_response: { type: 'text', text: `token=${SECRETS.mubitKey}` },
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
