// @ts-check
/**
 * Codex manifest lint, as executable tests.
 *
 * These are data assertions over files. Nothing here starts a process or opens a socket, so
 * this is the cheapest early warning for the breakage that only shows up at install time: a
 * hook pointing at a bundle the build no longer produces, a version that drifted from the
 * Claude Code plugin, an event name Codex has never heard of.
 *
 * Four Codex facts, all recorded against a live host, decide what is asserted here:
 *
 *   1. **Eleven events, not thirteen.** No `CwdChanged`, no `PostToolUseFailure`, no
 *      `StopFailure`. Registering one is not an error Codex reports — it parses the file and
 *      the handler never fires, which reads exactly like a plugin that was never installed.
 *   2. **No `if:` predicate.** Claude Code's `PreToolUse` registrations carry
 *      `if: "Bash(rm *)"`. Codex's `HookHandlerConfig` has no such field, so a registration
 *      that keeps one is a registration that fires on **every** matching tool call.
 *   3. **Shell strings, not exec form.** A handler's `command` is one string run through
 *      `$SHELL -lc`, and no `${PLUGIN_ROOT}` reaches it. The path has to be absolute, which
 *      is why `hooks.json` here is a *template* the setup skill rewrites rather than
 *      something Codex reads in place.
 *   4. **`timeout`, in seconds, and SessionEnd is clamped to 3.** Writing 8 there is not an
 *      error either; Codex silently clamps it and says so on a stderr nobody reads.
 *
 * Every missing file fails with the path and what defines it. Nothing is skipped — a skipped
 * manifest check is indistinguishable from a passing one on a CI dashboard.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { CODEX_ROOT, SHARED_ROOT, REPO_ROOT, CODEX_EVENTS } from './helpers/codex-fixtures.mjs';

const P = {
  plugin: join(CODEX_ROOT, '.codex-plugin', 'plugin.json'),
  hooks: join(CODEX_ROOT, 'hooks.json'),
  mcp: join(CODEX_ROOT, '.mcp.json'),
  pkg: join(CODEX_ROOT, 'package.json'),
  gitignore: join(CODEX_ROOT, '.gitignore'),
  skills: join(CODEX_ROOT, 'skills'),
  marketplace: join(REPO_ROOT, '.agents', 'plugins', 'marketplace.json'),
  ccMarketplace: join(REPO_ROOT, '.claude-plugin', 'marketplace.json'),
  ccPkg: join(SHARED_ROOT, 'package.json'),
  ccPlugin: join(SHARED_ROOT, '.claude-plugin', 'plugin.json'),
};

/**
 * §2 — the skills, the same set the Claude Code plugin ships, in the order they arrived.
 *
 * One name per line on purpose: four branches append to this list at once, and a single-line
 * array makes every one of those a conflict on the same line.
 */
const SKILLS = [
  'recall',
  'remember',
  'reflect',
  'forget',
  'doctor',
  'setup',
  'auth',
  'dashboard',
  'strategies',
  'checkpoint',
  'memory-health',
  'activity',
  'pin',
];

/** `.mcp.json` names the server `mubit`, so the model sees `mcp__mubit__<tool>`. */
const MCP_SERVER = 'mubit';

function readOrFail(p, why) {
  if (!existsSync(p)) assert.fail(`${p} does not exist yet.\n  ${why}`);
  return readFileSync(p, 'utf8');
}

function readJsonOrFail(p, why) {
  const raw = readOrFail(p, why);
  try { return JSON.parse(raw); } catch (err) {
    return assert.fail(`${p} is not parseable JSON — Codex would skip the whole file: ${err.message}`);
  }
}

/** Every handler in `hooks.json`, flattened, with its event and its position. */
function handlers() {
  const doc = readJsonOrFail(P.hooks, 'the eleven Codex registrations; see the header.');
  /** @type {Array<{event: string, group: number, index: number, handler: any}>} */
  const out = [];
  for (const [event, groups] of Object.entries(doc.hooks ?? {})) {
    (groups ?? []).forEach((g, gi) => {
      (g.hooks ?? []).forEach((handler, hi) => out.push({ event, group: gi, index: hi, handler }));
    });
  }
  return { doc, all: out };
}

