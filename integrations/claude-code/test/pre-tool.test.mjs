// @ts-check
/**
 * `hooks/src/pre-tool.mjs` — PreToolUse, **warnings only** (stage 1: warn, never deny).
 *
 * ---------------------------------------------------------------------------
 * What this gate is for
 * ---------------------------------------------------------------------------
 * A Mubit `rule` is defined as a hard constraint. Until now it landed as prose inside a
 * recall block, which the model may or may not honour. This hook is the first stage of
 * giving it a surface at the moment it applies — and **stage 1 denies nothing**.
 *
 * That is not a style preference, it is the whole safety argument for shipping it at all: a
 * false deny interrupts work, is confusing, and gets blamed on the plugin rather than on the
 * lesson that caused it. So the load-bearing test here is an *absence* test, and it
 * enumerates code paths rather than spot-checking the happy one.
 *
 * ---------------------------------------------------------------------------
 * There are TWO ways to deny, and both are pinned below
 * ---------------------------------------------------------------------------
 * Both were established against a running Claude Code 2.1.235, the way
 * `hook-output.test.mjs` establishes its constants, rather than taken from the published
 * reference:
 *
 *   1. **stdout.** The "Expected schema:" block the host prints for this event admits a
 *      `hookSpecificOutput.permissionDecision` of `allow`, `deny`, `ask` or `defer`, with a
 *      `permissionDecisionReason` beside it — and an `updatedInput`, which rewrites the
 *      tool's arguments and is a *larger* power than denying, since the call still runs and
 *      runs as something else. None of the five may ever appear.
 *
 *   2. **The exit code.** The host documents three bands for this event: exit 0 shows
 *      neither stdout nor stderr, exit 2 shows stderr to the model *and blocks the tool
 *      call*, and every other exit code shows stderr to the user only and continues with the
 *      call. **Exit 2 blocks the call.** Note the asymmetry: every *other* non-zero code
 *      continues through the normal permission flow, so the dangerous value is specifically
 *      2 — which is exactly what a naive `process.exit(2)` on an error path would pick.
 *      `lib/hook.mjs` pins `process.exitCode = 0` on every path out, and
 *      `assertHookContract` checks exit 0 as hygiene everywhere else in this suite; here it
 *      is the security property, so it is asserted explicitly and by name.
 *
 * ---------------------------------------------------------------------------
 * And zero network, necessarily
 * ---------------------------------------------------------------------------
 * This hook runs in front of a tool call. It cannot dial: even a 30 ms round trip on every
 * `rm` is latency the user pays for a warning. Rules come off disk, from
 * `runs/<run_id>/rules.json`, which `session-start`'s lessons call and `prompt-recall`'s
 * ladder fill in passing from entries they already fetched. `fakeMubit`'s `assertNotCalled`
 * is what holds that: a real loopback server that records everything, so "it dialled" is
 * visible rather than inferred.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PLUGIN_ROOT, assertHookContract, assertWithinBudget, baseEnv, fakeMubit, lib,
  makeDataDir, makeProjectDir, readJsonFile, runHook, tempDir,
} from './helpers/harness.mjs';
import { preToolUse, sessionStart, userPromptSubmit } from './helpers/fixtures.mjs';

/** Pinned (§6.1 `static`) so a case can seed `runs/<run_id>/rules.json` before the hook runs. */
const RUN_ID = 'cc-pre-tool-test';

/**
 * What `pre-tool` may cost on top of starting node. Everything it does is a `readFileSync`
 * and a set intersection, so the target is the same order as `stage-prompt`; 800 ms is set
 * from the other end, matching the allowance the rest of this suite uses under a concurrent
 * `npm test`. It is a guard-rail against a gross regression — a directory walk, a retry loop,
 * a network call — not a stopwatch. The network is caught exactly, by request count.
 */
const BUDGET_MS = 800;

