// @ts-check
/**
 * Is the committed bundle the one this source builds?
 *
 * `npm test` runs `hooks/src`. The host runs the committed `hooks/dist`. Nothing pinned the two
 * together, and the committed bundle is what ships — so a bundle could be arbitrarily stale
 * while the whole suite reported green. That is not hypothetical: a launcher writing a field
 * Codex rejects at parse time sat in `hooks/dist` through 251 passing tests, because no test
 * had ever executed the file the host actually runs.
 *
 * This rebuilds into a temp directory and compares. Two properties make that possible at all:
 * `minify: false` and a deterministic bundler, so the same inputs produce the same bytes.
 *
 * ---------------------------------------------------------------------------
 * The one thing that legitimately differs, and why it is normalised
 * ---------------------------------------------------------------------------
 * `sourcemap: 'inline'` embeds a base64 sourcemap whose `sources` are paths **relative to the
 * output file**. Rebuild into `/var/folders/…` and every one of them grows a `../` chain up to
 * the real source tree, so the bytes differ for a reason that has nothing to do with the code.
 *
 * So the comparison is: the emitted code, byte-for-byte; and the decoded sourcemap with
 * `sources` resolved to absolute and re-expressed against the repository root. `mappings` and
 * `sourcesContent` are compared as they are — `sourcesContent` is the input text itself, which
 * makes this stricter than a code-only diff, not looser.
 *
 * Node >= 20 built-ins only.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const MAP_PREFIX = '//# sourceMappingURL=data:application/json;base64,';

/**
 * Split a built file into the code and its decoded inline sourcemap.
 *
 * @param {string} text
 * @param {string} file      absolute path the file was written to
 * @param {string} repoRoot  what `sources` are re-expressed against
 * @returns {{code: string, map: any}}
 */
export function splitBundle(text, file, repoRoot) {
  const at = text.lastIndexOf(MAP_PREFIX);
  if (at === -1) return { code: text, map: null };

  const code = text.slice(0, at);
  const b64 = text.slice(at + MAP_PREFIX.length).trim();
  let map;
  try {
    map = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    // An undecodable map is itself a difference worth reporting; keep it as bytes.
    return { code, map: { undecodable: b64 } };
  }
  if (Array.isArray(map.sources)) {
    map.sources = map.sources.map((s) => {
      if (typeof s !== 'string') return s;
      const abs = resolve(dirname(file), s);
      return relative(repoRoot, abs);
    });
  }
  return { code, map };
}

/** Every file under `dir`, as paths relative to it, sorted. */
export function walk(dir, base = dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, acc);
    else acc.push(relative(base, p));
  }
  return acc;
}

/**
 * Rebuild a plugin into a throwaway directory.
 *
 * `MUBIT_CC_BUILD_SKIP_SERVER=1` is not a shortcut here — `mcp/dist/server.js` is bundled from
 * a TypeScript sibling that does not exist in the generated mirror this tree lives in, and is
 * vendored instead. It is compared as a *copy* by `codex-mcp.test.mjs`, not rebuilt by anyone.
 *
 * @param {string} pluginRoot
 * @returns {{outDir: string, ok: boolean, stderr: string, cleanup: () => void}}
 */
export function rebuildInto(pluginRoot) {
  const outDir = mkdtempSync(join(tmpdir(), 'mubit-dist-check-'));
  const r = spawnSync(process.execPath, [join(pluginRoot, 'esbuild.config.mjs')], {
    cwd: pluginRoot,
    encoding: 'utf8',
    env: { ...process.env, MUBIT_CC_BUILD_OUTDIR: outDir, MUBIT_CC_BUILD_SKIP_SERVER: '1' },
  });
  return {
    outDir,
    ok: r.status === 0,
    stderr: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    cleanup: () => { try { rmSync(outDir, { recursive: true, force: true }); } catch { /* fine */ } },
  };
}

/**
 * Compare a committed directory against its freshly built twin.
 *
 * @param {{committed: string, built: string, repoRoot: string, ignore?: (rel: string) => boolean}} o
 * @returns {{missing: string[], extra: string[], differing: Array<{file: string, why: string}>}}
 */
export function compareTrees(o) {
  const ignore = o.ignore ?? (() => false);
  const want = walk(o.built).filter((f) => !ignore(f));
  const have = walk(o.committed).filter((f) => !ignore(f));

  const missing = want.filter((f) => !have.includes(f));
  const extra = have.filter((f) => !want.includes(f));
  const differing = [];

  for (const rel of want.filter((f) => have.includes(f))) {
    const a = readFileSync(join(o.committed, rel), 'utf8');
    const b = readFileSync(join(o.built, rel), 'utf8');
    if (a === b) continue;

    const sa = splitBundle(a, join(o.committed, rel), o.repoRoot);
    const sb = splitBundle(b, join(o.built, rel), o.repoRoot);
    if (sa.code !== sb.code) {
      differing.push({ file: rel, why: firstDifference(sa.code, sb.code) });
    } else if (JSON.stringify(sa.map) !== JSON.stringify(sb.map)) {
      differing.push({ file: rel, why: 'the code matches but the inline sourcemap does not '
        + '(a source file moved, or its contents changed without changing the output)' });
    }
  }
  return { missing, extra, differing };
}

/** A short, quotable account of where two strings first diverge. */
function firstDifference(a, b) {
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  const line = a.slice(0, i).split('\n').length;
  const snip = (s) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 80));
  return `first differs at line ${line}\n      committed: ${snip(a)}\n      rebuilt:   ${snip(b)}`;
}
