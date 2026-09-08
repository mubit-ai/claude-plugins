// @ts-check
/**
 * `bin/dashboard.html` — the Memory tab's scope semantics, and nothing else.
 *
 * **Read this before adding to this file.** The dashboard page is one self-contained HTML file
 * with inline script, served from disk and never bundled. There is no DOM here and there will
 * not be one: jsdom would be the plugin's first runtime dependency, and this plugin ships with
 * zero. So the honest reach of this file is narrow, and saying so is more useful than a green
 * tick that implies more:
 *
 *   - **Event wiring is unverified.** Nothing here clicks the run segment, changes a select or
 *     presses Escape. That a listener is attached to the right element, and that it mutates the
 *     right key of `state`, is checked by reading the file and by opening the page.
 *   - **Rendering is unverified.** No assertion here proves a badge reaches the screen, that
 *     `clear()` emptied a node, or that the footer's numbers are the ones a person sees.
 *   - **Focus and keyboard order are unverified**, as is anything else that needs layout.
 *
 * What *is* verified is the part where being wrong is silent: the predicate that decides which
 * rows a scope filter keeps. It is sliced out of the shipped file by its region markers and
 * executed in a bare `node:vm` context, so the truth table below runs against the same source
 * a user's browser parses — not a copy of it that can drift.
 *
 * The second gate is the one that matters more over time. The page derives `leaksScope` itself
 * rather than reading the server's field, because three upstreams now feed the same list at
 * three fidelities. That is the right call and it is also exactly how a page and a server come
 * to disagree about what "visible outside its own run" means, so the third test pins them
 * together over the whole vocabulary.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { lib, PLUGIN_ROOT } from './helpers/harness.mjs';

const PAGE = join(PLUGIN_ROOT, 'bin', 'dashboard.html');

/** Everything the scope region is expected to define. A missing name is a loud ReferenceError. */
const REGION_EXPORTS = [
  'SCOPE_VALUES', 'NO_PROJECT',
  'scopeOf', 'scopeKnown', 'leaksScope', 'fromOtherRun',
  'matchesScope', 'projectOf', 'matchesProject', 'matchesText',
];

/** What the three view regions define. Each is sliced and executed the same way. */
const IDENTITY_EXPORTS = [
  'strategyLabel', 'scopeSentences', 'pathParts', 'parentRunId', 'runIdentity', 'sessionLabel',
  'shortSession', 'relativeTime', 'runStateTone', 'identitySignature',
];
const LESSON_EXPORTS = [
  'scopeTone', 'reachSentence', 'scopeCounts', 'typeCounts', 'dayKey', 'groupByDay', 'sortRows',
  'clockOf', 'storedLine', 'shortId', 'listEmptyMessage', 'footerParts', 'scopeNoteText',
];
const TURN_EXPORTS = [
  'turnMatches', 'rungText', 'usedCell', 'fmtInt', 'pct', 'tileSpecs', 'analyticsNote',
  'healthTileSpecs', 'healthNote',
];

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
 * One or more regions, lifted out of the shipped page and evaluated on their own.
 *
 * Evaluating them in a context with no `document`, no `state` and no `$` is the point: if
 * anything in a region reaches for the page, the calls below throw rather than quietly
 * passing because a global happened to exist. Regions are concatenated in the order given,
 * because the view regions build on the scope predicate and nothing else.
 *
 * @param {string|string[]} [names]
 * @param {string[]} [exports]
 */
function loadRegion(names = 'scope-predicate', exports = REGION_EXPORTS) {
  const src = readFileSync(PAGE, 'utf8');
  const list = Array.isArray(names) ? names : [names];
  const region = list.map((n) => sliceRegion(src, n)).join('\n');
  const ctx = vm.createContext({});
  vm.runInNewContext(
    `${region}\nglobalThis.region = { ${exports.join(', ')} };`,
    ctx,
    { filename: `dashboard.html#${list.join('+')}` },
  );
  return ctx.region;
}

/** Arrays and objects built inside the vm carry that realm's prototypes; compare them as data. */
const plain = (v) => JSON.parse(JSON.stringify(v));

const identity = () => loadRegion(['scope-predicate', 'identity-model'], [...REGION_EXPORTS, ...IDENTITY_EXPORTS]);
const lessons = () => loadRegion(['scope-predicate', 'lesson-view'], [...REGION_EXPORTS, ...LESSON_EXPORTS]);
const turns = () => loadRegion(['turn-view'], TURN_EXPORTS);

