// @ts-check
/**
 * `hooks/src/session-end.mjs` — SessionEnd.
 *
 * Guide sections under test:
 *   §5.7  the ordered flow, the reflect body, the once-marker, best-effort failure
 *   §1.4  background extraction produces lessons but NEVER widens their scope
 *   §4.6  `claimOnce` — the once-marker, and "proceed on marker failure"
 *   §7    `runs/<run_id>/flushed-<session_id>.marker`, spool keyed by run_id
 *   §12.4 session-end drains, reflects by default, then heartbeats idle
 *
 * The fact this whole file exists to protect (§1.4): Mubit extracts lessons on its own as
 * it ingests, but those keep the scope they were extracted at — and a `run`-scoped lesson
 * is invisible to the next session. Widening scope is reserved for the explicit reflect
 * path, so `POST /v2/control/reflect` at SessionEnd is the ONLY call that can widen a
 * lesson's scope past `run`. Deleting it must fail these tests loudly, not quietly cost
 * cross-session memory.
 *
 * Budget 8000 ms internal / 12 s hook timeout. Runs INLINE, not detached — the process
 * is going away and a detached child may be reaped before it finishes.
 *
 * Tests pin the run id with the `static` strategy (§6.1) so `runs/<run_id>/` can be
 * seeded before the hook runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  runHook, assertHookContract, fakeMubit, makeDataDir, makeProjectDir,
  baseEnv, readJsonFile, spoolFiles,
} from './helpers/harness.mjs';
import * as fx from './helpers/fixtures.mjs';

const PROJECT_DIR = makeProjectDir({ git: true });
const RUN_ID = 'cc-session-end-test';

function env(dataDir, endpoint, extra = {}) {
  return baseEnv({
    dataDir,
    endpoint,
    projectDir: PROJECT_DIR,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: RUN_ID,
      // Every assertion in this file is about the BODY — what it sends, in what order, and
      // what it writes. Since MUB-10 that body runs in a detached child by default, so this
      // switch keeps it here where the assertions can see it. The hand-off itself, and the
      // fact the body survives the hook being killed, are `session-end-detach.test.mjs`.
      MUBIT_CC_SESSION_END_DETACH: '0',
      ...extra,
    },
  });
}

const runDir = (dataDir) => join(dataDir, 'runs', RUN_ID);

/** One file per pending ingest item — `runs/<run_id>/spool/<ts>-<rand6>.json` (§4.6). */
function seedSpool(dataDir, n, tag = 'seed') {
  const dir = join(runDir(dataDir), 'spool');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    writeFileSync(
      join(dir, `176500000${String(i).padStart(4, '0')}-a${tag.slice(0, 2)}${i}0.json`),
      JSON.stringify(fx.spoolItem({ item_id: `cc-${tag}-${i}`, text: `${tag} item ${i}` })),
    );
  }
}

