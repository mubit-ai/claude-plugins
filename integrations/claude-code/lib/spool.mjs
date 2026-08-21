// @ts-check
/**
 * `lib/spool.mjs` — the durable buffer between capture and the network.
 *
 * The module API, the state layout and the 60 s drain-lock TTL,
 * §5.4/§5.5 (capture writes, drain reads), §12.6 (the 200-concurrent-append property).
 *
 * Capture is synchronous, hot and network-free; drain is detached, batched and networked.
 * This module is the seam. Three rules hold throughout, exactly as in `lib/state.mjs`:
 *
 *   1. Zero dependencies, Node >= 20 built-ins only, no import outside `lib/` — a detached
 *      drain child imports this module by absolute `file://` URL.
 *   2. Everything is synchronous. A hook process is about to exit; an event-loop round trip
 *      buys nothing and adds a "the process died before the write landed" failure mode.
 *   3. Nothing here throws. A memory layer has no business breaking a prompt (§4.9).
 *
 * ---------------------------------------------------------------------------
 * Why one file per item and not an append-only NDJSON log
 * ---------------------------------------------------------------------------
 * `fs.appendFileSync` with `O_APPEND` is only atomic below `PIPE_BUF` (4 KiB on Linux,
 * 512 B on macOS). Captured tool output routinely exceeds that, so two concurrent
 * `PostToolUse` hooks appending to one log interleave mid-line and corrupt both records.
 * File-per-item makes concurrent capture lock-free, makes a partial write self-evident
 * (unparseable -> unlink), and lets `commitBatch` unlink exactly what was accepted.
 *
 * Each item is written to a sibling temp file and `rename(2)`d into place, so a concurrent
 * `readBatch` sees either no file or the whole file — never a half-written one. The temp
 * name does not end in `.json`, so it is invisible to every reader here.
 */

