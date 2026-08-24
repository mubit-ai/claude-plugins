#!/usr/bin/env node
// @ts-check
/**
 * `hooks/src/prompt-recall.mjs` — UserPromptSubmit, blocking (§5.2, §1.8).
 *
 * ---------------------------------------------------------------------------
 * What is here, and what moved
 * ---------------------------------------------------------------------------
 * The three-rung read ladder — and the counter-intuitive fact that
 * `/v2/control/context` is the *most* expensive rung rather than the cheapest — lives in
 * `lib/recall.mjs`, because it now has more than one caller. Read that file's header before
 * touching anything about which request gets made.
 *
 * What is left here is the part that is specific to a *user prompt*: deciding whether this
 * prompt is worth recalling against at all, deriving the run, and then writing down what the
 * injection cost and what it named so `Stop` can attribute against it (§5.5).
 *
 * ---------------------------------------------------------------------------
 * The cross-turn seen-set
 * ---------------------------------------------------------------------------
 * Recall fires before every prompt with no relevance gate, and six memories about the task
 * at hand do not stop being about the task at hand on the next prompt. So the same entries
 * were re-rendered, and re-paid for, on every prompt of a session — up to 1500 tokens each
 * time, against 356 tokens *once* for the entire MCP tool surface.
 *
 * This hook now reads `runs/<run_id>/seen.json` (`lib/seen.mjs`) before assembling and marks
 * it after, beside the ids it stages on the turn. A repeat is **degraded, not dropped**: it
 * renders as a pointer and keeps its `reference_id` in `recalled[]`, because dropping it
 * would break attribution for exactly the memories that are helping most.
 *
 * Two consequences that are easy to get wrong, both pinned by tests:
 *
 *   - **Mark only what was rendered.** A failed or empty recall marks nothing, or the next
 *     prompt points at a memory the model was never given.
 *   - **A pointer's words are not memory vocabulary.** `memoryTerms` excludes pointer lines,
 *     so a degraded turn lands in `lib/outcome.mjs`'s *unmeasured* row rather than its
 *     *injected-and-ignored* row. See the note on `memoryTerms`.
 *
 * ---------------------------------------------------------------------------
 * Carry-forward, when `recallAsync` is on
 * ---------------------------------------------------------------------------
 * With the flag set this hook stops dialing. It renders the block the PREVIOUS turn's
 * detached `recall-refresh` left in `runs/<run_id>/carry.json`, marks it seen, spawns the
 * refresh that will produce the next one, and returns — a couple of milliseconds, whatever
 * the endpoint is doing. `recallBudgetMs` stops being a number anyone has to discover.
 *
 * Two things about it are worth stating before someone "simplifies" them:
 *
 *   - **It is not `"async": true` in the manifest.** That field is real — the 2.1.235 binary
 *     describes it as "if true, hook runs in background without blocking" — but it is a
 *     *static* manifest field and cannot be conditioned on a config key. A flag expressed
 *     that way needs two registrations no-oping against each other, which is two processes
 *     per prompt for everyone, including the people who never opted in. See `lib/carry.mjs`.
 *   - **Attribution is correct by construction, not by bookkeeping.** The write happens here,
 *     on the synchronous read, with the *receiving* turn's `prompt_id` in hand. Nothing has
 *     to remember which prompt asked for the block.
 *
 * The order below is load-bearing: render, then `markSeen`, then spawn. `markSeen` is
 * synchronous and the child's `readSeen` happens a node boot later, so the refresh always
 * assembles against a set that already contains this turn's ids. Spawn first and the repeat
 * is not degraded on the next turn — the seen-set saving silently reverts, with nothing red.
 *
 * ---------------------------------------------------------------------------
 * Pinned context
 * ---------------------------------------------------------------------------
 * A pin is a standing constraint the user set for this run — "for the rest of this, don't
 * touch the vendored server". It is read from `runs/<run_id>/pins.json` (`lib/pins.mjs`) and
 * rendered by `wrap`, and three properties of that are load-bearing:
 *
 *   - **It costs zero HTTP requests.** `readPins` is one `readJson`. The network half runs in
 *     the detached drainer, which is why a pin can render inside this hook's 1500 ms budget
 *     and, more to the point, while the breaker is open.
 *   - **It renders where recall does not** — `recall: false`, a prompt under 8 characters, an
 *     open breaker, a failed recall, an empty result, no carried block. Recall is a ranked
 *     guess about what might be relevant; a pin is an instruction, and the turns where recall
 *     finds nothing are exactly the turns where the instruction is all there is. The two gates
 *     that stay closed are a slash command (addressed to the harness, not the model) and an
 *     unconfigured install (no endpoint, and no run id worth deriving a subprocess for).
 *   - **It is not memory.** Pins never enter `outcome.refIds`, so they never reach
 *     `recalled[]` or the seen-set: there is no `reference_id` to attribute a turn to, and a
 *     standing constraint degraded to `(seen earlier)` is a constraint that does nothing.
 *
 * Their cost is recorded as `recall.pin_tokens`, beside `recall.tokens` rather than inside it.
 * Folding them together would corrupt every recall-cost measurement the plugin has taken.
 *
 * ---------------------------------------------------------------------------
 * The resume briefing
 * ---------------------------------------------------------------------------
 * On the first *substantive* prompt of a session — past the length gate and past the slash
 * gate — this hook also renders the block `hooks/src/session-resume.mjs` assembled while the
 * session was starting, **above** the ordinary recall block. It is a file read, exactly like
 * carry-forward, and it is consumed once per session.
 *
 * All of it lives in three functions: `claimResume` takes and marks, `resumeWrap` renders,
 * `injection` decides the order. Reading those three, in that order, is the whole feature from
 * this side; `lib/resume.mjs` has the rest.
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

import { join } from 'node:path';

import { isPointerLine, POINTER_MARK } from '../../lib/assemble.mjs';
import { CONN_STATES, readBreaker } from '../../lib/breaker.mjs';
import { takeCarry } from '../../lib/carry.mjs';
import { isConfigured, loadConfig } from '../../lib/config.mjs';
import { runHook, spawnDetached, stashPayload } from '../../lib/hook.mjs';
import { log } from '../../lib/log.mjs';
import { readMarker, updateMarker } from '../../lib/markers.mjs';
import { readPins } from '../../lib/pins.mjs';
import { takeResume } from '../../lib/resume.mjs';
import { rankForRecall } from '../../lib/rank.mjs';
import { recallBlock } from '../../lib/recall.mjs';
import { redactText } from '../../lib/redact.mjs';
import { deriveAgentId, deriveRunId, resolveProjectDir, turnKey } from '../../lib/runid.mjs';
import { markSeen, readSeen } from '../../lib/seen.mjs';
import { readJson, resolveDataDir, safeSegment, writeJsonAtomic } from '../../lib/state.mjs';

/** §5.2 step 0: "ok", "yes", "go on" carry no retrievable intent. */
const MIN_PROMPT_CHARS = 8;

