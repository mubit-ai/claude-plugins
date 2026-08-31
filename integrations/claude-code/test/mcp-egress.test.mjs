// @ts-check
/**
 * What an MCP write actually puts on the wire.
 *
 * Every other outbound call in this plugin goes through `lib/http.mjs`, which refuses a
 * poisoned run id (§4.3) and scrubs the body first (§7). The MCP server is the exception:
 * it is a vendored bundle that dials the endpoint itself, and nothing in this repo saw the
 * request. Two things used to go out through that gap.
 *
 *   1. **Scope.** `mubit_learned` is the only write tool a default install exposes, and the
 *      bundled SDK hard-codes `lesson_scope: "session"` on it. `"session"` is not the
 *      per-run scope its name suggests — only `"run"` is — while the plugin promises the
 *      opposite in two places a user reads: `plugin.json` (`reflectOnEnd` — "the only path
 *      that promotes a lesson beyond its own run") and `skills/remember/SKILL.md`. The
 *      guard makes the wire match the promise.
 *
 *   2. **The run id.** Every write tool takes an optional `session_id`, so without the guard
 *      the run a write lands in is whatever the caller passed rather than the one the
 *      launcher derived.
 *
 * These tests assert on the **wire**, never on the mechanism: `mcpCallTool` runs the shipped
 * `mcp/dist/index.js` for real against a `fakeMubit` and hands back what it sent. A future
 * rebuild that fixes this upstream, or a different guard entirely, passes unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fakeMubit, mcpCallTool, mod, PLUGIN_ROOT } from './helpers/harness.mjs';

/** Pinned, so "which run did this land in" is never a derivation question. */
const RUN = 'cc-egress-test-run';

const LESSON = 'When the operator wedges, apply the CRD before the StatefulSet.';

/** Load `mcp/src/egress.mjs` fresh. */
const E = () => mod('mcp/src/egress.mjs');

/**
 * Call one tool against a live fake and return both halves: what the tool answered, and
 * what the server put on the wire to answer it.
 *
 * @param {any} t  the node:test context, for `t.after`
 * @param {string} name
 * @param {Record<string, any>} [args]
 * @param {{extra?: Record<string,string>, routes?: Record<string, any>}} [opts]
 */
async function call(t, name, args = {}, opts = {}) {
  const server = await fakeMubit(opts.routes ?? {});
  t.after(() => server.close());
  const out = await mcpCallTool(name, args, {
    endpoint: server.url,
    runId: RUN,
    extra: opts.extra ?? {},
  });
  return { server, out };
}

/** The single ingest item a lesson write produces. */
const wrote = (server) => {
  const call_ = server.lastCall('POST', '/v2/control/ingest');
  assert.ok(call_, 'nothing was posted to /v2/control/ingest at all');
  return { body: call_.body, item: call_.body?.items?.[0] };
};

// ---------------------------------------------------------------------------
// What the guard pins
// ---------------------------------------------------------------------------

// The default, and the one thing on this wire a user can change. `run` was the default until
// it was measured: on a live instance a reflect over a run holding an agent-written lesson
// stored its own output at `run` too, so a lesson stamped `run` had no path out of its run at
// all. `session` is also what the tool's own frozen description tells the model it does.
test('mubit_learned writes lesson_scope "session" at the default ceiling', async (t) => {
  const { server } = await call(t, 'mubit_learned', { text: LESSON });
  const { item } = wrote(server);

  assert.equal(item.lesson_scope, 'session',
    `the default ceiling decides this, and it is "session". Got ${JSON.stringify(item.lesson_scope)}.`);
});

// The narrowing direction still works, and it is one setting away. This is the assertion a
// user who wants per-run isolation is relying on.
test('a ceiling of "run" keeps an agent-written lesson inside its own run', async (t) => {
  const { server } = await call(t, 'mubit_learned', { text: LESSON },
    { extra: { MUBIT_MCP_LESSON_SCOPE: 'run' } });

  assert.equal(wrote(server).item.lesson_scope, 'run');
});

// The tool still has to work. A guard that silently dropped the lesson would pass the test
// above and be far worse than the bug.
test('the lesson itself still reaches the wire intact', async (t) => {
  const { server } = await call(t, 'mubit_learned', { text: LESSON });
  const { body, item } = wrote(server);

  assert.equal(item.text, LESSON);
  assert.equal(item.intent, 'lesson');
  assert.equal(body.run_id, RUN);
  assert.equal(item.source, 'agent');
});

