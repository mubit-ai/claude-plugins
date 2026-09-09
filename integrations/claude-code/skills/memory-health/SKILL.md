---
name: memory-health
description: "Report what is actually stored: counts, staleness, contradictions; use when the question is whether anything was ever stored."
disable-model-invocation: false
tools: ["mcp__plugin_mubit-memory_mubit__mubit_memory_health", "mcp__plugin_mubit-memory_mubit__mubit_status"]
---

Call `mubit_memory_health` — `POST /v2/control/memory_health` — and report what it says about
the store. `limit` (1 to 500) is how many entries it samples; the default is enough unless the
user is specifically asking about an old part of a large run.

## This inspects the store. `mubit_status` inspects the connection.

The two answer different questions and are easy to confuse, because both fail as "memory
isn't working".

- **`mubit_status`** dials the instance. It tells you whether there is something at the other
  end, whether the key is accepted, and which typed `ConnState` applies. It knows nothing
  about what is stored.
- **`mubit_memory_health`** asks what is in there: how many entries, how stale they are,
  whether any of them contradict each other, and how each section is doing. It says nothing
  about the connection — if the instance is unreachable this call does not answer at all.

So a healthy connection over an empty store and a full store behind a dead endpoint look
identical from the status line, and they have opposite fixes. Answer the question the user
actually asked before offering a remedy for the other one.

## Reading the answer

- **Zero entries, connection fine.** Nothing was ever written. Check that capture is on, and
  remember that an accepted ingest is *queued*, not stored — a run that just started can be
  legitimately empty for a minute.
- **Entries present, but recall keeps returning nothing.** The store is not the problem.
  That is a retrieval or scope question: go to `/mubit-memory:doctor` step 1 and read
  `recall.empty_reason` from the local status marker, which names the cause outright.
- **Contradictions.** Two stored lessons that disagree. Neither is automatically wrong and
  deleting both loses the argument: prefer a negative `mubit_outcome` on the one that turned
  out false, or `/mubit-memory:forget` if it should never have existed. Report the pair to the
  user rather than picking a winner yourself.
- **Staleness.** Old is not broken. Say so — a lesson that has not been touched in months is
  usually one that has not been contradicted either.

`session_id` and `user_id` are best left out: the launcher already passes this run's id, and
`user_id` is a retrieval filter, so supplying a value nothing was captured under reports an
empty store that is not empty.

This is step 3 of `/mubit-memory:doctor`, which walks the whole ladder cheapest check first.
Use the doctor skill when the complaint is vague; use this one when the question is already
narrowed to what memory contains. Do not poll it in a loop — it samples the store, and the
answer does not change between turns.
