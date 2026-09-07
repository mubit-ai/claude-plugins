---
name: handoff
description: Hand work to another agent through Mubit, list the handoffs open in this run, or answer one with a verdict; use when a task changes hands between agents, or when a subagent's result is waiting for review.
disable-model-invocation: false
allowed-tools: ["Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/handoff.mjs:*)"]
---

**This skill never installs anything.** It runs one Node process from the plugin directory,
which writes a handoff or a feedback entry to the user's own Mubit instance under the current
run. No packages, no services, no changes to the shell.

## What a handoff is

A handoff is a note from one agent to another inside this run — "review this", "continue from
here", "approve before I execute" — filed as a `handoff` entry that the next agent, or the
next session, finds. Feedback is the answer: a verdict (`approve`, `request_changes`, `block`,
`acknowledge`) with optional comments, filed against the handoff's id. A handoff with no
feedback naming it is **open**.

Every subagent already files one without being asked. When a subagent finishes, the plugin
stores its result as a handoff from that subagent to this session's role, with
`requested_action: review`. So after a fan-out, `handoff list --open` is the list of subagent
results nobody has looked at yet, and answering each one is how the list empties.

## Send

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/handoff.mjs" send --to <agent> --action review "<the note>" --data-dir "${MUBIT_CC_DATA_DIR:-${CLAUDE_PLUGIN_DATA}}" --run <run_id> --json
```

`--to` is the receiving agent's role — `codex` for a Codex session in this same directory,
`claude-code` for another Claude Code session, or whatever an orchestrator registered. The
note is the argument. `--action` is one of `review`, `continue`, `approve`, `execute`; the
default is `continue`. `--task <id>` ties the note to a task id when the caller has one.

Print the handoff id back. It is what feedback names.

## List

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/handoff.mjs" list --open --data-dir "${MUBIT_CC_DATA_DIR:-${CLAUDE_PLUGIN_DATA}}" --run <run_id> --json
```

Without `--open`, every handoff in the run, each with the feedback that answered it. "Open"
is computed by this command, not by the instance: a handoff is open when no feedback entry
names its id. The instance never flips a handoff's `active` flag, so do not read that field as
its state.

## Answer

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/handoff.mjs" feedback <handoff_id> --verdict approve --comments "<why>" --data-dir "${MUBIT_CC_DATA_DIR:-${CLAUDE_PLUGIN_DATA}}" --run <run_id> --json
```

`--verdict` is required and is one of `approve`, `request_changes`, `block`, `acknowledge`.
`acknowledge` is for a note that needed no decision. Say what the verdict was when you report
back, and say it in the same breath as what was reviewed — a verdict with nothing attached
is not something a person can act on.

## Two flags every command carries, and why

**`--data-dir`.** The command runs through the Bash tool, and that call
does not inherit `CLAUDE_PLUGIN_DATA` — it arrives empty — so without the flag the command
guesses which install's store to read and can land on a sibling install whose run markers
name a session this one never had. Pass it exactly as written above: a set
`MUBIT_CC_DATA_DIR` wins, the way it does for every hook.

**`--run`.** Handoffs are scoped to a run, and the run id is printed in the SessionStart block
at the top of the conversation and by `/mubit-memory:doctor`. Without it the command reads the
newest run marker; when two sessions are live on this machine it refuses with `ambiguous_run`
and names the candidates rather than guessing, and it refuses `default` outright because that
is the id a run falls back to when nothing configured one. Re-run with the id from the
SessionStart block; do not pick one from the list by guessing which looks right.

Keep the command a bare `node …` invocation. An `ENV=… node …` prefix is no longer a `node`
command and will stop for a permission prompt.

## What a handoff is not

- **It is not a message queue.** The receiving agent sees it when it lists, or when its next
  session's resume briefing includes open handoffs. Nothing is pushed.
- **It is not cross-run.** A handoff lives in one run id. A subagent's note is filed under the
  parent's run — the sub-run id never reaches the instance — and there is no way to address a
  note to a run other than the one this command acts in.
- **It is not memory.** A handoff is state about who owes whom what, right now. A durable
  lesson is `/mubit-memory:remember`; a constraint for the rest of this run is
  `/mubit-memory:pin`.