// §4.3 — the launcher exists to derive the run id rather than let it be defaulted. The tool
// schema then hands the caller a `session_id` parameter that would override it. Closing the
// second hole is what makes the first one worth closing.
test('a caller-supplied session_id does not move the write out of the derived run', async (t) => {
  const { server } = await call(t, 'mubit_learned',
    { text: LESSON, session_id: 'someone-elses-run' });
  const { body } = wrote(server);

  assert.equal(body.run_id, RUN,
    'the agent named another run and the write followed it — per-run isolation is only as '
    + 'good as the run id the write lands in');
});

// ---------------------------------------------------------------------------
// The ceiling
// ---------------------------------------------------------------------------

// Isolation is the default, not the only option: a user who wants agent-written rules to
// follow them between projects raises the ceiling rather than restoring a whole tool.
test('MUBIT_MCP_LESSON_SCOPE raises the ceiling', async (t) => {
  const { server } = await call(t, 'mubit_learned', { text: LESSON },
    { extra: { MUBIT_MCP_LESSON_SCOPE: 'global' } });

  assert.equal(wrote(server).item.lesson_scope, 'global');
});

// Asking for the default explicitly is the same wire as leaving it alone.
test('a ceiling of "session" is the same as the default', async (t) => {
  const { server } = await call(t, 'mubit_learned', { text: LESSON },
    { extra: { MUBIT_MCP_LESSON_SCOPE: 'session' } });

  assert.equal(wrote(server).item.lesson_scope, 'session');
});

// A typo takes the documented default, exactly as every other enum setting does — never the
// widest scope, and never "whatever the SDK sent". The guard has a second, narrower net of
// its own for a value the config layer cannot produce; `resolveCeiling` below owns that one,
// and the two are deliberately different answers to two different questions.
test('an unrecognised ceiling takes the default, never the widest scope', async (t) => {
  const { server } = await call(t, 'mubit_learned', { text: LESSON },
    { extra: { MUBIT_MCP_LESSON_SCOPE: 'banana' } });

  assert.equal(wrote(server).item.lesson_scope, 'session');
});

// The original report's exact path: `mubit_remember` is off by default, but `mcpTools`
// restores it, and its `lesson_scope` is caller-chosen. Restoring a tool must not restore
// the defect.
test('a restored mubit_remember cannot write above the ceiling', async (t) => {
  const { server } = await call(t, 'mubit_remember',
    { text: LESSON, intent: 'lesson', lesson_scope: 'global' },
    { extra: { MUBIT_MCP_TOOLS: 'mubit_remember', MUBIT_MCP_LESSON_SCOPE: 'run' } });

  assert.equal(wrote(server).item.lesson_scope, 'run',
    'the agent asked for global and the ceiling is run — restoring a tool must not restore '
    + 'the ability to write past the setting');
});

// And the same at the shipped default: a caller asking for more than the ceiling is narrowed
// to it, whatever the ceiling happens to be.
test('a restored mubit_remember is clamped to the default ceiling too', async (t) => {
  const { server } = await call(t, 'mubit_remember',
    { text: LESSON, intent: 'lesson', lesson_scope: 'global' },
    { extra: { MUBIT_MCP_TOOLS: 'mubit_remember' } });

  assert.equal(wrote(server).item.lesson_scope, 'session');
});

// Clamping is one-directional. A caller that deliberately narrows its own write keeps the
// narrower scope; the ceiling is a maximum, not an assignment.
test('the ceiling never widens a write that asked for less', async (t) => {
  const { server } = await call(t, 'mubit_remember',
    { text: LESSON, intent: 'lesson', lesson_scope: 'run' },
    { extra: { MUBIT_MCP_TOOLS: 'mubit_remember', MUBIT_MCP_LESSON_SCOPE: 'global' } });

  assert.equal(wrote(server).item.lesson_scope, 'run');
});

// ---------------------------------------------------------------------------
// Saying so
// ---------------------------------------------------------------------------

// A silent clamp leaves the agent believing it stored something it did not — and the
// bundled tool description still promises "scoped to this session", which cannot be edited
// from this repo. The tool result is the only channel that can correct it.
test('a clamped write says so, and names the setting that would allow it', async (t) => {
  const { out } = await call(t, 'mubit_learned', { text: LESSON },
    { extra: { MUBIT_MCP_LESSON_SCOPE: 'run' } });

  assert.match(out.text, /run/,
    `the tool result never mentions the scope it actually wrote:\n${out.text}`);
  assert.match(out.text, /mcpLessonScope|MUBIT_MCP_LESSON_SCOPE/,
    `the tool result does not name the setting that raises the ceiling:\n${out.text}`);
  assert.equal(out.isError, false, 'a clamp is not a failure');
});

