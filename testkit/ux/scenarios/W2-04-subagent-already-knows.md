# W2-04 — The subagent already knows

**Family** W2 cross-session continuity · **Moments** M2* · **Sessions** 1 · **Duration** ~8 min

**Backend** hosted · **Arms** plugin-on, plugin-off

## What this proves

That a spawned subagent starts with the project's memory rather than from nothing, at a
budget appropriate to a subagent — and that fanning out to several does not multiply the
recall cost into something the user pays for many times over.

## Setup

W2-01's Setup, with `TK=/tmp/tk-w2-04` and `MUBIT_CC_RUN_ID=tk-w2-04`. Seed by walking W2-01
once first.

## Steps

1. Open a session with `--debug-file "$TK/s1.log"`.
2. Prompt: `Use three parallel subagents to review cart.py — one for correctness, one for style, one for tests.`
3. `/exit`, then count the subagent recalls:

```bash
grep -c 'SubagentStart' "$TK/s1.log"
node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run tk-w2-04 --json | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
  console.log("tokens injected:", j.totals.tokens_injected, "over", j.totals.prompts, "prompts");})'
```

## Expect

Each subagent gets its own injection, each smaller than the main session's — the subagent
budget is separate and deliberately tighter.

## Touchpoints

```
hooks:  SessionStart, UserPromptSubmit, SubagentStart*, SubagentStop, PostToolUse, Stop
tools:  —
skills: —
config: subagentRecallTokenBudget, recallTokenBudget
```

## Pass / fail

1. `SubagentStart` fires once per subagent. **Hard.**
2. Per-subagent injected tokens are at or below `subagentRecallTokenBudget`. **Hard.**
3. Total injected tokens for the turn are less than three times the main-session budget —
   otherwise fan-out is a cost multiplier. **Hard.**
4. `SubagentStart` stays inside its 3 s budget. A slow one delays every fan-out.

## Known-not-bugs

- **One subagent gets nothing.** An empty block is cheaper than a bad one, and a
  style-review subagent may legitimately match nothing stored.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| no `SubagentStart` in the log | `hooks.json` | the event is not registered in this version |
| subagent injections as large as the main one | `subagentRecallTokenBudget` | unset, so it fell back to the main budget |

## Teardown

`rm -rf /tmp/tk-w2-04` and unset the `MUBIT_*` exports.