/** A staged turn awaiting attribution — written by `stage-prompt` (§5.3) + `capture --stop` (§5.4). */
function seedPendingTurn(dataDir, promptId, recalled) {
  const dir = join(runDir(dataDir), 'turns');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${promptId}.json`), JSON.stringify({
    prompt_id: promptId,
    session_id: fx.SESSION_ID,
    prompt: 'why is the ingest job stuck in queued?',
    started_at: Date.now() - 30_000,
    ended_at: Date.now() - 1_000,
    recalled,
    outcome_pending: true,
  }));
}

function readMarker(dataDir) {
  const p = join(dataDir, 'status', `${RUN_ID}.json`);
  assert.ok(existsSync(p), `expected a status marker at status/${RUN_ID}.json (§4.8)`);
  return readJsonFile(p);
}

const idx = (server, method, path) =>
  server.requests.findIndex((r) => r.method === method && r.path === path);

const seq = (server) => server.requests.map((r) => `${r.method} ${r.path}`).join(', ');

// ---------------------------------------------------------------------------
// The ordered flow
// ---------------------------------------------------------------------------

// §5.7 steps 2-6: drain, reflect, heartbeat idle, marker — in that order.
test('drains the spool, then reflects, then heartbeats idle', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 3);

  const r = await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });

  assertHookContract(r);
  assert.deepEqual(r.json, { suppressOutput: true });

  server.assertCalled('POST', '/v2/control/ingest', 1);
  server.assertCalled('POST', '/v2/control/reflect', 1);
  server.assertCalled('POST', '/v2/control/agents/heartbeat', 1);

  const iIngest = idx(server, 'POST', '/v2/control/ingest');
  const iReflect = idx(server, 'POST', '/v2/control/reflect');
  const iBeat = idx(server, 'POST', '/v2/control/agents/heartbeat');
  assert.ok(iIngest < iReflect, `ingest must precede reflect; saw: ${seq(server)}`);
  assert.ok(iReflect < iBeat, `reflect must precede the idle heartbeat; saw: ${seq(server)}`);

  // The drain ignores the batch-size trigger here: three items is well under
  // batchMaxItems (32) and they still go out (§5.7 step 2).
  const items = server.lastCall('POST', '/v2/control/ingest').body.items;
  assert.equal(items.length, 3);
  assert.equal(server.lastCall('POST', '/v2/control/ingest').body.run_id, RUN_ID);
  for (const it of items) {
    // §1.5 — a missing intent costs one LLM round trip per item, server-side.
    assert.ok(it.intent && it.intent !== 'unclassified', `item ${it.item_id} lost its intent`);
    assert.ok(it.item_id && it.content_type, 'item_id and content_type are required (§1.3)');
  }

  assert.equal(server.lastCall('POST', '/v2/control/agents/heartbeat').body.status, 'idle');
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 0, 'a committed batch is unlinked (§4.6)');
});

// §5.7 step 4 + §1.4 — THE test. Reflect is on by default because it is the only path
// that widens a lesson's scope past `run`; auto-reflection's lessons are skipped by the
// promotion loop by design. A default of "off" would silently cost cross-session memory.
test('issues POST /v2/control/reflect BY DEFAULT with no opt-in env', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 2);

  const r = await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });

  assertHookContract(r);
  server.assertCalled('POST', '/v2/control/reflect', 1);

  // §5.7 — the body, verbatim. `last_n_items` bounds reflection to the recent tail
  // instead of replaying the whole run (control.proto), which keeps the
  // LLM-backed call inside its 4000 ms budget on a long session.
  // `include_step_outcomes` folds outcome signals in (control.proto) — the
  // NEGATIVE ones produce the highest-value lessons.
  const body = server.lastCall('POST', '/v2/control/reflect').body;
  assert.equal(body.run_id, RUN_ID);
  assert.notEqual(body.run_id, 'default');
  assert.equal(body.include_linked_runs, false);
  assert.equal(body.include_step_outcomes, true);
  assert.equal(body.last_n_items, 200);
});

// §5.7 — "Runs INLINE, not detached." The ingest is deliberately slow: a detached
// drain would let the hook exit first and this count would still be 0. There is no
// `waitFor` here on purpose — that is the assertion.
test('drains inline, not detached — the ingest lands before the process exits', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/ingest': {
      delayMs: 150,
      json: { accepted: true, job_id: 'job_test_1', deduplicated: false, status: 'queued' },
    },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 4);

  const r = await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });

  assertHookContract(r);
  assert.equal(server.countOf('POST', '/v2/control/ingest'), 1,
    'the drain must complete inline; a detached child may be reaped when the session ends');
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 0);
});

// §5.7 step 3 — a turn left `outcome_pending` by `capture --stop` is attributed before
// reflect, so the reflection sees the outcome signals (§5.5: reference_id "global" is the
// run-level sentinel; the real attribution lives in entry_ids[]).
test('flushes a turn left outcome_pending, before reflecting', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 1);
  seedPendingTurn(dataDir, fx.PROMPT_ID, ['ref_lesson_1', 'ref_rule_1']);

  const r = await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });

  assertHookContract(r);
  server.assertCalled('POST', '/v2/control/outcome', 1);

  const body = server.lastCall('POST', '/v2/control/outcome').body;
  assert.equal(body.run_id, RUN_ID);
  assert.equal(body.reference_id, 'global', 'reference_id must be non-empty (§1.3)');
  assert.deepEqual(body.entry_ids, ['ref_lesson_1', 'ref_rule_1']);

  assert.ok(idx(server, 'POST', '/v2/control/outcome') < idx(server, 'POST', '/v2/control/reflect'),
    `outcomes must land before reflect; saw: ${seq(server)}`);

  const turnPath = join(runDir(dataDir), 'turns', `${fx.PROMPT_ID}.json`);
  if (existsSync(turnPath)) {
    assert.ok(!readJsonFile(turnPath).outcome_pending, 'the pending flag must be cleared once flushed');
  }
});

// ---------------------------------------------------------------------------
// §5.7 step 3, conditioned on evidence — one rule, shared with `drain` (§5.5 step 7)
// ---------------------------------------------------------------------------

/**
 * `session-end` fires only for turns the drain never reached, so for a while the two hooks
 * were free to disagree without either one looking wrong: `drain` learned the four-case rule
 * and this hook kept posting `success`/+0.2 with `entry_ids` for every pending turn. The
 * series that came out mixed two definitions of the same measurement, with nothing on the
 * wire to say which record came from which — worse than either rule applied consistently.
 *
 * `lib/outcome.mjs` owns the rule now. These tests pin this hook's half of it; the parity
 * test below pins that the halves are the same.
 */

/** A pending turn as `capture --stop` leaves it once it could compute the used-signal. */
function seedMeasuredTurn(dataDir, promptId, used, over = {}) {
  const dir = join(runDir(dataDir), 'turns');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${promptId}.json`), JSON.stringify({
    prompt_id: promptId,
    session_id: fx.SESSION_ID,
    prompt: 'why is the ingest job stuck in queued?',
    started_at: Date.now() - 30_000,
    ended_at: Date.now() - 1_000,
    recalled: ['ref_lesson_1', 'ref_rule_1'],
    outcome_pending: true,
    ...(used === null ? {} : {
      used_evidence: {
        method: 'memory-term-echo/v1',
        at: Date.now(),
        candidates: 12,
        matched: used ? 3 : 0,
        terms: used ? ['indexing', 'queued', 'poll'] : [],
        answer_chars: 180,
        used,
      },
    }),
    ...over,
  }));
}

