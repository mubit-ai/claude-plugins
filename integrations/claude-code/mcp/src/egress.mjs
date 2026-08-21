// @ts-check
/**
 * `mcp/src/egress.mjs` — the missing egress stage on the MCP write path (§8.3).
 *
 * Every other outbound call this plugin makes goes through `lib/http.mjs`, which refuses a
 * poisoned run id (§4.3) and scrubs the body first (§7). The MCP server is the one
 * exception: it is a vendored bundle that dials the endpoint itself, and nothing in this
 * repo ever saw the request. Two things went out through that gap.
 *
 *   1. **Scope.** `mubit_learned` is the only lesson-writing tool a default install
 *      exposes, and the bundled SDK hard-codes `lesson_scope: "session"` on it. Server-side
 *      the cross-run overlay admits every lesson whose scope is not `"run"`, so a `session`
 *      lesson is read by *other runs* exactly as a `global` one is. It is not "narrower than
 *      global"; on the read side it is the same lane. A benchmark harness found this the
 *      expensive way — lessons one task wrote were injected into five unrelated ones.
 *
 *   2. **The run id.** Every write tool takes an optional `session_id` that the server
 *      prefers over the run the launcher derived, so an agent can write into any run it can
 *      name. Closing the second hole is what makes the first one worth closing.
 *
 * **Why here and not where the bug is.** The constant lives inside a 5.9 MB vendored bundle
 * (`mcp/dist/server.js`) whose TypeScript source is not in this repo; hand-editing a build
 * artefact would be discarded by the first real rebuild. The seam is the launcher: it is
 * real source this repo owns, it runs to completion in the same process *before* it imports
 * the server, and the server's transport dials with global `fetch`. So the launcher installs
 * a guard on `globalThis.fetch` and the vendored bundle stays byte-identical.
 *
 * The same seam carries the correction back. An extra key on the ingest **response**
 * survives the bundle's `response.json()` → `compactResponse` (a denylist of five dead
 * envelope fields, not an allowlist) → `asText` into the tool result the model reads.
 *
 * **The one rule.** This code sits in the request path of every call the server makes,
 * including shapes it has never seen. It must never be able to fail a write: every branch
 * falls through to the untouched original request or response on any surprise.
 */

/**
 * The scope lattice, widest last. `run` is the only scope the cross-run overlay skips, so
 * every step up this list is a step out of the run that wrote the lesson.
 *
 * `org` is here to be clamped, never to be chosen: it is promotion-only (§1.6) and must
 * never be client-written, so it is absent from `CEILINGS` below.
 */
const LATTICE = ['run', 'session', 'global', 'org'];

/** What a user may set the ceiling to — the three the control plane accepts from a client. */
const CEILINGS = ['run', 'session', 'global'];

/** The route a lesson leaves by. Matched on the pathname only; the host is the user's. */
const INGEST_PATH = '/v2/control/ingest';

/** Named in the clamp note, so the tool result carries its own escape hatch. */
const RAISE_WITH = 'mcpLessonScope (MUBIT_MCP_LESSON_SCOPE)';

/**
 * The scope the bundled SDK stamps on **every** lesson it sends, in `learned()`, regardless
 * of anything the caller said (`mcp/dist/server.js`: `lesson_scope: "session"` — one
 * occurrence in the whole bundle, and `mubit_learned` has no scope parameter to override it
 * with). It is a constant of the build, not a request, and the guard resolves it to the
 * ceiling rather than treating it as a ceiling of its own.
 *
 * That distinction is what makes the setting mean anything above `session`: under a pure
 * clamp, a user who raised the ceiling to `global` would still get `session` on every write,
 * because the only write tool a default install exposes never asks for anything else.
 *
 * The cost is stated plainly: on the wire this constant is indistinguishable from a caller
 * that asked for `session` outright, so a restored `mubit_remember` explicitly requesting
 * `session` under a `global` ceiling is written at `global` too. It is bounded — at the
 * default ceiling, and at `session`, the two readings agree exactly — and it is the
 * ambiguity the vendored bundle creates, not one this file invents. When a rebuild stops
 * hard-coding the value, `mcp-egress.test.mjs` fails on purpose and this goes with it.
 *
 * `guardIngest` knows nothing about this: it is a lattice, and the lattice clamps. Only
 * `installFetchGuard`, which exists specifically to guard *this* bundle, passes it in.
 */
const SDK_DEFAULT_SCOPE = 'session';

/**
 * The response body length changes when the note is attached, and a copied `content-length`
 * or `content-encoding` would then describe a body that no longer exists.
 */
const RESHAPED_HEADERS = ['content-length', 'content-encoding'];

// ---------------------------------------------------------------------------
// The ceiling
// ---------------------------------------------------------------------------

