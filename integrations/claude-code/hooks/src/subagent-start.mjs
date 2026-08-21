#!/usr/bin/env node
// @ts-check
/**
 * `hooks/src/subagent-start.mjs` — SubagentStart, blocking (§5.2, §4.3).
 *
 * ---------------------------------------------------------------------------
 * Why this hook exists at all
 * ---------------------------------------------------------------------------
 * **`UserPromptSubmit` does not fire for a subagent.** Measured on Claude Code 2.1.235,
 * over one parent turn that fanned out to two parallel general-purpose subagents:
 *
 *     2 SubagentStart / 2 SubagentStop / 1 UserPromptSubmit
 *
 * The single `UserPromptSubmit` was the parent's. So `prompt-recall` — the whole of the
 * recall path — is inert inside the Agent tool, and until this hook existed every subagent
 * a user spawned worked with no injected memory whatsoever. Not a small block: none.
 *
 * The other half is that this event can do something about it. The host's own registry says
 * "Exit code 0 - JSON additionalContext shown to subagent", its dispatch reads
 * `u.additionalContext = e.hookSpecificOutput.additionalContext`, and a live subagent asked
 * where it had seen an injected token answered: in a system message of its own, **prefixed
 * by the host with `SubagentStart hook additional context: `**, delivered in the same
 * envelope as the deferred-tool and skills listings.
 *
 * That prefix is the host's. `wrap()` below does not repeat it.
 *
 * ---------------------------------------------------------------------------
 * One caveat that can make this hook buy nothing
 * ---------------------------------------------------------------------------
 * The host drops the collected context when the agent has an isolated context —
 * `if (mr.length > 0 && !d?.isolatedContext)`. Budget spent on such an agent is spent and
 * discarded. Nothing here can detect it, so the honest handling is to say so in the guide
 * rather than to pretend otherwise in code.
 *
 * ---------------------------------------------------------------------------
 * Three ways this is NOT `prompt-recall` with a different event name
 * ---------------------------------------------------------------------------
 * The ladder itself is not here — it is `lib/recall.mjs`, which owns all three rungs and
 * the counter-intuitive fact that `/v2/control/context` is the *most* expensive of them.
 * Read that file's header before changing which request goes out. What is here is only what
 * a *subagent* needs, and each of the three differences below reads like a simplification:
 *
 * 1. **The query cannot come from the payload.** `SubagentStart` carries `session_id`,
 *    `transcript_path`, `cwd`, `prompt_id`, `agent_id`, `agent_type`, `hook_event_name` —
 *    and no task text at all. No `prompt`, no `description`. It does carry the *parent's*
 *    `prompt_id`, so the query is read back out of the turn `stage-prompt.mjs` staged on the
 *    parent's `UserPromptSubmit` (§5.3). No staged turn means no query, and no query means
 *    no request: dialling on the agent type alone would search for a word the user never
 *    typed, once per spawn.
 *
 * 2. **The parent's seen-set is neither read nor written.** `lib/seen.mjs` degrades a repeat
 *    into `(seen earlier) <ref> — <clause>`, which asserts the model was given the entry in
 *    full earlier *in this conversation*. For a subagent that sentence is false: it has a
 *    fresh window and was given nothing. A pointer would name a memory and withhold its
 *    text, which is strictly worse than not injecting it. Marking is the same mistake
 *    pointing the other way — the parent never received this block, so recording it as shown
 *    would make the parent's next prompt point at text it was never given.
 *
 * 3. **The budget is smaller.** `subagentRecallTokenBudget` (600) against the parent's 1500.
 *    A subagent's window is smaller and its task narrower, and this is paid once per spawn:
 *    a fan-out of ten pays it ten times.
 *
 * ---------------------------------------------------------------------------
 * Two things deliberately absent
 * ---------------------------------------------------------------------------
 * **No breaker pre-check.** `prompt-recall` reads the breaker itself because it blocks every
 * prompt and because it owns the marker's `state`. Neither applies here: `lib/http.mjs`
 * consults the breaker on its own way to the socket, so an open breaker already costs this
 * hook a `failure` Outcome and no round trip.
 *
 * **No marker write.** `status/<run_id>.json` is last-write-wins per run and is what the
 * status line renders as `recall 6/1.2k tok` for the *parent's* prompt. A subagent
 * overwriting that group would attribute its own numbers to the parent's turn — six spawns
 * would leave whichever finished last. The per-subagent record below is the read-out
 * instead.
 *
 * §4.9 throughout: never blocks, never exits non-zero. The only thing a failure here costs
 * is the memory.
 */

