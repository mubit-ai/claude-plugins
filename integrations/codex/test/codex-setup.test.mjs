// @ts-check
/**
 * `scripts/setup.mjs`, executed.
 *
 * This is 212 lines that rewrite two files in the user's `$CODEX_HOME` — the file every other
 * tool's hook registrations live in, and the file carrying their model choice, their notify
 * hook and their per-project trust levels. Until this file existed the entire coverage of it
 * was five `assert.match(src, /…/)` greps over its own source, which is a test that the script
 * *contains a string*, not that running it does anything in particular. A grep cannot catch a
 * script that deletes another tool's trust entry, because deleting it is not a string.
 *
 * So every test here runs the real script against a throwaway `$CODEX_HOME` and reads the
 * files afterwards.
 *
 * Two of them need `codex` on PATH — the trust write goes through `codex app-server`, and the
 * MCP registration through `codex mcp add`. They skip **by name** when it is absent, because
 * the alternative is a green run that checked neither.
 */

import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert, CODEX_ROOT } from './helpers/codex-fixtures.mjs';
import { codexVersion } from './helpers/codex-oracle.mjs';

const CODEX = codexVersion();
const needsCodex = {
  skip: CODEX.ok ? false
    : 'no `codex` on PATH — the trust write and the MCP registration could not be exercised. '
      + 'Those halves of setup are UNVERIFIED on this run.',
};

/** A throwaway `$CODEX_HOME`, optionally pre-seeded with a user's own files. */
function makeHome(files = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mubit-setup-home-')));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(home, name), body);
  return home;
}

/**
 * Run `scripts/setup.mjs` for real.
 *
 * @param {string} home
 * @param {string[]} [args]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runSetup(home, args = []) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(CODEX_ROOT, 'scripts', 'setup.mjs'), CODEX_ROOT, ...args], {
      env: { ...process.env, CODEX_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => { child.kill('SIGKILL'); rej(new Error('setup.mjs did not exit')); }, 60000);
    child.on('close', (code) => { clearTimeout(t); res({ code, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(t); rej(e); });
  });
}

const readHooks = (home) => JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8'));
const readToml = (home) => (existsSync(join(home, 'config.toml')) ? readFileSync(join(home, 'config.toml'), 'utf8') : '');

/** Every `[hooks.state."…"]` key in a config.toml, in file order. */
const stateKeys = (toml) => [...toml.matchAll(/^\[hooks\.state\."(.+?)"\]$/gm)].map((m) => m[1]);

/** A foreign tool's registrations, in the shape another vendor would plausibly write them. */
const FOREIGN_HOOKS = {
  hooks: {
    PostToolUse: [{
      matcher: '*',
      hooks: [{ type: 'command', timeout: 5, command: 'node "/opt/othertool/hooks/dist/audit.mjs"' }],
    }],
    SessionStart: [{
      hooks: [{ type: 'command', timeout: 5, command: '/usr/local/bin/othertool session-start' }],
    }],
  },
};

// ===========================================================================
// The merge
// ===========================================================================

test('a foreign handler survives the merge', async () => {
  const home = makeHome({ 'hooks.json': `${JSON.stringify(FOREIGN_HOOKS, null, 2)}\n` });
  await runSetup(home, ['--no-trust']);

  const after = readHooks(home);
  const commands = JSON.stringify(after);

  assert.match(commands, /othertool session-start/,
    'the foreign SessionStart handler was dropped. $CODEX_HOME/hooks.json is the user`s file '
    + 'and other tools register in it; setup merges, it does not own the file.');
  assert.match(commands, /\/opt\/othertool\/hooks\/dist\/audit\.mjs/,
    'the foreign PostToolUse handler was deleted. Its command contains `/hooks/dist/`, which is '
    + 'the substring `isMubit()` matched on — so any vendor who lays out their bundles the way '
    + 'we do had their hook silently removed from their own config.');
});

test('a backup of the user`s hooks.json is taken before it is touched', async () => {
  const home = makeHome({ 'hooks.json': `${JSON.stringify(FOREIGN_HOOKS, null, 2)}\n` });
  await runSetup(home, ['--no-trust']);

  const backup = join(home, 'hooks.json.before-mubit');
  assert.ok(existsSync(backup), 'no hooks.json.before-mubit was written');
  assert.deepEqual(JSON.parse(readFileSync(backup, 'utf8')), FOREIGN_HOOKS,
    'the backup does not hold what the file held before the run.');
});

