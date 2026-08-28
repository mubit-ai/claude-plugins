// @ts-check
/**
 * `lib/classify.mjs` — tool event -> `{intent, importance, contentType}`, plus the lesson
 * templates the `remember` skill expands.
 *
 * The mapping table, why `intent` is mandatory, and the type
 * inventory); spec §6.2 (categorisation).
 *
 * ---------------------------------------------------------------------------
 * The performance fact this whole module exists to serve (§1.5)
 * ---------------------------------------------------------------------------
 * An item that arrives at ingest already carrying a real intent is classified far more
 * cheaply than one that arrives without it. At tool-call frequency that difference is
 * the difference between a plugin you leave on and one you uninstall.
 *
 * So: **there is no path through this file that returns an empty, missing, or
 * `unclassified` intent.** Unknown tool, blank name, `undefined`, `null` — all land on a
 * real intent tag. The fallback is deliberately the cheapest true statement we can make
 * about an unrecognised tool: its output is tool output, and it is low value until
 * something proves otherwise.
 *
 * Zero dependencies, Node >= 20 built-ins only, synchronous, and nothing here throws.
 */

/** §1.3: every ingest item carries a `content_type`; the plugin only ever writes text. */
const CONTENT_TYPE = 'text';

/**
 * §4.5, the `tool_name` table. Values are `[intent, importance]`.
 *
 * The three groups, and why:
 *   - Read-shaped tools (`Read`/`Grep`/`Glob`/`Bash`/web) are `tool_output`/`low`: cheap,
 *     plentiful, and individually near-worthless in retrieval. They earn their place as
 *     context around the mutations, not on their own.
 *   - Mutations (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`) are `trace`/`medium`: the
 *     change *is* the episode. This is the row that makes a run replayable.
 *   - `Task` is `trace`/`medium` because dispatching a subagent is an episode, not an
 *     output — the output arrives later, at that subagent's `SubagentStop`.
 *
 * The rows below the guide's table are the remaining real Claude Code built-ins. They are
 * not in §4.5, but §1.5 admits no exceptions, and a named row is always better than the
 * fallback: `AskUserQuestion` in particular is genuine `feedback` — the one entry type
 * that records what the human, not the model, decided.
 *
 * The last block is Codex's tool set, for the sibling plugin that shares this file. The two
 * hosts' names live in one table on purpose: they also share a data directory, so one run can
 * hold items from both, and a run whose `apply_patch`es grade differently from its `Edit`s is
 * a run that reads inconsistently to whatever retrieves it.
 * @type {Record<string, [string, string]>}
 */
const TOOL_TABLE = {
  // Reads — path + capped excerpt.
  Read: ['tool_output', 'low'],
  Grep: ['tool_output', 'low'],
  Glob: ['tool_output', 'low'],

  // Mutations — the change is the episode.
  Edit: ['trace', 'medium'],
  Write: ['trace', 'medium'],
  MultiEdit: ['trace', 'medium'],
  NotebookEdit: ['trace', 'medium'],

  // Shell — also subject to §4.4 self-reference suppression, which runs upstream of this
  // module in `capture.mjs` step 2.
  Bash: ['tool_output', 'low'],
  BashOutput: ['tool_output', 'low'],
  KillShell: ['tool_output', 'low'],

  // Web — URL + capped summary.
  WebFetch: ['tool_output', 'low'],
  WebSearch: ['tool_output', 'low'],

  // Subagent dispatch.
  Task: ['trace', 'medium'],

  // Session-shaping built-ins.
  TodoWrite: ['trace', 'low'],
  ExitPlanMode: ['trace', 'medium'],
  SlashCommand: ['trace', 'low'],
  Skill: ['trace', 'low'],
  AskUserQuestion: ['feedback', 'medium'],

  // -------------------------------------------------------------------------
  // Codex CLI, for the sibling `integrations/codex` plugin.
  // -------------------------------------------------------------------------
  // `FALLBACK` already covers every one of these, so nothing here is about avoiding a
  // crash — an unported classifier is perfectly safe and perfectly useless. What these rows
  // recover is the **mutation-vs-read signal**, which is the one distinction the table above
  // exists to draw at all.
  //
  // Codex renames its shell tool to `Bash` in hook payloads, with this file's exact
  // `tool_input: {command}` shape, so the `Bash` row above already serves it. `shell` is here
  // anyway: that is the name Codex uses everywhere else, and the payload rename is a
  // compatibility shim this plugin neither controls nor can see.
  shell: ['tool_output', 'low'],
  exec_command: ['tool_output', 'low'],
  write_stdin: ['tool_output', 'low'],

  // The row this block is for. `apply_patch` is Codex's `Edit`/`Write`: the change IS the
  // episode. Left on the fallback it grades `tool_output`/`low`, sinks below every file read
  // in retrieval, and a run reads as a sequence of reads that somehow ended with the code
  // different.
  apply_patch: ['trace', 'medium'],

  // Codex's `TodoWrite`, and graded identically — the plan that matters is in the turn.
  update_plan: ['trace', 'low'],

  // Reads: a path plus a capped result.
  view_image: ['tool_output', 'low'],
  web_search: ['tool_output', 'low'],

  // Subagent dispatch — Codex's `Task`, and an episode for the same reason: the output
  // arrives later, at that subagent's `SubagentStop`. The namespace is glued to the tool
  // name with no separator, which is how it arrives in the payload.
  collaborationspawn_agent: ['trace', 'medium'],
  collaborationassign_agent_task: ['trace', 'medium'],
};