/** §5.2: recall quality does not improve past this, and a 40 KB paste is a slow embedding. */
const MAX_QUERY_CHARS = 2000;

/** U+00B7, the separator the status line and every systemMessage share. */
const DOT = ' · ';

/**
 * §5.5: how many of the injected block's own words the turn carries for the Stop-side
 * used-signal. The block is capped at ~1500 tokens, so 48 distinct terms covers the head of
 * every section that rendered; the cap exists so a pathological block cannot grow the turn
 * file without bound.
 */
const MAX_RECALL_TERMS = 48;

/**
 * A term: 4-24 characters, starting with a letter. The lower bound drops the function words
 * that carry no topic ("the", "job"); the upper bound is the first line of defence against a
 * credential becoming a term — most are longer, and `redactText` has already had the ones
 * that are not.
 */
const TERM_RE = /[A-Za-z][A-Za-z0-9_]{3,23}/g;

/** How much of the prompt is tokenised for subtraction. A 10 MB paste is a prompt too. */
const MAX_PROMPT_SCAN = 16 * 1024;

/**
 * Words that pass the shape test and mean nothing. Without them a reply that says "there
 * are three of these" would score as an echo of the memory. Deliberately short: the prompt
 * subtraction below removes far more, and every extra row here is a term the signal can no
 * longer see.
 */
const TERM_STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'always', 'another', 'because', 'been',
  'before', 'being', 'between', 'both', 'called', 'does', 'doing', 'done', 'each', 'else',
  'even', 'ever', 'every', 'from', 'have', 'here', 'html', 'http', 'https', 'into',
  'just', 'like', 'made', 'make', 'many', 'more', 'most', 'much', 'must', 'need', 'never',
  'next', 'once', 'only', 'other', 'over', 'part', 'same', 'says', 'send', 'sent', 'should',
  'since', 'some', 'such', 'take', 'than', 'that', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'thing', 'time', 'under', 'until', 'very', 'want',
  'well', 'were', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'without',
  'would', 'your',
]);

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

/**
 * An `Outcome` that recalled nothing, for the three paths that can now inject a W2-2 briefing
 * without one: a failed recall, an open breaker, and a first async prompt with no carry file.
 * A shared constant rather than a `null` check at every call site — `persistRecalled` and
 * `injection` both read six fields off it, and six optional-chains would be six places to
 * forget one.
 */
const NO_RECALL = Object.freeze({
  failed: false, rung: 0, block: '', tokens: 0, sources: 0, dropped: 0, pointers: 0,
  emptyReason: '', refIds: Object.freeze([]),
});

