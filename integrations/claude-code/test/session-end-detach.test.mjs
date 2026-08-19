// @ts-check
/**
 * `hooks/src/session-end.mjs` — the flush has to outlive the hook process.
 *
 * Guide sections under test:
 *   §5.7  the ordered flow, unchanged, run somewhere the host cannot cancel it
 *   §4.9  `spawnDetached` — `detached: true`, `stdio: 'ignore'`, `unref()`, payload by file
 *   §4.6  `claimOnce` — one flush per session, which is what keeps a non-idempotent reflect single
 *   §1.4  reflect is the ONLY call that widens a lesson's scope past `run`
 *
 * ---------------------------------------------------------------------------
 * The fact this file exists to protect
 * ---------------------------------------------------------------------------
 * `POST /v2/control/reflect` is issued from exactly one place, and that place is a process
 * the host is free to take away. Under `--print` Claude Code emits its result and tears the
 * session down about a second into SessionEnd — a **cancellation**, not a timeout, so no
 * budget on either side of the boundary helps; a trial with `SessionEnd.timeout: 30` was
 * cancelled at the same ~1 s, four times out of four. Interactive sessions are cancelled too:
 * runs that demonstrably stored lessons still read `reflect: {at: 0, status: ""}`, because the
 * hook sent the request and was killed before it could say so.
 *
 * So the defect was never the reflect call and never a budget. It was that **all of
 * session-end's work lived inside a process with no right to finish**. The fix moves the body
 * into a detached child, which is what `test 1` below actually measures: the hook is SIGKILLed
 * mid-run and the flush is required to land anyway.
 *
 * Everything else here is the price of that move — the hand-off must be fast, must keep §5.7's
 * order, must stay once-per-session, must be switchable off, and must fall back to running
 * inline when the hand-off itself cannot happen. The inline body is exercised verbatim by
 * `session-end.test.mjs`, which pins `MUBIT_CC_SESSION_END_DETACH=0` for exactly that reason.
 *
 * Tests pin the run id with the `static` strategy (§6.1) so `runs/<run_id>/` can be seeded
 * before the hook runs, and so the marker can be read at a known path afterwards.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  runHook, assertHookContract, assertWithinBudget, fakeMubit, makeDataDir, makeProjectDir,
  baseEnv, lib, readJsonFile, spoolFiles, waitFor,
} from './helpers/harness.mjs';
import * as fx from './helpers/fixtures.mjs';

const PROJECT_DIR = makeProjectDir({ git: true });
const RUN_ID = 'cc-session-end-detach-test';

/** What the hand-off itself may cost above a bare `node` spawn: two small writes and a spawn. */
const BUDGET_MS = 800;

/**
 * A server-side stall on ingest, long enough that a body running *inline* is provably still
 * inside it when the process is killed. The detached child has ~11.5 s, so this costs it
 * nothing; an inline body has 6.8 s total and is mid-request at `KILL_AT_MS`.
 */
const INGEST_DELAY_MS = 2500;

/**
 * When the SIGKILL lands. Far enough in that the hand-off has provably happened (a hook that
 * reaches its first statement in under a second on a loaded machine is the assumption the
 * whole suite already makes), far short of the stalled ingest above.
 */
const KILL_AT_MS = 1200;

function env(dataDir, endpoint, extra = {}) {
  return baseEnv({
    dataDir,
    endpoint,
    projectDir: PROJECT_DIR,
    extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN_ID, ...extra },
  });
}

const runDir = (dataDir) => join(dataDir, 'runs', RUN_ID);
const markerPath = (dataDir) => join(dataDir, 'status', `${RUN_ID}.json`);

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

/** A staged turn awaiting attribution — `stage-prompt` (§5.3) plus `capture --stop` (§5.4). */
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
  const p = markerPath(dataDir);
  assert.ok(existsSync(p), `expected a status marker at status/${RUN_ID}.json (§4.8)`);
  return readJsonFile(p);
}

/** The marker as the child is still writing it — absent is a legitimate answer while polling. */
function markerOrNull(dataDir) {
  try { return existsSync(markerPath(dataDir)) ? readJsonFile(markerPath(dataDir)) : null; } catch { return null; }
}

