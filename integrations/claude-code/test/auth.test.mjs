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
import { fakeConsole } from './helpers/fake-console.mjs';

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

test('the candidates never invent a host from a region', async () => {
  const { endpointCandidatesFor, DEFAULT_ENDPOINT } = await mod('bin/auth.src.mjs');

  // eu.mubit.ai and us.mubit.ai are NXDOMAIN. Mapping a region onto one of them stored an
  // endpoint that could never answer, and the failure surfaced far from the sign-in.
  for (const region of ['eu', 'us', 'EU', 'moon']) {
    assert.deepEqual(endpointCandidatesFor({ region }), [DEFAULT_ENDPOINT],
      `region ${region} is a console routing hint, not a hostname this side may invent`);
  }
  assert.equal(DEFAULT_ENDPOINT, 'https://api.mubit.ai', 'the only prod host that serves TLS');
  assert.equal(endpointCandidatesFor({ mubitEndpoint: 'https://custom.example.com' })[0],
    'https://custom.example.com', 'an explicit endpoint from the console is tried first');
  assert.equal(endpointCandidatesFor({ mubitEndpoint: 'https://custom.example.com', region: 'eu' })[0],
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
 * The console may name an endpoint this side must not send a key to — and the answer is
 * not to throw the whole answer away.
 *
 * Measured on 2026-08-28, in two clusters, and they disagree in a way that decides this:
 *
 *   api.eu.dev.mubit.ai   https -> 401   http -> 308 to https
 *   api.eu.mubit.ai       https -> TLS handshake fails   http -> 401
 *   api.mubit.ai          https -> 401
 *
 * Both clusters *report* `http://`, because that is what their platform-api has in
 * `MUBIT_REGIONAL_HTTP_ENDPOINT`. So a plaintext answer says nothing about whether the host
 * serves TLS: dev's does, prod's does not.
 *
 * Declining outright and falling back was wrong for dev in a way a real run showed: the key
 * went to `api.mubit.ai` — a *different cluster* — which rejected it, and the user was told
 * "the instance rejected that key. Issue a new one in the console." There is nothing wrong
 * with the key, and no new one will help.
 *
 * So the scheme is upgraded and the host is kept, and the compiled-in gateway follows it as
 * a fallback. The key is verified against each in turn and stored against the first that
 * accepts it, which is machinery this already had. Dev works today; prod's TLS failure falls
 * through to the gateway that has always served it. Neither ever sees plaintext.
 */
test('a plaintext endpoint is upgraded and tried first, with the gateway behind it', async () => {
  const { endpointCandidatesFor, DEFAULT_ENDPOINT } = await mod('bin/auth.src.mjs');

  assert.deepEqual(
    endpointCandidatesFor({ mubitEndpoint: 'http://api.eu.dev.mubit.ai' }),
    ['https://api.eu.dev.mubit.ai', DEFAULT_ENDPOINT],
    'dev serves TLS on that exact host, so the upgrade is what makes dev work at all');

  assert.deepEqual(
    endpointCandidatesFor({ mubitEndpoint: 'http://api.eu.mubit.ai' }),
    ['https://api.eu.mubit.ai', DEFAULT_ENDPOINT],
    'prod has no TLS listener there yet, so this one falls through to the gateway');

  assert.deepEqual(
    endpointCandidatesFor({ mubitEndpoint: 'https://custom.example.com' }),
    ['https://custom.example.com', DEFAULT_ENDPOINT]);

  assert.deepEqual(endpointCandidatesFor({}), [DEFAULT_ENDPOINT],
    'an older console that sends nothing still gets the working default');

  assert.deepEqual(endpointCandidatesFor({ mubitEndpoint: DEFAULT_ENDPOINT }), [DEFAULT_ENDPOINT],
    'no point verifying the same endpoint twice');
});

/** The point of the upgrade is that nothing is ever *tried* in clear text. */
test('no candidate ever carries the key over plaintext to a real network', async () => {
  const { endpointCandidatesFor } = await mod('bin/auth.src.mjs');

  for (const named of [
    'http://api.eu.mubit.ai', 'http://api.us.mubit.ai', 'http://internal.cluster.local:8080',
    'api.eu.mubit.ai', 'HTTP://Api.EU.Mubit.AI',
  ]) {
    for (const candidate of endpointCandidatesFor({ mubitEndpoint: named })) {
      assert.ok(candidate.startsWith('https://'),
        `${named} produced ${candidate}, which would put the key on the wire in clear text`);
    }
  }
});

/**
 * Loopback is the exception, and the only one: plaintext to 127.0.0.1 does not cross a
 * network, and there is rarely a TLS listener there to upgrade to. Local development and
 * `tests/e2e/cli-auth.spec.ts` both depend on it.
 */
test('a loopback endpoint is kept as-is, because plaintext there crosses nothing', async () => {
  const { endpointCandidatesFor } = await mod('bin/auth.src.mjs');

  for (const named of [
    'http://127.0.0.1:8788', 'http://localhost:3000', 'http://[::1]:8080',
  ]) {
    assert.equal(endpointCandidatesFor({ mubitEndpoint: named })[0], named.replace(/\/+$/, ''),
      'upgrading this one would break every local run');
  }
});

/**
 * The candidates are *verified*, not guessed between. This is the behaviour a real dev-cluster
 * run needed: the first candidate is unreachable, and the user still ends up signed in rather
 * than being told their key is bad.
 */
test('the first endpoint that accepts the key is the one stored', async () => {
  const { authenticateAcrossEndpoints, currentCredentials } = await mod('bin/auth.src.mjs');
  const dir = tempDir('mubit-endpoint-fallback-');
  const tried = [];

  const res = await authenticateAcrossEndpoints({
    dataDir: dir,
    endpoints: ['https://no-tls.example', 'https://gateway.example'],
    apiKey: 'mbt_a_b_c',
    // Verification makes more than one request per endpoint; what this asserts is which
    // endpoints were reached, and in what order, not how many calls each one costs.
    fetchImpl: async (url) => {
      const origin = new URL(url).origin;
      if (tried.at(-1) !== origin) tried.push(origin);
      if (url.startsWith('https://no-tls.example')) throw new Error('tlsv1 alert protocol version');
      return new Response('{}', { status: 200 });
    },
  });

  assert.equal(res.ok, true);
  assert.equal(res.endpoint, 'https://gateway.example');
  assert.deepEqual(tried, ['https://no-tls.example', 'https://gateway.example'],
    'in order, and the second is only reached because the first failed');
  assert.equal(currentCredentials(dir).endpoint, 'https://gateway.example',
    'stored against the endpoint that actually answered, not the one the console named');
});

test('a later endpoint is never tried once one has accepted the key', async () => {
  const { authenticateAcrossEndpoints, DEFAULT_ENDPOINT } = await mod('bin/auth.src.mjs');
  const tried = [];

  const res = await authenticateAcrossEndpoints({
    dataDir: tempDir('mubit-endpoint-first-'),
    endpoints: ['https://mine.example', DEFAULT_ENDPOINT],
    apiKey: 'mbt_a_b_c',
    fetchImpl: async (url) => {
      const origin = new URL(url).origin;
      if (tried.at(-1) !== origin) tried.push(origin);
      return new Response('{}', { status: 200 });
    },
  });

  assert.equal(res.endpoint, 'https://mine.example');
  assert.deepEqual(tried, ['https://mine.example'],
    'the fallback is a fallback, not a second request every user pays for');
});

/**
 * When every candidate refuses the key, the failure reported is the *console's own* answer.
 * The fallback failing too is the less interesting half: it is the endpoint the operator
 * configured that the user or an operator has to go look at.
 */
test('when nothing accepts the key, the console\'s own endpoint is the one reported', async () => {
  const { authenticateAcrossEndpoints } = await mod('bin/auth.src.mjs');

  const res = await authenticateAcrossEndpoints({
    dataDir: tempDir('mubit-endpoint-allfail-'),
    endpoints: ['https://named.example', 'https://gateway.example'],
    apiKey: 'mbt_a_b_c',
    fetchImpl: async () => new Response('{}', { status: 401 }),
  });

  assert.equal(res.ok, false);
  assert.equal(res.endpoint, 'https://named.example');
  assert.equal(res.stored, false);
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

// ===========================================================================
// The matrix nothing covered: bad env values, failed exchanges, and the edges
// ===========================================================================

/**
 * `MUBIT_CC_AUTH_TIMEOUT_MS` is read straight from the environment, and the environment
 * can say anything. `Number('abc')` is NaN, and `setTimeout(fn, NaN)` fires *now* — so a
 * mis-set variable would silently re-introduce the instant-timeout bug the 600 s default
 * exists to fix, and it would look exactly like "the browser flow never works on this
 * machine". Every unusable value must land on the shipped default, never on zero.
 */
test('an unusable auth timeout falls back to ten minutes, never to an instant one', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const { readCredentials } = await lib('credentials.mjs');

  for (const raw of ['abc', '', '0', '-5', 'NaN']) {
    const instance = await fakeMubit({ 'POST /v2/control/lessons': { json: { lessons: [] } } });
    const console_ = await fakeConsole({ key: 'mbt_survives_bad_timeout', mubitEndpoint: instance.url });
    const dataDir = makeDataDir();
    const lines = [];

    // No deps.timeoutMs: the env rung is the one under test. The browse lands ~50 ms in,
    // which a 600 s deadline survives and an instant one does not.
    const code = await main(['--json'],
      { MUBIT_CONSOLE_URL: console_.url, MUBIT_CC_AUTH_TIMEOUT_MS: raw },
      {
        dataDir, fetchImpl: fetch, log: (m) => lines.push(m),
        openImpl: (url) => { console_.browse(url, { delayMs: 50 }); },
      });

    assert.equal(code, 0,
      `MUBIT_CC_AUTH_TIMEOUT_MS=${JSON.stringify(raw)} must fall back, not fire instantly: ${lines.join('\n')}`);
    assert.equal(readCredentials(dataDir).apiKey, 'mbt_survives_bad_timeout');
    await console_.close();
    await instance.close();
  }
});

/**
 * The console's side of the exchange can fail in every way an HTTP service can, and the
 * flow's job is the same in all of them: exit 1, offer the paste route, store nothing.
 * The malformed-JSON row is the sharp one — `res.json()` throwing must not put a parser's
 * `Unexpected token` line in front of a user as if it were an explanation.
 */
test('a failed token exchange offers the paste route and stores nothing', async () => {
  const { main, KEY_ENV_VAR } = await mod('bin/auth.src.mjs');
  const { readCredentials } = await lib('credentials.mjs');

  /** @type {Array<[string, Record<string, any>]>} */
  const rows = [
    ['HTTP 400', { tokenStatus: 400 }],
    ['HTTP 500', { tokenStatus: 500 }],
    ['malformed JSON', { rawBody: '<!DOCTYPE html><p>service temporarily unavailable</p>' }],
    ['missing key field', { omitKey: true }],
    ['empty key', { key: '' }],
  ];

  for (const [name, consoleOpts] of rows) {
    const console_ = await fakeConsole(consoleOpts);
    const dataDir = makeDataDir();
    const lines = [];

    const code = await main(['--json'], { MUBIT_CONSOLE_URL: console_.url }, {
      dataDir, fetchImpl: fetch, log: (m) => lines.push(m), timeoutMs: 5000,
      openImpl: (url) => { console_.browse(url); },
    });

    assert.equal(code, 1, `${name}: a failed exchange is a failure, not a retry`);
    const out = JSON.parse(lines.join(''));
    assert.equal(out.state, 'browser_failed', name);
    assert.match(out.detail, new RegExp(KEY_ENV_VAR), `${name}: the paste route is the way out`);
    assert.ok(!out.detail.includes('Unexpected token'),
      `${name}: a JSON parser's complaint is not a user message — got: ${out.detail}`);
    assert.deepEqual(readCredentials(dataDir), {}, `${name}: nothing may be stored`);
    await console_.close();
  }
});

test('a console that refuses the exchange connection fails to the paste route', async () => {
  const { main, KEY_ENV_VAR } = await mod('bin/auth.src.mjs');
  const { readCredentials } = await lib('credentials.mjs');
  const { createServer } = await import('node:http');

  // A port that was just listening and now refuses: bind, note, close.
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', () => r(undefined)));
  const deadPort = /** @type {any} */ (probe.address()).port;
  await new Promise((r) => probe.close(() => r(undefined)));

  const dataDir = makeDataDir();
  const lines = [];
  const code = await main(['--json'],
    { MUBIT_CONSOLE_URL: `http://127.0.0.1:${deadPort}` },
    {
      dataDir, fetchImpl: fetch, log: (m) => lines.push(m), timeoutMs: 5000,
      // The "browser" can still reach the loopback; only the console is gone.
      openImpl: (url) => {
        const u = new URL(url);
        fetch(`http://127.0.0.1:${u.searchParams.get('port')}/callback`
          + `?code=c&state=${u.searchParams.get('state')}`, { redirect: 'manual' });
      },
    });

  assert.equal(code, 1);
  const out = JSON.parse(lines.join(''));
  assert.equal(out.state, 'browser_failed');
  assert.match(out.detail, new RegExp(KEY_ENV_VAR));
  assert.deepEqual(readCredentials(dataDir), {});
});

/**
 * A callback that carries our `state` but no `code` and no `provisioning=1` is a console
 * mid-flow, not a success — the old consoles' explicit `provisioning=1` and this are the
 * same situation, and both must come back retryable with nothing on disk.
 */
test('a callback with state but no code is still-provisioning, and stores nothing', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const { readCredentials } = await lib('credentials.mjs');
  const console_ = await fakeConsole();
  const dataDir = makeDataDir();
  const lines = [];

  const code = await main(['--json'], { MUBIT_CONSOLE_URL: console_.url }, {
    dataDir, fetchImpl: fetch, log: (m) => lines.push(m), timeoutMs: 5000,
    openImpl: (url) => { console_.browse(url, { omitCode: true }); },
  });

  assert.equal(code, 2, 'the retryable exit code, not the fix-something one');
  assert.equal(JSON.parse(lines.join('')).state, 'provisioning');
  assert.deepEqual(readCredentials(dataDir), {}, 'no code, no key, nothing to store');
  await console_.close();
});

// ---------------------------------------------------------------------------
// repoIdentity — who the console is provisioning for
// ---------------------------------------------------------------------------

test('repoIdentity normalises both remote shapes and is blank outside a repo', async () => {
  const { repoIdentity } = await mod('bin/auth.src.mjs');
  const { spawnSync } = await import('node:child_process');

  assert.equal(repoIdentity(tempDir('mubit-auth-norepo-')), '',
    'outside a repo the console gets a blank and decides for itself');

  const withRemote = (remote) => {
    const dir = tempDir('mubit-auth-repo-');
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
    return dir;
  };
  // leakcheck-allow: personal-data — a git SSH remote, not an address; the shape is the fixture.
  assert.equal(repoIdentity(withRemote('git@github.com:mubit-ai/claude-plugins.git')),
    'github.com/mubit-ai/claude-plugins', 'the SSH shape');
  assert.equal(repoIdentity(withRemote('https://github.com/mubit-ai/claude-plugins.git')),
    'github.com/mubit-ai/claude-plugins', 'the HTTPS shape');
});

test('the auth URL still carries repo= when there is no repo to name', async () => {
  const { runBrowserAuth } = await mod('bin/auth.src.mjs');
  const console_ = await fakeConsole();
  let authUrl = '';

  await runBrowserAuth({
    consoleUrl: console_.url, repo: '',
    openImpl: (url) => { authUrl = url; console_.browse(url); }, timeoutMs: 5000,
  });

  const u = new URL(authUrl);
  assert.ok(u.searchParams.has('repo'), 'the parameter is part of the contract, present even when empty');
  assert.equal(u.searchParams.get('repo'), '');
  await console_.close();
});

// ---------------------------------------------------------------------------
// The store, on the second run and after damage
// ---------------------------------------------------------------------------

test('re-authenticating replaces both the key and the endpoint, still owner-only', { skip: IS_ROOT }, async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const { credentialsPath, readCredentials, writeCredentials } = await lib('credentials.mjs');
  const instance = await fakeMubit({ 'POST /v2/control/lessons': { json: { lessons: [] } } });
  const console_ = await fakeConsole({ key: 'mbt_rotated', mubitEndpoint: instance.url });
  const dataDir = makeDataDir();
  writeCredentials(dataDir, { endpoint: 'https://stale.example', apiKey: 'mbt_stale' });
  const lines = [];

  const code = await main(['--json'], { MUBIT_CONSOLE_URL: console_.url }, {
    dataDir, fetchImpl: fetch, log: (m) => lines.push(m), timeoutMs: 5000,
    openImpl: (url) => { console_.browse(url); },
  });

  assert.equal(code, 0, lines.join('\n'));
  assert.deepEqual(readCredentials(dataDir), { endpoint: instance.url, apiKey: 'mbt_rotated' },
    'a half-replaced store — new key, stale endpoint — is a working key pointed at the wrong door');
  assert.equal((statSync(credentialsPath(dataDir)).mode & 0o777).toString(8), '600');
  await console_.close();
  await instance.close();
});

test('a corrupt credentials store reads as unconfigured, not as a crash', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const dataDir = makeDataDir();
  writeFileSync(join(dataDir, 'credentials.json'), '{"endpoint": "https://half.example", "apiK');
  const lines = [];

  const code = await main(['--status', '--json'], {}, { dataDir, log: (m) => lines.push(m) });

  assert.equal(code, 1, 'a store a SIGKILL truncated is the unconfigured state, not an error');
  assert.equal(JSON.parse(lines.join('')).state, 'unconfigured');
});

test('logging out with nothing stored is a success', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const lines = [];

  const code = await main(['--logout', '--json'], {}, { dataDir: makeDataDir(), log: (m) => lines.push(m) });

  assert.equal(code, 0, '"already logged out" is the state the user asked for');
  assert.equal(JSON.parse(lines.join('')).state, 'unconfigured');
});

