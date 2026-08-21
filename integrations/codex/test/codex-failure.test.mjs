// @ts-check
/**
 * The failure surface — the important file.
 *
 * The happy path is a handful of assertions; the failure surface is where the bugs live and
 * it decides whether anyone keeps the plugin installed. One rule dominates, and it is the
 * same rule under both hosts:
 *
 * > **This plugin never exits 2 and never exits non-zero, in any mode, including every
 * > failure mode.**
 *
 * Codex reads a hook's exit code exactly as Claude Code does: 0 means parse stdout, 2 means
 * **block** and turn stderr into the reason shown to the model, anything else is a
 * non-blocking error surfaced to the user. So the dangerous value is the one a naive error
 * handler picks — a memory layer that throws would start denying tool calls, and the user
 * would experience it as the agent refusing to work.
 *
 * Two Codex-specific failures get their own sections, because neither has a Claude Code
 * counterpart and both are silent:
 *
 *   - **A hook that is registered but not trusted never runs at all**, with no prompt and no
 *     warning. That is not something a hook can defend against — but the plugin must at least
 *     not confuse it with "capture is off", so every path leaves a local trace.
 *   - **`SessionEnd` gets three seconds**, clamped by the host whatever the registration says.
 *     Under Claude Code the same hook asks for eight.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BUILDERS, CODEX_EVENTS, userPromptSubmit, postToolUse, subagentStop, sessionEnd,
  runHook, baseEnv, makeDataDir, makeProjectDir, fakeMubit, tempDir,
} from './helpers/codex-fixtures.mjs';

/** Which hook answers which event, with its argv. The same table `hooks.json` registers. */
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

const label = ({ hook, args }) => `${hook}${args.length ? ` ${args.join(' ')}` : ''}`;

function env(over = {}, dataDir = makeDataDir()) {
  return baseEnv({
    dataDir,
    projectDir: makeProjectDir({ git: true }),
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: 'codex-failure-test',
      MUBIT_CC_SESSION_END_DETACH: '0',
      ...over,
    },
  });
}

/** Exit 0 and a JSON object on stdout — the two halves of the universal contract. */
function assertNeverBlocks(r, what) {
  assert.notEqual(r.code, 2,
    `${what} exited 2. Codex reads that as a BLOCK and turns stderr into the reason shown to `
    + `the model. stderr:\n${r.stderr}`);
  assert.equal(r.code, 0,
    `${what} exited ${r.code}. Every non-zero code is surfaced to the user as a hook error; `
    + `the only thing an internal failure may cost is the memory itself. stderr:\n${r.stderr}`);
  const out = r.stdout.trim();
  assert.ok(out, `${what} wrote nothing to stdout. lib/hook.mjs guarantees a JSON object on `
    + 'every path — Codex parsing empty stdout is not a contract to rely on.');
  let parsed;
  try { parsed = JSON.parse(out); } catch (err) {
    assert.fail(`${what} wrote unparseable stdout (${err.message}): ${out.slice(0, 300)}`);
  }
  assert.equal(typeof parsed, 'object', `${what} wrote a JSON scalar, not an object.`);
  assert.ok(parsed !== null, `${what} wrote null.`);
}

// ===========================================================================
// F1 — stdin that is not JSON
// ===========================================================================

for (const h of HANDLERS) {
  test(`F1 ${label(h)}: unparseable stdin costs the memory, not the turn`, async () => {
    const r = await runHook(h.hook, null, {
      args: h.args, env: env(), stdinRaw: 'not json at all {{{',
    });
    // § A truncated or garbled payload is a host bug, not a user one. The right cost is one
    //   log line and nothing else.
    assertNeverBlocks(r, `${label(h)} on garbage stdin`);
  });
}

test('F2 empty stdin is handled, not crashed on', async () => {
  for (const h of HANDLERS) {
    const r = await runHook(h.hook, null, { args: h.args, env: env(), stdinRaw: '' });
    assertNeverBlocks(r, `${label(h)} on empty stdin`);
  }
});

test('F3 a JSON scalar where an object belongs', async () => {
  for (const h of HANDLERS) {
    const r = await runHook(h.hook, null, { args: h.args, env: env(), stdinRaw: '"a string"' });
    assertNeverBlocks(r, `${label(h)} on a JSON string`);
  }
});

