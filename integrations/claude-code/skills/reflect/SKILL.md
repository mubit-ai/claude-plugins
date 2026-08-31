---
name: reflect
description: Ask Mubit to extract lessons from this session's activity and report what it learned.
disable-model-invocation: false
tools: ["mcp__plugin_mubit-memory_mubit__mubit_reflect", "mcp__plugin_mubit-memory_mubit__mubit_lessons"]
---

Reflect over the current run — `POST /v2/control/reflect {run_id}` — and report the extracted
`lessons[]` back to the user: `lesson_id`, `lesson_type`, and `scope` for each, one line
apiece. If the response is empty, say so plainly; an empty reflect is a real answer, not an
error. Use `mubit_lessons` afterwards when the user wants the standing catalogue rather than
what this run just produced.

`mubit_lessons` answers three different questions off its one `scope` argument, and asking the
wrong one is how a healthy store reads as empty:

- **no `scope`** — this run's lessons, plus every lesson stored above `run` scope by any run.
  The honest default, and the right one for "what do we know here".
- **`scope: "run"`** — this run alone. What this session has banked so far.
- **`scope: "session"` / `"global"`** — only the lessons that have travelled, from every run
  the key can see. Read a zero here as a real zero rather than as a fault.

Every answer carries a `mubit_lessons_guard` note saying what was shown and how many matched.
When it says `partial: true`, report the result as partial and quote no total — there is none.

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
captures or an explicit `/mubit-memory:remember` can honestly return `lessons_stored: 0`
where the same run reflected about a minute later returns them. If you have just written
something you expect to be reflected on, give ingest a moment rather than reflecting twice.
