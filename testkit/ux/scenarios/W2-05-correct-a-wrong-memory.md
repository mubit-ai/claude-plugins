# W2-05 — Correcting something it learned wrong

**Family** W2 cross-session continuity · **Moments** M4* · **Sessions** 2 · **Duration** ~10 min

**Backend** hosted · **Arms** plugin-on only

A memory layer that cannot be corrected is worse than none: it converts one wrong belief into
a permanent one, and the user has no way to tell which of the two happened.

## What this proves

That a wrong memory can be *superseded* by a negative outcome — the reversible path — and
*deleted* outright when it must be, and that the correction survives into the next session.

## Setup

W2-01's Setup, with `TK=/tmp/tk-w2-05` and `MUBIT_CC_RUN_ID=tk-w2-05`.

## Steps

1. Session 1: teach something deliberately wrong —
   `In this repo prices are always floats with two decimal places. Remember that.`
2. `/exit`. Wait for ingest as in W2-01 step 5.
3. Session 2: `That rule about prices being floats is wrong — they are integer cents. Fix what you know.`
4. Observe which path is taken: a negative outcome, a supersede, or a delete.
5. `/exit`, then `node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run tk-w2-05 --last 10 --resolve`
6. Session 3: `What do you know about prices in this repo?`

## Expect

Step 4 prefers `mubit_outcome` (negative) or a supersede over deletion — deletion cannot be
undone and the `forget` skill says so. Step 6 answers "integer cents" with no trace of the
float rule.

## Touchpoints

```
hooks:  UserPromptSubmit, PostToolUse, Stop, SessionEnd
tools:  mubit_forget*, mubit_outcome, mubit_archive
skills: forget
config: outcomeMode
```

## Pass / fail

1. The wrong rule stops being returned by step 6. **Hard.**
2. The correction path was reversible where possible — a negative outcome or supersede
   rather than a delete. **Hard**, because the skill's own guidance says to prefer it.
3. The user is told which happened, in one line. **Hard.**

## Known-not-bugs

- **The old memory is still dereferenceable by id.** Superseded is not deleted; only recall
  is expected to stop returning it.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| step 6 still returns the float rule | `--resolve` on the recalled ids | the outcome was recorded against a different id than the one recall returns |
| `mubit_forget` cannot find the lesson | — | a known defect: `mubit_forget` misses lessons that direct deletion removes cleanly |

## Teardown

`rm -rf /tmp/tk-w2-05` and unset the `MUBIT_*` exports.
