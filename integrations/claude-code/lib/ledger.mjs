// @ts-check
/**
 * `lib/ledger.mjs` — one durable, redacted line per closed turn.
 *
 * `runs/<run_id>/turns/<prompt_id>.json` is the record of a turn while it is in flight, and it
 * is pruned six hours after it closes (`lib/state.mjs`, the §7 TTL table). Everything the
 * dashboard could say about a turn — which memories were injected, whether the reply echoed
 * them, what outcome that earned — expired with it, so the page's history was whatever it
 * happened to be open for. The ledger is the part of that record worth keeping, appended by
 * `capture --stop` and `--stop-failure` as the turn closes, whether or not anything is
 * watching. It lives beside the turns, one `ledger.jsonl` per run, and `pruneStale` drops the
 * whole file thirty days after its last write.
 *
 * What a row is, and is not:
 *
 *   - **A decision, never a post.** `outcome` and `signal` are what `decideOutcome` says the
 *     turn earned, computed on the closed record the same way `drain` and `session-end` compute
 *     it — with the send-state keys stripped first, so a turn a drain already posted still
 *     reads as the outcome it earned rather than as "already sent". Nothing here has a socket;
 *     the two hooks that post append their own `kind: 'outcome'` row when a post is accepted.
 *   - **Redacted under a literal policy.** `LEDGER_REDACTION` is frozen and never derived from
 *     `cfg`. `redact: false` is consent to send one's own secrets to one's own instance over
 *     TLS; it is not consent to keep them on disk for a month under a different file name. The
 *     prompt is scrubbed and capped at `LEDGER_PREVIEW_BYTES`. The staged recall terms and the
 *     reply are prompt- and answer-derived and are never written at all.
 *   - **Main-agent turns only.** A subagent's stop goes through `capture --subagent`, which
 *     closes no turn file and writes no row; its fan-out is joined at read time from
 *     `runs/<run_id>/subagents/`, which is never pruned.
 *
 * The file is append-only with `O_APPEND`, one row per `write`, so two hooks racing on it
 * interleave whole lines. A crash mid-write leaves a torn last line: the reader skips it, and
 * the next append starts on a fresh line rather than gluing itself to the fragment. The one
 * rewrite is the trim, past `LEDGER_MAX_BYTES`, through a tmp file and a rename — a row
 * appended in the few milliseconds between the read and the rename would be lost, which is a
 * trade taken once per megabyte and never on a hook's ordinary path.
 *
 * Imports: `./state.mjs` (paths), `./redact.mjs` (the scrub), `./outcome.mjs` (the decision,
 * which is pure and dependency-free). Node >= 20 built-ins only; nothing here throws.
 */

