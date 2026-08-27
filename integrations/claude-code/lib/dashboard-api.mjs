// @ts-check
/**
 * `lib/dashboard-api.mjs` — the upstream half of `/mubit-memory:dashboard`.
 *
 * Every call the dashboard makes to a Mubit instance goes through here, and three rules hold
 * across all of them.
 *
 * **`{ record: false }` on every request.** The dashboard is an observer. `lib/http.mjs`
 * settles each call into the circuit breaker by default, so a page polling every fifteen
 * seconds against an instance that is down would open the breaker for the *hooks* — recall
 * would stop, the drain would stop, and the status line would blame a server the user was
 * merely looking at. `READ_ONLY` suppresses that bookkeeping. It does not suppress
 * `allowRequest`'s half-open probe write, which cannot be suppressed from out here: with the
 * breaker already open, a poll still stamps `probeAt`. That is one field, and the alternative
 * is not calling the instance at all.
 *
 * **The key never leaves the server process.** Nothing here returns `cfg`, and every string
 * that reaches a caller passes through `scrubKey`, because an upstream error message can
 * quote the request that produced it.
 *
 * **A failed upstream is a rendered banner, not a blank page.** Every function returns the
 * same envelope — `{ok: true, data}` or `{ok: false, status, code, message}` — so a caller
 * can map one shape onto an HTTP response and the page can keep showing the local tabs.
 *
 * Four routes here have no named helper in `lib/http.mjs`'s `ROUTES` and are called through
 * the generic `request()`: activity, memory_health, archive and lessons/delete.
 */

import { postLessons, postOutcome, postQuery, request } from './http.mjs';

/**
 * How long a dashboard call may wait.
 *
 * `lib/http.mjs` defaults to 4000 ms, and that number is right for a hook: it sits on a
 * prompt's critical path, and a memory layer has no business making somebody wait. Nothing
 * here is on that path — a person is looking at a page — and the activity listing in
 * particular is a scan that routinely runs past four seconds on a run with real history.
 * Inheriting the hook's deadline turns "your instance is a bit busy" into a red banner saying
 * it is unreachable, which is both wrong and the sort of wrong that gets a plugin uninstalled.
 */
export const TIMEOUT_MS = 20000;

/**
 * The one options object every upstream call is made with.
 * @see the module header for why this is not negotiable.
 */
export const READ_ONLY = Object.freeze({ record: false, timeoutMs: TIMEOUT_MS });

/** Routes with no named helper upstream. */
export const EXTRA_ROUTES = Object.freeze({
  activity: '/v2/control/activity',
  memoryHealth: '/v2/control/memory_health',
  archive: '/v2/control/archive',
  deleteLesson: '/v2/control/lessons/delete',
  runs: '/v2/control/runs',
});

/**
 * What a lesson's scope is when its metadata does not say.
 *
 * `run` is what such a lesson reads as everywhere else it is asked for, so rendering an empty
 * string here would make the page disagree with every other view of the same entry — and worse,
 * an empty scope belongs to neither side of the leak filter, so the row vanishes from a tab
 * whose job is showing every lesson exactly once.
 */
const DEFAULT_SCOPE = 'run';

/** The `env_tags` prefix that names a project. Untagged means unconfined, not local. */
const REPO_TAG = 'repo:';

/**
 * The error vocabulary the page renders from. `unauthorized` and `not_found` belong to the
 * dashboard's own server; the rest describe the instance behind it.
 */
export const ERROR_CODES = Object.freeze([
  'unauthorized', 'not_found', 'upstream_unreachable', 'auth_failed', 'bad_request',
]);

/** Upstream `FailState` -> the code and status the page sees. */
const STATE_MAP = Object.freeze({
  auth_failed: { status: 502, code: 'auth_failed' },
  invalid_request: { status: 400, code: 'bad_request' },
  unconfigured: { status: 503, code: 'upstream_unreachable' },
  unreachable: { status: 503, code: 'upstream_unreachable' },
  not_responding: { status: 503, code: 'upstream_unreachable' },
  server_error: { status: 503, code: 'upstream_unreachable' },
});

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/** @param {any} data @returns {{ok: true, status: number, data: any}} */
export function ok(data) {
  return { ok: true, status: 200, data };
}