/** Poll until `reflect.status` settles on `want`, then hand back the whole marker. */
function waitForStatus(dataDir, want, ms = 12_000) {
  return waitFor(() => {
    const m = markerOrNull(dataDir);
    return m && m.reflect && m.reflect.status === want ? m : null;
  }, ms);
}

const idx = (server, method, path) =>
  server.requests.findIndex((r) => r.method === method && r.path === path);

const seq = (server) => server.requests.map((r) => `${r.method} ${r.path}`).join(', ');

const INGEST_OK = { accepted: true, job_id: 'job_test_1', deduplicated: false, status: 'queued' };

/** Let anything already in flight settle, so "exactly once" means it and not "not yet twice". */
const settle = (ms = 400) => new Promise((r) => { setTimeout(r, ms); });

// ---------------------------------------------------------------------------
// 1. The regression: the host kills the hook, and the flush lands anyway
// ---------------------------------------------------------------------------

// This is the whole reason the change exists. On the inline body this test cannot pass:
// killing the process kills the reflect with it, and nothing anywhere records that it
// happened — the marker's `reflect` block is left at its creation default, which is
// indistinguishable from four other states.
test('the flush survives the hook process being killed mid-run', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/ingest': { delayMs: INGEST_DELAY_MS, json: INGEST_OK },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 2);

  const r = await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }), {
    env: env(dataDir, server.url),
    // What `--print` does, reproduced: the process is taken away, not asked to stop.
    killAfterMs: KILL_AT_MS,
  });

  // The kill either found a live process or found one that had already handed the work over
  // and exited. Both are the same story and neither is allowed to cost the flush, so the
  // assertions below are about the work, not about how the hook died.
  assert.ok(r.code === 0 || r.signal === 'SIGKILL',
    `expected a clean exit or a SIGKILL, got code=${r.code} signal=${r.signal}`);

  await waitFor(() => server.countOf('POST', '/v2/control/reflect') >= 1, 12_000);

  const marker = await waitForStatus(dataDir, 'ok');
  assert.equal(marker.reflect.lessons_stored, 1,
    'the child reports what reflect stored — the count the killed hook could never write');
  assert.ok(marker.reflect.at > 0, 'a terminal status carries the time it was reached');

  assert.equal(spoolFiles(dataDir, RUN_ID).length, 0,
    'the drain committed too: §5.7 step 2 runs in the child, ahead of the reflect');
  server.assertCalled('POST', '/v2/control/ingest', 1);
});

// ---------------------------------------------------------------------------
// 2. The hand-off is fast, and says so in the marker
// ---------------------------------------------------------------------------

// The parent's whole job: stash the payload, stamp the marker, spawn, return. It must not
// wait on any of the work it handed over — the host's 8 s ceiling stops applying only because
// nothing is waiting on us any more.
test('hands the flush to a detached child and returns immediately, marked detached', async (t) => {
  const server = await fakeMubit({
    // Holds the child inside its drain, so the marker read below is racing nothing.
    'POST /v2/control/ingest': { delayMs: INGEST_DELAY_MS, json: INGEST_OK },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 1);

  const r = await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });

  assertHookContract(r);
  assert.deepEqual(r.json, { suppressOutput: true }, 'stdout is unchanged by the hand-off');

  const marker = readMarker(dataDir);
  assert.equal(marker.reflect.status, 'detached',
    'the parent stamps the marker BEFORE spawning, so a fast child can only overwrite it');
  assert.equal(marker.reflect.at, 0, 'the parent has nothing to report yet');
  assert.equal(marker.reflect.lessons_stored, 0);

  // Nothing was sent by this process: the four calls belong to the child.
  assert.equal(server.countOf('POST', '/v2/control/reflect'), 0,
    `the parent must not reflect; saw: ${seq(server)}`);

  await assertWithinBudget('session-end (hand-off)', BUDGET_MS, r.ms, async () => {
    const fresh = makeDataDir();
    seedSpool(fresh, 1);
    return (await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
      { env: env(fresh, server.url) })).ms;
  });
});

// ---------------------------------------------------------------------------
// 3. §5.7's order is a property of the body, not of the process it runs in
// ---------------------------------------------------------------------------

