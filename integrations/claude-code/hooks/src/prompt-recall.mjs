#!/usr/bin/env node
// @ts-check
/**
 * `hooks/src/prompt-recall.mjs` — UserPromptSubmit, blocking (§5.2, §1.8).
 *
 * ---------------------------------------------------------------------------
 * The ladder, and why it looks inverted
 * ---------------------------------------------------------------------------
 * The obvious design — ask `/v2/control/context` for a ready-to-inject `context_block` —
 * rests on the belief that `GetContext` is pure assembly with no LLM. **That belief is
 * false.** It builds an internal `AgentQueryRequest` and re-enters `query()` as
 * `AgentRouted` with `evidence_only` left at `false`, pays a routing
 * call *and* a synthesis call, and then throws the synthesized answer away.
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
 * Rung 1 answers in ~30–250 ms server-side and is the path the docs call the default.
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
 * `direct_bypass` is policy-gated.
 * An operator turning it off is an ordinary, supported configuration, so a 403 here:
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
 * Budget and failure
 * ---------------------------------------------------------------------------
 * 1500 ms internal (`MUBIT_CC_RECALL_BUDGET_MS`) against a 3 s hook timeout, on a hook that
 * fires before EVERY prompt. Rung 2 is skipped when under 500 ms remains: it costs an LLM
 * call, and starting one that cannot finish spends the call and injects nothing.
 *
 * Breaker-open, a timeout, an empty result or any non-2xx all emit exactly
 * `{"suppressOutput": true}`. Injecting "I found nothing" wastes tokens and teaches the
 * model to distrust the channel. The hook never blocks and never exits non-zero (§4.9).
 */

import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { assembleContext, estimateTokens } from '../../lib/assemble.mjs';
import { CONN_STATES, readBreaker } from '../../lib/breaker.mjs';
import { envTags, isConfigured, loadConfig } from '../../lib/config.mjs';
import { runHook } from '../../lib/hook.mjs';
import { postContext, postQuery } from '../../lib/http.mjs';
import { log } from '../../lib/log.mjs';
import { readMarker, updateMarker } from '../../lib/markers.mjs';
import { deriveAgentId, deriveRunId } from '../../lib/runid.mjs';
import { readJson, resolveDataDir, writeJsonAtomic } from '../../lib/state.mjs';

/** §5.2 step 0: "ok", "yes", "go on" carry no retrievable intent. */
const MIN_PROMPT_CHARS = 8;

/** §5.2: recall quality does not improve past this, and a 40 KB paste is a slow embedding. */
const MAX_QUERY_CHARS = 2000;

/** §5.2 step 3: rung 2 costs an LLM call; do not start one that cannot land. */
const RUNG2_MIN_BUDGET_MS = 500;

/** §5.2 rung-1 body, verbatim. */
const ENTRY_TYPES = Object.freeze(['mental_model', 'rule', 'lesson', 'fact', 'trace']);
const QUERY_LIMIT = 8;

/** §5.2 rung-3 body, verbatim. */
const CONTEXT_LIMIT = 6;

/** §5.2/§7: the policy verdict file, keyed by endpoint hash — the same scheme as the breaker. */
const POLICY_TTL_MS = 86_400_000;
const ENDPOINT_HASH_LEN = 12;

/** U+00B7, the separator the status line and every systemMessage share. */
const DOT = ' · ';

/** `prompt_id` names a file, so it is untrusted input to a path. */
const MAX_ID = 128;

/**
 * Resolved once, before stdin, because the harness deadline has to be derived from
 * `recallBudgetMs` and `runHook` needs it up front. Never allowed to throw: a config that
 * cannot be read costs the recall, not the prompt.
 */
const CFG = safeConfig();
const RECALL_BUDGET_MS = clampInt(CFG.recallBudgetMs, 1500, 50, 10_000);
/** The harness's hard stop sits just past the internal budget, and well inside the 3 s hook timeout. */
const HARNESS_BUDGET_MS = Math.min(RECALL_BUDGET_MS + 400, 2800);

/**
 * The one shape every skip, failure and empty result emits (§5.2). Declared before the
 * top-level `await` below: the hook body runs while this module is still suspended at it,
 * so anything the body reads has to be initialised by then.
 */
const SUPPRESS = Object.freeze({ suppressOutput: true });

