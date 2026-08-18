#!/usr/bin/env node
// @ts-check
/**
 * `hooks/src/session-end.mjs` — SessionEnd (§5.7).
 *
 * ---------------------------------------------------------------------------
 * Why the reflect call at the end of this file is not optional
 * ---------------------------------------------------------------------------
 * Mubit extracts lessons on its own as it ingests, but those keep the scope they were
 * extracted at, and a `run`-scoped lesson is invisible to the next session. Widening scope is
 * reserved for the explicit reflect path. So **`POST /v2/control/reflect` here is the only
 * thing in the entire system that lets a lesson outlive the run that produced it** (§1.4). It
 * is required, not optional, and `MUBIT_CC_REFLECT_ON_END=0` is an opt-out that knowingly
 * costs cross-session durability.
 *
 * It is also not sufficient: a lesson still has to establish itself before it travels, and
 * rules never travel at all. This hook therefore reports a count and claims nothing — a marker
 * promising durability would be a lie the user only discovers two sessions later, when the
 * lesson is not there.
 *
 * ---------------------------------------------------------------------------
 * Order is the whole design
 * ---------------------------------------------------------------------------
 * ```
 * claimOnce → drain inline → flush outcome-pending turns → reflect → heartbeat idle
 *   → marker → pruneStale
 * ```
 *
 * **The drain commits before reflect is even attempted.** §1.4 says a session that ends
 * without reflecting loses scope promotion for that session's lessons — not the lessons
 * themselves — so a failing reflect may never be allowed to cost captures that were already
 * accepted. Outcomes go out before reflect for the opposite reason: `include_step_outcomes`
 * folds those signals into the evidence, and the negative ones produce the best lessons.
 *
 * The drain runs **inline, not detached**: the process is going away and a detached child
 * may be reaped before it finishes. It ignores the batch-size trigger — there is no "next
 * prompt" left to flush on.
 *
 * `claimOnce` guards the whole thing: SessionEnd can fire more than once (a `reason=exit`
 * after a `reason=clear`, a wrapper re-running the hook), and a double flush is a double
 * reflect. It returns **true when it fails to write** — proceeding on marker failure is
 * deliberate (§4.6): losing a session's captures is worse than sending them twice, and the
 * batch carries the same `idempotency_key` whichever drainer sends it, so the double send is
 * one the server can collapse.
 *
 * Best-effort throughout, and exit 0 always (§4.9). Anything still spooled is picked up by
 * the next session's first drain — the spool is keyed by `run_id`, not by session, so a
 * crashed session's captures survive.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { readBreaker } from '../../lib/breaker.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { ROUTES, heartbeat, postIngest, postOutcome, request } from '../../lib/http.mjs';
import { runHook } from '../../lib/hook.mjs';
import { log } from '../../lib/log.mjs';
import { readMarker, updateMarker } from '../../lib/markers.mjs';
import { deriveAgentId, deriveRunId } from '../../lib/runid.mjs';
import {
  acquireDrainLock, batchIdempotencyKey, claimOnce, commitBatch, readBatch, releaseDrainLock,
  spoolStats,
} from '../../lib/spool.mjs';
import {
  pruneStale, readJson, runDir, safeSegment, writeJsonAtomic,
} from '../../lib/state.mjs';

/**
 * §5.7 budgets. `hooks.json` allows this hook 8 s, so the internal deadline sits inside that
 * with room for the harness to still emit stdout and exit 0.
 */
const HARNESS_BUDGET_MS = 7200;
const BUDGET_MS = 6800;

/** §5.7 step 2: "until empty or 3500 ms elapse". */
const DRAIN_MS = 3500;
/** §5.7 step 4: the reflect is LLM-backed, so it gets the largest single slice. */
const REFLECT_MS = 4000;
const OUTCOME_MS = 1500;
const HEARTBEAT_MS = 1000;

/** §5.7: bounds the reflection to the recent tail (`control.proto`). */
const REFLECT_LAST_N = 200;

/** §7: `runs/<run_id>/jobs.json` keeps the last 20, for the doctor skill. */
const JOBS_KEEP = 20;

/** §5.5: the implicit signal is deliberately weak — a turn ending is not proof it helped. */
const SIGNAL_SUCCESS = 0.2;
const SIGNAL_FAILURE = -0.3;