await runHook('prompt-recall', {
  budgetMs: HARNESS_BUDGET_MS,
  body: async (payload, _hookCfg, ctx) => {
    const cfg = CFG;
    const started = numOr(ctx?.startedAt, Date.now());
    const deadline = started + RECALL_BUDGET_MS;

    // --- §5.2 step 0. Every skip here is "dial nothing", not "dial and discard".
    // `pinsGate` keeps that promise — it reads one file — while still handing over a standing
    // constraint the user set for this run. `recall: false` turns *recall* off; it is not a
    // switch for "inject nothing ever", and the user who set it is the one most likely to be
    // leaning on a pin instead.
    if (!cfg.recall) return pinsGate(cfg, payload);
    // §4.1: with no endpoint there is nothing to recall from. Ahead of run-id derivation,
    // which can shell out to `git rev-parse` — this hook blocks every prompt, and an install
    // nobody has signed in to yet should not pay a subprocess per prompt to learn that.
    // `session-start` has already written `unconfigured` to the marker for this run.
    if (!isConfigured(cfg)) return SUPPRESS;

    const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : '';
    // "ok", "yes", "go on" carry no retrievable intent — a statement about *retrieval*. A
    // standing constraint applies to "ok, do it" exactly as much as to a paragraph.
    if (prompt.length < MIN_PROMPT_CHARS) return pinsGate(cfg, payload);
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

    // The run's pinned context. One `readJson`, before the branch, so both the carry-forward
    // path and the blocking one render from the same read.
    const pins = readPins(cfg, runId);

    // The resume briefing, consumed exactly once per session and marked seen straight away.
    // Both of those are load-bearing and both are argued on `claimResume`. It sits above every
    // branch below because all three of them render it, and below the two gates above because
    // neither a slash command nor "ok" may spend a session's briefing on a message that injects
    // no memory anywhere — a pin is not memory, which is why those two gates still answer with
    // `pinsGate` rather than with this.
    const resume = claimResume(cfg, runId);

    // §5.2 — the carry-forward path. Everything below this line dials; nothing beyond this
    // point in `carryForward` does. See the header for why the order inside it is fixed.
    if (cfg.recallAsync) return carryForward(cfg, payload, runId, started, pins, resume);

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
      // The open-breaker case is where a standing constraint matters most: recall is
      // contributing nothing at all, and the pin is the only thing between the model and the
      // mistake the user pinned it to prevent. `pinsOnly` reads no socket, so F7 still holds.
      //
      // A briefing already on disk survives the same way, and for a second reason: F7's rule is
      // about not *dialing* a server known to be down, this block was assembled before the
      // breaker tripped, and `claimResume` has already consumed it — withholding it here would
      // not save it for later, it would throw it away.
      if (!resume) return pinsOnly(cfg, pins, runId);
      persistRecalled(cfg, runId, safeId(turnKey(payload)), payload, NO_RECALL, resume);
      if (pins.text) updateMarker(cfg, runId, { recall: { pin_tokens: pins.tokens } });
      return injection(runId, NO_RECALL, resume, pins, Date.now() - started);
    }

    const query = prompt.slice(0, MAX_QUERY_CHARS);
    // §5.2 — how the server should fuse this query's scores. Read off the query text itself
    // while `recallRankBy` is `auto`: "where were we?" is a question about the most recent
    // state of the work, and default fusion weights recency at 0.10, so it answers with
    // whatever is most *similar* to those three words. The same rule runs over the same text
    // in `recall-refresh` and `subagent-start` — one explanation covers all three.
    const rankBy = rankForRecall(cfg, query);
    const promptId = safeId(turnKey(payload));
    // Resolved once, from the same rule the run id uses, so the two can never disagree
    // about which repo this prompt belongs to.
    const projectDir = resolveProjectDir(cfg, payload);

    // What this run has already put in front of the model. Read before the call so the
    // assembler can degrade a repeat into a pointer; `lib/seen.mjs` is total, so a data dir
    // that cannot be read costs the saving and nothing else.
    const seen = readSeen(cfg, runId).ids;

    const outcome = await recallBlock(cfg, {
      runId, agentId, query, deadline, seen, projectDir, rankBy,
    });

    const ms = Date.now() - started;

    if (outcome.failed) {
      noteFailure(cfg, runId, outcome, ms);
      // The briefing is unaffected by this turn's recall failing — it was assembled by another
      // process, minutes ago, and `claimResume` has already spent it. Attribution goes with it:
      // those ids reached the model in this message and no later turn will ever see them.
      if (!resume) return pinsOnly(cfg, pins, runId);
      persistRecalled(cfg, runId, promptId, payload, NO_RECALL, resume);
      if (pins.text) updateMarker(cfg, runId, { recall: { pin_tokens: pins.tokens } });
      return injection(runId, NO_RECALL, resume, pins, ms);
    }

    // §5.2 step 6: what was rendered is what `Stop` attributes against (§5.5). Written even
    // when it is empty — an absent key is a different value from an empty one downstream.
    persistRecalled(cfg, runId, promptId, payload, outcome, resume);

    // …and the same ids, rolled up per run, so the NEXT prompt can point at them instead of
    // paying for them again. After `persistRecalled` deliberately: attribution is the
    // load-bearing write and must not be behind an optimisation's bookkeeping. Only the ids
    // that actually rendered are marked — `outcome.refIds` is empty on every failed and
    // every empty recall, so nothing that never reached the model is recorded as shown.
    markSeen(cfg, runId, outcome.refIds);

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
        // Beside `tokens`, never inside it. `recall.tokens` answers "what did recall cost",
        // and a pin is not recall — folding the two together would silently corrupt every
        // per-turn cost the dashboard and `dry_streak` are built on.
        pin_tokens: pins.tokens,
        ...dryness(cfg, runId, outcome.refIds.length > 0),
      },
    });

    // §5.2: an empty result injects NOTHING — of recalled memory. A pin was not retrieved, so
    // it does not become untrue because retrieval came back empty, and a briefing was assembled
    // before this prompt existed and is not an answer to it either.
    if (!outcome.block && !resume) return pinsOnly(cfg, pins, runId, true);

    return injection(runId, outcome, resume, pins, ms);
  },
});

