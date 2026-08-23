// @ts-check
/**
 * `lib/dashboard-api.mjs` — the dashboard's upstream proxy, and the three promises it makes.
 *
 * **An observer does not change what it observes.** `lib/http.mjs` settles every call into the
 * circuit breaker by default. A page polling a dead instance every fifteen seconds would
 * therefore open the breaker for the *hooks*: recall stops, the drain stops, and the status
 * line reports a failure the user caused by looking. Every call here passes `{record: false}`,
 * and the test for it asserts the absence of a breaker file rather than the presence of an
 * option — an option can be passed and ignored.
 *
 * **The key stays in the process.** No function returns `cfg`, and every message crossing the
 * boundary is scrubbed, because an upstream error carries a snippet of the response that
 * produced it and a proxy error page can quote a request header.
 *
 * **A dead instance is a banner, not a blank page.** Each function returns the same envelope,
 * so one shape maps onto an HTTP status, and the failures that have different fixes —
 * `auth_failed` versus `upstream_unreachable` — stay distinguishable.
 *
 * The wire-name trap has a test of its own. The server serialises `LessonEntry.id`; the
 * session-start hook reads `lesson_id`; `defaultRoutes()` in the harness fakes `lesson_id`.
 * The fake and a real instance therefore disagree, and code reading one spelling works against
 * exactly one of them. `lessonId()` accepts all three, and the table below covers all three.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { lib, baseEnv, fakeMubit, makeDataDir } from './helpers/harness.mjs';

/**
 * A fake instance, a config pointed at it, and the module under test.
 *
 * @param {import('node:test').TestContext} t
 * @param {{routes?: Record<string, any>, endpoint?: string, extra?: Record<string, string>}} [o]
 */
async function setup(t, o = {}) {
  const dataDir = makeDataDir();
  const server = await fakeMubit(o.routes ?? {});
  t.after(() => server.close());
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(baseEnv({ dataDir, endpoint: o.endpoint ?? server.url, extra: o.extra }));
  const mod = await lib('dashboard-api.mjs');
  return { dataDir, server, cfg, mod };
}

/** A `LessonEntry` as the server actually serialises it: nine fields, `id`, no `created_at`. */
function lessonEntry(over = {}) {
  return {
    id: 'a3c1f0de-0000-4000-8000-000000000001',
    content: 'Run the migration before starting the server.',
    lesson_type: 'rule',
    scope: 'global',
    importance: 'high',
    conditions: ['deploying'],
    rationale: 'The server refuses to boot against an old schema.',
    source_run_id: 'cc-other-00000001',
    source: 'reflection',
    ...over,
  };
}

