// @ts-check
/**
 * `lib/assemble.mjs` — client-side section assembly (§4.10).
 *
 * Rungs 1 and 2 of the read ladder (§1.8) answer with `evidence[]`, not a preassembled
 * `context_block`. This module does what rung 3 (`POST /v2/control/context`) would have done
 * server-side — for **zero LLM calls instead of two**. That substitution is only honest if
 * the client renders the *same* shape, in the *same* order, with the *same* `emptyReason`
 * vocabulary the server would have used, so everything downstream — the status line, the
 * doctor skill, `additionalContext` itself — is rung-agnostic. Every rule below exists to
 * protect that property:
 *
 *   - **Emission order is the server's**, fixed at `control.proto`:
 *     mental_models → active_rules → lessons → facts → observations → working_memory →
 *     traces → goals. The client never reorders, so switching rungs cannot look like a
 *     change in what was recalled.
 *   - **Section vocabulary is the server's** (§1.3). Nothing here may invent a key; an
 *     `entry_type` with no row in the §4.10 table renders under `other`.
 *   - **`emptyReason` is the server's**: `""` when something rendered, `"no_evidence"` when
 *     there was nothing to say, `"budget_exhausted"` when there was and none of it fit.
 *     `"recency_fallback"` is server-only and is never produced here.
 *
 * Two correctness notes that are easy to skip and expensive to skip:
 *
 *   - **Prefer non-`is_stale` entries when trimming.** The server returns stale entries for
 *     transparency and marks them (`control.proto`); that mark is only worth
 *     anything if the client acts on it.
 *   - **`sourceRefIds` carries `reference_id`, never `id`.** That array is what `Stop`
 *     attributes against (§5.5) and what becomes `RecordOutcome.entry_ids`
 *     (`control.proto`). An item that renders but is not recorded there is a memory
 *     that silently never gets reinforced, and nothing anywhere reports it.
 *
 * Discipline shared with the rest of `lib/`: zero dependencies, Node >= 20 built-ins only,
 * synchronous, and total — this runs inside a 1500 ms blocking budget in front of every
 * prompt, so it may never throw and may never be slow. `estimateTokens` is four characters
 * per token for exactly that reason: a real tokenizer would cost more than the recall.
 */

/** §1.3 (`control.proto`) — the only section keys that may ever be emitted. */
export const SECTION_KEYS = Object.freeze([
  'mental_models', 'active_rules', 'lessons', 'archive_blocks', 'handoffs', 'feedback',
  'facts', 'observations', 'working_memory', 'traces', 'goals', 'checkpoints', 'logs',
  'other',
]);

/** §1.3/§4.10 (`control.proto`) — the server's fixed emission order. */
export const EMISSION_ORDER = Object.freeze([
  'mental_models', 'active_rules', 'lessons', 'facts', 'observations',
  'working_memory', 'traces', 'goals',
]);

/**
 * The full render order: the server's eight, then every remaining documented key.
 * A section the server never orders still has to render *somewhere* deterministic, or two
 * runs with the same evidence produce two different blocks.
 */
const RENDER_ORDER = Object.freeze([
  ...EMISSION_ORDER,
  ...SECTION_KEYS.filter((k) => !EMISSION_ORDER.includes(k)),
]);

/**
 * §4.10's `entry_type → section` table, verbatim.
 *
 * The last row of that table is literally "anything else → `other`", which is why
 * `handoff`, `feedback`, `reflection`, `log` and `workflow` land in `other` even though §1.3
 * defines `handoffs`, `feedback` and `logs` section keys. That gap is a recorded decision,
 * not an oversight: `assemble.test.mjs` encodes this table as the spec, so a change belongs
 * there first.
 */
const SECTION_BY_ENTRY_TYPE = Object.freeze({
  mental_model: 'mental_models',
  rule: 'active_rules',
  lesson: 'lessons',
  fact: 'facts',
  observation: 'observations',
  working_memory: 'working_memory',
  goal: 'working_memory',
  trace: 'traces',
  tool_output: 'traces',
  tool_input: 'traces',
  task_result: 'traces',
  step_outcome: 'traces',
  archive_block: 'archive_blocks',
  checkpoint: 'checkpoints',
});