// ===========================================================================
// plugin.json
// ===========================================================================

test('.codex-plugin/plugin.json is the manifest Codex reads, and it parses', () => {
  const m = readJsonOrFail(P.plugin,
    'Codex looks for `.codex-plugin/plugin.json` first and falls back to `.claude-plugin/`. '
    + 'Shipping the Codex spelling is what stops this plugin being read as a Claude Code one.');

  // § The manifest fields Codex's own validator requires — name, version, description,
  //   author.name — plus the two that decide what loads.
  assert.equal(m.name, 'mubit-memory',
    'the plugin name is the component namespace: skills are listed to the model as '
    + '`<plugin>:<skill>`, so renaming it renames every skill the user types.');
  assert.match(String(m.version), /^\d+\.\d+\.\d+$/,
    'Codex validates `version` as strict semver and rejects the manifest otherwise.');
  assert.ok(String(m.description ?? '').trim(), 'a manifest with no description installs as an unlabelled row.');
  assert.ok(String(m.author?.name ?? '').trim(), 'Codex requires `author.name`.');

});

test('plugin.json carries no `mcpServers` key either, for the same reason as `hooks`', () => {
  const m = readJsonOrFail(P.plugin, 'see above.');
  // § Probed live. Codex starts a plugin-declared MCP server, but it resolves **nothing** in
  //   the entry: `${CLAUDE_PLUGIN_ROOT}/server.mjs`, `./server.mjs` and `server.mjs` all
  //   failed with "handshaking with MCP server failed: connection closed: initialize
  //   response" — node exited immediately on a path that was not there. A relative path is
  //   resolved against the *project* directory, and there is no substitution layer at all.
  //
  //   Only an absolute path works, and a plugin cannot know its own install path at publish
  //   time: a marketplace install copies the directory into
  //   `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/`.
  //
  //   So `.mcp.json` ships as a template too, and `/mubit-memory:setup` registers the server
  //   in the user layer (`codex mcp add mubit -- node <abs>/mcp/dist/index.js`) with the path
  //   resolved. Declaring it here would have Codex try and fail to start it on every single
  //   session, logging a warning nobody reads.
  assert.equal(m.mcpServers, undefined,
    'a plugin-declared MCP server cannot resolve its own path under Codex, so declaring one '
    + 'means a server that fails to start every session. /mubit-memory:setup registers it in '
    + 'the user layer instead, where the path can be absolute.');
});

test('plugin.json carries no `hooks` key', () => {
  const m = readJsonOrFail(P.plugin, 'see above.');
  // § Observed against a live host: a plugin-bundled `hooks.json` is inert under Codex 0.146.0 —
  //   copied into the install cache and never read. `hooks/list` reports `source: "user"` and
  //   `pluginId: null` for every hook it does see. Pointing the manifest at ours would say the
  //   opposite of what actually happens, and the bundled plugin-creator reference says
  //   validation rejects the field outright.
  assert.equal(m.hooks, undefined,
    'plugin-bundled hooks do not run under Codex (observed against a live host). `hooks.json` '
    + 'ships as a template that /mubit-memory:setup merges into $CODEX_HOME/hooks.json; '
    + 'naming it here would claim an install path that silently does nothing.');
});

test('plugin.json declares no userConfig', () => {
  const m = readJsonOrFail(P.plugin, 'see above.');
  // § Codex has no plugin option mechanism at all: the strings `PLUGIN_OPTION` and
  //   `userConfig` appear nowhere in the 0.146.0 binary. A `userConfig` block here would
  //   promise a settings UI that does not exist, and the values would never be exported.
  //   Configuration under Codex is MUBIT_* env -> credentials.json -> .mubit-cc.json.
  assert.equal(m.userConfig, undefined,
    'Codex exports no CODEX_PLUGIN_OPTION_* variables, so a userConfig block would be a '
    + 'promise nothing keeps. README.md documents the three rungs that do work.');
});

// ===========================================================================
// hooks.json — the eleven
// ===========================================================================

