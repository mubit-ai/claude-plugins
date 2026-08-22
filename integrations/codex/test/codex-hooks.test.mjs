// @ts-check
/**
 * Every Codex event, end to end: spawn the real hook, hand it a real Codex payload, and
 * assert on what it did.
 *
 * This is the file that would catch a port that type-checks and does nothing. The gates:
 *
 *   - the universal contract (exit 0, JSON object on stdout) on every event;
 *   - the emitted `hookEventName` matches the event, because Codex validates the envelope
 *     and reports a mismatch to the user as a hook error;
 *   - **zero HTTP where the contract says zero**, asserted against a real loopback server
 *     rather than inferred from timing. `capture` runs on every tool call: one blocking
 *     request there is a network round trip per tool call, which is the difference between a
 *     plugin you leave on and one you uninstall;
 *   - the state each hook was supposed to leave behind actually exists on disk.
 *
 * Everything runs against `fakeMubit()` on 127.0.0.1 and a temp data directory. Nothing here
 * reaches a network, and nothing is monkey-patched: these are the same subprocesses Codex
 * spawns, reading the same stdin.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  sessionStart, userPromptSubmit, preToolUse, permissionRequest, postToolUse,
  preCompact, postCompact, subagentStart, subagentStop, stop, sessionEnd,
  runHook, baseEnv, makeDataDir, makeProjectDir, fakeMubit,
  assertHookContract, spoolFiles, readJsonDir, waitFor,
} from './helpers/codex-fixtures.mjs';

const RUN_ID = 'codex-hooks-test';

/**
 * A pinned environment. `static` because a per-directory derivation shells out to git, and
 * these tests are about the hooks rather than about run-id strategy — `codex-runid.test.mjs`
 * owns that, with a real repo.
 */
function env(dataDir, projectDir, endpoint, extra = {}) {
  return baseEnv({
    dataDir,
    projectDir,
    endpoint,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: RUN_ID,
      MUBIT_CC_SESSION_END_DETACH: '0',
      ...extra,
    },
  });
}

async function harness(t) {
  const server = await fakeMubit();
  t.after(() => server.close());
  return { server, dataDir: makeDataDir(), projectDir: makeProjectDir({ git: true }) };
}

// ===========================================================================
// SessionStart
// ===========================================================================

test('SessionStart steers the model, and names itself correctly', async (t) => {
  const { server, dataDir, projectDir } = await harness(t);
  const r = await runHook('session-start', sessionStart(),
    { env: env(dataDir, projectDir, server.url) });

  assertHookContract(r);
  // § docs/harness-probe.md §7 proved this channel reaches the model: a string injected here
  //   came back out of the model's answer verbatim. It is also the *only* channel that does —
  //   the MCP server's `instructions` frame is not surfaced under Codex — so everything the
  //   model needs to know about Mubit rides on this one field.
  assert.equal(r.json?.hookSpecificOutput?.hookEventName, 'SessionStart',
    'Codex validates the envelope against session-start.command.output. A wrong hookEventName '
    + `is a hook error on the first event of every session. Got: ${r.stdout.slice(0, 300)}`);
  const steer = String(r.json?.hookSpecificOutput?.additionalContext ?? '');
  assert.match(steer, /[Mm]ubit/,
    'the steer block is the only statement of what Mubit is that a Codex session ever gets.');

  // § The one line of that block that is not host-neutral. Claude Code takes
  //   `/mubit-memory:recall` as a slash command; Codex lists the same skill as
  //   `mubit-memory:recall` and has no slash form at all. Telling a Codex model to type a
  //   command it does not have is a small lie in the place it is most likely to be acted on.
  assert.doesNotMatch(steer, /\/mubit-memory:/,
    'the steer block offers Claude Code slash commands to a Codex session. Codex invokes a '
    + `skill as \`mubit-memory:<name>\`. Block was:\n${steer}`);
  assert.match(steer, /mubit-memory:(remember|recall)/,
    'the block must still name the explicit skills — it is the only place a Codex session '
    + 'learns they exist before its first turn.');
});