// ---------------------------------------------------------------------------
// Endpoint hygiene — the console's answer, and the paste route's precedence
// ---------------------------------------------------------------------------

test('a non-URL endpoint from the console never displaces the default', async () => {
  const { endpointCandidatesFor, DEFAULT_ENDPOINT } = await mod('bin/auth.src.mjs');

  for (const bad of ['', '   ', '::::', null, 123]) {
    assert.deepEqual(endpointCandidatesFor({ mubitEndpoint: bad }), [DEFAULT_ENDPOINT],
      `mubitEndpoint ${JSON.stringify(bad)} is not an endpoint and must not become one`);
  }

  // A decision, pinned as one: `new URL('https://nonsense')` parses, so a bare word IS a
  // hostname as far as this side can tell. It goes first, gets *verified*, fails, and the
  // gateway behind it is what actually answers — the candidates machinery absorbs it.
  assert.deepEqual(endpointCandidatesFor({ mubitEndpoint: 'nonsense' }),
    ['https://nonsense', DEFAULT_ENDPOINT]);
});

test('--data-dir pointing at a directory that does not exist yet is created, owner-only', { skip: IS_ROOT }, async () => {
  const { main, KEY_ENV_VAR } = await mod('bin/auth.src.mjs');
  const { credentialsPath, readCredentials } = await lib('credentials.mjs');
  const server = await fakeMubit({ 'POST /v2/control/lessons': { json: { lessons: [] } } });
  const nested = join(tempDir('mubit-auth-deep-'), 'a', 'b', 'plugin-data');
  const lines = [];

  const code = await main(
    ['--paste', '--endpoint', server.url, '--data-dir', nested, '--json'],
    { [KEY_ENV_VAR]: KEY },
    { fetchImpl: fetch, log: (m) => lines.push(m) },
  );

  assert.equal(code, 0, lines.join('\n'));
  assert.deepEqual(readCredentials(nested), { endpoint: server.url, apiKey: KEY },
    'a data dir the host has not created yet must not turn a good sign-in into a silent no-op');
  assert.equal((statSync(credentialsPath(nested)).mode & 0o777).toString(8), '600');
  await server.close();
});

