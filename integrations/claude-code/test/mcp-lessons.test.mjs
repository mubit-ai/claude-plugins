// @ts-check
/**
 * What `mubit_lessons` actually reads.
 *
 * The tool takes an optional `session_id` and, alone among the read tools, resolves no
 * default for it: with the argument absent the bundled server sends `run_id: ""`. An empty
 * run id is not "no filter applied at the client" — it is a value the control plane reads as
 * "every run this key can see", so the catalogue a model was shown came back from runs that
 * had nothing to do with the one it was working in, in no particular order, cut off at
 * whatever the row limit happened to be.
 *
 * The tool's schema cannot be changed: it lives in a vendored bundle this repo cannot
 * rebuild. So the correction goes where every other correction to that bundle goes — the
 * `globalThis.fetch` wrapper the launcher installs before it imports the server.
 *
 * These tests assert on the **wire and the answer**, never on the mechanism. `mcpCallTool`
 * runs the shipped `mcp/dist/index.js` for real against a `fakeMubit`, so a future rebuild
 * that resolves the run id upstream passes these unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeMubit, mcpCallTool, mod } from './helpers/harness.mjs';

/** The run the launcher derives for these tests. Pinned, so "whose lesson is this" is never a guess. */
const RUN = 'cc-lessons-test-run';

/** A different run on the same key — the one whose rows must not leak into a default read. */
const OTHER = 'cc-someone-elses-run';

const E = () => mod('mcp/src/egress.mjs');

/**
 * One `ActivityEntry` as the feed serves it. Scope, type, importance, conditions and the
 * source run all live inside `metadata_json`; that nesting is the whole reason the census
 * has to ask for `projection: 'full'`.
 *
 * @param {{id: string, run: string, content: string, scope?: string, at?: string,
 *          type?: string, source?: string, sourceRun?: string, importance?: string}} o
 */
function lesson(o) {
  return {
    id: o.id,
    created_at: o.at ?? '2026-08-01T00:00:00Z',
    entry_type: 'lesson',
    run_id: o.run,
    content: o.content,
    source: o.source ?? `reflection:${o.run}`,
    metadata_json: JSON.stringify({
      scope: o.scope ?? 'run',
      lesson_type: o.type ?? 'rule',
      importance: o.importance ?? 'medium',
      conditions: ['when the daemon wedges'],
      rationale: 'measured twice',
      ...(o.sourceRun ? { source_run_id: o.sourceRun } : {}),
    }),
  };
}

/** A `fakeMubit` whose activity feed serves exactly these entries, in one page. */
function feed(entries, over = {}) {
  return {
    'POST /v2/control/activity': {
      json: { entries, next_page_token: '', total_visible: entries.length },
    },
    ...over,
  };
}

/**
 * Call `mubit_lessons` for real and hand back both halves: what the tool answered, and every
 * request the server made to answer it.
 *
 * @param {any} t
 * @param {Record<string, any>} args
 * @param {Record<string, any>} routes
 */
async function ask(t, args, routes) {
  const server = await fakeMubit(routes);
  t.after(() => server.close());
  // `mubit_lessons` left the default surface for `bin/admin.mjs`, so it is restored by name:
  // the guard on its route still has to hold for a user who does the same. The results guard
  // (`mcp/src/results.mjs`) would render the catalogue one line per lesson on the way out, so
  // it is switched off; these tests read the catalogue as the server answers it, and
  // `mcp-results.test.mjs` covers that rendering.
  const out = await mcpCallTool('mubit_lessons', args, {
    endpoint: server.url, runId: RUN,
    extra: { MUBIT_CC_MCP_RESULT_TOKENS: '0', MUBIT_MCP_TOOLS: 'mubit_lessons' },
  });
  return { server, out };
}

/** The `lessons` array the model was actually handed. */
function shown(out) {
  assert.ok(out.json, `mubit_lessons did not answer JSON:\n${out.text}`);
  assert.ok(Array.isArray(out.json.lessons), `no lessons array in:\n${out.text}`);
  return out.json.lessons;
}

// ---------------------------------------------------------------------------
// Where the answer comes from
// ---------------------------------------------------------------------------

// The headline. A default read used to dial the one route whose `limit` is applied before its
// filter, with the one run id that means "every run" — so it asked the wrong question of the
// wrong lane. It now asks the feed instead, and the feed collects and sorts before it pages.
test('a default read asks the activity feed, and never the lessons route', async (t) => {
  const { server } = await ask(t, {}, feed([
    lesson({ id: 'a', run: RUN, content: 'mine' }),
  ]));

  server.assertCalled('POST', '/v2/control/activity');
  server.assertNotCalled('POST', '/v2/control/lessons');
});

