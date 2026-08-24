# Manual test — HS-1: `fork` in the SessionStart matcher

**Claim under test:** a forked session gets the same memory a resumed one does.

`hooks/hooks.json` matched `startup|resume|clear|compact`. Claude Code emits a fifth
`SessionStart.source` — `fork`, for `--fork-session` with `--resume`/`--continue`, the `/fork`
background copy and `/branch`. Before host v2.1.214 a fork reported `resume` and the
four-source matcher caught it by accident; from v2.1.214 it reports `fork` and the matcher
stopped catching it. `session-start.mjs` is the hook that derives the run id, arms the
cold-start window, writes `status/<run_id>.json` and injects the steer block — so the miss did
not cost a section, it cost the whole feature, in exactly the sessions a user branched
*because* the work mattered.

Everything below was executed on **2026-08-19** against **Claude Code 2.1.235** and, for §7,
`https://api.mubit.ai`, from the worktree `feat/hook-fork-matcher`. The **Expect** blocks are
transcripts, not predictions. Where a value is machine-specific the text says so.

**Time:** ~6 minutes for §0–§4 (offline), ~10 more for §5–§7.
**Destroys:** nothing. Everything lives in four `/tmp` directories you delete in §8. Your
installed plugin and its memory are never touched.

§1–§4 are **offline and deterministic** — they need no network and no model call, and they are
the sections that prove the mechanism. §5–§6 drive the real host and spend four very small
headless model calls. §7 is the only section that talks to a Mubit instance.

---

## §0 — Setup, one paste

Two traps decide whether the rest of this file works, and both bite silently — a stale
`MUBIT_ENDPOINT` beats the key you signed in with, and `MUBIT_CC_DATA_DIR` redirects every byte
of state. Check before you start:

```bash
env | grep -iE '^(MUBIT|CLAUDE_PLUGIN)' | sed 's/\(MUBIT_API_KEY=.\{0,10\}\).*/\1…/' | sort
```

**Expect nothing at all.** Anything printed there is already steering the plugin. Hooks read
the environment of the Claude Code process fixed at launch, so you cannot correct it from
inside a running session — start a clean shell.

Now paste this whole block into the terminal you will use for the rest of the run:

```bash
export PLUG=$HOME/src/claude-plugins/integrations/claude-code
export SCRATCH=/tmp/mubit-hs1
export DATA=/tmp/mubit-hs1-data

rm -rf "$SCRATCH" "$DATA" && mkdir -p "$SCRATCH" "$DATA"
cd "$SCRATCH" && git init -q && echo "# scratch" > README.md
git add -A && git -c user.email=you@example.com -c user.name=you commit -qm init

export MUBIT_CC_DATA_DIR="$DATA"
export MUBIT_ENDPOINT=https://api.mubit.ai
export MUBIT_API_KEY=$(node -e 'process.stdout.write(require(process.env.HOME+"/.claude/plugins/data/mubit-memory-mubit/credentials.json").apiKey)')
export MUBIT_CC_LOG_LEVEL=debug

echo "plugin   $PLUG"
echo "data     $DATA"
echo "scratch  $SCRATCH"
echo "endpoint $MUBIT_ENDPOINT"
echo "key      ${MUBIT_API_KEY:0:8}… (${#MUBIT_API_KEY} chars)"
echo "host     $(claude --version)"
```

**Expect**

```
plugin   $HOME/src/claude-plugins/integrations/claude-code
data     /tmp/mubit-hs1-data
scratch  /tmp/mubit-hs1
endpoint https://api.mubit.ai
key      mbt_mubi… (105 chars)
host     2.1.235 (Claude Code)
```

Read the **host** line first. On anything below 2.1.214 a forked session still reports
`resume`, the old matcher already caught it, and §5 will show you `resume` where this file
shows `fork` — the bug this ticket fixes does not exist on that host.

The key is read out of the credential file rather than typed, so it never enters your shell
history. §1–§6 do not use it; only §7 does.

