// @ts-check
/**
 * `hooks/src/prompt-recall.mjs` — UserPromptSubmit, blocking (§5.2, §1.8, §12.4).
 *
 * The single most counter-intuitive fact in the whole plugin, and the one a future
 * maintainer is most likely to "simplify" away:
 *
 *   | request                                       | LLM calls |
 *   | query{mode:"direct_bypass", evidence_only}    |     0     |  ← rung 1, the primary path
 *   | query{mode:"agent_routed",  evidence_only}    |     1     |  ← rung 2, only on a 403
 *   | context{mode:"sections"}                      |     2     |  ← rung 3, opt-in only
 *
 * `/v2/control/context` is not the cheap assembly path its name implies: it is the most
 * expensive of the three requests above, and the synthesized answer it pays for is one the
 * recall hook throws away. So the hook is query-first and treats `context` as the last rung
 * — the inverse of what the endpoint names suggest.
 *
 * These tests are written before the implementation. Failing with
 * "hooks/src/prompt-recall.mjs does not exist yet" is the expected red state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  fakeMubit, queryResponse, evidence, runHook, assertHookContract,
  baseEnv, makeDataDir, makeProjectDir, readJsonFile, readJsonDir,
} from './helpers/harness.mjs';
import { userPromptSubmit, PROMPT_ID, SECRETS } from './helpers/fixtures.mjs';

const RUN_ID = 'cc-test-run-1';
const PROMPT = 'why is the ingest job stuck in queued?';

/** Direct search disabled by instance policy. A policy verdict, not a fault. */
const DENIED = {
  status: 403,
  json: { error: 'direct data-plane bypass is disabled by policy', code: 'permission_denied' },
};

/** Deterministic env: a pinned static run id makes every request body exactly assertable. */
/**
 * Rung 2 is opt-in as of the rung-1-only default (§5.2): tests that exercise the fallback
 * ladder have to ask for it, exactly as an operator would.
 */
const FALLBACK_ON = { MUBIT_CC_RECALL_FALLBACK: 'agent_routed' };

function env(dataDir, server, extra = {}) {
  return baseEnv({
    dataDir,
    endpoint: server.url,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: RUN_ID,
      MUBIT_CC_ENV_TAGS: 'ci:test',
      ...extra,
    },
  });
}

const policyDir = (d) => join(d, 'policy');
const marker = (d) => readJsonFile(join(d, 'status', `${RUN_ID}.json`));
const turnPath = (d, promptId = PROMPT_ID) =>
  join(d, 'runs', RUN_ID, 'turns', `${promptId}.json`);
const turn = (d, promptId = PROMPT_ID) => readJsonFile(turnPath(d, promptId));

// ---------------------------------------------------------------------------
// The regression test for the inverted ladder
// ---------------------------------------------------------------------------

// §1.8/§12.4 — THE test in this file. Under the default recallAssemble:"client" the hook
// spends exactly one zero-LLM-call request and never touches the two-LLM-call endpoint.
// If `context` ever shows up here, every user prompt just got two LLM calls more expensive.
test('rung 1 only: one direct_bypass query, and NO /v2/control/context at all', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) });

  assertHookContract(r);
  server.assertCalled('POST', '/v2/control/query', 1);
  server.assertNotCalled('POST', '/v2/control/context');

  const body = server.lastCall('POST', '/v2/control/query').body;
  assert.equal(body.mode, 'direct_bypass',
    'only "direct_bypass" and "direct" reach the direct lane; ' +
    'every other value is answered by the slower path, with no error anywhere to say so');
  assert.equal(body.evidence_only, true,
    'evidence_only:true skips answer synthesis — the second LLM call');
});

// §5.2: the rung-1 body, field for field. `limit`, `budget:"low"` (<500 ms tier, §1.7) and
// `entry_types` are all load-bearing; omitting `mode` defaults to "agent_routed",
// which is the expensive case with no error.
/**
 * The block's size was bounded by two things, neither of them a count the user could set:
 * the server's own request limit, and a 1500-token budget that a handful of one-line lessons
 * never came close to. `assembleContext` has had a per-section cap since it was written and
 * no caller ever passed it. Now it is a setting, and `0` keeps exactly the behaviour every
 * release so far has had.
 */
test('recallMaxPerSection caps items per section; 0 leaves it uncapped', async (t) => {
  const many = [
    evidence({ id: 'e1', reference_id: 'ref_1', entry_type: 'lesson', content: 'lesson one', score: 0.9 }),
    evidence({ id: 'e2', reference_id: 'ref_2', entry_type: 'lesson', content: 'lesson two', score: 0.8 }),
    evidence({ id: 'e3', reference_id: 'ref_3', entry_type: 'lesson', content: 'lesson three', score: 0.7 }),
  ];
  const server = await fakeMubit({
    'POST /v2/control/query': { json: queryResponse({ evidence: many }) },
  });
  t.after(() => server.close());

  const uncapped = await runHook('prompt-recall', userPromptSubmit(),
    { env: env(makeDataDir(), server) });
  assertHookContract(uncapped);
  const all = uncapped.json.hookSpecificOutput.additionalContext;
  assert.ok(all.includes('lesson three'), 'the default must not have started dropping items');

  const capped = await runHook('prompt-recall', userPromptSubmit(),
    { env: env(makeDataDir(), server, { MUBIT_CC_RECALL_MAX_PER_SECTION: '2' }) });
  assertHookContract(capped);
  const ctx = capped.json.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('lesson one') && ctx.includes('lesson two'));
  assert.ok(!ctx.includes('lesson three'), 'the third item is over the cap');
});

/**
 * Retrieval is a ranked guess over a token budget: items are dropped, entries go stale, and
 * nothing in the block was re-checked against the working tree. Rendered bare, a bullet under
 * a heading like "Active rules" reads as a project invariant and gets acted on instead of
 * checked. The envelope says so once, where the model cannot miss it.
 */
test('the injected block says memory may be incomplete and should be verified', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) });
  assertHookContract(r);

  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /may be incomplete or out of date/i);
  assert.match(ctx, /verify/i);
  // Still inside the envelope that separates injected memory from the model's own reasoning.
  assert.match(ctx, /^<mubit-memory /);
  assert.match(ctx, /<\/mubit-memory>$/);
});

// §5.2 rung 1 / §7 — the recall hook is also the rule store's supplier.
//
// `hooks/src/pre-tool.mjs` runs while the user waits on a tool call and may never dial, so
// its only supply is a hook that has already paid for a round trip. This is that hook, and
// the wiring is easy to lose: the call lives in `lib/recall.mjs`'s `fromEvidence`, one file
// removed from the hook under test, and nothing else in the suite drives it end to end —
// `pre-tool.test.mjs` and `hook-output.test.mjs` both seed `rules.json` by hand. Without
// this test the producer half could be deleted outright and the suite would stay green.
test('a rule in the recall response reaches rules.json, and a non-rule does not', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': {
      json: queryResponse({
        evidence: [
          evidence({
            id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule',
            content: 'Never force-push to main; it is protected and the push will be rejected.',
          }),
          evidence({
            id: 'e2', reference_id: 'ref_fact_1', entry_type: 'fact',
            content: 'The ingest worker polls every thirty seconds.',
          }),
        ],
      }),
    },
  });
  t.after(() => server.close());
  const dir = makeDataDir();

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) });
  assertHookContract(r);
  // Without this, a mis-keyed route reads as "the store was not written" and sends the next
  // reader hunting through `lib/rules.mjs` for a bug that is in the fixture.
  server.assertCalled('POST', '/v2/control/query', 1);

  const stored = readJsonFile(join(dir, 'runs', RUN_ID, 'rules.json'));
  assert.ok(stored, 'prompt-recall recalled a rule and stored none, so pre-tool has nothing '
    + 'to warn from — the store is only ever filled by a hook that already paid for a call');

  const refs = (stored.rules ?? []).map((/** @type {any} */ x) => x.ref);
  assert.deepEqual(refs, ['ref_rule_1'],
    'the store must hold the rule and only the rule: a fact surfaced as a tool-call warning '
    + `is noise the user cannot act on (got ${JSON.stringify(refs)})`);
});

test('rung 1 request body matches §5.2 exactly', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) });
  assertHookContract(r);

  const body = server.lastCall('POST', '/v2/control/query').body;
  assert.equal(body.run_id, RUN_ID);
  assert.equal(body.agent_id, 'claude-code', `agent_id was "${body.agent_id}"`);
  assert.equal(body.query, PROMPT);
  assert.equal(body.mode, 'direct_bypass');
  assert.equal(body.direct_lane, 'semantic_search');
  assert.equal(body.evidence_only, true);
  assert.equal(body.budget, 'low');
  assert.equal(body.limit, 8);
  assert.deepEqual(body.entry_types, ['mental_model', 'rule', 'lesson', 'fact', 'trace']);
  assert.equal(body.include_working_memory, true);
  assert.ok(Array.isArray(body.env_tags), 'env_tags exists on a /v2/control/query body but not on a /v2/control/context one');
  assert.ok(body.env_tags.includes('tool:claude-code'));
  assert.ok(body.env_tags.includes('ci:test'), 'MUBIT_CC_ENV_TAGS extras are appended verbatim');
  assert.ok(body.env_tags.length <= 8, 'env_tags is capped at 8 (§4.1)');
  // §5.2 — the fusion weights, chosen client-side. The fixture prompt is a diagnosis
  // ("why is the ingest job stuck in queued?"), not a handoff, so the default `auto` rule
  // resolves it to `relevance`. A `freshness` here would mean the rule fires on ordinary
  // questions, which is the one way this feature makes recall worse rather than better.
  assert.equal(body.rank_by, 'relevance',
    'rank_by must be on the wire and concrete: `auto` is a client-side word, and sending it '
    + 'would fall through to the default weights while looking like a decision');
});

