// @ts-check
/**
 * `hooks/src/subagent-start.mjs` — SubagentStart, blocking (§5.2, §4.3).
 *
 * ---------------------------------------------------------------------------
 * The two facts this hook exists because of, both measured
 * ---------------------------------------------------------------------------
 * Against Claude Code 2.1.235, on a real parent turn that fanned out to two parallel
 * general-purpose subagents:
 *
 *     2 SubagentStart / 2 SubagentStop / 1 UserPromptSubmit
 *
 * 1. **`UserPromptSubmit` does not fire for a subagent.** The one that fired was the
 *    parent's. So `prompt-recall` — the entire recall path — is inert inside the Agent tool,
 *    and every subagent a user spawns works with no injected memory at all. That is not a
 *    tuning problem; the hook that would have injected simply never runs for them.
 * 2. **`SubagentStart` can inject.** The host registry says "Exit code 0 - JSON
 *    additionalContext shown to subagent", the dispatch reads
 *    `u.additionalContext = e.hookSpecificOutput.additionalContext`, and a live subagent
 *    asked where it saw an injected token answered: a system message of its own, prefixed by
 *    the host with `SubagentStart hook additional context: `.
 *
 * The host supplies that label, so the block must not restate it.
 *
 * ---------------------------------------------------------------------------
 * Three things that are wrong here and right in `prompt-recall`
 * ---------------------------------------------------------------------------
 * This is not `prompt-recall` with a different event name, and each difference below is a
 * test in this file rather than a comment because each one reads as a simplification:
 *
 *   - **The query cannot come from the payload.** `SubagentStart` carries no `prompt` and no
 *     `description` — see the recorded field list on `fx.subagentStart`. It carries the
 *     *parent's* `prompt_id`, so the query is read back out of the turn `stage-prompt` staged.
 *   - **The parent's seen-set must not be consulted.** A subagent has its own context window
 *     and has seen none of the parent's conversation. Passing the parent's seen ids would
 *     degrade to `(seen earlier)` pointers exactly the entries the parent already has —
 *     pointing the subagent at text it was never given. Marking them would be the mirror
 *     mistake, in the parent's direction.
 *   - **The budget is smaller.** A subagent's window is smaller and its task narrower, so
 *     `subagentRecallTokenBudget` sits well below the 1500 a parent gets.
 *
 * These tests are written before the implementation. Failing with
 * "hooks/src/subagent-start.mjs does not exist yet" is the expected red state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import {
  assertHookContract, assertWithinBudget, baseEnv, evidence, fakeMubit, lib, makeDataDir,
  queryResponse, readJsonFile, runHook,
} from './helpers/harness.mjs';
import { subagentStart, PROMPT_ID, SESSION_ID } from './helpers/fixtures.mjs';

const RUN_ID = 'cc-test-subrun-1';

/** The parent prompt `stage-prompt` staged, and therefore the query this hook must send. */
const PARENT_PROMPT = 'why is the ingest job stuck in queued?';

/** The plugin's own recall agent. Injecting into it would be recall recalling for recall. */
const RECALL_AGENT = 'mubit-memory:mubit-recall';

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

/**
 * The turn `stage-prompt.mjs` writes on the parent's `UserPromptSubmit`, which is the only
 * place the subagent's task text exists by the time `SubagentStart` fires.
 * @param {string} dir @param {string} [prompt] @param {string} [promptId]
 */
function stageParentTurn(dir, prompt = PARENT_PROMPT, promptId = PROMPT_ID) {
  const turns = join(dir, 'runs', RUN_ID, 'turns');
  mkdirSync(turns, { recursive: true });
  writeFileSync(join(turns, `${promptId}.json`), JSON.stringify({
    prompt, prompt_id: promptId, session_id: SESSION_ID, started_at: Date.now(), recalled: [],
  }));
  return join(turns, `${promptId}.json`);
}

/** `runs/<parent_run_id>/subagents/` — one file per subagent, named by its sub-run id. */
function subRunDir(dir) {
  return join(dir, 'runs', RUN_ID, 'subagents');
}

