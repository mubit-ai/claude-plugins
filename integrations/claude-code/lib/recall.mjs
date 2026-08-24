// @ts-check
/**
 * `lib/recall.mjs` — the read ladder, as one call (§1.8, §5.2 steps 1-4).
 *
 * ---------------------------------------------------------------------------
 * The ladder, and why it looks inverted
 * ---------------------------------------------------------------------------
 * The obvious design — ask `/v2/control/context` for a ready-to-inject `context_block` —
 * rests on the belief that the context route is pure assembly with no model call. **That
 * belief is false.** Measured end to end it costs two model calls, not zero, and the answer
 * they produce is discarded — this module assembles the block locally instead.
 *
 * | Rung | Request | LLM calls | Entered when |
 * | --- | --- | --- | --- |
 * | 1 | `query{mode:"direct_bypass", evidence_only:true, budget:"low"}` | **0** | always — the primary path |
 * | 2 | `query{mode:"agent_routed",  evidence_only:true, budget:"low"}` | 1 | rung 1 got **403** *and* `recallFallback === "agent_routed"` |
 * | 3 | `context{mode:"sections"}` | **2** | only when `recallAssemble === "server"` |
 *
 * **Rung 2 is opt-in, and off by default** (`MUBIT_CC_RECALL_FALLBACK`). It buys the only
 * recall an instance with direct search disabled can serve, and it pays for it with a routing
 * LLM call on every prompt: measured median 5025 ms, tail past 11 s, against a 1500 ms recall
 * budget inside a 3 s hook timeout. Nearly every one of those aborts *after* spending the
 * call, so the default trades recall nobody was getting for latency everybody was paying.
 * Rung 1 answers in ~30-250 ms server-side and is the path the docs call the default.
 *
 * So rung 3 is the *last* rung, not the first, and it is never reached by default — its
 * absence is asserted explicitly by the tests, because it is the first thing a well-meaning
 * maintainer would "simplify" into place, at two LLM calls in front of every keystroke.
 *
 * `recallAssemble: "server"` substitutes rung 3 for the ladder rather than appending itself
 * to it: paying rung 1 and then rung 3 would cost three LLM calls for one recall.
 *
 * ---------------------------------------------------------------------------
 * A 403 on rung 1 is a verdict, not a fault
 * ---------------------------------------------------------------------------
 * `direct_bypass` is policy-gated. An operator turning it off is an ordinary, supported
 * configuration, so a 403 here:
 *
 *   - must **not** touch the breaker (`lib/http.mjs` never records a 403) or `auth_failed`;
 *   - **is** cached to `policy/<endpoint_hash>.json` with a 24 h TTL, so the next prompt
 *     skips rung 1 entirely instead of burning a round trip on it forever
 *     (`MUBIT_CC_POLICY_TTL_MS=1` re-probes immediately once an operator flips the dial);
 *   - descends one rung, and never two — and only when asked to.
 *
 * A **401** on the same call is the opposite: auth is broken, give up, and never cache it —
 * a cached 401 would hide a revoked key for a day. A **grant** is never cached either: rung
 * 1 succeeding is self-evident, and storing it would only add a stale-state failure mode.
 *
 * ---------------------------------------------------------------------------
 * Why this is a module and not the top half of `prompt-recall.mjs`
 * ---------------------------------------------------------------------------
 * `UserPromptSubmit` is no longer the only place a recall block is wanted. A `SubagentStart`
 * hook needs one on a tighter token budget — a subagent's window is smaller and its task is
 * narrower, so reusing `recallTokenBudget` unchanged would spend a parent-sized block on a
 * three-turn agent — and an async carry-forward mode needs the same ladder decoupled from
 * the turn it will eventually be delivered on.
 *
 * Neither can import a hook: hooks are separate esbuild entry points and must never import
 * one another (see `lib/outcome.mjs` for what happened the last time a rule lived in two
 * hooks and the two copies drifted). So the ladder lives here, once, and
 * `recallBlock(cfg, o)` is the whole of it: identity and query in, an `Outcome` out.
 *
 * Everything a caller may want to vary is an option that **defaults to the config**, so
 * `recallBlock(cfg, {runId, agentId, query, deadline})` is exactly what `UserPromptSubmit`
 * asks for today, and a tighter caller overrides `tokenBudget` and nothing else.
 *
 * `resumeContext` is the one export that is deliberately NOT a rung of that ladder. It
 * is a session-start briefing rather than a recall against a prompt, it makes exactly one
 * request whatever `recallAssemble` says, and it is the only caller in this file that asks
 * `lib/http.mjs` not to record what it learns. Its own docblock says why.
 *
 * Discipline shared with the rest of `lib/`: zero dependencies, Node >= 20 built-ins only,
 * no import outside `lib/`, and nothing here throws (§4.9).
 */

