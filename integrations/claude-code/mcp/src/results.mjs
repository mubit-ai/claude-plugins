// @ts-check
/**
 * `mcp/src/results.mjs` — the shape of a tool result on its way to the model.
 *
 * **What the model was reading.** Every tool the vendored server exposes answers with one
 * text block holding `JSON.stringify(reply, null, 2)` of the whole API response: every field,
 * every nested object, pretty-printed. Measured over fourteen days of real sessions, a lesson
 * list came back at up to ~12k tokens and a recall at up to ~7k — in one turn, and then re-sent
 * with every turn after it until the next compaction. That single result was the largest
 * context cost the plugin had, an order of magnitude over its always-loaded surface, and most
 * of it was paid for fields the model never reads: the rationale behind a lesson, its
 * conditions, a retrieval score to four decimals, two spaces of indentation per level.
 *
 * **What it reads now.** Two shapes are always rendered compactly, one line per item, with the
 * item's id on the line so `mubit_dereference` and `mubit_outcome` still have something to hold:
 *
 *   - a **lesson list** — a result whose `lessons` is an array of `{id|lesson_id, content}`;
 *   - an **evidence list** — a result whose `evidence` is an array of `{reference_id, content}`.
 *
 * Shapes, not tool names. A result frame carries no tool name, and matching on shape means a
 * rebuilt server answering the same way from a new tool is shaped the same way.
 *
 * Every result, whatever its shape, is held under a token ceiling (`mcpResultTokenBudget`,
 * default 2000). A known shape drops items past the ceiling; an unknown JSON shape drops from
 * the end of its longest array; prose is cut at a line. Whenever anything was dropped, and
 * always for the two compact shapes (whose metadata is gone from the line), the untouched
 * original is written under the run's data directory and the note at the foot of the result
 * names the path — so the rest costs nothing until the model chooses to read it.
 *
 * **Repeats.** The hooks keep a run-scoped set of every reference the model has already been
 * shown (`lib/seen.mjs`) and degrade a repeat in the per-prompt injection to a one-line
 * pointer. A tool result reads the same set and writes back to it: a lesson the injection
 * already rendered in full appears here as a pointer, and a lesson first shown in full here is
 * a pointer in the next injection. One transcript, one set.
 *
 * **The seam** is `process.stdout.write`, the one `mcp/src/instructions.mjs` uses and for the
 * same reason: the server bundle cannot be changed here, `StdioServerTransport` writes exactly
 * one frame per call, and this is the last point a result passes through code this repo owns.
 * Unlike the instructions guard this one stays in the path for the life of the process, so the
 * rule it inherits matters more: every branch falls through to the exact bytes the server
 * wrote on any surprise, and a line it cannot parse is passed through untouched.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { estimateTokens, firstClause, POINTER_MARK } from '../../lib/assemble.mjs';
import { markSeen, readSeen } from '../../lib/seen.mjs';
import { runDir, safeSegment } from '../../lib/state.mjs';

/** What one result may cost the conversation, in the estimator's tokens (`lib/assemble.mjs`). */
export const DEFAULT_RESULT_TOKENS = 2000;

/** Below this the ceiling would cut the note that explains the cut. */
export const MIN_RESULT_TOKENS = 200;

/** Where a run keeps the originals: `runs/<run_id>/spill/`. Swept by `pruneStale` after 24 h. */
export const SPILL_DIR = 'spill';

/** Tokens held back for the foot of a shaped result: the count line, the path, the pointer note. */
const NOTE_RESERVE = 90;

/** A scalar field carried over verbatim (a `final_answer`, a `summary`) keeps this much. */
const MAX_FIELD_CHARS = 1200;

/** The known shapes. `key` is the array, `ids` the fields an item's id may sit in. */
const SHAPES = [
  { key: 'lessons', ids: ['id', 'lesson_id'], noun: 'lessons' },
  { key: 'evidence', ids: ['reference_id'], noun: 'memories' },
];

/**
 * @typedef {object} ShapeOutcome
 * @property {any} message        the frame to send — the ORIGINAL reference when nothing moved
 * @property {boolean} changed
 * @property {string} shape       `lessons` | `evidence` | `json` | `text` | `error` | `''`
 * @property {string[]} shown     ids rendered in full
 * @property {string[]} pointed   ids rendered as a pointer
 * @property {number} dropped     items or tokens the ceiling refused
 * @property {string} spilled     where the original went, or `''`
 */

