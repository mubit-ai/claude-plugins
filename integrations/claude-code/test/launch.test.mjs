// @ts-check
/**
 * `mcp/src/launch.mjs` — build-guide §8.3 (and §8.1 for the upstream allowlist patch).
 *
 * The launcher is bundled to `mcp/dist/index.js`, which is the `.mcp.json` entry point.
 * It exists for one reason: the MCP server reads its configuration from `process.env` at
 * MODULE SCOPE, and one of those reads has a poisoned default — in effect:
 *
 *     const DEFAULT_SESSION_ID = process.env.MUBIT_DEFAULT_SESSION_ID || "default";
 *
 * The literal `"default"` collapses every user, every project and every machine into a
 * single Mubit run. The launcher's job is to overwrite that with the same run id the
 * hooks derive, *before* importing the server — after the import it is too late, because
 * the constant has already been captured.
 *
 * These tests import the launcher in a child process with a module-resolution hook that
 * swaps `./server.js` for a stub. The stub snapshots `process.env` at the instant it is
 * evaluated, which is exactly the ordering guarantee under test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PLUGIN_ROOT, REPO_ROOT, makeDataDir, makeProjectDir, tempDir, baseEnv, lib } from './helpers/harness.mjs';

/** §8.2 — the curated ten, in the guide's order. */
const DEFAULT_ALLOWLIST = [
  'mubit_learned', 'mubit_recall', 'mubit_outcome', 'mubit_reflect', 'mubit_lessons',
  'mubit_diagnose', 'mubit_archive', 'mubit_dereference', 'mubit_forget', 'mubit_status',
];

// ---------------------------------------------------------------------------
// Child-process scaffolding
// ---------------------------------------------------------------------------

/** Prefer the source entry; fall back to the committed bundle (§11.2, §11.3). */
function launcherScript() {
  const src = join(PLUGIN_ROOT, 'mcp', 'src', 'launch.mjs');
  const dist = join(PLUGIN_ROOT, 'mcp', 'dist', 'index.js');
  if (existsSync(src)) return src;
  if (existsSync(dist)) return dist;
  return assert.fail(
    `mcp/src/launch.mjs does not exist yet (nor the bundled mcp/dist/index.js) under ${PLUGIN_ROOT}.\n` +
    '  Build-guide §8.3 defines it: loadConfig() → deriveRunId() → set env → await import("./server.js").');
}

const STUB_SERVER = `
// Stands in for the bundled @mubit-ai/mcp server. It records process.env at the exact
// moment the module is evaluated — i.e. everything the real server would read at module
// scope — and does nothing else.
//
// It also records the egress guard's marker. The guard is not an env var: it is a wrapper
// around globalThis.fetch, and "installed before the import" is the same ordering property
// the env vars have, for the same reason — the real server captures its transport at
// module scope, so a guard installed afterwards would never see a request.
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.MUBIT_TEST_ENV_SNAPSHOT, JSON.stringify({
  env: { ...process.env },
  guard: globalThis.fetch?.mubitEgressGuard ?? null,
}));
export function createServer() { return { tool() {}, connect: async () => {} }; }
export default { createServer };
`;

