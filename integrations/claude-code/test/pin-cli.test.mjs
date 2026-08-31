// @ts-check
/**
 * `/mubit-memory:pin` — `bin/pin.src.mjs`, bundled to `bin/pin.mjs`.
 *
 * The surface is a skill plus a script rather than an MCP tool, and not by preference: the
 * vendored server registers twenty-one tools, **none of which touches variables**, and
 * `mcp/dist/server.js` cannot be rebuilt in this checkout. So this follows `auth` and
 * `dashboard` — a `Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/pin.mjs:*)` grant and a small binary.
 *
 * Three properties carry the risk, and most of this file is about them:
 *
 *   1. **A failed write leaves nothing behind locally.** A pin that exists only on this
 *      machine is one the user believes is shared and is not.
 *   2. **The caps are enforced here as well as at render time.** A person is watching, so
 *      being told "that is over the cap" beats discovering later that the sixth pin silently
 *      never rendered.
 *   3. **The run is the one the hooks are using.** A pin written to a run nothing reads is
 *      indistinguishable from a pin that did not work.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fakeMubit, makeDataDir, mod, readJsonFile, runHook, baseEnv } from './helpers/harness.mjs';
import { userPromptSubmit } from './helpers/fixtures.mjs';

const RUN_ID = 'cc-pin-run';
const KEY = 'mbt_test_0123456789abcdef_deadbeefcafebabe0123456789abcdef';

const CLI = await mod('bin/pin.src.mjs');

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

/** Collect what the command printed instead of writing to a terminal. */
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

const pinsPath = (d, runId = RUN_ID) => join(d, 'runs', runId, 'pins.json');

function routes(over = {}) {
  return {
    'POST /v2/control/variables/set': { json: { success: true } },
    'POST /v2/control/variables/delete': { json: { success: true } },
    'POST /v2/control/variables/list': { json: { variables: [] } },
    ...over,
  };
}

