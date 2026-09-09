# Mubit Memory for Codex

Persistent, typed, self-improving memory for the OpenAI Codex CLI. Work is captured
involuntarily as it happens, relevant lessons are injected before every prompt, outcomes are
attributed back so what helps ranks higher next time, and a reflection at session end promotes
what was learned beyond the run it was learned in.

It is the same plugin as [`../claude-code`](../claude-code): one `lib/`, one set of hook
bodies, one MCP launcher, built twice. **A Codex session and a Claude Code session started in
the same directory are one Mubit run, sharing one memory** — that is the point of the port,
not a side effect of it.

Requires Codex CLI **0.146.0 or newer** and Node **20 or newer**. Verified against 0.146.0 and 0.149.0; the hook schemas are byte-identical between them.

---

## Install

```bash
codex plugin marketplace add /path/to/this/repo
codex plugin add mubit-memory@mubit
```

Then either ask a Codex session to run `mubit-memory:setup`, or do it yourself:

```bash
PLUGIN=$(ls -d ~/.codex/plugins/cache/mubit/mubit-memory/*/ | tail -1)
node "$PLUGIN/scripts/setup.mjs" "$PLUGIN"
```

**That second step is not optional, and skipping it gives you a plugin that installs
perfectly and captures nothing.** Two facts about Codex 0.146.0 make it necessary, both
recorded against a live host:

- **A `hooks.json` bundled in a plugin is inert.** Codex copies it into the install cache and
  never reads it. `hooks/list` reports every hook it *does* see as `source: "user"` with
  `pluginId: null`.
- **A plugin-declared MCP server cannot resolve its own entry point.** There is no `${VAR}`
  substitution layer, and a relative path resolves against the *project* directory. All three
  of `${CLAUDE_PLUGIN_ROOT}/x.mjs`, `./x.mjs` and `x.mjs` fail to start.

So `hooks.json` and `.mcp.json` ship here as **templates**, and `setup` installs them into the
user layer with this plugin's absolute path substituted: the registrations merge into
`$CODEX_HOME/hooks.json`, and the server is registered with `codex mcp add mubit`.

The script merges rather than overwrites (other tools' hooks in `~/.codex/hooks.json` are
kept), backs up both files it touches to `<name>.before-mubit`, and is idempotent — re-run it
after every plugin upgrade. `--no-trust` skips the trust step; `--with-pre-tool` adds the
`PreToolUse` registration.

`setup` will also offer to record hook trust for you, and will ask before it does. A
registered hook does not run until it is trusted, and under `codex exec` an untrusted hook is
skipped **silently** — no prompt, no warning, exit 0. If you would rather grant it yourself,
run `/hooks` in the TUI and approve the Mubit entries. Either way it has to be redone after an
upgrade: editing a registration changes its content hash and returns it to untrusted.

Finally, `mubit-memory:auth` to sign in, and **start a new session** — hooks and MCP servers
are read when a session starts.

---

## What it costs, and what it never does

| | |
| --- | --- |
| Network per tool call | **none.** Capture is one local file write; everything outbound goes through a detached drain, on a trigger. |
| Network per prompt | one `POST /v2/control/query`, inside a budget. It answers with nothing rather than making you wait. |
| Blocking | **never.** No hook in this plugin denies a tool call, rewrites one, or exits non-zero on any path, including every failure path. |
| Secrets | scrubbed before anything leaves the machine, and a denylisted subject (`.env`, a key file) is dropped rather than scrubbed. |

The one thing to know about the eleven registrations: `PreToolUse` exists only to show a
stored Mubit rule in front of a matching tool call, and that feature is **off by default**.
Codex has no `if:` predicate, so a registered `PreToolUse` costs a process spawn per matching
tool call whether the feature is on or not — which is why `setup` omits that registration
unless you have turned the warnings on.

---

## Configuration

