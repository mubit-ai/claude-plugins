// @ts-check
/**
 * `mcp/src/egress.mjs` — the egress stage on the MCP write path (§8.3).
 *
 * Every other outbound call this plugin makes goes through `lib/http.mjs`, which checks the
 * run id (§4.3) and scrubs the body first (§7). The MCP server is the one exception: it is a
 * vendored bundle that dials the endpoint itself, so nothing in this repo ever saw the
 * request. Three things about an MCP call were therefore outside this plugin's control.
 *
 *   1. **Scope.** `mubit_learned` is the only lesson-writing tool a default install exposes,
 *      and the bundled SDK stamps a fixed `lesson_scope` on it regardless of the caller. The
 *      plugin promises that an agent-written lesson stays in the run that wrote it unless a
 *      user says otherwise, and a constant baked into a build is not a promise this repo can
 *      keep on its own.
 *
 *   2. **The run id on a write.** Every write tool takes an optional `session_id`, so without
 *      a guard the run a write lands in is whatever the caller passed rather than the one the
 *      launcher derived — and an MCP write would stop matching the hook captures beside it.
 *
 *   3. **The run id on a catalogue read.** `mubit_lessons` is the one read tool that resolves
 *      no default for the same optional argument, so with it absent the bundle sends
 *      `run_id: ""`. The transport backfills that field only when it is `== null`, and `?? ""`
 *      is precisely the spelling that defeats it — so the value goes out empty, which is the
 *      request that asks for every run the key can see rather than the one the model is
 *      working in. Filling the field is the whole of the fix; answering the question better
 *      is the rest of it.
 *
 * **Why here and not where the constant is.** It lives inside a vendored bundle whose source
 * is not in this repo; hand-editing a build artefact would be discarded by the first real
 * rebuild. The seam is the launcher: it is real source this repo owns, it runs to completion
 * in the same process *before* it imports the server, and the server's transport dials with
 * global `fetch`. So the launcher installs a guard on `globalThis.fetch` and the vendored
 * bundle stays untouched.
 *
 * The same seam carries the correction back: an extra key on the ingest **response** survives
 * the bundle's own response handling and reaches the tool result the model reads.
 *
 * **The one rule.** This code sits in the request path of every call the server makes,
 * including shapes it has never seen. It must never be able to fail a write: every branch
 * falls through to the untouched original request or response on any surprise.
 *
 * The read path has a second rule on top of it. **Failure there is narrow, not wide**: a
 * catalogue this file could not assemble falls back to the *pinned* request, never to the one
 * the bundle built. Failing open would restore the wide read at exactly the moment nobody can
 * see that it happened.
 */

import { lessonCensus } from '../../lib/activity.mjs';
import { readMarker, updateMarker } from '../../lib/markers.mjs';

/**
 * The scope lattice, widest last. Every step up this list is a step out of the run that wrote
 * the lesson.
 *
 * The widest scope is here to be clamped, never to be chosen: it is not a value a client sets
 * for itself, so it is absent from `CEILINGS` below.
 */
const LATTICE = ['run', 'session', 'global', 'org'];

/** What a user may set the ceiling to — the three the control plane accepts from a client. */
const CEILINGS = ['run', 'session', 'global'];

/** The route a lesson leaves by. Matched on the pathname only; the host is the user's. */
const INGEST_PATH = '/v2/control/ingest';

/**
 * The route a lesson catalogue is asked for by.
 *
 * `mubit_forget` posts one path segment further along, and matching that would answer a
 * deletion out of a cached listing and silently drop it. The trailing-slash strip below is
 * what keeps the two apart under every spelling; `test/mcp-lessons.test.mjs` pins it.
 */
const LESSONS_PATH = '/v2/control/lessons';

/** What the bundle asks for when the caller names no limit. Used only when the body omits one. */
const LESSONS_DEFAULT_LIMIT = 20;

/** The most rows a synthesized catalogue will render, whatever the body asked for. */
const LESSONS_MAX_LIMIT = 200;

/**
 * How long one assembled catalogue answers for.
 *
 * Re-entrancy is structurally impossible today — the census dials a different route from the
 * one being answered — but a model that lists twice in a row should not pay twice, and the
 * in-flight promise beside this makes a burst cost one census rather than N.
 */
const CENSUS_TTL_MS = 5000;

/** The key the catalogue note rides back under, beside `lessons`. */
const LESSONS_NOTE_KEY = 'mubit_lessons_guard';

/** The key the write-side clamp note rides back under. */
const INGEST_NOTE_KEY = 'mubit_scope_guard';

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
 * typo silently widen every write. The widest scope is unrecognised here for the same reason
 * it is absent from `CEILINGS`: it is not a value a client sets for itself.
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
// The catalogue read
// ---------------------------------------------------------------------------

