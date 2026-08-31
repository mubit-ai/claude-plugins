// @ts-check
/**
 * `lib/credentials.mjs` — the store `/mubit-memory:auth` writes into.
 *
 * Why this module exists at all: `apiKey` is a `userConfig` key, and Claude Code keeps
 * `sensitive` userConfig values in the OS keychain. There is no API for a slash command
 * to *write* that keychain entry — the `/plugin` UI is the only writer. So a command
 * that obtains a key has nowhere to put it unless the plugin owns a store of its own.
 *
 * That store is `${CLAUDE_PLUGIN_DATA}/credentials.json`, and the whole of its
 * contract is: it holds a live credential, so it is owner-only, and it never takes a
 * hook down.
 *
 * The mode assertions here are the point of the file. `0600` is not decoration — this
 * is the one file in the plugin that holds a secret at rest, and the two ways of
 * getting it wrong (chmod after write; writing into a file that already exists at a
 * wider mode) both leave a window where the key is world-readable and both look
 * completely fine in a passing round-trip test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { lib, makeDataDir } from './helpers/harness.mjs';

/** Root ignores mode bits entirely, so these assertions would pass vacuously. */
const IS_ROOT = process.getuid?.() === 0;

/** The permission bits, as an octal string: 0o600 -> '600'. */
const modeOf = (p) => (statSync(p).mode & 0o777).toString(8);

const KEY = 'mbt_credentials_test_key';

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test('writeCredentials then readCredentials round-trips', async () => {
  const { writeCredentials, readCredentials } = await lib('credentials.mjs');
  const dir = makeDataDir();

  assert.equal(writeCredentials(dir, { endpoint: 'https://api.mubit.ai', apiKey: KEY }), true,
    'writeCredentials must report success');

  assert.deepEqual(readCredentials(dir), { endpoint: 'https://api.mubit.ai', apiKey: KEY });
});

test('readCredentials returns {} when the file has never been written', async () => {
  const { readCredentials } = await lib('credentials.mjs');
  assert.deepEqual(readCredentials(makeDataDir()), {},
    'an absent store is the normal first-run state, not an error');
});

test('writeCredentials merges rather than replacing', async () => {
  const { writeCredentials, readCredentials } = await lib('credentials.mjs');
  const dir = makeDataDir();

  writeCredentials(dir, { endpoint: 'https://api.mubit.ai', apiKey: KEY });
  writeCredentials(dir, { apiKey: 'mbt_rotated' });

  assert.deepEqual(readCredentials(dir), { endpoint: 'https://api.mubit.ai', apiKey: 'mbt_rotated' },
    're-authenticating rotates the key; it must not silently drop the endpoint alongside it');
});

test('a blank or null value removes its key instead of storing an empty string', async () => {
  const { writeCredentials, readCredentials } = await lib('credentials.mjs');
  const dir = makeDataDir();

  writeCredentials(dir, { endpoint: 'https://api.mubit.ai', apiKey: KEY });
  writeCredentials(dir, { apiKey: '' });

  assert.deepEqual(readCredentials(dir), { endpoint: 'https://api.mubit.ai' },
    'config precedence tests `!== undefined`, so a stored "" would shadow the rungs below it');
});

// ---------------------------------------------------------------------------
// Mode — the reason this module is not just readJson/writeJsonAtomic
// ---------------------------------------------------------------------------

test('the credentials file is created owner-only (0600)', { skip: IS_ROOT }, async () => {
  const { writeCredentials, credentialsPath } = await lib('credentials.mjs');
  const dir = makeDataDir();

  writeCredentials(dir, { apiKey: KEY });

  assert.equal(modeOf(credentialsPath(dir)), '600',
    'the one file in this plugin that holds a secret at rest must not be group- or world-readable');
});

/**
 * The regression that a round-trip test cannot see. `writeFileSync(p, body)` onto an
 * existing path keeps that path's mode, so a file created 0644 by an older version — or
 * by a user's editor — would stay 0644 forever while every test still passed. Writing a
 * fresh temp file and renaming is what makes the mode unconditional.
 */
