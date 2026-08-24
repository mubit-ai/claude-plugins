// @ts-check
/**
 * Every fixture, and every hook's output, against what the host was recorded doing.
 *
 * This is the load-bearing file of the Codex suite, and the reason is worth stating plainly:
 * **a fixture written beside an implementation cannot falsify that implementation.** Whatever
 * shape the code reads, the fixture will have — the two are written by the same person in the
 * same hour, and they agree by construction. Nine tests can pass on a payload Codex would
 * never send.
 *
 * So the fixtures are checked against `test/fixtures/observed/payloads/*.json`: payloads the
 * host itself wrote to a recorder hook's stdin during a real session, with only the per-run
 * ids and paths replaced. They were written by the host, and that is the whole of their
 * authority. `test/helpers/codex-record.mjs --update` re-records them.
 *
 * That circle-breaking has already earned its keep twice: the first draft of `preCompact()`
 * carried a `permission_mode` (the two compaction events are the only turn-scoped events
 * without one) and `permissionRequest()` carried a `tool_use_id` (it has none — which is why
 * the plugin treats that event as read-only).
 *
 * **What a recording cannot do.** It pins the fields an event was *seen* to carry, not the
 * fields it *may* carry, so it cannot prove a field optional and it cannot reject one the host
 * would accept but has not sent yet. And five of the eleven events do not fire in a scripted
 * one-turn session, so they have no recording at all. Both limits are asserted below by name
 * rather than passed over — a gap that nothing states is indistinguishable from coverage.
 *
 * Both directions are still checked. The recordings say what a hook may be handed; the output
 * contract in `test/fixtures/codex-output-rules.json` says what it may answer, and an output
 * Codex cannot take is reported to the user as a hook error on every single event.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILDERS, CODEX_EVENTS, observedEvents, observedKeyErrors, observedPayload,
  outputAcceptance, outputCapabilities, outputRuleErrors,
  assertOutputAccepted,
  runHook, baseEnv, makeDataDir, makeProjectDir, fakeMubit,
} from './helpers/codex-fixtures.mjs';

/**
 * The events a recording session reaches. Kept here rather than derived from the directory:
 * a corpus that quietly lost a file would otherwise shrink this list and pass.
 */
const RECORDED = ['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'];

