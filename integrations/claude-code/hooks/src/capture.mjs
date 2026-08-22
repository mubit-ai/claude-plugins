#!/usr/bin/env node
// @ts-check
/**
 * `hooks/src/capture.mjs` — PostToolUse / PostToolUseFailure / PermissionRequest / Stop /
 * StopFailure / SubagentStop (§5.4).
 *
 * One script, six modes by argv: none, `--failure`, `--permission`, `--stop`,
 * `--stop-failure`, `--subagent`.
 *
 * `--permission` is Codex-only, because `PermissionRequest` is an event Claude Code does not
 * have. See `buildPermissionItem` for why it earns a mode of its own rather than riding on
 * the ordinary tool path.
 *
 * ---------------------------------------------------------------------------
 * The two properties that dominate this file
 * ---------------------------------------------------------------------------
 * 1. **Zero network, ever.** Capture runs on every single tool call. Its only outbound work
 *    is `spawnDetached('drain')`, and only when a trigger fires. That is what makes
 *    "detached" cheap: re-spawning yourself detached on every `PostToolUse` pays node's
 *    startup twice per tool call, so instead capture is pure local I/O — one file write,
 *    well under the §5.4 budget of 40 ms wall.
 *
 * 2. **Every item carries an `intent`.** The server classifies cheaply when an item
 *    arrives with an intent set, and otherwise falls back to an LLM round trip *per item*.
 *    An item without an
 *    intent is not a cosmetic problem, it is a bill — at tool-call frequency it is the
 *    difference between a plugin you leave on and one you uninstall.
 *
 * §5.4's pipeline, and every step of it individually try/caught so that a redaction crash
 * drops the item rather than spooling it unredacted:
 *
 *   config -> self-reference -> denied path -> classify -> build text -> redact
 *          -> appendItem -> maybe spawn drain -> emit {"suppressOutput": true}
 */

import { join } from 'node:path';

import { envTags, host } from '../../lib/config.mjs';
import { firstUserText, toolCallRecord } from '../../lib/codex-rollout.mjs';
import { runHook, spawnDetached, stashPayload } from '../../lib/hook.mjs';
import { classifyTool, classifyTurn } from '../../lib/classify.mjs';
import { isDeniedPath, isSelfReference, redactParams, redactText } from '../../lib/redact.mjs';
import { deriveAgentId, deriveRunId, resolveProjectDir, turnKey, turnNumber } from '../../lib/runid.mjs';
import { appendItem, spoolStats } from '../../lib/spool.mjs';
import { readJson, resolveDataDir, safeSegment, writeJsonAtomic } from '../../lib/state.mjs';

/**
 * Nothing here is allowed to be slow, so the budget exists only to bound a pathological
 * `redactText` over a multi-megabyte `tool_input` — not as a working deadline.
 */
const BUDGET_MS = 1500;

/** `tool_input` keys that name a file on disk, for the §4.4 stage-2 denylist check. */
const PATH_KEYS = [
  'file_path', 'filePath', 'path', 'notebook_path', 'notebookPath', 'target_file',
];

/**
 * The tools worth no memory. §3.2's matcher used to be an allowlist of eleven built-in tool
 * names, which is a rule this plugin cannot keep correct: the host owns that set and renames
 * it under us (`Task` -> `Agent`, `KillShell` -> `TaskStop`, `BashOutput` -> `TaskOutput`).
 * What kept the allowlist working at all was the host's own legacy-alias table — it tests a
 * matcher against a tool's current name AND its former ones, so `Task` went on quietly
 * matching `Agent` long after the rename. That is a compatibility shim the plugin does not
 * control, cannot see, and is one host release away from losing. Everything the allowlist
 * had never heard of was dropped in the manifest, silently, with nothing to report the loss.
 *
 * So `hooks.json` now matches every tool and the decision lives here, where a test can reach
 * it — and it is a *deny* list, so a tool that does not exist yet is captured by default.
 * Each row, and why it is not an episode:
 *
 *   TodoWrite        the model rewriting its own checklist. The plan that matters is in the
 *                    turn itself, which `Stop` already stores.
 *   EnterPlanMode    a mode transition, and so is its twin below. The plan they bracket was
 *   ExitPlanMode     written by the turn; the transition itself carries none of it.
 *   ToolSearch       loading a tool's schema. It says what was looked up, never what was done.
 *   ListAgents       who happens to be running right now; stale the moment it is stored.
 *   TaskList         likewise an enumeration of current state, not a change to it.
 *   CronList         likewise.
 *   Monitor          a poll. One wait becomes fifty identical items at recall time.
 *   ScheduleWakeup   a timer being set. Whatever it wakes up to is the episode, not this.
 *   StructuredOutput the plumbing by which a subagent hands its result back. The result is
 *                    already captured — at that subagent's `SubagentStop` — so storing this
 *                    too buys a duplicate of the most-duplicated content there is.
 *
 * **Kept on purpose**, because each records a decision or a result rather than bookkeeping:
 * `AskUserQuestion` (see below), `ReportFindings` (the findings ARE the content),
 * `CronCreate`/`CronDelete` (durable config mutated — the same shape of act as `Write`),
 * `EnterWorktree`/`ExitWorktree` (they decide where every later `Edit` lands, so an episode
 * that omits them misreads), `LSP` (code intelligence — read-shaped, exactly like `Grep`),
 * and `Workflow`. Absence from this list is the default; a name earns a row here only with a
 * reason written next to it.
 *
 * `AskUserQuestion` is the one that looks like bookkeeping and is not, so it gets its own
 * paragraph: its `tool_response` carries **what the human chose, and the options they turned
 * down**. §4.5 already grades it `feedback` — "the one entry type that records what the
 * human, not the model, decided" — and that is precisely the class of fact a model cannot
 * re-derive by reading the codebase, which is the whole reason a memory layer exists. It was
 * on this list in an early draft only because, before the `tool_response` fix, the payload
 * looked empty. Do not tidy it back on.
 *
 * Applied to SUCCESSFUL calls only, for the same reason self-reference suppression is
 * (step 2 below): a failure is the highest-value thing a coding agent can remember (§4.5),
 * and "the todo write blew up" is a diagnostic nobody else is keeping.
 */