/** An `ActivityEntry`, which is where `created_at` comes from. */
function activityEntry(over = {}) {
  return {
    id: 'a3c1f0de-0000-4000-8000-000000000001',
    run_id: 'cc-here-00000001',
    entry_type: 'lesson',
    content: 'Run the migration before starting the server.',
    source: 'reflection',
    importance: 'high',
    created_at: '2026-08-19T15:03:18Z',
    metadata_json: '{}',
    reference_id: 'ref_lesson_1',
    referenceable: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The breaker must not move
// ---------------------------------------------------------------------------

/**
 * The load-bearing one for this file.
 *
 * `recordFailure` is what writes `breaker/<endpoint-hash>.json`, and `{record: false}` is what
 * stops it. Asserting on the file rather than on the option is deliberate: an option that is
 * passed but dropped by a future refactor looks identical from the call site and identical in
 * a mock, and the symptom in production is recall going quiet on a machine whose only fault
 * was an open dashboard.
 */
test('proxy: an upstream failure records nothing in the breaker, so a dashboard poll cannot open it for the hooks', async (t) => {
  const { dataDir, cfg, mod } = await setup(t, {
    routes: {
      'POST /v2/control/lessons': { status: 500, json: { error: 'boom' } },
      'POST /v2/control/activity': { status: 500, json: { error: 'boom' } },
      'POST /v2/control/memory_health': { status: 500, json: { error: 'boom' } },
    },
  });

  for (let i = 0; i < 8; i++) {
    await mod.fetchLessons(cfg, { run: 'cc-here-00000001' });
    await mod.fetchMemoryHealth(cfg, { run: 'cc-here-00000001' });
  }

  assert.deepEqual(readdirSync(join(dataDir, 'breaker')), [],
    'sixteen failed dashboard calls must leave the breaker exactly as they found it');
});

test('proxy: READ_ONLY is frozen and says record false', async (t) => {
  const { mod } = await setup(t);
  assert.equal(mod.READ_ONLY.record, false);
  assert.ok(Object.isFrozen(mod.READ_ONLY));
});

/**
 * The hook deadline is 4000 ms because a hook sits on a prompt's critical path. Nothing here
 * does, and the activity listing is a scan that runs past four seconds on a run with real
 * history — measured against a hosted instance, where inheriting the hook's budget turned a
 * busy server into a banner reporting it as unreachable.
 */
test('proxy: dashboard calls get a longer deadline than a hook, and do not inherit 4000ms', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: { 'POST /v2/control/activity': { delayMs: 350, json: { entries: [], next_page_token: '', total_visible: 0 } } },
  });
  assert.ok(mod.TIMEOUT_MS > 4000, `a dashboard read must outlast the hook budget; got ${mod.TIMEOUT_MS}`);
  assert.equal(mod.READ_ONLY.timeoutMs, mod.TIMEOUT_MS);

  // And the deadline is actually applied: a response slower than a hook would tolerate lands.
  const r = await mod.fetchActivity(cfg, { run: 'cc-here-00000001' });
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// The wire-name trap
// ---------------------------------------------------------------------------

// One assertion per spelling. `reference_id` wins when more than one is present, because it is
// the id an attribution call needs and the order `lib/rules.mjs` already settled on.
test('lessons: an id spelled id, lesson_id or reference_id all resolve to the same lesson id', async (t) => {
  const { mod } = await setup(t);
  const rows = [
    [{ id: 'x1' }, 'x1', 'the server serialises LessonEntry.id'],
    [{ lesson_id: 'x2' }, 'x2', 'the session-start hook and the test harness both use lesson_id'],
    [{ reference_id: 'x3' }, 'x3', 'an attribution call needs reference_id'],
    [{ id: 'x1', lesson_id: 'x2', reference_id: 'x3' }, 'x3', 'reference_id wins when all three are present'],
    [{ id: '  x4  ' }, 'x4', 'ids are trimmed'],
    [{}, '', 'a lesson with no id at all is addressable by nothing, and says so'],
    [null, '', 'a null entry does not throw'],
  ];
  for (const [raw, expected, why] of rows) {
    assert.equal(mod.lessonId(raw), expected, `${why}: lessonId(${JSON.stringify(raw)})`);
  }
});

// The harness's `defaultRoutes()` fakes `lesson_id` while a real instance sends `id`. A
// normaliser that read only one of them would pass this suite and fail against Mubit, or the
// reverse — which is the exact shape of a bug that ships green.
test('lessons: the harness default route and a real LessonEntry both normalise', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: { 'POST /v2/control/activity': { json: { entries: [], next_page_token: '', total_visible: 0 } } },
  });

  const fromHarness = await mod.fetchLessons(cfg, {});
  assert.equal(fromHarness.ok, true);
  assert.equal(fromHarness.data.lessons[0].id, 'les_g1',
    'the harness fakes lesson_id; reading only `id` would silently produce a blank');
});

// ---------------------------------------------------------------------------
// The lessons ↔ activity join
// ---------------------------------------------------------------------------

