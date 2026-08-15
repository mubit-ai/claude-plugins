# Mubit memory, end to end

A hands-on walkthrough of one thread through the `mubit-memory` plugin: a session opens, a
prompt arrives, memory is recalled, tools run, the turn ends, work is sent, the session ends
and a lesson is extracted. You drive every step by hand and watch both sides of the wire.

Nothing here talks to a real Mubit instance. `labs/fake-mubit.mjs` stands up all eleven routes
the plugin knows how to call and prints every request, so "what actually leaves the machine"
is something you read, not something you take on faith.

> This repository is a **generated mirror**; the source lives in `ricedb-cc-plugin` and a
> publish wipes anything hand-committed here. `labs/` is on a throwaway branch for exactly that
> reason — poke at anything, keep nothing.

---

## The model in 60 seconds

Two surfaces, one memory.

```
                         ┌─────────────────────────── Claude Code ───────────────────────────┐
                         │                                                                   │
  involuntary  ─────────►│  hook events → 9 node processes, stdin JSON in, stdout JSON out    │
  (you never ask)        │  SessionStart · UserPromptSubmit ×2 · PostToolUse ×2 · Failure     │
                         │  Stop · SubagentStop · PreCompact · PostCompact · SessionEnd       │
                         │                                                                   │
  deliberate   ─────────►│  MCP server → 10 tools the model calls on purpose                  │
  (the model asks)       │  mubit_recall · mubit_learned · mubit_outcome · mubit_reflect · …  │
                         └───────────────────────────────────────────────────────────────────┘
                                       │                                    │
                                       ▼                                    ▼
                        ${CLAUDE_PLUGIN_DATA}  (all local state)      HTTPS → your Mubit
                        spool/ turns/ status/ breaker/ policy/        11 REST routes
```

Five facts that explain most of the design:

1. **A hook is a process.** Claude Code spawns `node hooks/dist/<name>.mjs`, writes a JSON
   payload to its stdin, reads JSON from its stdout, and enforces a timeout. That is the whole
   API. You can run any hook by hand — which is what these labs do.
2. **Every hook exits 0, always.** A dead server, an unwritable data dir, a corrupt state file
   — each costs a memory, never a turn. (`hooks/src/*.mjs`, and `lib/hook.mjs` which wraps
   them all.)
3. **The hot path never touches the network.** Capture writes one file per item into a spool.
   A separate, detached `drain.mjs` batches the spool and posts it. That split is why capture
   can run on every tool call.
4. **Local state is the whole database, and it is all JSON.** `peek` prints it.
5. **The run id is the join key.** Hook captures and MCP-tool writes must derive the *same*
   run id or one query can never see both. Lab 1 and Lab 7 are the two halves of this.

The thread you will follow:

```
SessionStart ─► UserPromptSubmit ─► PostToolUse × 4 ─► Stop ─► SessionEnd
    │                 │  │                 │             │  │        │
 health          recall  stage         spool 2 of 4   turn  drain  drain
 register        (ladder) turn         (2 dropped)    file  ──► POST /ingest
 lessons         ──► POST /query                            ──► POST /outcome
                                                                      │
                                                            POST /reflect ◄─┘
```

---

## Setup

Two terminals, both at the repo root.

**Terminal A — the instance:**

```bash
node labs/setup.mjs        # creates labs/.work/{data,demo-app}; --reset starts over
node labs/fake-mubit.mjs   # leave this running; it prints every request
```

**Terminal B — the hooks:**

```bash
source labs/env.sh
```

That exports exactly what Claude Code exports for a real install (`CLAUDE_PLUGIN_ROOT`,
`CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR`) plus the plugin's own settings, and defines three
helpers:

| Helper | What it does |
| --- | --- |
| `hook <name> <payload.json> [args]` | runs `hooks/src/<name>.mjs` the way Claude Code does |
| `peek [section]` | prints the plugin's local state — `peek --help` lists sections |
| `runid ['<payload json>']` | derives the run id without running a hook |

