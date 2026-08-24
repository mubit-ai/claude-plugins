// @ts-check
/**
 * `recallAsync` — the carry-forward recall path (§5.2, and item 6 of the hook-surface handoff).
 *
 * ---------------------------------------------------------------------------
 * What is being claimed, and what would falsify it
 * ---------------------------------------------------------------------------
 * Recall blocks every prompt for up to `recallBudgetMs`, and the documented workaround for a
 * Mubit that answers in 1.4-2.3 s against a 1500 ms default is for the user to raise
 * `MUBIT_CC_RECALL_BUDGET_MS` by hand — which trades a truncated recall for a slower prompt.
 * `recallAsync` removes the trade: the hook renders a block the **previous** turn's detached
 * refresh left on disk and returns without dialling anything.
 *
 * Three claims, one test group each:
 *
 *   1. **Nothing changes for anyone who does not opt in.** The flag defaults to false, and
 *      with it unset the hook still dials on the turn and still injects on the turn. The rest
 *      of this suite's 929 assertions are the real proof of that; the one here is the
 *      structural half — no carry file, no refresh process.
 *   2. **Attribution is correct by construction.** The handoff worried that "the turn that
 *      receives the block is not the turn that requested it". Under carry-forward the write
 *      happens on the synchronous *read*, against the prompt id in hand, so the ids land on
 *      the turn that was actually given them. `recalledLandsOnTheReceivingTurn` is the most
 *      valuable assertion in this file.
 *   3. **The wall clock stops tracking the endpoint.** Pinned against a real loopback server
 *      with `delayMs`, so no test sleeps and no test guesses.
 *
 * ---------------------------------------------------------------------------
 * Why not `"async": true` in `hooks.json`
 * ---------------------------------------------------------------------------
 * `async` and `asyncRewake` are real host manifest fields — extracted from Claude Code
 * 2.1.235, `"If true, hook runs in background without blocking"` — but they are **static
 * manifest fields**. They cannot be conditioned on a runtime config key, so a flag-gated
 * `recallAsync` expressed that way would need two registrations that no-op against each
 * other: two processes per prompt, forever, for everyone including people who never opt in.
 * Carry-forward is runtime-flippable, needs no manifest change, and is testable offline.
 * Do not "simplify" this into a manifest flag.
 *
 * ---------------------------------------------------------------------------
 * The seen-set interaction, which is the easy thing to get wrong
 * ---------------------------------------------------------------------------
 * `markSeen` records "the model has been shown this". Under carry-forward the refresh
 * *produces* the block and the next turn *renders* it, so there are two candidates for who
 * marks, and both wrong answers are silent:
 *
 *   - **The refresh marks** → a block that is never rendered (session ends, flag flipped off,
 *     compaction drops it) leaves entries recorded as seen that the model never received, and
 *     the next full-price block degrades them to pointers naming text that exists nowhere in
 *     the transcript. That is `lib/seen.mjs`'s own worst case.
 *   - **Nobody marks** → every carry-forward is assembled against an empty seen-set and the
 *     whole HS-3 saving reverts, with no test failing.
 *
 * The answer is the synchronous reader, against the current run, *before* it spawns the
 * refresh — so the child's `readSeen` already contains this turn's ids. `refreshMarksNothing`
 * and `theRepeatDegradesOnTheTurnAfter` pin both halves.
 *
 * These tests are written before the implementation. Failing with
 * "lib/carry.mjs does not exist yet" is the expected red state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  assertHookContract, baseEnv, evidence, fakeMubit, lib, makeDataDir, queryResponse,
  readJsonFile, runHook, tempDir, waitFor,
} from './helpers/harness.mjs';
import { postCompact, userPromptSubmit, PROMPT_ID } from './helpers/fixtures.mjs';

const RUN_ID = 'cc-test-async-1';

/** A second prompt id, so "which turn was credited" is a question with two possible answers. */
const PROMPT_ID_B = 'p_01HZXK8Q9N7M6P5R4S3T2U1V0X';
const PROMPT_ID_C = 'p_01HZXK8Q9N7M6P5R4S3T2U1V0Y';

