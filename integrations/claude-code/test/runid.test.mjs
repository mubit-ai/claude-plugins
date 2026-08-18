// @ts-check
/**
 * `lib/runid.mjs`.
 *
 * Protects build-guide §4.3 (the four strategies, the `SessionStart.source`
 * table, `SessionRecord`) and §12.3, plus spec §7 (identity and session model).
 *
 * The run id is the data scope: get it wrong and a user's memory either leaks
 * across projects or is silently written somewhere they will never read it
 * from. The single most important rule in this file is that no input — no
 * matter how hostile — may ever produce the literal `"default"`, the value
 * the MCP server still defaults `MUBIT_DEFAULT_SESSION_ID` to, which collapses
 * every user and project into one shared run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  lib, makeDataDir, makeProjectDir, baseEnv, withEnv, readJsonFile,
} from './helpers/harness.mjs';
import * as fx from './helpers/fixtures.mjs';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * A pinned environment for one derivation. `MUBIT_CC_RUN_ID` is explicitly
 * cleared unless a case sets it, so a developer's shell cannot decide a test.
 * @param {string} dataDir
 * @param {string} projectDir
 * @param {string} strategy
 * @param {Record<string,string|undefined>} [extra]
 */
function envFor(dataDir, projectDir, strategy, extra = {}) {
  return baseEnv({
    dataDir,
    projectDir,
    extra: { MUBIT_CC_RUN_STRATEGY: strategy, MUBIT_CC_RUN_ID: undefined, ...extra },
  });
}

/**
 * `loadConfig` + `deriveRunId` under one environment. `loadSessionMap` takes no
 * cfg (§4.3), so the environment has to be live for the call, not just passed.
 * @param {any} config @param {any} runid
 * @param {Record<string,string>} env @param {any} payload
 */
function derive(config, runid, env, payload) {
  return withEnv(env, () => runid.deriveRunId(config.loadConfig(env), payload));
}

/** @param {string} sid */
function sessionFile(dataDir, sid) { return join(dataDir, 'sessions', `${sid}.json`); }

/** A full §4.3 SessionRecord. */
function record(over = {}) {
  return {
    run_id: 'cc-pinned-deadbeef',
    agent_id: 'claude-code-4f21ab',
    strategy: 'per-directory',
    project_dir: '/Users/x/repo',
    created_at: 1765000000000,
    last_seen_at: 1765000000000,
    mode: 'local',
    clear_count: 0,
    endpoint_hash: '9f2a11c4',
    ...over,
  };
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) { spawnSync('git', args, { cwd, stdio: 'ignore' }); }

const HASH8 = /-[0-9a-f]{8}$/;

// ===========================================================================
// §4.3 — the four strategies and their documented shapes
// ===========================================================================

// §4.3: per-directory (default) → cc-<slug>-<hash8>, hashing `git rev-parse --show-toplevel`.
test('per-directory: shape is cc-<slug>-<hash8>', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const projectDir = makeProjectDir({ git: true });
  const env = envFor(makeDataDir(), projectDir, 'per-directory');

  const id = derive(config, runid, env, fx.sessionStart());

  assert.match(id, /^cc-.+-[0-9a-f]{8}$/, `"${id}" is not cc-<slug>-<hash8>`);
  assert.match(id, HASH8);
  assert.equal(/\s/.test(id), false, 'a run id may not contain whitespace');
});

// §4.3: git-branch → cc-<slug>-<branch>-<hash8>.
test('git-branch: shape is cc-<slug>-<branch>-<hash8>', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const projectDir = makeProjectDir({ git: true, branch: 'wip' });
  const env = envFor(makeDataDir(), projectDir, 'git-branch');

  const id = derive(config, runid, env, fx.sessionStart());

  assert.match(id, /^cc-.+-[0-9a-f]{8}$/, `"${id}" is not cc-<slug>-<branch>-<hash8>`);
  assert.ok(id.includes('-wip-'), `"${id}" does not carry the branch name`);
});

// §4.3: per-conversation → cc-<host_session_id>.
test('per-conversation: shape is cc-<host_session_id>', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const env = envFor(makeDataDir(), makeProjectDir({ git: true }), 'per-conversation');

  const id = derive(config, runid, env, fx.sessionStart());

  assert.equal(id, `cc-${fx.SESSION_ID}`);
});