/** The drain's bound, applied here too — this flush is the third sender of the same post. */
const MAX_OUTCOME_ATTEMPTS = 3;

/** §1.3: `reference_id` must be non-empty; the real attribution rides in `entry_ids[]`. */
const RUN_LEVEL_REFERENCE = 'global';

/** A dead session is not worth an unbounded scan of a six-hour turn directory. */
const MAX_TURN_FLUSH = 10;

/** The one stdout this hook ever produces (§5.7). */
const SUPPRESS = Object.freeze({ suppressOutput: true });

await runHook('session-end', {
  budgetMs: HARNESS_BUDGET_MS,
  body: async (payload, _hookCfg, ctx) => {
    const cfg = loadConfig();
    const started = numOr(ctx?.startedAt, Date.now());
    const deadline = started + BUDGET_MS;
    /** Whatever is left, capped at this section's slice, minus what later sections need. */
    const budgetFor = (sub, reserve = 0) => Math.max(0, Math.min(sub, deadline - Date.now() - reserve));

    let runId = '';
    let agentId = '';
    try {
      runId = deriveRunId(cfg, payload);
      agentId = deriveAgentId(payload);
    } catch (err) {
      // `static` with no pin, or a derivation that could only have answered "default" (§4.3).
      // The spool waits for a run id worth writing to; nothing here is lost.
      log(cfg, 'warn', `session-end: no usable run id (${messageOf(err)})`);
      return SUPPRESS;
    }

    // §5.7 step 1. `false` means another path already flushed this session.
    const sessionId = safeSegment(payload?.session_id) || 'nosession';
    if (!claimOnce(cfg, runId, `flushed-${sessionId}`)) {
      log(cfg, 'debug', 'session-end: this session was already flushed; standing down',
        { run_id: runId, session_id: sessionId });
      return SUPPRESS;
    }

    // §5.7 step 2 — inline, ignoring the batch-size trigger. Commits BEFORE anything below
    // can fail: a lost reflect costs scope promotion, never the captures themselves.
    const drained = await drainInline(cfg, {
      runId,
      agentId,
      sessionId,
      deadline: Math.min(deadline - (REFLECT_MS / 2), Date.now() + DRAIN_MS),
    });

    // §5.7 step 3 — a turn `capture --stop` left pending, attributed before reflect so the
    // reflection sees the outcome signals it folds in.
    const flushed = await flushOutcomes(cfg, {
      runId, agentId, budget: () => budgetFor(OUTCOME_MS, REFLECT_MS / 2),
    });

    // §5.7 step 4 — REQUIRED (§1.4), and skipped only on the two documented conditions.
    const priorIngested = numOr(readMarker(cfg, runId).captured?.ingested, 0);
    const reflect = await maybeReflect(cfg, {
      runId,
      budget: budgetFor(REFLECT_MS, HEARTBEAT_MS),
      // Evidence *in flight* counts. When another drainer holds the lock this hook defers to
      // it and reaches here before that drainer commits, so the marker's ingest count is stale
      // by design. The spool is the only term that sees the work that is about to land.
      anythingIngested: drained.sent > 0 || priorIngested > 0 || flushed > 0
        || spoolStats(cfg, runId).count > 0,
    });

    // §5.7 step 5 — the agent is not gone, it is idle; re-registering it next session is
    // noise the control plane reconciles.
    const beatBudget = budgetFor(HEARTBEAT_MS);
    if (beatBudget > 0) {
      const res = await heartbeat(cfg, { run_id: runId, agent_id: agentId, status: 'idle' },
        { timeoutMs: beatBudget });
      if (!res.ok) log(cfg, 'info', `session-end: idle heartbeat failed (${res.state})`, { run_id: runId });
    }

    // §5.7 step 6 — the marker is what the status line and the next session read.
    updateMarker(cfg, runId, {
      mode: cfg.mode,
      captured: { pending: spoolStats(cfg, runId).count },
      // Written unconditionally: a conditional block makes `status: ""` ambiguous between
      // "reflect was skipped" and "this hook never reached the marker write". After this, a
      // blank status means exactly the second — the hook was killed with its own work.
      reflect: { at: reflect.at, lessons_stored: reflect.lessons, status: reflect.status },
      ...(reflect.error ? { last_error: reflect.error.slice(0, 200) } : {}),
    });

    // §7's TTL sweep runs only from here and from `drain.mjs` — never on a blocking hook's
    // critical path — and is itself gated to at most once an hour.
    try { pruneStale(cfg); } catch { /* a sweep is never worth a failure */ }

    return SUPPRESS;
  },
});

