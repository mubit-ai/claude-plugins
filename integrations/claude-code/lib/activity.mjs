// @ts-check
/**
 * `lib/activity.mjs` — the audit question: what does my instance actually hold, and can I
 * take the answer somewhere else.
 *
 * The route pair this module wraps has been reachable from the plugin for a while and was
 * only ever used sideways: `lib/dashboard-api.mjs`'s `fetchActivity()` calls
 * `/v2/control/activity` to join a `created_at` onto a lesson. The export route, the six
 * request fields that turn a feed into a query, and any surface outside the dashboard's
 * browser UI did not exist. This is that surface.
 *
 * ## A module-local route constant, not `lib/http.mjs`'s `ROUTES`
 *
 * `ROUTES` is the frozen table of routes that have a typed wrapper, a `capFor()` entry and a
 * hook caller. Export has none of the three: it is called from a CLI a person types, on a
 * deadline no hook shares, and nothing about it belongs on the path a prompt waits for.
 * `lib/dashboard-api.mjs` already set the precedent for the other kind with `EXTRA_ROUTES`,
 * and `test/dashboard-api.test.mjs` pins it.
 *
 * ## The listing is distrusted; the export is not
 *
 * This is the asymmetry the whole module is shaped around, and it is forced by the wire.
 *
 * `exclude_derived` and `projection` are the two request fields whose *purpose* is the
 * compliance answer. "I asked for non-derived entries" is a claim about a field in a request.
 * "These are the non-derived entries" is a claim about the bytes on screen. If an instance
 * ignores the flag and we print the result under an `--exclude-derived` heading, we have
 * manufactured a false audit artefact — precisely the failure this module exists to remove.
 * So both are re-applied here, client-side, and both corrections are reported:
 * `excludeDerivedFallbackUsed` and `projectionFallbackUsed` exist because "the server did not
 * honour this" is itself audit-relevant.
 *
 * `/v2/control/activity/export` takes neither field. `ExportActivityRequest` has exactly
 * seven — `run_id`, `user_id`, `agent_id`, `entry_types`, `created_after`, `created_before`,
 * `sort` — so there is nothing to distrust, and `content` is handed on **verbatim**: no
 * re-parse, no re-serialise, no added newline. A compliance artefact the client reshaped is
 * not a record of what the server holds.
 *
 * ## `{record: false}` on everything, at 20 s and 45 s
 *
 * `lib/http.mjs` tags an abort `abortedEarly` — and declines to record it — *only* when the
 * caller's deadline is tighter than the 4000 ms default. Both deadlines here are looser, so
 * without `{record: false}` a slow export records `not_responding`, and five of those inside
 * the breaker's window opens the circuit: recall stops and the capture drain stops, because
 * the user asked a question about their own data. The listing reuses the dashboard's
 * `READ_ONLY`; the export gets its own, longer one.
 *
 * ## No re-redaction
 *
 * The dashboard scrubs what it renders because putting text into a web page is a different
 * consent from sending it to your own instance. Here a person is asking their own instance,
 * in their own terminal, what it holds — re-redacting would defeat the only question being
 * asked. Errors are still `scrubKey`'d, because an upstream message can quote a request
 * header.
 *
 * ## Two facts about the route that decide the request shape
 *
 * **The export has no `limit`.** `lib/http.mjs` caps *requests*; `dial()` reads the whole
 * response text and parses it in one allocation. An empty `run_id` means "every run this key
 * can see", so run scope is the only bound the response body has — which is why a run id is
 * required here rather than defaulted.
 *
 * **`total_visible` is a filtered count, not a total.** The server counts the entries left
 * after its own filters and before paging, out of a pool it caps while collecting. It
 * therefore over-counts by exactly whatever our client-side re-filter dropped, which is why
 * `droppedDerived` is reported next to it: only both numbers together reconcile.
 *
 * Discipline shared with the rest of `lib/`: zero dependencies, Node >= 20 built-ins only,
 * and nothing here throws.
 */

import {
  EXTRA_ROUTES, READ_ONLY, fail, fetchActivity, mapError, ok, scrubKey,
} from './dashboard-api.mjs';
import { request } from './http.mjs';

