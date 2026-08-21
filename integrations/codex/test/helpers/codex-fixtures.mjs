// @ts-check
/**
 * Test harness for the `mubit-memory` **Codex** plugin.
 *
 * Two things live here and nothing else:
 *
 *   1. **One builder per Codex hook event.** Each returns a payload shaped exactly as
 *      `codex exec` writes it — recorded in `docs/harness-probe.md` §5, not invented.
 *   2. **A draft-07 validator, and the host's own schemas to run it against.** This is the
 *      load-bearing part. A fixture written beside the implementation cannot falsify that
 *      implementation: whatever shape the code expects, the fixture will have. A fixture
 *      checked against `test/fixtures/codex-hook-schemas/*.json` — extracted verbatim from
 *      the Codex binary — can, because those schemas were written by the host and every one
 *      of them is `additionalProperties: false`.
 *
 * Everything else — `makeDataDir`, `fakeMubit`, `runHook`, `assertHookContract`,
 * `mcpListTools` — is the Claude Code suite's harness, re-exported. There is deliberately no
 * second copy: the spawn protocol, the fake server and the contract assertions are identical
 * across the two hosts, and a fork of them would be a second thing to keep true. The wrappers
 * below only bind the plugin root, so `runHook('capture', …)` here runs
 * `integrations/codex/hooks/{src,dist}/capture.mjs`.
 *
 * Node >= 20 built-ins only. No YAML, no JSON-Schema dependency, no framework.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as h from '../../../claude-code/test/helpers/harness.mjs';

/** Absolute path to `integrations/codex/`. */
export const CODEX_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Absolute path to `integrations/claude-code/` — the plugin whose `lib/` both share. */
export const SHARED_ROOT = resolve(CODEX_ROOT, '..', 'claude-code');

/** Absolute path to the repo root. */
export const REPO_ROOT = resolve(CODEX_ROOT, '..', '..');

/** Where the schemas extracted from the Codex binary live. */
export const SCHEMA_DIR = join(CODEX_ROOT, 'test', 'fixtures', 'codex-hook-schemas');

/**
 * The eleven events Codex 0.146.0 dispatches, in the order its own `HookEventsToml` lists
 * them. Claude Code has thirteen; `CwdChanged`, `PostToolUseFailure` and `StopFailure` have
 * no Codex counterpart, and `PermissionRequest` has no Claude Code one.
 */
export const CODEX_EVENTS = [
  'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop',
];

/** `PreToolUse` -> `pre-tool-use`, which is how the extracted schema files are named. */
export function schemaSlug(event) {
  return String(event).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// ---------------------------------------------------------------------------
// Re-exports, bound to the Codex plugin root
// ---------------------------------------------------------------------------

export const {
  assert, tempDir, makeDataDir, makeProjectDir, withEnv, fakeMubit, defaultRoutes,
  queryResponse, evidence, contextResponse, assertHookContract, assertWithinBudget,
  readJsonFile, readJsonDir, spoolFiles, soleRunId, waitFor,
} = h;

/** `baseEnv`, with `CLAUDE_PLUGIN_ROOT` pointing at the Codex plugin. */
export function baseEnv(o) {
  return h.baseEnv({ ...o, pluginRoot: o.pluginRoot ?? CODEX_ROOT });
}

/** `runHook`, resolving `integrations/codex/hooks/{src,dist}/<name>.mjs`. */
export function runHook(name, payload, opts = {}) {
  return h.runHook(name, payload, { root: CODEX_ROOT, ...opts });
}

/** `mcpListTools`, launching `integrations/codex/mcp/dist/index.js`. */
export function mcpListTools(opts = {}) {
  return h.mcpListTools({ root: CODEX_ROOT, ...opts });
}

/** `mcpDrive`, launching the Codex plugin's server. */
export function mcpDrive(opts = {}) {
  return h.mcpDrive({ root: CODEX_ROOT, ...opts });
}

/** Import a shared `lib/` module fresh. The Codex plugin has no `lib/` of its own but one. */
export function lib(file) { return h.lib(file); }

let _bust = 0;

/** Import a module from **this** plugin (e.g. `lib/boot.mjs`), bypassing the ESM cache. */
export function codexMod(relPath) {
  const p = join(CODEX_ROOT, relPath);
  if (!existsSync(p)) {
    throw new Error(`integrations/codex/${relPath} does not exist yet — write it, then re-run.`);
  }
  return import(`${new URL(`file://${p}`).href}?fresh=${_bust++}`);
}

// ---------------------------------------------------------------------------
// The schemas Codex itself carries
// ---------------------------------------------------------------------------

/** @type {Map<string, any>} */
const _schemas = new Map();

/**
 * One extracted schema, by title — e.g. `'post-tool-use.command.input'`.
 *
 * Fails loudly rather than skipping. A skipped schema check is indistinguishable from a
 * passing one, and these files are the only thing in the suite the implementation did not
 * write.
 *
 * @param {string} title
 * @returns {any}
 */
export function hostSchema(title) {
  if (_schemas.has(title)) return _schemas.get(title);
  const p = join(SCHEMA_DIR, `${title}.json`);
  if (!existsSync(p)) {
    const have = existsSync(SCHEMA_DIR) ? readdirSync(SCHEMA_DIR).join(', ') : '(no directory)';
    throw new Error(
      `no extracted schema for "${title}" at ${p}\n`
      + `  Present: ${have}\n`
      + '  These are extracted from the Codex binary; see docs/harness-probe.md, Appendix.');
  }
  const parsed = JSON.parse(readFileSync(p, 'utf8'));
  _schemas.set(title, parsed);
  return parsed;
}

/** Every extracted schema title on disk, sorted. */
export function hostSchemaTitles() {
  if (!existsSync(SCHEMA_DIR)) return [];
  return readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length)).sort();
}

