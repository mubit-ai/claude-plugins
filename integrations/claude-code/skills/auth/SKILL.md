---
name: auth
description: "Sign in to Mubit and store an API key for this machine. Use on a fresh install, when the plugin reports auth_failed, or when a key has been rotated or revoked."
disable-model-invocation: false
allowed-tools: ["Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/auth.mjs:*)"]
---

**This skill never installs anything.** It opens a browser, receives a key, checks it against
the instance, and writes it to one file. It does not install packages, start services, or touch
the user's shell profile. A memory plugin that runs installers is a trust failure.

## What it produces

Two values, which are the whole of the plugin's setup:

| Setting | Value |
| --- | --- |
| `endpoint` | the user's Mubit instance URL, e.g. `https://api.mubit.ai` |
| `apiKey` | a key of the form `mbt_...` |

They land in `${CLAUDE_PLUGIN_DATA}/credentials.json`, owner-only (mode 600). That path
survives plugin updates, so this is a once-per-machine step, not a once-per-release one.

## Step 1 — run it

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/auth.mjs" --json
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
| `2` | The workspace is still provisioning. **Not a failure.** | "Your workspace is still being created — usually a minute or two. Run `/mubit-memory:auth` again shortly; it picks up where it left off." Do not change anything. |
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
MUBIT_AUTH_KEY='mbt_…' node "${CLAUDE_PLUGIN_ROOT}/bin/auth.mjs" --paste --json
```

The key goes in the environment rather than in `--key` because a process's arguments are
readable by every user on the machine, and its environment is not. Never put the key in a
command-line flag, and never echo it back.

## Step 3 — the session boundary

`/reload-plugins` registers the hooks but does not fire `SessionStart`, so until the user starts
a **new** session there is no run id, no registered agent, and nothing on the status line. This
is the single most common "it's still broken" report immediately after a successful sign-in, and
it is not a fault. Say it explicitly.

## Related

- `/mubit-memory:setup` — reads what is configured and confirms the instance answers. Run it
  after this to see `ready`.
- `node "${CLAUDE_PLUGIN_ROOT}/bin/auth.mjs" --status` — what is stored right now. Reports
  whether a key is present, never the key itself. Exits non-zero when nothing is configured.
- `node "${CLAUDE_PLUGIN_ROOT}/bin/auth.mjs" --logout` — removes the stored credentials.

If the user already has `apiKey` set through `/plugin` → Mubit Memory → configure, or exports
`MUBIT_API_KEY`, both of those win over what this skill writes. That is deliberate: a deliberate
per-install setting and a CI environment variable should not be silently overridden by a login.
Say so rather than authenticating again in a loop.
