// @ts-check
/**
 * `lib/spool.mjs` — the capture buffer that sits between a hook and the network.
 *
 * Guide sections under test: §4.6 (the module), §7 (state layout and the 60 s drain-lock
 * TTL), §5.4/§5.5 (who calls it), §12.6 (the 200-concurrent-append property).
 *
 * The design decision this file exists to defend: **one file per item, not an append-only
 * NDJSON log.** `fs.appendFileSync` with `O_APPEND` is only atomic below `PIPE_BUF`,
 * captured tool output routinely exceeds that, and two concurrent `PostToolUse` hooks would
 * interleave and corrupt lines. File-per-item makes concurrent capture lock-free and makes
 * a partial write self-evident (unparseable → unlink).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { lib, baseEnv, makeDataDir, tempDir, PLUGIN_ROOT } from './helpers/harness.mjs';
import { spoolItem } from './helpers/fixtures.mjs';

const RUN = 'cc-my-project-9f2a11c4';
const SESSION = '4f21ab90-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

/** Fresh data dir + resolved config + a fresh `lib/spool.mjs`. */
async function setup(extra = {}) {
  const S = await lib('spool.mjs');
  const dataDir = makeDataDir();
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(baseEnv({ dataDir, extra }));
  return { cfg, dataDir, S };
}

const runDir = (dataDir, runId = RUN) => join(dataDir, 'runs', runId);
const spoolDir = (dataDir, runId = RUN) => join(runDir(dataDir, runId), 'spool');

/** Spool file names, sorted lexically — which, given `<ts>-<rand6>`, is chronological. */
function listSpool(dataDir, runId = RUN) {
  const dir = spoolDir(dataDir, runId);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
}

function readSpool(dataDir, file, runId = RUN) {
  return JSON.parse(readFileSync(join(spoolDir(dataDir, runId), file), 'utf8'));
}

/** Find the spool file holding `itemId` and give it an explicit age (name ts + mtime). */
function retime(dataDir, itemId, ts, runId = RUN) {
  for (const f of listSpool(dataDir, runId)) {
    const p = join(spoolDir(dataDir, runId), f);
    let json;
    try { json = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    const id = json.item_id ?? json.item?.item_id;
    if (id !== itemId) continue;
    const suffix = basename(p).split('-').slice(1).join('-') || 'aaaaaa.json';
    const moved = join(dirname(p), `${ts}-${suffix}`);
    renameSync(p, moved);
    const when = new Date(ts);
    utimesSync(moved, when, when);
    return moved;
  }
  return assert.fail(`no spool file found for item_id=${itemId}`);
}

const item = (over = {}) => spoolItem(over);

// ---------------------------------------------------------------------------
// appendItem — §4.6, §7 `runs/<run_id>/spool/<ts>-<rand6>.json`
// ---------------------------------------------------------------------------

// §7: the spool lives under the run, not the session — a crashed session's captures are
// picked up by the next session's first drain (§5.7).
test('appendItem: creates runs/<run_id>/spool/<ts>-<rand6>.json', async () => {
  const { cfg, dataDir, S } = await setup();
  S.appendItem(cfg, RUN, item({ item_id: 'i-1' }));

  const files = listSpool(dataDir);
  assert.equal(files.length, 1, `expected exactly one spool file, got ${JSON.stringify(files)}`);
  assert.match(files[0], /^\d{10,}-[A-Za-z0-9]{6}\.json$/,
    `spool file name must be <ts>-<rand6>.json, got "${files[0]}"`);
});

// §5.4: the spooled item is one element of the eventual `items[]` — the drain sends it
// through untouched, so what lands here must already be wire-shaped.
test('appendItem: the file is the item, verbatim and parseable', async () => {
  const { cfg, dataDir, S } = await setup();
  const it = item({ item_id: 'i-verbatim' });
  S.appendItem(cfg, RUN, it);

  const got = readSpool(dataDir, listSpool(dataDir)[0]);
  assert.equal(got.item_id, 'i-verbatim');
  assert.equal(got.content_type, 'text');
  assert.equal(got.intent, it.intent, '§1.5: intent must survive the round trip');
});

// §12.6 / §4.6 — THE property that justifies file-per-item. Eight real processes, 25 items
// each, every payload 32 KB (comfortably past PIPE_BUF, where O_APPEND stops being atomic).
// An NDJSON log fails this test by producing interleaved, unparseable lines.
test('appendItem: 200 concurrent appends across processes produce 200 individually parseable files', async () => {
  const { cfg, dataDir, S } = await setup();
  assert.equal(typeof S.appendItem, 'function');
  assert.ok(cfg);

  const writer = join(tempDir('mubit-cc-writer-'), 'writer.mjs');
  const spoolUrl = pathToFileURL(join(PLUGIN_ROOT, 'lib', 'spool.mjs')).href;
  const configUrl = pathToFileURL(join(PLUGIN_ROOT, 'lib', 'config.mjs')).href;
  writeFileSync(writer, [
    `import { appendItem } from ${JSON.stringify(spoolUrl)};`,
    `import { loadConfig } from ${JSON.stringify(configUrl)};`,
    'const [runId, tag, n] = process.argv.slice(2);',
    'const cfg = loadConfig(process.env);',
    "const big = 'x'.repeat(32 * 1024);",
    'for (let i = 0; i < Number(n); i++) {',
    '  appendItem(cfg, runId, {',
    "    item_id: tag + '-' + i, content_type: 'text', text: big,",
    "    intent: 'trace', importance: 'medium', source: 'agent', occurrence_time: 1765000000,",
    '  });',
    '}',
  ].join('\n'));

  const env = baseEnv({ dataDir });
  const procs = Array.from({ length: 8 }, (_, k) => new Promise((resolve) => {
    const child = spawn(process.execPath, [writer, RUN, `w${k}`, '25'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, err }));
  }));

  for (const { code, err } of await Promise.all(procs)) {
    assert.equal(code, 0, `concurrent writer failed:\n${err}`);
  }

  const files = listSpool(dataDir);
  assert.equal(files.length, 200,
    `200 concurrent appends must not collide: got ${files.length} files`);

  const ids = new Set();
  for (const f of files) {
    const json = readSpool(dataDir, f);   // throws on a torn write — that is the assertion
    assert.equal(json.text.length, 32 * 1024, `${f} was written partially`);
    ids.add(json.item_id);
  }
  assert.equal(ids.size, 200, 'every append kept its own identity; nothing was overwritten');
});

