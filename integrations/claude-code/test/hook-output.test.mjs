// @ts-check
/**
 * `test/hook-output.test.mjs` — the HOST's hook-output contract, for every hook this plugin
 * registers.
 *
 * Every other hook test in this suite asserts the shape the design guide specifies. This one
 * asserts the shape Claude Code actually accepts, and those are two different authorities:
 * the guide decides what the plugin means to say, the host decides what it is allowed to say,
 * and only one of them is holding the parser. Where they disagree the host wins **in silence**
 * — an output that fails its schema is discarded whole, so no `additionalContext` is injected,
 * no `systemMessage` is shown, and the hook still exits 0. Nothing downstream can tell that
 * apart from a hook that chose to say nothing.
 *
 * That is not hypothetical. `checkpoint --post` emitted
 * `hookSpecificOutput.hookEventName: "PostCompact"` for its whole shipped life, and every
 * re-anchor it produced was thrown away by the host:
 *
 *     PostCompact [node .../hooks/dist/checkpoint.mjs --post] failed:
 *     Hook JSON output validation failed — (root): Invalid input
 *
 * `PreCompact` never showed the problem, because it answers with `systemMessage`, which is a
 * top-level field and never reaches the `hookSpecificOutput` union at all.
 *
 * A per-hook test written against the guide cannot catch that class, because the constraint
 * does not live in the guide. So this file is a gate over **every registration in
 * `hooks/hooks.json`** rather than over one hook: a new hook, or a new argv mode of an
 * existing one, fails here until it has a case, and the case then pins its stdout against the
 * host. `drain.mjs` is deliberately absent — it is spawned detached by other hooks, never by
 * the host, so nothing ever reads its stdout.
 *
 * The two host rules this encodes, both read out of the shipped binary (see the extraction
 * commands on each constant):
 *
 *   1. `hookSpecificOutput.hookEventName` must be a name the host knows. Validation runs
 *      before dispatch, and a name outside the union fails the WHOLE object.
 *   2. It must also equal the event that fired:
 *      `if (i && e.hookSpecificOutput.hookEventName !== i) throw Error("Hook returned
 *      incorrect event name: expected '" + i + "' but got ...")`.
 *
 * Together those are stronger than either alone: a hook registered on an event outside the
 * accepted set has **no `hookSpecificOutput` channel at all** — not under its own name, which
 * fails rule 1, and not under a borrowed one, which fails rule 2. Whatever it needs to inject
 * has to be delivered by a hook whose own event is accepted, or through a top-level field.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PLUGIN_ROOT, runHook, assertHookContract, fakeMubit, makeDataDir, makeProjectDir,
  baseEnv, readJsonFile,
} from './helpers/harness.mjs';
import * as fx from './helpers/fixtures.mjs';

// ---------------------------------------------------------------------------
// The host's contract, copied verbatim from the shipping binary
// ---------------------------------------------------------------------------

/** The Claude Code build these constants were read out of. */
const HOST_VERSION = '2.1.233';

/**
 * The `hookEventName` values the host does something with, from its dispatch switch.
 * Re-derive (read-only) with:
 *
 *     V=~/.local/share/claude/versions/2.1.233
 *     strings -a "$V" \
 *       | grep -o 'switch(e.hookSpecificOutput.hookEventName){.\{0,4000\}' | head -1 \
 *       | grep -o 'case"[A-Za-z]*"'
 *
 * That prints four extra labels — `allow`, `deny`, `ask`, `defer` — which belong to the
 * nested `permissionDecision` switch inside `case"PreToolUse"` and are not event names.
 *
 * The zod union that runs *first*, and whose rejection reads `(root): Invalid input`, is a
 * strict superset: it adds `CwdChanged`, `FileChanged`, `Notification` and `WorktreeCreate`,
 * which validate and then fall through the switch.
 *
 *     strings -a "$V" | grep -o 'hookEventName:[A-Za-z0-9_$]*("[A-Za-z]*")' \
 *       | grep -o '"[A-Za-z]*"' | sort -u
 *
 * The dispatch set is the one pinned here, because passing validation only to be ignored is
 * indistinguishable from never having emitted anything.
 *
 * Neither set contains `PreCompact`, `PostCompact` or `SessionEnd`. Those events are real and
 * their hooks do run; they simply have no `hookSpecificOutput` channel.
 */
const ACCEPTED_HOOK_EVENT_NAMES = Object.freeze([
  'PreToolUse', 'UserPromptSubmit', 'UserPromptExpansion', 'SessionStart', 'Setup',
  'SubagentStart', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Stop',
  'SubagentStop', 'PermissionDenied', 'PermissionRequest', 'Elicitation',
  'ElicitationResult', 'MessageDisplay',
]);

/**
 * The top-level keys of the same schema, from the "Expected schema:" block the host prints
 * when it rejects an output:
 *
 *     strings -a "$V" | grep -o 'continue:"boolean (optional)".\{0,300\}'
 *
 * Unknown keys are stripped rather than rejected, so an invented top-level field does not
 * fail — it is simply ignored, which is the quieter half of the same bug.
 */