// §5.5 step 7: injected and the reply carried none of the memory's vocabulary. Recorded at
// exactly 0.0 with an EMPTY entry_ids[] — attributed reinforcement counts any signal >= 0 as
// one reinforcement, so naming the entries here would credit precisely the memories nothing
// showed were read.
test('an ignored injection flushes as neutral 0.0 with no entry_ids', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 1);
  seedMeasuredTurn(dataDir, fx.PROMPT_ID, false);

  assertHookContract(await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) }));

  server.assertCalled('POST', '/v2/control/outcome', 1);
  const body = server.lastCall('POST', '/v2/control/outcome').body;
  assert.equal(body.outcome, 'neutral',
    'the four accepted outcomes are success/failure/partial/neutral; anything else is a 400');
  assert.equal(body.signal, 0,
    'no evidence of use is not evidence of harm — a penalty here would punish memory for a '
    + 'signal that is mostly false negatives');
  assert.deepEqual(body.entry_ids, [],
    'a neutral record must not name the entries it could not credit');
  assert.equal(body.reference_id, 'global', 'reference_id must still be non-empty (§1.3)');
  assert.ok(body.rationale.includes('memory-term-echo/v1'),
    `the rationale must name the method that decided this: ${body.rationale}`);
});

// The same asymmetry `drain` keeps: a failed turn is not proof the memory was wrong when
// nothing shows the memory was used at all. -0.3 against an entry the model never touched is
// the same mistake as +0.2, pointed the other way.
test('a failed turn with no evidence of use is not punished for it', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 1);
  seedMeasuredTurn(dataDir, fx.PROMPT_ID, false, { outcome: 'failure' });

  assertHookContract(await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) }));

  const body = server.lastCall('POST', '/v2/control/outcome').body;
  assert.equal(body.outcome, 'neutral');
  assert.equal(body.signal, 0);
  assert.deepEqual(body.entry_ids, []);
});