/**
 * @typedef {object} ShapeOptions
 * @property {number} [budget]                          token ceiling; `DEFAULT_RESULT_TOKENS`
 * @property {Set<string>|null} [seen]                  ids already shown this run
 * @property {(text: string, shape: string) => string} [spill]  writes the original, returns its path or `''`
 */

// ---------------------------------------------------------------------------
// The rewrite
// ---------------------------------------------------------------------------

/**
 * Shape one JSON-RPC frame. Pure apart from `opts.spill`, and inert on anything it does not
 * understand: a frame it will not touch comes back **by identity**, so the caller can leave the
 * server's own bytes on the wire.
 *
 * A frame qualifies only when it is a JSON-RPC 2.0 message whose `result.content` is exactly
 * one text block — the shape every tool result from the vendored server has, and one that
 * `initialize` and `tools/list` do not. An error result is only ever held under the ceiling,
 * never re-rendered: the text of a failure is the model's only evidence of it.
 *
 * @param {any} message
 * @param {ShapeOptions} [opts]
 * @returns {ShapeOutcome}
 */
export function shapeToolResult(message, opts = {}) {
  const noop = { message, changed: false, shape: '', shown: [], pointed: [], dropped: 0, spilled: '' };
  try {
    const o = isObject(opts) ? opts : {};
    const budget = Math.max(MIN_RESULT_TOKENS, positiveInt(o.budget, DEFAULT_RESULT_TOKENS));
    const seen = o.seen instanceof Set ? o.seen : null;
    const spill = typeof o.spill === 'function' ? o.spill : () => '';

    const text = toolText(message);
    if (text === null) return noop;

    const out = message.result.isError === true
      ? holdText(text, budget, spill, 'error')
      : render(text, budget, seen, spill);
    if (out === null) return noop;

    const block = message.result.content[0];
    return {
      message: {
        ...message,
        result: { ...message.result, content: [{ ...block, text: out.text }] },
      },
      changed: true,
      shape: out.shape,
      shown: out.shown ?? [],
      pointed: out.pointed ?? [],
      dropped: out.dropped ?? 0,
      spilled: out.spilled ?? '',
    };
  } catch {
    // A frame shaped in a way this function did not anticipate goes out as the server wrote it.
    return noop;
  }
}

/**
 * The single text block of a tool result, or `null` for any other frame.
 * @param {any} message
 * @returns {string|null}
 */
function toolText(message) {
  if (!isObject(message) || message.jsonrpc !== '2.0') return null;
  const result = message.result;
  if (!isObject(result) || !Array.isArray(result.content) || result.content.length !== 1) return null;
  const block = result.content[0];
  if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string') return null;
  return block.text;
}

/**
 * @typedef {object} Rendered
 * @property {string} text
 * @property {string} shape
 * @property {string[]} [shown]
 * @property {string[]} [pointed]
 * @property {number} [dropped]
 * @property {string} [spilled]
 */

/**
 * @param {string} text
 * @param {number} budget
 * @param {Set<string>|null} seen
 * @param {(text: string, shape: string) => string} spill
 * @returns {Rendered|null}
 */
function render(text, budget, seen, spill) {
  const parsed = tryJson(text);
  if (!isObject(parsed)) return holdText(text, budget, spill, 'text');
  const shape = SHAPES.find((s) => isItemList(parsed[s.key]));
  if (shape) return renderList(text, parsed, shape, budget, seen, spill);
  return holdJson(text, parsed, budget, spill);
}

// ---------------------------------------------------------------------------
// The two compact shapes
// ---------------------------------------------------------------------------

/**
 * One line per item, the id on every line, a repeat degraded to a pointer — the same pointer
 * the per-prompt injection renders, so the model meets one convention rather than two. Items
 * come in the order the server ranked them and the ceiling cuts a prefix, never a selection:
 * "showing 8 of 30" then means the first eight, which is what a ranked list promises.
 *
 * @param {string} original
 * @param {Record<string, any>} parsed
 * @param {{key: string, ids: string[], noun: string}} shape
 * @param {number} budget
 * @param {Set<string>|null} seen
 * @param {(text: string, shape: string) => string} spill
 * @returns {Rendered}
 */