/**
 * Fill in the run id on a catalogue read that named none.
 *
 * Layer one of two, and the one that works everywhere: pure, synchronous, no network, and
 * enough on its own to make every path narrow rather than wide.
 *
 * A caller that asked for a scope wider than its own run is left alone. `scope` is the only
 * field on this frozen schema that can express "yes, I mean across runs", so pinning a request
 * carrying one would answer a different question from the one that was asked — and answering
 * a different question quietly is the failure this whole file is about.
 *
 * @param {any} body
 * @param {{runId?: string, pinRun?: boolean}} opts
 * @returns {GuardResult}
 */
export function guardLessonsRead(body, opts) {
  const noop = { body, changed: false, note: null };
  try {
    const runId = typeof opts?.runId === 'string' ? opts.runId : '';
    if (opts?.pinRun !== true || runId === '') return noop;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return noop;
    if (readRunId(body) !== '') return noop;
    if (isCrossRunAsk(readScope(body))) return noop;

    return { body: { ...body, run_id: runId }, changed: true, note: null };
  } catch {
    return noop;
  }
}

/**
 * Is this the catalogue read? A `POST` whose pathname ends `/v2/control/lessons`.
 *
 * Deliberately not the delete route one segment further along: that is what `mubit_forget`
 * posts to, and a listing answered in its place would look like a successful deletion that
 * removed nothing.
 *
 * @param {any} input
 * @param {any} init
 * @returns {boolean}
 */
export function isLessonsRead(input, init) {
  if (String(init?.method ?? 'GET').toUpperCase() !== 'POST') return false;
  if (typeof input !== 'string' && !(input instanceof URL)) return false;
  try {
    const { pathname } = input instanceof URL ? input : new URL(input);
    return pathname.replace(/\/+$/, '').endsWith(LESSONS_PATH);
  } catch {
    return false;
  }
}

/** The `run_id` a request body carries, as a string. @param {any} body */
function readRunId(body) {
  return typeof body?.run_id === 'string' ? body.run_id.trim() : '';
}

/** The `scope` a request body carries, normalised. @param {any} body */
function readScope(body) {
  return typeof body?.scope === 'string' ? body.scope.trim().toLowerCase() : '';
}

/** How many rows to render. @param {any} body */
function readLimit(body) {
  const n = Number(body?.limit);
  if (!Number.isFinite(n) || n <= 0) return LESSONS_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), LESSONS_MAX_LIMIT);
}

/** A scope that only means anything across runs. @param {string} scope */
function isCrossRunAsk(scope) {
  return scope === 'session' || scope === 'global';
}

/**
 * Which rows a caller asked for, in the order the filters have to run.
 *
 * **Limit is applied last, by the caller of this function**, and that ordering is the entire
 * point of assembling a catalogue rather than forwarding the request. Asking the catalogue
 * route for a handful of rows at a named scope comes back empty against a real instance, and
 * an empty answer reads exactly like a memory that has never learned anything.
 *
 * `mine` is a union because the run id is spelled two ways across the two routes the plugin
 * reads lessons from: bare on one, namespaced inside the metadata on the other. Either half
 * on its own drops rows the caller wrote itself.
 *
 * @param {Record<string, any>[]} rows normalised census rows
 * @param {{runId: string, scope: string}} o
 * @returns {Record<string, any>[]}
 */
export function selectLessons(rows, o) {
  const mine = (r) => (o.runId !== '' && (r.runId === o.runId || r.sourceRunId === o.runId));

  // No scope named: this run, plus every lesson that was deliberately widened past its own.
  // The second half is not a leak being tolerated — travelling is what those lessons are for.
  if (o.scope === '') return rows.filter((r) => mine(r) || r.scope !== 'run');
  if (o.scope === 'run') return rows.filter(mine);
  return rows.filter((r) => r.scope === o.scope);
}

/**
 * One census row as the ten keys a lessons answer carries on the wire.
 *
 * `entry_type` and `reference_id` are deliberately absent. The bundle's response handling
 * reads those two as evidence markers and, when either is present, drops `id` and `source`
 * back out of the row on the way to the model — so a row that named itself an entry would
 * arrive without the id needed to pass it to `mubit_forget`.
 *
 * @param {Record<string, any>} r
 */
export function wireLesson(r) {
  return {
    id: r.id,
    lesson_id: r.id,
    content: r.content,
    lesson_type: r.lessonType,
    scope: r.scope,
    importance: r.importance,
    conditions: r.conditions,
    rationale: r.rationale,
    source_run_id: r.sourceRunId,
    source: r.source,
  };
}

