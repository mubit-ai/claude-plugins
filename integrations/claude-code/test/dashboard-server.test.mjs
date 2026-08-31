// @ts-check
/**
 * `bin/dashboard.src.mjs` — the loopback server, and the nine invariants it exists under.
 *
 * A local web server that renders somebody's memory is the highest-consequence thing in this
 * plugin, so the properties this file protects are stated as invariants rather than as
 * features:
 *
 *   1. No route ever returns the API key, and it appears in no response body or error.
 *   2. Every route rejects a missing, wrong or stale token with 401 **before doing any work**.
 *   3. Every local route works with the network fully unavailable.
 *   4. Prompt text is redacted on the way out — a synthetic secret in a fixture turn does not
 *      appear in `/api/turns`.
 *   5. Binding is `127.0.0.1` only, never `0.0.0.0`.
 *   6. `/api/forget` without a matching `confirm` is a 400 and deletes nothing.
 *   7. Reading spool depth never drains the spool; reading breaker state never trips it.
 *   8. Every run and prompt id from a query string passes through `safeSegment`, so a `../`
 *      cannot escape the data dir.
 *   9. The rollup writer only ever writes under `<dataDir>/dashboard/`, and is capped.
 *
 * Invariants 7 and 9 are proved in `dashboard-data.test.mjs`, where the reads live; this file
 * covers them end to end through the HTTP surface, which is the only place a route can reach
 * for the wrong neighbour.
 *
 * The upstream is `fakeMubit()` — a real `node:http` server on `127.0.0.1:0`, so an unrouted
 * call is recorded and 404'd and "the dashboard dialled something it should not have" is
 * always visible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PLUGIN_ROOT, lib, mod, baseEnv, fakeMubit, makeDataDir } from './helpers/harness.mjs';
import { SECRETS } from './helpers/fixtures.mjs';

/** A page body the suite owns, so no assertion here depends on the shipped markup. */
const STUB_HTML = '<!doctype html><title>stub</title><p>stub page';

/**
 * A dashboard on a loopback port, with a fake instance behind it.
 *
 * `idleMs: 0` disables the shutdown timer for every test but the two that exercise it.
 *
 * @param {import('node:test').TestContext} t
 * @param {{routes?: Record<string, any>, endpoint?: string, idleMs?: number,
 *          onShutdown?: (r: string) => void}} [o]
 */
async function setup(t, o = {}) {
  const dataDir = makeDataDir();
  const upstream = await fakeMubit(o.routes ?? {});
  t.after(() => upstream.close());

  const { loadConfig } = await lib('config.mjs');
  const env = baseEnv({ dataDir, endpoint: o.endpoint ?? upstream.url });
  const cfg = loadConfig(env);
  const dash = await mod('bin/dashboard.src.mjs');

  const started = await dash.startServer({
    cfg, env, html: STUB_HTML, idleMs: o.idleMs ?? 0, onShutdown: o.onShutdown,
    onStop: () => { /* never process.exit() inside the test runner */ },
  });
  t.after(() => started.close());

  /** @param {string} path @param {RequestInit & {token?: string|null}} [init] */
  const call = (path, init = {}) => {
    const headers = { ...(init.headers ?? {}) };
    const token = 'token' in init ? init.token : started.token;
    if (token) headers.authorization = `Bearer ${token}`;
    return fetch(`http://127.0.0.1:${started.port}${path}`, { ...init, headers });
  };

  return { dataDir, cfg, env, dash, upstream, started, call };
}

function writeMarker(dataDir, runId, patch = {}) {
  writeFileSync(join(dataDir, 'status', `${runId}.json`), JSON.stringify({
    run_id: runId, mode: 'hosted', state: 'ready', updated_at: Date.now(), ...patch,
  }));
}