/**
 * How long the fake endpoint takes to answer in the latency test. It has to be comfortably
 * above a hook's own cost and comfortably below `HARNESS_BUDGET_MS` (2800 ms), because the
 * assertion is that a *synchronous* dial cannot possibly return in less than this.
 */
const SLOW_MS = 1800;

function env(dataDir, server, extra = {}) {
  return baseEnv({
    dataDir,
    endpoint: server.url,
    projectDir: dataDir,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: RUN_ID,
      ...extra,
    },
  });
}

/** The flag, as a user would set it. */
const ASYNC_ON = { MUBIT_CC_RECALL_ASYNC: '1' };

const carryPath = (d) => join(d, 'runs', RUN_ID, 'carry.json');
const seenPath = (d) => join(d, 'runs', RUN_ID, 'seen.json');
const turnPath = (d, promptId) => join(d, 'runs', RUN_ID, 'turns', `${promptId}.json`);
const marker = (d) => readJsonFile(join(d, 'status', `${RUN_ID}.json`));

// ---------------------------------------------------------------------------
// The spawn spy — the same `--require` preload `stage-prompt.test.mjs` uses.
// It records, it does not replace: the real `recall-refresh` still runs and still dials.
// ---------------------------------------------------------------------------

const SCRATCH = tempDir('mubit-cc-async-');
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

function withSpy(e) {
  const file = join(SCRATCH, `spy-${randomUUID()}.jsonl`);
  return { file, env: { ...e, NODE_OPTIONS: `--require ${SPY}`, MUBIT_TEST_SPY_FILE: file } };
}

function refreshSpawns(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((l) => basename(String(l.argv?.[0] ?? '')) === 'recall-refresh.mjs');
}

/** Run one async turn and wait for its detached refresh to leave the next turn's block. */
async function turnAndRefresh(e, payload) {
  const r = await runHook('prompt-recall', payload, { env: e });
  assertHookContract(r);
  return r;
}

/** A single-evidence response, so "was this one entry degraded" is unambiguous. */
const ONE = queryResponse({
  evidence: [evidence({
    id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule', score: 0.91,
    content: 'Ingest returns when queued, not when stored; poll the job for completion.',
  })],
});

// ===========================================================================
// lib/carry.mjs — the file itself
// ===========================================================================

/** Fresh data dir + resolved config + a fresh `lib/carry.mjs`. */
async function setup(extra = {}) {
  const C = await lib('carry.mjs');
  const dataDir = makeDataDir();
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(baseEnv({ dataDir, extra }));
  return { cfg, dataDir, C };
}

/** An `Outcome`, as `lib/recall.mjs` hands one back. */
function outcome(over = {}) {
  return {
    failed: false, rung: 1, block: '## Active rules\n- Poll the ingest job.',
    tokens: 42, sources: 1, dropped: 0, pointers: 0, emptyReason: '',
    refIds: ['ref_rule_1'],
    ...over,
  };
}

// The first prompt of a session has nothing carried forward, and that is the ordinary case
// rather than an error: `session-start`'s preamble has already landed, so the turn is not
// silent, it is merely un-recalled.
test('takeCarry: a run with nothing carried forward answers nothing, not an error', async () => {
  const { cfg, C } = await setup();
  assert.equal(C.takeCarry(cfg, RUN_ID), null,
    'a first prompt must not be handed a block from some other run');
});

// The carry file is an `Outcome` on disk. Keeping the shape identical is what lets
// `persistRecalled` and the render path stay one code path across both modes — a second
// shape here is a second place for `pointers` or `refIds` to be dropped.
test('writeCarry then takeCarry round-trips the Outcome the ladder produced', async () => {
  const { cfg, C } = await setup();
  const o = outcome({ pointers: 1, dropped: 2, rung: 2, tokens: 91 });

  assert.equal(C.writeCarry(cfg, RUN_ID, o, { promptId: PROMPT_ID, fetchMs: 1234 }), true);
  const got = C.takeCarry(cfg, RUN_ID);

  assert.equal(got.block, o.block);
  assert.equal(got.rung, 2);
  assert.equal(got.tokens, 91);
  assert.equal(got.dropped, 2);
  assert.equal(got.pointers, 1,
    'a carried block that degraded a repeat must say so, or the render drops the pointer '
    + 'caveat and the model reads a reference id as a truncated memory');
  assert.deepEqual(got.refIds, ['ref_rule_1'],
    'without the ids the receiving turn has nothing to attribute and nothing to mark seen');
  assert.equal(got.failed, false);
  assert.equal(got.forPromptId, PROMPT_ID,
    'provenance: which prompt this block was retrieved against is the one turn of staleness '
    + 'the mode trades for, so it has to be readable');
  assert.equal(got.fetchMs, 1234,
    'what the refresh spent is the number that shows the prompt no longer pays it');
});

