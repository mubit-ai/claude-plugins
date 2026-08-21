// @ts-check
/**
 * `lib/classify.mjs` — tool event → `{intent, importance}` and lesson templates.
 *
 * Guide §4.5 (the mapping table), §12.6 (test plan), §1.5 (why `intent` is
 * mandatory), §1.6 (the type inventory); spec §6.2 (categorisation).
 *
 * The stake, from §1.5: an item that arrives already carrying a real intent is
 * classified far more cheaply than one that arrives without it. At tool-call
 * frequency that difference is the difference between a plugin you leave on and
 * one you uninstall.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { lib, REPO_ROOT } from './helpers/harness.mjs';
import { postToolUse, postToolUseFailure, stop, subagentStop, preCompact, spoolItem } from './helpers/fixtures.mjs';

// ---------------------------------------------------------------------------
// Module under test — lazy so each test fails on its own with the
// "lib/classify.mjs does not exist yet" message rather than aborting the file.
// ---------------------------------------------------------------------------

let _mod;
const C = async () => (_mod ??= await lib('classify.mjs'));

// ---------------------------------------------------------------------------
// The type inventory (§1.6)
// ---------------------------------------------------------------------------

/** The 17 LTM entry types. */
const LTM_ENTRY_TYPES = [
  'fact', 'trace', 'archive_block', 'lesson', 'rule', 'handoff', 'feedback',
  'observation', 'tool_output', 'tool_input', 'reflection', 'task_result',
  'log', 'checkpoint', 'step_outcome', 'mental_model', 'workflow',
];

/** The 19 intent values — the 17 above plus these two. */
const INTENT_TAGS = [...LTM_ENTRY_TYPES, 'context', 'unclassified'];

/** Lesson importance levels. */
const IMPORTANCE = ['low', 'medium', 'high', 'critical'];

/** Lesson types. */
const LESSON_TYPES = ['success', 'failure', 'observation', 'rule', 'preference'];

/** lesson scope; `org` is promotion-only, never client-written. */
const LESSON_SCOPES = ['run', 'session', 'global', 'org'];

// ===========================================================================
// The §4.5 tool table
// ===========================================================================

