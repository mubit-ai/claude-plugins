// @ts-check
/**
 * `lib/boot.mjs` — the env-before-import shim, and the only file in this plugin that is more
 * than two lines long.
 *
 * ---------------------------------------------------------------------------
 * Why a shim exists at all
 * ---------------------------------------------------------------------------
 * The shared modules capture their configuration at **module scope**. `lib/config.mjs`
 * resolves `CLAUDE_PROJECT_DIR` and the data directory when `loadConfig` first runs, and the
 * bundled MCP server reads `MUBIT_DEFAULT_SESSION_ID` in a top-level `const`. So a value set
 * *after* the shared module is imported is indistinguishable from a value never set at all.
 *
 * Codex exports none of the names those modules read. Probed against a live 0.146.0 hook
 * process (`docs/harness-probe.md` §4), all four of `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`,
 * `PLUGIN_DATA` and `CLAUDE_PLUGIN_DATA` arrive unset — the strings exist in the binary, but
 * are only ever populated for plugin-sourced hooks, and plugin-sourced hooks do not load.
 * There is no `${...}` substitution layer either: a `$PLUGIN_ROOT` written into a hook
 * command is expanded by the login shell Codex runs it in, to the empty string.
 *
 * So something has to synthesise them, and it has to do it first. This is the same ordering
 * rule `mcp/src/launch.mjs` already lives by — its whole reason for existing is that every
 * `process.env` write happens before `await import('./server.js')` — and `codex-boot.test.mjs`
 * guards it here the way `test/launch.test.mjs` guards it there.
 *
 * ---------------------------------------------------------------------------
 * What it fills in, and from where
 * ---------------------------------------------------------------------------
 * | name                 | source                                | why not the environment |
 * | -------------------- | ------------------------------------- | ----------------------- |
 * | `MUBIT_CC_HOST`      | the constant `codex`                  | declared, never sniffed — see below |
 * | `CLAUDE_PLUGIN_ROOT` | the nearest `.codex-plugin/plugin.json` above this file | Codex sets no plugin root of any spelling |
 * | `CLAUDE_PLUGIN_DATA` | `~/.claude/plugins/data/mubit-memory` | deliberately the **same** directory Claude Code uses |
 * | `CLAUDE_PROJECT_DIR` | the payload `cwd`, else `process.cwd()` | Codex runs a hook in the project directory |
 *
 * **The host is declared, not detected**, and that is a correctness decision rather than a
 * shortcut. A Codex session launched from a Claude Code terminal inherits `CLAUDECODE=1` and
 * a dozen `CLAUDE_CODE_*` variables; a Codex session from a plain shell has none of them.
 * Any sniff gets one of those two cases wrong, silently. This file can assert the answer
 * because it exists nowhere else: if this module is running, the host is Codex.
 *
 * **The data directory is the one that looks like a mistake and is not.** A Codex session and
 * a Claude Code session in the same directory derive the same run id — that is the point of
 * the port — so they must also read and write the same directory. A Codex-only user does end
 * up with a `~/.claude/` directory they never asked for, and `README.md` says so. The
 * alternative is one project with two memories that never meet, which is the failure the
 * shared run id exists to prevent.
 *
 * Nothing here throws. A hook is on the user's critical path, and a shim that fails should
 * cost the memory rather than the turn: every fallible step is caught, and a name it could
 * not resolve is simply left for the shared module's own fallback to answer.
 *
 * Zero dependencies beyond `lib/state.mjs`, which is imported for exactly one thing: the
 * default data-directory path, so this file and the shared resolver cannot disagree about
 * where a Claude Code session would have written. That module reads its environment per call
 * and captures nothing at import time, which is what makes it safe to load this early.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dataDir as sharedDataDir } from '../../claude-code/lib/state.mjs';

/** The harness this bundle runs under. Asserted, not inferred — see the header. */
export const HOST = 'codex';

/** The file that identifies a plugin root, in the source tree and in an installed copy alike. */
const ROOT_MARKER = join('.codex-plugin', 'plugin.json');

/** How far up to look for it. `hooks/dist/impl/<name>.mjs` is the deepest real layout, at 3. */
const MAX_CLIMB = 6;

/**
 * Fill the three host names and the host marker into `env`, in place.
 *
 * **Never overwrites.** A value already in the environment was put there by somebody — a
 * test harness, a CI job, a user pinning a directory — and a shim that overrode them would
 * make this the one component whose configuration cannot be set from outside. Synthesising a
 * value is a fallback, not a policy.
 *
 * @param {Record<string, string|undefined>} [env]  `process.env` on the real path
 * @param {{cwd?: string}} [payload]  a hook payload, when one has been read already
 * @returns {Record<string, string|undefined>} the same object
 */
