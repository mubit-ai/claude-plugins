# W1-04 — About to run something destructive

**Family** W1 everyday coding · **Moments** M3* · **Sessions** 1 · **Duration** ~5 min

**Backend** hosted · **Arms** plugin-on with `preToolWarnings` on, plugin-on with it off

The most interruptive surface the plugin has, and it is **off by default**. This scenario
exists mainly to keep that fact visible: a reader of the coverage matrix should be able to
see that M3 is opt-in, rather than assume it is part of the product.

## What this proves

That `PreToolUse` warnings fire when enabled, carry a rule the user can act on, and stay
silent when not enabled — and that turning them on does not push `PreToolUse` past its 3 s
budget, because a slow pre-tool hook stalls every single tool call.

## Setup

W2-01's Setup, with `TK=/tmp/tk-w1-04` and `MUBIT_CC_RUN_ID=tk-w1-04`, plus:

```bash
export MUBIT_CC_PRE_TOOL_WARNINGS=1
```

Seed a rule about destructive commands first — walk W1-03 with
`never run git reset --hard without asking` as the rule.

## Steps

1. Open a session with `--debug-file "$TK/s1.log"`.
2. Prompt: `Discard all my local changes and match origin/main.`
3. Observe whether a `<mubit-rules>` block appears before the tool call.
4. Repeat the whole scenario with `MUBIT_CC_PRE_TOOL_WARNINGS` unset.

## Expect

**With warnings on** — a rules block before the `Bash` call, naming the stored rule.
**With warnings off** — nothing. The tool call proceeds exactly as it would without the
plugin.

## Touchpoints

```
hooks:  UserPromptSubmit, PreToolUse*, PostToolUse, Stop
tools:  —
skills: —
config: preToolWarnings
```

## Pass / fail

1. With the flag on, a rules block appears before the tool call. **Hard.**
2. With the flag off, nothing appears. **Hard** — an interruptive surface that ignores its
   own opt-out is a defect regardless of how good the warning is.
3. No `PreToolUse` overrun in the ring log with the flag on. **Hard** — this hook runs on
   every tool call, so its tail is felt more than any other.

## Known-not-bugs

- **The warning fires on a tool call you did not think was destructive.** The rule is matched
  semantically; over-firing is a tuning question, not a pass/fail one. Record it.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| no block with the flag on | `--json` → `marker.recall.empty_reason` | no matching rule was stored; seed W1-03 first |
| a block with the flag off | `lib/config.mjs` precedence | env beats config; check for a stale export |

## Teardown

`rm -rf /tmp/tk-w1-04`, and `unset MUBIT_CC_PRE_TOOL_WARNINGS` before any other scenario.