// §4.3: static → the literal MUBIT_CC_RUN_ID, untouched.
test('static: the literal MUBIT_CC_RUN_ID', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const env = envFor(makeDataDir(), makeProjectDir({ git: true }), 'static', {
    MUBIT_CC_RUN_ID: 'cc-team-shared-run',
  });

  assert.equal(derive(config, runid, env, fx.sessionStart()), 'cc-team-shared-run');
});

// §4.3: "config error when unset — never a silent default". A silent fallback
// here would write a team's pinned-run memory into some other run.
test('static: an unset MUBIT_CC_RUN_ID is a config error', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const env = envFor(makeDataDir(), makeProjectDir({ git: true }), 'static');

  let threw = false;
  try {
    withEnv(env, () => runid.deriveRunId(config.loadConfig(env), fx.sessionStart()));
  } catch {
    threw = true;
  }
  assert.equal(threw, true,
    'static without MUBIT_CC_RUN_ID must raise a config error, not fall back to another strategy');
});

/**
 * A run id names a directory under the plugin data dir as well as a run. A pin carrying a
 * separator meant two different things at once — one value on the wire, another after the
 * write flattened it — and `stage-prompt` used to join it raw, so the turn file landed
 * somewhere no sibling hook would read.
 */
test('static: a MUBIT_CC_RUN_ID that is a path is a config error', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');

  for (const pinned of ['../../escaped', 'cc-a/b', 'cc-a\\b', '..']) {
    const env = envFor(makeDataDir(), makeProjectDir({ git: true }), 'static',
      { MUBIT_CC_RUN_ID: pinned });
    let threw = false;
    try {
      withEnv(env, () => runid.deriveRunId(config.loadConfig(env), fx.sessionStart()));
    } catch {
      threw = true;
    }
    assert.equal(threw, true, `"${pinned}" must be refused, not turned into a directory`);
  }
});

// The pins that merely need flattening are still legal — refusing those would break a run
// id a user has been using for months.
test('static: a run id with unusual but harmless characters is still accepted', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const env = envFor(makeDataDir(), makeProjectDir({ git: true }), 'static',
    { MUBIT_CC_RUN_ID: 'cc-a:b*c' });

  assert.equal(derive(config, runid, env, fx.sessionStart()), 'cc-a:b*c',
    'the wire value is the pin verbatim; only the path segment is flattened');
});

// ===========================================================================
// §4.3/§12.3 — stability
// ===========================================================================

// §12.3: stable across two invocations in one directory. Two terminals in the
// same repo must share a run; that is the whole point of per-directory.
test('per-directory: stable across invocations, distinct across directories', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const projectA = makeProjectDir({ git: true });
  const projectB = makeProjectDir({ git: true });

  // Separate data dirs and separate session ids: no session map can be doing
  // the work that the derivation is supposed to be doing.
  const a1 = derive(config, runid, envFor(makeDataDir(), projectA, 'per-directory'),
    fx.sessionStart({ session_id: 'aaaaaaaa-0000-0000-0000-000000000001' }));
  const a2 = derive(config, runid, envFor(makeDataDir(), projectA, 'per-directory'),
    fx.sessionStart({ session_id: 'aaaaaaaa-0000-0000-0000-000000000002' }));
  const b1 = derive(config, runid, envFor(makeDataDir(), projectB, 'per-directory'),
    fx.sessionStart({ session_id: 'bbbbbbbb-0000-0000-0000-000000000001' }));

  assert.equal(a1, a2, 'two sessions in one directory must share a run');
  assert.notEqual(a1, b1, 'two directories must not share a run');
});

