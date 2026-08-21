# Harness probe — what Codex CLI 0.146.0 actually does with hooks

Everything below was executed on 2026-08-21 against `codex-cli 0.146.0` (Homebrew,
`@openai/codex-darwin-arm64`), on macOS 26.5, with an **isolated `CODEX_HOME`** — a throwaway
directory, never `~/.codex`. Every **Expect** block is a recorded transcript, not a prediction.

**Re-checked against 0.149.0** the same day, after Codex self-updated mid-session. All
twenty-one extracted schemas are **byte-identical** between the two builds, and the §4-§8 run
reproduces exactly: same wire, same steer block, same turn keyed by `turn_id`, no hook warning
of any kind. Nothing in this file changed. The only difference is in the Appendix's extraction
recipe, which the newer binary's string layout broke — see there.

The port's design rests on five questions. The plan named them; this file answers them. Four
answers changed the design, so read §Answers first if you read nothing else.

**Time:** ~25 minutes, most of it waiting on model turns.
**Destroys:** nothing. Everything lives under one `mktemp -d` you delete in §9.

---

## Answers, up front

| # | Question | Answer | Consequence for the port |
|---|---|---|---|
| 1 | Are plugin-bundled hooks honoured? | **No.** A `hooks.json` in the plugin root is copied into the install cache and then ignored — `hooks/list` reports `source: "user"`, `pluginId: null` for every hook it *does* see, and a plugin-only `hooks.json` yields nothing at all. | The plugin ships `hooks.json` as **data**; `/mubit-memory:setup` merges it into `$CODEX_HOME/hooks.json`. This is the documented user layer and it works. |
| 2 | Which env vars reach a hook? | **None of the four.** `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, `PLUGIN_DATA`, `CLAUDE_PLUGIN_DATA` are all unset. The strings exist in the binary but are only ever populated for plugin-sourced hooks, and those never load. `CODEX_HOME` **is** exported. | Hook commands must carry an **absolute path**, written at merge time by `setup`. `lib/boot.mjs` synthesises `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` from its own module URL rather than reading them. |
| 3 | `timeout` or `timeoutSec`? | **`timeout`**, in seconds, in `hooks.json`. `timeoutSec` is the *app-server protocol* spelling and is what `hooks/list` echoes back. Codex **clamps `SessionEnd` to 3s** and says so on stderr. | Registrations use `timeout`. SessionEnd cannot be given 8s as it is under Claude Code, which makes `sessionEndDetach` load-bearing rather than optional. |
| 4 | How does hook trust behave under `codex exec`? | Untrusted hooks are **silently skipped** — no prompt, no warning, exit 0. Trust is persisted in **`config.toml`**, not `hooks.json`: `[hooks.state."<key>"] trusted_hash = "<currentHash>"`. Both values come from the app-server's `hooks/list`. | `setup` can grant trust non-interactively, but only after showing the user what it will trust and asking. `--dangerously-bypass-hook-trust` is the automation escape hatch. |
| 5 | What prefix does the model see for MCP tools? | **`mcp__<server>__<tool>`** → `mcp__mubit__mubit_recall`. | Skills and prose name `mcp__mubit__*`. Confirmed by a live `PreToolUse` payload, not inferred. |

Two answers that were not on the list but change the code:

- **Codex renames its shell tool to `Bash` in hook payloads**, with Claude Code's exact
  `tool_input: {command}` shape. `apply_patch`, `update_plan`, `view_image`, `web_search`,
  `collaborationspawn_agent` and `collaborationwait_agent` come through under their own names.
- **`tool_response` is a bare string** for `Bash` and `apply_patch` (`"Exit code: 0\n…"`),
  where Claude Code sends `{stdout, stderr, interrupted}`. For MCP tools it is the raw MCP
  result object.

---

## §1 — Isolate

Never point this at your real `~/.codex`: §4 writes hook registrations that fire on every
session, and §6 writes trust entries into `config.toml`.

```bash
export PROBE=$(mktemp -d)/probe
mkdir -p $PROBE/{out,proj} $PROBE/mkt/plugins/probe/.codex-plugin $PROBE/mkt/.agents/plugins
export CODEX_HOME=$PROBE/codexhome
mkdir -p $CODEX_HOME
cp ~/.codex/auth.json $CODEX_HOME/auth.json          # auth is per-CODEX_HOME
printf 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "low"\n' > $CODEX_HOME/config.toml
cd $PROBE/proj && git init -q && echo "hello probe repo" > README.md
```

**Expect** `$CODEX_HOME` to be the only Codex state this file ever touches. Check it:

```bash
echo $CODEX_HOME
```

**Expect** a path under `$TMPDIR`. If it prints `/Users/you/.codex`, stop.

---

## §2 — A throwaway plugin

The probe plugin does one thing: on every hook event it appends the payload, its argv and the
interesting slice of its environment to `$PROBE/out/hooks.jsonl`.

`$PROBE/mkt/plugins/probe/.codex-plugin/plugin.json`:

```json
{ "name": "probe", "version": "0.0.1", "description": "Probe plugin: dumps hook env and stdin.",
  "author": { "name": "Probe" }, "license": "Apache-2.0", "mcpServers": "./.mcp.json" }
