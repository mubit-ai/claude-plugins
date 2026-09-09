// @ts-check
/**
 * `bin/dashboard.html` — the pure regions, executed rather than read.
 *
 * The page is one self-contained HTML file with inline script, served from disk and never
 * bundled. Its arithmetic — which rows a filter keeps, what a turn came to, how a delta reads,
 * where a bar goes — lives in `// #region` blocks that touch nothing in the page. This file
 * slices each block out of the shipped file by its markers and executes it in a bare
 * `node:vm` context, so the truth tables below run against the same source a user's browser
 * parses, not a copy that can drift. Anything in a region that reaches for `document` or
 * `state` throws here rather than quietly passing.
 *
 * Event wiring, rendering, focus and layout are `dashboard-browser.test.mjs`'s.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { lib, PLUGIN_ROOT } from './helpers/harness.mjs';

const PAGE = join(PLUGIN_ROOT, 'bin', 'dashboard.html');

/** Everything each region is expected to define. A missing name is a loud ReferenceError. */
const SCOPE_EXPORTS = [
  'SCOPE_VALUES', 'NO_PROJECT',
  'scopeOf', 'scopeKnown', 'leaksScope', 'fromOtherRun',
  'matchesScope', 'projectOf', 'matchesProject', 'matchesText',
];
const IDENTITY_EXPORTS = [
  'strategyLabel', 'scopeSentences', 'pathParts', 'parentRunId', 'shortSession', 'relativeTime', 'runStateTone',
  'plainRunId', 'baseRunId', 'runLabel', 'groupRunsByDirectory', 'familyIds',
];
const LESSON_EXPORTS = [
  'scopeTone', 'reachSentence', 'scopeCounts', 'typeCounts', 'dayKey', 'groupByDay', 'sortRows',
  'clockOf', 'shortId', 'placement', 'placementCounts', 'matchesView', 'originOf', 'matchesOrigin',
  'attributeTurn', 'provenanceLines', 'lessonStats', 'outcomeTone', 'sortLessons', 'countLine', 'listEmptyMessage',
];
const TURN_EXPORTS = [
  'rungText', 'usedCell', 'fmtInt', 'turnAgentsText', 'groupTurnsBySession', 'lessonsInTurn', 'savedInTurn',
  'entrySummary', 'durationText', 'outcomeOf', 'sortTurns', 'matchesTurnFilters',
];
const OVERVIEW_EXPORTS = [
  'deltaText', 'kpiTiles', 'outcomesByDay', 'perDay', 'rankedLessons', 'historyNote', 'healthTiles', 'healthNote',
];
const CHART_EXPORTS = ['scaleLinear', 'niceTicks', 'linePath', 'areaPath', 'stackedBars', 'hBars', 'sparkPoints'];
const ROUTER_EXPORTS = ['PAGES', 'parseHash', 'buildHash'];

/** One region's source, sliced out of the page by its markers. */
function sliceRegion(src, name) {
  const open = `// #region ${name}`;
  const close = `// #endregion ${name}`;
  const from = src.indexOf(open);
  const to = src.indexOf(close);
  if (from < 0 || to < 0 || to < from) {
    assert.fail(
      `${PAGE} no longer contains the "${open}" ... "${close}" markers.\n`
      + 'They are not decoration: this test slices the block out of the shipped page by those '
      + 'exact strings and executes it, so that the code a browser runs is the one the truth '
      + 'tables below cover. If the block moved, move the markers with it; if it was inlined '
      + 'into the render path, it is no longer testable and this test is now a lie.',
    );
  }
  return src.slice(from + open.length, to);
}

/**
 * One or more regions, lifted out of the shipped page and evaluated on their own. Regions are
 * concatenated in the order given, because the later ones build on the earlier.
 *
 * @param {string[]} names @param {string[]} exports
 */
function loadRegion(names, exports) {
  const src = readFileSync(PAGE, 'utf8');
  const region = names.map((n) => sliceRegion(src, n)).join('\n');
  const ctx = vm.createContext({});
  vm.runInNewContext(
    `${region}\nglobalThis.region = { ${exports.join(', ')} };`,
    ctx,
    { filename: `dashboard.html#${names.join('+')}` },
  );
  return ctx.region;
}

/** Arrays and objects built inside the vm carry that realm's prototypes; compare them as data. */
const plain = (v) => JSON.parse(JSON.stringify(v));

const scope = () => loadRegion(['scope-predicate'], SCOPE_EXPORTS);
const identity = () => loadRegion(['run-identity'], IDENTITY_EXPORTS);
const lessons = () => loadRegion(['scope-predicate', 'run-identity', 'lesson-model'], [...SCOPE_EXPORTS, ...IDENTITY_EXPORTS, ...LESSON_EXPORTS]);
const turns = () => loadRegion(['turn-model'], TURN_EXPORTS);
const overview = () => loadRegion(['scope-predicate', 'run-identity', 'lesson-model', 'turn-model', 'overview-model'], [...LESSON_EXPORTS, ...TURN_EXPORTS, ...OVERVIEW_EXPORTS]);
const charts = () => loadRegion(['chart-geometry'], CHART_EXPORTS);
const router = () => loadRegion(['router'], ROUTER_EXPORTS);

