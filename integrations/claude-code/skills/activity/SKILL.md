---
name: activity
description: List or export what this instance holds for a run; use when the user wants the audit record, not an answer.
disable-model-invocation: true
allowed-tools: ["Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/activity.mjs:*)"]
---

**This skill never installs anything, and it writes nothing anywhere unless asked.** It runs one
Node process from the plugin directory, makes one or more read-only calls to the configured
instance, and prints the answer.

`disable-model-invocation: true` is deliberate, and matches `dashboard`. This is a question a
person asks about their own data; nothing in a conversation should decide on its own to pull a
copy of somebody's memory into the transcript. A disabled skill's description is not
always-loaded context either, so it costs nothing until somebody types it.

## The distinction that decides which command to run

There are two things this command can produce and they are **not the same kind of answer**.

- **A listing** is a claim *this client* makes. The plugin sends the filters, and then checks
  the result against them itself: it re-drops derived entries and re-truncates content, and it
  says so when it had to. A listing is for reading.
- **An export** is the record *the instance holds*, byte for byte. `/v2/control/activity/export`
  accepts no `exclude_derived` and no `projection` at all, so an export is never filtered and
  never truncated, and nothing here reshapes it. An export is for keeping.

**Never describe an export as "filtered activity".** If somebody asks for "an export of my
non-derived lessons", they are asking for two different operations: an export is everything in
scope, and the filtering they want is a listing. Say which one they got.

## Reading it

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/activity.mjs"
node "${CLAUDE_PLUGIN_ROOT}/bin/activity.mjs" --exclude-derived --type lesson
node "${CLAUDE_PLUGIN_ROOT}/bin/activity.mjs" --scan --since 2026-08-01T00:00:00Z
```

The default is one page of the newest activity for the newest run in this data directory.
`--scan` pages through everything that matches, oldest first. `--run <id>` picks a run and
`--all-runs` asks across every run the key can see.

Filters: `--type` (repeatable), `--since` / `--until` as RFC3339, `--agent`, `--user`, and
`--exclude-derived` for the entries the instance promoted for itself rather than ones a client
wrote. `--full` returns every field untruncated; the default is five keys per entry.

Output: a table by default, `--jsonl` for one object per line, `--json` for one envelope. The
payload goes to stdout and the summary to stderr, so a pipe gets only the data.

## Exporting it

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/activity.mjs" --export
node "${CLAUDE_PLUGIN_ROOT}/bin/activity.mjs" --export --out ~/memory-audit.jsonl
```

Without `--out` the JSONL goes to stdout, which is the whole point: it composes, and it leaves
nothing on anybody's disk.

**Do not pass `--out` unless the user asked for a file.** An export is a complete copy of what
the instance holds for a run, and creating one is a decision that belongs to them, not to a
turn that seemed like it might want one. When you do pass it, **name the absolute path in your
reply** — the command prints it, and a file the user cannot find is a file they cannot delete.

`--out` refuses to overwrite, and refuses any path inside the plugin data directory: an export
there sits outside the TTL sweep, so it would live forever and nothing would ever mention it
again. It warns when the destination is inside a git working tree that is not ignoring it.
`--all-runs` is refused with `--export`, because that route takes no limit and a run is the
only bound on how much comes back.

## What to say about the numbers

Three of the things this prints are **findings**, not decoration, and they are the reason the
answer can be trusted. Relay them rather than summarising them away:

1. **"the instance did not honour exclude_derived"** means derived entries came back under a
   request that excluded them, and this client dropped them locally. The listing is correct;
   the server's filter is not. That is worth telling the user, because it is the difference
   between a filter and a claim about a filter.
2. **"the instance did not honour the compact projection"** means content was truncated here
   rather than upstream. Nothing was lost — `--full` or an export has all of it.
3. **"this answer is incomplete"** on a `--scan` means it stopped at a bound (entry cap, wall
   clock, or page count). It is a prefix, not the whole record. Say so; do not present it as a
   complete answer, and do not quietly re-run with a bigger cap without saying why.

`visible upstream` is the instance's own count of everything matching the filters it applied,
before paging — so when the first finding fires, it is larger than the number of rows shown by
exactly the number that were dropped here.

## The one thing it cannot tell you

Per-prompt recall cost and latency are not in the activity feed; they are local, under
`runs/<run_id>/turns/`. `/mubit-memory:dashboard`'s **Turns** tab is where that lives, joined
against the instance's side of the same session. Use this skill for what the instance holds and
that tab for what each prompt cost.

## Related

- `/mubit-memory:dashboard` — the same data as a page, plus the local per-prompt series.
- `/mubit-memory:doctor` — the cheaper question, and the right one when something is broken
  rather than merely unknown.
- `/mubit-memory:forget` — what to run when this listing turns up something that should not be
  there.