function writeTurn(dataDir, runId, turn) {
  const dir = join(dataDir, 'runs', runId, 'turns');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${turn.prompt_id}.json`), JSON.stringify(turn));
}

const RUN = 'cc-dash-00000001';
const PROMPT = '11111111-2222-3333-4444-555555555555';

function seedRun(dataDir, over = {}) {
  writeMarker(dataDir, RUN);
  writeTurn(dataDir, RUN, {
    prompt: 'rebuild the bundle',
    prompt_id: PROMPT,
    session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    started_at: 1_700_000_000_000,
    recalled: ['ref_lesson_1'],
    recall: { tokens: 120, chars: 480, sources: 3, pointers: 1, rung: 1 },
    ...over,
  });
}

/** Every GET route the server answers, for the cross-cutting sweeps. */
const GET_ROUTES = [
  '/', '/api/ping', '/api/meta', '/api/datadirs', '/api/runs', '/api/turns',
  `/api/turn?run=${RUN}&prompt=${PROMPT}`, '/api/health/local', '/api/analytics',
  '/api/lessons', '/api/activity', `/api/health/remote?run=${RUN}`, '/api/remote-runs',
];

/** Every POST route, with a body that is valid enough to get past the guards. */
const POST_ROUTES = [
  ['/api/search', { run: RUN, query: 'retry backoff' }],
  ['/api/outcome', { run: RUN, referenceId: 'ref_lesson_1', success: true }],
  ['/api/archive', { run: RUN, content: 'a decision' }],
  ['/api/forget', { lessonId: 'les_1', confirm: 'les_1' }],
];

// ---------------------------------------------------------------------------
// Invariant 5 — the bind
// ---------------------------------------------------------------------------

// Binding `0.0.0.0` would put a browsable copy of somebody's memory on their office network
// for as long as the page was open, and nothing in the UI would say so.
test('bind: the server listens on 127.0.0.1 and on no other address', async (t) => {
  const { started } = await setup(t);
  const addr = started.server.address();
  assert.equal(addr.address, '127.0.0.1', `bound to ${addr.address}`);
  assert.ok(addr.port > 0, 'an ephemeral port, chosen by the kernel');
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
});

test('bind: the source contains exactly one listen, and it names the loopback address', async () => {
  const src = readFileSync(join(PLUGIN_ROOT, 'bin', 'dashboard.src.mjs'), 'utf8');
  const listens = [...src.matchAll(/\.listen\(\s*([^,)]*)\s*,\s*([^,)]*)/g)]
    .map((m) => `${m[1].trim()} ${m[2].trim()}`);
  assert.deepEqual(listens, ["0 '127.0.0.1'"],
    `there must be exactly one bind and it must name 127.0.0.1; found ${JSON.stringify(listens)}`);
});

// ---------------------------------------------------------------------------
// Invariant 2 — the token
// ---------------------------------------------------------------------------

// One row per route. The check runs before the router, so this is also the assertion that no
// route can be added that forgets it.
test('auth: every route answers 401 without a token', async (t) => {
  const { call } = await setup(t);
  for (const path of GET_ROUTES) {
    const res = await call(path, { token: null });
    assert.equal(res.status, 401, `GET ${path} answered ${res.status} to an anonymous request`);
    const body = await res.json();
    assert.equal(body.error.code, 'unauthorized');
  }
  for (const [path, payload] of POST_ROUTES) {
    const res = await call(path, {
      method: 'POST', token: null,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 401, `POST ${path} answered ${res.status} to an anonymous request`);
  }
});

test('auth: a wrong token is 401, and so is a token for a different launch', async (t) => {
  const { call, dash } = await setup(t);
  for (const token of ['', 'nope', 'Bearer', dash.mintToken()]) {
    const res = await call('/api/meta', { token: token || null });
    assert.equal(res.status, 401, `token ${JSON.stringify(token)} was accepted`);
  }
});

// A 401 must cost nothing on the far side of the check. The upstream is the only observable
// "work" a route does, so an anonymous call to a proxied route must leave it untouched.
test('auth: an anonymous request to a proxied route dials nothing upstream', async (t) => {
  const { call, upstream } = await setup(t);
  await call('/api/lessons', { token: null });
  await call('/api/health/remote?run=cc-dash-00000001', { token: null });
  assert.equal(upstream.requests.length, 0,
    `an unauthorized request reached the instance: ${upstream.summary()}`);
});

/**
 * The browser's first navigation cannot carry a header, so the token arrives in the launch
 * URL for exactly that one request. The page then sends it as `Authorization` and replaces
 * its own URL so the token leaves the address bar.
 */
test('auth: the token is accepted from the query string, which is how the browser first arrives', async (t) => {
  const { started } = await setup(t);
  const res = await fetch(`http://127.0.0.1:${started.port}/?token=${encodeURIComponent(started.token)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(await res.text(), STUB_HTML);
});

test('auth: the page is served with a content-security-policy that pins it to its own origin', async (t) => {
  const { started } = await setup(t);
  const res = await fetch(`http://127.0.0.1:${started.port}/?token=${encodeURIComponent(started.token)}`);
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /frame-ancestors 'none'/, 'a page showing memory must not be framable');
  assert.match(csp, /connect-src 'self'/, 'the page talks to this server and to nothing else');
});

// `timingSafeEqual` throws on a length mismatch, so a naive implementation returns early on
// one and turns the token's length into a free oracle.
test('auth: the token comparison handles mismatched lengths without throwing', async (t) => {
  const { dash } = await setup(t);
  assert.equal(dash.tokenEquals('abc', 'abcd'), false);
  assert.equal(dash.tokenEquals('', ''), false, 'an empty token is never valid');
  assert.equal(dash.tokenEquals('abc', 'abc'), true);
  assert.equal(dash.tokenEquals(undefined, 'abc'), false);
});