test('paste mode resolves the endpoint flag over the environment over the default', async () => {
  const { main, KEY_ENV_VAR, DEFAULT_ENDPOINT } = await mod('bin/auth.src.mjs');
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(new URL(String(url)).origin);
    return new Response('{}', { status: 200 });
  };
  const run = (argv, env) => {
    seen.length = 0;
    return main(['--paste', '--json', ...argv], { [KEY_ENV_VAR]: KEY, ...env },
      { dataDir: makeDataDir(), fetchImpl, log: () => {} });
  };

  await run(['--endpoint', 'https://flag.example'], { MUBIT_ENDPOINT: 'https://env.example' });
  assert.ok(seen.length > 0 && seen.every((o) => o === 'https://flag.example'),
    `--endpoint outranks the environment: ${seen.join(', ')}`);

  await run([], { MUBIT_ENDPOINT: 'https://env.example' });
  assert.ok(seen.length > 0 && seen.every((o) => o === 'https://env.example'),
    `the environment outranks the default: ${seen.join(', ')}`);

  await run([], {});
  assert.ok(seen.length > 0 && seen.every((o) => o === DEFAULT_ENDPOINT),
    `nothing set means the compiled-in gateway: ${seen.join(', ')}`);
});

/**
 * Codex runs an unapproved command inside seatbelt with the network off. The verify path
 * already translates its ENOTFOUND into "approve the command"; the *browser* path did not,
 * so the same user was told the token exchange failed as if the console were down. The
 * sandbox note must reach the browser path's failure message too.
 */