Nothing touches your real `~/.claude` data. To wipe and start again:
`node labs/setup.mjs --reset && node labs/setup.mjs`.

---

## Lab 1 — Identity: which run does this session write to?

Everything else is keyed on the answer, so it comes first.

```bash
runid
```

```
strategy    per-directory
projectDir  …/labs/.work/demo-app
run_id      cc-demo-app-1ede9c0e
agent_id    claude-code-2f183a4e
```

`cc-<slug>-<hash8>` — the slug is the directory name, the hash covers the **git toplevel**. Two
terminals in one repo share a run; two repos that happen to share a directory name do not.

Now try the other three strategies:

```bash
MUBIT_CC_RUN_STRATEGY=git-branch       runid '{"session_id":"s2"}'
MUBIT_CC_RUN_STRATEGY=per-conversation runid '{"session_id":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"}'
MUBIT_CC_RUN_STRATEGY=static           runid '{"session_id":"s3"}'
```

```
cc-demo-app-main-6a4f0336                      ← branch is in the name AND the hash
cc-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d        ← one conversation, one run
REFUSED: MUBIT_CC_RUN_STRATEGY=static requires MUBIT_CC_RUN_ID…
```

That refusal is the point of the module. The MCP server defaults its session id to the literal
`"default"`, which would pool every user, project and machine into one shared run — so
`lib/runid.mjs` throws rather than ever emitting it, and `lib/http.mjs` refuses to put it on
the wire even if something else produced it.

`/clear` is the other interesting source — it must start a *new* run:

```bash
runid '{"session_id":"clear-demo","source":"clear"}'   # → …-c1
runid '{"session_id":"clear-demo","source":"clear"}'   # → …-c2
peek sessions
```

The counter lives in `sessions/<host_session_id>.json`, which is why `deriveRunId` is
deliberately not a pure function.

**Read:** `lib/runid.mjs` — the source table is in the doc comment at the top.

**Break it:** `MUBIT_CC_RUN_ID=default MUBIT_CC_RUN_STRATEGY=static runid`. Why is a refusal
better than a fallback here?

---

## Lab 2 — SessionStart: the session opens

```bash
hook session-start 01-session-start.json
```

Terminal A shows three calls in order: `GET /v2/core/health`, then
`POST /v2/control/agents/register`, then `POST /v2/control/lessons`. Terminal B prints what
the model will see:

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"# Mubit memory is active\n\nRun: cc-demo-app-1ede9c0e (hosted)\nRelevant memory is injected automatically before each of your turns — do not search for it preemptively.\n…"},
 "systemMessage":"mubit: hosted · run cc-demo-app-1ede9c0e · 2 global lessons"}
