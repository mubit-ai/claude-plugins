// @ts-check
/**
 * `/mubit-memory:auth` — getting a key, checking it, and putting it somewhere.
 *
 * The command exists because the honest answer to "how do I set this up?" used to be
 * "open the console, find the instance page, issue a key, copy it, run `/plugin`, find
 * Mubit Memory, choose configure, paste it into two fields". Every one of those steps is
 * a place to stop.
 *
 * Two properties are worth more than the happy path and are what most of this file
 * asserts:
 *
 *   1. **A key is never reported as good without being checked against the server.**
 *      `GET /v2/core/health` reports whether the instance is up, not whether your key
 *      is good, so a green health check proves nothing about the credential. Validating
 *      against it would make `/auth` a machine for producing false confidence — the
 *      exact failure the `doctor` skill then has to talk the user back out of.
 *   2. **The four outcomes stay distinct.** "Your key is wrong" and "your network is
 *      down" have nothing to do with each other, and collapsing them is how a user ends
 *      up re-issuing a perfectly good key.
 *
 * No real network, no real browser: `fetchImpl` and `openImpl` are injected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fakeMubit, lib, makeDataDir, mod, tempDir } from './helpers/harness.mjs';

const IS_ROOT = process.getuid?.() === 0;
const KEY = 'mbt_a_realistic_looking_test_key';

/** Collect the URL any browser-open would have used, without opening one. */
function recorder() {
  const opened = [];
  return { opened, openImpl: (url) => { opened.push(url); return true; } };
}

// ---------------------------------------------------------------------------
// Shape gate — before any HTTP
// ---------------------------------------------------------------------------

test('looksLikeKey accepts an mbt_ key and rejects the things users actually paste', async () => {
  const { looksLikeKey } = await mod('bin/auth.src.mjs');

  assert.equal(looksLikeKey(KEY), true);
  assert.equal(looksLikeKey(`  ${KEY}  `), true, 'a copy-paste picks up whitespace');

  for (const bad of [
    '', '   ', 'mbt_', 'sk-ant-api03-xxxx', 'Bearer mbt_x', 'mbt', 'xmbt_abc',
    'https://console.mubit.ai', undefined, null, 42,
  ]) {
    assert.equal(looksLikeKey(/** @type {any} */ (bad)), false, `must reject ${JSON.stringify(bad)}`);
  }
});

test('a malformed key is rejected without touching the network', async () => {
  const { verifyCredentials } = await mod('bin/auth.src.mjs');
  const server = await fakeMubit();
  test.after?.(() => server.close());

  const res = await verifyCredentials({
    endpoint: server.url, apiKey: 'not-a-key', fetchImpl: fetch,
  });

  assert.equal(res.state, 'invalid_key');
  assert.equal(res.ok, false);
  assert.equal(server.requests.length, 0,
    'the shape gate is there so an obvious typo costs a round trip to nobody');
  await server.close();
});

// ---------------------------------------------------------------------------
// Verification — the ladder
// ---------------------------------------------------------------------------

test('a good key against a healthy instance is ready', async () => {
  const { verifyCredentials } = await mod('bin/auth.src.mjs');
  const server = await fakeMubit({ 'POST /v2/control/lessons': { json: { lessons: [] } } });

  const res = await verifyCredentials({ endpoint: server.url, apiKey: KEY, fetchImpl: fetch });

  assert.equal(res.ok, true);
  assert.equal(res.state, 'ready');
  await server.close();
});

/**
 * The assertion this whole file is built around.
 *
 * `/v2/core/health` is the readiness probe, and the plugin makes it before a key exists —
 * that is the whole point of it, and it is why its verdict says nothing about the key. A
 * check that stops there reports success for a key that is rejected on every later call.
 */
test('a rejected key is auth_failed, even though health says OK', async () => {
  const { verifyCredentials } = await mod('bin/auth.src.mjs');
  const server = await fakeMubit({
    'GET /v2/core/health': { text: 'OK' },
    'POST /v2/control/lessons': { status: 401, json: { error: 'unauthorized' } },
  });

  const res = await verifyCredentials({ endpoint: server.url, apiKey: KEY, fetchImpl: fetch });

  assert.equal(res.ok, false);
  assert.equal(res.state, 'auth_failed');
  server.assertCalled('POST', '/v2/control/lessons');
  await server.close();
});

test('a 403 is auth_failed too', async () => {
  const { verifyCredentials } = await mod('bin/auth.src.mjs');
  const server = await fakeMubit({
    'POST /v2/control/lessons': { status: 403, json: { error: 'forbidden' } },
  });

  const res = await verifyCredentials({ endpoint: server.url, apiKey: KEY, fetchImpl: fetch });
  assert.equal(res.state, 'auth_failed');
  await server.close();
});

test('nothing listening is unreachable, and is never blamed on the key', async () => {
  const { verifyCredentials } = await mod('bin/auth.src.mjs');

  // Port 1 on loopback: connection refused, immediately.
  const res = await verifyCredentials({
    endpoint: 'http://127.0.0.1:1', apiKey: KEY, fetchImpl: fetch, timeoutMs: 1500,
  });

  assert.equal(res.ok, false);
  assert.equal(res.state, 'unreachable',
    'a user whose VPN is down must not be told to re-issue their key');
});

test('a transport failure names what went wrong, not just that it went wrong', async () => {
  const { verifyCredentials } = await mod('bin/auth.src.mjs');

  // A port that was bound and then released: connection refused, immediately. A hardcoded low
  // port will not do — the WHATWG "bad ports" list makes fetch refuse 1 and 9 before it ever
  // opens a socket, so the failure carries no errno to report.
  const probe = await fakeMubit();
  const deadUrl = probe.url;
  await probe.close();
  const refused = await verifyCredentials({
    endpoint: deadUrl, apiKey: KEY, fetchImpl: fetch, timeoutMs: 1500,
  });
  assert.equal(refused.state, 'unreachable');
  assert.match(refused.detail, /ECONNREFUSED/,
    'a port with nothing behind it must say so; the errno lives in the cause chain');

  // A name that cannot resolve. `.invalid` is reserved by RFC 2606 for exactly this.
  const noHost = await verifyCredentials({
    endpoint: 'https://nothing.invalid', apiKey: KEY, fetchImpl: fetch, timeoutMs: 4000,
  });
  assert.equal(noHost.state, 'unreachable');
  assert.match(noHost.detail, /ENOTFOUND|EAI_AGAIN/);

  assert.notEqual(refused.detail, noHost.detail,
    'a dead port and a dead name are different problems with different fixes, and both '
    + 'used to print the same sentence');
});