const ACCEPTED_TOP_LEVEL_KEYS = Object.freeze([
  'continue', 'suppressOutput', 'stopReason', 'decision', 'reason', 'systemMessage',
  'terminalSequence', 'permissionDecision', 'hookSpecificOutput',
]);

// ---------------------------------------------------------------------------
// Every registration in hooks.json
// ---------------------------------------------------------------------------

/** One real git project for every case; run-id derivation shells out to git. */
const PROJECT_DIR = makeProjectDir({ git: true });

/** Pinned (§6.1 `static`) so a case can seed `runs/<run_id>/` before the hook runs. */
const RUN_ID = 'cc-hook-output-test';

function env(dataDir, endpoint) {
  return baseEnv({
    dataDir,
    endpoint,
    projectDir: PROJECT_DIR,
    extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN_ID },
  });
}

/** `<Event> <hook> <argv…>` — the identity of one registration, and the key of its case. */
const idOf = (r) => [r.event, r.hook, ...r.args].join(' ');

/**
 * Every hook registration in `hooks/hooks.json`, deduplicated by identity: `PostToolUse` is
 * registered twice with different matchers and the same script and argv, and which tool
 * matched says nothing about the stdout shape.
 *
 * `hooks.json` is read rather than restated, so a hook that is added there without a case
 * below fails the coverage test rather than quietly going unchecked.
 *
 * @returns {{event: string, hook: string, args: string[]}[]}
 */
