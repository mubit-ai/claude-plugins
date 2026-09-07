#!/usr/bin/env node
// @ts-check
/**
 * Measure what the plugin actually put in front of the model, from the transcripts on this
 * machine.
 *
 * `measure-context-cost.mjs` measures the always-loaded surface: what a session pays before
 * the model does anything. This measures the other half — what the hooks injected and what
 * the MCP tools answered, per event and per session — which is where the cost that grows with
 * a session lives. The two numbers answer different questions and neither stands in for the
 * other: over fourteen days of real sessions the static surface came to ~1.5k tokens a session
 * under tool search, while a single tool result reached ~12k.
 *
 *   node scripts/measure-context-usage.mjs                 # last 14 days, ~/.claude/projects
 *   node scripts/measure-context-usage.mjs --days 30
 *   node scripts/measure-context-usage.mjs --projects <dir>  # another transcript root
 *   node scripts/measure-context-usage.mjs --json
 *
 * **What is counted.** Claude Code stores a hook's `additionalContext` in the transcript as an
 * attachment line, and it stays in history until the next compaction — so an injection is
 * paid on the turn it lands and again on every turn after it. Each attachment whose text
 * mentions Mubit is attributed to the hook that produced it (the attachment names it), and
 * every result of a `mubit_*` tool call is attributed to its tool. The estimate is the
 * plugin's own (`lib/assemble.mjs`), so the numbers here compare with the budgets in the
 * manifest rather than with a tokenizer.
 *
 * **What is printed.** Counts and sizes, never content. No path below the transcript root is
 * printed either: a project directory name is a project directory name.
 *
 * Zero dependencies, Node >= 20, read-only.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { estimateTokens } from '../lib/assemble.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DAYS = 14;
const TOOL_PREFIX = 'mcp__plugin_mubit-memory_mubit__';

/** The attachment types that carry the always-loaded listings. Counted, not sized: `measure-context-cost.mjs` sizes them. */
const LISTING_TYPES = new Set(['skill_listing', 'mcp_instructions_delta', 'deferred_tools_delta', 'agent_listing_delta']);

/**
 * What the plugin's own hooks put at the head of what they emit. Another hook's output that
 * merely talks about Mubit — a session working on this very plugin produces plenty — carries
 * none of these and is not ours to count.
 */
const MARKERS = ['<mubit-memory ', '<mubit-resume ', '<mubit-rules ', '# Mubit memory'];

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{days: number, projects: string, json: boolean, help: boolean, error: string}}
 */
