// @ts-check
/**
 * `claude plugin eval` as the primary A/B harness, and the wrapper that makes it usable
 * against a plugin living in another worktree.
 *
 * The host already provides everything a plugin ablation needs: `--ablation with-without`
 * is its default, it gives each run an isolated sandbox, it ships six grader types,
 * averages over runs, enforces a cost ceiling, and writes a stable `aggregate-result.json`.
 * Rebuilding any of that would be work spent to end up behind. The wrapper's whole job is
 * the two things the host deliberately does not do for us:
 *
 *  1. **Get the cases under the plugin.** `--eval-dir` must name a path *below the plugin*
 *     — an absolute path is refused outright ("must be a relative path inside the plugin").
 *     A kit that lives in a different worktree therefore has to reach in, and it does that
 *     with a symlink it also removes.
 *
 *  2. **Get credentials into the sandbox.** Every run gets a fresh `HOME` and
 *     `CLAUDE_CONFIG_DIR`, so the plugin's stored `credentials.json` is not there and the
 *     "with" arm would otherwise carry an *unconfigured* plugin that dials nothing — an
 *     ablation whose treatment is dead. The obvious fix does not work: `case.yaml`'s
 *     `execution.env` is restricted to `EVAL_*` keys and refuses anything else, saying so
 *     in as many words ("Anything else must come from the operator's shell"). So the
 *     operator's shell is where they go, and this wrapper is the operator.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { KIT_ROOT } from './paths.mjs';
import { resolveCredentials } from './arms.mjs';

/** The env var that gets past the early-access gate. */
export const GATE_ENV = 'CLAUDE_CODE_WALNUT_SPIRE';

/** The directory name the symlink takes inside the plugin under test. */
export const LINK_NAME = 'testkit-evals';

/**
 * The fully-qualified MCP tool names the host will expose for this plugin.
 *
 * Needed because `--allow-tools` **refuses wildcards** — `mcp__*` comes back as "a wildcard
 * tool name it does not support" — and MCP tools are gated, so without an explicit grant the
 * model is handed none of them. A "with" arm that loaded the plugin perfectly then sees zero
 * `mubit_*` tools and every with-only indicator goes silent, which reads as "the plugin does
 * nothing". That is the failure this function exists to prevent, and it cost two real eval
 * runs to find.
 *
 * Derived offline from the plugin's own manifest and `.mcp.json` rather than by probing:
 * `mcp__plugin_<pluginName>_<serverKey>__<toolName>`. `test/coverage-and-evals.test.mjs`
 * pins the result against names captured from a real `system/init` event, so a version that
 * changes the shape fails the selftest instead of the sweep.
 *
 * @param {string} pluginDir @returns {string[]}
 */
export function mcpToolNames(pluginDir) {
  const manifest = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
  const pluginName = String(manifest.name || '');

  let servers = [];
  try {
    servers = Object.keys(JSON.parse(readFileSync(join(pluginDir, '.mcp.json'), 'utf8')).mcpServers || {});
  } catch { return []; }

  /** @type {string[]} */
  let tools = [];
  try {
    const cc = JSON.parse(readFileSync(join(pluginDir, 'scripts', 'context-cost.json'), 'utf8'));
    tools = cc?.surface?.registered || cc?.surface?.allowlist || [];
  } catch { /* fall through */ }
  if (!tools.length) tools = manifest?.userConfig?.mcpTools?.default || [];

  const out = [];
  for (const server of servers) for (const tool of tools) out.push(`mcp__plugin_${pluginName}_${server}__${tool}`);
  return out.sort();
}

/**
 * Is `plugin eval` usable on this machine?
 *
 * Cheap by construction: `--case` with a name nothing matches makes the command run its
 * real discovery path and stop before spawning an agent, so the probe costs nothing and
 * still distinguishes "gated" from "open" from "open only with the escape hatch".
 *
 * @param {string} pluginDir
 * @returns {{state: 'gated'|'open'|'open-with-escape'|'missing', bare: string, escaped: string}}
 */