test('inside the codex sandbox a refused console blames the network, not the browser', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const { createServer } = await import('node:http');
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', () => r(undefined)));
  const deadPort = /** @type {any} */ (probe.address()).port;
  await new Promise((r) => probe.close(() => r(undefined)));
  const lines = [];

  const code = await main(['--json'],
    { MUBIT_CONSOLE_URL: `http://127.0.0.1:${deadPort}`, CODEX_SANDBOX: '1' },
    {
      dataDir: makeDataDir(), fetchImpl: fetch, log: (m) => lines.push(m), timeoutMs: 5000,
      openImpl: (url) => {
        const u = new URL(url);
        fetch(`http://127.0.0.1:${u.searchParams.get('port')}/callback`
          + `?code=c&state=${u.searchParams.get('state')}`, { redirect: 'manual' });
      },
    });

  assert.equal(code, 1);
  const out = JSON.parse(lines.join(''));
  assert.equal(out.state, 'browser_failed');
  assert.match(out.detail, /sandbox|network access/i,
    'the fix is approving the command, and the message must say so');
  assert.doesNotMatch(out.detail, /fetch failed/i,
    'the raw transport wrapper is not an explanation');
});

// ===========================================================================
// The data-dir split-brain warning
// ===========================================================================

/**
 * The flag wins — that ordering is load-bearing and tested above — but a flag that
 * *disagrees* with a pinned `MUBIT_CC_DATA_DIR` is exactly the shape of the observed
 * split-brain: the skill interpolated one directory, the environment pinned another,
 * and the sign-in reported success into a store no hook reads. The resolver cannot
 * know which side is right, so it says, on the progress channel, that they differ.
 */
