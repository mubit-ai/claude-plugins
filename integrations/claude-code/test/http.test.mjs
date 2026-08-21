// @ts-check
/**
 * `lib/http.mjs` — "the only network primitive".
 *
 * Guide sections under test: §4.2 (the module), §1.1 (routes and the per-route 256 KiB cap
 * on /v2/control/query), §1.2 (auth, and the one allowlisted unauthenticated route),
 * §1.3 (required fields — a missing one is a 422, not a silent default), §1.8 + §5.2 (the
 * `mode` literal and what a typo costs), §4.3 (the `"default"` run-id guard), §4.7 (the
 * breaker is consulted before dialing).
 *
 * The load-bearing property of this module is that it NEVER throws. Every hook in the
 * plugin exits 0 in every failure mode (§4.9), and that is only affordable because the
 * network layer hands back a value for every outcome — including the ones that are not
 * HTTP outcomes at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { lib, baseEnv, makeDataDir, fakeMubit } from './helpers/harness.mjs';
import { spoolItem } from './helpers/fixtures.mjs';

const RUN = 'cc-my-project-9f2a11c4';
const AGENT = 'claude-code-4f21ab';

/**
 * Fake Mubit + a data dir + a resolved config pointed at it + a fresh `lib/http.mjs`.
 * @param {import('node:test').TestContext} t
 * @param {{routes?: Record<string,any>, extra?: Record<string,string>, apiKey?: string}} [o]
 */
async function setup(t, o = {}) {
  const server = await fakeMubit(o.routes ?? {});
  // Fire-and-forget: a test that deliberately hangs a socket must not be able to wedge
  // teardown behind `server.close()` waiting for that connection to drain.
  t.after(() => { server.close(); });

  const http = await lib('http.mjs');
  const dataDir = makeDataDir();
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(baseEnv({ dataDir, endpoint: server.url, apiKey: o.apiKey, extra: o.extra }));
  return { server, cfg, dataDir, http };
}

/** A config pointed at a port nothing is listening on — ECONNREFUSED on demand. */
async function setupDead(t, o = {}) {
  const probe = await fakeMubit();
  const url = probe.url;
  await probe.close();

  const http = await lib('http.mjs');
  const dataDir = makeDataDir();
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(baseEnv({ dataDir, endpoint: url, extra: o.extra }));
  return { cfg, dataDir, http, url };
}

/** @template T @param {() => Promise<T>} fn @param {string} label @returns {Promise<T>} */
async function noThrow(fn, label) {
  try {
    return await fn();
  } catch (e) {
    return assert.fail(`${label} threw instead of returning a result: ${(e && e.stack) || e}`);
  }
}

/** @param {any} r */
function assertResultEnvelope(r) {
  assert.equal(typeof r, 'object', 'request() must return an object');
  assert.equal(typeof r.ok, 'boolean', 'every result carries a boolean `ok`');
  assert.equal(typeof r.ms, 'number', 'every result carries elapsed `ms`');
  assert.ok(r.ms >= 0);
}

const logText = (dataDir) => {
  const p = join(dataDir, 'logs', 'mubit-cc.log');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

// ---------------------------------------------------------------------------
// request() never throws — §4.2
// ---------------------------------------------------------------------------

// §4.2: the success envelope is {ok:true, status, body, ms}.
test('request: a 200 returns {ok:true, status, body, ms}', async (t) => {
  const { cfg, http } = await setup(t);
  const r = await noThrow(() => http.request(cfg, 'POST', '/v2/control/outcome',
    { run_id: RUN, reference_id: 'global' }), 'request(200)');

  assertResultEnvelope(r);
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
});

// §1.2 / §4.7: a 401 is a returned value, not an exception, and it is classified.
test('request: a 401 returns {ok:false, state:"auth_failed"} without throwing', async (t) => {
  const { cfg, http } = await setup(t, {
    routes: { 'POST /v2/control/query': { status: 401, json: { error: 'unauthorized' } } },
  });
  const r = await noThrow(() => http.request(cfg, 'POST', '/v2/control/query', { run_id: RUN }), 'request(401)');

  assertResultEnvelope(r);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'auth_failed');
  assert.equal(r.status, 401);
  assert.ok(r.error, 'a failed result carries an error string');
});

// §4.7: 5xx → server_error.
test('request: a 500 returns {ok:false, state:"server_error"} without throwing', async (t) => {
  const { cfg, http } = await setup(t, {
    routes: { 'POST /v2/control/ingest': { status: 500, json: { error: 'boom' } } },
  });
  const r = await noThrow(() => http.request(cfg, 'POST', '/v2/control/ingest', { run_id: RUN }), 'request(500)');

  assertResultEnvelope(r);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'server_error');
  assert.equal(r.status, 500);
});

