// @ts-check
/**
 * `bin/auth.src.mjs` — what `/mubit-memory:auth` runs. Bundled to `bin/auth.mjs`.
 *
 * Setting the plugin up is two values, `endpoint` and `apiKey`, and until this command
 * existed the only way to supply them was: open the console, find the instance, issue a
 * key, copy it, run `/plugin`, find Mubit Memory, choose configure, paste into two
 * fields. Seven steps, each one a place to stop.
 *
 * ## Why this does not use `lib/http.mjs`
 *
 * That module is built for hooks: it caches health for 30 s, and it sits behind a
 * circuit breaker so a dead instance cannot slow every prompt down. Both are wrong
 * here. A user runs `/auth` *because* something is not working, which is exactly when
 * the breaker is open and the cached health result is stale — and "I refuse to check
 * because checking failed recently" is a terrible answer to "please log me in". So this
 * file dials directly, with an injected `fetchImpl` the tests substitute.
 *
 * ## Why the key is checked against an authenticated route
 *
 * `GET /v2/core/health` reports whether the instance is reachable, not whether your key is
 * good — the plugin needs it as a readiness probe *before* a key exists. Validating a key
 * against it would make this command a machine for producing false confidence. So health answers "is anything
 * there?", and a second, authenticated call answers "is this key good?". Two questions,
 * two calls, and the failure modes stay distinguishable.
 *
 * Nothing here logs the key, and no returned object contains it.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  clearCredentials, credentialsPath, readCredentials, writeCredentials,
} from '../lib/credentials.mjs';
import { liveDataDir, safeHome } from '../lib/state.mjs';

/** Where keys are issued. `MUBIT_CONSOLE_URL` overrides it for staging. */
export const CONSOLE_URL = 'https://console.mubit.ai';

/** Used when the user does not name an instance. */
export const DEFAULT_ENDPOINT = 'https://api.mubit.ai';

/** Mubit API keys are `mbt_`-prefixed. */
export const KEY_PREFIX = 'mbt_';

/** What this plugin calls itself to the console. See `buildAuthUrl`. */
export const CLIENT_ID = 'claude-code';

/** The authenticated probe: a read, no side effects, and no LLM call. */
export const PROBE_ROUTE = '/v2/control/lessons';
export const HEALTH_ROUTE = '/v2/core/health';

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * How long to wait for the browser round trip.
 *
 * Two minutes was chosen for "sign in and pick an instance". The user this command exists
 * for is creating an account, creating an organization, and then waiting out a workspace
 * that takes a minute or two by itself — and the console now waits for that workspace rather
 * than bouncing back. Two minutes failed flows that were working.
 *
 * Ten is a ceiling rather than a preference: a Bash tool call is killed at 600 s at the
 * outside, so a longer deadline could never be reached. `skills/auth/SKILL.md` sets the
 * tool's own timeout to match — without that the harness kills this at its 120 s default and
 * this constant does nothing.
 *
 * `MUBIT_CC_AUTH_TIMEOUT_MS` shrinks it, the way the other `MUBIT_CC_*` windows are shrunk.
 */
const DEFAULT_AUTH_TIMEOUT_MS = 600000;

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * A cheap gate so an obvious typo — a pasted URL, an Anthropic key, the word `Bearer`
 * left on the front — costs a round trip to nobody and gets a precise message instead
 * of a generic `auth_failed`.
 *
 * It only checks shape. A well-formed key can still be revoked, and only the server
 * knows that.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function looksLikeKey(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return s.startsWith(KEY_PREFIX) && s.length > KEY_PREFIX.length && !/\s/.test(s);
}

/**
 * Normalize what a user pastes into something `new URL()` accepts.
 *
 * A bare hostname is upgraded to **https**, never http: silently downgrading the
 * transport a credential travels over is worse than refusing to guess.
 *
 * @param {unknown} v
 * @returns {string}
 */
