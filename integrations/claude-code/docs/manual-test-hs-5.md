# Manual test — HS-5, `SubagentStart`

Prove two things a user cannot see from the outside:

1. **A subagent starts with memory.** It did not before. `UserPromptSubmit` — the only hook
   that ever injected a recall block — does not fire for a subagent, so the whole recall path
   was inert inside the Agent tool.
2. **Its evidence is distinguishable from its siblings'.** A fan-out of six used to leave six
   streams of evidence on one indistinguishable turn.

Executed on **2026-08-19** against **Claude Code 2.1.235** and the plugin at
`$HOME/src/claude-plugins/integrations/claude-code`, branch `feat/subagent-start`.
The **Expect** blocks are transcripts, not predictions. Where a number will differ on your
machine, the text says so.

§1 and §8 need a live Claude Code and the hosted Mubit. **§2–§7 are offline** and run against a
30-line stub you paste in §0 — they are the deterministic core and still prove the mechanism
when `api.mubit.ai` is slow or down.

**Time:** ~15 minutes for §0–§7, ~10 more for §1 and §8.
**Destroys:** nothing outside `/tmp/mubit-hs5*`. §8 writes **one** labelled item into a
throwaway run (`cc-hs5-live`) on your hosted instance; nothing else touches real memory.

---

## §0 — Setup, one paste

Two traps decide whether the rest of this file works, and both bite silently. They are the same
two `manual-test-0.10.0.md` §0 documents, so read that section first if you have not:

- **The data directory is not where the docs say.** Pin it. `MUBIT_CC_DATA_DIR` has the highest
  precedence of any data-dir input (`lib/state.mjs`).
- **Your shell may already point at a different Mubit.** A `MUBIT_ENDPOINT` left exported from
  an earlier local-server session beats the hosted key you signed in with, silently.

```bash
env | grep -iE '^(MUBIT|CLAUDE_PLUGIN)' | sort
```

**Expect nothing at all.** Anything printed there is already steering the plugin.

Now paste this whole block into the terminal you will use for the rest of the run:

```bash
export PLUG=$HOME/src/claude-plugins/integrations/claude-code
export DATA=/tmp/mubit-hs5-data
export SCRATCH=/tmp/mubit-hs5

rm -rf "$SCRATCH" "$DATA" && mkdir -p "$SCRATCH" "$DATA"
cd "$SCRATCH" && git init -q && echo "# scratch" > README.md
git add -A && git -c user.email=you@example.com -c user.name=you commit -qm init

# pin everything explicitly — never rely on the ambient environment
export MUBIT_CC_DATA_DIR="$DATA"
export MUBIT_ENDPOINT=http://127.0.0.1:3987
export MUBIT_API_KEY=mbt_stub_key
export MUBIT_CC_RUN_STRATEGY=static
export MUBIT_CC_RUN_ID=cc-hs5-demo
export CLAUDE_PROJECT_DIR="$SCRATCH"

echo "plugin   $PLUG"
echo "data     $DATA"
echo "endpoint $MUBIT_ENDPOINT"
```

**Expect**

```
plugin   $HOME/src/claude-plugins/integrations/claude-code
data     /tmp/mubit-hs5-data
endpoint http://127.0.0.1:3987
```

> **Work in `$SCRATCH`, never in a Mubit repo.** Self-reference suppression drops any capture
> whose text mentions `mubit`. In a Mubit checkout the capture path looks broken and is working
> exactly as designed.

Now the offline stub. It answers `POST /v2/control/query` with fixed evidence — no network, no
key, no LLM, and byte-identical on every run, which is what makes §2–§7 deterministic.
`STUB_FAT=1` swaps three short entries for twelve long ones, so a token ceiling actually binds
and you can watch it bind.