// The load-bearing property of the whole file. A refresh that stops answering — the server
// went down, the process was reaped — must not leave the last good block to be re-injected
// on every prompt for the rest of the session. Consumed means gone.
test('takeCarry is consume-once: a second read gets nothing, not the same block again', async () => {
  const { cfg, dataDir, C } = await setup();
  C.writeCarry(cfg, RUN_ID, outcome(), { promptId: PROMPT_ID });

  assert.ok(C.takeCarry(cfg, RUN_ID)?.block, 'the first read gets the block');
  assert.equal(C.takeCarry(cfg, RUN_ID), null,
    'a stale block re-injected every prompt is worse than no block: it costs full price '
    + 'forever and describes a question the user has moved on from');
  assert.equal(existsSync(carryPath(dataDir)), false,
    'consumed means unlinked — a file left behind is a file the next prompt reads');
});

// One turn of staleness is the accepted trade. An hour of it is not: a block retrieved
// against a prompt from before lunch answers a question nobody is asking. The refresh runs
// on every prompt, so a live session never comes near this bound.
test('takeCarry: a block older than CARRY_TTL_MS is dropped rather than injected', async () => {
  const { cfg, dataDir, C } = await setup();
  mkdirSync(join(dataDir, 'runs', RUN_ID), { recursive: true });
  writeFileSync(carryPath(dataDir), JSON.stringify({
    run_id: RUN_ID,
    written_at: Date.now() - (C.CARRY_TTL_MS + 60_000),
    block: '## Active rules\n- Stale.',
    ref_ids: ['ref_old'],
  }));

  assert.equal(C.takeCarry(cfg, RUN_ID), null,
    'an expired block must not be injected as if it were about this conversation');
  assert.equal(existsSync(carryPath(dataDir)), false,
    'an expired block is also swept, or it is re-read and re-rejected on every prompt');
});

// §4.9: nothing on the recall path throws. A truncated file is the ordinary state after a
// SIGKILL mid-write, and it must cost the carried block, never the prompt.
test('takeCarry: a corrupt carry file degrades to nothing carried rather than throwing', async () => {
  const { cfg, dataDir, C } = await setup();
  mkdirSync(join(dataDir, 'runs', RUN_ID), { recursive: true });
  writeFileSync(carryPath(dataDir), '{"block": "## Active rul');

  assert.equal(C.takeCarry(cfg, RUN_ID), null);
});

// §5.6, the compaction reset. `clearSeen` exists because after a compaction the transcript
// the entries were injected into is gone, so a surviving pointer names a memory that exists
// nowhere. A carried block assembled *before* the compaction has those pointers baked into
// it already, so it has to go with the seen-set.
test('clearCarry removes the carried block — the compaction reset applies to it too', async () => {
  const { cfg, dataDir, C } = await setup();
  C.writeCarry(cfg, RUN_ID, outcome({ pointers: 1 }), { promptId: PROMPT_ID });

  assert.equal(C.clearCarry(cfg, RUN_ID), true);
  assert.equal(existsSync(carryPath(dataDir)), false);
  assert.equal(C.clearCarry(cfg, RUN_ID), true,
    'clearing a run with nothing carried is success — the question is "is the slate clean"');
});