/** What the default read is showing, said in the answer rather than left to be inferred. */
export const SHOWING = {
  '': 'this run, plus every lesson stored at a scope that reaches past the run that wrote it',
  run: 'this run only',
  session: 'lessons stored at session scope, across every run this key can see',
  global: 'lessons stored at global scope, across every run this key can see',
};

/**
 * The catalogue, as the body the tool result will carry.
 *
 * A truncated census reports **no total**. A count printed beside an admission that the
 * listing is partial is the number someone acts on, and it is the one number this cannot
 * stand behind.
 *
 * @param {Record<string, any>} data a `lessonCensus` payload
 * @param {{runId: string, scope: string, limit: number}} o
 */
function catalogue(data, o) {
  const rows = Array.isArray(data?.lessons) ? data.lessons : [];
  const matched = selectLessons(rows, o);
  const shown = matched.slice(0, o.limit);

  /** @type {Record<string, any>} */
  const note = {
    run_id: o.runId,
    showing: SHOWING[o.scope] ?? SHOWING[''],
    shown: shown.length,
  };
  if (data?.truncated) {
    note.partial = true;
    note.note = 'This catalogue is partial: the listing was cut short '
      + `(${String(data.truncatedReason || 'bound reached')}), so these are some of the lessons `
      + 'that matched and not all of them. No total is available. Narrow the request with '
      + '`scope`, or read the full listing with `/mubit-memory:remember`.';
  } else {
    note.matched = matched.length;
    if (matched.length > shown.length) {
      note.note = `${matched.length} lessons matched; the newest ${shown.length} are shown. `
        + 'Raise `limit` to see more.';
    }
  }

  return { lessons: shown.map(wireLesson), [LESSONS_NOTE_KEY]: note };
}

/**
 * The note that rides back when the catalogue could not be assembled and the request went to
 * the wire instead. Says which of the two fallbacks was taken, because they answer different
 * questions.
 *
 * @param {string} scope
 * @param {boolean} pinned
 */
function degradedNote(scope, pinned) {
  return {
    source: 'lessons-route',
    degraded: true,
    note: pinned
      ? 'The full catalogue could not be assembled, so this is the narrower answer: lessons '
        + 'stored against this run. Lessons widened by other runs are not included.'
      : `The full catalogue could not be assembled, so the request for scope "${scope}" went `
        + 'out as asked. These rows may come from any run this key can see, and the listing '
        + 'may be short of what is stored.',
  };
}

/**
 * One census per burst.
 *
 * Returns `null` when there is no config to dial with, which is what leaves an unconfigured
 * install on layer one alone rather than on nothing at all.
 *
 * @param {Record<string, any>|undefined} cfg
 * @returns {(() => Promise<any>)|null}
 */
