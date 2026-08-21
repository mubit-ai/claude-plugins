# Ticket register — memory scope fixes

**All twelve are landed on `plugin-scope-fix`.** Final gates: plugin 1167/1167 (source and
dist), testkit 61/61, `verify-manifests` passed, dist a fixed point, `lab ux --check` exit 0 at
20 scenarios with hooks 13/13 · tools 10/10 · skills 8/8, and `lab preflight` green against
`api.mubit.ai` on all eight checks.

Four defects were found by *running* the work rather than testing it, and each has its own
commit: `lab preflight` exiting 0 having printed and checked nothing (an `unref()`d timer it
awaited); the sentinel read dialing a per-prompt budget it could not meet; the picker listing a
`/clear`ed project twice under one label; and the Tier 2 offer being answered permanently by a
single headless render. See `../W2-01-baseline-walk.md`, `../SC-08-e2e-walk.md` and
`integrations/claude-code/docs/manual-test-scope.md` for the measurements.

Twelve tickets derived from [`../SCOPE.md`](../SCOPE.md). Each file states the defect, the
exact call sites, the test that must go red first, and how to verify it green.

| ID | Title | SCOPE.md | Branch | Kind |
| --- | --- | --- | --- | --- |
| [SC-01](SC-01-kit-tests-its-own-worktree.md) | The kit must test the plugin in its own worktree | — (found while planning) | integration | fix |
| [SC-02](SC-02-split-the-recall-canary.md) | Split the recall canary: same-run blocks, cross-run informs | I1, §8.1–8.2 | `fix/testkit-canary-split` | fix |
| [SC-03](SC-03-stop-stamping-degraded.md) | Stop stamping `degraded: true` for the shipped configuration | §8.3 | `fix/testkit-canary-split` | fix |
| [SC-04](SC-04-unknown-run-strategy.md) | An unknown run strategy must not silently become the default | I6 | `fix/run-strategy-and-clear` | fix |
| [SC-05](SC-05-clear-says-what-it-did.md) | `/clear` says what it did, and the memory is recoverable | I5 | `fix/run-strategy-and-clear` | fix |
| [SC-06](SC-06-link-routes-and-ledger.md) | `link_run` / `unlink_run` routes and a local link ledger | Target C, §6 | `feat/link-run-routes` | feat |
| [SC-07](SC-07-read-the-link-graph.md) | Read the link graph: `include_linked_runs` on recall and reflect | Target C | `feat/link-run-routes` | feat |
| [SC-08](SC-08-subagents-link-automatically.md) | Tier 1 — subagents link automatically | I4, §6 Tier 1 | `feat/subagent-link` | feat |
| [SC-09](SC-09-the-link-surface.md) | Tier 3 — the `/mubit-memory:link` surface | §6 Tier 3 | `feat/link-command` | feat |
| [SC-10](SC-10-offer-a-link-on-same-remote.md) | Tier 2 — offer a link when a second repo shares a remote | §6 Tier 2 | `feat/link-offer` | feat |
| [SC-11](SC-11-bounded-scope-experiments.md) | Bounded scope experiments: B1, B3, and the ten stranded lessons | §5 B1/B3, I7 | integration | docs |
| [SC-12](SC-12-promotion-reads-the-wrong-counter.md) | Backend: promotion reads the wrong recurrence counter | I3 | integration | docs |

## Waves

Waves exist because of file overlap and real dependencies. Waves 2 and 3 consume
`lib/links.mjs` and the two routes wave 1 introduces.

```
wave 1   fix/testkit-canary-split   fix/run-strategy-and-clear   feat/link-run-routes
wave 2   feat/subagent-link         feat/link-command
wave 3   feat/link-offer
```

## Working protocol

Every ticket is implemented **test-first**, in two commits minimum.

1. **Red.** Write or invert the tests, run them, confirm they fail for the stated reason,
   commit with a message saying what the failure proves.
2. **Green.** Implement, run the full suite, commit.

House style is not optional — match `test/runid.test.mjs`: `// @ts-check`, `node:test` flat
`test()`, `node:assert/strict`, a `// §x.y:` comment above each test, a message on every
assertion naming the consequence, and **no mocking**. Real temp dirs via `makeDataDir()` /
`makeProjectDir()`, real loopback HTTP via `fakeMubit()`, env through `baseEnv()` / `withEnv()`
and never `process.env.X = …`. All from `test/helpers/harness.mjs`. Fake payloads come from
`test/helpers/fixtures.mjs`; credential-shaped strings come from its `SECRETS`.

## Environment: four things that will bite

1. **A fresh worktree cannot `npm install`.** `package.json` dev-depends on
   `"@mubit-ai/mcp": "file:../mcp"` and `integrations/mcp` does not exist in this repo. Copy
   instead:
   `cp -R /Users/eldaru/Mubit/pre-main/integrations/claude-code/node_modules <wt>/integrations/claude-code/`.
   Only needed to *build*; `npm test` uses `node:` builtins exclusively.
2. **Never run `npm run verify`.** Its `clean` is `rm -rf hooks/dist mcp/dist bin/impl`, and
   `mcp/dist/server.js` is a tracked 5.9 MB artefact this tree cannot regenerate. Recovery is
   `git checkout -- integrations/claude-code/mcp/dist`.
3. **`hooks/dist` is tracked and shipped.** Claude Code installs the plugin straight from
   GitHub with no build step, so any change under `hooks/src/` or `lib/` must be rebuilt and
   the rebuilt bundles committed. `MUBIT_CC_BUILD_SKIP_SERVER=1` is what lets the build run.
4. **`npm run version:check` and `test/release.test.mjs` do not exist** in this checkout,
   though `package.json` and `test/README.md` reference them. Mirror-shaped tree; not
   something to "fix".

## Verification

Per plugin branch, from `<worktree>/integrations/claude-code`:

```bash
npm test
npm run test:dist
node scripts/verify-manifests.mjs
MUBIT_CC_BUILD_SKIP_SERVER=1 npm run build
git diff --exit-code -- hooks/dist bin/impl mcp/dist   # dist freshness gate; commit if it moved
```

Per testkit branch, from `<worktree>/testkit`: `node bin/lab.mjs selftest`.