```bash
cat > "$SCRATCH/stub.mjs" <<'EOF'
import { createServer } from 'node:http';
const EV = (reference_id, entry_type, content, score) => ({
  id: reference_id, reference_id, entry_type, content, score, source: 'agent',
  run_id: 'stub', metadata_json: '{}', retrieval_mode: 'semantic_search',
  referenceable: true, origin_entry_type: '', is_stale: false, superseded_by: '',
  explain_info: '', knowledge_confidence: 0.5,
});
const thin = [
  EV('ref_rule_1', 'rule', 'Ingest returns when queued, not when stored; poll the job.', 0.91),
  EV('ref_lesson_1', 'lesson', 'A job stays queued until indexing completes.', 0.84),
  EV('ref_fact_1', 'fact', 'IngestAccepted.status is always "queued" on success.', 0.55),
];
const fat = Array.from({ length: 12 }, (_, i) => EV(`ref_fat_${i}`,
  i % 2 === 0 ? 'rule' : 'lesson',
  (`Entry ${i}: the ingest endpoint returns before anything is stored, so a caller that `
   + 'treats the response as durable will read its own write back as missing and retry '
   + 'forever. Poll the job id instead. ').repeat(3),
  0.9 - i * 0.01));
createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    process.stderr.write(`${req.method} ${req.url}\n`);
    if (req.url === '/v2/core/health') { res.writeHead(200); return res.end('OK'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/v2/control/query'
      ? { final_answer: '', confidence: 0.6, mode: 'direct_bypass', degraded: false,
          consulted_runs: [], routing_summary: 'direct_bypass', signals: {}, citations: [],
          evidence: process.env.STUB_FAT ? fat : thin }
      : { success: true }));
  });
}).listen(3987, '127.0.0.1', () => process.stderr.write('stub on :3987\n'));
EOF

(cd "$SCRATCH" && node stub.mjs 2>"$SCRATCH/stub.log" &) ; sleep 1
curl -s http://127.0.0.1:3987/v2/core/health; echo
```

**Expect**

```
OK
```

`$SCRATCH/stub.log` is now a request log. Read it whenever a step's claim is "and nothing was
dialled" — that is a claim about this file, not about the hook's stdout.

---

## §1 — The premise, live: `UserPromptSubmit` never fires for a subagent

This is the whole value case, and it is measurable in one run. A shell hook that logs its own
stdin, registered on three events, in a throwaway project with **no MCP servers** so nothing
else interferes.

```bash
S=/tmp/mubit-hs5-spike
rm -rf "$S"; mkdir -p "$S/.claude"
(cd "$S" && git init -q . && echo "# spike" > README.md && git add -A \
   && git -c user.email=e@x -c user.name=x commit -qm init)

cat > "$S/log-hook.sh" <<'EOF'
#!/bin/bash
IN=$(cat)
EV=$(printf '%s' "$IN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).hook_event_name||"?")}catch(e){console.log("?")}})')
{
  echo "===$EV==="
  printf '%s' "$IN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log("FIELDS: "+Object.keys(o).join(", "))})'
} >> "$SPIKE_LOG"
if [ "$EV" = "SubagentStart" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"MUBIT_HS5_TOKEN_4C7E: this text was injected by a SubagentStart hook."}}'
fi
exit 0
EOF
chmod +x "$S/log-hook.sh"

cat > "$S/.claude/settings.json" <<EOF
{ "hooks": {
  "SubagentStart":    [ { "hooks": [ { "type": "command", "command": "$S/log-hook.sh", "timeout": 10 } ] } ],
  "SubagentStop":     [ { "hooks": [ { "type": "command", "command": "$S/log-hook.sh", "timeout": 10 } ] } ],
  "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "$S/log-hook.sh", "timeout": 10 } ] } ]
} }
EOF

export SPIKE_LOG="$S/hooks.log"; : > "$SPIKE_LOG"
(cd "$S" && claude -p --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --permission-mode bypassPermissions \
  'Spawn exactly two general-purpose subagents in parallel, in one message. Give each this identical task: "Search your entire context for the string MUBIT_HS5_TOKEN_4C7E. Report verbatim whether you found it, and if so, describe exactly where it appeared — which message role, what prefix or label preceded it, and whether it was inside the task prompt or a separate message. Do not use any tools." Then report both answers verbatim.' \
  > "$S/answer.txt" 2>&1)

grep -o '===[A-Za-z]*===' "$SPIKE_LOG" | sort | uniq -c
```

**Expect**

```
   2 ===SubagentStart===
   2 ===SubagentStop===
   1 ===UserPromptSubmit===
```

**Read `UserPromptSubmit` first: it is `1`, not `3`.** Two subagents each ran a full turn and
neither produced one — the single event is the parent's own prompt. That is the finding. Without
a `SubagentStart` hook a subagent gets no injected memory at all, not because the budget is
small but because the hook that would have spent it never runs.

Now the payload shape, and one field that is not in it:

```bash
grep -A1 '===SubagentStart===' "$SPIKE_LOG" | grep FIELDS | head -1
grep -A1 '===SubagentStop===' "$SPIKE_LOG"  | grep FIELDS | head -1
```

**Expect**

```
FIELDS: session_id, transcript_path, cwd, prompt_id, agent_id, agent_type, hook_event_name
FIELDS: session_id, transcript_path, cwd, prompt_id, permission_mode, agent_id, agent_type, effort, hook_event_name, stop_hook_active, agent_transcript_path, last_assistant_message, background_tasks, session_crons
```

