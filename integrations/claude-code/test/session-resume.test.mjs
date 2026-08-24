// @ts-check
/**
 * `resumeBlock` — the briefing a session opens with.
 *
 * ---------------------------------------------------------------------------
 * What is being claimed, and what would falsify it
 * ---------------------------------------------------------------------------
 * `SessionStart` injects recalled memory; it has never injected *here is where you left off*.
 * The first prompt of a session is therefore answered against relevance matches to a question
 * the user has not typed yet, and resuming is the thing people actually want from a memory
 * layer. This feature assembles that briefing once per session, in a process nobody waits on,
 * and renders it above the ordinary recall block on the first substantive prompt.
 *
 * ```
 * session-start (blocking, ~300 ms)            session-resume (detached, up to 20 s)
 *   health → register → lessons
 *   spawn --run --agent ──────────────────────▶ postContext{mode:"sections"}
 *                                               writeResume → runs/<run>/resume.json
 *
 * prompt-recall (the first substantive prompt)
 *   takeResume  → render <mubit-resume> above <mubit-memory>
 *   markSeen    → before this turn's own recall assembles
 *   persistRecalled → the ids land on the turn that RECEIVED them
 * ```
 *
 * Five claims, and each has a group below:
 *
 *   1. **The session never waits for it.** `SessionStart` is a 5 s hook that Claude Code
 *      blocks on. A briefing worth 1000 tokens cannot be bought with the user's time, so the
 *      call happens in a second process and the hook's wall clock does not move.
 *   2. **The child is not a second derivation of the run.** `lib/runid.mjs` increments and
 *      *persists* `clear_count` on `source: 'clear'`; a second process re-deriving would hand
 *      itself `-c2` where the parent got `-c1`, write it back, and leave the briefing under a
 *      run nothing will ever read. Identity arrives on argv, exactly as `drain.mjs` takes it.
 *   3. **A background briefing cannot take recall down.** The one request it makes is
 *      `{record: false}`, so no verdict it collects reaches the breaker that `prompt-recall`
 *      and the capture drain both depend on.
 *   4. **Attribution and the seen-set land on the receiving turn.** Same rule, and same
 *      reason, as carry-forward: the process that assembles a block has shown nothing to
 *      anyone, so it records nothing about what the model saw.
 *   5. **Consumed once.** `takeResume` unlinks first and unconditionally, so a corrupt file
 *      cannot re-inject forever — and a slash command, which returns before any file is read,
 *      does not spend the briefing on a command addressed to the harness.
 *
 * ---------------------------------------------------------------------------
 * Why this is not `lib/carry.mjs` with a second flag
 * ---------------------------------------------------------------------------
 * With `recallAsync` on, `recall-refresh` writes `carry.json` after every prompt and
 * `takeCarry` unlinks it. Two detached writers on one path is a race whose losing outcome is
 * silent. Worse: if resume won, `carryForward` would render it through `wrap(…, carried=true)`,
 * which prints *"it was retrieved against the previous message in this conversation"* — a
 * factual lie about a block assembled before any message existed.
 * `resumeIsNotCarry` pins the separation at the path level.
 *
 * ---------------------------------------------------------------------------
 * `/v2/control/context`, and the two fields that are not on it
 * ---------------------------------------------------------------------------
 * `ContextRequest` carries eleven fields and no ranking field of any kind. `lane_filter` is
 * **not** one of them — it exists only on `AgentQueryRequest` (`mcp/dist/server.js:47366`
 * against the `getContext` body at `:47398-47415`), which is why `docs/codaph-port.md`'s
 * description of this feature is corrected on this branch. `entry_types` *is* real here and
 * is worth sending. `theRequestBodyIsTheResumeRequest` asserts all four absences by name,
 * each with the reason, because a field the server silently ignores while sitting in a
 * request log looking like a choice is a bug with no symptom.
 *
 * These tests are written before the implementation. Failing with
 * "lib/resume.mjs does not exist yet" is the expected red state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  assertHookContract, baseEnv, contextResponse, evidence, fakeMubit, lib, makeDataDir,
  makeProjectDir, queryResponse, readJsonFile, runHook, tempDir, waitFor,
} from './helpers/harness.mjs';
import * as fx from './helpers/fixtures.mjs';
import { userPromptSubmit, PROMPT_ID } from './helpers/fixtures.mjs';

const RUN_ID = 'cc-test-resume-1';

/** A second prompt id, so "which turn was credited" is a question with two possible answers. */
const PROMPT_ID_B = 'p_01HZXK8Q9N7M6P5R4S3T2U1V0X';

/** One real git project: `session-start`'s run-id derivation shells out to git. */
const PROJECT_DIR = makeProjectDir({ git: true });

/** The flag, as a user would set it. It ships **on**; `baseEnv` pins it off for every suite. */
const RESUME_ON = { MUBIT_CC_RESUME_BLOCK: '1' };

const resumePath = (d, run = RUN_ID) => join(d, 'runs', run, 'resume.json');
const carryPath = (d, run = RUN_ID) => join(d, 'runs', run, 'carry.json');
const seenPath = (d, run = RUN_ID) => join(d, 'runs', run, 'seen.json');
const turnPath = (d, promptId, run = RUN_ID) => join(d, 'runs', run, 'turns', `${promptId}.json`);
const markerPath = (d, run = RUN_ID) => join(d, 'status', `${run}.json`);

/** A pinned static run, so every request body and every path is exactly assertable. */
function env(dataDir, server, extra = {}) {
  return baseEnv({
    dataDir,
    endpoint: server.url,
    projectDir: PROJECT_DIR,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: RUN_ID,
      ...extra,
    },
  });
}

/** A derived run, for the tests that are about run-id derivation rather than about recall. */
function derivedEnv(dataDir, server, extra = {}) {
  return baseEnv({ dataDir, endpoint: server.url, projectDir: PROJECT_DIR, extra });
}