/** A `variables/list` reply carrying these pins. */
function listing(pins) {
  return {
    json: {
      variables: pins.map(([slug, text]) => ({
        name: `cc.pin.${slug}`, value_json: JSON.stringify(text),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

test('pin add: writes one namespaced variable and renders on the very next prompt', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);
  const out = sink();

  const code = await CLI.main(['add', "don't touch the vendored server"], env(dir, server), { log: out.log });
  assert.equal(code, 0, out.text());

  const body = server.lastCall('POST', '/v2/control/variables/set').body;
  assert.equal(body.run_id, RUN_ID);
  assert.match(body.name, /^cc\.pin\./,
    'one variable per pin, namespaced — a single blob would lose a concurrent pin silently');
  assert.equal(JSON.parse(body.value_json), "don't touch the vendored server");

  // The write-through. Without it the pin would not render until the next drain refreshed
  // the cache — one or more prompts later — and "I pinned it and nothing happened" is the
  // failure that makes a feature untrustworthy.
  const cached = readJsonFile(pinsPath(dir));
  assert.deepEqual(cached.pins.map((p) => p.text), ["don't touch the vendored server"]);
  assert.equal(cached.run_id, RUN_ID);
});

/**
 * **A failed `variables/set` writes nothing locally.**
 *
 * The tempting shortcut is to write the cache first so the pin renders immediately and let the
 * next drain reconcile. It cannot: a pin that exists only on this machine is one the user
 * believes is shared and is not — they would set it in one terminal, watch it render, and
 * never learn the other terminal never had it. Offline pinning needs a spool; that is a v2.
 */
test('pin add: a failed write leaves no local cache behind', async (t) => {
  const server = await fakeMubit(routes({
    'POST /v2/control/variables/set': { status: 503, json: { error: 'upstream down' } },
  }));
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);
  const out = sink();

  const code = await CLI.main(['add', 'never landed'], env(dir, server), { log: out.log });
  assert.equal(code, 1, 'a failed pin must report a failure');
  assert.equal(safeRead(pinsPath(dir)), null,
    'nothing may claim locally that a pin exists on the instance');
  assert.match(out.text(), /could not|failed|down/i, 'the user has to be told');
});

test('pin add: the same slug replaces rather than duplicates', async (t) => {
  const server = await fakeMubit(routes({
    'POST /v2/control/variables/list': listing([['vendored', 'the old wording']]),
  }));
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);

  const code = await CLI.main(['add', '--name', 'vendored', 'the new wording'],
    env(dir, server), { log: sink().log });
  assert.equal(code, 0);
  assert.equal(server.lastCall('POST', '/v2/control/variables/set').body.name, 'cc.pin.vendored');

  const texts = readJsonFile(pinsPath(dir)).pins.map((p) => p.text);
  assert.deepEqual(texts, ['the new wording'], 'a replaced pin is one pin, not two');
});

// ---------------------------------------------------------------------------
// The caps, at write time
// ---------------------------------------------------------------------------

/**
 * Refused rather than silently dropped. `lib/pins.mjs` also refuses to *render* past the caps,
 * because another client can write anything at all under `cc.pin.` — but that path has nobody
 * to tell. Here there is a person watching, and telling them is most of the value.
 */
test('pin add: the sixth pin is refused, by name, without dialling a set', async (t) => {
  const P = await import(`../lib/pins.mjs?fresh=${Date.now()}`);
  const server = await fakeMubit(routes({
    'POST /v2/control/variables/list': listing(
      Array.from({ length: P.MAX_PINS }, (_, i) => [`p${i}`, `constraint ${i}`])),
  }));
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);
  const out = sink();

  const code = await CLI.main(['add', 'one too many'], env(dir, server), { log: out.log });
  assert.equal(code, 1);
  server.assertNotCalled('POST', '/v2/control/variables/set');
  assert.match(out.text(), new RegExp(String(P.MAX_PINS)),
    'the message has to name the cap, or it reads as an arbitrary refusal');
  assert.match(out.text(), /clear/i, 'and say what to do about it');
});

test('pin add: an overlong pin is refused rather than quietly truncated', async (t) => {
  const P = await import(`../lib/pins.mjs?fresh=${Date.now()}`);
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);
  const out = sink();

  const code = await CLI.main(['add', 'x'.repeat(P.MAX_PIN_CHARS + 1)], env(dir, server), { log: out.log });
  assert.equal(code, 1);
  server.assertNotCalled('POST', '/v2/control/variables/set');
  assert.match(out.text(), new RegExp(String(P.MAX_PIN_CHARS)),
    'truncating changes the user\'s words behind their back; refusing does not');
});

test('pin add: an empty pin is refused before anything is dialled', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);

  assert.equal(await CLI.main(['add', '   '], env(dir, server), { log: sink().log }), 1);
  assert.equal(server.requests.length, 0, `saw: ${server.summary()}`);
});

// ---------------------------------------------------------------------------
// list and clear
// ---------------------------------------------------------------------------

test('pin list: reports what the instance holds, and refreshes the cache with it', async (t) => {
  const server = await fakeMubit(routes({
    'POST /v2/control/variables/list': listing([
      ['vendored', 'no vendored server edits'],
      ['twin', 'ship the codex twin'],
    ]),
  }));
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);
  const out = sink();

  assert.equal(await CLI.main(['list'], env(dir, server), { log: out.log }), 0);
  assert.match(out.text(), /no vendored server edits/);
  assert.match(out.text(), /vendored/, 'the slug is what `pin clear` takes, so it has to be shown');
  assert.deepEqual(readJsonFile(pinsPath(dir)).pins.map((p) => p.slug), ['vendored', 'twin']);
});

test('pin list: an empty run says so rather than printing nothing', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);
  const out = sink();

  assert.equal(await CLI.main(['list'], env(dir, server), { log: out.log }), 0,
    'no pins is a normal state, not a failure');
  assert.match(out.text(), /no pins|nothing pinned/i);
});

test('pin clear: deletes one by slug and drops it from the cache', async (t) => {
  const server = await fakeMubit(routes({
    'POST /v2/control/variables/list': listing([
      ['vendored', 'no vendored server edits'],
      ['twin', 'ship the codex twin'],
    ]),
  }));
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);

  assert.equal(await CLI.main(['clear', 'vendored'], env(dir, server), { log: sink().log }), 0);
  assert.equal(server.lastCall('POST', '/v2/control/variables/delete').body.name, 'cc.pin.vendored');
  assert.deepEqual(readJsonFile(pinsPath(dir)).pins.map((p) => p.slug), ['twin']);
});

