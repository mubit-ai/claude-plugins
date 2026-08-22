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
 * | `CLAUDE_PLUGIN_DATA` | whichever `~/.claude/plugins/data/mubit-memory*` this machine's Claude Code install uses | deliberately the **same** directory, suffix and all |
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
 * Zero dependencies: Node built-ins only, and nothing imported from the shared plugin. That is
 * deliberate — this module runs before the shared modules are allowed to load, and importing
 * one to ask it a question would be the very ordering mistake the file exists to prevent.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  set('CLAUDE_PLUGIN_DATA', claudeCodeDataDir(e));
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

/** Where Claude Code keeps every plugin's data directory. */
const CC_DATA_ROOT = ['.claude', 'plugins', 'data'];
/** This plugin's data directory, and the prefix every variant of it shares. */
const DATA_DIR_PREFIX = 'mubit-memory';

/**
 * The data directory a Claude Code session on this machine actually uses.
 *
 * ---------------------------------------------------------------------------
 * Why this is a search and not a constant
 * ---------------------------------------------------------------------------
 * `lib/state.mjs` defaults to `~/.claude/plugins/data/mubit-memory`, and that default is only
 * ever reached when the host did not set `CLAUDE_PLUGIN_DATA` — which, under Claude Code, it
 * always does. **The name the host picks carries a suffix**: a marketplace install writes
 * `mubit-memory-<marketplace>`, a `--plugin-dir` session writes `mubit-memory-inline`, and the
 * bare name is only one of several. `scripts/mubit-inspect.mjs` has known this for as long as
 * it has existed; this file did not, and assumed the bare name.
 *
 * The consequence was silent and complete. A Codex session derived the *same run id* as the
 * Claude Code session in the same directory — the sharing worked — and then wrote it into
 * `…/mubit-memory` while Claude Code read `…/mubit-memory-mubit`. Two memories of one project,
 * one of them missing the credentials, and nothing anywhere reporting it. Measured on a real
 * install: both directories held a run named `cc-mubit-plugin-testing-41703b8c`.
 *
 * ---------------------------------------------------------------------------
 * The preference order, and why each rung
 * ---------------------------------------------------------------------------
 *   1. **A directory holding `credentials.json`.** `/mubit-memory:auth` writes exactly one of
 *      these, into the install the user actually authenticated. It is the strongest available
 *      evidence of which install is live, and it is the one that makes the credentials the
 *      user already has work under Codex without copying anything.
 *   2. **The most recently modified.** Every hook touches its data directory, so recency is a
 *      good proxy for "in use" when nobody has authenticated yet.
 *   3. **The bare name**, created if absent. A machine with no Claude Code install at all is
 *      the ordinary case for a Codex-only user, and it wants a directory rather than an error.
 *
 * A search is still a guess, so it is a fallback and not the mechanism.
 * `scripts/setup.mjs` resolves the same thing at install time and **pins** it as
 * `MUBIT_CC_DATA_DIR` in the registrations it writes, which outranks everything here — so on
 * a set-up install this function is never consulted at all.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
export function claudeCodeDataDir(env = process.env) {
  const home = (typeof env?.HOME === 'string' && env.HOME) ? env.HOME : safeHome();
  if (!home) return '';
  const root = join(home, ...CC_DATA_ROOT);
  const bare = join(root, DATA_DIR_PREFIX);

  /** @type {Array<{path: string, creds: boolean, at: number}>} */
  let candidates = [];
  try {
    candidates = readdirSync(root)
      .filter((n) => n === DATA_DIR_PREFIX || n.startsWith(`${DATA_DIR_PREFIX}-`))
      .map((n) => join(root, n))
      .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } })
      .map((p) => ({
        path: p,
        creds: existsSync(join(p, 'credentials.json')),
        at: mtime(p),
      }));
  } catch {
    return bare;                       // no ~/.claude at all: a Codex-only machine
  }
  if (!candidates.length) return bare;

  const withCreds = candidates.filter((c) => c.creds);
  const pool = withCreds.length ? withCreds : candidates;
  // Deterministic: newest first, then by path, so two directories with identical timestamps
  // cannot make this answer differently on two consecutive hooks of the same session.
  pool.sort((a, b) => (b.at - a.at) || a.path.localeCompare(b.path));
  return pool[0].path;
}

/** Latest mtime of a directory or of the files a live install touches. */
function mtime(dir) {
  let newest = 0;
  for (const rel of ['', 'config.json', 'status', 'runs', 'credentials.json']) {
    try {
      const t = statSync(rel ? join(dir, rel) : dir).mtimeMs;
      if (t > newest) newest = t;
    } catch { /* absent; try the next */ }
  }
  return newest;
}

function safeHome() {
  try { return homedir(); } catch { return ''; }
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
