// @ts-check
/**
 * What a Codex tool call is *recorded as*, when it failed.
 *
 * ---------------------------------------------------------------------------
 * The defect
 * ---------------------------------------------------------------------------
 * Codex has no `PostToolUseFailure` event. Claude Code has one, and `capture.mjs` decides
 * `failed` from which event fired — so under Codex `failed` is `false` for every tool call
 * that has ever happened, and a failed `rm`, a failed test run and a failed `apply_patch` are
 * all stored with `outcome: 'ok'`.
 *
 * That is not a gap in memory, it is a lie in memory. `mubit_diagnose` matches an error
 * against past failures; the failure half of this plugin's memory was empty by construction on
 * this host, and the success half was polluted with things that did not work.
 *
 * ---------------------------------------------------------------------------
 * Where the truth actually lives — and where it does not
 * ---------------------------------------------------------------------------
 * Not in `tool_response`. That was the assumption going in, and a live run refutes it: for
 * `Bash`, `tool_response` is the aggregated output and nothing else. Recorded from a real
 * `codex exec`:
 *
 *     command `sh -c "echo out; exit 9"`  ->  tool_response: "out\n"
 *     command `echo hello-stdout; exit 3` ->  tool_response: "hello-stdout\n"
 *
 * Byte-for-byte what a success sends. There is no exit code in the payload at all, and the
 * `"Exit code: N\nWall time: …"` preamble is an `apply_patch` shape, not a shell one — so a
 * parser for it would fix nothing for the tool that matters most.
 *
 * The host records the outcome in the **rollout transcript**, whose path the payload carries,
 * under the same `tool_use_id`:
 *
 *     {"type":"event_msg","payload":{"type":"item_completed","item":{
 *        "type":"CommandExecution","id":"exec-…","status":"failed","exit_code":9,
 *        "duration":{"secs":0,"nanos":2375}}}}
 *
 * and it is already on disk when the hook runs — confirmed by a hook that read its own
 * `transcript_path` mid-turn and found the line.
 *
 * That record also carries `duration`, which is the other thing this file covers: `duration_ms`
 * appears in no Codex hook schema, so every stored item recorded `execution_time_ms: 0` and
 * "which calls are slow" was unanswerable.
 *
 * ---------------------------------------------------------------------------
 * The rule this settles on
 * ---------------------------------------------------------------------------
 * Only a **positive** statement from the host changes the outcome. No transcript, no matching
 * record, an unreadable file, a tool with no `CommandExecution` line — all leave the item
 * exactly as it is today. The defect being fixed is a call the host said failed being stored
 * as a success; inventing an `unknown` state for every MCP tool call is a different and larger
 * change, and not one any evidence here supports.
 */

import test from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assert, baseEnv, makeDataDir, makeProjectDir, readJsonFile, runHook, spoolFiles, tempDir,
  fakeMubit, postToolUse, stop, subagentStop, userPromptSubmit, rolloutCommandCompleted,
  rolloutJsonl, FIXTURE_TOOL_USE_ID,
} from './helpers/codex-fixtures.mjs';

const RUN_ID = 'codex-outcome-test';

/** A rollout file holding `lines`, plus the usual machinery around them. */
function rolloutFile(lines) {
  const dir = tempDir('mubit-codex-rollout-');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const path = join(dir, 'sessions', 'rollout-2026-08-21T12-19-53.jsonl');
  writeFileSync(path, `${[
    JSON.stringify({ type: 'session_meta', payload: { id: 'x', cli_version: '0.149.0' } }),
    ...lines,
  ].join('\n')}\n`);
  return path;
}

/**
 * Drive `capture` over one PostToolUse and return the item it spooled.
 *
 * @param {{rollout?: string[], payload?: Record<string, any>}} o
 */