// ---------------------------------------------------------------------------
// Invariant 3 — offline
// ---------------------------------------------------------------------------

/**
 * The whole reason the routes are split into local and proxied.
 *
 * With nothing behind the endpoint, the analytics, turns and health tabs must keep rendering —
 * they read files — and only the tabs that genuinely need the instance may fail, each with a
 * code the page can turn into a banner naming the reason.
 */
test('offline: every local route answers 200 with no instance reachable, and the proxied ones say why', async (t) => {
  const { dataDir, call } = await setup(t, { endpoint: 'http://127.0.0.1:1' });
  seedRun(dataDir);

  for (const path of ['/api/meta', '/api/datadirs', '/api/runs', '/api/turns',
    `/api/turn?run=${RUN}&prompt=${PROMPT}`, '/api/health/local', '/api/analytics']) {
    const res = await call(path);
    assert.equal(res.status, 200, `local route ${path} answered ${res.status} with the network down`);
  }

  for (const path of ['/api/lessons', '/api/activity', `/api/health/remote?run=${RUN}`, '/api/remote-runs']) {
    const res = await call(path);
    assert.equal(res.status, 503, `${path} should degrade, not succeed`);
    const body = await res.json();
    assert.equal(body.error.code, 'upstream_unreachable');
    assert.ok(body.error.message.length > 0, 'the banner needs a reason to name');
  }
});

// ---------------------------------------------------------------------------
// Invariant 4 — redaction on the way out
// ---------------------------------------------------------------------------

/**
 * The end-to-end form of the trap `dashboard-data.test.mjs` states at the module level: with
 * `redact: false` configured, a key in a prompt still must not reach the browser.
 */
test('turns: a synthetic secret in a fixture turn does not appear in /api/turns', async (t) => {
  const dataDir = makeDataDir();
  const upstream = await fakeMubit();
  t.after(() => upstream.close());
  const { loadConfig } = await lib('config.mjs');
  const env = baseEnv({ dataDir, endpoint: upstream.url, extra: { MUBIT_CC_REDACT: '0' } });
  const cfg = loadConfig(env);
  assert.equal(cfg.redact, false, 'the fixture must actually have redaction disabled');

  const dash = await mod('bin/dashboard.src.mjs');
  const started = await dash.startServer({ cfg, env, html: STUB_HTML, idleMs: 0 });
  t.after(() => started.close());

  writeMarker(dataDir, RUN);
  writeTurn(dataDir, RUN, {
    prompt: `ship it with ${SECRETS.mubitKey}`,
    prompt_id: PROMPT,
    session_id: 's',
    started_at: 1_700_000_000_000,
    recalled: [],
  });

  const res = await fetch(`http://127.0.0.1:${started.port}/api/turns?run=${RUN}`, {
    headers: { authorization: `Bearer ${started.token}` },
  });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes(SECRETS.mubitKey), `the key was served to the browser: ${text}`);
  assert.match(text, /REDACTED/);
});

// ---------------------------------------------------------------------------
// Invariant 1 — the key never leaves the process
// ---------------------------------------------------------------------------

/**
 * Swept across every route rather than asserted at one, because the key can only leak from a
 * route somebody forgot about. The upstream deliberately echoes the `Authorization` header it
 * received into its own error body, which is the worst realistic case: a proxy error page or a
 * chatty 4xx doing the same.
 */
test('secrets: the API key appears in no response from any route', async (t) => {
  const echo = (req) => ({ status: 400, json: { error: `bad request: ${req.headers.authorization}` } });
  const { dataDir, cfg, call } = await setup(t, {
    routes: {
      'POST /v2/control/lessons': echo,
      'POST /v2/control/activity': echo,
      'POST /v2/control/memory_health': echo,
      'GET /v2/control/runs': echo,
      'POST /v2/control/query': echo,
      'POST /v2/control/outcome': echo,
      'POST /v2/control/archive': echo,
      'POST /v2/control/lessons/delete': echo,
    },
  });
  seedRun(dataDir);
  assert.ok(cfg.apiKey && cfg.apiKey.length > 10, 'the fixture must carry a key, or this proves nothing');

  for (const path of GET_ROUTES) {
    const text = await (await call(path)).text();
    assert.ok(!text.includes(cfg.apiKey), `GET ${path} returned the API key`);
  }
  for (const [path, payload] of POST_ROUTES) {
    const text = await (await call(path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })).text();
    assert.ok(!text.includes(cfg.apiKey), `POST ${path} returned the API key`);
  }
});

