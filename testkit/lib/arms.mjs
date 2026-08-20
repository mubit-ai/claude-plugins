// @ts-check
/**
 * What "plugin on" and "plugin off" mean, expressed as argv + env.
 *
 * The single most likely way this kit lies is an arm that is not what it claims: a control
 * that quietly loaded the marketplace copy of the plugin, or a treatment whose
 * `--plugin-dir` pointed at a manifest the host rejected. Both score as "no difference",
 * which is indistinguishable from a real null result. So the arms are built here, once,
 * from discovered facts rather than a hardcoded list, and `preflight` proves each one by
 * reading `system/init` back out of a real session.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { hashOf } from './versions.mjs';

/**
 * Every `plugin@marketplace` id the ambient install would enable.
 *
 * Read rather than hardcoded, because the answer is per-machine: this account has two LSP
 * plugins and a skills pack alongside `mubit-memory`, and an arm that leaves those on is
 * measuring them too. Missing one is silent, so the discovery is deliberately greedy —
 * anything mentioned as enabled anywhere gets disabled in both arms.
 *
 * @param {string} [cwd] project root, whose `.claude/settings*.json` also counts
 * @returns {string[]} sorted `plugin@marketplace` ids
 */
export function ambientPlugins(cwd = process.cwd()) {
  const files = [
    join(homedir(), '.claude', 'settings.json'),
    join(homedir(), '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ];
  /** @type {Set<string>} */
  const ids = new Set();
  for (const f of files) {
    if (!existsSync(f)) continue;
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      for (const id of Object.keys(j?.enabledPlugins || {})) ids.add(id);
    } catch { /* a malformed settings file is the host's problem, not ours */ }
  }
  return [...ids].sort();
}

/**
 * The `--settings` payload that takes every ambient plugin out of the picture.
 *
 * This is a JSON *string*, not a path — the host accepts either, and passing the object
 * inline is what keeps the arm reproducible from the recorded argv alone.
 *
 * @param {string[]} ids @returns {string}
 */
export function disableSettings(ids) {
  /** @type {Record<string, boolean>} */
  const enabledPlugins = {};
  for (const id of ids) enabledPlugins[id] = false;
  return JSON.stringify({ enabledPlugins });
}

/**
 * The arm table.
 *
 * `control` and `treatment` are the pair every command uses. `sham` is a negative control
 * used by `test/negative.test.mjs`: a real `--plugin-dir` whose hooks and MCP server have
 * been removed. If a sham arm ever reports recall latency, the kit is reading another
 * session's state — see N1 in the README.
 *
 * `on-async` exists because `recallAsync` is the one config lever that moves the headline
 * felt-latency number, and A/Bing it needs no new machinery.
 */
/**
 * Endpoint and API key, resolved the way the plugin itself would — except that the plugin
 * cannot help us here.
 *
 * A `--plugin-dir` install writes to `~/.claude/plugins/data/mubit-memory-inline`, and the
 * marketplace install's credentials live under `-mubit`. They do not share. On top of that
 * every arm pins its own `MUBIT_CC_DATA_DIR`, so there is no stored credential anywhere on
 * the path: without an explicit injection the treatment arm runs an *unconfigured* plugin
 * that dials nothing, and the A/B reports "no benefit" for a reason that has nothing to do
 * with the plugin. This is the same trap `case.yaml`'s `execution.env` exists to dodge on
 * the eval path.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {{endpoint: string, apiKey: string, from: string}}
 */
export function resolveCredentials(env = process.env) {
  if (env.MUBIT_ENDPOINT && env.MUBIT_API_KEY) {
    return { endpoint: env.MUBIT_ENDPOINT, apiKey: env.MUBIT_API_KEY, from: 'env' };
  }
  const base = join(homedir(), '.claude', 'plugins', 'data');
  let dirs = [];
  try {
    dirs = readdirSync(base).filter((d) => d.startsWith('mubit-memory')).sort();
  } catch { /* no install on this machine */ }
  // Prefer a marketplace install: `-inline` is what --plugin-dir writes, and it is the one
  // directory guaranteed never to have been through `/mubit-memory:auth`.
  dirs.sort((a, b) => Number(a.endsWith('-inline')) - Number(b.endsWith('-inline')));
  for (const d of dirs) {
    try {
      const j = JSON.parse(readFileSync(join(base, d, 'credentials.json'), 'utf8'));
      if (j?.endpoint && j?.apiKey) return { endpoint: String(j.endpoint), apiKey: String(j.apiKey), from: `${d}/credentials.json` };
    } catch { /* not this one */ }
  }
  return { endpoint: env.MUBIT_ENDPOINT || '', apiKey: env.MUBIT_API_KEY || '', from: 'nowhere' };
}

export const ARMS = {
  control: { id: 'control', plugin: false, env: {}, note: 'no --plugin-dir; all ambient plugins disabled' },
  treatment: { id: 'treatment', plugin: true, env: {}, note: 'plugin under test via --plugin-dir' },
  'on-async': { id: 'on-async', plugin: true, env: { MUBIT_CC_RECALL_ASYNC: '1' }, note: 'recallAsync — UserPromptSubmit becomes a file read' },
  'on-warn': { id: 'on-warn', plugin: true, env: { MUBIT_CC_PRE_TOOL_WARNINGS: '1' }, note: 'preToolWarnings — the opt-in interruptive surface' },
  sham: { id: 'sham', plugin: true, env: {}, sham: true, note: 'negative control: plugin dir with hooks and MCP stripped' },
};

/** @returns {string} identity of the arm definitions, for the comparability gate */
export function armsHash() {
  return hashOf(ARMS);
}

/**
 * Build the argv and env for one run.
 *
 * Every flag here has a reason, and the ones that look optional are not:
 *   - `--output-format stream-json --verbose` is the only way to get both the `system/init`
 *     event (which proves the arm) and the `result` envelope (which carries the metrics).
 *   - `--model` is pinned because an unpinned model makes two sweeps incomparable.
 *   - `--exclude-dynamic-system-prompt-sections` cuts cache-creation noise, which otherwise
 *     dominates cost: a 44-output-token call can bill $0.014 on a 6.4k-token cache write.
 *   - `--strict-mcp-config` and `--setting-sources ''` stop user config leaking into an arm.
 *   - `MUBIT_CC_RUN_STRATEGY=static` with a pinned run id is what lets `mubit-inspect` find
 *     exactly this run's state afterwards without guessing at a directory hash.
 *
 * @param {object} o
 * @param {keyof ARMS | string} o.arm
 * @param {string} o.pluginDir      resolved plugin dir (ignored for `control`)
 * @param {string} o.prompt
 * @param {string} o.model
 * @param {string} o.dataDir        per-run, so arms cannot see each other's state
 * @param {string} o.runId
 * @param {string} o.debugFile
 * @param {string[]} o.ambient
 * @param {Record<string,string>} [o.extraEnv]
 * @returns {{argv: string[], env: Record<string,string>, spec: any}}
 */
export function buildRun({ arm, pluginDir, prompt, model, dataDir, runId, debugFile, ambient, extraEnv = {} }) {
  const spec = ARMS[arm];
  if (!spec) throw new Error(`unknown arm "${arm}" (have: ${Object.keys(ARMS).join(', ')})`);

  const argv = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--permission-mode', 'acceptEdits',
    // NOT --strict-mcp-config. It suppresses the plugin's OWN MCP server: with the flag the
    // init event reports `mcp_servers: []` and zero mubit tools; without it, the server
    // connects and all ten appear. Since the MCP surface is the bulk of the plugin's context
    // cost, an arm carrying that flag measures a plugin with most of itself missing.
    // `--setting-sources ''` is what keeps the *user's* MCP servers out, and it is enough:
    // verified that the only server in the treatment arm is `plugin:mubit-memory:mubit`.
    '--setting-sources', '',
    '--exclude-dynamic-system-prompt-sections',
    '--settings', disableSettings(ambient),
    '--debug-file', debugFile,
  ];
  if (spec.plugin) argv.push('--plugin-dir', pluginDir);

  const creds = resolveCredentials();

  /** @type {Record<string,string>} */
  const env = {
    // Injected explicitly: see `resolveCredentials`. A pinned data dir has no stored key,
    // so leaving this to the plugin produces a silently unconfigured treatment arm.
    ...(creds.endpoint ? { MUBIT_ENDPOINT: creds.endpoint } : {}),
    ...(creds.apiKey ? { MUBIT_API_KEY: creds.apiKey } : {}),
    MUBIT_CC_DATA_DIR: dataDir,
    MUBIT_CC_RUN_STRATEGY: 'static',
    MUBIT_CC_RUN_ID: runId,
    MUBIT_CC_LOG_LEVEL: 'debug',
    ...spec.env,
    ...extraEnv,
  };

  // The control arm has no plugin, so a key in its environment can only confuse a reader of
  // the recorded run. Strip it rather than explain it.
  if (!spec.plugin) { delete env.MUBIT_ENDPOINT; delete env.MUBIT_API_KEY; }

  return { argv, env, spec };
}

