#!/usr/bin/env node
// @ts-check
/**
 * `bin/admin.src.mjs` — the memory administration commands: the lesson catalogue, a delete,
 * a named checkpoint, the pattern across lessons, and an explicit reflect.
 *
 *   node bin/admin.mjs lessons    [--scope run|session|global] [--importance <level>] [--limit N]
 *   node bin/admin.mjs forget     <lesson_id>
 *   node bin/admin.mjs checkpoint --label <name> (--file <path> | --snapshot <text> | stdin)
 *   node bin/admin.mjs strategies [--max N] [--types a,b]
 *   node bin/admin.mjs reflect
 *
 * Every command takes `--run <id>` and `--json`.
 *
 * **Why a script and not five MCP tools.** Each of these was an MCP tool until the surface
 * was cut to seven. A registered tool is paid for on every session before the model does
 * anything — its name under Claude Code, its whole schema under Codex — and none of the five
 * answers a question the model is holding mid-task: they are things a person asks for, at
 * most a few times in a session, and each already had a skill as its only real entry point.
 * A skill that runs a script costs nothing until it is invoked. The tools are not gone;
 * `mcpTools` restores any of them by name.
 *
 * **What it prints.** The same compact form a tool result takes (`mcp/src/results.mjs`): one
 * line per lesson, the id on the line, a lesson this run has already been shown degraded to
 * the injection's own pointer, and the whole thing held under `mcpResultTokenBudget`. What the
 * model reads here and what it reads from `mubit_recall` are one rendering. `--json` is the
 * raw reply, for a person or a script, and is never capped.
 *
 * **What it dials.** Only routes the plugin already speaks: the activity feed for the
 * catalogue (the same census the dashboard uses, because the lessons route filters after its
 * limit), and the delete, checkpoint, strategies and reflect routes the hooks and the
 * dashboard already call. Nothing here is a capability the plugin did not have.
 *
 * No launcher, for the same reason `pin` has none: a person typed this and is watching.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lessonCensus } from '../lib/activity.mjs';
import { estimateTokens } from '../lib/assemble.mjs';
import { loadConfig } from '../lib/config.mjs';
import { deleteLesson } from '../lib/dashboard-api.mjs';
import { postCheckpoint, request, ROUTES } from '../lib/http.mjs';
import { pickRun } from '../lib/runpick.mjs';
import { markSeen, readSeen } from '../lib/seen.mjs';
import { selectLessons, SHOWING, wireLesson } from '../mcp/src/egress.mjs';
import { DEFAULT_RESULT_TOKENS, renderCompact } from '../mcp/src/results.mjs';

const COMMANDS = ['lessons', 'forget', 'checkpoint', 'strategies', 'reflect'];
const SCOPES = ['run', 'session', 'global'];
const IMPORTANCE = ['low', 'medium', 'high', 'critical'];

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;
const DEFAULT_MAX_STRATEGIES = 5;
const MAX_STRATEGIES = 50;
/** The same bound the SessionEnd reflect uses: the tail of the run, of every kind. */
const REFLECT_LAST_N = 200;
/** Reflect and strategies are LLM-backed and dial wide; a checkpoint carries a snapshot. */
const SLOW_MS = 25_000;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

const USAGE = `usage: admin <command> [options]

  lessons     [--scope run|session|global] [--importance low|medium|high|critical] [--limit N]
  forget      <lesson_id>
  checkpoint  --label <name> (--file <path> | --snapshot <text> | snapshot on stdin)
  strategies  [--max N] [--types type,type]
  reflect

  --run <id>   the run to act on; the default is the run this session's hooks are writing to
  --json       the raw reply, uncapped
`;

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

const VALUED = new Set(['--run', '--scope', '--importance', '--limit', '--label', '--file',
  '--snapshot', '--max', '--types']);
const FLAGS = new Set(['--json', '--help', '-h']);

/**
 * @param {string[]} argv
 * @returns {Record<string, any>}
 */
