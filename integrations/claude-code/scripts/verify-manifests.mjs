#!/usr/bin/env node
// @ts-check
/**
 * Manifest lint — build-guide §12.7. Run by `npm run verify` and by CI.
 *
 * The same data assertions as test/manifests.test.mjs, in a form that does not need a test
 * runner: nothing here starts a process, opens a socket, or needs the plugin runtime. It
 * catches the class of breakage that only surfaces at install time — a version that
 * drifted, a hook pointing at a bundle the build no longer produces, a `userConfig` key
 * nobody reads, an allowlisted MCP tool that was renamed upstream.
 *
 * Exits 1 with every problem listed, never on the first one: fixing manifests one failure
 * per run is how a five-minute job becomes an afternoon.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PLUGIN_ROOT, '../..');

/** `.mcp.json` names the server `mubit`, so this is the prefix skills must use (§3.2). */
const QUALIFIED_PREFIX = 'mcp__plugin_mubit-memory_mubit__';

/** §4.7 — `CONN_STATES` in `lib/breaker.mjs`, restated rather than imported for the same
 *  reason as the allowlist below: this script must run without the plugin runtime. Adding a
 *  state there and not here means the README can stop documenting it and nothing notices. */
const CONN_STATES = [
  'ready', 'unreachable', 'server_error', 'auth_failed', 'not_responding', 'unconfigured',
];

/** §8.2 — ten of the twenty-one tools. */
const DEFAULT_ALLOWLIST = [
  'mubit_learned', 'mubit_recall', 'mubit_outcome', 'mubit_reflect', 'mubit_lessons',
  'mubit_diagnose', 'mubit_archive', 'mubit_dereference', 'mubit_forget', 'mubit_status',
];

const P = {
  plugin: join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'),
  hooks: join(PLUGIN_ROOT, 'hooks', 'hooks.json'),
  mcp: join(PLUGIN_ROOT, '.mcp.json'),
  settings: join(PLUGIN_ROOT, 'settings.json'),
  pkg: join(PLUGIN_ROOT, 'package.json'),
  marketplace: join(REPO_ROOT, '.claude-plugin', 'marketplace.json'),
  gitignore: join(PLUGIN_ROOT, '.gitignore'),
  readme: join(PLUGIN_ROOT, 'README.md'),
  contextCost: join(PLUGIN_ROOT, 'scripts', 'context-cost.json'),
  config: join(PLUGIN_ROOT, 'lib', 'config.mjs'),
  serverBundle: join(PLUGIN_ROOT, 'mcp', 'dist', 'server.js'),
  skills: join(PLUGIN_ROOT, 'skills'),
  agents: join(PLUGIN_ROOT, 'agents'),
};

/** @type {string[]} */
const problems = [];
const fail = (msg) => problems.push(msg);
const ok = (cond, msg) => { if (!cond) fail(msg); return Boolean(cond); };

/** @returns {any|null} */
function readJson(p, label, why) {
  if (!existsSync(p)) { fail(`${label} does not exist: ${p}\n    ${why}`); return null; }
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    fail(`${label} is not valid JSON (${p}): ${/** @type {Error} */ (e).message}`);
    return null;
  }
}

const resolvePluginPath = (s) => s
  .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, PLUGIN_ROOT)
  .replace(/\$CLAUDE_PLUGIN_ROOT\b/g, PLUGIN_ROOT);

// --- every manifest parses (§3) --------------------------------------------

const plugin = readJson(P.plugin, '.claude-plugin/plugin.json', 'build-guide §3.1');
const hooks = readJson(P.hooks, 'hooks/hooks.json', 'build-guide §3.2');
const mcp = readJson(P.mcp, '.mcp.json', 'build-guide §3.3');
const settings = readJson(P.settings, 'settings.json', 'build-guide §3.4');
const pkg = readJson(P.pkg, 'package.json', 'build-guide §11.1');
const market = readJson(P.marketplace, '.claude-plugin/marketplace.json', 'build-guide §3.5');