/**
 * The shipped default, with the harness's pin removed.
 *
 * `baseEnv` pins `MUBIT_CC_RESUME_BLOCK: '0'` for every suite in this repo — the detached
 * child dials the same `fakeMubit` at an unpredictable moment, which would make
 * `session-start.test.mjs`'s exact-call-sequence assertion a coin flip. That pin is also the
 * reason the shipped default has to be asserted *somewhere*, and this is that somewhere:
 * deleting the key is the only way a test can see what a real install sees.
 */
function unpinned(e) {
  const out = { ...e };
  delete out.MUBIT_CC_RESUME_BLOCK;
  return out;
}

/** A `ContextResponse` that is recognisably a briefing rather than the harness default. */
const BRIEFING = contextResponse({
  context_block: '## Working memory\n- The ingest drain was left mid-batch on run cc-1.\n'
    + '## Traces\n- `npm test` was last green at 41 files.\n',
  token_estimate: 61,
  sources: ['ref_wm_1', 'ref_trace_1'],
  section_summaries: [{ section: 'working_memory', count: 1 }, { section: 'traces', count: 1 }],
});

/**
 * An entry long enough for a pointer to be worth rendering. `lib/assemble.mjs` degrades a
 * repeat only when the pointer is *shorter* than the entry — a pointer longer than what it
 * points at is a pessimisation in the costume of an optimisation — so the seen-set's effect
 * is invisible on the one-line lessons most fixtures use.
 */
const SHARED_ENTRY = 'The ingest drain was left mid-batch on run cc-1: thirty-one spool items '
  + 'were accepted and committed, and the remaining nine were still in flight when the '
  + 'session ended, so the next drain resends them under the same idempotency key.';

/** A phrase only the FULL entry carries, never its first clause. */
const TAIL = 'same idempotency key';

/** A single-evidence recall response, so "which block did this line come from" is unambiguous. */
const ONE = queryResponse({
  evidence: [evidence({
    id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule', score: 0.91,
    content: 'Ingest returns when queued, not when stored; poll the job for completion.',
  })],
});

// ---------------------------------------------------------------------------
// The spawn spy — the same `--require` preload `async-recall.test.mjs` uses.
// It records, it does not replace: the real `session-resume` still runs and still dials.
// ---------------------------------------------------------------------------

const SCRATCH = tempDir('mubit-cc-resume-');
const SPY = join(SCRATCH, 'spawn-spy.cjs');
writeFileSync(SPY, `const fs = require('node:fs');
const out = process.env.MUBIT_TEST_SPY_FILE;
if (out) {
  try {
    fs.appendFileSync(out, JSON.stringify({
      argv: process.argv.slice(1),
      detached: process.env.MUBIT_CC_DETACHED || '',
      at: Date.now(),
    }) + '\\n');
  } catch {}
}
`);

function withSpy(e) {
  const file = join(SCRATCH, `spy-${randomUUID()}.jsonl`);
  return { file, env: { ...e, NODE_OPTIONS: `--require ${SPY}`, MUBIT_TEST_SPY_FILE: file } };
}

function resumeSpawns(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((l) => basename(String(l.argv?.[0] ?? '')) === 'session-resume.mjs');
}

/**
 * A Mubit that answers `session-start`'s three calls and never answers `/v2/control/context`.
 *
 * `fakeMubit`'s `{hang: true}` expresses the same thing, but its `close()` waits on the open
 * socket and the detached child holds one for the whole of its 20 s deadline — twenty seconds
 * of suite time for one assertion. This destroys the connection on teardown instead, which is
 * the only difference between the two.
 */
async function mubitThatNeverAnswersContext() {
  /** @type {{method: string, path: string}[]} */
  const requests = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      requests.push({ method: req.method ?? 'GET', path });
      if (path === '/v2/control/context') return;      // deliberately never answered
      if (path === '/v2/core/health') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('OK');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, lessons: [] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  const port = /** @type {any} */ (server.address()).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    countOf(method, path) {
      return requests.filter((r) => r.method === method && r.path === path).length;
    },
    close() {
      server.closeAllConnections();
      return new Promise((r) => server.close(() => r(undefined)));
    },
  };
}

// ===========================================================================
// 1 — `SessionStart` never waits on the resume call
// ===========================================================================

/*
 * Written first, and it passes before a line of the feature exists. That is the point: it is
 * the assertion that has to stay true through every later change, and the one whose failure
 * means the feature has quietly been put back on the blocking path.
 */

// §5.1's whole budget is 2500 ms internal against a 5 s hook timeout, with the harness's hard
// stop at 3200 ms. A briefing that costs two LLM calls cannot be bought with that, so the hook
// must return without having seen the answer — with its steer block intact, not the
// `{suppressOutput: true}` a blown budget emits.
test('session-start returns inside its budget while the resume call never answers', async (t) => {
  const server = await mubitThatNeverAnswersContext();
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }), {
    env: env(dataDir, server, RESUME_ON),
  });

  assertHookContract(r);
  assert.ok(r.ms < 3200,
    `session-start took ${r.ms}ms against a 3200ms harness budget. The resume call is worth `
    + 'up to 20 s and two LLM calls; the moment any of it is awaited here, every session in '
    + 'the world opens on a stalled hook');
  assert.equal(r.json?.hookSpecificOutput?.hookEventName, 'SessionStart',
    'a hook that blew its budget emits {suppressOutput:true} and no context at all — the '
    + 'steer block still landing is what proves the budget was never spent');
  assert.match(String(r.json.hookSpecificOutput.additionalContext), /Mubit memory is active/);
});

// ===========================================================================
// 2 — the call comes from a second process
// ===========================================================================

