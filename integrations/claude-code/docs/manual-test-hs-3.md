# Manual test — HS-3, the cross-turn seen-set

**Claim to prove: a lesson relevant for twenty prompts is paid for once at full price.**

The plugin was built on the belief that hooks are free and MCP is expensive. Measurement
inverted it. The whole MCP tool-name surface costs 356 tokens **once**; recall injection costs
up to 1500 tokens on **every prompt**. Over forty prompts that is 60,000 tokens against 356 —
and six memories about the task at hand do not stop being about the task at hand on the next
prompt, so most of those 60,000 tokens were the same six memories, re-sent.

`runs/<run_id>/seen.json` (`lib/seen.mjs`) records what this run has already put in front of
the model. A repeat is **degraded, not dropped**: it renders as its `reference_id` plus its
first clause, and it keeps that id in `recalled[]` so `Stop` can still attribute against it.
Dropping it would break attribution for exactly the memories that are helping most.

Everything below was executed on **2026-08-19** against this build, in
`$HOME/src/claude-plugins`. §1–§7 are offline and deterministic; §8 runs
against the hosted `https://api.mubit.ai` with the key already on this machine. **Every Expect
block is captured output, not a prediction.** Where a number will differ on your machine the
text says so.

**Time:** ~10 minutes for §0–§7, ~2 more for §8.
**Destroys:** nothing. Two temp directories, deleted in §9. Your installed plugin, its data
directory and your hosted memory are never written to — §8 only reads.

---

## §0 — Setup, one paste

Two traps decide whether the rest of this file works, and both bite silently. They are the
same two as `manual-test-0.10.0.md` §0, so the short version:

**Your shell may already point at a different Mubit,** and `MUBIT_ENDPOINT` beats the key you
signed in with. **Your data directory may not be where the docs say,** so pin it —
`MUBIT_CC_DATA_DIR` has the highest precedence of any data-dir input (`lib/state.mjs`).

```bash
env | grep -iE '^(MUBIT|CLAUDE_PLUGIN)' | sed 's/\(MUBIT_API_KEY=.\{0,10\}\).*/\1…/' | sort
```

**Expect nothing at all.** Anything printed there is already steering the plugin. Then paste
this whole block into the terminal you will use for the rest of the run:

```bash
export PLUG=$HOME/src/claude-plugins/integrations/claude-code
export DATA=/tmp/mubit-hs3-data
export SCRATCH=/tmp/mubit-hs3

# a throwaway project — never run this from a Mubit repo, see the note below
rm -rf "$SCRATCH" "$DATA" && mkdir -p "$SCRATCH" "$DATA"
cd "$SCRATCH" && git init -q && echo "# scratch" > README.md
git add -A && git -c user.email=you@example.com -c user.name=you commit -qm init

# pin the target explicitly — do not rely on the ambient environment
export MUBIT_CC_DATA_DIR="$DATA"
export MUBIT_ENDPOINT=http://127.0.0.1:48317        # the offline stub, stood up in §1
export MUBIT_API_KEY=mbt_stub_0123456789abcdef_deadbeefcafebabe0123456789abcdef

echo "plugin   $PLUG"
echo "data     $DATA"
echo "endpoint $MUBIT_ENDPOINT"
echo "key      ${MUBIT_API_KEY:0:8}… (${#MUBIT_API_KEY} chars)"
```

**Expect**

```
plugin   $HOME/src/claude-plugins/integrations/claude-code
data     /tmp/mubit-hs3-data
endpoint http://127.0.0.1:48317
key      mbt_stub… (58 chars)
```

Read `data` first. If it is not `/tmp/mubit-hs3-data`, stop — every number below would be
measuring some other run.

> **Work in `$SCRATCH`, never in a Mubit repo.** Self-reference suppression deliberately drops
> any capture whose text mentions `mubit`. In a Mubit checkout the capture path looks broken
> and is working exactly as designed.

> The key here is a fixture, not a credential: §1–§7 never leave loopback. §8 reads the real
> one out of the credential file so it never enters your shell history.

