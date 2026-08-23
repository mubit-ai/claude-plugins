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
 * The drain runs **inline within this body**, not as a further `spawnDetached('drain')`: one
 * hand-off is enough, and a second child would only race the first for the drain lock. It
 * ignores the batch-size trigger — there is no "next prompt" left to flush on.
 *
 * ---------------------------------------------------------------------------
 * ...and none of it runs in the process the host started
 * ---------------------------------------------------------------------------
 * The host does not promise this hook a chance to finish. Under `--print` Claude Code emits
 * its final result and tears the session down about a second in — a **cancellation**, not a
 * timeout, so no ceiling on either side of the boundary helps: a trial with
 * `SessionEnd.timeout: 30` was cancelled at the same ~1 s, four times out of four. Interactive
 * sessions are cancelled too, which is why runs that demonstrably stored lessons still read
 * `reflect: {at: 0, status: ""}` — the request went out and the hook was killed before it
 * could say so.
 *
 * So the ordered body above lives in a **detached child** (§4.9's `spawnDetached`, the same
 * mechanism `drain.mjs` already uses), and this process does exactly four things: stamp the
 * marker `handoff`, stash the payload, stamp it `detached`, spawn. The child is not on the
 * host's 8 s clock, because nothing is waiting on it.
 *
 * Two details are load-bearing:
 *
 *   - **The claim stays in the body, not in the parent.** A parent that claimed and then
 *     failed to spawn — or spawned a child that was reaped — would have burned the claim and
 *     taken the session's whole flush with it.
 *   - **The marker is stamped before the spawn**, so a fast child can only overwrite that
 *     stamp, never lose a race to it. The parent writes two non-terminal statuses and the
 *     child never writes either, which is what makes a marker left on one of them a specific,
 *     reportable failure rather than one more indistinguishable blank: `handoff` means the
 *     parent was killed before it could hand over or fall back — it dies inside the host's
 *     ~1 s window, so this is the common one — and `detached` means the hand-off completed
 *     and the child was reaped.
 *
 * `MUBIT_CC_SESSION_END_DETACH=0` runs the body here instead, for an environment that forbids
 * background processes; so does a hand-off that cannot be written. Neither drops the flush.
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

import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { readBreaker } from '../../lib/breaker.mjs';
import { host, loadConfig } from '../../lib/config.mjs';
import { ROUTES, heartbeat, postIngest, postOutcome, request } from '../../lib/http.mjs';
import { runHook, spawnDetached, stashPayload } from '../../lib/hook.mjs';
import { log } from '../../lib/log.mjs';
import { readMarker, updateMarker } from '../../lib/markers.mjs';
import { decideOutcome, implicitOutcomesEnabled, outcomeRequest } from '../../lib/outcome.mjs';
import { deriveAgentId, deriveRunId } from '../../lib/runid.mjs';
import {
  acquireDrainLock, batchIdempotencyKey, claimHeld, claimOnce, commitBatch, readBatch,
  releaseDrainLock, spoolStats,
} from '../../lib/spool.mjs';
import {
  pruneStale, readJson, runDir, safeSegment, writeJsonAtomic,
} from '../../lib/state.mjs';

/**
 * §5.7 budgets, in the two lifetimes this hook has.
 *
 * In the process the host started, `hooks.json` allows 8 s and the internal deadline sits
 * inside that with room to still emit stdout and exit 0 — though the hand-off spends
 * milliseconds of it. In the detached child the ceiling stops applying the moment nothing is
 * waiting on us, so the body gets `drain.mjs`-class headroom for an LLM-backed reflect.
 *
 * The detached numbers are sized for the reflect below rather than for tidiness: they have to
 * leave `REFLECT_MS` intact *after* a full `DRAIN_MS` and the heartbeat reserve, because these
 * three compose and the innermost one binds. `hooks.json`'s `SessionEnd.timeout: 8` is
 * unaffected — it binds the parent, and the parent is gone within milliseconds.
 */
const DETACHED = process.env.MUBIT_CC_DETACHED === '1';

/**
 * The inline ceiling is not the same number on both hosts.
 *
 * `hooks.json` asks for 8 s and Claude Code grants it. **Codex clamps SessionEnd to 3 s**
 * whatever the manifest says — recorded in `docs/harness-probe.md` §4, and `codex-oracle`
 * has the host itself reporting the timeout it will enforce. 6800 ms is 2.4x that, and the
 * sub-budgets nested inside it are each larger than the whole clamp (`REFLECT_MS` alone is
 * 4000), so the arithmetic that carves the deadline up hands the drain a window that has
 * already expired and the process is killed mid-reflect with the captures still on disk.
 *
 * Scaled rather than disabled, and scaled around the drain: a lost reflect costs scope
 * promotion, a lost drain costs the session. This binds only the `sessionEndDetach: false`
 * path — the default hands the whole body to a detached child that no host ceiling reaches,
 * which is precisely why it is the default on this host.
 */