/**
 * The one route with no wrapper anywhere else. See the module header for why it is not in
 * `lib/http.mjs`'s `ROUTES`; `EXTRA_ROUTES.activity` is imported rather than restated so the
 * listing path stays a single spelling across both files.
 */
export const ACTIVITY_ROUTES = Object.freeze({
  activity: EXTRA_ROUTES.activity,
  export: '/v2/control/activity/export',
});

/**
 * How long an export may take.
 *
 * A hook gets 4000 ms because it sits on a prompt's critical path. The dashboard gets 20 s
 * because a page is rendering. An export is a scan of every entry in a run, serialised into
 * one string, with no `limit` on the route to bound it — so it gets its own number, and that
 * number is longer than both. Nobody is blocked on it but the person who typed the command.
 */
export const EXPORT_TIMEOUT_MS = 45000;

/** @see the module header — an unrecorded call is what keeps an audit from opening the breaker. */
export const EXPORT_OPTS = Object.freeze({ record: false, timeoutMs: EXPORT_TIMEOUT_MS });

/** The only format the route emits, stated so a caller can notice when it did not. */
export const EXPORT_FORMAT = 'jsonl';

/**
 * The compact projection, as five keys in reading order.
 *
 * The server's own `compact` keeps all sixteen fields of `ActivityEntry` and only truncates
 * content and rewrites metadata — the right trade for a page render and the wrong one for a
 * listing read in a terminal. These five answer the audit question in full: what is it, when
 * did it arrive, which run wrote it, and what does it say. The other eleven are what `full`
 * and the export are for.
 */
export const COMPACT_KEYS = Object.freeze(['id', 'created_at', 'entry_type', 'run_id', 'content']);

/**
 * Where the server truncates, so a client truncation is the same bytes rather than a second,
 * differently-shaped one. The server appends `...` after 200 characters, making 203 the
 * longest a compacted row can be — which is also how "the server ignored `projection`" is
 * detected without guessing.
 */
export const COMPACT_CONTENT_CHARS = 200;

/** The server clamps `limit` into this range, and clamps a zero *up to one*, not to a default. */
export const PAGE_MIN = 1;
export const PAGE_MAX = 500;
export const PAGE_DEFAULT = 100;

/** Three independent bounds on a scan. Each one reports rather than trimming quietly. */
export const SCAN_MAX_ENTRIES = 5000;
export const SCAN_MAX_PAGES = 200;
export const SCAN_BUDGET_MS = 60000;

/**
 * The metadata keys that mean "the instance derived this, a client did not write it".
 *
 * The server's own `exclude_derived` checks two of them — `promotion` and `derived` — through
 * `as_bool()`, so a stringified boolean slips past it, and so does `auto_promoted`, which is
 * what recurrence promotion writes. Erring wide is the only safe direction: over-filtering
 * shows a caller fewer entries than exist, which they can see; under-filtering prints a
 * derived entry under a heading that says there are none, which they cannot.
 */
const DERIVED_KEYS = Object.freeze(['derived', 'promotion', 'promoted', 'auto_promoted']);

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * `POST /v2/control/activity/export`.
 *
 * The response is `{format, content, entry_count}` and `content` is JSONL: one serialised
 * `ActivityEntry` per line, joined with `\n` and with no trailing newline. It crosses this
 * function untouched.
 *
 * A zero-byte export is the one answer that must never be reported as success. "Your instance
 * holds nothing for this run" and "the export route answered with a field we could not read"
 * are the same empty file on disk and completely different facts, so an absent, empty or
 * non-string `content` is a failure with a message that says which.
 *
 * @param {Record<string, any>} cfg
 * @param {{run?: string, entryTypes?: string[], createdAfter?: string, createdBefore?: string,
 *          userId?: string, agentId?: string, sort?: string}} [params]
 * @returns {Promise<Record<string, any>>}
 */