```

Three things worth stopping on:

- **`additionalContext` is the injection channel.** Whatever a hook puts there is prepended to
  the model's context. This is the entire mechanism behind "memory is active".
- **"do not search for it preemptively"** is load-bearing. Without that sentence the model
  helpfully calls the recall tool on turn one of every session and pays for it every time.
- **Sub-budgets.** 2500 ms total, split 400/600/900 across health/register/lessons. A slow
  lesson list costs the lesson list, not the steer block — the one thing this hook may never do
  is fail to speak.

Note the lessons request carries **no `run_id`**: absent means all runs, which is exactly what
"global lessons" wants.

```bash
peek marker
```

`status/<run_id>.json` is the only file the status line reads. Render it:

```bash
echo '{"session_id":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"}' | node "$CLAUDE_PLUGIN_ROOT/bin/statusline.mjs"
# ● mubit: cc-demo-app-1ede9c0e · hosted · recall 3/60 tok · lessons 2g
```

**Read:** `hooks/src/session-start.mjs`.

---

## Lab 3 — UserPromptSubmit: recall, and the ladder

One event, **two** registered hooks. They run as separate processes with no ordering
guarantee, and they write to the same file — how they avoid clobbering each other is the lesson.

```bash
hook prompt-recall 02-prompt.json
hook stage-prompt  02-prompt.json
```

`prompt-recall` returns the block that gets injected in front of the prompt:

```
<mubit-memory run="cc-demo-app-1ede9c0e" sources="3" tokens="60">
## Active rules
- Ingest returns when queued, not when stored; poll the job id.
## Lessons
- A job stays queued until indexing completes — waiting is the fix, not retrying.
## Facts
- IngestAccepted.status is always "queued" on success.
</mubit-memory>
```

In Terminal A, look at the request that produced it:

```
POST /v2/control/query   mode=direct_bypass  lane=semantic_search  evidence_only=true
```

**The ladder is the most important design decision in the plugin.** The obvious implementation
— ask the server for a ready-made context block — costs **two LLM calls per prompt**, in front
of every keystroke, forever. So:

| Rung | Request | LLM calls | Entered when |
| --- | --- | --- | --- |
| 1 | `query{mode:"direct_bypass", evidence_only:true}` | **0** | always — the primary path |
| 2 | `query{mode:"agent_routed"}` | 1 | rung 1 returned **403** (policy, not fault) |
| 3 | `context{mode:"sections"}` | **2** | only if you opt in with `recallAssemble: server` |

Rung 1 returns raw `evidence[]`; `lib/assemble.mjs` renders it into sections client-side, in the
server's own order, for free. That is why the block above has `## Active rules` before
`## Lessons` even though the lesson could score higher — section order outranks score, because
the server does it that way and the two must be indistinguishable.

Now the state both hooks touched:

```bash
peek turns
```

```
prompt          the ingest job stays queued after the batch was accepted — is that a bug in enqueue()?
recalled        [ref_rule_1, ref_lesson_1, ref_fact_1]   ← becomes RecordOutcome.entry_ids
```

`stage-prompt` wrote `prompt` (the `Stop` payload carries the *answer* but not the question —
without this file every captured turn would be half a conversation). `prompt-recall` wrote
`recalled`. Both do read-modify-write and rename into place, and each preserves the other's
key. Order does not matter; that is the design.

**Questions:**
- Why does `prompt-recall` emit `{"suppressOutput":true}` and inject *nothing* when recall
  comes back empty? (Hint: what does "I found nothing" teach the model about this channel?)
- Why is a prompt shorter than 8 characters skipped entirely? Why are `/slash` commands?

**Break it:** `MUBIT_CC_RECALL=0 hook prompt-recall 02-prompt.json` — dials nothing.

Then squeeze the budget and watch the trim:

```bash
MUBIT_CC_RECALL_TOKENS=40 hook prompt-recall 02-prompt.json
peek marker
# recall  sources=2 tokens=37 dropped=1 …
```

Three memories became two — and note *which* two. The long `## Lessons` line did not fit, but
the shorter `## Facts` line after it still did. An item that does not fit is skipped and
counted, never treated as a stop signal.

**Read:** `hooks/src/prompt-recall.mjs` (the ladder), `lib/assemble.mjs` (the rendering).

---

## Lab 4 — PostToolUse: capture, redaction, and the two drops

Four tool calls. Two are captured, two are dropped, and the drops are the interesting half.

```bash
hook capture 03-edit.json            # Edit src/queue.js
hook capture 04-read-env.json        # Read .env
hook capture 05-read-ignored.json    # Read build/bundle.js
hook capture 06-bash-failure.json --failure
peek spool
```

Terminal A stays silent through all four: **capture never touches the network.** It writes one
file per item into `runs/<run_id>/spool/` and stops.

```
cc-demo-app-1ede9c0e   2 item(s) pending
  item_id   cc-toolu_lab_0001
  intent    trace   importance medium
  env_tags  tool:claude-code repo:demo-app branch:main
  text      Edit(file_path=src/queue.js, old_string=…) -> Applied 1 edit to src/queue.js

  item_id   cc-toolu_lab_0004
  intent    trace   importance high
  text      Bash(…) FAILED: connect ECONNREFUSED 127.0.0.1:3000 export [REDACTED:assignment]
            Authorization: Bearer [REDACTED:github-token] aws key [REDACTED:aws-access-key]
            built from 9f2a11c4e5d6a7b8c9d0e1f2a3b4c5d6e7f8a9b0
```

