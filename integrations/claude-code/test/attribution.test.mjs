// @ts-check
/**
 * The closed attribution loop — an end-to-end vertical slice across three hooks
 * (§5.2 step 6 → §5.4 step 8 → §5.5 step 7).
 *
 *   prompt-recall  recalls evidence and persists the RENDERED reference_id[] into
 *                  runs/<run_id>/turns/<prompt_id>.json under `recalled`
 *   capture --stop marks the turn outcome_pending and spawns the drain
 *   drain          POSTs /v2/control/outcome with those ids as `entry_ids[]`
 *
 * This is what makes memory improve with use rather than merely accumulate, so it is
 * written as a scenario test: any one hook can pass its own unit tests and still break the
 * loop at a seam.
 *
 * The seam most likely to break it: `reference_id`, NOT `id`, is what feeds
 * `RecordOutcome.entry_ids` (control.proto). The `queryResponse()` fixture gives
 * them deliberately different values (`e1` vs `ref_rule_1`) so a mix-up cannot pass.
 *
 * These tests are written before the implementation. Failing with
 * "hooks/src/<name>.mjs does not exist yet" is the expected red state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  fakeMubit, queryResponse, evidence, runHook, assertHookContract,
  baseEnv, makeDataDir, readJsonFile, waitFor,
} from './helpers/harness.mjs';
import { userPromptSubmit, stop, PROMPT_ID } from './helpers/fixtures.mjs';

const RUN_ID = 'cc-test-run-1';

/** The reference ids the default `queryResponse()` fixture renders, in section order. */
const RECALLED = ['ref_rule_1', 'ref_lesson_1', 'ref_fact_1'];
/** The `id` values of the same three entries. None of these may ever reach `entry_ids`. */
const EVIDENCE_IDS = ['e1', 'e2', 'e3'];

function env(dataDir, server, extra = {}) {
  return baseEnv({
    dataDir,
    endpoint: server.url,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: RUN_ID,
      ...extra,
    },
  });
}

const turnPath = (dataDir, promptId = PROMPT_ID) =>
  join(dataDir, 'runs', RUN_ID, 'turns', `${promptId}.json`);

/** Ingest is answered slowly so the drain that `capture --stop` detaches is still in flight
 *  while the test inspects the turn file it just wrote. */
const SLOW_INGEST = {
  delayMs: 250,
  json: { accepted: true, job_id: 'job_test_1', deduplicated: false, status: 'queued' },
};

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The loop, end to end
// ---------------------------------------------------------------------------

test('recall → stop → drain attributes the outcome to the recalled reference_ids', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/ingest': SLOW_INGEST });
  t.after(() => server.close());
  const dir = makeDataDir();
  const e = env(dir, server);

  // 1. Recall. §5.2 step 6: persist the rendered reference_ids for Stop attribution.
  //    prompt-recall runs before stage-prompt in hooks.json, so it creates the turn file.
  const recall = await runHook('prompt-recall', userPromptSubmit(), { env: e });
  assertHookContract(recall);
  server.assertCalled('POST', '/v2/control/query', 1);

  assert.ok(existsSync(turnPath(dir)), `no turn file at ${turnPath(dir)}`);
  const afterRecall = readJsonFile(turnPath(dir));
  assert.deepEqual(afterRecall.recalled, RECALLED,
    'the turn records reference_id[], in render order — this is the whole attribution surface');

  // 2. Stop. §5.4 step 8: mark the turn and ALWAYS trigger a drain with the outcome.
  const captured = await runHook('capture', stop(), { env: e, args: ['--stop'] });
  assertHookContract(captured);
  const afterStop = readJsonFile(turnPath(dir));
  assert.equal(afterStop.outcome_pending, true);
  assert.deepEqual(afterStop.recalled, RECALLED, 'Stop must not clobber what recall wrote');
  assert.equal(typeof afterStop.ended_at, 'number');

  // 3. Drain. §5.5 step 7.
  const drained = await runHook('drain', {}, { env: e, args: ['--with-outcome', PROMPT_ID] });
  assertHookContract(drained);
  await waitFor(() => server.countOf('POST', '/v2/control/outcome') >= 1, 5000);

  const body = server.lastCall('POST', '/v2/control/outcome').body;

  // §1.3/§5.5: reference_id must be non-empty; "global" is the run-level sentinel and the
  // real attribution lives in entry_ids[], which reinforces each entry individually
  // (control.proto).
  assert.equal(body.run_id, RUN_ID);
  assert.equal(body.reference_id, 'global');
  assert.equal(body.outcome, 'success');
  assert.equal(body.signal, 0.2,
    'the implicit signal is deliberately weak — a turn completing is not proof the memory helped');
  assert.equal(body.agent_id, 'claude-code', 'the outcome is attributed to the role, not the session');
  assert.ok(typeof body.idempotency_key === 'string' && body.idempotency_key.length > 0);

  // THE assertion. reference_id, not id.
  assert.deepEqual(body.entry_ids, RECALLED,
    'entry_ids must be the recalled reference_ids, in order');
  for (const bad of EVIDENCE_IDS) {
    assert.ok(!body.entry_ids.includes(bad),
      `entry_ids contains QueryEvidence.id "${bad}" — it must carry reference_id instead ` +
      '(control.proto). Reinforcement silently targets nothing when this is wrong.');
  }
});

