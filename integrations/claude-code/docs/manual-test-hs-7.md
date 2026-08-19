# Manual test — HS-7, `PreToolUse` warnings

One claim, and one guarantee that has to hold while it is true.

**The claim:** a Mubit `rule` can surface at the moment it applies — not twenty prompts earlier
in a recall block, but in front of the command it is about.

**The guarantee:** this stage **denies nothing**. Not by returning a permission decision, not
by rewriting the tool's arguments, and not by exiting 2 — which the host reads as "block this
call" whatever the stdout says. Every section below that proves the claim is followed by one
that proves the guarantee still holds on the same path.

Everything here was executed on **2026-08-19** against Claude Code **2.1.235** on macOS
(darwin 25.5.0, Node v22.23.1), from the branch `feat/pretooluse-warnings`. The **Expect**
blocks are transcripts, not predictions. Where a number will differ on your machine the text
says so, and where a live step could not prove what it was meant to, §8 says that instead of
inventing output.

**Time:** ~10 minutes for §0–§6 (offline, deterministic), ~10 more for §7–§8.
**Destroys:** nothing. Three temp directories and one throwaway file, all removed in §9. Your
installed plugin and its data dir are never touched. §8 registers one agent under a throwaway
run id against the hosted Mubit and then reads; it writes no memory and deletes nothing.

---

## §0 — Setup, one paste

Two traps decide whether the rest of this file works, and both bite silently. They are the
same two as `manual-test-0.10.0.md` §0 and the reasoning there still stands: **the data
directory is not where the docs say**, and **your shell may already point at a different
Mubit**. Check before you start:

```bash
env | grep -iE '^(MUBIT|CLAUDE_PLUGIN)' | sed 's/\(MUBIT_API_KEY=.\{0,10\}\).*/\1…/' | sort
```

**Expect nothing at all.** Anything printed is already steering the plugin. `MUBIT_CC_DATA_DIR`
and `CLAUDE_PLUGIN_DATA` redirect every byte of state; `MUBIT_ENDPOINT` and `MUBIT_API_KEY`
decide which Mubit you are measuring; `CLAUDE_PLUGIN_ROOT` decides which copy of the plugin
loads. Hooks read the environment of the Claude Code process, fixed at launch, so you cannot
correct any of this from inside a running session.

There is a third trap specific to this feature: **`preToolWarnings` is off by default.** A run
where nothing happens is the correct behaviour of an unconfigured plugin, and is
indistinguishable from a broken one if you forgot the flag. It is set explicitly below, and §3
turns it back off deliberately to check that off means off.

Now paste this whole block into the terminal you will use for the rest of the run:

```bash
export PLUG=/Users/eldaru/Mubit/hs-7-pretooluse-warn/integrations/claude-code
export SCRATCH=/tmp/mubit-hs7
export DATA=/tmp/mubit-hs7-data

# a throwaway project — never run this from a Mubit repo, see the note below
rm -rf "$SCRATCH" "$DATA" && mkdir -p "$SCRATCH" "$DATA"
cd "$SCRATCH" && git init -q && echo "# scratch" > README.md
git add -A && git -c user.email=you@example.com -c user.name=you commit -qm init

# pin the target explicitly — do not rely on the ambient environment
export MUBIT_CC_DATA_DIR="$DATA"
export MUBIT_ENDPOINT=https://api.mubit.ai
export MUBIT_API_KEY=$(node -e 'process.stdout.write(require(process.env.HOME+"/.claude/plugins/data/mubit-memory-mubit/credentials.json").apiKey)')
export MUBIT_CC_LOG_LEVEL=info          # writes the ring log at $DATA/logs/mubit-cc.log
export MUBIT_CC_RUN_STRATEGY=static     # so §2-§6 can seed a run directory by name
export MUBIT_CC_RUN_ID=hs7-manual
export MUBIT_CC_PRE_TOOL_WARNINGS=1     # the opt-in. Off is the shipped default.

# the hooks are spawned by the host with these two set; §2-§6 spawn them by hand instead
export CLAUDE_PLUGIN_ROOT="$PLUG"
export CLAUDE_PROJECT_DIR="$SCRATCH"

echo "plugin  $PLUG"
echo "data    $DATA"
echo "endpoint $MUBIT_ENDPOINT"
echo "key     ${MUBIT_API_KEY:0:8}… (${#MUBIT_API_KEY} chars)"
echo "run     $MUBIT_CC_RUN_ID"
```