Now the stand-in Mubit that §1–§3 run against. It answers the four routes SessionStart
touches and logs what was asked for — health as the bare string `OK` (§1.2), not JSON, because
a hook that `JSON.parse`s it reports every healthy server as down:

```bash
cat > "$SCRATCH/stub-mubit.mjs" <<'EOF'
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
const LOG = process.argv[2];
writeFileSync(LOG, '');
createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    appendFileSync(LOG, `${req.method} ${req.url} ${body}\n`);
    if (req.url === '/v2/core/health') {
      res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('OK');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === '/v2/control/lessons'
      ? JSON.stringify({ lessons: [{ lesson_id: 'les_g1', type: 'rule',
          content: 'Run the migration before the backfill.' }] })
      : '{}');
  });
}).listen(3199, '127.0.0.1', () => console.log('stub on http://127.0.0.1:3199'));
EOF
echo written
```

**Expect** `written`.

---

## §1 — Offline: the built hook on `source: "fork"`

This is the mechanism, and it runs against `hooks/dist/session-start.mjs` — the **shipped
bundle**, not `hooks/src`. An unbuilt change is a change that does nothing, so the offline core
deliberately never touches the source tree.

The seeded `sessions/<host_session_id>.json` is the §4.3 SessionRecord of the conversation this
fork branches from. Its `run_id` is `cc-parent-11112222`, which no run-id strategy would ever
derive from this directory — so "it reused the parent's run" is observable rather than inferred.

```bash
rm -rf "$DATA" && mkdir -p "$DATA/sessions"
node "$SCRATCH/stub-mubit.mjs" "$SCRATCH/wire.log" >/dev/null & STUB=$!
until curl -sf http://127.0.0.1:3199/v2/core/health >/dev/null; do :; done

cat > "$DATA/sessions/4f21ab90-1c2d-4e5f-8a9b-0c1d2e3f4a5b.json" <<'EOF'
{"run_id":"cc-parent-11112222","agent_id":"claude-code","strategy":"per-directory",
 "project_dir":"/tmp/mubit-hs1","created_at":1755500000000,"last_seen_at":1755500000000,
 "mode":"local","clear_count":0,"endpoint_hash":"deadbeefcafe"}
EOF

: > "$SCRATCH/wire.log"          # drop the readiness probe above
cd "$SCRATCH"
printf '%s' '{"session_id":"4f21ab90-1c2d-4e5f-8a9b-0c1d2e3f4a5b","cwd":"/tmp/mubit-hs1","hook_event_name":"SessionStart","source":"fork"}' \
 | MUBIT_CC_DATA_DIR="$DATA" MUBIT_ENDPOINT=http://127.0.0.1:3199 MUBIT_API_KEY=mbt_stub \
   node "$PLUG/hooks/dist/session-start.mjs" \
 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
     console.log(j.hookSpecificOutput.additionalContext.split("\n").slice(0,3).join("\n"));
     console.log("systemMessage:", j.systemMessage);})'
kill $STUB 2>/dev/null
echo "--- wire (method + path, in order) ---"; cut -d' ' -f1,2 "$SCRATCH/wire.log"
echo "--- run_id sent ---"; grep -o '"run_id":"[^"]*"' "$SCRATCH/wire.log" | sort -u
echo "--- \$DATA/status ---"; ls "$DATA/status"
```

**Expect**

```
# Mubit memory is active

Run: cc-parent-11112222 (hosted)
systemMessage: mubit: hosted · run cc-parent-11112222 · 1 global lesson
--- wire (method + path, in order) ---
GET /v2/core/health
POST /v2/control/agents/heartbeat
POST /v2/control/lessons
--- run_id sent ---
"run_id":"cc-parent-11112222"
--- $DATA/status ---
cc-parent-11112222.json
health.json
```

Read **the wire block** first — three calls, and the middle one is `heartbeat`, not `register`.
That is the one place in `session-start.mjs` where the `fork`/`startup` distinction is
load-bearing: `deriveAgentId` returns the bare role for a parent session
(`lib/runid.mjs:287`), so the agent the forked-from conversation announced *is* this agent, and
announcing it again is the reconciliation noise the `resume` branch already exists to avoid.