const LOADER_HOOKS = `
// Redirects the launcher's './server.js' import at the stub, so no real MCP server,
// stdio transport or network client is ever constructed.
let stubUrl = '';
export async function initialize(data) { stubUrl = data.stubUrl; }
export async function resolve(specifier, context, nextResolve) {
  if (/(?:^\\.{1,2}\\/|\\/)server\\.js$/.test(specifier)) {
    return { url: stubUrl, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;

const ENTRY = `
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register(
  pathToFileURL(process.env.MUBIT_TEST_HOOKS).href,
  import.meta.url,
  { data: { stubUrl: pathToFileURL(process.env.MUBIT_TEST_STUB).href } },
);
await import(pathToFileURL(process.env.MUBIT_TEST_LAUNCH).href);
// If the launcher leaves the loop alive (the real server would), stop after the import
// has been observed. Unref'd so a launcher that exits cleanly is not delayed.
setTimeout(() => process.exit(0), 1500).unref();
`;

/**
 * Run the launcher with a stubbed server.
 * @param {{extra?: Record<string,string>, projectDir?: string}} [o]
 * @returns {Promise<{code:number|null, stdout:string, stderr:string,
 *                    importedServer:boolean, envAtImport:Record<string,string>,
 *                    guardAtImport:any}>}
 */
async function runLauncher(o = {}) {
  const launch = launcherScript();
  const scaffoldDir = tempDir('mubit-cc-launch-');
  const stub = join(scaffoldDir, 'stub-server.mjs');
  const hooks = join(scaffoldDir, 'loader-hooks.mjs');
  const entry = join(scaffoldDir, 'entry.mjs');
  const snapshot = join(scaffoldDir, 'env-at-import.json');
  writeFileSync(stub, STUB_SERVER);
  writeFileSync(hooks, LOADER_HOOKS);
  writeFileSync(entry, ENTRY);

  const dataDir = makeDataDir();
  const projectDir = o.projectDir ?? makeProjectDir();
  const env = baseEnv({
    dataDir,
    projectDir,
    extra: {
      // What `.mcp.json` (§3.3) actually hands the launcher.
      MUBIT_CC_PROJECT_DIR: projectDir,
      MUBIT_CC_PLUGIN_ROOT: PLUGIN_ROOT,
      MUBIT_TEST_LAUNCH: launch,
      MUBIT_TEST_STUB: stub,
      MUBIT_TEST_HOOKS: hooks,
      MUBIT_TEST_ENV_SNAPSHOT: snapshot,
      ...(o.extra ?? {}),
    },
  });

  const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((res, rej) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); rej(new Error('launcher exceeded 15s')); }, 15000);
    child.on('close', (c) => { clearTimeout(t); res(c); });
    child.on('error', (e) => { clearTimeout(t); rej(e); });
  });

  const importedServer = existsSync(snapshot);
  const snap = importedServer ? JSON.parse(readFileSync(snapshot, 'utf8')) : {};
  const envAtImport = snap.env ?? {};
  const guardAtImport = snap.guard ?? null;
  return { code, stdout: out, stderr: err, importedServer, envAtImport, guardAtImport, env, projectDir };
}

/** The run id the hooks would derive for the same directory (§4.3). */
async function hookDerivedRunId(env) {
  const { loadConfig } = await lib('config.mjs');
  const { deriveRunId } = await lib('runid.mjs');
  return deriveRunId(loadConfig(env), {});
}

// ---------------------------------------------------------------------------
// §8.3 / §4.3 — the headline fix
// ---------------------------------------------------------------------------

// §4.3 — "The single most important rule here": MUBIT_DEFAULT_SESSION_ID must never
// reach the server as the literal "default". A leaked/ambient "default" in the parent
// environment is the realistic way this regresses, so it is seeded here on purpose.
test('never leaves MUBIT_DEFAULT_SESSION_ID as the literal "default"', async () => {
  const r = await runLauncher({ extra: { MUBIT_DEFAULT_SESSION_ID: 'default' } });
  assert.ok(r.importedServer,
    `the launcher never imported ./server.js. stderr:\n${r.stderr}`);
  assert.notEqual(r.envAtImport.MUBIT_DEFAULT_SESSION_ID, 'default',
    'MUBIT_DEFAULT_SESSION_ID was still "default" when the server was imported — that literal ' +
    'collapses every user, project and machine into one Mubit run (§4.3)');
  assert.ok((r.envAtImport.MUBIT_DEFAULT_SESSION_ID ?? '').length > 0,
    'MUBIT_DEFAULT_SESSION_ID must be set to a derived run id, not blanked');
});

// §8.3 step 2 — MCP verbs and hook captures must land in ONE run, which means the
// launcher derives the run id with the same strategy the hooks use.
test('sets MUBIT_DEFAULT_SESSION_ID to the run id the hooks derive for the same directory', async () => {
  const r = await runLauncher({ extra: { MUBIT_DEFAULT_SESSION_ID: 'default' } });
  const expected = await hookDerivedRunId(r.env);
  assert.equal(r.envAtImport.MUBIT_DEFAULT_SESSION_ID, expected,
    'the launcher must derive the run id with the same strategy as lib/runid.mjs so MCP-tool ' +
    'writes and hook captures share a run (§8.3)');
});

// §8.3 step 3 — the server reads env at MODULE scope. Setting any of these after the
// import is indistinguishable from not setting them at all.
test('sets every server env var BEFORE importing the server', async () => {
  const r = await runLauncher({
    extra: {
      MUBIT_ENDPOINT: 'http://127.0.0.1:34567',
      MUBIT_API_KEY: 'mbt_test_0123456789abcdef_deadbeefcafebabe0123456789abcdef',
      MUBIT_CC_USER_ID: 'eldar',
    },
  });
  assert.ok(r.importedServer, `the launcher never imported ./server.js. stderr:\n${r.stderr}`);

  const e = r.envAtImport;
  assert.equal(e.MUBIT_ENDPOINT, 'http://127.0.0.1:34567', 'MUBIT_ENDPOINT must be set before the import');
  assert.equal(e.MUBIT_API_KEY, 'mbt_test_0123456789abcdef_deadbeefcafebabe0123456789abcdef',
    'MUBIT_API_KEY must be set before the import');
  assert.equal(e.MUBIT_DEFAULT_USER_ID, 'eldar',
    'MUBIT_DEFAULT_USER_ID must carry cfg.userId into the server before the import (§8.3)');
  assert.ok((e.MUBIT_DEFAULT_SESSION_ID ?? '').length > 0, 'MUBIT_DEFAULT_SESSION_ID must be set before the import');
  assert.ok((e.MUBIT_MCP_TOOLS ?? '').length > 0, 'MUBIT_MCP_TOOLS must be set before the import (§8.1 reads it at module scope)');
});

// ---------------------------------------------------------------------------
// §8.3 — per-conversation cannot be honoured here
// ---------------------------------------------------------------------------

// §8.3 — an MCP server starts once per session and is never handed a hook payload, so
// there is no `session_id` to key `per-conversation` on. Falling back silently would
// split hook captures from MCP-tool writes with no way for the user to find out.
test('per-conversation falls back to per-directory and says so on stderr', async () => {
  const r = await runLauncher({
    extra: { MUBIT_CC_RUN_STRATEGY: 'per-conversation', MUBIT_DEFAULT_SESSION_ID: 'default' },
  });
  assert.ok(r.importedServer, `the launcher never imported ./server.js. stderr:\n${r.stderr}`);

  const perDirectory = await hookDerivedRunId({ ...r.env, MUBIT_CC_RUN_STRATEGY: 'per-directory' });
  assert.equal(r.envAtImport.MUBIT_DEFAULT_SESSION_ID, perDirectory,
    'with no session_id available the launcher must fall back to the per-directory run id (§8.3)');

  assert.match(r.stderr, /per-conversation/i,
    'the fallback must be logged — a silent fallback splits hook captures from MCP-tool writes (§8.3)');
  assert.match(r.stderr, /per-directory/i,
    'the warning must name what it fell back to, so the README guidance is actionable (§8.3)');
});

// ---------------------------------------------------------------------------
// §8.2 — the allowlist the launcher hands to the server
// ---------------------------------------------------------------------------

// §8.2 — blank config means the curated ten, not "all 21". The whole point of the
// allowlist is bounding the always-loaded context cost of the tool schemas (§3.5).
test('MUBIT_MCP_TOOLS defaults to the curated ten when mcpTools is blank', async () => {
  const r = await runLauncher({ extra: { MUBIT_MCP_TOOLS: '', CLAUDE_PLUGIN_OPTION_MCP_TOOLS: '' } });
  assert.ok(r.importedServer, `the launcher never imported ./server.js. stderr:\n${r.stderr}`);

  const got = String(r.envAtImport.MUBIT_MCP_TOOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual([...got].sort(), [...DEFAULT_ALLOWLIST].sort(),
    `MUBIT_MCP_TOOLS must default to the curated ten (§8.2), got: ${got.join(', ') || '(empty)'}`);
});

// §8.2 — "Users restore any of them with mcpTools / MUBIT_MCP_TOOLS." A user-supplied
// list must pass through verbatim, not be unioned with the default.
test('MUBIT_MCP_TOOLS honours a user-supplied allowlist verbatim', async () => {
  const r = await runLauncher({ extra: { MUBIT_MCP_TOOLS: 'mubit_recall, mubit_handoff' } });
  assert.ok(r.importedServer, `the launcher never imported ./server.js. stderr:\n${r.stderr}`);

  const got = String(r.envAtImport.MUBIT_MCP_TOOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(got, ['mubit_recall', 'mubit_handoff'],
    `a user-supplied allowlist must pass through unchanged (§8.2), got: ${got.join(', ')}`);
});

// §8.3 — the launcher itself is not a place to spend startup time or emit protocol
// noise: stdout on a stdio MCP server is the protocol channel.
test('the launcher writes nothing to stdout — stdout is the MCP protocol channel', async () => {
  const r = await runLauncher();
  assert.equal(r.stdout, '',
    `the launcher must keep stdout clean for the stdio transport, got: ${JSON.stringify(r.stdout)}`);
});

// ---------------------------------------------------------------------------
// §8.1 — the backwards-compatibility half of the upstream patch
// ---------------------------------------------------------------------------
//
// NOTE: these MIRROR tests that properly belong in `@mubit-ai/mcp`'s own suite, where the
// real `buildToolDefinitions()` and `createServer()` can be exercised. What is checkable
// from here is the plugin's side of the contract: the tool table the bundled server
// registers, and the documented filter semantics applied to it.
//
// The table is read from `mcp/dist/server.js` — the server this plugin ships and runs —
// rather than from the package's TypeScript source. That source is not part of the plugin:
// it lives outside `PLUGIN_ROOT`, so an installed copy does not contain it and these
// assertions failed in a published checkout on a missing file. Reading the bundle also
// tests the stronger claim, since the allowlist has to match what the *running* server
// registers, not what some source tree says it should.

/** The real tool names, straight out of the server bundle the plugin ships. */
function realToolNames() {
  const p = join(PLUGIN_ROOT, 'mcp', 'dist', 'server.js');
  assert.ok(existsSync(p), `mcp/dist/server.js is missing: ${p} — run \`npm run build\``);
  const names = [...readFileSync(p, 'utf8').matchAll(/name:\s*"(mubit_[a-z_0-9]+)"/g)].map((m) => m[1]);
  assert.ok(names.length > 0, 'could not parse tool names out of mcp/dist/server.js');
  return names;
}

