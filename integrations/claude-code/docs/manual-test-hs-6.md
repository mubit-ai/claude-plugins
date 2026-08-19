# Manual test — HS-6, async recall behind a flag

`recallAsync` stops recall blocking the prompt. With the flag on, `UserPromptSubmit` injects
the block a **detached refresh** retrieved just after the *previous* prompt, then spawns the
refresh that will produce the next one, and returns. It never dials, so it never waits.

This runbook proves three things and disproves one:

1. **The wall clock stops tracking the endpoint.** Against a Mubit that takes 2 300 ms, the
   blocking hook costs 1.55 s and injects nothing; the async hook costs 0.07 s and injects
   the block that call produced.
2. **Attribution lands on the turn that received the block**, not the one that requested it.
3. **The seen-set still works across the boundary** — a repeat is still degraded to a pointer.
4. **Nothing changes for anyone who does not opt in.** Default false, and §1 is the
   side-by-side.

> **What this is not.** It is not `"async": true` in `hooks.json`. That field is real — the
> 2.1.235 host binary describes it as *"If true, hook runs in background without blocking"*,
> alongside `asyncRewake` and `ASYNC_REWAKE_FLUSH_TIMEOUT_MS` — but it is a **static manifest
> field**. Nothing in a manifest can be conditioned on a config key the user sets after
> install, so a flag-gated `recallAsync` expressed that way needs two registrations no-oping
> against each other: two processes in front of every prompt, forever, for everyone. The flag
> exists so that people who leave it off pay nothing. Carry-forward gets the same trade with
> no manifest change at all.

Everything below was executed on **2026-08-19** against this branch's built
`hooks/dist/` — the bundles a marketplace install actually runs, not `hooks/src`. The
**Expect** blocks are captured output, not predictions — from one continuous run, so the
timestamps line up. Wall-clock figures and `fetch_ms` will differ by tens of milliseconds on
your machine; every claim below is about the *gap* between two of them, never the absolute.

**Time:** ~12 minutes for §0–§7, ~5 more for the live section.
**Destroys:** nothing. Every byte lives in four temp directories you delete in §9. Your
installed plugin and its memory are never touched.

---

## §0 — Setup, one paste

Two traps, both silent, both from `manual-test-0.10.0.md` §0 and both still live.

**Trap 1 — your shell may already point at a different Mubit.** Config precedence is
`CLAUDE_PLUGIN_OPTION_*` → `MUBIT_*` env → `credentials.json` → `.mubit-cc.json` → default, so
a `MUBIT_ENDPOINT` left exported from an earlier session beats whatever you signed in with.

**Trap 2 — the data directory is not where the docs say.** Pin it. `MUBIT_CC_DATA_DIR` has the
highest precedence of any data-dir input (`lib/state.mjs`), so everything lands in a directory
you own and can delete.

Check what is already set:

```bash
env | grep -iE '^(MUBIT|CLAUDE_PLUGIN)' | sed 's/\(MUBIT_API_KEY=.\{0,10\}\).*/\1…/' | sort
```

**Expect nothing at all.** Anything printed is already steering the plugin.

Now paste this whole block into the terminal you will use for the rest of the run:

```bash
export PLUG=/Users/eldaru/Mubit/hs-6-async-recall/integrations/claude-code
export SCRATCH=/tmp/mubit-hs6
export DATA=/tmp/mubit-hs6-data     # the async arm
export SYNC=/tmp/mubit-hs6-sync     # the blocking arm, kept separate so the counters are clean
export LIVE=/tmp/mubit-hs6-live     # §8 only

rm -rf "$SCRATCH" "$DATA" "$SYNC" "$LIVE"
mkdir -p "$SCRATCH" "$DATA" "$SYNC" "$LIVE"

# a throwaway project — never run this from a Mubit repo, see the note below
cd "$SCRATCH" && git init -q && echo "# scratch" > README.md
git add -A && git -c user.email=you@example.com -c user.name=you commit -qm init

export MUBIT_CC_DATA_DIR="$DATA"
export MUBIT_ENDPOINT=http://127.0.0.1:3199
export MUBIT_API_KEY=mbt_offline_fake_key_for_the_local_stand_in
export MUBIT_CC_RUN_STRATEGY=static
export MUBIT_CC_RUN_ID=cc-hs6
export MUBIT_CC_LOG_LEVEL=debug
export CLAUDE_PROJECT_DIR="$SCRATCH"

echo "plugin   $PLUG"
echo "data     $DATA (async) / $SYNC (blocking)"
echo "endpoint $MUBIT_ENDPOINT"
```

