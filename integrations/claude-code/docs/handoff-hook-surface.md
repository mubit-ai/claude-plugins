# Handoff — the hook surface follow-ups

**Branch:** `feat/hook-surface-followups`, off `pre-main` at `af866e8`.
**Origin:** a research pass over Mubit's docs and Claude Code's hook reference, asking two
questions — which hooks the plugin should add, and where MCP earns its place against a hook.
Full memo: <https://claude.ai/code/artifact/41191641-1101-444d-94da-420dcd8f0661>.

Seven items. They are ordered so that the cheap correctness fixes land first and the one that
changes the plugin's economics lands third, before anything speculative. Items 1, 2 and 4 are
each an afternoon. Item 3 is the one worth clearing a day for.

Nothing here is implemented. This document is the argument and the anchors, not a diff.

---

## The finding that reorders everything

The plugin was built on the assumption that the MCP server is the expensive surface and the
hooks are free. `docs/manual-test-0.10.0.md` §11.1 states it plainly: "**Hooks cost zero
context** — they run in the harness, not the model."

That is true of a hook's *existence* and false of its *output*. Measured three ways by booting
the real server over stdio and reading `tools/list` (`scripts/measure-mcp-live.mjs` on branch
`exp/hooks-vs-mcp`):

| surface | tokens | paid |
| --- | ---: | --- |
| MCP schemas, unfiltered 21 | 6,254 | once, and only where tool search is off |
| MCP schemas, curated 10 | 3,016 | once, and only where tool search is off |
| MCP tool **names** — tool search on, the default | 356 | once |
| skill + agent frontmatter | 409 | once, always |
| **recall injection** (`recallTokenBudget`) | **1,500** | **every prompt** |

At the ceiling the third prompt of a session costs more than the entire curated MCP surface.
Over forty prompts it is up to 60,000 tokens against 356.

Two things follow, and they set the priorities below:

1. **Context cost is no longer a reason to prefer a hook over an MCP tool.** Claude Code defers
   MCP schemas by default; only names and the server's `instructions` field load upfront. The
   `mcpTools` allowlist still earns its keep, but as a guard on the *write* surface — which is
   what `mcpLessonScope` and the egress guard already understand — not as a context saving.
2. **The tokens are in recall injection, not in the tool schemas.** Item 3 is therefore worth
   more than items 5–7 combined.

A third, structural finding runs underneath: hook handlers are no longer only shell commands.
`type` accepts `command`, `http`, `mcp_tool`, `prompt`, and `agent`. An `mcp_tool` handler
calls a tool on the plugin's own already-connected server (`plugin:mubit-memory:mubit`); an
`http` handler POSTs the event JSON straight at `/v2/control/*`. So "a hook, or an MCP tool"
was never the real choice — the same Mubit call can be either surface, and several of the
items below can be prototyped as an `mcp_tool` handler before anyone writes a `.mjs` file.

---

## 1 — Add `fork` to the SessionStart matcher

**One word. A forked session currently starts with no memory at all.**

`hooks/hooks.json:4` matches `startup|resume|clear|compact`. The hook reference lists a fifth
source:

> `fork` — A new session forked from an existing one: `--fork-session` with `--resume` or
> `--continue`, the `/fork` background copy, or `/branch`

and immediately below it: *"Before v2.1.214, forked sessions reported source `resume`."*

So this used to work by accident and stopped. On current Claude Code, `/fork` and `/branch`
produce a session where `session-start.mjs` never runs — which means no derived run id, no
injected preamble, and no marker. Every downstream hook in that session then does its own
fallback derivation or nothing at all, and the user sees a plugin that silently does nothing
in exactly the sessions they branched *because* the work mattered.

**Where:** `hooks/hooks.json:4`.

**Watch for:** the matcher is a `|` list, which the docs route through exact-string matching
rather than regex — adding `|fork` is safe and needs no anchoring. Check whether
`session-start.mjs` branches on `source` anywhere; a fork is closer to `resume` than to
`startup` for anything that decides whether to re-announce itself.

