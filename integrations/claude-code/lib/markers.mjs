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
 * The §4.8 Marker, with every documented sub-key present and correctly typed.
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
    recall: { sources: 0, tokens: 0, ms: 0, empty_reason: '', rung: 0, dropped: 0 },
    captured: { tools: 0, turns: 0, pending: 0 },
    lessons: { global: 0, checked_at: 0 },
    reflect: { at: 0, lessons_stored: 0, status: '' },
    last_error: '',
  };
}

/** The sub-objects that merge key-by-key rather than being replaced wholesale. */
const GROUPS = ['recall', 'captured', 'lessons', 'reflect'];

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
