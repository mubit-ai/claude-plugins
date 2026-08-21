// @ts-check
/**
 * What the model is actually handed — §8.1, §8.2, §3.5.
 *
 * Every other MCP test in this suite stubs the server out. `test/launch.test.mjs` swaps
 * `./server.js` for a module that snapshots `process.env`, which proves the launcher sets
 * `MUBIT_MCP_TOOLS` before the import — and proves nothing about whether anything reads it.
 * `test/manifests.test.mjs` reads tool names out of the bundle's *text*, which shows what is
 * **defined**, not what is **registered**. Between them there was no assertion that the
 * server a user runs answers `tools/list` with the ten tools the plugin configured, and a
 * server that ignored the allowlist entirely shipped past 650 green tests: 21 schemas
 * resident in every session, 5,382 tokens where 2,664 were declared.
 *
 * So this file speaks real stdio MCP to the committed `mcp/dist/index.js` and asserts the
 * surface itself. It is the only gate here that runs the shipped artifact end to end.
 *
 * Offline by construction — see `mcpListTools()` in `helpers/harness.mjs`. `tools/list` is
 * answered from the server's own table, so the endpoint is port 1 and nothing is dialled.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mcpListTools, PLUGIN_ROOT } from './helpers/harness.mjs';

/** §8.2 — the curated ten, in the guide's order. */
const DEFAULT_ALLOWLIST = [
  'mubit_learned', 'mubit_recall', 'mubit_outcome', 'mubit_reflect', 'mubit_lessons',
  'mubit_diagnose', 'mubit_archive', 'mubit_dereference', 'mubit_forget', 'mubit_status',
];

/**
 * The eleven §8.2 excludes: a hook already does the job better, or there is no Claude Code
 * surface for it at all. Named rather than derived, so this file states the contract
 * outright instead of restating whatever the server happens to register.
 */
const EXCLUDED = [
  'mubit_remember', 'mubit_context', 'mubit_checkpoint', 'mubit_memory_health',
  'mubit_register_agent', 'mubit_list_agents', 'mubit_step_outcome', 'mubit_ingest_status',
  'mubit_strategies', 'mubit_handoff', 'mubit_feedback',
];

/** The remedy every failure in this file shares. Stated once. */
const REMEDY = '\n  The shipped `mcp/dist/server.js` must be built from an @mubit-ai/mcp that reads\n'
  + '  MUBIT_MCP_TOOLS (§8.1). Rebuild it:\n'
  + '    npm --prefix ../mcp ci && npm --prefix ../mcp run build\n'
  + '    npm run build';

/** The remedy the three description gates share. */
const PROSE_REMEDY = '\n  Descriptions are authored in `../mcp/src/tools.ts` and reach this bundle through\n'
  + '  two builds — rewriting one without both leaves the shipped text unchanged:\n'
  + '    npm --prefix ../mcp run build\n'
  + '    npm run build';

/**
 * Phrases that tell a model *when* to act, rather than what the call does. Copied verbatim
 * from the surface probe that scores this plugin, so the gate and the score cannot disagree
 * about what counts as guidance.
 */
const TRIGGER = /\buse (this )?(tool )?(when|for|after|before|if)\b|\bcall (this|it) (when|after|before)\b|\bwhen (you|the user|a )\b/i;

/** Phrases that keep a model from reaching for a tool it should not. Same source. */
const NEGATIVE = /\bdo not\b|\bdon't\b|\bnever\b|\bavoid\b|\brather than\b|\binstead of\b|\bprefer\b|\bno need to\b/i;

/** The four advertised tools that all read from memory — the choice nobody was helped with. */
const RETRIEVAL = ['mubit_recall', 'mubit_lessons', 'mubit_diagnose', 'mubit_dereference'];

/**
 * The default surface, launched once and shared.
 *
 * Three tests below ask different questions of the same answer, and a 5.6 MB server bundle
 * costs ~120 ms to start — enough that four launches is a measurable slice of the suite's
 * ten-second budget. Nothing here mutates the result, so one launch is not a shortcut: it
 * IS the thing under test, examined three ways.
 */
let _default;
const defaultSurface = () => (_default ??= mcpListTools());

// §8.2 — a blank `mcpTools` means the curated ten. Not none, and not all 21.
test('tools/list advertises exactly the curated ten', async () => {
  const { names } = await defaultSurface();

  assert.deepEqual(names, [...DEFAULT_ALLOWLIST].sort(),
    `the server advertised ${names.length} tools, not the curated ten (§8.2).\n`
    + `  advertised: ${names.join(', ')}${REMEDY}`);
});

// §3.5 — the cost of getting this wrong, stated as the thing it costs: eleven tool schemas
// resident in every session, forever, for verbs a hook already covers.
test('none of the eleven excluded tools is advertised', async () => {
  const { names } = await defaultSurface();
  const leaked = EXCLUDED.filter((n) => names.includes(n));

  assert.deepEqual(leaked, [],
    `${leaked.length} tool(s) outside the allowlist are advertised, and every session pays `
    + `for their schemas: ${leaked.join(', ')} (§8.2, §3.5).${REMEDY}`);
});

