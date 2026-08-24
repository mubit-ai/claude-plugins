// @ts-check
/**
 * `mcp/src/launch.mjs` — the `.mcp.json` entry point, bundled to `mcp/dist/index.js` (§8.3).
 *
 * The upstream server reads its whole configuration at MODULE scope:
 *
 *     const DEFAULT_SESSION_ID = process.env.MUBIT_DEFAULT_SESSION_ID || "default";
 *
 * Two consequences shape this file.
 *
 * **Ordering is a correctness property, not a style.** Every `process.env` write below
 * happens before `await import('./server.js')`; setting any of them afterwards is
 * indistinguishable from not setting them at all, because the constants have already been
 * captured. That is why there is a launcher at all rather than a richer `.mcp.json`.
 *
 * The same rule governs the two things here that are not environment variables. The egress
 * guard wraps `globalThis.fetch` and the instructions guard wraps `process.stdout.write`;
 * the server captures both handles as it starts, so either one installed after the import
 * would sit on a handle nobody is holding.
 *
 * **The literal `"default"` is what this replaces.** It is the bundled server's placeholder
 * `session_id`, and it identifies no project. This launcher derives the run id with **the
 * same strategy the hooks use** (`lib/runid.mjs`), which is what makes an MCP-tool write and
 * a hook capture land in one run — one query then returns evidence from both. If the two
 * derivations diverged, `/mubit-memory:remember` would save into a run that pre-prompt recall
 * never reads.
 *
 * Runs its work at module scope on purpose: `.mcp.json` executes this file as the entry
 * point, and the launch tests import it directly. An `import.meta.url === process.argv[1]`
 * guard would make it a no-op under the second.
 *
 * stdout belongs to the stdio MCP transport. Nothing here may write to it; diagnostics go
 * to stderr and to the ring log.
 */

import { loadConfig } from '../../lib/config.mjs';
import { log } from '../../lib/log.mjs';
import { redactText } from '../../lib/redact.mjs';
import { deriveRunId } from '../../lib/runid.mjs';
import { installFetchGuard, resolveCeiling } from './egress.mjs';
import { INSTRUCTIONS, installInstructionsGuard } from './instructions.mjs';

/**
 * §8.2 — thirteen of the server's twenty-one tools, in the guide's order.
 *
 * A blank `mcpTools` means this curated set, never "none" and never all 21: the eight
 * excluded verbs are ones a hook already does better (`mubit_remember`, `mubit_context`)
 * or that have no Claude Code surface at all (`mubit_register_agent`, `mubit_list_agents`
 * and the rest of the multi-agent orchestration group). Nothing is removed — users restore
 * any of them through `mcpTools` / `MUBIT_MCP_TOOLS`.
 *
 * The last three arrived later, and each was excluded for a reason that turned out not to
 * hold.
 *
 * `mubit_checkpoint` was listed here as work a hook already did better. It is not the same
 * work. The `PreCompact` hook checkpoints on the host's schedule — when the window fills —
 * which is precisely the moment nobody can ask for. "Save where we are before I try this"
 * is a decision a person makes, and there was no way to express it. The hook and the tool
 * are the involuntary and the voluntary halves of one thing, not two paths to one.
 *
 * `mubit_strategies` reads the pattern *across* many lessons. Every retrieval verb above it
 * reads individual ones, so this was not a duplicated lane; it was a lane nobody opened.
 *
 * `mubit_memory_health` was excluded while `skills/doctor/SKILL.md` told its reader to
 * `POST /v2/control/memory_health` by hand at step 3. Withholding the tool never removed
 * the need for the route — it only moved the call off the tool surface and into prose.
 *
 * Each of the three ships with a skill (`strategies`, `checkpoint`, `memory-health`): an
 * allowlisted tool with nothing to invoke it is schema cost without a surface, which is the
 * failure the curation exists to prevent.
 *
 * `lib/config.mjs` carries the same list; this copy is the launcher's floor for the case
 * where config resolution hands back an empty list.
 */
export const DEFAULT_ALLOWLIST = [
  'mubit_learned', 'mubit_recall', 'mubit_outcome', 'mubit_reflect', 'mubit_lessons',
  'mubit_diagnose', 'mubit_archive', 'mubit_dereference', 'mubit_forget', 'mubit_status',
  'mubit_strategies', 'mubit_checkpoint', 'mubit_memory_health',
];

/**
 * §3.3 hands three values over under `MUBIT_CC_*` names that `lib/` reads under their host
 * names. Nothing else in the plugin reads the `MUBIT_CC_*` spellings, so without this
 * bridge `.mcp.json` passes the project directory to a launcher that then falls back to
 * `process.cwd()` — and a wrong project directory is a wrong run id, which is the exact
 * failure this file exists to prevent.
 */