// ---------------------------------------------------------------------------
// `prefer_current_run` — asking recall to stay inside this run
// ---------------------------------------------------------------------------

// The bug this closes: `entry_types` carries `lesson`, and asking for lessons puts a second,
// wider search behind every prompt — one that is not bounded by this run, so what it costs
// grows with everything the instance holds rather than with this project. On the blocking
// path that is most of what a recall spends, and no budget setting buys it back, because the
// host caps the hook below what it costs. Declining it is what keeps this rung inside its
// budget.
test('rung 1 declines the cross-run lesson overlay on the blocking path', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  assertHookContract(await runHook('prompt-recall', userPromptSubmit(), { env: env(makeDataDir(), server) }));

  assert.equal(server.lastCall('POST', '/v2/control/query').body.prefer_current_run, true,
    'a hook the host will cut off at 3s cannot fund a lane that costs ~1.7s and gets slower '
    + 'as the instance grows — without this field the default install never recalls at all');
});

// `off` is the same wire shape as the blocking default; what it changes is that a budget big
// enough to afford the lane no longer buys it. It is the escape hatch for an instance where
// the lane is slow enough to hurt even the detached path.
test('MUBIT_CC_RECALL_CROSS_RUN=off declines the lane whatever the budget', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  assertHookContract(await runHook('prompt-recall', userPromptSubmit(), {
    env: env(makeDataDir(), server, {
      MUBIT_CC_RECALL_CROSS_RUN: 'off',
      MUBIT_CC_RECALL_BUDGET_MS: '9000',
      MUBIT_CC_TIMEOUT_MS: '9000',
    }),
  }));

  assert.equal(server.lastCall('POST', '/v2/control/query').body.prefer_current_run, true);
});

// `on` is the counterpart pin: an operator who has decided the cross-run lessons are worth a
// slow prompt gets them, and gets them on the blocking path where `auto` would refuse.
test('MUBIT_CC_RECALL_CROSS_RUN=on pays for the lane even on the blocking path', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  assertHookContract(await runHook('prompt-recall', userPromptSubmit(), {
    env: env(makeDataDir(), server, { MUBIT_CC_RECALL_CROSS_RUN: 'on' }),
  }));

  assert.equal(server.lastCall('POST', '/v2/control/query').body.prefer_current_run, undefined,
    'absent IS false server-side: the opt-out is sent only when somebody declined the lane, '
    + 'so a request log shows the decision rather than the default');
});

// The threshold is a property of the budget, not of the installation — which is what lets one
// rule serve a 1500ms hook and a 10s detached refresh without either being told which it is.
test('auto: a budget big enough to fund the lane asks for it', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  assertHookContract(await runHook('prompt-recall', userPromptSubmit(), {
    env: env(makeDataDir(), server, {
      MUBIT_CC_RECALL_BUDGET_MS: '9000',
      MUBIT_CC_TIMEOUT_MS: '9000',
    }),
  }));

  assert.equal(server.lastCall('POST', '/v2/control/query').body.prefer_current_run, undefined,
    'auto spends the lane where there is room for it; pinning is only for the two ends');
});

// ---------------------------------------------------------------------------
// §5.2 — `rank_by`, the freshness dial
// ---------------------------------------------------------------------------

// The bug: "where were we?" is answered by whatever is most *similar* to those three words.
// `rank_by:"freshness"` asks the server to weight recency heavily for that query and that
// query only — nothing about the install changes.
test('a handoff-shaped prompt asks the server to rank by freshness', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  const r = await runHook('prompt-recall', userPromptSubmit({ prompt: 'where were we on the ingest bug?' }),
    { env: env(makeDataDir(), server) });
  assertHookContract(r);

  const body = server.lastCall('POST', '/v2/control/query').body;
  assert.equal(body.rank_by, 'freshness',
    '"where were we" is the archetypal handoff question; ranking it by similarity is the '
    + 'behaviour this dial exists to fix');
  assert.equal(body.query, 'where were we on the ingest bug?',
    'the rule reads the query text and changes nothing about it');
});

// The rule is what `auto` means, not a fallback for a missing setting. An operator who names
// a mode has made a decision, and `balanced` is reachable no other way.
test('MUBIT_CC_RECALL_RANK_BY overrides the rule in both directions', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  const handoff = userPromptSubmit({ prompt: 'catch me up on this branch' });
  assertHookContract(await runHook('prompt-recall', handoff, {
    env: env(makeDataDir(), server, { MUBIT_CC_RECALL_RANK_BY: 'balanced' }),
  }));
  assert.equal(server.lastCall('POST', '/v2/control/query').body.rank_by, 'balanced',
    'a configured mode must survive a prompt the rule would have re-ranked — otherwise the '
    + 'setting is a suggestion and "balanced" can never be reached at all');

  assertHookContract(await runHook('prompt-recall', handoff, {
    env: env(makeDataDir(), server, { MUBIT_CC_RECALL_RANK_BY: 'relevance' }),
  }));
  assert.equal(server.lastCall('POST', '/v2/control/query').body.rank_by, 'relevance',
    'pinning relevance is how an operator turns the rule off');
});

// `auto` is a client-side word. The server has no such mode, so sending it would fall
// through to the default weights while looking, in a request log, like a deliberate choice.
//
// What happens to an unusable value is a two-stage answer, and the name of this test used to
// describe only the second stage. `lib/config.mjs` clamps the key with `enumOf` first, so
// `sideways` never reaches the ladder as itself — it arrives as `auto`, and `auto` *means*
// run the rule. `lib/recall.mjs` does have a branch that omits the field entirely, but no
// caller in the plugin can reach it: all three pass a concrete mode. The omission that IS
// reachable is rung 3's, which has its own test below.
test('an unusable MUBIT_CC_RECALL_RANK_BY falls back to the rule, never to "auto"', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  const r = await runHook('prompt-recall', userPromptSubmit(), {
    env: env(makeDataDir(), server, { MUBIT_CC_RECALL_RANK_BY: 'sideways' }),
  });
  assertHookContract(r);

  const body = server.lastCall('POST', '/v2/control/query').body;
  assert.notEqual(body.rank_by, 'auto', '"auto" is never a wire value');
  assert.notEqual(body.rank_by, 'sideways', 'an unknown mode is clamped by config, not shipped');
  assert.equal(body.rank_by, 'relevance',
    'an unusable setting falls back to the rule, which is what `auto` would have done');
});

// One field on one body object covers both rungs: rung 2 is `{...body, mode:"agent_routed"}`.
// Asserted anyway, because "byte-identical but for the mode" is a claim that has to keep
// being true as fields are added.
test('rung 2 carries the same rank_by as rung 1', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': [DENIED, { json: queryResponse({ mode: 'agent_routed' }) }],
  });
  t.after(() => server.close());

  const r = await runHook('prompt-recall', userPromptSubmit({ prompt: 'what changed since yesterday?' }),
    { env: env(makeDataDir(), server, FALLBACK_ON) });
  assertHookContract(r);

  const [first, second] = server.calls('POST', '/v2/control/query').map((c) => c.body);
  assert.equal(first.rank_by, 'freshness');
  assert.equal(second.rank_by, 'freshness',
    'the fallback rung must not quietly revert to default fusion weights');
});

/*
 * THE caveat, pinned as a test because it is invisible everywhere else.
 *
 * `/v2/control/context` — rung 3, `recallAssemble:"server"` — accepts **no `rank_by` field at
 * all**, the same way it does not accept `env_tags` and `/query` does. So an operator who
 * turns rung 3 on to buy a server-assembled block silently gives up freshness ranking, and
 * nothing tells them. This asserts the field is absent rather than sent-and-ignored, so the
 * day the route starts accepting one this test fails and points at the README row that says
 * it is missing.
 */
test('rung 3 sends no rank_by, because /context has no such field', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  const r = await runHook('prompt-recall', userPromptSubmit({ prompt: 'where were we?' }), {
    env: env(makeDataDir(), server, { MUBIT_CC_RECALL_ASSEMBLE: 'server' }),
  });
  assertHookContract(r);

  const body = server.lastCall('POST', '/v2/control/context').body;
  assert.equal(body.rank_by, undefined,
    'inventing a field the server does not read would make rung 3 look ranked when it is '
    + 'not; the honest record is that recallAssemble:"server" costs you freshness');
});

