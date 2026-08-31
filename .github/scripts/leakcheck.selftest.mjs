#!/usr/bin/env node
// @ts-check
/**
 * `leakcheck.selftest` — proves the gate can still see.
 *
 * A leak scanner fails silently. If a rule stops matching, or a whole class of file stops being
 * read, nothing goes red — the report just gets shorter, and shorter reads like progress. So
 * this builds a throwaway git repository, plants one known leak of each kind in it, and asserts
 * the scanner finds them.
 *
 * Two of the cases are here because they have already gone wrong somewhere:
 *
 *   - **NUL bytes.** Four real files in this repository contain them, git calls those files
 *     binary, and `git grep` skips them without `-a`. One of them holds a live finding. A
 *     scanner that decides text-ness by sniffing content would be blind to exactly that file.
 *   - **Inline sourcemaps.** A bundle can carry the original source of a private package
 *     base64-encoded on a single line, which is invisible to every line-oriented rule. It must
 *     also *not* fire for a map whose sources are tracked here, or it is noise forever.
 *
 * Every fixture below is deliberately SYNTHETIC — a shape that matches a rule without being a
 * true fact about this system. This file is as public as the rest of the repository, so a
 * fixture that reproduced a real leak in order to test the rule against it would republish the
 * leak. Keep them fake; the rules match shapes, so fake is enough.
 *
 * Run: node .github/scripts/leakcheck.selftest.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_GITHUB = join(HERE, '..');

const root = mkdtempSync(join(tmpdir(), 'leakcheck-selftest-'));
const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A source file whose real source is not tracked here — the map must flag it. */
const foreignMap = {
  version: 3,
  sources: ['../../../mcp/src/secret-thing.ts'],
  sourcesContent: ['export const internal = 1; // private source'],
  mappings: '',
};
/** A map that only carries a source this fixture repo tracks — the rule must stay quiet. */
const domesticMap = {
  version: 3,
  sources: ['../lib/ours.mjs'],
  sourcesContent: ['export const ours = 1;'],
  mappings: '',
};
/** A foreign source whose embedded text carries a blocking sentence — both must fire. */
const leakyForeignMap = {
  version: 3,
  sources: ['../../../mcp/src/quiet-leak.ts'],
  sourcesContent: ['export const q = 1; // naming it would let a client write a tenant-wide rule'],
  mappings: '',
};
/** Same basename as a tracked file, different text: a stale copy, not a published one. */
const staleCopyMap = {
  version: 3,
  sources: ['../lib/ours.mjs'],
  sourcesContent: ['export const ours = 2; // anything above run scope could write a tenant-wide rule'],
  mappings: '',
};
const inline = (m) => `//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(m)).toString('base64')}`;

