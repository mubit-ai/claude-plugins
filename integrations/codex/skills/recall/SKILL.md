---
name: recall
description: Search Mubit memory for lessons, rules, facts, or past work relevant to a specific question. Use when you need detail beyond the memory already injected into this turn.
---

Relevant memory was **already injected** at the top of this turn by the Mubit recall hook.
Read it before searching. Most of the time you do not need this skill.

When you do:

1. Issue **one** broad `mcp__mubit__mubit_recall` call. Not three narrow ones.
2. Read the evidence. If it answers the question, stop.
3. Only if the first call returned nothing usable, issue one reformulated call.

Never fan out into parallel searches across sub-topics. Mubit retrieval is hybrid
(semantic + lexical + recency + graph); one well-formed query beats four keyword slices at
a quarter of the latency. Two calls is the ceiling.

Cite what you use by its `reference_id`, and call `mcp__mubit__mubit_outcome` with those
`entry_ids` when recalled memory turns out to be right or wrong. That feedback is what makes
the next recall better.

## Writing the query

Query with the *question*, not with keywords. "Why does the drain hook retry twice on a
5xx" retrieves better than "drain retry 5xx", because the semantic half of the hybrid index
has something to match on and the lexical half still catches the identifiers. Include the
identifiers you already know — file names, symbol names, error strings — inside the
sentence rather than instead of it.

A reformulation is a *different concept*, not a synonym. If "auth failed on ingest" returned
nothing, "401 from the control plane" is a reformulation; "authentication failure ingest" is
the same query with the words shuffled and will return the same nothing.

## When two calls return nothing

Say so and move on. Empty is a real answer: it means nothing about this was ever captured,
and a third query will not invent it. If the answer you then work out by hand is worth
keeping, save it with `mubit-memory:remember` so the next session's recall is not empty too.

## Memory this run shares with Claude Code

A Codex session and a Claude Code session started in the same directory derive the **same**
Mubit run and read the same store. So a query here can return work done in the other harness,
and vice versa — the `agent_id` on an entry (`codex` or `claude-code`) is what says which one
produced it. That is worth mentioning to the user when it explains where an entry came from,
and worth ignoring otherwise: it is one memory, and which tool wrote a fact rarely changes
whether the fact is true.

## Deep searches

If the question genuinely needs several angles — "what do we know about X" across an
unfamiliar area — spawn a sub-agent, point it at this skill, and ask it for a synthesis
rather than a transcript. The value is the isolation: the raw evidence lands in its context
instead of yours, and you get back the conclusion and a short list of `reference_id`s.

Codex has no plugin-defined agent types, so there is no named `mubit-recall` agent to invoke
the way the Claude Code plugin offers one. A generic sub-agent given this skill does the same
job.