async function captureOne(o = {}) {
  const server = await fakeMubit();
  try {
    const dataDir = makeDataDir();
    const env = baseEnv({
      dataDir,
      projectDir: makeProjectDir({ git: true }),
      endpoint: server.url,
      extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN_ID },
    });
    const payload = postToolUse({
      transcript_path: o.rollout ? rolloutFile(o.rollout) : null,
      ...(o.payload ?? {}),
    });
    const r = await runHook('capture', payload, { env });
    assert.equal(r.code, 0, `capture exited ${r.code}: ${r.stderr}`);

    const files = spoolFiles(dataDir, RUN_ID);
    assert.ok(files.length, `capture spooled nothing.\n  stderr: ${r.stderr}`);
    const spooled = readJsonFile(files[0]);
    // A spool file is one item, and its metadata rides as a JSON *string* — that is the shape
    // that goes on the wire, so it is the shape worth asserting against.
    return { ...spooled, metadata: JSON.parse(spooled.metadata_json ?? '{}') };
  } finally {
    server.close();
  }
}

// ===========================================================================
// T2.1 — a failure is stored as a failure
// ===========================================================================

test('a shell call the host recorded as failed is stored as a failure', async () => {
  const item = await captureOne({
    rollout: [rolloutCommandCompleted({ toolUseId: FIXTURE_TOOL_USE_ID, exitCode: 9 })],
    payload: { tool_response: 'out\n' },
  });

  assert.equal(item.metadata.outcome, 'failure',
    'the host recorded `status: "failed", exit_code: 9` for this exact tool_use_id, and the '
    + 'item still says the call succeeded. Every failed tool call on this host is stored as a '
    + 'success — which is why the failure half of memory is empty and mubit_diagnose has '
    + 'nothing to match against.');
  assert.match(item.text, /FAILED:/,
    'the rendered item should read as a failure too — that text is what a later recall shows.');
});

test('the exit code the host recorded is carried on the item', async () => {
  const item = await captureOne({
    rollout: [rolloutCommandCompleted({ toolUseId: FIXTURE_TOOL_USE_ID, exitCode: 9 })],
  });
  assert.equal(item.metadata.exit_code, 9,
    'the exit code is the one fact that distinguishes this from every other failure, and it '
    + 'costs nothing to keep once the record has been found.');
});

test('a shell call the host recorded as completed stays a success', async () => {
  const item = await captureOne({
    rollout: [rolloutCommandCompleted({ toolUseId: FIXTURE_TOOL_USE_ID, exitCode: 0 })],
    payload: { tool_response: 'hello probe repo\n' },
  });
  assert.equal(item.metadata.outcome, 'ok');
  assert.doesNotMatch(item.text, /FAILED:/);
});

// ===========================================================================
// The conservative half: silence never becomes a verdict
// ===========================================================================

test('no transcript leaves the outcome exactly as it was', async () => {
  const item = await captureOne({ payload: { transcript_path: null } });
  assert.equal(item.metadata.outcome, 'ok',
    'with nothing to read, the plugin must not invent a verdict in either direction.');
});

test('a transcript with no record for this call leaves the outcome alone', async () => {
  const item = await captureOne({
    rollout: [rolloutCommandCompleted({ toolUseId: 'exec-some-other-call', exitCode: 9 })],
  });
  assert.equal(item.metadata.outcome, 'ok',
    'a failure belonging to a DIFFERENT tool call was read onto this one. The join is on '
    + 'tool_use_id and must be exact.');
});

test('an unreadable transcript is not a failure verdict', async () => {
  const item = await captureOne({
    payload: { transcript_path: '/definitely/not/a/file/rollout.jsonl' },
  });
  assert.equal(item.metadata.outcome, 'ok');
});

test('a corrupt transcript line does not take the capture down with it', async () => {
  const item = await captureOne({
    rollout: [
      'not json at all {{{',
      JSON.stringify({ type: 'event_msg', payload: null }),
      rolloutCommandCompleted({ toolUseId: FIXTURE_TOOL_USE_ID, exitCode: 4 }),
    ],
  });
  assert.equal(item.metadata.outcome, 'failure',
    'the real record sits after two unparseable lines; a reader that gives up on the first '
    + 'bad line finds nothing on a real rollout, which is full of shapes it does not know.');
});

