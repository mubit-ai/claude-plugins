// @ts-check
/**
 * The deliberate surface, pinned: Lab 7 (what the server exposes) and Lab 11 (where a
 * tool call actually goes). For several guarantees the route IS the guarantee - both the
 * lessons route and the activity feed answer 200 for the same question, and only one of
 * them is confined - so these tests read the wire, not the answers alone.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { labState, startFake, runHook, driveMcp, deriveLabRunId, marker, eventually } from './helpers.mjs';

/** @type {ReturnType<typeof labState>} */ let st;
/** @type {Awaited<ReturnType<typeof startFake>>} */ let fake;
/** @type {string} */ let RUN;

before(async () => {
  st = labState();
  // Derive the run id BEFORE the fake starts: it reads LAB_RUN_ID at spawn to know which
  // corpus rows are "yours" - env.sh carries the same warning for the hand-run labs.
  RUN = deriveLabRunId(st.env);
  st.env.LAB_RUN_ID = RUN;
  fake = await startFake(st);
});
after(async () => { await fake.stop(); st.cleanup(); });

// ---------------------------------------------------------------------------------------
// Lab 7 - what the server exposes, and the identity agreement
// ---------------------------------------------------------------------------------------

test('lab 7: the launcher serves 13 allowlisted tools, and its session is the hooks\' run id', () => {
  const list = driveMcp(st, '--list');
  assert.equal(list.code, 0, list.stderr);
  const tools = [...list.stdout.matchAll(/^ {2}· (\S+)/gm)].map((m) => m[1]);
  assert.equal(tools.length, 13,
    'the allowlist holds: 13 tools, not everything the upstream server has');
  for (const t of ['mubit_status', 'mubit_recall', 'mubit_learned', 'mubit_lessons', 'mubit_outcome']) {
    assert.ok(tools.includes(t), `${t} is served`);
  }

  const status = driveMcp(st, 'mubit_status');
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /"connected"/);
  assert.ok(status.stdout.includes(RUN),
    'default_session equals the run id the hooks derive - the whole job of launch.mjs');
});

// ---------------------------------------------------------------------------------------
// Lab 11a - the catalogue reads the activity feed, not the route named after it
// ---------------------------------------------------------------------------------------

test('lab 11a: mubit_lessons dials the activity feed and never the lessons route', () => {
  const m = fake.mark();
  const r = driveMcp(st, 'mubit_lessons');
  assert.equal(r.code, 0, r.stderr);
  const keys = fake.since(m).map((q) => q.key);
  assert.ok(keys.includes('POST /v2/control/activity'), `dialled: ${keys.join(', ')}`);
  assert.ok(!keys.includes('POST /v2/control/lessons'),
    'the lessons route pages before it filters - a scoped read there answers zero on a busy account');
});

// ---------------------------------------------------------------------------------------
// Lab 11b - where the run boundary falls
// ---------------------------------------------------------------------------------------

test('lab 11b: a default read shows your rows and global rows - never another run\'s run-scoped lesson', () => {
  const r = driveMcp(st, 'mubit_lessons');
  assert.equal(r.code, 0, r.stderr);
  for (const id of ['les_r1', 'les_s1', 'les_g1', 'les_g2']) {
    assert.ok(r.stdout.includes(id), `${id} is in a default read`);
  }
  assert.ok(!r.stdout.includes('les_r2'),
    'les_r2 is the whole test: run scope is the boundary, and this row is the far side');
  assert.match(r.stdout, /mubit_lessons_guard/,
    'a catalogue that cannot say what it excluded is not one you can act on');
});

test('lab 11b: asking for global moves the boundary on purpose', () => {
  const r = driveMcp(st, 'mubit_lessons', { scope: 'global' });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('les_g1') && r.stdout.includes('les_g2'), 'both global rows');
  for (const id of ['les_r1', 'les_r2', 'les_s1']) {
    assert.ok(!r.stdout.includes(id), `${id} is not global and stays out`);
  }
});

// ---------------------------------------------------------------------------------------
// Lab 11c - a partial answer that says so
// ---------------------------------------------------------------------------------------

test('lab 11c: a truncated feed yields partial:true and no total to act on', async () => {
  const truncSt = labState();
  truncSt.env.LAB_RUN_ID = deriveLabRunId(truncSt.env);
  const truncFake = await startFake(truncSt, { scenario: 'truncate' });
  try {
    const r = driveMcp(truncSt, 'mubit_lessons');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /"partial":\s*true/);
    assert.match(r.stdout, /partial/i);
    assert.ok(!/"matched"\s*:/.test(r.stdout),
      'no matched count beside an admission of partiality - the absence is deliberate');
  } finally {
    await truncFake.stop();
    truncSt.cleanup();
  }
});

// ---------------------------------------------------------------------------------------
// Lab 11d - the write path reaches the widening authority
// ---------------------------------------------------------------------------------------

test('lab 11d: an MCP-only session still reflects at session end', async () => {
  const s2 = labState();
  const run2 = deriveLabRunId(s2.env);
  s2.env.LAB_RUN_ID = run2;
  const f2 = await startFake(s2);
  try {
    runHook(s2, 'session-start', '01-session-start.json');
    await eventually(() => f2.requests().some((q) => q.key === 'POST /v2/control/context'));

    const w = driveMcp(s2, 'mubit_learned', { text: 'The demo app listens on 3000, not 8080.' });
    assert.equal(w.code, 0, w.stderr);
    assert.ok(f2.requests().some((q) => q.key === 'POST /v2/control/ingest'), 'the MCP write went out');

    const mk = await eventually(() => {
      const v = marker(s2, run2);
      return v?.mcp?.ingested >= 1 ? v : null;
    });
    assert.ok(mk?.mcp?.ingested >= 1,
      'the egress guard recorded the MCP ingest on the run marker - the one field joining the two surfaces');
    assert.equal(mk.captured.tools, 0, 'zero hook captures, on purpose');

    const m = f2.mark();
    runHook(s2, 'session-end', '08-session-end.json');
    const reflect = await eventually(() => f2.since(m).find((q) => q.key === 'POST /v2/control/reflect'));
    assert.ok(reflect, 'session end counted the MCP ingest and reflected anyway');
  } finally {
    await f2.stop();
    s2.cleanup();
  }
});