// The claim above, stated as a mechanism rather than as a stopwatch: at the instant `runHook`
// resolved, `/v2/control/context` had not been called; a moment later it had. A wall-clock
// assertion alone would also pass for a hook that dialled a very fast server.
test('the resume request is made by a second process, after session-start has returned', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/context': { json: BRIEFING } });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const { file, env: e } = withSpy(env(dataDir, server, RESUME_ON));

  const r = await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }), { env: e });
  assertHookContract(r);

  assert.equal(server.countOf('POST', '/v2/control/context'), 0,
    'the hook had already returned and the briefing had not been requested — anything else '
    + 'means the user paid for it');

  await waitFor(() => server.countOf('POST', '/v2/control/context') >= 1);
  assert.equal(server.countOf('POST', '/v2/control/context'), 1,
    'exactly one briefing per session; a second is a second pair of LLM calls');

  const spawns = resumeSpawns(file);
  assert.equal(spawns.length, 1, 'exactly one child');
  assert.equal(spawns[0].detached, '1',
    'an attached child would put the round trip back on the session by another route');
  assert.ok(spawns[0].argv.includes('--run'),
    'the child takes its identity off argv; see the run-id test below for why');

  await waitFor(() => existsSync(resumePath(dataDir)));
});

// ===========================================================================
// 3 — the child never re-derives the run id
// ===========================================================================

/*
 * `lib/runid.mjs` is not a pure function. On `source: 'clear'` it increments `clear_count`
 * and **persists** the new SessionRecord, so a second process handed the same payload does
 * not merely compute the same answer twice — it computes a *different* answer (`-c2` where
 * the parent got `-c1`) and writes it back over the parent's. The briefing would then land
 * under a run nothing will ever read, and the next `/clear` would start from a count nobody
 * set.
 *
 * So the child is driven directly here, with a `clear` payload it must ignore, which is a
 * stronger statement than any test of the spawn path: it holds even if a future caller passes
 * a source the spawn gate does not.
 */
test('session-resume takes the run off argv and never re-derives it from the payload', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/context': { json: BRIEFING } });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const PINNED = 'cc-pinned-by-the-parent';

  const r = await runHook('session-resume', fx.sessionStart({ source: 'clear', cwd: PROJECT_DIR }), {
    env: derivedEnv(dataDir, server, RESUME_ON),
    args: ['--run', PINNED, '--agent', 'claude-code-abc123'],
  });
  assertHookContract(r);

  assert.ok(existsSync(resumePath(dataDir, PINNED)),
    'the briefing belongs under the run the parent named');

  const runs = readdirSync(join(dataDir, 'runs'));
  assert.deepEqual(runs, [PINNED],
    `the child created a second run directory (${runs.join(', ')}). deriveRunId on a "clear" `
    + 'source appends an incrementing counter, so a re-derivation here is a different run id '
    + 'AND a persisted counter bump the parent never asked for');

  const sessions = readdirSync(join(dataDir, 'sessions')).filter((f) => f.endsWith('.json'));
  for (const f of sessions) {
    assert.equal(readJsonFile(join(dataDir, 'sessions', f)).clear_count, 0,
      `sessions/${f} had its clear_count moved by the child. The next /clear would then skip `
      + 'a number, and the run the parent is writing to is not the one it derived');
  }

  const body = server.lastCall('POST', '/v2/control/context').body;
  assert.equal(body.run_id, PINNED, 'and the wire carries the parent\'s run, not the child\'s');
  assert.equal(body.agent_id, 'claude-code-abc123');
});

// ===========================================================================
// 4 — the request body is the resume request, and nothing else
// ===========================================================================

// The positive half and the negative half of the same claim. The four absences each cost
// nothing to send and each would be wrong in a different way, which is exactly the shape of
// mistake that survives review: the server accepts the request either way.
test('the resume request body is a sections context request, with four fields deliberately absent',
  async (t) => {
    const server = await fakeMubit({ 'POST /v2/control/context': { json: BRIEFING } });
    t.after(() => server.close());
    const dataDir = makeDataDir();
    const { RESUME_SECTIONS, RESUME_ENTRY_TYPES } = await lib('recall.mjs');

    assertHookContract(await runHook('session-resume', fx.sessionStart({ cwd: PROJECT_DIR }), {
      env: env(dataDir, server, RESUME_ON),
      args: ['--run', RUN_ID, '--agent', 'claude-code-abc123'],
    }));

    const body = server.lastCall('POST', '/v2/control/context').body;

    assert.equal(body.mode, 'sections',
      '`full` returns one undifferentiated wall and `summary` returns a paragraph; only '
      + '`sections` returns something a reader can skim on the first prompt of a session');
    assert.equal(body.format, 'structured');
    assert.equal(body.include_working_memory, true,
      'working memory is the section a resume question is actually asking about, and it is '
      + 'the one no entry_type in this request can fill');
    assert.equal(body.limit, 12);
    assert.equal(body.max_token_budget, 1000, '§6.1 `resumeTokenBudget`');
    assert.deepEqual(body.sections, [...RESUME_SECTIONS]);
    assert.deepEqual(body.entry_types, [...RESUME_ENTRY_TYPES]);
    assert.equal(body.run_id, RUN_ID);
    assert.ok(String(body.query).length > 20, 'the query is a real question, not a keyword');

    // --- the four absences.
    assert.equal('rank_by' in body, false,
      'ContextRequest has NO ranking field of any kind — its eleven fields do not include '
      + 'one. Sending `rank_by` here would be ignored by the server while sitting in the '
      + 'request log looking like a choice somebody made, which is a bug with no symptom');
    assert.equal('lane_filter' in body, false,
      '`lane_filter` exists on AgentQueryRequest and NOT on ContextRequest — mcp/dist/'
      + 'server.js:47366 against the getContext body at :47398-47415. docs/codaph-port.md '
      + 'said otherwise and is corrected on this branch');
    assert.equal('env_tags' in body, false,
      'same gap, one field further on: `env_tags` is an AgentQueryRequest field. Version-aware '
      + 'tag scoring is a capability rungs 1-2 have and this path does not');
    assert.equal('user_id' in body, false,
      '`user_id` is a retrieval FILTER the server enforces, not a label: filling it narrows '
      + 'the briefing to entries captured under the same id and returns nothing on every '
      + 'install that never set one');
  });

// ===========================================================================
// 5 — sections and entry types cannot drift apart
// ===========================================================================

/*
 * A pure unit test, and the cheapest one in this file. Ask for a section no entry type can
 * fill and it renders empty — silently, with a healthy 200 and a shorter block. Ask for an
 * entry type whose section was not requested and the retrieval was paid for and discarded.
 * Neither shows up anywhere at runtime.
 */