Two things to read off that pair:

- **`SubagentStart` has no `permission_mode`**, where `SubagentStop` and `UserPromptSubmit` both
  do. A fixture copied from either of those would invent the field. `test/helpers/fixtures.mjs`
  builds `subagentStart` by hand for exactly this reason.
- **`SubagentStart` has no task text.** No `prompt`, no `description` — nothing naming what the
  subagent was asked to do. §4 is about what the hook queries on instead.

Finally, where the injected text lands. Read `$S/answer.txt`; the two subagents reported:

```
- Role/channel: it arrived as a system-role message, distinct from the user turn that
  carried my task.
- Exact prefix/label preceding it: the message opens with the literal text
  `SubagentStart hook additional context: ` and the token follows immediately.
- What else shared that message: the deferred-tool listing and the skills listing. The
  hook text was prepended ahead of both.
```

**The host writes that prefix.** So the plugin's block must not restate it — §3 checks that it
does not.

---

## §2 — A subagent starts with memory

Back in the `$SCRATCH` terminal. First stage a parent turn, because that is where the query
comes from (§4):

```bash
echo '{"session_id":"s-1","prompt_id":"p-1","cwd":"'"$SCRATCH"'","hook_event_name":"UserPromptSubmit","prompt":"why is the ingest job stuck in queued?"}' \
  | node "$PLUG/hooks/dist/stage-prompt.mjs"
cat "$DATA/runs/cc-hs5-demo/turns/p-1.json"
```

**Expect**

```
{"suppressOutput":true}
{"prompt":"why is the ingest job stuck in queued?","prompt_id":"p-1","session_id":"s-1","started_at":1787154537896,"recalled":[]}
```

`started_at` will differ. Now the subagent:

```bash
echo '{"session_id":"s-1","transcript_path":"/dev/null","cwd":"'"$SCRATCH"'","prompt_id":"p-1","agent_id":"ab55bb82d19855fbc","agent_type":"Explore","hook_event_name":"SubagentStart"}' \
  | node "$PLUG/hooks/dist/subagent-start.mjs" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).hookSpecificOutput.additionalContext)})'
```

**Expect**

```
<mubit-memory run="cc-hs5-demo" agent="claude-code-sub-ab55bb82d198" sources="3" tokens="51">
Recalled from memory of earlier work on this project, retrieved against the prompt that spawned you rather than against your own instructions — so it may be incomplete, out of date, or about a different part of the task. Verify against the code before relying on it.

## Active rules
- Ingest returns when queued, not when stored; poll the job.

## Lessons
- A job stays queued until indexing completes.

## Facts
- IngestAccepted.status is always "queued" on success.
</mubit-memory>
```

**Read the `agent=` attribute first.** It is `claude-code-sub-ab55bb82d198`, not `claude-code`:
this block went out under the subagent's own identity, which is what §5 turns into isolation.
`run=` is the **parent's** run — nothing is stored under a sub-run id, so querying one would
return nothing for every subagent, forever.

---

## §3 — What the block does *not* say

```bash
echo '{"session_id":"s-1","transcript_path":"/dev/null","cwd":"'"$SCRATCH"'","prompt_id":"p-1","agent_id":"check01","agent_type":"Explore","hook_event_name":"SubagentStart"}' \
  | node "$PLUG/hooks/dist/subagent-start.mjs" > "$SCRATCH/blk.json"
echo "block bytes:         $(node -e 'console.log((require(process.env.SCRATCH+"/blk.json").hookSpecificOutput?.additionalContext||"").length)')"
echo "host label repeated: $(grep -ci 'SubagentStart hook additional context' "$SCRATCH/blk.json")"
```

**Expect**

```
block bytes:         573
host label repeated: 0
```

**Read both lines together, in that order.** A zero on the second line alone proves nothing —
a hook that emitted no block at all would also score zero. The first line is what makes the
second mean something: there *is* a block, 573 bytes of it, and it does not repeat the label.

§1 measured that the host prefixes the block with that exact string; printing it again inside
the block is paid-for duplication of something the reader has already been told.

---

## §4 — The query comes from the parent's staged turn

`SubagentStart` carries no task text (§1), so there is nothing in the payload to search on. The
hook reads the prompt back out of `runs/<run_id>/turns/<prompt_id>.json`, which
`stage-prompt.mjs` wrote on the parent's `UserPromptSubmit` — long before the Agent tool ran.

Move the staged turn out of the way and watch the hook decline to dial at all:

```bash
: > "$SCRATCH/stub.log"
mv "$DATA/runs/cc-hs5-demo/turns/p-1.json" "$SCRATCH/turn.bak"
echo '{"session_id":"s-1","transcript_path":"/dev/null","cwd":"'"$SCRATCH"'","prompt_id":"p-1","agent_id":"noturn01","agent_type":"Explore","hook_event_name":"SubagentStart"}' \
  | node "$PLUG/hooks/dist/subagent-start.mjs"
echo "requests: $(grep -c 'POST /v2/control/query' "$SCRATCH/stub.log")"
mv "$SCRATCH/turn.bak" "$DATA/runs/cc-hs5-demo/turns/p-1.json"
```

**Expect**

```
{"suppressOutput":true}
requests: 0
```

**Read `requests: 0`.** Not "dialled and injected nothing" — never dialled. The alternative was
to query on `agent_type`, which is a bare label like `Explore` that the user never typed; that
would spend a round trip per spawn searching for the wrong thing.

This is a **proxy** and worth naming as one: the subagent's actual instruction is narrower than
the parent's prompt and is not visible to any hook. The parent's prompt is the closest thing to
the task that exists on this event — which is why the block says so out loud in §2.

---

## §5 — Siblings are distinguishable

§1 measured the collapse: both subagents shared the parent's `session_id` **and** `prompt_id`,
differing only in `agent_id`. Reproduce it with the two ids that live fan-out actually produced.

```bash
# clear the records §2 and §3 left, so what follows is only this step's fan-out
rm -rf "$DATA/runs/cc-hs5-demo/subagents"
sub() { echo '{"session_id":"s-1","transcript_path":"/dev/null","cwd":"'"$SCRATCH"'","prompt_id":"p-1","agent_id":"'"$1"'","agent_type":"Explore","hook_event_name":"SubagentStart"}'; }
sub ab55bb82d19855fbc | node "$PLUG/hooks/dist/subagent-start.mjs" > /dev/null
sub a0a7d24f87136bee1 | node "$PLUG/hooks/dist/subagent-start.mjs" > /dev/null
ls -1 "$DATA/runs/cc-hs5-demo/subagents/"
node -e '
const {readdirSync,readFileSync}=require("fs");
const d=process.env.DATA+"/runs/cc-hs5-demo/subagents";
for(const f of readdirSync(d).sort()){
  const r=JSON.parse(readFileSync(d+"/"+f,"utf8"));
  console.log(`${r.sub_run_id}
  agent_id       ${r.agent_id}
  mubit_agent_id ${r.mubit_agent_id}
  prompt_id      ${r.prompt_id}
  recalled       ${r.recalled.join(", ")}
  recall         rung ${r.recall.rung} · ${r.recall.sources} src · ${r.recall.tokens} tok · ${r.recall.chars} chars · ${r.recall.pointers} ptr
  linked         ${r.linked}`);
}'
```

**Expect**

```
cc-hs5-demo-sub-a0a7d24f8713.json
cc-hs5-demo-sub-ab55bb82d198.json
cc-hs5-demo-sub-a0a7d24f8713
  agent_id       a0a7d24f87136bee1
  mubit_agent_id claude-code-sub-a0a7d24f8713
  prompt_id      p-1
  recalled       ref_rule_1, ref_lesson_1, ref_fact_1
  recall         rung 1 · 3 src · 51 tok · 200 chars · 0 ptr
  linked         false
cc-hs5-demo-sub-ab55bb82d198
  agent_id       ab55bb82d19855fbc
  mubit_agent_id claude-code-sub-ab55bb82d198
  prompt_id      p-1
  recalled       ref_rule_1, ref_lesson_1, ref_fact_1
  recall         rung 1 · 3 src · 51 tok · 200 chars · 0 ptr
  linked         false
```

**Read `prompt_id` first: it is `p-1` on both.** That is the collapse, still there, exactly as
the live fan-out produced it — this ticket does not fix it and does not pretend to. What it adds
is everything above that line: two files, two sub-run ids, two agent ids, and a separately
attributable `recalled` list per subagent. Six parallel subagents now leave six records instead
of six streams into one.

**`linked: false` is not a stub.** It states a real gap, and §9 is about it.

`rung 1` on both is worth one glance: the ladder in `lib/recall.mjs` is shared with
`prompt-recall`, and rung 1 is the zero-LLM-call one. A fan-out of ten on rung 2 would be ten
routing LLM calls in front of one turn.

---

## §6 — The plugin's own recall agent is excluded

