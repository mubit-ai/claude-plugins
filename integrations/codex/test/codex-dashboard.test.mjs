// @ts-check
/**
 * The committed `bin/dashboard.mjs` — what the Codex `dashboard` skill actually runs.
 *
 * Same reasoning as `codex-auth.test.mjs`: the behaviour lives in the sibling's shared
 * source and is tested there; what had zero coverage is this artifact. The lifecycle is
 * exercised the only honest way — a real detached process — because `--serve` writes a
 * state file naming its own pid and `--stop` kills that pid; run in-process, a passing
 * test and a killed test runner look identical.
 *
 * Three properties matter to the manual guide this mirrors: the state file
 * (`dashboard/server.json`) is owner-only, the API answers nothing without the bearer
 * token it holds, and `--stop` through the same bundle actually takes the server down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { CODEX_ROOT, SHARED_ROOT, baseEnv, fakeMubit, makeDataDir } from './helpers/codex-fixtures.mjs';
import { lib, mod } from '../../claude-code/test/helpers/harness.mjs';
import {
  RUN, PROMPT, SESSION, seedRun, writeLedger, lessonActivity, lessonsRoute,
} from '../../claude-code/test/helpers/dashboard-fixtures.mjs';

const BUNDLE = join(CODEX_ROOT, 'bin', 'dashboard.mjs');

test('the bundle exists and stays inert on import', async () => {
  assert.ok(existsSync(BUNDLE), 'the committed bundle is what ships; it must be there');
  const m = await import(`file://${BUNDLE}?codex-dashboard-guard=1`);
  assert.equal(typeof m.main, 'function',
    'importing must expose main() without running it — the entry guard');
});

test('lifecycle: detached --serve, owner-only state, token-gated API, --stop', async (t) => {
  const upstream = await fakeMubit();
  t.after(() => upstream.close());
  const dataDir = makeDataDir();
  const env = baseEnv({ dataDir, endpoint: upstream.url });
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(env);
  // The shared source module, for the state-file helpers only; the process under test
  // is the committed Codex bundle.
  const dash = await mod('bin/dashboard.src.mjs');

  const child = spawn(process.execPath, [BUNDLE, '--serve'], {
    detached: true, stdio: 'ignore', env,
  });
  child.unref();
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ } });

  await waitFor(() => existsSync(dash.statePath(cfg)), 10000,
    'the detached server never published its port');
  const state = dash.readState(cfg);
  assert.ok(state && state.port > 0 && state.token, `unusable state file: ${JSON.stringify(state)}`);
  assert.equal(state.pid, child.pid, 'the file names the process that wrote it');

  if (process.getuid?.() !== 0) {
    const mode = statSync(dash.statePath(cfg)).mode & 0o777;
    assert.equal(mode, 0o600, `the state file holds a live token; mode was ${mode.toString(8)}`);
  }

  // No token, no answer — the state file's 0600 is only worth something if the token
  // it protects is actually required.
  const bare = await fetch(`http://127.0.0.1:${state.port}/api/ping`);
  assert.equal(bare.status, 401, 'an unauthenticated request must be refused');

  const ping = await fetch(`http://127.0.0.1:${state.port}/api/ping`, {
    headers: { authorization: `Bearer ${state.token}` },
  });
  assert.equal(ping.status, 200);
  assert.equal((await ping.json()).service, 'mubit-dashboard');

  // Stop through the same artifact a user's skill would run.
  const stop = await new Promise((res, rej) => {
    const c = spawn(process.execPath, [BUNDLE, '--stop'], { env, stdio: 'ignore' });
    const timer = setTimeout(() => { c.kill('SIGKILL'); rej(new Error('--stop hung')); }, 10000);
    c.on('close', (code) => { clearTimeout(timer); res(code); });
    c.on('error', rej);
  });
  assert.equal(stop, 0);
  assert.equal(existsSync(dash.statePath(cfg)), false, '--stop clears the state file');

  await waitFor(async () => {
    try {
      await fetch(`http://127.0.0.1:${state.port}/api/ping`);
      return false;
    } catch {
      return true;
    }
  }, 5000, '--stop did not actually stop the server');
});

/** Poll a predicate until it holds, or fail with a message that says what did not happen. */
async function waitFor(pred, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => { setTimeout(r, 25); });
  }
  assert.fail(`${message} (waited ${timeoutMs}ms)`);
}

/** A turn whose file the 6-hour sweep has already taken; only its ledger row remains. */
const PRUNED = '33333333-2222-3333-4444-555555555555';

/**
 * The lesson-flow surface, proven on this artifact: the page the bundle serves is the shared
 * one (five pages behind the rail), `/api/overview` and `/api/turns` read the ledger a Codex
 * Stop hook appends, `/api/lessons` carries the injected count from it, and one verdict posts
 * one outcome for the turn's recalled ids. Every behaviour is tested in the sibling suite; what
 * this proves is that the committed Codex bundle carries all of it.
 */