import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { assembleContext, estimateTokens } from './assemble.mjs';
import { envTags } from './config.mjs';
import { postContext, postQuery } from './http.mjs';
import { log } from './log.mjs';
import { recordRules } from './rules.mjs';
import { readJson, resolveDataDir, writeJsonAtomic } from './state.mjs';

/** §5.2 step 3: rung 2 costs an LLM call; do not start one that cannot land. */
const RUNG2_MIN_BUDGET_MS = 500;

/** §5.2 rung-1 body, verbatim. */
const ENTRY_TYPES = Object.freeze(['mental_model', 'rule', 'lesson', 'fact', 'trace']);
const QUERY_LIMIT = 8;

/**
 * §5.2 — the budget below which rung 1 opts OUT of the server's cross-run lesson overlay.
 *
 * `entry_types` above contains `lesson`, and that alone puts the query on a second retrieval
 * lane: alongside the run-scoped search, the server runs an unscoped one to surface lessons
 * learned in OTHER runs. The run-scoped search takes a bounded fast path. The unscoped one
 * cannot — there is no run to bound it by — so it scales with the size of the whole
 * instance, not with this run, and it gets slower as an instance accumulates data no matter
 * what this plugin does. Measured against a hosted instance, that one lane is ~1.7s of a
 * ~2.0s rung-1 call: with it, the mean is 2.07s and every request overruns the 1500ms
 * default; without it, 0.35s. It is the difference between recall landing and recall timing
 * out, and no value of `recallBudgetMs` can buy its way out — `HARNESS_BUDGET_MS` in
 * `prompt-recall` is capped at 2800ms by the host's own 3s `UserPromptSubmit` timeout.
 *
 * So the threshold sits above that cap, deliberately: a blocking hook can never clear it and
 * always opts out, while the detached refresh (10s) and anything else with real slack always
 * clears it and keeps the overlay. The dial that decides this is a budget the caller already
 * has to set, not a new one to discover, and the rule reads the same way in both directions —
 * ask for the expensive lane only where there is room to pay for it.
 *
 * What opting out costs is small and measurable: the overlay contributed exactly ONE item per
 * query in every measurement, and now that lessons carry a real timestamp and age on a
 * half-life, that item ranks *below* the run-scoped hits it arrives with (0.34 against 1.00).
 * Set `recallCrossRun: "on"` to pay for it on the blocking path anyway.
 */
const CROSS_RUN_MIN_BUDGET_MS = 3000;

/**
 * §5.2: the `rank_by` modes the server actually has. Anything else — `auto` included — is
 * left off the wire entirely.
 *
 * `rank_by` selects how the server weights semantic, lexical and recency scores:
 * `relevance` is similarity-dominant, `freshness` is recency-dominant, `balanced` sits
 * between them. The exact weights are the server's, are operator-tunable per instance, and
 * are deliberately not restated here — `explain: true` reports the ones actually used.
 *
 * The server falls through to its default weighting on an unknown value, so a bad mode is
 * inert rather than an error — which is precisely why it is whitelisted here. A typo that
 * ranks at the default while sitting in the request log looking like a choice is a bug with
 * no symptom. `auto` is a client-side word (`lib/rank.mjs`) and never reaches the wire.
 */
const RANK_MODES = Object.freeze(['relevance', 'balanced', 'freshness']);

/** §5.2 rung-3 body, verbatim. */
const CONTEXT_LIMIT = 6;

// ---------------------------------------------------------------------------
// The resume briefing's request
// ---------------------------------------------------------------------------