// `/api/meta` exists so the page can say which instance it is showing. The endpoint is not a
// secret and is needed; the key is neither.
test('secrets: /api/meta reports the endpoint and never the key', async (t) => {
  const { cfg, call } = await setup(t);
  const body = await (await call('/api/meta')).json();
  assert.equal(body.endpoint, cfg.endpoint);
  assert.equal(body.configured, true);
  const rendered = JSON.stringify(body);
  assert.ok(!rendered.includes(cfg.apiKey));
  assert.ok(!/apiKey|api_key/i.test(rendered), 'not even the field name, so nothing can grow into it');
});

// ---------------------------------------------------------------------------
// Invariant 8 — path safety
// ---------------------------------------------------------------------------

// `runDir` applies `safeSegment`; `readMarker` does not. A run id from a query string reaches
// both, so it is flattened at the edge — and the observable proof is that the traversal names
// a run that does not exist rather than a file that does.
test('paths: a traversal run id resolves to a flattened segment, not to a file', async (t) => {
  const { dataDir, call } = await setup(t);
  seedRun(dataDir);
  writeFileSync(join(dataDir, 'credentials.json'), JSON.stringify({ apiKey: SECRETS.mubitKey }));

  for (const attempt of ['../../credentials', '../../../../etc/passwd', '..%2f..%2fcredentials']) {
    const res = await call(`/api/health/local?run=${encodeURIComponent(attempt)}`);
    assert.equal(res.status, 200, 'a bad id is an empty answer, not a 500');
    const body = await res.json();
    assert.ok(!body.runId.includes('/'), `runId ${body.runId} still carries a separator`);
    assert.equal(body.spoolDepth, 0);
    const text = JSON.stringify(body);
    assert.ok(!text.includes(SECRETS.mubitKey), `the traversal reached credentials.json: ${text}`);
  }
});

test('paths: a traversal prompt id is a 404, not a file read', async (t) => {
  const { dataDir, call } = await setup(t);
  seedRun(dataDir);
  const res = await call(`/api/turn?run=${RUN}&prompt=${encodeURIComponent('../../../credentials')}`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'not_found');
});

// A `?dir=` that names no directory this process found falls back to the default rather than
// resolving as a path.
test('paths: an arbitrary ?dir= resolves to a real data dir or to nothing', async (t) => {
  const { dataDir, call } = await setup(t);
  seedRun(dataDir);
  const body = await (await call('/api/runs?dir=/etc')).json();
  assert.equal(body.dir, dataDir, 'an unknown directory falls back to the default');
});

// ---------------------------------------------------------------------------
// Invariant 6 — forget
// ---------------------------------------------------------------------------

// Deletion has no undo, and a confirmation that lives only in the browser is one an errant
// `fetch` skips. The server is where it is enforced.
test('forget: a mismatched confirm is 400 and dials nothing', async (t) => {
  const { call, upstream } = await setup(t, {
    routes: { 'POST /v2/control/lessons/delete': { json: { success: true } } },
  });

  for (const body of [{ lessonId: 'les_1' }, { lessonId: 'les_1', confirm: 'yes' }, { confirm: 'les_1' }]) {
    const res = await call('/api/forget', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, `${JSON.stringify(body)} was not refused`);
    assert.equal((await res.json()).error.code, 'bad_request');
  }
  upstream.assertNotCalled('POST', '/v2/control/lessons/delete');
});

