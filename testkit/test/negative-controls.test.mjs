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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { integrity, noiseFloor, abTable, dropWarmup } from '../lib/report.mjs';
import { resolvePluginDir, KIT_ROOT, LAB_ROOT } from '../lib/paths.mjs';
import { checkEnvHygiene, checkRecallCanary, renderChecks } from '../lib/preflight.mjs';
import { buildRun, disableSettings, envLeaks } from '../lib/arms.mjs';

const PLUGIN = resolvePluginDir(process.env.MUBIT_LAB_PLUGIN_DIR || LAB_ROOT);

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
  const pluginDir = resolvePluginDir(process.env.MUBIT_LAB_PLUGIN_DIR || LAB_ROOT);
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
/* the canary, split: same-run blocks, cross-run informs (SCOPE.md §8, I1)      */
/* -------------------------------------------------------------------------- */

/**
 * The plugin's own loopback fake, imported from the plugin under test rather than
 * reimplemented here — the same reason the canary itself imports the plugin's `lib/recall.mjs`
 * instead of hand-rolling the request. It binds 127.0.0.1:0, so this is real HTTP over a real
 * socket with no network, no mocking and no model call.
 *
 * @param {Record<string, any>} [routes]
 */
async function loopbackInstance(routes = {}) {
  const harness = join(PLUGIN, 'test', 'helpers', 'harness.mjs');
  assert.ok(existsSync(harness),
    `no test/helpers/harness.mjs under ${PLUGIN}: point --plugin-dir (or MUBIT_LAB_PLUGIN_DIR) at a source checkout, or the canary's loopback controls cannot run at all`);
  const { fakeMubit } = await import(pathToFileURL(harness).href);
  return fakeMubit(routes);
}

/**
 * A loopback instance that actually stores what it is given and answers a query **only from
 * the run that asked** — `mcpLessonScope: run`, the shipped configuration, in miniature.
 *
 * `lesson` is pre-stored under `owningRun`, which is what lets the cross-run ladder walk its
 * whole length: an unrelated run sees nothing, `/v2/control/lessons` proves the store is not
 * empty, and the same query pinned to the owning run finds it.
 *
 * @param {{lesson?: string, owningRun?: string}} [o]
 */
async function storingInstance({ lesson = '', owningRun = 'tb-full30-a-openssl-selfsigned-cert' } = {}) {
  /** @type {Map<string, string[]>} run_id → the text of everything stored under it */
  const stored = new Map();
  const put = (runId, text) => {
    if (!runId || !text) return;
    stored.set(runId, [...(stored.get(runId) ?? []), text]);
  };
  if (lesson) put(owningRun, lesson);

  const server = await loopbackInstance({
    'POST /v2/control/ingest': (r) => {
      for (const it of r.body?.items ?? []) put(String(r.body?.run_id ?? ''), String(it?.text ?? ''));
      return { json: { accepted: true, job_id: 'job_test_1', status: 'queued' } };
    },
    'POST /v2/control/query': (r) => {
      const q = String(r.body?.query ?? '');
      const hits = q ? (stored.get(String(r.body?.run_id ?? '')) ?? []).filter((t) => t.includes(q)) : [];
      return { json: { evidence: hits.map((content, i) => ({
        id: `e${i}`, reference_id: `ref_${i}`, entry_type: 'lesson', score: 0.9, content,
      })) } };
    },
    'POST /v2/control/lessons': {
      json: { lessons: lesson ? [{ lesson_id: 'les_1', content: lesson, scope: 'run', source_run_id: owningRun }] : [] },
    },
  });
  return { server, stored, owningRun };
}

