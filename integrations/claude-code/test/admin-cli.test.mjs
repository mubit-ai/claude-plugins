// @ts-check
/**
 * `bin/admin.mjs` — the five administrative verbs that left the MCP surface.
 *
 * Each was a registered tool, paid for on every session before the model did anything,
 * and each already had a skill as its only real entry point. The skill now runs this script
 * instead, so the bill is zero until someone asks. What these tests pin:
 *
 *   1. The script speaks the routes the plugin already speaks, with the same bodies the hooks
 *      and the dashboard send — a run id on every write, the same reflect bound, the same
 *      delete route.
 *   2. What it prints is the compact form a tool result takes: one line per lesson with the
 *      id on it, every line in full — a shell command never reads or writes the seen-set,
 *      because it cannot know whether its output reached a model — and the ceiling honoured.
 *      `--json` is the raw reply.
 *   3. A person is watching: a bad flag exits 2 and dials nothing, a failed call exits 1 and
 *      says why.
 *
 * No real network — every test drives `main()` against `fakeMubit`, capturing both streams.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { baseEnv, fakeMubit, makeDataDir, mod, tempDir } from './helpers/harness.mjs';

const RUN = 'cc-admin-test-run';
const OTHER = 'cc-someone-elses-run';
/** A conversation that has been shown something, whose record the script must leave alone. */
const SESSION = '4f21ab90-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const LIST_ROUTE = 'POST /v2/control/activity';

/** One lesson as the activity feed serves it, metadata nested the way the census expects. */
function lesson(o) {
  return {
    id: o.id,
    created_at: o.at ?? '2026-08-01T00:00:00Z',
    entry_type: 'lesson',
    run_id: o.run ?? RUN,
    content: o.content,
    source: `reflection:${o.run ?? RUN}`,
    metadata_json: JSON.stringify({
      scope: o.scope ?? 'run',
      lesson_type: o.type ?? 'rule',
      importance: o.importance ?? 'medium',
      conditions: ['when the daemon wedges'],
      rationale: 'measured twice',
    }),
  };
}

function page(entries) {
  return { json: { entries, next_page_token: '', total_visible: entries.length } };
}

const CATALOGUE = [
  lesson({ id: 'les-0001', content: 'Poll the ingest job; the row lands after the queue.', importance: 'high' }),
  lesson({ id: 'les-0002', content: 'A retry against a wedged daemon only queues behind the wedge.', at: '2026-08-02T00:00:00Z' }),
  lesson({ id: 'les-0003', content: 'Global: never force-push main.', scope: 'global', run: OTHER, at: '2026-08-03T00:00:00Z' }),
  lesson({ id: 'les-0004', content: 'Other run, run scope: invisible from here.', run: OTHER, at: '2026-08-04T00:00:00Z' }),
];

/**
 * A fake instance, an env pointed at it with the run pinned, and the CLI with both streams
 * captured.
 * @param {import('node:test').TestContext} t
 * @param {{routes?: Record<string, any>, dataDir?: string, extra?: Record<string, string>}} [o]
 */
async function cli(t, o = {}) {
  const dataDir = o.dataDir ?? makeDataDir();
  const server = await fakeMubit(o.routes ?? {});
  t.after(() => server.close());
  const env = baseEnv({
    dataDir, endpoint: server.url,
    extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN, ...(o.extra ?? {}) },
  });
  const bin = await mod('bin/admin.src.mjs');
  /** @type {string[]} */ const out = [];
  /** @type {string[]} */ const err = [];
  const run = (argv, over = {}, deps = {}) => bin.main(argv, { ...env, ...over }, {
    stdout: (s) => out.push(s), stderr: (s) => err.push(s), stdin: () => '', ...deps,
  });
  return { dataDir, server, env, bin, run, out, err, stdout: () => out.join(''), stderr: () => err.join('') };
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

test('admin: a bad invocation exits 2 and dials nothing', async (t) => {
  const { server, run, stderr } = await cli(t);
  for (const argv of [[], ['nope'], ['lessons', '--nope'], ['lessons', '--scope', 'wide'], ['lessons', '--limit', '0'],
    ['forget'], ['checkpoint'], ['strategies', '--max', '99'], ['lessons', 'extra']]) {
    assert.equal(await run(argv), 2, `${argv.join(' ') || '(no args)'} must exit 2`);
  }
  assert.equal(server.requests.length, 0, `dialled: ${server.summary()}`);
  assert.match(stderr(), /usage: admin/);
});

