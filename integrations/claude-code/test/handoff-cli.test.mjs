// @ts-check
/**
 * `/mubit-memory:handoff` — `bin/handoff.src.mjs`, bundled to `bin/handoff.mjs`, over
 * `lib/handoff.mjs`.
 *
 * The surface is a skill plus a script rather than an MCP tool, for the reason `pin` is: no
 * tool on the vendored server covers the handoff routes, and the allowlist stays at seven.
 *
 * Three properties carry the risk:
 *
 *   1. **Open is computed here.** The server never flips a handoff's `active` flag and has no
 *      list route, so "open" is "no feedback names this id", joined client-side from one
 *      `/activity` page. A reader that trusted `active` would find everything open for ever.
 *   2. **The run is the parent's.** A subagent's note is filed under the run its parent is in;
 *      a sub-run id never reaches the wire, and the CLI refuses `default` and an ambiguous
 *      pair of live runs by name rather than guessing.
 *   3. **Nothing on stdout carries the key**, in either output mode.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fakeMubit, makeDataDir, mod } from './helpers/harness.mjs';

const RUN_ID = 'cc-handoff-run';
const KEY = 'mbt_test_0123456789abcdef_deadbeefcafebabe0123456789abcdef';

const CLI = await mod('bin/handoff.src.mjs');

/** The env a skill-invoked script actually gets: the plugin's, minus a hook payload. */
function env(dataDir, server, extra = {}) {
  return {
    HOME: dataDir,
    MUBIT_CC_DATA_DIR: dataDir,
    CLAUDE_PLUGIN_DATA: dataDir,
    CLAUDE_PROJECT_DIR: dataDir,
    MUBIT_ENDPOINT: server ? server.url : '',
    MUBIT_API_KEY: KEY,
    MUBIT_CC_LOG_LEVEL: 'error',
    MUBIT_DEFAULT_SESSION_ID: '',
    ...extra,
  };
}

function sink() {
  /** @type {string[]} */
  const lines = [];
  return { lines, log: (m) => lines.push(String(m)), text: () => lines.join('\n') };
}

/** The marker a run's hooks leave behind — how the CLI learns which run it is in. */
function seedMarker(dataDir, runId = RUN_ID, at = Date.now()) {
  mkdirSync(join(dataDir, 'status'), { recursive: true });
  writeFileSync(join(dataDir, 'status', `${runId}.json`),
    JSON.stringify({ run_id: runId, state: 'ready', updated_at: at }));
}

/** An `/activity` entry as the server writes a handoff created through the route. */
const handoffEntry = (id, over = {}) => ({
  id,
  created_at: '2026-09-07T10:00:00Z',
  entry_type: 'handoff',
  run_id: RUN_ID,
  content: over.content ?? `note ${id}`,
  source: over.from ?? 'claude-code',
  metadata_json: JSON.stringify({
    entry_type: 'handoff', task_id: over.task ?? `task-${id}`, from_agent_id: over.from ?? 'claude-code',
    to_agent_id: over.to ?? 'codex', requested_action: over.action ?? 'review',
    created_at: '2026-09-07T10:00:00Z', active: true,
  }),
});

/** …and a subagent's note, which arrived through ingest with the same keys. */
const subagentEntry = (id) => ({
  id,
  created_at: '2026-09-07T10:01:00Z',
  entry_type: 'handoff',
  run_id: RUN_ID,
  content: 'Q: find the call sites\n\nA: Found three call sites in src/service/lib.rs.',
  source: 'agent',
  metadata_json: JSON.stringify({
    hook_event: 'SubagentStop', agent_id: 'sub_01HZXK8Q9N7M', mubit_agent_id: 'claude-code-sub-01hzxk8q9n7m',
    from_agent_id: 'claude-code-sub-01hzxk8q9n7m', to_agent_id: 'claude-code', requested_action: 'review',
    task_id: 'prompt-1', active: true,
  }),
});

