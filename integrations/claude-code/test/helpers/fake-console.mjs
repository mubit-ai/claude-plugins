// @ts-check
/**
 * A stand-in for the Mubit console, shared by every suite that drives the browser
 * auth flow — `test/auth.test.mjs` here, and `integrations/codex/test/codex-auth.test.mjs`,
 * which spawns the sibling bundle built from the same `bin/auth.src.mjs`.
 *
 * It does the one thing the real console must do and that the client cannot check for
 * itself: it **recomputes the S256 challenge from the verifier** and refuses the
 * exchange when they disagree. That is the entire security property of PKCE, so the
 * fake enforces it rather than rubber-stamping whatever arrives.
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

/**
 * @param {{key?: string, provisioning?: boolean, mubitEndpoint?: string,
 *          tokenStatus?: number, rawBody?: string, omitKey?: boolean,
 *          tokenHang?: boolean}} [opts]
 */
export async function fakeConsole({ key = 'mbt_issued_by_console', provisioning = false,
  mubitEndpoint = '', tokenStatus = 200, rawBody = undefined, omitKey = false,
  tokenHang = false } = {}) {
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

      // A console that took the code and then never answered — observed live as a
      // 100-second silent hang. The client's own exchange deadline is what a test
      // that sets this is exercising.
      if (tokenHang) return;

      // The forced-failure modes, for the exchange-failure matrix. They short-circuit
      // before PKCE on purpose: a console answering 500 or an HTML error page never got
      // as far as checking anything.
      if (rawBody !== undefined) {
        res.writeHead(tokenStatus, { 'content-type': 'text/html' });
        return res.end(rawBody);
      }
      if (tokenStatus !== 200) {
        res.writeHead(tokenStatus, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: `forced_${tokenStatus}` }));
      }

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
      const payload = {
        mubitApiKey: key,
        mubitEndpoint,
        minimaUrl: 'https://harness.example.invalid',
        instanceId: 'instance-under-test',
        projectId: 'proj_1',
        namespace: 'proj_1',
        region: 'eu',
      };
      // A console broken enough to answer without the one field that matters.
      if (omitKey) delete payload.mubitApiKey;
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  const port = /** @type {any} */ (server.address()).port;

  return {
    url: `http://127.0.0.1:${port}`,
    exchanges,
    /**
     * Play the part of the browser: read the URL the CLI wanted to open, register the
     * challenge against a fresh code, and call the loopback back.
     */
    async browse(authUrl, {
      code = 'code_ok', tamperState, sendProvisioning = provisioning, delayMs = 0,
      omitCode = false,
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
        : omitCode
          ? `state=${encodeURIComponent(state)}`
          : `code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      return fetch(`http://127.0.0.1:${cbPort}/callback?${q}`, { redirect: 'manual' });
    },
    /** Register a code whose challenge does not match any verifier we will send. */
    poison(code) { issued.set(code, 'a-challenge-that-matches-nothing'); },
    // `closeAllConnections` first: a deliberately hung exchange (`tokenHang`) holds its
    // socket open, and a bare `close()` would wait on it forever.
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r(undefined)); }),
  };
}
