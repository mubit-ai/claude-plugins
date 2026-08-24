// @ts-check
/**
 * `lib/boot.mjs` — the env-before-import shim, and the only file in this plugin that is not
 * either a manifest or two lines long.
 *
 * The shared modules capture their configuration at **module scope**: `lib/config.mjs`
 * resolves `CLAUDE_PROJECT_DIR` and `CLAUDE_PLUGIN_DATA` when `loadConfig` first runs, and
 * `lib/state.mjs` resolves the data directory the same way. So under Codex — which exports
 * none of those names (docs/harness-probe.md §4) — something has to put them there *before*
 * the shared module is imported, not after. Setting them afterwards is indistinguishable from
 * not setting them at all.
 *
 * That is the same ordering rule `mcp/src/launch.mjs` already lives by, and the same one
 * `test/launch.test.mjs` already guards on the Claude Code side. This file is its twin for
 * the hook entry points.
 *
 * Three names are synthesised, and each has a different source:
 *
 *   | name                 | from                    | why not the environment |
 *   | -------------------- | ----------------------- | ----------------------- |
 *   | `CLAUDE_PLUGIN_ROOT` | this module's own URL   | Codex sets no PLUGIN_ROOT of any spelling |
 *   | `CLAUDE_PLUGIN_DATA` | `~/.claude/plugins/data/mubit-memory` | deliberately the **same** directory Claude Code uses |
 *   | `CLAUDE_PROJECT_DIR` | `process.cwd()`         | Codex runs a hook in the project directory, and says so in `payload.cwd` |
 *
 * The data directory is the one that looks like a mistake and is not. A Codex session and a
 * Claude Code session in the same directory derive the same run id (codex-runid.test.mjs) and
 * share one data directory *on purpose*: that is what lets memory flow between the two
 * harnesses. Splitting them would give a user two disjoint memories of one project.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';

import {
  CODEX_ROOT, codexMod, lib, withEnv, makeDataDir, makeProjectDir, tempDir,
} from './helpers/codex-fixtures.mjs';

/** The three names the shared code reads, and nothing else is synthesised. */
const HOST_NAMES = ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR'];

/** A Codex hook process's environment: none of the four plugin variables is set. */
function codexEnv(over = {}) {
  return {
    CLAUDE_PLUGIN_ROOT: undefined,
    CLAUDE_PLUGIN_DATA: undefined,
    CLAUDE_PROJECT_DIR: undefined,
    PLUGIN_ROOT: undefined,
    PLUGIN_DATA: undefined,
    MUBIT_CC_DATA_DIR: undefined,
    MUBIT_CC_HOST: undefined,
    CODEX_HOME: '/tmp/codex-home-for-test',
    ...over,
  };
}

// ===========================================================================
// What the shim writes
// ===========================================================================

test('the shim fills all three host names when Codex has set none of them', async () => {
  await withEnv(codexEnv(), async () => {
    const { applyCodexEnv } = await codexMod('lib/boot.mjs');
    const env = {};
    applyCodexEnv(env, { cwd: '/tmp/some/project' });

    for (const name of HOST_NAMES) {
      // § One assertion per name so a failure says which rung the shared code will fall
      //   through on — and each fall-through has a different, silent consequence.
      assert.ok(env[name], `${name} is unset after the shim ran. `
        + 'lib/config.mjs and lib/state.mjs read these at module scope; unset means '
        + 'process.cwd() for the project and ~/.claude/plugins/data/mubit-memory by luck '
        + 'rather than by decision.');
    }
  });
});

test('CLAUDE_PLUGIN_ROOT is derived from the shim`s own location, not from the environment', async () => {
  await withEnv(codexEnv(), async () => {
    const { applyCodexEnv } = await codexMod('lib/boot.mjs');
    const env = {};
    applyCodexEnv(env, { cwd: '/tmp/some/project' });
    // § docs/harness-probe.md §4: PLUGIN_ROOT, CLAUDE_PLUGIN_ROOT, PLUGIN_DATA and
    //   CLAUDE_PLUGIN_DATA all arrive unset, and there is no ${...} substitution layer either.
    //   The module's own URL is the one thing that is always right — including inside the
    //   bundle, where it is the path Codex actually invoked.
    assert.equal(env.CLAUDE_PLUGIN_ROOT, CODEX_ROOT,
      'the plugin root must resolve to this plugin. lib/hook.mjs uses it to find `drain.mjs` '
      + 'for the detached spawn, and lib/redact.mjs uses it to recognise the plugin`s own '
      + 'paths as self-reference.');
  });
});