**Expect**

```
plugin   /Users/eldaru/Mubit/hs-6-async-recall/integrations/claude-code
data     /tmp/mubit-hs6-data (async) / /tmp/mubit-hs6-sync (blocking)
endpoint http://127.0.0.1:3199
```

> **Work in `$SCRATCH`, never in a Mubit repo.** Self-reference suppression deliberately drops
> any capture whose text mentions `mubit`. In a Mubit checkout the capture path looks broken
> and is working exactly as designed.

> The API key here is a fake. §1–§7 never leave the machine: the endpoint is a stand-in server
> you start in the next step. The real key is read out of the credential file in §8 only, with
> `node -e`, so it never enters your shell history.

### The stand-in endpoint

The whole point of the offline core is that the latency is a number **you set**, not one you
hope for. This is a Mubit-shaped server whose only job is to answer `/v2/control/query` after
`DELAY_MS`:

```bash
cat > "$SCRATCH/slow-mubit.mjs" <<'EOF'
import { createServer } from 'node:http';
const DELAY_MS = Number(process.env.DELAY_MS ?? 0);
const BODY = {
  final_answer: '', confidence: 0.6, mode: 'direct_bypass', degraded: false,
  consulted_runs: [], routing_summary: 'direct_bypass', signals: {}, citations: [],
  evidence: [{
    id: 'e1', content: 'Ingest returns when queued, not when stored; poll the job for completion.',
    source: 'agent', score: 0.91, run_id: 'cc-hs6', entry_type: 'rule',
    metadata_json: '{}', retrieval_mode: 'semantic_search', reference_id: 'ref_rule_1',
    referenceable: true, origin_entry_type: '', is_stale: false, superseded_by: '',
    explain_info: '', knowledge_confidence: 0.9,
  }],
};
let calls = 0;
createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url === '/v2/core/health') { res.writeHead(200); return res.end('OK'); }
    calls += 1;
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} (call ${calls})`);
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(BODY));
    }, DELAY_MS);
  });
}).listen(3199, '127.0.0.1', () => console.log(`slow-mubit on :3199, delay ${DELAY_MS}ms`));
EOF

cd "$SCRATCH" && DELAY_MS=2300 nohup node slow-mubit.mjs > server.log 2>&1 &
sleep 2 && cat "$SCRATCH/server.log"
```

**Expect**

```
slow-mubit on :3199, delay 2300ms
```

**2 300 ms is not arbitrary.** It is the slow end of the 1.4–2.3 s range the runbook records
for a self-hosted Mubit answering a rung-1 query — against a `MUBIT_CC_RECALL_BUDGET_MS`
default of 1500. That mismatch is the problem this ticket exists to retire.

### One payload file per prompt

Every step below is a plain stdin redirect, so each prompt gets its own recorded
`UserPromptSubmit` payload:

```bash
cat > "$SCRATCH/mkp.mjs" <<'EOF'
import { writeFileSync } from 'node:fs';
const [id, text] = process.argv.slice(2);
writeFileSync(`${process.env.SCRATCH}/${id}.json`, JSON.stringify({
  session_id: 's-hs6', transcript_path: '/dev/null', cwd: process.env.SCRATCH,
  permission_mode: 'default', hook_event_name: 'UserPromptSubmit',
  prompt_id: id, prompt: text,
}));
EOF