/**
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @returns {{ok: false, status: number, code: string, message: string}}
 */
export function fail(status, code, message) {
  return { ok: false, status, code, message: String(message ?? '') };
}

/**
 * Map one `lib/http.mjs` `Result` onto the envelope.
 *
 * A 401 or 403 from the instance is `auth_failed` regardless of the transport verdict: those
 * are the two the user can actually fix, and folding them into `upstream_unreachable` would
 * send somebody to check their network over a revoked key.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} res
 * @returns {{ok: false, status: number, code: string, message: string}}
 */
export function mapError(cfg, res) {
  const message = scrubKey(cfg, String(res && res.error ? res.error : 'upstream call failed'));
  const status = Number(res && res.status);
  if (status === 401 || status === 403) return fail(502, 'auth_failed', message);
  const hit = STATE_MAP[String(res && res.state)];
  return hit ? fail(hit.status, hit.code, message) : fail(503, 'upstream_unreachable', message);
}

/**
 * Remove the configured API key from a string.
 *
 * Belt and braces: no upstream is expected to echo the `Authorization` header back, but a
 * proxy error page and a verbose 4xx both can, and `lib/http.mjs` puts a snippet of the
 * response body into `res.error`. One `includes` per error is cheaper than the incident.
 *
 * @param {Record<string, any>} cfg
 * @param {string} text
 * @returns {string}
 */
export function scrubKey(cfg, text) {
  const s = String(text ?? '');
  const key = cfg && typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
  if (!key || !s.includes(key)) return s;
  return s.split(key).join('[REDACTED:api-key]');
}

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

/**
 * The id a lesson is addressed by, across three spellings of the same field.
 *
 * The server serialises `LessonEntry.id`. The session-start hook reads `lesson_id`, and the
 * test harness's default route fakes `lesson_id` — so the fixture and the real instance
 * disagree, and code that reads only one of them works against exactly one of them.
 * `reference_id` is what an attribution call wants and is preferred when present, which is
 * the order `lib/rules.mjs` already settled on.
 *
 * @param {Record<string, any>} raw
 * @returns {string}
 */
export function lessonId(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const first = [raw.reference_id, raw.lesson_id, raw.id]
    .find((v) => typeof v === 'string' && v.trim());
  return first ? String(first).trim() : '';
}

/**
 * One `LessonEntry`, normalised.
 *
 * The wire shape has exactly nine fields and `created_at` is not one of them — hence the
 * activity join below. `scope` and `source_run_id` are what the scope-leak column renders:
 * a lesson whose `scope` is not `run` is visible to runs other than the one that wrote it,
 * and `source_run_id` says which run that was.
 *
 * @param {Record<string, any>} raw
 * @param {{createdAt?: string, currentRun?: string}} [ctx]
 * @returns {Record<string, any>}
 */
export function normalizeLesson(raw, ctx = {}) {
  const l = (raw && typeof raw === 'object') ? raw : {};
  const stated = String(l.scope || '');
  const scope = stated || DEFAULT_SCOPE;
  const sourceRun = String(l.source_run_id || '');
  return {
    id: lessonId(l),
    content: String(l.content || ''),
    lessonType: String(l.lesson_type || ''),
    scope,
    scopeKnown: stated !== '',
    importance: String(l.importance || ''),
    conditions: Array.isArray(l.conditions) ? l.conditions.map(String) : [],
    rationale: String(l.rationale || ''),
    sourceRunId: sourceRun,
    source: String(l.source || ''),
    createdAt: String(ctx.createdAt || ''),
    // "Visible outside the run that wrote it" — the filter the scope-leak view is built on.
    // Anything above `run` scope reaches other runs by design; whether that was intended is
    // the question the column exists to let a human answer.
    leaksScope: scope !== DEFAULT_SCOPE,
    fromOtherRun: !!(ctx.currentRun && sourceRun && sourceRun !== ctx.currentRun),
  };
}