/** @param {string} dir @returns {Array<Record<string, any>>} */
function subRunRecords(dir) {
  try {
    return readdirSync(subRunDir(dir)).filter((f) => f.endsWith('.json'))
      .map((f) => readJsonFile(join(subRunDir(dir), f)));
  } catch {
    return [];
  }
}

/** The injected text, or `''` when the hook suppressed. @param {any} json */
function injected(json) {
  return typeof json?.hookSpecificOutput?.additionalContext === 'string'
    ? json.hookSpecificOutput.additionalContext
    : '';
}

/** Long enough that a 600-token ceiling and a 1500-token one cannot render the same set. */
function fatEvidence() {
  const sentence = (n) => `Entry ${n}: `
    + 'the ingest endpoint returns before anything is stored, so a caller that treats the '
    + 'response as durable will read its own write back as missing and retry forever. Poll '
    + 'the job id instead, and treat "queued" as the successful case rather than as a wait. ';
  return queryResponse({
    evidence: Array.from({ length: 12 }, (_, i) => evidence({
      id: `e${i}`,
      reference_id: `ref_fat_${i}`,
      entry_type: i % 2 === 0 ? 'rule' : 'lesson',
      score: 0.9 - i * 0.01,
      content: sentence(i).repeat(3),
    })),
  });
}

// ---------------------------------------------------------------------------
// The claim: a subagent starts with memory
// ---------------------------------------------------------------------------

// THE test in this file. Without it a subagent gets nothing — `UserPromptSubmit`, the only
// hook that ever injected recall, does not fire for one.
test('a subagent starts with memory: SubagentStart returns a recall block on its own event name',
  async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const dir = makeDataDir();
    stageParentTurn(dir);

    const r = await runHook('subagent-start', subagentStart(), { env: env(dir, server) });
    assertHookContract(r);

    assert.equal(r.json?.hookSpecificOutput?.hookEventName, 'SubagentStart',
      'the host throws "Hook returned incorrect event name" and injects nothing when the name '
      + 'is not the event that fired, so a borrowed UserPromptSubmit name would deliver zero');
    assert.match(injected(r.json), /queued/,
      'the subagent must receive the recalled evidence itself, not an empty envelope');
    server.assertCalled('POST', '/v2/control/query', 1);
  });

// §5.2: the ladder is `lib/recall.mjs`'s, and rung 1 is the zero-LLM-call one. A subagent
// spawn is not a licence to spend two LLM calls the parent's own prompt would not spend.
test('recall for a subagent spends one direct_bypass query and never touches /v2/control/context',
  async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const dir = makeDataDir();
    stageParentTurn(dir);

    await runHook('subagent-start', subagentStart(), { env: env(dir, server) });

    server.assertCalled('POST', '/v2/control/query', 1);
    server.assertNotCalled('POST', '/v2/control/context');
    assert.equal(server.lastCall('POST', '/v2/control/query').body.mode, 'direct_bypass',
      'a fan-out of ten subagents on rung 2 would be ten routing LLM calls in front of one turn');
  });

// The host prefixes the block with `SubagentStart hook additional context: ` itself — measured
// live, from the subagent's own report of where it saw the token. Saying it again inside the
// block spends tokens telling the model something it has already been told.
test('the injected block does not restate the label the host already prints', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  stageParentTurn(dir);

  const r = await runHook('subagent-start', subagentStart(), { env: env(dir, server) });
  assert.doesNotMatch(injected(r.json), /SubagentStart hook additional context/i,
    'the host writes that prefix; repeating it inside the block is paid-for duplication');
});

// ---------------------------------------------------------------------------
// The query — it cannot come from this payload
// ---------------------------------------------------------------------------

