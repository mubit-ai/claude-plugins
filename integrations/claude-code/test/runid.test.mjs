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
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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

/**
 * The §4.8 ring log, parsed. Read through the real sink — a temp data dir plus
 * `MUBIT_CC_LOG_LEVEL` — rather than by stubbing `log`, so what is asserted is
 * the line a user pastes into an issue and not a call this test arranged.
 * @param {string} dataDir
 * @returns {Record<string, any>[]}
 */
function logLines(dataDir) {
  const p = join(dataDir, 'logs', 'mubit-cc.log');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** The four §4.3 strategies, spelled out here so a rename has to be made twice. */
const LEGAL_STRATEGIES = ['per-directory', 'git-branch', 'per-conversation', 'static'];

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

/*
 * §4.3, I6 — a value that is not one of the four.
 *
 * The fallback is deliberate and stays: `normaliseStrategy` is on the path of every hook, and
 * throwing on a typo would take a live session's run id away over a config error the user
 * cannot see mid-session. Contrast `staticRunId` above, which *does* throw — and is right to,
 * because there is no honest answer for an unset pin, whereas here there is a documented
 * default.
 *
 * What was wrong was the silence. `testkit/ux/scenarios/W2-02-branch-switch.md` set
 * `MUBIT_CC_RUN_STRATEGY=repo` — not a strategy — and ran under `per-directory` for its whole
 * life, where a branch switch does not move the run id. It would have passed while proving the
 * exact opposite of its own claim, and nothing anywhere said so.
 */

// §4.3: the fallback itself must not regress — an unrecognised value is still per-directory.
test('an unrecognised run strategy still falls back to per-directory', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const projectDir = makeProjectDir({ git: true });
  // Separate data dirs and session ids: no session map may be doing the work the fallback is
  // supposed to be doing.
  const sid = (n) => fx.sessionStart({ session_id: `ffffffff-0000-0000-0000-00000000000${n}` });

  const bad = derive(config, runid, envFor(makeDataDir(), projectDir, 'repo'), sid(1));
  const good = derive(config, runid, envFor(makeDataDir(), projectDir, 'per-directory'), sid(2));

  assert.equal(bad, good,
    'a typo in MUBIT_CC_RUN_STRATEGY must not take the run id away from a live session');
});

// §4.3/I6: the fallback is now *said*. One warn line, naming the value received and all four
// legal strategies, is the difference between a misconfiguration and an invisible one.
test('an unrecognised run strategy warns, naming the value and the four legal strategies', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const env = envFor(dataDir, makeProjectDir({ git: true }), 'repo',
    { MUBIT_CC_LOG_LEVEL: 'warn' });

  derive(config, runid, env, fx.sessionStart());

  const warnings = logLines(dataDir).filter((l) => l.level === 'warn');
  assert.equal(warnings.length, 1,
    `an unrecognised strategy must warn exactly once, got:\n${JSON.stringify(warnings, null, 2)}`);
  assert.ok(warnings[0].msg.includes('repo'),
    `the warning must name the value received, got: ${warnings[0].msg}`);
  for (const s of LEGAL_STRATEGIES) {
    assert.ok(warnings[0].msg.includes(s),
      `the warning must name "${s}" as a legal strategy, or it says what is wrong without `
      + `saying what is right, got: ${warnings[0].msg}`);
  }
});

// §4.8: once, not per call. `normaliseStrategy` runs on every `deriveRunId` and `deriveRunId`
// runs in every hook, so a line per invocation would flood the ring log — and rotating it is
// the one way this warning could cost a hook its budget.
test('an unrecognised run strategy warns once per process, not once per derivation', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const env = envFor(dataDir, makeProjectDir({ git: true }), 'nonsense',
    { MUBIT_CC_LOG_LEVEL: 'warn' });

  derive(config, runid, env, fx.sessionStart());
  derive(config, runid, env, fx.postToolUse());
  derive(config, runid, env, fx.stop());

  assert.equal(logLines(dataDir).filter((l) => l.level === 'warn').length, 1,
    'three derivations in one process must produce one warning, not three');
});