// §4.7: an unparseable body on a JSON route is a server fault, not an unhandled
// rejection. A reverse proxy returning an HTML error page is the real-world shape.
test('request: a non-JSON body on a JSON route returns server_error, no unhandled rejection', async (t) => {
  const { cfg, http } = await setup(t, {
    routes: { 'POST /v2/control/query': { status: 200, text: '<html><body>502 Bad Gateway</body></html>' } },
  });
  const r = await noThrow(() => http.request(cfg, 'POST', '/v2/control/query', { run_id: RUN }), 'request(non-JSON)');

  assertResultEnvelope(r);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'server_error');
});

// §4.7: nothing listening. The most common state of a local Mubit.
test('request: a refused connection returns {ok:false, state:"unreachable"} without throwing', async (t) => {
  const { cfg, http } = await setupDead(t);
  const r = await noThrow(() => http.request(cfg, 'POST', '/v2/control/ingest', { run_id: RUN },
    { timeoutMs: 1000 }), 'request(ECONNREFUSED)');

  assertResultEnvelope(r);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'unreachable');
});

// §4.7: a socket that is accepted and then never answered is the timeout path.
test('request: a hung socket returns {ok:false, state:"not_responding"} without throwing', async (t) => {
  const { cfg, http } = await setup(t, { routes: { 'POST /v2/control/query': { hang: true } } });
  const r = await noThrow(() => http.request(cfg, 'POST', '/v2/control/query', { run_id: RUN },
    { timeoutMs: 150 }), 'request(hang)');

  assertResultEnvelope(r);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'not_responding');
});

// §1.3: the wire contract is JSON on every route except health.
test('request: sends application/json on control routes', async (t) => {
  const { server, cfg, http } = await setup(t);
  await http.request(cfg, 'POST', '/v2/control/checkpoint', { run_id: RUN });

  const call = server.lastCall('POST', '/v2/control/checkpoint');
  assert.ok(call, 'the request should have been made');
  assert.match(String(call.headers['content-type']), /application\/json/);
  assert.deepEqual(call.body, { run_id: RUN }, 'the body is sent verbatim as JSON');
});

// §4.7: http.mjs is what feeds the breaker; without this, the breaker could never open.
test('request: a server failure is recorded on the breaker', async (t) => {
  const { cfg, dataDir, http } = await setup(t, {
    routes: { 'POST /v2/control/ingest': { status: 500, json: { error: 'boom' } } },
    extra: { MUBIT_CC_BREAKER_THRESHOLD: '3', MUBIT_CC_BREAKER_WINDOW_MS: '5000' },
  });
  const { readBreaker } = await lib('breaker.mjs');

  await http.request(cfg, 'POST', '/v2/control/ingest', { run_id: RUN });

  const b = readBreaker(cfg);
  assert.equal(b.state, 'server_error');
  assert.equal(b.failures.length, 1);
  assert.ok(dataDir);
});

// ---------------------------------------------------------------------------
// health() — §1.2, §4.2, §7
// ---------------------------------------------------------------------------

// §1.2: `GET /v2/core/health` returns the literal bare string `OK`
//. JSON.parse there is a guaranteed false negative — it
// would report every healthy server as unhealthy and the plugin would never dial again.
test('health: reads the body as TEXT and succeeds against the literal "OK"', async (t) => {
  const { server, cfg, http } = await setup(t, { routes: { 'GET /v2/core/health': { text: 'OK' } } });

  const r = await noThrow(() => http.health(cfg), 'health()');
  assert.equal(r.ok, true, 'a bare "OK" body is a healthy instance');
  assert.equal(r.body, 'OK', 'the body is the raw text, not a parsed object');
  server.assertCalled('GET', '/v2/core/health', 1);
});

// §4.7 — a 2xx is necessary and not sufficient. An SSO portal, a captive portal, a proxy
// error page and an unrelated service all answer 200; taking the status alone as healthy
// opened the session by telling the model memory was active when nothing behind the
// endpoint was Mubit. The route returns `OK`, so one comparison settles it.
test('health: a 200 whose body is not "OK" is server_error, never ready', async (t) => {
  const { cfg, http } = await setup(t, {
    routes: { 'GET /v2/core/health': { text: '<!DOCTYPE html><title>Sign in</title>' } },
  });

  const r = await noThrow(() => http.health(cfg), 'health(sso)');
  assert.equal(r.ok, false, 'an HTML login page at the endpoint is not a healthy Mubit');
  assert.equal(r.state, 'server_error');
  assert.match(r.error, /body was not "OK"/);
});

