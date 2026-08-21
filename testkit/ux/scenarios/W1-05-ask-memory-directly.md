# W1-05 — Asking memory a question on purpose

**Family** W1 everyday coding · **Moments** M2* · **Sessions** 1 · **Duration** ~5 min

**Backend** hosted · **Arms** plugin-on only

Automatic recall is capped and generic. This is the escape hatch for when the user knows
there is something in there and wants it now.

## What this proves

That the `recall` skill and `mubit_recall` return more than the automatic block does, that
`mubit_dereference` can turn a reference id back into text, and that a deliberate search does
not silently return the same capped block the prompt hook already injected.

## Setup

W2-01's Setup, with `TK=/tmp/tk-w1-05` and `MUBIT_CC_RUN_ID=tk-w1-05`. Seed by walking W2-01
once first.

## Steps

1. Open a session with `--debug-file "$TK/s1.log"`.
2. Prompt: `Search memory: what do we know about how prices are represented in this project?`
3. Prompt: `Show me the full text of the memory you just used.`
4. `/exit`, then `node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run tk-w1-05 --last 5 --resolve`

## Expect

Step 2 calls `mubit_recall` (possibly via the `recall` skill) and answers from what came
back. Step 3 calls `mubit_dereference` and prints real stored text, not a paraphrase.

## Touchpoints

```
hooks:  UserPromptSubmit, PostToolUse, Stop
tools:  mubit_recall*, mubit_dereference
skills: recall
config: recallTokenBudget
```

## Pass / fail

1. `mubit_recall` is called. **Hard.**
2. Its result differs from the automatic block injected on the same prompt — otherwise the
   deliberate path adds nothing. **Hard.**
3. Step 3 returns stored text, not a summary of it. **Hard.**

## Known-not-bugs

- **The prompt hook injects nothing on step 2.** `prompt-recall` deliberately suppresses
  injection on memory commands, so a memory question does not recall into itself.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| the model answers without calling a tool | `mcpTools` in the plugin config | `mubit_recall` is not in the allowlist |
| `mubit_dereference` returns empty | the id in `turns[].recalled` | a pointer id, which has no standalone text |

## Teardown

`rm -rf /tmp/tk-w1-05` and unset the `MUBIT_*` exports.
