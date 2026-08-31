// @ts-check
/**
 * `hooks/src/cwd-changed.mjs` — CwdChanged, the run-id follower.
 *
 * `per-directory` is the default run strategy and the run id is derived from a directory. A
 * `cd` into another repo mid-session used to keep writing the first repo's run: the derivation
 * read `CLAUDE_PROJECT_DIR`, which is the session's *launch* root and fixed for the life of
 * the process, and every hook after SessionStart took the reuse branch, which validated the
 * strategy and never the directory. `lib/runid.mjs` now reads `payload.cwd`; this hook is the
 * other half — the one that notices the move at the moment it happens, so the run the session
 * is leaving is drained instead of orphaned.
 *
 * Three host facts this file is written against, all established against the shipping host
 * (2.1.235) rather than taken from the docs:
 *
 *   1. `CwdChanged` passes the output schema's validation but is then **never acted on** — it
 *      has no `hookSpecificOutput` channel at all, the same class as `PreCompact` and
 *      `SessionEnd`. Every path here returns `{suppressOutput: true}`.
 *   2. The payload names are `old_cwd` and `new_cwd`, not `previous_cwd`.
 *   3. It supports no matcher at all, and it fires *after* the change, so it cannot block.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  runHook, assertHookContract, fakeMubit, baseEnv, lib, makeDataDir, makeProjectDir,
  readJsonFile, tempDir, withEnv,
} from './helpers/harness.mjs';
import { cwdChanged, spoolItem, SESSION_ID } from './helpers/fixtures.mjs';

// ---------------------------------------------------------------------------
// The detached-spawn spy — same shape as `test/stage-prompt.test.mjs`
// ---------------------------------------------------------------------------

const SCRATCH = tempDir('mubit-cc-cwd-');
const SPY = join(SCRATCH, 'spawn-spy.cjs');
writeFileSync(SPY, `const fs = require('node:fs');
const out = process.env.MUBIT_TEST_SPY_FILE;
if (out) {
  try {
    fs.appendFileSync(out, JSON.stringify({
      argv: process.argv.slice(1),
      detached: process.env.MUBIT_CC_DETACHED || '',
      at: Date.now(),
    }) + '\\n');
  } catch {}
}
`);

function spyLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function drainSpawns(file) {
  return spyLines(file).filter((l) => basename(String(l.argv?.[0] ?? '')) === 'drain.mjs');
}

function withSpy(env) {
  const file = join(SCRATCH, `spy-${randomUUID()}.jsonl`);
  return { file, env: { ...env, NODE_OPTIONS: `--require ${SPY}`, MUBIT_TEST_SPY_FILE: file } };
}

async function waitForSpawn(file, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = drainSpawns(file);
    if (s.length) return s;
    if (Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** `per-directory` — the default, and the only strategy a `cd` can move. */
function envFor(dataDir, projectDir, server, extra = {}) {
  return baseEnv({
    dataDir,
    endpoint: server.url,
    projectDir,
    extra: { MUBIT_CC_RUN_STRATEGY: 'per-directory', MUBIT_CC_RUN_ID: undefined, ...extra },
  });
}

/**
 * The run id `lib/runid.mjs` derives for a directory, computed through the module itself
 * rather than restated — restating `cc-<slug>-<hash8>` here would make this file agree with
 * a broken derivation. A throwaway data dir, so the empty payload cannot touch the session
 * map under test.
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function runIdFor(dir) {
  const config = await lib('config.mjs');
  const runid = await lib('runid.mjs');
  const env = baseEnv({ dataDir: makeDataDir(), projectDir: dir });
  return withEnv(env, () => runid.deriveRunId(config.loadConfig(env), {}));
}

/** The §4.3 `SessionRecord` this session would be carrying before the `cd`. */
async function seedSessionMap(env, runId, projectDir) {
  const runid = await lib('runid.mjs');
  const now = Date.now();
  withEnv(env, () => runid.saveSessionMap(SESSION_ID, {
    run_id: runId,
    agent_id: 'claude-code',
    strategy: 'per-directory',
    project_dir: projectDir,
    project_root: projectDir,
    created_at: now,
    last_seen_at: now,
    mode: 'local',
    clear_count: 0,
    endpoint_hash: '',
  }));
}

const sessionPath = (dataDir) => join(dataDir, 'sessions', `${SESSION_ID}.json`);
const markerPath = (dataDir, runId) => join(dataDir, 'status', `${runId}.json`);
const runDir = (dataDir, runId) => join(dataDir, 'runs', runId);