function registrations() {
  const json = readJsonFile(join(PLUGIN_ROOT, 'hooks', 'hooks.json'));
  /** @type {{event: string, hook: string, args: string[]}[]} */
  const out = [];
  const seen = new Set();
  for (const [event, groups] of Object.entries(json.hooks ?? {})) {
    for (const group of /** @type {any[]} */ (groups ?? [])) {
      for (const h of group.hooks ?? []) {
        const argv = (h.args ?? []).map(String);
        // `${CLAUDE_PLUGIN_ROOT}/hooks/dist/<name>.mjs` -> `<name>`. Tests run `hooks/src`
        // by default (see test/README.md), and `runHook` resolves the target.
        const hook = String(argv[0] ?? '').split('/').pop().replace(/\.mjs$/, '');
        const reg = { event, hook, args: argv.slice(1) };
        const id = idOf(reg);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(reg);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// One scenario per registration
// ---------------------------------------------------------------------------

/**
 * `setup` seeds whatever the hook needs to reach the branch that *speaks*, and returns payload
 * overrides. A gate that only ever exercised the suppressing branch would stay green against a
 * plugin that had stopped emitting anything at all.
 *
 * @type {Record<string, {setup?: (dataDir: string) => Record<string, any>,
 *                       payload: (over: Record<string, any>) => Record<string, any>}>}
 */
const CASES = {
  'SessionStart session-start': {
    payload: () => fx.sessionStart({ cwd: PROJECT_DIR }),
  },
  'UserPromptSubmit prompt-recall': {
    payload: () => fx.userPromptSubmit({ cwd: PROJECT_DIR }),
  },
  'UserPromptSubmit stage-prompt': {
    payload: () => fx.userPromptSubmit({ cwd: PROJECT_DIR }),
  },
  'SubagentStart subagent-start': {
    // The subagent's recall query is the parent turn's staged prompt — `SubagentStart`
    // carries no task text of its own. Without this the hook reaches only its suppressing
    // branch, and a case that never sees the speaking branch is not a case.
    setup: (dataDir) => { stageParentTurn(dataDir); return {}; },
    payload: () => fx.subagentStart({ cwd: PROJECT_DIR }),
  },
  'PostToolUse capture': {
    payload: () => fx.postToolUse({ cwd: PROJECT_DIR }),
  },
  'PostToolUseFailure capture --failure': {
    payload: () => fx.postToolUseFailure({ cwd: PROJECT_DIR }),
  },
  'Stop capture --stop': {
    payload: () => fx.stop({ cwd: PROJECT_DIR }),
  },
  'SubagentStop capture --subagent': {
    payload: () => fx.subagentStop({ cwd: PROJECT_DIR }),
  },
  'PreCompact checkpoint --pre': {
    setup: (dataDir) => ({ transcript_path: writeTranscript(dataDir) }),
    payload: (over) => fx.preCompact({ cwd: PROJECT_DIR, ...over }),
  },
  'PostCompact checkpoint --post': {
    // A stored checkpoint, so `--post` reaches the re-anchor branch rather than the empty
    // one. Without this the case would pass on a hook that can never say anything.
    setup: (dataDir) => { seedCheckpoint(dataDir); return {}; },
    payload: () => fx.postCompact({ cwd: PROJECT_DIR }),
  },
  'SessionEnd session-end': {
    payload: () => fx.sessionEnd({ cwd: PROJECT_DIR }),
  },
};

/** A small but real JSONL transcript, so `--pre` has something to snapshot. */
function writeTranscript(dataDir) {
  const path = join(dataDir, 'transcript.jsonl');
  const line = (role, text) =>
    JSON.stringify({ type: role, message: { role, content: [{ type: 'text', text }] } });
  writeFileSync(path, `${[
    line('user', 'why is the job still queued?'),
    line('assistant', 'It stays queued until indexing completes.'),
  ].join('\n')}\n`);
  return path;
}

/**
 * §5.3: `runs/<run_id>/turns/<prompt_id>.json`, the turn `stage-prompt` writes on the
 * parent's `UserPromptSubmit` and `subagent-start` reads its query back out of.
 */
function stageParentTurn(dataDir) {
  const dir = join(dataDir, 'runs', RUN_ID, 'turns');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${fx.PROMPT_ID}.json`), JSON.stringify({
    prompt: 'why is the ingest job stuck in queued?',
    prompt_id: fx.PROMPT_ID,
    session_id: fx.SESSION_ID,
    started_at: Date.now(),
    recalled: [],
  }));
}

/** §7: `runs/<run_id>/checkpoints.json`, the file `--pre` writes and `--post` reads. */
function seedCheckpoint(dataDir) {
  const dir = join(dataDir, 'runs', RUN_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'checkpoints.json'), JSON.stringify([
    { checkpoint_id: 'ckpt_seeded_9', token_estimate: 3400, at: Date.now() },
  ]));
}

// ---------------------------------------------------------------------------
// The assertion
// ---------------------------------------------------------------------------

/**
 * @param {any} out    parsed stdout
 * @param {string} event  the hook event this registration fires on
 * @param {string} label  the registration id, so a failure names the argv that produced it
 */
function assertHostContract(out, event, label) {
  assert.ok(out && typeof out === 'object' && !Array.isArray(out),
    `${label}: stdout must be a JSON object, got ${JSON.stringify(out)}`);

  for (const k of Object.keys(out)) {
    assert.ok(ACCEPTED_TOP_LEVEL_KEYS.includes(k),
      `${label}: top-level key "${k}" is not in the host's output schema (${HOST_VERSION}). `
      + `Unknown keys are stripped, so this field does nothing. `
      + `Accepted: ${ACCEPTED_TOP_LEVEL_KEYS.join(', ')}.`);
  }

  if (!('hookSpecificOutput' in out)) return;
  const hso = out.hookSpecificOutput;
  assert.ok(hso && typeof hso === 'object' && !Array.isArray(hso),
    `${label}: hookSpecificOutput must be an object, got ${JSON.stringify(hso)}`);

  // Rule 1 — the schema union. A name outside it fails the whole object, not just the field:
  // "Hook JSON output validation failed — (root): Invalid input".
  assert.ok(ACCEPTED_HOOK_EVENT_NAMES.includes(hso.hookEventName),
    `${label}: hookEventName ${JSON.stringify(hso.hookEventName)} is not a name Claude Code `
    + `${HOST_VERSION} accepts, so this ENTIRE output is discarded — the host answers "Hook `
    + `JSON output validation failed — (root): Invalid input" and injects nothing.\n`
    + `  Accepted: ${ACCEPTED_HOOK_EVENT_NAMES.join(', ')}\n`
    + `  A hook on an event outside that set has no hookSpecificOutput channel. Deliver the `
    + `context from a hook whose own event IS in the set, or use a top-level field `
    + `(systemMessage), and leave this one suppressed.`);

  // Rule 2 — and it must be this event's own name. Borrowing an accepted name from another
  // event throws "Hook returned incorrect event name" instead of injecting.
  assert.equal(hso.hookEventName, event,
    `${label}: hookEventName must equal the event that fired. The host throws "Hook returned `
    + `incorrect event name: expected '${event}' but got '${hso.hookEventName}'".`);
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

// The gate is only a gate if it covers everything the host will actually run. A registration
// added to `hooks.json` with no case here is an uncovered stdout shape, which is exactly the
// state `checkpoint --post` shipped in.
test('every registration in hooks.json has a hook-output case', () => {
  const ids = registrations().map(idOf);
  assert.ok(ids.length > 0, 'hooks.json declared no hooks — the gate would pass vacuously');
  for (const id of ids) {
    assert.ok(CASES[id], `hooks.json registers "${id}" but no case in CASES drives it`);
  }
  for (const id of Object.keys(CASES)) {
    assert.ok(ids.includes(id), `CASES drives "${id}", which hooks.json no longer registers`);
  }
});

for (const reg of registrations()) {
  const label = idOf(reg);
  test(`${label} emits an output shape the host accepts`, async (t) => {
    const spec = CASES[label];
    if (!spec) return; // the coverage test above owns this failure; do not double-report it.

    const server = await fakeMubit();
    t.after(() => server.close());
    const dataDir = makeDataDir();
    const over = spec.setup ? spec.setup(dataDir) : {};

    const r = await runHook(reg.hook, spec.payload(over), {
      env: env(dataDir, server.url),
      args: reg.args,
    });

    // §4.9 first: exit 0 and parseable stdout. The host contract below is meaningless on
    // stdout the host could not parse in the first place.
    assertHookContract(r);
    assertHostContract(r.json ?? {}, reg.event, label);
  });
}
