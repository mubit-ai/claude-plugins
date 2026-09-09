// @ts-check
/**
 * `bin/dashboard.html` — the markup and the stylesheet, as strings.
 *
 * `dashboard-browser.test.mjs` is where the page is executed; this file asserts the facts
 * about it that can be read off its text: that every element the script reaches for exists,
 * that the brand tokens are the ones the rest of the plugin uses, that the page stays
 * self-contained under its own CSP, and that the responsive rules collapse things behind a
 * visible control rather than hiding them.
 *
 * The last one is the property this file is really for. "Nothing is hidden" is enforced as:
 * inside a `@media` block, `display: none` may be applied to the rail and to the button that
 * opens it, and to nothing else.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PLUGIN_ROOT } from './helpers/harness.mjs';

const PAGE = join(PLUGIN_ROOT, 'bin', 'dashboard.html');
const src = () => readFileSync(PAGE, 'utf8');

/** The `<style>` block, the markup between it and the script, and the script. */
function parts(text) {
  const styleFrom = text.indexOf('<style>');
  const styleTo = text.indexOf('</style>');
  const scriptFrom = text.indexOf('<script>');
  assert.ok(styleFrom >= 0 && styleTo > styleFrom && scriptFrom > styleTo, 'the page is one <style>, markup, one <script>');
  return {
    css: text.slice(styleFrom + '<style>'.length, styleTo),
    html: text.slice(styleTo, scriptFrom),
    js: text.slice(scriptFrom),
  };
}

/** The body of the first `{ ... }` block after `signature`, by brace matching. */
function block(text, signature) {
  const at = text.indexOf(signature);
  assert.ok(at >= 0, `no "${signature}" in the stylesheet`);
  let depth = 0;
  const start = text.indexOf('{', at);
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return assert.fail(`unterminated block after "${signature}"`);
}

/** Every `@media (...)` block: its query and its body. */
function mediaBlocks(css) {
  const out = [];
  const re = /@media\s*([^{]+)\{/g;
  let m;
  while ((m = re.exec(css))) {
    out.push({ query: m[1].trim(), body: block(css, m[0].slice(0, -1)) });
  }
  return out;
}

/** `selector { declarations }` pairs inside one flat block. */
function rules(body) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(body))) out.push({ selector: m[1].trim(), decl: m[2] });
  return out;
}

/** The opening tag of the element with `id`. */
function openTag(html, id) {
  const at = html.indexOf(`id="${id}"`);
  assert.ok(at >= 0, `no id="${id}"`);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

// ---------------------------------------------------------------------------
// The elements the script needs
// ---------------------------------------------------------------------------

const REQUIRED_IDS = [
  'rail', 'rail-toggle', 'dirs', 'runs', 'endpoint',
  'page-title', 'page-desc', 'ctx-line', 'conn', 'conn-text', 'theme',
  'banner', 'banner-title', 'banner-text', 'banner-code',
  'nav-overview', 'nav-turns', 'nav-lessons', 'nav-feed', 'nav-health', 'nav-turns-n', 'nav-lessons-n',
  'page-overview', 'page-turns', 'page-lessons', 'page-feed', 'page-health',
  'window-seg', 'win-7', 'win-14', 'win-30', 'overview-note', 'kpis',
  'chart-tabs', 'ctab-outcomes', 'ctab-injected', 'ctab-cost', 'chart-caption', 'chart', 'chart-tip', 'chart-legend',
  'rank-worked', 'rank-failed', 'scope-details', 'scope-text',
  'turn-q', 'turn-session', 'turn-outcome', 'turn-injected', 'turn-cols', 'turn-cols-menu', 'turn-count', 'turn-table', 'turn-rows',
  'lesson-q', 'view-here', 'view-reach', 'view-all', 'scope-filter', 'project-filter', 'origin-filter', 'do-search',
  'lesson-cols', 'lesson-cols-menu', 'lesson-table', 'lesson-rows', 'lesson-footer',
  'feed-note', 'feed-table', 'feed-rows', 'health-tiles', 'health-note',
  'scrim', 'drawer', 'drawer-title', 'drawer-close', 'drawer-body', 'menu', 'toast',
];

test('layout: every element the page is built around is in the markup', () => {
  const { html } = parts(src());
  for (const id of REQUIRED_IDS) {
    assert.ok(html.includes(`id="${id}"`), `the markup has no id="${id}"`);
  }
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dup, [], 'an id used twice is an element getElementById never returns');
});