test('the page and the lesson-flow routes ship in this bundle: overview, ledger turns, lesson counts, verdict', async (t) => {
  const upstream = await fakeMubit(lessonsRoute([lessonActivity({ success_count: 2 })]));
  t.after(() => upstream.close());
  const dataDir = makeDataDir();
  const env = baseEnv({ dataDir, endpoint: upstream.url });
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(env);
  const dash = await mod('bin/dashboard.src.mjs');
  const L = await lib('ledger.mjs');

  seedRun(dataDir);
  const startedAt = Date.now() - 60_000;
  writeLedger(dataDir, RUN, [L.turnLedgerRow({
    prompt: 'the pruned one', prompt_id: PRUNED, session_id: SESSION, started_at: startedAt,
    ended_at: startedAt + 5000, recalled: ['ref_lesson_1', 'ref_lesson_2'],
    recall: { tokens: 90, chars: 300, sources: 2, rung: 1 },
    used_evidence: { used: true, matched: 1, candidates: 2 },
  }, RUN, startedAt + 5000)]);

  const child = spawn(process.execPath, [BUNDLE, '--serve'], { detached: true, stdio: 'ignore', env });
  child.unref();
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ } });
  await waitFor(() => existsSync(dash.statePath(cfg)), 10000, 'the detached server never published its port');
  const state = dash.readState(cfg);
  const base = `http://127.0.0.1:${state.port}`;
  const call = (path, init = {}) => fetch(base + path, {
    ...init, headers: { authorization: `Bearer ${state.token}`, ...(init.headers || {}) },
  });

  // The page: the shared file, served byte for byte, with the five pages on its rail.
  const page = await fetch(`${base}/?token=${encodeURIComponent(state.token)}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  for (const id of ['nav-overview', 'nav-turns', 'nav-lessons', 'nav-feed', 'nav-health']) {
    assert.ok(html.includes(`id="${id}"`), `the served page has no ${id}`);
  }
  assert.equal(html, readFileSync(join(SHARED_ROOT, 'bin', 'dashboard.html'), 'utf8'),
    'the Codex bundle serves the shared page, not a stale copy');

  // Overview: the ledger row is the one turn inside the window; the live fixture turns are old.
  const o = await (await call(`/api/overview?run=${RUN}&family=1&days=7`)).json();
  assert.equal(o.kpi.turns, 1);
  assert.equal(o.kpi.injectedRefs, 2);
  assert.equal(o.series.length, 7);
  assert.deepEqual(o.topInjected.map((x) => x.id).sort(), ['ref_lesson_1', 'ref_lesson_2']);

  // Turns: the pruned turn is served from its ledger row, beside the live one.
  const turns = (await (await call(`/api/turns?run=${RUN}&family=1`)).json()).turns;
  assert.equal(turns.find((x) => x.promptId === PRUNED)?.source, 'ledger');
  assert.equal(turns.find((x) => x.promptId === PROMPT)?.source, 'live');

  // Lessons: the instance's counter and the ledger's injected count on one row.
  const lessons = (await (await call(`/api/lessons?run=&currentRun=${RUN}&dir=${encodeURIComponent(dataDir)}&family=1`)).json()).lessons;
  const lesson = lessons.find((x) => x.id === 'ref_lesson_1');
  assert.ok(lesson, `ref_lesson_1 is not on the Lessons page: ${JSON.stringify(lessons).slice(0, 300)}`);
  assert.equal(lesson.successCount, 2);
  assert.equal(lesson.injectedCount, 2, 'injected by the live turn and by the ledger row');

  // Verdict: one outcome for the turn's recalled ids, credited to the user rather than a hook.
  const res = await call('/api/verdict', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir: dataDir, run: RUN, promptId: PROMPT, success: true }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.equal(JSON.parse(text).verdict, 'worked');
  upstream.assertCalled('POST', '/v2/control/outcome', 1);
  const wire = upstream.lastCall('POST', '/v2/control/outcome').body;
  assert.equal(wire.reference_id, 'global');
  assert.equal(wire.outcome, 'success');
  assert.deepEqual(wire.entry_ids, ['ref_lesson_1']);
  assert.ok(!('agent_id' in wire) && !('success' in wire));
  assert.ok(existsSync(join(dataDir, 'dashboard', `verdicts-${RUN}.jsonl`)), 'verdicts live under dashboard/');

  const stop = await new Promise((res2, rej) => {
    const c = spawn(process.execPath, [BUNDLE, '--stop'], { env, stdio: 'ignore' });
    const timer = setTimeout(() => { c.kill('SIGKILL'); rej(new Error('--stop hung')); }, 10000);
    c.on('close', (code) => { clearTimeout(timer); res2(code); });
    c.on('error', rej);
  });
  assert.equal(stop, 0);
});