// A carry file names a run, and a run id can be pinned by hand in a settings file or an
// environment variable. Same rule as every other per-run file: untrusted input to a path.
// `safeSegment` neutralises traversal rather than rejecting it, so the assertion is that the
// file lands *inside* `runs/`; a run id that leaves no segment at all is refused outright,
// because an empty one resolves to `runs/` itself, which is shared and not this run's.
test('carry paths are per-run: traversal is neutralised, an empty run id is refused', async () => {
  const { cfg, dataDir, C } = await setup();

  assert.equal(C.writeCarry(cfg, '../../etc', outcome(), { promptId: PROMPT_ID }), true);
  const under = readdirSync(join(dataDir, 'runs'));
  assert.equal(under.length, 1, `expected one run dir, got ${JSON.stringify(under)}`);
  assert.ok(!/[/\\]/.test(under[0]) && under[0] !== '..' && under[0] !== '.',
    `a pinned run id must not be able to write outside runs/; it landed at ${under[0]}`);

  assert.equal(C.writeCarry(cfg, '   ', outcome(), { promptId: PROMPT_ID }), false,
    'an empty segment resolves to runs/ itself, which every other run reads');
  assert.equal(C.takeCarry(cfg, '   '), null);
});

// ===========================================================================
// Default off — the flag unset must change nothing at all
// ===========================================================================

/*
 * The 929 assertions this suite already carries are the real proof, and they run unchanged.
 * This is the structural half of it, stated once so a reader does not have to infer it: with
 * the flag unset the hook dials on the turn, injects on the turn, leaves no carry file behind
 * and starts no second process.
 */
test('default: recallAsync is off, so the hook dials and injects on the same turn', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': { json: ONE } });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const { file, env: e } = withSpy(env(dataDir, server));

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: e });

  assertHookContract(r);
  server.assertCalled('POST', '/v2/control/query', 1);
  assert.ok(r.json.hookSpecificOutput.additionalContext.includes('poll the job'),
    'the blocking path must still inject on the turn that asked');
  assert.equal(existsSync(carryPath(dataDir)), false,
    'an opt-out install must not start paying for a file it never reads');
  assert.equal(refreshSpawns(file).length, 0,
    'a second process per prompt for someone who never opted in is exactly what the manifest '
    + '`async` field would have cost, and the whole reason this is a runtime flag instead');
});

// ===========================================================================
// The refresh process, on its own
// ===========================================================================

/*
 * `recall-refresh` is spawned detached and nothing waits on it, so it is easiest to pin
 * directly: hand it the same `UserPromptSubmit` payload on stdin and read what it left.
 */

// It produces the block and nothing else. Everything that describes *what the model saw* is
// written by the turn that renders it, because this process does not know whether any turn
// ever will.
test('recall-refresh writes the carried block, and writes neither the turn nor the seen-set', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': { json: ONE } });
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('recall-refresh', userPromptSubmit(), {
    env: env(dataDir, server, ASYNC_ON),
  });

  assertHookContract(r);
  server.assertCalled('POST', '/v2/control/query', 1);

  const carry = readJsonFile(carryPath(dataDir));
  assert.ok(String(carry.block).includes('poll the job'), 'the refresh exists to produce a block');
  assert.deepEqual(carry.ref_ids, ['ref_rule_1']);

  // §5.2 — the refresh runs the same ladder, so it must send the same fusion weights. The
  // fixture prompt is a diagnosis, so `auto` resolves it to `relevance` here too: a hook
  // that dials on a user's behalf and quietly ranks it differently from the one the user
  // waits on is two recall behaviours wearing one name.
  assert.equal(server.lastCall('POST', '/v2/control/query').body.rank_by, 'relevance');

  assert.equal(existsSync(seenPath(dataDir)), false,
    'marking here would record a memory as shown before any turn has shown it — the next '
    + 'full-price block would then degrade it to a pointer naming text the model never got');
  assert.equal(existsSync(turnPath(dataDir, PROMPT_ID)), false,
    'attributing here would credit the requesting turn for a block the receiving turn gets, '
    + 'which is precisely the mis-attribution carry-forward exists to avoid');
});