// Codex runs an unapproved command inside seatbelt with the network switched off, and DNS is
// what fails first there — so a healthy endpoint reports ENOTFOUND and the user is sent off to
// fix a URL that was never wrong.
test('inside the Codex sandbox the network is blamed, not the endpoint', async (t) => {
  const { verifyCredentials } = await mod('bin/auth.src.mjs');
  const before = process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  t.after(() => {
    if (before === undefined) delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
    else process.env.CODEX_SANDBOX_NETWORK_DISABLED = before;
  });
  process.env.CODEX_SANDBOX_NETWORK_DISABLED = '1';

  const res = await verifyCredentials({
    endpoint: 'https://nothing.invalid', apiKey: KEY, fetchImpl: fetch, timeoutMs: 4000,
  });

  assert.equal(res.state, 'unreachable');
  assert.match(res.detail, /no network access/);
  assert.match(res.detail, /Approve the command/);
  assert.ok(!/typo/.test(res.detail), 'the endpoint is not the thing to go and fix');
});

test('a timeout says it did not answer in time, not that the host is wrong', async () => {
  const { verifyCredentials } = await mod('bin/auth.src.mjs');
  const server = await fakeMubit({ 'GET /v2/core/health': { hang: true } });

  const res = await verifyCredentials({
    endpoint: server.url, apiKey: KEY, fetchImpl: fetch, timeoutMs: 200,
  });

  assert.equal(res.state, 'unreachable');
  assert.match(res.detail, /did not answer in time/);
  await server.close();
});

test('a failing instance is server_error, distinct from a bad key', async () => {
  const { verifyCredentials } = await mod('bin/auth.src.mjs');
  const server = await fakeMubit({
    'POST /v2/control/lessons': { status: 500, json: { error: 'boom' } },
  });

  const res = await verifyCredentials({ endpoint: server.url, apiKey: KEY, fetchImpl: fetch });

  assert.equal(res.ok, false);
  assert.equal(res.state, 'server_error');
  await server.close();
});

test('an unhealthy instance is reported before the key is ever judged', async () => {
  const { verifyCredentials } = await mod('bin/auth.src.mjs');
  const server = await fakeMubit({
    'GET /v2/core/health': { status: 503, text: 'starting' },
  });

  const res = await verifyCredentials({ endpoint: server.url, apiKey: KEY, fetchImpl: fetch });

  assert.equal(res.ok, false);
  assert.equal(res.state, 'server_error');
  server.assertNotCalled('POST', '/v2/control/lessons');
  await server.close();
});

test('a hanging server times out as unreachable rather than waiting forever', async () => {
  const { verifyCredentials } = await mod('bin/auth.src.mjs');
  const server = await fakeMubit({ 'GET /v2/core/health': { hang: true } });

  const started = Date.now();
  const res = await verifyCredentials({
    endpoint: server.url, apiKey: KEY, fetchImpl: fetch, timeoutMs: 200,
  });

  assert.equal(res.state, 'unreachable');
  assert.ok(Date.now() - started < 3000, 'the timeout must actually fire');
  await server.close();
});

test('the probe sends the key as a bearer token and never as a query parameter', async () => {
  const { verifyCredentials } = await mod('bin/auth.src.mjs');
  const server = await fakeMubit({ 'POST /v2/control/lessons': { json: { lessons: [] } } });

  await verifyCredentials({ endpoint: server.url, apiKey: KEY, fetchImpl: fetch });

  const call = server.lastCall('POST', '/v2/control/lessons');
  assert.ok(call, 'the authenticated probe must happen');
  assert.equal(call.headers.authorization, `Bearer ${KEY}`);
  for (const r of server.requests) {
    assert.ok(!r.query.toString().includes(KEY),
      'a key in a query string lands in access logs and browser history');
  }
  await server.close();
});

// ---------------------------------------------------------------------------
// Storing
// ---------------------------------------------------------------------------

test('a verified key is stored, owner-only', { skip: IS_ROOT }, async () => {
  const { authenticateWithKey } = await mod('bin/auth.src.mjs');
  const { readCredentials, credentialsPath } = await lib('credentials.mjs');
  const server = await fakeMubit({ 'POST /v2/control/lessons': { json: { lessons: [] } } });
  const dataDir = makeDataDir();

  const res = await authenticateWithKey({
    dataDir, endpoint: server.url, apiKey: KEY, fetchImpl: fetch,
  });

  assert.equal(res.ok, true);
  assert.equal(res.state, 'ready');
  assert.deepEqual(readCredentials(dataDir), { endpoint: server.url, apiKey: KEY });
  assert.equal((statSync(credentialsPath(dataDir)).mode & 0o777).toString(8), '600');
  await server.close();
});

test('a key the server rejects is never written to disk', async () => {
  const { authenticateWithKey } = await mod('bin/auth.src.mjs');
  const { readCredentials } = await lib('credentials.mjs');
  const server = await fakeMubit({
    'POST /v2/control/lessons': { status: 401, json: { error: 'unauthorized' } },
  });
  const dataDir = makeDataDir();

  const res = await authenticateWithKey({
    dataDir, endpoint: server.url, apiKey: KEY, fetchImpl: fetch,
  });

  assert.equal(res.ok, false);
  assert.deepEqual(readCredentials(dataDir), {},
    'storing an unverified key just moves the failure to the next session');
  await server.close();
});

test('re-authenticating rotates the key without dropping the endpoint', async () => {
  const { authenticateWithKey } = await mod('bin/auth.src.mjs');
  const { readCredentials } = await lib('credentials.mjs');
  const server = await fakeMubit({ 'POST /v2/control/lessons': { json: { lessons: [] } } });
  const dataDir = makeDataDir();

  await authenticateWithKey({ dataDir, endpoint: server.url, apiKey: KEY, fetchImpl: fetch });
  await authenticateWithKey({
    dataDir, endpoint: server.url, apiKey: 'mbt_rotated_key_value', fetchImpl: fetch,
  });

  assert.deepEqual(readCredentials(dataDir),
    { endpoint: server.url, apiKey: 'mbt_rotated_key_value' });
  await server.close();
});

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

test('normalizeEndpoint fixes what a user pastes', async () => {
  const { normalizeEndpoint, DEFAULT_ENDPOINT } = await mod('bin/auth.src.mjs');

  const rows = [
    ['https://api.mubit.ai', 'https://api.mubit.ai'],
    ['https://api.mubit.ai/', 'https://api.mubit.ai'],
    ['  https://api.mubit.ai/  ', 'https://api.mubit.ai'],
    ['api.mubit.ai', 'https://api.mubit.ai'],
    ['http://127.0.0.1:8899', 'http://127.0.0.1:8899'],
    ['', DEFAULT_ENDPOINT],
    [undefined, DEFAULT_ENDPOINT],
  ];
  for (const [input, want] of rows) {
    assert.equal(normalizeEndpoint(/** @type {any} */ (input)), want,
      `normalizeEndpoint(${JSON.stringify(input)})`);
  }
});