// --- version lockstep (§12.7) ----------------------------------------------

const entry = (market?.plugins ?? []).find((p) => p?.name === 'mubit-memory');
if (plugin && market) {
  ok(plugin.name === 'mubit-memory', `plugin.json name must be "mubit-memory", got ${plugin.name}`);
  ok(entry, 'marketplace.json has no plugin entry named "mubit-memory" (§3.5)');
}
if (plugin && pkg) {
  ok(/^\d+\.\d+\.\d+$/.test(String(plugin.version)), `plugin.json version must be semver, got ${plugin.version}`);
  ok(pkg.version === plugin.version,
    `version drift: package.json ${pkg.version} !== plugin.json ${plugin.version} — one bump touches four files (§12.7)`);
}
if (plugin && entry) {
  ok(entry.version === plugin.version,
    `version drift: marketplace.json entry ${entry.version} !== plugin.json ${plugin.version}`);
}
if (entry) {
  /*
   * The plugin ships in the same repo as this catalog, so a marketplace-relative path resolves
   * inside the copy the host already fetched, in both this repo and the published mirror — which
   * is why `marketplace.json` is byte-identical in the two and the mirror job rewrites nothing.
   * An explicit {source:"github"} entry would make the host clone a second time and re-resolve
   * the path against that clone, which is a slower way to reach the same files and one more
   * thing to keep in step. See the matching note in test/manifests.test.mjs.
   */
  ok(entry.source === './integrations/claude-code',
    `marketplace.json source must be the marketplace-relative string "./integrations/claude-code" — the plugin `
    + `ships in this same repo, so an explicit {source:"github"} entry triggers a second clone and the `
    + `install fails. Got ${JSON.stringify(entry.source)}`);
  ok(typeof entry.contextCost?.value === 'number' && entry.contextCost.value > 0,
    'marketplace entry must declare a real contextCost.value (§3.5)');
}

// --- hooks.json wiring (§3.2, §6.3, §11.4) ---------------------------------

