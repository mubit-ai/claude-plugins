// @ts-check
/**
 * `lib/handoff.mjs` — the handoff lane: send a note to another agent, list what is open in
 * a run, and answer one with feedback.
 *
 * ---------------------------------------------------------------------------
 * What a handoff is here
 * ---------------------------------------------------------------------------
 * A `handoff` entry is a note addressed from one agent to another inside a run — "review
 * this", "continue from here", "approve before I execute" — and a `feedback` entry is the
 * answer, naming the handoff it answers by id. Two things write handoffs:
 *
 *   - `POST /v2/control/handoff`, through `sendHandoff`, when an agent or a person types one.
 *   - `capture --subagent`, which files every `SubagentStop` as a handoff note from the
 *     subagent to the parent role with `requested_action: review`. It goes through ingest
 *     rather than the route, because a hook dials nothing; it lands as the same entry type
 *     with the same metadata keys, so a listing does not know the difference.
 *
 * ---------------------------------------------------------------------------
 * Open is computed here, because the server never flips `active`
 * ---------------------------------------------------------------------------
 * The route stamps `active: true` on every handoff it creates and nothing on the server ever
 * sets it to false — `submit_feedback` writes a separate `feedback` entry and leaves the
 * handoff as it was. There is also no list route: `/activity` is the only reader. So
 * `listHandoffs` fetches both entry types for the run and joins them client-side, and
 * **open means "no feedback entry names this handoff's id"**. A reader who filters on
 * `active` server-side will find every handoff ever written still open, which is why this
 * module does not.
 *
 * ---------------------------------------------------------------------------
 * Run scope
 * ---------------------------------------------------------------------------
 * Everything here is scoped to one run id, the parent's. A subagent's sub-run id is a local
 * bookkeeping key and never reaches the wire — the note a subagent hands back is filed under
 * the run its parent is in, which is the run the parent lists. A handoff to an agent in
 * another run is not something this lane can express, and the CLI says so rather than
 * silently filing it here.
 *
 * Constraints shared with the rest of `lib/`: zero dependencies, Node >= 20 built-ins, no
 * import outside `lib/`, and nothing here throws.
 */

import { listActivity } from './activity.mjs';
import { FEEDBACK_VERDICTS, HANDOFF_ACTIONS, postFeedback, postHandoff } from './http.mjs';

/** A listing is a person waiting at a prompt, not a hook; `lib/activity.mjs`'s 4 s is a hook budget. */
const LIST_TIMEOUT_MS = 15000;

/** A send or a feedback is one small write; the ordinary budget with a little room. */
const WRITE_TIMEOUT_MS = 8000;

/** How many entries one listing reads. A run with more open handoffs than this has a different problem. */
const LIST_LIMIT = 500;

/** How much of a note is kept when it is rendered in a listing. */
const PREVIEW_CHARS = 160;

export { HANDOFF_ACTIONS, FEEDBACK_VERDICTS };

/**
 * @typedef {object} Handoff
 * @property {string} id         the entry id; what feedback names
 * @property {string} task_id
 * @property {string} from
 * @property {string} to
 * @property {string} action     one of `HANDOFF_ACTIONS`
 * @property {string} content
 * @property {string} at         ISO time, `''` when the entry carries none
 * @property {boolean} open      no feedback names this id
 * @property {Feedback[]} feedback
 */

/**
 * @typedef {object} Feedback
 * @property {string} id
 * @property {string} verdict
 * @property {string} comments
 * @property {string} from
 * @property {string} at
 */

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Send a handoff. Nothing is written locally: a handoff exists when the server says it does,
 * and the id it answers with is the one feedback has to name.
 *
 * @param {Record<string, any>} cfg
 * @param {{run_id: string, to_agent_id: string, content: string, from_agent_id?: string,
 *          task_id?: string, requested_action?: string, metadata?: Record<string, any>}} o
 * @returns {Promise<{ok: true, id: string, action: string}|{ok: false, state: string, error: string}>}
 */
export async function sendHandoff(cfg, o) {
  const action = str(o?.requested_action).toLowerCase() || 'continue';
  const res = await postHandoff(cfg, {
    run_id: str(o?.run_id),
    task_id: str(o?.task_id),
    from_agent_id: str(o?.from_agent_id),
    to_agent_id: str(o?.to_agent_id),
    content: typeof o?.content === 'string' ? o.content : '',
    requested_action: action,
    metadata_json: safeJson(isObject(o?.metadata) ? o.metadata : {}),
  }, { record: false, timeoutMs: WRITE_TIMEOUT_MS });
  if (!res.ok) return failure(cfg, res);
  return { ok: true, id: str(res.body?.handoff_id), action };
}

/**
 * Answer a handoff.
 *
 * @param {Record<string, any>} cfg
 * @param {{run_id: string, handoff_id: string, verdict: string, comments?: string, from_agent_id?: string}} o
 * @returns {Promise<{ok: true, id: string, verdict: string}|{ok: false, state: string, error: string}>}
 */
export async function submitFeedback(cfg, o) {
  const verdict = str(o?.verdict).toLowerCase();
  const res = await postFeedback(cfg, {
    run_id: str(o?.run_id),
    handoff_id: str(o?.handoff_id),
    verdict,
    comments: typeof o?.comments === 'string' ? o.comments : '',
    from_agent_id: str(o?.from_agent_id),
  }, { record: false, timeoutMs: WRITE_TIMEOUT_MS });
  if (!res.ok) return failure(cfg, res);
  return { ok: true, id: str(res.body?.feedback_id), verdict };
}

