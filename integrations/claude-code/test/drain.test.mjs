// @ts-check
/**
 * `hooks/src/drain.mjs` — the detached drainer (§5.5).
 *
 * Not registered in `hooks.json`. It is spawned only by `stage-prompt`, `capture --stop`,
 * or `session-end`, which is what keeps the per-tool-call hot path free of node's startup
 * cost a second time. Nothing waits on it, so everything it does must be safe to abandon:
 * one drainer at a time, one request per batch, and a spool that is only ever unlinked
 * after a 2xx.
 *
 * The tests run it in the foreground (payload on stdin) — being detached is the caller's
 * concern, tested in `hook.test.mjs`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  runHook, assertHookContract, fakeMubit, baseEnv, makeDataDir,
  readJsonFile, readJsonDir, spoolFiles, waitFor,
} from './helpers/harness.mjs';
import { stop, spoolItem, PROMPT_ID } from './helpers/fixtures.mjs';

const RUN_ID = 'cc-test-0000';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function envFor(dataDir, endpoint, extra = {}) {
  return baseEnv({
    dataDir,
    endpoint,
    projectDir: dataDir,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: RUN_ID,
      MUBIT_CC_TIMEOUT_MS: '1500',
      ...extra,
    },
  });
}

const runDir = (dataDir) => join(dataDir, 'runs', RUN_ID);
const lockPath = (dataDir) => join(runDir(dataDir), 'drain.lock');

/**
 * Seed `n` spool items, oldest first, with both the filename timestamp and the mtime
 * increasing so any oldest-first ordering agrees.
 * @param {string} dataDir @param {number} n @param {number} [ageMs]
 */
function seedSpool(dataDir, n, ageMs = 5000) {
  const dir = join(runDir(dataDir), 'spool');
  mkdirSync(dir, { recursive: true });
  /** @type {string[]} */
  const ids = [];
  const base = Date.now() - ageMs;
  for (let i = 0; i < n; i++) {
    const id = `cc-seed-${String(i).padStart(3, '0')}`;
    const ts = base + i;
    const p = join(dir, `${ts}-${String(i).padStart(6, '0')}.json`);
    writeFileSync(p, JSON.stringify(spoolItem({ item_id: id, text: `seeded item ${i}` })));
    utimesSync(p, ts / 1000, ts / 1000);
    ids.push(id);
  }
  return ids;
}

function seedTurn(dataDir, over = {}) {
  const dir = join(runDir(dataDir), 'turns');
  mkdirSync(dir, { recursive: true });
  const turn = {
    prompt: 'why is the ingest job stuck in queued?',
    prompt_id: PROMPT_ID,
    session_id: stop().session_id,
    started_at: Date.now() - 4000,
    recalled: ['ref_rule_1', 'ref_lesson_1'],
    ended_at: Date.now(),
    outcome_pending: true,
    ...over,
  };
  writeFileSync(join(dir, `${PROMPT_ID}.json`), JSON.stringify(turn));
}

/** Take the lock ourselves, as a live drainer would. */
function holdDrainLock(dataDir) {
  mkdirSync(runDir(dataDir), { recursive: true });
  writeFileSync(lockPath(dataDir), JSON.stringify({ pid: process.pid, ts: Date.now() }));
}

function rejectedFiles(dataDir) {
  const dir = join(runDir(dataDir), 'spool', 'rejected');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
}

/** §1.3 + §1.5 — the three fields the server will not forgive. */
function assertWireItem(item) {
  assert.ok(typeof item.item_id === 'string' && item.item_id.length > 0, 'item_id is REQUIRED (§1.3)');
  assert.ok(typeof item.content_type === 'string' && item.content_type.length > 0,
    'content_type is REQUIRED (§1.3)');
  assert.ok(typeof item.intent === 'string' && item.intent.length > 0,
    'every item carries a non-empty intent (§1.5) — otherwise the server spends one LLM call per item');
  assert.notEqual(item.intent, 'unclassified');
}

/**
 * A fake Mubit whose listening socket is closed even when the test fails — otherwise an
 * open handle keeps the test process alive and the whole run hangs.
 * @param {any} t @param {any} [routes]
 */
