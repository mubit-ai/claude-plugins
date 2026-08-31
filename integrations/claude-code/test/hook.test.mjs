// @ts-check
/**
 * `lib/hook.mjs` — the harness every hook in this plugin runs inside (§4.9).
 *
 * The whole point of this module is exit-code discipline. Claude Code reads a hook's
 * exit code first: 0 → stdout is parsed as JSON; 2 → the hook BLOCKS and stderr becomes
 * the reason shown to the model; any other non-zero → a non-blocking error surfaced to
 * the user. This plugin never exits 2 and never exits non-zero, in any mode, including
 * every failure mode. A memory layer has no business blocking a prompt or a tool call;
 * the only thing an internal failure should ever cost is the memory itself.
 *
 * Nothing here talks to `hooks/src/*` except through `spawnDetached`, which needs a real
 * child. Everything else drives `runHook` through a generated driver script so the
 * harness is tested in isolation from any particular hook.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  PLUGIN_ROOT, tempDir, makeDataDir, baseEnv, fakeMubit, waitFor,
} from './helpers/harness.mjs';
import { stop, spoolItem, PROMPT_ID } from './helpers/fixtures.mjs';

const HOOK_LIB = join(PLUGIN_ROOT, 'lib', 'hook.mjs');
const CONFIG_LIB = join(PLUGIN_ROOT, 'lib', 'config.mjs');
const RUN_ID = 'cc-test-0000';

/** The expected red state until `lib/hook.mjs` is written. */
function requireHookLib() {
  if (!existsSync(HOOK_LIB)) {
    throw new Error('lib/hook.mjs does not exist yet — write it, then re-run this test.');
  }
}

// ---------------------------------------------------------------------------
// Driver: a throwaway script that calls runHook() with a body we control.
// ---------------------------------------------------------------------------

const SCRATCH = tempDir('mubit-cc-hooklib-');

/** Preload that records how any node process in this env was actually launched. */
const SPY_SRC = `const fs = require('node:fs');
const out = process.env.MUBIT_TEST_SPY_FILE;
if (out) {
  let charDev = null;
  try { charDev = fs.fstatSync(1).isCharacterDevice(); } catch { charDev = null; }
  try {
    fs.appendFileSync(out, JSON.stringify({
      argv: process.argv.slice(1),
      detached: process.env.MUBIT_CC_DETACHED || '',
      stdoutIsCharDevice: charDev,
      pid: process.pid,
      at: Date.now(),
    }) + '\\n');
  } catch {}
}
`;
const SPY = join(SCRATCH, 'spawn-spy.cjs');
writeFileSync(SPY, SPY_SRC);

/** @param {string} file @returns {any[]} */
function spyLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const bodyDriverSrc = () => `
import { runHook } from '${pathToFileURL(HOOK_LIB).href}';
import { writeFileSync } from 'node:fs';

const mode = process.env.T_MODE || 'return';

await runHook('t-driver', {
  budgetMs: Number(process.env.T_BUDGET_MS || '500'),
  body: async (payload) => {
    if (process.env.T_ECHO) writeFileSync(process.env.T_ECHO, JSON.stringify(payload ?? null));
    if (mode === 'throw') throw new Error('boom-in-body');
    if (mode === 'reject') return Promise.reject(new Error('rejected-in-body'));
    if (mode === 'slow') {
      await new Promise((r) => setTimeout(r, 5000));
      return { hookSpecificOutput: { late: true } };
    }
    if (mode === 'undefined') return undefined;
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', ok: true } };
  },
});
`;

/** @param {string} src @param {string} [name] */
function writeScript(src, name = `driver-${randomUUID()}.mjs`) {
  const p = join(SCRATCH, name);
  writeFileSync(p, src);
  return p;
}

/**
 * Spawn a script the way Claude Code spawns a hook: fresh node, payload on stdin.
 * @param {string} script
 * @param {{env: Record<string,string>, args?: string[], stdinRaw?: string, payload?: any, timeoutMs?: number}} o
 */