test('pin clear --all: deletes every pin in the namespace and nothing else', async (t) => {
  const server = await fakeMubit(routes({
    'POST /v2/control/variables/list': {
      json: {
        variables: [
          { name: 'cc.pin.a', value_json: '"one"' },
          { name: 'cc.pin.b', value_json: '"two"' },
          { name: 'codaph.run_state', value_json: '{"step":3}' },
        ],
      },
    },
  }));
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);

  assert.equal(await CLI.main(['clear', '--all'], env(dir, server), { log: sink().log }), 0);
  const deleted = server.calls('POST', '/v2/control/variables/delete').map((c) => c.body.name);
  assert.deepEqual(deleted.sort(), ['cc.pin.a', 'cc.pin.b'],
    'another client\'s state in the same run is not ours to delete');
  assert.deepEqual(readJsonFile(pinsPath(dir)).pins, []);
});

test('pin clear: a slug that is not pinned says so instead of reporting success', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);
  const out = sink();

  assert.equal(await CLI.main(['clear', 'nosuch'], env(dir, server), { log: out.log }), 1);
  assert.match(out.text(), /nosuch/);
});

// ---------------------------------------------------------------------------
// Which run
// ---------------------------------------------------------------------------

/**
 * The CLI adopts the run the hooks are already using, read off the newest marker in
 * `status/`, rather than re-deriving it.
 *
 * Re-deriving would mean a second copy of `lib/runid.mjs`'s rules living in a binary — and a
 * copy that drifted by one character would write pins to a run nothing reads, which looks
 * exactly like a pin that did not work. Observing beats re-deriving, and this test is what
 * makes it true: the hook writes the marker, and the CLI lands on the same run.
 */
test('pin: lands on the run the hook is using, without re-deriving it', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();

  // A real prompt-recall run, with the plugin's own run-id rules, in a fresh data dir.
  const hookEnv = baseEnv({ dataDir: dir, endpoint: server.url, extra: { MUBIT_CC_ENV_TAGS: 'ci:test' } });
  await runHook('prompt-recall', userPromptSubmit(), { env: hookEnv });

  server.reset();
  assert.equal(await CLI.main(['add', 'pinned by hand'], env(dir, server), { log: sink().log }), 0);

  const runId = server.lastCall('POST', '/v2/control/variables/set').body.run_id;
  assert.match(runId, /^cc-/);
  assert.notEqual(runId, 'default');

  // And the hook renders it on the next prompt — the whole loop, end to end.
  const r = await runHook('prompt-recall', userPromptSubmit({ prompt_id: 'p_after' }), { env: hookEnv });
  assert.equal(r.code, 0);
  assert.ok(r.json?.hookSpecificOutput?.additionalContext?.includes('pinned by hand'),
    'the pin was written to a run the hook does not read');
});

test('pin --run: an explicit run id wins over the marker', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);

  assert.equal(await CLI.main(['--run', 'cc-elsewhere', 'add', 'over there'],
    env(dir, server), { log: sink().log }), 0);
  assert.equal(server.lastCall('POST', '/v2/control/variables/set').body.run_id, 'cc-elsewhere');
});

test('pin: with no run to be found it says what to do, and dials nothing', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const out = sink();

  const code = await CLI.main(['add', 'nowhere to put it'], env(makeDataDir(), server), { log: out.log });
  assert.equal(code, 1);
  assert.equal(server.requests.length, 0, `saw: ${server.summary()}`);
  assert.match(out.text(), /--run/, 'the escape hatch has to be in the message that needs it');
});

