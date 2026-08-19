# Manual test — HS-4, `StopFailure`

**The claim this runbook proves: a turn that died on `rate_limit` never reaches
`record_outcome`.**

`Stop` posts an implicit outcome for every turn against that turn's recalled ids. A turn that
ended on `rate_limit`, `overloaded` or `max_output_tokens` did not fail because the recalled
memory was wrong — but until this change nothing in the path could tell the difference, and
`record_outcome()` is the call the docs describe as *"the highest-leverage call in the loop"*.
Everything downstream of it — `knowledge_confidence`, the 0.6 / 0.25 validation gate, scope
promotion, the shadow A/B that gates the widest scopes — depends on its input being clean.

Everything below was executed on **2026-08-19** against the branch `feat/stop-failure` at
worktree `/Users/eldaru/Mubit/hs-4-stop-failure`, built with
`MUBIT_CC_BUILD_SKIP_SERVER=1 npm run build`, and it drives **`hooks/dist/`** — the bundles the
host actually executes — not `hooks/src/`. The host facts in §1 come from Claude Code
**2.1.235**. The **Expect** blocks are transcripts, not predictions; where a number will differ
on your machine (timestamps, run ids, latency) the text says so.

**Time:** ~10 minutes for §0–§7 offline, ~5 more for the live section §8.
**Destroys:** nothing. Everything lives under `/tmp/mubit-hs4*`, which you delete in §9. Your
installed plugin, its data dir and its memory are never touched. §8 registers one throwaway
run against the hosted Mubit and posts **no** outcome — see the note there for why the
contrast case is deliberately not run live.

---

## §0 — Setup, one paste

Two traps decide whether the rest of this file works, and both bite silently. They are the
same two `manual-test-0.10.0.md` §0 opens with, so if you have just run that one you already
know them:

**Trap 1 — your shell may already point at a different Mubit.** Config precedence is
`CLAUDE_PLUGIN_OPTION_*` → `MUBIT_*` env → `credentials.json` → `.mubit-cc.json` → default, so
a `MUBIT_ENDPOINT` left exported from an earlier local-server session beats the hosted key you
signed in with. Check before you start:

```bash
env | grep -iE '^(MUBIT|CLAUDE_PLUGIN)' | sed 's/\(MUBIT_API_KEY=.\{0,10\}\).*/\1…/' | sort
```

**Expect nothing at all.** Anything printed here is already steering the plugin.

**Trap 2 — the run id.** Every step below reads and writes `runs/<run_id>/`, so the run id is
pinned with `MUBIT_CC_RUN_STRATEGY=static` rather than derived from the git remote. Without it
you will seed one run and inspect another.

Now paste this whole block into the terminal you will use for the rest of the run:

```bash
export PLUG=/Users/eldaru/Mubit/hs-4-stop-failure/integrations/claude-code
export SCRATCH=/tmp/mubit-hs4
export DATA=/tmp/mubit-hs4-data

# a throwaway project — never run this from a Mubit repo, see the note below
rm -rf "$SCRATCH" "$DATA" && mkdir -p "$SCRATCH" "$DATA"
cd "$SCRATCH" && git init -q && echo "# scratch" > README.md
git add -A && git -c user.email=you@example.com -c user.name=you commit -qm init

# pin everything explicitly — do not rely on the ambient environment
export MUBIT_CC_DATA_DIR="$DATA"
export MUBIT_CC_RUN_STRATEGY=static
export MUBIT_CC_RUN_ID=cc-hs4
export MUBIT_CC_LOG_LEVEL=debug        # writes the ring log at $DATA/logs/mubit-cc.log

echo "plugin   $PLUG"
echo "data     $DATA"
echo "run id   $MUBIT_CC_RUN_ID"
```

**Expect**

```
plugin   /Users/eldaru/Mubit/hs-4-stop-failure/integrations/claude-code
data     /tmp/mubit-hs4-data
run id   cc-hs4
```

The offline sections need somewhere for the hooks to dial that is not Mubit. This recorder
answers everything `200` and logs the path of every call it receives — which endpoint got
dialled is the entire question in §6. It runs **once**, for the whole offline run; `mark` and
`since` slice its log per step, so no step has to start or stop a server.

