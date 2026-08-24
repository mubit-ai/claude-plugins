#!/usr/bin/env node
// @ts-check
/**
 * `hooks/src/recall-refresh.mjs` — the detached half of carry-forward recall (§5.2).
 *
 * Not registered in `hooks.json`, for the same reason `drain.mjs` is not: it is spawned
 * detached by `prompt-recall` when `recallAsync` is on, exactly the way `stage-prompt.mjs`
 * fires the drain. Nothing waits on it, and that is the entire point — it is the process
 * that pays for the round trip so the prompt does not.
 *
 * ```
 * prompt-recall (blocking, ~2 ms)          recall-refresh (detached, however long it takes)
 *   takeCarry  → render turn N's block
 *   markSeen   → record what turn N saw
 *   spawn ────────────────────────────────▶ readSeen (now including turn N)
 *                                           recallBlock (the same three-rung ladder)
 *                                           writeCarry → the block turn N+1 will render
 * ```
 *
 * ---------------------------------------------------------------------------
 * What this process must NOT do
 * ---------------------------------------------------------------------------
 * It writes the **block** and nothing that describes what the model saw. Specifically, no
 * `markSeen` and no `recalled[]`:
 *
 *   - **`markSeen` here would be a lie.** It means "the model has been shown this", and this
 *     process has shown nothing to anyone. A block that is never rendered — the session ends,
 *     the flag is turned off, `checkpoint --post` clears it, the next prompt is a slash
 *     command — would leave entries recorded as seen that the model never received. The next
 *     full-price block then degrades them to pointers naming text that exists nowhere in the
 *     transcript, which `lib/seen.mjs` calls out as the one failure worse than paying twice.
 *   - **`recalled[]` here would credit the wrong turn.** The handoff's stated hard part was
 *     that "the turn that receives the block is not the turn that requested it". Writing
 *     attribution on the synchronous read instead of here dissolves it: the reader has the
 *     receiving turn's `prompt_id` in hand, so the ids land on the turn that was actually
 *     given them, by construction rather than by bookkeeping.
 *
 * It does own one thing the reader cannot: the **connection state**. This is the only process
 * that dials once the flag is on, so without its marker write the status line could never
 * show a failure again.
 *
 * ---------------------------------------------------------------------------
 * Budget
 * ---------------------------------------------------------------------------
 * `recallBudgetMs` is deliberately *not* consulted. That budget exists because a user is
 * waiting; here nobody is, so honouring it would reproduce the empty recall the mode was
 * built to fix — a Mubit answering in 1.4-2.3 s against a 1500 ms default is the runbook's
 * documented complaint. The bound here is `REFRESH_BUDGET_MS`, and `lib/http.mjs` still caps
 * each individual request at `timeoutMs`, so a hung endpoint costs one abandoned socket.
 *
 * Constraints shared with the rest of the plugin: zero dependencies, Node >= 20 built-ins,
 * and **exit code 0, always** (§4.9).
 */

import { isConfigured, loadConfig } from '../../lib/config.mjs';
import { runHook } from '../../lib/hook.mjs';
import { log } from '../../lib/log.mjs';
import { rankForRecall } from '../../lib/rank.mjs';
import { CONN_STATES } from '../../lib/breaker.mjs';
import { writeCarry } from '../../lib/carry.mjs';
import { updateMarker } from '../../lib/markers.mjs';
import { recallBlock } from '../../lib/recall.mjs';
import { deriveAgentId, deriveRunId, resolveProjectDir } from '../../lib/runid.mjs';
import { readSeen } from '../../lib/seen.mjs';
import { safeSegment } from '../../lib/state.mjs';

/**
 * The soft bound, matching `drain.mjs`. Nothing waits on this process, but a detached child
 * that never exits is a leak, and a ladder still climbing after ten seconds has already
 * missed the turn it was refreshing for.
 */
const REFRESH_BUDGET_MS = 10_000;

/** The harness's hard stop sits just past the working budget, so the marker write lands. */
const HARNESS_BUDGET_MS = REFRESH_BUDGET_MS + 2_000;

/** §5.2 step 0, shared with `prompt-recall`: "ok", "go on" carry no retrievable intent. */
const MIN_PROMPT_CHARS = 8;