node "$SCRATCH/mkp.mjs" p_a "why is the ingest job stuck in queued?"
node "$SCRATCH/mkp.mjs" p_b "and what does the drain do on a 5xx?"
node "$SCRATCH/mkp.mjs" p_c "so what should the retry interval be?"
node "$SCRATCH/mkp.mjs" p_d "does the breaker cover the outcome post too?"
node "$SCRATCH/mkp.mjs" p_e "and after the endpoint has gone away?"
ls "$SCRATCH"/p_*.json
```

**Expect**

```
/tmp/mubit-hs6/p_a.json
/tmp/mubit-hs6/p_b.json
/tmp/mubit-hs6/p_c.json
/tmp/mubit-hs6/p_d.json
/tmp/mubit-hs6/p_e.json
```

---

## §1 — The default, unchanged: recall blocks, and loses

Nothing is set here. This is what every install does today, and what every install keeps doing
after this change lands.

```bash
MUBIT_CC_DATA_DIR="$SYNC" /usr/bin/time -p \
  node "$PLUG/hooks/dist/prompt-recall.mjs" < "$SCRATCH/p_a.json"
```

**Expect**

```
{"suppressOutput":true}
real 1.55
user 0.07
sys 0.01
```

**Read `real` first.** 1.55 s of it is the user waiting, and `{"suppressOutput":true}` means
they waited for nothing: the 2 300 ms endpoint did not answer inside the 1 500 ms budget, so
the call was abandoned after it had already been paid for.

The marker records the damage:

```bash
python3 -c "
import json;d=json.load(open('$SYNC/status/cc-hs6.json'))
print(json.dumps({'state':d['state'],'last_error':d['last_error'],'recall':d['recall']},indent=2))"
```

**Expect**

```json
{
  "state": "not_responding",
  "last_error": "POST /v2/control/query: aborted after 1481ms",
  "recall": {
    "sources": 0,
    "tokens": 0,
    "ms": 1503,
    "empty_reason": "",
    "rung": 1,
    "dropped": 0,
    "dry_streak": 1,
    "last_hit_at": 0
  }
}
```

**`empty_reason` is blank and `state` is `not_responding`.** That pair is the documented
symptom, and the documented fix has been "raise `MUBIT_CC_RECALL_BUDGET_MS` by hand" — which
trades a truncated recall for a longer wait before every message you send, because the budget
exists precisely because this hook blocks.

---

## §2 — The flag on: the wall clock stops tracking the endpoint

Same server, same prompt, same bundle. One environment variable.

```bash
export MUBIT_CC_RECALL_ASYNC=1
/usr/bin/time -p node "$PLUG/hooks/dist/prompt-recall.mjs" < "$SCRATCH/p_a.json"
```

**Expect**

```
{"suppressOutput":true}
real 0.07
user 0.05
sys 0.01
```

**0.07 s against 1.55 s, on an endpoint that got 300 ms slower for neither of them.** The
hook did not dial. It looked for a block left by a previous turn, found none — this is the
first prompt of the session — and spawned the refresh.

```bash
python3 -c "
import json;d=json.load(open('$DATA/status/cc-hs6.json'))
print(json.dumps({'state':d['state'],'recall':d['recall']},indent=2))"
```

**Expect**

```json
{
  "state": "unknown",
  "recall": {
    "sources": 0,
    "tokens": 0,
    "ms": 2,
    "empty_reason": "async_no_carry",
    "rung": 0,
    "dropped": 0,
    "dry_streak": 1,
    "last_hit_at": 0
  }
}
```

**Read `empty_reason` first.** `async_no_carry` says literally what happened: no previous turn
left a block for this one. It deliberately does not guess *why* — an ordinary first prompt and
a refresh that has been failing for ten prompts both land here. `state` and `dry_streak` are
what separate them: `ready`/`unknown` with a streak of 1 is priming; `not_responding` with a
climbing streak is the endpoint. §6 shows the second case.

`recall.ms` is **2**. Under this flag that field means *what the prompt paid*, which is a file
read. What the endpoint cost is recorded separately, in the carried block itself:

```bash
sleep 3 && python3 -m json.tool "$DATA/runs/cc-hs6/carry.json"
```

**Expect**

```json
{
    "run_id": "cc-hs6",
    "written_at": 1787155319191,
    "for_prompt_id": "p_a",
    "fetch_ms": 2343,
    "rung": 1,
    "block": "## Active rules\n- Ingest returns when queued, not when stored; poll the job for completion.\n",
    "tokens": 23,
    "sources": 1,
    "dropped": 0,
    "pointers": 0,
    "empty_reason": "",
    "ref_ids": [
        "ref_rule_1"
    ]
}
```

**`fetch_ms: 2343` against `recall.ms: 2` is the whole ticket in two numbers.** The round trip
still costs 2.3 s. Nobody waits for it. And note it *completed*: the refresh is not paced by
`recallBudgetMs`, because no prompt is waiting on it.

---

## §3 — The block arrives, and says it is one turn old

```bash
/usr/bin/time -p node "$PLUG/hooks/dist/prompt-recall.mjs" < "$SCRATCH/p_b.json" \
  > "$SCRATCH/out2.json"
