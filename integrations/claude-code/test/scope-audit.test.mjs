// @ts-check
/**
 * `scripts/scope-audit.mjs` — what is stored, at what scope, and who wrote it.
 *
 * This script used to ask the catalogue route with a deliberately empty run id, which is the
 * same request that made `mubit_lessons` read across runs — so the one tool whose whole
 * purpose was to *measure* that behaviour was riding on it. It also inherited that route's
 * other property: a request for rows at a named scope comes back short against a real
 * instance, so the audit read zero on an instance holding hundreds of lessons, and a zero
 * that means "the query was wrong" is indistinguishable from a zero that means "nothing has
 * ever been promoted".
 *
 * The rewrite is built on `lessonCensus()`, which reads the activity feed and reports when it
 * gave up. Two properties are load-bearing and both are pinned below:
 *
 *   1. **A truncated census exits non-zero and calls every count a floor.** A loop that reads
 *      this must not be able to treat a partial reading as a measurement.
 *   2. **"The instance stamped no promotion metadata" and "zero candidates" are different
 *      facts.** They have different causes and different fixes, and rendering them as the same
 *      `0` is how a measurement becomes a wrong conclusion.
 *
 * No real network: every test drives `main()` against `fakeMubit` with both streams captured.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { baseEnv, fakeMubit, makeDataDir, mod } from './helpers/harness.mjs';

const LIST_ROUTE = 'POST /v2/control/activity';
const LESSONS_ROUTE = 'POST /v2/control/lessons';

const RUN_A = 'cc-project-a-00000001';
const RUN_B = 'cc-project-b-00000002';

/**
 * One lesson as the activity feed serves it.
 * @param {{id: string, run: string, scope?: string, source?: string, at?: string,
 *          meta?: Record<string, any>}} o
 */
function lesson(o) {
  return {
    id: o.id,
    created_at: o.at ?? '2026-08-01T00:00:00Z',
    entry_type: 'lesson',
    run_id: o.run,
    content: `lesson ${o.id}`,
    source: o.source ?? `reflection:${o.run}`,
    metadata_json: JSON.stringify({
      scope: o.scope ?? 'run',
      lesson_type: 'rule',
      importance: 'medium',
      ...(o.meta ?? {}),
    }),
  };
}

const page = (entries, next = '') => ({
  json: { entries, next_page_token: next, total_visible: entries.length },
});

/**
 * A fake instance, an env pointed at it, and the script, with both streams captured.
 * @param {import('node:test').TestContext} t
 * @param {{routes?: Record<string, any>}} [o]
 */
async function audit(t, o = {}) {
  const server = await fakeMubit(o.routes ?? {});
  t.after(() => server.close());
  const env = baseEnv({ dataDir: makeDataDir(), endpoint: server.url });
  const script = await mod('scripts/scope-audit.mjs');

  /** @type {string[]} */ const out = [];
  /** @type {string[]} */ const err = [];
  const run = (argv = []) => script.main(argv, env, {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });

  return { server, run, stdout: () => out.join(''), stderr: () => err.join('') };
}

// ---------------------------------------------------------------------------
// Where it asks
// ---------------------------------------------------------------------------

// The headline. A measurement tool must not ride on the behaviour it exists to measure.
test('audit: reads the activity feed and never the catalogue route', async (t) => {
  const { server, run } = await audit(t, {
    routes: { [LIST_ROUTE]: page([lesson({ id: 'a', run: RUN_A })]) },
  });

  assert.equal(await run(), 0);
  server.assertCalled('POST', '/v2/control/activity');
  server.assertNotCalled('POST', '/v2/control/lessons');
});

test('audit: --help exits 0 and dials nothing', async (t) => {
  const { server, run, stdout } = await audit(t);

  assert.equal(await run(['--help']), 0);
  assert.match(stdout(), /--json/);
  assert.equal(server.requests.length, 0);
});

test('audit: an unknown flag exits 2 and dials nothing', async (t) => {
  const { server, run, stderr } = await audit(t);

  assert.equal(await run(['--nope']), 2);
  assert.match(stderr(), /unknown|usage/i);
  assert.equal(server.requests.length, 0);
});

// ---------------------------------------------------------------------------
// What it counts
// ---------------------------------------------------------------------------