test('hooks.json registers exactly the eleven events Codex dispatches', () => {
  const { doc } = handlers();
  const got = Object.keys(doc.hooks ?? {}).sort();
  // § Recorded against a live host: Codex dispatches eleven event names. An event outside
  //   that set parses fine and never fires.
  assert.deepEqual(got, [...CODEX_EVENTS].sort(),
    'a registration Codex does not dispatch is silently dead, and a Codex event left '
    + 'unregistered is memory the plugin never sees. Both look identical from outside.');
});

test('hooks.json registers none of the three Claude-Code-only events', () => {
  const { doc } = handlers();
  for (const dead of ['CwdChanged', 'PostToolUseFailure', 'StopFailure']) {
    // § One assertion per event so the failure names which one came back.
    assert.equal(doc.hooks?.[dead], undefined,
      `${dead} does not exist under Codex. Registering it costs nothing at parse time and `
      + 'buys a handler that never runs — the most expensive kind of dead code, because it '
      + 'looks like coverage.');
  }
});

test('hooks.json has only the two top-level fields Codex accepts', () => {
  const doc = readJsonOrFail(P.hooks, 'see the header.');
  // § Observed against a live host: writing anything else is a hard parse error that takes the
  //   whole file down — "unknown field `state`, expected `description` or `hooks`" — and with
  //   it every registration, not just the offending one.
  const extra = Object.keys(doc).filter((k) => k !== 'hooks' && k !== 'description');
  assert.deepEqual(extra, [],
    'Codex accepts exactly `description` and `hooks` at the top level of a hooks config. '
    + 'One unknown key and none of the eleven hooks load.');
});

test('no handler carries an `if:` predicate', () => {
  const { all } = handlers();
  for (const { event, handler } of all) {
    // § Claude Code gates the two PreToolUse warnings behind `if: "Bash(rm *)"`. Codex's
    //   HookHandlerConfig has no `if`, so a copied registration fires on every Bash call —
    //   turning an opt-in warning into an unasked-for interruption on every shell command.
    assert.equal(handler.if, undefined,
      `${event} handler carries an \`if:\` predicate. Codex ignores it, so the handler runs `
      + 'on every matching call. Narrow with `matcher`, or decide inside the hook.');
  }
});

test('every handler is a `command` type with a shell string', () => {
  const { all } = handlers();
  for (const { event, handler } of all) {
    // § Codex's HookHandlerConfig also allows `prompt`, `agent` and `mcp_tool` handlers.
    //   This plugin uses none of them: each costs a model call per event.
    assert.equal(handler.type, 'command',
      `${event}: only \`command\` handlers are free. A \`prompt\` or \`agent\` handler would `
      + 'spend a model call on every tool call.');
    assert.equal(typeof handler.command, 'string',
      `${event}: Codex runs \`command\` as one shell string through $SHELL -lc. Claude Code's `
      + 'exec form ({command:"node", args:[…]}) is not accepted here.');
    assert.equal(handler.args, undefined,
      `${event}: \`args\` is the Claude Code exec form and is ignored by Codex — the arguments `
      + 'would vanish and the hook would run in its default mode.');
  }
});

test('every handler command is a template naming an absolute-path placeholder', () => {
  const { all } = handlers();
  for (const { event, handler } of all) {
    // § Observed against a live host: none of PLUGIN_ROOT / CLAUDE_PLUGIN_ROOT / PLUGIN_DATA /
    //   CLAUDE_PLUGIN_DATA is exported to a Codex hook, and there is no `${...}` substitution
    //   layer — `$PLUGIN_ROOT` in a command is expanded by the shell, to the empty string.
    //   So the shipped file is a template whose placeholder /mubit-memory:setup replaces with
    //   this plugin's real install path before writing $CODEX_HOME/hooks.json.
    assert.match(handler.command, /\{\{PLUGIN_ROOT\}\}/,
      `${event}: the command must carry the {{PLUGIN_ROOT}} placeholder. $PLUGIN_ROOT would `
      + 'expand to the empty string in the login shell Codex runs this in, leaving `node '
      + '"/hooks/dist/x.mjs"` — a path that does not exist, failing silently.');
    assert.doesNotMatch(handler.command, /\$\{?(CLAUDE_)?PLUGIN_(ROOT|DATA)\}?/,
      `${event}: a bare $PLUGIN_ROOT-style variable reaches the hook unset. Codex populates `
      + 'those names only for plugin-sourced hooks, and plugin-sourced hooks never load.');
  }
});

