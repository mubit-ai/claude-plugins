// @ts-check
/**
 * The committed `bin/handoff.mjs` — what the Codex `handoff` skill actually runs.
 *
 * The behaviour lives in the sibling's `bin/handoff.src.mjs` and `lib/handoff.mjs`, and every
 * verb is tested there in-process. What that cannot prove is this artifact under this host:
 * the skill runs `node <plugin-root>/bin/handoff.mjs` from a shell that carries no plugin
 * environment, so the bundle has to know on its own that it is Codex — or every note it
 * files says it came from a Claude Code session, and the receiving agent, the `list` join
 * and anything upstream counting distinct actors all read the wrong sender.
 *
 * The first test is the one this file was written for. The hook bundles go through
 * `lib/boot.mjs`; the command-line bundles, until this suite, did not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeMubit, makeDataDir } from './helpers/codex-fixtures.mjs';
import { KEY, assertInertOnImport, cliEnv, runBundle, seedMarker } from './helpers/codex-cli.mjs';

const RUN_ID = 'codex-handoff-run';

function routes(over = {}) {
  return {
    'POST /v2/control/handoff': { json: { success: true, handoff_id: 'hnd_01' } },
    'POST /v2/control/feedback': { json: { success: true, feedback_id: 'fb_01' } },
    'POST /v2/control/activity': { json: { entries: [], next_page_token: '', total_visible: 0 } },
    ...over,
  };
}

/** A fake instance and a data dir with this run's marker in it. */
async function harness(t, over = {}) {
  const server = await fakeMubit(routes(over));
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedMarker(dataDir, RUN_ID);
  return { server, dataDir, env: cliEnv({ dataDir, endpoint: server.url }) };
}

test('the bundle exists and stays inert on import', async () => {
  await assertInertOnImport('handoff');
});

// ---------------------------------------------------------------------------
// The sender — the reason this suite exists
// ---------------------------------------------------------------------------

test('send: the bundle knows it is Codex with no host in its environment', async (t) => {
  const { server, env } = await harness(t);

  const r = await runBundle('handoff', ['send', '--to', 'claude-code', 'look at the auth diff', '--json'], env);
  assert.equal(r.code, 0, r.out + r.err);

  const body = server.lastCall('POST', '/v2/control/handoff').body;
  // § `lib/runid.mjs` defaults the agent role to `claude-code` unless `MUBIT_CC_HOST=codex`
  //   is set before it loads. The hook bundles set it through `lib/boot.mjs`; a bin bundle
  //   built straight from the shared source has no shim, so a Codex user's handoff says it
  //   came from a Claude Code session. Nothing downstream can tell the difference.
  assert.equal(body.from_agent_id, 'codex',
    'the sender role must be `codex`: this bundle exists nowhere but the Codex plugin, and '
    + 'the skill that runs it cannot set MUBIT_CC_HOST for it.');
  assert.equal(body.to_agent_id, 'claude-code');
  assert.equal(body.run_id, RUN_ID);
  assert.equal(body.content, 'look at the auth diff');
  assert.ok(!r.out.includes(KEY), `the key reached stdout: ${r.out}`);
});

test('send: the default action is continue, the minted id is printed, and --json never carries the key', async (t) => {
  const { server, env } = await harness(t);
  const plain = await runBundle('handoff', ['send', '--to', 'claude-code', 'carry on from here'], env);
  assert.equal(plain.code, 0, plain.out + plain.err);
  assert.equal(server.lastCall('POST', '/v2/control/handoff').body.requested_action, 'continue');
  assert.match(plain.out, /hnd_01/, 'the id is what feedback names, so it has to be printed');

  const json = await runBundle('handoff', ['send', '--to', 'claude-code', '--action', 'review', '--task', 'T-7', 'x', '--json'], env);
  assert.equal(json.code, 0, json.err);
  const payload = JSON.parse(json.out);
  assert.equal(payload.ok, true);
  assert.equal(server.lastCall('POST', '/v2/control/handoff').body.task_id, 'T-7');
  assert.ok(!json.out.includes(KEY), `the key reached stdout: ${json.out}`);
});

// ---------------------------------------------------------------------------
// list — the join
// ---------------------------------------------------------------------------

/** An `/activity` entry as the server writes a handoff created through the route. */
const handoffEntry = (id, over = {}) => ({
  id, created_at: '2026-09-07T10:00:00Z', entry_type: 'handoff', run_id: RUN_ID,
  content: over.content ?? `note ${id}`, source: over.from ?? 'codex',
  metadata_json: JSON.stringify({
    entry_type: 'handoff', task_id: `task-${id}`, from_agent_id: over.from ?? 'codex',
    to_agent_id: over.to ?? 'claude-code', requested_action: over.action ?? 'review',
    created_at: '2026-09-07T10:00:00Z', active: true,
  }),
});

