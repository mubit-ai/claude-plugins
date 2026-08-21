# W2-03 — Surviving a compaction

**Family** W2 cross-session continuity · **Moments** M5* · **Sessions** 1 · **Duration** ~15 min

**Backend** hosted · **Arms** plugin-on only

## What this proves

That the `PreCompact` checkpoint captures what the session knew before the context was
thrown away, and that `PostCompact` restores enough that the session does not restart from
nothing. This is also the **only** user-visible failure message the plugin has: if the
checkpoint fails, the user is told, because a silent failure here loses work.

## Setup

W2-01's Setup, with `TK=/tmp/tk-w2-03` and `MUBIT_CC_RUN_ID=tk-w2-03`.

## Steps

1. Open a session with `--debug-file "$TK/s1.log"`.
2. Prompt: `In this repo prices are integer cents. Remember that and then help me refactor cart.py.`
3. Fill the context: ask for several long file reads and explanations until the host
   compacts, or run `/compact` explicitly.
4. After compaction, prompt: `What did we decide about how prices are represented?`
5. `/exit`, then `node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run tk-w2-03 --last 20`

## Expect

Step 4 answers correctly. `PreCompact` produced no visible output unless it failed, in which
case the message is explicit and names the failure.

## Touchpoints

```
hooks:  SessionStart, UserPromptSubmit, PostToolUse, PreCompact*, PostCompact, Stop, SessionEnd
tools:  —
skills: —
config: capture, recallAsync
```

## Pass / fail

1. Step 4 recovers the constraint. **Hard.**
2. `PreCompact` stays inside its 10 s budget — check the ring log. **Hard**: an overrun here
   means the host killed the checkpoint and the session lost its state silently.
3. If the checkpoint failed, the user was told. **Hard.**

## Known-not-bugs

- **Compaction is slower with the plugin on.** `PreCompact` has a 10 s budget for a reason.
  Measure it with `lab latency` rather than judging it by feel.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| step 4 has forgotten | ring log for `PreCompact` | checkpoint overran and was killed |
| a scary message with no detail | the `PreCompact` handler | the message should name the failure; a bare one is a defect |

## Teardown

`rm -rf /tmp/tk-w2-03` and unset the `MUBIT_*` exports.