test('every handler names a bundle that exists', () => {
  const { all } = handlers();
  for (const { event, handler } of all) {
    const m = /\{\{PLUGIN_ROOT\}\}\/(\S+?\.mjs)/.exec(handler.command);
    assert.ok(m, `${event}: cannot find a .mjs path in ${JSON.stringify(handler.command)}`);
    const rel = m[1];
    // § A registration pointing at a bundle the build no longer produces installs cleanly and
    //   does nothing. This is the check that would have caught it.
    assert.ok(existsSync(join(CODEX_ROOT, rel)),
      `${event} points at ${rel}, which is not committed. hooks/dist is a tracked artifact: `
      + 'a Codex install is a file copy, not a build, so whatever is committed is what runs. '
      + 'Run `MUBIT_CC_BUILD_SKIP_SERVER=1 npm run build`.');
  }
});

test('every timeout is an integer number of seconds, and SessionEnd asks for at most 3', () => {
  const { all } = handlers();
  for (const { event, handler } of all) {
    assert.equal(typeof handler.timeout, 'number',
      `${event}: the hooks.json field is \`timeout\`, in seconds. \`timeoutSec\` is the `
      + 'app-server protocol spelling and is not read from this file.');
    assert.ok(Number.isInteger(handler.timeout) && handler.timeout > 0,
      `${event}: timeout must be a positive whole number of seconds, got ${handler.timeout}.`);
    if (event === 'SessionEnd') {
      // § Recorded verbatim from a live host: "clamping SessionEnd hook timeout to 3s".
      //   Asking for 8 as Claude Code does is not an error — Codex clamps it and warns on a
      //   stderr nobody reads. Writing 3 here is the honest number, and it is why
      //   sessionEndDetach stops being optional under this host.
      assert.ok(handler.timeout <= 3,
        'Codex clamps SessionEnd to 3 seconds whatever this says. A larger number here is a '
        + 'budget the hook will never get, and the end-of-session reflect would be cut off '
        + 'mid-call. The detached hand-off is what makes 3s survivable.');
    }
  }
});

test('every event has at least one handler', () => {
  const { doc } = handlers();
  for (const event of CODEX_EVENTS) {
    const groups = doc.hooks?.[event] ?? [];
    const count = groups.reduce((n, g) => n + (g.hooks?.length ?? 0), 0);
    // § Full parity across every Codex event is the stated scope. An event registered with an
    //   empty handler list is the same as not registering it, and harder to notice.
    assert.ok(count >= 1, `${event} is registered with no handlers — that is not parity, it is a gap.`);
  }
});

// ===========================================================================
// .mcp.json
// ===========================================================================

test('.mcp.json names the server `mubit`, so tools are mcp__mubit__*', () => {
  const m = readJsonOrFail(P.mcp,
    'the MCP server template /mubit-memory:setup registers from. Codex never reads this file '
    + 'itself — see the plugin.json test above — but it is the single place the server name '
    + 'and entry point are written down, and what setup copies into the user layer.');
  const names = Object.keys(m.mcpServers ?? {});
  // § Observed against a live host: a live PreToolUse payload showed `mcp__probe__probe_ping` for
  //   a server named `probe`. The prefix is mcp__<server>__<tool>, full stop — and it is the
  //   same whether the server is declared by a plugin or added to the user layer, which was
  //   probed separately because the whole install story turns on it. So the server name here
  //   is what every skill's prose has to match.
  assert.deepEqual(names, [MCP_SERVER],
    `the server name is the tool prefix the model sees. Renaming it to "x" makes every tool `
    + '`mcp__x__…` and silently invalidates every reference in every skill.');
});