// ---------------------------------------------------------------------------
// readBatch — §4.6 (oldest first, respects max, unlinks unparseable files)
// ---------------------------------------------------------------------------

// §4.6: oldest first. The store's episodic ordering is only as good as the drain's.
test('readBatch: returns entries oldest first regardless of directory order', async () => {
  const { cfg, dataDir, S } = await setup();
  const now = Date.now();
  for (const id of ['c', 'a', 'b']) S.appendItem(cfg, RUN, item({ item_id: id }));
  // Give each file an explicit age so the assertion cannot ride on same-millisecond ties.
  retime(dataDir, 'a', now - 3000);
  retime(dataDir, 'b', now - 2000);
  retime(dataDir, 'c', now - 1000);

  const batch = S.readBatch(cfg, RUN, 10);
  assert.deepEqual(batch.map((e) => e.item.item_id), ['a', 'b', 'c']);
});

// §5.5: the drain sends `cfg.batchMaxItems` (default 32) per request and loops; `max` is
// what bounds one request.
test('readBatch: respects max and leaves the remainder on disk', async () => {
  const { cfg, dataDir, S } = await setup();
  const now = Date.now();
  for (const id of ['a', 'b', 'c', 'd', 'e']) S.appendItem(cfg, RUN, item({ item_id: id }));
  ['a', 'b', 'c', 'd', 'e'].forEach((id, i) => retime(dataDir, id, now - 10000 + i * 1000));

  const batch = S.readBatch(cfg, RUN, 2);
  assert.equal(batch.length, 2);
  assert.deepEqual(batch.map((e) => e.item.item_id), ['a', 'b']);
  assert.equal(listSpool(dataDir).length, 5, 'readBatch is a read — nothing is unlinked yet');
});

// §4.6: `commitBatch(entries)` unlinks, so an entry must carry the path it came from.
test('readBatch: each entry carries {path, item}', async () => {
  const { cfg, dataDir, S } = await setup();
  S.appendItem(cfg, RUN, item({ item_id: 'shape' }));

  const [entry] = S.readBatch(cfg, RUN, 10);
  assert.equal(typeof entry.path, 'string');
  assert.ok(existsSync(entry.path), `entry.path must point at the real file: ${entry.path}`);
  assert.equal(entry.item.item_id, 'shape');
  assert.equal(dirname(entry.path), spoolDir(dataDir));
});

