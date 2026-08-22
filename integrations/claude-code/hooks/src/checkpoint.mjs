#!/usr/bin/env node
// @ts-check
/**
 * `hooks/src/checkpoint.mjs` — PreCompact (`--pre`, blocking) / PostCompact (`--post`).
 *
 * One script, two modes by argv, and they have almost nothing in common: `--pre` is the only
 * blocking network call in the plugin, `--post` is a file read and a log line.
 *
 * ---------------------------------------------------------------------------
 * Why blocking is justified here and nowhere else
 * ---------------------------------------------------------------------------
 * Every other hook in this plugin would rather lose a memory than cost the user a
 * millisecond, because the content it is trying to capture is still on disk afterwards.
 * `PreCompact` is the single event where that is false: once the host compacts, the transcript
 * this hook was handed is **gone**, and nothing later can reconstruct it. §5.6 therefore
 * spends a 5000 ms internal budget against the 10 s `hooks.json` timeout, and §5.6's failure
 * line is the one failure in the whole plugin the user is shown:
 *
 *     mubit: checkpoint failed (server_error) — pre-compaction context not saved
 *
 * It is still exit 0 (§4.9). Blocking is not the same as failing, and a memory layer never
 * gets to fail a compaction.
 *
 * ---------------------------------------------------------------------------
 * The §5.6 flow, and the two places this file deviates from its step numbering
 * ---------------------------------------------------------------------------
 *   1. read `transcript_path` — the LAST 200 KB of message text
 *   2. redact it, before it goes anywhere
 *   5. spool the `checkpoint`-intent summary item        <- moved ahead of step 3
 *   3. POST /v2/control/checkpoint
 *   4. persist {checkpoint_id, token_estimate, at} to runs/<run_id>/checkpoints.json
 *
 * **Step 5 runs before step 3 on purpose.** §5.6 calls the spooled item the thing that makes
 * the anchor survive "even if the checkpoint call itself failed" — and the checkpoint call
 * can fail in a way a 500 does not cover: by hanging until the harness deadline fires and
 * takes the rest of the body with it. A local file write that happens first survives that;
 * one queued behind the socket does not. The item pays for it by carrying the `label` rather
 * than the server-assigned `checkpoint_id`, which is the cheaper half of the pair — the label
 * is derived here and is enough to join the two records back together.
 *
 * The **transcript is the densest secret surface the plugin ever touches** (§4.4): it holds
 * every command that was run and every file that was pasted. So the tail is scrubbed before
 * it is put in a request body, before it is put in a spool file, and before it is put in a
 * log line — and a scrub that throws drops the snapshot entirely rather than sending it raw.
 *
 * ---------------------------------------------------------------------------
 * `--post` injects nothing, and the re-anchor ships from SessionStart instead
 * ---------------------------------------------------------------------------
 * §5.6 gives `--post` (800 ms, **zero network**) the job of telling the model what the anchor
 * is and how to ask for it. It cannot do that job, and it never could: Claude Code validates
 * `hookSpecificOutput` against a closed set of `hookEventName` values, `PostCompact` is not
 * one of them, and a name outside the set fails the **whole** output —
 *
 *     PostCompact [node …/hooks/dist/checkpoint.mjs --post] failed:
 *     Hook JSON output validation failed — (root): Invalid input
 *
 * — so every re-anchor this hook emitted was discarded, silently, on every compaction since
 * the first release. `--pre` was never affected because `systemMessage` is a top-level field
 * and never reaches that union. `test/hook-output.test.mjs` holds the accepted set, the
 * command that re-derives it from the host binary, and the gate that now covers every hook.
 *
 * So the re-anchor moved to `hooks/src/session-start.mjs`, which fires with
 * `source === "compact"` after a compaction and whose `SessionStart` name **is** accepted. It
 * reads the same `checkpoints.json` this hook writes, so nothing new is stored to carry it.
 *
 * What is left here is a log line naming the anchor a compaction happened against — cheap,
 * useful when a user asks why nothing was re-anchored, and the honest amount of work for a
 * hook with no channel to speak on. With nothing stored it says nothing at all: "checkpoint
 * undefined holds your context" is strictly worse than silence, and so is a payload the host
 * throws away.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { clearCarry } from '../../lib/carry.mjs';
import { classifyTurn } from '../../lib/classify.mjs';
import { envTags } from '../../lib/config.mjs';
import { runHook } from '../../lib/hook.mjs';
import { postCheckpoint } from '../../lib/http.mjs';
import { log } from '../../lib/log.mjs';
import { redactText } from '../../lib/redact.mjs';
import { deriveAgentId, deriveRunId, resolveProjectDir, turnNumber } from '../../lib/runid.mjs';
import { clearSeen } from '../../lib/seen.mjs';
import { appendItem } from '../../lib/spool.mjs';
import { readJson, resolveDataDir, safeSegment, writeJsonAtomic } from '../../lib/state.mjs';

/** §5.6: `--pre` runs before a compaction, `--post` after it. */
const MODE = process.argv.slice(2).includes('--post') ? 'post' : 'pre';

