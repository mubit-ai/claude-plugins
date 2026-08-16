// @ts-check
/**
 * `lib/breaker.mjs` — the connection-state classifier and the circuit breaker.
 *
 * Guide sections under test: §4.7 (breaker), §7 (state layout), §12.6 (test plan),
 * §1.1/§1.2 (status codes and the one unauthenticated route).
 *
 * Two rules dominate this file and both exist to stop the plugin from lying to the user:
 *   1. "A timeout is not a verdict."  A cold start, a laptop waking from sleep, and
 *      a `cargo build` pinning every core all produce AbortErrors against a perfectly
 *      healthy server. Declaring it down on one of them is how a memory layer trains its
 *      users to uninstall it.
 *   2. `auth_failed` is sticky and never feeds the failure-count breaker. Opening a breaker
 *      on a 401 hides the single error the user can actually fix.
 *
 * Every window/cooldown is shrunk through `MUBIT_CC_BREAKER_*` (§6.1) — this file must
 * never sleep for real seconds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { lib, baseEnv, makeDataDir } from './helpers/harness.mjs';

/** The complete `ConnState` union (§4.7). Nothing outside this set may ever be produced. */
const CONN_STATES = [
  'ready', 'unreachable', 'server_error', 'auth_failed', 'not_responding', 'unconfigured',
];

/**
 * The subset `classifyError` is allowed to return. `unconfigured` is a ConnState but never a
 * classification: it is decided in `lib/http.mjs` *before* a dial, and no error object or
 * status code should be able to produce it. If it ever shows up here, some caller has reached
 * the socket on a config with no endpoint — which is the bug this state was added to end.
 */
const CLASSIFIABLE = CONN_STATES.filter((s) => s !== 'unconfigured');

/** Tiny breaker parameters so the whole file runs in well under a second. */
const TIGHT = {
  MUBIT_CC_BREAKER_THRESHOLD: '3',
  MUBIT_CC_BREAKER_WINDOW_MS: '5000',
  MUBIT_CC_BREAKER_COOLDOWN_MS: '40',
};

const LOCAL = 'https://unreachable.example.com';
const HOSTED = 'https://mubit.example.com';

/**
 * A fresh data dir + resolved config + a fresh `lib/breaker.mjs`.
 * @param {Record<string,string>} [extra]
 * @param {string} [endpoint]
 */
async function setup(extra = {}, endpoint = LOCAL) {
  const B = await lib('breaker.mjs');
  const dataDir = makeDataDir();
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(baseEnv({ dataDir, endpoint, extra: { ...TIGHT, ...extra } }));
  return { cfg, dataDir, B };
}

/** §4.7/§7: `breaker/<sha256(endpoint).slice(0,12)>.json`. */
function breakerPath(dataDir, endpoint) {
  const h = createHash('sha256').update(endpoint).digest('hex').slice(0, 12);
  return join(dataDir, 'breaker', `${h}.json`);
}

/** @param {string} code */
const err = (code) => Object.assign(new Error(code), { code });
const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// classifyError — the §4.7 mapping table, one assertion per row
// ---------------------------------------------------------------------------

