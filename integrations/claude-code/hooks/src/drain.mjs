#!/usr/bin/env node
// @ts-check
/**
 * `hooks/src/drain.mjs` — the detached drainer (§5.5).
 *
 * The only thing in the write path that touches the network, and the only caller in the
 * whole plugin that ever asks `lib/http.mjs` for `{retry: true}` — it is detached and
 * nobody is waiting on it, so one extra dial after a transport timeout costs nothing.
 *
 * Not registered in `hooks.json`. It is spawned only by `stage-prompt`, `capture --stop`,
 * `session-end` or `cwd-changed`, which is what keeps the per-tool-call hot path free of
 * node's startup cost a second time. The last of those passes `--run <id>`: it drains the
 * run a session has just walked away from, and a child that re-derived would read the
 * session map that hook is in the middle of rewriting. Nothing waits on it, so everything here must be safe to abandon:
 * one drainer at a time, one request per batch, and a spool that is only ever unlinked
 * after a 2xx.
 *
 * ```
 * acquireDrainLock → breaker check → readBatch(32) → POST /v2/control/ingest
 *   → 2xx      : commitBatch (unlink), marker.captured += n, push job_id into jobs.json
 *   → 5xx/net  : the batch is still good — LEAVE every spool file in place, stop
 *   → other 4xx: the payload is bad, not the server — quarantine in spool/rejected/
 *   → loop while items remain and elapsed < 10s → releaseDrainLock
 * ```
 *
 * **The three-way error split is the entire design.** A 5xx is the server's problem and the
 * batch is still good, so it is kept and retried next time. A 422 means the *payload* is
 * bad; retrying it forever is exactly how a spool becomes unbounded, so it is quarantined
 * and never retried. 408 and 429 are the two 4xx that stay retryable — and so, deliberately,
 * are 401/403/404: a user who has not pasted an API key yet, or a proxy that has not been
 * pointed at a Mubit build with these routes, must not have their memory deleted for it.
 *
 * **The lock is released on every exit path** — the breaker short-circuit, a throw after the
 * send, the hard stop — because a stuck `drain.lock` silently stops all capture for the
 * length of its 60 s TTL, which is far worse than the rare double drain that the per-batch
 * `idempotency_key` covers — it is content-addressed on `(run_id, item ids)`, so the same
 * items carry the same key whichever drainer sends them (`lib/spool.mjs`). The one
 * exception: a drainer that *lost* the race never deletes the winner's lock.
 *
 * Constraints, shared with the rest of the plugin: zero dependencies, Node >= 20 built-ins,
 * and **exit code 0, always** (§4.9). A memory layer has no business breaking a prompt.
 */

import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { readBreaker } from '../../lib/breaker.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { postIngest, postOutcome } from '../../lib/http.mjs';
import { log } from '../../lib/log.mjs';
import { readMarker, updateMarker } from '../../lib/markers.mjs';
import { decideOutcome, implicitOutcomesEnabled, outcomeRequest } from '../../lib/outcome.mjs';
import { deriveAgentId, deriveRunId, turnKey } from '../../lib/runid.mjs';
import {
  acquireDrainLock, batchIdempotencyKey, commitBatch, readBatch, releaseDrainLock, spoolStats,
} from '../../lib/spool.mjs';
import {
  ensureDir, pruneStale, readJson, runDir, safeSegment, writeJsonAtomic,
} from '../../lib/state.mjs';

/** §5.5: "Budget 10 s soft" — nothing waits on it, but it still bounds itself. */
const BUDGET_MS = 10_000;

/** The hard stop, for the case the soft budget cannot be reached (a wedged socket). */
const HARD_STOP_MS = 12_000;

/** §7: `runs/<run_id>/jobs.json` keeps the last 20, for the doctor skill. */
const JOBS_KEEP = 20;