/**
 * §5.6 budgets. `hooks.json` allows PreCompact 10 s and PostCompact 5 s; the harness budget
 * sits inside that with room to emit stdout, and `PRE_BUDGET_MS` is the §5.6 working deadline
 * the flow actually paces itself against.
 */
const PRE_HARNESS_MS = 8000;
const PRE_BUDGET_MS = 5000;
const POST_HARNESS_MS = 800;

/** Persisting the id and emitting stdout must still fit after the call comes back. */
const PERSIST_RESERVE_MS = 250;
/** Below this there is no point dialing at all; the socket would not finish handshaking. */
const MIN_POST_MS = 300;

/** §5.6 step 1: "the last 200 KB of message text". */
const SNAPSHOT_BYTES = 200 * 1024;

/**
 * Content-block types that carry human-readable message text, across both hosts —
 * Claude Code's `text` and Codex's `input_text` / `output_text`.
 *
 * `messageText` rejects every block type outside this set, and that rejection is
 * load-bearing: tool-use and tool-result blocks are already captured item-by-item through
 * the ordinary ingest path, and including them here would spend the 200 KB window on the one
 * part of the session that is not being thrown away. So it stays an allowlist — a block type
 * nobody has taught it about is silently skipped, which is the safe direction.
 *
 * It lives up here with the other constants rather than beside its one reader, and that is
 * not tidiness. This module runs `await runHook(...)` at module scope, so every `const` below
 * that line is still in its temporal dead zone while the hook body executes — and the body's
 * `attempt()` wrapper swallows the ReferenceError, yielding `no_transcript` on a transcript
 * that was there all along. Declared below, this constant silently disabled every checkpoint
 * on both hosts.
 */
const TEXT_BLOCKS = new Set(['text', 'input_text', 'output_text']);

/**
 * How much raw transcript is read to find that 200 KB. A `.jsonl` transcript spends most of
 * its bytes on envelopes, tool results and structure rather than on message text, so the read
 * window is deliberately wider than the target — and still bounded, because a long session's
 * transcript is measured in tens of megabytes and this hook is on the user's clock.
 */
const RAW_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * The spooled item is a *summary*, not a second copy of the snapshot: it travels the ordinary
 * ingest path, where §4.4's 8 KiB output cap applies. This leaves room for the header line
 * under that cap, so the item is never truncation-marked.
 */
const SUMMARY_TAIL_BYTES = 6 * 1024;

/** §5.6: `claude-code-precompact-<n>`, with `<n>` following the stored history. */
const LABEL_PREFIX = 'claude-code-precompact-';

/** §7: `runs/<run_id>/checkpoints.json` keeps the last 10. */
const CHECKPOINTS_KEEP = 10;

/** `item_id` is a wire value and a dedup key; keep it boring. */
const MAX_ID_CHARS = 160;

/** Nothing this hook decides is worth interrupting a compaction over. */
const SUPPRESS = Object.freeze({ suppressOutput: true });

/**
 * Every module-level binding this file uses lives ABOVE the `runHook` call, and that is not a
 * style choice: `await runHook(...)` suspends module evaluation, so a `const` declared below
 * it is still in its temporal dead zone while the body runs. Function declarations hoist and
 * are fine; a constant does not, and the resulting `ReferenceError` surfaces as nothing more
 * than `{"suppressOutput": true}` on the one path that touched it.
 *
 * @type {Snapshot}
 */
