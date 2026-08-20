#!/usr/bin/env node
// @ts-check
/**
 * The whole kit, behind one command.
 *
 *   lab preflight  --plugin-dir <dir>     refuse to measure a degraded backend
 *   lab ab         --plugin-dir <dir>     paired A/B over the prompt corpus
 *   lab eval       --plugin-dir <dir>     `claude plugin eval --ablation with-without`
 *   lab latency    --plugin-dir <dir>     responsiveness, four sources, labelled
 *   lab ux                                the scenarios to walk, and the coverage matrix
 *   lab compare    <stampA> <stampB>      two recorded runs, with a comparability gate
 *   lab install-evals --plugin-dir <dir>  link the cases into the plugin (and --uninstall)
 *
 * `ab` and `eval` run the preflight fresh on every invocation and refuse to write into
 * `results/` unless it is green — not "a recent green preflight", a green one *now*. The
 * outage this guards against came and went inside an afternoon, so a cached verdict would
 * have vouched for a sweep running straight through it. `--force` records anyway and stamps
 * `degraded: true`, which `compare` then refuses to place beside a trusted run.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, pluginManifest, resolvePluginDir, resultsRoot, stampName, KIT_ROOT } from '../lib/paths.mjs';
import { armsHash, ambientPlugins } from '../lib/arms.mjs';
import { hashOf, comparability, stamp as versionStamp } from '../lib/versions.mjs';
import { preflight, renderChecks } from '../lib/preflight.mjs';
import { runCell } from '../lib/metrics.mjs';
import { AB_COLS, abTable, dropWarmup, integrity, latencyTable, noiseFloor, table } from '../lib/report.mjs';
import { hookBudgets, inspect, parseRingLog, parseTranscripts, timeStatusline } from '../lib/latency.mjs';
import * as evals from '../lib/evals.mjs';
import { coverage, FAMILIES, groundTruth, loadScenarios } from '../lib/ux.mjs';
import { buildFixture } from '../corpus/fixture.mjs';

const DEFAULTS = JSON.parse(readFileSync(join(KIT_ROOT, 'kit.json'), 'utf8'));

/* -------------------------------------------------------------------------- */

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

/** @param {string} s */
const die = (s) => { process.stderr.write(`lab: ${s}\n`); process.exit(2); };
/** @param {string} s */
const say = (s = '') => process.stdout.write(`${s}\n`);

/** @param {any} args @returns {string} */
function needPluginDir(args) {
  if (!args['plugin-dir']) die('--plugin-dir <dir> is required (a worktree root, or the plugin dir itself)');
  try { return resolvePluginDir(String(args['plugin-dir'])); } catch (e) { return die(String(/** @type {any} */ (e).message)); }
}

/* -------------------------------------------------------------------------- */
/* preflight                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The gate every recording command passes through, run fresh each time.
 *
 * Deliberately not cached. The outage this gate exists for came and went inside an
 * afternoon; a verdict from this morning would have vouched for a sweep running through it.
 *
 * @param {string} pluginDir @param {any} args @returns {Promise<any>}
 */
async function gate(pluginDir, args) {
  const model = String(args.model || DEFAULTS.model);
  const res = await preflight({
    pluginDir,
    model,
    cwd: String(args.cwd || process.cwd()),
    canary: args.canary ? String(args.canary) : DEFAULTS.canary,
    budgetMs: Number(args['recall-budget-ms'] || DEFAULTS.recallBudgetMs),
    pinnedClaude: args['allow-host-drift'] ? undefined : args['pinned-claude'],
    skipArms: Boolean(args['skip-arms']),
  });
  say('preflight');
  say(renderChecks(res.checks));
  say();
  return res;
}

/* -------------------------------------------------------------------------- */

/** @param {string} pluginDir @param {any} args @returns {any} */
function sweepStamp(pluginDir, args, corpus) {
  const v = versionStamp(pluginDir);
  return {
    ...v,
    model: String(args.model || DEFAULTS.model),
    corpusHash: hashOf(corpus),
    armsHash: armsHash(),
    kitVersion: DEFAULTS.kitVersion,
  };
}