/**
 * How long to wait before confirming we still own the lock we were just handed.
 *
 * `acquireDrainLock` creates `drain.lock` with `O_EXCL` and *then* writes the owning pid, so
 * for a few microseconds the file exists and is empty. A second drainer arriving inside that
 * window reads an unparseable lock, correctly concludes "this cannot be attributed to a
 * living drainer", steals it — and now two drainers each believe they hold it and send the
 * same batch twice. Two hooks firing a detached drain milliseconds apart is the ordinary
 * case, not the exotic one, and with a warm config cache they run in near-perfect lockstep.
 *
 * A steal always finishes by writing the stealer's own pid, so the loser can see it happened.
 * 20 ms is far longer than the window and invisible on a path nobody waits for.
 */
const LOCK_CONFIRM_MS = 20;

/**
 * How long a drain carrying `--with-outcome` waits for a lock another drainer holds, before
 * giving up and leaving the turn for SessionEnd. See `acquireConfirmed`.
 *
 * Long enough to outlast the detached drain `capture --stop` spawns just ahead of it — one
 * batch post plus an outcome — and short enough that a wedged sibling does not keep a hook
 * process alive. It is a floor, not a schedule: the wait ends the moment the lock frees.
 */
const OUTCOME_LOCK_WAIT_MS = 2_000;

/** How often to re-try the lock while waiting. */
const LOCK_POLL_MS = 25;

/** §6.1 `MUBIT_CC_BATCH_MAX_ITEMS`, used when a config could not be resolved. */
const DEFAULT_BATCH = 32;

/**
 * The 4xx that are NOT a verdict on the payload.
 *
 * 408/429 are the two §5.5 names outright: a timeout and backpressure both mean "ask again".
 * 401/403 are here because quarantining on them would delete a user's memory over a missing
 * `MUBIT_API_KEY` — the one error they can fix in ten seconds — and 404 because a proxy or an
 * older instance without these routes is a deployment problem, not a bad batch. Everything
 * else in the 4xx range (400, 413, 415, 422, …) describes *this* payload and can never
 * succeed on a retry.
 */
const RETRYABLE_4XX = new Set([401, 403, 404, 408, 429]);

// ---------------------------------------------------------------------------
// Process-wide state, so every exit path can let go of the lock
// ---------------------------------------------------------------------------

/** @type {Record<string, any>} */
let cfgRef = {};
/** @type {import('../../lib/spool.mjs').DrainLock|null} */
let heldLock = null;
/** The `--payload` handoff file this process consumed, unlinked when it is done. */
let payloadFile = '';

/** Release everything this process is holding. Idempotent; never throws. */
function letGo() {
  try {
    if (heldLock) releaseDrainLock(heldLock);
  } catch { /* already released, or stolen past the TTL */ }
  heldLock = null;
  if (payloadFile) {
    try { unlinkSync(payloadFile); } catch { /* the §7 tmp sweep will get it */ }
    payloadFile = '';
  }
}