test('a --data-dir that disagrees with a set MUBIT_CC_DATA_DIR is warned about', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const fromFlag = makeDataDir();
  const pinned = makeDataDir();
  const progress = [];

  await main(['--status', '--json', '--data-dir', fromFlag], { MUBIT_CC_DATA_DIR: pinned },
    { log: () => {}, logProgress: (m) => progress.push(m) });

  const text = progress.join('\n');
  assert.match(text, /MUBIT_CC_DATA_DIR/,
    'the warning must name the setting being overridden, or nobody can act on it');
  assert.ok(text.includes(fromFlag) && text.includes(pinned),
    `both directories are named, so the split is visible. Got:\n${text || '(silent)'}`);
});

test('no warning when the flag and the pin agree, or when nothing is pinned', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const dir = makeDataDir();

  for (const env of [{ MUBIT_CC_DATA_DIR: dir }, {}]) {
    const progress = [];
    await main(['--status', '--json', '--data-dir', dir], env,
      { log: () => {}, logProgress: (m) => progress.push(m) });
    assert.doesNotMatch(progress.join('\n'), /MUBIT_CC_DATA_DIR/,
      'a warning that fires on the healthy path trains everyone to ignore it');
  }
});

// ===========================================================================
// A fresh key that 401s is retried before auth_failed
// ===========================================================================

