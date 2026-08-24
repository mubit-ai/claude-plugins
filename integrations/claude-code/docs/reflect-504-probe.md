# B1 — why `POST /v2/control/reflect` 504s

Probed against the production endpoint on 2026-08-24, run `cc-codaph-port-b8d331fe`.
Client timeout 90 s throughout, so every number below is the *server's* behaviour,
not ours.

## Result: it is a race against a fixed deadline, not a payload bound

| `last_n_items` | `include_step_outcomes` | outcome | elapsed |
| --- | --- | --- | --- |
| 200 | true | **504** | 15225 ms |
| 100 | true | 200 (3 lessons) | 12419 ms |
| 50 | true | 200 (4 lessons) | 12794 ms |
| 20 | true | **504** | 15154 ms |
| 20 | true | **504** | 15217 ms |
| 20 | true | **504** | 15074 ms |
| 20 | true | 200 (4 lessons) | 12326 ms |
| 20 | true | **504** | 15063 ms |
| 5 | true | 200 (5 lessons) | 7679 ms |
| 200 | false | 200 (4 lessons) | 14437 ms |
| 20 | false | **504** | 15077 ms |
| *(empty run)* 200 | true | 200 (0 lessons) | 2039 ms |
| *(empty run)* 20 | true | 200 (0 lessons) | 2162 ms |

Three things fall out, and together they redirect the fix.

**1. There is a hard ~15 s ceiling upstream.** Every 504 landed in 15063–15225 ms,
a 162 ms spread across six failures. No success ever exceeded 14437 ms. The
plugin's 45 s budget is therefore never the binding constraint — something between
us and the service gives up at ~15 s, and the plugin spends the remaining 30 s
waiting for a verdict that has already been decided.

**2. It is non-deterministic.** The *same* request (`last_n_items: 20`) run four
times in a row returned 504, 504, 200, 504. `last_n_items: 20` failed while 50 and
100 succeeded. Reflection duration for this run sits at 12.3–14.4 s — just under
the ceiling — so ordinary latency variance decides each call. Roughly 4 of every 10
attempts land on the wrong side.

**3. `last_n_items` has almost no leverage, and `include_step_outcomes` none.**
20 and 200 cost the same (12.3–15.2 ms band), because this run holds fewer than ~20
evidence items — every bound at or above that is the identical request. Only
`last_n_items: 5` moved the number (7679 ms), by truncating evidence to the point
where the reflection is no longer worth much. Turning outcomes off saved nothing
measurable (14437 ms at n=200).

## Where the time goes

An **empty** run reflects in 2.0–2.2 s. That is the fixed server cost: request
handling, the LLM round-trip on an empty prompt, the response. The other ~10–12 s
is work proportional to *what the run holds* — and, critically, **not** to
`last_n_items`, since bounding the evidence to 20 items did not reduce it.

That signature — cost scaling with run size while ignoring the evidence bound — is
what makes the enumeration in the promotion block the prime suspect: it is the one
piece of per-request work whose size is set by the run's total stored entries
rather than by anything the caller passes.

## What this means for the fix

- **Lowering `last_n_items` is not a fix.** It buys nothing between 20 and 200, and
  the value that does help (5) guts the reflection.
- **The real fix is server-side**: get the ~12 s under the ceiling, or raise the
  ceiling. Bounding that enumeration is the first thing to try.
- **A retry is worth having regardless**, and is affordable for the first time now
  that we know a failure costs a deterministic ~15 s rather than the 45 s we
  budgeted for it. Two attempts fit inside the existing envelope with margin.
