// @ts-check
/**
 * The two pieces that go stale silently: the coverage matrix, and the eval plumbing.
 *
 * A coverage matrix describing a plugin that no longer exists is worse than no matrix — it
 * reports full coverage of a surface that moved. The drift test is what turns that into a
 * failure on the day it happens.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { coverage, groundTruth, loadScenarios, parseScenario, FAMILIES, MOMENTS } from '../lib/ux.mjs';
import { install, uninstall, listCases, readAggregate, writeShimAggregate, LINK_NAME } from '../lib/evals.mjs';
import { resolvePluginDir, KIT_ROOT, LAB_ROOT } from '../lib/paths.mjs';

const PLUGIN = resolvePluginDir(process.env.MUBIT_LAB_PLUGIN_DIR || LAB_ROOT);

/* -------------------------------------------------------------------------- */
/* coverage                                                                    */
/* -------------------------------------------------------------------------- */

test('ground truth is read from the plugin, never typed twice', () => {
  const t = groundTruth(PLUGIN);
  assert.equal(t.hooks.length, 13);
  assert.equal(t.tools.length, 10);
  // Eight since SC-09 added `link` (SCOPE.md §6 Tier 3). The count is pinned rather than
  // read so that a skill appearing or disappearing is a decision somebody made here.
  assert.equal(t.skills.length, 8);
  assert.ok(t.skills.includes('link'), 'the Tier 3 link surface is part of the plugin under test');
  assert.ok(t.hooks.includes('SubagentStart'));
  assert.ok(t.tools.includes('mubit_recall'));
  assert.ok(t.config.includes('preToolWarnings'));
});

test('every scenario parses, and the whole hook/tool/skill surface is covered', () => {
  const scenarios = loadScenarios();
  assert.ok(scenarios.length >= 15, `expected the full taxonomy, got ${scenarios.length}`);

  const truth = groundTruth(PLUGIN);
  const cov = coverage(scenarios, truth);
  const covered = (kind) => new Set(cov.matrix.filter((m) => m.kind === kind).map((m) => m.touchpoint));

  assert.equal(covered('hooks').size, truth.hooks.length, 'an uncovered hook is an untested path');
  assert.equal(covered('tools').size, truth.tools.length);
  assert.equal(covered('skills').size, truth.skills.length);
});

test('every family and every moment has at least one scenario', () => {
  const scenarios = loadScenarios();
  for (const f of FAMILIES) {
    assert.ok(scenarios.some((s) => s.family === f.id), `family ${f.id} has no scenario`);
  }
  for (const m of MOMENTS) {
    assert.ok(scenarios.some((s) => s.moments.includes(m.id)), `moment ${m.id} has no scenario`);
  }
});

test('every scenario declares a primary moment and a primary touchpoint', () => {
  for (const s of loadScenarios()) {
    assert.ok(s.primaryMoment, `${s.id} has no primary moment`);
    assert.ok(s.primary.size > 0, `${s.id} marks no touchpoint with * — the matrix cannot tell what it is about`);
  }
});

