// @ts-check
/**
 * Where the kit is, where the plugin under test is, and where results go.
 *
 * The kit is parameterised over the plugin: nothing here resolves the plugin by walking up
 * from this file, because the whole point is that `testkit/` and the plugin under test live
 * in different worktrees. Every path that touches the target comes from `--plugin-dir`.
 *
 * Results default to `<kit>/results`, but this repo is a generated mirror — the next publish
 * runs `git rm -rq .` over it. Set `MUBIT_LAB_RESULTS` to somewhere outside the repo and
 * cross-version history survives; leave it unset and it does not.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LAB_ROOT = resolve(KIT_ROOT, '..');

/** @returns {string} the results root — `MUBIT_LAB_RESULTS` if set, else `<kit>/results`. */
export function resultsRoot() {
  const pin = process.env.MUBIT_LAB_RESULTS;
  return pin ? resolve(pin) : join(KIT_ROOT, 'results');
}

/**
 * Resolve `--plugin-dir`. Accepts either a worktree root or the plugin directory itself,
 * because typing `/Users/x/Mubit/some-worktree` is the natural thing to do and being wrong
 * about it costs a confusing "plugin did not load" twenty minutes later.
 *
 * @param {string} input
 * @returns {string} an absolute path to a directory containing `.claude-plugin/plugin.json`
 */
export function resolvePluginDir(input) {
  if (!input) throw new Error('--plugin-dir is required');
  const base = isAbsolute(input) ? input : resolve(process.cwd(), input);
  const candidates = [base, join(base, 'integrations', 'claude-code')];
  for (const c of candidates) {
    if (existsSync(join(c, '.claude-plugin', 'plugin.json'))) return c;
  }
  throw new Error(
    `no .claude-plugin/plugin.json under ${base} (tried it and integrations/claude-code)`,
  );
}

/** @param {string} pluginDir @returns {any} the parsed plugin manifest */
export function pluginManifest(pluginDir) {
  return JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
}

/** @param {string} p @returns {string} */
export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}

/**
 * The stamp directory for one recorded measurement: `<version>-<sha>-<iso>`.
 * Sortable, self-describing, and the first two fields are exactly what `compare` matches on.
 *
 * @param {{pluginVersion: string, pluginSha: string, at?: Date}} v
 */
export function stampName({ pluginVersion, pluginSha, at }) {
  const iso = (at ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${pluginVersion}-${pluginSha}-${iso}`;
}