/** Something for the leaving run to have left behind. */
function seedSpool(dataDir, runId, n = 2) {
  const dir = join(runDir(dataDir, runId), 'spool');
  mkdirSync(dir, { recursive: true });
  const base = Date.now() - 5000;
  for (let i = 0; i < n; i++) {
    const ts = base + i;
    const p = join(dir, `${ts}-${String(i).padStart(6, '0')}.json`);
    writeFileSync(p, JSON.stringify(spoolItem({ item_id: `cc-left-behind-${i}` })));
    utimesSync(p, ts / 1000, ts / 1000);
  }
}

/**
 * Hold the leaving run's drain lock, so the drain this hook spawns records its argv and then
 * stands down without dialling anything.
 */
function holdDrainLock(dataDir, runId) {
  mkdirSync(runDir(dataDir, runId), { recursive: true });
  writeFileSync(join(runDir(dataDir, runId), 'drain.lock'),
    JSON.stringify({ pid: process.pid, ts: Date.now() }));
}

/**
 * A fake Mubit whose listening socket is closed even when the test fails — otherwise an open
 * handle keeps the test process alive and the whole run hangs.
 * @param {any} t @param {any} [routes]
 */
async function mubit(t, routes) {
  const server = await fakeMubit(routes);
  t.after(() => server.close());
  return server;
}

/** One session that has been working in `repoA` and is about to `cd` into `repoB`. */
async function scenario(t, extra = {}) {
  const server = await mubit(t);
  const dataDir = makeDataDir();
  const repoA = makeProjectDir({ git: true });
  const repoB = makeProjectDir({ git: true });
  const runA = await runIdFor(repoA);
  const runB = await runIdFor(repoB);
  // `CLAUDE_PROJECT_DIR` stays on the launch repo for the life of the process. That it does
  // not move is exactly why the payload has to be read.
  const env = envFor(dataDir, repoA, server, extra);
  await seedSessionMap(env, runA, repoA);
  return { server, dataDir, repoA, repoB, runA, runB, env };
}

// ---------------------------------------------------------------------------
// The output contract
// ---------------------------------------------------------------------------

// Host fact 1: `CwdChanged` validates but never reaches the dispatch switch, so anything it
// put in `hookSpecificOutput` would be accepted and then discarded in silence.
test('cwd-changed: emits exactly {suppressOutput: true}', async (t) => {
  const s = await scenario(t);
  const r = await runHook('cwd-changed',
    cwdChanged({ old_cwd: s.repoA, new_cwd: s.repoB, cwd: s.repoB }), { env: s.env });

  assertHookContract(r);
  assert.deepEqual(r.json, { suppressOutput: true });
  assert.equal('hookSpecificOutput' in (r.json ?? {}), false,
    'CwdChanged has no hookSpecificOutput channel — the host validates it and then ignores it');
});

// ---------------------------------------------------------------------------
// A `cd` that does not move the run
// ---------------------------------------------------------------------------

/*
 * The churn guard, and the reason this hook checks rather than acts. `directoryRunId`
 * resolves through `git rev-parse --show-toplevel`, so `cd src/` is the same run — and a
 * hook that drained and remapped on every `cd` would spend a process on each one.
 */
test('cwd-changed: a cd within one repo remaps nothing and spawns nothing', async (t) => {
  const s = await scenario(t);
  const deep = join(s.repoA, 'src', 'service');
  mkdirSync(deep, { recursive: true });
  seedSpool(s.dataDir, s.runA);
  const { env, file } = withSpy(s.env);

  const r = await runHook('cwd-changed',
    cwdChanged({ old_cwd: s.repoA, new_cwd: deep, cwd: deep }), { env });
  assertHookContract(r);
  assert.deepEqual(r.json, { suppressOutput: true });
  await new Promise((res) => setTimeout(res, 250));

  assert.equal(readJsonFile(sessionPath(s.dataDir)).run_id, s.runA,
    'a subdirectory of the same repo is the same run; the mapping must not move');
  assert.equal(drainSpawns(file).length, 0, 'nothing was left behind, so nothing to drain');
  assert.equal(s.server.requests.length, 0,
    `cwd-changed is local bookkeeping; saw ${s.server.summary()}`);
});

// ---------------------------------------------------------------------------
// A `cd` into another repo
// ---------------------------------------------------------------------------