// §8, structural constraint 1: `severity` replaces the dead `fatal?` field, and a check that
// does not declare one must keep blocking. Every check that predates the split declares
// nothing, so a default of "informational" would silently open all five of them at once.
test('N3d — a check that declares no severity still blocks the gate', async () => {
  const { gateOk } = await import('../lib/preflight.mjs');
  const legacy = { id: 'arm-treatment', title: 'treatment arm loads the whole plugin', ok: false, measured: 'plugins=[]' };
  assert.equal(gateOk([legacy]), false,
    'a check with no severity would stop blocking, so every gate not touched by this split silently becomes advisory');
  assert.equal(gateOk([{ ...legacy, ok: true }]), true,
    'a passing blocking check must not hold the gate shut, or no sweep can ever be recorded');
  assert.equal(gateOk([{ ...legacy, severity: 'block' }]), false,
    'an explicit block:false must refuse the sweep exactly as the implicit one does');
  assert.equal(gateOk([{ ...legacy, severity: 'info' }]), true,
    'an informational check that failed would still refuse the sweep — which is the bypass-by---force this split exists to remove');
});

// §8.2 + structural constraint 2: `renderChecks` printed `detail` only for `!ok`, so demoting
// a check to informational would drop the one line that explains it — the entire point of the
// demotion. And an INFO row must not wear a PASS/FAIL label, because it is not a verdict.
test('N3e — an informational row renders as INFO and keeps its explanation', () => {
  const out = renderChecks([
    { id: 'health', title: 'backend health', ok: true, measured: '9ms ok' },
    {
      id: 'cross-run-overlay',
      title: 'cross-run overlay',
      ok: false,
      severity: 'info',
      measured: '0 sources in an unrelated run — instance-wide sharing is off; expected at mcpLessonScope=run',
      detail: 'the search index is healthy; every lesson here is stored at scope "run"',
    },
  ]);
  assert.match(out, /INFO {2}cross-run overlay/,
    'an informational row labelled FAIL is read as a verdict, and the next operator reaches for --force');
  assert.ok(!/FAIL/.test(out),
    'nothing here failed the gate, so a FAIL anywhere in this render is a lie about the instance');
  assert.match(out, /instance-wide sharing is off/,
    'the measured value is what makes the row informative rather than noise');
  assert.match(out, /the search index is healthy/,
    'dropping an informational row\'s detail leaves the operator with a number and no reading of it');
});

// §8.1: the product's actual contract — a run writes evidence and reads it back under that
// same `run_id`. This is the check that is allowed to stop a sweep.
test('N3f — the same-run sentinel is written and read back under one pinned run id', async () => {
  const { server } = await storingInstance();
  try {
    const checks = await checkRecallCanary({
      pluginDir: PLUGIN,
      query: 'what conventions and constraints apply to this project',
      budgetMs: 3000,
      landingMs: 2000,
      creds: { endpoint: server.url, apiKey: 'tk-fake-key' },
    });
    const canary = checks.find((c) => c.id === 'recall-canary');
    assert.ok(canary, 'without a recall-canary row the gate has no opinion on retrieval at all');
    assert.equal(canary.ok, true,
      `an instance that stores and returns the sentinel must pass, or the gate is red for the shipped configuration again: ${canary.measured}`);

    const ingest = server.lastCall('POST', '/v2/control/ingest');
    assert.ok(ingest, 'a canary that never writes is still only testing whether someone else wrote something');
    const wrote = String(ingest.body?.run_id ?? '');
    const asked = server.calls('POST', '/v2/control/query').map((c) => String(c.body?.run_id ?? ''));
    assert.ok(asked.includes(wrote),
      `the sentinel was written to "${wrote}" and never read back under it (queries: ${asked.join(', ')}) — that is the cross-run question again, wearing a new name`);
    assert.ok(!/^tk-preflight-canary$/.test(wrote),
      'a fixed sentinel run id accumulates junk on the instance, one item per preflight, forever');
  } finally { await server.close(); }
});