python3 -m json.tool "$SCRATCH/out2.json"
```

**Expect**

```
real 0.06
user 0.05
sys 0.00
```

```json
{
    "hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": "<mubit-memory run=\"cc-hs6\" sources=\"1\" tokens=\"23\">\nRecalled from memory of earlier work — it may be incomplete or out of date, so verify against the code before relying on it.\nIt was retrieved against the previous message in this conversation, not this one, so treat it as background rather than as an answer to what was just asked.\n\n## Active rules\n- Ingest returns when queued, not when stored; poll the job for completion.\n</mubit-memory>"
    },
    "systemMessage": "mubit: 1 memory · 23 tok · 4ms",
    "suppressOutput": true
}
```

**Read the second sentence of the wrapper.** It appears only under this flag, and it is the
price of the mode stated in about fifteen tokens: the block was retrieved against the previous
message. Without it the model reads a block about the last question as an answer to this one,
and concludes recall is unreliable rather than that it is one turn behind.

`systemMessage` says **4ms**. The user sees a number that is now always small.

---

## §4 — Attribution lands on the turn that received the block

This is the assertion the handoff called the real work in this item — it worried that "the
turn that *receives* the block is not the turn that *requested* it", so `recalled` would have
to be written against the receiving `prompt_id`. Under carry-forward the write happens on the
**synchronous read**, with the receiving turn's id already in hand, so it is correct by
construction and there is nothing to remember.

```bash
ls "$DATA/runs/cc-hs6/turns"
python3 -c "
import json,glob
for f in sorted(glob.glob('$DATA/runs/cc-hs6/turns/*.json')):
  d=json.load(open(f)); print(' ', f.split('/')[-1], '-> recalled =', d.get('recalled'))"
```

**Expect**

```
p_b.json
  p_b.json -> recalled = ['ref_rule_1']
```

**There is no `p_a.json` at all.** Prompt `p_a` paid for the round trip and was given nothing,
so it staged nothing. Prompt `p_b` received the block and carries the id. `Stop` attributes
against these files, so this is what stops a memory being reinforced against a turn that never
saw it.

The seen-set is written by the same process, for the same reason:

```bash
python3 -m json.tool "$DATA/runs/cc-hs6/seen.json"
```

**Expect**

```json
{
    "run_id": "cc-hs6",
    "updated_at": 1787155327944,
    "refs": {
        "ref_rule_1": {
            "first": 1787155327944,
            "last": 1787155327944,
            "count": 1
        }
    }
}
```

> **Why the reader marks and not the refresh.** `markSeen` means "the model has been shown
> this". The refresh has shown nothing to anyone: a block it produced may never be rendered —
> the session ends, the flag is flipped off, a compaction clears it (§7). Marking there would
> record memories as seen that the model never received, and the next full-price block would
> degrade them to pointers naming text that exists nowhere in the transcript. Marking nowhere
> is the opposite failure: every carried block would be assembled against an empty seen-set
> and the whole saving would revert silently. §5 is the check that it did not.

---

## §5 — The seen-set still degrades the repeat across the boundary

The reader marks **before** it spawns the refresh, so the child reads a set that already
contains this turn's ids.

```bash
sleep 3
python3 -c "
import json;d=json.load(open('$DATA/runs/cc-hs6/carry.json'))
print('pointers =',d['pointers'],'· tokens =',d['tokens'],'· fetch_ms =',d['fetch_ms'])
print(d['block'])"
```

**Expect**

```
pointers = 1 · tokens = 23 · fetch_ms = 2364
## Active rules
- (seen earlier) ref_rule_1 — Ingest returns when queued, not when stored…
```

Now render it:

```bash
node "$PLUG/hooks/dist/prompt-recall.mjs" < "$SCRATCH/p_c.json" \
 | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['hookSpecificOutput']['additionalContext']);print();print(d['systemMessage'])"