// `SubagentStart` carries no `prompt` and no `description`. The parent's `prompt_id` is the
// only handle on what the work is about, and `stage-prompt` already wrote the text under it.
test('the query is the parent turn\'s staged prompt, because the payload carries no task text',
  async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const dir = makeDataDir();
    stageParentTurn(dir);

    const p = subagentStart();
    assert.equal(p.prompt, undefined, 'the recorded payload has no prompt — that is the premise');
    assert.equal(p.description, undefined, 'nor a description');

    await runHook('subagent-start', p, { env: env(dir, server) });

    const body = server.lastCall('POST', '/v2/control/query').body;
    assert.equal(body.query, PARENT_PROMPT,
      'querying on the agent_type alone ("Explore") would retrieve against a word the user '
      + 'never typed; the staged turn is the only text describing the actual task');
    assert.equal(body.run_id, RUN_ID,
      'the query must read the PARENT run: a sub-run id has no memory stored against it, so '
      + 'querying one would return nothing for every subagent, forever');
  });

// No staged turn means no query text. Dialling anyway would spend a round trip per subagent
// spawn on a search with nothing to search for.
test('no staged parent turn: nothing is dialled and nothing is injected', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();

  const r = await runHook('subagent-start', subagentStart(), { env: env(dir, server) });
  assertHookContract(r);
  assert.equal(injected(r.json), '', 'nothing to query on is nothing to inject');
  server.assertNotCalled('POST', '/v2/control/query');
});

// ---------------------------------------------------------------------------
// The tighter budget
// ---------------------------------------------------------------------------

// The whole reason `recallBlock` takes a `tokenBudget` override. Reusing `recallTokenBudget`
// unchanged would spend a parent-sized 1500-token block on a three-turn Haiku agent.
test('a subagent gets a smaller block than a parent would, from identical evidence', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': { json: fatEvidence() } });
  t.after(() => server.close());

  const subDir = makeDataDir();
  stageParentTurn(subDir);
  const sub = await runHook('subagent-start', subagentStart(), { env: env(subDir, server) });

  const parentDir = makeDataDir();
  const { userPromptSubmit } = await import('./helpers/fixtures.mjs');
  const parent = await runHook('prompt-recall', userPromptSubmit({ prompt: PARENT_PROMPT }),
    { env: env(parentDir, server) });

  const subBlock = injected(sub.json);
  const parentBlock = injected(parent.json);
  assert.ok(parentBlock.length > 0, 'the parent-side control must actually render something');
  assert.ok(subBlock.length > 0, 'and so must the subagent side, or this proves nothing');
  assert.ok(subBlock.length < parentBlock.length,
    `the subagent block (${subBlock.length} chars) must be smaller than the parent's `
    + `(${parentBlock.length} chars) — same evidence, same ladder, tighter ceiling. Equal `
    + 'lengths mean the override was dropped and every subagent spawn now costs a full '
    + 'parent-sized injection.');

  const rec = subRunRecords(subDir)[0];
  assert.ok(rec.recall.tokens <= 900,
    `the rendered block came to ${rec.recall.tokens} tokens; the default subagent ceiling is `
    + 'meant to sit well below the parent\'s 1500');
});

// The dial has to be a dial. `verify-manifests` separately requires it be declared in
// plugin.json and documented in the README.
test('MUBIT_CC_SUBAGENT_RECALL_TOKENS moves the subagent ceiling', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': { json: fatEvidence() } });
  t.after(() => server.close());

  const tight = makeDataDir();
  stageParentTurn(tight);
  await runHook('subagent-start', subagentStart(),
    { env: env(tight, server, { MUBIT_CC_SUBAGENT_RECALL_TOKENS: '120' }) });

  const loose = makeDataDir();
  stageParentTurn(loose);
  await runHook('subagent-start', subagentStart(),
    { env: env(loose, server, { MUBIT_CC_SUBAGENT_RECALL_TOKENS: '1400' }) });

  const t120 = subRunRecords(tight)[0].recall.tokens;
  const t1400 = subRunRecords(loose)[0].recall.tokens;
  assert.ok(t120 <= 120, `a 120-token ceiling rendered ${t120} tokens`);
  assert.ok(t1400 > t120,
    `raising the ceiling to 1400 rendered ${t1400} tokens against ${t120} — an unread option `
    + 'is a lie to the user at enable time');
});