// Noise has a cost too: the note is a correction, so a write that needed no correcting must
// not carry one — which at the shipped default is every ordinary write. That is what makes
// the setting's other surfaces (the doctor skill, the README row) load-bearing rather than
// decorative: nothing in the tool result names it any more.
test('a write that needed no clamping is not annotated', async (t) => {
  const { out } = await call(t, 'mubit_learned', { text: LESSON });

  assert.doesNotMatch(out.text, /mcpLessonScope|MUBIT_MCP_LESSON_SCOPE/,
    `nothing was clamped, so nothing should be reported:\n${out.text}`);
});

// The write still has to be usable. Whatever the guard adds must not displace the job id
// the caller needs to follow the ingest.
test('the annotation rides alongside the real response, not instead of it', async (t) => {
  const { out } = await call(t, 'mubit_learned', { text: LESSON },
    { extra: { MUBIT_MCP_LESSON_SCOPE: 'run' } });

  assert.ok(out.json, `the tool result is not JSON:\n${out.text}`);
  assert.equal(out.json.job_id, 'job_test_1');
  assert.equal(out.json.accepted, true);
});

// ---------------------------------------------------------------------------
// Everything the guard must not touch
// ---------------------------------------------------------------------------

// Reads are the hot path — every prompt pays for them. The guard has no business there, and
// a query body it mangled would break recall for the sake of a write-side property.
test('a read is untouched', async (t) => {
  const { server, out } = await call(t, 'mubit_recall', { query: 'how do I start the daemon' });
  const body = server.lastCall('POST', '/v2/control/query')?.body;

  assert.ok(body, 'mubit_recall posted nothing to /v2/control/query');
  assert.equal(body.query, 'how do I start the daemon');
  assert.equal(body.run_id, RUN);
  assert.equal(out.isError, false);
  assert.doesNotMatch(out.text, /mcpLessonScope|MUBIT_MCP_LESSON_SCOPE/);
});

// `GET /v2/core/health` answers the bare text `OK`, not JSON. A guard that assumed every
// response was parseable would take the status tool down with it.
test('a non-JSON response survives the guard', async (t) => {
  const { out } = await call(t, 'mubit_status', {});

  assert.ok(out.json, `mubit_status did not answer JSON:\n${out.text}`);
  assert.equal(out.json.status, 'connected');
  assert.equal(out.json.health, 'OK');
});

// The guard sits in the request path of every call the server makes. If it can throw, it can
// take down a write that would otherwise have succeeded — so a failing endpoint must still
// produce the server's own error, not the guard's.
test('a 5xx from the endpoint is still reported as the tool failing, not the guard', async (t) => {
  const { out } = await call(t, 'mubit_learned', { text: LESSON },
    { routes: { 'POST /v2/control/ingest': { status: 500, json: { error: 'boom' } } } });

  assert.ok(out.result, 'no tool result at all — the server died rather than reporting');
  assert.match(`${out.text}`, /boom|500|error/i,
    `the failure was swallowed rather than reported:\n${out.text}`);
});

// ---------------------------------------------------------------------------
// The guard as a unit
// ---------------------------------------------------------------------------

// The guard's own fallback, and it is deliberately NOT the config default. `loadConfig`
// resolves an unrecognised setting to `session` like every other enum, and this layer never
// sees such a value — it exists as a second net for a string that reached the guard some
// other way, and for that case the safe answer is the narrowest scope, not the widest.
test('resolveCeiling defaults to run and refuses anything it does not know', async () => {
  const { resolveCeiling } = await E();

  assert.equal(resolveCeiling('run'), 'run');
  assert.equal(resolveCeiling('session'), 'session');
  assert.equal(resolveCeiling('global'), 'global');
  assert.equal(resolveCeiling(' GLOBAL '), 'global', 'settings arrive as typed');

  for (const bad of ['', '  ', 'banana', 'org', null, undefined, 5, {}]) {
    assert.equal(resolveCeiling(/** @type {any} */ (bad)), 'run',
      `${JSON.stringify(bad)} must fall back to run — the safe answer, not the SDK's`);
  }
});

