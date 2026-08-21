# W4-03 — Planning, with nothing edited

**Family** W4 non-code · **Moments** M4* · **Sessions** 1 · **Duration** ~5 min

**Backend** hosted · **Arms** plugin-on, plugin-off

**A negative scenario.** A session that calls no tools and changes no files is the cleanest
test of whether capture fires on *thinking* or only on *doing*, and the answer determines
whether a planning session is free or is quietly billed.

## What this proves

That `Stop` with zero tool calls does something sensible: either it captures the decision, or
it captures nothing and costs nothing. Both are defensible. What is not defensible is
capturing an empty record, paying an ingest job for it, and reporting a `dry_streak` later
that the empty records caused.

## Setup

W2-01's Setup, with `TK=/tmp/tk-w4-03` and `MUBIT_CC_RUN_ID=tk-w4-03`.

## Steps

1. Open a session with `--debug-file "$TK/s1.log"`.
2. Prompt: `Do not edit anything. Plan, in five bullets, how you would add currency support to this cart.`
3. Do not accept any tool use. If it offers to read a file, decline.
4. `/exit`, then:

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run tk-w4-03 --json | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
  console.log("captured:", JSON.stringify(j.marker.captured));
  console.log("jobs:", (j.jobs||[]).length, "spool:", j.spool_pending);})'
```

## Expect

Either `captured.turns` is 1 with a real decision stored, or everything is zero. **Not** a
job queued for an empty payload.

## Touchpoints

```
hooks:  SessionStart, UserPromptSubmit, Stop*, SessionEnd
tools:  —
skills: —
config: capture, reflectOnEnd
```

## Pass / fail

1. No empty record is spooled. **Hard.**
2. If a plan was captured, it contains the plan, not just its existence. **Hard.**
3. Session teardown is not slower than a plugin-off session by more than the noise floor.
4. `dry_streak` is not incremented by this session in a way that would later be reported as
   a recall problem. **Hard** — this is how a benign session poisons a later diagnosis.

## Known-not-bugs

- **`captured.tools` is 0.** Correct: no tools were called.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| a queued job with an empty payload | the spool file | `Stop` capture has no minimum-content gate |

## Teardown

`rm -rf /tmp/tk-w4-03` and unset the `MUBIT_*` exports.
