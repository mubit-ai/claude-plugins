// @ts-check
/**
 * `bin/statusline.mjs` — build-guide §10 (and §16.2 for the degradation path).
 *
 * The status line is the only part of this plugin that runs on every frame of the
 * host UI. Three properties matter more than anything it prints:
 *
 *   1. It is network-free. It reads `status/<run_id>.json` and `breaker/<hash>.json`
 *      and nothing else. A status line that dials Mubit turns a dead server into a
 *      visibly frozen terminal.
 *   2. It is fast. The real target is < 15ms; a slow status line makes the whole UI
 *      feel sluggish even when nothing else is wrong.
 *   3. It never throws. On a fresh install — before the first SessionStart — there is
 *      no state at all, and that is the state every user is in for their first few
 *      seconds. A stack trace there is the first thing they would ever see of this
 *      plugin.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PLUGIN_ROOT, makeDataDir, makeProjectDir, tempDir, baseEnv, fakeMubit, lib,
} from './helpers/harness.mjs';

// ---------------------------------------------------------------------------
// Running the status line
// ---------------------------------------------------------------------------

/**
 * Prefer the committed bundle; fall back to the source entry so the suite is usable
 * before the first `npm run build` (§11.2).
 */
function statuslineScript() {
  const built = join(PLUGIN_ROOT, 'bin', 'statusline.mjs');
  const src = join(PLUGIN_ROOT, 'bin', 'statusline.src.mjs');
  if (existsSync(built)) return built;
  if (existsSync(src)) return src;
  return assert.fail(
    `bin/statusline.mjs does not exist yet (nor bin/statusline.src.mjs) under ${PLUGIN_ROOT}.\n` +
    '  Build-guide §10 defines it; §11.2 bundles statusline.src.mjs → statusline.mjs.');
}

/**
 * Claude Code hands the status-line command a JSON blob about the session on stdin.
 * @param {Record<string, any>} [over]
 */
function statuslineStdin(over = {}) {
  return JSON.stringify({
    session_id: '4f21ab90-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
    cwd: over.cwd ?? '/Users/x/repo',
    model: { id: 'claude-opus-5', display_name: 'Opus' },
    workspace: { current_dir: over.cwd ?? '/Users/x/repo', project_dir: over.cwd ?? '/Users/x/repo' },
    ...over,
  });
}

/**
 * @param {{env: Record<string,string>, stdin?: string, timeoutMs?: number}} o
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, ms:number, line:string}>}
 */
async function runStatusline(o) {
  const script = statuslineScript();
  const started = Date.now();
  const child = spawn(process.execPath, [script], { env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.stdin.end(o.stdin ?? statuslineStdin());

  const code = await new Promise((res, rej) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); rej(new Error('statusline exceeded its timeout')); },
      o.timeoutMs ?? 10000);
    child.on('close', (c) => { clearTimeout(t); res(c); });
    child.on('error', (e) => { clearTimeout(t); rej(e); });
  });

  return { code, stdout: out, stderr: err, ms: Date.now() - started, line: out.trim() };
}

// ---------------------------------------------------------------------------
// Seeding the two files the status line is allowed to read (§7)
// ---------------------------------------------------------------------------

/** The run id the hooks would derive for this env — the marker is keyed by it (§4.3). */
async function derivedRunId(env) {
  const { loadConfig } = await lib('config.mjs');
  const { deriveRunId } = await lib('runid.mjs');
  return deriveRunId(loadConfig(env), {});
}

/** A complete §4.8 Marker, overridable field by field. */
function marker(runId, over = {}) {
  const now = Date.now();
  return {
    run_id: runId,
    mode: 'local',
    state: 'ready',
    updated_at: now,
    cold_start_until: now - 60_000, // cold start already elapsed unless a test says otherwise
    recall: { sources: 6, tokens: 1187, ms: 842, empty_reason: '', rung: 1, dropped: 0 },
    captured: { tools: 12, turns: 1, pending: 0 },
    lessons: { global: 3, checked_at: now },
    reflect: { at: now, lessons_stored: 3, status: 'ok' },
    last_error: '',
    ...over,
  };
}

function seedMarker(dataDir, runId, over = {}) {
  const dir = join(dataDir, 'status');
  mkdirSync(dir, { recursive: true });
  const m = marker(runId, over);
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify(m));
  return m;
}