import { join } from 'node:path';

import { isConfigured, loadConfig } from '../../lib/config.mjs';
import { runHook } from '../../lib/hook.mjs';
import { postLinkRun } from '../../lib/http.mjs';
import { recordLink } from '../../lib/links.mjs';
import { log } from '../../lib/log.mjs';
import { recallBlock } from '../../lib/recall.mjs';
import { deriveAgentId, deriveRunId, deriveSubRunId, resolveProjectDir } from '../../lib/runid.mjs';
import { readJson, runDir, safeSegment, writeJsonAtomic } from '../../lib/state.mjs';

/**
 * The plugin's own recall agent (`agents/mubit-recall.md`), in every form `agent_type` can
 * name it: bare, and plugin-scoped through the marketplace.
 *
 * Injecting a recall block into it would pay for the same memory twice on the one agent
 * guaranteed to go and fetch it anyway — its entire job is to call `mubit_recall`, three
 * times, on Haiku, and return a synthesis.
 *
 * The exclusion lives here rather than in the manifest because a matcher can only ever be
 * *positive*: the matcher field for this event is `agent_type`, and "every agent except this
 * one" is not something a match expresses. An allowlist is no better — the set of agent
 * types a user may spawn is open, so it would exclude nearly everything by accident. Here it
 * is one comparison, and a test can drive both directions of it.
 */
const OWN_AGENTS = new Set(['mubit-recall', 'mubit-memory:mubit-recall']);

/** §5.2: recall quality does not improve past this, and a 40 KB paste is a slow embedding. */
const MAX_QUERY_CHARS = 2000;

/** `prompt_id` and the run ids name files, so they are untrusted input to a path. */
const MAX_ID = 128;

/**
 * What the Tier 1 join may cost a spawn, and why it is a small fixed number rather than
 * "whatever is left".
 *
 * A fan-out of ten pays this ten times, in front of ten agents that are waiting to start. A
 * link that cannot land in half a second is not worth that, and nothing is lost by giving up
 * on it: the record already says `linked: false`, which holds every field a later
 * re-assertion needs. The ceiling is also deliberately below `cfg.timeoutMs` (4000), because
 * `dial()` marks an abort on a tighter-than-configured deadline `abortedEarly` and
 * `settle()` then keeps it off the breaker — a deadline this hook chose is not evidence
 * about the server, and opening the circuit over it would cost recall and the capture drain.
 */
const LINK_BUDGET_MS = 500;

/** Room after the link settles to write the record and get stdout out inside the budget. */
const LINK_MARGIN_MS = 120;

/** Below this there is no time for a dial to complete; skipping beats aborting one. */
const LINK_FLOOR_MS = 60;

/**
 * Resolved once, before stdin, because the harness deadline is derived from `recallBudgetMs`
 * and `runHook` needs it up front. Never allowed to throw: a config that cannot be read
 * costs the recall, not the spawn.
 */
const CFG = safeConfig();
const RECALL_BUDGET_MS = clampInt(CFG.recallBudgetMs, 1500, 50, 10_000);
/** Just past the internal budget, and well inside the 3 s hook timeout in `hooks.json`. */
const HARNESS_BUDGET_MS = Math.min(RECALL_BUDGET_MS + 400, 2800);

/**
 * The one shape every skip, failure and empty result emits. Declared before the top-level
 * `await` below: the hook body runs while this module is still suspended at it.
 */
const SUPPRESS = Object.freeze({ suppressOutput: true });

