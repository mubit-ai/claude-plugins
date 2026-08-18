// @ts-check
/**
 * `lib/state.mjs`, `lib/markers.mjs`, `lib/log.mjs`.
 *
 * Protects build-guide §4.8 (module API + the exact Marker shape) and §7 (state
 * layout under `${CLAUDE_PLUGIN_DATA}` and its TTL table).
 *
 * These three modules are the plugin's only durable surface: every hook is a
 * short-lived process, so anything that must survive a process boundary goes
 * through here. A partial write, a throwing read, or an unpruned spool is a
 * user-visible defect in a memory layer that is supposed to be invisible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync,
  statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PLUGIN_ROOT, lib, makeDataDir, tempDir, baseEnv, withEnv, readJsonFile,
} from './helpers/harness.mjs';
import * as fx from './helpers/fixtures.mjs';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MIB = 1024 * 1024;

/**
 * A full §4.1 `Config` literal carrying the §6.1 defaults. These modules take a
 * `cfg` and read `dataDir`/`logLevel`/`redact` off it; handing them a complete
 * object keeps a test failure about state, not about a missing field.
 * @param {string} dataDir
 * @param {Record<string, any>} [over]
 */
function mkCfg(dataDir, over = {}) {
  return {
    endpoint: 'https://mubit.example.com', mode: 'hosted', apiKey: '', userId: '',
    runStrategy: 'per-directory', capture: true, recall: true, redact: true,
    recallTokenBudget: 1500, recallBudgetMs: 1500, recallAssemble: 'client',
    outcomeMode: 'implicit', reflectOnEnd: true, statusLine: true,
    mcpTools: [], denyGlobs: [], maxParamBytes: 4096, maxOutputBytes: 8192,
    batchMaxItems: 32, batchMaxAgeMs: 30000,
    breaker: { threshold: 5, windowMs: 300000, cooldownMs: 120000 },
    coldStartGraceMs: 20000, timeoutMs: 4000, logLevel: 'debug',
    dataDir, projectDir: dataDir,
    ...over,
  };
}

/**
 * Run a synchronous call with the data dir pinned in `process.env` too, so the
 * test passes whether the module reads `cfg.dataDir` or resolves from the
 * environment (§4.8 `dataDir()`).
 * @template T
 * @param {string} dir
 * @param {() => T} fn
 * @returns {T}
 */
function inData(dir, fn) {
  return withEnv(baseEnv({ dataDir: dir }), fn);
}

/** @param {string} p @param {number} ageMs */
function setAge(p, ageMs) {
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(p, t, t);
}

/** @param {string} p @param {string} [body] @returns {string} */
function put(p, body = '{"x":1}') {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
}

/** @param {string} p @param {number} ageMs @returns {string} */
function putAged(p, ageMs, body) {
  put(p, body);
  setAge(p, ageMs);
  return p;
}

/** Every file under a directory tree, relative to it. */
function walk(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

// ===========================================================================
// state.mjs — dataDir()
// ===========================================================================

// §4.8: dataDir() resolution order, level 1 — MUBIT_CC_DATA_DIR wins outright.
test('dataDir(): MUBIT_CC_DATA_DIR beats CLAUDE_PLUGIN_DATA', async () => {
  const state = await lib('state.mjs');
  const override = makeDataDir();
  const host = makeDataDir();
  const got = withEnv(
    { ...baseEnv({ dataDir: host }), MUBIT_CC_DATA_DIR: override, CLAUDE_PLUGIN_DATA: host },
    () => state.dataDir({}),
  );
  assert.equal(got, override);
});

// §4.8: resolution order, level 2 — the host's CLAUDE_PLUGIN_DATA.
test('dataDir(): falls back to CLAUDE_PLUGIN_DATA when the override is unset', async () => {
  const state = await lib('state.mjs');
  const host = makeDataDir();
  const got = withEnv(
    { ...baseEnv({ dataDir: host }), MUBIT_CC_DATA_DIR: undefined, CLAUDE_PLUGIN_DATA: host },
    () => state.dataDir({}),
  );
  assert.equal(got, host);
});

// §4.8 + §7: resolution order, level 3 — ~/.claude/plugins/data/mubit-memory.
test('dataDir(): falls back to ~/.claude/plugins/data/mubit-memory', async () => {
  const state = await lib('state.mjs');
  const home = tempDir('mubit-cc-home-');
  const got = withEnv(
    {
      ...baseEnv({ dataDir: home }),
      HOME: home, MUBIT_CC_DATA_DIR: undefined, CLAUDE_PLUGIN_DATA: undefined,
    },
    () => state.dataDir({}),
  );
  assert.equal(got, join(home, '.claude', 'plugins', 'data', 'mubit-memory'));
});

// ===========================================================================
// state.mjs — writeJsonAtomic()
// ===========================================================================

// §4.8: writeJsonAtomic writes `<p>.tmp-<pid>` then renames — nothing is left behind.
test('writeJsonAtomic(): target parses and no .tmp-* sibling survives', async () => {
  const state = await lib('state.mjs');
  const dir = makeDataDir();
  const target = join(dir, 'status', 'cc-x.json');

  inData(dir, () => state.writeJsonAtomic(target, { run_id: 'cc-x', n: 1 }));

  assert.deepEqual(readJsonFile(target), { run_id: 'cc-x', n: 1 });
  const leftovers = readdirSync(join(dir, 'status')).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'a temp file survived the rename');
});