/**
 * The same lesson as it arrives on the **activity** feed, normalised to the same keys.
 *
 * The Memory tab reads lessons from `/v2/control/activity` rather than `/v2/control/lessons`,
 * because that route applies `limit` before it filters to `entry_type == "lesson"` — `limit:
 * 200` means "take two hundred arbitrary facts and keep whichever happen to be lessons", and
 * on a busy instance that is reliably none of them. The feed collects, filters, sorts, and only
 * then pages.
 *
 * Nothing is lost in the swap. `list_lessons` builds every field it returns out of
 * `f.metadata`, and `metadata_json` is that same map serialised whole — so the fields are all
 * still here, one indirection further in, plus `created_at`, which `LessonEntry` has no room
 * for and `createdAtIndex` below exists to go and fetch, plus `env_tags`.
 *
 * Two fields differ in ways that matter. `list_lessons` falls back to `&f.run_id`, the
 * *scoped* run id as stored, where the feed serialises `unscoped_run_id_for_owner` — so off the
 * lessons route `sourceRunId` and the page's current run are different strings even when they
 * name the same run, and every lesson reads as foreign. And an absent scope becomes `run` here,
 * matching the server's own default, rather than an empty string belonging to neither side of
 * the leak filter.
 *
 * @param {Record<string, any>} entry an `ActivityEntry`
 * @param {{currentRun?: string}} [ctx]
 * @returns {Record<string, any>}
 */
export function normalizeActivityLesson(entry, ctx = {}) {
  const e = (entry && typeof entry === 'object') ? entry : {};
  const meta = parseMetadata(e.metadata_json) || {};
  // The same `or_else` pair, in the same order, that `list_lessons` reads: an instance with
  // both conventions in its history serves both, and the server accepts both.
  const stated = str(meta.scope) || str(meta.lesson_scope);
  const scope = stated || DEFAULT_SCOPE;
  const sourceRun = String(meta.source_run_id || e.run_id || '');
  const conditions = meta.conditions || meta.lesson_conditions;
  return {
    id: lessonId(e),
    content: String(e.content || ''),
    lessonType: String(meta.lesson_type || ''),
    scope,
    // "The server would have called this a run lesson" and "we never saw the metadata" are the
    // same rendered word and different facts, and only the second should make a reader doubt
    // the count beside it.
    scopeKnown: stated !== '',
    importance: String(meta.importance || meta.lesson_importance || ''),
    conditions: Array.isArray(conditions) ? conditions.map(String) : [],
    rationale: String(meta.rationale || ''),
    sourceRunId: sourceRun,
    source: String(e.source || ''),
    createdAt: String(e.created_at || ''),
    runId: String(e.run_id || ''),
    project: projectTag(meta.env_tags),
    leaksScope: scope !== DEFAULT_SCOPE,
    fromOtherRun: !!(ctx.currentRun && sourceRun && sourceRun !== ctx.currentRun),
  };
}

/**
 * The project a lesson belongs to, or nothing at all.
 *
 * `repo:` is the project key, and an entry carrying no `repo:` tag is unconfined rather than
 * local. Attributing it to whatever project happens to be open would invent a confinement the
 * instance never recorded — which is the one claim this column exists to let a human check.
 *
 * @param {any} tags `env_tags` — a JSON array of strings, merged into the fact's metadata at
 *   ingest so tag-aware scoring can reach it
 * @returns {string}
 */
function projectTag(tags) {
  if (!Array.isArray(tags)) return '';
  const hit = tags.map(str).find((t) => t.startsWith(REPO_TAG));
  return hit ? hit.slice(REPO_TAG.length) : '';
}

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
export function parseMetadata(raw) {
  let v = raw;
  for (let i = 0; i < 2; i += 1) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v !== 'string' || !v.trim()) return null;
    try { v = JSON.parse(v); } catch { return null; }
  }
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
}

/**
 * `POST /v2/control/lessons`, joined against `POST /v2/control/activity` for `created_at`.
 *
 * `run_id` is optional on the lessons route and an absent one means every run, which is what
 * a global-lessons view wants — so an empty `run` is passed through rather than defaulted.
 *
 * The join degrades on its own: a failed activity call leaves every `createdAt` empty and sets
 * `joined: false`, and the lessons still render. Failing the whole route because a timestamp
 * could not be fetched would be the worse trade.
 *
 * @param {Record<string, any>} cfg
 * @param {{run?: string, scope?: string, importance?: string, limit?: number}} [params]
 * @returns {Promise<Record<string, any>>}
 */