/** @type {Array<[string, any, number|undefined, string]>} */
const CLASSIFY_ROWS = [
  // §4.7 row "2xx" — a parsed 2xx is the only thing that means the endpoint is healthy.
  ['200 → ready', null, 200, 'ready'],
  ['201 → ready', null, 201, 'ready'],
  ['204 → ready', null, 204, 'ready'],

  // §4.7 row "401, 403" / §1.2 — every /v2/control/* handler authenticates first.
  ['401 → auth_failed', null, 401, 'auth_failed'],
  ['403 → auth_failed', null, 403, 'auth_failed'],

  // §4.7 row "5xx, or unparseable body on a JSON route".
  ['500 → server_error', null, 500, 'server_error'],
  ['502 → server_error', null, 502, 'server_error'],
  ['503 → server_error', null, 503, 'server_error'],
  ['504 → server_error', null, 504, 'server_error'],
  // A 2xx whose body will not parse is a broken server, not a broken network: JSON.parse
  // throws SyntaxError and that is exactly what http.mjs hands back here.
  ['SyntaxError on a 200 JSON route → server_error', new SyntaxError('Unexpected token < in JSON at position 0'), 200, 'server_error'],

  // §4.7 row "ECONNREFUSED, ENOTFOUND, EHOSTUNREACH, ECONNRESET".
  ['ECONNREFUSED → unreachable', err('ECONNREFUSED'), undefined, 'unreachable'],
  ['ENOTFOUND → unreachable', err('ENOTFOUND'), undefined, 'unreachable'],
  ['EHOSTUNREACH → unreachable', err('EHOSTUNREACH'), undefined, 'unreachable'],
  ['ECONNRESET → unreachable', err('ECONNRESET'), undefined, 'unreachable'],

  // §4.7 row "AbortError / deadline exceeded" — classification names the symptom;
  // `recordFailure` decides whether the symptom ever becomes a verdict (see below).
  ['AbortError → not_responding', abortError(), undefined, 'not_responding'],
  ['DOMException AbortError → not_responding', new DOMException('aborted', 'AbortError'), undefined, 'not_responding'],
  ['TimeoutError → not_responding', Object.assign(new Error('timed out'), { name: 'TimeoutError' }), undefined, 'not_responding'],
  ['ETIMEDOUT → not_responding', err('ETIMEDOUT'), undefined, 'not_responding'],
];

for (const [label, e, status, want] of CLASSIFY_ROWS) {
  // §4.7 classification table.
  test(`classifyError: ${label}`, async () => {
    const { classifyError } = await lib('breaker.mjs');
    assert.equal(classifyError(e, status), want);
  });
}

// undici wraps socket errors: `TypeError: fetch failed` with the real code on `.cause`.
// Missing this is how every network failure gets misfiled as a server fault.
test('classifyError: undici-wrapped cause code still classifies as unreachable', async () => {
  const { classifyError } = await lib('breaker.mjs');
  const wrapped = Object.assign(new TypeError('fetch failed'), { cause: err('ECONNREFUSED') });
  assert.equal(classifyError(wrapped, undefined), 'unreachable');
});

// Same wrapping applies to the abort path when fetch is aborted by an AbortController.
test('classifyError: undici-wrapped AbortError still classifies as not_responding', async () => {
  const { classifyError } = await lib('breaker.mjs');
  const wrapped = Object.assign(new TypeError('fetch failed'), { cause: abortError() });
  assert.equal(classifyError(wrapped, undefined), 'not_responding');
});

// §4.7: the ConnState union is closed. Anything else leaks into the status line and the
// marker, where `bin/statusline.mjs` has no glyph for it.
test('classifyError: never produces a state outside the classifiable ConnState values', async () => {
  const { classifyError } = await lib('breaker.mjs');
  /** @type {Array<[any, any]>} */
  const grid = [];
  for (const s of [100, 200, 201, 204, 301, 304, 400, 401, 403, 404, 408, 413, 422, 429, 500, 502, 503, 504, 599, 0, undefined, null]) {
    grid.push([null, s]);
  }
  for (const c of ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'ENETDOWN', 'ETIMEDOUT', 'EACCES']) {
    grid.push([err(c), undefined]);
  }
  grid.push([new TypeError('fetch failed'), undefined]);
  grid.push([new SyntaxError('Unexpected end of JSON input'), 200]);
  grid.push([abortError(), undefined]);
  grid.push([new Error('something nobody predicted'), undefined]);
  grid.push([{}, undefined]);
  grid.push([undefined, undefined]);

  for (const [e, s] of grid) {
    const got = classifyError(e, s);
    assert.ok(CLASSIFIABLE.includes(got),
      `classifyError(${e && (e.code || e.name)}, ${s}) produced "${got}", outside ConnState`);
  }
});