const NO_SNAPSHOT = Object.freeze({ text: '', bytes: 0, messages: 0, redactions: 0, truncated: false });

await runHook('checkpoint', {
  budgetMs: MODE === 'pre' ? PRE_HARNESS_MS : POST_HARNESS_MS,
  body: (payload, cfg, ctx) => (MODE === 'pre'
    ? precompact(isObject(payload) ? payload : {}, cfg, ctx)
    : postcompact(isObject(payload) ? payload : {}, cfg)),
});

// ---------------------------------------------------------------------------
// --pre — PreCompact
// ---------------------------------------------------------------------------

/**
 * §5.6 steps 1-5. Returns the one `systemMessage` the user ever sees from this plugin, in
 * either its saved or its failed form.
 *
 * @param {Record<string, any>} payload
 * @param {Record<string, any>} cfg
 * @param {any} ctx
 * @returns {Promise<Record<string, any>>}
 */
async function precompact(payload, cfg, ctx) {
  const started = numOr(ctx?.startedAt, Date.now());
  const deadline = started + PRE_BUDGET_MS;

  let runId = '';
  try {
    runId = deriveRunId(cfg, payload);
  } catch (err) {
    // `static` with no pin, or a derivation that could only have answered "default" (§4.3).
    // There is no run to anchor to, so there is nothing to say to the user that is not
    // really a plea to fix their config — and the log is where that belongs.
    log(cfg, 'warn', `checkpoint: no usable run id (${messageOf(err)}); nothing to checkpoint`);
    return SUPPRESS;
  }
  const agentId = attempt(() => deriveAgentId(payload), '');

  // Steps 1-2. Redaction is inside `buildSnapshot`, so there is no path from here to the
  // wire that carries an unscrubbed transcript.
  const snap = buildSnapshot(payload, cfg);
  if (!snap.text) {
    // The transcript is missing, unreadable, empty, or carries no message text (§4.9 — a
    // compaction the plugin cannot snapshot must still not break the compaction). The user
    // is told, because this loses the same data the server failure below loses.
    log(cfg, 'warn', 'checkpoint: no readable transcript text; pre-compaction context not saved', {
      run_id: runId, transcript_path: str(payload.transcript_path),
    });
    return { systemMessage: failedMessage('no_transcript') };
  }

  const history = readHistory(cfg, runId);
  // §5.6: the counter follows the stored history so a long session's anchors stay
  // distinguishable — `precompact-1` and `precompact-7` are different moments in one run.
  const label = `${LABEL_PREFIX}${history.length + 1}`;

  // §5.6 step 5, run early — see the header. The belt goes on before the braces.
  attempt(() => spoolSummary(cfg, runId, payload, snap, label));

  // §5.6 step 3. The deadline is this hook's own §5.6 budget rather than
  // `MUBIT_CC_TIMEOUT_MS`: that variable is tuned for the hot paths, where the alternative to
  // giving up is a slow turn. Here the alternative to waiting is losing the context forever.
  const timeoutMs = Math.max(MIN_POST_MS, deadline - Date.now() - PERSIST_RESERVE_MS);
  const res = await postCheckpoint(cfg, {
    run_id: runId,
    agent_id: agentId,
    label,
    context_snapshot: snap.text,
    metadata_json: safeJson({
      session_id: str(payload.session_id),
      // Codex sends no `turn_number`; the staged turn file is where it comes from there.
      turn_number: attempt(() => turnNumber(cfg, runId, payload), 0),
      source: 'PreCompact',
      trigger: str(payload.trigger),
      label,
      messages: snap.messages,
      snapshot_bytes: snap.bytes,
      redactions: snap.redactions,
      truncated: snap.truncated,
    }),
  }, { timeoutMs });

  const body = res.ok && isObject(res.body) ? res.body : null;
  const checkpointId = body ? str(body.checkpoint_id) : '';
  if (!checkpointId) {
    // A 2xx with no `checkpoint_id` is a broken server, not a broken network: there is
    // nothing to anchor to and nothing the caller can retry against.
    const err = /** @type {any} */ (res);
    const state = res.ok ? 'server_error' : (str(err.state) || 'server_error');
    log(cfg, 'error', `checkpoint: ${label} failed (${state})`, {
      run_id: runId,
      status: err.status ?? 0,
      error: str(err.error).slice(0, 300),
    });
    // §5.6: the one failure the user is shown, because it is the only one that loses data
    // permanently. Still exit 0 (§4.9).
    return { systemMessage: failedMessage(state) };
  }

  // §5.6 step 4 / §7.
  const tokens = intOr(body.token_estimate, 0);
  attempt(() => persist(cfg, runId, history, {
    checkpoint_id: checkpointId,
    token_estimate: tokens,
    at: Date.now(),
  }));

  log(cfg, 'info', `checkpoint: ${label} saved as ${checkpointId}`, {
    run_id: runId, bytes: snap.bytes, token_estimate: tokens,
  });
  return { systemMessage: savedMessage(checkpointId, tokens) };
}