```bash
cat > "$SCRATCH/recorder.mjs" <<'EOF'
// A loopback Mubit that answers everything 200 and logs the path of every call it sees.
// Crude on purpose: the point is which endpoints get dialled, not what they return.
import { createServer } from 'node:http';
const s = createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    console.error(`${req.method} ${req.url}`);
    if (req.url.startsWith('/v2/core/health')) { res.writeHead(200); return res.end('OK'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', job_id: 'job_1', lessons_stored: 0, entries: [] }));
  });
});
s.listen(4317, '127.0.0.1');
EOF

pkill -f "$SCRATCH/recorder.mjs" 2>/dev/null; sleep 1     # a leftover from an earlier run holds the port
: > "$SCRATCH/calls.txt"
node "$SCRATCH/recorder.mjs" >/dev/null 2>>"$SCRATCH/calls.txt" &
sleep 1

export MUBIT_ENDPOINT=http://127.0.0.1:4317
export MUBIT_API_KEY=offline-key

# every call since the last `mark`. The sleep lets a hook's last socket land before we read:
# `session-end` finishes its own work fractionally before the endpoint has logged all of it.
mark ()  { wc -l < "$SCRATCH/calls.txt" | tr -d ' ' > "$SCRATCH/.mark"; }
since () { sleep 1; tail -n "+$(( $(cat "$SCRATCH/.mark") + 1 ))" "$SCRATCH/calls.txt"; }

mark; curl -s http://127.0.0.1:4317/v2/core/health; echo; since
```

**Expect** — the recorder answering, and its log slicing cleanly:

```
OK
GET /v2/core/health
```

If `calls.txt` fills with `EADDRINUSE` instead, a recorder from an earlier run still holds
4317: `for p in $(lsof -nP -iTCP:4317 -sTCP:LISTEN -t); do kill "$p"; done` and re-paste.

> **Work in `$SCRATCH`, never in a Mubit repo.** Self-reference suppression deliberately drops
> any capture whose text mentions `mubit`. In a Mubit checkout the capture path looks broken
> and is working exactly as designed.

---

## §1 — The fact the whole ticket turns on

Everything in HS-4 depends on one question: **when a turn dies on an API error, does `Stop`
fire as well?** If it does, the existing `capture --stop` closes the turn and all that is
needed is a decision. If it does not, nothing closes the turn at all and the mode has to do it.

This is not inferred. It is read out of the host binary's own hook registry, the same way
`test/hook-output.test.mjs:64-88` reads the accepted `hookEventName` set:

```bash
V=~/.local/share/claude/versions/2.1.235
strings -a "$V" | grep -o 'StopFailure:{summary:.\{0,420\}' | head -1 | fold -w 96
```

**Expect** (line-wrapped by `fold`; `—` is an em dash the binary stores escaped):

```
StopFailure:{summary:"When the turn ends due to an API error",description:"Fires instead of Stop
 when an API error (rate limit, auth failure, etc.) ended the turn. Fire-and-forget — hook
output and exit codes are ignored.",matcherMetadata:{fieldToMatch:"error",values:["rate_limit","
overloaded","authentication_failed","oauth_org_not_allowed",...fOr()?["account_on_hold"]:[],"bil
ling_error","invalid_request","model_not_found","server_e
```

Read **`"Fires instead of Stop"`** first. That is the answer: `capture --stop` never runs on a
rate-limited turn, so before HS-4 the turn file was simply abandoned half-written — `prompt`
and `recalled` staged by `UserPromptSubmit`, no `ended_at`, and nothing anywhere recording
that the turn had died or why.

Read `matcherMetadata` second, and specifically the spread: **`...fOr()?["account_on_hold"]:[]`**.
The error taxonomy is ten values plus a **feature-flagged eleventh**, so it is not the same
list on every account. An enumerated matcher in `hooks.json` would be correct on some installs
and silently short on others — and the turns it dropped would be exactly the ones this hook
exists to catch. That is why §2's registration carries no matcher at all.

Third, `"Fire-and-forget — hook output and exit codes are ignored"`: nothing this hook prints
is read. `StopFailure` is also absent from the host's `hookEventName` dispatch union, so it
has no `hookSpecificOutput` channel either. `{"suppressOutput": true}` is the only correct
stdout, and it is the only thing the hook emits.

The payload schema comes from the same binary, and it settles the field names:

```bash
strings -a "$V" | grep -o 'hook_event_name:wt("StopFailure").\{0,110\}' | head -1
```

**Expect**

```
hook_event_name:wt("StopFailure"),error:Mzc(),error_details:N().optional(),last_assistant_message:N().optional()
```

