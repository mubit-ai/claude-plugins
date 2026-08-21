# The mubit plugin lab

A reusable kit for answering two questions each time a new version of the `mubit-memory`
Claude Code plugin lands:

1. **Does it feel good?** — `ux/`, eighteen hand-walked scenarios organised by *user
   workflow* rather than by plugin feature, with a generated coverage grid that prints what
   is **not** tested.
2. **Is it worth carrying?** — `lab ab` and `lab eval`, a paired A/B on overhead and
   responsiveness, gated behind a preflight — run fresh on every sweep, never cached — that refuses to
   record a number when the backend is degraded.

> **This repository is a generated mirror.** Everything committed here is wiped by the next
> publish, which begins with `git rm -rq --ignore-unmatch .`. The kit is designed to be moved
> upstream by one command:
>
> ```bash
> cp -R testkit/ /Users/eldaru/Mubit/ricedb-cc-plugin/testkit/
> ```
>
> Nothing in `testkit/` imports from a path outside itself except through `--plugin-dir`, so
> that copy is the whole port.
>
> **Set `MUBIT_LAB_RESULTS` to somewhere outside this repo before you record anything.**
> Cross-version history is the entire point of the kit, and it does not survive a publish:
>
> ```bash
> export MUBIT_LAB_RESULTS=~/Mubit/testkit-results
> ```

## The reuse loop

This is the whole answer to "reusable with each new version". Everything else in this file
explains one of these lines.

```bash
export MUBIT_LAB_RESULTS=~/Mubit/testkit-results
V=/Users/eldaru/Mubit/<worktree-of-the-version-under-test>
L=/Users/eldaru/Mubit/plugin-lab/testkit

# 0. build the target (NEVER `npm run verify` — see below)
cd "$V/integrations/claude-code"
MUBIT_CC_BUILD_SKIP_SERVER=1 npm run build && npm test && npm run test:dist \
  && node scripts/verify-manifests.mjs

# 1. trust the kit, then trust the backend — in that order
node "$L/bin/lab.mjs" selftest                         # offline, ~3s, no model calls
node "$L/bin/lab.mjs" preflight  --plugin-dir "$V"     # refuses if recall is degraded

# 2. measure
node "$L/bin/lab.mjs" ab       --plugin-dir "$V" --reps 3
node "$L/bin/lab.mjs" latency  --plugin-dir "$V"
node "$L/bin/lab.mjs" eval     --plugin-dir "$V"

# 3. compare against the last version
node "$L/bin/lab.mjs" history
node "$L/bin/lab.mjs" compare <stampA> <stampB>

# 4. walk what no harness can judge
node "$L/bin/lab.mjs" ux --plugin-dir "$V" --check --write
$EDITOR "$L/ux/scenarios/W2-01-teach-then-recall.md"
```

`--plugin-dir` accepts either a worktree root or the plugin directory itself. The kit holds
no copy of the plugin, which is what makes one kit serve every version.

## Why the preflight is not optional

The backend can be **healthy and useless at the same time**. A health ping cannot see that,
so the gate writes a sentinel through the plugin's own ingest path under a freshly minted run
and reads it back under that same `run_id`:

```
PASS  backend health                               218ms ok
PASS  recall canary: a run reads its own evidence  sentinel read back in its own run · 1 sources
INFO  cross-run overlay                            0 sources in an unrelated run — instance-wide
                                                   sharing is off; expected at mcpLessonScope=run
```

Those are two different questions, and until `docs/SCOPE.md` §8 they were one check. The
canary used to dial a synthetic `tk-preflight-canary` run that had never written anything, so
what it measured was *cross-project* recall — which this plugin deliberately keeps off
(`mcpLessonScope` defaults to `run`). It was red for the shipped configuration, and a gate
that is red by design gets bypassed with `--force` within a week, after which it protects
nothing.

Cross-session recall *within* a project rides the same `run_id` — `runStrategy: per-directory`
derives it from the git toplevel — and does not go near the overlay. Every W2 scenario pins
its run id and therefore tests that path.

The gate still earns its place, now on the question that can actually go wrong: an A/B run
against a genuinely broken retrieval path produces clean, plausible, reproducible numbers
showing the plugin does nothing, and nothing in the output would say why. That is why the
canary dials the real recall ladder through the plugin's own `lib/recall.mjs` rather than
pinging health. The six checks:

| # | Check | Fails on |
| --- | --- | --- |
| 1 | `claude` version | absent, or drifted from the pinned one (`--allow-host-drift` to override) |
| 2 | env hygiene | any ambient `MUBIT_*` / `CLAUDE_PLUGIN_*` — env beats `credentials.json`, so a leftover export silently measures a different instance |
| 3 | credentials resolve | no key in env or any `mubit-memory*/credentials.json` |
| 4 | **recall canary** | the sentinel cannot be written, its ingest never lands, or the run that wrote it cannot read it back — plus `failed` and `budget_exhausted` anywhere on the path |
| 5 | cross-run overlay | nothing. It is **informational**: it measures whether an unrelated run sees anything, which is off by default and is not a reason to refuse a measurement |
| 6 | the arms are what they claim | treatment did not load the plugin, or control did |