test('a bare hostname is upgraded to https, never left as http', async () => {
  const { normalizeEndpoint } = await mod('bin/auth.src.mjs');
  assert.ok(normalizeEndpoint('api.mubit.ai').startsWith('https://'),
    'silently sending a key over http would be worse than failing');
});

// ---------------------------------------------------------------------------
// The browser step
// ---------------------------------------------------------------------------

test('the console URL is the documented one and is overridable for staging', async () => {
  const { CONSOLE_URL, consoleUrlFrom } = await mod('bin/auth.src.mjs');

  assert.equal(CONSOLE_URL, 'https://console.mubit.ai');
  assert.equal(consoleUrlFrom({}), 'https://console.mubit.ai');
  assert.equal(consoleUrlFrom({ MUBIT_CONSOLE_URL: 'http://localhost:4000' }),
    'http://localhost:4000');
  assert.equal(consoleUrlFrom({ MUBIT_CONSOLE_URL: '  ' }), 'https://console.mubit.ai',
    'a blank override is not an override');
});

test('a browser that will not open is not a failure — the URL is still surfaced', async () => {
  const { openConsole } = await mod('bin/auth.src.mjs');
  const printed = [];

  const res = openConsole({
    url: 'https://console.mubit.ai',
    openImpl: () => { throw new Error('no display'); },
    log: (m) => printed.push(m),
  });

  assert.equal(res.launched, false, 'it reports that it could not open one');
  assert.ok(printed.join('\n').includes('https://console.mubit.ai'),
    'over SSH there is no browser, and printing the URL is the whole fallback');
});

/**
 * The launcher `spawn`s and reports ENOENT on the *next tick*, long after `openConsole` has
 * returned — so a machine with no `open`/`xdg-open` looked like a successful launch. Nothing
 * printed the URL, and the user was left with a command that sat there and then told them
 * their workspace was still provisioning. Both halves are wrong, and both come from reading
 * a synchronous return value for an asynchronous failure.
 */
test('a launch that fails asynchronously still surfaces the URL, and still reads as failed', async () => {
  const { openConsole } = await mod('bin/auth.src.mjs');
  const printed = [];

  const res = openConsole({
    url: 'https://console.mubit.ai',
    // What `defaultOpen` does: returns cleanly, then reports the failure on a later tick.
    openImpl: (_url, onFailure) => { setTimeout(onFailure, 0); },
    log: (m) => printed.push(m),
  });

  assert.equal(res.launched, true, 'nothing has failed yet at the moment this returns');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(res.launched, false, 'and the deadline, much later, reads the settled answer');
  assert.ok(printed.join('\n').includes('https://console.mubit.ai'));
});

test('a real launch prints the URL too, so it is always copyable', async () => {
  const { openConsole } = await mod('bin/auth.src.mjs');
  const printed = [];

  openConsole({ url: 'https://console.mubit.ai', openImpl: () => {}, log: (m) => printed.push(m) });

  assert.ok(printed.join('\n').includes('https://console.mubit.ai'),
    'a tab that opened makes this redundant; a tab that silently did not makes it the only way out');
});

test('openConsole passes the console URL through untouched', async () => {
  const { openConsole } = await mod('bin/auth.src.mjs');
  const { opened, openImpl } = recorder();

  openConsole({ url: 'https://console.mubit.ai', openImpl, log: () => {} });

  assert.deepEqual(opened, ['https://console.mubit.ai']);
});

// ---------------------------------------------------------------------------
// Never leak the key
// ---------------------------------------------------------------------------

test('no result ever carries the key back in a message', async () => {
  const { verifyCredentials, authenticateWithKey } = await mod('bin/auth.src.mjs');
  const server = await fakeMubit({
    'POST /v2/control/lessons': { status: 401, json: { error: 'unauthorized' } },
  });
  const dataDir = makeDataDir();

  const results = [
    await verifyCredentials({ endpoint: server.url, apiKey: KEY, fetchImpl: fetch }),
    await authenticateWithKey({ dataDir, endpoint: server.url, apiKey: KEY, fetchImpl: fetch }),
  ];

  for (const r of results) {
    assert.ok(!JSON.stringify(r).includes(KEY),
      'these strings get printed into a transcript that gets pasted into issues');
  }
  await server.close();
});

// ---------------------------------------------------------------------------
// The CLI surface
// ---------------------------------------------------------------------------

test('the key travels in an environment variable, never in argv', async () => {
  const { KEY_ENV_VAR, main } = await mod('bin/auth.src.mjs');
  const server = await fakeMubit({ 'POST /v2/control/lessons': { json: { lessons: [] } } });
  const dataDir = makeDataDir();
  const lines = [];

  const code = await main(
    ['--paste', '--endpoint', server.url, '--json'],
    { [KEY_ENV_VAR]: KEY },
    { dataDir, fetchImpl: fetch, log: (m) => lines.push(m) },
  );

  assert.equal(code, 0);
  const out = JSON.parse(lines.join(''));
  assert.equal(out.state, 'ready');
  assert.ok(!lines.join('').includes(KEY), 'the key must not be echoed back');
  await server.close();
});

test('argv is never used to carry the key', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../bin/auth.src.mjs', import.meta.url), 'utf8'));

  assert.ok(!/['"]--key['"]/.test(src),
    'a --key flag is readable by any user on the machine via ps; use the environment');
});

test('--paste with no key set explains where to put it, and stores nothing', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const { readCredentials } = await lib('credentials.mjs');
  const dataDir = makeDataDir();
  const lines = [];

  const code = await main(['--paste'], {}, { dataDir, log: (m) => lines.push(m) });

  assert.equal(code, 1);
  assert.match(lines.join('\n'), /MUBIT_AUTH_KEY/);
  assert.deepEqual(readCredentials(dataDir), {});
});

test('--status distinguishes signed in from not, and exits accordingly', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const { writeCredentials } = await lib('credentials.mjs');
  const dataDir = makeDataDir();
  const lines = [];

  assert.equal(await main(['--status'], {}, { dataDir, log: (m) => lines.push(m) }), 1,
    'unconfigured is a non-zero exit, so a script can branch on it');

  writeCredentials(dataDir, { endpoint: 'https://api.mubit.ai', apiKey: KEY });
  assert.equal(await main(['--status'], {}, { dataDir, log: (m) => lines.push(m) }), 0);

  assert.ok(!lines.join('\n').includes(KEY), '--status reports presence, never the key itself');
  assert.match(lines.join('\n'), /api\.mubit\.ai/);
});