// ---------------------------------------------------------------------------
// §5.7 step 2 — the inline drain
// ---------------------------------------------------------------------------

/**
 * One drainer at a time, one request per batch, and files unlinked only after a 2xx —
 * the same contract as `drain.mjs`, run in this process because a detached child may be
 * reaped when the session ends.
 *
 * A failure stops the loop and leaves every spool file exactly where it is. Quarantine of a
 * genuinely bad payload is deliberately NOT duplicated here: `drain.mjs` owns the three-way
 * error split (§5.5), and the next session's first drain applies it. A second copy of that
 * logic in a hook nobody is waiting on is how the two drift apart.
 *
 * @param {Record<string, any>} cfg
 * @param {{runId: string, agentId: string, sessionId: string, deadline: number}} o
 * @returns {Promise<{sent: number, batches: number}>}
 */
async function drainInline(cfg, o) {
  let sent = 0;
  let batches = 0;

  const lock = acquireDrainLock(cfg, o.runId);
  if (!lock) {
    // A detached drain from `capture --stop` is mid-flight. It will finish the work; racing
    // it would double-send the same batch and race the unlink.
    log(cfg, 'debug', 'session-end: another drainer holds the lock; leaving the spool to it',
      { run_id: o.runId });
    return { sent, batches };
  }

  try {
    const max = intOr(cfg.batchMaxItems, 32);
    for (let seq = 0; ; seq++) {
      if (Date.now() >= o.deadline) {
        log(cfg, 'info', 'session-end: drain budget spent; the rest waits for the next session',
          { run_id: o.runId, pending: spoolStats(cfg, o.runId).count });
        break;
      }
      // A pure read: `request()` consults `allowRequest` itself, and consulting it twice
      // would spend the single half-open probe the dial is entitled to.
      if (breakerOpen(cfg)) {
        log(cfg, 'debug', 'session-end: breaker open; items stay spooled', { run_id: o.runId });
        break;
      }

      const batch = readBatch(cfg, o.runId, max);
      if (batch.length === 0) break;

      const items = batch.map((e) => e.item).filter((it) => !!it && typeof it === 'object');
      if (items.length === 0) { commitBatch(batch); continue; }

      const res = await postIngest(cfg, {
        run_id: o.runId,
        agent_id: o.agentId,
        idempotency_key: batchIdempotencyKey(o.runId, items),
        parallel: true,
        items,
        ...(str(cfg.userId) ? { user_id: str(cfg.userId) } : {}),
      }, { timeoutMs: Math.max(1, Math.min(intOr(cfg.timeoutMs, 4000), o.deadline - Date.now())) });

      batches++;
      if (!res.ok) {
        log(cfg, 'warn', `session-end: ingest failed (${res.state}); items stay spooled`, {
          run_id: o.runId, status: res.status ?? 0, error: str(res.error).slice(0, 300),
        });
        break;
      }

      // §5.5 step 6: `status: "queued"` means accepted, not durable — nothing here waits on
      // the job; `runs/<run_id>/jobs.json` is how the doctor skill gets back to it.
      commitBatch(batch);
      sent += batch.length;
      recordJob(cfg, o.runId, res.body, batch.length);
    }
  } catch (err) {
    log(cfg, 'warn', `session-end: drain stopped (${messageOf(err)})`, { run_id: o.runId });
  } finally {
    // Released on every path: a stuck `drain.lock` silently stops all capture for the length
    // of its 60 s TTL, which is far worse than the rare double drain the key absorbs.
    releaseDrainLock(lock);
  }

  if (sent > 0) {
    const prev = readMarker(cfg, o.runId);
    updateMarker(cfg, o.runId, {
      state: 'ready',
      last_error: '',
      captured: {
        ingested: numOr(prev.captured?.ingested, 0) + sent,
        pending: spoolStats(cfg, o.runId).count,
      },
    });
  }
  return { sent, batches };
}

/**
 * §7/§15.4: an ingest that answered `queued` has been accepted, not stored; this array is
 * the only way back to the job.
 * @param {Record<string, any>} cfg @param {string} runId @param {any} body @param {number} n
 */
