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
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  runHook, assertHookContract, fakeMubit, makeDataDir, makeProjectDir,
  baseEnv, readJsonFile,
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
  assert.match(ctx, /injected automatically/i);
  assert.match(ctx, /do not search/i);
  // The lesson section renders what /v2/control/lessons returned.
  assert.match(ctx, /standing lessons/i);
  assert.ok(ctx.includes('Run the migration'), `lesson content must render, got:\n${ctx}`);

  assert.match(r.json.systemMessage, /^mubit: hosted · run \S+ · \d+ global lessons?$/);
  assert.ok(r.json.systemMessage.includes(runId));
  assert.ok(!r.json.systemMessage.includes('\n'), 'systemMessage is one line');
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

// §4.3 `fork`: same rule as compact — the fork inherits the parent record's run.
test('source=fork reuses the parent session record run', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSessionRecord(dataDir, fx.SESSION_ID);

  const r = await runHook('session-start', fx.sessionStart({ source: 'fork', cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url) });
  assertHookContract(r);

  assert.deepEqual(outgoingRunIds(server), [MAPPED_RUN]);
});

// ---------------------------------------------------------------------------
// Degraded paths — §5.1 "Failure", §4.9 "never blocks"
// ---------------------------------------------------------------------------

// §5.1 step 4: health not ok -> skip register and lessons, but STILL steer, so the
// model knows memory is offline instead of inventing recall it never received.
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
  assert.ok(r.ms < 3200, `session-start took ${r.ms}ms, past its 2500ms internal budget`);
});