async function mubit(t, routes) {
  const server = await fakeMubit(routes);
  t.after(() => server.close());
  return server;
}

// ---------------------------------------------------------------------------

// §5.5 step 1 — single drainer. A second one exits immediately rather than racing.
test('drain: exits 0 without dialing when another drainer holds the lock', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  seedSpool(dataDir, 4);
  holdDrainLock(dataDir);

  const r = await runHook('drain', stop(), { env: envFor(dataDir, server.url) });

  assertHookContract(r);
  assert.equal(server.requests.length, 0,
    `a second drainer must not dial; saw: ${server.summary()}`);
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 4, 'items stay spooled for the live drainer');
  assert.ok(existsSync(lockPath(dataDir)), 'the loser must not delete the winner\'s lock');
});

// §5.5 step 2 — breaker open → release the lock and exit. Items stay spooled; a drain that
// dials into an open breaker is exactly the traffic the breaker exists to stop.
test('drain: an open breaker short-circuits the next drain and leaves items spooled', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t, { 'POST /v2/control/ingest': { status: 500, json: { error: 'boom' } } });
  seedSpool(dataDir, 3);
  const env = envFor(dataDir, server.url, { MUBIT_CC_BREAKER_THRESHOLD: '1' });

  const first = await runHook('drain', stop(), { env });
  assertHookContract(first);
  assert.equal(server.countOf('POST', '/v2/control/ingest'), 1, 'the first drain dials once');

  const second = await runHook('drain', stop(), { env });
  assertHookContract(second);
  assert.equal(server.countOf('POST', '/v2/control/ingest'), 1,
    'the second drain must short-circuit without dialing');
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 3, 'nothing is lost while the breaker is open');
  assert.equal(existsSync(lockPath(dataDir)), false, 'the lock is released on every exit path');
});

// §5.5 steps 3-5 — ONE request for the whole batch, not one per item, and every item on the
// wire carries the three required fields.
test('drain: sends exactly one POST /v2/control/ingest for a 32-item batch', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  const ids = seedSpool(dataDir, 32);

  const r = await runHook('drain', stop(), { env: envFor(dataDir, server.url) });
  assertHookContract(r);

  server.assertCalled('POST', '/v2/control/ingest', 1);
  const body = server.lastCall('POST', '/v2/control/ingest').body;
  assert.equal(body.run_id, RUN_ID);
  assert.ok(typeof body.agent_id === 'string' && body.agent_id.length > 0);
  assert.ok(typeof body.idempotency_key === 'string' && body.idempotency_key.length > 0);
  assert.equal(body.parallel, true, 'batch items are independent (§5.5)');
  assert.equal(body.items.length, 32);
  assert.deepEqual(body.items.map((i) => i.item_id), ids, 'readBatch is oldest-first (§4.6)');
  for (const item of body.items) assertWireItem(item);
});

// §5.5 — "idempotency_key is per batch, derived from (run_id, prompt_id, batch sequence),
// so a retry after a transport timeout is a server-side no-op."
test('drain: two drains of the same batch send the same idempotency_key', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t, {
    'POST /v2/control/ingest': [
      { status: 500, json: { error: 'transport' } },
      { json: { accepted: true, job_id: 'job_test_1', deduplicated: true, status: 'queued' } },
    ],
  });
  seedSpool(dataDir, 5);
  // Keep the breaker out of the way; this test is about the key, not the circuit.
  const env = envFor(dataDir, server.url, { MUBIT_CC_BREAKER_THRESHOLD: '10' });

  assertHookContract(await runHook('drain', stop(), { env }));
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 5, 'a 5xx leaves the batch in place');
  assertHookContract(await runHook('drain', stop(), { env }));

  const calls = server.calls('POST', '/v2/control/ingest');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.idempotency_key, calls[1].body.idempotency_key,
    'the retry of a batch must be dedupable server-side');
  assert.deepEqual(
    calls[0].body.items.map((i) => i.item_id),
    calls[1].body.items.map((i) => i.item_id),
    'the same key must describe the same items',
  );
});