**Expect**

```
plugin  /Users/eldaru/Mubit/hs-7-pretooluse-warn/integrations/claude-code
data    /tmp/mubit-hs7-data
endpoint https://api.mubit.ai
key     mbt_mubi… (105 chars)
run     hs7-manual
```

Read the `key` line first. A length of 0 means the credential file was not where the `node -e`
looked, and every live step in §8 will report a plausible-looking failure that is really about
your shell.

> **Work in `$SCRATCH`, never in a Mubit repo.** Self-reference suppression deliberately drops
> any capture whose text mentions `mubit`. In a Mubit checkout the capture path looks broken
> and is working exactly as designed.

> The key is read out of the credential file rather than typed, so it never enters your shell
> history. It is still visible to `ps` for the life of a child process; that is the normal
> trade.

---

## §1 — Does the host accept the registration at all

A plugin that fails validation does not half-load. It loads **nothing**. `PreToolUse` brings a
manifest field the other nine registrations do not use — `if` — so check the host's own schema
before anything else.

```bash
node -e 'console.log(JSON.stringify(require(process.env.PLUG + "/hooks/hooks.json").hooks.PreToolUse, null, 2))'
```

**Expect**

```json
[
  {
    "matcher": "Bash",
    "hooks": [
      {
        "type": "command",
        "command": "node",
        "timeout": 3,
        "if": "Bash(rm *)",
        "args": [
          "${CLAUDE_PLUGIN_ROOT}/hooks/dist/pre-tool.mjs"
        ]
      },
      {
        "type": "command",
        "command": "node",
        "timeout": 3,
        "if": "Bash(git push *)",
        "args": [
          "${CLAUDE_PLUGIN_ROOT}/hooks/dist/pre-tool.mjs"
        ]
      }
    ]
  }
]
```

Read `if` first, on both entries. It is per **hook entry**, not per matcher group — the host
builds its hook dedup key as `command \0 args \0 if`, so two entries differing only in `if` are
two distinct hooks and a single entry cannot carry both patterns. `matcher` and `if` are
different mechanisms and the difference matters: `matcher` is tested against one payload field
(for this event, `tool_name`), while `if` is a permission-rule pattern tested against the
contents of the call. **Without `if` this registration is one node process in front of every
Bash command in the session.** §7 measures that.

Then let the host validate it:

```bash
env -u MUBIT_ENDPOINT -u MUBIT_API_KEY -u MUBIT_CC_DATA_DIR \
    -u CLAUDE_PLUGIN_DATA -u CLAUDE_PLUGIN_ROOT \
    claude plugin validate "$PLUG"
```

**Expect**

```
Validating plugin manifest: /Users/eldaru/Mubit/hs-7-pretooluse-warn/integrations/claude-code/.claude-plugin/plugin.json

✔ Validation passed
```

---

## §2 — The mechanism, by hand

Seed a rule store and drive the hook the way Claude Code does: a fresh `node` process, the tool
call as JSON on stdin, JSON on stdout.

```bash
mkdir -p "$DATA/runs/hs7-manual"
cat > "$DATA/runs/hs7-manual/rules.json" <<'JSON'
{ "version": 1, "updated_at": 0, "rules": [
  { "ref": "ref_seed_force", "text": "Never force-push to main; open a pull request instead." },
  { "ref": "ref_seed_rm",    "text": "Never rm -rf a path you have not printed with ls first." },
  { "ref": "ref_seed_mig",   "text": "Run the migration before starting the server." }
] }
JSON

CALL='{"session_id":"s1","cwd":"'"$SCRATCH"'","permission_mode":"default","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push --force origin main"},"tool_use_id":"toolu_1"}'

echo "--- flag ON ---"
echo "$CALL" | MUBIT_CC_PRE_TOOL_WARNINGS=1 node "$PLUG/hooks/dist/pre-tool.mjs"; echo "exit=$?"
echo "--- flag OFF (the shipped default) ---"
echo "$CALL" | MUBIT_CC_PRE_TOOL_WARNINGS=0 node "$PLUG/hooks/dist/pre-tool.mjs"; echo "exit=$?"
```