test('with no Claude Code install at all, the data directory is the bare default', async () => {
  const home = tempDir('codex-empty-home-');
  await withEnv(codexEnv({ HOME: home }), async () => {
    const { applyCodexEnv } = await codexMod('lib/boot.mjs');
    const env = { HOME: home };
    applyCodexEnv(env, { cwd: '/tmp/some/project' });
    // § A Codex-only machine is the ordinary case, and it wants a directory rather than an
    //   error. It does mean such a user ends up with a `~/.claude/` they never asked for,
    //   which README.md says out loud — the alternative is two disjoint memories of one
    //   project, which is the failure the shared run id exists to prevent.
    assert.equal(env.CLAUDE_PLUGIN_DATA,
      join(home, '.claude', 'plugins', 'data', 'mubit-memory'),
      'with nothing to find, the bare default is the answer.');
  });
});

test('the data directory is whichever suffixed one Claude Code actually uses', async () => {
  // § The bug this test exists for, measured on a real install. `lib/state.mjs` defaults to
  //   the bare `mubit-memory`, and that default is only ever reached when the host did not set
  //   CLAUDE_PLUGIN_DATA — which under Claude Code it always does, *with a suffix*: a
  //   marketplace install writes `mubit-memory-<marketplace>`, `--plugin-dir` writes
  //   `mubit-memory-inline`.
  //
  //   Assuming the bare name made a Codex session derive the same run id as the Claude Code
  //   session in the same directory — the sharing worked — and then write it into a different
  //   directory. Two memories of one project, one of them without the credentials, and nothing
  //   anywhere reporting it. Both directories held a run named the same thing.
  const home = tempDir('codex-cc-home-');
  const root = join(home, '.claude', 'plugins', 'data');
  mkdirSync(join(root, 'mubit-memory'), { recursive: true });          // the bare one
  mkdirSync(join(root, 'mubit-memory-inline'), { recursive: true });   // a --plugin-dir session
  mkdirSync(join(root, 'mubit-memory-mubit'), { recursive: true });    // the marketplace install
  writeFileSync(join(root, 'mubit-memory-mubit', 'credentials.json'), '{"apiKey":"mbt_x"}');

  await withEnv(codexEnv({ HOME: home }), async () => {
    const { applyCodexEnv, claudeCodeDataDir } = await codexMod('lib/boot.mjs');
    assert.equal(claudeCodeDataDir({ HOME: home }), join(root, 'mubit-memory-mubit'),
      'the directory holding credentials.json is the install the user authenticated, and the '
      + 'only one whose key and memory a Codex session can actually use. Picking the bare name '
      + 'costs the credentials AND every memory the other harness holds.');
    const env = { HOME: home };
    applyCodexEnv(env, { cwd: '/tmp/some/project' });
    assert.equal(env.CLAUDE_PLUGIN_DATA, join(root, 'mubit-memory-mubit'));
  });
});

test('with no credentials anywhere, the most recently used directory wins', async () => {
  const home = tempDir('codex-recency-home-');
  const root = join(home, '.claude', 'plugins', 'data');
  mkdirSync(join(root, 'mubit-memory'), { recursive: true });
  mkdirSync(join(root, 'mubit-memory-mubit', 'runs'), { recursive: true });
  // Make the suffixed one unambiguously newer.
  const future = new Date(Date.now() + 60_000);
  utimesSync(join(root, 'mubit-memory-mubit', 'runs'), future, future);

  await withEnv(codexEnv({ HOME: home }), async () => {
    const { claudeCodeDataDir } = await codexMod('lib/boot.mjs');
    // § Recency is a weaker signal than credentials, and it is the right one before anybody
    //   has authenticated: every hook touches its data directory, so "most recently written"
    //   is a good proxy for "in use".
    assert.equal(claudeCodeDataDir({ HOME: home }), join(root, 'mubit-memory-mubit'),
      'with no credentials to go on, the directory in active use is the better guess than the '
      + 'bare name — which on this machine is the empty one Codex itself just created.');
  });
});

test('the resolution is deterministic across two hooks of one session', async () => {
  const home = tempDir('codex-stable-home-');
  const root = join(home, '.claude', 'plugins', 'data');
  // Two directories, identical timestamps, neither with credentials: the tie-break has to be
  // total, or two hooks in the same session answer differently and the run splits mid-turn.
  for (const n of ['mubit-memory-alpha', 'mubit-memory-beta']) mkdirSync(join(root, n), { recursive: true });
  const t = new Date(Date.now() - 5_000);
  for (const n of ['mubit-memory-alpha', 'mubit-memory-beta']) utimesSync(join(root, n), t, t);

  await withEnv(codexEnv({ HOME: home }), async () => {
    const { claudeCodeDataDir } = await codexMod('lib/boot.mjs');
    const first = claudeCodeDataDir({ HOME: home });
    for (let i = 0; i < 5; i++) {
      assert.equal(claudeCodeDataDir({ HOME: home }), first,
        'the answer moved between calls. A hook that resolves a different data directory than '
        + 'the one before it splits a single session across two stores, and the turn staged by '
        + 'stage-prompt is not the one capture --stop goes looking for.');
    }
  });
});