```

`$PROBE/mkt/.agents/plugins/marketplace.json`:

```json
{ "name": "probe-mkt", "interface": { "displayName": "Probe Marketplace" },
  "plugins": [ { "name": "probe", "source": { "source": "local", "path": "./plugins/probe" },
    "policy": { "installation": "AVAILABLE", "authentication": "ON_USE" },
    "category": "Productivity" } ] }
```

Install it:

```bash
codex plugin marketplace add $PROBE/mkt
codex plugin add probe@probe-mkt --json
```

**Expect**

```json
{
  "pluginId": "probe@probe-mkt",
  "name": "probe",
  "marketplaceName": "probe-mkt",
  "version": "0.0.1",
  "installedPath": "…/probe/codexhome/plugins/cache/probe-mkt/probe/0.0.1",
  "authPolicy": "ON_USE"
}
```

Note `installedPath`: **install is a copy, not a link.** Editing the marketplace source has no
effect until `codex plugin remove && codex plugin add`. Every later step that edits the plugin
reinstalls it.

---

## §3 — Question 1: are plugin-bundled hooks honoured?

Write a `hooks.json` at the *plugin root* registering all eleven events, reinstall, and run a
turn that is certain to call a tool.

```bash
codex exec --json --dangerously-bypass-hook-trust --skip-git-repo-check -C $PROBE/proj \
  'Read README.md with the shell tool, then reply with one short sentence.' < /dev/null
```

**Expect** the turn to succeed and the tool call to happen —

```
{"type":"item.completed","item":{"id":"item_3","type":"command_execution",
 "command":"/bin/zsh -lc \"sed -n '1,240p' README.md\"","aggregated_output":"hello probe repo\n",
 "exit_code":0,"status":"completed"}}