/**
 * Observed live: a key the console minted seconds earlier answered 401 at the
 * gateway for over a minute — edge ACLs propagate on their own clock. Declaring
 * `auth_failed` there sends the user to reissue a key that was never bad, and the
 * *second* authorize flow then supersedes the first key entirely.
 *
 * The exemption is scoped to keys this flow just minted. A stored or pasted key that
 * 401s is genuinely bad, and waiting 30 seconds to say so would be pure friction.
 */
test('the browser flow retries a fresh key through ACL lag instead of failing it', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const { readCredentials } = await lib('credentials.mjs');
  const server = await fakeMubit({
    'POST /v2/control/lessons': [
      { status: 401, json: { error: 'unknown key' } },
      { status: 401, json: { error: 'unknown key' } },
      { json: { lessons: [] } },
    ],
  });
  const console_ = await fakeConsole({ key: 'mbt_just_minted', mubitEndpoint: server.url });
  const dataDir = makeDataDir();
  const lines = [];

  const started = Date.now();
  const code = await main(['--json'],
    { MUBIT_CONSOLE_URL: console_.url, MUBIT_CC_AUTH_RETRY_UNIT_MS: '10' },
    {
      dataDir, fetchImpl: fetch, log: (m) => lines.push(m), timeoutMs: 5000,
      openImpl: (url) => { console_.browse(url); },
    });

  assert.equal(code, 0, `a lagging ACL is not a bad key:\n${lines.join('\n')}`);
  assert.equal(server.countOf('POST', '/v2/control/lessons'), 3,
    'two refusals, then the answer — the retry is what turned this into a sign-in');
  assert.equal(readCredentials(dataDir).apiKey, 'mbt_just_minted');
  assert.ok(Date.now() - started < 4000, 'no real sleeping in this suite');
  await console_.close();
  await server.close();
});

