---
name: reflect
description: Ask Mubit to extract lessons from this session's activity and report what it learned. Use when a long session has just finished a real chunk of work, or before a compaction, to bank what was learned while the evidence is still indexed.
---

Reflect over the current run with `mcp__mubit__mubit_reflect` — `POST /v2/control/reflect
{run_id}` — and report the extracted `lessons[]` back to the user: `lesson_id`,
`lesson_type`, and `scope` for each, one line apiece. If the response is empty, say so
plainly; an empty reflect is a real answer, not an error. Use `mcp__mubit__mubit_lessons`
afterwards when the user wants to see what is now visible at `global` scope rather than what
this run just produced.

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

The `SessionEnd` hook already reflects once per session, on the way out, with the same run id.
That covers routine hygiene. Invoke this skill for a **mid-session checkpoint** — a long
session that has just finished a real chunk of work, a debugging arc that ended in something
worth keeping, or the point where the user is about to compact and wants the lessons banked
first. Do not call it every few turns: it is an LLM-backed extraction pass over the run, and
calling it on a run that has barely changed costs time and returns the same lessons.

There is one Codex-specific reason to reach for it more readily than you would under Claude
Code. Codex clamps a `SessionEnd` hook to **three seconds** and kills it there. The plugin
hands the end-of-session flush to a detached process precisely so the reflect survives that,
but a detached child can still be reaped with the terminal — a container exiting, a machine
sleeping — and when it is, that session's reflection is simply lost. A mid-session reflect is
the only thing that banks the lessons before that window. `mubit-memory:doctor` reports
`reflect.status` if you want to know whether the last session's flush actually landed.

One timing detail worth knowing before you read a zero as a failure: reflection only sees
items the server has already **indexed**. A reflect fired immediately after a burst of
captures or an explicit `mubit-memory:remember` can honestly return `lessons_stored: 0`
where the same run reflected about a minute later returns them. If you have just written
something you expect to be reflected on, give ingest a moment rather than reflecting twice.