// ---------------------------------------------------------------------------
// Do not recurse — both directions
// ---------------------------------------------------------------------------

// The bundled agent exists to run recall through MCP. Injecting a recall block into it pays
// for the same memory twice on the one agent guaranteed to go and fetch it anyway.
for (const agentType of [RECALL_AGENT, 'mubit-recall', 'MUBIT-MEMORY:MUBIT-RECALL']) {
  test(`the recall agent gets no injected block (agent_type ${JSON.stringify(agentType)})`,
    async (t) => {
      const server = await fakeMubit();
      t.after(() => server.close());
      const dir = makeDataDir();
      stageParentTurn(dir);

      const r = await runHook('subagent-start', subagentStart({ agent_type: agentType }),
        { env: env(dir, server) });
      assertHookContract(r);
      assert.equal(injected(r.json), '',
        'the agent whose entire job is to call mubit_recall must not be handed a recall block');
      server.assertNotCalled('POST', '/v2/control/query',);
    });
}

// The other direction, which is what makes the exclusion a test rather than a tautology: a
// self-exclusion that matched everything would pass every case above and ship a dead hook.
test('an ordinary agent type is not excluded', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  stageParentTurn(dir);

  const r = await runHook('subagent-start', subagentStart({ agent_type: 'general-purpose' }),
    { env: env(dir, server) });
  assert.notEqual(injected(r.json), '',
    'general-purpose is the default fan-out agent; excluding it would make this hook inert');
  server.assertCalled('POST', '/v2/control/query', 1);
});

// ---------------------------------------------------------------------------
// Isolation — evidence distinguishable from a sibling's
// ---------------------------------------------------------------------------

// Measured live: a fan-out of two produced two SubagentStarts sharing the parent's
// `session_id` AND `prompt_id`, differing only in `agent_id`. Everything downstream that
// keys on the turn therefore collapses them; the sub-run id and the derived agent id are the
// two coordinates that do not.
test('two siblings on one parent turn leave two distinct records and two distinct agent ids',
  async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const dir = makeDataDir();
    stageParentTurn(dir);

    // The two ids the live fan-out actually produced.
    await runHook('subagent-start', subagentStart({ agent_id: 'ab55bb82d19855fbc' }),
      { env: env(dir, server) });
    await runHook('subagent-start', subagentStart({ agent_id: 'a0a7d24f87136bee1' }),
      { env: env(dir, server) });

    const records = subRunRecords(dir);
    assert.equal(records.length, 2,
      'one file per subagent, or six parallel subagents pour six streams of evidence into one '
      + 'undifferentiated record');
    assert.equal(new Set(records.map((r) => r.sub_run_id)).size, 2, 'distinct sub-run ids');
    assert.equal(new Set(records.map((r) => r.mubit_agent_id)).size, 2, 'distinct agent ids');
    assert.equal(new Set(records.map((r) => r.prompt_id)).size, 1,
      'they really do share the parent prompt — that collapse is the premise, not a bug here');

    for (const rec of records) {
      assert.equal(rec.parent_run_id, RUN_ID,
        'the parent run has to be recorded: the wire join is a pair of run ids, and this is '
        + 'the field a re-assertion after a checkpoint loss reads to rebuild the edge');
      assert.ok(rec.sub_run_id.startsWith(`${RUN_ID}-sub-`),
        `a sub-run id must be derivable from its parent, got ${rec.sub_run_id}`);
      assert.equal(rec.linked, true,
        'a star is N edges and not one: every sibling needs its own join to the hub, or the '
        + `sibling that missed out is unreadable from the parent forever (${rec.sub_run_id})`);
    }

    const spokes = server.calls('POST', '/v2/control/runs/link').map((c) => c.body.linked_run_id);
    assert.equal(new Set(spokes).size, 2,
      `the fan-out joined ${JSON.stringify(spokes)} to the parent; two siblings are two edges, `
      + 'and one call covering both would be a link to whichever spawned last');

    const agentIds = server.calls('POST', '/v2/control/query').map((c) => c.body.agent_id);
    assert.equal(new Set(agentIds).size, 2,
      `both queries went out as ${JSON.stringify(agentIds)}; two subagents working at the same `
      + 'time must not share an identity on the wire or their work cannot be told apart');
    for (const id of agentIds) {
      assert.match(id, /^claude-code-sub-/, 'a subagent is the role plus its own suffix (§4.3)');
    }
  });

