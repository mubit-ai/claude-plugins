// @ts-check
/**
 * `lib/codex-import.mjs` — the Codex source for the transcript backfill.
 *
 * ---------------------------------------------------------------------------
 * Where the rollouts are, and what one is
 * ---------------------------------------------------------------------------
 * Codex writes one rollout per thread under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
 * (`$CODEX_HOME/sessions` when that is set). The layout is by date rather than by project, so
 * unlike `lib/import.mjs`'s directory filter there is nothing to narrow on before opening a
 * file: every rollout is opened and its records decide, per turn, whether they fall inside the
 * scope. A `session_meta` record opens the file with the thread's `cwd`, `cli_version` and
 * `thread_source`; every turn then carries a `turn_context` with the `cwd` it ran in, which is
 * where the run id comes from — a thread that `cd`s is attributed turn by turn, not once.
 *
 * ---------------------------------------------------------------------------
 * Two shapes, one reader, and the version that separates them
 * ---------------------------------------------------------------------------
 * Counted over a real `~/.codex/sessions` — 169 rollouts, 0.130 to 0.153:
 *
 * | | before 0.149 | 0.149 and later |
 * | --- | --- | --- |
 * | the prompt | `response_item/message/role:user` | the same — but the *first* one is the host's own preamble |
 * | the answer | `response_item/message/role:assistant` | the same, with a `phase` |
 * | a shell call | `function_call` (`exec_command`) joined to `function_call_output` by `call_id`; the exit code inside the output text | `event_msg/item_completed` with a `CommandExecution` item: command, `exit_code`, `status`, output |
 * | a patch | `custom_tool_call` (`apply_patch`) with the patch body, `patch_apply_end` with the per-path kinds, then the output | a `FileChange` item with `changes: {path: {type}}` and no body at all |
 * | an MCP call | a `function_call` like any other | a `McpToolCall` item with `server`, `tool`, `arguments`, `result`/`error` |
 *
 * The item id follows the same rule on both sides. Live capture on Codex writes
 * `cc-<tool_use_id>`, and the host's `tool_use_id` is the `item_completed` item's own `id` —
 * `lib/codex-rollout.mjs` already matches on exactly that to read an outcome — so an imported
 * 0.149+ tool call carries the byte-identical id the hook would have written. Before 0.149
 * there was no `item` and the join key is `call_id`; those threads predate the plugin, so
 * nothing live is there to collide with either way.
 *
 * ---------------------------------------------------------------------------
 * What is never read
 * ---------------------------------------------------------------------------
 * A rollout says most things twice. `event_msg/user_message` and `event_msg/agent_message`
 * are the UI's copies of the `response_item` messages; from 0.149 the `UserMessage`,
 * `AgentMessage` and `Reasoning` items in `item_completed` are a third copy. Reading any of
 * them would import every turn twice under different ids. Only `response_item/message` is
 * conversation here, and only `CommandExecution`, `FileChange` and `McpToolCall` items are
 * tools. On a 0.149+ thread the `custom_tool_call` named `exec` is the *script* the model
 * wrote to drive its commands, and the `CommandExecution` items are the commands it ran; the
 * script is not read, or every command would be recorded twice.
 *
 * ---------------------------------------------------------------------------
 * Threads that are not the user's
 * ---------------------------------------------------------------------------
 * A `thread_source` of `guardian_review` — or, on the versions that spelled it as
 * `subagent`, a `source.subagent.other` of `guardian` — is the approval reviewer: a thread
 * whose every "prompt" is a pasted transcript of another thread and an action to assess. It is
 * read to its end so the cursor lands at EOF, and it contributes nothing. A `subagent` thread
 * proper carries the parent's thread id in `session_id` and its own in `id`; its items are
 * filed under the parent session and under whichever run its `cwd` resolves to, which is how
 * a Claude Code subagent transcript is filed too.
 *
 * ---------------------------------------------------------------------------
 * The preamble that looks like a prompt
 * ---------------------------------------------------------------------------
 * From 0.149 the first `user` record of a thread is `<recommended_plugins>` and
 * `<environment_context>`, and the prompt the person typed is the record after it.
 * `lib/codex-rollout.mjs` owns the filter, because live capture has the same problem:
 * `capture --subagent` renders `Q:` from the head of the agent's rollout and has been reading
 * the plugin listing as the task since that version.
 *
 * Constraints shared with the rest of `lib/`: zero dependencies, Node >= 20 built-ins, no
 * import outside `lib/`, and nothing here throws. Everything Codex-shaped is here; everything
 * a source shares — cursors, redaction, the denylist, batching, pacing, the item shape — is
 * `lib/import.mjs`'s, and this module only calls it.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { stripInjectedBlocks } from './codex-rollout.mjs';
import { buildToolItem, buildTurnItem, rootFor } from './import.mjs';
import { messageText, parseLine, readForward } from './transcript.mjs';

/** The rollout root. Overridable so a test never reads the real one. */
export const CODEX_SESSIONS_ROOT_ENV = 'MUBIT_CC_CODEX_SESSIONS_ROOT';

