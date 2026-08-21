// @ts-check
/**
 * `bin/link.src.mjs` — what `/mubit-memory:link` runs. Bundled to `bin/link.mjs`.
 *
 * SCOPE.md Target C keeps every lesson at `run` scope and joins runs instead of widening
 * scopes, so a project's reach is the link graph rather than a threshold's good behaviour.
 * `hooks/src/subagent-start.mjs` declares the parent/child edge automatically (§6 Tier 1) and
 * the same-remote offer proposes one (Tier 2). This file is Tier 3: the surface where a person
 * declares an edge nothing could have inferred, and — just as importantly — the surface where
 * they can see what they have already declared.
 *
 * ---------------------------------------------------------------------------
 * Users never see run ids
 * ---------------------------------------------------------------------------
 * `cc-plugin-lab-43f3807e` is `cc-` plus a slug plus eight hex of a git toplevel
 * (`lib/runid.mjs`). It is an implementation detail of the derivation, it changes when the
 * branch strategy changes, and no one can recognise their own project in it. Any UX that asks
 * someone to name one is already wrong, and a UX that merely *prints* one is one release away
 * from asking for it.
 *
 * So this command addresses projects **by directory** and renders directories and relative
 * dates. Run ids are resolved internally, from the session map under `<dataDir>/sessions/`,
 * which already pairs every run with the path it was derived from. No run id appears in any
 * output of this file — human or `--json` — and `test/link.test.mjs` asserts it. The
 * diagnostic surface that does print them is `scripts/mubit-inspect.mjs --runs`, which is for
 * somebody debugging the derivation rather than somebody connecting two projects.
 *
 * ---------------------------------------------------------------------------
 * Mesh, not hub — and this is the decision the next reader will "simplify"
 * ---------------------------------------------------------------------------
 * `linked_runs_for` (ricedb `lib.rs:5654`) returns `scope.linked_run_ids` **without walking
 * them**. The graph is read one hop deep and no further.
 *
 * A hub-and-spoke join therefore does not do what its diagram says. Link A→root and B→root,
 * and from A the consulted set is `[A, root]`: sibling B is never reached, while every surface
 * in the product says A and B are "linked". The bug is silent, it is on the read path, and it
 * looks exactly like memory that simply did not match.
 *
 * So linking a group links **every pair**. §6 measured same-remote sets at 2-4 projects in
 * practice, so O(n^2) is three calls for three projects and six for four — a handful of
 * requests, once, typed by a human. The saving from a star is not worth a graph that is
 * wrong in the direction of "you thought you had access and you did not".
 *
 * `pairsOf` is where this lives, on purpose: it is one function, with one test, that cannot
 * be turned back into a star without deleting it.
 *
 * ---------------------------------------------------------------------------
 * Why this is not an MCP tool
 * ---------------------------------------------------------------------------
 * A link widens what a run may **read**, durably, across every future session. Exposing that
 * to the model is the read-side twin of the hole `mcp/src/egress.mjs` just closed on the write
 * side, and the asymmetry is what settles it: a bad recall costs one turn of noise, and a bad
 * link is silent and permanent until somebody notices an unrelated project bleeding in. The
 * model may notice two repos look related and say so. A human confirms. `skills/link/SKILL.md`
 * carries `disable-model-invocation: true` and grants this binary and nothing else.
 *
 * ---------------------------------------------------------------------------
 * Why this one *does* use `lib/http.mjs`, where `bin/auth.src.mjs` does not
 * ---------------------------------------------------------------------------
 * `auth` dials directly because it runs precisely when the instance is unreachable and the
 * breaker is open, and "I refuse to check because checking failed recently" is a terrible
 * answer to "please log me in".
 *
 * Here the breaker is the right behaviour, because there is a better fallback than a round
 * trip: `lib/links.mjs` is the record of what the user *decided*, the server is the record of
 * what it currently holds, and re-asserting a decision is one idempotent request the next
 * session makes for free. So an unreachable instance costs the assertion and not the decision
 * — recorded locally, reported as exit 2, re-runnable. `list` never dials at all, which is what
 * lets the one surface whose whole promise is "your reach is inspectable" answer offline.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../lib/config.mjs';
import { postLinkRun, postUnlinkRun } from '../lib/http.mjs';
import { forgetLink, readLinks, recordLink } from '../lib/links.mjs';
import { readJson, resolveDataDir } from '../lib/state.mjs';

/** §4.3 writes the session map here; §7 lists it beside `runs/` and `links/`. */
export const SESSIONS_DIR = 'sessions';