// ---------------------------------------------------------------------------
// The parent's seen-set is not the subagent's
// ---------------------------------------------------------------------------

// A pointer says "you were given this in full earlier in this conversation". For a subagent
// that sentence is false: it has a fresh window and was given nothing. Reading the parent's
// set would hand it a reference id and no text.
test('the parent\'s seen ids do not degrade the subagent\'s block into pointers', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  stageParentTurn(dir);

  // Everything the default query response returns, already seen by the PARENT.
  const runDir = join(dir, 'runs', RUN_ID);
  mkdirSync(runDir, { recursive: true });
  const now = Date.now();
  const seen = {
    updated_at: now,
    entries: Object.fromEntries(['ref_rule_1', 'ref_lesson_1', 'ref_fact_1']
      .map((id) => [id, { first: now, last: now, count: 4 }])),
  };
  const seenFile = join(runDir, 'seen.json');
  writeFileSync(seenFile, JSON.stringify(seen));
  const before = readFileSync(seenFile, 'utf8');

  const r = await runHook('subagent-start', subagentStart(), { env: env(dir, server) });

  const block = injected(r.json);
  assert.doesNotMatch(block, /\(seen earlier\)/,
    'a subagent has seen nothing earlier — a pointer here names a memory and withholds its '
    + 'text, which is strictly worse than not injecting it at all');
  assert.match(block, /queued, not when stored/,
    'the entries must arrive in full, exactly as they would on a first prompt');
  assert.equal(subRunRecords(dir)[0].recall.pointers, 0, 'and nothing was degraded');

  assert.equal(readFileSync(seenFile, 'utf8'), before,
    'the subagent must not write into the parent\'s seen-set either: the parent never received '
    + 'this block, and marking it would make the parent\'s next prompt point at text it was '
    + 'never given');
});

// ---------------------------------------------------------------------------
// §4.9 — a memory layer never breaks a subagent spawn
// ---------------------------------------------------------------------------

test('an empty recall injects nothing rather than "I found nothing"', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { json: queryResponse({ evidence: [] }) },
  });
  t.after(() => server.close());
  const dir = makeDataDir();
  stageParentTurn(dir);

  const r = await runHook('subagent-start', subagentStart(), { env: env(dir, server) });
  assertHookContract(r);
  assert.equal(injected(r.json), '',
    'injecting an empty envelope wastes tokens and teaches the model to distrust the channel');
  assert.equal(r.json?.suppressOutput, true);
});

test('a 500 from the server costs the memory, not the subagent', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { status: 500, json: { error: 'boom' } },
  });
  t.after(() => server.close());
  const dir = makeDataDir();
  stageParentTurn(dir);

  const r = await runHook('subagent-start', subagentStart(), { env: env(dir, server) });
  assertHookContract(r);
  assert.equal(r.code, 0, 'exit 2 would surface stderr to the user on every subagent spawn');
  assert.equal(injected(r.json), '');
});

test('an unconfigured install dials nothing and stays silent', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  stageParentTurn(dir);

  const r = await runHook('subagent-start', subagentStart(),
    { env: { ...env(dir, server), MUBIT_ENDPOINT: '' } });
  assertHookContract(r);
  assert.equal(injected(r.json), '');
  server.assertNotCalled('POST', '/v2/control/query');
});

test('recall turned off turns this hook off too', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  stageParentTurn(dir);

  const r = await runHook('subagent-start', subagentStart(),
    { env: env(dir, server, { MUBIT_CC_RECALL: '0' }) });
  assertHookContract(r);
  assert.equal(injected(r.json), '');
  server.assertNotCalled('POST', '/v2/control/query');
});