// The drain commits before reflect is attempted (§1.4: a failing reflect may never cost
// captures that were already accepted), outcomes go out before reflect because
// `include_step_outcomes` folds them into the evidence, and the idle heartbeat goes last.
// Detaching moves all of it into another process; it must not reorder any of it.
test('the detached child keeps the ingest → outcome → reflect → heartbeat order', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 3);
  seedPendingTurn(dataDir, fx.PROMPT_ID, ['ref_lesson_1', 'ref_rule_1']);

  const r = await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  await waitFor(() => server.countOf('POST', '/v2/control/agents/heartbeat') >= 1, 12_000);

  const iIngest = idx(server, 'POST', '/v2/control/ingest');
  const iOutcome = idx(server, 'POST', '/v2/control/outcome');
  const iReflect = idx(server, 'POST', '/v2/control/reflect');
  const iBeat = idx(server, 'POST', '/v2/control/agents/heartbeat');

  assert.ok(iIngest >= 0 && iOutcome >= 0 && iReflect >= 0 && iBeat >= 0,
    `all four calls must land in the child; saw: ${seq(server)}`);
  assert.ok(iIngest < iOutcome, `the drain must commit before outcomes; saw: ${seq(server)}`);
  assert.ok(iOutcome < iReflect, `outcomes must land before reflect; saw: ${seq(server)}`);
  assert.ok(iReflect < iBeat, `reflect must precede the idle heartbeat; saw: ${seq(server)}`);

  const outcome = server.lastCall('POST', '/v2/control/outcome').body;
  assert.deepEqual(outcome.entry_ids, ['ref_lesson_1', 'ref_rule_1']);
  assert.equal(server.lastCall('POST', '/v2/control/ingest').body.items.length, 3);
});

// ---------------------------------------------------------------------------
// 4. Once per session — the claim moved with the body, on purpose
// ---------------------------------------------------------------------------

// `claimOnce` stays *inside* the detached body: a parent that claimed and then failed to
// spawn, or spawned a child that was reaped, would have burned the claim and taken the
// session's whole flush with it. And the claim has to hold, because reflect is NOT
// idempotent — a repeat call has been observed storing a lesson restating one already held.
test('two SessionEnds for one session produce exactly one reflect', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 2);

  const payload = fx.sessionEnd({ cwd: PROJECT_DIR, reason: 'clear' });
  const first = await runHook('session-end', payload, { env: env(dataDir, server.url) });
  const second = await runHook('session-end', { ...payload, reason: 'exit' },
    { env: env(dataDir, server.url) });

  assertHookContract(first);
  assertHookContract(second);

  await waitFor(() => server.countOf('POST', '/v2/control/reflect') >= 1, 12_000);
  await settle();

  assert.equal(server.countOf('POST', '/v2/control/reflect'), 1,
    `reflect is not idempotent — exactly one may go out; saw: ${seq(server)}`);
  assert.equal(server.countOf('POST', '/v2/control/ingest'), 1,
    `the second child must stand down before draining; saw: ${seq(server)}`);
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 0);
});

// ---------------------------------------------------------------------------
// 5. The opt-out, which is also what keeps the inline suite honest
// ---------------------------------------------------------------------------

// `MUBIT_CC_SESSION_END_DETACH=0` for an environment that forbids background processes —
// and the switch `session-end.test.mjs` sets, so all of its assertions keep running against
// the body itself rather than against a hand-off.
test('MUBIT_CC_SESSION_END_DETACH=0 runs the whole body inline, before the hook returns', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 1);

  const r = await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url, { MUBIT_CC_SESSION_END_DETACH: '0' }) });

  assertHookContract(r);
  // No `waitFor` anywhere here: that absence is the assertion.
  assert.equal(server.countOf('POST', '/v2/control/reflect'), 1,
    `the reflect must land before the hook returns; saw: ${seq(server)}`);

  const marker = readMarker(dataDir);
  assert.equal(marker.reflect.status, 'ok',
    'the inline body writes a terminal status; it never writes "detached"');
  assert.equal(marker.reflect.lessons_stored, 1);
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 0);
});

// ---------------------------------------------------------------------------
// 6. When the hand-off cannot happen at all
// ---------------------------------------------------------------------------