/** One real git project: run-id derivation shells out to git on the non-static strategies. */
const PROJECT_DIR = makeProjectDir({ git: true });

/**
 * A rule worth surfacing and a rule that must stay quiet, so every match assertion below is
 * two-sided. The second one is `readLessons`' own fixture text from
 * `harness.mjs:defaultRoutes` — it shares no distinctive term with a `git push`.
 */
const FORCE_PUSH_RULE = 'Never force-push to main; open a pull request instead.';
const MIGRATION_RULE = 'Run the migration before starting the server.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @param {string} dataDir @param {string} [endpoint] @param {Record<string,string>} [extra] */
function env(dataDir, endpoint, extra = {}) {
  return baseEnv({
    dataDir,
    endpoint,
    projectDir: PROJECT_DIR,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: RUN_ID,
      // The flag is default-OFF (see the default-off test); every case that wants the hook to
      // do anything at all has to say so, exactly as a user opting in would.
      MUBIT_CC_PRE_TOOL_WARNINGS: '1',
      ...extra,
    },
  });
}

/** `runs/<run_id>/rules.json`, written raw so a case can seed a malformed one. */
function rulesPath(dataDir, runId = RUN_ID) {
  return join(dataDir, 'runs', runId, 'rules.json');
}

/** @param {string} dataDir @param {string} body */
function writeRulesRaw(dataDir, body, runId = RUN_ID) {
  const p = rulesPath(dataDir, runId);
  mkdirSync(join(dataDir, 'runs', runId), { recursive: true });
  writeFileSync(p, body, 'utf8');
  return p;
}

/** @param {string} dataDir @param {{ref?: string, text: string}[]} rules */
function seedRules(dataDir, rules, runId = RUN_ID) {
  return writeRulesRaw(dataDir, JSON.stringify({
    version: 1,
    updated_at: Date.now(),
    rules: rules.map((r) => ({ ref: r.ref ?? '', text: r.text })),
  }), runId);
}

// ===========================================================================
// The load-bearing test — every path, both denial channels
// ===========================================================================

/**
 * Every branch the hook can take, named. A spot-check on the happy path would stay green
 * against a version that denies on its error path, which is precisely the version that would
 * ship: the error path is the one nobody drives by hand.
 *
 * `setup` returns `{env, payload}` overrides. Anything it does not name uses `env()` above,
 * which has the opt-in flag ON — so a case that wants the flag off says so.
 *
 * @type {{name: string, why: string,
 *         setup: (dataDir: string) => {envExtra?: Record<string,string>,
 *                                      payload?: Record<string, any>,
 *                                      stdinRaw?: string,
 *                                      dataDirOverride?: string}}[]}
 */