test('our own handlers are replaced, not stacked, on a second run', async () => {
  const home = makeHome();
  await runSetup(home, ['--no-trust']);
  const one = readHooks(home);
  await runSetup(home, ['--no-trust']);
  const two = readHooks(home);

  assert.deepEqual(two, one,
    'a second run produced a different hooks.json. Ours are replaced by path so that re-running '
    + 'after an upgrade is idempotent rather than additive.');
  for (const [event, groups] of Object.entries(two.hooks)) {
    const ours = groups.flatMap((g) => g.hooks).filter((h) => h.command.includes(CODEX_ROOT));
    const paths = ours.map((h) => /"([^"]+\.mjs)"/.exec(h.command)?.[1]);
    assert.equal(new Set(paths).size, paths.length, `${event} carries the same command twice`);
  }
});

test('only `description` and `hooks` reach the merged file', async () => {
  const home = makeHome({
    'hooks.json': `${JSON.stringify({ ...FOREIGN_HOOKS, someFutureKey: { a: 1 } }, null, 2)}\n`,
  });
  await runSetup(home, ['--no-trust']);

  const after = readHooks(home);
  assert.deepEqual(Object.keys(after).filter((k) => k !== 'hooks' && k !== 'description'), [],
    'hooks.json accepts exactly `description` and `hooks`; anything else fails the whole file, '
    + 'which would take the user`s other registrations down with ours.');
});

test('PreToolUse is registered only when asked for', async () => {
  const a = makeHome();
  await runSetup(a, ['--no-trust']);
  assert.equal(readHooks(a).hooks.PreToolUse, undefined,
    'PreToolUse exists for warnings that are off by default; registering it anyway spends a '
    + 'hook spawn per tool call for nothing.');

  const b = makeHome();
  await runSetup(b, ['--no-trust', '--with-pre-tool']);
  assert.ok(readHooks(b).hooks.PreToolUse, '--with-pre-tool did not register it');
});

test('--data-dir pins the directory it was given', async () => {
  const home = makeHome();
  const pinned = realpathSync(mkdtempSync(join(tmpdir(), 'mubit-pinned-data-')));
  await runSetup(home, ['--no-trust', `--data-dir=${pinned}`]);

  const commands = Object.values(readHooks(home).hooks).flatMap((gs) => gs.flatMap((g) => g.hooks))
    .map((h) => h.command);
  assert.ok(commands.length, 'nothing was registered');
  for (const command of commands) {
    assert.ok(command.startsWith(`MUBIT_CC_DATA_DIR=${JSON.stringify(pinned)} `),
      'the pin is what stops a Codex session and a Claude Code session in one directory deriving '
      + 'the same run id and writing it to two different places. Every hook command carries it, '
      + `and this one does not:\n  ${command}`);
  }
});

test('a data directory with a space in it stays one argument', async () => {
  const home = makeHome();
  const spaced = join(realpathSync(mkdtempSync(join(tmpdir(), 'mubit-spaced-'))), 'data dir');
  await runSetup(home, ['--no-trust', `--data-dir=${spaced}`]);

  for (const groups of Object.values(readHooks(home).hooks)) {
    for (const h of groups.flatMap((g) => g.hooks)) {
      assert.match(h.command, /^MUBIT_CC_DATA_DIR="[^"]*"\s+node\s/,
        `the pin is not quoted in: ${h.command}\n  Codex runs a hook command as a shell string, `
        + 'so an unquoted path with a space becomes two arguments and the pin becomes garbage.');
    }
  }
});

// ===========================================================================
// The trust rewrite
// ===========================================================================