// ---------------------------------------------------------------------------
// A draft-07 validator, in about eighty lines
// ---------------------------------------------------------------------------

/**
 * Validate `value` against one of the extracted schemas and return the errors as paths.
 *
 * This covers exactly the keywords Codex's generated schemas use — `type`, `const`, `enum`,
 * `properties`, `required`, `additionalProperties`, `$ref` into `#/definitions/*`, `allOf`,
 * and the bare `true` schema (`"tool_input": true`) — and nothing else. A schema keyword
 * that turns up later and is not handled here is reported as an error rather than ignored,
 * so the validator cannot quietly stop validating.
 *
 * `additionalProperties: false` is why this matters: it is what turns "my fixture has a
 * `prompt_id` field" from a harmless extra into a failure, which is precisely the mistake
 * a hand-written Codex fixture is most likely to make.
 *
 * @param {any} value
 * @param {any} schema  a whole document (its `definitions` resolve `$ref`)
 * @param {string} [path]
 * @returns {string[]} human-readable errors, empty when valid
 */
export function schemaErrors(value, schema, path = '$') {
  return check(value, schema, schema, path);
}

const KNOWN = new Set([
  '$schema', 'title', 'description', 'definitions', 'default',
  'type', 'const', 'enum', 'properties', 'required', 'additionalProperties', '$ref', 'allOf',
]);

function check(value, schema, root, path) {
  if (schema === true) return [];
  if (schema === false) return [`${path}: schema is \`false\` — nothing validates`];
  if (!schema || typeof schema !== 'object') return [`${path}: not a schema: ${JSON.stringify(schema)}`];

  /** @type {string[]} */
  const errs = [];

  for (const k of Object.keys(schema)) {
    if (!KNOWN.has(k)) errs.push(`${path}: unhandled schema keyword \`${k}\` — teach the validator`);
  }

  if (schema.$ref) {
    const target = deref(schema.$ref, root);
    if (!target) return [`${path}: cannot resolve $ref ${schema.$ref}`];
    return check(value, target, root, path);
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) errs.push(...check(value, sub, root, path));
  }

  if (schema.type !== undefined) {
    const want = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!want.some((t) => isType(value, t))) {
      errs.push(`${path}: expected type ${want.join('|')}, got ${typeName(value)}`);
      return errs;   // every keyword below assumes the type held
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errs.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errs.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    for (const req of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, req)) {
        errs.push(`${path}: missing required property \`${req}\``);
      }
    }
    for (const [k, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        errs.push(...check(v, props[k], root, `${path}.${k}`));
      } else if (schema.additionalProperties === false) {
        errs.push(`${path}: property \`${k}\` is not in the schema, and additionalProperties is false`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errs.push(...check(v, schema.additionalProperties, root, `${path}.${k}`));
      }
    }
  }

  return errs;
}

function deref(ref, root) {
  const m = /^#\/definitions\/(.+)$/.exec(String(ref));
  if (!m) return null;
  return root?.definitions?.[m[1]] ?? null;
}

