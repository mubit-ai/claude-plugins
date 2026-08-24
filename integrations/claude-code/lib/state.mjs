// @ts-check
/**
 * `lib/state.mjs` — the durable surface under `${CLAUDE_PLUGIN_DATA}`.
 *
 * Build-guide §4.8 (module API) and §7 (state layout + TTL table).
 *
 * Every hook is a short-lived process, so anything that must survive a process
 * boundary goes through here. Three rules hold everywhere in this file:
 *
 *   1. Zero dependencies, Node >= 20 built-ins only, and no import outside
 *      `lib/` — a detached child imports this module by absolute file:// URL.
 *   2. Everything is synchronous. Sync file I/O beats an event-loop round trip
 *      for a process that is about to exit, and removes an entire class of
 *      "process exited before the write landed" bugs.
 *   3. Nothing here throws. Every caller is on a hook's critical path, and a
 *      memory layer has no business breaking a prompt (§4.9).
 */

import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** §7: pruning runs at most hourly, gated by an O_EXCL marker at `prune.lock`. */
const PRUNE_INTERVAL_MS = HOUR;

// ---------------------------------------------------------------------------
// dataDir
// ---------------------------------------------------------------------------

/**
 * §4.8 resolution order:
 *   `MUBIT_CC_DATA_DIR` -> `CLAUDE_PLUGIN_DATA` -> `~/.claude/plugins/data/mubit-memory`.
 *
 * `${CLAUDE_PLUGIN_DATA}` survives plugin updates; `${CLAUDE_PLUGIN_ROOT}` does
 * not (it is replaced wholesale), so nothing writable ever goes in ROOT.
 *
 * @param {Record<string, any>} [cfg]
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function dataDir(cfg = {}, env = process.env) {
  const e = env ?? {};
  const override = e.MUBIT_CC_DATA_DIR;
  if (typeof override === 'string' && override) return override;
  const host = e.CLAUDE_PLUGIN_DATA;
  if (typeof host === 'string' && host) return host;
  if (cfg && typeof cfg.dataDir === 'string' && cfg.dataDir) return cfg.dataDir;
  const home = (typeof e.HOME === 'string' && e.HOME) ? e.HOME : safeHome();
  return join(home, '.claude', 'plugins', 'data', 'mubit-memory');
}

function safeHome() {
  try { return homedir(); } catch { return '.'; }
}

/**
 * The data root a `cfg` refers to. Prefers the resolved `cfg.dataDir` written by
 * `loadConfig`, falling back to the environment for callers that only have a
 * partial config.
 * @param {Record<string, any>} [cfg]
 * @returns {string}
 */
export function resolveDataDir(cfg = {}) {
  if (cfg && typeof cfg.dataDir === 'string' && cfg.dataDir) return cfg.dataDir;
  return dataDir(cfg);
}

// ---------------------------------------------------------------------------
// readJson / writeJsonAtomic
// ---------------------------------------------------------------------------

/**
 * §4.8: never throws. A truncated, empty, binary or absent file is normal after
 * a SIGKILL and yields the fallback.
 * @param {string} p
 * @param {any} [fallback]
 * @returns {any}
 */
export function readJson(p, fallback = null) {
  try {
    const raw = readFileSync(p, 'utf8');
    if (!raw || !raw.trim()) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/**
 * §4.8: write `<p>.tmp-<pid>`, then rename. `rename(2)` is atomic within a
 * filesystem, so a concurrent reader — `bin/statusline.mjs` runs every frame —
 * sees either the whole old file or the whole new one, never a partial.
 *
 * `opts.mode` sets the permission bits **at creation**, via the `open(2)` that
 * creates the temp file, and the rename then carries them onto `p`. Two
 * consequences, both of which matter for `credentials.json`:
 *
 *   - There is no window in which the file exists at a wider mode. A `chmod`
 *     after the write would leave the bytes on disk world-readable in between.
 *   - The mode is unconditional rather than inherited. Writing over an existing
 *     path keeps *that path's* mode, so a file created 0644 by an older version
 *     would silently stay 0644 forever.
 *
 * `mode` is only honoured on creation, so the temp file is opened `wx`
 * (`O_CREAT | O_EXCL`) and any stale one from a recycled pid is removed first.
 *
 * @param {string} p
 * @param {any} value
 * @param {{mode?: number}} [opts]
 * @returns {boolean} true when the value landed
 */
export function writeJsonAtomic(p, value, opts = {}) {
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(p), { recursive: true });
    let body;
    try {
      body = JSON.stringify(value ?? null);
    } catch {
      body = 'null'; // circular or unserializable — never take the hook down for it
    }
    const text = body === undefined ? 'null' : body;
    if (typeof opts?.mode === 'number') {
      try { unlinkSync(tmp); } catch { /* usually absent; only a recycled pid leaves one */ }
      writeFileSync(tmp, text, { encoding: 'utf8', mode: opts.mode, flag: 'wx' });
    } else {
      writeFileSync(tmp, text, 'utf8');
    }
    renameSync(tmp, p);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return false;
  }
}

