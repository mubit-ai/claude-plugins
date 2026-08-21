// @ts-check
/**
 * The workflow taxonomy, and the coverage matrix generated from it.
 *
 * The matrix is generated, never hand-maintained, and it is generated against the *plugin
 * under test* rather than a list typed into this file. That is what makes it survive a
 * version bump: when 0.11.0 renames a hook or adds an MCP tool, `lab.mjs ux --check` fails
 * the same day instead of the matrix quietly describing a plugin that no longer exists.
 *
 * The output's most useful column is the one nobody asks for: the UNTESTED list. A grid
 * makes a gap visible as a hole; a list of scenarios makes it invisible.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from './paths.mjs';

/** The four workflow families — axis A. What the user came to do. */
export const FAMILIES = [
  { id: 'W1', name: 'Everyday coding', gloss: 'bugfix or small feature in a repo you know' },
  { id: 'W2', name: 'Cross-session continuity', gloss: 'session 1 teaches, a fresh session 2 should already know' },
  { id: 'W3', name: 'Onboarding', gloss: 'first contact with an unfamiliar repo' },
  { id: 'W4', name: 'Non-code', gloss: 'design, planning, docs, research' },
];

/**
 * The eight memory moments — axis B. When the plugin can help, annoy, or do nothing.
 *
 * These are the cells. A family with no scenario at a moment has an untested path through
 * the product, which is a different and more interesting fact than "we have 15 scenarios".
 */
export const MOMENTS = [
  { id: 'M1', name: 'Session opening', surface: 'SessionStart steer block + global lessons' },
  { id: 'M2', name: 'Pre-prompt recall', surface: 'UserPromptSubmit → <mubit-memory>, blocking' },
  { id: 'M3', name: 'Mid-task warning', surface: 'PreToolUse <mubit-rules> — off by default' },
  { id: 'M4', name: 'Capture', surface: 'PostToolUse / Stop / failures — invisible, must stay invisible' },
  { id: 'M5', name: 'Compaction', surface: 'PreCompact checkpoint — the only user-visible failure message' },
  { id: 'M6', name: 'Session end', surface: 'SessionEnd detached reflect — the only cross-session promotion path' },
  { id: 'M7', name: 'Cross-session payoff', surface: 'recall in a later session returning what M6 promoted' },
  { id: 'M8', name: 'Degraded', surface: 'offline / auth failed / policy denied / dry streak' },
];

/**
 * Everything the plugin under test actually exposes. Read, never typed twice.
 *
 * @param {string} pluginDir
 * @returns {{hooks: string[], tools: string[], skills: string[], agents: string[], config: string[]}}
 */
export function groundTruth(pluginDir) {
  /** @type {string[]} */ let hooks = [];
  const hp = join(pluginDir, 'hooks', 'hooks.json');
  if (existsSync(hp)) hooks = Object.keys(JSON.parse(readFileSync(hp, 'utf8')).hooks || {});

  /** @type {string[]} */ let tools = [];
  const cc = join(pluginDir, 'scripts', 'context-cost.json');
  if (existsSync(cc)) {
    const j = JSON.parse(readFileSync(cc, 'utf8'));
    tools = j?.surface?.allowlist || j?.surface?.registered || [];
  }
  if (!tools.length) {
    // Older versions have no context-cost snapshot; fall back to the manifest's own list.
    const mp = join(pluginDir, '.claude-plugin', 'plugin.json');
    if (existsSync(mp)) {
      const m = JSON.parse(readFileSync(mp, 'utf8'));
      tools = m?.userConfig?.mcpTools?.default || [];
    }
  }

  const lsDir = (p) => { try { return readdirSync(p).filter((d) => !d.startsWith('.')); } catch { return []; } };
  const skills = lsDir(join(pluginDir, 'skills'));
  const agents = lsDir(join(pluginDir, 'agents')).map((f) => f.replace(/\.md$/, ''));

  /** @type {string[]} */ let config = [];
  const mp = join(pluginDir, '.claude-plugin', 'plugin.json');
  if (existsSync(mp)) config = Object.keys(JSON.parse(readFileSync(mp, 'utf8')).userConfig || {});

  return { hooks: hooks.sort(), tools: [...tools].sort(), skills: skills.sort(), agents: agents.sort(), config: config.sort() };
}

/** @typedef {{id: string, title: string, family: string, moments: string[], primaryMoment: string, sessions: string, duration: string, file: string, touch: {hooks: string[], tools: string[], skills: string[], config: string[]}, primary: Set<string>}} Scenario */