Codex has no plugin settings UI and exports no `CODEX_PLUGIN_OPTION_*` variables — the strings
`PLUGIN_OPTION` and `userConfig` appear nowhere in its binary — so configuration is three
rungs, highest first:

1. `MUBIT_*` environment variables
2. `<data-dir>/credentials.json`, written by `mubit-memory:auth`
3. `<project>/.mubit-cc.json`

Codex runs a hook command through a **login shell**, so anything exported in your `.zshrc` or
`.bashrc` reaches the plugin. That is usually what you want and is occasionally surprising: a
`MUBIT_ENDPOINT` left over from a local-server session outranks the key you signed in with.

The settings worth knowing, all `MUBIT_CC_*` unless noted:

| Variable | Default | What it does |
| --- | --- | --- |
| `MUBIT_ENDPOINT` / `MUBIT_API_KEY` | — | Your instance and key. Blank means nothing is sent and nothing is lost — capture spools locally. |
| `MUBIT_CC_RUN_STRATEGY` | `per-directory` | How a session maps to a run. The default is what makes the two harnesses share one. |
| `MUBIT_CC_CAPTURE` | `1` | Capture tool activity. |
| `MUBIT_CC_RECALL` | `1` | Inject recalled memory before each prompt. |
| `MUBIT_CC_REDACT` | `1` | Scrub before sending. Turning this off is not recommended. |
| `MUBIT_CC_RECALL_TOKEN_BUDGET` | `1500` | Ceiling on the injected block. |
| `MUBIT_CC_REFLECT_ON_END` | `1` | Reflect at session end. Off costs cross-session memory entirely. |
| `MUBIT_CC_SESSION_END_DETACH` | `1` | Finish the end-of-session flush in a detached process. **Leave this on under Codex** — see below. |
| `MUBIT_CC_PRE_TOOL_WARNINGS` | `0` | Show a stored rule before a matching tool call. It only ever warns. |
| `MUBIT_CC_PINS` | `1` | Render the constraints pinned with the `pin` skill above the recalled block on every prompt of the run — including the prompts recall skips — and above the block a subagent is given at `SubagentStart`. Capped at five pins, 200 characters each and 240 tokens (96 for a subagent); costs no extra request on the prompt path. Off restores the injected block exactly. |
| `MUBIT_CC_DATA_DIR` | — | Overrides where state lives. Highest precedence of any data-dir input. |
| `MUBIT_CC_STATUSLINE` | `0` here | Defaults **off** under Codex, whose status line is a fixed list of built-in item ids with nothing scriptable in it. |
| `MUBIT_MCP_TOOLS` (no `_CC`) | — | Which MCP tools to register, comma-separated. Blank means the seven below. A list you supply is used **verbatim**, not unioned with that default, so it is also how you reach the other eight. |

### The three-second SessionEnd

Codex clamps a `SessionEnd` hook to three seconds and kills it there, whatever the
registration asks for. The end-of-session flush — the drain, and the reflect that is the only
thing promoting a lesson beyond its own run — does not reliably fit. So the hook hands that
work to a detached process and returns immediately, which is why `MUBIT_CC_SESSION_END_DETACH`
defaults on and why turning it off costs you reflections.

A detached child can still be reaped with the terminal. If that matters to you, run
`mubit-memory:reflect` at the end of a long session rather than relying on the exit path, and
use `mubit-memory:doctor` to read `reflect.status` for the last one.

---

## Where state lives

Under `~/.claude/plugins/data/` — yes, `.claude`, and deliberately. A Codex session shares its
run id *and* its data directory with a Claude Code session in the same project, because that
is what makes one memory rather than two.

