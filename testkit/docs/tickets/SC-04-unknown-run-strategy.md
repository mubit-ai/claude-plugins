# SC-04 — an unknown run strategy must not silently become the default

**Branch:** `fix/run-strategy-and-clear` · **Worktree:** `/Users/eldaru/Mubit/scope-runid`
**Kind:** fix · **SCOPE.md:** I6

## The defect

`integrations/claude-code/lib/runid.mjs:702-706`:

```js
function normaliseStrategy(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return STRATEGIES.has(s) ? s : DEFAULT_STRATEGY;
}
```

Anything unrecognised becomes `per-directory` with no error and no log.

`testkit/ux/scenarios/W2-02-branch-switch.md:18` sets `MUBIT_CC_RUN_STRATEGY=repo`. `repo` is
not a strategy — `runid.mjs:53` allows only `per-directory`, `git-branch`, `per-conversation`
and `static`. So the scenario has been running under `per-directory`, where a branch switch
does **not** change the run id, and it would have passed while proving the exact opposite of
its own claim.

## The change — plugin

**Keep the fallback.** Throwing would break a live session on a typo, and the run id is
load-bearing for every hook. But emit **one** `warn` through `lib/log.mjs` naming the value
received and the four legal strategies.

Contrast with `staticRunId` (`:204-227`), which *does* throw when the pin is missing — and is
right to: there is no honest answer there, whereas here there is a documented default. The
new warning is what makes the difference visible instead of silent.

Two details that matter:

- **Warn once, not per call.** `normaliseStrategy` is on the path of every `deriveRunId`, and
  `deriveRunId` is called by every hook. A warning per invocation would be noise in the ring
  log and could itself cost budget. Warn only when the value is non-empty and unrecognised —
  an unset `runStrategy` is the ordinary case and must stay silent.
- `normaliseStrategy` currently takes no `cfg`, and `log()` needs one. Thread it, or move the
  warning to the one caller that has a `cfg` in hand (`resolveRunId`). Prefer whichever keeps
  `normaliseStrategy` a pure function.

## The change — testkit

- `testkit/ux/scenarios/W2-02-branch-switch.md:18` — `repo` → `git-branch`.
- The same file's Known-not-bugs at `:56-57` currently names `repo` as a real strategy.
  Rewrite it to say what was actually true: the scenario was configured with a value that is
  not a strategy, silently fell back to `per-directory`, and would have passed while
  demonstrating the opposite of its claim.

## Tests (red first)

`test/runid.test.mjs` already has the four-strategy table. Add:

- an unrecognised strategy still resolves to `per-directory` (the fallback is deliberate and
  must not regress);
- an unrecognised strategy **logs a warning** naming both the bad value and the legal set —
  this is the assertion that is red today;
- an unset / empty strategy logs nothing.

Read the log through the plugin's real log sink (a temp data dir plus `MUBIT_CC_LOG_LEVEL`),
not by stubbing `log`. `test/helpers/harness.mjs` has `makeDataDir()` and `baseEnv()`; check
how the existing log-assertion tests in this suite read the ring log and follow them.

## Verification

```bash
cd <worktree>/integrations/claude-code
npm test && npm run test:dist && node scripts/verify-manifests.mjs
MUBIT_CC_BUILD_SKIP_SERVER=1 npm run build
git diff --exit-code -- hooks/dist bin/impl mcp/dist   # commit the bundles if they moved
```