// ===========================================================================
// T2.3 — the duration the host recorded
// ===========================================================================

test('the call duration comes from the host`s record, not from zero', async () => {
  const item = await captureOne({
    rollout: [rolloutCommandCompleted({
      toolUseId: FIXTURE_TOOL_USE_ID, exitCode: 0, secs: 2, nanos: 500_000_000,
    })],
  });
  assert.equal(item.metadata.execution_time_ms, 2500,
    '`duration_ms` is in no Codex hook schema, so every item recorded execution_time_ms: 0 and '
    + '"which calls are slow" could not be answered at all. The rollout record carries '
    + '`duration: {secs, nanos}`, which is the same number the host measured.');
});

test('a sub-millisecond call is not rounded away to zero', async () => {
  const item = await captureOne({
    rollout: [rolloutCommandCompleted({
      toolUseId: FIXTURE_TOOL_USE_ID, exitCode: 0, secs: 0, nanos: 2375,
    })],
  });
  // 2375ns is 0.002375ms. Rounding it to 0 is honest; reporting it as 1 is not.
  assert.equal(item.metadata.execution_time_ms, 0,
    'a duration below a millisecond rounds to zero, and that is the right answer — but it must '
    + 'come from the recorded duration rather than from never having looked.');
});

// ===========================================================================
// T2.3 — turn ordering within a run
// ===========================================================================
//
// `turn_number` appears in none of Codex's eleven input schemas, so every stored item recorded
// `turn_number: 0` and the order of turns within a run was unrecoverable. Claude Code sends it;
// this host does not, and there is nothing in any payload to read it from.
//
// So it is derived where the turn is first seen. `stage-prompt` already writes
// `runs/<run_id>/turns/<prompt_id>.json` at UserPromptSubmit — one file per turn, in a
// directory that therefore counts them — and stamps the ordinal there. Everything downstream
// reads the payload first and that file second, so Claude Code is untouched.

/**
 * Drive one whole turn: stage the prompt, then close it with `capture --stop`.
 *
 * The environment holds the batch open (`MUBIT_CC_BATCH_MAX_ITEMS` well above what these
 * turns produce). Without that the `Stop` path fires a drain, the drain commits, and the spool
 * file this reads is deleted out from under it — which reads as "capture spooled nothing".
 */
async function turnItem(o) {
  // § Distinct text per turn, and not decoration: two turns whose prompt and answer are
  //   byte-identical produce one item, because the seen-set suppresses content already
  //   stored. A fixture that reused one prompt would look like a missing item.
  const prompt = o.prompt ?? `turn ${o.turnId.slice(-4)}: what changed?`;
  const answer = o.answer ?? `turn ${o.turnId.slice(-4)}: nothing changed.`;

  const r = await runHook('stage-prompt',
    userPromptSubmit({ turn_id: o.turnId, prompt }), { env: o.env });
  assert.equal(r.code, 0, `stage-prompt exited ${r.code}: ${r.stderr}`);

  const s = await runHook('capture',
    stop({ turn_id: o.turnId, last_assistant_message: answer }), { env: o.env, args: ['--stop'] });
  assert.equal(s.code, 0, `capture --stop exited ${s.code}: ${s.stderr}`);

  // § Found by id, not by counting. A drain can commit an earlier item while this one is
  //   being written, so the file count is the same before and after and a count-based check
  //   reports "spooled nothing" for an item that is right there.
  const want = `cc-stop-${o.turnId}`;
  const spooled = spoolFiles(o.dataDir, RUN_ID)
    .map((f) => readJsonFile(f))
    .find((it) => it?.item_id === want);
  assert.ok(spooled, `capture --stop spooled no item with id ${want}.\n  stderr: ${s.stderr}`);
  return { ...spooled, metadata: JSON.parse(spooled.metadata_json ?? '{}') };
}

