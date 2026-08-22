// @ts-check
/**
 * `lib/classify.mjs` on Codex's tool names.
 *
 * The stake is not a crash: `FALLBACK` already catches every unknown name and returns
 * `tool_output` / `low`, so an unported classifier is perfectly safe and perfectly useless.
 * What it loses is the **mutation-vs-read signal** — the one distinction the §4.5 table
 * exists to draw. `apply_patch` is the Codex equivalent of `Edit`/`Write`: the change *is*
 * the episode, and it is the row that makes a run replayable. Graded `tool_output`/`low` it
 * sinks below every `Read` in retrieval, and a run reads as a sequence of file reads that
 * somehow ended with the code different.
 *
 * The names below were recorded from live `PreToolUse` payloads (`docs/harness-probe.md` §5),
 * not read off a documentation page.
 *
 * One name deserves its own note. **Codex renames its shell tool to `Bash` in hook payloads**,
 * with Claude Code's exact `tool_input: {command}` shape — so the existing row already covers
 * it. `shell` is in the table anyway, because that is the name Codex uses everywhere else and
 * the payload rename is a compatibility shim this plugin does not control.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { lib } from './helpers/codex-fixtures.mjs';

let _mod;
const C = async () => (_mod ??= await lib('classify.mjs'));

describe('classifyTool — Codex tool names', () => {
  /**
   * One row per Codex tool, with a realistic `tool_input`. The classifier must not need the
   * input to reach the intent, but it must not choke on it either.
   */
  const TABLE = [
    // The shell, under both the name Codex sends to hooks and the name it uses internally.
    { tool: 'Bash', intent: 'tool_output', importance: 'low', input: { command: "sed -n '1,240p' README.md" } },
    { tool: 'shell', intent: 'tool_output', importance: 'low', input: { command: 'ls -la' } },

    // The mutation. This is the row the whole file is about.
    { tool: 'apply_patch', intent: 'trace', importance: 'medium', input: { command: '*** Begin Patch\n*** Add File: NOTES.md\n+probe note\n*** End Patch' } },

    // Session-shaping. Codex's answer to TodoWrite, and graded the same way.
    { tool: 'update_plan', intent: 'trace', importance: 'low', input: { plan: [{ step: 'probe', status: 'in_progress' }] } },

    // Reads.
    { tool: 'view_image', intent: 'tool_output', importance: 'low', input: { path: '/tmp/shot.png', detail: 'high' } },
    { tool: 'web_search', intent: 'tool_output', importance: 'low', input: { query: 'codex hooks json' } },

    // Subagent dispatch is an episode, not an output — the output arrives later, at that
    // subagent's SubagentStop. Codex glues the namespace to the tool with no separator.
    { tool: 'collaborationspawn_agent', intent: 'trace', importance: 'medium', input: { task_name: 'count_files', fork_turns: 'all' } },
  ];

  for (const row of TABLE) {
    // § One assertion per table row: a failure names the tool, not "the table".
    it(`${row.tool} → ${row.intent}/${row.importance}`, async () => {
      const { classifyTool } = await C();
      const got = classifyTool(row.tool, row.input, 'ok');
      assert.equal(got.intent, row.intent,
        `${row.tool} classified as ${got.intent}. ${row.intent === 'trace'
          ? 'A mutation graded as tool output sinks below every file read in retrieval, and the '
            + 'run reads as a sequence of reads that somehow ended with the code different.'
          : 'A read graded as a trace inflates the run with low-value episodes.'}`);
      assert.equal(got.importance, row.importance,
        `${row.tool} graded ${got.importance}, expected ${row.importance}.`);
      assert.equal(got.contentType, 'text', 'the plugin only ever writes text (§1.3).');
    });
  }
});

describe('classifyTool — the MCP prefix Codex uses', () => {
  /**
   * `mcp__<server>__<tool>` — recorded from a live payload, where a server named `probe`
   * produced `mcp__probe__probe_ping`. Claude Code's prefix for the *same* server is
   * `mcp__plugin_mubit-memory_mubit__`, which is why nothing may hard-code either.
   */
  const MCP = [
    ['mcp__mubit__mubit_recall', 'mubit', 'mubit_recall'],
    ['mcp__mubit__mubit_learned', 'mubit', 'mubit_learned'],
    ['mcp__github__create_issue', 'github', 'create_issue'],
    // The tool half may itself contain `__`, so only the FIRST separator divides the two.
    ['mcp__claude-in-chrome__tabs_close_mcp', 'claude-in-chrome', 'tabs_close_mcp'],
  ];

  for (const [name, server, tool] of MCP) {
    it(`${name} splits into ${server} / ${tool}`, async () => {
      const { classifyTool } = await C();
      const got = classifyTool(name, {}, 'ok');
      // § "Which server" is most of the signal in `mcp__github__create_issue` blowing up, so
      //   the split is kept in metadata even for a call that failed.
      assert.equal(got.metadata?.mcp_server, server, `server half of ${name} came out wrong.`);
      assert.equal(got.metadata?.mcp_tool, tool, `tool half of ${name} came out wrong.`);
      assert.equal(got.metadata?.tool, name, 'the full name is kept alongside the split.');
    });
  }
});