The error kind rides in **`error`** — not `reason`, and not `error_type`, both of which appear
in prose elsewhere. `test/helpers/fixtures.mjs` records the same names with the same command
next to them, because a fixture written from the wrong name would agree with an implementation
reading the wrong name and both would be green while every API-failed turn was stamped
`unknown`.

---

## §2 — The registration

```bash
node -e '
const h=require(process.env.PLUG+"/hooks/hooks.json").hooks;
for (const [ev,g] of Object.entries(h))
  for (const grp of g) for (const e of grp.hooks)
    console.log(String(ev).padEnd(19), JSON.stringify(grp.matcher ?? null).padEnd(28),
      e.args[0].split("/").pop(), (e.args.slice(1).join(" ")||"—").padEnd(15), "t="+e.timeout+"s");
'
```

**Expect** — ten events, eleven commands:

```
SessionStart        "startup|resume|clear|compact" session-start.mjs —               t=5s
UserPromptSubmit    null                         prompt-recall.mjs —               t=3s
UserPromptSubmit    null                         stage-prompt.mjs —               t=3s
PostToolUse         "*"                          capture.mjs —               t=3s
PostToolUseFailure  ""                           capture.mjs --failure       t=3s
Stop                null                         capture.mjs --stop          t=5s
StopFailure         null                         capture.mjs --stop-failure  t=3s
SubagentStop        null                         capture.mjs --subagent      t=3s
PreCompact          null                         checkpoint.mjs --pre           t=10s
PostCompact         null                         checkpoint.mjs --post          t=5s
SessionEnd          null                         session-end.mjs —               t=8s
```

Read the `StopFailure` row's **`null` matcher** first — that is §1's feature-flagged eleventh
value being handled by not enumerating anything. Read the timeout second: `3s`, not `Stop`'s
`5s`, because this mode writes one file and never forces a drain.

The manifest lint pins both:

```bash
node "$PLUG/scripts/verify-manifests.mjs"
```

**Expect**

```
verify-manifests: all manifest checks passed (§12.7)
```

---

## §3 — The mark

Drive one turn by hand, exactly as the host would drive it: `SessionStart`, then
`UserPromptSubmit`, then — because the API fell over — `StopFailure` **instead of** `Stop`.

The one synthetic step is the `recalled` array. In a session with memory `prompt-recall`
writes it; this scratch project has none, so it is seeded by hand. Everything else is the
shipped bundle reading a real payload.

```bash
cd "$SCRATCH"
node "$PLUG/hooks/dist/session-start.mjs" <<< '{"hook_event_name":"SessionStart","session_id":"s-hs4","cwd":"'"$SCRATCH"'","transcript_path":"'"$SCRATCH"'/t.jsonl","permission_mode":"default","source":"startup","model":"claude-opus-5"}' > /dev/null

node "$PLUG/hooks/dist/stage-prompt.mjs" <<< '{"hook_event_name":"UserPromptSubmit","session_id":"s-hs4","prompt_id":"p-hs4","cwd":"'"$SCRATCH"'","transcript_path":"'"$SCRATCH"'/t.jsonl","permission_mode":"default","prompt":"why is the ingest job stuck in queued?"}' > /dev/null

# what prompt-recall would have written, in a project that had memory
node -e 'const fs=require("node:fs"),p=process.env.DATA+"/runs/cc-hs4/turns/p-hs4.json";
const t=JSON.parse(fs.readFileSync(p,"utf8")); t.recalled=["ref_rule_1","ref_lesson_1"];
fs.writeFileSync(p,JSON.stringify(t));'

node "$PLUG/hooks/dist/capture.mjs" --stop-failure <<< '{"hook_event_name":"StopFailure","session_id":"s-hs4","prompt_id":"p-hs4","cwd":"'"$SCRATCH"'","transcript_path":"'"$SCRATCH"'/t.jsonl","permission_mode":"default","error":"rate_limit","error_details":"This request would exceed your rate limit.","last_assistant_message":"Let me check the indexing qu"}'

echo "--- turn file ---"
node -e 'console.log(JSON.stringify(JSON.parse(require("node:fs").readFileSync(process.env.DATA+"/runs/cc-hs4/turns/p-hs4.json","utf8")),null,2))'
echo "--- spool files ---"
ls -1 "$DATA/runs/cc-hs4/spool" 2>/dev/null | wc -l
```

**Expect** — timestamps differ:

```
{"suppressOutput":true}
--- turn file ---
{
  "prompt": "why is the ingest job stuck in queued?",
  "prompt_id": "p-hs4",
  "session_id": "s-hs4",
  "started_at": 1787152328901,
  "recalled": [
    "ref_rule_1",
    "ref_lesson_1"
  ],
  "api_error": "rate_limit",
  "ended_at": 1787152329003,
  "outcome_pending": true
}
--- spool files ---
       0
```

Read **`api_error`** first. It is the coordination point of the whole ticket: `capture
--stop-failure` is its only writer and `lib/outcome.mjs` is its only reader.

Read **`ended_at`** second — the turn is closed, by the only hook that will ever get the
chance to close it.

Read **`outcome_pending: true`** third, and notice that it is *not* a mistake. The turn is
left a genuine candidate for the outcome decision, exactly like every other closed turn, so
`session-end`'s flush really does pick it up in §6 and really does decide about it. Setting
the flag to `false` here would also stop the post — but by hiding the turn from the sweep
rather than by deciding, which is the shape of rule that the next person to touch that filter
deletes by accident. The rule lives in one place, `lib/outcome.mjs`, and both hooks read it.

Read **`prompt` and `recalled` surviving** fourth: the close merges, it does not rewrite.
Those ids are what a later, real outcome would attribute against.

Read **zero spool files** last. A turn the API killed produced no episode — its answer is
whatever fragment arrived before the failure — and `Q: …\n\nA: Let me check the indexing qu`
is not a memory worth paying to store, recall, and re-read later as though it were what the
assistant had to say on the subject.

---

## §4 — Whatever value the host sends

§1 showed the taxonomy is feature-flagged. This shows the mark does not care: every value is
copied through, including one the plugin has never heard of, and an absent field becomes
`unknown` — which is what the host itself substitutes on the way to its matcher
(`matchQuery: e.error ?? "unknown"`).

```bash
cd "$SCRATCH"
export DATA=/tmp/mubit-hs4-tax; export MUBIT_CC_DATA_DIR="$DATA"
for e in rate_limit overloaded authentication_failed oauth_org_not_allowed account_on_hold \
         billing_error invalid_request model_not_found server_error max_output_tokens unknown \
         context_window_exceeded ''; do
  rm -rf "$DATA"; mkdir -p "$DATA/runs/cc-hs4/turns"
  echo '{"prompt_id":"p1","recalled":["ref_1"],"started_at":1}' > "$DATA/runs/cc-hs4/turns/p1.json"
  if [ -z "$e" ]; then P='{"hook_event_name":"StopFailure","session_id":"s","prompt_id":"p1","cwd":"'"$SCRATCH"'","transcript_path":"/dev/null","permission_mode":"default"}';
  else P='{"hook_event_name":"StopFailure","session_id":"s","prompt_id":"p1","cwd":"'"$SCRATCH"'","transcript_path":"/dev/null","permission_mode":"default","error":"'"$e"'"}'; fi
  node "$PLUG/hooks/dist/capture.mjs" --stop-failure <<< "$P" > /dev/null
  printf '%-24s -> %s\n' "${e:-(no error field)}" \
    "$(node -e 'const t=JSON.parse(require("node:fs").readFileSync(process.env.DATA+"/runs/cc-hs4/turns/p1.json","utf8"));console.log(JSON.stringify(t.api_error))')"
done
export DATA=/tmp/mubit-hs4-data; export MUBIT_CC_DATA_DIR="$DATA"
```

**Expect**

```
rate_limit               -> "rate_limit"
overloaded               -> "overloaded"
authentication_failed    -> "authentication_failed"
oauth_org_not_allowed    -> "oauth_org_not_allowed"
account_on_hold          -> "account_on_hold"
billing_error            -> "billing_error"
invalid_request          -> "invalid_request"
model_not_found          -> "model_not_found"
server_error             -> "server_error"
max_output_tokens        -> "max_output_tokens"
unknown                  -> "unknown"
context_window_exceeded  -> "context_window_exceeded"
(no error field)         -> "unknown"
```

Read the last two rows first. `context_window_exceeded` is not in any taxonomy this plugin was
handed — it is a value from a hypothetical newer host — and it still closes the turn and still
suppresses. `(no error field)` becomes `"unknown"` rather than `""`, because an empty mark
would read as *no API error at all* and put the turn straight back into the outcome path.

Read `account_on_hold` second: that is the flag-gated eleventh, present here only because the
registration enumerates nothing.

