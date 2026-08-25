// @ts-check
/**
 * `lib/rules.mjs` — the per-run rule store at `runs/<run_id>/rules.json`.
 *
 * ---------------------------------------------------------------------------
 * Why a file exists at all
 * ---------------------------------------------------------------------------
 * `hooks/src/pre-tool.mjs` runs on `PreToolUse`, in front of a tool call the user is waiting
 * on, and **it may not dial**. Even a fast round trip is latency paid on every matching
 * command, for a warning — and the hook has a 3 s host timeout inside which a slow Mubit
 * would spend the whole budget and inject nothing.
 *
 * So the rules have to already be on disk when it runs. Two hooks are *already* paying for a
 * network call that returns typed entries, and both of them see rules go past:
 *
 *   - `session-start` asks `POST /v2/control/lessons` for the global set (§5.1 step 6). Some
 *     of those are `lesson_type: "rule"`.
 *   - `prompt-recall` asks `POST /v2/control/query` on every prompt and gets `evidence[]`
 *     back, with `entry_type: "rule"` among the five types it requests (§5.2 rung 1).
 *
 * Both write here in passing. Nothing in this module ever opens a socket, and nothing that
 * calls it does so for its sake — it is a side effect of a call that was already made.
 *
 * ---------------------------------------------------------------------------
 * Three rules, the same three `lib/spool.mjs` and `lib/state.mjs` hold
 * ---------------------------------------------------------------------------
 *   1. Zero dependencies, Node >= 20 built-ins only, and no import outside `lib/`.
 *   2. Everything is synchronous. Every caller is a process about to exit.
 *   3. **Nothing here throws.** This one carries more weight than usual: the reader is a hook
 *      whose non-zero exit the host reads as a verdict on the tool call, and exit code 2
 *      blocks it outright. A memory layer that can throw in front of `rm` is worse than no
 *      memory layer.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately NOT stored
 * ---------------------------------------------------------------------------
 * Only `rule`. Mubit's model defines `rule` as a hard constraint that always applies, which
 * is the only entry type whose relevance does not depend on the question being asked. A
 * `lesson` is a suggestion drawn from one past episode; surfacing one in front of a tool call
 * is an interruption on a guess, and after a few of those the model — and the user — stop
 * reading the channel.
 *
 * Stale entries are dropped too. The server marks an entry `is_stale` for transparency and
 * `lib/assemble.mjs` already acts on the mark by ranking those entries last. Here there is no
 * "last": a rule either appears in front of a live command or it does not, and a superseded
 * constraint stated at that moment is confidently wrong exactly where it is hardest to check.
 */

import { join } from 'node:path';

import { ensureDir, readJson, runDir, writeJsonAtomic } from './state.mjs';

/** §7: `runs/<run_id>/rules.json`. */
export const RULES_FILE = 'rules.json';

/** Bumped only if the on-disk shape changes; an unknown version reads as no rules. */
const VERSION = 1;

/**
 * How many rules one run may keep.
 *
 * This is a latency budget as much as a token one: the file is read synchronously in front of
 * a tool call and every stored rule is tokenised against the command. Thirty-two is well past
 * what a healthy run accumulates — `prompt-recall` asks for eight entries of *all* types per
 * prompt — and far short of anything a `readFileSync` would notice.
 */
const MAX_RULES = 32;

/** One pathological entry must not be able to fill the model's context mid-tool-call. */
const MAX_TEXT = 400;

/** A `reference_id` is a key in a map here, so it is treated as untrusted input. */
const MAX_REF = 128;

// ---------------------------------------------------------------------------
// recordRules
// ---------------------------------------------------------------------------

/**
 * Merge the `rule` entries out of `entries` into `runs/<run_id>/rules.json`.
 *
 * **Merge, never replace.** Two writers share this file — `session-start` once, then
 * `prompt-recall` on every prompt for the rest of the session — and a whole-object write from
 * either would drop the other's rules. There is no lock: the last writer wins on a collision,
 * which costs at most one prompt's worth of rules and is repaired by the next recall. A lock
 * on the blocking path would cost more than the failure it prevents.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {any[]} entries  `evidence[]` from the query ladder, or `lessons[]` from §5.1
 * @returns {number} how many rules the store holds afterwards, or 0 on any failure
 */
