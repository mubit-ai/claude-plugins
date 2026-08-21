// @ts-check
/**
 * `lib/links.mjs` — the local link ledger at `<dataDir>/links/<run_id>.json`.
 *
 * ---------------------------------------------------------------------------
 * Why the plugin keeps its own record instead of asking
 * ---------------------------------------------------------------------------
 * SCOPE.md Target C: **keep lessons at `run` scope and join runs instead of widening
 * scopes.** `POST /v2/control/runs/link` creates the join and `include_linked_runs` reads it,
 * so reach becomes the link graph rather than a threshold's good behaviour — an unlinked
 * project sees nothing by construction.
 *
 * The graph itself lives on the server, in `run_scopes`, which is an **in-memory map durable
 * only through the checkpoint**. That single fact is why this file exists and why it is not a
 * cache:
 *
 *   - **A cache would be wrong.** A cache's job is to answer instead of the server, and to be
 *     invalidated when it disagrees. This ledger is never invalidated by the server, because
 *     the server is not the authority on what the *user decided* — only on what it currently
 *     holds. A pod roll before a checkpoint drops joins the user still wants; the ledger is
 *     what lets the plugin re-assert them, cheaply and idempotently (the server de-duplicates
 *     and sorts `linked_run_ids`, so blind re-assertion costs one request and nothing else).
 *   - **It has to answer offline.** `/mubit-memory:link list` renders what this project can
 *     reach. Making that a round trip would mean an unreachable Mubit answers "you are linked
 *     to nothing", which is a lie in the one surface whose whole promise is that reach is
 *     inspectable.
 *
 * So: the server holds the joins; this file holds the **decisions**. They can disagree, and
 * when they do the ledger is the record of intent and the server is the record of state.
 *
 * ---------------------------------------------------------------------------
 * A decision, not a link — and why both ends are written
 * ---------------------------------------------------------------------------
 * An entry is a decision that happens to be either `linked` or `declined`, timestamped either
 * way. The decline is load-bearing rather than speculative: the Tier 2 offer (§6) proposes a
 * link when a second repo shares a git remote, and an offer with nowhere to record "no" is an
 * offer that fires on every `SessionStart` for the rest of the install's life.
 *
 * **Both ends are written locally**, mirroring what the backend does with the join itself.
 * This was the one real design choice here, and the alternative — recording only the edge
 * this machine created — loses in the case that actually happens: the user links two projects
 * from A, opens B tomorrow, and asks what B is linked to. With one end recorded, B answers
 * "nothing" while the server is already serving A's memory into it. A `list` that is silently
 * wrong is worse than a `list` that needs the network. The same argument applies to a
 * decline, which is why it is mirrored too: the offer must not simply move to the other
 * project and ask again.
 *
 * Note what this does *not* claim. Writing both ends records one decision from two vantage
 * points; it does not assert knowledge of the server's graph. Links made from another machine
 * are absent here, and links this file holds may already be gone from `run_scopes` — both are
 * expected, and neither is an error to repair.
 *
 * ---------------------------------------------------------------------------
 * Discipline, shared with `lib/state.mjs`, `lib/rules.mjs` and `lib/spool.mjs`
 * ---------------------------------------------------------------------------
 *   1. Zero dependencies, Node >= 20 built-ins only, and no import outside `lib/` — a
 *      detached child imports these modules by absolute `file://` URL.
 *   2. Everything is synchronous. Every caller is a process about to exit.
 *   3. **Nothing here throws.** The callers are `SubagentStart`, on the spawn path, and a
 *      `SessionStart` offer. An unwritable `${CLAUDE_PLUGIN_DATA}` costs the ledger entry and
 *      never the caller (§12.1-F14); a missing, empty or truncated file reads as "no record"
 *      and never as a fault.
 *
 * Deliberately **not** in the §7 TTL sweep. Everything `pruneStale` expires is a cache or a
 * transcript of something already sent; a link is a standing decision, and expiring one would
 * silently narrow a user's reach on a schedule nobody asked for. Removal is `forgetLink` —
 * i.e. `/mubit-memory:unlink`, a person revoking it on purpose.
 */

import { join } from 'node:path';

