// @ts-check
/**
 * Manifest lint, as executable tests — build-guide §12.7.
 *
 * These are data assertions over files. Nothing here starts a process, opens a
 * socket, or needs the plugin runtime, so this file is the cheapest possible
 * early-warning system for the class of breakage that only shows up at install
 * time: a version that drifted, a hook pointing at a bundle the build no longer
 * produces, a `userConfig` key nobody reads, an allowlisted MCP tool that was
 * renamed upstream.
 *
 * Every missing file fails with the path and the guide section that defines it.
 * Nothing is skipped — a skipped manifest check is indistinguishable from a
 * passing one on a CI dashboard.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { PLUGIN_ROOT, REPO_ROOT } from './helpers/harness.mjs';

// ---------------------------------------------------------------------------
// Paths (§2 file tree)
// ---------------------------------------------------------------------------

const P = {
  plugin: join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'),
  hooks: join(PLUGIN_ROOT, 'hooks', 'hooks.json'),
  mcp: join(PLUGIN_ROOT, '.mcp.json'),
  settings: join(PLUGIN_ROOT, 'settings.json'),
  pkg: join(PLUGIN_ROOT, 'package.json'),
  marketplace: join(REPO_ROOT, '.claude-plugin', 'marketplace.json'),
  gitignore: join(PLUGIN_ROOT, '.gitignore'),
  config: join(PLUGIN_ROOT, 'lib', 'config.mjs'),
  serverBundle: join(PLUGIN_ROOT, 'mcp', 'dist', 'server.js'),
  skills: join(PLUGIN_ROOT, 'skills'),
  agents: join(PLUGIN_ROOT, 'agents'),
};

/** The plugin's own MCP server prefix. `.mcp.json` names the server `mubit` (§3.3). */
const QUALIFIED_PREFIX = 'mcp__plugin_mubit-memory_mubit__';

/** §8.2 — ten of the twenty-one tools. */
const DEFAULT_ALLOWLIST = [
  'mubit_learned', 'mubit_recall', 'mubit_outcome', 'mubit_reflect', 'mubit_lessons',
  'mubit_diagnose', 'mubit_archive', 'mubit_dereference', 'mubit_forget', 'mubit_status',
];

/** §6.2 — every key the plugin promises to honour at enable time. */
const USER_CONFIG_KEYS = [
  'endpoint', 'apiKey', 'userId', 'runStrategy', 'capture', 'recall', 'redact',
  'recallTokenBudget', 'recallAssemble', 'reflectOnEnd', 'outcomeMode', 'statusLine',
  'mcpTools',
];

// ---------------------------------------------------------------------------
// Local helpers — no YAML/JSON dependency, no shared state
// ---------------------------------------------------------------------------

/** @param {string} p @param {string} label @param {string} why */
function mustExist(p, label, why) {
  if (!existsSync(p)) {
    assert.fail(`${label} does not exist yet: ${p}\n  ${why}`);
  }
  return p;
}

/** @param {string} p @param {string} label @param {string} why @returns {any} */
function readJson(p, label, why) {
  mustExist(p, label, why);
  const raw = readFileSync(p, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    return assert.fail(`${label} is not valid JSON (${p}): ${/** @type {Error} */ (e).message}`);
  }
}

/** @param {string} p @param {string} label @param {string} why @returns {string} */
function readText(p, label, why) {
  mustExist(p, label, why);
  return readFileSync(p, 'utf8');
}

/** `${CLAUDE_PLUGIN_ROOT}/x` → an absolute path under the plugin. */
function resolvePluginPath(s) {
  return s
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, PLUGIN_ROOT)
    .replace(/\$CLAUDE_PLUGIN_ROOT\b/g, PLUGIN_ROOT);
}

/** Flatten hooks.json into one row per registered command. */
function hookEntries(hooksJson) {
  /** @type {Array<{event:string, groupIndex:number, index:number, matcher:any, entry:any, where:string}>} */
  const out = [];
  for (const [event, groups] of Object.entries(hooksJson.hooks ?? {})) {
    assert.ok(Array.isArray(groups), `hooks.json: ${event} must be an array of matcher groups`);
    /** @type {any[]} */ (groups).forEach((g, gi) => {
      assert.ok(Array.isArray(g.hooks), `hooks.json: ${event}[${gi}] has no "hooks" array`);
      g.hooks.forEach((h, hi) => out.push({
        event, groupIndex: gi, index: hi, matcher: g.matcher, entry: h,
        where: `${event}[${gi}].hooks[${hi}]`,
      }));
    });
  }
  return out;
}

