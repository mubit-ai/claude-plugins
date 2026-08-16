// @ts-check
/**
 * `lib/http.mjs` — the only network primitive in the plugin.
 *
 * Build-guide §4.2 (the module), §1.1 (routes and the per-route 256 KiB cap on
 * `/v2/control/query`), §1.2 (auth, and the one allowlisted unauthenticated route), §1.3
 * (required fields — a missing one is a 422, not a silent default), §1.8 + §5.2 (the `mode`
 * literal and what a typo costs), §4.3 (the `"default"` run-id guard), §4.7 (the breaker is
 * consulted before dialing).
 *
 * The load-bearing property of this module is that it **never throws**. Every hook exits 0
 * in every failure mode (§4.9), and that is only affordable because the network layer hands
 * back a value for every outcome — including the ones that are not HTTP outcomes at all:
 *
 *   success  -> `{ok: true,  status, body, ms}`
 *   failure  -> `{ok: false, state, status?, error, ms}`
 *
 * `state` is a `ConnState` from §4.7 (`unreachable | server_error | auth_failed |
 * not_responding`) for anything that reached the socket, plus two values that never do.
 *
 * `invalid_request`, for the five pre-flight guards below. A guard failure is a bug in
 * the *caller*, not a verdict about the server, so it is deliberately outside the ConnState
 * union — it must never reach `recordFailure` and must never colour the status line.
 *
 * `unconfigured`, for a config with no usable endpoint. Unlike `invalid_request` this one
 * *is* a ConnState, because it is the honest answer to "what is the connection doing?" and
 * the user needs to see it on the status line. It shares the important half: nothing is
 * dialed and nothing is recorded.
 *
 * Five pre-flight guards, each preventing a specific silent failure. All five return
 * `ok:false` having dialed nothing:
 *
 *   1. `/v2/control/query` is capped at 256 KiB server-side;
 *      everything else inherits 64 MiB. Blowing the cap is a 413, which looks like a server
 *      fault to the breaker — so we would open a circuit over our own oversized request.
 *   2. The `mode` literal. the servermaps only `"direct_bypass"` and `"direct"`
 *      to the direct lane; every other value — *including an omitted one*
 * — silently becomes `AgentRouted` with no error, costing an LLM
 *      call per prompt forever. The class being rejected is therefore "anything that
 *      silently becomes agent_routed", which makes `agent_routed` itself legal: it is rung 2
 *      of the §1.8 ladder, entered deliberately after a 403 on rung 1.
 *   3. `run_id === "default"`. The MCP server defaults
 *      `MUBIT_DEFAULT_SESSION_ID` to that literal, which collapses every user, project and
 *      machine into one run. Exact match only — a project legitimately called
 *      `default-config` must still be able to have a run.
 *   4. §1.3 required fields, validated locally so the error names the field instead of
 *      arriving as an opaque 422.
 *   5. `postLessons` deliberately has **no** `run_id`: empty means "all runs", which is
 *      exactly what a global-lessons fetch wants.
 *
 * Retries: **one**, only for `state === "not_responding"`, and only when the caller passes
 * `{retry: true}` — which only `drain.mjs` does, because it is detached and nobody is
 * waiting on it. A 5xx is never retried: the server answered, and hammering it is how a
 * memory layer turns a blip into an outage. A retry inside a blocking hook's 1500 ms budget
 * just converts one slow turn into one slower turn.
 *
 * Two `opts` beyond the documented `{timeoutMs, retry}`, both for callers that own the
 * meaning of a result better than this module can:
 *   - `{record: false}` suppresses breaker bookkeeping for one call.
 *   - a **403 is never recorded** by default. §5.2/F22: `permission_denied` on a rung the
 *     plugin deliberately probed is a policy verdict, not a transport fault, and recording it
 *     as `auth_failed` would pin the status line to "✖ auth" on a perfectly healthy instance
 *     whose operator merely set `the instance's direct-search policy disabled`.
 *
 * Discipline shared with the rest of `lib/`: zero dependencies, Node >= 20 built-ins only
 * (`fetch` and `AbortController` are built in), standalone-importable ESM. Network calls are
 * the only async work in the plugin.
 */

import { join } from 'node:path';