/**
 * Breaker state file. §4.7 names it `breaker/<sha256(endpoint).slice(0,12)>.json`; the
 * digest encoding is not pinned in the guide, so the identical payload is written under
 * every plausible spelling. All three carry the same content, so an implementation that
 * globs the directory cannot pick a "wrong" one.
 */
function seedBreaker(dataDir, endpoint, state) {
  const dir = join(dataDir, 'breaker');
  mkdirSync(dir, { recursive: true });
  const hex = createHash('sha256').update(endpoint).digest('hex');
  const b64 = createHash('sha256').update(endpoint).digest('base64url');
  const body = JSON.stringify({
    failures: [], timeoutStreak: 0, lastOkAt: 0, lastState: state.state, ...state,
  });
  for (const name of [hex.slice(0, 12), hex, b64.slice(0, 12)]) {
    writeFileSync(join(dir, `${name}.json`), body);
  }
}

/** A deterministic env pointing at a throwaway data dir and a non-git project dir. */
function env(dataDir, extra = {}) {
  return baseEnv({
    dataDir,
    projectDir: makeProjectDir(),
    extra: {
      MUBIT_CC_STATUSLINE: '1',
      MUBIT_CC_BREAKER_COOLDOWN_MS: '120000',
      MUBIT_CC_COLDSTART_GRACE_MS: '20000',
      ...extra,
    },
  });
}

/** Guards against the one output the user must never see from a status line. */
function assertNoStackTrace(r) {
  assert.equal(r.code, 0, `status line must exit 0, got ${r.code}. stderr:\n${r.stderr}`);
  assert.ok(!/^\s+at\s/m.test(r.stderr),
    `status line printed a stack trace — §16.2: a fresh install must never see one:\n${r.stderr}`);
}

// ---------------------------------------------------------------------------
// §10 — network-free
// ---------------------------------------------------------------------------

// §10 — "network-free" is the load-bearing property. If the status line dials Mubit,
// every frame of the host UI is coupled to a remote server's latency.
test('makes zero network requests — it only reads local state', async () => {
  const server = await fakeMubit();
  try {
    const dataDir = makeDataDir();
    const e = env(dataDir, { MUBIT_ENDPOINT: server.url });
    const runId = await derivedRunId(e);
    seedMarker(dataDir, runId);

    const r = await runStatusline({ env: e });
    assertNoStackTrace(r);
    assert.equal(server.requests.length, 0,
      `status line made ${server.requests.length} request(s): ${server.summary()} — §10 says it reads only status/<run_id>.json and breaker/<hash>.json`);
    assert.ok(r.line.length > 0, 'expected one rendered status line');
  } finally {
    await server.close();
  }
});

// §10 — the real budget is 15ms. The ceiling asserted here is deliberately generous
// (node's own cold start is most of it on CI); it exists to catch an implementation
// that grew a directory walk, a spawn, or a socket.
test('renders well inside its budget (real target < 15ms; ceiling here is generous)', async () => {
  const dataDir = makeDataDir();
  const e = env(dataDir);
  const runId = await derivedRunId(e);
  seedMarker(dataDir, runId);

  const samples = [];
  for (let i = 0; i < 3; i++) samples.push((await runStatusline({ env: e })).ms);
  const best = Math.min(...samples);
  assert.ok(best < 300,
    `fastest of three status-line renders took ${best}ms including node startup (samples ${samples.join('/')}ms). ` +
    'The §10 target is <15ms of work; a number this high means it is doing I/O it should not.');
});

// §10 — the documented line. Example from the guide:
//   ● mubit: cc-my-project-9f2a11c4 · local · recall 6/1.2k tok · saved 12t/1q · lessons 3g
// The run id is whatever §4.3 derives for this directory, so it is substituted here.
test('renders the documented shape: glyph, run, mode, recall, saved, lessons', async () => {
  const dataDir = makeDataDir();
  const e = env(dataDir);
  const runId = await derivedRunId(e);
  seedMarker(dataDir, runId);

  const r = await runStatusline({ env: e });
  assertNoStackTrace(r);
  assert.equal(r.line.split('\n').length, 1, `status line must print exactly one line, got:\n${r.stdout}`);
  assert.equal(r.line,
    `● mubit: ${runId} · local · recall 6/1.2k tok · saved 12t/1q · lessons 3g`);
});

// ---------------------------------------------------------------------------
// §10 — glyph precedence: worst state wins, top to bottom
// ---------------------------------------------------------------------------

