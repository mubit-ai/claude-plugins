// @ts-check
/**
 * `lib/breaker.mjs` — the connection-state classifier and the circuit breaker.
 *
 * Build-guide §4.7 (states, thresholds, cold start), §7 (`breaker/<endpoint_hash>.json`),
 * §6.1 (`MUBIT_CC_BREAKER_*`).
 *
 * Every hook is a short-lived process, so the breaker lives in a file — one file per
 * endpoint, `breaker/<sha256(endpoint).slice(0,12)>.json`, so switching between a local
 * and a hosted instance never inherits the other's verdict.
 *
 * Three rules carry this module, and all three exist to stop the plugin from lying:
 *
 *   1. **"A timeout is not a verdict."** A cold start, a laptop waking from sleep
 *      and a `cargo build` pinning every core all produce AbortErrors against a perfectly
 *      healthy server. One timeout moves `timeoutStreak`, not the reported state; only
 *      three in a row escalate, and only ever to `not_responding` — never `unreachable`,
 *      never `server_error`. But a timeout *does* append to `failures[]`: "not a verdict"
 *      governs what the user is told, not whether we keep dialing. Read it the other way
 *      and a wedged server that times out every request never trips the breaker at all.
 *
 *   2. **`auth_failed` is sticky and never feeds the failure counter.** Opening a breaker
 *      on a 401 hides the one error the user can actually fix by pasting a key. A later
 *      `server_error` still counts toward the breaker but does not displace the verdict;
 *      only `recordSuccess` clears it.
 *
 *   3. **Cold-start suppression.** Inside `cold_start_until` a failure is still recorded,
 *      but it is *displayed* as `warming` with no systemMessage. The deadline is passed in
 *      rather than read: the breaker is keyed by endpoint and knows nothing about runs.
 *
 * Discipline shared with the rest of `lib/`: zero dependencies, Node >= 20 built-ins,
 * everything synchronous (a hook is about to exit; an event-loop round trip buys nothing),
 * and nothing here throws — every caller is on a hook's critical path (§4.9). When state
 * cannot be read or written the breaker degrades to "closed", because failing shut would
 * cost the user their memory over a full disk.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { readJson, resolveDataDir, writeJsonAtomic } from './state.mjs';

/** @typedef {"ready"|"unreachable"|"server_error"|"auth_failed"|"not_responding"} ConnState */
/** @typedef {ConnState|"warming"} DisplayState */

/** §4.7: the ConnState union is closed — `bin/statusline.mjs` has no glyph for anything else. */
export const CONN_STATES = /** @type {const} */ ([
  'ready', 'unreachable', 'server_error', 'auth_failed', 'not_responding',
]);

/** §4.7: "Only `timeoutStreak >= 3` escalates." Not tunable — it is the rule, not a knob. */
const TIMEOUT_ESCALATION = 3;

/** §6.1 fallbacks, used only when a caller hands us a partial config. */
const DEFAULT_THRESHOLD = 5;
const DEFAULT_WINDOW_MS = 300000;
const DEFAULT_COOLDOWN_MS = 120000;

// ---------------------------------------------------------------------------
// classifyError — §4.7's mapping table, and nothing else
// ---------------------------------------------------------------------------

/** §4.7: `ECONNREFUSED, ENOTFOUND, EHOSTUNREACH, ECONNRESET`, plus their obvious cousins. */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET',
  'ENETUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'EADDRNOTAVAIL', 'ECONNABORTED',
  'EAI_AGAIN', 'EPIPE',
]);

/** §4.7 "AbortError / deadline exceeded". `UND_ERR_*_TIMEOUT` is undici's own spelling. */
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

const TIMEOUT_NAMES = new Set(['AbortError', 'TimeoutError', 'HeadersTimeoutError', 'BodyTimeoutError']);

/**
 * Name the symptom. Pure: no state is read, no policy is applied — `recordFailure` owns
 * the escalation rules, so a timeout classifies as `not_responding` here even though a
 * single timeout must never *display* as one.
 *
 * @param {any} err     the thrown error, or null/undefined for a plain HTTP status
 * @param {number|string|null} [status] the HTTP status, when there was a response
 * @returns {ConnState}
 */
