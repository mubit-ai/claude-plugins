# W3-03 — A build command fails in a repo you do not know

**Family** W3 onboarding · **Moments** M8* · **Sessions** 1 · **Duration** ~8 min

**Backend** hosted · **Arms** plugin-on only

## What this proves

That when something looks wrong with memory itself, the plugin has a diagnostic path that
reports *what is actually wrong* rather than guessing — and that the diagnosis distinguishes
"the backend is down" from "there is nothing stored yet", which look identical from the
outside and need opposite responses.

## Setup

W2-01's Setup, with `TK=/tmp/tk-w3-03` and `MUBIT_CC_RUN_ID=tk-w3-03`.

## Steps

1. Open a session with `--debug-file "$TK/s1.log"`.
2. Prompt: `My project memory looks completely empty and I do not know whether it is even connected. Find out what is actually wrong.`
3. Observe which surface fires.
4. `/exit`, then compare its verdict against the kit's:
   `node /Users/eldaru/Mubit/plugin-lab/testkit/bin/lab.mjs preflight --plugin-dir "$PLUG"`

## Expect

The `doctor` skill or `mubit_diagnose` fires, and the answer names a state —
`unreachable`, `auth_failed`, `server_error`, `no_evidence`, a stuck ingest job — rather than
offering general advice.

## Touchpoints

```
hooks:  UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop
tools:  mubit_diagnose*, mubit_status
skills: doctor
config: endpoint, apiKey
```

## Pass / fail

1. A diagnostic surface fires rather than the model reasoning from first principles. **Hard.**
2. The verdict names a concrete state. **Hard.**
3. The verdict agrees with `lab preflight`. **Hard** — two diagnostics that disagree are
   worse than one, and this is the check that catches it.

## Known-not-bugs

- **`mubit_status` says healthy while recall returns nothing.** Both are true: health and
  retrieval are different routes. A diagnosis that stops at health has stopped too early —
  which is precisely why `lab preflight` dials recall rather than pinging health.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| generic advice, no tool call | `mcpTools` | `mubit_diagnose` is not in the allowlist |
| disagrees with `lab preflight` | both outputs side by side | one of them is reading a cached verdict |

## Teardown

`rm -rf /tmp/tk-w3-03` and unset the `MUBIT_*` exports.
