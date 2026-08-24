// @ts-check
/**
 * `lib/actor.mjs` — the actor id nobody has to type.
 *
 * The regression this whole module is shaped around lives in `capture.test.mjs`, not here:
 * an actor must reach the wire in `metadata_json` and **never** in `user_id`. Server-side
 * `user_id` is a retrieval *scope* that is enforced as a filter on query, and `lib/recall.mjs`
 * never sends one — so stamping a detected login into `user_id` would make every newly
 * captured entry invisible to the recall that is supposed to find it.
 *
 * What this file protects:
 *   - the ladder, one test per rung, each proving its rung wins once the rungs above it
 *     are gone. A rung that quietly never fires is a rung that is not there.
 *   - `${dataDir}/actor.json`: hit, miss, and a record past its 30-day TTL.
 *   - totality (§4.9). No `git` on PATH, a directory that is not a repo, a data dir that
 *     cannot be read or written: every one of them is `''`, and none of them throws. The
 *     callers are `capture` (every tool call) and `drain`; neither may ever fail for this.
 *
 * `resolveActor` shells out, so every test pins the git environment as well as the process
 * environment: `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`/`HOME`/`XDG_CONFIG_HOME` all point
 * somewhere empty, or the developer's own `~/.gitconfig` decides the result.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { lib, makeDataDir, makeProjectDir, tempDir, withEnv } from './helpers/harness.mjs';

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * An environment in which git can see nothing but the repo's own `.git/config`.
 * Without this the answer depends on whoever is running the suite.
 * @param {string} dataDir
 * @param {Record<string,string|undefined>} [extra]
 * @returns {Record<string,string|undefined>}
 */
function gitJail(dataDir, extra = {}) {
  return {
    HOME: dataDir,
    XDG_CONFIG_HOME: join(dataDir, 'xdg'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    // The two `GIT_CONFIG_*` paths above need git >= 2.32; `HOME`, `XDG_CONFIG_HOME` and
    // `GIT_CONFIG_NOSYSTEM` cover every git that predates them, so the isolation does not
    // depend on the version of git a contributor happens to have.
    GIT_CONFIG_NOSYSTEM: '1',
    // Only the junk-cfg rows can reach these — every other test passes `cfg.dataDir`, which
    // `resolveDataDir` prefers — but a developer's exported data dir must never be written
    // to by a test either way.
    MUBIT_CC_DATA_DIR: undefined,
    CLAUDE_PLUGIN_DATA: undefined,
    // The §W1 rung-5 inputs. Deleted unless a row asks for them, so a developer's shell
    // cannot supply the answer a test is meant to be proving.
    USER: undefined,
    USERNAME: undefined,
    LOGNAME: undefined,
    ...extra,
  };
}

/** @param {string} dir @param {string[]} args */
function gitIn(dir, args) {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'ignore' });
}

/**
 * A repo carrying exactly the config keys named and no others — `makeProjectDir({git:true})`
 * seeds `user.email` and `user.name`, and a rung test that left them in place would be
 * testing the rung above it.
 * @param {Record<string,string>} [keys]
 * @returns {string}
 */
function repoWith(keys = {}) {
  const dir = makeProjectDir({ git: true });
  for (const k of ['github.user', 'user.email', 'user.name']) {
    gitIn(dir, ['config', '--local', '--unset-all', k]);
  }
  for (const [k, v] of Object.entries(keys)) gitIn(dir, ['config', '--local', k, v]);
  return dir;
}

const cachePath = (dataDir) => join(dataDir, 'actor.json');

/** @param {string} dataDir @param {any} record */
function seedCache(dataDir, record) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(cachePath(dataDir), JSON.stringify(record));
}

// ===========================================================================
// The ladder — one row per rung
// ===========================================================================