test('SessionStart writes the run marker the status surfaces and the doctor skill read', async (t) => {
  const { server, dataDir, projectDir } = await harness(t);
  await runHook('session-start', sessionStart(),
    { env: env(dataDir, projectDir, server.url) });
  // § Without this file `/mubit-memory:doctor` has nothing local to read and every diagnosis
  //   starts with a network call.
  const markers = readdirSync(join(dataDir, 'status')).filter((f) => f.endsWith('.json'));
  assert.ok(markers.length >= 1,
    `no status marker under ${join(dataDir, 'status')} — the session left no local trace at all.`);
});

// ===========================================================================
// UserPromptSubmit — two handlers on one event
// ===========================================================================

test('UserPromptSubmit: prompt-recall injects under the right event name', async (t) => {
  const { server, dataDir, projectDir } = await harness(t);
  const r = await runHook('prompt-recall', userPromptSubmit(),
    { env: env(dataDir, projectDir, server.url) });

  assertHookContract(r);
  // § The recall hook is allowed to inject nothing — an empty memory is a real answer. But the
  //   fake server above HAS memory to return, so on this path it must inject, and the check
  //   below has to run. Guarding it with `if (hso)` made it vacuous: a hook that silently
  //   stopped injecting altogether passed this test, which is the failure it exists to catch.
  const hso = r.json?.hookSpecificOutput;
  assert.ok(hso,
    'prompt-recall injected nothing against a server that returned memory. Either recall is '
    + `broken or the fixture stopped returning evidence.\n  stdout: ${r.stdout}`);
  assert.equal(hso.hookEventName, 'UserPromptSubmit',
    'the envelope must name the event Codex dispatched, not the one Claude Code would have.');
  assert.ok(typeof hso.additionalContext === 'string' && hso.additionalContext.trim(),
    'the envelope is there and carries no context, which injects an empty block.');
  assert.equal(typeof r.json, 'object', 'stdout must be a JSON object on every path.');
});

test('UserPromptSubmit: stage-prompt files the turn under `turn_id`', async (t) => {
  const { server, dataDir, projectDir } = await harness(t);
  const payload = userPromptSubmit();
  const r = await runHook('stage-prompt', payload, { env: env(dataDir, projectDir, server.url) });

  assertHookContract(r);
  const turns = join(dataDir, 'runs', RUN_ID, 'turns');
  const files = existsSync(turns) ? readdirSync(turns) : [];
  // § This is the `prompt_id ?? turn_id` change, observed rather than asserted about. Claude
  //   Code names this file after `prompt_id`; Codex sends `turn_id` and no `prompt_id` at all.
  //   A hook that staged under one key and read under the other would stage every turn and
  //   find none of them: recall would inject, `Stop` would find no prompt to pair with the
  //   answer, and no outcome would ever be attributed. Nothing would error.
  assert.ok(files.length === 1,
    `expected exactly one staged turn under ${turns}, found ${files.length}: ${files.join(', ')}. `
    + 'Codex sends turn_id where Claude Code sends prompt_id.');
  assert.match(files[0], new RegExp(payload.turn_id.slice(0, 8)),
    `the staged turn file must be named after turn_id (${payload.turn_id}), or every later `
    + `read misses it. Got ${files[0]}.`);
});

// ===========================================================================
// PreToolUse
// ===========================================================================

test('PreToolUse never denies, whatever it finds', async (t) => {
  const { server, dataDir, projectDir } = await harness(t);
  const r = await runHook('pre-tool', preToolUse({
    tool_name: 'Bash', tool_input: { command: 'rm -rf build' },
  }), { env: env(dataDir, projectDir, server.url, { MUBIT_CC_PRE_TOOL_WARNINGS: '1' }) });

  assertHookContract(r);
  // § The Claude Code suite makes this same assertion across a dozen paths, and the reason
  //   carries over unchanged: Codex reads exit code 2 as a block and lets every other non-zero
  //   code through, so the dangerous value is the one a naive error handler picks. A memory
  //   layer has no business stopping a tool call.
  assert.equal(r.code, 0, 'exit 2 blocks the tool call under Codex exactly as under Claude Code.');
  assert.equal(r.json?.hookSpecificOutput?.permissionDecision, undefined,
    'no permissionDecision on any path. The hook warns; it never decides.');
  assert.equal(r.json?.decision, undefined, 'no top-level decision either.');
  assert.equal(r.json?.hookSpecificOutput?.updatedInput, undefined,
    'the hook never rewrites a tool call.');
});