import { ensureDir, readJson, resolveDataDir, safeSegment, writeJsonAtomic } from './state.mjs';

/** §7: the ledger lives beside `runs/`, `sessions/` and `status/` under the data root. */
export const LINKS_DIR = 'links';

/** Bumped only if the on-disk shape changes; an unknown version reads as no record. */
const VERSION = 1;

/**
 * The states a pair can be in on disk. Anything else is damage and reads as absent.
 *
 * `offered` is not a decision — it is the record of having *asked*, and it carries a count.
 * SC-10 originally wrote `declined` the moment the Tier 2 offer was rendered, on the argument
 * that silence is the "no". That holds for a human who saw the question; it is not an answer
 * from a headless session, and there is no interactivity signal on a `SessionStart` payload to
 * tell the two apart. A single `claude --print` — CI, a script, or this kit's own `checkArms`,
 * which starts two headless sessions per preflight — therefore answered for the user, forever.
 * Counting the asks keeps "silence is the no" while surviving renders nobody could have seen.
 */
const DECISIONS = Object.freeze(['linked', 'declined', 'offered']);

/**
 * How many times a pair may be offered before silence is taken as a refusal.
 *
 * Small on purpose. The offer costs one short paragraph in a preamble the user reads anyway,
 * and §6's requirement is that it "does not nag" — three renders is not a nag, and it clears
 * the one or two unattended sessions a preflight or a CI job realistically burns.
 */
const OFFER_LIMIT = 3;

/**
 * How many decisions one run may keep.
 *
 * A bound rather than a policy: §6 measured 2-4 same-remote projects per user, and Tier 1
 * links a parent to its subagents, which is the only fan-out that could grow. 256 is far
 * past both and still small enough that the synchronous read stays free on a hook path. The
 * cap drops the least recently decided, so a long-lived parent keeps the subagents it is
 * still working with.
 */
const MAX_LINKS = 256;

/** A run id is untrusted input to a path (§4.3), and a long one is still a filename. */
const MAX_ID = 200;

/**
 * @typedef {object} LinkEntry
 * @property {string} run_id        the OTHER run — the far end of this decision
 * @property {"linked"|"declined"|"offered"} decision  `offered` is a pair that has been asked
 *   about and not answered — see `DECISIONS`; it is not a decision and must not read as one
 * @property {string} project_dir   the far end's directory, for a UI that shows paths not hashes
 * @property {number} at            when the decision was last recorded (§6 renders "2d ago")
 * @property {number} [offers]      how many times the Tier 2 offer has been rendered for this
 *   pair; reaching `OFFER_LIMIT` is what turns silence into `declined`
 */

/**
 * @typedef {object} LinkSide
 * @property {string} runId
 * @property {string} [projectDir]
 */

// ---------------------------------------------------------------------------
// Where it lives
// ---------------------------------------------------------------------------

/**
 * `<dataDir>/links/<run_id>.json`. The name goes through `safeSegment` like every other path
 * this plugin writes, so a run id pinned by hand in a settings file cannot climb out of the
 * directory. The unflattened id is stored *inside* the file, because the flattening is not
 * reversible and a reader needs to know which run the ledger is actually about.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {string}
 */