**Which directory under there is not a constant.** Claude Code names it with a suffix: a
marketplace install writes `mubit-memory-<marketplace>`, a `--plugin-dir` session writes
`mubit-memory-inline`, and the bare `mubit-memory` is only one of several. `setup` resolves
which one this machine actually uses — preferring the one holding `credentials.json`, since
that is the install the user authenticated — and **pins it** as `MUBIT_CC_DATA_DIR` in the
registrations it writes. The command-line bundles under `bin/` — what the `auth`, `pin`,
`import`, `handoff` and other skills run from a plain shell, with no such pin — read that
registration first at runtime and fall back to the same search, so a command lands in the store
the hooks are using rather than in the one a search would guess.

Check it with `ls ~/.claude/plugins/data/` and pass `--data-dir=<path>` to `setup` if the
resolution picked wrong. Getting this wrong is quiet and total: the two harnesses derive the
*same run id* and write it to two different stores, so you get two half-memories of one
project and no error anywhere.

A Codex-only user ends up with a `~/.claude/` directory they never asked for.
`MUBIT_CC_DATA_DIR` moves it, at the cost of the sharing.

Which harness wrote an entry is recorded as its agent role — `codex` or `claude-code` — so the
two are distinguishable where it matters, and count as two actors where something upstream is
asking how well attested a lesson is.

### Sharing one run, and when it stops sharing

The sharing is a property of the id, not of a lookup: `per-directory` derives
`cc-<slug>-<sha256(git root)[:8]>` from the project, so both harnesses on one checkout compute
the same answer independently. The `cc-` prefix reads as "Claude Code" for historical reasons
only; it means "the run for this directory", and renaming it would strand every run already
stored under it.

Two things break it, and only two. The **data directory** — covered above, and the quiet one.
And the **path**: a second clone, or the same repo on another machine where the home directory
has a different name, derives a different hash and therefore a different run. To pin one run
across paths, harnesses and machines:

```bash
export MUBIT_CC_RUN_STRATEGY=static
export MUBIT_CC_RUN_ID=team-<project>
```

Set both for both tools and re-run `setup`, which writes them into the `--env` flags on each
registration so the hooks inherit them. `static` does not fall back: with `MUBIT_CC_RUN_ID`
unset it raises a config error rather than quietly deriving a different run, because a run that
is silently un-shared is indistinguishable from memory that does not work.

Check which run either side is on with `mubit-memory:doctor`, or `node <root>/bin/pin.mjs list
--json`.

---

## The eleven hook registrations

What `hooks.json` carries, and what `setup` merges into `$CODEX_HOME/hooks.json` with the
path resolved and the data directory pinned in front of every command:

| Event | Runs | Timeout | What it does |
| --- | --- | --- | --- |
| `SessionStart` (`startup\|resume\|clear\|compact`) | `session-start.mjs` | 5 s | Derives the run id, checks health, registers the agent, pulls up to 5 global lessons, and injects the steer block — under Codex the **only** channel that tells the model memory is active, since the MCP server's `instructions` frame is not surfaced. On `compact` it re-anchors to the checkpoint `PreCompact` saved. |
| `UserPromptSubmit` | `prompt-recall.mjs` | 3 s | Queries Mubit and injects recalled memory, inside a 1500 ms budget. Injects nothing when the result is empty. |
| `UserPromptSubmit` | `stage-prompt.mjs` | 3 s | Zero network. Stages the prompt under `turn_id` so `Stop` has both halves of the turn, and triggers the detached drain when the spool is full or stale. |
| `PreToolUse` (`Bash\|shell\|apply_patch`) | `pre-tool.mjs` | 3 s | **Off by default, and omitted by `setup` unless `--with-pre-tool`.** Shows a stored rule in front of a matching call and does nothing else. |
| `PermissionRequest` | `capture.mjs --permission` | 3 s | Records the attempt — the only record a denial leaves. Never decided. The event carries no `tool_use_id`, which is why it is observed rather than attributed. |
| `PostToolUse` (every tool) | `capture.mjs` | 3 s | Redacts and spools the call. Zero network. `tool_response` arrives as a bare string here, and an `apply_patch` is recorded with the files it touched. |
| `SubagentStart` | `subagent-start.mjs` | 3 s | The parent run's pins, then a recalled block against the parent's prompt — the only memory a Codex subagent will ever be given. |
| `SubagentStop` | `capture.mjs --subagent` | 3 s | The result, under a `codex-sub-…` identity, filed as a **handoff** to this session's role for review. Zero network. |
| `Stop` | `capture.mjs --stop` | 5 s | Writes the `Q: … / A: …` turn, spawns the drain, and attributes the outcome to the memories recalled for it. |
| `PreCompact` | `checkpoint.mjs --pre` | 10 s | The one blocking network call: snapshots the last 200 KB of the rollout before Codex throws it away. |
| `PostCompact` | `checkpoint.mjs --post` | 5 s | Records that the compaction happened. Injects nothing — Codex has no channel for it on this event. |
| `SessionEnd` | `session-end.mjs` | 3 s | **Clamped to 3 s by Codex whatever the file says.** Hands the drain, the outcome flush and the reflect to a detached process and returns. |

