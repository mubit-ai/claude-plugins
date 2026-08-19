// @ts-check
/**
 * `lib/runid.mjs` — the map from "a Claude Code session" to "a Mubit run" (§4.3).
 *
 * Four strategies:
 *
 * | strategy                  | shape                        | derived from |
 * | ------------------------- | ---------------------------- | ------------ |
 * | `per-directory` (default) | `cc-<slug>-<hash8>`          | `git rev-parse --show-toplevel`, falling back to `CLAUDE_PROJECT_DIR` |
 * | `git-branch`              | `cc-<slug>-<branch>-<hash8>` | root + branch, so a feature branch gets its own memory |
 * | `per-conversation`        | `cc-<host_session_id>`       | the host session id |
 * | `static`                  | `MUBIT_CC_RUN_ID`            | pinned; a config error when unset — never a silent default |
 *
 * The single most important rule in this file: the MCP server defaults
 * `MUBIT_DEFAULT_SESSION_ID` to the literal `"default"`, which collapses
 * every user, project and machine into one shared run. **No input may ever make
 * this module emit `"default"`** — not a blank session id, not a missing project
 * dir, not that variable sitting in the surrounding shell (which this module
 * never reads). Where an honest answer is impossible, `deriveRunId` throws a
 * config error; it never guesses, and it never silently falls back to a literal.
 *
 * Constraints shared with the rest of `lib/`: zero dependencies, Node >= 20
 * built-ins only, synchronous, and importable by absolute `file://` URL from a
 * detached child.
 *
 * `deriveRunId` is deliberately **not pure**: `SessionStart.source === "clear"`
 * has to remember how many times a session was cleared, so it persists
 * `clear_count` back to the session map on its way out.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { dataDir, readJson, writeJsonAtomic } from './state.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** §4.3 strategies. Anything else resolves to the default rather than failing. */
const STRATEGIES = new Set(['per-directory', 'git-branch', 'per-conversation', 'static']);
const DEFAULT_STRATEGY = 'per-directory';

/** §4.3 `SessionStart.source`. An unrecognised source is treated as "no source". */
const SOURCES = new Set(['startup', 'resume', 'clear', 'compact', 'fork']);

/**
 * Host session ids that are placeholders rather than identities. Treating them
 * as absent is what stops `per-conversation` from answering `cc-default` — a run
 * id that is the poisoned default wearing a prefix.
 */
const PLACEHOLDER_SESSION_IDS = new Set(['default', 'none', 'null', 'undefined', 'unknown', 'nil']);

/** Run ids that are never an answer, whatever produced them. */
const FORBIDDEN_RUN_IDS = new Set(['default', 'cc-', 'cc']);

/**
 * The agent identity, and deliberately not a per-session one.
 *
 * This used to be `claude-code-<8 chars of the host session id>`, which minted a fresh
 * principal every session. Anything upstream that counts *distinct actors* — to decide
 * whether a lesson has been confirmed by more than one of them — then counted one person's
 * consecutive sessions as a crowd, and the count stopped meaning anything.
 *
 * A role is what this value is for. The session is not lost: it is the run id, the session
 * map under `sessions/`, and the `session_id` the tool surface carries.
 */
const AGENT_ROLE = 'claude-code';
/** `-sub-<agentShort>` for a subagent identity. */
const AGENT_SHORT = 12;

const HASH_LEN = 8;
/** §7 names `breaker/<endpoint_hash>.json` as `sha256(endpoint).slice(0, 12)`. */
const ENDPOINT_HASH_LEN = 12;

const MAX_SLUG = 32;
const MAX_BRANCH = 32;
const MAX_SESSION_FILE = 128;

const GIT_TIMEOUT_MS = 2000;
/** How stale `last_seen_at` may get before a non-SessionStart hook rewrites it. */
const TOUCH_INTERVAL_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// deriveRunId
// ---------------------------------------------------------------------------

