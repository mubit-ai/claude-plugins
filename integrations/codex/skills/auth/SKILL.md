---
name: auth
description: Sign in to Mubit and store an API key for this machine. Use when the plugin is freshly installed, when it reports auth_failed, or when a key has been rotated or revoked.
---

**This skill never installs anything.** It opens a browser, receives a key, checks it against
the instance, and writes it to one file. It does not install packages, start services, or touch
the user's shell profile. A memory plugin that runs installers is a trust failure.

## Step 0 — resolve the binary

No environment variable carries this plugin's path under Codex. Codex lists each skill with the
absolute path of its `SKILL.md`; **this file** is at `<plugin-root>/skills/auth/SKILL.md`, so
the binary is two directories above it:

```
<plugin-root>/bin/auth.mjs
```

Resolve that to an absolute path from this file's own location and use it in every command
below. Do not write `${CLAUDE_PLUGIN_ROOT}`: Codex sets no plugin-root variable of any
spelling, so the shell expands it to nothing and `node /bin/auth.mjs` fails with ENOENT — on
the one skill a user reaches for when nothing else works.

## What it produces

Two values, which are the whole of the plugin's setup:

| Setting | Value |
| --- | --- |
| `endpoint` | the user's Mubit instance URL, e.g. `https://eu.mubit.ai` |
| `apiKey` | a key of the form `mbt_...` |

They land in `<data-dir>/credentials.json`, owner-only (mode 600), where the data directory is
`MUBIT_CC_DATA_DIR` if set and otherwise `~/.claude/plugins/data/mubit-memory`. That is the
same directory the Claude Code plugin uses, deliberately: the two share one memory of a
project, so they share one credential too. It survives plugin updates, so this is a
once-per-machine step rather than a once-per-release one.

## Step 1 — run it

```bash
node "<plugin-root>/bin/auth.mjs" --json
```

This opens the Mubit console in a browser. The user signs in (or signs up — the same page does
both), and the key comes back over a loopback callback on `127.0.0.1`.

**Prefer this over asking the user to paste a key.** A key pasted into the conversation is in
the transcript, and transcripts get shared, exported, and attached to bug reports. In the
browser flow the key never passes through the conversation at all.

## Step 2 — read the exit code

| Exit | Meaning | What to tell the user |
| --- | --- | --- |
| `0` | Signed in, and the key was checked against the instance. | Report the endpoint, then go to step 3. |
| `2` | The workspace is still provisioning. **Not a failure.** | "Your workspace is still being created — usually a minute or two. Run `mubit-memory:auth` again shortly; it picks up where it left off." Do not change anything. |
| `1` | Something went wrong. The `state` field says which. | See the table below. |

On exit `1`, `state` is one of:

| `state` | What it means | What to tell the user |
| --- | --- | --- |
| `browser_failed` | No browser opened, or the flow timed out. | Fall through to step 2b. This is the common case over SSH and in containers. |
| `auth_failed` | The instance rejected the key. | The key is wrong, revoked, or issued for a different instance. Issue a new one in the console. |
| `unreachable` | Nothing answered at the endpoint. | The endpoint is wrong, or the instance is not running. This is not a key problem — do not have them reissue one. |
| `server_error` | The instance is up and failing. | Retry once, then check the instance in the console. The client cannot fix it. |
| `invalid_key` | What was supplied is not `mbt_`-shaped. | A truncated paste. Ask for the whole key. |

### Step 2b — no browser

Ask the user to issue a key at <https://console.mubit.ai>, then run it with the key in the
environment for that one command:

```bash
MUBIT_AUTH_KEY='mbt_…' node "<plugin-root>/bin/auth.mjs" --paste --json
```

The key goes in the environment rather than in `--key` because a process's arguments are
readable by every user on the machine, and its environment is not. Never put the key in a
command-line flag, and never echo it back.

Codex runs a shell command through a **login shell**, so a `MUBIT_API_KEY` exported in the
user's `.zshrc` or `.bashrc` reaches the plugin and outranks what this skill writes. If a key
is configured and the plugin still reports `auth_failed`, check the profile before reissuing.

## Step 3 — the session boundary

Nothing here reaches a session that is already running: the hooks and the MCP server read their
configuration when the session starts. **Start a new Codex session** before concluding that the
sign-in did not work. This is the single most common "it's still broken" report immediately
after a successful sign-in, and it is not a fault. Say it explicitly.

## Related

- `mubit-memory:setup` — merges the hook registrations, registers the MCP server, and confirms
  the instance answers. On a fresh Codex install **that skill is the one that has to run**;
  this one only supplies the credential it checks.
- `node "<plugin-root>/bin/auth.mjs" --status` — what is stored right now. Reports whether a
  key is present, never the key itself. Exits non-zero when nothing is configured.
- `node "<plugin-root>/bin/auth.mjs" --logout` — removes the stored credentials.

If the user exports `MUBIT_API_KEY`, that wins over what this skill writes. That is deliberate:
a CI environment variable should not be silently overridden by a login. Say so rather than
authenticating again in a loop.
