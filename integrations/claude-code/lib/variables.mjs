// @ts-check
/**
 * `lib/variables.mjs` — `/v2/control/variables/{set,get,list,delete}`, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * Why this exists at all: there is no variables MCP tool
 * ---------------------------------------------------------------------------
 * The vendored server at `mcp/dist/server.js` registers twenty-one tools and **not one of
 * them touches variables**, and that bundle cannot be rebuilt in this checkout. So an
 * allowlist entry was never an option: the surface for pinned context is a skill plus a
 * `bin/` script — the shape `auth` and `dashboard` already use — and this module is the only
 * thing in the plugin that reaches these four routes.
 *
 * That makes the guards below the whole contract rather than a second line of defence.
 *
 * ---------------------------------------------------------------------------
 * The ordinary deadline, and failures ARE recorded
 * ---------------------------------------------------------------------------
 * Deliberately the opposite of `lib/dashboard-api.mjs`, which passes `{record: false}` on
 * every call because a page polling every fifteen seconds would open the breaker for the
 * hooks. Nothing here polls. These are small control-plane calls made on the plugin's own
 * budget — one `list` per drain, one `set` when a person types a command — so `abortedEarly`
 * is irrelevant and **a failing route is real evidence about the instance**. Swallowing it
 * would hide a broken deployment from the breaker and from the status line both.
 *
 * The 4000 ms `lib/http.mjs` default is right for the same reason: the callers are a detached
 * drainer and a command a person is watching, neither of which is a page and neither of which
 * is on a prompt's critical path.
 *
 * ---------------------------------------------------------------------------
 * What the server does that a caller cannot see
 * ---------------------------------------------------------------------------
 *   - **`value_json` is a JSON *document*, not a value.** The handler runs
 *     `serde_json::from_str(&req.value_json)` and answers `invalid_argument` on failure, so a
 *     raw string reaches the wire only to be refused. Every value is `JSON.stringify`d here,
 *     and one that cannot be is refused before a socket exists.
 *   - **`source` is matched as an exact string with a silent fallback.** The five it knows
 *     are `system | reasoning | retrieval | perception | explicit`; anything else — including
 *     a perfectly plausible `"user"` — becomes `Explicit` with no error. `system` is the one
 *     value this plugin sends, because it is the one whose meaning was verified.
 *   - **`list` returns every variable in the run, whoever wrote it.** Another client is
 *     entitled to keep its own state in the same run. `listVariables` filters to this
 *     plugin's own `cc.pin.` namespace, so there is exactly one place that decides what the
 *     plugin considers its own.
 *   - **`list` on an unknown run is `{variables: []}`, not a 404.** An empty list is a real
 *     answer, and is how a cleared pin reaches a second terminal.
 *
 * Constraints, as everywhere in `lib/`: zero dependencies, Node >= 20 built-ins only, and
 * nothing here throws — every outcome is a value (§4.9).
 */

import { request } from './http.mjs';

/**
 * The four routes. Frozen, and there is no fifth.
 *
 * The neighbouring surfaces on the same server — goals, actions, decision cycles — are
 * deprecated upstream and are not things a memory plugin has any business writing. Naming the
 * four exactly is what stops "while we are here" from turning this into an orchestrator.
 */
export const VARIABLE_ROUTES = Object.freeze({
  set: '/v2/control/variables/set',
  get: '/v2/control/variables/get',
  list: '/v2/control/variables/list',
  delete: '/v2/control/variables/delete',
});

/**
 * The namespace this plugin writes under: `cc.pin.<slug>`.
 *
 * One variable per pin rather than one blob for all of them. Codaph keeps a single
 * `codaph.run_state`, but that shape is read-modify-write, and under the default
 * `per-directory` strategy two terminals in one directory share a run — so a blob loses a
 * concurrent pin silently, which is the worst way to lose a standing constraint.
 */
export const PIN_NAMESPACE = 'cc.pin.';

/**
 * §4.3 / F21: the one run id that must never reach the wire. `MUBIT_DEFAULT_SESSION_ID`
 * defaults to this literal on the MCP server, and a *pin* written under it would render as a
 * standing constraint in a stranger's session.
 */
