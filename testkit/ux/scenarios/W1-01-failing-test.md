# W1-01 — A test starts failing in a repo you already worked in

**Family** W1 everyday coding · **Moments** M1, M2, M4*, M6 · **Sessions** 1 · **Duration** ~8 min

**Backend** hosted · **Arms** plugin-on, plugin-off

The modal session. If the plugin costs anything a user can feel, they feel it here, because
this is the shape most of their day takes.

## What this proves

That capture survives a *failing* tool call, not just a successful one. `PostToolUseFailure`
and `StopFailure` are separate registrations from their happy-path twins, and a failure that
teaches something is worth more than a success that does not — a command that fails twice for
the same reason (W1-03) is the single highest-value thing this plugin can learn.

## Setup

Reuse W2-01's Setup block, changing `TK` to `/tmp/tk-w1-01` and `MUBIT_CC_RUN_ID` to
`tk-w1-01`, then break the test on purpose:

```bash
printf 'import cart\ndef test_total():\n    assert cart.total([{"price": 2}]) == 3\n' > test_cart.py
```

## Steps

1. Open a session as in W2-01 step 1, with `--debug-file "$TK/s1.log"`.
2. Prompt: `The cart test is failing. Find out why and fix whichever side is wrong.`
3. Let it run the test, see it fail, and fix it. Accept the edits.
4. `/exit`.
5. `node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run tk-w1-01 --last 10`

## Expect

**Step 2** — a `mubit:` line before the first token. On a cold account it reads `0 memories`.

**Step 3** — the failing test run produces no visible plugin output at all. This is the
expectation: M4 is invisible or it is a regression.

**Step 5** — `captured.tools` is greater than zero and the failing `Bash` call is among what
was captured. A run where only the successful calls were captured has lost the more valuable
half.

## Touchpoints

```
hooks:  SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure*, Stop, StopFailure, SessionEnd
tools:  —
skills: —
config: capture, redact
```

## Pass / fail

1. The failing tool call appears in `mubit-inspect`'s captured counts. **Hard.**
2. Nothing plugin-shaped appears in the transcript between the prompt and the reply, other
   than the one `mubit:` status line. **Hard** — this is the invisibility contract.
3. No `warn` line carrying `budget_ms` in the ring log.
4. Wall-clock for the turn is within the noise floor of the same turn with the plugin off.
   Soft; `lab ab --cases W1-bugfix` measures it properly.

## Known-not-bugs

- **The failure is captured twice.** `PostToolUseFailure` and `Stop` both see it; dedup
  happens at ingest, not on the hot path.
- **`used(0/n)` on every row.** Expected on a cold account with nothing to echo.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| `captured.tools` is 0 | `marker.state` | breaker open, or the plugin never loaded |
| A visible plugin message during step 3 | the `hooks.json` registration for `PostToolUseFailure` | a hook returned a `systemMessage` where it should have suppressed output |

## Teardown

`rm -rf /tmp/tk-w1-01` and unset the `MUBIT_*` exports.