export function parseArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.map((a) => String(a ?? '')) : [];
  /** @type {Record<string, any>} */
  const out = {
    command: '', run: '', json: false, help: false, scope: '', importance: '',
    limit: DEFAULT_LIMIT, id: '', label: '', file: '', snapshot: '', max: DEFAULT_MAX_STRATEGIES,
    types: [], error: '',
  };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (FLAGS.has(a)) {
      if (a === '--json') out.json = true;
      else out.help = true;
      continue;
    }
    if (VALUED.has(a)) {
      const v = args[i + 1];
      if (v === undefined) { out.error = `${a} needs a value`; return out; }
      i += 1;
      if (a === '--run') out.run = v.trim();
      else if (a === '--scope') out.scope = v.trim();
      else if (a === '--importance') out.importance = v.trim();
      else if (a === '--limit') out.limit = Number(v);
      else if (a === '--label') out.label = v.trim();
      else if (a === '--file') out.file = v.trim();
      else if (a === '--snapshot') out.snapshot = v;
      else if (a === '--max') out.max = Number(v);
      else if (a === '--types') out.types = v.split(',').map((t) => t.trim()).filter(Boolean);
      continue;
    }
    if (a.startsWith('-')) { out.error = `unknown option ${a}`; return out; }
    positional.push(a);
  }
  if (out.help) return out;
  out.command = positional.shift() ?? '';
  if (!out.command) { out.error = 'no command given'; return out; }
  if (!COMMANDS.includes(out.command)) { out.error = `unknown command "${out.command}"`; return out; }
  if (out.command === 'forget') {
    out.id = positional.shift() ?? '';
    if (!out.id) { out.error = 'forget needs a lesson id'; return out; }
  }
  if (positional.length) { out.error = `unexpected argument "${positional[0]}"`; return out; }
  if (out.scope && !SCOPES.includes(out.scope)) { out.error = `--scope must be one of ${SCOPES.join(', ')}`; return out; }
  if (out.importance && !IMPORTANCE.includes(out.importance)) {
    out.error = `--importance must be one of ${IMPORTANCE.join(', ')}`; return out;
  }
  if (!Number.isInteger(out.limit) || out.limit < 1 || out.limit > MAX_LIMIT) {
    out.error = `--limit must be a whole number from 1 to ${MAX_LIMIT}`; return out;
  }
  if (!Number.isInteger(out.max) || out.max < 1 || out.max > MAX_STRATEGIES) {
    out.error = `--max must be a whole number from 1 to ${MAX_STRATEGIES}`; return out;
  }
  if (out.command === 'checkpoint' && !out.label) { out.error = 'checkpoint needs --label'; return out; }
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * @param {string[]} [argv]
 * @param {Record<string, string|undefined>} [env]
 * @param {{stdout?: (s: string) => void, stderr?: (s: string) => void,
 *          stdin?: () => string}} [deps]
 * @returns {Promise<number>}  the exit code
 */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  const args = parseArgs(argv);
  if (args.error) { stderr(`${args.error}\n\n${USAGE}`); return 2; }
  if (args.help) { stdout(USAGE); return 0; }

  let cfg;
  try { cfg = loadConfig(env); } catch (err) { stderr(`could not resolve configuration: ${messageOf(err)}\n`); return 1; }

  const pick = pickRun(cfg, args.run, { command: `admin ${args.command}` });
  if (!pick.ok) { stderr(`${pick.detail}\n`); return 1; }
  const runId = pick.runId;
  const ctx = { cfg, runId, args, stdout, stderr, stdin: deps.stdin ?? readStdin };

  try {
    switch (args.command) {
      case 'lessons': return await doLessons(ctx);
      case 'forget': return await doForget(ctx);
      case 'checkpoint': return await doCheckpoint(ctx);
      case 'strategies': return await doStrategies(ctx);
      case 'reflect': return await doReflect(ctx);
      default: return 2;
    }
  } catch (err) {
    stderr(`admin ${args.command} failed: ${messageOf(err)}\n`);
    return 1;
  }
}

/** @typedef {{cfg: any, runId: string, args: Record<string, any>, stdout: (s: string) => void,
 *             stderr: (s: string) => void, stdin: () => string}} Ctx */

// ---------------------------------------------------------------------------
// lessons
// ---------------------------------------------------------------------------