Then read **run_id**: one value on every call, and it is the parent's. Then
**`$DATA/status`** — `status/cc-parent-11112222.json` is the marker `bin/statusline.mjs`
renders and every later hook in this session reads back. Without it a forked session shows no
memory state at all.

The steer block's first three lines and the `1 global lesson` in `systemMessage` are the claim
itself: the fork was handed the run and the standing lessons a resumed session is handed.

---

## §2 — Offline: the same payload, `source: "startup"`

The control. Change one word and the hook must behave differently, or the branch in §1 is
decoration.

```bash
rm -rf "$DATA" && mkdir -p "$DATA/sessions"
node "$SCRATCH/stub-mubit.mjs" "$SCRATCH/wire.log" >/dev/null & STUB=$!
until curl -sf http://127.0.0.1:3199/v2/core/health >/dev/null; do :; done
cat > "$DATA/sessions/4f21ab90-1c2d-4e5f-8a9b-0c1d2e3f4a5b.json" <<'EOF'
{"run_id":"cc-parent-11112222","agent_id":"claude-code","strategy":"per-directory",
 "project_dir":"/tmp/mubit-hs1","created_at":1755500000000,"last_seen_at":1755500000000,
 "mode":"local","clear_count":0,"endpoint_hash":"deadbeefcafe"}
EOF
: > "$SCRATCH/wire.log"
cd "$SCRATCH"
printf '%s' '{"session_id":"4f21ab90-1c2d-4e5f-8a9b-0c1d2e3f4a5b","cwd":"/tmp/mubit-hs1","hook_event_name":"SessionStart","source":"startup"}' \
 | MUBIT_CC_DATA_DIR="$DATA" MUBIT_ENDPOINT=http://127.0.0.1:3199 MUBIT_API_KEY=mbt_stub \
   node "$PLUG/hooks/dist/session-start.mjs" \
 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("systemMessage:",JSON.parse(s).systemMessage))'
kill $STUB 2>/dev/null
echo "--- wire ---"; cut -d' ' -f1,2 "$SCRATCH/wire.log"
echo "--- run_id sent ---"; grep -o '"run_id":"[^"]*"' "$SCRATCH/wire.log" | sort -u
```

**Expect** — the run id is directory-derived and so depends on `$SCRATCH`; on another path the
hash after `cc-mubit-hs1-` differs:

```
systemMessage: mubit: hosted · run cc-mubit-hs1-3ccf98a8 · 1 global lesson
--- wire ---
GET /v2/core/health
POST /v2/control/agents/register
POST /v2/control/lessons
--- run_id sent ---
"run_id":"cc-mubit-hs1-3ccf98a8"
```

Read the middle wire line against §1's: `register` here, `heartbeat` there. And read the run
id: `startup` means *fresh means fresh*, so the seeded mapping is discarded
(`lib/runid.mjs:150-154`) — which is precisely the behaviour a fork must not get.

---

## §3 — Offline: the shape a real fork actually arrives in

§1 seeded a session map the fork could look up. A live fork cannot: it carries a **brand-new
`session_id`** and no pointer whatsoever back to the parent. Captured verbatim from the host in
§5 below:

```json
{"session_id":"e8303836-739a-45da-a09a-5861b96df5d1",
 "transcript_path":"…/e8303836-739a-45da-a09a-5861b96df5d1.jsonl",
 "cwd":"/private/tmp/mubit-hs1","hook_event_name":"SessionStart","source":"fork"}
```

So on the first SessionStart of a fork there is no mapping to reuse, `resolveRunId` falls
through to `deriveFresh` (`lib/runid.mjs:155-157`), and continuity becomes the run **strategy's**
job. Under the default `per-directory` the fork derives the very run its parent derived from the
same directory. This is what makes the matcher fix sufficient rather than merely necessary —
without it the hook would fire and still hand the fork a stranger's run.

