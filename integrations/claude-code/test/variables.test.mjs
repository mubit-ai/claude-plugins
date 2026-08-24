// @ts-check
/**
 * `lib/variables.mjs` — the four run-scoped state routes, and nothing else.
 *
 * The vendored MCP server registers twenty-one tools and **not one of them touches
 * variables**, and `mcp/dist/server.js` cannot be rebuilt in this checkout. So this is the
 * only way a client of this plugin reaches `/v2/control/variables/*`, which makes the guards
 * here the whole contract rather than a second line of defence.
 *
 * Every test below is about something the server will not tell you about:
 *
 *   - A missing `run_id` is a 422 that names nothing useful; a missing `name` writes a
 *     variable called `""`.
 *   - `run_id: "default"` is accepted, and collapses every user, project and machine on the
 *     instance into one run (§4.3).
 *   - `value_json` is parsed server-side with `serde_json::from_str`, so a value that is not
 *     valid JSON is an `invalid_argument` after a full round trip.
 *   - `list` returns *every* variable in the run, including ones written by other clients.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeMubit, lib, makeDataDir } from './helpers/harness.mjs';

const RUN_ID = 'cc-vars-run';
const KEY = 'mbt_test_0123456789abcdef_deadbeefcafebabe0123456789abcdef';

const V = await lib('variables.mjs');

/** @param {any} server @param {Record<string, any>} [over] */
function cfg(server, over = {}) {
  return {
    dataDir: makeDataDir(),
    endpoint: server ? server.url : 'https://mubit.example.com',
    apiKey: KEY,
    timeoutMs: 4000,
    logLevel: 'error',
    breaker: { threshold: 5, windowMs: 300000, cooldownMs: 120000 },
    ...over,
  };
}

const OK = { json: { success: true } };

/** The routes a happy-path fixture has to answer. */
function routes(over = {}) {
  return {
    'POST /v2/control/variables/set': OK,
    'POST /v2/control/variables/get': { json: { name: 'cc.pin.a', value_json: '"x"' } },
    'POST /v2/control/variables/list': { json: { variables: [] } },
    'POST /v2/control/variables/delete': OK,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

/**
 * Four paths, frozen, and no fifth.
 *
 * The neighbouring surfaces on the same server — goals, actions, decision cycles — are
 * deprecated upstream and are not things a memory plugin should be writing. Naming the four
 * exactly is what stops "while we are here" from turning this module into an orchestrator.
 */
test('variables: exactly four routes, and they are the documented ones', () => {
  assert.deepEqual(V.VARIABLE_ROUTES, {
    set: '/v2/control/variables/set',
    get: '/v2/control/variables/get',
    list: '/v2/control/variables/list',
    delete: '/v2/control/variables/delete',
  });
  assert.ok(Object.isFrozen(V.VARIABLE_ROUTES));
});

// ---------------------------------------------------------------------------
// The pre-flight guards — every one of them dials nothing
// ---------------------------------------------------------------------------

test('variables: a missing run_id or name is refused before a socket exists', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const c = cfg(server);

  for (const [label, call] of [
    ['set without a run', () => V.setVariable(c, '', 'cc.pin.a', 'x')],
    ['set without a name', () => V.setVariable(c, RUN_ID, '', 'x')],
    ['get without a run', () => V.getVariable(c, '', 'cc.pin.a')],
    ['get without a name', () => V.getVariable(c, RUN_ID, '')],
    ['list without a run', () => V.listVariables(c, '')],
    ['delete without a run', () => V.deleteVariable(c, '', 'cc.pin.a')],
    ['delete without a name', () => V.deleteVariable(c, RUN_ID, '')],
  ]) {
    const res = await call();
    assert.equal(res.ok, false, `${label} was accepted`);
    assert.match(res.error, /run_id|name/, `${label}: the error must name the missing field`);
  }
  assert.equal(server.requests.length, 0,
    `a caller bug is not a request; saw: ${server.summary()}`);
});

/**
 * §4.3 / F21. `MUBIT_DEFAULT_SESSION_ID` defaults to the literal `"default"` on the MCP
 * server, so a variable written under it lands in a run every user, project and machine on
 * the instance shares — and a *pin* written there would render as a standing constraint in
 * somebody else's session.
 *
 * `lib/http.mjs` refuses it too, on the body. This is the belt: the guard has to hold for
 * `list` and `delete`, which carry a run id in a body that guard does not inspect the same
 * way, and it has to hold before anything is serialized.
 */
test('variables: the poisoned "default" run id never reaches the wire', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const c = cfg(server);

  for (const call of [
    () => V.setVariable(c, 'default', 'cc.pin.a', 'x'),
    () => V.getVariable(c, 'default', 'cc.pin.a'),
    () => V.listVariables(c, 'default'),
    () => V.deleteVariable(c, 'default', 'cc.pin.a'),
  ]) {
    const res = await call();
    assert.equal(res.ok, false);
    assert.match(res.error, /default/);
  }
  assert.equal(server.requests.length, 0, `saw: ${server.summary()}`);

  // Exact match only: a project legitimately called `default-config` still gets a run.
  const fine = await V.setVariable(c, 'cc-default-config-a1b2', 'cc.pin.a', 'x');
  assert.equal(fine.ok, true);
});

/**
 * The server parses `value_json` with `serde_json::from_str` and answers `invalid_argument`
 * on failure. A circular object or a `BigInt` would therefore cost a full round trip to learn
 * something this process already knew — and, worse, would look like an instance fault to the
 * circuit breaker.
 */
