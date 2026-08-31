#!/usr/bin/env node
/**
 * Store a Mubit API key for a Codex install.
 *
 * `bin/auth.mjs` is shared with the Claude Code build, and on its own it writes to the bare
 * `~/.claude/plugins/data/mubit-memory`. Under Codex that is frequently the wrong directory:
 * `scripts/setup.mjs` resolves the one this machine actually uses — the suffix varies with the
 * install (`mubit-memory-<marketplace>`, `mubit-memory-inline`, …) — and PINS it as
 * MUBIT_CC_DATA_DIR in every registration it writes into `$CODEX_HOME/hooks.json`.
 *
 * So the hooks read one directory and a hand-run auth writes another, silently, with no error
 * anywhere. This script closes that gap: it reads the pin back out of the live registrations
 * and writes the credentials exactly where the hooks look.
 *
 * usage: node scripts/login.mjs [--key=mbt_...] [--endpoint=<url>] [--data-dir=<path>] [--status] [--json]
 *        key also accepted from MUBIT_AUTH_KEY / MUBIT_API_KEY, or a prompt.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { claudeCodeDataDir } from '../lib/boot.mjs';
import { authenticateWithKey, currentCredentials, normalizeEndpoint, DEFAULT_ENDPOINT } from '../bin/auth.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
};
const json = argv.includes('--json');
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');

/**
 * The pin `setup` wrote, which is what the hooks actually run with. Authoritative over any
 * search: a search is a guess about which install is live, this is the recorded answer.
 *
 * `liveDataDir()` in the claude-code integration's `lib/state.mjs` reads the same pin. This
 * copy stays because it must also report *which* rung answered — the `source` line below is
 * the whole reason a user can tell a recorded answer from a guess.
 * @returns {string}
 */
function pinnedDataDir() {
  const path = join(CODEX_HOME, 'hooks.json');
  if (!existsSync(path)) return '';
  try {
    const found = JSON.stringify(JSON.parse(readFileSync(path, 'utf8')))
      .match(/MUBIT_CC_DATA_DIR=\\"([^\\"]+)\\"/);
    return found ? found[1] : '';
  } catch {
    return '';
  }
}

const explicit = flag('data-dir');
const pinned = pinnedDataDir();
const dataDir = resolve(explicit || process.env.MUBIT_CC_DATA_DIR || pinned || claudeCodeDataDir(process.env));
const source = explicit ? 'from --data-dir'
  : process.env.MUBIT_CC_DATA_DIR ? 'from MUBIT_CC_DATA_DIR'
  : pinned ? 'pinned by setup in $CODEX_HOME/hooks.json'
  : 'resolved — setup has not run, so this is a guess';

const emit = (payload, text) => console.log(json ? JSON.stringify({ ...payload, dataDir }) : text);

if (argv.includes('--status')) {
  const cur = currentCredentials(dataDir);
  emit(
    { ok: cur.hasKey, state: cur.hasKey ? 'configured' : 'unconfigured', endpoint: cur.endpoint },
    cur.hasKey
      ? `A key is stored for ${cur.endpoint || DEFAULT_ENDPOINT} \u2014 read from disk, not dialed.\n  credentials: ${dataDir} (${source})`
      : `No Mubit credentials in ${dataDir} (${source}).`,
  );
  process.exit(cur.hasKey ? 0 : 1);
}

/**
 * Read a key from the terminal without echoing it. Node's readline echoes what is typed and
 * offers no supported way to suppress it — `_writeToOutput` is private and absent from the
 * promises interface on current Node — so take raw mode and read the bytes, the way `sudo`
 * does. A key in the scrollback is a key in the scrollback.
 * @param {string} prompt
 * @returns {Promise<string>}
 */
function readSecret(prompt) {
  return new Promise((resolve) => {
    const input = process.stdin;
    process.stderr.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let buf = '';
    const finish = (value, signal) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      process.stderr.write('\n');
      if (signal) {
        // Ctrl+C means cancelled, and must look cancelled: 130 is what a shell reports.
        process.exit(130);
      }
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(buf);
        if (ch === '\u0003') return finish('', true);
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        if (ch < ' ') continue;
        buf += ch;
      }
    };
    // stdin closing while we wait would otherwise hang here for ever, waiting on a keystroke
    // that cannot arrive. An empty answer is handled upstream; a hang is not handled anywhere.
    const onEnd = () => finish(buf);
    input.on('data', onData);
    input.once('end', onEnd);
  });
}

/** @returns {Promise<string>} */
async function readKey() {
  const given = flag('key') || process.env.MUBIT_AUTH_KEY || process.env.MUBIT_API_KEY || '';
  if (given) return given.trim();
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') return '';
  return (await readSecret('Mubit API key (mbt_\u2026): ')).trim();
}

const apiKey = await readKey();
if (!apiKey) {
  console.error('No key supplied. Pass --key=mbt_…, set MUBIT_AUTH_KEY, or run this in a terminal.');
  process.exit(1);
}

const endpoint = normalizeEndpoint(flag('endpoint') || process.env.MUBIT_ENDPOINT || '');
console.error(`data directory: ${dataDir}\n  ${source}`);

const res = await authenticateWithKey({ dataDir, endpoint, apiKey });
emit(
  { ok: res.ok, state: res.state, endpoint: res.endpoint, stored: res.stored },
  res.ok
    ? `${res.detail}\nStored in ${dataDir}. Start a NEW Codex session.`
    : `${res.detail}`,
);
process.exit(res.ok ? 0 : 1);