/**
 * Cheapest rung first. Every row keeps the rungs *below* it populated too, so a row only
 * passes when its own rung actually outranks them — an implementation that fell straight
 * through to `$USER` would fail rows 1-4 rather than accidentally passing them.
 *
 * `gh api user` is deliberately absent: it is a process spawn *and* a network round trip,
 * which has no place on any path a blocking hook can reach.
 */
const LADDER = [
  {
    rung: 1,
    what: 'cfg.actorId (MUBIT_CC_ACTOR_ID)',
    git: { 'github.user': 'gh-login', 'user.email': 'ada@example.com', 'user.name': 'Ada Lovelace' },
    env: { USER: 'shell-login' },
    cfg: { actorId: 'explicit-actor' },
    want: 'explicit-actor',
  },
  {
    rung: 2,
    what: 'git config --get github.user',
    git: { 'github.user': 'gh-login', 'user.email': 'ada@example.com', 'user.name': 'Ada Lovelace' },
    env: { USER: 'shell-login' },
    cfg: {},
    want: 'gh-login',
  },
  {
    rung: 3,
    what: 'git config --get user.email, local-part only',
    git: { 'user.email': 'ada@example.com', 'user.name': 'Ada Lovelace' },
    env: { USER: 'shell-login' },
    cfg: {},
    want: 'ada',
  },
  {
    rung: 4,
    what: 'git config --get user.name, sanitised',
    git: { 'user.name': 'Ada  Lovelace' },
    env: { USER: 'shell-login' },
    cfg: {},
    want: 'Ada-Lovelace',
  },
  {
    rung: 5,
    what: '$USER',
    // Still a real repo, so the `hasGitDir` guard passes and rungs 2-4 genuinely run and
    // genuinely find nothing. A row that used a bare directory would prove only the guard.
    git: {},
    env: { USER: 'shell-login' },
    cfg: {},
    want: 'shell-login',
  },
];

for (const row of LADDER) {
  test(`resolveActor: rung ${row.rung} — ${row.what}`, async () => {
    const actor = await lib('actor.mjs');
    const dataDir = makeDataDir();
    const projectDir = repoWith(row.git);

    const got = withEnv(gitJail(dataDir, row.env),
      () => actor.resolveActor({ dataDir, ...row.cfg }, projectDir));

    assert.equal(got, row.want, `rung ${row.rung} did not win`);
    // Whatever the ladder answered is what the hot path must see afterwards.
    assert.equal(withEnv(gitJail(dataDir, row.env), () => actor.readActor({ dataDir, ...row.cfg })),
      row.want, `rung ${row.rung} resolved but was not cached for readActor`);
  });
}

// §W1 rung 5 names three variables because the three shells in use do not agree on one.
test('resolveActor: rung 5 accepts USERNAME and LOGNAME as well as USER', async () => {
  const actor = await lib('actor.mjs');
  const projectDir = repoWith({});

  for (const name of ['USER', 'USERNAME', 'LOGNAME']) {
    const dataDir = makeDataDir();
    const got = withEnv(gitJail(dataDir, { [name]: `via-${name}` }),
      () => actor.resolveActor({ dataDir }, projectDir));
    assert.equal(got, `via-${name}`, `$${name} is a rung-5 input`);
  }
});

// ===========================================================================
// ${dataDir}/actor.json — the cache the hot path reads
// ===========================================================================

// `capture` runs on every tool call and may not spawn anything, so `readActor` is a file
// read and nothing else. This is the whole reason the module has two exports.
test('readActor: a fresh cached record is returned verbatim', async () => {
  const actor = await lib('actor.mjs');
  const dataDir = makeDataDir();
  seedCache(dataDir, { v: 1, at: Date.now(), actor: 'cached-one', source: 'git-email' });

  assert.equal(withEnv(gitJail(dataDir), () => actor.readActor({ dataDir })), 'cached-one');
});

test('readActor: no cache file at all is "" and not a throw', async () => {
  const actor = await lib('actor.mjs');
  const dataDir = makeDataDir();
  assert.equal(withEnv(gitJail(dataDir), () => actor.readActor({ dataDir })), '');
});

