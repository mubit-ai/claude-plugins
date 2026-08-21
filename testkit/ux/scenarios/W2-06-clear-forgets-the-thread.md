# W2-06 — /clear forgets the thread, and says so

**Family** W2 cross-session continuity · **Moments** M1*, M2, M6, M7 · **Sessions** 2 · **Duration** ~14 min

**Backend** hosted · **Arms** plugin-on only

The one real cross-session failure inside the story this product supports: same machine, same
repo, same person, and the memory is gone. `/clear` is the only `SessionStart.source` that
abandons its run — `resume`, `compact` and `fork` all reuse the mapped one — so it is the only
one that can hand a user an empty project and a steer block claiming memory is active.

## What this proves

Both halves of the decision, and they pull against each other on purpose.

**Fresh by default.** After `/clear` the previous session's evidence does not come back.
`/clear` means "forget the thread", and a user who typed it and then got the thread back would
be right to complain. This scenario exists to make that a decision rather than an accident.

**Recoverable in one command.** The reset is not a shredder. `lib/runid.mjs` records
`previous_run_id` on the session record, and `/mubit-memory:link` reconnects the cleared run to
the one it came from — so a `/clear` typed by mistake costs a command, not a project's memory.

The failure this replaces is neither of those: it is the silence between them. A cleared
session used to open with "Mubit memory is active", name a run with nothing in it, and recall
nothing all session, leaving the model unable to tell a reset project from one that has never
learned anything.

## Setup

W2-01's Setup, with `TK=/tmp/tk-w2-06`, and **two changes that are the whole scenario**:

```bash
unset MUBIT_CC_RUN_ID          # a pin is honoured on every source, /clear included
unset MUBIT_CC_RUN_STRATEGY    # so per-directory derives, and -c<n> is what moves the run
```

Leave either exported from W2-01 and `/clear` will not move the run at all — the derivation
never runs, the counter never applies, and every step below passes while measuring nothing.
That is not a plugin bug; it is what `static` means, and it is the first thing to check when
step 6 shows memory that should be gone.

> **`/mubit-memory:link` shipped in SC-09** (`feat/link-command`, §6 Tier 3), so steps 8–9 and
> pass/fail item 5 are live: the whole scenario runs end to end against one branch. SC-05
> delivers steps 1–7 and the `previous_run_id` they read; SC-09 reads it back. The Touchpoints
> fence now names `link` — it deliberately did not while the skill was unbuilt, because
> `lab ux --check` exits non-zero on a scenario naming a touchpoint the plugin under test does
> not have, and that alarm was worth more than an early entry.

## Steps

**1 — Session 1: teach a constraint.** As W2-01 step 2:

```
In this repo prices are integer cents, never floats. Any function that returns a
price must return an int. Fix cart.total to enforce that.
```

**2 — `/exit`, and wait for ingest** exactly as W2-01 step 5. Skipping the wait turns a
working plugin into a failed scenario.

**3 — Session 2, same directory, same environment.** Ask the adjacent question:

```
Add a discount(items, pct) function to cart.py.
```

This is the control. If it does not inject anything, W2-01 is what is broken and this scenario
has nothing to say — stop here.

**4 — Note the run id.**

```bash
node -e 'const fs=require("fs"),p=process.env.DATA+"/sessions";
for (const f of fs.readdirSync(p)) { const r=JSON.parse(fs.readFileSync(p+"/"+f,"utf8"));
  console.log(f, r.run_id, "clear_count", r.clear_count, "<-", r.previous_run_id || "(not cleared)"); }'
```

**5 — `/clear`.** Same session, same terminal, same directory.

**6 — Ask the identical question from step 3 again.** Word for word: a different prompt would
change what recall was asked for and confuse a real difference with a re-phrasing.

**7 — Read what the reset left behind.**

```bash
node -e 'const fs=require("fs"),p=process.env.DATA+"/sessions";
for (const f of fs.readdirSync(p)) { const r=JSON.parse(fs.readFileSync(p+"/"+f,"utf8"));
  console.log(f, r.run_id, "clear_count", r.clear_count, "<-", r.previous_run_id || "(not cleared)"); }'
node -e 'const t=require("fs").readFileSync(process.env.TK+"/s2.log","utf8");
const m=t.match(/reset by \/clear[^"]*/); console.log(m ? m[0] : "NOT SAID");'
node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --runs
```

**8 — Reconnect it, with no argument.**

