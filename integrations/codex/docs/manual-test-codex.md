# Manual test — mubit-memory 0.10.0 under Codex

Drive the plugin the way a user meets it: installed from a marketplace into a real Codex, set
up the way `mubit-memory:setup` sets it up, and then measured on what actually happened rather
than on what should have.

Everything below was executed on 2026-08-21 against `codex-cli 0.146.0` with this build. The
**Expect** blocks are transcripts, not predictions.

**Time:** ~15 minutes.
**Destroys:** nothing. Every byte lives in two temp directories you delete in §7, and
`CODEX_HOME` is redirected in §1 before any `codex` runs.

---

## §1 — Isolate, and stand up a fake Mubit

Never point this at your real `~/.codex`: §3 writes hook registrations that fire on every
session, §3 records trust hashes in `config.toml`, and §3 adds a global MCP server.

```bash
export E=$(mktemp -d)/e2e
mkdir -p $E/{codexhome,proj,out,data}
export CODEX_HOME=$E/codexhome
cp ~/.codex/auth.json $CODEX_HOME/auth.json
printf 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "low"\n' > $CODEX_HOME/config.toml
cd $E/proj && git init -q
printf '# e2e repo\n\nThis repository exists to exercise the Mubit Codex plugin end to end.\n' > README.md
```

The fake Mubit is a `node:http` server on `127.0.0.1:0` that answers the five routes the
plugin uses and appends every request to a log. It is what makes the assertions in §5 exact:
a stopwatch can be talked out of noticing a call, a request log cannot.

```bash
node <<'EOF' > /dev/null &
# (see the source in the runbook's §1 listing — health → "OK", query → {results:[]},
#  ingest → {job_id}, reflect → {lessons:[]}, checkpoint → {checkpoint_id}, and every
#  request appended to $E/out/wire.jsonl)
EOF
export MUBIT_ENDPOINT=$(cat $E/out/url.txt)
export MUBIT_API_KEY=mbt_e2e_0123456789abcdef_deadbeefcafebabe0123456789abcdef
export MUBIT_CC_DATA_DIR=$E/data
export MUBIT_CC_LOG_LEVEL=debug
```

`MUBIT_CC_DATA_DIR` is pinned rather than left to the default on purpose. The default is
`~/.claude/plugins/data/mubit-memory` — shared with the Claude Code plugin, deliberately — and
you do not want this run's markers mixed into the memory you actually use.

---

## §2 — Install

```bash
codex plugin marketplace add /path/to/claude-plugins
codex plugin add mubit-memory@mubit --json
```

**Expect**

```json
{
  "pluginId": "mubit-memory@mubit",
  "name": "mubit-memory",
  "marketplaceName": "mubit",
  "version": "0.10.0",
  "installedPath": "…/codexhome/plugins/cache/mubit/mubit-memory/0.10.0",
  "authPolicy": "ON_USE"
}
```

Note `installedPath`. **Install is a copy, not a link** — editing the source tree has no effect
until `codex plugin remove && codex plugin add`, and every path §3 writes points into that
copy. Confirm the committed artifacts survived the copy:

```bash
export ROOT=$CODEX_HOME/plugins/cache/mubit/mubit-memory/0.10.0
ls $ROOT/hooks/dist/capture.mjs $ROOT/mcp/dist/index.js $ROOT/mcp/dist/server.js
```

**Expect** all three. They are tracked artifacts; there is no build step at install time.

---

## §3 — What `mubit-memory:setup` does, done by hand

Doing it by hand once is worth more than trusting the skill, because it is also a test of the
skill's instructions.

### Merge the registrations

```bash
node -e '
const fs=require("fs"); const root=process.argv[1], out=process.argv[2];
const tpl=JSON.parse(fs.readFileSync(root+"/hooks.json","utf8"));
const sub=(s)=>s.split("{{PLUGIN_ROOT}}").join(root); const hooks={};
for (const [ev,g] of Object.entries(tpl.hooks)) {
  if (ev==="PreToolUse") continue;            // MUBIT_CC_PRE_TOOL_WARNINGS is off
  hooks[ev]=g.map(x=>({...x,hooks:x.hooks.map(h=>({...h,command:sub(h.command)}))}));
}
fs.writeFileSync(out, JSON.stringify({description:"Mubit Memory 0.10.0 (installed by mubit-memory:setup)",hooks},null,2)+"\n");
console.log("merged", Object.keys(hooks).length, "events");
' $ROOT $CODEX_HOME/hooks.json
```

