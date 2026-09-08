// @ts-check
/**
 * The committed `bin/pin.mjs` — what the Codex `pin` skill actually runs.
 *
 * `bin/pin.src.mjs` is tested verb by verb in the sibling suite, in-process. What that leaves
 * unproven is the artifact: that the Codex copy spawns, keeps its entry guard, speaks the
 * `variables/*` routes with the bodies the hooks read back, picks the run the hooks are on,
 * and never prints the key. Until this file the Codex plugin had zero pin coverage beyond a
 * skill that names the binary.
 *
 * A pin carries no agent role — the host-dependent thing this bundle does is resolve the
 * store: with nothing on the command line and nothing in the environment, it has to find the
 * directory setup pinned for the hooks, or `pin add` lands in a store no hook reads.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fakeMubit, makeDataDir, readJsonFile, tempDir } from './helpers/codex-fixtures.mjs';
import { KEY, assertInertOnImport, cliEnv, runBundle, seedMarker } from './helpers/codex-cli.mjs';

const RUN_ID = 'codex-pin-run';

function routes(over = {}) {
  return {
    'POST /v2/control/variables/set': { json: { success: true } },
    'POST /v2/control/variables/delete': { json: { success: true } },
    'POST /v2/control/variables/list': { json: { variables: [] } },
    ...over,
  };
}

function listing(pins) {
  return { json: { variables: pins.map(([slug, text]) => ({ name: `cc.pin.${slug}`, value_json: JSON.stringify(text) })) } };
}

const pinsPath = (dataDir, runId = RUN_ID) => join(dataDir, 'runs', runId, 'pins.json');

async function harness(t, over = {}) {
  const server = await fakeMubit(routes(over));
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedMarker(dataDir, RUN_ID);
  return { server, dataDir, env: cliEnv({ dataDir, endpoint: server.url }) };
}

test('the bundle exists and stays inert on import', async () => {
  await assertInertOnImport('pin');
});

test('add: one namespaced variable on the wire, and a cache the hooks can read on the next prompt', async (t) => {
  const { server, dataDir, env } = await harness(t);
  const r = await runBundle('pin', ['add', "don't touch the vendored server"], env);
  assert.equal(r.code, 0, r.out + r.err);

  const body = server.lastCall('POST', '/v2/control/variables/set').body;
  assert.equal(body.run_id, RUN_ID);
  assert.match(body.name, /^cc\.pin\./, 'one variable per pin, namespaced');
  assert.equal(JSON.parse(body.value_json), "don't touch the vendored server");
  // § The write-through. `readPins` accepts the cache only if its run and endpoint match the
  //   hook's, so a bundle that stamped either differently would pin something no prompt shows.
  const cached = readJsonFile(pinsPath(dataDir));
  assert.equal(cached.run_id, RUN_ID);
  assert.equal(cached.endpoint.replace(/\/+$/, ''), server.url);
  assert.deepEqual(cached.pins.map((p) => p.text), ["don't touch the vendored server"]);
});

test('list and clear: what the instance holds, refreshed into the cache, and deleted by slug', async (t) => {
  const { server, dataDir, env } = await harness(t, {
    'POST /v2/control/variables/list': listing([['vendored', 'no vendored server edits'], ['twin', 'ship the codex twin']]),
  });
  const listed = await runBundle('pin', ['list'], env);
  assert.equal(listed.code, 0, listed.err);
  assert.match(listed.out, /no vendored server edits/);
  assert.match(listed.out, /vendored/, 'the slug is what `pin clear` takes');
  assert.deepEqual(readJsonFile(pinsPath(dataDir)).pins.map((p) => p.slug), ['vendored', 'twin']);

  const cleared = await runBundle('pin', ['clear', 'vendored'], env);
  assert.equal(cleared.code, 0, cleared.err);
  assert.equal(server.lastCall('POST', '/v2/control/variables/delete').body.name, 'cc.pin.vendored');
  assert.deepEqual(readJsonFile(pinsPath(dataDir)).pins.map((p) => p.slug), ['twin']);
});

test('a failed write leaves no cache behind', async (t) => {
  const { dataDir, env } = await harness(t, {
    'POST /v2/control/variables/set': { status: 503, json: { error: 'upstream down' } },
  });
  const r = await runBundle('pin', ['add', 'never landed'], env);
  assert.equal(r.code, 1);
  // § A pin that exists only on this machine is one the user believes is shared and is not.
  assert.ok(!existsSync(pinsPath(dataDir)), 'nothing may claim locally that a pin exists on the instance');
  assert.match(r.out + r.err, /could not|failed|down/i);
});

test('--json: the fields a skill reads, and never the key — even on an upstream error', async (t) => {
  const { dataDir, env } = await harness(t);
  const ok = await runBundle('pin', ['add', 'machine readable', '--json'], env);
  assert.equal(ok.code, 0, ok.err);
  const payload = JSON.parse(ok.out);
  assert.equal(payload.ok, true);
  assert.equal(payload.run_id, RUN_ID);
  assert.equal(payload.pins.at(-1).text, 'machine readable');

  const server = await fakeMubit(routes({
    'POST /v2/control/variables/set': { status: 500, json: { error: `rejected Authorization: Bearer ${KEY}` } },
  }));
  t.after(() => server.close());
  const bad = await runBundle('pin', ['add', 'whatever', '--json'], cliEnv({ dataDir, endpoint: server.url }));
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.out).ok, false);
  assert.ok(!(bad.out + bad.err).includes(KEY), `the key was printed: ${bad.out}${bad.err}`);
});

test('the run comes from the marker, and --run wins over it', async (t) => {
  const { server, env } = await harness(t);
  assert.equal((await runBundle('pin', ['add', 'from the marker'], env)).code, 0);
  assert.equal(server.lastCall('POST', '/v2/control/variables/set').body.run_id, RUN_ID);

  assert.equal((await runBundle('pin', ['--run', 'cc-elsewhere', 'add', 'over there'], env)).code, 0);
  assert.equal(server.lastCall('POST', '/v2/control/variables/set').body.run_id, 'cc-elsewhere');
});

test('default and an unconfigured store are refused before anything is dialled', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const poison = await runBundle('pin', ['--run', 'default', 'add', 'poison'], cliEnv({ dataDir: makeDataDir(), endpoint: server.url }));
  assert.equal(poison.code, 1);
  assert.equal(server.requests.length, 0, `saw: ${server.summary()}`);

  const bare = await runBundle('pin', ['list'], cliEnv({ dataDir: makeDataDir(), endpoint: null }));
  assert.equal(bare.code, 1);
  assert.match(bare.out + bare.err, /mubit-memory:auth/);
  assert.equal(server.requests.length, 0);
});

test('with nothing on the command line, the bundle reads the store setup pinned for the hooks', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  // The machine: a pinned store holding the run marker, and a decoy with credentials that
  // the search alone would prefer.
  const home = tempDir('mubit-codex-pin-home-');
  const codexHome = tempDir('mubit-codex-pin-codex-home-');
  const root = join(home, '.claude', 'plugins', 'data');
  const decoy = join(root, 'mubit-memory-mubit');
  mkdirSync(decoy, { recursive: true });
  writeFileSync(join(decoy, 'credentials.json'), JSON.stringify({ endpoint: server.url, apiKey: KEY }));
  const pinned = join(root, 'mubit-memory-inline');
  seedMarker(pinned, RUN_ID);
  writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{
    type: 'command', command: `MUBIT_CC_DATA_DIR=${JSON.stringify(pinned)} node /somewhere/hooks/dist/session-start.mjs`,
  }] }] } }));

  const env = cliEnv({ dataDir: '', endpoint: server.url });
  delete env.MUBIT_CC_DATA_DIR;
  env.HOME = home;
  env.CODEX_HOME = codexHome;
  // § No `--data-dir`, no MUBIT_CC_DATA_DIR: exactly what a skill-run command gets. The
  //   marker lives only in the pinned store, so landing anywhere else is `no_run`.
  const r = await runBundle('pin', ['add', 'found the right store', '--json'], env);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(server.lastCall('POST', '/v2/control/variables/set').body.run_id, RUN_ID);
  assert.ok(existsSync(pinsPath(pinned)), 'the cache landed in the store the hooks read');
  assert.ok(!existsSync(pinsPath(decoy)), 'and not in the one the search would have guessed');
});
