// @ts-check
/**
 * `session-end` when the user has turned the detached hand-off off.
 *
 * `sessionEndDetach: false` is a supported setting, and it is the configuration in which this
 * hook does its work inside the process Codex started. Two things made that configuration
 * lose the work silently.
 *
 * **The budget was sized for the wrong host.** The inline deadline is 6800 ms, which sits
 * inside Claude Code's `SessionEnd.timeout: 8`. Codex clamps SessionEnd to **3 s** whatever
 * `hooks.json` asks for — recorded against a live host and asserted by
 * `codex-failure.test.mjs` — so 6800 ms is 2.4× the ceiling. Worse, the sub-budgets nested
 * inside it (`DRAIN_MS` 3500, `REFLECT_MS` 4000) are each larger than the whole clamp, so the
 * arithmetic that carves the deadline up hands the drain a window that has already expired.
 *
 * **And the claim marker was written first.** `claimOnce(…'flushed-<session>')` ran before the
 * drain, the outcome flush and the reflect. A hook killed at the 3 s boundary therefore left
 * the session marked flushed with none of it done — and the marker is exactly what makes a
 * later attempt stand down, so nothing ever retried. The user loses the drain *and* the
 * reflect, which is the only path that promotes a lesson beyond its own run.
 *
 * What replaces it is check-early / write-late: the marker is *read* up front so a second
 * SessionEnd stands down, and *written* after the work it claims. `claimOnce`'s own docstring
 * already argues the trade in the remaining case — "losing a session's captures is worse than
 * sending them twice", and the batch idempotency key lets the server collapse a double send.
 */

import test from 'node:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  assert, baseEnv, defaultRoutes, fakeMubit, makeDataDir, makeProjectDir, runHook, sessionEnd,
  postToolUse, spoolFiles,
} from './helpers/codex-fixtures.mjs';

const RUN_ID = 'codex-session-end-test';

/** Codex's own ceiling for this event, whatever `hooks.json` asks for. */
const CODEX_SESSION_END_CLAMP_MS = 3000;

/**
 * A Mubit that answers slowly — which is the only condition under which a budget is a budget.
 *
 * Against the instant fake server every one of these hooks finishes in well under a second and
 * a 6800 ms deadline is indistinguishable from a 2300 ms one. The numbers below are ordinary
 * for a hosted instance: `codex-failure.test.mjs` already records a real reflect tail at
 * 9626 ms, and the plugin's own inline reflect budget is 4000 — larger, by itself, than the
 * entire clamp this hook runs under.
 */
function slowMubit(o = {}) {
  return fakeMubit({
    ...defaultRoutes(),
    'POST /v2/control/ingest': {
      json: { accepted: true, job_id: 'job_test_1', deduplicated: false, status: 'queued' },
      delayMs: o.ingestMs ?? 250,
    },
    'POST /v2/control/reflect': {
      json: { lessons: [], summary: 'ok', confidence: 0.5, degraded: false, lessons_stored: 0 },
      delayMs: o.reflectMs ?? 5000,
    },
  });
}

function inlineEnv(dataDir, endpoint) {
  return baseEnv({
    dataDir,
    projectDir: makeProjectDir({ git: true }),
    endpoint,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: RUN_ID,
      // The setting this whole file is about.
      MUBIT_CC_SESSION_END_DETACH: '0',
    },
  });
}

/** The `flushed-<session>.marker` files under this run, which is the claim itself. */
const flushedMarkers = (dataDir) => {
  const dir = join(dataDir, 'runs', RUN_ID);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith('flushed-'));
};

// ===========================================================================

test('an inline session-end returns inside Codex`s 3s clamp', async (t) => {
  const server = await slowMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const env = inlineEnv(dataDir, server.url);

  await runHook('capture', postToolUse(), { env });

  const started = Date.now();
  const r = await runHook('session-end', sessionEnd(), { env, timeoutMs: 20_000 });
  const ms = Date.now() - started;

  assert.notEqual(r.code, 2, 'session-end must never be read as a block');
  assert.ok(ms < CODEX_SESSION_END_CLAMP_MS,
    `inline session-end took ${ms}ms. Codex kills it at ${CODEX_SESSION_END_CLAMP_MS}ms, so `
    + 'everything still inside the hook at that point dies with it. The inline budget is sized '
    + 'for Claude Code`s 8s timeout — 2.4x the ceiling that actually applies here.');
});

test('the work is done before the session is marked flushed', async (t) => {
  // § Slow enough that a kill at 700 ms is guaranteed to land before anything was delivered.
  const server = await slowMubit({ ingestMs: 2500 });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const env = inlineEnv(dataDir, server.url);

  await runHook('capture', postToolUse(), { env });

  // § Killed a quarter of the way into the clamp — which is what a slow network, a cold
  //   breaker or a loaded machine looks like from the hook's point of view, and what Codex
  //   itself does at 3 s.
  const r = await runHook('session-end', sessionEnd(), { env, killAfterMs: 700 });
  assert.equal(r.signal, 'SIGKILL', 'the kill has to actually land for this to test anything');

  // § "Still spooled" is the signal, not "no request arrived". The fake server counts a
  //   request when it arrives; the batch commits only once the reply comes back, so a hook
  //   killed mid-drain has sent bytes and delivered nothing.
  const pending = spoolFiles(dataDir, RUN_ID);
  assert.ok(pending.length,
    'the spool is empty, so the kill landed after the drain committed and this test is not '
    + 'exercising what it claims to.');

  assert.deepEqual(flushedMarkers(dataDir), [],
    'the hook was killed with the spool still full, and it had already written the '
    + '`flushed-<session>` marker. That marker is what makes every later attempt stand down — '
    + 'so the drain and the reflect are both lost, and nothing is left that would retry them. '
    + 'The claim must be written after the work it claims, not before it.');
});

test('a completed inline session-end does mark the session flushed', async (t) => {
  // § Fast server: this is about the run that DOES finish, and it must still record the claim.
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const env = inlineEnv(dataDir, server.url);

  await runHook('capture', postToolUse(), { env });
  const r = await runHook('session-end', sessionEnd(), { env, timeoutMs: 20_000 });
  assert.equal(r.code, 0);

  assert.ok(flushedMarkers(dataDir).length,
    'a run that finished must still record the claim, or a second SessionEnd for the same '
    + 'session does the whole flush again.');
});

test('a second session-end for the same session stands down', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const env = inlineEnv(dataDir, server.url);

  await runHook('capture', postToolUse(), { env });
  await runHook('session-end', sessionEnd(), { env, timeoutMs: 20_000 });
  const afterFirst = server.countOf('POST', '/v2/control/reflect');

  await runHook('session-end', sessionEnd(), { env, timeoutMs: 20_000 });
  assert.equal(server.countOf('POST', '/v2/control/reflect'), afterFirst,
    'the second SessionEnd reflected again. The claim marker exists to make this idempotent '
    + 'across the several ways a session can end.');
});

test('the drain still commits inside the clamp', async (t) => {
  // § A slow reflect must not eat the drain's window. The drain commits first precisely so a
  //   lost reflect costs scope promotion and never the captures themselves.
  const server = await slowMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const env = inlineEnv(dataDir, server.url);

  await runHook('capture', postToolUse(), { env });
  await runHook('session-end', sessionEnd(), { env, timeoutMs: 20_000 });

  assert.ok(server.countOf('POST', '/v2/control/ingest') > 0,
    'nothing was ingested. With DRAIN_MS (3500) larger than the whole 3s clamp, the deadline '
    + 'arithmetic hands the drain a window that has already expired — so the captures the '
    + 'session made never leave the machine at all.');
});