/**
 * The six shapes a row's scope arrives in. `''` and absent are separated on purpose — they are
 * the same rendering today and different facts, and the `unknown` filter is the only thing on
 * the page that can tell a person which one they are looking at.
 */
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

// ---------------------------------------------------------------------------
// 19
// ---------------------------------------------------------------------------

/**
 * The predicate, executed rather than read.
 *
 * Two entries in this table are the ones worth defending. `run` keeps an unrecorded row,
 * because such a lesson reads as `run` everywhere else it is asked for, and a page that hid it
 * from the run filter would disagree about where that lesson is visible. And `unknown`
 * overlaps `run` rather than replacing it: "nothing recorded a scope" is a second axis over
 * the same rows, and somebody auditing what leaks needs to be able to ask it separately.
 */
test('scope: the predicate keeps exactly the rows each filter claims', () => {
  const r = loadRegion();

  for (const c of ROWS) {
    assert.equal(r.scopeOf(c.row), c.scope, `scopeOf(${c.label})`);
    assert.equal(r.scopeKnown(c.row), c.known, `scopeKnown(${c.label})`);
    assert.equal(r.leaksScope(c.row), c.leaks, `leaksScope(${c.label})`);
  }

  // `undefined` spelled out, not merely an absent key — a search result carries the key.
  assert.equal(r.scopeOf({ scope: undefined }), 'run');
  assert.equal(r.scopeKnown({ scope: undefined }), false);
  assert.equal(r.leaksScope({ scope: undefined }), false);

  for (const [filter, kept] of Object.entries(FILTER_TABLE)) {
    for (const c of ROWS) {
      assert.equal(
        r.matchesScope(c.row, filter),
        kept.includes(c.label),
        `matchesScope(${c.label}, '${filter || 'every scope'}')`,
      );
    }
  }

  // `org` is promotion-only, so it is never written from here — but it filters like any other
  // exact value once a row carries it.
  assert.equal(r.matchesScope({ scope: 'org' }, 'org'), true);
  assert.equal(r.matchesScope({ scope: 'global' }, 'org'), false);

  // An explicit `scopeKnown` off the wire wins over the shape of the row. A row can say "run"
  // out loud *because the server defaulted it*, and only the flag carries that.
  assert.equal(r.scopeKnown({ scope: 'run', scopeKnown: false }), false);
  assert.equal(r.matchesScope({ scope: 'run', scopeKnown: false }, 'unknown'), true);
  assert.equal(r.matchesScope({ scope: 'run', scopeKnown: false }, 'run'), true);
  assert.equal(r.scopeKnown({ scope: '', scopeKnown: true }), true);
  assert.equal(r.matchesScope({ scope: '', scopeKnown: true }, 'unknown'), false);

  // Where a row was written, which is a fact about the reader's position and not about reach.
  assert.equal(r.fromOtherRun({ sourceRunId: 'a' }, 'a'), false);
  assert.equal(r.fromOtherRun({ sourceRunId: 'a' }, 'b'), true);
  assert.equal(r.fromOtherRun({ sourceRunId: '' }, 'b'), false);
  assert.equal(r.fromOtherRun({ sourceRunId: 'a' }, ''), false);
  assert.equal(r.fromOtherRun({ run_id: 'a' }, 'b'), true, 'the activity feed spells it run_id');
  assert.equal(r.fromOtherRun({}, 'b'), false);

  // The project facet is a display axis with an explicit unattributed bucket. An untagged row
  // is never claimed for the current project, so it lands in a bucket of its own.
  assert.equal(r.projectOf({ project: 'github.com/mubit-ai/x' }), 'github.com/mubit-ai/x');
  assert.equal(r.projectOf({ project: '' }), r.NO_PROJECT);
  assert.equal(r.projectOf({}), r.NO_PROJECT);
  assert.notEqual(r.NO_PROJECT, '', 'the empty string already means "every project" on the select');
  assert.equal(r.matchesProject({ project: 'a' }, ''), true);
  assert.equal(r.matchesProject({ project: 'a' }, 'a'), true);
  assert.equal(r.matchesProject({ project: 'a' }, 'b'), false);
  assert.equal(r.matchesProject({}, r.NO_PROJECT), true);
  assert.equal(r.matchesProject({ project: 'a' }, r.NO_PROJECT), false);

  // D7, the regression this exists to prevent: scope used to be concatenated into the
  // free-text haystack, so the word a person types *at a scope filter* matched every row.
  const session = { content: 'never edit the mirror', scope: 'session', sourceRunId: 'abc' };
  assert.equal(r.matchesText(session, 'run'), false, 'scope must not be searchable as text');
  assert.equal(r.matchesText(session, 'mirror'), true);
  assert.equal(r.matchesText(session, ''), true);
  assert.equal(r.matchesText({ content: 'x', run_id: 'run-77' }, 'run-77'), true);
});