test('a pasted key still fails fast on 401 — the lag exemption is for fresh mints only', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const server = await fakeMubit({
    'POST /v2/control/lessons': { status: 401, json: { error: 'revoked' } },
  });
  const lines = [];

  const code = await main(['--paste', '--json'],
    { MUBIT_AUTH_KEY: 'mbt_stored_and_revoked', MUBIT_ENDPOINT: server.url,
      MUBIT_CC_AUTH_RETRY_UNIT_MS: '10' },
    { dataDir: makeDataDir(), fetchImpl: fetch, log: (m) => lines.push(m) });

  assert.equal(code, 1);
  assert.equal(JSON.parse(lines.join('')).state, 'auth_failed');
  assert.equal(server.countOf('POST', '/v2/control/lessons'), 1,
    'a key that existed before this command ran earns no retry');
  await server.close();
});

/**
 * The schedule is a contract, not an implementation detail: the skill tells the user
 * how long the command can appear to hang, and the live-run analysis sized it
 * against a measured ~70 s worst-case propagation. Pinned by export so a future edit
 * has to look this reasoning in the eye.
 */
test('the retry schedule covers ~30 s and the env unit shrinks it for tests', async () => {
  const { AUTH_RETRY_SCHEDULE_MS } = await mod('bin/auth.src.mjs');

  assert.ok(Array.isArray(AUTH_RETRY_SCHEDULE_MS) && AUTH_RETRY_SCHEDULE_MS.length >= 2,
    'at least two retries — one is a coin toss against a propagation delay');
  const total = AUTH_RETRY_SCHEDULE_MS.reduce((a, b) => a + b, 0);
  assert.ok(total >= 25_000 && total <= 45_000,
    `the schedule totals ${total} ms; the measured ACL lag needs ~30 s of patience`);
});

