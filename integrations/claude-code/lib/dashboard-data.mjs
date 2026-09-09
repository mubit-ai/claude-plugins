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
 *   2. **Two functions write, both under `<dataDir>/dashboard/`.** `appendRollup` keeps the
 *      recall-cost trend the dashboard saw, and `appendVerdict` records a person's Worked /
 *      Did not work on a turn after the instance accepted it. Nothing else in the plugin reads
 *      or writes that directory, and it is outside `lib/state.mjs`'s TTL table, so the cap
 *      below is the only thing bounding either file.
 *   3. **The ledger sits behind the live turn files.** `runs/<run_id>/turns/*.json` is pruned
 *      at six hours; `runs/<run_id>/ledger.jsonl` (`lib/ledger.mjs`, appended by the Stop hook)
 *      keeps one row per closed turn for a month. Every turn read here is the join of the two,
 *      one row per prompt, the live file winning while it exists — so the Turns table, the
 *      per-lesson injection counts and the Overview all outlive the pruning, whether or not
 *      the dashboard was open when the turn happened.
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
import { LEDGER_FILE, readLedger } from './ledger.mjs';
import { readMarker } from './markers.mjs';
import { decideOutcome } from './outcome.mjs';
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
// Run identity — one directory, several run ids
// ---------------------------------------------------------------------------

/*
 * A directory's memory is spread over several ids. `per-directory` mints `cc-<slug>-<hash8>`
 * and `git-branch` mints `cc-<slug>-<branch>-<hash8>`; every `/clear` appends `-c<N>`
 * (`lib/runid.mjs`); every subagent gets `<parent>-sub-<id>`; and the activity feed spells
 * the same run `state::<uid>::cc-…`. Nothing on the page could say "this directory" until
 * those were folded back to one key. `bin/dashboard.html` carries the same two functions, and
 * `test/dashboard-page.test.mjs` pins the two copies to each other.
 */

/** The `state::<uid>::` namespace the activity feed and dereference put in front of a run. */
const FEED_PREFIX = /^state::[^:]*::/;

/** A subagent's marker suffix. */
const SUB_SUFFIX = /-sub-[a-z0-9]+$/;

/** A `/clear` counter. */
const CLEAR_SUFFIX = /-c(\d+)$/;

/**
 * The shape a `-c<N>` may be stripped from. A `static` id is a user string that may itself end
 * in `-c1`, so the counter goes only when what is left still looks like a directory key.
 */
const DIRECTORY_KEY = /^cc-.+-[0-9a-f]{8}$/;

/** @param {any} id @returns {string} the bare run id, without the feed's namespace */
export function plainRunId(id) {
  return String(id || '').replace(FEED_PREFIX, '');
}

/** @param {any} id @returns {string} the directory key every run of one directory shares */
export function baseRunId(id) {
  const s = plainRunId(id).replace(SUB_SUFFIX, '');
  const m = CLEAR_SUFFIX.exec(s);
  if (!m) return s;
  const head = s.slice(0, m.index);
  return DIRECTORY_KEY.test(head) ? head : s;
}

