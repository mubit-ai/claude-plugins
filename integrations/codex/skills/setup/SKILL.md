---
name: setup
description: First-run setup for Codex — merge Mubit's hook registrations into $CODEX_HOME/hooks.json, register the MCP server, and confirm the endpoint and key. Use when the plugin is freshly installed, after an upgrade, or when it appears installed but nothing is being captured.
---

**This skill never installs anything.** It writes two configuration files the user already
owns, tells them exactly what it is about to write, and confirms the instance answers. It does
not install packages, start services, or touch the user's shell profile. A memory plugin that
runs installers is a trust failure.

It does have more to do under Codex than under Claude Code, and the reason is worth stating
before you start, because it decides the whole shape of the work:

> **Codex does not read a plugin's `hooks.json`, and cannot resolve a plugin's `.mcp.json`
> entry point.** A `hooks.json` bundled in a plugin is copied into the install cache and then
> ignored — `hooks/list` reports every hook it *does* see as `source: "user"` with
> `pluginId: null`. And a plugin-declared MCP server gets no path substitution of any kind:
> `${CLAUDE_PLUGIN_ROOT}/x.mjs`, `./x.mjs` and `x.mjs` all fail to start, because a relative
> path resolves against the *project* directory and there is no variable layer at all.

So the plugin ships both files as **templates** and this skill installs them into the user
layer with the paths resolved. Skipping this step gives a plugin that installs perfectly, lists
its skills, and captures nothing.

## Step 0 — find the plugin root

Everything below needs this plugin's absolute install path, and no environment variable
carries it. Codex lists each skill with the absolute path of its `SKILL.md`; this file is at
`<plugin-root>/skills/setup/SKILL.md`, so the root is two directories above this file. Resolve
it once and use it throughout. Verify before continuing:

```bash
ls "<plugin-root>/hooks/dist/capture.mjs" "<plugin-root>/mcp/dist/index.js"
```

Both must exist. They are committed artifacts — there is no build step at install time — so if
either is missing the install is damaged and reinstalling is the fix, not anything below.

## Steps 1-3, as one command

The mechanical half of this — substitute, merge, register, trust — is
`<plugin-root>/scripts/setup.mjs`, so you do not have to hand-roll a JSON-RPC handshake to
read the trust hashes:

```bash
node "<plugin-root>/scripts/setup.mjs" "<plugin-root>"
```

**Read step 3 before you run it**, because that command records hook trust and that is the
user's decision, not yours. Pass `--no-trust` to do everything except that, and
`--with-pre-tool` to include the `PreToolUse` registration. The script merges rather than
overwrites, backs up both files it touches, and trusts only hooks under this plugin root.

What follows is what it does, and what to tell the user about each part. If the script is
missing — an older install — do it by hand as described; the results are identical.

## Step 1 — merge the hook registrations

Read `<plugin-root>/hooks.json`, replace every `{{PLUGIN_ROOT}}` with the resolved path, and
merge the result into `$CODEX_HOME/hooks.json` (`~/.codex/hooks.json` unless `CODEX_HOME` says
otherwise).

**Merge, do not overwrite.** That file is the user's, and other tools register there too.
Read what is present, keep every entry that is not Mubit's, and replace only the handlers whose
command names this plugin's `hooks/dist/`.

Two things about that file that will bite otherwise:

- It accepts exactly two top-level fields, `description` and `hooks`. Any other key is a hard
  parse error that takes **every** registration in the file down, not just the offending one.
- Codex clamps the `SessionEnd` timeout to 3 seconds whatever the file says, and prints a
  warning on stderr. The shipped template already asks for 3.

One registration is conditional. `PreToolUse` exists only to show a stored Mubit rule in front
of a matching tool call, and that feature (`MUBIT_CC_PRE_TOOL_WARNINGS`) is **off by default**.
Codex has no `if:` predicate, so a registered `PreToolUse` costs a process spawn on every shell
command whether the feature is on or not. **Omit the `PreToolUse` block unless the user has
turned the warnings on**, and say that you did.

## Step 2 — register the MCP server

```bash
codex mcp add mubit -- node "<plugin-root>/mcp/dist/index.js"
```

The server must be named `mubit`: the model sees each tool as `mcp__<server>__<tool>`, and
every skill in this plugin names `mcp__mubit__…`. Confirm with `codex mcp list`.

## Step 3 — trust the hooks, and ask first

A registered hook does not run until it is trusted. Under `codex exec` an untrusted hook is
skipped **silently** — no prompt, no warning, exit 0 — which is why this step is not optional
and why its absence is so hard to diagnose.

Trust is normally granted by a human in the `/hooks` screen. It can also be written directly:
each hook's `key` and `currentHash` come from the app server's `hooks/list`, and the pair goes
into `$CODEX_HOME/config.toml` as

```toml
[hooks.state."<key>"]
trusted_hash = "<currentHash>"
```

**Ask before writing it.** That entry is the control Codex uses to stop a hook running
unreviewed, and answering it on the user's behalf defeats the control however good the
intentions. Show them the exact commands you are about to trust — all of them, in full — and
get a yes. If they would rather do it themselves, tell them to run `/hooks` in the Codex TUI
and approve the Mubit entries there; the result is identical.

Editing any registration changes its hash and returns it to untrusted, so this step has to be
repeated after every upgrade or edit. Say that too.

## Step 4 — confirm the endpoint and key

Two values, and nothing else:

| Setting | Value |
| --- | --- |
| `endpoint` | the user's Mubit instance URL, e.g. `https://eu.mubit.ai` |
| `apiKey` | a key of the form `mbt_...` |

Precedence, highest first: `MUBIT_ENDPOINT` / `MUBIT_API_KEY` in the environment, then
`<data-dir>/credentials.json` (what `mubit-memory:auth` writes), then
`<project>/.mubit-cc.json`.

Codex has no plugin settings UI and no `CODEX_PLUGIN_OPTION_*` variables — the strings
`PLUGIN_OPTION` and `userConfig` appear nowhere in its binary — so those three rungs are the
whole ladder. Do not send a Codex user to a `/plugin` configure screen; it does not exist here.

**If either value is missing, run `mubit-memory:auth`.** It opens the console, signs the user
in, checks the key against the instance and stores it, which is the whole of what this skill
would otherwise ask them to do by hand.

## Step 5 — confirm with `mcp__mubit__mubit_status`

A `ready` state, the expected endpoint echoed back, and a run id is a finished setup. Report
those three things and stop.

Anything else maps to one cause:

| Result | What it means | What to tell the user |
| --- | --- | --- |
| `auth_failed` | The key is missing, wrong, or revoked. Not a network problem. | Run `mubit-memory:auth` to sign in again. Nothing else in this skill helps. |
| `unreachable` | Nothing is listening at that address. | The endpoint is wrong, or the instance is not running. Check both in the console. |
| `warming` | The instance is still starting. | Wait and retry — this is not a failure. |
| `server_error` | The instance is up and failing. | Retry once, then check the instance's status in the console. The client cannot fix it. |
| `not_responding` | Three or more consecutive timeouts. | Usually load, not death. Retry before concluding anything. |

## Step 6 — the session boundary

None of the above reaches a session that is already running: hooks are read at session start,
and the MCP server is launched then too. **Start a new Codex session before testing.** This is
the single most common "it's broken" report and it is not a fault. Say it explicitly whenever
setup is run in the session that installed the plugin.

## Finish

End with `mcp__mubit__mubit_status`. A `ready` state, the expected endpoint, and the run id the
hooks derived is a working install. Anything else is a job for `mubit-memory:doctor`, whose
step 0 is the Codex-specific one this skill just tried to prevent.
