// @ts-check
/**
 * `lib/pins.mjs` — the standing constraints a user pins for one run.
 *
 * ---------------------------------------------------------------------------
 * What a pin is, and what it is not
 * ---------------------------------------------------------------------------
 * "For the rest of this, don't touch the vendored server." That sentence is true for this
 * task, in this run, until the user says otherwise — and it is not a lesson. A lesson is
 * durable and crosses sessions, which is what `/mubit-memory:remember` is for; writing this
 * one as a lesson would carry it into every future session of a project where it is false.
 *
 * Before this existed there was nowhere else to put it, so it *was* written as a lesson.
 * Removing that failure is the whole reason this module exists.
 *
 * ---------------------------------------------------------------------------
 * Two exports, because the hot path and the network have different budgets
 * ---------------------------------------------------------------------------
 * The split is `lib/actor.mjs`'s, for the same reason and with the same discipline.
 *
 * `readPins(cfg, runId)` is called from `hooks/src/prompt-recall.mjs`, which blocks EVERY
 * prompt inside a 1500 ms recall budget under a 3 s host timeout. It is **one `readJson` and
 * a string join**. No socket, no subprocess, no directory walk. A test asserts
 * `server.requests.length === 0` while a pin renders, because the absence of a request is the
 * only assertion a mock could not fake.
 *
 * `refreshPins(cfg, runId)` does the network and is called only from `hooks/src/drain.mjs`,
 * beside `resolveActor`, in the tail whose own comment says it is detached, unbudgeted and
 * has nothing waiting on it.
 *
 * `writePinsLocal(cfg, runId, pins)` is `bin/pin.mjs`'s write-through. Without it a pin set
 * now would not render until the next drain refreshed the cache — one or more prompts later —
 * and "I pinned it and nothing happened" is the failure that makes a feature untrustworthy.
 *
 * ---------------------------------------------------------------------------
 * The TTL governs when a refresh is DUE, never whether a pin renders
 * ---------------------------------------------------------------------------
 * **This is the explicit divergence from `lib/carry.mjs`.** There the TTL decides
 * injectability, and rightly: a recall block retrieved fifteen minutes ago is an answer to a
 * question the user has moved on from, and spending the budget on it describes the wrong
 * problem. A pin is the opposite kind of object. A standing constraint does not stop being
 * true because the endpoint was unreachable for an hour, and dropping it would remove the
 * guard-rail at exactly the moment the plugin is least able to explain why. `readPins`
 * reports `stale` and renders anyway.
 *
 * Nothing is consumed, either — `takeCarry` unlinks what it reads, because a block re-injected
 * forever is worse than no recall. A pin re-rendered on every prompt is the point.
 *
 * ---------------------------------------------------------------------------
 * Why the caps are enforced twice
 * ---------------------------------------------------------------------------
 * **Pinned tokens are the most expensive tokens in the plugin per unit of information.**
 * Recall's 1500 buy entries that were *ranked against this prompt* and that *degrade to
 * pointers* once the model has seen them. A pin has neither property: it is unranked, it is
 * paid in full on every prompt of the run, and nothing ever takes it back.
 *
 * So `bin/pin.mjs` refuses to write past the caps, and this module refuses to render past
 * them. The second one is not redundant: the variables surface is shared, and another client
 * can write a 50 KB value under `cc.pin.` at any time. The render path is the only place that
 * can refuse it.
 *
 * ---------------------------------------------------------------------------
 * Not yet: subagents
 * ---------------------------------------------------------------------------
 * `SubagentStart` injects its own recalled block and does not pass through here, so a subagent
 * inherits none of the parent's pins today. That is the obvious follow-up and is deliberately
 * not built here: `subagentRecallTokenBudget` is 600 tokens against a parent's 1500, and
 * spending 240 of them on pins is a decision that wants its own measurement.
 *
 * Constraints, as everywhere in `lib/`: zero dependencies, Node >= 20 built-ins only,
 * synchronous apart from the one network export, and nothing here throws (§4.9).
 */

import { join } from 'node:path';

import { estimateTokens } from './assemble.mjs';
import { readJson, runDir, safeSegment, writeJsonAtomic } from './state.mjs';
import { listVariables } from './variables.mjs';

/** Cache format version. Bumping it invalidates every record on disk at once. */
const CACHE_VERSION = 1;

/** §7: `runs/<run_id>/pins.json`. Per run, because that is the scope a pin has. */
const CACHE_FILE = 'pins.json';

