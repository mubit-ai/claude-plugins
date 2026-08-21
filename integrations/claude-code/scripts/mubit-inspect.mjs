#!/usr/bin/env node
// @ts-check
/**
 * `scripts/mubit-inspect.mjs` — a reader for the state the plugin already writes.
 *
 * Every number a human wants after a session is on disk within a minute of the turn that
 * produced it, and nothing prints it. The marker at `status/<run_id>.json` is last-write-wins,
 * so it answers "how did the *last* prompt go" and cannot answer "how did this session go";
 * the per-prompt series lives one file per prompt under `runs/<run_id>/turns/`, which is the
 * right shape and the wrong ergonomics — a directory of uuid-named JSON.
 *
 * This script joins the two and prints the join. It is **read-only**: it opens files, and
 * with `--resolve` it makes one HTTP call per distinct reference id. It writes nothing,
 * ever, and it never prints an API key.
 *
 * What it can and cannot tell you:
 *
 *   - **cost, per prompt** — `tok`/`chars` are what the injected block actually spent.
 *     `tok` is the plugin's four-chars-per-token estimate; `chars` is there so you can
 *     re-derive it with a real tokenizer instead of inheriting the estimate. `ptr` is how
 *     many of that prompt's memories were repeats, rendered as a one-line pointer rather
 *     than in full — it is what makes a falling `tok` attributable to the seen-set.
 *   - **which memories** — `recalled[]` holds `reference_id` values in render order.
 *     `--resolve` turns them into text.
 *   - **whether they were used** — only as the `memory-term-echo/v1` proxy the capture hook
 *     records: did the reply carry vocabulary from the block that was not already in the
 *     prompt. False negatives dominate. `used(m/c)` shows matched-of-candidates, and a blank
 *     is "not measurable", not "not used".
 *   - **latency, per prompt** — it cannot. `recall.ms` is written to the marker only, so the
 *     value here is the *last* prompt's. Per-prompt timing survives only in a
 *     `--debug-file` log, in the `mubit: N memories · X tok · Yms` system message.
 *
 * Usage:
 *   node scripts/mubit-inspect.mjs                      # newest run, last 15 prompts
 *   node scripts/mubit-inspect.mjs --runs               # every run in every data dir
 *   node scripts/mubit-inspect.mjs --run <run_id> --last 40
 *   node scripts/mubit-inspect.mjs --data <dir>         # pin one data dir
 *   node scripts/mubit-inspect.mjs --prompt <prompt_id> # one turn, in full
 *   node scripts/mubit-inspect.mjs --resolve            # dereference the recalled ids
 *   node scripts/mubit-inspect.mjs --cross-run          # which injections came from another run
 *   node scripts/mubit-inspect.mjs --json               # the same data, machine-readable
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

/* -------------------------------------------------------------------------- */
/* args                                                                        */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const out = { last: 15, json: false, resolve: false, runs: false, help: false, crossRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--resolve') out.resolve = true;
    else if (a === '--cross-run') out.crossRun = true;
    else if (a === '--runs') out.runs = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--last') out.last = Math.max(1, Number(argv[++i]) || 15);
    else if (a === '--run') out.run = String(argv[++i] || '');
    else if (a === '--data') out.data = String(argv[++i] || '');
    else if (a === '--prompt') out.prompt = String(argv[++i] || '');
    else if (a.startsWith('--')) { fail(`unknown flag ${a} (try --help)`); }
  }
  return out;
}

function fail(msg) { process.stderr.write(`mubit-inspect: ${msg}\n`); process.exit(2); }

const HELP = `mubit-inspect — read the Mubit plugin's own on-disk state

  --runs             list every run found, newest first
  --run <run_id>     inspect one run (default: the most recently updated)
  --data <dir>       pin one data dir (default: every ~/.claude/plugins/data/mubit-memory*)
  --last N           how many prompts to show (default 15)
  --prompt <id>      one turn in full, including recalled ids and matched terms
  --resolve          dereference recalled ids into text (one HTTP call per id)
  --cross-run        report which injected memories came from a DIFFERENT run
                     (one HTTP call per distinct recalled id in the window shown)
  --json             machine-readable output
`;

/* -------------------------------------------------------------------------- */
/* reading                                                                     */
/* -------------------------------------------------------------------------- */

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function lsDir(path) {
  try { return readdirSync(path); } catch { return []; }
}

