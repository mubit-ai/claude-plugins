// @ts-check
/**
 * Responsiveness, from the four places the plugin already writes it.
 *
 * The sources are not interchangeable and the report never blends them:
 *
 *   - **`--debug-file`** is the only place the *per-prompt* recall series survives. The
 *     marker at `status/<run>.json` is last-write-wins, so it holds one sample, not a
 *     distribution.
 *   - **The ring log** (`<dataDir>/logs/mubit-cc.log`) records a hook's elapsed time **only
 *     when it overran its budget** (`lib/hook.mjs` warns on overrun and is otherwise
 *     silent). Reading it as "hook latency" is survivorship bias by construction: it is a
 *     tail detector, and the kit labels it as one.
 *   - **Transcripts** (`~/.claude/projects/**.jsonl`) carry `stop_hook_summary.hookInfos`
 *     with a real `durationMs` per hook command. Exact, free, and retroactive — but the
 *     only subtype that carries it, so this covers Stop and nothing else.
 *   - **`bin/statusline.mjs`** is timed directly, because it runs on every render and its
 *     budget is 15 ms.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * The budgets each hook is registered with, in milliseconds. Read from the plugin under
 * test rather than hardcoded — a version that widens a budget must not be graded against
 * the old one.
 *
 * @param {string} pluginDir
 * @returns {Record<string, number>} event → the largest timeout registered for it, in ms
 */
export function hookBudgets(pluginDir) {
  /** @type {Record<string, number>} */
  const out = {};
  const p = join(pluginDir, 'hooks', 'hooks.json');
  if (!existsSync(p)) return out;
  const j = JSON.parse(readFileSync(p, 'utf8'));
  for (const [event, groups] of Object.entries(j.hooks || {})) {
    for (const g of /** @type {any[]} */ (groups)) {
      for (const h of g.hooks || []) {
        const ms = Number(h.timeout || 0) * 1000;
        if (ms > (out[event] || 0)) out[event] = ms;
      }
    }
  }
  return out;
}

/**
 * Expand the `tok` field of the status line.
 *
 * `formatTokens` renders anything >= 1000 as `1.2k`, so the obvious
 * `grep -ao 'mubit: [0-9][^"\\]*'` recipe truncates every interesting sample down to one
 * decimal place and a naive `parseInt` turns 1.2k into 1. This is the single parsing bug
 * most likely to make the latency table quietly wrong.
 *
 * @param {string} raw @returns {number}
 */
export function parseTokens(raw) {
  const s = String(raw).trim();
  const m = s.match(/^([\d.]+)k$/i);
  if (m) return Math.round(parseFloat(m[1]) * 1000);
  return Math.round(parseFloat(s) || 0);
}

/** The status line the recall hook emits, verbatim from `hooks/src/prompt-recall.mjs`. */
const RECALL_RE = /mubit: (\d+) memor(?:y|ies) · ([\d.]+k?) tok · (\d+)ms/g;

/**
 * Mine one `--debug-file` for everything it knows about responsiveness.
 *
 * @param {string} file
 * @returns {{recall: {sources: number, tokens: number, ms: number}[], mcpBootMs: number[], firstByteMs: number[], hookSpans: {event: string, ms: number}[]}}
 */
export function parseDebugLog(file) {
  const empty = { recall: [], mcpBootMs: [], firstByteMs: [], hookSpans: [] };
  if (!existsSync(file)) return empty;
  const text = readFileSync(file, 'utf8');

  /** @type {{sources: number, tokens: number, ms: number}[]} */
  const recall = [];
  for (const m of text.matchAll(RECALL_RE)) {
    recall.push({ sources: Number(m[1]), tokens: parseTokens(m[2]), ms: Number(m[3]) });
  }

  const mcpBootMs = [...text.matchAll(/MCP server "[^"]*mubit[^"]*": Successfully connected \(transport: \w+\) in (\d+)ms/g)]
    .map((m) => Number(m[1]));
  const firstByteMs = [...text.matchAll(/first byte after (\d+)ms/g)].map((m) => Number(m[1]));

  return { recall, mcpBootMs, firstByteMs, hookSpans: [] };
}

/**
 * Overruns and drain wall time from the plugin's own ring log.
 *
 * Both rotations are read: `mubit-cc.log` and `.log.1`. A run long enough to rotate is
 * exactly the run whose tail you care about.
 *
 * @param {string} dataDir
 * @returns {{overruns: {hook: string, budgetMs: number, elapsedMs: number}[], drainMs: number[], errors: string[]}}
 */
