---
name: forget
description: Delete a lesson from Mubit memory, or mark an entry superseded. Prefer a negative outcome for a lesson that is merely wrong — deletion cannot be undone.
disable-model-invocation: false
tools: ["mcp__plugin_mubit-memory_mubit__mubit_forget", "mcp__plugin_mubit-memory_mubit__mubit_outcome"]
---

Call `mubit_forget` with `lesson_id` — the `reference_id` cited in recalled context, or the
`lesson_id` reported by `/mubit-memory:reflect`. Confirm the id and the text with the user
before you call it; there is no dry run.

Pass `lesson_id` and nothing else. The same tool accepts `session_id`, and that argument
deletes **the entire run** — every capture, trace, and lesson in it — not one entry. Never
send it unless the user has asked for exactly that, in those words.

There is also no "mark superseded" operation: nothing flags an entry as replaced. Superseding
is done the way described below — write the corrected lesson, and down-weight the old one so
retrieval stops preferring it.

## Read this before deleting

Deletion is **not undoable**. There is no tombstone to restore from, no recycle bin, and the
entry's accumulated reinforcement history — every outcome that ever credited or blamed it —
goes with it.

A lesson that is merely *wrong* is usually better handled with `mubit_outcome` and a negative
signal:

```
mubit_outcome  reference_id=<the lesson>  outcome=failure  signal=-1
               rationale="<why it was wrong, in one sentence>"
```

The promotion pipeline acts on that. The lesson's confidence drops, it stops surfacing near
the top of recall, and — this is the part deletion cannot do — the *reason* it was wrong is
now part of the record. A deleted lesson teaches the system nothing. A down-weighted one
teaches it something, and the correction survives to shape what gets promoted next.

## When deletion is actually right

- The entry should never have existed: a secret, a customer name, a path from someone else's
  machine that slipped past redaction.
- It is factually about a different project and will keep polluting recall here.
- The user asks for it directly, after being told it cannot be undone.

Everything else — a lesson that is outdated, over-general, or true-but-annoying — is a
`mubit_outcome` with a negative signal, or a fresh, better-worded lesson via
`/mubit-memory:remember` that supersedes it in retrieval. Reach for deletion last, not first.
