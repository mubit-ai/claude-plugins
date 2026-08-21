---
type: llm
focus: last_message
weight: 1
---

The reply should answer the coding question and nothing else.

It PASSES if it contains the requested `slugify` function and at most a sentence of
explanation about the function itself.

It FAILS if the reply mentions memory capture, recall, stored lessons, a memory plugin, a
`<mubit-memory>` block, ingest, or any other bookkeeping the user did not ask about. A user
writing a small utility should not be able to tell that a memory layer is running.