// ---------------------------------------------------------------------------
// --post — PostCompact
// ---------------------------------------------------------------------------

/**
 * §5.6: note which anchor the freshly compacted session belongs to, and reset the cross-turn
 * seen-set. Reads one file, unlinks one, and dials nothing — 800 ms is not a network budget,
 * and a PostCompact that waited on a socket would be a stall on the first turn after every
 * compaction.
 *
 * ---------------------------------------------------------------------------
 * Why the seen-set is cleared here
 * ---------------------------------------------------------------------------
 * `hooks/src/prompt-recall.mjs` degrades a memory it has already injected into a one-line
 * pointer, on the strength of `runs/<run_id>/seen.json` saying the model has it
 * (`lib/seen.mjs`). **Compaction resets the model's window, not the file.** After this event
 * the transcript those entries were injected into is gone, so a surviving pointer names a
 * memory that exists nowhere in the conversation — the model is told a memory applies and is
 * given no way to read it, which is strictly worse than having paid full price for it.
 *
 * The clear runs before every other decision in this function on purpose. A compaction with
 * no stored anchor still emptied the window; gating the reset on `--pre` having succeeded
 * would leave stale pointers behind on exactly the runs that already lost their checkpoint.
 *
 * Emits `{"suppressOutput": true}` on every path, including the one that found an anchor. See
 * the header: `PostCompact` has no `hookSpecificOutput` channel, so the only shapes available
 * here are a top-level field or silence — and `systemMessage` is reserved (§5.6) for the one
 * failure that loses data, not for a routine note after every compaction. The model gets the
 * re-anchor from `session-start.mjs` on the `compact` source instead.
 *
 * @param {Record<string, any>} payload
 * @param {Record<string, any>} cfg
 * @returns {Record<string, any>}
 */
function postcompact(payload, cfg) {
  let runId = '';
  try {
    runId = deriveRunId(cfg, payload);
  } catch (err) {
    log(cfg, 'warn', `checkpoint: no usable run id (${messageOf(err)}); nothing to re-anchor`);
    return SUPPRESS;
  }

  // The seen-set reset, ahead of every other decision here — see the header above.
  clearSeen(cfg, runId);
  // …and the block `recallAsync` left for the next prompt, for the same reason and no other.
  // A carried block was assembled against the pre-compaction seen-set, so its pointer lines
  // are already baked in — clearing the set alone would leave a block promising that the full
  // entries are earlier in a transcript that no longer exists.
  clearCarry(cfg, runId);

  const latest = readHistory(cfg, runId).at(-1);
  const checkpointId = str(latest?.checkpoint_id);
  if (!checkpointId) {
    // Nothing stored: `--pre` never ran for this run, its call failed, or §7's 30-day sweep
    // took the file. The next SessionStart will find the same nothing and steer without an
    // anchor paragraph, which is the correct outcome — "checkpoint undefined holds your
    // context" spends the model's attention on a lie.
    log(cfg, 'debug', 'checkpoint: no stored checkpoint to re-anchor to', { run_id: runId });
    return SUPPRESS;
  }

  // The other lasting effect of this hook. It is what answers "why was nothing re-anchored?"
  // when the SessionStart that follows a compaction turns out to have read a different run.
  log(cfg, 'info', `checkpoint: compaction re-anchors to ${clamp(checkpointId, MAX_ID_CHARS)}`, {
    run_id: runId, trigger: str(payload.trigger),
  });
  return SUPPRESS;
}