/** The three subcommands. `list` is the default because it is the one that answers a question. */
export const COMMANDS = Object.freeze(['list', 'link', 'unlink']);

/**
 * The word that names the run a `/clear` moved away from, for people who would rather type
 * something than a path. Bare `link` means the same thing.
 */
export const PREVIOUS = 'previous';

const GIT_TIMEOUT_MS = 2000;

/**
 * @typedef {object} Project
 * @property {string} runId       resolved internally; never rendered (see the header)
 * @property {string} path        the absolute directory, which is how a user addresses it
 * @property {string} root        its git toplevel, or the directory when it is not a repo
 * @property {number} lastSeenAt
 * @property {boolean} linked
 * @property {string} decision    `linked`, `declined`, or `''` for undecided
 * @property {boolean} previous   the run this session was in before a `/clear`
 * @property {boolean} sameRemote its `origin` matches this project's
 */

// ---------------------------------------------------------------------------
// The session map
// ---------------------------------------------------------------------------

/**
 * Every session record on this machine, newest first.
 *
 * Read straight off disk rather than through `lib/runid.mjs`: `loadSessionMap` answers for one
 * host session id, and the question here is "what runs exist at all". Damage is skipped
 * silently for the same reason `readLinks` returns `[]` for it — a torn write from a SIGKILL
 * is an ordinary state of this directory, and there is no useful branch for it.
 *
 * @param {Record<string, any>} cfg
 * @returns {Array<Record<string, any>>}
 */
export function sessionRecords(cfg) {
  try {
    const dir = join(resolveDataDir(cfg), SESSIONS_DIR);
    if (!existsSync(dir)) return [];
    /** @type {Array<Record<string, any>>} */
    const out = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const rec = readJson(join(dir, f), null);
      if (!isObject(rec) || !str(rec.run_id)) continue;
      out.push(rec);
    }
    return out.sort((a, b) => numOr(b.last_seen_at, 0) - numOr(a.last_seen_at, 0));
  } catch {
    return [];
  }
}

/**
 * Which run this project is in right now, and where it came from.
 *
 * The session map is the authority and the derivation is not, and the `/clear` case is why:
 * after a reset the live run is `<derived>-c1`, which no fresh derivation reproduces. Reading
 * the map also means this command never writes one — deriving through `lib/runid.mjs` would
 * persist a `SessionRecord` for a CLI invocation that is not a session.
 *
 * A `static` pin is honoured first, because on that strategy the map's directories describe
 * where the pinned run has been rather than what it is.
 *
 * @param {Record<string, any>} cfg
 * @param {Array<Record<string, any>>} records
 * @param {{gitRootOf?: (dir: string) => string}} [deps]
 * @returns {{runId: string, path: string, root: string, previousRunId: string}|null}
 */
export function currentRun(cfg, records, deps = {}) {
  const gitRootOf = deps.gitRootOf ?? gitToplevel;
  const here = resolvePath(str(cfg.projectDir) || safeCwd());
  const root = gitRootOf(here) || here;

  const pinned = str(cfg.runStrategy) === 'static' ? str(cfg.runId) : '';
  const mine = records.filter((r) => (pinned
    ? str(r.run_id) === pinned
    : sameProject(r, here, root)));

  const best = mine[0];
  if (best) {
    return {
      runId: str(best.run_id),
      path: resolvePath(str(best.project_dir)) || here,
      root: str(best.project_root) || root,
      previousRunId: str(best.previous_run_id),
    };
  }
  // A pin names its run whether or not a session has ever been recorded under it. Without
  // one there is genuinely nothing to link *from*, and saying so beats inventing a run id.
  if (pinned) return { runId: pinned, path: here, root, previousRunId: '' };
  return null;
}