/**
 * `$('x')` for an `x` that is not in the markup is `null`, and the first property read on it
 * is an exception in a render path — which the poll swallows, so the page just stops updating.
 */
test('layout: every $(\'literal\') in the script names an element the markup has', () => {
  const { html, js } = parts(src());
  const literal = [...js.matchAll(/\$\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  assert.ok(literal.length > 20, 'the script reaches for the page by id; if this fell to nothing the pattern changed');
  for (const id of new Set(literal)) {
    assert.ok(html.includes(`id="${id}"`), `$('${id}') has no id="${id}" to find`);
  }
  // The dynamic forms are allow-listed by shape, so a new one is a conscious addition. Each
  // one's prefix is checked against every id it can produce.
  const dynamic = [...js.matchAll(/\$\(\s*(?!')([^)]*)\)/g)].map((m) => m[1].trim());
  const allowed = {
    "'page-' + k": ['overview', 'turns', 'lessons', 'feed', 'health'].map((k) => `page-${k}`),
    "'nav-' + k": ['overview', 'turns', 'lessons', 'feed', 'health'].map((k) => `nav-${k}`),
    "'win-' + n": ['win-7', 'win-14', 'win-30'],
    "'ctab-' + k": ['ctab-outcomes', 'ctab-injected', 'ctab-cost'],
    "'view-' + v": ['view-here', 'view-reach', 'view-all'],
    id: [],
  };
  for (const arg of new Set(dynamic)) {
    assert.ok(arg in allowed, `$(${arg}) is not one of the allowed dynamic lookups`);
    for (const id of allowed[arg]) assert.ok(html.includes(`id="${id}"`), `$(${arg}) can produce "${id}", which the markup lacks`);
  }
});

// ---------------------------------------------------------------------------
// The tokens
// ---------------------------------------------------------------------------

/** The colour tokens the whole plugin's UI is built on. Values, not names: they must not move. */
const DARK = [
  '--bg: hsl(28 9% 8%);', '--panel: hsl(28 10% 10%);', '--panel-2: hsl(28 10% 13%);',
  '--border: hsl(28 9% 21%);', '--text: hsl(32 10% 85%);', '--muted: hsl(30 9% 60%);',
  '--accent: hsl(16 100% 55%);', '--accent-dim: hsl(16 100% 55% / 0.14);',
  '--success: hsl(142 50% 50%);', '--danger: hsl(0 72% 58%);', '--danger-dim: hsl(0 72% 58% / 0.12);',
  '--warning: hsl(38 92% 58%);',
];
const LIGHT = [
  '--bg: hsl(32 36% 97%);', '--panel: hsl(36 50% 99%);', '--panel-2: hsl(32 30% 95%);',
  '--border: hsl(30 18% 84%);', '--text: hsl(30 22% 14%);', '--muted: hsl(30 10% 42%);',
  '--accent: hsl(16 100% 50%);', '--accent-dim: hsl(16 100% 50% / 0.12);',
  '--success: hsl(149 70% 33%);', '--danger: hsl(0 82% 54%);', '--danger-dim: hsl(0 82% 54% / 0.10);',
  '--warning: hsl(31 92% 46%);',
];
const ADDED = [
  '--warning-dim:', '--success-dim:', '--hair:', '--hair-strong:', '--accent-ink:', '--surface-hover:',
  '--s1:', '--s2:', '--s3:', '--space-1:', '--space-6:', '--sidebar-w: 232px;', '--col-max:', '--track:', '--r-pill: 999px;',
];
/** Every token that has a dark value needs a light one in both light blocks, or it leaks across the theme. */
const THEMED = ['--warning-dim:', '--success-dim:', '--hair:', '--hair-strong:', '--accent-ink:', '--surface-hover:', '--s1:', '--s2:', '--s3:'];

test('layout: the brand tokens are byte-for-byte the ones the plugin has always used', () => {
  const { css } = parts(src());
  const root = block(css, ':root {');
  for (const line of DARK) assert.ok(root.includes(line), `:root lost ${line}`);
  for (const name of ADDED) assert.ok(root.includes(name), `:root does not define ${name}`);

  const system = block(css, '@media (prefers-color-scheme: light)');
  const explicit = block(css, ':root[data-theme="light"]');
  for (const line of LIGHT) {
    assert.ok(system.includes(line), `the system light block lost ${line}`);
    assert.ok(explicit.includes(line), `the explicit light block lost ${line}`);
  }
  for (const name of THEMED) {
    assert.ok(system.includes(name) && explicit.includes(name),
      `${name} needs a light value in both light blocks, or it keeps its dark value on a light ground`);
  }
});

/** Status is never colour alone: every pill carries a dot and its label is in the text colour. */
test('layout: a status pill carries a dot, and its text does not wear the status colour', () => {
  const { css, js } = parts(src());
  const pillRule = block(css, '.pill {');
  assert.match(pillRule, /color:\s*var\(--text\)/, 'the pill label is text-coloured');
  for (const tone of ['ok', 'warn', 'bad']) {
    assert.ok(css.includes(`.pill.${tone} .dot`), `no dot colour for .pill.${tone}`);
    assert.doesNotMatch(block(css, `.pill.${tone} {`), /color:\s*var\(--(success|warning|danger)\)/, `.pill.${tone} colours its text`);
  }
  assert.match(js, /function pill\([^)]*\)\s*\{[^}]*'dot'/, 'pill() always appends the dot');
});

// ---------------------------------------------------------------------------
// Self-contained
// ---------------------------------------------------------------------------

// The CSP is `default-src 'self'`, so anything fetched from elsewhere silently fails: a webfont
// that never arrives, a stylesheet that never applies. The page must carry everything it uses.
test('layout: the page loads nothing from anywhere', () => {
  // The one permitted <link>: an inline icon, which stops the browser requesting /favicon.ico
  // from a server that answers every unauthenticated request with 401.
  const text = src().replace('<link rel="icon" href="data:,">', '');
  for (const bad of ['@import', '@font-face', '<link', 'url(http', 'IBM Plex', 'JetBrains', 'innerHTML']) {
    assert.ok(!text.includes(bad), `the page must stay self-contained and build its DOM by API; found ${JSON.stringify(bad)}`);
  }
  assert.match(text, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
});

// ---------------------------------------------------------------------------
// Responsive — nothing hidden, only collapsed behind a visible control
// ---------------------------------------------------------------------------

test('layout: the breakpoints exist and the page, not a capped list, is what scrolls', () => {
  const { css } = parts(src());
  const queries = mediaBlocks(css).map((b) => b.query);
  for (const q of ['(max-width: 64rem)', '(max-width: 60rem)', '(max-width: 48rem)', '(max-width: 40rem)', '(max-width: 520px)', '(prefers-color-scheme: light)']) {
    assert.ok(queries.includes(q), `no @media ${q}; found ${JSON.stringify(queries)}`);
  }
  assert.ok(!css.includes('max-height: calc(100vh'),
    'a list capped to the viewport is a list whose bottom rows are unreachable on a short window');
});

/**
 * The rule that makes "usable down to 360px" a property rather than a promise. Inside a
 * `@media` block, `display: none` may be applied to the rail and to the button that opens it
 * — the one thing that is collapsed, behind the one control that reopens it — and nothing else.
 */
test('layout: inside a media query, display: none applies only to the rail and its toggle', () => {
  const { css } = parts(src());
  const offenders = [];
  for (const b of mediaBlocks(css)) {
    for (const r of rules(b.body)) {
      if (!/display\s*:\s*none/.test(r.decl)) continue;
      const ok = r.selector.split(',').every((s) => /(^|[\s>+~])#rail(-toggle)?\s*$/.test(s.trim()));
      if (!ok) offenders.push(`@media ${b.query} { ${r.selector} }`);
    }
  }
  assert.deepEqual(offenders, [], 'these rules hide content at some width instead of reflowing it');
});

test('layout: the rail collapses behind a labelled toggle below 48rem', () => {
  const { css, html } = parts(src());
  const narrow = mediaBlocks(css).find((b) => b.query === '(max-width: 48rem)');
  assert.ok(narrow, 'no 48rem block');
  assert.ok(rules(narrow.body).some((r) => /^#rail$/.test(r.selector.trim()) && /display\s*:\s*none/.test(r.decl)),
    'the rail is what collapses');
  assert.ok(rules(narrow.body).some((r) => /rail-open/.test(r.selector) && /#rail/.test(r.selector)),
    'and a class on the body is what brings it back');
  const open = openTag(html, 'rail-toggle');
  assert.match(open, /aria-expanded=/, 'the toggle is a disclosure and must say whether it is open');
  assert.match(open, /aria-controls="rail"/, 'and must name what it opens');
});

test('layout: the full directory path wraps rather than truncates, tables keep their first column, and wide content scrolls inside its card', () => {
  const { css } = parts(src());
  assert.match(css, /\.dirhead \.path[^{]*\{[^}]*overflow-wrap\s*:\s*anywhere/,
    'the rail shows the whole path; a truncated path is two projects that look alike');
  assert.match(css, /\.data th:first-child, \.data td:first-child \{[^}]*position\s*:\s*sticky/,
    'under horizontal scroll the first column stays put, so a row can still be placed');
  assert.match(css, /\.scroll-x \{[^}]*overflow-x\s*:\s*auto/, 'a table wider than its card scrolls inside it, never the page');
  const cards = mediaBlocks(css).find((b) => b.query === '(max-width: 520px)');
  assert.ok(cards && /attr\(data-k\)/.test(cards.body), 'below 520px each cell carries its own column label');
});

test('layout: live regions, roles and dialog semantics are declared where the script writes', () => {
  const { html } = parts(src());
  for (const id of ['conn', 'lesson-footer', 'toast']) {
    assert.match(openTag(html, id), /aria-live="polite"/, `#${id} is rewritten by the poll and must announce politely`);
  }
  assert.match(openTag(html, 'chart-tabs'), /role="tablist"/);
  for (const id of ['ctab-outcomes', 'ctab-injected', 'ctab-cost']) {
    assert.match(openTag(html, id), /role="tab"/, `#${id} is not a tab`);
  }
  for (const id of ['nav-overview', 'nav-turns', 'nav-lessons', 'nav-feed', 'nav-health']) {
    assert.match(openTag(html, id), /^<button/, `#${id} must be a button, so it is focusable and activates on Enter and Space`);
  }
  const drawer = openTag(html, 'drawer');
  assert.match(drawer, /role="dialog"/);
  assert.match(drawer, /aria-modal="true"/);
  assert.match(drawer, /aria-labelledby="drawer-title"/);
  assert.match(openTag(html, 'menu'), /role="menu"/);
  for (const id of ['turn-injected', 'view-here', 'view-reach', 'view-all', 'win-7']) {
    assert.match(openTag(html, id), /aria-pressed=/, `#${id} is a toggle and must carry aria-pressed`);
  }
  for (const id of ['scope-filter', 'project-filter', 'origin-filter', 'turn-session', 'turn-outcome', 'dirs']) {
    assert.match(openTag(html, id), /aria-label=/, `#${id} has no visible label of its own and must carry aria-label`);
  }
  // Sortable headers say which way they sort; every other header says none.
  const heads = [...html.matchAll(/<th class="[^"]*sortable[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.ok(heads.length >= 6, `found ${heads.length} sortable headers`);
  for (const h of heads) assert.match(h, /aria-sort="(none|ascending|descending)"/, h);
});

// ---------------------------------------------------------------------------
// The behaviour the rewrite must not lose
// ---------------------------------------------------------------------------

// Each of these is a bug that shipped once and is now a literal the script has to keep.
test('layout: the transport, polling, routing and theme invariants survive as literals', () => {
  const { js } = parts(src());
  for (const literal of [
    "'mubit-dashboard-theme'",
    'function effectiveTheme()',
    "matchMedia('(prefers-color-scheme: light)')",
    'const stale = () => seq !== state.reqSeq',
    'if (state.remoteBusy) return',
    "history.replaceState({}, '', location.pathname + location.hash)",
    "$('scope-filter').value = state.scope",
    "'run=&currentRun=' + encodeURIComponent(state.run)",
    'function parseHash(',
    'function buildHash(',
  ]) {
    assert.ok(js.includes(literal), `the script no longer contains ${literal}`);
  }
  // The page is served under `default-src 'self'`, so a stray absolute URL is a control that
  // silently does nothing in a browser.
  assert.doesNotMatch(js, /["'`]https?:\/\/(?!www\.w3\.org)/, 'the page must stay self-contained; the CSP blocks every external origin');
});
