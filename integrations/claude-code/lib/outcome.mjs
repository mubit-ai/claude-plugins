// @ts-check
/**
 * `lib/outcome.mjs` — a staged turn -> the one implicit `/v2/control/outcome` record it
 * deserves, or a clear "post nothing".
 *
 * The outcome call and its four cases, the flush of
 * turns the drain never reached), §1.3 (`reference_id` must be non-empty), §6.1
 * (`outcomeMode`).
 *
 * ---------------------------------------------------------------------------
 * Why this is a module and not a function each hook keeps a copy of
 * ---------------------------------------------------------------------------
 * **Two hooks post this record.** `drain.mjs` attributes a turn as it ends; `session-end.mjs`
 * flushes the turns the drain never reached — a drainer that stood down, an endpoint that was
 * down, a session that ended first. They are separate esbuild entry points and must never
 * import one another, so before this module the rule existed twice, and the two copies
 * disagreed: `drain` learned to tell an ignored injection from an unmeasured one, and the
 * SessionEnd flush kept posting `success`/+0.2 with `entry_ids` for everything.
 *
 * Neither hook looked wrong on its own, because they never fire for the same turn. What came
 * out was a run whose outcome series silently mixed two definitions of the same measurement,
 * with nothing on the wire to say which record came from which — worse than either rule
 * applied consistently, and invisible in exactly the way a measurement bug is worst.
 *
 * So the constants, the decision and the rationale text live here once. `decideOutcome` is a
 * pure function of the turn object — no clock, no config, no socket, no mutation of its
 * input — which is what lets both hooks be tested against the same table.
 *
 * Zero dependencies, Node >= 20 built-ins only, synchronous, and nothing here throws.
 */

/**
 * §5.5: "the implicit signal is deliberately weak (0.2, not 1.0) — a turn completing is not
 * proof the recalled memory helped, only weak positive evidence." A failed turn is stronger
 * evidence in the other direction, but still an inference, not a user verdict.
 *
 * They are spent only on turns where `capture --stop` found the injected memory's own
 * vocabulary in the reply, or on turns from before that signal existed. "A turn completed"
 * was never evidence about the *memory* — it is a fact about the session that happened to be
 * in scope.
 */
export const SIGNAL_SUCCESS = 0.2;
export const SIGNAL_FAILURE = -0.3;

/**
 * The third case: memory WAS injected and the reply shows no sign of it.
 *
 * Until this existed, that turn and a turn where nothing was injected at all were the same
 * thing on the wire — silence — so the denominator of any precision number never left the
 * machine. It is recorded as `neutral` at exactly 0.0:
 *
 *   - not a penalty, because the signal behind it is dominated by false negatives (see
 *     `capture.mjs`); punishing a memory the model may well have followed silently would make
 *     the store worse in the name of measuring it;
 *   - **and with an empty `entry_ids[]`** — see `decideOutcome`. Naming entries on this path
 *     would credit precisely the ones we have no evidence were read, which is the opposite
 *     of what attribution is for.
 *
 * `neutral` is one of the four outcomes the endpoint accepts (success, failure, partial,
 * neutral); anything else is a 400 for the whole call.
 */
export const OUTCOME_UNUSED = 'neutral';
export const SIGNAL_UNUSED = 0;

export const OUTCOME_SUCCESS = 'success';
export const OUTCOME_FAILURE = 'failure';

/**
 * `reference_id` must be non-empty on an outcome, so run-level attribution uses
 * this sentinel and puts the real ids in `entry_ids[]` — where each one is reinforced
 * individually (`control.proto`).
 */
export const RUN_LEVEL_REFERENCE = 'global';

/**
 * How many times one turn's outcome may be posted before the client gives up on it.
 *
 * The post is claim-then-send: `capture --stop` marks the turn pending and only a *response*
 * clears it, so a post the server accepted but answered past the client deadline is
 * indistinguishable from one that never arrived — and gets sent again by the next drain, and
 * again by the session-end flush. The stable `idempotency_key` below is what is supposed to
 * collapse those, but that is a property of the other end which this process never observes,
 * and the thing being spent on faith is reinforcement: the signal that decides what memory is
 * worth keeping.
 *
 * Three rides out a restart and a slow server; past that the signal is worth less than the
 * risk of counting one turn several times.
 */
export const MAX_OUTCOME_ATTEMPTS = 3;

/**
 * The turn-file key `capture --stop-failure` stamps when the host reports the turn ended on
 * an API error, and the fifth row of the table below.
 *
 * It is a key of its own rather than `outcome: "failure"` — which is what the original design
 * originally prescribed ("On a StopFailure turn: outcome: 'failure', signal: -0.3") — because
 * the two mean opposite things about the memory. `outcome: "failure"` says the work went
 * badly, which is weak evidence against whatever was recalled. `api_error` says the turn
 * never got to finish, which is evidence about nothing at all.
 */
export const API_ERROR_KEY = 'api_error';