**Expect** `merged 10 events`. Ten, not eleven: `PreToolUse` is omitted because the warnings it
exists for are off, and Codex has no `if:` predicate to gate it with — a registered
`PreToolUse` costs a process spawn per matching tool call whether the feature is on or not.

### Register the MCP server

```bash
codex mcp add mubit -- node $ROOT/mcp/dist/index.js
codex mcp list
```

**Expect**

```
Added global MCP server 'mubit'.
Name   Command  Args                                        Env  Cwd  Status   Auth
mubit  node     …/mubit-memory/0.10.0/mcp/dist/index.js     -    -    enabled  Unsupported
```

The name must be `mubit`: the model sees `mcp__<server>__<tool>`, and every skill in the plugin
names `mcp__mubit__…`.

### Trust the hooks

Untrusted hooks are skipped **silently** under `codex exec`. Ask Codex what it currently sees,
then record the hash of each:

```bash
# hooks/list over the app-server gives {key, currentHash, trustStatus} per registration;
# each pair goes into config.toml as [hooks.state."<key>"] trusted_hash = "<currentHash>".
```

**Expect** eleven rows flipping from `untrusted` to `trusted`:

```
permissionRequest trusted sha256:0a7114ca3176b | hooks.json:permission_request:0:0
postToolUse       trusted sha256:ed4fb5a7ffdea | hooks.json:post_tool_use:0:0
preCompact        trusted sha256:90c5de73ea80c | hooks.json:pre_compact:0:0
postCompact       trusted sha256:828f355476f4a | hooks.json:post_compact:0:0
sessionStart      trusted sha256:7da3110eccde8 | hooks.json:session_start:0:0
sessionEnd        trusted sha256:6959e52c3a1a1 | hooks.json:session_end:0:0
userPromptSubmit  trusted sha256:3b50133e6a871 | hooks.json:user_prompt_submit:0:0
userPromptSubmit  trusted sha256:da7a20ddad28a | hooks.json:user_prompt_submit:0:1
subagentStart     trusted sha256:8d045ea0318cc | hooks.json:subagent_start:0:0
subagentStop      trusted sha256:2fa1233435cab | hooks.json:subagent_stop:0:0
stop              trusted sha256:91c940b3eed02 | hooks.json:stop:0:0
```

Eleven rows for ten events, because `UserPromptSubmit` carries two handlers — `prompt-recall`
at `:0:0` and `stage-prompt` at `:0:1`. The key format is
`<sourcePath>:<snake_event>:<groupIndex>:<handlerIndex>`, so the second handler is a separate
trust decision and it is the one that stages the turn. Trusting only the first gives you
recall with nothing to attribute it against.

---

## §4 — One turn, end to end

```bash
cd $E/proj
codex exec --json --skip-git-repo-check -C $E/proj \
  'read README.md and tell me what this repo is' < /dev/null
```

**Expect** an ordinary answer:

```json
{"type":"agent_message","text":"This is a minimal end-to-end test repository for exercising the Mubit Codex plugin. The README doesn't describe any production application or additional functionality."}
```

---

## §5 — Assert on what happened, not on what should have

### The hooks are not merely running — they are being accepted

Do this one first, because a hook can run, do its whole job correctly, and still be reported to
the user as failed. Codex validates a hook's stdout twice: against a generated JSON Schema, and
then against a set of semantic rules the schema does not carry. Output that clears the schema
and breaks a rule is discarded with a message per invocation:

```
• PostToolUse hook (failed)
  error: PostToolUse hook returned unsupported suppressOutput
```

That failure does **not** appear as a `type:"error"` item in the `codex exec --json` stream, so
none of the assertions below will catch it. It is worth its own check, and the check needs no
model call and no network — pipe a payload through the hook Codex would run and read what comes
back:

```bash
E=$(mktemp -d); mkdir -p $E/data
for spec in "PreToolUse pre-tool" "PermissionRequest capture --permission" "PostToolUse capture"; do
  set -- $spec; event=$1; hook=$2; shift 2
  printf '%s' "{\"hook_event_name\":\"$event\",\"session_id\":\"01a0240c-7f5a-7de0-b4e4-caa34b796e11\",\"turn_id\":\"01a0240c-7f97-7ca3-a641-cf8d141498a0\",\"cwd\":\"$E\",\"model\":\"gpt-5.6-sol\",\"permission_mode\":\"default\",\"transcript_path\":\"$E/r.jsonl\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo hi\"},\"tool_response\":\"hi\",\"tool_use_id\":\"exec-1\"}" \
  | env MUBIT_CC_HOST=codex MUBIT_CC_DATA_DIR=$E/data MUBIT_CC_RUN_STRATEGY=static \
        MUBIT_CC_RUN_ID=hookcheck MUBIT_CC_ENDPOINT=http://127.0.0.1:9 \
        node $PLUGIN_ROOT/hooks/dist/$hook.mjs "$@" \
  | xargs -0 printf "%-18s %s\n" "$event"
done
```

**Expect** an empty object from each, and in particular **no `suppressOutput` key**:

```
PreToolUse         {}
PermissionRequest  {}
PostToolUse        {}
```

`{"suppressOutput":true}` here is the bug, not a variant: those three events reject the field,
and the other eight accept it. `test/fixtures/codex-output-rules.json` holds the extracted rule
table and `npm test -- test/codex-payload.test.mjs` drives every hook against all of it, which
is the exhaustive form of this check.

### The steer block reached the model

```bash
grep -o 'Mubit memory is active' $CODEX_HOME/sessions/*/*/*/*.jsonl
```

**Expect** a hit, in a `developer`-role `response_item`:

```
# Mubit memory is active

Run: cc-proj-04f45795 (hosted)
Relevant memory is injected automatically before each of your turns — no need to open a turn by searching for it.
Do search when the injected memory falls short: mubit_recall for a topic, mubit_diagnose when a command has failed, mubit_dereference for a reference_id you already hold.
Save what you learn with mubit_learned, and credit what helped with mubit_outcome. mubit-memory:remember and mubit-memory:recall are the explicit forms.
```

Note the last line: **no leading slash**. Codex lists a skill as `mubit-memory:remember` and
has no slash-command form; the block is host-aware for exactly this line.

### The wire

```bash
node -e 'const fs=require("fs");const c={};for(const r of fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse))c[r.method+" "+r.path]=(c[r.method+" "+r.path]||0)+1;console.log(c);' $E/out/wire.jsonl
```

**Expect** exactly this, and nothing else:

```js
{
  'GET /v2/core/health': 1,
  'POST /v2/control/agents/register': 1,
  'POST /v2/control/lessons': 1,
  'POST /v2/control/query': 1,
  'POST /v2/control/ingest': 1,
  'POST /v2/control/reflect': 1,
  'POST /v2/control/agents/heartbeat': 1
}
```

One `query` — the pre-prompt recall. One `ingest` — the drain, at session end, carrying the
whole turn in one batch rather than one call per tool call. One `reflect`. **No request at all
on the `PostToolUse` path**, which is the property the whole capture design exists to have.

The two that matter most, in full:

```
REGISTER: {"run_id":"cc-proj-04f45795","agent_id":"codex","role":"worker","status":"active",
           "capabilities":["code","shell","edit","search"]}

INGEST run_id: cc-proj-04f45795  items: 2
   - tool_output | low    | Bash(command=sed -n '1,240p' README.md) -> # e2e repo  This repository exists…
   - task_result | medium | Q: read README.md and tell me what this repo is  A: This is a minimal end-to-end…
```

Three things to read off that:

- `agent_id: "codex"`, not `claude-code`. The run is shared between the harnesses; the identity
  is not.
- The tool item has **text after the arrow**. Codex sends `tool_response` as a bare string
  where Claude Code sends `{stdout, stderr, interrupted}`; a reader that only understood the
  object shape would store `Bash(command=…) -> ` and record that a file was read without
  recording what was in it.
- The `Q:`/`A:` pair exists at all. `Stop` carries `last_assistant_message` and not the prompt,
  so the other half came out of the turn file — which is only findable if `stage-prompt` and
  `capture --stop` agree on the turn key. Under Codex that key is `turn_id`.

### The data directory

```bash
find $E/data -type f
```

**Expect**

```
$E/data/config.json
$E/data/status/cc-proj-04f45795.json
$E/data/status/health.json
$E/data/sessions/01a02441-4e1b-7a81-97d3-e49500716d40.json
$E/data/breaker/968794d552c5.json
$E/data/coldstart/968794d552c5.json
$E/data/runs/cc-proj-04f45795/jobs.json
$E/data/runs/cc-proj-04f45795/turns/01a02441-4e5d-76e0-bae2-845f8a8b3e1c.json
$E/data/runs/cc-proj-04f45795/flushed-01a02441-….marker
$E/data/logs/mubit-cc.log
```