function renderList(original, parsed, shape, budget, seen, spill) {
  const compact = renderCompact(parsed, shape.key, { budget, seen });
  if (!compact) return holdJson(original, parsed, budget, spill);
  const { shown, pointed, dropped, total } = compact;
  const spilled = spill(original, shape.key);

  const parts = [compact.text];
  const foot = [];
  if (dropped > 0) foot.push(`Showing ${total - dropped} of ${total}.`);
  if (spilled) foot.push(`Raw result: ${spilled}`);
  if (foot.length) parts.push(foot.join(' '));
  if (pointed.length) {
    parts.push(`A line marked "${POINTER_MARK}" was shown in full earlier in this conversation; `
      + 'mubit_dereference returns its text.');
  }
  return { text: parts.join('\n'), shape: shape.key, shown, pointed, dropped, spilled };
}

/**
 * @typedef {object} Compact
 * @property {string} text        the head lines, the count line and one line per item
 * @property {string[]} shown
 * @property {string[]} pointed
 * @property {number} dropped
 * @property {number} total
 */

/**
 * The compact form of a known shape, without the frame around it: what a tool result and
 * `bin/admin.mjs` both print, so the model meets one rendering of a lesson list whichever
 * way it asked for one.
 *
 * @param {Record<string, any>} parsed
 * @param {string} listKey  `lessons` or `evidence`
 * @param {{budget?: number, seen?: Set<string>|null}} [opts]
 * @returns {Compact|null}  `null` when `listKey` is not a known shape on this object
 */
export function renderCompact(parsed, listKey, opts = {}) {
  const shape = SHAPES.find((s) => s.key === listKey);
  if (!shape || !isObject(parsed) || !isItemList(parsed[shape.key])) return null;
  const budget = Math.max(MIN_RESULT_TOKENS, positiveInt(opts?.budget, DEFAULT_RESULT_TOKENS));
  const seen = opts?.seen instanceof Set ? opts.seen : null;
  /** @type {any[]} */
  const items = parsed[shape.key];
  const head = headLines(parsed, shape.key);

  const shown = [];
  const pointed = [];
  const lines = [];
  let used = estimateTokens(`${head.join('\n')}\n`) + NOTE_RESERVE;
  for (const item of items) {
    const id = firstString(item, shape.ids);
    const content = oneLine(item.content);
    const tag = tagsFor(item, shape.key);
    const full = `- ${tag ? `[${tag}] ` : ''}${id ? `${id} — ` : ''}${content}`;
    const pointer = id && seen && seen.has(id)
      ? `- ${POINTER_MARK} ${id} — ${firstClause(content)}`
      : '';
    // A pointer longer than the entry it points at is a pessimisation in the costume of an
    // optimisation — the same rule `lib/assemble.mjs` applies.
    const degraded = !!pointer && pointer.length < full.length;
    const line = degraded ? pointer : full;
    const cost = estimateTokens(`${line}\n`);
    if (used + cost > budget) break;
    lines.push(line);
    used += cost;
    if (id) (degraded ? pointed : shown).push(id);
  }

  const total = items.length;
  const parts = [...head];
  parts.push(`${cap(shape.noun)} (${total}${pointed.length ? `, ${pointed.length} seen earlier` : ''}):`);
  parts.push(...lines);
  return { text: parts.join('\n'), shown, pointed, dropped: total - lines.length, total };
}

/**
 * Everything beside the item list that is worth a line: a scalar at the top level (a
 * `final_answer`, a `summary`, a `degraded` flag) and the scalars one level down (the
 * catalogue's own note about what it is showing). Other arrays are not rendered — they are
 * indexes into the list, or lists of run ids, and the original carries them.
 *
 * @param {Record<string, any>} parsed
 * @param {string} listKey
 * @returns {string[]}
 */
function headLines(parsed, listKey) {
  const out = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (k === listKey) continue;
    if (isScalar(v)) {
      if (v !== '') out.push(`${k}: ${capField(v)}`);
    } else if (isObject(v)) {
      for (const [k2, v2] of Object.entries(v)) {
        if (isScalar(v2) && v2 !== '') out.push(`${k2}: ${capField(v2)}`);
      }
    }
  }
  return out;
}

/**
 * What qualifies an item on its line. A lesson carries its type, importance and scope — the
 * three things an admin decision about it turns on. A memory carries the type the section
 * heading would have given it, and its staleness, which the model has to know not to trust.
 * @param {Record<string, any>} item
 * @param {string} listKey
 */
function tagsFor(item, listKey) {
  const tags = listKey === 'lessons'
    ? [str(item.lesson_type), str(item.importance), str(item.scope)]
    : [str(item.origin_entry_type) || str(item.entry_type), item.is_stale === true ? 'stale' : ''];
  return tags.filter(Boolean).join(', ');
}