async function runScript(script, o) {
  const started = Date.now();
  const child = spawn(process.execPath, [script, ...(o.args ?? [])], {
    env: o.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.end(o.stdinRaw ?? JSON.stringify(o.payload ?? {}));
  const code = await new Promise((res, rej) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      rej(new Error(`driver exceeded ${o.timeoutMs ?? 15000}ms`));
    }, o.timeoutMs ?? 15000);
    child.on('close', (c) => { clearTimeout(t); res(c); });
    child.on('error', (e) => { clearTimeout(t); rej(e); });
  });
  return { code, stdout, stderr, ms: Date.now() - started };
}

/** Exit 0 and stdout that parses as a JSON object — the universal contract (§4.9). */
function jsonStdout(r) {
  assert.equal(r.code, 0, `hook must ALWAYS exit 0, got ${r.code}. stderr:\n${r.stderr}`);
  const raw = r.stdout.trim();
  assert.notEqual(raw, '', `expected JSON on stdout, got nothing. stderr:\n${r.stderr}`);
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    assert.fail(`stdout must be JSON, got:\n${r.stdout}\n(${e})`);
  }
  assert.equal(typeof parsed, 'object', `stdout must be a JSON object, got:\n${r.stdout}`);
  return parsed;
}

function envFor(dataDir, extra = {}) {
  return baseEnv({ dataDir, extra: { MUBIT_CC_LOG_LEVEL: 'debug', ...extra } });
}

/**
 * A fake Mubit whose listening socket is closed even when the test fails — otherwise an
 * open handle keeps the test process alive and the whole run hangs.
 * @param {any} t @param {any} [routes]
 */
async function mubit(t, routes) {
  const server = await fakeMubit(routes);
  t.after(() => server.close());
  return server;
}

// ---------------------------------------------------------------------------

// §4.9 — whatever body returns is stringified to stdout, and the exit code is 0.
test('runHook: a normal return is stringified to stdout with exit 0', async (t) => {
  requireHookLib();
  const dataDir = makeDataDir();
  const r = await runScript(writeScript(bodyDriverSrc()), {
    env: envFor(dataDir, { T_MODE: 'return' }),
    payload: stop(),
  });
  const out = jsonStdout(r);
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PostToolUse', ok: true } });
});

// §4.9 — "undefined emits {}". A hook with nothing to say still owes Claude Code valid JSON.
test('runHook: a body returning undefined emits {}', async (t) => {
  requireHookLib();
  const dataDir = makeDataDir();
  const r = await runScript(writeScript(bodyDriverSrc()), {
    env: envFor(dataDir, { T_MODE: 'undefined' }),
    payload: stop(),
  });
  assert.deepEqual(jsonStdout(r), {});
});

// §4.9 — "Any throw is caught, logged, and becomes exit 0 with {"suppressOutput": true}".
// Exit 1 here would show the user an error toast for a memory-layer bug they cannot fix.
test('runHook: a throw inside body becomes exit 0 + {"suppressOutput":true}', async (t) => {
  requireHookLib();
  const dataDir = makeDataDir();
  const r = await runScript(writeScript(bodyDriverSrc()), {
    env: envFor(dataDir, { T_MODE: 'throw' }),
    payload: stop(),
  });
  assert.deepEqual(jsonStdout(r), { suppressOutput: true });
  assert.equal(r.code, 0);
  // Never exit 2: that is the "block this tool call" channel and is not ours to use.
  assert.notEqual(r.code, 2);
});

// §4.9 — a rejected promise is the async spelling of a throw and must land identically.
test('runHook: a rejected promise from body becomes exit 0 + {"suppressOutput":true}', async (t) => {
  requireHookLib();
  const dataDir = makeDataDir();
  const r = await runScript(writeScript(bodyDriverSrc()), {
    env: envFor(dataDir, { T_MODE: 'reject' }),
    payload: stop(),
  });
  assert.deepEqual(jsonStdout(r), { suppressOutput: true });
});