/**
 * The run id for this session, honouring `cfg.runStrategy` and the §4.3
 * `SessionStart.source` table:
 *
 * | source | behaviour |
 * | --- | --- |
 * | `startup` | derive fresh, overwriting any stale mapping |
 * | `resume` | reuse the mapped run; derive when nothing is mapped |
 * | `clear` | **new run** — the derived run plus an incrementing `-c<n>` |
 * | `compact`, `fork` | reuse the parent session record's run |
 * | absent / unknown | reuse the mapped run when there is one (a `PostToolUse` after a `/clear` belongs to the cleared run), else derive |
 *
 * Writes the §4.3 `SessionRecord` back to `sessions/<host_session_id>.json`
 * whenever the mapping changes — which is what makes two successive `/clear`s
 * yield `-c1` then `-c2`.
 *
 * @param {Record<string, any>} cfg     a `loadConfig()` result
 * @param {Record<string, any>} [payload] the hook's stdin payload
 * @returns {string}
 * @throws {Error} when `static` has no usable pin, or when a derivation could
 *   only answer with `"default"` / a bare prefix. Throwing is the honest answer;
 *   a silent default is not.
 */
export function deriveRunId(cfg, payload = {}) {
  const c = isObject(cfg) ? cfg : {};
  const p = isObject(payload) ? payload : {};
  return assertUsableRunId(resolveRunId(c, p));
}

/**
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} payload
 * @returns {string}
 */
function resolveRunId(cfg, payload) {
  const strategy = normaliseStrategy(cfg.runStrategy);
  const source = normaliseSource(payload.source);
  const sessionId = hostSessionId(payload);

  // `static` is validated first, so an unset pin is a config error before any
  // state is read or written — never a quiet fall-through to another strategy.
  const pinned = strategy === 'static' ? staticRunId(cfg) : '';

  // No usable host session id (a bare `{}` from the status line, a blank
  // `session_id`, the literal "default") means no session map: derive and go.
  if (!sessionId) return pinned || deriveFresh(cfg, payload, strategy);

  const prev = loadSessionMap(sessionId);
  let clear = clearCount(prev);
  let runId;

  if (pinned) {
    // A pin is a pin on every source. Appending a clear counter to a
    // deliberately shared run id would silently un-share it.
    runId = pinned;
  } else if (source === 'clear') {
    // `per-directory`/`git-branch` are stable per directory, so the counter is
    // the only thing that can honour "forget the thread".
    clear = clearCount(prev) + 1;
    runId = `${deriveFresh(cfg, payload, strategy)}-c${clear}`;
  } else if (source === 'startup') {
    // Fresh means fresh: a leftover mapping from a previous session with the
    // same id is discarded, counter included.
    clear = 0;
    runId = deriveFresh(cfg, payload, strategy);
  } else {
    // resume / compact / fork / unknown / absent.
    runId = reusableRun(prev, strategy) || deriveFresh(cfg, payload, strategy);
  }

  rememberRun(cfg, payload, sessionId, prev, {
    run_id: runId,
    clear_count: clear,
    strategy,
    source,
  });
  return runId;
}

/**
 * The strategy's own derivation, with no session-map involvement.
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} payload
 * @param {string} strategy
 * @returns {string}
 */
function deriveFresh(cfg, payload, strategy) {
  if (strategy === 'static') return staticRunId(cfg);
  if (strategy === 'per-conversation') {
    const sessionId = sanitiseSegment(hostSessionId(payload), MAX_SESSION_FILE);
    if (sessionId) return `cc-${sessionId}`;
    // A conversation with no identity still has a directory. Falling back beats
    // answering `cc-` — and beats throwing on an event the user cannot fix.
  }
  return directoryRunId(cfg, strategy === 'git-branch');
}

/**
 * §4.3 `static`: "the literal `MUBIT_CC_RUN_ID`" — with one hard exception. A
 * pin of `"default"` or of nothing but whitespace is the failure this whole
 * module exists to prevent, so it is a config error rather than a value.
 * @param {Record<string, any>} cfg
 * @returns {string}
 */
