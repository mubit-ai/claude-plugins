// @ts-check
/**
 * `bin/dashboard.src.mjs` — what `/mubit-memory:dashboard` runs. Bundled to `bin/dashboard.mjs`.
 *
 * The plugin already captures work, recalls lessons before every prompt and attributes the
 * outcome of each turn — and until this command existed there was no way to *look* at any of
 * it. The lessons live behind the API; the per-prompt cost of recall lives on disk as
 * uuid-named JSON under `runs/<run_id>/turns/`. This joins the two into one page.
 *
 * ## The posture
 *
 * A local web server that reads a user's memory is a thing worth being careful with, so:
 *
 *   - **Loopback only.** `listen(0, '127.0.0.1')`, an ephemeral port. Binding `0.0.0.0` would
 *     put a browsable copy of somebody's memory on their office network.
 *   - **A bearer token, minted per launch.** Every route rejects a missing or wrong one with
 *     401 before doing any work, and an unauthorized request does not even refresh the idle
 *     clock — a stranger probing the port cannot keep the server alive. The token reaches the
 *     browser in the launch URL, because a browser navigating to a page cannot set a header;
 *     the page then sends it as `Authorization` on every call and drops it from the URL bar.
 *   - **The API key never leaves this process.** Every upstream call is proxied, and every
 *     response is checked for the key on the way out. That last check is redundant three
 *     times over and costs one `includes` per response.
 *   - **Reads do not perturb what they read.** `lib/dashboard-data.mjs` picks the pure
 *     neighbour in the three places where the obvious one mutates, and
 *     `lib/dashboard-api.mjs` passes `{record: false}` so a page polling a dead instance
 *     cannot open the circuit breaker for the hooks.
 *
 * ## Why it detaches
 *
 * The skill runs one `node` command and the user carries on with their session. A server in
 * the foreground would hold the tool call open for as long as the page was useful. So the
 * launch spawns a detached child, waits for it to publish its port and token, prints the URL,
 * and exits — and the child shuts itself down after half an hour with no authorized traffic,
 * because the failure mode of a forgotten daemon is a forgotten daemon.
 *
 * ## Why the HTML is a sibling file rather than an import
 *
 * `bin/dashboard.html` is read at runtime from beside whichever file is executing —
 * `bin/dashboard.src.mjs` under test, `bin/dashboard.mjs` once bundled. Importing it as a
 * text module would make the source unloadable by Node, and the test suite drives `main()` by
 * importing this file. It also keeps the page out of the bundle's inline sourcemap.
 */

import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lessonCensus } from '../lib/activity.mjs';
import { isConfigured, loadConfig } from '../lib/config.mjs';
import {
  deleteLesson, fetchActivity, fetchLessons, fetchMemoryHealth, fetchRemoteRuns,
  normalizeActivityLesson, ok, runSearch, sendArchive, sendOutcome,
} from '../lib/dashboard-api.mjs';
import {
  analytics, appendRollup, listDataDirs, listRuns, localHealth, newestRun,
  resolveDirParam, runsIn, sampleFor, turnDetail, turnRows,
} from '../lib/dashboard-data.mjs';
import { ensureDir, readJson, resolveDataDir, safeSegment, writeJsonAtomic } from '../lib/state.mjs';

/** Where the running server publishes its port and token, relative to the data dir. */
export const STATE_FILE = ['dashboard', 'server.json'];

/** Owner-only. The file holds a live bearer token for a page showing the user's memory. */
const STATE_MODE = 0o600;

/** No authorized request for this long and the server shuts itself down. */
export const IDLE_MS = 30 * 60 * 1000;

/** Poll cadences the page is told to use: disk is cheap, the instance is not. */
export const POLL_MS = Object.freeze({ local: 1000, remote: 15000 });

/** A POST body larger than this is a bug or an attack; either way it is not read. */
const MAX_BODY_BYTES = 64 * 1024;

/** How long the launcher waits for the detached child to publish its port. */
const LAUNCH_TIMEOUT_MS = 8000;

/** The page's own origin is the only thing it may talk to, and it may not be framed. */
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
].join('; ');

const HTML_URL = new URL('./dashboard.html', import.meta.url);

/** Shown when `bin/dashboard.html` is missing, which means a broken install rather than a bug. */
const FALLBACK_HTML = '<!doctype html><meta charset="utf-8"><title>Mubit dashboard</title>'
  + '<body style="font:13px system-ui;padding:2rem">'
  + '<h1>bin/dashboard.html is missing</h1>'
  + '<p>The server is running, but the page it serves is not on disk. Reinstall the plugin.</p>';

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/**
 * @param {string} [override] injected by the tests, so the suite never depends on the markup
 * @returns {string}
 */