/** The §8.1 filter, exactly as the patch specifies it. */
function applyAllowlist(names, rawEnvValue) {
  const list = (rawEnvValue || '').split(',').map((s) => s.trim()).filter(Boolean);
  const allow = list.length > 0 ? new Set(list) : null;
  return names.filter((n) => !allow || allow.has(n));
}

// §8.1 — the half that matters to every existing consumer: an UNSET allowlist must keep
// registering all 21 tools. A regression here silently removes tools from every non-plugin
// user of @mubit-ai/mcp.
test('[mirror of @mubit-ai/mcp tools suite] unset MUBIT_MCP_TOOLS registers all 21 tools', () => {
  const names = realToolNames();
  assert.equal(names.length, 21,
    `the bundled MCP server should register 21 tools (§1.9), parsed ${names.length}: ${names.join(', ')}`);
  assert.equal(applyAllowlist(names, undefined).length, 21, 'unset allowlist must register every tool');
  assert.equal(applyAllowlist(names, '').length, 21, 'empty allowlist must register every tool');
});

// §8.1 — and the half the plugin depends on: a two-name allowlist registers exactly two.
test('[mirror of @mubit-ai/mcp tools suite] a two-name allowlist registers exactly two tools', () => {
  const names = realToolNames();
  const got = applyAllowlist(names, 'mubit_recall,mubit_status');
  assert.deepEqual(got, ['mubit_recall', 'mubit_status'], 'a two-name allowlist must register exactly those two');
});

