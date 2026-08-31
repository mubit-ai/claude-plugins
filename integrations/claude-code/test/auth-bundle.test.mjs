// @ts-check
/**
 * The committed `bin/auth.mjs` — the file `/mubit-memory:auth` actually executes.
 *
 * Everything else in the auth suite imports `bin/auth.src.mjs` and drives `main()` with
 * injected dependencies (or, under `test:dist`, imports the bundle). Importing proves the
 * exports; nothing before this file ever *spawned* the artifact, so the entry-point
 * guard, argv handling and process exit codes of what users run had zero coverage. A
 * bundle whose guard misfires imports cleanly and then does nothing when executed —
 * exit 0, no output, no error — which is exactly the failure importing cannot see.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PLUGIN_ROOT, makeDataDir, mod, tempDir } from './helpers/harness.mjs';

const BUNDLE = join(PLUGIN_ROOT, 'bin', 'auth.mjs');

/** Run the committed bundle the way the skill does: a fresh node process. */
function runBundle(args, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: tempDir('mubit-auth-bundle-home-'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`bundle run did not exit: ${err}`));
    }, 15000);
    child.on('close', (code) => { clearTimeout(t); resolvePromise({ code, out, err }); });
    child.on('error', reject);
  });
}

test('the bundle exists and stays inert on import', async () => {
  assert.ok(existsSync(BUNDLE), 'the committed bundle is what ships; it must be there');
  const m = await mod('bin/auth.mjs');
  assert.equal(typeof m.main, 'function',
    'importing must expose main() without running it — the entry guard');
});

test('the bundle answers --status on an unconfigured machine with exit 1', async () => {
  const { code, out } = await runBundle(['--status', '--json'],
    { MUBIT_CC_DATA_DIR: makeDataDir() });

  assert.equal(code, 1, 'the skill reads the exit code, not the prose');
  const verdict = JSON.parse(out);
  assert.equal(verdict.state, 'unconfigured');
  assert.equal(verdict.ok, false);
});

test('the bundle answers --status on a configured machine with exit 0', async () => {
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

test('the bundle logs out, and logging out twice is still exit 0', async () => {
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