// §4.7/C1b — a breaker exists to stop dialing a server that is failing. An unconfigured
// install never dialed one, so there is nothing to trip and nothing to cool down. Recording
// it opened the breaker on a local config gap and then suppressed recall for the cooldown,
// against an instance the user was one command away from having.
test('recordFailure: `unconfigured` is never recorded — no file, no failures, no open', async () => {
  const { recordFailure, readBreaker, breakerPath } = await lib('breaker.mjs');
  const dataDir = makeDataDir();
  const cfg = { dataDir, endpoint: '', breaker: { threshold: 3, windowMs: 5000, cooldownMs: 1000 } };

  for (let i = 0; i < 10; i++) recordFailure(cfg, 'unconfigured');

  assert.equal(existsSync(breakerPath(cfg)), false,
    'ten unconfigured "failures" wrote a breaker file for an endpoint that was never dialed');
  const b = readBreaker(cfg);
  assert.equal(b.openedAt, 0);
  assert.equal(b.failures.length, 0);
});

// §1.3/§5.5: a 422 is a bad payload, a 413 is an oversized body, a 429 is backpressure.
// None of them mean "auth is broken" or "the host is gone" — misfiling them either pins
// the status line to `✖ auth` or tells the user their server is down.
test('classifyError: non-auth 4xx is neither auth_failed nor unreachable', async () => {
  const { classifyError } = await lib('breaker.mjs');
  for (const s of [400, 404, 408, 413, 422, 429]) {
    const got = classifyError(null, s);
    assert.ok(CONN_STATES.includes(got), `status ${s} produced "${got}"`);
    assert.notEqual(got, 'auth_failed', `status ${s} must not read as auth_failed`);
    assert.notEqual(got, 'unreachable', `status ${s} must not read as unreachable`);
    assert.notEqual(got, 'ready', `status ${s} must not read as ready`);
  }
});

// ---------------------------------------------------------------------------
// State file — §7 `breaker/<endpoint_hash>.json`
// ---------------------------------------------------------------------------

// §4.7: a never-contacted endpoint is optimistic — closed breaker, no failures, no streak.
test('readBreaker: a fresh breaker is closed, ready and empty', async () => {
  const { cfg, B } = await setup();
  const b = B.readBreaker(cfg);
  assert.equal(b.state, 'ready');
  assert.deepEqual(b.failures, []);
  assert.ok(!b.openedAt, `fresh breaker must not be open, got openedAt=${b.openedAt}`);
  assert.equal(b.timeoutStreak, 0);
  assert.equal(B.allowRequest(cfg), true);
});

// §7: state file `breaker/<sha256(endpoint).slice(0,12)>.json` with the §4.7 field set.
test('recordFailure: writes breaker/<sha256(endpoint).slice(0,12)>.json with the documented shape', async () => {
  const { cfg, dataDir, B } = await setup();
  B.recordFailure(cfg, 'unreachable');

  const p = breakerPath(dataDir, cfg.endpoint);
  assert.ok(existsSync(p), `expected breaker state at ${p}`);
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  for (const k of ['state', 'failures', 'openedAt', 'timeoutStreak', 'lastOkAt', 'lastState']) {
    assert.ok(k in raw, `breaker file is missing "${k}"`);
  }
  assert.ok(Array.isArray(raw.failures));
  assert.equal(raw.failures.length, 1);
  assert.ok(Math.abs(raw.failures[0] - Date.now()) < 5000, 'failures[] holds epoch-ms timestamps');
});

