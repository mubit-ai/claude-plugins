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
 * Zero dependencies, Node >= 20 built-ins only, synchronous, and nothing here throws —
 * except `applyLessonTemplate` on an unknown template name, which is a caller bug the user
 * needs to see (see its docblock).
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

// ---------------------------------------------------------------------------
// Lesson templates
// ---------------------------------------------------------------------------

/**
 * The 8 coding-agent lesson templates, as the MCP package defines them.
 *
 * ## Why this is a copy and not an import
 *
 * The rule is to **import** the MCP module "rather than copying the constants,
 * so the two surfaces cannot drift". That is the right instinct and the wrong mechanism
 * here, for two reasons that are both hard blockers:
 *
 *   1. The MCP package's table is TypeScript. Every `lib/` module is loaded as source by
 *      plain `node` — the test harness imports `lib/classify.mjs` directly, and the hooks
 *      run as `node <path>` with no loader (§11.4). Node cannot import a `.ts` file.
 *   2. The shipped plugin is this directory alone. The MCP package's sources are not inside
 *      it, so on a user's machine that import path does not exist at all — it would resolve
 *      during development and `ERR_MODULE_NOT_FOUND` in the field, which is the worst
 *      possible place to discover it.
 *
 * Drift is therefore prevented by a test rather than by the module system:
 * `test/classify.test.mjs` writes the same 8 triples out independently and compares every
 * value against this object. **That test is the enforcement mechanism — if you change one of
 * these triples, change it there too, or CI fails.** Do not "fix" this into an import.
 *
 * `lesson_scope` is never `org`: `org` is promotion-only and must never be client-written
 * (§1.6).
 *
 * @type {Readonly<Record<string, {intent: string, lesson_type: string, lesson_scope: string}>>}
 */
export const LESSON_TEMPLATES = Object.freeze({
  /** Coding standards, linting rules, naming conventions. Applies across all sessions. */
  CODING_RULE: Object.freeze({ intent: 'lesson', lesson_type: 'rule', lesson_scope: 'global' }),

  /** Successful debugging patterns, working solutions. */
  DEBUG_SUCCESS: Object.freeze({ intent: 'lesson', lesson_type: 'success', lesson_scope: 'session' }),

  /** Failed approaches, anti-patterns discovered — prevent repeating them. */
  DEBUG_FAILURE: Object.freeze({ intent: 'lesson', lesson_type: 'failure', lesson_scope: 'session' }),

  /** User/project preferences (style, tooling, workflow). Always applicable. */
  PREFERENCE: Object.freeze({ intent: 'lesson', lesson_type: 'preference', lesson_scope: 'global' }),

  /** Architecture insights, dependency behaviours, system quirks. Reusable knowledge. */
  ARCHITECTURE_INSIGHT: Object.freeze({ intent: 'lesson', lesson_type: 'observation', lesson_scope: 'global' }),

  /** Build/deploy configuration that works. */
  BUILD_CONFIG: Object.freeze({ intent: 'lesson', lesson_type: 'rule', lesson_scope: 'global' }),

  /** API usage patterns, SDK quirks, integration notes — may evolve with API versions. */
  API_PATTERN: Object.freeze({ intent: 'lesson', lesson_type: 'observation', lesson_scope: 'session' }),

  /** Test strategies that proved effective. */
  TEST_STRATEGY: Object.freeze({ intent: 'lesson', lesson_type: 'success', lesson_scope: 'global' }),
});

/**
 * Expand a template name onto an item: `{intent: "lesson", lesson_type, lesson_scope}`.
 * This is where those 8 templates finally get a consumer — the `remember` skill passes a
 * name, and this turns it into a typed lesson.
 *
 * **Throws on an unknown name.** It is the one deliberate throw in this file. Silently
 * passing the item through would store a `remember` call as an untyped item: the user
 * asked for a lesson and got a log line, with nothing anywhere to tell them so. The names
 * are the SCREAMING_SNAKE keys of `LESSON_TEMPLATES` — the lookup is exact, so
 * `'coding_rule'` is an error rather than a lenient match, because a template name that
 * silently normalises is a template name nobody ever gets right.
 *
 * @param {Record<string, any>} item  a wire-shaped ingest item
 * @param {string} templateName  one of the `LESSON_TEMPLATES` keys
 * @returns {Record<string, any>} the item with the template's three fields applied
 * @throws {Error} when `templateName` is not exactly one of the 8 keys
 */
export function applyLessonTemplate(item, templateName) {
  const known = Object.prototype.hasOwnProperty.call(LESSON_TEMPLATES, String(templateName));
  const tpl = (typeof templateName === 'string' && templateName && known)
    ? LESSON_TEMPLATES[templateName]
    : null;

  if (!tpl) {
    throw new Error(
      `unknown lesson template: ${JSON.stringify(templateName ?? null)}. `
      + `Expected one of: ${Object.keys(LESSON_TEMPLATES).join(', ')}`);
  }

  // Everything else on the item survives — §1.3 makes `item_id` and `content_type`
  // required, and dropping `text` would store an empty lesson.
  const base = (item && typeof item === 'object') ? item : {};
  return {
    ...base,
    intent: tpl.intent,
    lesson_type: tpl.lesson_type,
    lesson_scope: tpl.lesson_scope,
  };
}