/** @param {Ctx} c */
async function doLessons(c) {
  const { cfg, runId, args } = c;
  // Every run, then filter: the lessons route applies its scope filter after its limit, and
  // a global lesson written by another run could then structurally never appear.
  const res = await lessonCensus(cfg, { run: '', currentRun: runId });
  if (!res.ok) return failed(c, 'could not read the catalogue', res);
  const scope = args.scope;
  let rows = selectLessons(res.data.lessons, { runId, scope });
  if (args.importance) rows = rows.filter((r) => r.importance === args.importance);
  const shown = rows.slice(0, args.limit);
  const payload = {
    run_id: runId,
    showing: SHOWING[scope] ?? SHOWING[''],
    matched: rows.length,
    ...(res.data.truncated ? { partial: true, note: 'The listing was cut short, so these are some of the lessons that matched and not all of them.' } : {}),
    lessons: shown.map(wireLesson),
  };
  if (args.json) { c.stdout(`${JSON.stringify(payload, null, 2)}\n`); return 0; }
  if (!shown.length) {
    c.stdout(`run_id: ${runId}\nshowing: ${payload.showing}\nNo lessons matched.\n`);
    return 0;
  }
  const compact = renderCompact(payload, 'lessons', { budget: budgetOf(cfg), seen: readSeen(cfg, runId).ids });
  if (!compact) { c.stdout(`${JSON.stringify(payload, null, 2)}\n`); return 0; }
  const lines = [compact.text];
  if (compact.dropped > 0) lines.push(`Showing ${compact.total - compact.dropped} of ${compact.total}; --limit and --scope narrow it, --json is the whole listing.`);
  if (compact.pointed.length) lines.push(pointerNote());
  c.stdout(`${lines.join('\n')}\n`);
  markSeen(cfg, runId, [...compact.shown, ...compact.pointed]);
  return 0;
}

// ---------------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------------

