# What to port from Codaph

A feature audit of [mubit-ai/codaph](https://github.com/mubit-ai/codaph) against this plugin,
and the working brief for `feat/codaph-port`.

| | |
| --- | --- |
| codaph | v0.1.18 @ `d06aaf3`, confirmed level with `origin/main` |
| plugin | v0.10.0, base `pre-main` @ `05adfe0`, merged level with `pre-main` at `fca3837` |
| backend | route inventory counted against the control-plane API surface |
| audited | 2026-08-23 · re-verified 2026-08-24 · **wave 2.5 shipped, brief updated 2026-08-25** |

**Status.** Waves 1, 2 and 2.5 are on `feat/codaph-port`. Items 0, 1, 2, 3, 4, 8 and 9 are
built, tested and merged; items 5, 6 and 7 are not. Each shipped item keeps its original text and
carries a **Shipped** note recording what was built and, where they differ, what turned out to
be true instead. Those notes are the more reliable half of this document now: the
recommendation was written from the outside, the note was written from inside the code.

Read [What waves 1 and 2 learned](#what-waves-1-and-2-learned-that-wave-3-needs) before
starting anything below — three of its findings change what Wave 3 should do first.

---

## The short version

Codaph is a ~20k-line CLI and TUI that captures agent activity from Claude Code, Codex and
Gemini into Mubit. Its interesting half is not the TUI — it is that codaph exercises most of
the Mubit control plane, while this plugin, which is far more polished per feature, called
eleven endpoints and stopped. It now calls twenty-one.

| | | at audit | now |
| ---: | --- | ---: | ---: |
| **79** | control routes the backend exposes | 79 | 79 |
| **21** | tools registered in the MCP server we already vendor and ship | 21 | 21 |
| | tools a blank `mcpTools` exposes | 10 | **13** |
| | routes the plugin's own HTTP layer calls | 11 | **21** |
| | skills shipped, per host | 7 | **13** |

Counted at `05adfe0` and at the merged tip. Not all of the growth is these waves: the dashboard
arrived from `pre-main` and brought `archive`, `lessons/delete` and `runs` with it. Waves 1 and 2
added `activity`, `activity/export`, `memory_health` and the four `variables/*`.

Three things fell out of the audit. Two are now done:

1. ~~**The cheapest remaining win is knowing who the user is.**~~ **Done** (item 1). Attribution
   rides in `metadata_json.actor`, not in `user_id` — see the correction on item 1 for why that
   distinction was the whole of the work.
2. ~~**Eleven of our twenty-one MCP tools are switched off.**~~ **Done** (item 3).
   `mubit_strategies`, `mubit_checkpoint` and `mubit_memory_health` are allowlisted and each has
   a skill; eight remain off, deliberately.
3. **The biggest single change is transcript backfill**, and it is gated on a redaction gap
   confirmed live against `lib/redact.mjs`. Do not ship one without the other. **Still true, and
   the gap is not what this document said it was** — see item 5.

And one thing has fallen out since, which is larger than anything left on the list:

4. ~~**Recall currently returns nothing at all.**~~ **Done** (item 0), in the same commit that
   wrote this brief — which is why the original text below still reads as open. The fix is a
   request-body field, but *when* to send it turned out to be the whole of the design, and the
   answer is a budget rule rather than a constant. See the Shipped note on item 0.

---

## Prior art in this repo — read this before starting

The audit was originally written against `pre-main` alone, which understated what exists. Two
of its top recommendations are **already built on unmerged branches** and must not be
reimplemented here.

### `plugin-scope-fix` @ `67c02d7` — linked runs, effectively done

Tip of a chain: `feat/link-run-routes` → `feat/link-command` → `feat/subagent-link` →
`feat/link-offer` → `plugin-scope-fix`. Roughly 8,500 lines against `pre-main`, including:

- `lib/links.mjs` (new, ~395 lines) — the link routes and a ledger of the joins we decided
- `skills/link/SKILL.md` — `/mubit-memory:link`, addressed by directory
- subagents linking themselves to the parent run (`hooks/src/subagent-start.mjs`)
- an offer to link when a second repo shares a git remote, with the remote cached per session
- the link graph read on recall and on reflect
- ~1,400 lines of tests across `test/link.test.mjs`, `test/links.test.mjs`, `test/runid.test.mjs`

On `pre-main` none of this exists: `runs/link` is never called and `include_linked_runs` is
hardcoded `false` in `hooks/src/session-end.mjs`. **Landing that line is a merge decision, not
a build.**

> **Correction (2026-08-24).** This paragraph originally ended *"everything below assumes it
> lands"*. It has not landed, and not as one piece: PR #11 (`plugin-scope-fix` → `pre-main`) was
> **closed, not merged**, on 2026-08-23 — *"this should not have been opened as one branch-wide PR.
> The work stays on `plugin-scope-fix`; specific fixes will be carved out into their own PRs when
> asked for."* The branch remains the place to read the link work before building anything
> scope-shaped, but nothing below may assume it is merged. Wave 1 was built without it: neither
> item depended on it technically, and the ordering was a preference rather than a constraint.

### What that supersedes

The original audit recommended changing the run id to a stable `owner/repo` identity, the way
codaph derives `codaph:<owner/repo>` from `git config --get remote.origin.url`. **Do not do
this.** The scope line answers the same fragmentation problem — one repo across worktrees,
machines and contributors becoming several unrelated memories — by *linking* runs rather than
re-identifying them, which is the better answer: it joins the runs you meant to join and leaves
unrelated projects alone, where a wider identity leaks between them. The git remote is already
read on that branch, as a link signal rather than as identity.

What survives from that recommendation is the **actor** half, which no branch addresses —
verified, zero hits for actor detection across `lib/` on the whole scope line.

---

## Ranked recommendations

Ordered by impact per unit of effort with dependencies respected, so the list is also a build
order. Day figures assume one engineer already fluent in the plugin, and include tests plus a
skill where the feature needs a user-facing surface. **These are estimates, not commitments.**

### 0. Make recall answer at all — SHIPPED (wave 2.5, `144eab7`)

**Impact: critical · Effort: XS · under a day · NOT FROM CODAPH — found while building wave 2**

This is not a port. It is a defect, it outranks everything below it, and it was invisible from
outside the code because health stays green while it happens.

Rung-1 recall aborts at its 1500 ms budget on **every** prompt, against both the hosted instance
and a local debug build. Read off three run markers in the plugin's own data dir on 2026-08-24:

| run | `state` | `recall.ms` | sources | `dry_streak` |
| --- | --- | ---: | ---: | ---: |
| `cc-codaph-port-b8d331fe-c1` | `not_responding` | 1504 | 0 | 10 |
| `cc-pre-main-af449e06-c1` | `ready` | 1505 | 0 | 18 |
| `cc-pre-main-af449e06` | `not_responding` | 1508 | 0 | 11 |

`last_error: POST /v2/control/query: aborted after 1473ms`. The `ms` pinned at the budget in all
three is the signature of an abort rather than a slow success. That is ~39 consecutive prompts
across three runs with nothing injected — the plugin's primary surface, returning nothing, while
two of the three markers were being written by the sessions that built waves 1 and 2.

**Cause.** The query handler runs a cross-run lesson lane with no run filter. It is entered
whenever `entry_types` contains `"lesson"` — which `lib/recall.mjs:92`'s frozen `ENTRY_TYPES`
always does — and it is a full pass over the whole instance index, which additionally falls back
to listing up to 10 000 entries when it surfaces nothing. Measured: 2.05 s mean, against 0.25 s
with `prefer_current_run: true`. Nothing else in the request moves the number — `limit`, entry
type count, query length and a nonexistent run id all cost the same.

The cost scales with **the instance's** corpus rather than yours, which is why the same request
measured 378 ms on 2026-08-19 and ~2.0 s five days later with no plugin change.

**Fix.** `prefer_current_run: true` on the blocking rung-1 body in `lib/recall.mjs`, with the
wider lesson search moved to `recall-refresh` or session start. Confirmed reachable: the vendored
client passes it straight through on the `/query` body beside `rank_by` and `env_tags`, so this
is a request-body change and not a server one.

- **Do not "fix" this by raising `recallBudgetMs`.** The harness stop is
  `min(budget + 400, 2800)` under a 3 s `UserPromptSubmit` timeout, so the dial cannot reach the
  2.05 s it would need. Raising it only helps *manual* end-to-end runs, where it is required —
  set `MUBIT_CC_RECALL_BUDGET_MS=8000` or nothing exercises the injection path.
- **`MUBIT_CC_RECALL_ASYNC=1` sidesteps it today** — detached refresh, 10 s budget, one turn of
  staleness — which is a workaround, not the fix.
- **Do not re-diagnose this as the policy dial.** Check `policy/` is empty and `routing_summary`
  reads `direct_bypass:evidence_only` first: rung 1 is granted and working, just slow.
- **It compounds with run-scoped lessons**: entries stored at `scope: "run"` are discarded by the
  lane *after* it has paid for them, and that empty result is what triggers the 10 000-entry
  fallback.

> **Shipped (2026-08-24) in `144eab7`, alongside this brief** — which is why every paragraph
> above still reads as open. Built as `recallCrossRun` (`auto | on | off`,
> `MUBIT_CC_RECALL_CROSS_RUN`) rather than the unconditional field the item proposed.
>
> **`auto` is a property of the path, not of the installation.** It reads the budget the caller
> already arrived with against `CROSS_RUN_MIN_BUDGET_MS`: a hook that must answer before the
> user's prompt goes out declines the lane, the detached refresh behind it takes it, and neither
> needed to be told which one it is. Pinning it to a constant would have forced a second dial
> nobody would find. `on` and `off` remain as pins.
>
> **The recommendation's "where the wider lesson search moves to" was the wrong question.** It
> does not move: `session-start` was *already* fetching global-scope lessons on their own route,
> once per session, and that is where standing lessons were arriving from all along — see
> *Cross-run lessons arrive by two paths* below. Declining the per-prompt overlay costs the
> per-prompt refresh of cross-run lessons, not cross-run memory.
>
> **Correction (2026-08-25) to the numbers in this item.** The `2.05 s mean` / `0.25 s` figures
> were taken against a hosted instance in one session and are not reproducible from a clean
> checkout, so they have been removed from shipped source and from the README — a request-level
> latency breakdown of the backend does not belong in a public repo, and the scanner's
> `server-latency-profile` rule now clears. They are left in *this* paragraph as dated history,
> stated as what one measurement showed rather than as a property of the service. What survives
> re-measurement is only the **shape**: the cross-run half of a recall is not bounded by a run
> id, so it grows with the store rather than with your session, and it costs the same whether it
> finds a lesson or finds nothing.

---

### 1. An actor id we never have to ask for — SHIPPED (wave 1, PR #18)

**Impact: high · Effort: S · 1–2 days · landed in `11cf870`, `lib/actor.mjs`**

Codaph's `detectGitHubActorId()` falls through `gh api user --jq .login` → `github.user` →
`user.name` → email local-part → `$USER`. We have a `userId` config field that defaults to
empty, and nothing that fills it.

Without it the store cannot attribute a lesson to a person, which is the join key every
collaborative feature needs — and it is the one identity question the scope work leaves open.

- **Lands in** actor detection beside `envTags()` in `lib/config.mjs`
- **Watch** a `gh api user` spawn per hook is not affordable; resolve once and cache to the
  plugin data dir, the way `plugin-scope-fix` caches the git remote per session
- **Note** `userId` already reaches the wire in `capture.mjs`, `drain.mjs`, `checkpoint.mjs`
  and `session-end.mjs`

> **Correction (2026-08-24) — do not fill `userId`.** The note above read *"this fills an existing
> field rather than adding one"*. Filling it would have broken recall. On the wire, `user_id` is a
> **retrieval scope**, not an attribution tag: an entry ingested under one is only returned to a
> query carrying the same one, and a query that omits it does not opt out — the server supplies a
> default scope of its own. `lib/recall.mjs` never sends `user_id`, so every recall runs under that
> default, and stamping a detected login into `user_id` on ingest would make every newly captured
> entry **silently invisible to recall**. Codaph gets away with it only because it sends the same
> value on both sides. Attribution therefore rides in `metadata_json.actor` on every ingest item,
> and `cfg.userId` keeps its current meaning and its empty default.
>
> Confirmed against a live instance: entries captured after Wave 1 come back carrying
> `metadata_json.actor`, alongside the server's own default `user_id` — the same default that sits
> on entries written years before this change, which is exactly why they are all still reachable.

### 2. Freshness-aware recall ranking — SHIPPED (wave 1, PR #19)

**Impact: high · Effort: S · 1–2 days · landed in `cc2575c`, `lib/rank.mjs`**

Codaph takes `--rank-by relevance|balanced|freshness` on every query, and its docs are explicit
that freshness is for "current state", "what changed recently", and handoff-shaped questions.

`rank_by` appears nowhere in this plugin — verified, zero hits across `lib/` and `hooks/src/`.
Every recall is relevance-ranked. The injected block is the plugin's primary surface and its
largest recurring context cost, and relevance-only ranking answers *where were we?* with
whatever is most similar rather than most recent. That is precisely how a superseded lesson gets
injected ahead of the lesson that replaced it.

- **Lands in** a pass-through in `lib/recall.mjs`, one config default, and one rule in
  `lib/rank.mjs` — so the switch is automatic rather than a setting nobody finds

> **Correction (2026-08-24).** This originally put the rule in `lib/classify.mjs`, *"which already
> classifies prompts"*. It does not. `classify.mjs` classifies **tool names and turn events** off a
> static lookup table, and `classifyTurn(prompt, …)` (`lib/classify.mjs:175-192`) takes a `prompt`
> argument it never reads. The rule has to live where prompt text actually is.
- **Check first** the v0.13.3 backend changes to lesson decay and recall ranking postdate the
  measurements this recommendation was reasoned from; re-measure before tuning

### 3. Switch on the tools we already ship — SHIPPED (wave 2, PR #20)

**Impact: medium-high · Effort: S · 2–3 days · allowlist 10 → 13**

`mcp/dist/server.js` registers 21 tools. `DEFAULT_ALLOWLIST` in `mcp/src/launch.mjs` exposes 10.
The exclusions are deliberate and mostly correct — a hook does the job better. Three are worth
promoting anyway, because codaph demonstrates what they are for:

| Tool | Route | What codaph does with it |
| --- | --- | --- |
| `mubit_strategies` | `/v2/control/strategies` | a retrieval lane we never touch, holding reusable strategies as distinct from lessons |
| `mubit_checkpoint` | `/v2/control/checkpoint` | `codaph checkpoint "before-auth-refactor"` — a user-named marker before risky work, where we only checkpoint automatically at PreCompact |
| `mubit_memory_health` | `/v2/control/memory_health` | what our own doctor skill tells the reader to `POST` by hand at step 3 |

Highest ratio of user-visible capability to engineering on the list: the server code is written,
vendored and tested. What is missing is an allowlist entry and a skill that makes each reachable.

- **Lands in** `DEFAULT_ALLOWLIST` in `mcp/src/launch.mjs` and the matching list in
  `lib/config.mjs`, plus one skill each
- **Note** allowlisting alone is nearly free; the effort is the UX, without which they stay invisible

> **Shipped (2026-08-24).** All three promoted, each with a skill on both hosts
> (`strategies`, `checkpoint`, `memory-health`), and `skills/doctor` step 3 rewritten to call
> `mubit_memory_health` rather than describe a `POST`.
>
> **The ten-item list lived in nine places, not the two named above.** Besides
> `mcp/src/launch.mjs` and `lib/config.mjs`: `scripts/verify-manifests.mjs`,
> `scripts/measure-context-cost.mjs`, `test/manifests.test.mjs`, `test/launch.test.mjs`,
> `test/mcp-surface.test.mjs`, `integrations/codex/test/codex-mcp.test.mjs`, and the generated
> `bin/impl/statusline.mjs`. The measure script's copy was the dangerous one: left stale it
> would have stamped `curatedValue` against the old ten and reported the surface as unhonoured.
>
> **A promoted tool cannot go green on a source-only commit.** `test/mcp-surface.test.mjs` and
> `codex-mcp.test.mjs` drive a real stdio `tools/list` against the *committed* `mcp/dist/index.js`,
> so the contract test stays red until the bundles are rebuilt. That is a property of the gate,
> not a defect, and it is why the wave rebuilt once at the end.
>
> No server change was needed: the vendored `mcp/dist/server.js` already honours
> `MUBIT_MCP_TOOLS`, and its md5 is unchanged at `8295edfe6ca4207f603712db95552e39`.

### 4. A resume block at session start — SHIPPED (wave 2, PR #22), on the wrong endpoint

**Impact: high · Effort: M · 4–5 days · `lib/resume.mjs`, `hooks/src/session-resume.mjs`**

`codaph mubit context "what should the next agent know?"` builds a structured block for handoff,
with `sections`, `entry_types`, `include_working_memory` and `max_token_budget`.
It also generates a per-session summary for its browse view.

> **Correction (2026-08-24).** An earlier draft of this section listed `lane_filter` among those
> fields. It is not one: `lane_filter` belongs to `/query`, and `/context` does not accept it.
> Read it off the vendored client, where the only occurrence of the field sits in the `/query`
> call and the `/context` one does not carry it. `/context` accepts no ranking field either,
> which is why the shipped implementation sends no `rank_by` and cannot use `lib/rank.mjs`'s
> `where_were_we` rule on this path.

We already call `/v2/control/context`, but only as the `recallAssemble: server` variant of
per-prompt recall. SessionStart injects recalled memory; it does not inject *here is where you
left off*. Resuming is the thing people actually want from memory, and we own every piece — the
endpoint, the hook, the token budget machinery, the seen-set. Today the first prompt of a session
gets relevance matches against a prompt the user has not written yet.

- **Watch** SessionStart is a 5s-timeout hook; this must fit inside it or ride the existing async path

> **Shipped (2026-08-24), and the open question in it was answered badly.** SessionStart spawns
> a detached `session-resume` child; the first *substantive* prompt renders the block as
> `<mubit-resume>` above `<mubit-memory>`. It is the one feature on this list that ships **on by
> default**, because its cost is per session rather than per prompt. It fits the 5 s hook by not
> being in it: nothing waits on the child.
>
> **`/v2/control/context` is the wrong endpoint for a resume question, measured rather than
> assumed.** `GetContext` does not order evidence by retrieval score at all. It re-sorts into a
> fixed section hierarchy — `mental_models`, `active_rules`, `lessons`, …, `working_memory`
> (9th), `traces` (10th) — with importance second and the fused score only a third-order
> tiebreak, then spends `max_token_budget` top-down. **The two sections a resume question is
> actually about are the last to be paid for.** Live against `api.mubit.ai`: a 1000-token budget
> went to 4 lessons and 2 traces with `working_memory` rendering nothing. Narrowing `sections`
> to `working_memory,traces` is worse — a `trace` is a captured tool call, so the block became
> 553 tokens of one raw shell script.
>
> Two more facts off the same endpoint, both contradicting the proto: `limit` is **not**
> per-section — it is the total on one internal query, and overlay lanes add up to 12 sources
> *outside* it, so `limit: 12` can return 24. And `/context` is *mostly*, not strictly,
> run-scoped: lessons reach across runs three ways, so under `runStrategy: per-conversation` the
> block is thinner rather than empty.
>
> **Left as an open decision, not silently fixed** — see *Open decisions* below. The swap is
> contained on purpose: `resumeContext()` is one small function with one caller, and
> `fromContext()` is the shared response parser, so the whole path can be replaced without
> touching the renderer.

### 5. Backfill from the transcripts already on disk

**Impact: high · Effort: M–L · 8–12 days · GATED**

`codaph import` walks `~/.claude/projects/**.jsonl`, matches sessions to the project root *and
its linked git worktrees*, holds per-file cursors (`lineCount`, `sequence`, `sizeBytes`,
`mtimeMs`), extracts prompts, assistant text and reasoning, and tool-result file changes, and
dedupes on `eventId` through its ingest pipeline.

We are hooks-only. A fresh install knows nothing that happened before it, and a hook that times
out or is dropped loses that turn permanently.

This is the biggest available change to first-run experience: install and immediately have months
of history, instead of an empty store that looks broken — the README spends its entire first
section explaining that the plugin looks broken before its first session. It doubles as the repair
path for hook gaps. And the parser is half-written: `hooks/src/checkpoint.mjs` already reads
`transcript_path` and parses that same JSONL, just only the last 200 KB of one file.

> **Gate: the redactor was fixed first.** Bulk import multiplies whatever capture leaks by
> every transcript on the machine, so this item was held until `lib/redact.mjs` covered the
> two shapes a pasted `.env` block is made of. It does now, and `test/redact.test.mjs` holds
> the cases. Re-probe before starting: this gate is about the redactor as it is on the day
> the importer lands, not as it was when the item was written.

- **Also needs** ingest rate limiting, idempotency keys, progress reporting, a
  `/mubit-memory:import` skill

### 6. A structured file-change lane

**Impact: high · Effort: M · 5–7 days**

Codaph's `diff-engine.ts` collects `file_change` events into per-path summaries carrying
`add|delete|update` kinds and occurrence counts, read back by `codaph diff --session` and the
`codaph_diff_summary` tool.

`hooks/src/capture.mjs` records episodes as text — `Write(file_path=…) -> …`. The paths are in
there, as prose. Structuring them adds a retrieval axis we cannot serve at all today (*what
changed in auth?*) and, more useful turn to turn, lets recall filter by the files actually in
play. The tool parameters are already parsed by the capture hook; this is structuring something we
currently flatten, not new capture.

- **Read `capture.mjs` fresh before planning this.** It was restructured for the second host in
  `646162c` and again at the wave-2 merge: `item()` now builds `metadata_json` through
  `withModel` and `withActor`, and Codex events arrive via `firstUserText` / `toolCallRecord`
  from `lib/codex-rollout.mjs`. Any file-change lane has to be built for both hosts at once —
  `PATH_KEYS` is shared, the rollout parser is not.
- **This is the natural home for the redactor fix's second half.** A structured `file_change`
  record carries paths rather than prose, so it is also the place where a path that is itself
  a secret (a `.env`, a key file) can be denylisted once instead of pattern-matched forever.

### 7. A handoff lane for subagents and teammates

**Impact: medium-high · Effort: M · 5–7 days · needs the scope line landed**

Codaph has `handoff send --task --from --to --action`, `handoff list`, and
`handoff feedback --verdict approve` over `/v2/control/handoff` and `/v2/control/feedback`.

We register agents and heartbeat them (`/v2/control/agents/register`, `/agents/heartbeat`) and
then never use the relationship. A subagent starts with a 600-token recall block and nothing
about what the parent actually wanted.

Claude Code is multi-agent now — subagents, forks, cloud sessions, teammates on one repo. We
already run SubagentStart and SubagentStop hooks, and a handoff is the payload they should be
carrying. `mubit_handoff` is already in the shipped server, so this is wiring and UX rather than
new protocol. It composes with `feat/subagent-link`, which already links a subagent to its parent
run — the link is the edge, the handoff is what travels along it.

- **Still blocked on the same thing, and it has not moved.** `plugin-scope-fix` remains
  unmerged; PR #11 was closed, not merged. Nothing in waves 1 or 2 changed that. This is the
  only remaining item with a hard dependency on a branch, and the dependency is a merge
  decision rather than a build — see *Prior art*.
- **`mubit_handoff` is one of the eight tools still off the allowlist.** Wave 2 promoted three
  of eleven and left it deliberately: a tool with no surface is schema cost in every session.
  Promoting it is part of this item, not a prerequisite to it — and item 3's Shipped note lists
  the nine places the allowlist is restated.
- **Subagents get no pins today**, which is the closest thing the plugin now has to a handoff
  payload and the obvious first increment: `lib/pins.mjs` is run-scoped, and a subagent has its
  own run id.

### 8. Activity and export, for the audit question — SHIPPED (wave 2, PR #21)

**Impact: medium · Effort: S · 2–3 days · `lib/activity.mjs`, `bin/activity.mjs`, one skill**

`codaph mubit activity --limit 20 --exclude-derived --projection compact` and
`mubit export --format jsonl`, over `/v2/control/activity` and `/activity/export`.

Two audiences, both unserved: support, who need to see what actually landed rather than what we
believe landed; and anyone answering a procurement or compliance question about what left the
machine. Cheap, and it makes the redaction story demonstrable instead of assertable.

> **Correction (2026-08-24).** This item originally read *"we call neither"*. Half of that is now
> wrong. `pre-main` shipped `lib/dashboard-api.mjs`, whose `fetchActivity()` calls
> `/v2/control/activity` — but only from `createdAtIndex`, to join a `created_at` onto entries the
> dashboard already holds. So the route is reached and the capability is not: `/activity/export`
> is called from nowhere, `exclude_derived`, `projection`, `created_after`, `created_before`,
> `user_id` and `agent_id` are sent by nothing, there is no pagination past the first page, and
> the dashboard's three tabs are Memory / Turns / Analytics — no activity tab, and no surface at
> all outside a browser. The remaining work is therefore **export, the request fields, and
> reachability**, not a first call. `scripts/mubit-inspect.mjs` is still absent from the package
> `files` list and stays that way: it carries untested copies of what `lib/dashboard-data.mjs`
> now owns, and it answers the *local* question the Turns tab already ships.

- **Watch** activity needs a longer deadline than the 4000 ms hook budget; non-hook callers must
  pass their own. The lesson join needs `entry_types: ["lesson"]` or it matches nothing.

> **Shipped (2026-08-24).** `lib/activity.mjs` (listing, export, pagination, derived detection,
> compact projection), `bin/activity.mjs`, and a `disable-model-invocation: true` skill on both
> hosts. Prints JSONL to stdout; `--out` is opt-in and refuses to overwrite, refuses any path
> inside the plugin data dir, and warns when the target is inside a git tree and not ignored.
>
> **`/v2/control/activity/export` accepts seven fields and silently drops the rest.**
> `ExportActivityRequest` is `run_id`, `user_id`, `agent_id`, `entry_types`, `created_after`,
> `created_before`, `sort` — no `limit`, no `page_token`, no `exclude_derived`, no `projection`.
> Serde discards unknown keys without erroring, so sending `exclude_derived` is not a failed
> filter, it is **a client believing it filtered**. Run scope is therefore the only bound on a
> response body `dial()` reads and parses in one allocation, which is why a run id is required
> and `--all-runs --export` exits 2.
>
> **The listing is distrusted; the export is not**, and the asymmetry is forced by that wire
> shape rather than chosen. `exclude_derived` and `projection` are re-applied client-side and
> any disagreement is reported (`excludeDerivedFallbackUsed`, `projectionFallbackUsed`), because
> printing an unhonoured filter under an `--exclude-derived` heading manufactures the exact false
> audit artefact this item exists to remove. The export's `content` is written **verbatim** —
> a compliance record the client reshaped is not a record of what the server holds.
>
> **The server's own `exclude_derived` is narrower than advertised**: it tests `promotion` and
> `derived` through `as_bool()`, which misses `auto_promoted` — what recurrence promotion
> actually writes — plus `promoted`, stringified booleans, and a double-encoded `metadata_json`.
> The client filter deliberately catches all seven spellings: over-filtering is visible,
> under-filtering is not.
>
> **`total_visible` is a filtered count, not a total** — entries left after the server's filters
> and before paging, out of a pool itself capped while collecting. It over-counts by exactly what
> the client re-filter dropped, which is why `droppedDerived` is printed beside it.
>
> Listing sorts `desc`, scans sort `asc`: pagination is offset-style, so under `desc` a write
> arriving mid-scan shifts every offset and rows are re-read or missed.

### 9. Run variables as pinned context — SHIPPED (wave 2, PR #23)

**Impact: medium · Effort: S · 2 days · `lib/variables.mjs`, `lib/pins.mjs`, `bin/pin.mjs`**

Codaph uses `variables/set|get|list|delete` plus a `mirrorRunState` automation toggle. We call
none of them.

A small, cheap slot for things that should sit in front of the model every turn without paying a
retrieval round trip — the current task, a standing constraint, "don't touch the vendored server".
Today the only way to make something reliably present is to hope recall ranks it, which is exactly
the failure mode a pinned slot removes.

> **Shipped (2026-08-24).** Five pins per run, 200 chars each, 240 rendered tokens, namespaced
> `cc.pin.<slug>` — one variable per pin rather than codaph's single `run_state` blob, because a
> blob is read-modify-write and two terminals in one directory share a run under the default
> `per-directory` strategy, so a concurrent pin is lost silently.
>
> **The hot path never dials.** `readPins()` is one `readJson`; the network half runs in the
> detached drain tail beside `resolveActor`. That is what lets a pin render inside a 1500 ms
> recall budget and, more to the point, **while the breaker is open** — which is where a standing
> constraint matters most. Pins render wherever recall does not: `recall: false`, a sub-8-character
> prompt, an open breaker, a failed recall, an empty result. The TTL decides when a *refresh* is
> due, never whether pins render: a stale pin is still a pin.
>
> **There is no variables MCP tool.** The vendored server registers 21 tools and none touches
> variables, and `mcp/dist/server.js` cannot be rebuilt in this checkout — so the surface is a
> skill plus a `bin/` script, the `auth`/`dashboard` pattern, and not an allowlist entry.
>
> **`variables/list` returns `value_json` inline**, so the refresh is one round trip rather than
> N+1 and the 5-pin cap is about context spend, not latency. **`source: 'user'` is not a valid
> enum value** — the five are `system | reasoning | retrieval | perception | explicit`, matched
> exactly with a **silent** fallback to `Explicit`, so a plausible `"user"` would be accepted and
> mean something else. `value_json` must be valid JSON or the route 400s.
>
> **One real bug found on the way in, and it is not scoped to this feature.** `recordSuccess`
> clears the connection state for the **whole endpoint**: a successful `variables/list` in the
> drain tail, moments after a 500 on `/v2/control/ingest`, whitewashed `server_error` back to
> `ready`. The refresh is now gated on the breaker reading `ready`, which fixes this caller. The
> general case is still open — see *Open decisions*.
---

## The matrix

| # | Feature | Impact | Effort | Days | Depends on | Status |
| --- | --- | --- | --- | --- | --- | --- |
| — | *`plugin-scope-fix`* | *high* | *unmerged* | — | — | *PR #11 closed — see Prior art* |
| 0 | Recall answers at all | ●●● | XS | <1 | — | ✅ wave 2.5, `144eab7` |
| 1 | Actor id | ●●● | S | 1–2 | — | ✅ wave 1, PR #18 |
| 2 | Freshness ranking | ●●● | S | 1–2 | — | ✅ wave 1, PR #19 |
| 3 | Dormant MCP tools | ●●○ | S | 2–3 | — | ✅ wave 2, PR #20 |
| 4 | Session resume block | ●●● | M | 4–5 | — | ✅ wave 2, PR #22 — endpoint under review |
| 5 | Transcript backfill | ●●● | M–L | 8–12 | redactor fix | open — **wave 3** |
| 6 | File-change lane | ●●● | M | 5–7 | — | open — **wave 3** |
| 7 | Handoff lane | ●●○ | M | 5–7 | scope line | open — **wave 3**, still blocked |
| 8 | Activity + export | ●●○ | S | 2–3 | — | ✅ wave 2, PR #21 |
| 9 | Run variables | ●●○ | S | 2 | — | ✅ wave 2, PR #23 |
| 10 | Local JSONL mirror + browse | ●●○ | L | 12–18 | — | second shelf |
| 11 | Git post-commit anchor | ●○○ | S–M | 3–5 | — | second shelf |
| 12 | Project registry / team view | ●●○ | L | 15+ | actor id | second shelf |

Seven of ten shipped. What is left is the expensive half, and it is the half the estimates are
least trustworthy about: items 0–4, 8 and 9 all came in near their figures, but every one of them
was *exposure* of something already vendored. Items 5, 6 and 7 are the first that build something
the backend does not already do for us.

**On the second shelf.** The **local mirror** is codaph's most substantial engineering —
append-only JSONL, a manifest, sparse indexes by session, thread and actor, and an `eventId`
index — and it buys an offline read model, a deterministic timeline, and a recall fallback for
when the endpoint is slower than our budget. It also introduces disk growth, a `.gitignore`
question, and a second source of truth to keep consistent, which is why it sits below cheaper
things. The **post-commit anchor** would tie lessons to commit SHAs, but writing into a user's
`.git/hooks` is invasive in a way our install never is. The **project registry** is 14 backend
routes we have no concept for at all; it is the right home for a team view.

---

## Sequencing

**Wave 1 — identity and ranking (~1 week). ✅ Done.** Items 1 and 2, PRs #18 and #19.
`plugin-scope-fix` was originally sequenced ahead of them; PR #11 closed unmerged and neither item
depended on it, so Wave 1 skipped it — see *Prior art*.

**Wave 2 — surface (~2 weeks). ✅ Done.** Items 3, 4, 8, 9 — PRs #20, #21, #22, #23, merged into
`feat/codaph-port` with one integration commit for the bundles. Four branches built in parallel,
one worktree each. Landed at 1410/1410 tests on the Claude Code plugin and 360/360 on Codex.

Two process notes worth reusing, both learned the expensive way:

- **Rebuild once, at the end of the wave, not per branch.** Every hook entrypoint inlines the
  whole of `lib/`, so four branches regenerating eleven bundles each conflict across thousands of
  generated lines to produce a file none of them disagreed about. The cost is that
  `test/dist-freshness` and the live `tools/list` are red on every feature branch by design; the
  integration commit is what makes them green, and that is the only real proof the rebuild landed.
- **The Codex plugin inlines `../claude-code/lib`.** Wave 1's `lib/actor.mjs` and `lib/config.mjs`
  reached it without a single Codex file changing, and `codex-dist.test.mjs` caught it at the
  merge. Any wave that touches `lib/` owes both packages a rebuild.

**Wave 2.5 — before Wave 3 (under a day). ✅ Item 0 done; decision B still open.** This was not
optional in the way the rest of the ordering is a preference: **item 5 imports months of history
into a retrieval path that was returning nothing.** Backfill is justified by what recall does with
the result, so fixing recall first is what makes the wave measurable — otherwise a successful
import and a failed one look identical from the prompt.

> **The client half is done and the store half is not.** Recall now answers inside its budget, but
> what it answers *with* is still bounded by a store that has never had a global-scope lesson in
> it — see *Cross-run memory had nothing to return* below. Wave 3 should not read an empty
> cross-run result as a defect in whatever it just built.

**Wave 3 — capture (~4–5 weeks).** Redactor fix, then 5, 6, 7. The real engineering. The redactor
fix is not optional and comes first: bulk import multiplies whatever the scrubber misses by every
transcript on the machine — and the correction on item 5 means the fix is **two** fixes, in
`scrubAssignments` and in `RULES`, not the one-line anchor change the original text implied.

Suggested order inside the wave, which is not the item order:

1. **Redactor** — both gaps, with the four probe cases from item 5 as the tests. Standalone, and
   the only piece that must land before anything else.
2. **Item 6, the file-change lane.** Cheaper than 5, independent of it, and it produces the
   structured record 5 will want to emit. Building 5 first means writing its output format twice.
   Read `capture.mjs` fresh: it was restructured for the second host after this brief was written.
3. **Item 5, transcript backfill.** The big one. Needs rate limiting, idempotency keys, progress
   reporting and a skill; `hooks/src/checkpoint.mjs` already parses the same JSONL, for one file
   and the last 200 KB of it.
4. **Item 7, the handoff lane** — or drop it from the wave. It is the only item gated on a
   *branch* rather than on work, and that branch has not moved since the audit. Decide the
   `plugin-scope-fix` merge question before committing wave capacity to it.

---

## What waves 1 and 2 learned that Wave 3 needs

Findings that outlived the tickets that produced them. Each was measured against a live instance
or read off the vendored client, and each is stated as observable API behaviour — this repository
is public.

### The backend is slower than the plugin's budgets, in a way health does not show

Item 0 has the numbers. The part Wave 3 needs is the *shape*: `/v2/core/health` answers in
70–420 ms while `/v2/control/query` takes ~2 s, so the connection probe is green throughout.
Any feature that dials on a budget needs its own canary; a green status line is not evidence that
retrieval works. `/v2/control/context` returned **HTTP 504 after ~15 s on two of three real runs**
during wave 2, and `/v2/control/reflect` returned one too.

### `{record: false}` is load-bearing for anything on a loose deadline

`lib/http.mjs` tags an abort `abortedEarly` — and declines to record it — **only** when the
caller's deadline is *tighter* than the 4000 ms default. Every long-deadline caller therefore
records its failures by default, and five inside the breaker window opens the circuit, stopping
recall and the capture drain because a background job was slow. Wave 2 hit this three times
(resume at 20 s, activity at 20 s, export at 45 s) and it will hit every Wave 3 importer.

The abort path is not even the sharp edge: a plain non-2xx is recorded *unconditionally*, so the
504s above would have opened the breaker on their own. Test it by asserting the **absence of a
breaker file**, never the presence of an option — an option passed and silently dropped looks
identical at the call site.

### `recordSuccess` clears connection state for the whole endpoint

A success on any route whitewashes a recorded failure on any other. Observed live: a successful
`variables/list` in the drain tail, moments after a 500 on `/v2/control/ingest`, moved the marker
from `server_error` back to `ready`. One of the three markers in item 0's table shows the same
thing — `state: ready` after 18 consecutive dry prompts.

Wave 2 fixed the caller (`refreshPins` is gated on the breaker reading `ready`) and not the
mechanic. An importer making thousands of successful ingest calls will erase every failure signal
the plugin has, which makes this a Wave 3 prerequisite rather than a curiosity.

### Two request fields that are not what the contract says

- **`limit` on `/context` is not per-section.** It bounds one query's worth of candidates in
  total, and what the route layers on top is not counted against it. Only `max_token_budget`
  bounds the response.
- **`user_id` is a retrieval filter, not a label** (item 1's correction). Still the single most
  expensive mistake available in this codebase: filling it on ingest makes new entries invisible
  to a recall that omits it.

Add to those the enum trap from item 9: `source` accepts five values and falls back to `Explicit`
**silently**, so a plausible-but-wrong value is accepted and means something else.

### Cross-run lessons arrive by two paths, and `recallCrossRun` governs only one

Conflating them misreads what declining the lane costs.

1. **The per-prompt query.** A `/v2/control/query` carrying `lesson` in `entry_types` and no
   `prefer_current_run` comes back with lessons from other runs as well as this one, and costs
   more than the same query with the field set. That difference is the only thing
   `recallCrossRun` governs.
2. **`session-start`** — `POST /v2/control/lessons {scope:"global", limit:5}` with **no
   `run_id`**, once per session at a ~900 ms sub-budget, rendered as *Standing lessons (global)*.
   Independent of `recallCrossRun` entirely.

The trap: `recallCrossRun` defaults to `auto`, `recallAsync` defaults to **`false`**, and
`recall-refresh` is only detached when `recallAsync` is on. So **at stock defaults the per-prompt
overlay is requested on no path at all** — the blocking hook declines it and the refresh never
runs. Path 2 is the only cross-run delivery a default install has. That is a defensible trade,
but it was not written down anywhere, and "cross-run recall is off" and "cross-run memory is off"
are different claims.

Two smaller edges on the same rule: `auto` measures its slack through a helper that clamps to
`timeoutMs` (default 4000) against a 3000 threshold, so `MUBIT_CC_TIMEOUT_MS` below 3000 declines
the lane on **every** path including the refresh; and `on` is only coherent with `recallAsync` on
or with the recall budget raised to fund it.

### Cross-run memory had nothing to return, and that was never a plugin bug

`POST /v2/control/lessons {scope:"global"}` returns an empty list, and has on every instance
measured so far — nothing has ever been promoted to global scope. A server-side change that makes
global scope reachable is **in review, not shipped**.

This matters to Wave 3 in one specific way: **until it lands, every cross-run read returns
nothing regardless of what the client does**, so a Wave 3 feature that depends on cross-run recall
will measure as broken when it is merely unfed. Check the census before drawing a conclusion from
an empty block — and note that item 0's fix is a latency fix, not a supply fix. It made recall
answer; it did not give it more to answer with.

### Where the wire shape forces a design, write the asymmetry down

Item 8's listing is re-filtered client-side and its export is passed through verbatim, and that
looks inconsistent until you know `/activity/export` takes neither field. Wave 3's importer will
have the same problem in reverse — dedupe on `eventId` is a claim about *our* bookkeeping, not
about what the server stored. State which side of each claim is being made, in the module header,
and pin it with a test.

---

## Open decisions

Two open, one settled. None blocking, all cheaper to settle before Wave 3 than during it.

| | Decision | Recommendation |
| --- | --- | --- |
| ~~**A**~~ | ~~**Item 0: `prefer_current_run` on the rung-1 body.**~~ | ✅ **Settled and shipped** in `144eab7`, as `recallCrossRun: auto` rather than an unconditional field. The "where does the wider search move to" question dissolved: it was already on `session-start`'s own route. |
| **D** | **`recallAsync`'s default, now that it also decides whether any request asks for cross-run lessons.** | Decide deliberately. `recallAsync: false` means a default install never asks a per-prompt query for other runs' lessons on any path — the blocking hook declines, and the refresh that would ask is never spawned. That is fine while the store has no global lessons to return, and it stops being fine the moment the server-side promotion fix lands. Revisit it then, not now. |
| **B** | **Item 4: swap the resume block off `/context`.** | Swap it, to `postQuery{mode:'direct_bypass', rank_by:'freshness', entry_types, limit}` assembled client-side. `/context` cannot rank a temporal question and spends the budget on the wrong sections first. The cost is a bulleted list instead of a prose briefing. Note it inherits the same lesson-lane latency as item 0 — tolerably, since it runs detached at 20 s — so **A makes B better** and should land first. |
| **C** | **`plugin-scope-fix`: merge, carve up, or abandon.** | Decide before committing Wave 3 capacity to item 7, which is the only remaining item gated on it. PR #11 was closed with *"specific fixes will be carved out into their own PRs when asked for"*, and nothing has been carved out since. |

Two smaller ones, recorded so they are not rediscovered: **`recordSuccess`'s endpoint-wide
whitewash** (above — fixed for one caller, open in general), and **subagents get no pins**, which
is item 7's cheapest first increment.

---

## Deliberately not taking

- **The TUI, wholesale.** We are already inside a terminal UI and the host is the surface. Take
  the read model behind it if we want item 10; do not take the renderer.
- **OpenAI-assisted query synthesis.** Codaph needs a model to summarize its results because it
  has none. We run inside one — every answer we would synthesize, Claude is better placed to
  write, at no extra key and no extra vendor.
- **The Codex and Gemini importers.** Real work, wrong home. Cross-agent capture belongs in codaph
  or the codex plugin; two more transcript formats in a Claude Code plugin buy our users nothing.
- **The dual-store architecture as a principle.** "Local mirror is the read model, Mubit is the
  write model" is right for a CLI that renders timelines offline. Our recall path is synchronous
  and budgeted per prompt; a second store on it is a latency and consistency problem we do not
  currently have.
- **A stable `owner/repo` run id.** Superseded by the link graph — see *Prior art* above.

---

## Notes for whoever works in this worktree

- **`npm install` does not work in a fresh worktree.** The `file:../mcp` dependency is absent;
  copy `node_modules` from an existing checkout instead. One copy under
  `integrations/claude-code/` serves both packages — the Codex config resolves esbuild through
  its shared sibling.
- **`npm run verify` destroys the vendored server.** Its `clean` step deletes `mcp/dist/server.js`,
  which cannot be rebuilt from this repo. Run the narrower scripts. Build with
  `MUBIT_CC_BUILD_SKIP_SERVER=1 npm run build`, and check the md5 afterwards: it must stay
  `8295edfe6ca4207f603712db95552e39`.
- **There are two packages now, and `lib/` is shared.** `integrations/codex` inlines
  `../claude-code/lib` and bundles the same `mcp/src/launch.mjs`. A change to `lib/` reaches that
  host through a rebuild and nothing else, and `codex-dist.test.mjs` will fail the merge if you
  forget. Every skill ships twice — `codex-skills.test.mjs` asserts a hard `deepEqual` between the
  two skill directories.
- **The skill list is restated in four test files**, not the two you will find first:
  `test/skills.test.mjs`, `integrations/codex/test/codex-skills.test.mjs`, and
  `integrations/codex/test/codex-manifests.test.mjs`. They are one name per line so that parallel
  branches conflict on a line each rather than all on the same one; keep them that way.
- **Some sources carry NUL bytes.** Use `grep -a` on `lib/config.mjs` and `test/*.test.mjs`, and
  check anything you write with a heredoc for literal control bytes before committing.
- **A comment-only edit to `lib/` still needs a rebuild.** The inline sourcemaps embed source
  text, so `test/dist-freshness` fails on a pure comment change — reporting *"the code matches but
  the inline sourcemap does not"* — while grepping `hooks/dist/` for the comment finds nothing,
  because esbuild strips comments from emitted code but not from the map. One edit to
  `lib/recall.mjs` dirtied four bundles by exactly one line each. Do not assume a docs commit is
  build-free.
- **Not every branch base runs the full check suite.** Confirm which checks apply to the branch
  you cut, and run the rest by hand.
- **Raise `MUBIT_CC_RECALL_BUDGET_MS` for any manual end-to-end run** — 8000, with
  `MUBIT_CC_TIMEOUT_MS` to match. See item 0: at the shipped default the injection path does not
  execute and the run proves nothing. Do not read that timeout as a defect in whatever you built.
- **Effort figures are estimates**, and the ordering is the part most worth arguing with. Waves 1
  and 2 came in near their figures; both were exposure of vendored capability, which Wave 3 is not.

## How this was assembled

Read against the local codaph checkout at `d06aaf3`, confirmed level with `origin/main`; the
plugin at v0.10.0 on `pre-main` @ `05adfe0`; the backend route inventory counted against the
control-plane API surface; and the in-flight scope work read from `plugin-scope-fix` and its four
feeder branches. Backend behaviour cited anywhere in this document is stated as observable API
behaviour: this repository is public, and server internals do not belong in it.
Claims about what the plugin does or does not do were checked in source rather than in docs, and
the redaction gap in item 5 was probed against the live module on this branch's base.

**Updated 2026-08-25, after wave 2.5.** Item 0 is marked shipped, its measured latency figures
have been pulled out of shipped source and the README and left here as dated history, and three
findings were added: the two cross-run delivery paths, the empty global scope behind them, and the
sourcemap rebuild trap. Nothing in Wave 3 has been started.

**Updated 2026-08-24, after waves 1 and 2.** The Shipped notes, item 0, *What waves 1 and 2
learned* and *Open decisions* were written from inside the implementations rather than from the
outside, which is why several of them contradict the recommendation they sit under. Where they
do, the note is the more reliable half — and the contradiction is left visible rather than edited
away, because *what we believed before building it* is the part of this document that has to stay
honest for Wave 3 to be worth reading. Every measurement is dated and names what it was taken
against; the redactor probe in item 5 and the marker table in item 0 are both reproducible from a
clean checkout.
