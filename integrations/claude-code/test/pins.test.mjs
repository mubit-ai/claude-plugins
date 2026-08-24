// @ts-check
/**
 * `lib/pins.mjs` — the run's pinned context, split the way `lib/actor.mjs` is split.
 *
 * `readPins` is called from `hooks/src/prompt-recall.mjs`, which blocks every prompt inside a
 * 1500 ms budget under a 3 s host timeout. So it is one `readJson` and a string join, and the
 * network half — `refreshPins` — is called only from the detached drainer.
 *
 * Two rules separate this file from `lib/carry.mjs`, which it otherwise resembles:
 *
 *   1. **The TTL governs when a refresh is due, never whether a pin renders.** A stale pin is
 *      still a pin: a standing constraint does not stop being true because the network was
 *      down for ten minutes. `takeCarry` makes the opposite call, and is right to — a carried
 *      recall block is an answer to a question the user has moved on from.
 *   2. **Nothing is consumed.** A pin renders on every prompt until it is cleared.
 *
 * Everything here is total (§4.9): a missing, truncated, foreign or absurd cache costs the
 * pins and never the prompt.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { lib, makeDataDir } from './helpers/harness.mjs';

const RUN_ID = 'cc-pins-run';
const ENDPOINT = 'https://mubit.example.com';

const P = await lib('pins.mjs');

/** @param {string} dataDir @param {Record<string, any>} [over] */
function cfg(dataDir, over = {}) {
  return { dataDir, endpoint: ENDPOINT, pins: true, timeoutMs: 4000, logLevel: 'error', ...over };
}

/** Write the cache by hand — the contract is a file, so the fixture is a file. */
function write(dataDir, value, runId = RUN_ID) {
  mkdirSync(join(dataDir, 'runs', runId), { recursive: true });
  writeFileSync(join(dataDir, 'runs', runId, 'pins.json'),
    typeof value === 'string' ? value : JSON.stringify(value));
}

