---
name: checkpoint
description: Save a named snapshot of where this run has got to, stored verbatim. Use when the user is about to do something risky or destructive, when a compaction is coming that they want to survive on their own terms, or when they ask to mark a point they may need to come back to.
---

Call `mcp__mubit__mubit_checkpoint` — `POST /v2/control/checkpoint` — with the state you are
holding. `snapshot` is the only required argument; `label` is a short name the user can ask
for later and is worth passing every time.

## What goes in `snapshot`

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
two tests still red". It is worthless in six months and nobody wants it surfacing in an
unrelated session. That is a checkpoint.

**Knowledge** is true regardless of which run learned it: "a plugin-bundled `hooks.json` is
inert under Codex", "this team wants small PRs". That is a lesson — save it with
`mubit-memory:remember`, which classifies it and gives it a scope so it reaches later sessions
on purpose.

Getting this backwards costs something in both directions. A checkpoint used for knowledge
buries a durable fact in a snapshot nobody will search for. A lesson used for run state turns
memory into a session log, and every later recall pays for it.

## When to call it

The plugin registers a `PreCompact` hook that checkpoints on the way into a compaction. That
is the automatic one, and it fires on the host's schedule — when the window fills — which is
exactly the moment nobody can ask for. This tool is the half a person asks for: before a
destructive migration, a history rewrite, a long refactor, or a point the user says they might
want to walk back to.

There is a Codex-specific reason not to rely on the automatic half. A plugin-bundled
`hooks.json` is inert here: the registrations only take effect once they have been merged into
`$CODEX_HOME/hooks.json` and trusted, which `mubit-memory:setup` walks through. On an install
where that never happened, the `PreCompact` checkpoint has never fired and nothing says so.
This tool reaches the instance over MCP rather than through a hook, so it works either way —
and if the user is surprised there was no automatic checkpoint, that is the thing to check.

Do not checkpoint reflexively or on a timer. Each call is a durable write, and a run littered
with near-identical snapshots is harder to recover from than one with three good ones. The run
is also shared with any Claude Code session in the same directory, so what you store here is
what that session's reader finds too.