test('every resume entry type lands in a requested section, and every section can be filled',
  async () => {
    const { RESUME_SECTIONS, RESUME_ENTRY_TYPES } = await lib('recall.mjs');
    const { sectionFor } = await lib('assemble.mjs');

    // Direction 1 — nothing is retrieved that has nowhere to render.
    for (const t of RESUME_ENTRY_TYPES) {
      const section = sectionFor(t);
      assert.ok(RESUME_SECTIONS.includes(section),
        `entry_type "${t}" renders into "${section}", which this request does not ask for. `
        + 'The evidence is retrieved, budgeted for, and then dropped on the floor');
    }

    // Direction 2 — nothing is asked for that nothing can fill. `working_memory` is the one
    // exception and it is named rather than skipped: it is served by
    // `include_working_memory: true` rather than by any entry type, so a future editor who
    // drops that flag has to come here and say so.
    const reachable = new Set(RESUME_ENTRY_TYPES.map(sectionFor));
    for (const s of RESUME_SECTIONS) {
      if (s === 'working_memory') {
        assert.ok(!reachable.has(s),
          'if working_memory ever becomes reachable from an entry type, this exception is '
          + 'stale and the assertion below it should cover it like every other section');
        continue;
      }
      assert.ok(reachable.has(s),
        `section "${s}" is requested and no entry_type in RESUME_ENTRY_TYPES fills it. It `
        + 'renders as nothing, on a 200, with no log line and no shorter block to notice');
    }
  });

// ===========================================================================
// 6 — a slow or failing briefing cannot take recall down
// ===========================================================================

/*
 * `lib/http.mjs:557-560` tags an abort `abortedEarly` — and `settle()` at :592 then declines
 * to record it — **only** when the caller's deadline is *tighter* than the configured default.
 * This call's deadline is 20 s against a 4000 ms default, which is looser, so every failure
 * it collects would otherwise be a real vote with the breaker. Five sessions inside the 5 min
 * window and the breaker opens — which stops `prompt-recall` dialling AND suppresses the
 * capture drain, for a feature nobody was waiting on. `{record: false}` is the whole fix.
 */
test('a failing resume records nothing with the breaker, however many times it fails', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/context': { status: 500, json: { error: 'boom' } },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const e = env(dataDir, server, RESUME_ON);

  const { loadConfig } = await lib('config.mjs');
  const { readBreaker } = await lib('breaker.mjs');
  const cfg = loadConfig(e);

  // The default threshold is 5 within a 5-minute window.
  for (let i = 0; i < 5; i++) {
    assertHookContract(await runHook('session-resume', fx.sessionStart({ cwd: PROJECT_DIR }), {
      env: e, args: ['--run', RUN_ID, '--agent', 'a'],
    }));
  }
  assert.equal(server.countOf('POST', '/v2/control/context'), 5, 'all five actually dialled');

  assert.equal(readBreaker(cfg).openedAt, 0,
    'the breaker opened on five failures of a background briefing. It gates the recall every '
    + 'prompt depends on and the drain every capture depends on, so a feature nobody is '
    + 'waiting on must not be able to vote in it');
  assert.equal(existsSync(resumePath(dataDir)), false,
    'a failure is not a briefing; an empty block would be injected as one');
});

// ===========================================================================
// 7 — the child writes the block and nothing that describes what the model saw
// ===========================================================================

/*
 * `recall-refresh.mjs:22-31` argues this at length and it applies more strongly here. A
 * carried block is rendered on the very next prompt; a resume block has to survive a whole
 * session's worth of ways not to be rendered — the session ends without a prompt, the first
 * prompt is a slash command, `checkpoint --post` clears it. `markSeen` means "the model has
 * been shown this", and this process has shown nothing to anyone.
 */
test('session-resume writes the briefing, and neither the seen-set, a turn, nor the marker',
  async (t) => {
    const server = await fakeMubit({ 'POST /v2/control/context': { json: BRIEFING } });
    t.after(() => server.close());
    const dataDir = makeDataDir();
    const e = env(dataDir, server, RESUME_ON);

    // A marker the child could plausibly overwrite, written the way any hook writes one.
    const { loadConfig } = await lib('config.mjs');
    const { updateMarker } = await lib('markers.mjs');
    updateMarker(loadConfig(e), RUN_ID, { state: 'ready', mode: 'hosted' });
    const before = readFileSync(markerPath(dataDir), 'utf8');

    assertHookContract(await runHook('session-resume', fx.sessionStart({ cwd: PROJECT_DIR }), {
      env: e, args: ['--run', RUN_ID, '--agent', 'a'],
    }));

    const stored = readJsonFile(resumePath(dataDir));
    assert.match(String(stored.block), /mid-batch/, 'the child exists to produce a block');
    assert.deepEqual(stored.ref_ids, ['ref_wm_1', 'ref_trace_1']);

    assert.equal(existsSync(seenPath(dataDir)), false,
      'marking here would record memories as shown before any turn has shown them — the next '
      + 'full-price block would degrade them to pointers naming text the model never got');
    assert.equal(existsSync(join(dataDir, 'runs', RUN_ID, 'turns')), false,
      'attributing here would credit a turn that does not exist yet; the receiving turn owns '
      + 'that write, exactly as it does under recallAsync');
    assert.equal(readFileSync(markerPath(dataDir), 'utf8'), before,
      'the marker describes what was injected and this process injects nothing. It is also '
      + 'the file the status line reads, and a briefing has no business colouring it');
  });

// ===========================================================================
// 8 — lib/resume.mjs, the file itself
// ===========================================================================

/** Fresh data dir + resolved config + a fresh `lib/resume.mjs`. */
async function setup(extra = {}) {
  const R = await lib('resume.mjs');
  const dataDir = makeDataDir();
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(baseEnv({ dataDir, extra }));
  return { cfg, dataDir, R };
}