// The ordinary case, and by far the common one: nothing set at all. `lib/config.mjs` resolves
// an unset `MUBIT_CC_RUN_STRATEGY` to `per-directory`, which is not a misconfiguration and
// must not be reported as one — a warning every session would train users to ignore the log.
test('an unset or blank run strategy is silent', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const projectDir = makeProjectDir({ git: true });

  for (const [name, value] of [['unset', undefined], ['blank', '   ']]) {
    const dataDir = makeDataDir();
    const env = baseEnv({
      dataDir,
      projectDir,
      extra: {
        MUBIT_CC_RUN_STRATEGY: /** @type {any} */ (value),
        MUBIT_CC_RUN_ID: undefined,
        MUBIT_CC_LOG_LEVEL: 'warn',
      },
    });

    derive(config, runid, env, fx.sessionStart());

    assert.deepEqual(logLines(dataDir).filter((l) => l.level === 'warn'), [],
      `an ${name} run strategy is the documented default, not a misconfiguration`);
  }
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

/*
 * §4.3, I5 — where the memory went.
 *
 * The reset above is defensible: `/clear` means "forget the thread", and a user who typed it
 * and then got the thread back would be right to complain. What is not defensible is that the
 * run it was cleared from left no trace anywhere — so a session that reset its project memory
 * by accident had nothing on disk pointing at what it lost, and no way to ask for it back.
 *
 * `previous_run_id` is data only. No route, no HTTP, nothing that has to exist yet: SC-09's
 * `/mubit-memory:link` is what consumes it, and it can be written and read long before that.
 */

// §4.3/I5: the record written on a clear names the run the session was in before it.
test('source=clear: the record names the run it was cleared from', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const env = envFor(dataDir, makeProjectDir({ git: true }), 'per-directory');

  const base = derive(config, runid, env, fx.sessionStart({ source: 'startup' }));
  const cleared = derive(config, runid, env, fx.sessionStart({ source: 'clear' }));

  const rec = readJsonFile(sessionFile(dataDir, fx.SESSION_ID));
  assert.equal(rec.run_id, cleared, 'the record must follow the new run');
  assert.equal(rec.previous_run_id, base,
    'without this the memory a /clear set aside is unreachable: nothing on disk relates the '
    + 'run the session is now in to the one it was in a moment ago');
});

// §4.3/I5: the pointer describes the *current* run's provenance, so a second clear points one
// step back and not all the way to the original. Otherwise `-c2` claims to have come from a
// run it did not come from, and reconnecting it would rejoin the wrong thread.
test('source=clear: a second clear points at the -c1 run, not the original', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const env = envFor(dataDir, makeProjectDir({ git: true }), 'per-directory');

  const base = derive(config, runid, env, fx.sessionStart({ source: 'startup' }));
  const cleared1 = derive(config, runid, env, fx.sessionStart({ source: 'clear' }));
  const cleared2 = derive(config, runid, env, fx.sessionStart({ source: 'clear' }));

  const rec = readJsonFile(sessionFile(dataDir, fx.SESSION_ID));
  assert.equal(rec.run_id, cleared2);
  assert.equal(rec.previous_run_id, cleared1,
    `-c2 came from ${cleared1}, not from ${base}; one step back is the only true answer`);
});

/*
 * The other half, and the one an implementation gets wrong by writing the field and stopping:
 * `rememberRun` spreads `...inherited`, so anything left in a record rides forward into every
 * later write for free. A `previous_run_id` that outlives the run it described is worse than
 * no field at all — it points a recovery command at a run this session never came from.
 */