/** Human headings, chosen so `"## Working memory"` normalises back to `working_memory`. */
const HEADINGS = Object.freeze({
  mental_models: 'Mental models',
  active_rules: 'Active rules',
  lessons: 'Lessons',
  archive_blocks: 'Archive blocks',
  handoffs: 'Handoffs',
  feedback: 'Feedback',
  facts: 'Facts',
  observations: 'Observations',
  working_memory: 'Working memory',
  traces: 'Traces',
  goals: 'Goals',
  checkpoints: 'Checkpoints',
  logs: 'Logs',
  other: 'Other',
});

/** §6.1 `MUBIT_CC_RECALL_TOKENS`. Used when a caller names no budget. */
const DEFAULT_TOKEN_BUDGET = 1500;

/** §4.10: "~4 chars per token. Deliberately cheap." */
const CHARS_PER_TOKEN = 4;

/** A single rendered line is capped so one pathological entry cannot eat a whole budget. */
const MAX_ITEM_CHARS = 2000;

/**
 * The mark on a degraded repeat (§5.2, `lib/seen.mjs`).
 *
 * A `reference_id` already injected earlier in this run renders as a pointer — the id plus
 * the entry's first clause — instead of its whole content. It is a **degrade, not a drop**:
 * the id still reaches `sourceRefIds`, so `Stop` can attribute against it. Dropping a repeat
 * would silently stop reinforcing exactly the memories relevant enough to keep surfacing,
 * which is the opposite of what `record_outcome` is for.
 *
 * The mark is a stable prefix on purpose. `isPointerLine` is the seam
 * `hooks/src/prompt-recall.mjs` uses to keep a pointer's words out of the Stop-side
 * used-signal: a reference id is a handle, not vocabulary, and matching a reply against one
 * guarantees a miss — which would file an *ignored* verdict against a memory that is working.
 */
export const POINTER_MARK = '(seen earlier)';

/** How much of an entry's first clause a pointer carries. 64 chars is ~16 tokens. */
const MAX_POINTER_CHARS = 64;

/**
 * Below this a "clause" is not a clause. Plenty of stored memory opens with a short lead-in
 * — `Rule. Never force-push to main.` or `never_force_push: …` — and a pointer that renders
 * as `Rule…` names nothing the model can act on or recognise.
 */
const MIN_POINTER_CHARS = 24;

// ---------------------------------------------------------------------------
// sectionFor
// ---------------------------------------------------------------------------

/**
 * `entry_type` → section key. Unknown, blank and malformed inputs answer `other` rather than
 * throwing: this runs on the blocking path, and a type the server adds next quarter must
 * cost a heading, never a prompt.
 *
 * @param {string} entryType
 * @returns {string} always one of `SECTION_KEYS`
 */
export function sectionFor(entryType) {
  const t = typeof entryType === 'string' ? entryType.trim().toLowerCase() : '';
  if (!t) return 'other';
  return SECTION_BY_ENTRY_TYPE[t] ?? 'other';
}

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

/**
 * §4.10: four characters per token, no tokenizer. Monotonic in length, exact at 0, and
 * cheap enough to call once per candidate line inside a 1500 ms budget.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// assembleContext
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SectionSummary
 * @property {string} section
 * @property {number} count
 */

/**
 * @typedef {object} Assembled
 * @property {string} block           the rendered markdown, `''` when nothing fit
 * @property {number} tokenEstimate   `estimateTokens(block)`; never above the budget
 * @property {SectionSummary[]} sections  rendered sections, in emission order
 * @property {string[]} sourceRefIds  `reference_id` of every rendered item, in render order
 * @property {number} dropped         candidates that did not render
 * @property {number} pointers        rendered items degraded to a one-line pointer
 * @property {string} emptyReason     `''` | `'no_evidence'` | `'budget_exhausted'`
 */