// ===========================================================================
// F4 — the environment the shim was supposed to fill
// ===========================================================================

for (const h of HANDLERS) {
  test(`F4 ${label(h)}: no endpoint configured`, async () => {
    const r = await runHook(h.hook, BUILDERS[h.event](), {
      args: h.args,
      env: { ...env(), MUBIT_ENDPOINT: '', MUBIT_API_KEY: '' },
    });
    // § A blank endpoint is a meaningful state, not an error: capture spools locally, recall
    //   returns nothing, and nothing is sent. It is what a fresh install looks like before
    //   `/mubit-memory:auth`, so it must be completely quiet.
    assertNeverBlocks(r, `${label(h)} with no endpoint`);
  });
}

test('F5 a run id that cannot be derived', async () => {
  for (const h of HANDLERS) {
    const r = await runHook(h.hook, BUILDERS[h.event](), {
      args: h.args,
      // `static` with a blank pin is the one derivation that throws rather than guessing.
      env: env({ MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: '' }),
    });
    // § lib/runid.mjs throws rather than answer "default", which is correct — and the hook has
    //   to absorb that throw. The alternative is a plugin that blocks every tool call in a
    //   session whose config has one blank field.
    assertNeverBlocks(r, `${label(h)} with an underivable run id`);
  }
});

// ===========================================================================
// F6 — an unwritable data directory
// ===========================================================================

test('F6 an unwritable data directory costs the memory, not the session', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores the mode bits this depends on');
  const dir = tempDir('codex-readonly-');
  mkdirSync(join(dir, 'runs'), { recursive: true });
  chmodSync(dir, 0o500);
  t.after(() => { try { chmodSync(dir, 0o700); } catch { /* already gone */ } });

  for (const h of HANDLERS) {
    const r = await runHook(h.hook, BUILDERS[h.event](), {
      args: h.args,
      env: env({}, dir),
    });
    // § A read-only data directory is what a locked-down CI image looks like. Every write in
    //   lib/state.mjs is caught for exactly this, and the hook still has to answer.
    assertNeverBlocks(r, `${label(h)} with a read-only data dir`);
  }
});

// ===========================================================================
// F7 — the endpoint misbehaving
// ===========================================================================

const BAD_SERVERS = [
  ['a 500', { status: 500, json: { error: 'boom' } }],
  ['a 401', { status: 401, json: { error: 'auth_failed' } }],
  ['a 403', { status: 403, json: { error: 'policy' } }],
  ['prose where JSON belongs', { status: 200, text: '<html>gateway</html>' }],
];

for (const [what, reply] of BAD_SERVERS) {
  test(`F7 ${what} from the endpoint never reaches the model as a block`, async (t) => {
    const server = await fakeMubit({
      'POST /v2/control/query': reply,
      'POST /v2/control/ingest': reply,
      'POST /v2/control/reflect': reply,
      'POST /v2/control/checkpoint': reply,
      'GET /v2/core/health': reply,
    });
    t.after(() => server.close());

    for (const h of HANDLERS) {
      const r = await runHook(h.hook, BUILDERS[h.event](), {
        args: h.args,
        env: baseEnv({
          dataDir: makeDataDir(),
          projectDir: makeProjectDir({ git: true }),
          endpoint: server.url,
          extra: {
            MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: 'codex-failure-test',
            MUBIT_CC_SESSION_END_DETACH: '0',
          },
        }),
      });
      assertNeverBlocks(r, `${label(h)} against ${what}`);
    }
  });
}

test('F8 an endpoint that never answers still lets the hook finish', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': { hang: true },
    'GET /v2/core/health': { hang: true },
  });
  t.after(() => server.close());

  const r = await runHook('prompt-recall', userPromptSubmit(), {
    env: baseEnv({
      dataDir: makeDataDir(),
      projectDir: makeProjectDir({ git: true }),
      endpoint: server.url,
      extra: {
        MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: 'codex-failure-test',
        MUBIT_CC_RECALL_BUDGET_MS: '250',
      },
    }),
    timeoutMs: 20_000,
  });
  // § The prompt is on the user's clock. A recall that cannot answer inside its budget answers
  //   with nothing, which is a real answer — waiting is not.
  assertNeverBlocks(r, 'prompt-recall against a server that never answers');
});

