# Manual test — all seven hook-surface changes, one pass

Everything merged into `feat/hook-surface-followups` (HS-1 … HS-7), proved in about **ten
minutes** against a local stub. Seven per-ticket runbooks sit beside this one and go much
deeper; this is the fast pass that touches every change once.

Executed end to end on **2026-08-19** against the bundles in this worktree
(`MUBIT_CC_BUILD_SKIP_SERVER=1 npm run build`). Every **Expect** block is a transcript, not a
prediction. Numbers marked *(varies)* differ on your machine; everything else should match.

**Time:** ~10 minutes.
**Destroys:** nothing. Everything lives in four `/tmp` directories removed in §8. Your
installed plugin, its data directory and your Mubit memory are never touched — **this whole
file is offline**, against a stub on loopback. Nothing dials `api.mubit.ai`.

Each section runs the **shipped `hooks/dist/*.mjs`**, which is what Claude Code actually
executes — not `hooks/src`.

---

## §0 — Setup, one paste

Two traps decide whether the rest of this works.

**Trap 1 — your shell may already point at a real Mubit.** Config precedence puts `MUBIT_*`
env above `credentials.json`, so a leftover `MUBIT_ENDPOINT` silently redirects everything
below to a real instance. §0 pins every variable explicitly, but check first:

```bash
env | grep -iE '^(MUBIT|CLAUDE_PLUGIN)' | sed 's/\(MUBIT_API_KEY=.\{0,6\}\).*/\1…/' | sort
```

**Expect nothing at all.** If something prints, open a clean shell:
`env -u MUBIT_ENDPOINT -u MUBIT_API_KEY -u MUBIT_CC_DATA_DIR -u CLAUDE_PLUGIN_ROOT zsh`

**Trap 2 — do not truncate the stub log.** The stub holds a write offset, so `: > stub.log`
leaves a NUL-padded hole and your greps silently miss lines. The `mark`/`since` helpers below
read from a byte offset instead. This bites, and it looks exactly like "the hook dialled
nothing".

Now paste this whole block:

```bash
export PLUG=/Users/eldaru/Mubit/hook-surface/integrations/claude-code
export SCRATCH=/tmp/mubit-all
export DATA=/tmp/mubit-all-data

rm -rf "$SCRATCH" "$DATA" && mkdir -p "$SCRATCH" "$DATA"
cd "$SCRATCH" && git init -q && echo "# scratch" > README.md
git add -A && git -c user.email=you@example.com -c user.name=you commit -qm init

# pin everything — never rely on the ambient environment
export MUBIT_CC_DATA_DIR="$DATA"
export MUBIT_ENDPOINT=http://127.0.0.1:3991
export MUBIT_API_KEY=mbt_stub_key
export MUBIT_CC_RUN_STRATEGY=static
export MUBIT_CC_RUN_ID=cc-all-demo
export CLAUDE_PROJECT_DIR="$SCRATCH"
export S=b1111111-2222-3333-4444-555555555555

# read the stub's request log from a byte mark, never by truncating it
mark()  { MARK=$(wc -c < "$SCRATCH/stub.log"); }
since() { tail -c +$((MARK+1)) "$SCRATCH/stub.log" | grep -o '[A-Z]* /v2/[a-z/]*' | sed 's/^/  /'; }

# payload helpers — the field names are the host's own
P()   { echo "{\"session_id\":\"$S\",\"transcript_path\":\"$SCRATCH/t.jsonl\",\"cwd\":\"$SCRATCH\",\"prompt_id\":\"$1\",\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"why is the ingest job stuck in queued?\"}"; }
SUB() { echo "{\"session_id\":\"$S\",\"transcript_path\":\"$SCRATCH/t.jsonl\",\"cwd\":\"$SCRATCH\",\"prompt_id\":\"p-1\",\"agent_id\":\"ab55bb82d19855fbc\",\"agent_type\":\"$1\",\"hook_event_name\":\"SubagentStart\"}"; }
PT()  { echo "{\"session_id\":\"$S\",\"transcript_path\":\"$SCRATCH/t.jsonl\",\"cwd\":\"$SCRATCH\",\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"$1\"}}"; }

echo "plugin   $PLUG"
echo "data     $DATA"
echo "endpoint $MUBIT_ENDPOINT"
```