test('a payload with no agent_id is still safe: no crash, no invented sibling', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  stageParentTurn(dir);

  const p = subagentStart();
  delete p.agent_id;
  const r = await runHook('subagent-start', p, { env: env(dir, server) });
  assertHookContract(r);
  server.assertNotCalled('POST', '/v2/control/runs/link');
  // It still injects — the memory is the point — but there is nothing to isolate it by, so
  // the record must not pretend there is.
  const rec = subRunRecords(dir)[0];
  if (rec) {
    assert.equal(rec.sub_run_id, RUN_ID,
      'with no agent_id there is no subagent to distinguish; inventing a random suffix would '
      + 'produce an id SubagentStop could never derive again');
  }
});

// ---------------------------------------------------------------------------
// Cost — one process per subagent spawn
// ---------------------------------------------------------------------------

/**
 * What this hook may cost above a bare `node` spawn. It fires once per subagent, so a
 * fan-out of ten is ten of these — in parallel, but ten processes all the same. The budget
 * covers config load, run-id derivation (which shells out to `git rev-parse`), one loopback
 * request and the record write.
 *
 * Tier 1's `link_run` is inside this figure and the figure did not move. That is the point:
 * the join is fire-and-forget within the budget the hook already had, because a subagent
 * spawn is on the critical path and a slow link would be paid by every one of them.
 */
const BUDGET_MS = 1200;

test('a subagent spawn does not pay for a slow hook', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  stageParentTurn(dir);

  const r = await runHook('subagent-start', subagentStart(), { env: env(dir, server) });
  assertHookContract(r);
  await assertWithinBudget('subagent-start', BUDGET_MS, r.ms, async () => {
    const d = makeDataDir();
    stageParentTurn(d);
    return (await runHook('subagent-start', subagentStart(), { env: env(d, server) })).ms;
  });
});

// ---------------------------------------------------------------------------
// The record itself
// ---------------------------------------------------------------------------

// `ROUTES` carries `/v2/control/runs/link` now, so this file is no longer an IOU: it is the
// local half of a join the server actually holds. Every field a re-assertion would need is
// still here, because the graph lives in `run_scopes` — an in-memory map durable only through
// a checkpoint — and a pod roll before one drops joins the user still wants.
test('the sub-run record carries everything a link_run needs, and says the link landed', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  stageParentTurn(dir);

  await runHook('subagent-start', subagentStart(), { env: env(dir, server) });

  const rec = subRunRecords(dir)[0];
  assert.ok(rec, 'no record was written at all');
  for (const key of ['sub_run_id', 'parent_run_id', 'agent_id', 'mubit_agent_id', 'agent_type',
    'session_id', 'prompt_id', 'at', 'recall', 'recalled']) {
    assert.ok(key in rec, `the record is missing "${key}"`);
  }
  assert.deepEqual(rec.recalled, ['ref_rule_1', 'ref_lesson_1', 'ref_fact_1'],
    'the ids that actually rendered, so this subagent\'s block can be attributed separately '
    + 'from its siblings\'');
  assert.equal(rec.agent_id, 'ab55bb82d19855fbc', 'the host\'s own id, unmodified');
  assert.equal(rec.linked, true,
    'the field has to mean what it says or it is worse than absent: a later reader trusts it '
    + 'to decide whether this sub-run is reachable from the parent, and postLinkRun said ok');
  assert.ok(statSync(join(subRunDir(dir), `${rec.sub_run_id}.json`)).isFile(),
    'the file is named by the sub-run id, so a sibling cannot overwrite it');
});

// ---------------------------------------------------------------------------
// Tier 1 — the join, now that there is a route (SCOPE.md I4, §6 Tier 1)
// ---------------------------------------------------------------------------