test('a foreign [hooks.state] entry survives the rewrite', needsCodex, async () => {
  // § Another tool's hooks.json, trusted by the user in their own TUI. Its trust entry names
  //   ITS source file, not ours, so nothing about it is ours to revoke.
  const foreignSource = '/opt/othertool/hooks.json';
  const foreignKey = `${foreignSource}:post_tool_use:0:0`;
  const before = [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "low"',
    '',
    `[hooks.state."${foreignKey}"]`,
    'trusted_hash = "sha256:1111111111111111111111111111111111111111111111111111111111111111"',
    '',
    '[projects."/Users/someone/work"]',
    'trust_level = "trusted"',
    '',
  ].join('\n');

  const home = makeHome({ 'config.toml': before });
  const r = await runSetup(home);
  assert.equal(r.code, 0, `setup exited ${r.code}:\n${r.stdout}\n${r.stderr}`);

  const after = readToml(home);
  assert.ok(stateKeys(after).includes(foreignKey),
    'setup revoked another tool`s hook trust. `stripHookState()` deleted every [hooks.state.*] '
    + 'table and rewrote only ours, and Codex silently skips an untrusted hook — so the other '
    + 'tool simply stops working, with no message, on our re-run.\n'
    + `  keys after: ${JSON.stringify(stateKeys(after), null, 2)}`);
  assert.match(after, /trusted_hash = "sha256:1111/,
    'the foreign table survived but lost its body, which leaves it as good as revoked.');
});

