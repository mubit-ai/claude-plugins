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
 * `/v2/control/context` is NOT an LLM-free assembly path: `GetContext` re-enters `query()`
 * as `AgentRouted` with `evidence_only` left `false`, pays both calls,
 * then throws the synthesized answer away. So the recall hook is query-first and treats
 * `context` as the last rung — the inverse of what the endpoint names suggest.
 *
 * These tests are written before the implementation. Failing with
 * "hooks/src/prompt-recall.mjs does not exist yet" is the expected red state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
    'every other value silently falls through to AgentRouted and costs an LLM call');
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
  // SCOPE.md Target C. Set, `consulted_runs` extends with `linked_runs_for(run_id)` and the
  // evidence loop consults every linked run with NO scope filter — `run`-scoped entries
  // included. That is the whole reason joining runs beats widening scopes: reach becomes the
  // link graph rather than a threshold's good behaviour.
  assert.equal(body.include_linked_runs, true,
    'without this the plugin can create links it is unable to read back');
  assert.ok(Array.isArray(body.env_tags), 'env_tags exists on AgentQueryRequest but not on ContextRequest');
  assert.ok(body.env_tags.includes('tool:claude-code'));
  assert.ok(body.env_tags.includes('ci:test'), 'MUBIT_CC_ENV_TAGS extras are appended verbatim');
  assert.ok(body.env_tags.length <= 8, 'env_tags is capped at 8 (§4.1)');
});

// SCOPE.md Target C — the flag is INERT until something is linked, and a plugin that ships
// with no links needs that shown rather than promised in a comment. `linked_runs_for` returns
// `scope.linked_run_ids` for the calling run, so on a run nothing has joined the extended set
// is the empty set and `consulted_runs` is exactly what it was before the flag existed.
test('include_linked_runs is inert on an unlinked run: same block, same refIds, no ledger', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();

  const r = await runHook('prompt-recall', userPromptSubmit(), { env: env(dir, server) });
  assertHookContract(r);

  assert.equal(server.lastCall('POST', '/v2/control/query').body.include_linked_runs, true,
    'the flag goes out unconditionally — the server decides reach from the graph, not the client');
  assert.equal(existsSync(join(dir, 'links')), false,
    'a default install has no link ledger at all, so the flag names the empty set: this is a '
    + 'capability the user has to grant, not a widening the plugin took for itself');

  // The rung-1 rendering of the default fixture, unchanged. A widened reach would show up
  // here first — as evidence from a run this one was never joined to.
  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('Ingest returns when queued, not when stored; poll the job.'),
    `the ordinary rung-1 block is still what gets injected: ${ctx}`);
  assert.equal(marker(dir).recall.sources, 3, 'three sources, as before the flag');
  assert.deepEqual(turn(dir).recalled, ['ref_rule_1', 'ref_lesson_1', 'ref_fact_1'],
    'the same three references an unlinked run has always been served');
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

// §5.2 / F23: on the NEXT prompt, rung 1 is not probed at all. This is the whole point of
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

// §5.2 / F27: "A 'granted' verdict is not cached: rung 1 succeeding is self-evident and
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

// §5.2 / F24: an operator who flips the instance's direct-search policy back on gets the free
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

// §5.2 / F25: "Only a 401/403 on a rung the plugin did not deliberately probe means auth is
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

// A policy denial is not a transport fault (§5.2/F22), so it must not colour the status line
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
// MUB-2 — a permanently dead recall path has to be visible somewhere
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

  // The decision phase-2-recall.md leaves open, now recorded: server mode SUBSTITUTES rung 3
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

  // SCOPE.md Target C, and the one rung it deliberately does NOT reach. `include_linked_runs`
  // could not be established as a field ContextRequest accepts: the vendored client this
  // plugin ships (`mcp/dist/server.js`) is generated against the same service and carries the
  // field explicitly on `query` and on `reflect`, and omits it from `getContext`. Two bodies
  // already known not to be interchangeable — §1.8 documents `env_tags` the same way — so it
  // is left off rather than sent to be ignored. Rung 3 is opt-in and off by default; an
  // operator paying two LLM calls a prompt for a server-assembled block does not get the link
  // graph with it, and this pins that so the gap is a decision rather than an oversight.
  assert.equal('include_linked_runs' in body, false,
    'rung 3 must not send a field ContextRequest was never shown to accept — a silently '
    + 'ignored flag reads as working reach that is not there');
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

// §5.2 step 0 / §4.7 / F7: an open breaker short-circuits before dialing. A blocking hook
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

// §5.2 step 3 / F28: rung 2 costs an LLM call and the whole path is bounded at 1500 ms.
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