// §4.10/§5.5: only what actually reached the model can be credited for the turn. Evidence
// the token budget dropped was never seen, so reinforcing it would teach the store a lie.
test('only the entries that survived the token budget are attributed', async (t) => {
  const long = (tag, ch) => `${tag} ${ch.repeat(400)}`; // ~100 tokens each
  const server = await fakeMubit({
    'POST /v2/control/ingest': SLOW_INGEST,
    'POST /v2/control/query': {
      json: queryResponse({
        evidence: [
          evidence({ id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule', score: 0.91, content: long('RULE', 'r') }),
          evidence({ id: 'e2', reference_id: 'ref_lesson_1', entry_type: 'lesson', score: 0.84, content: long('LESSON', 'l') }),
          evidence({ id: 'e3', reference_id: 'ref_fact_1', entry_type: 'fact', score: 0.55, content: long('FACT', 'f') }),
        ],
      }),
    },
  });
  t.after(() => server.close());
  const dir = makeDataDir();
  const e = env(dir, server, { MUBIT_CC_RECALL_TOKENS: '150' });

  assertHookContract(await runHook('prompt-recall', userPromptSubmit(), { env: e }));
  const turn = readJsonFile(turnPath(dir));
  assert.deepEqual(turn.recalled, ['ref_rule_1'],
    'a 150-token budget holds one ~100-token item; active_rules fills first');

  assertHookContract(await runHook('capture', stop(), { env: e, args: ['--stop'] }));
  assertHookContract(await runHook('drain', {}, { env: e, args: ['--with-outcome', PROMPT_ID] }));
  await waitFor(() => server.countOf('POST', '/v2/control/outcome') >= 1, 5000);

  const body = server.lastCall('POST', '/v2/control/outcome').body;
  assert.deepEqual(body.entry_ids, ['ref_rule_1']);
  for (const dropped of ['ref_lesson_1', 'ref_fact_1']) {
    assert.ok(!body.entry_ids.includes(dropped),
      `${dropped} was dropped by the budget and never shown — it must not be reinforced`);
  }
});

// ---------------------------------------------------------------------------
// outcomeMode
// ---------------------------------------------------------------------------

// §5.5/§6.1: "off" disables implicit attribution entirely. The loop stops; nothing else does.
test('outcomeMode "off" posts no outcome at all', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/ingest': SLOW_INGEST });
  t.after(() => server.close());
  const dir = makeDataDir();
  const e = env(dir, server, { MUBIT_CC_OUTCOME_MODE: 'off' });

  assertHookContract(await runHook('prompt-recall', userPromptSubmit(), { env: e }));
  assert.deepEqual(readJsonFile(turnPath(dir)).recalled, RECALLED,
    'recall still records what it injected — only the attribution call is disabled');
  assertHookContract(await runHook('capture', stop(), { env: e, args: ['--stop'] }));
  assertHookContract(await runHook('drain', {}, { env: e, args: ['--with-outcome', PROMPT_ID] }));

  await waitFor(() => server.countOf('POST', '/v2/control/ingest') >= 1, 5000);
  await settle();
  server.assertNotCalled('POST', '/v2/control/outcome');
});

// §5.5: "explicit" hands the call to the model via the mubit_outcome MCP verb. The hook must
// not also fire one, or the model's deliberate judgement gets diluted by an automatic 0.2.
test('outcomeMode "explicit" posts no implicit outcome either', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/ingest': SLOW_INGEST });
  t.after(() => server.close());
  const dir = makeDataDir();
  const e = env(dir, server, { MUBIT_CC_OUTCOME_MODE: 'explicit' });

  assertHookContract(await runHook('prompt-recall', userPromptSubmit(), { env: e }));
  assertHookContract(await runHook('capture', stop(), { env: e, args: ['--stop'] }));
  assertHookContract(await runHook('drain', {}, { env: e, args: ['--with-outcome', PROMPT_ID] }));

  await waitFor(() => server.countOf('POST', '/v2/control/ingest') >= 1, 5000);
  await settle();
  server.assertNotCalled('POST', '/v2/control/outcome');
});