import { allowRequest, classifyError, readBreaker, recordFailure, recordSuccess } from './breaker.mjs';
import { authHeaders, isConfigured } from './config.mjs';
import { log } from './log.mjs';
import { readJson, resolveDataDir, writeJsonAtomic } from './state.mjs';

/**
 * @typedef {"unreachable"|"server_error"|"auth_failed"|"not_responding"|"invalid_request"
 *   |"unconfigured"} FailState
 */
/** @typedef {{ok: true, status: number, body: any, ms: number}} OkResult */
/** @typedef {{ok: false, state: FailState, status?: number, error: string, ms: number}} ErrResult */
/** @typedef {OkResult|ErrResult} Result */

// ---------------------------------------------------------------------------
// §1.1 — the route table, and the caps that go with it
// ---------------------------------------------------------------------------

export const ROUTES = Object.freeze({
  health: '/v2/core/health',
  register: '/v2/control/agents/register',
  heartbeat: '/v2/control/agents/heartbeat',
  ingest: '/v2/control/ingest',
  ingestJobs: '/v2/control/ingest/jobs',
  query: '/v2/control/query',
  context: '/v2/control/context',
  outcome: '/v2/control/outcome',
  checkpoint: '/v2/control/checkpoint',
  lessons: '/v2/control/lessons',
  reflect: '/v2/control/reflect',
});

/** §1.1: `POST /v2/control/query` has its own body limit. */
export const MAX_QUERY_BYTES = 256 * 1024;

/** §1.1: everything else inherits the global limit. */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** §4.2 / §6.1: `MUBIT_CC_TIMEOUT_MS` default. */
const DEFAULT_TIMEOUT_MS = 4000;

/** §1.1 / §7: the readiness probe is cached at `status/health.json` for 30 s. */
const HEALTH_TTL_MS = 30 * 1000;
const HEALTH_CACHE = ['status', 'health.json'];

/**
 * §5.2 + §1.8: the three literals that say, out loud, which rung is being paid for.
 * Case-sensitive: the server matches exact strings and case does not fold.
 */
export const QUERY_MODES = Object.freeze(['direct_bypass', 'direct', 'agent_routed']);

/** §4.3 / F21: the one run id that must never reach the wire. */
const POISONED_RUN_ID = 'default';

// ---------------------------------------------------------------------------
// request — §4.2
// ---------------------------------------------------------------------------

/**
 * The only network primitive. Aborts at `opts.timeoutMs ?? cfg.timeoutMs` (default 4000),
 * consults the breaker before dialing, classifies every failure into a state, and never
 * throws.
 *
 * @param {Record<string, any>} cfg
 * @param {string} method
 * @param {string} path   route path, optionally already carrying a query string
 * @param {any} [body]    serialized as JSON; omitted entirely for GET/HEAD
 * @param {{timeoutMs?: number, retry?: boolean, record?: boolean}} [opts]
 * @returns {Promise<Result>}
 */