test('PreToolUse makes no network call', async (t) => {
  const { server, dataDir, projectDir } = await harness(t);
  await runHook('pre-tool', preToolUse(),
    { env: env(dataDir, projectDir, server.url, { MUBIT_CC_PRE_TOOL_WARNINGS: '1' }) });
  // § Asserted against a real loopback server, not against a stopwatch. This hook sits in
  //   front of every tool call the matcher admits; one blocking request here is a round trip
  //   the user waits out before every shell command.
  assert.equal(server.requests.length, 0,
    `pre-tool dialled ${server.requests.map((q) => q.path).join(', ')}. It reads a local rule `
    + 'store and nothing else.');
});

// ===========================================================================
// PermissionRequest
// ===========================================================================

test('PermissionRequest is observed, never decided', async (t) => {
  const { server, dataDir, projectDir } = await harness(t);
  const r = await runHook('capture', permissionRequest(),
    { args: ['--permission'], env: env(dataDir, projectDir, server.url) });

  assertHookContract(r);
  // § permission-request.command.output offers exactly two fields: `decision` and
  //   `hookEventName`. There is no additionalContext, so there is nothing to *tell* the model
  //   here — the only two options are deciding, which this plugin never does, and observing.
  assert.equal(r.json?.hookSpecificOutput?.decision, undefined,
    'the plugin must never answer a permission request. It is a memory layer, not a policy '
    + 'engine — permissions are the host`s job and the user`s call.');
  assert.equal(server.requests.length, 0, 'capture never dials, in any mode.');
});

test('PermissionRequest records the attempt, which is the only record a denial leaves', async (t) => {
  const { server, dataDir, projectDir } = await harness(t);
  await runHook('capture', permissionRequest({
    tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/scratch' },
  }), { args: ['--permission'], env: env(dataDir, projectDir, server.url) });

  const files = spoolFiles(dataDir, RUN_ID);
  // § Observed in the probe: a permission request that the user declines produces NO
  //   PostToolUse at all. Without this mode the attempt vanishes — and "we tried this and were
  //   not allowed to" is exactly the class of fact a model cannot re-derive from the codebase.
  assert.equal(files.length, 1,
    'a gated tool call left no spool item. When the user denies it there is no PostToolUse, so '
    + 'this is the only trace that the attempt happened.');
  const item = readJsonDir(join(dataDir, 'runs', RUN_ID, 'spool'))[0]?.json;
  assert.ok(item?.intent, 'every item carries an intent; an untyped item costs an LLM call per item at ingest.');
  assert.equal(item.intent, 'feedback',
    'a permission request is a question put to a human, and §4.5 grades `feedback` as the one '
    + 'entry type that records what the human — not the model — decided. Graded as tool '
    + 'output it files with the file reads.');
  assert.match(String(item.text ?? ''), /rm -rf/,
    'the item must name what was being asked for, or it records that something happened and not what.');
  assert.equal(item.metadata_json ? JSON.parse(item.metadata_json).permission_requested : item.metadata?.permission_requested, true,
    'the item must be identifiable as a permission request rather than a completed call — '
    + 'the plugin never learns what the human answered, and an item that looks like a '
    + 'completed call would be read as one.');
});

// ===========================================================================
// PostToolUse
// ===========================================================================

test('PostToolUse spools one item and dials nothing', async (t) => {
  const { server, dataDir, projectDir } = await harness(t);
  const r = await runHook('capture', postToolUse(),
    { env: env(dataDir, projectDir, server.url) });

  assertHookContract(r);
  // § The whole design rests on this: capture is pure local I/O. Everything outbound goes
  //   through a detached drain, on a trigger.
  assert.equal(server.requests.length, 0,
    `capture dialled ${server.requests.map((q) => q.path).join(', ')} on a PostToolUse. It runs `
    + 'once per tool call; a request here is a round trip per tool call.');
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 1, 'one tool call, one spool file.');
});

