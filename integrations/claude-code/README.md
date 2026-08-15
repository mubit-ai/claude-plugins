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

```
/mubit-memory:auth
```

That is the whole setup. It opens the Mubit console in your browser; you sign in, or sign up on
the same page, and the key comes back over a loopback callback on `127.0.0.1`. The key never
passes through the conversation, so it never lands in a transcript you might export or attach to
a bug report.

It stores exactly two values — the whole of the plugin's configuration:

| Setting | Value |
| --- | --- |
| `endpoint` | your instance URL, e.g. `https://eu.mubit.ai` |
| `apiKey` | a key of the form `mbt_...` |

They go to `${CLAUDE_PLUGIN_DATA}/credentials.json`, owner-only (mode `600`). That directory sits
outside the plugin root, which is replaced wholesale on every update — so signing in is a
once-per-machine step, not a once-per-release one.

Two things worth knowing before you read the result:

- **Exit 2 is not a failure.** A brand-new workspace takes a minute or two to provision. Run
  `/mubit-memory:auth` again shortly and it resumes where it left off.
- **You still need a new session.** `/reload-plugins` registers the hooks but does not fire
  `SessionStart`, so until you start a fresh session there is no run id and nothing on the status
  line. This is the most common "it is still broken" report immediately after a *successful*
  sign-in, and it is not a fault.

The key is checked against your instance before it is written. A key that the server rejects is
never stored — storing an unverified key does not save you a step, it just moves the failure to
the next session, where it looks like a broken plugin rather than a failed login.

### If there is no browser

Over SSH, in a container, or on a machine with no default browser, the flow reports
`browser_failed` and prints the URL rather than dead-ending. Issue a key at
<https://console.mubit.ai>, then hand it over for that one command:

```bash
MUBIT_AUTH_KEY='mbt_…' node "${CLAUDE_PLUGIN_ROOT}/bin/auth.mjs" --paste
```

The key travels in the environment rather than a `--key` flag because a process's arguments are
readable by every user on the machine, and its environment is not.

### Or set it by hand

`/plugin` → Mubit Memory → configure still works, and still wins over what `auth` writes. `apiKey`
is marked sensitive there, so it lands in your OS keychain — the best place for it. Prefer that
for a long-lived install, and `/mubit-memory:auth` for getting working in the next minute. (A
slash command cannot write the keychain; the `/plugin` UI is its only writer. That is precisely
why `auth` needs a store of its own.)

