// @ts-check
/**
 * `bin/dashboard.html` — the markup and the stylesheet, as strings.
 *
 * There is no DOM here either (see `dashboard-page.test.mjs` for why), so this file asserts
 * the facts about the page that can be read off its text: that every element the script
 * reaches for exists, that the brand tokens are the ones the rest of the plugin uses, that
 * the page stays self-contained under its own CSP, and that the responsive rules collapse
 * things behind a visible control rather than hiding them.
 *
 * The last one is the property this file is really for. The old page had one breakpoint and a
 * list capped at `calc(100vh - 210px)`; below about a thousand pixels, components were simply
 * off-screen. "Nothing is hidden" is enforced here as: inside a `@media` block, `display: none`
 * may be applied to the rail and to the button that opens it, and to nothing else.
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

// ---------------------------------------------------------------------------
// The elements the script needs
// ---------------------------------------------------------------------------

const REQUIRED_IDS = [
  'endpoint', 'conn', 'conn-text', 'theme',
  'banner', 'banner-title', 'banner-text', 'banner-code',
  'identity', 'id-run', 'id-run-state', 'id-path', 'id-root', 'id-datadir', 'id-sessions',
  'id-session-list', 'id-scope',
  'rail', 'rail-toggle', 'dirs', 'runs',
  'tab-memory', 'tab-turns', 'tab-analytics', 'panel-memory', 'panel-turns', 'panel-analytics',
  'mode-lessons', 'mode-activity', 'runs-this', 'runs-reach', 'runs-all', 'sort-newest', 'sort-oldest',
  'filter', 'scope-filter', 'project-filter', 'do-search', 'scope-summary', 'type-summary',
  'memory-list', 'memory-detail', 'memory-footer', 'memory-scope-note',
  'turn-filter', 'turn-count', 'turn-rows', 'turn-detail',
  'tiles', 'analytics-note', 'health-tiles', 'health-note',
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
  // The dynamic forms are allow-listed by shape, so a new one is a conscious addition.
  const dynamic = [...js.matchAll(/\$\(\s*(?!')([^)]*)\)/g)].map((m) => m[1].trim());
  const allowed = [/^'tab-' \+ n$/, /^'panel-' \+ n$/, /^id$/];
  for (const arg of dynamic) {
    assert.ok(allowed.some((re) => re.test(arg)), `$(${arg}) is not one of the allowed dynamic lookups`);
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
];
const LIGHT = [
  '--bg: hsl(32 36% 97%);', '--panel: hsl(36 50% 99%);', '--panel-2: hsl(32 30% 95%);',
  '--border: hsl(30 18% 84%);', '--text: hsl(30 22% 14%);', '--muted: hsl(30 10% 42%);',
  '--accent: hsl(16 100% 50%);', '--accent-dim: hsl(16 100% 50% / 0.12);',
  '--success: hsl(149 70% 33%);', '--danger: hsl(0 82% 54%);', '--danger-dim: hsl(0 82% 54% / 0.10);',
];
const ADDED = ['--hair:', '--hair-strong:', '--accent-ink:', '--surface-hover:', '--space-1:', '--space-6:', '--rail-w:', '--col-max:', '--track:'];

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
  for (const name of ['--hair:', '--hair-strong:', '--accent-ink:']) {
    assert.ok(system.includes(name) && explicit.includes(name),
      `${name} needs a light value in both light blocks, or hairlines vanish on a light ground`);
  }
});

// ---------------------------------------------------------------------------
// Self-contained
// ---------------------------------------------------------------------------

// The CSP is `default-src 'self'`, so anything fetched from elsewhere silently fails: a webfont
// that never arrives, a stylesheet that never applies. The page must carry everything it uses.
test('layout: the page loads nothing from anywhere', () => {
  const text = src();
  for (const bad of ['@import', '@font-face', '<link', 'url(http', 'IBM Plex', 'JetBrains']) {
    assert.ok(!text.includes(bad), `the page must stay self-contained; found ${JSON.stringify(bad)}`);
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

  const tag = html.slice(html.indexOf('id="rail-toggle"'));
  const open = tag.slice(0, tag.indexOf('>'));
  assert.match(open, /aria-expanded=/, 'the toggle is a disclosure and must say whether it is open');
  assert.match(open, /aria-controls="rail"/, 'and must name what it opens');
});

test('layout: the full directory path wraps rather than truncates, and the turns table keeps its first column', () => {
  const { css } = parts(src());
  assert.match(css, /#id-path[^{]*\{[^}]*overflow-wrap\s*:\s*anywhere/,
    'the identity strip shows the whole path; a truncated path is two projects that look alike');
  assert.match(css, /[^{}]*turn[^{}]*first-child[^{}]*\{[^}]*position\s*:\s*sticky/,
    'under horizontal scroll the time column stays put, so a row can still be placed in time');
});

test('layout: live regions and roles are declared where the script writes', () => {
  const { html } = parts(src());
  for (const id of ['memory-footer', 'conn']) {
    const tag = html.slice(html.indexOf(`id="${id}"`));
    assert.match(tag.slice(0, tag.indexOf('>')), /aria-live="polite"/, `#${id} is rewritten by the poll and must announce politely`);
  }
  assert.ok(html.includes('role="tablist"'));
  for (const id of ['tab-memory', 'tab-turns', 'tab-analytics']) {
    const at = html.indexOf(`id="${id}"`);
    const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at));
    assert.match(tag, /role="tab"/, `${tag} is not a tab`);
  }
});

// ---------------------------------------------------------------------------
// The behaviour the rewrite must not lose
// ---------------------------------------------------------------------------

// Each of these is a bug that shipped once and is now a literal the script has to keep.
test('layout: the transport, polling and theme invariants survive as literals', () => {
  const { js } = parts(src());
  for (const literal of [
    "'mubit-dashboard-theme'",
    'function effectiveTheme()',
    "matchMedia('(prefers-color-scheme: light)')",
    'const stale = () => seq !== state.reqSeq',
    'if (state.remoteBusy) return',
    'history.replaceState',
    "$('scope-filter').value = state.scope",
  ]) {
    assert.ok(js.includes(literal), `the script no longer contains ${literal}`);
  }
});