// §4.9 — body runs "under a hard deadline". Claude Code waits for the process to exit
// before reading stdout, so a runaway body must not be able to stall a tool call.
test('runHook: a body over budget is cut off, still exits 0 with valid JSON', async (t) => {
  requireHookLib();
  const dataDir = makeDataDir();
  const r = await runScript(writeScript(bodyDriverSrc()), {
    // Real target: emit within budgetMs + a few ms. The 2s ceiling below is a CI
    // guard-rail — what matters is that it is nowhere near the body's 5000ms sleep.
    env: envFor(dataDir, { T_MODE: 'slow', T_BUDGET_MS: '300' }),
    payload: stop(),
  });
  const out = jsonStdout(r);
  assert.ok(r.ms < 2000, `budget 300ms was not enforced; process lived ${r.ms}ms`);
  assert.equal(out.hookSpecificOutput, undefined,
    'the late body result must not be emitted after the deadline');
});

// §4.9 — malformed stdin emits {} and exits 0, and says so exactly once in the log.
test('runHook: malformed stdin emits {}, exits 0, logs once, and never runs body', async (t) => {
  requireHookLib();
  const dataDir = makeDataDir();
  const echo = join(dataDir, 'echo.json');
  const r = await runScript(writeScript(bodyDriverSrc()), {
    env: envFor(dataDir, { T_MODE: 'return', T_ECHO: echo }),
    stdinRaw: 'not json',
  });
  assert.deepEqual(jsonStdout(r), {});
  assert.equal(existsSync(echo), false, 'body must not run on unparseable stdin');

  const logPath = join(dataDir, 'logs', 'mubit-cc.log');
  assert.ok(existsSync(logPath), 'a swallowed stdin parse failure must still be logged (§4.8)');
  const hits = readFileSync(logPath, 'utf8')
    .split('\n').filter((l) => /stdin|payload|malformed|parse/i.test(l));
  assert.equal(hits.length, 1, `expected exactly one log entry, got:\n${hits.join('\n')}`);
});

// §4.9 — empty stdin is the same story: {} and exit 0, never a crash.
test('runHook: empty stdin emits {} and exits 0', async (t) => {
  requireHookLib();
  const dataDir = makeDataDir();
  const echo = join(dataDir, 'echo.json');
  const r = await runScript(writeScript(bodyDriverSrc()), {
    env: envFor(dataDir, { T_MODE: 'return', T_ECHO: echo }),
    stdinRaw: '',
  });
  assert.deepEqual(jsonStdout(r), {});
  assert.equal(existsSync(echo), false, 'body must not run without a payload');
});