const BRIDGED = [
  ['MUBIT_CC_PROJECT_DIR', 'CLAUDE_PROJECT_DIR'],
  ['MUBIT_CC_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT'],
  ['MUBIT_CC_DATA_DIR', 'CLAUDE_PLUGIN_DATA'],
];

/** A `.mcp.json` value the host never expanded, e.g. the literal `${MUBIT_ENDPOINT}`. */
const UNEXPANDED = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/**
 * The bundled server's own version, inlined from the `@mubit-ai/mcp` manifest at build time
 * (`esbuild.config.mjs` defines `__MUBIT_MCP_VERSION__`).
 *
 * The server reads its version with `require("../package.json")`, which resolves inside its
 * own package and not inside ours: bundled to `mcp/dist/server.js`, `../package.json` is a
 * file that does not exist, and the require throws at module scope before any tool
 * registers. Reading the file here at runtime would only move the same guess; the build
 * knows the answer exactly, because it is the package it just bundled.
 *
 * Empty when this file is run unbundled — the launch tests import the source directly, and
 * the server's own in-package read is correct there anyway.
 */
// @ts-ignore — the name is not declared anywhere: esbuild substitutes a string literal for
// it at build time, and `typeof` is the one operator that is safe on a name that genuinely
// is not there when this file runs as source.
const SERVER_VERSION = typeof __MUBIT_MCP_VERSION__ === 'string' ? __MUBIT_MCP_VERSION__ : '';

if (prepare(process.env)) {
  // §8.3 step 4. Every module-scope read the server makes now sees a resolved value.
  await import('./server.js');
}

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

/**
 * Resolve config, derive the run id, and publish both into `env`.
 *
 * @param {Record<string, string|undefined>} env  `process.env`, mutated in place
 * @returns {boolean} whether the server may be imported
 */