await runHook('subagent-start', {
  budgetMs: HARNESS_BUDGET_MS,
  body: async (payload, _hookCfg, ctx) => {
    const cfg = CFG;
    const started = numOr(ctx?.startedAt, Date.now());
    const deadline = started + RECALL_BUDGET_MS;

    // --- Every skip below is "dial nothing", not "dial and discard".
    if (!cfg.recall) return SUPPRESS;
    // §4.1: with no endpoint there is nothing to recall from. Ahead of run-id derivation,
    // which can shell out to `git rev-parse` — a fan-out of ten on an install nobody has
    // signed in to yet should not cost ten subprocesses to learn that.
    if (!isConfigured(cfg)) return SUPPRESS;

    if (OWN_AGENTS.has(str(payload?.agent_type).toLowerCase())) {
      log(cfg, 'debug', 'subagent-start: skipping the plugin\'s own recall agent');
      return SUPPRESS;
    }

    let runId = '';
    let agentId = '';
    let subRunId = '';
    try {
      runId = deriveRunId(cfg, payload);
      agentId = deriveAgentId(payload);
      subRunId = deriveSubRunId(runId, payload);
    } catch (err) {
      // `static` with no pin, or a derivation that could only have answered "default" (§4.3).
      log(cfg, 'warn', `subagent-start: no usable run id (${messageOf(err)})`);
      return SUPPRESS;
    }

    const query = parentQuery(cfg, runId, payload);
    if (!query) {
      log(cfg, 'debug', 'subagent-start: no staged parent turn to query against; skipping',
        { run_id: runId });
      return SUPPRESS;
    }

    // The directory the SPAWN happened in, not the one the session launched in — a subagent
    // spawned after a `cd` belongs to the repo it is working in, same rule as the parent's.
    // Both ends of the join below sit in it: a subagent works in its parent's repo.
    const projectDir = resolveProjectDir(cfg, payload);

    const outcome = await recallBlock(cfg, {
      // Still the PARENT run, on purpose, and the one thing Tier 1 did NOT move. A subagent
      // should read everything the parent can; its own sub-run holds only its own evidence,
      // so querying that instead would hand it a fraction of what is already there. The
      // *write* side is what moved — `linkSubRun` below joins the two, which is what lets
      // `include_linked_runs` reach the sub-run from here in one hop (§4.3, §6 Tier 1).
      runId,
      agentId,        // …but the subagent's own identity, so siblings are separable.
      query,
      deadline,
      tokenBudget: CFG.subagentRecallTokenBudget,
      projectDir,
      // `seen` is deliberately omitted. See point 2 in the header — a subagent has seen
      // nothing earlier, so there is nothing here that could honestly be degraded.
    });

    const ms = Date.now() - started;

    if (outcome.failed) {
      log(cfg, 'warn',
        `subagent-start: recall failed on rung ${outcome.rung} (${str(outcome.state) || 'unknown'})`,
        { run_id: runId, error: str(outcome.error).slice(0, 300) });
      return SUPPRESS;
    }

    // Written even on an empty result: an absent record and a record of an empty recall are
    // different facts about a subagent that ran. And written BEFORE the link is attempted,
    // so a crash mid-call leaves a recoverable `linked: false` rather than nothing.
    const saved = persistSubRun(cfg, { runId, subRunId, agentId, payload, outcome, ms });

    // §6 Tier 1: pay the IOU this record has carried since it was written. Awaited only so
    // that `linked` can state what actually happened; never retried, never fatal, and inside
    // the budget this hook already had.
    await linkSubRun(cfg, {
      runId,
      subRunId,
      projectDir,
      saved,
      deadlineAt: numOr(ctx?.deadlineAt, started + HARNESS_BUDGET_MS),
    });

    // An empty result injects NOTHING. Injecting "I found nothing" wastes tokens and teaches
    // the model to distrust the channel.
    if (!outcome.block) return SUPPRESS;

    return {
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: wrap(runId, agentId,
          outcome.refIds.length || outcome.sources, outcome.tokens, outcome.block),
      },
      suppressOutput: true,
    };
  },
});

// ---------------------------------------------------------------------------
// The query — read out of the parent's staged turn
// ---------------------------------------------------------------------------