// 30 days. A record past it is a miss, exactly as if it had never been written — a machine
// that changes hands must not keep attributing work to whoever set it up.
test('readActor: a record older than the 30-day TTL is a miss', async () => {
  const actor = await lib('actor.mjs');
  const dataDir = makeDataDir();
  seedCache(dataDir, { v: 1, at: Date.now() - (31 * DAY), actor: 'stale-one', source: 'git-email' });

  assert.equal(withEnv(gitJail(dataDir), () => actor.readActor({ dataDir })), '');
});

test('readActor: a corrupt, wrong-version or empty record is a miss, never a throw', async () => {
  const actor = await lib('actor.mjs');
  for (const record of [
    'not json at all',
    JSON.stringify([1, 2, 3]),
    JSON.stringify({ v: 99, at: Date.now(), actor: 'from-the-future' }),
    JSON.stringify({ v: 1, actor: 'no-timestamp' }),
    JSON.stringify({ v: 1, at: 'soon', actor: 'bad-timestamp' }),
    JSON.stringify({ v: 1, at: Date.now(), actor: '' }),
    JSON.stringify({ v: 1, at: Date.now() }),
    '',
  ]) {
    const dataDir = makeDataDir();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(cachePath(dataDir), record);
    assert.equal(withEnv(gitJail(dataDir), () => actor.readActor({ dataDir })), '',
      `a record of ${JSON.stringify(record.slice(0, 40))} must be a miss`);
  }
});

// The point of the cache: a hit costs no subprocess. Proven by taking `git` away entirely —
// a fall-through to the ladder would answer '' here, not the cached value.
test('resolveActor: a cache hit answers without shelling out', async () => {
  const actor = await lib('actor.mjs');
  const dataDir = makeDataDir();
  const projectDir = repoWith({ 'user.email': 'test@example.com' });
  seedCache(dataDir, { v: 1, at: Date.now(), actor: 'cached-one', source: 'git-email' });

  const got = withEnv(gitJail(dataDir, { PATH: '' }),
    () => actor.resolveActor({ dataDir }, projectDir));
  assert.equal(got, 'cached-one', 'a fresh cache must short-circuit the whole ladder');
});

test('resolveActor: an expired record is re-detected and rewritten', async () => {
  const actor = await lib('actor.mjs');
  const dataDir = makeDataDir();
  const projectDir = repoWith({ 'user.email': 'ada@example.com' });
  seedCache(dataDir, { v: 1, at: Date.now() - (31 * DAY), actor: 'stale-one', source: 'git-email' });

  const got = withEnv(gitJail(dataDir), () => actor.resolveActor({ dataDir }, projectDir));
  assert.equal(got, 'ada');
  assert.equal(withEnv(gitJail(dataDir), () => actor.readActor({ dataDir })), 'ada',
    'the refreshed value must land in the cache the hot path reads');
});

// `cfg.actorId` outranks the cache as well as the ladder: the setting is the user saying
// who they are, and it must not wait out a 30-day TTL written before they said it.
test('resolveActor: cfg.actorId overrides a cached value and replaces it', async () => {
  const actor = await lib('actor.mjs');
  const dataDir = makeDataDir();
  const projectDir = repoWith({ 'user.email': 'ada@example.com' });
  seedCache(dataDir, { v: 1, at: Date.now(), actor: 'cached-one', source: 'git-email' });

  const got = withEnv(gitJail(dataDir), () => actor.resolveActor({ dataDir, actorId: 'ada-explicit' }, projectDir));
  assert.equal(got, 'ada-explicit');
  assert.equal(withEnv(gitJail(dataDir), () => actor.readActor({ dataDir })), 'ada-explicit');
});

// ===========================================================================
// §4.9 totality — every failure costs the actor and nothing else
// ===========================================================================