/**
 * Everything this project could link to, ordered the way the picker renders it.
 *
 * Two sources, unioned on the run id:
 *
 *   - the **session map**, which is every run that has a directory on this machine;
 *   - the **link ledger** for the current run, which is every decision already recorded —
 *     including far ends whose session record has since been pruned, because a link that is
 *     in force must stay visible even when the map that suggested it is gone.
 *
 * Sub-runs are excluded. `SubagentStart` links them automatically (§6 Tier 1) and they share
 * their parent's directory, so listing them would put the same path on screen several times
 * and invite somebody to revoke a join nobody made by hand.
 *
 * @param {Record<string, any>} cfg
 * @param {{runId: string, path: string, root: string, previousRunId: string}} current
 * @param {{records?: Array<Record<string, any>>, remoteOf?: (dir: string) => string,
 *          gitRootOf?: (dir: string) => string}} [deps]
 * @returns {{projects: Project[], otherLinks: number}}
 */
export function listProjects(cfg, current, deps = {}) {
  const records = deps.records ?? sessionRecords(cfg);
  const remoteOf = memo(deps.remoteOf ?? gitOrigin);
  const gitRootOf = memo(deps.gitRootOf ?? gitToplevel);

  const ledger = readLinks(cfg, current.runId);
  /** @type {Map<string, {decision: string, project_dir: string, at: number}>} */
  const decided = new Map();
  for (const e of ledger) decided.set(e.run_id, e);

  /** @type {Map<string, Project>} */
  const byRun = new Map();
  /**
   * @param {string} runId
   * @param {string} path
   * @param {number} lastSeenAt
   * @param {boolean} authoritative  true for the session map, false for the ledger
   */
  const add = (runId, path, lastSeenAt, authoritative) => {
    if (!runId || runId === current.runId || runId.includes('-sub-')) return;
    const dir = resolvePath(path);
    if (!dir) return;
    const seen = byRun.get(runId);
    // Two session records for one run is ordinary — two terminals in one repo — and the newer
    // wins. A ledger entry never overrides one, because its timestamp is when the *decision*
    // was recorded, and a project linked today but last worked in a fortnight ago must render
    // as a fortnight ago or the column means two different things on different rows.
    if (seen && (!authoritative || seen.lastSeenAt >= lastSeenAt)) return;
    const entry = decided.get(runId);
    byRun.set(runId, {
      runId,
      path: dir,
      root: gitRootOf(dir) || dir,
      lastSeenAt,
      linked: entry?.decision === 'linked',
      decision: entry ? String(entry.decision) : '',
      previous: runId === current.previousRunId,
      sameRemote: false,
    });
  };

  for (const r of records) add(str(r.run_id), str(r.project_dir), numOr(r.last_seen_at, 0), true);
  // Only for far ends the session map has no record of — a link made on another machine, or one
  // whose session file has been pruned. `at` is the decision's timestamp, which is the best this
  // machine knows about a project it has never opened.
  for (const e of ledger) add(e.run_id, e.project_dir, e.at, false);

  const mineRemote = remoteOf(current.root);
  const projects = [...byRun.values()];
  for (const p of projects) {
    // Both ends must actually have a remote. Two directories that are not repositories both
    // answer `''`, and calling that a match would group every scratch directory on the machine.
    p.sameRemote = !!mineRemote && remoteOf(p.root) === mineRemote;
  }

  // The `/clear` recovery first, then most recently used. SC-05 records `previous_run_id` for
  // exactly this: it is the single most likely thing somebody running this command wants, and
  // the session record already knows the answer, so the command should not have to ask.
  projects.sort((a, b) => (Number(b.previous) - Number(a.previous)) || (b.lastSeenAt - a.lastSeenAt));

  // Links in force whose far end has no directory here: a run linked from another machine, or
  // a subagent. Counted rather than listed, so reach stays inspectable without a hash on screen.
  const shown = new Set(projects.map((p) => p.runId));
  const otherLinks = ledger.filter((e) => e.decision === 'linked' && !shown.has(e.run_id)).length;

  return { projects, otherLinks };
}

// ---------------------------------------------------------------------------
// The mesh
// ---------------------------------------------------------------------------

/**
 * Every unordered pair from a group, in a stable order.
 *
 * This is the whole of "mesh, not hub" (see the header, and ricedb `lib.rs:5654`): the backend
 * reads `linked_run_ids` one hop deep, so a star leaves the points of the star unable to see
 * each other. Three projects are three pairs, not two spokes.
 *
 * Deduplicated by identity, because linking a group that already contains this project — which
 * is what `link <the directory I am in>` does after a `/clear` — must not try to link a run to
 * itself; `postLinkRun` refuses that outright and it would fail the whole command.
 *
 * @template {{runId: string}} T
 * @param {T[]} sides
 * @returns {Array<[T, T]>}
 */
