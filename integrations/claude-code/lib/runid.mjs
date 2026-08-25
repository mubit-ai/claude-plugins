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
 * The single most important rule in this file: `"default"` is the bundled server's
 * placeholder for `MUBIT_DEFAULT_SESSION_ID`, and it identifies nothing — a run id has to
 * name one project on one machine. **No input may ever make
 * this module emit `"default"`** — not a blank session id, not a missing project
 * dir, not that variable sitting in the surrounding shell (which this module
 * never reads). Where an honest answer is impossible, `deriveRunId` throws a
 * config error; it never guesses, and it never silently falls back to a literal.
 *
 * Constraints shared with the rest of `lib/`: zero dependencies, Node >= 20
 * built-ins only, synchronous, and importable by absolute `file://` URL from a
 * detached child.
 *
 * The `cc-` prefix is not a claim about the host. It reads as "Claude Code" for historical
 * reasons and means "the run for this directory" — which is what lets a Codex session and a
 * Claude Code session in the same directory be one run, and therefore one memory. Renaming it
 * would strand every run already stored under it. The *agent role* is what distinguishes the
 * two harnesses; see `AGENT_ROLES`.
 *
 * `deriveRunId` is deliberately **not pure**: `SessionStart.source === "clear"`
 * has to remember how many times a session was cleared, so it persists
 * `clear_count` back to the session map on its way out.
 *
 * **The directory is the payload's to name, not the environment's.** Every hook
 * payload carries `cwd`, and `CLAUDE_PROJECT_DIR` — which `cfg.projectDir`
 * resolves from — is the session's *launch* root, fixed for the life of the
 * process. Reading only the environment meant a `cd` into another repo kept
 * writing the first repo's run for the rest of the session: work in B captured,
 * recalled and attributed under A. So `payload.cwd` wins when it names a real
 * directory, and the reuse branch validates the directory as well as the
 * strategy. A payload with no `cwd` — `deriveRunId(cfg, {})`, which the MCP
 * launcher and the status line pass deliberately — is unaffected.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { dataDir, readJson, runDir, safeSegment, writeJsonAtomic } from './state.mjs';

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
 *
 * ---------------------------------------------------------------------------
 * Why there are two of them
 * ---------------------------------------------------------------------------
 * The Codex plugin shares this file, and a Codex session shares its **run** with a Claude
 * Code session in the same directory — that is the whole point of the port. What it does not
 * share is its identity, and by the same argument as above: a lesson that both harnesses
 * reached independently is genuinely better attested than one either reached twice, and only
 * a distinct role makes that visible to whatever is counting.
 *
 * The host is *declared*, never sniffed. A Codex session launched from a Claude Code terminal
 * inherits `CLAUDECODE=1` and a dozen `CLAUDE_CODE_*` variables; a Codex session started from
 * a plain shell has none of them. Detection gets both cases wrong in the direction that is
 * hardest to notice. `integrations/codex/lib/boot.mjs` sets `MUBIT_CC_HOST=codex` before any
 * of this loads, and it can do so unconditionally because that bundle exists nowhere else.
 * @type {Readonly<Record<string, string>>}
 */
const AGENT_ROLES = Object.freeze({ 'claude-code': 'claude-code', codex: 'codex' });
const DEFAULT_AGENT_ROLE = 'claude-code';

/**
 * This process's agent role. Read per call rather than captured at module scope so a test can
 * drive both hosts in one process; the lookup is a string compare against a two-entry table.
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
function agentRole(env = process.env) {
  const host = typeof env?.MUBIT_CC_HOST === 'string' ? env.MUBIT_CC_HOST.trim().toLowerCase() : '';
  return AGENT_ROLES[host] ?? DEFAULT_AGENT_ROLE;
}

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
    runId = reusableRun(cfg, payload, prev, strategy) || deriveFresh(cfg, payload, strategy);
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
  return directoryRunId(cfg, payload, strategy === 'git-branch');
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
      `MUBIT_CC_RUN_ID is ${JSON.stringify(pinned)}, which identifies no project. `
      + 'Pin a real run id.');
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
 * of the identity. The hash covers the git toplevel of wherever the payload says
 * this hook is running (falling back to `CLAUDE_PROJECT_DIR`), so two terminals
 * in one repo share a run, two repos with the same directory name do not, and a
 * `cd` within one repo moves nothing.
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} payload
 * @param {boolean} withBranch
 * @returns {string}
 */
