#!/usr/bin/env node
// @ts-check
/**
 * `scripts/scope-audit.mjs` — the server-side ledger for cross-run lesson scope.
 *
 * `scripts/mubit-inspect.mjs` reads what a run was *given*. This reads what runs have
 * *written*: the census of stored lessons by scope and by author, which is the only place
 * the cross-run leak is visible as a number rather than an anecdote.
 *
 * The defect it exists to measure: the bundled SDK hard-codes `lesson_scope: "session"` on
 * `mubit_learned`, and the server surfaces every lesson whose scope is not `run` to *other*
 * runs — session, global and org scope are all cross-run by design. So an agent-written
 * lesson followed its author into unrelated projects. `mcp/src/egress.mjs` clamps that at the wire; this script is how
 * you tell whether the clamp held.
 *
 * Three numbers, in the order they matter:
 *
 *   1. **agent-authored lessons at cross-run scope** — the direct count of the defect. It
 *      must stop growing. A run of this before the guard lands and one after is the whole
 *      measurement; without the first, the second means nothing.
 *   2. **distinct originating runs among them** — the blast radius. One noisy run and
 *      twenty leaking runs are different problems.
 *   3. **reflection-authored lessons at each scope** — the control. Reflection is the
 *      sanctioned path that widens a lesson beyond its run, so this row answers the
 *      question the headline cannot: did we break memory to fix isolation? It must be
 *      unchanged.
 *
 * **Read-only, and deliberately not via `lib/http.mjs`.** `postLessons` would be the
 * obvious reuse, but `request()` records breaker state by default — a "read-only" audit
 * that wrote into the health cache and could trip the breaker for the hooks running beside
 * it. Every other script in `scripts/` imports node builtins only; this one follows
 * `mubit-inspect.mjs` — its `creds()` precedence, and a raw `fetch`. It writes nothing and
 * never prints an API key.
 *
 * Usage:
 *   node scripts/scope-audit.mjs                    # census against the stored credential
 *   node scripts/scope-audit.mjs --data <dir>       # pin one data dir
 *   node scripts/scope-audit.mjs --user <id>        # audit one logical user's lessons
 *   node scripts/scope-audit.mjs --json             # the same data, machine-readable
 *   MUBIT_ENDPOINT=... MUBIT_API_KEY=... node scripts/scope-audit.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * The four scopes a lesson can carry. `run` is the control: it is the one scope the
 * cross-run overlay skips, so it belongs in the table as the denominator even though it is
 * never part of the headline.
 */
const SCOPES = ['run', 'session', 'global', 'org'];

/** Everything but `run` is read by other runs, which is what "cross-run" means here. */
const CROSS_RUN = SCOPES.filter((s) => s !== 'run');

/**
 * Author families, keyed off the part of `source` before the first `:`.
 *
 * The wire disagrees with the obvious guess in both directions, so both are pinned here
 * rather than inferred. `agent` is what the ingest item carries (`mcp/dist/server.js` sends
 * `source: "agent"`, and the service defaults an absent source to the same string) — an
 * audit filtering on `mcp-agent` would report a permanent zero and read as "the defect
 * never existed". And reflection arrives as two families, `reflection` and `auto-reflect`,
 * not one.
 */
const AGENT_SOURCES = ['agent', 'mcp-agent'];
const REFLECTION_SOURCES = ['reflection', 'auto-reflect'];

/** `ListLessons` clamps `limit` to 200 server-side; asking for more is silently capped. */
const MAX_LIMIT = 200;

/* -------------------------------------------------------------------------- */
/* args                                                                        */
/* -------------------------------------------------------------------------- */

const HELP = `scope-audit — what is stored at cross-run scope, and who wrote it

  --data <dir>       pin one data dir (default: every ~/.claude/plugins/data/mubit-memory*)
  --user <id>        filter to one logical user (default: no filter — the whole tenant)
  --limit N          lessons to request per scope (default ${MAX_LIMIT}, the server's cap)
  --json             machine-readable output
  -h, --help         this

  Endpoint and key come from MUBIT_ENDPOINT / MUBIT_API_KEY, else the pinned data dir's
  credentials.json. Env wins, and the source is printed — a shell that still exports a
  localhost endpoint would otherwise audit the wrong instance in silence.
`;

function parseArgs(argv) {
  const out = { json: false, help: false, limit: MAX_LIMIT, user: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--data') out.data = String(argv[++i] || '');
    else if (a === '--user') out.user = String(argv[++i] || '');
    else if (a === '--limit') out.limit = Math.min(MAX_LIMIT, Math.max(1, Number(argv[++i]) || MAX_LIMIT));
    else fail(`unknown flag ${a} (try --help)`);
  }
  return out;
}