// The point of moving the call off the prompt: it is no longer paced by `recallBudgetMs`.
// A 1.4-2.3 s endpoint against a 1500 ms budget is the runbook's documented complaint, and
// here the same endpoint answers inside the refresh's own, far larger, budget.
test('recall-refresh is not bounded by recallBudgetMs — a slow endpoint still lands', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { json: ONE, delayMs: 700 },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('recall-refresh', userPromptSubmit(), {
    env: env(dataDir, server, { ...ASYNC_ON, MUBIT_CC_RECALL_BUDGET_MS: '150' }),
  });

  assertHookContract(r);
  const carry = readJsonFile(carryPath(dataDir));
  assert.ok(String(carry.block).includes('poll the job'),
    'a 150 ms prompt budget must not reach into a process no prompt is waiting on — that is '
    + 'the entire trade, and getting it wrong reproduces the empty recall it was meant to fix');
  assert.ok(carry.fetch_ms >= 700,
    `the refresh must record what it actually spent; got ${carry.fetch_ms}ms`);
});

// The rule reads the prompt this process was spawned with, which is the same text the
// synchronous half would have queried on. Carry-forward moves *when* the call happens, never
// *what* it asks for — a handoff question ranked by similarity in the background is the same
// bug, just one turn later and harder to see.
test('recall-refresh ranks a handoff prompt by freshness, exactly as the blocking path would', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': { json: ONE } });
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('recall-refresh', userPromptSubmit({ prompt: 'catch me up on where we left off' }), {
    env: env(dataDir, server, ASYNC_ON),
  });

  assertHookContract(r);
  const body = server.lastCall('POST', '/v2/control/query').body;
  assert.equal(body.rank_by, 'freshness',
    'the detached half must not fall back to default fusion weights');
  assert.equal(body.query, 'catch me up on where we left off');
});

// A failed refresh writes no block. The alternative — an empty carry file — would be read by
// the next turn as "nothing to inject" either way, but it would also silently overwrite a
// good block that was still in date.
test('recall-refresh leaves no carried block when the ladder fails', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { status: 500, json: { error: 'boom' } },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();

  assertHookContract(await runHook('recall-refresh', userPromptSubmit(), {
    env: env(dataDir, server, ASYNC_ON),
  }));

  assert.equal(existsSync(carryPath(dataDir)), false,
    'a failure must not be carried forward as an empty block');
  assert.equal(marker(dataDir).state, 'server_error',
    'the refresh is the process that dialled, so it owns the connection state — without this '
    + 'write the status line can never show a failure again once the flag is on');
});

// ===========================================================================
// The synchronous path with the flag on
// ===========================================================================

// Turn one has nothing to render, dials nothing itself, and starts the refresh that turn two
// will read. `session-start`'s preamble has already landed, so the session is not silent.
test('recallAsync: the first prompt injects nothing, dials nothing, and primes the next turn', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': { json: ONE } });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const { file, env: e } = withSpy(env(dataDir, server, ASYNC_ON));

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: e });

  assertHookContract(r);
  assert.deepEqual(r.json, { suppressOutput: true },
    'nothing carried means nothing injected — "I found nothing" teaches the model to '
    + 'distrust the channel (§5.2)');

  const spawns = await waitFor(() => {
    const s = refreshSpawns(file);
    return s.length ? s : null;
  });
  assert.equal(spawns.length, 1, 'exactly one refresh per prompt');
  assert.equal(spawns[0].detached, '1',
    'an attached child would put the round trip back on the prompt by another route');

  await waitFor(() => existsSync(carryPath(dataDir)));
  const carry = readJsonFile(carryPath(dataDir));
  assert.ok(String(carry.block).includes('poll the job'));

  const m = marker(dataDir);
  assert.equal(m.recall.empty_reason, 'async_no_carry',
    'a blank empty_reason under this flag is indistinguishable from a recall path that has '
    + 'quietly died; naming it is what makes the doctor skill able to say anything');
  assert.equal(m.recall.dry_streak, 1,
    'the streak, not the reason, is what separates an ordinary first prompt from a refresh '
    + 'that has been failing for ten of them');
});