**Verify:** `claude --fork-session --resume <id>` and confirm the SessionStart preamble
appears and `status/<run_id>.json` is written.

---

## 2 — Ship server `instructions`

**Under tool search this is how the tools get found, and it is the only Mubit context a
subagent sees.**

The MCP reference is explicit that with tool search on, *"only tool names and server
instructions load at session start"*, and tells server authors that instructions *"help Claude
understand when to search for your tools, similar to how skills work."*

Mubit's `initialize` response carries `serverInfo` and `capabilities` and no `instructions`
field. `mcp/src/launch.mjs` never sets one — it publishes five env vars and imports the
server. So under the default configuration the model is offered ten tool names with no
statement of when any of them is worth reaching for.

The SessionStart preamble covers for this today: it names `mubit_recall`, `mubit_diagnose` and
`mubit_dereference` and says when each applies. But it fires once, in the parent conversation.
**A subagent never sees it** — which is the same gap item 5 attacks from the other side.

**Where:** `mcp/src/launch.mjs`. The bundled server reads its config at module scope, so if
the instructions can be passed as an env var the existing ordering discipline applies
unchanged; if not, the launcher has to wrap the `initialize` response the way `mcp/src/egress.mjs`
already wraps ingest — same seam, same fall-through-on-surprise rule.

**Content:** roughly what the SessionStart preamble says, minus the run-specific parts. When
memory is worth searching, what each tool is for, and the one thing a model gets wrong
unprompted — that `mubit_learned` is for durable claims, not for narrating the session.

**Verify:** the live `initialize` probe in `scripts/measure-mcp-live.mjs` prints the result
object; `instructions` should appear. In a session, the string shows up under "MCP Server
Instructions" in the system prompt.

---

## 3 — A cross-turn seen-set in the recall path

**The largest token win available to this plugin, by an order of magnitude.**

`lib/assemble.mjs:269` dedupes `sourceRefIds` *within* one block — "the same entry surfacing
twice" is collapsed. Nothing dedupes *across* turns. `hooks/src/prompt-recall.mjs` keeps no
record of what it injected last time, so a lesson that stays relevant for twenty prompts is
paid for twenty times, and all twenty copies sit in the transcript competing with each other.

This is not a hypothetical shape. The plugin's own status-line example is `recall 6/1.2k tok`
— six memories, 1.2k tokens, on a single prompt. Six memories about the task at hand do not
stop being about the task at hand on the next prompt.

**The state already exists.** `stage-prompt.mjs` writes `runs/<run_id>/turns/<prompt_id>.json`,
and `prompt-recall.mjs` writes `recalled: [reference_id, …]` into that same file — the array
`lib/outcome.mjs:170` later reads as `entry_ids`. So a per-run roll-up of "reference ids
already injected, and when" is an aggregation over files the plugin is already writing, not a
new subsystem.

**The shape to aim for:** on a repeat, do not drop the entry — degrade it. A one-line pointer
(`reference_id` plus its first clause) costs perhaps 15 tokens against 200, and keeps the id
in `sourceRefIds` so `Stop` can still attribute against it. Dropping it outright would break
attribution for exactly the memories that are helping most, which is the opposite of what
`record_outcome` is for.

**Two things to get right:**

- **Compaction resets the window, not the file.** After `PostCompact` the model has not seen
  any of it, so the seen-set has to be cleared or the block re-expanded. `checkpoint.mjs`
  already runs on both compaction events and is the natural place.
- **Attribution semantics.** `lib/outcome.mjs` distinguishes "injected and echoed" from
  "injected and unused". A pointer-only render is still an injection; make sure a degraded
  entry does not start reading as unused and accumulating neutral outcomes.

**Related, cheaper, same target:** an `InstructionsLoaded` hook receives the loaded `CLAUDE.md`
content and could feed the recall path a suppression set, so the plugin stops spending budget
restating rules the repo already states. Worth doing after the seen-set, with the same
machinery.

**Verify:** `scripts/mubit-inspect.mjs --run <id> --last 40` already prints per-prompt `tok`
and `chars`. Run a fixed forty-prompt script before and after; the `totals` row is the number.

