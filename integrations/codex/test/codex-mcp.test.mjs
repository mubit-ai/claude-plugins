// @ts-check
/**
 * The Codex plugin's MCP server, over real stdio.
 *
 * Everything else in this suite can be answered from source. This cannot: the tool table is
 * built inside the bundled server at registration time, so what is *advertised* exists
 * nowhere but the shipped `mcp/dist/`. That gap is how a server which ignored
 * `MUBIT_MCP_TOOLS` once shipped past a green suite next door.
 *
 * So this file runs `integrations/codex/mcp/dist/index.js` — the file `.mcp.json` actually
 * points Codex at — speaks newline-delimited JSON-RPC to it, and asserts on the answers.
 *
 * The Codex-specific stake is the **duplicate bundle**. Two independently installable plugins
 * cannot share a path: a Codex marketplace install copies the plugin directory into
 * `$CODEX_HOME/plugins/cache/…`, and nothing in that copy can reach `../claude-code`. So this
 * plugin carries its own copy of the 5.9 MB vendored server, and the two copies have to stay
 * the same server — a stale one here means a Codex user's `mubit_learned` writes a shape the
 * hosted instance stopped accepting, with no local symptom at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  CODEX_ROOT, SHARED_ROOT, mcpListTools, mcpDrive, fakeMubit, makeDataDir,
} from './helpers/codex-fixtures.mjs';

/**
 * §8.2 — the curated set. A blank allowlist means these, never "none" and never all 21.
 *
 * The Claude Code plugin's `mcp/src/launch.mjs` is the single source of this list and both
 * plugins bundle it, so a promotion there reaches Codex without anyone editing this tree.
 * `mubit_strategies`, `mubit_checkpoint` and `mubit_memory_health` arrived that way, each with
 * a skill of its own — which is the part that does not travel for free, since Codex has no
 * `tools:` grant and the prose is the only place the qualified name appears.
 */
const DEFAULT_ALLOWLIST = [
  'mubit_archive', 'mubit_dereference', 'mubit_diagnose', 'mubit_forget', 'mubit_learned',
  'mubit_lessons', 'mubit_outcome', 'mubit_recall', 'mubit_reflect', 'mubit_status',
  'mubit_strategies', 'mubit_checkpoint', 'mubit_memory_health',
].sort();

const CODEX_SERVER = join(CODEX_ROOT, 'mcp', 'dist', 'server.js');
const SHARED_SERVER = join(SHARED_ROOT, 'mcp', 'dist', 'server.js');

// ===========================================================================
// The bundle on disk
// ===========================================================================

test('the Codex plugin carries its own copy of the server bundle', () => {
  // § Not a symlink and not a reach across the tree: a marketplace install is a directory
  //   copy, and `../claude-code` does not exist inside `$CODEX_HOME/plugins/cache/`. The
  //   duplicate is the cost of the second plugin.
  assert.ok(existsSync(CODEX_SERVER),
    `${CODEX_SERVER} is missing. Without it the MCP server does not start, and every skill in `
    + 'this plugin names tools that do not exist.');
  assert.ok(statSync(CODEX_SERVER).size > 1_000_000,
    'the server bundle is suspiciously small — it vendors the SDK and the gRPC stack.');
});

test('the two copies of the server are byte-identical', () => {
  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
  // § The build copies this file rather than regenerating it, precisely so this assertion can
  //   be exact. A drift here is invisible from either plugin: both start, both register tools,
  //   and one of them speaks a protocol version the instance has moved past.
  assert.equal(sha(CODEX_SERVER), sha(SHARED_SERVER),
    'the Codex and Claude Code server bundles have diverged. They are one vendored artifact '
    + 'copied twice; regenerate with `MUBIT_CC_BUILD_SKIP_SERVER=1 npm run build`.');
});

test('the launcher is this plugin`s own build, not a copy of the other one', () => {
  const src = readFileSync(join(CODEX_ROOT, 'mcp', 'dist', 'index.js'), 'utf8');
  // § `index.js` is bundled from the shared `mcp/src/launch.mjs`, so it is genuinely the same
  //   code — but it must be *built here*, because the bundle inlines lib/ and the Codex build
  //   inlines the boot shim's view of the world with it.
  assert.match(src, /mubit/i, 'the launcher bundle does not look like the Mubit launcher at all.');
  assert.ok(src.length > 10_000,
    'the launcher bundle is too small to contain lib/config.mjs and lib/runid.mjs, which it '
    + 'inlines — a plugin that cannot derive a run id refuses to start the server at all.');
});

// ===========================================================================
// tools/list
// ===========================================================================

test('tools/list advertises exactly the curated set', async () => {
  const { names, server } = await mcpListTools();
  // § The eight excluded verbs are excluded because a hook already does the job better, not
  //   because tools are off by default. Advertising all 21 spends the model's window on
  //   schemas for tools it has no surface to use.
  assert.deepEqual(names, DEFAULT_ALLOWLIST,
    `the Codex plugin advertises ${names.length} tools, not the curated ${DEFAULT_ALLOWLIST.length}. Under Codex the `
    + 'model sees each as `mcp__mubit__<name>`, and every skill in this plugin names them that '
    + `way.\n  got:      ${names.join(', ')}\n  expected: ${DEFAULT_ALLOWLIST.join(', ')}`);
  assert.ok(server?.name, 'the server did not identify itself in `initialize`.');
});

