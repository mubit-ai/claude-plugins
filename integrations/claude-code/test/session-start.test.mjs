// @ts-check
/**
 * `hooks/src/session-start.mjs` — SessionStart (blocking, injection only).
 *
 * Guide sections under test:
 *   §5.1  flow, sub-budgets (health 400 ms / register 600 ms / lessons 900 ms), exact stdout
 *   §4.3  the `source` table: startup | resume | clear | compact | fork
 *   §1.2  `GET /v2/core/health` returns the bare string `OK`, not JSON
 *   §1.3  `ListLessonsRequest.run_id` is optional — empty means all runs
 *   §4.7  cold-start grace: `marker.cold_start_until = now + coldStartGraceMs`
 *   §4.9  the hook never blocks and never exits non-zero
 *
 * The whole budget is 2500 ms internal / 5 s hook timeout. Missing a *sub*-budget
 * degrades that section only — it never fails the hook.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  runHook, assertHookContract, assertWithinBudget, fakeMubit, lib, makeDataDir, makeProjectDir,
  baseEnv, readJsonFile, withEnv,
} from './helpers/harness.mjs';
import * as fx from './helpers/fixtures.mjs';

/** One real git project for every test in this file; run-id derivation shells out to git. */
const PROJECT_DIR = makeProjectDir({ git: true });

/** A run id no run-id strategy would ever derive, so "reused the map" is observable. */
const MAPPED_RUN = 'cc-mapped-11112222';

function env(dataDir, endpoint, extra = {}) {
  return baseEnv({ dataDir, endpoint, projectDir: PROJECT_DIR, extra });
}

/** Seed `sessions/<host_session_id>.json` — the SessionRecord of §4.3. */
function seedSessionRecord(dataDir, sessionId, over = {}) {
  const rec = {
    run_id: MAPPED_RUN,
    agent_id: 'claude-code-4f21ab',
    strategy: 'per-directory',
    project_dir: PROJECT_DIR,
    created_at: Date.now() - 60_000,
    last_seen_at: Date.now() - 60_000,
    mode: 'local',
    clear_count: 0,
    endpoint_hash: 'deadbeefcafe',
    ...over,
  };
  writeFileSync(join(dataDir, 'sessions', `${sessionId}.json`), JSON.stringify(rec));
  return rec;
}

/** §7: `runs/<run_id>/checkpoints.json` — what `checkpoint --pre` leaves behind. */
function seedCheckpoints(dataDir, runId, entries) {
  const dir = join(dataDir, 'runs', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'checkpoints.json'), JSON.stringify(entries));
}

/** The single status marker (§4.8). `status/health.json` is the health cache, not a marker. */
function readMarker(dataDir) {
  const dir = join(dataDir, 'status');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'health.json');
  assert.equal(files.length, 1, `expected exactly one status marker, got [${files.join(', ')}]`);
  return readJsonFile(join(dir, files[0]));
}

/** Every distinct non-empty `run_id` the hook put on the wire. */
function outgoingRunIds(server) {
  return [...new Set(
    server.requests.map((r) => r?.body?.run_id).filter((v) => typeof v === 'string' && v.length > 0),
  )];
}

const seq = (server) => server.requests.map((r) => `${r.method} ${r.path}`);

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

// §5.1 steps 4-6: health, then register, then lessons — in that order, and nothing else.
test('startup calls health -> register -> lessons, in that order', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });

  assertHookContract(r);
  assert.deepEqual(seq(server), [
    'GET /v2/core/health',
    'POST /v2/control/agents/register',
    'POST /v2/control/lessons',
  ]);

  // §1.2 — health is allowlisted and returns the plain string `OK`. A hook that
  // JSON.parses it would treat a healthy server as down, so the two calls that
  // follow are themselves the proof it was read as text.
  const reg = server.lastCall('POST', '/v2/control/agents/register');
  assert.match(String(reg.headers.authorization ?? ''), /mbt_test/, 'must send the API key (§1.2)');
});

// §5.1 — the RegisterAgent body, verbatim.
test('register body carries run_id, agent_id, role, status and capabilities', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  const body = server.lastCall('POST', '/v2/control/agents/register').body;
  assert.equal(body.role, 'worker');
  assert.equal(body.status, 'active');
  assert.deepEqual(body.capabilities, ['code', 'shell', 'edit', 'search']);
  // §1.3 — run_id and agent_id are mandatory on StateAgentRegisterRequestPayload.
  assert.match(body.run_id, /^cc-/);
  assert.equal(body.agent_id, 'claude-code');
  // §4.3 — the MCP server's `MUBIT_DEFAULT_SESSION_ID` default collapses every
  // project into one run. No strategy may ever emit it.
  assert.notEqual(body.run_id, 'default');
});

// §1.3 / control.proto — ListLessonsRequest.run_id is optional; empty means
// all runs, which is exactly what "global lessons" wants. Scoping it to this run
// would return nothing on a brand-new run.
test('lessons request is {scope:"global", limit:5} with no run_id', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  const body = server.lastCall('POST', '/v2/control/lessons').body;
  assert.equal(body.scope, 'global');
  assert.equal(body.limit, 5);
  assert.ok(
    body.run_id === undefined || body.run_id === '',
    `lessons must not be scoped to one run, got run_id=${JSON.stringify(body.run_id)}`,
  );
});

// §5.1 stdout — the steer block names the run and mode, tells the model recall is
// automatic (so it does not burn a turn searching), and the systemMessage is one line.
test('stdout is a SessionStart steer block plus a one-line systemMessage', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  const out = r.json.hookSpecificOutput;
  assert.equal(out.hookEventName, 'SessionStart');

  const runId = server.lastCall('POST', '/v2/control/agents/register').body.run_id;
  const ctx = out.additionalContext;
  assert.ok(ctx.includes(runId), `additionalContext must name the run, got:\n${ctx}`);
  assert.match(ctx, /hosted/, 'additionalContext must name the mode');
  // §5.1 — the steer must carry BOTH halves, and the pair is the contract. This test used to
  // assert only `/do not search/i`, which is how the plugin shipped a steer that told the
  // model memory existed and never to reach for it: a negative with no positive beside it,
  // against tool descriptions that said nothing about when to use them either (audit C1,
  // C2). Between them the trained behaviour was to call no memory tool at all — so every
  // measurement of those tools was really a measurement of this paragraph.
  assert.match(ctx, /injected automatically/i);
  assert.match(ctx, /no need to open a turn by searching/i,
    `the steer must say recall is already injected, so turn one need not search:\n${ctx}`);
  assert.match(ctx, /do search when the injected memory falls short/i,
    `the steer must also say when searching IS right, or the negative stands alone:\n${ctx}`);
  for (const tool of ['mubit_recall', 'mubit_diagnose', 'mubit_dereference']) {
    assert.ok(ctx.includes(tool), `the steer must name ${tool} as the tool for its case:\n${ctx}`);
  }
  // The lesson section renders what /v2/control/lessons returned.
  assert.match(ctx, /standing lessons/i);
  assert.ok(ctx.includes('Run the migration'), `lesson content must render, got:\n${ctx}`);

  assert.match(r.json.systemMessage, /^mubit: hosted · run \S+ · \d+ global lessons?$/);
  assert.ok(r.json.systemMessage.includes(runId));
  assert.ok(!r.json.systemMessage.includes('\n'), 'systemMessage is one line');
});

