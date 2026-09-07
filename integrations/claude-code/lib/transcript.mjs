// @ts-check
/**
 * `lib/transcript.mjs` — reading a transcript forwards, from a resumable byte offset.
 *
 * ---------------------------------------------------------------------------
 * Why this is not one of the readers we already have
 * ---------------------------------------------------------------------------
 * Every transcript reader in this tree is a **tail** reader on a hot path.
 * `hooks/src/checkpoint.mjs` takes the last 200 KB of one file because everything before it
 * is about to be compacted away; `lib/codex-rollout.mjs` takes the last 512 KB because the
 * record it wants is the most recent one, and its head reader takes the first 256 KB because
 * the task is the first thing in the file. All three are bounded so that a hook's cost is not
 * a function of session length.
 *
 * Both of them handle a truncated line the same way, and it is the wrong half of the problem
 * here: a bounded read starts or ends mid-line, so they **drop the partial first line** (or
 * refuse to parse the last). An importer reads a file from one end to the other and must not
 * lose a line at all — but it also must be able to stop and come back, so what it needs is
 * the *offset* of the last complete line rather than a window.
 *
 * That is the whole of this module's difference: it yields `{text, offset}` where `offset` is
 * a byte position that is always a line boundary, so a caller can store it and resume there
 * later with nothing skipped and nothing seen twice. A trailing fragment with no newline is
 * not yielded and not counted — it is a line the host is still writing.
 *
 * ---------------------------------------------------------------------------
 * One inverted rule, and it is the point of the exercise
 * ---------------------------------------------------------------------------
 * `checkpoint.mjs`'s `messageText` ends `if (type) return '';` — it discards every
 * `tool_use` and `tool_result` block, and its comment says why: *"their content is already
 * captured item-by-item by `capture.mjs` through the ordinary ingest path"*. That is true of
 * a live session and false of a historical one. On a transcript from before the plugin was
 * installed nothing was ever captured, so those blocks are not a duplicate of the record —
 * they **are** the record, and dropping them would import a month of work as a sequence of
 * prose messages with every command, edit and result removed.
 *
 * So the rule is an option (`includeTools`), off by default so the two existing callers keep
 * the behaviour their comments argue for, and on for the importer.
 *
 * ---------------------------------------------------------------------------
 * Both hosts, one reader
 * ---------------------------------------------------------------------------
 * Claude Code nests the record under `message`; Codex nests it under `payload`, but only some
 * `payload`s are conversation. The envelope sniff is `checkpoint.mjs`'s, moved here rather
 * than copied, because it was already carried in three places — `renderEntry`,
 * `messageRecord`/`messageText`, and `codex-rollout.mjs`'s `blockText`, whose own comment
 * says it "mirrors the checkpoint reader's rules". A rule that is mirrored is a rule that
 * drifts.
 *
 * ---------------------------------------------------------------------------
 * Bounds
 * ---------------------------------------------------------------------------
 * A transcript line is model-authored and unbounded: a committed bundle's inline sourcemap is
 * ~700 KB on one line, and an offloaded tool result's preview can be larger. Lines are read
 * through a fixed-size window and one longer than `MAX_LINE_BYTES` is skipped rather than
 * buffered — reported as `oversize`, never silently. The reader's memory is therefore a
 * function of `MAX_LINE_BYTES`, not of the file.
 *
 * Constraints shared with the rest of `lib/`: zero dependencies, Node >= 20 built-ins, no
 * import outside `lib/`, everything synchronous, and nothing here throws.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** How much is read per `readSync`. Big enough that a 1 MB file is a handful of syscalls. */
export const CHUNK_BYTES = 256 * 1024;

/**
 * The longest line this reader will materialise.
 *
 * Two real shapes sit above any sane conversational line: a bundle's inline sourcemap
 * (~700 KB, one line) and the preview of an offloaded tool result. Two megabytes clears every
 * transcript line worth reading and bounds the reader's memory whatever the file contains.
 */