// §4.8/§7: hooks write into `runs/<run_id>/spool/` before anything creates it.
test('writeJsonAtomic(): creates missing parent directories', async () => {
  const state = await lib('state.mjs');
  const dir = makeDataDir();
  const target = join(dir, 'runs', 'cc-fresh-00000000', 'spool', 'item-1.json');
  assert.equal(existsSync(dirname(target)), false, 'precondition: parent must not exist');

  inData(dir, () => state.writeJsonAtomic(target, fx.spoolItem()));

  assert.equal(readJsonFile(target).item_id, fx.spoolItem().item_id);
});

// §4.8: the point of the tmp+rename dance — a concurrent reader (the status line
// runs every frame) must see either the old file or the new one, never a partial.
test('writeJsonAtomic(): a concurrent reader never observes a partial file', async () => {
  const state = await lib('state.mjs'); // red-state guard: fails loudly if unwritten
  assert.equal(typeof state.writeJsonAtomic, 'function');

  const dir = makeDataDir();
  const target = join(dir, 'status', 'cc-big.json');
  put(target, JSON.stringify({ generation: 0 }));

  const stateUrl = pathToFileURL(join(PLUGIN_ROOT, 'lib', 'state.mjs')).href;
  const code =
    `import(${JSON.stringify(stateUrl)})` +
    `.then((m) => m.writeJsonAtomic(${JSON.stringify(target)}, ` +
    `{ generation: 1, blob: 'x'.repeat(4000000) }))` +
    `.catch((e) => { console.error(String(e)); process.exit(1); });`;

  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });

  /** @type {Set<string>} */
  const tmpNamesSeen = new Set();
  let partials = 0;
  let reads = 0;
  let exited = false;
  /** @type {Promise<number|null>} */
  const done = new Promise((res) => child.on('close', (c) => { exited = true; res(c); }));

  while (!exited) {
    for (const f of readdirSync(join(dir, 'status'))) {
      if (f !== 'cc-big.json') tmpNamesSeen.add(f);
    }
    try {
      JSON.parse(readFileSync(target, 'utf8'));
      reads++;
    } catch {
      partials++;
    }
    await new Promise((r) => setImmediate(r));
  }
  const code0 = await done;

  assert.equal(code0, 0, `writer child failed: ${stderr}`);
  assert.ok(reads > 0, 'the poller never managed to read the target');
  assert.equal(partials, 0, `reader saw ${partials} partial/unparseable states of ${target}`);
  // Whatever intermediate names existed must follow the documented `<p>.tmp-<pid>` form.
  for (const name of tmpNamesSeen) {
    assert.match(name, /^cc-big\.json\.tmp-\d+$/, `unexpected intermediate file ${name}`);
  }
  assert.equal(readJsonFile(target).generation, 1);
  assert.deepEqual(
    readdirSync(join(dir, 'status')).filter((f) => f.includes('.tmp')), [],
    'a temp file survived the rename',
  );
});

