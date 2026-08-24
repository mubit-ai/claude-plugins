// @ts-check
/**
 * `lib/config.mjs`.
 *
 * Protects build-guide §4.1 (the module API and the frozen `Config` shape),
 * §6.1 (environment variables and their defaults), §6.2 (`userConfig` keys and
 * the env var each maps to), §6.3 (the `CLAUDE_PLUGIN_OPTION_*` injection
 * guard), §7 (`config.json`, 300 s TTL) and §12.6.
 *
 * `loadConfig(env = process.env)` takes its environment as an argument, so most
 * of this file drives it with explicit env objects. `process.env` is patched to
 * match anyway — a stray `MUBIT_*` in the developer's shell must never decide a
 * test, and an implementation that reaches for `process.env` internally should
 * still see the same world.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { lib, makeDataDir, makeProjectDir, withEnv, readJsonFile } from './helpers/harness.mjs';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Delete every `MUBIT_` / `CLAUDE_` variable the host shell may be carrying. */
function scrubPatch() {
  /** @type {Record<string,string|undefined>} */
  const out = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('MUBIT_') || k.startsWith('CLAUDE_')) out[k] = undefined;
  }
  return out;
}

/**
 * A minimal, fully explicit environment. Only what is passed in `extra` can
 * influence the resolved config.
 * @param {string} dataDir
 * @param {string} projectDir
 * @param {Record<string,string|undefined>} [extra]
 * @returns {Record<string,string>}
 */
function envOf(dataDir, projectDir, extra = {}) {
  /** @type {Record<string,any>} */
  const e = {
    PATH: process.env.PATH ?? '',
    HOME: dataDir,
    TZ: 'UTC',
    CLAUDE_PLUGIN_DATA: dataDir,
    MUBIT_CC_DATA_DIR: dataDir,
    CLAUDE_PROJECT_DIR: projectDir,
    ...extra,
  };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
}

/** @param {any} config @param {Record<string,string>} env */
function load(config, env) {
  return withEnv({ ...scrubPatch(), ...env }, () => config.loadConfig(env));
}

/**
 * Resolve a config and use it while the environment is still patched — for
 * helpers like `envTags()` that take no `env` argument and may legitimately
 * read `process.env` at call time.
 * @template T
 * @param {any} config @param {Record<string,string>} env @param {(cfg:any) => T} fn
 * @returns {T}
 */
function loadAnd(config, env, fn) {
  return withEnv({ ...scrubPatch(), ...env }, () => fn(config.loadConfig(env)));
}