/** Every data dir the plugin might have written. `--plugin-dir` uses a `-inline` suffix,
 *  a marketplace install uses `-<marketplace>`, so the bare name is only one of several. */
function dataDirs(pin) {
  if (pin) return [pin];
  const root = join(homedir(), '.claude', 'plugins', 'data');
  return lsDir(root)
    .filter((n) => n.startsWith('mubit-memory'))
    .map((n) => join(root, n))
    .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
}

/** Runs are enumerated from the markers, which is the only file guaranteed to exist. */
function runsIn(dir) {
  return lsDir(join(dir, 'status'))
    .filter((f) => f.endsWith('.json') && f !== 'health.json')
    .map((f) => {
      const runId = f.slice(0, -5);
      const marker = readJson(join(dir, 'status', f), {}) || {};
      return { dir, runId, marker, updatedAt: Number(marker.updated_at) || 0 };
    });
}

function allRuns(pin) {
  return dataDirs(pin).flatMap(runsIn).sort((a, b) => b.updatedAt - a.updatedAt);
}

function turnsFor(dir, runId) {
  const tdir = join(dir, 'runs', runId, 'turns');
  return lsDir(tdir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(join(tdir, f), null))
    .filter((t) => t && typeof t === 'object')
    .sort((a, b) => (Number(a.started_at) || 0) - (Number(b.started_at) || 0));
}

function jobsFor(dir, runId) {
  const j = readJson(join(dir, 'runs', runId, 'jobs.json'), []);
  return Array.isArray(j) ? j : [];
}

function spoolCount(dir, runId) {
  return lsDir(join(dir, 'runs', runId, 'spool')).filter((f) => f.endsWith('.json')).length;
}

function breakerFor(dir) {
  return lsDir(join(dir, 'breaker'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(join(dir, 'breaker', f), null))
    .filter(Boolean);
}

/* -------------------------------------------------------------------------- */
/* shaping                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The one field the outcome path spreads across five keys, collapsed to a word.
 *
 * `api:<error>` comes first because it is the only one that explains itself: a turn the API
 * killed is closed AND stays `outcome_pending` forever, since `lib/outcome.mjs` suppresses
 * its outcome rather than sending one. Reading that as plain `pending` would look like a
 * flush that never happened, which is a bug hunt with nothing at the end of it.
 */
function outcomeState(turn) {
  if (turn.outcome_abandoned === true) return 'dropped';
  if (Number(turn.outcome_sent_at) > 0) return 'sent';
  if (typeof turn.api_error === 'string' && turn.api_error) return `api:${turn.api_error}`;
  if (turn.outcome_pending === true) return 'pending';
  if (turn.ended_at) return 'none';
  return '';
}

/** `used` is deliberately tri-state: absent means the signal could not be measured. */
function usedCell(turn) {
  const u = turn.used_evidence;
  if (!u || typeof u !== 'object') return '—';
  const m = Number(u.matched) || 0;
  const c = Number(u.candidates) || 0;
  if (u.used === true) return `${m}/${c} yes`;
  if (u.used === false) return `${m}/${c} no`;
  return `${m}/${c} ?`;      // reason: no_distinct_terms | no_reply
}

function row(turn) {
  const r = (turn.recall && typeof turn.recall === 'object') ? turn.recall : {};
  return {
    prompt_id: String(turn.prompt_id || ''),
    started_at: Number(turn.started_at) || 0,
    ended_at: Number(turn.ended_at) || 0,
    rung: Number(r.rung) || 0,
    sources: Number(r.sources) || 0,
    tokens: Number(r.tokens) || 0,
    chars: Number(r.chars) || 0,
    dropped: Number(r.dropped) || 0,
    // How many of `sources` were repeats rendered as a one-line pointer because this run had
    // already injected them (`lib/seen.mjs`). Without it a falling `tok` is unattributable:
    // a block that shrank because the seen-set worked reads the same as one that shrank
    // because recall found half as much.
    pointers: Number(r.pointers) || 0,
    empty_reason: String(r.empty_reason || ''),
    recalled: Array.isArray(turn.recalled) ? turn.recalled : [],
    // Filled in by --cross-run, which is the only thing that knows: the turn file records
    // reference ids and nothing about where they came from, so the originating run costs one
    // dereference call per id. Null means "not asked", never "none".
    cross_run: null,
    used: usedCell(turn),
    used_evidence: turn.used_evidence || null,
    outcome: outcomeState(turn),
    turn_ms: (Number(turn.ended_at) || 0) && (Number(turn.started_at) || 0)
      ? Number(turn.ended_at) - Number(turn.started_at) : 0,
    prompt: String(turn.prompt || ''),
  };
}

/* -------------------------------------------------------------------------- */
/* formatting                                                                  */
/* -------------------------------------------------------------------------- */

const clock = (ms) => (ms ? new Date(ms).toTimeString().slice(0, 8) : '—');
const short = (id, n = 8) => (id ? `${String(id).slice(0, n)}…` : '—');
const dash = (v) => (v ? String(v) : '—');

function table(rows, cols) {
  const head = cols.map((c) => c.label);
  const body = rows.map((r) => cols.map((c) => String(c.get(r))));
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (cols[i].right ? c.padStart(w[i]) : c.padEnd(w[i]))).join('  ').trimEnd();
  return [line(head), ...body.map(line)];
}