function directoryRunId(cfg, payload, withBranch) {
  const dir = projectDirOf(cfg, payload);
  const root = projectRootOf(dir);
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
 * empty run is not a record at all; and a record written in another repo is
 * stale for the same reason the strategy one is — it describes work that is not
 * this work.
 *
 * This branch is where the mid-session `cd` used to be invisible. Every hook
 * after SessionStart arrives with no `source`, so every one of them came through
 * here, and until now the only thing checked was the strategy.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} payload
 * @param {Record<string, any>|null} prev
 * @param {string} strategy
 * @returns {string}
 */
function reusableRun(cfg, payload, prev, strategy) {
  if (!isObject(prev)) return '';
  const id = typeof prev.run_id === 'string' ? prev.run_id.trim() : '';
  if (!id || FORBIDDEN_RUN_IDS.has(id.toLowerCase())) return '';
  const recorded = typeof prev.strategy === 'string' ? prev.strategy.trim() : '';
  if (recorded && normaliseStrategy(recorded) !== strategy) return '';
  if (!sameProject(cfg, payload, prev)) return '';
  return id;
}

/**
 * Is the mapped record about the directory this hook is running in?
 *
 * Compared against `project_root` — the resolved git toplevel — rather than the
 * raw `project_dir`, because a record whose `project_dir` is a subdirectory of
 * the repo root would otherwise read as a move on every `cd src/`. **An absent
 * `project_root` means "unknown" and still reuses:** every record written before
 * the field existed says nothing about where it was written, and installing this
 * version must not move every live session to a new run.
 *
 * The cheap comparison comes first. `dir === prev.project_dir` holds on every
 * hook of a session that never changed directory, which is nearly all of them,
 * and it answers without the `git rev-parse` spawn that resolving a root costs.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} payload
 * @param {Record<string, any>} prev
 * @returns {boolean}
 */