/** The same qualifier on the other injection surface — these were learned elsewhere too. */
test('the standing lessons section says they may be out of date', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /standing lessons/i);
  assert.match(ctx, /may be out of date/i);
  assert.match(ctx, /verify/i);
});

/**
 * A standing lesson steers the whole session, so it has to be able to earn that place — and
 * to lose it. Attribution runs on ids, and this hook used to parse `lesson_id` off the wire
 * and throw it away, which left every global lesson permanently uncreditable: never
 * reinforced when it helped, never corrected when it was wrong.
 */
test('the lesson ids are kept on the marker for the first turn to credit', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  const marker = readMarker(dataDir);
  assert.deepEqual(marker.lessons.injected_ids, ['les_g1'],
    'the lesson id must survive the parse');
  assert.equal(marker.lessons.credited_at, 0, 'nothing has credited them yet');

  // The id is bookkeeping, not prose: the model sees the lesson, not its id.
  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.ok(!ctx.includes('les_g1'), 'the id must not be rendered into the steer block');
});


// §4.7 — the grace window starts here, so failures in the first seconds after
// still starting up do not tell the user their memory is broken.
test('marker.cold_start_until = now + coldStartGraceMs', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const before = Date.now();
  const r = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url, { MUBIT_CC_COLDSTART_GRACE_MS: '20000' }) });
  const after = Date.now();
  assertHookContract(r);

  const marker = readMarker(dataDir);
  assert.ok(marker.cold_start_until >= before + 20000,
    `cold_start_until ${marker.cold_start_until} < ${before + 20000}`);
  assert.ok(marker.cold_start_until <= after + 20000,
    `cold_start_until ${marker.cold_start_until} > ${after + 20000}`);
});

// §4.7 — the window is a property of the *endpoint*, not of the session. Re-arming it on
// entry meant it was open at the instant every probe failed, on every session, forever: the
// grace could never expire, so `◍ warming` masked every real fault permanently and no other
// failure state was reachable through the hook that runs first.
test('cold_start_until is armed once per endpoint, not once per session', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const e = env(dataDir, server.url, { MUBIT_CC_COLDSTART_GRACE_MS: '20000' });

  const first = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }), { env: e });
  assertHookContract(first);
  const armed = readMarker(dataDir).cold_start_until;
  assert.ok(armed > 0, 'the first session for an endpoint arms the window');

  // A later session against the same endpoint inherits the same deadline, so the window
  // runs down in wall-clock time instead of restarting.
  const second = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }), { env: e });
  assertHookContract(second);
  assert.equal(readMarker(dataDir).cold_start_until, armed,
    'a second session re-armed the grace window instead of inheriting it');
});

// The other half of the same rule: a genuinely new instance really is starting up, so
// pointing at one arms a fresh window — and pointing back at a familiar one does not.
test('a new endpoint arms its own window; returning to the old one does not re-arm', async (t) => {
  const a = await fakeMubit();
  const b = await fakeMubit();
  t.after(() => { a.close(); b.close(); });
  const dataDir = makeDataDir();
  const grace = { MUBIT_CC_COLDSTART_GRACE_MS: '20000' };

  await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }), { env: env(dataDir, a.url, grace) });
  const armedA = readMarker(dataDir).cold_start_until;

  await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }), { env: env(dataDir, b.url, grace) });
  const armedB = readMarker(dataDir).cold_start_until;
  assert.notEqual(armedB, armedA, 'a different endpoint should arm its own grace window');

  await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }), { env: env(dataDir, a.url, grace) });
  assert.equal(readMarker(dataDir).cold_start_until, armedA,
    'returning to an endpoint already seen re-armed its window instead of reusing the record');
});

// §4.1 — the state that used to be reported as `server_error`: `urlFor` handed `fetch` a
// bare route, `fetch` threw ERR_INVALID_URL before opening a socket, and `classifyError`
// had no branch for it. The user was then sent to the README row that says the client
// cannot fix it, for the one problem only the client can fix.
test('no endpoint reports unconfigured, dials nothing, and names the fix', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }),
    { env: env(dataDir, '') });
  assertHookContract(r);

  const marker = readMarker(dataDir);
  assert.equal(marker.state, 'unconfigured');
  assert.equal(marker.cold_start_until, 0, 'an unset endpoint has nothing to warm up');
  server.assertCalled('GET', '/v2/core/health', 0);

  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /not configured/i);
  assert.match(ctx, /\/mubit-memory:auth/, 'the injected block must name the one command that fixes it');
  assert.doesNotMatch(ctx, /is unreachable|server_error/,
    'an unset endpoint is not a verdict about a server');
});

// ---------------------------------------------------------------------------
// §4.3 — the `source` table
// ---------------------------------------------------------------------------