test('audit: reports the scope distribution and the origin-run spread', async (t) => {
  const { run, stdout } = await audit(t, {
    routes: {
      [LIST_ROUTE]: page([
        lesson({ id: 'a1', run: RUN_A, scope: 'run' }),
        lesson({ id: 'a2', run: RUN_A, scope: 'run' }),
        lesson({ id: 'a3', run: RUN_A, scope: 'global' }),
        lesson({ id: 'b1', run: RUN_B, scope: 'session' }),
      ]),
    },
  });

  assert.equal(await run(['--json']), 0);
  const j = JSON.parse(stdout());

  assert.equal(j.total, 4);
  assert.deepEqual(j.byScope, { run: 2, global: 1, session: 1 });
  // "Visible outside the run that wrote it" is the number this audit exists to produce.
  assert.equal(j.escaped, 2);
  assert.equal(j.originRuns, 2);
  assert.equal(j.truncated, false);
});

// ---------------------------------------------------------------------------
// Promotion metadata, verbatim
// ---------------------------------------------------------------------------

// Emitted as it arrived, never summarised. Whatever an instance stamps here is what the
// question is about; rewriting it into this script's own vocabulary would put a layer of
// interpretation between the reader and the only evidence there is.
test('audit: emits the promotion metadata the instance stamped, verbatim', async (t) => {
  const { run, stdout } = await audit(t, {
    routes: {
      [LIST_ROUTE]: page([
        lesson({
          id: 'a1',
          run: RUN_A,
          meta: {
            promotion_candidate: true,
            promotion_quarantined: false,
            promotion_shadow_stats: { arm: 'treatment', n: 7, note: 'whatever the instance says' },
          },
        }),
        lesson({ id: 'a2', run: RUN_A }),
      ]),
    },
  });

  assert.equal(await run(['--json']), 0);
  const j = JSON.parse(stdout());

  assert.equal(j.promotion.stamped, 1, 'one of the two rows carried promotion metadata');
  assert.deepEqual(j.promotion.rows[0].promotion_shadow_stats,
    { arm: 'treatment', n: 7, note: 'whatever the instance says' },
    'the stats must arrive exactly as the instance stamped them');
  assert.equal(j.promotion.rows[0].promotion_candidate, true);
  assert.equal(j.promotion.rows[0].promotion_quarantined, false);
});

/**
 * The distinction the old audit could not make. An instance that stamps nothing and an
 * instance that stamps `promotion_candidate: false` on everything both render as "0
 * candidates", and they are different problems with different fixes — the first is a question
 * about the instance, the second about the lessons.
 */
test('audit: no promotion metadata at all is reported as a different fact from zero candidates', async (t) => {
  const silent = await audit(t, {
    routes: { [LIST_ROUTE]: page([lesson({ id: 'a1', run: RUN_A })]) },
  });
  assert.equal(await silent.run(['--json']), 0);
  const a = JSON.parse(silent.stdout());
  assert.equal(a.promotion.stamped, 0);
  assert.equal(a.promotion.candidates, null,
    'with nothing stamped there is no candidate count to report — null, not 0');

  const stated = await audit(t, {
    routes: {
      [LIST_ROUTE]: page([
        lesson({ id: 'a1', run: RUN_A, meta: { promotion_candidate: false } }),
      ]),
    },
  });
  assert.equal(await stated.run(['--json']), 0);
  const b = JSON.parse(stated.stdout());
  assert.equal(b.promotion.stamped, 1);
  assert.equal(b.promotion.candidates, 0, 'the instance said zero, and zero is the answer');
});

test('audit: the human report tells the two apart in words', async (t) => {
  const { run, stdout } = await audit(t, {
    routes: { [LIST_ROUTE]: page([lesson({ id: 'a1', run: RUN_A })]) },
  });

  assert.equal(await run(), 0);
  assert.match(stdout(), /stamped no promotion metadata|no promotion metadata/i,
    `the report must say the instance stamped nothing, not print a zero:\n${stdout()}`);
});

// ---------------------------------------------------------------------------
// A partial census is not a measurement
// ---------------------------------------------------------------------------

/**
 * The property a loop depends on. A census that gave up still renders — a short answer that
 * says it is short is usable — but it must not be mistakable for a reading, so every count is
 * named a floor and the exit code says so where nothing is reading the prose.
 */
