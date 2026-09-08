# Mubit Memory for Codex — user guide

From nothing installed to memory that survives between sessions, under the OpenAI Codex CLI.
Every command is copy-pasteable. Where a block is marked **Expect**, the output was produced
on a real machine by the command above it; where it was not, the text says so.

**What it does.** Codex forgets everything when a session ends. This plugin captures your work
as it happens, feeds relevant past lessons back in before each prompt, and learns which
memories actually helped. You never type "remember this" — capture is involuntary.

It is the same plugin as the Claude Code one, built twice from one source tree, and **a Codex
session and a Claude Code session started in the same directory are one Mubit run, sharing one
memory.** That is the point of the Codex build, not a side effect of it.

---

## The three things that surprise everyone

1. **Installing is two steps, and the second is not optional.** Codex copies the plugin into
   its cache and never reads the `hooks.json` inside it, and a plugin-declared MCP server
   cannot resolve its own path. `mubit-memory:setup` installs both into your own `~/.codex`
   with the real path substituted. Skip it and you have a plugin that installs perfectly,
   lists its skills, and captures nothing.
2. **A registered hook does not run until it is trusted.** Under `codex exec` an untrusted
   hook is skipped **silently** — no prompt, no warning, exit 0 — and editing a registration
   (which every upgrade does) returns it to untrusted. This is the fault that leaves no trace
   at all, so `mubit-memory:doctor` checks it first.
3. **After setup, start a *new* session.** Hooks and MCP servers are read when a session
   starts. Nothing above reaches the session that ran setup.

Two more that are the same on both hosts: an accepted write is not yet a stored memory (indexing
finishes a moment after ingest returns `queued`), and memory becomes cross-session at
`SessionEnd` — which under Codex has three seconds, so that work runs in a detached process
(Part 6).

---

## Part 1 — Install

Requires Codex CLI **0.146.0 or newer** and Node **20 or newer**. There is no build step and no
`npm install`: the plugin has zero runtime dependencies and ships its bundles pre-built.

### Add the marketplace and the plugin

From a local checkout of the repository (the loop you want while changing the plugin itself),
or from the Git source:

```bash
codex plugin marketplace add ~/src/claude-plugins
codex plugin add mubit-memory@mubit
```

The marketplace is named `mubit` by the repository's own `.agents/plugins/marketplace.json`,
which points at `integrations/codex/`. The plugin lands under
`~/.codex/plugins/cache/mubit/mubit-memory/<version>/`.

### Run setup

Either ask a Codex session to run `mubit-memory:setup`, or do it yourself:

```bash
PLUGIN=$(ls -d ~/.codex/plugins/cache/mubit/mubit-memory/*/ | tail -1)
node "$PLUGIN/scripts/setup.mjs" "$PLUGIN"
```

**Expect** (this transcript was produced against a throwaway `CODEX_HOME`, with `--no-trust`
and an explicit `--data-dir`; your directory and path will differ):

```
data directory: /Users/you/.claude/plugins/data/mubit-memory-mubit
  no credentials.json here yet. If you already use the Claude Code plugin, check this is the same directory it uses (ls ~/.claude/plugins/data/) and pass --data-dir=<path> if not.
merged 11 handler(s) across 10 events into ~/.codex/hooks.json
  (PreToolUse omitted: the warnings it exists for are off by default)
Added global MCP server 'mubit'.

skipping trust (--no-trust). Run /hooks in the Codex TUI and approve the Mubit entries,
or Codex will silently skip every one of them.
```

What it did, in order:

1. **Resolved the data directory and pinned it.** Every hook command and the MCP registration
   now carry `MUBIT_CC_DATA_DIR="…"`, so nothing downstream ever guesses again. That directory
   is under `~/.claude/plugins/data/` — yes, `.claude` — because it is the one the Claude Code
   plugin uses, and sharing it is what makes one memory rather than two. Pass
   `--data-dir=<path>` if it picked wrong (Part 8 says how to tell).
2. **Merged the hook registrations** into `~/.codex/hooks.json`, with `{{PLUGIN_ROOT}}`
   replaced by the real path. Other tools' entries are kept; a previous Mubit install's are
   replaced rather than stacked; the file is backed up first as `hooks.json.before-mubit`.
   A registration ends up looking like this:

   ```
   MUBIT_CC_DATA_DIR="/Users/you/.claude/plugins/data/mubit-memory-mubit" node "/Users/you/…/integrations/codex/hooks/dist/capture.mjs" --permission
   ```