export function pairsOf(sides) {
  /** @type {T[]} */
  const uniq = [];
  for (const s of sides ?? []) {
    if (!s || !str(s.runId)) continue;
    if (uniq.some((u) => u.runId === s.runId)) continue;
    uniq.push(s);
  }
  /** @type {Array<[T, T]>} */
  const out = [];
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) out.push([uniq[i], uniq[j]]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Addressing — a directory in, a project out
// ---------------------------------------------------------------------------

/**
 * Resolve one thing a user typed to one project.
 *
 * Accepts an absolute path, a `~`-relative one, a path relative to the working directory, the
 * word `previous`, and — when it is unambiguous — a trailing fragment such as `pre-main`. The
 * last one exists because the picker renders `~/Mubit/pre-main` and somebody reading that line
 * will type the part that identifies it; refusing on a technicality when exactly one project
 * matches is pedantry, and refusing when several do is the honest answer.
 *
 * @param {Project[]} projects
 * @param {string} token
 * @param {{home?: string, cwd?: string}} [ctx]
 * @returns {{ok: true, project: Project}|{ok: false, state: string, detail: string}}
 */
export function matchProject(projects, token, ctx = {}) {
  const raw = str(token);
  if (!raw) return { ok: false, state: 'no_target', detail: 'Name a project directory to link.' };

  if (raw.toLowerCase() === PREVIOUS) {
    const p = projects.find((x) => x.previous);
    return p ? { ok: true, project: p } : {
      ok: false,
      state: 'unknown_project',
      detail: 'This session was not reached by /clear, so there is no previous project to reconnect.',
    };
  }

  const want = expandPath(raw, ctx.home ?? '', ctx.cwd ?? '');
  const exact = projects.filter((p) => p.path === want || p.root === want);
  if (exact.length === 1) return { ok: true, project: exact[0] };
  if (exact.length > 1) return ambiguous(exact, raw, ctx);

  const needle = raw.replace(/\/+$/, '');
  const partial = projects.filter((p) => endsWithSegment(p.path, needle) || endsWithSegment(p.root, needle));
  if (partial.length === 1) return { ok: true, project: partial[0] };
  if (partial.length > 1) return ambiguous(partial, raw, ctx);

  return {
    ok: false,
    state: 'unknown_project',
    detail: `No project on this machine matches ${JSON.stringify(raw)}. `
      + 'Run `list` to see the directories Mubit has memory for.',
  };
}

/** @returns {{ok: false, state: string, detail: string}} */
function ambiguous(hits, raw, ctx) {
  const home = ctx.home ?? '';
  return {
    ok: false,
    state: 'ambiguous',
    detail: `${JSON.stringify(raw)} matches ${hits.length} projects: `
      + `${hits.map((p) => tildify(p.path, home)).join(', ')}. Name one of them in full.`,
  };
}

/** @param {string} path @param {string} needle */
function endsWithSegment(path, needle) {
  if (!path || !needle) return false;
  if (path === needle) return true;
  return path.endsWith(needle.startsWith('/') ? needle : `/${needle}`);
}

// ---------------------------------------------------------------------------
// Rendering — directories and dates, never hashes
// ---------------------------------------------------------------------------

/**
 * `/Users/me/Mubit/pre-main` → `~/Mubit/pre-main`. §6 renders paths the way a person writes
 * them; the absolute form is still what `--json` carries, because that is what a script needs.
 * @param {string} p @param {string} home
 * @returns {string}
 */
export function tildify(p, home) {
  const h = str(home).replace(/\/+$/, '');
  if (!h || !p) return p;
  if (p === h) return '~';
  return p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

/**
 * `2d ago`. Deliberately coarse: the question a picker answers is "is this the project I was
 * working in last week", and a timestamp to the second makes that harder to read, not easier.
 * @param {number} then @param {number} now
 * @returns {string}
 */
export function relativeAge(then, now) {
  const t = numOr(then, 0);
  if (!t) return 'unknown';
  const ms = Math.max(0, numOr(now, Date.now()) - t);
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The picker, as §6 draws it.
 *
 * @param {{current: {path: string}, projects: Project[], otherLinks: number}} view
 * @param {{home?: string, now?: number}} [opts]
 * @returns {string}
 */
export function renderList(view, opts = {}) {
  const home = opts.home ?? '';
  const now = opts.now ?? Date.now();
  const lines = [`Memory in this project:  ${tildify(view.current.path, home)}`, ''];

  if (!view.projects.length) {
    lines.push('  No other project on this machine has Mubit memory yet.', '',
      '  This fills in as you open sessions elsewhere: every project gets its own run, and',
      '  linking two of them is what lets recall in one see the other.');
    return lines.join('\n');
  }

  const rows = view.projects.map((p) => ({
    mark: p.linked ? '[x]' : '[ ]',
    dir: tildify(p.path, home),
    age: relativeAge(p.lastSeenAt, now),
    note: noteFor(p),
  }));
  const dirW = Math.max(...rows.map((r) => r.dir.length));
  const ageW = Math.max(...rows.map((r) => r.age.length));
  for (const r of rows) {
    lines.push(`  ${r.mark} ${r.dir.padEnd(dirW)}  ${r.age.padStart(ageW)}${r.note ? `   ${r.note}` : ''}`);
  }

  lines.push('');
  if (view.otherLinks) {
    lines.push(`  ${view.otherLinks} further linked run${view.otherLinks === 1 ? '' : 's'} `
      + 'have no directory here — subagent runs link themselves.');
  }
  lines.push("  linked projects can read each other's memory · unlink to revoke");
  return lines.join('\n');
}

/** @param {Project} p */
function noteFor(p) {
  const notes = [];
  if (p.previous) notes.push('before /clear');
  if (p.sameRemote) notes.push('same remote');
  if (p.decision === 'declined') notes.push('declined');
  return notes.join(' · ');
}

/**
 * The `--json` view of a project. **No run id**, by construction rather than by omission: the
 * absolute path is the handle a caller addresses, and a field carrying the hash would be back
 * in the surface within one release of somebody finding it convenient.
 *
 * @param {Project} p @param {{home?: string, now?: number}} [opts]
 */
function jsonProject(p, opts = {}) {
  return {
    dir: tildify(p.path, opts.home ?? ''),
    path: p.path,
    linked: p.linked,
    decision: p.decision,
    previous: p.previous,
    sameRemote: p.sameRemote,
    lastSeenAt: p.lastSeenAt,
    age: relativeAge(p.lastSeenAt, opts.now ?? Date.now()),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Parse argv into an intent. Separate from `main` so it is testable without running anything.
 * @param {string[]} argv
 * @returns {{command: string, targets: string[], json: boolean}}
 */
export function parseArgs(argv = []) {
  const args = (argv ?? []).filter((a) => typeof a === 'string');
  const json = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('--'));
  const command = COMMANDS.includes(positional[0]) ? positional[0] : 'list';
  const targets = COMMANDS.includes(positional[0]) ? positional.slice(1) : positional;
  return { command, targets, json };
}

/**
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 * @param {{cfg?: Record<string, any>, log?: (m: string) => void, now?: number,
 *          remoteOf?: (dir: string) => string, gitRootOf?: (dir: string) => string}} [deps]
 * @returns {Promise<number>} process exit code
 */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const log = deps.log ?? console.log;
  const cfg = deps.cfg ?? loadConfig(env);
  const args = parseArgs(argv);
  const home = str(env?.HOME);
  const now = deps.now ?? Date.now();
  const emit = (payload) => { log(args.json ? JSON.stringify(payload) : payload.detail); };

  const records = sessionRecords(cfg);
  const current = currentRun(cfg, records, deps);
  if (!current) {
    emit({
      ok: false,
      state: 'no_run',
      detail: 'Mubit has no run for this project yet, so there is nothing to link from. '
        + 'Start a session here first — the run is created at SessionStart.',
    });
    return 1;
  }

  const view = { current, ...listProjects(cfg, current, { ...deps, records }) };
  const shape = (over) => ({
    project: tildify(current.path, home),
    linked: view.projects.filter((p) => p.linked).length + view.otherLinks,
    projects: view.projects.map((p) => jsonProject(p, { home, now })),
    ...over,
  });

  if (args.command === 'list') {
    emit(shape({
      ok: true,
      state: 'listed',
      otherLinks: view.otherLinks,
      detail: renderList(view, { home, now }),
    }));
    return 0;
  }

  // Bare `link` means the `/clear` recovery: SC-05 recorded where the memory went, so the
  // command that reconnects it should not make the user look the answer up first.
  const tokens = args.targets.length
    ? args.targets
    : (args.command === 'link' && view.projects.some((p) => p.previous) ? [PREVIOUS] : []);

  if (!tokens.length) {
    emit(shape({
      ok: false,
      state: 'no_target',
      detail: args.command === 'unlink'
        ? `Name the project to unlink.\n\n${renderList(view, { home, now })}`
        : `Name the project to link, as a directory.\n\n${renderList(view, { home, now })}`,
    }));
    return 1;
  }

  /** @type {Project[]} */
  const targets = [];
  for (const token of tokens) {
    const hit = matchProject(view.projects, token, { home, cwd: current.path });
    if (!hit.ok) {
      emit(shape({ ok: false, state: hit.state, detail: hit.detail }));
      return 1;
    }
    targets.push(hit.project);
  }

  return args.command === 'link'
    ? doLink(cfg, current, targets, { emit, shape, home, now, view })
    : doUnlink(cfg, current, targets, { emit, shape, home, now });
}

/**
 * Link a group, pairwise.
 *
 * The order — assert, then record — is deliberate. A guard refusal (`invalid_request`) means
 * the request was malformed, and writing a decision the wire would never accept would leave a
 * ledger entry that re-assertion can never turn into a join. Every other failure is transport,
 * and the decision is exactly the thing worth keeping: `lib/links.mjs` exists so an unreachable
 * instance costs the assertion and not the intent.
 */
async function doLink(cfg, current, targets, io) {
  const pairs = pairsOf([current, ...targets]);
  const names = targets.map((t) => tildify(t.path, io.home)).join(', ');

  let asserted = 0;
  /** @type {string[]} */
  const problems = [];
  for (const [a, b] of pairs) {
    const res = await postLinkRun(cfg, { run_id: a.runId, linked_run_id: b.runId });
    if (res.ok) { asserted++; continue; }
    if (res.state === 'invalid_request') {
      io.emit(io.shape({
        ok: false,
        state: 'refused',
        pairs: pairs.length,
        detail: `Mubit refused the join: ${res.error}`,
      }));
      return 1;
    }
    problems.push(res.error);
  }

  let recorded = 0;
  for (const [a, b] of pairs) {
    if (recordLink(cfg, { runId: a.runId, projectDir: a.path }, { runId: b.runId, projectDir: b.path })) {
      recorded++;
    }
  }

  const many = pairs.length > 1
    ? ` (${pairs.length} pairs — every project in the group can read every other, because the `
      + 'graph is read one hop deep)'
    : '';

  if (problems.length) {
    io.emit(io.shape({
      ok: false,
      state: 'not_asserted',
      pairs: pairs.length,
      asserted,
      recorded,
      detail: `Recorded the link to ${names} locally, but Mubit did not confirm it: `
        + `${problems[0]}\nRun this again when the instance is reachable — re-asserting a link `
        + 'is idempotent, and nothing was lost.',
    }));
    return 2;
  }

  io.emit(io.shape({
    ok: true,
    state: 'linked',
    pairs: pairs.length,
    asserted,
    recorded,
    detail: `Linked this project to ${names}${many}.\nRecall here can now see their memory, `
      + 'and theirs can see this one. `unlink` revokes it.',
  }));
  return 0;
}

/**
 * Revoke the edges between this project and the named ones.
 *
 * Not pairwise, and that is not an inconsistency: linking a group is one intent ("these belong
 * together"), and revoking is always about *this* project's reach. Tearing down edges between
 * two other projects because they were named in the same command would revoke something the
 * user never mentioned.
 *
 * The ledger is cleared whichever way the wire went. Narrowing reach must never be blocked by
 * an unreachable instance — a revocation that silently did not happen is the one failure this
 * whole surface cannot afford.
 */
async function doUnlink(cfg, current, targets, io) {
  const names = targets.map((t) => tildify(t.path, io.home)).join(', ');

  /** @type {string[]} */
  const problems = [];
  for (const t of targets) {
    const res = await postUnlinkRun(cfg, { run_id: current.runId, linked_run_id: t.runId });
    if (!res.ok) {
      if (res.state === 'invalid_request') {
        io.emit(io.shape({ ok: false, state: 'refused', detail: `Mubit refused the revocation: ${res.error}` }));
        return 1;
      }
      problems.push(res.error);
    }
  }

  let forgotten = 0;
  for (const t of targets) {
    if (forgetLink(cfg, { runId: current.runId }, { runId: t.runId })) forgotten++;
  }

  if (problems.length) {
    io.emit(io.shape({
      ok: false,
      state: 'not_asserted',
      forgotten,
      detail: `Forgot the link to ${names} here, but Mubit did not confirm it: ${problems[0]}\n`
        + 'Run this again when the instance is reachable — until then that project may still be '
        + 'readable from this one.',
    }));
    return 2;
  }

  io.emit(io.shape({
    ok: true,
    state: 'unlinked',
    forgotten,
    detail: `Unlinked ${names}. Recall here no longer sees their memory.\n`
      + 'The lessons are untouched — only the edge is gone, and `link` restores it.',
  }));
  return 0;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** @param {Record<string, any>} rec @param {string} here @param {string} root */
function sameProject(rec, here, root) {
  const dir = resolvePath(str(rec.project_dir));
  const recRoot = str(rec.project_root);
  if (dir && dir === here) return true;
  return !!recRoot && recRoot === root;
}

/** `~/x` and `./x` both become an absolute path. @param {string} raw */
function expandPath(raw, home, cwd) {
  let s = raw.replace(/\/+$/, '') || raw;
  if (s === '~') s = home || s;
  else if (s.startsWith('~/') && home) s = join(home, s.slice(2));
  if (!isAbsolute(s)) {
    // A bare word is far more likely to be the tail of a rendered path than a sibling
    // directory nobody has memory in, so this stays a candidate rather than an answer.
    const asRelative = resolvePath(join(cwd || safeCwd(), s));
    return asRelative || s;
  }
  return resolvePath(s) || s;
}

/** @param {string} p */
function resolvePath(p) {
  const s = str(p);
  if (!s) return '';
  try { return resolve(s).replace(/\/+$/, '') || s; } catch { return s; }
}

/** The `origin` a directory pushes to, in whatever form it is configured. `''` outside a repo. */
function gitOrigin(dir) {
  return gitOutput(dir, ['config', '--get', 'remote.origin.url']);
}

/** @param {string} dir */
function gitToplevel(dir) {
  return gitOutput(dir, ['rev-parse', '--show-toplevel']);
}

/**
 * Mirrors `lib/runid.mjs`'s own git helper, including the cheap `.git` walk-up: a picker over
 * six directories must not pay six process spawns to discover that none of them is a repo.
 * Never throws — no git on PATH, a deleted directory and a plain folder are all `''`.
 * @param {string} dir @param {string[]} args
 */
function gitOutput(dir, args) {
  try {
    if (!dir || !existsSync(dir) || !hasGitDir(dir)) return '';
    const r = spawnSync('git', args, {
      cwd: dir, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return r && r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : '';
  } catch {
    return '';
  }
}

/** @param {string} start */
function hasGitDir(start) {
  try {
    let cur = resolve(start);
    for (let i = 0; i < 24; i++) {
      if (existsSync(join(cur, '.git'))) return true;
      const up = dirname(cur);
      if (up === cur) return false;
      cur = up;
    }
    return false;
  } catch {
    return false;
  }
}

/** One answer per directory per invocation; git is the only expensive thing this file does. */
function memo(fn) {
  /** @type {Map<string, string>} */
  const cache = new Map();
  return (dir) => {
    const key = str(dir);
    if (!cache.has(key)) cache.set(key, key ? fn(key) : '');
    return cache.get(key) ?? '';
  };
}

function safeCwd() {
  try { return process.cwd(); } catch { return '.'; }
}

/** @param {any} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** @param {any} v @param {number} d @returns {number} */
function numOr(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

/** @param {any} v */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Guarded the same way as `bin/auth.src.mjs`: the tests import this module and drive `main()`
// with injected dependencies, so it must not run itself on import.
const selfPath = fileURLToPath(import.meta.url);
const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';

if (entryPath === selfPath) {
  // A user is watching, so this command is allowed to fail loudly — but a stack trace is
  // never the right output, and the exit code carries the verdict.
  process.exitCode = await main().catch((err) => {
    console.log(`/mubit-memory:link could not run: ${err?.message ?? err}`);
    return 1;
  });
}
