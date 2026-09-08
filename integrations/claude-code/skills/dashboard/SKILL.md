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

Everything on the page is anchored on one **directory**. The rail lists every project
directory the data directory has seen, each with its runs under it — the current one, the one
before `/clear`, how many subagent runs — because a directory's memory is spread over several
run ids (`cc-<slug>-<hash>`, `-c<N>` after each `/clear`, `-sub-<id>` per subagent) and the
page folds them back together.

- **Selected directory** — the strip across the top says the full directory, the run every
  write on the page names (marked when it is the one the dashboard was launched in), every
  host session in the directory with its agent and when it was last seen, and what the run
  writes at and reads from as one sentence each: the lesson-scope cap and the cross-run recall
  setting as words rather than as `session` and `auto`.
- **Memory** — three views over one load. *Written here* (the default) is the lessons this
  directory's runs saved; *+ shared* adds the session and global lessons other directories
  saved, which reach here at recall; *Everything* is every lesson on the instance. Switching
  directory or view is instant, and the counts on the buttons are the counts of the list.
  Every row says who wrote it (agent, reflection, auto-reflection, hook capture), which
  session and which prompt — `recorded` when the write was stamped with them, dashed *by time*
  when the page inferred them from the turn window — and `from <directory>` when it came from
  elsewhere. The detail pane is one provenance block: saved when and by whom, directory and
  run, session, prompt with a *Show turn* link, reach. *Everything stored* is the raw feed;
  selecting a row resolves it by id, so a trace says which hook and which tool. The scope and
  project facets switch off there and say why. One-click `Worked` / `Did not work` sends an
  outcome; deletion requires typing the lesson id.
- **Turns** — one row per prompt across the directory's runs, grouped under a session header
  when there is more than one session: time, prompt, agents (`main`, or `main + 3 sub`), how
  many memories were injected, what they cost in tokens, whether the reply used them, and the
  outcome. The detail resolves every injected memory to its content with *Open in Memory*,
  lists the subagents that ran under the prompt and what each was given, and the lessons saved
  during the turn. Read from `runs/<run_id>/turns/` and `runs/<run_id>/subagents/`.
- **Analytics** — the same numbers as a trend across the directory's runs, plus spool depth,
  ingest counts and breaker state for the concrete run.

Three limits it states rather than papers over. A `mubit_learned` call from a subagent is
indistinguishable from the main agent's — one MCP process — so a lesson says "agent" and only a
subagent's own recall record or a SubagentStop note says "subagent". A reflection lesson gets
a session by time but never a prompt. Turn files are pruned after six hours, so a *by time*
link exists only for a recent lesson; a write stamped with its session and prompt keeps them.

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
