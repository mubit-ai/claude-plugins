#!/usr/bin/env node
// @ts-check
/**
 * `hooks/src/cwd-changed.mjs` — CwdChanged, the run-id follower.
 *
 * `per-directory` is the default run strategy: the run id is derived from a directory, so a
 * session that changes directory changes run. `lib/runid.mjs` now reads `payload.cwd` and so
 * derives the right answer on its own — but deriving a new id is only half of what a move
 * needs, because **nothing in this plugin ever sweeps `runs/`**. `session-end.mjs` and
 * `drain.mjs` each scope to exactly one run, and that run is this session's current one. If
 * the id simply moved, the run the session left would keep a spool nobody was ever going to
 * send: it survives only if the user walks back into that repo before `pruneStale` deletes it
 * (§7, 24 h), and it never gets a reflect, so its lessons never widen past `run` scope.
 *
 * So this hook is the moment of the move, and it does three things with it:
 *
 *   1. Nothing at all, when the run did not move. `cd src/` is the ordinary case and it must
 *      cost nothing — the id resolves through `git rev-parse --show-toplevel`, so only a
 *      different repo moves it, and `per-conversation` and `static` never move at all.
 *   2. Drains the run being left, pinned with `--run` so the detached child cannot re-derive
 *      through the mapping this hook is rewriting.
 *   3. Marks the run being entered, because `bin/statusline.mjs` follows the session map on
 *      every frame and renders `''` until the marker it names has been written.
 *
 * **Three host facts, read out of the shipping binary (2.1.235) rather than the docs:**
 *
 *   - `CwdChanged` passes the output schema's zod union and is **absent from the dispatch
 *     switch**. It has no `hookSpecificOutput` channel — the same class as `PreCompact` and
 *     `SessionEnd` — so anything it said would be validated and then discarded in silence.
 *     Every path here returns `{suppressOutput: true}`; the effect is entirely in the writes.
 *   - The payload names are `old_cwd` and `new_cwd`, not `previous_cwd`:
 *     `{...Ly(e,Vt()), hook_event_name:"CwdChanged", old_cwd:t, new_cwd:r}`.
 *   - It is dispatched with no `matchQuery`, so it supports no matcher, and it fires *after*
 *     the directory has already changed, so it cannot block one.
 *
 * `CLAUDE_ENV_FILE` is deliberately **not** written, though the host does republish it on this
 * event. It is sourced as a shell script for Bash-tool commands; no hook process re-reads it,
 * and neither does the already-running MCP server. `MUBIT_CC_RUN_ID` is consulted only under
 * `runStrategy: static` — which no `cd` can move — so a republish would be inert under the
 * default and misleading under the pin.
 *
 * **Failure:** swallow everything (§4.9). The cost of an unwritable data dir here is one
 * mis-attributed run, which is exactly the cost of not having this hook at all.
 */

import { loadConfig } from '../../lib/config.mjs';
import { runHook, spawnDetached, stashPayload } from '../../lib/hook.mjs';
import { log } from '../../lib/log.mjs';
import { readMarker, updateMarker } from '../../lib/markers.mjs';
import { deriveRunId, loadSessionMap } from '../../lib/runid.mjs';
import { spoolStats } from '../../lib/spool.mjs';

/**
 * The harness's hard stop, not a target. Everything here is local: two or three
 * `git rev-parse` calls (themselves capped at 2 s inside `lib/runid.mjs`) and a handful of
 * small reads and writes. The host awaits this hook before the next turn, so it stays tight.
 */
const BUDGET_MS = 2500;

/** The one stdout this hook ever produces. See the note on the dispatch switch above. */
const SUPPRESS = Object.freeze({ suppressOutput: true });