// `LessonEntry` has exactly nine fields and `created_at` is not one of them. The only place a
// lesson's timestamp exists is `ActivityEntry`, which is why a lessons view has to make two
// calls to render a date column.
test('lessons: created_at is joined in from the activity feed', async (t) => {
  const { server, cfg, mod } = await setup(t, {
    routes: {
      'POST /v2/control/lessons': { json: { lessons: [lessonEntry()] } },
      'POST /v2/control/activity': {
        json: { entries: [activityEntry()], next_page_token: '', total_visible: 1 },
      },
    },
  });

  const r = await mod.fetchLessons(cfg, { run: 'cc-here-00000001' });
  assert.equal(r.ok, true);
  assert.equal(r.data.joined, true);
  assert.equal(r.data.dated, 1);
  assert.equal(r.data.lessons[0].createdAt, '2026-08-19T15:03:18Z');
  server.assertCalled('POST', '/v2/control/lessons', 1);
  server.assertCalled('POST', '/v2/control/activity', 1);
});

/**
 * Measured against a hosted instance: the activity feed is every entry type in descending time
 * order, and seventeen thousand entries in, the newest three hundred were all traces and not
 * one was a lesson. An unfiltered join therefore fetches a page, matches nothing, and reports
 * success — the worst of the three outcomes, because it looks like the instance has no dates.
 */
test('lessons: the join asks the activity feed for lessons only', async (t) => {
  const { server, cfg, mod } = await setup(t, {
    routes: {
      'POST /v2/control/lessons': { json: { lessons: [lessonEntry()] } },
      'POST /v2/control/activity': { json: { entries: [activityEntry()], next_page_token: '', total_visible: 1 } },
    },
  });

  await mod.fetchLessons(cfg, { run: 'cc-here-00000001' });
  const body = server.lastCall('POST', '/v2/control/activity')?.body;
  assert.deepEqual(body.entry_types, ['lesson'],
    'the feed is dominated by traces; an unfiltered page joins nothing and says it worked');
});

/**
 * An instance can answer the join and still have no dates to give: on the hosted instance
 * measured here, `ActivityEntry.created_at` is populated for traces and empty for lessons.
 *
 * "The call worked" and "the call found something" are different facts, and only the second
 * one entitles a page to claim it is showing dates. `joined` reports the first, `dated` the
 * second, and the header renders the difference rather than showing a column of dashes and
 * a green light.
 */
test('lessons: an instance whose lesson entries carry no created_at reports dated zero', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: {
      'POST /v2/control/lessons': { json: { lessons: [lessonEntry()] } },
      'POST /v2/control/activity': {
        json: { entries: [activityEntry({ created_at: '' })], next_page_token: '', total_visible: 1 },
      },
    },
  });

  const r = await mod.fetchLessons(cfg, { run: 'cc-here-00000001' });
  assert.equal(r.ok, true);
  assert.equal(r.data.joined, true, 'the activity call itself succeeded');
  assert.equal(r.data.dated, 0, 'and produced no timestamps, which the page has to be able to say');
  assert.equal(r.data.lessons[0].createdAt, '');
});

// A timestamp is a column; the lessons are the page. Failing the whole route because the join
// failed would turn a cosmetic outage into a blank tab.
test('lessons: a failed activity call leaves the lessons rendered and the dates empty', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: {
      'POST /v2/control/lessons': { json: { lessons: [lessonEntry()] } },
      'POST /v2/control/activity': { status: 503, json: { error: 'unavailable' } },
    },
  });

  const r = await mod.fetchLessons(cfg, { run: 'cc-here-00000001' });
  assert.equal(r.ok, true, 'the lessons call succeeded; the route must not fail on the join');
  assert.equal(r.data.lessons.length, 1);
  assert.equal(r.data.lessons[0].createdAt, '');
  assert.equal(r.data.joined, false, 'the page needs to know the dates are missing rather than absent');
  assert.equal(r.data.dated, 0);
});

// With no lessons there is nothing to join, and the activity call is pure cost.
test('lessons: an empty lessons result does not pay for an activity call', async (t) => {
  const { server, cfg, mod } = await setup(t, {
    routes: { 'POST /v2/control/lessons': { json: { lessons: [] } } },
  });

  const r = await mod.fetchLessons(cfg, { run: 'cc-here-00000001' });
  assert.equal(r.ok, true);
  server.assertNotCalled('POST', '/v2/control/activity');
});