---

## §1 — A Mubit that never changes its mind

The experiment needs one thing the real world will not give you: **identical evidence on every
prompt.** That is what isolates the variable. If relevance does not decay between prompts, the
only thing that can make the injected block cheaper is the plugin knowing it already sent it.

```bash
cat > "$SCRATCH/stub-mubit.mjs" <<'STUB'
// A stand-in Mubit that answers /v2/control/query with the SAME six memories every time.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const PORT = Number(process.env.STUB_PORT) || 48317;

const body = (tag, n) => `${tag}: ${('the ' + tag.toLowerCase() + ' detail ').repeat(n)}`;
const evidence = (i, type, tag) => ({
  id: `e${i}`, reference_id: `ref_${tag}`, entry_type: type, source: 'agent', score: 0.9 - i / 100,
  content: body(tag, 12), run_id: 'stub', metadata_json: '{}', retrieval_mode: 'semantic_search',
  referenceable: true, origin_entry_type: '', is_stale: false, superseded_by: '',
  explain_info: '', knowledge_confidence: 0.6,
});

const EVIDENCE = [
  evidence(1, 'rule', 'never_force_push'),
  evidence(2, 'rule', 'migrations_are_forward_only'),
  evidence(3, 'lesson', 'ingest_returns_when_queued'),
  evidence(4, 'lesson', 'breaker_opens_on_five'),
  evidence(5, 'fact', 'run_ids_are_per_directory'),
  evidence(6, 'fact', 'turns_expire_after_six_hours'),
];

createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/v2/core/health')) { res.writeHead(200); return res.end('OK'); }
    if (req.url.startsWith('/v2/control/query')) {
      return json({ final_answer: '', confidence: 0.6, mode: 'direct_bypass', degraded: false,
        consulted_runs: [], routing_summary: 'direct_bypass', signals: {}, citations: [], evidence: EVIDENCE });
    }
    if (req.url.startsWith('/v2/control/outcome')) {
      // §7 reads this file: what the attribution loop actually posted.
      appendFileSync(new URL('./outcomes.ndjson', import.meta.url), `${raw}\n`);
      return json({ success: true, reinforcement_count: 1 });
    }
    if (req.url.startsWith('/v2/control/ingest')) return json({ accepted: true, job_id: 'job_1', status: 'queued' });
    json({ success: true });
  });
}).listen(PORT, '127.0.0.1', () => process.stdout.write(`stub-mubit on http://127.0.0.1:${PORT}\n`));
STUB

node "$SCRATCH/stub-mubit.mjs" &
sleep 1
curl -s http://127.0.0.1:48317/v2/core/health; echo
```

**Expect**

```
stub-mubit on http://127.0.0.1:48317
OK
```

If `EADDRINUSE` comes back, something else already owns the port — pick another with
`STUB_PORT=…` and change `MUBIT_ENDPOINT` to match. That is not hypothetical on a machine
running several plugin experiments at once; it happened during this run.

Each of the six memories is ~110 tokens, so six of them is ~700 — well inside the 1500-token
`recallTokenBudget`, which matters: **nothing below is the budget kicking in.** Every drop you
see is the seen-set, not truncation, and the `drop` column stays at `0` throughout to prove it.

---

## §2 — The before: forty prompts, every memory re-sent

`recallRepeatMode=full` is the behaviour of every release before this one — and it is still a
supported setting, so this is not a simulation of the old code, it *is* the old code path.

```bash
cat > "$SCRATCH/forty.sh" <<'DRIVE'
#!/bin/bash
# Forty prompts through the real UserPromptSubmit hook — one fresh node process each, exactly
# the way Claude Code spawns it. $1 is the run id, $2 is recallRepeatMode.
for i in $(seq -w 1 40); do
  printf '{"hook_event_name":"UserPromptSubmit","session_id":"s-%s","prompt_id":"p_%s","cwd":"%s","prompt":"why does the deploy step keep failing on attempt %s?"}' \
    "$2" "$i" "$SCRATCH" "$i" \
  | MUBIT_CC_RUN_STRATEGY=static MUBIT_CC_RUN_ID="$1" MUBIT_CC_RECALL_REPEAT_MODE="$2" \
    node "$PLUG/hooks/dist/prompt-recall.mjs" > /dev/null