test('--logout removes the stored credentials', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const { writeCredentials, readCredentials } = await lib('credentials.mjs');
  const dataDir = makeDataDir();

  writeCredentials(dataDir, { endpoint: 'https://api.mubit.ai', apiKey: KEY });
  const code = await main(['--logout'], {}, { dataDir, log: () => {} });

  assert.equal(code, 0);
  assert.deepEqual(readCredentials(dataDir), {});
});

test('a failed authentication exits non-zero so the skill can tell', async () => {
  const { KEY_ENV_VAR, main } = await mod('bin/auth.src.mjs');
  const server = await fakeMubit({
    'POST /v2/control/lessons': { status: 401, json: { error: 'unauthorized' } },
  });
  const dataDir = makeDataDir();

  const code = await main(
    ['--paste', '--endpoint', server.url],
    { [KEY_ENV_VAR]: KEY },
    { dataDir, fetchImpl: fetch, log: () => {} },
  );

  assert.equal(code, 1);
  await server.close();
});

test('parseArgs defaults to the browser flow', async () => {
  const { parseArgs } = await mod('bin/auth.src.mjs');

  assert.equal(parseArgs([]).mode, 'browser', 'the zero-argument path is the good one');
  assert.equal(parseArgs(['--paste']).mode, 'paste');
  assert.equal(parseArgs(['--status']).mode, 'status');
  assert.equal(parseArgs(['--logout']).mode, 'logout');
  assert.equal(parseArgs(['--endpoint', 'https://api.mubit.ai']).endpoint, 'https://api.mubit.ai');
});

// ===========================================================================
// The browser flow — loopback + PKCE
// ===========================================================================

/**
 * A stand-in for the Mubit console.
 *
 * It does the one thing the real console must do and that the client cannot check for
 * itself: it **recomputes the S256 challenge from the verifier** and refuses the
 * exchange when they disagree. That is the entire security property of PKCE, so the
 * fake enforces it rather than rubber-stamping whatever arrives.
 */
async function fakeConsole({ key = 'mbt_issued_by_console', provisioning = false,
  mubitEndpoint = '' } = {}) {
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');

  /** code -> challenge, as the real console would keep it. */
  const issued = new Map();
  const exchanges = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/cli/token') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      exchanges.push(body);

      const expected = issued.get(body.code);
      const actual = createHash('sha256').update(String(body.verifier ?? '')).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      if (!expected || expected !== actual) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'pkce_mismatch' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      // Exactly the field set `server/api/cli/token.post.ts` returns, and nothing else.
      // The old fake was *generous* — it invented a richer payload than the real server —
      // and that is precisely what hid the missing `mubitEndpoint` from 1487 tests: the
      // console shipped no endpoint, the plugin fell back to its compiled-in default, and
      // every test passed. The console asserts the same list from its side, so a change to
      // either reddens one of them.
      res.end(JSON.stringify({
        mubitApiKey: key,
        mubitEndpoint,
        minimaUrl: 'https://harness.example.invalid',
        instanceId: 'instance-under-test',
        projectId: 'proj_1',
        namespace: 'proj_1',
        region: 'eu',
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    exchanges,
    /**
     * Play the part of the browser: read the URL the CLI wanted to open, register the
     * challenge against a fresh code, and call the loopback back.
     */
    async browse(authUrl, {
      code = 'code_ok', tamperState, sendProvisioning = provisioning, delayMs = 0,
    } = {}) {
      // `delayMs` stands in for a user who has to create an account, an org and wait out a
      // workspace coming up. It is the only way to exercise a ten-minute deadline in a suite
      // that must finish in seconds — the wait is faked, the deadline arithmetic is not.
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs).unref?.());
      const u = new URL(authUrl);
      issued.set(code, u.searchParams.get('challenge'));
      const cbPort = u.searchParams.get('port');
      const state = tamperState ?? u.searchParams.get('state');
      const q = sendProvisioning
        ? `provisioning=1&state=${encodeURIComponent(state)}`
        : `code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      return fetch(`http://127.0.0.1:${cbPort}/callback?${q}`, { redirect: 'manual' });
    },
    /** Register a code whose challenge does not match any verifier we will send. */
    poison(code) { issued.set(code, 'a-challenge-that-matches-nothing'); },
    close: () => new Promise((r) => server.close(r)),
  };
}