Two more commands, for when you want to know what is there:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/auth.mjs" --status   # reports presence, never the key; non-zero when unconfigured
node "${CLAUDE_PLUGIN_ROOT}/bin/auth.mjs" --logout   # removes the stored credentials
```

Confirm any of these routes with `/mubit-memory:setup`, which calls `mubit_status` and echoes the
endpoint and the run id back. A rejected key reports as `auth_failed`, which is a key problem —
missing, wrong, or revoked — not a network one; `/mubit-memory:auth` is the fix.

If the endpoint is unset the plugin has nothing to talk to: capture spools locally, recall
returns nothing, and the status line says so. Nothing is lost and nothing is sent.

While an instance is still coming up, the status line shows `◍ warming` rather than a failure
glyph — see [Connection states](#connection-states).

---

## What you get

### Nine hook registrations

| Event | Runs | Timeout | What it does |
| --- | --- | --- | --- |
| `SessionStart` (`startup\|resume\|clear\|compact`) | `session-start.mjs` | 5 s | Derives the run id, checks health, registers the agent (heartbeats on `resume`), pulls up to 5 global lessons, injects a short steer block telling the model memory is active and not to search for it preemptively. |
| `UserPromptSubmit` | `prompt-recall.mjs` | 3 s | Queries Mubit and injects recalled memory as `additionalContext`. Blocking, with a 1500 ms internal budget. Injects nothing at all when the result is empty. |
| `UserPromptSubmit` | `stage-prompt.mjs` | 3 s | Zero network. Stages the prompt so the `Stop` capture has both halves of the turn, and triggers the detached drain when the spool is full or stale. |
| `PostToolUse` (built-in tools) | `capture.mjs` | 3 s | Redacts and spools the tool call. Zero network. |
| `PostToolUse` (`^mcp__.*`) | `capture.mjs` | 3 s | Same, for other MCP servers' tools. Mubit's own tool calls are suppressed. |
| `PostToolUseFailure` | `capture.mjs --failure` | 3 s | Captures the failure — these produce the most useful lessons. |
| `Stop` | `capture.mjs --stop` | 5 s | Writes the `Q: … / A: …` turn, spawns the drain, and attributes the turn's outcome to the memories that were recalled for it. |
| `SubagentStop` | `capture.mjs --subagent` | 3 s | Same, under a distinct subagent identity. |
| `PreCompact` | `checkpoint.mjs --pre` | 10 s | The one blocking network call in the plugin: snapshots the last 200 KB of transcript before the host throws it away. |
| `PostCompact` | `checkpoint.mjs --post` | 5 s | Zero network. Tells the model what the checkpoint anchor is. |
| `SessionEnd` | `session-end.mjs` | 8 s | Drains inline, flushes pending outcomes, then reflects. |

(Nine events; `UserPromptSubmit` and `PostToolUse` each register two commands.)

Every hook exits 0, always. A memory layer has no business breaking a prompt — a dead server,
an unwritable data dir, or a corrupt state file costs you a memory, never a turn.

### Seven skills and one subagent

| Command | Use it for |
| --- | --- |
| `/mubit-memory:auth` | Sign in and store a key for this machine. Also the fix for `auth_failed`, and for a rotated or revoked key. Never installs anything. |
| `/mubit-memory:setup` | First run: confirm the endpoint and key are set and the instance answers. Never installs anything. |
| `/mubit-memory:doctor` | Diagnose connectivity, memory health, and stuck ingest jobs, cheapest check first. |
| `/mubit-memory:recall` | Search memory for detail beyond what was already injected this turn. |
| `/mubit-memory:remember` | Save a durable lesson, rule, or standing preference. |
| `/mubit-memory:reflect` | Extract lessons from this session mid-flight, rather than waiting for `SessionEnd`. |
| `/mubit-memory:forget` | Delete a lesson, or down-weight one that is merely wrong. |
| `@mubit-memory:mubit-recall` | Subagent: multi-angle memory search in an isolated context, returns a synthesis instead of raw evidence. |

### Ten MCP tools

The bundled MCP server exposes 21 tools; the plugin allowlists ten of them by default:

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

The keyword list for `assignment` is `secret`, `token`, `password`, `credential`, `assertion`,
`signature`, `apikey` and `api_key`. A final `high-entropy` rule catches
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

The credentials store sits below the environment so a CI job exporting `MUBIT_API_KEY` still wins
over whatever a developer once signed in as on that machine, and above the project file so a
fresh sign-in beats a stale committed `.mubit-cc.json`. If a setting you expected from
`/mubit-memory:auth` appears to be ignored, something above it is set.

| Option | Default | Environment variable | Effect |
| --- | --- | --- | --- |
| `endpoint` | `""` | `MUBIT_ENDPOINT` | Your Mubit instance URL. Required — without it there is nothing to talk to. |
| `apiKey` | `""` | `MUBIT_API_KEY` | `mbt_...` key, sent as `Authorization: Bearer`. `/mubit-memory:auth` writes it to the owner-only credentials store; plugin settings keep it in the OS keychain and win over that. Never written to the resolved-config cache. |
| `userId` | `""` | `MUBIT_CC_USER_ID` | Optional user/entity id for multi-user memory scoping. |
| `runStrategy` | `per-directory` | `MUBIT_CC_RUN_STRATEGY` | How a session maps to a Mubit run. See [Run strategies](#run-strategies). |
| `capture` | `true` | `MUBIT_CC_CAPTURE` | Capture tool activity. Off means the `PostToolUse`/`Stop` hooks spool nothing. |
| `recall` | `true` | `MUBIT_CC_RECALL` | Inject recalled memory before each prompt. Off means `UserPromptSubmit` dials nothing. |
| `redact` | `true` | `MUBIT_CC_REDACT` | Stage-1 pattern scrub. Turning it off is not recommended; stages 2 and 3 run regardless. |
| `recallTokenBudget` | `1500` | `MUBIT_CC_RECALL_TOKENS` | Maximum tokens of recalled context injected per prompt. Sections are trimmed to fit, preferring non-stale entries. |
| `recallAssemble` | `client` | `MUBIT_CC_RECALL_ASSEMBLE` | `client` assembles the context block locally for **0 LLM calls**. `server` uses `/v2/control/context`, which costs **2 LLM calls per prompt** and replaces the free path rather than adding to it. |
| `reflectOnEnd` | `true` | `MUBIT_CC_REFLECT_ON_END` | Reflect at `SessionEnd`. This is the only path that promotes a lesson beyond its own run, so turning it off to save a few seconds trades away cross-session memory entirely. See below. |
| `outcomeMode` | `implicit` | `MUBIT_CC_OUTCOME_MODE` | `implicit`: each turn's success or failure is attributed automatically to the memories recalled for it. `explicit`: only the model's own `mubit_outcome` calls count. `off`: no attribution. |
| `statusLine` | `true` | `MUBIT_CC_STATUSLINE` | Render the status line. When false it prints an empty line and exits 0 rather than erroring per frame. |
| `mcpTools` | `""` (the curated ten) | `MUBIT_MCP_TOOLS` | Comma-separated allowlist. A list you supply is used verbatim, not unioned with the default — that is how you ask for only `mubit_recall`. |

### Environment-only settings

These have no plugin-settings equivalent. They also read from `.mubit-cc.json` under the
camelCase name in parentheses.

| Variable | Default | Effect |
| --- | --- | --- |
| `MUBIT_CC_DATA_DIR` | `${CLAUDE_PLUGIN_DATA}` | Where local state lives. |
| `MUBIT_CC_RUN_ID` (`runId`) | `""` | The pinned run id for `runStrategy: static`. Required there; unset is a config error, never a silent fallback. |
| `MUBIT_CC_RECALL_BUDGET_MS` (`recallBudgetMs`) | `1500` | Wall-clock budget for pre-prompt recall. |
| `MUBIT_CC_RECALL_SECTIONS` (`recallSections`) | `mental_models,active_rules,lessons,facts,working_memory,traces` | Which context sections to request. |
| `MUBIT_CC_POLICY_TTL_MS` (`policyTtlMs`) | `86400000` (24 h) | How long a cached `direct_bypass` policy denial is honoured before retrying. |
| `MUBIT_CC_CAPTURE_DENY` (`denyGlobs`) | `""` | Extra denylist globs, appended to the built-in floor. |
| `MUBIT_CC_RESPECT_GITIGNORE` (`respectGitignore`) | `1` | Drop captures for git-ignored paths. |
| `MUBIT_CC_MAX_PARAM_BYTES` (`maxParamBytes`) | `4096` | Byte cap per tool-input field. |
| `MUBIT_CC_MAX_OUTPUT_BYTES` (`maxOutputBytes`) | `8192` | Byte cap per tool output. |
| `MUBIT_CC_BATCH_MAX_ITEMS` (`batchMaxItems`) | `32` | Spool size that triggers a drain. |
| `MUBIT_CC_BATCH_MAX_AGE_MS` (`batchMaxAgeMs`) | `30000` | Spool age that triggers a drain. |
| `MUBIT_CC_TIMEOUT_MS` (`timeoutMs`) | `4000` | Per-request HTTP timeout. |
| `MUBIT_CC_COLDSTART_GRACE_MS` (`coldStartGraceMs`) | `20000` | How long after a session start failures display as `◍ warming`. |
| `MUBIT_CC_BREAKER_THRESHOLD` (`breakerThreshold`) | `5` | Failures within the window that open the circuit breaker. |
| `MUBIT_CC_BREAKER_WINDOW_MS` (`breakerWindowMs`) | `300000` (5 min) | The rolling failure window. |
| `MUBIT_CC_BREAKER_COOLDOWN_MS` (`breakerCooldownMs`) | `120000` (2 min) | Cooldown before a single half-open probe is allowed. |
| `MUBIT_CC_LOG_LEVEL` (`logLevel`) | `warn` | `error`, `warn`, `info`, or `debug`. |
| `MUBIT_CC_ENV_TAGS` (`envTags`) | `""` | Extra `TYPE:NAME` tags on every ingested item, appended to the derived `tool:claude-code`, `repo:`, `branch:`, `lang:` set (8 total). |

### Turning off `reflectOnEnd`

Mubit reflects on its own as a run accumulates activity, but a lesson extracted that way stays
at the scope it was extracted at — typically `run` — and a `run`-scoped lesson is invisible to
your next session.

`POST /v2/control/reflect`, which `SessionEnd` issues and which `reflectOnEnd` controls, is the
only thing that can widen a lesson's scope. Turn it off and your store still fills up — it just
never produces anything a future session can see. It is not a latency knob.

(Reflecting is necessary, not sufficient: rules are never scope-promoted, and a lesson has to
recur before it travels. Expect widening over several sessions, not on the first reflect.)

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

The status line reports one of five typed states. They are typed separately because each one
has a different fix; `/mubit-memory:doctor` reports them by name for the same reason.

| State | Glyph | What it means | The fix |
| --- | --- | --- | --- |
| `ready` | `●` | A 2xx with a parseable body. The connection is fine. | If memory still looks wrong, the problem is content or scope, not connectivity. Run `/mubit-memory:doctor` and look at memory health and ingest jobs. |
| `unreachable` | `✖` | `ECONNREFUSED` / `ENOTFOUND` / `EHOSTUNREACH` / `ECONNRESET`. Nothing is listening. | Check `endpoint` is correct and your instance is running. |
| `server_error` | `▲` | 5xx, or a 2xx whose body will not parse, or a 4xx that is a payload problem (400/413/422) or backpressure (429). Mubit is up and failing. | Retry, then check your instance's status in the console. The client cannot fix this one. |
| `auth_failed` | `✖` | 401 or 403. The key is missing, wrong, or revoked. | Set a valid `mbt_...` key via `/mubit-memory:setup`. This state is sticky and deliberately does not open the breaker, because it is the one error you can actually fix. |
| `not_responding` | `◌` | Three or more *consecutive* timeouts. | Usually load, not death — a cold cache, a laptop waking from sleep, a build hogging every core. Retry before concluding anything. |

Two displays that look like faults and are not:

- **`◍ warming`** — inside the cold-start grace window (20 s by default) after a session starts,
  failures are recorded but shown as warming. An instance that is still starting is not
  broken, merely slow to answer. `auth_failed` is never masked this way, because a server
  still warming up does not answer 401.
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
| `auth_failed`, or nothing works on a fresh machine | No key, or a rotated/revoked one | `/mubit-memory:auth`, then **start a new session** — the sign-in itself does not fire `SessionStart` |
| `/mubit-memory:auth` exits 2 | The workspace is still provisioning. Not a failure | Wait a minute and run it again; it resumes where it left off |
| Signed in successfully, but the plugin still uses an old key | Plugin settings and `MUBIT_API_KEY` both outrank the credentials store | Clear the higher rung, or set the new key there instead. `bin/auth.mjs --status` shows what the store holds |
| No skills, no hooks, no MCP server, and no error anywhere in the UI | `plugin.json` failed schema validation. A plugin that fails validation does not half-load — it does not load | `claude --plugin-dir <path> --debug-file /tmp/cc.log`, then `grep "invalid manifest" /tmp/cc.log` |
| `mcp-config-invalid: Missing environment variables` | `.mcp.json` references a `${VAR}` that is unset | Not something an install can hit; if you forked the plugin, declare no `env` block at all |
| Status line shows a glyph but no counters | No hook has written the marker for this run yet | Normal for the first few seconds of a session |
| Status line never appears at all | A plugin cannot register `statusLine`; the shipped entry is inert | Add it to your own `~/.claude/settings.json` — see [A status line](#a-status-line) |
| `/mcp` lists 21 tools instead of ten | The bundled MCP server predates the allowlist patch | Cosmetic; the ten in the default set are the ones the skills use. Fixed by the next `@mubit-ai/mcp` release |
| A saved lesson never becomes visible in a later session | `mubit_learned` writes every entry as `success` / `session`; only the explicit reflect path widens scope, over several sessions | Keep `reflectOnEnd` on, and run `/mubit-memory:reflect` at meaningful checkpoints |
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