function fail(msg) { process.stderr.write(`scope-audit: ${msg}\n`); process.exit(2); }

/* -------------------------------------------------------------------------- */
/* credentials                                                                 */
/* -------------------------------------------------------------------------- */

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function lsDir(path) {
  try { return readdirSync(path); } catch { return []; }
}

/** Same discovery `mubit-inspect.mjs` uses: install flavour decides the directory suffix. */
function dataDirs(pin) {
  if (pin) return [pin];
  const root = join(homedir(), '.claude', 'plugins', 'data');
  return lsDir(root)
    .filter((n) => n.startsWith('mubit-memory'))
    .map((n) => join(root, n))
    .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
}

/** Env beats the stored credential, exactly as `lib/config.mjs` orders them. */
function creds(pin) {
  if (process.env.MUBIT_ENDPOINT && process.env.MUBIT_API_KEY) {
    return { endpoint: process.env.MUBIT_ENDPOINT, apiKey: process.env.MUBIT_API_KEY, from: 'env' };
  }
  for (const dir of dataDirs(pin)) {
    const stored = readJson(join(dir, 'credentials.json'), {}) || {};
    const endpoint = process.env.MUBIT_ENDPOINT || stored.endpoint || '';
    const apiKey = process.env.MUBIT_API_KEY || stored.apiKey || '';
    if (endpoint && apiKey) {
      return {
        endpoint,
        apiKey,
        from: process.env.MUBIT_ENDPOINT && process.env.MUBIT_API_KEY
          ? 'env'
          : `${dir}/credentials.json`,
      };
    }
  }
  return { endpoint: '', apiKey: '', from: 'nowhere' };
}

/* -------------------------------------------------------------------------- */
/* the query                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `POST /v2/control/lessons` is the one control route with no required `run_id`; an absent
 * run means "every run", which is exactly the census this wants. An empty `user_id` means
 * no user filter — passing one narrows to lessons stored under that logical user, which on
 * a single-principal instance is usually zero.
 *
 * @param {{endpoint: string, apiKey: string}} c
 * @param {string} scope
 * @param {{limit: number, user: string}} opts
 */
async function listLessons(c, scope, opts) {
  const url = `${c.endpoint.replace(/\/+$/, '')}/v2/control/lessons`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ run_id: '', user_id: opts.user, scope, limit: opts.limit }),
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* reported below as a non-JSON answer */ }
  if (res.status !== 200) {
    return { scope, error: `HTTP ${res.status} ${raw.slice(0, 200)}`, lessons: [] };
  }
  if (!parsed || !Array.isArray(parsed.lessons)) {
    return { scope, error: `unexpected answer: ${raw.slice(0, 200)}`, lessons: [] };
  }
  return { scope, error: '', lessons: parsed.lessons };
}

/* -------------------------------------------------------------------------- */
/* shaping                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The author family: `source` on a stored lesson is `<family>:<source_run_id>`, and
 * `source_run_id` is itself a `state::<tenant>::<run>` triple, so the split has to be on
 * the FIRST colon only.
 */
function family(source) {
  return String(source || '').split(':')[0].trim().toLowerCase() || '(none)';
}

function authorOf(source) {
  const f = family(source);
  if (AGENT_SOURCES.includes(f)) return 'agent';
  if (REFLECTION_SOURCES.includes(f)) return 'reflection';
  return 'other';
}

/** The run a lesson came from — the field when it is set, else whatever `source` names. */
function originRun(lesson) {
  const explicit = String(lesson.source_run_id || '').trim();
  if (explicit) return explicit;
  const source = String(lesson.source || '');
  const colon = source.indexOf(':');
  return colon >= 0 ? source.slice(colon + 1) : '';
}