// §4.3 `startup`: derive fresh, write the session map, RegisterAgent.
test('source=startup derives a fresh run, writes the session map and registers', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('session-start', fx.sessionStart({ source: 'startup', cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  server.assertCalled('POST', '/v2/control/agents/register', 1);

  assert.deepEqual(readdirSync(join(dataDir, 'sessions')), [`${fx.SESSION_ID}.json`]);
  const rec = readJsonFile(join(dataDir, 'sessions', `${fx.SESSION_ID}.json`));
  assert.equal(rec.run_id, server.lastCall('POST', '/v2/control/agents/register').body.run_id);
  assert.match(rec.run_id, /^cc-/);
});

// §4.3 `resume`: reuse the mapped run and send a heartbeat INSTEAD of re-registering.
// Re-registering an agent that never left is noise the control plane has to reconcile.
test('source=resume reuses the mapped run and heartbeats instead of registering', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSessionRecord(dataDir, fx.SESSION_ID);

  const r = await runHook('session-start', fx.sessionStart({ source: 'resume', cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  server.assertNotCalled('POST', '/v2/control/agents/register');
  server.assertCalled('POST', '/v2/control/agents/heartbeat', 1);
  assert.deepEqual(outgoingRunIds(server), [MAPPED_RUN]);
});

// §4.3 `clear`: /clear means "forget the thread", so reusing the stable per-directory
// run would defeat it. A new run id, tracked by the record's clear counter.
test('source=clear produces a NEW run, not the mapped one', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSessionRecord(dataDir, fx.SESSION_ID, { clear_count: 0 });

  const r = await runHook('session-start', fx.sessionStart({ source: 'clear', cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  const runIds = outgoingRunIds(server);
  assert.equal(runIds.length, 1);
  assert.notEqual(runIds[0], MAPPED_RUN, '/clear must not reuse the cleared run');
  assert.match(runIds[0], /^cc-/);
  assert.notEqual(runIds[0], 'default');

  const rec = readJsonFile(join(dataDir, 'sessions', `${fx.SESSION_ID}.json`));
  assert.equal(rec.run_id, runIds[0], 'the session map must follow the new run');
});

/*
 * §4.3/I5 — the reset is defensible; the silence was not.
 *
 * `/clear` starts the session on a run with nothing in it, and until now nothing said so. The
 * model opened with "Mubit memory is active" and a run id, recalled nothing all session, and
 * neither it nor the user had any way to tell that apart from a project that has simply never
 * learned anything. Those are different facts and the user acts differently on each.
 *
 * The fact costs nothing to state: `sourceOf(payload)` is already read for the
 * register-versus-heartbeat decision, so this is a branch on a value in hand, not a round
 * trip. Nothing here may touch §5.1's 400/600/900 ms sub-budgets.
 */
test('source=clear says the memory was reset, and names the command that reconnects it', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSessionRecord(dataDir, fx.SESSION_ID, { clear_count: 0 });

  const r = await runHook('session-start', fx.sessionStart({ source: 'clear', cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Mubit memory is active/,
    'a cleared session is still a working session; this is a note on the steer block, not a '
    + 'replacement for it');
  assert.match(ctx, /reset by \/clear/i,
    `the model has to be told why this run is empty, got:\n${ctx}`);
  assert.match(ctx, /\/mubit-memory:link/,
    `saying the memory is gone without saying how to get it back is half a message:\n${ctx}`);

  // §5.1 — the whole point of putting it here is that the fact was already in hand.
  await assertWithinBudget('session-start --clear', 3200, r.ms, async () => (await runHook(
    'session-start', fx.sessionStart({ source: 'clear', cwd: PROJECT_DIR }),
    { env: env(makeDataDir(), server.url) },
  )).ms);
});

/*
 * The other direction, and the one that decides whether the line is information or noise.
 * `resume`, `compact` and `fork` all reuse the mapped run and `startup` re-derives it, so on
 * every source but one the project's memory is exactly where it was. Telling a resumed session
 * it was reset would be a straight falsehood, and telling every session about `/clear` would
 * train the model to ignore the paragraph the one cleared session needs.
 */
for (const source of ['startup', 'resume', 'compact', 'fork']) {
  test(`source=${source} says nothing about a reset`, async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const dataDir = makeDataDir();
    seedSessionRecord(dataDir, fx.SESSION_ID);

    const r = await runHook('session-start', fx.sessionStart({ source, cwd: PROJECT_DIR }),
      { env: env(dataDir, server.url) });
    assertHookContract(r);

    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /reset by \/clear/i,
      `${source} keeps the project's memory where it was, got:\n${ctx}`);
    assert.ok(!ctx.includes('/mubit-memory:link'),
      `${source} has nothing to reconnect, and offering the command implies it does`);
  });
}

// §4.3 `compact`: compaction is one conversation continuing, so the run continues too.
test('source=compact reuses the parent session record run', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSessionRecord(dataDir, fx.SESSION_ID);

  const r = await runHook('session-start', fx.sessionStart({ source: 'compact', cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  assert.deepEqual(outgoingRunIds(server), [MAPPED_RUN]);
});

// §5.6 — the post-compaction re-anchor is delivered HERE, not by `checkpoint --post`.
// `PostCompact` is not a `hookSpecificOutput.hookEventName` Claude Code accepts (see
// `test/hook-output.test.mjs`), so anything that hook injected was discarded whole. This is
// the only hook that both runs after a compaction and has an accepted event name.
test('source=compact re-anchors the session to the stored checkpoint', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSessionRecord(dataDir, fx.SESSION_ID);
  seedCheckpoints(dataDir, MAPPED_RUN, [
    { checkpoint_id: 'ckpt_older_1', token_estimate: 1200, at: 1765000000000 },
    { checkpoint_id: 'ckpt_seeded_9', token_estimate: 3400, at: 1765000001000 },
  ]);

  const r = await runHook('session-start', fx.sessionStart({ source: 'compact', cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  const out = r.json.hookSpecificOutput;
  assert.equal(out.hookEventName, 'SessionStart', 'the one accepted channel after a compaction');
  assert.ok(out.additionalContext.includes('ckpt_seeded_9'),
    `the block must name the NEWEST stored checkpoint, got:\n${out.additionalContext}`);
  assert.ok(!out.additionalContext.includes('ckpt_older_1'),
    'only the newest anchor is worth the model\'s attention');
  assert.match(out.additionalContext, /\/mubit-memory:recall/,
    'and must say how to ask for what was compacted away');
});

// The same rule in the other direction: a fresh session is not a compacted one, and telling
// it that a checkpoint "holds the pre-compaction context" for a conversation that never
// compacted spends the model's attention on a claim about nothing.
test('source=startup does not re-anchor, even with a stored checkpoint', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSessionRecord(dataDir, fx.SESSION_ID);
  seedCheckpoints(dataDir, MAPPED_RUN, [
    { checkpoint_id: 'ckpt_seeded_9', token_estimate: 3400, at: Date.now() },
  ]);

  const r = await runHook('session-start', fx.sessionStart({ source: 'startup', cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  assert.ok(!r.json.hookSpecificOutput.additionalContext.includes('ckpt_seeded_9'),
    'a startup session was not compacted; there is nothing to re-anchor');
});

// §5.6 — with nothing stored there is nothing to anchor to. `--pre` never ran for this run,
// its call failed, or §7's sweep took the file. Saying "checkpoint undefined holds your
// context" is strictly worse than silence.
test('source=compact with no stored checkpoint steers normally and names no anchor', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSessionRecord(dataDir, fx.SESSION_ID);

  const r = await runHook('session-start', fx.sessionStart({ source: 'compact', cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Mubit memory is active/, 'the ordinary steer block still ships');
  assert.doesNotMatch(ctx, /checkpoint/i,
    `no stored anchor must mean no anchor paragraph, got:\n${ctx}`);
});

/**
 * §4.3 `fork`: `--fork-session`, the `/fork` background copy and `/branch` all continue an
 * existing conversation, so the run continues with them — the same rule `compact` and
 * `resume` follow, for the same reason.
 *
 * This is a regression test for a session that got nothing at all. `hooks/hooks.json` matched
 * `startup|resume|clear|compact`; Claude Code reported `fork` from v2.1.214 onward and
 * `resume` before it, so the four-source matcher used to catch a fork by accident and then
 * stopped. Verified live on 2.1.235 in `docs/manual-test-hs-1.md` §5: a match-all SessionStart
 * group logged `{"source":"fork"}` while a four-source group beside it logged nothing. Since
 * this hook is the one that derives the run id, arms the cold-start window, writes the marker
 * and injects the steer, the miss cost the whole feature — in exactly the sessions a user
 * branched *because* the work mattered.
 *
 * Heartbeat, not register, is the second half. `deriveAgentId` (`lib/runid.mjs:287`) returns
 * the bare role for a parent session, so the agent the forked-from session announced IS this
 * agent; re-registering it is the reconciliation noise the `resume` branch already exists to
 * avoid.
 */
test('source=fork reuses the parent run and heartbeats instead of registering', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSessionRecord(dataDir, fx.SESSION_ID);

  const r = await runHook('session-start', fx.sessionStart({ source: 'fork', cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  assert.deepEqual(seq(server), [
    'GET /v2/core/health',
    'POST /v2/control/agents/heartbeat',
    'POST /v2/control/lessons',
  ], 'a fork continues a session that never left, so re-announcing its agent is noise the '
    + 'control plane has to reconcile');
  server.assertNotCalled('POST', '/v2/control/agents/register');

  assert.deepEqual(outgoingRunIds(server), [MAPPED_RUN],
    'deriving a fresh run id here would cut the fork off from the parent conversation\'s '
    + 'captured turns, which is the memory the user branched in order to keep');

  // §4.8 — `status/<run_id>.json` is what `bin/statusline.mjs` renders and what every later
  // hook in this session reads back. Without it a forked session shows no memory state at all.
  const markers = readdirSync(join(dataDir, 'status')).filter((f) => f !== 'health.json');
  assert.deepEqual(markers, [`${MAPPED_RUN}.json`],
    'the marker must be written under the inherited run, not a fresh one or none');

  // The claim this ticket exists to prove: a forked session is given the memory a resumed one
  // is given — the run named, and the standing lessons rendered.
  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes(MAPPED_RUN),
    `the steer block must name the inherited run, got:\n${ctx}`);
  assert.match(ctx, /standing lessons/i,
    'the global lessons a resumed session opens with must reach a forked one too');
});

/**
 * The shape a *live* fork actually arrives in, which the mapped case above does not cover.
 *
 * A real `--fork-session` payload carries a brand-new `session_id` and no pointer whatsoever
 * back to the parent — captured verbatim from Claude Code 2.1.235 in
 * `docs/manual-test-hs-1.md` §5:
 *
 *     {"session_id":"e8303836-739a-45da-a09a-5861b96df5d1","transcript_path":"…","cwd":"…",
 *      "hook_event_name":"SessionStart","source":"fork"}
 *
 * So on the first SessionStart of a fork there is no session map to reuse and
 * `resolveRunId` falls through to `deriveFresh` (`lib/runid.mjs:157`). Continuity is then the
 * strategy's job, and under the default `per-directory` the fork derives the very run its
 * parent derived from the same directory. That is what makes the matcher fix sufficient
 * rather than merely necessary: without this the fix would fire the hook and still hand the
 * fork a stranger's run.
 */
test('an unmapped fork session id still lands on the run its parent derived', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();

  // The parent: an ordinary startup, mapping nothing this fork can look up.
  const parent = await runHook('session-start',
    fx.sessionStart({ source: 'startup', cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(parent);
  const parentRun = server.lastCall('POST', '/v2/control/agents/register').body.run_id;

  // The fork: a session id the plugin has never seen, exactly as the host delivers it.
  const forkSession = 'e8303836-739a-45da-a09a-5861b96df5d1';
  const fork = await runHook('session-start', fx.sessionStart({
    source: 'fork',
    session_id: forkSession,
    transcript_path: `/Users/x/.claude/projects/-Users-x-repo/${forkSession}.jsonl`,
    cwd: PROJECT_DIR,
  }), { env: env(dataDir, server.url) });
  assertHookContract(fork);

  // The matcher change is what makes this hook run at all; the heartbeat is how it says
  // so. Assert it landed before reading its body, or a fork that never reached the wire
  // fails as a TypeError instead of as the missing round trip it is.
  server.assertCalled('POST', '/v2/control/agents/heartbeat', 1);
  assert.equal(server.lastCall('POST', '/v2/control/agents/heartbeat').body.run_id, parentRun,
    'a fork carries a new host session id, so only the run strategy can keep it on the '
    + 'parent\'s memory — a different run id here means the branch starts blind');

  // The fork gets its OWN entry in the session map, beside the parent's rather than over it,
  // so every later hook in the forked session resolves the run without re-deriving — and the
  // parent, if it is still open, goes on resolving too.
  assert.deepEqual(readdirSync(join(dataDir, 'sessions')).sort(),
    [`${forkSession}.json`, `${fx.SESSION_ID}.json`].sort(),
    'a fork must map its new session id without unmapping the session it forked from');
  const rec = readJsonFile(join(dataDir, 'sessions', `${forkSession}.json`));
  assert.equal(rec.run_id, parentRun, 'the fork\'s session record must point at the same run');
});

// ---------------------------------------------------------------------------
// Degraded paths — §5.1 "Failure", §4.9 "never blocks"
// ---------------------------------------------------------------------------

// §5.1 step 4: health not ok -> skip register and lessons, but STILL steer, so the
// model knows memory is offline instead of inventing recall it never received.
/**
 * The gap health cannot close. `GET /v2/core/health` is allowlisted before authentication —
 * it answers `OK` for a wrong key, an expired key, and no key at all — so a session whose
 * credential is rejected used to open with "Mubit memory is active" and then silently recall
 * nothing all session. The first authenticated call of the session is the one that knows,
 * and now it is the one that decides.
 */
test('a rejected key produces the unauthenticated block, not "memory is active"', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/agents/register': { status: 401, json: { error: 'invalid api key' } },
    'POST /v2/control/lessons': { status: 401, json: { error: 'invalid api key' } },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  // Health said OK — the point of the test is that this is no longer enough.
  server.assertCalled('GET', '/v2/core/health', 1);

  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /not authenticated/i);
  assert.ok(!/memory is active/i.test(ctx), 'the steer must not claim memory is working');
  assert.match(ctx, /do not assume anything was recalled/i);
  assert.match(ctx, /mubit-memory:auth/, 'the user needs the one command that fixes it');
  // Capture keeps running: the work is buffered, not dropped.
  assert.match(ctx, /captured and buffered/i);

  assert.equal(readMarker(dataDir).state, 'auth_failed');
});

/** A transport hiccup on register is not an authentication verdict, and must not read as one. */
test('a register failure that is not about the key leaves the steer block alone', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/agents/register': { status: 500, json: { error: 'boom' } },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /memory is active/i);
  assert.ok(!/not authenticated/i.test(ctx));
});

test('health down skips register and lessons but still emits a steer block', async (t) => {
  const server = await fakeMubit({ 'GET /v2/core/health': { status: 503, text: 'unavailable' } });
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url, { MUBIT_CC_COLDSTART_GRACE_MS: '0' }) });

  assertHookContract(r);
  server.assertNotCalled('POST', '/v2/control/agents/register');
  server.assertNotCalled('POST', '/v2/control/agents/heartbeat');
  server.assertNotCalled('POST', '/v2/control/lessons');

  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(ctx, /offline|unavailable|not reachable|unreachable/i,
    `the steer block must say memory is offline, got:\n${ctx}`);
  assert.ok(!/standing lessons/i.test(ctx), 'no lesson section when lessons were never fetched');
  assert.ok(!ctx.includes('Run the migration'));

  assert.match(r.json.systemMessage, /^mubit: offline \([a-z_]+\) · capture buffered$/);
});

// §5.1 "Failure" — the exact offline line, with nothing listening at all.
// Grace is pinned to 0 so §4.7's cold-start suppression cannot mask it.
test('unreachable endpoint emits the exact offline systemMessage and exits 0', async (t) => {
  const dead = await fakeMubit();
  const deadUrl = dead.url;
  await dead.close();
  const dataDir = makeDataDir();

  const r = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }),
    { env: env(dataDir, deadUrl, { MUBIT_CC_COLDSTART_GRACE_MS: '0' }) });

  assertHookContract(r);
  assert.equal(r.json.systemMessage, 'mubit: offline (unreachable) · capture buffered');
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(r.json.hookSpecificOutput.additionalContext, /offline|unreachable/i);
});

// §5.1 step 1 — with both halves off there is nothing to say and nobody to say it to.
test('capture and recall both disabled emits {} with zero HTTP', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }), {
    env: env(dataDir, server.url, { MUBIT_CC_CAPTURE: '0', MUBIT_CC_RECALL: '0' }),
  });

  assertHookContract(r);
  assert.deepEqual(r.json ?? {}, {});
  assert.equal(server.requests.length, 0, `expected no HTTP, saw: ${seq(server).join(', ')}`);
});

// §5.1 step 4 — health is the GATE, and a gate that is starved fails the whole hook, not one
// section. With the sub-budget pinned at 400 ms a cold or loaded instance that answered
// correctly in 700 ms read as `not_responding`: every session then opened by telling the model
// memory was offline and recall was unavailable, while recall itself worked normally. The
// budget must clear a realistic cold answer, not a warm one.
test('a healthy instance that answers health slowly is ready, not offline', async (t) => {
  const server = await fakeMubit({
    // Correct answer (§1.2: the bare string `OK`), just slow.
    'GET /v2/core/health': { text: 'OK', delayMs: 700 },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url, { MUBIT_CC_COLDSTART_GRACE_MS: '0' }) });

  assertHookContract(r);
  assert.equal(readMarker(dataDir).state, 'ready',
    'a slow-but-correct health answer is not a server fault');

  // The gate opened, so the steps it gates ran.
  server.assertCalled('POST', '/v2/control/agents/register', 1);
  server.assertCalled('POST', '/v2/control/lessons', 1);

  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Mubit memory is active/,
    `a healthy instance must get the active steer block, got:\n${ctx}`);
  assert.doesNotMatch(ctx, /offline|unreachable/i,
    'steering the model away from its own memory is the cost of a starved health budget');
});

