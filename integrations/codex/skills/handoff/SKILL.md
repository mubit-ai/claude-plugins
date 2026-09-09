---
name: handoff
description: Hand work to another agent through Mubit, list the handoffs open in this run, or answer one with a verdict. Use when a task changes hands between agents, or when a subagent's result is waiting for review.
---

**This skill never installs anything.** It runs one Node process from the plugin directory,
which writes a handoff or a feedback entry to the user's own Mubit instance under the current
run. No packages, no services, no changes to the shell.

## Step 0 — resolve the binary

No environment variable carries this plugin's path under Codex. Codex lists each skill with the
absolute path of its `SKILL.md`; **this file** is at `<plugin-root>/skills/handoff/SKILL.md`,
so the binary is two directories above it:

```
<plugin-root>/bin/handoff.mjs
```

Resolve that to an absolute path from this file's own location and use it in every command
below. Do not write `${CLAUDE_PLUGIN_ROOT}`: Codex sets no plugin-root variable of any
spelling, so the shell expands it to nothing and `node /bin/handoff.mjs` fails with ENOENT.

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
node <plugin-root>/bin/handoff.mjs send --to <agent> --action review "<the note>" --json
```

`--to` is the receiving agent's role — `claude-code` for a Claude Code session in this same
directory, `codex` for another Codex session, or whatever an orchestrator registered. The note
is the argument. `--action` is one of `review`, `continue`, `approve`, `execute`; the default
is `continue`. `--task <id>` ties the note to a task id when the caller has one.

Print the handoff id back. It is what feedback names.

## List

```bash
node <plugin-root>/bin/handoff.mjs list --open --json
```

Without `--open`, every handoff in the run, each with the feedback that answered it. "Open"
is computed by this command, not by the instance: a handoff is open when no feedback entry
names its id. The instance never flips a handoff's `active` flag, so do not read that field as
its state.

## Answer

```bash
node <plugin-root>/bin/handoff.mjs feedback <handoff_id> --verdict approve --comments "<why>" --json
```

`--verdict` is required and is one of `approve`, `request_changes`, `block`, `acknowledge`.
`acknowledge` is for a note that needed no decision. Say what the verdict was when you report
back, and say it in the same breath as what was reviewed.

## The run

Handoffs are scoped to a run. Without `--run <run_id>` the command reads the newest run marker
in the plugin's data directory; when two sessions are live on this machine it refuses with
`ambiguous_run` and names the candidates rather than guessing, and it refuses `default`
outright because that is the id a run falls back to when nothing configured one. The
SessionStart block at the top of the conversation prints this session's run id; pass it with
`--run` when asked to. If the command reports `no_run`, pass `--data-dir` with the directory
`/mubit-memory:doctor` prints.

## What a handoff is not

- **It is not a message queue.** The receiving agent sees it when it lists, or when its next
  session's resume briefing includes open handoffs. Nothing is pushed.
- **It is not cross-run.** A handoff lives in one run id. A subagent's note is filed under the
  parent's run — the sub-run id never reaches the instance — and there is no way to address a
  note to a run other than the one this command acts in.
- **It is not memory.** A handoff is state about who owes whom what, right now. A durable
  lesson is `/mubit-memory:remember`; a constraint for the rest of this run is
  `/mubit-memory:pin`.