function staticRunId(cfg) {
  const pinned = typeof cfg.runId === 'string' ? cfg.runId.trim() : '';
  if (!pinned) {
    throw new Error(
      'MUBIT_CC_RUN_STRATEGY=static requires MUBIT_CC_RUN_ID to name the pinned run. '
      + 'Set it, or choose per-directory/git-branch/per-conversation — this module will not '
      + 'silently fall back to another strategy.');
  }
  if (FORBIDDEN_RUN_IDS.has(pinned.toLowerCase())) {
    throw new Error(
      `MUBIT_CC_RUN_ID is ${JSON.stringify(pinned)}, which collapses every user and project `
      + 'into one shared Mubit run. Pin a real run id.');
  }
  // The run id names a directory as well as a run. A pin carrying a path separator or a dot
  // segment would mean two different things at once — one value on the wire, another after
  // the write flattened it — so it is a config error here rather than a surprise later.
  if (/[\\/]/.test(pinned) || /^\.+$/.test(pinned)) {
    throw new Error(
      `MUBIT_CC_RUN_ID is ${JSON.stringify(pinned)}, which is a path rather than a name. A `
      + 'run id names a directory under the plugin data dir as well as a run, so it may not '
      + 'contain "/" or "\\" or be a bare dot segment.');
  }
  return pinned;
}

/**
 * `cc-<slug>-<hash8>`, or `cc-<slug>-<branch>-<hash8>` when the branch is part
 * of the identity. The hash covers the git toplevel (falling back to
 * `CLAUDE_PROJECT_DIR`), so two terminals in one repo share a run and two repos
 * with the same directory name do not.
 * @param {Record<string, any>} cfg
 * @param {boolean} withBranch
 * @returns {string}
 */
function directoryRunId(cfg, withBranch) {
  const dir = projectDirOf(cfg);
  const root = gitToplevel(dir) || dir;
  const slug = sanitiseSegment(basename(stripTrailingSep(root)), MAX_SLUG) || 'workspace';
  const branch = withBranch
    ? (sanitiseSegment(gitBranch(dir), MAX_BRANCH) || 'nobranch')
    : '';
  // The branch rides in the hash as well as in the name: `git-branch` must move
  // when the branch moves even if two branch names sanitise to the same slug.
  const digest = shortHash(withBranch ? `${root} ${branch}` : root, HASH_LEN);
  return branch ? `cc-${slug}-${branch}-${digest}` : `cc-${slug}-${digest}`;
}

/**
 * The mapped run, when it is safe to keep using it. A record written under a
 * different strategy is stale by definition; a record carrying a poisoned or
 * empty run is not a record at all.
 * @param {Record<string, any>|null} prev
 * @param {string} strategy
 * @returns {string}
 */
function reusableRun(prev, strategy) {
  if (!isObject(prev)) return '';
  const id = typeof prev.run_id === 'string' ? prev.run_id.trim() : '';
  if (!id || FORBIDDEN_RUN_IDS.has(id.toLowerCase())) return '';
  const recorded = typeof prev.strategy === 'string' ? prev.strategy.trim() : '';
  if (recorded && normaliseStrategy(recorded) !== strategy) return '';
  return id;
}

/**
 * The last line of defence. Every exit from `deriveRunId` passes through here,
 * so a future edit to any strategy cannot reintroduce the poisoned literal.
 * @param {string} id
 * @returns {string}
 */
function assertUsableRunId(id) {
  const s = typeof id === 'string' ? id.trim() : '';
  if (!s || FORBIDDEN_RUN_IDS.has(s.toLowerCase())) {
    throw new Error(
      `lib/runid.mjs refused to emit the run id ${JSON.stringify(id)}. `
      + 'An empty run id, a bare "cc-" prefix, or the literal "default" would write this '
      + "project's memory into a run shared by every user and project on the machine (§4.3).");
  }
  return s;
}

// ---------------------------------------------------------------------------
// deriveAgentId
// ---------------------------------------------------------------------------

/**
 * §4.3/§5.1: the stable role `claude-code`, plus `-sub-<agentShort>` when the payload
 * belongs to a subagent — two subagents working at the same time must never share an
 * identity, or their work cannot be told apart. That distinctness is the only thing this
 * value has to provide; see `AGENT_ROLE` for why the parent half is not per-session.
 * @param {Record<string, any>} [payload]
 * @returns {string}
 */
