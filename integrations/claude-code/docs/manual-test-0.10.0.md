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
echo "endpoint=${MUBIT_ENDPOINT:-(unset)}  key=${MUBIT_API_KEY:+set}${MUBIT_API_KEY:-(unset)}"
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
for f in ~/.claude/plugins/data/mubit-memory*/policy/*.json; do
  echo "--- $f"; python3 -c "
import json,time
j=json.load(open('$f')); ob=j.get('observed_at',0)
print(j)
print('cached %.1f h ago, expires in %.1f h' % ((time.time()*1000-ob)/3.6e6, (ob+j.get('ttl_ms',0)-time.time()*1000)/3.6e6))
"; done
```

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

**Force a re-probe** — one prompt with a 1 ms TTL re-asks the instance and rewrites or clears
the cache:

```bash
MUBIT_CC_POLICY_TTL_MS=1 claude --plugin-dir "$PLUG" -p "ping"
ls -A "$DATA/policy" 2>/dev/null | wc -l     # 0 = rung 1 granted
```

Or just delete the file — it is a cache, and losing it costs one extra probe:

```bash
rm -f ~/.claude/plugins/data/mubit-memory*/policy/*.json
```

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

Capture runs on every tool call with **zero network I/O** — it classifies, redacts, and writes
one spool file. Work normally in `$SCRATCH` for a few turns, then:

```bash
find "$DATA/runs" -path '*/spool/*.json' | wc -l          # pending items
python3 -m json.tool "$(find "$DATA/runs" -path '*/spool/*.json' | head -1)" | head -12
```

**Expect** an item whose `intent` is set and never `unclassified` — an unclassified item makes
the server run an LLM classification call *per item* — and whose `text` has something after the
arrow. If it ends at `-> ` the capture recorded that a file was touched and not what was in it.

**Prove redaction drops rather than scrubs.** A capture whose subject is a denied path is
discarded whole:

```bash
cd "$SCRATCH"
printf 'MUBIT_API_KEY=mbt_live_dontleakme\n' > .env
before=$(find "$DATA/runs" -path '*/spool/*.json' | wc -l)
claude --plugin-dir "$PLUG" -p "read the .env file in this directory and tell me what is in it"
echo "spool grew by $(( $(find "$DATA/runs" -path '*/spool/*.json' | wc -l) - before ))   (expect 0)"
grep -rl "dontleakme" "$DATA" || echo "the secret is nowhere on disk ✓"
rm -f .env
```

**Expect** `spool grew by 0` and `the secret is nowhere on disk ✓`.

Then push the spool to Mubit and watch the job become durable:

```bash
node "$PLUG/scripts/mubit-inspect.mjs" | grep -E 'capture|totals'
```

**Expect** `jobs N (last: queued, M items)`.

> `queued` means **queued, not stored**. A 200 is an acknowledgement; the job is where it becomes
> durable. If a job never leaves `queued`, the embedding service behind your instance is down —
> by a wide margin the most common cause.

---

## §6 — Lessons: generated → recalled → used

> **Do this in an interactive session.** In headless `-p` mode the host cancels SessionEnd about
> a second in, so reflect never runs. You will see this exactly once per headless call:
> `SessionEnd hook […] failed: Hook cancelled`. It is a known harness limitation, not a plugin
> fault, and it means **lesson generation cannot be tested with `-p`.**

Start a session — `claude --plugin-dir "$PLUG"` — and walk the lifecycle:

| Step | Type | What to check |
|---|---|---|
| 1. Generate | `/mubit-memory:remember we always deploy from the release branch, never from main` | reports a lesson id |
| 2. Generate (bulk) | `/mubit-memory:reflect` | reports each lesson with id, type, scope. An empty result is a real answer, not an error |
| 3. Recall | `/mubit-memory:recall what did we decide about deploys` | the lesson comes back |
| 4. Recall (deep) | `@mubit-memory:mubit-recall what do we know about our deploy process` | a synthesis, not raw evidence. Bounded: Haiku, low effort, 3 turns, ≤3 queries |
| 5. Delete | `/mubit-memory:forget <lesson id>` | no dry run, no undo |

Between steps, from another terminal with the same `$DATA` exported:

```bash
node "$PLUG/scripts/mubit-inspect.mjs" | tail -6
```

**Expect** the `lessons` line to move:

```
lessons     global 3 · injected_ids 2 (credited) · reflect: 1 stored, status=ok
```

`reflect.status` is one of `ok`, `failed`, `skipped:disabled`, `skipped:not-ingested`,
`skipped:undrained`. A **blank** status on a written marker means the hook was killed mid-flight.

> Reflection at session end is the only path that promotes a lesson beyond the run that produced
> it. `reflectOnEnd` defaults to true; turning it off to save a few seconds at exit trades away
> cross-session memory entirely.

> Known limit: `/mubit-memory:remember` writes through `mubit_learned`, which hardcodes
> `lesson_scope: "session"`. A remembered lesson therefore never lands at `global` scope, no
> matter what you type. Check with `mubit_lessons` at each scope if it matters to you.

---

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

The four outcomes `lib/outcome.mjs` derives from the used-signal: `success +0.2` when the reply
echoed the block, `failure −0.3` when it measurably did not, `neutral 0.0` with an **empty**
`entry_ids[]` when the signal was unmeasurable, and nothing posted at all when nothing was
injected. `MUBIT_CC_OUTCOME_MODE=off` silences the whole path.

Confirm the confidence actually moved — `--resolve` prints it:

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --run <run id> --prompt <id> --resolve
```

**Expect** `[fact conf 0.63]` — and a higher number after a `success` outcome on the same entry.
Stored `knowledge_confidence` and a search hit's `score` are different numbers: the first is a
belief that outcomes move over time, the second is per-query relevance, recomputed every search.

---

## §8 — Compaction

In a long session, run `/compact`.

**Expect**, before the host throws the transcript away:

```
mubit: checkpoint <id> saved (3.4k tok) before compaction
```

```bash
python3 -m json.tool "$DATA/runs/<run id>/checkpoints.json"
```

**Expect** an array of `{checkpoint_id, token_estimate, at}`.

> **PostCompact is silent in 0.10.0, and that is the fix.** Earlier builds emitted a
> `systemMessage` there; the host rejects `PostCompact` as a `hookSpecificOutput.hookEventName`,
> so every one of those re-anchor messages was silently discarded. The hook now returns
> `{"suppressOutput": true}` on every path and the re-anchor moved into SessionStart's `compact`
> source. If you see a PostCompact message, you are on an older build.

PreCompact is the one blocking network call in the plugin (5000 ms budget). It is also the only
hook that will show you a failure in the UI:
`mubit: checkpoint failed (<state>) — pre-compaction context not saved`.

---

## §9 — Failure drills

The actual deliverable of the whole design: capture that works is easy, capture that cannot make
a session worse is the thing people keep installed. **Every hook exits 0, always.**

**A wrong key stays visible.** It is the one error a user can fix, so it must not hide behind a
cooldown:

```bash
BAD=/tmp/mubit-ux-badkey && rm -rf $BAD && mkdir -p $BAD
MUBIT_CC_DATA_DIR=$BAD MUBIT_API_KEY=mbt_live_wrongkey_00000000000000000000 \
  claude --plugin-dir "$PLUG" -p "anything at all"; echo "exit=$?"
python3 -m json.tool $BAD/breaker/*.json | head -6
```

**Expect** `exit=0`, state `auth_failed`, and `failures` still **empty** — a 401 deliberately
does not feed the failure counter.

**A dead endpoint loses nothing.** Pointing at a closed port exercises the identical
`ECONNREFUSED` path as killing the process, and costs nothing to undo:

```bash
DEAD=/tmp/mubit-ux-dead && rm -rf $DEAD && mkdir -p $DEAD
for i in 1 2 3 4 5 6; do
  MUBIT_CC_DATA_DIR=$DEAD MUBIT_ENDPOINT=http://127.0.0.1:9 \
    claude --plugin-dir "$PLUG" -p "note $i" >/dev/null 2>&1; echo "run $i exit=$?"
done
find $DEAD/runs -path '*/spool/*.json' | wc -l    # must have GROWN
node "$PLUG/scripts/mubit-inspect.mjs" --data $DEAD | tail -3
```

**Expect** every exit `0`, the spool grown, and the breaker open after **exactly 5** failures.
`breaker` state is **per endpoint** — one file per hashed endpoint — so a healthy instance's
verdict is never touched by a dead one's.

`○ warming` inside the 20 s cold-start window and `· paused Ns` while the breaker cools down are
**not faults**. Auth failure is never masked by the warming window.

---

## §10 — The status line

A plugin cannot register `statusLine` — a plugin's `settings.json` supports only `agent` and
`subagentStatusLine`. The entry the plugin ships is inert by design, so you have to wire it in
yourself. After two sessions where the widget never ran, SessionStart says so, once.

Check it without changing any settings — pipe a payload straight in:

```bash
echo '{"session_id":"x","cwd":"'"$SCRATCH"'","workspace":{"current_dir":"'"$SCRATCH"'"}}' \
 | MUBIT_CC_RUN_STRATEGY=static MUBIT_CC_RUN_ID=<run id> node "$PLUG/bin/statusline.mjs"
```

**Expect**

```
● mubit: cc-mubit-plugin-testing-41703b8c · hosted · recall 1/77 tok
```

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
grep -a 'exceeded its' "$DATA/logs/mubit-cc.log" | tail -5
grep -a '"msg":"drain' "$DATA/logs/mubit-cc.log" | tail -3
```

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