// §8.2 — and the curated ten must select ten of the twenty-one.
test('[mirror of @mubit-ai/mcp tools suite] the curated default allowlist selects ten of twenty-one', () => {
  const names = realToolNames();
  const got = applyAllowlist(names, DEFAULT_ALLOWLIST.join(','));
  assert.equal(got.length, 10, `curated allowlist selected ${got.length} tools: ${got.join(', ')}`);
  for (const n of DEFAULT_ALLOWLIST) {
    assert.ok(names.includes(n), `default allowlist names "${n}", which the bundled server does not register`);
  }
});

// §8.1 — whether the *shipped* server honours MUBIT_MCP_TOOLS at all.
//
// This replaces an assertion over `@mubit-ai/mcp`'s TypeScript source, which is not part of
// the plugin and cannot be read from an installed copy. Enforcement is that package's own
// business and is tested in its suite; what matters here is what the bundle in `mcp/dist`
// does, because that is the server a user actually runs.
//
// This assertion used to be two-sided — it checked only that `context-cost.json` *agreed*
// with whatever the bundle did, so it stayed green while the plugin shipped 21 tools where
// ten were configured, and was written to "flip on its own the day a patched @mubit-ai/mcp
// is bundled". That day came: the bundle is now built from the in-repo `@mubit-ai/mcp`
// (esbuild.config.mjs), so the accommodation is gone and the patch is simply required.
// A server that ignores the allowlist is a defect, not a state to be recorded faithfully.
test('the bundled server honours the allowlist, and context-cost.json says so', () => {
  const bundle = readFileSync(join(PLUGIN_ROOT, 'mcp', 'dist', 'server.js'), 'utf8');
  const defined = realToolNames();

  assert.match(bundle, /MUBIT_MCP_TOOLS/,
    'mcp/dist/server.js does not read MUBIT_MCP_TOOLS, so the allowlist is inert and every '
    + 'session pays for all 21 tool schemas (§8.1, §3.5).\n'
    + '  It is bundled from the in-repo @mubit-ai/mcp — rebuild both:\n'
    + '    npm --prefix ../mcp ci && npm --prefix ../mcp run build\n'
    + '    npm run build');

  const cost = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'scripts', 'context-cost.json'), 'utf8'));

  assert.equal(cost.allowlistHonoured, true,
    `context-cost.json records allowlistHonoured=${cost.allowlistHonoured}. Re-measure with `
    + '`node scripts/measure-context-cost.mjs --write`.');

  // `surface.registered` is the real `tools/list` answer, so under a blank `mcpTools` it is
  // the curated ten — not the 21 the bundle *defines*. Both facts are checked, because
  // "advertises ten" and "still carries all 21 for users who restore them" are separate
  // promises and only the first one bounds the context cost.
  assert.deepEqual(cost.surface?.registered, [...DEFAULT_ALLOWLIST].sort(),
    'context-cost.json was measured against a tool surface that is not the curated ten — '
    + 're-measure with `node scripts/measure-context-cost.mjs --write`');

  for (const name of cost.surface?.registered ?? []) {
    assert.ok(defined.includes(name),
      `context-cost.json records "${name}" as advertised, but mcp/dist/server.js does not define it`);
  }

  assert.equal(cost.breakdown?.toolSchemas?.count, DEFAULT_ALLOWLIST.length,
    `every session pays for ${DEFAULT_ALLOWLIST.length} tool schemas, but context-cost.json bills for `
    + `${cost.breakdown?.toolSchemas?.count}`);
});