3. **Registered the MCP server** as `mubit` — the name matters, because every skill names its
   tools `mcp__mubit__…` — with the same pin in its environment. `codex mcp list` shows it.
4. **Offered to record hook trust**, and asked first. Without `--no-trust` it shows you every
   command it is about to trust and waits for a yes. If you would rather do it yourself, run
   `/hooks` in the Codex TUI and approve the Mubit entries; the result is identical.

Re-run it after every plugin upgrade: it is idempotent, and an upgrade changes the registrations'
content hashes, which returns them to untrusted. `--with-pre-tool` adds the `PreToolUse`
registration (Part 6 says why it is left out by default).

### Confirm the install is sound

```bash
ls "$PLUGIN/hooks/dist/capture.mjs" "$PLUGIN/mcp/dist/index.js" "$PLUGIN/bin/handoff.mjs"
```

All three must exist — they are committed artifacts, not build outputs, so a missing one means
the install is damaged and reinstalling is the fix. Then ask Codex what it sees:

```bash
codex app-server <<'RPC'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"guide","title":"guide","version":"1"}}}
{"jsonrpc":"2.0","method":"initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"hooks/list","params":{}}
RPC
```

Every Mubit entry carries a `trustStatus`. Anything other than `"trusted"` is the answer to
"why is nothing happening", and `mubit-memory:setup` is the fix.

---

## Part 2 — Point it at a Mubit

```bash
node "$PLUGIN/bin/auth.mjs"
```

It opens the Mubit console in your browser, signs you in or up, and brings a key back over a
loopback callback on `127.0.0.1`. The key is checked against your instance *before* it is
stored, so a run that reports success means it works.

The key lands in `credentials.json`, owner-only (mode `600`), in the data directory setup
pinned. The command finds that directory the same way the hooks do — the pin in
`~/.codex/hooks.json` first, then the directory holding an existing `credentials.json`, then the
most recently used one — so a key stored here is a key the hooks read. Once per machine, not
once per release.

### The two values it sets

| Setting | Value |
| --- | --- |
| `endpoint` | your instance URL, e.g. `https://api.mubit.ai` |
| `apiKey` | a key of the form `mbt_...` |

Both are needed: an endpoint with no key gets `auth_failed` on every call, and no endpoint at
all means nothing is dialled — capture spools locally until there is one.

### No browser

Over SSH or in a container there is nothing to open. Issue a key in the console and hand it
over for one command:

```bash
MUBIT_AUTH_KEY='mbt_…' node "$PLUGIN/bin/auth.mjs" --paste
```

The key goes in the environment rather than a flag because arguments are readable by every
user on the machine via `ps`, and a process's environment is not. `--status` prints what is
stored (presence, never the key) and exits non-zero when nothing is; `--logout` removes it.

`node "$PLUGIN/scripts/login.mjs"` is the same thing with one more line of output: it prints
*which* directory it wrote to and how it decided, so a wrong answer is visible.

### Or configure by environment variable

Codex has no plugin settings UI and no per-plugin option variables, so configuration is three
rungs, highest first: `MUBIT_*` in the environment, then `credentials.json`, then a
`.mubit-cc.json` at the project root.

```bash
export MUBIT_ENDPOINT="https://api.mubit.ai"
export MUBIT_API_KEY="mbt_..."
```

Codex runs a hook through a **login shell**, so anything exported in `.zshrc` or `.bashrc`
reaches the plugin. That is usually what you want and occasionally surprising: a
`MUBIT_ENDPOINT` left over from a local-server session outranks the key you signed in with.

Confirm either route by asking a session to run `mubit-memory:setup`, or from the shell with
`node "$PLUGIN/bin/auth.mjs" --status`.

---

## Part 3 — Your first session

Start a new session in a real project and just work. You do not invoke anything.