test('admin: --help prints usage and exits 0', async (t) => {
  const { run, stdout } = await cli(t);
  assert.equal(await run(['--help']), 0);
  assert.match(stdout(), /lessons\s+\[--scope/);
});

// ---------------------------------------------------------------------------
// lessons
// ---------------------------------------------------------------------------

test('lessons: one line per lesson with id and tags, this run plus what travelled, newest first', async (t) => {
  const { run, stdout, server } = await cli(t, { routes: { [LIST_ROUTE]: page(CATALOGUE) } });

  assert.equal(await run(['lessons']), 0, stdout());
  const text = stdout();
  assert.match(text, /^run_id: cc-admin-test-run$/m);
  assert.match(text, /^showing: this run, plus every lesson/m);
  assert.match(text, /^Lessons \(3\):$/m, `wrong count:\n${text}`);
  const lines = text.split('\n').filter((l) => l.startsWith('- '));
  assert.deepEqual(lines.map((l) => /\] (\S+) —/.exec(l)?.[1]), ['les-0003', 'les-0002', 'les-0001'], `order:\n${text}`);
  assert.match(text, /^- \[rule, high, run\] les-0001 — Poll the ingest job/m);
  assert.match(text, /^- \[rule, medium, global\] les-0003 — Global: never force-push main\./m);
  assert.ok(!text.includes('les-0004'), `another run's run-scoped lesson leaked in:\n${text}`);
  assert.ok(!text.includes('rationale') && !text.includes('measured twice'), `metadata on the line:\n${text}`);
  // The census asks the activity feed, not the lessons route.
  assert.ok(server.countOf('POST', '/v2/control/activity') >= 1, server.summary());
  assert.equal(server.countOf('POST', '/v2/control/lessons'), 0, 'the lessons route filters after its limit');
});

// One fake instance per sub-case, so each assertion reads a request log of its own.
test('lessons: --scope and --importance narrow, --limit cuts and says so', async (t) => {
  const routes = { [LIST_ROUTE]: page(CATALOGUE) };

  let c = await cli(t, { routes });
  assert.equal(await c.run(['lessons', '--scope', 'global']), 0);
  assert.match(c.stdout(), /Lessons \(1\):\n- \[rule, medium, global\] les-0003/);

  c = await cli(t, { routes });
  assert.equal(await c.run(['lessons', '--scope', 'run']), 0);
  assert.match(c.stdout(), /Lessons \(2\):/);
  assert.ok(!c.stdout().includes('les-0003'));

  c = await cli(t, { routes });
  assert.equal(await c.run(['lessons', '--importance', 'high']), 0);
  assert.match(c.stdout(), /Lessons \(1\):\n- \[rule, high, run\] les-0001/);

  c = await cli(t, { routes });
  assert.equal(await c.run(['lessons', '--limit', '1']), 0);
  assert.match(c.stdout(), /Lessons \(1\):/);
  assert.match(c.stdout(), /^matched: 3$/m, 'the count line must still say how many matched');
});

test('lessons: an empty catalogue is a real answer', async (t) => {
  const { run, stdout } = await cli(t, { routes: { [LIST_ROUTE]: page([]) } });
  assert.equal(await run(['lessons']), 0);
  assert.match(stdout(), /No lessons matched\./);
});

test('lessons: --json is the raw catalogue, uncapped', async (t) => {
  const { run, stdout } = await cli(t, { routes: { [LIST_ROUTE]: page(CATALOGUE) } });
  assert.equal(await run(['lessons', '--json']), 0);
  const json = JSON.parse(stdout());
  assert.equal(json.run_id, RUN);
  assert.equal(json.matched, 3);
  assert.deepEqual(json.lessons.map((l) => l.id), ['les-0003', 'les-0002', 'les-0001']);
  assert.equal(json.lessons[2].rationale, 'measured twice', 'the raw form keeps the metadata');
});