---

## §5 — The used-signal stays unmeasured

§5.5's used-signal asks whether the reply carried the injected memory's vocabulary. A reply
the API cut off has no denominator for that question. Same staged terms, same reply, two modes:

```bash
cd "$SCRATCH"
export DATA=/tmp/mubit-hs4-sig; export MUBIT_CC_DATA_DIR="$DATA"
run () {
  rm -rf "$DATA"; mkdir -p "$DATA/runs/cc-hs4/turns"
  node -e 'require("node:fs").writeFileSync(process.env.DATA+"/runs/cc-hs4/turns/p1.json",JSON.stringify({
    prompt:"why is the ingest job stuck in queued?",prompt_id:"p1",session_id:"s",started_at:Date.now(),
    recalled:["ref_1"],recall:{at:Date.now(),rung:1,sources:1,tokens:40,chars:160,dropped:0,empty_reason:"",
    terms:["indexing","queued"]}}));'
  node "$PLUG/hooks/dist/capture.mjs" $1 <<< '{"hook_event_name":"'"$2"'","session_id":"s","prompt_id":"p1","cwd":"'"$SCRATCH"'","transcript_path":"/dev/null","permission_mode":"default",'"$3"'"last_assistant_message":"The indexing queue is still draining, so the job stays qu"}' > /dev/null
  node -e 'const t=JSON.parse(require("node:fs").readFileSync(process.env.DATA+"/runs/cc-hs4/turns/p1.json","utf8"));
    console.log("  used_evidence:", JSON.stringify(t.used_evidence));
    console.log("  api_error:    ", JSON.stringify(t.api_error));'
}
echo "Stop (--stop):";                          run --stop Stop ''
echo "StopFailure (--stop-failure), same reply:"; run --stop-failure StopFailure '"error":"max_output_tokens",'
export DATA=/tmp/mubit-hs4-data; export MUBIT_CC_DATA_DIR="$DATA"
```

**Expect**

```
Stop (--stop):
  used_evidence: {"method":"memory-term-echo/v1","at":1787152444093,"candidates":2,"matched":1,"terms":["indexing"],"answer_chars":57,"used":true}
  api_error:     undefined
StopFailure (--stop-failure), same reply:
  used_evidence: undefined
  api_error:     "max_output_tokens"
```

Read the second block's `used_evidence: undefined` first. The signal it *would* have produced
on a truncated reply is `used: false`, and `decideOutcome` reads a measured `false` as *the
model ignored the memory*. An absent key means unmeasured, which is what a reply cut off at
`max_output_tokens` actually is. Unmeasurable is not unused, and this is the last point at
which that distinction can still be made honestly.

---

## §6 — The suppression, in both hooks

**Two** hooks post this record — `drain.mjs` attributes a turn as it ends, `session-end.mjs`
flushes the turns the drain never reached. They are separate esbuild entry points that cannot
import one another, and the last time a rule like this lived in both files the copies drifted
for a release without either one looking wrong on its own (`lib/outcome.mjs:10-30`). So both
are driven here, each against the same turn twice: once ordinary, once marked.

```bash
cd "$SCRATCH"
seed () {   # $1 = data dir, $2 = extra turn keys
  rm -rf "$1"; mkdir -p "$1/runs/cc-hs4/turns" "$1/runs/cc-hs4/spool"
  node -e '
    const fs=require("node:fs");
    const t={prompt:"why is the ingest job stuck in queued?",prompt_id:"p-hs4",session_id:"s-hs4",
      started_at:Date.now()-30000,ended_at:Date.now()-1000,
      recalled:["ref_rule_1","ref_lesson_1"],outcome_pending:true, ...JSON.parse(process.argv[2])};
    fs.writeFileSync(process.argv[1]+"/runs/cc-hs4/turns/p-hs4.json",JSON.stringify(t));
    fs.writeFileSync(process.argv[1]+"/runs/cc-hs4/spool/1765000000000-a000.json",JSON.stringify({
      item_id:"cc-hs4-1",content_type:"text",text:"Bash(command=ls) -> README.md",intent:"trace",
      importance:"low",source:"agent",occurrence_time:1765000000,env_tags:["tool:claude-code"],
      metadata_json:"{}"}));
  ' "$1" "$2"
}
END='{"hook_event_name":"SessionEnd","session_id":"s-hs4","cwd":"'"$SCRATCH"'","transcript_path":"/dev/null","permission_mode":"default","reason":"exit"}'
STOP='{"hook_event_name":"Stop","session_id":"s-hs4","prompt_id":"p-hs4","cwd":"'"$SCRATCH"'","transcript_path":"/dev/null","permission_mode":"default"}'

for case in a:session-end:'{}' b:session-end:'{"api_error":"rate_limit"}' \
            c:drain:'{}'       d:drain:'{"api_error":"rate_limit"}'; do
  name=${case%%:*}; rest=${case#*:}; hook=${rest%%:*}; keys=${rest#*:}
  seed "/tmp/mubit-hs4-$name" "$keys"
  mark
  if [ "$hook" = drain ]; then
    MUBIT_CC_DATA_DIR="/tmp/mubit-hs4-$name" node "$PLUG/hooks/dist/drain.mjs" --with-outcome p-hs4 <<< "$STOP" > /dev/null
  else
    MUBIT_CC_DATA_DIR="/tmp/mubit-hs4-$name" node "$PLUG/hooks/dist/session-end.mjs" <<< "$END" > /dev/null
  fi
  echo "=== $name — $hook, ${keys} ==="; since
done
```