// ===========================================================================
// F9 — hostile payloads
// ===========================================================================

const HOSTILE = [
  ['an enormous tool_input', () => postToolUse({ tool_input: { command: 'x'.repeat(2_000_000) } })],
  ['a deeply nested tool_input', () => {
    let deep = { end: true };
    for (let i = 0; i < 800; i++) deep = { nest: deep };
    return postToolUse({ tool_input: deep });
  }],
  ['a turn_id that is a path traversal', () => userPromptSubmit({ turn_id: '../../../../etc/passwd' })],
  ['a turn_id full of separators', () => userPromptSubmit({ turn_id: 'a/b\\c\0d' })],
  ['a session_id that is the poisoned literal', () => postToolUse({ session_id: 'default' })],
  ['an agent_id that is a path traversal', () => subagentStop({ agent_id: '../../escape' })],
];

for (const [what, build] of HOSTILE) {
  test(`F9 ${what}`, async () => {
    const payload = build();
    const hook = payload.hook_event_name === 'UserPromptSubmit' ? 'stage-prompt' : 'capture';
    const args = payload.hook_event_name === 'SubagentStop' ? ['--subagent'] : [];
    const dataDir = makeDataDir();
    const r = await runHook(hook, payload, { args, env: env({}, dataDir), timeoutMs: 30_000 });
    // § `turn_id` and `agent_id` both name files. They arrive from the host, so they are
    //   untrusted input to a path — and under Codex they arrive under different names than the
    //   Claude Code suite tests, which is the whole reason this row exists here too.
    assertNeverBlocks(r, `${hook} on ${what}`);
    assert.ok(!existsSync('/tmp/codex-traversal-canary'),
      'a payload wrote outside the data directory.');
  });
}

test('F10 every event survives being handed the wrong event`s payload', async () => {
  // § A hook that is registered on the wrong event, or a host that changes what it dispatches,
  //   must not be able to block a tool call. The mismatch is a bug worth logging and nothing
  //   worth failing.
  for (const h of HANDLERS) {
    for (const wrong of ['SessionEnd', 'PreToolUse', 'Stop']) {
      if (wrong === h.event) continue;
      const r = await runHook(h.hook, BUILDERS[wrong](), { args: h.args, env: env() });
      assertNeverBlocks(r, `${label(h)} handed a ${wrong} payload`);
    }
  }
});

// ===========================================================================
// F11 — the Codex-specific ones
// ===========================================================================

test('F11 SessionEnd finishes inside the three seconds Codex allows it', async (t) => {
  const server = await fakeMubit({
    // A slow but answering instance: the realistic case, not a hang.
    'POST /v2/control/ingest': { status: 200, json: { accepted: 1 }, delayMs: 400 },
    'POST /v2/control/reflect': { status: 200, json: { lessons: [] }, delayMs: 400 },
  });
  t.after(() => server.close());

  const started = Date.now();
  const r = await runHook('session-end', sessionEnd(), {
    env: baseEnv({
      dataDir: makeDataDir(),
      projectDir: makeProjectDir({ git: true }),
      endpoint: server.url,
      extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: 'codex-failure-test' },
    }),
    timeoutMs: 20_000,
  });
  const ms = Date.now() - started;

  assertNeverBlocks(r, 'session-end under the Codex clamp');
  // § docs/harness-probe.md §4, recorded verbatim: "clamping SessionEnd hook timeout to 3s".
  //   Under Claude Code this hook asks for eight seconds. Here it gets three whatever
  //   `hooks.json` says, and the process is killed at that boundary — which is why the
  //   detached hand-off is the default and this test is about the hook *returning*, not about
  //   the work being finished inside it.
  assert.ok(ms < 3_000,
    `session-end took ${ms}ms to return. Codex kills it at 3s, so anything still inside the `
    + 'hook at that point dies with it — including the reflect, which is the only call that '
    + 'promotes a lesson beyond its own run. The work belongs in the detached child.');
});