const PATHS = [
  {
    name: 'flag off (the shipped default)',
    why: 'nothing changes for an existing user until they opt in',
    setup: (dataDir) => {
      seedRules(dataDir, [{ ref: 'ref_rule_1', text: FORCE_PUSH_RULE }]);
      return { envExtra: { MUBIT_CC_PRE_TOOL_WARNINGS: '0' } };
    },
  },
  {
    name: 'flag on, no rules.json at all',
    why: 'the ordinary state of a fresh run, before any recall has happened',
    setup: () => ({}),
  },
  {
    name: 'flag on, rules.json holds an empty list',
    why: 'recall ran and returned no rule — an absent key and an empty one are different values',
    setup: (dataDir) => { seedRules(dataDir, []); return {}; },
  },
  {
    name: 'flag on, rules.json is not JSON at all',
    why: 'a SIGKILL caught mid-write, or a foreign file dropped in the run directory',
    setup: (dataDir) => { writeRulesRaw(dataDir, '{"rules": [{"text": "half a wri'); return {}; },
  },
  {
    name: 'flag on, rules.json is JSON of the wrong shape',
    why: 'a store written by a future version, or by hand',
    setup: (dataDir) => { writeRulesRaw(dataDir, '["a bare array", 7, null]'); return {}; },
  },
  {
    name: 'flag on, rules.json holds entries with no text',
    why: 'a rule whose content did not survive redaction still must not become a deny',
    setup: (dataDir) => {
      writeRulesRaw(dataDir, JSON.stringify({ rules: [{ ref: 'ref_x' }, {}, null, 'string'] }));
      return {};
    },
  },
  {
    name: 'flag on, a rule matches the command',
    why: 'the one path that speaks — and it speaks in additionalContext, nothing else',
    setup: (dataDir) => {
      seedRules(dataDir, [{ ref: 'ref_rule_1', text: FORCE_PUSH_RULE }]);
      return {};
    },
  },
  {
    name: 'flag on, rules exist but none matches',
    why: 'the common case once a run has any rules at all',
    setup: (dataDir) => {
      seedRules(dataDir, [{ ref: 'ref_rule_2', text: MIGRATION_RULE }]);
      return {};
    },
  },
  {
    name: 'the payload carries no tool_name and no tool_input',
    why: 'a host version that renames a field must cost the warning, never the call',
    setup: (dataDir) => {
      seedRules(dataDir, [{ ref: 'ref_rule_1', text: FORCE_PUSH_RULE }]);
      return { payload: { tool_name: undefined, tool_input: undefined } };
    },
  },
  {
    name: 'the payload is not parseable JSON',
    why: 'lib/hook.mjs emits {} and exits 0 — it must not become an exit 2 here',
    setup: () => ({ stdinRaw: '{"tool_name": "Bash", ' }),
  },
  {
    name: 'the run id cannot be derived',
    why: 'a misconfigured MUBIT_CC_RUN_STRATEGY=static throws, and that throw is on this path',
    setup: () => ({ envExtra: { MUBIT_CC_RUN_ID: '' } }),
  },
  {
    name: 'the data dir is a regular file, so every read fails',
    why: '§12.1: an unwritable ${CLAUDE_PLUGIN_DATA} costs the memory, nothing else',
    setup: () => {
      const f = join(tempDir('mubit-cc-notadir-'), 'data');
      writeFileSync(f, 'this is a file where a directory should be');
      return { dataDirOverride: f };
    },
  },
];

/** The five keys that would turn this stage into stage 2, wherever they appear. */
const DENY_KEYS = Object.freeze([
  'permissionDecision', 'permissionDecisionReason', 'updatedInput',
  // `decision`/`reason` are the older top-level spelling of the same power and are still in
  // the host's accepted top-level key set, so a "fix" could reach for them instead.
  'decision', 'reason',
]);

for (const path of PATHS) {
  test(`denies nothing: ${path.name}`, async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());

    const dataDir = makeDataDir();
    const over = path.setup(dataDir);
    const runDataDir = over.dataDirOverride ?? dataDir;

    const r = await runHook('pre-tool', preToolUse({ cwd: PROJECT_DIR, ...(over.payload ?? {}) }), {
      env: env(runDataDir, server.url, over.envExtra ?? {}),
      stdinRaw: over.stdinRaw,
    });

    // Channel 2 first, because it is the one that blocks. `assertHookContract` also checks
    // this; it is restated by name because here it is not hygiene, it is the guarantee.
    assert.equal(r.code, 0,
      `pre-tool exited ${r.code} on the "${path.name}" path. Exit 2 BLOCKS the tool call and `
      + `shows stderr to the model; any other non-zero shows stderr to the user. This stage `
      + `denies nothing, so 0 is the only acceptable code. ${path.why}.\nstderr:\n${r.stderr}`);
    assertHookContract(r);

    // Channel 1: the five keys, at the top level and inside hookSpecificOutput.
    const out = r.json ?? {};
    const hso = (out && typeof out === 'object' && out.hookSpecificOutput) || {};
    for (const key of DENY_KEYS) {
      assert.ok(!(key in out),
        `pre-tool emitted top-level "${key}" on the "${path.name}" path. Stage 1 surfaces a `
        + `rule and decides nothing; ${path.why}.\nstdout: ${r.stdout}`);
      assert.ok(!(key in hso),
        `pre-tool emitted hookSpecificOutput.${key} on the "${path.name}" path. That is the `
        + `field the host reads to allow/deny/ask/defer or to rewrite the tool's arguments, `
        + `and stage 1 does none of them; ${path.why}.\nstdout: ${r.stdout}`);
    }

    // And the one key it IS allowed to fill must still name this event, or the host discards
    // the whole object with "(root): Invalid input" and injects nothing.
    if (out.hookSpecificOutput) {
      assert.equal(hso.hookEventName, 'PreToolUse',
        `pre-tool named the wrong event on the "${path.name}" path — the host throws "Hook `
        + 'returned incorrect event name" rather than injecting.');
    }
  });
}

