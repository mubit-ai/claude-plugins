// @ts-check
/**
 * `hooks/src/stage-prompt.mjs` — UserPromptSubmit, the fast path.
 *
 * **Budget < 25 ms. Zero network.** It runs on the same event as `prompt-recall`, which is
 * allowed 1500 ms and a round trip; this one is allowed neither, because everything it does
 * is local bookkeeping and the user is waiting on both.
 *
 * Two jobs:
 *
 *   1. Stage the prompt at `runs/<run_id>/turns/<prompt_id>.json`. The `Stop` payload carries
 *      `last_assistant_message` but **not** the prompt that produced it, so without this file
 *      every captured turn would be half a conversation — an answer with no question.
 *   2. Check the drain triggers (`count >= batchMaxItems` or `oldestMs >= batchMaxAgeMs`) and
 *      spawn the detached drain. A new prompt arriving is exactly the moment the previous
 *      turn's captures are complete, which makes it a better trigger than a timer: it is
 *      user-paced, it costs nothing when nothing was captured, and it never fires mid-turn.
 *
 * **The race:** `prompt-recall` writes `recalled` into this same file on this same event, and
 * the two hooks are separate processes with no ordering guarantee. Both are specified
 * read-modify-write-atomic, and this side of it means: read what is there, keep a `recalled`
 * that someone else already filled, and rename the whole file into place. `recalled: []` is
 * written when there is nothing to keep — an absent key is a different value from an empty
 * one to everything downstream.
 *
 * **Failure:** swallow everything. The cost of an unwritable data dir is one Q&A pair, and
 * that is a price worth paying many times over rather than delay a single prompt.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { loadConfig } from '../../lib/config.mjs';
import { runHook, spawnDetached } from '../../lib/hook.mjs';
import { log } from '../../lib/log.mjs';
import { deriveRunId } from '../../lib/runid.mjs';
import { spoolStats } from '../../lib/spool.mjs';
import {
  ensureDir, readJson, resolveDataDir, runDir, safeSegment, writeJsonAtomic,
} from '../../lib/state.mjs';

/**
 * §5.3 targets < 25 ms of work; this is the harness's hard stop, not the target. Everything
 * below is synchronous file I/O, so the deadline only ever matters if a filesystem hangs.
 */
const BUDGET_MS = 250;

/** A pasted 10 MB stack trace is a prompt too. The turn file is not the transcript. */
const MAX_PROMPT_BYTES = 64 * 1024;

/** `prompt_id` names a file, so it is treated as untrusted input to a path. */
const MAX_ID = 128;

await runHook('stage-prompt', {
  budgetMs: BUDGET_MS,
  body: async (payload) => {
    const cfg = loadConfig();

    // Capture off means no Stop capture to feed and no spool to drain; recall off means no
    // `recalled` ids to merge with. With both off the file has no reader.
    if (!cfg.capture && !cfg.recall) return { suppressOutput: true };

    let runId = '';
    try {
      runId = deriveRunId(cfg, payload);
    } catch (err) {
      log(cfg, 'error', `stage-prompt: no usable run id (${messageOf(err)})`);
      return { suppressOutput: true };
    }

    stageTurn(cfg, runId, payload);
    if (cfg.capture) maybeDrain(cfg, runId, payload);

    return { suppressOutput: true };
  },
});

// ---------------------------------------------------------------------------
// Step 1 — the staged turn
// ---------------------------------------------------------------------------

/**
 * `runs/<run_id>/turns/<prompt_id>.json` = `{prompt, prompt_id, session_id, started_at,
 * recalled}`, merged onto whatever is already there and renamed into place.
 *
 * `started_at` is kept when it is already present: if `prompt-recall` won the race it stamped
 * the same instant, and the earlier stamp is the truer one for a turn's elapsed time.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {Record<string, any>} payload
 * @returns {boolean} true when the file landed
 */
