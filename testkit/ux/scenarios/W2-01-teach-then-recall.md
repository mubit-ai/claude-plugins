# W2-01 — Teach it once in one session, start over in another

**Family** W2 cross-session continuity · **Moments** M1, M2*, M4, M6, M7 · **Sessions** 2 · **Duration** ~12 min

**Backend** hosted · **Arms** plugin-on, plugin-off · **Requires** a green `lab preflight` from the last 30 minutes

This is the scenario the product exists for. Everything else in W2 is a variation on it, and
every other family borrows its shape. If this one does not pass, nothing else in the kit is
worth reading.

## What this proves

That a constraint stated once in session 1 reaches the model in session 2 **before it asks**,
through the entire chain: capture → spool → drain → ingest → job completion → reflection →
recall → injection. Every link is separately observable in step 8, so a failure names its
link instead of indicting the product.

It also prices the claim. The `Yms` in step 7 is what the user waits before their first
token, and the `tok` is what it cost them in context. A version that doubles either has
regressed even if the memory still arrives.

## Setup

One paste. It pins the four variables that otherwise silently redirect the run, and it works
in a throwaway repo because self-reference suppression drops any capture whose text mentions
`mubit`.

```bash
export PLUG=/Users/eldaru/Mubit/pre-main/integrations/claude-code   # the version under test
export TK=/tmp/tk-w2-01
export DATA=$TK/data
export REPO=$TK/repo

rm -rf "$TK" && mkdir -p "$DATA" "$REPO"
cd "$REPO" && git init -q
printf 'def total(items):\n    return sum(i["price"] for i in items)\n' > cart.py
printf 'import cart\ndef test_total():\n    assert cart.total([{"price": 2}]) == 2\n' > test_cart.py
git add -A && git -c user.email=t@example.com -c user.name=t commit -qm init

export MUBIT_CC_DATA_DIR="$DATA"
export MUBIT_CC_RUN_STRATEGY=static
export MUBIT_CC_RUN_ID=tk-w2-01
export MUBIT_CC_LOG_LEVEL=debug
export MUBIT_ENDPOINT=$(node -e 'process.stdout.write(require(process.env.HOME+"/.claude/plugins/data/mubit-memory-mubit/credentials.json").endpoint)')
export MUBIT_API_KEY=$(node -e 'process.stdout.write(require(process.env.HOME+"/.claude/plugins/data/mubit-memory-mubit/credentials.json").apiKey)')

echo "repo $REPO"; echo "data $DATA"; echo "run  $MUBIT_CC_RUN_ID"
```

`MUBIT_CC_RUN_STRATEGY=static` with a pinned `MUBIT_CC_RUN_ID` is what makes session 2 land
in the same run as session 1 without depending on `git rev-parse` or a directory hash.
Without it, this scenario tests run-id derivation rather than memory.

The credentials matter as much. A `--plugin-dir` install writes to
`~/.claude/plugins/data/mubit-memory-inline`, which has never been through
`/mubit-memory:auth`; combined with a pinned `MUBIT_CC_DATA_DIR` there is no stored key
anywhere on the path. Skip the two exports and you are testing an unconfigured plugin.

## Steps

**1 — Open session 1.** The `--settings` string stops your installed marketplace copy from
loading alongside the one under test. It is a JSON string, not a path.

```bash
cd "$REPO"
claude --plugin-dir "$PLUG" \
       --settings '{"enabledPlugins":{"mubit-memory@mubit":false}}' \
       --debug-file "$TK/s1.log"
```

**2 — Teach it something a fresh model could not guess.** Type this as your first prompt:

```
In this repo prices are integer cents, never floats. Any function that returns a
price must return an int. Fix cart.total to enforce that.
```

**3 — Let it work.** Accept the edit. Run the test when it offers.

**4 — Close the session properly.** `/exit`, not Ctrl-C twice.

`SessionEnd` is the only path that promotes a lesson beyond its own run, and with
`sessionEndDetach` at its default `true` the promotion finishes in a detached child a few
seconds after the CLI returns. Ctrl-C can outrun it.

**5 — Wait for the ingest job to finish.** This is the step people skip, and skipping it
turns a working plugin into a failed scenario.

Two different facts, from two different places, and conflating them is why this step used to
be unrunnable:

```bash
# (a) spool_pending — a LOCAL fact, and mubit-inspect is the right reader for it
node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run tk-w2-01 --json | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
  console.log("spool pending:", j.spool_pending);
  console.log("reflect:", j.marker.reflect.status, "lessons:", j.marker.reflect.lessons_stored);})'

# (b) job status — a SERVER fact. Ask the server.
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const P = process.env.PLUG;
const { loadConfig }   = await import(pathToFileURL(P + "/lib/config.mjs").href);
const { getIngestJob } = await import(pathToFileURL(P + "/lib/http.mjs").href);
const jobs = JSON.parse(readFileSync(process.env.DATA + "/runs/tk-w2-01/jobs.json", "utf8"));
const last = jobs[jobs.length - 1];
const r = await getIngestJob(loadConfig(process.env), "tk-w2-01", last.job_id, { timeoutMs: 15000 });
console.log(r.ok ? `job ${last.job_id.slice(0,8)} -> ${r.body.status}` : `${r.state}: ${r.error}`);'
```

Repeat until `spool_pending` is `0` and (b) reports `completed`. Seconds is normal. Ten
minutes means the embedding service behind the instance is down, this scenario cannot pass,
and the right move is to stop and re-run `lab preflight`.