/*
 * §4.1 `repo:`/`branch:` come from shelling out in a directory, and until now that directory
 * was `CLAUDE_PROJECT_DIR` — the session's launch root, which a mid-session `cd` cannot move.
 * A recall scored against the tags of a repo the user left is worse than one scored against
 * no tags at all, so the query reads the payload's `cwd` for the same reason the run id does.
 */
test('env_tags follow the prompt\'s directory, not the launch one', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const launchedIn = makeProjectDir({ git: true });
  const workingIn = makeProjectDir({ git: true });

  const r = await runHook('prompt-recall', userPromptSubmit({ cwd: workingIn }), {
    env: env(makeDataDir(), server, { CLAUDE_PROJECT_DIR: launchedIn }),
  });
  assertHookContract(r);

  const tags = server.lastCall('POST', '/v2/control/query').body.env_tags;
  assert.ok(tags.includes(`repo:${basename(workingIn)}`),
    `expected repo:${basename(workingIn)} — the directory the prompt was sent in; got ${JSON.stringify(tags)}`);
  assert.ok(!tags.includes(`repo:${basename(launchedIn)}`),
    'the launch repo is not where this prompt happened');
});

// §5.2: "query truncates to 2000 chars — recall quality does not improve past that and a
// 40 KB pasted stack trace is a slow query." /v2/control/query also has a 256 KiB cap.
test('the query is truncated to 2000 characters', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  const long = 'why is the ingest job stuck in queued? '.repeat(200); // ~7600 chars

  const r = await runHook('prompt-recall', userPromptSubmit({ prompt: long }), { env: env(dir, server) });
  assertHookContract(r);

  const q = server.lastCall('POST', '/v2/control/query').body.query;
  assert.ok(q.length <= 2000, `query was ${q.length} chars`);
  assert.ok(q.length >= 1900, `query was truncated far below the 2000-char cap (${q.length})`);
  assert.equal(q.slice(0, 1900), long.slice(0, 1900), 'truncation keeps the head of the prompt');
});

// ---------------------------------------------------------------------------
// The policy ladder: 403 → rung 2, cached
// ---------------------------------------------------------------------------

// §1.8/§5.2: a 403 on rung 1 is a policy verdict, not a failure. Descend one rung (1 LLM
// call), and never to rung 3 (2 LLM calls).
test('403 permission_denied on rung 1 falls to rung 2, byte-identical but for the mode', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': [DENIED, { json: queryResponse({ mode: 'agent_routed' }) }],
  });
  t.after(() => server.close());
  const dir = makeDataDir();

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server, FALLBACK_ON) });

  assertHookContract(r);
  server.assertCalled('POST', '/v2/control/query', 2);
  server.assertNotCalled('POST', '/v2/control/context');

  const [first, second] = server.calls('POST', '/v2/control/query').map((c) => c.body);
  assert.equal(first.mode, 'direct_bypass');
  assert.equal(second.mode, 'agent_routed');
  assert.equal(second.evidence_only, true, 'rung 2 still skips synthesis — 1 LLM call, not 2');
  assert.deepEqual({ ...second, mode: 'direct_bypass' }, first,
    'rung 2 is byte-identical to rung 1 except for the mode string');
});

// §5.2/§7: the denial is an instance-level policy fact with a 24 h TTL. Re-probing
// direct_bypass on every prompt burns a round trip forever.
test('a rung-1 denial is cached to policy/<endpoint_hash>.json with a 24h TTL', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': [DENIED, { json: queryResponse() }],
  });
  t.after(() => server.close());
  const dir = makeDataDir();
  const before = Date.now();

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) });
  assertHookContract(r);

  const files = readJsonDir(policyDir(dir));
  assert.equal(files.length, 1, `expected one policy verdict file, got ${files.map((f) => f.file)}`);
  const v = files[0].json;
  assert.equal(v.direct_bypass, 'denied');
  assert.equal(v.ttl_ms, 86400000, 'MUBIT_CC_POLICY_TTL_MS default is 24 h');
  assert.equal(typeof v.observed_at, 'number');
  assert.ok(v.observed_at >= before && v.observed_at <= Date.now() + 1000);
});

// §5.2: on the NEXT prompt, rung 1 is not probed at all. This is the whole point of
// caching the verdict — one wasted round trip per day, not one per prompt.
test('a cached denial routes the next prompt straight to rung 2', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': [DENIED, { json: queryResponse() }],
  });
  t.after(() => server.close());
  const dir = makeDataDir();

  await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server, FALLBACK_ON) });
  server.assertCalled('POST', '/v2/control/query', 2);

  server.reset();
  server.route('POST /v2/control/query', { json: queryResponse({ mode: 'agent_routed' }) });
  const r2 = await runHook('prompt-recall', userPromptSubmit({ prompt_id: 'p_second' }), {
    env: env(dir, server, FALLBACK_ON),
  });

  assertHookContract(r2);
  server.assertCalled('POST', '/v2/control/query', 1);
  assert.equal(server.lastCall('POST', '/v2/control/query').body.mode, 'agent_routed',
    'rung 1 must not be re-probed while the verdict is valid');
});

// §5.2: "A 'granted' verdict is not cached: rung 1 succeeding is self-evident and
// caching it would only add a stale-state failure mode."
test('a successful rung 1 writes nothing to policy/', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) });

  assertHookContract(r);
  assert.deepEqual(readJsonDir(policyDir(dir)), [],
    'grants are never cached — only denials are');
});

// §5.2: an operator who flips the instance's direct-search policy back on gets the free
// path back within a day, with no reinstall.
test('an expired denial re-probes rung 1 exactly once', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': [DENIED, { json: queryResponse() }],
  });
  t.after(() => server.close());
  const dir = makeDataDir();

  await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) });
  const cached = readJsonDir(policyDir(dir));
  assert.equal(cached.length, 1);
  // Age the verdict past its own TTL. The filename is discovered, not guessed, so this
  // test stays honest about the endpoint-hash scheme without duplicating it.
  writeFileSync(cached[0].path, JSON.stringify({
    ...cached[0].json,
    observed_at: Date.now() - 2 * 86400000,
  }));

  server.reset();
  server.route('POST /v2/control/query', { json: queryResponse() });
  const r2 = await runHook('prompt-recall', userPromptSubmit({ prompt_id: 'p_third' }), {
    env: env(dir, server),
  });

  assertHookContract(r2);
  server.assertCalled('POST', '/v2/control/query', 1);
  assert.equal(server.lastCall('POST', '/v2/control/query').body.mode, 'direct_bypass',
    'the expired verdict must be re-probed, and the free rung reclaimed');
});

// §5.2/§7: "Keyed by endpoint hash so a local and a hosted instance hold independent
// verdicts." One instance disabling direct_bypass must not tax the other.
test('policy verdicts are per endpoint, not global', async (t) => {
  const denying = await fakeMubit({ 'POST /v2/control/query': [DENIED, { json: queryResponse() }] });
  const allowing = await fakeMubit();
  t.after(() => Promise.all([denying.close(), allowing.close()]));
  const dir = makeDataDir();

  await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, denying) });
  assert.equal(readJsonDir(policyDir(dir)).length, 1);

  const r2 = await runHook('prompt-recall', userPromptSubmit({ prompt_id: 'p_other_endpoint' }), {
    env: env(dir, allowing),
  });

  assertHookContract(r2);
  allowing.assertCalled('POST', '/v2/control/query', 1);
  assert.equal(allowing.lastCall('POST', '/v2/control/query').body.mode, 'direct_bypass',
    'the second endpoint must be probed on its own merits');
  assert.equal(readJsonDir(policyDir(dir)).length, 1,
    'the denial belongs to the first endpoint only');
});

// §5.2: "Only a 401/403 on a rung the plugin did not deliberately probe means auth is
// broken." A 401 is auth_failed — not a policy denial, never cached, and no rung-2 retry.
test('401 on rung 1 is auth_failed, never a cached policy verdict', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { status: 401, json: { error: 'unauthorized' } },
  });
  t.after(() => server.close());
  const dir = makeDataDir();

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) });

  assertHookContract(r);
  assert.deepEqual(readJsonDir(policyDir(dir)), [], 'a 401 must never be cached as a policy verdict');
  server.assertCalled('POST', '/v2/control/query', 1);
  assert.deepEqual(r.json, { suppressOutput: true },
    'auth failure costs the memory, never the prompt');
});

// ---------------------------------------------------------------------------
// Rung-independence of the rendered block
// ---------------------------------------------------------------------------

// §5.2/§4.10: "additionalContext renders identically whichever rung served it — that is the
// point of lib/assemble.mjs mirroring the server's section order and vocabulary."
test('rungs 1 and 2 render byte-identical additionalContext for the same evidence', async (t) => {
  const a = await fakeMubit();
  const b = await fakeMubit({
    'POST /v2/control/query': [DENIED, { json: queryResponse({ mode: 'agent_routed' }) }],
  });
  t.after(() => Promise.all([a.close(), b.close()]));

  const ra = await runHook('prompt-recall', userPromptSubmit(), { env: env(makeDataDir(), a) });
  const rb = await runHook('prompt-recall', userPromptSubmit(), { env: env(makeDataDir(), b, FALLBACK_ON) });

  assertHookContract(ra);
  assertHookContract(rb);
  a.assertCalled('POST', '/v2/control/query', 1);
  b.assertCalled('POST', '/v2/control/query', 2);
  assert.equal(
    ra.json.hookSpecificOutput.additionalContext,
    rb.json.hookSpecificOutput.additionalContext,
    'the assembler owns the shape, not the rung');
});