// §4.6: a partially written file (SIGKILL mid-write) is unlinked in passing and the
// batch still sends. Retrying a torn file forever is how a spool becomes unbounded.
test('readBatch: unlinks unparseable files and still returns the good ones', async () => {
  const { cfg, dataDir, S } = await setup();
  const now = Date.now();
  S.appendItem(cfg, RUN, item({ item_id: 'good-1' }));
  S.appendItem(cfg, RUN, item({ item_id: 'good-2' }));
  retime(dataDir, 'good-1', now - 3000);
  retime(dataDir, 'good-2', now - 1000);

  const torn = join(spoolDir(dataDir), `${now - 2000}-zzzzzz.json`);
  writeFileSync(torn, '{"item_id":"torn","content_ty');

  const batch = S.readBatch(cfg, RUN, 10);

  assert.deepEqual(batch.map((e) => e.item.item_id), ['good-1', 'good-2']);
  assert.equal(existsSync(torn), false, 'the unparseable file is unlinked as readBatch passes it');
});

// An empty (or absent) spool is the common case on a fresh run; it must not throw.
test('readBatch: an empty spool returns an empty array', async () => {
  const { cfg, S } = await setup();
  assert.deepEqual(S.readBatch(cfg, RUN, 32), []);
  assert.deepEqual(S.readBatch(cfg, 'cc-never-used-00000000', 32), []);
});

// §5.5/§7: `spool/rejected/` holds batches the server refused with a non-retryable 4xx.
// Re-reading them would retry a 422 forever — the exact unbounded-spool failure.
test('readBatch: ignores the spool/rejected/ quarantine directory', async () => {
  const { cfg, dataDir, S } = await setup();
  S.appendItem(cfg, RUN, item({ item_id: 'live' }));
  const rejected = join(spoolDir(dataDir), 'rejected');
  mkdirSync(rejected, { recursive: true });
  writeFileSync(join(rejected, `${Date.now()}-aaaaaa.json`), JSON.stringify(item({ item_id: 'quarantined' })));

  const batch = S.readBatch(cfg, RUN, 32);
  assert.deepEqual(batch.map((e) => e.item.item_id), ['live']);
});

// ---------------------------------------------------------------------------
// commitBatch — §4.6, §5.5 step 6 ("2xx → commitBatch")
// ---------------------------------------------------------------------------

// §5.5: unlink only after a 2xx. A 5xx or a network failure leaves the files in place.
test('commitBatch: unlinks exactly the committed entries', async () => {
  const { cfg, dataDir, S } = await setup();
  const now = Date.now();
  for (const id of ['a', 'b', 'c']) S.appendItem(cfg, RUN, item({ item_id: id }));
  ['a', 'b', 'c'].forEach((id, i) => retime(dataDir, id, now - 3000 + i * 1000));

  const batch = S.readBatch(cfg, RUN, 2);
  S.commitBatch(batch);

  assert.equal(listSpool(dataDir).length, 1, 'only the committed two are gone');
  assert.equal(S.readBatch(cfg, RUN, 10)[0].item.item_id, 'c');
});

// §4.6: a double drain is absorbed by the per-batch `idempotency_key`, so committing an
// entry twice must be a no-op, not a crash that strands the rest of the batch.
test('commitBatch: is a no-op on an already-unlinked entry rather than throwing', async () => {
  const { cfg, dataDir, S } = await setup();
  S.appendItem(cfg, RUN, item({ item_id: 'once' }));
  const batch = S.readBatch(cfg, RUN, 10);

  unlinkSync(batch[0].path);
  assert.doesNotThrow(() => S.commitBatch(batch));
  assert.equal(listSpool(dataDir).length, 0);
});

test('commitBatch: an empty batch is a no-op', async () => {
  const { cfg, S } = await setup();
  assert.doesNotThrow(() => S.commitBatch([]));
  assert.ok(cfg);
});

// ---------------------------------------------------------------------------
// The drain lock — §4.6, §7 (`runs/<run_id>/drain.lock`, stale at 60 s)
// ---------------------------------------------------------------------------

