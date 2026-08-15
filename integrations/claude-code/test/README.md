# Test suite — `mubit-memory`

**These tests were written before the implementation**, so the suite reads as a specification
rather than as a regression net: every failure names the file that does not exist yet, or the
manifest key that drifted, and says what defines it.

Each file is independently runnable and the whole suite finishes in well under ten seconds,
so the red-green loop stays tight.

The `§` references throughout are sections of the plugin's design guide, which is not part of
this distribution. They are there to say *why* an assertion exists; the assertions themselves
stand on their own.

## Running

```bash
cd integrations/claude-code

node --test 'test/*.test.mjs'     # everything
node --test test/redact.test.mjs  # one gate

MUBIT_CC_TEST_TARGET=dist node --test 'test/*.test.mjs'   # against the shipped bundles
```

Quote the glob so Node expands it. `node --test test/` fails before `package.json` exists —
Node treats the bare directory as a module path.

By default, hook tests run `hooks/src/*.mjs` so you can iterate without rebuilding. Run once
against `dist` before you commit — `hooks.json` points at `dist`, and a stale bundle is a bug
that only shows up in a real session.

No framework, no dependencies, no network, no Docker, no real Mubit. `node:test` and
`node:assert/strict`. The whole suite must stay under ~10 seconds.

## Gate map

| File | Covers |
|---|---|
| `manifests.test.mjs` | manifests as data, version lockstep, allowlist ↔ the shipped MCP tool table |
| `state.test.mjs` | paths, atomic JSON, TTL pruning, markers, redacted logging |
| `config.test.mjs` | precedence, loopback detection, env tags, frozen defaults |
| `runid.test.mjs` | four strategies, the `source` table, never `"default"` |
| `redact.test.mjs` | patterns, denylist, caps, scrub-before-cap, self-reference |
| `breaker.test.mjs` | five states, "a timeout is not a verdict", half-open |
| `http.test.mjs` | pre-flight guards, never-throws, retry policy |
| `spool.test.mjs` | file-per-item under concurrency, lock stealing, `claimOnce` |
| `classify.test.mjs` | tool → intent table, never `unclassified`, lesson templates |
| `hook.test.mjs` | exit-code discipline, budgets, `spawnDetached` |
| `capture.test.mjs` | four modes, zero HTTP, one spool file, stable `item_id` |
| `stage-prompt.test.mjs` | turn staging, the write race with `prompt-recall` |
| `drain.test.mjs` | batching, the 2xx/5xx/4xx split, idempotency |
| `session-start.test.mjs` | the `source` table, sub-budgets, the offline steer block |
| `assemble.test.mjs` | section mapping and order, budget, `sourceRefIds` |
| `prompt-recall.test.mjs` | the three-rung ladder, policy cache, the `context` absence |
| `attribution.test.mjs` | `reference_id` → `entry_ids` end to end |
| `checkpoint.test.mjs` | redacted snapshot, spooled anchor, visible failure |
| `session-end.test.mjs` | the required reflect, once-marker, best-effort ordering |
| `statusline.test.mjs` | network-free, glyph precedence, empty-state survival |
| `launch.test.mjs` | run-id derivation, env-before-import, allowlist default |
| `skills.test.mjs` | frontmatter, tool prefixes, load-bearing prose |
| `failure.test.mjs` | F1–F29, the cross-cutting failure surface |

## `failure.test.mjs` is the important one

The build guide says to write it first, and the reason generalises: the happy path is a handful
of assertions, but the failure surface is where the bugs live and it decides whether anyone
keeps the plugin installed.

Roughly a third of the whole suite exists to pin facts that are counter-intuitive enough that a
reasonable person would "fix" them in the wrong direction:

- **A 403 on the recall hook's first call is not a failure.** It is a policy verdict — cache it,
  descend the ladder, and leave the breaker and `auth_failed` untouched.
- **A timeout is not a verdict.** One `AbortError` changes no state.
- **A 401 must not open the breaker.** Hiding it behind a cooldown hides the only error the
  user can fix.
- **`claimOnce` returns `true` when it fails.** Losing a batch is worse than sending it twice.
- **The recall hook must never call `/v2/control/context` by default.** That call costs two LLM
  calls per prompt; the absence is asserted explicitly.

When one of those fails, re-read the guide section cited in the comment above it before
changing the assertion.

## The harness

`helpers/harness.mjs` — read it before writing a test.

- `makeDataDir()` — a fresh `${CLAUDE_PLUGIN_DATA}` with the §7 skeleton.
- `makeProjectDir({git, branch, files})` — a real git repo when a run-id strategy needs one.
- `baseEnv({dataDir, endpoint, apiKey, extra})` — a fully pinned environment, so no test
  depends on your shell.
- `fakeMubit(routes)` — a `node:http` server on port 0 with canned replies, per-call arrays,
  `delayMs`, `hang`, and `assertCalled` / `assertNotCalled`. Unrouted requests are recorded and
  404'd, so "the hook called something it should not have" is always visible.
- `runHook(name, payload, opts)` — spawns a hook the way Claude Code does: fresh process, JSON
  on stdin, JSON on stdout.
- `assertHookContract(result)` — exit 0, stdout empty or parseable. True in every mode,
  including every failure mode.
- `lib('config.mjs')` / `mod('bin/statusline.src.mjs')` — cache-busting imports that fail with a
  pointed message when the module has not been written yet.

`fakeMubit()` unrefs its listening socket, so a test that fails before reaching
`await server.close()` cannot keep the process alive and hang the run. That matters more than
it sounds in a suite where every test fails by design. Closing the server explicitly — via
`t.after(() => server.close())` — is still the better habit, since it frees the port
immediately rather than at process exit.

`helpers/fixtures.mjs` holds the recorded stdin payloads and a `SECRETS` bundle of
realistic-but-fake credentials for the redaction tests. Use those rather than inventing new
credential-shaped strings.

## House rules

- Table-drive anything the guide gives as a table, one assertion per row.
- Comment each test with the guide section it protects.
- Never sleep for real windows. Shrink them with `MUBIT_CC_BREAKER_*`, `MUBIT_CC_BATCH_*`, and
  friends.
- Skip permission-based tests when running as root (`process.getuid?.() === 0`) — root ignores
  the mode bits those tests depend on.