// The isolation property, stated as the thing a user would notice: somebody else's run-local
// lesson is not part of my catalogue, and mine is.
test('another run\'s run-scoped lesson is absent; my own is present', async (t) => {
  const { out } = await ask(t, {}, feed([
    lesson({ id: 'mine', run: RUN, content: 'MINE run-scoped' }),
    lesson({ id: 'theirs', run: OTHER, content: 'THEIRS run-scoped' }),
  ]));

  const contents = shown(out).map((l) => l.content);
  assert.ok(contents.includes('MINE run-scoped'), `own lesson missing from ${JSON.stringify(contents)}`);
  assert.ok(!contents.includes('THEIRS run-scoped'),
    `another run's run-scoped lesson leaked into the default read: ${JSON.stringify(contents)}`);
});

// A lesson that was deliberately widened is *supposed* to travel. Narrowing the default read
// must not also hide the lessons whose whole purpose is to be seen from elsewhere.
test('a lesson that escaped its run still shows in the default read', async (t) => {
  const { out } = await ask(t, {}, feed([
    lesson({ id: 'esc', run: OTHER, scope: 'global', content: 'ESCAPED global' }),
    lesson({ id: 'theirs', run: OTHER, content: 'THEIRS run-scoped' }),
  ]));

  const contents = shown(out).map((l) => l.content);
  assert.deepEqual(contents, ['ESCAPED global']);
});

// `scope` is the escape hatch the frozen schema already had: it is the only way for a caller
// to say "yes, I mean across runs".
test('scope:"global" returns another run\'s global lesson', async (t) => {
  const { out, server } = await ask(t, { scope: 'global' }, feed([
    lesson({ id: 'g', run: OTHER, scope: 'global', content: 'THEIRS global' }),
    lesson({ id: 'r', run: RUN, content: 'MINE run-scoped' }),
  ]));

  assert.deepEqual(shown(out).map((l) => l.content), ['THEIRS global']);
  server.assertNotCalled('POST', '/v2/control/lessons');
});

// `scope:"run"` means "just this run" — the escaped lessons drop out.
test('scope:"run" narrows to this run alone', async (t) => {
  const { out } = await ask(t, { scope: 'run' }, feed([
    lesson({ id: 'mine', run: RUN, content: 'MINE run-scoped' }),
    lesson({ id: 'esc', run: OTHER, scope: 'global', content: 'ESCAPED global' }),
    lesson({ id: 'theirs', run: OTHER, content: 'THEIRS run-scoped' }),
  ]));

  assert.deepEqual(shown(out).map((l) => l.content), ['MINE run-scoped']);
});

// The run id is spelled two ways on the two routes — bare on the feed's `run_id`, namespaced
// inside `metadata_json.source_run_id` — and a single comparison drops the caller's own rows.
test('a lesson of mine is mine under either spelling of the run id', async (t) => {
  const { out } = await ask(t, { scope: 'run' }, feed([
    lesson({ id: 'bare', run: RUN, content: 'BARE run_id' }),
    lesson({ id: 'nested', run: 'scoped-storage-key', sourceRun: RUN, content: 'NESTED source_run_id' }),
    lesson({ id: 'theirs', run: OTHER, sourceRun: OTHER, content: 'THEIRS' }),
  ]));

  const contents = shown(out).map((l) => l.content).sort();
  assert.deepEqual(contents, ['BARE run_id', 'NESTED source_run_id']);
});

// ---------------------------------------------------------------------------
// The false negative this replaces
// ---------------------------------------------------------------------------