/** The rest, and what each would take to record. Documented in `observed/README.md`. */
const UNRECORDED = ['PermissionRequest', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop'];

// ===========================================================================
// The corpus itself
// ===========================================================================

test('the recorded corpus is the one this file thinks it has', () => {
  // § Recording is a deliberate act against a specific host build. If these go missing the
  //   rest of this file passes vacuously, which is the failure mode the whole file exists to
  //   avoid — so their absence is its own test.
  assert.deepEqual(observedEvents(), [...RECORDED].sort(),
    'the recordings are the only artefact in this suite the implementation did not write. '
    + 'Without them every assertion below is the implementation agreeing with itself. '
    + 'Re-record with `node test/helpers/codex-record.mjs --update`.');

  assert.deepEqual([...RECORDED, ...UNRECORDED].sort(), [...CODEX_EVENTS].sort(),
    'every event is either recorded or listed as not recorded. An event in neither list is '
    + 'one nothing in this file has an opinion about.');
});

test('each recording carries the event it belongs to', () => {
  for (const event of RECORDED) {
    // § The `hook_event_name` field is how a hook knows which event it was handed when one
    //   script serves several — which is exactly how capture.mjs and checkpoint.mjs work.
    assert.equal(observedPayload(event)?.hook_event_name, event,
      `the ${event} recording does not name ${event}. The recorder files by that field, so a `
      + 'mismatch means the corpus was hand-edited.');
  }
});

test('the events with no recording are the ones a scripted turn cannot reach', () => {
  // § Stated as a test so the gap shrinks deliberately. Recording one of these means teaching
  //   codex-record.mjs to drive a session that reaches it — an approval the sandbox refuses, a
  //   window full enough to compact, a spawned subagent — not hand-writing a file.
  for (const event of UNRECORDED) {
    assert.equal(observedPayload(event), null,
      `${event} now has a recording, which is good news: move it into RECORDED and the `
      + 'builder below gains a real oracle.');
  }
});

// ===========================================================================
// Inputs
// ===========================================================================

for (const event of RECORDED) {
  // § One test per event: a failure names the builder that drifted, not "some fixture".
  test(`${event}: the fixture is the payload the host was recorded sending`, () => {
    const payload = BUILDERS[event]();
    const seen = observedPayload(event);

    const invented = observedKeyErrors(event, payload);
    assert.deepEqual(invented, [],
      `the ${event} builder produces fields the host has never been recorded sending, so `
      + `every test built on it proves nothing:\n  ${invented.join('\n  ')}`);

    // § And the other direction, which only a builder is held to: a fixture that drops a
    //   field the host always sends models a payload that has never existed, and a hook
    //   reading that field would be exercised against `undefined` for ever.
    const missing = Object.keys(seen).filter((k) => !(k in payload));
    assert.deepEqual(missing, [],
      `the ${event} builder omits fields every recorded ${event} carries: ${missing.join(', ')}`);
  });
}

for (const event of UNRECORDED) {
  test(`${event}: the fixture names its own event, and nothing else checks it`, () => {
    // § All that is left without a recording. Saying so is the point: the alternative is a
    //   test that looks like the ones above and asserts nothing the builder did not decide.
    assert.equal(BUILDERS[event]().hook_event_name, event);
  });
}

/** The four sources Codex reports on `SessionStart`, which is a subset of Claude Code's five. */
const CODEX_SOURCES = ['startup', 'resume', 'clear', 'compact'];

test('SessionStart carries no `fork` source', () => {
  // § Claude Code has five sources; Codex has four. lib/runid.mjs's SOURCES set is a superset
  //   and normalises anything unknown to '' (reuse rather than reset), so a subset is safe —
  //   but the subset has to be the *right* one, and this is where that is pinned.
  //
  //   A recording shows one source, not the set, so the set is the plugin's own claim and the
  //   recording is the part of it that is checked. codex-runid.test.mjs drives all four.
  assert.ok(!CODEX_SOURCES.includes('fork'),
    'if `fork` ever appears here, the run-id reuse branch has a fifth case to cover.');
  assert.ok(CODEX_SOURCES.includes(observedPayload('SessionStart').source),
    'the recorded SessionStart reports a source this table does not list.');
});

test('the turn key is `turn_id`, and `prompt_id` is not a field Codex has', () => {
  for (const event of RECORDED) {
    const props = Object.keys(observedPayload(event));
    // § This is the whole `prompt_id ?? turn_id` change in one assertion. Under Claude Code the
    //   turn file is `runs/<run>/turns/<prompt_id>.json`; a hook that staged under `turn_id`
    //   and read under `prompt_id` would stage every turn and find none of them, so recall
    //   would inject and nothing would ever be attributed.
    assert.ok(!props.includes('prompt_id'),
      `${event} was recorded carrying prompt_id — the shared hooks could then read it directly `
      + 'and this port would not need turnKey() at all.');
    if (!['SessionStart', 'SessionEnd'].includes(event)) {
      assert.ok(props.includes('turn_id'),
        `${event} must carry turn_id: it is the only key the turn file can be named after.`);
    }
  }
});

// ===========================================================================
// Outputs
// ===========================================================================

/**
 * Which hook answers which event, and with what argv. This is the same table
 * `hooks.json` registers — kept here as data so the output check can drive every one.
 */
const HANDLERS = [
  { event: 'SessionStart', hook: 'session-start', args: [] },
  { event: 'UserPromptSubmit', hook: 'prompt-recall', args: [] },
  { event: 'UserPromptSubmit', hook: 'stage-prompt', args: [] },
  { event: 'PreToolUse', hook: 'pre-tool', args: [] },
  { event: 'PermissionRequest', hook: 'capture', args: ['--permission'] },
  { event: 'PostToolUse', hook: 'capture', args: [] },
  { event: 'PreCompact', hook: 'checkpoint', args: ['--pre'] },
  { event: 'PostCompact', hook: 'checkpoint', args: ['--post'] },
  { event: 'SubagentStart', hook: 'subagent-start', args: [] },
  { event: 'SubagentStop', hook: 'capture', args: ['--subagent'] },
  { event: 'Stop', hook: 'capture', args: ['--stop'] },
  { event: 'SessionEnd', hook: 'session-end', args: [] },
];

for (const { event, hook, args } of HANDLERS) {
  const label = `${hook}${args.length ? ` ${args.join(' ')}` : ''}`;
  test(`${event}: what ${label} writes to stdout is a payload Codex can parse`, async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const dataDir = makeDataDir();
    const projectDir = makeProjectDir({ git: true });

    const r = await runHook(hook, BUILDERS[event](), {
      args,
      env: baseEnv({
        dataDir,
        projectDir,
        endpoint: server.url,
        extra: {
          MUBIT_CC_RUN_STRATEGY: 'static',
          MUBIT_CC_RUN_ID: 'codex-payload-test',
          // The end-of-session flush must stay inside this process, or the assertion races a
          // detached child that outlives the test.
          MUBIT_CC_SESSION_END_DETACH: '0',
        },
      }),
    });

    assert.equal(r.code, 0, `hook must exit 0, got ${r.code}. stderr:\n${r.stderr}`);
    const out = r.stdout.trim();
    assert.ok(out, `${label} wrote nothing to stdout. lib/hook.mjs guarantees a JSON object on `
      + 'every path — Codex parsing empty stdout is not a documented behaviour.');

    let parsed;
    try { parsed = JSON.parse(out); } catch (err) {
      assert.fail(`${label} wrote unparseable stdout: ${err.message}\n${out.slice(0, 400)}`);
    }

    // § Well-formed is not the same as accepted. `suppressOutput` is taken on most events and
    //   refused on `PreToolUse` and `PostToolUse`, which is how `PostToolUse hook returned
    //   unsupported suppressOutput` reached a real session: everything checking the *shape* of
    //   that output was green.
    assertOutputAccepted(event, parsed, label);

    if (event === 'SessionEnd') {
      // § SessionEnd is the one event that parses no output wire type at all. The universal
      //   envelope is still the contract: a JSON object, and nothing that would steer anything.
      assert.equal(typeof parsed, 'object', 'SessionEnd must still answer with a JSON object.');
      assert.equal(parsed.decision, undefined, 'SessionEnd has no decision channel.');
      return;
    }

  });
}