```

**Expect**

```
<mubit-memory run="cc-hs6" sources="1" tokens="23">
Recalled from memory of earlier work — it may be incomplete or out of date, so verify against the code before relying on it.
It was retrieved against the previous message in this conversation, not this one, so treat it as background rather than as an answer to what was just asked.
A line marked "(seen earlier)" was injected in full earlier in this conversation and is repeated here only as a reference; ask mubit_dereference for its text.

## Active rules
- (seen earlier) ref_rule_1 — Ingest returns when queued, not when stored…
</mubit-memory>

mubit: 1 memory · 23 tok · 4ms
```

**`pointers = 1` is the field to read.** HS-3's saving survives the mode. Had the reader marked
*after* spawning instead of before, this block would have arrived in full, at full price, on
every prompt of the session — and nothing anywhere would have said so.

---

## §6 — What stops a stale block: consume-once, and the failure drill

A block is injectable exactly once. Kill the endpoint and watch the mode degrade in the safe
direction rather than serving yesterday's answer forever.

```bash
sleep 3
python3 -c "import json;print('carried for', json.load(open('$DATA/runs/cc-hs6/carry.json'))['for_prompt_id'])"
lsof -ti :3199 | xargs -r kill && sleep 1

/usr/bin/time -p node "$PLUG/hooks/dist/prompt-recall.mjs" < "$SCRATCH/p_d.json" \
 | python3 -c "import json,sys;print(json.load(sys.stdin)['systemMessage'])"
```

**Expect** — the block already on disk is still rendered. It cost a round trip nobody should
pay twice, and it is not stale in any sense the mode has not already accepted:

```
carried for p_c
real 0.06
user 0.04
sys 0.00
mubit: 1 memory · 23 tok · 3ms
```

Its refresh, however, has nothing to talk to:

```bash
sleep 6
ls "$DATA/runs/cc-hs6/carry.json" 2>&1 || echo "carry.json: absent"
python3 -c "
import json;d=json.load(open('$DATA/status/cc-hs6.json'))
print('state =',d['state'],'· last_error =',repr(d['last_error']))"
```

**Expect**

```
ls: /tmp/mubit-hs6-data/runs/cc-hs6/carry.json: No such file or directory
carry.json: absent
state = unreachable · last_error = 'POST /v2/control/query: TypeError: fetch failed: (ECONNREFUSED)'
```

**Two things to read here.** `carry.json` is gone because `takeCarry` unlinks what it reads —
without that, a refresh that stops answering would leave the last good block to be re-injected
on every prompt for the rest of the session, at full price, describing a question the user
finished with an hour ago. And `state` is `unreachable`: the refresh is the only process that
dials once the flag is on, so it is the one that writes the connection state. Without that
write the status line could never show a failure again.

The next prompt gets nothing, and says so:

```bash
node "$PLUG/hooks/dist/prompt-recall.mjs" < "$SCRATCH/p_e.json"
python3 -c "
import json;r=json.load(open('$DATA/status/cc-hs6.json'))
print('state =',r['state'],'· empty_reason =',r['recall']['empty_reason'],'· dry_streak =',r['recall']['dry_streak'])"
```

**Expect**

```
{"suppressOutput":true}
state = unreachable · empty_reason = async_no_carry · dry_streak = 1
```

`async_no_carry` again — the same reason as §2's healthy first prompt. `state = unreachable` is
what tells you this one is a fault. That is the split described in §2.

The whole run reads out per prompt:

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run cc-hs6 --last 40
```

**Expect**