export async function request(cfg, method, path, body, opts = {}) {
  const started = Date.now();
  try {
    const verb = String(method ?? 'GET').toUpperCase();
    const route = String(path ?? '');
    const wantsBody = body !== undefined && body !== null && verb !== 'GET' && verb !== 'HEAD';

    // --- guard 3: the poisoned run id (§4.3). Checked before anything is serialized, so a
    // 64 MiB batch carrying it costs nothing.
    if (wantsBody && isPoisonedRunId(body)) {
      return refuse(cfg, started,
        `refusing to send run_id "${POISONED_RUN_ID}" to ${verb} ${route} — the MCP server's `
        + 'MUBIT_DEFAULT_SESSION_ID default collapses every user, project and machine into one run (§4.3)',
        { route, run_id: POISONED_RUN_ID });
    }

    /** @type {string|undefined} */
    let bodyText;
    if (wantsBody) {
      const encoded = encodeBody(body);
      if (encoded.error) {
        return refuse(cfg, started, `${verb} ${route}: body is not serializable as JSON (${encoded.error})`, { route });
      }
      bodyText = encoded.text;

      // --- guard 1: the per-route cap (§1.1). A 413 would read as a server fault to the
      // breaker, so the request never leaves this process.
      const cap = capFor(route);
      const size = Buffer.byteLength(bodyText, 'utf8');
      if (size > cap) {
        return refuse(cfg, started,
          `${verb} ${route}: body is ${size} bytes, over the ${cap}-byte (${Math.round(cap / 1024)} KiB) cap for this route`,
          { route, bytes: size, cap });
      }
    }

    // --- §4.1: no endpoint, no dial. `urlFor` would hand `fetch` the bare route, which is a
    // relative URL and throws `ERR_INVALID_URL` before a socket exists — a throw that reads
    // downstream as a fault in a server we never contacted. Ahead of `allowRequest` because
    // that call writes when it spends the half-open probe.
    if (!isConfigured(cfg)) return refuseUnconfigured(cfg, started, `${verb} ${route}`);

    // --- §4.2/§4.7: consult the breaker before dialing. Called exactly once per request:
    // while the breaker is open this consumes the single half-open probe, so asking twice
    // would spend a probe the retry below is entitled to.
    if (!allowRequest(cfg)) {
      const b = readBreaker(cfg);
      const state = /** @type {FailState} */ (b.state && b.state !== 'ready' ? b.state : 'unreachable');
      return {
        ok: false,
        state,
        error: `circuit breaker open (${state}); ${verb} ${route} was not dialed`,
        ms: Date.now() - started,
      };
    }

    const timeoutMs = deadline(cfg, opts);
    const url = urlFor(cfg, route);

    let res = await dial(cfg, { verb, url, route, bodyText, timeoutMs, parse: 'json' });

    // Exactly one retry, only on the timeout path, only when the caller asked.
    if (!res.ok && res.state === 'not_responding' && opts && opts.retry === true) {
      res = await dial(cfg, { verb, url, route, bodyText, timeoutMs, parse: 'json' });
    }

    settle(cfg, res, opts);
    return withMs(res, started);
  } catch (err) {
    // Belt and braces: `request()` never throws, whatever a caller hands it.
    return {
      ok: false,
      state: classifyError(err, null),
      error: messageOf(err),
      ms: Date.now() - started,
    };
  }
}

// ---------------------------------------------------------------------------
// health — §1.2, §4.2, §7
// ---------------------------------------------------------------------------

/**
 * `GET /v2/core/health`, cached 30 s at `status/health.json`.
 *
 * The body is read as **text**: the handler returns the bare string `OK`
 *, so `JSON.parse` here is a guaranteed false negative —
 * it would report every healthy server as unhealthy and the plugin would never dial again.
 *
 * This is also the one route `enforce_core_access_policy` allowlists,
 * which is what makes it usable as a readiness probe before the user has pasted a key.
 *
 * @param {Record<string, any>} cfg
 * @param {{timeoutMs?: number, record?: boolean, force?: boolean}} [opts]
 * @returns {Promise<Result & {cached?: boolean}>}
 */
export async function health(cfg, opts = {}) {
  const started = Date.now();
  try {
    // §4.1, and before the cache read as well as before `allowRequest`: a cached `ready`
    // from a previous endpoint must not answer for a config that no longer has one.
    if (!isConfigured(cfg)) return refuseUnconfigured(cfg, started, `GET ${ROUTES.health}`);

    if (!opts || opts.force !== true) {
      const hit = readHealthCache(cfg);
      if (hit) return { ...hit, ms: Date.now() - started, cached: true };
    }

    if (!allowRequest(cfg)) {
      const b = readBreaker(cfg);
      const state = /** @type {FailState} */ (b.state && b.state !== 'ready' ? b.state : 'unreachable');
      return { ok: false, state, error: `circuit breaker open (${state}); health was not dialed`, ms: Date.now() - started };
    }

    const dialed = await dial(cfg, {
      verb: 'GET',
      url: urlFor(cfg, ROUTES.health),
      route: ROUTES.health,
      bodyText: undefined,
      timeoutMs: deadline(cfg, opts),
      parse: 'text',
    });

    // §4.7: a 2xx is necessary and not sufficient. The status alone says only that *some*
    // host answered — an SSO redirect, a captive portal, a proxy error page and a completely
    // different service all answer 200 — and taking that as healthy opens the session by
    // telling the model memory is active when nothing behind it is Mubit. The route returns
    // the bare string `OK`, so one comparison settles it.
    //
    // This lands as `server_error` rather than a state of its own: §4.7 already classes "a
    // 2xx whose body will not parse" that way for the JSON routes, and "up and answering
    // wrongly" is the same verdict here.
    // Only a 2xx is reinterpreted here. A `dial` that already failed carries a verdict about
    // the transport — `unreachable`, `not_responding`, `auth_failed` — and that verdict is
    // better than anything this line could say.
    const res = (dialed.ok && !isOkBody(dialed.body)) ? {
      ok: /** @type {const} */ (false),
      status: dialed.status,
      state: /** @type {FailState} */ ('server_error'),
      error: `GET ${ROUTES.health}: HTTP ${dialed.status} but the body was not "OK" `
        + `(${preview(dialed.body)})`,
      ms: dialed.ms,
    } : dialed;

    // Validated before it is cached, or a wrong host is remembered as healthy for 30 s.
    settle(cfg, res, opts);
    writeHealthCache(cfg, res);
    return withMs(res, started);
  } catch (err) {
    return { ok: false, state: classifyError(err, null), error: messageOf(err), ms: Date.now() - started };
  }
}

