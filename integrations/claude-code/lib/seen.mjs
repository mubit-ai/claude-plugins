// @ts-check
/**
 * `lib/seen.mjs` — what one conversation has already been shown, and when.
 *
 * The state layout and its TTL table, and the recall path that reads and
 * writes it), §5.6 (the compaction reset).
 *
 * ---------------------------------------------------------------------------
 * Why this file exists
 * ---------------------------------------------------------------------------
 * `lib/assemble.mjs` dedupes `sourceRefIds` *within* one block — "the same entry surfacing
 * through two retrieval lanes" is collapsed. Nothing dedupes *across* turns. So a lesson
 * that stays relevant for twenty prompts was rendered twenty times, at full price, and all
 * twenty copies sat in the transcript competing with each other.
 *
 * That is the plugin's largest recurring cost by an order of magnitude. Measured against
 * the surfaces it was assumed to be cheaper than: the MCP tool names load once at 356
 * tokens, the skill and agent frontmatter once at 409, and recall injection costs up to
 * 1500 tokens **on every prompt**. Over forty prompts that is 60,000 against 356.
 *
 * ---------------------------------------------------------------------------
 * The scope is one conversation, and only a conversation can hold it
 * ---------------------------------------------------------------------------
 * A pointer says "you were given this in full earlier in this conversation". That sentence
 * is only true of the transcript the entry was injected into, so the set is keyed by the
 * host session id **and** the run: `runs/<run_id>/seen/<session_id>.json`.
 *
 * It was keyed by the run alone, and the run is the wrong unit. Under the default
 * `per-directory` strategy a run id is derived from the path, so every session opened in a
 * directory shared one set for six hours. Session B was handed pointers for what session A
 * had seen, and A's compaction wiped B's record. Worse, a shell command that rendered the
 * catalogue marked the set too, and a shell has no way of knowing whether its stdout ever
 * reached a model — one verification run from a plain terminal turned the next conversation's
 * whole listing into fragments with nothing to dereference them against.
 *
 * So two things hold now. A process with no usable session id **never touches this file**:
 * it reads an empty set, marks nothing, and clears nothing, which degrades to "render in
 * full" — the fail-safe direction, and what a caller that forgets the argument gets. And
 * `bin/admin.mjs`, which is a shell command, does not call this module at all.
 *
 * ---------------------------------------------------------------------------
 * A roll-up, not a new source of truth
 * ---------------------------------------------------------------------------
 * Every id in this file was already written to `runs/<run_id>/turns/<prompt_id>.json` under
 * `recalled` (§5.2 step 6) — the array `lib/outcome.mjs:170` later reads as `entry_ids`.
 * This is an aggregation over files the plugin is already writing, kept as one file so the
 * blocking recall path costs one `readFileSync` rather than one per turn in the session.
 *
 * That is what makes every failure here cheap: **losing this file costs one expensive turn
 * and cannot cost correctness.** A read that fails, a write that fails, an entry evicted by
 * the bound or expired by the TTL — all of them mean "render it in full again", which is
 * exactly what the plugin did before this module existed.
 *
 * The three rules from `lib/spool.mjs` and `lib/state.mjs` hold throughout:
 *
 *   1. Zero dependencies, Node >= 20 built-ins only, no import outside `lib/`.
 *   2. Everything is synchronous. A hook process is about to exit.
 *   3. Nothing here throws. A memory layer has no business breaking a prompt (§4.9).
 */

import { unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { hostSessionId } from './runid.mjs';
import { readJson, runDir, safeSegment, writeJsonAtomic } from './state.mjs';

/**
 * §7: the same 6 h the turn files get, and for the same reason.
 *
 * A memory the model can no longer see is not a memory it has seen. `runs/<run_id>/turns/`
 * expires at 6 h and this file is an aggregation over exactly those, so it expires with
 * them. Past the TTL an entry goes back to being rendered in full — the safe direction: the
 * cost of an unnecessary expansion is tokens, and the cost of an unwarranted pointer is the
 * model being told a memory applies with no way to read it.
 *
 * The age is measured from the LAST sighting, not the first. A memory injected again a
 * minute ago is in the window however long ago it first arrived.
 */
export const SEEN_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * The ceiling on tracked ids.
 *
 * This file is read synchronously in front of every prompt, so its size is a latency cost
 * and not only a disk one. A long session against a wide store can surface thousands of
 * distinct entries; 512 covers far more than any recall window and bounds the read. Past it
 * the least recently seen entries are evicted, which only makes them expensive again.
 */
export const MAX_SEEN_REFS = 512;

/** The directory under the run that holds one file per conversation. */
export const SEEN_DIR = 'seen';

/**
 * A session id is a path segment here. Host ids are UUIDs; this leaves room for a longer
 * one without letting an arbitrary string become an arbitrarily long file name.
 */
const MAX_SESSION_SEGMENT = 128;

/**
 * @typedef {object} SeenEntry
 * @property {number} first  when this id was first injected — when full price was paid
 * @property {number} last   when it was last injected; the TTL is measured from here
 * @property {number} count  how many turns have carried it
 */

/**
 * @typedef {object} Seen
 * @property {Set<string>} ids            the unexpired ids, ready for `assembleContext`
 * @property {Record<string, SeenEntry>} entries
 * @property {number} updatedAt
 */

/** A fresh empty result per call — callers own what they are handed. @returns {Seen} */
function emptySeen() {
  return { ids: new Set(), entries: {}, updatedAt: 0 };
}

/**
 * §7: `runs/<run_id>/seen/<session_id>.json`, or `''` when either id leaves no usable path
 * segment.
 *
 * A run id normally arrives from `lib/runid.mjs`, but it can be pinned by hand in a
 * settings file or an environment variable, so it is untrusted input to a path — the same
 * rule `lib/state.mjs` applies everywhere. An empty segment would resolve to `runs/`
 * itself, which is a shared directory and not this run's.
 *
 * The session id is judged by `hostSessionId`, the one definition of "a usable session id"
 * the plugin has: blank and the placeholders (`default`, `none`, …) are not identities, and
 * a process holding one of those is not a conversation, so it gets no file. That is the
 * whole mechanism behind "a process with no session never touches the set".
 *
 * @param {Record<string, any>} cfg @param {string} runId @param {string} sessionId
 * @returns {string}
 */
function seenPath(cfg, runId, sessionId) {
  if (!safeSegment(runId)) return '';
  const session = safeSegment(hostSessionId({ session_id: sessionId }), MAX_SESSION_SEGMENT);
  if (!session) return '';
  return join(runDir(cfg, runId), SEEN_DIR, `${session}.json`);
}

// ---------------------------------------------------------------------------
// readSeen
// ---------------------------------------------------------------------------

/**
 * What this conversation has already put in front of the model, with the TTL applied.
 *
 * Total by construction: a missing file is the ordinary first-prompt case, and a truncated
 * or foreign one is the ordinary state after a SIGKILL. Both answer "nothing seen", which
 * re-expands every entry — expensive, never wrong. So does a missing session id.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {string} [sessionId]  the host's `session_id`; nothing is read without one
 * @returns {Seen}
 */
export function readSeen(cfg, runId, sessionId = '') {
  try {
    const p = seenPath(cfg, runId, sessionId);
    if (!p) return emptySeen();

    const raw = readJson(p, null);
    if (!isObject(raw) || !isObject(raw.refs)) return emptySeen();

    const cutoff = Date.now() - SEEN_TTL_MS;
    const out = emptySeen();
    out.updatedAt = num(raw.updated_at, 0);

    for (const [id, v] of Object.entries(raw.refs)) {
      if (!id || !id.trim() || !isObject(v)) continue;
      const last = num(v.last, 0);
      // No timestamp is no evidence the model ever saw it. Renders in full.
      if (!(last > 0) || last < cutoff) continue;
      const first = num(v.first, 0);
      out.entries[id] = {
        first: first > 0 ? first : last,
        last,
        count: Math.max(1, Math.trunc(num(v.count, 1))),
      };
      out.ids.add(id);
    }
    return out;
  } catch {
    // §4.9/§12.1: an unreadable ${CLAUDE_PLUGIN_DATA} costs the saving, nothing else.
    return emptySeen();
  }
}

// ---------------------------------------------------------------------------
// markSeen
// ---------------------------------------------------------------------------

/**
 * Record the reference ids one turn actually injected into one conversation.
 *
 * Called from `hooks/src/prompt-recall.mjs` beside `persistRecalled`, and only on a turn
 * that rendered something: marking a recall that failed or returned nothing would make the
 * *next* prompt point at a memory the model was never given. The MCP results guard marks
 * what a tool result rendered, for the same reason and under the same session.
 *
 * Read-modify-write with `writeJsonAtomic`, matching every other per-run file. Two prompt
 * hooks cannot race here in practice — `UserPromptSubmit` fires once per prompt — and if
 * one ever did, the loser's sightings are re-learned on its next turn.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {string[]} refIds  `reference_id` values, as rendered
 * @param {string} [sessionId]  the host's `session_id`; nothing is written without one
 * @returns {boolean} true when the roll-up landed
 */
export function markSeen(cfg, runId, refIds, sessionId = '') {
  try {
    const p = seenPath(cfg, runId, sessionId);
    if (!p) return false;

    const ids = usableIds(refIds);
    if (ids.length === 0) return false;   // a turn that injected nothing records nothing

    // Reading through `readSeen` applies the TTL on the way in, so the sweep is free and
    // the file never accumulates entries nothing will ever consult again.
    const prior = readSeen(cfg, runId, sessionId).entries;
    const now = Date.now();
    /** @type {Record<string, SeenEntry>} */
    const refs = { ...prior };

    for (const id of ids) {
      const was = refs[id];
      // `first` is when the model was given the whole entry; it is never overwritten,
      // because that is the moment the full price was paid.
      refs[id] = was
        ? { first: was.first, last: now, count: was.count + 1 }
        : { first: now, last: now, count: 1 };
    }

    return writeJsonAtomic(p, {
      run_id: String(runId ?? ''),
      session_id: String(sessionId ?? ''),
      updated_at: now,
      refs: bounded(refs),
    });
  } catch {
    return false;
  }
}

/**
 * The §7 ceiling, applied at the write.
 *
 * Most recently seen first; on a tie — every id marked by one turn shares a millisecond —
 * the later of the two survives, so eviction always drops the oldest sighting rather than
 * whichever key `Object.entries` happened to yield first.
 *
 * @param {Record<string, SeenEntry>} refs
 * @returns {Record<string, SeenEntry>}
 */
function bounded(refs) {
  const rows = Object.entries(refs);
  if (rows.length <= MAX_SEEN_REFS) return refs;

  /** @type {Record<string, SeenEntry>} */
  const out = {};
  rows
    .map((row, i) => /** @type {[string, SeenEntry, number]} */ ([row[0], row[1], i]))
    .sort((a, b) => (b[1].last - a[1].last) || (b[2] - a[2]))
    .slice(0, MAX_SEEN_REFS)
    .forEach(([id, entry]) => { out[id] = entry; });
  return out;
}

/**
 * §1.3: `reference_id` must be non-empty. An entry with no id can never be pointed at, so
 * it must not take a slot in a bounded file either. The same id twice in one turn is one
 * injection — `lib/assemble.mjs` already deduped `sourceRefIds`, and this keeps the count
 * honest for anyone who reaches for the file directly.
 *
 * @param {any} refIds @returns {string[]}
 */
function usableIds(refIds) {
  if (!Array.isArray(refIds)) return [];
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const v of refIds) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// clearSeen
// ---------------------------------------------------------------------------

/**
 * Forget everything this conversation has been shown — the compaction reset (§5.6).
 *
 * Compaction resets the model's window, not the file. After `PostCompact` the transcript
 * the entries were injected into is **gone**, so a surviving pointer names a memory that
 * exists nowhere in the conversation. That is the one failure mode of the whole mechanism
 * that is worse than paying full price, because the model is told a memory applies and is
 * given no way to read it. `hooks/src/checkpoint.mjs --post` already runs on exactly that
 * event and calls this.
 *
 * Only the compacted session's file goes. Another conversation in the same run still has
 * its transcript, and its pointers are still true.
 *
 * Returns true when there is nothing left to clear, which includes the file never having
 * existed and there being no session to clear for: the caller's question is "is this
 * conversation's slate clean", not "did I delete a file".
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {string} [sessionId]  the host's `session_id`; nothing is deleted without one
 * @returns {boolean}
 */
export function clearSeen(cfg, runId, sessionId = '') {
  try {
    const p = seenPath(cfg, runId, sessionId);
    if (!p) return true;
    try { unlinkSync(p); } catch { /* never written, or already cleared */ }
    return true;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/** @param {any} v @returns {boolean} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @param {any} v @param {number} d @returns {number} */
function num(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}