// The defect: a verification run from a plain terminal marked a run's whole catalogue as
// shown, and the next conversation in that directory was handed four "(seen earlier)"
// fragments with nothing to dereference them against. A shell command cannot know whether
// its stdout reached a model, so it is out of the seen-set in both directions — it neither
// degrades what a conversation has been shown, nor records what it printed.
test('lessons: renders every lesson in full whatever a conversation has been shown, and records nothing', async (t) => {
  const { run, stdout, out, dataDir } = await cli(t, { routes: { [LIST_ROUTE]: page(CATALOGUE) } });
  const { markSeen } = await mod('lib/seen.mjs');
  markSeen({ dataDir }, RUN, ['les-0002'], SESSION);
  const seenDir = join(dataDir, 'runs', RUN, 'seen');
  const before = readFileSync(join(seenDir, `${SESSION}.json`), 'utf8');

  assert.equal(await run(['lessons']), 0);
  const text = stdout();
  assert.match(text, /^Lessons \(3\):$/m, text);
  assert.match(text, /^- \[rule, medium, run\] les-0002 — A retry against a wedged daemon/m, text);
  assert.ok(!text.includes('(seen earlier)'),
    `a shell command pointed at text it cannot know the model has:\n${text}`);
  assert.ok(!text.includes('mubit_dereference'), `a pointer footer with no pointer to explain:\n${text}`);

  assert.deepEqual(readdirSync(seenDir), [`${SESSION}.json`], 'the listing must not create a seen-set of its own');
  assert.equal(readFileSync(join(seenDir, `${SESSION}.json`), 'utf8'), before,
    'nor touch the conversation\'s');
  out.length = 0;

  assert.equal(await run(['lessons']), 0);
  assert.match(stdout(), /^Lessons \(3\):$/m, 'the second listing is as full as the first');
  assert.ok(!stdout().includes('(seen earlier)'), stdout());
});

