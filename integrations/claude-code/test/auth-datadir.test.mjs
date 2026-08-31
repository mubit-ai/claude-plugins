// @ts-check
/**
 * `/mubit-memory:auth` — does the *rest of the plugin* find what it wrote?
 *
 * Every other assertion about this command reads the file back with the same `dataDir` it
 * was handed, which proves the write worked and nothing else. The failure that shipped was
 * not a failed write: the key landed, mode 0600, in a real directory, and the command said
 * `ready` — into `~/.claude/plugins/data/mubit-memory`, while the session's hooks and MCP
 * server read `…/mubit-memory-mubit`. From the user's side that is indistinguishable from a
 * sign-in that did nothing.
 *
 * So this file runs the real `main()` in the environment a Bash tool call actually has —
 * **`CLAUDE_PLUGIN_DATA` and `MUBIT_CC_DATA_DIR` deliberately absent**, which is what
 * `test/auth.test.mjs` cannot show because it injects `deps.dataDir` — and then asks the
 * three consumers, each with the environment *it* gets, whether they can see the result.
 * No session is booted: `loadConfig()`, one MCP tool call and one hook run are the whole
 * acceptance criterion, and they cost about a second between them.
 *
 * `MUBIT_API_KEY` and `MUBIT_ENDPOINT` are *removed* from every consumer environment.
 * `baseEnv()` sets both, and leaving them would let every assertion below pass without
 * `credentials.json` being read at all. Removed rather than blanked, which is not the same
 * thing: `resolveApiKey` tests `e.MUBIT_API_KEY !== undefined`, so an empty-string
 * `MUBIT_API_KEY` is a *set* value that shadows the credentials store — deliberately, so a CI
 * job can turn a developer's stored key off. Blanking these would have made this file assert
 * the opposite of what it means to.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  baseEnv, fakeMubit, lib, makeDataDir, mcpCallTool, mod, readJsonDir, runHook, tempDir,
} from './helpers/harness.mjs';

/** The console, cut down to the one route the browser flow exchanges against. */
async function issuingConsole(key) {
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const issued = new Map();

  const server = createServer((req, res) => {
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/api/cli/token') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const actual = createHash('sha256').update(String(body.verifier ?? '')).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      if (issued.get(body.code) !== actual) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end('{"error":"pkce_mismatch"}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ mubitApiKey: key }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    browse(authUrl) {
      const u = new URL(authUrl);
      issued.set('code_ok', u.searchParams.get('challenge'));
      return fetch(`http://127.0.0.1:${u.searchParams.get('port')}/callback`
        + `?code=code_ok&state=${encodeURIComponent(u.searchParams.get('state'))}`,
      { redirect: 'manual' });
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * A `$HOME` shaped like a machine that has Claude Code installed and has never signed in:
 * the two data directories exist, and both are empty.
 */
function freshHome() {
  const home = tempDir('mubit-acceptance-home-');
  const root = join(home, '.claude', 'plugins', 'data');
  for (const n of ['mubit-memory', 'mubit-memory-mubit']) mkdirSync(join(root, n), { recursive: true });
  return { home, root, live: join(root, 'mubit-memory-mubit') };
}

test('a first sign-in is visible to config, the MCP server and a hook', async (t) => {
  const { main } = await mod('bin/auth.src.mjs');
  const { loadConfig } = await lib('config.mjs');
  const KEY = 'mbt_acceptance_0123456789abcdef';

  const instance = await fakeMubit({ 'POST /v2/control/lessons': { json: { lessons: [] } } });
  const console_ = await issuingConsole(KEY);
  const { home, root, live } = freshHome();
  t.after(async () => { await console_.close(); await instance.close(); });

  // --- the sign-in, exactly as the skill runs it, minus the interpolated --data-dir ---
  const lines = [];
  const code = await main(
    ['--endpoint', instance.url, '--json'],
    { HOME: home, MUBIT_CONSOLE_URL: console_.url },
    {
      fetchImpl: fetch, log: (m) => lines.push(m), timeoutMs: 5000,
      openImpl: (url) => { console_.browse(url); },
    },
  );
  assert.equal(code, 0, lines.join('\n'));

  const written = readdirSync(root)
    .filter((n) => existsSync(join(root, n, 'credentials.json')));
  assert.deepEqual(written, ['mubit-memory-mubit'],
    'exactly one credentials.json, in the directory the host points its hooks at');

  /** What each consumer gets: the host's own data dir, and no key in the environment. */
  const consumerEnv = (extra = {}) => baseEnv({
    dataDir: live,
    projectDir: tempDir('mubit-acceptance-proj-'),
    endpoint: instance.url,
    extra: { HOME: home, MUBIT_API_KEY: undefined, MUBIT_ENDPOINT: undefined, ...extra },
  });

  // --- 1. config: what every hook resolves before it does anything ---
  const cfg = loadConfig(consumerEnv());
  assert.equal(cfg.apiKey, KEY, 'a hook must see the key the sign-in stored');
  assert.equal(cfg.endpoint, instance.url, 'and the endpoint stored alongside it');

  // --- 2. the MCP server, out of process, over stdio ---
  const status = await mcpCallTool('mubit_status', {}, {
    dataDir: live,
    endpoint: instance.url,
    extra: { HOME: home, MUBIT_API_KEY: undefined, MUBIT_ENDPOINT: undefined },
  });
  assert.equal(status.isError ?? false, false, JSON.stringify(status).slice(0, 400));
  assert.equal(status.json?.status, 'connected',
    'mubit_status is the answer the user is shown after signing in');
  assert.equal(status.json?.endpoint, instance.url,
    'and it reached that endpoint by reading credentials.json, since the environment has none');

  // --- 3. a hook, which is the half `mubit_status` alone cannot prove ---
  const hook = await runHook('session-start', {
    session_id: 'acceptance-1', cwd: process.cwd(), hook_event_name: 'SessionStart',
  }, { env: consumerEnv({ MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: 'acceptance-run' }) });

  assert.equal(hook.code, 0, hook.stderr);
  const seen = instance.requests.map((r) => r.headers.authorization).filter(Boolean);
  assert.ok(seen.includes(`Bearer ${KEY}`),
    'the hook reached the instance with the key the sign-in stored, not with nothing');
  assert.ok(readJsonDir(join(live, 'status')).length > 0,
    'and left its marker in the directory the sign-in chose');
});

test('with nothing signed in, the same consumers report the absence rather than inventing a key', async () => {
  const { loadConfig } = await lib('config.mjs');
  const { home, live } = freshHome();

  const cfg = loadConfig(baseEnv({
    dataDir: live,
    extra: { HOME: home, MUBIT_API_KEY: undefined, MUBIT_ENDPOINT: undefined },
  }));
  assert.equal(cfg.apiKey, '', 'the control case: without credentials.json there is no key');
  assert.ok(!existsSync(join(makeDataDir(), 'credentials.json')));
});