// §4.7: per endpoint. Switching between a local and a hosted instance must not inherit the
// other's verdict — otherwise `MUBIT_ENDPOINT=https://…` starts life inside a local outage.
test('breaker state is per endpoint: a local outage does not condemn the hosted endpoint', async () => {
  const B = await lib('breaker.mjs');
  const dataDir = makeDataDir();
  const { loadConfig } = await lib('config.mjs');
  const local = loadConfig(baseEnv({ dataDir, endpoint: LOCAL, extra: TIGHT }));
  const hosted = loadConfig(baseEnv({ dataDir, endpoint: HOSTED, extra: TIGHT }));

  for (let i = 0; i < 3; i++) B.recordFailure(local, 'unreachable');

  assert.equal(B.allowRequest(local), false, 'the local breaker should be open');
  assert.equal(B.allowRequest(hosted), true, 'the hosted breaker must be untouched');
  assert.equal(B.readBreaker(hosted).state, 'ready');
  assert.deepEqual(B.readBreaker(hosted).failures, []);

  assert.ok(existsSync(breakerPath(dataDir, LOCAL)), 'the local endpoint has its own state file');
  assert.notEqual(breakerPath(dataDir, LOCAL), breakerPath(dataDir, HOSTED),
    'the two endpoints hash to different files');
});

// §4.9 discipline: nothing in this plugin may throw on a corrupt file. A half-written
// breaker (SIGKILL mid-write) must degrade to a fresh, closed breaker.
test('readBreaker: a truncated state file degrades to a fresh closed breaker, never throws', async () => {
  const { cfg, dataDir, B } = await setup();
  writeFileSync(breakerPath(dataDir, cfg.endpoint), '{"state":"unreach');

  const b = B.readBreaker(cfg);
  assert.equal(b.state, 'ready');
  assert.deepEqual(b.failures, []);
  assert.equal(B.allowRequest(cfg), true);
});

// Same, for a file that parses but holds nonsense types.
test('readBreaker: wrongly typed fields degrade instead of throwing', async () => {
  const { cfg, dataDir, B } = await setup();
  writeFileSync(breakerPath(dataDir, cfg.endpoint),
    JSON.stringify({ state: 42, failures: 'nope', openedAt: 'soon', timeoutStreak: null }));

  const b = B.readBreaker(cfg);
  assert.ok(CONN_STATES.includes(b.state), `state degraded to "${b.state}"`);
  assert.ok(Array.isArray(b.failures));
  assert.equal(B.allowRequest(cfg), true);
});

// An empty file is what a full disk leaves behind.
test('readBreaker: an empty state file degrades to a fresh closed breaker', async () => {
  const { cfg, dataDir, B } = await setup();
  writeFileSync(breakerPath(dataDir, cfg.endpoint), '');
  assert.equal(B.readBreaker(cfg).state, 'ready');
  assert.equal(B.allowRequest(cfg), true);
});

// ---------------------------------------------------------------------------
// "A timeout is not a verdict." — §4.7
// ---------------------------------------------------------------------------

// §4.7 / F4: one AbortError sets no state. It increments the streak and nothing else.
test('timeout: a single AbortError increments timeoutStreak and leaves the state unchanged', async () => {
  const { cfg, B } = await setup();
  B.recordSuccess(cfg);
  assert.equal(B.readBreaker(cfg).state, 'ready');

  B.recordFailure(cfg, 'not_responding');

  const b = B.readBreaker(cfg);
  assert.equal(b.timeoutStreak, 1);
  assert.equal(b.state, 'ready', 'one timeout must not move the reported state');
});

// The same holds from a non-ready base: a timeout never rewrites an existing verdict.
test('timeout: a single AbortError does not overwrite an existing server_error verdict', async () => {
  const { cfg, B } = await setup();
  B.recordFailure(cfg, 'server_error');
  B.recordFailure(cfg, 'not_responding');

  const b = B.readBreaker(cfg);
  assert.equal(b.state, 'server_error');
  assert.equal(b.timeoutStreak, 1);
});

// §4.7: two is still not enough. The escalation threshold is exactly three.
test('timeout: two consecutive timeouts still do not escalate', async () => {
  const { cfg, B } = await setup();
  B.recordSuccess(cfg);
  B.recordFailure(cfg, 'not_responding');
  B.recordFailure(cfg, 'not_responding');

  const b = B.readBreaker(cfg);
  assert.equal(b.timeoutStreak, 2);
  assert.equal(b.state, 'ready');
});