// The other half of the same change: a bigger health slice must not be able to push the hook
// past its harness budget. `budgetFor()` clamps each later sub-budget to what health left, so
// a slow health AND a stalled lesson list still land inside HARNESS_BUDGET_MS.
test('a slow health plus a stalled lessons call still fits the harness budget', async (t) => {
  const server = await fakeMubit({
    'GET /v2/core/health': { text: 'OK', delayMs: 700 },
    'POST /v2/control/lessons': { delayMs: 5000, json: { lessons: [] } },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url, { MUBIT_CC_COLDSTART_GRACE_MS: '0' }) });

  assertHookContract(r);
  assert.equal(readMarker(dataDir).state, 'ready');
  const out = r.json.hookSpecificOutput;
  assert.equal(out.hookEventName, 'SessionStart');
  assert.ok(!/standing lessons/i.test(out.additionalContext),
    'the lesson section is dropped, not waited for');
  assert.ok(r.ms < 3200, `session-start took ${r.ms}ms, past its 3200ms harness budget`);
});

// §5.1 "Missing a sub-budget degrades that section only." Lessons stalls past its
// 900 ms sub-budget; the hook still steers, just without a lesson section.
test('a lessons call past its 900ms sub-budget degrades only that section', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/lessons': { delayMs: 1200, json: { lessons: [] } },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });

  assertHookContract(r);
  server.assertCalled('POST', '/v2/control/agents/register', 1);
  server.assertCalled('POST', '/v2/control/lessons', 1);

  const out = r.json.hookSpecificOutput;
  assert.equal(out.hookEventName, 'SessionStart');
  const runId = server.lastCall('POST', '/v2/control/agents/register').body.run_id;
  assert.ok(out.additionalContext.includes(runId), 'the steer block survives a slow lessons call');
  assert.ok(!/standing lessons/i.test(out.additionalContext),
    'the lesson section is dropped, not waited for');

  // The 2500 ms whole-hook budget still holds; the 900 ms sub-budget is what expired.
  await assertWithinBudget('session-start', 3200, r.ms, async () => (await runHook(
    'session-start', fx.sessionStart({ cwd: PROJECT_DIR }),
    { env: env(makeDataDir(), server.url) },
  )).ms);
});