// ---------------------------------------------------------------------------
// §5.6 steps 1-2 — the snapshot
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Snapshot
 * @property {string} text        redacted, and bounded to the last 200 KB
 * @property {number} bytes
 * @property {number} messages
 * @property {number} redactions
 * @property {boolean} truncated
 */

/**
 * The last 200 KB of message text, scrubbed.
 *
 * Order is the point: the tail is selected on **whole record boundaries**, then scrubbed, then
 * capped (§4.4 — "scrub before capping", so a cap can never slice a credential in half and
 * leave the recognizable prefix). Every stage is individually caught, and a stage that fails
 * yields no snapshot at all: an unredacted transcript is not an acceptable degraded mode.
 *
 * @param {Record<string, any>} payload
 * @param {Record<string, any>} cfg
 * @returns {Snapshot}
 */
function buildSnapshot(payload, cfg) {
  const path = str(payload.transcript_path);
  if (!path) return NO_SNAPSHOT;

  const raw = attempt(() => readTail(path, RAW_TAIL_BYTES), '');
  if (!raw) return NO_SNAPSHOT;

  const picked = attempt(() => lastMessages(raw, SNAPSHOT_BYTES), null);
  if (!picked || !picked.text) return NO_SNAPSHOT;

  // `redactText`'s `output` cap is §4.4's 8 KiB, which is the right bound for an ingest item
  // and the wrong one for a checkpoint: it keeps the HEAD of what it caps, so the default
  // would hand back the oldest 8 KiB of the window — the exact opposite of a tail.
  const scrubbed = attempt(
    () => redactText(picked.text, { ...cfg, maxOutputBytes: SNAPSHOT_BYTES }, 'output'),
    null);
  if (!scrubbed || !scrubbed.text) return NO_SNAPSHOT;

  return {
    text: scrubbed.text,
    bytes: Buffer.byteLength(scrubbed.text, 'utf8'),
    messages: picked.messages,
    redactions: num(scrubbed.redactions),
    truncated: !!scrubbed.truncated,
  };
}

/**
 * The last `maxBytes` bytes of a file, as text, with any partial leading line dropped.
 *
 * Reads by descriptor rather than `readFileSync` so a 40 MB transcript costs one `pread`
 * of the window instead of 40 MB of allocation on a hook the user is waiting on.
 *
 * @param {string} path
 * @param {number} maxBytes
 * @returns {string}
 */
function readTail(path, maxBytes) {
  const st = statSync(path);
  // A directory where a file is expected: `openSync` would succeed on some platforms and
  // `readSync` would then throw EISDIR. Answer "no transcript" up front instead.
  if (!st.isFile()) return '';
  const size = Number(st.size);
  if (!Number.isFinite(size) || size <= 0) return '';

  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  const fd = openSync(path, 'r');
  let text = '';
  try {
    const buf = Buffer.allocUnsafe(len);
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    text = buf.subarray(0, off).toString('utf8');
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }

  if (start === 0) return text;
  // A window that starts mid-file starts mid-record; the fragment would not parse and would
  // read as a truncated sentence in the snapshot.
  const nl = text.indexOf('\n');
  return nl === -1 ? '' : text.slice(nl + 1);
}

/**
 * Walk the transcript **backwards**, rendering one line per message, until `maxBytes` of
 * message text is accounted for. Backwards is what makes this a tail: a forward walk with a
 * cap yields the beginning of the session, which is the half compaction is least likely to
 * throw away.
 *
 * @param {string} raw
 * @param {number} maxBytes
 * @returns {{text: string, messages: number}}
 */
function lastMessages(raw, maxBytes) {
  const lines = raw.split('\n');
  /** @type {string[]} */
  const picked = [];
  let bytes = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const rendered = renderEntry(lines[i]);
    if (!rendered) continue;

    const size = Buffer.byteLength(rendered, 'utf8') + 1;
    if (bytes + size > maxBytes) {
      // One message larger than the whole window — a pasted file, a huge tool result. Taking
      // nothing would hand the server an empty snapshot, so take that message's own tail.
      if (picked.length === 0) picked.push(tailBytes(rendered, maxBytes));
      break;
    }
    bytes += size;
    picked.push(rendered);
  }

  picked.reverse();
  return { text: picked.join('\n'), messages: picked.length };
}