// ---------------------------------------------------------------------------
// §5.2 — carry-forward (`recallAsync`)
// ---------------------------------------------------------------------------

/**
 * The whole of the flag's synchronous half: read one file, render it, record it, start the
 * refresh that fills the file again. No socket, no deadline, nothing that can time out.
 *
 * The four steps happen in this order and the order is not incidental:
 *
 *   1. **`takeCarry` consumes.** A block is injectable exactly once. A refresh that stops
 *      answering must not leave the last good block to be re-injected on every prompt for
 *      the rest of the session (`lib/carry.mjs`).
 *   2. **`persistRecalled` against THIS `prompt_id`.** This is where the handoff's stated
 *      hard part goes away: the ids are staged by the process that just handed the block to
 *      the model, so they land on the turn that received it. `Stop` then reinforces exactly
 *      the memories that were in front of the model when it answered.
 *   3. **`markSeen`, before the spawn.** It is synchronous; the child's `readSeen` is a node
 *      boot away. Do it after the spawn and the refresh assembles against a stale set, the
 *      repeat is re-sent in full next turn, and the HS-3 saving reverts with nothing red.
 *   4. **Spawn, unless the breaker is open.** A block already on disk is rendered either
 *      way — it cost a round trip nobody should pay twice — but F7's rule still holds for
 *      the dial: no process per prompt against a server already known to be down.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} payload
 * @param {string} runId
 * @param {number} started
 * @param {import('../../lib/pins.mjs').PinBlock} pins
 * @param {import('../../lib/resume.mjs').Resumed|null} [resume]
 * @returns {Record<string, any>}
 */
function carryForward(cfg, payload, runId, started, pins, resume = null) {
  const promptId = safeId(turnKey(payload));
  const carry = takeCarry(cfg, runId);
  const rendered = !!(carry && carry.block);

  if (rendered || resume) {
    persistRecalled(cfg, runId, promptId, payload, rendered ? carry : NO_RECALL, resume);
  }
  if (rendered) markSeen(cfg, runId, carry.refIds);

  const open = breakerOpen(cfg);
  const b = open ? readBreaker(cfg) : null;
  const ms = Date.now() - started;

  updateMarker(cfg, runId, {
    mode: cfg.mode,
    // The connection state is the refresh's to write — it is the process that dials. The one
    // exception is a verdict this side can read for itself off the breaker file.
    ...(open && isConnState(b?.state) ? { state: b.state } : {}),
    recall: {
      sources: rendered ? carry.refIds.length : 0,
      tokens: rendered ? carry.tokens : 0,
      // What the PROMPT paid, which under this flag is a file read. The endpoint's own
      // latency is in `carry.json` as `fetch_ms`; separating the two is the measurement.
      ms,
      rung: rendered ? carry.rung : 0,
      dropped: rendered ? carry.dropped : 0,
      // Literally what happened: no previous turn left a block for this one. Named rather
      // than blank, because a blank `empty_reason` under this flag is indistinguishable from
      // a recall path that has quietly died. It deliberately does NOT say *why* — the
      // ordinary first prompt of a session and a refresh that has been failing for ten
      // prompts both land here, and `state` plus `dry_streak` are what tell them apart:
      // `ready` with a streak of 1 is priming, `not_responding` with a climbing streak is
      // the endpoint. A name that guessed between them would send half the readers to the
      // wrong fix.
      empty_reason: rendered
        ? carry.emptyReason
        : (open ? 'breaker_open' : 'async_no_carry'),
      pin_tokens: pins.tokens,
      ...dryness(cfg, runId, rendered),
    },
  });

  if (open) {
    log(cfg, 'debug', 'prompt-recall: breaker open; carrying nothing forward', { run_id: runId });
  } else {
    spawnRefresh(cfg, payload, runId);
  }

  // The first prompt of an async session has no carried block by construction. A pin is not
  // carried — it was read from disk a moment ago — so it renders on that prompt too, and so
  // does a briefing, which a different process assembled before any of this ran.
  if (!rendered && !resume) return pinsOnly(cfg, pins, runId, true);

  return injection(runId, rendered ? carry : NO_RECALL, resume, pins, ms, true);
}

// ---------------------------------------------------------------------------
// The resume briefing
// ---------------------------------------------------------------------------

/**
 * Take this session's briefing, and record that the model is about to be shown it.
 *
 * Three decisions live in these few lines and each of them is silent when it is wrong.
 *
 *   1. **The renderer marks, not the assembler.** `hooks/src/session-resume.mjs` writes the
 *      block and nothing that describes what the model saw, for the reason
 *      `recall-refresh.mjs:22-31` gives at length: a process that has shown nothing to anyone
 *      must not record entries as shown. That argument is stronger for a briefing than for a
 *      carried block — a carried block is rendered on the very next prompt, while a briefing
 *      has a whole session's worth of ways never to be rendered at all.
 *   2. **It marks BEFORE this turn's recall assembles.** `readSeen` runs a few lines below, so
 *      an entry that is in both renders in **full** in the briefing above and as a **pointer**
 *      in the recall block below. That is accurate rather than merely cheap: the briefing
 *      really is earlier in the same message, so the pointer's promise — "this was injected in
 *      full earlier" — is true. Mark after the assembly instead and the same 200 tokens are
 *      sent twice in one message, with nothing red.
 *   3. **The gate is on the read as well as on the write.** An operator who turns the feature
 *      off gets it off on the next prompt, rather than after whatever a previous session
 *      already staged has been spent.
 *
 * `takeResume` is consume-once and total, so this is safe to call on every prompt for the
 * whole life of a session: the second call and every one after it answer `null`.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {import('../../lib/resume.mjs').Resumed|null}
 */