// ===========================================================================
// The token exchange has its own deadline
// ===========================================================================

/**
 * Observed live: the `POST /api/cli/token` fetch after the callback has no
 * timeout of its own, and a wedged console held the command in a >100 s silent hang —
 * inside a Bash tool call, indistinguishable from a dead process. The outer ten-minute
 * deadline technically fires, but it reports `provisioning` (exit 2, "run it again"),
 * which is the wrong verdict for a console that already took the code.
 */
test('a hung token exchange hits its own deadline, not the ten-minute one', async () => {
  const { runBrowserAuth, BrowserTimeout } = await mod('bin/auth.src.mjs');
  const console_ = await fakeConsole({ tokenHang: true });

  const started = Date.now();
  await assert.rejects(
    runBrowserAuth({
      consoleUrl: console_.url,
      openImpl: (url) => { console_.browse(url); },
      timeoutMs: 3000,
      exchangeTimeoutMs: 200,
      log: () => {},
    }),
    (err) => {
      assert.ok(!(err instanceof BrowserTimeout),
        'a console that took the code and hung is not a browser that never came back');
      assert.match(String(err?.message ?? err), /exchange|console/i,
        'the message must say which side went quiet');
      return true;
    });
  assert.ok(Date.now() - started < 5000,
    'the exchange deadline, not the outer browser deadline, is what fired');
  await console_.close();
});

test('main() reports a hung exchange as browser_failed with the paste route, not provisioning', async () => {
  const { main, KEY_ENV_VAR } = await mod('bin/auth.src.mjs');
  const console_ = await fakeConsole({ tokenHang: true });
  const lines = [];

  const code = await main(['--json'],
    { MUBIT_CONSOLE_URL: console_.url, MUBIT_CC_AUTH_EXCHANGE_TIMEOUT_MS: '200' },
    {
      dataDir: makeDataDir(), fetchImpl: fetch, log: (m) => lines.push(m), timeoutMs: 3000,
      openImpl: (url) => { console_.browse(url); },
    });

  assert.equal(code, 1,
    'exit 2 would tell the user to wait for a workspace; nothing is provisioning here');
  const out = JSON.parse(lines.join(''));
  assert.equal(out.state, 'browser_failed');
  assert.match(out.detail, new RegExp(KEY_ENV_VAR),
    'the paste route is the way forward when the console will not finish the exchange');
  await console_.close();
});

/**
 * The progress line is half the fix: the exchange runs after the user has already done
 * their part in the browser, so a silence here reads as "it ignored me". One line on
 * stderr says the flow is alive and what it is doing.
 */
test('the exchange announces itself on the progress channel', async () => {
  const { main } = await mod('bin/auth.src.mjs');
  const instance = await fakeMubit({ 'POST /v2/control/lessons': { json: { lessons: [] } } });
  const console_ = await fakeConsole({ key: 'mbt_k', mubitEndpoint: instance.url });
  const progress = [];

  const code = await main(['--json'], { MUBIT_CONSOLE_URL: console_.url }, {
    dataDir: makeDataDir(), fetchImpl: fetch, timeoutMs: 5000,
    log: () => {}, logProgress: (m) => progress.push(m),
    openImpl: (url) => { console_.browse(url); },
  });

  assert.equal(code, 0);
  assert.match(progress.join('\n'), /finishing sign-in/i,
    'the one moment the flow is silently busy must say so');
  await console_.close();
  await instance.close();
});

/** The shipped deadline: long enough for a slow console, far short of the Bash kill. */
test('the exchange deadline ships at 90 s and the environment can shrink it', async () => {
  const { DEFAULT_EXCHANGE_TIMEOUT_MS } = await mod('bin/auth.src.mjs');
  assert.equal(DEFAULT_EXCHANGE_TIMEOUT_MS, 90_000,
    'sized against the observed 100+ s hang: fail before the harness kills the command');
});
