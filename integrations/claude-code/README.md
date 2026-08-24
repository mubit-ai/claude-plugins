# Mubit Memory for Claude Code

`mubit-memory` gives Claude Code persistent, typed memory backed by a [Mubit](https://mubit.ai)
instance. It captures your tool activity involuntarily — you never have to remember to save
anything — recalls relevant lessons before every prompt at zero LLM cost, attributes the
outcome of each turn back to the memories that were injected so retrieval improves with use,
and scrubs secrets out of everything before it leaves the machine.

---

## Read this first

**After `/plugin install`, run `/reload-plugins` — but `/reload-plugins` does not fire the
`SessionStart` hook.** Until you start a *new* Claude Code session, the plugin has never run:
there is no run id, no registered agent, and no status marker on disk. The status line prints
nothing, `/mubit-memory:doctor` finds no local state, and the whole thing looks broken while
it is in fact fine. Start a new session, then look again.

---

## Install

```
/plugin marketplace add mubit-ai/claude-plugins
/plugin install mubit-memory@mubit
/reload-plugins
```

Then **start a new session** (see above).

There is no build step and no `npm install`. The plugin ships its bundles committed
(`hooks/dist/`, `mcp/dist/`, `bin/statusline.mjs`); Claude Code fetches the directory and runs
it. Node >= 20 is the only runtime requirement, and the plugin has zero runtime dependencies.

---

## Connect it to Mubit

Mubit Memory needs a Mubit instance and an API key for it. The short way:

```
/mubit-memory:auth
```

That opens the [Mubit console](https://console.mubit.ai) in your browser, signs you in or signs
you up, and brings a key back over a loopback callback on `127.0.0.1`. The key is checked against
your instance before it is stored, so a successful run means it actually works — not that it
looked right.

It is stored at `${CLAUDE_PLUGIN_DATA}/credentials.json`, owner-only (mode `600`). That path
survives plugin updates, so this is a once-per-machine step.

**No browser?** Over SSH or in a container, issue a key in the console and hand it over in the
environment for one command:

```bash
MUBIT_AUTH_KEY='mbt_…' node "${CLAUDE_PLUGIN_ROOT}/bin/auth.mjs" --paste
```

The key goes in the environment, not in a `--key` flag: arguments are readable by every user on
the machine via `ps`, and a process's environment is not.

**The manual route**, which still takes precedence over anything `/mubit-memory:auth` writes:
set two values in the plugin's settings (`/plugin` → Mubit Memory → configure).

| Setting | Value |
| --- | --- |
| `endpoint` | your instance URL, e.g. `https://eu.mubit.ai` |
| `apiKey` | a key of the form `mbt_...` |

There the key is marked sensitive, so it goes to your OS keychain rather than to a file. That is
the better home for a long-lived install; `/mubit-memory:auth` is the faster one. Full precedence
is in [Configuration](#configuration).

Either way, confirm with `/mubit-memory:setup`, which calls `mubit_status` and echoes the
endpoint and the run id back. A rejected key reports as `auth_failed`, which is a key problem —
missing, wrong, or revoked — not a network one.

If the endpoint is unset the plugin has nothing to talk to: capture spools locally, recall
returns nothing, and the status line says so — `○ not configured`, the `unconfigured` state,
which names `/mubit-memory:auth` as the fix rather than blaming a server. Nothing is lost and
nothing is sent.

The first time a given endpoint is seen, the status line shows `◍ warming` rather than a
failure glyph while the instance comes up — see [Connection states](#connection-states).

---

## What you get

### Ten hook registrations

| Event | Runs | Timeout | What it does |
| --- | --- | --- | --- |
| `SessionStart` (`startup\|resume\|clear\|compact`) | `session-start.mjs` | 5 s | Derives the run id, checks health, registers the agent (heartbeats on `resume`), pulls up to 5 global lessons, injects a short steer block telling the model memory is active, that it need not open a turn by searching, and which tool to reach for when the injected memory falls short. On a `compact` source it also re-anchors the session to the checkpoint saved by `PreCompact`. |
| `CwdChanged` | `cwd-changed.mjs` | 5 s | Zero network. The run id is derived from a directory, so a `cd` into another repo mid-session has to move it — and drain the run being left, which nothing else in the plugin would ever revisit. A `cd` within one repo costs nothing: the id resolves through the git toplevel. |
| `UserPromptSubmit` | `prompt-recall.mjs` | 3 s | Queries Mubit and injects recalled memory as `additionalContext`. Blocking, with a 1500 ms internal budget. Injects nothing at all when the result is empty. |
| `UserPromptSubmit` | `stage-prompt.mjs` | 3 s | Zero network. Stages the prompt so the `Stop` capture has both halves of the turn, and triggers the detached drain when the spool is full or stale. |
| `PreToolUse` (`Bash`, and only `rm *` / `git push *`) | `pre-tool.mjs` | 3 s | **Off by default** (`preToolWarnings`). Zero network. Reads the `rule`-typed memories this run already recalled and, when one mentions the command about to run, shows it to the model as `additionalContext`. It warns and nothing else: it never allows, denies, asks, defers or rewrites a tool call, and it exits 0 on every path — including its error paths — because the host reads exit code 2 as "block this call". A memory-informed reminder, not a security boundary. |
| `PostToolUse` (every tool) | `capture.mjs` | 3 s | Redacts and spools the tool call, whatever the tool was — built-in or any MCP server's. Zero network. A short skip list drops the handful that carry no memory (mode switches, list-only queries), and Mubit's own tool calls are suppressed. |
| `PostToolUseFailure` | `capture.mjs --failure` | 3 s | Captures the failure — these produce the most useful lessons. |
| `Stop` | `capture.mjs --stop` | 5 s | Writes the `Q: … / A: …` turn, spawns the drain, and attributes the turn's outcome to the memories that were recalled for it. |
| `SubagentStop` | `capture.mjs --subagent` | 3 s | Same, under a distinct subagent identity. |
| `PreCompact` | `checkpoint.mjs --pre` | 10 s | The one blocking network call in the plugin: snapshots the last 200 KB of transcript before the host throws it away. |
| `PostCompact` | `checkpoint.mjs --post` | 5 s | Zero network. Records that the compaction happened; injects nothing, because Claude Code accepts no injected context on this event. The re-anchor arrives instead from `SessionStart`, which also fires on a `compact` source. |
| `SessionEnd` | `session-end.mjs` | 8 s | Drains inline, flushes pending outcomes, then reflects. |

(Thirteen events; `UserPromptSubmit` registers two commands, and `PreToolUse` registers two —
one per `if` pattern.)

Every hook exits 0, always. A memory layer has no business breaking a prompt — a dead server,
an unwritable data dir, or a corrupt state file costs you a memory, never a turn.

### Seven skills and one subagent

| Command | Use it for |
| --- | --- |
| `/mubit-memory:auth` | Sign in to Mubit and store a key for this machine. Never installs anything. |
| `/mubit-memory:setup` | First run: confirm the endpoint and key are set and the instance answers. Never installs anything. |
| `/mubit-memory:doctor` | Diagnose connectivity, memory health, and stuck ingest jobs, cheapest check first. |
| `/mubit-memory:recall` | Search memory for detail beyond what was already injected this turn. |
| `/mubit-memory:remember` | Save a durable lesson, rule, or standing preference. |
| `/mubit-memory:reflect` | Extract lessons from this session mid-flight, rather than waiting for `SessionEnd`. |
| `/mubit-memory:forget` | Delete a lesson, or down-weight one that is merely wrong. |
| `@mubit-memory:mubit-recall` | Subagent: multi-angle memory search in an isolated context, returns a synthesis instead of raw evidence. |

### Ten MCP tools

The bundled MCP server carries 21 tools and registers ten of them by default — the other
eleven cost you nothing until you ask for them:

```
mubit_learned   mubit_recall   mubit_outcome   mubit_reflect   mubit_lessons
mubit_diagnose  mubit_archive  mubit_dereference  mubit_forget  mubit_status
```

The other eleven are excluded because a hook already does the job better
(`mubit_remember`, `mubit_context`, `mubit_checkpoint`, `mubit_register_agent`,
`mubit_list_agents`) or because they have no Claude Code surface (the multi-agent
orchestration group). Nothing is removed — restore any of them by name with `mcpTools`.

### A status line

```
● mubit: cc-my-project-9f2a11c4 · hosted · recall 6/1.2k tok · saved 12t/1q · lessons 3g
```

It reads two local JSON files and never touches the network, so a dead server can never freeze
your terminal. Groups are omitted while they are still zero, and an open circuit breaker adds
`· paused 94s` so you can tell "it recovers in 94 seconds" from "this thing is dead".

> **Known limitation.** A plugin's shipped `settings.json` can register `agent` and
> `subagentStatusLine`, but not `statusLine`, so the plugin's own registration is inert. To get
> the widget, add it to your own `~/.claude/settings.json`, pointing at the installed plugin's
> `bin/statusline.mjs`. Marketplace installs are copied into
> `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, so confirm the exact path on
> your machine and expect it to change when you upgrade:
>
> ```json
> {
>   "statusLine": {
>     "type": "command",
>     "command": "node",
>     "args": ["/Users/you/.claude/plugins/cache/mubit/mubit-memory/0.9.0/bin/statusline.mjs"],
>     "padding": 0
>   }
> }
> ```
>
> After two consecutive sessions in which the status line was never invoked, `SessionStart`
> says so once rather than leaving you to wonder.

---

## What leaves your machine, and what does not

This is the part worth reading closely.

Captured tool calls, their output, your prompts and Claude's replies are sent to **your** Mubit
endpoint, and nowhere else. Before any of it is written even to the local spool, it goes
through three stages, in this order.

### Stage 1 — pattern scrub

Every match is replaced with `[REDACTED:<kind>]`, naming which rule fired:

```
DATABASE_PASSWORD=hunter2                 ->  [REDACTED:assignment]
export MUBIT_API_KEY=mbt_prod_9f2a...     ->  export [REDACTED:assignment]
sk-proj-4f9a...                           ->  [REDACTED:openai-key]
ghp_16C7e42F292c6912E7710c838347Ae178B4a  ->  [REDACTED:github-token]
AKIAIOSFODNN7EXAMPLE                      ->  [REDACTED:aws-access-key]
eyJhbGciOi........                        ->  [REDACTED:jwt]
Authorization: Bearer abc123def456...     ->  Authorization: [REDACTED:bearer]
-----BEGIN RSA PRIVATE KEY----- ...       ->  [REDACTED:pem]
```

The keyword list for `assignment` (`secret`, `token`, `password`, `credential`, `assertion`,
`signature`, `apikey`, `api_key`) matches the terms Mubit itself treats as secret, so client
and server agree on what counts as one. A final `high-entropy` rule catches
anything else: a run of 32+ base64/hex characters with Shannon entropy >= 4.0 becomes
`[REDACTED:high-entropy]`. Git SHAs cannot trip it — entropy over a 16-symbol alphabet is
bounded by exactly 4.0 — and `idempotency-key` values are exempted by name so you can still
tell whether a batch was sent twice.

### Stage 2 — path denylist

Captures whose subject path matches the denylist are **dropped entirely, not scrubbed.** A
redacted `.env` is still a map of which secrets the project holds, which is why the weaker
guarantee was not good enough. The built-in floor:

```
.env  .env.*
*.pem  *.key  *.p12  *.pfx  *.kdbx
id_rsa*  id_ed25519*
secrets/**  .ssh/**  .aws/**  .gnupg/**
**/credentials  **/.netrc
```

**Plus everything git ignores.** You already declared those paths not-for-sharing; honouring
that costs you no new configuration. Disable with `MUBIT_CC_RESPECT_GITIGNORE=0`.
`MUBIT_CC_CAPTURE_DENY` *appends* your own globs to this floor — it never replaces it.

### Stage 3 — byte caps

4 KiB per tool-input field (each field, not shared across the input) and 8 KiB per tool output,
truncated on a UTF-8 character boundary. **The scrub runs before the cap**, so truncation can
never slice a secret in half and leave a recognizable prefix behind.

### The rest of it

- Setting `redact: false` / `MUBIT_CC_REDACT=0` disables **stage 1 only**. The path denylist
  and the byte caps always run — they have no false-positive cost, so there is no reason to let
  the escape hatch reach them.
- Every line written to the local log (`logs/mubit-cc.log`, ring-rotated at 1 MiB, two files)
  is scrubbed too, message and fields, recursively. It is the artefact you paste into an issue.
- The plugin suppresses its own traffic: its MCP tool calls, shell commands mentioning the
  Mubit endpoint or `MUBIT_*`, and reads of anything inside its own data directory are never
  captured. Other MCP servers' output is captured — that cross-tool memory is the point.
- The status line performs no network I/O at all, ever.
- Local state (spool, markers, session map, breaker, logs) lives under
  `${MUBIT_CC_DATA_DIR}` → `${CLAUDE_PLUGIN_DATA}` → `~/.claude/plugins/data/mubit-memory`, and
  is pruned on a TTL: turns after 6 h, status markers after 12 h, spool and job records after
  24 h, quarantined payloads and run directories after 7 days, session maps after 30 days.

Nothing is sent to Mubit AI. The endpoint you configure is the only destination.

---

## Configuration

Precedence, highest first:

1. Plugin settings (`userConfig`, exported as `CLAUDE_PLUGIN_OPTION_*`)
2. `MUBIT_*` environment variables
3. `${CLAUDE_PLUGIN_DATA}/credentials.json` — what `/mubit-memory:auth` writes
4. `${CLAUDE_PROJECT_DIR}/.mubit-cc.json` — a JSON object keyed by the same option names
5. The built-in default

Signing in ranks below the environment so a CI job exporting `MUBIT_API_KEY` still wins, and
above the project file so a fresh login beats a stale committed one. The resolved config is
cached for 300 s at `${CLAUDE_PLUGIN_DATA}/config.json`; the API key is deliberately not part of
that cache, and writing credentials invalidates it immediately rather than after the TTL.

| Option | Default | Environment variable | Effect |
| --- | --- | --- | --- |
| `endpoint` | `""` | `MUBIT_ENDPOINT` | Your Mubit instance URL. Required — without it there is nothing to talk to. |
| `apiKey` | `""` | `MUBIT_API_KEY` | `mbt_...` key, sent as `Authorization: Bearer`. Set it with `/mubit-memory:auth`, or via plugin settings to keep it in the OS keychain. |
| `userId` | `""` | `MUBIT_CC_USER_ID` | Optional user/entity id for multi-user memory scoping. A **retrieval scope**, not a name: it is sent as `user_id`, which the server stamps on capture and then *enforces as a filter* on query. Recall does not send one, so anything captured under a `userId` is invisible to this plugin's own recall — set it only when you mean to partition memory. To label who did the work, use `actorId`. |
| `actorId` | `""` (detected) | `MUBIT_CC_ACTOR_ID` | Who captured memory is attributed to. Left blank it is detected — `git config github.user`, then the local-part of `git config user.email`, then `git config user.name`, then `$USER` — and cached for 30 days at `${CLAUDE_PLUGIN_DATA}/actor.json`. Detection runs only in the detached drainer, never on a hook that a prompt is waiting on, so the first capture in a brand-new data dir may go unattributed. The value rides in each item's metadata and, unlike `userId`, never narrows what recall can see. |
| `runStrategy` | `per-directory` | `MUBIT_CC_RUN_STRATEGY` | How a session maps to a Mubit run. See [Run strategies](#run-strategies). |
| `capture` | `true` | `MUBIT_CC_CAPTURE` | Capture tool activity. Off means the `PostToolUse`/`Stop` hooks spool nothing. |
| `recall` | `true` | `MUBIT_CC_RECALL` | Inject recalled memory before each prompt. Off means `UserPromptSubmit` dials nothing. |
| `redact` | `true` | `MUBIT_CC_REDACT` | Stage-1 pattern scrub. Turning it off is not recommended; stages 2 and 3 run regardless. |
| `recallTokenBudget` | `1500` | `MUBIT_CC_RECALL_TOKENS` | Maximum tokens of recalled context injected per prompt. Sections are trimmed to fit, preferring non-stale entries. |
| `subagentRecallTokenBudget` | `600` | `MUBIT_CC_SUBAGENT_RECALL_TOKENS` | Maximum tokens of recalled context injected into a **subagent** when it starts. `UserPromptSubmit` does not fire for a subagent, so without the `SubagentStart` hook a subagent gets no memory at all; with it, this is the ceiling. Kept below `recallTokenBudget` because a subagent's window is smaller and its task narrower, and because this is paid once per spawn — a fan-out of ten pays it ten times. Set to `0` to fall back to `recallTokenBudget`. |
| `recallMaxPerSection` | `0` | `MUBIT_CC_RECALL_MAX_PER_SECTION` | Maximum items rendered per section of the injected block. `0` means no cap — the token budget and the server's own limit are what bound it. |
| `recallRepeatMode` | `pointer` | `MUBIT_CC_RECALL_REPEAT_MODE` | What happens to a memory this run has already injected. `pointer` repeats it as its reference id plus its first clause — roughly 20 tokens against 200 — and keeps the id attributable, so `Stop` still reinforces it. `full` re-sends the whole entry on every prompt, which is what releases before 0.10 did. Recall injection is the plugin's largest recurring context cost: up to 1500 tokens on *every* prompt, against 356 tokens *once* for the whole MCP tool surface. Compaction resets the set, because after it the model has not seen any of it. |
| `recallAssemble` | `client` | `MUBIT_CC_RECALL_ASSEMBLE` | `client` assembles the context block locally for **0 LLM calls**. `server` uses `/v2/control/context`, which costs **2 LLM calls per prompt** and replaces the free path rather than adding to it. It also silently gives up `recallRankBy`: `/v2/control/context` has no ranking field of any kind, so on this path every recall fuses at the server's default weights and a handoff question goes back to being answered by similarity. |
| `recallFallback` | `none` | `MUBIT_CC_RECALL_FALLBACK` | What recall does when the instance has direct-access recall disabled. `none` returns nothing, for **0 LLM calls**. `agent_routed` pays **1 LLM call per prompt** to get recall anyway — typically several seconds, against a recall budget of 1500 ms, so most prompts spend the call and still inject nothing. See [When recall returns nothing](#when-recall-returns-nothing). |
| `recallRankBy` | `auto` | `MUBIT_CC_RECALL_RANK_BY` | How the server weights semantic, lexical and recency scores for a recall query. Its default weighting barely counts recency, which is why "where were we?" has always answered with the most *similar* memory rather than the most recent one — there is real event time to rank on, it was simply never asked for. `auto` decides per prompt: a temporal or handoff question ("what changed", "catch me up", "pick up where we left off", "still failing") is sent as `freshness`, which makes recency dominant, and everything else as `relevance`. Pin `relevance` to turn the rule off, `freshness` to rank every prompt by recency, or `balanced` for the middle, which the rule never chooses on its own. The exact weights belong to your instance and are operator-tunable; a query with `explain: true` reports the ones actually used. It costs **0 extra LLM calls and 0 extra round trips** — it is one field on a request that is already being sent. **`recallAssemble: server` ignores it entirely**: `/v2/control/context` has no ranking field of any kind, so rung 3 always fuses at the default weighting, silently. |
| `recallAsync` | `false` | `MUBIT_CC_RECALL_ASYNC` | Never make a prompt wait on recall. On, `UserPromptSubmit` injects the block that a **detached refresh retrieved just after the previous prompt** and returns without dialling — so the hook's wall clock is a file read, however slow the endpoint is, and `MUBIT_CC_RECALL_BUDGET_MS` stops being something you have to discover and tune. It costs one turn of staleness (the block says so, in the block) and the first prompt of a session gets no recalled memory — `SessionStart`'s standing lessons still land, so the session is not memoryless. Attribution is unaffected: the ids are staged against the turn that received the block. Off by default. |
| `reflectOnEnd` | `true` | `MUBIT_CC_REFLECT_ON_END` | Reflect at `SessionEnd`. This is the only path that promotes a lesson beyond its own run, so turning it off to save a few seconds trades away cross-session memory entirely. See below. |
| `sessionEndDetach` | `true` | `MUBIT_CC_SESSION_END_DETACH` | Let the end-of-session drain and reflection finish in a detached process. The host cancels the `SessionEnd` hook about a second into a teardown — under `--print` it always does — and anything still running inside the hook dies with it, including the reflect above. On, the hook stamps the marker `detached`, hands the work over and returns in milliseconds; the child reports a terminal `reflect.status` when it is done, usually a few seconds after the CLI has exited. Turn it off only where background processes are forbidden — the work then runs inline, where a teardown can cut it short. |
| `outcomeMode` | `implicit` | `MUBIT_CC_OUTCOME_MODE` | `implicit`: a turn whose reply carried the recalled memory's own vocabulary is attributed to those memories; a turn that carried none of it is recorded as `neutral` against the run and attributed to no entry, so an injection nobody used is counted rather than being invisible. `explicit`: only the model's own `mubit_outcome` calls count. `off`: no attribution, and no measurement of it either. |
| `statusLine` | `true` | `MUBIT_CC_STATUSLINE` | Render the status line. When false it prints an empty line and exits 0 rather than erroring per frame. |
| `preToolWarnings` | `false` | `MUBIT_CC_PRE_TOOL_WARNINGS` | Show the model a matching stored `rule` just before an `rm` or `git push` runs. Warnings only — it never blocks, rewrites or asks about a tool call, and the filter that decides when it runs at all is best-effort, so treat it as a reminder and use Claude Code's permission system for anything that has to hold. Off by default: this is the one setting that can put text in front of a tool call. |
| `mcpTools` | `""` (the curated ten) | `MUBIT_MCP_TOOLS` | Comma-separated allowlist. A list you supply is used verbatim, not unioned with the default — that is how you ask for only `mubit_recall`. |
| `mcpLessonScope` | `run` | `MUBIT_MCP_LESSON_SCOPE` | The widest scope a lesson written by an MCP tool may claim: `run`, `session` or `global`. Anything above `run` is read back by unrelated runs, so the default keeps an agent-written lesson in the run that wrote it — with `runStrategy: per-directory`, that is the project it was written in. Raise it if you want agent-written rules to follow you between projects; reflection promotes a lesson beyond its run either way. |

### Environment-only settings

These have no plugin-settings equivalent. They also read from `.mubit-cc.json` under the
camelCase name in parentheses.

| Variable | Default | Effect |
| --- | --- | --- |
| `MUBIT_CC_DATA_DIR` | `${CLAUDE_PLUGIN_DATA}` | Where local state lives. |
| `MUBIT_CC_RUN_ID` (`runId`) | `""` | The pinned run id for `runStrategy: static`. Required there; unset is a config error, never a silent fallback. |
| `MUBIT_CC_RECALL_BUDGET_MS` (`recallBudgetMs`) | `1500` | Wall-clock budget for pre-prompt recall. |
| `MUBIT_CC_RECALL_SECTIONS` (`recallSections`) | `mental_models,active_rules,lessons,facts,working_memory,traces` | Which context sections to request. |
| `MUBIT_CC_POLICY_TTL_MS` (`policyTtlMs`) | `86400000` (24 h) | How long a cached `direct_bypass` policy denial is honoured before retrying. Set it to `1` to re-probe on the next prompt, after an operator has enabled direct search. |
| `MUBIT_CC_CAPTURE_DENY` (`denyGlobs`) | `""` | Extra denylist globs, appended to the built-in floor. |
| `MUBIT_CC_RESPECT_GITIGNORE` (`respectGitignore`) | `1` | Drop captures for git-ignored paths. |
| `MUBIT_CC_MAX_PARAM_BYTES` (`maxParamBytes`) | `4096` | Byte cap per tool-input field. |
| `MUBIT_CC_MAX_OUTPUT_BYTES` (`maxOutputBytes`) | `8192` | Byte cap per tool output. |
| `MUBIT_CC_BATCH_MAX_ITEMS` (`batchMaxItems`) | `32` | Spool size that triggers a drain. |
| `MUBIT_CC_BATCH_MAX_AGE_MS` (`batchMaxAgeMs`) | `30000` | Spool age that triggers a drain. |
| `MUBIT_CC_TIMEOUT_MS` (`timeoutMs`) | `4000` | Per-request HTTP timeout. |
| `MUBIT_CC_COLDSTART_GRACE_MS` (`coldStartGraceMs`) | `20000` | How long after an endpoint is first seen failures display as `◍ warming`. Armed once per endpoint, not per session. |
| `MUBIT_CC_BREAKER_THRESHOLD` (`breakerThreshold`) | `5` | Failures within the window that open the circuit breaker. |
| `MUBIT_CC_BREAKER_WINDOW_MS` (`breakerWindowMs`) | `300000` (5 min) | The rolling failure window. |
| `MUBIT_CC_BREAKER_COOLDOWN_MS` (`breakerCooldownMs`) | `120000` (2 min) | Cooldown before a single half-open probe is allowed. |
| `MUBIT_CC_LOG_LEVEL` (`logLevel`) | `warn` | `error`, `warn`, `info`, or `debug`. |
| `MUBIT_CC_ENV_TAGS` (`envTags`) | `""` | Extra `TYPE:NAME` tags on every ingested item, appended to the derived `tool:claude-code`, `repo:`, `branch:`, `lang:` set (8 total). |

### When recall returns nothing

Recall's default path is the **direct bypass**: one request, no LLM calls, tens to a couple of
hundred milliseconds server-side. That path is gated by your instance's direct-access policy.
When an operator has it switched off, the request comes back `403`, and the plugin has a
choice: return nothing, or pay a router LLM call to get an answer another way.

It returns nothing, and says so. The alternative costs a language-model call in front of every
prompt you type — measured at a ~5 s median with a tail past 11 s, against a recall budget of
1500 ms inside a 3 s hook timeout. Most of those prompts spend the call and inject nothing
anyway, so the default trades away recall you were mostly not receiving for latency you were
always paying. `MUBIT_CC_RECALL_FALLBACK=agent_routed` opts back in.

**The real fix is on the instance, not here.** Ask whoever operates it to enable direct-access
recall; the plugin needs no change, and rung 1 starts answering. The refusal is cached for 24 h
so the plugin does not re-probe on every prompt, so after the dial is flipped either wait it
out or set `MUBIT_CC_POLICY_TTL_MS=1` once to pick it up on the next prompt.

You can tell this is what is happening from the status line — `recall dry N` after three
consecutive empty recalls — or from `/mubit-memory:doctor`, which reads `recall.empty_reason`
and names `policy_denied` specifically. Note that the connection state stays `ready`
throughout, because nothing is wrong with the connection.

### When recall is slow rather than empty

A different symptom, with a different fix. If the status line shows `◌ not_responding` and
`recall.empty_reason` is blank rather than `policy_denied`, the instance is answering — just
not inside the budget. The call is abandoned after it has already been paid for.

**This is not only a self-hosting problem.** Measured 2026-08-24, a rung-1 query against
*hosted* Mubit took 2.0-2.6 s, against a `MUBIT_CC_RECALL_BUDGET_MS` of 1500. Self-hosted
instances land in a similar range. On either, an ordinary session recalls nothing on every
prompt and reports it as zeros.

**The tell is the number, not the zero.** `mubit-inspect` printing `ms: 1507` — a figure
sitting on the budget — is a timeout. A genuinely empty result returns fast and carries an
`empty_reason`. `status/health.json` will still read `ok: true, state: ready`, because
`/v2/core/health` is fast and the query path is not, so a healthy connection glyph does not
clear this.

**Raising the budget mostly cannot fix it.** The hook's hard stop is
`min(recallBudgetMs + 400, 2800)` — capped at 2800 ms, because `UserPromptSubmit` has a 3 s
host timeout. Past roughly 2400 the setting buys nothing, and every millisecond you do buy is
a longer wait before every message you send.

`MUBIT_CC_RECALL_ASYNC=1` removes the trade instead of tuning it. With it on, the hook injects
the block a **detached refresh** retrieved just after your previous prompt and returns without
dialling anything, so what it costs is one file read no matter how slow the endpoint is. The
refresh is not bound by the prompt budget — nothing is waiting on it.

What you give up:

- **One turn of staleness.** The block was retrieved against your previous message. It says so,
  in the block, so the model reads it as background rather than as an answer.
- **The first prompt of a session recalls nothing.** `SessionStart`'s standing lessons still
  land, so a fresh session is not memoryless.

What you keep: attribution. The recalled ids are staged against the turn that *received* the
block, so `Stop` reinforces exactly the memories the model actually had.

### Turning off `reflectOnEnd`

Mubit extracts lessons on its own as it ingests, but those keep the scope they were extracted
at — typically `run` — and a `run`-scoped lesson is invisible to your next session.

`POST /v2/control/reflect`, which `SessionEnd` issues and which `reflectOnEnd` controls, is the
only thing in the system that can widen a lesson's scope. Turn it off and your store still
fills up — it just never produces anything a future session can see. It is not a latency knob.

(Reflecting is necessary, not sufficient. Rules are never scope-promoted, since they are
enforced as written, and anything else has to establish itself before it travels. Expect
widening over several sessions, not on the first reflect.)

### Run strategies

| Strategy | Run id | Derived from |
| --- | --- | --- |
| `per-directory` (default) | `cc-<slug>-<hash8>` | The git toplevel, falling back to `CLAUDE_PROJECT_DIR`. Two terminals in one repo share a run; two repos with the same directory name do not. |
| `git-branch` | `cc-<slug>-<branch>-<hash8>` | Root + branch, so a feature branch gets its own memory. A detached HEAD becomes `detached`. |
| `per-conversation` | `cc-<host_session_id>` | The host session id. |
| `static` | `MUBIT_CC_RUN_ID` verbatim | Pinned. Unset is a config error — the plugin refuses rather than guessing. |

`/clear` starts a new run by appending an incrementing `-c1`, `-c2` suffix to the derived id;
`resume`, `compact` and `fork` reuse the mapped run. A `static` pin is honoured on every source,
suffix included — a deliberately shared run id would be silently un-shared otherwise.

**`per-conversation` splits hook captures from MCP-tool writes.** The MCP server starts once
per session and is never handed a hook payload, so it has no `session_id` to key on; it falls
back to `per-directory` and says so on stderr. The result is that everything the capture hooks
record lands in one run while everything the MCP tools write — `/mubit-memory:remember`, any
`mubit_learned` call — lands in another, and a single recall never sees both. `per-directory`,
the default, has no such split: both writers derive the same id from the same directory, and
one query returns evidence from both. Use `per-conversation` only if you actually want each
conversation isolated and can live with that split.

---

## Connection states

The status line reports one of six typed states. They are typed separately because each one
has a different fix; `/mubit-memory:doctor` reports them by name for the same reason.

| State | Glyph | What it means | The fix |
| --- | --- | --- | --- |
| `ready` | `●` | A 2xx whose body is Mubit's own `OK`. The connection is fine. | If memory still looks wrong, the problem is content or scope, not connectivity. Run `/mubit-memory:doctor` and look at memory health and ingest jobs. |
| `unconfigured` | `○` | No endpoint is set, so nothing was dialed. Not a fault — the plugin is installed and waiting. | Run `/mubit-memory:auth`. Capture keeps buffering meanwhile and is sent once an endpoint exists. |
| `unreachable` | `✖` | `ECONNREFUSED` / `ENOTFOUND` / `EHOSTUNREACH` / `ECONNRESET`. Nothing is listening. | Check `endpoint` is correct and your instance is running. |
| `server_error` | `▲` | 5xx, a 2xx whose body is not what the route returns, or a 4xx that is a payload problem (400/413/422) or backpressure (429). Something is up and answering wrongly. | Retry, then check your instance's status in the console. If it persists, confirm `endpoint` points at Mubit and not at a proxy or SSO portal — those answer 200 too. |
| `auth_failed` | `✖` | 401 or 403. The key is missing, wrong, or revoked. | Set a valid `mbt_...` key via `/mubit-memory:auth`. This state is sticky and deliberately does not open the breaker, because it is the one error you can actually fix. |
| `not_responding` | `◌` | Three or more *consecutive* timeouts. | Usually load, not death — a cold cache, a laptop waking from sleep, a build hogging every core. Retry before concluding anything. |

Two displays that look like faults and are not:

- **`◍ warming`** — inside the cold-start grace window (20 s by default) the *first* time a
  given endpoint is seen, failures are recorded but shown as warming. An instance that is
  still starting is not broken, merely slow to answer. The window is armed once per endpoint,
  not once per session, so it cannot mask a fault that outlives it; point the plugin at a
  different instance and it arms again for that one. `auth_failed` is never masked this way,
  because a server still warming up does not answer 401 — and neither is `unconfigured`,
  because nothing is starting up when no endpoint is set.
- **`· paused 94s`** — after 5 failures in 300 s the breaker opened for a 120 s cooldown and
  requests are being skipped on purpose. Exactly one half-open probe dials when the cooldown
  ends; a success closes it. Nothing needs restarting.

A single timeout is never a verdict. One `AbortError` changes no reported state; only a streak
of three escalates, and only ever to `not_responding` — never to `unreachable` or
`server_error`.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Nothing at all after install: no status line, no injected memory | `/reload-plugins` does not fire `SessionStart`, so the plugin has never run | Start a new session |
| No skills, no hooks, no MCP server, and no error anywhere in the UI | `plugin.json` failed schema validation. A plugin that fails validation does not half-load — it does not load | `claude --plugin-dir <path> --debug-file /tmp/cc.log`, then `grep "invalid manifest" /tmp/cc.log` |
| `mcp-config-invalid: Missing environment variables` | `.mcp.json` references a `${VAR}` that is unset | Not something an install can hit; if you forked the plugin, declare no `env` block at all |
| Status line shows a glyph but no counters | No hook has written the marker for this run yet | Normal for the first few seconds of a session |
| Status line never appears at all | A plugin cannot register `statusLine`; the shipped entry is inert | Add it to your own `~/.claude/settings.json` — see [A status line](#a-status-line) |
| `/mcp` lists 21 tools instead of ten | You are on 0.9.1 or older, whose bundled MCP server predates the allowlist patch and registers everything | Upgrade. On an older version it is not cosmetic: every session pays for all 21 tool schemas |
| A saved lesson never becomes visible in another project | `mubit_learned` writes every entry as `success` at `run` scope; only the explicit reflect path widens it | Keep `reflectOnEnd` on and run `/mubit-memory:reflect` at meaningful checkpoints, or raise `mcpLessonScope` |
| A just-saved memory is not findable a second later | `mubit_learned` returns when the write is **queued**, not stored. Embedding and indexing happen after the call returns | Wait. Reflecting or searching immediately honestly returns nothing, and that is not a fault |
| Hook captures and `/mubit-memory:remember` writes land in different runs | `runStrategy: per-conversation` | Use `per-directory` |
| `Config error: MUBIT_CC_RUN_STRATEGY=static requires MUBIT_CC_RUN_ID` | `static` with no pin | Set `MUBIT_CC_RUN_ID`, or pick another strategy |
| Edits to the plugin have no effect | Marketplace installs are copied into `~/.claude/plugins/cache` | Iterate with `claude --plugin-dir <path>` |
| Something you did not want captured got captured | Redaction is per-value, not per-concept | Add a glob to `MUBIT_CC_CAPTURE_DENY`, and remove the entry with `/mubit-memory:forget` |

Local state and logs for a run:

```bash
ls ~/.claude/plugins/data/mubit-memory*/runs/*/     # note the *: --plugin-dir writes to a -inline dir
cat ~/.claude/plugins/data/mubit-memory*/status/*.json
tail ~/.claude/plugins/data/mubit-memory*/logs/mubit-cc.log
```

Raise the detail with `MUBIT_CC_LOG_LEVEL=debug`. The log is scrubbed on the way out, so it is
safe to attach to an issue.

---

## Links

- Documentation: <https://docs.mubit.ai/integrations/claude-code>
- Source: <https://github.com/mubit-ai/claude-plugins>
- License: Apache-2.0