export function probeGate(pluginDir) {
  const probe = (env) => {
    try {
      return execFileSync('claude', ['plugin', 'eval', pluginDir, '--case', '__testkit_probe__'], {
        encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
      });
    } catch (err) {
      const e = /** @type {any} */ (err);
      return `${e.stdout || ''}${e.stderr || ''}` || String(e.message || '');
    }
  };

  const bare = probe({});
  if (/No eval cases found/i.test(bare)) return { state: 'open', bare, escaped: '' };
  if (/early access/i.test(bare)) {
    const escaped = probe({ [GATE_ENV]: '1' });
    if (/No eval cases found/i.test(escaped)) return { state: 'open-with-escape', bare, escaped };
    return { state: 'gated', bare, escaped };
  }
  return { state: 'missing', bare, escaped: '' };
}

/**
 * Symlink the kit's cases into the plugin under test.
 *
 * The link is added to that worktree's `.git/info/exclude` rather than its `.gitignore`,
 * so installing the kit never dirties the target's tree — `preflight`'s dist-freshness
 * story depends on the target staying clean.
 *
 * @param {string} pluginDir @returns {{link: string, action: string}}
 */
export function install(pluginDir) {
  const link = join(pluginDir, LINK_NAME);
  const target = join(KIT_ROOT, 'evals');

  if (existsSync(link) || isLink(link)) {
    if (isLink(link) && safeRealpath(link) === safeRealpath(target)) return { link, action: 'already installed' };
    throw new Error(`${link} exists and is not our symlink — refusing to replace it`);
  }
  symlinkSync(target, link, 'dir');
  excludeInGit(pluginDir, LINK_NAME);
  return { link, action: 'linked' };
}

/** @param {string} pluginDir @returns {{link: string, action: string}} */
export function uninstall(pluginDir) {
  const link = join(pluginDir, LINK_NAME);
  if (!isLink(link)) return { link, action: existsSync(link) ? 'left alone (not a symlink)' : 'not installed' };
  rmSync(link);
  unexcludeInGit(pluginDir, LINK_NAME);
  return { link, action: 'removed' };
}

/** @param {string} p */
function isLink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
/** @param {string} p */
function safeRealpath(p) { try { return realpathSync(p); } catch { return p; } }

/**
 * The exclude file git actually reads.
 *
 * `--git-dir` is the wrong answer in a linked worktree: it points at
 * `.git/worktrees/<name>/`, which git will happily let you write an `info/exclude` into and
 * then ignore. Only the common dir's copy takes effect, and it is shared by every worktree
 * of the repo — which is why `uninstall` removes the line rather than leaving it behind.
 *
 * @param {string} repoDir @returns {string|null}
 */
function excludeFile(repoDir) {
  try {
    const dir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repoDir, encoding: 'utf8' }).trim();
    const abs = dir.startsWith('/') ? dir : join(repoDir, dir);
    mkdirSync(join(abs, 'info'), { recursive: true });
    return join(abs, 'info', 'exclude');
  } catch { return null; }
}

/** @param {string} repoDir @param {string} entry */
function excludeInGit(repoDir, entry) {
  const file = excludeFile(repoDir);
  if (!file) return;
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (cur.split('\n').includes(entry)) return;
  appendFileSync(file, `${!cur || cur.endsWith('\n') ? '' : '\n'}${entry}\n`);
}

/** @param {string} repoDir @param {string} entry */
function unexcludeInGit(repoDir, entry) {
  const file = excludeFile(repoDir);
  if (!file || !existsSync(file)) return;
  const kept = readFileSync(file, 'utf8').split('\n').filter((l) => l !== entry);
  writeFileSync(file, kept.join('\n'));
}

/** @returns {string[]} case names present in the kit */
export function listCases() {
  const dir = join(KIT_ROOT, 'evals');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, 'prompt.md')) || existsSync(join(dir, d, 'case.yaml')))
    .sort();
}

