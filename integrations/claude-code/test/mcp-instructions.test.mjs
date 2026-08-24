// @ts-check
/**
 * Server `instructions` — what a model that never saw the SessionStart preamble is told.
 *
 * Under Claude Code's tool search only tool *names* and the server's `instructions` field
 * load at session start; a tool's description arrives after the model has already decided to
 * go looking. So `instructions` carries the whole "when is Mubit worth reaching for" argument
 * for two populations at once:
 *
 *   - every session with tool search on, where the ten descriptions are deferred;
 *   - every **subagent**. `hooks.json` registers `SessionStart` and `UserPromptSubmit` in the
 *     parent conversation only, so a subagent is handed no steer block and no per-turn
 *     injection. A subagent that does not search has no memory of this project at all.
 *
 * The bundled server cannot supply the field. `createServer()` in `mcp/dist/server.js` calls
 * `new McpServer({ name, version })` with no options object, and no `MUBIT_*` variable feeds
 * it — the only `instructions` in that 5.9 MB bundle are the SDK's own result schema and
 * `Server._instructions`, which nothing ever sets. There is no env hook to use, so the
 * launcher fills the field in on the outbound stdio frame instead (`mcp/src/instructions.mjs`),
 * the same seam discipline `mcp/src/egress.mjs` applies to `globalThis.fetch` — except that
 * `initialize` never crosses the network, so the wrapper goes on the frame rather than on fetch.
 *
 * This file speaks real stdio to the committed `mcp/dist/index.js`, the way
 * `test/mcp-surface.test.mjs` does. The launcher holding the right constant proves nothing
 * if the frame the host actually reads does not carry it.
 *
 * Offline by construction — `mcpDrive()` points the endpoint at port 1, and `initialize` is
 * answered from the server's own state without dialling anything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mcpDrive, mod, PLUGIN_ROOT } from './helpers/harness.mjs';

/** The remedy every failure over the shipped frame shares. Stated once. */
const REMEDY = '\n  `instructions` is filled in by mcp/src/instructions.mjs, installed from\n'
  + '  mcp/src/launch.mjs before it imports the server, and it reaches a user only through\n'
  + '  the committed bundle:\n'
  + '    MUBIT_CC_BUILD_SKIP_SERVER=1 npm run build';

/**
 * One `initialize`, shared. Four tests below ask different questions of the same frame, and
 * a 5.9 MB server bundle costs ~120 ms to start — nothing here mutates the answer.
 */
let _init;
const handshake = () => (_init ??= mcpDrive());

// ---------------------------------------------------------------------------
// The shipped frame
// ---------------------------------------------------------------------------

// The headline. Without this field a model under tool search is offered ten bare tool names
// and no statement of when any of them is worth reaching for.
test('initialize carries a non-empty instructions string', async () => {
  const { init, stderr } = await handshake();

  assert.equal(typeof init?.instructions, 'string',
    'the initialize result carried no `instructions` field, so under tool search the model '
    + 'meets ten bare tool names with nothing saying when to use one — and a subagent, which '
    + `sees no SessionStart preamble, meets nothing at all.${REMEDY}\n  server stderr:\n${stderr || '(silent)'}`);
  assert.ok(String(init.instructions).trim().length > 0,
    `\`instructions\` was present but blank, which the host renders as no guidance.${REMEDY}`);
});

// The launcher's constant is the editable copy; the frame is what ships. If these two ever
// drifted, editing the text in source would change nothing a user sees.
test('the instructions on the wire are the launcher\'s own constant', async () => {
  const { init } = await handshake();
  const { INSTRUCTIONS } = await mod('mcp/src/instructions.mjs');

  assert.equal(init.instructions, INSTRUCTIONS,
    'the text on the wire is not the INSTRUCTIONS constant in mcp/src/instructions.mjs — '
    + `editing that constant would then change nothing a user's model reads.${REMEDY}`);
});

// The preamble's own balance, minus the run-specific parts: recall is injected, so opening a
// turn with a search is pure cost — but a negative with no positive beside it trains a model
// to never call a memory tool at all (see the steer in `hooks/src/session-start.mjs`). Both
// halves have to be here, and the subagent case is the half the preamble cannot state.
test('instructions say when searching is wasted and when it is the only option', async () => {
  const { init } = await handshake();
  const text = String(init.instructions);

  assert.match(text, /inject/i,
    'the instructions never mention that memory is injected automatically, so a model pays '
    + 'for a recall call on turn one to fetch what it was already given');
  assert.match(text, /subagent/i,
    'the instructions never mention subagents, which are the population that receives no '
    + 'SessionStart preamble and no per-turn injection — for them this text is the only '
    + 'notice that a memory exists to search');
});

// The one thing a model gets wrong unprompted. `mubit_learned`'s own description says "a
// constraint, a fix that worked, a standing preference" but never says what is NOT a lesson,
// and under tool search that description is not even loaded when the model decides to write.
test('instructions say mubit_learned is for durable claims, not session narration', async () => {
  const { init } = await handshake();
  const text = String(init.instructions);

  assert.match(text, /mubit_learned/,
    'the instructions never name mubit_learned, the only lesson-writing tool a default '
    + 'install exposes');
  assert.match(text, /\bdurable\b/i,
    'the instructions never say a lesson has to be durable, so the model writes whatever the '
    + 'session happened to contain');
  assert.match(text, /\bnarrat|\bnot a session log\b|\bsession log\b/i,
    'the instructions never rule out narrating the session, which is the failure mode this '
    + 'text exists to pre-empt — a memory full of "the user asked me to refactor X" is a '
    + 'memory whose every future recall is noise');
});