// A hand-off with nowhere to write its payload must degrade to what the plugin did before,
// not to nothing: losing a session's flush is the failure this whole change exists to stop,
// and an unwritable `tmp/` is not a reason to reintroduce it.
test('an unwritable tmp/ falls back to the inline body rather than dropping the flush', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('runs as root: mode bits do not deny root, so the fallback cannot be provoked');
    return;
  }
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 1);

  const tmp = join(dataDir, 'tmp');
  chmodSync(tmp, 0o500);
  t.after(() => { try { chmodSync(tmp, 0o700); } catch { /* already gone */ } });

  const r = await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });

  assertHookContract(r);
  assert.equal(server.countOf('POST', '/v2/control/reflect'), 1,
    `with no handoff file the body must run here and now; saw: ${seq(server)}`);

  const marker = readMarker(dataDir);
  assert.equal(marker.reflect.status, 'ok');
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 0);
});

// ---------------------------------------------------------------------------
// 7. `reflect.status`: two writers, and every value means exactly one thing
// ---------------------------------------------------------------------------

/**
 * | status                | written by                    | means                                   |
 * | --------------------- | ----------------------------- | --------------------------------------- |
 * | `""`                  | `lib/markers.mjs` default     | session-end never reached the hand-off  |
 * | `"detached"`          | the parent, before spawning   | handed over; no child has reported yet  |
 * | `ok` / `failed` / `skipped:*` | whichever process ran the body | terminal                        |
 *
 * The parent never writes a terminal status and the child never writes `detached`, which is
 * what makes a marker stuck on `detached` a *specific* failure — the child was reaped —
 * rather than one more indistinguishable blank.
 */

// Row 1. The default, and the only thing it may ever mean.
test('reflect.status "" is the untouched default, written by nobody', async () => {
  const markers = await lib('markers.mjs');
  const fresh = makeDataDir();
  assert.equal(markers.readMarker({ dataDir: fresh }, RUN_ID).reflect.status, '',
    'a run nothing has flushed reads blank — after this change that means exactly one thing');
  assert.ok(!existsSync(markerPath(fresh)), 'and nothing was written to disk to say so');
});

// Row 2. The parent's only marker write, and it is not terminal.
test('reflect.status "detached" is written by the parent and by nothing else', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/ingest': { delayMs: INGEST_DELAY_MS, json: INGEST_OK },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSpool(dataDir, 1);

  await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });

  assert.equal(readMarker(dataDir).reflect.status, 'detached');
  // ...and it is a transition, not a resting place: the child replaces it with a terminal one.
  const done = await waitForStatus(dataDir, 'ok');
  assert.equal(done.reflect.lessons_stored, 1);
});

/**
 * Rows 3+. Every terminal status, produced through the detached path. The child runs the
 * same body under the same gates, so the values it writes are the values `session-end.test.mjs`
 * already pins inline — and none of them is `detached`.
 */
const TERMINAL_ROWS = [
  { status: 'ok', spool: 1, why: 'the reflect answered' },
  {
    status: 'failed',
    spool: 1,
    why: 'the reflect was attempted and did not answer',
    routes: { 'POST /v2/control/reflect': { status: 500, json: { error: 'boom' } } },
  },
  {
    status: 'skipped:disabled',
    spool: 1,
    why: 'MUBIT_CC_REFLECT_ON_END=0, knowingly costing cross-session durability (§1.4)',
    extra: { MUBIT_CC_REFLECT_ON_END: '0' },
  },
  { status: 'skipped:not-ingested', spool: 0, why: 'an LLM-backed call over an empty tail is pure cost' },
  {
    status: 'skipped:undrained',
    spool: 1,
    why: 'the spool did not land, so reflecting would read a session the server only half has',
    routes: { 'POST /v2/control/ingest': { status: 500, json: { error: 'boom' } } },
  },
];

for (const row of TERMINAL_ROWS) {
  test(`reflect.status "${row.status}" is written by the child — ${row.why}`, async (t) => {
    const server = await fakeMubit(row.routes ?? {});
    t.after(() => server.close());
    const dataDir = makeDataDir();
    if (row.spool) seedSpool(dataDir, row.spool);

    const r = await runHook('session-end', fx.sessionEnd({ cwd: PROJECT_DIR }),
      { env: env(dataDir, server.url, row.extra ?? {}) });
    assertHookContract(r);

    const marker = await waitForStatus(dataDir, row.status);
    assert.notEqual(marker.reflect.status, 'detached',
      'a child never writes "detached" — that value belongs to the parent alone');
    assert.ok(marker.reflect.at > 0, 'every terminal status carries the time it was reached');
  });
}
