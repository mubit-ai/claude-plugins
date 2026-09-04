---
name: reflect
description: Ask Mubit to extract lessons from this session's activity and report what it learned. Use when the user wants lessons banked now rather than at session end, or asks what memory holds for this project.
disable-model-invocation: false
allowed-tools: ["Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/admin.mjs reflect:*)", "Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/admin.mjs lessons:*)"]
---

Reflect over the current run with the bundled script — `POST /v2/control/reflect {run_id}`
behind it — and relay what it prints: one line per extracted lesson, with the lesson's id,
type, importance and scope on the line.

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/admin.mjs reflect
```

If it reports no lessons, say so plainly; an empty reflect is a real answer, not an error.
Neither command here is an MCP tool: `mubit_reflect` and `mubit_lessons` left the default
tool surface so that a session pays nothing to list them, and this script reaches the same
two routes.

## The standing catalogue

When the user wants what memory holds rather than what this run just produced:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/admin.mjs lessons                    # this run, plus what travelled
node ${CLAUDE_PLUGIN_ROOT}/bin/admin.mjs lessons --scope run        # this run alone
node ${CLAUDE_PLUGIN_ROOT}/bin/admin.mjs lessons --scope global     # only what has travelled
node ${CLAUDE_PLUGIN_ROOT}/bin/admin.mjs lessons --importance high --limit 10
```

The three scopes answer three different questions, and asking the wrong one is how a healthy
store reads as empty:

- **no `--scope`** — this run's lessons, plus every lesson stored above `run` scope by any
  run. The honest default, and the right one for "what do we know here".
- **`--scope run`** — this run alone. What this session has banked so far.
- **`--scope session` / `global`** — only the lessons that have travelled, from every run
  the key can see. Read a zero here as a real zero rather than as a fault.

The listing says what it is showing and how many matched. A lesson this conversation has
already been shown is printed as its id and first clause, marked `(seen earlier)`;
`mubit_dereference` returns the text. `--json` is the whole catalogue with its metadata.

## Why the explicit call exists at all

Mubit already extracts lessons on its own, in the background, as it ingests. It does that
perfectly well — and then stops there. Lessons extracted that way keep the scope they were
extracted at, typically `run`, and **a `run`-scoped lesson is invisible to the next session**.

The consequence is concrete: the store can look busy, lessons accumulating steadily, while
nothing ever crosses the boundary into a future session. Widening a lesson's scope is
reserved for the explicit reflect path — this skill, and the one `SessionEnd` issues.

Widening is still gradual once a lesson is on that path. Rules are never scope-promoted, since
they are enforced as written; anything else has to establish itself before it travels. Expect
lessons to widen over several sessions, not on the first reflect.

## When to invoke it

`session-end.mjs` already reflects once per session, on the way out, with the same run id.
That covers routine hygiene. Invoke this skill for a **mid-session checkpoint** — a long
session that has just finished a real chunk of work, a debugging arc that ended in something
worth keeping, or the point where the user is about to compact and wants the lessons banked
first. Do not call it every few turns: it is an LLM-backed extraction pass over the run, and
calling it on a run that has barely changed costs time and returns the same lessons.

One timing detail worth knowing before you read a zero as a failure: reflection only sees
items the server has already **indexed**. A reflect fired immediately after a burst of
captures or an explicit `/mubit-memory:remember` can honestly report `lessons_stored: 0`
where the same run reflected about a minute later returns them. If you have just written
something you expect to be reflected on, give ingest a moment rather than reflecting twice.
