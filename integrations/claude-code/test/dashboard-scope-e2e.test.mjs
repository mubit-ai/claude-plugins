// @ts-check
/**
 * The Memory tab's scope filter, end to end: a real detached server, a seeded fake
 * instance, and the same HTTP calls the page makes.
 *
 * `test/dashboard-api.test.mjs` proves `lessonsPayload` filters rows in process, and
 * `test/dashboard-page.test.mjs` proves the HTML carries the controls — but nothing ran
 * the *shipped server* over the wire and asked for one scope at a time. That is the path
 * the `c1fb7d3` fix changed (session and global used to be one entangled toggle), and it
 * is the path the manual test guide walks, so it is verified here the same way: launch,
 * token, `/api/lessons?scope=…`, read the envelope.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  PLUGIN_ROOT, baseEnv, fakeMubit, lib, makeDataDir, mod,
} from './helpers/harness.mjs';

/** One activity-feed lesson row, in the shape the census reads scope out of. */
function feedLesson(id, scope, runId, content) {
  return {
    id,
    created_at: `2026-02-0${1 + (id.charCodeAt(id.length - 1) % 5)}T00:00:00Z`,
    entry_type: 'lesson',
    run_id: runId,
    content,
    source: `reflection:${runId}`,
    metadata_json: JSON.stringify({ scope, lesson_type: 'rule', importance: 'high' }),
  };
}

/** The same swap `mod()` makes: under the dist target, run what ships. */
const SCRIPT = process.env.MUBIT_CC_TEST_TARGET === 'dist'
  && existsSync(join(PLUGIN_ROOT, 'bin', 'dashboard.mjs'))
  ? join(PLUGIN_ROOT, 'bin', 'dashboard.mjs')
  : join(PLUGIN_ROOT, 'bin', 'dashboard.src.mjs');

test('the live /api/lessons filters session and global independently', async (t) => {
  const upstream = await fakeMubit({
    'POST /v2/control/activity': {
      json: {
        entries: [
          feedLesson('les_run_1', 'run', 'cc-this-run', 'Kept to its own run.'),
          feedLesson('les_session_1', 'session', 'cc-this-run', 'Survives the run boundary.'),
          feedLesson('les_global_1', 'global', 'cc-other-run', 'Standing rule for every run.'),
        ],
        next_page_token: '',
        total_visible: 3,
      },
    },
  });
  t.after(() => upstream.close());

  const dataDir = makeDataDir();
  const env = baseEnv({ dataDir, endpoint: upstream.url });
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(env);
  const dash = await mod('bin/dashboard.src.mjs');

  const child = spawn(process.execPath, [SCRIPT, '--serve'], {
    detached: true, stdio: 'ignore', env,
  });
  child.unref();
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ } });

  await waitFor(() => existsSync(dash.statePath(cfg)), 10000,
    'the detached server never published its port');
  const state = dash.readState(cfg);
  assert.ok(state && state.port > 0 && state.token, `unusable state file: ${JSON.stringify(state)}`);

  /** @param {string} qs */
  const lessonsAt = async (qs) => {
    const res = await fetch(`http://127.0.0.1:${state.port}/api/lessons${qs}`, {
      headers: { authorization: `Bearer ${state.token}` },
    });
    assert.equal(res.status, 200, `GET /api/lessons${qs} answered ${res.status}`);
    return res.json();
  };

  // No filter: the whole census, with the counts the facet chips render.
  const all = await lessonsAt('');
  assert.deepEqual(all.lessons.map((l) => l.id).sort(),
    ['les_global_1', 'les_run_1', 'les_session_1']);
  assert.deepEqual(all.scopeCounts, { run: 1, session: 1, global: 1 });

  // One scope at a time — the two the page offers as independent toggles. Before
  // `c1fb7d3` these were entangled: selecting one changed what the other returned.
  const session = await lessonsAt('?scope=session');
  assert.deepEqual(session.lessons.map((l) => l.id), ['les_session_1'],
    'scope=session must return exactly the session lesson');
  assert.equal(session.hidden, 2, 'the other two are hidden, not gone');

  const global_ = await lessonsAt('?scope=global');
  assert.deepEqual(global_.lessons.map((l) => l.id), ['les_global_1'],
    'scope=global must return exactly the global lesson');

  // The filter runs over the collected rows, never on the wire (§ the census comment):
  // both scoped queries reached the same activity route with no scope parameter.
  for (const call of upstream.calls('POST', '/v2/control/activity')) {
    assert.ok(!('scope' in (call.body ?? {})),
      'scope must not be forwarded upstream — the route would filter after limit');
  }
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
