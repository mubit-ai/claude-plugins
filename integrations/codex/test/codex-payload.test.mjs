// @ts-check
/**
 * Every fixture, and every hook's output, against the schemas Codex itself carries.
 *
 * This is the load-bearing file of the Codex suite, and the reason is worth stating plainly:
 * **a fixture written beside an implementation cannot falsify that implementation.** Whatever
 * shape the code reads, the fixture will have — the two are written by the same person in the
 * same hour, and they agree by construction. Nine tests can pass on a payload Codex would
 * never send.
 *
 * So the fixtures are checked against `test/fixtures/codex-hook-schemas/*.json`, which are
 * draft-07 documents extracted verbatim from the `codex` binary (see `docs/harness-probe.md`,
 * Appendix). They were written by the host, they are the host's own definition of the wire,
 * and every one of them is `additionalProperties: false` — which is what makes them able to
 * say no.
 *
 * That has already earned its keep twice while this file was being written: the first draft
 * of `preCompact()` carried a `permission_mode` (the two compaction events are the only
 * turn-scoped events without one) and `permissionRequest()` carried a `tool_use_id` (it has
 * none — which is why the plugin treats that event as read-only).
 *
 * Both directions are checked. The input schemas say what a hook may be handed; the output
 * schemas say what it may answer, and an output Codex cannot parse is reported to the user as
 * a hook error on every single event.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILDERS, CODEX_EVENTS, hostSchema, hostSchemaTitles, schemaErrors, schemaSlug,
  runHook, baseEnv, makeDataDir, makeProjectDir, fakeMubit,
} from './helpers/codex-fixtures.mjs';

/** The eleven inputs and the ten outputs — SessionEnd has no output schema. */
const EXPECTED_TITLES = [
  ...CODEX_EVENTS.map((e) => `${schemaSlug(e)}.command.input`),
  ...CODEX_EVENTS.filter((e) => e !== 'SessionEnd').map((e) => `${schemaSlug(e)}.command.output`),
].sort();

// ===========================================================================
// The schemas themselves
// ===========================================================================

test('all twenty-one host schemas are checked in', () => {
  // § Extraction is a one-off against a specific Codex build. If these ever go missing the
  //   rest of this file passes vacuously, which is the failure mode the whole file exists to
  //   avoid — so their absence is its own test.
  assert.deepEqual(hostSchemaTitles(), EXPECTED_TITLES,
    'the extracted schemas are the only artefact in this suite the implementation did not '
    + 'write. Without them every assertion below is the implementation agreeing with itself. '
    + 'Re-extract per docs/harness-probe.md, Appendix.');
});

test('each schema declares the event it belongs to', () => {
  for (const event of CODEX_EVENTS) {
    const input = hostSchema(`${schemaSlug(event)}.command.input`);
    // § The `hook_event_name` const is how a hook knows which event it was handed when one
    //   script serves several — which is exactly how capture.mjs and checkpoint.mjs work.
    assert.equal(input.properties?.hook_event_name?.const, event,
      `${event}'s input schema does not pin hook_event_name — the extraction picked up the `
      + 'wrong block.');
    assert.equal(input.additionalProperties, false,
      `${event}'s input schema is not closed, so it cannot reject a field Codex never sends `
      + 'and this file loses its point.');
  }
});

// ===========================================================================
// Inputs
// ===========================================================================

for (const event of CODEX_EVENTS) {
  // § One test per event: a failure names the builder that drifted, not "some fixture".
  test(`${event}: the fixture is a payload Codex would actually send`, () => {
    const payload = BUILDERS[event]();
    const errs = schemaErrors(payload, hostSchema(`${schemaSlug(event)}.command.input`));
    assert.deepEqual(errs, [],
      `the ${event} builder produces something the host's own schema rejects, so every test `
      + `built on it proves nothing:\n  ${errs.join('\n  ')}`);
  });
}

