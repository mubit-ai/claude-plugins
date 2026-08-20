# W4-04 — Asking what it learned

**Family** W4 non-code · **Moments** M6* · **Sessions** 1 · **Duration** ~6 min

**Backend** hosted · **Arms** plugin-on only

## What this proves

That reflection can be triggered on demand rather than only at `SessionEnd`, that it reports
what it stored, and that the report is checkable against `mubit_lessons` rather than being a
narrative the model composed.

## Setup

W2-01's Setup, with `TK=/tmp/tk-w4-04` and `MUBIT_CC_RUN_ID=tk-w4-04`. Do a few minutes of
real work first — walk W1-01 in the same run — so there is something to reflect on.

## Steps

1. In the same session, prompt: `What did you learn in this session? Store anything worth keeping.`
2. Observe whether `reflect` or `mubit_reflect` fires.
3. Prompt: `List every lesson you now hold for this project.`
4. `/exit`, then cross-check:

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run tk-w4-04 --json | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
  console.log("reflect:", JSON.stringify(j.marker.reflect));
  console.log("lessons:", JSON.stringify(j.marker.lessons));})'
```

## Expect

`mubit_reflect` runs and returns a count. Step 3 uses `mubit_lessons` and its list matches
`marker.lessons.global`. A mismatch between what the model says it stored and what the store
reports is the failure this scenario exists to find.

## Touchpoints

```
hooks:  UserPromptSubmit, PostToolUse, Stop, SessionEnd
tools:  mubit_reflect*, mubit_lessons
skills: reflect
config: reflectOnEnd
```

## Pass / fail

1. `mubit_reflect` fires. **Hard.**
2. Its reported count matches `marker.reflect.lessons_stored`. **Hard.**
3. Step 3's list matches the store, not the conversation. **Hard.**
4. Reflection does not block the session for more than its budget.

## Known-not-bugs

- **Zero lessons stored from a short session.** Reflection has a bar. An honest zero beats a
  manufactured lesson.
- **`mubit_lessons` cannot see agent-authored lessons.** A known gap in the lessons route:
  the list can legitimately be shorter than what was written. Record it; do not fail on it.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| the model narrates instead of calling a tool | `mcpTools` | `mubit_reflect` is not in the allowlist |
| counts disagree | `marker.reflect` vs the reply | the model is reporting intent rather than result |

## Teardown

`rm -rf /tmp/tk-w4-04` and unset the `MUBIT_*` exports.
