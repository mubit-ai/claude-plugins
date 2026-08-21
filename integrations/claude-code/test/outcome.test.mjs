// @ts-check
/**
 * `lib/outcome.mjs` — the implicit-attribution rule, as one pure decision.
 *
 * Guide sections under test:
 *   §5.5 step 7  the outcome call: the four cases, the weak signal, the stable key
 *   §1.3         `reference_id` must be non-empty on an outcome
 *   §6.1         `outcomeMode` — `off` and `explicit` silence the implicit path
 *
 * The fact this file exists to protect: **two hooks post this outcome** — `drain.mjs` for a
 * turn that ended normally, `session-end.mjs` for a turn whose drain never reached it — and
 * for a while they disagreed about what to post. A run's outcome series then mixed two
 * definitions of the same measurement, with nothing on the wire to say which record came
 * from which. The rule lives here now so there is only one of it; the end-to-end proof that
 * both hooks agree lives in `session-end.test.mjs`.
 *
 * Everything here is a pure function of a turn object, so none of it needs a socket.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { lib } from './helpers/harness.mjs';
import { PROMPT_ID, SESSION_ID } from './helpers/fixtures.mjs';

// Lazy, so each test fails on its own with "lib/outcome.mjs does not exist yet"
// rather than aborting the file at import time.
let _mod;
const O = async () => (_mod ??= await lib('outcome.mjs'));

const RUN_ID = 'cc-outcome-test';

/** The reference ids `prompt-recall` staged, in render order (§5.2 step 6). */
const RECALLED = ['ref_rule_1', 'ref_lesson_1'];

/** A turn as `stage-prompt` + `capture --stop` leave it on disk (§5.3 / §5.4 step 8). */
function turn(over = {}) {
  return {
    prompt_id: PROMPT_ID,
    session_id: SESSION_ID,
    prompt: 'why is the ingest job stuck in queued?',
    started_at: Date.now() - 30_000,
    ended_at: Date.now(),
    recalled: [...RECALLED],
    outcome_pending: true,
    ...over,
  };
}

/** The `used_evidence` record `capture --stop` writes when it could compute the signal. */
function evidence(used, over = {}) {
  return {
    method: 'memory-term-echo/v1',
    at: Date.now(),
    candidates: 12,
    matched: used ? 3 : 0,
    terms: used ? ['indexing', 'queued', 'poll'] : [],
    answer_chars: 180,
    used,
    ...over,
  };
}

// ===========================================================================
// The constants — one declaration, not one per hook
// ===========================================================================

describe('the constants live in exactly one place', () => {
  // §5.5: "the implicit signal is deliberately weak (0.2, not 1.0) — a turn completing is
  // not proof the recalled memory helped, only weak positive evidence."
  it('SIGNAL_SUCCESS is +0.2 and SIGNAL_FAILURE is -0.3', async () => {
    const m = await O();
    assert.equal(m.SIGNAL_SUCCESS, 0.2);
    assert.equal(m.SIGNAL_FAILURE, -0.3);
  });

  // Exactly 0.0: a zero signal says "nothing to report about this memory", which is only an
  // honest claim when no entry ids ride along with it — so this value is paired with an empty
  // `entry_ids[]` (asserted below) and never with a populated one.
  it('SIGNAL_UNUSED is exactly 0', async () => {
    const m = await O();
    assert.equal(m.SIGNAL_UNUSED, 0);
    assert.ok(!Object.is(m.SIGNAL_UNUSED, -0), 'a signed zero would serialise as -0');
  });

  // The endpoint accepts four outcomes — success, failure, partial, neutral. Anything else
  // is a 400 for the whole call.
  it('the outcome strings are the ones the endpoint accepts', async () => {
    const m = await O();
    for (const v of [m.OUTCOME_SUCCESS, m.OUTCOME_FAILURE, m.OUTCOME_UNUSED]) {
      assert.ok(['success', 'failure', 'partial', 'neutral'].includes(v), `unknown outcome: ${v}`);
    }
    assert.equal(m.OUTCOME_UNUSED, 'neutral');
  });

  // §1.3: `reference_id` must be non-empty on an outcome, so run-level attribution
  // uses a sentinel and puts the real ids in `entry_ids[]`.
  it('RUN_LEVEL_REFERENCE is the non-empty run-level sentinel', async () => {
    const m = await O();
    assert.equal(m.RUN_LEVEL_REFERENCE, 'global');
    assert.ok(m.RUN_LEVEL_REFERENCE.length > 0);
  });
});

