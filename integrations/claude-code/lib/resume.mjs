// @ts-check
/**
 * `lib/resume.mjs` — the briefing a session leaves for its own first prompt (W2-2).
 *
 * ---------------------------------------------------------------------------
 * Why this is a twin of `lib/carry.mjs` and not a second mode inside it
 * ---------------------------------------------------------------------------
 * The two files look alike on purpose: same `Outcome` on disk, same consume-once rule, same
 * three constraints. They are still two files, and the reasons are not stylistic.
 *
 *   - **Two detached writers on one path is a race.** With `recallAsync` on, `recall-refresh`
 *     writes `carry.json` after *every* prompt and `takeCarry` unlinks it. `session-resume`
 *     writes once, at the start of the session, into a window where the first prompt may
 *     already have fired. Nothing locks either write, and the losing outcome is silent: a
 *     briefing overwritten by a refresh, or a refresh overwritten by a briefing, with a
 *     correct-looking block on disk either way.
 *   - **The wrapper would lie.** If a briefing arrived through `carry.json`, `carryForward`
 *     would render it via `wrap(…, carried = true)`, which prints *"it was retrieved against
 *     the previous message in this conversation"*. This block was assembled before any
 *     message existed. That sentence exists precisely so the model can tell one-turn-old
 *     context from context about the prompt in hand; spending it on a falsehood costs more
 *     than the twenty tokens it saves.
 *
 * The TTL is the other difference, and it is the same rule against a different clock.
 * `CARRY_TTL_MS` is fifteen minutes because a carried block was retrieved against the
 * *previous prompt* and stops being about the work the moment the subject changes. A briefing
 * is about the state of the work when the session opened, which is still true half an hour in.
 * Past that the session has become its own context and the briefing is describing history the
 * model has already lived through.
 *
 * ---------------------------------------------------------------------------
 * The file is an `Outcome`, deliberately
 * ---------------------------------------------------------------------------
 * `takeResume` hands back the same shape `recallBlock` returns, for the reason `lib/carry.mjs`
 * gives: one rendering path, one attribution path, one seen-set write. A second shape here is
 * a second place for `refIds` to go missing — and `refIds` is the whole of what the receiving
 * turn credits and marks.
 *
 * ---------------------------------------------------------------------------
 * Consume-once is the load-bearing rule
 * ---------------------------------------------------------------------------
 * `takeResume` unlinks what it reads, first and unconditionally, including a file it cannot
 * parse. A briefing that could be re-read would be re-injected on every prompt for the rest of
 * the session — a 1000-token preamble describing the session's own opening, paid for forever,
 * looking like a working memory layer the whole time. `lib/carry.mjs` calls that failure worse
 * than no recall at all, and it is worse again here: this block is larger and ages faster.
 *
 * The three rules `lib/seen.mjs`, `lib/spool.mjs` and `lib/carry.mjs` share hold here too:
 *
 *   1. Zero dependencies, Node >= 20 built-ins only, no import outside `lib/`.
 *   2. Everything is synchronous. A hook process is about to exit.
 *   3. Nothing throws. Losing this file costs one un-briefed session, never a prompt (§4.9).
 */

import { unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { readJson, runDir, safeSegment, writeJsonAtomic } from './state.mjs';

/**
 * How long a briefing stays injectable.
 *
 * Twice `CARRY_TTL_MS`, and the two answer different questions. That one asks "is this block
 * still about what the user is doing", which turns over with every prompt. This one asks "has
 * this session accumulated enough context of its own to make the opening summary redundant",
 * which is a question about the session rather than about the turn.
 *
 * What it catches is the session that was opened and walked away from — the terminal left open
 * over lunch, the window opened to check one thing and returned to hours later. The next thing
 * typed there is a new task, and a briefing about where a different afternoon left off spends
 * the token budget describing the wrong problem, with all the authority of a section heading.
 */
export const RESUME_TTL_MS = 30 * 60 * 1000;

/**
 * @typedef {object} Resumed
 * @property {false} failed        a failed assembly is never stored; the field exists so the
 *                                 shape is assignable to an `Outcome` at the call sites
 * @property {number} rung
 * @property {string} block
 * @property {number} tokens
 * @property {number} sources
 * @property {number} dropped
 * @property {number} pointers
 * @property {string} emptyReason
 * @property {string[]} refIds
 * @property {number} writtenAt    when the briefing was assembled — what the wrapper states
 * @property {string} source       the `SessionStart` source that asked for it
 * @property {number} fetchMs      what the child spent; the cost the session did not pay
 */

/**
 * §7: `runs/<run_id>/resume.json`, or `''` when the run id leaves no usable path segment.
 *
 * A run id can be pinned by hand in a settings file or an environment variable, so it is
 * untrusted input to a path — the same rule `lib/state.mjs` applies everywhere. An empty
 * segment would resolve to `runs/` itself, which is shared and not this run's.
 *
 * @param {Record<string, any>} cfg @param {string} runId @returns {string}
 */
function resumePath(cfg, runId) {
  if (!safeSegment(runId)) return '';
  return join(runDir(cfg, runId), 'resume.json');
}

// ---------------------------------------------------------------------------
// takeResume
// ---------------------------------------------------------------------------

/**
 * Read the briefing this session's child left, and remove it.
 *
 * Total by construction. A missing file is the ordinary case on every session that did not
 * qualify for one — `/clear`, a compaction, a fork, an install with the flag off — and a
 * truncated one is the ordinary state after a SIGKILL mid-write. Both answer `null`, which
 * injects nothing, the same thing every other empty recall does.
 *
 * The unlink happens whether or not the block was usable, including for an expired one: a
 * file left on disk is a file the next prompt reads and rejects again, for the whole session.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {Resumed|null}
 */
export function takeResume(cfg, runId) {
  try {
    const p = resumePath(cfg, runId);
    if (!p) return null;

    const raw = readJson(p, null);
    // Unlink first, and unconditionally. Consume-once has to survive a malformed file too, or
    // a block that cannot be parsed becomes a permanent read on the blocking path.
    try { unlinkSync(p); } catch { /* never written, or already taken */ }

    if (!isObject(raw)) return null;
    const block = typeof raw.block === 'string' ? raw.block : '';
    if (!block.trim()) return null;

    const writtenAt = num(raw.written_at, 0);
    if (!(writtenAt > 0) || Date.now() - writtenAt > RESUME_TTL_MS) return null;

    const refIds = Array.isArray(raw.ref_ids)
      ? raw.ref_ids.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
      : [];

    return {
      failed: false,
      rung: int(raw.rung, 0),
      block,
      tokens: int(raw.tokens, 0),
      sources: int(raw.sources, 0) || refIds.length,
      dropped: int(raw.dropped, 0),
      pointers: int(raw.pointers, 0),
      emptyReason: typeof raw.empty_reason === 'string' ? raw.empty_reason : '',
      refIds,
      writtenAt,
      source: typeof raw.source === 'string' ? raw.source : '',
      fetchMs: int(raw.fetch_ms, 0),
    };
  } catch {
    // §4.9/§12.1-F14: an unreadable ${CLAUDE_PLUGIN_DATA} costs the briefing, nothing else.
    return null;
  }
}

// ---------------------------------------------------------------------------
// writeResume
// ---------------------------------------------------------------------------

/**
 * Leave a briefing for the first substantive prompt of this session.
 *
 * Called only from `hooks/src/session-resume.mjs`, and only for an assembly that actually
 * produced something. An empty block is refused rather than stored: downstream, an empty file
 * would be read as "there is nothing to say about this run", which is a different claim from
 * "nobody has looked yet" — and it would render as a heading with nothing under it, which is
 * the one output worse than silence.
 *
 * Note what is **not** stored: the query. It is a module constant in `lib/recall.mjs`, not
 * user text, so a copy here would carry no information and would still be a second place for
 * the file to grow.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {{rung?: number, block?: string, tokens?: number, sources?: number, dropped?: number,
 *          pointers?: number, emptyReason?: string, refIds?: string[]}} outcome
 * @param {{source?: string, fetchMs?: number}} [meta]
 * @returns {boolean} true when the briefing landed
 */
export function writeResume(cfg, runId, outcome, meta = {}) {
  try {
    const p = resumePath(cfg, runId);
    if (!p) return false;

    const block = typeof outcome?.block === 'string' ? outcome.block : '';
    if (!block.trim()) return false;

    return writeJsonAtomic(p, {
      run_id: String(runId ?? ''),
      written_at: Date.now(),
      source: String(meta?.source ?? ''),
      fetch_ms: int(meta?.fetchMs, 0),
      rung: int(outcome?.rung, 0),
      block,
      tokens: int(outcome?.tokens, 0),
      sources: int(outcome?.sources, 0),
      dropped: int(outcome?.dropped, 0),
      pointers: int(outcome?.pointers, 0),
      empty_reason: typeof outcome?.emptyReason === 'string' ? outcome.emptyReason : '',
      ref_ids: Array.isArray(outcome?.refIds)
        ? outcome.refIds.filter((v) => typeof v === 'string' && v.trim())
        : [],
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// clearResume
// ---------------------------------------------------------------------------

/**
 * Drop an un-injected briefing — the compaction reset (§5.6), shared with `clearCarry`.
 *
 * A compaction means the conversation the model can read has been rewritten, and the briefing
 * is about a session that no longer exists in the window in the form it described.
 * `session-start` re-anchors the compacted run through the checkpoint id instead, which is the
 * same job done against a transcript that is actually there.
 *
 * Returns true when nothing is staged, which includes the file never having existed — the
 * caller's question is "is this run's slate clean", not "did I delete a file".
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {boolean}
 */
export function clearResume(cfg, runId) {
  try {
    const p = resumePath(cfg, runId);
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

/** @param {any} v @param {number} d @returns {number} */
function int(v, d) {
  const n = num(v, NaN);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : d;
}