/**
 * §10 precedence, worst first:
 *   ✖ auth failed > ✖ unreachable > ▲ server error > ◌ slow > ◍ warming > ● ready
 */
const PRECEDENCE = [
  { state: 'auth_failed', glyph: '✖', label: 'auth failed' },
  { state: 'unreachable', glyph: '✖', label: 'unreachable' },
  { state: 'server_error', glyph: '▲', label: 'server error' },
  { state: 'not_responding', glyph: '◌', label: 'slow' },
  { state: 'ready', glyph: '●', label: '' },
];

for (let i = 0; i < PRECEDENCE.length - 1; i++) {
  const worse = PRECEDENCE[i];
  const lesser = PRECEDENCE[i + 1];

  // §10 — two sources can disagree (the marker was written by the last hook, the breaker
  // file by the last failure). The worse of the two is what the user needs to see.
  test(`glyph precedence: ${worse.state} beats ${lesser.state} whichever source reports it`, async () => {
    for (const [markerState, breakerState] of [[lesser.state, worse.state], [worse.state, lesser.state]]) {
      const dataDir = makeDataDir();
      const e = env(dataDir);
      const runId = await derivedRunId(e);
      seedMarker(dataDir, runId, { state: markerState });
      seedBreaker(dataDir, e.MUBIT_ENDPOINT, { state: breakerState, openedAt: 0 });

      const r = await runStatusline({ env: e });
      assertNoStackTrace(r);
      assert.ok(r.line.startsWith(worse.glyph),
        `marker=${markerState} breaker=${breakerState}: expected the worse state ${worse.state} (${worse.glyph}), got: ${r.line}`);
      if (worse.label) {
        assert.ok(r.line.includes(worse.label),
          `marker=${markerState} breaker=${breakerState}: expected label ${JSON.stringify(worse.label)} in: ${r.line}`);
      }
    }
  });
}

// §4.7 — within coldStartGraceMs of SessionStart a failure is not a verdict. A user who
// whose instance is still starting must not be told memory is broken for the
// first seconds it spends warming up.
test('cold start renders ◍ warming rather than a failure glyph', async () => {
  const dataDir = makeDataDir();
  const e = env(dataDir);
  const runId = await derivedRunId(e);
  seedMarker(dataDir, runId, {
    state: 'unreachable',
    cold_start_until: Date.now() + 20_000,
  });

  const r = await runStatusline({ env: e });
  assertNoStackTrace(r);
  assert.ok(r.line.startsWith('◍'), `expected ◍ during cold start, got: ${r.line}`);
  assert.ok(r.line.includes('warming'), `expected the "warming" label, got: ${r.line}`);
});

// The decision phase-2-recall.md leaves open, now recorded: cold start suppresses
// `not_responding` as well. §10 ranks ◍ warming *below* ◌ slow; §4.7 says failures inside the
// grace window do not show a failure glyph at all. §4.7 wins, because the two sections answer
// different questions — §10 ranks two simultaneous facts, §4.7 decides whether a fact is a
// verdict yet, and that is asked first.
//
// The suite settles it either way: the test above pins that `unreachable` — which §10 ranks
// strictly WORSE than `not_responding` — is suppressed to ◍. Letting the milder symptom through
// while hiding the worse one would show the scarier glyph for the healthier server. And a
// timeout is the single most likely thing to happen while Mubit spends its first ten seconds
// still warming up, so the other reading would make ◌ the normal cold-start display and leave
// ◍ nearly unreachable — inverting the point of the grace window.
test('cold start suppresses not_responding too — the ◌/◍ pair §10 and §4.7 disagree on', async () => {
  const dataDir = makeDataDir();
  const e = env(dataDir);
  const runId = await derivedRunId(e);
  seedMarker(dataDir, runId, { state: 'not_responding', cold_start_until: Date.now() + 20_000 });

  const r = await runStatusline({ env: e });
  assertNoStackTrace(r);
  assert.ok(r.line.startsWith('◍'),
    `a timeout streak inside the grace window is not a verdict (§4.7), got: ${r.line}`);
  assert.ok(!r.line.includes('slow'), `expected "warming", not "slow", got: ${r.line}`);
});