// §8.2 — "Users restore any of them with mcpTools / MUBIT_MCP_TOOLS." A user-supplied list
// is used verbatim, not unioned with the default: "give me only mubit_recall" is a
// legitimate request and only a verbatim list can express it.
test('a user-supplied MUBIT_MCP_TOOLS is honoured verbatim', async () => {
  const { names } = await mcpListTools({ extra: { MUBIT_MCP_TOOLS: 'mubit_recall,mubit_status' } });

  assert.deepEqual(names, ['mubit_recall', 'mubit_status'],
    `a two-name allowlist must advertise exactly those two, got ${names.length}: `
    + `${names.join(', ')}${REMEDY}`);
});

// §8.1 — the same commit that added the allowlist stopped reporting a hardcoded
// serverInfo.version of "0.1.0" and read it from package.json instead. The literal is
// therefore a reliable tell that the bundle predates the patch, and `scripts/mcp-probe.mjs`
// already prints it as one. Asserting it here means the version and the behaviour cannot
// disagree about which server is bundled.
//
// Pinned to a version rather than to a literal, because the version travels a path with two
// places to lose it: the server reads `../package.json`, which does not exist once the bundle
// is relocated to `mcp/dist/server.js`, so the launcher inlines the value at build time and
// passes it in. "0.0.0-unpackaged" here means that hand-off broke — and it broke silently the
// first time, as a module-scope throw that killed the server before a single tool registered.
//
// The expected value comes from the plugin's own package.json, not the bundled server's,
// which lives outside PLUGIN_ROOT and is absent from a published checkout — the same trap
// `realToolNames()` in launch.test.mjs documents. The two are held equal at release time and
// asserted by manifests.test.mjs ('version lockstep'), so reading the local one costs nothing
// and works everywhere this test can run.
// §3.5 — `skills.test.mjs` already holds every SKILL.md to this bar: the description "is
// what the model reads when deciding whether to invoke the skill; it is always loaded and
// counts against contextCost, so it must actually describe the trigger". Tool descriptions
// are the same surface with a higher bill — ten of them, resident in every request of every
// session — and they were the one model-facing surface that never got the treatment: the
// audit scored 0 of 21 carrying a trigger, mean length 91 characters, all of them endpoint
// summaries. This asserts it on the artifact a user actually runs, not on the source, because
// the text reaches the model only if both builds carried it here.
test('every advertised tool description says WHEN to use it', async () => {
  const { tools } = await defaultSurface();
  const missing = tools.filter((t) => !TRIGGER.test(String(t.description ?? ''))).map((t) => t.name);

  assert.deepEqual(missing, [],
    `${missing.length} of ${tools.length} advertised descriptions carry no usage trigger: `
    + `${missing.join(', ')}.\n`
    + '  A description that restates the endpoint ("Search memories semantically with optional\n'
    + '  entry-type filtering") tells a model what the call does and nothing about when to make\n'
    + '  it. Write "Use when <situation>…" / "Use after <event>…" — and note that "Use this TO\n'
    + `  confirm…" does not count: the trigger must be when/for/after/before/if.${PROSE_REMEDY}`);
});

// The curated ten overlap: four of them read memory, two of them write a lesson, two of them
// score one. A trigger alone still leaves the model choosing between near-synonyms, so each
// must also say which neighbour to prefer or when calling it is wrong.
test('every advertised tool description says which tool to prefer, or when not to call it', async () => {
  const { tools } = await defaultSurface();
  const missing = tools.filter((t) => !NEGATIVE.test(String(t.description ?? ''))).map((t) => t.name);

  assert.deepEqual(missing, [],
    `${missing.length} of ${tools.length} advertised descriptions carry no negative condition: `
    + `${missing.join(', ')}.\n`
    + '  These ten are the entire surface a default install sees. Say which neighbour to prefer,\n'
    + '  or the case where this tool is the wrong one: "prefer …", "rather than …", "do not …",\n'
    + `  "never …".${PROSE_REMEDY}`);
});

// The sharpest case of the above, asserted by name rather than by regex: mubit_recall,
// mubit_lessons, mubit_diagnose and mubit_dereference are four restatements of "gets things
// out of memory". Unless each names one of the others, the choice between them is a coin toss.
test('the four retrieval tools disambiguate against each other by name', async () => {
  const { tools } = await defaultSurface();
  const byName = new Map(tools.map((t) => [t.name, String(t.description ?? '')]));
  const undisambiguated = RETRIEVAL.filter((name) => {
    const description = byName.get(name) ?? '';
    return !RETRIEVAL.some((other) => other !== name && description.includes(other));
  });

  assert.deepEqual(undisambiguated, [],
    `${undisambiguated.join(', ')} never names a sibling it competes with.\n`
    + '  recall is for topics, diagnose for errors, lessons for the catalogue, dereference for a\n'
    + `  reference_id you already hold — and only the descriptions can say so.${PROSE_REMEDY}`);
});

test('serverInfo reports the bundled server\'s real version', async () => {
  const { server } = await defaultSurface();
  const expected = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version;

  assert.equal(server?.name, 'mubit-memory', `unexpected server name: ${JSON.stringify(server)}`);
  assert.notEqual(server?.version, '0.1.0',
    'serverInfo.version is the "0.1.0" hardcode, which means the bundled server predates the '
    + `§8.1 patch and MUBIT_MCP_TOOLS is inert.${REMEDY}`);
  assert.equal(server?.version, expected,
    `serverInfo.version is "${server?.version}", but this plugin is ${expected} and the two `
    + 'ship in lockstep. The launcher inlines the version at build time (esbuild.config.mjs '
    + 'defines __MUBIT_MCP_VERSION__) and hands it over as MUBIT_MCP_VERSION — rebuild with '
    + '`npm run build`.');
});