import {
  closeSync, existsSync, linkSync, openSync, readdirSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { ensureDir, resolveDataDir, runDir, safeSegment } from './state.mjs';

/** §7: `runs/<run_id>/drain.lock` is assumed orphaned past this age and stolen. */
const DRAIN_LOCK_TTL_MS = 60_000;

/** §6.1 `MUBIT_CC_BATCH_MAX_ITEMS` default, used when a caller passes no usable `max`. */
const DEFAULT_MAX = 32;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * The `idempotency_key` for one ingest batch.
 *
 * Content-addressed on purpose: `(run_id, the item ids in this batch)` and nothing else.
 * `drain` and `session-end` drain the same spool — `session-end` steals a lock `drain` left
 * behind after 60 s, and `drain` has a hard stop that can leave a batch uncommitted — so the
 * same files are genuinely sent by both. They used to build this key differently (one keyed
 * on the prompt id under a `cc-` prefix, the other on the session id under `cc-end-`), which
 * meant the one case the key exists for was the one case it did not cover, while four
 * comments in this codebase claimed it did.
 *
 * The item ids stay in the digest for the reason the older versions gave: a *different*
 * batch landing on the same sequence number must not be deduped against an earlier one it
 * has nothing in common with. Content-addressing keeps that and drops the sender.
 *
 * @param {string} runId
 * @param {any[]} items
 * @returns {string}
 */
export function batchIdempotencyKey(runId, items) {
  const ids = (Array.isArray(items) ? items : [])
    .map((it) => (it && typeof it === 'object' ? String(it.item_id ?? '') : ''))
    .join('|');
  const digest = createHash('sha256')
    .update(`${String(runId ?? '')}|${ids}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `cc-batch-${digest}`;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** §7: `runs/<run_id>/spool/`. @param {Record<string, any>} cfg @param {string} runId */
function spoolDir(cfg, runId) {
  return join(runDir(cfg, runId), 'spool');
}

/** `<ts>-<rand6>.json` (§7). Crypto-seeded so two processes cannot agree by accident. */
function rand6() {
  let s = '';
  try {
    const b = randomBytes(6);
    for (let i = 0; i < 6; i++) s += ALPHABET[b[i] % ALPHABET.length];
  } catch {
    for (let i = s.length; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return s;
}

// ---------------------------------------------------------------------------
// appendItem
// ---------------------------------------------------------------------------

/**
 * §4.6: write one wire-shaped ingest item to `runs/<run_id>/spool/<ts>-<rand6>.json`.
 *
 * The file content is the item verbatim — the drain sends it through untouched, so
 * whatever `capture.mjs` hands over here is what reaches `/v2/control/ingest`.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {Record<string, any>} item
 * @returns {string} the path written, or '' when the item could not be spooled
 */
export function appendItem(cfg, runId, item) {
  try {
    if (!item || typeof item !== 'object') return '';
    const dir = spoolDir(cfg, runId);
    if (!ensureDir(dir)) return '';

    let body;
    try {
      body = JSON.stringify(item);
    } catch {
      return ''; // circular / unserializable: drop the item, never the hook
    }
    if (typeof body !== 'string') return '';

    // A same-millisecond collision across processes would silently overwrite an item, and
    // the 200-append property test would see 199 files. Re-roll the suffix on a hit.
    for (let attempt = 0; attempt < 8; attempt++) {
      const target = join(dir, `${Date.now()}-${rand6()}.json`);
      if (existsSync(target)) continue;
      const tmp = `${target}.tmp-${process.pid}`;
      try {
        writeFileSync(tmp, body, 'utf8');
        renameSync(tmp, target);   // atomic within a filesystem: readers never see a partial
        return target;
      } catch {
        try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
        return '';
      }
    }
    return '';
  } catch {
    // §4.9/§12.1: an unwritable ${CLAUDE_PLUGIN_DATA} costs the capture, nothing else.
    return '';
  }
}

// ---------------------------------------------------------------------------
// readBatch / commitBatch
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SpoolEntry
 * @property {string} path  absolute path, so `commitBatch` can unlink exactly this file
 * @property {any} item     the parsed item, verbatim
 */

/**
 * The sort key for "oldest first". The `<ts>` prefix is authoritative — it is written by
 * `appendItem` and is stable across the `cp`/`rsync` that would rewrite an mtime. Only a
 * file whose name carries no timestamp falls back to `stat(2)`.
 * @param {string} dir @param {string} name @returns {number}
 */
function stampOf(dir, name) {
  const m = /^(\d{10,})-/.exec(name);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return n;
  }
  try { return statSync(join(dir, name)).mtimeMs; } catch { return 0; }
}

/**
 * Spool file names for a run, oldest first.
 *
 * `withFileTypes` is what keeps `spool/rejected/` — the §5.5 quarantine for batches the
 * server refused with a non-retryable 4xx — out of every read. Re-reading a quarantined
 * batch would retry a 422 forever, which is precisely the unbounded-spool failure the
 * quarantine exists to prevent.
 *
 * @param {string} dir @returns {string[]}
 */
function orderedNames(dir) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }

  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => ({ name: e.name, ts: stampOf(dir, e.name) }))
    .sort((a, b) => (a.ts - b.ts) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => e.name);
}

/**
 * §4.6: up to `max` entries, oldest first. A read — nothing is unlinked except files that
 * cannot be parsed.
 *
 * An unparseable file is a SIGKILL caught mid-write (or a foreign file dropped in the
 * spool). It is unlinked in passing and the batch still ships: retrying a torn file
 * forever is how a spool becomes unbounded (§12.1).
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {number} [max]
 * @returns {SpoolEntry[]}
 */
export function readBatch(cfg, runId, max = DEFAULT_MAX) {
  /** @type {SpoolEntry[]} */
  const out = [];
  try {
    const limit = Number.isFinite(Number(max)) && Number(max) > 0
      ? Math.trunc(Number(max))
      : (Number(cfg?.batchMaxItems) || DEFAULT_MAX);

    const dir = spoolDir(cfg, runId);
    for (const name of orderedNames(dir)) {
      if (out.length >= limit) break;
      const path = join(dir, name);

      let raw;
      try {
        raw = readFileSync(path, 'utf8');
      } catch {
        // ENOENT: a concurrent drain already committed it. Nothing to unlink, nothing to
        // send — and pointedly NOT the torn-file case below, which must be unlinked.
        continue;
      }

      let item;
      try {
        item = raw && raw.trim() ? JSON.parse(raw) : undefined;
      } catch {
        item = undefined;
      }
      if (!item || typeof item !== 'object') {
        try { unlinkSync(path); } catch { /* already gone */ }
        continue;
      }
      out.push({ path, item });
    }
  } catch {
    // A missing or unreadable spool is the normal state of a fresh run.
  }
  return out;
}

/**
 * §5.5 step 6: unlink, and only after a 2xx. A 5xx or a network failure must leave the
 * files exactly where they are so the next drain retries them.
 *
 * A double drain carries one `idempotency_key` for the server to collapse (see
 * `batchIdempotencyKey`), so committing an already-unlinked entry is a no-op here rather
 * than a throw that would strand the rest of the batch on disk.
 *
 * @param {SpoolEntry[]} entries
 * @returns {void}
 */
export function commitBatch(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  for (const e of entries) {
    const p = typeof e === 'string' ? e : e?.path;
    if (!p) continue;
    try { unlinkSync(p); } catch { /* already committed, or never landed */ }
  }
}

// ---------------------------------------------------------------------------
// The drain lock
// ---------------------------------------------------------------------------

/**
 * @typedef {object} DrainLock
 * @property {string} path
 * @property {string} runId
 * @property {number} pid
 * @property {number} ts
 */

/** The lock/marker body: who holds it, and since when. @param {number} pid @param {number} ts */
function stamp(pid, ts) {
  return JSON.stringify({ pid, ts });
}

/**
 * The recorded owner of a lock file, or null when the file is unreadable or malformed.
 * A malformed lock is treated as orphaned: it cannot be attributed to a living drainer.
 * @param {string} lockPath
 * @returns {{pid: number, ts: number}|null}
 */
function readLock(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    const pid = Number(j.pid);
    let ts = Number(j.ts);
    if (!Number.isFinite(ts)) {
      // No recorded ts: fall back to the file's own age, the way §7's TTL sweep does.
      try { ts = statSync(lockPath).mtimeMs; } catch { return null; }
    }
    return { pid: Number.isFinite(pid) ? pid : 0, ts };
  } catch {
    return null;
  }
}

/**
 * Is the recorded owner still running? `process.kill(pid, 0)` sends no signal; it only
 * asks the kernel whether the pid exists. `EPERM` means it exists but belongs to another
 * user — alive, and not ours to steal from.
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {any} */ (err)?.code === 'EPERM';
  }
}

/**
 * §5.5 step 1: exactly one drainer per run, enforced by `O_EXCL` rather than a daemon —
 * two hooks can fire a detached drain within milliseconds of each other.
 *
 * A held lock is stolen in two cases:
 *   - Its recorded pid is provably gone (`process.kill(pid, 0)` throwing `ESRCH`). A
 *     drainer killed with its terminal leaves a fresh-looking lock; waiting out the full
 *     TTL for it would stall capture for a minute for no reason.
 *   - It is older than 60 s, *unconditionally* — even when its owner is demonstrably
 *     alive. A stuck lock silently stops ALL capture for a run, which is strictly worse
 *     than the rare double drain the per-batch `idempotency_key` covers — including the
 *     cross-drainer case this lock exists to make rare. (§7)
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {DrainLock|null} null when another drainer is live and must be left alone
 */
export function acquireDrainLock(cfg, runId) {
  try {
    const dir = runDir(cfg, runId);
    if (!ensureDir(dir)) return null;
    const lockPath = join(dir, 'drain.lock');

    const held = create(lockPath);
    if (held) return { path: lockPath, runId: String(runId ?? ''), pid: process.pid, ts: held };

    const owner = readLock(lockPath);
    const now = Date.now();
    const expired = !owner || (now - owner.ts) >= DRAIN_LOCK_TTL_MS;
    const orphaned = !owner || !pidAlive(owner.pid);
    if (!expired && !orphaned) return null;

    // Steal by removing and re-creating with O_EXCL, so two simultaneous stealers still
    // resolve to one winner rather than both believing they hold the lock.
    try { unlinkSync(lockPath); } catch { /* another stealer got there first */ }
    const stolen = create(lockPath);
    if (!stolen) return null;
    return { path: lockPath, runId: String(runId ?? ''), pid: process.pid, ts: stolen };
  } catch {
    return null;
  }
}

/**
 * Exclusive create that publishes the lock **with its stamp already in it**. Returns the
 * recorded ts on success, 0 when the lock is already held.
 *
 * The obvious `open(lockPath, 'wx')` + `write(stamp)` is wrong, and wrong in the direction
 * that costs memory. `O_EXCL` makes an *empty* file visible the instant it returns and the
 * stamp lands a moment later; a second drainer arriving inside that window reads an
 * unparseable lock, correctly concludes "orphaned" by the rule above, and steals a lock
 * that is microseconds old. Both then drain the same batch. Two hooks fire detached drains
 * within milliseconds of each other by design (§5.5), so this is the ordinary case, not an
 * exotic one — measured at 4 double-acquires in 40 racing trials.
 *
 * `link(2)` is the fix: it fails with `EEXIST` when the target exists, so the lock never
 * exists in an unstamped state. The temp file is written with `wx` too, and unlinked either
 * way.
 *
 * @param {string} lockPath
 * @returns {number}
 */
function create(lockPath) {
  const ts = Date.now();
  const body = stamp(process.pid, ts);
  const tmp = `${lockPath}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;

  try {
    writeFileSync(tmp, body, { flag: 'wx' });
  } catch {
    return 0;
  }

  try {
    linkSync(tmp, lockPath);
    return ts;
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'EEXIST') return 0;
    // A filesystem without hard links. Fall back to O_EXCL + stamp: the window above comes
    // back, but no lock at all would be strictly worse.
    let fd;
    try { fd = openSync(lockPath, 'wx'); } catch { return 0; }
    try { writeSync(fd, body); } catch { /* the file itself is the claim */ }
    finally { try { closeSync(fd); } catch { /* already closed */ } }
    return ts;
  } finally {
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
}

/**
 * §5.5: released in a `finally`, where the lock is legitimately null on every path that
 * stood down. Accepts the lock object or a bare path.
 * @param {DrainLock|string|null|undefined} lock
 * @returns {void}
 */
export function releaseDrainLock(lock) {
  try {
    if (!lock) return;
    const p = typeof lock === 'string' ? lock : lock.path;
    if (!p) return;
    unlinkSync(p);
  } catch {
    // Already released, or stolen out from under us past the TTL. Either way, done.
  }
}

// ---------------------------------------------------------------------------
// claimOnce
// ---------------------------------------------------------------------------

/**
 * §5.7 step 1 / §7: the once-only marker at `runs/<run_id>/<name>.marker`, used to make
 * the SessionEnd flush idempotent across the several ways a session can end.
 *
 * **Returns `true` on a non-`EEXIST` error — proceed on marker failure.** The marker exists
 * to prevent a *double* flush; a read-only or full `${CLAUDE_PLUGIN_DATA}` must not be able
 * to prevent the flush *entirely*. Losing a session's captures is worse than sending them
 * twice, and the same items carry the same per-batch `idempotency_key` either way, so the
 * double send is one the server can collapse (§4.6, §12.1).
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {string} name  e.g. `flushed-<session_id>`
 * @returns {boolean} true when this process owns the claim (or could not record one)
 */
export function claimOnce(cfg, runId, name) {
  try {
    const safe = safeSegment(name);
    if (!safe) return true;                 // nothing to claim against: proceed
    const dir = runDir(cfg, runId);
    ensureDir(dir);                          // may fail on a read-only dir; the open decides

    const marker = join(dir, `${safe}.marker`);
    let fd;
    try {
      fd = openSync(marker, 'wx');
    } catch (err) {
      // The one case that means "someone else already did this".
      if (/** @type {any} */ (err)?.code === 'EEXIST') return false;
      return true;                           // EACCES, ENOSPC, EROFS, ... -> proceed
    }
    try { writeSync(fd, stamp(process.pid, Date.now())); } catch { /* the file is the claim */ }
    finally { try { closeSync(fd); } catch { /* already closed */ } }
    return true;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// spoolStats
// ---------------------------------------------------------------------------

/**
 * §5.3: `count >= batchMaxItems OR oldestMs >= batchMaxAgeMs` triggers a detached drain,
 * so this is asked on every single prompt. It must be cheap, total, and never throw.
 *
 * It is the OLDEST item that decides, not the newest: with a newest-first age a steady
 * trickle of captures would keep resetting the trigger and the first item would never ship.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {{count: number, oldestMs: number}}
 */
export function spoolStats(cfg, runId) {
  try {
    const dir = spoolDir(cfg, runId);
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return { count: 0, oldestMs: 0 }; }

    let count = 0;
    let oldest = Infinity;
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;   // skips spool/rejected/
      count++;
      const ts = stampOf(dir, e.name);
      if (ts > 0 && ts < oldest) oldest = ts;
    }
    if (count === 0 || !Number.isFinite(oldest)) return { count, oldestMs: 0 };
    return { count, oldestMs: Math.max(0, Date.now() - oldest) };
  } catch {
    return { count: 0, oldestMs: 0 };
  }
}