```
run cc-hs6   hosted   ✖ unreachable   (data: /tmp/mubit-hs6-data)
last_error  POST /v2/control/query: TypeError: fetch failed: (ECONNREFUSED)

prompt  when      rung  src  tok  chars  drop  ptr  empty_reason  used(m/c)  outcome
p_b…    17:02:07     1    1   23     92     0    0  —             —          —
p_c…    17:02:19     1    1   23     91     0    1  —             —          —
p_d…    17:02:31     1    1   23     91     0    1  —             —          —

totals      3 prompts · 69 tok injected · 3 sources · 3/3 prompts got an injection
used-signal 0/0 measurable turns echoed the injected vocabulary (memory-term-echo/v1; false negatives dominate)

lessons     global 0 · injected_ids 0 · reflect: 0 stored, status=—
capture     tools 0 · turns 0 · pending 0 · ingested 0 · spool 0 · jobs 0
last recall 0 sources · 0 tok · 4 ms · rung 0 · async_no_carry · dry_streak 1
            ^ marker is last-write-wins: this row is the most recent prompt only, and it is the only place per-prompt latency ever appears
breaker     unreachable · 1 failures · closed · http://127.0.0.1:3199
```

**Read the `ptr` column.** Three prompts got an injection; two of them were pointers. `rung 1`
throughout confirms no LLM call was ever paid — the ladder is unchanged, it has simply moved
off the prompt.

> There is a second, slower guard on staleness: `CARRY_TTL_MS` (15 minutes, `lib/carry.mjs`).
> A block older than that is dropped and swept rather than injected — the laptop-closed-over-
> lunch case, where the next thing typed is a new task rather than a continuation. An active
> session never comes near it, because every prompt spawns a refresh.

---

## §7 — Compaction clears the carried block too

`clearSeen` exists because after a compaction the transcript the entries were injected into is
**gone**, so a surviving pointer names a memory that exists nowhere. A block assembled *before*
the compaction has those pointer lines already baked into it, so it has to go with the set.

```bash
cd "$SCRATCH" && DELAY_MS=2300 nohup node slow-mubit.mjs > server.log 2>&1 &
sleep 2
node "$PLUG/hooks/dist/prompt-recall.mjs" < "$SCRATCH/p_e.json" > /dev/null
sleep 3
echo "before:" && ls "$DATA/runs/cc-hs6/"

printf '{"session_id":"s-hs6","transcript_path":"/dev/null","cwd":"%s","hook_event_name":"PostCompact","trigger":"auto"}' "$SCRATCH" \
  | node "$PLUG/hooks/dist/checkpoint.mjs" --post
echo && echo "after:" && ls "$DATA/runs/cc-hs6/"
```

**Expect**

```
before:
carry.json
seen.json
turns
{"suppressOutput":true}

after:
turns
```

Both files go, together. The next prompt primes from scratch — one un-recalled turn, which is
the correct price for not promising the model a memory it cannot read.

---

## §8 — Live, against `https://api.mubit.ai`

**Separate section, separate data dir, real key.** Everything above proves the mechanism;
this proves it against the hosted instance.

Recall queries by `run_id`, so point it at a run that already holds memory — one of your own:

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --runs | head -5
```

Then:

```bash
export MUBIT_CC_DATA_DIR="$LIVE"
export MUBIT_ENDPOINT=https://api.mubit.ai
export MUBIT_API_KEY=$(node -e 'process.stdout.write(require(process.env.HOME+"/.claude/plugins/data/mubit-memory-mubit/credentials.json").apiKey)')
export MUBIT_CC_RUN_ID=cc-hook-surface-19123e68     # ← one of yours, from --runs above
export MUBIT_CC_RECALL_ASYNC=1

node "$SCRATCH/mkp.mjs" L1 "what does the mubit claude-code plugin do about recall latency?"
node "$SCRATCH/mkp.mjs" L2 "and how does the seen-set interact with it?"

echo "key ${MUBIT_API_KEY:0:8}… (${#MUBIT_API_KEY} chars)"
/usr/bin/time -p node "$PLUG/hooks/dist/prompt-recall.mjs" < "$SCRATCH/L1.json"
```

**Expect**

```
key mbt_mubi… (105 chars)
{"suppressOutput":true}
real 0.05
user 0.04
sys 0.00
```

```bash
sleep 10 && python3 -c "
import json;d=json.load(open('$LIVE/runs/$MUBIT_CC_RUN_ID/carry.json'))
print('fetch_ms =',d['fetch_ms'],'· rung =',d['rung'],'· sources =',d['sources'],'· tokens =',d['tokens'])
print(); print(d['block'][:400])"
```

**Expect** — real memory from the real store:

```
fetch_ms = 1084 · rung = 1 · sources = 4 · tokens = 175

