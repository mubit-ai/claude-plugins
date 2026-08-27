// @ts-check
/**
 * The committed bundles, against what the current source builds — for **both** plugins.
 *
 * This is the gate that would have caught the bug this whole branch started from.
 *
 * `npm test` runs `hooks/src/*.mjs`. Codex runs the committed `hooks/dist/*.mjs`. Nothing tied
 * the two together and there is no CI, so the bundle that actually ships could be arbitrarily
 * far behind its source while every test reported green — and it was: `hooks/dist` carried
 * launchers writing `{"suppressOutput":true}`, a field Codex rejects at parse time, through 251
 * passing tests. The suite could not see it because no test executed the file the host runs.
 *
 * Both plugins are checked here rather than one each side, for the same reason
 * `codex-mcp.test.mjs` lives here: this is the suite that already knows about both trees, and
 * the two are built from one source tree by two configs that must not drift apart.
 *
 * What "identical" means is narrowed in exactly one place, and `dist-freshness.mjs` explains
 * it: `sourcemap: 'inline'` embeds paths relative to the output file, so a rebuild into a temp
 * directory differs there for a reason that is not about the code. The emitted code is compared
 * byte-for-byte; the sourcemap is compared with its `sources` re-expressed against the repo
 * root, `sourcesContent` and all.
 */

import test from 'node:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assert, CODEX_ROOT, SHARED_ROOT, REPO_ROOT } from './helpers/codex-fixtures.mjs';
import { compareTrees, rebuildInto } from '../../claude-code/test/helpers/dist-freshness.mjs';

/**
 * `mcp/dist/server.js` is excluded, and only that.
 *
 * It is not built by either config in this checkout — it is bundled from a TypeScript sibling
 * the generated mirror does not carry, and is vendored instead. `codex-mcp.test.mjs` asserts
 * the two plugins' copies are byte-identical, which is the property that matters for a file
 * nobody here rebuilds.
 */
const isVendoredServer = (rel) => rel === 'server.js' || rel.endsWith('/server.js');

/** @param {{name: string, root: string, dirs: string[]}} plugin */
function checkPlugin(plugin) {
  const build = rebuildInto(plugin.root);
  try {
    assert.ok(build.ok,
      `rebuilding the ${plugin.name} plugin failed, so its committed bundles cannot be checked `
      + `at all:\n${build.stderr}`);

    for (const dir of plugin.dirs) {
      const committed = join(plugin.root, dir);
      const built = join(build.outDir, dir);
      const { missing, extra, differing } = compareTrees({
        committed, built, repoRoot: REPO_ROOT, ignore: isVendoredServer,
      });

      assert.deepEqual(missing, [],
        `${plugin.name}: the build produces ${dir}/ files that are not committed. Whatever is `
        + 'committed is what runs, so an uncommitted bundle is a hook the host cannot find.\n'
        + '  Fix: MUBIT_CC_BUILD_SKIP_SERVER=1 npm run build, then commit the result.');
      assert.deepEqual(extra, [],
        `${plugin.name}: ${dir}/ carries committed files the build no longer produces. They are `
        + 'shipped to every user and executed by nothing.');
      assert.deepEqual(differing.map((d) => `${d.file}: ${d.why}`), [],
        `${plugin.name}: the committed ${dir}/ is NOT what this source builds.\n\n`
        + '  This is the state that let a launcher writing a rejected field ship past a green\n'
        + '  suite. The tests run hooks/src; the host runs hooks/dist; only this compares them.\n\n'
        + '  Fix: MUBIT_CC_BUILD_SKIP_SERVER=1 npm run build, then commit hooks/dist.');
    }
  } finally {
    build.cleanup();
  }
}

test('the committed Codex bundles are what the current source builds', () => {
  checkPlugin({ name: 'codex', root: CODEX_ROOT, dirs: ['hooks/dist', 'bin', 'mcp/dist'] });
});

test('the committed Claude Code bundles are what the current source builds', () => {
  // § `bin/` here holds `*.src.mjs` inputs beside the built `*.mjs`, so an `extra` entry is
  //   expected and the directory is checked for drift in the built files only.
  checkPlugin({ name: 'claude-code', root: SHARED_ROOT, dirs: ['hooks/dist', 'mcp/dist'] });
});

test('a source edit is actually caught by this gate', () => {
  // § A freshness gate that cannot fail is worse than none: it reports the bundle is current
  //   whatever the bundle says. This proves the comparison has teeth without touching the
  //   tree — the built tree is edited, and the committed one must then disagree with it.
  const build = rebuildInto(CODEX_ROOT);
  try {
    assert.ok(build.ok, build.stderr);
    const victim = join(build.outDir, 'hooks/dist/capture.mjs');
    const before = readFileSync(victim, 'utf8');
    writeFileSync(victim, `${before}\n// a stale bundle looks exactly like this\n`);

    const { differing } = compareTrees({
      committed: join(CODEX_ROOT, 'hooks/dist'),
      built: join(build.outDir, 'hooks/dist'),
      repoRoot: REPO_ROOT,
      ignore: isVendoredServer,
    });
    assert.equal(differing.length, 1,
      'the gate did not notice a one-line difference in a launcher, so it would not have '
      + 'noticed the one that shipped.');
    assert.equal(differing[0].file, 'capture.mjs');
  } finally {
    build.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The publish build — what a released bundle may not carry
// ---------------------------------------------------------------------------

/**
 * `sourcemap: 'inline'` embeds `sourcesContent`: the complete text of every module esbuild
 * pulled in, base64'd into the bundle. For Codex that is the whole of the *sibling's* `lib/`
 * and `hooks/src/`, because `esbuild.config.mjs` inlines them — and `package.json`'s `files`
 * publishes neither. So a release built with the default settings ships the shared source
 * anyway, invisible to grep and to review, inside files that are on the published list.
 *
 * Claude Code grew `MUBIT_CC_BUILD_NO_SOURCEMAP` at `c768465` for exactly this. The Codex
 * config never did, which made the flag a claim that silently did nothing here — the worse
 * failure of the two, because the release step looks like it worked.
 */
test('the publish build leaves no inline sourcemap in any bundle Codex ships', () => {
  const built = rebuildInto(CODEX_ROOT, { MUBIT_CC_BUILD_NO_SOURCEMAP: '1' });
  try {
    assert.ok(built.ok, `the Codex build failed:\n${built.stderr}`);

    const carrying = readdirSync(built.outDir, { recursive: true })
      .map(String)
      .filter((rel) => rel.endsWith('.mjs') || rel.endsWith('.js'))
      .filter((rel) => !isVendoredServer(rel))
      .filter((rel) => readFileSync(join(built.outDir, rel), 'utf8').includes('sourceMappingURL'))
      .sort();

    assert.deepEqual(carrying, [], 'MUBIT_CC_BUILD_NO_SOURCEMAP=1 was set and these bundles still '
      + `carry an inline sourcemap:\n    ${carrying.join('\n    ')}\n`
      + '  Each one embeds the shared lib/ and hooks/src/ that this package does not publish.');
  } finally {
    built.cleanup();
  }
});
