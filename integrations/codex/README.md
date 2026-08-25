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
node ~/.codex/plugins/cache/mubit/mubit-memory/0.10.0/scripts/setup.mjs \
     ~/.codex/plugins/cache/mubit/mubit-memory/0.10.0
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
| `MUBIT_CC_PINS` | `1` | Render the constraints pinned with the `pin` skill above the recalled block on every prompt of the run — including the prompts recall skips. Capped at five pins, 200 characters each and 240 tokens; costs no extra request on the prompt path. Off restores the injected block exactly. |
| `MUBIT_CC_DATA_DIR` | — | Overrides where state lives. Highest precedence of any data-dir input. |
| `MUBIT_CC_STATUSLINE` | `0` here | Defaults **off** under Codex, whose status line is a fixed list of built-in item ids with nothing scriptable in it. |

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
registrations it writes. `lib/boot.mjs` runs the same search at runtime as a fallback.

Check it with `ls ~/.claude/plugins/data/` and pass `--data-dir=<path>` to `setup` if the
resolution picked wrong. Getting this wrong is quiet and total: the two harnesses derive the
*same run id* and write it to two different stores, so you get two half-memories of one
project and no error anywhere.

A Codex-only user ends up with a `~/.claude/` directory they never asked for.
`MUBIT_CC_DATA_DIR` moves it, at the cost of the sharing.

Which harness wrote an entry is recorded as its agent role — `codex` or `claude-code` — so the
two are distinguishable where it matters, and count as two actors where something upstream is
asking how well attested a lesson is.

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
| `pin` | Pin a standing constraint for the rest of this run — "don't touch the vendored server" — so it is put in front of the model on every prompt, including the ones recall skips. A pin is cleared when it stops being true; a durable, cross-session rule is `remember`. |

There is no `mubit-recall` subagent here. Codex has no plugin-defined agent types — every
`SubagentStart` reports `agent_type: "default"` — so a markdown subagent would be a file
nothing reads. Point a generic sub-agent at the `recall` skill instead; the isolation is the
part that mattered.

---

## Development

```bash
npm test                                    # 243 gates
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
both suites: this one, and the 1067 next door.

[`test/fixtures/observed/`](test/fixtures/observed/README.md) is the record of what Codex
actually does — payloads the host wrote to a recorder hook during a real session, and its
verdicts on what a hook answered — and is the reason several of the decisions above are what
they are. Read it before assuming a Codex behaviour matches Claude Code's.