/**
 * The text of the prompt this subagent was spawned to help with.
 *
 * `SubagentStart` carries no task text, so the only handle on the work is the parent's
 * `prompt_id` — and `stage-prompt.mjs` wrote the prompt under exactly that key on the
 * parent's `UserPromptSubmit`, which has already happened by the time the Agent tool runs.
 * Reading it back is why this hook needs no new state.
 *
 * It is a *proxy*, and worth naming as one: the subagent's actual instruction is narrower
 * than the parent's prompt and is not visible to any hook. The parent's prompt is the
 * closest thing to the task that exists on this event, and it is far closer than the agent
 * type — which is a bare label like "Explore" that the user never typed.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {Record<string, any>} payload
 * @returns {string}
 */
function parentQuery(cfg, runId, payload) {
  try {
    const promptId = safeSegment(payload?.prompt_id, MAX_ID);
    if (!promptId) return '';
    const file = join(runDir(cfg, runId), 'turns', `${promptId}.json`);
    const turn = readJson(file, null);
    return isObject(turn) ? str(turn.prompt).slice(0, MAX_QUERY_CHARS) : '';
  } catch {
    // A data dir that cannot be read costs this subagent its memory, never its spawn.
    return '';
  }
}

// ---------------------------------------------------------------------------
// The per-subagent record
// ---------------------------------------------------------------------------

/**
 * `runs/<parent_run_id>/subagents/<sub_run_id>.json` — one file per subagent, named by the
 * one coordinate that differs between siblings.
 *
 * ---------------------------------------------------------------------------
 * Why a file, now that the join is real
 * ---------------------------------------------------------------------------
 * Mubit's subagent-isolation pattern is for an orchestrator to give each subagent its own
 * `run_id` and join them with `link_run()`, reading them back with `include_linked_runs`.
 * `lib/http.mjs`'s `ROUTES` carries `/v2/control/runs/link` now, so this client does both
 * halves: `linkSubRun` makes the join and `linked` reports whether it landed.
 *
 * The file outlives the route rather than being replaced by it, because the graph it feeds
 * lives in `run_scopes` — an in-memory map on the backend, durable only through a
 * checkpoint. A pod roll before one takes joins the user still wants, and this record holds
 * everything a blind re-assertion needs without a rerun: both ends (`sub_run_id`,
 * `parent_run_id`), the two agent ids, and the ids this subagent's block actually rendered.
 *
 * `linked` is written `false` and flipped only on a 200. A record claiming a link that does
 * not exist is worse than one admitting it does not — the whole value of this file is that a
 * later reader can trust it — and writing it first means a crash mid-call leaves a
 * recoverable `false` rather than nothing at all.
 *
 * `agent_transcript_path` — per-subagent, and the one field that could anchor a real
 * sub-run — arrives on `SubagentStop`, not here, so it is not in this record. It is where
 * the next step on this starts.
 *
 * @param {Record<string, any>} cfg
 * @param {{runId: string, subRunId: string, agentId: string,
 *          payload: Record<string, any>, outcome: Record<string, any>, ms: number}} o
 * @returns {{path: string, record: Record<string, any>}|null} what was written, so the
 *   `linked` flip below can rewrite it without parsing it back off disk.
 */