// §4.7 / F5: only `timeoutStreak >= 3` escalates, and only to `not_responding`.
test('timeout: three consecutive timeouts escalate to not_responding', async () => {
  const { cfg, B } = await setup();
  B.recordSuccess(cfg);
  for (let i = 0; i < 3; i++) B.recordFailure(cfg, 'not_responding');

  const b = B.readBreaker(cfg);
  assert.equal(b.timeoutStreak, 3);
  assert.equal(b.state, 'not_responding');
});

// §4.7: "never to `unreachable` or `server_error`". A slow server is not a dead one, and
// the difference is the whole content of the message the user reads.
test('timeout: ten timeouts still say not_responding, never unreachable or server_error', async () => {
  const { cfg, B } = await setup({ MUBIT_CC_BREAKER_THRESHOLD: '100' });
  for (let i = 0; i < 10; i++) B.recordFailure(cfg, 'not_responding');

  const b = B.readBreaker(cfg);
  assert.equal(b.state, 'not_responding');
  assert.equal(b.timeoutStreak, 10);
});

// §4.7 / F6: a success resets the streak, so intermittent slowness never accumulates into
// a verdict across a whole session.
test('timeout: a success resets timeoutStreak to zero', async () => {
  const { cfg, B } = await setup();
  B.recordFailure(cfg, 'not_responding');
  B.recordFailure(cfg, 'not_responding');
  B.recordSuccess(cfg);

  assert.equal(B.readBreaker(cfg).timeoutStreak, 0);

  // Two more must therefore still be short of the escalation threshold.
  B.recordFailure(cfg, 'not_responding');
  B.recordFailure(cfg, 'not_responding');
  const b = B.readBreaker(cfg);
  assert.equal(b.timeoutStreak, 2);
  assert.equal(b.state, 'ready');
});

// §4.7 + F7: "not a verdict" governs the *reported state*, not the breaker. A wedged
// server that times out every request must still trip the failure counter, or every prompt
// pays the full recall budget forever.
test('timeout: timeouts still count toward the failure-count breaker', async () => {
  const { cfg, B } = await setup();       // threshold 3
  for (let i = 0; i < 3; i++) B.recordFailure(cfg, 'not_responding');

  assert.equal(B.readBreaker(cfg).failures.length, 3);
  assert.equal(B.allowRequest(cfg), false, 'three timeouts at threshold 3 must open the breaker');
});

// ---------------------------------------------------------------------------
// auth_failed is sticky and does not feed the breaker — §4.7
// ---------------------------------------------------------------------------

// §4.7 / F3: ten consecutive 401s leave `failures` empty and the breaker closed. Opening
// on a 401 hides the one error the user can actually fix by pasting a key.
test('auth_failed: ten consecutive 401s record no failures and never open the breaker', async () => {
  const { cfg, B } = await setup();
  for (let i = 0; i < 10; i++) B.recordFailure(cfg, 'auth_failed');

  const b = B.readBreaker(cfg);
  assert.equal(b.state, 'auth_failed');
  assert.deepEqual(b.failures, [], 'auth failures must not enter the failure window');
  assert.ok(!b.openedAt);
  assert.equal(B.allowRequest(cfg), true, 'the breaker must stay closed on auth failures');
});

// §4.7: sticky — a later transport or server failure does not displace the auth verdict,
// because fixing the key is still the only action that helps.
test('auth_failed: stays pinned when a later server_error arrives', async () => {
  const { cfg, B } = await setup();
  B.recordFailure(cfg, 'auth_failed');
  B.recordFailure(cfg, 'server_error');

  const b = B.readBreaker(cfg);
  assert.equal(b.state, 'auth_failed', 'auth_failed is sticky until a success clears it');
  assert.equal(b.failures.length, 1, 'the server_error still counts toward the breaker');
});

