// @ts-check
/**
 * One headless `claude` run, in, and one trial record, out.
 *
 * Field names on the plugin-agnostic half deliberately mirror Terminal-Bench's `Trial`
 * dataclass (`TBench/harness/trial_metrics.py`) so a TBench row and a testkit row sit in
 * the same table without an adapter. `resolved` and `reward` stay null: this kit measures
 * overhead and responsiveness, not task success. Keeping the fields present and null is the
 * honest encoding of "we did not run the capability benchmark" — the alternative invites
 * someone to invent a weaker one.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildRun } from './arms.mjs';
import { inspect, parseDebugLog, parseRingLog } from './latency.mjs';

/**
 * Run `claude` once and return every parsed stream-json event.
 *
 * stdout is NDJSON, one event per line, but a long tool result can exceed the pipe buffer
 * and arrive split, so lines are reassembled rather than assumed.
 *
 * @param {object} o
 * @param {string[]} o.argv
 * @param {Record<string,string>} o.env
 * @param {string} o.cwd
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{events: any[], code: number|null, stderr: string, timedOut: boolean, wallMs: number}>}
 */
export function runClaude({ argv, env, cwd, timeoutMs = 600_000 }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('claude', argv, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    /** @type {any[]} */
    const events = [];
    let buf = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { /* a non-JSON line is host chatter */ }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* truncated tail */ } }
      resolve({ events, code, stderr: stderr.slice(-4000), timedOut, wallMs: Date.now() - t0 });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ events, code: null, stderr: String(err.message), timedOut, wallMs: Date.now() - t0 });
    });
  });
}

/**
 * What `system/init` says about the arm.
 *
 * This is the arm's proof of identity. A treatment whose `plugins[]` lacks the plugin ran
 * as a control and its "no difference" result is a lie; a control whose `plugins[]`
 * contains it ran as a treatment. Both are caught here and again in `preflight`.
 *
 * @param {any[]} events @returns {{plugins: string[], pluginErrors: any[], mcpServers: any[], sessionId: string, model: string, found: boolean}}
 */
export function readInit(events) {
  const init = events.find((e) => e?.type === 'system' && e?.subtype === 'init');
  const tools = Array.isArray(init?.tools) ? init.tools.map(String) : [];
  return {
    // `plugins` entries are objects — `{name, path, source, version}` — not strings. Mapping
    // them through String() yields "[object Object]", which reads as "the plugin is absent"
    // and turns a healthy treatment arm into a VOID sweep. The arm check caught exactly this
    // in its own reader, which is the argument for having it.
    plugins: Array.isArray(init?.plugins) ? init.plugins.map((p) => (typeof p === 'string' ? p : String(p?.name || ''))) : [],
    pluginDetail: Array.isArray(init?.plugins) ? init.plugins : [],
    // Absent entirely when nothing failed, so a missing key is good news, not no news.
    pluginErrors: Array.isArray(init?.plugin_errors) ? init.plugin_errors : [],
    mcpServers: Array.isArray(init?.mcp_servers) ? init.mcp_servers : [],
    skills: Array.isArray(init?.skills) ? init.skills.map(String) : [],
    tools,
    sessionId: String(init?.session_id || ''),
    model: String(init?.model || ''),
    found: Boolean(init),
  };
}

/** @param {any[]} events @returns {any|null} */
export function readResult(events) {
  return events.find((e) => e?.type === 'result') || null;
}

/** @param {string} name @param {any[]} plugins @returns {boolean} */
export function pluginLoaded(name, plugins) {
  return plugins.some((p) => {
    const n = typeof p === 'string' ? p : String(p?.name || '');
    return n === name || n.startsWith(`${name}@`);
  });
}

/**
 * Turn a finished run into one trial record.
 *
 * @param {object} o
 * @param {string} o.arm @param {string} o.caseId @param {number} o.rep
 * @param {string} o.pluginName @param {string} o.pluginDir @param {string} o.dataDir
 * @param {string} o.runId @param {string} o.debugFile
 * @param {{events: any[], code: number|null, stderr: string, timedOut: boolean, wallMs: number}} o.run
 * @returns {any}
 */
