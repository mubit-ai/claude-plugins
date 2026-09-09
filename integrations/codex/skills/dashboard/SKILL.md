---
name: dashboard
description: Open the local Mubit dashboard for lessons, recall cost and ingest health; use when the user wants to look, not ask.
---

**This skill never installs anything.** It starts one Node process from the plugin directory,
binds a random port on `127.0.0.1`, and opens a browser at it. No packages, no services, no
changes to the user's shell.

**Do not start it on your own initiative.** This is a command a person types when they want to
look at something; nothing in a conversation should decide by itself to open a web page. The
Claude Code copy of this skill enforces that with `disable-model-invocation: true`, a key Codex
does not read — so under this host the rule is this paragraph, and it is on you to keep it.

## Step 0 — resolve the binary

No environment variable carries this plugin's path under Codex. Codex lists each skill with the
absolute path of its `SKILL.md`; **this file** is at `<plugin-root>/skills/dashboard/SKILL.md`,
so the binary is two directories above it:

```
<plugin-root>/bin/dashboard.mjs
```

Resolve that to an absolute path from this file's own location and use it in every command
below. Do not write `${CLAUDE_PLUGIN_ROOT}`: Codex sets no plugin-root variable of any
spelling, so the shell expands it to nothing and `node /bin/dashboard.mjs` fails with ENOENT.

## Start it

```bash
node <plugin-root>/bin/dashboard.mjs
```

That prints a URL and tries to open it. The output is the whole report — pass it on verbatim
rather than paraphrasing it, because the URL carries the token and a retyped one will not work.

| Exit | Meaning | What to tell the user |
| --- | --- | --- |
| `0` | Running. The URL is in the output. | Give them the URL. If a browser did not open, they can paste it. |
| `1` | It did not come up inside the launch window. | Re-run it with `--foreground`, which keeps the server in this process and prints why it failed instead of detaching. |

Add `--no-open` when there is no browser to open — over SSH or in a container — and `--json`
when the result is going to be parsed rather than read.

## What it shows

Three tabs, joining two sources that have never been joined before:

- **Memory** — every lesson the instance holds, filterable instantly and searchable properly.
  Each entry shows its scope, and there is a filter for the ones **visible outside the run that
  wrote them**, which is the question nothing else in the plugin answers. One-click `Worked` /
  `Did not work` sends an outcome; deletion requires typing the lesson id.
- **Turns** — one row per prompt: which rung recall used, how many memories it injected, what
  they cost in tokens, and how many were repeats rendered as a pointer. This is the local half,
  read from `runs/<run_id>/turns/`.
- **Analytics** — the same numbers as a trend, plus spool depth, ingest counts and breaker state.

## Three things to say when asked about a number on it

1. **There is no per-prompt latency, and that is not an omission.** The recall timing on the
   status marker is last-write-wins: it describes the most recent prompt, not each one. No file
   records timing per prompt, so the page has no latency series rather than a misleading one.
2. **A blank in the `used` column means "not measurable", never "not used".** It is a term-echo
   proxy — did the reply carry vocabulary from the injected block that was not already in the
   prompt — and its false negatives dominate.
3. **The Analytics tab starts empty.** Turn files are pruned six hours after they are written,
   so the trend line is a rollup the dashboard accumulates while it is open. It cannot
   reconstruct anything from before its first launch.

## The data directory, which matters more here

Codex and Claude Code write to **different** directories — `mubit-memory-<marketplace>` for one,
its own for the other — and credentials live in the directory, not in the shell. The picker at
the top left lists every `mubit-memory*` directory it can find, so if the lessons load but the
Turns tab is empty, check that the picker is on the directory this host actually writes to. It
defaults to the configured one.

## Stopping it

```bash
node <plugin-root>/bin/dashboard.mjs --stop
node <plugin-root>/bin/dashboard.mjs --status
```

It also stops itself after roughly thirty minutes with no traffic, so a forgotten tab does not
leave a server running for a week.

## The security posture, if it comes up

- It listens on `127.0.0.1` and an ephemeral port. Nothing on the network can reach it.
- Every request needs a bearer token minted for that launch. The URL carries it once, for the
  browser's first navigation; the page then drops it from the address bar.
- The API key never leaves the server process. Every call to the instance is proxied, and every
  response is checked for the key before it is written.
- Prompt text is scrubbed before it reaches the browser, on a policy that does not consult
  `redact`. Turning redaction off is consent to send your own secrets to your own instance; it
  is not consent to render them into a web page.
- Reading does not disturb what is read: spool depth is counted without draining the spool, and
  breaker state is read without spending its probe. Every call the page makes to the instance is
  marked so it cannot open the circuit breaker the hooks depend on.

## Related

- `doctor` — the diagnostic when something is wrong, and cheaper than this.
- `auth` — what to run if the dashboard reports that the key was rejected.
