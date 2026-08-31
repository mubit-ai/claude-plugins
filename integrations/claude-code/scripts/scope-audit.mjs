#!/usr/bin/env node
// @ts-check
/**
 * `scripts/scope-audit.mjs` — a census of stored lesson scope.
 *
 * `scripts/mubit-inspect.mjs` reads what a run was *given*. This reads what runs have
 * *written*: how many lessons are stored, at what scope, how many are visible outside the run
 * that wrote them, and whatever the instance has stamped about promotion. It is the only place
 * those answers are a number rather than an anecdote.
 *
 * ## Why this was rewritten rather than extended
 *
 * The version this replaces asked `POST /v2/control/lessons` with a deliberately empty
 * `run_id` — which is the same request that made `mubit_lessons` read across runs. The tool
 * whose whole purpose was to measure that behaviour was riding on it. It also inherited that
 * route's other property: a request for rows at a named scope comes back short against a real
 * instance, so the audit read a confident zero on an instance holding hundreds of lessons.
 *
 * A zero that means "the query was wrong" and a zero that means "nothing has ever been
 * promoted" are the same character on screen and opposite conclusions. That is the failure
 * this file exists to remove, so it goes through `lessonCensus()` instead: the activity feed
 * collects and sorts before it pages, and it reports when it gave up.
 *
 * ## Two properties that are not negotiable
 *
 *   1. **A truncated census exits non-zero, and every count it prints is named a floor.** A
 *      short answer that says it is short is usable. A short answer that looks complete is the
 *      false artefact again, and the exit code is what stops a script believing it.
 *
 *   2. **"Nothing was stamped" and "stamped, and the answer is zero" are different rows.**
 *      They have different causes and different fixes. Promotion metadata is emitted verbatim,
 *      never summarised, for the same reason: whatever the instance stamps is the evidence,
 *      and this script's job is to show it rather than to have an opinion about it.
 *
 * ## Structured as `main(argv, env, io)`
 *
 * Same shape as `bin/activity.src.mjs`, and for the same reason: it is testable against a fake
 * server with no network and no terminal. A reading is only worth as much as the confidence
 * that the tool producing it is correct.
 *
 * Read-only throughout. `lessonCensus` dials on the read-only options, so an audit can never
 * record a health verdict against an endpoint the hooks are using at the same time.
 *
 * Usage:
 *   node scripts/scope-audit.mjs                    # census against the stored credential
 *   node scripts/scope-audit.mjs --json             # the same data, machine-readable
 *   node scripts/scope-audit.mjs --run <id>         # one run only
 *   MUBIT_ENDPOINT=... MUBIT_API_KEY=... node scripts/scope-audit.mjs
 *
 * Exit codes: 0 a complete census, 1 a failure or a truncated census, 2 a bad argument.
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lessonCensus } from '../lib/activity.mjs';
import { loadConfig } from '../lib/config.mjs';

/** The scopes a lesson can carry, narrowest first. Anything else is reported as it arrived. */
const SCOPES = ['run', 'session', 'global', 'org'];

const USAGE = `scope-audit — what is stored, at what scope, and how much of it travels.

  node scripts/scope-audit.mjs [options]

  --run <id>     census one run only (default: every run this key can see)
  --limit N      rows per page (default 500, the route's ceiling)
  --json         machine-readable output on stdout
  -h, --help     this

  Endpoint and key resolve through the plugin's own config: MUBIT_ENDPOINT / MUBIT_API_KEY,
  else the stored credential in the plugin data dir. Nothing is written and no key is printed.

  Exits 1 when the census was cut short — a partial reading is not a measurement.
`;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { json: false, help: false, run: '', limit: 0, error: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--run') {
      out.run = String(argv[++i] ?? '');
      if (!out.run) return { ...out, error: '--run needs a run id' };
    } else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) return { ...out, error: '--limit needs a positive number' };
      out.limit = Math.floor(n);
    } else return { ...out, error: `unknown flag ${a}` };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/**
 * The author family: `source` on a stored lesson is `<family>:<source_run_id>`, and a run id
 * may itself be namespaced with `::`, so the split has to be on the FIRST colon only.
 * @param {string} source
 */
function family(source) {
  return String(source || '').split(':')[0].trim().toLowerCase() || '(none)';
}