done
echo "40 prompts done: run=$1 mode=$2"
DRIVE
chmod +x "$SCRATCH/forty.sh"

"$SCRATCH/forty.sh" hs3-before full
```

**Expect** (about five seconds)

```
40 prompts done: run=hs3-before mode=full
```

`hooks/dist/`, not `hooks/src/` — the bundle is what `hooks.json` actually runs, and an
unbuilt change is a change that does nothing.

---

## §3 — The after: forty prompts on the default

Same driver, same stub, same forty prompts. The only difference is `recallRepeatMode`, which
now defaults to `pointer`; it is spelled out here so the two runs differ in exactly one input.

```bash
"$SCRATCH/forty.sh" hs3-after pointer
```

**Expect**

```
40 prompts done: run=hs3-after mode=pointer
```

---

## §4 — The number

This is the headline. The `totals` row of `mubit-inspect` over the same forty prompts.

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run hs3-before --last 40
node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run hs3-after  --last 40
```

**Expect** — each command prints forty rows; the middle thirty-five are identical to their
neighbours and are elided here as `…`:

```
run hs3-before   hosted   ● ready   (data: /tmp/mubit-hs3-data)

prompt  when      rung  src  tok  chars  drop  ptr  empty_reason  used(m/c)  outcome
p_01…   16:24:23     1    6  697   2785     0    0  —             —          —
p_02…   16:24:23     1    6  697   2785     0    0  —             —          —
p_03…   16:24:23     1    6  697   2785     0    0  —             —          —
p_04…   16:24:23     1    6  697   2785     0    0  —             —          —
…
p_40…   16:24:27     1    6  697   2785     0    0  —             —          —

totals      40 prompts · 27880 tok injected · 240 sources · 40/40 prompts got an injection
```

```
run hs3-after   hosted   ● ready   (data: /tmp/mubit-hs3-data)

prompt  when      rung  src  tok  chars  drop  ptr  empty_reason  used(m/c)  outcome
p_01…   16:24:27     1    6  697   2785     0    0  —             —          —
p_02…   16:24:27     1    6  180    720     0    6  —             —          —
p_03…   16:24:28     1    6  180    720     0    6  —             —          —
p_04…   16:24:28     1    6  180    720     0    6  —             —          —
…
p_40…   16:24:31     1    6  180    720     0    6  —             —          —

totals      40 prompts · 7717 tok injected · 240 sources · 40/40 prompts got an injection
```

**Read `totals` first: 27,880 tokens → 7,717. A 72.3% drop over forty prompts.**

Then read the three columns that stop it being a lie:

| column | before | after | why it matters |
|---|---|---|---|
| `src` | `6` on every row | `6` on every row | **the same six memories reached the model every time.** A token saving that comes from recalling *less* is a regression with a nice graph |
| `sources` (totals) | `240` | `240` | the same, summed — 40 × 6, with nothing dropped on either side |
| `ptr` | `0` | `6` from prompt 2 on | the saving is attributable to this mechanism and nothing else |
| `drop` | `0` | `0` | the budget never bound; this is not truncation |

**Prompt 1 costs the same in both runs (697 tok).** That is the claim, stated as a number: full
price once, then 180 tokens a prompt for the remaining thirty-nine. The residual 180 is six
pointer lines plus three section headings — the block is still there, still attributed, still
naming every memory.

The ratio scales with how bulky your memories are. Six ~110-token entries save 74% a prompt;
§8 does it against one real 504-token memory and saves 95%.

---

## §5 — What actually changed in the block

The number is not worth much if the model can no longer tell what it was given. Look at it.