export async function fetchLessons(cfg, params = {}) {
  const run = str(params.run);
  const req = { limit: clamp(params.limit, 1, 500, 100) };
  if (run) req.run_id = run;
  if (str(params.scope)) req.scope = str(params.scope);
  if (str(params.importance)) req.importance = str(params.importance);

  const res = await postLessons(cfg, req, READ_ONLY);
  if (!res.ok) return mapError(cfg, res);

  const raw = Array.isArray(res.body && res.body.lessons) ? res.body.lessons : [];

  const stamps = await createdAtIndex(cfg, run, raw.length);
  const lessons = raw.map((l) => normalizeLesson(l, {
    createdAt: stamps.byId.get(lessonId(l)) ?? '',
    currentRun: run,
  }));

  return ok({
    lessons,
    joined: stamps.joined,
    // How many lessons actually came back with a timestamp. `joined` says the call worked;
    // this says whether it produced anything, and the two are not the same — see below.
    dated: lessons.filter((l) => l.createdAt).length,
    joinError: stamps.error,
  });
}

/**
 * `id -> created_at`, built from the activity feed.
 *
 * **`entry_types: ['lesson']` is load-bearing.** The feed is every entry type in descending
 * time order, and on a run with real history it is overwhelmingly traces — measured against a
 * hosted instance, the newest three hundred entries out of seventeen thousand contained not a
 * single lesson. An unfiltered page therefore joins nothing while looking like it worked.
 *
 * `ActivityEntry` carries both `id` and `reference_id` and a lesson can be addressed by
 * either, so both are indexed.
 *
 * A caveat the caller has to be able to see: an instance may return lesson entries whose
 * `created_at` is empty, in which case the call succeeded and produced no dates. That is why
 * `fetchLessons` reports `dated` alongside `joined` — "the join ran" and "the join found
 * something" are different facts, and only the second one should let a page claim dates.
 *
 * @param {Record<string, any>} cfg
 * @param {string} run
 * @param {number} lessonCount
 */