**Expect**

```
--- flag ON ---
{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"<mubit-rules matched=\"1\">\nStanding rules from Mubit memory that mention this command. This is a reminder, not a permission check — nothing here has blocked or changed the call, and the rules may be out of date. Judge whether each one applies before acting on it.\n\n- [ref_seed_force] Never force-push to main; open a pull request instead.\n</mubit-rules>\n"},"suppressOutput":true}
exit=0
--- flag OFF (the shipped default) ---
{"suppressOutput":true}
exit=0
```

Three fields, in this order.

1. **`matched="1"`.** Three rules were stored and one surfaced. The migration rule and the
   `rm -rf` rule share no distinctive term with a `git push`, so they stayed quiet. A hook that
   surfaced all three would be a hook nobody reads by the third command.
2. **`hookEventName` is `PreToolUse`.** It has to equal the event that fired. Anything else and
   the host throws "Hook returned incorrect event name" and injects nothing — silently, from
   the plugin's point of view, because the hook still exits 0.
3. **The whole object, on the OFF run, is `{"suppressOutput":true}`.** Not a suppressed
   `additionalContext`; nothing at all. Off means the store is never read and no rule can leak
   into a session that did not ask for one.

And what is *not* in either object: no `permissionDecision`, no `permissionDecisionReason`, no
`updatedInput`. §3 makes that a property rather than an observation.

---

## §3 — It denies nothing, on every path

This is the section the whole ticket is for. The host gives this event two ways to stop a call
and the plugin must take neither, on **every** path — including the ones nobody drives by hand,
because those are exactly where a well-meaning `catch` grows a `process.exit(2)`.

The second channel is easy to miss. From the host's own hook registry:

```
Exit code 0 - stdout/stderr not shown
Exit code 2 - show stderr to model and block tool call
Other exit codes - show stderr to user only but continue with tool call
```

Note the asymmetry: every *other* non-zero code lets the call through. The dangerous value is
specifically 2, which is the code a naive error handler picks.

```bash
R="$DATA/runs/hs7-manual/rules.json"; cp "$R" "$R.keep"
CALL='{"session_id":"s1","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push --force origin main"},"tool_use_id":"t1"}'

probe () {   # name, stdin, extra env
  out=$(printf '%s' "$2" | env $3 node "$PLUG/hooks/dist/pre-tool.mjs" 2>/dev/null); code=$?
  bad=$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let o={};try{o=JSON.parse(s)}catch{};const h=o.hookSpecificOutput||{};const k=["permissionDecision","permissionDecisionReason","updatedInput","decision","reason"].filter(x=>x in o||x in h);process.stdout.write(k.length?k.join(","):"none")})')
  printf '%-34s exit=%s  deny-keys=%s\n' "$1" "$code" "$bad"
}

probe "rule matches"        "$CALL" ""
printf '{"rules":[]}'              > "$R"; probe "empty store"     "$CALL" ""
printf '{"rules": [{"text": "half' > "$R"; probe "torn store"      "$CALL" ""
printf '["bare array"]'            > "$R"; probe "wrong shape"     "$CALL" ""
rm -f "$R";                                probe "no store at all" "$CALL" ""
cp "$R.keep" "$R"
probe "unparseable stdin"   '{"tool_name":'                    ""
probe "no tool_name"        '{"hook_event_name":"PreToolUse"}' ""
probe "flag off"            "$CALL" "MUBIT_CC_PRE_TOOL_WARNINGS=0"
probe "run id underivable"  "$CALL" "MUBIT_CC_RUN_ID="
probe "data dir is a file"  "$CALL" "MUBIT_CC_DATA_DIR=/etc/hosts"
```

**Expect**