test('.mcp.json points at the committed bundle', () => {
  const m = readJsonOrFail(P.mcp, 'see above.');
  const server = m.mcpServers[MCP_SERVER];
  assert.equal(server.command, 'node', 'a bundled .mjs run by node is a ~30ms cold start; npx is ~500ms.');
  const arg = String(server.args?.[0] ?? '');
  assert.match(arg, /\{\{PLUGIN_ROOT\}\}|mcp\/dist\/index\.js/,
    'the entry point must resolve to mcp/dist/index.js.');
  assert.ok(existsSync(join(CODEX_ROOT, 'mcp', 'dist', 'index.js')),
    'mcp/dist/index.js is not committed. There is no install-time build: what is committed is what runs.');
  assert.ok(existsSync(join(CODEX_ROOT, 'mcp', 'dist', 'server.js')),
    'mcp/dist/server.js is not committed. Two independently installable plugins cannot share '
    + 'a path, so this plugin carries its own copy of the vendored server bundle.');
});

// ===========================================================================
// The marketplace
// ===========================================================================

test('the Codex marketplace lists this plugin from its own path', () => {
  const m = readJsonOrFail(P.marketplace,
    '.agents/plugins/marketplace.json is the repo-local marketplace Codex discovers. It sits '
    + 'beside .claude-plugin/marketplace.json; the two hosts read different files.');
  const entry = (m.plugins ?? []).find((p) => p.name === 'mubit-memory');
  assert.ok(entry, 'no `mubit-memory` entry — `codex plugin add mubit-memory@…` has nothing to install.');
  assert.equal(entry.source?.source, 'local', 'a repo-local marketplace uses the `local` source kind.');
  assert.equal(entry.source?.path, './integrations/codex',
    'the source path must be the Codex plugin, not the Claude Code one. Pointing it at '
    + '`./integrations/claude-code` installs a plugin whose hooks Codex cannot run.');
  // § Codex's marketplace validator wants both of these on every entry.
  assert.ok(entry.policy?.installation, 'every entry needs policy.installation.');
  assert.ok(entry.policy?.authentication, 'every entry needs policy.authentication.');
  assert.ok(entry.category, 'every entry needs a category.');
});

test('the Claude Code marketplace still points only at the Claude Code plugin', () => {
  const m = readJsonOrFail(P.ccMarketplace, 'the existing marketplace, which must not have moved.');
  const entry = (m.plugins ?? []).find((p) => p.name === 'mubit-memory');
  // § The two marketplaces name the same plugin id from two different directories. Getting
  //   this backwards installs the wrong tree into the wrong host, and both hosts start with a
  //   manifest they can parse and hooks they cannot run.
  assert.equal(entry?.source, './integrations/claude-code',
    'adding the Codex tree must not have repointed the Claude Code marketplace.');
});

// ===========================================================================
// Version lockstep
// ===========================================================================

test('every version moves together: package, plugin manifest, marketplace, and the CC plugin', () => {
  const pkg = readJsonOrFail(P.pkg, 'the Codex plugin package manifest.');
  const plugin = readJsonOrFail(P.plugin, 'see above.');
  const mkt = readJsonOrFail(P.marketplace, 'see above.');
  const ccPkg = readJsonOrFail(P.ccPkg, 'the Claude Code plugin package manifest.');
  const ccPlugin = readJsonOrFail(P.ccPlugin, 'the Claude Code plugin manifest.');

  // The Codex marketplace entry carries no version of its own, and should not: Codex reads
  // the version out of the plugin's own manifest at install time — `codex plugin add` echoes
  // it back — so a second copy here would be a number nothing validates against the first.
  // The Claude Code marketplace does carry one, and `manifests.test.mjs` next door holds it
  // in lockstep; this test covers the four that exist.
  const entry = (mkt.plugins ?? []).find((p) => p.name === 'mubit-memory');
  assert.equal(entry?.version, undefined,
    'the Codex marketplace entry must not restate the version — Codex reads it from '
    + '.codex-plugin/plugin.json, and a second copy is a second thing to forget to bump.');
  const versions = {
    'codex/package.json': pkg.version,
    'codex/.codex-plugin/plugin.json': plugin.version,
    'claude-code/package.json': ccPkg.version,
    'claude-code/.claude-plugin/plugin.json': ccPlugin.version,
  };
  const distinct = [...new Set(Object.values(versions))];
  // § The two plugins share every line of lib/, hooks/src/ and mcp/src/. A user who installs
  //   0.10.0 under Codex and 0.9.2 under Claude Code has one data directory written by two
  //   different builds of the same state machine, and no way to know it.
  assert.equal(distinct.length, 1,
    'the two plugins are built from one source tree and share one data directory, so their '
    + `versions cannot drift: ${JSON.stringify(versions, null, 2)}`);
});