function audit(buckets) {
  /** @type {Record<string, Record<string, number>>} */
  const grid = {};
  for (const s of SCOPES) grid[s] = { agent: 0, reflection: 0, other: 0, total: 0 };

  const crossRunAgentRuns = new Set();
  /** @type {Set<string>} */
  const unclassified = new Set();
  let scanned = 0;

  for (const b of buckets) {
    for (const l of b.lessons) {
      scanned += 1;
      // Trust the row's own `scope` over the bucket it came back in: the filter and the
      // stored value are two different reads of the same metadata, and a disagreement is
      // worth counting where it actually is rather than where it was asked for.
      const scope = SCOPES.includes(String(l.scope)) ? String(l.scope) : b.scope;
      const author = authorOf(l.source);
      grid[scope][author] += 1;
      grid[scope].total += 1;
      if (author === 'other') unclassified.add(family(l.source));
      if (author === 'agent' && scope !== 'run') {
        const run = originRun(l);
        if (run) crossRunAgentRuns.add(run);
      }
    }
  }

  const headline = CROSS_RUN.reduce((n, s) => n + grid[s].agent, 0);
  return {
    scanned,
    grid,
    headline,
    blastRadius: crossRunAgentRuns.size,
    originatingRuns: [...crossRunAgentRuns].sort(),
    reflectionByScope: Object.fromEntries(SCOPES.map((s) => [s, grid[s].reflection])),
    unclassified: [...unclassified].sort(),
    truncated: buckets.filter((b) => b.lessons.length >= MAX_LIMIT).map((b) => b.scope),
    errors: buckets.filter((b) => b.error).map((b) => ({ scope: b.scope, error: b.error })),
  };
}

/* -------------------------------------------------------------------------- */
/* printing                                                                    */
/* -------------------------------------------------------------------------- */

function table(rows, cols) {
  const head = cols.map((c) => c.label);
  const body = rows.map((r) => cols.map((c) => String(c.get(r))));
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells
    .map((c, i) => (cols[i].right ? c.padStart(w[i]) : c.padEnd(w[i])))
    .join('  ')
    .trimEnd();
  return [line(head), ...body.map(line)];
}

function render(a, meta) {
  const out = [];
  out.push('mubit scope-audit — what is stored at cross-run scope, and who wrote it');
  out.push(`endpoint  ${meta.endpoint}  (from ${meta.from})`);
  out.push(`user      ${meta.user || '(no filter — the whole tenant)'}`);
  out.push('');

  out.push(`lessons scanned                        ${a.scanned}`);
  out.push('');
  out.push(`agent-authored at cross-run scope      ${a.headline}    <- the defect`);
  out.push(`  distinct originating runs            ${a.blastRadius}`);
  out.push('');

  out.push('by scope x author');
  const rows = SCOPES.map((s) => ({ scope: s, ...a.grid[s] }));
  for (const line of table(rows, [
    { label: 'scope', get: (r) => r.scope },
    { label: 'agent', get: (r) => r.agent, right: true },
    { label: 'reflection', get: (r) => r.reflection, right: true },
    { label: 'other', get: (r) => r.other, right: true },
    { label: 'total', get: (r) => r.total, right: true },
  ])) out.push(`  ${line}`);
  out.push('');

  // The control. Reflection is the sanctioned way a lesson widens beyond its run, so if
  // this row moved, the clamp caught something it was never aimed at.
  out.push('reflection-authored by scope (the sanctioned widening path — must be unchanged)');
  out.push(`  ${SCOPES.map((s) => `${s} ${a.reflectionByScope[s]}`).join(' · ')}`);

  if (a.originatingRuns.length) {
    out.push('');
    out.push('runs that wrote a cross-run agent lesson');
    for (const r of a.originatingRuns) out.push(`  ${r}`);
  }

  if (a.unclassified.length) {
    out.push('');
    out.push(`unclassified source families (counted under "other"): ${a.unclassified.join(', ')}`);
  }

  // A capped bucket is the one way this can under-report, so it says so rather than
  // printing a number that reads like a total.
  if (a.truncated.length) {
    out.push('');
    out.push(`WARNING: hit the server's ${MAX_LIMIT}-row cap for scope(s) ${a.truncated.join(', ')} —`);
    out.push('         these counts are a floor, not a total.');
  }

  for (const e of a.errors) {
    out.push('');
    out.push(`WARNING: scope ${e.scope} could not be read: ${e.error}`);
  }

  return out.join('\n');
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); return; }

  const c = creds(args.data);
  if (!c.endpoint || !c.apiKey) {
    fail('no endpoint/key — set MUBIT_ENDPOINT and MUBIT_API_KEY, or pass --data <dir> '
      + 'containing a credentials.json');
  }

  const buckets = [];
  for (const scope of SCOPES) {
    try {
      buckets.push(await listLessons(c, scope, { limit: args.limit, user: args.user }));
    } catch (err) {
      buckets.push({ scope, error: String(err && err.message ? err.message : err), lessons: [] });
    }
  }

  const a = audit(buckets);
  const meta = { endpoint: c.endpoint, from: c.from, user: args.user, at: new Date().toISOString() };

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ...meta, ...a }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${render(a, meta)}\n`);
}

main().catch((err) => fail(String(err && err.stack ? err.stack : err)));