// The runtime table above can only enumerate paths a test can reach. A budget overrun, an
// OOM, a stray callback throwing after the body resolved — `lib/hook.mjs` handles all three
// and they are not drivable from here. So the same property is asserted structurally too,
// over the source AND the shipped bundle: if the literal is not in the file, no path can
// emit it. The bundle is the half that matters, since that is what `hooks.json` executes.
test('neither the source nor the shipped bundle contains a deny at all', () => {
  const files = [
    join(PLUGIN_ROOT, 'hooks', 'src', 'pre-tool.mjs'),
    join(PLUGIN_ROOT, 'hooks', 'dist', 'impl', 'pre-tool.mjs'),
  ];
  for (const file of files) {
    assert.ok(existsSync(file),
      `${file} does not exist yet. That is the red state: write it (and rebuild, for the `
      + 'bundle), then re-run this test.');
    const src = readFileSync(file, 'utf8');

    for (const key of ['permissionDecision', 'updatedInput']) {
      // The doc comment names both keys deliberately, so the check is for a *value-carrying*
      // occurrence: the identifier followed by a `:` or a `=`, which is what an emit looks
      // like. Prose mentioning the field by name is how the ban stays legible.
      const emit = new RegExp(`${key}\\s*[:=]`);
      assert.ok(!emit.test(src),
        `${file} assigns ${key} somewhere. Stage 1 denies nothing and rewrites nothing — `
        + 'that key turns this hook into stage 2 without the confidence signals stage 2 needs.');
    }
    assert.ok(!/process\.exit\(\s*2\s*\)/.test(src),
      `${file} calls process.exit(2). The host blocks the tool call on exit code 2 — that is `
      + 'a deny by a second route, and it is the code a naive error handler picks.');
  }
});

// ===========================================================================
// Zero network
// ===========================================================================

// A hook in front of a tool call cannot dial: even a fast round trip is latency the user pays
// on every `rm`. The rules it reads were fetched by hooks that were already paying for a call.
test('pre-tool makes no HTTP call at all, on the path that speaks', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  const dataDir = makeDataDir();
  seedRules(dataDir, [{ ref: 'ref_rule_1', text: FORCE_PUSH_RULE }]);

  const r = await runHook('pre-tool', preToolUse({ cwd: PROJECT_DIR }), {
    env: env(dataDir, server.url),
  });
  assertHookContract(r);

  server.assertNotCalled('GET', '/v2/core/health');
  server.assertNotCalled('POST', '/v2/control/query');
  server.assertNotCalled('POST', '/v2/control/context');
  server.assertNotCalled('POST', '/v2/control/lessons');
  assert.equal(server.requests.length, 0,
    'pre-tool dialled Mubit. It runs in front of every matching tool call, so a round trip '
    + `here is latency on the user's critical path for a warning: ${server.summary()}`);
});

// ===========================================================================
// The default-off state is itself a test
// ===========================================================================

