// @ts-check
/**
 * `lib/markers.mjs` — the status-line `Marker` at `status/<run_id>.json` (§4.8, §7).
 *
 * Network-free by construction: this is the only thing `bin/statusline.mjs`
 * reads, and the status line runs on every frame. Each hook owns one slice of
 * the marker and they run in separate processes, so `updateMarker` is a merge
 * patch — never a whole-object write.
 */

import { join } from 'node:path';

import { readJson, resolveDataDir, writeJsonAtomic } from './state.mjs';

/**
 * The Marker, with every documented sub-key present and correctly typed.
 * `readMarker` returns this shape even when nothing has ever been written —
 * which is the normal state before the first hook of a session has run.
 * @param {string} [runId]
 */
function defaultMarker(runId = '') {
  return {
    run_id: runId,
    mode: 'hosted',
    state: 'unknown',
    updated_at: 0,
    cold_start_until: 0,
    // `dry_streak` and `last_hit_at` are what make a permanently dead recall path visible.
    // Everything else here describes the *last* recall, which is exactly the wrong shape for
    // "recall has returned nothing for the last forty prompts": a run of total failures and a
    // healthy run that happened to draw a blank write identical rows. The streak is the only
    // field that distinguishes them, and `recall` is the right home for it — the status line
    // and the doctor already read this group, and it is per-run, which is the scope recall
    // quality actually has. (Endpoint-scoped health is the breaker's job, not this file's.)
    recall: {
      sources: 0, tokens: 0, ms: 0, empty_reason: '', rung: 0, dropped: 0,
      dry_streak: 0, last_hit_at: 0,
    },
    captured: { tools: 0, turns: 0, pending: 0 },
    // What the MCP server sent, which the capture path never sees: an MCP write leaves its
    // own process and touches neither the spool nor `captured` above. Kept apart from that
    // group rather than folded into it, so the status line's capture count keeps meaning
    // "what the hooks captured" — but read beside it at session end, where the question is
    // the different one of whether this run put anything on the wire at all.
    mcp: { ingested: 0, at: 0 },
    lessons: { global: 0, checked_at: 0 },
    reflect: { at: 0, lessons_stored: 0, status: '' },
    last_error: '',
  };
}

/** The sub-objects that merge key-by-key rather than being replaced wholesale. */
const GROUPS = ['recall', 'captured', 'lessons', 'reflect', 'mcp'];

/** @param {Record<string, any>} cfg @param {string} runId @returns {string} */
function markerPath(cfg, runId) {
  return join(resolveDataDir(cfg), 'status', `${runId}.json`);
}

/** @param {any} v */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Merge `patch` onto `base`, one level deep for the four documented groups.
 * @param {Record<string, any>} base
 * @param {Record<string, any>} patch
 */
function merge(base, patch) {
  const out = { ...base };
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (GROUPS.includes(k) && isPlainObject(v)) {
      out[k] = { ...(isPlainObject(out[k]) ? out[k] : {}), ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * §4.8/§10: a missing or corrupt marker degrades to the default rather than
 * taking the status line — or the hook writing it — down.
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {Record<string, any>}
 */
export function readMarker(cfg, runId) {
  const base = defaultMarker(runId);
  try {
    const stored = readJson(markerPath(cfg, runId), null);
    if (!isPlainObject(stored)) return base;
    return merge(base, stored);
  } catch {
    return base;
  }
}

/**
 * §4.8: a merge patch, written atomically. Hooks each own one slice of the
 * marker, so a write must never clobber a sibling's slice.
 * `updated_at` is owned by this function and restamped on every write.
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {Record<string, any>} patch
 * @returns {void}
 */
export function updateMarker(cfg, runId, patch = {}) {
  try {
    if (!runId) return;
    const p = markerPath(cfg, runId);
    const stored = readJson(p, null);
    const base = isPlainObject(stored) ? merge(defaultMarker(runId), stored) : defaultMarker(runId);
    const next = merge(base, patch);
    next.run_id = next.run_id || runId;
    next.updated_at = Date.now();
    writeJsonAtomic(p, next);
  } catch {
    // §4.9: the status line is cosmetic; never fail a hook over it.
  }
}