const COLS = [
  { label: 'prompt',   get: (r) => short(r.prompt_id) },
  { label: 'when',     get: (r) => clock(r.started_at) },
  { label: 'rung',     get: (r) => (r.rung || '—'), right: true },
  { label: 'src',      get: (r) => r.sources, right: true },
  { label: 'tok',      get: (r) => r.tokens, right: true },
  { label: 'chars',    get: (r) => r.chars, right: true },
  { label: 'drop',     get: (r) => r.dropped, right: true },
  { label: 'ptr',      get: (r) => r.pointers, right: true },
  { label: 'empty_reason', get: (r) => dash(r.empty_reason) },
  { label: 'used(m/c)',get: (r) => r.used },
  { label: 'outcome',  get: (r) => dash(r.outcome) },
];

/**
 * `--cross-run` only. Appended where the table is printed rather than declared into `COLS`,
 * because `COLS` is evaluated at module scope — before `args` exists.
 *
 * `foreign/injected`: how many of this prompt's injected memories were written by a
 * different run. At the `run` scope ceiling the answer is 0 for every prompt; anything else
 * is a lesson that followed an agent out of the run that wrote it.
 */
const CROSS_RUN_COL = {
  label: 'x-run',
  get: (r) => {
    if (!r.cross_run) return '—';
    if (!r.cross_run.injected) return '—';
    const unresolved = r.cross_run.unresolved ? `+${r.cross_run.unresolved}?` : '';
    return `${r.cross_run.foreign}/${r.cross_run.injected}${unresolved}`;
  },
};

/** A run id may come back namespaced with `::` separators; the local ones are bare. */
const bareRun = (id) => String(id || '').split('::').pop().trim();

/** The run a dereferenced entry was written in, or '' when the call could not say. */
function originRunOf(item) {
  if (!item || item.status !== 200) return '';
  const body = item.entry || {};
  if (body.found === false) return '';
  const e = body.evidence || body.entry || body;
  const inner = Array.isArray(e) ? (e[0] || {}) : e;
  return bareRun(inner.run_id);
}

/* -------------------------------------------------------------------------- */
/* resolve                                                                     */
/* -------------------------------------------------------------------------- */

/** Env beats the stored credential, exactly as `lib/config.mjs` orders them. A shell that
 *  still has `MUBIT_ENDPOINT` exported from some earlier local-server session will therefore
 *  resolve against that server and not the one the run was recorded against — so print it. */
function creds(dir) {
  const stored = readJson(join(dir, 'credentials.json'), {}) || {};
  return {
    endpoint: process.env.MUBIT_ENDPOINT || stored.endpoint || '',
    apiKey: process.env.MUBIT_API_KEY || stored.apiKey || '',
    from: process.env.MUBIT_ENDPOINT ? 'env' : (stored.endpoint ? 'credentials.json' : 'nowhere'),
  };
}