test('forget: an exact confirm deletes, and the instance sees only lesson_id', async (t) => {
  const { call, upstream } = await setup(t, {
    routes: { 'POST /v2/control/lessons/delete': { json: { success: true } } },
  });
  const res = await call('/api/forget', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lessonId: 'les_1', confirm: 'les_1' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(upstream.lastCall('POST', '/v2/control/lessons/delete')?.body, { lesson_id: 'les_1' });
});

// ---------------------------------------------------------------------------
// Invariant 7 and 9, end to end
// ---------------------------------------------------------------------------

test('polling: a health poll leaves the spool and the breaker directory exactly as it found them', async (t) => {
  const { dataDir, call } = await setup(t);
  seedRun(dataDir);
  const spool = join(dataDir, 'runs', RUN, 'spool');
  mkdirSync(spool, { recursive: true });
  writeFileSync(join(spool, '1700000000000-aaaaaa.json'), '{"item_id":"a"}');
  writeFileSync(join(spool, '1700000000001-bbbbbb.json'), '{ truncated');

  for (let i = 0; i < 5; i++) await call(`/api/health/local?run=${RUN}`);

  assert.equal(readdirSync(spool).length, 2, 'five polls must not have drained anything');
  assert.deepEqual(readdirSync(join(dataDir, 'breaker')), [],
    'and must not have brought a breaker file into existence');
});

test('polling: the turns poll grows the rollup, and writes nowhere else', async (t) => {
  const { dataDir, call } = await setup(t);
  seedRun(dataDir);

  await call(`/api/turns?run=${RUN}`);
  const p = join(dataDir, 'dashboard', `rollup-${RUN}.jsonl`);
  assert.ok(existsSync(p), 'the first poll starts the series');
  const first = readFileSync(p, 'utf8');

  for (let i = 0; i < 4; i++) await call(`/api/turns?run=${RUN}`);
  assert.equal(readFileSync(p, 'utf8'), first,
    'four more polls of an unchanged turn add nothing — the series is per prompt, not per poll');

  const analytics = await (await call(`/api/analytics?run=${RUN}`)).json();
  assert.equal(analytics.points, 1);
  assert.equal(analytics.series[0].tok, 120);
});

// There is no per-prompt latency anywhere on disk, so the analytics payload must not claim one.
test('analytics: the payload carries no latency series, because none is recorded', async (t) => {
  const { dataDir, call } = await setup(t);
  seedRun(dataDir);
  await call(`/api/turns?run=${RUN}`);
  const body = await (await call(`/api/analytics?run=${RUN}`)).json();
  assert.ok(!('latency' in body) && !('ms' in body), 'recall.ms describes the last prompt, not each one');
  for (const row of body.series) {
    assert.ok(!('ms' in row), 'a rollup row must not carry a latency field either');
  }
});

// ---------------------------------------------------------------------------
// Proxying
// ---------------------------------------------------------------------------

/**
 * One `ActivityEntry` carrying the metadata a lesson actually has.
 *
 * `projection: 'full'` is what keeps `metadata_json` intact. Under the compact projection the
 * server overwrites it with `{entry_type, created_at}`, and every field the lessons route
 * would have returned — scope included — is gone. That is the whole reason the census asks for
 * `full`, and a fixture that fakes a compact row cannot catch it going wrong.
 *
 * @param {Record<string, any>} [meta] merged into `metadata_json`
 * @param {Record<string, any>} [over] merged onto the entry itself
 */
function lessonActivity(meta = {}, over = {}) {
  return {
    id: 'a3c1f0de-0000-4000-8000-000000000001',
    run_id: 'cc-other-00000001',
    entry_type: 'lesson',
    content: 'Run the migration first.',
    source: 'reflection',
    created_at: '2026-08-19T15:03:18Z',
    reference_id: 'ref_lesson_1',
    referenceable: true,
    ...over,
    metadata_json: JSON.stringify({
      entry_type: 'lesson',
      lesson_type: 'rule',
      scope: 'global',
      importance: 'high',
      source_run_id: 'cc-other-00000001',
      ...meta,
    }),
  };
}

/** A page of the activity route, in the shape `fetchActivity` reads. */
function activityPage(entries, next = '', total = entries.length) {
  return { json: { entries, next_page_token: next, total_visible: total } };
}

/**
 * The headline bug, and the only route change that fixes it.
 *
 * The page pinned every lessons call to the current run, so the instance took the
 * `nexus.list(run_id, limit)` branch instead of `list_global(limit)` and a `global` lesson
 * written by another run could not appear at all — which is the exact opposite of the question
 * the scope filter exists to answer. An empty `run` means every run, and nothing else needs to
 * be spelled: a second `allRuns` parameter would just be a second way to get this wrong again.
 */
test('lessons: with no run the census asks the instance for every run, so a lesson from another run can appear', async (t) => {
  const { call, upstream } = await setup(t, {
    routes: { 'POST /v2/control/activity': activityPage([lessonActivity()]) },
  });

  const body = await (await call('/api/lessons')).json();
  const req = upstream.lastCall('POST', '/v2/control/activity')?.body;
  assert.ok(!('run_id' in req), `an absent run means every run; body was ${JSON.stringify(req)}`);
  assert.deepEqual(req.entry_types, ['lesson']);
  assert.equal(req.projection, 'full', 'compact overwrites metadata_json and the scope is gone');
  assert.equal(body.source, 'activity');
  assert.equal(body.lessons.length, 1);
  assert.equal(body.lessons[0].scope, 'global');
  assert.equal(body.lessons[0].leaksScope, true);
});

// `currentRun` is a rendering context, not a filter. The moment it narrows the query, D1 is
// back: the tab can only show what the current run wrote, and "did this rule follow me here
// from somewhere else" becomes unanswerable.
test('lessons: currentRun marks a foreign lesson without narrowing the query', async (t) => {
  const { call, upstream } = await setup(t, {
    routes: { 'POST /v2/control/activity': activityPage([lessonActivity()]) },
  });

  const body = await (await call(`/api/lessons?currentRun=${RUN}`)).json();
  const req = upstream.lastCall('POST', '/v2/control/activity')?.body;
  assert.ok(!('run_id' in req), `currentRun must not reach the wire; body was ${JSON.stringify(req)}`);
  assert.equal(body.lessons[0].fromOtherRun, true,
    'the lesson was written by cc-other-00000001, and that is what the page has to be able to say');

  const own = await (await call('/api/lessons?currentRun=cc-other-00000001')).json();
  assert.equal(own.lessons[0].fromOtherRun, false);
});

/**
 * The back-compat pin.
 *
 * The census answers with `created_at` natively, so there is no join to report on — but the
 * page reads `joined`/`dated` to decide whether to say "this instance records no lesson
 * dates", and `joinError` is the only place a failed join can surface. Dropping any of the
 * four would silently change what the header claims.
 */
test('lessons: the response still carries lessons, joined, dated and joinError', async (t) => {
  const { call } = await setup(t, {
    routes: { 'POST /v2/control/activity': activityPage([lessonActivity()]) },
  });

  const body = await (await call('/api/lessons')).json();
  for (const key of ['lessons', 'joined', 'dated', 'joinError']) {
    assert.ok(key in body, `\`${key}\` is what the page renders the date column from`);
  }
  assert.equal(body.joined, true);
  assert.equal(body.dated, 1, 'the activity route carries created_at, so every row is dated');
});

/**
 * The filter the user guide promises, working.
 *
 * Scope is applied here and not on the wire, for two reasons that both end in an empty list.
 * `ListActivityRequest` has no scope field at all, and on the lessons route the scope filter
 * runs *after* `limit` — so asking upstream for `scope=global` filters an already-truncated
 * set and reliably answers with nothing.
 */
test('lessons: scope=leak returns only the lessons visible outside their own run', async (t) => {
  const { call, upstream } = await setup(t, {
    routes: {
      'POST /v2/control/activity': activityPage([
        lessonActivity({ scope: 'run' }, { id: 'l-run', reference_id: 'ref-run' }),
        lessonActivity({ scope: 'session' }, { id: 'l-session', reference_id: 'ref-session' }),
        lessonActivity({ scope: 'global' }, { id: 'l-global', reference_id: 'ref-global' }),
        lessonActivity({ scope: undefined }, { id: 'l-bare', reference_id: 'ref-bare' }),
      ]),
    },
  });

  const leaks = await (await call('/api/lessons?scope=leak')).json();
  assert.deepEqual(leaks.lessons.map((l) => l.id).sort(), ['ref-global', 'ref-session']);
  assert.equal(leaks.hidden, 2, 'and the page has to be able to say how many it is not showing');

  const req = upstream.lastCall('POST', '/v2/control/activity')?.body;
  assert.ok(!('scope' in req), `scope is never filtered on the wire; body was ${JSON.stringify(req)}`);

  const bare = await (await call('/api/lessons?scope=unknown')).json();
  assert.deepEqual(bare.lessons.map((l) => l.id), ['ref-bare']);
  assert.equal(bare.lessons[0].scope, 'run',
    'the instance would call it a run lesson, and the page must not contradict it');
  assert.equal(bare.lessons[0].scopeKnown, false,
    'but "the server defaulted it" and "we never saw the metadata" are different facts');

  const runs = await (await call('/api/lessons?scope=run')).json();
  assert.deepEqual(runs.lessons.map((l) => l.id).sort(), ['ref-bare', 'ref-run'],
    'an entry with no recorded scope is a run entry as far as the instance is concerned');
});

/**
 * The fallback, and why the page is told which route answered.
 *
 * The two have different fidelity — the lessons route carries no `created_at` and reports the
 * *scoped* `source_run_id` — so a page that cannot say where a row came from cannot say what a
 * missing row means. The array route here is consumed one reply per call: the census sees the
 * empty page, and the join behind `fetchLessons` sees the second.
 */
test('lessons: an empty census falls back to the lessons route and says which source answered', async (t) => {
  const { call, upstream } = await setup(t, {
    routes: {
      'POST /v2/control/lessons': {
        json: {
          lessons: [{
            id: 'a3c1f0de-0000-4000-8000-000000000001',
            content: 'Run the migration first.', lesson_type: 'rule', scope: 'global',
            importance: 'high', conditions: [], rationale: '', source_run_id: 'cc-other-1', source: 'reflection',
          }],
        },
      },
      'POST /v2/control/activity': [
        activityPage([]),
        activityPage([{ id: 'a3c1f0de-0000-4000-8000-000000000001', created_at: '2026-08-19T15:03:18Z' }]),
      ],
    },
  });

  const body = await (await call(`/api/lessons?run=${RUN}`)).json();
  assert.equal(body.source, 'lessons');
  assert.equal(body.lessons.length, 1);
  assert.equal(body.lessons[0].id, 'a3c1f0de-0000-4000-8000-000000000001');
  assert.equal(body.lessons[0].createdAt, '2026-08-19T15:03:18Z');
  assert.equal(body.lessons[0].leaksScope, true, 'a global lesson is visible outside the run that wrote it');
  upstream.assertCalled('POST', '/v2/control/lessons', 1);
});

/**
 * The Activity half of the same bug.
 *
 * The route sent no `entry_types` and no `projection`, so it got the compact default — and the
 * compact projection overwrites `metadata_json` with `{entry_type, created_at}`. Every activity
 * row therefore reached the page with no scope at all, and both non-empty options of the scope
 * dropdown matched zero rows. A person filtering by scope in Activity mode saw "No activity
 * matches." every single time, which reads as an empty instance.
 */
test('activity: entryTypes and projection reach the wire, and a lesson row carries its scope', async (t) => {
  const { call, upstream } = await setup(t, {
    routes: {
      'POST /v2/control/activity': activityPage([
        lessonActivity(),
        { id: 't1', entry_type: 'trace', content: 'ran the migration', created_at: '2026-08-19T15:00:00Z' },
      ]),
    },
  });

  const body = await (await call(
    `/api/activity?run=${RUN}&entryTypes=lesson,trace&projection=full&sort=asc`)).json();
  const req = upstream.lastCall('POST', '/v2/control/activity')?.body;
  assert.deepEqual(req.entry_types, ['lesson', 'trace']);
  assert.equal(req.projection, 'full');
  assert.equal(req.sort, 'asc');

  const lesson = body.entries.find((e) => e.entry_type === 'lesson');
  assert.equal(lesson.scope, 'global');
  assert.equal(lesson.leaksScope, true);
  assert.equal(lesson.scopeKnown, true);
  assert.equal(body.entries.find((e) => e.entry_type === 'trace').scope, undefined,
    'scope is a lesson property; inventing one for a trace would be a fiction the page renders');
});

test('routing: an unknown path is 404 with the documented error shape', async (t) => {
  const { call } = await setup(t);
  for (const [method, path] of [['GET', '/api/nope'], ['POST', '/api/nope'], ['GET', '/wat']]) {
    const res = await call(path, { method });
    assert.equal(res.status, 404, `${method} ${path}`);
    const body = await res.json();
    assert.equal(body.error.code, 'not_found');
  }
});

test('routing: a POST body that is not JSON is a 400 rather than a 500', async (t) => {
  const { call, upstream } = await setup(t);
  const res = await call('/api/search', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'bad_request');
  upstream.assertNotCalled('POST', '/v2/control/query');
});

// ---------------------------------------------------------------------------
// Idle shutdown
// ---------------------------------------------------------------------------

// A forgotten daemon is the failure mode of every "just leave it running" tool, and this one
// holds a live token for a page showing the user's memory.
test('lifecycle: the server shuts itself down after an idle window with no authorized traffic', async (t) => {
  let reason = '';
  const { started } = await setup(t, { idleMs: 200, onShutdown: (r) => { reason = r; } });
  await waitFor(() => reason === 'idle', 4000, 'the idle shutdown never fired');
  assert.equal(reason, 'idle');
  assert.equal(started.server.listening, false, 'and the port is actually released');
});

// An anonymous request must not count as traffic, or a port scanner keeps a forgotten
// dashboard alive indefinitely.
test('lifecycle: unauthorized requests do not keep the server alive', async (t) => {
  let reason = '';
  const { started, call } = await setup(t, { idleMs: 300, onShutdown: (r) => { reason = r; } });

  const noise = setInterval(() => { call('/api/meta', { token: null }).catch(() => {}); }, 40);
  t.after(() => clearInterval(noise));

  await waitFor(() => reason === 'idle', 5000, 'anonymous polling kept the idle clock alive');
  clearInterval(noise);
  assert.equal(started.server.listening, false);
});

// ---------------------------------------------------------------------------
// The command surface
// ---------------------------------------------------------------------------

test('cli: parseArgs maps each flag to one mode', async (t) => {
  const { dash } = await setup(t);
  assert.equal(dash.parseArgs([]).mode, 'launch');
  assert.equal(dash.parseArgs(['--serve']).mode, 'serve');
  assert.equal(dash.parseArgs(['--stop']).mode, 'stop');
  assert.equal(dash.parseArgs(['--status']).mode, 'status');
  assert.equal(dash.parseArgs(['--foreground']).mode, 'foreground');
  assert.equal(dash.parseArgs(['--no-open']).open, false);
  assert.equal(dash.parseArgs([]).open, true);
});

// A user asking about a dashboard that is not running gets a sentence and a non-zero exit,
// which is what lets the skill tell "not running" from "running at this URL".
test('cli: --status with nothing running reports it and exits non-zero', async (t) => {
  const { cfg, env, dash } = await setup(t);
  const lines = [];
  const code = await dash.main(['--status'], env, { cfg, log: (m) => lines.push(m) });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /not running/i);
});

