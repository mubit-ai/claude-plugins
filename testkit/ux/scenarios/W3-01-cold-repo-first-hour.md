# W3-01 — A cold repo, the first hour

**Family** W3 onboarding · **Moments** M2*, M8 · **Sessions** 1 · **Duration** ~6 min

**Backend** hosted · **Arms** plugin-on, plugin-off

**This is a negative scenario, and it is deliberate.** Every user's first thirty minutes with
this plugin look exactly like this, and a kit made only of happy paths cannot tell "works"
apart from "reports success unconditionally".

## What this proves

That an empty memory reads as *honest*, not as *broken*. The status line, the injected block
and the reply must all agree that there is nothing yet — and the turn must not be slower for
having found nothing.

## Setup

W2-01's Setup, with `TK=/tmp/tk-w3-01` and `MUBIT_CC_RUN_ID=tk-w3-01-$RANDOM` so the run is
genuinely new. Do **not** seed anything.

## Steps

1. Open a session with `--debug-file "$TK/s1.log"`.
2. Prompt: `I have never seen this repo before. What is it and where should I start?`
3. Prompt: `What conventions should I follow here?`
4. `/exit`, then `node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run "$MUBIT_CC_RUN_ID" --json`

## Expect

```
mubit: 0 memories · 0 tok · 412ms
```

on both prompts, and answers that come from reading the repo. Nothing in the reply should
claim to remember anything, and nothing should apologise for having no memory either.

`marker.recall.empty_reason` should be empty or `no_evidence` — **not** `budget_exhausted`
and **not** a failure state. An empty account and a broken backend must not look the same.

## Touchpoints

```
hooks:  SessionStart*, UserPromptSubmit, PostToolUse, Stop, SessionEnd
tools:  —
skills: —
config: statusLine, recallAsync
```

## Pass / fail

1. Both prompts show `0 memories` and no error. **Hard.**
2. `empty_reason` is `''` or `no_evidence`. **Hard** — anything else means the gate should
   have caught a degraded backend before this scenario ran.
3. Neither reply mentions memory, stored lessons, or the plugin. **Hard.**
4. Recall latency on an empty account is under 1500 ms. **Hard**: paying a full budget to
   learn there is nothing is the worst possible trade, and it is what a new user experiences.
5. `dry_streak` reaches 2 and the status line reflects it without alarming language.

## Known-not-bugs

- **`0 memories` on every prompt for the whole first session.** Correct. Nothing has been
  promoted yet; promotion happens at `SessionEnd`.
- **A brief `◌ not_responding` glyph at session start.** The marker starts cold.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| `budget_exhausted` | `lab preflight` | the endpoint is slower than the recall budget — the run is void, not the plugin |
| the reply apologises for having no memory | the block renderer | an empty block should be suppressed, not rendered as an apology |
| 1500 ms+ on an empty account | `lab latency --from <stamp>` | the ladder is paying for rung 2 before concluding nothing is there |

## Teardown

`rm -rf /tmp/tk-w3-01` and unset the `MUBIT_*` exports.