---

## 4 — Wire `StopFailure`

**Stop feeding API errors into the reinforcement signal.**

`Stop` currently posts an outcome for every turn against that turn's recalled ids. A turn that
ended on `rate_limit`, `overloaded`, or `max_output_tokens` did not fail because the recalled
memory was wrong — but nothing in the current path can tell the difference, so
`lib/outcome.mjs`'s failure branch absorbs noise from the API.

The docs call `record_outcome()` *"the highest-leverage call in the loop — without it,
reflection has only 'what happened', never 'what worked'."* Everything downstream depends on
its input being clean: `knowledge_confidence`, the 0.6 / 0.25 validation gate, scope promotion,
and the shadow A/B that gates the widest scopes. Poisoning it is expensive in a way that shows
up late and diffusely.

`StopFailure` fires on exactly those turns, and its matcher *is* the error taxonomy:
`rate_limit`, `overloaded`, `authentication_failed`, `billing_error`, `invalid_request`,
`model_not_found`, `server_error`, `max_output_tokens`, `unknown`.

**Where:** a new entry in `hooks/hooks.json` and a mode on `hooks/src/capture.mjs` — it
already dispatches four modes by argv, and this is a fifth. The turn file is the coordination
point: mark it, and let `Stop`'s attribution read the mark.

**A judgment call to make explicitly:** suppress the outcome entirely, or post `neutral` with
an empty `entry_ids`? `lib/outcome.mjs:135` documents the existing three-row table and notes
that row 1 — never sending an outcome attributed to nothing — is what makes row 3 legible.
An API-failed turn is a fourth row. My read is that it should suppress rather than post
`neutral`, because `neutral` currently means "injected and the model ignored it", which is a
real signal about the memory; conflating it with "the API fell over" degrades the one row that
is hardest to interpret already. But this is the plugin's own vocabulary and the call belongs
to whoever owns that table.

**Note:** `StopFailure` ignores exit codes and output entirely, and accepts only
`terminalSequence`. It is a pure side-effect hook. Do not try to return context from it.

---

## 5 — Wire `SubagentStart`

**Subagents get zero recalled memory today, and their writes land in the parent's run.**

Two separate gaps, one hook.

**No recall.** `UserPromptSubmit` does not fire for a subagent — a subagent has no user prompt.
So the entire recall path is inert inside the Agent tool. Every subagent this plugin's users
spawn works without memory, and the bundled `mubit-recall` agent is the only one that gets any,
because it goes and asks for it through MCP.

**No isolation.** `hooks/src/capture.mjs:345` attributes a `SubagentStop` to the subagent's own
`agent_id` — but in `metadata_json`, inside the parent's run. No separate run, no `link_run`,
no lane. Mubit's subagent-isolation pattern exists to avoid exactly this: *"an orchestrator
fans work out to subagents that each get their own `run_id`"*, linked back with
`client.advanced.link_run()` and read together with `include_linked_runs=True`. Six parallel
subagents currently pour six streams of evidence into one undifferentiated run.

> **Landed 2026-08-21, both halves** (HS-5 for the recall, SC-08 for the isolation). The
> paragraph above is the state before them and is kept as the argument, not as the current
> code. `ROUTES` carries `/v2/control/runs/link` now; `subagent-start` calls it with
> `(parent, sub)` and records the result; and `capture --subagent` files under the sub-run id
> where that join is on record. The sentence that has *not* expired is the last one — the
> `metadata_json` attribution stays exactly where it was, because it is what makes a
> `SubagentStop` matchable against the host's own `agent_id` whichever run the item is filed
> under.

`SubagentStart` closes both. It carries `agent_id` and `agent_type`, matches on agent type, and
— despite being unable to block subagent creation — **can return `additionalContext`**, which
the docs describe as *"added to the subagent's context at the start of its conversation, before
its first prompt."*

> This one is worth stating because I got it wrong first. A summarised read of the hook docs
> reported that `SubagentStart` cannot inject context and only offers `systemMessage`. The raw
> reference says otherwise, at `### SubagentStart`. Check the source doc, not a summary.