// Stopping something that is not running is a no-op that succeeded, not an error.
test('cli: --stop with nothing running exits zero', async (t) => {
  const { cfg, env, dash } = await setup(t);
  const lines = [];
  const code = await dash.main(['--stop'], env, { cfg, log: (m) => lines.push(m) });
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /was not running/i);
});

// A file describing a server that is gone is stale, and `--stop` reading one must not send a
// signal to whatever process inherited the pid. The probe is what makes the pid trustworthy.
test('cli: a stale state file is cleared rather than acted on', async (t) => {
  const { cfg, env, dash } = await setup(t);
  dash.writeState(cfg, {
    // A port with nothing on it, and a pid that is this process — so a naive `--stop`
    // implementation would take the test runner down instead of failing the assertion.
    pid: process.pid, port: 1, token: 'stale', startedAt: 1, url: 'http://127.0.0.1:1/',
  });
  assert.ok(existsSync(dash.statePath(cfg)));

  const code = await dash.main(['--stop'], env, { cfg, log: () => {} });
  assert.equal(code, 0);
  assert.equal(existsSync(dash.statePath(cfg)), false, 'the stale file is removed');
});

/**
 * The full lifecycle, against a real detached process — the only way to test what the skill
 * actually does.
 *
 * In-process would not do: `--serve` writes a state file naming its own pid, and `--stop`
 * kills that pid. Run in the test runner, a passing test and a killed runner look the same.
 */