function claimResume(cfg, runId) {
  try {
    if (!cfg.resumeBlock) return null;
    const resume = takeResume(cfg, runId);
    if (!resume) return null;
    markSeen(cfg, runId, resume.refIds);
    log(cfg, 'debug', `prompt-recall: rendering the session briefing (${resume.refIds.length} sources)`,
      { run_id: runId });
    return resume;
  } catch {
    // §4.9: a briefing is worth a session's opening summary, never a prompt.
    return null;
  }
}

/**
 * Fire `recall-refresh` and forget about it — the same call `stage-prompt.mjs` makes to start
 * the drain, and for the same reason: the payload travels through a file because a detached
 * child's inherited stdin is not reliably readable once this process exits, and this process
 * exits within milliseconds.
 *
 * A refresh that could not be started costs the *next* prompt its recall and nothing else.
 * The one after it tries again, because every prompt spawns one.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} payload
 * @param {string} runId
 * @returns {void}
 */
function spawnRefresh(cfg, payload, runId) {
  try {
    const payloadPath = stashPayload(cfg, payload);
    if (!payloadPath) {
      log(cfg, 'warn', 'prompt-recall: could not stage the refresh payload; the next prompt '
        + 'recalls nothing', { run_id: runId });
      return;
    }
    spawnDetached(cfg, 'recall-refresh', [], payloadPath);
    log(cfg, 'debug', 'prompt-recall: refresh spawned', { run_id: runId });
  } catch (err) {
    log(cfg, 'warn', `prompt-recall: could not start the refresh (${messageOf(err)})`,
      { run_id: runId });
  }
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
 * ---------------------------------------------------------------------------
 * `recall`: the cost half of precision, and why it belongs on the TURN
 * ---------------------------------------------------------------------------
 * Everything in it was already computed a few lines above and then thrown away. The marker
 * keeps the same numbers, but the marker is last-write-wins per RUN: a forty-prompt session
 * leaves exactly one record, so "what did an injection cost" is answerable only for whichever
 * prompt happened to be last. Recall fires on every prompt over 8 characters with no
 * relevance gate; the cost of that is measured (191 tokens a turn) and the return on it is
 * not. This is the denominator — `Stop` writes the numerator into the same file (§5.5).
 *
 * `terms` is the injected block's own vocabulary MINUS the prompt's, because that subtraction
 * is what makes the Stop-side signal mean anything: a word the user typed would have come
 * back in the reply with no memory involved at all. It is done here, where the prompt is in
 * hand, rather than re-derived at Stop from a file that may have been truncated.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {string} promptId
 * @param {Record<string, any>} payload
 * @param {Outcome} outcome
 * @returns {void}
 */
function persistRecalled(cfg, runId, promptId, payload, outcome, resume = null) {
  try {
    if (!promptId) return;
    const file = join(resolveDataDir(cfg), 'runs', safeId(runId), 'turns', `${promptId}.json`);
    const prev = readJson(file, null);
    const base = isObject(prev) ? prev : {};

    /** @type {Record<string, any>} */
    const next = {
      ...base,
      prompt_id: promptId,
      // The standing lessons injected at session start ride along on the first turn that
      // stages ids, so that they too can be reinforced or corrected. Deduped: the same
      // entry reached through two lanes must not be reinforced twice for one turn.
      recalled: [...new Set([
        ...claimStandingLessons(cfg, runId),
        ...(resume ? resume.refIds : []),
        ...outcome.refIds,
      ])],
      recall: {
        at: Date.now(),
        rung: outcome.rung,
        sources: (outcome.refIds.length || outcome.sources)
          + (resume ? (resume.refIds.length || resume.sources) : 0),
        tokens: outcome.tokens + (resume ? resume.tokens : 0),
        // The token figure is a four-chars-per-token estimate (§4.10). Characters are what
        // was actually injected, so a later reader can re-derive the estimate rather than
        // inherit it.
        chars: outcome.block.length + (resume ? resume.block.length : 0),
        dropped: outcome.dropped,
        // How many of `sources` were repeats the model already had. Without it a smaller
        // `tokens` is unattributable — a block that shrank because the seen-set worked and
        // one that shrank because recall found half as much read identically.
        pointers: outcome.pointers,
        empty_reason: outcome.emptyReason,
        terms: memoryTerms(cfg, [resume?.block ?? '', outcome.block], str(payload?.prompt)),
      },
    };
    if (typeof next.session_id !== 'string') next.session_id = str(payload?.session_id);
    if (!Number.isFinite(next.started_at)) next.started_at = Date.now();

    writeJsonAtomic(file, next);
  } catch (err) {
    // §4.9: the cost of an unwritable data dir is this turn's attribution, never the prompt.
    log(cfg, 'warn', `prompt-recall: could not stage recalled ids (${messageOf(err)})`, { run_id: runId });
  }
}

/**
 * The words the memory contributed and the prompt did not, in render order (so the sections
 * that fill first — mental models, then rules — are the ones that survive the cap).
 *
 * ---------------------------------------------------------------------------
 * Only the rendered entries, and only the ones sent in full
 * ---------------------------------------------------------------------------
 * Two kinds of line in the block are not memory vocabulary, and counting either of them
 * turns a working memory into a measured failure:
 *
 *   - **Section headings.** "Active rules", "Lessons", "Facts" are words this plugin prints,
 *     not words a memory contributed. A reply that happens to say "rules" would score as an
 *     echo of memory that was never read.
 *   - **Pointer lines.** A degraded repeat carries a `reference_id` and a clause, and the
 *     model has no reason to echo a reference id — so a pointer-only turn would stage a term
 *     set that is guaranteed to miss. `capture --stop` would then record `used: false`, and
 *     `lib/outcome.mjs` row 3 would file a `neutral` against every memory relevant enough to
 *     keep surfacing. With the pointers excluded the turn stages no terms at all, lands on
 *     `reason: 'no_distinct_terms'`, and is correctly read as **unmeasured** (row 4).
 *
 * A rung-3 block is the server's own rendering and has no bullets to trust, so there only
 * the headings are dropped. It cannot carry pointers: rung 3 assembles server-side.
 *
 * §4.4: the block is scrubbed before any of it is written down. Evidence content is not
 * necessarily this plugin's own redacted capture — another client, or `mubit_remember`, can
 * put anything in the store — and the turn file is a new place for a secret to land. The
 * `[REDACTED:…]` placeholders are then dropped rather than tokenised: "redacted" is not
 * memory vocabulary, and a reply that happened to contain the word would score as an echo.
 *
 * @param {Record<string, any>} cfg
 * @param {string} block
 * @param {string} prompt
 * @returns {string[]}
 */
function memoryTerms(cfg, blocks, prompt) {
  try {
    let text = blocks.filter(Boolean).map(vocabularyOf).filter(Boolean).join('\n');
    if (!text) return [];
    try {
      text = str(redactText(text, cfg, 'output')?.text) || '';
    } catch {
      // A scrub that threw is not a licence to write the raw block's words down.
      return [];
    }
    text = text.replace(/\[REDACTED:[^\]]*\]/gi, ' ');

    const fromPrompt = termSet(prompt.slice(0, MAX_PROMPT_SCAN));
    /** @type {string[]} */
    const out = [];
    const seen = new Set();
    for (const m of text.matchAll(TERM_RE)) {
      const t = m[0].toLowerCase();
      if (seen.has(t) || fromPrompt.has(t) || TERM_STOPWORDS.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= MAX_RECALL_TERMS) break;
    }
    return out;
  } catch {
    // A turn with no terms is measured as "unmeasurable" downstream, never as "unused".
    return [];
  }
}