// ===========================================================================
// §6 Tier 2 — the same-remote offer
// ===========================================================================

/*
 * SCOPE.md §6 measured the signal: six directories on one machine, six run ids, two git
 * remotes, and the two groups the remote draws are the two a human would draw. Tier 2 is the
 * plugin proposing that join the first time a second checkout shows up — the moment the
 * question becomes real, on a machine where it applies, and never on one where it does not.
 *
 * Three properties are worth more than the happy path here.
 *
 *   1. **Directories and dates, never hashes.** The same constraint SC-09 built the whole link
 *      surface around: `cc-storefront-1a2b3c4d` is a hash of a git toplevel, nobody recognises
 *      their own project in one, and a prompt that prints one is a release away from a prompt
 *      that asks for one. The steer block names *this* run by design (§5.1); the offer names
 *      the other project by directory, and this file slices the section out to say so.
 *   2. **Asked once, remembered against the pair.** The user declined linking two projects,
 *      not two sessions, so the answer has to survive a new session in either of them — which
 *      is why `lib/links.mjs` writes both ends.
 *   3. **It costs the spawn path nothing it was not already paying.** The remote comes off the
 *      session record (`lib/runid.mjs`), the scan is bounded, and every part of it is
 *      best-effort: a damaged data dir costs the offer and never the session.
 */