test('makePkce produces an S256 pair, base64url encoded', async () => {
  const { makePkce } = await mod('bin/auth.src.mjs');
  const { createHash } = await import('node:crypto');

  const { verifier, challenge } = makePkce();
  const expected = createHash('sha256').update(verifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  assert.equal(challenge, expected, 'the challenge must be S256(verifier), not the verifier');
  assert.notEqual(verifier, challenge);
  for (const s of [verifier, challenge]) {
    assert.doesNotMatch(s, /[+/=]/, 'base64url only — these travel in a query string');
    assert.ok(s.length >= 43, 'RFC 7636 wants at least 256 bits of entropy');
  }

  const second = makePkce();
  assert.notEqual(second.verifier, verifier, 'a fresh pair every time');
});

test('the browser flow returns the key the console issued', async () => {
  const { runBrowserAuth } = await mod('bin/auth.src.mjs');
  const console_ = await fakeConsole({ key: 'mbt_issued_by_console' });

  const res = await runBrowserAuth({
    consoleUrl: console_.url,
    openImpl: (url) => { console_.browse(url); },
    timeoutMs: 5000,
  });

  assert.equal(res.mubitApiKey, 'mbt_issued_by_console');
  assert.equal(res.namespace, 'proj_1');
  await console_.close();
});

/**
 * The property that makes the loopback safe. The code travels through the browser, the
 * address bar, and any redirect log along the way — so on its own it must be useless.
 * Only the process that generated the verifier can complete the exchange.
 */
test('the verifier never leaves the process; only the challenge does', async () => {
  const { runBrowserAuth } = await mod('bin/auth.src.mjs');
  const console_ = await fakeConsole();
  let authUrl = '';

  await runBrowserAuth({
    consoleUrl: console_.url,
    openImpl: (url) => { authUrl = url; console_.browse(url); },
    timeoutMs: 5000,
  });

  const params = new URL(authUrl).searchParams;
  assert.ok(params.get('challenge'), 'the challenge is what the browser carries');
  assert.equal(params.get('verifier'), null, 'the verifier must never be in the URL');

  const sent = console_.exchanges[0];
  assert.ok(sent.verifier, 'the verifier goes direct, over the back channel');
  assert.notEqual(sent.verifier, params.get('challenge'));
  await console_.close();
});

test('a code that does not match our verifier is refused by the console', async () => {
  const { runBrowserAuth } = await mod('bin/auth.src.mjs');
  const console_ = await fakeConsole();

  await assert.rejects(
    runBrowserAuth({
      consoleUrl: console_.url,
      openImpl: (url) => {
        console_.poison('stolen_code');
        const u = new URL(url);
        fetch(`http://127.0.0.1:${u.searchParams.get('port')}/callback`
          + `?code=stolen_code&state=${u.searchParams.get('state')}`, { redirect: 'manual' });
      },
      timeoutMs: 5000,
    }),
    /token exchange failed/i,
    'an intercepted code is worthless without the verifier — that is the point of PKCE',
  );
  await console_.close();
});

/**
 * `state` is the other half. Without it, any page the user visits could hit the
 * loopback with a code of its own choosing and log them into somebody else's account.
 */
test('a callback carrying the wrong state is ignored', async () => {
  const { runBrowserAuth } = await mod('bin/auth.src.mjs');
  const console_ = await fakeConsole();

  await assert.rejects(
    runBrowserAuth({
      consoleUrl: console_.url,
      openImpl: (url) => { console_.browse(url, { tamperState: 'not-our-state' }); },
      timeoutMs: 400,
    }),
    /timed out/i,
    'a mismatched state must not complete the flow',
  );
  await console_.close();
});

test('a still-provisioning workspace is retryable, not a failure', async () => {
  const { runBrowserAuth, ProvisioningPending } = await mod('bin/auth.src.mjs');
  const console_ = await fakeConsole({ provisioning: true });

  await assert.rejects(
    runBrowserAuth({
      consoleUrl: console_.url,
      openImpl: (url) => { console_.browse(url, { sendProvisioning: true }); },
      timeoutMs: 5000,
    }),
    (err) => {
      assert.ok(err instanceof ProvisioningPending,
        'a new workspace takes a minute; "run it again shortly" is the right message');
      return true;
    },
  );
  await console_.close();
});

test('a browser that never comes back times out instead of hanging', async () => {
  const { runBrowserAuth } = await mod('bin/auth.src.mjs');
  const console_ = await fakeConsole();

  const started = Date.now();
  await assert.rejects(
    runBrowserAuth({ consoleUrl: console_.url, openImpl: () => {}, timeoutMs: 150 }),
    /timed out/i,
  );
  assert.ok(Date.now() - started < 3000, 'no real sleeping in this suite');
  await console_.close();
});

test('the loopback listens only on 127.0.0.1', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../bin/auth.src.mjs', import.meta.url), 'utf8'));

  assert.match(src, /listen\(\s*0\s*,\s*['"]127\.0\.0\.1['"]/,
    'binding 0.0.0.0 would expose the callback to the whole network for the length of the flow');
});

test('the callback sends the browser back to the console, not to a blank page', async () => {
  const { runBrowserAuth } = await mod('bin/auth.src.mjs');
  const console_ = await fakeConsole();
  let redirect;

  await runBrowserAuth({
    consoleUrl: console_.url,
    openImpl: async (url) => { redirect = await console_.browse(url); },
    timeoutMs: 5000,
  });

  assert.equal(redirect.status, 302);
  assert.match(redirect.headers.get('location'), /\/app\/cli-auth\?status=authorized/);
  await console_.close();
});

test('the auth URL carries the context the console needs to provision', async () => {
  const { runBrowserAuth } = await mod('bin/auth.src.mjs');
  const console_ = await fakeConsole();
  let authUrl = '';

  await runBrowserAuth({
    consoleUrl: console_.url,
    repo: 'github.com/mubit-ai/claude-plugins',
    host: 'test-host',
    openImpl: (url) => { authUrl = url; console_.browse(url); },
    timeoutMs: 5000,
  });

  const u = new URL(authUrl);
  assert.equal(u.pathname, '/app/cli-auth');
  assert.equal(u.searchParams.get('repo'), 'github.com/mubit-ai/claude-plugins');
  assert.equal(u.searchParams.get('host'), 'test-host');
  assert.ok(Number(u.searchParams.get('port')) > 0);
  await console_.close();
});

/**
 * `/app/cli-auth` is shared: a second CLI client drives the same page with the same
 * parameters, and neither client sent a name until this. So the console cannot brand its
 * copy for Claude Code unless it is told, and `client` is how it is told.
 *
 * Purely additive. The console's neutral wording has to stay for every already-installed
 * copy of this plugin, which will keep omitting the parameter forever.
 */
test('the auth URL names this client, so the console can address it by name', async () => {
  const { runBrowserAuth } = await mod('bin/auth.src.mjs');
  const console_ = await fakeConsole();
  let authUrl = '';

  await runBrowserAuth({
    consoleUrl: console_.url,
    openImpl: (url) => { authUrl = url; console_.browse(url); },
    timeoutMs: 5000,
  });

  assert.equal(new URL(authUrl).searchParams.get('client'), 'claude-code');
  await console_.close();
});

test('the loopback port is released once the flow ends', async () => {
  const { runBrowserAuth } = await mod('bin/auth.src.mjs');
  const { createServer } = await import('node:http');
  const console_ = await fakeConsole();
  let port = 0;

  await runBrowserAuth({
    consoleUrl: console_.url,
    openImpl: (url) => { port = Number(new URL(url).searchParams.get('port')); console_.browse(url); },
    timeoutMs: 5000,
  });

  // If the listener were still up, binding the same port would throw EADDRINUSE.
  const probe = createServer();
  await new Promise((res, rej) => {
    probe.once('error', rej);
    probe.listen(port, '127.0.0.1', res);
  });
  await new Promise((r) => probe.close(r));
  await console_.close();
});

// ---------------------------------------------------------------------------
// Mapping the console's answer onto the plugin's two settings
// ---------------------------------------------------------------------------

test('endpointFor trusts an explicit endpoint, and never invents a host from a region', async () => {
  const { endpointFor, DEFAULT_ENDPOINT } = await mod('bin/auth.src.mjs');

  // eu.mubit.ai and us.mubit.ai are NXDOMAIN. Mapping a region onto one of them stored an
  // endpoint that could never answer, and the failure surfaced far from the sign-in.
  for (const region of ['eu', 'us', 'EU', 'moon']) {
    assert.equal(endpointFor({ region }), DEFAULT_ENDPOINT,
      `region ${region} is a console routing hint, not a hostname this side may invent`);
  }
  assert.equal(endpointFor({}), DEFAULT_ENDPOINT, 'no region means the default, not an error');
  assert.equal(DEFAULT_ENDPOINT, 'https://api.mubit.ai', 'the only host that resolves');
  assert.equal(endpointFor({ mubitEndpoint: 'https://custom.example.com' }),
    'https://custom.example.com', 'an explicit endpoint from the console always wins');
  assert.equal(endpointFor({ mubitEndpoint: 'https://custom.example.com', region: 'eu' }),
    'https://custom.example.com', 'an explicit endpoint outranks a region');
});

/**
 * The contract, from this side. `server/api/cli/token.post.ts` asserts the same list from
 * its own side, so the two cannot drift silently: whichever one moves, the other goes red.
 *
 * This test is here because the generous fake it replaces is the entire reason the missing
 * `mubitEndpoint` survived a 1487-test suite. A double that returns more than the real thing
 * proves the parser works and nothing about the contract.
 */
test('the console double returns exactly the field set the real console returns', async () => {
  const { runBrowserAuth } = await mod('bin/auth.src.mjs');
  const console_ = await fakeConsole({ mubitEndpoint: 'https://eu.api.mubit.ai' });

  const payload = await runBrowserAuth({
    consoleUrl: console_.url,
    openImpl: (url) => { console_.browse(url); },
    timeoutMs: 5000,
  });

  assert.deepEqual(Object.keys(payload).sort(), [
    'instanceId', 'minimaUrl', 'mubitApiKey', 'mubitEndpoint', 'namespace', 'projectId', 'region',
  ]);
  await console_.close();
});

/**
 * Pinning the fallback as a decision rather than an oversight.
 *
 * A console old enough not to send `mubitEndpoint` still has to work, and the default is not
 * a guess: probing production showed `api.mubit.ai` is a key-routed shared gateway —
 * `/v2/core/health` answers 200 for keys belonging to different instances — so the bearer
 * token, not the hostname, selects the instance. Making an absent endpoint fatal would break
 * users on an older console to fix nothing.
 */
test('an older console that sends no endpoint still gets a working default', async () => {
  const { main, DEFAULT_ENDPOINT } = await mod('bin/auth.src.mjs');
  const { readCredentials } = await lib('credentials.mjs');
  const console_ = await fakeConsole({ key: 'mbt_from_old_console' });   // mubitEndpoint: ''
  const dataDir = makeDataDir();
  const lines = [];

  // `fetchImpl` answers the default endpoint, which the test cannot dial for real.
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(String(url));
    if (String(url).startsWith(DEFAULT_ENDPOINT)) {
      return new Response(String(url).endsWith('/health') ? 'OK' : '{}', { status: 200 });
    }
    return fetch(url, init);
  };

  const code = await main(['--json'], { MUBIT_CONSOLE_URL: console_.url }, {
    dataDir, fetchImpl, log: (m) => lines.push(m), timeoutMs: 5000,
    openImpl: (url) => { console_.browse(url); },
  });

  assert.equal(code, 0, lines.join('\n'));
  assert.equal(readCredentials(dataDir).endpoint, DEFAULT_ENDPOINT);
  assert.ok(seen.some((u) => u.startsWith(DEFAULT_ENDPOINT)), 'and it was checked, not assumed');
  await console_.close();
});

/**
 * The console may name an endpoint this side must not store.
 *
 * Measured against production on 2026-08-28: the platform API's `/location` route reports
 * `MUBIT_REGIONAL_HTTP_ENDPOINT`, and the prod overlays set that to **`http://api.eu.mubit.ai`
 * / `http://api.us.mubit.ai`** — plain HTTP. Probed directly, those two hosts answer 401 over
 * HTTP and fail the TLS handshake outright over HTTPS, so there is no TLS listener there at
 * all. `api.mubit.ai` answers 401 over HTTPS.
 *
 * Storing what the console said would put `Authorization: Bearer mbt_…` on the wire in clear
 * text on every hook of every session. Upgrading the scheme instead would store an endpoint
 * that cannot connect. So a plaintext endpoint is *declined*, and the fallback — the shared
 * gateway, which serves TLS and routes by bearer key — is what the plugin already used before
 * any of this. The regional endpoints start being used the moment they serve HTTPS; nothing
 * here needs to change for that.
 *
 * `normalizeEndpoint` has said the same thing about user input since it was written:
 * "silently downgrading the transport a credential travels over is worse than refusing to
 * guess". The console is not a more trusted source than the user for this.
 */
test('a plaintext endpoint from the console is declined, not stored', async () => {
  const { endpointFor, DEFAULT_ENDPOINT } = await mod('bin/auth.src.mjs');

  for (const named of [
    'http://api.eu.mubit.ai',        // what production reports today
    'http://api.us.mubit.ai',
    'http://internal.cluster.local:8080',
  ]) {
    assert.equal(endpointFor({ mubitEndpoint: named }), DEFAULT_ENDPOINT,
      `${named} would carry the key in clear text`);
  }

  assert.equal(endpointFor({ mubitEndpoint: 'https://api.eu.mubit.ai' }), 'https://api.eu.mubit.ai',
    'the same host over TLS is exactly what this is waiting for');
});

/**
 * Loopback is the exception, and the only one: plaintext to 127.0.0.1 does not cross a
 * network. Local development and `tests/e2e/cli-auth.spec.ts` both depend on it.
 */
test('a loopback endpoint is kept, because plaintext there crosses nothing', async () => {
  const { endpointFor } = await mod('bin/auth.src.mjs');

  for (const named of [
    'http://127.0.0.1:8788', 'http://localhost:3000', 'http://[::1]:8080',
  ]) {
    assert.equal(endpointFor({ mubitEndpoint: named }), named.replace(/\/+$/, ''));
  }
});

// ---------------------------------------------------------------------------
// main() through the browser path
// ---------------------------------------------------------------------------

test('main() browser flow: signs in, verifies, and stores — with no key in the output', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const { readCredentials } = await lib('credentials.mjs');
  const server = await fakeMubit({ 'POST /v2/control/lessons': { json: { lessons: [] } } });
  const console_ = await fakeConsole({ key: 'mbt_from_browser_flow' });
  const dataDir = makeDataDir();
  const lines = [];

  // The console hands back region "eu"; --endpoint pins it at the fake instance so the
  // verification step has something real to talk to.
  const code = await main(
    ['--endpoint', server.url, '--json'],
    { MUBIT_CONSOLE_URL: console_.url },
    {
      dataDir, fetchImpl: fetch, log: (m) => lines.push(m), timeoutMs: 5000,
      openImpl: (url) => { console_.browse(url); },
    },
  );

  assert.equal(code, 0, lines.join('\n'));
  assert.deepEqual(readCredentials(dataDir), { endpoint: server.url, apiKey: 'mbt_from_browser_flow' });
  assert.ok(!lines.join('\n').includes('mbt_from_browser_flow'),
    'the whole point of the browser flow is that the key never appears in the transcript');
  await console_.close();
  await server.close();
});