// ===========================================================================
// §5.5 step 7 — the five-case table
// ===========================================================================

describe('decideOutcome — the five cases, one row each', () => {
  /**
   * | turn | posted |
   * | --- | --- |
   * | nothing injected | nothing |
   * | the API killed the turn | nothing |
   * | injected, the reply carried the memory's vocabulary | success +0.2 / failure -0.3, with entry_ids |
   * | injected, the reply carried none of it | neutral 0.0, with an EMPTY entry_ids |
   * | injected, the signal could not be computed | as before: success +0.2 / failure -0.3 |
   */
  const TABLE = [
    { name: 'nothing injected', turn: turn({ recalled: [] }), post: false },
    { name: 'nothing injected, and the turn failed', turn: turn({ recalled: [], outcome: 'failure' }), post: false },

    // Row 2 — the turn ended on an API error, so NOTHING is posted, not even a neutral.
    // `neutral` already means something specific and hard to read: "memory was injected and
    // the reply shows no sign of it", which is a real (if noisy) fact about the memory.
    // A rate limit is a fact about the endpoint. Filing it under `neutral` would put
    // infrastructure noise into the one row whose denominator the whole precision number
    // depends on, and nothing on the wire would say which records were which.
    { name: 'the API killed the turn', turn: turn({ api_error: 'rate_limit' }), post: false },
    { name: 'the API killed the turn, and it echoed the memory anyway', turn: turn({ api_error: 'max_output_tokens', used_evidence: evidence(true) }), post: false },
    { name: 'the API killed the turn, and it echoed nothing', turn: turn({ api_error: 'overloaded', used_evidence: evidence(false) }), post: false },

    { name: 'measured used, turn completed', turn: turn({ used_evidence: evidence(true) }), post: true, outcome: 'success', signal: 0.2, entryIds: RECALLED },
    { name: 'measured used, turn failed', turn: turn({ used_evidence: evidence(true), outcome: 'failure' }), post: true, outcome: 'failure', signal: -0.3, entryIds: RECALLED },

    { name: 'measured unused, turn completed', turn: turn({ used_evidence: evidence(false) }), post: true, outcome: 'neutral', signal: 0, entryIds: [] },
    // A turn that failed is not proof the memory was wrong when nothing shows the memory was
    // used at all. -0.3 against an entry the model never touched is the same mistake as
    // +0.2, pointed the other way.
    { name: 'measured unused, turn failed', turn: turn({ used_evidence: evidence(false), outcome: 'failure' }), post: true, outcome: 'neutral', signal: 0, entryIds: [] },

    { name: 'unmeasured, turn completed', turn: turn(), post: true, outcome: 'success', signal: 0.2, entryIds: RECALLED },
    { name: 'unmeasured, turn failed', turn: turn({ outcome: 'failure' }), post: true, outcome: 'failure', signal: -0.3, entryIds: RECALLED },
  ];

  for (const row of TABLE) {
    it(row.name, async () => {
      const { decideOutcome } = await O();
      const d = decideOutcome(row.turn);
      assert.equal(d.post, row.post, `post: ${JSON.stringify(d)}`);
      if (!row.post) return;
      assert.equal(d.outcome, row.outcome);
      assert.equal(d.signal, row.signal);
      assert.deepEqual(d.entryIds, row.entryIds);
      assert.ok(typeof d.rationale === 'string' && d.rationale.length > 0,
        'the rationale is the only field that can carry how the signal was arrived at');
    });
  }

  // THE assertion behind the neutral record. Attributed reinforcement counts any signal at
  // or above zero as one reinforcement, so naming the entries here would credit exactly the
  // memories nothing showed were read.
  it('the neutral record never names the entries it could not credit', async () => {
    const { decideOutcome } = await O();
    const d = decideOutcome(turn({ used_evidence: evidence(false) }));
    assert.deepEqual(d.entryIds, []);
    assert.ok(d.signal >= 0, 'a penalty here would punish memory for a mostly-false-negative signal');
  });
});