/**
 * Env that must NOT be set when a sweep starts.
 *
 * `lib/config.mjs` puts env above `credentials.json`, so a leftover
 * `MUBIT_ENDPOINT=http://127.0.0.1:3100` from a local-server session silently measures the
 * wrong instance and every number is real, reproducible, and about something else.
 */
export const LEAK_PREFIXES = ['MUBIT_', 'CLAUDE_PLUGIN_'];

/**
 * The kit's own variables, which share the `MUBIT_` prefix and are not leaks.
 * `MUBIT_LAB_RESULTS` in particular is set by the documented first line of the reuse loop.
 */
export const KIT_OWNED_ENV = ['MUBIT_LAB_RESULTS'];

/**
 * @param {Record<string,string|undefined>} [env]
 * @param {string[]} [allow] names the caller is deliberately setting
 * @returns {{name: string, value: string}[]}
 */
export function envLeaks(env = process.env, allow = []) {
  const ok = new Set([...KIT_OWNED_ENV, ...allow]);
  const out = [];
  for (const [name, value] of Object.entries(env)) {
    if (ok.has(name)) continue;
    if (!LEAK_PREFIXES.some((p) => name.startsWith(p))) continue;
    out.push({ name, value: /KEY|TOKEN|SECRET|PASSWORD/i.test(name) ? '<redacted>' : String(value) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