const CODEX_INLINE = !DETACHED && host() === 'codex';
const HARNESS_BUDGET_MS = DETACHED ? 58_000 : (CODEX_INLINE ? 2500 : 7200);
const BUDGET_MS = DETACHED ? 55_000 : (CODEX_INLINE ? 2300 : 6800);

/** §5.7 step 2: "until empty or 3500 ms elapse" — or as much of that as the clamp allows. */
const DRAIN_MS = CODEX_INLINE ? 1100 : 3500;
/**
 * §5.7 step 4: the reflect is LLM-backed, so it gets the largest single slice — and inside a
 * detached child that slice is what the extra headroom above is *for*. Measured against a
 * hosted instance, 4000 ms is simply not enough: the first `--print` session ever to reach
 * this call recorded `POST /v2/control/reflect: aborted after 4000ms`. The inline value is
 * left exactly where it was, because there the host's 8 s ceiling still decides.
 *
 * 8000 ms was not enough either, and for the same reason one step out: a Terminal-Bench sweep
 * put the *successful* hosted tail at 9626 ms, so the detached child was aborting calls the
 * server was still answering. It now dials wide enough that the LLM, not the client, decides
 * when to give up — which is also why this call opts out of the breaker (see the call site).
 */
const REFLECT_MS = DETACHED ? 45_000 : (CODEX_INLINE ? 700 : 4000);
const OUTCOME_MS = CODEX_INLINE ? 400 : 1500;
const HEARTBEAT_MS = CODEX_INLINE ? 300 : 1000;

/** §7: `runs/<run_id>/jobs.json` keeps the last 20, for the doctor skill. */
const JOBS_KEEP = 20;

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

    // Before anything else, and before the claim: hand the whole body to a process the host
    // does not own. Everything below this line is what the child then runs, unchanged.
    if (!ctx?.detached && cfg.sessionEndDetach !== false && handOff(cfg, payload, runId)) {
      return SUPPRESS;
    }

    // §5.7 step 1, split into two halves: the claim is READ here and RECORDED after the work
    // it claims, at the end of this body.
    //
    // It used to be a single `claimOnce` on this line, which marked the session flushed before
    // the drain, the outcome flush and the reflect had happened. Under Codex this hook is
    // killed at a 3-second ceiling, so a session could be marked flushed with none of it done
    // — and the marker is exactly what makes every later attempt stand down, so nothing ever
    // retried. The user lost the captures *and* the reflect, which is the only path that
    // promotes a lesson beyond its own run.
    const sessionId = safeSegment(payload?.session_id) || 'nosession';
    const claim = `flushed-${sessionId}`;
    if (claimHeld(cfg, runId, claim)) {
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

    // §5.7 step 4 — REQUIRED (§1.4), and skipped only on the documented conditions.
    const priorIngested = numOr(readMarker(cfg, runId).captured?.ingested, 0);
    const pending = spoolStats(cfg, runId).count;
    const reflect = await maybeReflect(cfg, {
      runId,
      budget: budgetFor(REFLECT_MS, HEARTBEAT_MS),
      // Evidence *in flight* counts. When another drainer holds the lock this hook defers to
      // it and reaches here before that drainer commits, so the marker's ingest count is stale
      // by design. The spool is the only term that sees the work that is about to land.
      anythingIngested: drained.sent > 0 || priorIngested > 0 || flushed > 0
        || (drained.deferred && pending > 0),
      // ...but a non-empty spool means the opposite when *our* drain is the one that stopped:
      // budget spent, breaker open, or an ingest that failed. Then nobody is about to land
      // it, and reflecting would draw conclusions from a session the server only half has.
      undelivered: drained.failed && pending > 0,
      pending,
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

    // §5.7 step 1, second half. The work above is done, so record the claim that says so —
    // and only now. A hook killed anywhere above this line leaves no marker, which is what
    // lets the next SessionEnd, or a later drain, pick the session up instead of standing
    // down in front of work that never happened.
    claimOnce(cfg, runId, claim);

    // §7's TTL sweep runs only from here and from `drain.mjs` — never on a blocking hook's
    // critical path — and is itself gated to at most once an hour.
    try { pruneStale(cfg); } catch { /* a sweep is never worth a failure */ }

    return SUPPRESS;
  },
});

// ---------------------------------------------------------------------------
// The hand-off
// ---------------------------------------------------------------------------