/** @returns {{id: string, text: string, family: string, expects_memory: boolean}[]} */
function loadCorpus(args) {
  const path = args.corpus ? String(args.corpus) : join(KIT_ROOT, 'corpus', 'prompts.json');
  const all = JSON.parse(readFileSync(path, 'utf8')).prompts;
  if (!args.cases) return all;
  const want = String(args.cases).split(',').map((s) => s.trim());
  return all.filter((p) => want.some((w) => p.id === w || p.family === w || p.id.startsWith(w)));
}

/* -------------------------------------------------------------------------- */
/* ab                                                                          */
/* -------------------------------------------------------------------------- */

/** @param {any} args */
async function cmdAb(args) {
  const pluginDir = needPluginDir(args);
  const manifest = pluginManifest(pluginDir);
  const corpus = loadCorpus(args);
  if (!corpus.length) die('the corpus selection is empty');

  const stampObj = sweepStamp(pluginDir, args, corpus);
  const dir = ensureDir(join(resultsRoot(), stampName(stampObj)));
  const rawDir = ensureDir(join(dir, 'raw'));

  const pre = await gate(pluginDir, args);
  if (!pre.ok && !args.force) {
    // "Nothing recorded" has to mean nothing: a half-written stamp directory left behind by a
    // refused run is exactly the thing someone finds later and mistakes for a result.
    rmSync(dir, { recursive: true, force: true });
    die('preflight failed — nothing recorded. Fix the failures above, or pass --force to record a run stamped degraded:true.');
  }
  writeFileSync(join(dir, 'preflight.json'), `${JSON.stringify({ ...pre, at: Date.now() }, null, 2)}\n`);

  // Every prompt is answered in the same generated repo unless the operator names another.
  // A sweep run in a live project is not reproducible across versions: the project moves.
  const cwd = args.cwd ? String(args.cwd) : buildFixture(join(rawDir, 'fixture'));
  say(`fixture: ${cwd}`);
  say();

  const reps = Number(args.reps || DEFAULTS.reps);
  const noise = Boolean(args['noise-floor']);
  // The A/A run is the same machinery with the arm label lying in a controlled way: both
  // arms are controls, so whatever delta comes out is the floor everything else sits on.
  const arms = noise ? ['controlA', 'controlB'] : String(args.arms || 'treatment,control').split(',');
  const armFor = (a) => (a.startsWith('control') ? 'control' : a);
  const ambient = ambientPlugins(process.cwd());
  const sweepId = stampName(stampObj).slice(0, 40);

  const ndjson = join(dir, 'trials.ndjson');
  /** @type {any[]} */
  const trials = [];
  const total = arms.length * corpus.length * reps;
  let n = 0;

  for (const prompt of corpus) {
    for (let rep = 1; rep <= reps; rep += 1) {
      for (const arm of arms) {
        n += 1;
        process.stdout.write(`  [${String(n).padStart(String(total).length)}/${total}] ${arm} · ${prompt.id} · rep ${rep} … `);
        const t = await runCell({
          arm: armFor(arm),
          prompt,
          rep,
          pluginDir,
          pluginName: String(manifest.name),
          model: stampObj.model,
          rawDir,
          ambient,
          sweepId,
          cwd,
          timeoutMs: Number(args['timeout-ms'] || 600_000),
        });
        t.arm = arm;
        t.sweep_id = sweepId;
        t.stamp = stampObj;
        trials.push(t);
        appendFileSync(ndjson, `${JSON.stringify(t)}\n`);
        say(`${t.exception || 'ok'} · ttft ${t.ttft_ms}ms · $${t.cost_usd.toFixed(4)}${t.mubit.loaded ? ` · ${t.mubit.recall_sources.join('/') || 'no recall'}` : ''}`);
      }
    }
  }

  say();
  const scored = reps > 1 ? dropWarmup(trials) : trials;
  if (reps > 1) say(`rep 1 of each pair discarded (cache creation) — ${scored.length}/${trials.length} trials scored`);

  const { lines, sound } = integrity(trials, String(manifest.name));
  say('integrity');
  for (const l of lines) say(`  ${l}`);
  say();

  // `model` in the stamp is what we asked for; this is what we got. An alias that resolved
  // to a different id six months later is the one way a "comparable" pair silently is not.
  const resolvedModels = [...new Set(trials.map((t) => t.resolved_model).filter(Boolean))];

  /** @type {any} */
  let summary = { schema: 'mubit-testkit/summary/v1', stamp: stampObj, sweepId, reps, arms, resolvedModels, degraded: !pre.ok, sound, integrity: lines, trials: trials.length };

  if (noise) {
    const floor = noiseFloor(scored);
    summary.noiseFloor = floor;
    say('noise floor (A/A — both arms are controls; a real effect must exceed this)');
    say(table(
      [{ key: 'metric', label: 'metric' }, { key: 'delta', label: 'Δ median', align: 'r' }, { key: 'iqr', label: 'Δ IQR', align: 'r' }, { key: 'n', label: 'pairs', align: 'r' }],
      Object.entries(floor).map(([k, v]) => ({ metric: k, delta: v.medianDelta ?? '—', iqr: v.q1 == null ? '—' : `${v.q1}..${v.q3}`, n: v.pairs })),
    ).map((l) => `  ${l}`).join('\n'));
  } else {
    const { rows } = abTable({ trials: scored, treatment: 'treatment', control: 'control' });
    summary.ab = rows;
    const floorPath = join(resultsRoot(), 'noise-floor.json');
    if (existsSync(floorPath)) {
      summary.noiseFloorRef = JSON.parse(readFileSync(floorPath, 'utf8'));
      say(`noise floor, from ${floorPath} — any Δ smaller than this is nothing`);
      say();
    } else {
      say('NOTE  no noise floor recorded. Run `lab ab --noise-floor` once and copy its');
      say('      summary.json noiseFloor to results/noise-floor.json, or every Δ below is');
      say('      uncalibrated.');
      say();
    }
    say(table(AB_COLS, rows).map((l) => `  ${l}`).join('\n'));
  }

  say();
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  if (args['shim-eval']) {
    const p = evals.writeShimAggregate(scored, join(dir, 'eval', 'aggregate-result.json'));
    say(`shim aggregate → ${p}`);
  }

  appendIndex(summary, dir);
  say(`recorded → ${dir}`);
  if (!sound) { say(); say('This sweep is NOT sound — see the integrity block. Do not quote its numbers.'); process.exit(1); }
}