Eleven events, twelve handlers. Three of Claude Code's events have no counterpart here
(`CwdChanged`, `PostToolUseFailure`, `StopFailure`) and one of these has none there
(`PermissionRequest`). There is no `if:` predicate on a Codex registration, and the four
handlers that inject context declare a 2500-token `additionalContextLimit` explicitly — over its
default Codex *spills* rather than truncates, writing the text to a file and handing the model a
stub. Every hook exits 0, always: a memory layer has no business breaking a prompt.

---

## Skills

Listed to the model as `mubit-memory:<name>`:

| Skill | For |
| --- | --- |
| `setup` | First run, and after every upgrade. Merges the registrations, registers the server, records trust. |
| `auth` | Sign in and store a key. |
| `recall` | Search memory for something the injected block did not cover. |
| `remember` | Save a durable lesson, rule, or preference. |
| `reflect` | Extract lessons from this run now, rather than at session end. |
| `forget` | Delete an entry, or down-weight one that is merely wrong. |
| `doctor` | Diagnose. Its step 0 is the Codex-specific one: hooks that were never trusted. |
| `dashboard` | Open a local page over the lessons, the per-prompt recall cost and ingest health. Loopback only. |
| `strategies` | Read the pattern *across* many lessons rather than any single one. |
| `checkpoint` | Save a named snapshot of where the run has got to, verbatim, before risky work. |
| `memory-health` | Report what is actually stored: counts, staleness, contradictions. The store, not the connection. |
| `activity` | The audit question: what this instance actually holds, filtered by time, type, agent or origin — and an export of the whole record as JSONL. Prints to stdout; writes a file only if asked. |
| `pin` | Pin a standing constraint for the rest of this run — "don't touch the vendored server" — so it is put in front of the model on every prompt, including the ones recall skips; subagents inherit the run's pins. A pin is cleared when it stops being true; a durable, cross-session rule is `remember`. |
| `import` | Backfill memory from the rollouts and transcripts already on this machine — Codex's by default, Claude Code's with `--source claude-code`, both with `--source all`. A dry run until `--send`; not something the model may run on its own initiative. |
| `handoff` | Hand work to another agent in this run, list what is still open, or answer a handoff with a verdict. Every subagent's result arrives here as an open handoff to review. |

There is no `mubit-recall` subagent here. Codex has no plugin-defined agent types — every
`SubagentStart` reports `agent_type: "default"` — so a markdown subagent would be a file
nothing reads. Point a generic sub-agent at the `recall` skill instead; the isolation is the
part that mattered.

