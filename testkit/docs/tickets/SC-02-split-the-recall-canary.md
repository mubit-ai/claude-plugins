# SC-02 — split the recall canary: same-run blocks, cross-run informs

**Branch:** `fix/testkit-canary-split` · **Worktree:** `/Users/eldaru/Mubit/scope-canary`
**Kind:** fix · **SCOPE.md:** I1, §8.1–8.2

## The defect

`testkit/lib/preflight.mjs:225` and `:287` dial a hard-coded run:

```js
const outcome = await recallMod.recallBlock(cfg, {
  runId: 'tk-preflight-canary',
  ...
});
```

`tk-preflight-canary` has never written anything. The question it poses is *"can a run that
has never stored anything retrieve what unrelated runs stored?"* — that is **instance-wide
sharing**, which the plugin deliberately keeps off (`mcpLessonScope` defaults to `run`).

So the gate is red for the shipped configuration. A gate that is red by design gets bypassed
with `--force` within a week, and then it protects nothing.

## The specification (SCOPE.md §8)

`checkRecallCanary` conflates three states and only two are a reason to refuse a measurement:

| State | What it means | Blocks a sweep? |
| --- | --- | --- |
| retrieval outage | endpoint errors, `budget_exhausted` | **yes** — already correct |
| project memory broken | a run cannot retrieve **its own** evidence | **yes** — not currently tested |
| instance-wide sharing off | a fresh run sees nothing from unrelated runs | **no** — the shipped default |

## The change

### 1. `recall-canary` becomes same-run

Write a sentinel through the plugin's own ingest path under a **fresh pinned run**, then read
it back under **that same `run_id`**. Red there is a real outage — it is the product's actual
contract.

`lib/preflight.mjs` already imports the plugin's `lib/http.mjs`, so `postIngest` plus a short
poll on `getIngestJob` is available with no new plumbing. Confirm the exact export names
against the plugin under test before writing against them.

The sentinel must be unmistakable and disposable: a nonce in the text, a run id minted per
preflight (not a fixed literal — a fixed one accumulates junk on the instance across runs).
Ingest is asynchronous; poll the job to completion within the budget rather than sleeping a
constant, and if it does not land in time report *that* as the measured value rather than
reporting a recall failure that was really an ingest lag.

### 2. Demote the current probe to `cross-run-overlay`, informational

Keep the existing lesson-fetch / self-echo / owning-run ladder — it is good diagnosis — but
report it as **informational** with its measured value rather than a FAIL:

```
0 sources in an unrelated run — instance-wide sharing is off; expected at mcpLessonScope=run
```

It stops being a reason to `--force`.

## Two structural constraints found in the code

Both must be handled or the split does not work:

1. **`Check.ok` is a strict boolean** and `preflight.ok = checks.every(c => c.ok)`
   (`lib/preflight.mjs:26`, `:376`). The declared-but-dead `fatal?` field on the `Check`
   typedef is the free slot — replace it with `severity: 'block' | 'info'` and reduce over
   `severity !== 'info'`. Checks that do not say otherwise must default to blocking, so an
   existing check that is not updated keeps its current behaviour.
2. **`renderChecks` (`:384-392`) prints `detail` only when `!c.ok`**, so an informational
   check would drop its own explanation — which is the entire point of demoting it. Fix the
   renderer in the same change, and give an informational row a label that is not `PASS` or
   `FAIL` (`INFO`), so an operator can see at a glance that it was not a verdict.

## The eight branches

The id `recall-canary` is emitted from **eight** places: `:238, 245, 252, 271, 280, 295, 319,
325, 330`. Splitting the check means re-homing some of them. Suggested allocation:

| Line | Condition | Goes to |
| --- | --- | --- |
| 238 | `outcome.failed` | `recall-canary`, blocking — a real outage |
| 245 | `budget_exhausted` | `recall-canary`, blocking — a real outage |
| 252 | `outcome.sources > 0` | `cross-run-overlay`, info — sharing is on |
| 271 | 0 lessons stored | `cross-run-overlay`, info — nothing to overlay |
| 280 | lessons with no readable text | `cross-run-overlay`, info |
| 295 | self-echo found it | `cross-run-overlay`, info — sharing is on |
| 319 | pinned-to-owner found it | `cross-run-overlay`, **info** — this is state 3, the shipped default |
| 325 | not findable from any scope | `recall-canary`, blocking — this one really is retrieval |
| 330 | the canary threw | `recall-canary`, blocking |

The `health` check keeps its current blocking behaviour.

## Tests (red first)

`testkit/test/negative-controls.test.mjs` already owns the canary's negative controls, and
`N3` (`:133`) pins today's behaviour: an unreachable endpoint must still fail `recall-canary`.
That test must keep passing — an outage is state 1 and still blocks.

Add, red first:

- a check that an instance where the same-run sentinel reads back is `ok`, and that
  `cross-run-overlay` returning 0 sources does **not** make `preflight.ok` false;
- a check that `renderChecks` emits an informational row's `detail` (today it does not);
- a check that a `Check` with no `severity` still blocks — the default must not silently
  weaken an existing gate.

Offline and deterministic where possible, in the style of the file's existing N-controls
(port 9 for a refused connection; no model calls).

## Verification

```bash
cd <worktree>/testkit && node bin/lab.mjs selftest
```

Plus, on the integration branch against the real instance:

```bash
node bin/lab.mjs preflight --plugin-dir /Users/eldaru/Mubit/plugin_scope_fix
```

`recall-canary` PASS on the same-run sentinel; `cross-run-overlay` rendered as informational
with a measured value rather than a FAIL.

## Do not

- Do not change any instance setting to make this green. Options A and B are rejected in
  SCOPE.md §4; the point of this ticket is that the *check* was wrong, not the instance.