export function recordRules(cfg, runId, entries) {
  try {
    if (!runId) return 0;

    /** @type {{ref: string, text: string}[]} */
    const incoming = [];
    for (const e of Array.isArray(entries) ? entries : []) {
      const rule = normalise(e);
      if (rule) incoming.push(rule);
    }
    if (incoming.length === 0) return readRules(cfg, runId).length;

    // Newest first, so the cap below drops the rules that have gone longest without being
    // recalled rather than the ones this prompt just proved relevant.
    const merged = dedupe([...incoming, ...readRules(cfg, runId)]).slice(0, MAX_RULES);

    const dir = runDir(cfg, runId);
    // §12.1: a read-only ${CLAUDE_PLUGIN_DATA} costs the warnings, nothing else.
    if (!ensureDir(dir)) return 0;
    const ok = writeJsonAtomic(join(dir, RULES_FILE), {
      version: VERSION,
      updated_at: Date.now(),
      rules: merged,
    });
    return ok ? merged.length : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// readRules
// ---------------------------------------------------------------------------

/**
 * The stored rules, newest first. `[]` for every kind of absence and every kind of damage:
 * no file, an unreadable one, a torn write, a shape a future version wrote, a `rules` key
 * that is not an array, an element that is not an object, an entry with no text left after
 * clamping. The caller is a hook in front of a tool call and has no branch for "the store is
 * broken" that differs from "there are no rules".
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {{ref: string, text: string}[]}
 */
export function readRules(cfg, runId) {
  try {
    if (!runId) return [];
    const stored = readJson(join(runDir(cfg, runId), RULES_FILE), null);
    if (!isObject(stored)) return [];
    if (!Array.isArray(stored.rules)) return [];

    /** @type {{ref: string, text: string}[]} */
    const out = [];
    for (const r of stored.rules) {
      if (!isObject(r)) continue;
      const text = clamp(r.text);
      if (!text) continue;
      out.push({ ref: segment(r.ref), text });
      if (out.length >= MAX_RULES) break;
    }
    return dedupe(out);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * One wire entry → a stored rule, or `null` when it is not one.
 *
 * Two shapes arrive here and they spell the same three fields differently, because they come
 * from two different responses:
 *
 * | field | `evidence[]` (query) | `lessons[]` (lessons) |
 * | --- | --- | --- |
 * | id   | `reference_id`       | `lesson_id`           |
 * | type | `origin_entry_type` ?? `entry_type` | `lesson_type` |
 * | text | `content`            | `content`             |
 *
 * `origin_entry_type` first is `lib/assemble.mjs`'s rule, verbatim from §4.10: "maps
 * entry_type (or origin_entry_type when the entry came through an overlay)". The overlay's
 * own type is bookkeeping; the origin is the type the rule actually has. Reading only
 * `entry_type` would leave this store empty on every instance that uses overlays.
 *
 * @param {any} e
 * @returns {{ref: string, text: string}|null}
 */
function normalise(e) {
  if (!isObject(e)) return null;
  if (e.is_stale === true) return null;

  const type = str(e.origin_entry_type) || str(e.entry_type) || str(e.lesson_type);
  if (type.toLowerCase() !== 'rule') return null;

  const text = clamp(e.content);
  if (!text) return null;

  return { ref: segment(e.reference_id ?? e.lesson_id ?? e.id), text };
}

/**
 * Collapse duplicates, first occurrence winning.
 *
 * Keyed on the `reference_id` where there is one, and on the text otherwise — a rule recalled
 * on twenty consecutive prompts is one rule, and a store with twenty copies of it would spend
 * its whole cap on a single constraint. The text fallback matters because the two producers
 * key on different ids: the same rule can arrive as `les_g1` from the lessons call and as
 * `ref_…` from the query ladder, and without it the store would carry both.
 *
 * @param {{ref: string, text: string}[]} rules
 * @returns {{ref: string, text: string}[]}
 */
function dedupe(rules) {
  /** @type {Map<string, {ref: string, text: string}>} */
  const byId = new Map();
  /** @type {Set<string>} */
  const seenText = new Set();
  /** @type {{ref: string, text: string}[]} */
  const out = [];

  for (const r of rules) {
    const key = r.text.trim().toLowerCase();
    if (r.ref && byId.has(r.ref)) continue;
    if (seenText.has(key)) continue;
    if (r.ref) byId.set(r.ref, r);
    seenText.add(key);
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** One line, trimmed, capped. Newlines collapse because the block renders one rule per line. */
function clamp(v) {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!s) return '';
  return s.length <= MAX_TEXT ? s : `${s.slice(0, MAX_TEXT - 1).trimEnd()}…`;
}

/** An id that will be rendered into the block, so it is length-capped and stripped of noise. */
function segment(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return '';
  return s.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, MAX_REF);
}

/** @param {any} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** @param {any} v */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
