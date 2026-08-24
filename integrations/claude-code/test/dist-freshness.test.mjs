// @ts-check
/**
 * The committed bundles, against what this source builds.
 *
 * `npm test` runs `hooks/src/*.mjs`. The host runs the committed `hooks/dist/*.mjs`. Those are
 * two different files, and until this gate existed nothing compared them — so a bundle could be
 * arbitrarily far behind its source while the whole suite reported green.
 *
 * That is not a hypothetical failure mode. It is how the sibling Codex plugin shipped launchers
 * writing `{"suppressOutput":true}` — a field Codex rejects at parse time — past 251 passing
 * tests, and a real user saw `• PostToolUse hook (failed)` twice per tool call. `hooks/dist` is
 * a committed artifact: whatever is committed is what runs.
 *
 * `test/helpers/dist-freshness.mjs` carries the machinery and the one narrowing this comparison
 * makes (inline sourcemap paths are relative to the output file, so they are normalised rather
 * than compared raw). `mcp/dist/server.js` is excluded because nothing in this checkout builds
 * it — it is vendored from a TypeScript sibling the generated mirror does not carry.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareTrees, rebuildInto } from './helpers/dist-freshness.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PLUGIN_ROOT, '..', '..');

const isVendoredServer = (rel) => rel === 'server.js' || rel.endsWith('/server.js');

test('the committed bundles are what this source builds', () => {
  const build = rebuildInto(PLUGIN_ROOT);
  try {
    assert.ok(build.ok,
      `the rebuild failed, so the committed bundles cannot be checked at all:\n${build.stderr}`);

    for (const dir of ['hooks/dist', 'mcp/dist']) {
      const { missing, extra, differing } = compareTrees({
        committed: join(PLUGIN_ROOT, dir),
        built: join(build.outDir, dir),
        repoRoot: REPO_ROOT,
        ignore: isVendoredServer,
      });

      assert.deepEqual(missing, [],
        `the build produces ${dir}/ files that are not committed — a hook the host cannot find.`);
      assert.deepEqual(extra, [],
        `${dir}/ carries committed files the build no longer produces: shipped to every user, `
        + 'executed by nothing.');
      assert.deepEqual(differing.map((d) => `${d.file}: ${d.why}`), [],
        `the committed ${dir}/ is NOT what this source builds. The tests run hooks/src; the host\n`
        + '  runs hooks/dist; this is the only thing that compares them.\n\n'
        + '  Fix: MUBIT_CC_BUILD_SKIP_SERVER=1 npm run build, then commit the result.');
    }
  } finally {
    build.cleanup();
  }
});