// ---------------------------------------------------------------------------
// pruneStale — the §7 TTL table
// ---------------------------------------------------------------------------

/**
 * The §7 TTL table, as a sweep. Called only from `drain.mjs` and
 * `session-end.mjs` — never on a blocking hook's critical path — and gated to
 * at most once an hour by an `O_EXCL` `prune.lock`.
 *
 * The sweep is a scalpel: `config.json`, `actor.json`, `breaker/*` and `policy/*`
 * are owned by their own TTL logic and are never touched here. `actor.json` is
 * `lib/actor.mjs`'s 30-day record of the detected actor id, and it is written only
 * by `drain.mjs`; expiring it from here on a different schedule would un-attribute
 * every capture between the sweep and the next drain.
 *
 * @param {Record<string, any>} [cfg]
 * @returns {void}
 */
export function pruneStale(cfg = {}) {
  try {
    const root = resolveDataDir(cfg);
    if (!root || !existsSync(root)) return;
    if (!claimPruneGate(root)) return;

    const now = Date.now();
    /** @param {string} p @param {number} ttl */
    const expire = (p, ttl) => {
      try {
        const st = statSync(p);
        if (now - st.mtimeMs > ttl) rmSync(p, { force: true });
      } catch { /* raced with another sweep, or never existed */ }
    };

    // sessions/<host_session_id>.json — 30 d
    for (const name of jsonFiles(join(root, 'sessions'))) {
      expire(join(root, 'sessions', name), 30 * DAY);
    }

    // status/<run_id>.json — 12 h; status/health.json — 30 s
    for (const name of jsonFiles(join(root, 'status'))) {
      expire(join(root, 'status', name), name === 'health.json' ? 30 * SEC : 12 * HOUR);
    }

    // tmp/<uuid>.json — 1 h (detached payload handoff; the child normally unlinks it)
    for (const e of dirEntries(join(root, 'tmp'))) {
      if (e.isFile()) expire(join(root, 'tmp', e.name), 1 * HOUR);
    }

    for (const r of dirEntries(join(root, 'runs'))) {
      if (!r.isDirectory()) continue;
      const rd = join(root, 'runs', r.name);

      // runs/<run_id>/spool/*.json — 24 h (dropped, counted)
      for (const name of jsonFiles(join(rd, 'spool'))) {
        expire(join(rd, 'spool', name), 24 * HOUR);
      }
      // runs/<run_id>/spool/rejected/*.json — 7 d
      for (const name of jsonFiles(join(rd, 'spool', 'rejected'))) {
        expire(join(rd, 'spool', 'rejected', name), 7 * DAY);
      }
      // runs/<run_id>/turns/<prompt_id>.json — 6 h
      for (const name of jsonFiles(join(rd, 'turns'))) {
        expire(join(rd, 'turns', name), 6 * HOUR);
      }
      // runs/<run_id>/seen.json — 6 h, the same window as the turns it aggregates
      // (`lib/seen.mjs`). It also expires entry by entry on every read; this is the sweep
      // for a run nobody comes back to, whose whole file would otherwise outlive its turns.
      expire(join(rd, 'seen.json'), 6 * HOUR);
      // runs/<run_id>/resume.json — 1 h. The briefing is already consume-once and
      // already carries its own 30 min injectability window (`lib/resume.mjs`), so this is
      // the sweep for the file nobody ever came back to read: a session that was started and
      // abandoned before its first prompt leaves one behind, and it would otherwise sit in
      // the data directory for as long as the run does.
      expire(join(rd, 'resume.json'), 1 * HOUR);
      // runs/<run_id>/pins.json — 7 d. Longer than the seen-set and the turns because a pin
      // is scoped to a *run*, and under the default `per-directory` strategy a run is a
      // project someone comes back to for weeks. It is a cache either way: the next drain
      // re-derives it from the instance, and a sweep that fired early would only cost the
      // prompts between it and that drain. Kept in the table rather than left out so a run
      // nobody returns to does not leave a file behind for ever.
      expire(join(rd, 'pins.json'), 7 * DAY);
      // runs/<run_id>/drain.lock — 60 s, stolen after
      expire(join(rd, 'drain.lock'), 60 * SEC);
      // runs/<run_id>/checkpoints.json — 30 d; jobs.json — 24 h
      expire(join(rd, 'checkpoints.json'), 30 * DAY);
      expire(join(rd, 'jobs.json'), 24 * HOUR);
      // runs/<run_id>/flushed-<session_id>.marker — 7 d
      for (const e of dirEntries(rd)) {
        if (e.isFile() && e.name.startsWith('flushed-') && e.name.endsWith('.marker')) {
          expire(join(rd, e.name), 7 * DAY);
        }
      }
    }
  } catch {
    // §12.1-F14: an unusable DATA dir costs the sweep, nothing else.
  }
}