/**
 * The sections a "where did this leave off" question is actually asking about.
 *
 * `facts` is deliberately absent. A fact is timeless — true before the session, during it and
 * after — so it answers "what is true here", not "what were we doing". Everything a resume
 * needs is state: what was in flight (`working_memory`), what happened (`traces`), the shape
 * the work is being done in (`mental_models`), and the constraints that were being observed
 * while doing it (`active_rules`, `lessons`).
 *
 * The list is paired with `RESUME_ENTRY_TYPES` below and the two cannot be edited apart: a
 * section no entry type can fill renders as nothing, silently, on a healthy 200.
 * `test/session-resume.test.mjs` checks both directions against `sectionFor()`.
 *
 * ---------------------------------------------------------------------------
 * The known weakness of this path, measured rather than assumed
 * ---------------------------------------------------------------------------
 * `GetContext` does **not** order its evidence by retrieval score. It re-sorts into a fixed
 * section hierarchy — mental_models, active_rules, lessons, …, working_memory(9), traces(10) —
 * with importance second and the fused score only as a third-order tiebreak, and then spends
 * `max_token_budget` top-down in that order. So the two sections a resume question is actually
 * about are the *last* to be paid for, and on a real run against api.mubit.ai a 1000-token
 * budget was consumed by 4 lessons and 2 traces with `working_memory` rendering nothing at all.
 *
 * Narrowing this list to `working_memory,traces` was measured too and is worse, not better: a
 * `trace` is a captured tool call rather than a summary, so the block became 553 tokens of one
 * raw multi-line shell script. Both orderings are in the PR that introduced this.
 *
 * Keeping the wider list is therefore the deliberate choice: the sections that render first
 * are the ones that render *legibly*. The real fix is not a different section list — it is
 * `postQuery{mode:'direct_bypass', rank_by:'freshness'}` assembled client-side, which is
 * cheaper, better ranked and not subject to any of this. That is a follow-up, and the reason
 * `resumeContext` is one small function with one caller is so it can be swapped whole.
 */
export const RESUME_SECTIONS = Object.freeze([
  'working_memory', 'traces', 'mental_models', 'active_rules', 'lessons',
]);

/**
 * The entry types that fill those sections (`lib/assemble.mjs`'s §4.10 table).
 *
 * `working_memory` has no entry type here and does not need one: `include_working_memory: true`
 * on the request is what fills it, and it is the section most of the answer comes from. That
 * asymmetry is the single most likely way this pair drifts, which is why the test names it
 * rather than skipping it.
 *
 * `entry_types` is a field `/context` does accept, unlike `rank_by`, `lane_filter` and
 * `env_tags`, and it is worth sending: without it the briefing competes for a 1000-token
 * budget against every `observation` and `tool_output` the run has produced.
 */
export const RESUME_ENTRY_TYPES = Object.freeze([
  'trace', 'task_result', 'mental_model', 'rule', 'lesson',
]);

/**
 * The briefing's question: three clauses, and a constant.
 *
 * Constant because there is no prompt to derive it from — this request is made before the user
 * has typed anything, which is the whole reason the feature exists. The three clauses are the
 * three things a person actually asks when they sit back down: where it stopped, what was
 * unfinished, and what to do first. Asking them in one query rather than three is what keeps
 * this to one round trip.
 */
export const RESUME_QUERY = 'Where did the work on this project leave off; '
  + 'what was in progress or blocked when it stopped; '
  + 'what should the next session pick up first.';

/**
 * Candidates for the briefing. Larger than `CONTEXT_LIMIT` (6) because this runs once per
 * *session* rather than once per prompt, and because five sections cannot be filled from six
 * candidates.
 *
 * **What `limit` actually counts, measured rather than taken from the contract.** It is not a
 * per-section cap, and it is not a cap on the response: it bounds one query's worth of
 * candidates in total, and the extra material `/context` layers on top is not counted against
 * it. A `limit` of 12 can come back with roughly twice that many sources, so the only bound
 * worth budgeting against is `max_token_budget`.
 *
 * `evidence_candidates_considered` is the observable that shows it: it is the merged, deduped
 * candidate count *before* budget truncation, and `evidence_dropped_by_budget` is that count
 * minus what survived.
 */
export const RESUME_LIMIT = 12;

/**
 * The briefing's deadline. Note that it is *looser* than `MUBIT_CC_TIMEOUT_MS`, which is
 * exactly why the request carrying it must also carry `{record: false}` — see `resumeContext`.
 */
const RESUME_TIMEOUT_MS = 20_000;

/** §6.1 `resumeTokenBudget`, used when a config could not be resolved. */
const RESUME_TOKEN_BUDGET = 1000;

/** §5.2/§7: the policy verdict file, keyed by endpoint hash — the same scheme as the breaker. */
const POLICY_TTL_MS = 86_400_000;
const ENDPOINT_HASH_LEN = 12;

/**
 * @typedef {object} Outcome
 * @property {boolean} failed
 * @property {number} rung
 * @property {string} block
 * @property {number} tokens
 * @property {number} sources
 * @property {number} dropped
 * @property {number} pointers   entries degraded to a one-line pointer (`lib/seen.mjs`)
 * @property {string} emptyReason
 * @property {string[]} refIds
 * @property {string} [state]   the §4.7 ConnState, on failure only
 * @property {string} [error]
 */