// ---------------------------------------------------------------------------
// Rung 1 only — the default. Rung 2 is a cost an operator opts into.
// ---------------------------------------------------------------------------

// The measured cost of the old default: rung 2 pays a routing LLM call at a ~5 s median
// against a 1500 ms recall budget, so on a policy-denied instance nearly every prompt spent
// the call and then aborted with nothing to show. Returning empty is strictly cheaper and no
// less useful.
test('403 on rung 1 does not descend by default — one request, no LLM call', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': [DENIED, { json: queryResponse() }] });
  t.after(() => server.close());
  const dir = makeDataDir();

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) });

  assertHookContract(r);
  server.assertCalled('POST', '/v2/control/query', 1);
  assert.equal(server.lastCall('POST', '/v2/control/query').body.mode, 'direct_bypass',
    'the only request made must be the zero-LLM one');
  server.assertNotCalled('POST', '/v2/control/context');
});

// The denial is still cached, so the next prompt does not even pay the rung-1 round trip —
// and still must not reach for rung 2.
test('a cached denial issues no request at all by default', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': [DENIED, { json: queryResponse() }] });
  t.after(() => server.close());
  const dir = makeDataDir();

  await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) });
  server.reset();

  const r2 = await runHook('prompt-recall', userPromptSubmit({ prompt_id: 'p_second' }), {
    env: env(dir, server),
  });

  assertHookContract(r2);
  server.assertCalled('POST', '/v2/control/query', 0);
});

// A policy denial is not a transport fault (§5.2), so it must not colour the status line
// with a failure state — but it must be distinguishable from "the store had nothing".
test('a policy denial records a reason without claiming a connection fault', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': [DENIED, { json: queryResponse() }] });
  t.after(() => server.close());
  const dir = makeDataDir();

  await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) });

  const m = marker(dir);
  assert.equal(m.recall.empty_reason, 'policy_denied');
  assert.equal(m.recall.sources, 0);
  assert.notEqual(m.state, 'auth_failed', 'a 403 on a probed rung is not an auth failure');
});

// ---------------------------------------------------------------------------
// A permanently dead recall path has to be visible somewhere
// ---------------------------------------------------------------------------

// The failure this closes: every hook fires, every recall returns nothing, the marker says
// `ready`, and no diagnostic anywhere reports a fault. `dry_streak` is the only field that
// separates that from a healthy run that happened to draw a blank.
test('consecutive empty recalls accumulate a dry streak', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': { json: queryResponse({ evidence: [] }) } });
  t.after(() => server.close());
  const dir = makeDataDir();

  for (let i = 1; i <= 3; i += 1) {
    await runHook('prompt-recall', userPromptSubmit({ prompt_id: `p_${i}` }), { env: env(dir, server) });
    assert.equal(marker(dir).recall.dry_streak, i, `after ${i} empty recalls`);
  }
  assert.equal(marker(dir).state, 'ready', 'an empty recall is still not a connection fault');
});

// One hit clears it, exactly as a success clears the breaker's timeout streak. Without this
// the counter would only ever climb and the signal would be worthless.
test('a recall that returns evidence clears the dry streak', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': { json: queryResponse({ evidence: [] }) } });
  t.after(() => server.close());
  const dir = makeDataDir();

  await runHook('prompt-recall', userPromptSubmit({ prompt_id: 'p_1' }), { env: env(dir, server) });
  assert.equal(marker(dir).recall.dry_streak, 1);

  server.route('POST /v2/control/query', { json: queryResponse() });
  await runHook('prompt-recall', userPromptSubmit({ prompt_id: 'p_2' }), { env: env(dir, server) });

  const m = marker(dir);
  assert.equal(m.recall.dry_streak, 0);
  assert.ok(m.recall.last_hit_at > 0, 'a hit stamps when memory last actually arrived');
});

// A failed recall is dry too — the streak counts "the model got no memory", not "the server
// said no". Otherwise a path that fails every time would report a streak of zero forever.
test('a failed recall counts toward the dry streak', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': { status: 500, json: { error: 'boom' } } });
  t.after(() => server.close());
  const dir = makeDataDir();

  await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) });

  assert.equal(marker(dir).recall.dry_streak, 1);
});

// ---------------------------------------------------------------------------
// Rung 3 — opt-in only
// ---------------------------------------------------------------------------

// §1.8/§5.2: rung 3 costs two LLM calls per prompt and exists only because an operator
// explicitly accepted that cost for the server-assembled context_block.
test('recallAssemble:"server" issues rung 3 with the documented sections body', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();

  const r = await runHook('prompt-recall', userPromptSubmit(), {
    env: env(dir, server, { MUBIT_CC_RECALL_ASSEMBLE: 'server' }),
  });

  assertHookContract(r);
  server.assertCalled('POST', '/v2/control/context', 1);

  // The question the design left open, now settled here: server mode SUBSTITUTES rung 3
  // for the ladder, it does not append itself to the end of it. §5.2's pseudocode reads as a
  // sequential fallback, which would make rung 3 reachable only after rungs 1 and 2 had both
  // failed — so the option would almost never take effect. plugin.json describes it as "how
  // recalled memory is assembled", a straight substitution, and that is the reading taken:
  // probing rung 1 first and then paying rung 3 anyway costs three LLM calls for one recall.
  server.assertNotCalled('POST', '/v2/control/query');

  const body = server.lastCall('POST', '/v2/control/context').body;
  assert.equal(body.run_id, RUN_ID);
  assert.equal(body.mode, 'sections');
  assert.equal(body.max_token_budget, 1500);
  assert.deepEqual(body.sections,
    ['mental_models', 'active_rules', 'lessons', 'facts', 'working_memory', 'traces']);
  assert.equal(body.include_working_memory, true);
  assert.equal(body.query, PROMPT);
});

// §5.2 step 5: "Rung 3 → use the server's context_block and section_summaries as-is."
// Re-assembling what you already paid two LLM calls for would be pure waste.
test('rung 3 injects the server context_block verbatim', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();

  const r = await runHook('prompt-recall', userPromptSubmit(), {
    env: env(dir, server, { MUBIT_CC_RECALL_ASSEMBLE: 'server' }),
  });

  assertHookContract(r);
  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('## Active rules'), `context_block not carried through: ${ctx}`);
  assert.ok(ctx.includes('Poll the ingest job.'));
  assert.equal(marker(dir).recall.rung, 3);
});

// ---------------------------------------------------------------------------
// Skip conditions — zero HTTP, every time
// ---------------------------------------------------------------------------

// §5.2 step 0: recall disabled means no dialing at all, not "dial and discard".
test('MUBIT_CC_RECALL=0 issues zero HTTP requests', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  const r = await runHook('prompt-recall', userPromptSubmit(), {
    env: env(makeDataDir(), server, { MUBIT_CC_RECALL: '0' }),
  });

  assertHookContract(r);
  assert.equal(server.requests.length, 0, `saw: ${server.summary()}`);
});

// §5.2 step 0: a prompt under 8 chars ("ok", "yes", "go on") carries no retrievable intent.
test('a prompt shorter than 8 characters issues zero HTTP requests', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  const r = await runHook('prompt-recall', userPromptSubmit({ prompt: 'yes' }), {
    env: env(makeDataDir(), server),
  });

  assertHookContract(r);
  assert.equal(server.requests.length, 0, `saw: ${server.summary()}`);
});

// §5.2 step 0: a slash command is addressed to the harness, not the model — recalling
// against "/mubit-memory:recall …" would inject memory into a memory command.
test('a prompt starting with "/" issues zero HTTP requests', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  const r = await runHook('prompt-recall', userPromptSubmit({ prompt: '/mubit-memory:doctor check the connection' }), {
    env: env(makeDataDir(), server),
  });

  assertHookContract(r);
  assert.equal(server.requests.length, 0, `saw: ${server.summary()}`);
});

// §5.2 step 0 / §4.7: an open breaker short-circuits before dialing. A blocking hook
// in front of every prompt must not pay a connect timeout to a server known to be down.
test('an open breaker issues zero HTTP requests', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { status: 500, json: { error: 'boom' } },
  });
  t.after(() => server.close());
  const dir = makeDataDir();
  const e = env(dir, server, { MUBIT_CC_BREAKER_THRESHOLD: '2' });

  // Two server errors inside the window open the breaker.
  await runHook('prompt-recall', userPromptSubmit({ prompt_id: 'p_a' }), { env: e });
  await runHook('prompt-recall', userPromptSubmit({ prompt_id: 'p_b' }), { env: e });

  server.reset();
  const r = await runHook('prompt-recall', userPromptSubmit({ prompt_id: 'p_c' }), { env: e });

  assertHookContract(r);
  assert.equal(server.requests.length, 0,
    `breaker open must short-circuit without dialing; saw: ${server.summary()}`);
});