// The check has to happen before the write, or the 30 s cache remembers a wrong host as
// healthy and the next four sessions never re-dial to find out otherwise.
test('health: a non-"OK" 200 is not cached as ready', async (t) => {
  const { cfg, dataDir, http } = await setup(t, {
    routes: { 'GET /v2/core/health': { text: 'Gateway Timeout' } },
  });

  await http.health(cfg);
  const cached = JSON.parse(readFileSync(join(dataDir, 'status', 'health.json'), 'utf8'));
  assert.equal(cached.ok, false, 'the failure is what gets cached');
  assert.equal(cached.state, 'server_error');

  const second = await http.health(cfg);
  assert.equal(second.ok, false, 'the cached verdict is still a failure');
});

// Trimmed, not exact: a proxy that appends a newline has still relayed a healthy answer,
// and failing that would report every instance behind such a proxy as broken.
test('health: surrounding whitespace on "OK" is still healthy', async (t) => {
  const { cfg, http } = await setup(t, { routes: { 'GET /v2/core/health': { text: 'OK\n' } } });

  const r = await noThrow(() => http.health(cfg), 'health(OK\\n)');
  assert.equal(r.ok, true);
});

// §4.1 — the guard that makes `unconfigured` mean what it says. Before it, `urlFor`
// handed `fetch` the bare route, `fetch` threw ERR_INVALID_URL before opening a socket, and
// the throw was classified as a fault in a server that was never contacted.
test('no endpoint: every call refuses without dialing and without touching the breaker', async (t) => {
  const http = await lib('http.mjs');
  const dataDir = makeDataDir();
  const { loadConfig } = await lib('config.mjs');
  const { breakerPath } = await lib('breaker.mjs');

  for (const endpoint of ['', '   ', 'eu.mubit.ai', 'htp://nope']) {
    const cfg = loadConfig(baseEnv({ dataDir, endpoint }));

    const h = await noThrow(() => http.health(cfg), `health(${JSON.stringify(endpoint)})`);
    assert.equal(h.ok, false);
    assert.equal(h.state, 'unconfigured', `endpoint ${JSON.stringify(endpoint)}`);

    const q = await noThrow(() => http.postQuery(cfg, { run_id: RUN, query: 'why', mode: 'direct_bypass', evidence_only: true }),
      `postQuery(${JSON.stringify(endpoint)})`);
    assert.equal(q.state, 'unconfigured');

    assert.equal(existsSync(breakerPath(cfg)), false,
      `a breaker file was written for endpoint ${JSON.stringify(endpoint)}, which was never dialed`);
  }
});

// §1.1/§7: the health result is cached for 30 s, so a SessionStart plus a status refresh
// do not each pay a round trip.
test('health: the result is cached for 30s — a second call makes zero extra requests', async (t) => {
  const { server, cfg, dataDir, http } = await setup(t);

  const first = await http.health(cfg);
  const second = await http.health(cfg);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  server.assertCalled('GET', '/v2/core/health', 1);
  assert.ok(existsSync(join(dataDir, 'status', 'health.json')),
    'the cached verdict lives at status/health.json (§7)');
});

// §1.2: health is the one route that answers before a credential is checked, which is what
// makes it usable as the readiness probe before the user has pasted a key.
test('health: works with no API key configured', async (t) => {
  const { server, cfg, http } = await setup(t, { apiKey: '' });

  const r = await http.health(cfg);
  assert.equal(r.ok, true);
  server.assertCalled('GET', '/v2/core/health', 1);
});

// §4.2: a down instance is a returned value like everything else.
test('health: an unreachable endpoint returns ok:false rather than throwing', async (t) => {
  const { cfg, http } = await setupDead(t);
  const r = await noThrow(() => http.health(cfg, { timeoutMs: 1000 }), 'health(dead)');
  assert.equal(r.ok, false);
  assert.equal(r.state, 'unreachable');
});

// ---------------------------------------------------------------------------
// Auth — §1.2
// ---------------------------------------------------------------------------

// §1.2: every /v2/control/* handler calls authenticate() first, including in local mode.
test('auth: every /v2/control/* request carries Authorization: Bearer <key>', async (t) => {
  const { server, cfg, http } = await setup(t);

  await http.postQuery(cfg, { run_id: RUN, query: 'why', mode: 'direct_bypass', evidence_only: true });
  await http.postIngest(cfg, { run_id: RUN, agent_id: AGENT, items: [spoolItem()] });

  for (const path of ['/v2/control/query', '/v2/control/ingest']) {
    const call = server.lastCall('POST', path);
    assert.ok(call, `expected a POST ${path}`);
    assert.equal(call.headers.authorization, `Bearer ${cfg.apiKey}`);
  }
});

