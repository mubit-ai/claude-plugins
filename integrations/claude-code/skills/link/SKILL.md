---
name: link
description: "Connect two projects so recall in one can see the other's memory, list what is already connected, or revoke a connection. The user runs this deliberately; it is never invoked on their behalf."
disable-model-invocation: true
allowed-tools: ["Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/link.mjs:*)"]
---

**Only a human runs this skill.** `disable-model-invocation: true` is not a formality here, and
if you are reading this because you were asked to "just link them", stop and ask.

A link widens what a run may **read**, durably, across every future session — not this turn,
not this conversation. Letting a model grant that to itself is the read-side twin of a hole the
plugin already closed on the write side, where an agent could name any run it liked and write
into it. And the two mistakes do not cost the same: a bad recall costs one turn of noise and is
over, while a bad link is silent and stays silent until somebody notices an unrelated project
bleeding into their answers, weeks later, in a session nobody connects to the decision.

You may notice that two repositories look related and say so. **A human confirms.** `unlink` is
one command, so a wrong decision is cheap to undo — but only once someone has seen it.

## Projects are named by directory

Every project on this machine has its own Mubit run, derived from its git toplevel. You never
have to know, type, or read the identifier: this command takes and prints **directories** and
relative dates, and resolves the rest internally.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/link.mjs" list
```

```
Memory in this project:  ~/work/storefront

  [x] ~/work/pricing        2d ago    same remote
  [ ] ~/work/analytics     11d ago
  [ ] ~/scratch/tbench     18d ago

  linked projects can read each other's memory · unlink to revoke
```

`[x]` is a link in force. `list` never contacts the server — it answers from the local record —
so it is correct offline, and it is the honest answer to "what can this project currently see?".

## Connecting

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/link.mjs" link ~/work/pricing --json
```

Several at once is one command, and it links **every pair** in the group, not each project to
this one:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/link.mjs" link ~/work/pricing ~/work/analytics
```

That is deliberate. Mubit reads the graph one hop deep, so a hub-and-spoke arrangement would
leave the two named projects able to see this one and unable to see each other — while every
screen here said they were linked. Three projects is three pairs.

### After a `/clear`

`/clear` moves this session to a fresh run on purpose: the thread was meant to be forgotten.
The memory is set aside rather than destroyed, and the session record remembers where it went,
so the recovery needs no argument at all:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/link.mjs" link
```

With no argument this reconnects the run the `/clear` moved away from, and does nothing else.
It is the one case where the command already knows the answer.

## Revoking

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/link.mjs" unlink ~/work/pricing
```

`unlink` removes the edge between this project and the one named, in both directions. Nothing
is deleted: the lessons on both sides are untouched and `link` puts the edge back. Revocation
takes effect locally even when the instance is unreachable, so narrowing reach is never blocked
by a network problem.

## Reading the exit code

| Exit | Meaning | What to tell the user |
| --- | --- | --- |
| `0` | Done, and Mubit confirmed it. | Report which directories, by name. |
| `2` | Recorded here; Mubit did not confirm. **Not a failure.** | The instance was unreachable. Re-running is safe and idempotent — say so rather than suggesting anything be undone. |
| `1` | It did not happen. The `state` field says why. | See below. |

On exit `1`, `state` is one of:

| `state` | What it means | What to do |
| --- | --- | --- |
| `no_run` | This project has no Mubit run yet. | The run is created at `SessionStart`; a `/reload-plugins` does not create one. Start a new session here. |
| `no_target` | No project was named, and there is no `/clear` to recover from. | Show `list` and let the user pick. |
| `unknown_project` | Nothing on this machine matches what was typed. | The picker only holds projects Mubit has seen. Run `list`. |
| `ambiguous` | The fragment matched more than one project. | The message names them; ask for one in full. |
| `refused` | Mubit rejected the request itself. | A malformed pair — report it. Do not retry in a loop. |

## What a link does not change

**Nothing about the lessons.** Their scope stays exactly what it was; the *edge* is the only
thing that moved. Unlinking leaves both projects precisely where they started.

**Recall and reflect do not read the graph equally.** Recall consults the whole set of linked
runs. Lesson extraction consults at most **3** of them, and a bounded slice of each — a
deliberately narrower window, because reflection is expensive and recall is not. So a mesh of
four or more projects is fully visible to recall while only partly visible to what gets learned
across them. If the point of linking is to have lessons drawn from all of them, keep the group
small; if the point is to be able to recall across them, size does not matter.

## Related

- `/mubit-memory:recall` — search the memory this project can currently reach, link graph
  included.
- Subagents need no link. A spawned subagent is joined to its parent automatically, which is
  why `list` sometimes reports linked runs with no directory of their own.