`agents/mubit-recall.md` exists to *call* `mubit_recall`. Injecting a recall block into it pays
for the same memory twice on the one agent guaranteed to go and fetch it anyway.

```bash
: > "$SCRATCH/stub.log"
for t in "mubit-memory:mubit-recall" "mubit-recall" "Explore"; do
  printf '%-28s -> ' "$t"
  echo '{"session_id":"s-1","transcript_path":"/dev/null","cwd":"'"$SCRATCH"'","prompt_id":"p-1","agent_id":"excl01","agent_type":"'"$t"'","hook_event_name":"SubagentStart"}' \
    | node "$PLUG/hooks/dist/subagent-start.mjs" | cut -c1-40; done
echo "queries dialled: $(grep -c 'POST /v2/control/query' "$SCRATCH/stub.log")"
```

**Expect**

```
mubit-memory:mubit-recall    -> {"suppressOutput":true}
mubit-recall                 -> {"suppressOutput":true}
Explore                      -> {"hookSpecificOutput":{"hookEven
queries dialled: 1
```

**Read the last line: one query for three spawns.** Both directions matter. A self-exclusion
that matched everything would produce three `suppressOutput`s and a dead hook — that is why
`Explore` is in the list.

The exclusion lives in the hook, not in a `hooks.json` matcher, and that is deliberate. The
matcher field for this event *is* `agent_type`, but a matcher can only ever be **positive**:
"every agent except this one" is not something it expresses, and an allowlist is worse, because
the set of agent types a user may spawn is open. One comparison in the hook, driven by a test in
both directions, is the honest version.

---

## §7 — The budget, and the seen-set that is not shared

### 7.1 A subagent's ceiling is not a parent's

Restart the stub in fat mode so the ceiling actually binds:

```bash
pkill -f 'stub.mjs'; sleep 0.3
(cd "$SCRATCH" && STUB_FAT=1 node stub.mjs 2>"$SCRATCH/stub.log" &) ; sleep 1
rm -rf "$DATA/runs/cc-hs5-demo/subagents"
for b in 150 250 600 1500; do
  echo '{"session_id":"s-1","transcript_path":"/dev/null","cwd":"'"$SCRATCH"'","prompt_id":"p-1","agent_id":"cap'"$b"'","agent_type":"Explore","hook_event_name":"SubagentStart"}' \
    | MUBIT_CC_SUBAGENT_RECALL_TOKENS=$b node "$PLUG/hooks/dist/subagent-start.mjs" > /dev/null
done
node -e '
const {readdirSync,readFileSync}=require("fs");
const d=process.env.DATA+"/runs/cc-hs5-demo/subagents";
const rows=readdirSync(d).map(f=>JSON.parse(readFileSync(d+"/"+f,"utf8")));
rows.sort((a,b)=>+a.agent_id.slice(3)-+b.agent_id.slice(3));
console.log("ceiling  rendered  dropped  tokens  chars");
for(const r of rows)console.log(`${r.agent_id.slice(3).padEnd(8)} ${String(r.recall.sources).padStart(8)} ${String(r.recall.dropped).padStart(8)} ${String(r.recall.tokens).padStart(7)} ${String(r.recall.chars).padStart(6)}`);'
```

**Expect**

```
ceiling  rendered  dropped  tokens  chars
150             0       12       0      0
250             1       11     152    605
600             4        8     594   2375
1500           10        2    1483   5930
```

**Read the `600` row against the `1500` row.** Same evidence, same ladder: 594 tokens against
1483. `subagentRecallTokenBudget` defaults to **600**, and 1500 is what a parent prompt gets —
that gap is the whole point of the separate dial. A subagent's window is smaller, its task is
narrower, and this is paid **once per spawn**, so a fan-out of ten pays it ten times.

The `150` row is the warning: these stub entries cost ~190 tokens each, so a ceiling below one
entry renders **nothing at all**. The block is dropped whole, not truncated. Do not tune this
below the size of a typical lesson.

### 7.2 A subagent has seen nothing earlier

The cross-turn seen-set degrades a repeat into `(seen earlier) <ref> — <clause>`. That line
asserts the model was given the entry in full **earlier in this conversation**. For a subagent
that is false: fresh window, given nothing.