import {
  closeSync, fstatSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { decideOutcome } from './outcome.mjs';
import { redactText } from './redact.mjs';
import { ensureDir, runDir, safeSegment } from './state.mjs';

/** The row format. Bumped when a reader could misread an older row. */
export const LEDGER_VERSION = 1;

/** `runs/<run_id>/ledger.jsonl` */
export const LEDGER_FILE = 'ledger.jsonl';

/** Past this size an append trims the file. */
export const LEDGER_MAX_BYTES = 1024 * 1024;

/** What a trim keeps: the newest rows that fit. */
export const LEDGER_KEEP_BYTES = 512 * 1024;

/** Rows older than this are dropped when the file is trimmed. */
export const LEDGER_ROW_TTL_MS = 30 * 24 * 3600e3;

/** How much of a prompt a row carries. Enough to recognise a turn, not to read it. */
export const LEDGER_PREVIEW_BYTES = 240;

/**
 * The redaction policy every prompt on the ledger is scrubbed under. A literal, frozen, and
 * never the user's `cfg` — see the module header.
 */
export const LEDGER_REDACTION = Object.freeze({ redact: true, maxOutputBytes: LEDGER_PREVIEW_BYTES });

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * `<dir>/runs/<run_id>/ledger.jsonl`, with the run id flattened: it can arrive from a query
 * string as easily as from `lib/runid.mjs`.
 *
 * @param {string} dir  the data directory
 * @param {string} runId
 * @returns {string}
 */
export function ledgerPath(dir, runId) {
  return join(runDir({ dataDir: dir }, safeSegment(runId) || 'unknown'), LEDGER_FILE);
}

// ---------------------------------------------------------------------------
// The turn row
// ---------------------------------------------------------------------------

/**
 * The `kind: 'turn'` row for one closed turn file.
 *
 * Pure: the turn is read and never written, and the clock is a parameter. The outcome is
 * decided on a copy with `outcome_sent_at` and `outcome_attempts` removed, because those say
 * whether a post happened and this row says what the turn earned. `post: false` for any other
 * reason — nothing injected, the API killed the turn — is `'none'` at signal 0.
 *
 * @param {Record<string, any>|null|undefined} turn  the parsed `turns/<prompt_id>.json`
 * @param {string} runId
 * @param {number} [now]
 * @returns {Record<string, any>}
 */
export function turnLedgerRow(turn, runId, now = Date.now()) {
  const t = isObject(turn) ? turn : {};
  const r = isObject(t.recall) ? t.recall : {};
  const ev = isObject(t.used_evidence) ? t.used_evidence : null;
  const preview = redactText(t.prompt, LEDGER_REDACTION, 'output');

  const { outcome_sent_at: _sent, outcome_attempts: _tries, ...decided } = t;
  const d = decideOutcome(decided);

  return {
    v: LEDGER_VERSION,
    kind: 'turn',
    at: num(now) || Date.now(),
    run_id: safeSegment(runId),
    prompt_id: str(t.prompt_id),
    session_id: str(t.session_id),
    turn_number: num(t.turn_number),
    started_at: num(t.started_at),
    ended_at: num(t.ended_at),
    prompt: preview.text,
    prompt_truncated: preview.truncated || t.prompt_truncated === true,
    prompt_redactions: preview.redactions + num(t.prompt_redactions),
    recalled: Array.isArray(t.recalled)
      ? t.recalled.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
      : [],
    recall: {
      rung: num(r.rung),
      sources: num(r.sources),
      tokens: num(r.tokens),
      chars: num(r.chars),
      pointers: num(r.pointers),
      dropped: num(r.dropped),
      empty_reason: str(r.empty_reason),
    },
    // Tri-state, and the third state is not "no": an absent `used` is unmeasured.
    used: ev && ev.used === true ? true : ev && ev.used === false ? false : null,
    api_error: str(t.api_error),
    outcome: d.post ? String(d.outcome) : 'none',
    signal: d.post ? num(d.signal) : 0,
  };
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

/**
 * Append one row as one line. `true` when it landed; `false` for anything else, never a throw
 * — this runs inside a hook's `attempt()` and a failure costs the row, not the turn.
 *
 * The file is opened `a+` so the last byte can be checked: after a torn line the row would
 * otherwise be glued onto the fragment and both lost. `O_APPEND` makes each `write` land
 * whole at the end whatever another process did in between.
 *
 * @param {string} dir  the data directory
 * @param {string} runId
 * @param {Record<string, any>|null|undefined} row
 * @returns {boolean}
 */
export function appendLedger(dir, runId, row) {
  try {
    if (!isObject(row) || !dir || !safeSegment(runId)) return false;
    const p = ledgerPath(dir, runId);
    if (!ensureDir(dirname(p))) return false;

    const line = `${JSON.stringify(row)}\n`;
    const fd = openSync(p, 'a+');
    let size = 0;
    try {
      const st = fstatSync(fd);
      let prefix = '';
      if (st.size > 0) {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, st.size - 1);
        if (last[0] !== 0x0a) prefix = '\n';
      }
      writeSync(fd, prefix + line);
      size = st.size + prefix.length + Buffer.byteLength(line, 'utf8');
    } finally {
      closeSync(fd);
    }
    if (size > LEDGER_MAX_BYTES) trimLedger(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * The rows for a run, oldest first. A line that does not parse — torn by a crash, or not a
 * row at all — is skipped and costs exactly itself.
 *
 * @param {string} dir  the data directory
 * @param {string} runId
 * @param {{since?: number, limit?: number, kinds?: string[]}} [opts]
 *   `since` drops rows whose `at` is older (epoch ms); `limit` keeps the newest N; `kinds`
 *   keeps only those `kind`s
 * @returns {Array<Record<string, any>>}
 */
export function readLedger(dir, runId, opts = {}) {
  const p = ledgerPath(dir, runId);
  let raw = '';
  try { raw = readFileSync(p, 'utf8'); } catch { return []; }

  const o = isObject(opts) ? opts : {};
  const since = num(o.since);
  const kinds = Array.isArray(o.kinds) && o.kinds.length ? new Set(o.kinds.map(String)) : null;
  const limit = Math.trunc(num(o.limit));

  /** @type {Array<Record<string, any>>} */
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isObject(row)) continue;
    if (kinds && !kinds.has(String(row.kind))) continue;
    if (since > 0 && num(row.at) < since) continue;
    out.push(row);
  }
  return limit > 0 && out.length > limit ? out.slice(-limit) : out;
}

// ---------------------------------------------------------------------------
// Trim
// ---------------------------------------------------------------------------

/**
 * Rewrite the file keeping the newest rows that fit in `keepBytes`, after dropping every row
 * older than `ttlMs`. Through a tmp file and a rename, like `capRollup`, so a reader never
 * sees half a file. `false` on any failure: an oversized ledger is better than one lost
 * mid-rewrite.
 *
 * @param {string} path  the ledger file
 * @param {{keepBytes?: number, ttlMs?: number, now?: number}} [opts]
 * @returns {boolean}
 */
export function trimLedger(path, opts = {}) {
  try {
    const o = isObject(opts) ? opts : {};
    const keepBytes = positive(o.keepBytes, LEDGER_KEEP_BYTES);
    const ttl = positive(o.ttlMs, LEDGER_ROW_TTL_MS);
    const now = num(o.now) || Date.now();

    let raw = '';
    try { raw = readFileSync(path, 'utf8'); } catch { return false; }

    /** @type {string[]} */
    const fresh = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!isObject(row)) continue;
      const at = num(row.at);
      if (at > 0 && now - at > ttl) continue;
      fresh.push(line);
    }

    let bytes = 0;
    let start = fresh.length;
    for (let i = fresh.length - 1; i >= 0; i -= 1) {
      const b = Buffer.byteLength(fresh[i], 'utf8') + 1;
      if (bytes + b > keepBytes) break;
      bytes += b;
      start = i;
    }
    const kept = fresh.slice(start);

    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} path @returns {number} bytes, or 0 when it does not exist */
export function ledgerSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/** @param {any} v @returns {boolean} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @param {any} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** @param {any} v @returns {number} */
function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** @param {any} v @param {number} d @returns {number} */
function positive(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}