/** @type {Array<{path:string, body:string|Buffer, expect:string[], quiet?:string[]}>} */
const CASES = [
  {
    path: 'a/plain.mjs',
    body: [
      "// see crates/example/service/src/lib.rs for the real thing",
      "// build-guide §4.2 explains the rest",
      "const home = '/Users/somebody/work';",
      "// naming it would let a client write a tenant-wide rule",
      "// health is allowlisted before authentication",
      "// MUB-42 — tracked internally",
      "// enforce_example_access_policy lets this one through",
      "// the negative-streak reflection threshold defaults to 99",
      "// there is no relevance floor on what comes back",
      "// this path incurs two LLM calls on every prompt",
      "// spec.policy.exampleFlag plus a pod restart",
      "const contact = 'someone.real@corp.example.org';",
      "// full memo: https://claude.ai/code/artifact/deadbeef-0000-0000-0000-000000000000",
      // The real shape: reading the stored key out, not merely naming the file. `lib/credentials.mjs`
      // has to name it, so the rule deliberately does not fire on a bare path.
      "// export KEY=$(node -e 'require(process.env.HOME+\"/.claude/plugins/data/x/credentials.json\").apiKey')",
      "// strings -a ~/.local/share/claude/versions/2.1.235",
      "// instanceId: 'abc-9f2a41'",
      "// see probes/mcp-surface.mjs",
      "// the denylist is not published",
    ].join('\n'),
    expect: [
      'private-source-path', 'internal-doc-reference', 'dev-machine-path',
      'isolation-defect-disclosure', 'unauthenticated-surface', 'internal-ticket-id',
      'server-internal-symbol', 'server-cap-or-threshold', 'reinforcement-arithmetic',
      'llm-cost-model', 'hosted-infrastructure', 'personal-data', 'private-link',
      'credential-extraction-recipe', 'host-binary-extraction', 'upstream-vendor-disclosure',
      'unpublished-file-reference', 'mirror-process-disclosure',
    ],
  },
  {
    // Git marks this binary. Every rule must still run over it.
    path: 'a/has-nul.mjs',
    body: Buffer.concat([
      Buffer.from("const sentinel = ' ';\n// see crates/example/service/src/lib.rs\n"),
      Buffer.from([0x00]),
      Buffer.from("\n// naming it would let a client write a tenant-wide rule\n"),
    ]),
    expect: ['private-source-path', 'isolation-defect-disclosure'],
  },
  {
    path: 'a/bundle.js',
    body: `export const x = 1;\n${inline(foreignMap)}\n`,
    expect: ['inline-sourcemap-sources'],
  },
  {
    path: 'lib/ours.mjs',
    body: `export const ours = 1;\n`,
    expect: [],
  },
  {
    path: 'a/domestic-bundle.js',
    body: `export const ours = 1;\n${inline(domesticMap)}\n`,
    expect: [],
    quiet: ['inline-sourcemap-sources'],
  },
  {
    // The bundle's own text is clean; the leak is a sentence inside the map's
    // `sourcesContent`, where no line-oriented rule has ever looked. The content rules
    // must run over what the map embeds, not only over what the file says.
    path: 'a/leaky-map-bundle.js',
    body: `export const x = 1;\n${inline(leakyForeignMap)}\n`,
    expect: ['inline-sourcemap-sources', 'isolation-defect-disclosure'],
  },
  {
    // A stale copy: the map names a file this repository tracks, but embeds text the
    // tracked file no longer says. Matching by basename alone silenced 36 of these —
    // the name is not the content, and only the content is what gets published.
    path: 'a/stale-copy-bundle.js',
    body: `export const ours = 1;\n${inline(staleCopyMap)}\n`,
    expect: ['inline-sourcemap-sources', 'isolation-defect-disclosure'],
  },
  {
    // Suppression, placeholders, allowlisted addresses and public vendor examples must not fire.
    path: 'a/allowed.mjs',
    body: [
      "const home = '/Users/you/project';",
      "const also = '/Users/x/repo/src/lib.rs'; // leakcheck-allow: dev-machine-path — fixture",
      "const mail = 'you@example.com';",
      "const key = 'mbt_live_dontleakme_0000';",
      "const gh = 'ghp_16C7e42F292c6912E7710c838347Ae178B4a';",
      "const aws = 'AKIAIOSFODNN7EXAMPLE';",
    ].join('\n'),
    expect: [],
    quiet: ['dev-machine-path', 'personal-data', 'credential-material'],
  },
  {
    path: 'docs/manual-test-something.md',
    body: '# a runbook\n',
    expect: ['internal-runbook'],
  },
  {
    // The gap the prefix version left: an internal document named nothing in particular.
    // `handoff-`, `manual-test-` and `manual-verification` were the names the first batch
    // happened to use, and two 500-line documents walked through on their filenames alone.
    path: 'docs/some-working-brief.md',
    body: '# a brief nobody outside would read\n',
    expect: ['internal-runbook'],
  },
  {
    // And the other side of an allowlist: the one document that is meant to be there.
    path: 'docs/user-guide.md',
    body: '# how to use it\n',
    expect: [],
    quiet: ['internal-runbook'],
  },
  {
    // Three phrasings that each survived a branch the narrow patterns had already passed.
    // They say what `tenant-wide` and `allowlisted before auth` say, in the words somebody
    // writing for a user reaches for instead.
    path: 'a/phrasings.mjs',
    body: [
      "// a pin written there renders in a stranger's session",
      '// health is unauthenticated by design',
      '// §1.2 (auth, and the one allowlisted unauthenticated route)',
    ].join('\n'),
    expect: ['isolation-defect-disclosure', 'unauthenticated-surface'],
  },
  {
    // The recipe, which is the part of a lifted artefact that cannot be written by accident.
    // Twenty-one files sat in the tree while both gates passed; nothing looked at a fixture
    // directory full of somebody else's JSON, and what made them reproducible was the note
    // beside them saying how to get more.
    path: 'a/extraction.mjs',
    body: [
      '// BIN=/opt/homebrew/lib/node_modules/@vendor/cli/node_modules/@vendor/cli-darwin-arm64/vendor/bin/cli',
      '// strings -n 2 "$BIN" > out.txt',
      '// the schemas are extracted from the Vendor binary; brace-match from each `{`',
    ].join('\n'),
    expect: ['vendor-artifact-extraction'],
  },
  {
    // Prose wraps. A rule anchored to a line is defeated by a line break, which is how four
    // real findings survived the first sweep — so the scanner joins comment runs and matches
    // against those too, and this proves it still does.
    path: 'a/wrapped.mjs',
    body: [
      'export const x = 1;',
      '/**',
      ' * The placeholder identifier is the one that',
      ' * collapses every user into a single bucket.',
      ' *',
      ' * Anything above run scope could write a',
      ' * tenant-wide rule if a client named it.',
      ' */',
    ].join('\n'),
    expect: ['tenancy-collapse', 'isolation-defect-disclosure'],
  },
];

