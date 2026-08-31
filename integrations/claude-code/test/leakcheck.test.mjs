// @ts-check
/**
 * Leak check — the public tree may not carry what was never published.
 *
 * This repository *is* the public mirror (`origin` is the marketplace repo that
 * `/plugin marketplace add` points at). Every file `git ls-files` reports here is
 * world-readable the moment it lands on the default branch. The plugin is built
 * from a private backend monorepo, so the interesting failure is not "the code is
 * wrong" but "the code is fine and it brought something with it".
 *
 * That has already happened three times, and each time it was invisible to review:
 *
 *   - A bundle's inline sourcemap embedded ~66 KB of first-party TypeScript that
 *     is not published anywhere, plus ~2 MB of dependency source. Nothing in the
 *     diff said so; the bundle is one line and the payload is base64.
 *   - Developer home directories were baked into committed docs and fixtures.
 *   - Backend implementation detail was quoted into user-facing prose.
 *
 * The mirror has no CI. This suite is the only gate that actually runs, so the
 * rule lives here as a test rather than as a convention.
 *
 * ---------------------------------------------------------------------------
 * Why every assertion below is a *shape* and not a list of names
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation is a denylist: the internal repo name, the backend
 * crate paths, the internal env prefixes, the private route names. That file
 * would be committed to the public mirror, where it would itself be the most
 * concentrated disclosure in the tree — a tidy index of exactly what we did not
 * want published, maintained in perpetuity.
 *
 * So nothing here names an internal anything. Each check asserts a structural
 * property that holds for published material and fails for unpublished material,
 * and the failure message teaches the shape without instantiating it.
 *
 * Scope is the whole repository, not just this plugin: the sibling integration
 * ships the same vendored bundle, and the leak that motivated check 1 was found
 * there *after* it had been fixed here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, normalize } from 'node:path';

import { REPO_ROOT } from './helpers/harness.mjs';

// ---------------------------------------------------------------------------
// The tracked tree, read once
// ---------------------------------------------------------------------------

/**
 * `git ls-files`, because "exists on disk" is the wrong question. An untracked
 * file is invisible downstream; a tracked one is published. Only the second kind
 * can leak. (This is the same reasoning manifests.test.mjs uses for the inverse
 * property — that runtime files must be tracked rather than merely present.)
 */
