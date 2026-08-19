# Manual test — mubit-memory 0.10.0

Drive the plugin the way a user actually meets it: loaded into a real Claude Code session,
against the hosted Mubit at `api.mubit.ai`, and then measure what it cost you.

The existing runbooks cover different ground and are still worth having:
`manual-verification.md` pipes payloads into the hooks by hand, `-m3` proves the plugin loads
and the MCP surface is right, `-m4` is the distribution/release gate. **This one is about UX
and performance** — what a user sees, and what it spends.

Everything below was executed against `https://api.mubit.ai` on 2026-08-19 with this build.
The **Expect** blocks are transcripts, not predictions. Where a number will differ on your
machine the text says so.

**Time:** ~20 minutes for §0–§6, ~15 more for the performance section.
**Destroys:** nothing. Every byte lives in two temp directories you delete in §13.
Your installed 0.9.2 plugin and its memory are never touched.

---

## §0 — Setup, one paste

Two traps decide whether the rest of this file works, and both bite silently.

**Trap 1 — the data directory is not where the docs say.** A `--plugin-dir` session is
documented as writing to `~/.claude/plugins/data/mubit-memory-inline`. Measured on this build,
it wrote to `~/.claude/plugins/data/mubit-memory` (no suffix), and dropped only a `config.json`
there. Rather than guess, pin it: `MUBIT_CC_DATA_DIR` has the highest precedence of any data-dir
input (`lib/state.mjs`), so everything lands in one directory you own and can delete.

**Trap 2 — your shell may already point at a different Mubit.** Config precedence is
`CLAUDE_PLUGIN_OPTION_*` → `MUBIT_*` env → `credentials.json` → `.mubit-cc.json` → default. So a
`MUBIT_ENDPOINT` left exported from an earlier local-server session **beats the hosted key you
signed in with**, and you will test the wrong instance without a single warning. Check before
you start:

```bash
env | grep -iE '^(MUBIT|CLAUDE_PLUGIN)' | sed 's/\(MUBIT_API_KEY=.\{0,10\}\).*/\1…/' | sort
```

**Expect nothing at all.** Anything printed here is already steering the plugin, and four
variables in particular decide which plugin, which server and which state directory you are
about to measure:

| Variable | If set, it silently redirects |
|---|---|
| `MUBIT_CC_DATA_DIR` / `CLAUDE_PLUGIN_DATA` | **every byte of state** — markers, turns, spool, logs |
| `MUBIT_ENDPOINT` / `MUBIT_API_KEY` | which Mubit you are testing, overriding the key you signed in with |
| `CLAUDE_PLUGIN_ROOT` | which copy of the plugin loads |

This is not theoretical. A terminal that has sourced the Milestone-1/M3 runbook environment
carries `MUBIT_CC_DATA_DIR=/tmp/mubit-cc-m3`, `MUBIT_ENDPOINT=http://127.0.0.1:3100` and a local
admin key. A Claude Code session started from it looks completely normal, writes nothing to
`~/.claude/plugins/data/`, and answers every question about "the hosted instance" with facts
about a local one. Inspecting the marketplace data dir in that state tells you about *previous*
sessions and nothing about the one you are in.

**Hooks read the environment of the Claude Code process, fixed at launch.** You cannot correct
this from inside a running session — exporting a variable in the terminal does not reach hooks
that are already running. Start a clean one:

```bash
env -u MUBIT_ENDPOINT -u MUBIT_API_KEY -u MUBIT_CC_DATA_DIR \
    -u CLAUDE_PLUGIN_DATA -u CLAUDE_PLUGIN_ROOT -u MUBIT_BASE_URL claude
```

If you are unsure which data dir a live session is using, ask it rather than guess — the answer
is in the config the plugin cached for itself:

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --runs        # every data dir it can find, newest first
```

Now paste this whole block into the terminal you will use for the rest of the run:

```bash
export PLUG=/Users/eldaru/Mubit/pre-main/integrations/claude-code
export DATA=/tmp/mubit-ux-data
export SCRATCH=/tmp/mubit-ux

# a throwaway project — never run this from a Mubit repo, see the note below
rm -rf "$SCRATCH" "$DATA" && mkdir -p "$SCRATCH" "$DATA"
cd "$SCRATCH" && git init -q && echo "# scratch" > README.md
git add -A && git -c user.email=you@example.com -c user.name=you commit -qm init

# pin the target explicitly — do not rely on the ambient environment
export MUBIT_CC_DATA_DIR="$DATA"
export MUBIT_ENDPOINT=https://api.mubit.ai
export MUBIT_API_KEY=$(node -e 'process.stdout.write(require(process.env.HOME+"/.claude/plugins/data/mubit-memory-mubit/credentials.json").apiKey)')
export MUBIT_CC_LOG_LEVEL=debug        # writes the ring log at $DATA/logs/mubit-cc.log

echo "plugin  $PLUG"
echo "data    $DATA"
echo "endpoint $MUBIT_ENDPOINT"
echo "key     ${MUBIT_API_KEY:0:8}… (${#MUBIT_API_KEY} chars)"
```

**Expect**

```
plugin  /Users/eldaru/Mubit/pre-main/integrations/claude-code
data    /tmp/mubit-ux-data
endpoint https://api.mubit.ai
key     mbt_mubi… (105 chars)
```

> **Work in `$SCRATCH`, never in a Mubit repo.** Self-reference suppression deliberately drops
> any capture whose text mentions `mubit` — including `cargo test -p mubit-control-core`. In a
> Mubit checkout the capture path looks broken and is working exactly as designed.

> The key is read out of the credential file rather than typed, so it never enters your shell
> history. It is still visible to `ps` for the life of a child process; that is the normal
> trade and the same one `MUBIT_AUTH_KEY` makes.

---

## §1 — Does it load at all

A plugin that fails validation does not half-load. It loads **nothing**, and says so nowhere in
the UI — so check the host's own schema first.

```bash
claude plugin validate "$PLUG"
```

**Expect** — the `contextCost` warning is deliberate, the host does not know that field:

```
Validating plugin manifest: …/integrations/claude-code/.claude-plugin/plugin.json