test('source=startup/resume: no previous_run_id, and a clear\'s does not ride forward', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const env = envFor(dataDir, makeProjectDir({ git: true }), 'per-directory');
  const read = () => readJsonFile(sessionFile(dataDir, fx.SESSION_ID));

  const base = derive(config, runid, env, fx.sessionStart({ source: 'startup' }));
  assert.equal(read().previous_run_id ?? '', '',
    'startup deliberately discards the mapping; there is no run it "came from"');

  const cleared = derive(config, runid, env, fx.sessionStart({ source: 'clear' }));
  assert.equal(read().previous_run_id, base, 'the clear is what sets the pointer');

  // Back to a fresh derivation on the same host session id. The run moved for a reason that
  // is not a clear, so the stored pointer no longer describes the run the record names.
  assert.equal(derive(config, runid, env, fx.sessionStart({ source: 'startup' })), base);
  assert.equal(read().previous_run_id ?? '', '',
    `a startup back onto ${base} must not keep claiming it was cleared from ${cleared}`);

  // resume reuses the mapped run and says nothing new about where it came from.
  derive(config, runid, env, fx.sessionStart({ source: 'resume' }));
  assert.equal(read().previous_run_id ?? '', '', 'a resume is not a reset');
});

/*
 * Upgrade safety, the same property `project_root` documents for itself: a record written
 * before the field existed says nothing about where its run came from, and "unknown" must
 * read as unknown rather than as a broken record or a moved one.
 */
