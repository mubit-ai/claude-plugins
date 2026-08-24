---
name: strategies
description: Surface the pattern across many stored lessons rather than any single one. Use when the user asks what memory has learned in general, why the same class of mistake keeps recurring, or how this project tends to work — not when they have one specific question.
---

Call `mcp__mubit__mubit_strategies` — `POST /v2/control/strategies` — and report the
strategies it returns in the user's own terms: what the pattern is, and what it was inferred
from. Ask for a small number and report all of them; a wall of generalisations is less useful
than three good ones.

## The one thing to be clear about

**`mcp__mubit__mubit_strategies` is the pattern *across* lessons.
`mcp__mubit__mubit_lessons` reads the individual lessons themselves.**

Every other retrieval tool here answers with entries. `mcp__mubit__mubit_recall` finds the
lessons that match a question, `mcp__mubit__mubit_lessons` lists the catalogue,
`mcp__mubit__mubit_diagnose` matches an error's shape, `mcp__mubit__mubit_dereference`
fetches the one whose `reference_id` you already hold. This is the only one that answers with
a *shape over* many of them: it clusters stored lessons into emergent strategies, so what
comes back is a generalisation the server derived, not a record anybody wrote.

That makes the choice easy in both directions. "Why do we keep breaking the build the same
way?" and "what has this project learned about testing?" are strategy questions. "What did we
decide about the recall budget?" is not — that has one answer, and `mcp__mubit__mubit_recall`
finds it faster and quotes it. Do not reach for this tool to locate a single lesson; it will
hand back a summary of a cluster the lesson happens to sit in.

## Arguments

- `max_strategies` — 1 to 50. Ask for five to ten. The value of the answer is that it is
  short; fifty clusters over a few dozen lessons is the same information with the pattern
  taken back out.
- `lesson_types` — narrows which lessons get clustered, when the user is asking about one
  kind of thing ("what have we learned about failures?").
- `session_id` and `user_id` — leave both out. The launcher already passes this run's id, and
  `user_id` is a retrieval *filter* rather than a label: a value nothing was captured under
  matches nothing, so inventing one is how you get an empty answer from a full store.

Under Codex the run is shared. A Codex session and a Claude Code session in the same directory
map to one run by design, so the lessons being clustered here are both harnesses' work. That
is the intent, and it is worth saying when a pattern surfaces that this session did not
produce.

## Reporting it

A strategy is inferred, not stated. It has less standing than a `rule`, which somebody wrote
down on purpose and which is enforced as written. Say which you are relaying — presenting a
clustered generalisation as though the user had asked for it is how a plausible pattern
becomes a fact nobody agreed to.

An empty or thin answer is usually not a fault. Clustering needs a body of lessons to cluster,
and a young run does not have one yet. Before reporting that memory has no patterns, check
that it has anything at all: `mubit-memory:memory-health` distinguishes "nothing was ever
stored" from "stored, and there is genuinely no pattern in it".