export function applyCodexEnv(env = process.env, payload = {}) {
  const e = env ?? {};
  const set = (name, value) => {
    if (typeof value !== 'string' || !value) return;
    const existing = e[name];
    if (typeof existing === 'string' && existing.trim()) return;
    e[name] = value;
  };

  set('MUBIT_CC_HOST', HOST);
  set('CLAUDE_PLUGIN_ROOT', pluginRoot());
  set('CLAUDE_PLUGIN_DATA', defaultDataDir(e));
  set('CLAUDE_PROJECT_DIR', projectDir(e, payload));

  return e;
}

/**
 * This plugin's root: the nearest ancestor of *this file* carrying `.codex-plugin/plugin.json`.
 *
 * A fixed relative path cannot answer, because there are two layouts and they differ in
 * depth. As source, this file is `lib/boot.mjs` — one level down. Bundled, it is inlined into
 * `hooks/dist/impl/<name>.mjs`, where `import.meta.url` names the *output* file and the root
 * is three levels up. An installed copy under `$CODEX_HOME/plugins/cache/…` is the bundled
 * layout again, at a path nothing here can predict.
 *
 * The marker walk answers all three, and answers a fourth case the depth arithmetic could
 * not: a test importing this module directly, where `process.argv[1]` is the test runner.
 *
 * `argv[1]` is the fallback rather than the primary for that reason, and it is bounded the
 * same way. It is right whenever the process was started by Codex — every registered hook is
 * `hooks/{src,dist}/<name>.mjs`, exactly two levels down — and wrong only where the marker
 * walk has already succeeded.
 *
 * @returns {string} an absolute path, or `''` when neither route found a plugin root
 */
export function pluginRoot() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const found = climbForMarker(here);
    if (found) return found;
  } catch { /* not a file: URL — fall through to argv */ }

  try {
    const entry = typeof process.argv[1] === 'string' ? process.argv[1] : '';
    if (entry) {
      const found = climbForMarker(dirname(resolve(entry)));
      if (found) return found;
    }
  } catch { /* an unresolvable argv[1] is not worth failing a hook over */ }

  return '';
}

/**
 * Walk up from `start` looking for `ROOT_MARKER`, at most `MAX_CLIMB` levels.
 * @param {string} start
 * @returns {string}
 */
function climbForMarker(start) {
  let dir = start;
  for (let i = 0; i <= MAX_CLIMB; i++) {
    try {
      if (existsSync(join(dir, ROOT_MARKER))) return dir;
    } catch { /* unstat-able; keep climbing */ }
    const up = dirname(dir);
    if (up === dir) return '';       // filesystem root
    dir = up;
  }
  return '';
}

/**
 * Where a Claude Code session in this account would write, computed by the shared resolver
 * rather than restated here.
 *
 * The synthetic environment is the point: passing the real one would let `MUBIT_CC_DATA_DIR`
 * or an existing `CLAUDE_PLUGIN_DATA` answer, and this function's job is specifically to
 * produce the *default*. `applyCodexEnv` never overwrites, so those two keep their
 * precedence exactly as they have it under Claude Code — which is what
 * `codex-boot.test.mjs` pins.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
function defaultDataDir(env) {
  try {
    return sharedDataDir({}, { HOME: env.HOME });
  } catch {
    return '';
  }
}

/**
 * The project directory: the payload's `cwd` when a caller has one, else the process's.
 *
 * On the real path there is no payload — this module runs before stdin is read — and
 * `process.cwd()` is the right answer there, because Codex runs a hook in the project
 * directory (recorded, `docs/harness-probe.md` §4) and `payload.cwd` says the same thing.
 * The overload exists for callers that re-derive later; `lib/runid.mjs` already prefers a
 * payload `cwd` over the environment for its own reasons, and this keeps the two agreeing.
 *
 * @param {Record<string, string|undefined>} env
 * @param {{cwd?: string}} payload
 * @returns {string}
 */
function projectDir(env, payload) {
  const fromPayload = typeof payload?.cwd === 'string' ? payload.cwd.trim() : '';
  if (fromPayload) return fromPayload;
  try {
    return process.cwd();
  } catch {
    return '';
  }
}

// The side effect the entry points import this module for. It runs at module scope on
// purpose: a hook entry's `import './../../lib/boot.mjs'` is hoisted above its statements,
// so this is what guarantees the environment is in place before the `await import(...)` of
// the shared body evaluates. Guarding it behind `import.meta.url === process.argv[1]` would
// make it a no-op everywhere it matters.
applyCodexEnv(process.env);
