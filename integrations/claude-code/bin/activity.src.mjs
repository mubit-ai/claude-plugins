// @ts-check
/**
 * `bin/activity.src.mjs` — what `/mubit-memory:activity` runs. Bundled to `bin/activity.mjs`.
 *
 * The question this answers is not "how is memory doing", which `doctor` already owns more
 * cheaply. It is the audit one: *what does my instance actually hold, and can I take the
 * answer somewhere else.* Until now the only surface over `/v2/control/activity` was three tabs
 * in a browser, and there was none at all over the export route.
 *
 * ## stdout by default; `--out` is opt-in
 *
 * A CLI that prints composes. It pipes, it redirects, it goes into `less`, and — the part that
 * matters here — it writes to nobody's disk, which resolves the consent question by not having
 * one. Nothing about "show me my memory" implies "leave a copy of my memory in the filesystem".
 *
 * `--out` is therefore a deliberate act, and it is guarded three ways before anything is
 * dialled:
 *
 *   - It refuses to overwrite. The most likely second run of this command is the same command,
 *     and the file it would clobber is the artefact somebody kept.
 *   - It refuses any path inside the plugin data directory. `pruneStale`'s TTL table names the
 *     directories it sweeps and this would not be one of them, so an export there is an
 *     unbounded copy of the instance's memory that lives forever and that nothing ever
 *     mentions again.
 *   - It warns — not refuses — when the destination is inside a git working tree that is not
 *     ignoring it. Committing an export is a reasonable thing to do deliberately and a bad
 *     thing to do by accident, and the difference is whether git is about to offer it up.
 *
 * And a failure writes nothing at all. A half-written export is worse than none: it is a file
 * that looks like a record.
 *
 * ## The stream split
 *
 * **The payload owns stdout.** The summary goes to stderr — unless `--out` took the payload, in
 * which case the summary *is* the output and takes stdout. That one rule is why
 * `--export | jq` works, and why `--export --out audit.jsonl` prints something a person can
 * read instead of nothing.
 *
 * ## Why `pickRun` is here and not in `lib/runid.mjs`
 *
 * Because it is twenty lines, and because `lib/runid.mjs` is a subtle file that several
 * branches are working in at once. Duplicating a small function is cheaper than resolving a
 * conflict inside `resolveRunId`, and the extraction is easy once there is more than one copy
 * to extract *from*. Duplicate small, extract after.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportActivity, listActivity, scanActivity, scrubKey } from '../lib/activity.mjs';
import { loadConfig } from '../lib/config.mjs';
import { resolveDataDir } from '../lib/state.mjs';

const USAGE = `mubit-memory: what this instance holds, and a copy of it you can keep.

  node bin/activity.mjs [options]

Modes
  (default)            list the newest activity for one run, one page
  --scan               page through everything that matches, oldest first
  --export             ask the instance for its own export, verbatim

Scope
  --run <id>           a run id; the default is the newest run in the data dir
  --all-runs           every run this key can see (listing and --scan only)
  --type <t>           entry type filter; repeat for more than one
  --since <rfc3339>    inclusive lower bound on created_at
  --until <rfc3339>    inclusive upper bound on created_at
  --agent <id>         one agent
  --user <id>          one logical user

Shape
  --exclude-derived    drop entries the instance derived for itself, and verify it did
  --full               every field, untruncated (the default is five keys)
  --limit <n>          page size, 1..500
  --max <n>            stop a --scan after n entries

Output
  (default)            a table on stdout, a summary on stderr
  --jsonl              one JSON object per entry on stdout
  --json               one JSON envelope on stdout
  --out <path>         write the payload to a file; refuses to overwrite
  -h, --help
`;

/** Flags that take a value. Named so a missing value is an error rather than a silent skip. */
const VALUED = new Set(['--run', '--type', '--since', '--until', '--agent', '--user', '--limit', '--max', '--out']);

/** Flags that do not. */
const BARE = new Set([
  '--scan', '--export', '--all-runs', '--exclude-derived', '--full', '--jsonl', '--json',
  '--help', '-h',
]);

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * Parse argv into an intent, or into an error.
 *
 * A mistyped flag is the one input where guessing costs more than refusing:
 * `--exclude-derive` quietly ignored produces a listing that claims to be filtered and is not,
 * which is the whole class of failure this command was written against. So anything unknown,
 * and any valued flag with nothing after it, is a refusal.
 *
 * @param {string[]} argv
 * @returns {Record<string, any>}
 */