async function resolveIds(ids, runId, dir) {
  const { endpoint, apiKey, from } = creds(dir);
  if (!endpoint || !apiKey) return { error: `no endpoint/key (looked in env and ${dir}/credentials.json)`, from, items: [] };
  const items = [];
  for (const id of ids) {
    try {
      const res = await fetch(`${endpoint.replace(/\/+$/, '')}/v2/control/dereference`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ run_id: runId, reference_id: id }),
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.text();
      let parsed = null; try { parsed = JSON.parse(body); } catch { /* keep the text */ }
      items.push({ id, status: res.status, entry: parsed, raw: parsed ? null : body.slice(0, 200) });
    } catch (err) {
      items.push({ id, status: 0, error: String(err && err.message ? err.message : err) });
    }
  }
  return { endpoint, from, items };
}

/** `POST /v2/control/dereference` answers `{found, evidence:{...}}` — one object, not a list.
 *  `knowledge_confidence` is the stored belief that outcomes move over time; `score` on a
 *  search hit is per-query relevance and a different number entirely. */
function gloss(item) {
  if (item.error) return `(${item.error})`;
  if (item.status !== 200) return `(HTTP ${item.status}${item.raw ? ` ${item.raw}` : ''})`;
  const body = item.entry || {};
  if (body.found === false) return '(not found — the entry was deleted, or belongs to another run)';
  const e = body.evidence || body.entry || body;
  const inner = Array.isArray(e) ? (e[0] || {}) : e;
  const text = String(inner.content || inner.text || '').replace(/\s+/g, ' ').trim();
  const kind = inner.entry_type || inner.intent || '';
  const conf = Number.isFinite(inner.knowledge_confidence)
    ? ` conf ${inner.knowledge_confidence.toFixed(2)}` : '';
  const stale = inner.is_stale ? ' STALE' : '';
  const head = `${kind ? `[${kind}${conf}${stale}] ` : ''}`;
  return text ? `${head}${text.slice(0, 200)}${text.length > 200 ? '…' : ''}` : `${head}(no text in response)`;
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

const args = parseArgs(process.argv.slice(2));
if (args.help) { process.stdout.write(HELP); process.exit(0); }

const runs = allRuns(args.data);
if (runs.length === 0) {
  fail(args.data
    ? `no runs under ${args.data} (expected a status/ directory)`
    : 'no runs found — has a session started since the plugin was installed?');
}

if (args.runs) {
  const rows = runs.map((r) => ({
    run: r.runId,
    updated: clock(r.updatedAt),
    state: r.marker.state || '?',
    mode: r.marker.mode || '?',
    turns: turnsFor(r.dir, r.runId).length,
    dir: basename(r.dir),
  }));
  if (args.json) { process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`); process.exit(0); }
  process.stdout.write(`${table(rows, [
    { label: 'run', get: (r) => r.run },
    { label: 'updated', get: (r) => r.updated },
    { label: 'state', get: (r) => r.state },
    { label: 'mode', get: (r) => r.mode },
    { label: 'turns', get: (r) => r.turns, right: true },
    { label: 'data dir', get: (r) => r.dir },
  ]).join('\n')}\n`);
  process.exit(0);
}

const chosen = args.run ? runs.find((r) => r.runId === args.run) : runs[0];
if (!chosen) fail(`run ${args.run} not found — try --runs`);

const marker = chosen.marker || {};
const mRecall = marker.recall || {};
const mLessons = marker.lessons || {};
const mReflect = marker.reflect || {};
const mCaptured = marker.captured || {};
const allTurns = turnsFor(chosen.dir, chosen.runId).map(row);
const jobs = jobsFor(chosen.dir, chosen.runId);

/* one turn, in full */
if (args.prompt) {
  const t = allTurns.find((r) => r.prompt_id === args.prompt || r.prompt_id.startsWith(args.prompt));
  if (!t) fail(`prompt ${args.prompt} not found in run ${chosen.runId}`);
  const ue = t.used_evidence || {};
  const resolved = args.resolve ? await resolveIds(t.recalled, chosen.runId, chosen.dir) : null;
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ run: chosen.runId, turn: t, resolved }, null, 2)}\n`);
    process.exit(0);
  }
  const out = [];
  out.push(`run     ${chosen.runId}   prompt ${t.prompt_id}`);
  out.push(`when    ${clock(t.started_at)} → ${clock(t.ended_at)}  (turn ${t.turn_ms} ms wall)`);
  out.push(`recall  rung ${t.rung || '—'} · ${t.sources} sources · ${t.tokens} tok / ${t.chars} chars · ${t.dropped} dropped${t.empty_reason ? ` · ${t.empty_reason}` : ''}`);
  out.push(`used    ${ue.method || '—'} · matched ${ue.matched ?? '—'} of ${ue.candidates ?? '—'}${ue.reason ? ` · ${ue.reason}` : ''}${ue.used === undefined ? ' (not measurable)' : ''}`);
  if (Array.isArray(ue.terms) && ue.terms.length) out.push(`terms   ${ue.terms.join(', ')}`);
  out.push(`outcome ${t.outcome || '—'}`);
  out.push('');
  out.push(`prompt  ${t.prompt.replace(/\s+/g, ' ').slice(0, 300)}${t.prompt.length > 300 ? '…' : ''}`);
  out.push('');
  out.push(`recalled (${t.recalled.length})`);
  if (!t.recalled.length) out.push('  (nothing was injected for this prompt)');
  for (const id of t.recalled) {
    const hit = resolved?.items.find((i) => i.id === id);
    out.push(`  ${id}${hit ? `\n    ${gloss(hit)}` : ''}`);
  }
  if (!args.resolve && t.recalled.length) out.push('  (pass --resolve to fetch the text behind these ids)');
  if (resolved?.error) out.push(`  resolve failed: ${resolved.error}`);
  process.stdout.write(`${out.join('\n')}\n`);
  process.exit(0);
}

