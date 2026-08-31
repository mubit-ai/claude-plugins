// @ts-check
/**
 * The committed `bin/dashboard.mjs` — what the Codex `dashboard` skill actually runs.
 *
 * Same reasoning as `codex-auth.test.mjs`: the behaviour lives in the sibling's shared
 * source and is tested there; what had zero coverage is this artifact. The lifecycle is
 * exercised the only honest way — a real detached process — because `--serve` writes a
 * state file naming its own pid and `--stop` kills that pid; run in-process, a passing
 * test and a killed test runner look identical.
 *
 * Three properties matter to the manual guide this mirrors: the state file
 * (`dashboard/server.json`) is owner-only, the API answers nothing without the bearer
 * token it holds, and `--stop` through the same bundle actually takes the server down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { CODEX_ROOT, baseEnv, fakeMubit, makeDataDir } from './helpers/codex-fixtures.mjs';
import { lib, mod } from '../../claude-code/test/helpers/harness.mjs';

const BUNDLE = join(CODEX_ROOT, 'bin', 'dashboard.mjs');

test('the bundle exists and stays inert on import', async () => {
  assert.ok(existsSync(BUNDLE), 'the committed bundle is what ships; it must be there');
  const m = await import(`file://${BUNDLE}?codex-dashboard-guard=1`);
  assert.equal(typeof m.main, 'function',
    'importing must expose main() without running it — the entry guard');
});

test('lifecycle: detached --serve, owner-only state, token-gated API, --stop', async (t) => {
  const upstream = await fakeMubit();
  t.after(() => upstream.close());
  const dataDir = makeDataDir();
  const env = baseEnv({ dataDir, endpoint: upstream.url });
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(env);
  // The shared source module, for the state-file helpers only; the process under test
  // is the committed Codex bundle.
  const dash = await mod('bin/dashboard.src.mjs');

  const child = spawn(process.execPath, [BUNDLE, '--serve'], {
    detached: true, stdio: 'ignore', env,
  });
  child.unref();
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ } });

  await waitFor(() => existsSync(dash.statePath(cfg)), 10000,
    'the detached server never published its port');
  const state = dash.readState(cfg);
  assert.ok(state && state.port > 0 && state.token, `unusable state file: ${JSON.stringify(state)}`);
  assert.equal(state.pid, child.pid, 'the file names the process that wrote it');

  if (process.getuid?.() !== 0) {
    const mode = statSync(dash.statePath(cfg)).mode & 0o777;
    assert.equal(mode, 0o600, `the state file holds a live token; mode was ${mode.toString(8)}`);
  }

  // No token, no answer — the state file's 0600 is only worth something if the token
  // it protects is actually required.
  const bare = await fetch(`http://127.0.0.1:${state.port}/api/ping`);
  assert.equal(bare.status, 401, 'an unauthenticated request must be refused');

  const ping = await fetch(`http://127.0.0.1:${state.port}/api/ping`, {
    headers: { authorization: `Bearer ${state.token}` },
  });
  assert.equal(ping.status, 200);
  assert.equal((await ping.json()).service, 'mubit-dashboard');

  // Stop through the same artifact a user's skill would run.
  const stop = await new Promise((res, rej) => {
    const c = spawn(process.execPath, [BUNDLE, '--stop'], { env, stdio: 'ignore' });
    const timer = setTimeout(() => { c.kill('SIGKILL'); rej(new Error('--stop hung')); }, 10000);
    c.on('close', (code) => { clearTimeout(timer); res(code); });
    c.on('error', rej);
  });
  assert.equal(stop, 0);
  assert.equal(existsSync(dash.statePath(cfg)), false, '--stop clears the state file');

  await waitFor(async () => {
    try {
      await fetch(`http://127.0.0.1:${state.port}/api/ping`);
      return false;
    } catch {
      return true;
    }
  }, 5000, '--stop did not actually stop the server');
});

/** Poll a predicate until it holds, or fail with a message that says what did not happen. */
async function waitFor(pred, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => { setTimeout(r, 25); });
  }
  assert.fail(`${message} (waited ${timeoutMs}ms)`);
}