// A turn staged before the used-signal existed was never measured. Reading that as "the
// model ignored it" would invent a denominator, so it keeps the old behaviour — which is
// also every turn this hook has ever flushed until now.
test('a turn with no used_evidence keeps the +0.2 and the attribution', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 1);
  seedMeasuredTurn(dataDir, fx.PROMPT_ID, null);

  assertHookContract(await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) }));

  const body = server.lastCall('POST', '/v2/control/outcome').body;
  assert.equal(body.outcome, 'success');
  assert.equal(body.signal, 0.2);
  assert.deepEqual(body.entry_ids, ['ref_lesson_1', 'ref_rule_1']);
});

// §5.5/§6.1: the neutral record is implicit attribution as much as the +0.2 is. "off" means
// the hook posts nothing, "explicit" means the model owns the call — and a user who turned
// this off did not ask to be measured either.
for (const mode of ['off', 'explicit']) {
  test(`outcomeMode "${mode}" silences the flush, neutral records included`, async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const dataDir = makeDataDir();
    seedSpool(dataDir, 1);
    seedMeasuredTurn(dataDir, fx.PROMPT_ID, false);

    assertHookContract(await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
      { env: env(dataDir, server.url, { MUBIT_CC_OUTCOME_MODE: mode }) }));

    server.assertCalled('POST', '/v2/control/ingest', 1);
    server.assertNotCalled('POST', '/v2/control/outcome');
  });
}

/**
 * THE test for this divergence: the same turn file, through both hooks, must reach the wire
 * as the same record — down to the idempotency key, which is what makes a concurrent drain
 * and a session-end flush a no-op instead of double reinforcement.
 *
 * Both hooks are given the same run id, the same prompt id and a payload carrying the same
 * session id, so every field of the request is a function of the turn file alone. Anything
 * that differs is a second definition of the measurement.
 */
for (const row of [
  { name: 'measured used', used: true, over: {} },
  { name: 'measured unused', used: false, over: {} },
  { name: 'measured used, turn failed', used: true, over: { outcome: 'failure' } },
  { name: 'measured unused, turn failed', used: false, over: { outcome: 'failure' } },
  { name: 'unmeasured', used: null, over: {} },
  { name: 'unmeasured, turn failed', used: null, over: { outcome: 'failure' } },
]) {
  test(`drain and session-end post an identical outcome — ${row.name}`, async (t) => {
    const drainServer = await fakeMubit();
    const endServer = await fakeMubit();
    t.after(() => drainServer.close());
    t.after(() => endServer.close());

    const drainDir = makeDataDir();
    const endDir = makeDataDir();
    seedMeasuredTurn(drainDir, fx.PROMPT_ID, row.used, row.over);
    seedMeasuredTurn(endDir, fx.PROMPT_ID, row.used, row.over);

    assertHookContract(await runHook('drain', fx.stop({ cwd: PROJECT_DIR }), {
      env: env(drainDir, drainServer.url),
      args: ['--with-outcome', fx.PROMPT_ID],
    }));
    assertHookContract(await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
      { env: env(endDir, endServer.url) }));

    drainServer.assertCalled('POST', '/v2/control/outcome', 1);
    endServer.assertCalled('POST', '/v2/control/outcome', 1);

    const fromDrain = drainServer.lastCall('POST', '/v2/control/outcome').body;
    const fromEnd = endServer.lastCall('POST', '/v2/control/outcome').body;
    assert.deepEqual(fromEnd, fromDrain,
      'the two hooks implement one rule; a difference here is a run whose outcome series '
      + `silently mixes two definitions.\n  drain:       ${JSON.stringify(fromDrain)}\n`
      + `  session-end: ${JSON.stringify(fromEnd)}`);
    assert.equal(fromEnd.idempotency_key, `cc-outcome-${RUN_ID}-${fx.PROMPT_ID}`,
      'the key is derived from (run_id, prompt_id), never random — it is what makes a '
      + 'concurrent drain and this flush a no-op rather than a double count');
  });
}