export function parseArgs(argv = []) {
  const out = { days: DEFAULT_DAYS, projects: join(homedir(), '.claude', 'projects'), json: false, help: false, error: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--days' || a === '--projects') {
      const v = argv[i + 1];
      if (v === undefined) { out.error = `${a} needs a value`; return out; }
      i += 1;
      if (a === '--days') {
        out.days = Number(v);
        if (!Number.isInteger(out.days) || out.days < 1) { out.error = '--days must be a whole number of days'; return out; }
      } else {
        out.projects = resolve(String(v));
      }
    } else { out.error = `unknown option ${a}`; return out; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Series
 * @property {number} count
 * @property {number} total
 * @property {number[]} sizes
 */

/**
 * @typedef {object} FileStats
 * @property {boolean} subagent
 * @property {number} prompts
 * @property {boolean} loaded         a Mubit listing attachment appeared — the plugin was on
 * @property {Record<string, number[]>} injected   tokens per fire, by source
 * @property {Record<string, number[]>} tools    result sizes by tool
 */

/**
 * Attribute one transcript. Pure: takes the file's text, returns what the plugin cost in it.
 *
 * @param {string} text
 * @param {{subagent?: boolean}} [opts]
 * @returns {FileStats}
 */
export function analyseTranscript(text, opts = {}) {
  /** @type {FileStats} */
  const s = { subagent: opts.subagent === true, prompts: 0, loaded: false, injected: {}, tools: {} };
  /** @type {Map<string, string>} */
  const pending = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue;
    /** @type {any} */
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object') continue;

    if (o.type === 'assistant') {
      for (const b of blocks(o)) {
        if (b.type === 'tool_use' && typeof b.name === 'string' && b.name.startsWith(TOOL_PREFIX)) {
          pending.set(String(b.id), b.name.slice(TOOL_PREFIX.length));
        }
      }
      continue;
    }

    if (o.type === 'user') {
      const c = o.message?.content;
      const list = Array.isArray(c) ? c : [];
      const hasResult = list.some((b) => b && b.type === 'tool_result');
      const hasText = typeof c === 'string' || list.some((b) => b && b.type === 'text');
      if (hasText && !hasResult && o.isMeta !== true) s.prompts += 1;
      for (const b of list) {
        if (!b || b.type !== 'tool_result' || !pending.has(String(b.tool_use_id))) continue;
        const name = pending.get(String(b.tool_use_id)) ?? '';
        pending.delete(String(b.tool_use_id));
        const body = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n')
            : JSON.stringify(b.content ?? '');
        (s.tools[name] ??= []).push(estimateTokens(body));
      }
      continue;
    }

    if (o.type !== 'attachment' || !o.attachment || typeof o.attachment !== 'object') continue;
    const a = o.attachment;
    if (LISTING_TYPES.has(String(a.type))) {
      if (/mubit/i.test(JSON.stringify(a))) s.loaded = true;
      continue;
    }
    if (a.type !== 'hook_additional_context') continue;
    const content = Array.isArray(a.content) ? a.content.map(String).join('\n') : String(a.content ?? '');
    if (!MARKERS.some((m) => content.includes(m))) continue;
    const event = String(a.hookEvent ?? a.hookName ?? '');
    for (const part of split(content)) {
      const source = sourceOf(event, part, s.subagent);
      (s.injected[source] ??= []).push(estimateTokens(part));
    }
  }
  return s;
}

/**
 * The first prompt of a resumed session carries the briefing and that turn's recall in one
 * output, the briefing above the `<mubit-memory>` envelope. They are two costs with two
 * dials, so they are counted apart.
 * @param {string} content
 * @returns {string[]}
 */
function split(content) {
  const at = content.indexOf('<mubit-memory ');
  if (at <= 0 || !content.includes('<mubit-resume ')) return [content];
  return [content.slice(0, at), content.slice(at)];
}

/**
 * Which of the plugin's injections this is. The hook event is the primary key; the markers
 * the hooks themselves emit split one event's several outputs.
 * @param {string} event
 * @param {string} content
 * @param {boolean} subagent
 */
function sourceOf(event, content, subagent) {
  const ev = event.split(':')[0];
  if (ev === 'SessionStart') {
    return /# Mubit memory is active/.test(content) ? 'SessionStart steer block' : 'SessionStart notice (unconfigured, offline, auth)';
  }
  if (ev === 'UserPromptSubmit') {
    if (/<mubit-resume /.test(content)) return 'UserPromptSubmit resume briefing';
    if (/<mubit-memory [^>]*sources="0"/.test(content)) return 'UserPromptSubmit pins only';
    return 'UserPromptSubmit recall';
  }
  if (ev === 'SubagentStart' || subagent) return 'SubagentStart recall';
  if (ev === 'PreToolUse') return 'PreToolUse warning';
  return ev ? `${ev} (other)` : 'unknown hook';
}

/** @param {any} o */
function blocks(o) {
  const c = o?.message?.content;
  return Array.isArray(c) ? c.filter((b) => b && typeof b === 'object') : [];
}

/**
 * Every `.jsonl` under `root` modified since `sinceMs`, with whether it is a subagent transcript.
 * @param {string} root
 * @param {number} sinceMs
 * @returns {Array<{path: string, subagent: boolean}>}
 */
export function listTranscripts(root, sinceMs) {
  /** @type {Array<{path: string, subagent: boolean}>} */
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { if (statSync(p).mtimeMs >= sinceMs) out.push({ path: p, subagent: p.includes(`${'/'}subagents${'/'}`) }); } catch { /* raced */ }
      }
    }
  };
  walk(root);
  return out;
}

/**
 * @typedef {object} Report
 * @property {number} days
 * @property {number} files
 * @property {number} sessions          main transcripts with at least one prompt
 * @property {number} loadedSessions    of those, with the plugin's listings present
 * @property {number} prompts
 * @property {Record<string, Series>} injected
 * @property {Record<string, Series>} tools
 * @property {number[]} perSession      tokens of everything above, per main session
 * @property {{value: number, measuredAt: string}|null} declared   scripts/context-cost.json
 */

/**
 * @param {string} root
 * @param {{days?: number, now?: number}} [opts]
 * @returns {Report}
 */