// `org` is promotion-only and must never be client-written (§1.6). It sits above `global`,
// so a ceiling of `global` has to bring it down like anything else.
test('guardIngest clamps down the whole lattice and never up', async () => {
  const { guardIngest } = await E();
  const at = (scope, ceiling) => {
    const { body } = guardIngest(
      { run_id: RUN, items: [{ intent: 'lesson', lesson_scope: scope }] },
      { ceiling, runId: RUN, pinRun: true });
    return body.items[0].lesson_scope;
  };

  assert.equal(at('org', 'global'), 'global');
  assert.equal(at('global', 'run'), 'run');
  assert.equal(at('session', 'run'), 'run');
  assert.equal(at('global', 'session'), 'session');
  assert.equal(at('run', 'global'), 'run', 'a narrower request is honoured, not widened');
  assert.equal(at('session', 'global'), 'session');
});

test('guardIngest reports what it changed, and reports nothing when it changed nothing', async () => {
  const { guardIngest } = await E();

  const clamped = guardIngest(
    { run_id: RUN, items: [{ intent: 'lesson', lesson_scope: 'global' }] },
    { ceiling: 'run', runId: RUN, pinRun: true });
  assert.equal(clamped.changed, true);
  assert.equal(clamped.note?.lesson_scope?.requested, 'global');
  assert.equal(clamped.note?.lesson_scope?.written, 'run');

  const untouched = guardIngest(
    { run_id: RUN, items: [{ intent: 'lesson', lesson_scope: 'run' }] },
    { ceiling: 'run', runId: RUN, pinRun: true });
  assert.equal(untouched.changed, false);
  assert.equal(untouched.note, null);
});

test('guardIngest pins the run id, and says so', async () => {
  const { guardIngest } = await E();

  const moved = guardIngest(
    { run_id: 'someone-elses-run', items: [{ intent: 'lesson', lesson_scope: 'run' }] },
    { ceiling: 'run', runId: RUN, pinRun: true });
  assert.equal(moved.body.run_id, RUN);
  assert.equal(moved.changed, true);
  assert.equal(moved.note?.run_id?.requested, 'someone-elses-run');
  assert.equal(moved.note?.run_id?.written, RUN);

  const off = guardIngest(
    { run_id: 'someone-elses-run', items: [{ intent: 'lesson', lesson_scope: 'run' }] },
    { ceiling: 'run', runId: RUN, pinRun: false });
  assert.equal(off.body.run_id, 'someone-elses-run');
  assert.equal(off.changed, false);
});

// Captures, traces and tool output are not lessons and carry no scope. Rewriting them would
// be a guard inventing a field the server never had from this caller.
test('guardIngest leaves non-lesson items alone', async () => {
  const { guardIngest } = await E();
  const { body, changed } = guardIngest(
    { run_id: RUN, items: [{ intent: 'tool_output', text: 'ok' }, { intent: 'trace' }] },
    { ceiling: 'run', runId: RUN, pinRun: true });

  assert.equal(changed, false);
  assert.equal('lesson_scope' in body.items[0], false, 'the guard invented a scope field');
  assert.equal('lesson_scope' in body.items[1], false);
});

// The guard runs on every request the server makes, including shapes it has never seen. It
// must be inert on all of them rather than throwing inside somebody else's call.
test('guardIngest is inert on a body it does not understand', async () => {
  const { guardIngest } = await E();

  for (const body of [null, undefined, 'not json', 42, [], {}, { items: 'nope' }, { items: [null] }]) {
    const out = guardIngest(/** @type {any} */ (body), { ceiling: 'run', runId: RUN, pinRun: false });
    assert.equal(out.changed, false, `${JSON.stringify(body)} should be left alone`);
    assert.equal(out.body, body, 'an unrecognised body is passed through by identity');
  }
});

// ---------------------------------------------------------------------------
// When to delete all of this
// ---------------------------------------------------------------------------

/**
 * The guard exists because the fix belongs upstream and cannot be made here: the constant
 * lives inside a 5.9 MB vendored bundle whose TypeScript source is not in this repo.
 *
 * So this test states the premise. When it fails, the bundle has been rebuilt from an SDK
 * that no longer hard-codes `session` — at which point the guard is clamping something that
 * is already correct, and should be retired rather than left to double-apply forever.
 */
test('the vendored bundle still hard-codes the scope this guard exists to correct', () => {
  const bundle = readFileSync(join(PLUGIN_ROOT, 'mcp', 'dist', 'server.js'), 'utf8');

  assert.ok(bundle.includes('lesson_scope: "session"'),
    'the bundled SDK no longer hard-codes lesson_scope: "session".\n'
    + '  That is the upstream fix, and it makes mcp/src/egress.mjs redundant for this case.\n'
    + '  Re-check what the SDK now sends, then retire the guard (or narrow it to the run pin)\n'
    + '  rather than leaving two layers correcting the same value.');
});