// ===========================================================================
// state.mjs — readJson()
// ===========================================================================

// §4.8: readJson never throws — every caller is on a hook's critical path.
test('readJson(): returns the fallback for a missing file', async () => {
  const state = await lib('state.mjs');
  const dir = makeDataDir();
  const sentinel = { fallback: true };
  assert.deepEqual(state.readJson(join(dir, 'status', 'nope.json'), sentinel), sentinel);
});

// §4.8 + §12.1/F15: a truncated or corrupt file is normal after a SIGKILL.
test('readJson(): returns the fallback for corrupt and truncated files', async () => {
  const state = await lib('state.mjs');
  const dir = makeDataDir();
  const cases = [
    ['corrupt.json', 'not json at all'],
    ['truncated.json', '{"run_id":"cc-x","recall":{"sources":'],
    ['empty.json', ''],
    ['binary.json', ' '],
  ];
  for (const [name, body] of cases) {
    const p = put(join(dir, 'status', name), body);
    assert.deepEqual(state.readJson(p, { fallback: name }), { fallback: name },
      `${name} must not throw and must yield the fallback`);
  }
});

// §4.8: the documented default fallback is null.
test('readJson(): defaults the fallback to null, and parses valid JSON', async () => {
  const state = await lib('state.mjs');
  const dir = makeDataDir();
  assert.equal(state.readJson(join(dir, 'missing.json')), null);
  const p = put(join(dir, 'sessions', 's.json'), JSON.stringify({ run_id: 'cc-x' }));
  assert.deepEqual(state.readJson(p, null), { run_id: 'cc-x' });
});

// ===========================================================================
// state.mjs — pruneStale()
// ===========================================================================

/**
 * The §7 TTL table, one row per path class. Each row is exercised in two fresh
 * data dirs — one where the file is past its TTL and must vanish, one where it
 * is well inside it and must survive. Two dirs rather than two files because
 * `status/health.json` is a fixed name and cannot have a sibling.
 */
const TTL_ROWS = [
  { what: 'spool item', rel: 'runs/cc-x/spool/item-1.json', ttl: 24 * HOUR },
  { what: 'rejected batch', rel: 'runs/cc-x/spool/rejected/batch-1.json', ttl: 7 * DAY },
  { what: 'staged turn', rel: `runs/cc-x/turns/${fx.PROMPT_ID}.json`, ttl: 6 * HOUR },
  { what: 'session record', rel: `sessions/${fx.SESSION_ID}.json`, ttl: 30 * DAY },
  { what: 'status marker', rel: 'status/cc-x.json', ttl: 12 * HOUR },
  { what: 'cached health', rel: 'status/health.json', ttl: 30 * SEC },
  { what: 'detached payload handoff', rel: 'tmp/0c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f.json', ttl: 1 * HOUR },
];

for (const row of TTL_ROWS) {
  // §7 TTL table: anything past its TTL is swept.
  test(`pruneStale(): drops a stale ${row.what} (TTL ${row.ttl}ms)`, async () => {
    const state = await lib('state.mjs');
    const dir = makeDataDir();
    const p = putAged(join(dir, row.rel), row.ttl + 5 * MIN);
    inData(dir, () => state.pruneStale(mkCfg(dir)));
    assert.equal(existsSync(p), false, `${row.rel} was past its ${row.ttl}ms TTL and should be gone`);
  });

  // §7 TTL table: anything inside its TTL is untouched — pruning must not eat live state.
  test(`pruneStale(): keeps a fresh ${row.what} (TTL ${row.ttl}ms)`, async () => {
    const state = await lib('state.mjs');
    const dir = makeDataDir();
    const p = putAged(join(dir, row.rel), Math.floor(row.ttl / 4));
    inData(dir, () => state.pruneStale(mkCfg(dir)));
    assert.equal(existsSync(p), true, `${row.rel} was inside its ${row.ttl}ms TTL and must survive`);
  });
}