| When | What the plugin does |
| --- | --- |
| Session starts | Derives a run id from your directory, registers the agent, pulls up to 5 standing (`global`) lessons, and injects a short block telling the model memory is active and which tool to reach for |
| Every prompt you send | Queries memory and injects what is relevant, within a 1500 ms budget and a 1500-token cap. Zero LLM calls — assembly is local |
| Every tool call | Redacts and spools it. Zero network on the hot path. `apply_patch` is recorded with the files it touched |
| A permission request | Recorded as the attempt it was — the only record a denial leaves. Never decided |
| A subagent starts | Given the parent run's pins and a recalled block of its own — the only memory it will ever see |
| A subagent finishes | Its result is filed as a handoff to your session, for review |
| Every turn ends | Writes the `Q: … / A: …` pair, flushes the spool, and attributes the outcome to the memories that were injected |
| Before a compact | Snapshots the last 200 KB of the rollout before Codex throws it away |
| Session ends | Hands the drain, the outcome flush and the reflect to a detached process — Codex allows three seconds here |

Every hook exits 0, always. A dead server, an unwritable directory, or a corrupt state file
costs you a memory, never a turn — and nothing here denies, rewrites or blocks a tool call on
any path.

**There is no status line.** Codex's status line is a fixed list of built-in items with nothing
scriptable in it, so the plugin ships none and `MUBIT_CC_STATUSLINE` defaults off. The block
injected at session start is what tells the model memory is active; Part 4 is how you tell.

---

## Part 4 — Prove it is actually working

Three checks, cheapest first.

**1. Did the hooks run at all, and what state is the run in?**

```bash
ls ~/.claude/plugins/data/mubit-memory*/status/
```

