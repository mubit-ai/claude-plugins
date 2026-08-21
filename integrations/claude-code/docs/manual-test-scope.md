# Manual test — memory scope: B1, B3, I7, and what `reflect` can see

Four bounded experiments about **who can read a lesson**, and one code reading that answers a
question the scope investigation left open. Together they establish, by measurement rather
than by argument, what the plugin's default scope ceiling actually costs and what raising it
actually buys.

Executed on **2026-08-21** against the hosted `https://api.mubit.ai`, plugin `0.10.0`, from
the `plugin-scope-fix` worktree. **The Expect blocks in §1 and §2 are transcripts, not
predictions.**

**Time:** ~10 minutes for §1–§2, ~2 for §3, and §4 is reading.
**Destroys:** nothing permanently. §1 writes two lessons to your real instance and **deletes
the one that matters** in §1.5 — that deletion is not optional and is the whole point of
calling this a *bounded* window.

> Read `docs/SCOPE.md` §5 (in the testkit) first if you have not. This file measures the
> things that document argues about; it does not restate the argument.

---

## §0 — Setup, one paste

Check first that your shell is not already steering the plugin somewhere else:

```bash
env | grep -iE '^(MUBIT|CLAUDE_PLUGIN)' | sed 's/\(MUBIT_API_KEY=.\{0,10\}\).*/\1…/' | sort
```

**Expect nothing at all.** In particular expect no `MUBIT_MCP_LESSON_SCOPE` — if one is
already exported, someone ran §1 and did not finish it, and every lesson written on this
machine since then went out at that ceiling.

```bash
export PLUG=/Users/eldaru/Mubit/plugin_scope_fix/integrations/claude-code
export B1=/tmp/mubit-scope-b1

rm -rf "$B1" && mkdir -p "$B1/data"
export MUBIT_CC_DATA_DIR="$B1/data"
export MUBIT_CC_RUN_STRATEGY=static
export MUBIT_CC_RUN_ID=tk-b1-writer
export MUBIT_CC_LOG_LEVEL=debug
export MUBIT_ENDPOINT=$(node -e 'process.stdout.write(require(process.env.HOME+"/.claude/plugins/data/mubit-memory-mubit/credentials.json").endpoint)')
export MUBIT_API_KEY=$(node -e 'process.stdout.write(require(process.env.HOME+"/.claude/plugins/data/mubit-memory-mubit/credentials.json").apiKey)')
```

Note what is **not** exported: `MUBIT_MCP_LESSON_SCOPE`. §1.2 sets it as a **prefix on one
command**, never as an export. That is deliberate and is the difference between a bounded
window and a machine that leaks until someone notices.

---

## §1 — B1: what the scope ceiling does, measured on both sides

`mubit_learned` is the only lesson-writing tool a default install exposes, and the vendored
SDK hard-codes `lesson_scope: "session"` on every write. The egress guard
(`mcp/src/egress.mjs`, installed at `mcp/src/launch.mjs:156`) clamps that to the
`mcpLessonScope` ceiling, default `run`.

### §1.1 — Control: write at the default ceiling

```bash
node "$PLUG/scripts/mcp-probe.mjs" --call mubit_learned --json --args \
  '{"text":"B1 control sentinel 8f3a2c: in the tk-b1 fixture the widget cache key is always the sha1 of the tenant slug, never the tenant id."}'
```

**Expect** — the guard reports itself in the response, which is the whole point of the
correction channel `egress.mjs` documents:

```json
{
  "accepted": true,
  "job_id": "2556626f-32dc-4010-821b-ae62b92a5e6a",
  "status": "queued",
  "mubit_scope_guard": {
    "ceiling": "run",
    "lesson_scope": { "requested": "session", "written": "run", "items": 1 },
    "raise_with": "mcpLessonScope (MUBIT_MCP_LESSON_SCOPE)"
  }
}
```

`requested: "session"` is the SDK's hard-coded value; `written: "run"` is the guard clamping
it. This single field is the end-to-end confirmation that the egress-guard reading in
SCOPE.md §5 is correct.

### §1.2 — Treatment: raise the ceiling for exactly one command

> **This is I2's leak, deliberately re-opened.** Anything written here becomes readable by
> **every run on the instance**. It is a prefix on one command, not an export. Never leave it
> on a benchmarking host, and do not skip §1.5.

```bash
MUBIT_MCP_LESSON_SCOPE=global node "$PLUG/scripts/mcp-probe.mjs" --call mubit_learned --json --args \
  '{"text":"B1 treatment sentinel 4d9e71: in the tk-b1 fixture the retry ceiling for outbound webhooks is exactly seven attempts, and the eighth is dropped silently."}'
```