/** Two checkouts of one repository. The origin is the whole signal (§6). */
const REMOTE = 'git@github.com:acme/storefront.git';

/** A day, so `last_seen_at` offsets read the way the offer renders them. */
const DAY = 86400000;

/** The heading both link notices render under; see `steerBlock`. */
const LINK_HEADING = '## Linking this project';

/** The shape `lib/runid.mjs` mints, as `test/link.test.mjs` writes it. */
const RUN_ID_SHAPE = /\bcc-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}\b/;

function envIn(dataDir, endpoint, projectDir, extra = {}) {
  return baseEnv({ dataDir, endpoint, projectDir, extra });
}

/**
 * A §4.3 `SessionRecord` for ANOTHER project on this machine, exactly as `rememberRun` writes
 * one — `git_remote` included, because that field is the whole reason the offer can decide
 * without spawning `git` once per candidate.
 */
function seedProject(dataDir, sessionId, over = {}) {
  const rec = {
    run_id: '',
    agent_id: 'claude-code',
    strategy: 'per-directory',
    project_dir: '',
    project_root: '',
    created_at: Date.now() - (30 * DAY),
    last_seen_at: Date.now(),
    mode: 'local',
    clear_count: 0,
    previous_run_id: '',
    endpoint_hash: 'deadbeefcafe',
    git_remote: '',
    ...over,
  };
  if (!rec.project_root) rec.project_root = rec.project_dir;
  writeFileSync(join(dataDir, 'sessions', `${sessionId}.json`), JSON.stringify(rec));
  return rec;
}

/**
 * The link section of a steer block, or `''` when neither notice fired. Sliced out rather
 * than matched across the whole block because the block names this run on purpose (§5.1) and
 * the offer may not name any run at all — the assertion only means something inside the
 * section it is about.
 */
function linkSection(ctx) {
  const at = String(ctx ?? '').indexOf(LINK_HEADING);
  if (at < 0) return '';
  const rest = String(ctx).slice(at + LINK_HEADING.length);
  const next = rest.indexOf('\n## ');
  return next < 0 ? rest : rest.slice(0, next);
}

/** SC-09's executable rule, applied to the offer. @param {string} out @param {string[]} ids */
function assertNoRunIds(out, ids, what) {
  for (const id of ids) {
    assert.ok(!out.includes(id),
      `${what} printed the run id ${JSON.stringify(id)}. §6: users never see run ids — a hash `
      + `of a git toplevel is not something anyone can recognise their project in.\n${out}`);
  }
  const leak = RUN_ID_SHAPE.exec(out);
  assert.equal(leak, null,
    `${what} printed something shaped like a run id (${leak?.[0]}). The offer addresses `
    + `projects by directory, exactly as /mubit-memory:link does.\n${out}`);
}

/** The steer block of a healthy session start in `projectDir`. */
async function startIn(dataDir, server, projectDir, over = {}) {
  const r = await runHook('session-start',
    fx.sessionStart({ cwd: projectDir, ...over }),
    { env: envIn(dataDir, server.url, projectDir) });
  assertHookContract(r);
  return r;
}

// §6 Tier 2: the offer itself. The far end is deliberately NOT a git repository — its remote
// can only have come off the session record, so a version that shells out per candidate
// cannot pass this, warm FS or cold.
test('a second project on the same remote is offered, by directory and relative date', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const here = makeProjectDir({ git: true, remote: REMOTE });
  const there = makeProjectDir();
  seedProject(dataDir, 'sess-pricing', {
    run_id: 'cc-pricing-1a2b3c4d',
    project_dir: there,
    git_remote: REMOTE,
    last_seen_at: Date.now() - (2 * DAY),
  });

  const r = await startIn(dataDir, server, here);
  const section = linkSection(r.json.hookSpecificOutput.additionalContext);

  assert.ok(section, 'a second checkout of the same repository is exactly when the question '
    + `becomes real; nothing was offered:\n${r.json.hookSpecificOutput.additionalContext}`);
  assert.ok(section.includes(there),
    `the offer must name the other project's directory, got:\n${section}`);
  assert.match(section, /2d ago/,
    `a project last opened two days ago reads "2d ago" — SC-09 shipped "just now" here by `
    + `letting the wrong timestamp win, got:\n${section}`);
  assert.doesNotMatch(section, /just now/,
    'the date comes from the far end\'s last_seen_at, not from the clock or the ledger');
  assert.match(section, /\/mubit-memory:link/,
    'an offer that does not name the command that accepts it is a notification, not an offer');
  assertNoRunIds(section, ['cc-pricing-1a2b3c4d'], 'the Tier 2 offer');
});