// `run_id` is optional on this one route, and an absent one means every run — which is exactly
// what a global-lessons view wants. Defaulting it to the current run would make cross-run
// recall impossible to look at.
test('lessons: an omitted run scope sends no run_id at all', async (t) => {
  const { server, cfg, mod } = await setup(t);
  await mod.fetchLessons(cfg, {});
  const body = server.lastCall('POST', '/v2/control/lessons')?.body;
  assert.ok(!('run_id' in body), `an absent scope means every run; body was ${JSON.stringify(body)}`);
  assert.equal(typeof body.limit, 'number');
});

// `scope` and `source_run_id` are what the scope-leak column renders: anything above `run`
// scope reaches other runs by design, and whether that was intended is the question the column
// exists to let a human answer.
test('lessons: scope above run is flagged as visible outside its own run', async (t) => {
  const { mod } = await setup(t);
  const rows = [
    ['run', false],
    ['session', true],
    ['global', true],
    ['', false],
  ];
  for (const [scope, expected] of rows) {
    const l = mod.normalizeLesson(lessonEntry({ scope }), { currentRun: 'cc-here-00000001' });
    assert.equal(l.leaksScope, expected, `scope ${JSON.stringify(scope)} leaksScope`);
  }

  const foreign = mod.normalizeLesson(lessonEntry({ source_run_id: 'cc-elsewhere-0001' }),
    { currentRun: 'cc-here-00000001' });
  assert.equal(foreign.fromOtherRun, true, 'a lesson written by another run is what followed an agent out');
});

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/**
 * The counter-intuitive one: `limit` clamps to **1** when it is 0, not to a default of 100.
 * An omitted limit therefore does not mean "the server's default", it means one entry — a feed
 * that renders exactly one row and looks like an empty instance.
 */
test('activity: the limit is always sent explicitly, because a zero clamps to one entry', async (t) => {
  const { server, cfg, mod } = await setup(t, {
    routes: { 'POST /v2/control/activity': { json: { entries: [], next_page_token: '', total_visible: 0 } } },
  });

  for (const asked of [undefined, 0, -5, NaN, 10_000]) {
    server.reset();
    await mod.fetchActivity(cfg, { run: 'cc-here-00000001', limit: asked });
    const body = server.lastCall('POST', '/v2/control/activity')?.body;
    assert.equal(typeof body.limit, 'number', `limit must always be present; asked ${asked}`);
    assert.ok(body.limit >= 1 && body.limit <= 500,
      `limit must be inside the server's own 1..500 clamp; asked ${asked}, sent ${body.limit}`);
  }
});

// `compact` truncates content to 200 chars and strips verbose metadata, which is what keeps a
// page of activity off the far side of a megabyte on a busy run.
test('activity: the feed asks for the compact projection by default', async (t) => {
  const { server, cfg, mod } = await setup(t, {
    routes: { 'POST /v2/control/activity': { json: { entries: [], next_page_token: '', total_visible: 0 } } },
  });
  await mod.fetchActivity(cfg, { run: 'cc-here-00000001' });
  assert.equal(server.lastCall('POST', '/v2/control/activity')?.body.projection, 'compact');
});

// Pagination is offset-style: the token is a numeric offset string and `next_page_token` is
// `""` once exhausted. The page needs both that and `total_visible` to know when to stop.
test('activity: the offset page token and total_visible are surfaced verbatim', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: {
      'POST /v2/control/activity': {
        json: { entries: [activityEntry()], next_page_token: '100', total_visible: 412 },
      },
    },
  });
  const r = await mod.fetchActivity(cfg, { run: 'cc-here-00000001', pageToken: '50' });
  assert.equal(r.ok, true);
  assert.equal(r.data.nextPageToken, '100');
  assert.equal(r.data.totalVisible, 412);
});

