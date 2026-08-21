// @ts-check
/**
 * The miners, pinned against fixtures.
 *
 * When the host renames a stream-json field or the plugin changes its status line, these are
 * the tests that say so — instead of a sweep quietly reporting zeros, which reads exactly
 * like "the plugin does nothing".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { hookBudgets, parseDebugLog, parseRingLog, parseTokens, parseTranscripts } from '../lib/latency.mjs';
import { readInit, readResult, pluginLoaded, toTrial } from '../lib/metrics.mjs';
import { median, percentile, signTest, pairedDelta } from '../lib/stats.mjs';

test('parseTokens expands the k suffix — the bug a naive grep ships with', () => {
  assert.equal(parseTokens('522'), 522);
  assert.equal(parseTokens('1.2k'), 1200);
  assert.equal(parseTokens('12.0k'), 12000);
  // The failure this guards: parseInt('1.2k') is 1, which turns 1200 injected tokens into 1
  // and makes a context-cost regression look like an improvement.
  assert.notEqual(parseTokens('1.2k'), 1);
});

test('parseDebugLog reads the per-prompt recall series, k suffixes included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tk-dbg-'));
  const f = join(dir, 'debug.log');
  writeFileSync(f, [
    'some host chatter',
    'systemMessage: "mubit: 3 memories · 522 tok · 1810ms"',
    'systemMessage: "mubit: 1 memory · 1.2k tok · 402ms"',
    'MCP server "plugin:mubit-memory:mubit": Successfully connected (transport: stdio) in 663ms',
    '[API:timing] first byte after 940ms',
  ].join('\n'));
  try {
    const r = parseDebugLog(f);
    assert.deepEqual(r.recall, [
      { sources: 3, tokens: 522, ms: 1810 },
      { sources: 1, tokens: 1200, ms: 402 },
    ]);
    assert.deepEqual(r.mcpBootMs, [663]);
    assert.deepEqual(r.firstByteMs, [940]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseRingLog separates overruns from drain time, and reads both rotations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tk-ring-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'logs', 'mubit-cc.log.1'), JSON.stringify({ level: 'warn', hook: 'UserPromptSubmit', budget_ms: 1500, elapsed_ms: 1802 }) + '\n');
  writeFileSync(join(dir, 'logs', 'mubit-cc.log'), [
    JSON.stringify({ level: 'info', msg: 'drain: 4 item(s) in 1 batch(es)', ms: 167 }),
    JSON.stringify({ level: 'info', msg: 'something else', ms: 9999 }),
    JSON.stringify({ level: 'error', msg: 'drain: ingest failed' }),
    'not json at all',
  ].join('\n'));
  try {
    const r = parseRingLog(dir);
    assert.deepEqual(r.overruns, [{ hook: 'UserPromptSubmit', budgetMs: 1500, elapsedMs: 1802 }]);
    assert.deepEqual(r.drainMs, [167], 'only the drain summary line carries drain wall time');
    assert.equal(r.errors.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseTranscripts reads stop_hook_summary and ignores every other subtype', () => {
  const root = mkdtempSync(join(tmpdir(), 'tk-tx-'));
  const proj = join(root, 'some-project');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'sess.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', plugins: ['mubit-memory'] }),
    JSON.stringify({
      type: 'system', subtype: 'stop_hook_summary',
      hookInfos: [
        { command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/dist/capture.mjs --stop', durationMs: 118 },
        { command: 'some-other-tool run', durationMs: 9000 },
      ],
    }),
    JSON.stringify({ type: 'system', subtype: 'post_tool_use_summary', hookInfos: [{ command: 'hooks/dist/x.mjs', durationMs: 5 }] }),
  ].join('\n'));
  try {
    const r = parseTranscripts({ root, limit: 10 });
    assert.equal(r.length, 1, 'only hooks/dist commands inside stop_hook_summary count');
    assert.equal(r[0].ms, 118);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hookBudgets reads the plugin under test, not a hardcoded table', () => {
  const b = hookBudgets('/Users/eldaru/Mubit/pre-main/integrations/claude-code');
  assert.equal(b.UserPromptSubmit, 3000);
  assert.equal(b.SessionEnd, 8000);
  assert.equal(b.PreCompact, 10000);
});

/* -------------------------------------------------------------------------- */