/** `apiKey` → `API_KEY`, `recallTokenBudget` → `RECALL_TOKEN_BUDGET`. */
function screaming(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** @param {string} projectDir @param {Record<string,any>} json */
function writeProjectConfig(projectDir, json) {
  writeFileSync(join(projectDir, '.mubit-cc.json'), JSON.stringify(json, null, 2));
}

// ===========================================================================
// §4.1 precedence — one test per level, highest first
// ===========================================================================

// §4.1 level 1: userConfig wins. It is the user's deliberate per-install choice
// and where the keychain-backed apiKey lives.
test('precedence: CLAUDE_PLUGIN_OPTION_* beats MUBIT_* env', async () => {
  const config = await lib('config.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  writeProjectConfig(projectDir, { endpoint: 'http://file.example.com:3000' });

  const cfg = load(config, envOf(dataDir, projectDir, {
    CLAUDE_PLUGIN_OPTION_ENDPOINT: 'http://option.example.com:3000',
    MUBIT_ENDPOINT: 'http://env.example.com:3000',
  }));

  assert.equal(cfg.endpoint, 'http://option.example.com:3000');
});

// §4.1 level 2: MUBIT_* env beats everything below it.
test('precedence: MUBIT_* env beats ${CLAUDE_PROJECT_DIR}/.mubit-cc.json', async () => {
  const config = await lib('config.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  writeProjectConfig(projectDir, { endpoint: 'http://file.example.com:3000' });

  const cfg = load(config, envOf(dataDir, projectDir, {
    MUBIT_ENDPOINT: 'http://env.example.com:3000',
  }));

  assert.equal(cfg.endpoint, 'http://env.example.com:3000');
});

// §4.1 level 3: the credentials store `/mubit-memory:auth` writes.
//
// It sits *below* the environment so a CI job exporting MUBIT_API_KEY still wins over
// whatever a developer once authenticated as on that machine, and *above* the project
// file so a fresh login beats a stale committed `.mubit-cc.json`.
test('precedence: MUBIT_* env beats the credentials store', async () => {
  const config = await lib('config.mjs');
  const { writeCredentials } = await lib('credentials.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  writeCredentials(dataDir, { endpoint: 'http://creds.example.com:3000' });

  const cfg = load(config, envOf(dataDir, projectDir, {
    MUBIT_ENDPOINT: 'http://env.example.com:3000',
  }));

  assert.equal(cfg.endpoint, 'http://env.example.com:3000');
});

test('precedence: the credentials store beats .mubit-cc.json', async () => {
  const config = await lib('config.mjs');
  const { writeCredentials } = await lib('credentials.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  writeProjectConfig(projectDir, { endpoint: 'http://file.example.com:3000' });
  writeCredentials(dataDir, {
    endpoint: 'http://creds.example.com:3000',
    apiKey: 'mbt_from_auth',
  });

  const cfg = load(config, envOf(dataDir, projectDir));

  assert.equal(cfg.endpoint, 'http://creds.example.com:3000');
  assert.equal(cfg.apiKey, 'mbt_from_auth');
});

// The store holds `userConfig` keys, so it must reach the env-only §6.1 rows too —
// `only()` and `pick()` are two lookups over one store, not two stores.
test('precedence: the credentials store is honoured by userConfig and env-only keys alike', async () => {
  const config = await lib('config.mjs');
  const { writeCredentials } = await lib('credentials.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  writeCredentials(dataDir, { apiKey: 'mbt_k', runStrategy: 'git-branch', timeoutMs: '9111' });

  const cfg = load(config, envOf(dataDir, projectDir));

  assert.equal(cfg.apiKey, 'mbt_k');
  assert.equal(cfg.runStrategy, 'git-branch', 'a userConfig row (pick)');
  assert.equal(cfg.timeoutMs, 9111, 'an environment-only row (only)');
});

/**
 * The bug this rung invites, and the reason the raw store text is folded into the
 * cache key rather than left out of it.
 *
 * `loadConfig` caches its answer at `${dataDir}/config.json` for 300 s. `/auth` runs in
 * its own process and writes the credentials file — but if that file is not part of the
 * cache key, every hook in the session keeps returning the *cached, keyless* config for
 * up to five minutes. The user authenticates successfully, sees a confirmation, and
 * nothing starts working. Then it fixes itself, which is worse.
 */
test('writing credentials invalidates the config cache immediately, not after the 300s TTL',
  async () => {
    const config = await lib('config.mjs');
    const { writeCredentials } = await lib('credentials.mjs');
    const dataDir = makeDataDir();
    const projectDir = makeProjectDir();
    const env = envOf(dataDir, projectDir);

    const before = load(config, env);
    assert.equal(before.apiKey, '', 'precondition: unauthenticated, and now cached');

    writeCredentials(dataDir, { apiKey: 'mbt_just_logged_in' });

    const after = load(config, env);
    assert.equal(after.apiKey, 'mbt_just_logged_in',
      'the cache key must cover the credentials file, or /auth appears to do nothing for 300s');
  });

test('clearing credentials invalidates the cache the same way', async () => {
  const config = await lib('config.mjs');
  const { writeCredentials, clearCredentials } = await lib('credentials.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  const env = envOf(dataDir, projectDir);

  writeCredentials(dataDir, { apiKey: 'mbt_k' });
  assert.equal(load(config, env).apiKey, 'mbt_k');

  clearCredentials(dataDir);

  assert.equal(load(config, env).apiKey, '', 'logging out must take effect at once');
});

/**
 * `plugin.json` tells the user the key is "stored in the OS keychain, never in a
 * settings file". The resolved-config cache is a settings file, and it used to hold the
 * key in plaintext — with a 300 s TTL, so it also outlived nothing in particular.
 *
 * The key is cheap to re-resolve, so it is simply not cached.
 */
test('the config cache never contains the API key', async () => {
  const config = await lib('config.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();

  const cfg = load(config, envOf(dataDir, projectDir, { MUBIT_API_KEY: 'mbt_secret_value' }));
  assert.equal(cfg.apiKey, 'mbt_secret_value', 'precondition: the key resolved');

  const raw = readFileSync(join(dataDir, 'config.json'), 'utf8');
  assert.ok(!raw.includes('mbt_secret_value'),
    'config.json is a settings file; plugin.json promises the key is not written to one');
});

test('a cached config still resolves the API key on the way out', async () => {
  const config = await lib('config.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  const env = envOf(dataDir, projectDir, { MUBIT_API_KEY: 'mbt_secret_value' });

  load(config, env);                       // populate the cache
  const second = load(config, env);        // served from it

  assert.equal(second.apiKey, 'mbt_secret_value',
    'not caching the key must not mean losing it — it is re-read on every cache hit');
});

// §4.1 level 3: the project file beats the built-in default.
test('precedence: .mubit-cc.json beats the built-in default', async () => {
  const config = await lib('config.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  writeProjectConfig(projectDir, {
    endpoint: 'http://file.example.com:3000',
    runStrategy: 'git-branch',
    recallTokenBudget: 700,
  });

  const cfg = load(config, envOf(dataDir, projectDir));

  assert.equal(cfg.endpoint, 'http://file.example.com:3000');
  assert.equal(cfg.runStrategy, 'git-branch');
  assert.equal(cfg.recallTokenBudget, 700);
});

// §4.1 level 4: nothing set anywhere — the built-in default stands.
test('precedence: the built-in default is the floor', async () => {
  const config = await lib('config.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();

  const cfg = load(config, envOf(dataDir, projectDir));

  assert.equal(cfg.endpoint, '');
  assert.equal(cfg.runStrategy, 'per-directory');
});

// §4.1/§12.1-F14: a malformed project file cannot take the plugin down.
test('precedence: a corrupt .mubit-cc.json falls through to the default', async () => {
  const config = await lib('config.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  writeFileSync(join(projectDir, '.mubit-cc.json'), '{ "endpoint": ');

  const cfg = load(config, envOf(dataDir, projectDir));
  assert.equal(cfg.endpoint, '');
});

// ===========================================================================
// §6.3 optionValue — both spellings, in the documented order
// ===========================================================================

// §6.3: the host's exact env-name transform is undocumented, so both spellings
// are pinned. This is the cheap insurance that keeps the keychain key readable.
test('optionValue(): reads CLAUDE_PLUGIN_OPTION_API_KEY', async () => {
  const config = await lib('config.mjs');
  const env = { CLAUDE_PLUGIN_OPTION_API_KEY: 'mbt_screaming_k_s' };
  assert.equal(config.optionValue('apiKey', env), 'mbt_screaming_k_s');
});

// §6.3: the verbatim-key spelling is checked too.
test('optionValue(): reads CLAUDE_PLUGIN_OPTION_apiKey verbatim', async () => {
  const config = await lib('config.mjs');
  const env = { CLAUDE_PLUGIN_OPTION_apiKey: 'mbt_verbatim_k_s' };
  assert.equal(config.optionValue('apiKey', env), 'mbt_verbatim_k_s');
});

// §6.3: "…in that order" — SCREAMING_SNAKE first.
test('optionValue(): SCREAMING_SNAKE wins when both spellings are present', async () => {
  const config = await lib('config.mjs');
  const env = {
    CLAUDE_PLUGIN_OPTION_API_KEY: 'mbt_screaming_k_s',
    CLAUDE_PLUGIN_OPTION_apiKey: 'mbt_verbatim_k_s',
  };
  assert.equal(config.optionValue('apiKey', env), 'mbt_screaming_k_s');
});

// §6.3: an unset option is `undefined`, not `""` — blank is a meaningful value.
test('optionValue(): returns undefined when neither spelling is set', async () => {
  const config = await lib('config.mjs');
  assert.equal(config.optionValue('apiKey', {}), undefined);
});

// §6.3: both spellings reach the resolved Config, not just the raw reader.
test('optionValue(): both spellings resolve into Config.apiKey', async () => {
  const config = await lib('config.mjs');
  const projectDir = makeProjectDir();
  for (const name of ['CLAUDE_PLUGIN_OPTION_API_KEY', 'CLAUDE_PLUGIN_OPTION_apiKey']) {
    const dataDir = makeDataDir();
    const cfg = load(config, envOf(dataDir, projectDir, { [name]: 'mbt_acme_kid_secret' }));
    assert.equal(cfg.apiKey, 'mbt_acme_kid_secret', `${name} did not reach Config.apiKey`);
  }
});

// ===========================================================================
// §4.1 connection mode
// ===========================================================================

/*
 * There is one way to reach a Mubit: an instance URL and an API key. The plugin used to
 * derive a `local`/`hosted` mode from the endpoint host and fall back to a loopback
 * address when none was set, which meant an unconfigured install quietly dialled the
 * local machine. It no longer does either — a blank endpoint stays blank, and nothing
 * is sent.
 */
test('a blank endpoint stays blank — there is no default to fall back to', async () => {
  const config = await lib('config.mjs');
  const projectDir = makeProjectDir();

  const cfg = load(config, envOf(makeDataDir(), projectDir, { MUBIT_ENDPOINT: '' }));
  assert.equal(cfg.endpoint, '', 'a blank endpoint must not acquire a default');
  assert.equal(cfg.mode, 'hosted');

  const cfg2 = load(config, envOf(makeDataDir(), projectDir, {
    CLAUDE_PLUGIN_OPTION_ENDPOINT: '',
  }));
  assert.equal(cfg2.endpoint, '');
});

test('no configuration path can produce a loopback endpoint by default', async () => {
  const config = await lib('config.mjs');
  const cfg = load(config, envOf(makeDataDir(), makeProjectDir(), {}));
  assert.equal(cfg.endpoint, '');
  assert.doesNotMatch(cfg.endpoint, /127\.|localhost|::1|0\.0\.0\.0/);
});

test('the endpoint is used verbatim, whatever host it names', async () => {
  const config = await lib('config.mjs');
  for (const url of ['https://mubit.example.com', 'https://eu.mubit.ai']) {
    const cfg = load(config, envOf(makeDataDir(), makeProjectDir(), { MUBIT_ENDPOINT: url }));
    assert.equal(cfg.endpoint, url);
    assert.equal(cfg.mode, 'hosted', 'mode is a constant now — there is no second mode');
  }
});

// ===========================================================================
// §1.2 authHeaders
// ===========================================================================

// §1.2: header is `Authorization: Bearer <key>`; §12.1-F3 depends on it being
// absent (not empty) when no key is configured, so a 401 is unambiguous.
test('authHeaders(): {} when there is no key', async () => {
  const config = await lib('config.mjs');
  const cfg = load(config, envOf(makeDataDir(), makeProjectDir(), { MUBIT_API_KEY: '' }));
  assert.deepEqual(config.authHeaders(cfg), {});
});

test('authHeaders(): Bearer <key> when there is one', async () => {
  const config = await lib('config.mjs');
  const key = 'mbt_acme_0123456789abcdef_deadbeefcafebabe0123456789abcdef';
  const cfg = load(config, envOf(makeDataDir(), makeProjectDir(), { MUBIT_API_KEY: key }));
  assert.deepEqual(config.authHeaders(cfg), { Authorization: `Bearer ${key}` });
});

// ===========================================================================
// §4.1 envTags — Mubit's TYPE:NAME[:VERSION] form
// ===========================================================================

/** §4.1: language is detected from lockfiles at the project root. */
const LANG_ROWS = [
  { file: 'Cargo.toml', body: '[package]\nname = "my-crate"\n', tag: 'lang:rust' },
  { file: 'package.json', body: '{"name":"x","version":"0.0.0"}', tag: 'lang:node' },
  { file: 'pyproject.toml', body: '[project]\nname = "x"\n', tag: 'lang:python' },
];

for (const row of LANG_ROWS) {
  // §4.1: <lockfile> → lang:<x>.
  test(`envTags(): ${row.file} at the project root emits ${row.tag}`, async () => {
    const config = await lib('config.mjs');
    const dataDir = makeDataDir();
    const projectDir = makeProjectDir({ files: { [row.file]: row.body } });

    const tags = loadAnd(config, envOf(dataDir, projectDir), (cfg) => config.envTags(cfg, projectDir));
    assert.ok(tags.includes(row.tag), `expected ${row.tag} in [${tags.join(', ')}]`);
  });
}

// §4.1: the always-on identity tag, plus the TYPE:NAME[:VERSION] grammar.
test('envTags(): always carries tool:claude-code and repo:<slug>, in TYPE:NAME form', async () => {
  const config = await lib('config.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir({ files: { 'Cargo.toml': '[package]\n' } });

  const tags = loadAnd(config, envOf(dataDir, projectDir), (cfg) => config.envTags(cfg, projectDir));
  assert.ok(tags.includes('tool:claude-code'), `missing tool:claude-code in [${tags.join(', ')}]`);
  assert.ok(tags.some((t) => /^repo:\S+$/.test(t)), `missing repo:<slug> in [${tags.join(', ')}]`);
  for (const t of tags) {
    assert.match(t, /^[a-z][a-z0-9_-]*:[^\s:]+(:[^\s:]+)?$/,
      `"${t}" is not TYPE:NAME[:VERSION]`);
  }
});

// §4.1: branch:<name> comes from the checked-out branch.
test('envTags(): emits branch:<name> in a git project', async () => {
  const config = await lib('config.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir({ git: true, branch: 'wip', files: { 'Cargo.toml': '[package]\n' } });

  const tags = loadAnd(config, envOf(dataDir, projectDir), (cfg) => config.envTags(cfg, projectDir));
  assert.ok(tags.includes('branch:wip'), `expected branch:wip in [${tags.join(', ')}]`);
});

// §4.1: "extras from MUBIT_CC_ENV_TAGS appended verbatim".
test('envTags(): appends MUBIT_CC_ENV_TAGS extras verbatim', async () => {
  const config = await lib('config.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir({ files: { 'package.json': '{}' } });
  const env = envOf(dataDir, projectDir, { MUBIT_CC_ENV_TAGS: 'team:platform,service:ingest:v2' });

  const tags = loadAnd(config, env, (cfg) => config.envTags(cfg, projectDir));
  assert.ok(tags.includes('team:platform'), `missing team:platform in [${tags.join(', ')}]`);
  assert.ok(tags.includes('service:ingest:v2'), `missing service:ingest:v2 in [${tags.join(', ')}]`);
});

// §4.1: "Cap at 8" — env_tags ride on every ingested item, so the cap is a
// payload-size guarantee, not a style rule.
test('envTags(): caps at 8 tags', async () => {
  const config = await lib('config.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir({ git: true, branch: 'wip', files: { 'Cargo.toml': '[package]\n' } });
  const extras = Array.from({ length: 10 }, (_, i) => `extra${i}:v`);
  const env = envOf(dataDir, projectDir, { MUBIT_CC_ENV_TAGS: extras.join(',') });

  const tags = loadAnd(config, env, (cfg) => config.envTags(cfg, projectDir));
  assert.equal(tags.length, 8, `expected exactly 8 tags, got [${tags.join(', ')}]`);
  assert.ok(tags.includes('tool:claude-code'), 'the derived identity tag was dropped by the cap');
  assert.ok(tags.includes('extra0:v'), 'extras are appended in order; the first must survive');
});

// ===========================================================================
// §6.2 userConfig key → env var mapping, one row per §3.1 key
// ===========================================================================

/**
 * Every `userConfig` key declared in build-guide §3.1, the §6.2 env var it maps
 * to, and the resolved `Config` field it lands in. Booleans are asserted with
 * the `0`/`1` convention §6.1 uses for env vars and the `"false"` a JSON
 * boolean stringifies to when the host exports it as an option.
 */
const USER_CONFIG_ROWS = [
  { key: 'endpoint', env: 'MUBIT_ENDPOINT', field: 'endpoint', raw: 'https://mubit.example.com', want: 'https://mubit.example.com' },
  { key: 'apiKey', env: 'MUBIT_API_KEY', field: 'apiKey', raw: 'mbt_acme_kid_secret', want: 'mbt_acme_kid_secret' },
  { key: 'userId', env: 'MUBIT_CC_USER_ID', field: 'userId', raw: 'eldar@mubit.ai', want: 'eldar@mubit.ai' },
  // Rung 1 of the `lib/actor.mjs` ladder, and the neighbour of `userId` it must never be
  // confused with: this one is attribution, in item metadata; `userId` is a retrieval scope
  // the server enforces as a query filter.
  { key: 'actorId', env: 'MUBIT_CC_ACTOR_ID', field: 'actorId', raw: 'eldar', want: 'eldar' },
  { key: 'runStrategy', env: 'MUBIT_CC_RUN_STRATEGY', field: 'runStrategy', raw: 'git-branch', want: 'git-branch' },
  { key: 'capture', env: 'MUBIT_CC_CAPTURE', field: 'capture', raw: '0', optRaw: 'false', want: false },
  { key: 'recall', env: 'MUBIT_CC_RECALL', field: 'recall', raw: '0', optRaw: 'false', want: false },
  { key: 'redact', env: 'MUBIT_CC_REDACT', field: 'redact', raw: '0', optRaw: 'false', want: false },
  { key: 'recallTokenBudget', env: 'MUBIT_CC_RECALL_TOKENS', field: 'recallTokenBudget', raw: '900', want: 900 },
  { key: 'recallAssemble', env: 'MUBIT_CC_RECALL_ASSEMBLE', field: 'recallAssemble', raw: 'server', want: 'server' },
  { key: 'recallRepeatMode', env: 'MUBIT_CC_RECALL_REPEAT_MODE', field: 'recallRepeatMode', raw: 'full', want: 'full' },
  // Asserted at a concrete mode rather than at `auto`: `auto` is the default, so a row that
  // set it there would pass just as well against a key `loadConfig` never reads. `freshness`
  // is also the value an operator most plausibly pins, since it is the whole point of the key.
  { key: 'recallRankBy', env: 'MUBIT_CC_RECALL_RANK_BY', field: 'recallRankBy', raw: 'freshness', want: 'freshness' },
  // Asserted ON rather than off: the default is already false, so a row that set it to false
  // would pass just as well against a key `loadConfig` never reads.
  { key: 'recallAsync', env: 'MUBIT_CC_RECALL_ASYNC', field: 'recallAsync', raw: '1', optRaw: 'true', want: true },
  { key: 'reflectOnEnd', env: 'MUBIT_CC_REFLECT_ON_END', field: 'reflectOnEnd', raw: '0', optRaw: 'false', want: false },
  // The escape hatch for an environment that forbids background processes. Asserted off,
  // because on is the default and a row that set it to true would pass just as well against
  // a key `loadConfig` never reads.
  { key: 'sessionEndDetach', env: 'MUBIT_CC_SESSION_END_DETACH', field: 'sessionEndDetach', raw: '0', optRaw: 'false', want: false },
  { key: 'outcomeMode', env: 'MUBIT_CC_OUTCOME_MODE', field: 'outcomeMode', raw: 'explicit', want: 'explicit' },
  { key: 'statusLine', env: 'MUBIT_CC_STATUSLINE', field: 'statusLine', raw: '0', optRaw: 'false', want: false },
  { key: 'mcpTools', env: 'MUBIT_MCP_TOOLS', field: 'mcpTools', raw: 'mubit_recall,mubit_remember', want: ['mubit_recall', 'mubit_remember'] },
  { key: 'mcpLessonScope', env: 'MUBIT_MCP_LESSON_SCOPE', field: 'mcpLessonScope', raw: 'global', want: 'global' },
  // The only row that defaults to `false`, so it is the opt-*in* direction that has to be
  // proven here. Its default is asserted separately below, and again in `pre-tool.test.mjs`
  // against the running hook — this is the stage that can put text in front of a tool call.
  { key: 'preToolWarnings', env: 'MUBIT_CC_PRE_TOOL_WARNINGS', field: 'preToolWarnings', raw: '1', optRaw: 'true', want: true },
];

for (const row of USER_CONFIG_ROWS) {
  // §6.2: userConfig "<key>" maps to <env> and lands on Config.<field>.
  test(`userConfig: ${row.key} → ${row.env} → Config.${row.field}`, async () => {
    const config = await lib('config.mjs');
    const projectDir = makeProjectDir();

    const viaEnv = load(config, envOf(makeDataDir(), projectDir, { [row.env]: row.raw }));
    assert.deepEqual(viaEnv[row.field], row.want, `${row.env} did not reach Config.${row.field}`);

    const optName = `CLAUDE_PLUGIN_OPTION_${screaming(row.key)}`;
    const viaOption = load(config, envOf(makeDataDir(), projectDir, {
      [optName]: row.optRaw ?? row.raw,
    }));
    assert.deepEqual(viaOption[row.field], row.want, `${optName} did not reach Config.${row.field}`);
  });
}

// ===========================================================================
// §6.1 defaults and §4.1 immutability
// ===========================================================================

// §6.1: the default table, verbatim. These numbers are the plugin's cost and
// latency contract; drifting one silently changes what a user pays per prompt.
test('loadConfig(): the §6.1 defaults, exactly', async () => {
  const config = await lib('config.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  const cfg = load(config, envOf(dataDir, projectDir));

  assert.equal(cfg.endpoint, '');
  assert.equal(cfg.mode, 'hosted');
  assert.equal(cfg.apiKey, '');
  assert.equal(cfg.userId, '');
  // Empty by default, and detection deliberately stays out of `resolveAll`: a subprocess
  // result cached for 300 s under an input hash that cannot invalidate it is a bug waiting
  // to happen, and `drain` — detached, unbudgeted — is where the ladder belongs.
  assert.equal(cfg.actorId, '');
  assert.equal(cfg.runStrategy, 'per-directory');
  assert.equal(cfg.capture, true);
  assert.equal(cfg.recall, true);
  assert.equal(cfg.redact, true);
  assert.equal(cfg.recallBudgetMs, 1500);
  assert.equal(cfg.recallTokenBudget, 1500);
  assert.equal(cfg.recallAssemble, 'client');
  // §5.2: a memory already injected this run is repeated as a one-line pointer rather than
  // in full. `full` is the pre-seen-set behaviour and costs up to 1500 tokens every prompt.
  assert.equal(cfg.recallRepeatMode, 'pointer');
  // §5.2: `auto` decides per prompt — a handoff question ("where were we?") is ranked by
  // recency, everything else by similarity. Defaulting to `relevance` would keep the bug;
  // defaulting to `freshness` would rank every ordinary question by recency, which is the
  // same mistake pointed the other way.
  assert.equal(cfg.recallRankBy, 'auto');
  // Carry-forward recall is opt-in. Default-on would hand every install a first prompt with
  // no memory and a turn of staleness on every prompt after it, in exchange for latency
  // most instances do not have a problem with.
  assert.equal(cfg.recallAsync, false);
  assert.equal(cfg.outcomeMode, 'implicit');
  assert.equal(cfg.reflectOnEnd, true);
  // On, because the hook it governs is cancelled by the host on the way out and everything
  // left inside it — the last drain and the only call that promotes a lesson — dies there.
  assert.equal(cfg.sessionEndDetach, true);
  assert.equal(cfg.statusLine, true);
  // Off. This is the one setting that can put text in front of a tool call, so nothing
  // changes for an existing user until they ask for it — which is also what makes "measure
  // how often it fires" a safe thing to run.
  assert.equal(cfg.preToolWarnings, false);
  assert.equal(cfg.maxParamBytes, 4096);
  assert.equal(cfg.maxOutputBytes, 8192);
  assert.equal(cfg.batchMaxItems, 32);
  assert.equal(cfg.batchMaxAgeMs, 30000);
  assert.equal(cfg.timeoutMs, 4000);
  assert.deepEqual(cfg.breaker, { threshold: 5, windowMs: 300000, cooldownMs: 120000 });
  assert.equal(cfg.coldStartGraceMs, 20000);
  assert.equal(cfg.logLevel, 'warn');
  assert.equal(cfg.dataDir, dataDir);
  assert.equal(cfg.projectDir, projectDir);
  assert.ok(Array.isArray(cfg.mcpTools), 'mcpTools must be an array');
  assert.ok(cfg.mcpTools.length > 0, 'a blank MUBIT_MCP_TOOLS means the curated set, not none');
  assert.equal(cfg.mcpLessonScope, 'run',
    'the ceiling on an agent-written lesson defaults to the run it was written in — a wider\n'
    + 'default is the cross-run leak the MCP egress guard exists to close');
  assert.ok(Array.isArray(cfg.denyGlobs), 'denyGlobs must be an array');
});

// §4.1: "Config is a frozen object" — one hook must not be able to mutate the
// config another module already read.
test('loadConfig(): the Config object is frozen', async () => {
  const config = await lib('config.mjs');
  const cfg = load(config, envOf(makeDataDir(), makeProjectDir()));

  assert.equal(Object.isFrozen(cfg), true, 'Config must be frozen');
  assert.throws(() => { cfg.endpoint = 'http://evil.example.com'; }, TypeError);
  assert.equal(cfg.endpoint, '');
  assert.equal(Object.isFrozen(cfg.breaker), true, 'the nested breaker block must be frozen too');
});

// §6.1: MUBIT_CC_CAPTURE_DENY extras join the built-in denylist rather than
// replacing it — §4.4's denylist is a floor.
test('loadConfig(): MUBIT_CC_CAPTURE_DENY extras are appended to denyGlobs', async () => {
  const config = await lib('config.mjs');
  const cfg = load(config, envOf(makeDataDir(), makeProjectDir(), {
    MUBIT_CC_CAPTURE_DENY: '**/*.kdbx,infra/secrets/**',
  }));
  assert.ok(cfg.denyGlobs.includes('**/*.kdbx'));
  assert.ok(cfg.denyGlobs.includes('infra/secrets/**'));
});

// ===========================================================================
// §7 config.json — cached resolved config, 300 s TTL, keyed by an input hash
// ===========================================================================

// §4.1/§7: the cache exists so PostToolUse does not re-`git rev-parse` per tool call.
test('loadConfig(): caches the resolved config to config.json', async () => {
  const config = await lib('config.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir({ git: true });

  load(config, envOf(dataDir, projectDir));

  const p = join(dataDir, 'config.json');
  assert.equal(existsSync(p), true, 'the resolved config must be cached at config.json (§7)');
  assert.equal(typeof readJsonFile(p), 'object');
});

// §4.1: "The cache key hashes the inputs, so an env change invalidates
// immediately." A stale cached endpoint would point every hook at the wrong
// instance for up to 300 s.
test('loadConfig(): an env change invalidates the cache immediately', async () => {
  const config = await lib('config.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();

  const first = load(config, envOf(dataDir, projectDir, {
    MUBIT_ENDPOINT: 'https://first.example.com',
  }));
  assert.equal(first.mode, 'hosted');

  const second = load(config, envOf(dataDir, projectDir, {
    MUBIT_ENDPOINT: 'https://mubit.example.com',
  }));
  assert.equal(second.endpoint, 'https://mubit.example.com', 'a stale cached config was served');
  assert.equal(second.mode, 'hosted');
});

// §4.1: the same applies to a userConfig change — the user toggled an option
// and expects the next hook to honour it.
test('loadConfig(): a userConfig change invalidates the cache immediately', async () => {
  const config = await lib('config.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();

  const first = load(config, envOf(dataDir, projectDir));
  assert.equal(first.capture, true);

  const second = load(config, envOf(dataDir, projectDir, {
    CLAUDE_PLUGIN_OPTION_CAPTURE: 'false',
  }));
  assert.equal(second.capture, false, 'a stale cached config was served');
});

// §7: 300 s TTL — a cache older than that is recomputed, not served.
test('loadConfig(): a config.json older than the 300 s TTL is not served', async () => {
  const config = await lib('config.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  const env = envOf(dataDir, projectDir, { MUBIT_ENDPOINT: 'https://mubit.example.com' });

  load(config, env);
  const p = join(dataDir, 'config.json');

  // Poison every cached copy of the endpoint, then age the file past the TTL.
  const poisoned = readFileSync(p, 'utf8').split('https://mubit.example.com').join('http://stale.invalid:9999');
  writeFileSync(p, poisoned);
  const past = (Date.now() - 301 * 1000) / 1000;
  utimesSync(p, past, past);
  const agedMtime = statSync(p).mtimeMs;

  const cfg = load(config, env);
  assert.equal(cfg.endpoint, 'https://mubit.example.com',
    'a config.json past its 300 s TTL was served instead of being recomputed');
  assert.ok(statSync(p).mtimeMs > agedMtime, 'the expired cache was not refreshed');
});

// §7/§12.1-F14: a corrupt cache is a bad day, not an outage.
test('loadConfig(): a corrupt config.json is ignored', async () => {
  const config = await lib('config.mjs');
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  writeFileSync(join(dataDir, 'config.json'), '{"endpoint": "http://stale');

  const cfg = load(config, envOf(dataDir, projectDir, {
    MUBIT_ENDPOINT: 'https://mubit.example.com',
  }));
  assert.equal(cfg.endpoint, 'https://mubit.example.com');
});

// ===========================================================================
// §8.2 mcpLessonScope — the ceiling on what an MCP write may claim
// ===========================================================================

// `run` is the only safe fallback. The value this setting overrides is the bundled SDK's
// hard-coded `session`, which the control plane reads across runs — so "unparseable, keep
// what the SDK sent" would let a typo silently reinstate the leak.
test('loadConfig(): an unrecognised mcpLessonScope falls back to run', async () => {
  const config = await lib('config.mjs');
  const projectDir = makeProjectDir();

  for (const bad of ['', '   ', 'banana', 'org', 'RUN?', 'session,global']) {
    const cfg = load(config, envOf(makeDataDir(), projectDir, { MUBIT_MCP_LESSON_SCOPE: bad }));
    assert.equal(cfg.mcpLessonScope, 'run',
      `${JSON.stringify(bad)} resolved to ${JSON.stringify(cfg.mcpLessonScope)} — the fallback `
      + 'must be the narrowest scope, never the widest and never the SDK default');
  }
});

// The three the control plane accepts from a client. `org` is promotion-only (§1.6) and is
// deliberately absent: a client that could name it could write a tenant-wide rule.
test('loadConfig(): mcpLessonScope accepts run, session and global — and nothing else', async () => {
  const config = await lib('config.mjs');
  const projectDir = makeProjectDir();

  for (const good of ['run', 'session', 'global']) {
    const cfg = load(config, envOf(makeDataDir(), projectDir, { MUBIT_MCP_LESSON_SCOPE: good }));
    assert.equal(cfg.mcpLessonScope, good);
  }

  const org = load(config, envOf(makeDataDir(), projectDir, { MUBIT_MCP_LESSON_SCOPE: 'org' }));
  assert.equal(org.mcpLessonScope, 'run',
    'org is promotion-only and must never be client-written (§1.6)');
});