Six things happened there:

1. **`.env` was dropped, not scrubbed.** A redacted `.env` is still a map of which secrets the
   project holds. Denylisted subjects never reach the spool at all.
2. **`build/bundle.js` was dropped too** — it is git-ignored, and the denylist honours
   `.gitignore` for free. You already declared those paths not-for-sharing.
3. **Three secret shapes were replaced**, each naming the rule that fired.
4. **The 40-hex git SHA survived.** Entropy over a 16-symbol alphabet is bounded by exactly
   4.0 and the threshold is `>= 4.0`, so a SHA can never trip the generic entropy rule. That is
   a property of the threshold, not a lucky fixture.
5. **The failure is graded `high`** while the successful edit is `medium`. A failed approach is
   the highest-value thing a coding agent can remember — it is the one class of knowledge the
   model cannot re-derive by reading the code.
6. **Every item carries an `intent`.** Items arriving without one cost the server an LLM call
   *per item* to classify. At tool-call frequency, that is the difference between a plugin you
   leave on and one you uninstall.

**Break it:** try to capture the plugin talking to itself —

```bash
echo '{"hook_event_name":"PostToolUse","session_id":"x","tool_name":"Bash","tool_use_id":"t9","tool_input":{"command":"curl $MUBIT_ENDPOINT/v2/core/health"},"tool_output":"OK"}' \
  | node "$HOOKS/capture.mjs"
peek spool     # unchanged
```

Self-reference suppression. Without it the plugin records its own traffic, recalls it, then
records the recall.

**Find the gap** (a real one, worth understanding):

```bash
node --input-type=module -e "
import { redactText } from '$CLAUDE_PLUGIN_ROOT/lib/redact.mjs';
for (const s of ['DATABASE_PASSWORD=hunter2', 'export DATABASE_PASSWORD=hunter2', 'env: DATABASE_PASSWORD=hunter2'])
  console.log(JSON.stringify(s), '->', JSON.stringify(redactText(s, {redact:true}, 'output').text));
"
```

The first two redact; the third does not. Read `ASSIGNMENT_RE` in `lib/redact.mjs` and work out
why a preceding `name:` swallows the assignment behind it. This is why stage 2 (drop whole
paths) exists rather than trusting stage 1 to catch everything.

**Read:** `hooks/src/capture.mjs`, `lib/redact.mjs`, `lib/classify.mjs`, `lib/spool.mjs`.

---

## Lab 5 — Stop: the turn closes, the drain flies, the outcome lands

```bash
hook capture 07-stop.json --stop
sleep 1
peek spool turns jobs
```

Terminal A now shows the two calls that matter most:

```
POST /v2/control/ingest
    idempotency_key=cc-p_lab_0001-0-06b7b1a469a8
    items=3
      · cc-toolu_lab_0001    trace        medium  "Edit(file_path=src/queue.js, …"
      · cc-toolu_lab_0004    trace        high    "Bash(…) FAILED: …"
      · cc-stop-p_lab_0001   task_result  medium  "Q: the ingest job stays queued … A: Not a bug in enqueue()…"
    replied job_id=job_lab_1 status=queued deduplicated=false

POST /v2/control/outcome
    outcome=success  signal=0.2  reference_id=global
    entry_ids=[ref_rule_1, ref_lesson_1, ref_fact_1]   ← the memories this turn reinforced
    idempotency_key=cc-outcome-cc-demo-app-1ede9c0e-p_lab_0001
```

Walk the chain backwards and the whole point of the plugin appears: those three `entry_ids`
are the reference ids of the memories **rung 1 returned in Lab 3**, which `prompt-recall`
staged into the turn file, which the drain read when the turn ended. Recall feeds attribution;
attribution improves the next recall. That loop is the product.

Details worth noticing:

- **The third item is the turn itself** — `Q: … / A: …`, assembled from the staged prompt plus
  `last_assistant_message`. Neither half exists in one payload.