**Where:** new hook, new `hooks/src/subagent-start.mjs`; run derivation in `lib/runid.mjs`
needs a sub-run form; `include_linked_runs` on the parent's recall. *(All three exist:
`lib/recall.mjs` sends `include_linked_runs`, and `deriveSubRunId` is the sub-run form.)*

**Watch for:**

- **Matcher syntax.** Plugin-scoped agent types go through the regex path because of the colon.
  Anchor them: `^mubit-memory:mubit-recall$`.
- **Do not recurse.** The `mubit-recall` agent must not get an injected recall block; it exists
  to run recall.
- **Budget it tighter than the main thread.** A subagent's window is smaller and its task is
  narrower. Reusing `recallTokenBudget` unchanged would spend a parent-sized block on a
  three-turn Haiku agent.
- **Cost.** This adds a process and possibly a network round trip per subagent spawn. Fan-out
  of ten is ten of them. Non-blocking as far as the harness is concerned, but not free. *(Two
  round trips as shipped — recall and the link — which is why the link carries a 500 ms
  ceiling of its own inside the same hook budget rather than the configured 4 s timeout.)*

---

## 6 — Prototype async recall behind a flag

**One turn of staleness in exchange for never blocking and never timing out.**

There is a standing problem, recorded in the runbook, that a local Mubit answers a rung-1
query in 1.4–2.3 s while `recallBudgetMs` defaults to 1500 (`lib/config.mjs:379`) — so recall
returns empty and the status line shows `◌ not_responding`, and the documented fix is for the
user to raise `MUBIT_CC_RECALL_BUDGET_MS` by hand. Raising it trades one problem for another:
the budget exists because `prompt-recall` blocks the prompt.

`"async": true` on a command hook removes the trade. Claude Code starts the hook, continues
immediately, and delivers the hook's `additionalContext` on the **next** conversation turn.

For a memory layer this is close to a free trade. Recalled lessons are mostly not about the
last thirty seconds; a lesson that arrives one turn late is still a lesson. And it aligns with
the plugin's own stated rule — `lib/spool.mjs:15`, "a memory layer has no business breaking a
prompt."

**What it costs:** the first prompt of a session gets nothing (SessionStart's preamble still
lands, so it is not silent). Attribution needs care — the turn that *receives* the block is not
the turn that *requested* it, so `stage-prompt.mjs`'s `recalled` array has to be written
against the receiving `prompt_id`, not the requesting one. That is the real work in this item.

**Do this before raising the timeout again.** If async recall works, the budget stops being a
tuning parameter users have to discover.

**Also worth knowing:** `asyncRewake` is the sharper variant — exit 2 wakes Claude with the
hook's message as a system reminder. That is a better fit for a long-running `reflect()` than
for recall.

---

## 7 — Then `PreToolUse`, warnings first

**This is what turns a Mubit `rule` into something that actually stops a command.**

Mubit's memory model defines `rule` as *"hard constraints that must always apply"*, always
injected, never competing on relevance. In Claude Code today that lands as prose in a recall
block, which the model may or may not honour. The guardrails-from-failures pattern — Tier 1
explicit rules, Tier 2 attributed failures, Tier 3 automatic distillation — currently has no
enforcement rung at all on this integration.

`PreToolUse` returns `permissionDecision: "deny"` with a `permissionDecisionReason`, and the
reason is shown to the model. A rule distilled from a production failure could stop the command
that caused it.

**Why it is last.** A false deny is far more expensive than a missed one: it interrupts work,
it is confusing, and it will be blamed on the plugin rather than on the lesson. Everything
above is either a correctness fix or a token saving; this one changes what the plugin is
allowed to do to the user's session. It needs the confidence signals to be trustworthy first,
and item 4 is part of making them trustworthy.

**Sequence it:**

1. `additionalContext` only — surface the matching rule, deny nothing. Measure how often it
   fires and whether it fires on the right things.
2. Deny only on `rule` entries (not `lesson`), non-stale, above a `knowledge_confidence` floor,
   and only where `verified_in_production` is set.
3. Reconsider.