// §5.2 step 3: rung 2 costs an LLM call and the whole path is bounded at 1500 ms.
// Starting a 1-LLM-call request with 300 ms left buys nothing but a visible stall.
test('rung 2 is skipped when less than 500 ms of budget remains', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': [{ ...DENIED, delayMs: 700 }, { json: queryResponse() }],
  });
  t.after(() => server.close());
  const dir = makeDataDir();

  const r = await runHook('prompt-recall', userPromptSubmit(), {
    env: env(dir, server, { MUBIT_CC_RECALL_BUDGET_MS: '1000' }),
  });

  assertHookContract(r);
  server.assertCalled('POST', '/v2/control/query', 1);
  server.assertNotCalled('POST', '/v2/control/context');
  assert.deepEqual(r.json, { suppressOutput: true });
});

// ---------------------------------------------------------------------------
// stdout contract
// ---------------------------------------------------------------------------

// §5.2: "Injecting 'I found nothing' wastes tokens and teaches the model to distrust the
// channel." Exactly {"suppressOutput": true} — no additionalContext, no systemMessage.
test('an empty result emits exactly {"suppressOutput": true}', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { json: queryResponse({ evidence: [] }) },
  });
  t.after(() => server.close());

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: env(makeDataDir(), server) });

  assertHookContract(r);
  assert.deepEqual(r.json, { suppressOutput: true });
  assert.equal(r.json.hookSpecificOutput, undefined);
  assert.equal(r.json.systemMessage, undefined);
});

// §5.2 stdout: the injection channel is hookSpecificOutput.additionalContext on
// UserPromptSubmit; the human-visible receipt is systemMessage.
test('a non-empty result emits additionalContext plus a systemMessage receipt', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: env(makeDataDir(), server) });

  assertHookContract(r);
  const hso = r.json.hookSpecificOutput;
  assert.equal(hso.hookEventName, 'UserPromptSubmit');
  assert.equal(typeof hso.additionalContext, 'string');
  assert.ok(hso.additionalContext.length > 0);
  assert.ok(hso.additionalContext.includes('Ingest returns when queued'),
    `recalled evidence must reach the prompt: ${hso.additionalContext}`);
  assert.match(r.json.systemMessage, /^mubit: \d+ memor\w+ · [\d.]+k? tok · \d+ms$/,
    `systemMessage was: ${r.json.systemMessage}`);
});

// ---------------------------------------------------------------------------
// Marker
// ---------------------------------------------------------------------------

// §4.8/§5.2 step 7: the marker records which rung served, so a user paying for rung 2 or 3
// can see it in the status line instead of discovering it on an invoice.
test('the marker records which rung served', async (t) => {
  const free = await fakeMubit();
  const denied = await fakeMubit({
    'POST /v2/control/query': [DENIED, { json: queryResponse({ mode: 'agent_routed' }) }],
  });
  t.after(() => Promise.all([free.close(), denied.close()]));

  const dirA = makeDataDir();
  const ra = await runHook('prompt-recall', userPromptSubmit(), { env: env(dirA, free) });
  assertHookContract(ra);
  const ma = marker(dirA);
  assert.equal(ma.recall.rung, 1, '0 LLM calls');
  assert.equal(ma.recall.sources, 3);
  assert.equal(ma.recall.empty_reason, '');
  assert.equal(typeof ma.recall.tokens, 'number');
  assert.equal(typeof ma.recall.ms, 'number');

  const dirB = makeDataDir();
  const rb = await runHook('prompt-recall', userPromptSubmit(), { env: env(dirB, denied, FALLBACK_ON) });
  assertHookContract(rb);
  assert.equal(marker(dirB).recall.rung, 2, '1 LLM call');
});

// ---------------------------------------------------------------------------
// The staged turn — the denominator of any precision number
// ---------------------------------------------------------------------------

// §5.2 step 6 / §5.5: the marker is last-write-wins per RUN, so a 40-prompt session leaves
// exactly one record of what recall cost. Everything the hook already computed — the rung,
// the tokens, what the budget dropped — has to land on the TURN, or the plugin can report
// what an injection cost only for whichever prompt happened to be last.
test('the staged turn records what the injection cost, not only what it named', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  const before = Date.now();

  assertHookContract(await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) }));

  const staged = turn(dir);
  assert.deepEqual(staged.recalled, ['ref_rule_1', 'ref_lesson_1', 'ref_fact_1'],
    'the existing attribution surface must survive being extended');

  const rec = staged.recall;
  assert.ok(rec && typeof rec === 'object', `the turn carries no recall record: ${JSON.stringify(staged)}`);
  assert.equal(rec.rung, 1, 'which rung answered is a per-turn fact, not a per-run one');
  assert.equal(rec.sources, 3);
  assert.equal(rec.dropped, 0);
  assert.equal(rec.empty_reason, '');
  assert.ok(rec.tokens > 0, `tokens is the cost half of precision: ${JSON.stringify(rec)}`);
  assert.ok(rec.chars > 0, 'chars is what was actually injected, independent of the 4-chars-per-token estimate');
  assert.ok(rec.at >= before && rec.at <= Date.now() + 1000, `recall.at was ${rec.at}`);
});

// §5.5: the Stop-side used-signal can only look for the memory's OWN vocabulary in the
// reply. A term the user already typed proves nothing — the model would have echoed it
// with no memory at all — so the prompt's words are subtracted here, where the prompt is
// in hand, rather than left to be re-derived at Stop.
test('the staged terms are what the memory added, not what the prompt already said', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();

  assertHookContract(await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) }));

  const terms = turn(dir).recall.terms;
  assert.ok(Array.isArray(terms) && terms.length > 0, `no terms staged: ${JSON.stringify(terms)}`);
  // From the evidence and nowhere near the prompt.
  assert.ok(terms.includes('indexing'), `"indexing" is memory-only vocabulary: ${terms.join(', ')}`);
  assert.ok(terms.includes('stored'), `"stored" is memory-only vocabulary: ${terms.join(', ')}`);
  // In the prompt "why is the ingest job stuck in queued?" — an echo of either proves nothing.
  assert.ok(!terms.includes('ingest'), `"ingest" came from the user, not the memory: ${terms.join(', ')}`);
  assert.ok(!terms.includes('queued'), `"queued" came from the user, not the memory: ${terms.join(', ')}`);
});

// §5.2: an empty recall injects nothing, and the turn still records that — "injected
// nothing" and "injected and was ignored" are different facts, and the empty record is
// what keeps them apart downstream.
test('an empty recall still stages the cost record, with no terms to match against', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { json: queryResponse({ evidence: [] }) },
  });
  t.after(() => server.close());
  const dir = makeDataDir();

  assertHookContract(await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) }));

  const staged = turn(dir);
  assert.deepEqual(staged.recalled, []);
  assert.equal(staged.recall.empty_reason, 'no_evidence');
  assert.equal(staged.recall.tokens, 0);
  assert.equal(staged.recall.chars, 0);
  assert.deepEqual(staged.recall.terms, []);
});

// §4.4: the turn file is a new place for a secret to land. Evidence content is not
// necessarily this plugin's own redacted capture — another client, or `mubit_remember`,
// can put anything in the store — so what recall stages goes through the same scrub as
// anything else the plugin writes down.
test('a secret inside recalled evidence never reaches the staged terms', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': {
      json: queryResponse({
        evidence: [evidence({
          id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule', score: 0.9,
          content: `Deploy with the publisher key ${SECRETS.openaiKey} exported first.`,
        })],
      }),
    },
  });
  t.after(() => server.close());
  const dir = makeDataDir();

  assertHookContract(await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) }));

  const raw = readFileSync(turnPath(dir), 'utf8');
  assert.ok(!raw.includes(SECRETS.openaiKey), `the staged turn carries a credential:\n${raw}`);
  const terms = turn(dir).recall.terms;
  assert.ok(!terms.some((tm) => SECRETS.openaiKey.toLowerCase().includes(tm)),
    `a fragment of the credential survived as a term: ${terms.join(', ')}`);
  assert.ok(!terms.includes('redacted'),
    'the placeholder is not memory vocabulary; it must not become a term to match on');
});

// ---------------------------------------------------------------------------
// The cross-turn seen-set — §5.2 step 6, `lib/seen.mjs`
// ---------------------------------------------------------------------------

/*
 * The plugin was built believing hooks are free and MCP is expensive. Measurement inverted
 * it: the whole MCP tool-name surface is 356 tokens, once, and recall injection is up to
 * 1500 tokens on EVERY prompt. Six memories about the task at hand do not stop being about
 * the task at hand on the next prompt, so before this the same six were re-sent — and
 * re-paid for — twenty times in a row.
 *
 * `hooks/src/prompt-recall.mjs` now reads `runs/<run_id>/seen.json` before assembling and
 * marks it after, next to the ids it stages for attribution.
 */