// A machine runs one plugin data directory for every session at once, so "the newest marker"
// stops meaning "this session" the moment a second session is answering a prompt. Guessing
// there writes the pin to somebody else's run and reports success for it.
test('pin: two live runs are refused by name rather than guessed between', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  const now = Date.now();
  seedMarker(dir, 'cc-mine-11111111', now - 64_000);
  seedMarker(dir, 'cc-theirs-22222222', now);
  const out = sink();

  const code = await CLI.main(['add', 'no new dependencies'], env(dir, server), { log: out.log });
  assert.equal(code, 1);
  assert.equal(server.requests.length, 0, `saw: ${server.summary()}`);
  assert.match(out.text(), /cc-mine-11111111/, 'the caller has to be told which runs it is between');
  assert.match(out.text(), /cc-theirs-22222222/);
  assert.match(out.text(), /--run/, 'the escape hatch has to be in the message that needs it');
});

test('pin --run: names the run even while two are live', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  const now = Date.now();
  seedMarker(dir, 'cc-mine-11111111', now - 64_000);
  seedMarker(dir, 'cc-theirs-22222222', now);

  assert.equal(await CLI.main(['--run', 'cc-mine-11111111', 'add', 'mine'],
    env(dir, server), { log: sink().log }), 0);
  assert.equal(server.lastCall('POST', '/v2/control/variables/set').body.run_id, 'cc-mine-11111111');
});

// §4.3: a `/clear` leaves the pre-clear marker on disk beside `-c1`, and a subagent writes
// `-sub-<short>`. Both name the session that is already the answer. Reading either as a second
// session would make pinning refuse for the rest of any run that had ever been cleared.
test('pin: a /clear successor is the same session, not a rival', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  const now = Date.now();
  seedMarker(dir, RUN_ID, now - 2_000);
  seedMarker(dir, `${RUN_ID}-c1`, now);

  assert.equal(await CLI.main(['add', 'after the clear'], env(dir, server), { log: sink().log }), 0);
  assert.equal(server.lastCall('POST', '/v2/control/variables/set').body.run_id, `${RUN_ID}-c1`);
});

test('pin: a subagent sub-run is the same session, not a rival', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  const now = Date.now();
  seedMarker(dir, `${RUN_ID}-sub-ab12cd34`, now - 2_000);
  seedMarker(dir, RUN_ID, now);

  assert.equal(await CLI.main(['add', 'parent still'], env(dir, server), { log: sink().log }), 0);
  assert.equal(server.lastCall('POST', '/v2/control/variables/set').body.run_id, RUN_ID);
});

test('pin: a run left behind earlier today is not a rival', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  const now = Date.now();
  seedMarker(dir, 'cc-thismorning-99999999', now - 3 * 60 * 60 * 1000);
  seedMarker(dir, RUN_ID, now);

  assert.equal(await CLI.main(['add', 'only one live'], env(dir, server), { log: sink().log }), 0);
  assert.equal(server.lastCall('POST', '/v2/control/variables/set').body.run_id, RUN_ID);
});

// §4.3 / F21 again, from the surface a person types at.
test('pin: refuses to write into the shared "default" run', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());

  const code = await CLI.main(['--run', 'default', 'add', 'poison'],
    env(makeDataDir(), server), { log: sink().log });
  assert.equal(code, 1);
  assert.equal(server.requests.length, 0, `saw: ${server.summary()}`);
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

test('pin --json: one JSON object per run, with the fields a skill reads', async (t) => {
  const server = await fakeMubit(routes());
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);
  const out = sink();

  assert.equal(await CLI.main(['add', 'machine readable', '--json'], env(dir, server), { log: out.log }), 0);
  const payload = JSON.parse(out.text());
  assert.equal(payload.ok, true);
  assert.equal(payload.run_id, RUN_ID);
  assert.ok(Array.isArray(payload.pins));
  assert.equal(payload.pins.at(-1).text, 'machine readable');
});

// The command prints an upstream error verbatim so the user can act on it. `lib/http.mjs`
// puts a snippet of the response body into that string, and a verbose 4xx can quote the
// request that produced it.
test('pin: an upstream error never reaches the terminal carrying the API key', async (t) => {
  const server = await fakeMubit(routes({
    'POST /v2/control/variables/set': {
      status: 500, json: { error: `rejected Authorization: Bearer ${KEY}` },
    },
  }));
  t.after(() => server.close());
  const dir = makeDataDir();
  seedMarker(dir);
  const out = sink();

  await CLI.main(['add', 'whatever'], env(dir, server), { log: out.log });
  assert.ok(!out.text().includes(KEY), `the key was printed: ${out.text()}`);
});