// ---------------------------------------------------------------------------
// 20
// ---------------------------------------------------------------------------

/**
 * The drift guard.
 *
 * The page computes `leaksScope` itself instead of rendering the server's, and it has to: a
 * `/api/search` row has no scope at all, so trusting the wire would mean trusting a field that
 * is sometimes absent and sometimes a default. The cost of deriving it is that two
 * implementations of "visible outside its own run" now exist, in two languages of the same
 * codebase, and nothing but this test notices when one of them moves.
 */
test('scope: the page and lib/dashboard-api.mjs agree on what leaks', async () => {
  const r = loadRegion();
  const { normalizeLesson } = await lib('dashboard-api.mjs');

  const wire = [
    { label: 'run', raw: { content: 'a', scope: 'run' } },
    { label: 'session', raw: { content: 'a', scope: 'session' } },
    { label: 'global', raw: { content: 'a', scope: 'global' } },
    { label: 'org', raw: { content: 'a', scope: 'org' } },
    { label: 'empty', raw: { content: 'a', scope: '' } },
    { label: 'absent', raw: { content: 'a' } },
  ];

  for (const c of wire) {
    const row = normalizeLesson(c.raw, { currentRun: 'run-1' });
    assert.equal(
      r.leaksScope(row), row.leaksScope,
      `the page and the server disagree about whether a ${c.label}-scope lesson leaks: `
      + `page says ${r.leaksScope(row)}, lib/dashboard-api.mjs says ${row.leaksScope}`,
    );
    // Whatever the server normalises an absent scope to, the page must land on a value from
    // the same vocabulary rather than inventing a fifth bucket for it.
    assert.ok(
      r.SCOPE_VALUES.includes(r.scopeOf(row)),
      `scopeOf() produced "${r.scopeOf(row)}" for a ${c.label}-scope lesson, which is not one `
      + `of ${r.SCOPE_VALUES.join(' | ')}`,
    );
  }

  // The same, for the other field the page re-derives.
  for (const currentRun of ['run-1', 'run-2', '']) {
    const row = normalizeLesson({ content: 'a', source_run_id: 'run-1' }, { currentRun });
    assert.equal(
      r.fromOtherRun(row, currentRun), row.fromOtherRun,
      `fromOtherRun disagrees with the server for currentRun="${currentRun}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// 21
// ---------------------------------------------------------------------------

/** The one function whose body is asserted over, sliced by brace matching rather than regex. */
function fnBody(src, signature) {
  const at = src.indexOf(signature);
  assert.ok(at >= 0, `bin/dashboard.html no longer contains "${signature}"`);
  let depth = 0;
  let i = src.indexOf('{', at);
  const start = i;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  assert.fail(`could not find the end of ${signature}`);
  return '';
}

/**
 * Structural facts about the shipped markup that the predicate cannot reach.
 *
 * Each of these is a bug that shipped once: a filter whose vocabulary was a third of the
 * server's, a search mapper that stamped a scope onto rows that had none, and a badge rendered
 * behind a truthiness check that an unrecorded scope always fails.
 */
test('scope: the shipped page offers the whole vocabulary and claims no scope it was not told', () => {
  const src = readFileSync(PAGE, 'utf8');

  // D3. `run | session | global | org` is the instance's vocabulary; `leak` and `unknown` are
  // the two questions asked across it. All six, plus "every scope", must be reachable.
  for (const value of ['', 'run', 'leak', 'session', 'global', 'org', 'unknown']) {
    assert.ok(
      src.includes(`<option value="${value}"`),
      `the scope filter offers no <option value="${value}">. `
      + 'A vocabulary the page cannot express is a question a person cannot ask.',
    );
  }

  // `org` is written by promotion and never by a client, so it must not be *offered* until
  // something carries it — otherwise it is a filter guaranteed to return nothing.
  const orgOption = src.slice(src.indexOf('<option value="org"'));
  assert.match(
    orgOption.slice(0, orgOption.indexOf('>') + 1), /hidden/,
    'the org option must start hidden and be revealed only when a loaded row carries org scope',
  );

  // D5. Search evidence carries no scope. Stamping one on made every result read as run-scoped,
  // which silently emptied the list under any active scope filter.
  const search = fnBody(src, 'async function searchInstance()');
  assert.doesNotMatch(search, /\bscope:\s*''/, 'the search mapper must not invent a scope');
  assert.doesNotMatch(search, /\bleaksScope:\s*false/, 'the search mapper must not invent leaksScope');
  assert.doesNotMatch(search, /\bscope:\s*""/, 'the search mapper must not invent a scope');

  // D5, the other half. A badge behind `if (e.scope)` disappears for exactly the rows whose
  // scope a person most needs to see — the ones nothing recorded a scope for.
  assert.doesNotMatch(
    src, /if\s*\(\s*e\.scope\s*\)/,
    'the scope badge must render for every row, including one with no recorded scope',
  );
  assert.ok(
    src.includes('function scopeBadge('),
    'the badge should go through one helper, so "always rendered" is enforced in one place',
  );

  // D1. The lessons fetch must be able to ask for every run, and `currentRun` is a rendering
  // context rather than a filter, so it is sent separately and always.
  assert.ok(
    src.includes("'run=' + encodeURIComponent(state.allRuns ? '' : state.run)"),
    'the Memory fetch must send an empty run when All runs is selected — an empty run is the '
    + 'only way upstream returns lessons other runs wrote',
  );
  assert.ok(src.includes('currentRun='), 'currentRun must be sent for fromOtherRun to mean anything');

  // D7. A failed fetch and an empty instance must not render the same sentence.
  assert.ok(src.includes('Could not load lessons from the instance.'));
  assert.doesNotMatch(src, /'No lessons match\.'/, 'the ambiguous empty-state string is gone');

  // Every control added for this work is reachable without sight. The two segment buttons carry
  // aria-pressed because they are toggles; the two selects carry aria-label because their only
  // visible label is the option text.
  for (const id of ['runs-this', 'runs-all']) {
    const tagText = src.slice(src.indexOf(`id="${id}"`));
    assert.match(
      tagText.slice(0, tagText.indexOf('>')), /aria-pressed=/,
      `#${id} is a toggle and must carry aria-pressed`,
    );
  }
  for (const id of ['scope-filter', 'project-filter']) {
    const tagText = src.slice(src.indexOf(`id="${id}"`));
    assert.match(
      tagText.slice(0, tagText.indexOf('>')), /aria-label=/,
      `#${id} has no visible label of its own and must carry aria-label`,
    );
  }
  // The one control built in script rather than markup.
  const footer = fnBody(src, 'function renderMemoryFooter()');
  assert.match(
    footer, /setAttribute\('aria-label'/,
    'the "Show every scope" escape hatch is created in script and must set its own aria-label',
  );

  // The page is served under `default-src 'self'` with no connect-src beyond its own origin,
  // so a stray absolute URL is a control that silently does nothing in a browser.
  assert.doesNotMatch(
    src.slice(src.indexOf('<script>')), /["'`]https?:\/\/(?!www\.w3\.org)/,
    'the page must stay self-contained; the CSP blocks every external origin',
  );
});

// ---------------------------------------------------------------------------
// The identity strip
// ---------------------------------------------------------------------------

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

// Every "ago" and every day header is computed from a clock the caller passes, never from
// `Date.now()` inside the region — which is what lets this table be exact.
test('identity: relativeTime, dayKey and groupByDay agree with a fixed clock', () => {
  const r = loadRegion(
    ['scope-predicate', 'identity-model', 'lesson-view'],
    [...REGION_EXPORTS, ...IDENTITY_EXPORTS, ...LESSON_EXPORTS],
  );
  const now = localNoon();

  assert.equal(r.relativeTime(now - 3_000, now), 'just now');
  assert.equal(r.relativeTime(now - 12_000, now), '12s ago');
  assert.equal(r.relativeTime(now - 120_000, now), '2m ago');
  assert.equal(r.relativeTime(now - 3 * H, now), '3h ago');
  assert.equal(r.relativeTime(now - 2 * 24 * H, now), '2d ago');
  assert.equal(r.relativeTime(now + 5_000, now), 'just now', 'a clock skewed into the future is not "in 5s"');
  assert.equal(r.relativeTime(0, now), '—');
  assert.equal(r.relativeTime(undefined, now), '—');

  const iso = (ms) => new Date(ms).toISOString();
  assert.equal(r.dayKey(iso(now - H), now), 'Today');
  assert.equal(r.dayKey(iso(now - 24 * H), now), 'Yesterday');
  assert.equal(r.dayKey(iso(now - 72 * H), now), ymd(now - 72 * H));
  assert.equal(r.dayKey('', now), 'Undated');
  assert.equal(r.dayKey('not a date', now), 'Undated');
  assert.equal(r.dayKey(undefined, now), 'Undated');

  assert.equal(r.clockOf(iso(now)), '12:00', 'HH:MM, local, 24-hour');
  assert.equal(r.clockOf(''), '—');

  const rows = [
    { id: 'a', createdAt: iso(now - H) },
    { id: 'b', createdAt: iso(now - 24 * H) },
    { id: 'c', created_at: iso(now - 2 * H) },
    { id: 'd' },
    { id: 'e', createdAt: iso(now - 72 * H) },
  ];
  const groups = r.groupByDay(rows, now, 'newest');
  assert.deepEqual(plain(groups.map((g) => g.key)), ['Today', 'Yesterday', ymd(now - 72 * H), 'Undated']);
  assert.deepEqual(plain(groups[0].rows.map((x) => x.id)), ['a', 'c'], 'newest first inside a day, and created_at counts too');
  assert.deepEqual(plain(groups[3].rows.map((x) => x.id)), ['d']);
});

/**
 * The strip names the newest session as the one the page is "in", and the directory comes
 * from the run row's join — with the launch directory as the fallback for the launch run,
 * which is the one run that can be identified without a session record at all.
 */
test('identity: runIdentity picks the newest session and falls back to the launch directory', () => {
  const r = identity();
  const meta = { launch: { cwd: '/home/user/proj', projectDir: '/home/user/proj', run: 'cc-here-00000001' } };
  const sessions = [
    { sessionId: 's-new', runId: 'cc-here-00000001', agentId: 'claude-code', lastSeenAt: 300, createdAt: 100, clearCount: 1, projectDir: '/home/user/proj/sub', projectRoot: '/home/user/proj' },
    { sessionId: 's-old', runId: 'cc-here-00000001', agentId: 'claude-code', lastSeenAt: 200, createdAt: 50, clearCount: 2, projectDir: '/home/user/proj', projectRoot: '/home/user/proj' },
  ];
  const row = { runId: 'cc-here-00000001', state: 'ready', mode: 'hosted', lastWrite: 400, sessions, sessionCount: 2, projectDir: '/home/user/proj/sub', projectRoot: '/home/user/proj' };

  const id = r.runIdentity(row, meta, [row]);
  assert.equal(id.runId, 'cc-here-00000001');
  assert.equal(id.isLaunchRun, true);
  assert.equal(id.newest.sessionId, 's-new', 'sessions arrive newest first and the strip names the first');
  assert.equal(id.sessionCount, 2);
  assert.equal(id.clearTotal, 3);
  assert.equal(id.projectDir, '/home/user/proj/sub');
  assert.equal(id.projectRoot, '/home/user/proj');
  assert.equal(id.state, 'ready');
  assert.equal(id.mode, 'hosted');
  assert.equal(id.lastWrite, 400);

  // The launch run with no session record yet: the directory is still known, because the
  // server said where it was launched from.
  const bare = r.runIdentity({ runId: 'cc-here-00000001', state: 'ready' }, meta, []);
  assert.equal(bare.isLaunchRun, true);
  assert.equal(bare.sessionCount, 0);
  assert.equal(bare.newest, null);
  assert.equal(bare.projectDir, '/home/user/proj', 'the launch directory is the fallback for the launch run');
  assert.equal(bare.projectRoot, '');

  // Any other run with no record has no directory. Guessing one would be worse than blank.
  const other = r.runIdentity({ runId: 'cc-else-00000002', state: 'unknown' }, meta, []);
  assert.equal(other.isLaunchRun, false);
  assert.equal(other.projectDir, '');
  assert.equal(other.state, 'unknown');

  // A subagent marker borrows the parent's sessions: nothing is stored under a sub-run id.
  const sub = r.runIdentity({ runId: 'cc-here-00000001-sub-abc' }, meta, [row]);
  assert.equal(sub.sessionCount, 2);
  assert.equal(sub.isLaunchRun, true);
  assert.equal(sub.projectDir, '/home/user/proj/sub');

  assert.equal(r.runIdentity(null, null, null).runId, '', 'nothing selected is a blank strip, not a throw');
  assert.equal(r.identitySignature(id), r.identitySignature(r.runIdentity(row, meta, [row])), 'stable across polls');
  assert.notEqual(r.identitySignature(id), r.identitySignature(bare));

  assert.equal(r.runStateTone('ready'), 'ok');
  assert.equal(r.runStateTone('unreachable'), 'bad');
  assert.equal(r.runStateTone('auth_failed'), 'bad');
  assert.equal(r.runStateTone('unknown'), 'muted');
  assert.equal(r.runStateTone(''), 'muted');

  assert.equal(r.shortSession('01a08f3e-1111-2222-3333-444444444e11'), '01a08…e11');
  assert.equal(r.shortSession(''), '—');
  const label = r.sessionLabel(sessions[0], 1000);
  assert.ok(label.includes('s-new') && label.includes('claude-code') && label.includes('cleared 1×'), label);

  assert.deepEqual(plain(r.pathParts('/home/user/proj')), { full: '/home/user/proj', head: '/home/user/', tail: 'proj' });
  assert.deepEqual(plain(r.pathParts('')), { full: '', head: '', tail: '' });
  assert.deepEqual(plain(r.pathParts('proj')), { full: 'proj', head: '', tail: 'proj' });
});

// `session`, `auto` and `per-directory` are not answers a person can use. Every value of every
// setting has to render as a different sentence, and the server's wording wins when it is there.
test('identity: scopeSentences has a distinct sentence for every strategy, ceiling and cross-run value', () => {
  const r = identity();
  const distinct = (values, fn) => {
    const seen = new Set(values.map(fn));
    assert.equal(seen.size, values.length, JSON.stringify([...seen]));
  };
  distinct(['per-directory', 'git-branch', 'per-conversation', 'static'], (v) => r.strategyLabel(v));
  distinct(['run', 'session', 'global'], (v) => r.scopeSentences({ writesAt: v }).writes);
  distinct(['auto', 'on', 'off'], (v) => r.scopeSentences({ readsAcrossRuns: v }).reads);

  const s = r.scopeSentences({
    writesAt: 'session', writesAtText: 'the server wording', readsAcrossRuns: 'auto', readsAcrossRunsText: 'and this one',
  });
  assert.match(s.writes, /^Writes: /);
  assert.ok(s.writes.includes('the server wording'), s.writes);
  assert.ok(s.writes.includes('(cap: session)'), 'the setting value is still named, for the person who has to change it');
  assert.match(s.reads, /^Reads: /);
  assert.ok(s.reads.includes('and this one') && s.reads.includes('(cross-run: auto)'), s.reads);

  const none = r.scopeSentences(null);
  assert.ok(none.writes.length > 20 && none.reads.length > 20, 'an old server with no scope block still gets the defaults');
  assert.ok(r.strategyLabel('custom').includes('custom'), 'an unknown strategy is named, not blanked');
});

test('identity: parentRunId strips a subagent suffix and nothing else', () => {
  const r = identity();
  assert.equal(r.parentRunId('cc-pre-main-af449e06-sub-1a2b3c'), 'cc-pre-main-af449e06');
  assert.equal(r.parentRunId('cc-pre-main-af449e06'), 'cc-pre-main-af449e06');
  assert.equal(r.parentRunId('cc-subject-000001'), 'cc-subject-000001', '"sub" inside a word is not the marker');
  assert.equal(r.parentRunId('-sub-x'), '-sub-x', 'a suffix with no parent before it is left alone');
  assert.equal(r.parentRunId(''), '');
  assert.equal(r.parentRunId(undefined), '');
});

// ---------------------------------------------------------------------------
// The lesson list
// ---------------------------------------------------------------------------

// The question the tab exists to answer is "what was stored, in what order". An undated row
// has no place in that order, so it goes last whichever way the list is sorted — never first
// because an empty string compares low.
test('lessons: sortRows and groupByDay put undated rows last in both orders', () => {
  const r = lessons();
  const now = localNoon();
  const iso = (ms) => new Date(ms).toISOString();
  const rows = [
    { id: 'undated-1' },
    { id: 'old', createdAt: iso(now - 72 * H) },
    { id: 'new', createdAt: iso(now - H) },
    { id: 'undated-2', createdAt: '' },
    { id: 'mid', created_at: iso(now - 24 * H) },
  ];
  assert.deepEqual(plain(r.sortRows(rows, 'newest').map((x) => x.id)), ['new', 'mid', 'old', 'undated-1', 'undated-2']);
  assert.deepEqual(plain(r.sortRows(rows, 'oldest').map((x) => x.id)), ['old', 'mid', 'new', 'undated-1', 'undated-2']);
  assert.deepEqual(rows.map((x) => x.id), ['undated-1', 'old', 'new', 'undated-2', 'mid'], 'the input is not mutated');

  const oldest = r.groupByDay(rows, now, 'oldest');
  assert.deepEqual(plain(oldest.map((g) => g.key)), [ymd(now - 72 * H), 'Yesterday', 'Today', 'Undated']);
  assert.equal(oldest[3].rows.length, 2);
  assert.deepEqual(plain(r.groupByDay([], now, 'newest')), []);
});

// The chip row is labelled with the numbers of the rows under it — counted the same way the
// filter keeps them, so `run` includes the unrecorded rows and `unknown` counts them again.
test('lessons: scopeCounts and typeCounts count what the list will show', () => {
  const r = lessons();
  const rows = [
    { scope: 'run', lessonType: 'rule' },
    { scope: 'run', lessonType: 'rule' },
    { scope: 'session', lessonType: 'fact' },
    { scope: 'global', lessonType: 'rule' },
    { scope: '', lessonType: 'rule' },
    { entry_type: 'trace' },
    { scope: 'org', lessonType: 'rule' },
  ];
  const c = r.scopeCounts(rows);
  assert.equal(c.run, 4, 'two recorded, two defaulted — the run filter keeps all four');
  assert.equal(c.session, 1);
  assert.equal(c.global, 1);
  assert.equal(c.org, 1);
  assert.equal(c.unknown, 2, 'the two rows nothing recorded a scope for');
  assert.deepEqual(plain(r.scopeCounts([])), { run: 0, session: 0, global: 0, org: 0, unknown: 0 });

  assert.deepEqual(plain(r.typeCounts(rows)), [
    { key: 'rule', count: 5 }, { key: 'fact', count: 1 }, { key: 'trace', count: 1 },
  ], 'by count, then by name; the activity feed spells it entry_type');

  assert.equal(r.scopeTone({ scope: 'global' }), 'shared');
  assert.equal(r.scopeTone({ scope: 'run' }), 'local');
  assert.equal(r.scopeTone({}), 'unknown');
  assert.equal(r.scopeTone({ scope: 'run', scopeKnown: false }), 'unknown');

  const line = r.storedLine({ createdAt: '2026-09-05T10:11:12.000Z', sourceRunId: 'cc-a-1', source: 'reflection', scope: 'session' }, 'cc-b-2');
  assert.match(line, /^Stored /);
  assert.ok(line.includes('2026-09-05T10:11:12.000Z'), 'the ISO stamp is there for the person who wants it exact');
  assert.ok(line.includes('by run cc-a-1 (not the selected run)'), line);
  assert.ok(line.includes('via reflection at session scope (recorded)'), line);
  const bare = r.storedLine({}, 'cc-b-2');
  assert.ok(bare.includes('did not record') && bare.includes('at run scope (defaulted)'), bare);

  assert.equal(r.reachSentence({ scope: 'global' }).length > 20, true);
  assert.ok(r.reachSentence({}).includes('default'), 'an unrecorded scope says it is the default');

  assert.equal(r.listEmptyMessage({ mode: 'lessons', error: 'boom' }).text, 'Could not load lessons from the instance.');
  assert.equal(r.listEmptyMessage({ mode: 'lessons', error: 'boom' }).detail, 'boom');
  assert.equal(r.listEmptyMessage({ mode: 'lessons', loaded: false }).kind, 'loading');
  assert.match(r.listEmptyMessage({ mode: 'lessons', loaded: true, total: 7 }).text, /7 loaded/);
  assert.match(r.listEmptyMessage({ mode: 'lessons', loaded: true, total: 0, allRuns: true }).text, /any run/);
  assert.match(r.listEmptyMessage({ mode: 'activity', loaded: true, total: 0, allRuns: false }).text, /activity.*this run/);

  const parts = r.footerParts({
    shown: 1, hidden: 2, mode: 'lessons', search: false,
    census: { totalVisible: 40, source: 'activity', truncated: true, pages: 2, truncatedReason: 'deadline', unknownScope: 3 },
  });
  assert.equal(parts[0], '1 result');
  assert.ok(parts.includes('2 hidden by the scope filter'));
  assert.ok(parts.includes('40 visible to this instance'));
  assert.ok(parts.some((p) => p.includes('stopped after 2 pages (deadline)')), JSON.stringify(parts));
  assert.ok(parts.includes('3 with no recorded scope'));
  const searching = r.footerParts({ shown: 2, mode: 'lessons', search: true, searchQuery: 'mirror', census: { totalVisible: 40 } });
  assert.ok(!searching.some((p) => p.includes('visible to this instance')), 'a search answer is not a census');
  assert.ok(searching.some((p) => p.includes('mirror')));
  assert.match(r.scopeNoteText({ mode: 'lessons', allRuns: true }), /every run/);
  assert.match(r.scopeNoteText({ mode: 'lessons', allRuns: false, joinError: 'x' }), /selected in the rail.*x/s);
});

// ---------------------------------------------------------------------------
// The turns table
// ---------------------------------------------------------------------------

// `used` has three states and the third is not `false`; `rung 0` is "no reading", not a rung.
// Both are places where a cell that looks like a number libels the retrieval path.
test('turns: usedCell is tri-state and rungText renders zero as unrecorded', () => {
  const r = turns();
  const yes = r.usedCell({ used: true, matched: 2, candidates: 4 });
  assert.equal(yes.text, '2/4');
  assert.equal(yes.tone, 'ok');
  const no = r.usedCell({ used: false, matched: 0, candidates: 4 });
  assert.equal(no.text, '0/4');
  assert.notEqual(no.tone, 'ok');
  assert.notEqual(no.tone, 'bad', 'a "no" is weak evidence and must not be painted as a failure');
  const unknown = r.usedCell({ used: null, matched: 0, candidates: 0, reason: 'no_reply' });
  assert.equal(unknown.text, '?', 'never "0/0", which reads as a measured zero');
  assert.ok(unknown.title.includes('no_reply') && unknown.title.includes('not "unused"'), unknown.title);
  assert.equal(r.usedCell(undefined).text, '?');
  assert.equal(r.usedCell({}).text, '?');

  assert.equal(r.rungText(0), '—');
  assert.equal(r.rungText(undefined), '—');
  assert.equal(r.rungText(1), '1');
  assert.equal(r.rungText(2), '2');

  assert.equal(r.turnMatches({ promptPreview: 'Rebuild the bundle', outcomeState: 'sent' }, 'bundle'), true);
  assert.equal(r.turnMatches({ promptPreview: 'Rebuild the bundle', outcomeState: 'sent' }, 'sent'), true);
  assert.equal(r.turnMatches({ promptPreview: 'Rebuild the bundle', outcomeState: 'sent' }, 'nope'), false);
  assert.equal(r.turnMatches({}, ''), true);

  assert.equal(r.fmtInt(1234567), '1,234,567');
  assert.equal(r.fmtInt(0), '0');
  assert.equal(r.fmtInt(undefined), '0');
  assert.equal(r.pct(0.5), '50%');
  assert.equal(r.pct(undefined), '0%');

  const tiles = r.tileSpecs({ points: 14, averages: { tok: 120, sources: 3.5, chars: 480 }, pointerRatio: 0.25, series: [{ tok: 1 }, { tok: 2 }] });
  assert.equal(tiles.length, 4);
  for (const t of tiles) {
    for (const k of ['key', 'value', 'unit', 'method']) assert.equal(typeof t[k], 'string', `tile.${k}`);
    assert.ok(Array.isArray(t.series));
  }
  assert.ok(tiles[0].method.includes('14 prompts'), tiles[0].method);
  assert.equal(tiles[2].value, '25%');
  assert.match(r.analyticsNote({ points: 0 }), /starts empty/);
  assert.match(r.analyticsNote({ points: 3, firstSampleAt: 1_700_000_000_000 }), /3 prompts/);

  const ht = r.healthTileSpecs({ spoolDepth: 2, rejectedCount: 1, marker: { state: 'ready', captured: { ingested: 5, pending: 1, tools: 2 } }, breaker: { phase: 'open', state: 'unreachable', cooldownLeftMs: 4500 } });
  assert.equal(ht.length, 4);
  assert.ok(ht[2].method.includes('5s left'), ht[2].method);
  assert.match(r.healthNote({ marker: { recall: { sources: 2, tokens: 30, rung: 1, dry_streak: 0 }, reflect: { status: 'ok', lessons_stored: 2 } } }), /last-write-wins/);
});
