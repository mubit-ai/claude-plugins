// @ts-check
/**
 * `lib/seen.mjs` — the cross-turn seen-set, at `runs/<run_id>/seen.json`.
 *
 * Guide sections under test: §7 (state layout and the TTL table), §4.8/§4.9 (synchronous,
 * atomic, never throws), §5.2 (who calls it, and when).
 *
 * ---------------------------------------------------------------------------
 * What this file is defending
 * ---------------------------------------------------------------------------
 * `lib/assemble.mjs` dedupes `sourceRefIds` *within* one block. Nothing dedupes across
 * turns, so a lesson that stays relevant for twenty prompts is injected twenty times at
 * full price — measured at up to 1500 tokens per prompt against 356 tokens, once, for the
 * whole MCP tool surface. This module is the memory of what has already been paid for.
 *
 * It is a **roll-up, not a new source of truth**: every id in it was already written to
 * `runs/<run_id>/turns/<prompt_id>.json` under `recalled`. Losing the file costs one
 * expensive turn and never costs correctness, which is what lets the write be best-effort
 * and the read be total.
 *
 * These tests are written before the implementation. Failing with
 * "lib/seen.mjs does not exist yet" is the expected red state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { lib, baseEnv, makeDataDir } from './helpers/harness.mjs';

const RUN = 'cc-my-project-9f2a11c4';
const HOUR = 60 * 60 * 1000;

/** Fresh data dir + resolved config + a fresh `lib/seen.mjs`. */
async function setup(extra = {}) {
  const S = await lib('seen.mjs');
  const dataDir = makeDataDir();
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(baseEnv({ dataDir, extra }));
  return { cfg, dataDir, S };
}

const runDir = (dataDir, runId = RUN) => join(dataDir, 'runs', runId);
const seenPath = (dataDir, runId = RUN) => join(runDir(dataDir, runId), 'seen.json');

/** Write the roll-up by hand, so a test can age an entry without sleeping. */
function seed(dataDir, entries, runId = RUN) {
  mkdirSync(runDir(dataDir, runId), { recursive: true });
  writeFileSync(seenPath(dataDir, runId), JSON.stringify({
    run_id: runId,
    updated_at: Date.now(),
    refs: entries,
  }));
}

// ---------------------------------------------------------------------------
// readSeen — total, and empty by default
// ---------------------------------------------------------------------------

// §5.2: this is read on the blocking path in front of every prompt. A run that has never
// injected anything is the ordinary first-prompt case, not an error.
test('readSeen: a run with no roll-up yet reports nothing seen', async () => {
  const { cfg, S } = await setup();
  const got = S.readSeen(cfg, RUN);

  assert.ok(got.ids instanceof Set, 'readSeen must hand back a Set of ids for assembleContext');
  assert.equal(got.ids.size, 0);
  assert.deepEqual(got.entries, {},
    'a first prompt must not be told it has already shown something');
});

// §4.9: nothing in lib/ throws on the recall path. A truncated or foreign file is the
// normal state after a SIGKILL and must cost the saving, never the prompt.
test('readSeen: a corrupt roll-up degrades to nothing seen rather than throwing', async () => {
  const { cfg, dataDir, S } = await setup();
  mkdirSync(runDir(dataDir), { recursive: true });
  writeFileSync(seenPath(dataDir), '{"refs": {"ref_a": ');   // truncated mid-write

  const got = S.readSeen(cfg, RUN);
  assert.equal(got.ids.size, 0,
    'an unreadable roll-up must re-expand every entry, which is only expensive — not wrong');
});

test('readSeen: a roll-up whose refs are not an object is ignored', async () => {
  const { cfg, dataDir, S } = await setup();
  mkdirSync(runDir(dataDir), { recursive: true });
  writeFileSync(seenPath(dataDir), JSON.stringify({ run_id: RUN, refs: ['ref_a'] }));

  assert.equal(S.readSeen(cfg, RUN).ids.size, 0);
});

// ---------------------------------------------------------------------------
// markSeen — the roll-up
// ---------------------------------------------------------------------------

// §5.2 step 6: `prompt-recall` marks what it rendered, next to the ids it stages on the turn.
test('markSeen: records the reference ids a turn injected', async () => {
  const { cfg, dataDir, S } = await setup();

  assert.equal(S.markSeen(cfg, RUN, ['ref_rule_1', 'ref_lesson_1']), true);
  assert.equal(existsSync(seenPath(dataDir)), true,
    'the roll-up must land at runs/<run_id>/seen.json (§7)');

  const got = S.readSeen(cfg, RUN);
  assert.deepEqual([...got.ids].sort(), ['ref_lesson_1', 'ref_rule_1']);
});