// An unconfigured install has nothing to pin to. Saying so beats a connect error.
test('pin: an unconfigured install is told to run /mubit-memory:auth', async (t) => {
  const dir = makeDataDir();
  seedMarker(dir);
  const out = sink();

  const code = await CLI.main(['add', 'x'], env(dir, null), { log: out.log });
  assert.equal(code, 1);
  assert.match(out.text(), /auth|endpoint/i);
});

/** `readJson` without the harness's throw-on-missing. */
function safeRead(p) {
  try { return readJsonFile(p); } catch { return null; }
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

/**
 * A pin that begins with a dash is a pin, not a flag. `pin add "--force is banned while we
 * finish this"` arrives as a single argv element, and a blanket "drop anything starting with
 * --" filter would swallow the user's first word and pin a subtly different constraint.
 */
test('pin parseArgs: an unknown --token is text, and the known flags are not', () => {
  const a = CLI.parseArgs(['add', '--force is banned while we finish this']);
  assert.equal(a.action, 'add');
  assert.equal(a.text, '--force is banned while we finish this');

  const b = CLI.parseArgs(['--run', 'cc-x', 'add', 'hello there', '--json', '--name', 'greeting']);
  assert.deepEqual(
    [b.action, b.text, b.runId, b.slug, b.json],
    ['add', 'hello there', 'cc-x', 'greeting', true]);

  // A bare invocation lists rather than writes: a model guessing at the interface should not
  // be able to pin something by accident.
  assert.equal(CLI.parseArgs([]).action, 'list');
  assert.equal(CLI.parseArgs(['a standing constraint']).action, 'add');
});

// The slug is what `pin clear` takes, so it has to be typeable. An apostrophe splitting a word
// leaves an orphaned letter that eats one of the four words meant to identify the pin.
test('pin slugify: produces a handle a person can type back', () => {
  assert.equal(CLI.slugify("don't touch the vendored server"), 'dont-touch-the-vendored');
  assert.equal(CLI.slugify('  Stay on 0.10!  '), 'stay-on-10');
  assert.equal(CLI.slugify('!!!'), '');
});

// ---------------------------------------------------------------------------
// The entry-point guard — §11.1
// ---------------------------------------------------------------------------

// The reported defect: `pin.mjs list --json` printed nothing and exited 0. Node's loader
// resolves symlinks in `import.meta.url` but `process.argv[1]` keeps them, so a plugin behind
// a symlinked cache path (`~/.codex/plugins/cache/mubit/...`) failed the guard, `main()` never
// ran, and the caller got a successful exit with no output and no error to explain it.
test('every bin/ script runs main() when reached through a symlinked path', async () => {
  const { spawnSync } = await import('node:child_process');
  const { symlinkSync } = await import('node:fs');
  const { PLUGIN_ROOT, tempDir } = await import('./helpers/harness.mjs');

  const link = join(tempDir('mubit-symlink-'), 'plugin');
  symlinkSync(PLUGIN_ROOT, link);

  const r = spawnSync(process.execPath, [join(link, 'bin', 'pin.mjs'), 'list', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, MUBIT_CC_DATA_DIR: makeDataDir(), MUBIT_CC_LOG_LEVEL: 'error' },
  });

  assert.notEqual(r.stdout.trim(), '', 'exit 0 with no output at all is the defect');
  assert.doesNotThrow(() => JSON.parse(r.stdout), `not JSON: ${r.stdout}`);
});

// The other half of the guard, and the reason it exists: the tests above import this module
// and drive main() with injected dependencies, so importing it must still do nothing.
test('importing a bin/ script does not run main()', async () => {
  const { spawnSync } = await import('node:child_process');
  const { PLUGIN_ROOT } = await import('./helpers/harness.mjs');
  const url = new URL(`file://${join(PLUGIN_ROOT, 'bin', 'pin.mjs')}`).href;

  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(url)}); console.log('IMPORTED');`], {
    encoding: 'utf8',
    env: { ...process.env, MUBIT_CC_LOG_LEVEL: 'error' },
  });

  assert.equal(r.stdout.trim(), 'IMPORTED', 'an import must produce no command output');
});
