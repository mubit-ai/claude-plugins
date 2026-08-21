# W2-07 — Link two projects, and address them by name

**Family** W2 cross-session continuity · **Moments** M7*, M2, M6 · **Sessions** 4 · **Duration** ~18 min

**Backend** hosted · **Arms** plugin-on only

Two checkouts of the same work — a repo and its worktree, a service and its client, `pre-main`
and `plugin-lab` — derive two different run ids, so by construction neither can see the other's
memory. That is the correct default and it is also, at some point, the wrong answer. §6 Tier 3
is the surface where a person says so.

## What this proves

Three things, and the third is the one that will regress.

**Reach is a graph, not a threshold.** Before the link, repo B recalls nothing from repo A —
not "less", nothing. After it, the same question in the same repo reaches A's memory. Nothing
about the lessons changed: the scope stayed `run`, and the *edge* is what moved.

**Users never see run ids.** `cc-plugin-lab-43f3807e` is a hash of a git toplevel. Every line
this command prints is a directory and a relative date, and every argument it accepts is a
directory. Step 4 is the assertion, and it is the one thing here worth failing the release
over: a surface that leaks a hash has already lost the argument, because the next version of
it asks the user to type one.

**Revocation is one command.** A link is safe to offer only because `unlink` exists, is
symmetric, and takes effect locally even when the instance is unreachable. Step 9 is not a
teardown step; it is half of the feature.

## Setup

W2-01's Setup, with `TK=/tmp/tk-w2-07`, and **two repos instead of one**:

```bash
export PLUG=/Users/eldaru/Mubit/pre-main/integrations/claude-code   # the version under test
export TK=/tmp/tk-w2-07
export DATA=$TK/data
export A=$TK/pricing
export B=$TK/storefront

rm -rf "$TK" && mkdir -p "$DATA"
for d in "$A" "$B"; do
  mkdir -p "$d" && cd "$d" && git init -q
  printf 'def total(items):\n    return sum(i["price"] for i in items)\n' > cart.py
  git add -A && git -c user.email=t@example.com -c user.name=t commit -qm init
done

export MUBIT_CC_DATA_DIR="$DATA"
export MUBIT_CC_LOG_LEVEL=debug
export MUBIT_ENDPOINT=$(node -e 'process.stdout.write(require(process.env.HOME+"/.claude/plugins/data/mubit-memory-mubit/credentials.json").endpoint)')
export MUBIT_API_KEY=$(node -e 'process.stdout.write(require(process.env.HOME+"/.claude/plugins/data/mubit-memory-mubit/credentials.json").apiKey)')

unset MUBIT_CC_RUN_ID          # per-directory derivation is the whole point:
unset MUBIT_CC_RUN_STRATEGY    # two directories must be two runs, or there is nothing to link

echo "A $A"; echo "B $B"; echo "data $DATA"
```

Leave `MUBIT_CC_RUN_ID` exported from W2-01 and both repos share one run. Every step below then
passes while measuring nothing at all — step 3 will inject on the first try, which is the tell.

## Steps

**1 — Session 1, in `$A`: teach a constraint.** As W2-01 step 2:

```
In this repo prices are integer cents, never floats. Any function that returns a
price must return an int. Fix cart.total to enforce that.
```

**2 — `/exit`, and wait for ingest** exactly as W2-01 step 5. Skipping the wait turns a working
plugin into a failed scenario.

**3 — Session 2, in `$B`: ask the adjacent question.**

```
Add a discount(items, pct) function to cart.py.
```

This is the control, and it is expected to inject **zero**. An unlinked project seeing another
project's memory is the leak Target C exists to close — if this injects, stop and report it as a
scope bug, not as a passing setup step.

**4 — Look at the graph, from `$B`.**

```bash
node "$PLUG/bin/link.mjs" list
node "$PLUG/bin/link.mjs" list --json | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
  const hash=JSON.stringify(j).match(/cc-[a-z0-9-]*-[0-9a-f]{8}/);
  console.log("projects:", j.projects.length, "· run id leaked:", hash ? hash[0] : "no");})'
```

Both `$A` and `$B` appear as **paths**, with a relative date, and `$A` is unchecked. The second
command is the assertion: the answer must be `no`.