```
rule matches                       exit=0  deny-keys=none
empty store                        exit=0  deny-keys=none
torn store                         exit=0  deny-keys=none
wrong shape                        exit=0  deny-keys=none
no store at all                    exit=0  deny-keys=none
unparseable stdin                  exit=0  deny-keys=none
no tool_name                       exit=0  deny-keys=none
flag off                           exit=0  deny-keys=none
run id underivable                 exit=0  deny-keys=none
data dir is a file                 exit=0  deny-keys=none
```

Read the `exit=` column first and the `deny-keys=` column second; a single `exit=2` anywhere in
that column is a released plugin that blocks commands, and it would most likely appear on one
of the last three rows — a misconfigured run strategy, a read-only data dir — which is to say
on the machines least able to diagnose it.

`test/pre-tool.test.mjs` drives this same table in CI, and adds the half this cannot: it greps
the **built bundle** for `permissionDecision`, `updatedInput` and `process.exit(2)`. A path a
test cannot reach — a blown deadline, a stray callback throwing after the body resolved — is
still covered, because a literal that is not in the file cannot be emitted by any path.

---

## §4 — Zero network, and why it is not optional

This hook runs while the user waits on the tool call. A round trip here is latency on every
matching command in exchange for a reminder, and a slow Mubit would spend the 3 s host timeout
and inject nothing. Point the plugin at a server that records everything it is asked for, and
check the recording is empty.

```bash
node -e '
const { createServer } = require("node:http");
const { execFileSync } = require("node:child_process");
const seen = [];
const s = createServer((q, r) => { seen.push(q.method + " " + q.url); r.writeHead(200, {"content-type":"application/json"}); r.end("{}"); });
s.listen(0, "127.0.0.1", () => {
  const url = "http://127.0.0.1:" + s.address().port;
  const call = JSON.stringify({ hook_event_name:"PreToolUse", tool_name:"Bash",
    tool_input:{ command:"git push --force origin main" }, tool_use_id:"t1" });
  const t0 = Date.now();
  const out = execFileSync(process.execPath, [process.env.PLUG + "/hooks/dist/pre-tool.mjs"],
    { input: call, env: { ...process.env, MUBIT_ENDPOINT: url } }).toString();
  console.log("hook wall clock : " + (Date.now() - t0) + " ms");
  console.log("requests seen   : " + (seen.length ? seen.join(", ") : "0"));
  console.log("matched         : " + (JSON.parse(out).hookSpecificOutput ? "yes" : "no"));
  s.close();
});
'
```

**Expect** — the millisecond figure is your machine's `node` cold start and will differ; the
other two will not:

```
hook wall clock : 50 ms
requests seen   : 0
matched         : yes
```

Read `requests seen` first. `matched: yes` beside it is what makes the zero meaningful: the
hook did its whole job on that call and still opened no socket. A `0` next to `matched: no`
would prove nothing at all — a hook that did nothing also dials nothing.

The 50 ms is the *whole* process, launcher and bundle parse included. The hook's own share is
the part above a bare `node` spawn, which on this machine is under 10 ms.

---

## §5 — The round trip: server → store → warning

§2 seeded `rules.json` by hand, which proves the reader and says nothing about the writer. The
store is filled by the two hooks that already pay for a network call and see typed entries go
past: `session-start`'s global-lessons call, and `prompt-recall`'s query ladder. Stand a fake
Mubit up and watch a rule travel the whole way.