**Expect**

```
plugin   /Users/eldaru/Mubit/hook-surface/integrations/claude-code
data     /tmp/mubit-all-data
endpoint http://127.0.0.1:3991
```

Now the stub Mubit. Memories are paragraph-length on purpose — a real lesson is a paragraph,
and that is what makes the repeat in §3 expensive enough to measure.

```bash
cat > "$SCRATCH/stub.mjs" <<'EOF'
import { createServer } from 'node:http';
const EV = (reference_id, entry_type, content, score) => ({
  id: reference_id, reference_id, entry_type, content, score, source: 'agent',
  run_id: 'stub', metadata_json: '{}', retrieval_mode: 'semantic_search',
  referenceable: true, origin_entry_type: '', is_stale: false, superseded_by: '',
  explain_info: '', knowledge_confidence: 0.5,
});
const evidence = [
  EV('ref_rule_1', 'rule',
    'Never force-push to main. The branch is protected and the push is rejected by the server, '
    + 'but only after the local history has already been rewritten, so the working copy and the '
    + 'remote disagree and the next pull produces a merge that looks like a conflict with '
    + 'yourself. Open a pull request instead; if history genuinely has to change, coordinate it '
    + 'and let an admin lift protection for the window.', 0.91),
  EV('ref_lesson_1', 'lesson',
    'Ingest returns when the job is queued, not when the document is stored. A caller that '
    + 'treats the 200 as durable will read its own write back as missing and retry forever, '
    + 'which is how the duplicate-document incident started. Poll the job id until it reports '
    + 'indexed, and treat any status other than indexed as not-yet-visible rather than failed.', 0.84),
  EV('ref_fact_1', 'fact',
    'IngestAccepted.status is always the literal string "queued" on success and is never '
    + '"stored"; the storage transition is only observable through the job endpoint, which is '
    + 'why the status field alone cannot be used as a completion signal.', 0.55),
];
const DELAY = Number(process.env.STUB_DELAY_MS || 0);
createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    process.stderr.write(`${req.method} ${req.url}\n`);
    if (req.url === '/v2/core/health') { res.writeHead(200); return res.end('OK'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    const body = JSON.stringify(req.url === '/v2/control/query'
      ? { final_answer: '', confidence: 0.6, mode: 'direct_bypass', degraded: false,
          consulted_runs: [], routing_summary: 'direct_bypass', signals: {}, citations: [],
          evidence }
      : req.url === '/v2/control/lessons' ? { lessons: [] } : { success: true });
    setTimeout(() => res.end(body), DELAY);
  });
}).listen(Number(process.env.STUB_PORT || 3991), '127.0.0.1',
  () => process.stderr.write(`stub on :${process.env.STUB_PORT || 3991}\n`));
EOF

(cd "$SCRATCH" && node stub.mjs >/dev/null 2>"$SCRATCH/stub.log" &) ; sleep 1
curl -s http://127.0.0.1:3991/v2/core/health; echo " <- stub up"
```

**Expect**

```
OK <- stub up
```

If the port is busy from an earlier run: `lsof -ti :3991 | xargs kill -9`. A stale stub is the
single most common cause of a confusing red below — `pkill -f stub.mjs` does **not** reliably
free it.

---

## §1 — HS-2: the MCP server now ships `instructions`

**Claim:** a model that never saw the SessionStart preamble — including every subagent — is
still told when to reach for Mubit. Under tool search this string plus the bare tool names is
all that loads.