function sameProject(cfg, payload, prev) {
  const recordedRoot = firstString(prev.project_root);
  if (!recordedRoot) return true;
  const dir = projectDirOf(cfg, payload);
  if (dir === firstString(prev.project_dir)) return true;
  return projectRootOf(dir) === recordedRoot;
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
// turnKey
// ---------------------------------------------------------------------------

/**
 * The id of the turn a payload belongs to — Claude Code's `prompt_id`, or Codex's `turn_id`.
 *
 * It names a file: `runs/<run_id>/turns/<turnKey>.json`, which `stage-prompt.mjs` writes,
 * `prompt-recall.mjs` adds the recalled reference ids to, `capture --stop` pairs with the
 * assistant's answer, `drain --with-outcome` posts the attribution from, and `session-end`
 * sweeps whatever is left. **Six readers, one key.** A disagreement anywhere costs
 * attribution silently: every turn is staged, none is ever found, recall keeps injecting and
 * nothing is ever credited — with no error on any path, because "no staged turn" is a
 * legitimate state that the code already handles gracefully.
 *
 * `prompt_id` wins when a payload carries both. It is what the stored turns on an existing
 * install are named after, and switching keys mid-run would orphan every one of them.
 *
 * Returns `''` rather than throwing when there is no turn: `SessionStart` and `SessionEnd`
 * genuinely have none, and every caller is on a hook's critical path.
 *
 * @param {Record<string, any>|null|undefined} payload
 * @returns {string}
 */
export function turnKey(payload) {
  if (!isObject(payload)) return '';
  const prompt = typeof payload.prompt_id === 'string' ? payload.prompt_id.trim() : '';
  if (prompt) return prompt;
  const turn = typeof payload.turn_id === 'string' ? payload.turn_id.trim() : '';
  return turn;
}

/**
 * The turn's ordinal within its run: 1 for the first turn, 2 for the second.
 *
 * **Two sources, in this order.** `payload.turn_number` when the host sends one — Claude Code
 * does, and nothing about that path changes. Otherwise the ordinal `stage-prompt` stamped into
 * `runs/<run_id>/turns/<prompt_id>.json` when the turn was first seen.
 *
 * The fallback exists because `turn_number` is in none of Codex's eleven input schemas. Every
 * item that host ever stored recorded `turn_number: 0`, so the order of turns within a run was
 * not merely approximate, it was absent — and `0` is indistinguishable from "the host said
 * zero", which is the shape of the bug rather than a gap in it.
 *
 * `0` still comes back when neither source has an answer, which is what a caller reading a
 * payload from before any of this was staged will see.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {Record<string, any>} payload
 * @returns {number}
 */
export function turnNumber(cfg, runId, payload) {
  const direct = Number(payload?.turn_number);
  if (Number.isFinite(direct) && direct > 0) return direct;
  try {
    const id = safeSegment(turnKey(payload));
    if (!id) return 0;
    const staged = readJson(join(runDir(cfg, runId), 'turns', `${id}.json`), null);
    const n = Number(staged?.turn_number);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// deriveAgentId
// ---------------------------------------------------------------------------

/**
 * §4.3/§5.1: the stable role `claude-code`, plus `-sub-<agentShort>` when the payload
 * belongs to a subagent — two subagents working at the same time must never share an
 * identity, or their work cannot be told apart. That distinctness is the only thing this
 * value has to provide; see `AGENT_ROLES` for why the parent half is not per-session.
 * @param {Record<string, any>} [payload]
 * @returns {string}
 */
export function deriveAgentId(payload = {}) {
  const p = isObject(payload) ? payload : {};
  const role = agentRole();
  const sub = subagentShort(p);
  return sub ? `${role}-sub-${sub}` : role;
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
  // bare role, so the equality case matters as much as the prefix one — and the test is
  // against EVERY known role, not just this process's. The two plugins share a data
  // directory, so a record written by one host is read back by the other, and a `codex`
  // agent id arriving at a Claude Code hook must not be mistaken for a subagent's.
  if (!raw) return '';
  for (const role of Object.values(AGENT_ROLES)) {
    if (raw === role || raw.startsWith(`${role}-`)) return '';
  }
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
 * @property {string} project_root  the resolved git toplevel of `project_dir`; what the
 *   `per-directory`/`git-branch` id is actually hashed from, and what a later hook compares
 *   against to notice a mid-session `cd`. Absent on records written before it existed, which
 *   reads as "unknown" and never as "moved".
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
 * truncated by a SIGKILL are all "no record" — never a throw (§12.1), because
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
  const dir = projectDirOf(cfg, payload);
  saveSessionMap(sessionId, {
    ...inherited,
    run_id: next.run_id,
    // The session's agent is the parent, even when a SubagentStop is what
    // happened to trigger this derivation.
    agent_id: agentRole(),
    strategy: next.strategy,
    project_dir: dir,
    // Resolved here rather than left for a reader to work out: `sameProject` has to be able
    // to answer without re-deriving, and the root is what the id was hashed from anyway.
    project_root: projectRootOf(dir),
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
    project_root: '',
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
 * The directory the run is about.
 *
 * `payload.cwd` first, because it is the only input that tracks a mid-session
 * `cd`: `cfg.projectDir` is `CLAUDE_PROJECT_DIR`, which the host sets once at
 * launch and never revises, and the config cache is keyed on it, so a `cd`
 * invalidates nothing either.
 *
 * "Usable" means it exists and is a directory. That test is what keeps the
 * preference safe: a payload naming a directory this machine does not have is
 * not evidence about where the work is happening, and hashing it would mint a
 * run id out of a path nobody can act on.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} [payload]
 * @returns {string}
 */
function projectDirOf(cfg, payload = {}) {
  return usableDir(isObject(payload) ? payload.cwd : '')
    || firstString(cfg.projectDir, process.env.CLAUDE_PROJECT_DIR)
    || safeCwd();
}

/**
 * The same answer, for callers outside this module that must not disagree with
 * it. `lib/config.mjs`'s `envTags` derives `repo:` and `branch:` by shelling out
 * in a directory, and those tags ride on every ingested item: tagging from one
 * directory while the run id was hashed from another is the same bug wearing
 * different clothes.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} [payload]
 * @returns {string}
 */
export function resolveProjectDir(cfg, payload = {}) {
  return projectDirOf(isObject(cfg) ? cfg : {}, payload);
}

/** The repo a directory belongs to, or the directory itself. @param {string} dir */
function projectRootOf(dir) {
  return gitToplevel(dir) || dir;
}

/** @param {any} v @returns {string} */
function usableDir(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return '';
  try {
    return statSync(s).isDirectory() ? s : '';
  } catch {
    // Absent, unreadable, or not a path at all — all "no answer", never a throw.
    return '';
  }
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

// ---------------------------------------------------------------------------
// Observing which runs exist
// ---------------------------------------------------------------------------

/**
 * Every run this data dir has a status marker for, with what the marker says about when it
 * was last touched.
 *
 * This is the *observation* half of run resolution, and it is deliberately not the deciding
 * half. `bin/activity.mjs` and `bin/pin.mjs` both have to answer "which run is this session",
 * and neither can call `deriveRunId`: derivation is what a hook does from a payload it was
 * handed, and re-running it from a CLI would compute an answer rather than read the one the
 * hooks actually used — and, on `source: 'clear'`, would increment and persist `clear_count`
 * a second time. So both observe instead, and this is the scan they share.
 *
 * What they do NOT share is the policy on top, which is why that stayed in each command:
 * `activity` breaks a tie on the higher `-c<n>` (a pre-clear marker and its successor can be
 * stamped inside one millisecond, and answering with the run the user just cleared would
 * report it as this session), while `pin` refuses a marker older than a day and refuses the
 * fallback run id outright (a pin is a standing constraint and needs a run to belong to).
 * Folding those together would mean one command silently inheriting the other's rules.
 *
 * Markers are enumerated from `status/`, never from `runs/`: the marker is the only file
 * guaranteed to exist, because a session that recalled and never captured has no `runs/<id>/`
 * at all. `health.json` shares the directory and is the endpoint probe cache, not a run.
 *
 * A marker truncated by a SIGKILL still names a run, so it is reported with the file's mtime
 * rather than dropped — the name is the run id, and that is the part being asked for. Total:
 * an unreadable data dir is an empty list, never a throw.
 *
 * @param {string} root  the resolved data dir
 * @returns {Array<{runId: string, at: number, clearCount: number}>}
 */
export function scanRunMarkers(root) {
  /** @type {Array<{runId: string, at: number, clearCount: number}>} */
  const out = [];
  try {
    const dir = join(str(root), 'status');
    if (!str(root) || !existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json') || name === 'health.json') continue;
      // The file name IS the run id — `updateMarker` writes `status/<run_id>.json`.
      const runId = name.slice(0, -'.json'.length);
      if (!runId) continue;
      const path = join(dir, name);
      let at = 0;
      try {
        at = Number(JSON.parse(readFileSync(path, 'utf8'))?.updated_at) || 0;
      } catch { /* truncated after a SIGKILL; fall back to the file's own clock */ }
      if (!Number.isFinite(at) || at <= 0) {
        try { at = statSync(path).mtimeMs; } catch { at = 0; }
      }
      out.push({ runId, at, clearCount: Number(/-c(\d+)$/.exec(runId)?.[1] ?? 0) });
    }
  } catch { /* §4.9: an unreadable data dir is no runs, not a crash */ }
  return out;
}

/** @param {any} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v : '';
}