describe('classifyTool — the guarantee that has no exceptions', () => {
  /** Every Codex name, plus the shapes a payload can degenerate into. */
  const EVERYTHING = [
    'Bash', 'shell', 'apply_patch', 'update_plan', 'view_image', 'web_search',
    'collaborationspawn_agent', 'collaborationwait_agent', 'collaborationsend_message',
    'exec_command', 'write_stdin', 'image_generation', 'request_permissions',
    'mcp__mubit__mubit_recall', 'mcp__', '', '   ', null, undefined,
    'a-tool-openai-has-not-shipped-yet',
  ];

  for (const name of EVERYTHING) {
    it(`${JSON.stringify(name)} still gets a real intent`, async () => {
      const { classifyTool } = await C();
      const got = classifyTool(/** @type {any} */ (name), {}, 'ok');
      // § §1.5, and it admits no exceptions: an item that arrives at ingest already carrying a
      //   real intent is classified far more cheaply than one that arrives without it. At
      //   tool-call frequency that difference is a bill. `unclassified` is a valid intent tag
      //   upstream, which is exactly why it must never be *this* module's answer — it would
      //   pass every schema and cost an LLM round trip per item.
      assert.notEqual(got.intent, 'unclassified',
        `${JSON.stringify(name)} produced \`unclassified\`. There is no path through `
        + 'classify.mjs that may return it: unknown tool, blank name, null — all land on a real '
        + 'intent, because an untyped item costs an LLM call at ingest and this runs per tool call.');
      assert.ok(got.intent && got.importance, 'both fields are mandatory on every path.');
    });
  }
});

describe('classifyTool — failures outrank every row', () => {
  for (const tool of ['apply_patch', 'shell', 'update_plan', 'mcp__mubit__mubit_recall']) {
    it(`${tool} that failed → trace/high`, async () => {
      const { classifyTool } = await C();
      const got = classifyTool(tool, {}, 'failure');
      // § §4.5: a failed approach is the highest-value thing a coding agent can remember — the
      //   one class of knowledge the model cannot re-derive by reading the codebase — and the
      //   server turns a streak of them into an extracted lesson for free at a threshold of 3.
      //   Grading failures low would bury them in retrieval and starve that trigger.
      assert.equal(got.intent, 'trace', `a failed ${tool} must be a trace, whatever it succeeds as.`);
      assert.equal(got.importance, 'high', `a failed ${tool} must be high, whatever it succeeds as.`);
    });
  }
});

describe('classifyTool — the Claude Code table is untouched', () => {
  /** A spot check per group, because the real net is the 1067-test suite next door. */
  const CC = [
    ['Read', 'tool_output', 'low'],
    ['Edit', 'trace', 'medium'],
    ['Write', 'trace', 'medium'],
    ['Task', 'trace', 'medium'],
    ['TodoWrite', 'trace', 'low'],
    ['AskUserQuestion', 'feedback', 'medium'],
  ];
  for (const [tool, intent, importance] of CC) {
    it(`${tool} still → ${intent}/${importance}`, async () => {
      const { classifyTool } = await C();
      const got = classifyTool(tool, {}, 'ok');
      // § Adding Codex rows to a shared table is only additive if the existing rows still
      //   answer the same. A shared data directory means one run can hold items from both.
      assert.deepEqual([got.intent, got.importance], [intent, importance],
        `${tool} moved. The Codex rows were supposed to be additive.`);
    });
  }
});

describe('classifyTurn — a Codex subagent owns its own result', () => {
  it('SubagentStop carries the agent id through', async () => {
    const { classifyTurn } = await C();
    const got = classifyTurn('', '', {
      event: 'SubagentStop',
      agent_id: '01a02413-16ff-75b3-a2c0-b3e93f9cfa63',
      agent_type: 'default',
    });
    // § A subagent must own its own result. Attributing it to the parent is how a six-subagent
    //   fan-out collapses into one indistinguishable blob at recall time — and Codex sends the
    //   parent's session_id and turn_id on every subagent event, so agent_id is the only thing
    //   that separates siblings.
    assert.equal(got.intent, 'task_result');
    assert.equal(got.agentId, '01a02413-16ff-75b3-a2c0-b3e93f9cfa63',
      'the agent id was dropped; sibling subagents become indistinguishable.');
    assert.equal(got.agentType, 'default',
      'Codex reports every subagent as `default` — it has no plugin-defined agent types.');
  });

  it('a parent Stop claims no agent identity', async () => {
    const { classifyTurn } = await C();
    const got = classifyTurn('', '', { event: 'Stop' });
    assert.equal(got.agentId, '', 'the parent turn is not a subagent`s.');
  });
});