```bash
rm -rf "$DATA" && mkdir -p "$DATA"
node "$SCRATCH/stub-mubit.mjs" "$SCRATCH/wire.log" >/dev/null & STUB=$!
until curl -sf http://127.0.0.1:3199/v2/core/health >/dev/null; do :; done
: > "$SCRATCH/wire.log"
cd "$SCRATCH"
run() { printf '%s' "$1" | MUBIT_CC_DATA_DIR="$DATA" MUBIT_ENDPOINT=http://127.0.0.1:3199 \
  MUBIT_API_KEY=mbt_stub node "$PLUG/hooks/dist/session-start.mjs" >/dev/null; }
run '{"session_id":"c937202b-b931-4f85-8b8c-de35800bb5c0","cwd":"/tmp/mubit-hs1","hook_event_name":"SessionStart","source":"startup"}'
run '{"session_id":"3847fd5d-7194-416d-a38a-ae5761e86230","cwd":"/tmp/mubit-hs1","hook_event_name":"SessionStart","source":"fork"}'
kill $STUB 2>/dev/null
echo "--- wire ---"; cut -d' ' -f1,2 "$SCRATCH/wire.log"
echo "--- run_id per call ---"; grep -o '"run_id":"[^"]*"' "$SCRATCH/wire.log"
echo "--- both session records point where? ---"
node -e 'const fs=require("fs"),p=process.env.DATA+"/sessions";
 for(const f of fs.readdirSync(p))console.log(f.slice(0,8)+"…",JSON.parse(fs.readFileSync(p+"/"+f,"utf8")).run_id)'
echo "--- \$DATA/status ---"; ls "$DATA/status"
```

**Expect**

```
--- wire ---
GET /v2/core/health
POST /v2/control/agents/register
POST /v2/control/lessons
POST /v2/control/agents/heartbeat
POST /v2/control/lessons
--- run_id per call ---
"run_id":"cc-mubit-hs1-3ccf98a8"
"run_id":"cc-mubit-hs1-3ccf98a8"
--- both session records point where? ---
3847fd5d… cc-mubit-hs1-3ccf98a8
c937202b… cc-mubit-hs1-3ccf98a8
--- $DATA/status ---
cc-mubit-hs1-3ccf98a8.json
health.json
```

Read the **two run ids** first: identical, from two sessions that share nothing but a
directory. Then the two session records — the fork gets its *own* map entry beside the
parent's rather than over it, so every later hook in the forked session resolves the run
without re-deriving, and the parent goes on resolving too. One marker, one run.

Only one `GET /v2/core/health` appears for two sessions: health is cached in
`status/health.json`, so the fork's probe was served from disk.

---

## §4 — Offline: the shipped path and the gates

```bash
cd "$PLUG"
node -e 'console.log(require("./hooks/hooks.json").hooks.SessionStart[0].matcher)'
grep -o '=== .resume. || [a-zA-Z]* === .fork.' hooks/dist/impl/session-start.mjs
node scripts/verify-manifests.mjs
```

**Expect**

```
startup|resume|clear|compact|fork
=== "resume" || src === "fork"
verify-manifests: all manifest checks passed (§12.7)
```

The `grep` is the one that matters: `hooks.json` names a launcher stub, and the real code is
`hooks/dist/impl/`. A matcher widened without a rebuild fires the hook and then re-registers.

Then the suite, twice — once against `hooks/src`, once against the bundles:

```bash
npm test 2>&1 | tail -5
npm run test:dist 2>&1 | tail -5
```

**Expect** both:

```
# pass 887
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

887 rather than the 886 of the previous baseline: two new tests in
`test/session-start.test.mjs`, minus one superseded by the first of them.

---

## §5 — Host-driven: what a fork actually sends, and what matches it

**Not offline.** This spends two very small headless model calls and needs an authenticated
`claude`. It uses no Mubit instance and no plugin — just a probe hook that dumps its stdin, so
the answer is about the *host*, not about this plugin.

Four SessionStart groups: the matcher the plugin shipped, the matcher it ships now, `fork`
alone, and a group with no matcher at all as the ground truth.

```bash
mkdir -p "$SCRATCH/probe"
cat > "$SCRATCH/probe/dump.mjs" <<'EOF'
import { appendFileSync } from 'node:fs';
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  appendFileSync(`${process.env.PROBE_DIR}/${process.argv[2]}`, `${raw.trim()}\n`);
  process.stdout.write('{}');
});
EOF
cat > "$SCRATCH/probe/settings.json" <<EOF
{
  "env": { "PROBE_DIR": "$SCRATCH/probe" },
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume|clear|compact",
        "hooks": [ { "type": "command", "command": "node", "timeout": 5,
          "args": ["$SCRATCH/probe/dump.mjs", "four-source.log"] } ] },
      { "matcher": "startup|resume|clear|compact|fork",
        "hooks": [ { "type": "command", "command": "node", "timeout": 5,
          "args": ["$SCRATCH/probe/dump.mjs", "five-source.log"] } ] },
      { "matcher": "fork",
        "hooks": [ { "type": "command", "command": "node", "timeout": 5,
          "args": ["$SCRATCH/probe/dump.mjs", "fork-only.log"] } ] },
      { "hooks": [ { "type": "command", "command": "node", "timeout": 5,
          "args": ["$SCRATCH/probe/dump.mjs", "match-all.log"] } ] }
    ]
  }
}
EOF
rm -f "$SCRATCH"/probe/four-source.log "$SCRATCH"/probe/five-source.log \
      "$SCRATCH"/probe/fork-only.log "$SCRATCH"/probe/match-all.log
cd "$SCRATCH"
SID=$(node -e 'console.log(crypto.randomUUID())')
claude -p "Reply with exactly: ok" --session-id "$SID" \
  --settings "$SCRATCH/probe/settings.json" --model haiku --permission-mode plan </dev/null >/dev/null 2>&1
claude -p "Reply with exactly: ok" --fork-session --resume "$SID" \
  --settings "$SCRATCH/probe/settings.json" --model haiku --permission-mode plan </dev/null >/dev/null 2>&1
for f in four-source five-source fork-only match-all; do
  printf '%-14s ' "$f"
  node -e 'try{console.log(require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(l=>JSON.parse(l).source).join(", "))}catch{console.log("(never fired)")}' "$SCRATCH/probe/$f.log"
done
echo "--- the fork payload, verbatim ---"
node -e 'const ls=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n");
 console.log(JSON.stringify(JSON.parse(ls[ls.length-1]),null,2))' "$SCRATCH/probe/match-all.log"
```

**Expect** — the two UUIDs are per-run:

```
four-source    startup
five-source    startup, fork
fork-only      fork
match-all      startup, fork
--- the fork payload, verbatim ---
{
  "session_id": "e8303836-739a-45da-a09a-5861b96df5d1",
  "transcript_path": "$HOME/.claude/projects/-private-tmp-mubit-hs1/e8303836-739a-45da-a09a-5861b96df5d1.jsonl",
  "cwd": "/private/tmp/mubit-hs1",
  "hook_event_name": "SessionStart",
  "source": "fork"
}
```

Read **`four-source`** first. It logged the startup and *nothing else* — that line is the bug,
reproduced: on this host a fork does not match `startup|resume|clear|compact`, so the plugin's
SessionStart never ran in a forked session. `five-source` logged both, which is the fix, and
`fork-only` confirms the host treats the `|` list as exact-string alternation rather than a
regex needing anchors.

Then read the payload. The `session_id` is not the parent's, and there is no field anywhere in
it that names the parent — which is why §3 exists.

---

## §6 — Host-driven: the regression, before and after

**Not offline.** Four more small headless calls. This is the only section that runs the real
plugin through a real fork.

The discriminator is not the marker *file* — `prompt-recall`, `stage-prompt`, `capture` and
`Stop` all merge their own slice into it, so it reappears whatever happens. It is two fields
that `session-start.mjs` alone writes: `cold_start_until` (line 163) and `lessons.checked_at`
(line 272). Delete `status/` after the parent turn and only a SessionStart can put them back.

```bash
export OLD=/tmp/mubit-hs1-oldplug
rm -rf "$OLD" && mkdir -p "$OLD"
rsync -a --exclude node_modules --exclude test --exclude .git "$PLUG"/ "$OLD"/
node -e 'const f="/tmp/mubit-hs1-oldplug/hooks/hooks.json",fs=require("fs");
 fs.writeFileSync(f, fs.readFileSync(f,"utf8").replace("startup|resume|clear|compact|fork","startup|resume|clear|compact"));'