await runHook('cwd-changed', {
  budgetMs: BUDGET_MS,
  body: async (payload) => {
    const cfg = loadConfig();

    // No session id means no mapping to move. Deriving one anyway would write a
    // `SessionRecord` under a name nothing else will ever look up.
    const sessionId = str(payload?.session_id);
    if (!sessionId) return SUPPRESS;

    const prev = loadSessionMap(sessionId);
    const leaving = str(prev?.run_id);
    // Nothing mapped yet — a `cd` before SessionStart has landed, or after a wiped data dir.
    // There is no run to leave, and the next hook derives from the new directory anyway.
    if (!leaving) return SUPPRESS;

    // `new_cwd` is the authority. The common `cwd` comes from the host's own live getter and
    // has already moved by the time this fires, but reading the field the event exists to
    // carry beats depending on that.
    const moved = { ...payload, cwd: str(payload?.new_cwd) || str(payload?.cwd) };

    let entering = '';
    try {
      // This both derives and remaps: `lib/runid.mjs` owns `sessions/<id>.json` and writes
      // the whole `SessionRecord` back — new `project_dir`, new `project_root`, inherited
      // `clear_count` — whenever the mapping changes. A second write from here would only
      // be a chance to disagree with it.
      entering = deriveRunId(cfg, moved);
    } catch (err) {
      // `static` with no pin, or a derivation that could only have answered "default" (§4.3).
      log(cfg, 'warn', `cwd-changed: no usable run id (${messageOf(err)})`);
      return SUPPRESS;
    }

    // A `cd` within one repo, or any strategy a directory cannot move. Costing nothing here
    // is the point: this fires on every `cd` the session makes.
    if (entering === leaving) return SUPPRESS;

    drainLeavingRun(cfg, payload, leaving);
    markEnteredRun(cfg, leaving, entering);

    log(cfg, 'info', 'cwd-changed: the session moved to another run', {
      run_id: entering, previous_run_id: leaving,
    });
    return SUPPRESS;
  },
});

// ---------------------------------------------------------------------------
// The run being left
// ---------------------------------------------------------------------------

/**
 * Spawn the detached drain for the run the session is walking away from.
 *
 * `--run` is what makes this honest. The child is a fresh process that would otherwise call
 * `deriveRunId` itself, read the session map this hook has just rewritten, and drain the run
 * it was spawned to leave alone — a race with no ordering that fixes it, since the map has to
 * be rewritten either way.
 *
 * Gated on the spool actually having something in it: a `cd` between two repos in a session
 * that has captured nothing should not cost a node start.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} payload
 * @param {string} runId
 * @returns {void}
 */
function drainLeavingRun(cfg, payload, runId) {
  try {
    const { count } = spoolStats(cfg, runId);
    if (count <= 0) {
      log(cfg, 'debug', 'cwd-changed: nothing spooled for the run being left', { run_id: runId });
      return;
    }
    // §4.9: the payload travels by file, not by inherited stdin — a detached child's stdin is
    // not reliably readable once this process exits.
    spawnDetached(cfg, 'drain', ['--run', runId], stashPayload(cfg, payload));
    log(cfg, 'debug', 'cwd-changed: draining the run being left', { run_id: runId, count });
  } catch (err) {
    // The items stay spooled. They are drained if the user walks back into that repo, and
    // otherwise swept by §7's TTL — the same outcome as before this hook existed.
    log(cfg, 'warn', `cwd-changed: could not drain the run being left (${messageOf(err)})`,
      { run_id: runId });
  }
}

// ---------------------------------------------------------------------------
// The run being entered
// ---------------------------------------------------------------------------

/**
 * §4.8: stamp a marker for the new run.
 *
 * `bin/statusline.mjs` resolves the run from the session map on every frame and renders `''`
 * when `updated_at` is 0 — its way of saying "no hook has run here yet". Without this write
 * the status line goes blank on every `cd` into a new repo and stays blank until the next
 * prompt, which reads as the plugin having died rather than as the session having moved.
 *
 * `state` and `cold_start_until` are carried across because they describe the *endpoint*,
 * not the run: re-deriving them would show `unknown` for a connection that is fine.
 *
 * @param {Record<string, any>} cfg
 * @param {string} leaving
 * @param {string} entering
 * @returns {void}
 */
function markEnteredRun(cfg, leaving, entering) {
  try {
    const prev = readMarker(cfg, leaving);
    updateMarker(cfg, entering, {
      mode: str(cfg.mode) || 'local',
      ...(str(prev.state) ? { state: str(prev.state) } : {}),
      cold_start_until: numOr(prev.cold_start_until, 0),
      captured: { pending: spoolStats(cfg, entering).count },
    });
  } catch (err) {
    // §4.9: the status line is cosmetic; never fail a hook over it.
    log(cfg, 'debug', `cwd-changed: could not mark the new run (${messageOf(err)})`,
      { run_id: entering });
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

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
  if (err && typeof err === 'object' && typeof (/** @type {any} */ (err).message) === 'string') {
    return (/** @type {any} */ (err).message);
  }
  return String(err);
}