```bash
export WIRE=/tmp/mubit-hs7-wire; rm -rf "$WIRE"; mkdir -p "$WIRE"

cat > "$SCRATCH/stand-in-mubit.mjs" <<'JS'
// A stand-in Mubit: answers health, register and lessons, and logs every request it is asked
// for. Two lessons, only one of them a `rule`.
import { createServer } from 'node:http';
const LESSONS = { lessons: [
  { lesson_id: 'les_force', lesson_type: 'rule',    content: 'Never force-push to main; open a pull request instead.' },
  { lesson_id: 'les_note',  lesson_type: 'failure', content: 'The ingest job stays queued until indexing completes.' },
] };
createServer((q, r) => {
  let b = ''; q.on('data', (d) => { b += d; }); q.on('end', () => {
    console.log(`${q.method} ${q.url}`);
    if (q.url === '/v2/core/health') { r.writeHead(200, { 'content-type': 'text/plain' }); return r.end('OK'); }
    r.writeHead(200, { 'content-type': 'application/json' });
    r.end(JSON.stringify(q.url === '/v2/control/lessons' ? LESSONS : { success: true }));
  });
}).listen(8791, '127.0.0.1', () => console.log('stand-in Mubit on http://127.0.0.1:8791'));
JS

node "$SCRATCH/stand-in-mubit.mjs" > "$SCRATCH/stand-in.log" 2>&1 &
echo $! > "$SCRATCH/stand-in.pid"; sleep 1

env MUBIT_CC_DATA_DIR="$WIRE" MUBIT_CC_RUN_ID=hs7-wire \
    MUBIT_ENDPOINT=http://127.0.0.1:8791 \
    MUBIT_API_KEY=mbt_local_0000000000000000_0000000000000000000000000000 \
  node "$PLUG/hooks/dist/session-start.mjs" > /dev/null <<JSON
{"hook_event_name":"SessionStart","source":"startup","session_id":"w1","cwd":"$SCRATCH"}
JSON

echo "--- what the stand-in was asked for ---"; cat "$SCRATCH/stand-in.log"
echo "--- runs/hs7-wire/rules.json ---";        cat "$WIRE/runs/hs7-wire/rules.json"
```

**Expect** — `updated_at` is a wall-clock stamp and will differ:

```
--- what the stand-in was asked for ---
stand-in Mubit on http://127.0.0.1:8791
GET /v2/core/health
POST /v2/control/agents/register
POST /v2/control/lessons
--- runs/hs7-wire/rules.json ---
{"version":1,"updated_at":1787152805480,"rules":[{"ref":"les_force","text":"Never force-push to main; open a pull request instead."}]}
```

Read the `rules` array first, and specifically read what is **not** in it. The server returned
two lessons; one is stored. `les_note` is a `failure`, and a failure is a suggestion drawn from
one past episode — putting one in front of a live command is an interruption on a guess. Only
`rule`, the type Mubit defines as a hard constraint that always applies, is kept.

Then run the warning against that store, and watch the stand-in stay silent:

```bash
: > "$SCRATCH/stand-in.log"
env MUBIT_CC_DATA_DIR="$WIRE" MUBIT_CC_RUN_ID=hs7-wire MUBIT_ENDPOINT=http://127.0.0.1:8791 \
  node "$PLUG/hooks/dist/pre-tool.mjs" <<'JSON' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).hookSpecificOutput.additionalContext))'
{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push --force origin main"},"tool_use_id":"t1"}
JSON
echo "--- the stand-in was asked for ---"
[ -s "$SCRATCH/stand-in.log" ] && cat "$SCRATCH/stand-in.log" || echo "(nothing)"
kill $(cat "$SCRATCH/stand-in.pid") 2>/dev/null; echo "stand-in stopped"
```

**Expect**

```
<mubit-rules matched="1">
Standing rules from Mubit memory that mention this command. This is a reminder, not a permission check — nothing here has blocked or changed the call, and the rules may be out of date. Judge whether each one applies before acting on it.

- [les_force] Never force-push to main; open a pull request instead.
</mubit-rules>
--- the stand-in was asked for ---
(nothing)
stand-in stopped
```

Read the sentence in the block before the rule. It is there because a model that meets a
standing rule at the exact moment of a tool call will otherwise read it as enforcement,
conclude the guardrail held, and stop checking — which is worse than never warning, since it
converts a reminder into a false assurance. Then read `[les_force]`: the `reference_id` rides
along so the model can `mubit_dereference` the entry and see its provenance rather than taking
the sentence on faith.

---

## §6 — How often does it fire, and on what

This is the measurement the next stage of HS-7 depends on, and it is the reason the flag ships
off: an operator turns it on for one run and reads the numbers before anyone argues about
denying anything.