// Nothing changes for an existing user until they opt in — which is also what makes the
// "measure how often it fires" step of the rollout safe to run.
test('with preToolWarnings unset the hook emits exactly {"suppressOutput":true}', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  const dataDir = makeDataDir();
  seedRules(dataDir, [{ ref: 'ref_rule_1', text: FORCE_PUSH_RULE }]);

  const r = await runHook('pre-tool', preToolUse({ cwd: PROJECT_DIR }), {
    // No MUBIT_CC_PRE_TOOL_WARNINGS at all: the shipped default.
    env: baseEnv({
      dataDir,
      endpoint: server.url,
      projectDir: PROJECT_DIR,
      extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN_ID },
    }),
  });

  assertHookContract(r);
  assert.deepEqual(r.json, { suppressOutput: true },
    'off means off: with the flag unset the hook must say nothing at all. A rule leaking into '
    + `additionalContext here is context every user pays for without having asked: ${r.stdout}`);
  assert.equal(server.requests.length, 0, 'the off path must not dial either');
});

test('preToolWarnings defaults to false in lib/config.mjs', async () => {
  const config = await lib('config.mjs');
  const cfg = config.loadConfig(baseEnv({ dataDir: makeDataDir(), projectDir: PROJECT_DIR }));
  assert.equal(cfg.preToolWarnings, false,
    'preToolWarnings must default to false — this is the stage that can put text in front of '
    + 'a tool call, and it ships opt-in');
});

// ===========================================================================
// What it says when it does speak
// ===========================================================================

test('a rule that mentions the command is surfaced as additionalContext', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  const dataDir = makeDataDir();
  seedRules(dataDir, [
    { ref: 'ref_rule_1', text: FORCE_PUSH_RULE },
    { ref: 'ref_rule_2', text: MIGRATION_RULE },
  ]);

  const r = await runHook('pre-tool', preToolUse({ cwd: PROJECT_DIR }), {
    env: env(dataDir, server.url),
  });
  assertHookContract(r);

  const ctx = r.json?.hookSpecificOutput?.additionalContext ?? '';
  assert.ok(ctx.includes(FORCE_PUSH_RULE),
    `the rule about force-pushing did not reach the model on a "git push --force" call, which `
    + `is the entire claim this hook makes: ${r.stdout}`);
  assert.ok(!ctx.includes(MIGRATION_RULE),
    'an unrelated rule rode along. Every rule that surfaces on an unrelated call is context '
    + 'the user pays for and a reason to stop reading the channel: ' + ctx);
  assert.ok(ctx.includes('ref_rule_1'),
    'the reference_id is not in the block, so the model cannot mubit_dereference the rule it '
    + 'was just shown');
});

test('the block says it is a reminder and not a permission check', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  const dataDir = makeDataDir();
  seedRules(dataDir, [{ ref: 'ref_rule_1', text: FORCE_PUSH_RULE }]);
  const r = await runHook('pre-tool', preToolUse({ cwd: PROJECT_DIR }), {
    env: env(dataDir, server.url),
  });

  const ctx = r.json?.hookSpecificOutput?.additionalContext ?? '';
  assert.match(ctx, /not (a )?(permission|block)/i,
    'the injected block must say outright that nothing here blocks the call. A model that '
    + 'reads a standing rule at the moment of a tool call and believes it was enforced will '
    + 'stop checking, which is the failure mode a warnings-only stage exists to avoid: ' + ctx);
});

test('a matching rule costs nothing measurable on top of a bare node spawn', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  const run = async () => {
    const dataDir = makeDataDir();
    seedRules(dataDir, [{ ref: 'ref_rule_1', text: FORCE_PUSH_RULE }]);
    const r = await runHook('pre-tool', preToolUse({ cwd: PROJECT_DIR }), {
      env: env(dataDir, server.url),
    });
    assertHookContract(r);
    return r.ms;
  };

  await assertWithinBudget('pre-tool (matching rule)', BUDGET_MS, await run(), run);
});

// ===========================================================================
// lib/rules.mjs — the store
// ===========================================================================