- **`signal: 0.2`, not 1.0.** A turn completing is weak positive evidence that the recalled
  memory helped, not proof. A failed turn is `-0.3`.
- **`status: "queued"` means accepted, not stored.** The spool files are unlinked anyway — the
  alternative is holding every item until a poll no hot path can afford. `jobs.json` keeps the
  last 20 job ids so the doctor skill can go back and ask.
- **Two idempotency keys, both derived, neither random.** Batch keys cover
  `(run, prompt, sequence, item ids)`; the outcome key covers `(run, prompt)`. A retry after a
  transport timeout is a server-side no-op — which is what makes it safe to abandon a detached
  drain and safe to have two drainers race.

Run the drain by hand to see the lock work:

```bash
node "$HOOKS/drain.mjs" < labs/payloads/02-prompt.json     # nothing left to send
```

**Read:** `hooks/src/capture.mjs` (`--stop` mode), `hooks/src/drain.mjs`, `lib/spool.mjs`
(the `link(2)` lock — the comment there explains a real race that was measured, not imagined).

---

## Lab 6 — SessionEnd: the only path that widens a lesson's scope

```bash
hook session-end 08-session-end.json
peek marker
```

```
POST /v2/control/reflect     run=… last_n_items=200 include_step_outcomes=true
    replied lessons_stored=1
POST /v2/control/agents/heartbeat   status=idle
```

Order is the design: **drain inline → flush pending outcomes → reflect → heartbeat idle.**

- The drain commits *before* reflect is attempted, because a failing reflect may never cost
  captures that were already accepted.
- Outcomes go out *before* reflect, because `include_step_outcomes` folds those signals into
  the evidence and the negative ones produce the best lessons.
- The drain runs **inline, not detached** — the process is going away and a detached child may
  be reaped before it finishes.

Why reflect matters: Mubit extracts lessons on its own as it ingests, but those keep the scope
they were extracted at, and a `run`-scoped lesson is invisible to your next session.
`POST /v2/control/reflect` is the only call that can widen that. `reflectOnEnd: false` is not a
latency knob — it is opting out of cross-session memory.

**Break it:** run it a second time.

```bash
hook session-end 08-session-end.json    # stands down; no reflect
```

`claimOnce` wrote `flushed-<session_id>.marker`. SessionEnd can fire more than once (an `exit`
after a `clear`, a wrapper re-running the hook) and a double flush is a double reflect. Note it
returns *true* when it cannot write the marker: losing a session's captures is worse than
sending them twice, and the idempotency key already absorbs the double send.

**Read:** `hooks/src/session-end.mjs`.

---

## Lab 7 — The MCP server: what the model can call on purpose

The hooks are involuntary. The MCP server is the surface the model reaches for deliberately —
`/mubit-memory:recall`, `/mubit-memory:remember`, and the `mubit_*` tools behind them.

```bash
cd integrations/claude-code
node scripts/mcp-probe.mjs --call mubit_status --args '{}'
cd -
```

The probe speaks real stdio MCP: spawn, `initialize`, `notifications/initialized`,
`tools/list`, `tools/call` — exactly what Claude Code does.

```
server    mubit-memory 0.1.0
tools     21
  · mubit_archive
  · mubit_checkpoint
  …
mubit_status →
{ "status": "connected", "endpoint": "http://127.0.0.1:8787",
  "default_session": "cc-demo-app-1ede9c0e" }
```

**`default_session` is the same run id Lab 1 derived.** That is the whole job of
`mcp/src/launch.mjs`. The upstream server reads its config at *module scope*:

```js
const DEFAULT_SESSION_ID = process.env.MUBIT_DEFAULT_SESSION_ID || "default";
```

So the launcher resolves config, derives the run id with the **same** `lib/runid.mjs` the hooks
use, writes five env vars, and *only then* does `await import('./server.js')`. Setting any of
them one line later is indistinguishable from not setting them at all. Ordering is a
correctness property here, not a style preference.