// §5.5 step 1: single drainer. Two hooks can fire a detached drain within milliseconds of
// each other; O_EXCL is what makes "exactly one proceeds" true without a daemon.
test('acquireDrainLock: O_EXCL — the second acquisition returns null', async () => {
  const { cfg, dataDir, S } = await setup();

  const first = S.acquireDrainLock(cfg, RUN);
  assert.ok(first, 'the first acquisition wins');

  const lockPath = join(runDir(dataDir), 'drain.lock');
  assert.ok(existsSync(lockPath), `expected the lock at ${lockPath}`);
  const held = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(held.pid, process.pid, 'the lock records its owner pid');
  assert.ok(Math.abs(held.ts - Date.now()) < 5000, 'the lock records its acquisition ts');

  assert.equal(S.acquireDrainLock(cfg, RUN), null, 'the second drainer must stand down');
});

test('releaseDrainLock: removes the lock and lets the next drainer in', async () => {
  const { cfg, dataDir, S } = await setup();
  const lock = S.acquireDrainLock(cfg, RUN);

  S.releaseDrainLock(lock);

  assert.equal(existsSync(join(runDir(dataDir), 'drain.lock')), false);
  assert.ok(S.acquireDrainLock(cfg, RUN), 'a fresh acquisition succeeds after release');
});

// drain.mjs releases in a `finally`, where the lock may legitimately be null.
test('releaseDrainLock: releasing a null lock does not throw', async () => {
  const { S } = await setup();
  assert.doesNotThrow(() => S.releaseDrainLock(null));
});