```bash
cat > "$SCRATCH/mcp-probe.mjs" <<'EOF'
import { spawn } from 'node:child_process';
const c = spawn(process.execPath, [process.argv[2]], { stdio: ['pipe','pipe','pipe'] });
c.stdin.write(JSON.stringify({ jsonrpc:'2.0', id:1, method:'initialize',
  params:{ protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{name:'probe',version:'0'} } })+'\n');
let buf='';
c.stdout.on('data', d => { buf += d;
  for (let i=buf.indexOf('\n'); i>=0; i=buf.indexOf('\n')) {
    const line=buf.slice(0,i).trim(); buf=buf.slice(i+1); if(!line) continue;
    const m=JSON.parse(line);
    if (m.id===1) {
      const s=m.result?.instructions;
      console.log('serverInfo    ', m.result?.serverInfo?.name, m.result?.serverInfo?.version);
      console.log('instructions  ', typeof s==='string' ? `${s.length} chars` : '(FIELD ABSENT)');
      if (s) console.log('first line    ', s.split('\n')[0]);
      c.kill(); process.exit(0);
    }
  }
});
setTimeout(()=>{ console.log('TIMEOUT'); c.kill(); process.exit(1); }, 8000);
EOF

node "$SCRATCH/mcp-probe.mjs" "$PLUG/mcp/dist/index.js"
```

**Expect**

```
serverInfo     mubit-memory 0.10.0
instructions   1206 chars
first line     Mubit is this project's persistent memory: lessons, decisions and past work carried over from earlier sessions.
```

Read `instructions` first. `(FIELD ABSENT)` means the launcher's stdout guard did not install
before the server imported — the whole ticket. The vendored server cannot set this field
itself, so the launcher fills it in on the outbound `initialize` frame.

---

## §2 — HS-1: a forked session gets memory

**Claim:** a fork heartbeats like a resume instead of re-registering as a brand-new session.

```bash
mkdir -p "$DATA/sessions"
cat > "$DATA/sessions/$S.json" <<EOF
{"run_id":"cc-all-demo","agent_id":"claude-code","strategy":"static","project_dir":"$SCRATCH",
 "created_at":1755500000000,"last_seen_at":1755500000000,"mode":"local","clear_count":0,
 "endpoint_hash":"deadbeefcafe"}
EOF

mark
echo "{\"session_id\":\"$S\",\"transcript_path\":\"$SCRATCH/t.jsonl\",\"cwd\":\"$SCRATCH\",\"hook_event_name\":\"SessionStart\",\"source\":\"fork\"}" \
  | node "$PLUG/hooks/dist/session-start.mjs" > "$SCRATCH/hs1.json"
echo "exit=$?"; sleep 0.5; since
```

**Expect**

```
exit=0
  GET /v2/core/health
  POST /v2/control/agents/heartbeat
  POST /v2/control/lessons
```

Read the middle line. **`heartbeat`, not `register`** — that is the fix. Before it, `fork` did
not match the SessionStart matcher at all and the hook never ran; with the matcher widened, a
fork still must not re-announce an agent that never left.

Confirm the block reached the model:

```bash
node -e "console.log(require('$SCRATCH/hs1.json').hookSpecificOutput.additionalContext.split('\n').slice(0,3).join('\n'))"
```

**Expect**

```
# Mubit memory is active

Run: cc-all-demo (hosted)
```

---

## §3 — HS-3: the same memory is paid for once *(the headline)*

**Claim:** a lesson relevant for twenty prompts costs full price once and a pointer thereafter,
**without** dropping out of attribution.

```bash
for n in 1 2 3; do
  P "p-$n" | node "$PLUG/hooks/dist/prompt-recall.mjs" > "$SCRATCH/r$n.json" 2>/dev/null
  node -e "console.log('turn $n  '+require('$SCRATCH/r$n.json').systemMessage)"
done
node -e "
const a=require('$SCRATCH/r1.json').hookSpecificOutput.additionalContext.length;
const b=require('$SCRATCH/r3.json').hookSpecificOutput.additionalContext.length;
console.log('block chars: turn1='+a+'  turn3='+b+'  drop='+Math.round((1-b/a)*100)+'%');"
```

**Expect**

```
turn 1  mubit: 3 memories · 257 tok · 67ms
turn 2  mubit: 3 memories · 72 tok · 66ms
turn 3  mubit: 3 memories · 72 tok · 76ms
block chars: turn1=1226  turn3=644  drop=47%
```

*(the `ms` figures vary)*

Read **`3 memories` on every line** before you read the tokens. The count never falls — the
saving is not fewer memories, it is the same memories rendered shorter. **257 → 72 tokens is a
72% drop**, and it holds flat from turn 2 onward.