export DATA=/tmp/mubit-hs1-e2e
export MUBIT_CC_DATA_DIR="$DATA"
cat > "$SCRATCH/show.mjs" <<'EOF'
import { readdirSync, readFileSync } from 'node:fs';
const p = `${process.env.MUBIT_CC_DATA_DIR}/status`;
let files = []; try { files = readdirSync(p); } catch {}
const m = files.find((f) => f !== 'health.json');
const j = m ? JSON.parse(readFileSync(`${p}/${m}`, 'utf8')) : null;
console.log(`${process.argv[2].padEnd(20)} marker ${m ?? '(none)'}`
  + `  cold_start_until ${j?.cold_start_until ? 'set' : 'ABSENT'}`
  + `  lessons.checked_at ${j?.lessons?.checked_at ? 'set' : 'ABSENT'}`);
EOF
cd "$SCRATCH"
probe() {   # $1 = plugin dir, $2 = label
  rm -rf "$DATA" && mkdir -p "$DATA"
  local sid; sid=$(node -e 'console.log(crypto.randomUUID())')
  claude --plugin-dir "$1" -p "Reply with exactly: ok" --session-id "$sid" --model haiku </dev/null >/dev/null 2>&1
  node "$SCRATCH/show.mjs" "$2 parent"
  rm -rf "$DATA/status"
  claude --plugin-dir "$1" -p "Reply with exactly: ok" --fork-session --resume "$sid" --model haiku </dev/null >/dev/null 2>&1
  node "$SCRATCH/show.mjs" "$2 fork"
}
probe "$OLD"  "old matcher"
probe "$PLUG" "this build"
```

**Expect**

```
old matcher parent   marker cc-mubit-hs1-3ccf98a8.json  cold_start_until set  lessons.checked_at set
old matcher fork     marker cc-mubit-hs1-3ccf98a8.json  cold_start_until ABSENT  lessons.checked_at ABSENT
this build parent    marker cc-mubit-hs1-3ccf98a8.json  cold_start_until set  lessons.checked_at set
this build fork      marker cc-mubit-hs1-3ccf98a8.json  cold_start_until set  lessons.checked_at set
```

Read **line 2 against line 4**. Same host, same project, same fork, one word of difference in
`hooks/hooks.json`: with the old matcher a forked session opened with no cold-start window, no
lesson fetch and no injected steer; with this build it opens with all three, on the run its
parent was using.

Both markers carry the same run id in every row, which is §3 holding at the host level rather
than at the payload level.

> If both `fork` rows read `ABSENT`, check the **host** line from §0. On a host below 2.1.214 a
> fork reports `resume`, and neither build will show you a difference.

---

## §7 — Live: the same fork against `https://api.mubit.ai`

**Not offline, and the only section that needs the API key.** §1–§3 prove the mechanism against
a stub precisely so that this section may be slow, or down, without costing you the run.