/**
 * Run the suite.
 *
 * @param {object} o
 * @param {string} o.pluginDir @param {string} o.outDir @param {string} o.model
 * @param {number} [o.runs] @param {number} [o.maxCostUsd] @param {string} [o.caseGlob]
 * @param {string} [o.dataDir] a seeded data dir, exported so the sandbox plugin can find it
 * @param {boolean} [o.keepTemp] keep the scaffold dirs, so `tracePath` survives the run
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, jsonPath: string, argv: string[]}>}
 */
export function run({ pluginDir, outDir, model, runs = 3, maxCostUsd = 5, caseGlob, dataDir, keepTemp }) {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, 'aggregate-result.json');
  const creds = resolveCredentials();

  const argv = [
    'plugin', 'eval', pluginDir,
    '--eval-dir', LINK_NAME,
    '--ablation', 'with-without',
    '--runs', String(runs),
    '--model', model,
    '--max-cost-usd', String(maxCostUsd),
    '--no-publish',
    // MCP tools are GATED: without an operator grant the model is handed none of them, and a
    // "with" arm that loaded the plugin still sees zero `mubit_*` tools. Verified — the
    // indicator grader failed on a perfectly healthy plugin until this was added. `Skill` is
    // granted for the same reason: the skill-firing cases cannot fire a skill without it.
    // Concrete names, never a glob: `--allow-tools mcp__*` is refused outright.
    '--allow-tools', ...mcpToolNames(pluginDir), 'Skill',
    '--output-dir', outDir,
    '--json', jsonPath,
    '--report', join(outDir, 'report.html'),
    // Without this the suite exits 1 whenever any case scores below 1.0, which turns a
    // partial-credit ablation into a hard failure and hides the numbers we came for.
    '--threshold', '0',
  ];
  if (caseGlob) argv.push('--case', caseGlob);
  // Without these a failing case is undiagnosable after the fact: `tracePath` in the
  // aggregate points into a temp dir the harness deletes on exit, and `--verbose` writes its
  // per-message trace only to a debug file. A silent with-only indicator is exactly the
  // situation where you need both, so the wrapper always keeps the debug log and takes
  // --keep-temp on request.
  argv.push('--verbose', '--debug-file', join(outDir, 'eval-debug.log'));
  if (keepTemp) argv.push('--keep-temp');

  /** @type {Record<string,string>} */
  const env = {
    [GATE_ENV]: '1',
    // The sandbox's fresh HOME means the plugin finds no credentials.json. These are the
    // only channel left open to us: `execution.env` refuses non-EVAL_* keys by design.
    MUBIT_ENDPOINT: creds.endpoint,
    MUBIT_API_KEY: creds.apiKey,
    MUBIT_CC_RUN_STRATEGY: 'static',
    MUBIT_CC_LOG_LEVEL: 'debug',
    ...(dataDir ? { MUBIT_CC_DATA_DIR: dataDir } : {}),
  };

  return new Promise((resolve) => {
    const child = spawn('claude', argv, { cwd: pluginDir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; process.stdout.write(c); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr, jsonPath, argv }));
    child.on('error', (err) => resolve({ code: null, stdout, stderr: String(err.message), jsonPath, argv }));
  });
}

/**
 * Read an `aggregate-result.json` — the host's, or the shim's.
 *
 * One reader for both is the point: when the gate is open the shim is deleted and nothing
 * downstream has to change. `plugins[]` is surfaced because it is the eval path's version
 * of the arm check — a suite whose plugin entry carries a `problem` ran its "with" arm
 * without the plugin, and every delta in the file is then meaningless.
 *
 * @param {string} path
 * @returns {{ok: boolean, source: string, plugins: any[], problems: string[], cases: any[], aggregates: any}|null}
 */
