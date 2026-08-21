// @ts-check
/**
 * `lib/carry.mjs` — the block one turn leaves for the next (§5.2, `recallAsync`).
 *
 * ---------------------------------------------------------------------------
 * Why a file, and not `"async": true`
 * ---------------------------------------------------------------------------
 * Claude Code really does have a backgrounding path for hooks. As of 2.1.235 a hook
 * registration honours two fields the published hook reference does not document: `async`,
 * which runs the hook in the background without blocking, and `asyncRewake`, which does the
 * same and additionally wakes the model when the hook exits 2 (a blocking error). The host
 * bounds the resulting flush with a timeout of its own. So the mechanism is real. It is
 * simply **not runtime-flippable**: `async` is a static field of a `hooks.json`
 * registration, and nothing in a manifest can be conditioned on a config key the user sets
 * after install. Expressing a flag-gated `recallAsync` that way needs two registrations of
 * the same hook — one async, one not — each no-oping when the other is meant to be in
 * charge. That is two node processes in front of every prompt, forever, including for the
 * people who never turn the flag on. The flag exists precisely so that they pay nothing.
 *
 * Carry-forward routes around it with no manifest change at all. The synchronous hook reads
 * a block the previous turn's detached refresh left here and returns; the refresh dials
 * without a prompt waiting on it. Same trade — one turn of staleness, never blocking, never
 * timing out — runtime-flippable, and testable offline.
 *
 * ---------------------------------------------------------------------------
 * The file is an `Outcome`, deliberately
 * ---------------------------------------------------------------------------
 * `takeCarry` hands back exactly the shape `recallBlock` returns, so the rendering, the
 * `recalled` write and the seen-set mark are one code path in both modes. A second shape
 * here would be a second place for `pointers` or `refIds` to go missing — and `pointers` is
 * what decides whether the injected wrapper explains its own reference lines.
 *
 * ---------------------------------------------------------------------------
 * Consume-once is the load-bearing rule
 * ---------------------------------------------------------------------------
 * `takeCarry` unlinks what it reads. A refresh that stops answering — the endpoint went
 * down, the child was reaped, the breaker opened — must not leave the last good block to be
 * re-injected on every prompt for the rest of the session. That failure is worse than no
 * recall at all: it costs full price forever to answer a question the user moved on from,
 * and it looks like a working memory layer the whole time.
 *
 * The TTL is the same rule against a slower clock, for the laptop that was closed mid-turn.
 *
 * The three rules `lib/seen.mjs` and `lib/spool.mjs` share hold here too:
 *
 *   1. Zero dependencies, Node >= 20 built-ins only, no import outside `lib/`.
 *   2. Everything is synchronous. A hook process is about to exit.
 *   3. Nothing throws. Losing this file costs one un-recalled turn, never a prompt (§4.9).
 */

import { unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { readJson, runDir, safeSegment, writeJsonAtomic } from './state.mjs';

/**
 * How long a carried block stays injectable.
 *
 * One turn of staleness is the trade this mode makes and it is a fair one — a lesson does
 * not stop being a lesson in thirty seconds. Fifteen minutes of it is a different thing: the
 * block was retrieved against a prompt the user has long since finished with, and injecting
 * it spends the token budget describing the wrong problem.
 *
 * The refresh runs on every prompt, so an active session never comes near this bound. What
 * it catches is the session that was left open over lunch and the laptop that was closed
 * mid-turn — where the next thing the user types is a new task, not a continuation.
 *
 * Shorter than `SEEN_TTL_MS` (6 h) on purpose: that TTL asks "can the model still see this
 * in its window", which is a question about the transcript. This one asks "is this block
 * still about what the user is doing", which is a question about the conversation.
 */
export const CARRY_TTL_MS = 15 * 60 * 1000;

/**
 * @typedef {object} Carried
 * @property {false} failed        a failed recall is never carried; the field exists so the
 *                                 shape is assignable to an `Outcome` at the call sites
 * @property {number} rung
 * @property {string} block
 * @property {number} tokens
 * @property {number} sources
 * @property {number} dropped
 * @property {number} pointers
 * @property {string} emptyReason
 * @property {string[]} refIds
 * @property {number} writtenAt
 * @property {string} forPromptId  the prompt this block was retrieved against
 * @property {number} fetchMs      what the refresh spent — the cost the prompt no longer pays
 */

/**
 * §7: `runs/<run_id>/carry.json`, or `''` when the run id leaves no usable path segment.
 *
 * A run id can be pinned by hand in a settings file or an environment variable, so it is
 * untrusted input to a path — the same rule `lib/state.mjs` applies everywhere. An empty
 * segment would resolve to `runs/` itself, which is shared and not this run's.
 *
 * @param {Record<string, any>} cfg @param {string} runId @returns {string}
 */
function carryPath(cfg, runId) {
  if (!safeSegment(runId)) return '';
  return join(runDir(cfg, runId), 'carry.json');
}

// ---------------------------------------------------------------------------
// takeCarry
// ---------------------------------------------------------------------------

/**
 * Read the block the previous turn left, and remove it.
 *
 * Total by construction. A missing file is the ordinary first-prompt case; a truncated one
 * is the ordinary state after a SIGKILL mid-write. Both answer `null`, which injects nothing
 * — the same thing every other empty recall does.
 *
 * The unlink happens whether or not the block was usable, including for an expired one: a
 * file left on disk is a file the next prompt reads and rejects again.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {Carried|null}
 */
export function takeCarry(cfg, runId) {
  try {
    const p = carryPath(cfg, runId);
    if (!p) return null;

    const raw = readJson(p, null);
    // Unlink first, and unconditionally. Consume-once has to survive a malformed file too,
    // or a block that cannot be parsed becomes a permanent read on the blocking path.
    try { unlinkSync(p); } catch { /* never written, or already taken */ }

    if (!isObject(raw)) return null;
    const block = typeof raw.block === 'string' ? raw.block : '';
    if (!block) return null;

    const writtenAt = num(raw.written_at, 0);
    if (!(writtenAt > 0) || Date.now() - writtenAt > CARRY_TTL_MS) return null;

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
      forPromptId: typeof raw.for_prompt_id === 'string' ? raw.for_prompt_id : '',
      fetchMs: int(raw.fetch_ms, 0),
    };
  } catch {
    // §4.9/§12.1: an unreadable ${CLAUDE_PLUGIN_DATA} costs the carried turn, nothing else.
    return null;
  }
}

// ---------------------------------------------------------------------------
// writeCarry
// ---------------------------------------------------------------------------

/**
 * Leave a block for the next turn.
 *
 * Called only from `hooks/src/recall-refresh.mjs`, and only for an outcome that actually
 * rendered something: an empty or failed recall writes nothing, so a block still in date is
 * not overwritten by the fact that one refresh drew a blank.
 *
 * Note what is **not** stored: the prompt text. It is already in
 * `runs/<run_id>/turns/<prompt_id>.json`, and a second copy would be a second place for a
 * secret to land (§4.4). `for_prompt_id` gives the same provenance for free.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {{rung?: number, block?: string, tokens?: number, sources?: number, dropped?: number,
 *          pointers?: number, emptyReason?: string, refIds?: string[]}} outcome
 * @param {{promptId?: string, fetchMs?: number}} [meta]
 * @returns {boolean} true when the block landed
 */
export function writeCarry(cfg, runId, outcome, meta = {}) {
  try {
    const p = carryPath(cfg, runId);
    if (!p) return false;

    const block = typeof outcome?.block === 'string' ? outcome.block : '';
    if (!block.trim()) return false;

    return writeJsonAtomic(p, {
      run_id: String(runId ?? ''),
      written_at: Date.now(),
      for_prompt_id: String(meta?.promptId ?? ''),
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
// clearCarry
// ---------------------------------------------------------------------------

/**
 * Drop whatever is carried — the compaction reset (§5.6), shared with `clearSeen`.
 *
 * A block assembled *before* a compaction may carry pointer lines, and a pointer is a
 * promise that the full entry is somewhere earlier in this conversation. After a compaction
 * it is not. `clearSeen` exists for exactly that reason and this file has to go with it:
 * clearing the seen-set alone would leave a block whose pointers were already baked in.
 *
 * Returns true when nothing is carried, which includes the file never having existed — the
 * caller's question is "is this run's slate clean", not "did I delete a file".
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {boolean}
 */
export function clearCarry(cfg, runId) {
  try {
    const p = carryPath(cfg, runId);
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