```bash
rm -f "$DATA/runs/cc-hs5-demo/seen.json"
for n in 1 2; do
  printf 'parent prompt %s: ' "$n"
  echo '{"session_id":"s-1","prompt_id":"q-'"$n"'","cwd":"'"$SCRATCH"'","hook_event_name":"UserPromptSubmit","prompt":"why is the ingest job stuck in queued?"}' \
    | node "$PLUG/hooks/dist/prompt-recall.mjs" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=(JSON.parse(s||"{}").hookSpecificOutput?.additionalContext)||"";console.log((c.match(/seen earlier/g)||[]).length+" pointer lines, "+c.length+" chars")})'
done
SEEN_BEFORE=$(cat "$DATA/runs/cc-hs5-demo/seen.json")
printf 'subagent starting now: '
echo '{"session_id":"s-1","transcript_path":"/dev/null","cwd":"'"$SCRATCH"'","prompt_id":"p-1","agent_id":"fresheyes1","agent_type":"Explore","hook_event_name":"SubagentStart"}' \
  | node "$PLUG/hooks/dist/subagent-start.mjs" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).hookSpecificOutput.additionalContext;console.log((c.match(/seen earlier/g)||[]).length+" pointer lines, "+c.length+" chars")})'
[ "$SEEN_BEFORE" = "$(cat "$DATA/runs/cc-hs5-demo/seen.json")" ] && echo "seen.json unchanged" || echo "seen.json CHANGED"
```

**Expect**

```
parent prompt 1: 0 pointer lines, 6132 chars
parent prompt 2: 11 pointer lines, 2512 chars
subagent starting now: 0 pointer lines, 2752 chars
seen.json unchanged
```

**Read the third line against the second.** The parent's second prompt degraded eleven entries
to pointers — the seen-set working, 6132 chars down to 2512. The subagent starting *after* both
of those still gets **0 pointer lines**: full entries, under its own 600-token ceiling.

`seen.json unchanged` is the other half, and it is the mistake pointing the other way. If the
subagent marked what it received, the parent's *next* prompt would render a pointer to text the
parent was never given.

### 7.3 What it costs

One process per subagent spawn. A fan-out of ten is ten of them.

```bash
pkill -f 'stub.mjs'; sleep 0.3
(cd "$SCRATCH" && node stub.mjs 2>"$SCRATCH/stub.log" &) ; sleep 1
node - <<'EOF'
const { spawnSync, spawn } = require('node:child_process');
const N = 7, PLUG = process.env.PLUG;
const pay = (id, type = 'Explore') => JSON.stringify({
  session_id: 's-1', transcript_path: '/dev/null', cwd: process.env.SCRATCH,
  prompt_id: 'p-1', agent_id: id, agent_type: type, hook_event_name: 'SubagentStart' });
const best = (fn) => { const s = []; for (let i = 0; i < N; i++) s.push(fn(i));
  s.sort((a,b)=>a-b); return { best: s[0], median: s[(N-1)>>1] }; };
const time = (args, input) => { const t = Date.now();
  spawnSync(process.execPath, args, { input, stdio: ['pipe','ignore','ignore'] }); return Date.now()-t; };
const bare = best(() => time(['-e',''], ''));
const excl = best((i) => time([`${PLUG}/hooks/dist/subagent-start.mjs`], pay(`x${i}`, 'mubit-memory:mubit-recall')));
const full = best((i) => time([`${PLUG}/hooks/dist/subagent-start.mjs`], pay(`c${i}`)));
const row = (l, r) => console.log(`${l.padEnd(34)} best ${String(r.best).padStart(4)} ms   median ${String(r.median).padStart(4)} ms`);
row('bare `node -e ""` spawn', bare);
row('subagent-start, self-excluded', excl);
row('subagent-start, full recall path', full);
console.log(`\nthe hook's own cost above a bare spawn: ${full.best - bare.best} ms (best), ${full.median - bare.median} ms (median)`);
const t0 = Date.now();
Promise.all(Array.from({ length: 10 }, (_, i) => new Promise((res) => {
  const c = spawn(process.execPath, [`${PLUG}/hooks/dist/subagent-start.mjs`], { stdio: ['pipe','ignore','ignore'] });
  c.stdin.end(pay(`f${i}`)); c.on('close', res);
}))).then(() => console.log(`fan-out of 10, all in parallel:     ${Date.now()-t0} ms wall clock`));
EOF
```

**Expect** (absolute numbers are machine-specific; the *differences* are the measurement — this
was an M-series laptop against a loopback stub)

```
bare `node -e ""` spawn            best   35 ms   median   37 ms
subagent-start, self-excluded      best   47 ms   median   50 ms
subagent-start, full recall path   best   84 ms   median   90 ms