// ---------------------------------------------------------------------------
// Typed wrappers — §1.3, one route each, validated before dialing
// ---------------------------------------------------------------------------

/**
 * `POST /v2/control/ingest` — `StateIngestRequestPayload` requires
 * `run_id`; every `Stateingest itemPayload` requires `item_id` and
 * `content_type`. One malformed item rejects the whole batch, because that is exactly what
 * the server does — a 422 on item 2 loses items 1 and 3 as well.
 *
 * `opts` is forwarded verbatim: `drain.mjs` is the one caller that asks for `{retry: true}`.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} req
 * @param {{timeoutMs?: number, retry?: boolean, record?: boolean}} [opts]
 * @returns {Promise<Result>}
 */
export async function postIngest(cfg, req, opts = {}) {
  const started = Date.now();
  const bad = firstOf(
    requireString(req, 'run_id', 'postIngest'),
    requireItems(req),
  );
  if (bad) return refuse(cfg, started, bad, { route: ROUTES.ingest });
  return request(cfg, 'POST', ROUTES.ingest, req, opts);
}

/**
 * `POST /v2/control/query` — rungs 1 and 2 of the §1.8 ladder.
 * The query payload requires `run_id`; `mode` is validated
 * here because the server has no error for a wrong one, only a bill.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} req
 * @param {{timeoutMs?: number, retry?: boolean, record?: boolean}} [opts]
 * @returns {Promise<Result>}
 */
export async function postQuery(cfg, req, opts = {}) {
  const started = Date.now();
  const bad = firstOf(
    requireString(req, 'run_id', 'postQuery'),
    requireMode(req),
  );
  if (bad) return refuse(cfg, started, bad, { route: ROUTES.query, mode: safeMode(req) });
  return request(cfg, 'POST', ROUTES.query, req, opts);
}

/**
 * `POST /v2/control/context` — rung 3 only, and it costs two LLM calls (§1.8).
 * `StateContextRequestPayload` requires `run_id`.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} req
 * @param {{timeoutMs?: number, retry?: boolean, record?: boolean}} [opts]
 * @returns {Promise<Result>}
 */
export async function postContext(cfg, req, opts = {}) {
  const started = Date.now();
  const bad = requireString(req, 'run_id', 'postContext');
  if (bad) return refuse(cfg, started, bad, { route: ROUTES.context });
  return request(cfg, 'POST', ROUTES.context, req, opts);
}

/**
 * `POST /v2/control/outcome` — `StateRecordOutcomePayload` requires
 * `run_id` and a **non-empty** `reference_id`. §1.3: for run-level attribution with no single
 * primary lesson, pass `"global"` and put the real ids in `entry_ids[]` — never `""`.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} req
 * @param {{timeoutMs?: number, retry?: boolean, record?: boolean}} [opts]
 * @returns {Promise<Result>}
 */
export async function postOutcome(cfg, req, opts = {}) {
  const started = Date.now();
  const bad = firstOf(
    requireString(req, 'run_id', 'postOutcome'),
    requireString(req, 'reference_id', 'postOutcome',
      'pass "global" for run-level attribution and put the real ids in entry_ids[] (§1.3)'),
  );
  if (bad) return refuse(cfg, started, bad, { route: ROUTES.outcome });
  return request(cfg, 'POST', ROUTES.outcome, req, opts);
}