export const MAX_LINE_BYTES = 2 * 1024 * 1024;

/** `input_text` / `output_text` are Codex's spellings of `text`. */
const TEXT_BLOCKS = new Set(['text', 'input_text', 'output_text']);

/** How deep a `content` tree is followed before it is assumed to be adversarial. */
const MAX_CONTENT_DEPTH = 3;

const NEWLINE = 0x0a;

// ---------------------------------------------------------------------------
// readForward — the resumable line reader
// ---------------------------------------------------------------------------

/**
 * @typedef {object} TranscriptLine
 * @property {string} text     the line, without its newline; `''` when `oversize`
 * @property {number} offset   byte offset just past this line's newline — a resume point
 * @property {number} bytes    the line's length in bytes, newline excluded
 * @property {boolean} oversize the line was over `MAX_LINE_BYTES` and was not materialised
 */

/**
 * Every complete line of `path` from `opts.from` onwards, in order.
 *
 * `offset` is the contract: it is always just past a newline, so storing the last one and
 * passing it back as `from` resumes exactly where this left off. A file that has grown since
 * continues; a file that has been truncated below the stored offset yields nothing, which is
 * the caller's signal to start over.
 *
 * Never throws. An unreadable path yields nothing, which is the same answer as an empty file
 * — an importer has no branch for "the file is broken" that differs from "there is nothing
 * left to read".
 *
 * @param {string} path
 * @param {{from?: number, chunkBytes?: number, maxLineBytes?: number}} [opts]
 * @returns {Generator<TranscriptLine, void, void>}
 */