```bash
export MUBIT_CC_RUN_STRATEGY=static MUBIT_CC_RUN_ID=hs3-block
say()   { printf '{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt_id":"%s","cwd":"%s","prompt":"why does the deploy step keep failing?"}' "$1" "$SCRATCH"; }
block() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).hookSpecificOutput.additionalContext+"\n"))'; }

say q1 | node "$PLUG/hooks/dist/prompt-recall.mjs" | block | head -6
```

**Expect** — the first prompt, cut off by `head -6` after the first two entries:

```
<mubit-memory run="hs3-block" sources="6" tokens="697">
Recalled from memory of earlier work — it may be incomplete or out of date, so verify against the code before relying on it.

## Active rules
- never_force_push: the never_force_push detail the never_force_push detail the never_force_push detail the never_force_push detail the never_force_push detail the never_force_push detail the never_force_push detail the never_force_push detail the never_force_push detail the never_force_push detail the never_force_push detail the never_force_push detail
- migrations_are_forward_only: the migrations_are_forward_only detail the migrations_are_forward_only detail the migrations_are_forward_only detail the migrations_are_forward_only detail the migrations_are_forward_only detail the migrations_are_forward_only detail the migrations_are_forward_only detail the migrations_are_forward_only detail the migrations_are_forward_only detail the migrations_are_forward_only detail the migrations_are_forward_only detail the migrations_are_forward_only detail
```

Now the same six memories again:

```bash
say q2 | node "$PLUG/hooks/dist/prompt-recall.mjs" | block
```

**Expect** — this one whole; it fits:

```
<mubit-memory run="hs3-block" sources="6" tokens="180">
Recalled from memory of earlier work — it may be incomplete or out of date, so verify against the code before relying on it.
A line marked "(seen earlier)" was injected in full earlier in this conversation and is repeated here only as a reference; ask mubit_dereference for its text.

## Active rules
- (seen earlier) ref_never_force_push — never_force_push: the never_force_push detail the never_force_pu…
- (seen earlier) ref_migrations_are_forward_only — migrations_are_forward_only: the migrations_are_forward_only det…

## Lessons
- (seen earlier) ref_ingest_returns_when_queued — ingest_returns_when_queued: the ingest_returns_when_queued detai…
- (seen earlier) ref_breaker_opens_on_five — breaker_opens_on_five: the breaker_opens_on_five detail the brea…

## Facts
- (seen earlier) ref_run_ids_are_per_directory — run_ids_are_per_directory: the run_ids_are_per_directory detail…
- (seen earlier) ref_turns_expire_after_six_hours — turns_expire_after_six_hours: the turns_expire_after_six_hours d…
```

Four things to read, in order:

1. **`sources="6"` on both.** Every memory is still named. Nothing was dropped.
2. **Sections and order are unchanged.** A pointer occupies the slot its entry would have.
3. **The extra sentence.** It appears only when the block carries a pointer — a line that names
   a memory without carrying it reads exactly like a memory that was *truncated*, and a model
   reading it that way would either ignore it or invent the rest. It also tells the model the
   one thing it can do about it: `mubit_dereference` takes that reference id.
4. **The reference id is the handle, not decoration.** That is why the pointer prints it.

And the file behind it:

```bash
node -e 'const j=JSON.parse(require("fs").readFileSync(process.env.DATA+"/runs/hs3-block/seen.json","utf8"));
const k=Object.keys(j.refs);
console.log(JSON.stringify({run_id:j.run_id,updated_at:j.updated_at,refs:{[k[0]]:j.refs[k[0]],"…":`${k.length-1} more`}},null,2));'
```

**Expect** (timestamps will differ)

```
{
  "run_id": "hs3-block",
  "updated_at": 1787153089437,
  "refs": {
    "ref_never_force_push": {
      "first": 1787153089210,
      "last": 1787153089437,
      "count": 2
    },
    "…": "5 more"
  }
}
```

`first` is when the full price was paid and is never overwritten. `last` is what the 6 h TTL is
measured from — the same TTL `runs/<run_id>/turns/` gets, because this file is an aggregation
over exactly those. Losing it costs one expensive turn and cannot cost correctness.