/**
 * Group `evidence` into the documented sections and render a context block under a token
 * budget.
 *
 * Sections fill in the fixed order; items inside a section sort fresh-before-stale, then by
 * descending `score`. **Section order outranks score** — a 0.10 rule renders before a 0.99
 * trace, because that is what the server does and the point of this module is that the two
 * agree.
 *
 * An item that does not fit is skipped and counted, not treated as a stop signal: a later,
 * shorter item from a later section may still fit, and reporting `dropped` is what lets the
 * status line say "budget-truncated" instead of "empty".
 *
 * `seen` is the set of `reference_id`s this run has already injected (`lib/seen.mjs`). An
 * entry in it is degraded to a pointer rather than dropped — see `POINTER_MARK`. Passing no
 * `seen`, or `repeatMode: 'full'`, reproduces the pre-seen-set block byte for byte.
 *
 * @param {any[]} evidence  `QueryEvidence[]` from rung 1 or 2
 * @param {{tokenBudget?: number, sections?: string[], perSection?: number,
 *          seen?: Set<string>|string[], repeatMode?: string}} [opts]
 * @returns {Assembled}
 */
export function assembleContext(evidence, opts = {}) {
  const o = isObject(opts) ? opts : {};
  const budget = positiveInt(o.tokenBudget, DEFAULT_TOKEN_BUDGET);
  const perSection = positiveInt(o.perSection, 0);
  const allowed = Array.isArray(o.sections) && o.sections.length
    ? new Set(o.sections.filter((s) => typeof s === 'string').map((s) => s.trim()))
    : null;
  // §6.1 `recallRepeatMode`. `full` is every release before the seen-set: an operator who
  // opted out gets the old block back, and a caller who passes no set never degrades at all.
  const seen = str(o.repeatMode) === 'full' ? null : seenSetOf(o.seen);

  const list = Array.isArray(evidence) ? evidence : [];

  /** @type {Map<string, {ref: string, text: string, score: number, stale: boolean, at: number}[]>} */
  const bySection = new Map();
  let candidates = 0;

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!isObject(e)) continue;

    const text = oneLine(e.content);
    if (!text) continue;                    // nothing to render is not a dropped candidate

    // §4.10: "maps entry_type (or origin_entry_type when the entry came through an
    // overlay)". The overlay's own type is bookkeeping; the origin is what the user reads.
    const section = sectionFor(str(e.origin_entry_type) || str(e.entry_type));
    if (allowed && !allowed.has(section)) continue;

    candidates++;
    const bucket = bySection.get(section) ?? [];
    bucket.push({
      ref: str(e.reference_id),
      text,
      score: finite(e.score, 0),
      stale: e.is_stale === true,
      at: i,
    });
    bySection.set(section, bucket);
  }

  if (candidates === 0) {
    return {
      block: '', tokenEstimate: 0, sections: [], sourceRefIds: [],
      dropped: 0, pointers: 0, emptyReason: 'no_evidence',
    };
  }

  /** @type {string[]} */
  const parts = [];
  /** @type {string[]} */
  const sourceRefIds = [];
  const seenRefs = new Set();
  /** @type {SectionSummary[]} */
  const sections = [];

  let used = 0;
  let rendered = 0;
  let pointers = 0;

  for (const key of RENDER_ORDER) {
    const bucket = bySection.get(key);
    if (!bucket || bucket.length === 0) continue;

    // Fresh before stale at equal score, then descending score, then input order — so the
    // same evidence always assembles into the same block.
    bucket.sort((a, b) => (Number(a.stale) - Number(b.stale)) || (b.score - a.score) || (a.at - b.at));

    const heading = `${parts.length ? '\n' : ''}## ${HEADINGS[key] ?? key}\n`;
    const headingCost = estimateTokens(heading);
    let open = false;
    let count = 0;

    for (const item of bucket) {
      if (perSection > 0 && count >= perSection) { continue; }

      // §4.10: the server marks an entry stale; a mark the client renders nowhere is a mark
      // that does nothing. It rides on the line it qualifies, where the model reads it —
      // including on a pointer, where the model still has to know not to trust the entry.
      const full = `- ${item.stale ? '(stale) ' : ''}${item.text}\n`;
      const pointer = seen && item.ref && seen.has(item.ref)
        ? `- ${POINTER_MARK} ${item.stale ? '(stale) ' : ''}${item.ref} — ${firstClause(item.text)}\n`
        : '';
      // A pointer longer than the entry it points at is a pessimisation in the costume of an
      // optimisation, and one-line lessons are both common and already cheap.
      const degraded = !!pointer && pointer.length < full.length;
      const line = degraded ? pointer : full;

      const cost = estimateTokens(line) + (open ? 0 : headingCost);
      if (used + cost > budget) continue;   // skipped, counted below; a later item may fit

      if (!open) { parts.push(heading); open = true; }
      parts.push(line);
      used += cost;
      count++;
      rendered++;
      if (degraded) pointers++;
      // §4.10/§5.5: reference_id, never id. Deduped, because the same entry surfacing
      // through two retrieval lanes must not be reinforced twice for one turn.
      if (item.ref && !seenRefs.has(item.ref)) {
        seenRefs.add(item.ref);
        sourceRefIds.push(item.ref);
      }
    }

    if (count > 0) sections.push({ section: key, count });
  }

  const block = rendered > 0 ? parts.join('') : '';
  return {
    block,
    // The running total is a sum of per-piece `ceil()`s, so it can only over-estimate the
    // whole; reporting the block's own estimate keeps `tokenEstimate <= tokenBudget` true.
    tokenEstimate: estimateTokens(block),
    sections,
    sourceRefIds,
    dropped: Math.max(0, candidates - rendered),
    // A degraded entry is rendered, not dropped: it counts here and nowhere else, so a
    // reader can tell a block that shrank from a block that lost half its evidence.
    pointers,
    emptyReason: rendered > 0 ? '' : 'budget_exhausted',
  };
}