// §4.9 — spawnDetached: the parent returns immediately, the child outlives it, and the
// payload travels through a file because a detached child's inherited stdin is not
// reliably readable once the parent exits.
test('spawnDetached: parent returns immediately; child is detached and unlinks its payload file', async (t) => {
  requireHookLib();
  if (!existsSync(CONFIG_LIB)) throw new Error('lib/config.mjs does not exist yet — write it, then re-run.');

  const dataDir = makeDataDir();
  // The child must be slow, so "the parent did not wait" is observable. Whichever
  // drain.mjs spawnDetached resolves to gets a reason to live: the stub below sleeps,
  // and the real drain blocks on an ingest that never answers.
  const server = await mubit(t, { 'POST /v2/control/ingest': { hang: true } });
  const spool = join(dataDir, 'runs', RUN_ID, 'spool');
  mkdirSync(spool, { recursive: true });
  writeFileSync(join(spool, `${Date.now()}-000001.json`), JSON.stringify(spoolItem()));

  const childLog = join(SCRATCH, `child-${randomUUID()}.jsonl`);
  const spyFile = join(SCRATCH, `spy-${randomUUID()}.jsonl`);
  const resultFile = join(SCRATCH, `result-${randomUUID()}.json`);

  // A stand-in for hooks/{src,dist}/drain.mjs, dropped next to the driver so that a
  // sibling-relative resolution finds it. It runs the same harness, so the payload-file
  // read and the unlink under test are still lib/hook.mjs's.
  const stubDir = join(SCRATCH, `detach-${randomUUID()}`);
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(stubDir, 'drain.mjs'), `
import { runHook } from '${pathToFileURL(HOOK_LIB).href}';
import { appendFileSync } from 'node:fs';
await runHook('drain', {
  budgetMs: 6000,
  body: async (payload) => {
    appendFileSync(process.env.T_CHILD_LOG, JSON.stringify({
      payload, argv: process.argv.slice(1), detached: process.env.MUBIT_CC_DETACHED || '',
    }) + '\\n');
    await new Promise((r) => setTimeout(r, 1500));
    return { suppressOutput: true };
  },
});
`);

  const driver = join(stubDir, 'driver.mjs');
  writeFileSync(driver, `
import { spawnDetached } from '${pathToFileURL(HOOK_LIB).href}';
import { loadConfig } from '${pathToFileURL(CONFIG_LIB).href}';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const cfg = loadConfig();
const dataDir = process.env.MUBIT_CC_DATA_DIR;
mkdirSync(join(dataDir, 'tmp'), { recursive: true });
// §4.9: payload handoff goes through \${CLAUDE_PLUGIN_DATA}/tmp/<uuid>.json.
const payloadPath = join(dataDir, 'tmp', randomUUID() + '.json');
writeFileSync(payloadPath, process.env.T_PAYLOAD);
const t0 = Date.now();
spawnDetached(cfg, 'drain', ['--with-outcome', '${PROMPT_ID}'], payloadPath);
writeFileSync(process.env.T_RESULT, JSON.stringify({ payloadPath, callMs: Date.now() - t0 }));
`);

  const r = await runScript(driver, {
    env: baseEnv({
      dataDir,
      endpoint: server.url,
      extra: {
        NODE_OPTIONS: `--require ${SPY}`,
        MUBIT_TEST_SPY_FILE: spyFile,
        T_CHILD_LOG: childLog,
        T_RESULT: resultFile,
        T_PAYLOAD: JSON.stringify(stop()),
        MUBIT_CC_RUN_STRATEGY: 'static',
        MUBIT_CC_RUN_ID: RUN_ID,
        MUBIT_CC_TIMEOUT_MS: '900',
      },
    }),
    stdinRaw: '',
  });

  assert.equal(r.code, 0, `parent must exit 0. stderr:\n${r.stderr}`);
  const result = JSON.parse(readFileSync(resultFile, 'utf8'));
  // The parent returns immediately — far below the child's >=1500ms lifetime.
  assert.ok(result.callMs < 250, `spawnDetached blocked for ${result.callMs}ms`);
  assert.ok(r.ms < 1200, `parent process waited on the child (${r.ms}ms wall)`);
  // Proof the parent did not wait: the child is demonstrably still working.
  assert.equal(existsSync(result.payloadPath), true,
    'payload file was already gone — the parent waited for the child to finish');

  const child = await waitFor(
    () => spyLines(spyFile).find((l) => basename(String(l.argv?.[0] ?? '')) === 'drain.mjs'),
    6000,
  ).catch(() => null);
  assert.ok(child, 'spawnDetached started no child: it must resolve "drain" to a drain.mjs '
    + 'sibling of the calling script (or under ${CLAUDE_PLUGIN_ROOT}/hooks/{src,dist})');

  // The child's own argv carries the args plus the payload file, in that order.
  assert.deepEqual(child.argv.slice(1, 3), ['--with-outcome', PROMPT_ID]);
  assert.equal(child.argv.at(-2), '--payload');
  assert.equal(child.argv.at(-1), result.payloadPath);
  assert.equal(dirname(result.payloadPath), join(dataDir, 'tmp'));
  assert.match(basename(result.payloadPath),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/);
  // MUBIT_CC_DETACHED=1 is how the child knows to read --payload instead of stdin.
  assert.equal(child.detached, '1');
  // stdio:'ignore' — fd 1 is /dev/null (a character device), not an inherited pipe.
  if (process.platform !== 'win32') {
    assert.equal(child.stdoutIsCharDevice, true,
      'detached child must be spawned with stdio:"ignore"');
  }

  // The child unlinks the payload file when done — and it does so after the parent is gone.
  await waitFor(() => !existsSync(result.payloadPath), 9000);

  // Bonus, only when the sibling stub was the child: prove the payload arrived by file.
  const seen = spyLines(childLog);
  if (seen.length) {
    assert.equal(seen[0].payload?.session_id, stop().session_id,
      'the child must read its payload from the --payload file');
    assert.equal(seen[0].detached, '1');
  }
});