// The regression test for the whole exercise. On the lessons route `limit` is applied before
// the scope filter, so `{scope:"global", limit:2}` over a busy instance means "take two
// arbitrary rows, keep whichever are global" — reliably zero, and indistinguishable from an
// instance that has never promoted anything. Filtering before limiting is the fix.
test('scope:"global" with a small limit finds the global lessons anyway', async (t) => {
  const entries = [];
  for (let i = 0; i < 30; i += 1) {
    const isGlobal = i === 11 || i === 22 || i === 29;
    entries.push(lesson({
      id: `e${i}`,
      run: OTHER,
      scope: isGlobal ? 'global' : 'run',
      content: isGlobal ? `GLOBAL ${i}` : `noise ${i}`,
      at: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));
  }

  const { out } = await ask(t, { scope: 'global', limit: 2 }, feed(entries));
  const rows = shown(out);

  assert.equal(rows.length, 2, `expected the limit to bite AFTER the filter, got ${rows.length}`);
  for (const r of rows) {
    assert.match(r.content, /^GLOBAL /, `a non-global row survived a scope:"global" read: ${r.content}`);
  }
  assert.equal(out.json.mubit_lessons_guard?.matched, 3,
    'the note must say how many actually matched, not just how many were shown');
});

// ---------------------------------------------------------------------------
// The shape of a row
// ---------------------------------------------------------------------------

// Newest first. A catalogue ordered by whatever the offset pager happened to hand back is a
// catalogue whose first row means nothing.
test('rows render newest first', async (t) => {
  const { out } = await ask(t, { scope: 'run' }, feed([
    lesson({ id: 'old', run: RUN, content: 'OLD', at: '2026-01-01T00:00:00Z' }),
    lesson({ id: 'new', run: RUN, content: 'NEW', at: '2026-08-01T00:00:00Z' }),
    lesson({ id: 'mid', run: RUN, content: 'MID', at: '2026-04-01T00:00:00Z' }),
  ]));

  assert.deepEqual(shown(out).map((l) => l.content), ['NEW', 'MID', 'OLD']);
});

// Without an id the model cannot pass a row on to `mubit_forget`, which makes the catalogue
// read-only in a way nothing tells it about.
test('every row carries an id the model can hand to mubit_forget', async (t) => {
  const { out } = await ask(t, {}, feed([
    lesson({ id: 'a1b2', run: RUN, content: 'mine' }),
  ]));

  const [row] = shown(out);
  assert.equal(row.lesson_id, 'a1b2');
  assert.equal(row.id, 'a1b2');
});

// The bundle's response compactor drops `id` and `source` from any row that also carries
// `entry_type` or `reference_id` — it reads those as evidence markers. The synthesized rows
// must therefore carry neither, and this pins the consequence rather than the cause.
test('a row carries the wire fields a lessons answer has, and no evidence markers', async (t) => {
  const { out } = await ask(t, {}, feed([
    lesson({ id: 'x', run: RUN, content: 'mine', type: 'failure', importance: 'high' }),
  ]));

  const [row] = shown(out);
  assert.equal(row.lesson_type, 'failure');
  assert.equal(row.scope, 'run');
  assert.equal(row.importance, 'high');
  assert.deepEqual(row.conditions, ['when the daemon wedges']);
  assert.equal(row.rationale, 'measured twice');
  assert.equal(row.source_run_id, RUN);
  assert.equal(row.source, `reflection:${RUN}`);
  assert.equal(row.entry_type, undefined, 'entry_type makes the compactor strip id and source');
  assert.equal(row.reference_id, undefined, 'reference_id makes the compactor strip id and source');
});

// ---------------------------------------------------------------------------
// When the caller has already been explicit
// ---------------------------------------------------------------------------

// A caller that named a run has asked a question the lessons route answers correctly: the run
// id is filled in, so the route's per-run branch applies and nothing needs correcting.
test('an explicit session_id dials the lessons route and skips the census', async (t) => {
  const { server } = await ask(t, { session_id: OTHER }, feed([]));

  server.assertCalled('POST', '/v2/control/lessons');
  server.assertNotCalled('POST', '/v2/control/activity');
  assert.equal(server.lastCall('POST', '/v2/control/lessons').body.run_id, OTHER);
});

// ---------------------------------------------------------------------------
// Failure is narrow, not wide
// ---------------------------------------------------------------------------

// Failing open would restore the defect at exactly the moment nobody can see it. A default
// read whose census died goes out with the run id FILLED IN, which is the narrow direction.
test('a dead feed falls back to a pinned request, not the wide one', async (t) => {
  const { server, out } = await ask(t, {}, feed([], {
    'POST /v2/control/activity': { status: 500, json: { error: 'boom' } },
  }));

  const req = server.lastCall('POST', '/v2/control/lessons');
  assert.ok(req, 'nothing was sent at all — the guard swallowed the read');
  assert.equal(req.body.run_id, RUN,
    'the fallback went out with the empty run id the bundle built — that is the defect, restored');
  assert.ok(out.json?.mubit_lessons_guard, 'a degraded answer must say it is degraded');
});

// The one exception. Silently narrowing a deliberate cross-run ask is the dishonest
// direction: the caller said "global", and a run-pinned request answers a different question.
test('an explicit cross-run ask whose census failed goes out unpinned, and says so', async (t) => {
  const { server, out } = await ask(t, { scope: 'global' }, feed([], {
    'POST /v2/control/activity': { status: 500, json: { error: 'boom' } },
  }));

  const req = server.lastCall('POST', '/v2/control/lessons');
  assert.ok(req, 'nothing was sent at all');
  assert.equal(req.body.run_id, '', 'a deliberate cross-run ask must not be quietly narrowed');
  assert.equal(req.body.scope, 'global');
  assert.ok(out.json?.mubit_lessons_guard, 'a degraded answer must say it is degraded');
});

// ---------------------------------------------------------------------------
// Truthfulness
// ---------------------------------------------------------------------------

// A count beside an admission of partiality is the number somebody acts on. So a census that
// gave up prints no total at all.
test('a truncated census says so, and names no total', async (t) => {
  // Two pages, and the second's token points back at the first — the liveness guard trips and
  // the scan reports itself short.
  const page = (entries, token) => ({
    json: { entries, next_page_token: token, total_visible: 999 },
  });
  const { out } = await ask(t, {}, {
    'POST /v2/control/activity': [
      page([lesson({ id: 'p1', run: RUN, content: 'first page' })], '1'),
      page([lesson({ id: 'p2', run: RUN, content: 'second page' })], '1'),
    ],
  });

  const note = out.json?.mubit_lessons_guard;
  assert.ok(note, 'a partial catalogue must say it is partial');
  assert.equal(note.partial, true);
  assert.equal(note.matched, undefined,
    'a total beside "this is partial" is the number somebody acts on');
  assert.match(String(note.note), /partial|incomplete|cut short|not all/i);
});

// A read is not a health signal. The census dials a route the breaker does not own, and a
// feed that is down must not close the circuit on the hooks running beside this process.
test('a census failure is not recorded against the circuit breaker', async (t) => {
  const { server } = await ask(t, {}, feed([], {
    'POST /v2/control/activity': { status: 500, json: { error: 'boom' } },
  }));

  // The health probe is the breaker's own route. A recorded failure would provoke one.
  server.assertNotCalled('GET', '/v2/core/health');
});

// ---------------------------------------------------------------------------
// The guard as a unit
// ---------------------------------------------------------------------------

test('isLessonsRead matches the catalogue route and not the delete route', async () => {
  const { isLessonsRead } = await E();
  const post = { method: 'POST' };

  assert.equal(isLessonsRead('https://api.example/v2/control/lessons', post), true);
  assert.equal(isLessonsRead('https://api.example/v2/control/lessons/', post), true);
  assert.equal(isLessonsRead(new URL('https://api.example/v2/control/lessons'), post), true);

  assert.equal(isLessonsRead('https://api.example/v2/control/lessons/delete', post), false,
    'mubit_forget posts here; answering it from a census would silently drop a deletion');
  assert.equal(isLessonsRead('https://api.example/v2/control/ingest', post), false);
  assert.equal(isLessonsRead('https://api.example/v2/control/lessons', { method: 'GET' }), false);
  assert.equal(isLessonsRead('not a url', post), false);
});

test('guardLessonsRead fills an empty run id and leaves a filled one alone', async () => {
  const { guardLessonsRead } = await E();

  const filled = guardLessonsRead({ run_id: '', limit: 20 }, { runId: RUN, pinRun: true });
  assert.equal(filled.changed, true);
  assert.equal(filled.body.run_id, RUN);
  assert.equal(filled.body.limit, 20, 'nothing but the run id may move');

  const already = { run_id: OTHER, limit: 20 };
  const kept = guardLessonsRead(already, { runId: RUN, pinRun: true });
  assert.equal(kept.changed, false);
  assert.equal(kept.body, already, 'an untouched body is returned by identity, not cloned');
});

// The SDK's transport backfills a run id only when the field is `== null`, so `?? ""` is
// precisely the spelling that defeats it. Filling the field is what the pin is.
test('guardLessonsRead treats an absent run id the same as an empty one', async () => {
  const { guardLessonsRead } = await E();

  const out = guardLessonsRead({ limit: 20 }, { runId: RUN, pinRun: true });
  assert.equal(out.changed, true);
  assert.equal(out.body.run_id, RUN);
});

// A deliberate cross-run ask is not pinned: pinning it would answer a different question from
// the one the caller asked, which is the failure the census exists to remove.
test('guardLessonsRead does not pin an explicit cross-run scope', async () => {
  const { guardLessonsRead } = await E();

  for (const scope of ['session', 'global']) {
    const out = guardLessonsRead({ run_id: '', scope, limit: 20 }, { runId: RUN, pinRun: true });
    assert.equal(out.changed, false, `scope:"${scope}" must not be narrowed to a single run`);
  }

  const run = guardLessonsRead({ run_id: '', scope: 'run', limit: 20 }, { runId: RUN, pinRun: true });
  assert.equal(run.changed, true, 'scope:"run" with no run id is exactly the case the pin is for');
  assert.equal(run.body.run_id, RUN);
});

test('guardLessonsRead is inert without a run id, and on a body it does not understand', async () => {
  const { guardLessonsRead } = await E();

  assert.equal(guardLessonsRead({ run_id: '' }, { runId: '', pinRun: true }).changed, false);
  assert.equal(guardLessonsRead({ run_id: '' }, { runId: RUN, pinRun: false }).changed, false);
  for (const body of [null, undefined, 'a string', 42, ['an', 'array']]) {
    const out = guardLessonsRead(body, { runId: RUN, pinRun: true });
    assert.equal(out.changed, false);
    assert.equal(out.body, body);
  }
});
