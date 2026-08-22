#!/usr/bin/env node
// @ts-check
/**
 * `hooks/src/subagent-start.mjs` — the Codex entry point for `SubagentStart`.
 *
 * Two lines, and the order of them is the whole file.
 *
 * `lib/boot.mjs` synthesises `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and
 * `CLAUDE_PROJECT_DIR` — none of which Codex exports — and marks the host. The shared body
 * below resolves its configuration at **module scope**, so those writes have to have already
 * happened when it is evaluated. A static `import` of the body would be hoisted above the
 * shim's side effects and see none of them; `await import()` is the one form that runs after
 * the statements above it. Same idiom, same reason, as `mcp/src/launch.mjs` and its
 * `await import('./server.js')`.
 *
 * Reversing these two lines does not fail. The hook still runs, still exits 0, and writes
 * this project's memory into whatever directory the unset defaults happened to name.
 * `codex-boot.test.mjs` is what asserts the order.
 */

import './../../lib/boot.mjs';

await import('../../../claude-code/hooks/src/subagent-start.mjs');