// ---------------------------------------------------------------------------
// Everything else: held under the ceiling, never re-rendered
// ---------------------------------------------------------------------------

/**
 * An unknown JSON object over the ceiling loses items from the end of its longest array of
 * objects — the shape of every list the server returns — and says so in a field of its own.
 * With no such array, or with the object still over the ceiling once the array is empty, the
 * text is cut instead.
 *
 * @param {string} original
 * @param {Record<string, any>} parsed
 * @param {number} budget
 * @param {(text: string, shape: string) => string} spill
 * @returns {Rendered|null}
 */
function holdJson(original, parsed, budget, spill) {
  const tokens = estimateTokens(original);
  if (tokens <= budget) return null;

  let key = '';
  let longest = 0;
  for (const [k, v] of Object.entries(parsed)) {
    if (Array.isArray(v) && v.length > longest && v.every(isObject)) { key = k; longest = v.length; }
  }
  if (key) {
    const list = parsed[key];
    const spilled = spill(original, 'json');
    // Proportional first guess, then step down: a few serialisations, not one per item.
    let keep = Math.min(longest, Math.max(0, Math.floor((longest * (budget - NOTE_RESERVE)) / tokens)));
    for (; keep >= 0; keep -= 1) {
      const copy = {
        ...parsed,
        [key]: list.slice(0, keep),
        _truncated: `Showing ${keep} of ${longest} ${key}.${spilled ? ` Raw result: ${spilled}` : ''}`,
      };
      const text = JSON.stringify(copy, null, 2);
      if (estimateTokens(text) <= budget) {
        return { text, shape: 'json', dropped: longest - keep, spilled };
      }
      if (keep === 0) break;
    }
    return holdText(original, budget, spill, 'json', spilled);
  }
  return holdText(original, budget, spill, 'json');
}

/**
 * Prose, an error, or JSON nothing better could be done with: cut at the last line that fits,
 * with a note naming the original.
 *
 * @param {string} original
 * @param {number} budget
 * @param {(text: string, shape: string) => string} spill
 * @param {string} shape
 * @param {string} [already]  a path the caller has already spilled the original to
 * @returns {Rendered|null}
 */
function holdText(original, budget, spill, shape, already = '') {
  const tokens = estimateTokens(original);
  if (tokens <= budget) return null;
  const spilled = already || spill(original, shape);
  const maxChars = Math.max(1, Math.floor(((budget - NOTE_RESERVE) * original.length) / tokens));
  let cut = original.lastIndexOf('\n', maxChars);
  if (cut < maxChars / 2) cut = original.lastIndexOf(' ', maxChars);
  if (cut < maxChars / 2) cut = maxChars;
  const kept = original.slice(0, cut).replace(/\s+$/, '');
  const note = `… cut at ${estimateTokens(kept)} of ${tokens} tokens.${spilled ? ` Raw result: ${spilled}` : ''}`;
  return { text: `${kept}\n${note}`, shape, dropped: tokens - estimateTokens(kept), spilled };
}

// ---------------------------------------------------------------------------
// The stdout wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap `process.stdout.write` so every tool result the server sends is shaped on its way out.
 * Must be called **before** `await import('./server.js')`, for the reason
 * `installInstructionsGuard` states: the transport captures `process.stdout` when it is built.
 *
 * Idempotent. Re-installing rewraps the original `write` rather than stacking a second layer.
 *
 * @param {{cfg: any, runId: string, budget?: number, stream?: any,
 *          seen?: () => Set<string>, spill?: (text: string, shape: string) => string,
 *          mark?: (ids: string[]) => void}} opts
 *   `stream`, `seen`, `spill` and `mark` override the production wiring for tests.
 * @returns {void}
 */