test('a session record written before previous_run_id existed reads as unknown', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const env = envFor(dataDir, makeProjectDir({ git: true }), 'per-directory');

  // Written raw rather than through `saveSessionMap`, which normalises and would stamp the
  // very field this test is about.
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  writeFileSync(sessionFile(dataDir, fx.SESSION_ID),
    JSON.stringify(record({ run_id: 'cc-upgraded-deadbeef' })));

  const loaded = withEnv(env, () => runid.loadSessionMap(fx.SESSION_ID));
  assert.equal('previous_run_id' in loaded, false,
    'the fixture is the §4.3 shape as it shipped, or this test proves nothing');

  assert.equal(derive(config, runid, env, fx.sessionStart({ source: 'resume' })),
    'cc-upgraded-deadbeef',
    'an unknown previous run is not a reason to move a live session to a new one');
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
// §4.3 — deriveSubRunId
// ===========================================================================

/**
 * Why a sub-run id exists at all, measured rather than assumed.
 *
 * A live fan-out of two subagents on Claude Code 2.1.235 produced two `SubagentStart`s and
 * two `SubagentStop`s that shared the parent's `session_id` **and** its `prompt_id`, and
 * differed only in `agent_id`. Every coordinate the plugin keys state on is therefore the
 * same for all siblings: `runs/<run_id>/turns/<prompt_id>.json` is one file that six
 * subagents all read as "their" turn. `agent_id` is the only thing that separates them, so
 * the run-scoped form of it is the only lane a subagent's own evidence can live in.
 */
test('deriveSubRunId(): <parent>-sub-<agentShort>, one lane per subagent', async () => {
  const runid = await lib('runid.mjs');
  const parent = 'cc-my-project-9f2a11c4';

  const a = runid.deriveSubRunId(parent, fx.subagentStart({ agent_id: 'ab55bb82d19855fbc' }));
  const b = runid.deriveSubRunId(parent, fx.subagentStart({ agent_id: 'a0a7d24f87136bee1' }));

  assert.ok(a.startsWith(`${parent}-sub-`), `"${a}" is not derivable from its parent`);
  assert.notEqual(a, b,
    'the two ids the live fan-out produced must not collapse — that collapse is the entire '
    + 'reason this function exists');
  assert.equal(runid.deriveSubRunId(parent, fx.subagentStart({ agent_id: 'ab55bb82d19855fbc' })), a,
    'SubagentStart and SubagentStop carry the same agent_id, so the same input must give the '
    + 'same lane on both events or nothing can ever be joined back up');
});

// A run id names a directory under the data dir. A sub-run id is a run id, so it inherits
// every restriction — including the one this whole module exists for.
test('deriveSubRunId(): the poisoned literal cannot be reached through the sub form', async () => {
  const runid = await lib('runid.mjs');

  assert.throws(() => runid.deriveSubRunId('default', fx.subagentStart()), /default/i,
    'a poisoned parent must not be laundered into a usable id by appending a suffix');
  assert.throws(() => runid.deriveSubRunId('', fx.subagentStart()),
    'an empty parent would resolve to a bare "-sub-…" directly under runs/');
  assert.doesNotMatch(runid.deriveSubRunId('cc-x-1', fx.subagentStart({ agent_id: '../../etc' })),
    /[\\/]|\.\./, 'agent_id arrives from outside the process and lands in a path');
});

// No subagent means nothing to isolate. Minting a suffix anyway would produce a lane that
// `SubagentStop` — which derives from the same missing field — could never find again.
test('deriveSubRunId(): a payload with no subagent identity answers with the parent', async () => {
  const runid = await lib('runid.mjs');
  const parent = 'cc-my-project-9f2a11c4';
  const anon = fx.subagentStart();
  delete anon.agent_id;

  assert.equal(runid.deriveSubRunId(parent, anon), parent);
  assert.equal(runid.deriveSubRunId(parent, {}), parent);
});

// Idempotent, because a caller holding an already-derived id is the normal case once more
// than one hook derives one. `cc-x-1-sub-ab-sub-ab` would be a second lane for one subagent.
test('deriveSubRunId(): deriving twice is deriving once', async () => {
  const runid = await lib('runid.mjs');
  const once = runid.deriveSubRunId('cc-x-1', fx.subagentStart());
  assert.equal(runid.deriveSubRunId(once, fx.subagentStart()), once);
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

// ===========================================================================
// §4.3 — one session that changes directory
// ===========================================================================

/*
 * `per-directory` is the default, and until now the directory it meant was the one the
 * session was *launched* in: `cfg.projectDir` is `CLAUDE_PROJECT_DIR`, which is fixed for
 * the life of the process, and every non-SessionStart hook took the reuse branch, which
 * validated the strategy and never the directory. A `cd` into another repo mid-session kept
 * writing the first repo's run — memory crossing projects by a different route than the
 * `session`-scope leak.
 *
 * Every hook payload has carried `cwd` from the start (`test/helpers/fixtures.mjs`). Nothing
 * read it. The cases below are the ones the existing suite could not fail on: the stability
 * test above deliberately uses separate data dirs AND separate session ids, so no session map
 * is in play at all, and that is exactly the file this bug lives in.
 */

test('per-directory: one session that cd\'s into another repo follows it', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const repoA = makeProjectDir({ git: true });
  const repoB = makeProjectDir({ git: true });
  // One data dir, one session id, and `CLAUDE_PROJECT_DIR` pinned to the launch repo — it
  // is the launch root and never moves, which is the whole reason the payload has to win.
  const env = envFor(dataDir, repoA, 'per-directory');

  const inA = derive(config, runid, env, fx.sessionStart({ cwd: repoA }));
  // No `source`: this is the reuse branch, which is where every hook after SessionStart goes.
  const inB = derive(config, runid, env, fx.postToolUse({ cwd: repoB }));

  assert.notEqual(inA, inB,
    'work done in repo B was written to repo A\'s run — the mid-session cwd drift');
  assert.match(inB, HASH8);

  const rec = readJsonFile(sessionFile(dataDir, fx.SESSION_ID));
  assert.equal(rec.run_id, inB, 'the session map must follow the session');
  assert.equal(rec.project_dir, repoB);
  // `git rev-parse --show-toplevel` resolves symlinks and the raw path does not (on macOS
  // every temp dir is one), so the two fields legitimately differ. That is the point of
  // recording the root separately: it is the value the run id is actually hashed from.
  assert.equal(rec.project_root, realpathSync(repoB),
    'the record carries the resolved git root, not the raw dir');
});

// The churn guard. `directoryRunId` resolves through `git rev-parse --show-toplevel`, so a
// `cd` *within* one repo must not move the run — otherwise every `cd src/` would fork the
// memory of the project it is inside.
test('per-directory: a cd within one repo keeps the same run', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const repo = makeProjectDir({ git: true });
  const deep = join(repo, 'src', 'service');
  mkdirSync(deep, { recursive: true });
  const env = envFor(dataDir, repo, 'per-directory');

  const atRoot = derive(config, runid, env, fx.sessionStart({ cwd: repo }));
  const inSub = derive(config, runid, env, fx.postToolUse({ cwd: deep }));

  assert.equal(inSub, atRoot, 'a subdirectory of the same repo is the same run');
});

// Upgrade safety. Every record written before `project_root` existed says nothing about
// where it was written, and "unknown" must not invalidate a mapping that is working: the
// alternative is that installing this version moves every live session to a new run.
test('a session record with no project_root is still reused', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const env = envFor(dataDir, makeProjectDir({ git: true }), 'per-directory');

  // `record()` is the §4.3 shape as it shipped: `project_dir`, no `project_root`.
  withEnv(env, () => runid.saveSessionMap(fx.SESSION_ID, record({ run_id: 'cc-upgraded-deadbeef' })));
  const id = derive(config, runid, env, fx.postToolUse({ cwd: makeProjectDir({ git: true }) }));

  assert.equal(id, 'cc-upgraded-deadbeef',
    'an unknown root is not a mismatch; the next write stamps it');
});