test('audit: a truncated census calls every count a floor and exits non-zero', async (t) => {
  // The page token points back at a page already read: the scan's liveness guard trips and it
  // reports itself short.
  const { run, stdout, stderr } = await audit(t, {
    routes: {
      [LIST_ROUTE]: [
        page([lesson({ id: 'a1', run: RUN_A })], '1'),
        page([lesson({ id: 'a2', run: RUN_A })], '1'),
      ],
    },
  });

  const code = await run();
  assert.notEqual(code, 0,
    'a partial census that exits 0 is a partial census a script will treat as a measurement');
  assert.match(`${stdout()}${stderr()}`, /floor/i,
    `the report must say the counts are a floor:\n${stdout()}${stderr()}`);
});

test('audit: --json marks a truncated census in the payload too', async (t) => {
  const { run, stdout } = await audit(t, {
    routes: {
      [LIST_ROUTE]: [
        page([lesson({ id: 'a1', run: RUN_A })], '1'),
        page([lesson({ id: 'a2', run: RUN_A })], '1'),
      ],
    },
  });

  assert.notEqual(await run(['--json']), 0);
  const j = JSON.parse(stdout());
  assert.equal(j.truncated, true);
  assert.ok(j.truncatedReason, 'a truncated census has to say which bound it hit');
  assert.equal(j.countsAreFloor, true);
});

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

test('audit: a feed that is down exits non-zero and says so', async (t) => {
  const { run, stderr, stdout } = await audit(t, {
    routes: { [LIST_ROUTE]: { status: 500, json: { error: 'boom' } } },
  });

  assert.notEqual(await run(), 0);
  assert.match(stderr(), /could not|failed|unavailable/i);
  assert.equal(stdout(), '', 'a failed audit prints no report — a report is a claim');
});

// The audit is an audit: it must not be able to change what it is measuring, and it must not
// record a health verdict against an endpoint the hooks are also using.
test('audit: reads only, and records nothing against the circuit breaker', async (t) => {
  const { server, run } = await audit(t, {
    routes: { [LIST_ROUTE]: page([lesson({ id: 'a1', run: RUN_A })]) },
  });

  await run();
  for (const r of server.requests) {
    assert.equal(`${r.method} ${r.path}`, LIST_ROUTE,
      `the audit dialled something other than the feed: ${r.method} ${r.path}`);
  }
  server.assertNotCalled('GET', '/v2/core/health');
  server.assertNotCalled('POST', '/v2/control/ingest');
});

// ---------------------------------------------------------------------------
// The normaliser the audit reads through
// ---------------------------------------------------------------------------

// `lessonCensus` drops metadata it does not recognise, and these three keys are the whole
// promotion answer. `normalizeActivityLesson` is the one place the two-level `metadata_json`
// unwrap lives, so it is the one place they can be picked up.
test('normalizeActivityLesson keeps the promotion keys', async () => {
  const { normalizeActivityLesson } = await mod('lib/dashboard-api.mjs');

  const row = normalizeActivityLesson({
    id: 'x',
    run_id: RUN_A,
    content: 'c',
    metadata_json: JSON.stringify({
      scope: 'global',
      promotion_candidate: true,
      promotion_quarantined: false,
      promotion_shadow_stats: { arm: 'control' },
    }),
  });

  assert.equal(row.promotionCandidate, true);
  assert.equal(row.promotionQuarantined, false);
  assert.deepEqual(row.promotionShadowStats, { arm: 'control' });
  assert.equal(row.promotionStamped, true);
});

// An absent key and a key stamped `false` are different answers, so the normaliser has to keep
// "was anything stamped at all" separately from the values themselves.
test('normalizeActivityLesson reports an unstamped lesson as unstamped, not as false', async () => {
  const { normalizeActivityLesson } = await mod('lib/dashboard-api.mjs');

  const row = normalizeActivityLesson({
    id: 'x', run_id: RUN_A, content: 'c', metadata_json: JSON.stringify({ scope: 'run' }),
  });

  assert.equal(row.promotionStamped, false);
  assert.equal(row.promotionCandidate, null);
  assert.equal(row.promotionQuarantined, null);
  assert.equal(row.promotionShadowStats, null);
});