/**
 * §6.1: the two `outcomeMode` values that silence the implicit path.
 *
 * `off` disables implicit attribution altogether. `explicit` hands the call to the model
 * through `mubit_outcome`, so a hook firing one as well would dilute the model's deliberate
 * judgement with an automatic 0.2. The neutral record is implicit attribution as much as the
 * +0.2 is and gets no exemption: a user who turned this off did not ask to be measured
 * either.
 */
const SILENCED_MODES = new Set(['off', 'explicit']);

/**
 * May this hook post an implicit outcome at all?
 *
 * `loadConfig` pins `outcomeMode` to `off | implicit | explicit` and defaults it to
 * `implicit`, so anything else here is a config that never loaded — and the safe reading of
 * "unrecognised" is the documented default, not silence. Silence would be a plugin that
 * measures nothing and says nothing about why.
 *
 * @param {Record<string, any>|null|undefined} cfg
 * @returns {boolean}
 */
export function implicitOutcomesEnabled(cfg) {
  const mode = str(cfg && typeof cfg === 'object' ? /** @type {any} */ (cfg).outcomeMode : '')
    .toLowerCase();
  return !SILENCED_MODES.has(mode);
}

/**
 * @typedef {object} OutcomeDecision
 * @property {boolean} post
 * @property {string} [reason]      why nothing is posted, for the log line
 * @property {string} [outcome]     one of the four the endpoint accepts
 * @property {number} [signal]
 * @property {string[]} [entryIds]  what to reinforce — deliberately EMPTY on a neutral record
 * @property {string} [rationale]
 */

/**
 * §5.5 step 7: what to post for one staged turn.
 *
 * | turn | posted |
 * | --- | --- |
 * | nothing injected | nothing |
 * | the API killed the turn (`api_error`) | nothing |
 * | injected, the reply carried the memory's vocabulary | `success` +0.2 / `failure` -0.3, with `entry_ids` |
 * | injected, the reply carried none of it | `neutral` 0.0, with an empty `entry_ids` |
 * | injected, but the signal could not be computed | as before: `success` +0.2 / `failure` -0.3 |
 *
 * **Row 1 is what makes row 4 legible.** A turn that recalled nothing is never sent with an
 * empty `recalled[]`: an outcome attributed to nothing is a wasted round trip that also
 * pollutes the run-level signal history the reflect path reads. Because that call is skipped,
 * "no post" means one thing and one thing only — *nothing was injected* — and the neutral
 * record is the only way "injected and unused" reaches the wire.
 *
 * **Row 2 posts nothing rather than a `neutral`, and that was the whole decision.**
 * A turn that ended on `rate_limit`, `overloaded` or `max_output_tokens` did not fail because
 * the recalled memory was wrong, so the failure branch is plainly out. `neutral` looks like
 * the safe middle and is not, for two reasons that compound:
 *
 *   - `neutral` is not "no opinion". It is a specific claim — *memory was injected and the
 *     reply shows no sign of it* — and it is already the hardest row to read, because the
 *     signal behind it is dominated by false negatives. Filing API failures under it mixes
 *     "the model ignored this memory" with "the endpoint fell over" in one bucket, with
 *     nothing on the wire to separate them afterwards. Row 4 is the denominator of any
 *     precision number this plugin can produce; diluting it costs the measurement the whole
 *     used-signal was built to make possible.
 *   - Every record still costs a round trip and a row in the run-level signal history the
 *     reflect path reads. A rate limit rarely arrives alone — one throttled minute can be
 *     several turns — so the failure mode is a burst of records that say nothing, precisely
 *     when the endpoint is least able to absorb them.
 *
 * Suppression loses one thing, and it is worth naming: the count of turns lost to API errors
 * never leaves the machine. It stays on the turn file (`api_error`, alongside `ended_at`),
 * where `scripts/mubit-inspect.mjs` prints it per prompt — local diagnosis, not reinforcement.
 *
 * **Row 5 is not a hedge.** A turn staged before the used-signal existed, or one whose every
 * distinctive term was already in the user's prompt, was never measured. Reading that as "the
 * model ignored it" would invent a denominator, so it keeps the old behaviour — which is why
 * `used` is compared strictly against `false`: an absent key is "unmeasured" and must not
 * fall into the same branch as a measured `false`.
 *
 * The turn is read, never written: the caller owns the file, and a decision that quietly
 * edited its input could not be run twice.
 *
 * @param {Record<string, any>|null|undefined} turn  the parsed `turns/<prompt_id>.json`
 * @returns {OutcomeDecision}
 */
