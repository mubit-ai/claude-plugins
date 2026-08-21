# Mubit Memory — user guide

From nothing installed to memory that survives between sessions. Every command is
copy-pasteable, and every expected output below was produced on a real machine.

**What it does.** Claude Code forgets everything when a session ends. This plugin captures your
work as it happens, feeds relevant past lessons back in before each prompt, and learns which
memories actually helped. You never type "remember this" — capture is involuntary.

---

## The three things that surprise everyone

Read these now and you will skip the three most common support questions.

1. **After installing, you must start a *new* session.** `/reload-plugins` loads the code but
   does not fire the `SessionStart` hook, so there is no run id, no status line, and nothing on
   disk. It looks broken. It is not.
2. **An accepted write is not yet a stored memory.** Ingest returns `queued` and indexing
   finishes a moment later, so a recall issued immediately after a capture can legitimately come
   back empty. `/mubit-memory:doctor` shows you the job states.
3. **Memory becomes cross-session only at `SessionEnd`.** That is the one path that promotes a
   lesson beyond the run it was learned in. Kill the terminal and you lose the promotion.

---

## Part 1 — Install

### Option A — from GitHub (what everyone should use)

```
/plugin marketplace add mubit-ai/claude-plugins
/plugin install mubit-memory@mubit
/reload-plugins
```

Then `/reload-plugins`, and **quit and start a new session.**

Claude Code fetches a marketplace with `git clone --depth 1`, using your own git credentials —
there is no separate plugin token. If your git is SSH-only, run `gh auth setup-git` first: the
clone URL is always HTTPS, even for sources written as `git@`.

### Option B — from a local checkout

A marketplace source can also be a local directory. This is the loop you want when you are
changing the plugin itself; substitute your own checkout path throughout.

```bash
claude plugin marketplace add ~/src/claude-plugins
claude plugin marketplace list
```

**Expect**:

```
Configured marketplaces:

  ❯ claude-plugins-official
    Source: GitHub (anthropics/claude-plugins-official)

  ❯ mubit
    Source: Directory (~/src/claude-plugins)
```

Then install — either from `/plugin` → **Browse plugins** → **Mubit Memory** → Install, or from
a shell:

```bash
claude plugin install mubit-memory@mubit
```

**Expect**:

```
✔ Successfully installed plugin: mubit-memory@mubit (scope: user)
13 userConfig options not yet set — run /plugin configure mubit-memory@mubit in Claude Code
```

Then `/reload-plugins`, and **quit and start a new session.**

> Scope: `user` (default) is you everywhere, `--scope project` commits it for collaborators,
> `--scope local` is you in this repo only. Uninstalling needs the same scope you installed
> with: `claude plugin uninstall mubit-memory --scope local`.

**Whenever the repo changes**, this marketplace re-reads from disk rather than fetching:

```bash
claude plugin marketplace update mubit
```

To undo the marketplace registration at any time:

```bash
claude plugin marketplace remove mubit
```

### Option C — try it without installing anything

Zero side effects, session-only. Good for a first look, and the fastest loop while developing:

```bash
claude --plugin-dir ~/src/claude-plugins/integrations/claude-code
```

> Session-only plugins get their own data directory —
> `~/.claude/plugins/data/mubit-memory-inline`, not `.../mubit-memory`. Glob `mubit-memory*`
> when you go looking for state.

### Confirm the install is sound

```bash
claude plugin validate ~/src/claude-plugins/integrations/claude-code
```

**Expect** `✔ Validation passed`. This is the host's own schema check, and it is the only thing
that catches a manifest error — a plugin that fails validation does not half-load, it loads
**nothing**, and says so nowhere in the UI.

Once installed, ask the host what it actually got:

```bash
claude plugin details mubit-memory
```

**Expect**:

```
Component inventory
  Skills (7)  auth, doctor, forget, recall, reflect, remember, setup
  Agents (1)  mubit-recall
  Hooks (10)  SessionStart, CwdChanged, UserPromptSubmit, PostToolUse, PostToolUseFailure,
             Stop, SubagentStop, PreCompact, PostCompact, SessionEnd  (harness-only — no model context cost)
  MCP servers (1)  mubit  (tool schemas resolved at runtime; not counted)

Projected token cost
  Always-on:   ~452 tok   added to every session
```

Seven skills, one agent, ten hook events. That number is what the skill descriptions and the
agent cost you in every session; hooks cost nothing in context because they run in the harness,
not the model.

> The plugin's own `contextCost` (5382) is larger because it counts the MCP tool schemas, which
> the host lists as "resolved at runtime; not counted". Both numbers are honest — they measure
> different things.