Seven of the skills run a binary from `bin/` rather than an MCP tool — `auth`, `activity`,
`pin`, `import`, `handoff`, `dashboard`, and the four administrative verbs through
`admin`. No environment variable carries this plugin's path under Codex, so each skill resolves
the root from its own location and the command is always `node <plugin-root>/bin/<name>.mjs`,
never `${CLAUDE_PLUGIN_ROOT}`. Each of those bundles boots the way the hooks do — it declares
the host and resolves the store before the shared code loads — so a handoff it sends is signed
`codex` and an import reads Codex's history by default, with nothing in the environment to
tell it so.

---

## The seven MCP tools

The bundled server carries 21 tools and registers seven of them. The rest cost you nothing
until you name them in `MUBIT_MCP_TOOLS` — and under Codex that cost is real: every registered
schema is loaded in full on every session, so the six that recently left this table were half
of the bill.

Codex has no settings UI and no per-skill `tools:` grant, so this table is the only place the
names appear outside the server's own descriptions.

| Tool | For |
| --- | --- |
| `mubit_recall` | Search memory in words. Returns ranked evidence, each with a `reference_id`. |
| `mubit_diagnose` | A command or test just failed — match the error shape against past failures, before bisecting. |
| `mubit_dereference` | Read back exact stored content when you already hold a `reference_id`. |
| `mubit_learned` | Save one durable claim, in a sentence. The common write. |
| `mubit_outcome` | Credit the `reference_id`s that actually helped, which is what makes them rank higher next time. |
| `mubit_status` | Can the plugin reach Mubit at all. The connection, not the store. |
| `mubit_memory_health` | What is actually stored: counts, staleness, contradictions. The store, not the connection. |

The lesson catalogue, a delete, a named checkpoint, the pattern across lessons and an
explicit reflect are the `reflect`, `forget`, `checkpoint` and `strategies` skills, which run
`bin/admin.mjs` and cost no listing. The rest of the fourteen left off are work a hook already
does better (`mubit_remember`, `mubit_context`), the multi-agent orchestration group
(`mubit_register_agent`, `mubit_list_agents`, `mubit_handoff`, `mubit_feedback`,
`mubit_step_outcome`), `mubit_ingest_status`, whose job the `doctor` skill does at its
step 4 by calling `GET /v2/control/ingest/jobs/<job_id>` directly, and `mubit_archive`,
which no skill reached. None is removed: name it in `MUBIT_MCP_TOOLS` and it is back.

Every tool result is shaped on its way to the model: a lesson list or a recall comes back one
line per item with the id kept, and nothing exceeds `MUBIT_CC_MCP_RESULT_TOKENS` (default
2000, `0` for the raw reply). The untouched original is saved under the plugin data directory,
where the foot of the result names it. The record of what a conversation has already been
shown is keyed by the host session id (`lib/seen.mjs`), and Codex hands its MCP servers no
session id — setup registers the server with only `MUBIT_CC_DATA_DIR` and
`MUBIT_CC_PLUGIN_ROOT` — so under Codex a tool result always renders in full and marks
nothing. The hooks carry `session_id` natively, so the per-prompt injection still degrades a
repeat to a pointer, and `bin/admin.mjs` renders in full on every host.

---

## What leaves your machine, and what does not

Captured tool calls, their output, your prompts and the model's replies are sent to **your**
Mubit endpoint and nowhere else. Before any of it is written even to the local spool, three
stages run in order — the same three as the Claude Code plugin's, whose README carries the full
rule tables:

1. **Pattern scrub.** Every match becomes `[REDACTED:<kind>]`, naming the rule that fired:
   credential assignments, vendor API keys, bearer tokens, private key blocks, JWTs, and a
   high-entropy catch-all. Hex-only strings cannot trip it, so git SHAs survive.
2. **Path denylist — dropped entirely, not scrubbed.** A redacted `.env` is still a map of which
   secrets a project holds. The floor is `.env*`, key and certificate files, `secrets/`,
   `.ssh/`, `.aws/`, `.gnupg/`, `credentials` and `.netrc`, **plus everything git ignores**;
   `MUBIT_CC_CAPTURE_DENY` appends your own globs and never replaces the floor.