export function decideOutcome(turn) {
  if (!isObject(turn)) return { post: false, reason: 'not_a_turn' };

  // Already attributed by an earlier drain or flush. The stable key below makes a re-post a
  // server-side no-op anyway, but there is no reason to spend the round trip.
  if (numOr(turn.outcome_sent_at, 0) > 0) return { post: false, reason: 'already_sent' };

  // Row 2 — the turn ended on an API error. `capture --stop-failure` is the only writer of
  // this key, and it writes it because `StopFailure` fires *instead of* `Stop`: without it
  // the turn would look like an ordinary unmeasured one and post +0.2 against ids the model
  // never got to use.
  //
  // Checked before `attempts_exhausted` on purpose: a turn nothing will ever dial must never
  // accumulate a dial count, and `attempts_exhausted` is the one reason a caller acts on by
  // marking the turn abandoned — a state that would misreport this as three failed posts.
  if (str(turn[API_ERROR_KEY])) return { post: false, reason: 'api_failed' };

  // Posted, never answered, repeatedly. The caller marks the turn abandoned on this reason —
  // this module reads the turn and never writes it.
  if (numOr(turn.outcome_attempts, 0) >= MAX_OUTCOME_ATTEMPTS) {
    return { post: false, reason: 'attempts_exhausted' };
  }

  const entryIds = Array.isArray(turn.recalled)
    ? turn.recalled.filter((v) => typeof v === 'string' && v.trim())
    : [];
  if (entryIds.length === 0) return { post: false, reason: 'nothing_injected' };

  // The turn file records how the turn ended, so neither hook has to re-derive it.
  const failed = str(turn.outcome).toLowerCase() === 'failure';
  const ev = isObject(turn.used_evidence) ? turn.used_evidence : {};
  // Strictly a boolean, never truthiness — see the docblock above.
  const unused = ev.used === false;

  return {
    post: true,
    outcome: unused ? OUTCOME_UNUSED : (failed ? OUTCOME_FAILURE : OUTCOME_SUCCESS),
    signal: unused ? SIGNAL_UNUSED : (failed ? SIGNAL_FAILURE : SIGNAL_SUCCESS),
    // Empty on the neutral record only: attributed reinforcement counts any signal >= 0 as
    // one reinforcement, so naming the entries here would credit exactly the memories nothing
    // showed were read. The cost is that the record says a turn was injected-and-unused
    // without saying which entries were ignored — a real limitation, and the honest side of
    // the trade.
    entryIds: unused ? [] : entryIds,
    rationale: rationaleFor(ev, unused, failed, entryIds.length),
  };
}

/**
 * §5.5: derived from `(run_id, prompt_id)`, **never random**.
 *
 * The server keeps an outcome idempotency ledger across restarts, which only helps if the
 * client sends a stable key — and it is what makes a drain and a SessionEnd flush racing over
 * the same turn a no-op instead of double reinforcement. Both hooks reach the wire through
 * this function so the two can no longer be spelled differently.
 *
 * @param {string} runId @param {string} promptId
 * @returns {string}
 */
export function outcomeIdempotencyKey(runId, promptId) {
  return `cc-outcome-${str(runId)}-${str(promptId)}`;
}

/**
 * The outcome request body, built once for both hooks.
 *
 * The decision decides *what* is claimed; this decides how it is addressed — and addressing
 * is the half that was never in dispute and would drift anyway, because `reference_id` and
 * the idempotency key are the kind of constant that gets retyped rather than re-derived.
 *
 * @param {{runId: string, agentId: string, promptId: string, decision: OutcomeDecision}} o
 * @returns {Record<string, any>}
 */
export function outcomeRequest(o) {
  const d = o.decision ?? {};
  return {
    run_id: o.runId,
    reference_id: RUN_LEVEL_REFERENCE,
    outcome: d.outcome,
    signal: d.signal,
    rationale: d.rationale,
    agent_id: o.agentId,
    entry_ids: Array.isArray(d.entryIds) ? [...d.entryIds] : [],
    idempotency_key: outcomeIdempotencyKey(o.runId, o.promptId),
  };
}

/**
 * `rationale` is the only field on the outcome request that can carry *how* the signal was
 * arrived at, so it names the method and the counts behind it.
 *
 * That matters most for the neutral records: someone reading a run full of them needs to know
 * they came from a lexical echo test that cannot see memory the model followed without
 * quoting it — not from a judgement that the entries were worthless. A turn the signal could
 * not measure keeps the original wording, unchanged, so old records and new ones do not
 * silently pool into one series.
 *
 * @param {Record<string, any>} ev  the turn's `used_evidence`, `{}` when there is none
 * @param {boolean} unused @param {boolean} failed @param {number} n
 * @returns {string}
 */
function rationaleFor(ev, unused, failed, n) {
  const method = str(ev.method);
  const by = method ? ` (${method})` : '';
  const counts = `${numOr(ev.matched, 0)} of ${numOr(ev.candidates, 0)} injected memory terms`;

  if (unused) {
    return `Claude Code injected ${n} ${n === 1 ? 'memory' : 'memories'} and the reply carried `
      + `none of their vocabulary — ${counts}${by}. Recorded, not penalised: this method `
      + 'cannot see memory the model followed without quoting it.';
  }
  if (ev.used === true) {
    return failed
      ? `Claude Code turn ended in failure; the reply carried ${counts}${by}.`
      : `Claude Code turn completed and the reply carried ${counts}${by}.`;
  }
  return failed
    ? 'Claude Code turn ended in failure after these memories were injected.'
    : 'Claude Code turn completed after these memories were injected.';
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