```

— and **`$PROBE/out/hooks.jsonl` not to exist**:

```bash
test -f $PROBE/out/hooks.jsonl && wc -l $PROBE/out/hooks.jsonl || echo "NOT WRITTEN"
```

**Expect** `NOT WRITTEN`.

That is answer 1. The bundled `plugin-creator` reference is right that plugin manifests should
not carry `hooks`, and its own field guide (which documents `hooks` as a manifest path, and says
`hooks` is "supplemented on top of default component discovery") is wrong about this build.
`hooks.json` in a plugin is inert.

---

## §4 — The user layer, and question 2

Copy the same file to `$CODEX_HOME/hooks.json` and re-run the identical command.

```bash
cp $PROBE/mkt/plugins/probe/hooks.json $CODEX_HOME/hooks.json
```

**Expect** six invocations this time:

```
SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd
```

and on stderr, unprompted:

```
clamping SessionEnd hook timeout to 3s in …/codexhome/hooks.json
```

That single line answers question 3 twice over: `timeout` was the field Codex parsed, and
**SessionEnd is capped at 3 seconds** however large a number you write.

Now the environment each hook saw. The probe recorded every variable matching
`PLUGIN|CODEX|CLAUDE|PROJECT|WORKSPACE|HOOK|SESSION|AGENT`:

```json
{
  "CODEX_HOME": "…/probe/codexhome",
  "CODEX_MANAGED_PACKAGE_ROOT": "/opt/homebrew/lib/node_modules/@openai/codex",
  "CODEX_MANAGED_BY_NPM": "1"
}
```

**Expect no `PLUGIN_ROOT`, no `CLAUDE_PLUGIN_ROOT`, no `PLUGIN_DATA`, no `CLAUDE_PLUGIN_DATA`,
and no project-directory variable.** (Any `CLAUDE_*` you *do* see is leakage from a parent
Claude Code session that launched `codex`, not something Codex set. That is exactly why host
detection must not sniff for `CLAUDECODE`.)

The hook command is a **shell string**, run through `$SHELL -lc`. Both `$PLUGIN_ROOT` and
`${CLAUDE_PLUGIN_ROOT}` in the registration arrived as the empty string — shell expansion of an
unset variable, not host-side interpolation. There is no `${...}` substitution layer here at
all, which is the substantive difference from Claude Code's exec-form registrations.

The hook process `cwd` is the project directory, and `payload.cwd` says the same.

---

## §5 — The payloads

One recorded payload per event, trimmed only of the repeated `transcript_path`.

**SessionStart** — `source` has four values, not five. There is no `fork`.

```json
{ "session_id": "01a0240c-7f5a-7de0-b4e4-caa34b796e11",
  "transcript_path": "…/sessions/2026/08/21/rollout-2026-08-21T12-19-53-01a0240c-….jsonl",
  "cwd": "…/probe/proj", "hook_event_name": "SessionStart",
  "model": "gpt-5.6-sol", "permission_mode": "bypassPermissions", "source": "startup" }
```

**UserPromptSubmit** — `turn_id`, where Claude Code sends `prompt_id`.

```json
{ "session_id": "01a0240c-…", "turn_id": "01a0240c-7f97-7ca3-a641-cf8d141498a0",
  "cwd": "…/probe/proj", "hook_event_name": "UserPromptSubmit",
  "model": "gpt-5.6-sol", "permission_mode": "bypassPermissions",
  "prompt": "Read README.md with the shell tool, then reply with one short sentence." }
```

**PreToolUse / PostToolUse** — the shell tool arrives as **`Bash`**, with Claude Code's shape.

```json
{ "hook_event_name": "PostToolUse", "turn_id": "01a0240c-…",
  "tool_name": "Bash", "tool_input": { "command": "sed -n '1,240p' README.md" },
  "tool_response": "hello probe repo\n",
  "tool_use_id": "exec-58fe245b-9bd8-4ba2-b4f7-c50964aa140c" }
```

`tool_response` is a **string**. Claude Code sends an object. Anything that reaches into
`tool_response.stdout` has to tolerate both.

**Stop**

```json
{ "hook_event_name": "Stop", "turn_id": "01a0240c-…", "stop_hook_active": false,
  "last_assistant_message": "README.md says: “hello probe repo.”" }
```

**SessionEnd** — no `turn_id`, no `model`, no `permission_mode`, and `reason` is the constant
`"other"`.

```json
{ "session_id": "01a0240c-…", "cwd": "…/probe/proj",
  "hook_event_name": "SessionEnd", "reason": "other" }