/**
 * One transcript record as `"<role>: <text>"`, or `''` for a record that carries no message
 * text (a tool result, a summary marker, a blank line).
 *
 * A line that is not JSON is treated as message text verbatim: a hand-rolled or older
 * transcript format is still a transcript, and refusing to snapshot it would trade a whole
 * feature for a parser assumption.
 *
 * ---------------------------------------------------------------------------
 * Two hosts, two envelopes, one rendering
 * ---------------------------------------------------------------------------
 * Claude Code writes `{"type":…,"message":{"role":…,"content":[{"type":"text","text":…}]}}`.
 * Codex writes a rollout: `{"type":"response_item","payload":{"type":"message","role":…,
 * "content":[{"type":"input_text"|"output_text","text":…}]}}`.
 *
 * The shape is sniffed **per line**, not per file, which costs nothing and means a data
 * directory shared by both hosts — which is exactly what the Codex port arranges — can hold
 * checkpoints from either without a mode flag anywhere.
 *
 * What made this worth a branch rather than a lenient `??` chain is that the failure is
 * silent and unrecoverable. `PreCompact` is the one event where the plugin gets no second
 * chance: once the host compacts, the transcript is gone. A reader that finds no `message`
 * key, falls back to the envelope, finds no `content` there either and returns `''` for every
 * line produces a hook that exits 0, logs "no readable transcript text", and loses the whole
 * pre-compaction context of every Codex session.
 *
 * @param {string} line
 * @returns {string}
 */
function renderEntry(line) {
  const s = typeof line === 'string' ? line.trim() : '';
  if (!s) return '';

  /** @type {any} */
  let entry;
  try {
    entry = JSON.parse(s);
  } catch {
    return s;
  }
  if (!isObject(entry)) return '';

  const message = messageRecord(entry);
  const body = messageText(message.content ?? entry.content ?? entry.text);
  if (!body.trim()) return '';

  const role = str(message.role) || str(entry.role) || str(entry.type) || 'message';
  return `${role}: ${body}`;
}

/**
 * The record inside a transcript line's envelope.
 *
 * Claude Code nests it under `message`. Codex nests it under `payload`, but only some
 * `payload`s are conversation — a rollout is mostly `session_meta`, `turn_context`,
 * `world_state`, `token_count` and `reasoning`, and one of those (`reasoning`) carries a
 * base64 blob large enough to fill the entire 200 KB window on its own. So the Codex branch
 * is taken on a **positive** signal: a `payload` that is an object carrying a `role` or a
 * `content`. Everything else falls through to the envelope itself, which is what the older
 * lenient behaviour did and what keeps a hand-rolled transcript readable.
 *
 * @param {Record<string, any>} entry
 * @returns {Record<string, any>}
 */
function messageRecord(entry) {
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
 * Tool-use and tool-result blocks are deliberately skipped: their content is already captured
 * item-by-item by `capture.mjs` through the ordinary ingest path, and including it here would
 * spend the 200 KB window on the one part of the session that is not being thrown away.
 *
 * @param {any} content
 * @param {number} [depth]
 * @returns {string}
 */
function messageText(content, depth = 0) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (depth > 3) return '';

  if (Array.isArray(content)) {
    return content.map((b) => messageText(b, depth + 1)).filter(Boolean).join('\n');
  }
  if (!isObject(content)) return '';

  const type = str(content.type);
  // `input_text` / `output_text` are Codex's spellings of `text`. Without them the branch
  // below rejects every conversational block in a rollout — the envelope sniff finds the
  // right object and this drops its contents, which looks identical to having no reader at
  // all.
  if (TEXT_BLOCKS.has(type) && typeof content.text === 'string') return content.text;
  if (type === 'thinking' && typeof content.thinking === 'string') return content.thinking;
  if (type) return ''; // tool_use, tool_result, image, reasoning, …
  if (typeof content.text === 'string') return content.text;
  return '';
}


// ---------------------------------------------------------------------------
// §5.6 step 5 — the spooled anchor
// ---------------------------------------------------------------------------