// §8.2 + §8, state 3: a fresh run seeing nothing from unrelated runs is the shipped default.
// It is reported with its measured value and it does not refuse the measurement.
test('N3g — instance-wide sharing being off is INFO, and the gate stays green', async () => {
  const { gateOk } = await import('../lib/preflight.mjs');
  const { server, owningRun } = await storingInstance({
    lesson: 'Run the migration before starting the server, or the first request 500s on a missing table.',
  });
  try {
    const checks = await checkRecallCanary({
      pluginDir: PLUGIN,
      query: 'what conventions and constraints apply to this project',
      budgetMs: 3000,
      landingMs: 2000,
      creds: { endpoint: server.url, apiKey: 'tk-fake-key' },
    });
    const overlay = checks.find((c) => c.id === 'cross-run-overlay');
    assert.ok(overlay, 'the cross-run ladder is good diagnosis and must survive the split, not be deleted by it');
    assert.equal(overlay.severity, 'info',
      'a blocking cross-run-overlay is the original defect under a different id: red by design, bypassed with --force within a week');
    assert.match(overlay.measured, /instance-wide sharing is off/,
      'demoting the row without keeping its measured value turns a diagnosis into a shrug');
    assert.match(String(overlay.detail ?? ''), new RegExp(owningRun.slice(-20)),
      'naming the run that owns the lesson is what tells the reader this is scope and not a broken index');
    assert.equal(checks.find((c) => c.id === 'recall-canary')?.ok, true,
      'same-run recall is working on this instance, so nothing here is a reason to refuse a sweep');
    assert.equal(gateOk(checks), true,
      'a gate that refuses the shipped configuration protects nothing, because every sweep runs under --force');
  } finally { await server.close(); }
});

// §8, state 2: project memory broken. The one empty result that really is a reason to stop.
test('N3h — a run that cannot read back its own sentinel refuses the sweep', async () => {
  const { gateOk } = await import('../lib/preflight.mjs');
  const server = await loopbackInstance({
    'POST /v2/control/ingest': { json: { accepted: true, job_id: 'job_test_1', status: 'queued' } },
    'POST /v2/control/query': { json: { evidence: [] } },
  });
  try {
    const checks = await checkRecallCanary({
      pluginDir: PLUGIN,
      query: 'anything',
      budgetMs: 1000,
      landingMs: 600,
      creds: { endpoint: server.url, apiKey: 'tk-fake-key' },
    });
    const canary = checks.find((c) => c.id === 'recall-canary');
    assert.equal(canary?.ok, false,
      'a store that swallows a write and then denies it is exactly the outage this gate exists for, and it just passed');
    assert.notEqual(canary?.severity, 'info',
      'demoting THIS one leaves the kit with no blocking retrieval check at all');
    assert.equal(gateOk(checks), false,
      'recording an A/B against a store that cannot read back its own writes produces clean numbers about nothing');
    assert.equal(checks.some((c) => c.id === 'cross-run-overlay'), false,
      'diagnosing the cross-run overlay after same-run recall is already down spends calls to explain the wrong thing');
  } finally { await server.close(); }
});

// §8.1: "if it does not land in time report *that* as the measured value rather than reporting
// a recall failure that was really an ingest lag."
test('N3i — a sentinel whose ingest never lands is reported as ingest lag, not as a dead index', async () => {
  const server = await loopbackInstance({
    'POST /v2/control/ingest': { json: { accepted: true, job_id: 'job_test_1', status: 'queued' } },
    'GET /v2/control/ingest/jobs/job_test_1': { json: { job_id: 'job_test_1', status: 'queued', done: false, error: '' } },
    'POST /v2/control/query': { json: { evidence: [] } },
  });
  try {
    const checks = await checkRecallCanary({
      pluginDir: PLUGIN,
      query: 'anything',
      budgetMs: 1000,
      landingMs: 600,
      creds: { endpoint: server.url, apiKey: 'tk-fake-key' },
    });
    const canary = checks.find((c) => c.id === 'recall-canary');
    assert.equal(canary?.ok, false, 'a sentinel that never became retrievable has not demonstrated the contract');
    assert.match(canary?.measured ?? '', /queued|ingest/i,
      'reporting an ingest that is still queued as a recall failure sends the reader to a vector index that is fine');
    assert.ok(server.countOf('GET', '/v2/control/ingest/jobs/job_test_1') > 0,
      'sleeping a constant instead of polling the job is how a slow instance gets misreported as a broken one');
  } finally { await server.close(); }
});

