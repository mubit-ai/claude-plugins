---
name: doctor
description: Diagnose Mubit connectivity, memory health, and stuck ingest jobs. Use when memory looks empty, captures are not landing, or the status line shows a failure glyph.
disable-model-invocation: false
tools: ["mcp__plugin_mubit-memory_mubit__mubit_status", "mcp__plugin_mubit-memory_mubit__mubit_diagnose", "mcp__plugin_mubit-memory_mubit__mubit_memory_health"]
---

Work in this order and stop at the first thing that is broken. Each step costs more than the
one before it, and the cheap steps answer most questions.

1. **Read the local status marker** at `status/<run_id>.json` under the plugin data dir
   (`MUBIT_CC_DATA_DIR`, else `CLAUDE_PLUGIN_DATA`, else
   `~/.claude/plugins/data/mubit-memory`). Free, no network. It carries the last known
   `state`, `updated_at`, `recall` counts, `captured` counts including `pending`, the last
   `reflect` result, and `last_error`. A marker whose `captured.pending` keeps growing is a
   drain problem, not a recall problem. A marker whose `recall.dry_streak` keeps growing is
   the reverse: recall is running and returning nothing. **Check this before step 3** — it is
   the one fault that leaves `state: ready` and a healthy-looking line, so every other check
   below will come back clean while the model receives no memory at all. Read
   `recall.empty_reason` for which kind:
   - `policy_denied` — the instance has direct-access recall (rung 1) disabled, and the
     `agent_routed` fallback is off by default because it costs an LLM call per prompt. Ask
     the operator to enable direct search. `MUBIT_CC_RECALL_FALLBACK=agent_routed` restores
     recall at that cost; `MUBIT_CC_POLICY_TTL_MS=1` re-probes immediately once it is on.
   - `budget_exhausted` — recall ran out of time before the call returned. Raise
     `MUBIT_CC_RECALL_BUDGET_MS`, and note it cannot usefully exceed the hook timeout.
   - `breaker_open` — recall is not being attempted at all; the connection is the problem, so
     continue to step 3.
   - `no_evidence` with a long streak — the connection and policy are fine and the store
     genuinely has nothing for these prompts. Go to step 4.

   Read `reflect.status` the same way. It is written by exactly two processes, and each
   value means one thing:

   | `reflect.status` | Written by | What it means |
   | --- | --- | --- |
   | `""` | nobody — the marker's own default | session-end never got as far as handing the flush over. The hook did not run, or was killed before its first act. |
   | `handoff` | the session-end hook, before it does any work | The hook started and was killed before it could either hand the flush over or fall back to running it inline. This is the value to expect when the host cancels SessionEnd inside its ~1 s window, and it is what keeps `""` above meaning only "never ran". Still reading this minutes later means that session's flush was lost — the next session's first drain picks the captures back up, but its reflection is gone. |
   | `detached` | the session-end hook, just before it spawns | The flush was handed to a background process and no child has reported since. Momentary at the end of a session; still reading this minutes later means the child was reaped before it finished — the container exited with it, or the machine went to sleep. |
   | `ok` | whichever process ran the flush | Reflection ran. `lessons_stored` is what it stored, and it can legitimately be `0` when the server has not finished indexing the session's evidence. |
   | `failed` | " | Reflection was attempted and did not answer. `last_error` carries the reason and `attempts` says how many tries it took to give up; this session's lessons stay at `run` scope. **Read `attempts` before diagnosing anything else** — see the note below. |
   | `skipped:disabled` | " | `MUBIT_CC_REFLECT_ON_END=0`. Not a fault — a deliberate opt-out that costs cross-session memory. |
   | `skipped:not-ingested` | " | Nothing was ingested this session, so there was no tail to reflect over. |
   | `skipped:undrained` | " | The spool did not land, so reflecting would have drawn conclusions from a session the server only half has. The next session drains the rest and reflects then. |

   **A `failed` reflect whose `last_error` is an HTTP 504 is the known one.** Reflection over
   a real run runs long enough that it sits on a cliff, and ordinary latency variance decides
   it — the identical request, issued four times in a row, has returned 504, 504, 200, 504.
   That is why this call retries: `attempts: 2` with a 504 means both throws lost, which
   happens to a minority of sessions and is **not** an instance fault. Do not send the user to check their
   key, their endpoint or their network for it; the same instance is answering every other
   route. What it costs is real, though — that session's lessons stay at `run` scope and are
   invisible to the next session. If it is failing on most sessions rather than some, that is
   worth escalating, and the number to quote is how many consecutive session markers read
   `failed`. `attempts: 1` with a 5xx means the retry was skipped for lack of budget, which
   points at a session-end that was already nearly out of time.

   One caveat before reporting a stuck `detached`: when SessionEnd fires twice for the same
   session — a `reason=exit` after a `reason=clear` — the second hand-off's child stands down
   without reporting, and the stamp it left behind stays. Check whether a reflect for that run
   already succeeded before calling it a reaped child.

