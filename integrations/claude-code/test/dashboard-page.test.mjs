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

/** Everything the region is expected to define. A missing name is a loud ReferenceError. */
const REGION_EXPORTS = [
  'SCOPE_VALUES', 'NO_PROJECT',
  'scopeOf', 'scopeKnown', 'leaksScope', 'fromOtherRun',
  'matchesScope', 'projectOf', 'matchesProject', 'matchesText',
];

const OPEN = '// #region scope-predicate';
const CLOSE = '// #endregion scope-predicate';

/**
 * The scope predicate, lifted out of the shipped page and evaluated on its own.
 *
 * Evaluating it in a context with no `document`, no `state` and no `$` is the point: if
 * anything in the region reaches for the page, the calls below throw rather than quietly
 * passing because a global happened to exist.
 */
function loadRegion() {
  const src = readFileSync(PAGE, 'utf8');
  const from = src.indexOf(OPEN);
  const to = src.indexOf(CLOSE);
  if (from < 0 || to < 0 || to < from) {
    assert.fail(
      `${PAGE} no longer contains the "${OPEN}" ... "${CLOSE}" markers.\n`
      + 'They are not decoration: this test slices the scope predicate out of the shipped page '
      + 'by those exact strings and executes it, so that the filter a browser runs is the one '
      + 'the truth table below covers. If the block moved, move the markers with it; if it was '
      + 'inlined into the render path, it is no longer testable and this test is now a lie.',
    );
  }

  const region = src.slice(from + OPEN.length, to);
  const ctx = vm.createContext({});
  vm.runInNewContext(
    `${region}\nglobalThis.region = { ${REGION_EXPORTS.join(', ')} };`,
    ctx,
    { filename: 'dashboard.html#scope-predicate' },
  );
  return ctx.region;
}

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