/**
 * Parse one scenario file.
 *
 * The format is rigid on purpose: a `## Touchpoints` fence with `hooks:`/`tools:`/`skills:`/
 * `config:` keys, where a trailing `*` marks the touchpoint the scenario is primarily about.
 * Rigid means diffable across versions and machine-checkable, which is the whole reason the
 * scenarios are files rather than a wiki page.
 *
 * @param {string} file @returns {Scenario|null}
 */
export function parseScenario(file) {
  const text = readFileSync(file, 'utf8');
  const h1 = text.match(/^#\s+(W\d-\d+)\s+—\s+(.+)$/m);
  if (!h1) return null;

  const meta = text.match(/\*\*Family\*\*\s*([^·\n]+)(?:·\s*\*\*Moments\*\*\s*([^·\n]+))?(?:·\s*\*\*Sessions\*\*\s*([^·\n]+))?(?:·\s*\*\*Duration\*\*\s*([^·\n]+))?/);
  const moments = (meta?.[2] || '').split(',').map((s) => s.trim().replace(/\*$/, '')).filter(Boolean);
  const primaryMoment = ((meta?.[2] || '').split(',').find((s) => s.trim().endsWith('*')) || moments[0] || '').trim().replace(/\*$/, '');

  const fence = text.match(/##\s*Touchpoints[\s\S]*?```\n([\s\S]*?)```/);
  /** @type {any} */
  const touch = { hooks: [], tools: [], skills: [], config: [] };
  const primary = new Set();
  if (fence) {
    for (const line of fence[1].split('\n')) {
      const m = line.match(/^\s*(hooks|tools|skills|config)\s*:\s*(.*)$/);
      if (!m) continue;
      for (const raw of m[2].split(',')) {
        const v = raw.trim();
        if (!v || v === '—') continue;
        const bare = v.replace(/\*$/, '');
        touch[m[1]].push(bare);
        if (v.endsWith('*')) primary.add(bare);
      }
    }
  }

  return {
    id: h1[1],
    title: h1[2].trim(),
    family: (meta?.[1] || '').trim().split(/\s+/)[0] || h1[1].slice(0, 2),
    moments,
    primaryMoment,
    sessions: (meta?.[3] || '1').trim(),
    duration: (meta?.[4] || '').trim(),
    file,
    touch,
    primary,
  };
}

/** @param {string} [dir] @returns {Scenario[]} */
export function loadScenarios(dir = join(KIT_ROOT, 'ux', 'scenarios')) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => parseScenario(join(dir, f)))
    .filter(/** @returns {s is Scenario} */ (s) => Boolean(s));
}

/**
 * Cross the scenarios with the ground truth.
 *
 * @param {Scenario[]} scenarios @param {ReturnType<typeof groundTruth>} truth
 * @returns {{matrix: {touchpoint: string, kind: string, cells: string[]}[], untested: {kind: string, name: string}[], drift: {scenario: string, kind: string, name: string}[], momentGrid: any[]}}
 */
export function coverage(scenarios, truth) {
  const kinds = /** @type {const} */ (['hooks', 'tools', 'skills', 'config']);
  const truthFor = { hooks: truth.hooks, tools: truth.tools, skills: truth.skills, config: truth.config };

  const matrix = [];
  const untested = [];
  const drift = [];

  for (const kind of kinds) {
    for (const name of truthFor[kind]) {
      const cells = scenarios.map((s) => (s.touch[kind].includes(name) ? (s.primary.has(name) ? 'X' : 'x') : ''));
      if (cells.some(Boolean)) matrix.push({ touchpoint: name, kind, cells });
      else untested.push({ kind, name });
    }
    // A scenario naming something the plugin does not have is the drift alarm.
    for (const s of scenarios) {
      for (const name of s.touch[kind]) {
        if (!truthFor[kind].includes(name)) drift.push({ scenario: s.id, kind, name });
      }
    }
  }

  const momentGrid = MOMENTS.map((m) => ({
    moment: m.id,
    name: m.name,
    ...Object.fromEntries(FAMILIES.map((f) => [
      f.id,
      scenarios.filter((s) => s.family === f.id && s.moments.includes(m.id))
        .map((s) => (s.primaryMoment === m.id ? `${s.id}*` : s.id)).join(' ') || '—',
    ])),
  }));

  return { matrix, untested, drift, momentGrid };
}
