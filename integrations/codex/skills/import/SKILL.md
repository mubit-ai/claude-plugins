---
name: import
description: "Backfill Mubit memory from the Codex rollouts and Claude Code transcripts already on this machine, so a fresh install knows what happened before it. Use when the user asks to import, backfill or seed their history, or when memory is empty because the plugin was installed after the work. Sends nothing without an explicit --send."
---

**This skill uploads work history to the configured Mubit instance.** It runs one Node process
from the plugin directory, reads `~/.codex/sessions` — and, when asked, Claude Code's
`~/.claude/projects` — and ingests what it finds. Nothing is sent unless `--send` is on the
command line.

**Do not run it on your own initiative, and do not pass `--send` unless the user said to.**
The Claude Code copy of this skill enforces that with `disable-model-invocation: true`; Codex
has no such key, so here it is a rule rather than a mechanism. It is a stricter rule than the
one on `activity` and `dashboard`, which only read. This one takes months of somebody's
transcripts — every prompt, every command, every file they touched — and puts them on a
server.

## Step 0 — resolve the binary

No environment variable carries this plugin's path under Codex. Codex lists each skill with the
absolute path of its `SKILL.md`; **this file** is at `<plugin-root>/skills/import/SKILL.md`, so
the binary is two directories above it:

```
<plugin-root>/bin/import.mjs
```

Resolve that to an absolute path from this file's own location and use it in every command
below. Do not write `${CLAUDE_PLUGIN_ROOT}`: Codex sets no plugin-root variable of any
spelling, so the shell expands it to nothing and `node /bin/import.mjs` fails with ENOENT.

## Always dry-run first, and show them the number

```bash
node <plugin-root>/bin/import.mjs
```

That is the whole command, and it sends nothing: a dry run is what happens when nobody says
otherwise. It prints where it is reading from, the scope it resolved, and how many items it
*would* send — one line per source.

**Relay that number and the scope before offering to send.** "This would send 2,300 items from
41 rollouts across 3 runs" is a sentence somebody can answer. "Shall I import your history?"
is not.

## Then, only if they say so

```bash
node <plugin-root>/bin/import.mjs --send
```

## Two sources

Under this host the default is `--source codex`: the rollouts Codex writes under
`~/.codex/sessions` (or `$CODEX_HOME/sessions`). `--source claude-code` reads Claude Code's
transcripts under `~/.claude/projects` instead, and `--source all` reads both. The scope, the
item cap, the cursors and the redaction pipeline are the same whichever is chosen, and the
report counts each source separately so the number can be checked against its directory.

Offer `--source all` when the user has both tools on the machine and asks to import their
history rather than *this* tool's history. A Codex item carries `tool:codex` in its env tags,
so the two histories stay tellable apart once stored.

Two things the Codex side skips, and says so: the reviewer threads Codex runs to approve its
own actions (their prompts are other threads' transcripts, and importing them would file every
reviewed session twice), and the preamble Codex writes in the user's voice at the top of every
thread since 0.149.

## Scope

The default is **the project you are in, plus every git worktree linked to it**. A rollout is
laid out by date rather than by project, so every one is opened and its turns decide, by the
directory each ran in, whether they fall inside the scope. A thread that moved between
directories is attributed turn by turn.

`--all` is every project on the machine. Offer it only if asked for it: it will include
personal projects, client work, and anything else that was ever opened in either CLI.

`--project <dir>` imports a different project instead of the current one.

## What it does not send

Three things are dropped rather than scrubbed, and it says how many of each:

- **Denylisted paths.** A tool call whose subject is a `.env`, a key file, or anything git is
  ignoring is dropped whole. A scrubbed `.env` is still a map of which secrets a project holds.
  A Codex `FileChange` names its paths outright, and those are checked too.
- **The plugin's own traffic.** Memory does not record itself recalling — an `mcp__mubit__*`
  call in a rollout is dropped.
- **Lines over the reader's size cap.** A committed bundle's inline sourcemap is ~700 KB on one
  line; it is skipped and counted.

Everything that *is* sent goes through the same redaction pipeline as live capture.

## What to say about the numbers

`denied`, `oversize` and `this answer is incomplete` are **findings**, not decoration:

1. **`denied`** is how many tool calls the path denylist refused. A non-zero count is the
   pipeline working, and worth saying so — it is the answer to "did this upload my `.env`".
2. **`oversize`** is how many lines were too large to read. Those are gone from the import and
   nothing will go back for them.
3. **`this answer is incomplete`** means it stopped at a bound — the item cap, the file cap, or
   an ingest failure. It is a prefix, not the whole history. Say so. Do not re-run with a bigger
   cap without saying why.

## Running it again is safe, and here is exactly why

Each transcript has a cursor recording the byte offset already consumed, so a second run over
unchanged files reads nothing and sends nothing. An interrupted import resumes rather than
duplicates.

That is a claim about **this client's bookkeeping**. Separately, every imported tool call
carries the same `item_id` live capture would have written for it — `cc-<item id>` on Codex
0.149 and later, `cc-<tool_use_id>` on Claude Code — so the import and the live path address
the same entries. Whether the *server* collapses two sends of one id is the server's behaviour
and this skill does not assert it. Do not tell a user "the server will deduplicate"; tell them
"a re-run reads nothing new", which is the part that is verified here.

## When this is the wrong tool

- **"Why is memory empty?"** — that is `/mubit-memory:doctor`. An import fixes a cold start,
  not a broken connection, and running it against an instance that cannot be reached wastes
  the time and tells you nothing.
- **"What does my instance hold?"** — that is `/mubit-memory:activity`.
- **"Remember this."** — that is `/mubit-memory:remember`. One fact does not need a backfill.