---

## §6 — Compaction resets it

This is the one failure mode of the whole mechanism that is worse than paying full price:
after a compaction the transcript those entries were injected into is **gone**, so a surviving
pointer would name a memory that exists nowhere in the conversation. The model would be told a
memory applies and given no way to read it.

```bash
export MUBIT_CC_RUN_ID=hs3-compact
say c1 | node "$PLUG/hooks/dist/prompt-recall.mjs" >/dev/null
say c2 | node "$PLUG/hooks/dist/prompt-recall.mjs" >/dev/null

echo "before:"; ls -1 "$DATA/runs/hs3-compact/" | sed 's/^/  /'
printf '{"hook_event_name":"PostCompact","session_id":"s1","cwd":"%s","trigger":"auto"}' "$SCRATCH" \
  | node "$PLUG/hooks/dist/checkpoint.mjs" --post
echo; echo "after:"; ls -1 "$DATA/runs/hs3-compact/" | sed 's/^/  /'

say c3 | node "$PLUG/hooks/dist/prompt-recall.mjs" >/dev/null
node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run hs3-compact --last 5
```

**Expect**

```
before:
  seen.json
  turns
{"suppressOutput":true}

after:
  turns
```

```
prompt  when      rung  src  tok  chars  drop  ptr  empty_reason  used(m/c)  outcome
c1…     16:25:03     1    6  697   2785     0    0  —             —          —
c2…     16:25:03     1    6  180    720     0    6  —             —          —
c3…     16:25:03     1    6  697   2785     0    0  —             —          —
```

Read the `tok` column top to bottom: **697 → 180 → compaction → 697.** The third prompt pays
full price again because the model genuinely has not seen any of it.

`{"suppressOutput":true}` is the whole of `--post`'s stdout and always has been — `PostCompact`
has no `hookSpecificOutput` channel, so this hook has never had anything to say. Judge it by
the `ls`, not by the output.

Note that `--post` clears the set **before** it looks for a stored checkpoint. A compaction
with no anchor still emptied the window, and gating the reset on `--pre` having succeeded would
leave stale pointers behind on precisely the runs that already lost their checkpoint.

---

## §7 — Attribution survives the degrade

The trap, and the reason this section exists.

`capture --stop`'s used-signal works by matching distinctive memory terms echoed in the reply.
A pointer-only render carries almost none — so if nothing were done, every prompt after the
first would file a `neutral` "the model ignored it" against the memories relevant enough to
keep surfacing. The reinforcement signal would degrade in exact proportion to how well recall
was working, silently, and show up months later as memory that mysteriously stopped being
trusted.

`lib/outcome.mjs:129-152` distinguishes two rows that are one character apart in the turn file:

| turn file | posted | means |
|---|---|---|
| `used_evidence.used === false` | `neutral` 0.0, **entry_ids empty** | injected, and the reply showed no sign of it — a *measurement* |
| `used_evidence.used` **absent** | `success` +0.2, **entry_ids intact** | the signal could not be computed — *unmeasured* |

A degraded turn belongs in the second. Drive both, with the same evidence and the same reply,
and read where each landed.

