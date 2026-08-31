// @ts-check
/**
 * `labs/test/helpers.mjs` — the walkthrough, made spawnable.
 *
 * Everything here mirrors `labs/env.sh` and the two-terminal setup the README describes:
 * a fake instance in one process, hooks and the MCP driver spawned exactly the way Claude
 * Code spawns them. Nothing imports plugin code into the test process — the labs' claim is
 * about processes on a wire, so that is what the tests exercise.
 *
 * Hermetic by construction: every `labState()` gets its own data dir, its own port (the
 * kernel picks), and its own request log. The one shared piece is `labs/.work/demo-app`,
 * which `setup.mjs` builds and every hook only reads (the `/clear` counter lands in the
 * data dir, not the project).
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(LAB_ROOT, '..');
export const PLUGIN_ROOT = join(REPO_ROOT, 'integrations', 'claude-code');
export const PAYLOADS = join(LAB_ROOT, 'payloads');
const HOOKS = join(PLUGIN_ROOT, 'hooks', 'src');

/** Build labs/.work/demo-app if a fresh checkout does not have it yet. Idempotent. */
export function ensureProject() {
  if (!existsSync(join(LAB_ROOT, '.work', 'demo-app', '.git'))) {
    const r = spawnSync('node', [join(LAB_ROOT, 'setup.mjs')], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`setup.mjs failed: ${r.stderr}`);
  }
  return join(LAB_ROOT, '.work', 'demo-app');
}

/** The run id these settings derive — same derivation env.sh performs, same modules the hooks use. */
export function deriveLabRunId(env) {
  const r = spawnSync('node', [join(LAB_ROOT, 'runid.mjs')], { cwd: REPO_ROOT, env, encoding: 'utf8' });
  const m = /^run_id\s+(\S+)/m.exec(r.stdout ?? '');
  if (!m) throw new Error(`runid.mjs gave no run_id:\n${r.stdout}\n${r.stderr}`);
  return m[1];
}

/**
 * One lab bench: scratch data dir, the env `env.sh` would export, teardown.
 * The endpoint is filled in by `startFake` once the kernel has picked a port.
 */
export function labState() {
  const dataDir = mkdtempSync(join(tmpdir(), 'lab-data-'));
  for (const sub of ['sessions', 'runs', 'status', 'breaker', 'policy', 'logs', 'tmp']) {
    mkdirSync(join(dataDir, sub), { recursive: true });
  }
  const projectDir = ensureProject();
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    CLAUDE_PLUGIN_DATA: dataDir,
    CLAUDE_PROJECT_DIR: projectDir,
    MUBIT_CC_DATA_DIR: dataDir,
    MUBIT_API_KEY: 'mbt_lab_0123456789abcdef0123456789abcdef',
    MUBIT_CC_LOG_LEVEL: 'debug',
    MUBIT_DEFAULT_SESSION_ID: '',
  };
  delete env.MUBIT_ENDPOINT; // startFake sets it once the port is known
  return {
    dataDir,
    projectDir,
    env,
    cleanup() { rmSync(dataDir, { recursive: true, force: true }); },
  };
}

/**
 * Start `labs/fake-mubit.mjs` on an ephemeral port with a private request log.
 * Resolves once the banner names the bound port — the same line a human waits for.
 */
export function startFake(state, { scenario = 'ok' } = {}) {
  const logFile = join(state.dataDir, 'requests.ndjson');
  const child = spawn('node', [
    join(LAB_ROOT, 'fake-mubit.mjs'),
    '--port', '0',
    '--scenario', scenario,
    '--log-file', logFile,
  ], { cwd: REPO_ROOT, env: state.env, stdio: ['ignore', 'pipe', 'pipe'] });

  return new Promise((resolvePort, reject) => {
    let banner = '';
    const onData = (c) => {
      banner += String(c);
      const m = /fake mubit\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(banner);
      if (!m) return;
      child.stdout.off('data', onData);
      child.stdout.resume();
      const port = Number(m[1]);
      state.env.MUBIT_ENDPOINT = `http://127.0.0.1:${port}`;
      resolvePort({
        port,
        url: state.env.MUBIT_ENDPOINT,
        logFile,
        /** Every request the instance has served, oldest first. */
        requests() {
          if (!existsSync(logFile)) return [];
          return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        },
        /** How many requests are on the log right now — diff across a call, Lab 11's trick. */
        mark() { return this.requests().length; },
        since(mark) { return this.requests().slice(mark); },
        async stop() {
          child.kill('SIGTERM');
          await new Promise((r) => { child.once('exit', r); setTimeout(r, 1500).unref(); });
        },
      });
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`fake-mubit exited ${code} before it was ready:\n${banner}`)));
    setTimeout(() => reject(new Error(`fake-mubit never printed its banner:\n${banner}`)), 10_000).unref();
  });
}

/**
 * Run one hook the way `env.sh`'s `hook` helper does: fresh process, payload on stdin,
 * JSON on stdout, from the repo root (the payloads carry repo-root-relative paths).
 */
export function runHook(state, name, payload, args = []) {
  const stdin = payload.endsWith('.json') || payload.endsWith('.jsonl')
    ? readFileSync(join(PAYLOADS, payload), 'utf8')
    : payload;
  const r = spawnSync('node', [join(HOOKS, `${name}.mjs`), ...args], {
    cwd: REPO_ROOT, env: state.env, input: stdin, encoding: 'utf8', timeout: 20_000,
  });
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { /* asserted by callers */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/** Call one MCP tool through `labs/mcp-drive.mjs` — the launcher path, not a shortcut. */
export function driveMcp(state, tool, args = {}, extra = []) {
  const r = spawnSync('node', [
    join(LAB_ROOT, 'mcp-drive.mjs'),
    ...(tool === '--list' ? ['--list'] : ['--tool', tool, '--args', JSON.stringify(args)]),
    ...extra,
  ], { cwd: REPO_ROOT, env: state.env, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The spool for a run: [{file, item}] — one file per item is the design being observed. */
export function spoolItems(state, runId) {
  const dir = join(state.dataDir, 'runs', runId, 'spool');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => ({
    file: f,
    item: JSON.parse(readFileSync(join(dir, f), 'utf8')),
  }));
}

/** status/<run_id>.json — the marker the status line reads, and Lab 11d's join point. */
export function marker(state, runId) {
  const p = join(state.dataDir, 'status', `${runId}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/** Poll until `fn` returns truthy or the deadline passes — for the detached drain. */
export async function eventually(fn, { ms = 8000, step = 150 } = {}) {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) return fn();
    await new Promise((r) => setTimeout(r, step));
  }
}

/** Every file under the data dir, with contents — for "the secret is nowhere on disk". */
export function allDataFiles(state) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push({ path: p, text: readFileSync(p, 'utf8') });
    }
  };
  walk(state.dataDir);
  return out;
}