```

### Other tool names

A turn asking for a plan, an MCP call and a file creation:

```
PreToolUse  | update_plan              | {"plan":[{"step":"…","status":"completed"}, …]}
PreToolUse  | mcp__probe__probe_ping   | {}
PermissionRequest | mcp__probe__probe_ping | {}
PreToolUse  | apply_patch              | {"command":"*** Begin Patch\n*** Add File: NOTES.md\n+probe note\n*** End Patch"}
PostToolUse | apply_patch              | "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nA NOTES.md\n"
PostToolUse | mcp__probe__probe_ping   | {"content":[{"type":"text","text":"pong"}]}
```

That is answer 5: **`mcp__<server>__<tool>`**.

### Subagents

Asking explicitly for delegation (Codex's default developer prompt forbids it otherwise):

```
PreToolUse  collaborationspawn_agent
PostToolUse collaborationspawn_agent   resp={"task_name":"/root/count_files"}
PreToolUse  collaborationwait_agent
SubagentStart   agent=01a02413-16ff-… type=default
PreToolUse  Bash   agent=01a02413-16ff-… type=default
PostToolUse Bash   agent=01a02413-16ff-… type=default
SubagentStop    agent=01a02413-16ff-… type=default
PostToolUse collaborationwait_agent    resp={"message":"Wait completed.","timed_out":false}
```

`collaborationspawn_agent` is the literal `tool_name` — a namespace glued to the tool with no
separator. Tool calls made *by* a subagent carry `agent_id` and `agent_type`; the parent's do
not. `SubagentStart.transcript_path` is the **agent's** rollout; `SubagentStop` carries both
`transcript_path` (the parent's) and `agent_transcript_path`.

```json
{ "hook_event_name": "SubagentStop", "session_id": "01a02413-0246-…",
  "turn_id": "01a02413-174a-…", "agent_id": "01a02413-16ff-…", "agent_type": "default",
  "stop_hook_active": false,
  "transcript_path": "…rollout-…-01a02413-0246-….jsonl",
  "agent_transcript_path": "…rollout-…-01a02413-16ff-….jsonl",
  "last_assistant_message": "There are **2 regular files** directly in the current directory. …" }
```

`PreCompact` and `PostCompact` were not reached — a probe turn is far too small to compact.
Their fixtures are built from the extracted schemas alone, and `codex-payload.test.mjs` says so.

---

## §6 — Question 4: hook trust

Re-run §4's command **without** `--dangerously-bypass-hook-trust`.

```bash
codex exec --json --skip-git-repo-check -C $PROBE/proj 'Say hi in five words.' < /dev/null
```

**Expect** exit 0, a normal answer, and **zero hook invocations**. The only diagnostic is the
SessionEnd timeout clamp. Nothing says "hooks were skipped"; nothing offers to trust them.

Codex's own view of the situation is available over the app-server, which is how the TUI's
`/hooks` screen is fed. Drive it on stdio:

```jsonc
--> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"probe","title":"probe","version":"0.0.1"}}}
--> {"jsonrpc":"2.0","method":"initialized","params":{}}
--> {"jsonrpc":"2.0","id":2,"method":"hooks/list","params":{}}
```

**Expect** one entry per registration:

```json
{ "key": "…/codexhome/hooks.json:pre_tool_use:0:0",
  "eventName": "preToolUse", "handlerType": "command",
  "matcher": null, "command": "node …/dump.mjs PreToolUse …",
  "timeoutSec": 10, "statusMessage": null, "additionalContextLimit": null,
  "sourcePath": "…/codexhome/hooks.json", "source": "user", "pluginId": null,
  "displayOrder": 0, "enabled": true, "isManaged": false,
  "currentHash": "sha256:13f74094efb0cf9d04dfba04f340f4851659601b81fc54d4ead2c20e511db003",
  "trustStatus": "untrusted" }