```bash
node "$PLUG/bin/link.mjs" link --json
```

With no argument this links the run named by `previous_run_id` and nothing else — the session
record already knows the answer, so the command does not have to ask. `node "$PLUG/bin/link.mjs"`
on its own lists what this project can now reach, with the pre-reset run marked `before /clear`.

**9 — Ask the identical question a third time.**

**10 — Clean up.** `rm -rf /tmp/tk-w2-06`.

## Expect

**Step 3** — the payoff W2-01 measures, one line before the model's first token:

```
mubit: 2 memories · 148 tok · 1810ms
```

**Step 5** — the SessionStart block for the cleared session names the reset and the recovery.
It is `additionalContext`, so it reaches the model rather than the terminal; step 7's second
command is how you read it back out of the debug log.

**Step 6** — `mubit: 0 memories`, and a `discount` written without the constraint. This is the
scenario passing, not failing.

**Step 7** — the run id gains `-c1`, `clear_count` is `1`, and `previous_run_id` names the run
from step 4. `--runs` lists both, one per line.

**Step 9** — the step-3 number again, from the same repo and the same person, with the run id
still carrying its `-c1`.

## Touchpoints

```
hooks:  SessionStart*, UserPromptSubmit, PostToolUse, Stop, SessionEnd
tools:  mubit_recall
skills: link*
config: runStrategy, reflectOnEnd
```

## Pass / fail

1. Step 3 injects at least one source. **Hard** — the control; a 0 here voids the run.
2. Step 6 injects **zero**. **Hard.** Memory surviving a `/clear` is the failure, not the
   success: the user asked for the thread to be forgotten.
3. The step-5 block names the reset and `/mubit-memory:link`. **Hard.** Silence here is the
   defect this scenario was written for, and it is invisible to every other assertion.
4. `previous_run_id` in step 7 names the step-4 run. **Hard.** Without it the memory is
   unreachable rather than set aside, and item 5 has nowhere to point.
5. Step 9 injects at least one source again. **Hard.** This is the other half of the decision:
   `/clear` forgets the thread, and one command gets it back. Without it the reset is a
   shredder, and item 2 — which asks for the memory to be gone — would be the whole story.

## Known-not-bugs

- **The run id gains a `-c1`.** That is the reset, spelled out in the id. §4.3 gives `clear`
  the only row in the source table that does not reuse its mapping.
- **`--runs` lists two runs for one repository after step 5.** Correct, and it is what makes
  item 4 checkable at all: the pre-clear run still exists with its memory in it.
- **Nothing moves under `MUBIT_CC_RUN_STRATEGY=static`.** A pin is honoured on every source —
  appending a clear counter to a deliberately shared run id would silently un-share it. The
  Setup unsets it for exactly this reason.
- **A second `/clear` points at `-c1`, not at the original run.** `previous_run_id` describes
  where the *current* run came from, one step back. Walking further back is a link-graph
  question, not a session-record one.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| step 6 still injects | `--runs`, and `clear_count` in step 7 | `MUBIT_CC_RUN_ID` or `runStrategy=static` still exported — the run never moved |
| step 6 injects, run id did move | `mubit-inspect --cross-run` | recall is not scoped to the calling run; that is a backend scope bug, not `/clear` |
| step 7 prints `NOT SAID` | `grep -c SessionStart "$TK/s2.log"` | the hook did not run on `source=clear`, or the note is gated on the wrong source |
| `previous_run_id` is `(not cleared)` | the record's `clear_count` | a non-clear write landed after the clear and reset the pointer |
| step 8 exits 1 with `no_target` | step 7's `previous_run_id` | the pointer is empty, so there is nothing to reconnect — a non-clear write landed after the clear |
| step 8 exits 2 | its `state` | the decision is recorded locally but Mubit did not confirm it; re-run it, and check the endpoint before blaming step 9 |

## Teardown

```bash
rm -rf /tmp/tk-w2-06
unset MUBIT_CC_DATA_DIR MUBIT_CC_LOG_LEVEL MUBIT_ENDPOINT MUBIT_API_KEY
```

`MUBIT_CC_RUN_ID` and `MUBIT_CC_RUN_STRATEGY` were unset by the Setup and must stay that way
for W2-02, which is also about derivation.

## Record

```bash
node "$PLUG/../../testkit/bin/lab.mjs" ux   # then note the result in results/<stamp>/ux-results.md
```