**Expect**

```
=== a — session-end, {} ===
POST /v2/control/ingest
POST /v2/control/outcome
POST /v2/control/reflect
POST /v2/control/agents/heartbeat
=== b — session-end, {"api_error":"rate_limit"} ===
POST /v2/control/ingest
POST /v2/control/reflect
POST /v2/control/agents/heartbeat
=== c — drain, {} ===
POST /v2/control/ingest
POST /v2/control/outcome
=== d — drain, {"api_error":"rate_limit"} ===
POST /v2/control/ingest
```

Read the missing `POST /v2/control/outcome` in **b and d** first — one key on the turn file,
both hooks, one line of difference. That is the claim at the top of this file, proved twice.

Read `POST /v2/control/ingest` **still being there** second. The turn's captured tool calls
were real work and still go out; the model's API fell over, not Mubit's. So did `reflect` and
the idle heartbeat — this is a suppressed *outcome*, not a suppressed session.

Read a and c third: they are the control. Without the mark the same turn posts an outcome, so
b and d are the guard firing and not the whole path being broken.

One thing the turn file will **not** show afterwards: an incremented `outcome_attempts`.
Attempts are a budget for posts that may have landed unanswered; a turn nothing will ever dial
must not spend one, or it eventually reads as three failed posts that never happened.

```bash
node -e 'console.log(require("node:fs").readFileSync("/tmp/mubit-hs4-d/runs/cc-hs4/turns/p-hs4.json","utf8"))'
```

**Expect** — no `outcome_attempts`, no `outcome_sent_at`, and `api_error` untouched:

```
{"prompt":"why is the ingest job stuck in queued?","prompt_id":"p-hs4","session_id":"s-hs4","started_at":1787152266721,"ended_at":1787152295721,"recalled":["ref_rule_1","ref_lesson_1"],"outcome_pending":true,"api_error":"rate_limit"}
```

---

## §7 — The read-out

`scripts/mubit-inspect.mjs` is the per-prompt view, and it has a row for this state so an
API-failed turn does not read as a flush that never happened:

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --data /tmp/mubit-hs4-data --run cc-hs4 --last 40
```

**Expect** — the §3 turn, times will differ:

```
run cc-hs4   hosted   ● ready   (data: /tmp/mubit-hs4-data)

prompt  when      rung  src  tok  chars  drop  empty_reason  used(m/c)  outcome
p-hs4…  16:12:38     —    0    0      0     0  —             —          api:rate_limit

totals      1 prompts · 0 tok injected · 0 sources · 0/1 prompts got an injection
used-signal 0/0 measurable turns echoed the injected vocabulary (memory-term-echo/v1; false negatives dominate)

lessons     global 0 · injected_ids 0 · reflect: 0 stored, status=—
capture     tools 0 · turns 0 · pending 0 · ingested 0 · spool 0 · jobs 0
last recall 0 sources · 0 tok · 0 ms · rung 0 · dry_streak 0
            ^ marker is last-write-wins: this row is the most recent prompt only, and it is the only place per-prompt latency ever appears
```

Read the **`outcome`** column: `api:rate_limit`, not `pending`. It carries the taxonomy value
straight through, so the reason the turn has no outcome is on the same line as the fact that it
has none. This is the one place the count of turns lost to API errors survives — deliberately
local, since suppression means it never reaches the wire.

---

## §8 — Live, against `https://api.mubit.ai`