// The other half of the signal, and the case a naive equality check gets wrong in the other
// direction: a remote that is not this repository's is not a match.
test('a project with a different origin is not offered', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const here = makeProjectDir({ git: true, remote: REMOTE });
  seedProject(dataDir, 'sess-other', {
    run_id: 'cc-unrelated-9a8b7c6d',
    project_dir: makeProjectDir(),
    git_remote: 'git@github.com:acme/unrelated.git',
    last_seen_at: Date.now() - DAY,
  });

  const r = await startIn(dataDir, server, here);

  assert.equal(linkSection(r.json.hookSpecificOutput.additionalContext), '',
    'two projects with different remotes are two projects; proposing a link between them is '
    + 'the nag §6 says must never appear on a machine where the question does not apply');
});

// `test/link.test.mjs` learned this the same way: two directories that are not repositories
// both answer `''`, and calling that a match would group every scratch directory on the box.
test('two projects with no remote are not "the same remote"', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const here = makeProjectDir({ git: true });
  seedProject(dataDir, 'sess-scratch', {
    run_id: 'cc-scratch-5f6e7d8c',
    project_dir: makeProjectDir(),
    git_remote: '',
    last_seen_at: Date.now() - DAY,
  });

  const r = await startIn(dataDir, server, here);

  assert.equal(linkSection(r.json.hookSpecificOutput.additionalContext), '',
    'a repository with no origin has no group; matching blank against blank would offer to '
    + 'link every unrelated directory on the machine to every other');
});

/*
 * "Proposed once, and the answer remembered either way" (§6 Tier 2) — where "once" is now
 * `OFFER_LIMIT` renders rather than one, because a headless session renders a preamble no
 * human sees and must not answer on their behalf.
 *
 * What has to hold either way, and what this test is really for: the count and the decision
 * belong to the PAIR, not to a session or a side. Sessions in `there` and `here` draw down the
 * SAME budget, and when it runs out both go quiet together. A counter stored per session — or
 * per direction — would let each project ask its own three times, which is six, from a user
 * who was asked once too often at three.
 *
 * Real sessions in two real repositories, and no hand-written run ids: the ids are the ones
 * this machine derives, which is the only way the pair under test is the pair the plugin
 * actually formed.
 */
test('the offer budget and the decision both belong to the pair', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const here = makeProjectDir({ git: true, remote: REMOTE });
  const there = makeProjectDir({ git: true, remote: REMOTE });

  // Session 1, in `there`: nothing else on this machine shares the remote yet.
  const first = await startIn(dataDir, server, there, { session_id: 'sess-there-1' });
  assert.equal(linkSection(first.json.hookSpecificOutput.additionalContext), '',
    'the first project on a machine has nothing to be offered; §6\'s signal is self-timing');

  // Session 2, in `here`: now there are two, and the offer fires.
  const second = await startIn(dataDir, server, here, { session_id: 'sess-here-1' });
  assert.ok(linkSection(second.json.hookSpecificOutput.additionalContext).includes(there),
    'the second checkout is the moment the question becomes real');

  // Session 3, back in `there`, under a new host session id. It draws down the SAME budget:
  // this is offer 2 of 3, not offer 1 of a fresh allowance belonging to the other project.
  const third = await startIn(dataDir, server, there, { session_id: 'sess-there-2' });
  assert.ok(linkSection(third.json.hookSpecificOutput.additionalContext).includes(here),
    'the far project asks about the near one, from the other side of the same undecided pair');

  // Session 4, in `here` again: offer 3 of 3, which exhausts it.
  const fourth = await startIn(dataDir, server, here, { session_id: 'sess-here-2' });
  assert.ok(linkSection(fourth.json.hookSpecificOutput.additionalContext).includes(there),
    'the third render is still a question; the budget is spent by making it, not before');

  // Session 5, in `there`: spent, from the side that did not spend the last one.
  const fifth = await startIn(dataDir, server, there, { session_id: 'sess-there-3' });
  assert.equal(linkSection(fifth.json.hookSpecificOutput.additionalContext), '',
    'the count belongs to the pair, not to a side — if each project had its own budget the '
    + 'user would be asked six times, and §6 says once');

  // And session 6, in `here`, for the same reason from the same side.
  const sixth = await startIn(dataDir, server, here, { session_id: 'sess-here-3' });
  assert.equal(linkSection(sixth.json.hookSpecificOutput.additionalContext), '',
    'an offer that fires every SessionStart for the rest of the install\'s life is the nag '
    + '§6 Tier 2 exists to avoid');

  // The ledger says the same thing, at both ends and in the vocabulary `lib/links.mjs` owns.
  const config = await lib('config.mjs');
  const links = await lib('links.mjs');
  const cfg = config.loadConfig(envIn(dataDir, server.url, here));
  const hereRun = readJsonFile(join(dataDir, 'sessions', 'sess-here-1.json')).run_id;
  const thereRun = readJsonFile(join(dataDir, 'sessions', 'sess-there-1.json')).run_id;
  assert.equal(links.linkDecision(cfg, hereRun, thereRun)?.decision, 'declined',
    'an offer with nowhere to record "no" fires forever; this is the record');
  assert.equal(links.linkDecision(cfg, thereRun, hereRun)?.decision, 'declined',
    'both ends, or the same offer is simply made again from the other project');
});

