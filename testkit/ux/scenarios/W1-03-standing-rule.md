# W1-03 — "From now on, always do X in this repo"

**Family** W1 everyday coding · **Moments** M4*, M6 · **Sessions** 1 · **Duration** ~6 min

**Backend** hosted · **Arms** plugin-on only (there is nothing to compare against)

The one moment where the user *deliberately* writes to memory. Everything else in M4 is
implicit; this is the explicit path, and its failure mode is the loudest — a user who is told
something was remembered and finds it was not will not use the feature again.

## What this proves

That an explicit standing preference routes to the `remember` skill, is written through
`mubit_learned`, and lands at the scope the user meant. The scope clamp matters: a rule about
*this repo* that leaks into every project is worse than not storing it.

## Setup

W2-01's Setup, with `TK=/tmp/tk-w1-03` and `MUBIT_CC_RUN_ID=tk-w1-03`.

## Steps

1. Open a session with `--debug-file "$TK/s1.log"`.
2. Prompt: `From now on in this repo, always use integer cents for prices, never floats. Remember that.`
3. Watch which surface fires — a skill, or the MCP tool directly.
4. `/exit`, then:

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run tk-w1-03 --json | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
  console.log("reflect:", JSON.stringify(j.marker.reflect));
  console.log("lessons:", JSON.stringify(j.marker.lessons));})'
```

## Expect

A `Skill` invocation naming `remember`, or a `mubit_learned` tool call, and a reply that says
what was stored in one line. Not a paragraph — the user asked for storage, not a summary.

## Touchpoints

```
hooks:  UserPromptSubmit, PostToolUse, Stop, SessionEnd
tools:  mubit_learned*
skills: remember
config: mcpLessonScope, reflectOnEnd
```

## Pass / fail

1. Something stores the rule — skill or tool. **Hard.**
2. The confirmation names what was stored, so the user can tell it was understood. **Hard.**
3. The stored scope is the repo, not the session and not global. Check with
   `mubit-inspect --run tk-w1-03 --resolve`. **Hard** — see the note below.
4. The reply is at most two sentences. Soft.

## Known-not-bugs

- **The model paraphrases the rule.** Storage is semantic, not verbatim; a paraphrase that
  preserves the constraint passes.
- **No skill fires and `mubit_learned` is called directly.** Both are correct paths.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| nothing stored | `marker.state` | breaker open, or `mcpTools` excludes `mubit_learned` |
| stored at `session` scope | `mcpLessonScope` | `session` scope is cross-run and leaks between projects — a known defect, not a misconfiguration |

## Teardown

`rm -rf /tmp/tk-w1-03` and unset the `MUBIT_*` exports.