Check 6 costs two real (cheap, one-turn) model calls, and it is the one that catches the
kit's most dangerous failure: an arm that is not what its label says scores as "no
difference", which is indistinguishable from a real null result.

`--force` records anyway and stamps `degraded: true`. `compare` prints a `WARN` naming the
run, and `history` shows it with `trusted` false — it does not refuse. That is deliberate: an
overhead measurement taken against a degraded backend is still a real number, and refusing to
place it in a table would strand it for nothing. The verdict that *does* stop you quoting a
sweep is `sound`, which is about the arms rather than the backend, and it exits non-zero.

Note what no longer sets `degraded`: an instance where cross-run sharing is off. That is the
shipped configuration (check 5 above), the gate stays green through it, and an A/B recorded
there is measuring the product as users have it.

## What the A/B measures, and what it refuses to measure

`lab ab` runs N prompts × 2 arms × R reps of `claude -p --output-format stream-json`, in a
generated fixture repo so the work is identical across versions.

- **Treatment**: `--plugin-dir <target>`, plus a `--settings` JSON string disabling every
  ambient plugin.
- **Control**: identical, minus `--plugin-dir`. The same `--settings`, because ambient
  plugins load in both arms otherwise.

Both arms get `--model` pinned, `--exclude-dynamic-system-prompt-sections` (cache-creation
noise dominates cost — a 44-output-token call can bill $0.014 on a 6.4k-token cache write),
`--strict-mcp-config` and `--setting-sources ''`.

Reported as **paired medians with an IQR and an exact binomial sign test**. No means: one
40-second outlier owns the mean at n=5. Where the discordant-pair count cannot reach p<0.05
at all, the table prints `underpowered (need 6 pairs)` rather than "not significant" — those
are different claims and only one of them is honest at this n.

**Run the noise floor once, or every delta is uncalibrated:**

```bash
node bin/lab.mjs ab --plugin-dir "$V" --noise-floor --reps 3
# copy summary.json's noiseFloor to $MUBIT_LAB_RESULTS/noise-floor.json
```

That is an A/A run — both arms are controls — so whatever delta comes out is the floor
everything else sits on.

`resolved` and `reward` are present in every trial record and always `null`. This kit
measures overhead and responsiveness, not task success. The capability question is already
answered for `b46eded` by Terminal-Bench (80 trials, `MUBIT_PERFORMANCE_SUMMARY.md`); the
field names here match its `Trial` dataclass so a TBench row and a testkit row sit in the
same table, and keeping the fields null is the honest encoding of "we did not re-run it".

## Responsiveness — four sources, never blended

`lab latency` keeps them in separate rows and labels each, because blending them is how a
survivorship-biased number gets published:

| Source | What it is good for | What it is not |
| --- | --- | --- |
| `--debug-file` | the **only** place the per-prompt recall series survives (`marker.recall.ms` is last-write-wins) | needs a sweep to produce it |
| transcripts | free, exact, retroactive Stop-hook wall time from `stop_hook_summary.hookInfos` — 343 samples already on this machine, p50 118 ms, p95 413 ms | `stop_hook_summary` is the only subtype carrying `hookInfos`, so it is Stop and nothing else |
| the ring log | overruns and detached drain time | **records a hook only when it overran.** A tail detector, not a distribution |
| `bin/statusline.mjs`, timed here | the 15 ms budget on a surface that runs every render | includes ~25 ms of node startup |

The `tok` field of the status line goes through `formatTokens`, so anything ≥ 1000 renders as
`1.2k`. The obvious `grep -ao 'mubit: [0-9][^"\\]*'` recipe truncates it and `parseInt` turns
1200 into 1 — `lib/latency.mjs` expands it and `test/parsers.test.mjs` pins that.

## `claude plugin eval` — the primary A/B path

The host already **is** a plugin ablation harness: `--ablation with-without` is its default,
it sandboxes each run, ships six grader types, averages over runs, enforces a cost ceiling
and writes a stable `aggregate-result.json`. The kit uses it and rebuilds none of it.

Two things it deliberately does not do for us, both handled by `lab eval` — see
[`evals/README.md`](evals/README.md) for the detail:

1. `--eval-dir` must be **relative, below the plugin** (an absolute path is refused
   outright). `lab install-evals` symlinks `evals/` into the target and adds the link to
   git's exclude file, so the target worktree stays clean; `--uninstall` removes both.
2. Each run gets a fresh `HOME`, so the plugin's stored `credentials.json` is not there and
   the "with" arm would carry a dead plugin. `case.yaml`'s `execution.env` **cannot** fix
   this — it accepts `EVAL_*` keys only. `lab eval` exports the credentials from the
   operator's shell, which is what the host's own error message says to do.

`lab eval --probe` classifies the early-access gate as `gated | open | open-with-escape` for
free, and writes `evals/gate.json`. On this account today it is `open-with-escape`.