// §4.7: "It pins the status line to ✖ auth until a success clears it."
test('auth_failed: only a success clears the sticky state', async () => {
  const { cfg, B } = await setup();
  for (let i = 0; i < 4; i++) B.recordFailure(cfg, 'auth_failed');
  assert.equal(B.readBreaker(cfg).state, 'auth_failed');

  B.recordSuccess(cfg);

  const b = B.readBreaker(cfg);
  assert.equal(b.state, 'ready');
  assert.deepEqual(b.failures, []);
  assert.ok(b.lastOkAt > 0, 'recordSuccess stamps lastOkAt');
});

// ---------------------------------------------------------------------------
// Threshold, window, cooldown — §4.7 (5 failures / 300 s → open for 120 s)
// ---------------------------------------------------------------------------

// §4.7: threshold-many failures inside the window opens the breaker.
test('breaker: threshold failures within the window opens it', async () => {
  const { cfg, B } = await setup();       // threshold 3
  assert.equal(cfg.breaker.threshold, 3, 'MUBIT_CC_BREAKER_THRESHOLD feeds cfg.breaker.threshold');

  B.recordFailure(cfg, 'unreachable');
  B.recordFailure(cfg, 'unreachable');
  assert.equal(B.allowRequest(cfg), true, 'below threshold the breaker stays closed');

  B.recordFailure(cfg, 'unreachable');
  assert.equal(B.allowRequest(cfg), false);
  assert.ok(B.readBreaker(cfg).openedAt > 0, 'openedAt is stamped when the breaker opens');
});

// A closed breaker's `allowRequest` is a pure read — calling it repeatedly must not consume
// anything, or a hook that checks twice would lock itself out.
test('breaker: allowRequest is idempotent while closed', async () => {
  const { cfg, B } = await setup();
  for (let i = 0; i < 5; i++) assert.equal(B.allowRequest(cfg), true);
  B.recordFailure(cfg, 'unreachable');
  for (let i = 0; i < 5; i++) assert.equal(B.allowRequest(cfg), true);
});

// §4.7 / §12.6: the window is rolling — failures older than it drop out and stop counting.
// Without expiry, five failures spread over a week would open the breaker on a healthy box.
test('breaker: failures older than the window expire and no longer count', async () => {
  const { cfg, B } = await setup({ MUBIT_CC_BREAKER_WINDOW_MS: '40' });

  B.recordFailure(cfg, 'unreachable');
  B.recordFailure(cfg, 'unreachable');
  await sleep(70);                        // both fall out of the 40 ms window

  B.recordFailure(cfg, 'unreachable');
  B.recordFailure(cfg, 'unreachable');

  const b = B.readBreaker(cfg);
  assert.equal(b.failures.length, 2, 'expired failures are pruned from the persisted window');
  assert.equal(B.allowRequest(cfg), true, 'two fresh failures are below the threshold of 3');
});

// §4.7 / F8: after the cooldown exactly one half-open probe dials; a second short-circuits.
test('breaker: after the cooldown exactly one half-open probe is allowed', async () => {
  const { cfg, B } = await setup();       // cooldown 40 ms
  for (let i = 0; i < 3; i++) B.recordFailure(cfg, 'unreachable');
  assert.equal(B.allowRequest(cfg), false, 'open inside the cooldown');

  await sleep(60);
  assert.equal(B.allowRequest(cfg), true, 'first call after the cooldown is the probe');
  assert.equal(B.allowRequest(cfg), false, 'the probe is consumed — no second dial');

  await sleep(60);
  assert.equal(B.allowRequest(cfg), true, 'a further cooldown earns another single probe');
});