test('the user`s own settings are byte-identical across three runs', needsCodex, async () => {
  const before = [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "low"',
    'notify = ["/usr/local/bin/notify-me", "--sound"]',
    '',
    '[projects."/Users/someone/work"]',
    'trust_level = "trusted"',
    '',
    '[projects."/Users/someone/other"]',
    'trust_level = "untrusted"',
    '',
  ].join('\n');

  const home = makeHome({ 'config.toml': before });
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const r = await runSetup(home);
    assert.equal(r.code, 0, `run ${i + 1} exited ${r.code}:\n${r.stdout}\n${r.stderr}`);
    seen.push(readToml(home));
  }

  assert.equal(seen[1], seen[2],
    'three runs did not converge — run 2 and run 3 differ, so the file grows or churns forever.');

  // § The user's half, extracted by dropping every line this script owns.
  const theirs = (toml) => toml
    .split('\n')
    .filter((l) => !/^\[hooks\.state\./.test(l) && !/^trusted_hash\s*=/.test(l) && !/^# Mubit/.test(l)
      && !/^# Every \[hooks\.state\]/.test(l))
    .join('\n');
  for (const line of ['model = "gpt-5.6-sol"', 'notify = ["/usr/local/bin/notify-me", "--sound"]',
    '[projects."/Users/someone/work"]', '[projects."/Users/someone/other"]']) {
    assert.ok(seen[2].includes(line),
      `the user's \`${line}\` did not survive three runs. This file is theirs; we add tables to `
      + 'it and must reformat none of it.');
  }
  assert.equal(theirs(seen[1]), theirs(seen[2]),
    'the user`s own lines moved between runs.');
});

test('no [hooks.state] table is ever defined twice', needsCodex, async () => {
  // § The regression that bricked a real config. A trust key does not change when its command
  //   does, so appending rather than replacing produced a SECOND table with the same name —
  //   TOML forbids that, so Codex refused to start at all: "failed to load bootstrap
  //   configuration". A user cannot recover from that without editing the file by hand.
  const home = makeHome();
  for (let i = 0; i < 3; i++) await runSetup(home);

  const keys = stateKeys(readToml(home));
  assert.ok(keys.length > 0, 'no trust tables were written at all');
  assert.equal(new Set(keys).size, keys.length,
    'a [hooks.state] key is defined more than once, so config.toml no longer parses and Codex '
    + `will not start:\n  ${keys.join('\n  ')}`);
});

test('a foreign handler is never trusted on the user`s behalf', needsCodex, async () => {
  // § `hooks/list` returns every hook Codex can see, ours and theirs. Writing the whole result
  //   into config.toml would approve someone else's hook on the user's behalf — which is
  //   exactly the control the trust mechanism exists to be.
  const home = makeHome({ 'hooks.json': `${JSON.stringify(FOREIGN_HOOKS, null, 2)}\n` });
  const r = await runSetup(home);
  assert.equal(r.code, 0, `setup exited ${r.code}:\n${r.stdout}\n${r.stderr}`);

  const merged = readHooks(home);
  const foreign = Object.values(merged.hooks).flatMap((gs) => gs.flatMap((g) => g.hooks))
    .filter((h) => !h.command.includes(CODEX_ROOT));
  assert.ok(foreign.length, 'the foreign handlers vanished before trust was even considered');

  // A trust key is <sourcePath>:<event>:<group>:<index>. The merge appends ours as a NEW group
  // rather than into theirs, so on a shared event theirs stays group 0 and ours becomes group 1.
  const source = join(home, 'hooks.json');
  const trusted = stateKeys(readToml(home));
  for (const event of ['post_tool_use', 'session_start']) {
    assert.ok(trusted.includes(`${source}:${event}:1:0`),
      `ours should be trusted as group 1 of ${event}:\n  ${trusted.join('\n  ')}`);
    assert.ok(!trusted.includes(`${source}:${event}:0:0`),
      `setup trusted the foreign ${event} handler in group 0. Trust is the user's decision `
      + `about someone else's code:\n  ${trusted.join('\n  ')}`);
  }
});

test('the MCP registration carries the data-dir pin', needsCodex, async () => {
  const home = makeHome();
  const pinned = realpathSync(mkdtempSync(join(tmpdir(), 'mubit-pinned-data-')));
  const r = await runSetup(home, [`--data-dir=${pinned}`]);
  assert.equal(r.code, 0, `setup exited ${r.code}:\n${r.stdout}\n${r.stderr}`);

  const toml = readToml(home);
  assert.match(toml, /\[mcp_servers\.mubit\]/, 'the MCP server was not registered');
  assert.ok(toml.includes(pinned),
    'the MCP server was registered without MUBIT_CC_DATA_DIR. The server derives the run id '
    + 'itself, so one reading a different data directory writes /mubit-memory:remember into a '
    + `run pre-prompt recall never reads.\n${toml}`);
});

test('the MCP registration survives the trust rewrite that follows it', needsCodex, async () => {
  // § Ordering: step 2 runs `codex mcp add`, step 3 rewrites the same file. A rewrite that
  //   dropped what step 2 just wrote would leave the plugin with hooks and no tools.
  const home = makeHome({ 'config.toml': 'model = "gpt-5.6-sol"\n' });
  await runSetup(home);
  const toml = readToml(home);
  assert.match(toml, /\[mcp_servers\.mubit\]/);
  assert.match(toml, /^model = "gpt-5\.6-sol"$/m);
  assert.ok(stateKeys(toml).length >= 11, `only ${stateKeys(toml).length} hooks were trusted`);
});

test('a trust write that does not add up restores the file it found', needsCodex, async () => {
  // § setup counts the [hooks.state] tables it left behind and restores the original if the
  //   number is not the number of hooks it meant to trust. Feed it a config whose own content
  //   inflates that count: a table that is not ours and not removable.
  const foreign = [
    'model = "gpt-5.6-sol"',
    '',
    '[hooks.state."/opt/othertool/hooks.json:stop:0:0"]',
    'trusted_hash = "sha256:2222222222222222222222222222222222222222222222222222222222222222"',
    '',
  ].join('\n');
  const home = makeHome({ 'config.toml': foreign });
  const r = await runSetup(home);

  const after = readToml(home);
  if (r.code === 0) {
    // The intended outcome once the foreign entry is preserved: ours plus theirs, no duplicates.
    const keys = stateKeys(after);
    assert.equal(new Set(keys).size, keys.length, 'duplicate trust tables');
    assert.ok(keys.includes('/opt/othertool/hooks.json:stop:0:0'), 'the foreign entry was dropped');
  } else {
    // The refusal path: it must leave the file exactly as it found it.
    assert.equal(after, foreign,
      'setup refused to finish but did not restore config.toml, so it left the user with a file '
      + 'that is neither what they had nor what they asked for.');
  }
  assert.ok(existsSync(join(home, 'config.toml.before-mubit')), 'no config.toml backup was taken');
});

// ===========================================================================
// Refusals
// ===========================================================================

test('setup refuses a root that is not a plugin', async () => {
  const home = makeHome();
  const notAPlugin = mkdtempSync(join(tmpdir(), 'mubit-not-a-plugin-'));
  const r = await new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(CODEX_ROOT, 'scripts', 'setup.mjs'), notAPlugin], {
      env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => res({ code, stderr }));
    child.on('error', rej);
  });
  assert.equal(r.code, 2, 'a directory with no hooks.json is not a plugin root');
  assert.match(r.stderr, /usage:/);
  assert.ok(!existsSync(join(home, 'hooks.json')),
    'it wrote to the user`s $CODEX_HOME before deciding the input was invalid');
});
