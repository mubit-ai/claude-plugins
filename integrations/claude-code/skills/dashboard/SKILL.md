---
name: dashboard
description: Open the local Mubit dashboard for lessons, recall cost and ingest health; use when the user wants to look, not ask.
disable-model-invocation: true
allowed-tools: ["Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/dashboard.mjs:*)"]
---

**This skill never installs anything.** It starts one Node process from the plugin directory,
binds a random port on `127.0.0.1`, and opens a browser at it. No packages, no services, no
changes to the user's shell.

`disable-model-invocation: true` is deliberate: this is a command a person types when they want
to look at something. Nothing in a conversation should decide, on its own, to open a web page.

## Start it

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/dashboard.mjs"
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

- **Memory** — every lesson the instance holds, across **every run** by default, filterable
  instantly and searchable properly. Each lesson shows its scope, and there is a filter for the
  ones **visible outside the run that wrote them**, which is the question nothing else in the
  plugin answers. One-click `Worked` / `Did not work` sends an outcome; deletion requires typing
  the lesson id. Activity mode shows the raw feed, which is fetched compactly and carries no
  scope — the scope and project filters switch off there and say so.
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

## Stopping it

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/dashboard.mjs" --stop
node "${CLAUDE_PLUGIN_ROOT}/bin/dashboard.mjs" --status
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

- `/mubit-memory:doctor` — the diagnostic when something is wrong, and cheaper than this.
- `/mubit-memory:auth` — what to run if the dashboard reports that the key was rejected.