// §7: "Pruning runs at most hourly, gated by an O_EXCL marker at prune.lock."
test('pruneStale(): claims an O_EXCL prune.lock', async () => {
  const state = await lib('state.mjs');
  const dir = makeDataDir();
  inData(dir, () => state.pruneStale(mkCfg(dir)));
  assert.equal(existsSync(join(dir, 'prune.lock')), true,
    'prune must leave the hourly gate marker behind');
});

// §7: at most hourly — a second call in the same hour must not sweep again.
test('pruneStale(): a second call within the hour is a no-op', async () => {
  const state = await lib('state.mjs');
  const dir = makeDataDir();
  inData(dir, () => state.pruneStale(mkCfg(dir)));

  const p = putAged(join(dir, 'runs/cc-x/spool/late.json'), 48 * HOUR);
  inData(dir, () => state.pruneStale(mkCfg(dir)));
  assert.equal(existsSync(p), true,
    'prune ran twice inside one hour; the gate is not holding');
});

// §7: once the gate is older than an hour, the sweep runs again.
test('pruneStale(): runs again once prune.lock is older than an hour', async () => {
  const state = await lib('state.mjs');
  const dir = makeDataDir();
  inData(dir, () => state.pruneStale(mkCfg(dir)));

  const lock = join(dir, 'prune.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() - 2 * HOUR }));
  setAge(lock, 2 * HOUR);

  const p = putAged(join(dir, 'runs/cc-x/spool/late.json'), 48 * HOUR);
  inData(dir, () => state.pruneStale(mkCfg(dir)));
  assert.equal(existsSync(p), false, 'a >1h prune.lock must not block the next sweep');
});

// §7: the sweep is a scalpel — unknown files under DATA are not its business.
test('pruneStale(): leaves files it does not own alone', async () => {
  const state = await lib('state.mjs');
  const dir = makeDataDir();
  const keep = putAged(join(dir, 'config.json'), 10 * SEC);
  const foreign = putAged(join(dir, 'breaker', 'abc123.json'), 10 * SEC);
  inData(dir, () => state.pruneStale(mkCfg(dir)));
  assert.equal(existsSync(keep), true);
  assert.equal(existsSync(foreign), true);
});

// §4.9/§12.1-F14: state helpers never throw, even when DATA is unusable.
test('pruneStale(): does not throw when the data dir does not exist', async () => {
  const state = await lib('state.mjs');
  const dir = tempDir('mubit-cc-gone-');
  rmSync(dir, { recursive: true, force: true });
  inData(dir, () => state.pruneStale(mkCfg(dir)));
  assert.ok(true);
});

// ===========================================================================
// markers.mjs
// ===========================================================================

/** The Marker, verbatim from build-guide §4.8. */
const MARKER = {
  run_id: 'cc-my-project-9f2a11c4',
  mode: 'local',
  state: 'ready',
  updated_at: 1765000000000,
  cold_start_until: 1765000020000,
  recall: {
    sources: 6, tokens: 1187, ms: 842, empty_reason: '', rung: 1, dropped: 0,
    dry_streak: 0, last_hit_at: 1765000000000,
  },
  captured: { tools: 12, turns: 1, pending: 3 },
  lessons: { global: 3, checked_at: 1765000000000 },
  reflect: { at: 1765000000000, lessons_stored: 3, status: 'ok' },
  last_error: '',
};

// §4.8 + §7: the marker lives at status/<run_id>.json and round-trips whole.
test('updateMarker()/readMarker(): the §4.8 Marker round-trips at status/<run_id>.json', async () => {
  const markers = await lib('markers.mjs');
  const dir = makeDataDir();
  const cfg = mkCfg(dir);

  inData(dir, () => markers.updateMarker(cfg, MARKER.run_id, MARKER));
  const p = join(dir, 'status', `${MARKER.run_id}.json`);
  assert.equal(existsSync(p), true, 'the marker must land at status/<run_id>.json');

  const got = inData(dir, () => markers.readMarker(cfg, MARKER.run_id));
  for (const [k, v] of Object.entries(MARKER)) {
    if (k === 'updated_at') {
      // updateMarker owns this field; it may restamp it.
      assert.equal(typeof got.updated_at, 'number');
      continue;
    }
    assert.deepEqual(got[k], v, `Marker.${k} did not round-trip`);
  }
});

// §4.8: updateMarker is a patch — hooks each own one slice of the marker and
// run in separate processes, so a write must not clobber a sibling's slice.
test('updateMarker(): merges, and does not clobber sibling keys', async () => {
  const markers = await lib('markers.mjs');
  const dir = makeDataDir();
  const cfg = mkCfg(dir);
  const runId = 'cc-my-project-9f2a11c4';

  inData(dir, () => {
    markers.updateMarker(cfg, runId, { run_id: runId, mode: 'local', state: 'ready' });
    markers.updateMarker(cfg, runId, {
      recall: { sources: 6, tokens: 1187, ms: 842, empty_reason: '', rung: 1, dropped: 0 },
    });
    markers.updateMarker(cfg, runId, { captured: { tools: 12, turns: 1, pending: 3 } });
    markers.updateMarker(cfg, runId, { lessons: { global: 3, checked_at: 1765000000000 } });
  });

  const got = inData(dir, () => markers.readMarker(cfg, runId));
  assert.equal(got.run_id, runId);
  assert.equal(got.mode, 'local', 'a later patch clobbered mode');
  assert.equal(got.state, 'ready', 'a later patch clobbered state');
  assert.equal(got.recall.sources, 6, 'a later patch clobbered recall');
  assert.equal(got.captured.tools, 12);
  assert.equal(got.lessons.global, 3);
});

// §4.8/§10: statusline.mjs reads the marker on every frame; a missing marker is
// the normal state before the first hook has ever run.
test('readMarker(): a missing marker yields a usable default, never a throw', async () => {
  const markers = await lib('markers.mjs');
  const dir = makeDataDir();
  const cfg = mkCfg(dir);

  const got = inData(dir, () => markers.readMarker(cfg, 'cc-never-written-00000000'));
  assert.equal(typeof got, 'object');
  assert.notEqual(got, null);

  for (const k of Object.keys(MARKER)) {
    assert.ok(k in got, `default Marker is missing "${k}"`);
  }
  assert.equal(typeof got.run_id, 'string');
  assert.equal(typeof got.mode, 'string');
  assert.equal(typeof got.state, 'string');
  assert.equal(typeof got.updated_at, 'number');
  assert.equal(typeof got.cold_start_until, 'number');
  assert.equal(typeof got.last_error, 'string');
  for (const [group, keys] of Object.entries({
    recall: ['sources', 'tokens', 'ms', 'empty_reason', 'rung', 'dropped'],
    captured: ['tools', 'turns', 'pending'],
    lessons: ['global', 'checked_at'],
    reflect: ['at', 'lessons_stored', 'status'],
  })) {
    assert.equal(typeof got[group], 'object', `default Marker.${group} must be an object`);
    for (const k of keys) assert.ok(k in got[group], `default Marker.${group} is missing "${k}"`);
  }
});

// §4.8/§12.1-F14: a corrupt marker degrades to the default rather than taking
// the status line (or the hook that writes it) down with it.
test('readMarker(): a corrupt marker file degrades to the default', async () => {
  const markers = await lib('markers.mjs');
  const dir = makeDataDir();
  const cfg = mkCfg(dir);
  put(join(dir, 'status', 'cc-corrupt.json'), '{"run_id": "cc-corrupt", "recall": {');

  const got = inData(dir, () => markers.readMarker(cfg, 'cc-corrupt'));
  assert.equal(typeof got, 'object');
  assert.equal(typeof got.state, 'string');
  assert.equal(typeof got.recall, 'object');
});

// ===========================================================================
// log.mjs
// ===========================================================================

// §4.8: "every message passes through redactText on the way out" — the log is
// the easiest place to leak the API key you were debugging.
test('log(): redacts secrets in the message before they reach the file', async () => {
  const log = await lib('log.mjs');
  const dir = makeDataDir();
  const cfg = mkCfg(dir, { logLevel: 'debug', redact: true });

  inData(dir, () => log.log(cfg, 'error', `register failed with key ${fx.SECRETS.mubitKey}`));

  const p = join(dir, 'logs', 'mubit-cc.log');
  assert.equal(existsSync(p), true, 'log must write to logs/mubit-cc.log (§7)');
  const body = readFileSync(p, 'utf8');
  assert.equal(body.includes(fx.SECRETS.mubitKey), false,
    'the raw mbt_ key reached the log file');
  assert.ok(body.includes('[REDACTED'), 'the redaction marker is missing');
});

// §4.8 + §4.4: structured fields go out through the same scrub as the message.
test('log(): redacts secrets in the fields object too', async () => {
  const log = await lib('log.mjs');
  const dir = makeDataDir();
  const cfg = mkCfg(dir, { logLevel: 'debug', redact: true });

  inData(dir, () => log.log(cfg, 'error', 'auth failed', {
    header: `Bearer ${fx.SECRETS.mubitKey}`,
    nested: { token: fx.SECRETS.githubToken },
  }));

  const body = readFileSync(join(dir, 'logs', 'mubit-cc.log'), 'utf8');
  assert.equal(body.includes(fx.SECRETS.mubitKey), false, 'a key leaked through fields');
  assert.equal(body.includes(fx.SECRETS.githubToken), false, 'a token leaked through nested fields');
});

// §6.1 `MUBIT_CC_LOG_LEVEL`: below-threshold messages cost nothing.
test('log(): honours the configured level', async () => {
  const log = await lib('log.mjs');
  const dir = makeDataDir();
  const cfg = mkCfg(dir, { logLevel: 'error' });

  inData(dir, () => {
    log.log(cfg, 'debug', 'chatty debug line that must not be written');
    log.log(cfg, 'info', 'chatty info line that must not be written');
  });

  const p = join(dir, 'logs', 'mubit-cc.log');
  const body = existsSync(p) ? readFileSync(p, 'utf8') : '';
  assert.equal(body.includes('must not be written'), false,
    'a sub-threshold message was written');

  inData(dir, () => log.log(cfg, 'error', 'this one is at threshold'));
  assert.ok(readFileSync(p, 'utf8').includes('this one is at threshold'));
});

// §4.8: "rotates at 1 MiB and keeps two files" — a ring, not an unbounded log.
test('log(): rings at 1 MiB keeping exactly two files', async () => {
  const log = await lib('log.mjs');
  const dir = makeDataDir();
  const cfg = mkCfg(dir, { logLevel: 'debug', redact: true });

  // ~4 KiB per line, low entropy so the scrub has nothing to find, and spaces so
  // the high-entropy detector cannot mistake it for a credential.
  const line = 'lorem ipsum dolor sit amet '.repeat(150);
  inData(dir, () => {
    for (let i = 0; i < 800; i++) log.log(cfg, 'info', `${i} ${line}`);
  });

  const logs = join(dir, 'logs');
  assert.equal(existsSync(join(logs, 'mubit-cc.log')), true);
  assert.equal(existsSync(join(logs, 'mubit-cc.log.1')), true,
    'rotation must keep one previous file');
  assert.equal(existsSync(join(logs, 'mubit-cc.log.2')), false,
    'the ring keeps two files; a third means it grows without bound');

  const stray = walk(logs).filter((f) => !['mubit-cc.log', 'mubit-cc.log.1'].includes(f));
  assert.deepEqual(stray, [], `unexpected files in logs/: ${stray.join(', ')}`);

  // 1 MiB cap, plus at most one over-the-line message.
  const slack = 64 * 1024;
  for (const f of ['mubit-cc.log', 'mubit-cc.log.1']) {
    const size = statSync(join(logs, f)).size;
    assert.ok(size <= MIB + slack, `${f} is ${size} bytes, past the 1 MiB cap`);
  }
});

// §4.9/§12.1-F14: logging is never allowed to be the thing that breaks a hook.
test('log(): does not throw when the log directory cannot be created', async () => {
  const log = await lib('log.mjs');
  const dir = tempDir('mubit-cc-nolog-');
  // A regular file where `logs/` should be: every mkdir/append below it fails.
  writeFileSync(join(dir, 'logs'), 'not a directory');
  const cfg = mkCfg(dir, { logLevel: 'debug' });
  inData(dir, () => log.log(cfg, 'error', 'this cannot be written anywhere'));
  assert.ok(true);
});