**Expect**

```json
  "mubit_scope_guard": {
    "ceiling": "global",
    "lesson_scope": { "requested": "session", "written": "global", "items": 1 }
  }
```

### §1.3 — Wait for both jobs, at the server

```bash
node --input-type=module -e '
import { pathToFileURL } from "node:url";
const P = process.env.PLUG;
const { loadConfig }   = await import(pathToFileURL(P + "/lib/config.mjs").href);
const { getIngestJob } = await import(pathToFileURL(P + "/lib/http.mjs").href);
const cfg = loadConfig(process.env);
for (const [k, id] of Object.entries({ control: "<job id from §1.1>", treatment: "<job id from §1.2>" })) {
  const r = await getIngestJob(cfg, "tk-b1-writer", id, { timeoutMs: 15000 });
  console.log(k, r.ok ? r.body.status : r.state);
}'
```

**Expect** both `completed`, within seconds.

> Do **not** poll `mubit-inspect` for this. It reads `runs/<run>/jobs.json`, a snapshot
> written at submit time that nothing refreshes, so it reports `queued` forever. See
> `testkit/docs/W2-01-baseline-walk.md`, where that trap cost a full ten-minute wait on a
> backend that had finished in 322 ms.

### §1.4 — The read side, from a run that has never written anything

```bash
node --input-type=module -e '
import { pathToFileURL } from "node:url";
const P = process.env.PLUG;
const { loadConfig }  = await import(pathToFileURL(P + "/lib/config.mjs").href);
const { recallBlock } = await import(pathToFileURL(P + "/lib/recall.mjs").href);
const cfg = loadConfig({ ...process.env, MUBIT_CC_DATA_DIR: process.env.B1 + "/reader" });
for (const [label, q] of [
  ["control  (run scope)   ", "widget cache key sha1 tenant slug"],
  ["treatment (global scope)", "retry ceiling outbound webhooks attempts"]]) {
  const o = await recallBlock(cfg, { runId: "tk-b1-reader-a1b2c3", agentId: "tk-b1-reader",
    query: q, deadline: Date.now() + 8000, projectDir: process.cwd() });
  const b = String(o.block || "");
  console.log(`${label} sources=${o.sources} rung=${o.rung} control=${/8f3a2c/.test(b)} treatment=${/4d9e71/.test(b)}`);
}'
```

**Expect** — and read the second column carefully, because it is more interesting than the
result it was written to get:

```
control  (run scope)    sources=1 rung=1 control=false treatment=true
treatment (global scope) sources=1 rung=1 control=false treatment=true
```

**B1 is confirmed.** From a fresh unrelated run, the `run`-scoped lesson is invisible and the
`global`-scoped one is not. One environment variable, on one machine, with no deploy.

**And the cost is visible in the same two lines.** The *first* probe asked about the control
lesson's subject — widget cache keys — and got the **treatment** lesson back, about webhook
retries. Nothing about the two is related. The control is filtered out of the cross-run lane
entirely, the treatment is the only cross-run-visible candidate, and recall has no relevance
floor, so an unrelated project's lesson is injected simply because it is the only thing there
to inject. That is not a contrived failure: it is the exact shape of the incident that made
the egress guard necessary, reproduced in two commands.

### §1.5 — Close the window. Not optional.

The treatment sentinel is now a fabricated fact about a fixture that does not exist, readable
by every run on your instance, forever. Delete it.

```bash
# the reference id is what recall returned in §1.4 — re-read it if you did not keep it
node "$PLUG/scripts/mcp-probe.mjs" --call mubit_forget --json \
  --args '{"lesson_id":"924eb293-2c80-465c-ae3b-bf39f00f29dd"}'
```

**Expect** `{"success": true}`. Note the parameter name: `mubit_forget` wants `lesson_id` or
`session_id`, and rejects `entry_id` with *"Please provide either session_id or lesson_id to
delete."*

Then prove it:

```
retry ceiling outbound webhooks attempts   sources=0 empty=no_evidence control=false treatment=false
widget cache key sha1 tenant slug          sources=0 empty=no_evidence control=false treatment=false
```

Zero sources on both. The window is closed, and the control lesson is still where it always
was — invisible from here, exactly as `run` scope promises.

Finally, confirm nothing was left exported:

```bash
env | grep -c MUBIT_MCP_LESSON_SCOPE     # expect 0
```

**This is a measurement instrument, not a recommendation.** Shipping
`MUBIT_MCP_LESSON_SCOPE=global` as a default is explicitly out of scope; Target C exists so
that nobody has to.

---

## §2 — B3: `userId`, and why it does not close the gap