test('cwd-changed: a cd into another repo rewrites the session map to the new run', async (t) => {
  const s = await scenario(t);
  const r = await runHook('cwd-changed',
    cwdChanged({ old_cwd: s.repoA, new_cwd: s.repoB, cwd: s.repoB }), { env: s.env });
  assertHookContract(r);

  const rec = readJsonFile(sessionPath(s.dataDir));
  assert.notEqual(s.runA, s.runB, 'two repos must derive two runs, or this test proves nothing');
  assert.equal(rec.run_id, s.runB,
    'work done after the cd belongs to the new repo\'s run, not the one the session launched in');
  assert.equal(rec.project_dir, s.repoB);
  assert.equal(rec.strategy, 'per-directory');
});

/*
 * `hooks/src/session-end.mjs` and `hooks/src/drain.mjs` each scope to exactly one run and
 * nothing sweeps `runs/`. Moving the id without draining would leave repo A's spool for
 * `pruneStale` to delete 24 hours later — captured work, silently discarded.
 *
 * The `--run` pin is what makes this honest: the detached child would otherwise re-derive
 * through the very session map this hook has just rewritten, and drain the run it is
 * supposed to be leaving alone.
 */
test('cwd-changed: spawns exactly one detached drain, pinned to the run being left', async (t) => {
  const s = await scenario(t);
  seedSpool(s.dataDir, s.runA);
  holdDrainLock(s.dataDir, s.runA);
  const { env, file } = withSpy(s.env);

  assertHookContract(await runHook('cwd-changed',
    cwdChanged({ old_cwd: s.repoA, new_cwd: s.repoB, cwd: s.repoB }), { env }));

  const spawns = await waitForSpawn(file);
  assert.equal(spawns.length, 1, 'one drain, for the run being left');
  assert.equal(spawns[0].detached, '1');
  const argv = spawns[0].argv.map(String);
  assert.ok(argv.includes('--run'), `the drain must be pinned: ${argv.join(' ')}`);
  assert.equal(argv[argv.indexOf('--run') + 1], s.runA,
    'pinned to the run being LEFT — the new one has nothing spooled yet');
});

/*
 * `bin/statusline.src.mjs` follows the session map on every frame and renders `''` until the
 * marker it names has been written (`updated_at > 0`). Without this the status line would go
 * blank on every `cd` until the next hook happened to stamp one.
 */
test('cwd-changed: writes a marker for the new run', async (t) => {
  const s = await scenario(t);
  assertHookContract(await runHook('cwd-changed',
    cwdChanged({ old_cwd: s.repoA, new_cwd: s.repoB, cwd: s.repoB }), { env: s.env }));

  const p = markerPath(s.dataDir, s.runB);
  assert.equal(existsSync(p), true, `no marker at ${p} — the status line renders '' without one`);
  const marker = readJsonFile(p);
  assert.equal(marker.run_id, s.runB);
  assert.ok(marker.updated_at > 0, 'the status line reads updated_at as "has anything run here"');
});

// ---------------------------------------------------------------------------
// §4.9 — failure costs the memory, never the turn
// ---------------------------------------------------------------------------

test('cwd-changed: exits 0 with valid JSON when the data dir is unwritable', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root: permissions are unenforceable');
    return;
  }
  const s = await scenario(t);
  const before = statSync(s.dataDir).mode;
  chmodSync(s.dataDir, 0o555);
  try {
    const r = await runHook('cwd-changed',
      cwdChanged({ old_cwd: s.repoA, new_cwd: s.repoB, cwd: s.repoB }), { env: s.env });
    assertHookContract(r);
    assert.deepEqual(r.json, { suppressOutput: true });
  } finally {
    chmodSync(s.dataDir, before);
  }
});

// A payload with no session id has no mapping to move. Deriving one anyway would write a
// `SessionRecord` under a name nothing else will ever look up.
test('cwd-changed: does nothing when the payload carries no session id', async (t) => {
  const s = await scenario(t);
  const { env, file } = withSpy(s.env);
  const r = await runHook('cwd-changed',
    cwdChanged({ old_cwd: s.repoA, new_cwd: s.repoB, cwd: s.repoB, session_id: '' }), { env });

  assertHookContract(r);
  assert.deepEqual(r.json, { suppressOutput: true });
  await new Promise((res) => setTimeout(res, 250));
  assert.equal(drainSpawns(file).length, 0);
  assert.equal(readJsonFile(sessionPath(s.dataDir)).run_id, s.runA, 'the mapping is untouched');
});