```bash
export MUBIT_CC_RUN_ID=hs3-attrib
rm -f "$SCRATCH/outcomes.ndjson"
turn() {
  printf '{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt_id":"%s","cwd":"%s","prompt":"why does the deploy step keep failing?"}' "$1" "$SCRATCH" \
    | node "$PLUG/hooks/dist/prompt-recall.mjs" > /dev/null
  printf '{"hook_event_name":"Stop","session_id":"s1","prompt_id":"%s","cwd":"%s","last_assistant_message":"I checked the pipeline config and left it as it was."}' "$1" "$SCRATCH" \
    | node "$PLUG/hooks/dist/capture.mjs" --stop > /dev/null
  node "$PLUG/hooks/dist/drain.mjs" --with-outcome "$1" > /dev/null
}
turn t1; turn t2; sleep 1

# the `recall` / `used` / `outcome` lines of each turn, then what the server received
echo "turn 1 — every memory sent in full"
node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run hs3-attrib --prompt t1 | sed -n '3,5p' | sed 's/^/  /'
echo
echo "turn 2 — the same six, degraded to pointers"
node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run hs3-attrib --prompt t2 | sed -n '3,5p' | sed 's/^/  /'
echo
echo "what /v2/control/outcome actually received"
node -e 'for (const l of require("fs").readFileSync(process.env.SCRATCH+"/outcomes.ndjson","utf8").trim().split("\n")) {
  const b=JSON.parse(l);
  console.log(`  ${b.idempotency_key.slice(-2)}  outcome=${b.outcome}  signal=${b.signal}  entry_ids=${b.entry_ids.length}`);
}'
```

Drop the `sed` filters to see each turn in full — the elided lines are the prompt text, the
recalled ids and the turn's wall clock.

The reply is deliberately bland: it echoes none of the injected vocabulary either time, so the
*only* variable between the two turns is how the block was rendered.

**Expect**

```
turn 1 — every memory sent in full
  recall  rung 1 · 6 sources · 697 tok / 2785 chars · 0 dropped
  used    memory-term-echo/v1 · matched 0 of 8
  outcome sent

turn 2 — the same six, degraded to pointers
  recall  rung 1 · 6 sources · 180 tok / 720 chars · 0 dropped
  used    memory-term-echo/v1 · matched 0 of 0 · no_distinct_terms (not measurable)
  outcome sent

what /v2/control/outcome actually received
  t1  outcome=neutral  signal=0  entry_ids=0
  t2  outcome=success  signal=0.2  entry_ids=6
```

**Read the `used` line first, and read `matched 0 of 8` against `matched 0 of 0`.**

- Turn 1 had **8 candidate terms** and the reply carried none. That is a real measurement, and
  `neutral` with no `entry_ids` is the correct, honest record of it.
- Turn 2 had **0 candidate terms** — `no_distinct_terms (not measurable)`. A pointer's words
  are a reference id and a fragment; the model has no reason to echo either, so counting them
  would guarantee a miss. There is nothing to measure, and the plugin says so instead of
  inventing a denominator.
- **`entry_ids=6` on turn 2 is the line that matters most.** All six memories are still
  attributed. Degrading how a memory is *rendered* did not change whether it can be
  *reinforced* — which is the whole reason a repeat is degraded rather than dropped.

If `t2` ever reads `outcome=neutral entry_ids=0`, the trap has been reintroduced.
`test/attribution.test.mjs` pins this exact pair.

---

## §8 — Live, against `api.mubit.ai`

Marked separately because it depends on a hosted endpoint and on there being memory to recall.
Everything above proves the mechanism without a network; this proves the *default install*
does it against real memory.

It is read-only: `POST /v2/control/query` and nothing else. It writes to a temp data dir, and
it reads an existing run's memory rather than creating any.

```bash
export DATA=/tmp/mubit-hs3-live
rm -rf "$DATA" && mkdir -p "$DATA"
export MUBIT_CC_DATA_DIR="$DATA"
export MUBIT_ENDPOINT=https://api.mubit.ai
export MUBIT_API_KEY=$(node -e 'process.stdout.write(require(process.env.HOME+"/.claude/plugins/data/mubit-memory-mubit/credentials.json").apiKey)')
export MUBIT_CC_RUN_STRATEGY=static MUBIT_CC_RECALL_BUDGET_MS=8000

# pick a run that has memory: `mubit-inspect --runs` lists every run on this machine
export LIVE_RUN=cc-pre-main-af449e06

live() {
  for i in 1 2 3 4 5 6 7 8 9 10; do
    printf '{"hook_event_name":"UserPromptSubmit","session_id":"s-%s","prompt_id":"L%s%s","cwd":"%s","prompt":"what did we learn about the plugin hooks and the recall token budget?"}' \
      "$1" "$1" "$i" "$SCRATCH" \
    | MUBIT_CC_RUN_ID="$LIVE_RUN" MUBIT_CC_RECALL_REPEAT_MODE="$1" node "$PLUG/hooks/dist/prompt-recall.mjs" >/dev/null
  done
  echo "10 live prompts done: mode=$1"
}
live full
live pointer
node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run "$LIVE_RUN" --last 20
```