// §1.2: a missing key must not produce `Authorization: Bearer ` or `Bearer undefined` —
// a malformed header is a harder 401 to diagnose than an absent one.
test('auth: a missing key sends no Authorization header at all', async (t) => {
  const { server, cfg, http } = await setup(t, { apiKey: '' });

  await http.postQuery(cfg, { run_id: RUN, query: 'why', mode: 'direct_bypass', evidence_only: true });

  const call = server.lastCall('POST', '/v2/control/query');
  assert.ok(call, 'the request is still made — the 401 is the server\'s to give');
  assert.ok(!('authorization' in call.headers),
    `expected no authorization header, got: ${JSON.stringify(call.headers.authorization)}`);
});

// ---------------------------------------------------------------------------
// Pre-flight guards — §1.1 cap, §5.2 mode literal, §4.3 "default"
// ---------------------------------------------------------------------------

// §1.1: /v2/control/query has a per-route 256 KiB cap; everything
// else inherits 64 MiB. Blowing it produces a 413 that looks like a server fault to the
// breaker, so the check happens client-side and nothing is dialed.
test('postQuery: a body over 256 KiB is rejected pre-flight and nothing is dialed', async (t) => {
  const { server, cfg, http } = await setup(t);

  const r = await noThrow(() => http.postQuery(cfg, {
    run_id: RUN, mode: 'direct_bypass', evidence_only: true,
    query: 'x'.repeat(300 * 1024),
  }), 'postQuery(oversized)');

  assert.equal(r.ok, false);
  assert.equal(server.requests.length, 0,
    `nothing may be dialed for an oversized body; saw: ${server.summary()}`);
  assert.match(String(r.error), /256|size|large|cap|byte/i);
});

// The cap is per route, and a normal recall payload is nowhere near it — the guard must
// not become a de-facto smaller limit.
test('postQuery: a body just under 256 KiB is sent', async (t) => {
  const { server, cfg, http } = await setup(t);

  const r = await http.postQuery(cfg, {
    run_id: RUN, mode: 'direct_bypass', evidence_only: true,
    query: 'x'.repeat(200 * 1024),
  });

  assert.equal(r.ok, true);
  server.assertCalled('POST', '/v2/control/query', 1);
});

// §5.2: only "direct_bypass" and "direct" select the direct lane; EVERY other value
// silently falls through to the routed lane with no error. A typo therefore costs an LLM
// call per prompt, forever,
// invisibly. Catch it client-side.
test('postQuery: a mistyped mode literal is rejected pre-flight and logged at error', async (t) => {
  const { server, cfg, dataDir, http } = await setup(t);

  const r = await noThrow(() => http.postQuery(cfg, {
    run_id: RUN, query: 'why', evidence_only: true, mode: 'direct-bypass',
  }), 'postQuery(bad mode)');

  assert.equal(r.ok, false);
  assert.equal(server.requests.length, 0,
    `a mode typo must dial nothing; saw: ${server.summary()}`);
  assert.match(logText(dataDir), /mode/i, 'the mismatch is logged at error level');
});

// The server matches the exact literals; case does not fold.
test('postQuery: mode is case-sensitive — "DIRECT_BYPASS" is rejected', async (t) => {
  const { server, cfg, http } = await setup(t);
  const r = await http.postQuery(cfg, {
    run_id: RUN, query: 'why', evidence_only: true, mode: 'DIRECT_BYPASS',
  });
  assert.equal(r.ok, false);
  assert.equal(server.requests.length, 0);
});

// §1.8 rung 1 and its documented alias.
for (const mode of ['direct_bypass', 'direct']) {
  test(`postQuery: mode "${mode}" reaches DirectBypass and is sent`, async (t) => {
    const { server, cfg, http } = await setup(t);
    const r = await http.postQuery(cfg, { run_id: RUN, query: 'why', evidence_only: true, mode });
    assert.equal(r.ok, true);
    server.assertCalled('POST', '/v2/control/query', 1);
    assert.equal(server.lastCall('POST', '/v2/control/query').body.mode, mode);
  });
}

// §1.8 rung 2 is a deliberate 1-LLM-call fallback entered only after a 403 on rung 1, so
// `agent_routed` is the third and last legal literal. The rejected class is "anything
// else", precisely because anything else *becomes* agent_routed without saying so.
test('postQuery: mode "agent_routed" is legal — it is rung 2, not a typo', async (t) => {
  const { server, cfg, http } = await setup(t);
  const r = await http.postQuery(cfg, { run_id: RUN, query: 'why', evidence_only: true, mode: 'agent_routed' });
  assert.equal(r.ok, true);
  server.assertCalled('POST', '/v2/control/query', 1);
});

