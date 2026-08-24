// @ts-check
/**
 * `lib/actor.mjs` — who the human behind a session is, without ever asking them.
 *
 * ---------------------------------------------------------------------------
 * Attribution is metadata. It is NOT `user_id`.
 * ---------------------------------------------------------------------------
 * The obvious implementation of this feature — fill `cfg.userId` in with a detected login —
 * is actively harmful, and the reason is the whole design of this module.
 *
 * `cfg.userId` reaches the wire as `user_id` on every ingest item (`capture.mjs`,
 * `drain.mjs`, `session-end.mjs`, `checkpoint.mjs`). Server-side, `user_id` is not an
 * attribution tag: on capture it is stamped into the entry's metadata, and **on query it is
 * enforced as a filter**, defaulting to `actor::<accountId>` when a client sends nothing.
 * `lib/recall.mjs` never sends a `user_id`, so every recall this plugin performs runs under
 * that default. Stamping a detected login into `user_id` would therefore scope every newly
 * captured entry into a bucket recall never looks in — the memory would keep being written
 * and would go silently invisible, which is the worst failure mode a memory layer has.
 *
 * So the actor rides in `metadata_json`, which is free-form, is already on every ingest item,
 * and survives into the stored entry. `cfg.userId` keeps exactly the meaning it has always
 * had, and stays empty by default.
 *
 * ---------------------------------------------------------------------------
 * Two exports, because the hot path and the ladder have different budgets
 * ---------------------------------------------------------------------------
 * `readActor(cfg)` is what `capture.mjs` calls on **every** PostToolUse. It reads one small
 * JSON file and returns. No subprocess, no network, no directory walk.
 *
 * `resolveActor(cfg, projectDir)` is the detection ladder and the only thing that writes the
 * cache. It is called from `hooks/src/drain.mjs`, which is detached, unbudgeted and has
 * nothing waiting on it — the only place in this plugin where spending two `git` spawns is
 * affordable.
 *
 * Both are total (§4.9). A failure here costs the actor and never the hook.
 *
 * ---------------------------------------------------------------------------
 * The ladder, cheapest rung first
 * ---------------------------------------------------------------------------
 *   1. `cfg.actorId`                     — the explicit setting / `MUBIT_CC_ACTOR_ID`
 *   2. `git config --get github.user`    — set by anyone who has used `gh auth`/`hub`
 *   3. `git config --get user.email`     — the local-part, before the `@`
 *   4. `git config --get user.name`      — sanitised into the `TYPE:NAME` shape
 *   5. `$USER` / `$USERNAME` / `$LOGNAME`
 *
 * **`gh api user` is deliberately not a rung.** It is the one call that would return the
 * canonical GitHub login, and it is unaffordable twice over: it is a process spawn, and it is
 * a *network* round trip. Even sitting behind a 30-day cache it has no place here, because a
 * cache miss is a cache miss on whatever hook happens to be running — and one of this
 * module's callers is on the per-tool-call path. Rungs 2-4 resolve to the same login for
 * anyone who has ever pushed to GitHub from this machine, which is the population that would
 * have benefited from rung 6 anyway.
 *
 * ---------------------------------------------------------------------------
 * `${dataDir}/actor.json` — 30 days
 * ---------------------------------------------------------------------------
 * `{v:1, at, actor, source}`, structured after the health cache in `lib/http.mjs`. It owns
 * its own TTL and is never touched by `pruneStale`.
 *
 * The cache is only ever **written** by `drain.mjs`, so the very first capture in a fresh
 * data dir carries no actor at all. That is accepted rather than worked around: `stage-prompt`
 * spawns the drainer on `UserPromptSubmit`, which normally lands well before the first
 * `PostToolUse` of the session, and the alternative — letting `capture` detect — puts two
 * `git` spawns on the hot path to rescue one item.
 *
 * A *failed* detection is deliberately not cached. Caching `''` for thirty days would mean a
 * developer who configures git tomorrow goes unattributed until next month, and the cost of
 * being wrong here is one extra pair of guarded spawns per drain on a machine that has
 * nothing to find.
 *
 * Constraints, as everywhere in `lib/`: zero dependencies, Node >= 20 built-ins only,
 * synchronous, and nothing here throws.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { readJson, resolveDataDir, writeJsonAtomic } from './state.mjs';

/** Cache format version. Bumping it invalidates every record on disk at once. */
const CACHE_VERSION = 1;