/** An `Outcome`, as `lib/recall.mjs` hands one back. */
function outcome(over = {}) {
  return {
    failed: false, rung: 3, block: '## Working memory\n- Left mid-batch.', tokens: 61,
    sources: 2, dropped: 0, pointers: 0, emptyReason: '',
    refIds: ['ref_wm_1', 'ref_trace_1'],
    ...over,
  };
}

// A session whose child never finished — or never ran, because the source was `clear` — has
// nothing here, and that is the ordinary case rather than an error.
test('takeResume: a run with no briefing answers nothing, not an error', async () => {
  const { cfg, R } = await setup();
  assert.equal(R.takeResume(cfg, RUN_ID), null);
});

// The file is an `Outcome` on disk, for the reason `lib/carry.mjs` gives: one rendering path.
// A second shape here is a second place for `refIds` to be dropped, and `refIds` is what the
// receiving turn attributes and marks against.
test('writeResume then takeResume round-trips the Outcome the context call produced', async () => {
  const { cfg, R } = await setup();
  const o = outcome({ dropped: 2, tokens: 91 });

  assert.equal(R.writeResume(cfg, RUN_ID, o, { source: 'startup', fetchMs: 4321 }), true);
  const got = R.takeResume(cfg, RUN_ID);

  assert.equal(got.block, o.block);
  assert.equal(got.tokens, 91);
  assert.equal(got.dropped, 2);
  assert.deepEqual(got.refIds, ['ref_wm_1', 'ref_trace_1'],
    'without the ids the receiving turn has nothing to attribute and nothing to mark seen');
  assert.equal(got.failed, false);
  assert.equal(got.source, 'startup',
    'which session source produced the briefing is the provenance a reader needs when one '
    + 'turns up on a session that should not have had one');
  assert.equal(got.fetchMs, 4321,
    'what the child spent is the number that shows the session did not pay it');
  assert.ok(got.writtenAt > 0, 'when it was assembled is half of what the wrapper has to say');
});

// The load-bearing property. A child that stops answering, a session that is never prompted,
// a corrupt file — none of them may leave a briefing to be re-injected on every prompt for
// the rest of the session. Consumed means gone.
test('takeResume is consume-once: a second read gets nothing, not the same briefing again', async () => {
  const { cfg, dataDir, R } = await setup();
  R.writeResume(cfg, RUN_ID, outcome(), { source: 'startup' });

  assert.ok(R.takeResume(cfg, RUN_ID)?.block, 'the first read gets it');
  assert.equal(R.takeResume(cfg, RUN_ID), null,
    'a briefing re-injected every prompt costs full price forever to describe a session the '
    + 'user is already several hours into');
  assert.equal(existsSync(resumePath(dataDir)), false,
    'consumed means unlinked — a file left behind is a file the next prompt reads');
});

// Thirty minutes, against carry-forward's fifteen. A carried block was retrieved against the
// *previous prompt* and goes stale as soon as the subject changes; a briefing is about the
// state of the work at the moment the session opened, which is still true half an hour later.
// Past that, the session has become its own context and the briefing is describing history.
test('takeResume: a briefing older than RESUME_TTL_MS is dropped rather than injected', async () => {
  const { cfg, dataDir, R } = await setup();
  assert.equal(R.RESUME_TTL_MS, 30 * 60 * 1000);

  mkdirSync(join(dataDir, 'runs', RUN_ID), { recursive: true });
  writeFileSync(resumePath(dataDir), JSON.stringify({
    run_id: RUN_ID,
    written_at: Date.now() - (R.RESUME_TTL_MS + 60_000),
    block: '## Working memory\n- Stale.',
    ref_ids: ['ref_old'],
  }));

  assert.equal(R.takeResume(cfg, RUN_ID), null);
  assert.equal(existsSync(resumePath(dataDir)), false,
    'an expired briefing is swept too, or it is re-read and re-rejected on every prompt');
});

// §4.9: nothing on the recall path throws. A truncated file is the ordinary state after a
// SIGKILL mid-write, and the unlink happens first precisely so that a file which cannot be
// parsed does not become a permanent read on the blocking path.
test('takeResume: a corrupt briefing degrades to nothing, and is removed anyway', async () => {
  const { cfg, dataDir, R } = await setup();
  mkdirSync(join(dataDir, 'runs', RUN_ID), { recursive: true });
  writeFileSync(resumePath(dataDir), '{"block": "## Working mem');

  assert.equal(R.takeResume(cfg, RUN_ID), null);
  assert.equal(existsSync(resumePath(dataDir)), false,
    'unlink-first is what stops a corrupt file being re-read on every prompt of the session');
});

// A run id can be pinned by hand in `.mubit-cc.json` or an environment variable, so it is
// untrusted input to a path — the same rule every other per-run file lives by.
test('resume paths are per-run: traversal is neutralised, an empty run id is refused', async () => {
  const { cfg, dataDir, R } = await setup();

  assert.equal(R.writeResume(cfg, '../../etc', outcome(), { source: 'startup' }), true);
  const under = readdirSync(join(dataDir, 'runs'));
  assert.equal(under.length, 1, `expected one run dir, got ${JSON.stringify(under)}`);
  assert.ok(!/[/\\]/.test(under[0]) && under[0] !== '..' && under[0] !== '.',
    `a pinned run id must not write outside runs/; it landed at ${under[0]}`);

  assert.equal(R.writeResume(cfg, '   ', outcome(), { source: 'startup' }), false,
    'an empty segment resolves to runs/ itself, which every other run reads');
  assert.equal(R.takeResume(cfg, '   '), null);
});

// A briefing with no block is not a briefing. Writing one would overwrite a good file and
// would be read downstream as "there is nothing to say", which is a different claim from
// "nobody has looked yet".
test('writeResume refuses an empty block', async () => {
  const { cfg, dataDir, R } = await setup();
  assert.equal(R.writeResume(cfg, RUN_ID, outcome({ block: '   ' }), { source: 'startup' }), false);
  assert.equal(existsSync(resumePath(dataDir)), false);
});

// ===========================================================================
// 9 — injected once, on the first prompt that recalls
// ===========================================================================