/** ~200 tokens each: the per-memory size a 1500-token budget over six memories implies. */
const bulky = (tag, ch) => `${tag} because ${ch.repeat(760)} TAIL_${tag}`;

const STICKY_EVIDENCE = () => [
  evidence({ id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule', score: 0.91, content: bulky('RULE', 'r') }),
  evidence({ id: 'e2', reference_id: 'ref_lesson_1', entry_type: 'lesson', score: 0.84, content: bulky('LESSON', 'l') }),
  evidence({ id: 'e3', reference_id: 'ref_fact_1', entry_type: 'fact', score: 0.55, content: bulky('FACT', 'f') }),
];

const seenPath = (d) => join(d, 'runs', RUN_ID, 'seen.json');

/** A distinct `prompt_id` per turn, because the turn file is keyed on it. */
const nthPrompt = (n) => userPromptSubmit({
  prompt_id: `p_seen_${String(n).padStart(3, '0')}`,
  prompt: `${PROMPT} (attempt ${n})`,
});

/*
 * THE number. Forty prompts, identical evidence every time, one process per prompt exactly
 * as the harness spawns them.
 *
 * Two assertions, and both matter. The tokens have to fall by a large margin — that is the
 * saving. And `recalled[]` has to stay the same length on every single turn — that is the
 * proof the saving did not come from quietly injecting less memory, which is the one way a
 * token graph can improve while the plugin gets worse.
 */
test('forty prompts against identical evidence pay for a memory once, not forty times', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { json: queryResponse({ evidence: STICKY_EVIDENCE() }) },
  });
  t.after(() => server.close());
  const dir = makeDataDir();
  const e = env(dir, server);

  const TURNS = 40;
  /** @type {number[]} */
  const tokens = [];
  for (let i = 1; i <= TURNS; i++) {
    const r = await runHook('prompt-recall', nthPrompt(i), { env: e });
    assertHookContract(r);
    const staged = turn(dir, `p_seen_${String(i).padStart(3, '0')}`);
    assert.equal(staged.recalled.length, 3,
      `turn ${i} injected ${staged.recalled.length} memories instead of 3 — a token saving `
      + 'that comes from recalling less is not a saving, it is a regression with a nice graph');
    tokens.push(staged.recall.tokens);
  }

  const before = tokens[0] * TURNS;   // what forty identical full-price renders cost
  const after = tokens.reduce((a, b) => a + b, 0);
  assert.ok(after * 2 < before,
    `forty prompts cost ${after} tokens against ${before} for the same evidence rendered in `
    + `full every time — under a 2x drop this mechanism is not paying for its complexity`);
  assert.ok(tokens[1] * 3 < tokens[0],
    `the second prompt cost ${tokens[1]} tokens against the first's ${tokens[0]}; the whole `
    + 'claim is that a lesson relevant for twenty prompts is paid for once at full price');
  assert.equal(tokens.at(-1), tokens[1],
    'once every entry has been seen the per-prompt cost is flat — a drift here means the '
    + 'roll-up is being rebuilt or expired inside a single session');
});

// The seam the saving rides on: what was injected is written down where the NEXT process
// can find it. Two separate `node` processes; nothing is shared but the data dir.
test('a prompt marks what it injected into the run seen-set', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { json: queryResponse({ evidence: STICKY_EVIDENCE() }) },
  });
  t.after(() => server.close());
  const dir = makeDataDir();
  const e = env(dir, server);

  const first = await runHook('prompt-recall', nthPrompt(1), { env: e });
  assertHookContract(first);

  const rolled = readJsonFile(seenPath(dir));
  assert.deepEqual(Object.keys(rolled.refs).sort(), ['ref_fact_1', 'ref_lesson_1', 'ref_rule_1'],
    'the roll-up records reference_id, the same values that reach RecordOutcome.entry_ids');

  const second = await runHook('prompt-recall', nthPrompt(2), { env: e });
  assertHookContract(second);
  const block = second.json.hookSpecificOutput.additionalContext;
  assert.ok(block.includes('ref_rule_1'), 'the repeat points at the entry by reference id');
  assert.ok(!block.includes('TAIL_RULE'), 'and does not re-send a body the model already has');
  assert.deepEqual(turn(dir, 'p_seen_002').recalled,
    ['ref_rule_1', 'ref_lesson_1', 'ref_fact_1'],
    'a degraded entry is still attributed — dropping it would stop reinforcing exactly the '
    + 'memories that stayed relevant longest');
});

// The block is written for a model, not for a log. A line that names a memory without
// carrying it has to say so, or it reads as a memory that was truncated.
test('a block containing pointers says what a pointer is', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { json: queryResponse({ evidence: STICKY_EVIDENCE() }) },
  });
  t.after(() => server.close());
  const dir = makeDataDir();
  const e = env(dir, server);

  const first = await runHook('prompt-recall', nthPrompt(1), { env: e });
  const second = await runHook('prompt-recall', nthPrompt(2), { env: e });
  assertHookContract(second);

  const plain = first.json.hookSpecificOutput.additionalContext;
  const pointed = second.json.hookSpecificOutput.additionalContext;
  assert.ok(!/injected in full earlier/i.test(plain),
    'a block with nothing degraded must not spend tokens explaining pointers');
  assert.ok(/injected in full earlier/i.test(pointed),
    'the model has to be told that a pointer line is a reference, not a shortened memory');
});

// §6.1: the opt-out. `full` is the behaviour of every release before this one.
test('recallRepeatMode "full" pays full price on every prompt', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { json: queryResponse({ evidence: STICKY_EVIDENCE() }) },
  });
  t.after(() => server.close());
  const dir = makeDataDir();
  const e = env(dir, server, { MUBIT_CC_RECALL_REPEAT_MODE: 'full' });

  assertHookContract(await runHook('prompt-recall', nthPrompt(1), { env: e }));
  const second = await runHook('prompt-recall', nthPrompt(2), { env: e });
  assertHookContract(second);

  const one = turn(dir, 'p_seen_001').recall;
  const two = turn(dir, 'p_seen_002').recall;
  assert.equal(two.tokens, one.tokens,
    'an operator who opted out of degrading repeats must get the old cost back exactly');
  assert.equal(two.pointers, 0);
  assert.ok(second.json.hookSpecificOutput.additionalContext.includes('TAIL_RULE'));
});

// The turn file is where a run's cost is measured (`scripts/mubit-inspect.mjs`). A token
// count that fell for an unrecorded reason is a number nobody can act on.
test('the staged turn records how many entries were degraded', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { json: queryResponse({ evidence: STICKY_EVIDENCE() }) },
  });
  t.after(() => server.close());
  const dir = makeDataDir();
  const e = env(dir, server);

  assertHookContract(await runHook('prompt-recall', nthPrompt(1), { env: e }));
  assertHookContract(await runHook('prompt-recall', nthPrompt(2), { env: e }));

  assert.equal(turn(dir, 'p_seen_001').recall.pointers, 0);
  assert.equal(turn(dir, 'p_seen_002').recall.pointers, 3,
    'all three entries were already shown, so all three are pointed at');
});

// §4.9: a recall that never reached the model must not claim it did. Marking on failure
// would make the NEXT prompt point at a memory that was never injected at all.
test('a failed recall marks nothing as seen', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': [
      { json: queryResponse({ evidence: STICKY_EVIDENCE() }) },
      { status: 500, json: { error: 'boom' } },
      { json: queryResponse({ evidence: STICKY_EVIDENCE() }) },
    ],
  });
  t.after(() => server.close());
  const dir = makeDataDir();
  const e = env(dir, server);

  assertHookContract(await runHook('prompt-recall', nthPrompt(1), { env: e }));
  const before = readJsonFile(seenPath(dir));

  assertHookContract(await runHook('prompt-recall', nthPrompt(2), { env: e }));
  const after = readJsonFile(seenPath(dir));
  assert.deepEqual(Object.keys(after.refs).sort(), Object.keys(before.refs).sort(),
    'a 500 injected nothing, so it must record nothing as shown');
  for (const id of Object.keys(before.refs)) {
    assert.equal(after.refs[id].count, before.refs[id].count,
      `${id} was counted as shown again by a turn that showed nothing`);
  }
});

// ===========================================================================
// Pinned context
// ===========================================================================

/**
 * A pin is a standing constraint the user set for this run — "for the rest of this, don't
 * touch the vendored server". It is neither a recalled memory nor a lesson: it holds for
 * exactly as long as the user says it does, and it has to reach the model on the turns where
 * recall reaches it with nothing at all.
 *
 * Everything below turns on one property, which is why the first assertion is an *absence*:
 * rendering a pin costs **zero HTTP requests**. `readPins` is one `readJson` on a hook that
 * blocks every prompt inside a 1500 ms budget; the network half lives in the detached
 * drainer. A mock could not fail that assertion — only a real socket count can.
 */

import { mkdirSync } from 'node:fs';

/** `${dataDir}/runs/<run_id>/pins.json` — what the drainer's refresh leaves for the hook. */
const pinsPath = (d) => join(d, 'runs', RUN_ID, 'pins.json');

