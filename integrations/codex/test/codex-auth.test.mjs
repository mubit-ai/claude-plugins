// @ts-check
/**
 * The committed `bin/auth.mjs` — what the Codex `auth` skill actually executes.
 *
 * The bundle is built from the sibling's `bin/auth.src.mjs`, and every behaviour test of
 * that source lives in the sibling suite. What none of that proves is this artifact: that
 * the Codex copy spawns, keeps its entry guard, answers the status/logout surface, and can
 * carry one whole browser sign-in — URL out on stderr, callback in on the loopback, key
 * verified and stored. Until this file, the Codex plugin had zero auth coverage: a bundle
 * whose guard misfires imports cleanly and then does nothing when executed.
 *
 * The browser flow runs against the same doubles the sibling uses (`fakeConsole`,
 * `fakeMubit`), with one Codex-shaped difference: nothing is injectable into a spawned
 * process, so the test plays the browser by reading the authorize URL off stderr — and
 * `PATH` points at an empty directory so the real `open(1)` can never be found. A test
 * suite that opens browser tabs on the developer's machine is itself a defect.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CODEX_ROOT, fakeMubit, makeDataDir, tempDir } from './helpers/codex-fixtures.mjs';
import { fakeConsole } from '../../claude-code/test/helpers/fake-console.mjs';

const BUNDLE = join(CODEX_ROOT, 'bin', 'auth.mjs');

/**
 * Run the committed bundle the way the skill does: a fresh node process.
 *
 * `PATH` is an empty temp directory, always: only the full-flow test *needs* the browser
 * launch to fail, but none of these runs may ever find a real `open(1)` either.
 *
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @param {{onStderr?: (line: string) => void, timeoutMs?: number}} [opts]
 */
function runBundle(args, env = {}, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], {
      cwd: tempDir('mubit-codex-auth-cwd-'),
      env: { PATH: tempDir('mubit-codex-auth-nopath-'), HOME: tempDir('mubit-codex-auth-home-'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; opts.onStderr?.(err); });
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`bundle run did not exit: ${err}`));
    }, opts.timeoutMs ?? 20_000);
    child.on('close', (code) => { clearTimeout(t); resolvePromise({ code, out, err }); });
    child.on('error', reject);
  });
}

test('the bundle exists and stays inert on import', async () => {
  assert.ok(existsSync(BUNDLE), 'the committed bundle is what ships; it must be there');
  const m = await import(`file://${BUNDLE}?codex-auth-guard=1`);
  assert.equal(typeof m.main, 'function',
    'importing must expose main() without running it — the entry guard');
});

test('--status on an unconfigured machine answers unconfigured, exit 1', async () => {
  const { code, out } = await runBundle(['--status', '--json'],
    { MUBIT_CC_DATA_DIR: makeDataDir() });

  assert.equal(code, 1, 'the skill reads the exit code, not the prose');
  const verdict = JSON.parse(out);
  assert.equal(verdict.state, 'unconfigured');
  assert.equal(verdict.ok, false);
});

test('--status on a configured machine answers configured, and never the key', async () => {
  const dataDir = makeDataDir();
  writeFileSync(join(dataDir, 'credentials.json'),
    JSON.stringify({ endpoint: 'https://instance.example', apiKey: 'mbt_stored' }));

  const { code, out } = await runBundle(['--status', '--json'], { MUBIT_CC_DATA_DIR: dataDir });

  assert.equal(code, 0);
  const verdict = JSON.parse(out);
  assert.equal(verdict.state, 'configured');
  assert.equal(verdict.endpoint, 'https://instance.example');
  assert.ok(!out.includes('mbt_stored'), 'the key itself never appears in any output');
});

test('--logout removes the store, and logging out twice is still exit 0', async () => {
  const dataDir = makeDataDir();
  writeFileSync(join(dataDir, 'credentials.json'),
    JSON.stringify({ endpoint: 'https://instance.example', apiKey: 'mbt_stored' }));

  let r = await runBundle(['--logout', '--json'], { MUBIT_CC_DATA_DIR: dataDir });
  assert.equal(r.code, 0);
  assert.equal(existsSync(join(dataDir, 'credentials.json')), false,
    'logout must actually remove the store');

  r = await runBundle(['--logout', '--json'], { MUBIT_CC_DATA_DIR: dataDir });
  assert.equal(r.code, 0, '"already logged out" is the state the user asked for');
});

/**
 * One whole sign-in, through the artifact. The console names the fake instance as the
 * endpoint (loopback is exempt from the TLS upgrade), so verification lands on
 * `fakeMubit` and the stored credentials are checkable end to end.
 */
test('a full browser sign-in lands the key in the pinned data dir', async (t) => {
  const instance = await fakeMubit({ 'POST /v2/control/lessons': { json: { lessons: [] } } });
  t.after(() => instance.close());
  const console_ = await fakeConsole({ key: 'mbt_codex_flow_key', mubitEndpoint: instance.url });
  t.after(() => console_.close());
  const dataDir = makeDataDir();

  let browsed = false;
  const { code, out, err } = await runBundle(['--json'], {
    MUBIT_CC_DATA_DIR: dataDir,
    MUBIT_CONSOLE_URL: console_.url,
    MUBIT_CC_AUTH_TIMEOUT_MS: '15000',
  }, {
    onStderr: (all) => {
      if (browsed) return;
      // The bundle prints the authorize URL unconditionally; with no `open(1)` on PATH
      // that line is the whole browser story, exactly as over SSH.
      const m = /(http:\/\/127\.0\.0\.1:\d+\/app\/cli-auth\?\S+)/.exec(all);
      if (!m) return;
      browsed = true;
      console_.browse(m[1]);
    },
  });

  assert.equal(code, 0, `stderr was:\n${err}`);
  const verdict = JSON.parse(out);
  assert.equal(verdict.state, 'ready');
  assert.equal(verdict.endpoint, instance.url,
    'stored against the endpoint the console named, which is the fake instance');

  const stored = JSON.parse(readFileSync(join(dataDir, 'credentials.json'), 'utf8'));
  assert.deepEqual(stored, { endpoint: instance.url, apiKey: 'mbt_codex_flow_key' });
  if (process.getuid?.() !== 0) {
    const mode = statSync(join(dataDir, 'credentials.json')).mode & 0o777;
    assert.equal(mode, 0o600, `credentials hold a live key; mode was ${mode.toString(8)}`);
  }
  assert.ok(!out.includes('mbt_codex_flow_key') && !err.includes('mbt_codex_flow_key'),
    'the key never crosses stdout or stderr — that is the point of the browser flow');
  instance.assertCalled('POST', '/v2/control/lessons');
});