/** `${dataDir}/actor.json`. Top level, beside `config.json` — it is per machine, not per run. */
const CACHE_FILE = 'actor.json';

/** §7: 30 days. Long, because the answer almost never changes; finite, because it can. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A login is a label on a memory, not a payload. 64 characters is past every real login and
 * short enough that a pathological `git config` value cannot bloat every item it rides on.
 */
const MAX_ACTOR_CHARS = 64;

/** The same 2000 ms `lib/config.mjs` gives its `git` calls. A hung git is not worth waiting on. */
const GIT_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// readActor — the hot path
// ---------------------------------------------------------------------------

/**
 * The actor to stamp on an item, from the config and the cache and nothing else.
 *
 * `cfg.actorId` is checked first because it is rung 1 and costs nothing to read: a user who
 * has just set `MUBIT_CC_ACTOR_ID` sees it on the very next tool call rather than after the
 * next drain. Everything below rung 1 costs a subprocess, and so is only ever read back from
 * the cache `resolveActor` wrote.
 *
 * @param {Record<string, any>} [cfg]
 * @returns {string} the actor, or `''` when nothing is known
 */
export function readActor(cfg = {}) {
  try {
    const explicit = clean(isObject(cfg) ? cfg.actorId : '');
    if (explicit) return explicit;
    const hit = readCache(cfg);
    return hit ? hit.actor : '';
  } catch {
    // §4.9: an unreadable data dir costs the attribution, never the capture.
    return '';
  }
}

// ---------------------------------------------------------------------------
// resolveActor — the ladder, and the only writer
// ---------------------------------------------------------------------------

/**
 * Resolve the actor, refreshing `${dataDir}/actor.json` when it has to.
 *
 * Call this **only** from `drain.mjs`. It shells out, and a blocking hook cannot pay for it.
 *
 * @param {Record<string, any>} [cfg]
 * @param {string} [projectDir]  where to ask git — `resolveProjectDir(cfg, payload)`
 * @returns {string} the actor, or `''` when every rung came up empty
 */
export function resolveActor(cfg = {}, projectDir = '') {
  try {
    // Rung 1 outranks the cache as well as the ladder. The setting is the user saying who
    // they are, and it must not have to wait out a 30-day TTL written before they said it.
    const explicit = clean(isObject(cfg) ? cfg.actorId : '');
    if (explicit) {
      writeCache(cfg, explicit, 'config');
      return explicit;
    }

    const hit = readCache(cfg);
    if (hit) return hit.actor;

    const found = detect(projectDir);
    if (found.actor) writeCache(cfg, found.actor, found.source);
    return found.actor;
  } catch {
    // §4.9: the drainer's job is shipping memory. It never fails for want of a name.
    return '';
  }
}

/**
 * Rungs 2-5, in order. Each one is total on its own, so a rung that cannot answer falls
 * through instead of ending the ladder.
 *
 * @param {string} projectDir
 * @returns {{actor: string, source: string}}
 */
