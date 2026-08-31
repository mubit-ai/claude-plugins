---
name: remember
description: Save a durable lesson, rule, or preference to Mubit memory. Use when the user states a standing preference, when you discover a non-obvious constraint, or when an approach fails in a way worth never repeating.
disable-model-invocation: false
tools: ["mcp__plugin_mubit-memory_mubit__mubit_learned"]
---

Routine work is captured automatically — do not use this for "I read a file" or "I ran the
tests". The capture hooks already write tool activity, prompts, and turn outcomes into this
run without being asked. Using the explicit verb for that fills the store with duplicates of
what is already there and buries the entries that matter. Use it for knowledge that should
outlive this session.

Reach for it when:

- the user states a standing preference ("always run the suite before you commit");
- you discover a constraint that is not visible in the code ("the operator's reconcile loop
  requires the CRD applied before the StatefulSet, or it wedges");
- an approach fails in a way worth never repeating, and you know *why* it failed.

Pick a template, which sets `lesson_type` and `lesson_scope` for you:

| Template | Use for | type / scope |
| --- | --- | --- |
| `CODING_RULE` | lint rules, naming, style constraints | rule / global |
| `DEBUG_SUCCESS` | a debugging approach that worked | success / session |
| `DEBUG_FAILURE` | an approach that failed, and why | failure / session |
| `PREFERENCE` | how this user wants things done | preference / global |
| `ARCHITECTURE_INSIGHT` | system quirks, dependency behaviour | observation / global |
| `BUILD_CONFIG` | build/deploy settings that work | rule / global |
| `API_PATTERN` | SDK quirks, integration notes | observation / session |
| `TEST_STRATEGY` | test approaches that proved effective | success / global |

The pair is the whole point of choosing a template. `lesson_type` decides how retrieval
weighs the entry; `lesson_scope` decides who ever sees it again — a `global` entry follows
the user into every project, a `session` entry stays with related sessions, and a `run`
entry dies with this run. Picking the wrong template is not a cosmetic error.

Write the lesson as an imperative with its condition attached — "When X, do Y, because Z" —
not as a narrative of what just happened. "Fixed the flaky test" is worth nothing to a future
session; "When a Tokio test hangs on `block_on`, run it with `--test-threads=1` first,
because the runtime is already inside a runtime" is worth something. One lesson per call,
and keep it self-contained: it will be read months later with none of this conversation
around it.

`mubit_learned` returns when the write is **queued**, not stored. Do not immediately search
for what you just saved; it will not be there yet. Ingest runs asynchronously — the item is
embedded and indexed after the call returns, so a search fired in the same turn honestly
returns nothing and that is not a sign that memory is broken. The same applies to
`/mubit-memory:reflect`: reflection only sees items the server has already indexed, so
reflecting seconds after a write reports zero lessons where reflecting a minute later
reports them.

Note the one place the tool is narrower than the table: `mubit_learned` is the
low-boilerplate path, and every entry it writes is stored as `success`, at whatever
`mcpLessonScope` (`MUBIT_MCP_LESSON_SCOPE`) is set to — `session` by default, which is what
lets a lesson written here reach a later session at all. Set it to `run` to keep every
agent-written lesson inside the run that wrote it, or to `global` to have them follow the
user between projects. Use the table to decide what the entry *is* and to word it
accordingly. If you need an exact type/scope pair written directly, that is `mubit_remember`,
which is off by default and restored via the `mcpTools` setting.