// ---------------------------------------------------------------------------
// Pointers
// ---------------------------------------------------------------------------

/**
 * Is this rendered line a pointer at an entry injected on an earlier turn?
 *
 * The one place the pointer format is decoded, so a caller never has to re-spell it.
 * `hooks/src/prompt-recall.mjs` uses it to exclude these lines from the vocabulary it
 * stages for the Stop-side used-signal — see `POINTER_MARK`.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isPointerLine(line) {
  return typeof line === 'string' && line.startsWith(`- ${POINTER_MARK} `);
}

/**
 * Enough of an entry for the model to recognise which memory is being pointed at: its first
 * clause, or the first `MAX_POINTER_CHARS` characters, whichever comes first.
 *
 * Clause rather than sentence because a memory's first sentence is routinely the whole
 * memory, and the point of the pointer is that it is not.
 *
 * `:` is deliberately NOT a boundary, even though it reads like one. Stored memories very
 * often lead with a label — `Rule: never force-push to main` — and cutting there yields a
 * pointer that identifies nothing. `MIN_POINTER_CHARS` covers the same shape spelled with a
 * full stop.
 *
 * @param {string} text  already collapsed to one line by `oneLine`
 * @returns {string}
 */
function firstClause(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return '';
  const stop = s.search(/[.;!?]/);
  let end = stop > 0 ? Math.min(stop, MAX_POINTER_CHARS) : MAX_POINTER_CHARS;
  if (end < MIN_POINTER_CHARS) end = Math.min(s.length, MAX_POINTER_CHARS);
  const clause = s.slice(0, end).trim() || s.slice(0, MAX_POINTER_CHARS).trim();
  return clause.length < s.length ? `${clause}…` : clause;
}

/**
 * The seen set, however the caller spells it.
 *
 * `readSeen(...).ids` is a `Set`; an array is accepted because a caller who passes one and
 * silently gets full-price rendering has a bug nothing surfaces until someone counts
 * tokens. Anything else — a string, a plain object, `null` — degrades nothing, which is the
 * behaviour of every release before the seen-set existed.
 *
 * @param {any} v
 * @returns {Set<string>|null}
 */
function seenSetOf(v) {
  if (v instanceof Set) return v.size ? v : null;
  if (Array.isArray(v)) {
    const set = new Set(v.filter((s) => typeof s === 'string' && s.trim()));
    return set.size ? set : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/**
 * Markdown bullets are line-oriented: a multi-line `content` would otherwise break the list
 * and — worse — a line of it beginning with `##` would forge a section heading.
 * @param {any} v
 * @returns {string}
 */
function oneLine(v) {
  const s = typeof v === 'string' ? v : '';
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_ITEM_CHARS ? `${flat.slice(0, MAX_ITEM_CHARS)}…` : flat;
}

/** @param {any} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** @param {any} v @returns {boolean} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @param {any} v @param {number} d @returns {number} */
function finite(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

/** @param {any} v @param {number} d @returns {number} */
function positiveInt(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return d;
  const t = Math.trunc(n);
  return t > 0 ? t : (t === 0 ? 0 : d);
}
