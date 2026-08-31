// @ts-check
/**
 * The involuntary surface, pinned: Labs 1-6 and 9 as assertions.
 *
 * Each test drives real hook processes against a private fake instance and asserts the
 * outcome the README documents. When the walkthrough and the plugin disagree, the test
 * pins the plugin and the README gets corrected - that is the direction of trust here;
 * the main suite under `integrations/claude-code/test/` is where behaviour itself is argued.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  LAB_ROOT, REPO_ROOT, labState, startFake, runHook, deriveLabRunId,
  marker, spoolItems, eventually, allDataFiles,
} from './helpers.mjs';

/** @type {ReturnType<typeof labState>} */ let st;
/** @type {Awaited<ReturnType<typeof startFake>>} */ let fake;
/** @type {string} */ let RUN;

before(async () => {
  st = labState();
  // Derive the run id BEFORE the fake starts: it reads LAB_RUN_ID at spawn to know which
  // corpus rows are "yours" - env.sh carries the same warning for the hand-run labs.
  RUN = deriveLabRunId(st.env);
  st.env.LAB_RUN_ID = RUN;
  fake = await startFake(st);
});
after(async () => { await fake.stop(); st.cleanup(); });

// ---------------------------------------------------------------------------------------
// Lab 1 - identity
// ---------------------------------------------------------------------------------------

const runid = (payload, extraEnv = {}) => {
  const r = spawnSync('node', [join(LAB_ROOT, 'runid.mjs'), ...(payload ? [payload] : [])], {
    cwd: REPO_ROOT, env: { ...st.env, ...extraEnv }, encoding: 'utf8',
  });
  return r.stdout;
};

test('lab 1: per-directory derives cc-<slug>-<hash8> from the project path', () => {
  assert.match(runid(), /run_id\s+cc-demo-app-[0-9a-f]{8}\n/);
  assert.match(runid(), /strategy\s+per-directory\n/);
});

test('lab 1: the other three strategies behave as documented', () => {
  assert.match(
    runid('{"session_id":"s2"}', { MUBIT_CC_RUN_STRATEGY: 'git-branch' }),
    /run_id\s+cc-demo-app-[a-z0-9-]+-[0-9a-f]{8}\n/,
    'git-branch puts the branch in the name and the hash');
  assert.match(
    runid('{"session_id":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"}', { MUBIT_CC_RUN_STRATEGY: 'per-conversation' }),
    /run_id\s+cc-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d\n/,
    'per-conversation: one conversation, one run');
  assert.match(
    runid('{"session_id":"s3"}', { MUBIT_CC_RUN_STRATEGY: 'static' }),
    /run_id\s+REFUSED:/,
    'static without MUBIT_CC_RUN_ID refuses rather than falls back - two layers for one rule');
});

test('lab 1: /clear starts a new run and the counter persists', () => {
  const first = runid('{"session_id":"clear-demo","source":"clear"}');
  const second = runid('{"session_id":"clear-demo","source":"clear"}');
  const suffix = (out) => /run_id\s+\S+-c(\d+)\n/.exec(out)?.[1];
  const a = Number(suffix(first));
  const b = Number(suffix(second));
  assert.ok(a >= 1, `first clear run carries a -c<n> suffix: ${first}`);
  assert.equal(b, a + 1, 'the counter lives in sessions/<id>.json, so a second clear increments');
});

// ---------------------------------------------------------------------------------------
// Lab 2 - SessionStart
// ---------------------------------------------------------------------------------------