> **Do not poll `mubit-inspect` for job status.** It reads `runs/<run>/jobs.json`
> (`scripts/mubit-inspect.mjs:132`), a snapshot written when the job was *submitted* that
> nothing ever refreshes. It says `queued` forever. Measured 2026-08-21: the local record
> read `queued` while the server had finished the same job 322 ms after creating it — so the
> old version of this step sent the operator to wait out ten minutes and declare a healthy
> backend down. See `docs/W2-01-baseline-walk.md`.

**6 — Open session 2 in the same directory, with the same environment.**

```bash
cd "$REPO"
claude --plugin-dir "$PLUG" \
       --settings '{"enabledPlugins":{"mubit-memory@mubit":false}}' \
       --debug-file "$TK/s2.log"
```

**7 — Ask an adjacent question that does not name the constraint.**

```
Add a discount(items, pct) function to cart.py.
```

**8 — Read what the plugin claimed it did.**

```bash
node -e '
const t=require("fs").readFileSync(process.env.TK+"/s2.log","utf8");
for (const m of t.matchAll(/mubit: (\d+) memor\S+ · ([\d.]+k?) tok · (\d+)ms/g))
  console.log(`${m[1]} sources · ${m[2]} tok · ${m[3]}ms`);'
node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run tk-w2-01 --last 10
node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run tk-w2-01 --last 10 --resolve
```

Read the `tok` field with a parser, not with `grep -o` and your eyes: anything at or above
1000 renders as `1.2k`, and the obvious grep silently truncates it.

**9 — Clean up.** `rm -rf /tmp/tk-w2-01`. Memories written under `tk-w2-01` stay in Mubit,
which is usually what you want; `/mubit-memory:forget` with the session id removes the run.

## Expect

**Step 2** — a system line under your prompt, sources 0 or low, because nothing is stored
yet:

```
mubit: 0 memories · 0 tok · 412ms
```

**Step 4** — `mubit-inspect` shows `reflect.status` moving off `skipped:not-ingested`.

**Step 7** — the load-bearing expectation. Before the model's first token:

```
mubit: 2 memories · 148 tok · 1810ms
```

and `discount` comes back returning an `int`, in cents, **without you having said so**. The
model may or may not mention where it learned it; do not require that it does.

**Step 8** — `--resolve` prints the lesson text, which should contain "cents" or "int". A
`used(m/c)` value like `4/12` on that row is the used-signal firing.

## Touchpoints

```
hooks:  SessionStart, UserPromptSubmit*, PostToolUse, Stop, SessionEnd
tools:  —
skills: —
config: runStrategy, reflectOnEnd, sessionEndDetach, recallRepeatMode, recallAsync
```

## Pass / fail

1. Step 7 injects at least one source (`mubit: N memories`, N ≥ 1). **Hard fail at 0.**
2. The injected text, resolved in step 8, is the constraint from step 2 — not an unrelated
   top hit. Recall has no relevance floor, so a wrong hit is a failure here, not a near miss.
3. The generated `discount` respects the constraint. **Soft**: this is model behaviour, not
   plugin behaviour. Record it; do not gate on it.
4. Step 7's `Yms` is under 3000. Over the 3 s `UserPromptSubmit` budget means the host killed
   the hook and the user got nothing.
5. No `warn` line carrying `budget_ms` in `$DATA/logs/mubit-cc.log`.

## Known-not-bugs

- **Session 1 shows `0 memories`.** Correct. Nothing is stored yet, and an honest empty
  recall is the desired behaviour — see W3-01.
- **The status line reads `◌ not_responding` for a few seconds after step 6.** The marker is
  last-write-wins and starts cold; it settles once the first recall lands.
- **`used(0/2)` on the injected row.** The used-signal measures echo, not benefit. A model
  that applied a constraint without repeating its words scores 0 and was still helped.
- **Two runs appear in `--runs`.** Only if `MUBIT_CC_RUN_ID` was not exported in the second
  shell — which is a setup error, not a plugin bug, and pass/fail item 1 will catch it.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| Step 7 shows `0 memories` | `--json` → `marker.recall.empty_reason` | `policy_denied` is a cached 24 h denial; `budget_exhausted` means the endpoint is slow, not the plugin |
| Step 7 shows nothing at all | `grep -c UserPromptSubmit "$TK/s2.log"` | the hook never ran — the plugin did not load; check `plugins[]` in a `--output-format stream-json` init event |
| `spool_pending` never reaches 0 | `--json` → `marker.state` | breaker open, or a stale `drain.lock` (stolen after 60 s) |
| Job stays `queued` in `mubit-inspect` | ask the server, step 5 (b) | **expected** — the local record is a submit-time snapshot and never refreshes. Only (b) can answer this |
| Job stays `queued` **at the server** | — | the embedding service is down. Not a plugin fault; the run is void |
| Session 2 lands in a different run | `mubit-inspect --runs` | `MUBIT_CC_RUN_ID` was not exported in the second shell |

## Teardown

```bash
rm -rf /tmp/tk-w2-01
unset MUBIT_CC_DATA_DIR MUBIT_CC_RUN_STRATEGY MUBIT_CC_RUN_ID MUBIT_CC_LOG_LEVEL
unset MUBIT_ENDPOINT MUBIT_API_KEY
```

Leaving those exported is the single most common way the *next* scenario measures the wrong
instance — `lib/config.mjs` puts env above `credentials.json`. `lab preflight` checks for
exactly this and fails on it.

## Record

```bash
node "$PLUG/../../testkit/bin/lab.mjs" ux   # then note the result in results/<stamp>/ux-results.md
```