`pre-tool` writes no turn state, so `scripts/mubit-inspect.mjs` — the readout for the recall
path — has nothing to show for it. The channel is the ring log, one line per invocation, at
`info`. That is deliberate: a `systemMessage` would put a line in the user's terminal in the
middle of a tool call, on a feature whose whole premise is that it is quiet.

```bash
rm -f "$DATA/logs/mubit-cc.log"
for c in "git push --force origin main" "rm -rf node_modules" "rm -f /tmp/scratch.txt" "git push origin feature/x"; do
  printf '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"},"tool_use_id":"t"}' "$c" \
    | node "$PLUG/hooks/dist/pre-tool.mjs" > /dev/null
done

echo "fired : $(grep -ac 'pre-tool: rule check' "$DATA/logs/mubit-cc.log")"
echo "quiet : $(grep -ac '\"matched\":0' "$DATA/logs/mubit-cc.log")"
echo
grep -a 'pre-tool' "$DATA/logs/mubit-cc.log" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.trim().split("\n")){const j=JSON.parse(l);console.log(`${String(j.matched).padStart(2)} matched  refs=${JSON.stringify(j.refs)}`)}})'
```

**Expect**

```
fired : 4
quiet : 2

 1 matched  refs=["ref_seed_force"]
 1 matched  refs=["ref_seed_rm"]
 0 matched  refs=[]
 0 matched  refs=[]
```

Read the two zero rows first — they are the ones that tell you the matcher is not simply
saying yes.

- `rm -f /tmp/scratch.txt` shares only `rm` with the rule about `rm -rf`. One shared term is
  not enough; the floor is two distinct non-common terms.
- `git push origin feature/x` shares only `push` with the force-push rule. `force` and `main`
  are both absent, which is precisely the difference between the command the rule is about and
  a command that merely looks like it.

`fired` minus the sum of the matched column is your false-quiet budget, and `refs` is what you
audit when a match looks wrong: paste the id into `/mubit-memory:recall` and read the rule the
warning actually came from.

---

## §7 — In a real Claude Code session

Everything so far spawned the hook by hand. This runs the real host, so the `if` filter and the
matcher are the host's own, not a simulation of them. It still needs no Mubit — the store is
seeded, and §8 is where the hosted endpoint comes in.

```bash
export SESS=/tmp/mubit-hs7-session; rm -rf "$SESS"; mkdir -p "$SESS/runs/hs7-session"
cat > "$SESS/runs/hs7-session/rules.json" <<'JSON'
{ "version": 1, "updated_at": 0, "rules": [
  { "ref": "ref_seed_rm", "text": "Never rm -rf a path you have not printed with ls first." } ] }
JSON
touch "$SCRATCH/throwaway.txt"
rm -f /tmp/cc-hs7-fire.log

env -u MUBIT_ENDPOINT -u MUBIT_API_KEY -u CLAUDE_PLUGIN_DATA -u CLAUDE_PLUGIN_ROOT \
  MUBIT_CC_DATA_DIR="$SESS" MUBIT_CC_RUN_STRATEGY=static MUBIT_CC_RUN_ID=hs7-session \
  MUBIT_CC_LOG_LEVEL=info MUBIT_CC_PRE_TOOL_WARNINGS=1 \
  claude --plugin-dir "$PLUG" --debug-file /tmp/cc-hs7-fire.log --allowedTools Bash \
    -p 'Run exactly this one bash command and then stop: rm -rf /tmp/mubit-hs7/throwaway.txt'

echo "=== plugin ring log ==="
grep -a 'pre-tool' "$SESS/logs/mubit-cc.log"
echo "=== what the host says ==="
grep -a "pre-tool.mjs" /tmp/cc-hs7-fire.log | sed 's/^[^ ]* //'
grep -a "Skipping hook due to if condition" /tmp/cc-hs7-fire.log | cut -c1-200
grep -aoE "PostToolUse:[A-Za-z]+" /tmp/cc-hs7-fire.log | sort | uniq -c
```

**Expect** — the model's wording will differ, everything below `=== plugin ring log ===` will
not:

```
Done — `/tmp/mubit-hs7/throwaway.txt` is deleted. (It was an empty, untracked file; I checked it before removing.)
=== plugin ring log ===
{"ts":"2026-08-19T15:21:16.203Z","level":"info","msg":"pre-tool: rule check","run_id":"hs7-session","tool":"Bash","stored":1,"matched":1,"refs":["ref_seed_rm"]}
=== what the host says ===
[DEBUG] Hook PreToolUse (node ${CLAUDE_PLUGIN_ROOT}/hooks/dist/pre-tool.mjs) provided additionalContext (351 chars)
2026-08-19T15:21:16.148Z [DEBUG] Skipping hook due to if condition "Bash(git push *)" not matching
   1 PostToolUse:Bash
   1 PostToolUse:Read
```

Four things, and the fourth is the one worth the whole section.

1. **`provided additionalContext (351 chars)`** — the host's own words. The block landed; it
   was not discarded by schema validation, which is the silent failure this event's sibling
   `PostCompact` shipped with for its whole life.
2. **`Skipping hook due to if condition "Bash(git push *)" not matching`** — the second
   registration was filtered out before it could spawn. Both halves of the `if` mechanism, in
   one run: one entry ran, one did not.
3. **Two `PostToolUse` calls, one `pre-tool` line.** The session used `Bash` and `Read`; the
   `Read` never reached the matcher. That ratio is the entire argument for the filter, and it
   gets worse in the plugin's favour in a real session: without `matcher` and `if` this would
   be one node process for every one of them.
4. **The model's reply says "I checked it before removing."** It read the warning and acted on
   it — without anything having been blocked, asked or rewritten. That is the claim of the
   ticket, observed once, in a real session. One observation is an anecdote, which is what §6
   exists to turn into a number.

---

## §8 — LIVE: against `https://api.mubit.ai`

Everything above is deterministic and offline. This section talks to the hosted instance with
the key from §0. It registers one agent under the throwaway run id `hs7-live` and reads; it
writes no memory.

```bash
export LIVE=/tmp/mubit-hs7-live; rm -rf "$LIVE"; mkdir -p "$LIVE"

env MUBIT_CC_DATA_DIR="$LIVE" MUBIT_CC_RUN_ID=hs7-live \
  node "$PLUG/hooks/dist/session-start.mjs" > /dev/null <<JSON
{"session_id":"hs7-live-1","cwd":"$SCRATCH","permission_mode":"default","hook_event_name":"SessionStart","source":"startup","model":"claude-opus-5"}
JSON

env MUBIT_CC_DATA_DIR="$LIVE" MUBIT_CC_RUN_ID=hs7-live MUBIT_CC_RECALL_BUDGET_MS=8000 \
  node "$PLUG/hooks/dist/prompt-recall.mjs" > /dev/null <<JSON
{"session_id":"hs7-live-1","cwd":"$SCRATCH","permission_mode":"default","hook_event_name":"UserPromptSubmit","prompt_id":"p1","prompt":"what are the rules about force pushing and rm -rf in this project?"}
JSON

node "$PLUG/scripts/mubit-inspect.mjs" --data "$LIVE" --run hs7-live --last 40
echo "--- runs/hs7-live/rules.json ---"
cat "$LIVE/runs/hs7-live/rules.json" 2>/dev/null || echo "(no store — nothing rule-typed came back)"
```

**Expect** — this is what the run actually produced on 2026-08-19, and it is **not** the happy
path:

```
run hs7-live   hosted   ● ready   (data: /tmp/mubit-hs7-live)

prompt  when      rung  src  tok  chars  drop  empty_reason  used(m/c)  outcome
p1…     16:18:39     1    0    0      0     0  no_evidence   —          —

totals      1 prompts · 0 tok injected · 0 sources · 0/1 prompts got an injection
used-signal 0/0 measurable turns echoed the injected vocabulary (memory-term-echo/v1; false negatives dominate)

lessons     global 0 · injected_ids 0 · reflect: 0 stored, status=—
capture     tools 0 · turns 0 · pending 0 · ingested 0 · spool 0 · jobs 0
last recall 0 sources · 0 tok · 851 ms · rung 1 · no_evidence · dry_streak 1
            ^ marker is last-write-wins: this row is the most recent prompt only, and it is the only place per-prompt latency ever appears
--- runs/hs7-live/rules.json ---
(no store — nothing rule-typed came back)
```

