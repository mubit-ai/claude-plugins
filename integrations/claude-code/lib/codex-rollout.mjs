// @ts-check
/**
 * `lib/codex-rollout.mjs` — the outcome of a tool call, read out of Codex's rollout transcript.
 *
 * ---------------------------------------------------------------------------
 * Why this file has to exist
 * ---------------------------------------------------------------------------
 * Codex has no `PostToolUseFailure` event, so `capture.mjs` — which decides `failed` from
 * which event fired — records every tool call on this host as a success. A failed `rm`, a
 * failed test run, a failed `apply_patch`: all stored `outcome: 'ok'`. The failure half of
 * memory is empty by construction, and the success half carries things that did not work.
 *
 * The obvious repair is to read the outcome out of `tool_response`, and it does not work. A
 * live `codex exec` says why:
 *
 *     `sh -c "echo out; exit 9"`     ->  tool_response: "out\n"
 *     `echo hello-stdout; exit 3`    ->  tool_response: "hello-stdout\n"
 *
 * For `Bash`, `tool_response` is the aggregated output and nothing else — byte-for-byte what
 * a success sends. No exit code, no status. (The `"Exit code: N\nWall time: …"` preamble is
 * an `apply_patch` shape; a parser for it fixes nothing for the shell.)
 *
 * What the host *does* record is a line in the rollout transcript, whose path every relevant
 * payload already carries, keyed by the same `tool_use_id`:
 *
 *     {"type":"event_msg","payload":{"type":"item_completed","item":{
 *        "type":"CommandExecution","id":"exec-94b2…","status":"failed","exit_code":9,
 *        "stdout":"out\n","aggregated_output":"out\n","duration":{"secs":0,"nanos":2375}}}}
 *
 * and it is already on disk when the hook runs, which a hook reading its own
 * `transcript_path` mid-turn confirmed.
 *
 * ---------------------------------------------------------------------------
 * Two rules it keeps
 * ---------------------------------------------------------------------------
 * **It reads a bounded tail.** This runs on every `PostToolUse`, inside a 3-second host
 * timeout, against a file that grows all session. The record wanted is the most recent one,
 * so the last few hundred KB is read and scanned backwards. A whole-file read would make the
 * hot path a function of session length.
 *
 * **Silence is never a verdict.** No path, no file, no matching record, an unparseable line —
 * every one of those returns `found: false`, and the caller leaves the item exactly as it
 * would have been. The bug being fixed is the host saying "failed" and the plugin recording
 * "ok"; guessing in the other direction would be the same bug facing the other way.
 */

import { openSync, readSync, closeSync, fstatSync } from 'node:fs';

/** How much of the tail to read. A `CommandExecution` line runs a few KB at most. */
const TAIL_BYTES = 512 * 1024;

/** How much of the HEAD to read when looking for a rollout's opening user message. */
const HEAD_BYTES = 256 * 1024;

/** A subagent's task, not its transcript: enough to identify the work, not to replay it. */
const MAX_PROMPT_CHARS = 4096;

/** `input_text` / `output_text` are Codex's spellings of `text`. */
const TEXT_BLOCKS = new Set(['text', 'input_text', 'output_text']);

/**
 * @typedef {object} ToolCallRecord
 * @property {boolean} found        did the host record this call at all
 * @property {boolean} failed       did it record it as failed
 * @property {number|null} exitCode
 * @property {number|null} durationMs
 * @property {string} status        the host's own word, '' when not found
 */

/** @type {ToolCallRecord} */
const NOT_FOUND = Object.freeze({
  found: false, failed: false, exitCode: null, durationMs: null, status: '',
});

/**
 * What the host recorded about one tool call.
 *
 * @param {string} transcriptPath  `payload.transcript_path`
 * @param {string} toolUseId       `payload.tool_use_id`
 * @param {{tailBytes?: number}} [opts]
 * @returns {ToolCallRecord}
 */
export function toolCallRecord(transcriptPath, toolUseId, opts = {}) {
  const path = typeof transcriptPath === 'string' ? transcriptPath.trim() : '';
  const id = typeof toolUseId === 'string' ? toolUseId.trim() : '';
  if (!path || !id) return NOT_FOUND;

  const text = readTail(path, Number(opts.tailBytes) > 0 ? Number(opts.tailBytes) : TAIL_BYTES);
  if (!text) return NOT_FOUND;

  const lines = text.split('\n');
  // Backwards: a retried call appends a second record, and the last one is what happened.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // § The cheap filter first. A rollout is mostly reasoning and message text, and parsing
    //   every line of it per tool call is the difference between ~1 ms and tens of ms.
    if (!line || line.indexOf(id) === -1) continue;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A truncated first line is normal — the tail read starts mid-file — and a rollout
      // carries shapes this plugin does not know. Neither is a reason to stop looking.
      continue;
    }
    const item = parsed?.payload?.item;
    if (!item || item.id !== id) continue;

    const status = typeof item.status === 'string' ? item.status : '';
    const exitCode = Number.isFinite(item.exit_code) ? Number(item.exit_code) : null;
    return {
      found: true,
      // § `status` is the host's own verdict and is what to trust. `exit_code` is the
      //   fallback for a record shape that carries one without the other.
      failed: status ? status === 'failed' : exitCode !== null && exitCode !== 0,
      exitCode,
      durationMs: durationMs(item.duration),
      status,
    };
  }
  return NOT_FOUND;
}