/**
 * The run a lesson came from.
 *
 * The two routes the plugin reads lessons through spell this differently — bare on one,
 * namespaced on the other — so the trailing segment is what identifies one run across both.
 * @param {Record<string, any>} row
 */
function originRun(row) {
  const raw = String(row.sourceRunId || row.runId || '');
  return String(raw.split('::').pop() || '').trim();
}

/**
 * Count the census into the report.
 *
 * @param {Record<string, any>} data a `lessonCensus` payload
 * @returns {Record<string, any>}
 */
function shape(data) {
  const lessons = Array.isArray(data.lessons) ? data.lessons : [];

  // Counted into Maps: these keys come from an instance's metadata, and `obj['__proto__'] = n`
  // on a plain object silently sets nothing at all.
  /** @type {Map<string, number>} */ const byScope = new Map();
  /** @type {Map<string, number>} */ const byAuthor = new Map();
  /** @type {Set<string>} */ const origins = new Set();
  /** @type {Set<string>} */ const escapedOrigins = new Set();
  /** @type {Record<string, any>[]} */ const promotionRows = [];

  let escaped = 0;
  let unknownScope = 0;
  let stampedCandidates = 0;

  for (const row of lessons) {
    const scope = String(row.scope || '');
    byScope.set(scope, (byScope.get(scope) ?? 0) + 1);
    byAuthor.set(family(row.source), (byAuthor.get(family(row.source)) ?? 0) + 1);
    if (!row.scopeKnown) unknownScope += 1;

    const origin = originRun(row);
    if (origin) origins.add(origin);

    // "Visible outside the run that wrote it" — the one number this audit exists to produce.
    if (scope !== 'run') {
      escaped += 1;
      if (origin) escapedOrigins.add(origin);
    }

    if (row.promotionStamped) {
      if (row.promotionCandidate === true) stampedCandidates += 1;
      promotionRows.push({
        id: row.id,
        scope,
        source_run_id: row.sourceRunId,
        // Verbatim. Whatever the instance stamped is the evidence; a summary of it is this
        // script's opinion, and an opinion is not what anybody runs an audit for.
        promotion_candidate: row.promotionCandidate,
        promotion_quarantined: row.promotionQuarantined,
        promotion_shadow_stats: row.promotionShadowStats,
      });
    }
  }

  return {
    total: lessons.length,
    byScope: Object.fromEntries(byScope),
    byAuthor: Object.fromEntries(byAuthor),
    unknownScope,
    escaped,
    originRuns: origins.size,
    escapedOriginRuns: escapedOrigins.size,
    promotion: {
      stamped: promotionRows.length,
      // `null`, not `0`. With nothing stamped there is no candidate count to report, and a
      // zero here would answer a question the instance never answered.
      candidates: promotionRows.length ? stampedCandidates : null,
      rows: promotionRows,
    },
    truncated: !!data.truncated,
    truncatedReason: String(data.truncatedReason || ''),
    countsAreFloor: !!data.truncated,
    pages: data.pages,
    elapsedMs: data.elapsedMs,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, any>} a
 * @param {{endpoint: string, run: string, at: string}} meta
 */
function render(a, meta) {
  const out = [];
  const floor = a.countsAreFloor ? '  (a floor)' : '';

  out.push('mubit scope-audit — what is stored, at what scope, and how much of it travels');
  out.push(`endpoint  ${meta.endpoint}`);
  out.push(`scope     ${meta.run || 'every run this key can see'}`);
  out.push(`read      ${a.pages} page${a.pages === 1 ? '' : 's'} in ${a.elapsedMs}ms`);
  out.push('');

  out.push(`lessons stored                             ${a.total}${floor}`);
  out.push(`  visible outside the run that wrote them  ${a.escaped}${floor}`);
  out.push(`  runs that wrote one of those             ${a.escapedOriginRuns}`);
  out.push(`distinct origin runs                       ${a.originRuns}`);
  if (a.unknownScope) {
    out.push(`  metadata never stated a scope            ${a.unknownScope}`);
  }
  out.push('');

  out.push('by scope');
  const scopes = [...SCOPES, ...Object.keys(a.byScope).filter((s) => !SCOPES.includes(s))];
  for (const s of scopes) out.push(`  ${s.padEnd(10)} ${String(a.byScope[s] ?? 0).padStart(5)}`);
  out.push('');

  out.push('by author');
  for (const [k, n] of Object.entries(a.byAuthor).sort()) {
    out.push(`  ${String(k).padEnd(20)} ${String(n).padStart(5)}`);
  }
  out.push('');

  // The two facts that must never render as the same zero.
  out.push('promotion');
  if (a.promotion.stamped === 0) {
    out.push('  This instance stamped no promotion metadata on any of these lessons. That is');
    out.push('  not "zero candidates" — it is no answer at all, and the two have different');
    out.push('  causes. Nothing about promotion can be concluded from this reading.');
  } else {
    out.push(`  lessons carrying promotion metadata      ${a.promotion.stamped}${floor}`);
    out.push(`  of those, promotion_candidate: true      ${a.promotion.candidates}`);
    out.push('');
    out.push('  verbatim, as the instance stamped it:');
    for (const r of a.promotion.rows) {
      out.push(`    ${r.id}  scope=${r.scope}`);
      out.push(`      promotion_candidate     ${JSON.stringify(r.promotion_candidate)}`);
      out.push(`      promotion_quarantined   ${JSON.stringify(r.promotion_quarantined)}`);
      out.push(`      promotion_shadow_stats  ${JSON.stringify(r.promotion_shadow_stats)}`);
    }
  }

  if (a.countsAreFloor) {
    out.push('');
    out.push(`WARNING: the census was cut short (${a.truncatedReason}). Every count above is a`);
    out.push('         FLOOR, not a total, and this command exits non-zero so that nothing');
    out.push('         reading it can mistake a partial reading for a measurement.');
  }

  out.push('');
  out.push(`read at ${meta.at}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * @param {string[]} [argv]
 * @param {Record<string, string|undefined>} [env]
 * @param {{stdout?: (s: string) => void, stderr?: (s: string) => void}} [io]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  const stdout = io.stdout ?? ((s) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s));

  const args = parseArgs(argv);
  if (args.error) { stderr(`scope-audit: ${args.error}\n\n${USAGE}`); return 2; }
  if (args.help) { stdout(USAGE); return 0; }

  /** @type {Record<string, any>} */
  let cfg;
  try {
    cfg = loadConfig(env);
  } catch (err) {
    stderr(`scope-audit: could not resolve configuration: ${message(err)}\n`);
    return 1;
  }
  if (!cfg.endpoint || !cfg.apiKey) {
    stderr('scope-audit: no endpoint or key — set MUBIT_ENDPOINT and MUBIT_API_KEY, or run '
      + '/mubit-memory:auth to store a credential.\n');
    return 1;
  }

  const census = await lessonCensus(cfg, {
    run: args.run,
    ...(args.limit ? { limit: args.limit } : {}),
  });
  if (!census.ok) {
    // No report at all. A report is a claim, and there is nothing here to stand behind.
    stderr(`scope-audit: the activity feed could not be read (${census.code}): ${census.message}\n`);
    return 1;
  }

  const a = shape(census.data);
  const meta = { endpoint: String(cfg.endpoint), run: args.run, at: new Date().toISOString() };

  if (args.json) stdout(`${JSON.stringify({ ...meta, ...a }, null, 2)}\n`);
  else stdout(`${render(a, meta)}\n`);

  // The exit code carries the verdict where nothing is reading the prose.
  return a.countsAreFloor ? 1 : 0;
}

/** @param {unknown} err */
function message(err) {
  return err instanceof Error ? err.message : String(err);
}

// Guarded the same way as `bin/activity.src.mjs`: the tests import this module and drive
// `main()` with captured streams, so it must not run itself on import. `import.meta.url` is
// symlink-resolved by the loader and `process.argv[1]` is not, so both are resolved here.
/** @param {string} p */
function realPath(p) {
  try { return p ? realpathSync(p) : p; } catch { return p; }
}

const selfReal = realPath(fileURLToPath(import.meta.url));
const entryPath = process.argv[1] ? realPath(resolve(process.argv[1])) : '';

if (entryPath === selfReal) {
  process.exitCode = await main().catch((err) => {
    process.stderr.write(`scope-audit could not run: ${message(err)}\n`);
    return 1;
  });
}