export async function exportActivity(cfg, params = {}) {
  const p = obj(params);
  const run = str(p.run);
  if (!run) {
    return fail(400, 'bad_request',
      'export requires a run id: the route takes no limit, and an empty run_id means every run '
      + 'this key can see — which is an unbounded response read into one string');
  }

  const req = {
    run_id: run,
    // Not a field of `ExportActivityRequest`, and deliberately sent anyway: it is the format
    // this caller will accept, and the response's own `format` is checked against it below.
    // Everything the route genuinely cannot honour is absent instead — see `dropped` below.
    format: EXPORT_FORMAT,
    // Chronological. The offset-drift argument that forces `asc` on a scan does not apply to
    // a single request, but a record of what happened reads in the order it happened.
    sort: str(p.sort) === 'desc' ? 'desc' : 'asc',
  };
  if (Array.isArray(p.entryTypes) && p.entryTypes.length) req.entry_types = p.entryTypes.map(String);
  if (str(p.createdAfter)) req.created_after = str(p.createdAfter);
  if (str(p.createdBefore)) req.created_before = str(p.createdBefore);
  if (str(p.userId)) req.user_id = str(p.userId);
  if (str(p.agentId)) req.agent_id = str(p.agentId);

  // `exclude_derived`, `projection`, `limit` and `page_token` are NOT sent. The handler
  // deserialises with serde's default, which drops unknown keys without complaint — so a
  // request carrying `exclude_derived` is a client believing it filtered, and believing it
  // silently. That is the whole failure mode this module was written against.

  const res = await request(cfg, 'POST', ACTIVITY_ROUTES.export, req, EXPORT_OPTS);
  if (!res.ok) return mapError(cfg, res);

  const body = obj(res.body);
  const content = body.content;
  if (typeof content !== 'string') {
    return fail(503, 'upstream_unreachable',
      `the export route answered with no usable content (got ${describe(content)}); `
      + 'an empty file is not the same fact as an empty instance');
  }
  if (content === '') {
    return fail(503, 'upstream_unreachable',
      'the export route answered with empty content; refusing to report a zero-byte export as '
      + 'success, because "nothing is stored" and "nothing came back" are different answers');
  }

  return ok({
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
    // What the instance said it produced, next to what we asked for. An instance answering
    // `csv` has not produced the JSONL the caller is about to parse, and that should be
    // visible rather than inferred from a parse failure three steps later.
    format: String(body.format || ''),
    requestedFormat: EXPORT_FORMAT,
    entryCount: Number(body.entry_count) || 0,
    // Line count of what actually arrived, so a caller can reconcile it against the count the
    // server reported without re-splitting the payload themselves.
    lines: content.split('\n').length,
    run,
  });
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * One page of `POST /v2/control/activity`, re-filtered and re-projected.
 *
 * `sort` defaults to `desc`: a single page is what somebody means by "what just happened",
 * and that is the newest end. A scan does the opposite, for a reason `scanActivity` explains.
 *
 * A run id is required unless `allRuns` is passed. An instance-wide listing is a different
 * question from "what does this run hold", and it should be asked out loud rather than
 * reached by omission.
 *
 * @param {Record<string, any>} cfg
 * @param {{run?: string, allRuns?: boolean, limit?: number, pageToken?: string,
 *          entryTypes?: string[], createdAfter?: string, createdBefore?: string,
 *          userId?: string, agentId?: string, excludeDerived?: boolean,
 *          projection?: string, sort?: string}} [params]
 * @returns {Promise<Record<string, any>>}
 */
export async function listActivity(cfg, params = {}) {
  const p = obj(params);
  const run = str(p.run);
  if (!run && p.allRuns !== true) {
    return fail(400, 'bad_request',
      'activity requires a run id; pass allRuns to list across every run this key can see');
  }

  const res = await fetchActivity(cfg, {
    run,
    limit: clamp(p.limit, PAGE_MIN, PAGE_MAX, PAGE_DEFAULT),
    pageToken: str(p.pageToken),
    sort: str(p.sort) === 'asc' ? 'asc' : 'desc',
    projection: str(p.projection) === 'full' ? 'full' : 'compact',
    entryTypes: Array.isArray(p.entryTypes) ? p.entryTypes : undefined,
    excludeDerived: p.excludeDerived === true,
    createdAfter: str(p.createdAfter),
    createdBefore: str(p.createdBefore),
    userId: str(p.userId),
    agentId: str(p.agentId),
  });
  if (!res.ok) return res;

  const corrected = correct(res.data.entries, {
    excludeDerived: p.excludeDerived === true,
    compact: str(p.projection) !== 'full',
  });

  return ok({
    ...corrected,
    nextPageToken: res.data.nextPageToken,
    // The server's count, over the server's filtering, before paging. It over-counts by
    // `droppedDerived` whenever the re-filter had to do work.
    totalVisible: res.data.totalVisible,
  });
}

/**
 * Every page matching a query, oldest first.
 *
 * **A scan sorts ascending and a listing does not**, because pagination here is offset-style:
 * the token is a numeric offset into a set the server re-derives on every request. Under
 * `desc`, a write landing mid-scan shifts every later offset by one — the next page re-reads a
 * row already read, and the row pushed past the boundary is never read at all. Under `asc` new
 * rows arrive past the offsets already consumed, and a scan can only ever miss what was
 * written after it started.
 *
 * Three bounds, and each one *reports*: a short answer that says it is short is usable, and a
 * short answer that looks complete is the false artefact again. The page-token guard is the
 * fourth and is not a bound but a liveness check — an instance whose `next_page_token` never
 * advances would otherwise turn this into an infinite request loop against the user's own
 * server.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} [params] as `listActivity`, plus
 *   `{maxEntries, maxPages, budgetMs}`
 * @returns {Promise<Record<string, any>>}
 */
export async function scanActivity(cfg, params = {}) {
  const p = obj(params);
  const maxEntries = clamp(p.maxEntries, 1, 1_000_000, SCAN_MAX_ENTRIES);
  const maxPages = clamp(p.maxPages, 1, 10_000, SCAN_MAX_PAGES);
  const budgetMs = clamp(p.budgetMs, 1, 3_600_000, SCAN_BUDGET_MS);
  const started = Date.now();

  /** @type {any[]} */
  const entries = [];
  /** @type {Set<string>} */
  const seen = new Set();
  let token = str(p.pageToken);
  let pages = 0;
  let totalVisible = 0;
  let droppedDerived = 0;
  let excludeDerivedFallbackUsed = false;
  let projectionFallbackUsed = false;
  let truncated = false;
  let truncatedReason = '';

  for (;;) {
    if (seen.has(token)) { truncated = true; truncatedReason = 'page_token_repeated'; break; }
    seen.add(token);

    const page = await listActivity(cfg, { ...p, pageToken: token, sort: 'asc' });
    // A page lost in the middle means the scan did not see everything. Returning what did
    // arrive, shaped like a completed scan, is how a partial answer becomes a complete-looking
    // one — which is the same lie as an unhonoured filter, told by omission.
    if (!page.ok) return page;

    pages += 1;
    entries.push(...page.data.entries);
    totalVisible = page.data.totalVisible;
    droppedDerived += page.data.droppedDerived;
    excludeDerivedFallbackUsed = excludeDerivedFallbackUsed || page.data.excludeDerivedFallbackUsed;
    projectionFallbackUsed = projectionFallbackUsed || page.data.projectionFallbackUsed;

    if (entries.length >= maxEntries) { truncated = true; truncatedReason = 'max_entries'; break; }
    if (Date.now() - started >= budgetMs) { truncated = true; truncatedReason = 'budget'; break; }
    if (pages >= maxPages) { truncated = true; truncatedReason = 'max_pages'; break; }

    token = page.data.nextPageToken;
    if (!token) break;
  }

  return ok({
    entries,
    pages,
    totalVisible,
    droppedDerived,
    excludeDerivedFallbackUsed,
    projectionFallbackUsed,
    truncated,
    truncatedReason,
    elapsedMs: Date.now() - started,
    nextPageToken: truncated ? token : '',
  });
}

// ---------------------------------------------------------------------------
// Derived detection and the compact shape
// ---------------------------------------------------------------------------

/**
 * Whether an entry is something the instance derived rather than something a client wrote.
 *
 * Wider than the server's own test by design — see `DERIVED_KEYS`. The flag is looked for both
 * inside `metadata_json` and on the entry itself, because a shared helper is reached by
 * callers who have already parsed the one and by wire shapes that carry the other.
 *
 * Never throws: this runs once per entry over an export-sized listing.
 *
 * @param {any} entry
 * @returns {boolean}
 */
export function isDerived(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  for (const key of DERIVED_KEYS) {
    if (truthy(/** @type {any} */ (entry)[key])) return true;
  }
  const meta = parseMetadata(/** @type {any} */ (entry).metadata_json ?? /** @type {any} */ (entry).metadata);
  if (!meta) return false;
  for (const key of DERIVED_KEYS) {
    if (truthy(meta[key])) return true;
  }
  return false;
}

/**
 * One entry, as the five keys in `COMPACT_KEYS`.
 *
 * A missing field becomes an empty string rather than an absent key: this is written out as
 * JSONL, and a stream whose rows have different keys is not a table.
 *
 * @param {any} entry
 * @returns {Record<string, string>}
 */
export function compactEntry(entry) {
  const e = (entry && typeof entry === 'object' && !Array.isArray(entry)) ? entry : {};
  const content = e.content === undefined || e.content === null ? '' : String(e.content);
  return {
    id: plain(e.id),
    created_at: plain(e.created_at),
    entry_type: plain(e.entry_type),
    run_id: plain(e.run_id),
    content: content.length > COMPACT_CONTENT_CHARS
      ? `${content.slice(0, COMPACT_CONTENT_CHARS)}...`
      : content,
  };
}

/**
 * Apply both client-side corrections to one page, and report which of them had to do work.
 *
 * The projection check is structural rather than a guess: a server-compacted row is at most
 * `COMPACT_CONTENT_CHARS + 3` characters, so anything longer is proof the flag did not take
 * effect. The derived check is simply "did anything survive the server's filter that should
 * not have".
 *
 * @param {any[]} raw
 * @param {{excludeDerived: boolean, compact: boolean}} o
 */
function correct(raw, o) {
  let entries = Array.isArray(raw) ? raw : [];
  let droppedDerived = 0;

  if (o.excludeDerived) {
    const kept = entries.filter((e) => !isDerived(e));
    droppedDerived = entries.length - kept.length;
    entries = kept;
  }

  let projectionFallbackUsed = false;
  if (o.compact) {
    projectionFallbackUsed = entries.some((e) => {
      const c = e && typeof e === 'object' ? e.content : '';
      return typeof c === 'string' && c.length > COMPACT_CONTENT_CHARS + 3;
    });
    entries = entries.map(compactEntry);
  }

  return {
    entries,
    droppedDerived,
    excludeDerivedFallbackUsed: droppedDerived > 0,
    projectionFallbackUsed,
  };
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/**
 * `metadata_json`, whatever shape it arrived in.
 *
 * The proto declares it a `string`, so on the wire it is JSON in a string. Callers that have
 * already parsed it hand over an object, and instances that round-trip it through a second
 * encoder hand over a JSON string whose contents are themselves JSON. Two unwraps cover all
 * three; the bound is fixed rather than a loop so a pathological value cannot spin.
 *
 * @param {any} raw
 * @returns {Record<string, any>|null}
 */
function parseMetadata(raw) {
  let v = raw;
  for (let i = 0; i < 2; i += 1) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v !== 'string' || !v.trim()) return null;
    try { v = JSON.parse(v); } catch { return null; }
  }
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
}

/**
 * The truth values a flag arrives as. A JSON boolean is what the server writes; the string
 * spellings are what a metadata writer that stringified its booleans produces, and the server
 * misses those because `as_bool()` rejects them.
 * @param {any} v
 */
function truthy(v) {
  if (v === true) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  return false;
}

/** @param {any} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** Untrimmed: a listing shows what is stored, and trailing space is part of what is stored. */
function plain(v) {
  return v === undefined || v === null ? '' : String(v);
}

/** @param {any} v */
function obj(v) {
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

/** @param {any} v @param {number} lo @param {number} hi @param {number} dflt */
function clamp(v, lo, hi, dflt) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

/** A type name for an error message, without putting the value itself into one. */
function describe(v) {
  if (v === undefined) return 'no field at all';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `a ${typeof v}`;
}

/**
 * Re-exported so a caller that only needs to scrub one string does not have to know that the
 * dashboard owns the implementation. Nothing here returns `cfg`, and every message crossing
 * the boundary has already been through it.
 */
export { scrubKey, READ_ONLY };