/**
 * Stash the payload, stamp the marker, spawn, and report whether the child owns the flush.
 *
 * `spawnDetached` (§4.9) is re-used rather than reinvented: `detached: true`, `stdio:
 * 'ignore'`, `unref()`, and the payload handed over by file because a detached child's
 * inherited stdin is not reliably readable once the parent exits — and the parent exits
 * within milliseconds, which is the entire point. `'session-end'` resolves as a sibling of
 * `argv[1]` first, so the same call works from `hooks/src` and from the shipped `hooks/dist`.
 *
 * **Every failure here returns `false`, and false means "run the body yourself".** Losing a
 * session's flush is the failure this whole path exists to stop; an unwritable `tmp/` is not
 * a reason to reintroduce it.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} payload
 * @param {string} runId
 * @returns {boolean} true when the child owns the flush and this process is done
 */
function handOff(cfg, payload, runId) {
  // Before the first byte of work, so a blank status keeps meaning exactly one thing. The
  // stash below runs inside the host's ~1 s kill window: a parent killed there would otherwise
  // leave the marker at its creation default, indistinguishable from a session where this hook
  // never fired at all. A fallback to the inline body leaves this standing until the body
  // writes a terminal status, which is correct — that run is not detached.
  updateMarker(cfg, runId, { reflect: { at: 0, lessons_stored: 0, status: 'handoff' } });

  const path = stashPayload(cfg, payload);
  if (!path) {
    log(cfg, 'info', 'session-end: no handoff file could be written; flushing inline instead',
      { run_id: runId });
    return false;
  }

  // Stamped BEFORE the spawn, so a fast child can only overwrite this, never lose to it.
  // The second and last of the parent's writes, and like `handoff` above it is never
  // terminal: a marker still reading it later means the child never reported.
  updateMarker(cfg, runId, { reflect: { at: 0, lessons_stored: 0, status: 'detached' } });

  const child = spawnDetached(cfg, 'session-end', [], path);
  if (!child) {
    try { unlinkSync(path); } catch { /* §7's tmp sweep gets it */ }
    log(cfg, 'info', 'session-end: could not spawn the flush; running it inline instead',
      { run_id: runId });
    return false;
  }

  log(cfg, 'debug', 'session-end: flushing in a detached child', { run_id: runId, pid: child.pid });
  return true;
}

// ---------------------------------------------------------------------------
// §5.7 step 2 — the inline drain
// ---------------------------------------------------------------------------

/**
 * One drainer at a time, one request per batch, and files unlinked only after a 2xx —
 * the same contract as `drain.mjs`, run in this body rather than handed to yet another
 * child: the body is already in one, and a second would only race the first for the lock.
 *
 * A failure stops the loop and leaves every spool file exactly where it is. Quarantine of a
 * genuinely bad payload is deliberately NOT duplicated here: `drain.mjs` owns the three-way
 * error split (§5.5), and the next session's first drain applies it. A second copy of that
 * logic in a hook nobody is waiting on is how the two drift apart.
 *
 * It reports *how* it ended, not just how much it sent. "The spool is not empty" has two
 * opposite meanings — another drainer is about to land this work, or nobody is — and step 4
 * has to tell them apart before deciding whether there is anything worth reflecting on.
 *
 * @param {Record<string, any>} cfg
 * @param {{runId: string, agentId: string, sessionId: string, deadline: number}} o
 * @returns {Promise<{sent: number, batches: number, deferred: boolean, failed: boolean}>}
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
    return { sent, batches, deferred: true, failed: false };
  }

  let failed = false;

  try {
    const max = intOr(cfg.batchMaxItems, 32);
    for (let seq = 0; ; seq++) {
      if (Date.now() >= o.deadline) {
        log(cfg, 'info', 'session-end: drain budget spent; the rest waits for the next session',
          { run_id: o.runId, pending: spoolStats(cfg, o.runId).count });
        failed = true;
        break;
      }
      // A pure read: `request()` consults `allowRequest` itself, and consulting it twice
      // would spend the single half-open probe the dial is entitled to.
      if (breakerOpen(cfg)) {
        log(cfg, 'debug', 'session-end: breaker open; items stay spooled', { run_id: o.runId });
        failed = true;
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
        failed = true;
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
  return { sent, batches, deferred: false, failed };
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
 * **The rule is `lib/outcome.mjs`'s, not this hook's.** `drain.mjs` (§5.5 step 7) is its other
 * caller, and because the two hooks never fire for the same turn, a disagreement between them
 * is invisible: it shows up only as a run whose outcome series mixes two definitions of the
 * same measurement. That is exactly what happened while this function kept its own copy — it
 * posted `success`/+0.2 with `entry_ids` for every pending turn, including the ones the drain
 * had learned to record as `neutral` with none.
 *
 * So `decideOutcome` answers what to post (including "nothing", for a turn that recalled
 * nothing — an outcome attributed to nothing is a wasted round trip that also pollutes the
 * run-level signal history the reflect path is about to read), `outcomeRequest` addresses it,
 * and what stays here is what a SessionEnd flush owns: which files to consider, the budget,
 * and leaving a failure pending.
 *
 * @param {Record<string, any>} cfg
 * @param {{runId: string, agentId: string, budget: () => number}} o
 * @returns {Promise<number>} how many outcomes were accepted
 */