Note the `*`: the directory carries a suffix, and there may be more than one. If there is **no
`status/` directory anywhere**, the hooks have never run — either you have not started a new
session since setup, or the hooks are not trusted (Part 1's `hooks/list`). Then the marker
itself:

```bash
cat "$(ls -t ~/.claude/plugins/data/mubit-memory*/status/*.json | grep -v health | head -1)"
```

You want `"state": "ready"`, `last_error` empty, and `captured.tools` climbing as you work.
`"state": "unconfigured"` means Part 2 has not happened yet; nothing is broken and nothing is
lost.

**2. Is anything being captured?**

```bash
find ~/.claude/plugins/data/mubit-memory*/runs -name '*.json' -mmin -10 | head
```

Files under `spool/` and `turns/` mean capture is landing. A `files.json` beside them is the
per-run index of what your patches touched.

**3. Ask the plugin itself.** Ask the session to run `mubit-memory:doctor`. Its step 0 is the
Codex-only one — hooks that were never trusted — then the marker, then connectivity, then memory
health and stuck ingest jobs, and it reports the connection state by name.

---

## Part 5 — The commands

Capture is automatic; these are for the moments it is not enough. Codex lists each skill to the
model as `mubit-memory:<name>`, so "run `mubit-memory:recall` for what we decided about retries"
is how you invoke one.

| Skill | Ask for it when |
| --- | --- |
| `mubit-memory:setup` | First run, and after every upgrade. Merges the registrations, registers the server, records trust. |
| `mubit-memory:auth` | Sign in and store a key. |
| `mubit-memory:doctor` | Memory looks empty, captures are not landing, or a call reports a failure state. |
| `mubit-memory:recall` | You want detail beyond what was already injected this turn. |
| `mubit-memory:remember` | Something should outlive this session. |
| `mubit-memory:reflect` | You want lessons extracted **now** rather than at session end. |
| `mubit-memory:forget` | A stored lesson is wrong. |
| `mubit-memory:strategies` | The pattern *across* many lessons, rather than any single one. |
| `mubit-memory:checkpoint` | A named snapshot before risky work, stored verbatim. |
| `mubit-memory:memory-health` | What is actually stored: counts, staleness, contradictions. |
| `mubit-memory:activity` | What the instance holds, filtered — and an export you can keep. |
| `mubit-memory:pin` | A constraint that holds for the rest of this run and stops being true after. |
| `mubit-memory:import` | The plugin was installed after the work, and the rollouts are still on disk. |
| `mubit-memory:handoff` | Work is changing hands between agents, or a subagent's result is waiting for a verdict. |
| `mubit-memory:dashboard` | You want to *look* at any of the above rather than ask about it. |

Seven of these run a binary from the plugin directory rather than an MCP tool. Under Codex no
environment variable carries the plugin's path, so the skill resolves it from its own location
and the command is always `node <plugin-root>/bin/<name>.mjs` — never `${CLAUDE_PLUGIN_ROOT}`,
which expands to nothing here. Every one of those binaries knows it is running under Codex on
its own: a handoff it sends is signed `codex`, and an import reads Codex's history by default.

### Saving, searching, extracting, deleting

`mubit-memory:remember` is for standing preferences, non-obvious constraints, and failures worth
never repeating — not for "I read a file"; routine work is already captured.
`mubit-memory:recall` is for when the block at the top of your turn is not enough.
`mubit-memory:reflect` reports each lesson with its id, type and scope, and an empty result is
a real answer. `mubit-memory:forget` has no dry run and no undo; for a lesson that is merely
wrong rather than harmful, let outcome attribution down-weight it.

### Pinning a constraint for one task

```bash
node "$PLUGIN/bin/pin.mjs" add "don't touch the vendored server"
node "$PLUGIN/bin/pin.mjs" list
node "$PLUGIN/bin/pin.mjs" clear vendored
```

A pin renders above the recalled block on every prompt of the run, in full, and on the prompts
recall skips — a two-word answer, a failed recall, an open circuit breaker. Subagents get the
parent run's pins too, above their own smaller recalled block. Five pins, 200 characters each;
the command refuses anything over that rather than truncating your words. A pin the instance
did not accept is not written locally at all.

### Importing what happened before the plugin

```bash
node "$PLUGIN/bin/import.mjs"
```

A dry run: it prints where it is reading from, which projects are in scope, and how many items
it *would* send, one line per source. Read that number first. Then, and only then:

```bash
node "$PLUGIN/bin/import.mjs" --send
```

Under Codex the default source is `--source codex`: the rollouts under `~/.codex/sessions`, in
both the shape Codex wrote before 0.149 and the one it writes now, minus the reviewer threads
Codex spawns to approve its own actions and the preamble it writes in your voice at the top of
every thread. `--source claude-code` reads `~/.claude/projects` instead, and `--source all`
reads both; a Codex item carries `tool:codex` in its tags and a Claude Code one
`tool:claude-code`, so the two histories stay tellable apart once stored.

The scope is this project and the git worktrees linked to it; `--all` is every project on the
machine, so it is a flag you type. Everything goes through the same three redaction stages as
live capture (Part 7). Running it again is safe: every rollout keeps a cursor, so a second run
reads nothing new. Three numbers in the report are findings rather than decoration — `denied`
is the denylist working, `oversize` is lines too large to read, and "this answer is incomplete"
means it stopped at a bound.

### Handing work between agents

```bash
node "$PLUGIN/bin/handoff.mjs" send --to claude-code --action review "the auth diff is ready"
node "$PLUGIN/bin/handoff.mjs" list --open
node "$PLUGIN/bin/handoff.mjs" feedback <handoff_id> --verdict approve
```

A handoff is a note from one agent to another inside this run — `--to claude-code` reaches a
Claude Code session in the same directory, since the two share the run — and feedback is the
answer, one of `approve`, `request_changes`, `block`, `acknowledge`. A handoff nobody has
answered is open. Every subagent's result is filed as one without being asked, so after a
fan-out `list --open` is the list of results nobody has looked at yet.

It is not a queue — nothing is pushed — and it is not cross-run: a handoff lives in one run id,
and a subagent's note is filed under its parent's run.

### Looking at all of it

```bash
node "$PLUGIN/bin/dashboard.mjs"
node "$PLUGIN/bin/dashboard.mjs" --stop
```

A page on `127.0.0.1`, a random port, a token minted for that launch. Three tabs — every lesson
the instance holds, one row per prompt with what recall cost, and the trend — and it shuts
itself down after about half an hour of no traffic.

---

## Part 6 — The settings worth changing

Everything is an environment variable; there is no settings screen. Set them in your shell
profile — hooks run through a login shell — or pass them once with `--env` when re-running
`setup`, which writes them into the registrations.

### Which sessions share memory

`MUBIT_CC_RUN_STRATEGY`, default `per-directory`, derives `cc-<slug>-<hash8>` from the git
root, so two terminals in one repo share memory — and so does a Claude Code session in the
same directory. The `cc-` prefix means "the run for this directory"; renaming it would strand
every run already stored under it.

It stops sharing in exactly two cases: the **data directory** (Part 8), and the **path** — a
second clone, or the same repo on another machine under a different home directory. To pin one
run across paths, harnesses and machines:

```bash
export MUBIT_CC_RUN_STRATEGY=static
export MUBIT_CC_RUN_ID=team-<project>
```

Set both for both tools and re-run setup. `static` does not fall back: with `MUBIT_CC_RUN_ID`
unset it raises a config error rather than quietly deriving a different run.

### Keep these on

`MUBIT_CC_SESSION_END_DETACH`, default `1`. Codex clamps a `SessionEnd` hook to three seconds
and kills it there, whatever the registration asks for. The end-of-session drain and the
reflect — the only thing promoting a lesson beyond its run — do not reliably fit, so the hook
hands them to a detached process. Turning this off costs you reflections. A detached child can
still be reaped with the terminal; if that matters, run `mubit-memory:reflect` at the end of a
long session.

`MUBIT_CC_REFLECT_ON_END`, default `1`. Off costs cross-session memory entirely.

### How much context memory is allowed to spend

`MUBIT_CC_RECALL_TOKEN_BUDGET`, default `1500`, is the ceiling on the injected block. Every
hook that injects context declares a 2500-token limit to Codex explicitly, because over its
default Codex *spills* rather than truncates — it writes the text to a file and hands the model
a head-and-tail stub — and the margin is stated rather than inherited.

`MUBIT_CC_MCP_RESULT_TOKENS`, default `2000`, is the most one MCP tool result may put in front
of the model; the untouched result is saved under the data directory and named at the foot.

### A reminder before a dangerous command — off by default

`MUBIT_CC_PRE_TOOL_WARNINGS`, default `0`, shows a stored rule in front of a matching shell
command. It only ever warns — it never allows, denies or rewrites, on any path. Codex has no
`if:` predicate on a registration, so this costs a process spawn on *every* shell command
whether the feature is on or not, which is why `setup` leaves the registration out unless you
pass `--with-pre-tool`.

### Quieting it temporarily

```bash
MUBIT_CC_CAPTURE=0 codex     # stop capturing, keep recall
MUBIT_CC_RECALL=0 codex      # stop injecting, keep capturing
```

### Fewer MCP tools

`MUBIT_MCP_TOOLS` (no `_CC`) is a comma-separated allowlist, used verbatim rather than merged
with the default seven. Under Codex every registered tool schema is loaded in full on every
session, so the list is the bill.

---

## Part 7 — What leaves your machine

Everything goes to **your** Mubit endpoint and nowhere else. Before anything is written even
to the local spool, three stages run in order:

**1. Pattern scrub.** Every match becomes `[REDACTED:<kind>]`, naming the rule that fired —
credential assignments, vendor API keys, bearer tokens, private key blocks, and a catch-all for
anything that merely looks like a secret. Hex-only strings are safe, so git SHAs survive.

**2. Path denylist — dropped entirely, not scrubbed.** A redacted `.env` is still a map of which
secrets a project holds. The floor is `.env`, key files, `secrets/`, `.ssh/`, `.aws/`,
`.gnupg/`, `credentials`, `.netrc` — **plus everything git ignores**. Your own globs append to
it: `MUBIT_CC_CAPTURE_DENY="internal/**,*.sql"`.

**3. Byte caps.** 4 KiB per tool-input field, 8 KiB per output. The scrub runs *before* the cap,
so truncation can never leave a recognizable half of a secret.

Two things are Codex-shaped. A `shell` or `apply_patch` result arrives as a bare string rather
than an object, and it is captured in full either way. And an `apply_patch` names its files
nowhere but inside the patch, so the paths are parsed out of it for the denylist — a patch that
touches `.env` is dropped whole, not recorded as "touched `.env`" — and out of its
`*** Add/Update/Delete File:` markers for the record: every capture that changed a file carries
`files: [{path, kind}]`, and the same rows are merged into a small per-run index of what is in
play. `delete` is stated outright here, which is more than either host says anywhere else.

Also worth knowing: `MUBIT_CC_REDACT=0` disables stage 1 only; the denylist and caps always
run. The local log is scrubbed too. The plugin never captures its own traffic — an
`mcp__mubit__*` call is dropped.

---

## Part 8 — When it looks broken

Codex first. These four have no Claude Code counterpart, and three of them are silent.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Nothing at all: no `status/` directory, no markers, no injected memory | The hooks are not trusted, so Codex skipped every one of them without saying so | Part 1's `hooks/list`; then `mubit-memory:setup`, or approve the Mubit entries in `/hooks` |
| The same, right after installing | `hooks.json` was never installed — the copy in the plugin cache is inert. `grep PLUGIN_ROOT ~/.codex/hooks.json` finding a literal `{{PLUGIN_ROOT}}` is the same fault: somebody copied the template | Run `mubit-memory:setup` |
| It worked until the upgrade | Upgrading rewrote the registrations, which changed their hashes and returned them to untrusted | Re-run setup, and re-trust |
| Reflections never appear, and the marker's `reflect.status` is stale | `MUBIT_CC_SESSION_END_DETACH=0`, so the reflect was killed at Codex's three-second clamp | Leave it on. Run `mubit-memory:reflect` by hand for a long session |
| Two directories under `~/.claude/plugins/data/` hold a run with the **same name** | The run id sharing worked and the two harnesses wrote to different stores | Re-run setup with `--data-dir=<the one holding credentials.json>`. Memory written to the other one before the fix is recoverable by hand, not automatically |
| No status line | By design; Codex has nothing scriptable there | Part 4 |

Then the connection, which the marker's `state` and `mubit-memory:doctor` both report by name:

| State | What it means | Fix |
| --- | --- | --- |
| `ready` | Connection is fine | If memory still looks wrong, it is content or scope, not connectivity — run `mubit-memory:doctor` |
| `unconfigured` | No endpoint is set, so nothing was dialled | Part 2. Nothing is lost — capture buffers until an endpoint exists |
| `unreachable` | Nothing is listening | Check `endpoint` is correct and your instance is running |
| `server_error` | Something is up and answering wrongly | Retry, then check the instance in the console. A proxy or SSO page answers 200 too |
| `auth_failed` | Key missing, wrong, or revoked | Set a valid `mbt_...` key. Sticky on purpose — it is the one error you can fix |
| `not_responding` | Three consecutive timeouts | Usually load, not death. Retry before concluding anything |

A `warming` reading inside the first 20 seconds of a new endpoint is not a fault, and neither
is the circuit breaker's pause after five failures in five minutes; one probe dials when the
cooldown ends.

Deeper diagnosis — the plugin's own log, already scrubbed, safe to paste into an issue:

```bash
tail -50 ~/.claude/plugins/data/mubit-memory*/logs/mubit-cc.log
MUBIT_CC_LOG_LEVEL=debug codex     # more detail, for one session
```

---

## Part 9 — Turning it off

Setup wrote into two files you own, and undoing it is undoing those:

```bash
codex mcp remove mubit
codex plugin remove mubit-memory@mubit         # the plugin and its cache
codex plugin marketplace remove mubit          # drop the source too
```

The hook registrations are still in `~/.codex/hooks.json`. Either restore the backup setup
took — `~/.codex/hooks.json.before-mubit` — or delete the entries whose command names this
plugin's `hooks/dist/`; the other tools' entries in that file are yours to keep. A registration
pointing at a removed plugin is skipped, but it is still a process spawn that fails.

Local state is pruned on a TTL regardless — turns after 6 h, status markers after 12 h, spool
after 24 h, run directories after 7 days. To wipe it now, knowing that a Claude Code install
shares it:

```bash
rm -rf ~/.claude/plugins/data/mubit-memory*
```

Nothing is deleted from your Mubit instance by uninstalling. Use `mubit-memory:forget` for that.

---

## What was verified for this guide, and what was not

Verified on this machine, with Codex CLI 0.153.4 installed: `scripts/setup.mjs` run against a
throwaway `CODEX_HOME` with `--no-trust` — the transcript in Part 1 is that run, and the
`hooks.json` and `config.toml` it wrote were read back; the seven command-line bundles spawned
by the plugin's own test suite against a loopback instance, with no plugin environment, which
is where the `codex`-signed handoff and the Codex-first import default are held; and every
hook run by that suite on payloads the host itself was recorded sending.

Not verified in the session that wrote this guide: a live interactive Codex session on this
machine with the hooks trusted — the `hooks/list` transcript, the marker after a real turn,
and the recall content a real instance returns. Those come from the recordings under
`test/fixtures/observed/` and from earlier sessions, not from this one.