test('drift: a scenario naming a touchpoint the plugin does not have is caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tk-scen-'));
  try {
    writeFileSync(join(dir, 'W9-99-ghost.md'), [
      '# W9-99 — A hook that was renamed in 0.11.0',
      '',
      '**Family** W9 ghost · **Moments** M1* · **Sessions** 1 · **Duration** ~1 min',
      '',
      '## Touchpoints',
      '',
      '```',
      'hooks:  SessionStart*, PreUserPromptSubmitDeluxe',
      'tools:  mubit_teleport',
      '```',
      '',
    ].join('\n'));
    const cov = coverage(loadScenarios(dir), groundTruth(PLUGIN));
    const names = cov.drift.map((d) => d.name);
    assert.ok(names.includes('PreUserPromptSubmitDeluxe'));
    assert.ok(names.includes('mubit_teleport'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a * suffix marks the primary touchpoint and does not leak into its name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tk-scen2-'));
  try {
    writeFileSync(join(dir, 'W1-99-x.md'), [
      '# W1-99 — Star handling',
      '',
      '**Family** W1 everyday · **Moments** M2* · **Sessions** 1 · **Duration** ~1 min',
      '',
      '## Touchpoints',
      '',
      '```',
      'hooks:  SessionStart, UserPromptSubmit*',
      'skills: —',
      '```',
      '',
    ].join('\n'));
    const [s] = loadScenarios(dir);
    assert.deepEqual(s.touch.hooks, ['SessionStart', 'UserPromptSubmit']);
    assert.deepEqual([...s.primary], ['UserPromptSubmit']);
    assert.deepEqual(s.touch.skills, [], 'an em dash means "none", not a touchpoint named —');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* -------------------------------------------------------------------------- */
/* evals                                                                       */
/* -------------------------------------------------------------------------- */

test('the eval suite has cases and they are shaped the way the host expects', () => {
  const cases = listCases();
  assert.ok(cases.length >= 5, `expected the initial case set, got ${cases.join(', ')}`);
  for (const c of cases) {
    assert.ok(existsSync(join(KIT_ROOT, 'evals', c, 'prompt.md')) || existsSync(join(KIT_ROOT, 'evals', c, 'case.yaml')),
      `${c} has neither prompt.md nor case.yaml`);
  }
});

test('install/uninstall is a clean round trip that leaves the target untouched', () => {
  const link = join(PLUGIN, LINK_NAME);
  const wasInstalled = existsSync(link);
  if (wasInstalled) uninstall(PLUGIN);

  const a = install(PLUGIN);
  assert.equal(a.action, 'linked');
  assert.equal(lstatSync(link).isSymbolicLink(), true);

  // Idempotent: installing twice must not throw and must not replace anything.
  assert.equal(install(PLUGIN).action, 'already installed');

  assert.equal(uninstall(PLUGIN).action, 'removed');
  assert.equal(existsSync(link), false);
  assert.equal(uninstall(PLUGIN).action, 'not installed');

  if (wasInstalled) install(PLUGIN);
});

test('install refuses to clobber something that is not our symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tk-plug-'));
  try {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
    mkdirSync(join(dir, LINK_NAME), { recursive: true });
    assert.throws(() => install(dir), /refusing to replace/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readAggregate reads the host shape and flags a "with" arm that lost the plugin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tk-agg-'));
  try {
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({
      suite: { plugins: [{ name: 'mubit-memory', problem: null }] },
      cases: [{ name: 'c', runs: [] }],
      aggregates: { score: 0.8, scoreWithout: 0.2, delta: 0.6 },
    }));
    const g = readAggregate(good);
    assert.equal(g?.ok, true);
    assert.equal(g?.aggregates.delta, 0.6);

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({
      suite: { plugins: [{ name: 'mubit-memory', problem: 'will_not_load' }] },
      aggregates: { score: 0.5, scoreWithout: 0.5, delta: 0 },
    }));
    const b = readAggregate(bad);
    assert.equal(b?.ok, false, 'a delta of 0 from a plugin that would not load is not a null result');
    assert.match(b.problems.join(''), /will_not_load/);

    assert.equal(readAggregate(join(dir, 'absent.json')), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the shim writes the same shape one reader can read, and labels itself as a shim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tk-shim-'));
  try {
    const mk = (arm, loaded, sources) => ({
      arm, case: 'c', rep: 2, steps: 2, cost_usd: 0.01, span_s: 10,
      mubit: { loaded, recall_sources: sources },
    });
    const out = join(dir, 'eval', 'aggregate-result.json');
    writeShimAggregate([mk('treatment', true, [2]), mk('control', false, [])], out);

    const r = readAggregate(out);
    assert.equal(r?.ok, true);
    assert.equal(r?.source, 'lab.mjs ab --shim-eval', 'the shim must be distinguishable from the real thing');
    assert.equal(r?.aggregates.overallScore, 1);
    assert.equal(r?.aggregates.meanDelta, 1);
    assert.equal(r?.detectedPlugin, true, 'the shim must expose indicators the same way the host does');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('the real aggregate shape: arms.with/without, and with-only graders are unscored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tk-real-'));
  try {
    // Trimmed from a genuine `claude plugin eval` run on claude 2.1.237. The trap this pins:
    // overallScore 1 and meanDelta 0 look like a clean null result, while every with-only
    // indicator was silent — which means the suite never saw the plugin at all.
    const f = join(dir, 'aggregate-result.json');
    writeFileSync(f, JSON.stringify({
      schemaVersion: 1, costUsd: 0.1328754, partial: false,
      suite: { ablation: 'with-without', plugins: [{ name: 'mubit-memory', version: '0.10.0' }] },
      cases: [{
        name: 'plugin-tools-available',
        arms: {
          with: [{ score: 1, passed: true, turns: 2, costUsd: 0.076, durationSeconds: 6, error: null, graders: [
            { name: 'baseline-says-none', passed: true, withOnly: false, scored: true },
            { name: 'names-a-mubit-tool', passed: false, withOnly: true, scored: false, explanation: 'pattern not found in last_message' },
          ] }],
          without: [{ score: 1, passed: true, turns: 1, costUsd: 0.056, durationSeconds: 2, error: null, graders: [
            { name: 'baseline-says-none', passed: true, withOnly: false, scored: true },
          ] }],
        },
      }],
      aggregates: { casesTotal: 1, casesPassed: 1, overallScore: 1, overallPassRate: 1, meanDelta: 0 },
    }));

    const r = readAggregate(f);
    assert.equal(r?.ok, true, 'the plugin loaded — there is no `problem`');
    assert.equal(r?.aggregates.meanDelta, 0);
    assert.equal(r?.aggregates.overallScore, 1);
    assert.equal(r?.indicators.length, 1);
    assert.equal(r?.indicatorsPassed, 0);
    assert.equal(r?.detectedPlugin, false,
      'a suite that detected nothing must not be readable as a null result');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a suite with no with-only graders reports detectedPlugin as unknown, not as false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tk-noind-'));
  try {
    const f = join(dir, 'a.json');
    writeFileSync(f, JSON.stringify({
      suite: { plugins: [{ name: 'mubit-memory' }] },
      cases: [{ name: 'c', arms: { with: [{ score: 1, graders: [{ name: 'g', passed: true, withOnly: false, scored: true }] }], without: [] } }],
      aggregates: { overallScore: 1, meanDelta: 0 },
    }));
    assert.equal(readAggregate(f)?.detectedPlugin, null,
      'no indicators is a different fact from indicators that all failed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mcpToolNames matches names captured from a real system/init event', async () => {
  const { mcpToolNames } = await import('../lib/evals.mjs');
  // Captured verbatim from `claude -p --output-format stream-json --plugin-dir <plug>` on
  // claude 2.1.237. `--allow-tools` refuses globs, so these have to be exactly right or the
  // "with" arm silently runs without its MCP surface.
  const REAL = [
    'mcp__plugin_mubit-memory_mubit__mubit_archive',
    'mcp__plugin_mubit-memory_mubit__mubit_dereference',
    'mcp__plugin_mubit-memory_mubit__mubit_diagnose',
    'mcp__plugin_mubit-memory_mubit__mubit_forget',
    'mcp__plugin_mubit-memory_mubit__mubit_learned',
    'mcp__plugin_mubit-memory_mubit__mubit_lessons',
    'mcp__plugin_mubit-memory_mubit__mubit_outcome',
    'mcp__plugin_mubit-memory_mubit__mubit_recall',
    'mcp__plugin_mubit-memory_mubit__mubit_reflect',
    'mcp__plugin_mubit-memory_mubit__mubit_status',
  ];
  assert.deepEqual(mcpToolNames(PLUGIN), REAL);
});

test('every tool an eval case declares is one the plugin actually exposes', async () => {
  const { mcpToolNames, listCases } = await import('../lib/evals.mjs');
  const { readFileSync } = await import('node:fs');
  const real = new Set([...mcpToolNames(PLUGIN), 'Skill', 'Bash', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'WebFetch']);

  for (const c of listCases()) {
    const text = readFileSync(join(KIT_ROOT, 'evals', c, 'prompt.md'), 'utf8');
    const line = text.match(/^allowed_tools:\s*\[(.*)\]\s*$/m);
    if (!line) continue;
    for (const raw of line[1].split(',')) {
      const t = raw.trim();
      if (!t) continue;
      assert.ok(!t.includes('*'), `${c}: "${t}" is a wildcard — --allow-tools refuses those outright`);
      assert.ok(real.has(t), `${c}: declares "${t}", which this plugin version does not expose`);
    }
  }
});

test('the eval launcher never pins a static run strategy without an id', async () => {
  const { run } = await import('../lib/evals.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const out = mkdtempSync(join(tmpdir(), 'tk-evalenv-'));
  try {
    // `MUBIT_CC_RUN_STRATEGY=static` with no `MUBIT_CC_RUN_ID` makes the MCP server exit
    // before it serves a single tool. `system/init` reports only `status: "failed"`, the
    // model gets 0 of 10 tools, and the ablation reads as "the plugin does nothing".
    // Asserted on the built argv/env rather than by launching: this must be impossible to
    // reintroduce, and it must cost nothing to check.
    const src = readFileSync(new URL('../lib/evals.mjs', import.meta.url), 'utf8');
    assert.match(src, /refusing to launch: MUBIT_CC_RUN_STRATEGY=static without MUBIT_CC_RUN_ID/,
      'the guard against a dead MCP server must stay in place');
    assert.ok(!/MUBIT_CC_RUN_STRATEGY: 'static',\n\s+MUBIT_CC_LOG_LEVEL/.test(src),
      'static must never be set unconditionally');
  } finally { rmSync(out, { recursive: true, force: true }); }
});