/**
 * The case the key exists for, and the one it used not to cover.
 *
 * `drain` and `session-end` drain the same spool. `session-end` steals a lock `drain` left
 * behind after 60 s, and `drain` has a hard stop that can leave a batch uncommitted, so the
 * same files really are sent by both. They each built the key their own way — one from the
 * prompt id under a `cc-` prefix, the other from the session id under `cc-end-` — so the
 * cross-drainer resend, the one thing four comments in this codebase claimed was covered,
 * produced two different keys and re-posted the batch.
 */
test('drain and session-end send one batch under one idempotency_key', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t, {
    'POST /v2/control/ingest': [
      { status: 500, json: { error: 'transport' } },
      { json: { accepted: true, job_id: 'job_test_1', deduplicated: true, status: 'queued' } },
    ],
  });
  seedSpool(dataDir, 4);
  const env = envFor(dataDir, server.url, { MUBIT_CC_BREAKER_THRESHOLD: '10' });

  // The drain tries and fails; the batch stays on disk.
  assertHookContract(await runHook('drain', stop(), { env }));
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 4, 'a 5xx leaves the batch in place');

  // The session ends, and the other drainer picks up exactly those files — in a detached
  // child, since the host cancels the session-end hook on the way out.
  assertHookContract(await runHook('session-end',
    { hook_event_name: 'SessionEnd', reason: 'exit' }, { env }));
  await waitFor(() => server.countOf('POST', '/v2/control/ingest') >= 2, 12_000);

  const calls = server.calls('POST', '/v2/control/ingest');
  assert.equal(calls.length, 2, 'both drainers sent the batch');
  assert.deepEqual(
    calls[0].body.items.map((i) => i.item_id),
    calls[1].body.items.map((i) => i.item_id),
    'precondition: it is the same batch',
  );
  assert.equal(calls[0].body.idempotency_key, calls[1].body.idempotency_key,
    'the same items must carry the same key whichever drainer sends them');
});

// §5.5 step 6 — 2xx commits: spool unlinked, marker advanced, job_id kept for the doctor skill.
test('drain: a 2xx unlinks the batch, advances the marker, and records the job_id', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  seedSpool(dataDir, 3);
  // §7: jobs.json keeps the last 20. Seed it past the cap so trimming is observable.
  mkdirSync(runDir(dataDir), { recursive: true });
  writeFileSync(join(runDir(dataDir), 'jobs.json'), JSON.stringify(
    Array.from({ length: 25 }, (_, i) => ({ job_id: `job_old_${i}`, at: Date.now() - 1000 * i })),
  ));

  const r = await runHook('drain', stop(), { env: envFor(dataDir, server.url) });
  assertHookContract(r);

  server.assertCalled('POST', '/v2/control/ingest', 1);
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 0, 'commitBatch unlinks only after a 2xx');
  assert.equal(existsSync(lockPath(dataDir)), false, 'the drain lock is released');

  const jobs = readJsonFile(join(runDir(dataDir), 'jobs.json'));
  assert.ok(Array.isArray(jobs), 'jobs.json is an array of {job_id, ...} (§15.4)');
  assert.ok(jobs.length <= 20, `jobs.json keeps the last 20, got ${jobs.length}`);
  assert.ok(jobs.some((j) => j.job_id === 'job_test_1'), 'the new job_id must be recorded');

  const marker = readJsonFile(join(dataDir, 'status', `${RUN_ID}.json`));
  const captured = Object.values(marker.captured ?? {}).filter((v) => typeof v === 'number');
  assert.ok(captured.length > 0, 'the marker must carry a captured count for the status line');
  assert.ok(captured.reduce((a, b) => a + b, 0) >= 3, `marker.captured did not advance: ${JSON.stringify(marker.captured)}`);
});

// §5.5 step 6 — a transport failure records a breaker failure and LEAVES the spool alone.
// The spool is keyed by run_id, not session, so nothing is lost by waiting.
test('drain: a network failure leaves every spool file in place', async (t) => {
  const dataDir = makeDataDir();
  seedSpool(dataDir, 4);
  // Nothing is listening on port 1 — ECONNREFUSED, the nothing-listening scenario.
  const r = await runHook('drain', stop(), { env: envFor(dataDir, 'http://127.0.0.1:1') });

  assertHookContract(r);
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 4, 'unreachable is not a reason to drop memory');
  assert.equal(existsSync(lockPath(dataDir)), false, 'the lock is released even when the send failed');

  const breakers = readJsonDir(join(dataDir, 'breaker'));
  assert.equal(breakers.length, 1, 'breaker state is per endpoint');
  assert.ok(Array.isArray(breakers[0].json.failures) && breakers[0].json.failures.length >= 1,
    `recordFailure did not run: ${JSON.stringify(breakers[0].json)}`);
});