// §5.2: "The field default when omitted is `agent_routed`, so omitting
// it is the expensive case." An omitted mode is indistinguishable from a typo in cost, so
// it gets the same treatment: the caller must state which rung it is paying for.
test('postQuery: an omitted mode is rejected pre-flight — omission is the expensive case', async (t) => {
  const { server, cfg, http } = await setup(t);
  const r = await http.postQuery(cfg, { run_id: RUN, query: 'why', evidence_only: true });
  assert.equal(r.ok, false);
  assert.equal(server.requests.length, 0);
});

// §4.3: `"default"` is the placeholder a session carries before anything has derived a real
// run id for it, so nothing sent under it can be attributed to the work that produced it.
// request() is the last line of defence and refuses to put it on the wire at all.
test('request: refuses any body whose run_id === "default", and dials nothing', async (t) => {
  const { server, cfg, dataDir, http } = await setup(t);

  const r = await noThrow(() => http.request(cfg, 'POST', '/v2/control/ingest',
    { run_id: 'default', items: [spoolItem()] }), 'request(run_id=default)');

  assert.equal(r.ok, false);
  assert.equal(server.requests.length, 0,
    `"default" must never reach the wire; saw: ${server.summary()}`);
  assert.match(logText(dataDir), /run_id|default/i, 'the refusal is logged at error level');
});

// The guard applies through the typed wrappers too — they are the only callers in practice.
test('postIngest: the "default" guard applies through the typed wrappers', async (t) => {
  const { server, cfg, http } = await setup(t);
  const r = await http.postIngest(cfg, { run_id: 'default', agent_id: AGENT, items: [spoolItem()] });
  assert.equal(r.ok, false);
  assert.equal(server.requests.length, 0);
});

// The guard is an exact-match on the poisoned literal, not a substring ban — a legitimate
// project called `default-config` must still be able to have a run.
test('request: a run_id that merely contains "default" is allowed', async (t) => {
  const { server, cfg, http } = await setup(t);
  const r = await http.request(cfg, 'POST', '/v2/control/checkpoint', { run_id: 'cc-default-config-9f2a11c4' });
  assert.equal(r.ok, true);
  server.assertCalled('POST', '/v2/control/checkpoint', 1);
});

// ---------------------------------------------------------------------------
// Required fields — §1.3 (a missing field is a 422, not a silent default)
// ---------------------------------------------------------------------------

const ingestItem = () => spoolItem();

/** @type {Array<[string, (h: any, cfg: any) => Promise<any>]>} */
const REJECT_ROWS = [
  // POST /v2/control/ingest — run_id
  ['postIngest requires run_id', (h, c) => h.postIngest(c, { agent_id: AGENT, items: [ingestItem()] })],
  // POST /v2/control/ingest, per item — item_id
  ['postIngest requires item_id on every item',
    (h, c) => h.postIngest(c, { run_id: RUN, agent_id: AGENT, items: [{ content_type: 'text', text: 'x', intent: 'trace' }] })],
  // POST /v2/control/ingest, per item — content_type
  ['postIngest requires content_type on every item',
    (h, c) => h.postIngest(c, { run_id: RUN, agent_id: AGENT, items: [{ item_id: 'i1', text: 'x', intent: 'trace' }] })],
  // One bad item poisons the batch: the server rejects the whole request, not the item.
  ['postIngest rejects a batch where only the second item is malformed',
    (h, c) => h.postIngest(c, { run_id: RUN, agent_id: AGENT, items: [ingestItem(), { text: 'x' }] })],
  // query payload — run_id
  ['postQuery requires run_id', (h, c) => h.postQuery(c, { query: 'why', mode: 'direct_bypass', evidence_only: true })],
  // POST /v2/control/context — run_id
  ['postContext requires run_id', (h, c) => h.postContext(c, { query: 'why', mode: 'sections' })],
  // POST /v2/control/checkpoint — run_id
  ['postCheckpoint requires run_id', (h, c) => h.postCheckpoint(c, { agent_id: AGENT, content: 'tail' })],
  // POST /v2/control/outcome — run_id
  ['postOutcome requires run_id', (h, c) => h.postOutcome(c, { reference_id: 'global', outcome: 'success' })],
  // POST /v2/control/outcome — reference_id must be present…
  ['postOutcome requires reference_id', (h, c) => h.postOutcome(c, { run_id: RUN, outcome: 'success' })],
  // …and NON-EMPTY (§1.3: pass "global" for run-level attribution, never "").
  ['postOutcome rejects an empty reference_id',
    (h, c) => h.postOutcome(c, { run_id: RUN, reference_id: '', outcome: 'success', entry_ids: ['ref_1'] })],
  // POST /v2/control/agents/register — run_id, agent_id
  ['registerAgent requires run_id', (h, c) => h.registerAgent(c, { agent_id: AGENT, role: 'worker' })],
  ['registerAgent requires agent_id', (h, c) => h.registerAgent(c, { run_id: RUN, role: 'worker' })],
  // job query — run_id on the query string
  ['getIngestJob requires run_id', (h, c) => h.getIngestJob(c, '', 'job_test_1')],
];