/**
 * The `checkpoint`-intent item, on the ordinary ingest path (§5.4/§5.5). It is the reason a
 * failed `/v2/control/checkpoint` costs the user an id rather than the context itself.
 *
 * Its text is derived from the **already-redacted** snapshot and re-scrubbed on the way out,
 * so there is no route by which a secret reaches the spool: the second pass is idempotent
 * (placeholders contain `[`, `]` and `:`, none of them in any rule's charset) and buys the
 * §4.4 byte cap for free.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {Record<string, any>} payload
 * @param {Snapshot} snap
 * @param {string} label
 */
function spoolSummary(cfg, runId, payload, snap, label) {
  const turn = attempt(() => turnNumber(cfg, runId, payload), 0);
  const head = `PreCompact checkpoint ${label}`
    + `${turn ? ` at turn ${turn}` : ''} (${snap.messages} message${snap.messages === 1 ? '' : 's'}, `
    + `${snap.bytes} bytes). Transcript tail before compaction:`;

  const tail = onLineBoundary(tailBytes(snap.text, SUMMARY_TAIL_BYTES));
  const body = attempt(
    () => redactText(`${head}\n${tail}`, cfg, 'output'),
    { text: '', redactions: 0, truncated: false });
  if (!body.text.trim()) return;

  // §4.5: PreCompact → `checkpoint`. §1.5: the intent is always set, or the server// pays for an LLM round trip per item to guess one.
  const cls = attempt(
    () => classifyTurn('', '', { event: 'PreCompact', trigger: str(payload.trigger) }),
    { intent: 'checkpoint', importance: 'medium', contentType: 'text' });

  appendItem(cfg, runId, {
    // §1.3: `item_id` and `content_type` are REQUIRED — a missing one is a 422 for the whole
    // batch. Derived from (session, counter) and never from a clock, so a retried drain
    // deduplicates instead of writing a second anchor for one compaction.
    item_id: clamp(`cc-precompact-${idPart(payload.session_id) || idPart(runId) || 'anon'}-${label.slice(LABEL_PREFIX.length)}`, MAX_ID_CHARS),
    content_type: str(cls.contentType) || 'text',
    text: body.text,
    intent: str(cls.intent) || 'checkpoint',
    importance: importanceOr(cls.importance),
    source: 'agent',
    // Unix SECONDS (`control.proto`); milliseconds here dates every memory to the year 57000.
    occurrence_time: Math.floor(Date.now() / 1000),
    // From the payload's directory, not the launch one: after a mid-session `cd` the run id
    // follows the new repo, and `repo:`/`branch:` have to follow it or the item lands in the
    // right run wearing the wrong labels.
    env_tags: attempt(
      () => envTags(cfg, resolveProjectDir(cfg, payload)), ['tool:claude-code']),
    metadata_json: safeJson({
      hook_event: str(payload.hook_event_name) || 'PreCompact',
      source: 'PreCompact',
      session_id: str(payload.session_id),
      turn_number: turn,
      trigger: str(payload.trigger),
      label,
      messages: snap.messages,
      snapshot_bytes: snap.bytes,
      redactions: snap.redactions + num(body.redactions),
      truncated: snap.truncated || !!body.truncated,
    }),
    ...(str(cfg?.userId) ? { user_id: str(cfg.userId) } : {}),
  });
}

// ---------------------------------------------------------------------------
// §7 — runs/<run_id>/checkpoints.json
// ---------------------------------------------------------------------------

/** @param {Record<string, any>} cfg @param {string} runId @returns {string} */
function checkpointsPath(cfg, runId) {
  return join(resolveDataDir(cfg), 'runs', safeSegment(runId), 'checkpoints.json');
}

/**
 * The stored history, oldest first. A missing, empty or corrupt file is the normal state of a
 * run that has never compacted, so it is "no history" rather than an error.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {Record<string, any>[]}
 */
