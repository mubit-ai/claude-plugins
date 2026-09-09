---
name: forget
description: Delete a lesson, or down-weight one that is merely wrong; use when asked, after saying it cannot be undone.
---

## Step 0 — resolve the binary

No environment variable carries this plugin's path under Codex. Codex lists each skill with the
absolute path of its `SKILL.md`; **this file** is at `<plugin-root>/skills/forget/SKILL.md`, so
the binary is two directories above it:

```
<plugin-root>/bin/admin.mjs
```

Resolve that to an absolute path from this file's own location and use it in every command
below. Do not write `${CLAUDE_PLUGIN_ROOT}`: Codex sets no plugin-root variable of any
spelling, so the shell expands it to nothing and `node /bin/admin.mjs` fails with ENOENT.

Delete with the bundled script, naming the lesson — the `reference_id` cited in recalled
context, or the id on a line of `mubit-memory:reflect` or `mubit-memory:strategies`:

```bash
node <plugin-root>/bin/admin.mjs forget <lesson_id>
```

Confirm the id and the text with the user before you run it; there is no dry run. The script
deletes one lesson by `POST /v2/control/lessons/delete` and nothing else: it has no way to
delete a whole run, on purpose, because that operation removed every capture, trace and
lesson in the run and was one argument away from a single-lesson delete.

There is also no "mark superseded" operation: nothing flags an entry as replaced. Superseding
is done the way described below — write the corrected lesson, and down-weight the old one so
retrieval stops preferring it.

## Read this before deleting

Deletion is **not undoable**. There is no tombstone to restore from, no recycle bin, and the
entry's accumulated reinforcement history — every outcome that ever credited or blamed it —
goes with it.

A lesson that is merely *wrong* is usually better handled with `mcp__mubit__mubit_outcome` and a negative
signal:

```
mcp__mubit__mubit_outcome  reference_id=<the lesson>  outcome=failure  signal=-1
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
`mcp__mubit__mubit_outcome` with a negative signal, or a fresh, better-worded lesson via
`mubit-memory:remember` that supersedes it in retrieval. Reach for deletion last, not first.
