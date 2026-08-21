// @ts-check
/**
 * The identity stamped onto every recorded measurement.
 *
 * `compare` refuses to put two runs side by side unless the parts of this stamp that make
 * numbers comparable — model, corpus, `claude` version — agree. So this file is not
 * bookkeeping; it is the thing that decides whether a comparison is allowed to happen.
 *
 * `distHash` is the load-bearing field. A version string can lie (nobody bumps it for a
 * one-line fix) and a git sha describes the source, not the bundle that ran. The hash is
 * over the bytes the host actually executes.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pluginManifest } from './paths.mjs';

/** @param {string} cmd @param {string[]} args @param {string} [cwd] @returns {string} */
function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** @param {string} dir @param {string[]} acc @returns {string[]} every file under `dir`, sorted */
function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

/**
 * sha256 over the shipped runtime: the hook bundles, the MCP bundles, and `bin/`.
 * Path-sensitive, so a renamed bundle changes the hash even if its bytes did not.
 *
 * @param {string} pluginDir @returns {string}
 */
export function distHash(pluginDir) {
  const h = createHash('sha256');
  for (const sub of ['hooks/dist', 'mcp/dist', 'bin']) {
    for (const f of walk(join(pluginDir, sub))) {
      h.update(relative(pluginDir, f));
      h.update('\0');
      h.update(readFileSync(f));
    }
  }
  return `sha256:${h.digest('hex').slice(0, 16)}`;
}

/** @returns {string} e.g. `2.1.237` — the host, pinned because its stream-json shape moves */
export function claudeVersion() {
  return (run('claude', ['--version']).match(/[\d.]+/) || [''])[0];
}

/**
 * @param {string} pluginDir
 * @returns {{pluginVersion: string, pluginName: string, pluginSha: string, pluginDirty: boolean,
 *            pluginBranch: string, distHash: string, claudeVersion: string, nodeVersion: string,
 *            pluginDir: string, capturedAt: string}}
 */
export function stamp(pluginDir) {
  const manifest = pluginManifest(pluginDir);
  const sha = run('git', ['rev-parse', '--short', 'HEAD'], pluginDir);
  const dirty = run('git', ['status', '--porcelain', '--', '.'], pluginDir) !== '';
  return {
    pluginName: String(manifest.name || 'unknown'),
    pluginVersion: String(manifest.version || '0.0.0'),
    pluginSha: sha || 'nogit',
    pluginDirty: dirty,
    pluginBranch: run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], pluginDir),
    distHash: distHash(pluginDir),
    claudeVersion: claudeVersion(),
    nodeVersion: process.version,
    pluginDir,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * The fields that must agree before two recorded runs may be compared, and why.
 *
 * `pluginVersion` and `pluginSha` are deliberately absent: differing on those is the whole
 * point of a comparison.
 */
export const COMPARABILITY_KEYS = [
  ['model', 'a different model changes cost and latency more than the plugin does'],
  ['corpusHash', 'different prompts are different work'],
  ['claudeVersion', 'the host changes caching and system-prompt size between releases'],
  ['armsHash', 'the arms define what "on" and "off" mean'],
];

/**
 * @param {any} a @param {any} b
 * @returns {{comparable: boolean, mismatches: {key: string, a: any, b: any, why: string}[]}}
 */
export function comparability(a, b) {
  const mismatches = [];
  for (const [key, why] of COMPARABILITY_KEYS) {
    const va = a?.[key] ?? a?.stamp?.[key];
    const vb = b?.[key] ?? b?.stamp?.[key];
    if (va !== vb) mismatches.push({ key, a: va, b: vb, why });
  }
  return { comparable: mismatches.length === 0, mismatches };
}

/** @param {any} value @returns {string} a short stable hash, for corpus and arms identity */
export function hashOf(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)}`;
}