/**
 * The half that was broken end to end: the console names an endpoint and the plugin stores
 * it. Every other browser-flow test pins `--endpoint`, so none of them could have caught the
 * console not sending one.
 */
test('main() stores the endpoint the console named, not its own default', async () => {
  const { main, DEFAULT_ENDPOINT } = await mod('bin/auth.src.mjs');
  const { readCredentials } = await lib('credentials.mjs');
  const instance = await fakeMubit({ 'POST /v2/control/lessons': { json: { lessons: [] } } });
  const console_ = await fakeConsole({ key: 'mbt_regional', mubitEndpoint: instance.url });
  const dataDir = makeDataDir();
  const lines = [];

  const code = await main(['--json'], { MUBIT_CONSOLE_URL: console_.url }, {
    dataDir, fetchImpl: fetch, log: (m) => lines.push(m), timeoutMs: 5000,
    openImpl: (url) => { console_.browse(url); },
  });

  assert.equal(code, 0, lines.join('\n'));
  assert.equal(readCredentials(dataDir).endpoint, instance.url);
  assert.notEqual(instance.url, DEFAULT_ENDPOINT, 'the test would be vacuous otherwise');
  await console_.close();
  await instance.close();
});

test('main() reports a still-provisioning workspace as retryable, with its own exit code', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const console_ = await fakeConsole({ provisioning: true });
  const dataDir = makeDataDir();
  const lines = [];

  const code = await main(
    ['--json'],
    { MUBIT_CONSOLE_URL: console_.url },
    {
      dataDir, fetchImpl: fetch, log: (m) => lines.push(m), timeoutMs: 5000,
      openImpl: (url) => { console_.browse(url, { sendProvisioning: true }); },
    },
  );

  assert.equal(code, 2, 'distinct from 1, so the skill can say "wait" instead of "fix something"');
  assert.equal(JSON.parse(lines.join('')).state, 'provisioning');
  await console_.close();
});