/** Local noon today, so an hour either side never crosses a day boundary in any time zone. */
function localNoon() {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

/** The page's own day key, restated: local calendar date, zero-padded. */
function ymd(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const H = 3_600_000;
const T0 = 1_700_000_000_000;
const isoAt = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Every region stands alone
// ---------------------------------------------------------------------------

test('regions: every region evaluates in an empty context and defines what the page expects of it', () => {
  scope(); identity(); lessons(); turns(); overview(); charts(); router();
  // `turn-model` and `overview-model` are listed as depending on nothing in the page; the
  // bare load proves it — a reference to `state`, `$` or `document` would throw here.
  loadRegion(['turn-model'], TURN_EXPORTS);
});

// ---------------------------------------------------------------------------
// The scope predicate
// ---------------------------------------------------------------------------

const ROWS = [
  { label: "scope 'run'", row: { scope: 'run' }, scope: 'run', known: true, leaks: false },
  { label: "scope 'session'", row: { scope: 'session' }, scope: 'session', known: true, leaks: true },
  { label: "scope 'global'", row: { scope: 'global' }, scope: 'global', known: true, leaks: true },
  { label: "scope 'org'", row: { scope: 'org' }, scope: 'org', known: true, leaks: true },
  { label: "scope ''", row: { scope: '' }, scope: 'run', known: false, leaks: false },
  { label: 'scope absent', row: {}, scope: 'run', known: false, leaks: false },
];

/** filter -> the row labels it keeps. Anything not listed must be excluded. */
const FILTER_TABLE = {
  '': ["scope 'run'", "scope 'session'", "scope 'global'", "scope 'org'", "scope ''", 'scope absent'],
  leak: ["scope 'session'", "scope 'global'", "scope 'org'"],
  run: ["scope 'run'", "scope ''", 'scope absent'],
  session: ["scope 'session'"],
  global: ["scope 'global'"],
  unknown: ["scope ''", 'scope absent'],
};

test('scope: the predicate keeps exactly the rows each filter claims', () => {
  const r = scope();
  for (const c of ROWS) {
    assert.equal(r.scopeOf(c.row), c.scope, `scopeOf(${c.label})`);
    assert.equal(r.scopeKnown(c.row), c.known, `scopeKnown(${c.label})`);
    assert.equal(r.leaksScope(c.row), c.leaks, `leaksScope(${c.label})`);
  }
  assert.equal(r.scopeOf({ scope: undefined }), 'run');
  assert.equal(r.scopeKnown({ scope: undefined }), false);
  for (const [filter, kept] of Object.entries(FILTER_TABLE)) {
    for (const c of ROWS) {
      assert.equal(r.matchesScope(c.row, filter), kept.includes(c.label), `matchesScope(${c.label}, '${filter || 'every scope'}')`);
    }
  }
  assert.equal(r.scopeKnown({ scope: 'run', scopeKnown: false }), false, 'an explicit flag off the wire wins over the shape of the row');
  assert.equal(r.matchesScope({ scope: 'run', scopeKnown: false }, 'unknown'), true);
  assert.equal(r.fromOtherRun({ sourceRunId: 'a' }, 'b'), true);
  assert.equal(r.fromOtherRun({ run_id: 'a' }, 'b'), true, 'the activity feed spells it run_id');
  assert.equal(r.fromOtherRun({ sourceRunId: 'a' }, ''), false);
  assert.equal(r.projectOf({}), r.NO_PROJECT);
  assert.notEqual(r.NO_PROJECT, '', 'the empty string already means "every project" on the select');
  assert.equal(r.matchesProject({}, r.NO_PROJECT), true);
  assert.equal(r.matchesProject({ project: 'a' }, r.NO_PROJECT), false);
  // Scope must not be searchable as text: typing `run` at a scope filter matched every row.
  const session = { content: 'never edit the mirror', scope: 'session', sourceRunId: 'abc' };
  assert.equal(r.matchesText(session, 'run'), false);
  assert.equal(r.matchesText(session, 'mirror'), true);
  assert.equal(r.matchesText({ content: 'x', id: 'ref_abc' }, 'ref_abc'), true, 'an id is searchable');
});

/** The drift guard: the page derives `leaksScope` itself, and it must agree with the server. */
test('scope: the page and lib/dashboard-api.mjs agree on what leaks', async () => {
  const r = scope();
  const { normalizeLesson } = await lib('dashboard-api.mjs');
  for (const raw of [{ scope: 'run' }, { scope: 'session' }, { scope: 'global' }, { scope: 'org' }, { scope: '' }, {}]) {
    const row = normalizeLesson({ content: 'a', ...raw }, { currentRun: 'run-1' });
    assert.equal(r.leaksScope(row), row.leaksScope, `disagree on ${JSON.stringify(raw)}`);
    assert.ok(r.SCOPE_VALUES.includes(r.scopeOf(row)));
  }
  for (const currentRun of ['run-1', 'run-2', '']) {
    const row = normalizeLesson({ content: 'a', source_run_id: 'run-1' }, { currentRun });
    assert.equal(r.fromOtherRun(row, currentRun), row.fromOtherRun);
  }
});

/** Structural facts about the shipped markup that the predicate cannot reach. */
test('scope: the shipped page offers the whole vocabulary and claims no scope it was not told', () => {
  const src = readFileSync(PAGE, 'utf8');
  for (const value of ['', 'run', 'leak', 'session', 'global', 'org', 'unknown']) {
    assert.ok(src.includes(`<option value="${value}"`), `the scope filter offers no <option value="${value}">`);
  }
  const orgOption = src.slice(src.indexOf('<option value="org"'));
  assert.match(orgOption.slice(0, orgOption.indexOf('>') + 1), /hidden/, 'org starts hidden until a loaded row carries it');
  const search = src.slice(src.indexOf('async function searchInstance()'), src.indexOf('function setView('));
  assert.doesNotMatch(search, /\bscope:\s*['"]/, 'the search mapper must not invent a scope');
  assert.doesNotMatch(search, /\bleaksScope:\s*false/, 'the search mapper must not invent leaksScope');
  assert.doesNotMatch(src, /if\s*\(\s*e\.scope\s*\)/, 'the scope badge must render for every row, including one with no recorded scope');
  assert.ok(src.includes('function scopeBadge('), 'one helper, so "always rendered" is enforced in one place');
  assert.doesNotMatch(src, /state\.allRuns/, 'the run toggle is gone; the view is the filter');
  assert.ok(src.includes('Could not load lessons from the instance'), 'a failed fetch and an empty instance render different sentences');
});

// ---------------------------------------------------------------------------
// Run identity
// ---------------------------------------------------------------------------

test('identity: relativeTime, dayKey, groupByDay and clockOf agree with a fixed clock', () => {
  const r = lessons();
  const now = localNoon();
  assert.equal(r.relativeTime(now - 3_000, now), 'just now');
  assert.equal(r.relativeTime(now - 12_000, now), '12s ago');
  assert.equal(r.relativeTime(now - 120_000, now), '2m ago');
  assert.equal(r.relativeTime(now - 3 * H, now), '3h ago');
  assert.equal(r.relativeTime(now - 2 * 24 * H, now), '2d ago');
  assert.equal(r.relativeTime(now + 5_000, now), 'just now', 'a clock skewed into the future is not "in 5s"');
  assert.equal(r.relativeTime(0, now), '—');
  const iso = (ms) => new Date(ms).toISOString();
  assert.equal(r.dayKey(iso(now - H), now), 'Today');
  assert.equal(r.dayKey(iso(now - 24 * H), now), 'Yesterday');
  assert.equal(r.dayKey(iso(now - 72 * H), now), ymd(now - 72 * H));
  assert.equal(r.dayKey('', now), 'Undated');
  assert.equal(r.dayKey('not a date', now), 'Undated');
  assert.equal(r.clockOf(iso(now)), '12:00');
  assert.equal(r.clockOf(''), '—');
  const rows = [
    { id: 'a', createdAt: iso(now - H) }, { id: 'b', createdAt: iso(now - 24 * H) },
    { id: 'c', created_at: iso(now - 2 * H) }, { id: 'd' }, { id: 'e', createdAt: iso(now - 72 * H) },
  ];
  const groups = r.groupByDay(rows, now, 'newest');
  assert.deepEqual(plain(groups.map((g) => g.key)), ['Today', 'Yesterday', ymd(now - 72 * H), 'Undated']);
  assert.deepEqual(plain(groups[0].rows.map((x) => x.id)), ['a', 'c']);
  assert.deepEqual(plain(r.sortRows(rows, 'oldest').map((x) => x.id)), ['e', 'b', 'c', 'a', 'd'], 'undated last in both orders');
  assert.deepEqual(rows.map((x) => x.id), ['a', 'b', 'c', 'd', 'e'], 'the input is not mutated');
});

test('identity: scopeSentences, strategyLabel, pathParts, parentRunId, shortSession and runStateTone', () => {
  const r = identity();
  const distinct = (values, fn) => assert.equal(new Set(values.map(fn)).size, values.length);
  distinct(['per-directory', 'git-branch', 'per-conversation', 'static'], (v) => r.strategyLabel(v));
  distinct(['run', 'session', 'global'], (v) => r.scopeSentences({ writesAt: v }).writes);
  distinct(['auto', 'on', 'off'], (v) => r.scopeSentences({ readsAcrossRuns: v }).reads);
  const s = r.scopeSentences({ writesAt: 'session', writesAtText: 'the server wording', readsAcrossRuns: 'auto', readsAcrossRunsText: 'and this one' });
  assert.ok(s.writes.includes('the server wording') && s.writes.includes('(cap: session)'), s.writes);
  assert.ok(s.reads.includes('and this one') && s.reads.includes('(cross-run: auto)'), s.reads);
  assert.ok(r.scopeSentences(null).writes.length > 20, 'an old server with no scope block still gets the defaults');
  assert.deepEqual(plain(r.pathParts('/home/user/proj')), { full: '/home/user/proj', head: '/home/user/', tail: 'proj' });
  assert.deepEqual(plain(r.pathParts('')), { full: '', head: '', tail: '' });
  assert.equal(r.parentRunId('cc-pre-main-af449e06-sub-1a2b3c'), 'cc-pre-main-af449e06');
  assert.equal(r.parentRunId('cc-subject-000001'), 'cc-subject-000001', '"sub" inside a word is not the marker');
  assert.equal(r.parentRunId('-sub-x'), '-sub-x');
  assert.equal(r.shortSession('01a08f3e-1111-2222-3333-444444444e11'), '01a08…e11');
  assert.equal(r.shortSession(''), '—');
  assert.equal(r.runStateTone('ready'), 'ok');
  assert.equal(r.runStateTone('auth_failed'), 'bad');
  assert.equal(r.runStateTone(''), 'muted');
});

/** Every shape a run id arrives in. The same table `test/dashboard-data.test.mjs` pins. */
const RUN_ID_SHAPES = [
  'cc-pre-main-af449e06', 'cc-pre-main-feat-x-af449e06', 'cc-pre-main-af449e06-c1',
  'cc-pre-main-af449e06-c12', 'cc-pre-main-af449e06-sub-a06e2764eaae',
  'cc-pre-main-af449e06-c1-sub-abc123', 'state::01234::cc-pre-main-af449e06-c1',
  'my-pinned-run-c1', 'my-pinned-run', '11111111-2222-4333-8444-555555555555', '',
];

test('identity: baseRunId and plainRunId agree with lib/dashboard-data.mjs on every shape of run id', async () => {
  const r = identity();
  const d = await lib('dashboard-data.mjs');
  for (const id of RUN_ID_SHAPES) {
    assert.equal(r.baseRunId(id), d.baseRunId(id), `baseRunId(${JSON.stringify(id)}) differs between the page and the server`);
    assert.equal(r.plainRunId(id), d.plainRunId(id), `plainRunId(${JSON.stringify(id)}) differs between the page and the server`);
  }
  assert.equal(r.baseRunId('my-pinned-run-c1'), 'my-pinned-run-c1', 'a static id is not a directory key');
});

test('identity: groupRunsByDirectory folds a directory\'s runs together and names the current one', () => {
  const r = identity();
  const runs = [
    { runId: 'cc-here-00000001-c1', lastWrite: 300, turnCount: 3, projectDir: '/home/user/proj', projectRoot: '/home/user/proj', sessions: [{ sessionId: 's2', runId: 'cc-here-00000001-c1', lastSeenAt: 300, agentId: 'claude-code' }] },
    { runId: 'cc-here-00000001', lastWrite: 100, turnCount: 12, projectDir: '/home/user/proj', projectRoot: '/home/user/proj', sessions: [{ sessionId: 's1', runId: 'cc-here-00000001', lastSeenAt: 100, agentId: 'claude-code' }] },
    { runId: 'cc-here-00000001-sub-abc', lastWrite: 200, turnCount: 0, sessions: [] },
    { runId: 'pinned', lastWrite: 250, turnCount: 1, projectDir: '/home/user/proj/sub', projectRoot: '/home/user/proj', sessions: [{ sessionId: 's3', runId: 'pinned', lastSeenAt: 250, agentId: 'codex' }] },
    { runId: 'cc-else-00000002', lastWrite: 400, turnCount: 1, projectDir: '/home/user/other', projectRoot: '/home/user/other', sessions: [{ sessionId: 's4', runId: 'cc-else-00000002', lastSeenAt: 400, agentId: 'claude-code' }] },
    { runId: 'cc-orphan-0000003', lastWrite: 50, turnCount: 0, sessions: [] },
  ];
  const groups = r.groupRunsByDirectory(runs);
  assert.deepEqual(plain(groups.map((g) => g.runs.map((x) => x.runId))), [
    ['cc-else-00000002'],
    ['cc-here-00000001-c1', 'pinned', 'cc-here-00000001-sub-abc', 'cc-here-00000001'],
    ['cc-orphan-0000003'],
  ], 'families newest first; runs inside a family newest first');
  const here = groups[1];
  assert.equal(here.projectDir, '/home/user/proj');
  assert.equal(here.current, 'cc-here-00000001-c1', 'the run the newest session maps to');
  assert.deepEqual(plain(here.runs.map((x) => x.label)), ['current', 'earlier', 'subagent', 'before /clear']);
  assert.equal(here.subagentRuns, 1);
  assert.equal(here.turnCount, 16);
  assert.equal(here.sessionCount, 3, 'every session in the family, for the context line');
  assert.equal(groups[2].projectDir, '', 'no session record, no directory — guessing one would be worse than blank');
  assert.equal(r.runLabel('cc-here-00000001-c12', { ...here, current: 'x' }), 'after /clear ×12');
  assert.deepEqual(plain(r.familyIds(runs, 'pinned')).sort(), plain(here.runs.map((x) => x.runId)).sort());
  assert.deepEqual(plain(r.familyIds(runs, 'cc-nope-00000009')), ['cc-nope-00000009']);
  assert.deepEqual(plain(r.groupRunsByDirectory(null)), []);
});

// ---------------------------------------------------------------------------
// The lesson model
// ---------------------------------------------------------------------------

test('lessons: scopeCounts, typeCounts, scopeTone and reachSentence count and name what the table shows', () => {
  const r = lessons();
  const rows = [
    { scope: 'run', lessonType: 'rule' }, { scope: 'run', lessonType: 'rule' }, { scope: 'session', lessonType: 'fact' },
    { scope: 'global', lessonType: 'rule' }, { scope: '', lessonType: 'rule' }, { entry_type: 'trace' }, { scope: 'org', lessonType: 'rule' },
  ];
  const c = r.scopeCounts(rows);
  assert.equal(c.run, 4, 'two recorded, two defaulted — the run filter keeps all four');
  assert.equal(c.unknown, 2);
  assert.deepEqual(plain(r.typeCounts(rows)), [{ key: 'rule', count: 5 }, { key: 'fact', count: 1 }, { key: 'trace', count: 1 }]);
  assert.equal(r.scopeTone({ scope: 'global' }), 'shared');
  assert.equal(r.scopeTone({ scope: 'run' }), 'local');
  assert.equal(r.scopeTone({}), 'unknown');
  assert.ok(r.reachSentence({}).includes('default'), 'an unrecorded scope says it is the default');
});

test('lessons: placement and matchesView decide here, shared and elsewhere against the selected directory', () => {
  const r = lessons();
  const bases = ['cc-here-00000001'];
  const rows = {
    hereRun: { scope: 'run', sourceRunId: 'cc-here-00000001' },
    hereCleared: { scope: 'session', sourceRunId: 'state::u::cc-here-00000001-c1' },
    hereSub: { scope: 'run', run_id: 'cc-here-00000001-sub-abc' },
    sharedGlobal: { scope: 'global', sourceRunId: 'cc-else-00000002' },
    sharedSession: { scope: 'session', run_id: 'state::u::cc-else-00000002-c3' },
    elsewhere: { scope: 'run', sourceRunId: 'cc-else-00000002' },
    noRun: { scope: 'global' },
  };
  const P = { hereRun: 'here', hereCleared: 'here', hereSub: 'here', sharedGlobal: 'shared', sharedSession: 'shared', elsewhere: 'elsewhere', noRun: 'here' };
  for (const [k, row] of Object.entries(rows)) assert.equal(r.placement(row, bases), P[k], `placement(${k})`);
  assert.equal(r.matchesView(rows.sharedGlobal, 'here', bases), false);
  assert.equal(r.matchesView(rows.sharedGlobal, 'reach', bases), true);
  assert.equal(r.matchesView(rows.elsewhere, 'reach', bases), false);
  assert.equal(r.matchesView(rows.elsewhere, 'all', bases), true);
  assert.deepEqual(plain(r.placementCounts(Object.values(rows), bases)), { here: 4, reach: 6, all: 7 });
  assert.equal(r.placement(rows.hereRun, []), 'elsewhere', 'with no directory selected, nothing is here');
});

/** Three turns: two in one session (the second still open), one in another session and run. */
const TURNS = [
  { runId: 'cc-here-00000001', promptId: 'p1', sessionId: 's1', startedAt: T0, endedAt: T0 + 100_000, turnNumber: 1, promptPreview: 'first prompt' },
  { runId: 'cc-here-00000001', promptId: 'p2', sessionId: 's1', startedAt: T0 + 300_000, endedAt: 0, turnNumber: 2, promptPreview: 'second, still open' },
  { runId: 'cc-here-00000001-c1', promptId: 'p3', sessionId: 's2', startedAt: T0 + 30_000, endedAt: T0 + 50_000, turnNumber: 1, promptPreview: 'other session' },
];

test('lessons: originOf and matchesOrigin read the four origins; attributeTurn says recorded, by time, or nothing', () => {
  const r = lessons();
  assert.equal(r.originOf({ origin: 'agent' }), 'agent', 'the server\'s word wins when it sent one');
  assert.equal(r.originOf({ source: 'mcp-agent' }), 'agent');
  assert.equal(r.originOf({ source: 'auto-reflect:end' }), 'auto-reflection');
  assert.equal(r.originOf({ source: 'reflection', autoReflection: true }), 'auto-reflection');
  assert.equal(r.originOf({ source: 'reflection:session-end' }), 'reflection');
  assert.equal(r.originOf({ entry_type: 'trace', source: 'agent' }), 'hook', 'the capture hooks stamp source: agent on a trace');
  assert.equal(r.originOf({}), '');
  assert.equal(r.matchesOrigin({ source: 'mcp-agent' }, ''), true);
  assert.equal(r.matchesOrigin({ source: 'mcp-agent' }, 'agent'), true);
  assert.equal(r.matchesOrigin({ source: 'mcp-agent' }, 'hook'), false);
  assert.equal(r.matchesOrigin({}, 'unknown'), true, '"unknown" is the rows nothing recorded an origin for');
  assert.equal(r.matchesOrigin({ source: 'reflection' }, 'unknown'), false);

  assert.equal(r.attributeTurn({ promptId: 'p1', sessionId: 's1', createdAt: isoAt(T0 + 20_000) }, TURNS).how, 'recorded');
  const pruned = r.attributeTurn({ promptId: 'p9', createdAt: isoAt(T0 + 20_000) }, TURNS);
  assert.equal(pruned.how, 'recorded', 'stamped is stamped, even when the turn is not on the page');
  assert.equal(pruned.turn, null);
  const byTime = r.attributeTurn({ sessionId: 's1', createdAt: isoAt(T0 + 40_000) }, TURNS);
  assert.equal(byTime.how, 'by time');
  assert.equal(byTime.turn.promptId, 'p1', 'the same session — not the other session\'s turn at the same moment');
  assert.equal(r.attributeTurn({ createdAt: isoAt(T0 + 40_000) }, TURNS).turn.promptId, 'p3', 'without a session, the latest window that contains the time');
  assert.equal(r.attributeTurn({ sessionId: 's1', createdAt: isoAt(T0 + 900_000) }, TURNS).turn.promptId, 'p2', 'an open turn\'s window has no end');
  assert.equal(r.attributeTurn({ sessionId: 's1', createdAt: isoAt(T0 + 130_000) }, TURNS).turn.promptId, 'p1', 'the grace after a close');
  assert.equal(r.attributeTurn({ sessionId: 's1', createdAt: isoAt(T0 + 200_000) }, TURNS).how, '', 'between two turns is outside every window');
  assert.equal(r.attributeTurn({ source: 'reflection:x', sessionId: 's1', createdAt: isoAt(T0 + 20_000) }, TURNS).how, '', 'a reflection is never attributed to a prompt');
  assert.equal(r.attributeTurn(null, null).how, '');
});

test('lessons: provenanceLines says where, which session, which prompt, and how it knows', () => {
  const r = lessons();
  const families = [{
    key: 'cc-here-00000001', projectDir: '/home/user/proj', bases: ['cc-here-00000001'], current: 'cc-here-00000001-c1',
    runs: [{ runId: 'cc-here-00000001-c1', label: 'current' }, { runId: 'cc-here-00000001', label: 'before /clear' }],
  }];
  const sid = '01a08f3e-1111-2222-3333-444444444e11';
  const turns = [{ runId: 'cc-here-00000001', promptId: 'p1', sessionId: sid, startedAt: T0, endedAt: T0 + 100_000, turnNumber: 23, promptPreview: 'Give me the commands to start the daemon and check its logs afterwards please' }];
  const row = { id: 'l1', createdAt: isoAt(T0 + 20_000), source: 'mcp-agent', origin: 'agent', scope: 'session', sourceRunId: 'cc-here-00000001', sessionId: sid, promptId: 'p1', turnNumber: 23 };
  const find = (lines, key) => lines.find((l) => l.key === key);

  const lines = r.provenanceLines(row, { families, turns });
  assert.deepEqual(plain(lines.map((l) => l.key)), ['saved', 'directory', 'session', 'prompt', 'reach']);
  assert.ok(find(lines, 'saved').text.includes('by the agent (mubit_learned)'));
  assert.equal(find(lines, 'directory').text, 'Directory /home/user/proj · run cc-here-00000001 (before /clear)');
  assert.equal(find(lines, 'session').text, 'Session 01a08…e11 · recorded');
  assert.match(find(lines, 'prompt').text, /^Prompt “Give me the commands to start/);
  assert.ok(find(lines, 'prompt').text.includes('turn 23') && find(lines, 'prompt').text.endsWith('· recorded'));
  assert.equal(find(lines, 'prompt').turn.promptId, 'p1');

  const byTime = r.provenanceLines({ ...row, sessionId: '', promptId: '', turnNumber: 0 }, { families, turns });
  assert.equal(find(byTime, 'session').text, 'Session 01a08…e11 · by time');
  assert.equal(find(byTime, 'prompt').how, 'by time');
  const reflection = r.provenanceLines({ createdAt: isoAt(T0 + 20_000), source: 'reflection:x', sourceRunId: 'cc-here-00000001', scope: 'session' }, { families, turns });
  assert.equal(find(reflection, 'prompt'), undefined, 'a reflection gets a session by time but never a prompt');
  const pruned = r.provenanceLines({ ...row, promptId: 'p9' }, { families, turns });
  assert.match(find(pruned, 'prompt').text, /turn not on this page/);
  assert.equal(find(pruned, 'prompt').turn, null);
  const other = r.provenanceLines({ ...row, sourceRunId: 'cc-else-00000002', sessionId: '', promptId: '' }, { families, turns });
  assert.match(find(other, 'directory').text, /not in this data directory/);
  assert.equal(find(other, 'prompt'), undefined, 'another directory\'s turns are not on this page');
  const hook = r.provenanceLines({ entryType: 'trace', tool: 'Edit', hookEvent: 'PostToolUse', sessionId: sid, promptId: 'p1', createdAt: isoAt(T0 + 1_000), run_id: 'state::u::cc-here-00000001', source: 'agent' }, { families, turns });
  assert.ok(find(hook, 'saved').text.includes('hook capture (Edit)') && find(hook, 'saved').text.includes('PostToolUse'), find(hook, 'saved').text);
  assert.equal(r.provenanceLines(null, null).length, 5, 'a blank row still renders the five lines rather than throwing');
});

/**
 * The counters. Blank — never 0 — when the instance stamped none: a zero would claim the
 * lesson was measured and never helped, where a blank says nothing was recorded either way.
 */
test('lessons: lessonStats is blank, not zero, for a counter the instance never stamped', () => {
  const r = lessons();
  const stamped = r.lessonStats({ countersStamped: true, successCount: 3, confidence: 0.714, injectedCount: 5 });
  assert.equal(stamped.worked, '3');
  assert.equal(stamped.failed, '0', 'failure_count is absent until a failure lands; stamped means 0');
  assert.equal(stamped.confidence, '0.71');
  assert.equal(stamped.injected, '5');
  assert.equal(stamped.workedN, 3);
  assert.equal(stamped.failedN, 0);
  const bare = r.lessonStats({ countersStamped: false, successCount: 0, failureCount: 0, confidence: null });
  assert.equal(bare.worked, '');
  assert.equal(bare.failed, '');
  assert.equal(bare.confidence, '');
  assert.equal(bare.injected, '', 'undecorated: the ledger had nothing for this directory');
  assert.equal(bare.workedN, null);
  assert.equal(r.lessonStats({ injectedCount: 0 }).injected, '0', 'decorated and never injected is a real zero');
  assert.equal(r.lessonStats(null).worked, '');

  assert.deepEqual(plain(r.outcomeTone('success')), { text: 'worked', tone: 'ok' });
  assert.deepEqual(plain(r.outcomeTone('failure')), { text: 'failed', tone: 'bad' });
  assert.equal(r.outcomeTone('partial').tone, 'warn');
  assert.equal(r.outcomeTone('neutral').tone, 'warn');
  assert.deepEqual(plain(r.outcomeTone('')), { text: 'none', tone: 'muted' });
});

test('lessons: sortLessons orders by a counter with blanks last in both directions, and by saved time', () => {
  const r = lessons();
  const rows = [
    { id: 'blank' },
    { id: 'three', countersStamped: true, successCount: 3, createdAt: isoAt(T0) },
    { id: 'one', countersStamped: true, successCount: 1, createdAt: isoAt(T0 + 5_000) },
    { id: 'seven', countersStamped: true, successCount: 7, timestamp: isoAt(T0 - 5_000) },
  ];
  assert.deepEqual(plain(r.sortLessons(rows, 'worked', 'desc').map((x) => x.id)), ['seven', 'three', 'one', 'blank']);
  assert.deepEqual(plain(r.sortLessons(rows, 'worked', 'asc').map((x) => x.id)), ['one', 'three', 'seven', 'blank'], 'a blank is not the least reinforced');
  assert.deepEqual(plain(r.sortLessons(rows, 'saved', 'desc').map((x) => x.id)), ['one', 'three', 'seven', 'blank']);
  assert.deepEqual(plain(r.sortLessons(rows, 'saved', 'asc').map((x) => x.id)), ['seven', 'three', 'one', 'blank']);
  assert.deepEqual(rows.map((x) => x.id), ['blank', 'three', 'one', 'seven'], 'the input is not mutated');
});

test('lessons: countLine and listEmptyMessage tell a failed fetch, an empty instance and a filter apart', () => {
  const r = lessons();
  assert.match(r.countLine({ error: 'boom' }), /^Could not load lessons.*boom/);
  assert.equal(r.countLine({ loaded: false }), 'Loading…');
  const line = r.countLine({ loaded: true, shown: 1, total: 3, census: { totalVisible: 40, truncated: true, pages: 2, truncatedReason: 'deadline', unknownScope: 3 } });
  for (const part of ['1 shown', '2 hidden by the view and filters', '40 on the instance', 'stopped after 2 pages (deadline)', '3 with no recorded scope']) {
    assert.ok(line.includes(part), `${JSON.stringify(part)} missing from ${JSON.stringify(line)}`);
  }
  const searching = r.countLine({ loaded: true, shown: 2, total: 2, search: true, searchQuery: 'mirror', census: { totalVisible: 40 } });
  assert.ok(searching.includes('mirror') && !searching.includes('on the instance'), 'a search answer is not a census');
  assert.equal(r.listEmptyMessage({ error: 'boom' }).kind, 'error');
  assert.equal(r.listEmptyMessage({ loaded: false }).kind, 'loading');
  const filtered = r.listEmptyMessage({ loaded: true, total: 7, view: 'here', scope: 'global', q: 'mirror' });
  assert.equal(filtered.kind, 'filtered');
  assert.ok(filtered.text.includes('7 loaded') && filtered.text.includes('“mirror”') && filtered.text.includes('scope global') && filtered.text.includes('Written here'), filtered.text);
  assert.match(r.listEmptyMessage({ loaded: true, total: 0, view: 'all' }).text, /anywhere on the instance/);
  assert.match(r.listEmptyMessage({ loaded: true, total: 0, view: 'here' }).text, /this directory/);
});

// ---------------------------------------------------------------------------
// The turn model
// ---------------------------------------------------------------------------

test('turns: turnAgentsText, groupTurnsBySession, lessonsInTurn, savedInTurn, entrySummary and durationText', () => {
  const r = turns();
  assert.equal(r.turnAgentsText({ subagentCount: 0 }), 'main');
  assert.equal(r.turnAgentsText({ subagentCount: 2, subagentTypes: ['Explore', 'Plan'] }), 'main + 2 sub (Explore, Plan)');
  assert.equal(r.turnAgentsText({ subagentCount: 3, subagentTypes: ['Explore', 'Explore', 'Explore'] }), 'main + 3 sub (Explore)');
  const groups = r.groupTurnsBySession([{ promptId: 'a', sessionId: 's2' }, { promptId: 'b', sessionId: 's1' }, { promptId: 'c', sessionId: 's2' }, { promptId: 'd' }]);
  assert.deepEqual(plain(groups.map((g) => [g.sessionId, g.rows.map((x) => x.promptId)])), [['s2', ['a', 'c']], ['s1', ['b']], ['', ['d']]]);

  const turn = { promptId: 'p1', sessionId: 's1', startedAt: T0, endedAt: T0 + 60_000 };
  const lessons = [
    { id: 'stamped', promptId: 'p1', createdAt: isoAt(T0 + 900_000) },
    { id: 'inWindow', createdAt: isoAt(T0 + 30_000), sessionId: 's1' },
    { id: 'otherSession', createdAt: isoAt(T0 + 30_000), sessionId: 's9' },
    { id: 'outside', createdAt: isoAt(T0 + 600_000) },
    { id: 'otherPrompt', promptId: 'p2', createdAt: isoAt(T0 + 30_000) },
    { id: 'reflection', source: 'reflection:x', createdAt: isoAt(T0 + 30_000) },
  ];
  assert.deepEqual(plain(r.lessonsInTurn(turn, lessons).map((l) => l.id)), ['stamped', 'inWindow']);
  assert.deepEqual(plain(r.savedInTurn(turn, lessons).map((s) => [s.lesson.id, s.how])), [['stamped', 'recorded'], ['inWindow', 'by time']],
    'each says how the page knows: stamped with the prompt, or inferred from the time');
  assert.deepEqual(plain(r.savedInTurn(null, lessons)), []);

  const e = r.entrySummary({ entryType: 'trace', tool: 'Edit', content: 'Edit lib/x.mjs '.repeat(20), createdAt: isoAt(T0), origin: 'hook' });
  assert.equal(e.type, 'trace');
  assert.ok(e.preview.length <= 140 && e.preview.endsWith('…'));
  assert.equal(r.entrySummary({}).clock, '—');
  assert.equal(r.durationText(T0, T0 + 12_000), '12s');
  assert.equal(r.durationText(T0, T0 + 185_000), '3m 05s');
  assert.equal(r.durationText(T0, T0 + 3_720_000), '1h 02m');
  assert.equal(r.durationText(T0, 0), '');
});

test('turns: usedCell is tri-state, rungText renders zero as unrecorded, fmtInt groups thousands', () => {
  const r = turns();
  assert.equal(r.usedCell({ used: true, matched: 2, candidates: 4 }).tone, 'ok');
  const no = r.usedCell({ used: false, matched: 0, candidates: 4 });
  assert.equal(no.text, '0/4');
  assert.notEqual(no.tone, 'bad', 'a "no" is weak evidence and must not be painted as a failure');
  const unknown = r.usedCell({ used: null, matched: 0, candidates: 0, reason: 'no_reply' });
  assert.equal(unknown.text, '?', 'never "0/0", which reads as a measured zero');
  assert.ok(unknown.title.includes('no_reply') && unknown.title.includes('not "unused"'));
  assert.equal(r.usedCell(undefined).text, '?');
  assert.equal(r.rungText(0), '—');
  assert.equal(r.rungText(2), '2');
  assert.equal(r.fmtInt(1234567), '1,234,567');
  assert.equal(r.fmtInt(undefined), '0');
});

/**
 * The outcome word: the verdict wins over the automatic signal, `neutral` is a third tone
 * rather than a failure, and a turn the API cut off is `none`, never `failed`.
 */
test('turns: outcomeOf lets a verdict win over the signal and never paints neutral as failure', () => {
  const r = turns();
  const o = (t) => plain(r.outcomeOf(t));
  assert.deepEqual(o({ outcome: 'success', verdict: 'failed' }), { key: 'failed', text: 'did not work', tone: 'bad', by: 'verdict' });
  assert.deepEqual(o({ outcome: 'failure', verdict: 'worked' }), { key: 'worked', text: 'worked', tone: 'ok', by: 'verdict' });
  assert.deepEqual(o({ outcome: 'success' }), { key: 'worked', text: 'worked', tone: 'ok', by: 'signal' });
  assert.deepEqual(o({ outcome: 'failure' }), { key: 'failed', text: 'failed', tone: 'bad', by: 'signal' });
  assert.equal(o({ outcome: 'neutral' }).tone, 'warn');
  assert.equal(o({ outcome: 'neutral' }).key, 'neutral');
  assert.deepEqual(o({ outcome: 'none', apiError: 'rate_limit', startedAt: T0, endedAt: T0 + 1 }), { key: 'none', text: 'api error', tone: 'muted', by: 'api' });
  assert.equal(o({ startedAt: T0, endedAt: 0 }).key, 'open');
  assert.equal(o({ outcome: 'none', startedAt: T0, endedAt: T0 + 1 }).key, 'none');
  assert.equal(o(null).key, 'none');
});

test('turns: sortTurns and matchesTurnFilters order and narrow the table', () => {
  const r = turns();
  const rows = [
    { promptId: 'a', startedAt: T0 + 1, recalledCount: 2, tok: 50, outcome: 'neutral', promptPreview: 'rebuild the bundle', sessionId: 's1' },
    { promptId: 'b', startedAt: T0 + 3, recalledCount: 0, tok: 0, outcome: 'none', promptPreview: 'and again', sessionId: 's2', endedAt: T0 + 4 },
    { promptId: 'c', startedAt: T0 + 2, recalledCount: 5, tok: 900, outcome: 'success', verdict: 'failed', promptPreview: 'ship it', sessionId: 's1' },
  ];
  assert.deepEqual(plain(r.sortTurns(rows, 'time', 'desc').map((t) => t.promptId)), ['b', 'c', 'a']);
  assert.deepEqual(plain(r.sortTurns(rows, 'injected', 'desc').map((t) => t.promptId)), ['c', 'a', 'b']);
  assert.deepEqual(plain(r.sortTurns(rows, 'tok', 'asc').map((t) => t.promptId)), ['b', 'a', 'c']);
  assert.deepEqual(plain(r.sortTurns(rows, 'outcome', 'asc').map((t) => t.promptId)), ['a', 'c', 'b'], 'worked, neutral, failed, then none');
  const ids = (f) => plain(rows.filter((t) => r.matchesTurnFilters(t, f)).map((t) => t.promptId));
  assert.deepEqual(ids({}), ['a', 'b', 'c']);
  assert.deepEqual(ids({ q: 'BUNDLE' }), ['a'], 'case-insensitive over the preview');
  assert.deepEqual(ids({ session: 's1' }), ['a', 'c']);
  assert.deepEqual(ids({ outcome: 'failed' }), ['c'], 'the verdict is what the filter sees');
  assert.deepEqual(ids({ outcome: 'none' }), ['b']);
  assert.deepEqual(ids({ injectedOnly: true }), ['a', 'c']);
  assert.deepEqual(ids({ q: 's1', injectedOnly: true, session: 's1' }), ['a', 'c'], 'the session id is in the haystack too');
});

// ---------------------------------------------------------------------------
// The overview model
// ---------------------------------------------------------------------------

test('overview: deltaText reads direction against whether up is good, and says when there is no earlier window', () => {
  const r = overview();
  assert.deepEqual(plain(r.deltaText(12, 9, { days: 7, good: 'up' })), { text: '+3 vs previous 7 days', tone: 'ok' });
  assert.deepEqual(plain(r.deltaText(9, 12, { days: 7, good: 'up' })), { text: '−3 vs previous 7 days', tone: 'bad' });
  assert.deepEqual(plain(r.deltaText(900, 1200, { days: 7, good: 'down' })), { text: '−300 vs previous 7 days', tone: 'ok' });
  assert.equal(r.deltaText(5, 2, { days: 7, good: 'none' }).tone, 'muted', 'a count with no better direction is not coloured');
  assert.deepEqual(plain(r.deltaText(5, 5, { days: 7, good: 'up' })), { text: 'no change vs previous 7 days', tone: 'muted' });
  assert.deepEqual(plain(r.deltaText(5, null, { days: 7 })), { text: 'no earlier window', tone: 'muted' });
  assert.equal(r.deltaText(5, 2, { days: 7, hasPrev: false }).text, 'no earlier window');
});

/** The server's overview, as `lib/dashboard-data.mjs` shapes it. */
function overviewFixture(over = {}) {
  const day = (d, turns, injected, tokens, success, failure, neutral, none) => ({
    day: d, turns, injectedTurns: injected ? 1 : 0, injectedRefs: injected, injected, tokens, chars: tokens * 4,
    outcomes: { success, failure, neutral, none }, verdicts: { worked: 0, failed: 0 },
  });
  const series = [day('2026-09-03', 2, 3, 400, 1, 0, 1, 0), day('2026-09-04', 0, 0, 0, 0, 0, 0, 0), day('2026-09-05', 3, 6, 900, 1, 1, 0, 1)];
  return {
    days: 7, now: T0, windowStart: T0 - 7 * 86400000, previousStart: T0 - 14 * 86400000, firstLedgerAt: T0 - 20 * 86400000,
    kpi: { turns: 5, injectedTurns: 2, injectedRefs: 9, tokens: 1300, outcomes: { success: 2, failure: 1, neutral: 1, none: 1 }, verdicts: { worked: 1, failed: 0 } },
    previous: { turns: 4, injectedTurns: 3, injectedRefs: 6, tokens: 1600, outcomes: { success: 1, failure: 0, neutral: 2, none: 1 }, verdicts: { worked: 0, failed: 0 } },
    series,
    ...over,
  };
}

test('overview: kpiTiles yields the five tiles with zeros rather than NaN, and deltas against the previous window', () => {
  const r = overview();
  const tiles = r.kpiTiles(overviewFixture(), { lessonsLoaded: true, lessonsSaved: 2, lessonsSavedPrev: 5 });
  assert.deepEqual(plain(tiles.map((t) => t.key)), ['turns', 'injected', 'outcomes', 'saved', 'cost']);
  const by = (k) => tiles.find((t) => t.key === k);
  assert.equal(by('turns').value, '5');
  assert.equal(by('turns').delta.text, '+1 vs previous 7 days');
  assert.equal(by('injected').value, '9');
  assert.equal(by('outcomes').value, '2 / 1');
  assert.ok(by('outcomes').unit.includes('1 by verdict'), by('outcomes').unit);
  assert.equal(by('outcomes').delta.tone, 'ok', 'more worked is good');
  assert.equal(by('saved').value, '2');
  assert.equal(by('saved').delta.text, '−3 vs previous 7 days');
  assert.equal(by('cost').value, '260', '1300 tokens over 5 turns');
  assert.equal(by('cost').delta.tone, 'ok', '260 is down from 400, and down is good');
  for (const t of tiles) {
    assert.equal(typeof t.value, 'string');
    assert.ok(!t.value.includes('NaN'), `${t.key} rendered NaN`);
  }
  const empty = r.kpiTiles(null, {});
  assert.equal(empty.length, 5);
  assert.equal(empty.find((t) => t.key === 'cost').value, '0');
  assert.equal(empty.find((t) => t.key === 'saved').value, '—', 'lessons not loaded is a dash, not a zero');
  assert.equal(empty.find((t) => t.key === 'turns').delta.text, 'no earlier window');
  // A ledger younger than two windows has no honest previous window.
  const young = r.kpiTiles(overviewFixture({ firstLedgerAt: T0 - 3 * 86400000 }), {});
  assert.equal(young.find((t) => t.key === 'turns').delta.text, 'no earlier window');
});

test('overview: outcomesByDay, perDay and rankedLessons shape the chart and the two tables', () => {
  const r = overview();
  const ov = overviewFixture();
  assert.deepEqual(plain(r.outcomesByDay(ov.series)), [
    { day: '2026-09-03', worked: 1, neutral: 1, failed: 0, none: 0 },
    { day: '2026-09-04', worked: 0, neutral: 0, failed: 0, none: 0 },
    { day: '2026-09-05', worked: 1, neutral: 0, failed: 1, none: 1 },
  ]);
  assert.deepEqual(plain(r.perDay(ov.series, 'injected').map((d) => d.value)), [3, 0, 6]);
  assert.deepEqual(plain(r.perDay(ov.series, 'cost').map((d) => d.value)), [200, 0, 300], 'tokens per turn, zero on an empty day');
  assert.deepEqual(plain(r.outcomesByDay(null)), []);
  const lessons = [
    { id: 'a', content: 'A', countersStamped: true, successCount: 4, failureCount: 1 },
    { id: 'b', content: 'B', countersStamped: true, successCount: 0, failureCount: 3 },
    { id: 'c', content: 'C', countersStamped: false },
    { id: 'd', content: 'D', countersStamped: true, successCount: 2 },
  ];
  assert.deepEqual(plain(r.rankedLessons(lessons, 'worked', 5)), [
    { id: 'a', content: 'A', count: 4, share: 1 }, { id: 'd', content: 'D', count: 2, share: 0.5 },
  ], 'zeros and unstamped rows are not ranked');
  assert.deepEqual(plain(r.rankedLessons(lessons, 'failed', 1).map((x) => x.id)), ['b']);
});

test('overview: historyNote and healthTiles say what the window can show', () => {
  const r = overview();
  assert.match(r.historyNote(0, 7), /No turn history yet/);
  assert.match(r.historyNote(T0 - 2 * 86400000, 7, T0), /History starts .* \(2 days of 7 asked for\)/);
  assert.match(r.historyNote(T0 - 1000, 30, T0), /\(today of 30 asked for\)/);
  const tiles = r.healthTiles({ spoolDepth: 2, rejectedCount: 1, jobs: [{}, {}], marker: { captured: { ingested: 5, pending: 1 } }, breaker: { phase: 'open', state: 'unreachable', cooldownLeftMs: 4500 }, coldStart: { active: true, until: T0 } });
  assert.deepEqual(plain(tiles.map((t) => t.key)), ['spool', 'breaker', 'ingest', 'cold']);
  assert.equal(tiles[0].value, '2');
  assert.ok(tiles[1].sub.includes('5s left'), tiles[1].sub);
  assert.equal(tiles[2].value, '2');
  assert.equal(tiles[3].value, 'active');
  assert.equal(r.healthTiles(null).length, 4);
  assert.match(r.healthNote({ marker: { recall: { sources: 2 }, reflect: { status: 'ok', lessons_stored: 2 } } }), /last-write-wins/);
});

// ---------------------------------------------------------------------------
// Chart geometry
// ---------------------------------------------------------------------------

test('charts: scaleLinear, niceTicks, linePath, areaPath and sparkPoints are exact', () => {
  const r = charts();
  const y = r.scaleLinear([0, 10], [100, 0]);
  assert.equal(y(0), 100);
  assert.equal(y(10), 0);
  assert.equal(y(5), 50);
  assert.equal(r.scaleLinear([3, 3], [0, 100])(3), 50, 'a flat domain maps to the middle');
  assert.deepEqual(plain(r.niceTicks(0, 4)), [0, 1]);
  assert.deepEqual(plain(r.niceTicks(7, 4)), [0, 2, 4, 6, 8]);
  assert.deepEqual(plain(r.niceTicks(23, 4)), [0, 10, 20, 30]);
  assert.deepEqual(plain(r.niceTicks(1300, 4)), [0, 500, 1000, 1500]);
  for (const max of [1, 3, 9, 42, 999, 12345]) {
    const t = r.niceTicks(max, 4);
    assert.ok(t[t.length - 1] >= max, `ticks for ${max} stop at ${t[t.length - 1]}`);
    assert.ok(t.length >= 2 && t.length <= 7, `ticks for ${max}: ${t.length}`);
  }
  assert.equal(r.linePath([{ x: 0, y: 10 }, { x: 5.5, y: 2.25 }]), 'M0,10 L5.5,2.25');
  assert.equal(r.linePath([]), '');
  assert.equal(r.areaPath([{ x: 0, y: 10 }, { x: 5, y: 2 }], 20), 'M0,10 L5,2 L5,20 L0,20 Z');
  assert.equal(r.areaPath([], 20), '');
  assert.equal(r.sparkPoints([1, 1, 1], 100, 28), '0,14 50,14 100,14', 'a flat series is a line, not nothing');
  assert.equal(r.sparkPoints([], 100, 28), '');
  assert.match(r.sparkPoints([0, 10], 100, 28), /^0,26 100,2$/);
});

test('charts: stackedBars caps thickness, gaps segments in surface, rounds only the top, and hBars scales to the largest', () => {
  const r = charts();
  const rows = [{ worked: 2, neutral: 1, failed: 0, none: 0 }, { worked: 0, neutral: 0, failed: 0, none: 0 }, { worked: 0, neutral: 0, failed: 3, none: 0 }];
  const bars = r.stackedBars(rows, ['worked', 'neutral', 'failed', 'none'], { x0: 40, width: 300, height: 200, max: 4, maxBar: 24, segGap: 2 });
  assert.equal(bars.length, 3);
  assert.ok(bars.every((b) => b.w <= 24), 'never thicker than 24px');
  assert.deepEqual(plain(bars[0].segments.map((s) => [s.key, s.top])), [['worked', false], ['neutral', true]], 'only the last non-zero segment is the data-end');
  assert.equal(bars[0].segments[0].h, 100 - 2, 'a 2px gap comes off the lower segment');
  assert.equal(bars[0].segments[1].h, 50, 'the top segment keeps its full height');
  assert.equal(bars[0].total, 3);
  assert.deepEqual(plain(bars[1].segments), [], 'an empty day is an empty bar, not a zero-height rect');
  assert.equal(bars[2].segments[0].key, 'failed');
  assert.ok(bars[1].cx > bars[0].cx && bars[2].cx > bars[1].cx, 'left to right');
  assert.deepEqual(plain(r.stackedBars([], ['a'], {})), []);
  assert.deepEqual(plain(r.hBars([{ label: 'a', value: 4 }, { label: 'b', value: 2 }], 200)), [{ label: 'a', value: 4, w: 200 }, { label: 'b', value: 2, w: 100 }]);
  assert.deepEqual(plain(r.hBars([{ label: 'a', value: 0 }], 200)), [{ label: 'a', value: 0, w: 0 }], 'all zero is no bar, not a division by zero');
});

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

test('router: parseHash and buildHash round-trip page and context, and refuse what they do not know', () => {
  const r = router();
  assert.deepEqual(plain(r.PAGES), ['overview', 'turns', 'lessons', 'feed', 'health']);
  assert.deepEqual(plain(r.parseHash('')), { page: 'overview', params: {} });
  assert.deepEqual(plain(r.parseHash('#/turns')), { page: 'turns', params: {} });
  assert.deepEqual(plain(r.parseHash('#/turns?dir=%2Fa%2Fb&run=cc-x-00000001&turn=p1&q=hi')), { page: 'turns', params: { dir: '/a/b', run: 'cc-x-00000001', turn: 'p1', q: 'hi' } });
  assert.equal(r.parseHash('#/nope?dir=x').page, 'overview', 'an unknown page is the first one');
  assert.deepEqual(plain(r.parseHash('#/lessons?evil=1&lesson=l1').params), { lesson: 'l1' }, 'unknown keys are dropped');
  assert.deepEqual(plain(r.parseHash('#/overview?window=30&chart=cost').params), { window: '30', chart: 'cost' });
  assert.equal(r.buildHash('turns', { dir: '/a/b', run: 'cc-x-00000001', turn: 'p1', q: '' }), '#/turns?dir=%2Fa%2Fb&run=cc-x-00000001&turn=p1');
  assert.equal(r.buildHash('nope', {}), '#/overview');
  assert.equal(r.buildHash('health', null), '#/health');
  const h = r.buildHash('lessons', { dir: '/x y', lesson: 'ref_1', q: 'a&b' });
  assert.deepEqual(plain(r.parseHash(h)), { page: 'lessons', params: { dir: '/x y', lesson: 'ref_1', q: 'a&b' } }, 'round-trips through encoding');
});