/*
 * `deriveRunId(cfg, {})` is the shape `mcp/src/launch.mjs` and `bin/statusline.src.mjs` pass
 * deliberately — an empty payload, so the derivation takes the "no host session id" path and
 * never writes a `SessionRecord`. It has no `cwd` either, so it must keep answering from
 * `CLAUDE_PROJECT_DIR` exactly as before, whatever the session has since done.
 */
test('deriveRunId(cfg, {}) still answers from CLAUDE_PROJECT_DIR after the session moved', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const repoA = makeProjectDir({ git: true });
  const repoB = makeProjectDir({ git: true });
  const env = envFor(dataDir, repoA, 'per-directory');

  const inA = derive(config, runid, env, fx.sessionStart({ cwd: repoA }));
  const bare = withEnv(env, () => runid.deriveRunId(config.loadConfig(env), {}));
  assert.equal(bare, inA);

  derive(config, runid, env, fx.postToolUse({ cwd: repoB }));

  assert.equal(withEnv(env, () => runid.deriveRunId(config.loadConfig(env), {})), bare,
    'the empty-payload derivation is the launcher\'s and the status line\'s; it may not move');
});

// ===========================================================================
// §6 Tier 2 — the origin remote, cached on the record
// ===========================================================================

/*
 * SCOPE.md §6 measured the signal that partitions projects the way a human would: six
 * directories, six run ids, two git remotes, two groups. Tier 2 proposes a link the first
 * time a second checkout of one repository shows up, and `SessionStart` is where it has to
 * notice — which is the one place that cannot afford to ask.
 *
 * `git remote get-url origin` per candidate would be a process spawn per project in the
 * session map, on the spawn path, inside the 400/600/900 ms sub-budgets, measured on a cold
 * FS. So the remote is resolved once and stored, exactly as `project_root` is and for exactly
 * the reason its own comment gives: the reader should not have to work it out, and the reader
 * here is a hook with a deadline.
 */

/** The origin `makeProjectDir({remote})` sets, and what `git config --get` must report back. */
const ORIGIN = 'git@github.com:acme/storefront.git';

// §6 Tier 2: without this field the offer has nothing to match on but a shell-out per session.
test('the session record caches the repo origin the run was derived from', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const repo = makeProjectDir({ git: true, remote: ORIGIN });
  const env = envFor(dataDir, repo, 'per-directory');

  derive(config, runid, env, fx.sessionStart({ cwd: repo }));

  const rec = readJsonFile(sessionFile(dataDir, fx.SESSION_ID));
  assert.equal(rec.git_remote, ORIGIN,
    'the record must carry this project\'s origin, or the Tier 2 offer can only get it by '
    + 'spawning git once per candidate on every SessionStart');
});