/**
 * @typedef {object} RecallOptions
 * @property {string} runId
 * @property {string} agentId
 * @property {string} query
 * @property {number} deadline           absolute ms; every rung paces itself against it
 * @property {Set<string>|string[]} [seen]  already injected this run (`lib/seen.mjs`)
 * @property {number} [tokenBudget]      defaults to `cfg.recallTokenBudget`
 * @property {string} [rankBy]           defaults to `cfg.recallRankBy`; `auto` (or anything
 *                                       not in `RANK_MODES`) sends no `rank_by` at all
 * @property {number} [perSection]       defaults to `cfg.recallMaxPerSection`
 * @property {string} [repeatMode]       defaults to `cfg.recallRepeatMode`
 * @property {string} [crossRun]         defaults to `cfg.recallCrossRun`; `auto` decides from
 *                                       the budget this call was given
 * @property {string} [projectDir]      the directory THIS prompt was sent in, for `env_tags`
 */

/**
 * Climb the ladder and hand back a rendered block.
 *
 * Never throws and never rejects: a caller is on a hook's critical path, and every failure
 * mode is already a shape in `Outcome` — `failed` for a verdict from the server, an
 * `emptyReason` for a budget that ran out before anything was dialled.
 *
 * @param {Record<string, any>} cfg
 * @param {RecallOptions} o
 * @returns {Promise<Outcome>}
 */
export async function recallBlock(cfg, o) {
  try {
    return cfg?.recallAssemble === 'server'
      ? await rungThree(cfg, o)
      : await ladder(cfg, o);
  } catch (err) {
    // §4.9: `lib/http.mjs` is total, so reaching here means a programming error rather than
    // a network one. It still may not take the prompt down with it.
    log(cfg, 'warn', `recall: the ladder threw (${messageOf(err)})`, { run_id: o?.runId });
    return failure('server_error', messageOf(err), 0);
  }
}

/**
 * Rungs 1 and 2. Rung 1 is skipped entirely while a valid policy denial is cached, which is
 * the whole point of caching it: one wasted round trip per day rather than one per prompt.
 *
 * @param {Record<string, any>} cfg
 * @param {RecallOptions} o
 * @returns {Promise<Outcome>}
 */