if (hooks) {
  const distDir = join(PLUGIN_ROOT, 'hooks', 'dist');
  /** @type {Array<{where:string, entry:any}>} */
  const rows = [];
  for (const [event, groups] of Object.entries(hooks.hooks ?? {})) {
    if (!Array.isArray(groups)) { fail(`hooks.json: ${event} must be an array of matcher groups`); continue; }
    groups.forEach((g, gi) => {
      if (!Array.isArray(g?.hooks)) { fail(`hooks.json: ${event}[${gi}] has no "hooks" array`); return; }
      g.hooks.forEach((h, hi) => rows.push({ where: `${event}[${gi}].hooks[${hi}]`, entry: h }));
    });
  }
  ok(rows.length > 0, 'hooks.json registers no commands at all');

  for (const { where, entry: h } of rows) {
    ok(h.type === 'command', `${where}: hook "type" must be "command"`);
    ok(h.command === 'node', `${where}: command must be exactly "node" — exec form, never shell form (§6.3)`);
    const args = Array.isArray(h.args) ? h.args.map(String) : [];
    ok(args.length >= 1, `${where}: exec form requires a non-empty "args" array (§6.3)`);
    ok(typeof h.timeout === 'number' && h.timeout > 0 && h.timeout <= 120,
      `${where}: "timeout" is in SECONDS (§3.2), got ${h.timeout}`);

    const all = [h.command, ...args].join(' ');
    ok(!/\bnpx\b/.test(all), `${where}: uses npx — ~500ms of module resolution per hook (§11.4)`);
    ok(!/\b(tsx|ts-node)\b/.test(all) && !/--(loader|experimental-loader)\b/.test(all) && !/\.tsx?(\s|$)/.test(all),
      `${where}: uses a TypeScript loader or executes TypeScript directly (§11.4)`);

    const script = args.find((a) => a.endsWith('.mjs'));
    if (!ok(script, `${where}: no .mjs script in args — exec form must name the bundle (§3.2)`)) continue;
    const abs = resolvePluginPath(/** @type {string} */ (script));
    if (!ok(abs.startsWith(distDir + '/') || abs.startsWith(distDir + '\\'),
      `${where}: script must live under hooks/dist/ (committed build output, §11.3), got ${script}`)) continue;
    ok(existsSync(abs),
      `${where}: ${script} does not exist → ${abs}\n    Build it: npm --prefix integrations/claude-code run build (§11.2)`);
  }

  const expectedEvents = ['SessionStart', 'CwdChanged', 'UserPromptSubmit', 'PostToolUse',
    'PostToolUseFailure', 'Stop', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd'];
  const events = Object.keys(hooks.hooks ?? {});
  const missing = expectedEvents.filter((e) => !events.includes(e));
  const extra = events.filter((e) => !expectedEvents.includes(e));
  ok(missing.length === 0 && extra.length === 0,
    `hooks.json must register exactly the ten events in §3.2; missing [${missing}], unexpected [${extra}]`);

  ok(hooks.hooks?.SessionStart?.[0]?.matcher === 'startup|resume|clear|compact',
    'SessionStart matcher must be "startup|resume|clear|compact" (§3.2)');
  // Exactly ONE group, matching everything. Two groups was the old shape — a built-in tool
  // alternation plus `^mcp__.*` — and it dropped every tool the alternation had not been
  // updated for. It is one group now rather than two match-all ones because a second group
  // would fire capture.mjs twice for every tool call. What to capture is decided in
  // capture.mjs, where the tool table already lives (§3.2, audit F2).
  const postToolUse = hooks.hooks?.PostToolUse ?? [];
  ok(postToolUse.length === 1,
    `PostToolUse must declare exactly one match-all group (§3.2); found ${postToolUse.length}`);
  ok(['*', '', '.*'].includes(String(postToolUse[0]?.matcher ?? '')),
    'the PostToolUse matcher must match every tool — the host reads "", "*" and ".*" as '
    + `match-all; found ${JSON.stringify(postToolUse[0]?.matcher)} (§3.2)`);
}

// --- .mcp.json and settings.json (§3.3, §3.4) ------------------------------

if (mcp) {
  const names = Object.keys(mcp.mcpServers ?? {});
  if (ok(names.length === 1 && names[0] === 'mubit',
    `.mcp.json must declare exactly one server named "mubit" — the ${QUALIFIED_PREFIX} prefix depends on it (§3.3), got [${names}]`)) {
    const server = mcp.mcpServers.mubit;
    ok(server.command === 'node', '.mcp.json server command must be "node" (§11.4)');
    if (ok(Array.isArray(server.args) && server.args.length === 1,
      '.mcp.json server must use exec form with a single entry-point arg')) {
      const abs = resolvePluginPath(String(server.args[0]));
      ok(abs.endsWith(join('mcp', 'dist', 'index.js')),
        `.mcp.json entry point must be mcp/dist/index.js (§3.3), got ${server.args[0]}`);
      ok(existsSync(abs), `mcp/dist/index.js does not exist → ${abs} (bundled from mcp/src/launch.mjs, §11.2)`);
    }
    // No `env` block, for two independently fatal reasons. The host already injects
    // CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA / CLAUDE_PROJECT_DIR into a plugin's MCP
    // server process — and under `--plugin-dir` it injects the *inline* data dir,
    // `.../data/mubit-memory-inline`. Re-declaring those names here overwrites the correct
    // values with unusable ones, `dataDir()` falls back, and the MCP server writes to a
    // different data dir than the hooks. Naming any variable that happens to be unset is
    // worse: the host rejects the whole server config with `mcp-config-invalid` and the
    // plugin silently loses its MCP server. Anything else the server needs is the
    // launcher's job (`mcp/src/launch.mjs`), which resolves it from config.
    ok(server.env === undefined,
      '.mcp.json must not declare an "env" block (§3.3) — the host injects CLAUDE_PLUGIN_ROOT, '
      + 'CLAUDE_PLUGIN_DATA and CLAUDE_PROJECT_DIR itself, and re-declaring them splits the '
      + 'MCP server off into a different data dir than the hooks');
  }
}

if (settings) {
  const sl = settings.statusLine;
  if (ok(sl, 'settings.json must declare a "statusLine" entry (§3.4)')) {
    ok(sl.type === 'command' && sl.command === 'node',
      'statusLine must be exec form: type "command", command "node" — never a shell string (§6.3)');
    if (ok(Array.isArray(sl.args) && sl.args.length === 1, 'statusLine must use exec form with one arg')) {
      const abs = resolvePluginPath(String(sl.args[0]));
      ok(abs.endsWith(join('bin', 'statusline.mjs')), `statusLine must point at bin/statusline.mjs (§3.4), got ${sl.args[0]}`);
      ok(existsSync(abs), `bin/statusline.mjs does not exist → ${abs} (built from bin/statusline.src.mjs, §11.2)`);
    }
  }
}

// --- packaging invariants (§11.1, §11.3) -----------------------------------

if (pkg) {
  ok(Object.keys(pkg.dependencies ?? {}).length === 0,
    `package.json "dependencies" must be empty and stay empty (§11.1) — found: ${Object.keys(pkg.dependencies ?? {})}`);
  ok(pkg.devDependencies?.esbuild, 'esbuild must be a devDependency (§11.1)');
  ok(pkg.devDependencies?.['@mubit-ai/mcp'],
    '@mubit-ai/mcp must be a devDependency (§11.1) — it is bundled at build time, not resolved at runtime');
  ok(pkg.type === 'module', 'package.json must declare "type": "module"');
  ok(pkg.name === '@mubit-ai/claude-code-plugin', 'package name is fixed by the release guard (§13)');
}

if (existsSync(P.gitignore)) {
  const lines = readFileSync(P.gitignore, 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  ok(lines.some((l) => /(^|\/)node_modules(\/|$)/.test(l.replace(/^!/, ''))), '.gitignore must ignore node_modules');
  const ignoresDist = lines.filter((l) => !l.startsWith('!') && /\bdist\b/.test(l));
  ok(ignoresDist.length === 0,
    `.gitignore must NOT ignore dist — there is no install step and no build on install (§11.3). Offending: ${ignoresDist.join(' | ')}`);
} else {
  fail(`.gitignore does not exist: ${P.gitignore}`);
}

// --- userConfig is actually read (§6.2) ------------------------------------

if (plugin) {
  const declared = Object.keys(plugin.userConfig ?? {});
  ok(declared.length > 0, 'plugin.json declares no userConfig keys (§3.1)');
  if (existsSync(P.config)) {
    const src = readFileSync(P.config, 'utf8');
    const screaming = (k) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    for (const key of declared) {
      ok(new RegExp(`\\b${key}\\b`).test(src) || new RegExp(`\\b${screaming(key)}\\b`).test(src),
        `userConfig key "${key}" is declared in plugin.json but never read in lib/config.mjs — a declared-but-unread option is a lie to the user at enable time (§12.7)`);
    }
  } else {
    fail(`lib/config.mjs does not exist: ${P.config}\n    One resolution function must see every userConfig key (§4.1, §6.3).`);
  }
}

// --- skills, agents, and the MCP allowlist (§9, §12.7) ---------------------

/** @returns {string[]} */
function frontmatterTools(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return [];
  const block = m[1];
  const inline = /^tools\s*:\s*(\[[^\]]*\])\s*$/m.exec(block);
  if (inline) {
    try { return JSON.parse(inline[1]); } catch { /* lenient split below */ }
    return inline[1].replace(/[[\]]/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  const blockList = /^tools\s*:\s*\r?\n((?:\s*-\s+.*\r?\n?)+)/m.exec(block);
  if (blockList) {
    return blockList[1].split(/\r?\n/).map((l) => /^\s*-\s+(.*)$/.exec(l)?.[1] ?? '')
      .map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  const scalar = /^tools\s*:\s*([^\n[]+)$/m.exec(block);
  if (scalar) return scalar[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return [];
}

/*
 * The tool table comes from the server bundle the plugin ships, not from the upstream
 * TypeScript it was built from. That source sits outside `PLUGIN_ROOT`, so an installed copy
 * does not contain it and this check used to fail downstream on a missing file. The bundle is
 * also the stricter target: an allowlist entry has to name a tool the running server
 * registers.
 */
/** @type {string[]} */
let realTools = [];
if (existsSync(P.serverBundle)) {
  realTools = [...readFileSync(P.serverBundle, 'utf8').matchAll(/name:\s*"(mubit_[a-z_0-9]+)"/g)].map((m) => m[1]);
  ok(realTools.length > 0, 'could not parse any tool names out of mcp/dist/server.js');
  for (const name of DEFAULT_ALLOWLIST) {
    ok(realTools.includes(name),
      `default allowlist names "${name}", which the bundled MCP server does not register (§8.2)`);
  }
} else {
  fail(`mcp/dist/server.js does not exist: ${P.serverBundle} — run \`npm run build\``);
}

/** @type {Array<{file:string, rel:string}>} */
const markdown = [];
if (existsSync(P.skills)) {
  for (const d of readdirSync(P.skills, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = join(P.skills, d.name, 'SKILL.md');
    if (existsSync(f)) markdown.push({ file: f, rel: `skills/${d.name}/SKILL.md` });
  }
}
if (existsSync(P.agents)) {
  for (const f of readdirSync(P.agents)) {
    if (f.endsWith('.md')) markdown.push({ file: join(P.agents, f), rel: `agents/${f}` });
  }
}
ok(markdown.length > 0, 'no skills/*/SKILL.md or agents/*.md exist — build-guide §9 defines six skills and one agent');

for (const { file, rel } of markdown) {
  const text = readFileSync(file, 'utf8');
  if (!ok(/^---\r?\n[\s\S]*?\r?\n---/.test(text), `${rel}: no YAML frontmatter block`)) continue;

  /*
   * The host parses this block with a real YAML parser; test/skills.test.mjs parses it with a
   * hand-rolled `key: value` splitter, which is strictly more permissive. The gap that matters
   * is an unquoted scalar containing ": " — YAML reads it as a nested mapping and rejects the
   * whole document, at which point the skill loads with EVERY field silently dropped: no name,
   * no description, no tools grant, and no error in the UI. Cross-check with
   * `claude plugin validate <plugin-dir>`, which is the authority; this catches the one class
   * of it that a dependency-free script can catch.
   */
  const fmBlock = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  for (const line of fmBlock ? fmBlock[1].split(/\r?\n/) : []) {
    const kv = /^([A-Za-z0-9_-]+):[ \t]+(\S.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].trim();
    if (/^["'[{|>]/.test(value)) continue; // quoted, flow collection, or block scalar — all safe
    ok(!/:\s/.test(value),
      `${rel}: frontmatter "${kv[1]}" is an unquoted value containing ": ", so the YAML block does not parse `
      + `and the file loads with every field dropped. Quote it:\n`
      + `      ${kv[1]}: ${JSON.stringify(value)}`);
  }

  for (const t of frontmatterTools(text)) {
    if (!ok(t.startsWith(QUALIFIED_PREFIX),
      `${rel}: tools entry "${t}" is not fully qualified — a plugin-provided server needs the ${QUALIFIED_PREFIX} prefix; bare mcp__<server>__<tool> matches nothing (§3.2)`)) continue;
    const bare = t.slice(QUALIFIED_PREFIX.length);
    if (realTools.length) {
      ok(realTools.includes(bare), `${rel}: names MCP tool "${bare}", which the bundled MCP server does not register`);
    }
  }
}

// --- README.md, the four things it must say (§2, §13) ----------------------

/**
 * The plugin's README is the only documentation a marketplace installer ever sees, and four
 * of its statements are load-bearing: each one is a support ticket the plugin will otherwise
 * generate, on a schedule, forever. They are checked here rather than in prose review because
 * a README rewrite drops a paragraph far more easily than it drops a test.
 *
 * The rest — every `userConfig` key, every typed connection state, the redaction guarantee —
 * exists so the README cannot fall behind the manifest it documents. A config option nobody
 * can look up is the same defect as a config option nobody reads (§6.2, checked above).
 */
if (existsSync(P.readme)) {
  const readme = readFileSync(P.readme, 'utf8');
  const has = (...needles) => needles.every((n) => readme.includes(n));
  /** Bold runs, so "in bold near the top" is checkable rather than aspirational. */
  const bold = [...readme.matchAll(/\*\*([^*]+)\*\*/g)];

  const reloadInBold = bold.find((m) => m[1].includes('/reload-plugins'));
  ok(reloadInBold && reloadInBold.index < readme.length * 0.4,
    'README.md must say — in bold, near the top — that `/reload-plugins` does not fire SessionStart, so a '
    + 'fresh install has no run id, no registered agent and no marker until the user starts a NEW session. '
    + 'Until they do, the status line looks broken while everything is fine. This trips up everyone.');
  ok(has('SessionStart'),
    'README.md mentions /reload-plugins but never names SessionStart — the reason the reload is not enough');

  /*
   * The published README documents a hosted instance and nothing else. Self-hosting is not a
   * documented path.
   *
   * This asserts what the README must contain rather than listing components it must not name.
   * A denylist has to spell out the internals in order to forbid them, so the guard becomes
   * the disclosure the moment it ships — and it only catches terms someone thought to
   * enumerate. Pinning setup to the two hosted settings leaves no room for a local-stack
   * walkthrough to be correct, without naming one. The denylist still exists, in
   * `scripts/check-mirror-clean.mjs`, which runs against the built mirror and is not published.
   */
  ok(/\bendpoint\b/i.test(readme) && /\bapiKey\b|\bAPI key\b/i.test(readme),
    'README.md must document the two settings a hosted instance takes — `endpoint` and `apiKey`. '
    + 'Those are the whole configuration surface; anything else implies a stack the user runs.');
  ok(/\/plugin\b/.test(readme) && /\/mubit-memory:auth/.test(readme),
    'README.md must show how those settings get set: `/mubit-memory:auth`, or the `/plugin` config '
    + 'UI that writes them to the OS keychain. A README that documents neither is documenting '
    + 'some other install path.');

  ok(has('reflectOnEnd') && /reflectOnEnd[\s\S]{0,600}?(cross-session|beyond its own run)/.test(readme),
    'README.md must state what turning off `reflectOnEnd` costs: it is the only path that promotes a lesson '
    + 'beyond its own run, so disabling it for latency trades away cross-session memory');

  ok(has('per-conversation', 'per-directory')
    && /per-conversation[\s\S]{0,600}?(hook|capture)[\s\S]{0,200}?MCP/i.test(readme),
    'README.md must state that `per-conversation` splits hook captures from MCP-tool writes, and that '
    + '`per-directory` — the default — does not');

  ok(has('/plugin marketplace add mubit-ai/claude-plugins', '/plugin install mubit-memory@mubit'),
    'README.md must give both install commands verbatim: `/plugin marketplace add mubit-ai/claude-plugins` then '
    + '`/plugin install mubit-memory@mubit` (§13 "Done when")');

  for (const key of Object.keys(plugin?.userConfig ?? {})) {
    ok(new RegExp(`\\b${key}\\b`).test(readme),
      `README.md never documents the userConfig option "${key}" (§6) — the config surface is declared in `
      + 'plugin.json, so a user meets it at enable time whether or not it is written down');
  }

  // §4.7 — the states are typed precisely because each has a different fix. A README that
  // says "connection problems" instead of naming them sends every one of them to the same
  // wrong remedy.
  for (const state of CONN_STATES) {
    ok(new RegExp(`\\b${state}\\b`).test(readme),
      `README.md never names the connection state "${state}" (§4.7) — each state has its own `
      + 'distinct fix, and the status line shows them by name');
  }

  // §4.4 — the differentiator. "State it plainly rather than burying it in a table."
  ok(has('[REDACTED:'),
    'README.md must show the literal `[REDACTED:<kind>]` placeholder (§4.4) — the redaction guarantee is '
    + 'the plugin\'s headline differentiator and reads as marketing until the reader sees its output');
  ok(has('denylist'),
    'README.md must describe the path denylist (§4.4 stage 2) — matching captures are DROPPED, not scrubbed, '
    + 'which is a stronger guarantee than the pattern scrub and is invisible if unstated');
} else {
  fail(`README.md does not exist: ${P.readme}\n`
    + '    Build-guide §2: install, configure, troubleshoot. The release guard treats it as part of the '
    + 'release surface (§13), and it is the only documentation a marketplace installer sees.');
}

// --- contextCost was measured, not inherited (§3.5) ------------------------

/**
 * `marketplace.json` shipped `{"value": 2100}` as a placeholder. The number is checked
 * against a stamp written by `scripts/measure-context-cost.mjs`, and the stamp records the
 * surface it measured — so adding a skill or editing the allowlist invalidates it here
 * rather than silently leaving a stale claim in the marketplace catalog.
 *
 * This file starts no process (see the header), which is exactly why the measurement lives
 * in its own script and leaves a stamp behind.
 */
const REMEASURE = 'Re-measure: node scripts/measure-context-cost.mjs --write';
const stamp = existsSync(P.contextCost)
  ? readJson(P.contextCost, 'scripts/context-cost.json', `build-guide §3.5. ${REMEASURE}`)
  : (fail(`scripts/context-cost.json does not exist (§3.5) — marketplace.json declares a contextCost that `
    + `nobody measured.\n    ${REMEASURE}`), null);

if (stamp && entry) {
  ok(stamp.value === entry.contextCost?.value,
    `contextCost drift: marketplace.json declares ${entry.contextCost?.value}, the last measurement was `
    + `${stamp.value} (${stamp.measuredAt}).\n    ${REMEASURE}`);

  const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

  ok(sameSet(stamp.surface?.allowlist, DEFAULT_ALLOWLIST),
    `contextCost was measured against a different MCP allowlist than the one in force.\n`
    + `    measured: [${(stamp.surface?.allowlist ?? []).join(', ')}]\n`
    + `    current:  [${DEFAULT_ALLOWLIST.join(', ')}]\n    ${REMEASURE}`);

  const skillIds = existsSync(P.skills)
    ? readdirSync(P.skills, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(P.skills, d.name, 'SKILL.md')))
      .map((d) => d.name)
    : [];
  ok(sameSet(stamp.surface?.skills, skillIds),
    `contextCost was measured against a different set of skills than the plugin ships.\n`
    + `    measured: [${(stamp.surface?.skills ?? []).join(', ')}]\n`
    + `    current:  [${skillIds.join(', ')}]\n    ${REMEASURE}`);
}

// --- report -----------------------------------------------------------------

if (problems.length) {
  console.error(`verify-manifests: ${problems.length} problem${problems.length === 1 ? '' : 's'} (build-guide §12.7)\n`);
  for (const p of problems) console.error(`  ✖ ${p}`);
  console.error('');
  process.exit(1);
}
console.log('verify-manifests: all manifest checks passed (§12.7)');