Everything above is offline and deterministic. This section runs the same suppression against
the hosted endpoint, and it is honest about what it cannot do.

**What cannot be run live:** a real `StopFailure` requires a real API error. You cannot make
Anthropic rate-limit you on demand, so the payload below is still hand-fed. What is live is
everything else — the endpoint, the key, the registration, the drain, and the decision.

**What is deliberately not run live:** the §6 A/C control case. Posting an outcome with
`entry_ids: ["ref_rule_1","ref_lesson_1"]` would write reinforcement against reference ids that
do not exist in the hosted store. The offline recorder covers that half; production does not
need the litter.

```bash
export DATA=/tmp/mubit-hs4-live
export MUBIT_CC_DATA_DIR="$DATA"
export MUBIT_CC_RUN_ID=cc-hs4-live
export MUBIT_ENDPOINT=https://api.mubit.ai
export MUBIT_API_KEY=$(node -e 'process.stdout.write(require(process.env.HOME+"/.claude/plugins/data/mubit-memory-mubit/credentials.json").apiKey)')
export MUBIT_CC_RECALL_BUDGET_MS=6000     # see the note under the Expect block
rm -rf "$DATA"; mkdir -p "$DATA"
cd "$SCRATCH"

node "$PLUG/hooks/dist/session-start.mjs" <<< '{"hook_event_name":"SessionStart","session_id":"s-live","cwd":"'"$SCRATCH"'","transcript_path":"'"$SCRATCH"'/t.jsonl","permission_mode":"default","source":"startup","model":"claude-opus-5"}' | head -c 260; echo
node "$PLUG/hooks/dist/prompt-recall.mjs" <<< '{"hook_event_name":"UserPromptSubmit","session_id":"s-live","prompt_id":"p-live","cwd":"'"$SCRATCH"'","transcript_path":"'"$SCRATCH"'/t.jsonl","permission_mode":"default","prompt":"why is the ingest job stuck in queued and how do I unstick it?"}'
node "$PLUG/hooks/dist/stage-prompt.mjs" <<< '{"hook_event_name":"UserPromptSubmit","session_id":"s-live","prompt_id":"p-live","cwd":"'"$SCRATCH"'","transcript_path":"'"$SCRATCH"'/t.jsonl","permission_mode":"default","prompt":"why is the ingest job stuck in queued and how do I unstick it?"}'
node -e 'console.log(JSON.stringify(JSON.parse(require("node:fs").readFileSync(process.env.DATA+"/runs/cc-hs4-live/turns/p-live.json","utf8")),null,1))'
```

**Expect** — the preamble is truncated to its first 260 bytes; `no_evidence` is correct here,
see below:

```
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"# Mubit memory is active\n\nRun: cc-hs4-live (hosted)\nRelevant memory is injected automatically before each of your turns — no need to open a turn by searching for it.\nDo search whe
{"suppressOutput":true}
{"suppressOutput":true}
{
 "prompt_id": "p-live",
 "recalled": [],
 "recall": {
  "at": 1787152883839,
  "rung": 1,
  "sources": 0,
  "tokens": 0,
  "chars": 0,
  "dropped": 0,
  "empty_reason": "no_evidence",
  "terms": []
 },
 "session_id": "s-live",
 "started_at": 1787152883839,
 "prompt": "why is the ingest job stuck in queued and how do I unstick it?"
}
```

Read `"rung": 1` and `"empty_reason": "no_evidence"` first: recall really did dial the hosted
endpoint and the endpoint really did answer — with nothing, because `$SCRATCH` is a two-commit
throwaway repo with no memory attached to it. That is the correct answer, and it is also why
the two reference ids below are seeded rather than recalled: **row 1 of the outcome table
(`nothing_injected`) already suppresses an empty `recalled[]`**, so a genuinely empty turn
cannot demonstrate row 2.

**`MUBIT_CC_RECALL_BUDGET_MS` is raised to 6000 for a reason.** Recall's default budget is
1500 ms, which is tuned for a hook the user is waiting on, not for a runbook. Measured here,
`api.mubit.ai` answered this query in **838 ms** — comfortably inside the default — but a
*local* server on this machine takes 1.4–2.3 s and would blow it. If your `recall` block comes
back with `"rung": 0` and an `empty_reason` of `budget`, that is the deadline and not the
plugin: raise the budget and re-run. The number is in the marker, `last recall … ms`.