test('lessons: the ceiling cuts a prefix and names the way to the rest', async (t) => {
  const many = Array.from({ length: 80 }, (_, i) => lesson({
    id: `les-many-${String(i).padStart(3, '0')}`, at: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T00:00:${String(i % 60).padStart(2, '0')}Z`,
    content: `Lesson ${i}: a full sentence of the kind a reflection writes, long enough to cost tokens on its line.`,
  }));
  const { run, stdout } = await cli(t, {
    routes: { [LIST_ROUTE]: page(many) }, extra: { MUBIT_CC_MCP_RESULT_TOKENS: '400' },
  });
  assert.equal(await run(['lessons', '--limit', '80']), 0);
  const text = stdout();
  const shown = (text.match(/^- /gm) ?? []).length;
  assert.ok(shown > 0 && shown < 80, `a 400-token ceiling rendered ${shown} of 80`);
  assert.match(text, new RegExp(`Showing ${shown} of 80; --limit and --scope narrow it, --json is the whole listing\\.`));
});

test('lessons: a failed census exits 1 and says why', async (t) => {
  const { run, stderr } = await cli(t, { routes: { [LIST_ROUTE]: { status: 503, json: { error: 'down' } } } });
  assert.equal(await run(['lessons']), 1);
  assert.match(stderr(), /could not read the catalogue/);
});

// ---------------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------------

test('forget: deletes exactly the named lesson by the delete route, and says it cannot be undone', async (t) => {
  const { run, stdout, server } = await cli(t, {
    routes: { 'POST /v2/control/lessons/delete': { json: { success: true, deleted: 1 } } },
  });
  assert.equal(await run(['forget', 'les-0002']), 0, stdout());
  const call = server.lastCall('POST', '/v2/control/lessons/delete');
  assert.ok(call, server.summary());
  assert.deepEqual(call.body, { lesson_id: 'les-0002' }, 'the body must name the lesson and nothing else');
  assert.equal(server.requests.filter((r) => r.path.includes('/runs')).length, 0, 'never a run deletion');
  assert.match(stdout(), /Deleted lesson les-0002\. This cannot be undone\./);
});

test('forget: a refused delete exits 1 with the reason', async (t) => {
  const { run, stderr } = await cli(t, {
    routes: { 'POST /v2/control/lessons/delete': { status: 404, json: { error: 'lesson not found' } } },
  });
  assert.equal(await run(['forget', 'les-nope']), 1);
  assert.match(stderr(), /could not delete lesson les-nope/);
});

// ---------------------------------------------------------------------------
// checkpoint
// ---------------------------------------------------------------------------

test('checkpoint: posts the snapshot verbatim under the run with the label, from a file or stdin', async (t) => {
  const { run, stdout, out, server } = await cli(t);
  const dir = tempDir('mubit-admin-ckpt-');
  const file = join(dir, 'snap.md');
  const snapshot = '# Where we are\n\nmid-migration on feat/x, three files edited.\n';
  writeFileSync(file, snapshot);

  assert.equal(await run(['checkpoint', '--label', 'before the rebase', '--file', file]), 0, stdout());
  let call = server.lastCall('POST', '/v2/control/checkpoint');
  assert.ok(call, server.summary());
  assert.equal(call.body.run_id, RUN);
  assert.equal(call.body.label, 'before the rebase');
  assert.equal(call.body.context_snapshot, snapshot, 'the snapshot must go up byte for byte');
  assert.equal(JSON.parse(call.body.metadata_json).source, 'admin');
  assert.match(stdout(), /Checkpoint ckpt_test_1 saved for run cc-admin-test-run, labelled "before the rebase" \(~3400 tokens\)\./);
  out.length = 0;

  assert.equal(await run(['checkpoint', '--label', 'from stdin'], {}, { stdin: () => 'piped snapshot\n' }), 0);
  call = server.lastCall('POST', '/v2/control/checkpoint');
  assert.equal(call.body.context_snapshot, 'piped snapshot\n');
  assert.equal(call.body.label, 'from stdin');
});

test('checkpoint: no snapshot at all exits 2 and dials nothing', async (t) => {
  const { run, stderr, server } = await cli(t);
  assert.equal(await run(['checkpoint', '--label', 'empty']), 2);
  assert.match(stderr(), /checkpoint needs a snapshot/);
  assert.equal(server.countOf('POST', '/v2/control/checkpoint'), 0);
});

// ---------------------------------------------------------------------------
// strategies
// ---------------------------------------------------------------------------

const STRATEGIES = {
  strategies: [
    { strategy_id: 'strat-1', description: 'Poll after every ingest; the row lands after the queue.', dominant_lesson_type: 'rule',
      dominant_scope: 'run', supporting_lesson_count: 2, lesson_ids: ['les-0001', 'les-0002'], avg_confidence: 0.7, avg_reinforcement: 1.5 },
    { strategy_id: 'strat-2', description: 'Rebase before a force-push, never after.', dominant_lesson_type: 'failure',
      dominant_scope: 'global', supporting_lesson_count: 1, lesson_ids: ['les-0003'], avg_confidence: 0.5, avg_reinforcement: 1 },
  ],
};

test('strategies: posts the run and the bound, and renders each strategy with its supporting lesson ids', async (t) => {
  const { run, stdout, server } = await cli(t, { routes: { 'POST /v2/control/strategies': { json: STRATEGIES } } });

  assert.equal(await run(['strategies', '--max', '7', '--types', 'rule,failure']), 0, stdout());
  const call = server.lastCall('POST', '/v2/control/strategies');
  assert.ok(call, server.summary());
  assert.deepEqual(call.body, { run_id: RUN, max_strategies: 7, lesson_types: ['rule', 'failure'] });
  const text = stdout();
  assert.match(text, /^Strategies \(2\):$/m);
  assert.match(text, /^- \[rule, run\] strat-1 — Poll after every ingest; the row lands after the queue\. \(from 2 lessons: les-0001, les-0002\)$/m, text);
  assert.match(text, /^- \[failure, global\] strat-2 — Rebase before a force-push, never after\. \(from 1 lessons: les-0003\)$/m, text);
  assert.match(text, /inferred from a cluster of lessons/);
  assert.ok(!text.includes('avg_confidence'), 'the averages are not on the line');
});

test('strategies: the default bound is five, and an empty answer says why it may be empty', async (t) => {
  const { run, stdout, server } = await cli(t, { routes: { 'POST /v2/control/strategies': { json: { strategies: [] } } } });
  assert.equal(await run(['strategies']), 0);
  assert.equal(server.lastCall('POST', '/v2/control/strategies').body.max_strategies, 5);
  assert.match(stdout(), /No strategies: clustering needs a body of lessons/);
});

// ---------------------------------------------------------------------------
// reflect
// ---------------------------------------------------------------------------

test('reflect: sends the SessionEnd body for this run and renders the extracted lessons compactly', async (t) => {
  const { run, stdout, server, dataDir } = await cli(t);

  assert.equal(await run(['reflect']), 0, stdout());
  const call = server.lastCall('POST', '/v2/control/reflect');
  assert.ok(call, server.summary());
  assert.deepEqual(call.body, { run_id: RUN, include_linked_runs: false, include_step_outcomes: true, last_n_items: 200 });
  const text = stdout();
  assert.match(text, /^summary: ok$/m);
  assert.match(text, /^lessons_stored: 1$/m);
  assert.match(text, /^Lessons \(1\):\n- \[failure, high, run\] les_1 — When X, do Y\.$/m, text);

  assert.equal(existsSync(join(dataDir, 'runs', RUN, 'seen')), false,
    'a reflect printed from a shell records nothing as shown: the next injection renders les_1 in full');
});

test('reflect: an empty reflect is a real answer', async (t) => {
  const { run, stdout } = await cli(t, {
    routes: { 'POST /v2/control/reflect': { json: { lessons: [], summary: 'nothing new', confidence: 0.2, degraded: false, lessons_stored: 0 } } },
  });
  assert.equal(await run(['reflect']), 0);
  assert.match(stdout(), /^summary: nothing new$/m);
  assert.match(stdout(), /No lessons extracted\. An empty reflect is a real answer/);
});

test('reflect: --json is the raw reply', async (t) => {
  const { run, stdout } = await cli(t);
  assert.equal(await run(['reflect', '--json']), 0);
  assert.equal(JSON.parse(stdout()).lessons[0].lesson_id, 'les_1');
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

test('admin parseArgs: --data-dir is taken as given, and a blank or unsubstituted value is dropped', async () => {
  const { parseArgs } = await mod('bin/admin.src.mjs');
  assert.equal(parseArgs(['lessons', '--data-dir', '/store/ours']).dataDir, '/store/ours');
  assert.equal(parseArgs(['lessons', '--data-dir', '   ']).dataDir, '', 'a Bash tool call can expand the expression to nothing');
  assert.equal(parseArgs(['lessons', '--data-dir', '${CLAUDE_PLUGIN_DATA}']).dataDir, '',
    'a host that substitutes nothing hands the literal down; taken as a path it would be a directory under the cwd');
  assert.equal(parseArgs(['lessons', '--data-dir', '${MUBIT_CC_DATA_DIR:-${CLAUDE_PLUGIN_DATA}}']).dataDir, '');
  assert.equal(parseArgs(['lessons']).dataDir, '');
  assert.match(parseArgs(['lessons', '--data-dir']).error, /--data-dir needs a value/);
});

// The skills run this through Bash, where `CLAUDE_PLUGIN_DATA` arrives empty. Without the
// flag the script searched `~/.claude/plugins/data/` and picked a sibling install's store —
// one whose markers named a run this session's hooks never wrote to.
test('--data-dir names the store the run is picked from', async (t) => {
  const theirs = makeDataDir();
  const ours = makeDataDir();
  const { run, server, stderr } = await cli(t, {
    dataDir: theirs,
    routes: { 'POST /v2/control/strategies': { json: { strategies: [] } } },
    extra: { MUBIT_CC_RUN_STRATEGY: 'per-directory', MUBIT_CC_RUN_ID: '' },
  });
  mkdirSync(join(ours, 'status'), { recursive: true });
  writeFileSync(join(ours, 'status', 'cc-from-our-store.json'),
    JSON.stringify({ run_id: 'cc-from-our-store', updated_at: Date.now() }));

  assert.equal(await run(['strategies', '--data-dir', ours]), 0, stderr());
  assert.equal(server.lastCall('POST', '/v2/control/strategies').body.run_id, 'cc-from-our-store',
    'the run must come from the named store, not from the one the environment pinned');
});

test('--run names the run every command acts on', async (t) => {
  const { run, server } = await cli(t, { routes: { 'POST /v2/control/strategies': { json: { strategies: [] } } } });
  assert.equal(await run(['strategies', '--run', 'cc-named-run']), 0);
  assert.equal(server.lastCall('POST', '/v2/control/strategies').body.run_id, 'cc-named-run');
});

test('with no run to observe and none named, every command refuses before dialling', async (t) => {
  const { run, stderr, server } = await cli(t, { extra: { MUBIT_CC_RUN_STRATEGY: 'per-directory', MUBIT_CC_RUN_ID: '' } });
  assert.equal(await run(['reflect']), 1);
  assert.match(stderr(), /Could not tell which Mubit run this session is using/);
  assert.match(stderr(), /admin reflect --run <run_id>/);
  assert.equal(server.requests.length, 0, server.summary());
});