/** The `tool:` tag every item from this source carries. */
export const HOST = 'codex';

/** The first version whose rollouts carry `item_completed` tool items. */
const ITEMS_SINCE = [0, 149, 0];

/** The `item_completed` item types that are tool calls. Everything else is a copy of a message. */
const TOOL_ITEM_TYPES = new Set(['CommandExecution', 'FileChange', 'McpToolCall']);

/** The `function_call` names that are a shell, and the argument keys that hold the command. */
const SHELL_CALLS = new Set(['exec_command', 'shell', 'local_shell', 'container.exec']);
const SHELL_ARG_KEYS = ['cmd', 'command'];

/** How much of a prompt or answer is kept in one item; the same bound as `lib/import.mjs`. */
const MAX_TEXT_CHARS = 8000;

/** How deep the date tree goes: `YYYY/MM/DD/rollout-*.jsonl`. */
const DATE_DEPTH = 3;

/** A `FileChange` item's `changes[path].type`, which uses the same three words. */
const CHANGE_KINDS = new Set(['add', 'delete', 'update']);

// ---------------------------------------------------------------------------
// Where the rollouts are
// ---------------------------------------------------------------------------

/**
 * `MUBIT_CC_CODEX_SESSIONS_ROOT`, else `$CODEX_HOME/sessions`, else `~/.codex/sessions`.
 * @param {Record<string, any>} [env]
 * @returns {string}
 */
export function rolloutRoot(env = process.env) {
  const override = str(env?.[CODEX_SESSIONS_ROOT_ENV]);
  if (override) return override;
  const home = str(env?.CODEX_HOME);
  return home ? join(home, 'sessions') : join(homedir(), '.codex', 'sessions');
}

/**
 * Every rollout under the root, oldest first.
 *
 * `dirFilter` is accepted and ignored: the tree is laid out by date, so a project filter has
 * nothing to bite on, and the records decide scope per turn. `dirName` is the `YYYY/MM/DD`
 * the file was found under, for the report.
 *
 * @param {{root?: string, dirFilter?: (dirName: string) => boolean, maxFiles?: number}} [opts]
 * @returns {{files: Array<{path: string, sessionId: string, agentId: string, dirName: string}>,
 *            dirs: number, truncatedReason: string}}
 */