function censusOnce(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;

  /** @type {Promise<any>|null} */
  let inflight = null;
  /** @type {{at: number, res: any}|null} */
  let cached = null;

  return function census() {
    const now = Date.now();
    if (cached && now - cached.at < CENSUS_TTL_MS) return Promise.resolve(cached.res);
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        // No `run`, which is what makes this instance-wide, and no breaker bookkeeping:
        // `lessonCensus` reads on the read-only options, so a feed that is down cannot
        // close the circuit on the hooks running beside this process.
        const res = await lessonCensus(cfg, {});
        cached = { at: Date.now(), res };
        return res;
      } catch (err) {
        cached = { at: Date.now(), res: { ok: false, message: String(err) } };
        return cached.res;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

// ---------------------------------------------------------------------------
// Telling the hooks what the MCP server sent
// ---------------------------------------------------------------------------

/**
 * Record an accepted MCP write against the run, in the file the hooks already read.
 *
 * The two write paths do not meet anywhere else. A hook capture goes through the spool and
 * the drain, which stamp the run marker on the way; an MCP write leaves this process and
 * touches neither. So `session-end` — deciding whether there is anything to reflect over —
 * could see a session whose whole memory contribution was `mubit_learned` and correctly
 * conclude, from the only evidence it had, that nothing had been ingested. It then skipped
 * reflect, which is the one call authorised to widen a lesson past the run that wrote it.
 *
 * Local, synchronous and best-effort, exactly like every other marker write: a failure here
 * costs a reflect, never the write that just succeeded.
 *
 * @param {Record<string, any>|undefined} cfg
 * @param {string} runId
 * @param {number} items
 */
function recordMcpIngest(cfg, runId, items) {
  try {
    if (!cfg || !runId || items <= 0) return;
    const prior = Number(readMarker(cfg, runId)?.mcp?.ingested);
    updateMarker(cfg, runId, {
      mcp: { ingested: (Number.isFinite(prior) ? prior : 0) + items, at: Date.now() },
    });
  } catch { /* a lost marker write is not a reason to fail a write that landed */ }
}

/** How many items a body carries, for the count above. @param {any} body */
function countItems(body) {
  return Array.isArray(body?.items) ? body.items.length : 0;
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
 * `cfg` is what lets a catalogue read be answered from the activity feed instead of
 * forwarded. Without it the read path degrades to the pin alone — still narrow, just less
 * complete — which is what an install that could not resolve its configuration should get.
 *
 * @param {{ceiling: string, runId?: string, pinRun?: boolean, cfg?: Record<string, any>}} opts
 * @returns {void}
 */
export function installFetchGuard(opts) {
  const ceiling = resolveCeiling(opts?.ceiling);
  const runId = typeof opts?.runId === 'string' ? opts.runId : '';
  const pinRun = opts?.pinRun === true;
  const census = censusOnce(opts?.cfg);

  const current = /** @type {any} */ (globalThis.fetch);
  if (typeof current !== 'function') return;
  const base = typeof current.mubitEgressGuardOriginal === 'function'
    ? current.mubitEgressGuardOriginal
    : current;

  /**
   * Decide what to do with a catalogue read, without dialling anything the caller has to
   * undo. Either the answer is assembled here, or the request goes out — once, below.
   *
   * @param {any} init
   * @returns {Promise<{answer?: any, init?: any, note?: any}>}
   */
  const planLessons = async (init) => {
    const parsed = parseBody(init);
    if (!parsed.ok) return {};

    const body = parsed.value;
    const scope = readScope(body);
    // A caller that named a run has asked a question the route already answers correctly.
    if (readRunId(body) !== '') return {};

    const pinned = guardLessonsRead(body, { runId, pinRun });
    const send = pinned.changed ? { ...init, body: JSON.stringify(pinned.body) } : undefined;

    if (!census) return { init: send };

    const res = await census();
    if (res?.ok) {
      return { answer: catalogue(res.data, { runId, scope, limit: readLimit(body) }) };
    }

    // Narrow, not wide. The one exception is a deliberate cross-run ask: pinning that would
    // answer a different question, and doing so silently is the dishonest direction.
    return isCrossRunAsk(scope)
      ? { note: degradedNote(scope, false) }
      : { init: send, note: degradedNote(scope, pinned.changed) };
  };

  /**
   * @param {any} input
   * @param {any} [init]
   */
  const wrapped = async function fetch(input, init) {
    /** @type {any} */
    let note = null;
    /** @type {string} */
    let noteKey = INGEST_NOTE_KEY;
    /** @type {any} */
    let sendInit = init;
    // Set on an ingest, and read after the response: what to credit the run with if the
    // write is accepted. Computed here because this is the only place the body is parsed.
    let ingestedItems = 0;
    let ingestedRun = '';

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
          ingestedItems = countItems(out.body);
          // The run the write actually goes to, which is the pinned one under `pinRun` and
          // the caller's otherwise — the marker has to name the run the hooks will look in.
          ingestedRun = typeof out.body?.run_id === 'string' ? out.body.run_id : '';
        }
      } else if (isLessonsRead(input, init)) {
        const plan = await planLessons(init);
        if (plan.answer) return jsonResponse(plan.answer);
        if (plan.init) sendInit = plan.init;
        if (plan.note) { note = plan.note; noteKey = LESSONS_NOTE_KEY; }
      }
    } catch {
      // Anything unexpected about the request means it goes out exactly as the server
      // built it. A guard that could refuse a write is worse than the leak.
      note = null;
      noteKey = INGEST_NOTE_KEY;
      sendInit = init;
    }

    const res = await base(input, sendInit);
    if (res?.ok && ingestedItems > 0) recordMcpIngest(opts?.cfg, ingestedRun, ingestedItems);
    if (!note) return res;
    return annotate(res, note, noteKey);
  };

  Object.defineProperty(wrapped, 'mubitEgressGuardOriginal', {
    value: base, writable: true, configurable: true, enumerable: false,
  });
  // The launch tests read this off `globalThis.fetch` from inside the stub server and
  // JSON-serialise it, so it stays plain data.
  wrapped.mubitEgressGuard = { ceiling, pinRun, runId, census: census !== null };

  globalThis.fetch = /** @type {any} */ (wrapped);
}

/**
 * A synthesized answer, shaped so the bundle's own response handling reads it exactly as it
 * would read the endpoint's.
 * @param {any} payload
 * @returns {Response}
 */
function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
  });
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
 * Attach a note to a response, under `key`.
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
 * @param {string} key
 * @returns {Promise<Response>}
 */
async function annotate(res, note, key) {
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
        payload = JSON.stringify({ ...parsed, [key]: note });
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