async function createdAtIndex(cfg, run, lessonCount) {
  /** @type {Map<string, string>} */
  const byId = new Map();
  if (!lessonCount) return { byId, joined: true, error: '' };

  const res = await fetchActivity(cfg, {
    run,
    limit: Math.min(500, Math.max(100, lessonCount * 2)),
    projection: 'compact',
    entryTypes: ['lesson'],
  });
  if (!res.ok) return { byId, joined: false, error: res.message };

  for (const e of res.data.entries) {
    const at = String(e.created_at || '');
    if (!at) continue;
    for (const key of [e.id, e.reference_id]) {
      if (typeof key === 'string' && key.trim() && !byId.has(key)) byId.set(key, at);
    }
  }
  return { byId, joined: true, error: '' };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/**
 * `POST /v2/control/activity`.
 *
 * Two facts about this route decide the request shape. Pagination is offset-style — the token
 * is a numeric offset string and `next_page_token` is `""` once exhausted — and **`limit`
 * clamps to 1 when it is 0**, so an omitted limit does not mean "the default", it means one
 * entry. The limit here is therefore always explicit.
 *
 * The last five parameters are `ListActivityRequest` fields the dashboard never needed and
 * `lib/activity.mjs` does. Every one of them is emitted **only when set**, which is not
 * fastidiousness: an unconditional `user_id: ''` is read server-side by
 * `effective_logical_user_scope` and becomes a retrieval filter nobody asked for — the same
 * shape as the trap on the ingest side, where filling `user_id` made new captures
 * unrecallable. `exclude_derived: false` is likewise absent rather than false, so a request
 * body says only what the caller actually asked for.
 *
 * @param {Record<string, any>} cfg
 * @param {{run?: string, limit?: number, pageToken?: string, projection?: string,
 *          entryTypes?: string[], sort?: string, excludeDerived?: boolean,
 *          createdAfter?: string, createdBefore?: string, userId?: string,
 *          agentId?: string}} [params]
 * @returns {Promise<Record<string, any>>}
 */
export async function fetchActivity(cfg, params = {}) {
  const req = {
    limit: clamp(params.limit, 1, 500, 100),
    sort: params.sort === 'asc' ? 'asc' : 'desc',
    // Truncates content to 200 chars and strips verbose metadata — the right projection for a
    // feed, and it is what keeps a page of activity off the far side of a megabyte.
    projection: params.projection === 'full' ? 'full' : 'compact',
  };
  if (str(params.run)) req.run_id = str(params.run);
  if (str(params.pageToken)) req.page_token = str(params.pageToken);
  if (Array.isArray(params.entryTypes) && params.entryTypes.length) {
    req.entry_types = params.entryTypes.map(String);
  }
  if (params.excludeDerived === true) req.exclude_derived = true;
  if (str(params.createdAfter)) req.created_after = str(params.createdAfter);
  if (str(params.createdBefore)) req.created_before = str(params.createdBefore);
  if (str(params.userId)) req.user_id = str(params.userId);
  if (str(params.agentId)) req.agent_id = str(params.agentId);

  const res = await request(cfg, 'POST', EXTRA_ROUTES.activity, req, READ_ONLY);
  if (!res.ok) return mapError(cfg, res);

  const body = (res.body && typeof res.body === 'object') ? res.body : {};
  return ok({
    entries: Array.isArray(body.entries) ? body.entries : [],
    nextPageToken: String(body.next_page_token || ''),
    totalVisible: Number(body.total_visible) || 0,
  });
}

// ---------------------------------------------------------------------------
// Health and runs
// ---------------------------------------------------------------------------

/**
 * `POST /v2/control/memory_health`. `run_id` is required — this is the one route where an
 * empty scope is a client bug rather than "every run".
 *
 * @param {Record<string, any>} cfg
 * @param {{run?: string}} [params]
 * @returns {Promise<Record<string, any>>}
 */
export async function fetchMemoryHealth(cfg, params = {}) {
  const run = str(params.run);
  if (!run) return fail(400, 'bad_request', 'memory_health requires a run id');
  const res = await request(cfg, 'POST', EXTRA_ROUTES.memoryHealth, { run_id: run }, READ_ONLY);
  return res.ok ? ok(res.body ?? {}) : mapError(cfg, res);
}

/**
 * `GET /v2/control/runs?limit=` — a GET, unlike every other control route, and its `limit` is
 * clamped to 1..100 server-side. Clamping here too keeps the request honest rather than
 * relying on the server to fix it.
 *
 * @param {Record<string, any>} cfg
 * @param {{limit?: number}} [params]
 * @returns {Promise<Record<string, any>>}
 */
export async function fetchRemoteRuns(cfg, params = {}) {
  const limit = clamp(params.limit, 1, 100, 25);
  const res = await request(cfg, 'GET', `${EXTRA_ROUTES.runs}?limit=${limit}`, undefined, READ_ONLY);
  if (!res.ok) return mapError(cfg, res);
  const body = (res.body && typeof res.body === 'object') ? res.body : {};
  return ok({ runs: Array.isArray(body.runs) ? body.runs : [] });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * `POST /v2/control/query` with `evidence_only: true`.
 *
 * `evidence_only` skips the synthesis step, which is the whole reason this is affordable as an
 * on-demand search: the page gets ranked evidence back without paying for a written answer it
 * would only render as a list anyway.
 *
 * `mode` is validated by `postQuery` before anything is dialled, because the server has no
 * error for a wrong one — only a bill.
 *
 * @param {Record<string, any>} cfg
 * @param {{run?: string, query?: string, mode?: string, limit?: number,
 *          includeLinkedRuns?: boolean, preferCurrentRun?: boolean}} [params]
 * @returns {Promise<Record<string, any>>}
 */
export async function runSearch(cfg, params = {}) {
  const run = str(params.run);
  const query = str(params.query);
  if (!run) return fail(400, 'bad_request', 'search requires a run id');
  if (!query) return fail(400, 'bad_request', 'search requires a query');

  const res = await postQuery(cfg, {
    run_id: run,
    query,
    mode: str(params.mode) || 'direct_bypass',
    evidence_only: true,
    limit: clamp(params.limit, 1, 50, 20),
    include_linked_runs: params.includeLinkedRuns === true,
    prefer_current_run: params.preferCurrentRun === true,
  }, READ_ONLY);
  if (!res.ok) return mapError(cfg, res);

  const body = (res.body && typeof res.body === 'object') ? res.body : {};
  return ok({
    evidence: Array.isArray(body.evidence) ? body.evidence : [],
    mode: String(body.mode || ''),
    degraded: body.degraded === true,
    routingSummary: String(body.routing_summary || ''),
    consultedRuns: Array.isArray(body.consulted_runs) ? body.consulted_runs : [],
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * `POST /v2/control/outcome`.
 *
 * The `idempotency_key` is what makes the button safe to double-click: without one, two
 * clicks are two reinforcements and the confidence the page just showed becomes wrong because
 * the page showed it. `reference_id` must be non-empty — `"global"` is the documented value
 * for run-level attribution with no single primary lesson.
 *
 * @param {Record<string, any>} cfg
 * @param {{run?: string, referenceId?: string, success?: boolean, entryIds?: string[],
 *          idempotencyKey?: string, notes?: string}} [params]
 * @returns {Promise<Record<string, any>>}
 */
export async function sendOutcome(cfg, params = {}) {
  const run = str(params.run);
  const referenceId = str(params.referenceId);
  if (!run) return fail(400, 'bad_request', 'outcome requires a run id');
  if (!referenceId) {
    return fail(400, 'bad_request',
      'outcome requires a reference_id; pass "global" for run-level attribution');
  }

  const req = {
    run_id: run,
    reference_id: referenceId,
    success: params.success !== false,
    idempotency_key: str(params.idempotencyKey) || `dash-${run}-${referenceId}-${params.success !== false}`,
  };
  if (Array.isArray(params.entryIds) && params.entryIds.length) {
    req.entry_ids = params.entryIds.map(String);
  }
  if (str(params.notes)) req.notes = str(params.notes);

  const res = await postOutcome(cfg, req, READ_ONLY);
  if (!res.ok) return mapError(cfg, res);
  const body = (res.body && typeof res.body === 'object') ? res.body : {};
  return ok({
    success: body.success === true,
    reinforcementCount: Number(body.reinforcement_count) || 0,
    updatedConfidence: Number(body.updated_confidence) || 0,
  });
}

/**
 * `POST /v2/control/archive`. `run_id`, `content` and `artifact_kind` are all required by the
 * route, so all three are checked before anything is dialled.
 *
 * @param {Record<string, any>} cfg
 * @param {{run?: string, content?: string, artifactKind?: string, metadataJson?: string}} [params]
 * @returns {Promise<Record<string, any>>}
 */
export async function sendArchive(cfg, params = {}) {
  const run = str(params.run);
  const content = str(params.content);
  const artifactKind = str(params.artifactKind) || 'note';
  if (!run) return fail(400, 'bad_request', 'archive requires a run id');
  if (!content) return fail(400, 'bad_request', 'archive requires content');

  const res = await request(cfg, 'POST', EXTRA_ROUTES.archive, {
    run_id: run,
    content,
    artifact_kind: artifactKind,
    metadata_json: str(params.metadataJson) || '',
  }, READ_ONLY);
  return res.ok ? ok(res.body ?? {}) : mapError(cfg, res);
}

/**
 * `POST /v2/control/lessons/delete`.
 *
 * The typed confirmation is enforced here rather than in the page, because a confirmation
 * that lives only in the browser is a confirmation an errant `fetch` skips. `confirm` must
 * equal the lesson id exactly; anything else refuses without dialling, so a mismatched
 * request cannot delete and cannot be retried into deleting.
 *
 * @param {Record<string, any>} cfg
 * @param {{lessonId?: string, confirm?: string}} [params]
 * @returns {Promise<Record<string, any>>}
 */
export async function deleteLesson(cfg, params = {}) {
  const id = str(params.lessonId);
  const confirm = str(params.confirm);
  if (!id) return fail(400, 'bad_request', 'forget requires a lesson_id');
  if (confirm !== id) {
    return fail(400, 'bad_request',
      'forget requires `confirm` to match the lesson id exactly; nothing was deleted');
  }

  const res = await request(cfg, 'POST', EXTRA_ROUTES.deleteLesson, { lesson_id: id }, READ_ONLY);
  if (!res.ok) return mapError(cfg, res);
  const body = (res.body && typeof res.body === 'object') ? res.body : {};
  return ok({ success: body.success === true, lessonId: id });
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/** @param {any} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** @param {any} v @param {number} lo @param {number} hi @param {number} dflt */
function clamp(v, lo, hi, dflt) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}