// The edge is (parent, sub) and the direction is not cosmetic. §6: a parent with N subagents
// is a star, every query originates at the hub, and `linked_runs_for(parent)` returns all N
// in one hop — which is the whole reason this tier needs no mesh and no UX.
test('a successful link joins the parent to the sub-run on /v2/control/runs/link', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  stageParentTurn(dir);

  const r = await runHook('subagent-start', subagentStart(), { env: env(dir, server) });
  assertHookContract(r);

  const rec = subRunRecords(dir)[0];
  assert.ok(rec, 'no record was written, so there is nothing the link could have been about');

  server.assertCalled('POST', '/v2/control/runs/link', 1);
  const body = server.lastCall('POST', '/v2/control/runs/link').body;
  assert.equal(body.run_id, RUN_ID,
    'the hub is the parent: a subagent should read everything the parent can, and the parent '
    + 'is the run every later query is made from');
  assert.equal(body.linked_run_id, rec.sub_run_id,
    `the spoke is this subagent's own run, got ${JSON.stringify(body.linked_run_id)} against a `
    + `record of ${rec.sub_run_id} — a join naming the wrong id is a join to nothing`);
  assert.equal(rec.linked, true, 'and the record says the call landed');
});

// The ledger is not a cache of `run_scopes`; it is the plugin's record of what was decided,
// which is what lets a link be re-asserted after the backend's in-memory graph is lost with a
// pod. Recording only the parent's end would make `/mubit-memory:link list` disagree with the
// server the moment it is read from the other side.
test('the join is written to the local ledger at both ends', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  stageParentTurn(dir);

  await runHook('subagent-start', subagentStart(), { env: env(dir, server) });

  const links = await lib('links.mjs');
  const cfg = { dataDir: dir };
  const rec = subRunRecords(dir)[0];
  assert.deepEqual(links.linkedRunIds(cfg, RUN_ID), [rec.sub_run_id],
    'the parent must be able to answer "what can I reach" offline — a list that needs the '
    + 'network answers "nothing" on an unreachable instance, which is a lie');
  assert.deepEqual(links.linkedRunIds(cfg, rec.sub_run_id), [RUN_ID],
    'and the sub-run end has to hold it too: `capture --subagent` reads this side to decide '
    + 'whether its evidence has a lane to land in');
});

// §4.9, and the design rule that makes the field worth reading: a record claiming a link that
// does not exist is worse than one admitting it does not.
test('a link the server refuses leaves linked:false and costs the spawn nothing', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/runs/link': { status: 500, json: { error: 'boom' } },
  });
  t.after(() => server.close());
  const dir = makeDataDir();
  stageParentTurn(dir);

  const r = await runHook('subagent-start', subagentStart(), { env: env(dir, server) });
  assertHookContract(r);
  assert.equal(r.code, 0,
    'exit 2 would surface stderr to the user on every subagent spawn, over a join that is '
    + 'recoverable from the record on the next attempt');
  assert.match(injected(r.json), /queued/,
    'the recall block is the thing this hook exists for; a failed link must not cost it');

  const rec = subRunRecords(dir)[0];
  assert.equal(rec.linked, false,
    'the server said 500, so nothing is joined — stamping true here would tell the next '
    + 'reader that evidence under this sub-run is reachable from the parent when it is not');

  const links = await lib('links.mjs');
  assert.deepEqual(links.linkedRunIds({ dataDir: dir }, RUN_ID), [],
    'and the ledger records decisions that landed, not ones that were attempted');
});

// The same rule one layer down: `postLinkRun` refuses a self-link before dialing, and a
// payload with no subagent identity derives the parent unchanged. Dialing it anyway would
// spend a round trip per spawn to be told what the client already knows.
test('nothing is dialled when there is no sub-run to join', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dir = makeDataDir();
  stageParentTurn(dir);

  const p = subagentStart();
  delete p.agent_id;
  const r = await runHook('subagent-start', p, { env: env(dir, server) });
  assertHookContract(r);
  server.assertNotCalled('POST', '/v2/control/runs/link');

  const links = await lib('links.mjs');
  assert.deepEqual(links.linkedRunIds({ dataDir: dir }, RUN_ID), [],
    'a run already consults its own memory, so an edge to itself adds no reach and would sit '
    + 'in the ledger as a permanent piece of noise in the Tier 3 picker');
});