/** §5.2: recall quality does not improve past this, and a 40 KB paste is a slow embedding. */
const MAX_QUERY_CHARS = 2000;

/** `prompt_id` is carried as provenance only, but it is still host input. */
const MAX_ID = 128;

const SUPPRESS = Object.freeze({ suppressOutput: true });

await runHook('recall-refresh', {
  budgetMs: HARNESS_BUDGET_MS,
  body: async (payload, _hookCfg, ctx) => {
    const cfg = loadConfig();
    const started = numOr(ctx?.startedAt, Date.now());

    // The same step-0 gate the caller applies. Re-checked rather than trusted: this process
    // can also be started by hand while debugging, and a refresh with recall off would write
    // a block nothing is allowed to inject.
    if (!cfg.recall) return SUPPRESS;
    if (!isConfigured(cfg)) return SUPPRESS;

    const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : '';
    if (prompt.length < MIN_PROMPT_CHARS) return SUPPRESS;
    if (prompt.startsWith('/')) return SUPPRESS;

    let runId = '';
    let agentId = '';
    try {
      runId = deriveRunId(cfg, payload);
      agentId = deriveAgentId(payload);
    } catch (err) {
      log(cfg, 'warn', `recall-refresh: no usable run id (${messageOf(err)})`);
      return SUPPRESS;
    }

    // What the run has already put in front of the model — *including* the turn that spawned
    // this process, because `prompt-recall` marks before it spawns. Reading a seen-set that
    // is one turn behind would re-render at full price the entry the user is looking at.
    const seen = readSeen(cfg, runId).ids;

    const query = prompt.slice(0, MAX_QUERY_CHARS);

    const outcome = await recallBlock(cfg, {
      runId,
      agentId,
      query,
      deadline: started + REFRESH_BUDGET_MS,
      seen,
      // §5.2 — the same rule over the same query text `prompt-recall` would have used.
      // Carry-forward moves WHEN the call happens, never what it asks for: a handoff prompt
      // ranked by similarity in the background is the same bug, one turn later.
      rankBy: rankForRecall(cfg, query),
      // The refresh runs detached but carries the spawning turn's payload, so it tags against
      // the directory that turn was sent in rather than wherever this process happens to sit.
      projectDir: resolveProjectDir(cfg, payload),
    });
    const fetchMs = Date.now() - started;

    // §4.7/§4.8: the state as observed. This is the only process that dials once the flag is
    // on, so the status line's connection glyph is sourced from here or from nowhere. The
    // `recall` group is deliberately left alone — that describes what was *injected*, and
    // this process injects nothing.
    if (outcome.failed) {
      log(cfg, 'warn',
        `recall-refresh: recall failed on rung ${outcome.rung} (${str(outcome.state) || 'unknown'})`,
        { run_id: runId, error: str(outcome.error).slice(0, 300) });
      updateMarker(cfg, runId, {
        ...(isConnState(str(outcome.state)) ? { state: str(outcome.state) } : {}),
        last_error: str(outcome.error).slice(0, 200),
      });
      // Nothing is carried forward. An empty carry file would read as "nothing to inject" on
      // the next turn either way, and it would overwrite a block that is still in date.
      return SUPPRESS;
    }

    updateMarker(cfg, runId, { state: 'ready', last_error: '' });

    if (!outcome.block) {
      log(cfg, 'debug', `recall-refresh: nothing to carry forward (${outcome.emptyReason || 'no_evidence'})`,
        { run_id: runId });
      return SUPPRESS;
    }

    const landed = writeCarry(cfg, runId, outcome, {
      promptId: safeSegment(payload?.prompt_id, MAX_ID),
      fetchMs,
    });
    log(cfg, landed ? 'debug' : 'warn',
      landed
        ? `recall-refresh: carried ${outcome.refIds.length} sources forward in ${fetchMs}ms`
        : 'recall-refresh: could not write the carried block; the next prompt recalls nothing',
      { run_id: runId });

    return SUPPRESS;
  },
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** §4.7's closed union, asked against the export so this file cannot drift from it. */
function isConnState(v) {
  return typeof v === 'string' && /** @type {readonly string[]} */ (CONN_STATES).includes(v);
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