```

Two facts fall out of that record. `source: "user"` and `pluginId: null` confirm §3 from the
host's own mouth. And the `key` is `<sourcePath>:<snake_case_event>:<groupIndex>:<handlerIndex>`.

Trust is **not** stored in `hooks.json`. Writing a `state` key there is a hard parse error that
takes the whole file down:

```
failed to parse hooks config …/hooks.json: unknown field `state`, expected `description` or `hooks`
```

(Which also says `hooks.json` accepts exactly two top-level fields: `description` and `hooks`.)

It is stored in `config.toml`:

```toml
[hooks.state."/…/codexhome/hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:13f74094efb0cf9d04dfba04f340f4851659601b81fc54d4ead2c20e511db003"
```

**Expect** `hooks/list` to flip that one entry to `"trustStatus": "trusted"` and leave the other
ten `untrusted`. Write all eleven and re-run §6's un-bypassed command:

**Expect** `SessionStart, UserPromptSubmit, Stop, SessionEnd`.

So trust can be granted without a TUI. Whether it *should* be is a different question, and
`/mubit-memory:setup` answers it by printing the eleven commands it is about to trust and asking
first. Editing a registration changes its `currentHash`, the stored hash no longer matches, and
the hook goes back to being silently skipped — which is the behaviour a user should expect and
the reason setup re-runs the trust step after any change.

---

## §7 — `additionalContext` reaches the model

The whole recall mechanism depends on this. Make the probe answer `SessionStart` and
`UserPromptSubmit` with the shared envelope:

```json
{ "hookSpecificOutput": { "hookEventName": "UserPromptSubmit",
    "additionalContext": "PROBE-STEER-UserPromptSubmit: the magic word is xylophone47." },
  "suppressOutput": true }
```

```bash
codex exec --json --skip-git-repo-check -C $PROBE/proj \
  'What is the magic word? Answer in three words.' < /dev/null
```

**Expect**

```json
{"type":"agent_message","text":"It is xylophone47."}
```

The model has no other source for that string. Both injections land in the rollout as
`developer`-role messages, in order, around the user's prompt.

---

## §8 — The rollout transcript

`transcript_path` points at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl`.
It is JSONL, one envelope per line, and only some lines are conversation:

```
type=session_meta   keys=session_id,id,timestamp,cwd,originator,cli_version,source,…
type=event_msg      payload.type=task_started
type=response_item  payload.type=message   role=developer
type=response_item  payload.type=message   role=user
type=world_state
type=turn_context
type=response_item  payload.type=reasoning
type=event_msg      payload.type=agent_message
type=response_item  payload.type=message   role=assistant
type=event_msg      payload.type=token_count
type=event_msg      payload.type=task_complete
```

A conversation line is `{"type":"response_item","payload":{"type":"message","role":…,
"content":[{"type":"input_text"|"output_text","text":…}]}}`:

```json
{ "type": "response_item",
  "payload": { "type": "message", "role": "developer",
    "content": [ { "type": "input_text",
      "text": "PROBE-STEER-SessionStart: the magic word is xylophone47." } ] } }
```

Claude Code's transcript is `{"type":…,"message":{"role":…,"content":[{"text":…}]}}`. The
content-item `type` differs too (`input_text`/`output_text` vs `text`), so a reader must key off
the presence of `content[].text`, not off the item type. That is the whole of
`checkpoint.mjs`'s new sniffing.

---

## §9 — Skills, and tearing down

Plugin skills — unlike plugin hooks — load fine, namespaced `<plugin>:<skill>`:

```bash
codex exec --json --skip-git-repo-check -C $PROBE/proj \
  'List the skills available to you, verbatim names only.' < /dev/null
```

**Expect** the built-ins plus yours:

```
imagegen
openai-docs
plugin-creator
skill-creator
skill-installer
probe:probe-skill
```

Codex's skill frontmatter is `name` + `description`. There is no `allowed-tools` anywhere in the
binary; a `SKILL.json` may carry an `interface.short_description`, and the binary calls the
frontmatter `description` the "Legacy short_description from SKILL.md".

One thing not observable here: an MCP server's `initialize` **`instructions`** string never
appears in the rollout, and the rollout does not record the tool catalogue either, so this probe
cannot say whether Codex shows it to the model. The plugin does not rely on it — the same
guidance goes out through `SessionStart`'s `additionalContext`, which §7 proves lands.

```bash
codex plugin remove probe@probe-mkt
codex plugin marketplace remove probe-mkt
rm -rf $(dirname $PROBE)
unset CODEX_HOME PROBE
```

**Expect** your real `~/.codex/config.toml` to be byte-identical to before you started. It never
had a chance to be otherwise: `CODEX_HOME` was redirected in §1 before any `codex` ran.

---

## Appendix — extracting the hook schemas

The native binary embeds a draft-07 JSON Schema for every hook event's input and output. They
are what `test/fixtures/codex-hook-schemas/*.json` holds, and what `codex-payload.test.mjs`
validates every fixture against — a fixture written next to the implementation cannot falsify
it, one checked against the host's own schema can.

```bash
BIN=/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex
strings -n 2 "$BIN" > codex-strings.txt
```

The schemas sit in one contiguous block, each preceded by its title
(`post-tool-use.command.input`, `session-start.command.output`, …); brace-match from each
`{\n  "$schema"` and parse. **Expect 21**: eleven inputs, ten outputs — `SessionEnd` has no
output schema.

**`-n 2`, not `-n 8`.** The schemas are pretty-printed, so a closing `},` sits alone on a
two-character line. `strings -n 8` drops those, and what comes out is a schema block that
looks complete, greps fine for any field you go looking for, and will not brace-match — so an
extractor built on it silently yields **zero** schemas rather than failing. `-n 8` happened to
work on 0.146.0's binary and did not on 0.149.0's; there is no reason to think the layout is
stable, and no reason to use the larger bound.

Sanity-check the count before trusting the output. Twenty-one is the answer; anything else,
including nothing at all, means the recipe has drifted again rather than that Codex changed.

One of them carries this comment verbatim, which is as clear a statement of intent as the port
could ask for:

> Claude requires `reason` when `decision` is `block`; we enforce that semantic rule during
> output parsing rather than in the JSON schema.

That "rather than in the JSON schema" is not decoration, and the binary spells out what it
means. Alongside the schemas is a block of rejection messages the schemas do not encode:

```
PreToolUse hook returned unsupported continue:false
PreToolUse hook returned unsupported stopReason
PreToolUse hook returned unsupported suppressOutput
PreToolUse hook returned permissionDecision:deny without a non-empty permissionDecisionReason
PostToolUse hook returned reason without decision
PostToolUse hook returned unsupported suppressOutput
PostToolUse hook returned unsupported updatedMCPToolOutput
PermissionRequest hook returned unsupported continue:false
PermissionRequest hook returned unsupported suppressOutput
PermissionRequest hook returned unsupported updatedInput
PermissionRequest hook returned unsupported updatedPermissions
PermissionRequest hook returned unsupported interrupt:true
```

Every one of those fields **is** in the corresponding output schema, with a documented
default. So schema validity is necessary and not sufficient, and `codex-payload.test.mjs`
cannot be the whole gate — which is why `codex-hooks.test.mjs` runs every hook against a real
subprocess and reads what Codex actually says back.

### Correction — these fire, and this plugin was tripping three of them

The paragraph that used to sit here said the `suppressOutput` rules were "empirically accepted
on both 0.146.0 and 0.149.0", on the evidence that a full end-to-end run produced no
`type:"error"` item and nothing on stderr. **That was wrong**, and it was wrong in the most
expensive direction: it read an absence of evidence in one output channel as evidence of
absence, and signed off a list of rules that the extraction had already put in front of me.

What a real interactive session does, on 0.149.0, once per tool call:

```
• PostToolUse hook (failed)
  error: PostToolUse hook returned unsupported suppressOutput

• PermissionRequest hook (failed)
  error: PermissionRequest hook returned unsupported suppressOutput
```

Three events reject the field — `PreToolUse`, `PostToolUse`, `PermissionRequest` — and this
plugin emitted `{"suppressOutput": true}` on all three, because Claude Code accepts it
everywhere and the shared `lib/hook.mjs` had one envelope for both hosts. Recall, capture and
the MCP tools all worked correctly throughout; the only cost was a hook the user was told had
failed, twice per tool call.

The fix is `forHost()` in `lib/hook.mjs`: under `MUBIT_CC_HOST=codex`, and only there, the
field is dropped on those three events. It is cosmetic to us on all three — we attach no
`systemMessage` and no `additionalContext` to any of them, so there is nothing to suppress.

Two lessons worth carrying, both encoded as gates rather than as prose:

- **Schema validity is not acceptance.** `codex-payload.test.mjs` validated every hook's real
  stdout against the host's own output schema and went green, because `suppressOutput` is a
  declared property of that schema with a documented default. The rules live in a second place
  and had to be extracted into `test/fixtures/codex-output-rules.json`, which that test now
  checks every hook against.
- **`codex exec --json` is not where a hook failure shows up.** The stream carries no
  `type:"error"` item for one; the binary models the failure as `HookErrorInfo` with a status
  of `failed`, and the TUI is where it surfaced. An end-to-end run over that stream cannot be
  the only check that hooks are healthy — which is why `manual-test-codex.md` now reads the
  hook status out of the session rather than concluding from a quiet stderr.

Re-extract the list after a Codex upgrade. It is the half of the contract the schemas do not
carry, and nothing in the type system will tell you when it moves.