3. **Byte caps.** 4 KiB per tool-input field and 8 KiB per output, cut on a UTF-8 boundary. The
   scrub runs before the cap, so truncation cannot leave a recognizable half of a secret.

Two things are Codex-shaped. A `shell` or `apply_patch` result arrives as a bare string rather
than an object, and is captured in full either way. And an `apply_patch` names its files nowhere
but inside the patch, so the denylist reads the paths out of the patch body — a patch that
touches `.env` is dropped whole, not recorded as "touched `.env`".

`MUBIT_CC_REDACT=0` disables stage 1 only; the denylist and the caps always run. The local log
is scrubbed too. The plugin suppresses its own traffic: an `mcp__mubit__*` call, a shell
command mentioning the endpoint or `MUBIT_*`, and a read inside its own data directory are
never captured.

### What a capture records about files

A tool call that changed a file carries a structured record of it: `metadata_json.files` on the
item, one `{path, kind}` per file with `kind` one of `add`, `update`, `delete`. Under Codex
the kinds come from the patch's own `*** Add/Update/Delete File:` markers, which is more than
either host states anywhere else — `delete` is only ever recorded here. A shell command carries
no `files` field at all, so the field's presence means a change. The same rows are merged into
`runs/<run_id>/files.json`, a per-run index of what is in play — kinds as a set, an occurrence
count, most recently touched first — so a later recall can ask about the files without a round
trip. An import records the same rows for historical `FileChange` items.

---

## Importing the history already on this machine

A fresh install knows nothing that happened before it. The rollouts are still on disk, and
`mubit-memory:import` reads them:

```
node <plugin-root>/bin/import.mjs
```

That is a **dry run**: it prints where it read from, the projects in scope, and how many items it
would send, one line per source. Nothing is sent until `--send` is on the command line. Codex
reads no `disable-model-invocation` key, so the rule that the model may not run this on its
own initiative — or pass `--send` unless the user said to — lives in the skill's prose, and the
suite holds it there.

Under this host the default is `--source codex`: the rollouts under `~/.codex/sessions` (or
`$CODEX_HOME/sessions`), in both the shape Codex wrote before 0.149 and the one it writes now,
skipping the reviewer threads Codex spawns to approve its own actions and the preamble it writes
in the user's voice at the top of every thread since 0.149. `--source claude-code` reads
`~/.claude/projects` instead, and `--source all` reads both against one item cap and one set of
cursors. A Codex item carries `tool:codex` in its tags and a Claude Code one `tool:claude-code`,
whichever host ran the import, so the two histories stay tellable apart once stored.

The scope is this project plus the git worktrees linked to it; `--all` is every project on the
machine and is a flag somebody types. Each rollout keeps a cursor under `import/` in the data
directory, so a second run over unchanged files reads nothing and an interrupted import resumes —
a claim about this client's bookkeeping, not about what the server stores. An imported tool call
carries the item id live capture would have minted for the same call (`cc-<item id>`) and
`imported: true` in its metadata. Three counts are findings, not decoration: `denied` is the
denylist working, `oversize` is lines too large to read, and `this answer is incomplete` means a
bound was hit and the import is a prefix of the history.

When a batch is refused, the counts line is followed by the reason — `ingest failed (<state>):
<message>`, the same sentence the plugin logs — so `failed 1` never stands alone. The case this
host meets first: Codex runs an unapproved command inside its sandbox with the network off, and
a `--send` from there is refused before a rollout is opened, with that sentence on the terminal.
A dry run only reads and goes ahead; the send needs the command run with escalated permissions,
which the skill tells the model to ask for.

---

## Handing work to another agent

A handoff is a note from one agent to another inside a run — "review this", "continue from
here", "approve before I execute" — and feedback is the answer: a verdict (`approve`,
`request_changes`, `block`, `acknowledge`) filed against the handoff's id. A handoff nobody has
answered is **open**.