/**
 * `POST /v2/control/checkpoint` — `StateCheckpointPayload` requires
 * `run_id`.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} req
 * @param {{timeoutMs?: number, retry?: boolean, record?: boolean}} [opts]
 * @returns {Promise<Result>}
 */
export async function postCheckpoint(cfg, req, opts = {}) {
  const started = Date.now();
  const bad = requireString(req, 'run_id', 'postCheckpoint');
  if (bad) return refuse(cfg, started, bad, { route: ROUTES.checkpoint });
  return request(cfg, 'POST', ROUTES.checkpoint, req, opts);
}

/**
 * `POST /v2/control/lessons` — the one control route with **no** required `run_id`. An
 * absent run scope means "every run", which is precisely what a global-lessons fetch wants;
 * requiring one here would make cross-run recall impossible.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} [req]
 * @param {{timeoutMs?: number, retry?: boolean, record?: boolean}} [opts]
 * @returns {Promise<Result>}
 */
export async function postLessons(cfg, req = {}, opts = {}) {
  return request(cfg, 'POST', ROUTES.lessons, req ?? {}, opts);
}

/**
 * `POST /v2/control/agents/register` — `StateAgentRegisterRequestPayload`
 * requires `run_id` and `agent_id`.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} req
 * @param {{timeoutMs?: number, retry?: boolean, record?: boolean}} [opts]
 * @returns {Promise<Result>}
 */
export async function registerAgent(cfg, req, opts = {}) {
  const started = Date.now();
  const bad = firstOf(
    requireString(req, 'run_id', 'registerAgent'),
    requireString(req, 'agent_id', 'registerAgent'),
  );
  if (bad) return refuse(cfg, started, bad, { route: ROUTES.register });
  return request(cfg, 'POST', ROUTES.register, req, opts);
}

/**
 * `POST /v2/control/agents/heartbeat` — the same identity pair as register: without both,
 * the heartbeat lands on nothing.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} req
 * @param {{timeoutMs?: number, retry?: boolean, record?: boolean}} [opts]
 * @returns {Promise<Result>}
 */
export async function heartbeat(cfg, req, opts = {}) {
  const started = Date.now();
  const bad = firstOf(
    requireString(req, 'run_id', 'heartbeat'),
    requireString(req, 'agent_id', 'heartbeat'),
  );
  if (bad) return refuse(cfg, started, bad, { route: ROUTES.heartbeat });
  return request(cfg, 'POST', ROUTES.heartbeat, req, opts);
}

/**
 * `GET /v2/control/ingest/jobs/<job_id>?run_id=<id>` — the job query
 * takes `run_id` on the **query string**, not in a body, and a GET carries
 * no body at all.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {string} jobId
 * @param {{timeoutMs?: number, retry?: boolean, record?: boolean}} [opts]
 * @returns {Promise<Result>}
 */
export async function getIngestJob(cfg, runId, jobId, opts = {}) {
  const started = Date.now();
  const run = typeof runId === 'string' ? runId.trim() : '';
  const job = typeof jobId === 'string' ? jobId.trim() : '';

  if (!run) {
    return refuse(cfg, started,
      'getIngestJob: run_id is required — it goes on the query string',
      { route: ROUTES.ingestJobs });
  }
  if (!job) {
    return refuse(cfg, started, 'getIngestJob: job_id is required', { route: ROUTES.ingestJobs });
  }
  // The §4.3 guard lives in `request()`, which only inspects bodies — and this route has
  // none. Repeat it here rather than let the poisoned literal through on a query string.
  if (run === POISONED_RUN_ID) {
    return refuse(cfg, started,
      `getIngestJob: refusing run_id "${POISONED_RUN_ID}" (§4.3)`, { route: ROUTES.ingestJobs });
  }

  const path = `${ROUTES.ingestJobs}/${encodeURIComponent(job)}?run_id=${encodeURIComponent(run)}`;
  return request(cfg, 'GET', path, undefined, opts);
}

// ---------------------------------------------------------------------------
// The dial itself
// ---------------------------------------------------------------------------

/**
 * One attempt. Returns the same envelope as `request()` minus `ms`, and never throws.
 *
 * @param {Record<string, any>} cfg
 * @param {{verb: string, url: string, route: string, bodyText: string|undefined,
 *          timeoutMs: number, parse: 'json'|'text'}} o
 * @returns {Promise<{ok: true, status: number, body: any}|{ok: false, state: FailState, status?: number, error: string}>}
 */
