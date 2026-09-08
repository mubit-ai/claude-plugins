// @ts-check
/**
 * `bin/import.src.mjs` — what `/mubit-memory:import` runs. Bundled to `bin/import.mjs`.
 *
 * ## What it does, said plainly
 *
 * It reads the agent transcripts already on this machine — Claude Code's under
 * `~/.claude/projects`, Codex's under `~/.codex/sessions` — and sends what they hold to the
 * configured Mubit instance. That is a bulk upload of months of somebody's work, so the
 * command is built around three properties and every one of them is a refusal rather than a
 * warning:
 *
 *   - **Nothing happens without a person.** `disable-model-invocation: true` on the skill, and
 *     `--dry-run` is what runs when nobody says otherwise. A conversation must not be able to
 *     decide on its own to ship a history to a server.
 *   - **The default scope is this project**, plus the git worktrees linked to it. `--all` is
 *     the whole machine and is a flag somebody types.
 *   - **The bound is always reported.** `lib/activity.mjs`'s `truncatedReason` contract: an
 *     answer that stopped at a cap and does not say so reads as a complete one.
 *
 * ## Why `--dry-run` is the default and `--send` is the verb
 *
 * Every other command in this plugin reads. This one writes to somebody else's server, in
 * volume, irreversibly from the client's point of view. Making the safe mode the default
 * inverts the usual CLI convention on purpose: the cost of a surprise `--dry-run` is a wasted
 * minute, and the cost of a surprise send is a copy of a year of work on an instance the user
 * had not decided to put it on yet.
 *
 * ## Two sources
 *
 * `--source claude-code|codex|all` picks which host's transcripts are read. The default is the
 * host this copy of the plugin is running under, because that is the history the person in
 * front of it most plausibly means; `all` is typed. Both sources share one scope, one item
 * budget, one set of cursors and one redaction pipeline, and the report counts each one
 * separately so the number can be checked against the directory it came from.
 *
 * ## Resuming
 *
 * `lib/import.mjs` holds one cursor per transcript file, so a second run over unchanged files
 * reads nothing and posts nothing. That is what makes an interrupted import safe to repeat —
 * and it is a claim about *this client's* bookkeeping, not about what the server stored. The
 * two are different claims and the module header says which is which.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { codexSource, rolloutRoot } from '../lib/codex-import.mjs';
import { host, loadConfig, isConfigured } from '../lib/config.mjs';
import { claudeCodeSource, discoverTranscripts, encodeProjectDir, linkedRoots, runImport, transcriptRoot } from '../lib/import.mjs';

const USAGE = `mubit-memory: backfill memory from the transcripts already on this machine.

  node bin/import.mjs [options]

Nothing is sent without --send. The default is a dry run.

Scope
  --project <dir>      the project to import; the default is the working directory
  --all                every project on this machine, not just this one and its worktrees
  --source <which>     claude-code, codex, or all (default: the host this plugin runs under)
  --max <n>            stop after n items (default 5000)
  --max-files <n>      stop after n transcript files per source

Action
  --dry-run            count what would be sent and send nothing (the default)
  --send               actually ingest

Pace
  --batch <n>          items per request (default 32)
  --pace <ms>          milliseconds between requests (default 200)

Output
  --json               one JSON report on stdout
  -h, --help
`;

const VALUED = new Set(['--project', '--source', '--max', '--max-files', '--batch', '--pace']);
const BARE = new Set(['--all', '--dry-run', '--send', '--json', '--help', '-h']);

/** The sources `--source` may name, by name. */
const SOURCES = Object.freeze({ 'claude-code': claudeCodeSource, codex: codexSource });

/**
 * Parse argv into an intent, or into an error.
 *
 * An unknown flag is a refusal rather than a shrug, on `bin/activity.src.mjs`'s reasoning and
 * with more at stake here: a mistyped `--dry-run` that was quietly ignored would send.
 *
 * @param {string[]} argv
 * @returns {Record<string, any>}
 */
export function parseArgs(argv = []) {
  /** @type {Record<string, any>} */
  const out = {
    project: '', source: '', all: false, send: false, json: false, help: false,
    max: 0, maxFiles: 0, batch: 0, pace: -1, error: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (VALUED.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || String(v).startsWith('--')) { out.error = `${a} needs a value`; return out; }
      i += 1;
      if (a === '--project') { out.project = String(v).trim(); continue; }
      if (a === '--source') {
        const which = String(v).trim().toLowerCase();
        if (which !== 'all' && !Object.prototype.hasOwnProperty.call(SOURCES, which)) {
          out.error = `--source must be claude-code, codex, or all (got ${which || 'nothing'})`;
          return out;
        }
        out.source = which;
        continue;
      }

      // Validated here rather than after the loop, because "not given" and "given as 0" are
      // different intents and only the second is an error. A `--max 0` treated as "unset"
      // would run the default 5000 for somebody who asked for none.
      const n = Number(v);
      if (a === '--pace') {
        if (!Number.isFinite(n) || n < 0) { out.error = '--pace must be zero or more'; return out; }
        out.pace = n;
        continue;
      }
      if (!Number.isFinite(n) || n <= 0) { out.error = `${a} must be a positive number`; return out; }
      if (a === '--max') out.max = n;
      else if (a === '--max-files') out.maxFiles = n;
      else if (a === '--batch') out.batch = n;
      continue;
    }
    if (!BARE.has(a)) { out.error = `unknown flag: ${a}`; return out; }
    if (a === '--all') out.all = true;
    else if (a === '--send') out.send = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    // `--dry-run` is the default, so naming it explicitly sets nothing. It is accepted because
    // a person who types it is asking for the safe mode and must not be told it is unknown.
  }

  return out;
}