/** A stream-json envelope in the shape `claude` 2.1.237 emits. */
const EVENTS_ON = [
  { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-4-6', plugins: ['mubit-memory'], plugin_errors: [], mcp_servers: [{ name: 'plugin:mubit-memory:mubit', status: 'connected' }] },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
  {
    type: 'result', subtype: 'success', is_error: false, num_turns: 3,
    duration_ms: 38110, duration_api_ms: 37000, ttft_ms: 1902, time_to_request_ms: 210,
    total_cost_usd: 0.0413, stop_reason: 'end_turn', permission_denials: [],
    usage: { input_tokens: 12, cache_creation_input_tokens: 4106, cache_read_input_tokens: 18422, output_tokens: 388, output_tokens_details: { thinking_tokens: 0 } },
  },
];

test('readInit surfaces the arm proof: plugins, errors and mcp servers', () => {
  const i = readInit(EVENTS_ON);
  assert.equal(i.found, true);
  assert.deepEqual(i.plugins, ['mubit-memory']);
  assert.equal(i.sessionId, 's1');
  assert.equal(i.model, 'claude-sonnet-4-6');
  assert.equal(pluginLoaded('mubit-memory', i.plugins), true);
  assert.equal(pluginLoaded('mubit-memory', ['typescript-lsp']), false);
  assert.equal(pluginLoaded('mubit-memory', ['mubit-memory@mubit']), true, 'a marketplace-qualified id still counts as loaded');
});

test('a missing init event is reported as missing, not as a clean control', () => {
  const i = readInit([{ type: 'result' }]);
  assert.equal(i.found, false);
  assert.deepEqual(i.plugins, []);
});

test('toTrial maps the result envelope onto TBench-compatible field names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tk-trial-'));
  try {
    const t = toTrial({
      arm: 'treatment', caseId: 'W1-bugfix', rep: 2,
      pluginName: 'mubit-memory', pluginDir: '/nonexistent', dataDir: dir,
      runId: 'tk-x', debugFile: join(dir, 'absent.log'),
      run: { events: EVENTS_ON, code: 0, stderr: '', timedOut: false, wallMs: 41200 },
    });
    assert.equal(t.cost_usd, 0.0413);
    assert.equal(t.input_tokens, 12);
    assert.equal(t.cache_creation_tokens, 4106);
    assert.equal(t.cache_read_tokens, 18422);
    assert.equal(t.output_tokens, 388);
    assert.equal(t.steps, 3);
    assert.equal(t.ttft_ms, 1902);
    assert.equal(t.span_s, 41.2);
    assert.equal(t.agent_exec_s, 38.11);
    assert.equal(t.resolved_model, 'claude-sonnet-4-6');
    assert.equal(t.mubit.loaded, true);
    // Null, not zero, and not invented: this kit does not measure task success.
    assert.equal(t.resolved, null);
    assert.equal(t.reward, null);
    assert.equal(t.scoreable, true);
    assert.equal(t.exception, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a timed-out run is scored as an exception rather than as a fast one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tk-trial2-'));
  try {
    const t = toTrial({
      arm: 'treatment', caseId: 'c', rep: 1, pluginName: 'mubit-memory',
      pluginDir: '/nonexistent', dataDir: dir, runId: 'r', debugFile: join(dir, 'x.log'),
      run: { events: [EVENTS_ON[0]], code: null, stderr: '', timedOut: true, wallMs: 600000 },
    });
    assert.equal(t.timed_out, true);
    assert.equal(t.exception, 'timeout');
    assert.equal(t.scoreable, false, 'an unscoreable trial must not enter a pair');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* -------------------------------------------------------------------------- */

test('stats: medians, nearest-rank percentiles, and an exact sign test', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);

  // Nearest rank, so every printed percentile is a value some run actually produced.
  assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 5);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);

  assert.equal(signTest([1, 1, 1, 1, 1, 1]).p, 0.03125);
  assert.equal(signTest([1, 1, 1, 1]).p, 0.125);
  assert.equal(signTest([1, 1, 1, 1]).underpowered, true);
  assert.equal(signTest([0, 0, 0]).p, null, 'all ties means nothing can be claimed');
  assert.equal(signTest([1, -1, 1, -1, 1, -1]).p, 1);
});

test('pairedDelta pairs on the key and drops unmatched cells', () => {
  const a = new Map([['x#1', 10], ['y#1', 20], ['z#1', 30]]);
  const b = new Map([['x#1', 4], ['y#1', 5]]);
  const d = pairedDelta(a, b);
  assert.equal(d.pairs, 2, 'an unpaired cell must not contribute a delta');
  assert.equal(d.medianDelta, 10.5);
});

/* -------------------------------------------------------------------------- */
/* regression: the shape of plugins[] in system/init                          */
/* -------------------------------------------------------------------------- */

test('plugins[] entries are objects, and reading them as strings must not void a good arm', () => {
  // The real shape on claude 2.1.237. Mapping these through String() gives "[object Object]",
  // which reads as "plugin absent" and marks a perfectly good treatment arm VOID.
  const events = [{
    type: 'system', subtype: 'init', session_id: 's', model: 'm',
    plugins: [{ name: 'mubit-memory', path: '/p', source: 'mubit-memory@inline', version: '0.10.0' }],
    mcp_servers: [{ name: 'plugin:mubit-memory:mubit', status: 'connected' }],
    tools: ['Read', 'mcp__plugin_mubit-memory_mubit__mubit_recall'],
    skills: ['mubit-memory:remember'],
    // plugin_errors is absent entirely when nothing failed — a missing key is good news.
  }];
  const i = readInit(events);
  assert.deepEqual(i.plugins, ['mubit-memory']);
  assert.equal(pluginLoaded('mubit-memory', i.plugins), true);
  assert.deepEqual(i.pluginErrors, []);
  assert.equal(i.mcpServers[0].status, 'connected');
});

test('pluginLoaded accepts the object form directly too', () => {
  assert.equal(pluginLoaded('mubit-memory', [{ name: 'mubit-memory' }]), true);
  assert.equal(pluginLoaded('mubit-memory', [{ name: 'typescript-lsp' }]), false);
  assert.equal(pluginLoaded('mubit-memory', [{}]), false);
});

test('the treatment arm never carries --strict-mcp-config, which would strip the MCP surface', async () => {
  const { buildRun } = await import('../lib/arms.mjs');
  const r = buildRun({
    arm: 'treatment', pluginDir: '/p', prompt: 'hi', model: 'sonnet',
    dataDir: '/d', runId: 'r', debugFile: '/f', ambient: [],
  });
  assert.ok(!r.argv.includes('--strict-mcp-config'),
    'with the flag, init reports mcp_servers: [] and 0 mubit tools — most of the plugin is missing');
  assert.ok(r.argv.includes('--setting-sources'), 'user MCP servers are kept out this way instead');
});