/* -------------------------------------------------------------------------- */
/* latency                                                                     */
/* -------------------------------------------------------------------------- */

/** @param {any} args */
async function cmdLatency(args) {
  const pluginDir = needPluginDir(args);
  const budgets = hookBudgets(pluginDir);
  const since = Date.now() - Number(args['since-hours'] || 24 * 90) * 3600_000;

  /** @type {{surface: string, source: string, samples: number[], budgetMs?: number|null, note?: string}[]} */
  const groups = [];

  // From an A/B sweep's raw debug logs, if one is named. Per-prompt recall lives nowhere else.
  const from = args.from ? join(resultsRoot(), String(args.from)) : latestSweep();
  if (from && existsSync(join(from, 'trials.ndjson'))) {
    const trials = readFileSync(join(from, 'trials.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const on = trials.filter((t) => t.mubit?.loaded);
    groups.push({ surface: 'prompt-recall (blocking)', source: 'debug-file', samples: on.flatMap((t) => t.mubit.recall_ms), budgetMs: DEFAULTS.recallBudgetMs, note: 'internal recall budget, not the 3s hook registration timeout' });
    groups.push({ surface: 'mcp server boot', source: 'debug-file', samples: on.flatMap((t) => t.mubit.mcp_boot_ms), budgetMs: null, note: 'once per session' });
    groups.push({ surface: 'drain (detached)', source: 'ring log', samples: on.flatMap((t) => t.mubit.drain_ms), budgetMs: null, note: 'off the hot path — never felt by the user' });
    say(`per-prompt sources: ${from}`);
  } else {
    say('per-prompt sources: none — run `lab ab` first, or pass --from <stamp>');
  }

  // Stop-hook wall time, free and retroactive, from every session ever recorded.
  const stops = parseTranscripts({ sinceMs: since, limit: Number(args['transcript-limit'] || 2000) });
  const byCmd = new Map();
  for (const s of stops) {
    const key = s.command.replace(/.*hooks\/dist\//, '').replace(/\$\{[^}]*\}/g, '').trim();
    if (!byCmd.has(key)) byCmd.set(key, []);
    byCmd.get(key).push(s.ms);
  }
  for (const [cmd, samples] of byCmd) {
    groups.push({ surface: cmd, source: 'transcript', samples, budgetMs: budgets.Stop ?? null, note: 'stop_hook_summary — the only subtype carrying hookInfos' });
  }

  // Overruns. A tail detector, not a distribution, and the table says so.
  const dataDir = args['data-dir'] ? String(args['data-dir']) : null;
  if (dataDir) {
    const ring = parseRingLog(dataDir);
    if (ring.overruns.length) {
      groups.push({ surface: 'budget overruns', source: 'ring log', samples: ring.overruns.map((o) => o.elapsedMs), budgetMs: null, note: `OVERRUNS ONLY — ${[...new Set(ring.overruns.map((o) => o.hook))].join(', ')}` });
    }
    const sl = timeStatusline(pluginDir, { dataDir });
    // No budget on this row. The 15 ms budget is on the script's in-process work, and this
    // measurement is a cold `node` process — so grading it against 15 would report 20/20
    // overruns on a healthy plugin, every run, until nobody reads the column.
    if (sl.ok) groups.push({ surface: 'statusline render (cold)', source: 'timed here', samples: sl.ms, budgetMs: null, note: `${sl.note}; the 15ms budget is on in-process work only` });
  }

  // An empty row is dropped from the table but never dropped silently: "recall was not
  // measured" and "recall was fast" must not look the same.
  const empty = groups.filter((g) => !g.samples.length);
  const { rows, cols } = latencyTable(groups.filter((g) => g.samples.length));
  say();
  say(table(cols, rows).map((l) => `  ${l}`).join('\n'));
  say();
  for (const g of empty) {
    say(`  NO DATA  ${g.surface} (${g.source}) — no samples. If recall is the surface, check`);
    say(`           the preflight canary: an injection that never happened has no latency.`);
  }
  if (empty.length) say();
  say('  Sources are not interchangeable. The ring log records a hook only when it OVERRAN');
  say('  its budget, so it is a tail detector; the transcript column is the honest Stop');
  say('  distribution; per-prompt recall exists only in the debug log.');

  if (from) {
    writeFileSync(join(from, 'responsiveness.json'), `${JSON.stringify({ groups, budgets, rows }, null, 2)}\n`);
    say();
    say(`recorded → ${join(from, 'responsiveness.json')}`);
  }
}

/* -------------------------------------------------------------------------- */
/* eval                                                                        */
/* -------------------------------------------------------------------------- */

/** @param {any} args */
async function cmdEval(args) {
  const pluginDir = needPluginDir(args);

  if (args.probe) {
    const g = evals.probeGate(pluginDir);
    say(`gate: ${g.state}`);
    say(`  bare:    ${g.bare.split('\n')[0]}`);
    if (g.escaped) say(`  escaped: ${g.escaped.split('\n')[0]}`);
    writeFileSync(join(KIT_ROOT, 'evals', 'gate.json'), `${JSON.stringify({ state: g.state, at: new Date().toISOString(), claude: versionStamp(pluginDir).claudeVersion }, null, 2)}\n`);
    process.exit(g.state === 'gated' || g.state === 'missing' ? 1 : 0);
  }

  const gateState = evals.probeGate(pluginDir).state;
  if (gateState === 'gated' || gateState === 'missing') {
    die(`plugin eval is not available (${gateState}). Use \`lab ab --shim-eval\` until it is.`);
  }

  // The "corpus" of an eval run is the set of cases it ran, not the `ab` prompt corpus.
  // Hashing the wrong one makes two eval runs over different case sets look comparable.
  const cases = evals.listCases().filter((c) => !args.case || c.includes(String(args.case).replace(/\*/g, '')));
  const stampObj = sweepStamp(pluginDir, args, { evalCases: cases });
  const dir = ensureDir(join(resultsRoot(), stampName(stampObj)));
  say(`cases: ${cases.join(', ') || '(none)'}`);

  const pre = await gate(pluginDir, args);
  if (!pre.ok && !args.force) {
    rmSync(dir, { recursive: true, force: true });
    die('preflight failed — nothing recorded (--force to override)');
  }
  writeFileSync(join(dir, 'preflight.json'), `${JSON.stringify({ ...pre, at: Date.now() }, null, 2)}\n`);

  const installed = evals.install(pluginDir);
  say(`evals: ${installed.action} → ${installed.link}`);
  try {
    const r = await evals.run({
      pluginDir,
      outDir: join(dir, 'eval'),
      model: stampObj.model,
      runs: Number(args.runs || 3),
      maxCostUsd: Number(args['max-cost-usd'] || DEFAULTS.maxCostUsd),
      caseGlob: args.case ? String(args.case) : undefined,
      dataDir: args['data-dir'] ? String(args['data-dir']) : undefined,
      keepTemp: Boolean(args['keep-temp']),
    });
    const agg = evals.readAggregate(r.jsonPath);
    say();
    if (!agg) { say('no aggregate-result.json was written — see the output above'); process.exit(1); }
    if (!agg.ok) {
      say(`VOID  the "with" arm did not carry the plugin: ${agg.problems.join('; ')}`);
      process.exit(1);
    }
    say(`aggregate → ${r.jsonPath}`);
    // `compare` and `history` read summary.json, so an eval run without one is recorded and
    // then invisible — which defeats the point of recording it.
    writeFileSync(join(dir, 'summary.json'), `${JSON.stringify({
      schema: 'mubit-testkit/summary/v1',
      kind: 'eval',
      stamp: stampObj,
      cases,
      degraded: !pre.ok,
      sound: agg.detectedPlugin !== false,
      aggregates: agg.aggregates,
      indicators: agg.indicators,
      indicatorsPassed: agg.indicatorsPassed,
      detectedPlugin: agg.detectedPlugin,
      costUsd: agg.costUsd,
      partial: agg.partial,
    }, null, 2)}\n`);
    if (agg.aggregates) {
      say(`  score ${agg.aggregates.overallScore ?? '—'} · pass rate ${agg.aggregates.overallPassRate ?? '—'} · meanDelta ${agg.aggregates.meanDelta ?? '—'} · $${agg.costUsd.toFixed(4)}${agg.partial ? ' · PARTIAL (cost ceiling hit)' : ''}`);
    }
    say();
    say(`  plugin indicators (with-only graders — unscored by design, and the only thing that`);
    say(`  says the plugin did anything):`);
    for (const i of agg.indicators) say(`    ${i.passed ? 'FIRED   ' : 'SILENT  '} ${i.case} · ${i.name}${i.passed ? '' : ` — ${i.explanation}`}`);
    if (!agg.indicators.length) say('    (none — no case declares a with-only grader)');
    say();
    if (agg.detectedPlugin === false) {
      // meanDelta 0 with every indicator silent is not a null result. It is a suite that
      // cannot see the plugin — most often a missing tool grant, not a plugin that does
      // nothing — and reporting it as "no benefit" would be the exact lie this kit exists
      // to prevent.
      say('VOID  the suite ran cleanly and detected NOTHING the plugin does. A meanDelta of 0');
      say('      here measures the suite, not the plugin — most often a case-design fault,');
      say('      not a plugin that does nothing.');
      say(`      Re-run with --keep-temp and read the trace at cases[].arms.with[].tracePath,`);
      say(`      plus ${join(dir, 'eval', 'eval-debug.log')}.`);
      appendIndex({ schema: 'mubit-testkit/summary/v1', stamp: stampObj, kind: 'eval', degraded: true, sound: false, aggregates: agg.aggregates }, dir);
      process.exit(1);
    }
    appendIndex({ schema: 'mubit-testkit/summary/v1', stamp: stampObj, kind: 'eval', degraded: !pre.ok, aggregates: agg.aggregates }, dir);
  } finally {
    if (!args.keep) say(`evals: ${evals.uninstall(pluginDir).action}`);
  }
}

/* -------------------------------------------------------------------------- */
/* ux                                                                          */
/* -------------------------------------------------------------------------- */

/** @param {any} args */
function cmdUx(args) {
  const pluginDir = args['plugin-dir'] ? needPluginDir(args) : null;
  const scenarios = loadScenarios();

  if (!pluginDir) {
    say('scenarios to walk by hand:');
    for (const s of scenarios) say(`  ${s.id.padEnd(7)} ${s.title}   (${s.duration || '?'}, ${s.sessions} session(s))`);
    say();
    say('pass --plugin-dir to render the coverage matrix against a real plugin');
    return;
  }

  const truth = groundTruth(pluginDir);
  const cov = coverage(scenarios, truth);

  if (args.check || args.coverage) {
    say('moments × families — a blank cell is an untested path, not an omission');
    say(table(
      [{ key: 'moment', label: 'moment' }, { key: 'name', label: '' }, ...FAMILIES.map((f) => ({ key: f.id, label: f.id }))],
      cov.momentGrid,
    ).map((l) => `  ${l}`).join('\n'));
    say();

    const ids = scenarios.map((s) => s.id);
    say('touchpoints × scenarios   (X = primary, x = exercised)');
    say(table(
      [{ key: 'touchpoint', label: 'touchpoint' }, { key: 'kind', label: 'kind' }, ...ids.map((id) => ({ key: id, label: id.replace('W', '') }))],
      cov.matrix.map((r) => ({ touchpoint: r.touchpoint, kind: r.kind, ...Object.fromEntries(ids.map((id, i) => [id, r.cells[i]])) })),
    ).map((l) => `  ${l}`).join('\n'));
    say();

    const counts = (k) => `${new Set(cov.matrix.filter((m) => m.kind === k).map((m) => m.touchpoint)).size}/${truth[k].length}`;
    const summaryLine = `${scenarios.length} scenarios · hooks ${counts('hooks')} · tools ${counts('tools')} · skills ${counts('skills')}`;
    say(`  ${summaryLine}`);
    if (cov.untested.length) {
      say(`  UNTESTED: ${cov.untested.map((u) => u.name).join(', ')}`);
    }

    if (args.write) {
      // coverage.json is the machine-readable half — it is what a future `--check` in CI
      // would diff against, and what makes "which paths does 0.11.0 no longer cover" a
      // question with an answer rather than an argument.
      writeFileSync(join(KIT_ROOT, 'ux', 'coverage.json'), `${JSON.stringify({
        schema: 'mubit-testkit/coverage/v1',
        generatedAgainst: { pluginVersion: versionStamp(pluginDir).pluginVersion, pluginSha: versionStamp(pluginDir).pluginSha },
        truth,
        scenarios: scenarios.map((sc) => ({ id: sc.id, title: sc.title, family: sc.family, moments: sc.moments, primaryMoment: sc.primaryMoment, sessions: sc.sessions, duration: sc.duration, touch: sc.touch, primary: [...sc.primary] })),
        matrix: cov.matrix,
        untested: cov.untested,
        drift: cov.drift,
      }, null, 2)}\n`);
      say(`  wrote ux/coverage.json`);

      // TAXONOMY.md keeps its prose by hand and its grid by generation. Hand-maintaining a
      // matrix is how a matrix ends up describing last year's plugin.
      const taxPath = join(KIT_ROOT, 'ux', 'TAXONOMY.md');
      const tax = readFileSync(taxPath, 'utf8');
      const block = [
        '<!-- generated: coverage -->',
        '',
        `## Coverage — generated against ${versionStamp(pluginDir).pluginVersion} (${versionStamp(pluginDir).pluginSha})`,
        '',
        '### Moments × families',
        '',
        'A blank cell is an untested path, not an omission. `*` marks the scenario whose',
        'primary moment this is.',
        '',
        '```',
        ...table([{ key: 'moment', label: 'moment' }, { key: 'name', label: '' }, ...FAMILIES.map((f) => ({ key: f.id, label: f.id }))], cov.momentGrid),
        '```',
        '',
        '### Touchpoints × scenarios',
        '',
        '`X` is the scenario primarily about that touchpoint; `x` merely exercises it.',
        '',
        '```',
        ...table(
          [{ key: 'touchpoint', label: 'touchpoint' }, { key: 'kind', label: 'kind' }, ...ids.map((id) => ({ key: id, label: id.replace('W', '') }))],
          cov.matrix.map((r) => ({ touchpoint: r.touchpoint, kind: r.kind, ...Object.fromEntries(ids.map((id, i) => [id, r.cells[i]])) })),
        ),
        '```',
        '',
        `${summaryLine}`,
        '',
        cov.untested.length
          ? `**Untested:** ${cov.untested.map((u) => `\`${u.name}\``).join(', ')}. Config keys with no scenario are a deliberate tail — they are levers, not surfaces, and the A/B arms in \`lib/arms.mjs\` cover the ones that move a number.`
          : '**Untested:** nothing — every hook, tool, skill and config key is named by at least one scenario.',
        '',
        '<!-- /generated -->',
      ].join('\n');
      writeFileSync(taxPath, tax.replace(/<!-- generated: coverage -->[\s\S]*?<!-- \/generated -->/, block));
      say(`  wrote ux/TAXONOMY.md`);
    }
    if (cov.drift.length) {
      say();
      for (const d of cov.drift) say(`  DRIFT  ${d.scenario} names ${d.kind.slice(0, -1)} "${d.name}", which this plugin version does not have`);
      process.exit(1);
    }
    return;
  }

  cmdUx({ ...args, coverage: true });
}

/* -------------------------------------------------------------------------- */
/* compare                                                                     */
/* -------------------------------------------------------------------------- */

/** @returns {string|null} */
function latestSweep() {
  const root = resultsRoot();
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root).filter((d) => existsSync(join(root, d, 'summary.json'))).sort();
  return dirs.length ? join(root, dirs[dirs.length - 1]) : null;
}