describe('classifyTool — the §4.5 tool_name table', () => {
  /**
   * One row per line of the §4.5 table. `input` is a realistic `tool_input`
   * for that tool; the classifier must not need it to reach the intent, but it
   * must not choke on it either.
   */
  const TABLE = [
    // Read-shaped tools: path + capped excerpt. Cheap, plentiful, low value.
    { tool: 'Read',   intent: 'tool_output', importance: 'low',    input: { file_path: '/Users/x/repo/src/lib.rs' } },
    { tool: 'Grep',   intent: 'tool_output', importance: 'low',    input: { pattern: 'TODO', path: 'src' } },
    { tool: 'Glob',   intent: 'tool_output', importance: 'low',    input: { pattern: '**/*.rs' } },

    // Mutations: "the change is the episode".
    { tool: 'Edit',         intent: 'trace', importance: 'medium', input: { file_path: '/Users/x/repo/src/lib.rs', old_string: 'a', new_string: 'b' } },
    { tool: 'Write',        intent: 'trace', importance: 'medium', input: { file_path: '/Users/x/repo/src/new.rs', content: 'fn main() {}' } },
    { tool: 'MultiEdit',    intent: 'trace', importance: 'medium', input: { file_path: '/Users/x/repo/src/lib.rs', edits: [{ old_string: 'a', new_string: 'b' }] } },
    { tool: 'NotebookEdit', intent: 'trace', importance: 'medium', input: { notebook_path: '/Users/x/repo/nb.ipynb', new_source: 'print(1)' } },

    // Bash — also subject to self-reference suppression (§4.4), which runs
    // upstream of the classifier in capture.mjs step 2.
    { tool: 'Bash',   intent: 'tool_output', importance: 'low',    input: { command: 'cargo check -p tonic' } },

    // Web tools: URL + capped summary.
    { tool: 'WebFetch',  intent: 'tool_output', importance: 'low', input: { url: 'https://docs.rs/tonic', prompt: 'find the builder API' } },
    { tool: 'WebSearch', intent: 'tool_output', importance: 'low', input: { query: 'tonic build.rs proto' } },

    // Subagent dispatch is an episode, not an output.
    { tool: 'Task',   intent: 'trace', importance: 'medium',       input: { subagent_type: 'Explore', prompt: 'find the call sites' } },
  ];

  for (const row of TABLE) {
    // §4.5 tool_name → {intent, importance}, one assertion per table row.
    it(`${row.tool} → ${row.intent}/${row.importance}`, async () => {
      const { classifyTool } = await C();
      const r = classifyTool(row.tool, row.input, 'ok');

      assert.equal(r.intent, row.intent, `${row.tool} intent`);
      assert.equal(r.importance, row.importance, `${row.tool} importance`);
    });
  }

  // §5.4 step 4: classifyTool() → {intent, importance, contentType}.
  it('returns {intent, importance, contentType}', async () => {
    const { classifyTool } = await C();
    const r = classifyTool('Read', { file_path: '/Users/x/repo/src/lib.rs' }, 'ok');

    assert.equal(typeof r.intent, 'string');
    assert.equal(typeof r.importance, 'string');
    assert.equal(r.contentType, 'text', 'ingest item.content_type is required (§1.3)');
  });

  // §4.5: foreign `mcp__*` → tool_output/low, with server + tool in metadata.
  it('foreign mcp__* → tool_output/low with server and tool in metadata', async () => {
    const { classifyTool } = await C();
    const r = classifyTool('mcp__github__create_issue', { title: 'bug', body: 'x' }, 'ok');

    assert.equal(r.intent, 'tool_output');
    assert.equal(r.importance, 'low');
    assert.equal(typeof r.metadata, 'object', 'the mcp server/tool split must be preserved');
    assert.notEqual(r.metadata, null);

    const flat = JSON.stringify(r.metadata);
    assert.ok(flat.includes('github'), `metadata must name the MCP server; got ${flat}`);
    assert.ok(flat.includes('create_issue'), `metadata must name the MCP tool; got ${flat}`);
  });

  it('handles other foreign mcp__* servers the same way', async () => {
    const { classifyTool } = await C();
    for (const tool of ['mcp__codaph__codaph_status', 'mcp__linear__list_issues']) {
      const r = classifyTool(tool, {}, 'ok');
      assert.equal(r.intent, 'tool_output', `${tool} intent`);
      assert.equal(r.importance, 'low', `${tool} importance`);
    }
  });

  /**
   * §4.5: "any tool, PostToolUseFailure → trace / HIGH".
   *
   * Failures are high on purpose. A failed approach is the highest-value thing
   * a coding agent can remember — it is the one class of knowledge the model
   * cannot re-derive from the codebase — and a run of them is what makes an
   * extracted lesson show up later without anyone having asked for one.
   * Grading failures `low` would both bury them in retrieval and starve the
   * auto-reflection that depends on them.
   */
  for (const row of TABLE) {
    it(`${row.tool} on PostToolUseFailure → trace/high`, async () => {
      const { classifyTool } = await C();
      const r = classifyTool(row.tool, row.input, 'failure');

      assert.equal(r.intent, 'trace', `${row.tool} failure intent`);
      assert.equal(r.importance, 'high', `${row.tool} failure importance`);
    });
  }

  it('a failing foreign MCP tool is also trace/high', async () => {
    const { classifyTool } = await C();
    const r = classifyTool('mcp__github__create_issue', { title: 'bug' }, 'failure');
    assert.equal(r.intent, 'trace');
    assert.equal(r.importance, 'high');
  });

  // The recorded PostToolUseFailure payload is a `cargo check` blowing up.
  it('classifies the recorded PostToolUseFailure fixture as trace/high', async () => {
    const { classifyTool } = await C();
    const p = postToolUseFailure();
    const r = classifyTool(p.tool_name, p.tool_input, 'failure');

    assert.equal(r.intent, 'trace');
    assert.equal(r.importance, 'high');
  });

  // The recorded PostToolUse payload is an Edit.
  it('classifies the recorded PostToolUse fixture as trace/medium', async () => {
    const { classifyTool } = await C();
    const p = postToolUse();
    const r = classifyTool(p.tool_name, p.tool_input, 'ok');

    assert.equal(r.intent, 'trace');
    assert.equal(r.importance, 'medium');
  });
});

