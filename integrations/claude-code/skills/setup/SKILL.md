---
name: setup
description: "First-run setup: confirm the Mubit endpoint and API key are set and that the instance answers. Use on a fresh install, or when the plugin reports auth_failed or unreachable."
disable-model-invocation: false
tools: ["mcp__plugin_mubit-memory_mubit__mubit_status"]
---

**This skill never installs anything.** It reads what is configured, tells the user exactly what
is missing, and gives them the one place to fix it. Do not install packages, do not start
services, do not write into their shell profile. A memory plugin that runs installers is a trust
failure.

## What a working setup looks like

Two values, and nothing else:

| Setting | Value |
| --- | --- |
| `endpoint` | the user's Mubit instance URL, e.g. `https://api.mubit.ai` |
| `apiKey` | a key of the form `mbt_...` |

**If either is missing, run `/mubit-memory:auth`.** It opens the console, signs the user in,
checks the key against the instance and stores it — which is the whole of what this skill would
otherwise ask them to do by hand. Do not walk somebody through the manual steps first.

The manual route still exists and still wins over what `auth` writes: `/plugin` → Mubit Memory →
configure puts the key in the OS keychain, which is the best place for it. Prefer that for a
long-lived install; prefer `/mubit-memory:auth` for getting someone working in the next minute.

## Step 1 — read what is configured

Precedence, highest first: the plugin's `endpoint` and `apiKey` settings
(`CLAUDE_PLUGIN_OPTION_*`, where the keychain-backed key lives), then `MUBIT_ENDPOINT` /
`MUBIT_API_KEY` in the environment, then `${CLAUDE_PLUGIN_DATA}/credentials.json` (what
`/mubit-memory:auth` writes), then `${CLAUDE_PROJECT_DIR}/.mubit-cc.json`.

- **No endpoint** → there is nothing to talk to. Capture spools locally and recall returns
  nothing; nothing is lost and nothing is sent. Point the user at the console, then at
  `/plugin` → configure.
- **No key** → same destination. An endpoint without a key gets `auth_failed` on every call.

## Step 2 — confirm with `mubit_status`

A `ready` state, the expected endpoint echoed back, and a run id is a finished setup. Report
those three things and stop.

Anything else maps to one cause:

| Result | What it means | What to tell the user |
| --- | --- | --- |
| `auth_failed` | The key is missing, wrong, or revoked. Not a network problem. | Run `/mubit-memory:auth` to sign in again. Nothing else in this skill helps. |
| `unreachable` | Nothing is listening at that address. | The endpoint is wrong, or the instance is not running. Check both in the console. |
| `warming` | The instance is still starting. | Wait and retry — this is not a failure. |
| `server_error` | The instance is up and failing. | Retry once, then check the instance's status in the console. The client cannot fix it. |
| `not_responding` | Three or more consecutive timeouts. | Usually load, not death. Retry before concluding anything. |

## Step 3 — remind them about the session boundary

`/reload-plugins` registers the hooks but does not fire `SessionStart`, so until the user starts
a **new** session there is no run id, no registered agent, and nothing on the status line. This
is the single most common "it's broken" report and it is not a fault. Say it explicitly whenever
setup is run in the same session as the install.

## Step 4 — offer the `/dashboard` shim, and only offer it

Once setup reports `ready`, mention once that there is a page:

> There is a local dashboard — `/mubit-memory:dashboard` — that shows your lessons, what recall
> cost on each prompt, and whether captures are landing. Want me to add a shorter `/dashboard`
> alias for it?

**Do not create it unless they say yes.** This skill installs nothing on its own, and a file
written into someone's home directory without being asked is exactly the kind of "helpful"
that costs the plugin its trust. If they decline, drop it and do not raise it again.

If they accept, write a personal command at `~/.claude/commands/dashboard.md` holding:

```markdown
---
description: Open the Mubit memory dashboard
allowed-tools: ["Bash(node <the absolute path to bin/dashboard.mjs>:*)"]
---

Run `node "<the absolute path to bin/dashboard.mjs>" --json` and give the user the URL it
prints, verbatim — the token is in the URL and a retyped one will not work.
```

Resolve `<the absolute path>` from `${CLAUDE_PLUGIN_ROOT}` at the moment you write the file:
that variable is set inside the plugin and not in a personal command, so both occurrences have
to be a literal path. Say the consequence out loud — **reinstalling the plugin at a different
path breaks the alias**, and the fix is to delete the file and re-run this skill.
`/mubit-memory:dashboard` keeps working either way, which is why the shim is a convenience and
not the recommended route.

The alias asks for the command in prose, the way every other script-running skill here does. It
deliberately does not use the host’s pre-execution form — an exclamation mark followed by a
backtick-quoted command — because the host scans a **skill body** for that form and runs what
it finds before the skill is read, and a fenced code block is not an escape. A worked example of
it on this page would run this page’s own `<the absolute path…>` placeholder as a shell command
every time somebody typed `/mubit-memory:setup`.

## Finish

End with `mubit_status`. A `ready` state, the expected endpoint, and the run id the hooks derived
is a working install. Anything else is a job for `/mubit-memory:doctor`, which reads the typed
connection state and maps it to its specific fix.