test('SessionStart carries no `fork` source', () => {
  const schema = hostSchema('session-start.command.input');
  // § Claude Code has five sources; Codex has four. lib/runid.mjs's SOURCES set is a superset
  //   and normalises anything unknown to '' (reuse rather than reset), so a subset is safe —
  //   but the subset has to be the *right* one, and this is where that is pinned.
  assert.deepEqual(schema.properties?.source?.enum, ['startup', 'resume', 'clear', 'compact'],
    'the Codex source table is what codex-runid.test.mjs drives. If `fork` ever appears here, '
    + 'the run-id reuse branch has a fifth case to cover.');
});

test('the turn key is `turn_id`, and `prompt_id` is not a field Codex has', () => {
  for (const event of CODEX_EVENTS) {
    const schema = hostSchema(`${schemaSlug(event)}.command.input`);
    const props = Object.keys(schema.properties ?? {});
    // § This is the whole `prompt_id ?? turn_id` change in one assertion. Under Claude Code the
    //   turn file is `runs/<run>/turns/<prompt_id>.json`; a hook that staged under `turn_id`
    //   and read under `prompt_id` would stage every turn and find none of them, so recall
    //   would inject and nothing would ever be attributed.
    assert.ok(!props.includes('prompt_id'),
      `${event} would carry prompt_id — the shared hooks could then read it directly and this `
      + 'port would not need turnKey() at all. Check the extraction.');
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

    if (event === 'SessionEnd') {
      // § SessionEnd is the one event with no output schema at all. The universal envelope is
      //   still the contract: a JSON object, and nothing that would steer anything.
      assert.equal(typeof parsed, 'object', 'SessionEnd must still answer with a JSON object.');
      assert.equal(parsed.decision, undefined, 'SessionEnd has no decision channel.');
      return;
    }

    const errs = schemaErrors(parsed, hostSchema(`${schemaSlug(event)}.command.output`));
    assert.deepEqual(errs, [],
      `${label} answered ${event} with something Codex's own output schema rejects. Codex `
      + `reports that to the user as a hook error on every single event:\n  ${errs.join('\n  ')}`
      + `\n  stdout was: ${out.slice(0, 400)}`);
  });
}

// ===========================================================================
// The absences the output schemas make possible
// ===========================================================================

test('the compaction events have no additionalContext channel at all', () => {
  for (const event of ['PreCompact', 'PostCompact']) {
    const schema = hostSchema(`${schemaSlug(event)}.command.output`);
    // § checkpoint.mjs already knows this for PostCompact under Claude Code ("PostCompact has
    //   no hookSpecificOutput channel, so the only shapes available are a top-level field or
    //   silence"). Codex extends it to PreCompact as well, which makes `systemMessage` the
    //   only way a failed checkpoint can tell anyone — and this is the schema that says so.
    assert.equal(schema.properties?.hookSpecificOutput, undefined,
      `${event} has no hookSpecificOutput under Codex. Emitting one is an output the host `
      + 'rejects, and the failure lands on the user as a hook error during compaction.');
    assert.ok(schema.properties?.systemMessage,
      `${event} must keep systemMessage — it is the only channel left for a checkpoint that `
      + 'failed to save, which is the one outcome the user needs to hear about.');
  }
});

test('PermissionRequest can decide but cannot inform', () => {
  const schema = hostSchema('permission-request.command.output');
  const ref = schema.properties?.hookSpecificOutput?.allOf?.[0]?.$ref?.split('/').pop();
  const inner = schema.definitions?.[ref]?.properties ?? {};
  // § This is what settled the design of the PermissionRequest handler. The only fields are
  //   `decision` and `hookEventName`: there is no `additionalContext`, so a stored Mubit rule
  //   cannot be shown to the model here at all. What is left is either deciding — which this
  //   plugin never does — or observing. It observes: `capture --permission` records that a
  //   gated call was attempted, which is the only record that survives when the user denies it
  //   and no PostToolUse ever fires.
  assert.ok('decision' in inner, 'the extraction lost PermissionRequest.decision.');
  assert.equal(inner.additionalContext, undefined,
    'PermissionRequest has no additionalContext. If that changes, the pre-tool warning path '
    + 'gains a second home and this test should be the thing that says so.');
});