async function ladder(cfg, o) {
  const rankBy = rankByOf(cfg, o);
  const crossRun = crossRunOf(cfg, o);
  const body = {
    run_id: o.runId,
    agent_id: o.agentId,
    query: o.query,
    mode: 'direct_bypass',
    direct_lane: 'semantic_search',
    evidence_only: true,
    budget: 'low',
    limit: QUERY_LIMIT,
    entry_types: [...ENTRY_TYPES],
    include_working_memory: true,
    // `env_tags` is accepted on the query route but not on the context route — version-aware
    // tag scoring is capability rungs 1-2 gain over rung 3, not something they give up.
    // Tagged from the directory this prompt was sent in, not the one the session launched
    // in — the same reason the run id reads the payload. A recall scored against `repo:`
    // tags from the wrong repo is worse than one scored against none.
    env_tags: envTags(cfg, o.projectDir),
    // `rank_by` is the same trap as `env_tags` above, one field further on. `/context`
    // accepts no ranking field of ANY kind,
    // which makes freshness the second capability rungs 1-2 gain over rung 3 rather than
    // something they give up. What makes it a trap rather than a limitation: turning rung 3
    // on (`recallAssemble: "server"`) does not fail, warn, or fall back: it silently reverts
    // every recall to the default fusion weights, and "where were we?" quietly goes back to
    // answering with whatever is most similar. Documented in the README's `recallAssemble`
    // row for the same reason.
    //
    // Omitted rather than sent when it resolves to nothing: absent IS `relevance`
    // server-side, so there is no shape of request this spread cannot express.
    ...(rankBy ? { rank_by: rankBy } : {}),
    // §5.2: opting out of the cross-run lesson overlay, and the ONLY field here that is sent
    // to make the request cheaper rather than better. See `CROSS_RUN_MIN_BUDGET_MS`.
    //
    // Omitted rather than sent as `false` when the overlay is wanted: absent IS `false`
    // server-side, and a request log that only ever shows the field when somebody declined
    // the lane is easier to read than one where every request carries it.
    ...(crossRun ? {} : { prefer_current_run: true }),
  };

  let denied = readPolicyDenial(cfg);

  // --- RUNG 1. Zero LLM calls.
  if (!denied) {
    const budget = remaining(cfg, o.deadline);
    // Our own budget ran out, which is not a verdict about the server: reported as an empty
    // result so it cannot colour the status line with a failure state nobody earned.
    if (budget <= 0) return empty(0, 'budget_exhausted');

    const res = await postQuery(cfg, body, { timeoutMs: budget });
    if (res.ok) {
      // A grant is never cached; a stale denial that has just been disproved is cleared.
      clearPolicy(cfg);
      return fromEvidence(cfg, res.body, 1, o);
    }
    if (res.status === 403) {
      // §5.2: a policy verdict, not a fault. `lib/http.mjs` has already declined to
      // record it with the breaker; all that is left is to remember it and decide.
      cachePolicyDenial(cfg);
      if (cfg.recallFallback !== 'agent_routed') {
        // `warn`, not `info`: the default log level is `warn`, and this is the single most
        // important fact about the install — every recall from here on returns nothing until
        // an operator enables direct search. Logging it below the default level is how a
        // permanently dead recall path stays invisible.
        log(cfg, 'warn', 'prompt-recall: direct_bypass is disabled by instance policy and '
          + 'MUBIT_CC_RECALL_FALLBACK is "none", so this recall returns empty. Ask your operator '
          + 'to enable direct search, or set MUBIT_CC_RECALL_FALLBACK=agent_routed to pay an LLM '
          + 'call per prompt instead.', { run_id: o.runId });
        return empty(1, 'policy_denied');
      }
      log(cfg, 'warn', 'prompt-recall: direct_bypass is disabled by policy; descending to rung 2',
        { run_id: o.runId });
      denied = true;
    } else {
      // §5.2: "Any other failure → give up; this is a transport/server problem, not policy."
      // A 401 lands here, deliberately: spending an LLM call on rung 2 with a broken key
      // buys a second 401.
      return failure(res.state, res.error, 1);
    }
  }

  // --- RUNG 2. One LLM call, opt-in, and only ever after a rung-1 probe was refused.
  // The cached-denial path arrives here too, on every prompt for the next 24 h — the fresh
  // 403 above explains itself once, this keeps the door shut quietly thereafter.
  if (cfg.recallFallback !== 'agent_routed') return empty(1, 'policy_denied');

  const left = o.deadline - Date.now();
  if (left < RUNG2_MIN_BUDGET_MS) {
    log(cfg, 'info', `prompt-recall: ${left}ms left is under the ${RUNG2_MIN_BUDGET_MS}ms rung-2 floor; skipping`,
      { run_id: o.runId });
    return empty(0, 'budget_exhausted');
  }

  const res = await postQuery(cfg, { ...body, mode: 'agent_routed' },
    { timeoutMs: remaining(cfg, o.deadline) });
  if (!res.ok) return failure(res.state, res.error, 2);
  return fromEvidence(cfg, res.body, 2, o);
}

/**
 * Rung 3 — `POST /v2/control/context`, two LLM calls, opt-in only. The server has already
 * assembled the block, so it is injected verbatim: re-assembling what two LLM calls just
 * paid for would be pure waste.
 *
 * `rank_by` does not reach it either, and cannot: `/context` accepts no ranking field, so
 * this rung always ranks at the service's defaults. See the note beside the rung-1
 * body — it is the one cost of `recallAssemble: "server"` that nothing at runtime reports.
 *
 * The seen-set does not reach this rung, and cannot: the block is the server's rendering and
 * the client has no seam inside it to degrade. An operator paying two LLM calls per prompt
 * pays full token price too. `pointers` is 0 here, honestly rather than by omission.
 *
 * @param {Record<string, any>} cfg
 * @param {RecallOptions} o
 * @returns {Promise<Outcome>}
 */
async function rungThree(cfg, o) {
  const budget = remaining(cfg, o.deadline);
  if (budget <= 0) return empty(0, 'budget_exhausted');

  const res = await postContext(cfg, {
    run_id: o.runId,
    agent_id: o.agentId,
    query: o.query,
    mode: 'sections',
    sections: [...(cfg.recallSections ?? [])],
    max_token_budget: tokenBudgetOf(cfg, o),
    limit: CONTEXT_LIMIT,
    include_working_memory: true,
    format: 'structured',
  }, { timeoutMs: budget });

  if (!res.ok) return failure(res.state, res.error, 3);
  return fromContext(res.body, 3);
}

// ---------------------------------------------------------------------------
// The resume briefing
// ---------------------------------------------------------------------------