export function linksPath(cfg, runId) {
  return join(resolveDataDir(cfg), LINKS_DIR, `${safeSegment(runId, MAX_ID)}.json`);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Every decision recorded for `runId`, most recent first.
 *
 * `[]` for every kind of absence and every kind of damage: no file, an unreadable one, a torn
 * write, a shape a future version wrote, a `links` key that is not an array, an element that
 * is not an object, an entry naming no run or carrying a decision this version does not know.
 * A caller has no branch for "the ledger is broken" that differs from "there are no links".
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {LinkEntry[]}
 */
export function readLinks(cfg, runId) {
  try {
    if (!safeSegment(runId, MAX_ID)) return [];
    const stored = readJson(linksPath(cfg, runId), null);
    if (!isObject(stored) || !Array.isArray(stored.links)) return [];

    /** @type {LinkEntry[]} */
    const out = [];
    /** @type {Set<string>} */
    const seen = new Set();
    for (const raw of stored.links) {
      const entry = normalise(raw);
      if (!entry || seen.has(entry.run_id)) continue;
      seen.add(entry.run_id);
      out.push(entry);
      if (out.length >= MAX_LINKS) break;
    }
    return out.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/**
 * The run ids `runId` may actually read from — the `linked` decisions and nothing else.
 *
 * The distinction is the whole point of storing declines in the same file: counting one as
 * reach would hand a project exactly the memory the user just refused to connect.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {string[]}
 */
export function linkedRunIds(cfg, runId) {
  return readLinks(cfg, runId).filter((e) => e.decision === 'linked').map((e) => e.run_id);
}

/**
 * The decision recorded for one pair, or `null` when there is none.
 *
 * `null` is the state the Tier 2 offer fires on, so the three answers are distinct and all
 * three matter: `null` means ask, `declined` means never ask again, `linked` means say so.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {string} otherRunId
 * @returns {LinkEntry|null}
 */
export function linkDecision(cfg, runId, otherRunId) {
  const other = str(otherRunId);
  if (!other) return null;
  return readLinks(cfg, runId).find((e) => e.run_id === other) ?? null;
}

// ---------------------------------------------------------------------------
// Writing — always both ends
// ---------------------------------------------------------------------------

/**
 * Record that these two runs are linked, at both ends.
 *
 * Idempotent: the pair holds exactly one entry however many times it is recorded, and
 * re-recording refreshes `at` rather than appending — re-assertion after a checkpoint loss is
 * a named use of this file, and a decision whose timestamp never moved could not be told from
 * one nobody has touched since the pod that held it died. A `declined` pair that is later
 * linked flips to `linked`; the newer decision replaces the older rather than joining it.
 *
 * @param {Record<string, any>} cfg
 * @param {LinkSide} a
 * @param {LinkSide} b
 * @returns {boolean} true when the decision landed at both ends
 */
export function recordLink(cfg, a, b) {
  return recordDecision(cfg, a, b, 'linked');
}

/**
 * Record that these two runs are deliberately **not** linked, at both ends.
 *
 * SC-10's Tier 2 offer is proposed once and remembered either way; this is the "either way".
 * Mirrored for the same reason a link is: an offer that simply moves to the other project and
 * asks again has not remembered anything.
 *
 * @param {Record<string, any>} cfg
 * @param {LinkSide} a
 * @param {LinkSide} b
 * @returns {boolean} true when the decision landed at both ends
 */
export function recordDecline(cfg, a, b) {
  return recordDecision(cfg, a, b, 'declined');
}

/**
 * Record that this pair was *offered* — not that it was refused.
 *
 * Returns the new count so the caller need not re-read. At `OFFER_LIMIT` the pair becomes
 * `declined` at both ends and stops being offered: silence is still the "no", it just takes
 * more than one unattended render to say it. See `DECISIONS` for why.
 *
 * A pair already `linked` or `declined` is left exactly as it is — this only ever advances a
 * pair nobody has answered for.
 *
 * @param {Record<string, any>} cfg
 * @param {LinkSide} a
 * @param {LinkSide} b
 * @returns {number} how many times the pair has now been offered
 */
export function recordOffer(cfg, a, b) {
  const existing = linkDecision(cfg, a.runId, b.runId);
  if (existing && existing.decision !== 'offered') return existing.offers ?? 0;
  const offers = (existing?.offers ?? 0) + 1;
  recordDecision(cfg, a, b, offers >= OFFER_LIMIT ? 'declined' : 'offered', offers);
  return offers;
}

/**
 * Drop a pair from both ledgers — the local half of `/mubit-memory:unlink`.
 *
 * A revoked pair reads as *undecided*, not as declined: the user withdrew a link they had
 * granted, which is not the same as refusing an offer, and conflating them would silently
 * suppress a future Tier 2 proposal they might well accept.
 *
 * Idempotent, and true for a pair that was never recorded: the caller asked for a state, and
 * that state already holds.
 *
 * @param {Record<string, any>} cfg
 * @param {LinkSide} a
 * @param {LinkSide} b
 * @returns {boolean} true when neither ledger still holds the pair
 */
export function forgetLink(cfg, a, b) {
  try {
    const idA = str(a?.runId);
    const idB = str(b?.runId);
    if (!idA || !idB) return false;
    return dropFrom(cfg, idA, idB) && dropFrom(cfg, idB, idA);
  } catch {
    return false;
  }
}

/**
 * The symmetric write both public recorders share.
 *
 * The signature takes two *sides* rather than a subject and an object precisely because the
 * operation has no subject: the user linked two projects. Each side's directory is stored in
 * the other's ledger, which is what lets either project render the pair as a path.
 *
 * A partial write — one end landed, the other did not — is reported as a failure but is
 * **not** rolled back. Half a record is still better than none: it survives to be re-asserted,
 * and the next successful call repairs the other end.
 *
 * @param {Record<string, any>} cfg
 * @param {LinkSide} a
 * @param {LinkSide} b
 * @param {"linked"|"declined"} decision
 * @returns {boolean}
 */
function recordDecision(cfg, a, b, decision, offers = 0) {
  try {
    const idA = str(a?.runId);
    const idB = str(b?.runId);
    if (!idA || !idB) return false;
    // The same refusal `postLinkRun` makes on the wire, made here so a ledger written without
    // a round trip cannot disagree with one written after it. A run already consults itself.
    if (idA === idB) return false;

    const at = Date.now();
    const landedA = upsert(cfg, idA, { run_id: idB, decision, project_dir: str(b?.projectDir), at, offers });
    const landedB = upsert(cfg, idB, { run_id: idA, decision, project_dir: str(a?.projectDir), at, offers });
    return landedA && landedB;
  } catch {
    return false;
  }
}

/**
 * Merge one entry into one run's ledger. Read, replace-or-prepend, write whole — there is no
 * merge hazard worth a lock here the way there is in `lib/rules.mjs`: link decisions arrive
 * from a human at human speed, or once per subagent spawn, and the loser of a collision is
 * repaired by the next re-assertion.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId    the ledger's owner
 * @param {LinkEntry} entry
 * @returns {boolean}
 */
function upsert(cfg, runId, entry) {
  try {
    const p = linksPath(cfg, runId);
    if (!safeSegment(runId, MAX_ID)) return false;
    // §12.1-F14: a read-only ${CLAUDE_PLUGIN_DATA} costs the ledger entry, nothing else.
    if (!ensureDir(join(resolveDataDir(cfg), LINKS_DIR))) return false;

    const kept = readLinks(cfg, runId).filter((e) => e.run_id !== entry.run_id);
    return writeJsonAtomic(p, {
      version: VERSION,
      run_id: str(runId),
      updated_at: entry.at,
      links: [entry, ...kept].slice(0, MAX_LINKS),
    });
  } catch {
    return false;
  }
}

/**
 * Remove one far end from one run's ledger.
 *
 * A ledger that never held the pair is left untouched rather than created empty: the point of
 * "no record" is that the absent file *is* the answer, and writing one to say so would put a
 * file on disk for every pair anybody ever asked about.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {string} otherRunId
 * @returns {boolean}
 */
function dropFrom(cfg, runId, otherRunId) {
  try {
    const existing = readLinks(cfg, runId);
    const kept = existing.filter((e) => e.run_id !== otherRunId);
    if (kept.length === existing.length) return true;
    if (!ensureDir(join(resolveDataDir(cfg), LINKS_DIR))) return false;
    return writeJsonAtomic(linksPath(cfg, runId), {
      version: VERSION,
      run_id: str(runId),
      updated_at: Date.now(),
      links: kept,
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * One stored element → a `LinkEntry`, or `null` when it is not one. An entry naming no run,
 * or carrying a decision this version does not know, is damage rather than a partial record.
 * @param {any} raw
 * @returns {LinkEntry|null}
 */
function normalise(raw) {
  if (!isObject(raw)) return null;
  const runId = str(raw.run_id);
  if (!runId) return null;
  const decision = str(raw.decision);
  if (!DECISIONS.includes(decision)) return null;
  return {
    run_id: runId,
    decision: /** @type {"linked"|"declined"|"offered"} */ (decision),
    project_dir: str(raw.project_dir),
    at: numOr(raw.at, 0),
    offers: Math.max(0, Math.trunc(numOr(raw.offers, 0))),
  };
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