const POISONED_RUN_ID = 'default';

/** The one `source` whose meaning was verified against the server's own match arm. */
const SOURCE = 'system';

// ---------------------------------------------------------------------------
// set / get / list / delete
// ---------------------------------------------------------------------------

/**
 * `POST /v2/control/variables/set`.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {string} name   fully qualified, e.g. `cc.pin.vendored`
 * @param {any} value     JSON-encoded here; refused if it cannot be
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, error?: string, state?: string, status?: number}>}
 */
export async function setVariable(cfg, runId, name, value, opts = {}) {
  const run = clean(runId);
  const key = clean(name);
  const bad = refuseRun(run, 'set') || refuseName(key, 'set');
  if (bad) return { ok: false, error: bad };

  let valueJson;
  try {
    valueJson = JSON.stringify(value);
  } catch (err) {
    // A circular object. The server would answer `invalid_argument` after a full round trip,
    // and the breaker would read that round trip as an instance fault.
    return { ok: false, error: `setVariable: value is not serializable as JSON (${messageOf(err)})` };
  }
  if (typeof valueJson !== 'string') {
    // `undefined`, a function and a BigInt all land here — `JSON.stringify` returns
    // `undefined` for the first two and throws for the third, which the catch above took.
    return { ok: false, error: 'setVariable: value has no JSON serialization (undefined, a function or a symbol)' };
  }

  const res = await request(cfg, 'POST', VARIABLE_ROUTES.set, {
    run_id: run, name: key, value_json: valueJson, source: SOURCE,
  }, opts);
  return envelope(cfg, res);
}

/**
 * `POST /v2/control/variables/get` — one variable, by name.
 *
 * Not on any hot path: the drainer refreshes with a single `list`, which carries `value_json`
 * inline for every variable in the run. This exists for the CLI's `--name` read and for
 * anything that holds a name and nothing else.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {string} name
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, value?: any, error?: string, state?: string, status?: number}>}
 */
export async function getVariable(cfg, runId, name, opts = {}) {
  const run = clean(runId);
  const key = clean(name);
  const bad = refuseRun(run, 'get') || refuseName(key, 'get');
  if (bad) return { ok: false, error: bad };

  const res = await request(cfg, 'POST', VARIABLE_ROUTES.get, { run_id: run, name: key }, opts);
  if (!res.ok) return envelope(cfg, res);
  const parsed = decode(res.body?.value_json);
  return { ok: true, value: parsed.ok ? parsed.value : undefined };
}

/**
 * `POST /v2/control/variables/list` — every variable in the run, narrowed to this plugin's.
 *
 * **One round trip, not N+1.** `ListVariablesResponse` carries a full `VariableResponse` per
 * entry — `name`, `value_json`, `var_type`, `created_at`, `last_updated`, `access_count`,
 * `source` — so nothing here needs a follow-up `get`. Had it returned bare names, the five-pin
 * cap would have become load-bearing for latency rather than for context spend.
 *
 * A single entry whose `value_json` will not parse costs that entry and not the list: it is
 * one pin missing rather than every pin missing, and the difference matters when the thing
 * being lost is a constraint the user is relying on.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, variables: Array<{name: string, slug: string, value: any,
 *   updatedAt: string}>, error?: string, state?: string, status?: number}>}
 */
export async function listVariables(cfg, runId, opts = {}) {
  const run = clean(runId);
  const bad = refuseRun(run, 'list');
  if (bad) return { ok: false, variables: [], error: bad };

  const res = await request(cfg, 'POST', VARIABLE_ROUTES.list, { run_id: run }, opts);
  if (!res.ok) return { ...envelope(cfg, res), variables: [] };

  const raw = Array.isArray(res.body?.variables) ? res.body.variables : [];
  /** @type {Array<{name: string, slug: string, value: any, updatedAt: string}>} */
  const variables = [];
  for (const v of raw) {
    if (!isObject(v)) continue;
    const name = typeof v.name === 'string' ? v.name : '';
    // Case-sensitive, and a prefix rather than a contains: `cc.pinned` is somebody else's
    // variable that happens to start with the same letters.
    if (!name.startsWith(PIN_NAMESPACE)) continue;
    const slug = name.slice(PIN_NAMESPACE.length);
    if (!slug) continue;
    const parsed = decode(v.value_json);
    if (!parsed.ok) continue;
    variables.push({
      name,
      slug,
      value: parsed.value,
      updatedAt: typeof v.last_updated === 'string' ? v.last_updated : '',
    });
  }
  return { ok: true, variables };
}