const SKIP_TOOLS = new Set([
  'TodoWrite', 'EnterPlanMode', 'ExitPlanMode', 'ToolSearch',
  'ListAgents', 'TaskList', 'CronList', 'Monitor', 'ScheduleWakeup',
  'StructuredOutput',
]);

/**
 * How far into a nested `tool_input` the human-readable render descends before collapsing
 * to `{…}`. Deliberately shallower than `redactParams`' own depth-12 walk: everything this
 * renders has therefore already been through stage 1, which is what stops an 800-deep
 * hostile object from smuggling a credential past the scrub on the way into `text`.
 */
const MAX_RENDER_DEPTH = 4;
const MAX_RENDER_ITEMS = 24;

/** A single param value never earns more of the line than this, whatever the caps allow. */
const MAX_VALUE_CHARS = 4096;

/** `item_id` is a wire value and a dedup key; keep it boring. */
const MAX_ID_CHARS = 160;

/**
 * The used-signal's name, written onto every record it produces.
 *
 * A bare `0.4` on a turn file is unreadable a version later — nobody can tell whether it was
 * a probability, a ratio, or a threshold somebody tuned. The version suffix is load-bearing
 * too: when the method changes, old records stay interpretable instead of being silently
 * pooled with new ones that were measured differently.
 */
const USED_SIGNAL_METHOD = 'memory-term-echo/v1';

/** How many matched terms are kept as evidence. Enough to read; not a copy of the block. */
const MAX_EVIDENCE_TERMS = 12;

/** The reply is scanned, never stored. This bounds the scan on a pathological message. */
const MAX_ANSWER_SCAN = 64 * 1024;

/** Sanity bounds on terms read back from a turn file, which is editable local state. */
const MAX_TERMS_READ = 64;
const TERM_MIN_CHARS = 4;
const TERM_MAX_CHARS = 24;

/**
 * The mark `--stop-failure` writes on the turn file, and the whole reason that mode exists.
 *
 * `lib/outcome.mjs` reads this key and posts nothing for the turn. It is deliberately NOT
 * `outcome: "failure"`, which build-guide §5.5 originally called for ("On a StopFailure turn:
 * outcome 'failure', signal -0.3"): -0.3 against the turn's recalled ids is a claim that the
 * *memory* was wrong, and a rate limit is not evidence about memory. See the fifth row of
 * `decideOutcome`'s table.
 */
const API_ERROR_KEY = 'api_error';

/**
 * The taxonomy value is a closed vocabulary of short identifiers; this only bounds a host
 * that sends something else. The free-text `error_details` beside it is deliberately not
 * stored: the decision keys on the taxonomy value alone, and an unbounded API message is a
 * §4.4 question with nothing on the other side of it.
 */
const MAX_API_ERROR_CHARS = 64;

/**
 * What the host itself substitutes for a missing `error` on the way to the matcher
 * (`matchQuery: e.error ?? "unknown"`), and the taxonomy's own catch-all. An empty mark would
 * read as "no API error at all" and put the turn straight back into the outcome path, so
 * there is no path out of `--stop-failure` with a blank one.
 */
const API_ERROR_UNKNOWN = 'unknown';

// ---------------------------------------------------------------------------

/** @typedef {'tool'|'failure'|'permission'|'stop'|'stop-failure'|'subagent'} Mode */

const MODE = pickMode(process.argv.slice(2));

await runHook('capture', {
  budgetMs: BUDGET_MS,
  body: (payload, cfg) => {
    capture(payload, cfg, MODE);
    // §5.4: `{"suppressOutput": true}` in every mode, including every mode that dropped
    // the item. What capture decided is never the user's business mid-turn.
    return { suppressOutput: true };
  },
});

/**
 * `Array.includes` is exact equality, not a prefix test, so `--stop-failure` and `--stop`
 * cannot be confused for one another however these rows are ordered. The specific flag is
 * checked first anyway, because the next person to read this will wonder.
 *
 * @param {string[]} argv
 * @returns {Mode}
 */
function pickMode(argv) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes('--failure')) return 'failure';
  if (args.includes('--permission')) return 'permission';
  if (args.includes('--stop-failure')) return 'stop-failure';
  if (args.includes('--stop')) return 'stop';
  if (args.includes('--subagent')) return 'subagent';
  return 'tool';
}

/**
 * The §5.4 pipeline. Returns nothing: every outcome — spooled, dropped, or failed — is the
 * same `{"suppressOutput": true}` to the host.
 *
 * @param {Record<string, any>} rawPayload
 * @param {Record<string, any>} cfg
 * @param {Mode} mode
 */