function persistSubRun(cfg, o) {
  try {
    const name = safeSegment(o.subRunId, MAX_ID);
    if (!name) return null;
    const dir = join(runDir(cfg, o.runId), 'subagents');
    const path = join(dir, `${name}.json`);
    const record = {
      sub_run_id: o.subRunId,
      parent_run_id: o.runId,
      // The host's own id, unmodified — `mubit_agent_id` is what went on the wire. Both,
      // because only the first can be matched against a `SubagentStop` and only the second
      // can be matched against the store.
      agent_id: str(o.payload?.agent_id),
      mubit_agent_id: o.agentId,
      agent_type: str(o.payload?.agent_type),
      session_id: str(o.payload?.session_id),
      // The parent's, and shared with every sibling. Kept precisely because it is the
      // coordinate that collapses: without it here, nothing records which turn fanned out.
      prompt_id: str(o.payload?.prompt_id),
      at: Date.now(),
      recall: {
        rung: numOr(o.outcome?.rung, 0),
        sources: (o.outcome?.refIds?.length ?? 0) || numOr(o.outcome?.sources, 0),
        tokens: numOr(o.outcome?.tokens, 0),
        // Characters are what was actually injected; the token figure is a
        // four-chars-per-token estimate (§4.10) a later reader can re-derive from these.
        chars: str(o.outcome?.block).length,
        dropped: numOr(o.outcome?.dropped, 0),
        // Always 0 while the seen-set stays out of this path. Recorded rather than assumed,
        // so a future change that starts passing one is visible here instead of silent.
        pointers: numOr(o.outcome?.pointers, 0),
        empty_reason: str(o.outcome?.emptyReason),
        ms: numOr(o.ms, 0),
      },
      // What this subagent was actually given, separable from what its siblings were given.
      recalled: Array.isArray(o.outcome?.refIds) ? [...o.outcome.refIds] : [],
      linked: false,
    };
    writeJsonAtomic(path, record);
    return { path, record };
  } catch (err) {
    // §4.9: an unwritable data dir costs this subagent's record, never its spawn.
    log(cfg, 'warn', `subagent-start: could not record the sub-run (${messageOf(err)})`,
      { run_id: o.runId });
    return null;
  }
}

// ---------------------------------------------------------------------------
// The join — §6 Tier 1
// ---------------------------------------------------------------------------

/**
 * `POST /v2/control/runs/link`, parent to sub-run.
 *
 * ---------------------------------------------------------------------------
 * Why the edge points this way, and why one hop is enough
 * ---------------------------------------------------------------------------
 * A parent with N subagents is a **star**, and every query originates at the hub: the
 * parent's own `prompt-recall`, the parent's `session-end` reflect, and this hook's recall
 * all read the parent run. So `linked_runs_for(parent)` returns all N children in a single
 * hop and no sibling ever has to reach another sibling. That is why Tier 1 needs no mesh,
 * no decision from the user, and no UX at all — the topology fits the backend's one-hop
 * limit natively. Sub-to-sub is SCOPE.md's §6 Tier 3 problem, not this one's.
 *
 * ---------------------------------------------------------------------------
 * Three rules this obeys, all of them §4.9
 * ---------------------------------------------------------------------------
 * 1. **`linked` flips only on `ok`.** Anything else and the record keeps saying `false`,
 *    which is true and recoverable. See `persistSubRun`'s header.
 * 2. **A failure is a `warn`, never a hook failure.** This is the spawn path: a network
 *    fault must cost the join and nothing else. `postLinkRun` is total — it answers a
 *    refusal envelope rather than throwing — but it is wrapped anyway, because the one thing
 *    this hook may never do is exit non-zero.
 * 3. **Nothing is dialled when there is nothing to join.** A payload with no subagent
 *    identity derives the parent unchanged, and an edge from a run to itself adds no reach:
 *    a run already consults its own memory. `postLinkRun` refuses that case pre-flight too,
 *    but catching it here also keeps it out of the local ledger, where it would sit forever
 *    as noise in the Tier 3 picker.
 *
 * The ledger write comes last and only on success. `lib/links.mjs` is the record of
 * decisions that **landed** — it is what re-asserts a join after `run_scopes` is lost with a
 * pod, and what `capture.mjs` reads, offline and with no round trip, to decide whether this
 * subagent's evidence has a lane it can be rejoined from.
 *
 * @param {Record<string, any>} cfg
 * @param {{runId: string, subRunId: string, projectDir: string,
 *          saved: {path: string, record: Record<string, any>}|null, deadlineAt: number}} o
 * @returns {Promise<boolean>} true when the join landed and the record says so
 */