// ===========================================================================
// Turn-level classification
// ===========================================================================

describe('classifyTurn — Stop, SubagentStop, PreCompact (§4.5)', () => {
  // §4.5: Stop Q&A pair → task_result/medium.
  it('a Stop Q&A pair → task_result/medium', async () => {
    const { classifyTurn } = await C();
    const s = stop();
    const r = classifyTurn('why is the ingest job stuck in queued?', s.last_assistant_message);

    assert.equal(r.intent, 'task_result');
    assert.equal(r.importance, 'medium');
  });

  /**
   * §4.5: SubagentStop → task_result/medium, "attributed to the subagent
   * agent_id". The third argument is the options bag carrying the hook event
   * and the payload's `agent_id`, which `deriveAgentId` (§4.3) turns into
   * `claude-code-<sessionShort>-sub-<agentShort>`.
   */
  it('a SubagentStop → task_result/medium attributed to the subagent agent_id', async () => {
    const { classifyTurn } = await C();
    const s = subagentStop();
    const r = classifyTurn('find the call sites', s.last_assistant_message, {
      event: 'SubagentStop',
      agent_id: s.agent_id,
      agent_type: s.agent_type,
    });

    assert.equal(r.intent, 'task_result');
    assert.equal(r.importance, 'medium');
    assert.equal(r.agentId, s.agent_id,
      'the subagent must own its own result, not the parent session');
  });

  it('a plain Stop is not attributed to a subagent', async () => {
    const { classifyTurn } = await C();
    const r = classifyTurn('why is it stuck?', stop().last_assistant_message, { event: 'Stop' });

    assert.equal(r.intent, 'task_result');
    assert.ok(!r.agentId, 'a top-level Stop has no subagent to attribute to');
  });

  /**
   * §4.5: PreCompact → `checkpoint`. Importance is "—" in the table because the
   * item never reaches ingest: it goes via `POST /v2/control/checkpoint`
   * (§5.6), which has no importance field.
   */
  it('PreCompact → checkpoint', async () => {
    const { classifyTurn } = await C();
    const r = classifyTurn('', '', { event: 'PreCompact', trigger: preCompact().trigger });

    assert.equal(r.intent, 'checkpoint');
  });

  it('does not throw on an empty prompt or a missing assistant message', async () => {
    const { classifyTurn } = await C();
    assert.doesNotThrow(() => classifyTurn('', ''));
    assert.doesNotThrow(() => classifyTurn(undefined, undefined));
    assert.doesNotThrow(() => classifyTurn('q', undefined, {}));
  });
});

// ===========================================================================
// The §1.5 guarantee
// ===========================================================================