Now look at what a repeat actually renders as:

```bash
node -e "console.log(require('$SCRATCH/r3.json').hookSpecificOutput.additionalContext)"
```

**Expect**

```
<mubit-memory run="cc-all-demo" sources="3" tokens="72">
Recalled from memory of earlier work — it may be incomplete or out of date, so verify against the code before relying on it.
A line marked "(seen earlier)" was injected in full earlier in this conversation and is repeated here only as a reference; ask mubit_dereference for its text.

## Active rules
- (seen earlier) ref_rule_1 — Never force-push to main…

## Lessons
- (seen earlier) ref_lesson_1 — Ingest returns when the job is queued, not when the document is…

## Facts
- (seen earlier) ref_fact_1 — IngestAccepted.status is always the literal string "queued" on s…
</mubit-memory>
```

`sources="3"` is the load-bearing attribute: a degraded entry is **still a source**, so `Stop`
can still credit it. Dropping repeats would have broken attribution for exactly the memories
that are helping most.

The roll-up driving it:

```bash
node -e "const s=require('$DATA/runs/cc-all-demo/seen.json');
for (const [k,v] of Object.entries(s.refs)) console.log('  '+k+'  seen '+v.count+'x')"
```

**Expect**

```
  ref_rule_1  seen 3x
  ref_lesson_1  seen 3x
  ref_fact_1  seen 3x
```

**Compaction resets it** — after a compaction the model has not seen any of it:

```bash
echo "{\"session_id\":\"$S\",\"transcript_path\":\"$SCRATCH/t.jsonl\",\"cwd\":\"$SCRATCH\",\"hook_event_name\":\"PostCompact\",\"trigger\":\"auto\"}" \
  | node "$PLUG/hooks/dist/checkpoint.mjs" --post >/dev/null 2>&1
test -f "$DATA/runs/cc-all-demo/seen.json" && echo "seen.json still there — NOT cleared" || echo "seen.json cleared — the next block re-expands in full"
```

**Expect**

```
seen.json cleared — the next block re-expands in full
```

---

## §4 — HS-7: a rule surfaces at the tool call, and denies nothing

**Claim:** a Mubit `rule` can warn at the moment it applies, and this stage cannot block
anything.

The store was filled by §3 — `pre-tool` never dials, so its only supply is a hook that already
paid for a round trip:

```bash
node -e "const r=require('$DATA/runs/cc-all-demo/rules.json');
console.log(r.rules.length+' rule(s): '+r.rules.map(x=>x.ref).join(', '))"
```

**Expect**

```
1 rule(s): ref_rule_1
```

Default-off, then opted in:

```bash
echo "flag OFF:"; PT 'git push --force origin main' | node "$PLUG/hooks/dist/pre-tool.mjs"; echo
echo "flag ON:"
PT 'git push --force origin main' | MUBIT_CC_PRE_TOOL_WARNINGS=1 node "$PLUG/hooks/dist/pre-tool.mjs" \
 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
   const h=(JSON.parse(s||'{}').hookSpecificOutput)||{};
   console.log('  hookEventName      '+h.hookEventName);
   console.log('  additionalContext  '+(h.additionalContext||'').length+' chars');
   console.log('  permissionDecision '+('permissionDecision' in h?'!! PRESENT !!':'absent'));
   console.log('  updatedInput       '+('updatedInput' in h?'!! PRESENT !!':'absent'));})"
```

**Expect**

```
flag OFF:
{"suppressOutput":true}

flag ON:
  hookEventName      PreToolUse
  additionalContext  694 chars
  permissionDecision absent
  updatedInput       absent
```

Read the last two lines first — **that is the safety property.** `permissionDecision` has four
values (`allow`, `deny`, `ask`, `defer`) and `updatedInput` rewrites a tool's arguments
outright; this stage emits neither, on any path. Exit code 0 matters just as much: the host
**blocks the tool call on exit code 2**.

And what the model sees:

```bash
PT 'git push --force origin main' | MUBIT_CC_PRE_TOOL_WARNINGS=1 node "$PLUG/hooks/dist/pre-tool.mjs" \
 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).hookSpecificOutput.additionalContext))"
```

**Expect**

```
<mubit-rules matched="1">
Standing rules from Mubit memory that mention this command. This is a reminder, not a permission check — nothing here has blocked or changed the call, and the rules may be out of date. Judge whether each one applies before acting on it.

- [ref_rule_1] Never force-push to main. The branch is protected and the push is rejected by the server, but only after the local history has already been rewritten, so the working copy and the remote disagree and the next pull produces a merge that looks like a conflict with yourself. Open a pull request instead; if history genuinely has to change, coordinate it and let an admin lift protection for the window.
</mubit-rules>
```

A non-matching command says nothing at all:

```bash
PT 'ls -la' | MUBIT_CC_PRE_TOOL_WARNINGS=1 node "$PLUG/hooks/dist/pre-tool.mjs"; echo
```

**Expect**

```
{"suppressOutput":true}
```

> **This is a guardrail, not a security boundary.** In the host's own words the `if` filter
> "fails open, running your hook regardless of pattern, when the Bash command can't be
> parsed… use the permission system rather than a hook to enforce a hard allow or deny."

---

## §5 — HS-5: a subagent starts with memory

**Claim:** a subagent gets injected memory on a tighter budget — and the recall agent itself
does not recurse.

A subagent's query comes from the **parent's staged turn**, so stage it the way a real
`UserPromptSubmit` does:

```bash
P p-1 | node "$PLUG/hooks/dist/stage-prompt.mjs" >/dev/null 2>&1

read1() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const h=(JSON.parse(s||'{}').hookSpecificOutput)||{};
  const b=h.additionalContext||'';
  console.log('  hookEventName '+(h.hookEventName||'(absent — suppressed)'));
  console.log('  block         '+(b?b.length+' chars':'(none)'));})"; }

echo "Explore:";      SUB Explore      | node "$PLUG/hooks/dist/subagent-start.mjs" | read1
echo "mubit-recall:"; SUB mubit-recall | node "$PLUG/hooks/dist/subagent-start.mjs" | read1
echo "sub-run lane:"; ls "$DATA/runs/cc-all-demo/subagents/"
```

**Expect**

```
Explore:
  hookEventName SubagentStart
  block         1405 chars
mubit-recall:
  hookEventName (absent — suppressed)
  block         (none)
sub-run lane: 
cc-all-demo-sub-ab55bb82d198.json
```

Two things to read. **`mubit-recall` gets nothing** — it exists to run recall, so injecting into
it would be a loop. And the **sub-run lane file** is HS-5's isolation: a fan-out of six shares
one parent `prompt_id`, and this is what separates their evidence.

This is the ticket's whole value case: `UserPromptSubmit` never fires for a subagent, so
without this hook a subagent starts with no project memory at all.

---

## §6 — HS-4: a turn the API killed posts no outcome

**Claim:** a turn that died on `rate_limit` never reaches `record_outcome` — from **both**
hooks that post one.

`StopFailure` **fires instead of `Stop`**, so nothing else ever closes these turns:

```bash
mark
echo "{\"session_id\":\"$S\",\"transcript_path\":\"$SCRATCH/t.jsonl\",\"cwd\":\"$SCRATCH\",\"prompt_id\":\"p-1\",\"hook_event_name\":\"StopFailure\",\"error\":\"rate_limit\",\"error_details\":\"would exceed your organization's rate limit\",\"last_assistant_message\":\"Let me check the queue\"}" \
  | node "$PLUG/hooks/dist/capture.mjs" --stop-failure
echo " <- stdout"; sleep 0.4; echo "dialled:"; since
node -e "const t=require('$DATA/runs/cc-all-demo/turns/p-1.json');
console.log('api_error       '+t.api_error);
console.log('outcome_pending '+t.outcome_pending);"
```

**Expect**

```
{"suppressOutput":true} <- stdout
dialled:
api_error       rate_limit
outcome_pending true
```

