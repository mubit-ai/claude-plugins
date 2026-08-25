#!/usr/bin/env node
// @ts-check
/**
 * Measure the plugin's always-loaded context surface.
 *
 * `marketplace.json` shipped `{"value": 2100, "cached": 0}` as a placeholder. A declared
 * context budget that nobody measured is worse than none: the number is the one thing a
 * user reads before installing, and it is the only claim in the manifest that cannot be
 * checked by looking at the plugin.
 *
 * What is actually always-loaded, before the model does anything:
 *
 *   1. **MCP tool schemas.** Every tool the server registers at `tools/list` — name,
 *      description and the full JSON Schema — under the host's qualified prefix
 *      `mcp__plugin_mubit-memory_mubit__`, which is itself 30 characters per tool.
 *   2. **The server's `instructions`.** The string on the `initialize` result, which the
 *      host puts in the system prompt under "MCP Server Instructions". It is the one item
 *      here that is loaded even when the schemas are not: with tool search on — the
 *      default — the host defers the descriptions and loads tool names plus this. Measured
 *      from a live handshake for the same reason the schemas are, and because the launcher
 *      fills the field in on the outbound frame (`mcp/src/instructions.mjs`) rather than
 *      declaring it anywhere a static read could find.
 *   3. **Skill frontmatter.** `name` + `description` for each skill. The SKILL.md body is
 *      loaded on invocation, not up front, so only the frontmatter counts here.
 *   4. **Agent frontmatter**, on the same rule.
 *
 * Hooks, `lib/`, and the bundles cost nothing — they run out of process and their output
 * enters context only when a hook actually injects something.
 *
 * The tool schemas are read from a live `tools/list` rather than parsed out of the server
 * source, because zod-to-JSON-Schema is where most of the bytes come from and no static
 * reading reproduces it.
 *
 *   node scripts/measure-context-cost.mjs                 # report
 *   node scripts/measure-context-cost.mjs --json          # machine-readable
 *   node scripts/measure-context-cost.mjs --write         # stamp it and update marketplace.json
 *   node scripts/measure-context-cost.mjs --server <path> # measure a different server bundle
 *
 * `--server` measures a different server bundle, for the same reason it exists in
 * `mcp-probe.mjs`. What the committed server registers is what a user installing today
 * actually pays, so that is what gets declared; `curatedValue` reports the allowlisted
 * figure beside it. Until 0.9.1 the two differed — `mcp/dist/server.js` was bundled from the
 * *published* `@mubit-ai/mcp`, which predates the §8.1 allowlist patch and registered all 21
 * tools, so the declared cost was 5,382 against a curated 2,664. It is now built from the
 * in-repo package and the two agree.
 *
 * ## The token estimate
 *
 * Zero dependencies is a hard constraint (§11.1), so there is no real BPE tokenizer here.
 * The estimator segments into word / number / symbol runs and charges:
 *
 *   - a word run:   `ceil(len / 4)` tokens  (BPE keeps common short words whole and splits
 *                   longer ones at roughly four characters a piece)
 *   - a digit run:  `ceil(len / 3)` tokens  (digits tokenize worse than letters)
 *   - a symbol run: `ceil(len / 2)` tokens  (BPE merges the `":"`, `","`, `"},{"` runs that
 *                   dominate JSON Schema, so charging one per character is far too much)
 *   - whitespace:   free — it folds into the token that follows
 *
 * This is deliberately an **over**-estimate, and no claim is made about how close it lands:
 * without a real tokenizer there is nothing here to calibrate against, and of the two ways
 * to be wrong, a declared context budget that is too small is the one that misleads. The
 * report prints the characters-per-token ratio it implies and `--json` prints the raw
 * character counts, so anyone with a tokenizer can check the whole thing in one line.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PLUGIN_ROOT, '../..');
const LAUNCHER = join(PLUGIN_ROOT, 'mcp', 'dist', 'index.js');
const STAMP = join(PLUGIN_ROOT, 'scripts', 'context-cost.json');
const MARKETPLACE = join(REPO_ROOT, '.claude-plugin', 'marketplace.json');

/** The host prefixes a plugin-provided server's tools with this. 30 chars, once per tool. */
const QUALIFIED_PREFIX = 'mcp__plugin_mubit-memory_mubit__';

/** §8.2 — the curated set a blank `mcpTools` resolves to. Kept in sync by verify-manifests. */
const DEFAULT_ALLOWLIST = [
  'mubit_learned', 'mubit_recall', 'mubit_outcome', 'mubit_reflect', 'mubit_lessons',
  'mubit_diagnose', 'mubit_archive', 'mubit_dereference', 'mubit_forget', 'mubit_status',
  'mubit_strategies', 'mubit_checkpoint', 'mubit_memory_health',
];