for (const [label, call] of REJECT_ROWS) {
  // §1.3: validate before dialing — a missing field is a 422, and a 422 looks like a
  // server fault to anything downstream.
  test(`required fields: ${label} (rejected pre-flight, nothing dialed)`, async (t) => {
    const { server, cfg, http } = await setup(t);
    const r = await noThrow(() => call(http, cfg), label);
    assert.equal(r.ok, false, `${label}: expected ok:false`);
    assert.equal(server.requests.length, 0,
      `${label}: expected zero requests, saw: ${server.summary()}`);
  });
}

/** @type {Array<[string, string, (h: any, cfg: any) => Promise<any>]>} */
const HAPPY_ROWS = [
  ['postIngest', '/v2/control/ingest',
    (h, c) => h.postIngest(c, { run_id: RUN, agent_id: AGENT, idempotency_key: 'cc-p1-1', parallel: true, items: [ingestItem()] })],
  ['postQuery', '/v2/control/query',
    (h, c) => h.postQuery(c, { run_id: RUN, agent_id: AGENT, query: 'why', mode: 'direct_bypass', evidence_only: true, budget: 'low', limit: 8 })],
  ['postContext', '/v2/control/context',
    (h, c) => h.postContext(c, { run_id: RUN, agent_id: AGENT, query: 'why', mode: 'sections', max_token_budget: 1500 })],
  ['postOutcome', '/v2/control/outcome',
    (h, c) => h.postOutcome(c, { run_id: RUN, reference_id: 'global', outcome: 'success', signal: 0.2, entry_ids: ['ref_rule_1'] })],
  ['postCheckpoint', '/v2/control/checkpoint',
    (h, c) => h.postCheckpoint(c, { run_id: RUN, agent_id: AGENT, content: 'transcript tail' })],
  ['postLessons', '/v2/control/lessons',
    (h, c) => h.postLessons(c, { scope: 'global', limit: 5 })],
  ['registerAgent', '/v2/control/agents/register',
    (h, c) => h.registerAgent(c, { run_id: RUN, agent_id: AGENT, role: 'worker', status: 'active', capabilities: ['code'] })],
  ['heartbeat', '/v2/control/agents/heartbeat',
    (h, c) => h.heartbeat(c, { run_id: RUN, agent_id: AGENT, status: 'idle' })],
];

for (const [name, path, call] of HAPPY_ROWS) {
  // §1.1: each wrapper owns exactly one route and issues exactly one request.
  test(`typed wrapper: ${name} POSTs ${path} exactly once`, async (t) => {
    const { server, cfg, http } = await setup(t);
    const r = await noThrow(() => call(http, cfg), name);
    assert.equal(r.ok, true, `${name} should have succeeded, got ${JSON.stringify(r)}`);
    server.assertCalled('POST', path, 1);
    assert.equal(server.requests.length, 1, `${name} must not dial anything else`);
  });
}

// §1.3: the job query takes run_id on the QUERY STRING, not the body —
// GET /v2/control/ingest/jobs/:job_id?run_id=<id>.
test('getIngestJob: puts run_id on the query string, not in a body', async (t) => {
  const { server, cfg, http } = await setup(t);

  const r = await http.getIngestJob(cfg, RUN, 'job_test_1');

  assert.equal(r.ok, true);
  server.assertCalled('GET', '/v2/control/ingest/jobs/job_test_1', 1);
  const call = server.lastCall('GET', '/v2/control/ingest/jobs/job_test_1');
  assert.equal(call.query.get('run_id'), RUN);
  assert.equal(call.raw, '', 'a GET carries no body');
});

// §5.4: `intent` is set on every item the plugin writes (§1.5) — omitting it costs one LLM
// round trip per item server-side. The wrapper must pass it through
// untouched rather than dropping unknown fields.
test('postIngest: forwards item_id, content_type and intent verbatim', async (t) => {
  const { server, cfg, http } = await setup(t);
  const item = ingestItem();

  await http.postIngest(cfg, { run_id: RUN, agent_id: AGENT, items: [item] });

  const sent = server.lastCall('POST', '/v2/control/ingest').body;
  assert.equal(sent.run_id, RUN);
  assert.equal(sent.items.length, 1);
  assert.equal(sent.items[0].item_id, item.item_id);
  assert.equal(sent.items[0].content_type, 'text');
  assert.equal(sent.items[0].intent, item.intent);
});