function isType(v, t) {
  switch (t) {
    case 'null': return v === null;
    case 'boolean': return typeof v === 'boolean';
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'array': return Array.isArray(v);
    case 'object': return !!v && typeof v === 'object' && !Array.isArray(v);
    default: return false;
  }
}

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Assert a payload validates, with the failures listed.
 * @param {any} value
 * @param {string} title  e.g. `'session-start.command.input'`
 * @param {string} what   what the caller is validating, for the message
 */
export function assertValid(value, title, what) {
  const errs = schemaErrors(value, hostSchema(title));
  assert.deepEqual(errs, [],
    `${what} does not satisfy the host's own ${title} schema, so it is not a payload Codex `
    + `would ever send — a test built on it proves nothing:\n  ${errs.join('\n  ')}`);
}

// ---------------------------------------------------------------------------
// One builder per event
// ---------------------------------------------------------------------------

/**
 * The fields every turn-scoped Codex payload carries. Recorded, not invented — see
 * `docs/harness-probe.md` §5.
 *
 * `session_id` and `turn_id` are UUIDv7s in the shape Codex actually emits, because the run
 * id and the turn file are both derived from them and a shape that sanitises differently
 * would move where state lands.
 */
const SESSION_ID = '01a0240c-7f5a-7de0-b4e4-caa34b796e11';
const TURN_ID = '01a0240c-7f97-7ca3-a641-cf8d141498a0';
const AGENT_ID = '01a02413-16ff-75b3-a2c0-b3e93f9cfa63';
const TOOL_USE_ID = 'exec-58fe245b-9bd8-4ba2-b4f7-c50964aa140c';
const MODEL = 'gpt-5.6-sol';
const TRANSCRIPT = '/tmp/codex/sessions/2026/08/21/rollout-2026-08-21T12-19-53-01a0240c-7f5a-7de0-b4e4-caa34b796e11.jsonl';

/** @param {Record<string, any>} [over] */
function base(over = {}) {
  return {
    session_id: SESSION_ID,
    transcript_path: TRANSCRIPT,
    cwd: '/tmp/codex/proj',
    model: MODEL,
    permission_mode: 'default',
    ...over,
  };
}

/**
 * `SessionStart`. `source` is one of **four** — `startup`, `resume`, `clear`, `compact`.
 * Claude Code has a fifth, `fork`, and Codex's schema does not list it.
 *
 * Alone among the turn-scoped events it has no `turn_id`: a session starts before a turn
 * does.
 */
export function sessionStart(over = {}) {
  return { ...base(), hook_event_name: 'SessionStart', source: 'startup', ...over };
}

/** `UserPromptSubmit`. The turn key is `turn_id`, where Claude Code sends `prompt_id`. */
export function userPromptSubmit(over = {}) {
  return {
    ...base(),
    turn_id: TURN_ID,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Read README.md with the shell tool, then reply with one short sentence.',
    ...over,
  };
}

/** `PreToolUse`. Codex renames its shell tool to `Bash`, with Claude Code's exact shape. */
export function preToolUse(over = {}) {
  return {
    ...base(),
    turn_id: TURN_ID,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: "sed -n '1,240p' README.md" },
    tool_use_id: TOOL_USE_ID,
    ...over,
  };
}

/**
 * `PermissionRequest` — the one event Claude Code has no counterpart for.
 *
 * It carries `tool_name` and `tool_input` but **no `tool_use_id`**, which is the field that
 * would let a capture correlate it with the `PreToolUse` for the same call. That absence is
 * why the plugin treats this event as read-only: there is nothing here to attribute against
 * that `PreToolUse` does not already carry.
 */
export function permissionRequest(over = {}) {
  return {
    ...base(),
    turn_id: TURN_ID,
    hook_event_name: 'PermissionRequest',
    tool_name: 'mcp__mubit__mubit_recall',
    tool_input: { query: 'how do we build the plugin' },
    ...over,
  };
}

/** `PostToolUse`. `tool_response` is a bare **string** for `Bash` and `apply_patch`. */
export function postToolUse(over = {}) {
  return {
    ...base(),
    turn_id: TURN_ID,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: "sed -n '1,240p' README.md" },
    tool_response: 'hello probe repo\n',
    tool_use_id: TOOL_USE_ID,
    ...over,
  };
}