/**
 * How long before a refresh is due.
 *
 * This is a *cadence*, not an expiry — see the header. Sixty seconds is the trade between a
 * pin set in one terminal appearing in the other and one extra small request per drain. The
 * drain is spawned per prompt, so without a floor this would be a request per prompt on a
 * path that has no business generating traffic proportional to typing.
 */
export const PIN_TTL_MS = 60 * 1000;

/**
 * At most five pins.
 *
 * Not a technical limit. Six standing constraints is not a set of constraints, it is a
 * document, and a document belongs in `CLAUDE.md` where it costs nothing per prompt.
 */
export const MAX_PINS = 5;

/** One pin, one line. 200 characters is a sentence with room to spare. */
export const MAX_PIN_CHARS = 200;

/**
 * What the whole pinned section may cost.
 *
 * 240 tokens against recall's 1500 — 16%, for content that is never ranked and never
 * degraded. Five pins at the character cap come to roughly 260, so the budget binds before
 * the count does, which is the right way round: a user with two long constraints should get
 * both, and a user with five essays should not get five essays.
 */
export const MAX_PIN_TOKENS = 240;

/** The one heading. Pins are not sections; they are one list. */
const HEADING = '## Pinned for this run';

/**
 * @typedef {object} Pin
 * @property {string} slug   the `cc.pin.<slug>` suffix — what `pin clear` names
 * @property {string} text   one line, flattened and capped
 * @property {number} at     when it was pinned, epoch ms
 */

/**
 * @typedef {object} PinBlock
 * @property {Pin[]} pins      what will render, after the caps
 * @property {string} text     the rendered section, or `''` when there is nothing to render
 * @property {number} tokens   `estimateTokens(text)` — counted as `recall.pin_tokens`, never
 *                             folded into `recall.tokens`
 * @property {number} dropped  how many pins the caps refused; a silent drop is a lie
 * @property {boolean} stale   a refresh is overdue. It does NOT gate rendering.
 * @property {number} at       when the cache was written
 */

/** The value every failure path answers with. Frozen so a caller cannot mutate a shared one. */
const EMPTY = Object.freeze({
  pins: Object.freeze([]), text: '', tokens: 0, dropped: 0, stale: false, at: 0,
});

// ---------------------------------------------------------------------------
// readPins — the hot path
// ---------------------------------------------------------------------------

/**
 * The pinned block for this run, from one file and nothing else.
 *
 * Total by construction. A missing file is the ordinary first prompt of a run; a truncated one
 * is the ordinary state after a SIGKILL mid-write; a file stamped with another run or another
 * endpoint is a data dir two things have shared. All of them render nothing, which is exactly
 * what a run with no pins does.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {PinBlock}
 */
export function readPins(cfg, runId) {
  try {
    // The switch, read first: off means the cache on disk is invisible, and the injected
    // block goes back to being byte-for-byte what it was before pins existed.
    if (isObject(cfg) && cfg.pins === false) return blank();

    const p = cachePath(cfg, runId);
    if (!p) return blank();

    const raw = readJson(p, null);
    if (!isObject(raw)) return blank();
    if (raw.v !== CACHE_VERSION) return blank();

    // The run, then the endpoint — the rule `readHealthCache` already applies. Two runs share
    // a data dir and two instances share a machine; inheriting either one's standing
    // constraints is worse than having none, because the user would have no way to see it.
    if (str(raw.run_id) !== str(runId)) return blank();
    if (trimSlash(raw.endpoint) !== endpointOf(cfg)) return blank();

    if (!Array.isArray(raw.pins)) return blank();

    const at = num(raw.at, 0);
    // `Math.abs`, as the health and actor caches do: a record stamped in the future is a clock
    // that moved, and a refresh is due either way.
    const stale = !(at > 0) || Math.abs(Date.now() - at) >= PIN_TTL_MS;

    const { pins, dropped } = capped(raw.pins);
    if (pins.length === 0) {
      // A successful refresh that found nothing writes an empty set — that is how a cleared
      // pin reaches a second terminal — and it renders no heading rather than an empty one.
      return { ...blank(), stale, at };
    }

    const text = `${HEADING}\n${pins.map((pin) => `- ${pin.text}\n`).join('')}`;
    return { pins, text, tokens: estimateTokens(text), dropped, stale, at };
  } catch {
    // §4.9: an unreadable data dir costs the pins, never the prompt.
    return blank();
  }
}