// ---------------------------------------------------------------------------
// Retries — §4.2 ("one, only for not_responding, only when the caller asks")
// ---------------------------------------------------------------------------

// §4.2: a 5xx is not retried. The server answered; hammering it is how a memory layer
// turns a blip into an outage.
test('retry: a 500 is never retried, even with {retry:true}', async (t) => {
  const { server, cfg, http } = await setup(t, {
    routes: { 'POST /v2/control/ingest': { status: 500, json: { error: 'boom' } } },
  });

  const r = await http.request(cfg, 'POST', '/v2/control/ingest', { run_id: RUN }, { retry: true });

  assert.equal(r.ok, false);
  server.assertCalled('POST', '/v2/control/ingest', 1);
});

// §4.2: blocking hooks never retry — a second 150 ms stall in front of a prompt buys
// nothing the user wants.
test('retry: a timeout without {retry:true} dials exactly once', async (t) => {
  const { server, cfg, http } = await setup(t, { routes: { 'POST /v2/control/query': { hang: true } } });

  const r = await http.request(cfg, 'POST', '/v2/control/query', { run_id: RUN }, { timeoutMs: 120 });

  assert.equal(r.ok, false);
  assert.equal(r.state, 'not_responding');
  server.assertCalled('POST', '/v2/control/query', 1);
});

// §4.2: exactly one retry, only on the timeout path, only when asked — which only
// drain.mjs does, because it is detached and nobody is waiting on it.
test('retry: a timeout with {retry:true} dials exactly twice', async (t) => {
  const { server, cfg, http } = await setup(t, { routes: { 'POST /v2/control/ingest': { hang: true } } });

  const r = await http.request(cfg, 'POST', '/v2/control/ingest', { run_id: RUN },
    { timeoutMs: 120, retry: true });

  assert.equal(r.ok, false);
  assert.equal(r.state, 'not_responding');
  server.assertCalled('POST', '/v2/control/ingest', 2);
});

// The typed wrappers forward opts, or drain.mjs cannot ask for its one retry.
test('retry: postIngest forwards {retry:true} to request()', async (t) => {
  const { server, cfg, http } = await setup(t, { routes: { 'POST /v2/control/ingest': { hang: true } } });

  const r = await http.postIngest(cfg,
    { run_id: RUN, agent_id: AGENT, items: [ingestItem()] },
    { timeoutMs: 120, retry: true });

  assert.equal(r.ok, false);
  server.assertCalled('POST', '/v2/control/ingest', 2);
});

// ---------------------------------------------------------------------------
// The breaker gate — §4.2, §4.7
// ---------------------------------------------------------------------------

// §4.2: "consults the breaker before dialing". An open breaker means zero syscalls, which
// is the entire point — a down instance must cost nothing per prompt.
test('breaker: with the breaker open, request() short-circuits and dials nothing', async (t) => {
  const { server, cfg, http } = await setup(t, {
    extra: { MUBIT_CC_BREAKER_THRESHOLD: '2', MUBIT_CC_BREAKER_WINDOW_MS: '5000', MUBIT_CC_BREAKER_COOLDOWN_MS: '60000' },
  });
  const { recordFailure, allowRequest } = await lib('breaker.mjs');

  recordFailure(cfg, 'unreachable');
  recordFailure(cfg, 'unreachable');
  assert.equal(allowRequest(cfg), false, 'precondition: the breaker is open');

  const r = await noThrow(() => http.request(cfg, 'POST', '/v2/control/query', { run_id: RUN }),
    'request(breaker open)');

  assert.equal(r.ok, false);
  assert.equal(r.state, 'unreachable', 'the short-circuit reports the last known state');
  assert.equal(server.requests.length, 0,
    `an open breaker must dial nothing; saw: ${server.summary()}`);
});

// ---------------------------------------------------------------------------
// Timeouts — §4.2 (`opts.timeoutMs ?? cfg.timeoutMs`, default 4000)
// ---------------------------------------------------------------------------

// §6.1: MUBIT_CC_TIMEOUT_MS default 4000.
test('timeout: cfg.timeoutMs defaults to 4000', async (t) => {
  const { cfg } = await setup(t);
  assert.equal(cfg.timeoutMs, 4000);
});