/** Put a briefing on disk the way the child would, without running the child. */
async function seedResume(e, dataDir, over = {}) {
  const { loadConfig } = await lib('config.mjs');
  const { writeResume } = await lib('resume.mjs');
  writeResume(loadConfig(e), RUN_ID, {
    failed: false, rung: 3, tokens: 61, sources: 2, dropped: 0, pointers: 0, emptyReason: '',
    block: '## Working memory\n- The ingest drain was left mid-batch on run cc-1.',
    refIds: ['ref_wm_1', 'ref_trace_1'],
    ...over,
  }, { source: 'startup', fetchMs: 900 });
  assert.ok(existsSync(resumePath(dataDir)), 'the briefing has to be on disk for this test');
}

test('the briefing renders above the recall block on the first prompt, and not on the second',
  async (t) => {
    const server = await fakeMubit({ 'POST /v2/control/query': { json: ONE } });
    t.after(() => server.close());
    const dataDir = makeDataDir();
    const e = env(dataDir, server, RESUME_ON);
    await seedResume(e, dataDir);

    const first = await runHook('prompt-recall', userPromptSubmit(), { env: e });
    assertHookContract(first);
    const block = String(first.json.hookSpecificOutput.additionalContext);

    assert.match(block, /<mubit-resume /, 'the briefing is its own element');
    assert.ok(block.indexOf('<mubit-resume') < block.indexOf('<mubit-memory'),
      'the briefing is the older, wider context and belongs above the answer to this prompt; '
      + 'below it, the model reads it as an afterthought to a question it was not about');
    assert.match(block, /mid-batch/, 'the briefing\'s own text');
    assert.match(block, /poll the job/, 'and this turn\'s recall, unaffected');

    // The two sentences the wrapper carries, each doing a job the other cannot.
    assert.match(block, /start of this session/i,
      'without saying WHEN it was assembled, the model reads a briefing as an answer to the '
      + 'message just typed — which it predates');
    assert.match(block, /not a task list/i,
      'the single most likely misfire: "here is where you left off" read as "do this". '
      + 'Nothing in the block was asked for by anybody');

    assert.equal(existsSync(resumePath(dataDir)), false, 'consumed');

    const second = await runHook('prompt-recall',
      userPromptSubmit({ prompt_id: PROMPT_ID_B, prompt: 'and what does the drain do on 5xx?' }),
      { env: e });
    assertHookContract(second);
    assert.ok(!String(second.json.hookSpecificOutput.additionalContext).includes('<mubit-resume'),
      'twice is not a briefing, it is a repeated 1000-token preamble on every prompt of the '
      + 'session — the exact failure lib/carry.mjs calls worse than no recall at all');
  });

// ===========================================================================
// 10 — a slash command does not consume it
// ===========================================================================

// A slash command is addressed to the harness, not the model, and `prompt-recall` returns
// before it reads anything. That is not an accident to be preserved by luck: opening a
// session with `/mubit-memory:doctor` must not spend the session's briefing on a command that
// injects nothing anywhere.
test('a slash command spends nothing: the briefing survives to the first real prompt', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': { json: ONE } });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const e = env(dataDir, server, RESUME_ON);
  await seedResume(e, dataDir);

  const slash = await runHook('prompt-recall',
    userPromptSubmit({ prompt: '/mubit-memory:doctor' }), { env: e });
  assertHookContract(slash);
  assert.deepEqual(slash.json, { suppressOutput: true });
  assert.ok(existsSync(resumePath(dataDir)),
    'the briefing is for the first thing the user actually asks, not for the first thing '
    + 'they type');

  const real = await runHook('prompt-recall',
    userPromptSubmit({ prompt_id: PROMPT_ID_B, prompt: 'right, where were we on the drain?' }),
    { env: e });
  assertHookContract(real);
  assert.match(String(real.json.hookSpecificOutput.additionalContext), /<mubit-resume /);
});

// ===========================================================================
// 11 — attribution and the seen-set land on the receiving turn
// ===========================================================================

/*
 * THE test in this file, and the same claim `async-recall.test.mjs` makes about carry-forward,
 * one step further out: the turn that receives a block is not the turn — nor even the process
 * — that requested it. Both writes happen here, on the synchronous read, with the receiving
 * turn's `prompt_id` in hand, so nothing has to remember anything.
 *
 * The seen-set half has a second job. `markSeen` runs BEFORE this turn's own recall assembles,
 * so an entry that is in both renders in full in the briefing and as a pointer in the recall
 * block — which is accurate, because the briefing really is earlier in the same message.
 */
test('the briefing\'s ids are credited to the turn that received it, and marked before recall',
  async (t) => {
    const server = await fakeMubit({
      // The same entry the briefing carries, offered again by this turn's recall. Long
      // enough that a pointer is actually cheaper than the entry — `lib/assemble.mjs`
      // refuses to degrade a line the pointer would be longer than, which is correct and is
      // why a one-line fixture cannot exercise this.
      'POST /v2/control/query': {
        json: queryResponse({
          evidence: [
            evidence({
              id: 'e1', reference_id: 'ref_wm_1', entry_type: 'fact', score: 0.9,
              content: SHARED_ENTRY,
            }),
            evidence({
              id: 'e2', reference_id: 'ref_rule_1', entry_type: 'rule', score: 0.8,
              content: 'Ingest returns when queued, not when stored; poll the job for '
                + 'completion before reporting anything as stored.',
            }),
          ],
        }),
      },
    });
    t.after(() => server.close());
    const dataDir = makeDataDir();
    const e = env(dataDir, server, RESUME_ON);
    await seedResume(e, dataDir, { block: `## Working memory\n- ${SHARED_ENTRY}` });

    const r = await runHook('prompt-recall', userPromptSubmit(), { env: e });
    assertHookContract(r);
    const block = String(r.json.hookSpecificOutput.additionalContext);

    const turn = readJsonFile(turnPath(dataDir, PROMPT_ID));
    assert.deepEqual([...turn.recalled].sort(), ['ref_rule_1', 'ref_trace_1', 'ref_wm_1'],
      'every id the model was handed in this message is attributable against this turn. The '
      + 'briefing\'s ids are the ones with no other home: no other turn ever sees them, and '
      + 'the process that fetched them is long gone');

    const seen = readJsonFile(seenPath(dataDir));
    assert.ok(seen.refs.ref_wm_1 && seen.refs.ref_trace_1,
      'the turn that rendered the briefing is the turn that records it as shown');

    // The ordering claim: marked before this turn's recall assembled, so the duplicate is a
    // pointer here and was sent in full above.
    const briefing = block.slice(0, block.indexOf('<mubit-memory'));
    const memory = block.slice(block.indexOf('<mubit-memory'));
    assert.ok(briefing.includes(TAIL), 'the full entry is in the briefing');
    assert.ok(memory.includes('(seen earlier)') && memory.includes('ref_wm_1'),
      'ref_wm_1 was in the briefing, so the recall block below degrades it to a pointer. '
      + 'Marking after the assembly instead sends the same entry twice in one message, at '
      + `full price both times. The recall block was:\n${memory}`);
    assert.ok(!memory.includes(TAIL),
      'a pointer carries the first clause and not the whole entry — that saving is the '
      + 'entire reason the ordering matters');
    assert.equal(turn.recall.pointers, 1,
      'and the turn records it, so a block that shrank because the seen-set worked can be '
      + 'told from one that shrank because recall found less');
  });