// §5.5 step 6 — a non-retryable 4xx means the payload is bad, not the server.
// Retrying a 422 forever is how a spool becomes unbounded.
test('drain: a 422 quarantines the batch under spool/rejected/ and never retries it', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t, {
    'POST /v2/control/ingest': { status: 422, json: { error: 'item_id is required' } },
  });
  seedSpool(dataDir, 3);
  const env = envFor(dataDir, server.url, { MUBIT_CC_BREAKER_THRESHOLD: '10' });

  assertHookContract(await runHook('drain', stop(), { env }));
  assert.equal(server.countOf('POST', '/v2/control/ingest'), 1);
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 0, 'the rejected batch leaves the live spool');
  assert.ok(rejectedFiles(dataDir).length >= 1, 'the batch is quarantined, not deleted');

  assertHookContract(await runHook('drain', stop(), { env }));
  assert.equal(server.countOf('POST', '/v2/control/ingest'), 1,
    'a quarantined batch is never retried');
});

// §5.5 step 8 — loop while items remain and elapsed < 10s. 70 items is 32/32/6.
test('drain: loops until the spool is empty, one request per batch', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  const ids = seedSpool(dataDir, 70);

  const r = await runHook('drain', stop(), { env: envFor(dataDir, server.url) });
  assertHookContract(r);
  assert.ok(r.ms < 9000, `drain must bound itself to a 10s soft budget, took ${r.ms}ms`);

  const calls = server.calls('POST', '/v2/control/ingest');
  assert.deepEqual(calls.map((c) => c.body.items.length), [32, 32, 6]);
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 0);
  assert.deepEqual(calls.flatMap((c) => c.body.items.map((i) => i.item_id)), ids);
  assert.equal(new Set(calls.map((c) => c.body.idempotency_key)).size, 3,
    'each batch in the sequence gets its own key');
});

// §5.5 step 7 — `--with-outcome` attributes the turn. `reference_id` must be non-empty
// (§1.3); "global" is the run-level sentinel and the real attribution lives in entry_ids[].
// The signal is deliberately weak: a turn completing is not proof the recalled memory
// helped, only weak positive evidence — hence 0.2, not 1.0.
test('drain --with-outcome: posts one outcome carrying the turn\'s recalled entry_ids', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  seedSpool(dataDir, 2);
  seedTurn(dataDir);

  const r = await runHook('drain', stop(), {
    env: envFor(dataDir, server.url),
    args: ['--with-outcome', PROMPT_ID],
  });
  assertHookContract(r);

  server.assertCalled('POST', '/v2/control/ingest', 1);
  server.assertCalled('POST', '/v2/control/outcome', 1);
  const body = server.lastCall('POST', '/v2/control/outcome').body;
  assert.equal(body.run_id, RUN_ID);
  assert.equal(body.reference_id, 'global');
  assert.ok(body.reference_id.length > 0, 'reference_id must be non-empty on an outcome (§1.3)');
  assert.equal(body.outcome, 'success');
  assert.equal(body.signal, 0.2);
  assert.deepEqual(body.entry_ids, ['ref_rule_1', 'ref_lesson_1']);
  assert.ok(typeof body.agent_id === 'string' && body.agent_id.length > 0);
  assert.ok(typeof body.rationale === 'string' && body.rationale.length > 0);
  // Derived from (run_id, prompt_id) and never random — and spelled the same way in
  // `session-end`, since that is what makes a concurrent flush a server-side no-op rather
  // than double reinforcement. `session-end.test.mjs` asserts the two agree end to end.
  assert.equal(body.idempotency_key, `cc-outcome-${RUN_ID}-${PROMPT_ID}`);
});