function prepare(env) {
  /** @type {Record<string, any>} */
  let cfg;
  try {
    dropUnexpanded(env);
    bridgeHostVars(env);
    cfg = loadConfig(env);
  } catch (err) {
    // Guessing at an endpoint or a data directory would write this project's memory
    // somewhere the user never chose. Refusing to start is the honest failure.
    refuse(`could not resolve configuration: ${describe(err)}`);
    return false;
  }

  /** @type {string} */
  let runId;
  try {
    runId = deriveRunId(runConfig(cfg), {});
  } catch (err) {
    // `lib/runid.mjs` throws rather than answer `"default"` — an unset `static` pin is the
    // realistic case. Starting anyway would hand the server the poisoned literal and pool
    // this project's memory with every other consumer's, which is worse than no server:
    // the hooks in the same session fail the same derivation and capture nothing, so the
    // MCP writes would be the only thing landing, and landing in the wrong place.
    refuse(`could not derive a run id: ${describe(err)}`);
    return false;
  }

  const tools = allowlist(cfg);

  // §8.3 step 3 — all five, before the import.
  env.MUBIT_ENDPOINT = String(cfg.endpoint ?? '');
  env.MUBIT_API_KEY = String(cfg.apiKey ?? '');
  env.MUBIT_DEFAULT_SESSION_ID = runId;
  env.MUBIT_DEFAULT_USER_ID = String(cfg.userId ?? '');
  env.MUBIT_MCP_TOOLS = tools.join(',');
  if (SERVER_VERSION) env.MUBIT_MCP_VERSION = SERVER_VERSION;

  // The sixth thing that has to be in place before the import, and the only one that is not
  // an environment variable. The bundled server dials the endpoint itself with global
  // `fetch` and captures its transport at module scope, so this is subject to exactly the
  // ordering rule above: installed afterwards, it would never see a request.
  //
  // `pinRun: true` because this server was launched by the plugin, which already derived
  // the run — the same `runId` published on the line above, so the guard and the server
  // cannot disagree about which run this session writes into. Without it, a caller-supplied
  // `session_id` would decide that instead.
  const ceiling = resolveCeiling(cfg.mcpLessonScope);
  installFetchGuard({ ceiling, runId, pinRun: true });

  // And the seventh. Under tool search the host loads only tool *names* and the server's
  // `instructions` field at session start, and a subagent sees neither the SessionStart
  // steer block nor per-turn recall — so for both, this string is the only statement of when
  // Mubit is worth reaching for. The bundled server cannot supply it (`createServer()` is
  // `new McpServer({name, version})` with no options object, and no env var feeds the
  // field), so the launcher fills it into the outbound `initialize` frame. Same ordering
  // rule as the guard above, and for the same reason: `StdioServerTransport` takes
  // `process.stdout` as a constructor default and holds it from then on.
  installInstructionsGuard({ instructions: INSTRUCTIONS });

  log(cfg, 'info', 'mcp: starting server', {
    run_id: runId, endpoint: cfg.endpoint, mode: cfg.mode, tools: tools.length,
    lesson_scope: ceiling, pin_run: true, instruction_chars: INSTRUCTIONS.length,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Run strategy
// ---------------------------------------------------------------------------

/**
 * The config to derive the run id from.
 *
 * `per-conversation` is the one strategy a launcher cannot honour: an MCP server starts
 * once per session and is never handed a hook payload, so there is no `session_id` to key
 * on. Falling back is the only option, but falling back *silently* would split hook
 * captures from MCP-tool writes with no way for the user to find out — so it says so on
 * stderr, which Claude Code surfaces in the MCP server log.
 *
 * @param {Record<string, any>} cfg
 * @returns {Record<string, any>}
 */
function runConfig(cfg) {
  if (String(cfg.runStrategy ?? '').trim() !== 'per-conversation') return cfg;

  note('mubit: runStrategy "per-conversation" cannot be honoured by the MCP server — it '
    + 'starts once per session and is never handed a session_id. Falling back to '
    + '"per-directory" for MCP-tool writes. Hook captures still key on the conversation, so '
    + 'the two land in different runs; use "per-directory" (the default) to keep them together.');
  log(cfg, 'warn', 'mcp: per-conversation is unavailable in the launcher; using per-directory');

  return { ...cfg, runStrategy: 'per-directory' };
}

/**
 * §8.2 — `cfg.mcpTools`, or the curated ten. A user-supplied list passes through verbatim
 * rather than being unioned with the default: "restore `mubit_handoff`" and "give me only
 * `mubit_recall`" are both legitimate, and only a verbatim list expresses the second.
 *
 * @param {Record<string, any>} cfg
 * @returns {string[]}
 */
function allowlist(cfg) {
  const list = Array.isArray(cfg.mcpTools)
    ? cfg.mcpTools.map((t) => String(t).trim()).filter(Boolean)
    : [];
  return list.length ? list : [...DEFAULT_ALLOWLIST];
}

// ---------------------------------------------------------------------------
// Environment hygiene
// ---------------------------------------------------------------------------

/**
 * Drop `MUBIT_*` / `CLAUDE_*` values that are still an unexpanded `${VAR}` placeholder.
 *
 * §3.3 passes values through unexpanded on purpose and leaves the defaulting to this file,
 * but expansion semantics for `.mcp.json` env values are not documented well enough to rely
 * on. An endpoint of the literal `"${MUBIT_ENDPOINT}"` is not a config value, it is a
 * failed substitution — and treating it as absent gets the documented default instead of a
 * connection error the user cannot read.
 *
 * @param {Record<string, string|undefined>} env
 */
function dropUnexpanded(env) {
  for (const key of Object.keys(env)) {
    if (!key.startsWith('MUBIT_') && !key.startsWith('CLAUDE_')) continue;
    if (UNEXPANDED.test(String(env[key] ?? ''))) delete env[key];
  }
}

/**
 * Fill each host variable from its `MUBIT_CC_*` twin when the host did not set it itself.
 * Never overwrites: a value Claude Code set directly is the more authoritative of the two.
 *
 * @param {Record<string, string|undefined>} env
 */
function bridgeHostVars(env) {
  for (const [from, to] of BRIDGED) {
    const value = String(env[from] ?? '').trim();
    if (value && !String(env[to] ?? '').trim()) env[to] = value;
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * One line to stderr. Never stdout: on a stdio transport that channel carries the protocol,
 * and one stray byte makes the server unparseable to the host.
 * @param {string} msg
 */
function note(msg) {
  try { process.stderr.write(`${msg}\n`); } catch { /* a lost diagnostic is not a failure */ }
}

/**
 * Decline to start, and say why. `process.exitCode` rather than `process.exit()` so the
 * stderr line above is flushed on the way out instead of truncated.
 * @param {string} why
 */
function refuse(why) {
  note(`mubit: MCP server not started — ${why}`);
  process.exitCode = 1;
}

/**
 * An error's message, scrubbed. Nothing here is expected to carry a credential, but stderr
 * from an MCP server lands in the host log — the one artefact users paste into issues.
 * @param {unknown} err
 * @returns {string}
 */
function describe(err) {
  const raw = err instanceof Error ? err.message : String(err);
  return redactText(raw, { redact: true }, 'output').text;
}