**5 — Link them, by directory.**

```bash
node "$PLUG/bin/link.mjs" link "$A" --json
```

**6 — `list` again.** `$A` now carries `[x]`. This is the "reach is inspectable" promise: a user
who linked something last month can see it without asking the server.

**7 — Session 3, in `$B`: the identical question from step 3.** Word for word — a different
prompt changes what recall was asked for and confuses a real difference with a re-phrasing.

**8 — Read it back from the other end.** In `$A`:

```bash
cd "$A" && node "$PLUG/bin/link.mjs" list
```

`$B` is checked here too. The decision was one decision; both ends recorded it.

**9 — Revoke, from either end.**

```bash
node "$PLUG/bin/link.mjs" unlink "$A" --json
node "$PLUG/bin/link.mjs" list
```

**10 — Session 4, in `$B`: the identical question a third time.** Back to zero.

**11 — Clean up.** `rm -rf /tmp/tk-w2-07`.

## Expect

**Step 3** — `mubit: 0 memories`, and a `discount` written without the constraint.

**Step 4** — something of this shape, and nothing resembling a hash:

```
Memory in this project:  ~/…/tk-w2-07/storefront

  [ ] ~/…/tk-w2-07/pricing                 4m ago

  linked projects can read each other's memory · unlink to revoke
```

**Step 7** — the injection step 3 did not get: at least one source, and a `discount` that
returns an int.

**Step 9** — `$A` unchecked again, from either direction.

**Step 10** — `mubit: 0 memories`. A revoked link is revoked.

## Touchpoints

```
hooks:  SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd
tools:  mubit_recall
skills: link*
config: runStrategy, reflectOnEnd
```

## Pass / fail

1. Step 3 injects **zero**. **Hard** — the control. Memory crossing an unlinked boundary is a
   scope leak and voids the rest of the run.
2. No run id appears anywhere in step 4's output, human or `--json`. **Hard.** This is §6's
   ruling constraint made checkable; a leaked hash is a design regression even when everything
   else passes.
3. Step 7 injects at least one source. **Hard** — the payoff.
4. Step 8 shows the link from `$A` as well as `$B`. **Hard.** One decision, both ledgers; an
   end that answers "nothing" while the server serves memory into it is worse than needing the
   network.
5. Step 10 injects zero again. **Hard.** `unlink` that leaves the reach in place is the failure
   mode that makes a link unsafe to offer at all.

## Known-not-bugs

- **`list` never dials.** It answers from the local ledger, so it is correct offline and stays
  correct when the instance is down. It reports decisions, not the server's current graph.
- **Linking three projects issues three calls, not two.** The backend walks one hop, so a
  hub strands the spokes from each other; a group is linked pairwise on purpose.
- **`reflect` sees fewer linked runs than recall does.** At most three, with a bounded slice of
  each. A mesh of four or more is fully visible to recall and only partly to lesson extraction.
- **Step 5 exits 2 with an unreachable instance.** The decision is recorded locally and the
  next run re-asserts it. That is the ledger doing its job, not a failure.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| step 3 already injects | `mubit-inspect --runs` | one run for both repos — `MUBIT_CC_RUN_ID` still exported, or `runStrategy=static` |
| step 4 lists only `$B` | `ls "$DATA/sessions"` | repo A never opened a session, so the session map has nothing to offer |
| step 4 prints a `cc-…` id | the renderer | a run id reached the surface; §6 rules that out |
| step 7 still injects zero | `mubit-inspect --cross-run` | the link was recorded locally but never asserted on the wire — re-run step 5 and read its exit code |
| step 10 still injects | step 9's exit code | `unlink` recorded locally but the instance kept the join |

## Teardown

```bash
rm -rf /tmp/tk-w2-07
unset MUBIT_CC_DATA_DIR MUBIT_CC_LOG_LEVEL MUBIT_ENDPOINT MUBIT_API_KEY
```

`MUBIT_CC_RUN_ID` and `MUBIT_CC_RUN_STRATEGY` were unset by the Setup and must stay that way
for W2-02 and W2-06, which are also about derivation.

## Record

```bash
node "$PLUG/../../testkit/bin/lab.mjs" ux   # then note the result in results/<stamp>/ux-results.md
```
