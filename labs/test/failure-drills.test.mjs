// @ts-check
/**
 * Lab 8, pinned: the plugin's behaviour when the instance misbehaves. The rule above all
 * four drills is the plugin's own: each failure costs a memory, never a turn - every hook
 * exits 0 with parseable output no matter what the wire does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, labState, startFake, runHook, deriveLabRunId, spoolItems, eventually } from './helpers.mjs';

/** A bench with its own fake on `scenario`, torn down by the caller. */
async function bench(scenario) {
  const st = labState();
  st.env.LAB_RUN_ID = deriveLabRunId(st.env);
  const fake = await startFake(st, { scenario });
  return { st, fake, run: st.env.LAB_RUN_ID };
}

// ---------------------------------------------------------------------------------------
// 8a - the operator disabled direct_bypass
// ---------------------------------------------------------------------------------------

test('8a: by default a 403 goes dark and is cached - the descent costs an LLM call and is opt-in', async () => {
  const { st, fake } = await bench('deny-direct');
  try {
    const m1 = fake.mark();
    const r1 = runHook(st, 'prompt-recall', '02-prompt.json');
    assert.equal(r1.code, 0);
    assert.deepEqual(r1.json, { suppressOutput: true }, 'nothing injected on a policy denial');
    assert.deepEqual(
      fake.since(m1).filter((q) => q.key.endsWith('query')).map((q) => [q.body.mode, q.status]),
      [['direct_bypass', 403]],
      'no automatic descent: rung 2 is one LLM call per prompt, so it requires MUBIT_CC_RECALL_FALLBACK');

    const m2 = fake.mark();
    runHook(st, 'prompt-recall', '02-prompt.json');
    assert.equal(fake.since(m2).filter((q) => q.key.endsWith('query')).length, 0,
      'the 403 was cached to policy/<endpoint_hash>.json: not even the probe repeats within the TTL');

    const policy = readdirSync(join(st.dataDir, 'policy')).filter((f) => f.endsWith('.json'));
    assert.equal(policy.length, 1, 'the verdict lives in policy/<endpoint_hash>.json');
  } finally {
    await fake.stop(); st.cleanup();
  }
});

test('8a: with the fallback opted in, the ladder descends one rung - never two - and caches the rung', async () => {
  const { st, fake } = await bench('deny-direct');
  st.env.MUBIT_CC_RECALL_FALLBACK = 'agent_routed';
  try {
    const m1 = fake.mark();
    const r1 = runHook(st, 'prompt-recall', '02-prompt.json');
    assert.equal(r1.code, 0);
    assert.deepEqual(
      fake.since(m1).filter((q) => q.key.endsWith('query')).map((q) => [q.body.mode, q.status]),
      [['direct_bypass', 403], ['agent_routed', 200]],
      'one rung down, never two');
    assert.match(r1.json?.hookSpecificOutput?.additionalContext ?? '', /<mubit-memory/,
      'recall still answers - a policy verdict is not a fault');

    const m2 = fake.mark();
    runHook(st, 'prompt-recall', '02-prompt.json');
    assert.deepEqual(
      fake.since(m2).filter((q) => q.key.endsWith('query')).map((q) => [q.body.mode, q.status]),
      [['agent_routed', 200]],
      'the cached 403 sends the next prompt straight to rung 2: one wasted round trip per day, not per prompt');
  } finally {
    await fake.stop(); st.cleanup();
  }
});

// ---------------------------------------------------------------------------------------
// 8b - the server refuses the payload vs the server is broken
// ---------------------------------------------------------------------------------------