test('lifecycle: a detached --serve publishes an owner-only state file, and --stop stops it', async (t) => {
  const dataDir = makeDataDir();
  const upstream = await fakeMubit();
  t.after(() => upstream.close());
  const { loadConfig } = await lib('config.mjs');
  const env = baseEnv({ dataDir, endpoint: upstream.url });
  const cfg = loadConfig(env);
  const dash = await mod('bin/dashboard.src.mjs');

  const script = join(PLUGIN_ROOT, 'bin', 'dashboard.src.mjs');
  const child = spawn(process.execPath, [script, '--serve'], {
    detached: true, stdio: 'ignore', env,
  });
  child.unref();
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ } });

  await waitFor(() => existsSync(dash.statePath(cfg)), 10000, 'the detached server never published its port');
  const state = dash.readState(cfg);
  assert.ok(state && state.port > 0 && state.token, `unusable state file: ${JSON.stringify(state)}`);
  assert.equal(state.pid, child.pid, 'the file names the process that wrote it');

  if (process.getuid?.() !== 0) {
    const mode = statSync(dash.statePath(cfg)).mode & 0o777;
    assert.equal(mode, 0o600, `the state file holds a live token; mode was ${mode.toString(8)}`);
  }

  const ping = await fetch(`http://127.0.0.1:${state.port}/api/ping`, {
    headers: { authorization: `Bearer ${state.token}` },
  });
  assert.equal(ping.status, 200);
  assert.equal((await ping.json()).service, 'mubit-dashboard');

  const status = await dash.main(['--status'], env, { cfg, log: () => {} });
  assert.equal(status, 0, '--status must find the running server');

  const stopped = await dash.main(['--stop'], env, { cfg, log: () => {} });
  assert.equal(stopped, 0);
  assert.equal(existsSync(dash.statePath(cfg)), false, '--stop clears the state file');

  await waitFor(async () => !(await dash.probe({ port: state.port, token: state.token })).alive,
    5000, '--stop did not actually stop the server');
});

/** Poll a predicate until it holds, or fail with a message that says what did not happen. */
async function waitFor(pred, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    // Deliberately NOT unref'd. The thing being waited for is usually a server closing itself,
    // and once it does there is nothing else holding the loop open — an unref'd poll would let
    // the process drain out from under a pending assertion and report it as a hang.
    await new Promise((r) => { setTimeout(r, 25); });
  }
  assert.fail(`${message} (waited ${timeoutMs}ms)`);
}