export function classifyError(err, status) {
  try {
    // undici reports socket failures as `TypeError: fetch failed` with the real error on
    // `.cause`. Missing this is how every network failure gets misfiled as a server fault.
    const chain = causeChain(err);

    for (const e of chain) {
      if (TIMEOUT_NAMES.has(nameOf(e)) || TIMEOUT_CODES.has(codeOf(e))) return 'not_responding';
    }
    for (const e of chain) {
      if (UNREACHABLE_CODES.has(codeOf(e))) return 'unreachable';
    }

    const s = toStatus(status);
    if (s !== null) {
      // §1.2: every /v2/control/* handler authenticates first, so 401/403 is unambiguous.
      if (s === 401 || s === 403) return 'auth_failed';
      // §4.7: a parsed 2xx is the only thing that means healthy. A 2xx whose body will not
      // parse (JSON.parse threw a SyntaxError) is a broken server, not a broken network.
      if (s >= 200 && s < 300) return err ? 'server_error' : 'ready';
      // Everything the server said and we did not like — 5xx, and the non-auth 4xx that
      // are payload problems (400/413/422) or backpressure (429). None of them mean the
      // host is gone, and none of them may read as `ready`.
      return 'server_error';
    }

    // No status at all: a transport error we have no code for. `fetch failed` with nothing
    // attached is still a connection that never completed.
    if (chain.length && isFetchFailed(chain[0])) return 'unreachable';
    return 'server_error';
  } catch {
    // A getter on a caller's error object threw. Never let classification be the failure.
    return 'server_error';
  }
}

/** @param {any} e @returns {any[]} */
function causeChain(e) {
  /** @type {any[]} */
  const out = [];
  const seen = new Set();
  let cur = e;
  for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
    if (seen.has(cur)) break;      // `err.cause === err` is rare but not impossible
    seen.add(cur);
    out.push(cur);
    cur = cur.cause;
  }
  return out;
}

/** @param {any} e */
function codeOf(e) {
  const c = e && e.code;
  return typeof c === 'string' ? c.toUpperCase() : '';
}

/** @param {any} e */
function nameOf(e) {
  const n = e && e.name;
  return typeof n === 'string' ? n : '';
}

/** @param {any} e */
function isFetchFailed(e) {
  return typeof (e && e.message) === 'string' && /fetch failed/i.test(e.message);
}