export function measure(root, opts = {}) {
  const days = opts.days ?? DEFAULT_DAYS;
  const now = opts.now ?? Date.now();
  const files = listTranscripts(root, now - days * 86_400_000);
  /** @type {Report} */
  const r = { days, files: files.length, sessions: 0, loadedSessions: 0, prompts: 0, injected: {}, tools: {}, perSession: [], declared: declared() };
  const add = (table, key, n) => {
    const s = table[key] ??= { count: 0, total: 0, sizes: [] };
    s.count += 1; s.total += n; s.sizes.push(n);
  };
  for (const f of files) {
    let text;
    try { text = readFileSync(f.path, 'utf8'); } catch { continue; }
    const s = analyseTranscript(text, { subagent: f.subagent });
    let session = 0;
    for (const [k, sizes] of Object.entries(s.injected)) for (const n of sizes) { add(r.injected, k, n); session += n; }
    for (const [name, sizes] of Object.entries(s.tools)) for (const n of sizes) { add(r.tools, name, n); session += n; }
    if (!f.subagent && s.prompts > 0) {
      r.sessions += 1;
      r.prompts += s.prompts;
      if (s.loaded) r.loadedSessions += 1;
      r.perSession.push(session);
    }
  }
  return r;
}

function declared() {
  try {
    const stamp = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'scripts', 'context-cost.json'), 'utf8'));
    return { value: Number(stamp.value) || 0, measuredAt: String(stamp.measuredAt ?? '') };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** @param {number[]} a @param {number} p */
function pct(a, p) {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.floor(p * b.length))];
}

/** @param {Report} r */
export function render(r) {
  const n = (v) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const lines = [];
  lines.push(`Mubit context usage — last ${r.days} days: ${n(r.sessions)} sessions (${n(r.loadedSessions)} with the plugin loaded), ${n(r.prompts)} prompts, ${n(r.files)} transcripts`);
  lines.push('');
  if (r.declared) {
    lines.push(`Always-loaded, per session: ${n(r.declared.value)} tokens declared (scripts/context-cost.json, ${r.declared.measuredAt.slice(0, 10)}); tool schemas are deferred under tool search.`);
    lines.push('');
  }
  const table = (title, unit, rows) => {
    lines.push(`${title.padEnd(48)} ${unit.padStart(6)} ${'p50'.padStart(7)} ${'p90'.padStart(7)} ${'max'.padStart(7)} ${'total'.padStart(9)}`);
    for (const [k, s] of rows) {
      lines.push(`  ${k.padEnd(46)} ${n(s.count).padStart(6)} ${n(pct(s.sizes, 0.5)).padStart(7)} ${n(pct(s.sizes, 0.9)).padStart(7)} ${n(pct(s.sizes, 1)).padStart(7)} ${n(s.total).padStart(9)}`);
    }
    if (!rows.length) lines.push('  (none)');
    lines.push('');
  };
  const byTotal = (t) => Object.entries(t).sort((a, b) => b[1].total - a[1].total);
  table('Injected by hooks (tokens)', 'fires', byTotal(r.injected));
  table('MCP tool results (tokens)', 'calls', byTotal(r.tools));
  const injectedTotal = Object.values(r.injected).reduce((a, s) => a + s.total, 0);
  const toolTotal = Object.values(r.tools).reduce((a, s) => a + s.total, 0);
  lines.push(`Per main session, everything above: p50 ${n(pct(r.perSession, 0.5))}, p90 ${n(pct(r.perSession, 0.9))}, max ${n(pct(r.perSession, 1))} tokens; ${n(injectedTotal)} injected and ${n(toolTotal)} in tool results over the period.`);
  lines.push('An injection stays in history until the next compaction, so each is paid again on every later turn.');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * @param {string[]} [argv]
 * @param {{stdout?: (s: string) => void, stderr?: (s: string) => void}} [deps]
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  const args = parseArgs(argv);
  const usage = 'usage: measure-context-usage [--days N] [--projects <dir>] [--json]\n';
  if (args.error) { stderr(`${args.error}\n${usage}`); return 2; }
  if (args.help) { stdout(usage); return 0; }
  const r = measure(args.projects, { days: args.days });
  if (args.json) {
    const strip = (t) => Object.fromEntries(Object.entries(t).map(([k, s]) => [k, { count: s.count, total: s.total, p50: pct(s.sizes, 0.5), p90: pct(s.sizes, 0.9), max: pct(s.sizes, 1) }]));
    stdout(`${JSON.stringify({ ...r, injected: strip(r.injected), tools: strip(r.tools), perSession: { p50: pct(r.perSession, 0.5), p90: pct(r.perSession, 0.9), max: pct(r.perSession, 1) } }, null, 2)}\n`);
  } else {
    stdout(render(r));
  }
  return 0;
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === selfPath) {
  process.exitCode = await main().catch((err) => {
    process.stderr.write(`measure-context-usage: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  });
}
