---
name: strategies
description: Surface the pattern across many stored lessons rather than any single one. Use when the user asks what memory has learned in general, why the same class of mistake keeps recurring, or how this project tends to work — not when they have one specific question.
---

## Step 0 — resolve the binary

No environment variable carries this plugin's path under Codex. Codex lists each skill with the
absolute path of its `SKILL.md`; **this file** is at `<plugin-root>/skills/strategies/SKILL.md`, so
the binary is two directories above it:

```
<plugin-root>/bin/admin.mjs
```

Resolve that to an absolute path from this file's own location and use it in every command
below. Do not write `${CLAUDE_PLUGIN_ROOT}`: Codex sets no plugin-root variable of any
spelling, so the shell expands it to nothing and `node /bin/admin.mjs` fails with ENOENT.

Run the bundled script — `POST /v2/control/strategies` behind it — and report the strategies
it prints in the user's own terms: what the pattern is, and what it was inferred from. Ask for
a small number and report all of them; a wall of generalisations is less useful than three
good ones.

```bash
node <plugin-root>/bin/admin.mjs strategies --max 5
node <plugin-root>/bin/admin.mjs strategies --max 8 --types failure,rule
```

Neither command here is an MCP tool: `mubit_strategies` and `mubit_lessons` left the default
tool surface so that a session pays nothing to list them, and this script reaches the same
two routes.

## The one thing to be clear about

**`strategies` is the pattern *across* lessons. `lessons` reads the individual lessons
themselves.**

Every other retrieval verb answers with entries. `mcp__mubit__mubit_recall` finds the lessons that match a
question, `admin.mjs lessons` lists the catalogue, `mcp__mubit__mubit_diagnose` matches an error's shape,
`mcp__mubit__mubit_dereference` fetches the one whose `reference_id` you already hold. This is the only
one that answers with a *shape over* many of them: it clusters stored lessons into emergent
strategies, so what comes back is a generalisation the server derived, not a record anybody
wrote. Each line names the lesson ids the strategy was inferred from; `mcp__mubit__mubit_dereference`
reads any of them.

That makes the choice easy in both directions. "Why do we keep breaking the build the same
way?" and "what has this project learned about testing?" are strategy questions. "What did we
decide about the recall budget?" is not — that has one answer, and `mcp__mubit__mubit_recall` finds it
faster and quotes it. Do not reach for this for a single lesson; it will hand back a summary
of a cluster the lesson happens to sit in. For the lessons themselves:

```bash
node <plugin-root>/bin/admin.mjs lessons [--scope run|session|global] [--limit N]
```

## Arguments

- `--max` — 1 to 50. Ask for five to ten. The value of the answer is that it is short; fifty
  clusters over a few dozen lessons is the same information with the pattern taken back out.
- `--types` — narrows which lessons get clustered, when the user is asking about one kind of
  thing ("what have we learned about failures?").
- `--run` — leave it out. The script acts on the run this session's hooks are writing to.

## Reporting it

A strategy is inferred, not stated. It has less standing than a `rule`, which somebody wrote
down on purpose and which is enforced as written. Say which you are relaying — presenting a
clustered generalisation as though the user had asked for it is how a plausible pattern
becomes a fact nobody agreed to.

An empty or thin answer is usually not a fault. Clustering needs a body of lessons to cluster,
and a young run does not have one yet. Before reporting that memory has no patterns, check
that it has anything at all: `mubit-memory:memory-health` distinguishes "nothing was ever
stored" from "stored, and there is genuinely no pattern in it".
