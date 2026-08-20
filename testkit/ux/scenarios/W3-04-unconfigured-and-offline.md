# W3-04 — Unconfigured, then offline

**Family** W3 onboarding · **Moments** M8* · **Sessions** 2 · **Duration** ~8 min

**Backend** none, deliberately · **Arms** plugin-on only

The one scenario that needs no working backend, which makes it the one that can always be
run — including on the day the hosted instance is down and every other scenario is void.

## What this proves

That a plugin with no credentials, and a plugin whose endpoint is unreachable, both degrade
to *silent and harmless* rather than to noise or a stalled session. A memory layer that
breaks a session when it cannot reach its server is worse than one that is switched off.

## Setup

```bash
export PLUG=/Users/eldaru/Mubit/pre-main/integrations/claude-code
export TK=/tmp/tk-w3-04
rm -rf "$TK" && mkdir -p "$TK/data" "$TK/repo" && cd "$TK/repo" && git init -q
printf 'x = 1\n' > a.py && git add -A && git -c user.email=t@e.com -c user.name=t commit -qm init
export MUBIT_CC_DATA_DIR="$TK/data" MUBIT_CC_RUN_ID=tk-w3-04 MUBIT_CC_RUN_STRATEGY=static
unset MUBIT_ENDPOINT MUBIT_API_KEY          # part 1: unconfigured
```

## Steps

**Part 1 — unconfigured.**

1. Open a session with `--debug-file "$TK/unconf.log"`.
2. Prompt: `What is in this repo?`
3. Prompt: `Set up my memory.`
4. `/exit`.

**Part 2 — configured but unreachable.**

```bash
export MUBIT_ENDPOINT=http://127.0.0.1:9   # nothing listens here
export MUBIT_API_KEY=not-a-real-key
```

5. Open a session with `--debug-file "$TK/offline.log"`.
6. Prompt: `What is in this repo?`
7. `/exit`, then `node "$PLUG/scripts/mubit-inspect.mjs" --data "$TK/data" --run tk-w3-04 --json`

## Expect

**Part 1** — step 2 behaves as if the plugin were absent. Step 3 routes to `setup` or `auth`
and gives a concrete next action.

**Part 2** — step 6 answers normally. `marker.state` reads `unreachable`, the breaker opens
after the first failures, and subsequent prompts do not each pay a full timeout.

## Touchpoints

```
hooks:  SessionStart*, UserPromptSubmit, PostToolUse, Stop, SessionEnd
tools:  mubit_status
skills: auth, setup
config: endpoint, apiKey
```

## Pass / fail

1. No prompt is delayed by more than its hook budget in either part. **Hard** — the whole
   point of a breaker.
2. No stack trace, and no error text, reaches the user. **Hard.**
3. Step 3 gives an actionable next step rather than a generic apology. **Hard.**
4. `marker.state` reads `unconfigured` in part 1 and `unreachable` in part 2. **Hard**: the
   two states need different fixes and must not be conflated.
5. Prompt 2 of part 2 is faster than prompt 1 — the breaker is open and no longer dialling.

## Known-not-bugs

- **The first offline prompt is slow.** It pays one timeout to discover the endpoint is
  dead. Only a *second* slow prompt is a defect.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| every prompt is slow | `marker.state` and the ring log | the breaker is not opening |
| an error surfaces to the user | the hook wrapper | a hook threw instead of failing closed |

## Teardown

```bash
rm -rf /tmp/tk-w3-04
unset MUBIT_ENDPOINT MUBIT_API_KEY MUBIT_CC_DATA_DIR MUBIT_CC_RUN_ID MUBIT_CC_RUN_STRATEGY
```

Leaving `MUBIT_ENDPOINT=http://127.0.0.1:9` exported would point every later scenario at a
dead port, and env beats `credentials.json`. `lab preflight` fails on exactly this.