test('recordRules keeps entry_type "rule" and drops everything else', async () => {
  const rules = await lib('rules.mjs');
  const dataDir = makeDataDir();
  const cfg = { dataDir };

  rules.recordRules(cfg, RUN_ID, [
    { reference_id: 'ref_a', entry_type: 'rule', content: FORCE_PUSH_RULE },
    { reference_id: 'ref_b', entry_type: 'lesson', content: 'A job stays queued until indexed.' },
    { reference_id: 'ref_c', entry_type: 'fact', content: 'status is always "queued".' },
    { reference_id: 'ref_d', entry_type: 'mental_model', content: 'Ingest is asynchronous.' },
  ]);

  const stored = rules.readRules(cfg, RUN_ID);
  assert.deepEqual(stored.map((r) => r.ref), ['ref_a'],
    'only `rule` entries belong in this store. A lesson surfacing in front of a tool call is '
    + 'the model being interrupted by a suggestion, which is not what a rule is for');
});

test('recordRules reads origin_entry_type ahead of entry_type, as assemble.mjs does', async () => {
  const rules = await lib('rules.mjs');
  const dataDir = makeDataDir();
  const cfg = { dataDir };

  // §4.10: "maps entry_type (or origin_entry_type when the entry came through an overlay)".
  // The overlay's own type is bookkeeping; the origin is the type the user's rule actually has.
  rules.recordRules(cfg, RUN_ID, [
    { reference_id: 'ref_overlay', entry_type: 'observation', origin_entry_type: 'rule',
      content: FORCE_PUSH_RULE },
  ]);
  assert.equal(rules.readRules(cfg, RUN_ID).length, 1,
    'a rule that arrived through an overlay is still a rule; dropping it means the store is '
    + 'empty on exactly the instances that use overlays');
});

test('recordRules accepts the lessons wire shape as well as the evidence one', async () => {
  const rules = await lib('rules.mjs');
  const dataDir = makeDataDir();
  const cfg = { dataDir };

  // `POST /v2/control/lessons` answers `{lesson_id, content, lesson_type, scope, importance}`
  // — a different spelling of the same three fields the query ladder returns.
  rules.recordRules(cfg, RUN_ID, [
    { lesson_id: 'les_g1', lesson_type: 'rule', content: FORCE_PUSH_RULE },
    { lesson_id: 'les_g2', lesson_type: 'failure', content: 'When X, do Y.' },
  ]);

  const stored = rules.readRules(cfg, RUN_ID);
  assert.deepEqual(stored.map((r) => r.ref), ['les_g1'],
    'session-start fetches global lessons and prompt-recall fetches evidence; the two name '
    + 'the same fields differently, and a store that reads only one of them is half-wired');
});

test('recordRules drops entries the server has marked stale', async () => {
  const rules = await lib('rules.mjs');
  const dataDir = makeDataDir();
  const cfg = { dataDir };

  rules.recordRules(cfg, RUN_ID, [
    { reference_id: 'ref_fresh', entry_type: 'rule', content: FORCE_PUSH_RULE },
    { reference_id: 'ref_old', entry_type: 'rule', is_stale: true, content: MIGRATION_RULE },
  ]);

  assert.deepEqual(rules.readRules(cfg, RUN_ID).map((r) => r.ref), ['ref_fresh'],
    'the server marks an entry stale for transparency and the client is supposed to act on '
    + 'it. Putting a superseded constraint in front of a live command is worse than saying '
    + 'nothing: it is confidently wrong at the moment it is hardest to check');
});