// §4.3: "falling back to CLAUDE_PROJECT_DIR" when there is no git root.
test('per-directory: falls back to CLAUDE_PROJECT_DIR outside a git repo', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const plainA = makeProjectDir();
  const plainB = makeProjectDir();

  const a1 = derive(config, runid, envFor(makeDataDir(), plainA, 'per-directory'),
    fx.sessionStart({ session_id: 'cccccccc-0000-0000-0000-000000000001' }));
  const a2 = derive(config, runid, envFor(makeDataDir(), plainA, 'per-directory'),
    fx.sessionStart({ session_id: 'cccccccc-0000-0000-0000-000000000002' }));
  const b1 = derive(config, runid, envFor(makeDataDir(), plainB, 'per-directory'),
    fx.sessionStart({ session_id: 'dddddddd-0000-0000-0000-000000000001' }));

  assert.match(a1, /^cc-.+-[0-9a-f]{8}$/);
  assert.equal(a1, a2, 'the non-git fallback must still be stable');
  assert.notEqual(a1, b1,
    'the fallback must hash CLAUDE_PROJECT_DIR, not the process cwd');
});

// §12.3: git-branch changes with the branch while per-directory does not —
// "so a feature branch gets its own memory" (spec §7).
test('git-branch tracks the branch; per-directory ignores it', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const projectDir = makeProjectDir({ git: true, branch: 'alpha' });
  const sid = (n) => fx.sessionStart({ session_id: `eeeeeeee-0000-0000-0000-00000000000${n}` });

  const dirAlpha = derive(config, runid, envFor(makeDataDir(), projectDir, 'per-directory'), sid(1));
  const branchAlpha = derive(config, runid, envFor(makeDataDir(), projectDir, 'git-branch'), sid(2));

  git(projectDir, ['checkout', '-qb', 'beta']);

  const dirBeta = derive(config, runid, envFor(makeDataDir(), projectDir, 'per-directory'), sid(3));
  const branchBeta = derive(config, runid, envFor(makeDataDir(), projectDir, 'git-branch'), sid(4));

  assert.equal(dirAlpha, dirBeta, 'per-directory must not move when the branch does');
  assert.notEqual(branchAlpha, branchBeta, 'git-branch must move with the branch');
  assert.ok(branchAlpha.includes('-alpha-'));
  assert.ok(branchBeta.includes('-beta-'));
});

// ===========================================================================
// §4.3 — the SessionStart.source table
// ===========================================================================

// §4.3 `startup`: "Derive fresh, write the map."
test('source=startup: derives fresh and writes the session map', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir({ git: true });
  const env = envFor(dataDir, projectDir, 'per-directory');

  const id = derive(config, runid, env, fx.sessionStart({ source: 'startup' }));

  const p = sessionFile(dataDir, fx.SESSION_ID);
  assert.equal(existsSync(p), true, 'startup must write sessions/<host_session_id>.json');
  const rec = readJsonFile(p);
  assert.equal(rec.run_id, id);
  assert.equal(rec.strategy, 'per-directory');
  assert.equal(rec.project_dir, projectDir);
});

// §4.3 `startup`: fresh means fresh — a leftover mapping is not reused.
test('source=startup: ignores a stale mapped run id', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const env = envFor(dataDir, makeProjectDir({ git: true }), 'per-directory');

  withEnv(env, () => runid.saveSessionMap(fx.SESSION_ID, record({ run_id: 'cc-stale-deadbeef' })));
  const id = derive(config, runid, env, fx.sessionStart({ source: 'startup' }));

  assert.notEqual(id, 'cc-stale-deadbeef', 'startup must derive, not inherit');
  assert.match(id, HASH8);
});

// §4.3 `resume`: "Reuse the mapped run_id."
test('source=resume: reuses the mapped run id', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const env = envFor(dataDir, makeProjectDir({ git: true }), 'per-directory');

  withEnv(env, () => runid.saveSessionMap(fx.SESSION_ID, record({ run_id: 'cc-pinned-deadbeef' })));
  const id = derive(config, runid, env, fx.sessionStart({ source: 'resume' }));

  assert.equal(id, 'cc-pinned-deadbeef');
});

// §4.3 `compact`/`fork`: "Reuse the parent session record's run."
for (const source of ['compact', 'fork']) {
  test(`source=${source}: reuses the parent session record's run`, async () => {
    const config = await lib('config.mjs');
    const runid = await lib('runid.mjs');
    const dataDir = makeDataDir();
    const env = envFor(dataDir, makeProjectDir({ git: true }), 'per-directory');

    withEnv(env, () => runid.saveSessionMap(fx.SESSION_ID, record({ run_id: 'cc-parent-deadbeef' })));
    const id = derive(config, runid, env, fx.sessionStart({ source }));

    assert.equal(id, 'cc-parent-deadbeef');
  });
}