test('every advertised tool has a description the model can route on', async () => {
  const { tools } = await mcpListTools();
  for (const tool of tools) {
    // § Under tool search the host loads only names and descriptions at session start. A tool
    //   with a thin description is a tool that is never chosen.
    assert.ok(String(tool.description ?? '').trim().length > 20,
      `${tool.name} has no usable description; the model routes on it and nothing else.`);
    assert.equal(tool.inputSchema?.type, 'object',
      `${tool.name} has no object input schema — the model cannot construct a call.`);
  }
});

test('the allowlist is configurable, and a user list passes through verbatim', async () => {
  const { names } = await mcpListTools({ extra: { MUBIT_MCP_TOOLS: 'mubit_recall,mubit_learned' } });
  // § "Restore mubit_handoff" and "give me only mubit_recall" are both legitimate, and only a
  //   verbatim list expresses the second. A union with the default would make the narrow case
  //   inexpressible.
  assert.deepEqual(names, ['mubit_learned', 'mubit_recall'],
    'a user-supplied allowlist must pass through verbatim, not be unioned with the default.');
});

// ===========================================================================
// initialize
// ===========================================================================

test('the initialize frame carries the instructions block', async () => {
  const { init } = await mcpDrive({ steps: [] });
  // § The bundled server cannot supply this — `createServer()` is `new McpServer({name,
  //   version})` with no options object — so the launcher fills it into the outbound frame.
  //   Under Claude Code it is the only Mubit context a subagent or a tool-search session gets.
  //
  //   Under Codex it appears not to reach the model at all: a live session with an MCP server
  //   whose `instructions` said "Probe MCP server." answered that it had no such block, and
  //   the rollout records no tool catalogue to check against. That is a Codex-side question
  //   this suite cannot settle — but the frame is still emitted, because the day Codex starts
  //   surfacing it is not a day anyone will remember to come back and add it. What the plugin
  //   *relies* on instead is SessionStart's additionalContext, which docs/harness-probe.md §7
  //   proves lands.
  assert.ok(String(init?.instructions ?? '').trim(),
    'the launcher stopped filling in `instructions`. It costs nothing to emit and is the only '
    + 'thing that would work if Codex starts surfacing it.');
  assert.match(String(init.instructions), /[Mm]ubit/,
    'the instructions block does not mention Mubit, which is the one thing it exists to say.');
});

test('the server refuses to start rather than write into the poisoned default run', async () => {
  // § The facade maps `session_id` onto the control-plane `run_id`, and the upstream server
  //   defaults it to the literal "default" — a fallback rather than a run of anyone's. An
  //   unset `static` pin is the realistic way to reach it. Starting
  //   anyway would be worse than not starting: the hooks in the same session fail the same
  //   derivation and capture nothing, so the MCP writes would be the only thing landing, and
  //   landing in the wrong place.
  //
  //   Refusing means exiting, so the harness's "the server died" path is the *passing* one
  //   here and the assertion is on what it said on the way out. Codex surfaces an MCP
  //   server's stderr in its own log, which is where a user would go looking.
  let error = null;
  try {
    await mcpDrive({
      extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: '' },
      steps: [{ method: 'tools/list' }],
    });
  } catch (err) {
    error = err;
  }
  assert.ok(error,
    'the server answered tools/list with no derivable run id. Every write it then accepts '
    + 'lands in the shared "default" run, pooling this project with every other consumer of '
    + 'the instance.');
  assert.match(String(error.message), /not started/i,
    `the server exited without saying why. A silent refusal is indistinguishable from a crash:\n${error.message}`);
  assert.match(String(error.message), /run id/i,
    `the refusal must name the cause, which is the one thing a user can fix:\n${error.message}`);
});

// ===========================================================================
// A write, end to end
// ===========================================================================

test('a lesson written through the Codex plugin lands in the derived run', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());

  const { mcpCallTool } = await import('../../claude-code/test/helpers/harness.mjs');
  const r = await mcpCallTool('mubit_learned', {
    text: 'The Codex plugin ships hooks.json as a template, not as a live registration.',
    lesson_type: 'observation',
  }, {
    root: CODEX_ROOT,
    endpoint: server.url,
    dataDir: makeDataDir(),
    runId: 'codex-mcp-write-test',
  });

  // § This is the property the whole launcher exists for. If the MCP write and the hook
  //   captures derived different runs, `/mubit-memory:remember` would save into a run that
  //   pre-prompt recall never reads — and nothing anywhere would report it.
  assert.ok(!r.isError, `mubit_learned failed: ${r.text}`);
  const wrote = server.requests.filter((q) => q.method === 'POST');
  assert.ok(wrote.length > 0, 'the tool reported success and sent nothing.');
  const body = JSON.stringify(wrote.map((q) => q.body));
  assert.match(body, /codex-mcp-write-test/,
    'the write did not carry the derived run id. The upstream default is the literal '
    + `"default"; what went out was:\n${body.slice(0, 600)}`);
  assert.ok(!/"session_id"\s*:\s*"default"/.test(body),
    'the write went to the poisoned default run, which pools this project with every other '
    + 'consumer of the instance.');
});
