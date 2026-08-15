// @ts-check
/**
 * `lib/credentials.mjs` — the store `/mubit-memory:auth` writes into.
 *
 * `apiKey` and `endpoint` are `userConfig` keys, and Claude Code keeps `sensitive`
 * userConfig values in the OS keychain. There is no API for a slash command to *write*
 * that keychain entry — the `/plugin` UI is its only writer. So a command that goes and
 * fetches a key for the user has nowhere to put it unless the plugin owns a store, and
 * this is that store: `${CLAUDE_PLUGIN_DATA}/credentials.json`, owner-only.
 *
 * It sits under the data dir rather than the plugin root because
 * `${CLAUDE_PLUGIN_ROOT}` is replaced wholesale on every plugin update, and logging in
 * again after each release is not a thing anyone should have to do.
 *
 * Three rules, inherited from `lib/state.mjs`:
 *
 *   1. Zero dependencies, Node >= 20 built-ins only.
 *   2. Synchronous — every caller is a short-lived process about to exit.
 *   3. Nothing throws. `loadConfig` calls in on a hook's critical path, and a
 *      credential store has no business breaking a prompt (§4.9).
 *
 * Nothing here logs. The values are secrets, and the redaction layer is downstream of
 * this module, not around it.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './state.mjs';

/** Owner read/write. The one file in this plugin holding a live secret at rest. */
const FILE_MODE = 0o600;

const FILE = 'credentials.json';

/**
 * @param {string} dataDir  the resolved `${CLAUDE_PLUGIN_DATA}` root
 * @returns {string}
 */
export function credentialsPath(dataDir) {
  return join(String(dataDir ?? ''), FILE);
}

/**
 * The stored credentials, as a flat object of `userConfig` keys.
 *
 * Absent, empty, truncated or binary all read as `{}` — the unconfigured state. That
 * is the normal first run, and it is also what a SIGKILL mid-write leaves behind; both
 * mean "no credential", and neither is an error worth surfacing to a prompt.
 *
 * @param {string} dataDir
 * @returns {Record<string, string>}
 */
export function readCredentials(dataDir) {
  try {
    const raw = readFileSync(credentialsPath(dataDir), 'utf8');
    if (!raw || !raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return {};
    /** @type {Record<string, string>} */
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v !== '') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Merge `values` into the store and persist it, owner-only.
 *
 * **Merge, not replace.** Re-authenticating rotates `apiKey`, and a replacing write
 * would take `endpoint` with it — leaving the plugin holding a valid key and nothing to
 * point it at.
 *
 * **A blank value deletes its key** rather than storing `''`. `lib/config.mjs` tests
 * each rung with `!== undefined`, so an empty string here would shadow every rung below
 * it and pin the setting to blank — the precedence bug that looks like "my env var
 * stopped working".
 *
 * @param {string} dataDir
 * @param {Record<string, string|null|undefined>} values
 * @returns {boolean} true when the store landed
 */
export function writeCredentials(dataDir, values) {
  if (!isPlainObject(values)) return false;
  try {
    const next = readCredentials(dataDir);
    for (const [k, v] of Object.entries(values)) {
      if (v === null || v === undefined || v === '') delete next[k];
      else if (typeof v === 'string') next[k] = v;
    }
    return writeJsonAtomic(credentialsPath(dataDir), next, { mode: FILE_MODE });
  } catch {
    return false;
  }
}

/**
 * Remove the store. Safe when there is nothing to remove — "already logged out" is a
 * success, not a failure.
 * @param {string} dataDir
 * @returns {boolean}
 */
export function clearCredentials(dataDir) {
  try {
    const p = credentialsPath(dataDir);
    if (existsSync(p)) unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/** @param {any} v @returns {boolean} */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