/**
 * Hand-write the pin cache.
 *
 * Deliberately not built through `lib/pins.mjs`: the file is a contract between a detached
 * writer and a blocking reader, and a fixture written by the same code that reads it cannot
 * see the two drift apart.
 */
function writePins(dir, server, pins, over = {}) {
  mkdirSync(join(dir, 'runs', RUN_ID), { recursive: true });
  writeFileSync(pinsPath(dir), JSON.stringify({
    v: 1,
    run_id: RUN_ID,
    endpoint: server ? server.url : 'http://127.0.0.1:1',
    at: Date.now(),
    pins: pins.map((p, i) => (typeof p === 'string'
      ? { slug: `pin-${i + 1}`, text: p, at: Date.now() }
      : p)),
    ...over,
  }));
}

const PIN_ONE = "don't touch the vendored server";
const PIN_TWO = 'the codex twin ships with every skill';

/** The heading the block renders pins under. */
const PIN_HEADING = '## Pinned for this run';

// ---------------------------------------------------------------------------
// The promise: a pinned block costs nothing on the wire
// ---------------------------------------------------------------------------

// The whole design rests on this. If rendering a pin could dial, a standing constraint would
// become the most expensive thing in the plugin rather than the cheapest. `MUBIT_CC_RECALL=0`
// removes the recall request, so the socket count here is *only* the pins path.
test('pins: a pinned block renders with zero HTTP requests', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  writePins(dir, server, [PIN_ONE]);

  const r = await runHook('prompt-recall', userPromptSubmit(), {
    env: env(dir, server, { MUBIT_CC_RECALL: '0' }),
  });

  assertHookContract(r);
  assert.equal(server.requests.length, 0,
    `rendering a pin must not dial anything; saw: ${server.summary()}`);
  assert.ok(r.json?.hookSpecificOutput?.additionalContext?.includes(PIN_ONE),
    'the pin never reached the model');
});

// The case that matters most, and the one a naive implementation loses: the endpoint is down,
// recall is contributing nothing at all, and a standing constraint is the only thing standing
// between the model and the mistake the user pinned it to prevent.
test('pins: an open breaker still renders them, and still dials nothing', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { status: 500, json: { error: 'boom' } },
  });
  t.after(() => server.close());
  const dir = makeDataDir();
  const e = env(dir, server, { MUBIT_CC_BREAKER_THRESHOLD: '2' });

  await runHook('prompt-recall', userPromptSubmit({ prompt_id: 'p_a' }), { env: e });
  await runHook('prompt-recall', userPromptSubmit({ prompt_id: 'p_b' }), { env: e });

  writePins(dir, server, [PIN_ONE]);
  server.reset();
  const r = await runHook('prompt-recall', userPromptSubmit({ prompt_id: 'p_c' }), { env: e });

  assertHookContract(r);
  assert.equal(server.requests.length, 0,
    `the breaker short-circuit must survive; saw: ${server.summary()}`);
  assert.ok(r.json?.hookSpecificOutput?.additionalContext?.includes(PIN_ONE),
    'an open breaker is exactly when a standing constraint matters most');
});

// An empty recall injects nothing at all — that is deliberate, and it must not take the pins
// down with it.
test('pins: an empty recall still renders them', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { json: queryResponse({ evidence: [] }) },
  });
  t.after(() => server.close());
  const dir = makeDataDir();
  writePins(dir, server, [PIN_ONE]);

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) });

  assertHookContract(r);
  const ctx = r.json?.hookSpecificOutput?.additionalContext ?? '';
  assert.ok(ctx.includes(PIN_ONE), 'an empty recall injects nothing; a pin is not "nothing"');
  assert.ok(!/Recalled from memory of earlier work/.test(ctx),
    'nothing was recalled, so the caveat about recalled memory must not be printed');
});

// A recall that failed leaves the model with no memory at all. Same rule.
test('pins: a failed recall still renders them', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { status: 500, json: { error: 'boom' } },
  });
  t.after(() => server.close());
  const dir = makeDataDir();
  writePins(dir, server, [PIN_ONE]);

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) });

  assertHookContract(r);
  assert.ok(r.json?.hookSpecificOutput?.additionalContext?.includes(PIN_ONE));
});

// ---------------------------------------------------------------------------
// The tax guard
// ---------------------------------------------------------------------------

/**
 * **The regression test for everybody who is not using this feature.**
 *
 * Every assertion in this file about an exact `additionalContext` is green only because its
 * fixture has no `pins.json`. That is an accident of the fixtures until something pins it
 * deliberately, and this is that something: with no pins, the injected block is byte-for-byte
 * what it was before pinning existed — no attribute on the envelope, no heading, not one
 * space.
 *
 * The literal is the output captured from the tree before `wrap()` was touched.
 */
test('pins: with none set the injected block is byte-identical to the block before pins existed', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) });

  assertHookContract(r);
  assert.equal(r.json.hookSpecificOutput.additionalContext,
    '<mubit-memory run="cc-test-run-1" sources="3" tokens="51">\n'
    + 'Recalled from memory of earlier work — it may be incomplete or out of date, so verify '
    + 'against the code before relying on it.\n'
    + '\n'
    + '## Active rules\n'
    + '- Ingest returns when queued, not when stored; poll the job.\n'
    + '\n'
    + '## Lessons\n'
    + '- A job stays queued until indexing completes.\n'
    + '\n'
    + '## Facts\n'
    + '- IngestAccepted.status is always "queued" on success.\n'
    + '</mubit-memory>',
    'a user with no pins must pay nothing for the feature — not a token, not a byte');
});

// The same guard from the other side: the feature switched off restores the block exactly,
// even with a cache sitting on disk. Without this, "turn it off" would mean "turn most of it
// off", which is not an escape hatch anybody can rely on.
test('pins: MUBIT_CC_PINS=0 restores the block byte for byte', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  const plain = await runHook('prompt-recall', userPromptSubmit(),
    { env: env(makeDataDir(), server) });
  assertHookContract(plain);

  const withCache = makeDataDir();
  writePins(withCache, server, [PIN_ONE, PIN_TWO]);
  const off = await runHook('prompt-recall', userPromptSubmit(),
    { env: env(withCache, server, { MUBIT_CC_PINS: '0' }) });
  assertHookContract(off);

  assert.equal(off.json.hookSpecificOutput.additionalContext,
    plain.json.hookSpecificOutput.additionalContext,
    'the flag is off, so the pin cache on disk must be invisible');
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * Pins go **above** the "may be incomplete or out of date" caveat.
 *
 * That caveat is about *retrieved* memory — a ranked guess over a token budget, which may be
 * stale and was not re-checked against the working tree. A pin is none of those things: the
 * user typed it a minute ago and it is true until they say otherwise. A model that reads the
 * caveat as covering the pin will second-guess a standing constraint, which is the exact
 * opposite of what pinning is for.
 */
test('pins: render first, above the caveat, and are marked off from recalled memory', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  writePins(dir, server, [PIN_ONE, PIN_TWO]);

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) });
  assertHookContract(r);
  const ctx = r.json.hookSpecificOutput.additionalContext;

  const pinAt = ctx.indexOf(PIN_HEADING);
  const caveatAt = ctx.indexOf('Recalled from memory of earlier work');
  const recallAt = ctx.indexOf('## Active rules');
  assert.ok(pinAt >= 0, `no pinned section in:\n${ctx}`);
  assert.ok(caveatAt >= 0 && recallAt >= 0, 'this fixture recalls, so both must be present');
  assert.ok(pinAt < caveatAt,
    'the caveat is about retrieved memory; above it is the only place a pin is not covered by it');
  assert.ok(caveatAt < recallAt, 'the caveat still introduces the recalled block');
  assert.ok(ctx.includes(PIN_ONE) && ctx.includes(PIN_TWO), 'both pins must render');
});

// The clause that tells the two apart is worth ~15 tokens and is only worth them when there
// is something to tell it apart *from*. On a pins-only turn it is noise about an absence.
test('pins: the contrast clause renders only when recalled memory follows', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { json: queryResponse({ evidence: [] }) },
  });
  t.after(() => server.close());

  const alone = makeDataDir();
  writePins(alone, server, [PIN_ONE]);

  const only = await runHook('prompt-recall', userPromptSubmit(), { env: env(alone, server) });
  assertHookContract(only);
  const onlyCtx = only.json.hookSpecificOutput.additionalContext;
  assert.ok(onlyCtx.includes(PIN_ONE));
  assert.ok(!/retrieved for this prompt/i.test(onlyCtx),
    'nothing was retrieved, so there is nothing to contrast the pin with');

  const full = await fakeMubit();
  t.after(() => full.close());
  const both = makeDataDir();
  writePins(both, full, [PIN_ONE]);
  const r = await runHook('prompt-recall', userPromptSubmit(), { env: env(both, full) });
  assertHookContract(r);
  assert.match(r.json.hookSpecificOutput.additionalContext, /retrieved for this prompt/i,
    'with recalled memory below it, the model needs one line saying which is which');
});

// ---------------------------------------------------------------------------
// Identity — a pin is not a memory
// ---------------------------------------------------------------------------