// ---------------------------------------------------------------------------
// §8.3 — the egress guard, installed on the same schedule as the env
// ---------------------------------------------------------------------------

// The bundled server dials the endpoint itself: nothing in this repo sees the request, and
// the SDK inside it hard-codes `lesson_scope: "session"` on the one write tool a default
// install exposes — a scope the control plane reads across runs. The guard wraps
// `globalThis.fetch` to clamp that, and it is subject to the same ordering rule as every
// env var here: the server captures its transport at module scope, so a guard installed
// after the import would never see a single request.
test('installs the egress guard BEFORE importing the server', async () => {
  const r = await runLauncher();
  assert.ok(r.importedServer, `the launcher never imported ./server.js. stderr:\n${r.stderr}`);

  assert.ok(r.guardAtImport,
    'globalThis.fetch carried no egress guard when the server was imported — every MCP write '
    + 'then leaves this machine unexamined (§8.3)');
  assert.equal(r.guardAtImport.ceiling, 'run',
    'the default ceiling must be the run the write was made in');
  assert.equal(r.guardAtImport.pinRun, true,
    'a plugin-launched server must ignore a caller-supplied session_id — the launcher '
    + 'already derived the run, and a write that follows the caller elsewhere breaks the '
    + 'per-run boundary the run id exists to draw');
});

// §6.2 — the ceiling is a userConfig key, so it has to travel the same path as the rest of
// the config rather than being read out of the environment a second time inside the guard.
test('carries mcpLessonScope through to the guard', async () => {
  const r = await runLauncher({ extra: { MUBIT_MCP_LESSON_SCOPE: 'global' } });
  assert.ok(r.importedServer, `the launcher never imported ./server.js. stderr:\n${r.stderr}`);

  assert.equal(r.guardAtImport?.ceiling, 'global');
});

// The guard clamps to a run id, so it needs the same one the rest of the launcher published.
// If these two ever disagreed, a pinned write would land in a run the hooks never read.
test('the guard pins to the same run id the server was given', async () => {
  const r = await runLauncher({ extra: { MUBIT_DEFAULT_SESSION_ID: 'default' } });
  assert.ok(r.importedServer, `the launcher never imported ./server.js. stderr:\n${r.stderr}`);

  assert.equal(r.guardAtImport?.runId, r.envAtImport.MUBIT_DEFAULT_SESSION_ID,
    'the guard and the server must agree on which run this session writes into');
});