// §8.2 advertises four tools that all read from memory. Choosing between them is the thing
// nobody was helped with, and under tool search the descriptions that would help are deferred.
test('instructions name the retrieval tool for each shape of question', async () => {
  const { init } = await handshake();
  const text = String(init.instructions);

  for (const [tool, why] of [
    ['mubit_recall', 'a topic stated in words'],
    ['mubit_diagnose', 'an error message from a command that just failed'],
    ['mubit_dereference', 'a reference_id the model already holds'],
    ['mubit_outcome', 'crediting what actually helped, which is what makes good memory rank'],
  ]) {
    assert.match(text, new RegExp(tool),
      `the instructions never name ${tool}, so ${why} has no tool attached to it`);
  }
});

// The guard sits in `process.stdout.write`, which carries every JSON-RPC frame this server
// will ever send. A wrapper that mangled the second frame would be a far worse bug than the
// missing field it fixes, and `mcpDrive` fails outright on a byte that is not protocol.
test('filling in instructions leaves the rest of the protocol untouched', async () => {
  const { init, results } = await mcpDrive({ steps: [{ method: 'tools/list' }, { method: 'tools/list' }] });

  assert.ok(init?.serverInfo?.name,
    'the initialize result lost its serverInfo — the guard must add a field, never rebuild the frame');
  for (const [i, r] of results.entries()) {
    assert.ok(Array.isArray(r?.result?.tools) && r.result.tools.length > 0,
      `tools/list #${i + 1} came back empty or malformed after the stdout guard was installed; `
      + 'a guard that can corrupt a later frame is worse than the missing field it fixes');
  }
});

// §3.5 — instructions load before the model does anything, on every session, so they are
// always-loaded surface exactly as the tool schemas are. A number measured before this field
// existed understates what the plugin costs.
test('context-cost.json bills for the instructions', async () => {
  const { INSTRUCTIONS } = await mod('mcp/src/instructions.mjs');
  const cost = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'scripts', 'context-cost.json'), 'utf8'));
  const billed = cost.breakdown?.serverInstructions;

  assert.ok(billed, 'context-cost.json has no `breakdown.serverInstructions`, so the declared '
    + 'contextCost omits a block of text every session loads before the model does anything '
    + '(§3.5).\n  Re-measure: node scripts/measure-context-cost.mjs --write');
  assert.equal(billed.chars, INSTRUCTIONS.length,
    `context-cost.json bills ${billed.chars} characters of instructions against the ${INSTRUCTIONS.length} `
    + 'the launcher ships — the declared budget describes a text that is no longer the one '
    + 'sent.\n  Re-measure: node scripts/measure-context-cost.mjs --write');
  assert.ok(billed.tokens > 0, 'instructions were measured at zero tokens, which cannot be right');
});

// ---------------------------------------------------------------------------
// The guard itself — the fall-through rule, in isolation
// ---------------------------------------------------------------------------
//
// `mcp/src/egress.mjs` states the rule this file inherits: the guard sits in the path of
// every frame the server sends, including shapes it has never seen, and it must never be
// able to break one. Each case below is a shape it must decline to touch.

test('a frame that is not an initialize result is returned by identity', async () => {
  const { guardInitialize } = await mod('mcp/src/instructions.mjs');

  for (const [label, frame] of [
    ['a tool result', { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'hi' }] } }],
    ['an error reply', { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'no' } }],
    ['a notification', { jsonrpc: '2.0', method: 'notifications/message', params: {} }],
    ['a request', { jsonrpc: '2.0', id: 3, method: 'ping' }],
  ]) {
    const out = guardInitialize(frame, 'TEXT');
    assert.equal(out.changed, false, `${label} was rewritten — only the initialize result may be touched`);
    assert.equal(out.message, frame,
      `${label} was cloned rather than passed through; the caller distinguishes "nothing to do" `
      + 'from "rewritten to the same value" by identity, so a copy here re-serialises a frame '
      + 'this code did not author');
  }
});

test('instructions the server supplied itself are never displaced', async () => {
  const { guardInitialize } = await mod('mcp/src/instructions.mjs');
  const frame = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      serverInfo: { name: 'mubit-memory', version: '0.9.0' },
      instructions: 'the server has its own now',
    },
  };

  const out = guardInitialize(frame, 'TEXT');
  assert.equal(out.changed, false,
    'the launcher overwrote instructions the bundled server set for itself. A rebuilt '
    + '@mubit-ai/mcp that grows its own text must win: this guard exists to fill a hole, not '
    + 'to take the field over');
  assert.equal(out.message, frame, 'an untouched frame must come back by identity');
});

test('a frame the guard cannot read is never rewritten', async () => {
  const { guardInitialize } = await mod('mcp/src/instructions.mjs');
  const initLike = {
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'x' } },
  };

  for (const [label, frame, text] of [
    ['null', null, 'TEXT'],
    ['a bare string', 'not a frame', 'TEXT'],
    ['an array', [1, 2, 3], 'TEXT'],
    ['a result with no protocolVersion', { jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }, 'TEXT'],
    ['a result with no serverInfo', { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } }, 'TEXT'],
    ['an initialize result but no text to add', initLike, ''],
  ]) {
    const out = guardInitialize(frame, text);
    assert.equal(out.changed, false, `${label} was rewritten`);
    assert.equal(out.message, frame,
      `${label} did not come back by identity — a shape this guard does not understand is not `
      + 'a reason to reshape somebody else\'s frame');
  }
});