the hook's own cost above a bare spawn: 49 ms (best), 53 ms (median)
fan-out of 10, all in parallel:     176 ms wall clock
```

Two consecutive runs on the same machine gave 49–56 ms and 176–185 ms, so read these as ±15 %,
not as constants.

**Read the last two lines.**

- **~50 ms of the plugin's own work per spawn**, on top of a 35 ms `node` start — config load,
  run-id derivation (which shells out to `git rev-parse`), one request, one record write.
- **A fan-out of ten costs ~176 ms of wall clock**, not ten times 84 ms, because the host spawns
  them in parallel. The serial cost is ~840 ms of CPU; the latency a user feels is ~176 ms.
- **Self-exclusion is the cheap path**: 47 ms against 84 ms, because it returns before deriving
  a run id or dialling anything.

Against a **remote** endpoint the request term dominates everything above — §8 measured 939 ms
for one hosted call. The recall budget (`MUBIT_CC_RECALL_BUDGET_MS`, default 1500 ms) is what
bounds it, and a slow endpoint costs an empty block, never a failed spawn.

---

## §8 — Live, against `api.mubit.ai`

Fresh data dir, the real endpoint, the key read out of `credentials.json` with `node -e` so it
never enters shell history.

```bash
export LIVE=/tmp/mubit-hs5-live; rm -rf "$LIVE"; mkdir -p "$LIVE"
export MUBIT_CC_DATA_DIR="$LIVE"
export MUBIT_ENDPOINT=https://api.mubit.ai
export MUBIT_API_KEY=$(node -e 'process.stdout.write(require(process.env.HOME+"/.claude/plugins/data/mubit-memory-mubit/credentials.json").apiKey)')
export MUBIT_CC_RUN_ID=cc-hs5-live
export MUBIT_CC_RECALL_BUDGET_MS=8000     # see the note below
echo "key length: ${#MUBIT_API_KEY}"
```

**Expect** `key length: 105`. Zero means the credentials file is missing — run
`/mubit-memory:auth` and start again.

> **Why the budget is raised.** The default is 1500 ms and the hosted instance answered in
> 939–1201 ms below — comfortable, but a loaded instance or a slower link crosses it and the
> step reports an empty block that looks like a bug. Raise it for the measurement; do not leave
> it raised, because in a real session that budget is what stops a hook blocking.

A brand-new run has nothing in it, so seed one labelled item first:

```bash
node - <<'EOF'
const P = process.env.PLUG;
const { loadConfig } = await import(`file://${P}/lib/config.mjs`);
const { postIngest } = await import(`file://${P}/lib/http.mjs`);
const r = await postIngest(loadConfig(), {
  run_id: 'cc-hs5-live', agent_id: 'claude-code',
  items: [{
    item_id: `hs5-seed-${Date.now()}`, content_type: 'text',
    text: 'HS5 manual-test seed: a SubagentStart hook is the only way a Claude Code subagent '
        + 'receives injected memory, because UserPromptSubmit never fires for one.',
    intent: 'lesson', importance: 'medium', source: 'agent',
    occurrence_time: Math.floor(Date.now() / 1000), env_tags: ['tool:claude-code', 'test:hs5'],
    metadata_json: '{"manual_test":"hs-5"}',
  }],
}, { timeoutMs: 20000 });
console.log('ingest ok:', r.ok, 'status:', r.status, 'state:', r.body?.status);
EOF
```

**Expect**

```
ingest ok: true status: 200 state: queued
```

`queued` is the success case, not a wait — that is literally one of the lessons the stub serves
in §2. Give indexing a few seconds, then run the real thing:

```bash
echo '{"session_id":"L-3","prompt_id":"lp-1","cwd":"'"$SCRATCH"'","hook_event_name":"UserPromptSubmit","prompt":"how does a Claude Code subagent receive injected memory?"}' \
  | node "$PLUG/hooks/dist/stage-prompt.mjs" > /dev/null
sleep 5
echo '{"session_id":"L-3","transcript_path":"/dev/null","cwd":"'"$SCRATCH"'","prompt_id":"lp-1","agent_id":"poll1","agent_type":"Explore","hook_event_name":"SubagentStart"}' \
  | node "$PLUG/hooks/dist/subagent-start.mjs" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(o.hookSpecificOutput?.additionalContext||JSON.stringify(o))})'
node -e '
const {readdirSync,readFileSync}=require("fs");
const d=process.env.LIVE+"/runs/cc-hs5-live/subagents";
for(const f of readdirSync(d).sort()){const r=JSON.parse(readFileSync(d+"/"+f,"utf8"));
console.log(`${r.agent_id.padEnd(10)} rung ${r.recall.rung} · ${r.recall.sources} src · ${String(r.recall.tokens).padStart(4)} tok · ${String(r.recall.ms).padStart(5)} ms · ${r.recall.empty_reason||"-"}`);}'
```

**Expect**

```
<mubit-memory run="cc-hs5-live" agent="claude-code-sub-poll1" sources="1" tokens="42">
Recalled from memory of earlier work on this project, retrieved against the prompt that spawned you rather than against your own instructions — so it may be incomplete, out of date, or about a different part of the task. Verify against the code before relying on it.