/**
 * @param {string[]} argv
 * @param {{stdout?: (s: string) => void, stderr?: (s: string) => void, env?: Record<string, any>}} [io]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const err = io.stderr ?? ((s) => process.stderr.write(s));
  const env = io.env ?? process.env;

  const args = parseArgs(argv);
  if (args.help) { out(USAGE); return 0; }
  if (args.error) { err(`${args.error}\n\n${USAGE}`); return 2; }

  const cfg = loadConfig(env);
  if (!isConfigured(cfg)) {
    err('no endpoint is configured. Run /mubit-memory:setup first.\n');
    return 1;
  }

  const projectDir = args.project ? resolve(args.project) : (cfg.projectDir || process.cwd());
  const roots = args.all ? [] : linkedRoots(projectDir);
  const which = args.source || host(env);
  const sources = which === 'all' ? Object.values(SOURCES) : [SOURCES[which]];
  const sourceRoots = { 'claude-code': transcriptRoot(env), codex: rolloutRoot(env) };

  // The scope is stated before anything is read, because "which projects" is the one thing a
  // person needs to check before a bulk upload and the one thing a summary printed afterwards
  // cannot help with.
  if (!args.json) {
    for (const s of sources) err(`${s.name.padEnd(12)} ${sourceRoots[s.name]}\n`);
    err(args.all
      ? 'scope:       EVERY project on this machine\n'
      : `scope:       ${roots.join('\n             ')}\n`);
  }

  const report = await runImport(cfg, {
    env,
    roots: args.all ? [] : roots,
    all: args.all,
    dryRun: !args.send,
    sources,
    sourceRoots,
    ...(args.max ? { maxItems: args.max } : {}),
    ...(args.maxFiles ? { maxFiles: args.maxFiles } : {}),
    ...(args.batch ? { batchSize: args.batch } : {}),
    ...(args.pace !== -1 ? { paceMs: args.pace } : {}),
  });

  if (args.json) {
    out(`${JSON.stringify(report)}\n`);
  } else {
    const verb = report.dryRun ? 'would send' : 'sent';
    out(`${verb} ${report.items} item(s) from ${report.files} transcript(s) `
      + `across ${report.runs.length} run(s) in ${Math.round(report.ms / 1000)}s\n`);
    // One line per source, so the number can be checked against the directory it came from.
    for (const [name, c] of Object.entries(report.sources ?? {})) {
      out(`  ${name.padEnd(12)} ${c.items} item(s) from ${c.files} transcript(s)`
        + ` · denied ${c.denied} · skipped ${c.skipped}\n`);
    }
    if (report.runs.length) out(`runs: ${report.runs.join(', ')}\n`);
    err(`lines ${report.lines} · batches ${report.batches} · skipped ${report.skipped}`
      + ` · denied ${report.denied} · oversize ${report.oversize} · failed ${report.failed}\n`);
    // `failed 1` is a count, not a reason. The reason used to go only to the log, and a person
    // reading the terminal — or the model relaying it — had nothing to act on.
    if (report.error) err(`ingest failed (${report.errorState || 'unknown'}): ${report.error}\n`);
    // Three findings rather than decoration, in the order a reader needs them.
    if (report.denied) {
      err(`${report.denied} tool call(s) were dropped by the path denylist — a denied subject `
        + 'is dropped whole, never scrubbed.\n');
    }
    if (report.oversize) {
      err(`${report.oversize} line(s) were over the reader's size cap and were skipped.\n`);
    }
    if (report.truncatedReason) err(`this answer is incomplete: ${report.truncatedReason}\n`);
    if (report.dryRun) err('nothing was sent. Add --send to ingest.\n');
  }

  return report.failed > 0 ? 1 : 0;
}

/**
 * How many transcripts the current scope can see, without reading any of them. Exported for
 * the skill's "how big is this" question and for the tests.
 * @param {{root?: string, roots?: string[]}} o
 */
export function scopeSize(o = {}) {
  const prefixes = (o.roots ?? []).map(encodeProjectDir);
  const filter = prefixes.length
    ? (name) => prefixes.some((p) => name === p || name.startsWith(p))
    : undefined;
  return discoverTranscripts({ root: o.root, dirFilter: filter });
}

// Guarded the same way as `bin/auth.src.mjs` and `bin/activity.src.mjs`: the tests import this
// module and drive `main()` with captured streams, so it must not run itself on import.
const selfPath = fileURLToPath(import.meta.url);
const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';

if (entryPath === selfPath) {
  process.exitCode = await main().catch((e) => {
    process.stderr.write(`import could not run: ${e?.message ?? e}\n`);
    return 1;
  });
}
