# Manual test — HS-2, server `instructions`

Prove by hand that a model which never saw the SessionStart preamble is still told when to
reach for Mubit — because the `initialize` frame now carries an `instructions` string, and
under Claude Code's tool search that field plus the bare tool names is all that loads at
session start.

Everything below was executed in the `feat/mcp-server-instructions` worktree on **2026-08-19**
against the bundle built there (`MUBIT_CC_BUILD_SKIP_SERVER=1 npm run build`). §6 was run
against the hosted `https://api.mubit.ai`. The **Expect** blocks are transcripts, not
predictions.

**Time:** ~8 minutes for §0–§5 offline, ~2 more for the live §6.
**Destroys:** nothing. Every byte lives in two temp directories you delete in §7. Your
installed plugin, its data directory and your Mubit memory are never written to — the only
live call in this file is a read.

> `scripts/mubit-inspect.mjs` is the read-out for most runbooks here and is **not** used in
> this one. `instructions` never touches the capture path: it is a field on a JSON-RPC frame
> that leaves through `process.stdout`, so the thing to look at is the frame itself. §0 writes
> a 45-line stdio client for exactly that.

> No step here depends on how fast the endpoint answers. The whole offline core is served from
> the server's own state with the endpoint pointed at port 1, and the one live call in §6 is a
> connectivity read. `MUBIT_CC_RECALL_BUDGET_MS` does not come into it.

---

## §0 — Setup, one paste

Two traps decide whether the rest of this file measures what you think, and both are the ones
`manual-test-0.10.0.md` §0 documents: **your shell may already point at a different Mubit**,
and **the data directory is not where the docs say**. Check the first before you start —

```bash
env | grep -iE '^(MUBIT|CLAUDE_PLUGIN)' | sed 's/\(MUBIT_API_KEY=.\{0,10\}\).*/\1…/' | sort
```

**Expect nothing at all.** Anything printed is already steering the plugin: `MUBIT_ENDPOINT`
left over from a local-server session beats the hosted key you signed in with, and
`MUBIT_CC_DATA_DIR` redirects every byte of state. Both are pinned explicitly below rather
than inherited, so paste this whole block into the terminal you will use for the rest of the
run:

```bash
export PLUG=/Users/eldaru/Mubit/hs-2-mcp-instructions/integrations/claude-code
export DATA=/tmp/mubit-hs2-data
export SCRATCH=/tmp/mubit-hs2

# a throwaway project — never run this from a Mubit repo, see the note below
rm -rf "$SCRATCH" "$DATA" && mkdir -p "$SCRATCH" "$DATA"
cd "$SCRATCH" && git init -q && echo "# scratch" > README.md
git add -A && git -c user.email=you@example.com -c user.name=you commit -qm init

# pin the target explicitly — do not rely on the ambient environment
export MUBIT_CC_DATA_DIR="$DATA"
export MUBIT_ENDPOINT=http://127.0.0.1:1     # nothing listens on port 1; §1–§5 are offline
export MUBIT_API_KEY=mbt_manual_0123456789abcdef_deadbeefcafebabe0123456789abcdef
export MUBIT_CC_RUN_STRATEGY=static
export MUBIT_CC_RUN_ID=hs2-manual
export MUBIT_CC_LOG_LEVEL=debug              # writes the ring log at $DATA/logs/mubit-cc.log

echo "plugin  $PLUG"
echo "data    $DATA"
echo "scratch $SCRATCH"
```

**Expect**

```
plugin  /Users/eldaru/Mubit/hs-2-mcp-instructions/integrations/claude-code
data    /tmp/mubit-hs2-data
scratch /tmp/mubit-hs2
```

> **Work in `$SCRATCH`, never in a Mubit repo.** Self-reference suppression drops any capture
> whose text mentions `mubit`. In a Mubit checkout the capture path looks broken and is working
> exactly as designed.

Now write the stdio client. Every section below is one invocation of it.