`metadata_matches_scope` (`crates/control/service/src/lib.rs:3932`) filters candidates by
`user_id`, so setting the plugin's `userId` and writing at `global` looks like it would give
cross-project, single-user memory with no backend change.

Read the filter before running anything:

```rust
if let Some(user_id) = logical_user_id.filter(|value| !value.trim().is_empty()) {
    let stored_user_id = metadata.get("user_id").and_then(|v| v.as_str()).unwrap_or_default();
    if !stored_user_id.is_empty() && stored_user_id != user_id {     // <-- non-empty only
        return false;
    }
}
```

**It rejects only when the stored `user_id` is non-empty.** An entry written without one
matches *every* caller. So on any instance that already holds untagged entries — which is
every instance that has ever run a default install — tagging future writes partitions the
future and leaves the whole existing corpus readable by everyone.

**Verdict: record it, do not ship it.** It is not retroactive, and a mixed corpus still leaks
the untagged half. It would be a real mechanism on an instance that had been tagged from its
first write, and no instance has been.

---

## §3 — I7: the ten stranded lessons

Every lesson `/v2/control/lessons` returns as a "global lesson" on this instance is stored at
`scope: "run"`, bound to its `source_run_id`. Promotion does not touch them retroactively —
the promotion block iterates the lessons produced by *the current reflect call* only.

So any fix that changes future behaviour leaves this corpus invisible.

**For a demo, generate fresh content rather than rewriting the corpus in place.** Walk
`testkit/ux/scenarios/W2-01-teach-then-recall.md` once; it takes about twelve minutes and
produces real lessons in a run you control. It was walked on 2026-08-21 and passed on all
five criteria — four sources, 723 tokens, 1173 ms — with the recall canary red the whole
time; see `testkit/docs/W2-01-baseline-walk.md`.

Rewriting ten stored records to make a demo work is the kind of change that is still true six
months later and that nobody remembers making. Don't.

---

## §4 — What `reflect` can see, and the 30% it can displace

SCOPE.md §5 left this open: does `reflect` at `SessionEnd`, which runs against a single
`run_id`, see a linked run's evidence? It does — and the mechanism matters more than the
answer.

`reflect()` (`lib.rs:10207`) has its **own** `include_linked_runs` branch at `:10309`,
separate from `query`'s at `:8709`:

```rust
for linked_id in linked_ids.iter().take(3) {                       // at most THREE runs
    if let Ok(traces) = self.echoes.list(linked_id.clone(), 20).await {   // 20 traces each
        for t in traces {
            evidence.push(ReflectionEvidence {
                content: format!("[linked:{}] input={} outcome={}", linked_id, t.input, t.outcome),
                entry_type: "trace".to_string(), score: 0.35,             // traces only
            });
```

Three consequences:

1. **`query` and `reflect` do not agree about reach.** `query` extends `consulted_runs` with
   *every* linked run and runs the whole retrieval over them. `reflect` takes the first three
   and reads only their echo traces. A mesh of four or more projects is fully visible to
   recall and partly invisible to lesson extraction.
2. **Linked evidence can displace the session's own.** The items are pushed at the *end*, and
   the very next block is `if req.last_n_items > 0 { evidence.drain(..evidence.len() - n) }` —
   which keeps the **tail**. The plugin sends `last_n_items: 200`
   (`hooks/src/session-end.mjs:138`), so up to 60 of those 200 slots — 30% — can be linked
   traces displacing this session's *oldest* own evidence.
3. **It is bounded, which is why the flag is still worth setting.** 60 is the ceiling however
   many runs are linked, and a session with fewer than 140 evidence items loses nothing.

### §4.1 — the link graph, measured

Run on 2026-08-21 against `api.mubit.ai`, driving `lib/http.mjs` directly. Two runs, one item
each, neither ever reflected:

```
1) write one item into each of two unrelated runs
   ingest tk-link-alpha-7c31: ok=true      ingest tk-link-beta-7c31: ok=true
   job A completed · job B completed

2) BEFORE any link — A asks about beta's port
   A, unlinked            sources=1  ALPHAFACT=true  BETAFACT=false

3) link A <-> B (mesh: both directions)
   tk-link-alpha-7c31 -> tk-link-beta-7c31: ok=true
   tk-link-beta-7c31 -> tk-link-alpha-7c31: ok=true
   self-link guard: ok=false state=invalid_request (refused without dialing)

4) AFTER the link — same question, same run
   A, linked to B         sources=2  ALPHAFACT=true  BETAFACT=true
   B, linked to A         sources=2  ALPHAFACT=true  BETAFACT=true
```