If the two derivations ever diverged, `/mubit-memory:remember` would write into a run that
pre-prompt recall never reads — which is exactly what happens under
`runStrategy: per-conversation`, because an MCP server starts once per session and is never
handed a `session_id`. It falls back to `per-directory` and says so on stderr.

Note also: **21 tools, not the curated 10.** The committed `mcp/dist/server.js` is bundled from
a published `@mubit-ai/mcp` that predates the allowlist patch, so `MUBIT_MCP_TOOLS` is inert in
this bundle. The probe prints that as a note. Cosmetic — but it is a good example of a shipped
artefact disagreeing with its own README, which is only visible if you probe it.

**Read:** `mcp/src/launch.mjs`, `.mcp.json`, `scripts/mcp-probe.mjs`.

---

## Lab 8 — Failure drills

Restart the fake instance with a scenario each time (Ctrl-C in Terminal A first).

### 8a — The operator disabled `direct_bypass`

```bash
node labs/fake-mubit.mjs --scenario deny-direct     # terminal A
hook prompt-recall 02-prompt.json                   # terminal B
hook prompt-recall 02-prompt.json
peek policy
```

First prompt: `403` on `direct_bypass`, then a second call at `agent_routed` — one rung down,
never two. Second prompt: **only one call**, straight to `agent_routed`. The 403 was cached to
`policy/<endpoint_hash>.json` with a 24 h TTL, so a supported configuration costs one wasted
round trip per day instead of one per prompt.

A 403 must also not touch the circuit breaker or the `auth_failed` state — an operator turning
a lane off is not a broken instance. A **401** on the same call is the opposite: give up, never
cache it, because a cached 401 would hide a revoked key for a day.

The cache outlives this drill by 24 hours, so before going back to the earlier labs:

```bash
rm -f labs/.work/data/policy/*.json     # rung 1 is probed again on the next prompt
```

### 8b — The server refuses the payload

```bash
node labs/fake-mubit.mjs --scenario reject-ingest
hook capture 03-edit.json
node "$HOOKS/drain.mjs" < labs/payloads/02-prompt.json
peek spool rejected
```

422 → the batch moves to `spool/rejected/`, quarantined and never retried. The three-way split
is the entire design of the drain:

| Response | Meaning | Action |
| --- | --- | --- |
| 2xx | accepted | unlink the spool files |
| 5xx, network, timeout | the server's problem, batch still good | leave every file, stop, retry next time |
| other 4xx (422, 400, 413…) | *this payload* is bad | quarantine — retrying forever is how a spool becomes unbounded |

401/403/404/408/429 stay retryable on purpose: nobody's memory gets deleted because they had
not pasted an API key yet.

Try `--scenario fail-ingest` (503) and watch the same batch stay put instead.

### 8c — Nothing is listening

```bash
# Ctrl-C the server, then:
rm -f labs/.work/data/status/health.json     # the 30 s readiness cache
hook session-start 01-session-start.json
hook capture 03-edit.json
peek marker breaker health
```

The steer block flips to **"Mubit memory is offline"** — the model is told, in the same channel
it would have received memory in, that there is none this session, *and* that its work is still
being kept. Capture keeps spooling; the next successful drain sends it.

The marker says `warming`, not `unreachable`, because the cold-start grace window (20 s) is
still open — an instance that is still starting is not broken, merely slow. `auth_failed` is
never masked this way, because a server still warming up does not answer 401.

Keep firing hooks with the server down and watch `breaker/<hash>.json` accumulate failures.
Five within 300 s opens the circuit for a 120 s cooldown; exactly one half-open probe dials when
it ends. The status line then reads `· paused 94s`, which tells you "it recovers in 94 seconds"
rather than "this thing is dead".

### 8d — Everything is slow

```bash
node labs/fake-mubit.mjs --scenario slow      # 2.5 s on every route
rm -f labs/.work/data/status/health.json      # bypass the 30 s readiness cache
time hook prompt-recall 02-prompt.json
time hook session-start 01-session-start.json
```

