// @ts-check
/**
 * What ships defaults to production, and names no other cluster.
 *
 * The live auth matrix was driven against a disposable dev console by *overriding*
 * `MUBIT_CONSOLE_URL` in a private harness — never by editing a default. This suite pins
 * that line where CI can hold it: the shipped bundles' compiled-in endpoints are the
 * production pair, and no shipped artifact — in either integration — carries a
 * non-production hostname, not even inside an inline sourcemap.
 *
 * The sourcemap half is the reason this is not a grep. `sourcemap: 'inline'` embeds
 * `sourcesContent` — the verbatim text of every source file, comments included — base64'd
 * into the one line of the bundle no reviewer reads. A hostname scrubbed from the code
 * but left in a comment ships anyway, invisibly. (And several sources embed literal NUL
 * bytes, which make `grep(1)` silently skip the file — see `test/leakcheck.test.mjs`.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { PLUGIN_ROOT, REPO_ROOT } from './helpers/harness.mjs';

const CODEX_ROOT = join(REPO_ROOT, 'integrations', 'codex');

/** The production pair. Anything else in a shipped default is a leak of somewhere. */
const PROD_CONSOLE = 'https://console.mubit.ai';
const PROD_ENDPOINT = 'https://api.mubit.ai';

/**
 * Hostname shapes that mean "not production": the dev console, and any `*.dev.mubit.ai`
 * cluster host. The EU production hosts (`api.eu.mubit.ai`) are fine and deliberately
 * not matched — this is about environments, not regions.
 *
 * Anchored on the literal, with the host prefix recovered afterwards: a leading
 * `[a-z0-9.-]*` turns quadratic over a megabytes-long base64 line, and the sourcemap
 * payloads here are exactly that.
 */
const NON_PROD = /console\.dev\.|\.dev\.mubit\.ai/gi;

/** The full hostname around a NON_PROD hit, for a finding someone can read. */
function hostAround(text, index) {
  let start = index;
  while (start > 0 && /[a-z0-9.-]/i.test(text[start - 1])) start -= 1;
  let end = index;
  while (end < text.length && /[a-z0-9.-]/i.test(text[end])) end += 1;
  return text.slice(start, end);
}

/**
 * The published trees, per integration — the union of each `package.json` `files` list
 * that exists on disk. Tests and build tooling are deliberately outside: fixtures may
 * name a dev cluster (existing precedent), shipped artifacts may not.
 */
function shippedFiles(root) {
  const { files = [] } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  /** @type {string[]} */
  const out = [];
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name));
    } else {
      out.push(p);
    }
  };
  for (const rel of files) {
    const p = join(root, rel);
    if (existsSync(p)) walk(p);
  }
  assert.ok(out.length > 20,
    `only ${out.length} shipped files under ${root} — the scan would pass vacuously`);
  return out;
}

const INLINE_MAP = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/g;

/** Every scannable text a shipped file carries: its own bytes, plus each decoded
 *  `sourcesContent` entry of every inline sourcemap in it. */
function scannableTexts(path) {
  const raw = readFileSync(path).toString('utf8');
  const texts = [{ label: path, text: raw }];
  for (const m of raw.matchAll(INLINE_MAP)) {
    let map;
    try {
      map = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    } catch {
      continue; // undecodable maps are the leakcheck suite's finding
    }
    (map.sources ?? []).forEach((source, i) => {
      const content = (map.sourcesContent ?? [])[i];
      if (typeof content === 'string' && content.length) {
        texts.push({ label: `${path} (map: ${source})`, text: content });
      }
    });
  }
  return texts;
}

test('both shipped auth bundles compile in the production console and gateway', async () => {
  for (const [label, path] of [
    ['claude-code', join(PLUGIN_ROOT, 'bin', 'auth.mjs')],
    ['codex', join(CODEX_ROOT, 'bin', 'auth.mjs')],
  ]) {
    assert.ok(existsSync(path), `${label}: ${path} is what ships and must exist`);
    const m = await import(`file://${path}?prod-defaults=${label}`);
    assert.equal(m.CONSOLE_URL, PROD_CONSOLE,
      `${label}: the compiled-in console must be production`);
    assert.equal(m.DEFAULT_ENDPOINT, PROD_ENDPOINT,
      `${label}: the compiled-in gateway must be production`);
  }
});

test('no shipped artifact names a non-production cluster, sourcemaps included', () => {
  const findings = [];
  let scanned = 0;
  for (const root of [PLUGIN_ROOT, CODEX_ROOT]) {
    for (const path of shippedFiles(root)) {
      if (/\.(png|jpg|gif|ico|woff2?)$/.test(path)) continue;
      for (const { label, text } of scannableTexts(path)) {
        scanned += 1;
        for (const m of text.matchAll(NON_PROD)) {
          findings.push(`${label}: ${hostAround(text, m.index ?? 0)}`);
        }
      }
    }
  }
  assert.ok(scanned > 100, `only ${scanned} texts scanned — the guard would pass vacuously`);
  assert.equal(findings.length, 0,
    'A shipped artifact names a non-production cluster:\n'
    + findings.slice(0, 12).map((f) => `    ${f}`).join('\n')
    + (findings.length > 12 ? `\n    … and ${findings.length - 12} more` : '')
    + '\n\n  Dev endpoints belong to the private test harness (MUBIT_CONSOLE_URL et al.),\n'
    + '  never to a shipped default, comment, or sourcemap. If the hit is in a sourcemap,\n'
    + '  fix the *source* it embeds and rebuild — scrubbing the bundle text is not enough.');
});