// The third state `linkDecision` distinguishes, and the one a user reaches on purpose: these
// two are already linked, so there is nothing to propose. `null` means ask; `linked` and
// `declined` are both answers, and only one of them is a refusal.
test('a pair that is already linked is not offered', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const here = makeProjectDir({ git: true, remote: REMOTE });
  const there = makeProjectDir();
  seedProject(dataDir, 'sess-pricing', {
    run_id: 'cc-pricing-1a2b3c4d', project_dir: there, git_remote: REMOTE,
  });

  // The run id this project derives, taken the way `mcp/src/launch.mjs` takes it: an empty
  // payload, which writes no session record and therefore arranges nothing.
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const links = await lib('links.mjs');
  const env = envIn(dataDir, server.url, here);
  const cfg = config.loadConfig(env);
  const hereRun = withEnv(env, () => runid.deriveRunId(cfg, {}));
  links.recordLink(cfg, { runId: hereRun, projectDir: here },
    { runId: 'cc-pricing-1a2b3c4d', projectDir: there });

  const r = await startIn(dataDir, server, here);

  assert.equal(linkSection(r.json.hookSpecificOutput.additionalContext), '',
    'offering a link that is already in force tells the user their own decision did not '
    + 'take; `list` is where a standing link is shown, not the session preamble');
});

/*
 * §4.3/I5 and §6 Tier 2 can both be true of one session — a `/clear` in a repo that shares a
 * remote — and they are one command with two different targets. Two unrelated paragraphs both
 * saying "run /mubit-memory:link" is how a model ends up running the wrong one, so they share
 * a section and the section says which is which.
 */
test('a cleared session in a shared repo says both things, under one heading', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const here = makeProjectDir({ git: true, remote: REMOTE });
  const there = makeProjectDir();
  seedProject(dataDir, 'sess-pricing', {
    run_id: 'cc-pricing-1a2b3c4d',
    project_dir: there,
    git_remote: REMOTE,
    last_seen_at: Date.now() - (2 * DAY),
  });
  seedProject(dataDir, fx.SESSION_ID, {
    run_id: 'cc-here-0f0f0f0f', project_dir: here, project_root: here, git_remote: REMOTE,
  });

  const r = await startIn(dataDir, server, here, { source: 'clear' });
  const ctx = r.json.hookSpecificOutput.additionalContext;
  const section = linkSection(ctx);

  assert.equal(ctx.split(LINK_HEADING).length - 1, 1,
    `both notices are about what this run can reach, so they share one section:\n${ctx}`);
  assert.match(section, /reset by \/clear/i,
    `the cleared session still has to be told why its run is empty:\n${section}`);
  assert.ok(section.includes(there),
    `and the offer still has to name the project it is proposing:\n${section}`);
  assertNoRunIds(section, ['cc-pricing-1a2b3c4d', 'cc-here-0f0f0f0f'], 'the combined section');
});

// §12.1-F14 / `lib/hook.mjs` discipline: the scan is over a directory of files this plugin
// wrote, but it is still I/O on the spawn path, and every kind of damage found there costs the
// offer and nothing else. A session that fails to start because a session file was truncated
// by a SIGKILL is a far worse bug than a missing prompt.
test('damage in the session map costs the offer, never the session', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const here = makeProjectDir({ git: true, remote: REMOTE });
  const there = makeProjectDir();
  const sessions = join(dataDir, 'sessions');
  writeFileSync(join(sessions, 'torn.json'), '{"run_id": "cc-torn-11112222", "project_di');
  writeFileSync(join(sessions, 'empty.json'), '');
  writeFileSync(join(sessions, 'array.json'), '[1,2,3]');
  mkdirSync(join(sessions, 'directory.json'), { recursive: true });
  seedProject(dataDir, 'sess-pricing', {
    run_id: 'cc-pricing-1a2b3c4d', project_dir: there, git_remote: REMOTE,
  });

  const r = await startIn(dataDir, server, here);

  assert.ok(linkSection(r.json.hookSpecificOutput.additionalContext).includes(there),
    'a readable record next to four broken ones is still a readable record');
  assert.equal(r.code, 0, 'no shape of damage in the data dir may fail this hook (§4.9)');
});

// §5.1 — the offer reads files the hook's own derivation already wrote and dials nothing, so
// it may not move the sub-budgets. Measured with the offer actually firing: a resample against
// an empty data dir would measure the path where there is nothing to offer.
test('the same-remote offer stays inside the SessionStart budget', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const here = makeProjectDir({ git: true, remote: REMOTE });
  const there = makeProjectDir();
  const sample = async () => {
    const dataDir = makeDataDir();
    seedProject(dataDir, 'sess-pricing', {
      run_id: 'cc-pricing-1a2b3c4d', project_dir: there, git_remote: REMOTE,
    });
    return runHook('session-start', fx.sessionStart({ cwd: here }),
      { env: envIn(dataDir, server.url, here) });
  };

  const r = await sample();
  assertHookContract(r);
  assert.ok(linkSection(r.json.hookSpecificOutput.additionalContext).includes(there),
    'the measurement only means something if the offer fired on the run being measured');

  await assertWithinBudget('session-start --link-offer', 3200, r.ms,
    async () => (await sample()).ms);
});

// SC-10, found by driving the built hook headlessly. The offer's decline was written the
// moment the offer was RENDERED, so one `claude --print` — CI, a script, or the testkit's own
// `checkArms`, which starts two headless sessions on every preflight — consumed it for good.
// Nobody was there to read the preamble, and the pair is answered forever.
//
// "Silence is the no" is right for a human who saw the question. It is not an answer from a
// session that had no human in it, and the hook cannot tell those apart: there is no
// interactivity signal on a SessionStart payload. So an offer is counted, and only a pair that
// has been offered OFFER_LIMIT times reads as declined.
test('an offer nobody could have seen does not answer for the user', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const here = makeProjectDir({ git: true, remote: REMOTE });
  seedProject(dataDir, 'sess-far', {
    run_id: 'cc-faraway-5e6f7a8b',
    project_dir: makeProjectDir(),
    git_remote: REMOTE,
    last_seen_at: Date.now() - (2 * DAY),
  });

  const first = linkSection((await startIn(dataDir, server, here)).json.hookSpecificOutput.additionalContext);
  assert.ok(first, 'the first session in a second checkout is exactly when the question becomes real');

  const second = linkSection((await startIn(dataDir, server, here)).json.hookSpecificOutput.additionalContext);
  assert.ok(second, 'one unattended render must not answer for a human who was never shown it — '
    + 'the testkit alone starts two headless sessions per preflight, and each would burn one');

  await startIn(dataDir, server, here);
  const fourth = linkSection((await startIn(dataDir, server, here)).json.hookSpecificOutput.additionalContext);
  assert.equal(fourth, '', 'it still has to stop: an offer that returns every session is the nag '
    + '§6 says it must never become');
});