// §5.5 — no recalled ids means there is nothing to reinforce; the call is skipped entirely
// rather than sent with an empty entry_ids[].
test('drain --with-outcome: skips the outcome call when entry_ids is empty', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  seedSpool(dataDir, 1);
  seedTurn(dataDir, { recalled: [] });

  const r = await runHook('drain', stop(), {
    env: envFor(dataDir, server.url),
    args: ['--with-outcome', PROMPT_ID],
  });
  assertHookContract(r);
  server.assertCalled('POST', '/v2/control/ingest', 1);
  server.assertNotCalled('POST', '/v2/control/outcome');
});

// §5.5 — outcomeMode "off" disables implicit attribution entirely.
test('drain --with-outcome: skips the outcome call when outcomeMode is "off"', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  seedSpool(dataDir, 1);
  seedTurn(dataDir);

  const r = await runHook('drain', stop(), {
    env: envFor(dataDir, server.url, { MUBIT_CC_OUTCOME_MODE: 'off' }),
    args: ['--with-outcome', PROMPT_ID],
  });
  assertHookContract(r);
  server.assertCalled('POST', '/v2/control/ingest', 1);
  server.assertNotCalled('POST', '/v2/control/outcome');
});

/**
 * §5.5 — a turn whose file records `outcome: "failure"` posts `failure` / -0.3. The turn file
 * records how the turn ended, so the drain never has to re-derive it.
 *
 * This used to be titled "a StopFailure turn", after §5.5's line *"On a StopFailure turn:
 * outcome: 'failure', signal: -0.3."* It never was one. Nothing in the plugin has ever
 * written `outcome` onto a turn file — the key exists only here and in the other tests that
 * seed it — because `StopFailure` was not registered, and the host fires it **instead of**
 * `Stop`, so the hook that would have written it never ran on those turns.
 *
 * Now that `StopFailure` IS registered, the guide's row is the one thing this ticket
 * overturns: an API-failed turn posts nothing at all (see `api_error` below). The row this
 * test covers is the different and still-real one — a turn the *file* records as having
 * failed, whatever wrote that.
 */
test('drain --with-outcome: a turn recorded as failed posts outcome "failure" at signal -0.3', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  seedSpool(dataDir, 1);
  seedTurn(dataDir, { outcome: 'failure' });

  const r = await runHook('drain', stop(), {
    env: envFor(dataDir, server.url),
    args: ['--with-outcome', PROMPT_ID],
  });
  assertHookContract(r);

  const body = server.lastCall('POST', '/v2/control/outcome').body;
  assert.equal(body.outcome, 'failure');
  assert.equal(body.signal, -0.3);
  assert.deepEqual(body.entry_ids, ['ref_rule_1', 'ref_lesson_1']);
});

/**
 * The `StopFailure` row, through the drain — one of the two hooks that share
 * `lib/outcome.mjs`, and the one the ticket's claim is written against: *a turn that died on
 * `rate_limit` never reaches `record_outcome`.*
 *
 * The drain reaches this turn only if something hands it `--with-outcome`, which
 * `capture --stop-failure` deliberately does not do. That makes this the belt to
 * `capture.mjs`'s braces: the ingest still goes out (those tool calls were real work), and
 * the outcome does not, even when the argv says to attribute.
 */
test('drain --with-outcome: a turn the API killed ingests, and posts no outcome', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  seedSpool(dataDir, 2);
  seedTurn(dataDir, { api_error: 'rate_limit' });

  const r = await runHook('drain', stop(), {
    env: envFor(dataDir, server.url),
    args: ['--with-outcome', PROMPT_ID],
  });
  assertHookContract(r);

  server.assertCalled('POST', '/v2/control/ingest', 1);
  server.assertNotCalled('POST', '/v2/control/outcome');

  // Not dialled, so not counted. `attempts` is a budget for posts that may have landed
  // unanswered; spending it on a turn nothing will ever send would eventually mark a turn
  // abandoned for a failure that never happened.
  const turn = readJsonFile(join(runDir(dataDir), 'turns', `${PROMPT_ID}.json`));
  assert.ok(!(Number(turn.outcome_attempts) > 0),
    `a suppressed turn must not spend an attempt: ${JSON.stringify(turn.outcome_attempts)}`);
  assert.ok(!turn.outcome_sent_at, 'nothing was sent, so nothing may claim it was');
});