// §7: "steal unconditionally past the TTL". The owner here is very much alive (it is this
// process), and the lock is still stolen: a stuck lock silently stops ALL capture, which is
// strictly worse than a rare double drain that the `idempotency_key` absorbs.
test('acquireDrainLock: a lock older than 60s is stolen even when its pid is alive', async () => {
  const { cfg, dataDir, S } = await setup();
  mkdirSync(runDir(dataDir), { recursive: true });
  const lockPath = join(runDir(dataDir), 'drain.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() - 61_000 }));
  const old = new Date(Date.now() - 61_000);
  utimesSync(lockPath, old, old);

  const lock = S.acquireDrainLock(cfg, RUN);

  assert.ok(lock, 'a lock past the 60 s TTL is orphaned by definition');
  const held = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.ok(Date.now() - held.ts < 5000, 'the stolen lock is re-stamped with a fresh ts');
});

// §7: "Verify the recorded `pid` is dead first where possible (`process.kill(pid, 0)`
// throwing ESRCH)". A drainer killed with its terminal leaves a fresh-looking lock; waiting
// out the full TTL for it would stall capture for a minute for no reason.
test('acquireDrainLock: a fresh lock whose pid is dead is stolen via the pid check', async (t) => {
  const { cfg, dataDir, S } = await setup();
  const reaped = spawnSync(process.execPath, ['-e', '0']);
  const deadPid = reaped.pid;
  assert.ok(deadPid, 'could not spawn a throwaway process to harvest a dead pid');
  try {
    process.kill(deadPid, 0);
    return t.skip(`pid ${deadPid} was recycled; cannot test the ESRCH path`);
  } catch { /* ESRCH — the pid really is gone */ }

  mkdirSync(runDir(dataDir), { recursive: true });
  writeFileSync(join(runDir(dataDir), 'drain.lock'), JSON.stringify({ pid: deadPid, ts: Date.now() }));

  assert.ok(S.acquireDrainLock(cfg, RUN),
    'a lock whose owner is gone must be stealable before the TTL expires');
});

// The converse: a live owner inside the TTL keeps its lock. Without this, "single drainer"
// is not a property at all.
test('acquireDrainLock: a fresh lock held by a live pid is not stolen', async () => {
  const { cfg, dataDir, S } = await setup();
  mkdirSync(runDir(dataDir), { recursive: true });
  writeFileSync(join(runDir(dataDir), 'drain.lock'), JSON.stringify({ pid: process.pid, ts: Date.now() }));

  assert.equal(S.acquireDrainLock(cfg, RUN), null);
});

// ---------------------------------------------------------------------------
// claimOnce — §4.6 "proceed on marker failure"
// ---------------------------------------------------------------------------

// §5.7 step 1 / §7: `runs/<run_id>/flushed-<session_id>.marker`.
test('claimOnce: the first claim wins and the second sees EEXIST', async () => {
  const { cfg, dataDir, S } = await setup();
  const name = `flushed-${SESSION}`;

  assert.equal(S.claimOnce(cfg, RUN, name), true);
  assert.ok(existsSync(join(runDir(dataDir), `${name}.marker`)),
    'the marker lands at runs/<run_id>/<name>.marker (§7)');
  assert.equal(S.claimOnce(cfg, RUN, name), false, 'the second claim must lose');
});

// Distinct names are distinct claims — one session flushing must not consume another's.
test('claimOnce: markers are namespaced by name', async () => {
  const { cfg, S } = await setup();
  assert.equal(S.claimOnce(cfg, RUN, 'flushed-session-a'), true);
  assert.equal(S.claimOnce(cfg, RUN, 'flushed-session-b'), true);
});

// §4.6: "returns `true` on a non-EEXIST error — proceed on marker failure". The marker
// prevents a *double* flush; a read-only or full ${CLAUDE_PLUGIN_DATA} must not be able to
// prevent the flush *entirely*. Losing the batch is worse than sending it twice, and the
// per-batch idempotency_key makes a double send a server-side no-op anyway.
test('claimOnce: returns true when the marker cannot be written at all (EACCES)', async (t) => {
  if (process.getuid?.() === 0) {
    return t.skip('running as root: filesystem permissions are unenforceable');
  }
  const { cfg, dataDir, S } = await setup();
  S.appendItem(cfg, RUN, item({ item_id: 'x' }));      // materialise runs/<run_id>/

  const dir = runDir(dataDir);
  chmodSync(dir, 0o500);                                // r-x: no new entries
  t.after(() => { try { chmodSync(dir, 0o700); } catch { /* best effort */ } });

  assert.equal(S.claimOnce(cfg, RUN, `flushed-${SESSION}`), true,
    'an unwritable data dir must not be able to veto the final flush');
});

// ---------------------------------------------------------------------------
// spoolStats — §4.6, §5.3 (the drain trigger)
// ---------------------------------------------------------------------------

// §5.3: `count >= batchMaxItems OR oldestMs >= batchMaxAgeMs` triggers a detached drain, so
// an empty spool is asked about on every single prompt. It must be cheap and total.
test('spoolStats: an empty spool returns {count: 0} without throwing', async () => {
  const { cfg, S } = await setup();
  const s = S.spoolStats(cfg, RUN);
  assert.equal(s.count, 0);
  assert.ok(!s.oldestMs, `an empty spool has no age, got ${s.oldestMs}`);

  const never = S.spoolStats(cfg, 'cc-never-used-00000000');
  assert.equal(never.count, 0);
});

// §6.1: `MUBIT_CC_BATCH_MAX_ITEMS` (32) is the count trigger.
test('spoolStats: count tracks the number of pending items', async () => {
  const { cfg, S } = await setup();
  for (const id of ['a', 'b', 'c']) S.appendItem(cfg, RUN, item({ item_id: id }));
  assert.equal(S.spoolStats(cfg, RUN).count, 3);
});

// §6.1: `MUBIT_CC_BATCH_MAX_AGE_MS` (30 000) is the age trigger — without a truthful
// `oldestMs`, a slow session never drains until it happens to hit 32 items.
test('spoolStats: oldestMs grows with an artificially aged file', async () => {
  const { cfg, dataDir, S } = await setup();
  S.appendItem(cfg, RUN, item({ item_id: 'aged' }));
  assert.ok(S.spoolStats(cfg, RUN).oldestMs < 1000, 'a just-written item is not old');

  retime(dataDir, 'aged', Date.now() - 5000);

  const s = S.spoolStats(cfg, RUN);
  assert.equal(s.count, 1);
  assert.ok(s.oldestMs >= 4500, `expected oldestMs ≈ 5000, got ${s.oldestMs}`);
});

// It is the OLDEST item that decides, not the newest — otherwise a steady trickle of new
// captures would keep resetting the trigger and the first item would never ship.
test('spoolStats: oldestMs reflects the oldest item, not the newest', async () => {
  const { cfg, dataDir, S } = await setup();
  S.appendItem(cfg, RUN, item({ item_id: 'old' }));
  S.appendItem(cfg, RUN, item({ item_id: 'new' }));
  retime(dataDir, 'old', Date.now() - 8000);

  const s = S.spoolStats(cfg, RUN);
  assert.equal(s.count, 2);
  assert.ok(s.oldestMs >= 7500, `expected oldestMs ≈ 8000, got ${s.oldestMs}`);
});