// ---------------------------------------------------------------------------
// Listing — the client-side join
// ---------------------------------------------------------------------------

/**
 * Every handoff in the run, newest first, each carrying the feedback that names it.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {{open?: boolean, limit?: number, timeoutMs?: number}} [o]
 * @returns {Promise<{ok: true, handoffs: Handoff[], orphans: number}|{ok: false, state: string, error: string}>}
 *   `orphans` counts feedback whose handoff was not in the page — a run longer than the
 *   listing, or feedback on a handoff in another run — so a caller can say the join is partial.
 */
export async function listHandoffs(cfg, runId, o = {}) {
  const run = str(runId);
  if (!run) return { ok: false, state: 'no_run', error: 'listHandoffs: a run id is required' };

  const res = await listActivity(cfg, {
    run,
    entryTypes: ['handoff', 'feedback'],
    projection: 'full',
    limit: posInt(o?.limit, LIST_LIMIT),
    sort: 'desc',
  }, { record: false, timeoutMs: posInt(o?.timeoutMs, LIST_TIMEOUT_MS) });
  if (!res.ok) return failure(cfg, res);

  const entries = Array.isArray(res.data?.entries) ? res.data.entries : [];
  /** @type {Map<string, Handoff>} */
  const byId = new Map();
  /** @type {Array<Feedback & {handoff_id: string}>} */
  const answers = [];

  for (const e of entries) {
    if (!isObject(e)) continue;
    const meta = parseMeta(e.metadata_json ?? e.metadata);
    const type = str(e.entry_type) || str(meta.entry_type);
    const id = str(e.id);
    if (!id) continue;
    const at = str(e.created_at) || str(meta.created_at);
    const from = str(meta.from_agent_id) || sourceAgent(e.source);

    if (type === 'handoff') {
      if (byId.has(id)) continue;
      byId.set(id, {
        id,
        task_id: str(meta.task_id),
        from,
        to: str(meta.to_agent_id),
        action: str(meta.requested_action).toLowerCase(),
        content: typeof e.content === 'string' ? e.content : '',
        at,
        open: true,
        feedback: [],
      });
    } else if (type === 'feedback') {
      answers.push({
        id,
        handoff_id: str(meta.handoff_id),
        verdict: str(meta.verdict).toLowerCase(),
        comments: typeof e.content === 'string' ? e.content : '',
        from,
        at,
      });
    }
  }

  let orphans = 0;
  for (const a of answers) {
    const h = byId.get(a.handoff_id);
    if (!h) { orphans += 1; continue; }
    const { handoff_id: _drop, ...feedback } = a;
    h.feedback.push(feedback);
    h.open = false;
  }

  let handoffs = [...byId.values()];
  if (o?.open === true) handoffs = handoffs.filter((h) => h.open);
  return { ok: true, handoffs, orphans };
}

/**
 * One handoff as a line a person reads, for the CLI and the skill.
 * @param {Handoff} h @returns {string}
 */
export function renderHandoff(h) {
  const state = h.open ? 'open' : `closed (${h.feedback.map((f) => f.verdict).filter(Boolean).join(', ') || 'answered'})`;
  const who = `${h.from || '?'} -> ${h.to || '?'}`;
  return `${h.id}  ${who}  ${h.action || 'continue'}  ${state}\n    ${preview(h.content)}`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * A failed result, with the API key scrubbed out of the error. `lib/http.mjs` quotes a
 * snippet of the response body in its error string, and a verbose 4xx can quote the request
 * that produced it — Authorization header included. The CLI prints this string to a person,
 * so the scrub lives here, on the one path every failure takes, the way `lib/variables.mjs`
 * scrubs its own.
 * @param {Record<string, any>} cfg @param {{state?: string, error?: string}} res
 * @returns {{ok: false, state: string, error: string}}
 */
function failure(cfg, res) {
  return {
    ok: false,
    state: str(res?.state) || 'upstream_failed',
    error: scrubKey(cfg, str(res?.error) || 'the instance did not answer'),
  };
}

/** @param {Record<string, any>} cfg @param {string} text @returns {string} */
function scrubKey(cfg, text) {
  try {
    const s = String(text ?? '');
    const key = cfg && typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
    if (!key || !s.includes(key)) return s;
    return s.split(key).join('[REDACTED:api-key]');
  } catch {
    return '';
  }
}

/**
 * The route files the entry's `source` as the sending agent when one was named, and as the
 * literal `handoff` / `feedback` when none was — which is not an agent.
 * @param {any} v
 */
function sourceAgent(v) {
  const s = str(v);
  return s === 'handoff' || s === 'feedback' ? '' : s;
}

/** @param {any} v @returns {Record<string, any>} */
function parseMeta(v) {
  if (isObject(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return {};
  try {
    const parsed = JSON.parse(v);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {string} s */
function preview(s) {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > PREVIEW_CHARS ? `${one.slice(0, PREVIEW_CHARS - 1)}…` : one;
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return '{}';
  }
}

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function posInt(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : d;
}