/**
 * How long a human actually needs.
 *
 * The default was two minutes, chosen for "sign in and pick an instance". The user this
 * command exists for is doing more than that: creating an account, creating an org, and then
 * waiting out a workspace that takes a minute or two on its own — and the console now waits
 * for that workspace rather than bouncing. Two minutes fails a flow that is working.
 *
 * Ten is the ceiling, not a guess: a Bash tool call is killed at 600 s at the outside, so a
 * client deadline above that could never be reached. `skills/auth/SKILL.md` sets the tool's
 * own timeout to match — without that the harness kills this at 120 s and the change is inert.
 */
test('the browser deadline is ten minutes, matching the longest a tool call can run', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const { readCredentials } = await lib('credentials.mjs');
  const instance = await fakeMubit({ 'POST /v2/control/lessons': { json: { lessons: [] } } });
  const console_ = await fakeConsole({ key: 'mbt_slow_signup', mubitEndpoint: instance.url });
  const dataDir = makeDataDir();
  const lines = [];

  const started = Date.now();
  const code = await main(['--json'], { MUBIT_CONSOLE_URL: console_.url }, {
    dataDir, fetchImpl: fetch, log: (m) => lines.push(m),
    // The deadline is shrunk for the test; the point is that the flow survives a callback
    // arriving long after the old 120 s default would have given up.
    timeoutMs: 5000,
    openImpl: (url) => { console_.browse(url, { delayMs: 300 }); },
  });

  assert.equal(code, 0, lines.join('\n'));
  assert.equal(readCredentials(dataDir).apiKey, 'mbt_slow_signup');
  assert.ok(Date.now() - started < 4000, 'no real sleeping in this suite');
  await console_.close();
  await instance.close();
});

test('the shipped default deadline is 600000 ms, and the environment still overrides it', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const console_ = await fakeConsole();
  const lines = [];

  // Nothing opens, so the flow runs to its deadline. `MUBIT_CC_AUTH_TIMEOUT_MS` has to still
  // work, or every test in this file that relies on it would sit out ten minutes.
  const started = Date.now();
  await main(['--json'], { MUBIT_CONSOLE_URL: console_.url, MUBIT_CC_AUTH_TIMEOUT_MS: '120' },
    { dataDir: makeDataDir(), fetchImpl: fetch, log: (m) => lines.push(m), openImpl: () => {} });
  assert.ok(Date.now() - started < 3000);

  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../bin/auth.src.mjs', import.meta.url), 'utf8'));
  assert.match(src, /raw > 0 \? raw : 600000/,
    'a Bash tool call is killed at 600 s at the outside, so nothing above it is reachable');
  await console_.close();
});

/**
 * A browser that opened and a browser that never existed are different problems.
 *
 * Timing out after the console page was reached means the sign-up is still in flight, or the
 * workspace is still coming up — the same command, run again, finishes it. Reporting that as
 * `browser_failed` sent the user off to issue a key by hand to fix a flow that was working.
 * The SSH case, where nothing could be opened at all, keeps exit 1 and the paste route.
 */
test('a timeout after the browser opened is retryable, not a browser failure', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const console_ = await fakeConsole();
  const lines = [];

  const code = await main(
    ['--json'],
    { MUBIT_CONSOLE_URL: console_.url, MUBIT_CC_AUTH_TIMEOUT_MS: '150' },
    // A browser opened — it just never came back in time.
    { dataDir: makeDataDir(), fetchImpl: fetch, log: (m) => lines.push(m), openImpl: () => true },
  );

  assert.equal(code, 2, 'the retryable exit code, not the fix-something one');
  assert.equal(JSON.parse(lines.join('')).state, 'provisioning');
  await console_.close();
});

test('a machine with no browser at all still gets the paste route', async () => {
  const { main, KEY_ENV_VAR } = await mod('bin/auth.src.mjs');
  const console_ = await fakeConsole();
  const lines = [];

  const code = await main(
    ['--json'],
    { MUBIT_CONSOLE_URL: console_.url, MUBIT_CC_AUTH_TIMEOUT_MS: '150' },
    {
      dataDir: makeDataDir(), fetchImpl: fetch, log: (m) => lines.push(m),
      openImpl: () => { throw new Error('no xdg-open here'); },
    },
  );

  assert.equal(code, 1, 'over SSH there is nothing to wait for — waiting again would not help');
  const out = JSON.parse(lines.join(''));
  assert.equal(out.state, 'browser_failed');
  assert.match(out.detail, new RegExp(KEY_ENV_VAR));
  await console_.close();
});

/**
 * The authorize URL is printed on every run now, and `--json` callers parse the verdict. They
 * are two streams for a reason: progress on stderr, exactly one JSON object on stdout.
 */
test('--json puts nothing but the verdict on the log channel', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const instance = await fakeMubit({ 'POST /v2/control/lessons': { json: { lessons: [] } } });
  const console_ = await fakeConsole({ key: 'mbt_k', mubitEndpoint: instance.url });
  const lines = [];
  const progress = [];

  const code = await main(['--json'], { MUBIT_CONSOLE_URL: console_.url }, {
    dataDir: makeDataDir(), fetchImpl: fetch, timeoutMs: 5000,
    log: (m) => lines.push(m), logProgress: (m) => progress.push(m),
    openImpl: (url) => { console_.browse(url); },
  });

  assert.equal(code, 0, [...progress, ...lines].join('\n'));
  assert.equal(lines.length, 1);
  assert.doesNotThrow(() => JSON.parse(lines[0]));
  assert.match(progress.join('\n'), /\/app\/cli-auth\?/, 'the URL is still surfaced, just not there');
  await console_.close();
  await instance.close();
});