// §4.7 / F9: a successful probe closes the breaker and clears the failure window.
test('breaker: a successful half-open probe closes it and clears failures', async () => {
  const { cfg, B } = await setup();
  for (let i = 0; i < 3; i++) B.recordFailure(cfg, 'unreachable');
  await sleep(60);
  assert.equal(B.allowRequest(cfg), true);

  B.recordSuccess(cfg);

  const b = B.readBreaker(cfg);
  assert.equal(b.state, 'ready');
  assert.deepEqual(b.failures, []);
  assert.ok(!b.openedAt, 'a closed breaker carries no openedAt');
  assert.equal(B.allowRequest(cfg), true);
  assert.equal(B.allowRequest(cfg), true, 'closed means unlimited requests again');
});

// §4.7: a failed probe re-opens with a FRESH openedAt, so the next probe is a full cooldown
// away rather than immediately available.
test('breaker: a failed half-open probe re-opens with a fresh openedAt', async () => {
  const { cfg, B } = await setup();
  for (let i = 0; i < 3; i++) B.recordFailure(cfg, 'unreachable');
  const firstOpenedAt = B.readBreaker(cfg).openedAt;

  await sleep(60);
  assert.equal(B.allowRequest(cfg), true, 'probe allowed');
  B.recordFailure(cfg, 'unreachable');

  const b = B.readBreaker(cfg);
  assert.equal(B.allowRequest(cfg), false, 're-opened');
  assert.ok(b.openedAt > firstOpenedAt,
    `expected a fresh openedAt, got ${b.openedAt} <= ${firstOpenedAt}`);
});

// ---------------------------------------------------------------------------
// Cold-start suppression — §4.7, §4.8 (marker.cold_start_until), F20
// ---------------------------------------------------------------------------

// §4.7: within `coldStartGraceMs` of the run's first SessionStart the failure is still
// recorded, but it is reported as `warming` and no systemMessage is emitted. A user who
// whose instance is still starting should not be told memory is broken for
// the first seconds it spends warming up.
//
// The grace deadline is an absolute epoch-ms timestamp — the same value the marker stores
// as `cold_start_until` (§4.8) — and is passed in, because the breaker is keyed by endpoint
// and knows nothing about runs.
test('cold start: a failure inside the grace window reports "warming" and suppresses the message', async () => {
  const { cfg, B } = await setup();
  assert.equal(cfg.coldStartGraceMs, 20000, 'MUBIT_CC_COLDSTART_GRACE_MS defaults to 20000');

  B.recordFailure(cfg, 'unreachable');

  const b = B.readBreaker(cfg, { coldStartUntil: Date.now() + cfg.coldStartGraceMs });
  assert.equal(b.state, 'unreachable', 'the truth is still recorded');
  assert.equal(b.failures.length, 1, 'failures are counted during the grace window');
  assert.equal(b.display, 'warming', 'the *displayed* state is warming');
  assert.equal(b.suppressMessage, true, 'no systemMessage while warming');
});

// §4.7: once the grace expires the real verdict surfaces.
test('cold start: past the grace window the real state is displayed again', async () => {
  const { cfg, B } = await setup();
  B.recordFailure(cfg, 'unreachable');

  const b = B.readBreaker(cfg, { coldStartUntil: Date.now() - 1 });
  assert.equal(b.display, 'unreachable');
  assert.equal(b.suppressMessage, false);
});

// With no cold-start deadline supplied at all, display is simply the state.
test('cold start: absent a coldStartUntil, display mirrors state and nothing is suppressed', async () => {
  const { cfg, B } = await setup();
  B.recordFailure(cfg, 'server_error');

  const b = B.readBreaker(cfg);
  assert.equal(b.display, 'server_error');
  assert.equal(b.suppressMessage, false);
});

// A ready breaker inside the grace window must not be dressed up as a problem either —
// `warming` only ever replaces a failure glyph, never a healthy one.
test('cold start: a healthy breaker inside the grace window still displays ready', async () => {
  const { cfg, B } = await setup();
  B.recordSuccess(cfg);

  const b = B.readBreaker(cfg, { coldStartUntil: Date.now() + 20000 });
  assert.equal(b.state, 'ready');
  assert.equal(b.display, 'ready');
  assert.equal(b.suppressMessage, false);
});