// ===========================================================================
// `used === false` is a measurement; an absent key is not
// ===========================================================================

describe('decideOutcome — measured-false and unmeasured are different turns', () => {
  // An absent `used` means the signal did not exist yet, or every distinctive term was
  // already in the user's prompt. Reading that as "the model ignored it" invents a
  // denominator, and would report every turn from before this signal shipped as an
  // injection the model ignored.
  const UNMEASURED = [
    { name: 'no used_evidence at all', ev: undefined },
    { name: 'used_evidence with no `used` key', ev: { method: 'memory-term-echo/v1', candidates: 0, matched: 0, reason: 'no_distinct_terms' } },
    { name: 'used_evidence with no `used` key and no reply', ev: { method: 'memory-term-echo/v1', candidates: 4, matched: 0, reason: 'no_reply' } },
    { name: 'a non-boolean `used`', ev: { method: 'memory-term-echo/v1', used: 'false' } },
    { name: 'used_evidence that is not an object', ev: 'nope' },
    { name: 'used_evidence that is an array', ev: [] },
  ];

  for (const row of UNMEASURED) {
    it(`${row.name} keeps the +0.2 and the attribution`, async () => {
      const { decideOutcome } = await O();
      const d = decideOutcome(turn(row.ev === undefined ? {} : { used_evidence: row.ev }));
      assert.equal(d.post, true);
      assert.equal(d.outcome, 'success');
      assert.equal(d.signal, 0.2);
      assert.deepEqual(d.entryIds, RECALLED);
    });
  }

  it('`used: false` — and only that — reaches the neutral branch', async () => {
    const { decideOutcome } = await O();
    assert.equal(decideOutcome(turn({ used_evidence: evidence(false) })).outcome, 'neutral');
    assert.equal(decideOutcome(turn({ used_evidence: evidence(true) })).outcome, 'success');
  });
});

// ===========================================================================
// The rationale — what a reader of the record can tell apart
// ===========================================================================

describe('the rationale names the method, so a neutral record is legible', () => {
  // Someone reading a run full of neutral records needs to know they came from a lexical
  // echo test that cannot see memory the model followed without quoting it — not from a
  // judgement that the entries were worthless.
  it('a neutral record names the method and says it is not a penalty', async () => {
    const { decideOutcome } = await O();
    const { rationale } = decideOutcome(turn({ used_evidence: evidence(false) }));
    assert.ok(rationale.includes('memory-term-echo/v1'), `no method named: ${rationale}`);
    assert.match(rationale, /not penalis|not penaliz/i, `nothing says why it is 0.0: ${rationale}`);
  });

  it('a measured-used record names the method and the counts', async () => {
    const { decideOutcome } = await O();
    const { rationale } = decideOutcome(turn({ used_evidence: evidence(true) }));
    assert.ok(rationale.includes('memory-term-echo/v1'), `no method named: ${rationale}`);
    assert.ok(/3 of 12/.test(rationale), `no counts: ${rationale}`);
  });

  // A turn the signal could not measure keeps the original wording, unchanged, so old
  // records and new ones do not silently pool into one series.
  it('an unmeasured turn keeps the original wording', async () => {
    const { decideOutcome } = await O();
    assert.equal(decideOutcome(turn()).rationale,
      'Claude Code turn completed after these memories were injected.');
    assert.equal(decideOutcome(turn({ outcome: 'failure' })).rationale,
      'Claude Code turn ended in failure after these memories were injected.');
  });
});

// ===========================================================================
// "post nothing" — the answers that are not a record
// ===========================================================================