describe('§1.5 — every produced item carries a real intent', () => {
  /**
   * Every tool name the plugin can plausibly see, plus the degenerate ones.
   * The fallback for an unknown tool must still be a real intent: omitting
   * `intent`, or emitting `unclassified`, sends the item down the LLM
   * classification path in the server— one round trip per
   * captured item, at tool-call frequency.
   */
  const ALL_TOOLS = [
    'Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
    'Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'Task',
    'TodoWrite', 'ExitPlanMode', 'SlashCommand', 'Skill', 'AskUserQuestion',
    'mcp__github__create_issue', 'mcp__codaph__codaph_status',
  ];

  const DEGENERATE = [
    ['an unknown tool',        'SomeToolWeHaveNeverSeen'],
    ['a future built-in',      'Artifact'],
    ['an empty tool name',     ''],
    ['undefined',              undefined],
    ['null',                   null],
    ['a whitespace-only name', '   '],
    ['a bare mcp prefix',      'mcp__'],
  ];

  for (const outcome of ['ok', 'failure']) {
    for (const tool of ALL_TOOLS) {
      it(`${tool} (${outcome}) has a non-empty, non-unclassified intent`, async () => {
        const { classifyTool } = await C();
        const r = classifyTool(tool, {}, outcome);

        assert.equal(typeof r.intent, 'string', `${tool}: intent must be a string`);
        assert.ok(r.intent.length > 0, `${tool}: intent must be non-empty`);
        assert.notEqual(r.intent, 'unclassified',
          `${tool}: 'unclassified' costs one LLM call per item`);
        assert.ok(INTENT_TAGS.includes(r.intent), `${tool}: '${r.intent}' is not a valid intent`);
      });
    }
  }

  for (const [why, tool] of DEGENERATE) {
    it(`falls back to a real intent for ${why}`, async () => {
      const { classifyTool } = await C();
      const r = classifyTool(/** @type {any} */ (tool), {}, 'ok');

      assert.equal(typeof r.intent, 'string');
      assert.ok(r.intent.length > 0, 'the fallback must not be empty');
      assert.notEqual(r.intent, 'unclassified', 'the fallback must not be the LLM trigger');
      assert.ok(INTENT_TAGS.includes(r.intent),
        `fallback '${r.intent}' is not one of the 19 intent values`);
      assert.ok(IMPORTANCE.includes(r.importance),
        `fallback importance '${r.importance}' is not a lesson importance`);
    });
  }

  // §1.6: the 19 intent values, and only those.
  it('every intent the classifier emits is one of the 19 intent values', async () => {
    const { classifyTool, classifyTurn } = await C();
    const seen = new Set();

    for (const outcome of ['ok', 'failure']) {
      for (const tool of [...ALL_TOOLS, ...DEGENERATE.map(([, t]) => t)]) {
        seen.add(classifyTool(/** @type {any} */ (tool), {}, outcome).intent);
      }
    }
    for (const event of ['Stop', 'SubagentStop', 'PreCompact']) {
      seen.add(classifyTurn('q', 'a', { event }).intent);
    }

    assert.ok(seen.size > 0, 'sanity: the classifier produced something');
    for (const intent of seen) {
      assert.ok(INTENT_TAGS.includes(intent), `'${intent}' is not a valid intent`);
    }
  });

  // Separately: `unclassified` is valid on the wire but must never be emitted.
  it('never actually emits `unclassified`, though it is a valid intent', async () => {
    const { classifyTool, classifyTurn } = await C();

    assert.ok(INTENT_TAGS.includes('unclassified'), 'sanity: it is one of the 19');

    for (const outcome of ['ok', 'failure']) {
      for (const tool of [...ALL_TOOLS, ...DEGENERATE.map(([, t]) => t)]) {
        const r = classifyTool(/** @type {any} */ (tool), {}, outcome);
        assert.notEqual(r.intent, 'unclassified', `${tool}/${outcome} emitted unclassified`);
      }
    }
    for (const event of ['Stop', 'SubagentStop', 'PreCompact']) {
      assert.notEqual(classifyTurn('q', 'a', { event }).intent, 'unclassified',
        `${event} emitted unclassified`);
    }
  });

  // Importance must likewise be a real lesson importance on every path.
  it('every importance the classifier emits is a lesson importance', async () => {
    const { classifyTool } = await C();
    for (const outcome of ['ok', 'failure']) {
      for (const tool of ALL_TOOLS) {
        const r = classifyTool(tool, {}, outcome);
        assert.ok(IMPORTANCE.includes(r.importance),
          `${tool}/${outcome}: '${r.importance}' is not one of ${IMPORTANCE.join('|')}`);
      }
    }
  });
});

// ===========================================================================
// Lesson templates
// ===========================================================================