test('an existing wide-open credentials file is narrowed, not inherited', { skip: IS_ROOT }, async () => {
  const { writeCredentials, credentialsPath } = await lib('credentials.mjs');
  const dir = makeDataDir();
  const p = credentialsPath(dir);

  mkdirSync(dir, { recursive: true });
  writeFileSync(p, '{"apiKey":"mbt_old"}', 'utf8');
  chmodSync(p, 0o644);

  writeCredentials(dir, { apiKey: KEY });

  assert.equal(modeOf(p), '600',
    'the new file must carry its own mode — inheriting the old one leaves the key readable');
});

/**
 * `rename(2)` is atomic, but only the rename is. If the temp file is created at the
 * default mode and chmod'd afterwards, the key is on disk world-readable in between.
 * Asserting on the temp file directly is racy, so assert the invariant that rules the
 * race out: nothing is left behind, and the only artifact is already 0600.
 */
test('no temp file survives a write', { skip: IS_ROOT }, async () => {
  const { writeCredentials } = await lib('credentials.mjs');
  const dir = makeDataDir();

  writeCredentials(dir, { apiKey: KEY });

  const strays = readdirSync(dir).filter((f) => f.startsWith('credentials.json.tmp'));
  assert.deepEqual(strays, [], 'a leftover temp file is a second copy of the key at an unknown mode');
});

// ---------------------------------------------------------------------------
// Never throws — every caller is on a hook's critical path (§4.9)
// ---------------------------------------------------------------------------

test('corrupt JSON reads as {} rather than throwing', async () => {
  const { readCredentials, credentialsPath } = await lib('credentials.mjs');
  const dir = makeDataDir();

  mkdirSync(dir, { recursive: true });
  writeFileSync(credentialsPath(dir), '{ this is not json', 'utf8');

  assert.deepEqual(readCredentials(dir), {},
    'a truncated store after a SIGKILL must degrade to unconfigured, never break a prompt');
});

test('a write to an unwritable location reports false instead of throwing', async () => {
  const { writeCredentials } = await lib('credentials.mjs');
  // A path under a regular file can never be a directory.
  const dir = makeDataDir();
  const wedged = join(dir, 'notadir');
  writeFileSync(wedged, 'x', 'utf8');

  assert.equal(writeCredentials(join(wedged, 'nested'), { apiKey: KEY }), false,
    'writeCredentials returns a boolean; it never throws');
});

test('clearCredentials removes the file and is safe when there is nothing to remove', async () => {
  const { writeCredentials, clearCredentials, readCredentials, credentialsPath } =
    await lib('credentials.mjs');
  const dir = makeDataDir();

  clearCredentials(dir); // no file yet — must not throw

  writeCredentials(dir, { apiKey: KEY });
  clearCredentials(dir);

  assert.equal(existsSync(credentialsPath(dir)), false, 'the file must be gone');
  assert.deepEqual(readCredentials(dir), {}, 'and reading it must be the unconfigured state again');
});

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test('credentialsPath sits under the data dir, which survives plugin updates', async () => {
  const { credentialsPath } = await lib('credentials.mjs');
  const dir = makeDataDir();

  assert.equal(credentialsPath(dir), join(dir, 'credentials.json'));
});

test('a non-object write is ignored rather than corrupting the store', async () => {
  const { writeCredentials, readCredentials } = await lib('credentials.mjs');
  const dir = makeDataDir();

  writeCredentials(dir, { apiKey: KEY });
  // @ts-expect-error — deliberately wrong type
  writeCredentials(dir, 'mbt_bare_string');

  assert.deepEqual(readCredentials(dir), { apiKey: KEY },
    'the store stays a flat object of userConfig keys; a bad call must not replace it');
});

test('the stored JSON is a flat object, so config.mjs can read it like the project file', async () => {
  const { writeCredentials, credentialsPath } = await lib('credentials.mjs');
  const dir = makeDataDir();

  writeCredentials(dir, { endpoint: 'https://api.mubit.ai', apiKey: KEY });

  const parsed = JSON.parse(readFileSync(credentialsPath(dir), 'utf8'));
  assert.equal(typeof parsed, 'object');
  assert.equal(Array.isArray(parsed), false);
  for (const v of Object.values(parsed)) {
    assert.equal(typeof v, 'string',
      'values are userConfig strings — `.mubit-cc.json` is parsed the same way');
  }
});