// §10 — warming outranks ready: a run that has not proven itself yet is not "ready".
test('cold start beats ready in the precedence order', async () => {
  const dataDir = makeDataDir();
  const e = env(dataDir);
  const runId = await derivedRunId(e);
  seedMarker(dataDir, runId, { state: 'ready', cold_start_until: Date.now() + 20_000 });

  const r = await runStatusline({ env: e });
  assertNoStackTrace(r);
  assert.ok(r.line.startsWith('◍'), `expected ◍ warming to outrank ● ready, got: ${r.line}`);
});

// §4.7 — auth_failed is sticky and pins the status line: it is the one error the user can
// actually fix, so cold start must not hide it. This is also the top of the §10 table.
test('auth_failed outranks cold start — the one error the user can fix is never hidden', async () => {
  const dataDir = makeDataDir();
  const e = env(dataDir);
  const runId = await derivedRunId(e);
  seedMarker(dataDir, runId, { state: 'auth_failed', cold_start_until: Date.now() + 20_000 });

  const r = await runStatusline({ env: e });
  assertNoStackTrace(r);
  assert.ok(r.line.startsWith('✖'), `expected ✖ auth failed to outrank ◍ warming, got: ${r.line}`);
  assert.ok(r.line.includes('auth failed'), `expected the "auth failed" label, got: ${r.line}`);
});

// ---------------------------------------------------------------------------
// §10 — breaker cooldown and the rung label
// ---------------------------------------------------------------------------

// §10 — an open breaker recovers by itself. Showing the remaining cooldown is the
// difference between "it will come back in 94 seconds" and "this thing is dead".
test('an open breaker appends the remaining cooldown, e.g. " · paused 94s"', async () => {
  const dataDir = makeDataDir();
  const e = env(dataDir, { MUBIT_CC_BREAKER_COOLDOWN_MS: '120000' });
  const runId = await derivedRunId(e);
  seedMarker(dataDir, runId, { state: 'unreachable' });
  // Opened 26s ago with a 120s cooldown → 94s remaining.
  seedBreaker(dataDir, e.MUBIT_ENDPOINT, {
    state: 'unreachable',
    openedAt: Date.now() - 26_000,
    failures: [Date.now() - 26_000],
  });

  const r = await runStatusline({ env: e });
  assertNoStackTrace(r);
  const m = / · paused (\d+)s/.exec(r.line);
  assert.ok(m, `expected " · paused <n>s" while the breaker is open (§10), got: ${r.line}`);
  const remaining = Number(m[1]);
  assert.ok(remaining >= 92 && remaining <= 94,
    `expected ~94s of cooldown remaining (120s cooldown opened 26s ago), got ${remaining}s in: ${r.line}`);
});

// §10 — a closed breaker says nothing. Noise in a per-frame widget is worse than silence.
test('a closed breaker adds no paused suffix', async () => {
  const dataDir = makeDataDir();
  const e = env(dataDir);
  const runId = await derivedRunId(e);
  seedMarker(dataDir, runId);
  seedBreaker(dataDir, e.MUBIT_ENDPOINT, { state: 'ready', openedAt: 0 });

  const r = await runStatusline({ env: e });
  assertNoStackTrace(r);
  assert.ok(!/paused/.test(r.line), `closed breaker must not print a paused suffix, got: ${r.line}`);
});

// §10/§1.8 — rung 1 is the free path (0 LLM calls). Rung 2 spends one LLM call per
// prompt and rung 3 spends two. The user is entitled to know that without reading a log.
for (const { rung, expected } of [
  { rung: 1, expected: null },
  { rung: 2, expected: ' · rung 2' },
  { rung: 3, expected: ' · rung 3' },
]) {
  test(`rung ${rung} ${expected ? `appends "${expected.trim()}"` : 'adds no label — it is the free path'}`, async () => {
    const dataDir = makeDataDir();
    const e = env(dataDir);
    const runId = await derivedRunId(e);
    seedMarker(dataDir, runId, {
      recall: { sources: 6, tokens: 1187, ms: 842, empty_reason: '', rung, dropped: 0 },
    });

    const r = await runStatusline({ env: e });
    assertNoStackTrace(r);
    if (expected === null) {
      assert.ok(!/rung/.test(r.line),
        `rung 1 is the free path and needs no label (§10), got: ${r.line}`);
    } else {
      assert.ok(r.line.includes(expected),
        `expected "${expected.trim()}" — rung ${rung} means the instance is spending LLM calls on every prompt (§1.8), got: ${r.line}`);
    }
  });
}