await runHook('prompt-recall', {
  budgetMs: HARNESS_BUDGET_MS,
  body: async (payload, _hookCfg, ctx) => {
    const cfg = CFG;
    const started = numOr(ctx?.startedAt, Date.now());
    const deadline = started + RECALL_BUDGET_MS;

    // --- §5.2 step 0. Every skip here is "dial nothing", not "dial and discard".
    if (!cfg.recall) return SUPPRESS;
    // §4.1: with no endpoint there is nothing to recall from. Ahead of run-id derivation,
    // which can shell out to `git rev-parse` — this hook blocks every prompt, and an install
    // nobody has signed in to yet should not pay a subprocess per prompt to learn that.
    // `session-start` has already written `unconfigured` to the marker for this run.
    if (!isConfigured(cfg)) return SUPPRESS;

    const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : '';
    if (prompt.length < MIN_PROMPT_CHARS) return SUPPRESS;
    // A slash command is addressed to the harness, not the model; recalling against
    // "/mubit-memory:recall …" would inject memory into a memory command.
    if (prompt.startsWith('/')) return SUPPRESS;

    let runId = '';
    let agentId = '';
    try {
      runId = deriveRunId(cfg, payload);
      agentId = deriveAgentId(payload);
    } catch (err) {
      // `static` with no pin, or a derivation that could only have answered "default" (§4.3).
      log(cfg, 'warn', `prompt-recall: no usable run id (${messageOf(err)})`);
      return SUPPRESS;
    }

    // §4.7/F7: a blocking hook in front of every prompt must not pay a connect timeout to a
    // server already known to be down. Read-only — `allowRequest` would spend the single
    // half-open probe that `lib/http.mjs` is about to ask for itself.
    if (breakerOpen(cfg)) {
      // Carry the breaker's verdict onto the marker on the way out. Returning without it is
      // how a state goes stale and stays stale: once the breaker is open this hook stops
      // dialing, so nothing else writes `state` for the rest of the run, and whatever the
      // last hook happened to record — often a `warming` from a window that has long since
      // expired — is what the status line keeps showing.
      const b = readBreaker(cfg);
      log(cfg, 'debug', 'prompt-recall: breaker open; skipping recall', { run_id: runId });
      // The `recall` block goes with it. Without this the status line keeps rendering the
      // last *successful* recall for the whole time the breaker is open — a green count
      // describing a call that has not been made in minutes.
      updateMarker(cfg, runId, {
        mode: cfg.mode,
        ...(isConnState(b.state) ? { state: b.state } : {}),
        recall: {
          sources: 0, tokens: 0, ms: 0, rung: 0, dropped: 0, empty_reason: 'breaker_open',
          ...dryness(cfg, runId, false),
        },
      });
      return SUPPRESS;
    }

    const query = prompt.slice(0, MAX_QUERY_CHARS);
    const promptId = safeId(payload?.prompt_id);

    const outcome = cfg.recallAssemble === 'server'
      ? await rungThree(cfg, { runId, agentId, query, deadline })
      : await ladder(cfg, { runId, agentId, query, deadline });

    const ms = Date.now() - started;

    if (outcome.failed) {
      noteFailure(cfg, runId, outcome, ms);
      return SUPPRESS;
    }

    // §5.2 step 6: what was rendered is what `Stop` attributes against (§5.5). Written even
    // when it is empty — an absent key is a different value from an empty one downstream.
    persistRecalled(cfg, runId, promptId, payload, outcome.refIds);

    updateMarker(cfg, runId, {
      state: 'ready',
      last_error: '',
      recall: {
        sources: outcome.refIds.length,
        tokens: outcome.tokens,
        ms,
        empty_reason: outcome.emptyReason,
        rung: outcome.rung,
        dropped: outcome.dropped,
        ...dryness(cfg, runId, outcome.refIds.length > 0),
      },
    });

    // §5.2: an empty result injects NOTHING. No additionalContext, no systemMessage.
    if (!outcome.block) return SUPPRESS;

    const sources = outcome.refIds.length || outcome.sources;
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: wrap(runId, sources, outcome.tokens, outcome.block),
      },
      systemMessage: `mubit: ${sources} ${sources === 1 ? 'memory' : 'memories'}`
        + `${DOT}${formatTokens(outcome.tokens)} tok${DOT}${ms}ms`,
      suppressOutput: true,
    };
  },
});

// ---------------------------------------------------------------------------
// The ladder — §1.8, §5.2 steps 1-4
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Outcome
 * @property {boolean} failed
 * @property {number} rung
 * @property {string} block
 * @property {number} tokens
 * @property {number} sources
 * @property {number} dropped
 * @property {string} emptyReason
 * @property {string[]} refIds
 * @property {string} [state]   the §4.7 ConnState, on failure only
 * @property {string} [error]
 */

/**
 * Rungs 1 and 2. Rung 1 is skipped entirely while a valid policy denial is cached, which is
 * the whole point of caching it: one wasted round trip per day rather than one per prompt.
 *
 * @param {Record<string, any>} cfg
 * @param {{runId: string, agentId: string, query: string, deadline: number}} o
 * @returns {Promise<Outcome>}
 */