// ---------------------------------------------------------------------------
// §5.5 step 7, conditioned on evidence — "ignored" is not the same as "not injected"
// ---------------------------------------------------------------------------

/** A turn as `capture --stop` leaves it once it could compute the used-signal. */
function seedMeasuredTurn(dataDir, used, over = {}) {
  return seedTurn(dataDir, {
    used_evidence: {
      method: 'memory-term-echo/v1',
      at: Date.now(),
      candidates: 12,
      matched: used ? 3 : 0,
      terms: used ? ['indexing', 'queued', 'poll'] : [],
      answer_chars: 180,
      used,
    },
    ...over,
  });
}

// THE test for this finding. Before it, a turn whose injected memory was plainly ignored
// and a turn where nothing was injected at all were the same thing on the wire: silence.
// Precision cannot be computed from a denominator that never leaves the machine.
test('drain --with-outcome: an ignored injection is distinguishable from no injection', async (t) => {
  const ignoredDir = makeDataDir();
  const ignored = await mubit(t);
  seedSpool(ignoredDir, 1);
  seedMeasuredTurn(ignoredDir, false);

  assertHookContract(await runHook('drain', stop(), {
    env: envFor(ignoredDir, ignored.url),
    args: ['--with-outcome', PROMPT_ID],
  }));

  ignored.assertCalled('POST', '/v2/control/outcome', 1);
  const body = ignored.lastCall('POST', '/v2/control/outcome').body;
  assert.equal(body.outcome, 'neutral',
    'the four accepted outcomes are success/failure/partial/neutral; anything else is a 400');
  assert.equal(body.signal, 0,
    'no evidence of use is not evidence of harm — a penalty here would punish memory for '
    + 'a signal that is mostly false negatives');
  assert.deepEqual(body.entry_ids, [],
    'a neutral record must not name the entries: attributed reinforcement counts any signal '
    + '>= 0 as one reinforcement, so naming them would credit exactly what was ignored');
  assert.equal(body.reference_id, 'global');
  assert.ok(typeof body.rationale === 'string' && body.rationale.length > 0,
    'the rationale is the only field that can carry what was measured');

  // The other half of the distinction: nothing injected is still silence.
  const emptyDir = makeDataDir();
  const empty = await mubit(t);
  seedSpool(emptyDir, 1);
  seedTurn(emptyDir, { recalled: [] });

  assertHookContract(await runHook('drain', stop(), {
    env: envFor(emptyDir, empty.url),
    args: ['--with-outcome', PROMPT_ID],
  }));
  empty.assertNotCalled('POST', '/v2/control/outcome');
});

// §5.5: the weak +0.2 was always defended as "a turn completing is weak positive evidence".
// It now stands on something narrower and checkable — the reply carried the memory's own
// vocabulary — and the record says which method decided that.
test('drain --with-outcome: evidence of use keeps the +0.2 and the entry attribution', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  seedSpool(dataDir, 1);
  seedMeasuredTurn(dataDir, true);

  assertHookContract(await runHook('drain', stop(), {
    env: envFor(dataDir, server.url),
    args: ['--with-outcome', PROMPT_ID],
  }));

  const body = server.lastCall('POST', '/v2/control/outcome').body;
  assert.equal(body.outcome, 'success');
  assert.equal(body.signal, 0.2);
  assert.deepEqual(body.entry_ids, ['ref_rule_1', 'ref_lesson_1']);
  assert.ok(body.rationale.includes('memory-term-echo/v1'),
    `the rationale must name the method that decided this: ${body.rationale}`);
});

// A turn that failed is not proof the memory was wrong when nothing shows the memory was
// used at all. -0.3 against an entry the model never touched is the same mistake as +0.2,
// pointed the other way.
test('drain --with-outcome: a failed turn with no evidence of use is not punished for it', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  seedSpool(dataDir, 1);
  seedMeasuredTurn(dataDir, false, { outcome: 'failure' });

  assertHookContract(await runHook('drain', stop(), {
    env: envFor(dataDir, server.url),
    args: ['--with-outcome', PROMPT_ID],
  }));

  const body = server.lastCall('POST', '/v2/control/outcome').body;
  assert.equal(body.outcome, 'neutral');
  assert.equal(body.signal, 0);
  assert.deepEqual(body.entry_ids, []);
});