function recordJob(cfg, runId, body, n) {
  try {
    const jobId = str(body?.job_id);
    if (!jobId) return;
    const p = join(runDir(cfg, runId), 'jobs.json');
    const prev = readJson(p, []);
    const arr = Array.isArray(prev) ? prev.filter((e) => !!e && typeof e === 'object') : [];
    arr.push({
      job_id: jobId,
      at: Date.now(),
      items: n,
      status: str(body?.status),
      deduplicated: body?.deduplicated === true,
    });
    writeJsonAtomic(p, arr.slice(-JOBS_KEEP));
  } catch {
    // §4.9: a full or read-only data dir costs the job record, never the flush.
  }
}

// ---------------------------------------------------------------------------
// §5.7 step 3 — outcomes left pending
// ---------------------------------------------------------------------------

/**
 * A turn that `capture --stop` marked `outcome_pending` but whose drain never got to
 * attribute it — the drainer stood down, the endpoint was down, the session ended first.
 *
 * Never sent with an empty `entry_ids[]`: an outcome attributed to nothing is a wasted round
 * trip that also pollutes the run-level signal history the reflect path is about to read.
 * `outcomeMode: "off"` disables implicit attribution entirely, and `"explicit"` hands the
 * call to the model through `mubit_outcome` — firing one here as well would dilute the
 * model's deliberate judgement with an automatic 0.2.
 *
 * @param {Record<string, any>} cfg
 * @param {{runId: string, agentId: string, budget: () => number}} o
 * @returns {Promise<number>} how many outcomes were accepted
 */
async function flushOutcomes(cfg, o) {
  const mode = str(cfg.outcomeMode) || 'implicit';
  if (mode !== 'implicit') return 0;

  let flushed = 0;
  try {
    const dir = join(runDir(cfg, o.runId), 'turns');
    /** @type {string[]} */
    let names = [];
    try { names = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return 0; }

    for (const name of names.slice(0, MAX_TURN_FLUSH)) {
      const budget = o.budget();
      if (budget <= 0) break;

      const p = join(dir, name);
      const turn = readJson(p, null);
      if (!isObject(turn)) continue;
      if (turn.outcome_pending !== true) continue;
      if (numOr(turn.outcome_sent_at, 0) > 0) continue;

      const entryIds = Array.isArray(turn.recalled)
        ? turn.recalled.filter((v) => typeof v === 'string' && v.trim())
        : [];
      if (entryIds.length === 0) continue;

      const promptId = str(turn.prompt_id) || name.replace(/\.json$/, '');

      // Same bound the drain applies, for the same reason: a post the server accepted but
      // answered too late leaves the turn pending, and this flush is the third place that
      // would send it again. Counted in the file, before dialling.
      const attempts = numOr(turn.outcome_attempts, 0);
      if (attempts >= MAX_OUTCOME_ATTEMPTS) {
        writeJsonAtomic(p, { ...turn, outcome_pending: false, outcome_abandoned: true });
        log(cfg, 'info', `session-end: outcome abandoned after ${attempts} attempts`,
          { run_id: o.runId, prompt_id: promptId });
        continue;
      }
      writeJsonAtomic(p, { ...turn, outcome_attempts: attempts + 1 });

      const failed = str(turn.outcome).toLowerCase() === 'failure';

      const res = await postOutcome(cfg, {
        run_id: o.runId,
        reference_id: RUN_LEVEL_REFERENCE,
        outcome: failed ? 'failure' : 'success',
        signal: failed ? SIGNAL_FAILURE : SIGNAL_SUCCESS,
        rationale: failed
          ? 'Claude Code turn ended in failure after these memories were injected.'
          : 'Claude Code turn completed after these memories were injected.',
        agent_id: o.agentId,
        entry_ids: entryIds,
        // Derived from (run_id, prompt_id) and never random, so this and a concurrent drain
        // post the same key: the server's outcome ledger then makes the second one a no-op.
        idempotency_key: `cc-outcome-${o.runId}-${promptId}`,
      }, { timeoutMs: budget });

      if (res.ok) {
        flushed++;
        writeJsonAtomic(p, {
          ...turn, outcome_attempts: attempts + 1, outcome_pending: false, outcome_sent_at: Date.now(),
        });
      } else {
        // Left pending on purpose: the next session's drain re-posts it under the same key,
        // up to the attempt bound above.
        log(cfg, 'info', `session-end: outcome flush failed (${res.state})`,
          { run_id: o.runId, prompt_id: promptId });
      }
    }
  } catch (err) {
    log(cfg, 'warn', `session-end: outcome flush skipped — ${messageOf(err)}`, { run_id: o.runId });
  }
  return flushed;
}

