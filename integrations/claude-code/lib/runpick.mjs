// @ts-check
/**
 * `lib/runpick.mjs` — which run a skill-invoked command is acting on.
 *
 * A hook is handed its run by the host payload. A command a person typed is not: it runs in
 * a fresh process with no payload, so it has to *observe* which run the session's hooks are
 * writing to rather than derive one — and deriving would be wrong anyway, because the hooks
 * may have derived theirs from a payload this process never sees.
 *
 * The observation is the run markers under `status/`. The newest fresh marker is the session
 * that typed the command, unless a second session's hook fired seconds before it, in which
 * case "newest" is a coin toss and the honest answer is to ask. A marker older than a day is
 * not this session either: answering with one silently binds the command to a project the
 * user left last week, and "no run found, pass --run" is a far better failure than a write
 * nobody sees.
 *
 * Shared by `bin/pin.src.mjs` and `bin/admin.src.mjs`, which is why it is here and not in
 * either of them: the second command to need it would otherwise have had its own copy of
 * the same judgement.
 */

import { scanRunMarkers } from './runid.mjs';

/** The fallback a run id takes when nothing configured one. Never a run of the user's. */
export const POISONED_RUN_ID = 'default';

/** A marker older than this is a session the user left, not the one typing now. */
export const MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Two markers this close together are two live sessions, and "newest" is a coin toss. */
export const MARKER_AMBIGUOUS_MS = 5 * 60 * 1000;

/**
 * @typedef {{ok: true, runId: string}|{ok: false, state: string, detail: string}} RunPick
 */

/**
 * Which run this command is acting on.
 *
 * @param {Record<string, any>} cfg
 * @param {string} [explicit]  `--run`
 * @param {{command?: string}} [opts]  the command name, for the remedy in a failure
 * @returns {RunPick}
 */
export function pickRun(cfg, explicit = '', opts = {}) {
  const command = str(opts?.command) || 'pin';
  const named = str(explicit) || (str(cfg?.runStrategy) === 'static' ? str(cfg?.runId) : '');
  if (named) {
    if (named === POISONED_RUN_ID) {
      return {
        ok: false,
        state: 'poisoned_run',
        detail: `"${POISONED_RUN_ID}" is the fallback a run id takes when nothing configured one, `
          + 'not a run of yours. Name the run this session is using: '
          + `${command} --run <run_id> …`,
      };
    }
    return { ok: true, runId: named };
  }
  const { runId, rivals } = newestMarker(cfg);
  if (runId && rivals.length) {
    return {
      ok: false,
      state: 'ambiguous_run',
      detail: `More than one Mubit run is live in this data directory — ${[runId, ...rivals].join(', ')}`
        + ' — so the most recently touched marker is not reliably the session that typed this. '
        + `Name the run this session is using: ${command} --run <run_id> …. The SessionStart `
        + 'block at the top of the conversation prints it, and so does /mubit-memory:doctor.',
    };
  }
  if (runId) return { ok: true, runId };
  // Naming the directory is the whole point. "Send one prompt first" is useless advice to
  // someone who already has, and the commonest cause of an empty scan is not a session that
  // has written nothing but a command that inherited no `MUBIT_CC_DATA_DIR` and is looking
  // somewhere the hooks never write.
  return {
    ok: false,
    state: 'no_run',
    detail: 'Could not tell which Mubit run this session is using — no run marker in '
      + `${str(cfg?.dataDir) || '(no data directory resolved)'}. If the session has been `
      + 'sending prompts, that is not the directory its hooks are writing to: '
      + '/mubit-memory:doctor prints the one they use, and MUBIT_CC_DATA_DIR overrides it. '
      + `Otherwise send one prompt first, or name the run: ${command} --run <run_id> ….`,
  };
}

/**
 * The most recently updated `status/<run_id>.json`, and any rival close enough behind it to
 * be a second live session.
 *
 * A run and its own successors are not rivals. A `/clear` leaves the pre-clear marker on
 * disk beside `-c1`, and a subagent writes `-sub-<short>`; both name the session that is
 * already the answer, so they are folded together by `markerBase` before anything is
 * compared.
 *
 * @param {Record<string, any>} cfg
 * @returns {{runId: string, rivals: string[]}}
 */
export function newestMarker(cfg) {
  const now = Date.now();
  const fresh = scanRunMarkers(str(cfg?.dataDir))
    .filter((m) => m.runId !== POISONED_RUN_ID && m.at > 0 && now - m.at < MARKER_MAX_AGE_MS)
    .sort((a, b) => b.at - a.at);
  const [best, ...rest] = fresh;
  if (!best) return { runId: '', rivals: [] };
  const bestBase = markerBase(best.runId);
  const rivals = [];
  for (const m of rest) {
    if (best.at - m.at >= MARKER_AMBIGUOUS_MS) break;
    if (markerBase(m.runId) === bestBase) continue;
    if (!rivals.includes(m.runId)) rivals.push(m.runId);
  }
  return { runId: best.runId, rivals };
}

/** A run id with its `/clear` and subagent suffixes removed. @param {string} runId */
export function markerBase(runId) {
  return str(runId).replace(/-sub-[^-]+$/, '').replace(/-c\d+$/, '');
}

/** @param {any} v */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}