describe('decideOutcome — the reasons not to post', () => {
  // §5.5/§12.4: "only when entry_ids is non-empty". An outcome attributed to nothing is a
  // wasted round trip that also pollutes the run-level signal history the reflect path
  // reads — and it is what makes the neutral record legible: "no post" then means one thing
  // only, *nothing was injected*.
  it('a turn that recalled nothing is not posted at all', async () => {
    const { decideOutcome } = await O();
    for (const recalled of [[], undefined, null, 'ref_rule_1', ['', '   '], [1, 2]]) {
      const d = decideOutcome(turn({ recalled }));
      assert.equal(d.post, false, `recalled=${JSON.stringify(recalled)} must post nothing`);
      assert.ok(typeof d.reason === 'string' && d.reason.length > 0, 'a skip must say why');
    }
  });

  /**
   * The `StopFailure` row, stated as the reason rather than only as an absence.
   *
   * `capture --stop-failure` stamps `api_error` and closes the turn `outcome_pending`, which
   * is exactly what makes this guard load-bearing: the turn IS swept by `session-end`'s
   * flush and IS handed to this function, and this is the only thing between it and a
   * `-0.3` posted against ids the model never got to use. Without the guard the turn reads
   * as "injected, unmeasured, turn completed" — the +0.2 row — because the used-signal is
   * deliberately absent on a truncated reply.
   *
   * `api_failed` is checked before `attempts_exhausted` on purpose: a turn nothing will ever
   * dial must never accumulate a dial count.
   */
  it('a turn the API killed is not posted at all, whatever else the turn says', async () => {
    const { decideOutcome } = await O();
    const rows = [
      { name: 'the common one', over: { api_error: 'rate_limit' } },
      { name: 'the catch-all', over: { api_error: 'unknown' } },
      { name: 'a value from a newer host', over: { api_error: 'context_window_exceeded' } },
      { name: 'measured used', over: { api_error: 'overloaded', used_evidence: evidence(true) } },
      { name: 'measured unused', over: { api_error: 'server_error', used_evidence: evidence(false) } },
      // The row that would otherwise post -0.3 against every recalled id.
      { name: 'the file also says the turn failed', over: { api_error: 'rate_limit', outcome: 'failure' } },
      // Never dialled, so it must never look like a turn that ran out of retries — that
      // reason is the one the callers act on by marking the turn abandoned.
      { name: 'attempts already counted by an older build', over: { api_error: 'rate_limit', outcome_attempts: 3 } },
    ];
    for (const row of rows) {
      const d = decideOutcome(turn(row.over));
      assert.equal(d.post, false, `${row.name}: ${JSON.stringify(d)}`);
      assert.equal(d.reason, 'api_failed',
        `${row.name}: the skip must name the API failure — "${d.reason}" would send a reader `
        + 'looking for a memory problem that is not there');
      assert.equal(d.entryIds, undefined, `${row.name}: nothing is attributed, so nothing is named`);
    }
  });

  // The mark is the only thing that turns suppression on, so a turn without one must go on
  // being posted exactly as before. An over-broad guard here is worse than none: it would
  // silently stop the reinforcement signal for every turn in the run.
  it('an absent or empty api_error leaves the ordinary rows untouched', async () => {
    const { decideOutcome } = await O();
    for (const api_error of [undefined, null, '', '   ', 0, false]) {
      const d = decideOutcome(turn({ api_error }));
      assert.equal(d.post, true, `api_error=${JSON.stringify(api_error)} must not suppress anything`);
      assert.equal(d.outcome, 'success');
      assert.deepEqual(d.entryIds, RECALLED);
    }
  });

  // An earlier drain already attributed it. The stable key below makes a re-post a
  // server-side no-op anyway, but there is no reason to spend the round trip.
  it('a turn already attributed is not posted again', async () => {
    const { decideOutcome } = await O();
    const d = decideOutcome(turn({ outcome_sent_at: Date.now() }));
    assert.equal(d.post, false);
    assert.equal(d.reason, 'already_sent');
  });

  it('a missing or malformed turn file is not posted', async () => {
    const { decideOutcome } = await O();
    for (const bad of [null, undefined, 'a string', 42, ['an', 'array']]) {
      assert.equal(decideOutcome(/** @type {any} */ (bad)).post, false, `${JSON.stringify(bad)}`);
    }
  });

  // The decision is a pure function of the turn: same input, same answer, and the turn
  // itself is never mutated. That is what makes it testable in both hooks without a socket.
  it('is pure — repeatable, and it never mutates the turn', async () => {
    const { decideOutcome } = await O();
    const t = turn({ used_evidence: evidence(false) });
    const before = JSON.stringify(t);
    assert.deepEqual(decideOutcome(t), decideOutcome(t));
    assert.equal(JSON.stringify(t), before, 'the turn file object must survive unmodified');
  });
});

// ===========================================================================
// §6.1 — the mode gate, the same one in both hooks
// ===========================================================================