/**
 * The ids of the standing lessons `session-start` injected, taken once per session.
 *
 * They are handed to the model in the same breath as recalled memory and act on the same
 * turn, but they never passed through recall, so nothing ever put them in front of the
 * attribution machinery: they could not be reinforced when a session went well, and — the
 * part that matters — could not be corrected when a wrong one steered a session into the
 * ground. Crediting them on the first turn that stages ids puts them under exactly the rule
 * every recalled item already lives by.
 *
 * `credited_at` is stamped before the ids are returned, so a second prompt in the same
 * session does not reinforce them again.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {string[]}
 */
function claimStandingLessons(cfg, runId) {
  try {
    const lessons = readMarker(cfg, runId).lessons;
    if (!isObject(lessons) || numOr(lessons.credited_at, 0) > 0) return [];
    const ids = Array.isArray(lessons.injected_ids)
      ? lessons.injected_ids.filter((v) => typeof v === 'string' && v.trim())
      : [];
    if (!ids.length) return [];
    updateMarker(cfg, runId, { lessons: { credited_at: Date.now() } });
    return ids;
  } catch {
    // Attribution is worth a turn's ids, never a turn.
    return [];
  }
}

/**
 * The rendered entries' own text: bullets only, pointer lines excluded, and the leading
 * markers stripped so `(stale)` is not vocabulary either. See the note on `memoryTerms`.
 * @param {string} block
 * @returns {string}
 */
function vocabularyOf(block) {
  const lines = String(block ?? '').split('\n');
  const bullets = lines.filter((l) => l.startsWith('- '));
  // A block with no bullets was assembled somewhere else (rung 3). Drop the headings, which
  // are structure in any rendering, and trust the rest.
  if (bullets.length === 0) return lines.filter((l) => !l.startsWith('#')).join('\n');
  return bullets
    .filter((l) => !isPointerLine(l))
    .map((l) => l.slice(2).replace(/^\(stale\)\s+/, ''))
    .join('\n');
}