function stageTurn(cfg, runId, payload) {
  try {
    const promptId = safeSegment(payload?.prompt_id, MAX_ID);
    if (!promptId) return false;

    // Both halves of this path are untrusted: the prompt id comes from the host, the run id
    // can be pinned by hand. This join used to sanitise only the first, which put the turn
    // file somewhere no sibling hook would ever read it.
    const dir = join(runDir(cfg, runId), 'turns');
    // §12.1-F14: a read-only ${CLAUDE_PLUGIN_DATA} costs this Q&A pair and nothing else.
    if (!ensureDir(dir)) return false;

    const file = join(dir, `${promptId}.json`);
    const prev = readJson(file, null);
    const base = isObject(prev) ? prev : {};

    const { text, truncated } = clampPrompt(payload?.prompt);
    /** @type {Record<string, any>} */
    const next = {
      ...base,
      prompt: text,
      prompt_id: promptId,
      session_id: typeof payload?.session_id === 'string' ? payload.session_id : '',
      started_at: Number.isFinite(base.started_at) ? base.started_at : Date.now(),
      // The other half of the §5.3 race: never overwrite ids `prompt-recall` already staged.
      recalled: Array.isArray(base.recalled) ? base.recalled : [],
    };
    if (truncated) next.prompt_truncated = true;

    return writeJsonAtomic(file, next);
  } catch (err) {
    log(cfg, 'warn', `stage-prompt: could not stage the turn (${messageOf(err)})`, { run_id: runId });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Step 2 — the drain trigger
// ---------------------------------------------------------------------------

/**
 * §5.3 step 2. `spoolStats` is the whole trigger: `count >= batchMaxItems` says the batch is
 * full, `oldestMs >= batchMaxAgeMs` says a quiet session has captures going stale. It is the
 * *oldest* item that decides the age, so a steady trickle cannot keep resetting the clock.
 *
 * The drain is detached and does its own locking, so spawning one while another is mid-flight
 * costs a process that exits immediately — never a double send.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {Record<string, any>} payload
 * @returns {void}
 */
function maybeDrain(cfg, runId, payload) {
  try {
    const { count, oldestMs } = spoolStats(cfg, runId);
    if (count <= 0) return;

    const full = count >= intOr(cfg.batchMaxItems, 32);
    const stale = oldestMs >= intOr(cfg.batchMaxAgeMs, 30000);
    if (!full && !stale) return;

    // §4.9: the payload travels by file, not by inherited stdin — a detached child's stdin is
    // not reliably readable once this process exits.
    const payloadPath = writePayload(cfg, payload);
    spawnDetached(cfg, 'drain', [], payloadPath);
    log(cfg, 'debug', 'stage-prompt: drain triggered', { run_id: runId, count, oldest_ms: oldestMs });
  } catch (err) {
    // A drain that could not be started is retried on the very next prompt.
    log(cfg, 'warn', `stage-prompt: could not start the drain (${messageOf(err)})`, { run_id: runId });
  }
}

/**
 * `${CLAUDE_PLUGIN_DATA}/tmp/<uuid>.json`, which the child unlinks when it is done.
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} payload
 * @returns {string}
 */
function writePayload(cfg, payload) {
  const dir = join(resolveDataDir(cfg), 'tmp');
  const file = join(dir, `${randomUUID()}.json`);
  ensureDir(dir);
  writeJsonAtomic(file, isObject(payload) ? payload : {});
  return file;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** @param {any} v @returns {{text: string, truncated: boolean}} */
function clampPrompt(v) {
  const s = typeof v === 'string' ? v : '';
  if (Buffer.byteLength(s, 'utf8') <= MAX_PROMPT_BYTES) return { text: s, truncated: false };
  return { text: Buffer.from(s, 'utf8').subarray(0, MAX_PROMPT_BYTES).toString('utf8'), truncated: true };
}

/** @param {any} v */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function intOr(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : d;
}

function messageOf(err) {
  if (err && typeof err === 'object' && typeof (/** @type {any} */ (err).message) === 'string') {
    return (/** @type {any} */ (err).message);
  }
  return String(err);
}
