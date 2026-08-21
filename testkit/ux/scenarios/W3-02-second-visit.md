# W3-02 — The second visit to a repo you do not know

**Family** W3 onboarding · **Moments** M7* · **Sessions** 2 · **Duration** ~12 min

**Backend** hosted · **Arms** plugin-on, plugin-off

W2-01 proves continuity for something *you* taught. This proves it for something you never
articulated — the payoff turn on a codebase you are still learning, which is where the
feature is worth the most and is hardest to fake.

## What this proves

That knowledge the model *discovered* in session 1 — not stated by the user — is promoted at
`SessionEnd` and comes back in session 2. This is the difference between a note-taking tool
and a memory layer.

## Setup

W2-01's Setup, with `TK=/tmp/tk-w3-02` and `MUBIT_CC_RUN_ID=tk-w3-02`, but point `$REPO` at a
real repository you do not know well. A checkout of a mid-sized open-source project works;
the fixture in `corpus/fixture.mjs` is too small to have anything worth discovering.

## Steps

1. Session 1: `Work out how this project runs its tests and what the entry point is, then explain both.`
2. Let it explore. Do not tell it anything.
3. `/exit`. Wait for ingest as in W2-01 step 5.
4. Session 2: `How do I run the tests here?`
5. Compare the number of tool calls in session 2 against session 1.

## Expect

Session 2 answers with noticeably less exploration — ideally from the injected block, with a
confirming read rather than a rediscovery. The `mubit:` line on step 4 should show at least
one source.

## Touchpoints

```
hooks:  SessionStart, UserPromptSubmit*, PostToolUse, Stop, SessionEnd
tools:  —
skills: —
config: reflectOnEnd, sessionEndDetach
```

## Pass / fail

1. Step 4 injects at least one source. **Hard.**
2. Session 2 uses fewer tool calls than session 1 for the same question. **Hard** — this is
   the only measurable form the payoff takes here.
3. The answer is still correct. **Hard**: a faster wrong answer is a regression, and a
   confidently recalled stale fact is the worst outcome this feature can produce.

## Known-not-bugs

- **Session 2 still reads one file.** Confirming a recalled fact against the repo is good
  behaviour, not a failure to use memory.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| step 4 injects nothing | `marker.reflect.status` | nothing was promoted; `reflectOnEnd` off, or session 1 was killed before the detached reflect finished |
| session 2 re-explores anyway | the injected text via `--resolve` | promoted, but too vague to act on — a quality issue, worth recording |

## Teardown

`rm -rf /tmp/tk-w3-02` and unset the `MUBIT_*` exports.