/** §1.5: the fallback for anything unrecognised. A real intent, never `unclassified`. */
const FALLBACK = /** @type {[string, string]} */ (['tool_output', 'low']);

/** §4.5: foreign `mcp__*` — server + tool in metadata. */
const MCP = /** @type {[string, string]} */ (['tool_output', 'low']);

/**
 * §4.5: "any tool, `PostToolUseFailure` -> `trace` / **`high`**".
 *
 * Failures are `high` on purpose, and it overrides every row above. A failed approach is
 * the highest-value thing a coding agent can remember — it is the one class of knowledge
 * the model cannot re-derive by reading the codebase — and a run of them is what reflection
 * turns into a durable lesson. Grading failures `low` would both bury them in retrieval and
 * starve the reflection that feeds on them.
 */
const FAILURE = /** @type {[string, string]} */ (['trace', 'high']);

const MCP_PREFIX = 'mcp__';

/** @param {any} outcome @returns {boolean} */
function isFailure(outcome) {
  const s = String(outcome ?? '').trim().toLowerCase();
  return s === 'failure' || s === 'fail' || s === 'error';
}

/**
 * Split `mcp__<server>__<tool>`. The tool half may itself contain `__`
 * (`mcp__claude-in-chrome__tabs_close_mcp`), so only the FIRST separator after the prefix
 * divides server from tool.
 * @param {string} name
 * @returns {{server: string, tool: string}|null}
 */
function parseMcp(name) {
  if (!name.startsWith(MCP_PREFIX)) return null;
  const rest = name.slice(MCP_PREFIX.length);
  if (!rest) return null;                       // a bare `mcp__` names nothing
  const i = rest.indexOf('__');
  if (i < 0) return { server: rest, tool: '' };
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

/**
 * §5.4 step 4: `classifyTool() -> {intent, importance, contentType}`.
 *
 * `toolInput` is accepted, never required, and never trusted: the classification is a
 * function of the tool name and the outcome alone, so a hostile or enormous `tool_input`
 * cannot change the intent — or throw on the way through.
 *
 * @param {string|null|undefined} toolName
 * @param {any} [toolInput]  the hook payload's `tool_input`; unused, and deliberately so
 * @param {'ok'|'failure'|string} [outcome]
 * @returns {{intent: string, importance: string, contentType: string, metadata?: Record<string, string>}}
 */
export function classifyTool(toolName, toolInput, outcome = 'ok') {
  const name = typeof toolName === 'string' ? toolName.trim() : '';
  const failed = isFailure(outcome);

  const mcp = name ? parseMcp(name) : null;
  const row = mcp ? MCP : (TOOL_TABLE[name] ?? FALLBACK);
  const [intent, importance] = failed ? FAILURE : row;

  /** @type {{intent: string, importance: string, contentType: string, metadata?: Record<string, string>}} */
  const out = { intent, importance, contentType: CONTENT_TYPE };

  // §4.5: keep the server/tool split for an MCP call even when it failed — "which server"
  // is most of the signal in `mcp__github__create_issue` blowing up.
  if (mcp) out.metadata = { mcp_server: mcp.server, mcp_tool: mcp.tool, tool: name };

  return out;
}

/**
 * §4.5, the turn-level rows:
 *
 *   | Stop Q&A pair | `task_result` | `medium` | staged prompt + final message |
 *   | SubagentStop  | `task_result` | `medium` | attributed to the subagent `agent_id` |
 *   | PreCompact    | `checkpoint`  | —        | goes via `/v2/control/checkpoint` |
 *
 * `PreCompact`'s importance is "—" in the table because the item never reaches ingest: it
 * goes to `POST /v2/control/checkpoint` (§5.6), which has no importance field. A valid
 * value is still emitted so a caller that spreads this into an item cannot produce an
 * invalid one.
 *
 * `agentId` is the payload's raw `agent_id`; turning it into the wire-level
 * `claude-code-<sessionShort>-sub-<agentShort>` is `deriveAgentId`'s job in §4.3. A
 * subagent must own its own result — attributing it to the parent session is how a
 * six-subagent fan-out collapses into one indistinguishable blob at recall time.
 *
 * @param {string|null|undefined} [prompt]
 * @param {string|null|undefined} [lastAssistantMessage]
 * @param {{event?: string, agent_id?: string, agentId?: string, agent_type?: string, trigger?: string}} [opts]
 * @returns {{intent: string, importance: string, contentType: string, agentId: string, agentType: string}}
 */
export function classifyTurn(prompt, lastAssistantMessage, opts = {}) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const event = typeof o.event === 'string' ? o.event : '';

  const isSubagent = event === 'SubagentStop';
  const [intent, importance] = event === 'PreCompact'
    ? ['checkpoint', 'medium']
    : ['task_result', 'medium'];

  const rawAgentId = o.agent_id ?? o.agentId;
  return {
    intent,
    importance,
    contentType: CONTENT_TYPE,
    agentId: isSubagent && typeof rawAgentId === 'string' ? rawAgentId : '',
    agentType: isSubagent && typeof o.agent_type === 'string' ? o.agent_type : '',
  };
}