/* the run */
const shown = allTurns.slice(-args.last);

/* --cross-run: the injection side of the scope question.
 *
 * `scripts/scope-audit.mjs` counts what runs have *written* at a cross-run scope. This
 * counts what this run was *given* from somewhere else — the half the original report had
 * to reconstruct by hand. Zero is the target for a run at the `run` ceiling.
 *
 * Only the window being displayed is resolved: one HTTP call per distinct id, and a
 * `--last 400` would otherwise be four hundred of them. */
let crossRun = null;
if (args.crossRun) {
  const ids = [...new Set(shown.flatMap((r) => r.recalled))];
  const resolved = ids.length
    ? await resolveIds(ids, chosen.runId, chosen.dir)
    : { items: [], endpoint: '', from: '' };
  const origin = new Map();
  for (const item of resolved.items || []) origin.set(item.id, originRunOf(item));

  let injected = 0; let foreign = 0; let unresolved = 0;
  const foreignRuns = new Set();
  for (const r of shown) {
    let f = 0; let u = 0;
    for (const id of r.recalled) {
      const o = origin.get(id) || '';
      // An id that cannot be dereferenced is counted as unknown, never as same-run: a
      // deleted or out-of-scope entry is exactly the case where a silent 0 would lie.
      if (!o) u += 1;
      else if (o !== bareRun(chosen.runId)) { f += 1; foreignRuns.add(o); }
    }
    r.cross_run = { injected: r.recalled.length, foreign: f, unresolved: u };
    injected += r.recalled.length; foreign += f; unresolved += u;
  }
  crossRun = {
    prompts: shown.length,
    injected,
    foreign,
    unresolved,
    per_100_prompts: shown.length ? Math.round((foreign / shown.length) * 1000) / 10 : 0,
    foreign_runs: [...foreignRuns].sort(),
    calls: ids.length,
    endpoint: resolved.endpoint || '',
    error: resolved.error || '',
  };
}

const hits = allTurns.filter((r) => r.sources > 0).length;
const totalTok = allTurns.reduce((a, r) => a + r.tokens, 0);
const totalSrc = allTurns.reduce((a, r) => a + r.sources, 0);
const measured = allTurns.filter((r) => r.used_evidence && r.used_evidence.used !== undefined);
const echoed = measured.filter((r) => r.used_evidence.used === true).length;
const lastJob = jobs.length ? jobs[jobs.length - 1] : null;
const breakers = breakerFor(chosen.dir);

if (args.json) {
  process.stdout.write(`${JSON.stringify({
    run_id: chosen.runId,
    data_dir: chosen.dir,
    marker,
    totals: {
      prompts: allTurns.length, prompts_with_injection: hits,
      tokens_injected: totalTok, sources_injected: totalSrc,
      used_measured: measured.length, used_echoed: echoed,
    },
    turns: shown,
    cross_run: crossRun,
    jobs,
    spool_pending: spoolCount(chosen.dir, chosen.runId),
  }, null, 2)}\n`);
  process.exit(0);
}