**The eval path is wired but not yet detecting the plugin** — the suite runs, ablates and
writes its aggregate, but every with-only indicator is still silent. `lab eval` exits
non-zero and prints `VOID` in that state rather than letting `meanDelta 0` read as a null
result. See [`evals/README.md`](evals/README.md) for what has been ruled out. Until an
indicator fires, use `lab ab`, whose arm verification is confirmed.

If the gate ever closes again, `lab ab --shim-eval` writes the same file shape from A/B
trials. `readAggregate` reads either, so the shim is deletable the day the gate opens without
anything downstream changing. It is throwaway by construction and labelled as such in the
file it writes.

## Trusting the kit before trusting its numbers

```bash
node bin/lab.mjs selftest     # 58 tests, offline, ~3s
```

Four negative controls, plus the checks they depend on:

- **N1 — a dead treatment arm.** A treatment that did not load the plugin, a control that
  did, and a control that wrote plugin state all mark the sweep **VOID** rather than sound.
  A silently-unloaded plugin scoring as "no difference" is the single most likely way this
  kit lies.
- **N2 — should-not-fire.** Identical arms produce `+0` and a verdict that declines to claim
  anything; a real 1800 ms difference over nine pairs is detected as significant; four pairs
  report `underpowered (need 6 pairs)` instead of a false null.
- **N3 — degraded backend.** An unreachable endpoint fails the canary specifically, and a
  leaked `MUBIT_ENDPOINT` is caught before it can redirect a sweep — with the API key
  reported by name and never by value. The split canary (`N3d`–`N3j`) is driven against a
  loopback instance that really stores what it is given and answers a query only from the run
  that asked: a run that cannot read back its own sentinel refuses the sweep, an unrelated
  run seeing nothing does not, and an ingest still `queued` is reported as ingest lag rather
  than as a dead index.
- **N4 — the noise floor.** An A/A pair is measured and reported.

Plus the parsers pinned against fixtures (`1.2k` expansion, the ring log's overrun-only
shape, `stop_hook_summary` filtering, the stream-json envelope), and the coverage drift
alarm.

## Layout

```
testkit/
  README.md               this file
  kit.json                pinned model, reps, budgets — and why each is what it is
  bin/lab.mjs             the single CLI
  lib/
    paths.mjs             plugin resolution, results root
    versions.mjs          the stamp, and the comparability gate
    arms.mjs              what "on" and "off" mean, as argv + env
    preflight.mjs         the gate: six checks, and which of them may refuse a sweep
    metrics.mjs           one run in, one TBench-compatible trial record out
    latency.mjs           the four responsiveness miners
    report.mjs            paired medians, integrity block, tables
    stats.mjs             median, IQR, paired delta, exact sign test (~60 lines, no deps)
    evals.mjs             gate probe, symlink install, the throwaway shim
    ux.mjs                scenario parser, ground truth, coverage
  corpus/
    prompts.json          the A/B prompt corpus
    fixture.mjs           the generated repo every prompt is answered in
  ux/
    TAXONOMY.md           the two axes, plus a generated coverage grid
    coverage.json         machine-readable, regenerated by `lab ux --write`
    scenarios/*.md        18 scenarios, fixed nine-section format
  evals/                  `claude plugin eval` cases
  test/*.test.mjs         the negative controls — `node --test`
  results/                gitignored except index.json and noise-floor.json
```

Node, zero dependencies, `node --test` — matching the plugin repo's own convention. The
preflight *imports the plugin's own* `loadConfig`, `health` and `recallBlock`, so it measures
the same config precedence, the same breaker and the same policy cache the hooks will use,
and cannot drift from them by construction.

## Two traps in the target repo

- **Never run `npm run verify`** in the plugin repo. Its `clean` deletes
  `mcp/dist/server.js`, which is a tracked artefact this mirror cannot rebuild. Use the
  `MUBIT_CC_BUILD_SKIP_SERVER=1 npm run build && npm test && npm run test:dist` line above.
- **A fresh worktree cannot `npm install`**: `package.json` dev-depends on
  `@mubit-ai/mcp: file:../mcp`, which has no sibling in the mirror. Copy `node_modules` from
  an existing worktree.

## What this deliberately does not build

| Not building | Why |
| --- | --- |
| A Terminal-Bench or SWE-bench extension | wrong instrument for a plugin A/B, and TBench already answered the capability question for `b46eded` at 80 trials. The kit cites its scorecard rather than producing a weaker rival |
| A grader framework | the host ships six grader types and the gate opens with one env var |
| A new Mubit stub | `test/helpers/harness.mjs`'s `fakeMubit()` and `labs/fake-mubit.mjs` both exist |
| Statistics beyond a sign test | n is 3–10. A t-test at n=5 is decoration |
| A new manual runbook | `docs/manual-test-0.10.0.md` is 1074 lines of recorded transcript covering plugin *surfaces*. `ux/` covers *workflows* and cross-links rather than restating |
| CI wiring | the kit spends real money against a hosted backend. Only `selftest` can run on a PR, and it is the only part that should |
| Cross-session *value* measurement | explicitly descoped. W2 proves continuity works without pricing what it is worth |