`prompt-recall` returns `{"suppressOutput":true}` at ~1.5 s — its internal budget, well inside
the 3 s hook timeout — and injects nothing rather than making the user wait. `session-start`
returns in **under half a second**: health is the gate and gets only 400 ms of the 2500 ms
budget, so a server that will not answer produces the offline steer block (state
`not_responding`, not `unreachable` — three consecutive timeouts is a different fact from a
refused connection) instead of spending the whole budget finding out.

**Read:** `lib/breaker.mjs`, `lib/http.mjs` (the five pre-flight guards at the top are worth
the read on their own).

---

## Lab 9 — Bonus: PreCompact, the one blocking network call

```bash
node labs/fake-mubit.mjs                    # healthy again
hook checkpoint 10-precompact.json --pre    # run from the repo root: the transcript path is relative
peek spool
node "$HOOKS/checkpoint.mjs" --post < labs/payloads/10-precompact.json
```

Every other hook would rather lose a memory than cost you a millisecond, because what it wanted
to capture is still on disk afterwards. `PreCompact` is the one event where that is false: once
the host compacts, the transcript is gone. So this hook blocks — and it spools its summary item
*before* it posts, so the anchor survives even a call that hangs.

The transcript is also the densest secret surface the plugin ever touches. Check the spooled
item: the `DATABASE_PASSWORD=` line in `labs/payloads/transcript.jsonl` never reaches the wire.

---

## Lab 10 — The tests are the real spec

```bash
cd integrations/claude-code && npm test        # ~12 s, 720 assertions, no network, no Docker
```

`test/helpers/harness.mjs` is worth reading before any of the test files: `fakeMubit()` is a
richer version of `labs/fake-mubit.mjs` (per-route replies, delays, hangs, request assertions),
and `runHook()` spawns hooks exactly as Claude Code does. Every design decision described above
has a test that pins it — `prompt-recall`'s test asserts rung 3 is *never* reached by default,
because it is the first thing a well-meaning maintainer would "simplify" into place at two LLM
calls per prompt.

Pick one behaviour you found surprising in Labs 1–9 and find the test that pins it. Then change
the implementation to break it and watch which test fails. (One timing-sensitive test can flake
under load; re-run before believing a single failure.)

---

## File map

| Path | What lives there |
| --- | --- |
| `hooks/hooks.json` | the nine registrations, matchers and timeouts — start here |
| `hooks/src/session-start.mjs` | health, register, global lessons, the steer block |
| `hooks/src/prompt-recall.mjs` | the recall ladder, the policy cache |
| `hooks/src/stage-prompt.mjs` | stages the prompt, triggers the drain. Zero network |
| `hooks/src/capture.mjs` | four modes: tool, `--failure`, `--stop`, `--subagent` |
| `hooks/src/drain.mjs` | the only outbound path in the write direction |
| `hooks/src/checkpoint.mjs` | `--pre` blocks; `--post` is a file read |
| `hooks/src/session-end.mjs` | drain → outcomes → reflect → idle |
| `lib/config.mjs` | five-level precedence resolution |
| `lib/runid.mjs` | run and agent identity — the join key |
| `lib/http.mjs` | the only network primitive; never throws |
| `lib/spool.mjs` | file-per-item buffer, drain lock, `claimOnce` |
| `lib/redact.mjs` | the three sanitisation stages |
| `lib/classify.mjs` | tool → intent/importance |
| `lib/assemble.mjs` | client-side section rendering (rung 1's payoff) |
| `lib/breaker.mjs` | connection states, failure classification, cooldown |
| `mcp/src/launch.mjs` | env ordering + run-id agreement before importing the server |
| `bin/statusline.mjs` | reads two JSON files, renders one line, never dials |
| `skills/*/SKILL.md` | the seven slash commands |
| `test/helpers/harness.mjs` | fake Mubit, hook runner, fixtures |

---

## Cleanup

```bash
node labs/setup.mjs --reset     # removes labs/.work entirely
pkill -f labs/fake-mubit.mjs
```