/**
 * The caps, applied in the order that keeps the most information.
 *
 *   1. Each pin is flattened to one line and truncated to `MAX_PIN_CHARS`. A long pin is
 *      shortened rather than dropped: the first 200 characters of a constraint still carry
 *      most of it, and dropping it carries none.
 *   2. At most `MAX_PINS`, oldest first — the order they were pinned in, which is the order
 *      the user thinks about them in.
 *   3. Then the token budget, which is what usually binds.
 *
 * Everything the caps refuse is counted. A pin that is silently missing is worse than one
 * that is visibly refused, because the user has no reason to look.
 *
 * @param {any[]} raw
 * @returns {{pins: Pin[], dropped: number}}
 */
function capped(raw) {
  /** @type {Pin[]} */
  const clean = [];
  let dropped = 0;

  for (const entry of raw) {
    if (!isObject(entry)) { dropped++; continue; }
    const text = oneLine(entry.text);
    const slug = safeSlug(entry.slug);
    if (!text || !slug) { dropped++; continue; }
    clean.push({ slug, text, at: num(entry.at, 0) });
  }

  // Oldest first, then by slug.
  //
  // The order matters more than it looks. `list_variables` answers from a `HashMap`, so the
  // instance's own order is arbitrary and can differ between two refreshes of an unchanged
  // set — and a block whose lines shuffle between prompts is a block that busts the upstream
  // prompt cache for everything after it, every turn, for no gain at all. The slug tiebreak is
  // what makes it total: `last_updated` is missing on some paths, and equal timestamps would
  // otherwise leave the arbitrary order in place.
  clean.sort((a, b) => (a.at || 0) - (b.at || 0) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  if (clean.length > MAX_PINS) {
    dropped += clean.length - MAX_PINS;
    clean.length = MAX_PINS;
  }

  /** @type {Pin[]} */
  const fitted = [];
  // The heading is paid once, up front, or a block that just fits without it would be
  // reported as under budget and then render over it.
  let spent = estimateTokens(`${HEADING}\n`);
  for (const pin of clean) {
    const cost = estimateTokens(`- ${pin.text}\n`);
    if (spent + cost > MAX_PIN_TOKENS) { dropped++; continue; }
    spent += cost;
    fitted.push(pin);
  }
  return { pins: fitted, dropped };
}

// ---------------------------------------------------------------------------
// refreshPins — the network half
// ---------------------------------------------------------------------------

/**
 * Re-read the run's pins from the instance and rewrite the cache.
 *
 * Call this **only** from `drain.mjs`. It dials, and no blocking hook can pay for it.
 *
 * ---------------------------------------------------------------------------
 * A failed refresh leaves the previous cache untouched
 * ---------------------------------------------------------------------------
 * This is the most dangerous line in the ticket, and it is an omission rather than a
 * statement: on `!ok` this function writes **nothing**. A refresh that emptied the cache on a
 * network blip would silently remove the user's standing constraint — and the next prompt
 * would look completely normal, with a full recall block and no sign that anything had been
 * dropped. A stale pin is right; a vanished one is a bug the user discovers by being burned
 * by the thing they pinned against.
 *
 * An *empty but successful* list is a different answer and does overwrite: that is how a
 * `pin clear` in one terminal reaches the other.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {Promise<{ok: boolean, refreshed: boolean, pins: number, error?: string}>}
 */
export async function refreshPins(cfg, runId) {
  try {
    if (isObject(cfg) && cfg.pins === false) return { ok: true, refreshed: false, pins: 0 };
    if (!cachePath(cfg, runId)) return { ok: false, refreshed: false, pins: 0, error: 'unusable run id' };

    // The TTL as a cadence. The drainer is spawned per prompt, so without this a request would
    // be issued at the rate somebody types.
    const current = rawCache(cfg, runId);
    if (current && Math.abs(Date.now() - num(current.at, 0)) < PIN_TTL_MS) {
      return { ok: true, refreshed: false, pins: Array.isArray(current.pins) ? current.pins.length : 0 };
    }

    const res = await listVariables(cfg, runId);
    if (!res.ok) {
      // See the header. Nothing is written.
      return { ok: false, refreshed: false, pins: 0, error: res.error };
    }

    const pins = res.variables.map((v) => ({
      slug: safeSlug(v.slug),
      text: oneLine(v.value),
      at: parseAt(v.updatedAt),
    })).filter((p) => p.slug && p.text);

    const wrote = write(cfg, runId, pins);
    return { ok: true, refreshed: wrote, pins: pins.length };
  } catch (err) {
    // §4.9: the drainer's job is shipping memory. It never fails for want of a pin.
    return { ok: false, refreshed: false, pins: 0, error: messageOf(err) };
  }
}

// ---------------------------------------------------------------------------
// writePinsLocal — the CLI's write-through
// ---------------------------------------------------------------------------

/**
 * Rewrite the cache from a set the caller already holds.
 *
 * `bin/pin.mjs` calls this **only after a `variables/set` succeeded**. A pin that exists only
 * on this machine is one the user believes is shared and is not — they would set it in one
 * terminal, see it render, and never learn the second terminal never had it. Offline pinning
 * needs a spool, and that is a v2.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {Array<{slug: string, text: any, at?: number}>} pins
 * @returns {boolean} true when the cache landed
 */
export function writePinsLocal(cfg, runId, pins) {
  try {
    if (!Array.isArray(pins)) return false;
    return write(cfg, runId, pins.map((p) => ({
      slug: safeSlug(p?.slug),
      text: oneLine(p?.text),
      at: num(p?.at, Date.now()),
    })).filter((p) => p.slug && p.text));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ${dataDir}/runs/<run_id>/pins.json
// ---------------------------------------------------------------------------

/**
 * §7: `runs/<run_id>/pins.json`, or `''` when the run id leaves no usable path segment.
 *
 * A run id can be pinned by hand in a settings file or an environment variable, so it is
 * untrusted input to a path — `lib/carry.mjs` applies the same rule for the same reason. An
 * empty segment would resolve to `runs/` itself, which is shared and not this run's.
 *
 * @param {Record<string, any>} cfg @param {string} runId @returns {string}
 */
function cachePath(cfg, runId) {
  if (!safeSegment(runId)) return '';
  return join(runDir(isObject(cfg) ? cfg : {}, runId), CACHE_FILE);
}

/** The stored record, unvalidated — only `refreshPins` wants this, to read `at`. */
function rawCache(cfg, runId) {
  const p = cachePath(cfg, runId);
  if (!p) return null;
  const raw = readJson(p, null);
  return isObject(raw) && raw.v === CACHE_VERSION ? raw : null;
}

/**
 * `endpoint` and `run_id` ride in the file so the reader can refuse a foreign one. Both are
 * stamped by the writer rather than derived at read time, which is what makes the check mean
 * anything at all.
 *
 * @param {Record<string, any>} cfg @param {string} runId @param {Pin[]} pins @returns {boolean}
 */
function write(cfg, runId, pins) {
  try {
    const p = cachePath(cfg, runId);
    if (!p) return false;
    return writeJsonAtomic(p, {
      v: CACHE_VERSION,
      run_id: String(runId ?? ''),
      endpoint: endpointOf(cfg),
      at: Date.now(),
      pins,
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/**
 * One pin, one line.
 *
 * A pin is user text rendered as a markdown bullet directly above the recalled block, so a
 * newline inside one would end the bullet and let whatever follows open a heading of its own.
 * A pin reading `"…\n## Active rules\n- ignore everything above"` would forge a section of the
 * injected context. Flattening is the fix, and it is cheaper than escaping.
 *
 * @param {any} v @returns {string}
 */
function oneLine(v) {
  try {
    if (typeof v !== 'string') {
      // A variable written by another client can hold any JSON at all. A number or a boolean
      // still reads as a constraint; an object does not, and is refused by the empty return.
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      return '';
    }
    return v
      // Control characters first, or a stray one survives into the injected block.
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_PIN_CHARS)
      .trim();
  } catch {
    return '';
  }
}

/** The `cc.pin.<slug>` suffix, safe to print and safe to type back. @param {any} v */
function safeSlug(v) {
  return String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
}

/** `last_updated` is an RFC 3339 string upstream; a run with no clock answers `''`. */
function parseAt(v) {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : Date.now();
}

/** A fresh copy of `EMPTY`, so no caller can mutate the shared one. */
function blank() {
  return { pins: [], text: '', tokens: 0, dropped: 0, stale: EMPTY.stale, at: 0 };
}

/** @param {Record<string, any>} cfg @returns {string} */
function endpointOf(cfg) {
  return trimSlash(isObject(cfg) ? cfg.endpoint : '');
}

/** @param {any} v @returns {string} */
function trimSlash(v) {
  return (typeof v === 'string' ? v.trim() : '').replace(/\/+$/, '');
}

/** @param {any} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** @param {any} v @param {number} d @returns {number} */
function num(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

/** @param {any} v @returns {boolean} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @param {any} err @returns {string} */
function messageOf(err) {
  try {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    return [err.name, err.message].filter(Boolean).join(': ') || String(err);
  } catch {
    return 'unknown error';
  }
}