export function pageHtml(override) {
  if (typeof override === 'string' && override) return override;
  try { return readFileSync(HTML_URL, 'utf8'); } catch { return FALLBACK_HTML; }
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/** 256 bits, base64url. One per launch; nothing derives it and nothing reuses it. */
export function mintToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * The token a request presented, from the header first and the query string second.
 *
 * The query string exists for exactly one request — the browser's first navigation, which
 * cannot carry a header. The page replaces its own URL immediately afterwards so the token
 * does not sit in the address bar, in history, or in whatever the user pastes into a bug
 * report.
 *
 * @param {{headers?: Record<string, any>}} req
 * @param {URL} url
 * @returns {string}
 */
export function presentedToken(req, url) {
  const header = req && req.headers ? String(req.headers.authorization ?? '') : '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (m) return m[1].trim();
  return String(url.searchParams.get('token') ?? '').trim();
}

/**
 * Constant-time comparison that does not leak the length either.
 *
 * `timingSafeEqual` throws on a length mismatch, and returning early on one would turn the
 * token's length into a free oracle. Both sides are hashed to a fixed width first — cheap,
 * and it makes every comparison the same shape.
 *
 * @param {string} a @param {string} b @returns {boolean}
 */
export function tokenEquals(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (!x.length || !y.length) return false;
  const width = Math.max(x.length, y.length);
  const px = Buffer.alloc(width);
  const py = Buffer.alloc(width);
  x.copy(px);
  y.copy(py);
  try { return timingSafeEqual(px, py) && x.length === y.length; } catch { return false; }
}

// ---------------------------------------------------------------------------
// The state file
// ---------------------------------------------------------------------------

/** @param {Record<string, any>} cfg @returns {string} */
export function statePath(cfg) {
  return join(resolveDataDir(cfg), ...STATE_FILE);
}

/**
 * @param {Record<string, any>} cfg
 * @returns {{pid: number, port: number, token: string, startedAt: number, url: string}|null}
 */
export function readState(cfg) {
  const s = readJson(statePath(cfg), null);
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const pid = Number(s.pid);
  const port = Number(s.port);
  if (!Number.isFinite(pid) || !Number.isFinite(port) || !s.token) return null;
  return {
    pid, port,
    token: String(s.token),
    startedAt: Number(s.startedAt) || 0,
    url: String(s.url || `http://127.0.0.1:${port}/`),
  };
}

/** @param {Record<string, any>} cfg @param {Record<string, any>} state */
export function writeState(cfg, state) {
  ensureDir(join(resolveDataDir(cfg), STATE_FILE[0]));
  return writeJsonAtomic(statePath(cfg), state, { mode: STATE_MODE });
}

/** @param {Record<string, any>} cfg */
export function clearState(cfg) {
  try { unlinkSync(statePath(cfg)); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * Serialise, then make sure the API key is not in what we are about to write.
 *
 * Nothing is supposed to be able to put it there. This is the assertion that says so at
 * runtime rather than in a comment, and it is the difference between a bug and an incident.
 *
 * @param {any} res
 * @param {number} status
 * @param {any} body
 * @param {Record<string, any>} cfg
 */
function sendJson(res, status, body, cfg) {
  let text = '{}';
  try { text = JSON.stringify(body ?? {}); } catch { text = '{"error":{"code":"bad_request","message":"unserialisable"}}'; }
  const key = cfg && typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
  if (key && text.includes(key)) text = text.split(key).join('[REDACTED:api-key]');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(text);
}

/** @param {any} res @param {number} status @param {string} code @param {string} message @param {Record<string,any>} cfg */
function sendError(res, status, code, message, cfg) {
  sendJson(res, status, { error: { code, message } }, cfg);
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/**
 * Stand the dashboard up on a loopback port.
 *
 * @param {{cfg?: Record<string, any>, env?: Record<string, string|undefined>, token?: string,
 *          idleMs?: number, html?: string, onShutdown?: (reason: string) => void,
 *          onStop?: () => void}} [opts]
 * @returns {Promise<{server: any, port: number, token: string, url: string,
 *                    cfg: Record<string, any>, close: () => Promise<void>}>}
 */
export async function startServer(opts = {}) {
  const env = opts.env ?? process.env;
  const cfg = opts.cfg ?? loadConfig(env);
  const token = opts.token || mintToken();
  const html = pageHtml(opts.html);
  const idleMs = Number.isFinite(Number(opts.idleMs)) ? Number(opts.idleMs) : IDLE_MS;

  const ctx = {
    cfg,
    startedAt: Date.now(),
    lastRequestAt: Date.now(),
    /** What `POST /api/shutdown` does. Injected, so the suite can exercise the route without
     *  taking the test runner down with it. */
    onStop: opts.onStop ?? (() => { process.exit(0); }),
    /** Cached because `/api/turns` polls about once a second and the scan is a few stats. */
    dirsAt: 0,
    dirs: /** @type {any[]} */ ([]),
  };

  const server = createServer((req, res) => {
    handle(ctx, req, res, token, html).catch((err) => {
      // A handler that throws is a bug in this file, never something the client said. It is
      // reported as a server fault without echoing the message, which could quote a request.
      try { sendError(res, 500, 'bad_request', `dashboard handler failed: ${err?.name ?? 'Error'}`, cfg); }
      catch { /* the socket is already gone */ }
    });
  });

  await new Promise((ready, bad) => {
    server.once('error', bad);
    server.listen(0, '127.0.0.1', () => ready(undefined));
  });

  const port = /** @type {any} */ (server.address()).port;
  const url = `http://127.0.0.1:${port}/`;

  /** @type {any} */
  let idleTimer = null;
  const close = () => new Promise((done) => {
    if (idleTimer) clearInterval(idleTimer);
    server.close(() => done(undefined));
    // A browser tab holds a keep-alive socket open, and `close()` waits for it. Without this
    // the shutdown a user asked for takes a minute to happen.
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });

  if (idleMs > 0) {
    // Half the idle window, so a shutdown lands within 1.5x of the deadline. The 50 ms floor
    // is what lets the suite exercise the timer without sleeping for real minutes; in
    // production `idleMs` is half an hour and this is a minute.
    const every = Math.max(50, Math.min(60000, Math.floor(idleMs / 2)));
    idleTimer = setInterval(() => {
      if (Date.now() - ctx.lastRequestAt < idleMs) return;
      clearInterval(idleTimer);
      close().then(() => opts.onShutdown?.('idle'));
    }, every);
    // The listening socket keeps the loop alive; the timer must not, or a closed server would
    // hang the process waiting for a tick nobody needs.
    idleTimer.unref?.();
  }

  return { server, port, token, url, cfg, close };
}

/**
 * One request.
 *
 * @param {Record<string, any>} ctx
 * @param {any} req
 * @param {any} res
 * @param {string} token
 * @param {string} html
 */
async function handle(ctx, req, res, token, html) {
  const cfg = ctx.cfg;
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  // Before anything else, and before anything is read from disk or dialled. An unauthorized
  // request is answered and forgotten: it is not logged, and it does not touch the idle clock,
  // so a port scanner cannot keep a forgotten dashboard alive.
  if (!tokenEquals(presentedToken(req, url), token)) {
    return sendError(res, 401, 'unauthorized', 'a valid bearer token is required', cfg);
  }
  ctx.lastRequestAt = Date.now();

  const method = String(req.method ?? 'GET').toUpperCase();
  const path = url.pathname;

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    return res.end(html);
  }

  if (method === 'GET' && path === '/api/ping') {
    return sendJson(res, 200, {
      service: 'mubit-dashboard', pid: process.pid, startedAt: ctx.startedAt,
    }, cfg);
  }

  if (method === 'POST' && path === '/api/shutdown') {
    sendJson(res, 200, { stopping: true }, cfg);
    // Answered first, so the caller learns the request landed rather than seeing a dropped
    // socket and having to guess whether it worked.
    const timer = setTimeout(() => { try { ctx.onStop(); } catch { /* already going */ } }, 50);
    timer.unref?.();
    return undefined;
  }

  if (method === 'GET') return getRoute(ctx, res, path, url);
  if (method === 'POST') return postRoute(ctx, req, res, path);

  return sendError(res, 404, 'not_found', `${method} ${path} is not a dashboard route`, cfg);
}

// ---------------------------------------------------------------------------
// Parameter resolution — the whole path-safety story for ids from a query string
// ---------------------------------------------------------------------------

/**
 * The data directories, rescanned at most every two seconds.
 * @param {Record<string, any>} ctx
 */
function dirsOf(ctx) {
  const now = Date.now();
  if (now - ctx.dirsAt < 2000 && ctx.dirs.length) return ctx.dirs;
  ctx.dirs = listDataDirs({ cfg: ctx.cfg });
  ctx.dirsAt = now;
  return ctx.dirs;
}

/**
 * `?dir=` and `?run=`, both made safe before they touch a path.
 *
 * `dir` is resolved by equality against directories this process found on disk — an arbitrary
 * string is never joined onto anything. `run` and `prompt` go through `safeSegment`, which is
 * the plugin's one definition of a path segment it will write; note that `readMarker` does
 * *not* apply it internally, so `../../etc/passwd` would otherwise be read as a marker path.
 *
 * @param {Record<string, any>} ctx
 * @param {URL} url
 * @returns {{dir: string, run: string, dirs: any[]}}
 */
function scope(ctx, url) {
  const dirs = dirsOf(ctx);
  const dir = resolveDirParam(String(url.searchParams.get('dir') ?? ''), dirs);
  const asked = safeSegment(String(url.searchParams.get('run') ?? ''));
  const run = asked || (dir ? newestRun(dir) : '');
  return { dir, run, dirs };
}

// ---------------------------------------------------------------------------
// The lesson census
// ---------------------------------------------------------------------------

/**
 * Why `/api/lessons` scans the activity feed rather than calling the lessons route.
 *
 * The instance's lessons route fetches `limit` facts of *any* entry type and only then filters to
 * `entry_type == "lesson"`. `limit=200` therefore means "take two hundred arbitrary facts and
 * keep whichever happen to be lessons" — measured against a hosted instance, the newest three
 * hundred entries out of seventeen thousand contained not a single one. The tab was near-empty
 * and it looked like an instance with nothing in it. The activity route has the opposite
 * order: it collects everything, filters by `entry_types`, sorts, and only then pages.
 *
 * The lessons route stays as the fallback, because it is what an instance with an unreadable
 * activity feed can still answer. Which of the two replied is *reported* rather than inferred:
 * they have different fidelity — the lessons route carries no `created_at` and reports the
 * scoped `source_run_id` where activity reports the unscoped one — and a page that cannot say
 * where a row came from cannot say what a missing row means.
 *
 * Scope is never sent upstream. `ListActivityRequest` has no scope field at all, and on the
 * lessons route the scope filter runs *after* `limit`, so asking for `scope=global` there
 * filters an already-truncated set and reliably answers with nothing. It is applied here,
 * after the census, which is what makes "show me the leaks" stop returning an empty list.
 */

/**
 * The one value of `?project=` that is not a repo slug: the rows carrying no `repo:` tag.
 *
 * The bucket needs a spelling of its own because an empty query parameter is indistinguishable
 * from an absent one — and it is the honest half of the facet. `repo:` is written only by the
 * hook capture paths, so a lesson written through `mubit_learned`, and every lesson reflection
 * produces, has no project at all. Those must never be shown as belonging to the current one.
 */
export const UNTAGGED_PROJECT = '__untagged__';

/**
 * Does one normalised row satisfy the selected scope?
 *
 * `run` and `unknown` overlap deliberately. A lesson whose metadata names no scope comes back
 * reading `run`, so that is where the page has to file it or the two disagree about the same
 * entry — but "it arrived saying run" and "it arrived saying nothing" are different facts, and
 * `unknown` is where somebody goes to see the difference.
 *
 * @param {Record<string, any>} row
 * @param {string} want
 */
function scopeMatches(row, want) {
  if (!want) return true;
  if (want === 'leak') return row.leaksScope === true;
  if (want === 'unknown') return row.scopeKnown === false;
  return row.scope === want;
}

/**
 * Counted into a `Map` rather than an object literal: these keys come out of an instance's
 * metadata, and `obj['__proto__'] = n` on a plain object silently sets nothing at all.
 *
 * @param {any[]} rows @param {(r: any) => string} key
 */
function countBy(rows, key) {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const r of rows) {
    const k = key(r);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return Object.fromEntries(out);
}

/**
 * The census, the fallback, and the local filter — as one envelope.
 *
 * @param {Record<string, any>} cfg
 * @param {{run: string, currentRun: string, scope: string, importance: string,
 *          project: string, limit: number, source: string}} p
 * @returns {Promise<Record<string, any>>}
 */
async function lessonsPayload(cfg, p) {
  const keep = (rows) => rows.filter((r) => scopeMatches(r, p.scope)
    && (!p.importance || r.importance === p.importance)
    && (!p.project || (p.project === UNTAGGED_PROJECT ? !r.project : r.project === p.project)));

  /** @type {Record<string, any>|null} */
  let census = null;
  if (p.source !== 'lessons') {
    census = await lessonCensus(cfg, { run: p.run, currentRun: p.currentRun, limit: p.limit });
    if (!census.ok) {
      if (p.source === 'activity') return census;
    } else if (census.data.lessons.length || census.data.truncated || p.source === 'activity') {
      // A truncated census that found nothing found nothing *so far*. Falling back there would
      // swap a partial answer for a differently-shaped one; only a complete, empty scan is
      // evidence that the feed has no lessons to give.
      const loaded = census.data.lessons;
      const rows = keep(loaded);
      return ok({
        lessons: rows,
        joined: true,
        dated: loaded.filter((l) => l.createdAt).length,
        joinError: '',
        source: 'activity',
        censusError: '',
        loaded: loaded.length,
        matched: rows.length,
        hidden: loaded.length - rows.length,
        totalVisible: census.data.totalVisible,
        truncated: census.data.truncated,
        truncatedReason: census.data.truncatedReason,
        pages: census.data.pages,
        unknownScope: census.data.unknownScope,
        scopeCounts: census.data.scopeCounts,
        projectCounts: census.data.projectCounts,
      });
    }
  }

  // `scope` and `importance` are deliberately not forwarded: on this route they are applied
  // after `limit`, so sending them narrows an already-arbitrary sample twice.
  const fb = await fetchLessons(cfg, { run: p.run, limit: p.limit });
  if (!fb.ok) return fb;

  const loaded = fb.data.lessons;
  const rows = keep(loaded);
  return ok({
    lessons: rows,
    joined: fb.data.joined,
    dated: fb.data.dated,
    joinError: fb.data.joinError,
    source: 'lessons',
    // Why the page is not looking at a census. Empty when the census simply came back empty.
    censusError: census && !census.ok ? String(census.message ?? '') : '',
    loaded: loaded.length,
    matched: rows.length,
    hidden: loaded.length - rows.length,
    // This route reports no server-side total, so the only honest number is what arrived —
    // which `source: 'lessons'` is what tells the page.
    totalVisible: loaded.length,
    truncated: false,
    truncatedReason: '',
    pages: 1,
    unknownScope: loaded.filter((l) => l.scopeKnown === false).length,
    scopeCounts: countBy(loaded, (l) => String(l.scope ?? '')),
    projectCounts: countBy(loaded, (l) => String(l.project ?? '')),
  });
}

/**
 * Add the scope fields to a lesson-typed activity row, keeping everything else it carries.
 *
 * Lesson rows only: scope is a lesson property, and stamping a trace with one would put a
 * fiction on the page that reads exactly like a fact. Under the compact projection the server
 * has already overwritten `metadata_json` with `{entry_type, created_at}`, so a compact lesson
 * row arrives with `scopeKnown: false` — the honest answer, and the reason the page can say the
 * feed does not carry scope instead of filtering silently to nothing.
 *
 * @param {any} entry
 * @param {string} currentRun
 */
function decorateScope(entry, currentRun) {
  if (!entry || typeof entry !== 'object' || entry.entry_type !== 'lesson') return entry;
  const n = normalizeActivityLesson(entry, { currentRun });
  return {
    ...entry,
    scope: n.scope,
    scopeKnown: n.scopeKnown,
    leaksScope: n.leaksScope,
    project: n.project,
    sourceRunId: n.sourceRunId,
    fromOtherRun: n.fromOtherRun,
  };
}

// ---------------------------------------------------------------------------
// GET routes
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, any>} ctx
 * @param {any} res
 * @param {string} path
 * @param {URL} url
 */
async function getRoute(ctx, res, path, url) {
  const cfg = ctx.cfg;

  // --- local. Every one of these works with the network unplugged. ---------

  if (path === '/api/meta') {
    const { dir, run, dirs } = scope(ctx, url);
    return sendJson(res, 200, {
      // The endpoint is not a secret and the page needs it to say which instance it is showing.
      // The key is not here and is not anywhere else in a response body either.
      endpoint: String(cfg.endpoint ?? ''),
      configured: isConfigured(cfg),
      dataDir: resolveDataDir(cfg),
      dirs,
      dir,
      run,
      pollMs: POLL_MS,
      startedAt: ctx.startedAt,
    }, cfg);
  }

  if (path === '/api/datadirs') {
    return sendJson(res, 200, { dirs: dirsOf(ctx) }, cfg);
  }

  if (path === '/api/runs') {
    const { dir, dirs } = scope(ctx, url);
    const all = String(url.searchParams.get('all') ?? '') === '1';
    return sendJson(res, 200, { dir, runs: all ? listRuns(dirs) : runsIn(dir) }, cfg);
  }

  if (path === '/api/turns') {
    const { dir, run } = scope(ctx, url);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    // The disk poll is also when the rollup grows. Turn files are pruned at six hours, so a
    // trend line has to be accumulated as it happens or it cannot exist at all.
    if (dir && run) appendRollup(dir, run, sampleFor(dir, run));
    return sendJson(res, 200, {
      dir, run, turns: dir && run ? turnRows(dir, run, { limit }) : [],
    }, cfg);
  }

  if (path === '/api/turn') {
    const { dir, run } = scope(ctx, url);
    const prompt = String(url.searchParams.get('prompt') ?? '');
    const turn = dir && run ? turnDetail(dir, run, prompt) : null;
    if (!turn) return sendError(res, 404, 'not_found', 'no such turn', cfg);
    return sendJson(res, 200, { dir, run, turn }, cfg);
  }

  if (path === '/api/health/local') {
    const { dir, run } = scope(ctx, url);
    return sendJson(res, 200, localHealth(cfg, dir, run), cfg);
  }

  if (path === '/api/analytics') {
    const { dir, run } = scope(ctx, url);
    const since = Number(url.searchParams.get('since') ?? 0);
    if (dir && run) appendRollup(dir, run, sampleFor(dir, run));
    return sendJson(res, 200, dir && run
      ? analytics(dir, run, { since })
      : { dir, runId: run, series: [], points: 0 }, cfg);
  }

  // --- proxied. These need the instance, and degrade with a banner. --------

  if (path === '/api/lessons') {
    return upstream(res, cfg, await lessonsPayload(cfg, {
      // An empty `run` means every run, and that is the only spelling it gets. A second
      // `allRuns` parameter would just be a second way to pin this tab back to one run, which
      // is the bug that made a global lesson from another run structurally invisible.
      run: String(url.searchParams.get('run') ?? ''),
      // A rendering context, never a filter: it is what `fromOtherRun` is measured against.
      currentRun: String(url.searchParams.get('currentRun') ?? ''),
      scope: String(url.searchParams.get('scope') ?? ''),
      importance: String(url.searchParams.get('importance') ?? ''),
      project: String(url.searchParams.get('project') ?? ''),
      limit: Number(url.searchParams.get('limit') ?? 100),
      source: String(url.searchParams.get('source') ?? 'auto'),
    }));
  }

  if (path === '/api/activity') {
    const entryTypes = String(url.searchParams.get('entryTypes') ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const r = await fetchActivity(cfg, {
      run: String(url.searchParams.get('run') ?? ''),
      limit: Number(url.searchParams.get('limit') ?? 100),
      pageToken: String(url.searchParams.get('pageToken') ?? ''),
      projection: String(url.searchParams.get('projection') ?? ''),
      sort: String(url.searchParams.get('sort') ?? ''),
      entryTypes: entryTypes.length ? entryTypes : undefined,
    });
    if (!r.ok) return upstream(res, cfg, r);
    const currentRun = String(url.searchParams.get('currentRun') ?? '');
    return upstream(res, cfg, ok({
      ...r.data,
      entries: r.data.entries.map((e) => decorateScope(e, currentRun)),
    }));
  }

  if (path === '/api/health/remote') {
    return upstream(res, cfg, await fetchMemoryHealth(cfg, {
      run: String(url.searchParams.get('run') ?? '') || scope(ctx, url).run,
    }));
  }

  if (path === '/api/remote-runs') {
    return upstream(res, cfg, await fetchRemoteRuns(cfg, {
      limit: Number(url.searchParams.get('limit') ?? 25),
    }));
  }

  return sendError(res, 404, 'not_found', `GET ${path} is not a dashboard route`, cfg);
}

// ---------------------------------------------------------------------------
// POST routes
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, any>} ctx
 * @param {any} req
 * @param {any} res
 * @param {string} path
 */
async function postRoute(ctx, req, res, path) {
  const cfg = ctx.cfg;
  const routes = {
    '/api/search': (b) => runSearch(cfg, b),
    '/api/outcome': (b) => sendOutcome(cfg, b),
    '/api/archive': (b) => sendArchive(cfg, b),
    '/api/forget': (b) => deleteLesson(cfg, b),
  };
  const fn = routes[path];
  if (!fn) return sendError(res, 404, 'not_found', `POST ${path} is not a dashboard route`, cfg);

  const read = await readBody(req);
  if (!read.ok) return sendError(res, 400, 'bad_request', read.error, cfg);

  return upstream(res, cfg, await fn(read.body));
}

/**
 * Read a JSON body, refusing anything oversized without buffering it.
 * @param {any} req
 * @returns {Promise<{ok: true, body: any}|{ok: false, error: string}>}
 */
function readBody(req) {
  return new Promise((done) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; done(v); } };

    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, error: `request body exceeds ${MAX_BODY_BYTES} bytes` });
        try { req.destroy(); } catch { /* already gone */ }
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => finish({ ok: false, error: 'request body could not be read' }));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return finish({ ok: true, body: {} });
      try { return finish({ ok: true, body: JSON.parse(raw) }); }
      catch { return finish({ ok: false, error: 'request body is not valid JSON' }); }
    });
  });
}