export function discoverRollouts(opts = {}) {
  const root = str(opts?.root) || rolloutRoot();
  const maxFiles = posInt(opts?.maxFiles, 0);
  const files = [];
  let dirs = 0;
  let truncatedReason = '';

  try {
    /** @type {Array<[string, number]>} */
    const stack = [[root, 0]];
    while (stack.length) {
      const [dir, depth] = /** @type {[string, number]} */ (stack.pop());
      for (const e of dirEntries(dir)) {
        if (e.isDirectory()) {
          if (depth < DATE_DEPTH) stack.push([join(dir, e.name), depth + 1]);
          continue;
        }
        if (!e.isFile() || !e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl')) continue;
        files.push({
          path: join(dir, e.name),
          sessionId: '',
          agentId: '',
          dirName: dir.slice(root.length).replace(/^[/\\]/, ''),
        });
      }
      if (depth === DATE_DEPTH) dirs += 1;
    }
  } catch {
    // An unreadable root is a machine with no Codex history, which is a real state.
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (maxFiles && files.length > maxFiles) {
    truncatedReason = `stopped after ${maxFiles} rollout file(s); more remain`;
    files.length = maxFiles;
  }
  return { files, dirs, truncatedReason };
}

// ---------------------------------------------------------------------------
// One rollout → items
// ---------------------------------------------------------------------------

/**
 * Read one rollout from its cursor and turn it into items — the Codex half of
 * `lib/import.mjs`'s `importItems`, with the same result shape and the same rules on prompts,
 * answers and turns.
 *
 * Two pieces of state a Claude Code transcript never needs. **`legacy`**: whether this thread
 * predates 0.149, decided from `session_meta.cli_version`, which is what says whether tool
 * calls are joined `function_call` pairs or `item_completed` items. **`pending`** and
 * **`patches`**: on a legacy thread, a call is held until its output line arrives and a
 * `patch_apply_end` is held until the patch's output does, because the kinds are on the one
 * and the outcome on the other.
 *
 * A resumed read — `from > 0` — re-reads the file's first record before starting, because the
 * `session_meta` it needs is on line one and the cursor is past it. Without that a thread that
 * grew since the last import would be read with no version, no session and no cwd until its
 * next `turn_context`.
 *
 * @param {Record<string, any>} cfg
 * @param {string} path
 * @param {{from?: number, roots?: string[], maxItems?: number, projectDir?: string}} [opts]
 * @returns {{items: Array<{runId: string, cwd: string, item: Record<string, any>}>, offset: number,
 *            lines: number, skipped: number, denied: number, oversize: number, truncatedReason: string}}
 */
export function rolloutItems(cfg, path, opts = {}) {
  const items = [];
  const roots = Array.isArray(opts?.roots) ? opts.roots : [];
  const maxItems = posInt(opts?.maxItems, 0);
  let offset = nonNeg(opts?.from);
  let lines = 0;
  let skipped = 0;
  let denied = 0;
  let oversize = 0;
  let truncatedReason = '';

  /** What `session_meta` said, and what the turns have said since. */
  const thread = { cwd: '', sessionId: '', legacy: false, skip: false };
  /** legacy: `call_id` → the call, until its output turns up. */
  const pending = new Map();
  /** legacy: `call_id` → `{files, success}` from `patch_apply_end`, until the output turns up. */
  const patches = new Map();
  /** The turn being accumulated: one prompt and every assistant message that follows it. */
  let turn = null;

  const build = (call, result) => {
    const built = buildToolItem(cfg, { ...call, host: HOST }, result, opts);
    if (built === 'denied') { denied += 1; return; }
    if (built) items.push(built);
  };

  if (offset > 0) applyMeta(thread, firstRecord(path));

  for (const line of readForward(path, { from: offset })) {
    lines += 1;
    offset = line.offset;
    if (line.oversize) { oversize += 1; continue; }
    if (thread.skip) { skipped += 1; continue; }

    const entry = parseLine(line.text);
    if (!entry) { skipped += 1; continue; }
    const type = str(entry.type);
    const p = isObject(entry.payload) ? entry.payload : {};

    if (type === 'session_meta') {
      applyMeta(thread, entry);
      if (thread.skip) { skipped += 1; continue; }
      continue;
    }
    if (type === 'turn_context') {
      if (str(p.cwd)) thread.cwd = str(p.cwd);
      continue;
    }

    // The scope decision, per record, because `cwd` changes between turns.
    const cwd = thread.cwd;
    const root = roots.length ? rootFor(cwd, roots) : (cwd || str(opts?.projectDir) || '');
    if (roots.length && !root) { skipped += 1; continue; }
    const where = { cwd, root, sessionId: thread.sessionId };

    if (type === 'response_item') {
      const pt = str(p.type);
      if (pt === 'message') {
        const role = str(p.role);
        if (role === 'user') {
          const text = messageText(stripInjectedBlocks(p.content)).trim();
          if (!text) { skipped += 1; continue; }
          const done = buildTurnItem(cfg, turn, opts);
          if (done) items.push(done);
          turn = { prompt: text, answer: [], ...where, host: HOST };
        } else if (role === 'assistant' && turn) {
          const text = messageText(p.content).trim();
          if (text && turn.answer.join('\n').length < MAX_TEXT_CHARS) turn.answer.push(text);
        }
        // `developer` and everything else is the harness talking to the model.
      } else if (thread.legacy && (pt === 'function_call' || pt === 'custom_tool_call')) {
        const id = str(p.call_id);
        if (id) pending.set(id, { id, ...legacyCall(p), ...where });
      } else if (thread.legacy && (pt === 'function_call_output' || pt === 'custom_tool_call_output')) {
        const id = str(p.call_id);
        const call = pending.get(id);
        pending.delete(id);
        // An output with no call is the far side of a window that started mid-thread.
        if (!call) { skipped += 1; continue; }
        const patch = patches.get(id);
        patches.delete(id);
        const output = outputText(p.output);
        const exitCode = exitCodeOf(output);
        const failed = patch ? patch.success === false : (exitCode !== null && exitCode !== 0);
        build({
          ...call,
          ...(patch && patch.files.length ? { files: patch.files } : {}),
          exitCode,
        }, { content: output, isError: failed });
      }
    } else if (type === 'event_msg') {
      const pt = str(p.type);
      if (pt === 'item_completed' && !thread.legacy) {
        const item = isObject(p.item) ? p.item : null;
        if (item && TOOL_ITEM_TYPES.has(str(item.type))) {
          const c = itemCall(item);
          if (c) build({ ...c, ...where }, { content: c.output, isError: c.failed });
        }
      } else if (pt === 'patch_apply_end' && thread.legacy) {
        const id = str(p.call_id);
        if (id) patches.set(id, { files: changesToFiles(p.changes), success: p.success !== false });
      }
    }

    if (maxItems && items.length >= maxItems) {
      truncatedReason = `stopped at ${maxItems} item(s) from this rollout; it holds more`;
      break;
    }
  }

  const last = buildTurnItem(cfg, turn, opts);
  if (last) items.push(last);

  // Calls with no output are dropped, deliberately and countably, as in `importItems`.
  skipped += pending.size;
  return { items, offset, lines, skipped, denied, oversize, truncatedReason };
}

// ---------------------------------------------------------------------------
// The thread
// ---------------------------------------------------------------------------

/**
 * Apply a `session_meta` record to the thread state: cwd, session, version, and whether the
 * whole file is a reviewer's.
 * @param {{cwd: string, sessionId: string, legacy: boolean, skip: boolean}} thread
 * @param {Record<string, any>|null} entry
 */
function applyMeta(thread, entry) {
  if (!entry || str(entry.type) !== 'session_meta') return;
  const p = isObject(entry.payload) ? entry.payload : {};
  if (str(p.cwd)) thread.cwd = str(p.cwd);
  // A subagent's `session_id` is its parent thread; its own id is `id`. Filing under the
  // parent is what rejoins a fan-out, the way a Claude Code subagent transcript carries its
  // parent's `sessionId`.
  thread.sessionId = str(p.session_id) || str(p.id);
  thread.legacy = versionBefore(str(p.cli_version), ITEMS_SINCE);
  thread.skip = isReviewer(p);
}

/**
 * The approval reviewer's thread. Its prompts are other threads' transcripts and actions to
 * judge, and importing them would file every reviewed session twice under a reviewer's words.
 * @param {Record<string, any>} meta
 */
function isReviewer(meta) {
  if (str(meta.thread_source) === 'guardian_review') return true;
  const other = meta.source?.subagent?.other;
  return typeof other === 'string' && other.toLowerCase() === 'guardian';
}

/** The first record of the file, or `null`. Used by a resumed read to recover `session_meta`. */
function firstRecord(path) {
  try {
    for (const line of readForward(path, { from: 0 })) {
      return line.oversize ? null : parseLine(line.text);
    }
  } catch {
    // Unreadable: the loop below reads nothing either.
  }
  return null;
}

/**
 * Is `version` older than `floor`? An unparseable version reads as current — the
 * `item_completed` shape is the one the host writes today, and a thread with no version at
 * all is more likely a new shape than an old one.
 * @param {string} version @param {number[]} floor
 */
function versionBefore(version, floor) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < floor.length; i += 1) {
    if (v[i] < floor[i]) return true;
    if (v[i] > floor[i]) return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 0.149+: one item is the whole call
// ---------------------------------------------------------------------------

/**
 * An `item_completed` tool item as a call, its output and its outcome.
 *
 * The tool names follow what the Codex hook payloads use, so an imported item and a captured
 * one classify alike: the shell is `Bash` with `{command}`, a patch is `apply_patch`, and an
 * MCP call is `mcp__<server>__<tool>` — the spelling `isSelfReference` knows, which is what
 * keeps the plugin's own `mubit_*` calls out of memory here too.
 *
 * @param {Record<string, any>} item
 * @returns {{id: string, name: string, input: Record<string, any>, output: string, failed: boolean,
 *            exitCode: number|null, files?: Array<{path: string, kind: string}>}|null}
 */
function itemCall(item) {
  const id = str(item.id);
  if (!id) return null;
  const status = str(item.status);
  const type = str(item.type);

  if (type === 'CommandExecution') {
    const exitCode = Number.isFinite(item.exit_code) ? Number(item.exit_code) : null;
    return {
      id,
      name: 'Bash',
      input: { command: commandText(item.command) },
      output: str(item.aggregated_output) || [str(item.stdout), str(item.stderr)].filter(Boolean).join('\n'),
      // `status` is the host's own verdict; `exit_code` is the fallback, as in `toolCallRecord`.
      failed: status ? status === 'failed' : exitCode !== null && exitCode !== 0,
      exitCode,
    };
  }
  if (type === 'FileChange') {
    const files = changesToFiles(item.changes);
    return {
      id,
      name: 'apply_patch',
      // No patch body survives in the rollout; the paths are the input the call had.
      input: { paths: files.map((f) => f.path) },
      output: str(item.stdout) || str(item.stderr),
      failed: status === 'failed',
      exitCode: null,
      files,
    };
  }
  // McpToolCall
  const server = str(item.server);
  const tool = str(item.tool);
  const failed = status === 'failed' || (item.error !== undefined && item.error !== null);
  return {
    id,
    name: `mcp__${server || 'mcp'}__${tool || 'tool'}`,
    input: isObject(item.arguments) ? item.arguments : {},
    output: outputText(failed && item.error !== undefined ? item.error : item.result),
    failed,
    exitCode: null,
  };
}

/**
 * `command` is `[shell, "-lc", script]` on this host. The script is the command a person
 * would recognise; the shell in front of it is the same on every line.
 * @param {any} command
 */
function commandText(command) {
  if (typeof command === 'string') return command;
  if (!Array.isArray(command)) return '';
  const parts = command.map((c) => (typeof c === 'string' ? c : String(c ?? '')));
  if (parts.length === 3 && /^-l?c$/.test(parts[1])) return parts[2];
  return parts.join(' ');
}

/**
 * `changes: {path: {type: 'add'|'delete'|'update', …}}` as the file-change lane's rows. The
 * content under each path is not read — it is the whole file, and the lane records what
 * changed, not what it became.
 * @param {any} changes
 * @returns {Array<{path: string, kind: string}>}
 */
function changesToFiles(changes) {
  const out = [];
  if (!isObject(changes)) return out;
  for (const [path, c] of Object.entries(changes)) {
    const p = str(path);
    const kind = isObject(c) ? str(c.type).toLowerCase() : '';
    if (!p || !CHANGE_KINDS.has(kind)) continue;
    out.push({ path: p, kind });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Before 0.149: a call and its output are two lines
// ---------------------------------------------------------------------------

/**
 * A `function_call` or `custom_tool_call` as a call. A shell is renamed `Bash` with its
 * command under `command`, so it classifies as the live hook's shell call would; a patch keeps
 * its body under `command`, which is where `fileChanges` reads the markers from.
 * @param {Record<string, any>} p
 * @returns {{name: string, input: Record<string, any>}}
 */
function legacyCall(p) {
  const name = str(p.name) || 'Tool';
  if (str(p.type) === 'custom_tool_call') {
    const body = typeof p.input === 'string' ? p.input : outputText(p.input);
    return { name: name === 'apply_patch' ? 'apply_patch' : name, input: { command: body } };
  }
  const args = parseArgs(p.arguments);
  if (SHELL_CALLS.has(name)) {
    for (const key of SHELL_ARG_KEYS) {
      if (typeof args[key] === 'string') return { name: 'Bash', input: { command: args[key] } };
    }
  }
  return { name, input: args };
}

/** `arguments` is a JSON string on this shape, and an object on the next. */
function parseArgs(v) {
  if (isObject(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return {};
  try {
    const parsed = JSON.parse(v);
    return isObject(parsed) ? parsed : { input: v };
  } catch {
    return { input: v };
  }
}

/**
 * The exit code an output text states — `Process exited with code N` on a shell, `Exit code: N`
 * on a patch — or `null` when it states none. `null` is "the host did not say", and is never
 * read as success.
 * @param {string} output
 */
function exitCodeOf(output) {
  const m = /(?:Process exited with code|^Exit code:)\s*(-?\d+)/m.exec(output);
  return m ? Number(m[1]) : null;
}

/** An output that is a string, a block list, or an object, as text. */
function outputText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const text = messageText(v, { includeTools: true });
    if (text.trim()) return text;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

/** `~/.codex/sessions`, as a source `lib/import.mjs`'s `runImport` can walk. */
export const codexSource = Object.freeze({
  name: 'codex',
  host: HOST,
  root: (env = process.env) => rolloutRoot(env),
  discover: (opts = {}) => discoverRollouts(opts),
  readItems: (cfg, path, opts = {}) => rolloutItems(cfg, path, opts),
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function dirEntries(p) {
  try {
    return existsSync(p) && statSync(p).isDirectory() ? readdirSync(p, { withFileTypes: true }) : [];
  } catch {
    return [];
  }
}

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function nonNeg(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function posInt(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : d;
}