describe('applyLessonTemplate — the 8 templates (§4.5)', () => {
  /**
   * All 8 templates, written out here independently of the implementation. Being a second
   * copy is the point: `lib/classify.mjs` holds the table the plugin actually sends, and the
   * drift guard at the end of this block compares the two. A typo in either surfaces as a
   * failure rather than as every lesson stored at the wrong scope.
   */
  const TEMPLATES = {
    CODING_RULE:          { intent: 'lesson', lesson_type: 'rule',        lesson_scope: 'global' },
    DEBUG_SUCCESS:        { intent: 'lesson', lesson_type: 'success',     lesson_scope: 'session' },
    DEBUG_FAILURE:        { intent: 'lesson', lesson_type: 'failure',     lesson_scope: 'session' },
    PREFERENCE:           { intent: 'lesson', lesson_type: 'preference',  lesson_scope: 'global' },
    ARCHITECTURE_INSIGHT: { intent: 'lesson', lesson_type: 'observation', lesson_scope: 'global' },
    BUILD_CONFIG:         { intent: 'lesson', lesson_type: 'rule',        lesson_scope: 'global' },
    API_PATTERN:          { intent: 'lesson', lesson_type: 'observation', lesson_scope: 'session' },
    TEST_STRATEGY:        { intent: 'lesson', lesson_type: 'success',     lesson_scope: 'global' },
  };

  for (const [name, expected] of Object.entries(TEMPLATES)) {
    it(`${name} → ${expected.lesson_type}/${expected.lesson_scope}`, async () => {
      const { applyLessonTemplate } = await C();
      const item = spoolItem({ text: 'Always run the migration before starting the server.' });
      const out = applyLessonTemplate(item, name);

      assert.equal(out.intent, expected.intent, `${name} intent`);
      assert.equal(out.lesson_type, expected.lesson_type, `${name} lesson_type`);
      assert.equal(out.lesson_scope, expected.lesson_scope, `${name} lesson_scope`);
    });
  }

  it('preserves the rest of the item', async () => {
    const { applyLessonTemplate } = await C();
    const item = spoolItem({ text: 'Poll the ingest job; "queued" is not "stored".' });
    const out = applyLessonTemplate(item, 'CODING_RULE');

    assert.equal(out.text, item.text, 'content must survive the template');
    assert.equal(out.item_id, item.item_id, 'item_id is required (§1.3) and must survive');
    assert.equal(out.content_type, item.content_type, 'content_type is required (§1.3)');
    assert.equal(out.source, item.source);
    assert.deepEqual(out.env_tags, item.env_tags);
  });

  it('emits only valid lesson type / lesson scope values', async () => {
    const { applyLessonTemplate } = await C();
    for (const name of Object.keys(TEMPLATES)) {
      const out = applyLessonTemplate(spoolItem(), name);
      assert.ok(LESSON_TYPES.includes(out.lesson_type), `${name}: bad lesson_type ${out.lesson_type}`);
      assert.ok(LESSON_SCOPES.includes(out.lesson_scope), `${name}: bad lesson_scope ${out.lesson_scope}`);
      assert.notEqual(out.lesson_scope, 'org',
        `${name}: org is promotion-only and must never be client-written (§1.6)`);
    }
  });

  /**
   * An unknown template name must be a loud error. Silently passing the item
   * through would store a `remember` call as an untyped item — the user asked
   * for a lesson and got a log line, with nothing to tell them so.
   */
  it('throws on an unknown template name', async () => {
    const { applyLessonTemplate } = await C();
    const item = spoolItem();

    assert.throws(() => applyLessonTemplate(item, 'NOT_A_TEMPLATE'),
      /NOT_A_TEMPLATE|unknown|template/i,
      'an unknown template must not be a silent pass-through');
    assert.throws(() => applyLessonTemplate(item, ''), /template/i);
    assert.throws(() => applyLessonTemplate(item, undefined), /template/i);
    assert.throws(() => applyLessonTemplate(item, 'coding_rule'),
      /coding_rule|unknown|template/i,
      'template names are the SCREAMING_SNAKE keys of LESSON_TEMPLATES, not free text');
  });

  /**
   * Drift guard, between the table above and the one `lib/classify.mjs` sends.
   *
   * This used to parse the upstream TypeScript the plugin's copy was taken from. That file
   * is not part of the plugin — it lives outside `PLUGIN_ROOT`, so an installed copy does
   * not have it and this test could only ever pass in a monorepo checkout. The templates are
   * a client-side table and are not in `mcp/dist/server.js` either, so the honest target is
   * the plugin's own module: two independently-written copies of the same 8 triples, and a
   * mismatch means a `remember` call silently mis-scopes every lesson it writes.
   *
   * That does mean drift *away from upstream* is no longer caught here. It cannot be: the
   * upstream source is not published. It belongs to `@mubit-ai/mcp`'s own suite, which is
   * where a change to the shared table is made in the first place.
   */
  it('lib/classify.mjs has not drifted from the templates pinned here', async () => {
    const { LESSON_TEMPLATES } = await C();

    assert.ok(LESSON_TEMPLATES, 'lib/classify.mjs must export LESSON_TEMPLATES');
    assert.equal(Object.keys(TEMPLATES).length, 8,
      `the pinned table must carry all 8 templates, has ${Object.keys(TEMPLATES).length}`);
    assert.deepEqual(
      Object.keys(LESSON_TEMPLATES).sort(),
      Object.keys(TEMPLATES).sort(),
      'lib/classify.mjs knows a different set of template names than this test pins');

    for (const [name, expected] of Object.entries(TEMPLATES)) {
      const got = LESSON_TEMPLATES[name];
      assert.equal(got.intent, expected.intent, `${name}.intent drifted`);
      assert.equal(got.lesson_type, expected.lesson_type, `${name}.lesson_type drifted`);
      assert.equal(got.lesson_scope, expected.lesson_scope, `${name}.lesson_scope drifted`);
    }
  });
});

