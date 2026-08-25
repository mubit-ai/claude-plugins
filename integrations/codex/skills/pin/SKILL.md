---
name: pin
description: Pin a standing constraint for the rest of this run, so it is put in front of the model on every prompt — "don't touch the vendored server", "stay on the 0.10 branch", "no new dependencies". Use when the user states a rule that holds for this task and stops being true when the task ends. A pin is for THIS run and is cleared when it no longer applies; a durable, cross-session lesson is mubit-memory:remember instead. Also use when asked to list or clear what is pinned.
---

**This skill never installs anything.** It runs one Node process from the plugin directory,
which writes a run-scoped variable to the user's own Mubit instance. No packages, no services,
no changes to the shell.

## Step 0 — resolve the binary

No environment variable carries this plugin's path under Codex. Codex lists each skill with the
absolute path of its `SKILL.md`; **this file** is at `<plugin-root>/skills/pin/SKILL.md`, so
the binary is two directories above it:

```
<plugin-root>/bin/pin.mjs
```

Resolve that to an absolute path from this file's own location and use it in every command
below. Do not write `${CLAUDE_PLUGIN_ROOT}`: Codex sets no plugin-root variable of any
spelling, so the shell expands it to nothing and `node /bin/pin.mjs` fails with ENOENT.

## What a pin is

A pin is a sentence that is true for **this run and this task**, injected in full above the
recalled memory on every prompt until it is cleared.

> for the rest of this, don't touch the vendored server

You are who notices a sentence like that. Before pinning existed, the only place to put it was
memory — so it was written as a *lesson*, and a lesson is durable and cross-session. It would
then be recalled into every future session of a project where it had long since stopped being
true. Removing that failure is the entire reason this command exists.

## Pin or remember — the line is not blurry

| | pin | remember |
| --- | --- | --- |
| Scope | this run, this task | durable, every future session |
| Ends when | the user clears it, or the run does | never, unless it is forgotten or superseded |
| Costs | tokens on **every** prompt of this run | nothing until recall decides it is relevant |
| Example | "no new dependencies while we finish this PR" | "this project pins dependencies by exact version" |

Read the two example rows before choosing. If the sentence would still be worth saying in six
months, in a different session, it is a lesson — use the `remember` skill. If it would be wrong
to say next week, it is a pin.

## Pin something

```bash
node <plugin-root>/bin/pin.mjs add "don't touch the vendored server" --json
```

It renders on the very next prompt — the command writes through to the local cache the recall
hook reads, so there is nothing to wait for.

Use the user's own words. A pin is an instruction, and paraphrasing an instruction changes it.

## See what is pinned, and clear one

```bash
node <plugin-root>/bin/pin.mjs list --json
node <plugin-root>/bin/pin.mjs clear <slug> --json
node <plugin-root>/bin/pin.mjs clear --all --json
```

`list` prints a slug beside each pin; `clear` takes that slug. `--all` clears only this
plugin's pins and never another client's state in the same run.

**Clearing is half the job.** A pin that outlives the task it was set for is worse than no pin:
it is spending tokens on every prompt to enforce a rule that has stopped being true. When the
work a pin was set for is finished, say so and offer to clear it.

## The limits, and why they are there

At most **five pins**, each at most **200 characters**, and at most **240 tokens** rendered.
The command refuses anything over them rather than silently truncating.

They are tight on purpose. Recalled memory is ranked against the prompt and degrades to a
one-line pointer once you have already seen it; a pin does neither — it is unranked and paid in
full on every single prompt of the run. Six standing constraints is not a set of constraints,
it is a document, and a document belongs in `AGENTS.md`, where it costs nothing per prompt.

If a refusal comes back, do not work around it by shortening the user's words. Report the cap
and ask which existing pin to clear.

## Exit codes

| Exit | Meaning | What to tell the user |
| --- | --- | --- |
| `0` | Done. `--json` carries `run_id` and the full pin list. | Confirm what is now pinned. |
| `1` | Refused or failed. `detail` says which. | Pass the detail on. A cap was hit, the run could not be determined, or the instance did not answer. |

Two failures worth recognising by name:

- **`unconfigured`** — no endpoint is set. Run the `auth` skill first.
- **`no_run`** — no hook has written a run marker yet, so the command cannot tell which run
  this session is. It resolves itself after one prompt; `--run <run_id>` names one explicitly,
  and the `doctor` skill prints the current run id.

## What a pin is not

- **It is not a permission boundary.** It is text put in front of you, exactly like recalled
  memory. Use Codex's approval settings for anything that has to hold.
- **It is not stored offline.** A pin that the instance did not accept is not written locally
  at all, because a pin that exists only on one machine is one the user believes is shared and
  is not.
- **It does not reach sub-agents.** They get their own recalled block and do not read pins yet.