// §4.3 `clear`: "New run." /clear means "forget the thread"; per-directory is
// stable per directory, so the clear counter is what actually forgets.
test('source=clear: produces a NEW run id with an incrementing -c<n>', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const env = envFor(dataDir, makeProjectDir({ git: true }), 'per-directory');

  const base = derive(config, runid, env, fx.sessionStart({ source: 'startup' }));
  const cleared1 = derive(config, runid, env, fx.sessionStart({ source: 'clear' }));
  const cleared2 = derive(config, runid, env, fx.sessionStart({ source: 'clear' }));

  assert.notEqual(cleared1, base, '/clear must not reuse the run it was asked to forget');
  assert.equal(cleared1, `${base}-c1`);
  assert.equal(cleared2, `${base}-c2`);
  assert.equal(readJsonFile(sessionFile(dataDir, fx.SESSION_ID)).clear_count, 2);
});

// §4.3: resume with nothing mapped (fresh install, restored terminal) still has
// to answer with a real run id.
test('source=resume: derives when there is no session record at all', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const env = envFor(makeDataDir(), makeProjectDir({ git: true }), 'per-directory');

  const id = derive(config, runid, env, fx.sessionStart({ source: 'resume' }));

  assert.match(id, /^cc-.+-[0-9a-f]{8}$/);
  assert.notEqual(id, 'default');
});

// ===========================================================================
// §4.3/§12.3 — the headline: "default" is unreachable
// ===========================================================================

/** Missing, blank and outright hostile inputs. */
const HOSTILE = [
  { name: 'empty session id', payload: { session_id: '' } },
  { name: 'missing session id', payload: { session_id: undefined } },
  { name: 'session id literally "default"', payload: { session_id: 'default' } },
  { name: 'blank project dir', env: { CLAUDE_PROJECT_DIR: '' } },
  { name: 'missing project dir', env: { CLAUDE_PROJECT_DIR: undefined } },
  { name: 'nonexistent project dir', env: { CLAUDE_PROJECT_DIR: '/nope/not/a/real/path' } },
  { name: 'MUBIT_DEFAULT_SESSION_ID=default in the env', env: { MUBIT_DEFAULT_SESSION_ID: 'default' } },
  { name: 'MUBIT_CC_RUN_ID=default', env: { MUBIT_CC_RUN_ID: 'default' } },
  { name: 'MUBIT_CC_RUN_ID blank', env: { MUBIT_CC_RUN_ID: '   ' } },
  { name: 'empty payload', payload: null },
  { name: 'unknown SessionStart.source', payload: { source: 'teleported' } },
];

for (const strategy of ['per-directory', 'git-branch', 'per-conversation', 'static']) {
  // §4.3/§12.3: no strategy can ever emit "default" — the MCP server's poisoned
  // default is what collapses every project on a machine into one run.
  test(`${strategy}: no input can produce "default" or an empty run id`, async () => {
    const config = await lib('config.mjs');
    const runid = await lib('runid.mjs');
    const projectDir = makeProjectDir({ git: true });

    for (const c of HOSTILE) {
      const env = envFor(makeDataDir(), projectDir, strategy, c.env ?? {});
      const payload = c.payload === null ? {} : fx.sessionStart(c.payload ?? {});

      let out;
      try {
        out = withEnv(env, () => runid.deriveRunId(config.loadConfig(env), payload));
      } catch {
        // A config error is a legitimate answer. A silent "default" is not.
        continue;
      }

      assert.equal(typeof out, 'string', `${c.name}: run id must be a string`);
      assert.notEqual(out.trim(), 'default', `${c.name}: emitted the poisoned "default" run id`);
      assert.notEqual(out.trim(), '', `${c.name}: emitted an empty run id`);
      assert.notEqual(out.trim(), 'cc-', `${c.name}: emitted a bare prefix`);
    }
  });
}

// ===========================================================================
// §4.3 — deriveAgentId
// ===========================================================================