// ===========================================================================
// Absences
// ===========================================================================

test('nothing in the Codex plugin mentions a status line', () => {
  const { doc } = handlers();
  const plugin = readJsonOrFail(P.plugin, 'see above.');
  const blob = `${JSON.stringify(doc)}\n${JSON.stringify(plugin)}`;
  // § Codex's status line is a declarative list of built-in item ids. There is no command
  //   hook and nothing scriptable, so a status-line registration is not merely ignored — it
  //   is a promise of a surface the host does not have. `lib/config.mjs` defaults
  //   `statusLine` to false under this host for the same reason; see codex-boot.test.mjs.
  assert.doesNotMatch(blob, /statusLine|statusline/i,
    'Codex has no scriptable status line. Rendering one costs a process per UI frame and '
    + 'shows nobody anything.');
  assert.ok(!existsSync(join(CODEX_ROOT, 'bin', 'statusline.mjs')),
    'bin/statusline.mjs must not ship here — it is dead weight in a marketplace bundle.');
});

test('no agents/ directory ships, because Codex has no plugin-defined subagent types', () => {
  // § Probed live: asked to list the sub-agent types it can spawn, Codex answered "No fixed
  //   sub-agent types" with an `agents/*.md` present in the installed plugin, and every
  //   SubagentStart payload carried `agent_type: "default"`. A markdown subagent here would
  //   be a file nothing reads. The `recall` skill covers the same ground — a model that wants
  //   isolated deep search spawns a generic agent and points it at that skill.
  assert.ok(!existsSync(join(CODEX_ROOT, 'agents')),
    'Codex discovers plugin skills (namespaced <plugin>:<skill>) but not plugin subagents. '
    + 'Shipping agents/mubit-recall.md would look like parity and provide none.');
});

// ===========================================================================
// Skills as files
// ===========================================================================