// ===========================================================================
// Which directory the credentials land in
// ===========================================================================

/**
 * This is the rung nothing used to cover.
 *
 * Every other test in this file injects `deps.dataDir`, so `resolveDataDirFrom()` — the code
 * that runs on the only path a user ever takes — had zero coverage. It matters more than the
 * rest put together: a sign-in that stores a good key in a directory no hook reads is
 * indistinguishable, from the user's side, from a sign-in that failed.
 *
 * The skill invokes this command through Bash, and a Bash tool call gets
 * `CLAUDE_PLUGIN_DATA=""` — measured, not assumed. So the environment rung is not available
 * where it is needed and the answer has to be passed in as `--data-dir`, interpolated by the
 * host into the skill body.
 */

/** A `$HOME` with the named `mubit-memory*` directories, and credentials in some of them. */
function homeWithDataDirs(dirs = {}) {
  const home = tempDir('mubit-auth-home-');
  const root = join(home, '.claude', 'plugins', 'data');
  for (const [name, spec] of Object.entries(dirs)) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    if (spec.endpoint) {
      writeFileSync(join(dir, 'credentials.json'),
        JSON.stringify({ endpoint: spec.endpoint, apiKey: KEY }));
    }
  }
  return { home, root };
}

/**
 * `--status` reads the resolved directory and reports its endpoint, so it is a
 * network-free probe for "which directory did the resolver choose?".
 * @returns {Promise<string>}
 */
async function resolvedEndpoint(argv, env) {
  const { main } = await mod('bin/auth.src.mjs');
  const lines = [];
  await main([...argv, '--status', '--json'], env, { log: (m) => lines.push(m) });
  return JSON.parse(lines.join('')).endpoint;
}

test('the data directory resolver walks every rung, in order', async () => {
  const { home, root } = homeWithDataDirs({
    'mubit-memory': {},
    'mubit-memory-mubit': { endpoint: 'https://found-by-search.example' },
  });
  const pinned = makeDataDir();
  writeFileSync(join(pinned, 'credentials.json'),
    JSON.stringify({ endpoint: 'https://pinned.example', apiKey: KEY }));
  const fromHost = makeDataDir();
  writeFileSync(join(fromHost, 'credentials.json'),
    JSON.stringify({ endpoint: 'https://from-host.example', apiKey: KEY }));
  const fromFlag = makeDataDir();
  writeFileSync(join(fromFlag, 'credentials.json'),
    JSON.stringify({ endpoint: 'https://from-flag.example', apiKey: KEY }));

  /** @type {Array<{name: string, argv: string[], env: Record<string,string>, want: string}>} */
  const table = [
    {
      name: '--data-dir outranks everything: it is what the host interpolated into the skill',
      argv: ['--data-dir', fromFlag],
      env: { HOME: home, MUBIT_CC_DATA_DIR: pinned, CLAUDE_PLUGIN_DATA: fromHost },
      want: 'https://from-flag.example',
    },
    {
      name: 'MUBIT_CC_DATA_DIR next — setup recorded it, so it is not a guess',
      argv: [],
      env: { HOME: home, MUBIT_CC_DATA_DIR: pinned, CLAUDE_PLUGIN_DATA: fromHost },
      want: 'https://pinned.example',
    },
    {
      name: 'CLAUDE_PLUGIN_DATA next, for the processes the host does launch itself',
      argv: [],
      env: { HOME: home, CLAUDE_PLUGIN_DATA: fromHost },
      want: 'https://from-host.example',
    },
    {
      name: 'the search last, and it finds the suffixed directory the hooks use',
      argv: [],
      env: { HOME: home },
      want: 'https://found-by-search.example',
    },
  ];

  for (const row of table) {
    assert.equal(await resolvedEndpoint(row.argv, row.env), row.want, row.name);
  }
  assert.ok(root);
});

test('an empty or uninterpolated --data-dir is ignored, not used as a path', async () => {
  const { home } = homeWithDataDirs({
    'mubit-memory-mubit': { endpoint: 'https://found-by-search.example' },
  });

  // A host that does not know the variable leaves the placeholder in the argument verbatim.
  // Taking it literally would create `./${CLAUDE_PLUGIN_DATA}/credentials.json` under
  // whatever directory the session happened to be in, and report success.
  for (const bad of ['', '${CLAUDE_PLUGIN_DATA}', '${MUBIT_CC_DATA_DIR}']) {
    assert.equal(
      await resolvedEndpoint(['--data-dir', bad], { HOME: home }),
      'https://found-by-search.example',
      `--data-dir ${JSON.stringify(bad)} must fall through to the next rung`,
    );
  }
});

test('parseArgs exposes --data-dir', async () => {
  const { parseArgs } = await mod('bin/auth.src.mjs');
  assert.equal(parseArgs(['--data-dir', '/somewhere']).dataDir, '/somewhere');
  assert.equal(parseArgs([]).dataDir, undefined);
});

/**
 * The acceptance criterion for the whole fix, stated where a reader will find it: a
 * first-ever sign-in, in the environment a Bash tool call actually has, writes exactly one
 * `credentials.json`, and it is in the directory the host points its hooks at.
 */
test('a first-ever sign-in writes to the suffixed directory and never creates the bare one', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const server = await fakeMubit({ 'POST /v2/control/lessons': { json: { lessons: [] } } });
  const console_ = await fakeConsole({ key: 'mbt_first_ever_signin' });
  const { home, root } = homeWithDataDirs({ 'mubit-memory': {}, 'mubit-memory-mubit': {} });
  const lines = [];

  const code = await main(
    ['--endpoint', server.url, '--json'],
    // Exactly what a Bash tool call gets: no CLAUDE_PLUGIN_DATA, no MUBIT_CC_DATA_DIR.
    { HOME: home, MUBIT_CONSOLE_URL: console_.url },
    {
      fetchImpl: fetch, log: (m) => lines.push(m), timeoutMs: 5000,
      openImpl: (url) => { console_.browse(url); },
    },
  );

  assert.equal(code, 0, lines.join('\n'));
  assert.ok(existsSync(join(root, 'mubit-memory-mubit', 'credentials.json')),
    'the key must land where the hooks read');
  assert.equal(existsSync(join(root, 'mubit-memory', 'credentials.json')), false,
    'the bare name is not a directory any host hands a hook');
  await console_.close();
  await server.close();
});