export function* readForward(path, opts = {}) {
  const p = typeof path === 'string' ? path.trim() : '';
  if (!p) return;

  const chunkBytes = posInt(opts?.chunkBytes, CHUNK_BYTES);
  const maxLineBytes = posInt(opts?.maxLineBytes, MAX_LINE_BYTES);

  let fd = -1;
  try {
    fd = openSync(p, 'r');
    const size = fstatSync(fd).size;
    let pos = Math.max(0, Math.trunc(numOr(opts?.from, 0)));
    if (pos >= size) return;

    const buf = Buffer.allocUnsafe(chunkBytes);
    /** Bytes held back because the line they belong to is not finished yet. */
    let pending = Buffer.alloc(0);
    /** The byte offset `pending` starts at. */
    let pendingAt = pos;
    /** Set once a line has outgrown the cap: everything up to the next newline is discarded. */
    let skipping = false;
    let skippedBytes = 0;

    while (pos < size) {
      const want = Math.min(chunkBytes, size - pos);
      const read = readSync(fd, buf, 0, want, pos);
      if (read <= 0) break;
      const chunk = buf.subarray(0, read);
      pos += read;

      if (skipping) {
        const nl = chunk.indexOf(NEWLINE);
        if (nl === -1) { skippedBytes += read; continue; }
        skippedBytes += nl;
        yield { text: '', offset: pos - read + nl + 1, bytes: skippedBytes, oversize: true };
        skipping = false;
        skippedBytes = 0;
        pending = Buffer.from(chunk.subarray(nl + 1));
        pendingAt = pos - read + nl + 1;
      } else {
        pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      }

      let start = 0;
      let nl;
      while (!skipping && (nl = pending.indexOf(NEWLINE, start)) !== -1) {
        const bytes = nl - start;
        yield {
          text: pending.toString('utf8', start, nl),
          offset: pendingAt + nl + 1,
          bytes,
          oversize: false,
        };
        start = nl + 1;
      }
      if (skipping) continue;

      pendingAt += start;
      pending = pending.subarray(start);

      // A line longer than the cap. Held bytes are released and the rest of the line is read
      // past without ever being materialised, so one adversarial line costs a scan and not a
      // heap. It is reported rather than dropped silently — a caller that imports nothing
      // from a file should be able to say which line it could not read.
      if (pending.length > maxLineBytes) {
        skipping = true;
        skippedBytes = pending.length;
        pending = Buffer.alloc(0);
      }
    }
    // A trailing fragment with no newline is a line the host is still writing. Not yielded,
    // and — the half that matters — not counted in any offset, so the next read starts at its
    // first byte rather than after it.
  } catch {
    // See the header: unreadable and empty are the same answer.
  } finally {
    if (fd !== -1) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * The size of `path` in bytes, or 0 for anything unreadable. Callers store it beside a cursor
 * so a truncated or replaced file can be told from one that has simply grown.
 * @param {string} path
 * @returns {{size: number, mtimeMs: number}}
 */
export function statOf(path) {
  let fd = -1;
  try {
    fd = openSync(typeof path === 'string' ? path : '', 'r');
    const st = fstatSync(fd);
    return { size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
  } catch {
    return { size: 0, mtimeMs: 0 };
  } finally {
    if (fd !== -1) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

// ---------------------------------------------------------------------------
// The record inside a line — one set of rules, three callers
// ---------------------------------------------------------------------------

/**
 * One transcript line as an object, or `null`.
 *
 * A line that will not parse is not an error: a bounded read starts mid-line, a rollout
 * carries shapes this plugin does not know, and a host writes a partial line while it is
 * flushing. All three answer `null` and the caller moves on.
 *
 * @param {string} line
 * @returns {Record<string, any>|null}
 */
export function parseLine(line) {
  const s = typeof line === 'string' ? line.trim() : '';
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The record inside a transcript line's envelope.
 *
 * Claude Code nests it under `message`. Codex nests it under `payload`, but only some
 * `payload`s are conversation — a rollout is mostly `session_meta`, `turn_context`,
 * `world_state`, `token_count` and `reasoning`, and one of those carries a base64 blob large
 * enough to fill a whole read window on its own. So the Codex branch is taken on a
 * **positive** signal: a `payload` that is an object carrying a `role` or a `content`.
 * Everything else falls through to the envelope itself, which keeps a hand-rolled transcript
 * readable.
 *
 * @param {Record<string, any>} entry
 * @returns {Record<string, any>}
 */
export function messageRecord(entry) {
  if (!isObject(entry)) return {};
  if (isObject(entry.message)) return entry.message;
  const payload = entry.payload;
  if (isObject(payload) && (typeof payload.role === 'string' || payload.content !== undefined)) {
    return payload;
  }
  return entry;
}

/**
 * The human-readable text of a `message.content`, which arrives as a string, a block array,
 * or a single block depending on the record.
 *
 * **`includeTools` is the inverted rule.** Off — the default, and what `checkpoint.mjs` and
 * `codex-rollout.mjs` want — tool blocks are skipped, because on a live session their content
 * is already stored item-by-item by `capture.mjs` and repeating it here would spend a bounded
 * window on the one part of the session that is not being thrown away. On — what an importer
 * wants — they are rendered, because on a historical transcript nothing was ever captured and
 * those blocks are the record rather than a copy of it.
 *
 * @param {any} content
 * @param {{includeTools?: boolean}} [opts]
 * @param {number} [depth]
 * @returns {string}
 */
export function messageText(content, opts = {}, depth = 0) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (depth > MAX_CONTENT_DEPTH) return '';

  if (Array.isArray(content)) {
    return content.map((b) => messageText(b, opts, depth + 1)).filter(Boolean).join('\n');
  }
  if (!isObject(content)) return '';

  const type = str(content.type);
  if (TEXT_BLOCKS.has(type) && typeof content.text === 'string') return content.text;
  if (type === 'thinking' && typeof content.thinking === 'string') return content.thinking;

  if (opts?.includeTools === true) {
    // `tool_result.content` is a string on some hosts and a block array on others, and both
    // shapes reach the same recursion — with `includeTools` still on, because a result can
    // itself carry a nested block list.
    if (type === 'tool_result') return messageText(content.content, opts, depth + 1);
    // A `tool_use` is rendered the way `capture.mjs` renders one, so an imported episode and
    // a captured one read alike. The parameters are NOT rendered here: they go through
    // `redactParams` first, and a renderer that produced the text before the scrubber ran
    // would be a redaction bypass with a comment on it.
    if (type === 'tool_use') return '';
  }

  if (type) return ''; // tool_use, tool_result, image, reasoning, …
  if (typeof content.text === 'string') return content.text;
  return '';
}

/**
 * `"<role>: <text>"` for one transcript line, or `''` when the line carries no text.
 *
 * @param {string} line
 * @param {{includeTools?: boolean}} [opts]
 * @returns {string}
 */
export function renderEntry(line, opts = {}) {
  const s = typeof line === 'string' ? line.trim() : '';
  if (!s) return '';

  const entry = parseLine(s);
  // A line that will not parse is still text somebody wrote. `checkpoint.mjs` returns it
  // verbatim rather than nothing, on the argument that a hand-rolled or partially flushed
  // transcript is better read than discarded, and that is kept here.
  if (!entry) return s;

  const message = messageRecord(entry);
  const body = messageText(message.content ?? entry.content ?? entry.text, opts);
  if (!body.trim()) return '';

  const role = str(message.role) || str(entry.role) || str(entry.type) || 'message';
  return `${role}: ${body}`;
}

// ---------------------------------------------------------------------------
// The blocks an importer needs, which the renderers deliberately flatten away
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ToolUse
 * @property {string} id      `tool_use.id` — verbatim, because it is what joins this to its
 *                            result and to the item id live capture would have written
 * @property {string} name
 * @property {Record<string, any>} input
 */

/**
 * @typedef {object} ToolResult
 * @property {string} id      `tool_result.tool_use_id`
 * @property {any} content    string or block array, as sent
 * @property {boolean} isError
 */

/**
 * The tool blocks in one line's message content.
 *
 * `tool_use` and `tool_result` arrive on **different lines** — the call on an `assistant`
 * line, the result on a `user` line — joined only by `tool_use.id` ↔ `tool_result.tool_use_id`.
 * Nothing in this repository joined them before the importer, because every live hook is
 * handed both halves in one payload.
 *
 * That join is not a convenience. `hasDeniedSubject` reads `PATH_KEYS` off the *call*, and
 * the file body arrives on the *result* line with no path field anywhere on it — so a reader
 * that walks lines independently gets the contents of a `.env` with no stage-2 protection at
 * all. Anything consuming this must pair them before it decides what to keep.
 *
 * @param {Record<string, any>} entry
 * @returns {{uses: ToolUse[], results: ToolResult[]}}
 */
export function toolBlocks(entry) {
  /** @type {{uses: ToolUse[], results: ToolResult[]}} */
  const out = { uses: [], results: [] };
  try {
    const content = messageRecord(entry).content;
    if (!Array.isArray(content)) return out;
    for (const b of content) {
      if (!isObject(b)) continue;
      const type = str(b.type);
      if (type === 'tool_use') {
        const id = str(b.id);
        if (id) out.uses.push({ id, name: str(b.name), input: isObject(b.input) ? b.input : {} });
      } else if (type === 'tool_result') {
        const id = str(b.tool_use_id);
        if (id) out.results.push({ id, content: b.content, isError: b.is_error === true });
      }
    }
  } catch {
    // A hostile content tree costs the tool blocks of one line.
  }
  return out;
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/** @param {any} v @returns {boolean} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @param {any} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** @param {any} v @param {number} d @returns {number} */
function numOr(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

/** @param {any} v @param {number} d @returns {number} */
function posInt(v, d) {
  const n = numOr(v, NaN);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : d;
}