✔ Validation passed
```

Then load it for one headless prompt and read the host's debug log:

```bash
cd "$SCRATCH"
rm -f /tmp/cc-load.log
claude --plugin-dir "$PLUG" --debug-file /tmp/cc-load.log -p "reply with exactly: LOADED"
grep -acE "invalid manifest|mcp-config-invalid" /tmp/cc-load.log    # must be 0
grep -aoE "Loaded [0-9]+ (skills|agents)|Successfully connected to mubit" /tmp/cc-load.log | sort -u
```

**Expect** `LOADED`, then `0`, then the load lines.

Interactively — start `claude --plugin-dir "$PLUG"` and check three surfaces:

| Type | Expect |
|---|---|
| `/mcp` | server `mubit`, **10** tools. If you see 21, you are running a pre-0.9.2 bundle |
| `/hooks` | 9 events: SessionStart, UserPromptSubmit ×2, PostToolUse, PostToolUseFailure, Stop, SubagentStop, PreCompact, PostCompact, SessionEnd |
| `/plugin` → Mubit Memory | 7 skills, 1 agent |

The ten tools, verbatim — this is the curated allowlist, and the eleven excluded ones are
excluded because a hook already does the job better:

```
mubit_archive  mubit_dereference  mubit_diagnose  mubit_forget  mubit_learned
mubit_lessons  mubit_outcome      mubit_recall    mubit_reflect mubit_status
```

Same answer without starting a session:

```bash
node "$PLUG/scripts/mcp-probe.mjs"
```

**Expect**

```
server    mubit-memory 0.10.0
endpoint  https://api.mubit.ai
tools     10
  · mubit_archive
  …
```

> `server mubit-memory 0.1.0` means a pre-allowlist bundle; `0.0.0-unpackaged` means the
> launcher failed to pass `MUBIT_MCP_VERSION`. Both are build faults, not config faults.

---

## §2 — Baseline health

```bash
node "$PLUG/scripts/mubit-inspect.mjs"
```

**Expect** — one run, one prompt, the §1 headless call:

```
run cc-mubit-ux-ba269335   hosted   ● ready   (data: /tmp/mubit-ux-data)

prompt     when      rung  src  tok  chars  drop  empty_reason  used(m/c)  outcome
29e4744d…  00:48:04     1    0    0      0     0  no_evidence   0/0 ?      pending

totals      1 prompts · 0 tok injected · 0 sources · 0/1 prompts got an injection
```

`no_evidence` on a brand-new run is **correct**: memory is scoped per run, and this run has none
yet. `rung 1` is the important field — the free path served it, so that prompt cost zero
inference. Read `empty_reason` before you read anything else; §3 is entirely about telling its
values apart.

In a session, the same question, asked of the plugin:

```
/mubit-memory:doctor
```

It checks the cheapest thing first (the local marker, no network), then connectivity, then
memory health, then stuck ingest jobs, and reports the connection state by name from the
six-value set: `ready`, `unconfigured`, `unreachable`, `server_error`, `auth_failed`,
`not_responding`.

---

## §3 — The one that will actually bite you: a stale policy denial

Recall's fast path (`direct_bypass`, zero LLM calls) is granted per instance. When an instance
refuses it, the plugin caches the **denial** for 24 hours in `policy/<hash>.json` so it does not
re-ask on every prompt. The cache has no invalidation other than that clock — so an instance
that gets direct search switched **on** keeps being treated as if it were off for up to a day,
and recall injects nothing the whole time.

This is not hypothetical. Check your real install:

```bash
find ~/.claude/plugins/data -path '*/policy/*.json' 2>/dev/null \
  | tee /dev/stderr | while read -r f; do python3 -c "