```bash
node -e 'const fs=require("node:fs"),p=process.env.DATA+"/runs/cc-hs4-live/turns/p-live.json";
const t=JSON.parse(fs.readFileSync(p,"utf8")); t.recalled=["ref_rule_1","ref_lesson_1"];
fs.writeFileSync(p,JSON.stringify(t));'

node "$PLUG/hooks/dist/capture.mjs" --stop-failure <<< '{"hook_event_name":"StopFailure","session_id":"s-live","prompt_id":"p-live","cwd":"'"$SCRATCH"'","transcript_path":"'"$SCRATCH"'/t.jsonl","permission_mode":"default","error":"rate_limit","error_details":"Rate limit exceeded.","last_assistant_message":"Let me look at the ingest qu"}'

node "$PLUG/hooks/dist/drain.mjs" --with-outcome p-live <<< '{"hook_event_name":"Stop","session_id":"s-live","prompt_id":"p-live","cwd":"'"$SCRATCH"'","transcript_path":"'"$SCRATCH"'/t.jsonl","permission_mode":"default"}'
grep -a "outcome\|drain:" "$DATA/logs/mubit-cc.log" | tail -3
```

**Expect**

```
{"suppressOutput":true}
{"ts":"2026-08-19T15:21:37.091Z","level":"debug","msg":"drain: no outcome to post (api_failed)","run_id":"cc-hs4-live","prompt_id":"p-live"}
{"ts":"2026-08-19T15:21:37.099Z","level":"info","msg":"drain: 0 item(s) in 0 batch(es)","run_id":"cc-hs4-live","rejected":0,"ms":41}
```

Read **`no outcome to post (api_failed)`** first. That is the decision naming itself, from the
shipped bundle, with `MUBIT_ENDPOINT=https://api.mubit.ai` and a live key in the environment —
the drain reached the point of dialling and chose not to. `api_failed` is a distinct reason
from `nothing_injected` and `already_sent`, so a reader of the log is never left guessing which
silence they are looking at.

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run cc-hs4-live --last 40 | head -5
```

**Expect**

```
run cc-hs4-live   hosted   ● ready   (data: /tmp/mubit-hs4-live)

prompt   when      rung  src  tok  chars  drop  empty_reason  used(m/c)  outcome
p-live…  16:21:23     1    0    0      0     0  no_evidence   —          api:rate_limit
```

`● ready` is the hosted marker: the run registered against `api.mubit.ai` and the breaker is
closed. Read that together with `api:rate_limit` — a healthy endpoint, a turn with no outcome,
and the reason on the same line.

---

## §9 — Teardown

```bash
pkill -f "$SCRATCH/recorder.mjs" 2>/dev/null
rm -rf /tmp/mubit-hs4 /tmp/mubit-hs4-data /tmp/mubit-hs4-live \
       /tmp/mubit-hs4-tax /tmp/mubit-hs4-sig /tmp/mubit-hs4-{a,b,c,d}
unset -f mark since
unset PLUG SCRATCH DATA MUBIT_CC_DATA_DIR MUBIT_CC_RUN_STRATEGY MUBIT_CC_RUN_ID \
      MUBIT_CC_LOG_LEVEL MUBIT_CC_RECALL_BUDGET_MS MUBIT_ENDPOINT MUBIT_API_KEY
echo "clean"
```

**Expect**

```
clean
```

The hosted side keeps one registered run, `cc-hs4-live`, with no items, no outcomes and no
lessons. Nothing else was written to `api.mubit.ai`.

---

## What this runbook does not prove

Stated plainly, because a guide that only lists its successes is not evidence:

- **A real `StopFailure` from the host was never observed.** Every payload here is hand-fed.
  What §1 establishes from the binary is that the event exists, fires instead of `Stop`, and
  carries `error`; what §2–§8 establish is that the plugin does the right thing with it. The
  join between the two — the host actually invoking this registration during a throttled turn —
  needs a genuine API failure and cannot be scheduled.
- **The counterfactual is not measured.** "Reinforcement quality improves" is the reason for
  the change and is not something this runbook can show. What it shows is that the noisy input
  no longer reaches the wire.
- **`account_on_hold` was not observed from a live host.** §4 feeds the value by hand. Whether
  `fOr()` is on for this account is not something the plugin can see, which is the argument for
  the empty matcher rather than a demonstration of it.
