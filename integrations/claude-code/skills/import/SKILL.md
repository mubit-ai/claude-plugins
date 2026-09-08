---
name: import
description: "Backfill Mubit memory from the Claude Code and Codex transcripts already on this machine, so a fresh install knows what happened before it. Sends nothing without an explicit --send."
disable-model-invocation: true
allowed-tools: ["Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/import.mjs:*)"]
---

**This skill uploads work history to the configured Mubit instance.** It runs one Node process
from the plugin directory, reads `~/.claude/projects` — and, when asked, Codex's
`~/.codex/sessions` — and ingests what it finds. Nothing is sent unless `--send` is on the
command line.

`disable-model-invocation: true` is not a formality here, and it is stricter than the reason
`activity` and `dashboard` carry the same line. Those read. This one takes months of somebody's
transcripts — every prompt, every command, every file they touched — and puts them on a server.
Nothing in a conversation should decide on its own to do that. A person types it, or it does
not happen.

## Always dry-run first, and show them the number

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/import.mjs"
```

That is the whole command, and it sends nothing: a dry run is what happens when nobody says
otherwise. It prints the scope it resolved and how many items it *would* send.

**Relay that number and the scope before offering to send.** "This would send 2,300 items from
41 transcripts across 3 runs" is a sentence somebody can answer. "Shall I import your history?"
is not.

## Then, only if they say so

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/import.mjs" --send
```

## When it says `ingest failed`

The counts line is followed by the reason — `ingest failed (<state>): <message>`, the same
sentence the plugin logs. `unreachable` with "no network access" means the shell the command
ran in has no network: Codex's sandbox does this to an unapproved command, and the fix there
is to run it with escalated permissions, never to change the endpoint. `auth_failed` is the
key, which is `/mubit-memory:auth`. `server_error` is the instance. Relay the sentence, not
the count: "failed 1" is not an answer to "why".

## Scope

The default is **the project you are in, plus every git worktree linked to it**. A worktree is
a different directory and therefore a different transcript folder to the host, but it is the
same work, so importing one without the others would give a partial history that looks
complete.

`--all` is every project on the machine. Offer it only if asked for it: it will include
personal projects, client work, and anything else that was ever opened in this CLI.

`--project <dir>` imports a different project instead of the current one.

## Two sources

`--source claude-code` (the default under this host) reads Claude Code's transcripts.
`--source codex` reads Codex's rollouts from `~/.codex/sessions` (or `$CODEX_HOME/sessions`),
and `--source all` reads both. The scope, the item cap, the cursors and the redaction pipeline
are the same whichever is chosen, and the report counts each source on its own line — so
"1,200 items" can be checked against the directory it came from.

Offer `--source all` when the user has both tools on the machine and asks to import their
history rather than *this* tool's history. A Codex item carries `tool:codex` in its env tags,
so the two histories stay tellable apart once stored.

Two things the Codex side skips, and says so: the reviewer threads Codex runs to approve its
own actions (their prompts are other threads' transcripts), and the preamble Codex writes in
the user's voice at the top of every thread since 0.149.

## What it does not send

Three things are dropped rather than scrubbed, and it says how many of each:

- **Denylisted paths.** A tool call whose subject is a `.env`, a key file, or anything git is
  ignoring is dropped whole. A scrubbed `.env` is still a map of which secrets a project holds.
- **The plugin's own traffic.** Memory does not record itself recalling.
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
carries the same `item_id` live capture would have written for it — `cc-<tool_use_id>` on
Claude Code, `cc-<item id>` on Codex 0.149 and later — so the import and the live path address
the same entries. Whether the *server* collapses two sends of
one id is the server's behaviour and this skill does not assert it. Do not tell a user "the
server will deduplicate"; tell them "a re-run reads nothing new", which is the part that is
verified here.

## When this is the wrong tool

- **"Why is memory empty?"** — that is `/mubit-memory:doctor`. An import fixes a cold start,
  not a broken connection, and running it against an instance that cannot be reached wastes
  the time and tells you nothing.
- **"What does my instance hold?"** — that is `/mubit-memory:activity`.
- **"Remember this."** — that is `/mubit-memory:remember`. One fact does not need a backfill.