// §4.9: "This plugin never exits 2 and never exits non-zero." Not even on a bug of ours.
process.on('uncaughtException', (err) => {
  try { log(cfgRef, 'error', `drain: uncaught ${messageOf(err)}`); } catch { /* nothing left */ }
  letGo();
  process.exitCode = 0;
});
process.on('unhandledRejection', (err) => {
  try { log(cfgRef, 'error', `drain: unhandled rejection ${messageOf(err)}`); } catch { /* … */ }
  letGo();
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  const argv = process.argv.slice(2);
  const payloadPath = flagValue(argv, '--payload');
  const outcomeArg = flagValue(argv, '--with-outcome');
  const wantsOutcome = argv.includes('--with-outcome');
  const pinnedRun = flagValue(argv, '--run');

  // Invoked two ways: with the payload on stdin (foreground, as the tests do) and with
  // `--payload <file>` (detached — a detached child's inherited stdin is not reliably
  // readable once the parent has exited, §4.9).
  const payload = await readPayload(payloadPath);

  const cfg = loadConfig(process.env);
  cfgRef = cfg;

  let runId = '';
  if (pinnedRun) {
    // `--run <id>`: drain THIS run, whatever this process would have derived.
    //
    // `cwd-changed` spawns a drain for the run a session is walking away from and then
    // rewrites `sessions/<host_session_id>.json` to name the new one. A child that
    // re-derived would read whichever version of that file it won the race against, and
    // would drain the run it was spawned to leave alone. The flag removes the race rather
    // than making it unlikely.
    //
    // It is still checked: a run id names a directory under the data dir as well as a run,
    // and `"default"` is the value that collapses every user and project into one shared
    // run (§4.3). An unusable pin drains nothing — the spool waits.
    runId = usableRunId(pinnedRun);
    if (!runId) {
      log(cfg, 'error', `drain: refusing the pinned run id ${JSON.stringify(pinnedRun)}`);
      return;
    }
  } else {
    try {
      runId = deriveRunId(cfg, payload);
    } catch (err) {
      // `static` with no pin, or a derivation that could only have answered "default".
      // Refusing is the honest answer; the spool waits for a run id worth writing to (§4.3).
      log(cfg, 'error', `drain: no usable run id — ${messageOf(err)}`);
      return;
    }
  }

  const agentId = deriveAgentId(payload);
  const promptId = str(outcomeArg) || turnKey(payload);

  // §5.5 step 1: exactly one drainer per run.
  const lock = await acquireConfirmed(cfg, runId, wantsOutcome, started);
  if (!lock) {
    log(cfg, 'debug', 'drain: another drainer holds the lock; standing down', { run_id: runId });
    return;
  }

  // Belt and braces around the soft budget: a socket that never settles would otherwise
  // hold the lock for its full 60 s TTL and stall every later drain.
  const hardStop = setTimeout(() => {
    try { log(cfg, 'warn', 'drain: hard stop, releasing the lock', { run_id: runId }); } catch { /* … */ }
    letGo();
    process.exit(0);
  }, HARD_STOP_MS);
  if (typeof hardStop.unref === 'function') hardStop.unref();

  try {
    const drained = await drainSpool(cfg, runId, agentId, promptId, started);

    // §5.5 step 7.
    await flushOutcome(cfg, runId, agentId, promptId, wantsOutcome);

    log(cfg, 'info', `drain: ${drained.sent} item(s) in ${drained.batches} batch(es)`, {
      run_id: runId, rejected: drained.rejected, ms: Date.now() - started,
    });
  } finally {
    clearTimeout(hardStop);
    letGo();
  }

  // §7's TTL sweep runs only from here and from `session-end` — never on a blocking hook's
  // critical path — and is itself gated to at most once an hour.
  try { pruneStale(cfg); } catch { /* a sweep is never worth a failure */ }
}

// ---------------------------------------------------------------------------
// The drain loop — §5.5 steps 2-6, 8
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {string} agentId
 * @param {string} promptId
 * @param {number} started
 * @returns {Promise<{sent: number, batches: number, rejected: number}>}
 */
async function drainSpool(cfg, runId, agentId, promptId, started) {
  const max = batchMax(cfg);
  let seq = 0;
  let sent = 0;
  let batches = 0;
  let rejected = 0;

  for (;;) {
    if (Date.now() - started >= BUDGET_MS) {
      // Whatever is left is the next drain's work. The spool is keyed by run_id, not by
      // session, so nothing is lost by stopping here.
      log(cfg, 'info', 'drain: 10s soft budget spent; leaving the rest spooled', { run_id: runId });
      break;
    }

    // §5.5 step 2. A pure read: `request()` consults `allowRequest` itself, and consulting
    // it twice would spend the single half-open probe that the dial is entitled to.
    if (breakerOpen(cfg)) {
      log(cfg, 'debug', 'drain: breaker open; items stay spooled', { run_id: runId });
      break;
    }

    // §5.5 steps 3-4. Oldest first, so the wire order is the order things happened.
    const batch = readBatch(cfg, runId, max);
    if (batch.length === 0) break;

    const items = batch.map((e) => e.item).filter((it) => !!it && typeof it === 'object');
    if (items.length === 0) { commitBatch(batch); continue; }

    // §5.5 step 5: ONE request for the whole batch, not one per item.
    const res = await postIngest(cfg, {
      run_id: runId,
      agent_id: agentId,
      idempotency_key: batchIdempotencyKey(runId, items),
      parallel: true,               // batch items are independent of each other
      items,
      ...(str(cfg.userId) ? { user_id: str(cfg.userId) } : {}),
    }, { timeoutMs: numOr(cfg.timeoutMs, 4000), retry: true });

    seq++;
    batches++;

    if (res.ok) {
      // §5.5 step 6. `status: "queued"` means accepted, NOT durable — nothing here waits on
      // the job; only the doctor skill polls it. Unlinking on "queued" is deliberate: the
      // alternative is holding every item until a poll that no hot path can afford.
      commitBatch(batch);
      sent += batch.length;
      recordJob(cfg, runId, res.body, batch.length);
      advanceMarker(cfg, runId, batch.length);
      continue;
    }

    if (isRejectedPayload(res)) {
      // §5.5 step 6 / F16: the payload is bad, not the server. Quarantine and never retry.
      quarantine(cfg, runId, batch, res);
      rejected += batch.length;
      continue;
    }

    // 5xx, a transport failure, or a breaker that closed the door mid-loop. The batch is
    // still good: leave every file exactly where it is and stop. `lib/http.mjs` has already
    // recorded the failure with the breaker — recording it again here would escalate twice
    // as fast as §4.7 allows.
    noteFailure(cfg, runId, res);
    break;
  }

  return { sent, batches, rejected };
}

/**
 * Take the lock, then confirm it stayed ours (see LOCK_CONFIRM_MS: the lock file is briefly
 * empty at creation, and an empty lock reads as orphaned to the drainer right behind us).
 *
 * A drainer with nothing to attribute loses the race and stands down at once — that is the
 * §5.5 contract, and the cheap thing to do when another process is already sending the same
 * spool. A drainer carrying `--with-outcome` waits a little for the lock instead, because
 * `capture --stop` *always* spawns a detached drain first (§5.4 step 8), so the drain behind
 * it is normally the loser. Standing down immediately would mean a failed outcome post is
 * never retried before SessionEnd — the turn's credit lands nowhere, which is the one thing
 * §5.5 step 7 exists to prevent.
 *
 * It waits for the lock rather than posting without it. A drainer that stood down still
 * never dials: the lock is what makes "exactly one drainer per run" true, and attribution
 * does not get to be an exception to it.
 *
 * @param {Record<string, any>} cfg @param {string} runId
 * @param {boolean} wantsOutcome @param {number} started
 * @returns {Promise<any>} the confirmed lock, or null after standing down
 */
async function acquireConfirmed(cfg, runId, wantsOutcome, started) {
  for (;;) {
    const lock = acquireDrainLock(cfg, runId);
    if (lock) {
      heldLock = lock;
      if (await stillOurs(lock)) return lock;
      heldLock = null;               // it belongs to the winner now — never delete it
    }
    if (!wantsOutcome || Date.now() - started >= OUTCOME_LOCK_WAIT_MS) return null;
    await sleep(LOCK_POLL_MS);
  }
}

/**
 * Do we still own the lock we were handed?
 *
 * A steal rewrites `drain.lock` with the stealer's pid, so whoever wrote last is the single
 * winner and everyone else stands down — which is the property `acquireDrainLock`'s `O_EXCL`
 * was reaching for. A lock file that has vanished entirely is not ours either: something
 * unlinked it, and proceeding without one would be the double drain in a different costume.
 *
 * @param {{path: string}} lock
 * @returns {Promise<boolean>}
 */
async function stillOurs(lock) {
  try {
    await sleep(LOCK_CONFIRM_MS);
    const owner = readJson(lock.path, null);
    return !!owner && typeof owner === 'object' && Number(owner.pid) === process.pid;
  } catch {
    return false;
  }
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Is this the "the payload is bad" branch of the three-way split?
 *
 * `invalid_request` counts: it is `lib/http.mjs` refusing the batch pre-flight over a missing
 * `item_id` or `content_type` (§1.3), which is the same verdict a 422 would have carried and
 * would otherwise loop forever having never dialed.
 *
 * @param {any} res
 * @returns {boolean}
 */
function isRejectedPayload(res) {
  if (!res || res.ok) return false;
  if (res.state === 'invalid_request') return true;
  const status = Number(res.status);
  if (!Number.isFinite(status)) return false;
  return status >= 400 && status < 500 && !RETRYABLE_4XX.has(status);
}

/**
 * §5.5/§7: move the batch to `runs/<run_id>/spool/rejected/`. Quarantined, not deleted — it
 * is evidence, it is what the user pastes into an issue, and §7 expires it after 7 days.
 *
 * @param {Record<string, any>} cfg @param {string} runId
 * @param {{path: string, item: any}[]} batch @param {any} res
 */
function quarantine(cfg, runId, batch, res) {
  log(cfg, 'warn',
    `drain: ingest rejected the batch (${res?.status ?? res?.state}); quarantined in spool/rejected/`, {
      run_id: runId, items: batch.length, error: str(res?.error).slice(0, 300),
    });

  for (const entry of batch) {
    const from = str(entry?.path);
    if (!from) continue;
    const dir = join(dirname(from), 'rejected');
    ensureDir(dir);
    const to = join(dir, basename(from));
    try {
      renameSync(from, to);
    } catch {
      // Across a filesystem boundary, or a name that already exists: copy the parsed item
      // and drop the original. The batch must leave the live spool either way, or the next
      // drain re-sends a payload the server has already refused.
      try {
        writeFileSync(to, JSON.stringify(entry.item ?? null), 'utf8');
        unlinkSync(from);
      } catch { /* leave it; the next drain will try again and §7 will expire it */ }
    }
  }
}

/**
 * §5.5: a retryable failure costs nothing but the attempt. The spool is untouched; the only
 * thing recorded is the reason, so the status line can say something true.
 * @param {Record<string, any>} cfg @param {string} runId @param {any} res
 */
function noteFailure(cfg, runId, res) {
  log(cfg, 'warn', `drain: ingest failed (${res?.state}); items stay spooled`, {
    run_id: runId, status: res?.status ?? 0, error: str(res?.error).slice(0, 300),
  });
  updateMarker(cfg, runId, {
    last_error: str(res?.error).slice(0, 200),
    captured: { pending: spoolStats(cfg, runId).count },
  });
}

// ---------------------------------------------------------------------------
// §5.5 step 6 — what a 2xx leaves behind
// ---------------------------------------------------------------------------

/**
 * §7/§15.4: `runs/<run_id>/jobs.json` is an ARRAY of the last 20 accepted jobs. The doctor
 * skill polls `GET /v2/control/ingest/jobs/<job_id>` with these — an ingest that answered
 * `queued` has been accepted, not stored, and this file is the only way back to it.
 *
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
    // §4.9: a full or read-only data dir costs the job record, never the drain — and never
    // the lock, which the caller's `finally` releases regardless.
  }
}

/**
 * §4.8: the status line reads nothing but the marker, so the count of what has actually
 * reached the wire has to land here. `pending` is restated from the spool rather than
 * decremented, so a concurrent capture cannot leave it drifting.
 *
 * @param {Record<string, any>} cfg @param {string} runId @param {number} n
 */
function advanceMarker(cfg, runId, n) {
  try {
    const prev = readMarker(cfg, runId);
    const captured = (prev && typeof prev.captured === 'object' && prev.captured) || {};
    updateMarker(cfg, runId, {
      last_error: '',
      captured: {
        ingested: numOr(captured.ingested, 0) + n,
        pending: spoolStats(cfg, runId).count,
      },
    });
  } catch { /* the status line is cosmetic (§4.9) */ }
}

// ---------------------------------------------------------------------------
// §5.5 step 7 — the outcome call
// ---------------------------------------------------------------------------

/**
 * §5.5 step 7, deliberately **not** gated on the drain lock.
 *
 * The lock guards the spool: one drainer per run, so a batch is never sent twice. The outcome
 * is a different resource — per turn, guarded by `outcome_sent_at` locally and by a stable
 * `idempotency_key` server-side, so a second post is a no-op rather than double reinforcement.
 *
 * Gating it on the lock as well would mean a failed outcome is almost never retried before
 * SessionEnd, because `capture --stop` *always* spawns a detached drain first (§5.4 step 8):
 * the foreground `--with-outcome` drain behind it is normally the loser, and standing down
 * would take the attribution with it. Attribution is the whole point of the turn ending.
 *
 * Skipped while the breaker is open — an outcome dialed into a dead endpoint is one more
 * failure and no attribution. The turn stays `outcome_pending` and §5.7 step 3 flushes it.
 *
 * @param {Record<string, any>} cfg @param {string} runId @param {string} agentId
 * @param {string} promptId @param {boolean} wanted
 */
async function flushOutcome(cfg, runId, agentId, promptId, wanted) {
  if (!wanted || breakerOpen(cfg)) return;
  await sendOutcome(cfg, runId, agentId, promptId);
}

/**
 * `--with-outcome <prompt_id>`: read `runs/<run_id>/turns/<prompt_id>.json` and post exactly
 * one `/v2/control/outcome`.
 *
 * **The rule itself lives in `lib/outcome.mjs`, and this hook is one of its two callers.**
 * `session-end.mjs` is the other, for turns this drain never reached (§5.7 step 3), and the
 * two are separate esbuild entry points that cannot import one another — so the rule sat in
 * both files, and the copies disagreed for a while. `decideOutcome` answers the four-case
 * table (including "post nothing", which is a real answer here) and `outcomeRequest` addresses
 * the record; everything left in this function is the parts a drain owns: the file, the
 * clock, and what a failure means.
 *
 * `outcomeMode` "off" and "explicit" silence all of it — including the neutral record, which
 * is implicit attribution as much as the +0.2 is.
 *
 * @param {Record<string, any>} cfg @param {string} runId @param {string} agentId
 * @param {string} promptId
 */
async function sendOutcome(cfg, runId, agentId, promptId) {
  try {
    if (!implicitOutcomesEnabled(cfg)) return;
    if (!promptId) return;

    const p = join(runDir(cfg, runId), 'turns', `${safeSegment(promptId)}.json`);
    const turn = readJson(p, null);

    const decision = decideOutcome(turn);
    if (!decision.post) {
      // One reason needs the file changed: nothing is going to send this turn's outcome, so
      // it must stop claiming to be pending.
      if (decision.reason === 'attempts_exhausted') {
        writeJsonAtomic(p, { ...turn, outcome_pending: false, outcome_abandoned: true });
      }
      log(cfg, 'debug', `drain: no outcome to post (${decision.reason})`, {
        run_id: runId, prompt_id: promptId,
      });
      return;
    }

    // Counted before dialling, in the file. See MAX_OUTCOME_ATTEMPTS.
    const attempts = numOr(turn.outcome_attempts, 0);
    writeJsonAtomic(p, { ...turn, outcome_attempts: attempts + 1 });

    const res = await postOutcome(cfg, outcomeRequest({ runId, agentId, promptId, decision }),
      // Deliberately no `retry`. The transport's one silent re-dial on timeout doubles a post
      // that may already have landed, inside the same second — the widest part of the window,
      // and the least useful, since the next drain retries anyway.
      { timeoutMs: numOr(cfg.timeoutMs, 4000) });

    if (res.ok) {
      writeJsonAtomic(p, {
        ...turn, outcome_attempts: attempts + 1, outcome_pending: false, outcome_sent_at: Date.now(),
      });
    } else {
      // Left pending on purpose: the next drain re-posts it under the same key, up to the
      // attempt bound above.
      log(cfg, 'warn', `drain: outcome post failed (${res.state})`, {
        run_id: runId, prompt_id: promptId, error: str(res.error).slice(0, 300),
      });
    }
  } catch (err) {
    log(cfg, 'warn', `drain: outcome skipped — ${messageOf(err)}`, { run_id: runId });
  }
}

// ---------------------------------------------------------------------------
// The breaker, read without spending the probe
// ---------------------------------------------------------------------------

/**
 * §5.5 step 2, as a pure read.
 *
 * `allowRequest()` is not used here on purpose: while the breaker is open it *consumes* the
 * single half-open probe, and `lib/http.mjs` calls it again on the way to the socket. Asking
 * twice would spend the probe on this check and then refuse the dial it was granted for —
 * the breaker would never actually re-test the endpoint.
 *
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
    // Fail open: a breaker that cannot be read must not be able to stop the drain forever.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * The hook payload, from `--payload <file>` when there is one (the detached path — §4.9
 * hands the payload over through `${CLAUDE_PLUGIN_DATA}/tmp/<uuid>.json` because a detached
 * child's inherited stdin is not reliably readable once the parent exits), otherwise stdin.
 *
 * A malformed payload is `{}`, never a throw: the drain's real inputs are the spool and the
 * run id, and it can do useful work with neither a prompt id nor a session id.
 *
 * @param {string} payloadPath
 * @returns {Promise<Record<string, any>>}
 */
async function readPayload(payloadPath) {
  if (payloadPath) {
    const fromFile = readJson(payloadPath, null);
    // §4.9: "the child unlinks the file when done."
    if (process.env.MUBIT_CC_DETACHED === '1') payloadFile = payloadPath;
    if (fromFile && typeof fromFile === 'object' && !Array.isArray(fromFile)) return fromFile;
  }
  const raw = await readStdin();
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * stdin to EOF, bounded. Detached, stdin is `/dev/null` and this returns immediately; the
 * timeout is there for the case it is neither that nor a parent that closes its end.
 * @param {number} [limitMs]
 * @returns {Promise<string>}
 */
function readStdin(limitMs = 1000) {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { process.stdin.pause(); } catch { /* already gone */ }
      resolve(data);
    };
    const timer = setTimeout(done, limitMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      if (process.stdin.isTTY) { done(); return; }
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', done);
      process.stdin.on('error', done);
      process.stdin.on('close', done);
    } catch {
      done();
    }
  });
}