/*
 * The caching itself, asserted rather than inferred from a stopwatch. A budget test on a warm
 * FS passes happily while the shell-out is still there; this one cannot, because the value on
 * the record and the value `git` would report are deliberately different. If the write
 * re-resolves, the sentinel is gone and the live origin is in its place.
 */
test('a remote already on the record is inherited, not resolved again', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const repo = makeProjectDir({ git: true, remote: ORIGIN });
  const env = envFor(dataDir, repo, 'per-directory');

  // A first session stamps the record; the run id and the root are then whatever this
  // machine derives, which is what the reuse branch has to agree with.
  const runId = derive(config, runid, env, fx.sessionStart({ cwd: repo }));
  const stamped = readJsonFile(sessionFile(dataDir, fx.SESSION_ID));
  assert.equal(stamped.git_remote, ORIGIN,
    'the first write is what there is to inherit; with nothing on the record the sentinel '
    + 'below survives because nobody ever writes the field, which proves nothing');
  withEnv(env, () => runid.saveSessionMap(fx.SESSION_ID, {
    ...stamped,
    git_remote: 'git@github.com:acme/cached-not-resolved.git',
    // Older than TOUCH_INTERVAL_MS, so the next hook actually rewrites the file. Without
    // this the record is left alone and the assertion below passes for the wrong reason.
    last_seen_at: Date.now() - (5 * 60 * 1000),
  }));

  // No `source`: the branch every hook after SessionStart takes.
  assert.equal(derive(config, runid, env, fx.postToolUse({ cwd: repo })), runId,
    'the reuse branch is the one under test; a moved run would mean a different write path');

  const rec = readJsonFile(sessionFile(dataDir, fx.SESSION_ID));
  assert.equal(rec.git_remote, 'git@github.com:acme/cached-not-resolved.git',
    `a record that already knows the remote must not spawn git again — got ${rec.git_remote}, `
    + `which is what "git config --get remote.origin.url" answers in ${repo}`);
});

// The invalidation rule, and the only one there is: the cache is about a root, so a session
// that moves to another repo must not carry the first repo's remote into the second's record.
// Without this a mid-session `cd` would group two unrelated repositories forever.
test('a session that moves to another repo re-resolves the remote', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const repoA = makeProjectDir({ git: true, remote: ORIGIN });
  const repoB = makeProjectDir({ git: true, remote: 'git@github.com:acme/pricing.git' });
  const env = envFor(dataDir, repoA, 'per-directory');

  derive(config, runid, env, fx.sessionStart({ cwd: repoA }));
  derive(config, runid, env, fx.postToolUse({ cwd: repoB }));

  const rec = readJsonFile(sessionFile(dataDir, fx.SESSION_ID));
  assert.equal(rec.git_remote, 'git@github.com:acme/pricing.git',
    'the cached remote belongs to the recorded root; carrying A\'s origin into B\'s record '
    + 'would make two unrelated repositories look like one group');
});

// Upgrade safety, the property `project_root` documents for itself. A record written before
// the field existed says nothing about the remote, and "unknown" must read as "resolve it",
// never as "this project has no remote" — which would silently disable the offer for every
// session already on disk.
test('a session record with no git_remote is stamped with one on the next write', async () => {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const dataDir = makeDataDir();
  const repo = makeProjectDir({ git: true, remote: ORIGIN });
  const env = envFor(dataDir, repo, 'per-directory');

  // `record()` is the §4.3 shape as it shipped: no `git_remote` key at all.
  withEnv(env, () => runid.saveSessionMap(fx.SESSION_ID, record({
    run_id: 'cc-upgraded-deadbeef', project_dir: repo, project_root: realpathSync(repo),
  })));
  derive(config, runid, env, fx.postToolUse({ cwd: repo }));

  const rec = readJsonFile(sessionFile(dataDir, fx.SESSION_ID));
  assert.equal(rec.git_remote, ORIGIN,
    'an absent field is unknown, not empty; leaving it empty would keep every pre-upgrade '
    + 'session out of the Tier 2 offer for as long as it lives');
});