test('recordRules merges across calls and dedupes by reference id', async () => {
  const rules = await lib('rules.mjs');
  const dataDir = makeDataDir();
  const cfg = { dataDir };

  // session-start writes first, then prompt-recall writes on every prompt for the rest of
  // the session. The second writer must not wipe the first.
  rules.recordRules(cfg, RUN_ID, [{ reference_id: 'ref_a', entry_type: 'rule', content: FORCE_PUSH_RULE }]);
  rules.recordRules(cfg, RUN_ID, [{ reference_id: 'ref_b', entry_type: 'rule', content: MIGRATION_RULE }]);
  rules.recordRules(cfg, RUN_ID, [{ reference_id: 'ref_a', entry_type: 'rule', content: FORCE_PUSH_RULE }]);

  const stored = rules.readRules(cfg, RUN_ID);
  assert.deepEqual(stored.map((r) => r.ref).sort(), ['ref_a', 'ref_b'],
    'two writers share this file; the later one must merge rather than replace, and a rule '
    + 'recalled on twenty prompts must be stored once');
});

test('the store is bounded — a long rule and a long list are both capped', async () => {
  const rules = await lib('rules.mjs');
  const dataDir = makeDataDir();
  const cfg = { dataDir };

  const many = [];
  for (let i = 0; i < 500; i++) {
    many.push({ reference_id: `ref_${i}`, entry_type: 'rule', content: `${'x'.repeat(4000)} ${i}` });
  }
  rules.recordRules(cfg, RUN_ID, many);

  const stored = rules.readRules(cfg, RUN_ID);
  assert.ok(stored.length > 0 && stored.length <= 64,
    `the store grew to ${stored.length} rules. It is read synchronously in front of a tool `
    + 'call, so it is a latency budget as much as a token one');
  for (const r of stored) {
    assert.ok(r.text.length <= 512,
      `a stored rule is ${r.text.length} characters. One pathological entry must not be able `
      + 'to fill the model\'s context at the moment of a tool call');
  }
});

test('every rules.mjs entry point survives a corrupt store without throwing', async () => {
  const rules = await lib('rules.mjs');
  const dataDir = makeDataDir();
  const cfg = { dataDir };

  for (const body of ['', '   ', 'not json', '[]', '{"rules": "nope"}', 'null', '{}']) {
    writeRulesRaw(dataDir, body);
    assert.doesNotThrow(() => rules.readRules(cfg, RUN_ID),
      `readRules threw on a store containing ${JSON.stringify(body)}. Every caller is on a `
      + 'hook\'s critical path; a memory layer has no business breaking a tool call (§4.9)');
    assert.deepEqual(rules.readRules(cfg, RUN_ID), [],
      `a store containing ${JSON.stringify(body)} must read as no rules, not as a partial one`);
    assert.doesNotThrow(() => rules.recordRules(cfg, RUN_ID, [
      { reference_id: 'ref_a', entry_type: 'rule', content: FORCE_PUSH_RULE },
    ]), `recordRules threw over a store containing ${JSON.stringify(body)}`);
  }
});

test('rules.mjs never throws on an unwritable data dir', async () => {
  const rules = await lib('rules.mjs');
  const file = join(tempDir('mubit-cc-rules-notadir-'), 'data');
  writeFileSync(file, 'a file where a directory should be');
  const cfg = { dataDir: file };

  assert.doesNotThrow(() => rules.recordRules(cfg, RUN_ID, [
    { reference_id: 'ref_a', entry_type: 'rule', content: FORCE_PUSH_RULE },
  ]), '§12.1: an unwritable ${CLAUDE_PLUGIN_DATA} costs the rule store, nothing else');
  assert.deepEqual(rules.readRules(cfg, RUN_ID), []);
});

// ===========================================================================
// The producers — the store is filled by paths that already fetch entries
// ===========================================================================