const GLYPH = {
  ready: '●', not_responding: '◌', unreachable: '✖', auth_failed: '✖',
  server_error: '▲', unconfigured: '○',
};
const out = [];
out.push(`run ${chosen.runId}   ${marker.mode || '?'}   ${GLYPH[marker.state] || '?'} ${marker.state || 'unknown'}   (data: ${chosen.dir})`);
if (marker.last_error) out.push(`last_error  ${marker.last_error}`);
out.push('');

if (shown.length === 0) {
  out.push('no turns recorded for this run yet — the prompt hooks have not run, or state was pruned');
} else {
  out.push(...table(shown, args.crossRun ? [...COLS, CROSS_RUN_COL] : COLS));
  out.push('');
  out.push(`totals      ${allTurns.length} prompts · ${totalTok} tok injected · ${totalSrc} sources · ${hits}/${allTurns.length} prompts got an injection`);
  if (crossRun) {
    out.push(`cross-run   ${crossRun.foreign} of ${crossRun.injected} injections came from another run`
      + ` · ${crossRun.per_100_prompts} per 100 prompts`
      + (crossRun.unresolved ? ` · ${crossRun.unresolved} ids could not be dereferenced` : '')
      + ` (${crossRun.calls} calls over the ${crossRun.prompts} prompts shown)`);
    if (crossRun.foreign_runs.length) {
      out.push(`            from ${crossRun.foreign_runs.join(', ')}`);
    }
    if (crossRun.error) out.push(`            resolve failed: ${crossRun.error}`);
  }
  out.push(`used-signal ${echoed}/${measured.length} measurable turns echoed the injected vocabulary (memory-term-echo/v1; false negatives dominate)`);
  if (shown.length < allTurns.length) out.push(`            showing the last ${shown.length} — pass --last ${allTurns.length} for all`);
}
out.push('');
out.push(`lessons     global ${mLessons.global ?? 0} · injected_ids ${(mLessons.injected_ids || []).length}${mLessons.credited_at ? ' (credited)' : ''} · reflect: ${mReflect.lessons_stored ?? 0} stored, status=${mReflect.status || '—'}`);
out.push(`capture     tools ${mCaptured.tools ?? 0} · turns ${mCaptured.turns ?? 0} · pending ${mCaptured.pending ?? 0} · ingested ${mCaptured.ingested ?? 0} · spool ${spoolCount(chosen.dir, chosen.runId)} · jobs ${jobs.length}${lastJob ? ` (last: ${lastJob.status}, ${lastJob.items} items)` : ''}`);
out.push(`last recall ${mRecall.sources ?? 0} sources · ${mRecall.tokens ?? 0} tok · ${mRecall.ms ?? 0} ms · rung ${mRecall.rung ?? 0}${mRecall.empty_reason ? ` · ${mRecall.empty_reason}` : ''} · dry_streak ${mRecall.dry_streak ?? 0}`);
out.push(`            ^ marker is last-write-wins: this row is the most recent prompt only, and it is the only place per-prompt latency ever appears`);
// Breaker state is per endpoint, so a machine that has pointed at more than one instance
// keeps more than one file. `openedAt` alone does not mean open: once the cooldown has
// elapsed the breaker is half-open and the next call goes through, so age has to be read too.
const COOLDOWN_MS = Number(process.env.MUBIT_CC_BREAKER_COOLDOWN_MS) || 120000;
for (const b of breakers) {
  if (!b || (b.state === 'ready' && !(b.failures || []).length)) continue;
  const age = Date.now() - (Number(b.openedAt) || 0);
  const open = Number(b.openedAt) > 0 && age < COOLDOWN_MS;
  const phase = Number(b.openedAt) > 0 ? (open ? `OPEN, ${Math.ceil((COOLDOWN_MS - age) / 1000)}s left` : 'half-open (cooldown elapsed)') : 'closed';
  out.push(`breaker     ${b.state} · ${(b.failures || []).length} failures · ${phase} · ${b.endpoint || '(no endpoint configured)'}`);
}
process.stdout.write(`${out.join('\n')}\n`);