const HANDSHAKE_MS = 20_000;

main().catch((err) => {
  process.stderr.write(`measure-context-cost: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
});

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) return usage();

  const entry = opt.server ? stageLauncher(opt.server) : (opt.entry || LAUNCHER);
  const listed = await listTools(entry);
  const skills = readMarkdownFrontmatter(join(PLUGIN_ROOT, 'skills'), 'SKILL.md');
  const agents = readMarkdownFrontmatter(join(PLUGIN_ROOT, 'agents'), null);

  const registered = costOfTools(listed.tools);
  const curated = costOfTools(listed.tools.filter((t) => DEFAULT_ALLOWLIST.includes(t.name)));
  const instructionCost = costOfText(listed.instructions);
  const skillCost = costOfFrontmatter(skills);
  const agentCost = costOfFrontmatter(agents);

  // `instructions` is in both totals unchanged: the allowlist bounds how many tool schemas
  // are resident and has no bearing on this string, which is one server-level field.
  const fixed = instructionCost.tokens + skillCost.tokens + agentCost.tokens;
  const value = registered.tokens + fixed;
  const curatedValue = curated.tokens + fixed;

  const result = {
    value,
    cached: 0,
    curatedValue,
    allowlistHonoured: listed.tools.length === curated.count,
    method: 'word/number/symbol segmentation; see the header of scripts/measure-context-cost.mjs',
    surface: {
      allowlist: [...DEFAULT_ALLOWLIST].sort(),
      registered: listed.tools.map((t) => t.name).sort(),
      skills: skills.map((f) => f.id).sort(),
      agents: agents.map((f) => f.id).sort(),
    },
    breakdown: {
      toolSchemas: { tokens: registered.tokens, chars: registered.chars, count: registered.count },
      serverInstructions: {
        tokens: instructionCost.tokens, chars: instructionCost.chars,
        count: listed.instructions ? 1 : 0,
      },
      curatedToolSchemas: { tokens: curated.tokens, chars: curated.chars, count: curated.count },
      skillFrontmatter: { tokens: skillCost.tokens, chars: skillCost.chars, count: skills.length },
      agentFrontmatter: { tokens: agentCost.tokens, chars: agentCost.chars, count: agents.length },
    },
    server: listed.server,
  };

  if (opt.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    report(result);
  }

  if (opt.write) write(result);
}

// ---------------------------------------------------------------------------
// tools/list over real stdio MCP
// ---------------------------------------------------------------------------

/**
 * @param {string} entry
 * @returns {Promise<{server: any, instructions: string,
 *                    tools: Array<{name: string, description?: string, inputSchema?: any}>}>}
 */
async function listTools(entry) {
  if (!existsSync(entry)) {
    throw new Error(`${entry} does not exist. Build it first: npm run build (§11.2)`);
  }
  // The measurement must not depend on whatever is in the developer's shell: a
  // `MUBIT_MCP_TOOLS` sitting in the environment would silently measure someone's
  // personal allowlist and declare it as everyone's.
  const env = { ...process.env };
  delete env.MUBIT_MCP_TOOLS;

  const child = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });

  /** @type {Map<number, (m: any) => void>} */
  const pending = new Map();
  let buf = '';
  let stderr = '';

  child.stderr.on('data', (d) => { stderr += String(d); });
  child.stdout.on('data', (d) => {
    buf += String(d);
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const fn = pending.get(msg.id);
        if (fn) { pending.delete(msg.id); fn(msg); }
      } catch { stderr += `[stdout, not protocol] ${line}\n`; }
    }
  });

  /** @returns {Promise<any>} */
  const rpc = (/** @type {number} */ id, /** @type {string} */ method, /** @type {any} */ params) =>
    new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(
        `timed out after ${HANDSHAKE_MS / 1000}s waiting for ${method}.\nserver stderr:\n${stderr || '(silent)'}`)),
      HANDSHAKE_MS);
      pending.set(id, (msg) => { clearTimeout(timer); res(msg); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    const init = await rpc(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'measure-context-cost', version: '1' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await rpc(2, 'tools/list', {});
    return {
      server: init.result?.serverInfo ?? null,
      instructions: typeof init.result?.instructions === 'string' ? init.result.instructions : '',
      tools: listed.result?.tools ?? [],
    };
  } finally {
    child.kill('SIGKILL');
  }
}

/**
 * Copy the launcher into a scratch directory beside a `server.js` that re-exports the
 * bundle you asked for — the launcher resolves `./server.js` relative to itself, so this
 * swaps the server without touching the committed one. Same trick as `mcp-probe.mjs`.
 * @param {string} serverPath
 * @returns {string} the staged entry point
 */
function stageLauncher(serverPath) {
  const abs = resolve(serverPath);
  if (!existsSync(abs)) throw new Error(`--server ${serverPath} does not exist → ${abs}`);
  const dir = mkdtempSync(join(tmpdir(), 'mubit-context-cost-'));
  const entry = join(dir, 'index.js');
  copyFileSync(LAUNCHER, entry);
  writeFileSync(join(dir, 'server.js'), `import ${JSON.stringify(abs)};\n`);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  return entry;
}

// ---------------------------------------------------------------------------
// Costing
// ---------------------------------------------------------------------------

/**
 * A tool costs what the host puts in the window: the qualified name, the description, and
 * the serialized input schema.
 * @param {Array<{name: string, description?: string, inputSchema?: any}>} tools
 */
function costOfTools(tools) {
  let chars = 0;
  for (const t of tools) {
    chars += estimateChars(`${QUALIFIED_PREFIX}${t.name}`)
      + estimateChars(t.description ?? '')
      + estimateChars(JSON.stringify(t.inputSchema ?? {}));
  }
  return { count: tools.length, chars, tokens: tools.reduce((n, t) => n + tokensOfTool(t), 0) };
}

/** @param {{name: string, description?: string, inputSchema?: any}} t */
function tokensOfTool(t) {
  return estimateTokens(`${QUALIFIED_PREFIX}${t.name}`)
    + estimateTokens(t.description ?? '')
    + estimateTokens(JSON.stringify(t.inputSchema ?? {}));
}

/**
 * A block of prose costs exactly itself. Separate from `costOfTools` because the host does
 * not wrap it in anything — no qualified prefix, no schema — so there is nothing to add.
 * @param {string} text
 */
function costOfText(text) {
  const s = typeof text === 'string' ? text : '';
  return { chars: estimateChars(s), tokens: estimateTokens(s) };
}

/**
 * A skill or agent costs its `name` and `description` — the body is loaded on invocation.
 * @param {Array<{id: string, name: string, description: string}>} entries
 */
function costOfFrontmatter(entries) {
  let chars = 0;
  let tokens = 0;
  for (const e of entries) {
    const text = `${e.name}: ${e.description}`;
    chars += estimateChars(text);
    tokens += estimateTokens(text);
  }
  return { chars, tokens };
}

/** @param {string} s */
const estimateChars = (s) => s.length;

/**
 * See the header: words at four characters a token, digits at three, symbol runs at two,
 * whitespace free.
 * @param {string} s
 */
function estimateTokens(s) {
  let n = 0;
  for (const m of s.matchAll(/([A-Za-z]+)|([0-9]+)|(\s+)|([^\sA-Za-z0-9]+)/g)) {
    if (m[1]) n += Math.ceil(m[1].length / 4);
    else if (m[2]) n += Math.ceil(m[2].length / 3);
    else if (m[4]) n += Math.ceil(m[4].length / 2);
    // whitespace: free
  }
  return n;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/**
 * @param {string} dir
 * @param {string|null} nested `SKILL.md` for skills/<id>/SKILL.md, null for agents/<id>.md
 * @returns {Array<{id: string, name: string, description: string}>}
 */
function readMarkdownFrontmatter(dir, nested) {
  if (!existsSync(dir)) return [];
  /** @type {Array<{id: string, name: string, description: string}>} */
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const file = nested
      ? (d.isDirectory() ? join(dir, d.name, nested) : null)
      : (d.isFile() && d.name.endsWith('.md') ? join(dir, d.name) : null);
    if (!file || !existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m) continue;
    const scalar = (/** @type {string} */ key) => {
      const hit = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm').exec(m[1]);
      return hit ? hit[1].trim().replace(/^["']|["']$/g, '') : '';
    };
    out.push({
      id: nested ? d.name : d.name.replace(/\.md$/, ''),
      name: scalar('name') || d.name,
      description: scalar('description'),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** @param {any} r */
function report(r) {
  const b = r.breakdown;
  const row = (/** @type {string} */ label, /** @type {any} */ tokens,
    /** @type {any} */ chars, /** @type {any} */ count) =>
    `  ${label.padEnd(26)} ${String(tokens).padStart(6)} tok  ${String(chars).padStart(7)} chars  ${count}\n`;

  process.stdout.write(`server    ${r.server?.name ?? '(unnamed)'} ${r.server?.version ?? ''}\n\n`);
  process.stdout.write(row('MCP tool schemas', b.toolSchemas.tokens, b.toolSchemas.chars, `${b.toolSchemas.count} tools`));
  process.stdout.write(row('server instructions', b.serverInstructions.tokens, b.serverInstructions.chars,
    b.serverInstructions.count ? 'loaded even under tool search' : 'ABSENT — see mcp/src/instructions.mjs'));
  process.stdout.write(row('skill frontmatter', b.skillFrontmatter.tokens, b.skillFrontmatter.chars, `${b.skillFrontmatter.count} skills`));
  process.stdout.write(row('agent frontmatter', b.agentFrontmatter.tokens, b.agentFrontmatter.chars, `${b.agentFrontmatter.count} agents`));
  process.stdout.write(`  ${'—'.repeat(58)}\n`);
  process.stdout.write(row('contextCost.value', r.value, '', ''));

  if (!r.allowlistHonoured) {
    process.stdout.write(
      `\nThis server registers all ${b.toolSchemas.count} tools, so \`mcpTools\` is inert and every\n`
      + `user pays for every tool. With the curated set honoured the same surface costs\n`
      + `${r.curatedValue} tokens, ${r.value - r.curatedValue} fewer.\n`
      + 'The server is bundled from the in-repo @mubit-ai/mcp, which reads MUBIT_MCP_TOOLS (§8.1).\n'
      + 'A server that ignores it is a stale bundle — rebuild:\n'
      + '  npm --prefix ../mcp ci && npm --prefix ../mcp run build && npm run build\n');
  }
  const chars = b.toolSchemas.chars + b.serverInstructions.chars
    + b.skillFrontmatter.chars + b.agentFrontmatter.chars;
  process.stdout.write(`\nDeliberate over-estimate, not a tokenizer count: ${(chars / r.value).toFixed(2)} chars/token `
    + 'over this surface, where a real BPE runs nearer 3.5 on schema JSON.\n'
    + 'Method in this script\'s header; --json prints the raw character counts.\n');
}

