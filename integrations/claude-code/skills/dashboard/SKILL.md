---
name: dashboard
description: Open the local Mubit dashboard — turns, what was injected into each, what it earned, and every lesson's record; use when the user wants to look, not ask.
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

Everything on the page is anchored on one **directory**. The context block in the sidebar
lists every project directory the data directory has seen, each with its runs under it — the
current one, the one before `/clear`, how many subagent runs — because a directory's memory
is spread over several run ids (`cc-<slug>-<hash>`, `-c<N>` after each `/clear`, `-sub-<id>`
per subagent) and the page folds them back together. The header names the directory, the run
every write on the page uses, and how many sessions the directory has had.

Five pages, and one chain running through them: a session has turns; a turn was given
lessons; the reply earned them an outcome; the turn may have saved lessons of its own; and
every lesson carries how often it was injected, worked and failed.

- **Overview** — five tiles over a window of 7, 14 or 30 days: turns, lessons injected,
  worked / failed, lessons saved, recall cost per prompt — each with a delta against the
  previous equal window, or *no earlier window* when the history is younger than two. One
  chart with three tabs: turns per day by outcome (worked, neutral, failed, none injected — a
  verdict overrides the automatic signal), lessons injected per day, recall cost per prompt.
  Under it, the most reinforced and the most failed lessons, and a fold-out with what the run
  writes at and reads from in words.
- **Turns** — one row per prompt across the directory's runs, grouped under a session header
  when there is more than one session: time, prompt, session, agents (`main`, or
  `main + 3 sub`), how many lessons were injected, what they cost, whether the reply used
  them, and the outcome as a pill. Sort by any numeric column, search the prompts, filter by
  session or outcome or *has injected*, choose columns. Opening a row shows the prompt, the
  meta, *Injected (N)* with each lesson's content, scope and its own worked / failed counts,
  the **Worked / Did not work** buttons, *Saved in this turn (N)*, the subagents that ran
  under the prompt, and the used-signal note. Rows come from the turn files for six hours and
  from the per-turn ledger (`runs/<run_id>/ledger.jsonl`, written by the Stop hook) for thirty
  days, so the table outlives the pruning.
- **Lessons** — one row per lesson: id, content, scope, origin, injected (turns in this
  directory that were given it, from the ledger), worked, failed, confidence, last outcome,
  saved. Three views over one load — *Written here*, *+ shared* (plus session and global
  lessons other directories saved, which reach here at recall), *Everything* — and scope,
  project and origin filters over it; an instant text filter, and *Search instance* to ask
  the instance properly. The row menu carries **Worked**, **Did not work** and **Delete**;
  the drawer carries the provenance lines (saved when and by whom, directory and run,
  session, prompt with a *Show turn* link, reach), the counters, the rationale and
  conditions, and deletion by typing the id.
- **Feed** — everything stored on the instance, newest first under day headers. A row
  resolves by id, so a trace says which hook and which tool.
- **Health** — spool depth, breaker, ingest jobs and cold start for the concrete run, and the
  marker's last recall and reflection.

Two verdicts exist and they weigh differently. The per-turn **Worked / Did not work** credits
every lesson injected into that turn at full weight (`±1.0`), because a person judged the
turn; the automatic signal the Stop hook posts is deliberately weak (`+0.2` / `−0.3`),
because a turn completing is not proof the memory helped. On the page the verdict wins over
the signal wherever the two are shown together.

## Four things to say when asked about a number on it

1. **History starts at this build.** The ledger accrues one row per prompt from the first
   turn that ends after the plugin was built with it, and holds thirty days; the Overview
   says where its history starts. Nothing from before that first row can be reconstructed —
   the turn files it would have come from are pruned after six hours.
2. **A blank worked or failed count means "nothing stamped", not zero.** The instance writes
   the counters on a lesson only once an outcome has named it. Blank is "never measured";
   `0` is "measured, and never".
3. **A blank in the `used` column means "not measurable", never "not used".** It is a term-echo
   proxy — did the reply carry vocabulary from the injected block that was not already in the
   prompt — and its false negatives dominate.
4. **There is no per-prompt latency, and that is not an omission.** The recall timing on the
   status marker is last-write-wins: it describes the most recent prompt, not each one. No file
   records timing per prompt, so the page has no latency series rather than a misleading one.

Two limits it states rather than papers over. A `mubit_learned` call from a subagent is
indistinguishable from the main agent's — one MCP process — so a lesson says "agent" and only a
subagent's own recall record or a SubagentStop note says "subagent". A reflection lesson gets
a session *by time* but never a prompt, and a *by time* attribution needs the turn on the page.

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
  browser's first navigation; the page then drops it from the address bar, and a session cookie
  set by that first navigation — HttpOnly, same-site only, gone when the tab closes — is what
  lets a reload keep the page.
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