test('8b: a 422 quarantines the batch; a second drain does not retry it', async () => {
  const { st, fake, run } = await bench('reject-ingest');
  try {
    runHook(st, 'capture', '03-edit.json');
    assert.equal(spoolItems(st, run).length, 1);

    const drain = () => spawnSync('node',
      [join(REPO_ROOT, 'integrations/claude-code/hooks/src/drain.mjs')],
      { cwd: REPO_ROOT, env: st.env, input: '{"session_id":"s-8b"}', encoding: 'utf8', timeout: 20_000 });

    assert.equal(drain().status, 0);
    assert.equal(spoolItems(st, run).length, 0, 'the batch left the spool');
    const rejected = join(st.dataDir, 'runs', run, 'spool', 'rejected');
    assert.ok(existsSync(rejected) && readdirSync(rejected).length > 0,
      'quarantined, never deleted - retrying a bad payload forever is how a spool becomes unbounded');

    const m = fake.mark();
    assert.equal(drain().status, 0);
    assert.ok(!fake.since(m).some((q) => q.key === 'POST /v2/control/ingest'),
      'the quarantined batch is not offered again');
  } finally {
    await fake.stop(); st.cleanup();
  }
});

test('8b: a 503 leaves the batch spooled for next time', async () => {
  const { st, fake, run } = await bench('fail-ingest');
  try {
    runHook(st, 'capture', '03-edit.json');
    const r = spawnSync('node',
      [join(REPO_ROOT, 'integrations/claude-code/hooks/src/drain.mjs')],
      { cwd: REPO_ROOT, env: st.env, input: '{"session_id":"s-8b2"}', encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0);
    assert.equal(spoolItems(st, run).length, 1,
      "the server's problem: batch still good, every file left in place");
    void fake;
  } finally {
    await fake.stop(); st.cleanup();
  }
});

// ---------------------------------------------------------------------------------------
// 8c - nothing is listening
// ---------------------------------------------------------------------------------------

test('8c: with no server, the model is told in-channel and capture keeps spooling', async () => {
  const st = labState();
  st.env.LAB_RUN_ID = deriveLabRunId(st.env);
  // A port with nothing behind it: bind-and-release would race, so just point at a
  // loopback port from the dynamic range with no listener.
  st.env.MUBIT_ENDPOINT = 'http://127.0.0.1:59999';
  try {
    const ss = runHook(st, 'session-start', '01-session-start.json');
    assert.equal(ss.code, 0, 'a dead server never costs a turn');
    const ctx = ss.json?.hookSpecificOutput?.additionalContext ?? '';
    assert.match(ctx, /offline/i,
      'the offline steer arrives in the same channel memory would have - and says work is kept');

    const cap = runHook(st, 'capture', '03-edit.json');
    assert.equal(cap.code, 0);
    assert.equal(spoolItems(st, st.env.LAB_RUN_ID).length, 1,
      'capture keeps spooling; the next successful drain sends it');

    const breaker = readdirSync(join(st.dataDir, 'breaker')).filter((f) => f.endsWith('.json'));
    assert.ok(breaker.length >= 1, 'the breaker recorded the failure');
  } finally {
    st.cleanup();
  }
});

// ---------------------------------------------------------------------------------------
// 8d - everything is slow
// ---------------------------------------------------------------------------------------

test('8d: a slow instance costs its own budget, never the hook timeout', async () => {
  const { st, fake } = await bench('slow');
  try {
    // The readiness cache would mask the slowness; the drill removes it, so do we.
    const health = join(st.dataDir, 'status', 'health.json');
    if (existsSync(health)) { const { rmSync } = await import('node:fs'); rmSync(health); }

    let t0 = Date.now();
    const pr = runHook(st, 'prompt-recall', '02-prompt.json');
    const prMs = Date.now() - t0;
    assert.equal(pr.code, 0);
    assert.deepEqual(pr.json, { suppressOutput: true },
      'inject nothing rather than make the user wait');
    assert.ok(prMs < 3000, `well inside the 3 s hook timeout (took ${prMs} ms)`);

    t0 = Date.now();
    const ss = runHook(st, 'session-start', '01-session-start.json');
    const ssMs = Date.now() - t0;
    assert.equal(ss.code, 0);
    assert.match(ss.json?.hookSpecificOutput?.additionalContext ?? '', /offline/i,
      'health is the gate: a server that will not answer produces the offline steer');
    assert.ok(ssMs < 2500, `the 400 ms health budget decided early (took ${ssMs} ms)`);

    // Let the slow replies land before teardown so nothing logs into a dead dir.
    await eventually(() => fake.requests().length >= 1, { ms: 4000 });
  } finally {
    await fake.stop(); st.cleanup();
  }
});