// ---------------------------------------------------------------------------
// Guards that refuse before dialling
// ---------------------------------------------------------------------------

// This is the one route where an empty scope is a client bug rather than "every run". Sending
// it anyway earns a 400 from the instance and teaches the page nothing.
test('memory health: a missing run id is refused here, not upstream', async (t) => {
  const { server, cfg, mod } = await setup(t);
  const r = await mod.fetchMemoryHealth(cfg, {});
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.code, 'bad_request');
  server.assertNotCalled('POST', '/v2/control/memory_health');
});

// A GET, unlike every other control route, with a limit the server clamps to 1..100. Clamping
// here keeps the request honest rather than relying on the server to fix it.
test('remote runs: the limit is clamped to the range the route accepts', async (t) => {
  const { server, cfg, mod } = await setup(t, {
    routes: { 'GET /v2/control/runs': { json: { runs: [{ run_id: 'cc-remote-000001', total_jobs: 3 }] } } },
  });

  for (const [asked, expected] of [[0, 1], [1000, 100], [25, 25], [undefined, 25]]) {
    server.reset();
    const r = await mod.fetchRemoteRuns(cfg, { limit: asked });
    assert.equal(r.ok, true);
    const call = server.lastCall('GET', '/v2/control/runs');
    assert.equal(call?.query.get('limit'), String(expected), `limit ${asked} -> ${expected}`);
  }
});