```bash
cat > "$SCRATCH/probe.mjs" <<'EOF'
// Speak newline-delimited JSON-RPC to an MCP server over stdio and print what came back.
//
//   node probe.mjs <entry.js> [step ...]
//
// A step is a bare method (`tools/list`) or `tools/call:<tool>`. `initialize` is always sent
// first and its whole result is printed, because that is the frame this ticket is about.
import { spawn } from 'node:child_process';

const [entry, ...steps] = process.argv.slice(2);
const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
let stderr = '', buf = '', left = steps.length;

const frame = (s, id) => (s.startsWith('tools/call:')
  ? { jsonrpc: '2.0', id, method: 'tools/call', params: { name: s.slice(11), arguments: {} } }
  : { jsonrpc: '2.0', id, method: s, params: {} });

child.stderr.on('data', (d) => { stderr += d; });
child.stdout.on('data', (d) => {
  buf += d;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1) {
      const r = msg.result;
      console.log(`initialize.protocolVersion   ${r.protocolVersion}`);
      console.log(`initialize.serverInfo        ${r.serverInfo?.name} ${r.serverInfo?.version}`);
      console.log(`initialize.instructions      ${typeof r.instructions === 'string'
        ? `${r.instructions.length} chars` : '(field absent)'}`);
      if (r.instructions) console.log(`\n--- instructions ---\n${r.instructions}\n--------------------`);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      if (!steps.length) return done();
      steps.forEach((s, n) => send(frame(s, n + 2)));
    } else if (msg.id >= 2) {
      const s = steps[msg.id - 2], r = msg.result;
      const text = r?.tools
        ? `${r.tools.length} tools: ${r.tools.map((t) => t.name).sort().join(' ')}`
        : (r?.content ?? []).map((c) => c.text ?? '').join(' ') || JSON.stringify(r ?? msg.error);
      console.log(`${s.padEnd(26)} ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
      if (--left === 0) done();
    }
  }
});
function done() {
  if (stderr.trim()) console.log(`\nstderr: ${stderr.trim()}`);
  child.kill('SIGKILL');
  process.exit(0);
}
send({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'manual', version: '1' } },
});
setTimeout(() => { console.log(`\nno answer in 15s. stderr:\n${stderr || '(silent)'}`); process.exit(1); }, 15000);
EOF
wc -l "$SCRATCH/probe.mjs"
```

**Expect**

```
      55 /tmp/mubit-hs2/probe.mjs