There is no build step and no `npm install`. Node ≥ 20 is the only requirement; the plugin has
zero runtime dependencies and ships its bundles pre-built.

---

## Part 2 — Point it at a Mubit

```
/mubit-memory:auth
```

That is the whole setup. It opens the [Mubit console](https://console.mubit.ai) in your browser,
signs you in or signs you up, and brings a key back over a loopback callback on `127.0.0.1`. The
key is checked against your instance *before* it is stored, so a run that reports success means
it works — not that it looked plausible.

It lands in `${CLAUDE_PLUGIN_DATA}/credentials.json`, owner-only (mode `600`), on a path that
survives plugin updates. Once per machine, not once per release.

### The two values it sets

| Setting | Value |
| --- | --- |
| `endpoint` | your instance URL, e.g. `https://eu.mubit.ai` |
| `apiKey` | a key of the form `mbt_...` |

Both are needed: an endpoint with no key gets `auth_failed` on every call, and no endpoint at
all means there is nothing to talk to.

### No browser

Over SSH or in a container there is nothing to open. Issue a key at
<https://console.mubit.ai> and hand it over for one command:

```bash
MUBIT_AUTH_KEY='mbt_…' node "${CLAUDE_PLUGIN_ROOT}/bin/auth.mjs" --paste
```

The key goes in the environment rather than a `--key` flag because arguments are readable by
every user on the machine via `ps`, and a process's environment is not.

Useful neighbours: `--status` prints what is stored (presence, never the key) and exits non-zero
when nothing is; `--logout` removes it.

### Or set it by hand

`/plugin` → **Mubit Memory** → configure. There the key is marked sensitive, so it goes to your
OS keychain rather than to a file — the better home for a long-lived install, and it takes
precedence over anything `/mubit-memory:auth` writes.

Confirm either route with:

```
/mubit-memory:setup
```

A rejected key reports as `auth_failed`, not as a network problem: the key is missing, wrong, or
revoked. Before you have set an endpoint at all the status line reads `○ not configured`, which
is not a failure either — it is the plugin waiting. The first time an endpoint is used, while
the instance is still starting, the status line shows `◍ warming` rather than a failure glyph.

### Or configure by environment variable

Handy for a quick trial or a per-project override. Plugin settings win over these.

```bash
export MUBIT_ENDPOINT="https://eu.mubit.ai"
export MUBIT_API_KEY="mbt_..."
```

Per-project, without touching your shell — drop a `.mubit-cc.json` at your project root:

```bash
cat > .mubit-cc.json <<'JSON'
{
  "runStrategy": "git-branch",
  "recallTokenBudget": 2500
}
JSON
```

Precedence, highest first: plugin settings → `MUBIT_*` env vars → `credentials.json` (what
`/mubit-memory:auth` writes) → `.mubit-cc.json` → defaults.

---

## Part 3 — Your first session

Start a new session in a real project and just work. You do not invoke anything.

What happens on its own:

| When | What the plugin does |
| --- | --- |
| Session starts | Derives a run id from your directory, registers the agent, pulls up to 5 global lessons, and tells the model memory is active |
| You `cd` into another repo | Moves the session to that repo's run, and flushes what the run you left had spooled. A `cd` inside one repo changes nothing |
| Every prompt you send | Queries memory and injects what is relevant, within a 1500 ms budget and a 1500-token cap. **Zero LLM calls** — assembly is local |
| Every tool call | Redacts and spools it. Zero network on the hot path |
| Every tool failure | Captured — these produce the most useful lessons |
| Every turn ends | Writes the `Q: … / A: …` pair, flushes the spool, and attributes the turn's success or failure back to the memories that were injected for it |
| Before a compact | Snapshots the last 200 KB of transcript before the host throws it away |
| Session ends | Drains, flushes outcomes, then reflects — extracting lessons that outlive this run |

Every hook exits 0, always. A dead server, an unwritable directory, or a corrupt state file
costs you a memory, never a turn.

### The status line

```
● mubit: cc-my-project-9f2a11c4 · local · recall 6/1.2k tok · saved 12t/1q · lessons 3g
```

| Field | Meaning |
| --- | --- |
| `●` | Connection state — see [Part 8](#part-8--when-it-looks-broken) |
| `cc-my-project-9f2a11c4` | Your run id — the memory scope this session writes to |
| `local` | Derived mode |
| `recall 6/1.2k tok` | 6 memories injected this turn, costing 1.2k tokens |
| `saved 12t/1q` | 12 tool calls and 1 turn captured |
| `lessons 3g` | 3 lessons visible at global scope |

Groups are hidden while still zero. It reads two local JSON files and never touches the
network, so a dead server can never freeze your terminal.

---

## Part 4 — Prove it is actually working

Three checks, cheapest first.

**1. Is there a run id and what state is it in?**

```bash
cat "$(ls -t ~/.claude/plugins/data/mubit-memory*/status/*.json | grep -v health | head -1)" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify({run_id:j.run_id,mode:j.mode,state:j.state,captured:j.captured,recall:{sources:j.recall.sources,tokens:j.recall.tokens},last_error:j.last_error},null,2))})'
```

**Expect** something like this — here with the endpoint set but nothing listening on it, which
is why `state` is `unreachable` and `last_error` is set:

```json
{
  "run_id": "cc-my-project-9f2a11c4",
  "mode": "hosted",
  "state": "unreachable",
  "captured": { "tools": 0, "turns": 0, "pending": 1 },
  "recall": { "sources": 0, "tokens": 0 },
  "last_error": "GET /v2/core/health: TypeError: fetch failed: (ECONNREFUSED)"
}
```

With Mubit up you want `"state": "ready"`, `last_error` empty, and `captured.tools` climbing as
you work.

If that command says **no such file**, there is no status marker — the plugin has never run
here. That is the answer: you have not started a new session since installing.

**2. Is anything being captured?**

```bash
find ~/.claude/plugins/data/mubit-memory*/runs -name '*.json' -mmin -10 | head
```

Files under `spool/` and `turns/` mean capture is landing.

**3. Ask the plugin itself.**

```
/mubit-memory:doctor
```

It checks the cheapest thing first (the local status marker), then connectivity, then memory
health and stuck ingest jobs — and reports the connection state by name.

---

## Part 5 — The six commands

You will not need most of these day to day. Capture is automatic; these are for the moments it
is not enough.

| Command | Type this when |
| --- | --- |
| `/mubit-memory:setup` | First run, or after `auth_failed` / `unreachable`. Detects your deployment and tells you what is missing. **Never installs anything.** |
| `/mubit-memory:doctor` | Memory looks empty, captures are not landing, or the status line shows a failure glyph |
| `/mubit-memory:recall` | You want detail beyond what was already injected this turn |
| `/mubit-memory:remember` | Something should outlive this session |
| `/mubit-memory:reflect` | You want lessons extracted **now** rather than at session end |
| `/mubit-memory:forget` | A stored lesson is wrong |

### Saving something worth keeping

```
/mubit-memory:remember we always deploy from the release branch, never from main
```

Use it for standing preferences, non-obvious constraints, and failures worth never repeating —
not for "I read a file". Routine work is already captured; using the explicit verb for that
buries the entries that matter under duplicates.

### Searching memory

```
/mubit-memory:recall what did we decide about the retry backoff
```

Relevant memory is already at the top of your turn — read that first. This is for when you need
more.

### Extracting lessons mid-session

```
/mubit-memory:reflect
```

Reports each lesson with its id, type and scope. An empty result is a real answer, not an error.

### Deleting a lesson

```
/mubit-memory:forget les_01H8...
```

There is no dry run and no undo. For a lesson that is merely *wrong* rather than harmful,
prefer letting outcome attribution down-weight it.

### The subagent, for bigger questions

```
@mubit-memory:mubit-recall what do we know about how auth tokens are refreshed
```

Runs up to three distinct queries in an isolated context and returns a synthesis, so your main
conversation never absorbs the raw evidence. Bounded: Haiku, low effort, three turns.

---

## Part 6 — The settings worth changing

Everything below is in `/plugin` → Mubit Memory → configure.

### Which sessions share memory

`runStrategy`, default `per-directory`:

| Value | Run id | Use when |
| --- | --- | --- |
| `per-directory` | `cc-<slug>-<hash8>` | **Default.** Two terminals in one repo share memory |
| `git-branch` | `cc-<slug>-<branch>-<hash8>` | A feature branch should get its own memory |
| `per-conversation` | `cc-<session_id>` | Each conversation must be isolated — read the warning below |
| `static` | `MUBIT_CC_RUN_ID` verbatim | You are pinning a shared run deliberately |

> **`per-conversation` splits your memory in two.** The MCP server has no session id to key on,
> so it falls back to `per-directory`. Everything the hooks capture lands in one run; everything
> `/mubit-memory:remember` writes lands in another, and no single recall sees both. Use it only
> if you genuinely want isolation and can live with that.

`/clear` starts a fresh run (`-c1`, `-c2` …). Resume, compact and fork reuse the same one.

A `cd` into a different repo moves the session onto that repo's run under `per-directory` and
`git-branch`, and drains whatever the run you left still had spooled. `per-conversation` and
`static` are not derived from a directory, so they do not move. A `cd` *within* one repo never
moves anything — the id resolves through `git rev-parse --show-toplevel`.

> The MCP server does not follow. It derives its run once, when the session starts it, and
> pins every write to that value; moving it would need a server restart the plugin cannot ask
> for. After a `cd`, what the hooks capture lands in the new repo's run while what
> `/mubit-memory:remember` writes lands in the one you started in.

### How much context memory is allowed to spend

`recallTokenBudget`, default `1500`. Raise it if recall keeps getting trimmed; lower it if you
want the context back.

### Keep this on

`reflectOnEnd`, default `true`. It is the only path that promotes a lesson beyond its own run.
Turning it off to save a few seconds at exit trades away cross-session memory entirely.

### A reminder before a dangerous command — off by default

`preToolWarnings`, default **`false`**.

Turn it on and, just before Claude runs an `rm` or a `git push`, the plugin checks the `rule`
memories this run has already recalled. If one mentions the command, it is shown to Claude —
and nothing else happens. Try it for a session:

```bash
MUBIT_CC_PRE_TOOL_WARNINGS=1 claude
```

Two things about it are worth understanding before you rely on it, because both are easy to
assume the other way round.

**It warns. It cannot stop anything.** Claude Code gives a pre-tool hook four decisions —
allow, deny, ask, defer — and a fifth power that rewrites the command's arguments outright.
This plugin uses none of them, on any code path, and its tests assert that absence across
every branch and the shipped bundle rather than trusting it. What Claude sees is a note; it
decides what to do with it, exactly as it does with any other recalled memory. A rule that
says "never force-push to main" does not become a lock on force-pushing to main.

**And it does not see every command.** The hook is registered with a filter so it is not a
process spawn in front of every tool call in your session — Claude Code's own description of
that field is *"Only runs if the tool call matches the pattern. Avoids spawning hooks for
non-matching commands."* The docs also say the filter is best-effort and **fails open**:

> The filter also fails open, running your hook regardless of pattern, when the Bash command
> can't be parsed. Because the filter is best-effort, use the permission system rather than a
> hook to enforce a hard allow or deny.

Read that last sentence as written. **This is a memory-informed guardrail, not a security
boundary.** If a command must never run, that belongs in `permissions.deny` in your
`settings.json`, where the host enforces it — not in a Mubit rule, and not here. What this
setting buys is that a lesson you already paid to learn shows up at the moment it applies
instead of scrolling past twenty prompts earlier.

One small thing that is *not* documented anywhere, so do not assume it: what Claude Code does
with a pre-tool hook that times out. The published reference does not say. Nothing here rests
on it — the plugin denies nothing at any exit it controls, and it exits 0 on every path,
including the path where its own internal deadline fires — but if you write your own pre-tool
hook, do not carry the assumption forward.

### Quieting it temporarily

```bash
MUBIT_CC_CAPTURE=0 claude    # stop capturing, keep recall
MUBIT_CC_RECALL=0 claude     # stop injecting, keep capturing
MUBIT_CC_PRE_TOOL_WARNINGS=0 claude   # stop the pre-command reminders (already the default)
```

### Fewer MCP tools

`mcpTools` takes a comma-separated allowlist, used verbatim rather than merged with the default:

```
mubit_recall,mubit_learned
```

> The bundled server honours the allowlist: `/mcp` shows the ten in the default set, which
> are the ones the skills
> use. Fixed by the next `@mubit-ai/mcp` release.

---

## Part 7 — What leaves your machine

Everything goes to **your** Mubit endpoint and nowhere else. Nothing is sent to Mubit AI.

Before anything is written even to the local spool, three stages run in order:

**1. Pattern scrub.** Every match becomes `[REDACTED:<kind>]`, naming the rule that fired:

```
DATABASE_PASSWORD=hunter2              ->  [REDACTED:assignment]
sk-proj-4f9a...                        ->  [REDACTED:openai-key]
ghp_16C7e42F292c...                    ->  [REDACTED:github-token]
Authorization: Bearer abc123...        ->  Authorization: [REDACTED:bearer]
-----BEGIN RSA PRIVATE KEY-----        ->  [REDACTED:pem]
```

Plus a catch-all for anything that merely looks like a secret: a long run of random-looking
characters is redacted on sight. Hex-only strings are safe, so git SHAs survive it.

**2. Path denylist — dropped entirely, not scrubbed.** A redacted `.env` is still a map of which
secrets a project holds:

```
.env  .env.*   *.pem  *.key  *.p12  *.pfx  *.kdbx
id_rsa*  id_ed25519*   secrets/**  .ssh/**  .aws/**  .gnupg/**
**/credentials  **/.netrc
```

**Plus everything git ignores.** Add your own globs — they append to this floor, never replace
it:

```bash
export MUBIT_CC_CAPTURE_DENY="internal/**,*.sql"
```

**3. Byte caps.** 4 KiB per tool-input field, 8 KiB per output. The scrub runs *before* the cap,
so truncation can never leave a recognizable half of a secret.

Also worth knowing: `redact: false` disables stage 1 only — the denylist and caps always run.
The local log is scrubbed too. The plugin never captures its own traffic. The status line does
no network I/O, ever.

---

## Part 8 — When it looks broken

| Glyph | State | What it means | Fix |
| --- | --- | --- | --- |
| `●` | `ready` | Connection is fine | If memory still looks wrong, it is content or scope, not connectivity — run `/mubit-memory:doctor` |
| `○` | `unconfigured` | No endpoint is set, so nothing was dialed | Run `/mubit-memory:auth`. Nothing is broken and nothing is lost — capture buffers until an endpoint exists |
| `✖` | `unreachable` | Nothing is listening | Check `endpoint` is correct and your instance is running |
| `▲` | `server_error` | Something is up and answering wrongly | Retry, then check the instance in the console. If it persists, check `endpoint` reaches Mubit and not a proxy or SSO page — those answer 200 too |
| `✖` | `auth_failed` | Key missing, wrong, or revoked | Set a valid `mbt_...` key. Sticky on purpose — it is the one error you can fix |
| `◌` | `not_responding` | Three consecutive timeouts | Usually load, not death. Retry before concluding anything |

Two displays that look like faults and are not:

- **`◍ warming`** — the 20-second cold-start window, opened the first time a given endpoint is
  used. An instance that is still starting is not broken, merely slow to answer. It is armed
  once per endpoint rather than once per session, so it cannot hide a fault that outlasts it.
- **`· paused 94s`** — the circuit breaker opened after 5 failures in 5 minutes. One probe dials
  when the cooldown ends and a success closes it. Nothing needs restarting.

### The common ones

| Symptom | Cause | Fix |
| --- | --- | --- |
| No status line, no skills, nothing at all | You have not started a new session since installing | Quit and reopen. `/reload-plugins` does not fire `SessionStart` |
| Everything connects, recall is always empty | Writes are accepted and indexed a moment later, so a recall right after a capture can miss | Run `/mubit-memory:doctor` and check the ingest job states |
| Nothing loads and there is no error anywhere | A manifest failed validation. A plugin that fails does not half-load | `claude plugin validate <plugin-dir>` |
| Memory from `/mubit-memory:remember` never shows up in recall | `runStrategy: per-conversation` splits hook writes from MCP writes | Use `per-directory` |
| `/mcp` lists 21 tools instead of 10 | The bundled server predates the allowlist patch | Cosmetic; ignore |

Deeper diagnosis — the plugin's own log, already scrubbed, safe to paste into an issue:

```bash
tail -50 ~/.claude/plugins/data/mubit-memory*/logs/mubit-cc.log
```

For more detail, raise the level for one session:

```bash
MUBIT_CC_LOG_LEVEL=debug claude
```

---

## Part 9 — Turning it off

```
/plugin
```

→ Mubit Memory → disable. Or from the shell:

```bash
claude plugin disable mubit-memory
claude plugin uninstall mubit-memory      # remove entirely
claude plugin marketplace remove mubit    # drop the source too
```

Local state is pruned on a TTL regardless — turns after 6 h, status markers after 12 h, spool
after 24 h, run directories after 7 days. To wipe it now:

```bash
rm -rf ~/.claude/plugins/data/mubit-memory*
```

Nothing is deleted from your Mubit instance by uninstalling. Use `/mubit-memory:forget` for that,
or delete the run server-side.

---

## What was verified for this guide, and what was not

Verified on this machine: `claude plugin validate` on both manifests; adding the local directory
marketplace and listing it; a real `claude plugin install` from it, `claude plugin details`, and
`claude plugin uninstall`; the plugin loading with 7 skills / 1 agent / MCP connected; and the
shape of the on-disk status marker. Every expected-output block above is a transcript.

Not verified: a fresh clone-and-install from GitHub. The transcripts above were produced from a
local directory marketplace, so the install path most people take — `/plugin marketplace add
mubit-ai/claude-plugins` — is exercised by its parts and not end to end here. Also unverified is
any behaviour that needs a running Mubit: recall content, reflection output, and lesson
promotion — those need a live instance and are covered separately.