const feedbackEntry = (id, handoffId, verdict = 'approve', over = {}) => ({
  id,
  created_at: '2026-09-07T10:05:00Z',
  entry_type: 'feedback',
  run_id: RUN_ID,
  content: over.comments ?? `Feedback: ${verdict} (${handoffId})`,
  source: over.from ?? 'codex',
  metadata_json: JSON.stringify({
    entry_type: 'feedback', handoff_id: handoffId, verdict, created_at: '2026-09-07T10:05:00Z',
    ...(over.from ? { from_agent_id: over.from } : {}),
  }),
});

function routes(over = {}) {
  return {
    'POST /v2/control/handoff': { json: { success: true, handoff_id: 'hnd_01' } },
    'POST /v2/control/feedback': { json: { success: true, feedback_id: 'fb_01' } },
    'POST /v2/control/activity': { json: { entries: [], next_page_token: '', total_visible: 0 } },
    ...over,
  };
}

const activity = (entries) => ({ json: { entries, next_page_token: '', total_visible: entries.length } });

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

test('handoff send: posts the note under the run and prints the id the server minted', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);
  const out = sink();

  const code = await CLI.main(['send', '--to', 'codex', '--action', 'review', '--task', 'T-7', 'look at the auth diff'],
    env(dir, server), { log: out.log });
  assert.equal(code, 0, out.text());

  const body = server.lastCall('POST', '/v2/control/handoff').body;
  assert.equal(body.run_id, RUN_ID);
  assert.equal(body.to_agent_id, 'codex');
  assert.equal(body.from_agent_id, 'claude-code', 'the sender is this host\'s role unless --from says otherwise');
  assert.equal(body.content, 'look at the auth diff');
  assert.equal(body.requested_action, 'review');
  assert.equal(body.task_id, 'T-7');
  assert.match(out.text(), /hnd_01/, 'the id is what feedback names, so it has to be printed');
});

test('handoff send: the default action is continue, and --from overrides the sender', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);

  assert.equal(await CLI.main(['send', '--to', 'codex', '--from', 'orchestrator', 'carry on'], env(dir, server), { log: sink().log }), 0);
  const body = server.lastCall('POST', '/v2/control/handoff').body;
  assert.equal(body.requested_action, 'continue');
  assert.equal(body.from_agent_id, 'orchestrator');
});

test('handoff send: refuses a missing recipient, an empty note and an unknown action before dialing', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);

  for (const [argv, re] of [
    [['send', 'a note with nobody to send it to'], /--to/],
    [['send', '--to', 'codex'], /Nothing to hand off/],
    [['send', '--to', 'codex', '--action', 'ponder', 'x'], /--action must be one of/],
  ]) {
    const out = sink();
    assert.equal(await CLI.main(argv, env(dir, server), { log: out.log }), 1, argv.join(' '));
    assert.match(out.text(), re);
  }
  assert.equal(server.requests.length, 0, `nothing may be dialed for a refused send; saw: ${server.summary()}`);
});

test('handoff send: a note that starts with -- is still the note', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);
  assert.equal(await CLI.main(['send', '--to', 'codex', '--force is banned here'], env(dir, server), { log: sink().log }), 0);
  assert.equal(server.lastCall('POST', '/v2/control/handoff').body.content, '--force is banned here');
});

// ---------------------------------------------------------------------------
// list — the join
// ---------------------------------------------------------------------------