/** @param {any} r */
function write(r) {
  const stamp = {
    measuredAt: new Date().toISOString(),
    value: r.value,
    cached: r.cached,
    curatedValue: r.curatedValue,
    allowlistHonoured: r.allowlistHonoured,
    method: r.method,
    surface: r.surface,
    breakdown: r.breakdown,
  };
  writeFileSync(STAMP, `${JSON.stringify(stamp, null, 2)}\n`);

  // Surgical, not a re-serialization: `JSON.parse` → `JSON.stringify` would reflow every
  // hand-set line in the catalog and bury a one-number change in a whole-file diff.
  const before = readFileSync(MARKETPLACE, 'utf8');
  const replacement = `"contextCost": { "value": ${r.value}, "cached": ${r.cached} }`;
  const after = before.replace(/"contextCost"\s*:\s*\{[^{}]*\}/, replacement);
  if (after === before && !before.includes(replacement)) {
    throw new Error(`could not find a "contextCost" object to replace in ${MARKETPLACE}`);
  }
  const parsed = JSON.parse(after); // never write a manifest we just broke
  const entry = (parsed.plugins ?? []).find((/** @type {any} */ p) => p?.name === 'mubit-memory');
  if (entry?.contextCost?.value !== r.value) {
    throw new Error('the replacement did not land on the mubit-memory entry — check marketplace.json by hand');
  }
  writeFileSync(MARKETPLACE, after);

  process.stdout.write(`\nwrote ${STAMP.replace(REPO_ROOT, '.')}\n`);
  process.stdout.write(`wrote contextCost {"value": ${r.value}, "cached": ${r.cached}} to ${MARKETPLACE.replace(REPO_ROOT, '.')}\n`);
}

function usage() {
  process.stdout.write(`measure-context-cost — what the plugin costs before the model does anything (§3.5)

  --write           stamp scripts/context-cost.json and update marketplace.json
  --json            machine-readable
  --server <path>   measure a different server bundle (see the header)
  --entry  <path>   run <path> as the server outright (default: mcp/dist/index.js)
  -h, --help        this
`);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { write: false, json: false, server: '', entry: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--write') out.write = true;
    else if (a === '--json') out.json = true;
    else if (a === '--server') out.server = argv[++i] ?? '';
    else if (a === '--entry') out.entry = argv[++i] ?? '';
    else throw new Error(`unknown argument ${JSON.stringify(a)} (try --help)`);
  }
  return out;
}