test('PostToolUse survives a string tool_response, which is what Codex sends', async (t) => {
  const { server, dataDir, projectDir } = await harness(t);
  await runHook('capture', postToolUse({
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Add File: NOTES.md\n+probe note\n*** End Patch' },
    tool_response: 'Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nA NOTES.md\n',
  }), { env: env(dataDir, projectDir, server.url) });

  const items = readJsonDir(join(dataDir, 'runs', RUN_ID, 'spool')).map((f) => f.json);
  assert.equal(items.length, 1, 'an apply_patch must be captured like any other mutation.');
  assert.equal(items[0].intent, 'trace',
    'apply_patch is Codex`s Edit/Write: the change IS the episode. On the fallback it grades '
    + '`tool_output`/`low` and sinks below every file read in retrieval.');
  // § Claude Code sends `{stdout, stderr, interrupted}`; Codex sends a bare string
  //   (docs/harness-probe.md §5). A reader that only understands the object shape stores
  //   `apply_patch(...) -> ` with nothing after the arrow — it records that a patch was
  //   applied and never what it did.
  assert.match(String(items[0].text ?? ''), /Success\. Updated/,
    'the item lost the tool`s output. Codex sends tool_response as a plain string.');
});

test('the model`s own recall calls are not captured back into memory', async (t) => {
  const { server, dataDir, projectDir } = await harness(t);
  await runHook('capture', postToolUse({
    tool_name: 'mcp__mubit__mubit_recall',
    tool_input: { query: 'what do we know about the build' },
    tool_response: { content: [{ type: 'text', text: 'a previous lesson' }] },
  }), { env: env(dataDir, projectDir, server.url) });

  // § §4.4 self-reference suppression. Without it the plugin records its own traffic, recalls
  //   it, and records the recall — and the tool prefix it has to recognise is `mcp__mubit__`
  //   under Codex where it is `mcp__plugin_mubit-memory_mubit__` under Claude Code.
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 0,
    'a Mubit MCP call was captured into Mubit. The prefix differs between hosts; the '
    + 'suppression has to recognise both.');
});

// ===========================================================================
// Compaction
// ===========================================================================

test('PreCompact answers without a hookSpecificOutput, because Codex has no channel for one', async (t) => {
  const { server, dataDir, projectDir } = await harness(t);
  const r = await runHook('checkpoint', preCompact(),
    { args: ['--pre'], env: env(dataDir, projectDir, server.url) });

  assertHookContract(r);
  // § pre-compact.command.output has exactly `continue`, `stopReason`, `suppressOutput` and
  //   `systemMessage`. Emitting hookSpecificOutput is an output Codex rejects, and it rejects
  //   it in the middle of a compaction — the one moment the user is already waiting.
  assert.equal(r.json?.hookSpecificOutput, undefined,
    'PreCompact has no hookSpecificOutput under Codex. systemMessage is the only channel left.');
});

test('PostCompact answers without a hookSpecificOutput either', async (t) => {
  const { server, dataDir, projectDir } = await harness(t);
  const r = await runHook('checkpoint', postCompact(),
    { args: ['--post'], env: env(dataDir, projectDir, server.url) });

  assertHookContract(r);
  assert.equal(r.json?.hookSpecificOutput, undefined,
    'PostCompact has no hookSpecificOutput under Codex either.');
});

// ===========================================================================
// Subagents
// ===========================================================================

test('SubagentStart injects under its own event name', async (t) => {
  const { server, dataDir, projectDir } = await harness(t);
  const e = env(dataDir, projectDir, server.url);

  // § The parent's turn, staged first. `subagent-start` reads it for the query — SubagentStart
  //   carries no task text of its own — and returns early when it is absent. Without this the
  //   hook injected nothing, the `if (hso)` below never ran, and the test passed while
  //   asserting nothing at all.
  await runHook('stage-prompt', userPromptSubmit(), { env: e });

  const r = await runHook('subagent-start', subagentStart(), { env: e });

  assertHookContract(r);
  const hso = r.json?.hookSpecificOutput;
  assert.ok(hso,
    'subagent-start injected nothing with a parent turn staged and a server holding memory. '
    + 'This event is the only memory a Codex subagent will ever be given: it sees neither the '
    + 'SessionStart steer nor per-turn recall, and under Codex not the MCP server`s '
    + `instructions either.\n  stdout: ${r.stdout}`);
  assert.equal(hso.hookEventName, 'SubagentStart',
    'the envelope must name SubagentStart; subagent-start.command.output validates it.');
  assert.ok(typeof hso.additionalContext === 'string' && hso.additionalContext.trim(),
    'the envelope is there and carries no context.');
});