test('handoff list: joins feedback to handoffs client-side, and open means unanswered', async (t) => {
  const server = await fakeMubit(routes({
    'POST /v2/control/activity': activity([
      feedbackEntry('fb_1', 'hnd_a', 'approve', { from: 'codex', comments: 'looks right' }),
      subagentEntry('hnd_sub'),
      handoffEntry('hnd_a', { to: 'codex' }),
      handoffEntry('hnd_b', { to: 'codex', action: 'execute' }),
      feedbackEntry('fb_2', 'hnd_elsewhere', 'block'),
    ]),
  }));
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);
  const out = sink();

  assert.equal(await CLI.main(['list', '--json'], env(dir, server), { log: out.log }), 0, out.text());
  const body = server.lastCall('POST', '/v2/control/activity').body;
  assert.equal(body.run_id, RUN_ID, 'a listing is scoped to the run — there is no cross-run handoff');
  assert.deepEqual([...body.entry_types].sort(), ['feedback', 'handoff']);

  const payload = JSON.parse(out.text());
  assert.equal(payload.ok, true);
  const byId = Object.fromEntries(payload.handoffs.map((h) => [h.id, h]));
  assert.deepEqual(Object.keys(byId).sort(), ['hnd_a', 'hnd_b', 'hnd_sub']);

  assert.equal(byId.hnd_a.open, false, 'fb_1 names it');
  assert.deepEqual(byId.hnd_a.feedback.map((f) => [f.id, f.verdict, f.from, f.comments]),
    [['fb_1', 'approve', 'codex', 'looks right']]);
  assert.equal(byId.hnd_b.open, true);
  assert.equal(byId.hnd_b.action, 'execute');

  // The subagent's note, which came through ingest, reads exactly like one from the route.
  assert.equal(byId.hnd_sub.open, true);
  assert.equal(byId.hnd_sub.from, 'claude-code-sub-01hzxk8q9n7m');
  assert.equal(byId.hnd_sub.to, 'claude-code');
  assert.equal(byId.hnd_sub.action, 'review');
  assert.equal(byId.hnd_sub.task_id, 'prompt-1');

  assert.equal(payload.orphans, 1, 'feedback naming a handoff outside the listing is counted, not hidden');
});

test('handoff list --open: only what nobody has answered, rendered for a person', async (t) => {
  const server = await fakeMubit(routes({
    'POST /v2/control/activity': activity([
      handoffEntry('hnd_a'), feedbackEntry('fb_1', 'hnd_a'), handoffEntry('hnd_b', { content: 'still waiting on this one' }),
    ]),
  }));
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);
  const out = sink();

  assert.equal(await CLI.main(['list', '--open'], env(dir, server), { log: out.log }), 0);
  assert.match(out.text(), /1 open handoff/);
  assert.match(out.text(), /hnd_b.*open/);
  assert.ok(!out.text().includes('hnd_a'), 'an answered handoff is not open');
  assert.match(out.text(), /still waiting on this one/);
});

test('handoff list: an empty run says so rather than printing nothing', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);
  const out = sink();
  assert.equal(await CLI.main([], env(dir, server), { log: out.log }), 0, 'list is the default verb');
  assert.match(out.text(), /No handoffs in cc-handoff-run/);
});

// ---------------------------------------------------------------------------
// feedback
// ---------------------------------------------------------------------------

test('handoff feedback: posts the verdict against the id, from this host\'s role', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);
  const out = sink();

  const code = await CLI.main(['feedback', 'hnd_a', '--verdict', 'request_changes', '--comments', 'the test is missing'],
    env(dir, server), { log: out.log });
  assert.equal(code, 0, out.text());
  const body = server.lastCall('POST', '/v2/control/feedback').body;
  assert.equal(body.run_id, RUN_ID);
  assert.equal(body.handoff_id, 'hnd_a');
  assert.equal(body.verdict, 'request_changes');
  assert.equal(body.comments, 'the test is missing');
  assert.equal(body.from_agent_id, 'claude-code');
  assert.match(out.text(), /fb_01/);
});

test('handoff feedback: refuses a missing id, a missing verdict and an unknown verdict before dialing', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);
  for (const [argv, re] of [
    [['feedback', '--verdict', 'approve'], /Name the handoff/],
    [['feedback', 'hnd_a'], /verdict is required/],
    [['feedback', 'hnd_a', '--verdict', 'meh'], /--verdict must be one of/],
  ]) {
    const out = sink();
    assert.equal(await CLI.main(argv, env(dir, server), { log: out.log }), 1, argv.join(' '));
    assert.match(out.text(), re);
  }
  assert.equal(server.requests.length, 0, `saw: ${server.summary()}`);
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

test('handoff: with no run to be found it says what to do, and dials nothing', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const out = sink();
  const code = await CLI.main(['send', '--to', 'codex', 'nowhere'], env(makeDataDir(), server), { log: out.log });
  assert.equal(code, 1);
  assert.equal(server.requests.length, 0, `saw: ${server.summary()}`);
  assert.match(out.text(), /--run/);
});