/**
 * Map one `lib/dashboard-api.mjs` envelope onto an HTTP response.
 * @param {any} res @param {Record<string, any>} cfg @param {Record<string, any>} r
 */
function upstream(res, cfg, r) {
  if (r && r.ok) return sendJson(res, 200, r.data, cfg);
  const status = Number(r && r.status) || 503;
  return sendError(res, status, String(r?.code ?? 'upstream_unreachable'), String(r?.message ?? ''), cfg);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** @param {string[]} argv */
export function parseArgs(argv = []) {
  const args = argv.slice();
  const has = (f) => args.includes(f);
  return {
    mode: has('--serve') ? 'serve'
      : has('--stop') ? 'stop'
        : has('--status') ? 'status'
          : has('--foreground') ? 'foreground'
            : 'launch',
    json: has('--json'),
    open: !has('--no-open'),
  };
}

/**
 * Is the server described by a state file actually there, and actually ours?
 *
 * A pid alone is not enough: pids are recycled, and `--stop` reading a stale file would send
 * SIGTERM to whatever inherited the number. Answering `/api/ping` with our own token is proof
 * of identity, so nothing is killed on the strength of a file.
 *
 * @param {{port: number, token: string}|null} state
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{alive: boolean, pid?: number, startedAt?: number}>}
 */
export async function probe(state, fetchImpl = fetch) {
  if (!state) return { alive: false };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    timer.unref?.();
    const res = await fetchImpl(`http://127.0.0.1:${state.port}/api/ping`, {
      headers: { authorization: `Bearer ${state.token}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { alive: false };
    const body = await res.json();
    if (body?.service !== 'mubit-dashboard') return { alive: false };
    return { alive: true, pid: Number(body.pid), startedAt: Number(body.startedAt) };
  } catch {
    return { alive: false };
  }
}

/** @param {string} url */
function defaultOpen(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
      : 'xdg-open';
  const child = spawn(cmd, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
  child.on('error', () => { /* no browser here; the caller already printed the URL */ });
  child.unref();
}

const selfPath = fileURLToPath(import.meta.url);

/**
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 * @param {{log?: (m: string) => void, openImpl?: (url: string) => any, fetchImpl?: typeof fetch,
 *          spawnImpl?: typeof spawn, cfg?: Record<string, any>, scriptPath?: string,
 *          idleMs?: number, launchTimeoutMs?: number}} [deps]
 * @returns {Promise<number>} process exit code
 */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const log = deps.log ?? console.log;
  const cfg = deps.cfg ?? loadConfig(env);
  const args = parseArgs(argv);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const emit = (payload) => log(args.json ? JSON.stringify(payload) : payload.detail);

  if (args.mode === 'status') {
    const state = readState(cfg);
    const live = await probe(state, fetchImpl);
    if (!live.alive) {
      // A file describing a server that is not there is stale, not a state to preserve.
      if (state) clearState(cfg);
      emit({ ok: false, running: false, detail: 'The Mubit dashboard is not running.' });
      return 1;
    }
    emit({
      ok: true, running: true, port: state?.port, pid: live.pid,
      url: launchUrl(state),
      detail: `The Mubit dashboard is running at ${launchUrl(state)}`,
    });
    return 0;
  }

  if (args.mode === 'stop') {
    const state = readState(cfg);
    const live = await probe(state, fetchImpl);
    if (!live.alive || !state) {
      if (state) clearState(cfg);
      emit({ ok: true, running: false, detail: 'The Mubit dashboard was not running.' });
      return 0;
    }
    const stopped = await stop(state, live, fetchImpl);
    clearState(cfg);
    emit({
      ok: stopped, running: false,
      detail: stopped
        ? 'Stopped the Mubit dashboard.'
        : `Could not stop the dashboard on port ${state.port}; its process may already be gone.`,
    });
    return stopped ? 0 : 1;
  }

  if (args.mode === 'serve' || args.mode === 'foreground') {
    const started = await startServer({
      cfg,
      env,
      idleMs: deps.idleMs,
      onShutdown: () => { clearState(cfg); process.exit(0); },
    });
    const state = {
      pid: process.pid,
      port: started.port,
      token: started.token,
      startedAt: Date.now(),
      url: started.url,
    };
    writeState(cfg, state);

    const bye = () => { clearState(cfg); started.close().then(() => process.exit(0)); };
    process.on('SIGTERM', bye);
    process.on('SIGINT', bye);

    if (args.mode === 'foreground') {
      emit({ ok: true, running: true, port: started.port, url: launchUrl(state), detail: launchUrl(state) });
    }
    // `serve` says nothing: it is the detached child, and its stdout goes to /dev/null.
    return 0;
  }

  // --- launch --------------------------------------------------------------

  const existing = readState(cfg);
  const live = await probe(existing, fetchImpl);
  if (live.alive && existing) {
    const url = launchUrl(existing);
    if (args.open) openBrowser(url, deps, log);
    emit({ ok: true, running: true, reused: true, port: existing.port, url, detail: describe(url, cfg, true) });
    return 0;
  }

  // A file that failed the probe describes a server that is gone. It is removed before the
  // spawn so the wait below cannot mistake the stale one for the new child.
  if (existing) clearState(cfg);

  const script = deps.scriptPath ?? selfPath;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const child = spawnImpl(process.execPath, [script, '--serve'], {
    detached: true,
    stdio: 'ignore',
    env: { ...env },
  });
  child.unref?.();

  const state = await waitForState(cfg, deps.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS);
  if (!state) {
    emit({
      ok: false, running: false,
      detail: 'The dashboard did not start within '
        + `${deps.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS}ms. Run it in the foreground to see why: `
        + `node "${script}" --foreground`,
    });
    return 1;
  }

  const url = launchUrl(state);
  if (args.open) openBrowser(url, deps, log);
  emit({ ok: true, running: true, reused: false, port: state.port, url, detail: describe(url, cfg, false) });
  return 0;
}

/**
 * Ask the server to stop, and fall back to a signal.
 *
 * The HTTP route is preferred because it proves, by answering, that the thing being stopped is
 * the thing the state file describes. The signal is the fallback for a process that is wedged
 * enough not to answer but alive enough to have passed the probe a moment ago.
 *
 * @param {{port: number, token: string}} state
 * @param {{pid?: number}} live
 * @param {typeof fetch} fetchImpl
 */
async function stop(state, live, fetchImpl) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${state.port}/api/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${state.token}` },
    });
    if (res.ok) return true;
  } catch { /* fall through to the signal */ }
  const pid = Number(live.pid);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
}

