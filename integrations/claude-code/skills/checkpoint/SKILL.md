---
name: checkpoint
description: Save a named snapshot of where this run has got to, stored verbatim. Use when the user is about to do something risky or destructive, when a compaction is coming that they want to survive on their own terms, or when they ask to mark a point they may need to come back to.
disable-model-invocation: false
allowed-tools: ["Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/admin.mjs checkpoint:*)"]
---

Run the bundled script with the snapshot on stdin. It posts `POST /v2/control/checkpoint`
under this session's run, and nothing else:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/admin.mjs checkpoint --label "<short name>" <<'SNAPSHOT'
<the snapshot>
SNAPSHOT
```

`--label` is required: a short name the user can ask for later. The snapshot is whatever is on
stdin (`--file <path>` reads it from a file instead). The script prints the checkpoint id it
was given back; relay it. It does not call an MCP tool — `mubit_checkpoint` left the default
tool surface so that a session pays nothing to list it, and this script is how the skill
reaches the same route.

## What goes in the snapshot

It is stored **verbatim and unsummarised**. Nothing rewrites it, shortens it or extracts
anything from it, which cuts both ways: whatever you write is exactly what a future reader
gets, and a one-line headline restores nothing.

Write it for someone who has lost the conversation entirely — which is the only situation in
which it will ever be read. What we were doing and why, what is finished, what is half-done
and how far, the exact branch, file paths and commands in play, and the next concrete step.
Prose is fine. Length is fine. This is the one write in the plugin where compressing is the
mistake.

## A checkpoint is run state, not knowledge

This is the distinction that decides whether to use this skill at all.

**Run state** is true now and false tomorrow: "mid-migration on `feat/x`, three files edited,
the codex suite still red on two dist tests". It is worthless in six months and nobody wants
it surfacing in an unrelated session. That is a checkpoint.

**Knowledge** is true regardless of which run learned it: "`npm run verify` deletes the
vendored server bundle", "this team wants small PRs". That is a lesson — save it with
`/mubit-memory:remember`, which classifies it and gives it a scope so it reaches later
sessions on purpose.

Getting this backwards costs something in both directions. A checkpoint used for knowledge
buries a durable fact in a snapshot nobody will search for. A lesson used for run state turns
memory into a session log, and every later recall pays for it.

## When to call it

The `PreCompact` hook already checkpoints on the way into a compaction. That is the automatic
one, and it fires on the host's schedule — when the window fills — which is exactly the moment
nobody can ask for. This skill is the half a person asks for: before a destructive migration,
a history rewrite, a long refactor, or a deliberate `/clear` the user wants to walk back from.

Do not checkpoint reflexively or on a timer. Each call is a durable write, and a run littered
with near-identical snapshots is harder to recover from than one with three good ones.