## Lessons
- HS5 manual-test seed: a SubagentStart hook is the only way a Claude Code subagent receives injected memory, because UserPromptSubmit never fires for one.
</mubit-memory>
live0001   rung 1 · 0 src ·    0 tok ·  1201 ms · no_evidence
poll1      rung 1 · 1 src ·   42 tok ·   939 ms · -
```

**Read the `ms` column.** 939 ms and 1201 ms against a **1500 ms** default budget — the hosted
path fits, but not by much, and every one of those milliseconds is spent before the subagent
starts working. That is the number to watch if subagents start reporting empty blocks.

The `live0001` row above is from an earlier call against the same run **before** the seed
landed: `rung 1`, HTTP 200, `no_evidence`. Keep it in view — an empty block from a healthy
server looks identical to a broken one from stdout alone, and `empty_reason` is the only field
that tells them apart.

> **What was not run live.** Everything here drives `subagent-start.mjs` directly with a
> recorded payload. Driving it *through* a live Claude Code session with the plugin installed —
> so that a real subagent reports the plugin's own block rather than a spike token — was not
> run. §1 proves the delivery mechanism live with a stub hook; that the plugin's stdout is the
> shape the host accepts is covered by `test/hook-output.test.mjs`, on both directions of the
> host's own schema.

---

## §9 — The two gaps, stated

Neither is a defect in what shipped. Both are the honest edge of it.

### 9.1 An isolated-context agent gets nothing, and nothing can tell you

The host collects hook contexts and then drops them for an agent that has an isolated context:

```
if (mr.length > 0 && !d?.isolatedContext) { … }
```

So for such an agent the hook spawns, derives a run id, spends a request, renders a block — and
the block is discarded before the subagent sees it. The `SubagentStart` payload carries no field
that reveals it (§1), so the plugin cannot detect the case, skip it, or report it. `mubit`'s
record will show a healthy injection that the agent never received.

**Practical effect:** budget spent on such an agent buys nothing. If you configure agents with
isolated contexts and fan out to them widely, `subagentRecallTokenBudget` is the dial, and `0`
in `plugin.json` disables the block by falling back to the parent budget rather than turning the
hook off — set `recall: false` for that.

### 9.2 There is no `link_run` route, so isolation is local

Mubit's subagent-isolation pattern is for each subagent to get its own `run_id`, joined back
with `link_run()` and read together with `include_linked_runs`. **This client cannot do the join
half.** `lib/http.mjs`'s `ROUTES` is:

```
health, register, heartbeat, ingest, ingestJobs, query, context, outcome, checkpoint,
lessons, reflect
```

No link-run route. Inventing an endpoint would be worse than the gap — writing a subagent's
evidence under an id nothing can rejoin would *lose* it rather than isolate it. So this ticket
deliberately stops at recall injection plus the sub-run id, and the record in §5 is the local
half of the join: it holds both ends (`sub_run_id`, `parent_run_id`), both agent ids, and the
ids this subagent's block actually rendered, so a later `link_run` needs no rerun.
`linked: false` says so in the data.

**Where the next step starts.** `agent_transcript_path` is on `SubagentStop`, not on
`SubagentStart` — §1's field lists show it — and it is per-subagent:

```
…/<session_id>/subagents/agent-<agent_id>.jsonl
```

That is the one field on the whole surface that could anchor a real sub-run: a per-subagent
transcript is a per-subagent stream of evidence. `hooks/src/capture.mjs`'s `--subagent` mode
still reads the *parent's* turn file for its `Q:` half, so all siblings share a question they
were never individually asked. Joining that path to the record this ticket writes is the work
that closes §5's `prompt_id` collapse for real.

---

## §10 — Clean up

```bash
pkill -f 'stub.mjs'
rm -rf /tmp/mubit-hs5 /tmp/mubit-hs5-data /tmp/mubit-hs5-live /tmp/mubit-hs5-spike
```

The one live item seeded in §8 stays in the `cc-hs5-live` run on your instance. It is labelled
`metadata_json: {"manual_test":"hs-5"}` and `env_tags: ["test:hs5"]`; delete it with
`/mubit-memory:forget` if you would rather it were not there.