// The roll-up is cumulative across turns — that is the entire point. A turn that recalls a
// different lesson must not forget the one three prompts ago.
test('markSeen: accumulates across turns instead of replacing', async () => {
  const { cfg, S } = await setup();

  S.markSeen(cfg, RUN, ['ref_rule_1']);
  S.markSeen(cfg, RUN, ['ref_lesson_1']);
  S.markSeen(cfg, RUN, ['ref_rule_1', 'ref_fact_1']);

  assert.deepEqual([...S.readSeen(cfg, RUN).ids].sort(),
    ['ref_fact_1', 'ref_lesson_1', 'ref_rule_1']);
});

// "…and when." The first sighting is what the entry was paid for at full price; the last is
// what decides whether it has aged out of the model's window.
test('markSeen: keeps the first sighting and moves the last', async () => {
  const { cfg, S } = await setup();

  S.markSeen(cfg, RUN, ['ref_rule_1']);
  const first = S.readSeen(cfg, RUN).entries.ref_rule_1;
  assert.equal(typeof first.first, 'number');
  assert.equal(first.count, 1);

  S.markSeen(cfg, RUN, ['ref_rule_1']);
  const second = S.readSeen(cfg, RUN).entries.ref_rule_1;
  assert.equal(second.first, first.first,
    'the first sighting is when the full price was paid; a later turn must not overwrite it');
  assert.ok(second.last >= first.last);
  assert.equal(second.count, 2, 'the sighting count is how a guide shows the saving compounding');
});

// §1.3: `reference_id` must be non-empty. An entry with no id can never be pointed at, so it
// must never take a slot in a bounded roll-up either.
test('markSeen: ignores blank, non-string and duplicate ids', async () => {
  const { cfg, S } = await setup();

  S.markSeen(cfg, RUN, ['ref_a', '', '   ', null, 42, { id: 'x' }, 'ref_a']);

  const got = S.readSeen(cfg, RUN);
  assert.deepEqual([...got.ids], ['ref_a']);
  assert.equal(got.entries.ref_a.count, 1,
    'the same id twice in one turn is one injection, not two');
});

test('markSeen: an empty id list writes nothing at all', async () => {
  const { cfg, dataDir, S } = await setup();

  S.markSeen(cfg, RUN, []);
  assert.equal(existsSync(seenPath(dataDir)), false,
    'a turn that injected nothing must not create a roll-up for it');
});

// §4.8: `writeJsonAtomic` renames into place, so `bin/statusline.mjs` and a racing hook see
// either the whole old file or the whole new one. A leftover temp file is the tell that a
// writer took the non-atomic path.
test('markSeen: leaves no temp file beside the roll-up', async () => {
  const { cfg, dataDir, S } = await setup();
  S.markSeen(cfg, RUN, ['ref_a']);

  const stray = readdirSync(runDir(dataDir)).filter((f) => f !== 'seen.json');
  assert.deepEqual(stray, [],
    `the write must rename into place; found ${stray.join(', ')} left behind`);
});

// ---------------------------------------------------------------------------
// The TTL — §7, the same 6 h the turn files get
// ---------------------------------------------------------------------------

/*
 * A memory the model can no longer see is not a memory it has seen. `runs/<run_id>/turns/`
 * expires at 6 h (§7), and the roll-up is an aggregation over exactly those files, so it
 * expires with them. Past the TTL the entry goes back to being rendered in full, which is
 * the safe direction: the cost of an unnecessary expansion is tokens, the cost of an
 * unwarranted pointer is a memory the model was never actually shown.
 */
test('readSeen: an entry older than the 6 h turn TTL stops counting as seen', async () => {
  const { cfg, dataDir, S } = await setup();
  const now = Date.now();
  seed(dataDir, {
    ref_fresh: { first: now - 60_000, last: now - 60_000, count: 1 },
    ref_stale: { first: now - 7 * HOUR, last: now - 7 * HOUR, count: 9 },
  });

  const got = S.readSeen(cfg, RUN);
  assert.deepEqual([...got.ids], ['ref_fresh'],
    'an entry the model can no longer see must be re-expanded, not pointed at');
});

test('readSeen: a sighting inside the window keeps an old first sighting alive', async () => {
  const { cfg, dataDir, S } = await setup();
  const now = Date.now();
  seed(dataDir, {
    ref_long_lived: { first: now - 7 * HOUR, last: now - 60_000, count: 20 },
  });

  assert.deepEqual([...S.readSeen(cfg, RUN).ids], ['ref_long_lived'],
    'the TTL is measured from the LAST sighting — a memory injected again a minute ago is '
    + 'still in the window, however long ago it first arrived');
});