export function deriveAgentId(payload = {}) {
  const p = isObject(payload) ? payload : {};
  const sub = subagentShort(p);
  return sub ? `${AGENT_ROLE}-sub-${sub}` : AGENT_ROLE;
}

// ---------------------------------------------------------------------------
// deriveSubRunId
// ---------------------------------------------------------------------------

/**
 * §4.3: the sub-run form — `<parent_run_id>-sub-<agentShort>`, the same suffix
 * `deriveAgentId` puts on the role, applied to the run instead.
 *
 * ---------------------------------------------------------------------------
 * The collapse this exists to undo, measured
 * ---------------------------------------------------------------------------
 * A live fan-out of two subagents on Claude Code 2.1.235 produced two `SubagentStart`s and
 * two `SubagentStop`s carrying the parent's `session_id` **and** the parent's `prompt_id`.
 * They differed in exactly one field: `agent_id`. Every coordinate this plugin keys state on
 * is therefore identical across siblings — `runs/<run_id>/turns/<prompt_id>.json` is one
 * file that six parallel subagents would all read as "their" turn — so `agent_id` is the
 * only thing that can separate them, and this is its run-scoped form.
 *
 * ---------------------------------------------------------------------------
 * What it is NOT for
 * ---------------------------------------------------------------------------
 * **Never query against it.** A sub-run id has no memory stored under it: the store knows
 * the parent run, so asking about `cc-x-1-sub-ab55bb82d198` would return nothing for every
 * subagent, forever. It is a *local* lane — a name for one subagent's own record — until
 * there is a route that can join it back up. There is not one today: `lib/http.mjs`'s
 * `ROUTES` has no `link_run`, so nothing on the wire relates a sub-run to its parent, and
 * the parent id is carried alongside the record instead.
 *
 * A payload with no subagent identity answers with the parent unchanged. Minting a suffix
 * out of nothing would open a lane that `SubagentStop` — deriving from the same missing
 * field — could never find again, which is worse than the collapse it was meant to fix.
 *
 * @param {string} runId    the parent run, already derived
 * @param {Record<string, any>} [payload] a `SubagentStart` / `SubagentStop` payload
 * @returns {string}
 * @throws {Error} when the parent run id is one `deriveRunId` would have refused to emit.
 *   A sub-run id names a directory exactly as a run id does, so it inherits every rule —
 *   including the one about `"default"` — rather than laundering a poisoned parent by
 *   appending a suffix to it.
 */
export function deriveSubRunId(runId, payload = {}) {
  const parent = assertUsableRunId(runId);
  const short = subagentShort(isObject(payload) ? payload : {});
  if (!short) return parent;
  const suffix = `-sub-${short}`;
  // Idempotent: a caller holding an already-derived sub-run id is ordinary once more than
  // one hook derives one, and `…-sub-ab-sub-ab` would be a second lane for one subagent.
  return parent.endsWith(suffix) ? parent : assertUsableRunId(`${parent}${suffix}`);
}

/**
 * @param {Record<string, any>} payload
 * @returns {string}
 */
function subagentShort(payload) {
  const raw = typeof payload.agent_id === 'string' ? payload.agent_id.trim() : '';
  // A payload echoing an already-derived agent id is not a subagent. The parent is now the
  // bare role, so the equality case matters as much as the prefix one.
  if (!raw || raw === AGENT_ROLE || raw.startsWith(`${AGENT_ROLE}-`)) return '';
  const short = raw
    .replace(/^(sub_?agent|subagent|sub|agent)[-_]/i, '')
    .toLowerCase()
    .replace(/[^0-9a-z]/g, '')
    .slice(0, AGENT_SHORT);
  return short || shortHash(raw, HASH_LEN);
}

// ---------------------------------------------------------------------------
// The session map — sessions/<host_session_id>.json
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SessionRecord
 * @property {string} run_id
 * @property {string} agent_id
 * @property {string} strategy
 * @property {string} project_dir
 * @property {number} created_at
 * @property {number} last_seen_at
 * @property {string} mode
 * @property {number} clear_count
 * @property {string} endpoint_hash
 */