function capture(rawPayload, cfg, mode) {
  const payload = isObject(rawPayload) ? rawPayload : {};

  // 1. capture disabled -> nothing to do.
  if (cfg && cfg.capture === false) return;

  // 2a. §3.2: the matcher lets every tool through, so the bookkeeping tools are dropped
  //     here. See `SKIP_TOOLS` for why an allowlist in the manifest could not do this job.
  //
  //     `--permission` is dropped by the same list: a permission request for `TodoWrite` is
  //     as much bookkeeping as the write would have been.
  if ((mode === 'tool' || mode === 'permission')
      && SKIP_TOOLS.has(str(payload.tool_name).trim())) return;

  // 2. §4.4 self-reference suppression. Without it the plugin records its own traffic,
  //    recalls it, then records the recall.
  //
  //    Applied to a *successful* tool call only. The loop this defends against is one the
  //    plugin's own successful output feeds; a tool that FAILED produced no memory content
  //    to recycle, and "the memory layer's own call blew up" is exactly the diagnostic the
  //    doctor skill exists to surface. Suppressing it would also swallow every failure in
  //    any repo whose crate names happen to contain `mubit` — the fixture
  //    `cargo check -p my-crate` is precisely that case.
  //    `--permission` is suppressed too, and here the reason is sharper than the loop: under
  //    Codex the plugin's own MCP tools are the ones most likely to be gated, so without this
  //    every `mubit_recall` approval would be recorded as an episode by the thing being
  //    approved.
  if (mode === 'tool' || mode === 'permission') {
    if (attempt(() => isSelfReference(payload.tool_name, payload.tool_input, cfg), false)) return;
  }

  // 3. §4.4 stage 2: a denylisted subject is DROPPED, never scrubbed. A scrubbed `.env` is
  //    still a map of which secrets the project holds.
  if (mode === 'tool' || mode === 'failure' || mode === 'permission') {
    if (attempt(() => hasDeniedSubject(payload, cfg), false)) return;
  }

  const runId = attempt(() => deriveRunId(cfg, payload), '');
  if (!runId) return;

  // 4-6. classify, build the text, redact.
  //
  // `--stop-failure` builds nothing. The turn produced no episode: its answer is whatever
  // fragment the API managed before it fell over, and `Q: <prompt>\n\nA: <half a sentence>`
  // is the half-a-conversation this file already refuses to store — except this time it would
  // also be recalled later as though it were what the assistant had to say on the subject.
  const item = attempt(
    () => {
      if (mode === 'stop-failure') return null;
      if (mode === 'permission') return buildPermissionItem(payload, cfg);
      return mode === 'stop' || mode === 'subagent'
        ? buildTurnItem(payload, cfg, runId, mode)
        : buildToolItem(payload, cfg, mode);
    },
    null,
  );

  // 7. One file, one item, no network.
  if (item) attempt(() => appendItem(cfg, runId, item));

  // 8. `--stop` closes the turn out and ALWAYS drains: the turn is over, so this is the
  //    moment its attribution can be recorded. Every other mode drains only on a trigger,
  //    because one detached node process per tool call is the cost this design avoids.
  if (mode === 'stop') {
    attempt(() => closeTurn(cfg, runId, payload));
    attempt(() => fireDrain(cfg, runId, payload, outcomeArgs(payload)));
    return;
  }

  // 8b. `--stop-failure` closes the turn too — and it is the ONLY thing that ever will.
  //
  //     The host fires `StopFailure` **instead of** `Stop` (its own registry: "Fires instead
  //     of Stop when an API error (rate limit, auth failure, etc.) ended the turn"), so on a
  //     rate-limited turn `--stop` never runs. Before this mode existed the turn file was
  //     simply abandoned mid-write: `prompt` and `recalled` staged, no `ended_at`, nothing
  //     anywhere recording that the turn had died or why.
  //
  //     It closes the turn `outcome_pending` exactly like `--stop` does, on purpose. Leaving
  //     the flag off would also stop `session-end`'s flush from posting — but by hiding the
  //     turn from the sweep rather than by deciding about it, which puts the rule in the
  //     shape of an omission that the next person to touch that filter deletes by accident.
  //     One rule, in `lib/outcome.mjs`, read by both hooks (see its header).
  //
  //     And it does NOT force a drain. The only reason `--stop` always does is to carry
  //     `--with-outcome`; there is no outcome to carry here, so this falls through to the
  //     ordinary batch trigger below — the turn's captured tool calls were real work, and
  //     the model's API falling over says nothing about Mubit's.
  if (mode === 'stop-failure') {
    attempt(() => closeTurn(cfg, runId, payload, apiErrorOf(payload)));
  }

  if (attempt(() => drainTriggerFired(cfg, runId), false)) {
    attempt(() => fireDrain(cfg, runId, payload, []));
  }
}

/**
 * The `StopFailure` payload's error kind, as the host spells it.
 *
 * The field is **`error`** — read out of Claude Code 2.1.235's own Zod schema
 * (`hook_event_name: wt("StopFailure"), error: …, error_details: …optional(),
 * last_assistant_message: …optional()`), not from the published hook reference, which calls
 * it `error_type` in one place and `reason` in another. Reading the wrong name here would
 * stamp every API-failed turn `unknown` while every test agreed with it.
 *
 * @param {Record<string, any>} payload
 * @returns {string} never empty
 */