The turn file is named after Codex's **`turn_id`**, and the run id carries the `cc-` prefix
that both harnesses share.

```bash
cat $E/data/status/cc-proj-04f45795.json
```

**Expect** `state: "ready"`, `captured.ingested: 2`, `captured.pending: 0`, and
`reflect: {status: "ok"}`. A `pending` that does not fall to zero is a drain problem; a
`reflect.status` of `handoff` minutes later means the hook was killed inside Codex's
three-second clamp before it could hand the flush over.

---

## §6 — The cross-harness claim

This is the point of the run-id decision, and it is the one thing worth testing that no unit
test can: two different binaries, one directory, one memory.

Run a Claude Code session in a fresh directory first — either interactively, or by piping the
hook payloads into `integrations/claude-code/hooks/dist/*.mjs` the way the host does — then a
Codex session in the same directory, both pointed at one `MUBIT_CC_DATA_DIR`.

```bash
ls $X/data/runs/
```

**Expect one directory, not two:**

```
cc-proj-983ba560
```

```bash
ls $X/data/runs/cc-proj-983ba560/turns/
```

**Expect two turn files, named by each host's own key:**

```
cc-p1.json                                  # Claude Code's prompt_id
01a02443-8191-74d1-a878-cd4bce420ecc.json   # Codex's turn_id
```

And on the wire, one run written by two agents:

```
run: cc-proj-983ba560  agent: claude-code
   - tool_output | Bash(command=npm run build) -> built by claude code
   - task_result | Q: how do we build this repo  A: You build it with npm run build.
run: cc-proj-983ba560  agent: codex
   - tool_output | Bash(command=git status --short) -> ?? README.md
   - task_result | Q: Run `git status --short` with the shell and say…
```

Finally, the plugin's own reader:

```bash
node ../claude-code/scripts/mubit-inspect.mjs --data $X/data --run cc-proj-983ba560
```

**Expect** both prompts under one run:

```
run cc-proj-983ba560   hosted   ● ready

prompt     when      rung  src  tok  chars  drop  ptr  empty_reason  used(m/c)  outcome
cc-p1…     13:19:47     —    0    0      0     0    0  —             —          pending
01a02443…  13:20:01     1    0    0      0     0    0  no_evidence   0/0 ?      pending

totals      2 prompts · 0 tok injected · 0 sources · 0/2 prompts got an injection
capture     tools 0 · turns 0 · pending 0 · ingested 4 · spool 0 · jobs 2
```

`0 tok injected` is correct here and not a fault: the fake Mubit answers `/v2/control/query`
with an empty result set, so there was nothing to inject. What the row proves is that the two
harnesses' turns landed in one run and one reader can see both.

---

## §7 — Tear down

```bash
codex plugin remove mubit-memory@mubit
codex plugin marketplace remove mubit
codex mcp remove mubit
pkill -f fake-mubit.mjs
rm -rf $(dirname $E) $(dirname $X)
unset CODEX_HOME E X MUBIT_ENDPOINT MUBIT_API_KEY MUBIT_CC_DATA_DIR MUBIT_CC_LOG_LEVEL
```

**Expect** your real `~/.codex/config.toml` to be byte-identical to before you started. It
never had a chance to be otherwise: `CODEX_HOME` was redirected in §1 before any `codex` ran.

---

## What this runbook does not cover

- **`PreCompact` / `PostCompact`.** A test turn is far too small to compact. The reader is
  covered by `codex-transcript.test.mjs` against a real rollout fixture, and the payload shapes
  by `codex-payload.test.mjs` against the schemas extracted from the Codex binary — but nobody
  has watched a real Codex compaction go through this plugin.
- **`PermissionRequest` on a denial.** The probe reached the event
  (`docs/harness-probe.md` §5) but a denied call under `codex exec --json` is awkward to script,
  so the "no PostToolUse ever fires" half of that mode's justification is observed rather than
  asserted here.
- **A real Mubit.** Everything above is against a loopback fake. Point `MUBIT_ENDPOINT` at
  `https://api.mubit.ai` with a real key and the same assertions hold, minus the request log —
  use `mubit-memory:doctor` and `mubit-inspect` instead.