/**
 * THE test for this ticket, on the flush side — and the one that has to exist because of
 * *how* `StopFailure` fires.
 *
 * The host's registry (Claude Code 2.1.235): `StopFailure` "fires **instead of** Stop when an
 * API error … ended the turn". So `capture --stop` never runs on a rate-limited turn, and
 * `capture --stop-failure` is what closes it — `outcome_pending: true`, exactly like any
 * other closed turn, because hiding the turn from the sweep is not the same as deciding
 * about it. This flush therefore genuinely picks the turn up, reads it, and posts nothing;
 * `lib/outcome.mjs` is the only thing standing between it and a `-0.3`.
 *
 * That is also why this is a *pair* of tests with `drain.test.mjs` rather than one: the two
 * hooks are separate esbuild entry points that cannot import one another, and the last time
 * a rule like this lived in both files the copies drifted for a release without either one
 * looking wrong on its own.
 */
test('a turn the API killed is swept, and flushed as nothing at all', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 1);
  seedPendingTurn(dataDir, fx.PROMPT_ID, ['ref_lesson_1', 'ref_rule_1']);
  // `capture --stop-failure`'s mark, on a turn that is otherwise the +0.2 row: recalled ids,
  // pending, and no used-signal because the reply was cut off.
  const turnPath = join(runDir(dataDir), 'turns', `${fx.PROMPT_ID}.json`);
  writeFileSync(turnPath, JSON.stringify({ ...readJsonFile(turnPath), api_error: 'rate_limit' }));

  assertHookContract(await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) }));

  // The session still ingests and still reflects: the model's API fell over, not Mubit's.
  server.assertCalled('POST', '/v2/control/ingest', 1);
  server.assertNotCalled('POST', '/v2/control/outcome');

  const after = readJsonFile(turnPath);
  assert.equal(after.api_error, 'rate_limit', 'the mark is the flush\'s input, not its scratch space');
  assert.ok(!(Number(after.outcome_attempts) > 0),
    `a suppressed turn must not spend an attempt: ${JSON.stringify(after.outcome_attempts)}`);
  assert.ok(!after.outcome_sent_at, 'nothing was sent, so nothing may claim it was');
});

// The other half of the distinction, in this hook too: nothing injected is still silence, so
// "no post" means one thing only.
test('a turn that recalled nothing is not flushed at all', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 1);
  seedPendingTurn(dataDir, fx.PROMPT_ID, []);

  assertHookContract(await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) }));

  server.assertCalled('POST', '/v2/control/ingest', 1);
  server.assertNotCalled('POST', '/v2/control/outcome');
});

// ---------------------------------------------------------------------------
// The two — and only two — reflect skip conditions (§5.7 step 4)
// ---------------------------------------------------------------------------

// §5.7 / §6.1 — `MUBIT_CC_REFLECT_ON_END=0` is an explicit opt-out that costs
// cross-session durability. Everything else about SessionEnd still runs.
test('skips reflect when MUBIT_CC_REFLECT_ON_END=0, but still drains and heartbeats', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 2);

  const r = await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url, { MUBIT_CC_REFLECT_ON_END: '0' }) });

  assertHookContract(r);
  server.assertNotCalled('POST', '/v2/control/reflect');
  server.assertCalled('POST', '/v2/control/ingest', 1);
  server.assertCalled('POST', '/v2/control/agents/heartbeat', 1);
});

