// @ts-check
/**
 * `lib/config.mjs` — the one resolution function that sees every setting.
 *
 * Build-guide §4.1 (module API + the frozen `Config`), §6.1 (environment
 * variables and defaults), §6.2 (`userConfig` keys and the env var each maps
 * to), §6.3 (the `CLAUDE_PLUGIN_OPTION_*` injection guard) and §7
 * (`config.json`, 300 s TTL).
 *
 * Precedence, highest first:
 *   1. `userConfig`  — `CLAUDE_PLUGIN_OPTION_*`
 *   2. `MUBIT_*` environment
 *   3. `${dataDir}/credentials.json` — written by `/mubit-memory:auth`
 *   4. `${CLAUDE_PROJECT_DIR}/.mubit-cc.json`
 *   5. built-in default
 *
 * `userConfig` wins because it is the user's deliberate per-install choice and
 * where the keychain-backed `apiKey` lives.
 *
 * The credentials store exists because nothing else can be written by a slash
 * command: `sensitive` userConfig values live in the OS keychain and the `/plugin`
 * UI is their only writer, so `/auth` needs a store of its own. It ranks below the
 * environment (a CI job's `MUBIT_API_KEY` still wins) and above the project file (a
 * fresh login beats a stale committed one).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { readCredentials } from './credentials.mjs';
import { dataDir as resolveDataRoot, readJson, writeJsonAtomic } from './state.mjs';

// ---------------------------------------------------------------------------
// §6.1 defaults
// ---------------------------------------------------------------------------

/**
 * §8.2 — ten of the MCP server's twenty-one tools. A blank `mcpTools` /
 * `MUBIT_MCP_TOOLS` means this curated set, never "none": the excluded eleven
 * are excluded because a hook already does the job better, not because tools
 * are off by default.
 */
const DEFAULT_MCP_TOOLS = [
  'mubit_learned', 'mubit_recall', 'mubit_outcome', 'mubit_reflect', 'mubit_lessons',
  'mubit_diagnose', 'mubit_archive', 'mubit_dereference', 'mubit_forget', 'mubit_status',
];

/** §7: `config.json` — cached resolved config, keyed by an input hash. */
const CACHE_FILE = 'config.json';
const CACHE_TTL_MS = 300 * 1000;
const CACHE_VERSION = 1;

/** §4.1: env_tags ride on every ingested item, so the cap is a payload-size guarantee. */
const MAX_ENV_TAGS = 8;

// ---------------------------------------------------------------------------
// §6.3 — reading userConfig
// ---------------------------------------------------------------------------

