// @ts-check
/**
 * `lib/dashboard-data.mjs` — the local half of `/mubit-memory:dashboard`.
 *
 * Everything the dashboard can answer without a network: which data directories exist, which
 * runs are in them, what each prompt's recall cost, how deep the spool is, and what the
 * breaker thinks. It is the same join `scripts/mubit-inspect.mjs` prints to a terminal, with
 * two differences that matter:
 *
 *   1. **Text leaves this module for a browser page.** Every prompt, term and error string is
 *      pushed through `redactText` with a *literal* policy — never the user's `cfg`. A user
 *      who set `redact: false` did so to let their own secrets reach their own Mubit instance
 *      over TLS; that is not consent to render them into an HTML page. `BROWSER_REDACTION` is
 *      frozen for the same reason.
 *   2. **One function writes.** `appendRollup` is the single exception to the read-only rule,
 *      and it is confined to `<dataDir>/dashboard/`. It exists because turn files are pruned
 *      at six hours, so the raw series cannot carry a trend line; the rollup is the dashboard
 *      keeping its own history of what it saw. Nothing else in the plugin reads or writes
 *      that directory, and it is outside `lib/state.mjs`'s TTL table, so the cap below is the
 *      only thing bounding it.
 *
 * Everything else here is a pure read, and the choice of neighbour is deliberate in three
 * places where the obvious call mutates: `readMarker` not `updateMarker`, `readBreaker` not
 * `allowRequest`, `spoolStats` not `readBatch`. A dashboard poll that drained a spool or
 * spent a half-open probe would change the behaviour of the thing it is supposed to observe.
 *
 * Zero dependencies, Node >= 20 built-ins only, no import outside `lib/`.
 */

import {
  appendFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { readBreaker } from './breaker.mjs';
import { readMarker } from './markers.mjs';
import { redactText } from './redact.mjs';
import { spoolStats } from './spool.mjs';
import { ensureDir, readJson, runDir, safeSegment } from './state.mjs';

/** How much of a prompt the list view carries. Enough to recognise a turn, not to read it. */
export const PREVIEW_BYTES = 480;

/** How much of a prompt the detail view carries, once the user has clicked through. */
export const DETAIL_BYTES = 8192;

/** The one directory this module writes under, relative to a data dir. */
export const ROLLUP_DIR = 'dashboard';

/** Rows kept in one rollup file. Beyond this the oldest are dropped on the next append. */
export const ROLLUP_MAX_ROWS = 5000;

/** Bytes kept in one rollup file, whichever cap bites first. */
export const ROLLUP_MAX_BYTES = 512 * 1024;

/**
 * The redaction policy every string served to the browser is scrubbed under.
 *
 * Frozen, and deliberately not derived from `cfg`. `redactText` honours `cfg.redact === false`
 * by skipping the scrub entirely, so passing the live config here would render a live key into
 * a web page for exactly the users who opted out of scrubbing — the people most likely to have
 * one in a prompt. `maxOutputBytes` is overridden per call site; `redact` never is.
 */
export const BROWSER_REDACTION = Object.freeze({ redact: true, maxOutputBytes: PREVIEW_BYTES });

/** The default marker's cooldown, mirrored so a derived breaker phase needs no config. */
const DEFAULT_COOLDOWN_MS = 120000;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Scrub and cap one string on its way to the browser.
 *
 * @param {any} text
 * @param {number} [maxBytes]
 * @returns {{text: string, redactions: number, truncated: boolean}}
 */
export function redactForBrowser(text, maxBytes = PREVIEW_BYTES) {
  const cap = Number.isFinite(maxBytes) && Number(maxBytes) > 0
    ? Math.trunc(Number(maxBytes))
    : PREVIEW_BYTES;
  const r = redactText(text, { ...BROWSER_REDACTION, maxOutputBytes: cap }, 'output');
  return { text: r.text, redactions: r.redactions, truncated: r.truncated };
}

/** The same, for a list of short strings (recall terms, which are prompt-derived). */
function redactTerms(list, maxBytes = 120) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 64).map((t) => redactForBrowser(t, maxBytes).text);
}

// ---------------------------------------------------------------------------
// Filesystem primitives — lifted from `scripts/mubit-inspect.mjs`, which already
// degrades correctly on every one of these paths.
// ---------------------------------------------------------------------------