/**
 * A pin never enters `recalled[]` and never enters `seen.json`.
 *
 * Both would be category errors with real costs. `recalled[]` is what `Stop` attributes a
 * turn's outcome against, and crediting a pin would reinforce or penalise an entry that was
 * never retrieved — there is no entry. The seen-set degrades a repeat into a pointer, and a
 * standing constraint degraded to "(seen earlier)" is a constraint that does nothing.
 */
test('pins: never land in recalled[] and never enter the seen-set', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  writePins(dir, server, [{ slug: 'vendored', text: PIN_ONE, at: Date.now() }]);

  assertHookContract(await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) }));

  const staged = turn(dir);
  assert.ok(!staged.recalled.includes('vendored'),
    'a pin has no reference_id, so nothing about it can be attributed');
  assert.ok(!JSON.stringify(staged.recalled).includes('pin'),
    `pins leaked into recalled[]: ${JSON.stringify(staged.recalled)}`);

  const seen = readJsonFile(seenPath(dir));
  assert.ok(!JSON.stringify(seen).includes('vendored'),
    'a pin degraded to "(seen earlier)" on the second prompt is a pin that stopped working');
});

// The second prompt is where a seen-set bug would show: the pin must render in full again.
test('pins: render in full on every prompt, never degraded to a pointer', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  writePins(dir, server, [PIN_ONE]);
  const e = env(dir, server);

  assertHookContract(await runHook('prompt-recall', userPromptSubmit({ prompt_id: 'p_1' }), { env: e }));
  const second = await runHook('prompt-recall', userPromptSubmit({ prompt_id: 'p_2' }), { env: e });
  assertHookContract(second);

  const ctx = second.json.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes(PIN_ONE), 'the constraint is still true on the second prompt');
  assert.ok(!/\(seen earlier\)[^\n]*don't touch/.test(ctx),
    'a pin is not a repeat to be degraded — it is a standing instruction');
});

// ---------------------------------------------------------------------------
// The marker split
// ---------------------------------------------------------------------------

/**
 * `recall.tokens` keeps its meaning exactly: what *recall* cost. Pins are counted beside it
 * in `recall.pin_tokens`.
 *
 * Folding them together would silently corrupt every recall-cost measurement the plugin has
 * ever taken — the dashboard's per-turn cost, `dry_streak`, and the whole argument for the
 * seen-set. `test/statusline.test.mjs` is untouched by this ticket for the same reason: if it
 * reddens, this split was done wrong.
 */
test('pins: are counted in recall.pin_tokens and left out of recall.tokens', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  const plain = makeDataDir();
  assertHookContract(await runHook('prompt-recall', userPromptSubmit(), { env: env(plain, server) }));
  const base = marker(plain).recall;

  const pinned = makeDataDir();
  writePins(pinned, server, [PIN_ONE, PIN_TWO]);
  assertHookContract(await runHook('prompt-recall', userPromptSubmit(), { env: env(pinned, server) }));
  const withPins = marker(pinned).recall;

  assert.equal(withPins.tokens, base.tokens,
    'recall.tokens is what recall cost; a pin is not recall');
  assert.equal(withPins.sources, base.sources, 'a pin is not a source');
  assert.ok(withPins.pin_tokens > 0,
    'the pinned tokens are real context spend and must be measurable somewhere');
  assert.equal(base.pin_tokens ?? 0, 0, 'no pins, no pin tokens');
});

// ---------------------------------------------------------------------------
// The gate matrix
// ---------------------------------------------------------------------------

// `recall: false` turns *recall* off. It is not a switch for "inject nothing ever" — the user
// who set it is the user most likely to be leaning on a pin instead.
test('pins: render even with recall turned off entirely', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  writePins(dir, server, [PIN_ONE]);

  const r = await runHook('prompt-recall', userPromptSubmit(), {
    env: env(dir, server, { MUBIT_CC_RECALL: '0' }),
  });
  assertHookContract(r);
  assert.ok(r.json?.hookSpecificOutput?.additionalContext?.includes(PIN_ONE));
});

// "ok" carries no retrievable intent — which is a statement about *retrieval*. A standing
// constraint applies to "ok, do it" exactly as much as to a paragraph.
test('pins: render on a prompt too short to recall against', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  writePins(dir, server, [PIN_ONE]);

  const r = await runHook('prompt-recall', userPromptSubmit({ prompt: 'yes' }), {
    env: env(dir, server),
  });
  assertHookContract(r);
  assert.equal(server.requests.length, 0, `saw: ${server.summary()}`);
  assert.ok(r.json?.hookSpecificOutput?.additionalContext?.includes(PIN_ONE));
});

// The two gates that stay closed. A slash command is addressed to the harness, not the model,
// and an unconfigured install must not pay a run-id derivation per prompt to learn it has
// nothing to say.
test('pins: a slash command and an unconfigured install still inject nothing', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  const slash = makeDataDir();
  writePins(slash, server, [PIN_ONE]);
  const a = await runHook('prompt-recall', userPromptSubmit({ prompt: '/mubit-memory:doctor check' }),
    { env: env(slash, server) });
  assertHookContract(a);
  assert.equal(a.json?.hookSpecificOutput, undefined,
    'recalling into a memory command is what this gate exists to stop; a pin is no different');

  const blank = makeDataDir();
  writePins(blank, null, [PIN_ONE]);
  const b = await runHook('prompt-recall', userPromptSubmit(), {
    env: env(blank, server, { MUBIT_ENDPOINT: '' }),
  });
  assertHookContract(b);
  assert.equal(b.json?.hookSpecificOutput, undefined,
    'with no endpoint there is nothing behind the pin cache, and no run to key it by');
});

// ---------------------------------------------------------------------------
// Carry-forward
// ---------------------------------------------------------------------------

// Under `recallAsync` the hook does not dial at all. Pins ride the same synchronous path and
// must render both with a carried block and — the first prompt of a session — without one.
test('pins: render under recallAsync, with and without a carried block', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  writePins(dir, server, [PIN_ONE]);
  const e = env(dir, server, { MUBIT_CC_RECALL_ASYNC: '1' });

  // First prompt: no carry file exists yet, so recall contributes nothing.
  const first = await runHook('prompt-recall', userPromptSubmit({ prompt_id: 'p_c1' }), { env: e });
  assertHookContract(first);
  assert.ok(first.json?.hookSpecificOutput?.additionalContext?.includes(PIN_ONE),
    'the first prompt of an async session has no recalled memory; the pin is all there is');

  // A block the previous turn's refresh left behind.
  writeFileSync(join(dir, 'runs', RUN_ID, 'carry.json'), JSON.stringify({
    run_id: RUN_ID, written_at: Date.now(), for_prompt_id: 'p_c1', fetch_ms: 12,
    rung: 1, block: '## Lessons\n- CARRIED_LESSON\n', tokens: 9, sources: 1,
    dropped: 0, pointers: 0, empty_reason: '', ref_ids: ['ref_carried'],
  }));

  const second = await runHook('prompt-recall', userPromptSubmit({ prompt_id: 'p_c2' }), { env: e });
  assertHookContract(second);
  const ctx = second.json.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes(PIN_ONE) && ctx.includes('CARRIED_LESSON'));
  assert.ok(ctx.indexOf(PIN_HEADING) < ctx.indexOf('retrieved against the previous message'),
    'the pin was not retrieved against anything; the staleness note is about the carried block');
});

// ---------------------------------------------------------------------------
// Totality at the render edge
// ---------------------------------------------------------------------------

// A pin cache written by another instance, or by another run, must never render. It is the
// rule `readHealthCache` already applies, and for the same reason: switching endpoints must
// not inherit the other one's answers.
test('pins: a cache from another run or another endpoint is ignored', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  const otherRun = makeDataDir();
  writePins(otherRun, server, [PIN_ONE], { run_id: 'cc-some-other-run' });
  const a = await runHook('prompt-recall', userPromptSubmit(), { env: env(otherRun, server) });
  assertHookContract(a);
  assert.ok(!a.json.hookSpecificOutput.additionalContext.includes(PIN_ONE),
    'a pin belongs to the run it was set in');

  const otherEndpoint = makeDataDir();
  writePins(otherEndpoint, server, [PIN_ONE], { endpoint: 'https://elsewhere.example.com' });
  const b = await runHook('prompt-recall', userPromptSubmit(), { env: env(otherEndpoint, server) });
  assertHookContract(b);
  assert.ok(!b.json.hookSpecificOutput.additionalContext.includes(PIN_ONE),
    'switching instances must not inherit the other instance\'s standing constraints');
});

// A truncated file is the ordinary state of a data dir after a SIGKILL. It costs the pins and
// nothing else — the recall block still renders and the hook still exits 0.
test('pins: a truncated cache costs the pins and not the prompt', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  mkdirSync(join(dir, 'runs', RUN_ID), { recursive: true });
  writeFileSync(pinsPath(dir), '{"v":1,"run_id":"cc-test-run-1","pins":[{"slug"');

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) });
  assertHookContract(r);
  assert.match(r.json.hookSpecificOutput.additionalContext, /## Active rules/,
    'a broken pin cache must not take recall down with it');
});