/** @param {any} args */
function cmdCompare(args) {
  const [a, b] = args._;
  if (!a || !b) die('usage: lab compare <stampA> <stampB>');
  const read = (s) => {
    const p = join(resultsRoot(), s, 'summary.json');
    if (!existsSync(p)) die(`no summary.json at ${p}`);
    return JSON.parse(readFileSync(p, 'utf8'));
  };
  const A = read(a);
  const B = read(b);

  const c = comparability(A.stamp, B.stamp);
  say(`comparability  ${a}  vs  ${b}`);
  if (!c.comparable) {
    for (const m of c.mismatches) say(`  MISMATCH  ${m.key}: ${m.a} vs ${m.b}  —  ${m.why}`);
    if (!args.force) {
      say();
      die('refusing to compare. These two numbers are not about the same thing. --force to print anyway.');
    }
    say('  (--force: the table below compares things that are not comparable)');
  } else {
    say('  OK  model, corpus, host and arms all agree');
  }
  if (A.degraded || B.degraded) say(`  WARN  ${[a, b].filter((_, i) => [A, B][i].degraded).join(' and ')} recorded with a failed preflight (degraded:true)`);
  const ra = (A.resolvedModels || []).join(',');
  const rb = (B.resolvedModels || []).join(',');
  if (ra && rb && ra !== rb) say(`  WARN  the pinned model is the same string but resolved differently: ${ra} vs ${rb}`);
  say();

  for (const [name, run] of [[a, A], [b, B]]) {
    if (!run.ab) say(`  NOTE  ${name} is a ${run.kind || '?'} run and has no A/B table; only its stamp is comparable`);
  }
  const byMetric = (s) => new Map((s.ab || []).map((r) => [r.metric, r]));
  const ma = byMetric(A);
  const mb = byMetric(B);
  const rows = [...ma.keys()].map((k) => ({
    metric: k,
    a: ma.get(k)?.delta ?? '—',
    b: mb.get(k)?.delta ?? '—',
    note: `${ma.get(k)?.verdict ?? ''} → ${mb.get(k)?.verdict ?? ''}`,
  }));
  say(table([
    { key: 'metric', label: 'metric' },
    // Includes the stamp's timestamp: two sweeps of the SAME version is the common case when
    // you are checking whether a result reproduces, and identical column headers make that
    // table unreadable.
    { key: 'a', label: `${A.stamp.pluginVersion}-${A.stamp.pluginSha} Δ (${a.slice(-16, -1)})`, align: 'r' },
    { key: 'b', label: `${B.stamp.pluginVersion}-${B.stamp.pluginSha} Δ (${b.slice(-16, -1)})`, align: 'r' },
    { key: 'note', label: '' },
  ], rows).map((l) => `  ${l}`).join('\n'));
}