test('every skill is present, one directory each', () => {
  const dirs = existsSync(P.skills)
    ? readdirSync(P.skills, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    : [];
  assert.deepEqual(dirs, [...SKILLS].sort(),
    'the Codex plugin ships the same skills as the Claude Code one. A missing skill is '
    + 'a slash command that silently does not exist.');
  for (const s of SKILLS) {
    assert.ok(existsSync(join(P.skills, s, 'SKILL.md')),
      `skills/${s}/SKILL.md is missing — Codex lists a skill by its SKILL.md and nothing else.`);
  }
});

test('the setup script exists, and the setup skill points at it', () => {
  const script = join(CODEX_ROOT, 'scripts', 'setup.mjs');
  // § Codex needs an install step that no other host does — the registrations and the MCP
  //   server both have to be written into the user layer with an absolute path — and the
  //   fiddliest part of it, reading each hook's trust hash back out of the app server, is not
  //   something to ask a model to improvise per install.
  assert.ok(existsSync(script),
    'scripts/setup.mjs is missing. Without it /mubit-memory:setup has to hand-roll a JSON-RPC '
    + 'handshake against `codex app-server` on every install.');
  const skill = readOrFail(join(P.skills, 'setup', 'SKILL.md'), 'the setup skill.');
  assert.match(skill, /scripts\/setup\.mjs/,
    'the setup skill must name the script, or the two drift into different install procedures.');
  assert.match(skill, /--no-trust/,
    'the skill must document the escape hatch for a user who would rather approve the hooks '
    + 'themselves in /hooks. Trust is their decision.');
});

test('the setup script does not reserialise the user`s config.toml', () => {
  const src = readOrFail(join(CODEX_ROOT, 'scripts', 'setup.mjs'), 'the setup script.');
  // § Almost everything this script does is now asserted by *running* it, in
  //   `codex-setup.test.mjs`: the merge, the pin, the trust rewrite, idempotency over three
  //   runs, restore-on-mismatch. What used to stand here were five `assert.match(src, /…/)`
  //   greps over 212 lines, which prove the file contains a string — not that running it does
  //   anything in particular, and not that it leaves another tool's config intact.
  //
  //   This is the one constraint left that is about the *approach* rather than the outcome,
  //   so it stays a source assertion: config.toml is the user's, carrying their project trust
  //   levels, their model choice and their notify hook, and round-tripping it through a parser
  //   and a serialiser to rewrite eleven tables would reformat every setting they own.
  assert.ok(!/TOML\.parse|parseToml|@iarna|smol-toml/i.test(src),
    'the [hooks.state] strip must stay line-based.');
  assert.deepEqual(
    JSON.parse(readOrFail(join(CODEX_ROOT, 'package.json'), 'the package manifest.')).dependencies, {},
    'and the plugin stays dependency-free, which is the other half of the same promise.');
});

test('the published package carries the install procedure it documents', () => {
  const pkg = JSON.parse(readOrFail(join(CODEX_ROOT, 'package.json'), 'the package manifest.'));
  // § The setup skill's central instruction is `node <root>/scripts/setup.mjs`, and that file
  //   imports `../lib/boot.mjs`. An `npm publish` with neither in `files` ships a plugin whose
  //   only install procedure is absent — and it fails on someone else's machine, with a
  //   MODULE_NOT_FOUND naming a path that was never in the tarball.
  for (const dir of ['scripts', 'lib']) {
    assert.ok(pkg.files.includes(dir),
      `package.json "files" omits ${dir}/, which the setup skill cannot work without.`);
  }
  assert.ok(existsSync(join(CODEX_ROOT, 'scripts', 'setup.mjs')));
  assert.ok(existsSync(join(CODEX_ROOT, 'lib', 'boot.mjs')));
});

test('the setup skill`s by-hand fallback pins the data directory too', () => {
  const skill = readOrFail(join(P.skills, 'setup', 'SKILL.md'), 'the setup skill.');
  // § The skill offers a fallback for "an older install" where scripts/setup.mjs is missing.
  //   It used to show `codex mcp add mubit -- node …` and call the result "identical" to the
  //   script's — which passes `--env MUBIT_CC_DATA_DIR=…`. It is not identical, and the MCP
  //   bundle gets no boot.mjs, so nothing else supplies the pin: the server derives its own run
  //   id and writes /mubit-memory:remember into a run recall never reads, or fails auth outright
  //   on a machine whose credentials live in the directory it did not look in.
  const mcpAdd = /codex mcp add mubit[\s\S]{0,400}?```/.exec(skill);
  assert.ok(mcpAdd, 'the skill no longer shows a `codex mcp add mubit` command at all.');
  assert.match(mcpAdd[0], /--env/,
    'the documented `codex mcp add` has no --env, so a reader following the fallback registers '
    + `a server pointed at the wrong data directory:\n${mcpAdd[0]}`);
  assert.match(mcpAdd[0], /MUBIT_CC_DATA_DIR/, 'the --env must name MUBIT_CC_DATA_DIR.');

  assert.doesNotMatch(skill, /the results are identical/,
    'the skill claimed the by-hand path and the script produce identical results. They do not, '
    + 'and that sentence is what stops a reader noticing the missing pin.');
  assert.match(skill, /MUBIT_CC_DATA_DIR/,
    'the hook registrations the fallback describes need the pin as well.');
});

test('.gitignore re-includes the committed artifact directories', () => {
  const raw = readOrFail(P.gitignore, 'the artifact negations; see its own comment.');
  for (const dir of ['hooks/dist', 'mcp/dist', 'bin']) {
    // § There is no build step at install time. A `dist` that is ignored is a plugin that
    //   installs with a manifest pointing at files that were never published.
    assert.match(raw, new RegExp(`^!${dir.replace('/', '\\/')}/?$`, 'm'),
      `.gitignore must re-include ${dir}/ — a Codex install copies files, it does not build them.`);
  }
});