export function parseArgs(argv = []) {
  /** @type {Record<string, any>} */
  const out = {
    mode: 'list', run: '', allRuns: false, entryTypes: [], since: '', until: '',
    agent: '', user: '', excludeDerived: false, full: false, limit: 0, max: 0,
    jsonl: false, json: false, out: '', help: false, error: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (VALUED.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || String(v).startsWith('--')) {
        out.error = `${a} needs a value`;
        return out;
      }
      i += 1;
      if (a === '--run') out.run = String(v).trim();
      else if (a === '--type') out.entryTypes.push(String(v).trim());
      else if (a === '--since') out.since = String(v).trim();
      else if (a === '--until') out.until = String(v).trim();
      else if (a === '--agent') out.agent = String(v).trim();
      else if (a === '--user') out.user = String(v).trim();
      else if (a === '--limit') out.limit = Number(v);
      else if (a === '--max') out.max = Number(v);
      else if (a === '--out') out.out = String(v);
      continue;
    }
    if (!BARE.has(a)) {
      out.error = `unknown flag: ${a}`;
      return out;
    }
    if (a === '--scan') out.mode = 'scan';
    else if (a === '--export') out.mode = 'export';
    else if (a === '--all-runs') out.allRuns = true;
    else if (a === '--exclude-derived') out.excludeDerived = true;
    else if (a === '--full') out.full = true;
    else if (a === '--jsonl') out.jsonl = true;
    else if (a === '--json') out.json = true;
    else out.help = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The run id
// ---------------------------------------------------------------------------

/**
 * Which run this command is about.
 *
 * Runs are enumerated from `status/`, not `runs/`: the marker is the only file guaranteed to
 * exist, because a session that recalled and never captured has no `runs/<id>/` at all.
 * `health.json` lives in the same directory and is the endpoint probe cache, not a run.
 *
 * Newest wins, by the marker's own `updated_at` — and **a tie goes to the higher `-c<n>`**.
 * After a `/clear` the run is `cc-<slug>-<hash>-c1` while the pre-clear marker is still on disk
 * under its twelve-hour TTL, and both can be stamped inside the same millisecond. A resolver
 * that ignores the counter answers with the run the user just cleared and reports its activity
 * as this session's.
 *
 * @param {string} dataDir
 * @param {string} [explicit]
 * @returns {string}
 */
export function pickRun(dataDir, explicit = '') {
  const want = typeof explicit === 'string' ? explicit.trim() : '';
  if (want) return want;
  try {
    const dir = join(dataDir, 'status');
    let best = '';
    let bestAt = -1;
    let bestClear = -1;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json') || file === 'health.json') continue;
      const runId = file.slice(0, -5);
      const path = join(dir, file);
      let at = 0;
      try {
        const m = JSON.parse(readFileSync(path, 'utf8'));
        at = Number(m && m.updated_at);
      } catch { /* a marker truncated by a SIGKILL still names a run */ }
      if (!Number.isFinite(at) || at <= 0) {
        try { at = statSync(path).mtimeMs; } catch { at = 0; }
      }
      const clear = Number(/-c(\d+)$/.exec(runId)?.[1] ?? 0);
      if (at > bestAt || (at === bestAt && clear > bestClear)) {
        best = runId; bestAt = at; bestClear = clear;
      }
    }
    return best;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// --out
// ---------------------------------------------------------------------------

/**
 * Whether this path may be written, decided before anything is dialled.
 *
 * @param {string} dest
 * @param {string} dataDir
 * @returns {{ok: boolean, abs: string, error: string}}
 */
export function checkOutPath(dest, dataDir) {
  const abs = isAbsolute(dest) ? resolve(dest) : resolve(process.cwd(), dest);

  if (existsSync(abs)) {
    return { ok: false, abs, error: `${abs} already exists; refusing to overwrite it` };
  }

  const root = resolve(dataDir || '');
  if (root && (abs === root || abs.startsWith(root + sep))) {
    return {
      ok: false,
      abs,
      error: `${abs} is inside the plugin data dir (${root}). An export there is an unbounded `
        + 'copy of your memory outside the TTL sweep: nothing would ever prune it and nothing '
        + 'would ever mention it again. Write it somewhere you will look.',
    };
  }

  return { ok: true, abs, error: '' };
}

/**
 * `''`, or the sentence to say about where this file landed.
 *
 * Best effort in every direction: no git, no repo, or a git that refuses to answer all mean
 * silence rather than a wrong warning.
 *
 * @param {string} abs
 * @returns {string}
 */
function gitNote(abs) {
  try {
    const cwd = dirname(abs);
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'],
      { cwd, encoding: 'utf8', timeout: 2000 });
    if (inside.status !== 0 || String(inside.stdout).trim() !== 'true') return '';
    const ignored = spawnSync('git', ['check-ignore', '-q', abs], { cwd, timeout: 2000 });
    // `check-ignore -q` exits 0 when the path IS ignored, 1 when it is not.
    if (ignored.status === 0) return '';
    return `${abs} is inside a git working tree and is not ignored — an export is a copy of `
      + 'everything your instance holds, so add it to .gitignore before you commit anything.';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One entry as a table row. Newlines collapse: a row that wraps is not a row. */
function row(entry) {
  const e = (entry && typeof entry === 'object') ? entry : {};
  const at = String(e.created_at ?? '').padEnd(20);
  const type = String(e.entry_type ?? '').padEnd(12);
  const id = String(e.id ?? '').padEnd(38);
  const content = String(e.content ?? '').replace(/\s*\n\s*/g, ' ');
  return `${at} ${type} ${id} ${content}`;
}

/**
 * The notes that are *findings* rather than decoration.
 *
 * Each of these says the answer is not what was asked for, which is the only thing about a
 * compliance answer more important than the answer.
 *
 * @param {Record<string, any>} data
 * @returns {string[]}
 */
function findings(data) {
  const notes = [];
  if (data.excludeDerivedFallbackUsed) {
    const n = data.droppedDerived;
    notes.push(`the instance did not honour exclude_derived: ${n} `
      + `${n === 1 ? 'entry it returned was' : 'entries it returned were'} derived, and `
      + `${n === 1 ? 'was' : 'were'} dropped here instead`);
  }
  if (data.projectionFallbackUsed) {
    notes.push('the instance did not honour the compact projection; content was truncated '
      + 'locally, so what you see is shorter than what it sent');
  }
  if (data.truncated) {
    notes.push(`this answer is incomplete: the scan stopped at ${data.truncatedReason}. `
      + 'It is a prefix of what the instance holds, not all of it.');
  }
  return notes;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 * @param {{stdout?: (s: string) => void, stderr?: (s: string) => void}} [deps]
 * @returns {Promise<number>} process exit code
 */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));

  const args = parseArgs(argv);
  if (args.error) {
    stderr(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    stdout(USAGE);
    return 0;
  }

  const cfg = loadConfig(env);
  const dataDir = resolveDataDir(cfg);

  // "Every run" is a legitimate question for a listing, which is bounded by `limit`. It is not
  // one for an export: that route takes no limit, so scope is the only bound its response body
  // has, and `dial()` reads the whole thing into one string.
  if (args.mode === 'export' && args.allRuns) {
    stderr('--all-runs cannot be combined with --export: the export route takes no limit, so a '
      + 'run is the only bound on how much comes back. Export one run at a time, or use --scan, '
      + 'which pages.\n');
    return 2;
  }

  const run = args.allRuns ? '' : pickRun(dataDir, args.run);
  if (!run && !args.allRuns) {
    stderr('No run to look at: this data dir has no run marker yet. Pass --run <id>, or '
      + `--all-runs to ask across every run this key can see. (data dir: ${dataDir})\n`);
    return 1;
  }

  // Checked before the dial, so a refusal costs nobody a request — and so a refusal is never
  // reported after the instance has already done the work.
  let outPath = '';
  if (args.out) {
    const verdict = checkOutPath(args.out, dataDir);
    if (!verdict.ok) { stderr(`${verdict.error}\n`); return 1; }
    outPath = verdict.abs;
  }

  const shared = {
    run,
    allRuns: args.allRuns,
    entryTypes: args.entryTypes,
    createdAfter: args.since,
    createdBefore: args.until,
    userId: args.user,
    agentId: args.agent,
  };

  const res = args.mode === 'export'
    ? await exportActivity(cfg, shared)
    : args.mode === 'scan'
      ? await scanActivity(cfg, {
        ...shared,
        excludeDerived: args.excludeDerived,
        projection: args.full ? 'full' : 'compact',
        limit: args.limit || undefined,
        maxEntries: args.max || undefined,
      })
      : await listActivity(cfg, {
        ...shared,
        excludeDerived: args.excludeDerived,
        projection: args.full ? 'full' : 'compact',
        limit: args.limit || undefined,
      });

  if (!res.ok) {
    const message = scrubKey(cfg, String(res.message ?? ''));
    stderr(args.json
      ? `${JSON.stringify({ ok: false, mode: args.mode, run, code: res.code, message })}\n`
      : `${message}\n`);
    return 1;
  }

  return args.mode === 'export'
    ? emitExport(res.data, { args, run, outPath, stdout, stderr })
    : emitEntries(res.data, { args, run, outPath, stdout, stderr });
}

/**
 * The export. `content` reaches the file or the terminal exactly as the instance sent it —
 * this is the half of the command whose entire value is that nothing reshaped it.
 */
function emitExport(data, { args, run, outPath, stdout, stderr }) {
  const summary = args.json
    ? JSON.stringify({
      ok: true,
      mode: 'export',
      run,
      format: data.format,
      requestedFormat: data.requestedFormat,
      entryCount: data.entryCount,
      lines: data.lines,
      bytes: data.bytes,
      path: outPath || null,
    })
    : outPath
      ? `wrote ${outPath} — ${data.bytes} bytes, ${data.entryCount} entries, format ${data.format}`
      : `${data.entryCount} entries · ${data.bytes} bytes · format ${data.format}`;

  const notes = [];
  if (data.format && data.format !== data.requestedFormat) {
    notes.push(`the instance answered in ${data.format}, not the ${data.requestedFormat} that `
      + 'was asked for — whatever reads this next should not assume JSONL');
  }

  if (outPath) {
    const failed = write(outPath, data.content);
    if (failed) { stderr(`${failed}\n`); return 1; }
    const note = gitNote(outPath);
    if (note) notes.push(note);
    stdout(`${summary}\n`);
  } else {
    // The payload owns stdout; the summary steps aside so a pipe gets only the record.
    stdout(data.content);
    stderr(`${summary}\n`);
  }
  for (const n of notes) stderr(`note: ${n}\n`);
  return 0;
}

/** A listing or a scan. */
function emitEntries(data, { args, run, outPath, stdout, stderr }) {
  const entries = Array.isArray(data.entries) ? data.entries : [];

  const envelope = {
    ok: true,
    mode: args.mode,
    run: run || '(all runs)',
    allRuns: args.allRuns === true,
    count: entries.length,
    totalVisible: data.totalVisible ?? 0,
    droppedDerived: data.droppedDerived ?? 0,
    excludeDerivedFallbackUsed: data.excludeDerivedFallbackUsed === true,
    projectionFallbackUsed: data.projectionFallbackUsed === true,
    truncated: data.truncated === true,
    truncatedReason: data.truncatedReason ?? '',
    pages: data.pages ?? 1,
    nextPageToken: data.nextPageToken ?? '',
    entries,
  };

  const payload = args.json
    ? JSON.stringify(envelope)
    : args.jsonl
      ? `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`
      : `${entries.map(row).join('\n')}\n`;

  const summary = `run ${envelope.run} · ${entries.length} entries shown · `
    + `${envelope.totalVisible} visible upstream`
    + (envelope.pages > 1 ? ` · ${envelope.pages} pages` : '');

  if (outPath) {
    const failed = write(outPath, payload);
    if (failed) { stderr(`${failed}\n`); return 1; }
    stdout(`wrote ${outPath} — ${Buffer.byteLength(payload)} bytes, ${entries.length} entries\n`);
    const note = gitNote(outPath);
    if (note) stderr(`note: ${note}\n`);
  } else {
    stdout(payload);
    if (!args.json) stderr(`${summary}\n`);
  }
  for (const n of findings(envelope)) stderr(`note: ${n}\n`);
  return 0;
}

/**
 * The write itself. Only ever reached with the whole payload already in hand, which is what
 * makes "a failure writes no file" true rather than aspirational.
 *
 * `wx` is `O_CREAT | O_EXCL`: `checkOutPath` already refused an existing path, but that check
 * and this write are two syscalls apart and the file can appear in between. Refusing at the
 * kernel is the only version of "does not overwrite" that is actually a guarantee.
 *
 * @returns {string} `''`, or the sentence to print instead of a success line
 */
function write(abs, text) {
  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, { encoding: 'utf8', flag: 'wx' });
    return '';
  } catch (err) {
    return `could not write ${abs}: ${err?.message ?? err}`;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Guarded the same way as `bin/auth.src.mjs`: the tests import this module and drive `main()`
// with captured streams, so it must not run itself on import.
const selfPath = fileURLToPath(import.meta.url);
const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';

if (entryPath === selfPath) {
  // A person is watching this one, so it is allowed to fail out loud — but a stack trace is
  // never the right output, and the exit code carries the verdict.
  process.exitCode = await main().catch((err) => {
    process.stderr.write(`activity could not run: ${err?.message ?? err}\n`);
    return 1;
  });
}