/**
 * Resolve a configured ceiling, falling back to `run`.
 *
 * The fallback is the *narrowest* scope on purpose. The value this setting overrides is the
 * bundled SDK's hard-coded `session`, so "unparseable — keep what the SDK sent" would let a
 * typo silently reinstate the leak. `org` is unrecognised here for the same reason it is
 * absent from `CEILINGS`: a client that could name it could write a tenant-wide rule.
 *
 * @param {unknown} value
 * @returns {'run'|'session'|'global'}
 */
export function resolveCeiling(value) {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /** @type {any} */ (CEILINGS.includes(s) ? s : 'run');
}

/**
 * Where a scope sits on the lattice. An unrecognised string ranks above everything, so it
 * is clamped rather than trusted — the conservative direction for a value this code did not
 * write and does not understand.
 *
 * @param {unknown} scope
 * @returns {number}
 */
function rank(scope) {
  const i = LATTICE.indexOf(String(scope ?? '').trim().toLowerCase());
  return i < 0 ? Number.POSITIVE_INFINITY : i;
}

// ---------------------------------------------------------------------------
// The rewrite
// ---------------------------------------------------------------------------

/**
 * @typedef {object} GuardResult
 * @property {any} body     the body to send — the ORIGINAL reference when nothing moved
 * @property {boolean} changed
 * @property {any} note     the clamp note to attach to the response, or `null`
 */

/**
 * Clamp an ingest body to the ceiling and pin it to the derived run.
 *
 * Synchronous, pure, and inert on anything it does not understand: a body it cannot read is
 * returned **by identity**, not cloned, so a caller can tell "nothing to do" from "rewritten
 * to the same value" without comparing fields.
 *
 * Clamping is one-directional. A caller that narrows its own write keeps the narrower
 * scope — the ceiling is a maximum, not an assignment. The single exception is opt-in:
 * `sdkDefaultScope` names a value that is a build constant rather than a request (see
 * `SDK_DEFAULT_SCOPE`), and that one resolves to the ceiling in either direction. Left
 * unset — as every caller but `installFetchGuard` leaves it — this is a pure clamp.
 *
 * @param {any} body
 * @param {{ceiling: string, runId?: string, pinRun?: boolean, sdkDefaultScope?: string}} opts
 * @returns {GuardResult}
 */
export function guardIngest(body, opts) {
  const noop = { body, changed: false, note: null };
  try {
    const ceiling = resolveCeiling(opts?.ceiling);
    const ceilingRank = rank(ceiling);
    const runId = typeof opts?.runId === 'string' ? opts.runId : '';
    const pinRun = opts?.pinRun === true && runId !== '';
    const sdkDefault = typeof opts?.sdkDefaultScope === 'string' ? opts.sdkDefaultScope : '';

    if (!body || typeof body !== 'object' || Array.isArray(body)) return noop;

    // --- what would move, computed before anything is cloned ---------------
    const items = Array.isArray(body.items) ? body.items : [];
    /** @type {number[]} */
    const clamped = [];
    /** @type {string[]} */
    const requested = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item || typeof item !== 'object') continue;
      if (item.intent !== 'lesson') continue;
      // Only an item that already carries a scope is rewritten. Adding the field to one
      // that had none would be this guard inventing a value the server never received from
      // this caller — captures, traces and tool output are not lessons and carry no scope.
      if (typeof item.lesson_scope !== 'string') continue;
      // A build constant is not a request: it resolves to the ceiling. Anything else is a
      // real ask and is only ever narrowed. Either way the value written is the ceiling —
      // an item that would keep its own scope never reaches `clamped`.
      const asked = item.lesson_scope;
      const effective = sdkDefault !== '' && asked === sdkDefault ? ceiling : asked;
      const target = rank(effective) > ceilingRank ? ceiling : effective;
      if (target === asked) continue;
      clamped.push(i);
      if (!requested.includes(asked)) requested.push(asked);
    }

    const priorRun = typeof body.run_id === 'string' ? body.run_id : '';
    const movesRun = pinRun && body.run_id !== runId;

    if (!clamped.length && !movesRun) return noop;

    // --- only now is anything copied ---------------------------------------
    const next = { ...body };
    if (movesRun) next.run_id = runId;
    if (clamped.length) {
      next.items = items.slice();
      for (const i of clamped) next.items[i] = { ...items[i], lesson_scope: ceiling };
    }

    /** @type {Record<string, any>} */
    const note = { ceiling };
    if (clamped.length) {
      note.lesson_scope = {
        requested: requested.join(', '),
        written: ceiling,
        items: clamped.length,
      };
    }
    if (movesRun) note.run_id = { requested: priorRun, written: runId };
    note.raise_with = RAISE_WITH;

    return { body: next, changed: true, note };
  } catch {
    // A body shaped in a way this function did not anticipate is not a reason to fail
    // somebody else's write.
    return noop;
  }
}