```

Read the line count only as a smoke test that the heredoc landed intact. If the next section
prints `no answer in 15s`, the file is truncated.

---

## §1 — The gap: there is nothing to set from the outside

Before believing the fix, see that the hole is real and that no environment variable closes
it. Run the **vendored server bundle directly** — no launcher, nothing of this plugin's in the
path:

```bash
node "$SCRATCH/probe.mjs" "$PLUG/mcp/dist/server.js"
```

**Expect**

```
initialize.protocolVersion   2024-11-05
initialize.serverInfo        mubit-memory 0.0.0-unpackaged
initialize.instructions      (field absent)
```

**Read `initialize.instructions` first.** `(field absent)` is the shipped behaviour of
`@mubit-ai/mcp` on its own: a model is offered ten tool names and no statement of when any of
them is worth reaching for. (`serverInfo` reads `0.0.0-unpackaged` here because the bundle's
`require("../package.json")` does not resolve once it is relocated to `mcp/dist/server.js` —
the launcher inlines the real version, which is why §2 shows `0.10.0` instead.)

Now check whether an env var could have done the job, which is what decides the whole shape of
the fix:

```bash
grep -aoE 'process\.env\.MUBIT_[A-Z0-9_]+' "$PLUG/mcp/dist/server.js" | sort -u
node -e '
const s = require("node:fs").readFileSync(process.env.PLUG + "/mcp/dist/server.js", "latin1");
console.log(s.slice(s.indexOf("function createServer()"), s.indexOf("function createServer()") + 150));
'
```

**Expect**

```
process.env.MUBIT_API_KEY
process.env.MUBIT_DEFAULT_SESSION_ID
process.env.MUBIT_DEFAULT_USER_ID
process.env.MUBIT_ENDPOINT
process.env.MUBIT_MCP_EXCERPT_CHARS
process.env.MUBIT_MCP_RESPONSE_FORMAT
process.env.MUBIT_MCP_TOOLS
process.env.MUBIT_MCP_VERSION
function createServer() {
  const server = new McpServer({
    name: "mubit-memory",
    version: pkg.version
  });
  const client = createMubitFacade
```

**Read the `new McpServer({...})` call first.** There is no options object — the second
argument, where `instructions` would go, is not passed at all — and none of the eight
`MUBIT_*` variables the bundle reads feeds it. So this is not a sixth environment variable;
the field has to be filled in on the frame on its way out, which is what `mcp/src/instructions.mjs`
does.

---

## §2 — The shipped frame

Same probe, one path different: the launcher `.mcp.json` actually points at.

```bash
node "$SCRATCH/probe.mjs" "$PLUG/mcp/dist/index.js"
```

**Expect**

```
initialize.protocolVersion   2024-11-05
initialize.serverInfo        mubit-memory 0.10.0
initialize.instructions      1206 chars

--- instructions ---
Mubit is this project's persistent memory: lessons, decisions and past work carried over from earlier sessions.

When to search. In the main conversation Mubit injects the memory relevant to each turn before you see it, so opening a turn by searching for that is wasted work. Search when the injected memory falls short — and always search as a subagent, which receives no injection at all and otherwise begins with no memory of this project.

Which tool. mubit_recall for a topic or question in words. mubit_diagnose when a command or test has just failed, which matches the error shape against past failures. mubit_dereference when you already hold a reference_id. mubit_lessons to review what has been learned rather than to ask a question.

What to write back. mubit_learned records one durable claim — a constraint, a fix that worked, a standing preference — stated so it is still true in a later session. It is not a session log: narrating what happened ("the user asked for X", "I refactored Y") is the common way this tool is misused, and every future recall pays for it. mubit_outcome credits the reference_ids that actually helped, which is what makes the memory that helps rank higher next time.
--------------------
```

**Read the third paragraph first — "What to write back".** That is the claim this ticket is
really making. `mubit_learned`'s own tool description says what belongs in a lesson and never
what does not, and under tool search that description is not even loaded at the moment the
model decides to write one. The sentence ruling out narration is the only place the distinction
is stated before the fact.

The second paragraph is the other half. The SessionStart preamble says the same thing about
injected memory, but it fires once in the parent conversation — `hooks.json` registers
`SessionStart` and `UserPromptSubmit` there and nowhere else — so a subagent has never seen
it. The "always search as a subagent" clause is the part the preamble structurally cannot say.

In a real session this string appears in the system prompt under **MCP Server Instructions**.

---

## §3 — Installed before the import, which is the whole correctness argument

A wrapper installed after the server module has already captured its handles does nothing.
`StdioServerTransport` takes `process.stdout` as a constructor default and holds it for the
life of the process, so the guard has to be in place before `await import('./server.js')` —
the same rule the five environment variables and the egress guard obey.

Prove it at runtime by giving the launcher a `./server.js` that reports what was already there
when it was evaluated. The launcher resolves that import relative to itself, so a copy in a
scratch directory picks up the stub instead of the real 5.9 MB bundle:

```bash
mkdir -p "$SCRATCH/stub"
cp "$PLUG/mcp/dist/index.js" "$SCRATCH/stub/index.js"
printf '{"type":"module"}\n' > "$SCRATCH/stub/package.json"
cat > "$SCRATCH/stub/server.js" <<'EOF'
process.stderr.write(`at import: fetch guard        ${JSON.stringify(globalThis.fetch?.mubitEgressGuard ?? null)}\n`);
process.stderr.write(`at import: instructions guard ${JSON.stringify(process.stdout.write?.mubitInstructionsGuard ?? null)}\n`);
EOF
node "$SCRATCH/stub/index.js"
```

**Expect**

```
at import: fetch guard        {"ceiling":"run","pinRun":true,"runId":"hs2-manual"}
at import: instructions guard {"chars":1206}
```

**Read `instructions guard` first.** A `null` there means the frame goes out exactly as the
bundle built it, with no `instructions` field — and nothing else in this file would tell you,
because the marker is the only thing that distinguishes "installed too late" from "not
installed". `1206` matches the character count §2 printed, which is how you know the launcher
handed the guard its own `INSTRUCTIONS` constant rather than some other string.

The same two lines are pinned by `test/launch.test.mjs` ("installs the instructions guard
BEFORE importing the server"), which is where the regression would be caught first.

The launcher also records the length it installed, so a session log is enough to tell whether
instructions shipped:

```bash
grep -a 'starting server' "$DATA/logs/mubit-cc.log" | tail -1
```

**Expect**

```
{"ts":"2026-08-19T15:07:46.167Z","level":"info","msg":"mcp: starting server","run_id":"hs2-manual","endpoint":"http://127.0.0.1:1","mode":"hosted","tools":10,"lesson_scope":"run","pin_run":true,"instruction_chars":1206}
```

**Read `instruction_chars`.** `0` or a missing key means a session that shipped no guidance.
Your `ts` will differ.

---

## §4 — The fall-through rule: later frames are untouched

The guard sits in `process.stdout.write`, which carries every JSON-RPC frame this server will
ever send. A wrapper that mangled the second frame would be a far worse bug than the missing
field it fixes: one stray byte on a stdio transport makes the whole server unparseable to the
host. Drive two `tools/list` calls after the rewritten handshake:

```bash
node "$SCRATCH/probe.mjs" "$PLUG/mcp/dist/index.js" tools/list tools/list \
  | grep -v -e '^Mubit is' -e '^When to' -e '^Which tool' -e '^What to' -e '^---' -e '^$'
```

**Expect** (the `grep -v` only suppresses the instructions body, which §2 already printed):

```
initialize.protocolVersion   2024-11-05
initialize.serverInfo        mubit-memory 0.10.0
initialize.instructions      1206 chars
tools/list                 10 tools: mubit_archive mubit_dereference mubit_diagnose mubit_forget mubit_learned mubit_lessons mubit_outcome mubit_recall mubit_reflect mubit_status
tools/list                 10 tools: mubit_archive mubit_dereference mubit_diagnose mubit_forget mubit_learned mubit_lessons mubit_outcome mubit_recall mubit_reflect mubit_status
```

**Read `serverInfo` on line 2 first, then the two tool lists.** `serverInfo` still being
present is the check that the guard *added* a field rather than rebuilding the frame; the two
identical tool lists are the check that it stopped looking once `initialize` had gone past.
The probe throws on any line of stdout that is not parseable JSON-RPC, so a corrupted frame
would end this step with an exception rather than a wrong answer.

---

## §5 — What it costs

`instructions` is always-loaded surface in the strictest sense: it is in the system prompt
before the model does anything, and with tool search on it loads even when the ten tool
schemas do not. So it has to be in the declared budget.

```bash
cd "$PLUG" && npm run context-cost
```

**Expect**

```
server    mubit-memory 0.10.0

  MCP tool schemas             2907 tok     7981 chars  10 tools
  server instructions           356 tok     1206 chars  loaded even under tool search
  skill frontmatter             347 tok     1165 chars  7 skills
  agent frontmatter              62 tok      214 chars  1 agents
  ——————————————————————————————————————————————————————————
  contextCost.value            3672 tok          chars

Deliberate over-estimate, not a tokenizer count: 2.88 chars/token over this surface, where a real BPE runs nearer 3.5 on schema JSON.
Method in this script's header; --json prints the raw character counts.
```

**Read the `server instructions` row first.** It did not exist before this change — the
measurement counted tool schemas and frontmatter only, so shipping this text without touching
the script would have left the declared budget silently understating the plugin by 356 tokens.
`contextCost.value` moved **3316 → 3672** for that reason and no other; the other three rows
are unchanged.

The number is declared in two places that must agree, and `verify-manifests` is the gate:

```bash
grep -n 'contextCost' "$PLUG/../../.claude-plugin/marketplace.json"
node "$PLUG/scripts/verify-manifests.mjs"
```

**Expect**

```
18:      "contextCost": { "value": 3672, "cached": 0 }
verify-manifests: all manifest checks passed (§12.7)
```

If this prints a `contextCost drift` failure instead, the stamp and the manifest disagree:
re-run `node scripts/measure-context-cost.mjs --write` and commit both files.

---

## §6 — LIVE: the hosted endpoint

> **This section talks to `https://api.mubit.ai` with your real key.** It makes one read
> (`mubit_status`) and writes nothing to your memory. Skip it and §1–§5 still prove the
> mechanism end to end — the field is filled in locally, so nothing about it depends on the
> endpoint. What this section adds is that the guard does not disturb a server which is
> actually talking to something.

```bash
export MUBIT_ENDPOINT=https://api.mubit.ai
export MUBIT_API_KEY=$(node -e 'process.stdout.write(require(process.env.HOME+"/.claude/plugins/data/mubit-memory-mubit/credentials.json").apiKey)')
echo "key ${MUBIT_API_KEY:0:8}… (${#MUBIT_API_KEY} chars)"
node "$SCRATCH/probe.mjs" "$PLUG/mcp/dist/index.js" tools/list tools/call:mubit_status \
  | grep -v -e '^Mubit is' -e '^When to' -e '^Which tool' -e '^What to' -e '^---' -e '^$'
```

**Expect**

```
key mbt_mubi… (105 chars)
initialize.protocolVersion   2024-11-05
initialize.serverInfo        mubit-memory 0.10.0
initialize.instructions      1206 chars
tools/list                 10 tools: mubit_archive mubit_dereference mubit_diagnose mubit_forget mubit_learned mubit_lessons mubit_outcome mubit_recall mubit_reflect mubit_status
tools/call:mubit_status    { "status": "connected", "endpoint": "https://api.mubit.ai", "default_session": "hs2-manual", "default_user": "(none)", "health": "OK" }
```

**Read `tools/call:mubit_status` first.** `"status": "connected"` with `"health": "OK"` is a
real round trip to the hosted control plane, made through a `process.stdout` this plugin has
wrapped and a `globalThis.fetch` it has wrapped as well, and the tool result came back intact.
`"default_session": "hs2-manual"` is the run id §0 pinned, which confirms the launcher — not
the bundle's poisoned `"default"` — is what the server is using.

The key is read out of the credential file rather than typed, so it never enters your shell
history. It is still visible to `ps` for the life of a child process; that is the normal trade.

---

## §7 — Teardown

```bash
rm -rf "$SCRATCH" "$DATA"
unset PLUG DATA SCRATCH MUBIT_CC_DATA_DIR MUBIT_ENDPOINT MUBIT_API_KEY \
      MUBIT_CC_RUN_STRATEGY MUBIT_CC_RUN_ID MUBIT_CC_LOG_LEVEL
echo "gone: $(ls -d /tmp/mubit-hs2* 2>/dev/null | wc -l | tr -d ' ') directories left"
```

**Expect**

```
gone: 0 directories left
```

Nothing outside those two directories was written. The live section made one read and stored
nothing.

---

## What each section would have caught

| Section | The failure it catches |
|---|---|
| §1 | Someone "fixes" this with a sixth env var that the bundle never reads |
| §2 | The text ships but says nothing about narration — the one mistake a model makes unprompted |
| §3 | The guard is installed after the import, where it wraps a handle nobody holds |
| §4 | The guard corrupts a later frame, which breaks the whole server rather than one field |
| §5 | The declared context budget understates the plugin by the size of a text every session loads |
| §6 | The wrapper works offline and disturbs a real, talking server |