test('the project directory comes from the payload cwd when there is one', async () => {
  await withEnv(codexEnv(), async () => {
    const { applyCodexEnv } = await codexMod('lib/boot.mjs');
    const env = {};
    applyCodexEnv(env, { cwd: '/tmp/payload/dir' });
    // § Every Codex payload carries `cwd`, and lib/runid.mjs already prefers it over the
    //   environment for exactly the reason it prefers it under Claude Code: a session that
    //   moved would otherwise keep writing the first directory's run.
    assert.equal(env.CLAUDE_PROJECT_DIR, '/tmp/payload/dir');
  });
});

test('with no payload cwd it falls back to the process cwd, which is where Codex runs a hook', async () => {
  await withEnv(codexEnv(), async () => {
    const { applyCodexEnv } = await codexMod('lib/boot.mjs');
    const env = {};
    applyCodexEnv(env, {});
    // § docs/harness-probe.md §4, recorded: the hook process's cwd is the project directory.
    //   The shim runs before stdin is read, so on the real path this is the only answer
    //   available — the cwd-carrying overload exists for the modules that re-derive later.
    assert.equal(env.CLAUDE_PROJECT_DIR, process.cwd());
  });
});

// ===========================================================================
// What the shim does NOT overwrite
// ===========================================================================

for (const name of HOST_NAMES) {
  test(`${name} already set is left alone`, async () => {
    await withEnv(codexEnv({ [name]: '/tmp/deliberate' }), async () => {
      const { applyCodexEnv } = await codexMod('lib/boot.mjs');
      const env = { [name]: '/tmp/deliberate' };
      applyCodexEnv(env, { cwd: '/tmp/some/project' });
      // § A value already in the environment was put there by somebody — a test harness, a CI
      //   job, a user pinning MUBIT_CC_DATA_DIR's twin. Overwriting it would make this plugin
      //   the one component whose configuration cannot be overridden from outside.
      assert.equal(env[name], '/tmp/deliberate',
        `the shim overwrote an explicitly set ${name}. Synthesising a value is a fallback, `
        + 'not a policy.');
    });
  });
}

test('MUBIT_CC_DATA_DIR still outranks everything, exactly as it does under Claude Code', async () => {
  const pinned = makeDataDir();
  await withEnv(codexEnv({ MUBIT_CC_DATA_DIR: pinned }), async () => {
    const { applyCodexEnv } = await codexMod('lib/boot.mjs');
    const env = { MUBIT_CC_DATA_DIR: pinned };
    applyCodexEnv(env, { cwd: '/tmp/some/project' });
    const { dataDir } = await lib('state.mjs');
    // § lib/state.mjs resolves MUBIT_CC_DATA_DIR -> CLAUDE_PLUGIN_DATA -> the default. The
    //   shim writes the second rung, so it must not be able to defeat the first — that is the
    //   variable every runbook in docs/ tells a user to pin.
    assert.equal(dataDir({}, env), pinned,
      'MUBIT_CC_DATA_DIR is the highest-precedence data-dir input on both hosts. The shim '
      + 'must not have climbed above it.');
  });
});

// ===========================================================================
// The host marker
// ===========================================================================

test('the shim declares the host rather than sniffing for it', async () => {
  await withEnv(codexEnv(), async () => {
    const { applyCodexEnv, HOST } = await codexMod('lib/boot.mjs');
    const env = {};
    applyCodexEnv(env, {});
    assert.equal(HOST, 'codex');
    // § Detection is the wrong mechanism here and the probe shows why: a Codex session
    //   launched from a Claude Code session inherits CLAUDECODE=1 and a dozen CLAUDE_CODE_*
    //   variables, and a Codex-only shell has none of them. Sniffing gets both cases wrong in
    //   the direction that is hardest to notice. Declaring is unambiguous: if this bundle is
    //   running, the host is Codex, because this bundle exists nowhere else.
    assert.equal(env.MUBIT_CC_HOST, 'codex',
      'the shared config keys the statusLine default off this marker. Sniffing for CLAUDECODE '
      + 'would misread a Codex session started from a Claude Code terminal.');
  });
});