/**
 * `POST /v2/control/variables/delete`.
 *
 * The server answers `Ack{success:true}` whether or not the variable existed, which is the
 * right shape for "make sure this is gone" and is what `pin clear` wants.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {string} name
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, error?: string, state?: string, status?: number}>}
 */
export async function deleteVariable(cfg, runId, name, opts = {}) {
  const run = clean(runId);
  const key = clean(name);
  const bad = refuseRun(run, 'delete') || refuseName(key, 'delete');
  if (bad) return { ok: false, error: bad };

  const res = await request(cfg, 'POST', VARIABLE_ROUTES.delete, { run_id: run, name: key }, opts);
  return envelope(cfg, res);
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * §1.3 plus §4.3, checked before anything is serialized.
 *
 * `lib/http.mjs` refuses the poisoned run id too, on the request body — but its guard is
 * about what leaves the process, and this one is about what a caller meant. Answering here
 * means the error names the call (`listVariables`) rather than the route, which is the
 * difference between a message somebody can act on and one they have to trace.
 *
 * @param {string} run @param {string} op @returns {string}
 */
function refuseRun(run, op) {
  if (!run) return `${op}Variable: run_id is required — a variable is run-scoped state and has nowhere else to live`;
  // Exact match only. A project legitimately called `default-config` must still have a run.
  if (run === POISONED_RUN_ID) {
    return `${op}Variable: refusing run_id "${POISONED_RUN_ID}" — the MCP server's `
      + 'MUBIT_DEFAULT_SESSION_ID default collapses every user, project and machine into one '
      + 'run, and a pin written there would render in a stranger\'s session (§4.3)';
  }
  return '';
}

/** @param {string} name @param {string} op @returns {string} */
function refuseName(name, op) {
  if (!name) return `${op}Variable: name is required — an empty one writes a variable called ""`;
  return '';
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

/**
 * One `lib/http.mjs` `Result` as this module's envelope, with the key taken out of it.
 *
 * Belt and braces, the same reasoning as `lib/dashboard-api.mjs`'s `scrubKey`: no upstream is
 * expected to echo the `Authorization` header back, but a proxy error page and a verbose 4xx
 * both can, and `lib/http.mjs` puts a snippet of the response body into `res.error`. Callers
 * of this module print that string — `bin/pin.mjs` to a terminal, the drainer to a log file.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} res
 * @returns {{ok: boolean, error?: string, state?: string, status?: number}}
 */
function envelope(cfg, res) {
  if (res && res.ok) return { ok: true };
  return {
    ok: false,
    error: scrubKey(cfg, String(res?.error ?? 'the variables route failed')),
    ...(typeof res?.state === 'string' ? { state: res.state } : {}),
    ...(typeof res?.status === 'number' ? { status: res.status } : {}),
  };
}

/** @param {Record<string, any>} cfg @param {string} text @returns {string} */
function scrubKey(cfg, text) {
  try {
    const s = String(text ?? '');
    const key = cfg && typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
    if (!key || !s.includes(key)) return s;
    return s.split(key).join('[REDACTED:api-key]');
  } catch {
    return '';
  }
}

/** @param {any} v @returns {{ok: boolean, value?: any}} */
function decode(v) {
  if (typeof v !== 'string' || !v) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(v) };
  } catch {
    // Written by something else, or truncated in transit. One entry lost, not the list.
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/** @param {any} v @returns {string} */
function clean(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** @param {any} v @returns {boolean} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @param {any} err @returns {string} */
function messageOf(err) {
  try {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    return [err.name, err.message].filter(Boolean).join(': ') || String(err);
  } catch {
    return 'unknown error';
  }
}