/** `N` from a `-c<N>` that `baseRunId` stripped, else 0. @param {string} id */
function clearIndexOf(id) {
  const s = plainRunId(id).replace(SUB_SUFFIX, '');
  const m = CLEAR_SUFFIX.exec(s);
  return m && baseRunId(id) === s.slice(0, m.index) ? Number(m[1]) : 0;
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
export function runsIn(dir, opts = {}) {
  // Read once and grouped, not once per run: the rail polls this every second.
  const byRun = opts && opts.sessions === true ? groupSessions(readSessionMap(dir)) : null;
  return lsDir(join(dir, 'status')).filter(isRunMarker).map((f) => {
    const runId = f.slice(0, -5);
    const cfg = { dataDir: dir };
    const marker = readMarker(cfg, runId);
    const rd = runDir(cfg, runId);
    const turns = lsDir(join(rd, 'turns')).filter((n) => n.endsWith('.json'));
    const row = {
      runId,
      dir,
      dirName: basename(dir),
      lastWrite: num(marker.updated_at) || mtimeOf(join(dir, 'status', f)),
      turnCount: turns.length,
      spoolDepth: spoolStats(cfg, runId).count,
      state: String(marker.state || 'unknown'),
      mode: String(marker.mode || ''),
    };
    if (byRun) {
      const sessions = byRun.get(runId) ?? [];
      Object.assign(row, {
        sessions,
        sessionCount: sessions.length,
        projectDir: firstNonEmpty(sessions, 'projectDir'),
        projectRoot: firstNonEmpty(sessions, 'projectRoot'),
        baseRunId: baseRunId(runId),
        clearIndex: clearIndexOf(runId),
        subagentCount: lsDir(join(rd, 'subagents')).filter((n) => n.endsWith('.json')).length,
      });
    }
    return row;
  }).sort((a, b) => b.lastWrite - a.lastWrite);
}

/**
 * Every run across every given directory, newest first.
 * @param {Array<{path: string}>} dirs
 * @param {{sessions?: boolean}} [opts]
 * @returns {Array<Record<string, any>>}
 */
export function listRuns(dirs, opts = {}) {
  return (Array.isArray(dirs) ? dirs : [])
    .flatMap((d) => runsIn(d.path, opts))
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
// Sessions — sessions/<host_session_id>.json
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SessionRow
 * @property {string} sessionId
 * @property {string} runId
 * @property {string} agentId
 * @property {string} strategy
 * @property {string} projectDir
 * @property {string} projectRoot  `''` on a record written before the field existed
 * @property {number} createdAt
 * @property {number} lastSeenAt
 * @property {string} mode
 * @property {number} clearCount
 * @property {string} endpointHash
 */

/**
 * Every host session recorded in a data dir, newest `last_seen_at` first.
 *
 * Deliberately not `loadSessionMap` from `lib/runid.mjs`: that one resolves the *ambient* data
 * dir from `process.env`, because every caller there is a hook. The dashboard serves whichever
 * directory `?dir=` selected, and a reader built on the hook helper would show one directory's
 * runs beside another directory's sessions.
 *
 * The record is mapped through a whitelist rather than spread. It is the one file in the data
 * dir that a future version might grow a field into, and a field this function has not heard
 * of is a field that reaches a browser without anyone deciding it should.
 *
 * @param {string} dir
 * @returns {SessionRow[]}
 */
export function readSessionMap(dir) {
  const sdir = join(dir, 'sessions');
  /** @type {SessionRow[]} */
  const out = [];
  for (const f of lsDir(sdir)) {
    if (!f.endsWith('.json')) continue;
    const rec = readJson(join(sdir, f), null);
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    out.push({
      sessionId: f.slice(0, -5),
      runId: String(rec.run_id || ''),
      agentId: String(rec.agent_id || ''),
      strategy: String(rec.strategy || ''),
      projectDir: String(rec.project_dir || ''),
      projectRoot: String(rec.project_root || ''),
      createdAt: num(rec.created_at),
      lastSeenAt: num(rec.last_seen_at),
      mode: String(rec.mode || ''),
      clearCount: num(rec.clear_count),
      endpointHash: String(rec.endpoint_hash || ''),
    });
  }
  return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * The sessions mapped to one run, newest first. The id is flattened first because it can
 * arrive from a query string, and an empty one matches nothing rather than everything.
 *
 * @param {string} dir
 * @param {string} runId
 * @returns {SessionRow[]}
 */
export function sessionsForRun(dir, runId) {
  const id = safeSegment(runId);
  if (!id) return [];
  return readSessionMap(dir).filter((s) => s.runId === id);
}

/**
 * The run the dashboard was launched *for*: the newest session whose project is the launch
 * directory, by git root or by exact directory. `''` when no session names it.
 *
 * @param {string} dir
 * @param {string} projectDir
 * @returns {string}
 */
export function launchRunFor(dir, projectDir) {
  const want = typeof projectDir === 'string' ? projectDir : '';
  if (!want) return '';
  const hit = readSessionMap(dir).find((s) => s.runId
    && (s.projectRoot === want || s.projectDir === want));
  return hit ? hit.runId : '';
}

/** @param {SessionRow[]} rows @returns {Map<string, SessionRow[]>} */
function groupSessions(rows) {
  /** @type {Map<string, SessionRow[]>} */
  const byRun = new Map();
  for (const s of rows) {
    if (!s.runId) continue;
    const list = byRun.get(s.runId);
    if (list) list.push(s); else byRun.set(s.runId, [s]);
  }
  return byRun;
}

/** The first non-empty value of `key` in a newest-first list. */
function firstNonEmpty(rows, key) {
  for (const r of rows) if (r[key]) return r[key];
  return '';
}

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

/**
 * Every run id in a directory that belongs with `runId`, newest first.
 *
 * Two rules, applied to a fixpoint. A run joins when its `baseRunId` matches a member's — that
 * is what groups `cc-x-<hash>`, its `-c<N>` clears and its `-sub-<id>` subagents. And a run
 * joins when a session record maps it to the same `projectRoot` as a member — that is what
 * groups a `static` or `per-conversation` run with the directory it was actually used in,
 * without guessing anything from the id. The asked id is a member even with no marker: a run
 * whose marker has aged out still has a family, and the caller still has a run.
 *
 * An id that would need flattening is not a run id, and gets an empty family rather than a
 * family for whatever it flattened to.
 *
 * @param {string} dir
 * @param {string} runId
 * @returns {{base: string, projectRoot: string, runIds: string[]}}
 */
export function familyOf(dir, runId) {
  const id = safeSegment(runId);
  if (!id || id !== String(runId)) return { base: '', projectRoot: '', runIds: [] };

  const known = new Map(runsIn(dir).map((r) => [String(r.runId), r]));
  // A run whose marker has expired (12 h) still belongs to its directory while its ledger is
  // on disk: that file is what the page reads for the month after the marker and the turns
  // are gone, and a family that forgot the run would lose those rows with it.
  for (const name of lsDir(join(dir, 'runs'))) {
    if (known.has(name) || safeSegment(name) !== name) continue;
    const ledger = join(dir, 'runs', name, LEDGER_FILE);
    if (existsSync(ledger)) known.set(name, { runId: name, lastWrite: mtimeOf(ledger) });
  }
  if (!known.has(id)) known.set(id, { runId: id, lastWrite: 0 });
  const byRun = groupSessions(readSessionMap(dir));
  const rootOf = (rid) => firstNonEmpty(byRun.get(rid) ?? [], 'projectRoot');

  const members = new Set([id]);
  const bases = new Set([baseRunId(id)]);
  const roots = new Set([rootOf(id)].filter(Boolean));
  let grew = true;
  while (grew) {
    grew = false;
    for (const rid of known.keys()) {
      if (members.has(rid)) continue;
      const root = rootOf(rid);
      if (!bases.has(baseRunId(rid)) && !(root && roots.has(root))) continue;
      members.add(rid);
      bases.add(baseRunId(rid));
      if (root) roots.add(root);
      grew = true;
    }
  }

  const runIds = [...members]
    .map((rid) => known.get(rid))
    .sort((a, b) => num(b.lastWrite) - num(a.lastWrite))
    .map((r) => String(r.runId));
  return { base: baseRunId(id), projectRoot: [...roots][0] ?? '', runIds };
}

// ---------------------------------------------------------------------------
// Subagents — runs/<run_id>/subagents/<sub_run_id>.json
// ---------------------------------------------------------------------------

/**
 * Every subagent record under a run, oldest first.
 *
 * `subagent-start.mjs` writes one per spawn, and nothing ever removes them — the directory is
 * outside `lib/state.mjs`'s TTL table — so a long-lived run holds every subagent it ever ran.
 * `since` bounds the read by mtime, which a caller attaching records to a window of turns
 * must pass: the records that matter were written after the oldest turn on the page started.
 *
 * Whitelisted, like the session record: a field nobody decided to serve is not served.
 *
 * @param {string} dir
 * @param {string} runId
 * @param {{since?: number}} [opts] epoch ms; records last written before this are skipped
 * @returns {Array<Record<string, any>>}
 */
export function readSubagents(dir, runId, opts = {}) {
  const id = safeSegment(runId);
  if (!id) return [];
  const sdir = join(runDir({ dataDir: dir }, id), 'subagents');
  const since = num(opts && opts.since);
  /** @type {Array<Record<string, any>>} */
  const out = [];
  for (const f of lsDir(sdir)) {
    if (!f.endsWith('.json')) continue;
    const p = join(sdir, f);
    if (since > 0 && mtimeOf(p) < since) continue;
    const rec = readJson(p, null);
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const r = (rec.recall && typeof rec.recall === 'object') ? rec.recall : {};
    const recalled = Array.isArray(rec.recalled) ? rec.recalled.map(String) : [];
    out.push({
      subRunId: String(rec.sub_run_id || f.slice(0, -5)),
      parentRunId: String(rec.parent_run_id || id),
      agentId: String(rec.agent_id || ''),
      mubitAgentId: String(rec.mubit_agent_id || ''),
      agentType: String(rec.agent_type || ''),
      sessionId: String(rec.session_id || ''),
      promptId: String(rec.prompt_id || ''),
      at: num(rec.at),
      recall: {
        rung: num(r.rung),
        sources: num(r.sources),
        tokens: num(r.tokens),
        chars: num(r.chars),
        pointers: num(r.pointers),
        ms: num(r.ms),
      },
      recalled,
      recalledCount: recalled.length,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Clock skew allowed between a turn's `started_at` and the mtime of a record written under it. */
const SUBAGENT_SLACK_MS = 60_000;

// ---------------------------------------------------------------------------
// Scope, in words
// ---------------------------------------------------------------------------

const STRATEGY_TEXT = {
  'per-directory': 'one run per directory; every session opened here shares it',
  'git-branch': 'one run per git branch',
  'per-conversation': 'one run per host session',
  static: 'a fixed run id from MUBIT_CC_RUN_ID',
};

const WRITES_AT_TEXT = {
  run: 'lessons an agent saves stay inside this run',
  session: 'lessons an agent saves can surface in later sessions of this project',
  global: 'lessons an agent saves are visible to every run on this instance',
};

// The 3 s figure is `CROSS_RUN_MIN_BUDGET_MS` in `lib/recall.mjs`, restated rather than
// imported: this module stays free of the recall path so it cannot be pulled into a hook.
const READS_ACROSS_TEXT = {
  auto: 'recall consults other runs when at least 3 s of budget remains',
  on: 'every recall consults other runs',
  off: 'recall never consults other runs; only the session-start briefing does',
};

/**
 * What this run writes at and reads from, as the three settings that decide it and one plain
 * sentence for each. The defaults are the config's own, so a bare `{}` describes a default
 * install rather than nothing.
 *
 * @param {Record<string, any>} cfg
 * @returns {{strategy: string, strategyText: string, writesAt: string, writesAtText: string,
 *            readsAcrossRuns: string, readsAcrossRunsText: string}}
 */
export function describeRunScope(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const strategy = String(c.runStrategy || 'per-directory');
  const writesAt = String(c.mcpLessonScope || 'session');
  const readsAcrossRuns = String(c.recallCrossRun || 'auto');
  return {
    strategy,
    strategyText: STRATEGY_TEXT[strategy] || `runs are keyed by the "${strategy}" strategy`,
    writesAt,
    writesAtText: WRITES_AT_TEXT[writesAt] || `lessons an agent saves are capped at "${writesAt}" scope`,
    readsAcrossRuns,
    readsAcrossRunsText: READS_ACROSS_TEXT[readsAcrossRuns]
      || `cross-run recall is set to "${readsAcrossRuns}"`,
  };
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
  const decided = decidedOutcome(t);
  return {
    promptId: String(t.prompt_id || ''),
    sessionId: String(t.session_id || ''),
    turnNumber: num(t.turn_number),
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
    // What the turn earned under `lib/outcome.mjs`'s rule — the automatic signal, whether or
    // not a post has happened yet. A verdict is reported beside it, never over it: the page
    // and `overview` both apply "verdict wins" from these two fields.
    outcome: decided.outcome,
    signal: decided.signal,
    source: 'live',
    verdict: '',
    verdictAt: 0,
    outcomeSentAt: num(t.outcome_sent_at),
  };
}

/** The four outcomes a row can carry. Anything else — a future `partial` included — reads as none. */
const OUTCOME_WORDS = new Set(['success', 'failure', 'neutral', 'none']);

/**
 * The outcome a turn earns under `lib/outcome.mjs`'s rule, read off the record with the
 * send-state keys removed. `outcome_sent_at` says whether a post happened; this says what
 * was, or would be, posted — the same computation `lib/ledger.mjs` stores. `post: false` for
 * any other reason (nothing injected, the API killed the turn) is `none`.
 *
 * @param {Record<string, any>} turn
 * @returns {{outcome: string, signal: number}}
 */
function decidedOutcome(turn) {
  const { outcome_sent_at: _sent, outcome_attempts: _tries, ...rest } = (turn && typeof turn === 'object') ? turn : {};
  const d = decideOutcome(rest);
  return d.post && OUTCOME_WORDS.has(String(d.outcome))
    ? { outcome: String(d.outcome), signal: num(d.signal) }
    : { outcome: 'none', signal: 0 };
}

/**
 * The outcome a turn counts as once a person has spoken: a verdict wins over the automatic
 * signal. This is the one rule the Turns table, the per-lesson counts and the Overview share,
 * restated on the page for the row it renders.
 *
 * @param {Record<string, any>} row a turn row
 * @returns {'success'|'failure'|'neutral'|'none'}
 */
export function effectiveOutcome(row) {
  const r = (row && typeof row === 'object') ? row : {};
  if (r.verdict === 'worked') return 'success';
  if (r.verdict === 'failed') return 'failure';
  const o = String(r.outcome || '');
  return /** @type {any} */ (OUTCOME_WORDS.has(o) ? o : 'none');
}

/**
 * One ledger `turn` row, flattened to exactly the keys `turnRow` produces — so the page reads
 * one shape whichever record answered. What the ledger never carried is honest here rather
 * than invented: `recalledAt` and `outcomeAttempts` are zero, `used` has no counts behind its
 * yes or no, and `outcomeState` is empty rather than "pending" for a turn whose delivery this
 * file did not record.
 *
 * @param {Record<string, any>} row
 * @param {{previewBytes?: number}} [opts]
 * @returns {Record<string, any>}
 */
export function ledgerTurnRow(row, opts = {}) {
  const r = (row && typeof row === 'object') ? row : {};
  const rc = (r.recall && typeof r.recall === 'object') ? r.recall : {};
  // Already scrubbed under the ledger's own policy; scrubbed again under the browser's, which
  // is cheap and keeps invariant 4 a property of this module rather than of the writer.
  const preview = redactForBrowser(r.prompt, opts.previewBytes ?? PREVIEW_BYTES);
  const startedAt = num(r.started_at);
  const endedAt = num(r.ended_at);
  const recalled = Array.isArray(r.recalled) ? r.recalled.map(String) : [];
  const apiError = String(r.api_error || '');
  const outcome = OUTCOME_WORDS.has(String(r.outcome)) ? String(r.outcome) : 'none';
  return {
    promptId: String(r.prompt_id || ''),
    sessionId: String(r.session_id || ''),
    turnNumber: num(r.turn_number),
    startedAt,
    endedAt,
    turnMs: startedAt && endedAt ? endedAt - startedAt : 0,
    promptPreview: preview.text,
    promptTruncated: preview.truncated || r.prompt_truncated === true,
    promptRedactions: preview.redactions + num(r.prompt_redactions),
    rung: num(rc.rung),
    sources: num(rc.sources),
    tok: num(rc.tokens),
    chars: num(rc.chars),
    dropped: num(rc.dropped),
    ptr: num(rc.pointers),
    emptyReason: String(rc.empty_reason || ''),
    recalledAt: 0,
    recalled,
    recalledCount: recalled.length,
    used: usedSignal(r.used === true || r.used === false ? { used_evidence: { used: r.used } } : {}),
    outcomeState: apiError ? `api:${apiError}` : outcome === 'none' ? 'none' : '',
    outcomeAttempts: 0,
    apiError,
    outcome,
    signal: num(r.signal),
    source: 'ledger',
    verdict: '',
    verdictAt: 0,
    outcomeSentAt: 0,
  };
}

/**
 * Every turn of a run — or, with `family`, of its directory — one row per prompt, from the
 * ledger and the live files together. Unsorted and unsliced; the callers sort, bound and join.
 *
 * The join order is the rule: ledger rows first (oldest first, so a prompt closed twice keeps
 * its newest row), live files last, so a turn that has both is read from the file the drain
 * is still updating. Then the delivered-outcome rows and the verdicts are folded onto
 * whichever row won, matched by prompt id — a prompt id is a UUID, so a verdict recorded
 * under a sibling run of the family still finds its turn.
 *
 * `since` is applied on `startedAt` at the end; on the ledger read it is applied on `at` as a
 * cheap pre-filter, and `at` is the close time, so nothing that should pass is dropped early.
 *
 * @param {string} dir
 * @param {string} runId
 * @param {{family?: boolean, since?: number, want?: number}} [opts] `want` bounds the live read
 *   the way `rawTurns` does; 0 reads every file
 * @returns {Array<Record<string, any>>}
 */
function gatherTurns(dir, runId, opts = {}) {
  const ids = opts.family === true
    ? familyOf(dir, runId).runIds
    : [safeSegment(runId)].filter(Boolean);
  const since = num(opts.since);
  const want = num(opts.want);

  /** @type {Map<string, Record<string, any>>} */
  const byPrompt = new Map();
  for (const id of ids) {
    for (const r of readLedger(dir, id, { since, kinds: ['turn'] })) {
      const pid = String(r.prompt_id || '');
      if (pid) byPrompt.set(pid, { ...ledgerTurnRow(r), runId: id });
    }
  }
  for (const id of ids) {
    for (const t of rawTurns(dir, id, want)) {
      const pid = String(t.prompt_id || '');
      if (pid) byPrompt.set(pid, { ...turnRow(t), runId: id });
    }
  }
  for (const id of ids) {
    for (const o of readLedger(dir, id, { kinds: ['outcome'] })) {
      const row = byPrompt.get(String(o.prompt_id || ''));
      if (!row) continue;
      if (num(o.at) > row.outcomeSentAt) row.outcomeSentAt = num(o.at);
      // A ledger-only row did not know whether its post landed; now it does.
      if (row.source === 'ledger') {
        row.outcomeState = 'sent';
        if (row.outcome === 'none' && OUTCOME_WORDS.has(String(o.outcome))) {
          row.outcome = String(o.outcome);
          row.signal = num(o.signal);
        }
      }
    }
    for (const v of readVerdicts(dir, id)) {
      const row = byPrompt.get(String(v.prompt || ''));
      if (!row || num(v.at) < row.verdictAt) continue;
      const word = v.verdict === 'worked' ? 'worked' : v.verdict === 'failed' ? 'failed' : '';
      if (!word) continue;
      row.verdict = word;
      row.verdictAt = num(v.at);
    }
  }

  /** @type {Array<Record<string, any>>} */
  const out = [];
  for (const row of byPrompt.values()) {
    if (since > 0 && row.startedAt > 0 && row.startedAt < since) continue;
    out.push(row);
  }
  return out;
}

/**
 * Turn rows for one run — or, with `family`, for every run of its directory — newest first,
 * from the ledger and the live files together (`gatherTurns`).
 *
 * Each row says which run it came from, which record answered (`source`), and which subagents
 * fanned out under its prompt. The subagent read is bounded to the window of turns returned,
 * never the whole directory.
 *
 * @param {string} dir
 * @param {string} runId
 * @param {{limit?: number, family?: boolean, since?: number}} [opts]
 * @returns {Array<Record<string, any>>}
 */
export function turnRows(dir, runId, opts = {}) {
  const limit = clampInt(opts.limit, 1, 1000, 100);
  const kept = gatherTurns(dir, runId, { family: opts.family === true, since: num(opts.since), want: limit })
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);

  let oldest = Infinity;
  for (const k of kept) if (k.startedAt > 0) oldest = Math.min(oldest, k.startedAt);
  const since = Number.isFinite(oldest) ? oldest - SUBAGENT_SLACK_MS : 0;
  /** @type {Map<string, Array<Record<string, any>>>} */
  const subs = new Map();
  const subsOf = (id) => {
    if (!subs.has(id)) subs.set(id, readSubagents(dir, id, { since }));
    return subs.get(id) ?? [];
  };

  return kept.map((row) => {
    const mine = subsOf(row.runId).filter((s) => s.promptId === row.promptId);
    return {
      ...row,
      subagentCount: mine.length,
      subagentTypes: mine.map((s) => s.agentType),
    };
  });
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
 * The live file answers while it exists: `recall.terms` and `used_evidence.terms` are
 * extracted from the prompt, so they carry whatever the prompt carried and are redacted on the
 * same policy as the prompt itself. Once it is pruned the ledger row answers instead, with
 * `source: 'ledger'` and the fields the ledger never carried — the staged terms, the evidence
 * record — reported as `null` rather than reconstructed.
 *
 * @param {string} dir
 * @param {string} runId
 * @param {string} promptId
 * @returns {Record<string, any>|null}
 */
export function turnDetail(dir, runId, promptId) {
  const id = safeSegment(promptId);
  if (!id) return null;
  const run = safeSegment(runId);
  const p = join(runDir({ dataDir: dir }, run), 'turns', `${id}.json`);
  const t = readJson(p, null);

  /** @type {Record<string, any>|null} */
  let detail = null;
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    const prompt = redactForBrowser(t.prompt, DETAIL_BYTES);
    const recall = (t.recall && typeof t.recall === 'object') ? t.recall : null;
    const used = (t.used_evidence && typeof t.used_evidence === 'object') ? t.used_evidence : null;
    detail = {
      ...turnRow(t, { previewBytes: DETAIL_BYTES }),
      prompt: prompt.text,
      promptTruncated: prompt.truncated || t.prompt_truncated === true,
      recall: recall ? { ...recall, terms: redactTerms(recall.terms) } : null,
      usedEvidence: used ? { ...used, terms: redactTerms(used.terms) } : null,
      outcomeSentAt: num(t.outcome_sent_at),
      outcomePending: t.outcome_pending === true,
      outcomeAbandoned: t.outcome_abandoned === true,
    };
  } else {
    const rows = readLedger(dir, run, { kinds: ['turn'] }).filter((r) => String(r.prompt_id || '') === id);
    if (!rows.length) return null;
    const r = rows[rows.length - 1];
    const prompt = redactForBrowser(r.prompt, DETAIL_BYTES);
    const rc = (r.recall && typeof r.recall === 'object') ? r.recall : null;
    detail = {
      ...ledgerTurnRow(r, { previewBytes: DETAIL_BYTES }),
      prompt: prompt.text,
      promptTruncated: prompt.truncated || r.prompt_truncated === true,
      recall: rc ? { ...rc, terms: null } : null,
      usedEvidence: null,
      outcomePending: false,
      outcomeAbandoned: false,
    };
  }

  for (const o of readLedger(dir, run, { kinds: ['outcome'] })) {
    if (String(o.prompt_id || '') !== id) continue;
    if (num(o.at) > detail.outcomeSentAt) detail.outcomeSentAt = num(o.at);
    if (detail.source === 'ledger') detail.outcomeState = 'sent';
  }
  for (const v of readVerdicts(dir, run)) {
    if (String(v.prompt || '') !== id || num(v.at) < detail.verdictAt) continue;
    const word = v.verdict === 'worked' ? 'worked' : v.verdict === 'failed' ? 'failed' : '';
    if (!word) continue;
    detail.verdict = word;
    detail.verdictAt = num(v.at);
  }

  const startedAt = detail.startedAt;
  return {
    ...detail,
    runId: run,
    subagents: readSubagents(dir, run, { since: startedAt > 0 ? startedAt - SUBAGENT_SLACK_MS : 0 })
      .filter((s) => s.promptId === id),
  };
}

// ---------------------------------------------------------------------------
// What memory did — per lesson, and per day
// ---------------------------------------------------------------------------

/** One empty tally: every counter present, so a consumer never meets an absent key. */
function emptyTally() {
  return {
    turns: 0, injectedTurns: 0, injectedRefs: 0, tokens: 0, chars: 0,
    usedYes: 0, usedNo: 0, usedUnmeasured: 0,
    outcomes: { success: 0, failure: 0, neutral: 0, none: 0 },
    verdicts: { worked: 0, failed: 0 },
    apiErrors: 0,
  };
}

/** @param {ReturnType<typeof emptyTally>} k @param {Record<string, any>} row */
function tallyRow(k, row) {
  k.turns += 1;
  if (row.recalledCount > 0) k.injectedTurns += 1;
  k.injectedRefs += num(row.recalledCount);
  k.tokens += num(row.tok);
  k.chars += num(row.chars);
  const u = row.used && typeof row.used === 'object' ? row.used.used : null;
  if (u === true) k.usedYes += 1; else if (u === false) k.usedNo += 1; else k.usedUnmeasured += 1;
  k.outcomes[effectiveOutcome(row)] += 1;
  if (row.verdict === 'worked') k.verdicts.worked += 1;
  else if (row.verdict === 'failed') k.verdicts.failed += 1;
  if (row.apiError) k.apiErrors += 1;
}

/**
 * Per-lesson counts over a set of turn rows. Each id counts once per turn however many times
 * the block repeated it; the outcome counted is the effective one, so a verdict on a turn
 * credits — or debits — every lesson injected into it, which is what the verdict means.
 *
 * @param {Array<Record<string, any>>} rows
 * @returns {Map<string, {injectedCount: number, usedInTurns: number, lastInjectedAt: number,
 *   outcomes: {success: number, failure: number, neutral: number, none: number},
 *   verdicts: {worked: number, failed: number}}>}
 */
function indexRows(rows) {
  /** @type {Map<string, any>} */
  const out = new Map();
  for (const row of rows) {
    const eff = effectiveOutcome(row);
    const used = row.used && typeof row.used === 'object' && row.used.used === true;
    for (const id of new Set(Array.isArray(row.recalled) ? row.recalled : [])) {
      if (!id) continue;
      let e = out.get(id);
      if (!e) {
        e = {
          injectedCount: 0, usedInTurns: 0, lastInjectedAt: 0,
          outcomes: { success: 0, failure: 0, neutral: 0, none: 0 },
          verdicts: { worked: 0, failed: 0 },
        };
        out.set(id, e);
      }
      e.injectedCount += 1;
      if (used) e.usedInTurns += 1;
      if (num(row.startedAt) > e.lastInjectedAt) e.lastInjectedAt = num(row.startedAt);
      e.outcomes[eff] += 1;
      if (row.verdict === 'worked') e.verdicts.worked += 1;
      else if (row.verdict === 'failed') e.verdicts.failed += 1;
    }
  }
  return out;
}

/**
 * How often each memory id was injected into a turn of this run — or, with `family`, of its
 * directory — and what those turns came to. Durable, unlike the six-hour seen-set: it reads
 * the ledger and the live files together, one row per prompt.
 *
 * @param {string} dir
 * @param {string} runId
 * @param {{family?: boolean, since?: number}} [opts]
 * @returns {ReturnType<typeof indexRows>}
 */
export function injectionIndex(dir, runId, opts = {}) {
  return indexRows(gatherTurns(dir, runId, { family: opts.family === true, since: num(opts.since), want: 0 }));
}

/** `YYYY-MM-DD` by the local calendar — the same key the page's day headers use. */
function localDay(ms) {
  const d = new Date(ms);
  const two = (n) => (n < 10 ? '0' : '') + n;
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** Local midnight `daysBack` calendar days before the day `ms` falls on. DST-safe: date arithmetic, not 24 h steps. */
function localDayStart(ms, daysBack = 0) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack).getTime();
}

/**
 * The Overview: what memory did over the last `days` calendar days, by day and in total, and
 * the same totals for the equal window before it, so a tile can carry a delta.
 *
 * Days are **local calendar days** on the machine serving the page — which is the machine the
 * turns happened on — and every day in the window is present, zero-filled, so a chart has one
 * bar per day rather than one per day something happened. Outcomes are the *effective* ones:
 * a verdict wins over the automatic signal, so this agrees with the Turns table row by row.
 * `verdicts` counts turns that carried one at all.
 *
 * Local only: nothing here reaches the instance.
 *
 * @param {string} dir
 * @param {string} runId
 * @param {{family?: boolean, days?: number, now?: number}} [opts] `days` is clamped to 1..30
 * @returns {Record<string, any>}
 */
export function overview(dir, runId, opts = {}) {
  const days = clampInt(opts.days, 1, 30, 30);
  const now = num(opts.now) || Date.now();
  const family = opts.family === true;
  const ids = family ? familyOf(dir, runId).runIds : [safeSegment(runId)].filter(Boolean);
  const windowStart = localDayStart(now, days - 1);
  const previousStart = localDayStart(now, 2 * days - 1);

  const rows = gatherTurns(dir, runId, { family, since: previousStart, want: 0 });
  const current = rows.filter((r) => r.startedAt >= windowStart);
  const previous = rows.filter((r) => r.startedAt < windowStart);

  /** @type {Map<string, any>} */
  const byDay = new Map();
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = localDay(localDayStart(now, i));
    byDay.set(day, { day, injected: 0, ...emptyTally() });
  }
  const kpi = emptyTally();
  for (const row of current) {
    tallyRow(kpi, row);
    const bucket = byDay.get(localDay(row.startedAt));
    if (!bucket) continue;
    tallyRow(bucket, row);
    bucket.injected = bucket.injectedRefs;
  }
  const prev = emptyTally();
  for (const row of previous) tallyRow(prev, row);

  const topInjected = [...indexRows(current).entries()]
    .map(([id, e]) => ({ id, ...e }))
    .sort((x, y) => y.injectedCount - x.injectedCount || y.lastInjectedAt - x.lastInjectedAt)
    .slice(0, 10);

  // The oldest close time on any ledger of the family, whatever order the rows landed in.
  let firstLedgerAt = 0;
  for (const id of ids) {
    for (const r of readLedger(dir, id, { kinds: ['turn'] })) {
      const at = num(r.at);
      if (at > 0 && (!firstLedgerAt || at < firstLedgerAt)) firstLedgerAt = at;
    }
  }

  return {
    dir,
    runId: safeSegment(runId),
    runIds: ids,
    days,
    now,
    windowStart,
    previousStart,
    // Stated rather than implied: the ledger accrues from the first Stop after it existed
    // and cannot reconstruct anything before that.
    firstLedgerAt,
    kpi,
    previous: prev,
    series: [...byDay.values()],
    topInjected,
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
  return readJsonl(rollupPath(dir, runId), since);
}

/**
 * One JSONL file under `dashboard/`, oldest first. A row torn by a crash mid-append is normal
 * and costs exactly itself.
 *
 * @param {string} p
 * @param {number} [since] epoch ms on `at`; rows older than this are dropped
 * @returns {Array<Record<string, any>>}
 */
function readJsonl(p, since = 0) {
  if (!existsSync(p)) return [];
  let raw = '';
  try { raw = readFileSync(p, 'utf8'); } catch { return []; }
  const from = num(since);
  /** @type {Array<Record<string, any>>} */
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (from > 0 && num(row.at) < from) continue;
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verdicts — the other thing the dashboard writes
// ---------------------------------------------------------------------------

/**
 * `<dataDir>/dashboard/verdicts-<run_id>.jsonl`: one row per Worked / Did not work a person
 * gave a turn, appended by the server after the instance accepted the outcome post.
 *
 * Beside the rollup rather than on the ledger, on purpose. The ledger is appended by the Stop
 * hook, and rewriting one of its rows from a server process would race that append; and the
 * "dashboard writes only under `dashboard/`" invariant is worth more than one file fewer.
 * The reader folds the newest verdict per prompt onto its turn row (`gatherTurns`).
 *
 * @param {string} dir
 * @param {string} runId
 * @returns {string}
 */
export function verdictsPath(dir, runId) {
  return join(dir, ROLLUP_DIR, `verdicts-${safeSegment(runId) || 'unknown'}.jsonl`);
}

/**
 * Append one verdict row: `{at, run, prompt, verdict: 'worked'|'failed', entryIds, …}`.
 * Capped like the rollup, by the same function.
 *
 * @param {string} dir
 * @param {string} runId
 * @param {Record<string, any>|null} row
 * @returns {boolean} whether a row was written
 */
export function appendVerdict(dir, runId, row) {
  try {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    const p = verdictsPath(dir, runId);
    const rows = readVerdicts(dir, runId);
    if (!ensureDir(join(dir, ROLLUP_DIR))) return false;
    appendFileSync(p, `${JSON.stringify(row)}\n`, 'utf8');
    capRollup(p, rows.length + 1);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every verdict recorded for a run, oldest first.
 *
 * @param {string} dir
 * @param {string} runId
 * @param {number} [since]
 * @returns {Array<Record<string, any>>}
 */
export function readVerdicts(dir, runId, since = 0) {
  return readJsonl(verdictsPath(dir, runId), since);
}

/**
 * The analytics payload: the rollup series plus the aggregates the tiles show.
 *
 * There is no latency series and there is no latency tile. `recall.ms` exists on the status
 * marker and on subagent records, never on a turn, so per-prompt timing is not recorded
 * anywhere on disk — the honest thing is to omit it rather than to plot the last prompt's
 * number against every prompt.
 *
 * With `family`, the series is every run of the directory's rollups concatenated by time: a
 * `/clear` moves the hooks to a new run id, and a trend that restarted at every clear would
 * be a trend of nothing.
 *
 * @param {string} dir
 * @param {string} runId
 * @param {{since?: number, family?: boolean}} [opts]
 * @returns {Record<string, any>}
 */
export function analytics(dir, runId, opts = {}) {
  const ids = opts.family === true
    ? familyOf(dir, runId).runIds
    : [safeSegment(runId)].filter(Boolean);
  const series = ids
    .flatMap((id) => readRollup(dir, id, num(opts.since)))
    .sort((a, b) => num(a.at) - num(b.at));
  const n = series.length;
  const sum = (k) => series.reduce((acc, row) => acc + num(row[k]), 0);
  const last = n ? series[n - 1] : null;

  const sources = sum('sources');
  return {
    dir,
    runId: safeSegment(runId),
    runIds: ids,
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
