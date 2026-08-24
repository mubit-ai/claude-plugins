// @ts-check
/**
 * `lib/log.mjs` — the ring log at `logs/mubit-cc.log` (§4.8, §7).
 *
 * "Every message passes through `redactText` on the way out." That is not a
 * nicety: the log is the easiest place in the whole plugin to leak the API key
 * you were debugging, and it is the one artefact a user pastes into an issue.
 * Both the message AND every field, recursively, go through the scrub.
 *
 * Rotates at 1 MiB and keeps exactly two files — a ring, not an unbounded log.
 * Never throws: logging is never allowed to be the thing that breaks a hook.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { redactText } from './redact.mjs';
import { resolveDataDir } from './state.mjs';

/** §6.1 `MUBIT_CC_LOG_LEVEL`: error|warn|info|debug, default `warn`. */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const MAX_BYTES = 1024 * 1024;
const FILE = 'mubit-cc.log';
const PREV = 'mubit-cc.log.1';

/**
 * @param {Record<string, any>} cfg
 * @param {'error'|'warn'|'info'|'debug'|string} level
 * @param {string} msg
 * @param {Record<string, any>} [fields]
 * @returns {void}
 */
export function log(cfg, level, msg, fields = {}) {
  try {
    const want = LEVELS[String(level)] ?? LEVELS.info;
    const threshold = LEVELS[String(cfg?.logLevel ?? 'warn')] ?? LEVELS.warn;
    if (want > threshold) return;

    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: String(level),
      msg: scrubOne(msg, cfg),
      ...scrubFields(fields, cfg),
    });

    const dir = join(resolveDataDir(cfg), 'logs');
    try { mkdirSync(dir, { recursive: true }); } catch { return; }

    const file = join(dir, FILE);
    rotateIfNeeded(dir, file);
    appendFileSync(file, `${line}\n`, 'utf8');
  } catch {
    // §4.9/§12.1: a log that cannot be written costs the log, nothing else.
  }
}

/** Rotate at 1 MiB, keeping exactly `mubit-cc.log` and `mubit-cc.log.1`. */
function rotateIfNeeded(dir, file) {
  try {
    if (statSync(file).size < MAX_BYTES) return;
    renameSync(file, join(dir, PREV)); // rename(2) replaces the previous ring slot
  } catch {
    // No file yet, or the rename lost a race — either way, just append.
  }
}

/** @param {any} v @param {Record<string, any>} cfg @returns {string} */
function scrubOne(v, cfg) {
  const s = typeof v === 'string' ? v : safeString(v);
  // Force the scrub on even when `MUBIT_CC_REDACT=0`: that switch exists so tool
  // output is not mangled, not so credentials can reach a file on disk.
  return redactText(s, { ...(cfg ?? {}), redact: true }, 'output').text;
}

/**
 * Recursively route every field value through the same scrub as the message.
 * @param {any} fields
 * @param {Record<string, any>} cfg
 * @returns {Record<string, any>}
 */
function scrubFields(fields, cfg) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = scrubValue(v, cfg, 0);
  return out;
}

/** @param {any} v @param {Record<string, any>} cfg @param {number} depth */
function scrubValue(v, cfg, depth) {
  if (depth > 8) return '[depth]';
  if (typeof v === 'string') return scrubOne(v, cfg);
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, cfg, depth + 1));
  if (v instanceof Error) return scrubOne(`${v.name}: ${v.message}`, cfg);
  if (v && typeof v === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = scrubValue(val, cfg, depth + 1);
    return out;
  }
  return v;
}

/** @param {any} v @returns {string} */
function safeString(v) {
  if (v === null || v === undefined) return '';
  try { return typeof v === 'object' ? JSON.stringify(v) ?? '' : String(v); } catch { return ''; }
}