test('variables: an unserialisable value is refused before dialling', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const c = cfg(server);

  const circular = { name: 'loop' };
  circular.self = circular;

  for (const bad of [circular, 1n, () => 1]) {
    const res = await V.setVariable(c, RUN_ID, 'cc.pin.a', bad);
    assert.equal(res.ok, false, `${typeof bad} was accepted`);
    assert.match(res.error, /JSON|serial/i);
  }
  assert.equal(server.requests.length, 0, `saw: ${server.summary()}`);
});

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------

/**
 * `value_json` is a **string of JSON**, not a value. The field name says so and the server
 * enforces it; sending the raw text would store an unparseable variable — or, for a value
 * that happened to look like a number, silently store the wrong type.
 *
 * `source` is one of `system | reasoning | retrieval | perception | explicit`, matched as an
 * exact string with a silent fallback to `explicit` for anything else. `"user"` is not one of
 * them, so a plausible-looking value would be accepted and quietly mean something different.
 */
test('variables: set sends a JSON-encoded value and a source the server actually knows', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());

  const res = await V.setVariable(cfg(server), RUN_ID, 'cc.pin.vendored', "don't touch it");
  assert.equal(res.ok, true);

  const body = server.lastCall('POST', '/v2/control/variables/set').body;
  assert.equal(body.run_id, RUN_ID);
  assert.equal(body.name, 'cc.pin.vendored');
  assert.equal(body.value_json, JSON.stringify("don't touch it"),
    'value_json is a JSON *document*; the server parses it and rejects anything else');
  assert.equal(body.source, 'system');
});

/**
 * `list` answers with every variable in the run, whoever wrote it. Another client — a
 * LangGraph orchestrator, a script, a second plugin — is entitled to keep its own state in
 * the same run, and none of it is pinned context.
 *
 * Filtering here rather than at the call site means there is exactly one place that decides
 * what this plugin considers its own.
 */
test('variables: only the plugin namespace survives a list', async (t) => {
  const server = await fakeMubit(routes({
    'POST /v2/control/variables/list': {
      json: {
        variables: [
          { name: 'cc.pin.vendored', value_json: '"no vendored server edits"', last_updated: '2026-08-24T00:00:00Z' },
          { name: 'codaph.run_state', value_json: '{"step":3}' },
          { name: 'cc.pinned', value_json: '"near miss"' },
          { name: 'CC.PIN.shouty', value_json: '"case matters"' },
          { name: 'cc.pin.twin', value_json: '"ship the codex twin"' },
        ],
      },
    },
  }));
  t.after(() => server.close());

  const res = await V.listVariables(cfg(server), RUN_ID);
  assert.equal(res.ok, true);
  assert.deepEqual(res.variables.map((v) => v.slug), ['vendored', 'twin'],
    'anything outside `cc.pin.` belongs to whoever wrote it');
  assert.equal(res.variables[0].value, 'no vendored server edits',
    'value_json arrives as a JSON string and has to be parsed back');
});

// A variable whose `value_json` will not parse is one entry lost, never the whole list.
test('variables: a single unparseable value_json does not lose the rest of the list', async (t) => {
  const server = await fakeMubit(routes({
    'POST /v2/control/variables/list': {
      json: {
        variables: [
          { name: 'cc.pin.broken', value_json: '{"half' },
          { name: 'cc.pin.fine', value_json: '"still here"' },
        ],
      },
    },
  }));
  t.after(() => server.close());

  const res = await V.listVariables(cfg(server), RUN_ID);
  assert.equal(res.ok, true);
  assert.deepEqual(res.variables.map((v) => v.slug), ['fine']);
});

// The server answers `{variables: []}` for a run it has never heard of, rather than a 404.
// An empty list is a real answer — it is how `pin clear` reaches a second terminal.
test('variables: an empty list is a success, not a failure', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());

  const res = await V.listVariables(cfg(server), RUN_ID);
  assert.deepEqual([res.ok, res.variables], [true, []]);
});

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

/**
 * An upstream error message can quote the request that produced it, and `lib/http.mjs` puts a
 * snippet of the response body into `res.error`. This module's callers print that string:
 * `bin/pin.mjs` puts it in front of a user and the drainer writes it to a log file.
 */
test('variables: an upstream error never carries the API key back to a caller', async (t) => {
  const server = await fakeMubit(routes({
    'POST /v2/control/variables/set': {
      status: 500,
      json: { error: `upstream rejected Authorization: Bearer ${KEY}` },
    },
  }));
  t.after(() => server.close());

  const res = await V.setVariable(cfg(server), RUN_ID, 'cc.pin.a', 'x');
  assert.equal(res.ok, false);
  assert.ok(!res.error.includes(KEY), `the key came back in: ${res.error}`);
  assert.match(res.error, /REDACTED/);
});

// The deliberate opposite of the dashboard's `{record: false}`. These are small control-plane
// calls made on the plugin's own budget, so a route that is failing is real evidence about
// the instance and the breaker should hear about it.
test('variables: a failure is recorded against the circuit breaker', async (t) => {
  const server = await fakeMubit(routes({
    'POST /v2/control/variables/list': { status: 500, json: { error: 'boom' } },
  }));
  t.after(() => server.close());
  const c = cfg(server);

  const res = await V.listVariables(c, RUN_ID);
  assert.equal(res.ok, false);

  const B = await lib('breaker.mjs');
  assert.ok(B.readBreaker(c).failures.length > 0,
    'a failing route is evidence about the instance, not something to swallow');
});