test('turns are numbered within the run, in the order they happened', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const env = baseEnv({
    dataDir,
    projectDir: makeProjectDir({ git: true }),
    endpoint: server.url,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: RUN_ID,
      MUBIT_CC_BATCH_MAX_ITEMS: '999',
      MUBIT_CC_BATCH_MAX_AGE_MS: '600000',
    },
  });

  const first = await turnItem({ env, dataDir, turnId: '01a0240c-7f97-7ca3-a641-000000000001' });
  assert.equal(first.metadata.turn_number, 1,
    'the first turn of a run is turn 1. It read 0, which is what every Codex item recorded — '
    + '`turn_number` is in no Codex schema, so nothing ever set it and turn ordering within a '
    + 'run could not be reconstructed at all.');

  const second = await turnItem({ env, dataDir, turnId: '01a0240c-7f97-7ca3-a641-000000000002' });
  assert.equal(second.metadata.turn_number, 2,
    'the second turn must be 2 — the ordinal is the whole point.');
});

test('re-staging the same turn does not renumber it', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const env = baseEnv({
    dataDir,
    projectDir: makeProjectDir({ git: true }),
    endpoint: server.url,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: RUN_ID,
      MUBIT_CC_BATCH_MAX_ITEMS: '999',
      MUBIT_CC_BATCH_MAX_AGE_MS: '600000',
    },
  });
  const turnId = '01a0240c-7f97-7ca3-a641-00000000000a';

  await runHook('stage-prompt', userPromptSubmit({ turn_id: turnId }), { env });
  const again = await turnItem({ env, dataDir, turnId });
  assert.equal(again.metadata.turn_number, 1,
    'staging the same turn twice moved its number. The turn file is merged onto, not '
    + 'rewritten — `prompt-recall` may have created it first — so an ordinal already there '
    + 'must survive.');
});

// ===========================================================================
// T2.4 — which model, and which subagent
// ===========================================================================

test('the model that produced an item is recorded on it', async () => {
  const item = await captureOne({});
  assert.equal(item.metadata.model, 'gpt-5.6-sol',
    '`model` is required on ten of Codex`s eleven events and was recorded nowhere, so memory '
    + 'could not say which model produced a lesson — or notice that two of them disagreed.');
});

test('an event without a model does not invent one', async (t) => {
  // § SessionEnd is the one Codex event with no `model` field at all. An empty string on the
  //   item would be worse than an absent key: it reads as "the host said the model is blank".
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const env = baseEnv({
    dataDir,
    projectDir: makeProjectDir({ git: true }),
    endpoint: server.url,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: RUN_ID,
      MUBIT_CC_BATCH_MAX_ITEMS: '999',
      MUBIT_CC_BATCH_MAX_AGE_MS: '600000',
    },
  });
  const turnId = '01a0240c-7f97-7ca3-a641-00000000000b';
  await runHook('stage-prompt', userPromptSubmit({ turn_id: turnId, prompt: 'no model here' }), { env });
  const s = await runHook('capture',
    stop({ turn_id: turnId, model: undefined, last_assistant_message: 'done, no model' }),
    { env, args: ['--stop'] });
  assert.equal(s.code, 0, s.stderr);

  const spooled = spoolFiles(dataDir, RUN_ID).map((f) => readJsonFile(f))
    .find((it) => it?.item_id === `cc-stop-${turnId}`);
  assert.ok(spooled);
  const metadata = JSON.parse(spooled.metadata_json ?? '{}');
  assert.ok(!('model' in metadata),
    `an absent model must stay absent, not become "": ${spooled.metadata_json}`);
});