And revoking it, which is the half that makes a link safe to grant:

```
5) unlink, both directions
   still linked           sources=4  ALPHAFACT=true  BETAFACT=true
   unlink lpha-7c31 -> beta-7c31: ok=true
   unlink beta-7c31 -> lpha-7c31: ok=true
   after unlink           sources=2  ALPHAFACT=true  BETAFACT=false
```

**That is Target C working, in both directions.** The boundary held before the link, opened
only between the two runs named, and closed again on request — and the items never left `run` scope. Compare §1.4, where one environment
variable made a single lesson readable by *every* run on the instance: same visibility, a
blast radius of two runs instead of all of them, and revocable per pair — measured above,
not asserted. There is no equivalent of that last line for `MUBIT_MCP_LESSON_SCOPE`: the only
way to withdraw what it published is to delete the lesson, as §1.5 had to.

### §4.3 — the `/mubit-memory:link` surface, end to end

§4.1 drove the routes directly. This drives the command a user actually types, against the
same instance, with two throwaway projects:

```
1. list      [ ] …/cli-test/there   2h ago
2. link      Linked this project to …/cli-test/there.
             Recall here can now see their memory, and theirs can see this one. `unlink` revokes it.
3. list      [x] …/cli-test/there   2h ago
```

and the server agrees, which is the part a local ledger could fake:

```
consulted_runs               ["…::tk-cli-here-3f2a", "…::tk-cli-there-3f2a"]
consulted_runs after unlink  ["…::tk-cli-here-3f2a"]
```

Run against the real session map, the picker renders what §6 asked for — directories,
relative dates, `same remote` grouping, and no run id anywhere:

```
Memory in this project:  ~/Mubit/pre-main

  [ ] ~/Mubit/pre-main                      just now   same remote
  [ ] ~/Mubit/Benchmarking/TBench             1h ago
  [ ] ~/Mubit/hook-surface                    2h ago   same remote
  [ ] ~/Mubit/hook-surface                    2h ago   before /clear · same remote
  [ ] ~/Mubit/claude-plugins                 22h ago   same remote
```

The two `hook-surface` rows are the reason to run this against a real map rather than a
fixture. A `/clear` leaves one directory holding two runs, so "address projects by directory"
stops being a unique address — and both rows rendered identically until the `before /clear`
note was extended to cover projects other than the current one. Both rows are kept: both runs
are real and linkable, and collapsing them would hide the pre-reset memory, which is exactly
what SC-05's preamble tells the user to go and reconnect.

### §4.2 — reflect: the mechanism is in the code, and this probe could not observe it

Attempted, and worth writing down as a **negative result** so nobody repeats it. `reflect` was
called on run A twice, `include_linked_runs` false then true, with B holding first a
lesson-shaped item and then a trace-shaped one:

```
include_linked_runs=false  lessons=1  BETAFACT=false  linkedMarker=false
include_linked_runs=true   lessons=1  BETAFACT=false  linkedMarker=false
```

No observable difference. **This does not show that reflect ignores linked runs**, and reading
it that way would be wrong on two counts:

1. **The marker was never going to appear.** `[linked:…]` is written into
   `ReflectionEvidence.content` — the *input* to the reflection model. The response carries
   *extracted lessons*, not the evidence they were extracted from. Grepping the response for
   the marker tests nothing.
2. **The linked branch reads `self.echoes.list(...)`** — the history store — and it is not
   established that `POST /v2/control/ingest` with `intent: "trace"` populates it. The second
   attempt above assumed it does; that assumption is untested.

So the honest state: §4's mechanism is read from the source and is not in doubt, and this
experiment was not capable of confirming or refuting it. A conclusive test needs either
server-side visibility into the assembled evidence vector, or a linked run whose echoes were
populated by real session capture rather than by direct ingest — i.e. walk a full session in
one project, link it, and end a session in the other.

Recorded rather than quietly dropped, because "we measured it and saw nothing" and "we
measured the wrong thing" are different facts and only one of them is true here.

---

## §5 — Teardown

```bash
rm -rf /tmp/mubit-scope-b1
unset MUBIT_CC_DATA_DIR MUBIT_CC_RUN_STRATEGY MUBIT_CC_RUN_ID MUBIT_CC_LOG_LEVEL
unset MUBIT_ENDPOINT MUBIT_API_KEY
env | grep -c MUBIT_MCP_LESSON_SCOPE     # expect 0, again
```

The last line is repeated on purpose. `lib/config.mjs` puts env above `credentials.json`, and
a `MUBIT_MCP_LESSON_SCOPE` left exported is the one variable in this file that changes what
*other people's* sessions can read.