// §4.2: the config timeout actually aborts — a stalled response must not outlive it.
test('timeout: cfg.timeoutMs aborts a slow response', async (t) => {
  const { cfg, http } = await setup(t, {
    routes: { 'POST /v2/control/query': { delayMs: 900, json: { ok: true } } },
    extra: { MUBIT_CC_TIMEOUT_MS: '150' },
  });

  const started = Date.now();
  const r = await http.request(cfg, 'POST', '/v2/control/query', { run_id: RUN });
  const elapsed = Date.now() - started;

  assert.equal(r.ok, false);
  assert.equal(r.state, 'not_responding');
  assert.ok(elapsed < 600, `expected an abort near 150ms, took ${elapsed}ms`);
  assert.ok(r.ms < 600, `reported ms should reflect the abort, got ${r.ms}`);
});

// §4.2: `opts.timeoutMs ?? cfg.timeoutMs` — the recall path overrides it per call.
test('timeout: opts.timeoutMs overrides cfg.timeoutMs', async (t) => {
  const { cfg, http } = await setup(t, {
    routes: { 'POST /v2/control/query': { delayMs: 900, json: { ok: true } } },
    extra: { MUBIT_CC_TIMEOUT_MS: '5000' },
  });

  const started = Date.now();
  const r = await http.request(cfg, 'POST', '/v2/control/query', { run_id: RUN }, { timeoutMs: 150 });
  const elapsed = Date.now() - started;

  assert.equal(r.ok, false);
  assert.ok(elapsed < 600, `opts.timeoutMs should have aborted near 150ms, took ${elapsed}ms`);
});

// A response that lands inside the budget is not aborted — the deadline must not be a
// hair-trigger on a cold cache.
test('timeout: a response inside the budget still succeeds', async (t) => {
  const { cfg, http } = await setup(t, {
    routes: { 'POST /v2/control/query': { delayMs: 60, json: { final_answer: '', evidence: [] } } },
  });

  const r = await http.request(cfg, 'POST', '/v2/control/query', { run_id: RUN }, { timeoutMs: 800 });

  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.ok(r.ms >= 50, `elapsed ms should be measured, got ${r.ms}`);
});

// ---------------------------------------------------------------------------
// A deadline the client chose is not a verdict about the server
// ---------------------------------------------------------------------------

// §4.7/§5.2: `session-start`'s health slice and `prompt-recall`'s budget both dial on a
// fraction of the configured timeout. Recording those aborts escalated the marker to
// `not_responding` and, past the threshold, opened the breaker — which also suppresses the
// capture drain. A dead recall path must not throttle capture as a side effect.
test('breaker: an abort on a caller-squeezed budget is not recorded', async (t) => {
  const { cfg, http } = await setup(t, {
    routes: { 'POST /v2/control/query': { delayMs: 900, json: { ok: true } } },
    extra: { MUBIT_CC_TIMEOUT_MS: '4000', MUBIT_CC_BREAKER_THRESHOLD: '3', MUBIT_CC_BREAKER_WINDOW_MS: '5000' },
  });
  const { readBreaker } = await lib('breaker.mjs');

  for (let i = 0; i < 3; i += 1) {
    const r = await http.request(cfg, 'POST', '/v2/control/query', { run_id: RUN }, { timeoutMs: 120 });
    assert.equal(r.ok, false);
    assert.equal(r.state, 'not_responding');
  }

  const b = readBreaker(cfg);
  assert.equal(b.state, 'ready', 'three squeezed aborts must not escalate the reported state');
  assert.equal(b.timeoutStreak, 0, 'a client-side budget must not move the timeout streak');
  assert.equal(b.failures.length, 0, 'a client-side budget must not count toward opening the breaker');
});

// The other half of the same rule: an abort on the *full* configured budget is evidence, and
// `drain.mjs` — the only caller that dials on it — must still be able to open the breaker.
test('breaker: an abort on the full configured budget is still recorded', async (t) => {
  const { cfg, http } = await setup(t, {
    routes: { 'POST /v2/control/ingest': { delayMs: 900, json: { ok: true } } },
    extra: { MUBIT_CC_TIMEOUT_MS: '120', MUBIT_CC_BREAKER_THRESHOLD: '3', MUBIT_CC_BREAKER_WINDOW_MS: '5000' },
  });
  const { readBreaker } = await lib('breaker.mjs');

  for (let i = 0; i < 3; i += 1) {
    await http.request(cfg, 'POST', '/v2/control/ingest', { run_id: RUN }, { timeoutMs: 120 });
  }

  const b = readBreaker(cfg);
  assert.equal(b.timeoutStreak, 3, 'a timeout on the whole budget is a verdict and must count');
  assert.equal(b.state, 'not_responding', '§4.7: three in a row escalate');
});