export function parseRingLog(dataDir) {
  /** @type {{hook: string, budgetMs: number, elapsedMs: number}[]} */
  const overruns = [];
  /** @type {number[]} */
  const drainMs = [];
  /** @type {string[]} */
  const errors = [];

  for (const name of ['mubit-cc.log.1', 'mubit-cc.log']) {
    const p = join(dataDir, 'logs', name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.level === 'warn' && r.budget_ms != null && r.elapsed_ms != null) {
        overruns.push({ hook: String(r.hook || '?'), budgetMs: Number(r.budget_ms), elapsedMs: Number(r.elapsed_ms) });
      }
      if (typeof r.msg === 'string' && /^drain: \d+ item\(s\) in \d+ batch\(es\)$/.test(r.msg) && r.ms != null) {
        drainMs.push(Number(r.ms));
      }
      if (r.level === 'error') errors.push(String(r.msg || '').slice(0, 160));
    }
  }
  return { overruns, drainMs, errors };
}

/**
 * Stop-hook wall time from host transcripts.
 *
 * Free and retroactive: every session ever run already recorded it. `stop_hook_summary` is
 * the only subtype carrying `hookInfos`, so this is a Stop-only distribution — which is
 * why it complements, rather than replaces, the debug-log numbers.
 *
 * @param {object} [o]
 * @param {string} [o.root] default `~/.claude/projects`
 * @param {string} [o.match] substring a hook command must contain
 * @param {number} [o.sinceMs] epoch ms; only transcripts modified after this are read
 * @param {number} [o.limit] most-recent-first cap on transcripts scanned
 * @returns {{command: string, ms: number, file: string}[]}
 */
export function parseTranscripts({ root, match = 'hooks/dist/', sinceMs = 0, limit = 400 } = {}) {
  const base = root || join(homedir(), '.claude', 'projects');
  if (!existsSync(base)) return [];

  /** @type {{p: string, mtime: number}[]} */
  const files = [];
  for (const slug of readdirSync(base)) {
    const dir = join(base, slug);
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(dir, f);
      try {
        const st = statSync(p);
        if (st.mtimeMs >= sinceMs) files.push({ p, mtime: st.mtimeMs });
      } catch { /* raced with a rotation */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  /** @type {{command: string, ms: number, file: string}[]} */
  const out = [];
  for (const { p } of files.slice(0, limit)) {
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    if (!text.includes('stop_hook_summary')) continue;
    for (const line of text.split('\n')) {
      if (!line.includes('stop_hook_summary')) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      for (const h of r?.hookInfos || []) {
        const command = String(h.command || '');
        if (match && !command.includes(match)) continue;
        if (!Number.isFinite(Number(h.durationMs))) continue;
        out.push({ command, ms: Number(h.durationMs), file: p });
      }
    }
  }
  return out;
}

/**
 * Time `bin/statusline.mjs` end to end, the way the host calls it.
 *
 * Its budget is 15 ms and it runs on every render, so it is the one surface where a
 * regression is felt continuously rather than once per prompt.
 *
 * @param {string} pluginDir @param {object} o @param {string} o.dataDir @param {number} [o.reps]
 * @returns {{ms: number[], ok: boolean, note: string}}
 */
export function timeStatusline(pluginDir, { dataDir, reps = 20 }) {
  const script = join(pluginDir, 'bin', 'statusline.mjs');
  if (!existsSync(script)) return { ms: [], ok: false, note: 'bin/statusline.mjs not present in this version' };

  const payload = JSON.stringify({
    session_id: 'testkit-statusline',
    cwd: process.cwd(),
    model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet' },
    workspace: { current_dir: process.cwd(), project_dir: process.cwd() },
  });

  /** @type {number[]} */
  const ms = [];
  let note = '';
  for (let i = 0; i < reps; i += 1) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [script], {
      input: payload,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, MUBIT_CC_DATA_DIR: dataDir },
    });
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    if (r.error) { note = String(r.error.message); break; }
    ms.push(dt);
  }
  // Node's own startup is ~25 ms and is not the plugin's fault; the report says so rather
  // than pretending the 15 ms budget applies to a cold process.
  return { ms, ok: ms.length > 0, note: note || 'includes ~25ms node startup' };
}

/** @param {string} pluginDir @returns {boolean} */
export function hasInspect(pluginDir) {
  return existsSync(join(pluginDir, 'scripts', 'mubit-inspect.mjs'));
}

/**
 * `scripts/mubit-inspect.mjs --json` from the plugin under test, so the reader is always
 * version-matched to the state it is reading.
 *
 * @param {string} pluginDir @param {object} o @param {string} o.dataDir @param {string} [o.runId]
 * @returns {any|null}
 */
export function inspect(pluginDir, { dataDir, runId }) {
  if (!hasInspect(pluginDir)) return null;
  const args = [join(pluginDir, 'scripts', 'mubit-inspect.mjs'), '--data', dataDir, '--json', '--last', '200'];
  if (runId) args.push('--run', runId);
  try {
    const out = execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out);
  } catch {
    return null;
  }
}