/** @param {string} s @returns {Set<string>} */
function termSet(s) {
  const set = new Set();
  for (const m of String(s ?? '').matchAll(TERM_RE)) set.add(m[0].toLowerCase());
  return set;
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
 * The one place this hook builds its stdout, shared by every path that injects anything.
 *
 * There are up to two elements and the order between them is fixed: the **briefing first**,
 * then this turn's recall. The briefing is the older and wider context — it is about the run,
 * assembled before the conversation started — and below the recall block a model reads it as
 * an afterthought to a question it was never about. It is also what makes a pointer in the
 * recall block honest: the full text really is earlier in the same message.
 *
 * Pins are not a third element. They render inside `wrap`, above its caveat, because a pin is
 * a standing instruction rather than a retrieved memory and must not be read under a sentence
 * that says it may be out of date. That also means a turn with pins and nothing else still
 * emits a `<mubit-memory>` envelope, with an empty block — which is what `pinsOnly` asks for.
 *
 * The counts are summed rather than reported separately. `systemMessage` is one line by
 * contract, and "how much memory is in front of me and what did it cost" is one question; the
 * `· resume` and `· N pinned` suffixes say what else was in the message, once, and only on the
 * turns that carried one.
 *
 * @param {string} runId
 * @param {Outcome} outcome           this turn's recall; `NO_RECALL` when there was none
 * @param {import('../../lib/resume.mjs').Resumed|null} resume
 * @param {import('../../lib/pins.mjs').PinBlock} pins
 * @param {number} ms
 * @param {boolean} [carried]  the recall block came from the previous turn's refresh
 * @returns {Record<string, any>}
 */
function injection(runId, outcome, resume, pins, ms, carried = false) {
  const recallSources = outcome.refIds.length || outcome.sources;
  const resumeSources = resume ? (resume.refIds.length || resume.sources) : 0;
  const sources = recallSources + resumeSources;
  const tokens = outcome.tokens + (resume ? resume.tokens : 0);
  const pinned = pins && pins.text ? pins : null;

  const parts = [];
  if (resume) parts.push(resumeWrap(runId, resumeSources, resume.tokens, resume.block));
  if (outcome.block || pinned) {
    parts.push(
      wrap(runId, recallSources, outcome.tokens, outcome.block, outcome.pointers, carried, pinned));
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: parts.join('\n'),
    },
    systemMessage: `mubit: ${sources} ${sources === 1 ? 'memory' : 'memories'}`
      + `${DOT}${formatTokens(tokens)} tok${DOT}${ms}ms`
      + `${resume ? `${DOT}resume` : ''}`
      + `${pinned ? `${DOT}${pinned.pins.length} pinned` : ''}`,
    suppressOutput: true,
  };
}

/**
 * W2-2 stdout. The briefing `hooks/src/session-resume.mjs` assembled at the start of this
 * session, wrapped in the two sentences it cannot be read correctly without.
 *
 * **When it was assembled.** This block predates every message in the conversation, including
 * the one it is being injected into. Without that stated, the model reads a summary of last
 * Tuesday's work as this plugin's answer to the question just typed — and then either acts on
 * it or concludes that memory is unreliable. Neither is recoverable from inside the turn.
 *
 * **That it is not a task list.** This is the single most likely misfire, and it is the
 * expensive one. "The ingest drain was left mid-batch" is a description of a past state; a
 * model given it under a heading, at the top of a session, with no instruction attached, will
 * reasonably infer that finishing it is the job. Nobody asked for any of it. One sentence
 * turns a to-do list back into a briefing, and it is the cheapest twenty tokens in the file.
 *
 * The element name is deliberately not `<mubit-memory>`: these two blocks make different
 * claims and the model has to be able to tell which sentence governs which text.
 *
 * @param {string} runId @param {number} sources @param {number} tokens @param {string} block
 * @returns {string}
 */
function resumeWrap(runId, sources, tokens, block) {
  return `<mubit-resume run="${runId}" sources="${sources}" tokens="${tokens}">\n`
    + 'Assembled from memory at the start of this session, before this or any other message '
    + 'in the conversation — it describes where earlier work on this project left off, not the '
    + 'message you were just sent.\n'
    + 'It is a briefing and not a task list: nothing in it has been asked for, it may be '
    + 'incomplete or out of date, and anything here that still looks worth doing should be '
    + 'confirmed against the code and with the user before you act on it.\n'
    + `\n${block.replace(/\s+$/, '')}\n</mubit-resume>`;
}

/**
 * The pinned block on a turn where recall contributed nothing — and `{suppressOutput: true}`
 * when there is nothing pinned either.
 *
 * Every gate in this hook that used to return `SUPPRESS` now returns this instead, which is
 * the whole of the "pins render where recall does not" rule. The read has already happened;
 * this only decides whether there is anything to say.
 *
 * `pin_tokens` is stamped here rather than left to the caller because these are the paths
 * where nothing else writes the `recall` group — a pinned turn under `recall: false` would
 * otherwise be invisible in the one file that measures what injection costs.
 *
 * @param {Record<string, any>} cfg
 * @param {import('../../lib/pins.mjs').PinBlock} pins
 * @param {string} runId
 * @param {boolean} [stamped]  the caller has already written `pin_tokens` onto the marker
 * @returns {Record<string, any>}
 */
function pinsOnly(cfg, pins, runId, stamped = false) {
  if (!pins || !pins.text) return SUPPRESS;
  if (!stamped) updateMarker(cfg, runId, { recall: { pin_tokens: pins.tokens } });
  const n = pins.pins.length;
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: wrap(runId, 0, 0, '', 0, false, pins),
    },
    systemMessage: `mubit: ${n} pinned${DOT}${formatTokens(pins.tokens)} tok`,
    suppressOutput: true,
  };
}