test('handoff: two live runs are refused by name rather than guessed between', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  const now = Date.now();
  seedMarker(dir, 'cc-mine-11111111', now - 64_000);
  seedMarker(dir, 'cc-theirs-22222222', now);
  const out = sink();
  const code = await CLI.main(['send', '--to', 'codex', 'which run?'], env(dir, server), { log: out.log });
  assert.equal(code, 1);
  assert.equal(server.requests.length, 0);
  assert.match(out.text(), /cc-mine-11111111/);
  assert.match(out.text(), /cc-theirs-22222222/);
  assert.match(out.text(), /handoff --run/);
});

test('handoff --run: names the run even while two are live, and a subagent sub-run is not a rival', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  const now = Date.now();
  seedMarker(dir, `${RUN_ID}-sub-ab12cd34`, now - 2_000);
  seedMarker(dir, RUN_ID, now);
  assert.equal(await CLI.main(['send', '--to', 'codex', 'parent'], env(dir, server), { log: sink().log }), 0);
  assert.equal(server.lastCall('POST', '/v2/control/handoff').body.run_id, RUN_ID,
    'the parent run, never the sub-run: a sub-run id must not reach the wire');

  seedMarker(dir, 'cc-theirs-22222222', now + 1);
  assert.equal(await CLI.main(['--run', RUN_ID, 'send', '--to', 'codex', 'mine'], env(dir, server), { log: sink().log }), 0);
  assert.equal(server.lastCall('POST', '/v2/control/handoff').body.run_id, RUN_ID);
});

test('handoff: refuses to write into the shared "default" run', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const code = await CLI.main(['--run', 'default', 'send', '--to', 'codex', 'poison'], env(makeDataDir(), server), { log: sink().log });
  assert.equal(code, 1);
  assert.equal(server.requests.length, 0);
});

test('handoff: an unconfigured install is told to run /mubit-memory:auth', async (t) => {
  const out = sink();
  const code = await CLI.main(['list'], env(makeDataDir(), null), { log: out.log });
  assert.equal(code, 1);
  assert.match(out.text(), /mubit-memory:auth/);
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

test('handoff --json: the fields a skill reads, and never the key — even on an upstream error', async (t) => {
  const server = await fakeMubit(routes({
    'POST /v2/control/handoff': { status: 500, json: { error: `rejected Authorization: Bearer ${KEY}` } },
  }));
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);

  const ok = sink();
  assert.equal(await CLI.main(['list', '--json'], env(dir, server), { log: ok.log }), 0);
  const listed = JSON.parse(ok.text());
  assert.deepEqual(Object.keys(listed).sort(), ['detail', 'handoffs', 'ok', 'orphans', 'run_id', 'state']);
  assert.equal(listed.run_id, RUN_ID);

  const bad = sink();
  assert.equal(await CLI.main(['send', '--to', 'codex', 'x', '--json'], env(dir, server), { log: bad.log }), 1);
  const failed = JSON.parse(bad.text());
  assert.equal(failed.ok, false);
  assert.ok(!bad.text().includes(KEY), `the key was printed: ${bad.text()}`);
});

test('handoff parseArgs: verbs, flags, and a bare invocation that lists', () => {
  assert.equal(CLI.parseArgs([]).action, 'list');
  assert.equal(CLI.parseArgs(['ls', '--open']).open, true);
  assert.equal(CLI.parseArgs(['answer', 'hnd_1', '--verdict', 'Approve']).verdict, 'approve');
  const a = CLI.parseArgs(['send', '--to', 'codex', '--action', 'Review', 'do', 'the', 'thing']);
  assert.deepEqual([a.action, a.to, a.requestedAction, a.text], ['send', 'codex', 'review', 'do the thing']);
  assert.equal(CLI.parseArgs(['--data-dir', '${CLAUDE_PLUGIN_DATA}']).dataDir, '', 'an unsubstituted flag is dropped');
});