// ---------------------------------------------------------------------------
// The fetch wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap `globalThis.fetch` so every ingest the bundled server sends is clamped on the way
 * out and annotated on the way back.
 *
 * Must be called **before** `await import('./server.js')`: the server captures its
 * transport at module scope, so a guard installed afterwards would never see a request —
 * the same ordering rule every `MUBIT_*` env var in the launcher obeys, for the same reason.
 *
 * Idempotent. Re-installing rewraps the original `fetch` rather than stacking a second
 * layer on top of the first, so a double call cannot double-annotate a response.
 *
 * @param {{ceiling: string, runId?: string, pinRun?: boolean}} opts
 * @returns {void}
 */
export function installFetchGuard(opts) {
  const ceiling = resolveCeiling(opts?.ceiling);
  const runId = typeof opts?.runId === 'string' ? opts.runId : '';
  const pinRun = opts?.pinRun === true;

  const current = /** @type {any} */ (globalThis.fetch);
  if (typeof current !== 'function') return;
  const base = typeof current.mubitEgressGuardOriginal === 'function'
    ? current.mubitEgressGuardOriginal
    : current;

  /**
   * @param {any} input
   * @param {any} [init]
   */
  const wrapped = async function fetch(input, init) {
    /** @type {any} */
    let note = null;
    /** @type {any} */
    let sendInit = init;

    try {
      if (isIngest(input, init)) {
        const parsed = parseBody(init);
        if (parsed.ok) {
          const out = guardIngest(parsed.value, {
            ceiling, runId, pinRun, sdkDefaultScope: SDK_DEFAULT_SCOPE,
          });
          if (out.changed) {
            sendInit = { ...init, body: JSON.stringify(out.body) };
            note = out.note;
          }
        }
      }
    } catch {
      // Anything unexpected about the request means it goes out exactly as the server
      // built it. A guard that could refuse a write is worse than the leak.
      note = null;
      sendInit = init;
    }

    const res = await base(input, sendInit);
    if (!note) return res;
    return annotate(res, note);
  };

  Object.defineProperty(wrapped, 'mubitEgressGuardOriginal', {
    value: base, writable: true, configurable: true, enumerable: false,
  });
  // The launch tests read this off `globalThis.fetch` from inside the stub server and
  // JSON-serialise it, so it stays plain data.
  wrapped.mubitEgressGuard = { ceiling, pinRun, runId };

  globalThis.fetch = /** @type {any} */ (wrapped);
}

/**
 * Is this the one request this guard is for? A `POST` whose pathname ends `/v2/control/ingest`
 * and nothing else — reads are the hot path and have no business here.
 *
 * The bundle's transport calls `fetch(url, init)` with a `URL` and a plain init; the
 * `Request`-object form is never used, and is deliberately not handled — an unrecognised
 * call shape passes straight through.
 *
 * @param {any} input
 * @param {any} init
 * @returns {boolean}
 */
function isIngest(input, init) {
  if (String(init?.method ?? 'GET').toUpperCase() !== 'POST') return false;
  if (typeof input !== 'string' && !(input instanceof URL)) return false;
  try {
    const { pathname } = input instanceof URL ? input : new URL(input);
    return pathname.replace(/\/+$/, '').endsWith(INGEST_PATH);
  } catch {
    return false;
  }
}

/**
 * @param {any} init
 * @returns {{ok: boolean, value?: any}}
 */
function parseBody(init) {
  if (typeof init?.body !== 'string') return { ok: false };
  try { return { ok: true, value: JSON.parse(init.body) }; } catch { return { ok: false }; }
}

/**
 * Attach the clamp note to an ingest response.
 *
 * Only an ok JSON response is touched. A failure is left strictly alone so the tool still
 * reports the server's own error rather than the guard's account of it, and a non-JSON body
 * is not something to append a key to.
 *
 * A body can only be read once, so the read happens on a `clone()`. That is the difference
 * between "the note could not be attached" and "the guard broke the write": a read that
 * fails part-way through leaves its own body unusable, and returning that consumed response
 * would make the transport's `response.json()` throw on a write the server had already
 * accepted. Cloning keeps the original pristine, so every failure here falls back to exactly
 * the response the server would have seen with no guard installed.
 *
 * @param {Response} res
 * @param {any} note
 * @returns {Promise<Response>}
 */
async function annotate(res, note) {
  try {
    if (!res.ok) return res;
    if (!String(res.headers.get('content-type') ?? '').includes('application/json')) return res;

    let raw;
    try { raw = await res.clone().text(); } catch { return res; }

    let payload = raw;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Spread first: the note rides alongside the real response, never instead of it,
        // and must not displace the job id the caller needs to follow the ingest.
        payload = JSON.stringify({ ...parsed, mubit_scope_guard: note });
      }
    } catch { /* not an object after all — hand back exactly what arrived */ }

    const headers = new Headers();
    res.headers.forEach((value, key) => {
      if (!RESHAPED_HEADERS.includes(key.toLowerCase())) headers.set(key, value);
    });
    return new Response(payload, { status: res.status, statusText: res.statusText, headers });
  } catch {
    return res;
  }
}