/**
 * The one request `hooks/src/session-resume.mjs` makes: `POST /v2/control/context` asking what
 * the next agent on this run needs to know.
 *
 * ---------------------------------------------------------------------------
 * `postContext` directly, and never `recallBlock`
 * ---------------------------------------------------------------------------
 * `recallBlock` dispatches on `cfg.recallAssemble`, so routing the briefing through it would
 * mean the feature silently changes shape — a different endpoint, a different body, a
 * different ranking story — the moment an operator flips a per-prompt dial that has nothing to
 * do with it. This path has exactly one shape and reaching it costs one function.
 *
 * ---------------------------------------------------------------------------
 * `{record: false, timeoutMs: 20000}` is required, not optional
 * ---------------------------------------------------------------------------
 * `lib/http.mjs:557-560` tags an abort `abortedEarly` — and `settle()` at :592 then declines to
 * record it with the breaker — **only** when the caller's deadline is *tighter* than the
 * configured default. That is the right rule: a caller on a 400 ms slice learns nothing about
 * a healthy instance from its own impatience.
 *
 * This deadline is 20 s against a 4000 ms default, which is *looser*, so an abort here would
 * be treated as evidence and recorded. Five sessions inside the five-minute window and the
 * breaker opens — which stops `prompt-recall` dialling and suppresses the capture drain, for a
 * briefing nobody was waiting on. A background feature must not be able to take recall down,
 * so it declines to vote at all.
 *
 * 20 s is the right deadline for the same reason `recall-refresh` ignores `recallBudgetMs`:
 * nothing is waiting. Rung 3 costs two LLM calls and the runbook's own measurement puts an
 * agent-routed call at a 5 s median with a tail past 11 s.
 *
 * Never throws and never rejects — every failure is already a shape in `Outcome` (§4.9).
 *
 * @param {Record<string, any>} cfg
 * @param {{runId: string, agentId: string, tokenBudget?: number}} o
 * @returns {Promise<Outcome>}
 */
export async function resumeContext(cfg, o) {
  try {
    const res = await postContext(cfg, {
      run_id: o?.runId,
      agent_id: o?.agentId,
      query: RESUME_QUERY,
      mode: 'sections',
      sections: [...RESUME_SECTIONS],
      entry_types: [...RESUME_ENTRY_TYPES],
      include_working_memory: true,
      max_token_budget: intOr(o?.tokenBudget ?? cfg?.resumeTokenBudget, RESUME_TOKEN_BUDGET),
      limit: RESUME_LIMIT,
      format: 'structured',
      // Four fields are deliberately absent and each is absent for its own reason:
      //
      //   `rank_by`     — `/context` accepts no ranking field of ANY kind. Sending one is
      //                   ignored while sitting in the request log looking like a choice
      //                   somebody made, which is a bug with no symptom. It is also the real
      //                   cost of this path: `lib/rank.mjs` has a `where_were_we` rule that
      //                   would resolve this query to `freshness`, and it cannot be used.
      //   `lane_filter` — a `/query` field. `/context` does not accept it.
      //   `env_tags`    — the same gap, one field further on. Version-aware tag scoring is a
      //                   capability rungs 1-2 have and this endpoint does not.
      //   `user_id`     — a retrieval FILTER the server enforces, not a label. Filling it
      //                   narrows the briefing to entries captured under the same id, which on
      //                   every install that never set one is nothing at all.
    }, { timeoutMs: RESUME_TIMEOUT_MS, record: false });

    if (!res.ok) return failure(res.state, res.error, 3);
    return fromContext(res.body, 3);
  } catch (err) {
    log(cfg, 'warn', `resume: the context call threw (${messageOf(err)})`, { run_id: o?.runId });
    return failure('server_error', messageOf(err), 3);
  }
}

/**
 * A `ContextResponse` as an `Outcome`. Shared by rung 3 and the resume briefing, because they
 * are the same response off the same endpoint — and a second parser would be a second place
 * for `sources[]` to be read as `evidence[]`, which is the mistake this shape invites.
 *
 * The seen-set never reaches either caller and cannot: the block is the server's own rendering
 * and the client has no seam inside it to degrade. `pointers` is 0 here honestly rather than
 * by omission.
 *
 * @param {any} responseBody
 * @param {number} rung
 * @returns {Outcome}
 */