```
node <plugin-root>/bin/handoff.mjs send --to claude-code --action review "the auth diff is ready"
node <plugin-root>/bin/handoff.mjs list --open
node <plugin-root>/bin/handoff.mjs feedback <handoff_id> --verdict approve --comments "fine"
```

A note sent from this plugin is signed `codex`; `--to claude-code` reaches a Claude Code session
in the same directory, because the two share the run. Every subagent files one without being
asked: `SubagentStop` stores its result as a handoff from that subagent's `codex-sub-…` identity
to this session's role, addressed for review, with zero network — it rides the ordinary drain,
redaction and circuit breaker included — and under the **parent's** run id. A sub-run id never
reaches the wire, and there is no way to address a note to another run.

"Open" is computed by the command, not by the instance: the instance never flips a handoff's
`active` flag and has no list route, so the command reads both entry types for the run and
joins them — open means no feedback names that id. With two sessions live in one data directory
the command refuses with `ambiguous_run` and names them rather than guessing; pass `--run`.

---

## Connection states

There is no status line here, so the state is read from the run marker
(`status/<run_id>.json` under the data directory) and reported by name by `mubit-memory:doctor`.
They are typed separately because each has a different fix.

| State | What it means | The fix |
| --- | --- | --- |
| `ready` | A 2xx whose body is Mubit's own `OK`. The connection is fine. | If memory still looks wrong, the problem is content or scope, not connectivity — run `mubit-memory:doctor` and look at memory health and ingest jobs. |
| `unconfigured` | No endpoint is set, so nothing was dialled. Not a fault — the plugin is installed and waiting. | Run `mubit-memory:auth`. Capture keeps buffering meanwhile and is sent once an endpoint exists. |
| `unreachable` | `ECONNREFUSED` / `ENOTFOUND` / `EHOSTUNREACH` / `ECONNRESET`. Nothing is listening. | Check `endpoint` is correct and your instance is running. |
| `server_error` | 5xx, a 2xx whose body is not what the route returns, or a 4xx that is a payload problem or backpressure. Something is up and answering wrongly. | Retry, then check your instance's status in the console. If it persists, confirm `endpoint` points at Mubit and not at a proxy or SSO portal — those answer 200 too. |
| `auth_failed` | 401 or 403. The key is missing, wrong, or revoked. | Set a valid `mbt_...` key via `mubit-memory:auth`. Sticky, and deliberately does not open the breaker: it is the one error you can fix. |
| `not_responding` | Three or more *consecutive* timeouts. | Usually load, not death. Retry before concluding anything. |

Two readings that look like faults and are not: `warming`, inside the 20-second cold-start
window the first time a given endpoint is seen; and the breaker's pause after 5 failures in
300 s, during which requests are skipped on purpose and one probe dials when the cooldown ends.
A single timeout is never a verdict.

---

## Troubleshooting

Codex first — these have no Claude Code counterpart, and most of them are silent:

| Symptom | Cause | Fix |
| --- | --- | --- |
| Nothing at all: no `status/` directory, no markers, no injected memory | The hooks are not trusted. Under `codex exec` an untrusted hook is skipped silently — no prompt, no warning, exit 0 | `mubit-memory:doctor`, whose step 0 asks Codex's `hooks/list` for each entry's `trustStatus`; then `mubit-memory:setup`, or approve the Mubit entries in `/hooks` |
| The same, right after installing | `hooks.json` was never installed — the copy in the plugin cache is inert | Run `mubit-memory:setup` |
| A literal `{{PLUGIN_ROOT}}` in `~/.codex/hooks.json` | Somebody copied the template by hand. It is a placeholder `setup` substitutes, and Codex expands nothing | Run `mubit-memory:setup`; it replaces the entries under this plugin's root |
| It worked until the upgrade | Upgrading rewrote the registrations, which changed their content hashes and returned them to untrusted | Re-run `setup`, and re-trust |
| Reflections never appear; `reflect.status` on the marker is stale | `MUBIT_CC_SESSION_END_DETACH=0`, so the reflect was killed at Codex's three-second clamp | Leave it on. Run `mubit-memory:reflect` by hand at the end of a long session |
| Two directories under `~/.claude/plugins/data/` hold a run with the **same name** | The run id sharing worked and the two harnesses wrote to different stores | Re-run `setup` with `--data-dir=<the one holding credentials.json>`. Memory written to the other one before the fix is recoverable by hand, not automatically |
| No status line | By design: Codex's status line is a fixed list of built-in items | Read the marker, or ask `mubit-memory:doctor` |

