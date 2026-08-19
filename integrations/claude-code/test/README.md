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

npm run test:dist                 # everything, against the shipped bundles
```

Quote the glob so Node expands it. `node --test test/` fails before `package.json` exists —
Node treats the bare directory as a module path.

By default, hook tests run `hooks/src/*.mjs` so you can iterate without rebuilding:
`runHook()` resolves `hooks/src/<name>.mjs` unless `MUBIT_CC_TEST_TARGET=dist` (or a per-call
`target: 'dist'`) redirects it at the bundle `hooks/hooks.json` actually points at.

`npm run test:dist` is that redirect, and it is now **enforced rather than a habit**:
`.github/workflows/claude-code-plugin-ci.yml` runs it as its own step, downstream of the
rebuild and the `git diff --exit-code` freshness gate, so the bundles under test are provably
byte-identical to what a marketplace fetch hands a user. The freshness gate alone only proves
the artifacts were *built* from this source — esbuild can emit a bundle that Node then refuses
to import, and the diff stays clean. `release.test.mjs` asserts that CI step exists, and
resolves the script name out of `package.json`, so use the script rather than retyping the env
var: that is what keeps this file and CI from drifting into two spellings.

Still worth running locally before you commit. It costs ~6 s, and CI is the backstop, not the
first line of defence.

No framework, no dependencies, no Docker, no real Mubit, and no network beyond loopback:
`fakeMubit()` is a real `node:http` server on `127.0.0.1:0` and hooks are real subprocesses
dialling it, so the client stack under test is the whole client stack. Nothing is monkey-patched
and nothing reaches the internet. `node:test` and `node:assert/strict`. The whole suite must stay
under ~10 seconds.

## Gate map

| File | Covers |
|---|---|
| `manifests.test.mjs` | manifests as data, version lockstep, allowlist ↔ the shipped MCP tool table |
| `mcp-surface.test.mjs` | real stdio `tools/list` against `mcp/dist/` — the allowlist as the model sees it |
| `state.test.mjs` | paths, atomic JSON, TTL pruning, markers, redacted logging |
| `config.test.mjs` | precedence, loopback detection, env tags, frozen defaults |
| `credentials.test.mjs` | the 0600 store, merge-not-replace, never throws |
| `auth.test.mjs` | the key ladder, PKCE + loopback, the four outcomes |
| `runid.test.mjs` | four strategies, the `source` table, never `"default"` |
| `redact.test.mjs` | patterns, denylist, caps, scrub-before-cap, self-reference |
| `breaker.test.mjs` | five states, "a timeout is not a verdict", half-open |
| `http.test.mjs` | pre-flight guards, never-throws, retry policy |
| `spool.test.mjs` | file-per-item under concurrency, lock stealing, `claimOnce` |
| `classify.test.mjs` | tool → intent table, never `unclassified`, lesson templates |
| `outcome.test.mjs` | the implicit outcome rule as a pure decision: the four cases, measured-`false` vs unmeasured, the derived key |
| `hook.test.mjs` | exit-code discipline, budgets, `spawnDetached` |
| `capture.test.mjs` | four modes, zero HTTP, one spool file, stable `item_id`, the Stop used-signal |
| `stage-prompt.test.mjs` | turn staging, the write race with `prompt-recall` |
| `pre-tool.test.mjs` | the rule store and its term matching, and — the load-bearing one — that **no path denies**: no `permissionDecision`, no `updatedInput`, exit 0, zero HTTP |
| `drain.test.mjs` | batching, the 2xx/5xx/4xx split, idempotency, "ignored" vs "not injected" |
| `session-start.test.mjs` | the `source` table, sub-budgets, the offline steer block |
| `assemble.test.mjs` | section mapping and order, budget, `sourceRefIds` |
| `prompt-recall.test.mjs` | the three-rung ladder, policy cache, the `context` absence, the staged turn |
| `attribution.test.mjs` | `reference_id` → `entry_ids` end to end |
| `checkpoint.test.mjs` | redacted snapshot, spooled anchor, visible failure |
| `session-end.test.mjs` | the required reflect, once-marker, best-effort ordering, one outcome rule shared with `drain` |
| `statusline.test.mjs` | network-free, glyph precedence, empty-state survival |
| `launch.test.mjs` | run-id derivation, env-before-import, allowlist default |
| `skills.test.mjs` | frontmatter, tool prefixes, load-bearing prose |
| `release.test.mjs` | release wiring, committed `dist`, the shipped licence |
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
- **The `PreToolUse` hook must never deny, and exit 2 is a deny.** The host blocks the tool call
  on exit code 2 and lets every *other* non-zero code through, so the dangerous value is the one
  a naive error handler picks. `pre-tool.test.mjs` enumerates paths — flag off, empty store,
  corrupt store, unparseable stdin, underivable run id, unwritable data dir — and asserts exit 0
  and the absent keys on each, then greps the built bundle for the same, because the paths a test
  cannot reach are the ones the guarantee has to cover too.

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

- **Which entry point a runner picks is not uniform, and the four rules are deliberate — say
  which one you are following when you add a runner.** `runHook()` takes `src` and is redirected
  wholesale by `MUBIT_CC_TEST_TARGET`, because a hook bundle is a faithful build of its source
  and either can answer most questions. `statusline.test.mjs` prefers the built
  `bin/statusline.mjs` and falls back to `src`. `launch.test.mjs` prefers `mcp/src/launch.mjs`
  and falls back to `dist`. `mcp-surface.test.mjs` is dist-only and hard-errors without the
  bundle — the *registered* tool table exists nowhere but the shipped server, which is how B1
  shipped past a green suite.
- Table-drive anything the guide gives as a table, one assertion per row.
- Comment each test with the guide section it protects.
- Never sleep for real windows. Shrink them with `MUBIT_CC_BREAKER_*`, `MUBIT_CC_BATCH_*`, and
  friends.
- Skip permission-based tests when running as root (`process.getuid?.() === 0`) — root ignores
  the mode bits those tests depend on.