```bash
export DATA=/tmp/mubit-hs1-live
rm -rf "$DATA" && mkdir -p "$DATA"
cd "$SCRATCH"
SID_A=$(node -e 'console.log(crypto.randomUUID())')
SID_B=$(node -e 'console.log(crypto.randomUUID())')
for pair in "startup:$SID_A" "fork:$SID_B"; do
  src=${pair%%:*}; sid=${pair##*:}
  printf '{"session_id":"%s","cwd":"/tmp/mubit-hs1","hook_event_name":"SessionStart","source":"%s"}' "$sid" "$src" \
   | MUBIT_CC_DATA_DIR="$DATA" node "$PLUG/hooks/dist/session-start.mjs" \
   | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(process.argv[1].padEnd(8),"->",JSON.parse(s).systemMessage))' "$src"
done
MUBIT_CC_DATA_DIR="$DATA" node -e '
const fs=require("fs"),p=process.env.MUBIT_CC_DATA_DIR+"/status";
const f=fs.readdirSync(p).find(x=>x!=="health.json");
const m=JSON.parse(fs.readFileSync(p+"/"+f,"utf8"));
console.log(f);console.log(JSON.stringify({mode:m.mode,state:m.state,lessons:m.lessons},null,2));'
```

**Expect** — `checked_at` is a live timestamp:

```
startup  -> mubit: hosted · run cc-mubit-hs1-3ccf98a8 · 0 global lessons
fork     -> mubit: hosted · run cc-mubit-hs1-3ccf98a8 · 0 global lessons
cc-mubit-hs1-3ccf98a8.json
{
  "mode": "hosted",
  "state": "ready",
  "lessons": {
    "global": 0,
    "checked_at": 1787152769778,
    "injected_ids": [],
    "credited_at": 0
  }
}
```

Read **`state`** first: `ready` means the fork's `heartbeat` and `lessons` calls both reached
the hosted control plane and both were accepted — health alone would not prove that, because
health is allowlisted before authentication and answers `OK` for a wrong key, an expired key
and no key at all.

`0 global lessons` is what this instance returns today, not a fault in the hook; the rendering
of a non-empty list is what §1's stub pins. If your instance has global lessons the count will
be non-zero and `injected_ids` non-empty.

Finally, the same fact in the inspector's own terms — note both sessions filed under one run:

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --data /tmp/mubit-hs1-e2e --run cc-mubit-hs1-3ccf98a8 --last 40
```

**Expect** (from the §6 data dir, so two prompts — the parent turn and the forked turn):

```
run cc-mubit-hs1-3ccf98a8   hosted   ● ready   (data: /tmp/mubit-hs1-e2e)

prompt     when      rung  src  tok  chars  drop  empty_reason  used(m/c)  outcome
0b4518d0…  16:15:34     1    0    0      0     0  no_evidence   0/0 ?      pending
ed1d8fa2…  16:16:01     1    0    0      0     0  no_evidence   0/0 ?      pending

totals      2 prompts · 0 tok injected · 0 sources · 0/2 prompts got an injection
```

Read **the run header and the row count together**: two prompts from two different host
sessions, one of which was a fork, on a single run. That is the whole claim — the fork's turn
is filed against the parent's memory rather than against a run of its own.

`no_evidence` on a run this new is correct: memory is scoped per run and this run has nothing
yet. `--data` is not optional here — without it `mubit-inspect` reads every
`~/.claude/plugins/data/mubit-memory*` directory and will show you your installed plugin's runs
instead of this one.

> Where a step depends on the endpoint being fast: `MUBIT_CC_RECALL_BUDGET_MS` defaults to
> 1,500 ms, and a local server answers in 1.4–2.3 s. Raise it before blaming the hook if you
> point this file at a local instance.

---

## §8 — Clean up

```bash
rm -rf /tmp/mubit-hs1 /tmp/mubit-hs1-data /tmp/mubit-hs1-e2e /tmp/mubit-hs1-live /tmp/mubit-hs1-oldplug
unset MUBIT_CC_DATA_DIR MUBIT_ENDPOINT MUBIT_API_KEY MUBIT_CC_LOG_LEVEL PLUG SCRATCH DATA OLD
```

The six forked and parent sessions §5–§6 created live in `~/.claude/projects/` like any other
session and are harmless; delete that project directory too if you want the machine clean.