/**
 * `PreCompact`. Never reached by the probe — a probe turn is far too small to compact — so
 * this one is built from the extracted schema alone, and `codex-payload.test.mjs` says so.
 *
 * Note what is **absent**: the two compaction events carry no `permission_mode`, alone among
 * the nine turn-scoped events. Adding one produces a payload Codex would never send, and the
 * host's `additionalProperties: false` is what catches it.
 */
export function preCompact(over = {}) {
  const { permission_mode: _pm, ...rest } = base();
  return { ...rest, turn_id: TURN_ID, hook_event_name: 'PreCompact', trigger: 'auto', ...over };
}

/** `PostCompact`. Same provenance, and the same missing `permission_mode`. */
export function postCompact(over = {}) {
  const { permission_mode: _pm, ...rest } = base();
  return { ...rest, turn_id: TURN_ID, hook_event_name: 'PostCompact', trigger: 'auto', ...over };
}

/** `SubagentStart`. `transcript_path` here is the **agent's** rollout, not the parent's. */
export function subagentStart(over = {}) {
  return {
    ...base(),
    turn_id: TURN_ID,
    hook_event_name: 'SubagentStart',
    agent_id: AGENT_ID,
    agent_type: 'default',
    ...over,
  };
}

/** `SubagentStop`. Carries both transcripts; `transcript_path` is the parent's. */
export function subagentStop(over = {}) {
  return {
    ...base(),
    turn_id: TURN_ID,
    hook_event_name: 'SubagentStop',
    agent_id: AGENT_ID,
    agent_type: 'default',
    agent_transcript_path:
      '/tmp/codex/sessions/2026/08/21/rollout-2026-08-21T12-27-05-01a02413-16ff-75b3-a2c0-b3e93f9cfa63.jsonl',
    stop_hook_active: false,
    last_assistant_message: 'There are 2 regular files directly in the current directory.',
    ...over,
  };
}

/** `Stop`. */
export function stop(over = {}) {
  return {
    ...base(),
    turn_id: TURN_ID,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'README.md says: "hello probe repo."',
    ...over,
  };
}

/**
 * `SessionEnd`. The thinnest payload of the eleven: no `turn_id`, no `model`, no
 * `permission_mode`, and `reason` is the constant `"other"` — Codex has no equivalent of
 * Claude Code's `clear` / `logout` / `prompt_input_exit` distinctions.
 */
export function sessionEnd(over = {}) {
  return {
    session_id: SESSION_ID,
    transcript_path: TRANSCRIPT,
    cwd: '/tmp/codex/proj',
    hook_event_name: 'SessionEnd',
    reason: 'other',
    ...over,
  };
}

/** Every builder, by event name — so a test can table-drive all eleven. */
export const BUILDERS = Object.freeze({
  SessionStart: sessionStart,
  UserPromptSubmit: userPromptSubmit,
  PreToolUse: preToolUse,
  PermissionRequest: permissionRequest,
  PostToolUse: postToolUse,
  PreCompact: preCompact,
  PostCompact: postCompact,
  SubagentStart: subagentStart,
  SubagentStop: subagentStop,
  Stop: stop,
  SessionEnd: sessionEnd,
});

// ---------------------------------------------------------------------------
// A rollout transcript, in Codex's own JSONL
// ---------------------------------------------------------------------------

/**
 * A Codex rollout file's worth of lines, as recorded in `docs/harness-probe.md` §8.
 *
 * The envelope is `{"type":"response_item","payload":{"type":"message",role,content:[…]}}`,
 * where Claude Code's is `{"type":…,"message":{role,content:[…]}}`. The content item's own
 * `type` also differs — `input_text` / `output_text` against Claude Code's `text` — which is
 * why a reader has to key off the presence of `content[].text` rather than off the item type.
 *
 * The non-conversation envelopes (`session_meta`, `event_msg`, `world_state`, `turn_context`)
 * are included because they are most of a real rollout and a reader that renders them would
 * spend its window on machinery.
 *
 * @param {Array<{role: string, text: string}>} [messages]
 * @returns {string}
 */
export function rolloutJsonl(messages = []) {
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { session_id: SESSION_ID, cwd: '/tmp/codex/proj', cli_version: '0.146.0' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: TURN_ID } }),
  ];
  for (const m of messages) {
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        id: `msg_${lines.length}`,
        role: m.role,
        content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.text }],
      },
    }));
    if (m.role === 'assistant') {
      lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: m.text } }));
    }
  }
  lines.push(JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAA…' } }));
  lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: TURN_ID } }));
  return `${lines.join('\n')}\n`;
}