async function linkSubRun(cfg, o) {
  // No record means the data dir is unwritable, so there is nothing a successful link could
  // be recorded against. Claiming it in the ledger alone would be a link nobody can see.
  if (!o.saved) return false;
  if (!o.subRunId || o.subRunId === o.runId) return false;

  const budget = Math.min(LINK_BUDGET_MS, o.deadlineAt - Date.now() - LINK_MARGIN_MS);
  if (budget < LINK_FLOOR_MS) {
    log(cfg, 'debug', 'subagent-start: no budget left to link the sub-run; the record stands',
      { run_id: o.runId, linked_run_id: o.subRunId });
    return false;
  }

  /** @type {Record<string, any>|null} */
  let res = null;
  try {
    res = await postLinkRun(cfg, { run_id: o.runId, linked_run_id: o.subRunId },
      { timeoutMs: budget, retry: false });
  } catch (err) {
    log(cfg, 'warn', `subagent-start: the link call threw (${messageOf(err)})`,
      { run_id: o.runId, linked_run_id: o.subRunId });
    return false;
  }

  if (!res || res.ok !== true) {
    log(cfg, 'warn',
      `subagent-start: could not link the sub-run (${str(res?.state) || numOr(res?.status, 0)})`,
      { run_id: o.runId, linked_run_id: o.subRunId, error: str(res?.error).slice(0, 300) });
    return false;
  }

  // Both ends sit in the same directory: a subagent works in its parent's repo.
  recordLink(cfg, { runId: o.runId, projectDir: o.projectDir },
    { runId: o.subRunId, projectDir: o.projectDir });

  try {
    writeJsonAtomic(o.saved.path, { ...o.saved.record, linked: true });
  } catch (err) {
    // The join is real on the server either way; what is lost is this file's account of it.
    log(cfg, 'warn', `subagent-start: linked, but could not restamp the record (${messageOf(err)})`,
      { run_id: o.runId, linked_run_id: o.subRunId });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The injected block.
 *
 * The host already prefixes this with `SubagentStart hook additional context: ` and
 * delivers it as a system message of the subagent's own — measured, from a live subagent's
 * report of where it found an injected token. Restating that framing inside the block would
 * be paid-for duplication of something the reader has already been told.
 *
 * What the block does have to say, once, is what it is *not*: retrieval is a ranked guess
 * over a token budget, entries can be stale, and none of it was re-checked against the
 * repository as it stands. Without that line a bullet under "Active rules" reads with the
 * authority of a project invariant, and a subagent — which has no conversation history to
 * weigh it against, and typically three turns to finish in — is the reader least equipped
 * to discount it and most likely to act on it directly.
 *
 * It also names the parent's prompt as the thing the memory was retrieved against, because
 * that is true (see `parentQuery`) and because a subagent whose own instruction is narrower
 * needs to know the block may be about its sibling's half of the work.
 *
 * @param {string} runId @param {string} agentId @param {number} sources
 * @param {number} tokens @param {string} block
 * @returns {string}
 */
function wrap(runId, agentId, sources, tokens, block) {
  return `<mubit-memory run="${runId}" agent="${agentId}" sources="${sources}" tokens="${tokens}">\n`
    + 'Recalled from memory of earlier work on this project, retrieved against the prompt '
    + 'that spawned you rather than against your own instructions — so it may be incomplete, '
    + 'out of date, or about a different part of the task. Verify against the code before '
    + 'relying on it.\n'
    + `\n${block.replace(/\s+$/, '')}\n</mubit-memory>`;
}

// ---------------------------------------------------------------------------
// Small helpers
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
function intOr(v, d) {
  const n = numOr(v, NaN);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : d;
}

/** @param {any} v @param {number} d @param {number} lo @param {number} hi @returns {number} */
function clampInt(v, d, lo, hi) {
  return Math.min(hi, Math.max(lo, intOr(v, d)));
}

/** `loadConfig` is total in practice; a hook that dies at import time would exit non-zero. */
function safeConfig() {
  try {
    return loadConfig();
  } catch {
    return /** @type {Record<string, any>} */ ({
      recall: true, recallBudgetMs: 1500, recallTokenBudget: 1500,
      subagentRecallTokenBudget: 600, timeoutMs: 4000,
      logLevel: process.env.MUBIT_CC_LOG_LEVEL || 'warn', recallAssemble: 'client',
      recallFallback: 'none',
    });
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