export function readAggregate(path) {
  if (!existsSync(path)) return null;
  /** @type {any} */
  let j;
  try { j = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }

  const plugins = j?.suite?.plugins || j?.plugins || [];
  const problems = plugins.filter((p) => p?.problem).map((p) => `${p.name || '?'}: ${p.problem}`);
  const cases = j?.cases || [];

  // The scored delta is only half the story, and on a plugin ablation it is the less
  // interesting half: a `with-only` grader is marked `scored: false` by design, so a plugin
  // whose every indicator failed can still report meanDelta 0 and overallScore 1. The
  // indicators are what actually say "the plugin did something", so they are pulled out here
  // rather than left buried three levels down in the per-run grader arrays.
  const indicators = [];
  for (const c of cases) {
    for (const run of c?.arms?.with || []) {
      for (const g of run?.graders || []) {
        if (g?.withOnly) indicators.push({ case: c.name, name: g.name, passed: Boolean(g.passed), explanation: String(g.explanation || '') });
      }
    }
  }
  const indicatorsPassed = indicators.filter((i) => i.passed).length;

  return {
    ok: problems.length === 0,
    source: j?.shim ? 'lab.mjs ab --shim-eval' : 'claude plugin eval',
    plugins,
    problems,
    cases,
    partial: Boolean(j?.partial),
    costUsd: Number(j?.costUsd ?? 0),
    aggregates: j?.aggregates || null,
    indicators,
    indicatorsPassed,
    // A suite where the plugin loaded and NOTHING it does was detected is not a null result,
    // it is a broken suite — most often a missing tool grant.
    detectedPlugin: indicators.length === 0 ? null : indicatorsPassed > 0,
  };
}

/**
 * The fallback that keeps the pipeline alive if the gate ever closes again.
 *
 * Deliberately minimal and deliberately labelled: it emits the host's own v1 shape from
 * `lab.mjs ab` trials so `readAggregate` can read either, and it scores nothing an LLM
 * would have to judge. It is throwaway by construction — when the gate is open, this
 * function is dead code and should be deleted rather than maintained.
 *
 * @param {any[]} trials @param {string} outPath @returns {string}
 */
export function writeShimAggregate(trials, outPath) {
  const arms = { with: 'treatment', without: 'control' };
  const scoreOf = (t) => (t.mubit?.loaded && (t.mubit?.recall_sources || []).some((s) => s > 0) ? 1 : 0);
  const runsFor = (arm) => trials.filter((t) => t.arm === arm).map((t) => ({
    error: null,
    score: scoreOf(t),
    passed: scoreOf(t) === 1,
    turns: t.steps,
    costUsd: t.cost_usd,
    durationSeconds: t.span_s,
    graders: [
      { name: 'plugin-loaded', passed: Boolean(t.mubit?.loaded), withOnly: arm === 'treatment', scored: false, explanation: 'system/init plugins[]' },
      { name: 'recall-injected', passed: (t.mubit?.recall_sources || []).some((s) => s > 0), withOnly: arm === 'treatment', scored: false, explanation: 'debug-file status line' },
    ],
  }));

  const w = runsFor(arms.with);
  const wo = runsFor(arms.without);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  const doc = {
    shim: 'mubit-testkit — NOT `claude plugin eval` output. Delete this path once the gate is open.',
    schemaVersion: 1,
    partial: false,
    costUsd: [...w, ...wo].reduce((a, r) => a + (r.costUsd || 0), 0),
    suite: { ablation: 'with-without', plugins: [{ name: 'mubit-memory', version: 'unknown', path: '' }] },
    cases: [{ name: 'ab-sweep', dir: '(shim)', arms: { with: w, without: wo } }],
    aggregates: {
      casesTotal: 1,
      casesPassed: mean(w.map((r) => (r.passed ? 1 : 0))) === 1 ? 1 : 0,
      overallScore: mean(w.map((r) => r.score)),
      overallPassRate: mean(w.map((r) => (r.passed ? 1 : 0))),
      meanDelta: mean(w.map((r) => r.score)) - mean(wo.map((r) => r.score)),
    },
  };
  mkdirSync(join(outPath, '..'), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
  return outPath;
}