// ---------------------------------------------------------------------------
// §10/§16.2 — the off switch and the empty states
// ---------------------------------------------------------------------------

// §10 — an empty status line, not an error. Turning the widget off must not make the
// host print a failed-command banner every frame.
test('MUBIT_CC_STATUSLINE=0 prints nothing and exits 0', async () => {
  const dataDir = makeDataDir();
  const e = env(dataDir, { MUBIT_CC_STATUSLINE: '0' });
  const runId = await derivedRunId(e);
  seedMarker(dataDir, runId);

  const r = await runStatusline({ env: e });
  assertNoStackTrace(r);
  assert.equal(r.stdout, '', `MUBIT_CC_STATUSLINE=0 must print nothing, got: ${JSON.stringify(r.stdout)}`);
});

// §6.2/§6.3 — the same off switch reached through userConfig. Both env spellings are
// set because the exact transform for a userConfig key is not fully documented (§6.3).
test('statusLine: false via userConfig prints nothing and exits 0', async () => {
  const dataDir = makeDataDir();
  const e = env(dataDir, {
    CLAUDE_PLUGIN_OPTION_STATUS_LINE: 'false',
    CLAUDE_PLUGIN_OPTION_STATUSLINE: 'false',
    CLAUDE_PLUGIN_OPTION_statusLine: 'false',
  });
  const runId = await derivedRunId(e);
  seedMarker(dataDir, runId);

  const r = await runStatusline({ env: e });
  assertNoStackTrace(r);
  assert.equal(r.stdout, '', `statusLine:false must print nothing, got: ${JSON.stringify(r.stdout)}`);
});

// §16.2 — the state every user is in for their first few seconds: installed, enabled,
// no SessionStart yet, no directories, no files. This must be silent, not a crash.
test('survives a fresh install with no Mubit state at all: prints nothing, exits 0', async () => {
  const emptyDir = tempDir('mubit-cc-fresh-'); // deliberately NOT makeDataDir(): no skeleton either
  const e = env(emptyDir);

  const r = await runStatusline({ env: e });
  assertNoStackTrace(r);
  assert.equal(r.stdout, '',
    `with no state at all the status line must print nothing (§16.2), got: ${JSON.stringify(r.stdout)}`);
});

// §7/§16.2 — the skeleton exists but no marker has been written yet (between install and
// the first SessionStart). Same contract.
test('survives an empty data dir skeleton with no marker: prints nothing, exits 0', async () => {
  const dataDir = makeDataDir();
  const r = await runStatusline({ env: env(dataDir) });
  assertNoStackTrace(r);
  assert.equal(r.stdout, '', `no marker means nothing to say, got: ${JSON.stringify(r.stdout)}`);
});

// §4.9 discipline applied to the status line: a half-written marker (the process died
// mid-rename) must degrade to silence, never to a parse error on the user's prompt line.
test('survives a corrupt marker file: no throw, exit 0', async () => {
  const dataDir = makeDataDir();
  const e = env(dataDir);
  const runId = await derivedRunId(e);
  mkdirSync(join(dataDir, 'status'), { recursive: true });
  writeFileSync(join(dataDir, 'status', `${runId}.json`), '{"run_id": "cc-x", "recall": {');

  const r = await runStatusline({ env: e });
  assertNoStackTrace(r);
  assert.ok(!/SyntaxError|JSON/.test(r.stderr), `corrupt marker leaked a parse error: ${r.stderr}`);
  assert.ok(r.stdout === '' || r.line.length > 0,
    'a corrupt marker must yield either silence or a valid line — never a partial render');
});

// §10 — a marker whose fields are missing (an older schema, a partial write that still
// parsed) must not produce "undefined" in the user's prompt line.
test('a marker missing optional sections never renders "undefined" or "NaN"', async () => {
  const dataDir = makeDataDir();
  const e = env(dataDir);
  const runId = await derivedRunId(e);
  mkdirSync(join(dataDir, 'status'), { recursive: true });
  writeFileSync(join(dataDir, 'status', `${runId}.json`),
    JSON.stringify({ run_id: runId, mode: 'local', state: 'ready', updated_at: Date.now() }));

  const r = await runStatusline({ env: e });
  assertNoStackTrace(r);
  assert.ok(!/undefined|NaN|\[object Object\]/.test(r.line),
    `status line rendered a placeholder for missing marker fields: ${r.line}`);
});