/** @param {string} path @returns {string[]} */
export function lsDir(path) {
  try { return readdirSync(path); } catch { return []; }
}

/** @param {string} path @returns {number} mtime in epoch ms, or 0 */
function mtimeOf(path) {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

/** @param {string} path @returns {boolean} */
function isDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** @param {any} v @returns {number} */
function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Data directories
// ---------------------------------------------------------------------------

/**
 * `~/.claude/plugins/data` — the parent every install writes a directory under.
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function dataRoot(env = process.env) {
  const home = (env && typeof env.HOME === 'string' && env.HOME) ? env.HOME : safeHome();
  return join(home, '.claude', 'plugins', 'data');
}

function safeHome() {
  try { return homedir(); } catch { return '.'; }
}

/**
 * One data directory, described.
 * @param {string} path
 * @returns {{path: string, name: string, lastWrite: number, runCount: number}}
 */
export function describeDataDir(path) {
  const markers = lsDir(join(path, 'status')).filter(isRunMarker);
  let lastWrite = 0;
  for (const f of markers) {
    const m = readJson(join(path, 'status', f), null);
    const at = num(m && m.updated_at);
    if (at > lastWrite) lastWrite = at;
  }
  if (!lastWrite) lastWrite = mtimeOf(path);
  return { path, name: basename(path), lastWrite, runCount: markers.length };
}

/** `health.json` is the endpoint probe cache, not a run. */
function isRunMarker(file) {
  return file.endsWith('.json') && file !== 'health.json';
}

/**
 * Every data directory the plugin might have written, newest first.
 *
 * `--plugin-dir` installs write to a `-inline` suffix and a marketplace install writes to
 * `-<marketplace>`, so the bare `mubit-memory` is only one of several and is usually not the
 * live one. The config's own resolved dir is always included and always first in the scan,
 * because `MUBIT_CC_DATA_DIR` can point anywhere at all.
 *
 * @param {{cfg?: Record<string, any>, env?: Record<string, string|undefined>, pin?: string}} [opts]
 * @returns {Array<{path: string, name: string, lastWrite: number, runCount: number, isDefault: boolean}>}
 */
export function listDataDirs(opts = {}) {
  const { cfg = {}, env = process.env, pin = '' } = opts;

  /** @type {string[]} */
  const candidates = [];
  if (pin) {
    candidates.push(pin);
  } else {
    // `cfg.dataDir` rather than `resolveDataDir(cfg)`: the latter falls back to `process.env`,
    // which would make this function's answer depend on the ambient shell even when a caller
    // handed it an explicit `env`. The scan below is what covers the no-config case.
    const live = (cfg && typeof cfg.dataDir === 'string' && cfg.dataDir) ? cfg.dataDir : '';
    if (live) candidates.push(live);
    const root = dataRoot(env);
    for (const name of lsDir(root)) {
      if (name.startsWith('mubit-memory')) candidates.push(join(root, name));
    }
  }

  /** @type {Map<string, ReturnType<typeof describeDataDir>>} */
  const seen = new Map();
  for (const p of candidates) {
    if (seen.has(p) || !isDir(p)) continue;
    seen.set(p, describeDataDir(p));
  }

  const dirs = [...seen.values()].sort((a, b) => b.lastWrite - a.lastWrite);

  // The default is the directory the launching session is actually writing to, when there is
  // one. Falling back to "whichever was written to most recently" is right for a bare launch
  // with no config, and wrong the moment somebody pins `MUBIT_CC_DATA_DIR` and finds the page
  // opened on a different install — a second Claude Code session two directories over updates
  // its marker every prompt and would win the race every time.
  const live = (cfg && typeof cfg.dataDir === 'string') ? cfg.dataDir : '';
  const preferred = pin || (dirs.some((d) => d.path === live) ? live : (dirs[0] ? dirs[0].path : ''));
  return dirs.map((d) => ({ ...d, isDefault: d.path === preferred }));
}

/**
 * Resolve a `?dir=` parameter against the directories that actually exist.
 *
 * The whole path-safety story for `dir` is here: an arbitrary string is never joined onto
 * anything. It is compared against a list this process built by reading the filesystem, and
 * anything that is not in that list resolves to the default instead. A `../` cannot survive
 * an equality test.
 *
 * @param {string} wanted
 * @param {Array<{path: string, name: string, isDefault: boolean}>} dirs
 * @returns {string} an existing data dir path, or `''` when there are none at all
 */
export function resolveDirParam(wanted, dirs) {
  const list = Array.isArray(dirs) ? dirs : [];
  if (!list.length) return '';
  const want = typeof wanted === 'string' ? wanted.trim() : '';
  if (want) {
    const hit = list.find((d) => d.path === want || d.name === want);
    if (hit) return hit.path;
  }
  return (list.find((d) => d.isDefault) ?? list[0]).path;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * Runs are enumerated from `status/`, not `runs/`.
 *
 * The marker is the only file guaranteed to exist for a run: a session that recalled and never
 * captured has no `runs/<id>/` at all, and a run whose turns have aged past six hours has an
 * empty one. `scripts/mubit-inspect.mjs` settled this the same way.
 *
 * @param {string} dir
 * @returns {Array<Record<string, any>>}
 */
export function runsIn(dir) {
  return lsDir(join(dir, 'status')).filter(isRunMarker).map((f) => {
    const runId = f.slice(0, -5);
    const cfg = { dataDir: dir };
    const marker = readMarker(cfg, runId);
    const rd = runDir(cfg, runId);
    const turns = lsDir(join(rd, 'turns')).filter((n) => n.endsWith('.json'));
    return {
      runId,
      dir,
      dirName: basename(dir),
      lastWrite: num(marker.updated_at) || mtimeOf(join(dir, 'status', f)),
      turnCount: turns.length,
      spoolDepth: spoolStats(cfg, runId).count,
      state: String(marker.state || 'unknown'),
      mode: String(marker.mode || ''),
    };
  }).sort((a, b) => b.lastWrite - a.lastWrite);
}

/**
 * Every run across every given directory, newest first.
 * @param {Array<{path: string}>} dirs
 * @returns {Array<Record<string, any>>}
 */
export function listRuns(dirs) {
  return (Array.isArray(dirs) ? dirs : [])
    .flatMap((d) => runsIn(d.path))
    .sort((a, b) => b.lastWrite - a.lastWrite);
}

/**
 * The newest run in a directory, or `''`.
 * @param {string} dir
 * @returns {string}
 */
export function newestRun(dir) {
  const runs = runsIn(dir);
  return runs.length ? String(runs[0].runId) : '';
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * The one field the outcome path spreads across five keys, collapsed to a word.
 *
 * `api:<error>` comes first because it is the only one that explains itself: a turn the API
 * killed is closed AND stays `outcome_pending` forever, since `lib/outcome.mjs` suppresses its
 * outcome rather than sending one. Reading that as plain `pending` looks like a flush that
 * never happened.
 *
 * @param {Record<string, any>} turn
 * @returns {string}
 */
export function outcomeState(turn) {
  if (turn.outcome_abandoned === true) return 'dropped';
  if (num(turn.outcome_sent_at) > 0) return 'sent';
  if (typeof turn.api_error === 'string' && turn.api_error) return `api:${turn.api_error}`;
  if (turn.outcome_pending === true) return 'pending';
  if (turn.ended_at) return 'none';
  return '';
}

/**
 * `used_evidence`, kept tri-state.
 *
 * `used: undefined` means the signal could not be measured — no reply to compare against, or
 * no distinct vocabulary to look for — and it is *not* `false`. The dashboard renders `null`
 * as a blank cell for exactly that reason: `memory-term-echo/v1` is a proxy whose false
 * negatives dominate, and painting an unmeasurable turn as "unused" would libel the retrieval
 * path with the one number the page makes look authoritative.
 *
 * @param {Record<string, any>} turn
 * @returns {{measured: boolean, used: boolean|null, matched: number, candidates: number,
 *            method: string, reason: string, label: string}}
 */
export function usedSignal(turn) {
  const u = turn && typeof turn.used_evidence === 'object' && turn.used_evidence
    ? turn.used_evidence : null;
  if (!u) {
    return { measured: false, used: null, matched: 0, candidates: 0, method: '', reason: '', label: '' };
  }
  const matched = num(u.matched);
  const candidates = num(u.candidates);
  const used = u.used === true ? true : u.used === false ? false : null;
  return {
    measured: used !== null,
    used,
    matched,
    candidates,
    method: String(u.method || ''),
    reason: String(u.reason || ''),
    label: used === true ? `${matched}/${candidates} yes`
      : used === false ? `${matched}/${candidates} no`
        : `${matched}/${candidates} ?`,
  };
}

/**
 * One turn file, flattened.
 *
 * Four hooks write this record in read-modify-write merges with no ordering guarantee, which
 * is why every field but `prompt`, `prompt_id`, `session_id`, `started_at` and `recalled[]` is
 * optional here. `recall.ms` is deliberately absent: it is written to the status marker only,
 * so it describes the *last* prompt rather than this one, and a per-prompt latency series
 * cannot be reconstructed from these files at all.
 *
 * @param {Record<string, any>} turn
 * @param {{previewBytes?: number}} [opts]
 * @returns {Record<string, any>}
 */
export function turnRow(turn, opts = {}) {
  const t = (turn && typeof turn === 'object') ? turn : {};
  const r = (t.recall && typeof t.recall === 'object') ? t.recall : {};
  const preview = redactForBrowser(t.prompt, opts.previewBytes ?? PREVIEW_BYTES);
  const startedAt = num(t.started_at);
  const endedAt = num(t.ended_at);
  return {
    promptId: String(t.prompt_id || ''),
    sessionId: String(t.session_id || ''),
    startedAt,
    endedAt,
    turnMs: startedAt && endedAt ? endedAt - startedAt : 0,
    promptPreview: preview.text,
    promptTruncated: preview.truncated || t.prompt_truncated === true,
    promptRedactions: preview.redactions,
    rung: num(r.rung),
    sources: num(r.sources),
    tok: num(r.tokens),
    chars: num(r.chars),
    dropped: num(r.dropped),
    // How many of `sources` were repeats rendered as a one-line pointer because this run had
    // already injected them. Without it a falling `tok` is unattributable: a block that shrank
    // because the seen-set worked reads exactly like one that shrank because recall found half
    // as much.
    ptr: num(r.pointers),
    emptyReason: String(r.empty_reason || ''),
    recalledAt: num(r.at),
    recalled: Array.isArray(t.recalled) ? t.recalled.map(String) : [],
    recalledCount: Array.isArray(t.recalled) ? t.recalled.length : 0,
    used: usedSignal(t),
    outcomeState: outcomeState(t),
    outcomeAttempts: num(t.outcome_attempts),
    apiError: String(t.api_error || ''),
  };
}

/**
 * Turn rows for one run, newest first.
 * @param {string} dir
 * @param {string} runId
 * @param {{limit?: number}} [opts]
 * @returns {Array<Record<string, any>>}
 */
export function turnRows(dir, runId, opts = {}) {
  const limit = clampInt(opts.limit, 1, 1000, 100);
  return rawTurns(dir, runId, limit)
    .sort((a, b) => num(b.started_at) - num(a.started_at))
    .slice(0, limit)
    .map((t) => turnRow(t));
}

/**
 * Every turn file for a run, unsorted and unredacted, bounded by how many the caller will use.
 *
 * Internal: nothing here reaches a browser without going through `turnRow` or `turnDetail`.
 *
 * The bound matters because this is the disk poll's inner loop. Turn files live six hours, so a
 * heavy session leaves a few hundred of them, and a page open for half an hour at one poll a
 * second would otherwise read and parse every one of them eighteen hundred times. When there
 * are visibly more files than the caller wants, they are ranked by mtime — a `stat` rather than
 * a read and a parse — and only the newest slice is opened.
 *
 * mtime is not `started_at`: a turn file is written when the prompt arrives and updated when it
 * ends, so mtime tracks the *end*. That makes it the wrong sort key and a perfectly good filter,
 * which is why the slice is deliberately generous and the real ordering happens on the parsed
 * records afterwards.
 *
 * @param {string} dir
 * @param {string} runId
 * @param {number} [want] how many records the caller will keep; 0 means all of them
 * @returns {Array<Record<string, any>>}
 */
function rawTurns(dir, runId, want = 0) {
  const tdir = join(runDir({ dataDir: dir }, runId), 'turns');
  let names = lsDir(tdir).filter((f) => f.endsWith('.json'));

  if (want > 0 && names.length > want * 3) {
    names = names
      .map((f) => ({ f, at: mtimeOf(join(tdir, f)) }))
      .sort((x, y) => y.at - x.at)
      .slice(0, want * 2)
      .map((e) => e.f);
  }

  return names
    .map((f) => readJson(join(tdir, f), null))
    .filter((t) => t && typeof t === 'object' && !Array.isArray(t));
}

/**
 * One turn in full, with every prompt-derived string scrubbed.
 *
 * `recall.terms` and `used_evidence.terms` are extracted from the prompt, so they carry
 * whatever the prompt carried and are redacted on the same policy as the prompt itself.
 *
 * @param {string} dir
 * @param {string} runId
 * @param {string} promptId
 * @returns {Record<string, any>|null}
 */
export function turnDetail(dir, runId, promptId) {
  const id = safeSegment(promptId);
  if (!id) return null;
  const p = join(runDir({ dataDir: dir }, runId), 'turns', `${id}.json`);
  const t = readJson(p, null);
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;

  const prompt = redactForBrowser(t.prompt, DETAIL_BYTES);
  const recall = (t.recall && typeof t.recall === 'object') ? t.recall : null;
  const used = (t.used_evidence && typeof t.used_evidence === 'object') ? t.used_evidence : null;

  return {
    ...turnRow(t, { previewBytes: DETAIL_BYTES }),
    prompt: prompt.text,
    promptTruncated: prompt.truncated || t.prompt_truncated === true,
    recall: recall ? { ...recall, terms: redactTerms(recall.terms) } : null,
    usedEvidence: used ? { ...used, terms: redactTerms(used.terms) } : null,
    outcomeSentAt: num(t.outcome_sent_at),
    outcomePending: t.outcome_pending === true,
    outcomeAbandoned: t.outcome_abandoned === true,
  };
}

// ---------------------------------------------------------------------------
// Local health
// ---------------------------------------------------------------------------

/**
 * The read-only half of the health tab.
 *
 * Three neighbours here have a mutating twin and the wrong one is the obvious one:
 *
 *   - `spoolStats` is a `readdir`. `readBatch` unlinks anything it cannot parse, so a health
 *     poll built on it would delete a user's captures as a side effect of looking at them.
 *   - `readBreaker` is documented pure. `allowRequest` spends the half-open probe.
 *   - `status/health.json` is read straight off disk rather than through `http.health()`,
 *     which writes that file as its 30-second verdict cache.
 *
 * @param {Record<string, any>} cfg  the live config, for the endpoint the breaker is keyed by
 * @param {string} dir
 * @param {string} runId
 * @returns {Record<string, any>}
 */
export function localHealth(cfg, dir, runId) {
  const scoped = { ...cfg, dataDir: dir };
  const id = safeSegment(runId);
  const marker = id ? readMarker(scoped, id) : readMarker(scoped, '');
  const rd = runDir(scoped, id);

  const coldStartUntil = num(marker.cold_start_until);
  const breaker = readBreaker(scoped, { coldStartUntil });
  const spool = id ? spoolStats(scoped, id) : { count: 0, oldestMs: 0 };

  return {
    dir,
    dirName: basename(dir),
    runId: id,
    marker,
    spoolDepth: spool.count,
    spoolOldestMs: spool.oldestMs,
    rejectedCount: lsDir(join(rd, 'spool', 'rejected')).filter((f) => f.endsWith('.json')).length,
    jobs: jobsFor(dir, id),
    breaker: { ...breaker, ...breakerPhase(breaker, cfg) },
    // Every breaker file in the directory, because the state is keyed by endpoint: a machine
    // that has pointed at more than one instance keeps more than one, and the one `readBreaker`
    // found is only the one matching the config in force right now.
    breakers: breakersIn(dir),
    coldStart: {
      until: coldStartUntil,
      active: coldStartUntil > 0 && Date.now() < coldStartUntil,
    },
    // The endpoint probe cache, read rather than refreshed. Calling `health()` would rewrite it.
    healthCache: readJson(join(dir, 'status', 'health.json'), null),
  };
}

/**
 * `openedAt > 0` alone does not mean open.
 *
 * Once the cooldown has elapsed the breaker is half-open and the next call goes through, so
 * the age has to be read too — and the clock runs from the later of "when it opened" and "when
 * the last probe was spent", which is what `allowRequest` compares against.
 *
 * @param {{openedAt?: number, probeAt?: number}} breaker
 * @param {Record<string, any>} cfg
 */
function breakerPhase(breaker, cfg) {
  const cooldownMs = positive(cfg && cfg.breaker && cfg.breaker.cooldownMs, DEFAULT_COOLDOWN_MS);
  const openedAt = num(breaker && breaker.openedAt);
  if (!(openedAt > 0)) return { open: false, phase: 'closed', cooldownLeftMs: 0 };
  const since = Math.max(openedAt, num(breaker && breaker.probeAt));
  const left = cooldownMs - (Date.now() - since);
  return left > 0
    ? { open: true, phase: 'open', cooldownLeftMs: left }
    : { open: false, phase: 'half-open', cooldownLeftMs: 0 };
}

/** Every breaker record in a data dir, keyed by the endpoint each was written for. */
function breakersIn(dir) {
  return lsDir(join(dir, 'breaker'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const b = readJson(join(dir, 'breaker', f), null);
      if (!b || typeof b !== 'object') return null;
      return {
        file: f,
        state: String(b.state || 'ready'),
        failures: Array.isArray(b.failures) ? b.failures.length : 0,
        openedAt: num(b.openedAt),
        probeAt: num(b.probeAt),
        lastOkAt: num(b.lastOkAt),
        // `endpoint` is carried in the file purely so a directory of hash-named files is
        // readable by a human; it is the only place the dashboard can learn which instance a
        // non-current breaker belongs to.
        endpoint: String(b.endpoint || ''),
      };
    })
    .filter(Boolean);
}

/** @param {string} dir @param {string} runId */
function jobsFor(dir, runId) {
  if (!runId) return [];
  const j = readJson(join(runDir({ dataDir: dir }, runId), 'jobs.json'), []);
  return Array.isArray(j) ? j.slice(-25) : [];
}

// ---------------------------------------------------------------------------
// The rollup — the one thing the dashboard writes
// ---------------------------------------------------------------------------

/**
 * `<dataDir>/dashboard/rollup-<run_id>.jsonl`.
 *
 * `safeSegment` is applied here rather than trusted from the caller: this is a path built from
 * a run id, and a run id can arrive from a query string.
 *
 * @param {string} dir
 * @param {string} runId
 * @returns {string}
 */
export function rollupPath(dir, runId) {
  return join(dir, ROLLUP_DIR, `rollup-${safeSegment(runId) || 'unknown'}.jsonl`);
}

/**
 * The rollup row for a run's most recent turn, or `null` when there is nothing to record.
 *
 * @param {string} dir
 * @param {string} runId
 * @param {number} [now]
 * @returns {Record<string, any>|null}
 */
export function sampleFor(dir, runId, now = Date.now()) {
  // Only the newest turn is wanted, so the mtime filter above collapses this to a handful
  // of stats and a couple of reads however long the run has been going.
  const turns = rawTurns(dir, runId, 1);
  if (!turns.length) return null;
  let newest = turns[0];
  for (const t of turns) if (num(t.started_at) > num(newest.started_at)) newest = t;
  const r = (newest.recall && typeof newest.recall === 'object') ? newest.recall : {};
  return {
    at: now,
    run: safeSegment(runId),
    dir: basename(dir),
    // The prompt *id*, never its text: it is what makes the series one row per prompt rather
    // than one row per poll, and an opaque id carries nothing to redact.
    prompt: String(newest.prompt_id || ''),
    startedAt: num(newest.started_at),
    tok: num(r.tokens),
    chars: num(r.chars),
    ptr: num(r.pointers),
    rung: num(r.rung),
    sources: num(r.sources),
  };
}

/**
 * Append one row, unless it repeats the last one.
 *
 * The disk poll runs about once a second and turn files change only when a prompt is
 * submitted, so without the dedup a quiet hour would write three thousand identical rows and
 * the trend line would be a flat run of the same prompt. The comparison ignores `at`, which is
 * the only field that always differs.
 *
 * @param {string} dir
 * @param {string} runId
 * @param {Record<string, any>|null} sample
 * @returns {boolean} whether a row was written
 */
export function appendRollup(dir, runId, sample) {
  try {
    if (!sample || typeof sample !== 'object') return false;
    const p = rollupPath(dir, runId);
    const rows = readRollup(dir, runId);
    const last = rows.length ? rows[rows.length - 1] : null;
    if (last && sameSample(last, sample)) return false;

    if (!ensureDir(join(dir, ROLLUP_DIR))) return false;
    appendFileSync(p, `${JSON.stringify(sample)}\n`, 'utf8');
    capRollup(p, rows.length + 1);
    return true;
  } catch {
    // A dashboard that cannot write its own history still renders everything else.
    return false;
  }
}

/** Two samples describing the same prompt with the same numbers. */
function sameSample(a, b) {
  return a.prompt === b.prompt
    && a.tok === b.tok && a.chars === b.chars && a.ptr === b.ptr
    && a.rung === b.rung && a.sources === b.sources;
}

/**
 * Hold the file to `ROLLUP_MAX_ROWS` rows and `ROLLUP_MAX_BYTES` bytes, whichever bites first.
 *
 * This file is outside `lib/state.mjs`'s TTL table — nothing prunes it but this — so an
 * uncapped append here is a file that grows for as long as the plugin is installed.
 *
 * @param {string} p
 * @param {number} approxRows
 */
function capRollup(p, approxRows) {
  try {
    let size = 0;
    try { size = statSync(p).size; } catch { size = 0; }
    if (approxRows <= ROLLUP_MAX_ROWS && size <= ROLLUP_MAX_BYTES) return;
    const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    const kept = lines.slice(-Math.floor(ROLLUP_MAX_ROWS / 2));
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
    renameSync(tmp, p);
  } catch {
    // Leaving an oversized file is better than losing the history mid-rewrite.
  }
}

/**
 * The rollup series for a run, oldest first.
 *
 * @param {string} dir
 * @param {string} runId
 * @param {number} [since] epoch ms; rows older than this are dropped
 * @returns {Array<Record<string, any>>}
 */
export function readRollup(dir, runId, since = 0) {
  const p = rollupPath(dir, runId);
  if (!existsSync(p)) return [];
  let raw = '';
  try { raw = readFileSync(p, 'utf8'); } catch { return []; }
  const from = num(since);
  /** @type {Array<Record<string, any>>} */
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    // A row torn by a crash mid-append is normal and costs exactly itself.
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (from > 0 && num(row.at) < from) continue;
    out.push(row);
  }
  return out;
}

/**
 * The analytics payload: the rollup series plus the aggregates the tiles show.
 *
 * There is no latency series and there is no latency tile. `recall.ms` exists on the status
 * marker and on subagent records, never on a turn, so per-prompt timing is not recorded
 * anywhere on disk — the honest thing is to omit it rather than to plot the last prompt's
 * number against every prompt.
 *
 * @param {string} dir
 * @param {string} runId
 * @param {{since?: number}} [opts]
 * @returns {Record<string, any>}
 */
export function analytics(dir, runId, opts = {}) {
  const series = readRollup(dir, runId, num(opts.since));
  const n = series.length;
  const sum = (k) => series.reduce((acc, row) => acc + num(row[k]), 0);
  const last = n ? series[n - 1] : null;

  const sources = sum('sources');
  return {
    dir,
    runId: safeSegment(runId),
    series,
    points: n,
    totals: {
      tok: sum('tok'),
      chars: sum('chars'),
      ptr: sum('ptr'),
      sources,
    },
    averages: {
      tok: n ? Math.round(sum('tok') / n) : 0,
      chars: n ? Math.round(sum('chars') / n) : 0,
      // Memories per prompt, which is the number the seen-set moves.
      sources: n ? Number((sources / n).toFixed(2)) : 0,
    },
    // What share of injected memories were repeats rendered as a one-line pointer. A rising
    // ratio at a flat source count is the seen-set doing its job.
    pointerRatio: sources ? Number((sum('ptr') / sources).toFixed(3)) : 0,
    latest: last,
    // Stated rather than implied, because the rollup starts empty: it accrues from the first
    // launch and cannot reconstruct anything that happened before it.
    firstSampleAt: n ? num(series[0].at) : 0,
  };
}

// ---------------------------------------------------------------------------
// Shared coercion
// ---------------------------------------------------------------------------

/**
 * @param {any} v @param {number} lo @param {number} hi @param {number} dflt
 * @returns {number}
 */
export function clampInt(v, lo, hi, dflt) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function positive(v, dflt) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
