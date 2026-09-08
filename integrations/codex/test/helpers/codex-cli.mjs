// @ts-check
/**
 * Spawning the committed command-line bundles — `bin/<name>.mjs` — the way a Codex skill does.
 *
 * Every Codex skill that runs a binary runs `node <plugin-root>/bin/<name>.mjs` from a shell
 * with **no plugin environment at all**: no `MUBIT_CC_HOST`, no `CLAUDE_PLUGIN_*`, nothing a
 * hook registration would have pinned. So the artifact under test is the bundle, spawned,
 * with an environment built here from nothing — never `mod('bin/<name>.src.mjs')` in-process,
 * which `codex-runid.test.mjs` already covers and which cannot go red on a bundle that boots
 * without the shim. The one property the whole set of CLI suites exists to hold is that the
 * bundle *itself* knows it is running under Codex.
 *
 * `HOME` and `CODEX_HOME` are fresh temp directories on every call, so `liveDataDir()`,
 * `rolloutRoot()` and the boot shim's own search never reach the developer's real install.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CODEX_ROOT, tempDir } from './codex-fixtures.mjs';

/** The test key every suite next door uses; never a real one. */
export const KEY = 'mbt_test_0123456789abcdef_deadbeefcafebabe0123456789abcdef';

/** Absolute path of a committed bundle. */
export function bundlePath(name) {
  return join(CODEX_ROOT, 'bin', `${name}.mjs`);
}

/**
 * The environment a skill-run binary actually gets, made explicit.
 *
 * Nothing is inherited but `PATH`. In particular `MUBIT_CC_HOST` is **absent** — that is the
 * condition under test, and the assertion below keeps a later edit from quietly supplying
 * the answer the bundle is supposed to know on its own.
 *
 * @param {{dataDir: string, endpoint?: string|null, extra?: Record<string, string>}} o
 * @returns {Record<string, string>}
 */
export function cliEnv(o) {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: tempDir('mubit-codex-cli-home-'),
    CODEX_HOME: tempDir('mubit-codex-cli-codex-home-'),
    NODE_OPTIONS: '',
    TZ: 'UTC',
    MUBIT_CC_DATA_DIR: o.dataDir,
    MUBIT_ENDPOINT: o.endpoint ?? '',
    MUBIT_API_KEY: KEY,
    MUBIT_CC_LOG_LEVEL: 'error',
    MUBIT_DEFAULT_SESSION_ID: '',
    ...(o.extra ?? {}),
  };
  assert.ok(!('MUBIT_CC_HOST' in env),
    'a Codex CLI test must not hand the bundle its host: the skill that runs it cannot, so '
    + 'the bundle has to declare it on its own, and that is the property under test.');
  return env;
}

/**
 * Run a bundle to completion.
 *
 * @param {string} name  `handoff`, `import`, …
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @param {{cwd?: string, stdin?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{code: number|null, out: string, err: string}>}
 */
export function runBundle(name, args, env, opts = {}) {
  const bundle = bundlePath(name);
  assert.ok(existsSync(bundle), `${bundle} is not committed; the skill would find nothing to run`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [bundle, ...args], {
      cwd: opts.cwd ?? tempDir('mubit-codex-cli-cwd-'),
      env,
      stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`bin/${name}.mjs ${args.join(' ')} did not exit:\n${err}`));
    }, opts.timeoutMs ?? 30_000);
    child.on('close', (code) => { clearTimeout(t); resolvePromise({ code, out, err }); });
    child.on('error', reject);
    if (opts.stdin !== undefined && child.stdin) child.stdin.end(opts.stdin);
  });
}

/**
 * Import a bundle in-process and assert it exposed `main` without running it.
 *
 * A shimmed bundle applies the boot shim to *this* process's environment on import — never
 * overwriting anything already set — which is harmless because every spawn above passes an
 * explicit environment. The query string defeats the module cache across suites.
 */
export async function assertInertOnImport(name) {
  const bundle = bundlePath(name);
  assert.ok(existsSync(bundle), 'the committed bundle is what ships; it must be there');
  const m = await import(`file://${bundle}?codex-${name}-guard=${Date.now()}`);
  assert.equal(typeof m.main, 'function',
    'importing must expose main() without running it — the entry guard');
}

/** The marker a run's hooks leave behind — how a CLI learns which run it is in. */
export function seedMarker(dataDir, runId, at = Date.now()) {
  mkdirSync(join(dataDir, 'status'), { recursive: true });
  writeFileSync(join(dataDir, 'status', `${runId}.json`),
    JSON.stringify({ run_id: runId, state: 'ready', updated_at: at }));
}
