// @ts-check
/**
 * The four negative controls from the plan, plus the arm-integrity checks they depend on.
 *
 * These exist because of one specific way this kit could lie: an arm that is not what it
 * claims scores as "no difference", which is indistinguishable from a real null result. Every
 * test here is offline and deterministic — no model calls, no backend — so there is never a
 * reason to skip them before a sweep.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { integrity, noiseFloor, abTable, dropWarmup } from '../lib/report.mjs';
import { resolvePluginDir } from '../lib/paths.mjs';
import { checkEnvHygiene, checkRecallCanary } from '../lib/preflight.mjs';
import { buildRun, disableSettings, envLeaks } from '../lib/arms.mjs';

/** A minimal synthetic trial, so the integrity checks can be driven without spending money. */
function trial(over = {}) {
  return {
    arm: 'treatment', case: 'W1-bugfix', rep: 2, scoreable: true, exception: '',
    ttft_ms: 1000, span_s: 10, cost_usd: 0.01, output_tokens: 100,
    cache_creation_tokens: 1000, cache_read_tokens: 5000, steps: 2,
    mubit: {
      loaded: true, plugin_errors: [], recall_sources: [2], recall_ms: [800], recall_tok: [120],
      budget_overruns: [], drain_ms: [], data_dir_entries: ['status'],
    },
    ...over,
  };
}

/* -------------------------------------------------------------------------- */

test('N1 — a treatment arm that did not load the plugin voids the sweep', () => {
  const trials = [
    trial({ mubit: { ...trial().mubit, loaded: false } }),
    trial({ arm: 'control', mubit: { ...trial().mubit, loaded: false, data_dir_entries: [] } }),
  ];
  const r = integrity(trials, 'mubit-memory');
  assert.equal(r.sound, false, 'a dead treatment must not be reported as sound');
  assert.match(r.lines.join('\n'), /did not load/);
});

