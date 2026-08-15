#!/usr/bin/env node
// @ts-check
/**
 * `hooks/src/capture.mjs` — PostToolUse / PostToolUseFailure / Stop / SubagentStop (§5.4).
 *
 * One script, four modes by argv: none, `--failure`, `--stop`, `--subagent`.
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

import { envTags } from '../../lib/config.mjs';
import { runHook, spawnDetached, stashPayload } from '../../lib/hook.mjs';
import { classifyTool, classifyTurn } from '../../lib/classify.mjs';
import { isDeniedPath, isSelfReference, redactParams, redactText } from '../../lib/redact.mjs';
import { deriveAgentId, deriveRunId } from '../../lib/runid.mjs';
import { appendItem, spoolStats } from '../../lib/spool.mjs';
import { readJson, resolveDataDir, writeJsonAtomic } from '../../lib/state.mjs';

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

// ---------------------------------------------------------------------------

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
 * @param {string[]} argv
 * @returns {'tool'|'failure'|'stop'|'subagent'}
 */
function pickMode(argv) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes('--failure')) return 'failure';
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
 * @param {'tool'|'failure'|'stop'|'subagent'} mode
 */
function capture(rawPayload, cfg, mode) {
  const payload = isObject(rawPayload) ? rawPayload : {};

  // 1. capture disabled -> nothing to do.
  if (cfg && cfg.capture === false) return;

  // 2. §4.4 self-reference suppression. Without it the plugin records its own traffic,
  //    recalls it, then records the recall.
  //
  //    Applied to a *successful* tool call only. The loop this defends against is one the
  //    plugin's own successful output feeds; a tool that FAILED produced no memory content
  //    to recycle, and "the memory layer's own call blew up" is exactly the diagnostic the
  //    doctor skill exists to surface. Suppressing it would also swallow every failure in
  //    any repo whose crate names happen to contain `mubit` — the fixture
  //    `cargo check -p my-crate` is precisely that case.
  if (mode === 'tool') {
    if (attempt(() => isSelfReference(payload.tool_name, payload.tool_input, cfg), false)) return;
  }

  // 3. §4.4 stage 2: a denylisted subject is DROPPED, never scrubbed. A scrubbed `.env` is
  //    still a map of which secrets the project holds.
  if (mode === 'tool' || mode === 'failure') {
    if (attempt(() => hasDeniedSubject(payload, cfg), false)) return;
  }

  const runId = attempt(() => deriveRunId(cfg, payload), '');
  if (!runId) return;

  // 4-6. classify, build the text, redact.
  const item = attempt(
    () => (mode === 'stop' || mode === 'subagent'
      ? buildTurnItem(payload, cfg, runId, mode)
      : buildToolItem(payload, cfg, mode)),
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
  if (attempt(() => drainTriggerFired(cfg, runId), false)) {
    attempt(() => fireDrain(cfg, runId, payload, []));
  }
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
  const failed = mode === 'failure';
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

  const rawTail = failed ? errorText(payload) : outputText(payload.tool_output);
  const tail = attempt(
    () => redactText(rawTail, cfg, 'output'),
    { text: '', redactions: 0, truncated: false },
  );

  const text = failed
    ? `${toolName}(${params.text}) FAILED: ${tail.text}`
    : `${toolName}(${params.text}) -> ${tail.text}`;
  if (!text.trim()) return null;

  return item({
    cfg,
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
      prompt_id: str(payload.prompt_id),
      execution_time_ms: finiteOr(payload.execution_time_ms, 0),
      outcome: failed ? 'failure' : 'ok',
      truncated: !!(params.truncated || tail.truncated),
      redactions: num(scrubbed.redactions) + num(params.redactions) + num(tail.redactions),
      ...(isObject(cls.metadata) ? cls.metadata : {}),
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

  const turn = attempt(() => readTurn(cfg, runId, payload.prompt_id), null);
  const staged = str(turn?.prompt) || str(payload.prompt);
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
    id: mode === 'subagent'
      ? `cc-sub-${idPart(payload.agent_id) || 'anon'}-${idPart(payload.prompt_id) || idPart(payload.session_id) || 'turn'}`
      : `cc-stop-${idPart(payload.prompt_id) || idPart(payload.session_id) || 'turn'}`,
    text,
    intent: cls.intent,
    importance: cls.importance,
    metadata: {
      hook_event: str(payload.hook_event_name) || event,
      session_id: str(payload.session_id),
      prompt_id: str(payload.prompt_id),
      turn_number: finiteOr(payload.turn_number, 0),
      ...(subAgent ? { agent_id: subAgent, agent_type: str(cls.agentType) } : {}),
      ...(subAgent ? { mubit_agent_id: attempt(() => deriveAgentId(payload), '') } : {}),
      truncated: !!(q.truncated || a.truncated),
      redactions: num(q.redactions) + num(a.redactions),
    },
  });
}

/**
 * The §5.4 wire shape. `item_id` and `content_type` are REQUIRED (§1.3) — a missing one is a
 * 422 for the whole batch, not just this item — and `intent` is always set (§1.5).
 *
 * @param {{cfg: Record<string, any>, id: string, text: string, intent: any,
 *          importance: any, metadata: Record<string, any>}} o
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
    env_tags: attempt(() => envTags(cfg, str(cfg.projectDir)), ['tool:claude-code']),
    metadata_json: safeJson(o.metadata),
  };
  const userId = str(cfg.userId);
  if (userId) out.user_id = userId;
  return out;
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
 * `tool_output` arrives in half a dozen shapes depending on the tool.
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
  return outputText(payload.error ?? payload.tool_output);
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
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {Record<string, any>} payload
 */
function closeTurn(cfg, runId, payload) {
  const p = turnPath(cfg, runId, payload.prompt_id);
  if (!p) return;
  const prev = readJson(p, null);
  const base = isObject(prev) ? prev : {
    prompt_id: str(payload.prompt_id),
    session_id: str(payload.session_id),
    started_at: Date.now(),
  };
  writeJsonAtomic(p, { ...base, ended_at: Date.now(), outcome_pending: true });
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
  const id = str(payload.prompt_id);
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
    prompt_id: str(payload.prompt_id),
    transcript_path: str(payload.transcript_path),
    cwd: str(payload.cwd),
    permission_mode: str(payload.permission_mode),
    agent_id: str(payload.agent_id),
    agent_type: str(payload.agent_type),
    turn_number: finiteOr(payload.turn_number, 0),
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
  return String(v ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, MAX_ID_CHARS);
}

/**
 * No `tool_use_id` — an older host, or a synthetic event. A content hash keeps the dedup
 * property (the same call twice is still one item) without inventing an identity.
 * @param {Record<string, any>} payload
 * @param {string} text
 */
function fallbackId(payload, text) {
  let h = 0x811c9dc5;
  const seed = `${str(payload.session_id)}|${str(payload.prompt_id)}|${str(payload.tool_name)}|${text}`;
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