function fromContext(responseBody, rung) {
  const b = isObject(responseBody) ? responseBody : {};
  const block = typeof b.context_block === 'string' ? b.context_block.trim() : '';
  const refIds = Array.isArray(b.sources)
    ? [...new Set(b.sources.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()))]
    : [];
  const summaries = Array.isArray(b.section_summaries) ? b.section_summaries : [];
  const counted = summaries.reduce((n, s) => n + (isObject(s) ? numOr(s.count, 0) : 0), 0);

  return {
    failed: false,
    rung,
    block,
    tokens: numOr(b.token_estimate, 0) || estimateTokens(block),
    sources: refIds.length || counted,
    dropped: numOr(b.evidence_dropped_by_budget, 0),
    pointers: 0,
    emptyReason: typeof b.empty_reason === 'string' && b.empty_reason
      ? b.empty_reason
      : (block ? '' : 'no_evidence'),
    refIds,
  };
}

/**
 * Rungs 1-2 answer with `evidence[]`; `lib/assemble.mjs` renders it into the same shape,
 * in the same order, with the same `emptyReason` vocabulary rung 3 would have produced
 * (§4.10). That is what makes `additionalContext` rung-agnostic.
 *
 * It is also where the rule store is filled. The `rule`-typed entries in this same
 * `evidence[]` are written to `runs/<run_id>/rules.json` for `hooks/src/pre-tool.mjs` to read
 * in front of a matching tool call. That hook may not dial — it runs while the user waits on
 * the call — so its only supply is a hook that has already paid for a round trip, and this is
 * the one that pays on every prompt. A pure side effect: `recordRules` never throws, writes
 * one small file, and cannot change what this function returns.
 *
 * Rung 3 has no equivalent and deliberately gets none: `POST /v2/control/context` answers
 * with a pre-assembled `context_block` and `sources[]`, and no per-entry `entry_type` at all,
 * so there is nothing there to filter to `rule`. On the opt-in `recallAssemble: "server"`
 * path the store is therefore fed by `session-start` alone — worth knowing before reading a
 * quiet `pre-tool` as a bug.
 *
 * @param {Record<string, any>} cfg
 * @param {any} responseBody
 * @param {number} rung
 * @param {RecallOptions} o
 * @returns {Outcome}
 */
function fromEvidence(cfg, responseBody, rung, o) {
  const b = isObject(responseBody) ? responseBody : {};
  const evidence = Array.isArray(b.evidence) ? b.evidence : [];
  if (o?.runId) recordRules(cfg, o.runId, evidence);
  const a = assembleContext(evidence, {
    tokenBudget: tokenBudgetOf(cfg, o),
    perSection: intOr(o.perSection ?? cfg.recallMaxPerSection, 0),
    seen: o.seen,
    repeatMode: typeof o.repeatMode === 'string' && o.repeatMode
      ? o.repeatMode
      : String(cfg.recallRepeatMode ?? 'pointer'),
  });
  return {
    failed: false,
    rung,
    block: a.block,
    tokens: a.tokenEstimate,
    sources: a.sourceRefIds.length,
    dropped: a.dropped,
    pointers: a.pointers,
    emptyReason: a.emptyReason,
    // §4.10/§5.5: a degraded entry is still in here. Dropping a repeat would break
    // attribution for exactly the memories that are helping most.
    refIds: a.sourceRefIds,
  };
}

/**
 * The block's token ceiling: the caller's, then the config's, then §6.1's default. A
 * `SubagentStart` caller overrides it and nothing else.
 * @param {Record<string, any>} cfg @param {RecallOptions} o @returns {number}
 */
function tokenBudgetOf(cfg, o) {
  return intOr(o?.tokenBudget ?? cfg?.recallTokenBudget, 1500);
}

/**
 * The query's fusion weights: the caller's, then the config's, then nothing.
 *
 * "Nothing" is a real answer here and the reason this is not modelled with a default: the
 * field is optional on `/query`, and absent means exactly what `relevance` means.
 * `auto` lands here as `''` — by then a caller was supposed to have resolved it
 * (`lib/rank.mjs`, `rankForRecall`), and if one did not, ranking at the server's defaults is
 * the same recall the plugin has always done rather than a new failure mode. Sending the
 * literal `"auto"` would be the worst of the three: ignored by the server, and impossible to
 * tell in a request log from a mode somebody chose.
 *
 * @param {Record<string, any>} cfg @param {RecallOptions} o @returns {string}
 */
function rankByOf(cfg, o) {
  const v = o?.rankBy ?? cfg?.recallRankBy;
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return RANK_MODES.includes(s) ? s : '';
}

