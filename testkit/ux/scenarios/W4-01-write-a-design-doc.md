# W4-01 — Writing a design document

**Family** W4 non-code · **Moments** M4* · **Sessions** 1 · **Duration** ~8 min

**Backend** hosted · **Arms** plugin-on, plugin-off

## What this proves

That capture works when the work is prose rather than code. Capture is tool-shaped — it
watches `Edit` and `Write` and `Bash` — so a session whose entire output is one long Markdown
file is exactly where it is most likely to under-capture, and where nobody would notice.

## Setup

W2-01's Setup, with `TK=/tmp/tk-w4-01` and `MUBIT_CC_RUN_ID=tk-w4-01`.

## Steps

1. Open a session with `--debug-file "$TK/s1.log"`.
2. Prompt: `Write docs/pricing.md: a design note arguing that prices in this project must be integer cents, with the two trade-offs.`
3. Accept the write.
4. Prompt: `Now add a section on migration.`
5. `/exit`, then `node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run tk-w4-01 --last 10`
6. In a fresh session: `What did we decide about price representation?`

## Expect

`captured.tools` counts the `Write` and the `Edit`. Step 6 answers from the decision, not
from re-reading the file — though re-reading it is acceptable if the answer is right.

## Touchpoints

```
hooks:  SessionStart, UserPromptSubmit, PostToolUse*, Stop, SessionEnd
tools:  —
skills: —
config: capture, redact
```

## Pass / fail

1. Both document edits appear in the captured counts. **Hard.**
2. Step 6 recovers the decision. **Hard.**
3. The document's content is redacted on the way out where redaction applies — check the
   ring log for anything that should not have left the machine. **Hard.**

## Known-not-bugs

- **The whole document is not stored.** Capture stores what was decided, not the artefact.
  A design note that survives only as its conclusion is the intended behaviour.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| `captured.tools` is 0 | `capture` config | `Write`/`Edit` not in the captured tool set |
| step 6 is wrong | `--resolve` | the stored summary lost the decision — a quality issue worth recording |

## Teardown

`rm -rf /tmp/tk-w4-01` and unset the `MUBIT_*` exports.