`MUBIT_CC_RECALL_BUDGET_MS=8000` is deliberate. The default is 1500 ms, and a slow instance
answers a rung-1 query in 1.4–2.3 s — recall then returns empty and the status line shows
`◌ not_responding`. Raising it for a manual run keeps a latency problem from being read as a
seen-set problem. The hosted endpoint answered in well under a second on this run.

**Expect** (times and the memory itself will differ on your machine; the *shape* is the point)

```
run cc-pre-main-af449e06   hosted   ● ready   (data: /tmp/mubit-hs3-live)

prompt     when      rung  src  tok  chars  drop  ptr  empty_reason  used(m/c)  outcome
Lfull1…    16:25:33     1    1  504   2014     0    0  —             —          —
Lfull2…    16:25:34     1    1  504   2014     0    0  —             —          —
Lfull3…    16:25:35     1    1  504   2014     0    0  —             —          —
Lfull4…    16:25:36     1    1  504   2014     0    0  —             —          —
…
Lfull10…   16:25:43     1    1  504   2014     0    0  —             —          —
Lpointer…  16:25:44     1    1   27    107     0    1  —             —          —
Lpointer…  16:25:45     1    1   27    107     0    1  —             —          —
Lpointer…  16:25:46     1    1   27    107     0    1  —             —          —
Lpointer…  16:25:47     1    1   27    107     0    1  —             —          —
…                                        (six more identical rows)

totals      20 prompts · 5310 tok injected · 20 sources · 20/20 prompts got an injection
```

**One real 504-token memory, re-sent ten times, becomes 27 tokens a prompt: 5,040 → 270, a 95%
drop.** `src` stays at `1` and `drop` at `0` throughout: the same memory reached the model on
all twenty prompts.

**The `Lpointer1` row is already 27 tokens, not 504 — read that carefully.** The `full` run
before it still *recorded* what it injected; `recallRepeatMode` governs how a repeat is
rendered, not whether it is remembered. That is deliberate: an operator flipping the dial back
gets the saving on the very next prompt rather than after a warm-up.

If your `src` column reads `0` with `empty_reason no_evidence`, the run you picked has no
memory the query matched. Try another from `mubit-inspect --runs`, or a query closer to what
that run actually worked on — an empty recall proves nothing either way.

---

## §9 — Teardown

```bash
kill %1 2>/dev/null            # the stub from §1
rm -rf /tmp/mubit-hs3 /tmp/mubit-hs3-data /tmp/mubit-hs3-live
echo "gone: $(ls -d /tmp/mubit-hs3* 2>/dev/null | wc -l | tr -d ' ') directories left"
```

**Expect**

```
gone: 0 directories left
```

Nothing outside those three paths was written. Your installed plugin's data directory was never
opened for writing, and §8 made no write calls to the hosted instance.

---

## What this guide does not prove

Stated so nobody has to re-derive it:

- **That a pointer works as well as the full text, for the model.** It proves the pointer is
  cheap, attributed, and honest about what it is. Whether a model acts on
  `(seen earlier) ref_x — first clause…` as reliably as on the whole entry is a question about
  model behaviour, and it needs a task benchmark, not a token count.
- **Anything about rung 3.** `recallAssemble: "server"` has the server assemble the block, and
  there is no seam inside it to degrade — that path pays two LLM calls and full token price.
  The `ptr` column reads `0` there, honestly rather than by omission.
- **Behaviour past the 6 h TTL or the 512-entry ceiling.** Both are exercised by
  `test/seen-set.test.mjs`, which can age a roll-up without waiting six hours.