test('lab 2: session-start speaks, and dials health -> register -> activity', async () => {
  const m = fake.mark();
  const r = runHook(st, 'session-start', '01-session-start.json');
  assert.equal(r.code, 0);
  const ctx = r.json?.hookSpecificOutput?.additionalContext ?? '';
  assert.match(ctx, /# Mubit memory is active/);
  assert.ok(ctx.includes(RUN), 'the steer block names the run');
  assert.match(r.json?.systemMessage ?? '', /2 global lessons/);

  // The route sequence. The standing-lessons read goes to the activity feed, not the
  // lessons route - Lab 11a explains why (the lessons route pages before it filters).
  const dialled = fake.since(m).map((q) => q.key);
  assert.deepEqual(dialled, [
    'GET /v2/core/health',
    'POST /v2/control/agents/register',
    'POST /v2/control/activity',
  ]);
  const activity = fake.since(m)[2];
  assert.equal(activity.body?.run_id, undefined, 'the standing-lessons read names no run: absent means all runs');

  // session-start also spawns a detached resume prefetch (context mode=sections). Let it
  // land here so every later test sees a settled wire - and so its existence is pinned.
  const prefetch = await eventually(() => fake.since(m).find((q) => q.key === 'POST /v2/control/context'));
  assert.ok(prefetch, 'the detached resume prefetch dialled context');
  assert.equal(prefetch.body?.mode, 'sections');
});

test('lab 2: the marker is written and the status line renders it without dialling', () => {
  const mk = marker(st, RUN);
  assert.ok(mk, 'status/<run_id>.json exists');
  assert.equal(mk.lessons.global, 2);
  assert.deepEqual([...mk.lessons.injected_ids].sort(), ['les_g1', 'les_g2']);

  const m = fake.mark();
  const r = spawnSync('node', [join(REPO_ROOT, 'integrations/claude-code/bin/statusline.mjs')], {
    cwd: REPO_ROOT, env: st.env, input: '{"session_id":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"}', encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes(RUN), `status line names the run: ${r.stdout}`);
  assert.equal(fake.since(m).length, 0, 'the status line reads files, never the wire');
});

// ---------------------------------------------------------------------------------------
// Lab 3 - UserPromptSubmit
// ---------------------------------------------------------------------------------------

test('lab 3: first prompt = resume block + rung-1 recall; both hooks share the turn file', () => {
  const m = fake.mark();
  const pr = runHook(st, 'prompt-recall', '02-prompt.json');
  assert.equal(pr.code, 0);
  const ctx = pr.json?.hookSpecificOutput?.additionalContext ?? '';

  // The resume block is newer than the walkthrough's prose: session-start prefetched it
  // detached (pinned in lab 2), and the first prompt emits it from the stash - so this
  // call dials rung 1 alone.
  assert.match(ctx, /<mubit-resume run="/);
  assert.match(ctx, /<mubit-memory run="/);

  // Rung 1: evidence-only direct bypass, rendered client-side in the server's own order.
  const calls = fake.since(m).map((q) => ({ key: q.key, mode: q.body?.mode }));
  assert.deepEqual(calls, [
    { key: 'POST /v2/control/query', mode: 'direct_bypass' },
  ]);
  const query = fake.since(m)[0].body;
  assert.equal(query.evidence_only, true);
  const rules = ctx.lastIndexOf('## Active rules');
  const lessons = ctx.lastIndexOf('## Lessons');
  const facts = ctx.lastIndexOf('## Facts');
  assert.ok(rules < lessons && lessons < facts,
    'section order is the server order, because rung 1 must be indistinguishable from rung 3');

  const sp = runHook(st, 'stage-prompt', '02-prompt.json');
  assert.equal(sp.code, 0);

  const turnsDir = join(st.dataDir, 'runs', RUN, 'turns');
  const turnFile = readdirSync(turnsDir).find((f) => f.includes('p_lab_0001'));
  assert.ok(turnFile, 'the turn file exists');
  const turn = JSON.parse(readFileSync(join(turnsDir, turnFile), 'utf8'));
  assert.match(turn.prompt ?? '', /bug in enqueue/, 'stage-prompt wrote the prompt half');
  // The staged ids are the injected standing lessons PLUS the rung-1 evidence: since the
  // lesson-scope work, a turn's outcome also moves the confidence of the lessons that were
  // injected at session start, not only what recall returned for this prompt.
  assert.deepEqual(turn.recalled ?? turn.recalled_ids ?? [],
    ['les_g2', 'les_g1', 'ref_rule_1', 'ref_lesson_1', 'ref_fact_1'],
    'prompt-recall staged injected lessons + evidence - Lab 5 sends these back as the outcome');
});

test('lab 3: a squeezed budget drops an item and says so, never treats it as a stop', () => {
  // Its own prompt id: re-running p_lab_0001 here would rewrite that turn's recalled ids
  // and quietly change what Lab 5's outcome reports.
  const payload = JSON.stringify({
    ...JSON.parse(readFileSync(join(LAB_ROOT, 'payloads/02-prompt.json'), 'utf8')),
    prompt_id: 'p_lab_budget',
  });
  const tight = { ...st.env, MUBIT_CC_RECALL_TOKENS: '40' };
  const rr = spawnSync('node', [join(REPO_ROOT, 'integrations/claude-code/hooks/src/prompt-recall.mjs')], {
    cwd: REPO_ROOT, env: tight, input: payload,
    encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(rr.status, 0);
  const mk = marker(st, RUN);
  assert.ok(mk.recall.dropped >= 1, `an item that does not fit is counted: ${JSON.stringify(mk.recall)}`);
  assert.ok(mk.recall.sources < 3, 'fewer sources made it through the 40-token budget');
});

// ---------------------------------------------------------------------------------------
// Lab 4 - capture, redaction, the two drops
// ---------------------------------------------------------------------------------------

test('lab 4: an edit is captured to the spool and the network stays silent', () => {
  const m = fake.mark();
  const r = runHook(st, 'capture', '03-edit.json');
  assert.equal(r.code, 0);
  assert.equal(fake.since(m).length, 0, 'capture never touches the network');
  const items = spoolItems(st, RUN);
  assert.equal(items.length, 1);
  assert.equal(items[0].item.intent, 'trace');
  assert.equal(items[0].item.importance, 'medium');
  assert.match(items[0].item.text, /Edit\(file_path=src\/queue\.js/);
});

test('lab 4: .env is dropped whole - a redacted map of secrets is still a map', () => {
  runHook(st, 'capture', '04-read-env.json');
  assert.equal(spoolItems(st, RUN).length, 1, 'nothing new spooled');
  const leaked = allDataFiles(st).filter((f) => f.text.includes('hunter2'));
  assert.deepEqual(leaked.map((f) => f.path), [], 'the .env content reached no file at all');
});

test('lab 4: a git-ignored path is dropped for free', () => {
  runHook(st, 'capture', '05-read-ignored.json');
  assert.equal(spoolItems(st, RUN).length, 1, 'build/bundle.js never reaches the spool');
});

test('lab 4: a failure is graded high, its secrets replaced, and the git SHA survives', () => {
  const r = runHook(st, 'capture', '06-bash-failure.json', ['--failure']);
  assert.equal(r.code, 0);
  const items = spoolItems(st, RUN);
  assert.equal(items.length, 2);
  const failure = items.find((i) => i.item.importance === 'high');
  assert.ok(failure, 'the failed Bash call is the high-importance item');
  assert.match(failure.item.text, /FAILED/);
  assert.match(failure.item.text, /\[REDACTED:/, 'secret shapes are replaced, each naming its rule');
  assert.ok(!failure.item.text.includes('hunter2'), 'the assignment value is gone');
  assert.ok(!/Bearer gh[a-z]?p?_[A-Za-z0-9]/.test(failure.item.text), 'the bearer token is gone');
  assert.match(failure.item.text, /9f2a11c4e5d6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/,
    'a 40-hex SHA is entropy-bounded below the threshold - a property, not luck');
});

test('lab 4: the plugin never captures itself talking to Mubit', () => {
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 'x', tool_name: 'Bash', tool_use_id: 't9',
    tool_input: { command: `curl ${st.env.MUBIT_ENDPOINT}/v2/core/health` }, tool_output: 'OK',
  });
  const r = spawnSync('node', [join(REPO_ROOT, 'integrations/claude-code/hooks/src/capture.mjs')], {
    cwd: REPO_ROOT, env: st.env, input: payload, encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(r.status, 0);
  assert.equal(spoolItems(st, RUN).length, 2, 'self-reference suppressed: the spool is unchanged');
});

// ---------------------------------------------------------------------------------------
// Lab 5 - Stop: drain and outcome
// ---------------------------------------------------------------------------------------

test('lab 5: the turn closes - ingest carries the turn, outcome carries the recalled ids', async () => {
  const m = fake.mark();
  const r = runHook(st, 'capture', '07-stop.json', ['--stop']);
  assert.equal(r.code, 0);

  const ingest = await eventually(() => fake.since(m).find((q) => q.key === 'POST /v2/control/ingest'));
  assert.ok(ingest, 'the detached drain posted the batch');
  const items = ingest.body.items;
  assert.equal(items.length, 3, 'two spooled tool items plus the turn itself');
  const turnItem = items.find((i) => i.intent === 'task_result');
  assert.ok(turnItem, 'the third item is the turn');
  assert.match(turnItem.text, /Q: .*A: /s, 'assembled from the staged prompt plus the answer - neither half exists in one payload');
  assert.match(ingest.body.idempotency_key ?? '', /^cc-/, 'derived, not random');

  const outcome = await eventually(() => fake.since(m).find((q) => q.key === 'POST /v2/control/outcome'));
  assert.ok(outcome, 'the outcome landed');
  assert.deepEqual(outcome.body.entry_ids,
    ['les_g2', 'les_g1', 'ref_rule_1', 'ref_lesson_1', 'ref_fact_1'],
    'recall AND the injected standing lessons feed attribution - the loop that is the product');
  assert.equal(outcome.body.signal, 0.2, 'a turn completing is weak evidence, not proof');

  await eventually(() => spoolItems(st, RUN).length === 0);
  assert.equal(spoolItems(st, RUN).length, 0, 'accepted batches are unlinked');
});

test('lab 5: a second drain has nothing to send', () => {
  const m = fake.mark();
  const r = spawnSync('node', [join(REPO_ROOT, 'integrations/claude-code/hooks/src/drain.mjs')], {
    cwd: REPO_ROOT, env: st.env, input: readFileSync(join(LAB_ROOT, 'payloads/02-prompt.json'), 'utf8'),
    encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(r.status, 0);
  assert.ok(!fake.since(m).some((q) => q.key === 'POST /v2/control/ingest'), 'nothing left to send');
});

// ---------------------------------------------------------------------------------------
// Lab 6 - SessionEnd
// ---------------------------------------------------------------------------------------

test('lab 6: session-end reflects then stands down; a second end does not reflect twice', async () => {
  const m = fake.mark();
  const r = runHook(st, 'session-end', '08-session-end.json');
  assert.equal(r.code, 0);

  // The walkthrough's original text said "inline, not detached". The shipped hook now
  // flushes in a detached child (so a host teardown cannot kill the flush mid-send),
  // which is why the wire settles after the hook process has already exited.
  await eventually(() => fake.since(m).some((q) => q.key === 'POST /v2/control/agents/heartbeat'));
  const keys = fake.since(m).map((q) => q.key);
  const reflectAt = keys.indexOf('POST /v2/control/reflect');
  const idleAt = keys.indexOf('POST /v2/control/agents/heartbeat');
  assert.ok(reflectAt >= 0, `reflect fired (saw: ${keys.join(', ')})`);
  assert.ok(idleAt > reflectAt, 'heartbeat idle comes after reflect - order is the design');
  const reflect = fake.since(m)[reflectAt];
  assert.equal(reflect.body.include_step_outcomes, true, 'outcome signals fold into the evidence');

  const m2 = fake.mark();
  const r2 = runHook(st, 'session-end', '08-session-end.json');
  assert.equal(r2.code, 0);
  await new Promise((res) => setTimeout(res, 1200));
  assert.ok(!fake.since(m2).some((q) => q.key === 'POST /v2/control/reflect'),
    'claimOnce wrote the flushed marker: a double SessionEnd is not a double reflect');
});

// ---------------------------------------------------------------------------------------
// Lab 9 - PreCompact
// ---------------------------------------------------------------------------------------

test('lab 9: checkpoint blocks, spools its anchor first, and the transcript secret never flies', async () => {
  const m = fake.mark();
  const r = runHook(st, 'checkpoint', '10-precompact.json', ['--pre']);
  assert.equal(r.code, 0);
  const posted = fake.since(m).find((q) => q.key === 'POST /v2/control/checkpoint');
  assert.ok(posted, 'the one blocking network call');
  assert.ok(!JSON.stringify(fake.since(m)).includes('hunter2'),
    'the DATABASE_PASSWORD line in the transcript never reaches the wire');

  const post = runHook(st, 'checkpoint', '10-precompact.json', ['--post']);
  assert.equal(post.code, 0, '--post is a file read and must not fail');
});

// ---------------------------------------------------------------------------------------
// The rule above every lab: hooks exit 0, always
// ---------------------------------------------------------------------------------------

test('every hook exits 0 on an empty payload - a memory may be lost, a turn never', () => {
  for (const name of ['session-start', 'prompt-recall', 'stage-prompt', 'capture', 'drain', 'session-end']) {
    const r = spawnSync('node', [join(REPO_ROOT, `integrations/claude-code/hooks/src/${name}.mjs`)], {
      cwd: REPO_ROOT, env: st.env, input: '{}', encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(r.status, 0, `${name} with {} on stdin`);
  }
});