Then the ones both hosts share:

| Symptom | Cause | Fix |
| --- | --- | --- |
| Everything connects, recall is always empty | Writes are accepted and indexed a moment later, so a recall right after a capture can miss | `mubit-memory:doctor` and check the ingest job states |
| A saved lesson never becomes visible in another project | `mubit_learned` writes at the `mcpLessonScope` ceiling, `session` by default | Raise `MUBIT_CC_MCP_LESSON_SCOPE` to `global`, or keep reflection on and run `mubit-memory:reflect` at meaningful checkpoints |
| `Config error: MUBIT_CC_RUN_STRATEGY=static requires MUBIT_CC_RUN_ID` | `static` with no pin | Set `MUBIT_CC_RUN_ID` for both tools and re-run `setup`, or pick another strategy |
| Edits to the plugin have no effect | A marketplace install is a copy under `$CODEX_HOME/plugins/cache` | Re-add the marketplace and the plugin, then re-run `setup` |
| Something you did not want captured got captured | Redaction is per-value, not per-concept | Add a glob to `MUBIT_CC_CAPTURE_DENY`, and remove the entry with `mubit-memory:forget` |

Local state and logs for a run:

```bash
ls ~/.claude/plugins/data/mubit-memory*/runs/*/     # note the *: the directory carries a suffix
cat ~/.claude/plugins/data/mubit-memory*/status/*.json
tail ~/.claude/plugins/data/mubit-memory*/logs/mubit-cc.log
```

Raise the detail with `MUBIT_CC_LOG_LEVEL=debug`. The log is scrubbed on the way out, so it is
safe to attach to an issue.

---

## Development

```bash
npm test                                    # 436 gates
MUBIT_CC_TEST_TARGET=dist npm test          # the same, against the committed bundles
npm run build                               # rebuild hooks/dist, bin/, mcp/dist
node ../claude-code/scripts/verify-manifests.mjs
```

`hooks/dist`, `bin/` and `mcp/dist` are **committed artifacts**, re-included in `.gitignore`
on purpose: a Codex install is a file copy, not a build, so whatever is committed is what
runs. `mcp/dist/server.js` is a byte-identical copy of the Claude Code plugin's vendored
bundle — two independently installable plugins cannot share a path, and the build copies it
rather than regenerating it.

Every change to `../claude-code/lib` or `../claude-code/hooks/src` changes both plugins. Run
both suites: this one, and the 1961 next door.

[`test/fixtures/observed/`](test/fixtures/observed/README.md) is the record of what Codex
actually does — payloads the host wrote to a recorder hook during a real session, and its
verdicts on what a hook answered — and is the reason several of the decisions above are what
they are. Read it before assuming a Codex behaviour matches Claude Code's.

---

## Links

- User guide, from nothing installed to memory that survives a session: [`docs/user-guide.md`](docs/user-guide.md)
- Documentation: <https://docs.mubit.ai/integrations/codex>
- Source: <https://github.com/mubit-ai/claude-plugins>
- License: Apache-2.0 — [`LICENSE`](LICENSE); third-party code bundled into the MCP server is attributed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), the same file the Claude Code plugin ships, because the bundle is the same