/**
 * `O_EXCL` hourly gate. Returns true when this process owns the sweep.
 * A `prune.lock` older than an hour is refreshed and the sweep proceeds.
 * @param {string} root
 * @returns {boolean}
 */
function claimPruneGate(root) {
  const lock = join(root, 'prune.lock');
  const stamp = () => JSON.stringify({ pid: process.pid, ts: Date.now() });
  try {
    const fd = openSync(lock, 'wx');
    try { writeSync(fd, stamp()); } finally { closeSync(fd); }
    return true;
  } catch {
    try {
      const st = statSync(lock);
      if (Date.now() - st.mtimeMs < PRUNE_INTERVAL_MS) return false;
      writeFileSync(lock, stamp(), 'utf8');
      return true;
    } catch {
      return false;
    }
  }
}

/** @param {string} dir @returns {import('node:fs').Dirent[]} */
function dirEntries(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** @param {string} dir @returns {string[]} */
function jsonFiles(dir) {
  return dirEntries(dir).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);
}

/**
 * Ensure a directory exists. Returns false rather than throwing, so a caller on
 * a hook's critical path can simply skip the write.
 * @param {string} dir
 * @returns {boolean}
 */
export function ensureDir(dir) {
  try { mkdirSync(dir, { recursive: true }); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Path segments
// ---------------------------------------------------------------------------

/**
 * The one definition of a path segment this plugin will write.
 *
 * A run id normally arrives from `lib/runid.mjs` as `cc-<slug>-<hash>`, but it can also be
 * pinned by hand in a settings file or an environment variable, and a prompt id arrives
 * from the host. Both are untrusted input to a path: anything that could climb out of the
 * directory it is joined under is flattened rather than trusted.
 *
 * This lived as four near-identical private copies (`safeSegment`, `safeId`, `idPart`) plus
 * one join that had none, which is how `stage-prompt` came to write turn state to a path no
 * sibling would look in. One copy, imported everywhere, is the fix.
 *
 * @param {unknown} value
 * @param {number} [max]  truncate to this many characters; 0 leaves it uncapped
 * @returns {string}  the flattened segment, or `''` when nothing usable is left
 */
export function safeSegment(value, max = 0) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  let safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  if (max > 0) safe = safe.slice(0, max);
  return safe && safe !== '.' && safe !== '..' ? safe : '';
}

/**
 * `${dataDir}/runs/<run_id>` — the per-run root every hook writes under.
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {string}
 */
export function runDir(cfg, runId) {
  return join(resolveDataDir(cfg), 'runs', safeSegment(runId));
}