function trackedFiles() {
  const res = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ls-files failed: ${res.stderr}`);
  const files = res.stdout.split('\0').filter(Boolean);
  assert.ok(files.length > 50,
    `git ls-files returned only ${files.length} paths — the scan would pass vacuously.`);
  return files;
}

/**
 * Read as a Buffer and decode explicitly.
 *
 * Several `lib/*.mjs` files contain NUL bytes (they carry control characters in
 * redaction and classification fixtures). `grep(1)` classifies those as binary
 * and *silently skips them* — a scan built on shell grep reports success on
 * exactly the files most likely to hold a pasted secret. Node has no such
 * behaviour, which is the main reason this is a test and not a shell script.
 */
function readTracked(rel) {
  try {
    return readFileSync(join(REPO_ROOT, rel)).toString('utf8');
  } catch {
    return null;
  }
}

/** Lazily read the whole tracked tree once and share it across the checks. */
let _corpus = null;
function corpus() {
  if (_corpus) return _corpus;
  _corpus = [];
  for (const rel of trackedFiles()) {
    const text = readTracked(rel);
    if (text !== null) _corpus.push({ rel, text });
  }
  return _corpus;
}

/** An inline esbuild sourcemap is a single enormous base64 run. Strip it for the
 *  text scans — its *contents* are check 1's job, and leaving it in would make
 *  every opaque-string heuristic below fire on the mapping payload. */
const INLINE_MAP = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/g;
const stripMaps = (text) => text.replace(INLINE_MAP, '');

/** Render at most `n` findings, so a failure is readable rather than a wall. */
function report(findings, n = 12) {
  const shown = findings.slice(0, n).map((f) => `    ${f}`).join('\n');
  const rest = findings.length > n ? `\n    … and ${findings.length - n} more` : '';
  return `${shown}${rest}`;
}

// ---------------------------------------------------------------------------
// 1. No bundle may embed source that is not published in this repository
// ---------------------------------------------------------------------------

/**
 * The check that catches the leak nobody can see in a diff.
 *
 * `sourcemap: 'inline'` embeds `sourcesContent` — the verbatim text of every file
 * that went into the bundle. For a bundle built only from this repository that is
 * free: the map republishes what is already published. For a bundle that pulls in
 * a dependency built from private source, the map ships that source, in full, in
 * a committed artifact, encoded so that neither review nor `grep` will show it.
 *
 * The property asserted is therefore not "no sourcemaps" — they are wanted, they
 * make a stack trace from a user's machine legible. It is that a bundle may only
 * embed source this repository already publishes. That generalises: it holds for
 * any dependency vendored later, without anyone having to remember this rule.
 *
 * A build that legitimately bundles unpublished source turns its sourcemap off
 * (`sourcemap: false`), rather than adding an exemption here.
 */
test('no shipped bundle embeds source that is not a tracked file in this repo', () => {
  const findings = [];
  let bundlesWithMaps = 0;

  for (const { rel, text } of corpus()) {
    if (!/\.(mjs|js)$/.test(rel)) continue;

    for (const match of text.matchAll(INLINE_MAP)) {
      bundlesWithMaps += 1;
      let map;
      try {
        map = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
      } catch (err) {
        findings.push(`${rel}: inline sourcemap does not decode as JSON (${err.message})`);
        continue;
      }

      const sources = map.sources ?? [];
      const contents = map.sourcesContent ?? [];
      const bundleDir = dirname(rel);
      const tracked = new Set(trackedFiles());

      sources.forEach((source, i) => {
        // No embedded text means nothing was republished — only a pointer, which
        // resolves to nothing on a reader's machine and discloses nothing.
        const content = contents[i];
        if (typeof content !== 'string' || content.length === 0) return;

        // Sourcemap paths are relative to the bundle's own directory.
        const resolved = normalize(join(bundleDir, source));
        if (tracked.has(resolved)) return;

        findings.push(
          `${rel}\n        embeds ${(content.length / 1024).toFixed(1)} KB of ${source}`
          + `\n        → ${resolved} is not tracked in this repository`);
      });
    }
  }

  assert.ok(bundlesWithMaps > 0,
    'No inline sourcemaps were found at all. Either the build stopped emitting them\n'
    + '  or this scan stopped finding them — - and a scan that finds nothing cannot fail.');

  assert.equal(findings.length, 0,
    `A committed bundle embeds source that this repository does not publish.\n\n`
    + `${report(findings)}\n\n`
    + '  This is a publication bug, not a build bug: the bundle runs fine. Its inline\n'
    + '  sourcemap carries `sourcesContent` — the full text of each file above — into\n'
    + '  a public artifact, where nothing else would put it.\n\n'
    + '  Fix it at the build, not here: set `sourcemap: false` on the target that\n'
    + '  bundles unpublished source. Nothing is lost — the map only ever pointed at\n'
    + '  files a reader of the public tree does not have, and `minify: false` is what\n'
    + '  keeps a stack trace readable.\n\n'
    + '  If the bundle is vendored from a sibling integration, rebuild it there first;\n'
    + '  a stale copy keeps the payload after the original was fixed.');
});

// ---------------------------------------------------------------------------
// 5. What a sourcemap embeds is held to the same standard as the tree
// ---------------------------------------------------------------------------

/**
 * Check 1 asks *which files* a map embeds; this one reads what it embeds. The
 * two failure modes are different: a map can name only tracked files and still
 * carry a stale copy of one — text the tree used to say, kept alive base64'd in
 * an artifact nobody diffs. Checks 2–4 all strip inline maps before scanning
 * (deliberately — the mapping payload defeats their heuristics), so without
 * this check the embedded text is scanned by nothing at all.
 *
 * The shapes asserted are exactly checks 2–4's, applied to each decoded
 * `sourcesContent` entry, with the same redaction-demo exemption: an embedded
 * copy of the redactor legitimately carries credential shapes, because the
 * tracked original does.
 */
test('nothing an inline sourcemap embeds may carry what the tree itself may not', () => {
  const findings = [];
  let entriesScanned = 0;

  for (const { rel, text } of corpus()) {
    if (!/\.(mjs|js)$/.test(rel)) continue;

    for (const match of text.matchAll(INLINE_MAP)) {
      let map;
      try {
        map = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
      } catch {
        continue; // undecodable maps are check 1's finding, not this one's
      }

      const sources = map.sources ?? [];
      const contents = map.sourcesContent ?? [];

      sources.forEach((source, i) => {
        const content = contents[i];
        if (typeof content !== 'string' || content.length === 0) return;
        entriesScanned += 1;

        const where = (excerpt) => `${rel} (map: ${source}): ${excerpt}`;

        for (const m of content.matchAll(HOME_PATH)) {
          const who = m[1];
          if (PLACEHOLDER_HOMES.has(who) || /^[$<{]/.test(who)) continue;
          findings.push(where(m[0]));
        }
        for (const m of content.matchAll(WORKSPACE_CRATE_PATH)) {
          findings.push(where(`${m[0]}…`));
        }
        if (!isRedactionDemo(source)) {
          for (const [label, pattern] of SECRET_SHAPES) {
            for (const m of content.matchAll(pattern)) {
              findings.push(where(`${label} — ${m[0].slice(0, 48)}…`));
            }
          }
        }
      });
    }
  }

  assert.ok(entriesScanned > 0,
    'No embedded sources were scanned at all. Either the builds stopped inlining\n'
    + '  sourcesContent or this scan stopped decoding them — and a scan that reads\n'
    + '  nothing cannot fail.');

  assert.equal(findings.length, 0,
    `An inline sourcemap embeds text the tree itself would not be allowed to carry.\n\n`
    + `${report(findings)}\n\n`
    + '  The bundle diff never showed this — the payload is one base64 line. It is\n'
    + '  usually a stale embedded copy: the tracked file was cleaned, the bundle was\n'
    + '  not rebuilt, and the map keeps republishing the old text. Rebuild the bundle\n'
    + '  (or fix the source and then rebuild); do not exempt it here.');
});

// ---------------------------------------------------------------------------
// 2. No tracked file may carry a real home directory
// ---------------------------------------------------------------------------

/**
 * An absolute home path publishes the account name of whoever wrote the line, and
 * usually the local layout of a private checkout alongside it. It is also just
 * broken for the reader: a path under someone else's home never resolves.
 *
 * The allowlist is placeholder *names*, not paths, because the property being
 * asserted is "this path names nobody". Adding a new placeholder is a one-line
 * change here; adding a real account name is what this test exists to stop.
 */
const PLACEHOLDER_HOMES = new Set([
  'x', 'y', 'u', 'you', 'me', 'user', 'username', 'USERNAME', 'someone', 'somebody',
  'name', 'your-name', 'yourname', 'example', 'test', 'runner', 'home',
]);

const HOME_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([A-Za-z0-9._$<>{}-]+)/g;

test('no tracked file contains an absolute home-directory path naming a real account', () => {
  const findings = [];

  for (const { rel, text } of corpus()) {
    const seen = new Set();
    for (const match of stripMaps(text).matchAll(HOME_PATH)) {
      const who = match[1];
      if (PLACEHOLDER_HOMES.has(who)) continue;
      // Shell and template indirection names nobody: $USER, ${USER}, <user>.
      if (/^[$<{]/.test(who)) continue;
      if (seen.has(who)) continue;
      seen.add(who);
      findings.push(`${rel}: ${match[0]}`);
    }
  }

  assert.equal(findings.length, 0,
    `A tracked file carries an absolute home directory.\n\n`
    + `${report(findings)}\n\n`
    + '  This publishes the account name of whoever wrote the line, and often the\n'
    + '  layout of a private checkout next to it. It is also wrong for every reader:\n'
    + '  a path under another person\'s home resolves to nothing on their machine.\n\n'
    + '  Use a placeholder (/Users/x, ~/, $HOME, or a repo-relative path). If you have\n'
    + '  introduced a new placeholder convention, add the name to PLACEHOLDER_HOMES\n'
    + '  above — that is a deliberate one-line edit, which is the point.');
});

// ---------------------------------------------------------------------------
// 3. No tracked file may reference the backend's workspace layout
// ---------------------------------------------------------------------------

/**
 * This plugin is JavaScript. It talks to a service over HTTP and knows nothing
 * about how that service is built — which is the correct posture and also the one
 * the public tree should display.
 *
 * The shape asserted is a path rooted at a Rust workspace crate directory, i.e.
 * `crates/<something>/…`. That is a monorepo *layout*, and there is no reason for
 * a JavaScript plugin to contain one; a reference like that only ever arrives by
 * being pasted out of a backend checkout, bringing the internal module structure
 * with it.
 *
 * Deliberately NOT asserted: "no Rust reference at all". That was the first draft
 * and it fails on ~23 files of entirely legitimate material — the classifier and
 * the redactor use a Rust project as their *generic example workspace*, so
 * `cargo check`, `Cargo.toml` and `src/lib.rs` appear all over the fixtures as
 * sample tool input. Those name nothing internal. Widening this pattern to catch
 * them would make the check unrunnable, and a check that is routinely overridden
 * protects nothing.
 */
const WORKSPACE_CRATE_PATH = /\bcrates\/[A-Za-z0-9_.-]+\//g;

/**
 * The one file that must contain what this check looks for.
 *
 * `.github/scripts/leakcheck.selftest.mjs` exercises the wider scanner, so its
 * fixtures are by construction examples of every shape the scanner blocks — a
 * crate path among them. It is the same exemption `REDACTION_DEMO_FILES` makes
 * below for the redactor's fixtures, and for the same reason: a check that fires
 * on the material proving another check works is a check that gets switched off.
 *
 * Scoped to this one assertion rather than dropped from `corpus()` wholesale.
 * The selftest is still scanned for real secrets and real home directories,
 * which is where a pasted fixture would actually do damage.
 */
const isGateFixture = (rel) => rel.endsWith('.github/scripts/leakcheck.selftest.mjs');

test('no tracked file references a Rust workspace crate path', () => {
  const findings = [];

  for (const { rel, text } of corpus()) {
    if (isGateFixture(rel)) continue;
    const seen = new Set();
    for (const match of stripMaps(text).matchAll(WORKSPACE_CRATE_PATH)) {
      if (seen.has(match[0])) continue;
      seen.add(match[0]);
      findings.push(`${rel}: ${match[0]}…`);
    }
  }

  assert.equal(findings.length, 0,
    `A tracked file references a backend workspace path.\n\n`
    + `${report(findings)}\n\n`
    + '  A JavaScript plugin has no reason to name the internal module layout of the\n'
    + '  service it calls. A reference like this arrives by being pasted out of a\n'
    + '  backend checkout — usually into a comment, a doc, or a test name — and it\n'
    + '  publishes that structure to everyone who reads the mirror.\n\n'
    + '  Describe the behaviour at the API boundary instead: the route, the request,\n'
    + '  the response. That is what a reader of this repository can actually act on.');
});

// ---------------------------------------------------------------------------
// 4. No tracked file may carry a credential-shaped literal
// ---------------------------------------------------------------------------

/**
 * Three unambiguous shapes. Each is a literal that has no reason to exist in
 * source: a private key block, a populated Authorization header, and an
 * assignment of a long opaque value to a credential-named field.
 *
 * The exemptions are the files whose *job* is to carry these shapes: the redactor
 * that detects them, the fixtures that exercise it, and the two documents that
 * show a user what redaction does. Exempting them by path is right — the check
 * cannot distinguish a convincing fake from a real key, and a fake that is not
 * convincing does not test the redactor.
 *
 * Suffix matching, so both integrations are covered by one entry.
 */
const REDACTION_DEMO_FILES = [
  'lib/redact.mjs',
  'test/redact.test.mjs',
  'test/helpers/fixtures.mjs',
  'test/helpers/harness.mjs',
  'README.md',
  'docs/user-guide.md',
  // Lab 4's payload. The bash failure it replays carries a bearer token so the reader can
  // watch the redactor take it out; a payload whose secret is unconvincing demonstrates
  // nothing. Only present on the labs branch, where `labs/` is checked out.
  'labs/payloads/06-bash-failure.json',
];

const isRedactionDemo = (rel) => REDACTION_DEMO_FILES.some((suffix) => rel.endsWith(suffix));

const SECRET_SHAPES = [
  ['private key block', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g],
  ['populated bearer token', /\bBearer\s+[A-Za-z0-9_\-.=]{20,}/g],
  ['credential assignment',
    /\b(?:api[_-]?key|secret|token|password|passwd|credential)\b\s*[:=]\s*["'`][A-Za-z0-9_\-.=+/]{24,}["'`]/gi],
];

test('no tracked file contains a credential-shaped literal', () => {
  const findings = [];

  for (const { rel, text } of corpus()) {
    if (isRedactionDemo(rel)) continue;
    const body = stripMaps(text);
    for (const [label, pattern] of SECRET_SHAPES) {
      const seen = new Set();
      for (const match of body.matchAll(pattern)) {
        const excerpt = match[0].slice(0, 48);
        if (seen.has(excerpt)) continue;
        seen.add(excerpt);
        findings.push(`${rel}: ${label} — ${excerpt}…`);
      }
    }
  }

  assert.equal(findings.length, 0,
    `A tracked file contains a credential-shaped literal.\n\n`
    + `${report(findings)}\n\n`
    + '  Treat it as live until proven otherwise: rotate first, then remove it, and\n'
    + '  remember that removing it in a later commit does not unpublish it — the blob\n'
    + '  stays reachable in this repository\'s history.\n\n'
    + '  If this is deliberately fake material demonstrating redaction, it belongs in\n'
    + '  one of the files listed in REDACTION_DEMO_FILES above, next to the rest of\n'
    + '  the fixtures, rather than exempted where it stands.');
});