async function dial(cfg, o) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { controller.abort(); } catch { /* already settled */ }
  }, Math.max(1, o.timeoutMs));
  if (typeof timer.unref === 'function') timer.unref();

  try {
    /** @type {Record<string, string>} */
    const headers = {
      accept: o.parse === 'text' ? 'text/plain, */*' : 'application/json',
      // §1.2: `Authorization: Bearer <key>` on everything. With no key configured the header
      // is ABSENT rather than empty — `Bearer undefined` is a far harder 401 to diagnose.
      ...authHeaders(cfg),
    };
    if (o.bodyText !== undefined) headers['content-type'] = 'application/json';

    const res = await fetch(o.url, {
      method: o.verb,
      headers,
      body: o.bodyText,
      signal: controller.signal,
      redirect: 'follow',
    });

    const status = res.status;
    const text = await res.text();

    if (status >= 200 && status < 300) {
      if (o.parse === 'text') return { ok: true, status, body: text };

      const parsed = decodeJson(text);
      if (parsed.error) {
        // §4.7/F10: a 200 whose body will not parse is a broken server (a reverse proxy
        // serving an HTML error page is the real-world shape), never an unhandled rejection.
        return {
          ok: false,
          state: /** @type {FailState} */ (classifyError(parsed.error, status)),
          status,
          error: `${o.verb} ${o.route}: HTTP ${status} with an unparseable JSON body (${snippet(text)})`,
        };
      }
      return { ok: true, status, body: parsed.value };
    }

    return {
      ok: false,
      state: /** @type {FailState} */ (classifyError(null, status)),
      status,
      error: `${o.verb} ${o.route}: HTTP ${status}${text ? ` ${snippet(text)}` : ''}`,
    };
  } catch (err) {
    // A deliberate abort is unambiguous regardless of how the runtime spells the rejection.
    const state = /** @type {FailState} */ (timedOut ? 'not_responding' : classifyError(err, null));
    return {
      ok: false,
      state,
      error: timedOut
        ? `${o.verb} ${o.route}: aborted after ${o.timeoutMs}ms`
        : `${o.verb} ${o.route}: ${messageOf(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Breaker bookkeeping for one completed `request()`/`health()` — the whole reason F7 can
 * ever fire. Recorded once per call, not once per attempt: a retried timeout is one symptom,
 * and double-counting it would escalate `timeoutStreak` twice as fast as §4.7 allows.
 *
 * @param {Record<string, any>} cfg
 * @param {{ok: boolean, state?: string, status?: number}} res
 * @param {{record?: boolean}|undefined} opts
 */
function settle(cfg, res, opts) {
  if (opts && opts.record === false) return;
  if (res.ok) { recordSuccess(cfg); return; }
  // §5.2/F22: `permission_denied` is a policy verdict about a rung the caller chose to probe,
  // not a transport fault. Recording it would pin the status line to "✖ auth" on an instance
  // that is merely running with the instance's direct-search policy disabled.
  if (res.status === 403) return;
  recordFailure(cfg, /** @type {any} */ (res.state));
}

// ---------------------------------------------------------------------------
// §7 — status/health.json, a 30 s verdict cache
// ---------------------------------------------------------------------------

/** @param {Record<string, any>} cfg */
function healthCachePath(cfg) {
  return join(resolveDataDir(cfg), ...HEALTH_CACHE);
}

/**
 * @param {Record<string, any>} cfg
 * @returns {Result|null}
 */
function readHealthCache(cfg) {
  try {
    const raw = readJson(healthCachePath(cfg), null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return null;
    if (Math.abs(Date.now() - raw.at) >= HEALTH_TTL_MS) return null;
    // The verdict is per endpoint: switching between a local and a hosted instance must not
    // inherit the other's answer.
    if (raw.endpoint !== endpointOf(cfg)) return null;

    if (raw.ok === true) {
      return { ok: true, status: numOr(raw.status, 200), body: typeof raw.body === 'string' ? raw.body : 'OK', ms: 0 };
    }
    if (raw.ok === false) {
      return {
        ok: false,
        state: /** @type {FailState} */ (typeof raw.state === 'string' ? raw.state : 'unreachable'),
        ...(typeof raw.status === 'number' ? { status: raw.status } : {}),
        error: typeof raw.error === 'string' ? raw.error : 'health check failed',
        ms: 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, any>} cfg
 * @param {{ok: boolean, status?: number, body?: any, state?: string, error?: string}} res
 */
function writeHealthCache(cfg, res) {
  try {
    writeJsonAtomic(healthCachePath(cfg), {
      at: Date.now(),
      endpoint: endpointOf(cfg),
      ok: res.ok === true,
      status: typeof res.status === 'number' ? res.status : 0,
      body: typeof res.body === 'string' ? res.body.slice(0, 256) : '',
      state: res.ok === true ? 'ready' : (res.state ?? 'unreachable'),
      error: res.ok === true ? '' : String(res.error ?? ''),
    });
  } catch {
    // §4.9: an unwritable data dir costs the cache, never the probe.
  }
}

// ---------------------------------------------------------------------------
// Pre-flight validation
// ---------------------------------------------------------------------------

/**
 * A guard verdict: log it at `error` (these are caller bugs, and a silent one costs either
 * money or a collapsed run id) and hand back a failed result having dialed nothing.
 *
 * @param {Record<string, any>} cfg
 * @param {number} started
 * @param {string} error
 * @param {Record<string, any>} [fields]
 * @returns {ErrResult}
 */
function refuse(cfg, started, error, fields = {}) {
  log(cfg, 'error', error, fields);
  return { ok: false, state: 'invalid_request', error, ms: Date.now() - started };
}

/**
 * The same shape for "no endpoint is set", at `debug` rather than `error`: an install nobody
 * has signed in to yet is an ordinary state, not a fault, and one log line per dial per
 * prompt would be noise on a machine whose only problem is that it has not been configured.
 *
 * Every caller of this must run *before* `allowRequest`, which writes the breaker file when
 * it spends a half-open probe. Refusing after that point would still leave a breaker record
 * for a server that was never dialed.
 *
 * @param {Record<string, any>} cfg
 * @param {number} started
 * @param {string} what the verb and route, for the message
 * @returns {ErrResult}
 */
function refuseUnconfigured(cfg, started, what) {
  const error = `${what}: no Mubit endpoint is configured; nothing was dialed`;
  log(cfg, 'debug', error);
  return { ok: false, state: 'unconfigured', error, ms: Date.now() - started };
}

/**
 * Was that body Mubit answering, rather than merely something answering? The health handler
 * returns the bare string `OK`, so this is an equality test and not a heuristic. Trimmed,
 * because a proxy that appends a newline has still relayed a healthy answer.
 *
 * @param {any} body the text body of a 2xx
 * @returns {boolean}
 */
function isOkBody(body) {
  return String(body ?? '').trim() === 'OK';
}

/** A short, single-line, quoted glimpse of an unexpected body — enough to recognise a login
 *  page or a proxy error in a log without pasting a kilobyte of HTML into it. */
function preview(body) {
  const s = String(body ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return 'empty body';
  return s.length > 60 ? `${JSON.stringify(s.slice(0, 60))}…` : JSON.stringify(s);
}

/**
 * §1.3: fields without `#[serde(default)]` are mandatory, and a missing one is a 422 — which
 * looks like a server fault to everything downstream. Empty strings count as missing.
 *
 * @param {any} req
 * @param {string} field
 * @param {string} who
 * @param {string} [hint]
 * @returns {string}
 */
function requireString(req, field, who, hint) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) {
    return `${who}: a request object is required`;
  }
  const v = req[field];
  if (typeof v === 'string' && v.trim()) return '';
  return `${who}: "${field}" is required and must be a non-empty string (§1.3 — a missing field is a 422, not a default)`
    + (hint ? `; ${hint}` : '');
}

