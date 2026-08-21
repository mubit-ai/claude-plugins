# W2-01 walked unchanged, with the canary red

**Date** 2026-08-21 · **Plugin** `0.10.0` at `05adfe0`, `/Users/eldaru/Mubit/pre-main`, **unmodified**
**Backend** hosted `api.mubit.ai` · **Run** `tk-w2-01` (`static`, pinned)

SCOPE.md §9 step 1 and the plan both name this as the load-bearing experiment:

> If it passes with the canary red, I1 is confirmed and the severity of the rest drops
> sharply. If it fails, the problem is inside project memory and none of Target C is the
> answer.

## Result: PASS, on all five items

| # | Criterion | Measured | |
| --- | --- | --- | --- |
| 1 | step 7 injects ≥ 1 source (**hard fail at 0**) | **4 sources · 723 tok · 1173 ms · rung 1** | PASS |
| 2 | the injected text is the constraint from step 2, not an unrelated top hit | the block carries session 1's integer-cents work verbatim | PASS |
| 3 | the generated `discount` respects the constraint (**soft**) | int cents in, int cents out, half-up rounding | PASS, confounded — see below |
| 4 | step 7's latency under 3000 ms | 1173 ms | PASS |
| 5 | no `warn` carrying `budget_ms` in the ring log | zero `warn`, zero `error`, zero `budget_ms` | PASS |

Per-prompt, from `mubit-inspect --last 10`:

```
prompt     when      rung  src  tok  chars  drop  ptr  empty_reason  used(m/c)  outcome
4a130bb8…  12:50:52     1    0    0      0     0    0  no_evidence   0/0 ?      pending
c86d1f00…  12:53:23     1    4  723   2889     0    0  —             16/48 yes  sent

lessons     global 0 · injected_ids 0 · reflect: 2 stored, status=ok
capture     ingested 11 · spool 0 · jobs 2
```

Session 1 draws a blank because nothing is stored yet — the documented correct behaviour.
Session 2 gets four sources at rung 1 before the model's first token, and the used-signal
fires at 16/48.

## What this confirms

**I1 is confirmed.** Cross-session recall within a project works, on the shipped
configuration, on the same instance whose `recall-canary` is red. The canary was measuring
*cross-project* recall — a run that has never written anything trying to read what unrelated
runs stored — and blocking every measurement on a state the plugin deliberately keeps off.

The severity of the rest of the register drops accordingly. SC-02/SC-03 unblock measurement;
Target C is a capability gap rather than a repair.

## Two things found while walking it

**1. W2-01 step 5 cannot succeed as written.** It says to poll until *"the newest job is not
`queued`"* using `mubit-inspect`. But `mubit-inspect` reads `runs/<run>/jobs.json` from local
disk (`scripts/mubit-inspect.mjs:132`) — a snapshot written at submit time that nothing ever
refreshes. The status stays `queued` forever.

Asked directly, the server had finished the job **322 ms** after it was created:

```
local record : 9d74fcdf-…  queued     6 items
server says  : status "completed", created 11:51:30.321Z, finished 11:51:30.643Z
```

So an operator following step 5 waits out the full ten minutes and concludes, per the
scenario's own guidance, that *"the embedding service behind the instance is down"* — on a
backend that answered in a third of a second. The step is fixed in this commit to poll
`getIngestJob` through the plugin's own `lib/http.mjs`, and to read `spool_pending` (which is
local, and is a genuine local fact) separately from job status (which is not).

**2. Pass/fail item 3 is confounded, and always was.** Session 1 wrote the constraint into
`cart.py`'s own docstring. Session 2 reads that file, so a model with no memory at all would
still return int cents. The scenario already grades item 3 as soft and says "record it; do
not gate on it" — which is right, and this is the specific reason why. Item 1 is the real
gate and is unaffected.

## Deviations from the scenario as written

Two, neither of which touches what is measured:

- `$TK` is the session scratchpad rather than `/tmp/tk-w2-01`. Nothing reads the path.
- Both sessions were driven headlessly with `claude --print … --permission-mode acceptEdits`
  rather than interactively. The same hooks fire — `SessionStart`, `UserPromptSubmit`,
  `PostToolUse`, `Stop`, `SessionEnd` — and the injection is observed in the same debug log.
  One consequence worth naming: the model could not run `pytest` under `--print`, so both
  sessions reported their tests unverified. That is a property of the harness, not of the
  plugin, and no pass/fail item depends on it.