// §5.5/§6.1: the new record is still implicit attribution. "off" means the hook posts
// nothing, and "explicit" means the model owns the call — a measurement that ignores either
// is a measurement the user did not consent to.
for (const mode of ['off', 'explicit']) {
  test(`drain --with-outcome: outcomeMode "${mode}" silences the neutral record too`, async (t) => {
    const dataDir = makeDataDir();
    const server = await mubit(t);
    seedSpool(dataDir, 1);
    seedMeasuredTurn(dataDir, false);

    assertHookContract(await runHook('drain', stop(), {
      env: envFor(dataDir, server.url, { MUBIT_CC_OUTCOME_MODE: mode }),
      args: ['--with-outcome', PROMPT_ID],
    }));

    server.assertCalled('POST', '/v2/control/ingest', 1);
    server.assertNotCalled('POST', '/v2/control/outcome');
  });
}

// §5.5 step 9 + §7 — the lock is released on every exit path, including after a throw.
// A stuck lock silently stops all capture, which is worse than a rare double drain.
test('drain: releases the lock even when a post-send step throws', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  seedSpool(dataDir, 2);
  // jobs.json as a directory: writing the job_id after the 2xx cannot succeed.
  mkdirSync(join(runDir(dataDir), 'jobs.json'), { recursive: true });

  const r = await runHook('drain', stop(), { env: envFor(dataDir, server.url) });

  assertHookContract(r);
  assert.equal(existsSync(lockPath(dataDir)), false,
    'a throw must not leave drain.lock behind — it would stop all capture for 60s');
  assert.ok(statSync(join(runDir(dataDir), 'jobs.json')).isDirectory());
});

// ---------------------------------------------------------------------------
// --run — draining a run the session has already left
// ---------------------------------------------------------------------------

/*
 * `cwd-changed` spawns this drain for the run a session is walking away from, and then
 * rewrites `sessions/<host_session_id>.json` to name the new one. A detached child that
 * re-derived would read whichever version of that file it happened to win the race against,
 * so the run it must drain is passed on the argv instead of being worked out.
 *
 * The two runs here differ in every input the derivation has: the pin in the environment
 * says one thing, the flag says another, and only the flag may be obeyed.
 */
test('drain --run: drains the named run and ignores the derivation', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  const LEFT = 'cc-left-behind-0000';

  // Two spools: the run this process would derive, and the run it is told to drain.
  seedSpool(dataDir, 2);
  const leftDir = join(dataDir, 'runs', LEFT, 'spool');
  mkdirSync(leftDir, { recursive: true });
  writeFileSync(join(leftDir, `${Date.now()}-000000.json`),
    JSON.stringify(spoolItem({ item_id: 'cc-orphan-1', text: 'left behind by a cd' })));

  const r = await runHook('drain', stop(), {
    env: envFor(dataDir, server.url),
    args: ['--run', LEFT],
  });

  assertHookContract(r);
  server.assertCalled('POST', '/v2/control/ingest', 1);
  const body = server.lastCall('POST', '/v2/control/ingest').body;
  assert.equal(body.run_id, LEFT,
    'the batch must be attributed to the run named on the argv, not to MUBIT_CC_RUN_ID');
  assert.deepEqual(body.items.map((i) => i.item_id), ['cc-orphan-1']);

  assert.equal(spoolFiles(dataDir, LEFT).length, 0, 'the named run is drained');
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 2,
    'the run this process would have derived is left alone entirely');
});

// A pin that could only name the poisoned shared run is refused, exactly as a derivation
// that could only answer `"default"` is (§4.3). The spool waits for a run id worth writing to.
test('drain --run: a "default" pin drains nothing', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  seedSpool(dataDir, 2);

  const r = await runHook('drain', stop(), {
    env: envFor(dataDir, server.url),
    args: ['--run', 'default'],
  });

  assertHookContract(r);
  assert.equal(server.requests.length, 0, `saw unexpected HTTP: ${server.summary()}`);
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 2);
});
