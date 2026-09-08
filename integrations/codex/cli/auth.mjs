#!/usr/bin/env node
// @ts-check
/**
 * `cli/auth.mjs` — the Codex entry point `bin/auth.mjs` is built from.
 *
 * Same two lines, same order, same reason as `hooks/src/*.mjs`: `lib/boot.mjs` declares
 * `MUBIT_CC_HOST=codex` and synthesises the three `CLAUDE_*` names, and the shared body
 * resolves its configuration at module scope, so the shim has to have run first. A skill runs
 * this bundle from a plain shell that carries none of that environment — which is why a bin
 * built straight from the shared source ran as a Claude Code process on a Codex machine.
 *
 * `main` is re-exported so the bundle stays inert on import: the shared body's own entry
 * guard compares `process.argv[1]` with its `import.meta.url`, which in the bundle is this
 * file's output path, so it runs when executed and not when imported. The two constants ride
 * along because `test/prod-defaults.test.mjs` next door reads the compiled-in console and
 * gateway off this bundle — the one place a non-production default would ship unnoticed.
 */

import '../lib/boot.mjs';

const shared = await import('../../claude-code/bin/auth.src.mjs');
export const { main, CONSOLE_URL, DEFAULT_ENDPOINT } = shared;