2. **If the complaint is "lessons never reach another session", read the scope ceiling
   before anything else.** This is not a connectivity fault and steps 3-5 will all come back
   clean while it is the cause. Two local reads answer it:

   - The **resolved ceiling** on what an MCP write may claim is `mcpLessonScope`
     (`MUBIT_MCP_LESSON_SCOPE`), default `session`. It is a `userConfig` key, so it resolves
     through the ordinary precedence — environment, then `/plugin` → Mubit Memory →
     configure. At `run`, every lesson `mubit_learned` writes stays inside the run that wrote
     it, and nothing later widens it: reflection stamps `run` too.
   - **What is actually stored, by scope** — `node scripts/scope-audit.mjs`. It reports the
     scope distribution across every run, how many lessons are visible outside the run that
     wrote them, and whatever promotion metadata the instance stamped. Run it before and
     after changing the setting; a single reading says nothing.

   A ceiling of `run` with a user who expected cross-session lessons is the whole fault, and
   the fix is one setting rather than anything below.

3. **Check connectivity** — `mubit_status`, or `GET /v2/core/health` directly. Health is the
   one route that answers without a key, so a healthy response here alongside a failing
   control-plane call points squarely at auth. It returns the plain string `OK`, not JSON —
   parsing it as JSON is itself a way to invent a `server_error` that is not there.
4. **Check memory health** — `mubit_memory_health`, or `POST /v2/control/memory_health
   {run_id}` directly. This is what distinguishes "nothing was ever written" from "things were
   written and are not coming back". It inspects the store; step 3 inspected the connection,
   and a healthy answer there says nothing at all about this one.
   `/mubit-memory:memory-health` is the same call with the reading guide attached.
5. **Poll the run's ingest jobs.** `runs/<run_id>/jobs.json` holds the last 20 accepted job
   ids; poll each with `GET /v2/control/ingest/jobs/<job_id>?run_id=<run_id>`. Accepted means
   queued, not stored. A job stuck in `queued` for minutes means the instance accepted the
   write but has not finished indexing it — report it and point the user at the console.
6. **If there is an error in context**, `POST /v2/control/diagnose {run_id, error_text}` (or
   `mubit_diagnose`) to surface failure-path lessons that match it. This is a memory lookup,
   not a health check: run it when you have a specific error to explain.

## Report the typed state verbatim

The connection state is a closed union of six values, and each one has a different fix. Say
which one it is — never paraphrase them into "something went wrong", which sends the user
looking in the wrong place.

| `ConnState` | What it means | The fix |
| --- | --- | --- |
| `ready` | 2xx, and the health route answered with its own `OK`. The connection is fine. | If memory still looks wrong, check `recall.dry_streak` first (step 1) — a dead recall path reports `ready`. If that is zero, the problem is content or scope — go to step 2, then step 4. |
| `unconfigured` | No endpoint is set, so nothing was dialed. Not a fault, and not a server problem — there is no server yet. | `/mubit-memory:auth`. Say plainly that nothing is broken and nothing has been lost: capture is buffered and goes out once an endpoint exists. |
| `unreachable` | `ECONNREFUSED` / `ENOTFOUND` / `EHOSTUNREACH` / `ECONNRESET`. Nothing is listening. | Check the endpoint is correct and the instance is running — see `/mubit-memory:setup`. |
| `server_error` | 5xx, an unparseable body on a JSON route, or a 200 on the health route whose body was not `OK`. Something is up and answering wrongly. | Retry, then check the instance's status in the console. If it persists, check the endpoint reaches Mubit rather than a proxy or SSO portal — those answer 200 as well, and that is what this state catches. |
| `auth_failed` | 401 or 403. The key is missing, wrong, or revoked. | Set a valid `mbt_...` key — `/mubit-memory:auth`. This state is sticky and deliberately does not open the breaker, because it is the one error the user can actually fix. |
| `not_responding` | Three or more consecutive timeouts. | Usually load, not death: a cold cache, a laptop waking from sleep, a build hogging the CPU. Retry before concluding anything. |

**A single timeout is not a verdict.** One `AbortError` changes no state; only a streak of
three escalates, and only to `not_responding` — never to `unreachable` or `server_error`.

**`unconfigured` is never a server fault.** If the marker or the breaker says an endpoint is
unset, do not read the `server_error` row to the user and do not suggest checking instance
status. Nothing was dialed.

Two more things that look like faults and are not:

- **Warming.** Within the cold-start grace window (20 s by default) after an endpoint is seen
  for the first time, failures are recorded but displayed as `◍ warming`. An instance that is
  still starting is not broken, merely slow to answer. The window is armed per endpoint, so a
  marker still reading `warming` long after that endpoint was first used is a bug worth
  reporting, not a warming instance.
- **Paused.** After 5 failures in 300 s the breaker opens for a 120 s cooldown and the status
  line shows `· paused Ns`. Requests are being skipped on purpose. One half-open probe dials
  when the cooldown ends; a success closes it. Report the remaining cooldown rather than
  advising a restart.

Finish with a one-paragraph verdict: the state, the single most likely cause, and the exact
command or setting that fixes it. Do not run installers or start services on the user's
behalf.