async function ladder(cfg, o) {
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
    // §1.8: `env_tags` exists on AgentQueryRequest but NOT on ContextRequest — version-aware
    // tag scoring is capability rungs 1-2 gain over rung 3, not something they give up.
    env_tags: envTags(cfg),
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
      return fromEvidence(cfg, res.body, 1);
    }
    if (res.status === 403) {
      // §5.2/F22: a policy verdict, not a fault. `lib/http.mjs` has already declined to
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
  return fromEvidence(cfg, res.body, 2);
}

/**
 * Rung 3 — `POST /v2/control/context`, two LLM calls, opt-in only. The server has already
 * assembled the block, so it is injected verbatim: re-assembling what two LLM calls just
 * paid for would be pure waste.
 *
 * @param {Record<string, any>} cfg
 * @param {{runId: string, agentId: string, query: string, deadline: number}} o
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
    max_token_budget: intOr(cfg.recallTokenBudget, 1500),
    limit: CONTEXT_LIMIT,
    include_working_memory: true,
    format: 'structured',
  }, { timeoutMs: budget });

  if (!res.ok) return failure(res.state, res.error, 3);

  const b = isObject(res.body) ? res.body : {};
  const block = typeof b.context_block === 'string' ? b.context_block.trim() : '';
  const refIds = Array.isArray(b.sources)
    ? [...new Set(b.sources.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()))]
    : [];
  const summaries = Array.isArray(b.section_summaries) ? b.section_summaries : [];
  const counted = summaries.reduce((n, s) => n + (isObject(s) ? numOr(s.count, 0) : 0), 0);

  return {
    failed: false,
    rung: 3,
    block,
    tokens: numOr(b.token_estimate, 0) || estimateTokens(block),
    sources: refIds.length || counted,
    dropped: numOr(b.evidence_dropped_by_budget, 0),
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
 * @param {Record<string, any>} cfg
 * @param {any} responseBody
 * @param {number} rung
 * @returns {Outcome}
 */
function fromEvidence(cfg, responseBody, rung) {
  const b = isObject(responseBody) ? responseBody : {};
  const evidence = Array.isArray(b.evidence) ? b.evidence : [];
  const a = assembleContext(evidence, { tokenBudget: intOr(cfg.recallTokenBudget, 1500) });
  return {
    failed: false,
    rung,
    block: a.block,
    tokens: a.tokenEstimate,
    sources: a.sourceRefIds.length,
    dropped: a.dropped,
    emptyReason: a.emptyReason,
    refIds: a.sourceRefIds,
  };
}

/**
 * A rung that was never run — the ladder ended without a verdict from the server. Reported
 * as an empty result rather than a failure: nothing is broken, there was simply no budget.
 * @param {number} rung @param {string} reason @returns {Outcome}
 */
function empty(rung, reason) {
  return {
    failed: false, rung, block: '', tokens: 0, sources: 0, dropped: 0,
    emptyReason: reason, refIds: [],
  };
}

/** @param {any} state @param {any} error @param {number} rung @returns {Outcome} */
function failure(state, error, rung) {
  return {
    failed: true, rung, block: '', tokens: 0, sources: 0, dropped: 0,
    emptyReason: '', refIds: [],
    state: typeof state === 'string' ? state : 'server_error',
    error: typeof error === 'string' ? error : String(error ?? ''),
  };
}

// ---------------------------------------------------------------------------
// §5.2 step 6 — the staged turn
// ---------------------------------------------------------------------------

/**
 * Write `recalled` into `runs/<run_id>/turns/<prompt_id>.json` without clobbering the
 * `prompt` / `started_at` that `stage-prompt.mjs` writes into the same file on the same
 * event (§5.3). The two hooks are separate processes with no ordering guarantee, so this is
 * read-modify-write, renamed into place — the mirror image of the merge on that side.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {string} promptId
 * @param {Record<string, any>} payload
 * @param {string[]} refIds
 * @returns {void}
 */