export function normalizeEndpoint(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return DEFAULT_ENDPOINT;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  return withScheme.replace(/\/+$/, '');
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function consoleUrlFrom(env = process.env) {
  const v = env?.MUBIT_CONSOLE_URL;
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.replace(/\/+$/, '') : CONSOLE_URL;
}

// ---------------------------------------------------------------------------
// The browser step
// ---------------------------------------------------------------------------

/**
 * Open the OS browser, detached, and never care whether it worked.
 *
 * Over SSH, in a container, or on a machine with no default browser there is nothing to
 * open, and that is not an error — printing the URL is the whole fallback, and the user
 * carries on by hand. Failing here would strand somebody who was one paste away.
 *
 * @param {{url: string, openImpl?: (url: string) => any, log?: (m: string) => void}} opts
 * @returns {boolean} whether a browser was actually launched
 */
export function openConsole({ url, openImpl = defaultOpen, log = console.error }) {
  let launched = false;
  try {
    openImpl(url);
    launched = true;
  } catch {
    launched = false;
  }
  if (!launched) log(`Open this in your browser:\n  ${url}`);
  return launched;
}

/** @param {string} url */
function defaultOpen(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
      : 'xdg-open';
  const child = spawn(cmd, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
  child.on('error', () => { /* no browser here; the caller already printed the URL */ });
  child.unref();
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * @typedef {'ready'|'auth_failed'|'unreachable'|'server_error'|'invalid_key'} AuthState
 * @typedef {{ok: boolean, state: AuthState, detail: string}} VerifyResult
 */

/**
 * Two calls, cheapest first, so every outcome has exactly one cause.
 *
 *   1. `GET /v2/core/health` — is anything there? Separates "your network/endpoint is
 *      wrong" from "your key is wrong". Without it, a user on a dropped VPN is told to
 *      re-issue a perfectly good key.
 *   2. `POST /v2/control/lessons` with the bearer token — is this key good? This is the
 *      only question health cannot answer.
 *
 * @param {{endpoint: string, apiKey: string, fetchImpl?: typeof fetch, timeoutMs?: number}} opts
 * @returns {Promise<VerifyResult>}
 */
export async function verifyCredentials(opts) {
  const { apiKey, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = opts ?? {};
  const endpoint = normalizeEndpoint(opts?.endpoint);

  if (!looksLikeKey(apiKey)) {
    return {
      ok: false,
      state: 'invalid_key',
      detail: `That does not look like a Mubit API key. Keys begin with \`${KEY_PREFIX}\`.`,
    };
  }
  const key = String(apiKey).trim();

  // 1 — reachability.
  const health = await dial(fetchImpl, `${endpoint}${HEALTH_ROUTE}`, { timeoutMs });
  if (health.transportError) {
    return {
      ok: false,
      state: 'unreachable',
      detail: `Could not reach ${endpoint}: ${health.cause}.`,
    };
  }
  if (health.status >= 500) {
    return {
      ok: false,
      state: 'server_error',
      detail: `${endpoint} is up but unhealthy (HTTP ${health.status}). This is the instance, not your key.`,
    };
  }

  // 2 — the key itself.
  const probe = await dial(fetchImpl, `${endpoint}${PROBE_ROUTE}`, {
    method: 'POST',
    timeoutMs,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: '{}',
  });
  if (probe.transportError) {
    return {
      ok: false,
      state: 'unreachable',
      detail: `Lost the connection to ${endpoint} while checking the key: ${probe.cause}.`,
    };
  }
  if (probe.status === 401 || probe.status === 403) {
    return { ok: false, state: 'auth_failed', detail: 'The instance rejected that key. Issue a new one in the console.' };
  }
  if (probe.status >= 500) {
    return { ok: false, state: 'server_error', detail: `The instance failed while checking the key (HTTP ${probe.status}).` };
  }
  if (probe.status >= 400) {
    return { ok: false, state: 'server_error', detail: `Unexpected reply from ${endpoint} (HTTP ${probe.status}).` };
  }
  return { ok: true, state: 'ready', detail: `Connected to ${endpoint}.` };
}

/**
 * One request, with a deadline, that never throws.
 *
 * A timeout is reported as a transport error rather than a status, because a request
 * that never got an answer is a different thing from an answer that said no — the whole
 * point of the state table above.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{status: number, transportError: boolean, cause?: string}>}
 */
async function dial(fetchImpl, url, { method = 'GET', headers = {}, body, timeoutMs } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method, headers, body, signal: ac.signal });
    return { status: res.status, transportError: false };
  } catch (err) {
    return { status: 0, transportError: true, cause: transportCause(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Codex runs an unapproved command inside seatbelt with the network switched off, and DNS is
 * what fails first there — so a perfectly healthy endpoint reports ENOTFOUND. Reading that
 * as a bad endpoint sends the reader off to fix a URL that was never wrong; the fix is to
 * approve the command. No network error carries information about the endpoint in here.
 *
 * @returns {string}
 */
function SANDBOX_BLOCKED() {
  const env = (typeof process === 'object' && process) ? (process.env || {}) : {};
  if (!env.CODEX_SANDBOX && !env.CODEX_SANDBOX_NETWORK_DISABLED) return '';
  return 'this process has no network access — Codex ran it inside its sandbox. Approve the '
    + 'command and run it again; the endpoint is almost certainly fine';
}

/**
 * The actionable half of a transport failure, which lives in the `cause` chain rather than in
 * the `TypeError: fetch failed` wrapper. A name that does not resolve and an instance that is
 * switched off are different problems with different fixes, and used to print identically.
 *
 * @param {unknown} err
 * @returns {string}
 */
function transportCause(err) {
  /** @type {Record<string, string>} */
  const HINTS = {
    ENOTFOUND: 'that hostname does not resolve — check the endpoint for a typo (ENOTFOUND)',
    EAI_AGAIN: 'the DNS lookup failed — check the network, or the endpoint for a typo (EAI_AGAIN)',
    ECONNREFUSED: 'nothing is listening on that port (ECONNREFUSED)',
    EHOSTUNREACH: 'the host is unreachable from this network (EHOSTUNREACH)',
    ENETUNREACH: 'the network is unreachable (ENETUNREACH)',
    ECONNRESET: 'the connection was reset in flight (ECONNRESET)',
    CERT_HAS_EXPIRED: 'its TLS certificate has expired (CERT_HAS_EXPIRED)',
    DEPTH_ZERO_SELF_SIGNED_CERT:
      'its TLS certificate is self-signed and not trusted (DEPTH_ZERO_SELF_SIGNED_CERT)',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE:
      'its TLS certificate could not be verified (UNABLE_TO_VERIFY_LEAF_SIGNATURE)',
  };
  let cur = /** @type {any} */ (err);
  for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
    const code = typeof cur['code'] === 'string' ? cur['code'].toUpperCase() : '';
    if (HINTS[code]) return SANDBOX_BLOCKED() || HINTS[code];
    const name = typeof cur['name'] === 'string' ? cur['name'] : '';
    if (name === 'AbortError' || name === 'TimeoutError') return 'it did not answer in time';
    cur = cur['cause'];
  }
  return 'nothing answered — check the endpoint, and that the instance is running';
}

// ---------------------------------------------------------------------------
// Verify, then store
// ---------------------------------------------------------------------------

/**
 * Check a key and — only if the server accepts it — write it.
 *
 * Storing an unverified key does not save the user a step; it moves the failure to the
 * next session, where it shows up as a broken plugin rather than a failed login.
 *
 * @param {{dataDir: string, endpoint: string, apiKey: string,
 *          fetchImpl?: typeof fetch, timeoutMs?: number}} opts
 * @returns {Promise<{ok: boolean, state: AuthState, detail: string, endpoint: string, stored: boolean}>}
 */
export async function authenticateWithKey(opts) {
  const endpoint = normalizeEndpoint(opts?.endpoint);
  const result = await verifyCredentials({ ...opts, endpoint });
  if (!result.ok) return { ...result, endpoint, stored: false };

  const stored = writeCredentials(opts.dataDir, {
    endpoint,
    apiKey: String(opts.apiKey).trim(),
  });
  if (!stored) {
    return {
      ok: false,
      state: 'server_error',
      detail: `The key is valid but could not be written to ${credentialsPath(opts.dataDir)}.`,
      endpoint,
      stored: false,
    };
  }
  return { ...result, endpoint, stored: true };
}

/**
 * What is configured right now, for the "you are already signed in" path.
 * Returns the key's presence, never the key.
 *
 * @param {string} dataDir
 * @returns {{endpoint: string, hasKey: boolean}}
 */
export function currentCredentials(dataDir) {
  const c = readCredentials(dataDir);
  return { endpoint: c.endpoint ?? '', hasKey: typeof c.apiKey === 'string' && c.apiKey !== '' };
}

// ---------------------------------------------------------------------------
// The browser flow — loopback + PKCE
// ---------------------------------------------------------------------------

/**
 * The workspace is still coming up. Not a failure: the same command, run again in a
 * minute, finishes the job. Modelled as its own error type so callers cannot
 * accidentally treat it as one.
 */
export class ProvisioningPending extends Error {
  constructor(message = 'workspace is still provisioning') {
    super(message);
    this.name = 'ProvisioningPending';
  }
}

/**
 * The browser round trip ran out of time.
 *
 * `launched` is the whole reason this is a class and not a bare `Error`. A deadline reached
 * *after* a browser opened means the sign-up, the org creation or the workspace is still in
 * flight, and running the same command again finishes it. A deadline reached with nothing
 * opened — over SSH, in a container — means there was never anything to wait for, and the
 * only way forward is the paste route. They used to print the same message, which sent the
 * first user off to issue a key by hand to fix a flow that was working.
 */
export class BrowserTimeout extends Error {
  /** @param {boolean} launched */
  constructor(launched) {
    super('timed out waiting for browser authorization');
    this.name = 'BrowserTimeout';
    this.launched = launched;
  }
}

/** base64url: the URL-safe alphabet, no padding. These travel in a query string. */
function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * An RFC 7636 S256 pair.
 *
 * The browser only ever carries the **challenge**. The verifier stays in this process
 * and goes straight to the console over the back channel, which is what makes the code
 * in the address bar useless to anyone who reads it: without the verifier it cannot be
 * exchanged, and the challenge is a one-way hash.
 *
 * @returns {{verifier: string, challenge: string}}
 */
export function makePkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * The loopback + PKCE flow, the same shape `gh auth login` uses.
 *
 *   1. Generate a PKCE pair and a `state` nonce.
 *   2. Listen on `127.0.0.1:0` — a random free port, loopback only. Binding `0.0.0.0`
 *      would put the callback on the network for the length of the flow.
 *   3. Open the console, passing the port, the state and the challenge.
 *   4. The user signs in there; the console redirects back to the loopback with a code.
 *   5. Exchange `{code, verifier}` for the key over the back channel.
 *
 * `state` is checked on the way in. Without it, any page the user happens to have open
 * could call the loopback with a code of its own and sign them into somebody else's
 * account.
 *
 * @param {{consoleUrl?: string, repo?: string, host?: string, region?: string,
 *          openImpl?: (url: string) => any, fetchImpl?: typeof fetch,
 *          timeoutMs?: number, log?: (m: string) => void}} [opts]
 * @returns {Promise<Record<string, any>>}
 */
export async function runBrowserAuth(opts = {}) {
  const {
    consoleUrl = CONSOLE_URL, repo = '', host = '', region = '',
    openImpl, fetchImpl = fetch, timeoutMs = DEFAULT_AUTH_TIMEOUT_MS, log = console.error,
  } = opts;

  const { verifier, challenge } = makePkce();
  const state = base64url(randomBytes(16));

  const server = createServer();
  /** @type {(v: any) => void} */ let settle;
  /** @type {(e: Error) => void} */ let fail;
  const awaited = new Promise((res, rej) => { settle = res; fail = rej; });

  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    // A state mismatch is answered politely and then ignored: the real browser may still
    // be on its way, so this must not end the flow. It simply never completes it.
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('state mismatch');
    }

    const provisioning = url.searchParams.get('provisioning') === '1';
    const code = url.searchParams.get('code');

    // Hand the browser back to the console rather than leaving it on a blank loopback
    // page — the user's attention is there, and that is where the confirmation belongs.
    res.writeHead(302, {
      location: `${consoleUrl}/app/cli-auth?status=${provisioning || !code ? 'provisioning' : 'authorized'}`,
    });
    res.end();

    if (provisioning || !code) settle({ provisioning: true });
    else settle({ code });
  });

  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => res(undefined));
  });
  server.unref();
  // `address()` is `AddressInfo | string | null`, and only the first carries a port. The old
  // cast silently produced `port=undefined` in the sign-in URL for the other two, which fails
  // in the browser with nothing pointing back here.
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('the local callback server did not bind a TCP port');
  }
  const port = addr.port;

  let launched = false;
  const timer = setTimeout(() => fail(new BrowserTimeout(launched)), timeoutMs);

  try {
    const authUrl = buildAuthUrl({ consoleUrl, port, state, challenge, repo, host, region });
    launched = openConsole({ url: authUrl, openImpl, log });

    const hit = await awaited;
    if (hit.provisioning) throw new ProvisioningPending();

    const res = await fetchImpl(`${consoleUrl}/api/cli/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: hit.code, verifier }),
    });
    if (!res.ok) throw new Error(`token exchange failed (HTTP ${res.status})`);

    const payload = await res.json();
    if (!payload || typeof payload.mubitApiKey !== 'string' || !payload.mubitApiKey) {
      throw new Error('token exchange failed: the console returned no API key');
    }
    return payload;
  } finally {
    clearTimeout(timer);
    // Always release the port. A listener left behind outlives the command and the next
    // run picks a different port, so the leak is silent until something else needs it.
    await new Promise((r) => server.close(() => r(undefined)));
  }
}

/**
 * `/app/cli-auth` serves more than one CLI, and until this parameter existed it could not
 * tell which one it was talking to — so its copy had to stay neutral about the command the
 * user should run and the product it belongs to. `client` is additive on purpose: every
 * already-installed copy of this plugin will keep omitting it, so the console's neutral
 * wording is the fallback and not a legacy branch.
 *
 * @returns {string}
 */
function buildAuthUrl({ consoleUrl, port, state, challenge, repo, host, region }) {
  const url = new URL(`${consoleUrl}/app/cli-auth`);
  url.searchParams.set('client', CLIENT_ID);
  url.searchParams.set('port', String(port));
  url.searchParams.set('state', state);
  url.searchParams.set('challenge', challenge);
  url.searchParams.set('repo', repo || '');
  url.searchParams.set('host', host || '');
  if (region) url.searchParams.set('region', region);
  return url.toString();
}

/**
 * Turn the console's answer into the `endpoint` the plugin stores.
 *
 * `mubitEndpoint` is the console's own answer — `httpEndpoint` from the platform API's
 * `/location` route, which is the only thing that knows what a given cluster overrode
 * `MUBIT_REGIONAL_HTTP_ENDPOINT` to. Trust it whenever it is there.
 *
 * When it is not, the default is a decision and not an oversight. A console old enough to
 * omit the field still has to work, and `api.mubit.ai` is a key-routed shared gateway:
 * `/v2/core/health` answers for keys belonging to different instances, so the bearer token
 * selects the instance and the hostname does not. Making an absent endpoint fatal would
 * break those users to fix nothing.
 *
 * No region map, either way. eu.mubit.ai and us.mubit.ai are NXDOMAIN, so turning
 * `payload.region` into one of them stored an endpoint that could never answer, and every
 * later command then failed with `TypeError: fetch failed (ENOTFOUND)` far from the sign-in
 * that caused it. A region is a routing hint for the console, not a hostname this side may
 * invent.
 *
 * @param {Record<string, any>} payload
 * @returns {string}
 */
export function endpointFor(payload = {}) {
  const explicit = typeof payload.mubitEndpoint === 'string' ? payload.mubitEndpoint.trim() : '';
  if (explicit) return normalizeEndpoint(explicit);
  return DEFAULT_ENDPOINT;
}

/**
 * The repository this session is in, in the console's `github.com/org/repo` form, so a
 * workspace is provisioned per project rather than per machine. Best effort: outside a
 * git repo the console simply gets a blank and decides for itself.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function repoIdentity(cwd = process.cwd()) {
  try {
    const r = spawnSync('git', ['config', '--get', 'remote.origin.url'],
      { cwd, encoding: 'utf8', timeout: 2000 });
    const origin = (r.stdout ?? '').trim();
    if (origin) {
      return origin
        .replace(/^git@([^:]+):/, '$1/')
        .replace(/^https?:\/\//, '')
        .replace(/\.git$/, '');
    }
  } catch { /* not a repo, or no git */ }
  return '';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * The key arrives in an environment variable, not `--key`.
 *
 * `argv` is world-readable: anyone on the machine can `ps` it while the process runs.
 * A process's environment is readable only by its owner. Neither is as good as never
 * handling the key at all, which is what the browser flow gets us — this path is the
 * fallback for when there is no browser to open.
 */
export const KEY_ENV_VAR = 'MUBIT_AUTH_KEY';

/**
 * Parse argv into an intent. Kept separate from `main` so it is testable without
 * running anything.
 * @param {string[]} argv
 */
export function parseArgs(argv = []) {
  const args = argv.slice();
  const has = (f) => args.includes(f);
  const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  return {
    mode: has('--status') ? 'status' : has('--logout') ? 'logout' : has('--paste') ? 'paste' : 'browser',
    endpoint: valueOf('--endpoint'),
    dataDir: valueOf('--data-dir'),
    json: has('--json'),
  };
}

/**
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 * @param {{fetchImpl?: typeof fetch, log?: (m: string) => void, dataDir?: string}} [deps]
 * @returns {Promise<number>} process exit code
 */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const log = deps.log ?? console.log;
  const args = parseArgs(argv);
  const dataDir = deps.dataDir ?? resolveDataDirFrom(env, args);
  const emit = (payload) => log(args.json ? JSON.stringify(payload) : payload.detail);

  if (args.mode === 'status') {
    const cur = currentCredentials(dataDir);
    emit({
      ok: cur.hasKey,
      state: cur.hasKey ? 'configured' : 'unconfigured',
      endpoint: cur.endpoint,
      detail: cur.hasKey
        ? `Signed in to ${cur.endpoint || DEFAULT_ENDPOINT}.`
        : 'No Mubit credentials stored. Run /mubit-memory:auth.',
    });
    return cur.hasKey ? 0 : 1;
  }

  if (args.mode === 'logout') {
    clearCredentials(dataDir);
    emit({ ok: true, state: 'unconfigured', detail: 'Removed the stored Mubit credentials.' });
    return 0;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;

  // The good path: nothing to copy, nothing to paste, and the key never passes through
  // the conversation. Only reached when the user did not ask for --paste.
  if (args.mode === 'browser') {
    try {
      const payload = await runBrowserAuth({
        consoleUrl: consoleUrlFrom(env),
        repo: repoIdentity(env?.CLAUDE_PROJECT_DIR || process.cwd()),
        host: hostname(),
        fetchImpl,
        // Injected by the tests. Without this seam the suite would open a real browser
        // window per test and then sit out the full deadline.
        openImpl: deps.openImpl,
        timeoutMs: authTimeoutFrom(env, deps),
        log: (m) => log(m),
      });
      const res = await authenticateWithKey({
        dataDir,
        endpoint: args.endpoint ?? endpointFor(payload),
        apiKey: payload.mubitApiKey,
        fetchImpl,
      });
      emit({ ok: res.ok, state: res.state, endpoint: res.endpoint, detail: res.detail });
      return res.ok ? 0 : 1;
    } catch (err) {
      // A browser opened and the deadline passed: the sign-up, the organization or the
      // workspace is still in flight, and the same command run again picks it up. That is
      // the same situation as the console's explicit `provisioning=1`, which older console
      // versions still send and which therefore stays.
      if (err instanceof ProvisioningPending || (err instanceof BrowserTimeout && err.launched)) {
        emit({
          ok: false,
          state: 'provisioning',
          detail: 'Your Mubit workspace is still being created (usually a minute or two). '
            + 'Run /mubit-memory:auth again shortly — it picks up where it left off.',
        });
        return 2; // distinct from a real failure, so the skill can say "wait", not "fix"
      }
      // Nothing could be opened — over SSH, in a container, on a machine with no default
      // browser. Waiting longer cannot help, and the paste route can, so the flow degrades
      // to it rather than dead-ending.
      emit({
        ok: false,
        state: 'browser_failed',
        detail: `${err?.message ?? err}\n`
          + `You can finish by hand instead: issue a key at ${consoleUrlFrom(env)}, then run\n`
          + `  ${KEY_ENV_VAR}=mbt_… node "${'${CLAUDE_PLUGIN_ROOT}'}/bin/auth.mjs"`
          + ` --data-dir "${dataDir}" --paste`,
      });
      return 1;
    }
  }

  const apiKey = env?.[KEY_ENV_VAR] ?? '';
  if (!apiKey) {
    emit({
      ok: false,
      state: 'invalid_key',
      detail: `No key supplied. Set ${KEY_ENV_VAR} for this one command, e.g.\n`
        + `  ${KEY_ENV_VAR}=mbt_… node bin/auth.mjs --paste`,
    });
    return 1;
  }

  const endpoint = normalizeEndpoint(args.endpoint ?? env?.MUBIT_ENDPOINT ?? '');
  const res = await authenticateWithKey({
    dataDir, endpoint, apiKey, fetchImpl,
  });
  emit({ ok: res.ok, state: res.state, endpoint: res.endpoint, detail: res.detail });
  return res.ok ? 0 : 1;
}

/** See `DEFAULT_AUTH_TIMEOUT_MS`. */
function authTimeoutFrom(env = {}, deps = {}) {
  if (typeof deps.timeoutMs === 'number') return deps.timeoutMs;
  const raw = Number(env?.MUBIT_CC_AUTH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 600000;
}

/**
 * Where the credentials go, and the only decision in this file that can make a *successful*
 * sign-in look like nothing happened.
 *
 * Mirrors `lib/state.mjs` `dataDir()`, minus its `cfg` rung — this command has no resolved
 * config, and asking for one before the user is signed in is the wrong way round — plus one
 * rung above it:
 *
 *   1. **`--data-dir`.** `${CLAUDE_PLUGIN_DATA}` is interpolated by the host into a skill's
 *      body text, so `skills/auth/SKILL.md` can pass the exact answer down. This rung exists
 *      because the two environment rungs below it are *empty* on the path that matters: the
 *      skill runs this command through Bash, and a Bash tool call gets
 *      `CLAUDE_PLUGIN_DATA=""` and `CLAUDE_PLUGIN_ROOT=""`. Measured, not assumed.
 *   2. `MUBIT_CC_DATA_DIR`, then `CLAUDE_PLUGIN_DATA`, for a process the host launched.
 *   3. `liveDataDir()` itself rather than a fourth hand-copy of it. Looking in the bare
 *      directory left `--status` reporting no credentials on a machine that had them.
 *
 * A blank `--data-dir`, or one the host never substituted, is dropped rather than used: a
 * literal `${CLAUDE_PLUGIN_DATA}` taken as a path would create a directory of that name under
 * whatever the session's cwd happened to be, write the key into it, and report success.
 */
function resolveDataDirFrom(env = process.env, args = {}) {
  const e = env ?? {};
  const flag = typeof args?.dataDir === 'string' ? args.dataDir.trim() : '';
  if (flag && !/^\$\{/.test(flag)) return flag;
  if (e.MUBIT_CC_DATA_DIR) return e.MUBIT_CC_DATA_DIR;
  if (e.CLAUDE_PLUGIN_DATA) return e.CLAUDE_PLUGIN_DATA;
  return liveDataDir(e.HOME || safeHome(), e);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Guarded the same way as `bin/statusline.src.mjs`: the tests import this module and
// drive `main()` with injected dependencies, so it must not run itself on import.
/**
 * `p` with its symlinks resolved, or `p` unchanged when it cannot be resolved.
 *
 * The module loader resolves symlinks in `import.meta.url` but `process.argv[1]` keeps them,
 * so a plugin installed behind a symlinked cache directory (`~/.codex/plugins/cache/...`)
 * failed the entry-point guard below: `main()` never ran, and the caller saw exit 0 with no
 * output and no error to explain it.
 */
function realPath(p) {
  try { return p ? realpathSync(p) : p; } catch { return p; }
}

const selfPath = fileURLToPath(import.meta.url);
const selfReal = realPath(selfPath);
const entryPath = process.argv[1] ? realPath(resolve(process.argv[1])) : '';

if (entryPath === selfReal) {
  // Unlike a hook, this command is allowed to fail loudly — the user is watching, and a
  // silent exit 0 after a failed login is worse than a message. But a stack trace is
  // still never the right output, so the exit code carries the verdict.
  process.exitCode = await main().catch((err) => {
    console.log(`Authentication could not run: ${err?.message ?? err}`);
    return 1;
  });
}