/** @param {Ctx} c */
async function doForget(c) {
  const { cfg, args } = c;
  // The dashboard's own delete, which insists the id be repeated as `confirm`: one argument
  // is the difference between this and the whole-run delete the route also offers.
  const res = await deleteLesson(cfg, { lessonId: args.id, confirm: args.id });
  if (!res.ok) return failed(c, `could not delete lesson ${args.id}`, res);
  if (args.json) { c.stdout(`${JSON.stringify(res.data ?? {}, null, 2)}\n`); return 0; }
  c.stdout(`Deleted lesson ${args.id}. This cannot be undone.\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// checkpoint
// ---------------------------------------------------------------------------

/** @param {Ctx} c */
async function doCheckpoint(c) {
  const { cfg, runId, args } = c;
  let snapshot = '';
  if (args.file) {
    try { snapshot = readFileSync(args.file, 'utf8'); } catch (err) {
      c.stderr(`could not read ${args.file}: ${messageOf(err)}\n`); return 1;
    }
  } else if (args.snapshot) {
    snapshot = args.snapshot;
  } else {
    snapshot = c.stdin();
  }
  if (!snapshot.trim()) {
    c.stderr('checkpoint needs a snapshot: --file <path>, --snapshot <text>, or text on stdin\n');
    return 2;
  }
  if (Buffer.byteLength(snapshot, 'utf8') > MAX_SNAPSHOT_BYTES) {
    c.stderr(`the snapshot is over ${MAX_SNAPSHOT_BYTES} bytes; a checkpoint is a briefing, not a transcript\n`);
    return 2;
  }
  const res = await postCheckpoint(cfg, {
    run_id: runId,
    label: args.label,
    context_snapshot: snapshot,
    metadata_json: JSON.stringify({ source: 'admin', label: args.label, snapshot_bytes: Buffer.byteLength(snapshot, 'utf8') }),
  }, { record: false, timeoutMs: SLOW_MS });
  if (!res.ok) return failed(c, 'could not save the checkpoint', res);
  const body = isObject(res.body) ? res.body : {};
  if (args.json) { c.stdout(`${JSON.stringify(body, null, 2)}\n`); return 0; }
  const tokens = Number.isFinite(Number(body.token_estimate)) ? ` (~${body.token_estimate} tokens)` : '';
  c.stdout(`Checkpoint ${str(body.checkpoint_id) || '(no id returned)'} saved for run ${runId}, labelled "${args.label}"${tokens}.\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// strategies
// ---------------------------------------------------------------------------

/** @param {Ctx} c */
async function doStrategies(c) {
  const { cfg, runId, args } = c;
  const body = { run_id: runId, max_strategies: args.max, ...(args.types.length ? { lesson_types: args.types } : {}) };
  const res = await request(cfg, 'POST', ROUTES.strategies, body, { record: false, timeoutMs: SLOW_MS });
  if (!res.ok) return failed(c, 'could not surface strategies', res);
  const reply = isObject(res.body) ? res.body : {};
  if (args.json) { c.stdout(`${JSON.stringify(reply, null, 2)}\n`); return 0; }
  const list = Array.isArray(reply.strategies) ? reply.strategies.filter(isObject) : [];
  if (!list.length) { c.stdout(`run_id: ${runId}\nNo strategies: clustering needs a body of lessons to cluster, and this run may not have one yet.\n`); return 0; }
  const lines = [`run_id: ${runId}`, `Strategies (${list.length}):`];
  let used = estimateTokens(lines.join('\n'));
  let rendered = 0;
  for (const s of list) {
    const tag = [str(s.dominant_lesson_type), str(s.dominant_scope)].filter(Boolean).join(', ');
    const ids = Array.isArray(s.lesson_ids) ? s.lesson_ids.map(String) : [];
    const from = ids.length ? ` (from ${ids.length} lessons: ${ids.join(', ')})` : '';
    const line = `- ${tag ? `[${tag}] ` : ''}${str(s.strategy_id)} — ${oneLine(s.description)}${from}`;
    const cost = estimateTokens(`${line}\n`);
    if (used + cost > budgetOf(cfg)) break;
    lines.push(line);
    used += cost;
    rendered += 1;
  }
  if (rendered < list.length) lines.push(`Showing ${rendered} of ${list.length}; --json is the whole reply.`);
  lines.push('A strategy is inferred from a cluster of lessons, not written by anyone; say so when relaying it.');
  c.stdout(`${lines.join('\n')}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// reflect
// ---------------------------------------------------------------------------

/** @param {Ctx} c */
async function doReflect(c) {
  const { cfg, runId, args } = c;
  const body = { run_id: runId, include_linked_runs: false, include_step_outcomes: true, last_n_items: REFLECT_LAST_N };
  const res = await request(cfg, 'POST', ROUTES.reflect, body, { record: false, timeoutMs: SLOW_MS });
  if (!res.ok) return failed(c, 'reflect failed', res);
  const reply = isObject(res.body) ? res.body : {};
  if (args.json) { c.stdout(`${JSON.stringify(reply, null, 2)}\n`); return 0; }
  const compact = renderCompact(reply, 'lessons', { budget: budgetOf(cfg), seen: readSeen(cfg, runId).ids });
  if (!compact) {
    const head = [`run_id: ${runId}`];
    for (const k of ['summary', 'lessons_stored', 'confidence', 'degraded']) {
      if (reply[k] !== undefined && reply[k] !== '') head.push(`${k}: ${oneLine(String(reply[k]))}`);
    }
    head.push('No lessons extracted. An empty reflect is a real answer: reflection only sees items the instance has already indexed.');
    c.stdout(`${head.join('\n')}\n`);
    return 0;
  }
  const lines = [`run_id: ${runId}`, compact.text];
  if (compact.dropped > 0) lines.push(`Showing ${compact.total - compact.dropped} of ${compact.total}; --json is the whole reply.`);
  if (compact.pointed.length) lines.push(pointerNote());
  c.stdout(`${lines.join('\n')}\n`);
  markSeen(cfg, runId, [...compact.shown, ...compact.pointed]);
  return 0;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** @param {any} cfg */
function budgetOf(cfg) {
  const n = Number(cfg?.mcpResultTokenBudget);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RESULT_TOKENS;
  // `0` is the operator asking for the raw result back; here that means uncapped.
  return n === 0 ? Number.MAX_SAFE_INTEGER : n;
}

function pointerNote() {
  return 'A line marked "(seen earlier)" was shown in full earlier in this conversation; mubit_dereference returns its text.';
}

/**
 * @param {Ctx} c
 * @param {string} what
 * @param {Record<string, any>} res
 */
function failed(c, what, res) {
  const why = str(res?.message) || str(res?.error?.message) || str(res?.reason) || str(res?.code)
    || str(res?.error?.code) || (res?.status ? `HTTP ${res.status}` : 'no reply');
  c.stderr(`${what}: ${why}\n`);
  if (c.args.json) c.stdout(`${JSON.stringify({ ok: false, error: why }, null, 2)}\n`);
  return 1;
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return '';
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** @param {any} v */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @param {any} v */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** @param {any} v */
function oneLine(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

/** @param {unknown} err */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function realPath(p) {
  try { return realpathSync(p); } catch { return p; }
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && realPath(resolve(process.argv[1])) === realPath(selfPath)) {
  process.exitCode = await main().catch((err) => {
    process.stderr.write(`admin: ${messageOf(err)}\n`);
    return 1;
  });
}