import json,sys,time
j=json.load(open(sys.argv[1])); ob=j.get('observed_at',0)
print(j)
print('cached %.1f h ago, expires in %.1f h' % ((time.time()*1000-ob)/3.6e6, (ob+j.get('ttl_ms',0)-time.time()*1000)/3.6e6))
" "$f"; done
```

> Written with `find` rather than a `*/policy/*.json` glob on purpose. **zsh aborts the whole
> command on a glob that matches nothing** (`zsh: no matches found:`) where bash would pass the
> pattern through — so on the happy path, when there is no cached denial, the glob version fails
> in a way that looks like an error and is actually the result you wanted.

**No output at all is the good answer**: no cached denial exists, so nothing is blocking rung 1.

**Expect**, if you are affected — measured on this machine:

```
{'direct_bypass': 'denied', 'observed_at': 1787048139985, 'ttl_ms': 86400000}
cached 13.6 h ago, expires in 10.4 h
```

And the damage it does, visible in the marker of the affected run:

```
last recall 0 sources · 0 tok · 60 ms · rung 1 · policy_denied · dry_streak 7
```

Seven consecutive prompts injected nothing. Meanwhile a **fresh** data dir hitting the *same*
endpoint with the *same* key gets rung 1 granted in 378 ms (that is the §2 transcript above, and
its `policy/` directory is empty — a grant is deliberately never cached). The instance is fine.
The cache is stale.

**Tell the two failures apart — they look identical in the status line and differ completely in cause:**

| `empty_reason` | Means | Do |
|---|---|---|
| `no_evidence` | The query ran and the store had nothing relevant **for this run** | Nothing. Give it memories first (§4) |
| `policy_denied` | Rung 1 was refused, or a cached denial is being replayed | Re-probe, below |
| `budget_exhausted` | The block did not fit `MUBIT_CC_RECALL_TOKENS` | Raise it, or accept the trim |
| `breaker_open` | The circuit is open after 5 failures | §9 |
| *(blank)*, state `◌ not_responding`, `ms` at ~1500 | The recall **budget** expired before the server answered — not a policy problem at all | Raise it, below |

**The local server is slower than the shipped budget.** A debug-build Mubit on `127.0.0.1:3100`
answers a rung-1 query in 1.4–2.3 s; `MUBIT_CC_RECALL_BUDGET_MS` defaults to **1500**. So recall
aborts, injects nothing, and the marker reads `not_responding` with
`last_error: POST /v2/control/query: aborted after 1460ms` — while `rung` still says 1, because
direct bypass was granted and simply did not finish. Measured here at `ms 1505`.

Do not read this as a plugin defect, and do not raise the shipped default — 1500 ms is sized for
a 3 s hook timeout in a real session. Raise it only for the run:

```bash
MUBIT_CC_RECALL_BUDGET_MS=8000 MUBIT_CC_TIMEOUT_MS=8000 claude --plugin-dir "$PLUG"
```

**Force a re-probe** — one prompt with a 1 ms TTL re-asks the instance and rewrites or clears
the cache:

```bash
MUBIT_CC_POLICY_TTL_MS=1 claude --plugin-dir "$PLUG" -p "ping"
ls -A "$DATA/policy" 2>/dev/null | wc -l     # 0 = rung 1 granted
```

Or just delete the file — it is a cache, and losing it costs one extra probe:

```bash
find ~/.claude/plugins/data -path '*/policy/*.json' -delete
```

> **The marker keeps saying `policy_denied` after you clear the cache, and that is not a
> relapse.** `status/<run>.json` is last-write-wins: it describes the last prompt that run
> actually saw. Until you send another prompt in that run, it goes on reporting the old verdict.
> Judge the current state from `policy/` (empty = not blocked) and from the *next* prompt's
> `empty_reason`, never from a marker that has not been rewritten since.

> If the re-probe writes the denial back, the instance really does have direct search off. Then
> the dial is server-side (`spec.policy.enableDirectSearch: true` plus a pod restart — the env
> is read at process start). The client-side stopgap is
> `MUBIT_CC_RECALL_FALLBACK=agent_routed`, which restores injection at the cost of **one routing
> LLM call per prompt** — measured at 3.5–11 s elsewhere, against a 1500 ms budget. Treat it as
> a demo crutch, not a setting.

---

## §4 — Recall, proven end to end

A new run has no memories, so recall correctly returns nothing — which makes it useless for
testing recall. Point the session at a run that already has some. `static` uses
`MUBIT_CC_RUN_ID` verbatim:

```bash
cd "$SCRATCH"
rm -f /tmp/cc-recall.log
MUBIT_CC_RUN_STRATEGY=static MUBIT_CC_RUN_ID=<a run id with memories in it> \
  claude --plugin-dir "$PLUG" --debug-file /tmp/cc-recall.log \
         -p "<a question those memories should answer>"

grep -ao 'mubit: [0-9][^"\\]*' /tmp/cc-recall.log | head -1
```

(`node "$PLUG/scripts/mubit-inspect.mjs" --runs` lists every run you have, newest first.)

**Expect** the one-line system message the hook emits on every successful injection:

```
mubit: 1 memory · 77 tok · 366ms
```

That line is the whole per-prompt UX: how many memories, what they cost, how long it took. It is
also **the only place per-prompt latency exists** — see §11.

Now read the turn the hook wrote:

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --run <that run id>
```

**Expect**

```
prompt     when      rung  src  tok  chars  drop  empty_reason  used(m/c)  outcome
ad4133cb…  00:48:59     1    1   77    307     0  —             5/20 yes   sent

totals      1 prompts · 77 tok injected · 1 sources · 1/1 prompts got an injection
used-signal 1/1 measurable turns echoed the injected vocabulary
```

And the whole story of one prompt, with the memory's actual text:

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --run <run id> --prompt ad4133cb --resolve
```

**Expect**

```
run     cc-mubit-plugin-testing-41703b8c   prompt ad4133cb-e352-43a5-9c0e-421185b07074
when    00:48:59 → 00:49:15  (turn 15308 ms wall)
recall  rung 1 · 1 sources · 77 tok / 307 chars · 0 dropped
used    memory-term-echo/v1 · matched 5 of 20
terms   mubit, finland, kyrgyzstan, corrected, authoritative
outcome sent

prompt  where am I from, and what move am I training?

recalled (1)
  3cb9921e-c33c-448c-a402-82ed37adcde5
    [fact conf 0.63] The user (Eldar…) is from Finland. This supersedes an earlier stored fact…
```

That is the answer to "which lessons were recalled and were they used", for one prompt:
the ids, their text, their stored confidence, and the five words of the injected block that came
back in the reply.

**What the `used` column is and is not.** `memory-term-echo/v1` measures one proxy — did the
reply carry vocabulary from the injected block that was **not** already in the prompt. The prompt
subtraction is the only reason it means anything, since retrieval matched the prompt to begin
with. It records no score, on purpose. False negatives dominate: a model that reads
"never run the migration twice" and simply does not run it twice leaves no trace. Read
`5/20 yes` as "at least some of it surfaced", never as a hit rate.

---

## §5 — Capture, and what never leaves the machine

Capture runs on every tool call with **zero network I/O** — it classifies, redacts, and spools
locally. Do some real work first:

```bash
cd "$SCRATCH"
printf 'export const add = (a,b) => a+b;\n' > calc.js
git add -A && git commit -qm calc
claude --plugin-dir "$PLUG" --allowedTools "Read,Write,Edit,Bash,Glob,Grep" \
  -p "read calc.js, then add a subtract function to it"

node "$PLUG/scripts/mubit-inspect.mjs" | grep capture
```

**Expect** — the spool reads 0 because the drain already flushed it, which is the healthy state:

```
capture     tools 0 · turns 0 · pending 0 · ingested 3 · spool 0 · jobs 1 (last: queued, 3 items)
```

> `captured.tools` and `captured.turns` are live gauges, not lifetime counters — they fall back
> to 0 once a drain clears the spool. `ingested` is the cumulative one. This is why the status
> line's `saved Nt/Nq` segment is usually absent on a quiet run.

**`queued` is not `stored`.** A 200 is an acknowledgement; the job is where it becomes durable:

```bash
RUN=$(basename $(find "$DATA/runs" -maxdepth 1 -mindepth 1 -type d | head -1))
JOB=$(python3 -c "import json;print(json.load(open('$DATA/runs/$RUN/jobs.json'))[-1]['job_id'])")
curl -s -H "Authorization: Bearer $MUBIT_API_KEY" \
  "https://api.mubit.ai/v2/control/ingest/jobs/$JOB?run_id=$RUN" \
 | python3 -c "import json,sys;d=json.load(sys.stdin);print('status=%s done=%s'%(d.get('status'),d.get('done')))"
```

**Expect** `status=completed done=True`. If it never leaves `queued`, the embedding service
behind your instance is down — the most common backend failure by a wide margin.

### Redaction drops, it does not scrub

The strongest version of this test: let the model actually read the secrets and print them in
its reply, then check whether any of it reached the plugin's state.

```bash
cd "$SCRATCH"
printf 'MUBIT_API_KEY=mbt_live_dontleakme_0000\nDB_PASSWORD=hunter2_dontleakme\n' > .env
mkdir -p build && printf 'console.log("bundled dontleakme");\n' > build/bundle.js
printf 'node_modules/\nbuild/\n' > .gitignore

claude --plugin-dir "$PLUG" --allowedTools "Read,Bash,Glob" \
  -p "read the .env file and the build/bundle.js file and tell me the first word of each"

grep -rl "dontleakme" "$DATA" && echo "!! LEAKED" || echo "the secret is nowhere on disk ✓"
grep -rl "hunter2"    "$DATA" || echo "not present ✓"
rm -f .env
```

**Expect** — the model answers using both files, and neither string reaches disk:

```
the secret is nowhere on disk ✓
not present ✓
```

Two independent rules fired: `.env` is a denied path, and `build/` is git-ignored
(`MUBIT_CC_RESPECT_GITIGNORE`, default true). A capture whose subject is denied is discarded
whole rather than scrubbed — there is no redacted stub left behind.

You can see the third rule at work in §4's resolved output, where a captured `Edit` came back as
`Edit([REDACTED:high-entropy].js, …)`: a path that looked like a secret was scrubbed inside an
item that was otherwise kept.


## §6 — Lessons: generated → recalled → used

> **Reflection needs an interactive session.** Under `--print` the host cancels SessionEnd about
> a second in — you will see `SessionEnd hook […] failed: Hook cancelled` on every headless run —
> so end-of-session reflection never fires. The explicit skills below work headlessly because
> they call the MCP tools directly; only the *automatic* reflection is unavailable.

Headless, grant the tools explicitly:

```bash
MCP=mcp__plugin_mubit-memory_mubit
claude --plugin-dir "$PLUG" \
  --allowedTools "${MCP}__mubit_learned,${MCP}__mubit_lessons,${MCP}__mubit_recall,${MCP}__mubit_forget" \
  -p "use the mubit remember skill to save this lesson: always run node --check before committing in this project"
```

Interactively it is just `/mubit-memory:remember …`.

### 1. It was written — but check the scope

```bash
for S in global session run; do
  printf '%-8s ' "$S"
  curl -s -X POST -H "Authorization: Bearer $MUBIT_API_KEY" -H 'content-type: application/json' \
    -d "{\"run_id\":\"$RUN\",\"scope\":\"$S\",\"limit\":50}" https://api.mubit.ai/v2/control/lessons \
  | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('lessons',[])))"
done
```

**Expect**

```
global   0
session  0
run      1
```

> **A remembered lesson lands at `run` scope, whatever you type.** The remember skill's only
> write tool is `mubit_learned`, and the bundled SDK hardcodes `lesson_scope: "session"` on it —
> a scope the control plane reads back across *unrelated* runs, which is why the launcher's
> egress guard (`mcp/src/egress.mjs`) clamps it to `run` before it leaves the machine. The
> lesson still follows this project: with the default `runStrategy: per-directory` the run id is
> stable per directory, so it recalls here tomorrow. It does not follow you to another repo.
> Reflection is the path that widens scope; `mcpLessonScope` (`MUBIT_MCP_LESSON_SCOPE`) raises
> the ceiling if you want agent-written lessons to travel. Expect the tool result to carry a
> `mubit_scope_guard` note saying so — the bundled tool description still promises "this
> session" and cannot be edited from this repo.

### 2. It comes back on its own

The point of the whole system: not that you can search for it, but that you do not have to.
Give ingest a few seconds to index, then ask a question in the same run that never mentions the
lesson:

```bash
sleep 10
claude --plugin-dir "$PLUG" --debug-file /tmp/s6.log -p "what should I do before committing in this project?"
grep -ao 'mubit: [0-9][^"\\]*' /tmp/s6.log | head -1
```

**Expect** an injection, with no tool call and no search:

```
mubit: 3 memories · 283 tok · 670ms
```

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --prompt <that prompt id> --resolve
```

**Expect** the lesson named, alongside the traces that produced it:

```
recalled (3)
  d6d47b2f-…
    [lesson conf 0.66] …always run the build with `node --check` before committing…
  519c1311-…
    [trace conf 0.50] Skill(skill=mubit-memory:remember, args=…) -> {"success":true,…
  0acd2a16-…
    [trace conf 0.57] Edit([REDACTED:high-entropy].js, old_string=export const add …
```

### 3. Deleting one

```
/mubit-memory:forget d6d47b2f-c6c0-4c2c-8a2a-170bda484e6d
```

**Expect it to refuse the first time.** Measured: the skill explains that deletion cannot be
undone, offers a negative outcome as the softer alternative, and waits. That is deliberate — say
"yes, delete it" to proceed:

```
Deleted. Lesson d6d47b2f-… is gone from Mubit memory — mubit_forget returned success.
That deletion can't be undone.
```

Verify against the store, not the reply:

```bash
curl -s -X POST -H "Authorization: Bearer $MUBIT_API_KEY" -H 'content-type: application/json' \
  -d "{\"run_id\":\"$RUN\",\"scope\":\"session\",\"limit\":10}" https://api.mubit.ai/v2/control/lessons \
| python3 -c "import json,sys;print(len(json.load(sys.stdin).get('lessons',[])))"
```

**Expect** `0`.

For a lesson that is merely *wrong* rather than harmful, prefer letting outcome attribution
down-weight it (§7) — deletion has no undo.


## §7 — Attribution: did the memory earn its keep

At the end of every turn the Stop hook posts an outcome against the memories that were injected
for that turn — the loop that makes recall get better instead of just staying the same.

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --run <run id> --last 20
```

Read the `outcome` column:

| Value | Meaning |
|---|---|
| `sent` | Attribution posted; the recalled entries' confidence moved |
| `pending` | The turn closed; the outcome has not been flushed yet (drain or SessionEnd will) |
| `dropped` | Abandoned after repeated failures — the turn is not retried forever |
| `none` | Nothing was injected, so there was nothing to attribute |

What `lib/outcome.mjs` posts, which is **not** a simple good/bad on the echo:

| The turn | Posted | `entry_ids` |
|---|---|---|
| Nothing injected | nothing at all | — |
| Injected, reply echoed the block | `success` +0.2, or `failure` −0.3 if the *turn itself* failed | the recalled ids |
| Injected, reply echoed **none** of it | `neutral` **0.0** | **empty** |
| Injected, signal not computable | `success` +0.2 / `failure` −0.3 as before | the recalled ids |

Two things follow, and both surprise people:

**A memory that goes unused is not penalised.** Row 3 posts `neutral` at exactly 0.0 — not
`failure` — because the used-signal is dominated by false negatives and a penalty would punish
memories the model read silently. `failure` −0.3 is driven by `turn.outcome === 'failure'`, i.e.
the turn went badly, not by the echo being absent.

**Row 3 deliberately withholds the ids.** Attributed reinforcement counts any signal ≥ 0 as one
reinforcement, so naming the entries on a 0.0 record would credit exactly the memories nothing
showed were read. The cost is that the record says "injected and unused" without saying which
entries were ignored. That is the honest side of the trade, and it is why an unused entry's
`reinforcement_count` stays `None` while a used one climbs.

Measured, one turn each against `api.mubit.ai`:

```
3cb9921e  conf=0.665  reinforcements=3     last_outcome=success   ← echoed: credited
ccedecb0  conf=0.500  reinforcements=None  last_outcome=None      ← not echoed: untouched
```

`MUBIT_CC_OUTCOME_MODE=off` silences the whole path, neutral records included.

Confirm the confidence actually moved — `--resolve` prints it:

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --run <run id> --prompt <id> --resolve
```

**Expect** `[fact conf 0.63]` — and a higher number after a `success` outcome on the same entry.
Stored `knowledge_confidence` and a search hit's `score` are different numbers: the first is a
belief that outcomes move over time, the second is per-query relevance, recomputed every search.

---

## §8 — Compaction

In a long session, run `/compact`. To exercise it now without one, drive the hook the way the
host does — build a transcript and feed it in:

```bash
python3 -c "
import json
with open('/tmp/transcript.jsonl','w') as f:
    for i in range(300):
        f.write(json.dumps({'type':'assistant','message':{'role':'assistant',
            'content':[{'type':'text','text':'turn %d: the drain lock is stolen after 60s.'%i}]}})+'\n')"

echo "{\"session_id\":\"g\",\"transcript_path\":\"/tmp/transcript.jsonl\",\"cwd\":\"$SCRATCH\",\"hook_event_name\":\"PreCompact\",\"trigger\":\"manual\"}" \
 | CLAUDE_PROJECT_DIR="$SCRATCH" node "$PLUG/hooks/dist/checkpoint.mjs" --pre
```

**Expect** the one message the plugin puts in front of a user during compaction:

```json
{"systemMessage":"mubit: checkpoint 007b4f01-2379-4e1e-b717-b7bfb0f25351 saved (8.0k tok) before compaction"}
```

```bash
find "$DATA/runs" -name checkpoints.json -exec python3 -m json.tool {} \;
```

**Expect**

```json
[ { "checkpoint_id": "007b4f01-…", "token_estimate": 8035, "at": 1787102504451 } ]
```

**PostCompact must say nothing.** Measured:

```bash
echo "{\"session_id\":\"g\",\"hook_event_name\":\"PostCompact\"}" \
 | node "$PLUG/hooks/dist/checkpoint.mjs" --post
```

```json
{"suppressOutput":true}
```

> That silence is the 0.10.0 fix, not a regression. Earlier builds emitted a `systemMessage`
> here, and the host rejects `PostCompact` as a `hookSpecificOutput.hookEventName` — so every one
> of those re-anchor messages was silently discarded. The re-anchor moved into SessionStart's
> `compact` source. If you see a PostCompact message, you are on an older build.

PreCompact is the one blocking network call in the plugin (5000 ms budget), and the only hook
that shows a failure in the UI:
`mubit: checkpoint failed (<state>) — pre-compaction context not saved`.


## §9 — Failure drills

The actual deliverable of the whole design: capture that works is easy, capture that cannot make
a session worse is the thing people keep installed. **Every hook exits 0, always.**

These drive the hooks directly rather than starting a session each time — same code path, same
bundles, seconds instead of minutes.

> ### The trap that will silently void these drills
>
> **`MIN_PROMPT_CHARS = 8`.** `prompt-recall.mjs:174` returns early on any prompt shorter than
> eight characters — before the config is used, before the network, before any marker or breaker
> is written. A drill driven with `"note 1"` (six characters) touches nothing at all and leaves
> only `config.json` on disk, which reads exactly like a plugin that has stopped working.
> Measured, against a dead endpoint where any network attempt would leave a breaker file:
>
> ```
> len=1   "a"                        -> 1 files (skipped, no network)
> len=6   "note 1"                   -> 1 files (skipped, no network)
> len=7   "note 12"                  -> 1 files (skipped, no network)
> len=8   "note 123"                 -> 5 files (recall ran)
> len=25  "a much longer prompt here" -> 5 files (recall ran)
> ```
>
> Use a realistic sentence in every payload below.

### A wrong key stays visible

It is the one error a user can actually fix, so it must not hide behind a cooldown.

```bash
BAD=/tmp/mubit-badkey && rm -rf $BAD && mkdir -p $BAD
echo "{\"session_id\":\"bad\",\"prompt_id\":\"p_bad\",\"cwd\":\"$SCRATCH\",\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"anything at all here\"}" \
 | MUBIT_CC_DATA_DIR=$BAD CLAUDE_PLUGIN_DATA=$BAD MUBIT_ENDPOINT=https://api.mubit.ai \
   MUBIT_API_KEY=mbt_live_wrongkey_000000000000000000 CLAUDE_PROJECT_DIR="$SCRATCH" \
   node "$PLUG/hooks/dist/prompt-recall.mjs"; echo "  exit=$?"

python3 -c "
import json,glob
for f in glob.glob('$BAD/breaker/*.json'):
    j=json.load(open(f)); print({k:j[k] for k in ('state','failures','openedAt')})
for f in glob.glob('$BAD/status/cc-*.json'):
    print('marker state =', json.load(open(f))['state'])"
```

**Expect**, and it held identically across three consecutive trials:

```
{"suppressOutput":true}
  exit=0
{'state': 'auth_failed', 'failures': [], 'openedAt': 0}
marker state = auth_failed
```

`failures` is **empty** and the breaker never opened. A 401 deliberately does not feed the
failure counter — opening a circuit on a bad key hides the one fault the user could have fixed
behind a 120-second cooldown.

### A dead endpoint loses nothing, and opens the circuit at exactly five

```bash
D=/tmp/mubit-dead && rm -rf $D && mkdir -p $D
for i in 1 2 3 4 5 6 7; do
  echo "{\"session_id\":\"d\",\"prompt_id\":\"p$i\",\"cwd\":\"$SCRATCH\",\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"this is prompt number $i, long enough to trigger recall\"}" \
   | MUBIT_CC_DATA_DIR=$D CLAUDE_PLUGIN_DATA=$D MUBIT_ENDPOINT=http://127.0.0.1:9 \
     MUBIT_API_KEY=mbt_live_wrongkey_000000000000000000 CLAUDE_PROJECT_DIR="$SCRATCH" \
     node "$PLUG/hooks/dist/prompt-recall.mjs" >/dev/null
  rc=$?
  python3 -c "
import json,glob
f=sorted(glob.glob('$D/breaker/*.json')); j=json.load(open(f[0])) if f else {}
print('call $i exit=$rc  breaker=%-12s failures=%s open=%s' % (j.get('state','-'), len(j.get('failures',[])), j.get('openedAt',0)>0))"
done
```

**Expect**

```
call 1 exit=0  breaker=unreachable  failures=1 open=False
call 2 exit=0  breaker=unreachable  failures=2 open=False
call 3 exit=0  breaker=unreachable  failures=3 open=False
call 4 exit=0  breaker=unreachable  failures=4 open=False
call 5 exit=0  breaker=unreachable  failures=5 open=True
call 6 exit=0  breaker=unreachable  failures=5 open=True
call 7 exit=0  breaker=unreachable  failures=5 open=True
```

Four things at once: every hook exited **0**, the failure count climbed, the circuit opened at
**exactly 5**, and it stopped counting after that rather than growing without bound.

### Breaker state is per endpoint

Send one prompt to a healthy instance using the *same* data dir, then look at both files:

```bash
python3 -c "
import json,glob
for f in sorted(glob.glob('$D/breaker/*.json')):
    j=json.load(open(f)); print('%-13s failures=%s open=%-5s %s' % (j['state'], len(j['failures']), j['openedAt']>0, j.get('endpoint') or '(none)'))"
```

**Expect** two files, and the healthy instance's verdict untouched by the dead one's:

```
unreachable   failures=5 open=True  http://127.0.0.1:9
ready         failures=0 open=False https://api.mubit.ai
```

`◍ warming` inside the 20 s cold-start window and `· paused Ns` while the breaker cools down are
**not faults**. Auth failure is never masked by the warming window.


## §10 — The status line

A plugin cannot register `statusLine` — a plugin's `settings.json` supports only `agent` and
`subagentStatusLine`. The entry the plugin ships is inert by design, so you have to wire it in
yourself. After two sessions where the widget never ran, SessionStart says so, once.

Check it without changing any settings — pipe a payload straight in:

```bash
render() { echo "{\"session_id\":\"x\",\"cwd\":\"$SCRATCH\",\"workspace\":{\"current_dir\":\"$SCRATCH\"}}" \
  | MUBIT_CC_DATA_DIR=$1 CLAUDE_PLUGIN_DATA=$1 CLAUDE_PROJECT_DIR="$SCRATCH" node "$PLUG/bin/statusline.mjs"; }

render /tmp/mubit-guide-data    # healthy
render /tmp/mubit-badkey        # §9's auth failure
render /tmp/mubit-dead          # §9's dead endpoint
render /tmp/nothing-here        # never run
```

**Expect** — all four measured:

```
● mubit: cc-mubit-guide-52fe1a38 · hosted · recall 4/320 tok
✖ mubit: cc-mubit-guide-52fe1a38 · hosted · auth failed · recall 0/0 tok
✖ mubit: cc-mubit-guide-52fe1a38 · hosted · unreachable · recall dry 5
                                        ← nothing at all, exit 0
```

`recall dry 5` is the dry-streak escalation: after **3** consecutive empty recalls the token
figure is replaced by the streak, because "recall 0/0 tok" and "recall has been dead for five
prompts" are the same row otherwise.

> **The marker is last-write-wins, so the line describes the last prompt that data dir saw** —
> not the health of the endpoint you are thinking about. A dead-endpoint data dir that later
> served one healthy prompt renders `● ready`, correctly. If you want to see a degraded glyph,
> make the *last* write the failing one.

> Export the **same** run-strategy env the session used. The status line re-derives the run id
> from the working directory, so without it you get the directory's run and its numbers, not the
> one you were testing.


| Field | Meaning |
|---|---|
| `●` | Connection state — worst-wins across marker and breaker |
| `cc-…-9f2a11c4` | Run id: the memory scope this session writes to |
| `hosted` | Derived mode |
| `recall 6/1.2k tok` | 6 memories injected on the last prompt, costing 1.2k tokens |
| `recall dry N` | Replaces the above after **3** consecutive empty recalls. The glyph stays `●` — the connection is fine, the recall is not |
| `saved 12t/1q` | 12 tool calls and 1 turn captured |
| `lessons 3g` | Lessons visible at global scope |
| `rung N` | Shown only when N > 1, i.e. you are paying LLM calls for recall |
| `paused Ns` | Breaker cooldown remaining |

Glyphs, worst to best: `○ not configured` · `✖ auth failed` · `✖ unreachable` · `▲ server error`
· `◌ slow` · `◍ warming` · `●`.

Groups are hidden while still zero. It reads two local JSON files and never touches the network,
so a dead server can never freeze your terminal.

**To actually see it**, add this to your own `~/.claude/settings.json` — and note that if you
already have a `statusLine` (many people do), you must chain the two in one script rather than
replace yours:

```json
"statusLine": { "type": "command", "command": "node",
                "args": ["/Users/eldaru/Mubit/pre-main/integrations/claude-code/bin/statusline.mjs"],
                "padding": 0 }
```

Chaining, if you already have one — the payload arrives on stdin, so it has to be duplicated:

```bash
#!/bin/bash
payload=$(cat)
mine=$(printf '%s' "$payload" | /Users/eldaru/.claude/statusline.sh)
mubit=$(printf '%s' "$payload" | node "$PLUG/bin/statusline.mjs")
printf '%s%s' "$mine" "${mubit:+  $mubit}"
```

---

## §11 — Performance: four numbers, measured separately

They answer different questions and are easy to conflate.

### 1. What it costs you before you type anything

```bash
cd "$PLUG" && npm run context-cost
```

**Expect**

```
  MCP tool schemas             2907 tok     7981 chars  10 tools
  skill frontmatter             347 tok     1165 chars  7 skills
  agent frontmatter              62 tok      214 chars  1 agents
  ——————————————————————————————————————————————————————————
  contextCost.value            3316 tok
```

This is the always-on surface: tool schemas plus skill and agent frontmatter. **Hooks cost zero
context** — they run in the harness, not the model. It is a deliberate over-estimate
(2.82 chars/token here, where a real BPE runs nearer 3.5 on schema JSON), and it does **not**
include the per-prompt injected block.

It fell from 5382 in 0.9.2 because the bundled server now honours the tool allowlist — 10 schemas
instead of 21. If you see a loud `allowlistHonoured: false` block, the MCP bundle is stale.

### 2. What each prompt's injection costs

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --run <run id> --last 40
```

The `totals` row sums it. `tok` is the plugin's four-chars-per-token estimate; `chars` is there
so you can re-derive it with a real tokenizer rather than inherit the estimate.

### 3. End-to-end tokens, time and dollars — the A/B that actually matters

The only honest way to answer "is memory worth its context". Same prompt, same directory, one
arm with the plugin and one without:

```bash
cd "$SCRATCH"
Q="summarise what this repository is for in one sentence"
for arm in mubit control; do
  for i in 1 2 3; do
    if [ "$arm" = mubit ]; then
      claude --plugin-dir "$PLUG" --output-format json -p "$Q" > /tmp/ab-$arm-$i.json 2>/dev/null
    else
      claude --output-format json -p "$Q" > /tmp/ab-$arm-$i.json 2>/dev/null
    fi
  done
done

python3 - <<'PY'
import json, glob, statistics as st
for arm in ("control", "mubit"):
    rows = [json.load(open(f)) for f in sorted(glob.glob(f"/tmp/ab-{arm}-*.json"))]
    def med(fn): return st.median(fn(r) for r in rows)
    print(f"{arm:8} n={len(rows)}  "
          f"in={med(lambda r: r['usage']['input_tokens']):>6.0f}  "
          f"cache_create={med(lambda r: r['usage']['cache_creation_input_tokens']):>7.0f}  "
          f"cache_read={med(lambda r: r['usage']['cache_read_input_tokens']):>7.0f}  "
          f"out={med(lambda r: r['usage']['output_tokens']):>5.0f}  "
          f"ttft={med(lambda r: r.get('ttft_ms') or 0):>6.0f}ms  "
          f"wall={med(lambda r: r['duration_ms']):>7.0f}ms  "
          f"${med(lambda r: r['total_cost_usd']):.4f}")
PY
```

**Expect** a two-row table. The plugin's cost shows up in `cache_creation_input_tokens` (the
always-on 3316 plus whatever was injected) and in `wall` (the blocking recall hook, ~370 ms on
rung 1). Its *benefit* — if there is one for your prompt — shows up as fewer `out` tokens and
fewer turns, because the model did not have to go find what it already knew.

The `--output-format json` envelope carries everything you need: `duration_ms`, `duration_api_ms`,
`ttft_ms`, `num_turns`, `total_cost_usd`, and the full `usage` block including both cache
counters.

> Three reps is the minimum worth reading and still not much. Prompt caching makes the first run
> of any arm unrepresentative, and one task cannot tell you about memory in general — memory pays
> off across sessions, and a single-prompt A/B measures only its overhead. For a real answer use
> the Terminal-Bench A/B rig, which scopes one memory run per task and needs at least two epochs
> before the difference-in-differences means anything.

### 4. Hook latency

```bash
python3 -c "
import json,glob
for f in glob.glob('$DATA/logs/mubit-cc.log*'):
    for line in open(f):
        try: j=json.loads(line)
        except: continue
        if 'ms' in j or 'exceeded' in j.get('msg',''):
            print('%-5s %-46s %s' % (j['level'], j['msg'][:46], {k:v for k,v in j.items() if k in ('ms','budget_ms','elapsed_ms')}))"
```

**Expect** the drain's wall time per batch, and a `warn` line for any hook that blew its budget:

```
info  drain: 3 item(s) in 1 batch(es)                 {'ms': 167}
info  drain: 1 item(s) in 1 batch(es)                 {'ms': 517}
info  drain: 4 item(s) in 1 batch(es)                 {'ms': 4251}
info  drain: outcome post failed (not_responding)     {}
```

A drain taking 4.2 s is not a stall — it runs detached, off the hot path, which is the whole
reason capture can be free at the point of the tool call.

The ring log is NDJSON, one object per line, redacted on write, 1 MiB × 2. Budget overruns log
at `warn` with `{budget_ms, elapsed_ms}`. Hook budgets: SessionStart 5 s, UserPromptSubmit 3 s,
PostToolUse 3 s, Stop 5 s, PreCompact 10 s, SessionEnd 8 s.

**Per-prompt recall latency is not recoverable from disk.** `recall.ms` is written only to the
marker, which is last-write-wins per run, so it always describes the most recent prompt. The
per-prompt series exists only in the `mubit: N memories · X tok · Yms` system message — capture
it with `--debug-file` if you need it:

```bash
grep -ao 'mubit: [0-9][^"\\]*' /tmp/cc-recall.log
```

---

## §12 — Known, and not bugs

| What you will see | Why |
|---|---|
| `SessionEnd hook […] failed: Hook cancelled` on every `-p` run | The host cancels SessionEnd ~1 s in under `--print`. No reflect, no end-of-session drain. Test lessons interactively |
| `empty_reason: policy_denied` with a healthy `● ready` line | A cached 24 h denial (§3). The status line cannot show it; `dry_streak` is what makes it visible |
| PostCompact says nothing | Fixed in 0.10.0 — the host rejected the old shape and discarded every message |
| The shipped `statusLine` does nothing | Plugins cannot register one (§10) |
| Nothing captured while working in a Mubit repo | Self-reference suppression, working as designed |
| `npm run version:check` fails | It calls `scripts/set-version.mjs`, which the mirror excludes by design. Same for `test/release.test.mjs` |
| `npm test` fails only on `engine-floor` | That gate needs the `esbuild` devDependency; the rest of the suite has zero dependencies |
| `/mcp` shows 21 tools | A pre-0.9.2 MCP bundle. This build ships 10 |
| A hand-driven hook leaves only `config.json` | The prompt was under 8 characters. `MIN_PROMPT_CHARS = 8` returns before any network, marker or breaker write (§9) |
| `captured.tools` / `turns` sit at 0 while `ingested` climbs | They are live gauges cleared by each drain, not lifetime counters (§5) |
| `forget` asks before deleting | Deliberate — deletion has no undo. Confirm explicitly (§6) |
| A remembered lesson lands at `run` scope | The SDK hardcodes `session`; the egress guard clamps it to `run` and says so in the tool result. Reflection widens it, or raise `mcpLessonScope` (§6) |
| Recall injects something irrelevant on a sparse run | There is no relevance floor — the top semantic hit is returned whatever its score. The used-signal will score it 0 and post `neutral` (§7) |
| `docs/user-guide.md` says `mcpTools` has no effect | Stale as of 0.10.0 — the allowlist **is** honoured now, which is exactly why `contextCost` fell 5382 → 3316 |

Troubleshooting the rest:

| Symptom | Cause | Fix |
|---|---|---|
| Everything reads `unconfigured` | No endpoint or key resolved | §0 — and check `MUBIT_ENDPOINT` is not left over from another instance |
| Every `/v2/control/*` returns 401 | Auth is mandatory, including on localhost | There is no loopback exemption |
| Health response will not parse as JSON | It is the bare string `OK` | Read it as text; `JSON.parse` is a guaranteed false negative |
| Spool never empties | Breaker open, or a stale `drain.lock` | The lock is stolen unconditionally after 60 s |
| Job stays `queued` forever | The embedding service behind the instance is down | The most common backend failure by a wide margin |
| `/reload-plugins` changed nothing | It registers hooks but does **not** fire SessionStart | Quit and start a new session |

---

## §13 — Clean up

```bash
rm -rf /tmp/mubit-ux /tmp/mubit-ux-data /tmp/mubit-ux-badkey /tmp/mubit-ux-dead
rm -f /tmp/cc-*.log /tmp/ab-*.json
```

Memories written to Mubit under the runs you used stay there, which is usually what you want.
To remove one: `/mubit-memory:forget` with its `session_id` deletes an entire run.

Your installed plugin was never touched — `--plugin-dir` loads in place and installs nothing.

---

## Where the state lives

| Path | Holds |
|---|---|
| `status/<run>.json` | The marker: recall stats, capture counts, lessons, reflect. **Last-write-wins per run** |
| `runs/<run>/turns/<prompt>.json` | The per-prompt record: prompt, `recalled[]` ids, `recall{}` cost, `used_evidence`, outcome |
| `runs/<run>/spool/*.json` | One pending capture per file, lock-free append |
| `runs/<run>/jobs.json` | Last 20 ingest job ids |
| `runs/<run>/checkpoints.json` | Pre-compaction checkpoints |
| `sessions/<host_session>.json` | Host session → run id map |
| `breaker/<hash>.json` | Circuit state, **one file per endpoint** |
| `policy/<hash>.json` | Cached `direct_bypass` **denial**, 24 h. Denials only — grants are never cached |
| `logs/mubit-cc.log` | NDJSON ring log, 1 MiB × 2, redacted on write |
| `credentials.json` | Endpoint + API key, mode 0600 |