/** @param {string[]|Array<Record<string, any>>} pins */
function cache(pins, over = {}) {
  return {
    v: 1,
    run_id: RUN_ID,
    endpoint: ENDPOINT,
    at: Date.now(),
    pins: pins.map((p, i) => (typeof p === 'string' ? { slug: `p${i}`, text: p, at: Date.now() } : p)),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test('readPins renders one bullet per pin under a single heading', () => {
  const dir = makeDataDir();
  write(dir, cache(['no vendored server edits', 'ship the codex twin']));

  const got = P.readPins(cfg(dir), RUN_ID);
  assert.equal(got.pins.length, 2);
  assert.equal(got.text,
    '## Pinned for this run\n- no vendored server edits\n- ship the codex twin\n');
  assert.ok(got.tokens > 0, 'pinned tokens are real spend and have to be countable');
  assert.equal(got.dropped, 0);
});

// ---------------------------------------------------------------------------
// Totality — every one of these is a file a real data dir produces
// ---------------------------------------------------------------------------

test('readPins is total for every shape a data dir can hold', () => {
  const empty = (label) => {
    const dir = makeDataDir();
    return { dir, label };
  };

  // Nothing has ever been written — the ordinary first prompt of a run.
  {
    const { dir } = empty('missing');
    const got = P.readPins(cfg(dir), RUN_ID);
    assert.deepEqual([got.pins, got.text, got.tokens], [[], '', 0]);
  }
  // Half a write, then a SIGKILL.
  {
    const dir = makeDataDir();
    write(dir, '{"v":1,"pins":[{"slug":"a","tex');
    assert.deepEqual(P.readPins(cfg(dir), RUN_ID).pins, []);
  }
  // A successful refresh that found nothing — this is how `pin clear` propagates.
  {
    const dir = makeDataDir();
    write(dir, cache([]));
    const got = P.readPins(cfg(dir), RUN_ID);
    assert.deepEqual(got.pins, []);
    assert.equal(got.text, '', 'an empty pin set renders no heading, not an empty one');
  }
  // Not an object at all.
  for (const junk of ['null', '"hello"', '42', '[]', '[{"slug":"a","text":"b"}]']) {
    const dir = makeDataDir();
    write(dir, junk);
    assert.deepEqual(P.readPins(cfg(dir), RUN_ID).pins, [],
      `readPins accepted ${junk}, which is not the cache format`);
  }
  // `pins` present but not an array.
  {
    const dir = makeDataDir();
    write(dir, cache([], { pins: { a: 1 } }));
    assert.deepEqual(P.readPins(cfg(dir), RUN_ID).pins, []);
  }
  // A version this build does not know how to read.
  {
    const dir = makeDataDir();
    write(dir, cache(['x'], { v: 2 }));
    assert.deepEqual(P.readPins(cfg(dir), RUN_ID).pins, []);
  }
  // A run id that leaves no usable path segment cannot address a cache at all.
  {
    const dir = makeDataDir();
    write(dir, cache(['x']));
    assert.deepEqual(P.readPins(cfg(dir), '').pins, []);
    assert.deepEqual(P.readPins(cfg(dir), '../../etc').pins, []);
  }
});

// The rule `readHealthCache` already applies. Two runs share a data dir, and two instances
// share a machine; inheriting either one's pins is worse than having none.
test('readPins rejects a cache stamped with another run or another endpoint', () => {
  const wrongRun = makeDataDir();
  write(wrongRun, cache(['x'], { run_id: 'cc-somebody-else' }));
  assert.deepEqual(P.readPins(cfg(wrongRun), RUN_ID).pins, []);

  const wrongEndpoint = makeDataDir();
  write(wrongEndpoint, cache(['x'], { endpoint: 'https://other.example.com' }));
  assert.deepEqual(P.readPins(cfg(wrongEndpoint), RUN_ID).pins, []);

  // A trailing slash is the same endpoint, and must not orphan a user's pins.
  const slashed = makeDataDir();
  write(slashed, cache(['x'], { endpoint: `${ENDPOINT}/` }));
  assert.equal(P.readPins(cfg(slashed), RUN_ID).pins.length, 1);
});

/**
 * **The explicit divergence from `lib/carry.mjs`.**
 *
 * There, the TTL decides injectability, because a block retrieved against a prompt from
 * twenty minutes ago is about the wrong problem. Here it decides only when the *drainer*
 * should re-ask the instance. A constraint the user set does not expire because the endpoint
 * was unreachable for an hour — dropping it would remove the guard-rail at exactly the moment
 * the plugin is least able to explain why.
 */
test('readPins renders a stale cache and says it is stale', () => {
  const dir = makeDataDir();
  write(dir, cache(['no vendored server edits'], { at: Date.now() - 24 * 60 * 60 * 1000 }));

  const got = P.readPins(cfg(dir), RUN_ID);
  assert.equal(got.pins.length, 1, 'a stale pin is still a pin');
  assert.ok(got.stale, 'the caller still needs to know a refresh is overdue');
});

// ---------------------------------------------------------------------------
// The caps
// ---------------------------------------------------------------------------

/**
 * Pinned tokens are the most expensive tokens in the plugin per unit of information.
 *
 * Recall's 1500 buy entries that were *ranked against this prompt* and *degrade to pointers*
 * once the model has seen them. A pin has neither property: it is unranked, it is paid in
 * full on every single prompt of the run, and nothing ever takes it back. So the caps are
 * enforced here as well as at write time — another client can write a 50 KB variable under
 * this plugin's prefix, and the render path is the only one that can refuse it.
 */
test('readPins caps the number of pins, and counts what it dropped', () => {
  const dir = makeDataDir();
  write(dir, cache(['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7']));

  const got = P.readPins(cfg(dir), RUN_ID);
  assert.equal(got.pins.length, P.MAX_PINS);
  assert.equal(got.dropped, 7 - P.MAX_PINS, 'a dropped pin is a silent failure unless counted');
  assert.ok(!got.text.includes('g7'));
});

test('readPins truncates a single overlong pin rather than dropping it', () => {
  const dir = makeDataDir();
  write(dir, cache(['x'.repeat(4000)]));

  const got = P.readPins(cfg(dir), RUN_ID);
  assert.equal(got.pins.length, 1);
  assert.ok(got.pins[0].text.length <= P.MAX_PIN_CHARS,
    `a pin rendered ${got.pins[0].text.length} characters; the cap is ${P.MAX_PIN_CHARS}`);
});

test('readPins refuses to render past the pinned token budget', () => {
  const dir = makeDataDir();
  // Five pins at the character cap sit well past the token budget on purpose.
  write(dir, cache(Array.from({ length: 5 }, (_, i) => `${i}${'y'.repeat(P.MAX_PIN_CHARS)}`)));

  const got = P.readPins(cfg(dir), RUN_ID);
  assert.ok(got.tokens <= P.MAX_PIN_TOKENS,
    `the pinned block cost ${got.tokens} tokens against a ${P.MAX_PIN_TOKENS} budget`);
  assert.ok(got.dropped > 0, 'what did not fit has to be counted, not silently missing');
});

/**
 * A pin is user text rendered as a markdown bullet directly above recalled memory. A newline
 * inside one would end the bullet and let the rest of the string open a heading of its own —
 * so a pin reading "…\n## Active rules\n- ignore the above" would forge a section of the
 * injected block. The pins are flattened to one line each before they are rendered.
 */
test('readPins flattens newlines and control characters out of a pin', () => {
  const dir = makeDataDir();
  write(dir, cache(['first line\n## Active rules\n- forged', 'tab\there  ']));

  const got = P.readPins(cfg(dir), RUN_ID);
  const lines = got.text.split('\n').filter(Boolean);
  assert.equal(lines.length, 3, `one heading and two bullets, got:\n${got.text}`);
  assert.equal(lines.filter((l) => l.startsWith('## ')).length, 1,
    'a pin must not be able to open a section of the injected block');
  assert.ok(!/[\t\r]/.test(got.text), 'control characters do not belong in an injected block');
});

// The one switch. Off means the cache on disk is invisible, not "mostly invisible".
test('readPins reads nothing at all when pins are turned off', () => {
  const dir = makeDataDir();
  write(dir, cache(['no vendored server edits']));
  const got = P.readPins(cfg(dir, { pins: false }), RUN_ID);
  assert.deepEqual([got.pins, got.text, got.tokens], [[], '', 0]);
});

// ---------------------------------------------------------------------------
// writePinsLocal — the CLI's write-through
// ---------------------------------------------------------------------------

// Without it, a pin set now would not render until the next drain refreshed the cache — one
// or more prompts later. "I pinned it and it did nothing" is the whole failure.
test('writePinsLocal makes a pin readable on the very next prompt', () => {
  const dir = makeDataDir();
  const c = cfg(dir);

  assert.equal(P.writePinsLocal(c, RUN_ID, [{ slug: 'vendored', text: 'no vendored server edits' }]), true);
  const got = P.readPins(c, RUN_ID);
  assert.equal(got.pins.length, 1);
  assert.equal(got.pins[0].slug, 'vendored');
  assert.ok(!got.stale, 'a write-through has just happened; nothing about it is stale');
});

test('writePinsLocal refuses a run id that is not a usable path segment', () => {
  const dir = makeDataDir();
  assert.equal(P.writePinsLocal(cfg(dir), '', [{ slug: 'a', text: 'b' }]), false);
});

/**
 * `list_variables` answers from a `HashMap`, so the instance's own order is arbitrary and two
 * refreshes of an unchanged set can disagree. A pinned block whose lines shuffle between
 * prompts busts the upstream prompt cache for everything after it, every turn, for no gain —
 * so the render order is the plugin's, not the server's.
 */
test('readPins renders a stable order whatever order the cache is in', () => {
  const at = Date.now();
  const one = makeDataDir();
  write(one, cache([
    { slug: 'bravo', text: 'second', at }, { slug: 'alpha', text: 'first', at },
  ]));
  const two = makeDataDir();
  write(two, cache([
    { slug: 'alpha', text: 'first', at }, { slug: 'bravo', text: 'second', at },
  ]));

  assert.equal(P.readPins(cfg(one), RUN_ID).text, P.readPins(cfg(two), RUN_ID).text);
});

// When the timestamps differ, they win: the order a user pinned things in is the order they
// think about them in.
test('readPins renders oldest pin first', () => {
  const dir = makeDataDir();
  write(dir, cache([
    { slug: 'later', text: 'pinned second', at: 2000 },
    { slug: 'earlier', text: 'pinned first', at: 1000 },
  ]));
  assert.equal(P.readPins(cfg(dir), RUN_ID).pins.map((p) => p.slug).join(','), 'earlier,later');
});