// ===========================================================================
// 12 — the briefing and the carried block are two files, and both render
// ===========================================================================

/*
 * `recallAsync` is the one mode where a second detached writer already exists. Sharing
 * `carry.json` would be a race between two processes with no lock, whose losing outcome is
 * silent — and if resume won it, `carryForward` would render it through
 * `wrap(…, carried=true)`, printing "it was retrieved against the previous message in this
 * conversation" about a block assembled before any message existed.
 */
test('recallAsync: the briefing renders above the carried block, from a different file', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': { json: ONE } });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const e = env(dataDir, server, { ...RESUME_ON, MUBIT_CC_RECALL_ASYNC: '1' });

  assert.notEqual(resumePath(dataDir), carryPath(dataDir),
    'two detached writers on one path is a race with no lock and a silent loser');

  await seedResume(e, dataDir);

  // Turn A primes the carry file and renders the briefing, since it is already on disk.
  const a = await runHook('prompt-recall', userPromptSubmit(), { env: e });
  assertHookContract(a);
  const first = String(a.json.hookSpecificOutput.additionalContext);
  assert.match(first, /<mubit-resume /,
    'the briefing does not wait for a carried block; the first prompt of an async session has '
    + 'none by construction and is precisely the prompt that needs it most');
  assert.ok(!first.includes('previous message'),
    'the briefing must never be rendered through the carry wrapper: it was assembled before '
    + 'any message existed, so "retrieved against the previous message" is a plain falsehood');

  await waitFor(() => existsSync(carryPath(dataDir)));
  assert.equal(existsSync(resumePath(dataDir)), false, 'consumed on turn A, not on turn B');

  const b = await runHook('prompt-recall',
    userPromptSubmit({ prompt_id: PROMPT_ID_B, prompt: 'and what does the drain do on 5xx?' }),
    { env: e });
  assertHookContract(b);
  const second = String(b.json.hookSpecificOutput.additionalContext);
  assert.match(second, /poll the job/, 'turn B renders the carried block');
  assert.match(second, /previous message/, 'and it says so, exactly as it always has');
  assert.ok(!second.includes('<mubit-resume'), 'and the briefing was spent on turn A');
});

// ===========================================================================
// 13 — the source matrix
// ===========================================================================

/*
 * `SessionStart` fires on five sources and only two of them describe a model whose window is
 * empty and whose run has history. Each row carries the reason it is where it is, because
 * every one of the three that do not spawn looks, from the hook's point of view, exactly like
 * one that should.
 */
const SOURCE_ROWS = [
  {
    source: 'startup', spawns: true,
    why: 'a new session on a run with history: an empty window and everything to catch up on',
  },
  {
    source: 'resume', spawns: true,
    why: '--resume re-opens a transcript, but the MODEL\'s window starts empty; this is the '
      + 'case the feature is named after',
  },
  {
    source: 'clear', spawns: false,
    why: '/clear asks for a blank slate, and lib/runid.mjs gives it a brand-new run id with '
      + 'nothing under it. There is no "where we left off" to describe',
  },
  {
    source: 'compact', spawns: false,
    why: 'a compaction is already re-anchored for free: session-start injects the checkpoint '
      + 'id that checkpoint --pre stored, which is the same job for no round trip',
  },
  {
    source: 'fork', spawns: false,
    why: 'a fork continues a conversation that is already in the window, so the briefing '
      + 'would describe context the model can still read',
  },
];

for (const row of SOURCE_ROWS) {
  test(`source "${row.source}" ${row.spawns ? 'assembles' : 'does not assemble'} a briefing`,
    async (t) => {
      const server = await fakeMubit({ 'POST /v2/control/context': { json: BRIEFING } });
      t.after(() => server.close());
      const dataDir = makeDataDir();
      const { file, env: e } = withSpy(env(dataDir, server, RESUME_ON));

      assertHookContract(await runHook('session-start',
        fx.sessionStart({ source: row.source, cwd: PROJECT_DIR }), { env: e }));

      if (row.spawns) {
        const spawns = await waitFor(() => {
          const s = resumeSpawns(file);
          return s.length ? s : null;
        });
        assert.equal(spawns.length, 1, row.why);
        await waitFor(() => existsSync(resumePath(dataDir)));
      } else {
        assert.equal(resumeSpawns(file).length, 0, row.why);
        assert.equal(server.countOf('POST', '/v2/control/context'), 0, row.why);
      }
    });
}

// ===========================================================================
// 14 — the flag, and the shipped default
// ===========================================================================