/**
 * §4.3: persist the whole `SessionRecord`, verbatim. Takes no `cfg` — the data
 * root comes from the live environment — because every caller is a hook that
 * already has the environment and may not have a config.
 *
 * Values that were supplied are stored exactly as given (`last_seen_at`
 * included): this is a store, not a clock.
 *
 * @param {string} sessionId  the host session id
 * @param {Partial<SessionRecord> & Record<string, any>} record
 * @returns {void}
 */
export function saveSessionMap(sessionId, record) {
  try {
    const file = sessionFileName(sessionId);
    if (!file) return;
    writeJsonAtomic(sessionPath(file), normaliseRecord(record));
  } catch {
    // §4.9: an unwritable data dir costs the mapping, never the hook.
  }
}

/**
 * §4.3: the mapped record, or `null`. A missing file, an empty file and a file
 * truncated by a SIGKILL are all "no record" — never a throw (§12.1-F14), because
 * the caller's answer to `null` is simply to derive.
 * @param {string} sessionId
 * @returns {(SessionRecord & Record<string, any>)|null}
 */
export function loadSessionMap(sessionId) {
  try {
    const file = sessionFileName(sessionId);
    if (!file) return null;
    const stored = readJson(sessionPath(file), null);
    return isObject(stored) ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Write the record back when the mapping actually moved — or when a SessionStart
 * says so. A `PostToolUse` firing every few seconds must not rewrite the file
 * every time just to bump `last_seen_at`.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} payload
 * @param {string} sessionId
 * @param {Record<string, any>|null} prev
 * @param {{run_id: string, clear_count: number, strategy: string, source: string}} next
 * @returns {void}
 */
function rememberRun(cfg, payload, sessionId, prev, next) {
  const now = Date.now();
  const isSessionStart = !!next.source || payload.hook_event_name === 'SessionStart';
  const moved = !isObject(prev)
    || prev.run_id !== next.run_id
    || clearCount(prev) !== next.clear_count;
  const lastSeen = isObject(prev) ? numberOr(prev.last_seen_at, 0) : 0;
  if (!moved && !isSessionStart && now - lastSeen < TOUCH_INTERVAL_MS) return;

  const inherited = isObject(prev) ? prev : {};
  saveSessionMap(sessionId, {
    ...inherited,
    run_id: next.run_id,
    // The session's agent is the parent, even when a SubagentStop is what
    // happened to trigger this derivation.
    agent_id: AGENT_ROLE,
    strategy: next.strategy,
    project_dir: projectDirOf(cfg),
    created_at: numberOr(inherited.created_at, now),
    last_seen_at: now,
    mode: firstString(cfg.mode) || 'local',
    clear_count: next.clear_count,
    endpoint_hash: endpointHash(cfg.endpoint),
  });
}

/**
 * Fill in every documented key so a record is never half a record, without
 * overwriting anything the caller supplied.
 * @param {Record<string, any>} record
 * @returns {Record<string, any>}
 */
function normaliseRecord(record) {
  const now = Date.now();
  /** @type {Record<string, any>} */
  const out = {
    run_id: '',
    agent_id: '',
    strategy: DEFAULT_STRATEGY,
    project_dir: '',
    created_at: now,
    last_seen_at: now,
    mode: 'local',
    clear_count: 0,
    endpoint_hash: '',
  };
  if (isObject(record)) {
    for (const [k, v] of Object.entries(record)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

/** @param {string} file @returns {string} */
function sessionPath(file) {
  return join(dataDir({}), 'sessions', `${file}.json`);
}

/**
 * A host session id is a uuid, but it arrives from outside the process, so it is
 * treated as untrusted input to a path: no separators, no dot segments.
 * @param {string} sessionId
 * @returns {string}
 */
function sessionFileName(sessionId) {
  const raw = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!raw) return '';
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '').slice(0, MAX_SESSION_FILE);
  return safe && safe !== '.' && safe !== '..' ? safe : '';
}

// ---------------------------------------------------------------------------
// Project directory + git
// ---------------------------------------------------------------------------

/**
 * The directory the run is about. `cfg.projectDir` is what `loadConfig` resolved
 * from `CLAUDE_PROJECT_DIR`; the environment and the cwd are the fallbacks for a
 * caller holding a partial config.
 * @param {Record<string, any>} cfg
 * @returns {string}
 */
function projectDirOf(cfg) {
  return firstString(cfg.projectDir, process.env.CLAUDE_PROJECT_DIR) || safeCwd();
}

/** @param {string} dir @returns {string} */
function gitToplevel(dir) {
  return gitOutput(dir, ['rev-parse', '--show-toplevel']);
}

/** @param {string} dir @returns {string} */
function gitBranch(dir) {
  const name = gitOutput(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  // A detached HEAD has no branch. Using the commit sha would give every commit
  // its own run, which is churn, not memory.
  return name && name !== 'HEAD' ? name : (name === 'HEAD' ? 'detached' : '');
}

/**
 * Shell out only inside a real repo, and never throw: a non-git directory, a
 * directory that does not exist, and a machine with no `git` on PATH are all
 * ordinary conditions here, answered with `''`.
 * @param {string} dir
 * @param {string[]} args
 * @returns {string}
 */
function gitOutput(dir, args) {
  try {
    if (!dir || !existsSync(dir) || !hasGitDir(dir)) return '';
    const r = spawnSync('git', args, {
      cwd: dir, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return r && r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : '';
  } catch {
    return '';
  }
}

/**
 * A cheap `.git` walk-up, so the common non-repo case costs a few `stat`s
 * instead of a process spawn per hook.
 * @param {string} start
 * @returns {boolean}
 */
function hasGitDir(start) {
  try {
    let cur = resolve(start);
    for (let i = 0; i < 24; i++) {
      if (existsSync(join(cur, '.git'))) return true;
      const up = dirname(cur);
      if (up === cur) return false;
      cur = up;
    }
  } catch {
    // An unreadable path is simply not a repo.
  }
  return false;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** @param {any} v @returns {boolean} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @param {...any} vals @returns {string} */
function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** @param {any} v @param {number} d @returns {number} */
function numberOr(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

/** @param {Record<string, any>|null} rec @returns {number} */
function clearCount(rec) {
  if (!isObject(rec)) return 0;
  const n = Math.trunc(numberOr(rec.clear_count, 0));
  return n > 0 ? n : 0;
}

/** @param {any} v @returns {string} */
function normaliseStrategy(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return STRATEGIES.has(s) ? s : DEFAULT_STRATEGY;
}

/** An unrecognised `source` is "no source", which reuses rather than resets. */
function normaliseSource(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return SOURCES.has(s) ? s : '';
}

/**
 * The host session id, or `''` when what arrived is a placeholder rather than an
 * identity.
 * @param {Record<string, any>} payload
 * @returns {string}
 */
function hostSessionId(payload) {
  const v = isObject(payload) && typeof payload.session_id === 'string'
    ? payload.session_id.trim()
    : '';
  if (!v || PLACEHOLDER_SESSION_IDS.has(v.toLowerCase())) return '';
  return v;
}

/**
 * A run id is a path segment (`runs/<run_id>/`, `status/<run_id>.json`) and a
 * wire value, so it is restricted to lowercase alphanumerics and single dashes.
 * @param {any} v
 * @param {number} max
 * @returns {string}
 */
function sanitiseSegment(v, max) {
  const s = String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/, '');
}

/** @param {string} s @returns {string} */
function stripTrailingSep(s) {
  const t = String(s ?? '').replace(/[\\/]+$/, '');
  return t || String(s ?? '');
}

/** @param {string} input @param {number} len @returns {string} */
function shortHash(input, len) {
  return createHash('sha256').update(String(input ?? ''), 'utf8').digest('hex').slice(0, len);
}

/**
 * §7: the same `sha256(endpoint).slice(0, 12)` that names `breaker/` and
 * `policy/` files, so a record can be joined against them.
 * @param {any} endpoint
 * @returns {string}
 */
function endpointHash(endpoint) {
  return shortHash(typeof endpoint === 'string' ? endpoint : '', ENDPOINT_HASH_LEN);
}

/** @returns {string} */
function safeCwd() {
  try { return process.cwd(); } catch { return '.'; }
}