// §5.7 — nothing ingested this session means there is nothing to reflect ON; an
// LLM-backed call over an empty tail is pure cost.
/**
 * Reflection reads the server's tail of the run, so it is only meaningful over a run the
 * server actually has. A non-empty spool means two opposite things: another drainer is about
 * to land the work — which is why it counts as evidence in flight — or *our* drain stopped
 * (budget spent, breaker open, ingest failed) and nobody is going to. In the second case
 * reflecting draws conclusions from half a session and stores them as if they were the whole
 * one; the next session drains the rest and can reflect over the real thing.
 */
test('skips reflect when this drain left the spool undelivered', async (t) => {
  const dataDir = makeDataDir();
  const server = await fakeMubit({
    'POST /v2/control/ingest': { status: 500, json: { error: 'nope' } },
  });
  t.after(() => server.close());
  seedSpool(dataDir, 3);

  const r = await runHook('session-end', fx.sessionEnd(),
    { env: env(dataDir, server.url, { MUBIT_CC_BREAKER_THRESHOLD: '99' }) });
  assertHookContract(r);

  server.assertNotCalled('POST', '/v2/control/reflect');
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 3, 'precondition: the items are still here');
  assert.equal(readMarker(dataDir).reflect.status, 'skipped:undrained',
    'the marker has to say which skip this was');
});

test('skips reflect when nothing was ingested this session', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir(); // empty spool, no pending turns

  const r = await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });

  assertHookContract(r);
  server.assertNotCalled('POST', '/v2/control/ingest');
  server.assertNotCalled('POST', '/v2/control/reflect');
  server.assertCalled('POST', '/v2/control/agents/heartbeat', 1);
});

// ---------------------------------------------------------------------------
// Idempotence and durability
// ---------------------------------------------------------------------------

// §5.7 step 1 + §4.6 — `claimOnce(flushed-<session_id>)`. SessionEnd can fire more than
// once (reason=exit after reason=clear, a wrapper re-running the hook); the second
// invocation must not re-send. §7 names the marker file.
test('running session-end twice sends the ingest exactly once', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 2, 'first');

  const a = await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(a);

  assert.ok(existsSync(join(runDir(dataDir), `flushed-${fx.SESSION_ID}.marker`)),
    'the once-marker must be written at runs/<run_id>/flushed-<session_id>.marker (§7)');

  // New work arrives after the flush. The second run must still short-circuit —
  // it is the marker, not an empty spool, that has to stop it.
  seedSpool(dataDir, 2, 'second');

  const b = await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(b);

  assert.equal(server.countOf('POST', '/v2/control/ingest'), 1,
    `the once-marker must stop the second flush; saw: ${seq(server)}`);
  assert.equal(server.countOf('POST', '/v2/control/reflect'), 1);
});

// §5.7 "Failure" / §7 — the spool is keyed by run_id, not by session, so a session that
// crashed without ending still has its captures picked up by the next session's flush.
test('drains a crashed session spool, because the spool is keyed by run_id', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 3, 'crashed'); // left behind by a session that never reached SessionEnd

  const r = await runHook('session-end',
    fx.sessionEnd({ session_id: '00000000-dead-4dead-8dea-000000000000', cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });

  assertHookContract(r);
  server.assertCalled('POST', '/v2/control/ingest', 1);
  const ids = server.lastCall('POST', '/v2/control/ingest').body.items.map((i) => i.item_id);
  assert.deepEqual(ids.sort(), ['cc-crashed-0', 'cc-crashed-1', 'cc-crashed-2']);
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 0);
});