export function toTrial({ arm, caseId, rep, pluginName, pluginDir, dataDir, runId, debugFile, run }) {
  const init = readInit(run.events);
  const result = readResult(run.events);
  const usage = result?.usage || {};
  const dbg = parseDebugLog(debugFile);
  const ring = parseRingLog(dataDir);
  const ins = inspect(pluginDir, { dataDir, runId });

  const loaded = pluginLoaded(pluginName, init.plugins);
  const assistantText = run.events
    .filter((e) => e?.type === 'assistant')
    .flatMap((e) => (e.message?.content || []).filter((c) => c?.type === 'text').map((c) => String(c.text)))
    .join('\n');

  return {
    schema: 'mubit-testkit/trial/v1',
    arm,
    case: caseId,
    rep,

    // --- TBench `Trial`-compatible half -------------------------------------------------
    resolved: null,
    reward: null,
    complete: Boolean(result) && !run.timedOut,
    scoreable: Boolean(result),
    cost_usd: Number(result?.total_cost_usd ?? 0),
    input_tokens: Number(usage.input_tokens ?? 0),
    cache_creation_tokens: Number(usage.cache_creation_input_tokens ?? 0),
    cache_read_tokens: Number(usage.cache_read_input_tokens ?? 0),
    output_tokens: Number(usage.output_tokens ?? 0),
    thinking_tokens: Number(usage.output_tokens_details?.thinking_tokens ?? 0),
    steps: Number(result?.num_turns ?? 0),
    span_s: run.wallMs / 1000,
    agent_exec_s: Number(result?.duration_ms ?? 0) / 1000,
    exception: run.timedOut ? 'timeout' : (result?.is_error ? String(result?.subtype || 'error') : ''),
    timed_out: run.timedOut,

    // --- host responsiveness -----------------------------------------------------------
    ttft_ms: Number(result?.ttft_ms ?? 0),
    duration_api_ms: Number(result?.duration_api_ms ?? 0),
    time_to_request_ms: Number(result?.time_to_request_ms ?? 0),
    stop_reason: String(result?.stop_reason ?? ''),
    permission_denials: Array.isArray(result?.permission_denials)
      ? result.permission_denials.length
      : Number(result?.permission_denials ?? 0),

    // --- plugin-side -------------------------------------------------------------------
    mubit: {
      loaded,
      plugins: init.plugins,
      plugin_errors: init.pluginErrors,
      mcp_servers: init.mcpServers.map((s) => ({ name: s?.name, status: s?.status })),
      // The MCP surface is most of the plugin's context cost. An arm that loaded the plugin
      // but not its server is a different plugin, and this is how the trial record says so.
      mcp_connected: init.mcpServers.some((s) => /mubit/.test(String(s?.name)) && String(s?.status) === 'connected'),
      tool_count: init.tools.filter((t) => t.startsWith('mcp__') && /mubit/.test(t)).length,
      skill_count: init.skills.filter((t) => /mubit/.test(t)).length,
      recall: dbg.recall,
      recall_ms: dbg.recall.map((r) => r.ms),
      recall_tok: dbg.recall.map((r) => r.tokens),
      recall_sources: dbg.recall.map((r) => r.sources),
      mcp_boot_ms: dbg.mcpBootMs,
      budget_overruns: ring.overruns,
      drain_ms: ring.drainMs,
      log_errors: ring.errors.slice(0, 10),
      marker_state: String(ins?.marker?.state || ''),
      empty_reason: String(ins?.marker?.recall?.empty_reason || ''),
      dry_streak: Number(ins?.marker?.recall?.dry_streak ?? 0),
      injected_total_tok: Number(ins?.totals?.tokens_injected ?? 0),
      injected_sources: Number(ins?.totals?.sources_injected ?? 0),
      prompts_with_injection: Number(ins?.totals?.prompts_with_injection ?? 0),
      spool_pending: Number(ins?.spool_pending ?? 0),
      // Non-empty on a control arm means the ambient install leaked past `--settings` and
      // the whole sweep is void. `test/negative.test.mjs` asserts it is empty.
      data_dir_entries: safeLs(dataDir),
    },

    session_id: init.sessionId,
    resolved_model: init.model,
    run_id: runId,
    reply_chars: assistantText.length,
    stderr: run.stderr ? run.stderr.slice(-500) : '',
  };
}

/** @param {string} dir @returns {string[]} */
function safeLs(dir) {
  try { return readdirSync(dir).sort(); } catch { return []; }
}

/**
 * Run one (arm, case, rep) cell end to end.
 *
 * @param {object} o
 * @param {string} o.arm @param {{id: string, text: string}} o.prompt @param {number} o.rep
 * @param {string} o.pluginDir @param {string} o.pluginName @param {string} o.model
 * @param {string} o.cwd @param {string} o.rawDir @param {string[]} o.ambient
 * @param {string} o.sweepId @param {Record<string,string>} [o.extraEnv] @param {number} [o.timeoutMs]
 * @returns {Promise<any>}
 */
export async function runCell(o) {
  const runId = `tk-${o.sweepId}-${o.arm}-${o.prompt.id}-${o.rep}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 96);
  const dataDir = join(o.rawDir, 'data', o.arm, o.prompt.id, String(o.rep));
  const debugFile = join(o.rawDir, 'debug', `${o.arm}-${o.prompt.id}-${o.rep}.log`);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(o.rawDir, 'debug'), { recursive: true });

  const { argv, env } = buildRun({
    arm: o.arm,
    pluginDir: o.pluginDir,
    prompt: o.prompt.text,
    model: o.model,
    dataDir,
    runId,
    debugFile,
    ambient: o.ambient,
    extraEnv: o.extraEnv,
  });

  const run = await runClaude({ argv, env, cwd: o.cwd, timeoutMs: o.timeoutMs ?? 600_000 });
  const trial = toTrial({
    arm: o.arm,
    caseId: o.prompt.id,
    rep: o.rep,
    pluginName: o.pluginName,
    pluginDir: o.pluginDir,
    dataDir,
    runId,
    debugFile,
    run,
  });
  trial.argv_hint = argv.filter((a) => a !== o.prompt.text);
  return trial;
}
