---
name: memory-health
description: Report what is actually in Mubit memory — entry counts, staleness, contradictions and per-section health. Use when memory looks empty or stale and you need to know whether anything was ever stored, rather than whether the instance is reachable.
---

Call `mcp__mubit__mubit_memory_health` — `POST /v2/control/memory_health` — and report what it
says about the store. `limit` (1 to 500) is how many entries it samples; the default is enough
unless the user is specifically asking about an old part of a large run.

## This inspects the store. `mcp__mubit__mubit_status` inspects the connection.

The two answer different questions and are easy to confuse, because both fail as "memory
isn't working".

- **`mcp__mubit__mubit_status`** dials the instance. It tells you whether there is something
  at the other end, whether the key is accepted, and which typed `ConnState` applies. It knows
  nothing about what is stored.
- **`mcp__mubit__mubit_memory_health`** asks what is in there: how many entries, how stale
  they are, whether any of them contradict each other, and how each section is doing. It says
  nothing about the connection — if the instance is unreachable this call does not answer at
  all.

So a healthy connection over an empty store and a full store behind a dead endpoint look
identical from the outside, and they have opposite fixes. Answer the question the user
actually asked before offering a remedy for the other one.

## Reading the answer

- **Zero entries, connection fine.** Nothing was ever written. Under Codex, check the hook
  install first: a plugin-bundled `hooks.json` is inert until it has been merged into
  `$CODEX_HOME/hooks.json` and trusted, and an untrusted hook is skipped silently under
  `codex exec` — no prompt, no warning, exit 0. That is the local failure that produces a
  reachable instance and an empty store. `mubit-memory:setup` walks the merge and the trust.
- **Entries present, but recall keeps returning nothing.** The store is not the problem.
  That is a retrieval or scope question: go to `mubit-memory:doctor` and read
  `recall.empty_reason` from the local status marker, which names the cause outright.
- **Contradictions.** Two stored lessons that disagree. Neither is automatically wrong and
  deleting both loses the argument: prefer a negative `mcp__mubit__mubit_outcome` on the one
  that turned out false, or `mubit-memory:forget` if it should never have existed. Report the
  pair to the user rather than picking a winner yourself.
- **Staleness.** Old is not broken. Say so — a lesson that has not been touched in months is
  usually one that has not been contradicted either.

`session_id` and `user_id` are best left out: the launcher already passes this run's id, and
`user_id` is a retrieval filter, so supplying a value nothing was captured under reports an
empty store that is not empty. The run itself is shared with any Claude Code session in the
same directory, so the counts here cover both harnesses' work.

Use `mubit-memory:doctor` when the complaint is vague — it walks the whole ladder, cheapest
check first, and this call is one rung of it. Use this skill when the question is already
narrowed to what memory contains. Do not poll it in a loop: it samples the store, and the
answer does not change between turns.