// §4.8 — the marker is what the status line and the next session read.
test('marker gains reflect {at, lessons_stored, status} from the response', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 1);

  const before = Date.now();
  const r = await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  const marker = readMarker(dataDir);
  assert.ok(marker.reflect, 'marker must carry a reflect section');
  assert.equal(marker.reflect.status, 'ok');
  assert.equal(marker.reflect.lessons_stored, 1); // default route stores 1
  assert.ok(marker.reflect.at >= before);
});

// §5.7 "Failure" / §12.1 F29 — a failed reflect is best-effort. What must NOT happen is
// losing the drain with it: the captures are already gone from the spool's perspective.
test('a failed reflect is logged, marked failed, exits 0 — and the drain still commits', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/reflect': { status: 500, json: { error: 'llm down' } } });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 3);

  const r = await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });

  assertHookContract(r);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { suppressOutput: true });

  server.assertCalled('POST', '/v2/control/ingest', 1);
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 0, 'the committed drain must survive a failed reflect');

  const marker = readMarker(dataDir);
  assert.equal(marker.reflect.status, 'failed');
});

// ---------------------------------------------------------------------------
// Documentation test — what a reflect does NOT buy you
// ---------------------------------------------------------------------------

/**
 * §1.4 / §5.7 "Expectation-setting". A reflect that stores 3 lessons has NOT made them
 * cross-session durable. Promotion past `run` scope is gated three more ways, all in the
 * same server-side loop:
 *
 *   1. not a rule           — `lesson.is_rule` entries never scope-promote
 *   2. validation `Active`  — pending/rejected candidates must earn trust first 
 *   3. recurrence           — the normalized key must recur
 *                             the promotion threshold times, default 3 
 *
 * One reflect per session is the NECESSARY condition, not the sufficient one. So the hook
 * reports a count and nothing more — a marker or systemMessage promising durability would
 * be a lie the user only discovers two sessions later, when the lesson is not there.
 */
test('reflect reports lessons_stored without claiming cross-session durability', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/reflect': {
      json: {
        lessons: [
          { lesson_id: 'les_1', content: 'A write is accepted before it is indexed, so recall can lag it.', lesson_type: 'failure', scope: 'run', importance: 'high' },
          { lesson_id: 'les_2', content: 'cargo check without --features misses the server paths.', lesson_type: 'failure', scope: 'run', importance: 'high' },
          { lesson_id: 'les_3', content: 'Run the migration before starting the server.', lesson_type: 'rule', scope: 'run', importance: 'medium' },
        ],
        summary: 'three lessons extracted', confidence: 0.71, degraded: false, lessons_stored: 3,
      },
    },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 2);

  const r = await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });

  assertHookContract(r);
  server.assertCalled('POST', '/v2/control/reflect', 1);

  const marker = readMarker(dataDir);
  assert.equal(marker.reflect.lessons_stored, 3, 'the marker records the count the server reported');

  // Every lesson above came back at `run` scope — none of them is visible to the next
  // session yet. Nothing the hook writes may suggest otherwise.
  const claims = /promot|durable|permanent|forever|cross-session|remembered next session/i;
  assert.ok(!claims.test(JSON.stringify(marker.reflect)),
    `the marker claims durability reflect cannot deliver: ${JSON.stringify(marker.reflect)}`);
  assert.ok(!claims.test(r.stdout), `stdout claims durability reflect cannot deliver: ${r.stdout}`);
  assert.deepEqual(r.json, { suppressOutput: true });
});

// §7 — sanity: SessionEnd is the pruning path (with drain), so it must not leave the
// data dir in a shape later hooks cannot read. Cheap guard against a half-written state.
test('leaves a readable state layout behind', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 2);

  const r = await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  for (const f of readdirSync(join(dataDir, 'status'))) {
    if (f.endsWith('.json')) readJsonFile(join(dataDir, 'status', f)); // throws on garbage
  }
  for (const f of readdirSync(runDir(dataDir))) {
    if (f.endsWith('.json')) readJsonFile(join(runDir(dataDir), f));
  }
});