**Keep it cheap** with the `if` field, so the hook only spawns where a rule could plausibly
apply: `Bash(rm *)`, `Bash(git push *)`, `Edit(**/migrations/**)`. Without it this is a process
spawn on every tool call in the session.

**Two cautions from the docs, both load-bearing:**

- `if` is best-effort and **fails open** when a Bash command cannot be parsed, and the
  reference says outright: *"use the permission system rather than a hook to enforce a hard
  allow or deny."* This is a memory-informed guardrail, not a security boundary. Say so in the
  user guide.
- A timed-out `PreToolUse` command hook **does not block the call** — it continues through the
  normal permission flow. So a slow Mubit fails open too, which is the right default here but
  should be deliberate rather than discovered.

---

## Not in scope, but adjacent

Recorded so they are not re-derived later. Reasoning in §04 of the memo.

- **`TaskCreated` / `TaskCompleted` → `record_step_outcome()`.** `/v2/control/step_outcome` and
  the `step_outcome` entry type are documented process-reward primitives with no Claude Code
  surface whatsoever, and Claude Code raises an event on both ends of a task. One-to-one
  mapping. This is the largest *unbuilt* capability in the list; it is out of this handoff only
  because it is a feature rather than a fix.
- **`Notification`, matcher `idle_prompt`** → Mubit's sleep-time consolidation, triggered by
  the harness's own idle signal, costing nothing anyone waits for.
- **`CwdChanged` / `DirectoryAdded`.** `per-directory` is the default run strategy and the run
  id is derived once — at SessionStart for hooks, at module scope for the MCP launcher. A `cd`
  into another repo mid-session keeps writing the first repo's run. `CwdChanged` has access to
  `CLAUDE_ENV_FILE`, so it can republish the derived id for subsequent Bash commands.
- **`PostToolBatch`.** One hook process per resolved batch instead of one per tool call — lower
  overhead than the current `PostToolUse` spool, and the natural place to poll
  `get_run_signal()` for `is_looping` / `is_stuck`.
- **`SessionStart` `reloadSkills` + `watchPaths`.** The most direct Mubit-pattern-to-harness-
  feature match in the whole surface: Mubit induces `workflow` entries from credited traces and
  serves them via `get_skills(format="anthropic")`; `reloadSkills` re-scans the skill directory
  after SessionStart hooks finish, so a workflow learned last week becomes a live skill this
  session.
- **MCP tool profiles rather than a wider default.** `default` (today's ten), `multi-agent`
  (+ `handoff`, `feedback`, `register_agent`, `step_outcome`), `ops` (+ `memory_health`,
  `strategies`). Blocked on the read side: the lessons route cannot currently see
  agent-authored lessons, so there is no way to observe what an agent wrote through MCP.

---

## What was measured and what was not

**Measured** — on `exp/hooks-vs-mcp`, reproducible with `node scripts/measure-mcp-live.mjs`:
the three MCP surface sizes, by booting the real server over stdio against a `.invalid`
endpoint; and the absence of `instructions` from the `initialize` response.

**Read from source at `af866e8`:** the matchers in `hooks/hooks.json`, the 1,500-token default
in `lib/assemble.mjs:107` and `lib/config.mjs:337`, the absence of cross-turn dedupe in
`hooks/src/prompt-recall.mjs`, the turn-file contract between `stage-prompt.mjs` and
`lib/outcome.mjs:170`, and the subagent attribution path at `hooks/src/capture.mjs:345`.

**Read from the raw Claude Code hooks reference** rather than a summary — which mattered, see
the note under item 5.

**Not verified.** No live Mubit endpoint was used, so the per-prompt injection figures are the
configured ceiling plus the runbook's earlier measurements, not a fresh run. None of the seven
items was prototyped. The `fork` regression is read off the docs and the matcher string and was
not reproduced by forking a session — do that first, it is thirty seconds and it decides
whether item 1 is a bug or a non-issue. The claim that `UserPromptSubmit` never fires for a
subagent follows from the event's definition and the absence of a subagent prompt; it was not
tested directly, and item 5's value depends on it.