/**
 * The same thing for the two gates that fire *before* the run id has been derived.
 *
 * They are left in their original order deliberately: `!cfg.recall` and the 8-character floor
 * both used to return before any derivation, and moving them below it would put a possible
 * `git rev-parse` in front of every two-word prompt for everyone. Deriving lazily, only on the
 * gate that is actually taken, keeps that cost exactly where it already was on the main path.
 *
 * A derivation that cannot answer is not an error here — it is a run with no pins.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} payload
 * @returns {Record<string, any>}
 */
function pinsGate(cfg, payload) {
  try {
    const runId = deriveRunId(cfg, payload);
    return pinsOnly(cfg, readPins(cfg, runId), runId);
  } catch {
    // `static` with no pin, or a derivation that could only have answered "default" (§4.3).
    return SUPPRESS;
  }
}

/**
 * §5.2 stdout. The wrapper names the run and states what was spent, so a user reading the
 * transcript can see where the injected block came from — and so the model can tell injected
 * memory apart from its own reasoning.
 *
 * It also says, once, what this block is not. Retrieval is a ranked guess over a token
 * budget: items get dropped, an entry can be stale, and nothing here was re-checked against
 * the repository as it stands right now. Rendered without that line, a bullet under
 * "Active rules" reads with the authority of a project invariant, and the model will act on
 * a year-old one rather than look. One sentence is the whole fix.
 *
 * A block carrying pointers says so, once, and only when it carries one. A line that names
 * a memory without carrying it reads exactly like a memory that was truncated, and a model
 * that reads it that way will either ignore it or invent the rest. Roughly twenty tokens to
 * make the other ~180 legible; on a block with nothing degraded it is not spent at all.
 *
 * A carried-forward block says *that*, too, and only under `recallAsync`. It was retrieved
 * against the previous message, so without the line the model reads a block about the last
 * question as an answer to this one — and quietly concludes that recall is unreliable rather
 * than that it is one turn behind. One turn of staleness is the mode's whole cost; stating it
 * is far cheaper than hiding it.
 *
 * ---------------------------------------------------------------------------
 * Pins go ABOVE the caveat, and the caveat is conditional
 * ---------------------------------------------------------------------------
 * The "may be incomplete or out of date" line is about *retrieved* memory: a ranked guess
 * over a token budget, possibly stale, never re-checked against the tree. A pin is none of
 * those things — the user typed it a minute ago and it is true until they clear it. A model
 * that reads the caveat as covering the pin will second-guess a standing constraint, which is
 * the exact opposite of the point. Above it is the only placement where it does not.
 *
 * The caveat, the carried-block note and the pointer note are all conditional on there being
 * a recalled block at all, because on a pins-only turn each of them describes an absence.
 *
 * The one clause that separates the two renders only when recalled memory follows: it is
 * ~15 tokens spent telling them apart, and on a pins-only turn there is nothing to tell apart.
 *
 * **Not in `lib/assemble.mjs`.** Three reasons, each sufficient. `assembleContext`'s contract
 * is that it reproduces what the server's rung 3 would render, and a client-only section
 * inside it breaks that. Under `recallAssemble: server` rung 3 never passes through it, so
 * pins would silently vanish for those users. And inside it a pin would be subject to the
 * seen-set — a pin degraded to `(seen earlier)` is a pin that does nothing.
 *
 * @param {string} runId @param {number} sources @param {number} tokens @param {string} block
 * @param {number} [pointers]
 * @param {boolean} [carried]  the block came from the previous turn's refresh
 * @param {import('../../lib/pins.mjs').PinBlock|null} [pins]  the run's standing constraints
 * @returns {string}
 */
function wrap(runId, sources, tokens, block, pointers = 0, carried = false, pins = null) {
  const pinned = pins && pins.text ? pins : null;
  const recalled = typeof block === 'string' && block !== '';
  return `<mubit-memory run="${runId}" sources="${sources}" tokens="${tokens}"`
    // Only when there are pins, so a user who has none gets the envelope they have always had.
    + `${pinned ? ` pins="${pinned.pins.length}"` : ''}>\n`
    + (pinned
      ? `${pinned.text}${recalled
        ? 'Those were pinned for this run and hold until they are cleared. Everything below '
          + 'them was retrieved for this prompt.\n'
        : ''}`
      : '')
    + (recalled
      ? 'Recalled from memory of earlier work — it may be incomplete or out of date, so verify '
        + 'against the code before relying on it.\n'
      : '')
    + (recalled && carried
      ? 'It was retrieved against the previous message in this conversation, not this one, '
        + 'so treat it as background rather than as an answer to what was just asked.\n'
      : '')
    + (recalled && pointers > 0
      ? `A line marked "${POINTER_MARK}" was injected in full earlier in this conversation `
        + 'and is repeated here only as a reference; ask mubit_dereference for its text.\n'
      : '')
    + (recalled ? `\n${block.replace(/\s+$/, '')}\n` : '')
    + '</mubit-memory>';
}

/** `1187` → `1.2k`; small counts stay exact. @param {number} n @returns {string} */
function formatTokens(n) {
  const t = Math.max(0, Math.trunc(numOr(n, 0)));
  return t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** @param {any} v @returns {string} */
function safeId(v) {
  return safeSegment(v, MAX_ID);
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