Two reads. Stdout is `{"suppressOutput":true}` and **nothing else** — `StopFailure` is absent
from the host's accepted event list, so a `hookSpecificOutput` here would be rejected. And
**nothing was dialled**: this hook writes one file and never touches the network.

Now the A/B that matters — the same turn, with and without the mark, through both consumers:

```bash
seed(){ rm -rf "$1"; mkdir -p "$1/runs/cc-hs4/turns" "$1/runs/cc-hs4/spool"
  node -e 'const fs=require("node:fs");
  const t={prompt:"why is the ingest job stuck in queued?",prompt_id:"p-hs4",session_id:"s-hs4",
    started_at:Date.now()-30000,ended_at:Date.now()-1000,recalled:["ref_rule_1","ref_lesson_1"],
    outcome_pending:true, ...JSON.parse(process.argv[2])};
  fs.writeFileSync(process.argv[1]+"/runs/cc-hs4/turns/p-hs4.json",JSON.stringify(t));
  fs.writeFileSync(process.argv[1]+"/runs/cc-hs4/spool/1765000000000-a000.json",JSON.stringify({
    item_id:"cc-hs4-1",content_type:"text",text:"Bash(command=ls) -> README.md",intent:"trace",
    importance:"low",source:"agent",occurrence_time:1765000000,env_tags:["tool:claude-code"],
    metadata_json:"{}"}));' "$1" "$2"; }

END='{"hook_event_name":"SessionEnd","session_id":"s-hs4","cwd":"'"$SCRATCH"'","transcript_path":"/dev/null","permission_mode":"default","reason":"exit"}'
STOP='{"hook_event_name":"Stop","session_id":"s-hs4","prompt_id":"p-hs4","cwd":"'"$SCRATCH"'","transcript_path":"/dev/null","permission_mode":"default"}'

for case in a:session-end:'{}' b:session-end:'{"api_error":"rate_limit"}' \
            c:drain:'{}'       d:drain:'{"api_error":"rate_limit"}'; do
  name=${case%%:*}; rest=${case#*:}; hook=${rest%%:*}; keys=${rest#*:}
  seed "/tmp/mubit-hs4-$name" "$keys"; mark
  if [ "$hook" = drain ]; then
    MUBIT_CC_DATA_DIR="/tmp/mubit-hs4-$name" MUBIT_CC_RUN_ID=cc-hs4 \
      node "$PLUG/hooks/dist/drain.mjs" --with-outcome p-hs4 <<< "$STOP" >/dev/null 2>&1
  else
    MUBIT_CC_DATA_DIR="/tmp/mubit-hs4-$name" MUBIT_CC_RUN_ID=cc-hs4 \
      node "$PLUG/hooks/dist/session-end.mjs" <<< "$END" >/dev/null 2>&1
  fi
  sleep 0.5; echo "=== $name — $hook ${keys} ==="; since
done
```

**Expect**

```
=== a — session-end {} ===
  POST /v2/control/ingest
  POST /v2/control/outcome
  POST /v2/control/reflect
  POST /v2/control/agents/heartbeat
=== b — session-end {"api_error":"rate_limit"} ===
  POST /v2/control/ingest
  POST /v2/control/reflect
  POST /v2/control/agents/heartbeat
=== c — drain {} ===
  POST /v2/control/ingest
  POST /v2/control/outcome
=== d — drain {"api_error":"rate_limit"} ===
  POST /v2/control/ingest
```

Read the **missing `POST /v2/control/outcome` in b and d**. One key on the turn file, both
consumers, one line of difference — and the evidence still ingests either way, because the
work happened even though the turn died.

---

## §7 — HS-6: recall stops blocking the prompt *(opt-in)*

**Claim:** with `recallAsync` on, the prompt never waits on recall — and with it off, nothing
changes for anyone.

A second stub, deliberately slow (2.5 s, past the 1500 ms default budget):

```bash
(STUB_PORT=3992 STUB_DELAY_MS=2500 node "$SCRATCH/stub.mjs" >/dev/null 2>"$SCRATCH/slow.log" &)
sleep 1; curl -s http://127.0.0.1:3992/v2/core/health; echo " <- slow stub up"
```

**Expect** `OK <- slow stub up`