// ===========================================================================
// signal → template heuristics  [not implemented]
// ===========================================================================

describe('signal → template heuristics [not implemented]', {
  skip: 'lib/classify.mjs does not export suggestTemplate(signal). Unskip if it '
      + 'ever does and this mapping is the agreed one.',
}, () => {
  /**
   * A sketch of how an observed signal could pick a lesson template on its own.
   * Nothing reads this today — `suggestTemplate` does not exist — so the table is a
   * design note kept beside the templates it would use, not a contract.
   */
  const HEURISTICS = [
    { why: 'PostToolUseFailure on Bash with a non-zero exit',
      signal: { event: 'PostToolUseFailure', tool: 'Bash', input: { command: 'cargo check -p my-crate' }, exit_code: 101 },
      template: 'DEBUG_FAILURE' },
    { why: 'a failing Bash command later succeeding with the same intent',
      signal: { event: 'PostToolUse', tool: 'Bash', input: { command: 'cargo check -p my-crate' }, prior_failure: true },
      template: 'DEBUG_SUCCESS' },
    { why: 'Edit to a lint config path',
      signal: { event: 'PostToolUse', tool: 'Edit', input: { file_path: '/Users/x/repo/.eslintrc.json' } },
      template: 'CODING_RULE' },
    { why: 'Write to a CI config path',
      signal: { event: 'PostToolUse', tool: 'Write', input: { file_path: '/Users/x/repo/.github/workflows/ci.yml' } },
      template: 'CODING_RULE' },
    { why: 'a build/deploy verb succeeding after a failure',
      signal: { event: 'PostToolUse', tool: 'Bash', input: { command: 'docker build -t app:latest .' }, prior_failure: true },
      template: 'BUILD_CONFIG' },
    { why: 'PostToolUseFailure on WebFetch',
      signal: { event: 'PostToolUseFailure', tool: 'WebFetch', input: { url: 'https://api.example.com/v1' } },
      template: 'API_PATTERN' },
    { why: 'PostToolUseFailure on a foreign mcp__* tool',
      signal: { event: 'PostToolUseFailure', tool: 'mcp__github__create_issue', input: { title: 'x' } },
      template: 'API_PATTERN' },
    { why: 'a test-runner verb',
      signal: { event: 'PostToolUse', tool: 'Bash', input: { command: 'cargo test -p my-crate' } },
      template: 'TEST_STRATEGY' },
    { why: 'a user prompt correcting the assistant',
      signal: { event: 'UserPromptSubmit', prompt: 'no, use tabs not spaces in this repo' },
      template: 'PREFERENCE' },
    { why: 'a Read fan-out over 5+ files in one directory tree',
      signal: { event: 'PostToolUse', tool: 'Read', input: { file_path: '/Users/x/repo/src/store/entries.rs' }, fanout: 6 },
      template: 'ARCHITECTURE_INSIGHT' },
  ];

  for (const row of HEURISTICS) {
    it(`${row.why} → ${row.template}`, async () => {
      const { suggestTemplate } = await C();
      assert.equal(suggestTemplate(row.signal), row.template);
    });
  }

  it('returns null for a signal that matches no heuristic', async () => {
    const { suggestTemplate } = await C();
    assert.equal(suggestTemplate({ event: 'PostToolUse', tool: 'Read', input: { file_path: '/Users/x/repo/README.md' } }), null);
  });
});