/** …and a Codex subagent's note, which arrived through ingest with the same keys. */
const subagentEntry = (id) => ({
  id, created_at: '2026-09-07T10:01:00Z', entry_type: 'handoff', run_id: RUN_ID,
  content: 'Q: find the call sites\n\nA: three call sites in src/service/lib.rs.', source: 'agent',
  metadata_json: JSON.stringify({
    hook_event: 'SubagentStop', agent_id: '01a02413-16ff-75b3-a2c0-b3e93f9cfa63',
    mubit_agent_id: 'codex-sub-01a0241316ff', from_agent_id: 'codex-sub-01a0241316ff', to_agent_id: 'codex',
    requested_action: 'review', task_id: 'prompt-1', active: true,
  }),
});

const feedbackEntry = (id, handoffId, verdict = 'approve', comments = '') => ({
  id, created_at: '2026-09-07T10:05:00Z', entry_type: 'feedback', run_id: RUN_ID,
  content: comments || `Feedback: ${verdict} (${handoffId})`, source: 'claude-code',
  metadata_json: JSON.stringify({ entry_type: 'feedback', handoff_id: handoffId, verdict, from_agent_id: 'claude-code' }),
});

const activity = (entries) => ({ json: { entries, next_page_token: '', total_visible: entries.length } });

test('list: joins feedback to handoffs client-side, and open means unanswered', async (t) => {
  const { server, env } = await harness(t, {
    'POST /v2/control/activity': activity([
      feedbackEntry('fb_1', 'hnd_a', 'approve', 'looks right'),
      subagentEntry('hnd_sub'),
      handoffEntry('hnd_a'),
      handoffEntry('hnd_b', { action: 'execute' }),
    ]),
  });
  const r = await runBundle('handoff', ['list', '--json'], env);
  assert.equal(r.code, 0, r.out + r.err);
  const body = server.lastCall('POST', '/v2/control/activity').body;
  assert.equal(body.run_id, RUN_ID, 'a listing is scoped to the run — there is no cross-run handoff');
  assert.deepEqual([...body.entry_types].sort(), ['feedback', 'handoff']);

  const payload = JSON.parse(r.out);
  const byId = Object.fromEntries(payload.handoffs.map((h) => [h.id, h]));
  assert.deepEqual(Object.keys(byId).sort(), ['hnd_a', 'hnd_b', 'hnd_sub']);
  // § The instance never flips `active`; "open" is "no feedback names this id", computed here.
  assert.equal(byId.hnd_a.open, false, 'fb_1 names it');
  assert.deepEqual(byId.hnd_a.feedback.map((f) => [f.id, f.verdict, f.from]), [['fb_1', 'approve', 'claude-code']]);
  assert.equal(byId.hnd_b.open, true);
  // The subagent's note, filed by `capture --subagent` under this host's role, reads alike.
  assert.equal(byId.hnd_sub.open, true);
  assert.equal(byId.hnd_sub.from, 'codex-sub-01a0241316ff');
  assert.equal(byId.hnd_sub.to, 'codex');

  const open = await runBundle('handoff', ['list', '--open'], env);
  assert.equal(open.code, 0, open.err);
  assert.match(open.out, /2 open handoff/);
  assert.ok(!open.out.includes('hnd_a'), 'an answered handoff is not open');
});

// ---------------------------------------------------------------------------
// feedback
// ---------------------------------------------------------------------------

test('feedback: posts the verdict against the id, from this host`s role', async (t) => {
  const { server, env } = await harness(t);
  const r = await runBundle('handoff', ['feedback', 'hnd_a', '--verdict', 'request_changes', '--comments', 'the test is missing'], env);
  assert.equal(r.code, 0, r.out + r.err);
  const body = server.lastCall('POST', '/v2/control/feedback').body;
  assert.equal(body.run_id, RUN_ID);
  assert.equal(body.handoff_id, 'hnd_a');
  assert.equal(body.verdict, 'request_changes');
  assert.equal(body.comments, 'the test is missing');
  assert.equal(body.from_agent_id, 'codex', 'the answer is signed by this host too');
  assert.match(r.out, /fb_01/);
});

// ---------------------------------------------------------------------------
// The run, and the store
// ---------------------------------------------------------------------------

test('default, an empty store and an unconfigured install are each refused by name, before dialling', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());

  const poison = await runBundle('handoff', ['--run', 'default', 'send', '--to', 'claude-code', 'poison', '--json'], cliEnv({ dataDir: makeDataDir(), endpoint: server.url }));
  assert.equal(poison.code, 1);
  assert.equal(JSON.parse(poison.out).state, 'poisoned_run');

  const empty = await runBundle('handoff', ['send', '--to', 'claude-code', 'nowhere', '--json'], cliEnv({ dataDir: makeDataDir(), endpoint: server.url }));
  assert.equal(empty.code, 1);
  assert.equal(JSON.parse(empty.out).state, 'no_run');
  assert.match(JSON.parse(empty.out).detail, /--run/);

  const bare = await runBundle('handoff', ['list', '--json'], cliEnv({ dataDir: makeDataDir(), endpoint: null }));
  assert.equal(bare.code, 1);
  assert.equal(JSON.parse(bare.out).state, 'unconfigured');
  assert.match(JSON.parse(bare.out).detail, /mubit-memory:auth/);

  assert.equal(server.requests.length, 0, `saw: ${server.summary()}`);
});