// §4.3/§5.1: a role, not a session. The session id must not leak into the identity — a new
// principal per session makes any upstream "how many distinct actors confirmed this?" count
// meaningless, because one person working two days running satisfies it alone.
test('deriveAgentId(): the stable role claude-code, with no session in it', async () => {
  const runid = await lib('runid.mjs');

  const id = runid.deriveAgentId(fx.stop());
  assert.equal(id, 'claude-code', `"${id}" is not the bare role`);

  assert.equal(runid.deriveAgentId(fx.userPromptSubmit()), id, 'agent id must not vary by hook');
  assert.equal(runid.deriveAgentId(fx.stop({ session_id: '9999abcd-1111-2222-3333-444455556666' })), id,
    'a different session is the same actor');
  assert.ok(!id.includes(fx.SESSION_ID.replace(/-/g, '').slice(0, 8)),
    'the host session id must not appear in the agent id');
});

// §4.3: subagents still get their own identity — claude-code-sub-<agentShort>. This is the
// one distinctness the value has to provide, and making the parent stable must not cost it.
test('deriveAgentId(): appends -sub-<agentShort> for a subagent payload', async () => {
  const runid = await lib('runid.mjs');

  const parent = runid.deriveAgentId(fx.stop());
  const sub = runid.deriveAgentId(fx.subagentStop());

  assert.ok(sub.startsWith(`${parent}-sub-`), `"${sub}" is not "${parent}-sub-<agentShort>"`);
  assert.ok(sub.slice(`${parent}-sub-`.length).length > 0, 'the subagent short id is empty');
  assert.notEqual(runid.deriveAgentId(fx.subagentStop({ agent_id: 'sub_ZZZZZZZZZZZZ' })), sub,
    'two subagents working at once must not share an agent id');
});

// A payload echoing the derived parent back at us is not a subagent. With the parent now the
// bare role, the equality case is as reachable as the prefix one.
test('deriveAgentId(): a payload echoing the parent id is not a subagent', async () => {
  const runid = await lib('runid.mjs');

  assert.equal(runid.deriveAgentId(fx.stop({ agent_id: 'claude-code' })), 'claude-code');
  assert.equal(runid.deriveAgentId(fx.stop({ agent_id: 'claude-code-sub-abc123' })), 'claude-code');
});

// ===========================================================================
// §4.3 — the session map
// ===========================================================================

// §4.3: SessionRecord round-trips whole at sessions/<host_session_id>.json.
test('saveSessionMap()/loadSessionMap(): the full SessionRecord round-trips', async () => {
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const env = envFor(dataDir, makeProjectDir(), 'per-directory');
  const rec = record({ run_id: 'cc-my-project-9f2a11c4', clear_count: 2 });

  const got = withEnv(env, () => {
    runid.saveSessionMap(fx.SESSION_ID, rec);
    return runid.loadSessionMap(fx.SESSION_ID);
  });

  assert.equal(existsSync(sessionFile(dataDir, fx.SESSION_ID)), true,
    'the record must live at sessions/<host_session_id>.json');
  for (const k of Object.keys(rec)) {
    assert.deepEqual(got[k], rec[k], `SessionRecord.${k} did not round-trip`);
  }
  const onDisk = readJsonFile(sessionFile(dataDir, fx.SESSION_ID));
  for (const k of Object.keys(rec)) {
    assert.ok(k in onDisk, `SessionRecord.${k} is missing from the persisted file`);
  }
});

// §4.3: an unknown session is `null` — the caller derives; it never guesses.
test('loadSessionMap(): an unknown session returns null', async () => {
  const runid = await lib('runid.mjs');
  const env = envFor(makeDataDir(), makeProjectDir(), 'per-directory');

  const got = withEnv(env, () => runid.loadSessionMap('00000000-dead-beef-0000-000000000000'));
  assert.equal(got, null);
});

// §4.3 + §12.1-F14: a corrupt record is treated as "no record", never a throw.
test('loadSessionMap(): a corrupt session file returns null', async () => {
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const env = envFor(dataDir, makeProjectDir(), 'per-directory');
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  writeFileSync(sessionFile(dataDir, fx.SESSION_ID), '{"run_id": "cc-x", "clear_c');

  const got = withEnv(env, () => runid.loadSessionMap(fx.SESSION_ID));
  assert.equal(got, null);
});