/** Frontmatter `tools:` values from a SKILL.md / agent .md, as a flat string array. */
function frontmatterTools(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null; // caller decides whether missing frontmatter is fatal
  const block = m[1];
  const inline = /^tools\s*:\s*(\[[^\]]*\])\s*$/m.exec(block);
  if (inline) {
    try {
      return JSON.parse(inline[1]);
    } catch {
      return inline[1].replace(/[[\]]/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
  }
  const scalar = /^tools\s*:\s*([^\n[]+)$/m.exec(block);
  if (scalar) return scalar[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  const blockList = /^tools\s*:\s*\r?\n((?:\s*-\s+.*\r?\n?)+)/m.exec(block);
  if (blockList) {
    return blockList[1].split(/\r?\n/)
      .map((l) => /^\s*-\s+(.*)$/.exec(l)?.[1] ?? '')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  return [];
}

/** Every `skills/<name>/SKILL.md` and `agents/*.md` that exists on disk. */
function markdownWithTools() {
  /** @type {Array<{file:string, rel:string}>} */
  const files = [];
  if (existsSync(P.skills)) {
    for (const d of readdirSync(P.skills, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = join(P.skills, d.name, 'SKILL.md');
      if (existsSync(f)) files.push({ file: f, rel: `skills/${d.name}/SKILL.md` });
    }
  }
  if (existsSync(P.agents)) {
    for (const f of readdirSync(P.agents)) {
      if (f.endsWith('.md')) files.push({ file: join(P.agents, f), rel: `agents/${f}` });
    }
  }
  return files;
}

/**
 * The real MCP tool names, parsed out of the server bundle the plugin ships and runs.
 *
 * This used to read the upstream TypeScript, which lives outside `PLUGIN_ROOT` and so is
 * absent from an installed copy — the assertions below failed in a published checkout for
 * want of a file that was never part of the plugin. The bundle is the honest target anyway:
 * an allowlist entry has to name a tool the *running server* registers, and that is this
 * file, not the source it was built from.
 */
function realToolNames() {
  const src = readText(P.serverBundle, 'mcp/dist/server.js',
    'This is the bundled MCP server (§1.9); the plugin allowlist is checked against what it registers.');
  const names = [...src.matchAll(/name:\s*"(mubit_[a-z_0-9]+)"/g)].map((m) => m[1]);
  assert.ok(names.length > 0, 'could not parse any tool names out of mcp/dist/server.js');
  return names;
}

// ---------------------------------------------------------------------------
// §12.7 — every manifest parses
// ---------------------------------------------------------------------------

// §3 — all five plugin manifests plus the repo-root catalog must exist and parse.
// A manifest that does not parse is not a degraded plugin; it is an uninstallable one.
test('every manifest exists and parses as JSON', () => {
  readJson(P.plugin, '.claude-plugin/plugin.json', 'Defined verbatim in build-guide §3.1.');
  readJson(P.hooks, 'hooks/hooks.json', 'Defined verbatim in build-guide §3.2.');
  readJson(P.mcp, '.mcp.json', 'Defined verbatim in build-guide §3.3.');
  readJson(P.settings, 'settings.json', 'Defined verbatim in build-guide §3.4 (statusLine registration).');
  readJson(P.pkg, 'package.json', 'Defined verbatim in build-guide §11.1.');
  readJson(P.marketplace, '.claude-plugin/marketplace.json',
    'Repo-root marketplace catalog, build-guide §3.5. This is what `/plugin marketplace add mubit-ai/claude-plugins` reads.');
});

// §3.1/§3.5 — identity is duplicated across manifests; it must agree.
test('plugin identity agrees across plugin.json and the marketplace entry', () => {
  const plugin = readJson(P.plugin, '.claude-plugin/plugin.json', 'build-guide §3.1');
  const market = readJson(P.marketplace, '.claude-plugin/marketplace.json', 'build-guide §3.5');

  assert.equal(plugin.name, 'mubit-memory', 'plugin.json name must be "mubit-memory"');
  assert.ok(Array.isArray(market.plugins), 'marketplace.json must have a "plugins" array');
  const entry = market.plugins.find((p) => p.name === 'mubit-memory');
  assert.ok(entry, 'marketplace.json has no plugin entry named "mubit-memory"');
});

// §12.7 — one bump touches four files (plugin.json, package.json, marketplace.json,
// and — at release time — the sibling JS packages). Drift here ships a plugin whose
// reported version is a lie.
test('version lockstep: plugin.json === package.json === marketplace.json entry', () => {
  const plugin = readJson(P.plugin, '.claude-plugin/plugin.json', 'build-guide §3.1');
  const pkg = readJson(P.pkg, 'package.json', 'build-guide §11.1');
  const market = readJson(P.marketplace, '.claude-plugin/marketplace.json', 'build-guide §3.5');
  const entry = (market.plugins ?? []).find((p) => p.name === 'mubit-memory');
  assert.ok(entry, 'marketplace.json has no "mubit-memory" entry to compare versions against');

  assert.match(String(plugin.version), /^\d+\.\d+\.\d+$/, 'plugin.json version must be semver');
  assert.equal(pkg.version, plugin.version,
    `package.json version ${pkg.version} !== plugin.json version ${plugin.version} — one bump touches four files (§12.7); automate it or it will drift`);
  assert.equal(entry.version, plugin.version,
    `marketplace.json entry version ${entry.version} !== plugin.json version ${plugin.version}`);
});

// ---------------------------------------------------------------------------
// §12.7 — hooks.json wiring
// ---------------------------------------------------------------------------

// §12.7 — a hook whose bundle is missing is a silently dead event. `dist/` is a
// committed artifact (§11.3), so "it exists in the repo" is the whole install check.
test('every hooks.json command/args path exists under hooks/dist/', () => {
  const hooks = readJson(P.hooks, 'hooks/hooks.json', 'build-guide §3.2');
  const distDir = join(PLUGIN_ROOT, 'hooks', 'dist');
  const entries = hookEntries(hooks);
  assert.ok(entries.length > 0, 'hooks.json registers no commands at all');

  for (const { where, entry } of entries) {
    const script = (entry.args ?? []).find((a) => typeof a === 'string' && a.endsWith('.mjs'));
    assert.ok(script, `${where}: no .mjs script found in args — exec form must name the bundle in args (§3.2)`);
    const abs = resolvePluginPath(script);
    assert.ok(abs.startsWith(distDir + '/') || abs.startsWith(distDir + '\\'),
      `${where}: script must live under hooks/dist/ (committed build output, §11.3), got ${script}`);
    assert.ok(existsSync(abs),
      `${where}: ${script} does not exist yet → ${abs}\n  Build it: npm --prefix integrations/claude-code run build (§11.2). dist/ is committed (§11.3).`);
  }
});

// §6.3 — shell-form hook commands cannot interpolate `${user_config.*}`; Claude Code
// blocks it as an injection guard. Exec form also means no shell to fork and no quoting
// to get wrong.
test('every hooks.json command uses exec form (command + args), never shell form', () => {
  const hooks = readJson(P.hooks, 'hooks/hooks.json', 'build-guide §3.2');
  for (const { where, entry } of hookEntries(hooks)) {
    assert.equal(entry.type, 'command', `${where}: hook "type" must be "command"`);
    assert.equal(typeof entry.command, 'string', `${where}: "command" must be a string`);
    assert.ok(!/\s/.test(entry.command),
      `${where}: "command" contains whitespace (${JSON.stringify(entry.command)}) — that is shell form; use command + args (§6.3)`);
    assert.equal(entry.command, 'node',
      `${where}: command must be exactly "node" (§3.2), got ${JSON.stringify(entry.command)}`);
    assert.ok(Array.isArray(entry.args) && entry.args.length >= 1,
      `${where}: exec form requires a non-empty "args" array (§6.3)`);
    const all = [entry.command, ...entry.args].join(' ');
    assert.ok(!/[|;&`]|\$\(/.test(all.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, '')),
      `${where}: shell metacharacters in an exec-form command: ${all}`);
  }
});

// §3.2 — all ten registrations, with the exact events, ordering, matchers, extra args
// and timeouts. `timeout` is in SECONDS; a millisecond value here silently gives every
// hook a ~3ms budget.
test('hooks.json declares all ten registrations with the right events, args and timeouts', () => {
  const hooks = readJson(P.hooks, 'hooks/hooks.json', 'build-guide §3.2');
  const events = Object.keys(hooks.hooks ?? {});

  const expectedEvents = [
    'SessionStart', 'UserPromptSubmit', 'SubagentStart', 'PostToolUse', 'PostToolUseFailure',
    'Stop', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd',
  ];
  assert.deepEqual([...events].sort(), [...expectedEvents].sort(),
    `hooks.json must register exactly the ten events in §3.2; got [${events.join(', ')}]`);

  /** event → flat list of {script, extraArgs, timeout} in declaration order */
  const flat = new Map();
  for (const { event, entry } of hookEntries(hooks)) {
    const args = (entry.args ?? []).map(String);
    const scriptIdx = args.findIndex((a) => a.endsWith('.mjs'));
    const row = {
      script: scriptIdx >= 0 ? args[scriptIdx].split('/').pop() : '(none)',
      extraArgs: scriptIdx >= 0 ? args.slice(scriptIdx + 1) : [],
      timeout: entry.timeout,
    };
    if (!flat.has(event)) flat.set(event, []);
    flat.get(event).push(row);
  }

  /** @type {Record<string, Array<{script:string, extraArgs:string[], timeout:number}>>} */
  const expected = {
    SessionStart: [{ script: 'session-start.mjs', extraArgs: [], timeout: 5 }],
    // Order matters: recall must run before the prompt is staged for the drain trigger.
    UserPromptSubmit: [
      { script: 'prompt-recall.mjs', extraArgs: [], timeout: 3 },
      { script: 'stage-prompt.mjs', extraArgs: [], timeout: 3 },
    ],
    // Registered with NO matcher, deliberately. The matcher field for this event is
    // `agent_type` and a matcher can only ever be positive, so "every agent except the
    // plugin's own recall agent" is not a thing it can express — and the set of agent types
    // a user might spawn is open, so an allowlist would silently exclude most of them. The
    // self-exclusion therefore lives in the hook, where a test can drive both directions.
    SubagentStart: [{ script: 'subagent-start.mjs', extraArgs: [], timeout: 3 }],
    // Exactly one, and match-all. Two groups both matching a tool would fire capture twice
    // for that one call — see the PostToolUse matcher test below.
    PostToolUse: [{ script: 'capture.mjs', extraArgs: [], timeout: 3 }],
    PostToolUseFailure: [{ script: 'capture.mjs', extraArgs: ['--failure'], timeout: 3 }],
    Stop: [{ script: 'capture.mjs', extraArgs: ['--stop'], timeout: 5 }],
    SubagentStop: [{ script: 'capture.mjs', extraArgs: ['--subagent'], timeout: 3 }],
    PreCompact: [{ script: 'checkpoint.mjs', extraArgs: ['--pre'], timeout: 10 }],
    PostCompact: [{ script: 'checkpoint.mjs', extraArgs: ['--post'], timeout: 5 }],
    SessionEnd: [{ script: 'session-end.mjs', extraArgs: [], timeout: 8 }],
  };

  for (const [event, rows] of Object.entries(expected)) {
    assert.deepEqual(flat.get(event), rows,
      `hooks.json ${event} registration does not match §3.2 (timeouts are SECONDS)`);
  }
});

// §3.2 — SessionStart is matched on source; without the matcher the hook fires on
// sources it has no handling for.
test('hooks.json SessionStart matches startup|resume|clear|compact', () => {
  const hooks = readJson(P.hooks, 'hooks/hooks.json', 'build-guide §3.2');
  const groups = hooks.hooks?.SessionStart ?? [];
  assert.equal(groups.length, 1, 'SessionStart should declare exactly one matcher group');
  assert.equal(groups[0].matcher, 'startup|resume|clear|compact',
    'SessionStart matcher must be "startup|resume|clear|compact" (§3.2)');
});

/**
 * §3.2 — PostToolUse is ONE group, and it matches every tool.
 *
 * It used to be two: an anchored allowlist of eleven built-in names, and `^mcp__.*`. Both
 * halves of that were wrong.
 *
 * 1. The allowlist enumerated a tool set the plugin does not own and cannot see change. The
 *    host's names drift under it — `Task` became `Agent`, `KillShell` became `TaskStop`,
 *    `BashOutput` became `TaskOutput` — and the only reason the renamed ones kept matching
 *    is that the host tests a matcher against a tool's former names as well as its current
 *    one. That is a compatibility table the plugin does not control and cannot read, and
 *    every entry in it is one host release from going away. Meanwhile a dozen names that
 *    never existed when the list was written (`TaskCreate`, `TaskUpdate`, `Skill`,
 *    `SendMessage`, `Artifact`, …) had no alias to ride and were simply never captured:
 *    459 of 7,545 calls (6.1%) over a real transcript corpus, silently dropped, with nothing
 *    anywhere to report the loss. A rule the plugin cannot keep correct does not belong in a
 *    manifest; the decision moves into `capture.mjs`, where it is a tested skip list (see
 *    `test/capture.test.mjs`).
 * 2. Two groups cannot survive one of them becoming match-all: every `mcp__*` call would
 *    match both and fire capture twice for a single tool call. So it is exactly one.
 *
 * The group deliberately also matches this plugin's own MCP tools; capture drops those in
 * code (§4.4), because a negative lookahead in a manifest is untestable.
 */
test('hooks.json PostToolUse declares exactly one match-all group', () => {
  const hooks = readJson(P.hooks, 'hooks/hooks.json', 'build-guide §3.2');
  const groups = hooks.hooks?.PostToolUse ?? [];
  assert.equal(groups.length, 1,
    'PostToolUse must declare exactly ONE matcher group — a second group matching the same '
    + 'tool fires capture twice for one call');

  // The host treats an absent matcher, `""`, `"*"` and `".*"` as match-all. Anything else
  // is an allowlist, whatever it is spelled like.
  const matcher = groups[0].matcher;
  assert.ok(matcher === undefined || matcher === '' || matcher === '*' || matcher === '.*',
    `PostToolUse matcher must match every tool, got ${JSON.stringify(matcher)} — the plugin `
    + 'cannot enumerate the host\'s tool set, so it must not try');

  // The names the old allowlist could never deliver, and the ones the host has since
  // renamed. Each one must reach capture now.
  for (const tool of ['Read', 'Bash', 'Edit', 'Agent', 'TaskCreate', 'TaskUpdate', 'TaskStop',
    'Skill', 'SendMessage', 'Artifact', 'TaskOutput', 'mcp__github__create_issue']) {
    assert.ok(matchesAll(matcher, tool), `PostToolUse must match ${tool}`);
  }
});

/** The host's rule: absent, `""`, `"*"` and `".*"` match every tool; anything else filters. */
function matchesAll(matcher, toolName) {
  if (matcher === undefined || matcher === '' || matcher === '*' || matcher === '.*') return true;
  try { return new RegExp(String(matcher)).test(toolName); } catch { return false; }
}

// §11.4 — `npx` costs ~500ms of module resolution per invocation, paid on every
// PostToolUse. A fifty-tool session would burn 25 seconds of process overhead for zero
// work. A TS loader (tsx/ts-node) has the same shape of cost.
test('no hooks.json command uses npx or a TypeScript loader', () => {
  const hooks = readJson(P.hooks, 'hooks/hooks.json', 'build-guide §3.2');
  for (const { where, entry } of hookEntries(hooks)) {
    const all = [entry.command, ...(entry.args ?? [])].join(' ');
    assert.ok(!/\bnpx\b/.test(all), `${where}: uses npx — ~500ms of resolution per hook (§11.4): ${all}`);
    assert.ok(!/\b(tsx|ts-node)\b/.test(all), `${where}: uses a TypeScript loader (§11.4): ${all}`);
    assert.ok(!/--(loader|experimental-loader)\b/.test(all), `${where}: registers a loader hook (§11.4): ${all}`);
    assert.ok(!/\.tsx?(\s|$)/.test(all), `${where}: executes TypeScript directly (§11.4): ${all}`);
  }
});

// ---------------------------------------------------------------------------
// §3.3 / §3.4 — the other two plugin manifests
// ---------------------------------------------------------------------------

// §3.3 — the server name is load-bearing: the fully qualified tool prefix that skills
// and hook matchers use is `mcp__plugin_mubit-memory_<server-name>__`.
test('.mcp.json registers one server named "mubit" pointing at mcp/dist/index.js', () => {
  const mcp = readJson(P.mcp, '.mcp.json', 'build-guide §3.3');
  const names = Object.keys(mcp.mcpServers ?? {});
  assert.deepEqual(names, ['mubit'],
    `.mcp.json must declare exactly one server named "mubit" — the ${QUALIFIED_PREFIX} prefix depends on it (§3.2 matcher note)`);

  const server = mcp.mcpServers.mubit;
  assert.equal(server.command, 'node', '.mcp.json server command must be "node" (§11.4)');
  assert.ok(Array.isArray(server.args) && server.args.length === 1,
    '.mcp.json server must use exec form with a single entry-point arg');
  const abs = resolvePluginPath(String(server.args[0]));
  assert.ok(abs.endsWith(join('mcp', 'dist', 'index.js')),
    `.mcp.json entry point must be mcp/dist/index.js (§3.3), got ${server.args[0]}`);
  assert.ok(existsSync(abs),
    `mcp/dist/index.js does not exist yet → ${abs}\n  It is the bundled mcp/src/launch.mjs (§8.3, §11.2); dist/ is committed (§11.3).`);
});

// ---------------------------------------------------------------------------
// Distribution: tracked, not merely present
// ---------------------------------------------------------------------------

/**
 * Claude Code installs this plugin by fetching a published tree, and that tree is
 * built from `git ls-files`. So the question every other test in this file asks —
 * "does the file exist?" — is the wrong one. On a developer's machine an untracked
 * file exists and works perfectly; downstream it was never published at all.
 *
 * This is not hypothetical. The repo-root `.gitignore` carries a bare `.mcp.json`
 * rule, meant for developers' own local MCP configs, and it silently swallowed the
 * plugin's `.mcp.json`. The file sat on disk, `existsSync` was happy, the assertion
 * above passed — and the published plugin registered no MCP server, so every
 * `mcp__plugin_mubit-memory_mubit__*` tool the skills declare resolved to nothing.
 *
 * The plugin's own `.gitignore` already re-includes `hooks/dist/` and `mcp/dist/`
 * for exactly this reason. `.mcp.json` needed the same line and did not have it.
 *
 * Assert the property that actually broke: tracked.
 */
test('every file Claude Code needs at runtime is tracked by git, not merely present', () => {
  // Paths are repo-relative because that is what `git ls-files` speaks.
  const REQUIRED = [
    'integrations/claude-code/.mcp.json',
    'integrations/claude-code/.claude-plugin/plugin.json',
    'integrations/claude-code/hooks/hooks.json',
    'integrations/claude-code/settings.json',
    'integrations/claude-code/package.json',
    'integrations/claude-code/mcp/dist/index.js',
    'integrations/claude-code/bin/statusline.mjs',
    '.claude-plugin/marketplace.json',
  ];

  const res = spawnSync('git', ['ls-files', '-z', '--', ...REQUIRED],
    { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ls-files failed: ${res.stderr}`);
  const tracked = new Set(res.stdout.split('\0').filter(Boolean));

  for (const rel of REQUIRED) {
    assert.ok(tracked.has(rel),
      `${rel} is not tracked by git.\n`
      + '  It may exist on disk and work locally, but the published tree is built from\n'
      + '  `git ls-files`, so downstream this file does not exist at all.\n'
      + '  Check whether a broader .gitignore is swallowing it, and re-include it in\n'
      + '  integrations/claude-code/.gitignore the way !hooks/dist/ and !mcp/dist/ are.');
  }
});

// §3.4 — the shipped statusLine registration. Whether a plugin may own the status line
// is unverified (§16.2), but if we ship the registration it must point at a real file.
test('settings.json registers the status line in exec form at bin/statusline.mjs', () => {
  const settings = readJson(P.settings, 'settings.json', 'build-guide §3.4');
  const sl = settings.statusLine;
  assert.ok(sl, 'settings.json must declare a "statusLine" entry (§3.4)');
  assert.equal(sl.type, 'command', 'statusLine.type must be "command"');
  assert.equal(sl.command, 'node', 'statusLine.command must be "node" — never a shell string (§6.3)');
  assert.ok(Array.isArray(sl.args) && sl.args.length === 1, 'statusLine must use exec form with one arg');
  const abs = resolvePluginPath(String(sl.args[0]));
  assert.ok(abs.endsWith(join('bin', 'statusline.mjs')),
    `statusLine must point at bin/statusline.mjs (§3.4), got ${sl.args[0]}`);
  assert.ok(existsSync(abs),
    `bin/statusline.mjs does not exist yet → ${abs}\n  Built from bin/statusline.src.mjs (§11.2) and committed (§11.3).`);
});

// ---------------------------------------------------------------------------
// §12.7 — userConfig, tool prefixes, allowlist
// ---------------------------------------------------------------------------

// §6.2 — the enable-time prompt is a promise. A declared-but-unread option is a lie to
// the user, and an undeclared-but-read one is a setting they can never reach.
test('every userConfig key declared in plugin.json is read somewhere in lib/config.mjs', () => {
  const plugin = readJson(P.plugin, '.claude-plugin/plugin.json', 'build-guide §3.1');
  const src = readText(P.config, 'lib/config.mjs',
    'One resolution function sees every userConfig key (§4.1, §6.3).');

  const declared = Object.keys(plugin.userConfig ?? {});
  assert.ok(declared.length > 0, 'plugin.json declares no userConfig keys (§3.1)');

  for (const key of USER_CONFIG_KEYS) {
    assert.ok(declared.includes(key),
      `plugin.json userConfig is missing the documented key "${key}" (§6.2)`);
  }

  const screaming = (k) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
  for (const key of declared) {
    const seen = new RegExp(`\\b${key}\\b`).test(src) || new RegExp(`\\b${screaming(key)}\\b`).test(src);
    assert.ok(seen,
      `userConfig key "${key}" is declared in plugin.json but never read in lib/config.mjs — a declared-but-unread option is a lie to the user at enable time (§12.7)`);
  }
});

// §3.2 matcher note — bare `mcp__<server>__<tool>` does NOT match a plugin-provided
// server. Get this wrong and the skill's tool grant silently matches nothing.
test('every tools: entry in a skill or agent uses the fully qualified plugin prefix', () => {
  const files = markdownWithTools();
  assert.ok(files.length > 0,
    `no skills/*/SKILL.md or agents/*.md exist yet under ${PLUGIN_ROOT} — build-guide §9 defines six skills and one agent`);

  for (const { file, rel } of files) {
    const tools = frontmatterTools(readFileSync(file, 'utf8'));
    assert.ok(tools !== null, `${rel}: no YAML frontmatter block`);
    for (const t of tools) {
      assert.ok(t.startsWith(QUALIFIED_PREFIX),
        `${rel}: tools entry "${t}" is not fully qualified — a plugin-provided server needs the ${QUALIFIED_PREFIX} prefix; bare mcp__<server>__<tool> matches nothing (§3.2)`);
    }
  }
});

// §12.7 — catches the class of bug where a renamed MCP tool silently drops out of the
// allowlist and the skill referencing it stops working.
test('every tool in the default allowlist exists in the bundled MCP server', () => {
  const real = realToolNames();
  assert.equal(real.length, 21,
    `expected the bundled MCP server to register 21 tools (§1.9), parsed ${real.length}: ${real.join(', ')}`);

  for (const name of DEFAULT_ALLOWLIST) {
    assert.ok(real.includes(name),
      `default allowlist names "${name}", which the bundled server does not register. Real tools: ${real.join(', ')}`);
  }
  assert.equal(DEFAULT_ALLOWLIST.length, 10, 'the curated default allowlist is ten of twenty-one (§8.2)');
});

// §12.7 — same check, one level down: a tool named in a skill must exist in the server.
test('every tool named by a skill or agent exists in the bundled MCP server', () => {
  const real = new Set(realToolNames());
  for (const { file, rel } of markdownWithTools()) {
    for (const t of frontmatterTools(readFileSync(file, 'utf8')) ?? []) {
      const bare = t.replace(QUALIFIED_PREFIX, '');
      assert.ok(real.has(bare),
        `${rel}: names MCP tool "${bare}", which the bundled server does not register`);
    }
  }
});

// ---------------------------------------------------------------------------
// §11 — packaging invariants
// ---------------------------------------------------------------------------

// §11.1/§11.4 — a runtime dependency reintroduces module resolution into the hot path,
// which is exactly the cost that rules out npx. `@mubit-ai/mcp` is bundled at build time,
// not resolved at runtime, so it is a devDependency.
test('package.json has zero runtime dependencies, with esbuild and @mubit-ai/mcp as devDependencies', () => {
  const pkg = readJson(P.pkg, 'package.json', 'build-guide §11.1');

  const deps = pkg.dependencies ?? {};
  assert.deepEqual(Object.keys(deps), [],
    `package.json "dependencies" must be empty and stay empty (§11.1) — found: ${Object.keys(deps).join(', ')}`);

  const dev = pkg.devDependencies ?? {};
  assert.ok(dev.esbuild, 'esbuild must be a devDependency (§11.1) — it produces the committed bundles');
  assert.ok(dev['@mubit-ai/mcp'],
    '@mubit-ai/mcp must be a devDependency (§11.1) — it is bundled into mcp/dist/server.js at build time, not resolved at runtime');

  assert.equal(pkg.type, 'module', 'package.json must declare "type": "module"');
  assert.equal(pkg.name, '@mubit-ai/claude-code-plugin', 'package name is fixed by the release guard (§13)');
});

// §11.3 — Claude Code fetches the marketplace source.path from GitHub with no install
// step and no build. Whatever is in the repo is what runs; ignoring dist/ ships nothing.
test('.gitignore ignores node_modules but does NOT ignore dist', () => {
  const raw = readText(P.gitignore, '.gitignore',
    'build-guide §2/§11.3 — ignores node_modules; must not ignore dist.');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

  assert.ok(lines.some((l) => /(^|\/)node_modules(\/|$)/.test(l.replace(/^!/, ''))),
    '.gitignore must ignore node_modules');

  const ignoresDist = lines.filter((l) => !l.startsWith('!') && /\bdist\b/.test(l));
  assert.deepEqual(ignoresDist, [],
    `.gitignore must NOT ignore dist — there is no install step and no build on install (§11.3). Offending lines: ${ignoresDist.join(' | ')}`);
});

// §3.5 — the catalog entry is how the plugin is discovered and fetched. A wrong path
// installs an empty plugin; a missing contextCost hides the always-loaded surface.
test('marketplace.json source points at integrations/claude-code and declares contextCost', () => {
  const market = readJson(P.marketplace, '.claude-plugin/marketplace.json', 'build-guide §3.5');
  const entry = (market.plugins ?? []).find((p) => p.name === 'mubit-memory');
  assert.ok(entry, 'marketplace.json has no "mubit-memory" entry (§3.5)');

  // §3.5 originally specified {source:"github", repo:"...", path:"..."}. That form is
  // schema-valid and it costs an extra clone: the plugin ships in the *same* repo as this
  // catalog, so an explicit github source makes the host fetch a second copy of a tree it is
  // already holding — and pins the plugin to one repository name, which then has to be edited
  // in lockstep every time the catalog is served from somewhere else.
  // A marketplace-relative path resolves inside the copy the host already fetched to read this
  // file, so one manifest works unchanged for a directory-added marketplace and a GitHub-added
  // one alike.
  // Verified 2026-08-13 by installing for real from a local directory marketplace, both forms.
  assert.equal(entry.source, './integrations/claude-code',
    'marketplace.json source must be the marketplace-relative string "./integrations/claude-code" (§3.5)');

  assert.ok(entry.contextCost, 'marketplace entry must declare contextCost (§3.5) — ten MCP tool schemas plus six skill descriptions');
  assert.equal(typeof entry.contextCost.value, 'number', 'contextCost.value must be a number');
  assert.ok(entry.contextCost.value > 0, 'contextCost.value must be a real estimate, not 0');
});