/** @param {any} args */
function cmdHistory() {
  const p = join(resultsRoot(), 'index.json');
  if (!existsSync(p)) { say('no runs recorded yet'); return; }
  const rows = readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  say(table([
    { key: 'at', label: 'recorded' },
    { key: 'version', label: 'version' },
    { key: 'sha', label: 'sha' },
    { key: 'kind', label: 'kind' },
    { key: 'trusted', label: 'trusted' },
    { key: 'dir', label: 'dir' },
  ], rows).map((l) => `  ${l}`).join('\n'));
}

/** @param {any} summary @param {string} dir */
function appendIndex(summary, dir) {
  const root = ensureDir(resultsRoot());
  appendFileSync(join(root, 'index.json'), `${JSON.stringify({
    at: new Date().toISOString(),
    version: summary.stamp.pluginVersion,
    sha: summary.stamp.pluginSha,
    kind: summary.kind || 'ab',
    trusted: !summary.degraded && summary.sound !== false,
    dir: dir.replace(`${root}/`, ''),
  })}\n`);
}

/* -------------------------------------------------------------------------- */

const HELP = `lab — the mubit plugin UX + A/B test kit

  lab preflight     --plugin-dir <dir>            gate: refuse to measure a degraded backend
  lab ab            --plugin-dir <dir> [--reps N] [--cases W1,W3] [--noise-floor] [--shim-eval]
  lab eval          --plugin-dir <dir> [--probe] [--runs N] [--case <glob>] [--keep-temp]
  lab latency       --plugin-dir <dir> [--from <stamp>] [--data-dir <dir>]
  lab ux            [--plugin-dir <dir>] [--check]
  lab compare       <stampA> <stampB> [--force]
  lab selftest                                     the kit's own negative controls (offline)
  lab history
  lab install-evals --plugin-dir <dir> [--uninstall]

Common flags
  --model <m>       pinned model (default ${DEFAULTS.model})
  --force           record even though preflight failed; stamps degraded:true
  --results <dir>   or set MUBIT_LAB_RESULTS — keep history outside this mirror repo

Results go to ${resultsRoot()}
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (args.results) process.env.MUBIT_LAB_RESULTS = String(args.results);

  switch (cmd) {
    case 'preflight': {
      const pluginDir = needPluginDir(args);
      const res = await gate(pluginDir, args);
      process.exit(res.ok ? 0 : 1);
      break;
    }
    case 'ab': await cmdAb(args); break;
    case 'eval': await cmdEval(args); break;
    case 'latency': await cmdLatency(args); break;
    case 'ux': cmdUx(args); break;
    case 'compare': cmdCompare(args); break;
    case 'history': cmdHistory(); break;
    case 'selftest': {
      // Trust the kit before trusting its numbers. Offline, deterministic, no model calls —
      // so there is never a reason to skip it before a sweep.
      const { spawnSync } = await import('node:child_process');
      // cwd rather than a path argument: node's own discovery finds test/**.test.mjs, and a
      // directory passed positionally is resolved as a module instead.
      const r = spawnSync(process.execPath, ['--test'], { cwd: KIT_ROOT, stdio: 'inherit' });
      process.exit(r.status ?? 1);
      break;
    }
    case 'install-evals': {
      const pluginDir = needPluginDir(args);
      const r = args.uninstall ? evals.uninstall(pluginDir) : evals.install(pluginDir);
      say(`${r.action}: ${r.link}`);
      break;
    }
    default: say(HELP); process.exit(cmd ? 2 : 0);
  }
}

main().catch((err) => { process.stderr.write(`lab: ${err?.stack || err}\n`); process.exit(2); });