/** `apiKey` -> `API_KEY`, `recallTokenBudget` -> `RECALL_TOKEN_BUDGET`. */
function screaming(key) {
  return String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/**
 * §6.3: the host's exact env-name transform for a `userConfig` key is not fully
 * documented, so every plausible spelling is checked —
 * `CLAUDE_PLUGIN_OPTION_<SCREAMING_SNAKE>` first, then `CLAUDE_PLUGIN_OPTION_<key>`
 * verbatim, then `CLAUDE_PLUGIN_OPTION_<UPPERCASE>`. Cheap insurance that keeps
 * the keychain-backed key readable whichever transform the host applies.
 *
 * The third spelling is the one the plugins reference actually specifies: "All
 * values are exported to hook processes as `CLAUDE_PLUGIN_OPTION_<KEY>`
 * environment variables, where `<KEY>` is the option key uppercased." Plainly
 * read, `apiKey` becomes `APIKEY`, not `API_KEY` — and no example there uses a
 * multi-word key, which is why all three stay. It matters for nine of the
 * thirteen §6.2 keys: single-word ones (`endpoint`, `capture`, `recall`,
 * `redact`) collapse to the same string under both transforms, so only the
 * camelCase ones were ever at risk, and they are exactly the ones a user sets at
 * enable time (`apiKey`, `runStrategy`, `mcpTools`, …). Missing them would make
 * the enable-time prompt write values nothing ever reads.
 *
 * Returns `undefined` — not `''` — when no spelling is set: a blank
 * `endpoint` is a meaningful value ("explicitly local"), not an absent one.
 *
 * @param {string} key
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|undefined}
 */
export function optionValue(key, env = process.env) {
  const e = env ?? {};
  for (const name of [screaming(key), key, String(key).toUpperCase()]) {
    const v = e[`CLAUDE_PLUGIN_OPTION_${name}`];
    if (v !== undefined) return v;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// §4.1 — connection mode
// ---------------------------------------------------------------------------

/**
 * The plugin talks to a Mubit instance over HTTPS with an API key, and to nothing else.
 * There is no second mode to derive an endpoint host into, so this is a constant rather
 * than a function — kept as a field because the run marker and the status line both carry
 * it, and a marker written by an older version may still hold something else.
 */
export const MODE = 'hosted';

/**
 * §1.2: `Authorization: Bearer <key>`. Absent — not empty — when no key is
 * configured, so §12.1-F3's 401 is unambiguous.
 * @param {Record<string, any>} cfg
 * @returns {Record<string, string>}
 */
export function authHeaders(cfg) {
  const key = typeof cfg?.apiKey === 'string' ? cfg.apiKey.trim() : '';
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/**
 * Is there an endpoint worth dialing? This is the predicate behind the `unconfigured`
 * ConnState, and it is deliberately about the *endpoint* alone — a key that is missing or
 * wrong produces a 401 from a real server, which is already `auth_failed` and already names
 * the right fix.
 *
 * An absolute `http:`/`https:` URL or nothing. Both a blank endpoint and a plausible-looking
 * one with no scheme (`eu.mubit.ai`) fail identically inside `fetch` — `urlFor` concatenates
 * the route onto whatever this is, and a relative URL throws `ERR_INVALID_URL` before a
 * socket exists. That is a local config gap in both cases, so both classify the same way.
 * Without this the throw falls through `classifyError` to `server_error` and the plugin
 * reports a fault in a server it never dialed.
 *
 * @param {Record<string, any>} cfg
 * @returns {boolean}
 */
export function isConfigured(cfg) {
  const ep = typeof cfg?.endpoint === 'string' ? cfg.endpoint.trim() : '';
  if (!ep) return false;
  try {
    const u = new URL(ep);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// §4.1 — envTags, in Mubit's TYPE:NAME[:VERSION] form
// ---------------------------------------------------------------------------

/** Lockfile at the project root -> `lang:<x>`. */
const LANG_FILES = [
  ['Cargo.toml', 'lang:rust'],
  ['package.json', 'lang:node'],
  ['pyproject.toml', 'lang:python'],
  ['go.mod', 'lang:go'],
  ['Gemfile', 'lang:ruby'],
  ['pom.xml', 'lang:java'],
];

/**
 * `["tool:claude-code", "repo:<slug>", "branch:<name>", "lang:<x>"]`, plus
 * `MUBIT_CC_ENV_TAGS` extras appended verbatim, capped at 8.
 *
 * The cap slices from the tail, and the derived identity tag is emitted first,
 * so `tool:claude-code` can never be the thing the cap drops.
 *
 * @param {Record<string, any>} cfg
 * @param {string} [projectDir]
 * @returns {string[]}
 */
export function envTags(cfg, projectDir = '') {
  const dir = projectDir || cfg?.projectDir || process.cwd();
  /** @type {string[]} */
  const tags = ['tool:claude-code'];

  const root = gitToplevel(dir) || dir;
  const slug = sanitiseTag(basename(root));
  if (slug) tags.push(`repo:${slug}`);

  const branch = gitBranch(dir);
  if (branch) tags.push(`branch:${sanitiseTag(branch)}`);

  for (const [file, tag] of LANG_FILES) {
    if (existsSync(join(dir, file))) { tags.push(tag); break; }
  }

  const extraRaw = typeof cfg?.envTagsExtra === 'string'
    ? cfg.envTagsExtra
    : (process.env.MUBIT_CC_ENV_TAGS ?? '');
  for (const t of splitList(extraRaw)) tags.push(t);

  return [...new Set(tags)].slice(0, MAX_ENV_TAGS);
}

/** TYPE:NAME[:VERSION] forbids whitespace and stray colons inside NAME. */
function sanitiseTag(v) {
  return String(v ?? '').trim().replace(/[\s:]+/g, '-').replace(/^-+|-+$/g, '');
}

function gitToplevel(dir) {
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  return r ? r.trim() : '';
}

function gitBranch(dir) {
  const r = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = r ? r.trim() : '';
  return name && name !== 'HEAD' ? name : '';
}

/** Shell out only inside a real repo; a spawn per hook is not free. */
function git(dir, args) {
  try {
    if (!dir || !hasGitDir(dir)) return '';
    const r = spawnSync('git', args, {
      cwd: dir, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return r.status === 0 && typeof r.stdout === 'string' ? r.stdout : '';
  } catch {
    return '';
  }
}

function hasGitDir(start) {
  let cur = resolve(start);
  for (let i = 0; i < 24; i++) {
    if (existsSync(join(cur, '.git'))) return true;
    const up = dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
  return false;
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/**
 * Resolve the whole configuration, cache it, and freeze it.
 *
 * `Config` is frozen — including the nested `breaker` block — so one hook
 * cannot mutate the config another module already read.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {Readonly<Record<string, any>>}
 */
export function loadConfig(env = process.env) {
  const e = env ?? {};

  const projectDir = firstNonEmpty(e.CLAUDE_PROJECT_DIR, safeCwd());
  const dataDir = resolveDataRoot({}, e);
  const userFileRaw = readUserFileRaw(projectDir);
  const userFile = parseUserFile(userFileRaw);
  const creds = readCredentials(dataDir);

  const cachePath = join(dataDir, CACHE_FILE);
  const key = inputHash(e, userFileRaw, creds, projectDir, dataDir);

  const cached = readCache(cachePath, key);
  // §12.1: `apiKey` is deliberately absent from the cache (see `stripSecrets`), so a
  // cache hit re-resolves it. It is one env/file lookup — cheaper than the read that
  // just happened, and it keeps the key out of a file `plugin.json` promises it is not in.
  if (cached) return freezeConfig({ ...cached, apiKey: resolveApiKey(e, creds, userFile) });

  const cfg = resolveAll(e, userFile, creds, projectDir, dataDir);
  writeJsonAtomic(cachePath, {
    v: CACHE_VERSION, hash: key, at: Date.now(), config: stripSecrets(cfg),
  });
  return freezeConfig(cfg);
}

/**
 * The resolved config, minus anything that must not be written to disk.
 *
 * `plugin.json` tells the user the API key is "stored in the OS keychain, never in a
 * settings file". `${dataDir}/config.json` is a settings file, so the key does not go
 * in it — `loadConfig` re-resolves it on every cache hit instead.
 */
function stripSecrets(cfg) {
  const { apiKey: _omitted, ...rest } = cfg;
  return rest;
}

/** The `apiKey` rung of `resolveAll`, on its own, for the cache-hit path. */
function resolveApiKey(e, creds, userFile) {
  const opt = optionValue('apiKey', e);
  if (opt !== undefined) return str(opt, '').trim();
  if (e.MUBIT_API_KEY !== undefined) return str(e.MUBIT_API_KEY, '').trim();
  if (creds && creds.apiKey !== undefined) return str(creds.apiKey, '').trim();
  if (userFile && userFile.apiKey !== undefined) return str(userFile.apiKey, '').trim();
  return '';
}

/**
 * @param {Record<string, string|undefined>} e
 * @param {Record<string, any>} userFile
 * @param {string} projectDir
 * @param {string} dataDir
 */
function resolveAll(e, userFile, creds, projectDir, dataDir) {
  /**
   * One lookup per §6.2 row: `userConfig` key, then its `MUBIT_*` env var, then the
   * credentials store, then the project file, then the caller's default.
   *
   * The store sits below the environment so a CI job exporting `MUBIT_API_KEY` still
   * wins over whatever a developer once authenticated as on that machine, and above the
   * project file so a fresh `/mubit-memory:auth` beats a stale committed `.mubit-cc.json`.
   *
   * @param {string} key   the `userConfig` key name (§3.1)
   * @param {string} envVar the §6.1 environment variable it maps to
   */
  const pick = (key, envVar) => {
    const opt = optionValue(key, e);
    if (opt !== undefined) return opt;
    if (envVar && e[envVar] !== undefined) return e[envVar];
    if (creds && creds[key] !== undefined) return creds[key];
    if (userFile && userFile[key] !== undefined) return userFile[key];
    return undefined;
  };

  // §6.2 userConfig rows -------------------------------------------------
  const endpointRaw = str(pick('endpoint', 'MUBIT_ENDPOINT'), '');
  const endpoint = endpointRaw.trim();   // blank means unconfigured: nothing is sent
  const apiKey = str(pick('apiKey', 'MUBIT_API_KEY'), '').trim();
  const userId = str(pick('userId', 'MUBIT_CC_USER_ID'), '').trim();
  const runStrategy = str(pick('runStrategy', 'MUBIT_CC_RUN_STRATEGY'), 'per-directory').trim()
    || 'per-directory';
  const capture = bool(pick('capture', 'MUBIT_CC_CAPTURE'), true);
  const recall = bool(pick('recall', 'MUBIT_CC_RECALL'), true);
  const redact = bool(pick('redact', 'MUBIT_CC_REDACT'), true);
  const recallTokenBudget = int(pick('recallTokenBudget', 'MUBIT_CC_RECALL_TOKENS'), 1500);
  const recallAssemble = enumOf(pick('recallAssemble', 'MUBIT_CC_RECALL_ASSEMBLE'),
    ['client', 'server'], 'client');
  // What recall does when rung 1 (`direct_bypass`, zero LLM calls) is refused by instance
  // policy. `none` is the default deliberately: rung 2 pays a routing LLM call, measured at a
  // 5 s median and a long tail past 11 s, against a recall budget of 1500 ms inside a 3 s hook
  // timeout — so on an instance with direct search disabled it aborts nearly every time,
  // having spent the call. Blocking every prompt on that is worse than recalling nothing.
  // Operators who would rather pay it can opt back in.
  const recallFallback = enumOf(pick('recallFallback', 'MUBIT_CC_RECALL_FALLBACK'),
    ['none', 'agent_routed'], 'none');
  const reflectOnEnd = bool(pick('reflectOnEnd', 'MUBIT_CC_REFLECT_ON_END'), true);
  const outcomeMode = enumOf(pick('outcomeMode', 'MUBIT_CC_OUTCOME_MODE'),
    ['off', 'implicit', 'explicit'], 'implicit');
  const statusLine = bool(pick('statusLine', 'MUBIT_CC_STATUSLINE'), true);
  const mcpToolsRaw = pick('mcpTools', 'MUBIT_MCP_TOOLS');
  const mcpTools = list(mcpToolsRaw, DEFAULT_MCP_TOOLS);

  // §6.1 environment-only rows -------------------------------------------
  const only = (envVar, key) => {
    const opt = key ? optionValue(key, e) : undefined;
    if (opt !== undefined) return opt;
    if (e[envVar] !== undefined) return e[envVar];
    if (key && creds && creds[key] !== undefined) return creds[key];
    if (key && userFile && userFile[key] !== undefined) return userFile[key];
    return undefined;
  };

  const runId = str(only('MUBIT_CC_RUN_ID', 'runId'), '').trim();
  const recallBudgetMs = int(only('MUBIT_CC_RECALL_BUDGET_MS', 'recallBudgetMs'), 1500);
  const recallSections = list(only('MUBIT_CC_RECALL_SECTIONS', 'recallSections'),
    ['mental_models', 'active_rules', 'lessons', 'facts', 'working_memory', 'traces']);
  const policyTtlMs = int(only('MUBIT_CC_POLICY_TTL_MS', 'policyTtlMs'), 86400000);
  const denyGlobs = list(only('MUBIT_CC_CAPTURE_DENY', 'denyGlobs'), []);
  const respectGitignore = bool(only('MUBIT_CC_RESPECT_GITIGNORE', 'respectGitignore'), true);
  const maxParamBytes = int(only('MUBIT_CC_MAX_PARAM_BYTES', 'maxParamBytes'), 4096);
  const maxOutputBytes = int(only('MUBIT_CC_MAX_OUTPUT_BYTES', 'maxOutputBytes'), 8192);
  const batchMaxItems = int(only('MUBIT_CC_BATCH_MAX_ITEMS', 'batchMaxItems'), 32);
  const batchMaxAgeMs = int(only('MUBIT_CC_BATCH_MAX_AGE_MS', 'batchMaxAgeMs'), 30000);
  const timeoutMs = int(only('MUBIT_CC_TIMEOUT_MS', 'timeoutMs'), 4000);
  const coldStartGraceMs = int(only('MUBIT_CC_COLDSTART_GRACE_MS', 'coldStartGraceMs'), 20000);
  const logLevel = enumOf(only('MUBIT_CC_LOG_LEVEL', 'logLevel'),
    ['error', 'warn', 'info', 'debug'], 'warn');
  const envTagsExtra = str(only('MUBIT_CC_ENV_TAGS', 'envTags'), '');

  const breaker = {
    threshold: int(only('MUBIT_CC_BREAKER_THRESHOLD', 'breakerThreshold'), 5),
    windowMs: int(only('MUBIT_CC_BREAKER_WINDOW_MS', 'breakerWindowMs'), 300000),
    cooldownMs: int(only('MUBIT_CC_BREAKER_COOLDOWN_MS', 'breakerCooldownMs'), 120000),
  };

  return {
    endpoint,
    mode: MODE,
    apiKey,
    userId,
    runStrategy,
    runId,
    capture,
    recall,
    redact,
    recallTokenBudget,
    recallBudgetMs,
    recallAssemble,
    recallFallback,
    recallSections,
    policyTtlMs,
    outcomeMode,
    reflectOnEnd,
    statusLine,
    mcpTools,
    denyGlobs,
    respectGitignore,
    maxParamBytes,
    maxOutputBytes,
    batchMaxItems,
    batchMaxAgeMs,
    breaker,
    coldStartGraceMs,
    timeoutMs,
    logLevel,
    envTagsExtra,
    dataDir,
    projectDir,
    pluginRoot: str(e.CLAUDE_PLUGIN_ROOT, ''),
  };
}

// ---------------------------------------------------------------------------
// §7 config.json — 300 s TTL, keyed by an input hash
// ---------------------------------------------------------------------------

/**
 * Hash every input that can change the answer, so an env or option change
 * invalidates immediately rather than waiting out the TTL. A stale cached
 * endpoint would point every hook at the wrong instance for up to 300 s.
 */
function inputHash(e, userFileRaw, creds, projectDir, dataDir) {
  const parts = [`v${CACHE_VERSION}`, `pd=${projectDir}`, `dd=${dataDir}`, `home=${e.HOME ?? ''}`];
  const names = Object.keys(e)
    .filter((k) => k.startsWith('MUBIT_') || k.startsWith('CLAUDE_'))
    .sort();
  for (const k of names) parts.push(`${k}=${e[k]}`);
  parts.push(`file=${userFileRaw}`);
  // `/auth` runs in its own process and writes the credentials store. Without it in the
  // key, every hook in the session serves the cached, keyless config for up to 300 s:
  // the user authenticates, is told it worked, and nothing changes until the TTL lapses.
  // Sorted, so key order within the file cannot change the hash on its own.
  for (const k of Object.keys(creds ?? {}).sort()) parts.push(`cred:${k}=${creds[k]}`);
  return createHash('sha256').update(parts.join(' ')).digest('hex');
}

/** @returns {Record<string, any>|null} */
function readCache(p, key) {
  try {
    const st = statSync(p);
    if (Date.now() - st.mtimeMs >= CACHE_TTL_MS) return null;
  } catch {
    return null;
  }
  const raw = readJson(p, null);
  if (!raw || typeof raw !== 'object') return null;
  if (raw.v !== CACHE_VERSION || raw.hash !== key) return null;
  if (!raw.config || typeof raw.config !== 'object') return null;
  return raw.config;
}

/** §4.1: `Config` is a frozen object, and so is its nested `breaker` block. */
function freezeConfig(cfg) {
  const out = { ...cfg };
  out.breaker = Object.freeze({ ...(out.breaker ?? {}) });
  out.mcpTools = Object.freeze([...(out.mcpTools ?? [])]);
  out.denyGlobs = Object.freeze([...(out.denyGlobs ?? [])]);
  out.recallSections = Object.freeze([...(out.recallSections ?? [])]);
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// ${CLAUDE_PROJECT_DIR}/.mubit-cc.json
// ---------------------------------------------------------------------------

function readUserFileRaw(projectDir) {
  try {
    if (!projectDir) return '';
    return readFileSync(join(projectDir, '.mubit-cc.json'), 'utf8');
  } catch {
    return '';
  }
}

/** §12.1-F14: a malformed project file falls through to the default. */
function parseUserFile(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/**
 * Booleans arrive in two spellings: §6.1 uses `MUBIT_CC_CAPTURE=0`, while a
 * `userConfig` boolean reaches us as `CLAUDE_PLUGIN_OPTION_CAPTURE=false` —
 * which is just what a JSON `false` stringifies to. Both must coerce.
 */
function bool(v, d) {
  if (v === undefined || v === null) return d;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === '') return d;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  return d;
}

function int(v, d) {
  if (v === undefined || v === null || v === '') return d;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

function str(v, d) {
  if (v === undefined || v === null) return d;
  return typeof v === 'string' ? v : String(v);
}

function enumOf(v, allowed, d) {
  const s = str(v, '').trim().toLowerCase();
  return allowed.includes(s) ? s : d;
}

/** Comma-separated string, or an array from the project file. Blank -> default. */
function list(v, d) {
  if (Array.isArray(v)) {
    const arr = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    return arr.length ? arr : [...d];
  }
  if (typeof v === 'string') {
    const arr = splitList(v);
    return arr.length ? arr : [...d];
  }
  return [...d];
}

function splitList(v) {
  return String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

function firstNonEmpty(...vals) {
  for (const v of vals) if (typeof v === 'string' && v) return v;
  return '';
}

function safeCwd() {
  try { return process.cwd(); } catch { return '.'; }
}