test('SubagentStop attributes the result to the subagent, not to the parent', async (t) => {
  const { server, dataDir, projectDir } = await harness(t);
  const payload = subagentStop();
  await runHook('capture', payload, { args: ['--subagent'], env: env(dataDir, projectDir, server.url) });

  const items = readJsonDir(join(dataDir, 'runs', RUN_ID, 'spool')).map((f) => f.json);
  assert.equal(items.length, 1, 'a SubagentStop must produce exactly one turn item.');
  const meta = items[0].metadata_json ? JSON.parse(items[0].metadata_json) : (items[0].metadata ?? {});

  // § Every coordinate the plugin keys state on is identical across sibling subagents: Codex
  //   sends the PARENT's session_id and turn_id on every subagent event, exactly as Claude
  //   Code does. `agent_id` is the only field that differs, so it is the only thing that can
  //   separate a six-way fan-out from one indistinguishable blob at recall time. The ingest
  //   item has no agent field of its own, so the attribution rides in the metadata.
  assert.equal(meta.agent_id, payload.agent_id,
    `the subagent's own agent_id is missing from the item. Codex sends `
    + `agent_id=${payload.agent_id} on every subagent event; without it two subagents working `
    + 'at the same time are one unreadable record.');
  assert.match(String(meta.mubit_agent_id ?? ''), /^codex-sub-/,
    'the derived Mubit identity must be a Codex sub-agent role. `claude-code-sub-…` here '
    + 'would count the two harnesses as one actor upstream.');
});

// ===========================================================================
// Stop and SessionEnd
// ===========================================================================

test('Stop closes the turn and pairs the answer with the staged prompt', async (t) => {
  const { server, dataDir, projectDir } = await harness(t);
  const e = env(dataDir, projectDir, server.url);
  await runHook('stage-prompt', userPromptSubmit(), { env: e });
  const r = await runHook('capture', stop(), { args: ['--stop'], env: e });

  assertHookContract(r);
  const items = readJsonDir(join(dataDir, 'runs', RUN_ID, 'spool')).map((f) => f.json);
  const turn = items.find((i) => String(i.text ?? '').startsWith('Q:'));
  // § The Q&A pair is the whole episode. `Stop` carries `last_assistant_message` but not the
  //   prompt, so the other half comes out of the turn file — which is only findable if
  //   stage-prompt and capture agree on the turn key. Under Codex that key is `turn_id`.
  assert.ok(turn,
    'no Q&A item. Either stage-prompt filed the turn under a key capture does not read, or '
    + `capture never found it. Items: ${items.map((i) => String(i.text).slice(0, 40)).join(' | ')}`);
  assert.match(String(turn.text), /Read README\.md/,
    'the staged prompt did not make it into the pair — half a conversation was stored.');
});

test('SessionEnd reflects, which is the only thing that promotes a lesson beyond its run', async (t) => {
  const { server, dataDir, projectDir } = await harness(t);
  const e = env(dataDir, projectDir, server.url);
  await runHook('capture', postToolUse(), { env: e });
  const r = await runHook('session-end', sessionEnd(), { env: e });

  assertHookContract(r);
  await waitFor(() => server.countOf('POST', '/v2/control/reflect') > 0, 5000);
  // § Turning reflection off costs cross-session memory entirely, and SessionEnd is where it
  //   happens. Under Codex the hook has three seconds — the host clamps it and says so — which
  //   is why the detached hand-off stops being optional here. This test pins the inline path
  //   (MUBIT_CC_SESSION_END_DETACH=0) so the assertion does not race a background process.
  server.assertCalled('POST', '/v2/control/reflect');
});