// §5.5/§12.4: "only when entry_ids is non-empty". An outcome with an empty entry_ids[]
// attributes a turn to nothing at all — a wasted round trip that also pollutes the
// run-level signal history the reflect path reads.
test('a turn that recalled nothing skips the outcome call entirely', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/ingest': SLOW_INGEST,
    'POST /v2/control/query': { json: queryResponse({ evidence: [] }) },
  });
  t.after(() => server.close());
  const dir = makeDataDir();
  const e = env(dir, server);

  const recall = await runHook('prompt-recall', userPromptSubmit(), { env: e });
  assertHookContract(recall);
  assert.deepEqual(recall.json, { suppressOutput: true });
  if (existsSync(turnPath(dir))) {
    assert.deepEqual(readJsonFile(turnPath(dir)).recalled ?? [], []);
  }

  assertHookContract(await runHook('capture', stop(), { env: e, args: ['--stop'] }));
  assertHookContract(await runHook('drain', {}, { env: e, args: ['--with-outcome', PROMPT_ID] }));

  await waitFor(() => server.countOf('POST', '/v2/control/ingest') >= 1, 5000);
  await settle();
  server.assertNotCalled('POST', '/v2/control/outcome');
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

// §5.5: the outcome idempotency_key is derived from (run_id, prompt_id), never random, so a
// retry after a failed post is a server-side no-op instead of double reinforcement. The
// server keeps an outcome idempotency ledger across restarts, which only
// helps if the client sends a stable key.
test('two drains for the same turn send the same idempotency_key', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/ingest': SLOW_INGEST,
    // The first attempt fails, so the turn stays pending and a second drain re-posts it.
    'POST /v2/control/outcome': [
      { status: 500, json: { error: 'boom' } },
      { json: { success: true, reinforcement_count: 1, updated_confidence: 0.7 } },
    ],
  });
  t.after(() => server.close());
  const dir = makeDataDir();
  const e = env(dir, server);

  assertHookContract(await runHook('prompt-recall', userPromptSubmit(), { env: e }));
  assertHookContract(await runHook('capture', stop(), { env: e, args: ['--stop'] }));
  assertHookContract(await runHook('drain', {}, { env: e, args: ['--with-outcome', PROMPT_ID] }));
  assertHookContract(await runHook('drain', {}, { env: e, args: ['--with-outcome', PROMPT_ID] }));

  await waitFor(() => server.countOf('POST', '/v2/control/outcome') >= 2, 6000);

  const keys = server.calls('POST', '/v2/control/outcome').map((c) => c.body.idempotency_key);
  assert.equal(new Set(keys).size, 1, `keys diverged across retries: ${JSON.stringify(keys)}`);
  assert.ok(keys[0].includes(RUN_ID), `key must be derived from the run id: ${keys[0]}`);
  assert.ok(keys[0].includes(PROMPT_ID), `key must be derived from the turn id: ${keys[0]}`);

  for (const call of server.calls('POST', '/v2/control/outcome')) {
    assert.deepEqual(call.body.entry_ids, RECALLED, 'every retry carries the same attribution');
    assert.equal(call.body.reference_id, 'global');
  }
});