test('under the Codex host, statusLine defaults off', async () => {
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  const { loadConfig } = await lib('config.mjs');

  const shared = {
    CLAUDE_PLUGIN_DATA: dataDir, MUBIT_CC_DATA_DIR: dataDir, CLAUDE_PROJECT_DIR: projectDir,
    MUBIT_ENDPOINT: 'https://mubit.example.com', HOME: dataDir,
  };
  const underCodex = loadConfig({ ...shared, MUBIT_CC_HOST: 'codex' });
  // § Codex's status line is a declarative list of built-in item ids — there is nothing
  //   scriptable to render into. Leaving the default `true` would have the plugin computing a
  //   status nobody can see, on a host where it also has no hook to render it from.
  assert.equal(underCodex.statusLine, false,
    'statusLine must default false under Codex. It is not a feature that degrades there; it '
    + 'is a surface the host does not have.');
});

test('an explicit statusLine still wins under Codex, and the Claude Code default is untouched', async () => {
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  const { loadConfig } = await lib('config.mjs');
  const shared = {
    CLAUDE_PLUGIN_DATA: dataDir, MUBIT_CC_DATA_DIR: dataDir, CLAUDE_PROJECT_DIR: projectDir,
    MUBIT_ENDPOINT: 'https://mubit.example.com', HOME: dataDir,
  };

  // § The host picks the *default*, and nothing else. Every rung above it — MUBIT_CC_STATUSLINE,
  //   credentials.json, .mubit-cc.json — has to keep working, or this stops being a default and
  //   becomes a hard-coded answer.
  assert.equal(loadConfig({ ...shared, MUBIT_CC_HOST: 'codex', MUBIT_CC_STATUSLINE: '1' }).statusLine, true,
    'MUBIT_CC_STATUSLINE=1 must still turn it on: a user driving Codex through some other '
    + 'front end may well have somewhere to put it.');

  // § And the regression this whole change has to not be: no marker means Claude Code, and
  //   Claude Code's default is unchanged. The 1067-test suite next door is the real net for
  //   this; the assertion is here because this is the file that introduced the branch.
  assert.equal(loadConfig({ ...shared, MUBIT_CC_HOST: undefined }).statusLine, true,
    'with no host marker the default must stay `true` — that is the Claude Code behaviour, '
    + 'and this change was supposed to be additive.');
});

// ===========================================================================
// Ordering — the property the whole file is named after
// ===========================================================================

test('every hook entry point imports the shim before it imports anything shared', async () => {
  const { readFileSync, readdirSync, existsSync } = await import('node:fs');
  const dir = join(CODEX_ROOT, 'hooks', 'src');
  assert.ok(existsSync(dir), `${dir} does not exist yet — the entry points are the port.`);
  const entries = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  assert.ok(entries.length >= 10, `expected the shared hook set under ${dir}, found ${entries.length}.`);

  for (const file of entries) {
    const src = readFileSync(join(dir, file), 'utf8');
    const bootAt = src.indexOf('boot.mjs');
    const sharedAt = src.indexOf('claude-code/hooks/src/');
    // § This is the whole contract in two indices. The shared module resolves its config at
    //   module scope, so an import that lands first wins — and a reordering here fails
    //   *silently*: the hook still runs, still exits 0, and writes its state into whatever
    //   directory the unset defaults happened to name.
    assert.ok(bootAt >= 0, `hooks/src/${file} does not import lib/boot.mjs at all.`);
    assert.ok(sharedAt >= 0, `hooks/src/${file} does not import a shared hook body.`);
    assert.ok(bootAt < sharedAt,
      `hooks/src/${file} imports the shared body before the shim. The shared modules capture `
      + 'CLAUDE_PROJECT_DIR and CLAUDE_PLUGIN_DATA at module scope, so this ordering is a '
      + 'correctness property, not a style: reversed, the hook silently uses the wrong '
      + 'project directory and the wrong data directory.');
  }
});

test('the shared body is loaded by dynamic import, so the shim is not merely hoisted past', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = join(CODEX_ROOT, 'hooks', 'src');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
    const src = readFileSync(join(dir, file), 'utf8');
    // § ESM hoists every static `import` above all statements, so two static imports in
    //   "the right order" are still evaluated in graph order — which for a shared body that
    //   imports lib/config.mjs is not the order this needs. `await import()` is the one form
    //   that runs after the statements above it, which is exactly why mcp/src/launch.mjs uses
    //   it for `./server.js` and why test/launch.test.mjs guards the same shape there.
    assert.match(src, /await import\(/,
      `hooks/src/${file} must load the shared body with \`await import(...)\`. A second static `
      + 'import would be hoisted and evaluated before the shim`s side effects ran, which is '
      + 'the failure this shim exists to prevent.');
  }
});