// THE test in this file. The block turn A asked for is rendered on turn B, and it is turn B
// that is credited with it — because the write happens on the synchronous read, with turn B's
// prompt id in hand. Get this wrong and `Stop` reinforces a memory against a turn that never
// saw it, which is worse than no attribution at all.
test('recallAsync: the carried block is credited to the turn that RECEIVED it', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': { json: ONE } });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const e = env(dataDir, server, ASYNC_ON);

  // Turn A: primes. Nothing injected, nothing to attribute.
  await turnAndRefresh(e, userPromptSubmit({ prompt_id: PROMPT_ID }));
  await waitFor(() => existsSync(carryPath(dataDir)));

  // Turn B: receives.
  const b = await runHook('prompt-recall', userPromptSubmit({
    prompt_id: PROMPT_ID_B, prompt: 'and what does the drain do when it is 5xx?',
  }), { env: e });
  assertHookContract(b);

  assert.ok(b.json.hookSpecificOutput.additionalContext.includes('poll the job'),
    'turn B must actually receive the block turn A paid for');

  const turnB = readJsonFile(turnPath(dataDir, PROMPT_ID_B));
  assert.deepEqual(turnB.recalled, ['ref_rule_1'],
    'the ids belong to the turn that was given them; `Stop` attributes against this file');

  assert.equal(existsSync(turnPath(dataDir, PROMPT_ID)), false,
    'turn A staged no ids: it was never given any. A `recalled` entry there would credit a '
    + 'memory to a turn that could not possibly have used it');
});

// The other half of the seen-set decision. The reader marks, before it spawns, so the child's
// `readSeen` already carries this turn's ids — and turn C's block degrades the repeat to a
// pointer exactly as the blocking path does. Mark *after* the spawn and this silently reverts
// to full price on every prompt with nothing failing.
test('recallAsync: the receiving turn marks seen, so the NEXT block degrades the repeat', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': { json: ONE } });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const e = env(dataDir, server, ASYNC_ON);

  await turnAndRefresh(e, userPromptSubmit({ prompt_id: PROMPT_ID }));
  await waitFor(() => existsSync(carryPath(dataDir)));
  assert.equal(existsSync(seenPath(dataDir)), false,
    'nothing has been shown to the model yet, so nothing may be recorded as shown');

  const b = await runHook('prompt-recall', userPromptSubmit({
    prompt_id: PROMPT_ID_B, prompt: 'and what does the drain do when it is 5xx?',
  }), { env: e });
  assertHookContract(b);
  assert.ok(b.json.hookSpecificOutput.additionalContext.includes('poll the job'),
    'the full entry is rendered once');

  const seen = readJsonFile(seenPath(dataDir));
  assert.ok(seen.refs.ref_rule_1,
    'the turn that rendered it is the turn that records it as shown');

  // Turn B's refresh ran after that mark, so turn C gets the degraded rendering.
  await waitFor(() => existsSync(carryPath(dataDir)));
  const c = await runHook('prompt-recall', userPromptSubmit({
    prompt_id: PROMPT_ID_C, prompt: 'so what should the retry interval be?',
  }), { env: e });
  assertHookContract(c);

  const block = c.json.hookSpecificOutput.additionalContext;
  assert.ok(!block.includes('poll the job'),
    'the refresh reads the seen-set the reader has already written, so a repeat is degraded. '
    + 'Marking after the spawn instead reverts the whole HS-3 saving with no test failing');
  assert.ok(block.includes('ref_rule_1'),
    'a degraded repeat keeps its reference id — dropping it would break attribution for '
    + 'exactly the memories that keep proving relevant');
});

// The claim the guide is allowed to make. A synchronous dial cannot return before the server
// has answered; the carry-forward read never dials, so its wall clock is the cost of reading
// one file. That is what stops `MUBIT_CC_RECALL_BUDGET_MS` being a tuning parameter anyone
// has to discover.
test('recallAsync: the hook\'s wall clock stops tracking the endpoint', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { json: ONE, delayMs: SLOW_MS },
  });
  t.after(() => server.close());

  // Budget well above the endpoint's latency, so it is the endpoint and not the budget that
  // decides how long the blocking arm takes.
  const BIG_BUDGET = { MUBIT_CC_RECALL_BUDGET_MS: '9000' };

  const asyncDir = makeDataDir();
  const fast = await runHook('prompt-recall', userPromptSubmit(), {
    env: env(asyncDir, server, { ...ASYNC_ON, ...BIG_BUDGET }),
  });
  assertHookContract(fast);

  const blockingDir = makeDataDir();
  const slow = await runHook('prompt-recall', userPromptSubmit(), {
    env: env(blockingDir, server, BIG_BUDGET),
  });
  assertHookContract(slow);

  assert.ok(slow.ms >= SLOW_MS,
    `the blocking arm must actually wait for the endpoint; it returned in ${slow.ms}ms `
    + `against a ${SLOW_MS}ms server`);
  assert.ok(fast.ms < SLOW_MS,
    `the async arm returned in ${fast.ms}ms against an endpoint that takes ${SLOW_MS}ms to `
    + 'answer. A hook that dialled synchronously could not have: this is the measurement '
    + 'that retires the "raise MUBIT_CC_RECALL_BUDGET_MS by hand" workaround');

  // Let the detached refresh finish before the server closes under it.
  await waitFor(() => existsSync(carryPath(asyncDir)), 8000);
});

