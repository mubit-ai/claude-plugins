// @ts-check
/**
 * The committed `bin/admin.mjs` — the four administrative verbs, as the Codex skills run them.
 *
 * `lessons`, `checkpoint`, `strategies` and `reflect` left the MCP surface so they cost
 * nothing until asked for; the skills that ask run this bundle. The verbs are tested in-process
 * next door. This file spawns the artifact with a skill's environment and pins that it speaks
 * the routes the hooks speak — the census through `/activity` and never the lessons route, a
 * checkpoint verbatim under the run, the SessionEnd reflect body — exits 2 on a bad
 * invocation without dialling, resolves the run from the marker or `--run`, and never prints
 * the key.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fakeMubit, makeDataDir, tempDir } from './helpers/codex-fixtures.mjs';
import { KEY, assertInertOnImport, cliEnv, runBundle, seedMarker } from './helpers/codex-cli.mjs';

const RUN_ID = 'codex-admin-run';
const LIST_ROUTE = 'POST /v2/control/activity';

function lesson(o) {
  return {
    id: o.id, created_at: o.at ?? '2026-08-01T00:00:00Z', entry_type: 'lesson', run_id: o.run ?? RUN_ID,
    content: o.content, source: `reflection:${o.run ?? RUN_ID}`,
    metadata_json: JSON.stringify({ scope: o.scope ?? 'run', lesson_type: 'rule', importance: o.importance ?? 'medium' }),
  };
}
const page = (entries) => ({ json: { entries, next_page_token: '', total_visible: entries.length } });
const CATALOGUE = [
  lesson({ id: 'les-0001', content: 'Poll the ingest job; the row lands after the queue.', importance: 'high' }),
  lesson({ id: 'les-0002', content: 'A retry against a wedged daemon only queues behind the wedge.', at: '2026-08-02T00:00:00Z' }),
];

async function harness(t, routes = {}) {
  const server = await fakeMubit(routes);
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedMarker(dataDir, RUN_ID);
  return { server, dataDir, env: cliEnv({ dataDir, endpoint: server.url }) };
}

test('the bundle exists and stays inert on import', async () => {
  await assertInertOnImport('admin');
});

test('--help exits 0; a bad invocation exits 2 and dials nothing', async (t) => {
  const { server, env } = await harness(t);
  const help = await runBundle('admin', ['--help'], env);
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /lessons\s+\[--scope/);
  for (const argv of [[], ['nope'], ['lessons', '--nope'], ['checkpoint']]) {
    const r = await runBundle('admin', argv, env);
    assert.equal(r.code, 2, `${argv.join(' ') || '(no args)'} must exit 2`);
    assert.match(r.err, /usage: admin/);
  }
  assert.equal(server.requests.length, 0, `dialled: ${server.summary()}`);
});

test('lessons: the census asks the activity feed, never the lessons route, and renders one line each', async (t) => {
  const { server, env } = await harness(t, { [LIST_ROUTE]: page(CATALOGUE) });
  const r = await runBundle('admin', ['lessons'], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^run_id: codex-admin-run$/m);
  assert.match(r.out, /^Lessons \(2\):$/m, r.out);
  assert.match(r.out, /^- \[rule, high, run\] les-0001 — Poll the ingest job/m);
  // § `POST /v2/control/lessons` filters *after* its limit, so a census through it is
  //   structurally short. The activity feed is the reliable count.
  assert.ok(server.countOf('POST', '/v2/control/activity') >= 1, server.summary());
  assert.equal(server.countOf('POST', '/v2/control/lessons'), 0);

  const raw = await runBundle('admin', ['lessons', '--json'], env);
  assert.equal(raw.code, 0, raw.err);
  assert.match(raw.out, /les-0002/);
  assert.doesNotThrow(() => JSON.parse(raw.out), `--json is not JSON: ${raw.out}`);
});

test('checkpoint: the snapshot goes up verbatim under the run, labelled, from a file', async (t) => {
  const { server, env } = await harness(t);
  const file = join(tempDir('mubit-codex-admin-ckpt-'), 'snap.md');
  const snapshot = '# Where we are\n\nmid-migration on feat/x, three files edited.\n';
  writeFileSync(file, snapshot);

  const r = await runBundle('admin', ['checkpoint', '--label', 'before the rebase', '--file', file], env);
  assert.equal(r.code, 0, r.out + r.err);
  const body = server.lastCall('POST', '/v2/control/checkpoint').body;
  assert.equal(body.run_id, RUN_ID);
  assert.equal(body.label, 'before the rebase');
  assert.equal(body.context_snapshot, snapshot, 'byte for byte');
  assert.equal(JSON.parse(body.metadata_json).source, 'admin');
  assert.match(r.out, /Checkpoint ckpt_test_1 saved for run codex-admin-run/);
});

test('reflect: sends the SessionEnd body for this run and renders the lessons compactly', async (t) => {
  const { server, env } = await harness(t);
  const r = await runBundle('admin', ['reflect'], env);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(server.lastCall('POST', '/v2/control/reflect').body,
    { run_id: RUN_ID, include_linked_runs: false, include_step_outcomes: true, last_n_items: 200 });
  assert.match(r.out, /^summary: ok$/m);
  assert.match(r.out, /^- \[failure, high, run\] les_1 — When X, do Y\.$/m, r.out);
});

test('--json never carries the key, even when the instance echoes the request', async (t) => {
  const { env } = await harness(t, {
    'POST /v2/control/reflect': (req) => ({ status: 500, json: { error: `rejected ${req.headers.authorization}` } }),
  });
  const r = await runBundle('admin', ['reflect', '--json'], env);
  assert.equal(r.code, 1);
  assert.ok(!(r.out + r.err).includes(KEY), `the key reached the output:\n${r.out}${r.err}`);
});

test('the run comes from the marker; --run names it outright; nothing to observe refuses before dialling', async (t) => {
  const { server, env } = await harness(t, { 'POST /v2/control/strategies': { json: { strategies: [] } } });
  assert.equal((await runBundle('admin', ['strategies'], env)).code, 0);
  assert.equal(server.lastCall('POST', '/v2/control/strategies').body.run_id, RUN_ID);

  assert.equal((await runBundle('admin', ['strategies', '--run', 'cc-named-run'], env)).code, 0);
  assert.equal(server.lastCall('POST', '/v2/control/strategies').body.run_id, 'cc-named-run');

  const n = server.requests.length;
  const none = await runBundle('admin', ['reflect'], cliEnv({ dataDir: makeDataDir(), endpoint: server.url }));
  assert.equal(none.code, 1);
  assert.match(none.err, /Could not tell which Mubit run/);
  assert.match(none.err, /admin reflect --run <run_id>/);
  assert.equal(server.requests.length, n, 'nothing was dialled for a run nobody could name');
});

test('an unconfigured install is told to run /mubit-memory:auth, and dials nothing', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedMarker(dataDir, RUN_ID);
  // § The finding this case made on arrival: the bundle exited 1 with `reflect failed: no
  //   reply`, the HTTP layer's refusal to dial an empty endpoint rendered as a dead instance.
  const r = await runBundle('admin', ['reflect'], cliEnv({ dataDir, endpoint: null }));
  assert.equal(r.code, 1);
  assert.match(r.err, /mubit-memory:auth/);
  assert.ok(!r.err.includes('no reply'), r.err);
  assert.equal(server.requests.length, 0);
});