// §8.1: `getIngestJob` has no other caller in the plugin, so an instance that does not serve
// the route is a real possibility. The poll is a courtesy; the read-back is the contract.
test('N3j — an instance with no ingest-job route is still judged on the read-back itself', async () => {
  const { server } = await storingInstance();
  server.route('GET /v2/control/ingest/jobs/job_test_1', { status: 404, json: { error: 'no such route' } });
  try {
    const checks = await checkRecallCanary({
      pluginDir: PLUGIN,
      query: 'anything',
      budgetMs: 3000,
      landingMs: 2000,
      creds: { endpoint: server.url, apiKey: 'tk-fake-key' },
    });
    assert.equal(checks.find((c) => c.id === 'recall-canary')?.ok, true,
      'failing the gate because a diagnostic route is absent blocks every sweep on an instance whose memory works');
  } finally { await server.close(); }
});

// §8.1: "ingest lag" is a claim about the write still being in flight, and it may only be
// made on positive evidence. `done: true` is that evidence whatever the status string spells,
// and a backend that has no jobs route gives no evidence either way — in which case the
// read-back is all there is to go on and it is the read-back that must be reported.
test('N3k — a finished job is finished however it spells its status', async () => {
  const server = await loopbackInstance({
    'POST /v2/control/ingest': { json: { accepted: true, job_id: 'job_test_1', status: 'queued' } },
    'GET /v2/control/ingest/jobs/job_test_1': { json: { job_id: 'job_test_1', status: 'processed', done: true, error: '' } },
    'POST /v2/control/query': { json: { evidence: [] } },
  });
  try {
    const checks = await checkRecallCanary({
      pluginDir: PLUGIN,
      query: 'anything',
      budgetMs: 1000,
      landingMs: 600,
      creds: { endpoint: server.url, apiKey: 'tk-fake-key' },
    });
    const canary = checks.find((c) => c.id === 'recall-canary');
    assert.equal(canary?.ok, false, 'the sentinel never came back, whatever the job called itself');
    assert.ok(!/ingest lag/.test(canary?.measured ?? ''),
      `the store said the write was done and then could not return it, which is the retrieval verdict; blaming ingest sends the operator to wait out a queue that is already empty: ${canary?.measured}`);
    assert.match(canary?.measured ?? '', /sentinel/,
      'the row still has to name what was asked for, or "0 sources" is unreadable');
  } finally { await server.close(); }
});

/* -------------------------------------------------------------------------- */
/* what a recorded run gets stamped with (SCOPE.md §8.3)                       */
/* -------------------------------------------------------------------------- */

/** The six rows `preflight()` returns on a healthy instance running the shipped default. */
const shippedChecks = () => ([
  { id: 'claude-version', title: 'claude CLI version', ok: true, measured: '2.1.237' },
  { id: 'env', title: 'no ambient MUBIT_*/CLAUDE_PLUGIN_* env', ok: true, measured: 'clean' },
  { id: 'creds', title: 'credentials resolved', ok: true, measured: 'https://api.mubit.ai from env' },
  { id: 'health', title: 'backend health', ok: true, measured: '218ms ok' },
  { id: 'recall-canary', title: 'recall canary: a run reads its own evidence', ok: true, measured: 'sentinel read back in its own run · 1 sources' },
  {
    id: 'cross-run-overlay',
    title: 'cross-run overlay',
    ok: false,
    severity: 'info',
    measured: '0 sources in an unrelated run — instance-wide sharing is off; expected at mcpLessonScope=run',
  },
  { id: 'mcp', title: 'MCP server answers mubit_status', ok: true, measured: '640ms' },
  { id: 'arm-treatment', title: 'treatment arm loads the whole plugin', ok: true, measured: 'plugins=[mubit-memory]' },
  { id: 'arm-control', title: 'control arm is clean', ok: true, measured: 'plugins=[]' },
]);