/**
 * Every item needs `item_id` and `content_type`. The whole batch is
 * rejected when any single item is malformed, because that is what the server does: a 422 on
 * item 2 also loses items 1 and 3.
 * @param {any} req
 * @returns {string}
 */
function requireItems(req) {
  const items = req && typeof req === 'object' ? req.items : undefined;
  if (!Array.isArray(items)) return 'postIngest: "items" is required and must be an array';
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      return `postIngest: items[${i}] must be an object`;
    }
    for (const field of ['item_id', 'content_type']) {
      const v = it[field];
      if (!(typeof v === 'string' && v.trim())) {
        return `postIngest: items[${i}]."${field}" is required — one malformed item rejects the whole batch`;
      }
    }
  }
  return '';
}

/**
 * §5.2 + §1.8. The rejected class is "anything that silently becomes `agent_routed`", which
 * is why an omitted `mode` is rejected too: the serverdefaults it, so omission and a
 * typo cost exactly the same — one LLM call per prompt, forever, with no error anywhere.
 * @param {any} req
 * @returns {string}
 */
function requireMode(req) {
  const mode = req && typeof req === 'object' ? req.mode : undefined;
  if (typeof mode === 'string' && QUERY_MODES.includes(mode)) return '';
  const shown = mode === undefined ? '(omitted)' : JSON.stringify(mode);
  return `postQuery: invalid query mode ${shown} — must be exactly one of `
    + `${QUERY_MODES.map((m) => `"${m}"`).join(', ')} (case-sensitive). `
    + 'Anything else — including an omitted mode — silently becomes agent_routed server-side '
    + 'and costs an LLM call per prompt with no error.';
}

