# What to port from Codaph

A feature audit of [mubit-ai/codaph](https://github.com/mubit-ai/codaph) against this plugin,
and the working brief for `feat/codaph-port`.

| | |
| --- | --- |
| codaph | v0.1.18 @ `d06aaf3`, confirmed level with `origin/main` |
| plugin | v0.10.0, base `pre-main` @ `05adfe0` |
| backend | route inventory counted against the control-plane API surface |
| audited | 2026-08-23, re-verified against this branch's base 2026-08-24 |

Nothing here is implemented. This document is the brief; the branch is empty of code changes
by design.

---

## The short version

Codaph is a ~20k-line CLI and TUI that captures agent activity from Claude Code, Codex and
Gemini into Mubit. Its interesting half is not the TUI — it is that codaph exercises most of
the Mubit control plane, while this plugin, which is far more polished per feature, calls
eleven endpoints and stops.

| | |
| ---: | --- |
| **79** | control routes the backend exposes |
| **21** | tools registered in the MCP server we already vendor and ship |
| **11** | endpoints the plugin actually calls, across 13 hook events |

Three things fall out of the audit:

1. **The cheapest remaining win is knowing who the user is.** We never learn an actor id, so
   nothing in the store can answer *who learned this* — and team memory has no join key.
2. **Eleven of our twenty-one MCP tools are switched off.** Some deliberately and rightly. But
   `mubit_strategies`, `mubit_checkpoint` and `mubit_memory_health` are dormant features rather
   than absent ones — our own doctor skill instructs the reader to `POST` `memory_health` by hand.
3. **The biggest single change is transcript backfill**, and it is gated on a redaction gap
   confirmed live against `lib/redact.mjs`. Do not ship one without the other.

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

### 1. An actor id we never have to ask for

**Impact: high · Effort: S · 1–2 days**

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

### 2. Freshness-aware recall ranking

**Impact: high · Effort: S · 1–2 days**

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

### 3. Switch on the tools we already ship

**Impact: medium-high · Effort: S · 2–3 days**

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

### 4. A resume block at session start

**Impact: high · Effort: M · 4–5 days**

`codaph mubit context "what should the next agent know?"` builds a structured block for handoff,
with `sections`, `lane_filter`, `entry_types`, `include_working_memory` and `max_token_budget`.
It also generates a per-session summary for its browse view.

We already call `/v2/control/context`, but only as the `recallAssemble: server` variant of
per-prompt recall. SessionStart injects recalled memory; it does not inject *here is where you
left off*. Resuming is the thing people actually want from memory, and we own every piece — the
endpoint, the hook, the token budget machinery, the seen-set. Today the first prompt of a session
gets relevance matches against a prompt the user has not written yet.

- **Watch** SessionStart is a 5s-timeout hook; this must fit inside it or ride the existing async path

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

> **Gate: fix the redactor first.** Verified live against this branch's `lib/redact.mjs`. Real key
> shapes are caught (`sk-ant-…`, `mbt_…`, `ghp_…`) and a bare `DATABASE_PASSWORD=hunter2` is
> redacted, but the assignment rule misses whenever the assignment is not at a line start. Both
> `env: DATABASE_PASSWORD=hunter2` and an indented `  DATABASE_URL=postgres://u:p@h/db` pass
> through unredacted. On live capture that is a handful of turns. On a bulk import of every
> transcript on the machine, it is every indented env block anyone has ever pasted into a session.

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

### 8. Activity and export, for the audit question

**Impact: medium · Effort: S · 2–3 days**

`codaph mubit activity --limit 20 --exclude-derived --projection compact` and
`mubit export --format jsonl`, over `/v2/control/activity` and `/activity/export`. We call
neither. What was captured is visible only through `scripts/mubit-inspect.mjs`, which reads local
markers and is not in the package `files` list, so users never receive it.

Two audiences, both unserved: support, who need to see what actually landed rather than what we
believe landed; and anyone answering a procurement or compliance question about what left the
machine. Cheap, and it makes the redaction story demonstrable instead of assertable.

- **Watch** activity needs a longer deadline than the 4000 ms hook budget; non-hook callers must
  pass their own. The lesson join needs `entry_types: ["lesson"]` or it matches nothing.

### 9. Run variables as pinned context

**Impact: medium · Effort: S · 2 days**

Codaph uses `variables/set|get|list|delete` plus a `mirrorRunState` automation toggle. We call
none of them.

A small, cheap slot for things that should sit in front of the model every turn without paying a
retrieval round trip — the current task, a standing constraint, "don't touch the vendored server".
Today the only way to make something reliably present is to hope recall ranks it, which is exactly
the failure mode a pinned slot removes.

---

## The matrix

| # | Feature | Impact | Effort | Days | Depends on | Primary surface |
| --- | --- | --- | --- | --- | --- | --- |
| — | *`plugin-scope-fix`* | *high* | *unmerged* | — | — | *PR #11 closed — see Prior art* |
| 1 | Actor id | ●●● | S | 1–2 | — | `lib/actor.mjs` |
| 2 | Freshness ranking | ●●● | S | 1–2 | — | `lib/recall.mjs` |
| 3 | Dormant MCP tools | ●●○ | S | 2–3 | — | `mcp/src/launch.mjs` |
| 4 | Session resume block | ●●● | M | 4–5 | — | SessionStart hook |
| 5 | Transcript backfill | ●●● | M–L | 8–12 | redactor fix | new importer |
| 6 | File-change lane | ●●● | M | 5–7 | — | `hooks/src/capture.mjs` |
| 7 | Handoff lane | ●●○ | M | 5–7 | scope line | subagent hooks |
| 8 | Activity + export | ●●○ | S | 2–3 | — | new skill |
| 9 | Run variables | ●●○ | S | 2 | — | `variables/*` |
| 10 | Local JSONL mirror + browse | ●●○ | L | 12–18 | — | new read model |
| 11 | Git post-commit anchor | ●○○ | S–M | 3–5 | — | user's `.git/hooks` |
| 12 | Project registry / team view | ●●○ | L | 15+ | actor id | `projects/*` |

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

**Wave 1 — identity and ranking (~1 week).** Items 1 and 2. Small, independent, and everything
collaborative reads better afterwards. `plugin-scope-fix` was originally sequenced ahead of them;
PR #11 closed unmerged and neither item depended on it, so Wave 1 skipped it — see *Prior art*.

**Wave 2 — surface (~2 weeks).** Items 3, 4, 8, 9. Mostly exposure of capability already vendored
and shipped; the highest visible-value-per-day on the list, and a good place to land user-facing
wins while the capture work is still in flight.

**Wave 3 — capture (~4–5 weeks).** Redactor fix, then 5, 6, 7. The real engineering. The redactor
fix is not optional and comes first: bulk import multiplies whatever the scrubber misses by every
transcript on the machine.

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
  copy `node_modules` from `pre-main` instead.
- **`npm run verify` destroys the vendored server.** Its `clean` step deletes `mcp/dist/server.js`,
  which cannot be rebuilt from this repo. Run the narrower scripts.
- **Branches cut from `pre-main` get no CI and no leak scanner.** Whatever runs here has to be run
  by hand.
- **Effort figures are estimates**, and the ordering is the part most worth arguing with.

## How this was assembled

Read against the local codaph checkout at `d06aaf3`, confirmed level with `origin/main`; the
plugin at v0.10.0 on `pre-main` @ `05adfe0`; the backend route inventory counted against the
control-plane API surface; and the in-flight scope work read from `plugin-scope-fix` and its four
feeder branches. Backend behaviour cited anywhere in this document is stated as observable API
behaviour: this repository is public, and server internals do not belong in it.
Claims about what the plugin does or does not do were checked in source rather than in docs, and
the redaction gap in item 5 was probed against the live module on this branch's base.