/** @param {any} v @returns {number|null} */
function toStatus(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

// ---------------------------------------------------------------------------
// §7 — breaker/<sha256(endpoint).slice(0,12)>.json
// ---------------------------------------------------------------------------

/**
 * §4.7: per endpoint. `MUBIT_ENDPOINT=https://…` must not start life inside a local outage.
 * @param {Record<string, any>} [cfg]
 * @returns {string}
 */
export function breakerPath(cfg = {}) {
  const endpoint = typeof cfg?.endpoint === 'string' ? cfg.endpoint : '';
  const hash = createHash('sha256').update(endpoint).digest('hex').slice(0, 12);
  return join(resolveDataDir(cfg), 'breaker', `${hash}.json`);
}

/**
 * @typedef {object} BreakerState
 * @property {ConnState} state
 * @property {number[]} failures    epoch-ms, pruned to the rolling window
 * @property {number} openedAt      0 while closed
 * @property {number} timeoutStreak
 * @property {number} lastOkAt
 * @property {ConnState|''} lastState  the state before the most recent update
 * @property {number} probeAt       when the current open period last spent its half-open probe
 */

/** @returns {BreakerState} */
function fresh() {
  return {
    state: 'ready', failures: [], openedAt: 0, timeoutStreak: 0,
    lastOkAt: 0, lastState: '', probeAt: 0,
  };
}

/**
 * §6.1 knobs, through `cfg.breaker`. Never hard-coded: the tests shrink all three, and a
 * nonsense value (0, NaN, negative) falls back rather than opening a breaker on request one.
 * @param {Record<string, any>} [cfg]
 */
function params(cfg) {
  const b = (cfg && typeof cfg.breaker === 'object' && cfg.breaker) ? cfg.breaker : {};
  return {
    threshold: posInt(b.threshold, DEFAULT_THRESHOLD),
    windowMs: posInt(b.windowMs, DEFAULT_WINDOW_MS),
    cooldownMs: posInt(b.cooldownMs, DEFAULT_COOLDOWN_MS),
  };
}

/**
 * Read and sanitise. §4.9: a truncated, empty, absent or wrongly typed file is normal after
 * a SIGKILL or a full disk, and every one of them degrades to a fresh, closed breaker.
 * @param {Record<string, any>} cfg
 * @param {number} now
 * @param {number} windowMs
 * @returns {BreakerState}
 */
function load(cfg, now, windowMs) {
  const s = fresh();
  try {
    const raw = readJson(breakerPath(cfg), null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return s;

    if (isConnState(raw.state)) s.state = raw.state;
    if (isConnState(raw.lastState)) s.lastState = raw.lastState;
    if (Array.isArray(raw.failures)) {
      // The window is rolling, and the prune happens here so it is applied on every read as
      // well as every write: without expiry, five failures spread over a week would open the
      // breaker on a perfectly healthy box. |now - t| also drops timestamps from a clock
      // that jumped forward, which would otherwise pin the breaker open forever.
      s.failures = raw.failures.filter(
        (t) => typeof t === 'number' && Number.isFinite(t) && Math.abs(now - t) < windowMs,
      );
    }
    s.openedAt = num(raw.openedAt);
    s.lastOkAt = num(raw.lastOkAt);
    s.probeAt = num(raw.probeAt);
    s.timeoutStreak = Math.max(0, Math.trunc(num(raw.timeoutStreak)));
  } catch {
    return fresh();
  }
  return s;
}

/**
 * @param {Record<string, any>} cfg
 * @param {BreakerState} s
 * @returns {void}
 */
function save(cfg, s) {
  // `endpoint` is carried purely so a directory of hash-named files is readable by a human
  // debugging one; nothing reads it back.
  writeJsonAtomic(breakerPath(cfg), {
    state: s.state,
    failures: s.failures,
    openedAt: s.openedAt,
    timeoutStreak: s.timeoutStreak,
    lastOkAt: s.lastOkAt,
    lastState: s.lastState,
    probeAt: s.probeAt,
    endpoint: typeof cfg?.endpoint === 'string' ? cfg.endpoint : '',
  });
}

// ---------------------------------------------------------------------------
// readBreaker
// ---------------------------------------------------------------------------

/**
 * The persisted verdict, plus the two derived fields the status line and the hooks need.
 * A pure read — it never consumes the half-open probe and never writes.
 *
 * `display` is `warming` only inside the cold-start grace and only over a *failure*:
 * `warming` replaces a failure glyph, never a healthy one, and never an `auth_failed` —
 * a server still warming up does not answer 401, so masking that verdict would hide
 * the single error the user can fix.
 *
 * @param {Record<string, any>} cfg
 * @param {{coldStartUntil?: number}} [opts] `coldStartUntil` is the absolute epoch-ms
 *   deadline the marker stores as `cold_start_until` (§4.8), passed in because the breaker
 *   is keyed by endpoint and knows nothing about runs.
 * @returns {BreakerState & {display: DisplayState, suppressMessage: boolean}}
 */
export function readBreaker(cfg, opts = {}) {
  try {
    const { windowMs } = params(cfg);
    const now = Date.now();
    const s = load(cfg ?? {}, now, windowMs);

    const until = num(opts?.coldStartUntil);
    const warming = until > 0 && now < until && s.state !== 'ready' && s.state !== 'auth_failed';

    return {
      state: s.state,
      failures: s.failures,
      openedAt: s.openedAt,
      timeoutStreak: s.timeoutStreak,
      lastOkAt: s.lastOkAt,
      lastState: s.lastState,
      probeAt: s.probeAt,
      display: warming ? 'warming' : s.state,
      suppressMessage: warming,
    };
  } catch {
    return { ...fresh(), display: 'ready', suppressMessage: false };
  }
}

// ---------------------------------------------------------------------------
// recordFailure / recordSuccess
// ---------------------------------------------------------------------------

/**
 * Record one failed call.
 *
 * @param {Record<string, any>} cfg
 * @param {ConnState|string} state the `classifyError` verdict for this call
 * @returns {void}
 */
export function recordFailure(cfg, state) {
  try {
    const { threshold, windowMs } = params(cfg);
    const now = Date.now();
    const s = load(cfg ?? {}, now, windowMs);
    // `ready` is not a failure and an unknown string is not a verdict; both are recorded as
    // the conservative "something answered badly" so a caller's typo cannot lose the event.
    const kind = (isConnState(state) && state !== 'ready') ? state : 'server_error';
    const prev = s.state;

    // The streak counts *consecutive* timeouts. Anything else — including a 401 — means we
    // got an answer, so the run of timeouts is over.
    s.timeoutStreak = kind === 'not_responding' ? s.timeoutStreak + 1 : 0;

    if (kind === 'auth_failed') {
      // §4.7: sticky, and it never enters the failure window. `failures` stays empty so the
      // next request still fails loudly instead of being short-circuited.
      s.state = 'auth_failed';
    } else {
      s.failures.push(now);
      const cap = Math.max(threshold * 4, 64);
      if (s.failures.length > cap) s.failures = s.failures.slice(-cap);

      if (kind === 'not_responding') {
        // "A timeout is not a verdict": the count moved, the reported state does not — until
        // three in a row, and then only ever to `not_responding`.
        if (s.timeoutStreak >= TIMEOUT_ESCALATION && s.state !== 'auth_failed') {
          s.state = 'not_responding';
        }
      } else if (s.state !== 'auth_failed') {
        s.state = kind;
      }
    }

    if (s.failures.length >= threshold) {
      // Re-stamped on every failure at or above the threshold, which is also what re-opens
      // a breaker whose half-open probe just failed: the next probe is a full cooldown away
      // rather than immediately available.
      s.openedAt = now;
      s.probeAt = 0;
    }

    s.lastState = prev;
    save(cfg ?? {}, s);
  } catch {
    // §4.9: a breaker that cannot record is a slower plugin, never a broken prompt.
  }
}

/**
 * Record one successful call: closes the breaker, clears the window, drops the timeout
 * streak and releases the sticky `auth_failed`. A success is the only thing that does any
 * of these — which is why `failure.test.mjs` can assert the file itself is clean afterwards.
 *
 * @param {Record<string, any>} cfg
 * @returns {void}
 */
export function recordSuccess(cfg) {
  try {
    const { windowMs } = params(cfg);
    const now = Date.now();
    const prev = load(cfg ?? {}, now, windowMs).state;
    save(cfg ?? {}, {
      state: 'ready',
      failures: [],
      openedAt: 0,
      timeoutStreak: 0,
      lastOkAt: now,
      lastState: prev,
      probeAt: 0,
    });
  } catch {
    // See recordFailure.
  }
}

// ---------------------------------------------------------------------------
// allowRequest
// ---------------------------------------------------------------------------

/**
 * The gate every caller consults before dialing (§4.2). While the breaker is closed this is
 * a pure, idempotent read — a hook that checks twice must not lock itself out.
 *
 * While it is open it is *not* a pure read. Once the cooldown has elapsed the first caller
 * gets `true` and the probe is consumed by writing `probeAt`, so the second caller — a
 * concurrent hook, or the same hook checking again — gets `false`. Exactly one dial per
 * cooldown, which is the whole point of half-open. A further cooldown earns another.
 *
 * Fails *open*: if the state cannot be read or written, requests are allowed. Failing shut
 * would cost the user their memory over an unwritable data dir.
 *
 * @param {Record<string, any>} cfg
 * @returns {boolean}
 */
export function allowRequest(cfg) {
  try {
    const { windowMs, cooldownMs } = params(cfg);
    const now = Date.now();
    const s = load(cfg ?? {}, now, windowMs);

    if (!(s.openedAt > 0)) return true;

    // The clock the cooldown runs from: the moment it opened, or the last probe it spent.
    const since = Math.max(s.openedAt, s.probeAt);
    if (now - since < cooldownMs) return false;

    s.probeAt = now;
    save(cfg ?? {}, s);
    return true;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/** @param {any} v @returns {v is ConnState} */
function isConnState(v) {
  return typeof v === 'string' && /** @type {readonly string[]} */ (CONN_STATES).includes(v);
}

/** @param {any} v @returns {number} */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** @param {any} v @param {number} d @returns {number} */
function posInt(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : d;
}