/**
 * Wait for the detached child to publish its port and token.
 * @param {Record<string, any>} cfg
 * @param {number} timeoutMs
 */
async function waitForState(cfg, timeoutMs) {
  const deadline = Date.now() + Math.max(200, timeoutMs);
  while (Date.now() < deadline) {
    const s = readState(cfg);
    if (s && (await probe(s)).alive) return s;
    await sleep(60);
  }
  return null;
}

/**
 * Deliberately NOT unref'd.
 *
 * The launcher's only remaining work is this wait: the child is detached and its handles
 * belong to another process, and the parent holds nothing else. An unref'd timer here lets the
 * event loop drain out from under the top-level `await main()`, and Node exits 13 with
 * "Detected unsettled top-level await" instead of printing a URL.
 */
function sleep(ms) {
  return new Promise((r) => { setTimeout(r, ms); });
}

/** @param {{url?: string, port: number, token: string}|null} state */
function launchUrl(state) {
  if (!state) return '';
  return `http://127.0.0.1:${state.port}/?token=${encodeURIComponent(state.token)}`;
}

function openBrowser(url, deps, log) {
  const openImpl = deps.openImpl ?? defaultOpen;
  try { openImpl(url); } catch { log(`Open this in your browser:\n  ${url}`); }
}

/** @param {string} url @param {Record<string, any>} cfg @param {boolean} reused */
function describe(url, cfg, reused) {
  const lines = [
    reused ? 'The Mubit dashboard is already running:' : 'Mubit dashboard:',
    `  ${url}`,
    '',
    'Loopback only, and the token in that URL is the whole of its access control — it is minted',
    'per launch and is not stored anywhere a browser can read it back.',
  ];
  if (!isConfigured(cfg)) {
    lines.push('',
      'No Mubit endpoint is configured, so the lessons and activity tabs will show a banner.',
      'The local tabs — turns, analytics, ingest health — work regardless. Run /mubit-memory:auth');
  }
  lines.push('', 'Stop it with:  node "$CLAUDE_PLUGIN_ROOT/bin/dashboard.mjs" --stop');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Guarded the same way as `bin/auth.src.mjs`: the tests import this module and drive `main()`
// with injected dependencies, so it must not run itself on import.
const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';

if (entryPath === selfPath) {
  process.exitCode = await main().catch((err) => {
    console.log(`The dashboard could not start: ${err?.message ?? err}`);
    return 1;
  });
}