/**
 * `{secs, nanos}` as whole milliseconds, or `null`.
 *
 * Rounded down, so a 2375 ns call reports 0 rather than 1. Zero here means "the host measured
 * less than a millisecond", which is true; the state being fixed is zero meaning "nobody
 * looked".
 *
 * @param {any} d
 * @returns {number|null}
 */
function durationMs(d) {
  if (!d || typeof d !== 'object') return null;
  const secs = Number.isFinite(d.secs) ? Number(d.secs) : 0;
  const nanos = Number.isFinite(d.nanos) ? Number(d.nanos) : 0;
  if (!secs && !nanos) return 0;
  return Math.floor(secs * 1000 + nanos / 1e6);
}

/**
 * The last `bytes` of a file, as text. `''` for anything that goes wrong.
 *
 * `openSync`/`readSync` rather than `readFileSync`, because the point is not to read a file
 * that may be tens of megabytes by the end of a long session.
 *
 * @param {string} path
 * @param {number} bytes
 * @returns {string}
 */
function readTail(path, bytes) {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    if (length <= 0) return '';
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8', 0, read);
  } catch {
    return '';
  } finally {
    if (fd !== -1) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * The first thing a *user* said in a rollout — which, in a subagent's own transcript, is the
 * task it was actually given.
 *
 * ---------------------------------------------------------------------------
 * Why a subagent needs this
 * ---------------------------------------------------------------------------
 * `capture --subagent` renders `Q: <prompt>` from the turn file its **parent** staged. Every
 * sibling in a fan-out shares that one turn, so six subagents in one turn are stored as six
 * different answers to one identical question — and which one did what is unrecoverable.
 *
 * `SubagentStop` carries `agent_transcript_path`, the agent's own rollout, and it is the only
 * coordinate that differs between siblings. This reads its head: the task is the first thing
 * in the file, so the whole file never has to be.
 *
 * The envelope is the one Codex writes and the checkpoint reader already knows:
 * `{"type":"response_item","payload":{"type":"message","role":"user",
 * "content":[{"type":"input_text","text":…}]}}`. `input_text` is Codex's spelling of `text`.
 *
 * Returns `''` for anything that does not answer — no path, no file, no user message, a
 * transcript in a shape this does not know. The caller falls back to the parent's staged
 * prompt, which is what was stored before any of this existed.
 *
 * @param {string} transcriptPath
 * @param {{headBytes?: number, maxChars?: number}} [opts]
 * @returns {string}
 */
export function firstUserText(transcriptPath, opts = {}) {
  const path = typeof transcriptPath === 'string' ? transcriptPath.trim() : '';
  if (!path) return '';

  const text = readHead(path, Number(opts.headBytes) > 0 ? Number(opts.headBytes) : HEAD_BYTES);
  if (!text) return '';

  const lines = text.split('\n');
  // The last line of a bounded head read is very likely truncated; never parse it.
  for (const line of lines.slice(0, -1)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // Codex nests the record under `payload`; Claude Code under `message`. Both are accepted
    // so a shared data directory does not need a mode flag anywhere.
    const record = entry?.payload ?? entry?.message ?? entry;
    if (!record || typeof record !== 'object') continue;
    if (record.role !== 'user') continue;

    const body = blockText(record.content);
    if (body.trim()) return body.slice(0, Number(opts.maxChars) > 0 ? Number(opts.maxChars) : MAX_PROMPT_CHARS);
  }
  return '';
}

/** The text out of a message's content blocks. Mirrors the checkpoint reader's rules. */
function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      const type = typeof b.type === 'string' ? b.type : '';
      if (TEXT_BLOCKS.has(type) && typeof b.text === 'string') return b.text;
      if (!type && typeof b.text === 'string') return b.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** The first `bytes` of a file, as text. `''` for anything that goes wrong. */
function readHead(path, bytes) {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    if (length <= 0) return '';
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, 0);
    return buf.toString('utf8', 0, read);
  } catch {
    return '';
  } finally {
    if (fd !== -1) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}