// ---------------------------------------------------------------------------
// §5.7 step 4 — the reflect
// ---------------------------------------------------------------------------

/**
 * `POST /v2/control/reflect`, the only call that can widen a lesson's scope past `run`
 * (§1.4). Skipped on exactly two conditions, both documented: `MUBIT_CC_REFLECT_ON_END=0`,
 * and nothing having been ingested — an LLM-backed call over an empty tail is pure cost.
 *
 * A failure is logged and recorded as `reflect: failed`, never surfaced as a blocking error.
 *
 * Every exit stamps a `status`, so the marker can tell the skip reasons apart:
 * `skipped:disabled`, `skipped:not-ingested`, `failed`, `ok`. A blank status in a written
 * marker is therefore impossible — it means the hook died before the marker write.
 *
 * @param {Record<string, any>} cfg
 * @param {{runId: string, budget: number, anythingIngested: boolean}} o
 * @returns {Promise<{attempted: boolean, status: string, lessons: number, at: number, error: string}>}
 */
async function maybeReflect(cfg, o) {
  const idle = { attempted: false, status: 'skipped', lessons: 0, at: 0, error: '' };

  if (cfg.reflectOnEnd === false) {
    log(cfg, 'info', 'session-end: reflect disabled by MUBIT_CC_REFLECT_ON_END=0 — this session\'s '
      + 'lessons stay at run scope', { run_id: o.runId });
    return { ...idle, at: Date.now(), status: 'skipped:disabled' };
  }
  if (!o.anythingIngested) {
    log(cfg, 'debug', 'session-end: nothing ingested this session; nothing to reflect on',
      { run_id: o.runId });
    return { ...idle, at: Date.now(), status: 'skipped:not-ingested' };
  }
  if (o.budget <= 0) {
    log(cfg, 'warn', 'session-end: no budget left for reflect; this session\'s lessons stay at run scope',
      { run_id: o.runId });
    return { ...idle, attempted: true, status: 'failed', at: Date.now(), error: 'reflect budget exhausted' };
  }

  const res = await request(cfg, 'POST', ROUTES.reflect, {
    run_id: o.runId,
    include_linked_runs: false,
    // `include_step_outcomes` folds outcome signals into the evidence
    // (`control.proto`) — the NEGATIVE ones produce the highest-value lessons.
    include_step_outcomes: true,
    last_n_items: REFLECT_LAST_N,
  }, { timeoutMs: o.budget });

  if (!res.ok) {
    log(cfg, 'warn', `session-end: reflect failed (${res.state}); this session's lessons stay at run scope`, {
      run_id: o.runId, status: res.status ?? 0, error: str(res.error).slice(0, 300),
    });
    return { attempted: true, status: 'failed', lessons: 0, at: Date.now(), error: str(res.error) };
  }

  const body = isObject(res.body) ? res.body : {};
  const stored = Number.isFinite(Number(body.lessons_stored))
    ? Math.max(0, Math.trunc(Number(body.lessons_stored)))
    : (Array.isArray(body.lessons) ? body.lessons.length : 0);

  log(cfg, 'info', `session-end: reflect stored ${stored} lesson(s)`, { run_id: o.runId });
  return { attempted: true, status: 'ok', lessons: stored, at: Date.now(), error: '' };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * §5.5 step 2, as a pure read. `allowRequest()` is not used here on purpose: while the
 * breaker is open it consumes the single half-open probe, and `lib/http.mjs` asks for it
 * again on the way to the socket.
 * @param {Record<string, any>} cfg
 * @returns {boolean}
 */
function breakerOpen(cfg) {
  try {
    const b = readBreaker(cfg);
    if (!(b.openedAt > 0)) return false;
    const cooldownMs = numOr(cfg?.breaker?.cooldownMs, 120_000);
    const since = Math.max(b.openedAt, numOr(b.probeAt, 0));
    return Date.now() - since < cooldownMs;
  } catch {
    // Fail open: a breaker that cannot be read must not stop the last flush of a session.
    return false;
  }
}

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
function intOr(v, d) {
  const n = numOr(v, NaN);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : d;
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