test('readSeen: an entry with no usable timestamp is treated as expired', async () => {
  const { cfg, dataDir, S } = await setup();
  seed(dataDir, { ref_a: { count: 3 }, ref_b: 'not an entry' });

  assert.equal(S.readSeen(cfg, RUN).ids.size, 0,
    'without a timestamp there is no evidence the model ever saw it, so it renders in full');
});

// ---------------------------------------------------------------------------
// The bound — §7, nothing under the data dir grows without a ceiling
// ---------------------------------------------------------------------------

// A long session with a wide store can inject thousands of distinct ids. The roll-up is read
// synchronously in front of every prompt, so its size is a latency cost, not just a disk one.
test('markSeen: the roll-up is bounded, keeping the most recent sightings', async () => {
  const { cfg, dataDir, S } = await setup();

  const many = [];
  for (let i = 0; i < S.MAX_SEEN_REFS + 40; i++) many.push(`ref_${i}`);
  S.markSeen(cfg, RUN, many);

  const got = S.readSeen(cfg, RUN);
  assert.ok(got.ids.size <= S.MAX_SEEN_REFS,
    `the roll-up grew to ${got.ids.size} ids; a file read before every prompt needs a ceiling`);
  assert.ok(got.ids.has(`ref_${S.MAX_SEEN_REFS + 39}`),
    'eviction must drop the oldest sightings, not the newest');

  const raw = JSON.parse(readFileSync(seenPath(dataDir), 'utf8'));
  assert.ok(Object.keys(raw.refs).length <= S.MAX_SEEN_REFS,
    'the bound belongs on disk, not only on the read');
});

// ---------------------------------------------------------------------------
// clearSeen — the compaction reset
// ---------------------------------------------------------------------------

/*
 * §5.6: compaction resets the model's window, not the file. After `PostCompact` the model
 * has not seen any of it, so a pointer would name a memory that is no longer anywhere in
 * the conversation — the one failure mode of this whole mechanism that is worse than
 * paying full price.
 */
test('clearSeen: forgets everything, so the next prompt re-expands in full', async () => {
  const { cfg, dataDir, S } = await setup();
  S.markSeen(cfg, RUN, ['ref_rule_1', 'ref_lesson_1']);

  assert.equal(S.clearSeen(cfg, RUN), true);
  assert.equal(existsSync(seenPath(dataDir)), false, 'the roll-up file must be gone');
  assert.equal(S.readSeen(cfg, RUN).ids.size, 0);
});

test('clearSeen: clearing a run that never had a roll-up is not an error', async () => {
  const { cfg, S } = await setup();
  assert.equal(S.clearSeen(cfg, 'cc-never-seen-anything'), true);
});

// ---------------------------------------------------------------------------
// §4.9 — never throws, on any path
// ---------------------------------------------------------------------------

// §12.1: an unwritable ${CLAUDE_PLUGIN_DATA} costs the saving and nothing else. The
// prompt still goes out, with every entry rendered in full.
test('markSeen: an unwritable run directory costs the roll-up, never the prompt', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores mode bits');
  const { cfg, dataDir, S } = await setup();
  mkdirSync(runDir(dataDir), { recursive: true });
  chmodSync(runDir(dataDir), 0o500);
  t.after(() => { try { chmodSync(runDir(dataDir), 0o700); } catch { /* already gone */ } });

  assert.equal(S.markSeen(cfg, RUN, ['ref_a']), false,
    'a failed write reports false; it must not throw out of a hook body');
  assert.equal(S.readSeen(cfg, RUN).ids.size, 0);
});

test('every export is total against a missing config and a missing run id', async () => {
  const { S } = await setup();
  const cfg = /** @type {any} */ ({});

  assert.doesNotThrow(() => S.readSeen(cfg, ''));
  assert.doesNotThrow(() => S.readSeen(/** @type {any} */ (null), RUN));
  assert.doesNotThrow(() => S.markSeen(cfg, '', ['ref_a']));
  assert.doesNotThrow(() => S.markSeen(cfg, RUN, /** @type {any} */ (null)));
  assert.doesNotThrow(() => S.clearSeen(cfg, ''));
});

// §7: the run id names a directory and can be pinned by hand, so it is untrusted input to a
// path — the same rule `lib/state.mjs` applies everywhere else.
test('the roll-up cannot be written outside the run directory', async () => {
  const { cfg, dataDir, S } = await setup();
  S.markSeen(cfg, '../../escaped', ['ref_a']);

  assert.equal(existsSync(join(dataDir, '..', 'escaped')), false,
    'a run id is untrusted input to a path (lib/state.mjs safeSegment)');
});