// Off means no process, no request, and nothing on disk — the same standard `recallAsync`'s
// opt-out is held to.
test('resumeBlock off: no second process, no context call, nothing written', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/context': { json: BRIEFING } });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const { file, env: e } = withSpy(env(dataDir, server, { MUBIT_CC_RESUME_BLOCK: '0' }));

  assertHookContract(await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }), { env: e }));

  assert.equal(resumeSpawns(file).length, 0);
  assert.equal(server.countOf('POST', '/v2/control/context'), 0);
  assert.equal(existsSync(resumePath(dataDir)), false);
});

/*
 * The shipped default is ON, and this is the only test in the repo that can see it: `baseEnv`
 * pins the flag off for every suite, because the detached child dials the same `fakeMubit` at
 * an unpredictable moment and would make `session-start.test.mjs`'s exact-call-sequence
 * assertion a coin flip.
 *
 * On is the right default because the cost is per SESSION, not per prompt. The three settings
 * that ship off are off because they cost something on every turn — `recallAsync` a second
 * process, `recallAssemble: server` two LLM calls, `preToolWarnings` text in front of a tool
 * call. This is one process and two LLM calls once, against the prompt where the model knows
 * least about what it is walking into.
 */
test('resumeBlock defaults ON: an install that sets nothing gets a briefing', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/context': { json: BRIEFING } });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const { file, env: e } = withSpy(env(dataDir, server));

  const { loadConfig } = await lib('config.mjs');
  assert.equal(loadConfig(unpinned(e)).resumeBlock, true,
    'if this ever ships off, the README row and the plugin.json default have to move with it');

  assertHookContract(await runHook('session-start', fx.sessionStart({ cwd: PROJECT_DIR }), {
    env: unpinned(e),
  }));

  await waitFor(() => resumeSpawns(file).length >= 1);
  await waitFor(() => existsSync(resumePath(dataDir)));
});

// ===========================================================================
// 15 — the failure paths
// ===========================================================================

/*
 * Every one of these has to end in "nothing written, nothing injected, exit 0". The shape of
 * the mistake they guard against is an empty `<mubit-resume>` element: 40 tokens of framing
 * around nothing, on the first prompt of every session, teaching the model that the channel
 * carries noise.
 */

// The server has nothing to say about this run — a brand-new project, a first session. That
// is a correct answer, and rendering a heading over it would be worse than silence.
test('an empty context block is not written and not injected', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/context': { json: contextResponse({ context_block: '', sources: [], empty_reason: 'no_evidence' }) },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();

  assertHookContract(await runHook('session-resume', fx.sessionStart({ cwd: PROJECT_DIR }), {
    env: env(dataDir, server, RESUME_ON), args: ['--run', RUN_ID, '--agent', 'a'],
  }));
  assert.equal(existsSync(resumePath(dataDir)), false);
});

// A 500 is the server's problem, and the child's only recourse is to leave the session
// un-briefed. It must not write, must not throw, and must exit 0 like every other hook.
test('a 500 from the context endpoint leaves nothing behind and still exits 0', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/context': { status: 500, json: { error: 'boom' } },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('session-resume', fx.sessionStart({ cwd: PROJECT_DIR }), {
    env: env(dataDir, server, RESUME_ON), args: ['--run', RUN_ID, '--agent', 'a'],
  });
  assertHookContract(r);
  assert.equal(existsSync(resumePath(dataDir)), false);
});

// Port 1 is where nothing listens. `fetch` rejects rather than answering, which is the one
// path where an unguarded child would exit non-zero.
test('a dead endpoint costs the briefing and nothing else', async () => {
  const dataDir = makeDataDir();
  const r = await runHook('session-resume', fx.sessionStart({ cwd: PROJECT_DIR }), {
    env: baseEnv({
      dataDir,
      endpoint: 'http://127.0.0.1:1',
      projectDir: PROJECT_DIR,
      extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN_ID, ...RESUME_ON },
    }),
    args: ['--run', RUN_ID, '--agent', 'a'],
  });
  assertHookContract(r);
  assert.equal(existsSync(resumePath(dataDir)), false);
});

// §4.1: with no endpoint there is nothing to brief from. `urlFor` would hand `fetch` a bare
// route, which throws `ERR_INVALID_URL` before a socket exists.
test('an unconfigured install dials nothing and writes nothing', async () => {
  const dataDir = makeDataDir();
  const e = baseEnv({
    dataDir, projectDir: PROJECT_DIR,
    extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN_ID, ...RESUME_ON },
  });
  e.MUBIT_ENDPOINT = '';

  const r = await runHook('session-resume', fx.sessionStart({ cwd: PROJECT_DIR }), {
    env: e, args: ['--run', RUN_ID, '--agent', 'a'],
  });
  assertHookContract(r);
  assert.equal(existsSync(resumePath(dataDir)), false);
});

// `recall: false` turns off the injection of memory, and a briefing is memory. Re-checked in
// the child rather than trusted from the parent, because this process can also be started by
// hand while debugging.
test('recall off: no briefing is assembled, whatever resumeBlock says', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/context': { json: BRIEFING } });
  t.after(() => server.close());
  const dataDir = makeDataDir();

  assertHookContract(await runHook('session-resume', fx.sessionStart({ cwd: PROJECT_DIR }), {
    env: env(dataDir, server, { ...RESUME_ON, MUBIT_CC_RECALL: '0' }),
    args: ['--run', RUN_ID, '--agent', 'a'],
  }));

  assert.equal(server.countOf('POST', '/v2/control/context'), 0);
  assert.equal(existsSync(resumePath(dataDir)), false);
});

// A briefing that is on disk when the flag goes off must not be injected either. The gate is
// on the read as well as on the write, so turning the feature off takes effect on the next
// prompt rather than after whatever is already staged has been spent.
test('resumeBlock off at read time: a briefing already on disk is not injected', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/query': { json: ONE } });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const on = env(dataDir, server, RESUME_ON);
  await seedResume(on, dataDir);

  const r = await runHook('prompt-recall', userPromptSubmit(), {
    env: env(dataDir, server, { MUBIT_CC_RESUME_BLOCK: '0' }),
  });
  assertHookContract(r);
  assert.ok(!String(r.json.hookSpecificOutput.additionalContext).includes('<mubit-resume'));
});