/**
 * `--flag value`, and `--flag=value`. Returns '' for a flag that is absent or bare.
 * @param {string[]} argv @param {string} name
 * @returns {string}
 */
/**
 * The same refusal `lib/runid.mjs` applies to a `static` pin, for a run id that arrived on
 * this process's argv instead. `''` means "not a run id", and the caller drains nothing.
 * @param {string} raw
 * @returns {string}
 */
function usableRunId(raw) {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id || id.toLowerCase() === 'default') return '';
  if (/[\\/]/.test(id) || /^\.+$/.test(id)) return '';
  return id;
}

function flagValue(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === name) {
      const next = argv[i + 1];
      return typeof next === 'string' && !next.startsWith('--') ? next : '';
    }
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return '';
}

// ---------------------------------------------------------------------------
// Paths and coercion
// ---------------------------------------------------------------------------

/** §6.1 `MUBIT_CC_BATCH_MAX_ITEMS`. @param {Record<string, any>} cfg @returns {number} */
function batchMax(cfg) {
  const n = Math.trunc(numOr(cfg?.batchMaxItems, DEFAULT_BATCH));
  return n > 0 ? n : DEFAULT_BATCH;
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

// ---------------------------------------------------------------------------

process.exitCode = 0;
try {
  await main();
} catch (err) {
  // Nothing above should throw, and if it does it costs the drain and nothing else.
  try { log(cfgRef, 'error', `drain: ${messageOf(err)}`); } catch { /* … */ }
  letGo();
}
process.exitCode = 0;
