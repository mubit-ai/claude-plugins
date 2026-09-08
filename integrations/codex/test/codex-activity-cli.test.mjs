// @ts-check
/**
 * The committed `bin/activity.mjs` — what the Codex `activity` skill actually runs.
 *
 * The surface is tested in-process next door (`activity-cli.test.mjs`). This file spawns the
 * artifact the skill names, with the environment a skill-run command has — none — and pins
 * the properties a person relies on when they ask what their instance holds: rows on stdout
 * and the summary on stderr so the output pipes; `--jsonl` one object per line; an export
 * that owns stdout byte for byte and writes no file unless asked; the run picked from the
 * hooks' marker and `--run` over it; and never the key, whatever the instance answers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';

import { fakeMubit, makeDataDir } from './helpers/codex-fixtures.mjs';
import { KEY, assertInertOnImport, cliEnv, runBundle, seedMarker } from './helpers/codex-cli.mjs';

const RUN_ID = 'codex-activity-run';
const LIST_ROUTE = 'POST /v2/control/activity';
const EXPORT_ROUTE = 'POST /v2/control/activity/export';

function entry(over = {}) {
  return {
    id: 'a3c1f0de-0000-4000-8000-000000000001', run_id: RUN_ID, entry_type: 'trace',
    content: 'ran the migration', created_at: '2026-08-19T15:03:18Z', metadata_json: '{}', reference_id: 'ref_1',
    ...over,
  };
}
const page = (entries) => ({ json: { entries, next_page_token: '', total_visible: entries.length } });

async function harness(t, routes = {}) {
  const server = await fakeMubit(routes);
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedMarker(dataDir, RUN_ID);
  return { server, dataDir, env: cliEnv({ dataDir, endpoint: server.url }) };
}

test('the bundle exists and stays inert on import', async () => {
  await assertInertOnImport('activity');
});

test('--help exits 0 and dials nothing; an unknown flag exits 2 and dials nothing', async (t) => {
  const { server, env } = await harness(t, { [LIST_ROUTE]: page([]) });
  const help = await runBundle('activity', ['--help'], env);
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /--out/);
  assert.match(help.out, /--export/);

  const bad = await runBundle('activity', ['--exclude-derive'], env);
  // § A typo in a flag is the one input where guessing is worse than refusing: `--exclude-derive`
  //   silently ignored produces an export that claims to be filtered and is not.
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown|missing|usage/i);
  assert.equal(server.requests.length, 0, `saw: ${server.summary()}`);
});

test('a listing: rows to stdout, the summary and run to stderr, scoped to the marker`s run', async (t) => {
  const { server, env } = await harness(t, { [LIST_ROUTE]: page([entry(), entry({ id: 'b', content: 'second' })]) });
  const r = await runBundle('activity', [], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /ran the migration/);
  assert.match(r.out, /second/);
  assert.match(r.err, new RegExp(RUN_ID), 'the summary names the run so the rows can be checked against it');
  assert.equal(server.lastCall('POST', '/v2/control/activity').body.run_id, RUN_ID);
});

test('--jsonl: one parseable object per entry and nothing else on stdout', async (t) => {
  const { env } = await harness(t, { [LIST_ROUTE]: page([entry(), entry({ id: 'b' })]) });
  const r = await runBundle('activity', ['--jsonl'], env);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.deepEqual(Object.keys(JSON.parse(line)), ['id', 'created_at', 'entry_type', 'run_id', 'content']);
  }
});

test('--export owns stdout byte for byte and writes no file', async (t) => {
  const { server, dataDir, env } = await harness(t, {
    [EXPORT_ROUTE]: { json: { format: 'jsonl', content: '{"id":"a"}\n{"id":"b"}', entry_count: 2 } },
  });
  const before = readdirSync(dataDir).sort();
  const r = await runBundle('activity', ['--export'], env);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '{"id":"a"}\n{"id":"b"}', 'the payload is stdout, so it pipes');
  assert.match(r.err, /2 entries/, 'the summary stays on stderr');
  assert.equal(server.lastCall('POST', '/v2/control/activity/export').body.run_id, RUN_ID);
  // § Nothing new on disk: a file is the one irreversible thing this command can do, and it
  //   does it only on `--out`.
  const after = readdirSync(dataDir).sort();
  assert.deepEqual(after.filter((n) => !before.includes(n) && /\.jsonl$/.test(n)), []);
});

test('--json never prints the key, on success or on failure, and the removal is visible', async (t) => {
  const { env } = await harness(t, {
    [LIST_ROUTE]: (req) => ({ status: 400, json: { error: `rejected ${req.headers.authorization}` } }),
  });
  const r = await runBundle('activity', ['--json'], env);
  const all = r.out + r.err;
  assert.ok(!all.includes(KEY), `the key reached the output:\n${all}`);
  assert.match(all, /REDACTED/);
});

test('--run wins over the marker, and an empty store refuses rather than listing the instance', async (t) => {
  const { server, env } = await harness(t, { [LIST_ROUTE]: page([]) });
  assert.equal((await runBundle('activity', ['--run', 'cc-named-run'], env)).code, 0);
  assert.equal(server.lastCall('POST', '/v2/control/activity').body.run_id, 'cc-named-run');

  const empty = await runBundle('activity', [], cliEnv({ dataDir: makeDataDir(), endpoint: server.url }));
  assert.equal(empty.code, 1);
  assert.match(empty.err, /run/i);
  assert.equal(server.countOf('POST', '/v2/control/activity'), 1, 'the empty store dialled nothing');
});

test('an unconfigured install is refused before dialling', async (t) => {
  const dataDir = makeDataDir();
  seedMarker(dataDir, RUN_ID);
  const r = await runBundle('activity', [], cliEnv({ dataDir, endpoint: null }));
  assert.equal(r.code, 1);
  assert.match(r.err, /endpoint|configured|auth/i);
  assert.ok(!existsSync(`${dataDir}/activity.jsonl`));
});