test('a subagent is paired with its own transcript, not its parent`s turn', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const env = baseEnv({
    dataDir,
    projectDir: makeProjectDir({ git: true }),
    endpoint: server.url,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: RUN_ID,
      MUBIT_CC_BATCH_MAX_ITEMS: '999',
      MUBIT_CC_BATCH_MAX_AGE_MS: '600000',
    },
  });

  // The parent's turn: one prompt, staged once, shared by every subagent it fans out to.
  const turnId = '01a0240c-7f97-7ca3-a641-00000000000c';
  await runHook('stage-prompt',
    userPromptSubmit({ turn_id: turnId, prompt: 'PARENT PROMPT: audit the repo' }), { env });

  // Two siblings in that one turn, each with its own rollout and its own task.
  // § The two ids differ from their first character. `item_id` embeds only a PREFIX of the
  //   agent id, so siblings sharing one would be indistinguishable here — which is a smaller
  //   version of the very collapse this test is about.
  const sibs = [
    { agentId: 'aa11a413-16ff-75b3-a2c0-000000000001', task: 'SIBLING ONE: count the tests' },
    { agentId: 'bb22b413-16ff-75b3-a2c0-000000000002', task: 'SIBLING TWO: read the manifests' },
  ];
  const items = [];
  for (const sib of sibs) {
    const agentTranscript = rolloutFile([rolloutJsonl([
      { role: 'user', text: sib.task },
      { role: 'assistant', text: `done: ${sib.task}` },
    ]).trim()]);
    const s = await runHook('capture', subagentStop({
      turn_id: turnId,
      agent_id: sib.agentId,
      agent_transcript_path: agentTranscript,
      last_assistant_message: `done: ${sib.task}`,
    }), { env, args: ['--subagent'] });
    assert.equal(s.code, 0, s.stderr);

    const spooled = spoolFiles(dataDir, RUN_ID).map((f) => readJsonFile(f))
      .find((it) => String(it?.item_id ?? '').includes(sib.agentId.slice(0, 8)));
    assert.ok(spooled, `no item spooled for ${sib.agentId}`);
    items.push({ ...spooled, metadata: JSON.parse(spooled.metadata_json ?? '{}') });
  }

  for (const [i, item] of items.entries()) {
    assert.match(item.text, new RegExp(sibs[i].task),
      'a sibling subagent was stored against the PARENT`s staged prompt. Every subagent in a '
      + 'fan-out shares that one prompt, so all of them read as having been asked the same '
      + 'question — `agent_transcript_path` is the one field that says what this one was '
      + `actually asked.\n  got: ${item.text.slice(0, 200)}`);
    assert.doesNotMatch(item.text, /PARENT PROMPT/);
    assert.ok(item.metadata.agent_transcript_path,
      'the path itself belongs on the item: it is what lets a later reader rejoin this '
      + 'subagent to its own rollout.');
  }
});

test('a subagent with no readable transcript falls back to the parent`s turn', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const env = baseEnv({
    dataDir,
    projectDir: makeProjectDir({ git: true }),
    endpoint: server.url,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: RUN_ID,
      MUBIT_CC_BATCH_MAX_ITEMS: '999',
      MUBIT_CC_BATCH_MAX_AGE_MS: '600000',
    },
  });
  const turnId = '01a0240c-7f97-7ca3-a641-00000000000d';
  await runHook('stage-prompt',
    userPromptSubmit({ turn_id: turnId, prompt: 'PARENT PROMPT: the only prompt there is' }), { env });

  const agentId = '01a02413-16ff-75b3-a2c0-000000000003';
  const s = await runHook('capture', subagentStop({
    turn_id: turnId,
    agent_id: agentId,
    agent_transcript_path: '/definitely/not/a/file.jsonl',
    last_assistant_message: 'finished with no transcript',
  }), { env, args: ['--subagent'] });
  assert.equal(s.code, 0, s.stderr);

  const spooled = spoolFiles(dataDir, RUN_ID).map((f) => readJsonFile(f))
    .find((it) => String(it?.item_id ?? '').includes(agentId.slice(0, 8)));
  assert.ok(spooled, 'nothing was stored at all — the fallback has to still produce an item');
  assert.match(spooled.text, /PARENT PROMPT/,
    'with no readable agent transcript the parent`s staged prompt is the best available '
    + 'context, and it is what was stored before any of this. Silence must not cost the item.');
});