let failures = 0;
const fail = (msg) => { failures += 1; process.stdout.write(`  FAIL  ${msg}\n`); };

/**
 * `--rev` reads a commit's tree instead of the working tree, and the `pre-push` hook depends on
 * it entirely: it is the difference between checking what is about to be published and checking
 * whatever happens to be checked out. Committing the fixtures and re-scanning by revision must
 * produce exactly what scanning the files produced.
 */
function checkRevMode(fromWorkingTree) {
  git('commit', '-qm', 'fixtures');
  const head = git('rev-parse', 'HEAD').trim();
  let out;
  try {
    out = execFileSync('node', [join(root, '.github/scripts/leakcheck.mjs'),
      '--strict', '--json', '--no-annotations', '--rev', head],
      { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = /** @type {any} */ (e).stdout;
  }
  if (typeof out !== 'string' || !out.includes('"findings"')) {
    fail('--rev produced no findings JSON'); return;
  }
  const key = (f) => `${f.rule} ${f.path} ${f.match}`;
  const a = new Set(fromWorkingTree.map(key));
  const b = new Set(JSON.parse(out).findings.map(key));
  for (const k of a) if (!b.has(k)) fail(`--rev missed a finding the working-tree scan found: ${k}`);
  for (const k of b) if (!a.has(k)) fail(`--rev invented a finding: ${k}`);
}

try {
  git('init', '-q');
  git('config', 'user.email', 'selftest@example.com');
  git('config', 'user.name', 'selftest');

  cpSync(SOURCE_GITHUB, join(root, '.github'), { recursive: true });
  rmSync(join(root, '.github/leakcheck/baseline.json'), { force: true });

  for (const c of CASES) {
    mkdirSync(join(root, dirname(c.path)), { recursive: true });
    writeFileSync(join(root, c.path), c.body);
  }
  git('add', '-A');

  const out = execFileSync('node', [join(root, '.github/scripts/leakcheck.mjs'), '--strict', '--json', '--no-annotations'],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const { findings } = JSON.parse(out);

  const firedAt = (path) => new Set(findings.filter((f) => f.path === path).map((f) => f.rule));

  for (const c of CASES) {
    const fired = firedAt(c.path);
    for (const rule of c.expect) {
      if (!fired.has(rule)) fail(`${c.path}: expected ${rule}, got [${[...fired].join(', ') || 'nothing'}]`);
    }
    for (const rule of c.quiet || []) {
      if (fired.has(rule)) fail(`${c.path}: ${rule} fired and should not have`);
    }
  }
  checkRevMode(findings);
} catch (err) {
  // execFileSync throws on a non-zero exit, which --strict does whenever it finds anything.
  const e = /** @type {any} */ (err);
  if (e && typeof e.stdout === 'string' && e.stdout.includes('"findings"')) {
    const { findings } = JSON.parse(e.stdout);
    const firedAt = (path) => new Set(findings.filter((f) => f.path === path).map((f) => f.rule));
    for (const c of CASES) {
      const fired = firedAt(c.path);
      for (const rule of c.expect) {
        if (!fired.has(rule)) fail(`${c.path}: expected ${rule}, got [${[...fired].join(', ') || 'nothing'}]`);
      }
      for (const rule of c.quiet || []) {
        if (fired.has(rule)) fail(`${c.path}: ${rule} fired and should not have`);
      }
    }
    checkRevMode(findings);
  } else {
    fail(`scanner did not run: ${e?.message || String(err)}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures) {
  process.stdout.write(`\nleakcheck.selftest: ${failures} failure(s) — the gate is not seeing what it claims to.\n`);
  process.exit(1);
}
process.stdout.write(`leakcheck.selftest: ok — ${CASES.length} cases.\n`);