Read `rung 1` and `state ● ready` first, then `empty_reason`.

- **`rung 1` and `● ready`** say the wire is fine. `direct_bypass` was granted — no 403, no
  descent, no LLM call — and the round trip took **851 ms** against the 1500 ms default recall
  budget. On a slower instance raise `MUBIT_CC_RECALL_BUDGET_MS`, as this step does, or the
  ladder aborts before the answer arrives and reports an empty result that looks like an empty
  account.
- **`lessons global 0` and `empty_reason no_evidence`** say the account is empty, not that the
  producers are broken. Both hooks ran, both recorded what they were given, and what they were
  given was nothing.

**So this section does not prove the live round trip end to end, and it would be dishonest to
present it as though it did.** What it proves is that both producer paths reach
`https://api.mubit.ai`, authenticate, and return without error. §5 proves the filtering and the
store against a server whose contents are known; §7 proves the host wiring. On an account that
holds `rule` entries, the step that closes the gap is the same one — read
`runs/hs7-live/rules.json` after the two hooks above, and expect one entry per non-stale `rule`
the account returned, keyed by `reference_id`.

Run this to confirm you are in the same situation rather than a different one:

```bash
node -e 'const j=require(process.env.LIVE+"/status/hs7-live.json");
console.log("state   :", j.state);
console.log("lessons :", j.lessons.global, "global");
console.log("recall  :", j.recall.sources, "sources ·", j.recall.rung && "rung "+j.recall.rung, "·", j.recall.empty_reason || "(injected)");'
```

**Expect**

```
state   : ready
lessons : 0 global
recall  : 0 sources · rung 1 · no_evidence
```

`state: ready` with `0 global` is an empty account. `state: auth_failed` is your key. `state:
unreachable` is the network. Those are three different problems and the marker is where they
are told apart.

---

## §9 — Cleanup

```bash
kill $(cat "$SCRATCH/stand-in.pid") 2>/dev/null
rm -rf /tmp/mubit-hs7 /tmp/mubit-hs7-data /tmp/mubit-hs7-wire /tmp/mubit-hs7-session /tmp/mubit-hs7-live
rm -f /tmp/cc-hs7-load.log /tmp/cc-hs7-fire.log
ls -d /tmp/mubit-hs7* 2>/dev/null || echo "all clear"
```

**Expect**

```
all clear
```

Nothing outside `/tmp` was written. The `hs7-live` agent registration in the hosted instance is
left behind — it is an agent record under a throwaway run id, not memory, and nothing recalls
against it.

---

## What this guide proves, and what it does not

**Proved:**

- The registration is accepted by Claude Code 2.1.235, `if` field and all (§1), and the host
  applies both filters as intended — one entry ran, the other was skipped by name (§7).
- A stored `rule` reaches the model as `additionalContext` at the moment the command it is
  about is issued (§2, §5, §7), and the host confirms delivery in its own log (§7).
- Only `rule` entries are stored; a `failure` returned in the same response is dropped (§5).
- The hook opens no socket, on the path where it does its whole job (§4).
- No path returns a permission decision, a reason, or rewritten input, and every path exits 0 —
  across ten branches including the corrupt-store, unparseable-stdin, underivable-run-id and
  unwritable-data-dir paths (§3).
- Firing is measurable without turning on any UI, and the matcher stays quiet on near-misses
  (§6).

**Not proved here:**

- The live end-to-end round trip, because the account used has no `rule` entries (§8). The wire
  and the auth are proved; the contents are not.
- Anything about how Claude Code treats a `PreToolUse` hook that **times out**. The published
  reference does not document it and this guide does not guess. Nothing in the plugin rests on
  it: the hook exits 0 on every path it controls, including the one where its own internal
  deadline fires.
- Whether the term-overlap matcher is good enough to build a *deny* on. That is the question §6
  exists to gather data for, and it needs a real session count, not four hand-written commands.