```bash
export MUBIT_ENDPOINT=http://127.0.0.1:3992 MUBIT_CC_RUN_ID=cc-async
S2=c2222222-3333-4444-5555-666666666666
Q(){ echo "{\"session_id\":\"$S2\",\"transcript_path\":\"$SCRATCH/t.jsonl\",\"cwd\":\"$SCRATCH\",\"prompt_id\":\"$1\",\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"why is the ingest job stuck in queued?\"}"; }

echo "=== BLOCKING (default) ==="
D=/tmp/mubit-async-off; rm -rf $D; mkdir -p $D
s=$(date +%s%N); Q q-1 | MUBIT_CC_DATA_DIR=$D node "$PLUG/hooks/dist/prompt-recall.mjs" > "$SCRATCH/off.json" 2>/dev/null; e=$(date +%s%N)
echo "  wall $(( (e-s)/1000000 )) ms -> $(node -e "console.log(require('$SCRATCH/off.json').systemMessage||'(no block injected)')")"

echo "=== ASYNC (recallAsync=1) ==="
D=/tmp/mubit-async-on; rm -rf $D; mkdir -p $D
for n in 1 2; do
  s=$(date +%s%N); Q q-$n | MUBIT_CC_DATA_DIR=$D MUBIT_CC_RECALL_ASYNC=1 \
    node "$PLUG/hooks/dist/prompt-recall.mjs" > "$SCRATCH/on$n.json" 2>/dev/null; e=$(date +%s%N)
  echo "  prompt $n: wall $(( (e-s)/1000000 )) ms -> $(node -e "console.log(require('$SCRATCH/on$n.json').systemMessage||'(no block yet — refresh spawned)')")"
  if [ "$n" = 1 ]; then sleep 4; fi
done
```

**Expect**

```
=== BLOCKING (default) ===
  wall 1628 ms -> (no block injected)
=== ASYNC (recallAsync=1) ===
  prompt 1: wall 137 ms -> (no block yet — refresh spawned)
  prompt 2: wall 184 ms -> mubit: 3 memories · 257 tok · 12ms
```

*(all four `ms` figures vary)*

Read the two wall times. Blocking spends **1.6 s and injects nothing** — it hit the budget and
gave up. Async returns in **~140 ms** and the block that same slow call produced arrives on the
**next** prompt. That is the trade: one turn of staleness, never blocking, never timing out.

This is why nobody should have to discover `MUBIT_CC_RECALL_BUDGET_MS` by hand.

`recallAsync` is **default false**, which §3 already proved — every number there came from the
blocking path with the flag unset.

---

## §8 — Teardown

```bash
lsof -ti :3991 -ti :3992 2>/dev/null | xargs kill -9 2>/dev/null
rm -rf /tmp/mubit-all /tmp/mubit-all-data /tmp/mubit-hs4-* /tmp/mubit-async-o*
ls -d /tmp/mubit-all /tmp/mubit-all-data 2>/dev/null | wc -l | xargs echo 'dirs left:'
```

**Expect**

```
dirs left: 0
```

Your installed plugin and its data directory were never touched, and nothing in this file
reached `api.mubit.ai`.

---

## What this file does *not* prove

Deliberate limits, so a green run is not read as more than it is:

- **No live endpoint.** Everything here is a loopback stub. The per-ticket runbooks each carry
  a marked live section against `https://api.mubit.ai`.
- **No real Claude Code session.** Payloads are piped in by hand. That exercises the whole
  client stack but not the host's own dispatch — whether the host *calls* these hooks, with
  these matchers, is what a real session adds. Fork, a subagent fan-out, a compaction and a
  `Bash(rm *)` call in one live session is the remaining gap.
- **No real `StopFailure`.** §6 hand-feeds the payload. That the event exists, fires instead of
  `Stop`, and carries `error` comes from the host binary's own registry; joining that to §6
  needs a genuine API failure, which cannot be scheduled.
- **Not that a pointer works as well as full text.** §3 measures tokens, not comprehension.
  Whether the model does as well from `(seen earlier) ref_rule_1 — …` as from the paragraph is
  a task-benchmark question this file cannot answer.