// §5.6 again, this time through the hook that owns the reset. A block assembled before a
// compaction carries pointers into a transcript that no longer exists.
test('recallAsync: PostCompact drops the carried block along with the seen-set', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': { json: ONE } });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const e = env(dataDir, server, ASYNC_ON);

  await turnAndRefresh(e, userPromptSubmit({ prompt_id: PROMPT_ID }));
  await waitFor(() => existsSync(carryPath(dataDir)));

  assertHookContract(await runHook('checkpoint', postCompact(), { env: e, args: ['--post'] }));

  assert.equal(existsSync(carryPath(dataDir)), false,
    'a block assembled against the pre-compaction window may carry a pointer to a memory the '
    + 'model can no longer read — the one failure worse than paying full price');
});

// The block says, once, that it was retrieved against the previous message. Without it the
// model reads a block about the last question as a block about this one — the one turn of
// staleness is the mode's whole cost, and it is cheaper to state it than to hide it.
test('recallAsync: the injected wrapper says the block is one turn old', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': { json: ONE } });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const e = env(dataDir, server, ASYNC_ON);

  await turnAndRefresh(e, userPromptSubmit({ prompt_id: PROMPT_ID }));
  await waitFor(() => existsSync(carryPath(dataDir)));

  const b = await runHook('prompt-recall', userPromptSubmit({
    prompt_id: PROMPT_ID_B, prompt: 'and what does the drain do when it is 5xx?',
  }), { env: e });
  assertHookContract(b);

  const block = b.json.hookSpecificOutput.additionalContext;
  assert.match(block, /previous message/i,
    'the model has to be able to tell a block about the last question from one about this '
    + 'question; the blocking path never had to say it, so nothing else does');
});

// §4.7/F7 — the breaker still governs whether a process is spawned to dial a server already
// known to be down. It must NOT stop a block that is already on disk from being rendered:
// that block cost a round trip nobody has to repeat.
test('recallAsync: a tripped breaker renders the carried block but starts no refresh', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': { json: ONE } });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const e = env(dataDir, server, ASYNC_ON);

  await turnAndRefresh(e, userPromptSubmit({ prompt_id: PROMPT_ID }));
  await waitFor(() => existsSync(carryPath(dataDir)));

  // Trip it through the module that owns it, rather than by writing its file by hand: the
  // state is keyed by endpoint hash and a hand-written copy drifts silently.
  const { loadConfig } = await lib('config.mjs');
  const { recordFailure, readBreaker } = await lib('breaker.mjs');
  const cfg = loadConfig({ ...e, MUBIT_CC_BREAKER_THRESHOLD: '2' });
  recordFailure(cfg, 'server_error');
  recordFailure(cfg, 'server_error');
  assert.ok(readBreaker(cfg).openedAt > 0, 'the breaker has to actually be open for this test');

  const { file, env: spied } = withSpy(e);
  const b = await runHook('prompt-recall', userPromptSubmit({
    prompt_id: PROMPT_ID_B, prompt: 'and what does the drain do when it is 5xx?',
  }), { env: spied });
  assertHookContract(b);

  assert.ok(b.json.hookSpecificOutput?.additionalContext?.includes('poll the job'),
    'the block was already paid for; refusing to render it spends the round trip twice');
  assert.equal(refreshSpawns(file).length, 0,
    'spawning a process per prompt to dial a server the breaker has already given up on is '
    + 'the cost F7 exists to avoid');
});