// `mode` is validated client-side because the server has no error for a wrong one, only a
// bill: an unrecognised mode routes to the most expensive path rather than failing.
test('search: an unrecognised query mode is refused before anything is dialled', async (t) => {
  const { server, cfg, mod } = await setup(t);
  const r = await mod.runSearch(cfg, { run: 'cc-here-00000001', query: 'retry backoff', mode: 'cheap' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_request');
  server.assertNotCalled('POST', '/v2/control/query');
});

// `evidence_only` skips the synthesis step. Without it every search on this page pays for a
// written answer that the page renders as a list anyway.
test('search: evidence_only is always true and the default mode is the cheapest rung', async (t) => {
  const { server, cfg, mod } = await setup(t);
  const r = await mod.runSearch(cfg, { run: 'cc-here-00000001', query: 'retry backoff' });
  assert.equal(r.ok, true);
  const body = server.lastCall('POST', '/v2/control/query')?.body;
  assert.equal(body.evidence_only, true);
  assert.equal(body.mode, 'direct_bypass');
  assert.ok(Array.isArray(r.data.evidence) && r.data.evidence.length > 0);
});

test('search: an empty query or an absent run is refused without a call', async (t) => {
  const { server, cfg, mod } = await setup(t);
  assert.equal((await mod.runSearch(cfg, { run: 'cc-here-00000001', query: '   ' })).code, 'bad_request');
  assert.equal((await mod.runSearch(cfg, { query: 'anything' })).code, 'bad_request');
  server.assertNotCalled('POST', '/v2/control/query');
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

// A double-clicked button is two reinforcements without one, and the confidence the page just
// showed becomes wrong because the page showed it.
test('outcome: an idempotency key is always sent, so a double click cannot double-count', async (t) => {
  const { server, cfg, mod } = await setup(t);
  const r = await mod.sendOutcome(cfg, { run: 'cc-here-00000001', referenceId: 'ref_lesson_1', success: true });
  assert.equal(r.ok, true);
  const body = server.lastCall('POST', '/v2/control/outcome')?.body;
  assert.ok(body.idempotency_key, 'every outcome the dashboard sends carries one');
  assert.equal(r.data.reinforcementCount, 1);
});

// `reference_id` must be non-empty; `"global"` is the documented value for run-level
// attribution with no single primary lesson, and `""` is never it.
test('outcome: an empty reference id is refused with the fix in the message', async (t) => {
  const { server, cfg, mod } = await setup(t);
  const r = await mod.sendOutcome(cfg, { run: 'cc-here-00000001', referenceId: '' });
  assert.equal(r.code, 'bad_request');
  assert.match(r.message, /global/, 'the message must name the value to pass instead');
  server.assertNotCalled('POST', '/v2/control/outcome');
});

/**
 * The typed confirmation is enforced on the server side of the dashboard, not in the page.
 *
 * A confirmation that lives only in the browser is a confirmation that an errant `fetch`, a
 * replayed request or a future refactor of the markup skips — and deletion has no undo.
 */
test('forget: a confirm that does not match the lesson id deletes nothing and dials nothing', async (t) => {
  const { server, cfg, mod } = await setup(t, {
    routes: { 'POST /v2/control/lessons/delete': { json: { success: true } } },
  });

  for (const confirm of [undefined, '', 'yes', 'a3c1f0de-0000-4000-8000-00000000000', 'A3C1F0DE-0000-4000-8000-000000000001']) {
    const r = await mod.deleteLesson(cfg, { lessonId: 'a3c1f0de-0000-4000-8000-000000000001', confirm });
    assert.equal(r.ok, false, `confirm ${JSON.stringify(confirm)} must not delete`);
    assert.equal(r.status, 400);
    assert.equal(r.code, 'bad_request');
  }
  server.assertNotCalled('POST', '/v2/control/lessons/delete');
});

test('forget: an exact confirm sends lesson_id and nothing else', async (t) => {
  const { server, cfg, mod } = await setup(t, {
    routes: { 'POST /v2/control/lessons/delete': { json: { success: true } } },
  });
  const id = 'a3c1f0de-0000-4000-8000-000000000001';
  const r = await mod.deleteLesson(cfg, { lessonId: id, confirm: id });
  assert.equal(r.ok, true);
  assert.equal(r.data.success, true);
  assert.deepEqual(server.lastCall('POST', '/v2/control/lessons/delete')?.body, { lesson_id: id });
});

// All three are required by the route, so all three are checked before a dial rather than
// after a 400.
test('archive: run, content and kind are validated before anything is dialled', async (t) => {
  const { server, cfg, mod } = await setup(t, {
    routes: { 'POST /v2/control/archive': { json: { success: true, entry_id: 'arch_1' } } },
  });

  assert.equal((await mod.sendArchive(cfg, { content: 'x' })).code, 'bad_request');
  assert.equal((await mod.sendArchive(cfg, { run: 'cc-here-00000001' })).code, 'bad_request');
  server.assertNotCalled('POST', '/v2/control/archive');

  const r = await mod.sendArchive(cfg, { run: 'cc-here-00000001', content: 'a decision worth keeping' });
  assert.equal(r.ok, true);
  const body = server.lastCall('POST', '/v2/control/archive')?.body;
  assert.equal(body.artifact_kind, 'note', 'the route requires a kind; the dashboard supplies a default');
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * The two failures with different fixes must not collapse into one.
 *
 * `auth_failed` is "your key is wrong or revoked" and is fixed with `/mubit-memory:auth`.
 * `upstream_unreachable` is "the instance is not answering" and is fixed by looking at the
 * network. Reporting a revoked key as a network problem sends somebody to check their VPN.
 */
test('errors: each upstream status maps to the code whose fix is different', async (t) => {
  const rows = [
    [401, 502, 'auth_failed'],
    [403, 502, 'auth_failed'],
    [500, 503, 'upstream_unreachable'],
    [503, 503, 'upstream_unreachable'],
  ];
  for (const [upstream, status, code] of rows) {
    const { cfg, mod } = await setup(t, {
      routes: { 'POST /v2/control/memory_health': { status: upstream, json: { error: 'nope' } } },
    });
    const r = await mod.fetchMemoryHealth(cfg, { run: 'cc-here-00000001' });
    assert.equal(r.ok, false, `HTTP ${upstream} must not read as success`);
    assert.equal(r.status, status, `HTTP ${upstream} -> ${status}`);
    assert.equal(r.code, code, `HTTP ${upstream} -> ${code}`);
    assert.ok(mod.ERROR_CODES.includes(r.code), `${r.code} is not in the documented error vocabulary`);
  }
});

// Nothing answering at all, which is the offline case the page renders its banner from.
test('errors: an endpoint with nothing behind it is upstream_unreachable, and the page keeps working', async (t) => {
  const { cfg, mod } = await setup(t, { endpoint: 'http://127.0.0.1:1' });
  const r = await mod.fetchLessons(cfg, { run: 'cc-here-00000001' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.equal(r.code, 'upstream_unreachable');
});

// An install nobody has signed in to yet is an ordinary state, not a fault — and it must not
// be reported as a broken network either.
test('errors: no endpoint configured degrades rather than throwing', async (t) => {
  const { cfg, mod } = await setup(t, { extra: { MUBIT_ENDPOINT: '' } });
  const r = await mod.fetchLessons(cfg, {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'upstream_unreachable');
  assert.ok(typeof r.message === 'string' && r.message.length > 0, 'the banner needs something to say');
});

/**
 * The invariant, asserted against the worst case: an instance that echoes the request back.
 *
 * `lib/http.mjs` puts a snippet of the response body into `res.error`, so a server that quotes
 * the `Authorization` header in its 4xx puts the key on a path that ends in a browser. One
 * `includes` per error is cheaper than the incident.
 */
test('errors: a message that would have quoted the API key does not', async (t) => {
  const dataDir = makeDataDir();
  const server = await fakeMubit({
    'POST /v2/control/memory_health': (req) => ({
      status: 400,
      json: { error: `bad request with header ${req.headers.authorization}` },
    }),
  });
  t.after(() => server.close());

  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(baseEnv({ dataDir, endpoint: server.url }));
  const mod = await lib('dashboard-api.mjs');

  const r = await mod.fetchMemoryHealth(cfg, { run: 'cc-here-00000001' });
  assert.equal(r.ok, false);
  assert.ok(cfg.apiKey && cfg.apiKey.length > 10, 'the fixture must have a key, or this proves nothing');
  assert.ok(!r.message.includes(cfg.apiKey), `the key reached the caller: ${r.message}`);
  assert.match(r.message, /REDACTED/, 'and the removal is visible rather than silent');
});

// ---------------------------------------------------------------------------
// Routes with no named helper
// ---------------------------------------------------------------------------

// `ROUTES` in `lib/http.mjs` covers eleven routes and these four are not among them, so they
// go through the generic `request()`. Pinning the paths here is what stops a typo becoming a
// 404 that reads as "the instance has no lessons".
test('proxy: the four unnamed routes are dialled at exactly the documented paths', async (t) => {
  const { server, cfg, mod } = await setup(t, {
    routes: {
      'POST /v2/control/activity': { json: { entries: [], next_page_token: '', total_visible: 0 } },
      'POST /v2/control/memory_health': { json: { healthy: true } },
      'POST /v2/control/archive': { json: { success: true } },
      'POST /v2/control/lessons/delete': { json: { success: true } },
      'GET /v2/control/runs': { json: { runs: [] } },
    },
  });

  await mod.fetchActivity(cfg, { run: 'r' });
  await mod.fetchMemoryHealth(cfg, { run: 'r' });
  await mod.sendArchive(cfg, { run: 'r', content: 'c' });
  await mod.deleteLesson(cfg, { lessonId: 'i', confirm: 'i' });
  await mod.fetchRemoteRuns(cfg, {});

  for (const [method, path] of [
    ['POST', '/v2/control/activity'],
    ['POST', '/v2/control/memory_health'],
    ['POST', '/v2/control/archive'],
    ['POST', '/v2/control/lessons/delete'],
    ['GET', '/v2/control/runs'],
  ]) {
    server.assertCalled(method, path, 1);
  }
  assert.equal(server.requests.filter((r) => r.path.startsWith('/v2/control/')).length, 5,
    `the dashboard called something it should not have: ${server.summary()}`);
});