/** @param {any} req */
function safeMode(req) {
  const m = req && typeof req === 'object' ? req.mode : undefined;
  return typeof m === 'string' ? m : String(m);
}

/**
 * §4.3 / F21: exact match only. `cc-default-config-9f2a11c4` is a legitimate run id and must
 * still be able to reach the wire — this is a ban on one poisoned literal, not a substring.
 * @param {any} body
 */
function isPoisonedRunId(body) {
  return !!body && typeof body === 'object' && !Array.isArray(body) && body.run_id === POISONED_RUN_ID;
}

/** §1.1: the query route carries its own, much smaller, cap. */
function capFor(route) {
  return pathOf(route) === ROUTES.query ? MAX_QUERY_BYTES : MAX_BODY_BYTES;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** @param {any} body @returns {{text: string, error: string}} */
function encodeBody(body) {
  try {
    const text = JSON.stringify(body);
    if (typeof text !== 'string') return { text: '', error: 'value is not JSON-representable' };
    return { text, error: '' };
  } catch (err) {
    return { text: '', error: messageOf(err) };
  }
}

/** @param {string} text @returns {{value: any, error: any}} */
function decodeJson(text) {
  if (!text || !text.trim()) return { value: {}, error: null };
  try {
    return { value: JSON.parse(text), error: null };
  } catch (err) {
    return { value: null, error: err };
  }
}

/** `opts.timeoutMs ?? cfg.timeoutMs`, default 4000 (§4.2, §6.1). */
function deadline(cfg, opts) {
  const o = Number(opts && opts.timeoutMs);
  if (Number.isFinite(o) && o > 0) return Math.trunc(o);
  const c = Number(cfg && cfg.timeoutMs);
  if (Number.isFinite(c) && c > 0) return Math.trunc(c);
  return DEFAULT_TIMEOUT_MS;
}

/** @param {Record<string, any>} cfg */
function endpointOf(cfg) {
  const ep = typeof cfg?.endpoint === 'string' ? cfg.endpoint.trim() : '';
  return ep.replace(/\/+$/, '');
}

/** @param {Record<string, any>} cfg @param {string} route */
function urlFor(cfg, route) {
  const path = route.startsWith('/') ? route : `/${route}`;
  return `${endpointOf(cfg)}${path}`;
}

/** The pathname of a route that may already carry a query string. */
function pathOf(route) {
  const i = route.indexOf('?');
  return i === -1 ? route : route.slice(0, i);
}

/** @template T @param {...string} vals @returns {string} */
function firstOf(...vals) {
  for (const v of vals) if (v) return v;
  return '';
}

/** @param {any} res @param {number} started @returns {any} */
function withMs(res, started) {
  return { ...res, ms: Date.now() - started };
}

/** @param {any} err */
function messageOf(err) {
  try {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    const parts = [];
    if (err.name) parts.push(String(err.name));
    if (err.message) parts.push(String(err.message));
    const cause = err.cause;
    if (cause && (cause.code || cause.message)) parts.push(`(${String(cause.code || cause.message)})`);
    return parts.join(': ') || String(err);
  } catch {
    return 'unknown error';
  }
}

/** A short, log-safe excerpt of a body we could not use. */
function snippet(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** @param {any} v @param {number} d */
function numOr(v, d) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