// §8.3: an A/B measured while instance-wide sharing is off is measuring the SHIPPED
// configuration, and it is trustworthy. `degraded` is `!pre.ok` at bin/lab.mjs:203, :393 and
// :424, so this is the reduce that decides whether `compare` and `history` trust the run.
test('a sweep whose only unhappy row is the cross-run overlay is recorded trusted', async () => {
  const { gateOk } = await import('../lib/preflight.mjs');
  const checks = shippedChecks();
  assert.equal(gateOk(checks), true,
    'every run on a correctly-configured instance would be stamped degraded, and compare would warn about all of them until the warning means nothing');

  const lab = readFileSync(join(KIT_ROOT, 'bin', 'lab.mjs'), 'utf8');
  assert.equal((lab.match(/degraded: !pre\.ok/g) ?? []).length, 3,
    'a summary that stops deriving `degraded` from the gate can be stamped from anywhere, and the reduce above stops meaning anything');

  const overlay = checks.find((c) => c.id === 'cross-run-overlay');
  assert.equal(gateOk(checks.filter((c) => c !== overlay)), true,
    'dropping the informational row must change nothing about the verdict — if it does, the row is still being counted');
});

// §8.3: "Keep the hard-coded `degraded: true` at :421 — that is the eval VOID path, where the
// arm genuinely did not measure what it claims, and it is correct."
test('the eval VOID path still stamps degraded:true, because that arm measured nothing', () => {
  const lab = readFileSync(join(KIT_ROOT, 'bin', 'lab.mjs'), 'utf8');
  const void_ = lab.slice(lab.indexOf('detectedPlugin === false'));
  assert.match(void_.slice(0, 2000), /appendIndex\(\{[^}]*degraded: true/,
    'a VOID eval arm detected nothing the plugin does; recording it as trustworthy is the exact lie this kit exists to prevent');
  assert.equal((lab.match(/degraded: true,/g) ?? []).length, 1,
    'exactly one call site may stamp degraded unconditionally — a second one is a gate result being overridden by hand');
});

// §8.3 loose end 2: `KIT_OWNED_ENV` is the list of variables the kit sets deliberately, and
// the SC-11 B1 experiment exports this one. Without it, B1 blocks its own sweep.
test('envLeaks does not report MUBIT_MCP_LESSON_SCOPE, which the B1 experiment sets on purpose', () => {
  const leaks = envLeaks({
    MUBIT_MCP_LESSON_SCOPE: 'global',
    MUBIT_LAB_RESULTS: '/Users/x/mubit-lab-results',
    MUBIT_ENDPOINT: 'http://127.0.0.1:3100',
  });
  assert.deepEqual(leaks.map((l) => l.name), ['MUBIT_ENDPOINT'],
    'B1 exports MUBIT_MCP_LESSON_SCOPE to measure a bounded cross-run window, and reporting it as a leak blocks the experiment it is required by');
  assert.equal(leaks[0]?.value, 'http://127.0.0.1:3100',
    'the leak this check was built for is an ambient endpoint silently measuring another instance, and it must still be caught by name and value');
});

// §8.3 loose end 1: README:112 and bin/lab.mjs:18 both claimed `compare` refuses to place a
// degraded run beside a trusted one. It does not — :575 WARNs and :627 stamps `trusted` on
// the index row — and refusing outright would strand a legitimately-degraded overhead
// measurement, which is a real and useful number.
test('compare warns about a degraded run rather than refusing it, and both docs say so', () => {
  const lab = readFileSync(join(KIT_ROOT, 'bin', 'lab.mjs'), 'utf8');
  const readme = readFileSync(join(KIT_ROOT, 'README.md'), 'utf8');

  assert.ok(!/refuses to place/.test(readme),
    'the README describes a refusal the code has never performed, and the next operator plans around a guard that is not there');
  assert.ok(!/refuses to place/.test(lab),
    'a corrected README beside a stale header comment is worse than either alone — the reader believes the comment');
  assert.match(lab, /WARN {2}\$\{\[a, b\]/,
    'losing the warning entirely would put a degraded run in a comparison table with nothing marking it');
  assert.match(lab, /trusted: !summary\.degraded/,
    'the index row is where `trusted` is actually decided, and a reader sent to the wrong guard cannot audit it');
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