test('resolveActor: no git on PATH is "" and never a throw', async () => {
  const actor = await lib('actor.mjs');
  const dataDir = makeDataDir();
  const projectDir = repoWith({ 'user.email': 'ada@example.com' });

  const got = withEnv(gitJail(dataDir, { PATH: '' }),
    () => actor.resolveActor({ dataDir }, projectDir));
  assert.equal(got, '', 'a machine with no git falls through the ladder, it does not fail');
});

// The `hasGitDir` guard from `lib/config.mjs`: a spawn per hook is not free, so git is only
// ever run inside something that is actually a repo.
test('resolveActor: a directory that is not a repo is "" and never a throw', async () => {
  const actor = await lib('actor.mjs');
  const dataDir = makeDataDir();
  const projectDir = tempDir('mubit-cc-norepo-');

  assert.equal(withEnv(gitJail(dataDir), () => actor.resolveActor({ dataDir }, projectDir)), '');
});

test('resolveActor: a missing or nonsense project dir is "" and never a throw', async () => {
  const actor = await lib('actor.mjs');
  const dataDir = makeDataDir();

  for (const dir of ['', '/nope/not/here', undefined, null, 42, {}]) {
    assert.equal(withEnv(gitJail(dataDir), () => actor.resolveActor({ dataDir }, /** @type {any} */ (dir))), '',
      `projectDir ${JSON.stringify(dir)} must be "" rather than a throw`);
  }
});

// An unwritable data dir costs the cache, never the drain — the same contract
// `writeHealthCache` keeps in `lib/http.mjs`.
test('resolveActor: an unwritable data dir still returns the detected actor', async () => {
  const actor = await lib('actor.mjs');
  // A *file* where the data dir should be: `mkdirSync` under it is ENOTDIR for any uid,
  // where a chmod-based test would quietly pass as root.
  const blocked = join(tempDir('mubit-cc-blocked-'), 'not-a-dir');
  writeFileSync(blocked, 'x');
  const projectDir = repoWith({ 'user.email': 'ada@example.com' });

  const got = withEnv(gitJail(makeDataDir()),
    () => actor.resolveActor({ dataDir: blocked }, projectDir));
  assert.equal(got, 'ada', 'detection succeeded; only the cache write failed');
  assert.equal(withEnv(gitJail(makeDataDir()), () => actor.readActor({ dataDir: blocked })), '',
    'an unreadable cache is a miss');
});

test('readActor / resolveActor: a junk cfg is "" and never a throw', async () => {
  const actor = await lib('actor.mjs');
  const projectDir = repoWith({});

  for (const cfg of [undefined, null, '', 0, [], { dataDir: 42 }, { actorId: 42 }]) {
    assert.doesNotThrow(() => withEnv(gitJail(makeDataDir(), { HOME: makeDataDir() }),
      () => actor.readActor(/** @type {any} */ (cfg))));
    assert.doesNotThrow(() => withEnv(gitJail(makeDataDir(), { HOME: makeDataDir() }),
      () => actor.resolveActor(/** @type {any} */ (cfg), projectDir)));
  }
});

// A login is a label on a memory, not a payload. Anything long, multi-line or colon-bearing
// would break `TYPE:NAME` readers downstream and bloat every item it rides on.
test('resolveActor: the answer is trimmed, single-line and bounded', async () => {
  const actor = await lib('actor.mjs');
  const dataDir = makeDataDir();
  const projectDir = repoWith({});
  const huge = 'x'.repeat(500);

  const got = withEnv(gitJail(dataDir, { USER: ` ${huge} ` }),
    () => actor.resolveActor({ dataDir }, projectDir));
  assert.ok(got.length > 0 && got.length <= 64, `unbounded actor id: ${got.length} chars`);
  assert.ok(!/\s/.test(got), `an actor id must not carry whitespace: ${JSON.stringify(got)}`);
});