function persistRecalled(cfg, runId, promptId, payload, refIds) {
  try {
    if (!promptId) return;
    const file = join(resolveDataDir(cfg), 'runs', safeId(runId), 'turns', `${promptId}.json`);
    const prev = readJson(file, null);
    const base = isObject(prev) ? prev : {};

    /** @type {Record<string, any>} */
    const next = { ...base, prompt_id: promptId, recalled: [...refIds] };
    if (typeof next.session_id !== 'string') next.session_id = str(payload?.session_id);
    if (!Number.isFinite(next.started_at)) next.started_at = Date.now();

    writeJsonAtomic(file, next);
  } catch (err) {
    // §4.9: the cost of an unwritable data dir is this turn's attribution, never the prompt.
    log(cfg, 'warn', `prompt-recall: could not stage recalled ids (${messageOf(err)})`, { run_id: runId });
  }
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
// Failure bookkeeping
// ---------------------------------------------------------------------------

/**
 * §4.7/§4.8: the status line reads nothing but the marker, so a failed recall has to leave
 * a true state behind — the state as observed, with no display lens applied. The cold-start
 * grace still exists and still shows `◍ warming` over a failure, but it is resolved by
 * `bin/statusline.mjs` from the window the marker carries, which means it expires on its own
 * instead of being frozen into the record by whichever hook wrote last.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {Outcome} outcome
 * @param {number} ms
 */
function noteFailure(cfg, runId, outcome, ms) {
  const state = str(outcome.state);
  // Against `CONN_STATES` rather than a list written out here. The copy that used to live on
  // this line was one state short of the union the moment a state was added, and the effect
  // of falling off it is silent: the marker simply keeps whatever it said before.
  const known = isConnState(state);

  log(cfg, 'warn', `prompt-recall: recall failed on rung ${outcome.rung} (${state || 'unknown'})`, {
    run_id: runId, error: str(outcome.error).slice(0, 300),
  });

  updateMarker(cfg, runId, {
    // The state as observed. `bin/statusline.mjs` owns the cold-start lens and reads the
    // window from the marker, so writing `warming` here would persist a display decision
    // past the window that justified it.
    ...(known ? { state } : {}),
    last_error: str(outcome.error).slice(0, 200),
    recall: {
      sources: 0, tokens: 0, ms, empty_reason: '', rung: outcome.rung, dropped: 0,
      ...dryness(cfg, runId, false),
    },
  });
}

/**
 * §4.8 — the one field that can tell "recall is dead" from "recall found nothing this time".
 *
 * Every other field in the `recall` group describes the last call, so a path that has
 * returned nothing for forty consecutive prompts is byte-identical to a healthy one that drew
 * a blank. This counts consecutive dry recalls — empty, failed, policy-denied or skipped
 * alike — and any single hit clears it.
 *
 * It follows `lib/breaker.mjs`'s `timeoutStreak` deliberately: a counter that moves on every
 * bad event, a threshold that governs display rather than recording, and one success that
 * resets everything. What it must NOT do is become a ConnState — a recall that returns
 * nothing is not a verdict about the connection, and `CONN_STATES` is a closed union the
 * status line iterates exhaustively.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {boolean} hit did this recall actually return evidence?
 * @returns {{dry_streak: number, last_hit_at?: number}}
 */
function dryness(cfg, runId, hit) {
  if (hit) return { dry_streak: 0, last_hit_at: Date.now() };
  try {
    const prior = numOr(readMarker(cfg, runId).recall?.dry_streak, 0);
    return { dry_streak: (prior >= 0 ? prior : 0) + 1 };
  } catch {
    // §4.9: the marker is cosmetic. A read that fails costs a count, never the hook.
    return { dry_streak: 1 };
  }
}

/**
 * §5.5 step 2, as a pure read. `allowRequest()` is deliberately not used: while the breaker
 * is open it *consumes* the half-open probe, and `lib/http.mjs` asks for it again on the way
 * to the socket — so checking here with `allowRequest` would spend the probe and then refuse
 * the dial it was granted for.
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
    // Fail open: a breaker file that cannot be read must not be able to stop recall forever.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * §5.2 stdout. The wrapper names the run and states what was spent, so a user reading the
 * transcript can see where the injected block came from — and so the model can tell injected
 * memory apart from its own reasoning.
 * @param {string} runId @param {number} sources @param {number} tokens @param {string} block
 * @returns {string}
 */
function wrap(runId, sources, tokens, block) {
  return `<mubit-memory run="${runId}" sources="${sources}" tokens="${tokens}">\n`
    + `${block.replace(/\s+$/, '')}\n</mubit-memory>`;
}

/** `1187` → `1.2k`; small counts stay exact. @param {number} n @returns {string} */
function formatTokens(n) {
  const t = Math.max(0, Math.trunc(numOr(n, 0)));
  return t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
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

/** @param {any} v @returns {string} */
function safeId(v) {
  return String(v ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, MAX_ID);
}

/** @param {any} v @returns {boolean} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @param {any} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** Is this one of the §4.7 states? Asked against the exported union so this file cannot
 *  drift from it. `invalid_request` is deliberately not one — it is a caller bug, not a
 *  verdict about the connection, and must never reach the status line. */
function isConnState(v) {
  return typeof v === 'string' && /** @type {readonly string[]} */ (CONN_STATES).includes(v);
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
      recall: true, recallBudgetMs: 1500, recallTokenBudget: 1500, timeoutMs: 4000,
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