/**
 * Whether this call may ask for the server's cross-run lesson overlay.
 *
 * `on` and `off` are pins. `auto` — the default — reads the budget the caller arrived with,
 * so the answer is a property of the PATH rather than of the installation: a hook that must
 * answer inside the host's prompt timeout declines the lane, the detached refresh behind it
 * takes it, and neither needed to be told which one it is. See `CROSS_RUN_MIN_BUDGET_MS`.
 *
 * An absent or unparseable deadline is treated as no slack. That is the safe direction: the
 * cost of wrongly declining is one cross-run lesson, the cost of wrongly accepting is the
 * whole recall.
 *
 * @param {Record<string, any>} cfg @param {RecallOptions} o @returns {boolean}
 */
function crossRunOf(cfg, o) {
  const v = o?.crossRun ?? cfg?.recallCrossRun;
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (s === 'on') return true;
  if (s === 'off') return false;
  return remaining(cfg, o?.deadline) >= CROSS_RUN_MIN_BUDGET_MS;
}

/**
 * A rung that was never run — the ladder ended without a verdict from the server. Reported
 * as an empty result rather than a failure: nothing is broken, there was simply no budget.
 * @param {number} rung @param {string} reason @returns {Outcome}
 */
function empty(rung, reason) {
  return {
    failed: false, rung, block: '', tokens: 0, sources: 0, dropped: 0, pointers: 0,
    emptyReason: reason, refIds: [],
  };
}

/** @param {any} state @param {any} error @param {number} rung @returns {Outcome} */
function failure(state, error, rung) {
  return {
    failed: true, rung, block: '', tokens: 0, sources: 0, dropped: 0, pointers: 0,
    emptyReason: '', refIds: [],
    state: typeof state === 'string' ? state : 'server_error',
    error: typeof error === 'string' ? error : String(error ?? ''),
  };
}

// ---------------------------------------------------------------------------
// §5.2/§7 — the policy-verdict cache
// ---------------------------------------------------------------------------

/**
 * `${CLAUDE_PLUGIN_DATA}/policy/<sha256(endpoint)[0:12]>.json`. Keyed by endpoint so a local
 * and a hosted instance hold independent verdicts — one operator disabling `direct_bypass`
 * must not tax the other instance.
 * @param {Record<string, any>} cfg
 * @returns {string}
 */
function policyPath(cfg) {
  const endpoint = typeof cfg?.endpoint === 'string' ? cfg.endpoint : '';
  const hash = createHash('sha256').update(endpoint).digest('hex').slice(0, ENDPOINT_HASH_LEN);
  return join(resolveDataDir(cfg), 'policy', `${hash}.json`);
}

/**
 * Is there a *valid* cached denial? An expired one answers false, which re-probes rung 1
 * exactly once — an operator who flips the instance's direct-search policy back on gets the
 * free path back within a day, with no reinstall.
 * @param {Record<string, any>} cfg
 * @returns {boolean}
 */
function readPolicyDenial(cfg) {
  try {
    const v = readJson(policyPath(cfg), null);
    if (!isObject(v) || v.direct_bypass !== 'denied') return false;
    const ttl = intOr(cfg.policyTtlMs, 0) || intOr(v.ttl_ms, 0) || POLICY_TTL_MS;
    const observed = numOr(v.observed_at, 0);
    return observed > 0 && (Date.now() - observed) < ttl;
  } catch {
    return false;
  }
}

/** @param {Record<string, any>} cfg @returns {void} */
function cachePolicyDenial(cfg) {
  try {
    writeJsonAtomic(policyPath(cfg), {
      direct_bypass: 'denied',
      observed_at: Date.now(),
      ttl_ms: intOr(cfg.policyTtlMs, POLICY_TTL_MS),
    });
  } catch { /* an unwritable data dir costs one round trip per prompt, never the prompt */ }
}

/**
 * A verdict the server has just contradicted. Grants are never *stored* (§5.2), but an old
 * denial that has been disproved is removed rather than left to confuse the doctor skill.
 * @param {Record<string, any>} cfg
 * @returns {void}
 */
function clearPolicy(cfg) {
  try { unlinkSync(policyPath(cfg)); } catch { /* nothing cached, which is the normal case */ }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * The per-call timeout: whatever is left of the recall budget, never more than
 * `MUBIT_CC_TIMEOUT_MS`. A non-positive value means "do not dial" — `lib/http.mjs` reads one
 * as "unset" and would fall back to its 4000 ms default, which is the entire budget spent on
 * a call that had already run out of time.
 * @param {Record<string, any>} cfg @param {number} deadline @returns {number}
 */
function remaining(cfg, deadline) {
  const left = deadline - Date.now();
  if (left <= 0) return 0;
  return Math.max(1, Math.min(left, intOr(cfg.timeoutMs, 4000)));
}

/** @param {any} v @returns {boolean} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
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