function apiErrorOf(payload) {
  const raw = str(payload.error).trim();
  return raw ? clamp(raw, MAX_API_ERROR_CHARS) : API_ERROR_UNKNOWN;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * PostToolUse:        `"<tool>(<params>) -> <capped output>"`
 * PostToolUseFailure: `"<tool>(<params>) FAILED: <capped error>"`
 *
 * @param {Record<string, any>} payload
 * @param {Record<string, any>} cfg
 * @param {'tool'|'failure'} mode
 * @returns {Record<string, any>|null}
 */
function buildToolItem(payload, cfg, mode) {
  // Codex has no `PostToolUseFailure`, so `mode` is `'tool'` for every call this host ever
  // makes and `failed` would be permanently false — every failed command stored as a success,
  // which empties the half of memory `mubit_diagnose` matches against.
  //
  // The host records the real outcome in the rollout transcript, under this call's own
  // `tool_use_id`; `lib/codex-rollout.mjs` explains why that is the only place it exists.
  // Consulted only when no failure event fired, and only when it answers: a miss leaves the
  // item exactly as it would have been, because the fix for "the host said failed and we wrote
  // ok" must not become "we guessed".
  const recorded = mode === 'tool' && host() === 'codex'
    ? attempt(() => toolCallRecord(payload.transcript_path, payload.tool_use_id), null)
    : null;
  const failed = mode === 'failure' || !!recorded?.failed;
  const toolName = clamp(str(payload.tool_name) || 'Tool', 128);

  // 4. §4.5. `classifyTool` is a function of the tool name and the outcome alone, so a
  //    hostile `tool_input` cannot change the intent — or throw on the way through.
  const cls = attempt(
    () => classifyTool(payload.tool_name, payload.tool_input, failed ? 'failure' : 'ok'),
    { intent: 'tool_output', importance: 'low', contentType: 'text' },
  );

  // 6. Redact BEFORE assembling, and per value rather than across the joined line: a scrub
  //    that runs over `key=value, key=value` can fuse a key onto a path and hand the entropy
  //    rule a 32-character run that neither half would have produced on its own.
  const scrubbed = attempt(() => redactParams(payload.tool_input, cfg), { params: null, redactions: 0 });
  const params = attempt(
    () => redactText(renderParams(scrubbed.params), cfg, 'param'),
    { text: '', redactions: 0, truncated: false },
  );

  // The host sends the result as **`tool_response`**. `tool_output` is the older name and
  // is kept only as a fallback — reading it alone is what made every memory this plugin ever
  // shipped read `Read(file_path=X) -> ` with nothing after the arrow: the plugin recorded
  // that a file had been read and never what was in it.
  const rawTail = failed ? errorText(payload) : outputText(payload.tool_response ?? payload.tool_output);
  const tail = attempt(
    () => redactText(rawTail, cfg, 'output'),
    { text: '', redactions: 0, truncated: false },
  );

  const text = failed
    ? `${toolName}(${params.text}) FAILED: ${tail.text}`
    : `${toolName}(${params.text}) -> ${tail.text}`;

  // Both halves empty means the item is a tool name and two brackets — `Tool() -> `, which
  // is not a memory. An empty TAIL alone is kept on purpose: `Bash(command=rm x) -> ` and
  // `Write(file_path=…) -> ` are real episodes whose content is entirely in the params, and
  // plenty of tools legitimately answer with nothing. Note the old test here was
  // `!text.trim()`, which could never fire — `toolName` falls back to `'Tool'`, so the
  // string always had characters in it.
  if (!params.text.trim() && !tail.text.trim()) return null;

  return item({
    cfg,
    payload,
    // §5.4: "item_id is stable per tool call so a retried drain deduplicates." Derived from
    // `tool_use_id` and nothing else — a timestamp in here would make every retry a new
    // entry, which is the exact failure the dedup exists to prevent.
    id: `cc-${idPart(payload.tool_use_id) || fallbackId(payload, text)}`,
    text,
    intent: cls.intent,
    importance: cls.importance,
    metadata: {
      tool: toolName,
      tool_use_id: str(payload.tool_use_id),
      hook_event: str(payload.hook_event_name) || (failed ? 'PostToolUseFailure' : 'PostToolUse'),
      session_id: str(payload.session_id),
      prompt_id: turnKey(payload),
      // The host names it `duration_ms`; `execution_time_ms` is the older payload name and
      // stays as a fallback. The metadata key keeps the old spelling because it is already
      // on the wire in every stored item.
      //
      // Codex sends neither: `duration_ms` is in none of its eleven input schemas, so every
      // item stored on that host read 0 and "which calls are slow" had no answer. The rollout
      // record carries the duration the host itself measured, and it is the last rung here
      // rather than the first so no Claude Code item changes shape.
      execution_time_ms: finiteOr(
        payload.duration_ms ?? payload.execution_time_ms ?? recorded?.durationMs, 0),
      // Present only when the host recorded one, which is the one thing distinguishing this
      // failure from every other.
      ...(typeof recorded?.exitCode === 'number' ? { exit_code: recorded.exitCode } : {}),
      outcome: failed ? 'failure' : 'ok',
      truncated: !!(params.truncated || tail.truncated),
      redactions: num(scrubbed.redactions) + num(params.redactions) + num(tail.redactions),
      ...(isObject(cls.metadata) ? cls.metadata : {}),
    },
  });
}

/**
 * PermissionRequest (Codex only): `"<tool>(<params>) NEEDS APPROVAL"`.
 *
 * ---------------------------------------------------------------------------
 * Why this is an item at all
 * ---------------------------------------------------------------------------
 * A permission request looks like half a fact — it says a gated call was *attempted* and
 * never says what the human answered. That reads like a reason to drop it, and it is
 * exactly backwards.
 *
 * When the user **allows** the call, `PostToolUse` fires and records the whole episode, so
 * this item is redundant and cheap. When the user **denies** it, no `PostToolUse` ever
 * fires — observed live, `docs/harness-probe.md` §5 — and this is the only trace anywhere
 * that the attempt happened. "We tried this and were not allowed to" is precisely the class
 * of fact a model cannot re-derive by reading the codebase, and without this mode a coding
 * agent rediscovers the same forbidden operation once a session, forever.
 *
 * ---------------------------------------------------------------------------
 * Why a mode of its own rather than the ordinary tool path
 * ---------------------------------------------------------------------------
 * Three things differ, and each would be wrong on the tool path:
 *
 *   1. **There is no `tool_response`.** `buildToolItem` would render `Tool(params) -> ` with
 *      nothing after the arrow, which is the exact string that made every early memory this
 *      plugin shipped useless.
 *   2. **The intent is `feedback`, not `tool_output`.** §4.5 grades `feedback` as "the one
 *      entry type that records what the human, not the model, decided", and a request for
 *      approval is a question put to a human. Grading it as tool output files it with the
 *      file reads.
 *   3. **There is no `tool_use_id`.** Codex's `permission-request.command.input` has no such
 *      field, so the stable id has to come from the fallback hash. Two identical requests in
 *      one turn therefore dedupe to one item, which is the right answer: they are the same
 *      question asked twice.
 *
 * `medium`, not `high`: a gated call is a routine event under `dontAsk`, and grading every
 * one of them `high` would outrank the failures that §4.5 reserves `high` for.
 *
 * @param {Record<string, any>} payload
 * @param {Record<string, any>} cfg
 * @returns {Record<string, any>|null}
 */
function buildPermissionItem(payload, cfg) {
  const toolName = clamp(str(payload.tool_name) || 'Tool', 128);

  const scrubbed = attempt(() => redactParams(payload.tool_input, cfg), { params: null, redactions: 0 });
  const params = attempt(
    () => redactText(renderParams(scrubbed.params), cfg, 'param'),
    { text: '', redactions: 0, truncated: false },
  );

  // Unlike `buildToolItem`, an empty render is fatal here rather than merely thin: with no
  // output half either, `Tool() NEEDS APPROVAL` names no operation at all.
  if (!params.text.trim()) return null;

  return item({
    cfg,
    payload,
    id: `cc-perm-${fallbackId(payload, `${toolName}|${params.text}`)}`,
    text: `${toolName}(${params.text}) NEEDS APPROVAL`,
    intent: 'feedback',
    importance: 'medium',
    metadata: {
      tool: toolName,
      hook_event: str(payload.hook_event_name) || 'PermissionRequest',
      session_id: str(payload.session_id),
      prompt_id: turnKey(payload),
      permission_requested: true,
      // Deliberately not an `outcome`: this event fires *before* the human answers, and the
      // plugin never learns what they said. Stamping `ok` here would be a claim about a
      // decision nobody recorded.
      truncated: !!params.truncated,
      redactions: num(scrubbed.redactions) + num(params.redactions),
    },
  });
}

/**
 * Stop / SubagentStop: `"Q: <staged prompt>\n\nA: <capped assistant message>"`.
 *
 * `Stop` carries `last_assistant_message` but NOT the prompt, so the other half of the
 * conversation comes from the turn file `stage-prompt.mjs` wrote (§5.3).
 *
 * @param {Record<string, any>} payload
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {'stop'|'subagent'} mode
 * @returns {Record<string, any>|null}
 */
function buildTurnItem(payload, cfg, runId, mode) {
  const event = mode === 'subagent' ? 'SubagentStop' : 'Stop';
  const cls = attempt(
    () => classifyTurn('', '', {
      event,
      agent_id: str(payload.agent_id),
      agent_type: str(payload.agent_type),
    }),
    { intent: 'task_result', importance: 'medium', contentType: 'text', agentId: '', agentType: '' },
  );

  const turn = attempt(() => readTurn(cfg, runId, turnKey(payload)), null);

  // A subagent's question is its OWN, and the turn file above belongs to its parent — shared
  // with every sibling in the fan-out, so six subagents in one turn would all be stored as
  // answers to one identical question. `agent_transcript_path` arrives on SubagentStop and is
  // the only coordinate that differs between siblings; its opening user message is the task
  // this one was actually given. Falls back to the parent's staged prompt, which is what was
  // stored before any of this, whenever the transcript does not answer.
  const own = mode === 'subagent'
    ? attempt(() => firstUserText(payload.agent_transcript_path), '')
    : '';
  const staged = own || str(turn?.prompt) || str(payload.prompt);
  const answer = str(payload.last_assistant_message) || str(payload.message);
  if (!staged && !answer) return null;

  const q = attempt(() => redactText(staged, cfg, 'output'), { text: '', redactions: 0, truncated: false });
  const a = attempt(() => redactText(answer, cfg, 'output'), { text: '', redactions: 0, truncated: false });
  const text = `Q: ${q.text}\n\nA: ${a.text}`;

  // §4.5: a SubagentStop is attributed to the subagent's own `agent_id`, not the parent's.
  // ingest item (control.proto) has no agent field and the batch-level one belongs
  // to the session, so the attribution rides in `metadata_json` — otherwise a six-subagent
  // fan-out collapses into one indistinguishable blob at recall time.
  const subAgent = str(cls.agentId);

  return item({
    cfg,
    payload,
    id: mode === 'subagent'
      ? `cc-sub-${idPart(payload.agent_id) || 'anon'}-${idPart(turnKey(payload)) || idPart(payload.session_id) || 'turn'}`
      : `cc-stop-${idPart(turnKey(payload)) || idPart(payload.session_id) || 'turn'}`,
    text,
    intent: cls.intent,
    importance: cls.importance,
    metadata: {
      hook_event: str(payload.hook_event_name) || event,
      session_id: str(payload.session_id),
      prompt_id: turnKey(payload),
      // Payload first, then the ordinal `stage-prompt` staged — Codex sends no `turn_number`
      // on any event, so without the second source every item here recorded 0.
      turn_number: attempt(() => turnNumber(cfg, runId, payload), 0),
      ...(subAgent ? { agent_id: subAgent, agent_type: str(cls.agentType) } : {}),
      ...(subAgent ? { mubit_agent_id: attempt(() => deriveAgentId(payload), '') } : {}),
      // The path itself, so a later reader can rejoin this subagent to its own rollout —
      // which is what `persistSubRun` names as the next step on real per-subagent isolation.
      ...(str(payload.agent_transcript_path)
        ? { agent_transcript_path: str(payload.agent_transcript_path) } : {}),
      truncated: !!(q.truncated || a.truncated),
      redactions: num(q.redactions) + num(a.redactions),
    },
  });
}

/**
 * The §5.4 wire shape. `item_id` and `content_type` are REQUIRED (§1.3) — a missing one is a
 * 422 for the whole batch, not just this item — and `intent` is always set (§1.5).
 *
 * @param {{cfg: Record<string, any>, payload: Record<string, any>, id: string, text: string,
 *          intent: any, importance: any, metadata: Record<string, any>}} o
 * @returns {Record<string, any>}
 */
function item(o) {
  const cfg = o.cfg ?? {};
  /** @type {Record<string, any>} */
  const out = {
    item_id: clamp(o.id || `cc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, MAX_ID_CHARS),
    content_type: 'text',
    text: o.text,
    intent: intentOr(o.intent),
    importance: importanceOr(o.importance),
    source: 'agent',
    // Unix SECONDS, as in the §5.4 example — `occurrence_time` is an int64 of seconds
    // (control.proto) and handing it milliseconds dates every memory to the year 57000.
    occurrence_time: Math.floor(Date.now() / 1000),
    // The tags are derived from a directory too, and they ride on every ingested item. A
    // run id that follows a mid-session `cd` while `repo:`/`branch:` stay on the launch repo
    // would be half a fix: the memory would land in the right run wearing the wrong labels.
    env_tags: attempt(
      () => envTags(cfg, resolveProjectDir(cfg, o.payload)), ['tool:claude-code']),
    // `model` rides on the payload of ten of Codex's eleven events and was recorded nowhere,
    // so memory could not say which model produced a lesson — or notice that two of them
    // disagreed about the same thing. Added here rather than in each builder so every item
    // type gets it at once, and omitted when absent: Claude Code sends it on SessionStart
    // only, and an empty string would read as "the host said the model is blank".
    metadata_json: safeJson(withModel(o.metadata, o.payload)),
  };
  const userId = str(cfg.userId);
  if (userId) out.user_id = userId;
  return out;
}

/**
 * `metadata` plus the model that produced it, when the payload names one.
 *
 * @param {Record<string, any>} metadata
 * @param {Record<string, any>} payload
 * @returns {Record<string, any>}
 */
function withModel(metadata, payload) {
  const base = isObject(metadata) ? metadata : {};
  if ('model' in base) return base;
  const model = clamp(str(payload?.model), 128);
  return model ? { ...base, model } : base;
}

// ---------------------------------------------------------------------------
// Rendering tool_input
// ---------------------------------------------------------------------------

/**
 * `key=value, key=value`, flat, human-readable, and bounded in every dimension.
 * @param {any} params  the output of `redactParams`
 * @returns {string}
 */
function renderParams(params) {
  if (params === null || params === undefined) return '';
  if (typeof params !== 'object') return renderValue(params, MAX_RENDER_DEPTH);
  if (Array.isArray(params)) return renderValue(params, 1);

  const parts = [];
  let n = 0;
  for (const [k, v] of Object.entries(params)) {
    if (n >= MAX_RENDER_ITEMS) { parts.push('…'); break; }
    n += 1;
    parts.push(`${clamp(String(k), 64)}=${clamp(renderValue(v, 1), MAX_VALUE_CHARS)}`);
  }
  return parts.join(', ');
}

/**
 * @param {any} v
 * @param {number} depth
 * @returns {string}
 */
function renderValue(v, depth) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const t = typeof v;
  if (t === 'string') return v;
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
  if (t === 'function' || t === 'symbol') return `[${t}]`;
  if (depth >= MAX_RENDER_DEPTH) return Array.isArray(v) ? '[…]' : '{…}';

  try {
    if (Array.isArray(v)) {
      const head = v.slice(0, MAX_RENDER_ITEMS).map((x) => renderValue(x, depth + 1));
      if (v.length > MAX_RENDER_ITEMS) head.push('…');
      return `[${head.join(', ')}]`;
    }
    const entries = Object.entries(v).slice(0, MAX_RENDER_ITEMS);
    const body = entries.map(([k, x]) => `${clamp(String(k), 64)}: ${renderValue(x, depth + 1)}`);
    if (Object.keys(v).length > MAX_RENDER_ITEMS) body.push('…');
    return `{${body.join(', ')}}`;
  } catch {
    return '[unrenderable]';
  }
}

/**
 * `tool_response` arrives in half a dozen shapes depending on the tool, and no two of them
 * agree: `Read` buries the payload under `file.content`, `Bash` splits it across
 * `stdout`/`stderr`, and most of the rest are flat result objects with no text field at all.
 * The `JSON.stringify` at the bottom is the deliberate floor — an unknown shape rendered as
 * JSON is still the tool's answer, and `redactText` caps it either way.
 *
 * @param {any} v
 * @param {number} [depth]
 * @returns {string}
 */
function outputText(v, depth = 0) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v !== 'object') return String(v);
  if (depth > 3) return '';

  try {
    if (Array.isArray(v)) {
      return v.map((x) => outputText(x, depth + 1)).filter(Boolean).join('\n');
    }
    if (typeof v.text === 'string') return v.text;
    // `Read` — `{type: "text", file: {filePath, content, numLines, …}}`. Without this row the
    // most-called tool in the session stores its JSON envelope instead of the file, and the
    // envelope's keys eat the output cap the excerpt was supposed to get.
    if (isObject(v.file) && typeof v.file.content === 'string') return v.file.content;
    if (typeof v.content === 'string') return v.content;
    if (Array.isArray(v.content)) return outputText(v.content, depth + 1);
    if (typeof v.output === 'string') return v.output;
    if (typeof v.stdout === 'string' || typeof v.stderr === 'string') {
      return [v.stdout, v.stderr].filter((s) => typeof s === 'string' && s).join('\n');
    }
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/** @param {Record<string, any>} payload @returns {string} */
function errorText(payload) {
  const direct = str(payload.error) || str(payload.tool_error) || str(payload.error_message);
  if (direct) return direct;
  // `PostToolUseFailure` carries `error`; the two result fields are the fallback, newest
  // name first, for a host that reported the failure inside the result instead.
  return outputText(payload.error ?? payload.tool_response ?? payload.tool_output);
}

// ---------------------------------------------------------------------------
// The turn file (§5.3 / §5.4 step 8)
// ---------------------------------------------------------------------------

/** @param {Record<string, any>} cfg @param {string} runId @param {any} promptId */
function turnPath(cfg, runId, promptId) {
  const id = idPart(promptId);
  if (!id) return '';
  return join(resolveDataDir(cfg), 'runs', idPart(runId), 'turns', `${id}.json`);
}

/** @param {Record<string, any>} cfg @param {string} runId @param {any} promptId */
function readTurn(cfg, runId, promptId) {
  const p = turnPath(cfg, runId, promptId);
  if (!p) return null;
  const v = readJson(p, null);
  return isObject(v) ? v : null;
}

/**
 * §5.4 step 8: add the end markers **in place**. `prompt` and `recalled` were staged by
 * `stage-prompt.mjs` and are what `drain --with-outcome` attributes against — writing a
 * fresh object here would silently delete the attribution the next step depends on.
 *
 * This is also where the used-signal lands (§5.5), for the same reason: everything it needs
 * — the staged terms and `last_assistant_message` — is in scope at one point in one function,
 * and the file is already being rewritten. One read, one write, no new lifecycle.
 *
 * `apiError` is `StopFailure`'s half. It is the only difference between the two closes, and
 * it turns the used-signal off — see below.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {Record<string, any>} payload
 * @param {string} [apiError]  the taxonomy value that ended the turn; '' on a normal Stop
 */
function closeTurn(cfg, runId, payload, apiError = '') {
  const p = turnPath(cfg, runId, turnKey(payload));
  if (!p) return;
  const prev = readJson(p, null);
  const base = isObject(prev) ? prev : {
    prompt_id: turnKey(payload),
    session_id: str(payload.session_id),
    started_at: Date.now(),
  };
  // The signal asks whether the reply carried the injected memory's vocabulary. A reply the
  // API cut off has no denominator for that question — `max_output_tokens` is literally "the
  // answer stopped early" — and the answer it would produce is `used: false`, which
  // `decideOutcome` reads as "the model ignored the memory". Unmeasurable is not unused, and
  // this is the one place that distinction can still be made honestly.
  const evidence = apiError ? null : attempt(() => usedEvidence(base, payload), null);
  writeJsonAtomic(p, {
    ...base,
    // Absent when nothing was staged to look for. An absent key means "unmeasured" and the
    // drain falls back to the old turn-completed reading; `used: false` means "measured, and
    // nothing was found". Collapsing the two would report every turn from before this
    // existed as an injection the model ignored.
    ...(evidence ? { used_evidence: evidence } : {}),
    ...(apiError ? { [API_ERROR_KEY]: apiError } : {}),
    ended_at: Date.now(),
    outcome_pending: true,
  });
}

/**
 * ---------------------------------------------------------------------------
 * The used-signal — what it can show, and what it cannot
 * ---------------------------------------------------------------------------
 * Recall injects on every prompt over 8 characters. The cost of that is measured; whether
 * any of it was *read* is not, and this hook cannot answer that question — the plugin sees
 * what the model said, never what it attended to. So this does not claim to measure use. It
 * measures one observable proxy and records the raw ingredients of it:
 *
 *   **did the reply carry vocabulary that came from the injected block and not from the
 *   prompt?**
 *
 * The prompt subtraction happens in `prompt-recall.mjs`, and it is the only reason the
 * number is worth anything: retrieval matched the prompt in the first place, so an overlap
 * with the prompt's own words is what you would see with the memory layer switched off.
 *
 * No score is emitted, deliberately. A ratio over a term list of arbitrary size has no
 * calibration behind it, and a `0.4` would be read as one. What is recorded is the matched
 * terms, the size of the set they were drawn from, and the method's name — the ingredients
 * any later calibration would need, and none of the confidence it has not earned.
 *
 * **Its weaknesses, in order of how often they will bite:**
 *
 *  1. *False negatives dominate.* A model that reads "never run the migration twice" and
 *     then simply does not run it twice has used the memory perfectly and echoed nothing.
 *     Rules and prohibitions are the entries most likely to be used silently, which is
 *     exactly the class this signal is worst at.
 *  2. *Only the final message is visible.* Memory used in intermediate reasoning or in a
 *     tool call it prompted is invisible here; `Stop` carries the last message and no more.
 *  3. *False positives from shared subject matter.* Memory and reply are both about this
 *     codebase, so a term can coincide without the memory having been read.
 *  4. *Paraphrase defeats it entirely.* The match is lexical, with a left word boundary
 *     only — `poll` matches `polling` — and nothing beyond that.
 *
 * **What it would take to falsify it:** a few dozen turns where a human reads the injected
 * block and the reply and judges "used / not used", scored against `used_evidence.used`. If
 * the two distributions do not separate — if the signal fires about as often on turns a
 * human calls unused as on turns they call used — the method is noise and belongs deleted,
 * not tuned. Tightening a threshold on a signal that has never been checked against a label
 * is how this codebase acquired a 400 ms health budget that failed every trial it was given.
 * Until that check exists, nothing may gate recall on this: it is a measurement, not a
 * verdict, and `drain` treats it as one.
 *
 * §4.4: nothing from the reply is written down. The record carries only terms that
 * `prompt-recall` already staged and already scrubbed, so a secret the assistant happened to
 * print cannot land here — the reply is read, matched against, and dropped.
 *
 * @param {Record<string, any>} turn   the staged turn, as read
 * @param {Record<string, any>} payload
 * @returns {Record<string, any>|null} null when there was nothing to measure against
 */
function usedEvidence(turn, payload) {
  const recall = isObject(turn.recall) ? turn.recall : null;
  if (!recall || !Array.isArray(recall.terms)) return null;

  const terms = recall.terms
    .filter((t) => typeof t === 'string'
      && t.length >= TERM_MIN_CHARS && t.length <= TERM_MAX_CHARS)
    .map((t) => t.toLowerCase())
    .slice(0, MAX_TERMS_READ);

  const answer = str(payload.last_assistant_message) || str(payload.message);

  /** @type {Record<string, any>} */
  const out = {
    method: USED_SIGNAL_METHOD,
    at: Date.now(),
    candidates: terms.length,
    matched: 0,
    terms: [],
    answer_chars: answer.length,
  };

  // Both of these are "unmeasurable", not "unused", so neither sets `used`. An injection
  // whose every distinctive word was already in the prompt cannot be told apart from one
  // the model ignored, and saying otherwise would put a fabricated denominator on the wire.
  if (terms.length === 0) { out.reason = 'no_distinct_terms'; return out; }
  if (!answer.trim()) { out.reason = 'no_reply'; return out; }

  const hits = matchTerms(terms, answer.slice(0, MAX_ANSWER_SCAN));
  out.matched = hits.length;
  out.terms = hits.slice(0, MAX_EVIDENCE_TERMS);
  out.used = hits.length > 0;
  return out;
}

/**
 * Which of `terms` the reply carries.
 *
 * Every run of non-word characters becomes a single space, so the haystack is a stream of
 * space-delimited words and a term preceded by a space is a match at a left word boundary.
 * The *right* boundary is deliberately absent: `queue` matches `queued`, `idempotency`
 * matches `idempotency_key`. English inflection is the common case, and demanding an exact
 * match would turn ordinary suffixing into a false negative — the failure mode this signal
 * already has too much of.
 *
 * @param {string[]} terms  lowercased
 * @param {string} text
 * @returns {string[]} the matched terms, in the order they were staged
 */
function matchTerms(terms, text) {
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9_]+/g, ' ')} `;
  return terms.filter((t) => hay.includes(` ${t}`));
}

// ---------------------------------------------------------------------------
// The drain
// ---------------------------------------------------------------------------

/**
 * §5.3/§5.5: `count >= batchMaxItems OR oldestMs >= batchMaxAgeMs`.
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {boolean}
 */
function drainTriggerFired(cfg, runId) {
  const stats = spoolStats(cfg, runId);
  if (!stats || stats.count <= 0) return false;
  const maxItems = positiveInt(cfg?.batchMaxItems, 32);
  const maxAgeMs = positiveInt(cfg?.batchMaxAgeMs, 30000);
  return stats.count >= maxItems || stats.oldestMs >= maxAgeMs;
}

/** `--with-outcome <prompt_id>`, or nothing when the turn has no id to attribute against. */
function outcomeArgs(payload) {
  const id = turnKey(payload);
  return id ? ['--with-outcome', id] : [];
}

/**
 * The one and only outbound act in this process — and it is a `spawn`, not a socket.
 *
 * The handoff payload is deliberately slim: the drain needs an identity and a turn, not the
 * two-megabyte `tool_input` that happened to trigger it.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {Record<string, any>} payload
 * @param {string[]} args
 */
function fireDrain(cfg, runId, payload, args) {
  const handoff = stashPayload(cfg, {
    hook_event_name: str(payload.hook_event_name),
    session_id: str(payload.session_id),
    prompt_id: turnKey(payload),
    transcript_path: str(payload.transcript_path),
    cwd: str(payload.cwd),
    permission_mode: str(payload.permission_mode),
    agent_id: str(payload.agent_id),
    agent_type: str(payload.agent_type),
    // Resolved here rather than in the child: the child reads this stash, not the payload.
    turn_number: attempt(() => turnNumber(cfg, runId, payload), 0),
    run_id: runId,
  });
  spawnDetached(cfg, 'drain', args, handoff);
}

// ---------------------------------------------------------------------------
// Denylist
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, any>} payload
 * @param {Record<string, any>} cfg
 * @returns {boolean}
 */
function hasDeniedSubject(payload, cfg) {
  const input = isObject(payload.tool_input) ? payload.tool_input : {};
  const projectDir = str(cfg?.projectDir);
  for (const key of PATH_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v && isDeniedPath(v, cfg, projectDir)) return true;
  }
  // `MultiEdit`-shaped inputs carry their subjects one level down.
  const edits = Array.isArray(input.edits) ? input.edits.slice(0, MAX_RENDER_ITEMS) : [];
  for (const e of edits) {
    if (!isObject(e)) continue;
    for (const key of PATH_KEYS) {
      const v = e[key];
      if (typeof v === 'string' && v && isDeniedPath(v, cfg, projectDir)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * §5.4: "every step is individually try/caught". One broken step costs its own contribution
 * and nothing else — most importantly, a redaction crash drops the item rather than letting
 * an unredacted one through.
 * @template T
 * @param {() => T} fn
 * @param {T} [fallback]
 * @returns {T}
 */
function attempt(fn, fallback = /** @type {any} */ (undefined)) {
  try { return fn(); } catch { return fallback; }
}

/** @param {any} v @returns {boolean} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @param {any} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v : '';
}

/** @param {any} v @returns {number} */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** @param {any} v @param {number} d @returns {number} */
function finiteOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** @param {any} v @param {number} d @returns {number} */
function positiveInt(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : d;
}

/** @param {string} s @param {number} max @returns {string} */
function clamp(s, max) {
  const v = typeof s === 'string' ? s : String(s ?? '');
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

/** An id fragment safe as both a path segment and a wire value. @param {any} v */
function idPart(v) {
  return safeSegment(v, MAX_ID_CHARS);
}

/**
 * No `tool_use_id` — an older host, or a synthetic event. A content hash keeps the dedup
 * property (the same call twice is still one item) without inventing an identity.
 * @param {Record<string, any>} payload
 * @param {string} text
 */
function fallbackId(payload, text) {
  let h = 0x811c9dc5;
  const seed = `${str(payload.session_id)}|${turnKey(payload)}|${str(payload.tool_name)}|${text}`;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `anon-${h.toString(16).padStart(8, '0')}`;
}

/** §1.5: there is no path out of here with an empty or `unclassified` intent. */
function intentOr(v) {
  const s = str(v).trim();
  return s && s !== 'unclassified' ? s : 'tool_output';
}

/** §1.3: `importance` is a closed vocabulary; anything else is a 422 waiting to happen. */
function importanceOr(v) {
  const s = str(v).trim().toLowerCase();
  return ['low', 'medium', 'high', 'critical'].includes(s) ? s : 'medium';
}

/** `metadata_json` goes on the wire as a STRING, not an object (control.proto). */
function safeJson(v) {
  try {
    const s = JSON.stringify(v ?? {});
    return typeof s === 'string' ? s : '{}';
  } catch {
    return '{}';
  }
}