describe('implicitOutcomesEnabled — "off" and "explicit" silence the implicit path', () => {
  const TABLE = [
    // The default. §6.1 pins `outcomeMode` to these three; anything else is a config that
    // never loaded, and the documented default is what it should behave like.
    { mode: 'implicit', enabled: true },
    { mode: '', enabled: true },
    { mode: undefined, enabled: true },
    { mode: 'nonsense', enabled: true },
    // Disables implicit attribution altogether.
    { mode: 'off', enabled: false },
    // Hands the call to the model through `mubit_outcome`; an automatic 0.2 alongside it
    // would dilute the model's deliberate judgement.
    { mode: 'explicit', enabled: false },
  ];

  for (const row of TABLE) {
    it(`outcomeMode ${JSON.stringify(row.mode)} → ${row.enabled}`, async () => {
      const { implicitOutcomesEnabled } = await O();
      assert.equal(implicitOutcomesEnabled({ outcomeMode: row.mode }), row.enabled);
    });
  }

  it('a config that could not be read behaves like the default', async () => {
    const { implicitOutcomesEnabled } = await O();
    for (const cfg of [{}, null, undefined]) {
      assert.equal(implicitOutcomesEnabled(/** @type {any} */ (cfg)), true);
    }
  });
});

// ===========================================================================
// The idempotency key — derived, never random
// ===========================================================================

describe('outcomeIdempotencyKey — the same turn is the same key, forever', () => {
  // §5.5: the server keeps an outcome idempotency ledger across restarts, which only helps
  // if the client sends a stable key. It is what makes a concurrent drain and a session-end
  // flush a no-op rather than double reinforcement.
  it('is derived from (run_id, prompt_id) and nothing else', async () => {
    const { outcomeIdempotencyKey } = await O();
    assert.equal(outcomeIdempotencyKey(RUN_ID, PROMPT_ID), `cc-outcome-${RUN_ID}-${PROMPT_ID}`);
  });

  it('is stable across calls — nothing random, nothing time-based', async () => {
    const { outcomeIdempotencyKey } = await O();
    const a = outcomeIdempotencyKey(RUN_ID, PROMPT_ID);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(outcomeIdempotencyKey(RUN_ID, PROMPT_ID), a);
  });

  it('two different turns of one run get two different keys', async () => {
    const { outcomeIdempotencyKey } = await O();
    assert.notEqual(outcomeIdempotencyKey(RUN_ID, PROMPT_ID), outcomeIdempotencyKey(RUN_ID, 'p_other'));
  });
});

// ===========================================================================
// The wire body — built once, so `reference_id` and the key cannot drift either
// ===========================================================================

describe('outcomeRequest — the body both hooks put on the wire', () => {
  it('carries the run-level sentinel, the decision, and the derived key', async () => {
    const { decideOutcome, outcomeRequest } = await O();
    const decision = decideOutcome(turn({ used_evidence: evidence(true) }));
    const body = outcomeRequest({
      runId: RUN_ID, agentId: 'claude-code-4f21ab90', promptId: PROMPT_ID, decision,
    });

    assert.equal(body.run_id, RUN_ID);
    assert.equal(body.reference_id, 'global');
    assert.equal(body.outcome, 'success');
    assert.equal(body.signal, 0.2);
    assert.deepEqual(body.entry_ids, RECALLED);
    assert.equal(body.agent_id, 'claude-code-4f21ab90');
    assert.equal(body.idempotency_key, `cc-outcome-${RUN_ID}-${PROMPT_ID}`);
    assert.equal(body.rationale, decision.rationale);
  });

  it('sends the neutral record with an empty entry_ids[]', async () => {
    const { decideOutcome, outcomeRequest } = await O();
    const decision = decideOutcome(turn({ used_evidence: evidence(false) }));
    const body = outcomeRequest({
      runId: RUN_ID, agentId: 'claude-code-4f21ab90', promptId: PROMPT_ID, decision,
    });
    assert.equal(body.outcome, 'neutral');
    assert.equal(body.signal, 0);
    assert.deepEqual(body.entry_ids, []);
    assert.equal(body.reference_id, 'global', 'reference_id must still be non-empty (§1.3)');
  });
});