test('F12 the detached hand-off survives the hook process being killed', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const e = baseEnv({
    dataDir,
    projectDir: makeProjectDir({ git: true }),
    endpoint: server.url,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: 'codex-failure-test',
      MUBIT_CC_SESSION_END_DETACH: '1',
    },
  });
  await runHook('capture', postToolUse(), { env: e });
  // § Killing the process is the only way to reproduce what the host actually does: this is a
  //   cancellation, not a timeout, so no budget on either side of the boundary saves the work.
  //   Codex's 3s clamp makes it more likely here than under Claude Code, not less.
  const r = await runHook('session-end', sessionEnd(), { env: e, killAfterMs: 250 });
  assert.notEqual(r.code, 2, 'a killed session-end must never be read as a block.');

  const { waitFor } = await import('./helpers/codex-fixtures.mjs');
  const landed = await waitFor(() => server.countOf('POST', '/v2/control/reflect') > 0, 8000)
    .then(() => true).catch(() => false);
  assert.ok(landed,
    'the reflect never happened. With the hook process taken away at 250ms, the detached child '
    + 'is the only thing left that can finish the flush — and reflection is the one path that '
    + 'promotes a lesson beyond its own run.');
});

test('F13 a hook left untrusted is invisible from inside, so every path leaves a local trace', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  await runHook('session-start', BUILDERS.SessionStart(), {
    env: baseEnv({
      dataDir, projectDir: makeProjectDir({ git: true }), endpoint: server.url,
      extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: 'codex-failure-test' },
    }),
  });
  // § There is nothing a hook can do about not being run. What the plugin can do is make the
  //   two states distinguishable: "installed but untrusted" leaves no status marker at all,
  //   where "installed and capture disabled" leaves one. `/mubit-memory:doctor` tells them
  //   apart by reading this file, which is the only reason the difference is diagnosable.
  const marker = join(dataDir, 'status');
  assert.ok(existsSync(marker),
    'SessionStart left no status directory. A Codex user whose hooks are untrusted sees '
    + 'exactly the same nothing as one whose plugin is broken, and the local marker is the '
    + 'only thing that separates the two.');
});

// ===========================================================================
// The absence, asserted rather than timed
// ===========================================================================

test('F14 no hook dials the network on a path the contract says is local', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const e = () => baseEnv({
    dataDir: makeDataDir(),
    projectDir: makeProjectDir({ git: true }),
    endpoint: server.url,
    extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: 'codex-failure-test' },
  });

  const LOCAL_ONLY = [
    { hook: 'capture', args: [], event: 'PostToolUse' },
    { hook: 'capture', args: ['--permission'], event: 'PermissionRequest' },
    { hook: 'pre-tool', args: [], event: 'PreToolUse' },
    { hook: 'stage-prompt', args: [], event: 'UserPromptSubmit' },
    { hook: 'checkpoint', args: ['--post'], event: 'PostCompact' },
  ];
  for (const h of LOCAL_ONLY) {
    server.reset();
    await runHook(h.hook, BUILDERS[h.event](), { args: h.args, env: e() });
    // § Asserted exactly, against a real loopback socket, rather than inferred from how long
    //   something took. A fast local server can talk a stopwatch out of noticing; it cannot
    //   talk a request counter out of it.
    assert.equal(server.requests.length, 0,
      `${label(h)} dialled ${server.requests.map((q) => `${q.method} ${q.path}`).join(', ')}. `
      + 'This path is local I/O only; a request here is a round trip on the user`s clock.');
  }
});

test('F15 the event set is what hooks.json registers, and nothing has quietly been dropped', () => {
  const covered = new Set(HANDLERS.map((h) => h.event));
  // § This file drives its table by hand. If an event is added to hooks.json and not here, the
  //   whole failure surface for it goes untested — which is exactly the shape of the gap this
  //   suite exists to close.
  assert.deepEqual([...covered].sort(), [...CODEX_EVENTS].sort(),
    'the failure table has drifted from the eleven Codex events. Every event needs its garbage '
    + 'stdin, its blank endpoint and its underivable run id covered.');
});