export function installResultsGuard(opts) {
  const budget = positiveInt(opts?.budget, DEFAULT_RESULT_TOKENS);
  // `0` is the operator's way of asking for the raw result back.
  if (budget <= 0) return;

  const stream = opts?.stream ?? process.stdout;
  const current = stream?.write;
  if (typeof current !== 'function') return;
  const base = typeof current.mubitResultsGuardOriginal === 'function'
    ? current.mubitResultsGuardOriginal
    : current;

  const cfg = opts?.cfg ?? {};
  const runId = typeof opts?.runId === 'string' ? opts.runId : '';
  const seen = typeof opts?.seen === 'function' ? opts.seen : () => readSeen(cfg, runId).ids;
  const spill = typeof opts?.spill === 'function' ? opts.spill : spillWriter(cfg, runId);
  const mark = typeof opts?.mark === 'function' ? opts.mark : (ids) => { markSeen(cfg, runId, ids); };

  /**
   * @param {any} chunk
   * @param {...any} rest  encoding / callback, forwarded untouched
   */
  const wrapped = function write(chunk, ...rest) {
    // Only a tool result carries `content`; the substring check keeps every other frame free.
    if (typeof chunk === 'string' && chunk.includes('"content"')) {
      try {
        const shaped = shapeChunk(chunk, { budget, seen, spill, mark });
        if (shaped !== null) chunk = shaped;
      } catch {
        // Whatever went wrong, the server's bytes go out as written. A guard that can corrupt
        // the protocol channel is worse than any result it could have shaped.
      }
    }
    return base.call(this, chunk, ...rest);
  };

  // The instructions guard is installed first and announces itself with a marker on the
  // handle; wrapping that handle would hide it. Enumerable markers ride along, and only
  // those: each guard's non-enumerable `...Original` stays its own, so a re-install of either
  // rewraps its own layer and never unwraps the other.
  Object.assign(wrapped, current);
  Object.defineProperty(wrapped, 'mubitResultsGuardOriginal', {
    value: base, writable: true, configurable: true, enumerable: false,
  });
  // The launch tests read this off `process.stdout.write` and JSON-serialise it.
  wrapped.mubitResultsGuard = { budget };

  stream.write = wrapped;
}

/**
 * Shape whichever lines of a chunk are tool results. Returns `null` when nothing moved, so the
 * caller forwards the original string. The split is lossless and only a line that changed is
 * re-serialised; every other line keeps the exact bytes the server produced.
 *
 * @param {string} chunk
 * @param {{budget: number, seen: () => Set<string>,
 *          spill: (text: string, shape: string) => string, mark: (ids: string[]) => void}} ctx
 * @returns {string|null}
 */
export function shapeChunk(chunk, ctx) {
  const parts = chunk.split('\n');
  let changed = false;
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].trim() === '') continue;
    /** @type {any} */
    let frame;
    try { frame = JSON.parse(parts[i]); } catch { continue; }
    if (toolText(frame) === null) continue;
    let seen = null;
    try { seen = ctx.seen(); } catch { /* an unreadable set renders everything in full */ }
    const out = shapeToolResult(frame, { budget: ctx.budget, seen, spill: ctx.spill });
    if (!out.changed) continue;
    parts[i] = JSON.stringify(out.message);
    changed = true;
    const ids = [...out.shown, ...out.pointed];
    if (ids.length) {
      try { ctx.mark(ids); } catch { /* a set that could not be written costs one repeat */ }
    }
  }
  return changed ? parts.join('\n') : null;
}

/**
 * The production spill: `runs/<run_id>/spill/<ms>-<shape>-<n>.<ext>`, owner-readable only,
 * because a result can carry anything the memory does.
 * @param {any} cfg
 * @param {string} runId
 * @returns {(text: string, shape: string) => string}
 */
function spillWriter(cfg, runId) {
  let n = 0;
  return (text, shape) => {
    try {
      if (!safeSegment(runId)) return '';
      const dir = join(runDir(cfg, runId), SPILL_DIR);
      mkdirSync(dir, { recursive: true });
      const ext = shape === 'text' || shape === 'error' ? 'txt' : 'json';
      const p = join(dir, `${Date.now()}-${safeSegment(shape) || 'result'}-${n++}.${ext}`);
      writeFileSync(p, text, { encoding: 'utf8', mode: 0o600 });
      return p;
    } catch {
      return '';
    }
  };
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/** @param {any} v */
function isItemList(v) {
  return Array.isArray(v) && v.length > 0
    && v.every((item) => isObject(item) && typeof item.content === 'string');
}

/** @param {any} v */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @param {any} v */
function isScalar(v) {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/** @param {any} v */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** @param {string} s */
function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * @param {Record<string, any>} item
 * @param {string[]} keys
 */
function firstString(item, keys) {
  for (const k of keys) {
    const v = str(item[k]);
    if (v) return v;
  }
  return '';
}

/** @param {any} v */
function oneLine(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

/** @param {any} v */
function capField(v) {
  const s = oneLine(String(v));
  return s.length > MAX_FIELD_CHARS ? `${s.slice(0, MAX_FIELD_CHARS).trim()}…` : s;
}

/** @param {any} v @param {number} d */
function positiveInt(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.trunc(n);
}

/** @param {string} text */
function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