test('N1b — a broken plugin dir is rejected before any run happens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tk-broken-'));
  try {
    assert.throws(() => resolvePluginDir(dir), /no \.claude-plugin\/plugin\.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('N1c — a control arm that DID load the plugin voids the sweep', () => {
  const trials = [trial(), trial({ arm: 'control' })];
  const r = integrity(trials, 'mubit-memory');
  assert.equal(r.sound, false);
  assert.match(r.lines.join('\n'), /leaked past --settings/);
});

test('N1d — a control arm that wrote plugin state voids the sweep', () => {
  const trials = [
    trial(),
    trial({ arm: 'control', mubit: { ...trial().mubit, loaded: false, data_dir_entries: ['status', 'runs'] } }),
  ];
  const r = integrity(trials, 'mubit-memory');
  assert.equal(r.sound, false);
  assert.match(r.lines.join('\n'), /wrote to their data dir/);
});

test('a clean pair of arms is reported sound', () => {
  const trials = [
    trial(),
    trial({ arm: 'control', mubit: { ...trial().mubit, loaded: false, data_dir_entries: [] } }),
  ];
  const r = integrity(trials, 'mubit-memory');
  assert.equal(r.sound, true);
  assert.match(r.lines.join('\n'), /arms verified/);
});

/* -------------------------------------------------------------------------- */

test('N2 — an arm pair with no real difference reports no significant difference', () => {
  /** @type {any[]} */
  const trials = [];
  // Identical values in both arms: every paired delta is exactly zero, so the sign test has
  // no non-tied pairs at all and must decline to claim anything.
  for (const c of ['a', 'b', 'c', 'd']) {
    for (const rep of [2, 3]) {
      trials.push(trial({ case: c, rep, ttft_ms: 1000 }));
      trials.push(trial({ case: c, rep, arm: 'control', ttft_ms: 1000, mubit: { ...trial().mubit, loaded: false, data_dir_entries: [] } }));
    }
  }
  const { rows } = abTable({ trials, treatment: 'treatment', control: 'control' });
  const ttft = rows.find((r) => r.metric === 'ttft ms');
  assert.equal(ttft.delta, '+0');
  assert.match(ttft.verdict, /underpowered|not significant/);
});

test('N2b — a real, consistent difference is detected once there are enough pairs', () => {
  /** @type {any[]} */
  const trials = [];
  for (const c of ['a', 'b', 'c']) {
    for (const rep of [2, 3, 4]) {
      trials.push(trial({ case: c, rep, ttft_ms: 2800 }));
      trials.push(trial({ case: c, rep, arm: 'control', ttft_ms: 1000, mubit: { ...trial().mubit, loaded: false, data_dir_entries: [] } }));
    }
  }
  const { rows } = abTable({ trials, treatment: 'treatment', control: 'control' });
  const ttft = rows.find((r) => r.metric === 'ttft ms');
  assert.equal(ttft.delta, '+1800');
  assert.equal(ttft.n, '9');
  assert.equal(ttft.verdict, 'significant');
});

test('N2c — four pairs cannot reach p<0.05 and the table says so rather than claiming a null', () => {
  /** @type {any[]} */
  const trials = [];
  for (const c of ['a', 'b']) {
    for (const rep of [2, 3]) {
      trials.push(trial({ case: c, rep, ttft_ms: 2000 }));
      trials.push(trial({ case: c, rep, arm: 'control', ttft_ms: 1000, mubit: { ...trial().mubit, loaded: false, data_dir_entries: [] } }));
    }
  }
  const { rows } = abTable({ trials, treatment: 'treatment', control: 'control' });
  const ttft = rows.find((r) => r.metric === 'ttft ms');
  assert.match(ttft.verdict, /underpowered \(need 6 pairs\)/,
    'an underpowered result must never be rendered as "not significant"');
});

/* -------------------------------------------------------------------------- */

test('N3 — an unreachable endpoint fails the canary, naming recall rather than a generic timeout', async () => {
  const pluginDir = resolvePluginDir('/Users/eldaru/Mubit/pre-main');
  const checks = await checkRecallCanary({
    pluginDir,
    query: 'anything',
    budgetMs: 1500,
    // Port 9 is the discard port: connections are refused immediately, so this is fast and
    // needs no network.
    creds: { endpoint: 'http://127.0.0.1:9', apiKey: 'not-a-real-key' },
  });
  const canary = checks.find((c) => c.id === 'recall-canary');
  assert.ok(canary, 'the canary check must run even when health fails');
  assert.equal(canary.ok, false);
  assert.equal(checks.find((c) => c.id === 'health')?.ok, false);
});

test('N3b — a leaked MUBIT_ endpoint is caught before it can redirect a sweep', () => {
  const before = process.env.MUBIT_ENDPOINT;
  process.env.MUBIT_ENDPOINT = 'http://127.0.0.1:3100';
  try {
    const c = checkEnvHygiene();
    assert.equal(c.ok, false);
    assert.match(c.measured, /MUBIT_ENDPOINT=http:\/\/127\.0\.0\.1:3100/);
    assert.match(String(c.detail), /env beats credentials\.json/);
  } finally {
    if (before === undefined) delete process.env.MUBIT_ENDPOINT; else process.env.MUBIT_ENDPOINT = before;
  }
});

test('N3c — a leaked API key is reported by name but never by value', () => {
  const before = process.env.MUBIT_API_KEY;
  process.env.MUBIT_API_KEY = 'sk-super-secret-value';
  try {
    const leaks = envLeaks();
    const hit = leaks.find((l) => l.name === 'MUBIT_API_KEY');
    assert.ok(hit);
    assert.equal(hit.value, '<redacted>');
    assert.ok(!JSON.stringify(leaks).includes('super-secret'));
  } finally {
    if (before === undefined) delete process.env.MUBIT_API_KEY; else process.env.MUBIT_API_KEY = before;
  }
});

/* -------------------------------------------------------------------------- */

test('N4 — the noise floor is computed from an A/A pair', () => {
  /** @type {any[]} */
  const trials = [];
  const jitter = [0, 40, -30, 10, -20, 50];
  let i = 0;
  for (const c of ['a', 'b', 'c']) {
    for (const rep of [2, 3]) {
      trials.push(trial({ case: c, rep, arm: 'controlA', ttft_ms: 1000 }));
      trials.push(trial({ case: c, rep, arm: 'controlB', ttft_ms: 1000 + jitter[i % jitter.length] }));
      i += 1;
    }
  }
  const floor = noiseFloor(trials);
  assert.equal(floor.ttft_ms.pairs, 6);
  assert.ok(Number.isFinite(Number(floor.ttft_ms.medianDelta)));
});

/* -------------------------------------------------------------------------- */

test('the warm-up rep is discarded, because it pays for the cache the others read', () => {
  const trials = [trial({ rep: 1 }), trial({ rep: 2 }), trial({ rep: 3 })];
  assert.deepEqual(dropWarmup(trials).map((t) => t.rep), [2, 3]);
});

test('both arms disable every ambient plugin, and only the treatment gets --plugin-dir', () => {
  const ambient = ['mubit-memory@mubit', 'typescript-lsp@claude-plugins-official'];
  const common = { pluginDir: '/p', prompt: 'hi', model: 'sonnet', dataDir: '/d', runId: 'r', debugFile: '/f', ambient };
  const t = buildRun({ arm: 'treatment', ...common });
  const c = buildRun({ arm: 'control', ...common });

  assert.ok(t.argv.includes('--plugin-dir'));
  assert.ok(!c.argv.includes('--plugin-dir'), 'a control that carries --plugin-dir is a treatment');

  for (const arm of [t, c]) {
    const settings = JSON.parse(arm.argv[arm.argv.indexOf('--settings') + 1]);
    for (const id of ambient) {
      assert.equal(settings.enabledPlugins[id], false, `${id} must be disabled in BOTH arms`);
    }
  }
});

test('the control arm carries no credentials — it has no plugin to use them', () => {
  const common = { pluginDir: '/p', prompt: 'hi', model: 'sonnet', dataDir: '/d', runId: 'r', debugFile: '/f', ambient: [] };
  const c = buildRun({ arm: 'control', ...common });
  assert.ok(!('MUBIT_API_KEY' in c.env));
  assert.ok(!('MUBIT_ENDPOINT' in c.env));
});

test('disableSettings emits a JSON string the host will accept inline', () => {
  const s = disableSettings(['a@b', 'c@d']);
  assert.equal(typeof s, 'string');
  assert.deepEqual(JSON.parse(s), { enabledPlugins: { 'a@b': false, 'c@d': false } });
});