async function flushOutcomes(cfg, o) {
  // §6.1: "off" disables implicit attribution entirely, and "explicit" hands the call to the
  // model through `mubit_outcome` — firing one here as well would dilute the model's
  // deliberate judgement with an automatic 0.2.
  if (!implicitOutcomesEnabled(cfg)) return 0;

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
      // This hook sweeps a directory rather than being handed one turn, so `outcome_pending`
      // is the filter that says which files are even candidates: a turn `capture --stop` has
      // not closed yet is still being written.
      if (!isObject(turn) || turn.outcome_pending !== true) continue;

      const decision = decideOutcome(turn);
      if (!decision.post) {
        // Nothing is going to send this one; stop claiming it is pending.
        if (decision.reason === 'attempts_exhausted') {
          writeJsonAtomic(p, { ...turn, outcome_pending: false, outcome_abandoned: true });
        }
        continue;
      }

      const promptId = str(turn.prompt_id) || name.replace(/\.json$/, '');

      // The same bound the drain applies, for the same reason: this flush is the third place
      // that would send the same post. Counted before dialling, in the file.
      const attempts = numOr(turn.outcome_attempts, 0);
      writeJsonAtomic(p, { ...turn, outcome_attempts: attempts + 1 });

      const res = await postOutcome(cfg,
        outcomeRequest({ runId: o.runId, agentId: o.agentId, promptId, decision }),
        { timeoutMs: budget });

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
 * `skipped:disabled`, `skipped:not-ingested`, `skipped:undrained`, `failed`, `ok`. A blank
 * status in a written marker is therefore impossible — it means the hook died before the
 * marker write.
 *
 * @param {Record<string, any>} cfg
 * @param {{runId: string, budget: number, anythingIngested: boolean, undelivered?: boolean,
 *          pending?: number}} o
 * @returns {Promise<{attempted: boolean, status: string, lessons: number, at: number, error: string}>}
 */
async function maybeReflect(cfg, o) {
  const idle = { attempted: false, status: 'skipped', lessons: 0, at: 0, error: '' };

  if (cfg.reflectOnEnd === false) {
    log(cfg, 'info', 'session-end: reflect disabled by MUBIT_CC_REFLECT_ON_END=0 — this session\'s '
      + 'lessons stay at run scope', { run_id: o.runId });
    return { ...idle, at: Date.now(), status: 'skipped:disabled' };
  }
  if (o.undelivered) {
    // Reflection reads the server's tail. Ours did not get there — this drain stopped with
    // items still spooled and no other drainer holding the lock — so a reflection now would
    // be drawn from a partial session and stored as if it were the whole one. The next
    // session drains the rest and can reflect over a run the server actually has.
    log(cfg, 'info', 'session-end: the spool did not drain; leaving reflect to the next session',
      { run_id: o.runId, pending: o.pending ?? 0 });
    return { ...idle, at: Date.now(), status: 'skipped:undrained' };
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
    // No `last_n_items`. The field bounds the request to a tail of the run, and nothing in
    // the contract says that tail is the session this hook just watched — so bounding it
    // risks spending the one reflect a session gets on evidence that is not this session's.
    // This call already dials wide (`REFLECT_MS`); the bound bought no headroom worth that.
    // `record: false`, because a deadline this client chose is not evidence about the server.
    // `lib/http.mjs` already exempts callers who dial *tighter* than the configured default;
    // this one is the mirror image and the exemption misses it — the reflect is LLM-backed
    // and dials deliberately wide, so its abort would be filed as `not_responding` against an
    // instance that was still composing an answer. Five of those inside the window open the
    // breaker, and the breaker gates the ingest *drain*: a merely slow reflection would
    // escalate into capture stopping altogether. Opting out here rather than widening the
    // exemption in `http.mjs` keeps it to the one caller that has earned it — a future
    // wide-dialing caller should have to say so itself. The cost is that a *successful*
    // reflect no longer records one either; the drain above and the idle heartbeat below
    // still give the breaker real transport verdicts on every session end.
  }, { timeoutMs: o.budget, record: false });

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
