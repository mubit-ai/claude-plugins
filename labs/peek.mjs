#!/usr/bin/env node
// @ts-check
/**
 * `labs/peek.mjs` — everything the plugin has written to disk, in one screen.
 *
 * There is no database here. `${CLAUDE_PLUGIN_DATA}` is the whole of the plugin's local
 * state, it is all JSON, and reading it is the fastest way to understand the workflow:
 * the spool is the buffer between capture and the network, the turn file is how a `Stop`
 * finds the prompt that produced it, and the marker is the only thing the status line reads.
 *
 *   node labs/peek.mjs               # everything
 *   node labs/peek.mjs spool         # one section
 *   node labs/peek.mjs --help
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `peek spool | head` closes the pipe early; that is not an error worth a stack trace.
process.stdout.on('error', (e) => { if (e?.code === 'EPIPE') process.exit(0); });

const LAB_ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.MUBIT_CC_DATA_DIR
  || process.env.CLAUDE_PLUGIN_DATA
  || join(LAB_ROOT, '.work', 'data');

const SECTIONS = ['tree', 'sessions', 'marker', 'spool', 'turns', 'jobs', 'rejected', 'breaker', 'policy', 'health', 'log'];

const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  say(`peek [${SECTIONS.join('|')}]   (no argument = all)`);
  process.exit(0);
}
const run = want.length ? want : SECTIONS;

if (!existsSync(DATA)) {
  say(`no data dir at ${DATA} — run: node labs/setup.mjs`);
  process.exit(0);
}

say(`data dir  ${DATA}`);
for (const section of run) render(section);

// ---------------------------------------------------------------------------

function render(section) {
  switch (section) {
    case 'tree': return tree();
    case 'sessions': return sessions();
    case 'marker': return markers();
    case 'spool': return spool();
    case 'turns': return turns();
    case 'jobs': return jobs();
    case 'rejected': return rejected();
    case 'breaker': return jsonDir('breaker', 'breaker/  — the circuit breaker, one file per endpoint');
    case 'policy': return jsonDir('policy', 'policy/   — cached "direct_bypass is disabled" verdicts (24 h TTL)');
    case 'health': return health();
    case 'log': return log();
    default: return say(`\nunknown section ${section}`);
  }
}

function tree() {
  head('tree');
  walk(DATA, '');
  function walk(dir, prefix) {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        say(`${prefix}${e.name}/`);
        walk(p, `${prefix}  `);
      } else {
        say(`${prefix}${e.name}  ${size(p)}`);
      }
    }
  }
}

function sessions() {
  head('sessions/  — host session id → Mubit run id (§4.3)');
  for (const [name, rec] of jsonFiles(join(DATA, 'sessions'))) {
    say(`  ${name}`);
    say(`    run_id       ${rec.run_id}`);
    say(`    agent_id     ${rec.agent_id}`);
    say(`    strategy     ${rec.strategy}    clear_count ${rec.clear_count}`);
    say(`    project_dir  ${rec.project_dir}`);
  }
}

function markers() {
  head('status/  — the ONLY thing the status line reads. Zero network.');
  for (const [name, m] of jsonFiles(join(DATA, 'status'))) {
    if (name === 'health.json') continue;
    say(`  ${name}`);
    say(`    state        ${m.state ?? '-'}${m.last_error ? `   last_error: ${trim(m.last_error, 60)}` : ''}`);
    if (m.recall) say(`    recall       sources=${m.recall.sources} tokens=${m.recall.tokens} dropped=${m.recall.dropped ?? 0} ms=${m.recall.ms} rung=${m.recall.rung} empty_reason=${m.recall.empty_reason || '-'}`);
    if (m.captured) say(`    captured     ingested=${m.captured.ingested ?? 0} pending=${m.captured.pending ?? 0}`);
    // Writes that arrived through the MCP rather than the capture hooks. Session end adds
    // this to what the spool reports when it decides whether the run is worth reflecting on,
    // so a run showing 0 captured and a non-zero mcp still reflects (Lab 11d).
    if (m.mcp) say(`    mcp          ingested=${m.mcp.ingested ?? 0}`);
    if (m.lessons) say(`    lessons      global=${m.lessons.global}`);
    if (m.reflect) say(`    reflect      status=${m.reflect.status} lessons_stored=${m.reflect.lessons_stored}`);
    if (m.cold_start_until) say(`    warming until ${new Date(m.cold_start_until).toISOString()}`);
  }
}

function spool() {
  head('runs/<run_id>/spool/  — captured items waiting for the drain. One file per item.');
  for (const runId of runIds()) {
    const dir = join(DATA, 'runs', runId, 'spool');
    const files = jsonNames(dir);
    say(`  ${runId}   ${files.length} item(s) pending`);
    for (const name of files) {
      const it = readJson(join(dir, name));
      if (!it) continue;
      say(`    ${name}`);
      say(`      item_id   ${it.item_id}`);
      say(`      intent    ${it.intent}   importance ${it.importance}   occurrence_time ${it.occurrence_time}`);
      say(`      env_tags  ${(it.env_tags ?? []).join(' ')}`);
      say(`      text      ${trim(it.text, 300)}`);
      const meta = safeParse(it.metadata_json);
      if (meta) say(`      metadata  ${trim(JSON.stringify(meta), 200)}`);
    }
  }
}

function turns() {
  head('runs/<run_id>/turns/  — one file per prompt: the question, what was recalled for it, how it ended');
  for (const runId of runIds()) {
    const dir = join(DATA, 'runs', runId, 'turns');
    for (const [name, t] of jsonFiles(dir)) {
      say(`  ${runId}/${name}`);
      say(`    prompt          ${trim(t.prompt, 90) || '(not staged)'}`);
      say(`    recalled        [${(t.recalled ?? []).join(', ')}]   ← becomes RecordOutcome.entry_ids`);
      say(`    started_at      ${stamp(t.started_at)}`);
      if (t.ended_at) say(`    ended_at        ${stamp(t.ended_at)}`);
      say(`    outcome_pending ${t.outcome_pending === true}   outcome_sent_at ${t.outcome_sent_at ? stamp(t.outcome_sent_at) : '-'}`);
    }
  }
}

function jobs() {
  head('runs/<run_id>/jobs.json  — ingest jobs accepted ("queued" is accepted, not stored)');
  for (const runId of runIds()) {
    const arr = readJson(join(DATA, 'runs', runId, 'jobs.json'));
    if (!Array.isArray(arr)) continue;
    for (const j of arr) say(`  ${runId}  ${j.job_id}  items=${j.items}  status=${j.status}  deduplicated=${j.deduplicated}  ${stamp(j.at)}`);
  }
}

function rejected() {
  head('runs/<run_id>/spool/rejected/  — batches the server refused with a non-retryable 4xx. Never retried.');
  for (const runId of runIds()) {
    const dir = join(DATA, 'runs', runId, 'spool', 'rejected');
    for (const name of jsonNames(dir)) {
      const it = readJson(join(dir, name));
      say(`  ${runId}/${name}   ${trim(it?.text, 100)}`);
    }
  }
}

function health() {
  head('status/health.json  — the 30 s readiness cache');
  const h = readJson(join(DATA, 'status', 'health.json'));
  if (h) say(`  ok=${h.ok} state=${h.state} endpoint=${h.endpoint} at=${stamp(h.at)} ${h.error ? `error=${trim(h.error, 80)}` : ''}`);
}

function jsonDir(sub, title) {
  head(title);
  for (const [name, v] of jsonFiles(join(DATA, sub))) say(`  ${name}  ${trim(JSON.stringify(v), 200)}`);
}

function log() {
  head('logs/mubit-cc.log  — last 25 lines (scrubbed on the way out, safe to paste into an issue)');
  const p = join(DATA, 'logs', 'mubit-cc.log');
  if (!existsSync(p)) return;
  const lines = readFileSync(p, 'utf8').trim().split('\n').slice(-25);
  for (const l of lines) say(`  ${trim(l, 220)}`);
}

// ---------------------------------------------------------------------------

function runIds() {
  try { return readdirSync(join(DATA, 'runs'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }
}
function jsonNames(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name).sort(); }
  catch { return []; }
}
function* jsonFiles(dir) {
  for (const name of jsonNames(dir)) {
    const v = readJson(join(dir, name));
    if (v) yield [name, v];
  }
}
function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
function safeParse(s) { try { return typeof s === 'string' ? JSON.parse(s) : null; } catch { return null; } }
function size(p) { try { return `${statSync(p).size}b`; } catch { return ''; } }
function stamp(ms) { return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 23) : '-'; }
function trim(v, max) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function head(t) { say(`\n\x1b[1m${t}\x1b[0m`); }
function say(s) { try { process.stdout.write(`${s}\n`); } catch { /* closed pipe */ } }