function readHistory(cfg, runId) {
  try {
    const stored = readJson(checkpointsPath(cfg, runId), []);
    if (Array.isArray(stored)) return stored.filter(isObject);
    // Tolerate a wrapped shape rather than silently starting the history over: the counter
    // and the PostCompact anchor both read this file.
    if (isObject(stored)) {
      const inner = stored.checkpoints ?? stored.items;
      if (Array.isArray(inner)) return inner.filter(isObject);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * §7: "Last 10". The oldest are evicted, so a session that compacts thirty times does not
 * grow this file without bound, and `--post` always finds the newest at the end.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {Record<string, any>[]} history
 * @param {{checkpoint_id: string, token_estimate: number, at: number}} entry
 */
function persist(cfg, runId, history, entry) {
  writeJsonAtomic(checkpointsPath(cfg, runId), [...history, entry].slice(-CHECKPOINTS_KEEP));
}

// ---------------------------------------------------------------------------
// stdout copy
// ---------------------------------------------------------------------------

/**
 * §5.6, verbatim: `mubit: checkpoint failed (<state>) — pre-compaction context not saved`.
 * The parenthetical is the `ConnState` (§4.7), so "it timed out" and "it rejected my key" are
 * distinguishable without opening a log.
 * @param {string} state
 * @returns {string}
 */
function failedMessage(state) {
  return `mubit: checkpoint failed (${state}) — pre-compaction context not saved`;
}

/**
 * §5.6: `mubit: checkpoint ckpt_01HZ… saved (3.4k tok) before compaction`. The id is what
 * makes the anchor findable afterwards, so it is never elided by this function.
 * @param {string} id
 * @param {number} tokens
 * @returns {string}
 */
function savedMessage(id, tokens) {
  const size = tokens > 0 ? ` (${formatTokens(tokens)})` : '';
  return `mubit: checkpoint ${clamp(id, MAX_ID_CHARS)} saved${size} before compaction`;
}

/** `3400` -> `3.4k tok`. @param {number} n @returns {string} */
function formatTokens(n) {
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k tok`;
  }
  return `${n} tok`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The last `cap` bytes of a string, never slicing a UTF-8 sequence in half — the mirror of
 * `lib/redact.mjs`'s head-side cap.
 * @param {string} s
 * @param {number} cap
 * @returns {string}
 */
function tailBytes(s, cap) {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= cap) return s;
  let start = buf.length - cap;
  while (start < buf.length && (buf[start] & 0xC0) === 0x80) start += 1;
  return buf.subarray(start).toString('utf8');
}

/** Drop a leading half-line, so a summary never opens mid-sentence. @param {string} s */
function onLineBoundary(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(nl + 1);
}

/** An id fragment safe as both a path segment and a wire value. @param {any} v */
function idPart(v) {
  return safeSegment(v, MAX_ID_CHARS);
}

/**
 * §5.4's discipline, applied here for the same reason: one broken step costs its own
 * contribution and nothing else — most importantly, a redaction crash drops the snapshot
 * rather than letting an unredacted one through.
 * @template T
 * @param {() => T} fn
 * @param {T} [fallback]
 * @returns {T}
 */
function attempt(fn, fallback = /** @type {any} */ (undefined)) {
  try { return fn(); } catch { return fallback; }
}

/** @param {any} v @returns {boolean} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @param {any} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** @param {any} v @returns {number} */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** @param {any} v @param {number} d @returns {number} */
function numOr(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

/** @param {any} v @param {number} d @returns {number} */
function finiteOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** @param {any} v @param {number} d @returns {number} */
function intOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : d;
}

/** @param {string} s @param {number} max @returns {string} */
function clamp(s, max) {
  const v = typeof s === 'string' ? s : String(s ?? '');
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

/** §1.3: `importance` is a closed vocabulary; anything else is a 422 waiting to happen. */
function importanceOr(v) {
  const s = str(v).toLowerCase();
  return ['low', 'medium', 'high', 'critical'].includes(s) ? s : 'medium';
}

/** `metadata_json` goes on the wire as a STRING, not an object (`control.proto`). */
function safeJson(v) {
  try {
    const s = JSON.stringify(v ?? {});
    return typeof s === 'string' ? s : '{}';
  } catch {
    return '{}';
  }
}

/** @param {any} err @returns {string} */
function messageOf(err) {
  try {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    return [err.name, err.message].filter(Boolean).join(': ') || String(err);
  } catch {
    return 'unknown error';
  }
}