## Lessons
- When building the Claude Code plugin in the mirror repository where the sibling `../mcp` directory is absent, you must set `MUBIT_CC_BUILD_SKIP_SERVER=1` to prevent build failures.
- Avoid using `/v2/control/context` (rung 3) as a primary recall path because it incurs two LLM calls on every prompt, whereas `/v2/control/query` with `direct_bypass` (rung 1) is LLM-free.
- The actual Sto
```

(Truncated at 400 characters by the `[:400]` above — the block carries four entries.)

`rung = 1` — the hosted instance granted `direct_bypass`, so the block cost **zero LLM calls**.
The next prompt receives it:

```bash
/usr/bin/time -p node "$PLUG/hooks/dist/prompt-recall.mjs" < "$SCRATCH/L2.json" > "$SCRATCH/live2.json"
python3 -c "import json;print(json.load(open('$SCRATCH/live2.json'))['systemMessage'])"
```

**Expect**

```
real 0.07
user 0.06
sys 0.01
mubit: 4 memories · 175 tok · 5ms
```

And the same query blocking, for the comparison that matters here:

```bash
rm -rf /tmp/mubit-hs6-live2 && mkdir -p /tmp/mubit-hs6-live2
env -u MUBIT_CC_RECALL_ASYNC MUBIT_CC_DATA_DIR=/tmp/mubit-hs6-live2 \
  /usr/bin/time -p node "$PLUG/hooks/dist/prompt-recall.mjs" < "$SCRATCH/L1.json" > /dev/null
```

**Expect**

```
real 1.58
user 0.12
sys 0.02
```

**Be honest about what this shows.** The hosted instance answered its query in ~1.08 s, inside
the 1 500 ms budget — so blocking recall *works* there, it just costs the user a second and a
half of every prompt. The flag turns that into 70 ms. It is on the slow self-hosted instance of
§1–§2, where blocking recall returns nothing at all, that the flag changes correctness rather
than latency; here it only changes what the wait costs.

Note the two live runs disagree slightly on `sources` (4 here against 2 in an earlier run of
the same query): the store is live and this run is not a controlled measurement. That is what
§1–§7 are for.

---

## §9 — Clean up

```bash
lsof -ti :3199 | xargs -r kill
rm -rf /tmp/mubit-hs6 /tmp/mubit-hs6-data /tmp/mubit-hs6-sync /tmp/mubit-hs6-live /tmp/mubit-hs6-live2
unset MUBIT_CC_RECALL_ASYNC MUBIT_CC_DATA_DIR MUBIT_ENDPOINT MUBIT_API_KEY \
      MUBIT_CC_RUN_STRATEGY MUBIT_CC_RUN_ID MUBIT_CC_LOG_LEVEL CLAUDE_PROJECT_DIR
```

Nothing was written outside those five directories, and the live section only ever **read**
from `api.mubit.ai` — `prompt-recall` and `recall-refresh` issue `POST /v2/control/query` and
nothing else.

---

## §10 — Known, and not bugs

| What you see | Why |
|---|---|
| The first prompt of a session injects nothing | There is no previous turn to have carried a block. `SessionStart`'s standing lessons still land, so the session is not memoryless. |
| `recall.ms` is 2–5 ms and never grows | Under this flag it means what the *prompt* paid. The endpoint's own latency is `fetch_ms` in `carry.json`. |
| `async_no_carry` on a healthy install | The ordinary priming case. `state` plus `dry_streak` are what say whether it is a fault (§2, §6). |
| The status line's `recall` counts lag one prompt | They describe what was injected, and what was injected was retrieved a turn ago. That is the mode, not a bug. |
| Two extra node processes per prompt while the flag is on | One `recall-refresh` per prompt, detached, plus the drain when it triggers. With the flag **off** neither the file nor the process exists — that is what "default false" is protecting, and it is why this is a runtime flag rather than the host's static `async` manifest field. |