// ===========================================================================
// The absences the output contract makes possible
// ===========================================================================

/** The five events that can put text in front of the model at all. */
const CAN_EMIT_CONTEXT = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SubagentStart', 'UserPromptSubmit'];

test('the five events that can emit context are the five the contract lists', () => {
  for (const event of CODEX_EVENTS) {
    assert.equal(outputCapabilities(event).emitsAdditionalContext, CAN_EMIT_CONTEXT.includes(event),
      `${event}: the contract and the list in this file disagree about additionalContext. `
      + 'One of them is wrong, and a handler somewhere is built on whichever it was.');
  }
});

test('the compaction events have no additionalContext channel at all', () => {
  for (const event of ['PreCompact', 'PostCompact']) {
    // § checkpoint.mjs already knows this for PostCompact under Claude Code ("PostCompact has
    //   no hookSpecificOutput channel, so the only shapes available are a top-level field or
    //   silence"). Codex extends it to PreCompact as well, which makes `systemMessage` the
    //   only way a failed checkpoint can tell anyone.
    assert.equal(outputCapabilities(event).hasHookSpecificOutput, false,
      `${event} has no hookSpecificOutput under Codex. Emitting one is an output the host `
      + 'rejects, and the failure lands on the user as a hook error during compaction.');
    assert.equal(outputCapabilities(event).emitsAdditionalContext, false,
      `${event} must have no additionalContext channel — systemMessage is the only one left `
      + 'for a checkpoint that failed to save, which is the one outcome the user needs.');
  }
});

test('PermissionRequest can decide but cannot inform', () => {
  const caps = outputCapabilities('PermissionRequest');
  // § This is what settled the design of the PermissionRequest handler. Its only structured
  //   channel is a verdict: there is no `additionalContext`, so a stored Mubit rule cannot be
  //   shown to the model here at all. What is left is either deciding — which this plugin
  //   never does — or observing. It observes: `capture --permission` records that a gated call
  //   was attempted, which is the only record that survives when the user denies it and no
  //   PostToolUse ever fires.
  assert.equal(caps.decisionOnly, true, 'PermissionRequest decides; that is its whole channel.');
  assert.equal(caps.emitsAdditionalContext, false,
    'PermissionRequest has no additionalContext. If that changes, the pre-tool warning path '
    + 'gains a second home and this test should be the thing that says so.');
});

// ===========================================================================
// The contract against the recorded verdicts
// ===========================================================================

test('what the contract forbids is what a real session was seen refusing', () => {
  // § The claim this whole file rests on, stated as a test because it cost a user-visible
  //   failure to learn: an output can be well-formed and still be refused, so nothing that
  //   checks only the shape is checking the contract.
  //
  //   `output-acceptance.json` is a recording of the host's verdict on an output a hook
  //   actually returned — `hook: <Event> Completed` against `hook: <Event> Failed`. Every
  //   verdict in it must agree with the rule table, in both directions. Events the probe
  //   session never reached are absent from it and are not asserted here; the rule table is
  //   still the plugin's contract for them, it is simply not one a recording has confirmed.
  const probes = outputAcceptance().probes ?? [];
  assert.ok(probes.length, 'no recorded verdicts — the cross-check below would pass vacuously.');

  for (const probe of probes) {
    for (const [event, verdict] of Object.entries(probe.verdict)) {
      const errs = outputRuleErrors(event, probe.output);
      const forbids = errs.length > 0;
      assert.equal(forbids, verdict === 'rejected',
        `${event}: a real session ${verdict} ${JSON.stringify(probe.output)}, and the rule `
        + `table ${forbids ? 'forbids' : 'permits'} it. Whichever is wrong, something in this `
        + 'suite is green on output the host would refuse — or strips a field for nothing.');
    }
  }
});

test('suppressOutput is refused where it is refused, and taken everywhere else', () => {
  // § The specific case that reached a user, kept as its own test so a regression names it.
  const rejecting = ['PreToolUse', 'PostToolUse', 'PermissionRequest'];
  for (const event of rejecting) {
    assert.deepEqual(outputRuleErrors(event, { suppressOutput: true }),
      [`${event} hook returned unsupported suppressOutput (we sent \`suppressOutput\`)`],
      `the rule table must refuse suppressOutput on ${event}. Without that row nothing in `
      + 'this suite can see the failure, because the output is perfectly well-formed.');
  }

  // § The mirror image: on every other event the field is genuinely accepted, and stripping it
  //   there would be a behaviour change bought for nothing.
  for (const event of CODEX_EVENTS.filter((e) => !rejecting.includes(e))) {
    assert.deepEqual(outputRuleErrors(event, { suppressOutput: true }), [],
      `${event} accepts suppressOutput. Forbidding it everywhere would make the hooks noisier `
      + 'in the transcript than they need to be.');
  }
});