function detect(projectDir) {
  const dir = typeof projectDir === 'string' ? projectDir : '';

  // Rung 2 — whoever ran `gh auth login` or `hub` has this, and it is the canonical login.
  const ghUser = clean(gitConfig(dir, 'github.user'));
  if (ghUser) return { actor: ghUser, source: 'git-github-user' };

  // Rung 3 — the local-part of the commit email. `ada@example.com` is `ada`; the domain says
  // where they work, not who they are, and it is the same on every colleague's machine.
  const email = gitConfig(dir, 'user.email');
  const local = clean(email.includes('@') ? email.slice(0, email.indexOf('@')) : email);
  if (local) return { actor: local, source: 'git-email' };

  // Rung 4 — a display name, so it goes through the `TYPE:NAME` sanitiser: `env_tags` and
  // the wire metadata both forbid whitespace and stray colons inside a NAME.
  const name = clean(gitConfig(dir, 'user.name'));
  if (name) return { actor: name, source: 'git-name' };

  // Rung 5 — the three names the shells in use do not agree on.
  for (const key of ['USER', 'USERNAME', 'LOGNAME']) {
    const v = clean(process.env[key]);
    if (v) return { actor: v, source: `env-${key.toLowerCase()}` };
  }

  return { actor: '', source: '' };
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

/**
 * One `git config --get` inside a real repo, or `''`.
 *
 * The `hasGitDir` guard and the 2000 ms timeout are lifted verbatim from `lib/config.mjs` and
 * must stay that way: `git config` outside a worktree would still answer from the user's
 * global file, but "shell out only inside a real repo" is the rule that keeps the cost of
 * this module bounded, and a rung that fires anywhere is a rung that fires everywhere.
 * Rung 5 covers the machines this loses.
 *
 * @param {string} dir
 * @param {string} key
 * @returns {string}
 */
function gitConfig(dir, key) {
  try {
    if (!dir || !hasGitDir(dir)) return '';
    const r = spawnSync('git', ['config', '--get', key], {
      cwd: dir, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : '';
  } catch {
    // No `git` on PATH, a cwd that vanished, a spawn the OS refused — all "no answer".
    return '';
  }
}

/** @param {string} start @returns {boolean} */
function hasGitDir(start) {
  try {
    let cur = resolve(start);
    for (let i = 0; i < 24; i++) {
      if (existsSync(join(cur, '.git'))) return true;
      const up = dirname(cur);
      if (up === cur) return false;
      cur = up;
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ${dataDir}/actor.json
// ---------------------------------------------------------------------------

/** @param {Record<string, any>} cfg @returns {string} */
function cachePath(cfg) {
  return join(resolveDataDir(isObject(cfg) ? cfg : {}), CACHE_FILE);
}

/**
 * Structured after `readHealthCache` in `lib/http.mjs`: every field is checked, and anything
 * that is not exactly what was written is a miss rather than an error. A truncated or
 * half-written file is the normal state of a data dir after a SIGKILL.
 *
 * @param {Record<string, any>} cfg
 * @returns {{actor: string, source: string}|null}
 */
function readCache(cfg) {
  try {
    const raw = readJson(cachePath(cfg), null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.v !== CACHE_VERSION) return null;
    if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return null;
    // `Math.abs`, as the health cache does: a record stamped in the future is a clock that
    // moved, and trusting it would pin the actor for however far ahead the clock went.
    if (Math.abs(Date.now() - raw.at) >= TTL_MS) return null;

    const actor = clean(raw.actor);
    if (!actor) return null;
    return { actor, source: typeof raw.source === 'string' ? raw.source : '' };
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, any>} cfg
 * @param {string} actor
 * @param {string} source
 */
function writeCache(cfg, actor, source) {
  try {
    // `source` is never read back for a decision — it is there so that a support question
    // ("why does it think I am `root`?") is answerable from the file alone.
    writeJsonAtomic(cachePath(cfg), { v: CACHE_VERSION, at: Date.now(), actor, source });
  } catch {
    // §4.9: an unwritable data dir costs the cache, never the answer.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The `sanitiseTag` shape from `lib/config.mjs:200`, applied to every rung rather than only
 * to rung 4. Rungs 1-3 and 5 are logins and cannot normally contain whitespace or a colon —
 * but "cannot normally" is not a guarantee about a value that came out of a config file or
 * an environment variable, and every one of them ends up inside `metadata_json` alongside
 * `TYPE:NAME` readers.
 *
 * @param {any} v
 * @returns {string}
 */
function clean(v) {
  try {
    return String(v ?? '')
      // Control characters first: they would otherwise survive into `metadata_json` and
      // into every log line the actor ever appears in.
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .replace(/[\s:]+/g, '-')
      // Capped before the dashes are stripped, so a truncation cannot leave a trailing one.
      .slice(0, MAX_ACTOR_CHARS)
      .replace(/^-+|-+$/g, '');
  } catch {
    return '';
  }
}

/** @param {any} v @returns {boolean} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
