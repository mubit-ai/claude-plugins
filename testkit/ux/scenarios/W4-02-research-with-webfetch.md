# W4-02 — Research with WebFetch

**Family** W4 non-code · **Moments** M4* · **Sessions** 1 · **Duration** ~8 min

**Backend** hosted · **Arms** plugin-on only

## What this proves

That capture and redaction behave on content that did not come from the repository. Fetched
pages are the one input the user did not write and did not review, which makes them the most
likely source of something that should never have been sent to a memory backend.

## Setup

W2-01's Setup, with `TK=/tmp/tk-w4-02` and `MUBIT_CC_RUN_ID=tk-w4-02`.

## Steps

1. Open a session with `--debug-file "$TK/s1.log"`.
2. Prompt: `Look up how Python's decimal module recommends representing money, and summarise the recommendation.`
3. Let it fetch and summarise.
4. `/exit`, then inspect what was captured, and grep the spool for anything that should not
   be there:

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run tk-w4-02 --last 10
grep -ril 'authorization\|api[-_]key\|bearer ' "$DATA/runs/tk-w4-02/spool" 2>/dev/null || echo "spool clean"
```

## Expect

The recommendation is captured as a fact. The spool grep prints `spool clean`.

## Touchpoints

```
hooks:  UserPromptSubmit, PostToolUse*, Stop, SessionEnd
tools:  —
skills: —
config: capture, redact
```

## Pass / fail

1. Something from the fetch is captured. **Hard** — non-repo research is still work.
2. The spool grep is clean. **Hard.**
3. No fetched URL's full body is stored verbatim. **Hard**: capture stores conclusions, and
   a verbatim page is both a cost and an exposure.

## Known-not-bugs

- **Nothing is captured at all.** If self-reference suppression matched the page, that is
  correct behaviour, not a miss. Check the page text for `mubit` before calling it a failure.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| the grep hits | `lib/redact.mjs` | note the exact shape; an assignment-rule form such as `env: DATABASE_PASSWORD=x` is known to slip past stage 1 |

## Teardown

`rm -rf /tmp/tk-w4-02` and unset the `MUBIT_*` exports.