// This hook cannot dial, so the store has to be populated by someone who already paid for a
// round trip. If neither producer writes, the hook is correct and permanently silent — which
// is the failure mode that looks exactly like "it works, nothing matched".
test('session-start writes the rules it already fetched into rules.json', async (t) => {
  // The feed's shape, not the lessons route's: `lesson_type` lives inside `metadata_json`
  // here, and mapping it back out is exactly what keeps this store fed.
  const feedLesson = (id, content, type) => ({
    id,
    created_at: '2026-02-02T00:00:00Z',
    entry_type: 'lesson',
    run_id: 'cc-some-other-run',
    content,
    source: 'reflection:cc-some-other-run',
    metadata_json: JSON.stringify({ scope: 'global', lesson_type: type, importance: 'high' }),
  });
  const server = await fakeMubit({
    'POST /v2/control/activity': {
      json: {
        entries: [
          feedLesson('les_rule', FORCE_PUSH_RULE, 'rule'),
          feedLesson('les_lesson', MIGRATION_RULE, 'failure'),
        ],
        next_page_token: '',
        total_visible: 2,
      },
    },
  });
  t.after(() => server.close());

  const dataDir = makeDataDir();
  const r = await runHook('session-start', sessionStart({ cwd: PROJECT_DIR }), {
    env: env(dataDir, server.url),
  });
  assertHookContract(r);

  assert.ok(existsSync(rulesPath(dataDir)),
    'session-start fetched the standing lessons and did not record the rules among them. The '
    + 'PreToolUse hook has no other way to learn about them: it may not dial.');
  const stored = readJsonFile(rulesPath(dataDir));
  assert.deepEqual((stored.rules ?? []).map((x) => x.ref), ['les_rule'],
    'only the `rule`-typed lesson belongs in the store');
});

test('prompt-recall writes the rules out of the evidence it already fetched', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  // The default `queryResponse()` already carries one `entry_type: 'rule'` — `ref_rule_1` —
  // beside a lesson and a fact, which is exactly the mixed shape rung 1 answers with.
  const dataDir = makeDataDir();
  const r = await runHook('prompt-recall', userPromptSubmit({ cwd: PROJECT_DIR }), {
    env: env(dataDir, server.url),
  });
  assertHookContract(r);

  assert.ok(existsSync(rulesPath(dataDir)),
    'prompt-recall recalled evidence containing a rule and recorded nothing. Rules reach the '
    + 'PreToolUse hook only through this file.');
  const stored = readJsonFile(rulesPath(dataDir));
  assert.deepEqual((stored.rules ?? []).map((x) => x.ref), ['ref_rule_1'],
    'the rule from the evidence should be stored under its reference_id, and the lesson and '
    + 'fact beside it should not be stored at all');
});

test('a rule recalled on one prompt is still warned about on a later tool call', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': {
      json: {
        final_answer: '', confidence: 0.6, mode: 'direct_bypass', degraded: false,
        consulted_runs: [], routing_summary: 'direct_bypass', signals: {}, citations: [],
        evidence: [{
          id: 'e1', reference_id: 'ref_force', entry_type: 'rule', score: 0.9,
          content: FORCE_PUSH_RULE, source: 'agent', run_id: RUN_ID, metadata_json: '{}',
          retrieval_mode: 'semantic_search', referenceable: true, origin_entry_type: '',
          is_stale: false, superseded_by: '', explain_info: '', knowledge_confidence: 0.9,
        }],
      },
    },
  });
  t.after(() => server.close());

  const dataDir = makeDataDir();

  // Turn 1: the prompt hook recalls, and records the rule in passing.
  const recall = await runHook('prompt-recall', userPromptSubmit({ cwd: PROJECT_DIR }), {
    env: env(dataDir, server.url),
  });
  assertHookContract(recall);

  // Turn 1, later: the model reaches for the command the rule is about.
  const pre = await runHook('pre-tool', preToolUse({ cwd: PROJECT_DIR }), {
    env: env(dataDir, server.url),
  });
  assertHookContract(pre);

  assert.ok((pre.json?.hookSpecificOutput?.additionalContext ?? '').includes(FORCE_PUSH_RULE),
    'end to end, a rule that came back from recall did not surface at the moment it applied. '
    + 'That round trip — server to rules.json to the tool call — is the whole of stage 1: '
    + `${pre.stdout}`);
});
