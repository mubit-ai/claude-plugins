# Memory scope: the issues, the context, and what to build

Written 2026-08-20, revised 2026-08-21, against `api.mubit.ai`, plugin `0.10.0` (`05adfe0`),
backend `ricedb` `a84ff38`, and [docs.mubit.ai/concepts](https://docs.mubit.ai/concepts).
Every line number below was read in those checkouts.

**What this document is.** It started as "why cross-session recall returns nothing, and how to
fix it," concluded *"this is a backend problem; no change to the plugin will help,"* and
recommended lowering a promotion threshold on the shared hosted instance. **That conclusion
was wrong**, and finding out why turned up six other things worth writing down. It is now an
issue register with the context needed to judge each one, plus the design that closes the
real gap.

The single correction that overturned the original: **the canary is not measuring
cross-session recall.** It measures cross-*project* recall, which this plugin deliberately
turns off in its own code. Everything downstream of that — the severity, the fix, and the
claim that "every W2 scenario will fail" — had to be re-derived.

---

## 1. Context: how memory is actually scoped here

You cannot judge any issue below without this. It takes two tables.

### 1.1 Four scope names, two read behaviours

| Scope | Docs say ([runs-and-scopes](https://docs.mubit.ai/concepts/runs-and-scopes)) | What the code does |
| --- | --- | --- |
| `run` | "Only the writing run" | matches — consulted only for the `run_id` you pass |
| `session` | "Related runs" | **every run on the instance** |
| `global` | "Every run on the instance" | every run on the instance |
| `org` | "Every instance in the tenant" | tenant-keyed `__org__<id>` run |

The middle rung is documented and **not implemented on the read path**. The cross-run lesson
lane (`crates/control/service/src/lib.rs:9069`) calls `nexus.consult_global(...)` — a global
search, unbounded by run — then applies exactly one scope test (`:9121`):

```rust
// Only surface session-scoped, global-scoped, and org-scoped lessons.
if scope == "run" {
    continue;
}
```

Nothing consults `linked_run_ids`. Nothing checks a session identity. The plugin's own egress
guard states the consequence (`mcp/src/egress.mjs`):

> Server-side the cross-run overlay admits every lesson whose scope is not `"run"`, so a
> `session` lesson is read by *other runs* exactly as a `global` one is. It is not "narrower
> than global"; on the read side it is the same lane. **A benchmark harness found this the
> expensive way — lessons one task wrote were injected into five unrelated ones.**

### 1.2 `run_id` is derived from the directory, so `run` scope acts as *project* scope

`lib/runid.mjs` maps a Claude Code session to a Mubit run. The default is `per-directory`
(`lib/config.mjs:332`):

| Strategy | Run id | Derived from |
| --- | --- | --- |
| `per-directory` (default) | `cc-<slug>-<hash8>` | `git rev-parse --show-toplevel`, falling back to `CLAUDE_PROJECT_DIR` |
| `git-branch` | `cc-<slug>-<branch>-<hash8>` | root + branch |
| `per-conversation` | `cc-<host_session_id>` | the host session id |
| `static` | `MUBIT_CC_RUN_ID` verbatim | pinned; unset is a config error |

`directoryRunId`'s own comment: *"two terminals in one repo share a run, two repos with the
same directory name do not, and a `cd` within one repo moves nothing."*

**So session 2 in the same repo is the same run as session 1.** Its memory returns through
the current-run evidence lane at `run` scope, with no promotion involved. Cross-session
recall *within a project* is the default and works by construction.

### 1.3 The effective architecture

```
run scope + runStrategy: per-directory   →  PROJECT memory   (cross-session, works today)
session / global scope                   →  INSTANCE memory  (cross-project, leaks)
                    ── nothing in between ──
```

`run` is doing the work of a project scope. That is a good trick and it is why the product
functions. It is also why there is no rung left for *"follows me between my projects, but not
into anyone else's."*

**There is no third path.** Checked and ruled out: sleep-time consolidation
(`consolidation_worker.rs:334`) iterates runs and calls `nexus.list(row.run_id, …)` — it
merges *within* each run and never widens scope. `MUBIT_CL_AUTO_PROMOTE` (`lib.rs:999`) is
champion/challenger *prompt-version* promotion, unrelated to lesson scope. Only two
mechanisms can move memory between runs: **scope promotion** (§4) and **linked runs** (§6).

---

## 2. The symptom

`lab preflight` fails one check and passes the rest:

```
PASS  backend health   187ms ok
FAIL  recall canary    scope, not retrieval: 0 sources in a fresh run,
                       3 for the SAME query pinned to run "…tb-full30-a-openssl…"
```

`POST /v2/control/query` returns **HTTP 200**, `degraded: false`, `evidence: []`,
`confidence: 0`, in every mode (`direct_bypass`, `direct`, `agent_routed`) and at rung 3.

| `run_id` | evidence | time |
| --- | --- | --- |
| the lesson's own `source_run_id` | **8** | 1381 ms |
| a fresh run id | **0** | 1073 ms |

The index is healthy. **This is not a retrieval outage.** That much of the original document
stands, and it is what §3's first issue is about.

---

## 3. The issue register

Seven issues. Two block work today; three are architectural; two are local bugs. Each says
what it is, why it is a problem, and what it blocks.

---

### I1 — The preflight gate refuses every measurement for a by-design reason

**Severity: blocking. Fix first.**

`testkit/lib/preflight.mjs:225` dials recall with a hard-coded synthetic run:

```js
const outcome = await recallMod.recallBlock(cfg, {
  runId: 'tk-preflight-canary',
  ...
});
```

`tk-preflight-canary` has never written anything. So the question it poses is *"can a run
that has never stored anything retrieve what unrelated runs stored?"* — that is **instance-wide
memory**, which §1.1 shows is off by default and §1.2 shows is not how the product delivers
cross-session recall.

**Why it is a problem.** The gate exists to stop a sweep recording numbers from a degraded
backend, which is correct and valuable. But it is failing on the shipped configuration, so
every `lab ab` either does not run or runs under `--force` and gets stamped `degraded: true`,
which `compare` then refuses to place beside a trusted run. A gate that is red for a
by-design reason gets bypassed within a week, and then it protects nothing.

**What it also caused.** The original document read the red canary as proof that *"every W2
scenario, W3-02, and moment M7 will fail for reasons that have nothing to do with the
plugin."* That is false. Every one of those scenarios pins its run id:

| Scenario | Run identity |
| --- | --- |
| W2-01 teach-then-recall | `MUBIT_CC_RUN_STRATEGY=static`, `MUBIT_CC_RUN_ID=tk-w2-01` |
| W2-03 survive-compaction | `MUBIT_CC_RUN_ID=tk-w2-03` |
| W2-04 subagent-already-knows | `MUBIT_CC_RUN_ID=tk-w2-04` |
| W2-05 correct-a-wrong-memory | `MUBIT_CC_RUN_ID=tk-w2-05` |
| W3-02 second-visit | `MUBIT_CC_RUN_ID=tk-w3-02` |

W2-01 says why in its own setup block: *"`static` with a pinned `MUBIT_CC_RUN_ID` is what
makes session 2 land in the same run as session 1."* None of them route through the cross-run
overlay. **They should pass today, with the canary red and nothing changed** — which makes
walking one of them the cheapest way to find out whether anything here is actually broken.

**Fix:** §7.

---

### I2 — There is no scope between "one run" and "the whole instance"

**Severity: architectural. This is the real gap.**

From §1.1: `session` and `global` are the same lane on read. From §1.2: `run` is bound to one
directory. So the only two settings available are *nothing crosses projects* or *everything
crosses to every run on the instance.*

**Why it is a problem.** It makes cross-project memory an all-or-nothing choice between no
feature and a known leak. The leak is not hypothetical — a benchmark harness already had one
task's lessons injected into five unrelated ones, and closing it is why 0.10.0's egress guard
exists. So today the plugin ships with the feature off, and the documented middle rung that
would make it safe (`session` = "related runs") returns the same results as `global`.

It also means the docs and the implementation disagree in a way a user cannot detect: someone
reading "session scope = related runs" and choosing it for safety gets instance-wide sharing.

**Fix:** §6, Target C.

---

### I3 — The promotion ladder is correct, and dead

**Severity: architectural. Rises to blocking if I2 is not fixed.**

Promotion is the *documented* way a lesson earns wider scope, and the only one besides linked
runs. It is gated on recurrence (`lib.rs:10399`):

```rust
// :10437 — the recurrence key
let norm_key: String = lesson.content.chars().take(100).collect::<String>().to_lowercase();
let count = { *entry += 1; *entry };                       // :10446
if count >= self.lesson_promotion_threshold {              // :10451
    let promoted_scope = match lesson.scope {
        LessonScope::Run     => LessonScope::Session,
        LessonScope::Session => LessonScope::Global,
        LessonScope::Global  => /* → Org, tenant-keyed */
    };
    ...
    self.lesson_recurrence_counts.insert(norm_key.clone(), 0);   // :10679, reset per rung
}
```

`lesson_promotion_threshold` = `MUBIT_CONTROL_LESSON_PROMOTION_THRESHOLD`, default **3**
(`:3577`). Rules never widen; only `Active` (validated) lessons count; auto-reflected lessons
are excluded.

**Why it is a problem.** A lesson must be reflected three times **with the same first 100
characters, lowercased**, before it moves `run → session`. Reflection is an LLM summarising a
session, so the same insight comes back worded differently every time and the normalised key
rarely matches twice. The result is a promotion path that exists, is correct, and effectively
never fires — exactly what the instance shows: **ten lessons, all at `run` scope, none
promoted.**

**Three corrections to the original account of this, all of which make it more fixable:**

1. **The counter is durable, not process-local.** `lesson_recurrence_counts` is an in-memory
   `DashMap` (`:2836`), but it is written into the checkpoint (`:3135`) and restored from it
   (`:3261`). A pod roll does not reset it *if checkpointing is on for this instance*.
2. **The semantic recurrence detector already exists, and promotion does not use it.**
   `lesson_recurrence_similarity` (`:1308`, normalized-token Jaccard) is live at
   `MUBIT_CL_RECONCILE_MIN_SIM`, default **0.5**, with `MUBIT_CL_WRITE_RECONCILE` defaulting
   to **on** (`:1258`); its unit test (`:18348`) pins it against three real paraphrases of one
   lesson. It does not help promotion because `find_recurrent_lesson` consults **`run_id`
   only** (`:16740` — its comment says "an existing **same-run** entry"), and when it fires it
   bumps a **`recurrence_count` field in the entry's metadata** (`:16778`), which is a
   *different counter* from the `DashMap` promotion reads.

   Two counters — one persisted, semantic and per-run; one in-memory, exact-match and
   cross-run — and promotion reads the wrong one. **That is the actual defect**, and it is far
   smaller than "add similarity keying."
3. **`MUBIT_CL_AUTO_PROMOTE` is not a shortcut.** Champion/challenger prompt versions
   (`:999`), unrelated to lesson scope. Noted so nobody loses an afternoon.

**Fix:** point promotion at the persisted `recurrence_count` and widen `find_recurrent_lesson`
beyond the current run. Backend change, out of this kit's scope, but a scoped patch rather
than a design project.

---

### I4 — Subagent fan-out has no isolation, and the join is half-built

**Severity: capability gap. Costs nothing today; blocks attribution later.**

The local half is built carefully. The wire half is deliberately absent, and the code says so.

**Built:** `deriveSubRunId(runId, payload)` → `<parent_run_id>-sub-<agentShort>`
(`lib/runid.mjs:384`, idempotent); a distinct `claude-code-sub-<agentShort>` agent identity
(`:338`); a `SubagentStart` hook that injects recall (`hooks/hooks.json:27`); and a per-subagent
record at `runs/<parent>/subagents/<sub_run_id>.json` holding **both ends of the join** —
`sub_run_id`, `parent_run_id`, both agent ids, the parent's `prompt_id`, the exact `refIds`
that subagent received — ending with the field `linked: false` (`subagent-start.mjs:311`).

**Not built:** no `link_run` call — `lib/http.mjs:89`'s `ROUTES` has eleven entries and no
link route. And **nothing is ever stored under a sub-run id**: `subagent-start.mjs:168`
comments its own argument, `runId, // the PARENT run: nothing is stored under a sub-run id`,
and `SubagentStop` routes to `capture.mjs --subagent`, which derives the **parent** run
(`:240`) and carries the subagent's identity in `metadata_json` instead (`:430-451`).
`runid.mjs:363` is blunt: *"**Never query against it.** A sub-run id has no memory stored
under it… It is a *local* lane… until there is a route that can join it back up."*

**Why it is a problem.** Not because subagents lack memory — they read the parent run, which
is everything. The cost is the opposite direction: a fan-out of six subagents dumps six
streams of unrelated work into one run, and next week's recall in that project cannot tell
them apart. There is no way to isolate them without losing them, so the `linked: false`
records accumulate as a deliberate IOU.

**Note the topology.** A parent with N subagents is a star and every query originates at the
hub, so `linked_runs_for(parent)` returns all N in one hop. The linked-run mechanism supports
the subagent shape natively — which is presumably why `subagent-start.mjs:255` names it as
Mubit's own pattern.

**Fix:** §6, Target C, Tier 1.

---

### I5 — `/clear` silently drops a project's memory

**Severity: product bug inside the supported story. Uncovered by any test.**

`deriveRunId` appends an incrementing `-c1`, `-c2` suffix on `SessionStart.source === "clear"`
(`lib/runid.mjs:158`). `resume`, `compact` and `fork` reuse the mapped run; `clear` does not.

**Why it is a problem.** This is a *real* cross-session failure a user will hit, unlike the
one the canary flags. It sits squarely inside the story the product does support — same
machine, same repo, same person — and nothing in `ux/` covers it. It is also arguably correct
behaviour ("forget the thread"), which is exactly why it needs a scenario: to decide
deliberately rather than by default.

---

### I6 — W2-02 tests a run strategy that does not exist

**Severity: kit bug. Trivial fix.**

`W2-02-branch-switch.md` sets `MUBIT_CC_RUN_STRATEGY=repo`. `repo` is not a strategy —
`lib/runid.mjs:53` allows only `per-directory`, `git-branch`, `per-conversation`, `static`,
and `normaliseStrategy` (`:705`) **silently falls back to the default** rather than erroring.

**Why it is a problem.** The scenario currently runs under `per-directory`, where a branch
switch does *not* change the run id — so it proves the opposite of what it claims, and would
pass while doing it. It wants `git-branch`.

---

### I7 — The ten stored lessons are reachable only from their own run

**Severity: corpus state, not a defect. Affects demos.**

All ten lessons `/v2/control/lessons` returns as "global lessons" are stored with
`scope: "run"`, each bound to its `source_run_id`. Promotion (I3) does not touch them
retroactively — the promotion block iterates the lessons produced by *the current reflect
call* only.

**Why it matters.** Any fix that changes future behaviour leaves this corpus invisible. If a
demo needs existing content to appear cross-run, the ten need rewriting in place (`scope` and
`lesson_scope` → `"session"`, the same rewrite the promotion code performs) — otherwise walk
`ux/scenarios/W2-01` once and generate a fresh one.

---

## 4. Options considered and rejected

### Option A — `MUBIT_CONTROL_LESSON_PROMOTION_THRESHOLD: "1"` (was "recommended")

The mechanism checks out. The CRD allowlist is real
(`deploy/k8s/crd/mubitinstances.platform.mubit.ai.yaml:94-101`). At `1`, the first explicit
reflect moves a lesson `run → session`, which clears the overlay gate.

**Four objections, in order of severity.**

1. **It changes a shared backend to make a local canary green.** `extraEnv` is per-instance,
   and `api.mubit.ai` serves every other consumer. Widest blast radius here, narrowest benefit.
2. **What it enables is instance-wide sharing — the leak, not a side effect of it.** It
   re-opens exactly what the egress guard closed, for every writer on the instance at once.
3. **It needs a deploy and cluster access.** "Config only, no code" is true and misleading: a
   CRD edit, an operator reconcile and a pod roll on production.
4. **It does not even fix the symptom.** Promotion only touches lessons from the current
   reflect call, so the ten stored lessons (I7) stay invisible and the canary stays red until
   someone reflects something new.

**Verdict: not recommended.**

### Option B — backfill the ten existing lessons

Correct as written, worth doing only for a demo (I7). Not optional *alongside* A — A is inert
without it or a fresh reflect.

### Option C (original) — invent similarity-keyed recurrence

Superseded by I3 correction 2: the similarity function already exists and is already running.
The work is to point promotion at the persisted counter, not to build a new one.

---

## 5. What to build

Pick by target. These are different products, and the original document conflated them.

### Target A — memory that survives a new session in the same project

**Already works; build nothing.** `run` scope plus `per-directory` is the design (§1.2), and
the kit's W2 scenarios test it. The one real gap inside this target is I5 (`/clear`).

### Target B — memory that follows the user between projects, today, with no new code

**B1 — plugin-side (the cheap lever).** `mubit_learned` is the only lesson-writing tool a
default install exposes, and the vendored SDK hard-codes `lesson_scope: "session"` on every
write. 0.10.0's egress guard clamps that to the `mcpLessonScope` ceiling, default `run`
(`mcp/src/launch.mjs:156`, `mcp/src/egress.mjs`). Raise it:

```bash
export MUBIT_MCP_LESSON_SCOPE=global    # or: session — identical on the read side
```

The plugin's own troubleshooting table prescribes this (README:444): *"A saved lesson never
becomes visible in another project → … or raise `mcpLessonScope`."*

One environment variable. No deploy, no cluster access, revertible per shell, and its blast
radius is **the machine that sets it**. It gets cross-run recall working for agent-written
lessons immediately, without touching reflection or promotion.

**The cost, stated plainly: this is I2's leak, deliberately re-opened.** Anything
`mubit_learned` writes becomes readable by every run on the instance. Use it for a bounded
measurement window; never leave it on a benchmarking host.

*This is the single fact that overturned the original document.* "No change to the plugin will
help" was written without reading the egress guard.

**B2 — backend-side.** Option A. Same effect, wider blast radius, needs ops. Prefer B1.

**B3 — user scoping, worth one experiment.** `metadata_matches_scope` (`:3932`) already filters
candidates by `user_id`, so setting the plugin's `userId` and writing at `global` would give
cross-project, single-user memory with no backend change. The catch is in the code: it rejects
only when the stored `user_id` is **non-empty**, so entries written without one match every
caller. Not retroactive, and a mixed corpus still leaks the untagged half.

### Target C — the missing rung: join runs instead of widening scopes

This is the fix for I2 and I4. **The mechanism is already built on both sides and unused on
both sides.**

- **Backend.** `/v2/control/query` accepts `include_linked_runs`. When set, `consulted_runs`
  extends with `linked_runs_for(run_id)` (`:8709`) and the evidence loop consults **every
  linked run** (`:8827`) with **no scope filter at all** — `run`-scoped entries included.
  `link_run` maintains the join bidirectionally (`:7861-7901`) and is already exposed over
  HTTP: `POST /v2/control/runs/link` and `/runs/unlink`
  (`crates/core/runtime/src/server/mod.rs:220-221`). **No backend change is required.**
- **Plugin.** It never sends the flag (`hooks/src/session-end.mjs:568` sets
  `include_linked_runs: false`) and has no route to create a link (`lib/runid.mjs:367`:
  *"`ROUTES` has no `link_run`, so nothing on the wire relates a sub-run to its parent"*).
  `hooks/src/subagent-start.mjs:255` names this design as the intended one and writes both
  ends of the join to disk so a later `link_run` needs no rerun.

> **Keep lessons at `run` scope. Join runs instead of widening scopes.**

**Why it beats every option in §4:**

- **No leak.** Reach is the link graph. An unlinked project sees nothing by construction, not
  by a threshold's good behaviour.
- **No promotion.** I3 stops being load-bearing. Nothing depends on an LLM producing the same
  100 characters three times.
- **Same-instance-safe.** Other consumers are unaffected — the caller opts in per query.
- **Honest rungs.** `session` becomes implementable as documented (§1.1).
- **It closes I4**, which is the original reason the plugin wanted this route.

**Two constraints found while verifying it, both of which shape the topology:**

1. **`linked_runs_for` is one hop, not transitive** (`:5654` — it returns
   `scope.linked_run_ids` and does not walk them). The obvious hub-and-spoke design therefore
   *does not work as stated*: from project A, `consulted_runs` is `[A, root]`, and sibling
   project B is never reached. Two ways out, and it is a real design decision:
   - **Mesh** — link each project run to every other. Exact reach, per-pair revocable, O(n²)
     links — but n is one user's project count, and §6 shows it is 2–4 in practice.
   - **Hub with a portable-memory root** — keep the star but *write* travelling lessons into
     the root run. Cheaper graph, but it needs a write-side decision about which lessons are
     portable, which is a bigger change than a flag.
2. **`run_scopes` is an in-memory `HashMap`** (`:2809`) durable only via the checkpoint
   (`:3026` save, `:3179` restore) — the same caveat as I3's counter. Confirm checkpointing is
   on before treating a link as permanent.

**Open question, unresolved:** whether `reflect` at `SessionEnd`, which runs against a single
`run_id`, sees a linked run's evidence. If not, linking improves recall but not lesson
extraction. Fine either way, but it should be known before it is promised.

---

## 6. How users would actually link runs

The design constraint that rules out most options: **users never see run ids.**
`cc-plugin-lab-43f3807e` is a hash of a git toplevel. Any UX that asks someone to name one is
already wrong.

Two things the plugin already has make this tractable.

**The session map already pairs runs with real paths.** Every entry under
`~/.claude/plugins/data/mubit-memory*/sessions/`:

```json
{"run_id":"cc-tbench-b0b12b61","agent_id":"claude-code-1abc0352","strategy":"per-directory",
 "project_dir":"/Users/eldaru/Mubit/Benchmarking/TBench","created_at":1787233363280,
 "last_seen_at":1787248590945,"mode":"hosted","clear_count":0}
```

**And the git remote partitions projects correctly.** Measured on this machine:

```
plugin-lab         claude-plugins.git   ┐ same work
pre-main           claude-plugins.git   ┘
ricedb             ricedb.git           ┐
ricedb-cc-plugin   ricedb.git           │ same work
ricedb-recall-fix  ricedb.git           │
som-t11            ricedb.git           ┘
```

Six directories, six distinct run ids, two groups — and the grouping is the one a human would
draw. That is the signal to build on.

### Tier 1 — subagents: fully automatic, no UX at all

There is no question to ask. The parent knows its own run, mints the sub-run, and
`subagent-start.mjs` already holds both ends of the join in the record it writes. Nobody
decides anything, the star topology fits the one-hop limit natively, and it closes I4.

**Ship this first.**

### Tier 2 — same-remote repos: proposed once, confirmed by a human

When `SessionStart` fires in a run whose `git remote get-url origin` matches another run in
the session map, offer it once and remember the answer either way:

```
mubit: this repo shares a remote with a project you already have memory in.

  ~/Mubit/pre-main            last active 2 days ago, 47 entries

  Link them so recall in one can see the other?   /mubit-memory:link yes | no
```

Directories and dates, never hashes. Declining is remembered, so it does not nag. The signal
is self-timing: on a fresh machine with one repo there is nothing to offer, and the prompt
appears the first time a second run with a matching remote shows up — exactly when the
question becomes real. Same-remote sets are small (2–4 above), so mesh linking is trivially
cheap and the hub's write-side problem never arises.

### Tier 3 — explicit, for everything else

`/mubit-memory:link` opens a picker over the session map, sorted by `last_seen_at`:

```
Memory in this project:  ~/Mubit/plugin-lab

  [x] ~/Mubit/pre-main                    2d ago    same remote
  [ ] ~/Mubit/claude-plugins             11d ago    same remote
  [ ] ~/Mubit/Benchmarking/TBench        18d ago
  [ ] ~/Mubit/claude-plugins-labs        24d ago

  linked projects can read each other's memory · /mubit-memory:unlink to revoke
```

The same surface lists what is currently linked, so reach is always inspectable.

### Not the LLM — and this one should hold

A link widens what a run may **read**, durably, across future sessions. Handing that to the
model is the same class of mistake the egress guard just closed in the other direction: every
MCP write tool exposes an optional `session_id` that the server prefers over the launcher's
derived run, so an agent could write into any run it could name. A model-callable link route
re-opens that hole on the read side — an agent granting itself access to memory the user never
connected.

The asymmetry matters too. A bad recall costs one turn of noise. A bad link is silent and
permanent until someone notices an unrelated project bleeding in — precisely the failure the
benchmark harness hit.

So: the model may *notice* and say so ("these two repos look related — want me to link
them?"), and the plugin proposes from a deterministic signal it can defend. **A human
confirms.** `unlink` is one command and the route already exists.

### What it costs in the plugin

- `lib/http.mjs:89` — two entries in `ROUTES` (`/v2/control/runs/link`, `/runs/unlink`).
- `lib/recall.mjs:159` — add `include_linked_runs: true` to the query body.
- `hooks/src/subagent-start.mjs` — one `link_run` call (both arguments already in hand), flip
  `linked` to `true`, and write subagent captures under `subRunId`.
- A place to declare the graph: the Tier 2 offer plus a `/mubit-memory:link` skill.

---

## 7. If Target C is not built

A fair question, and the honest answer is that most of the register does not move.

**Unaffected — fix regardless:** I1 (the gate, still blocking), I5 (`/clear`), I6 (W2-02), and
the pre-existing eval-arm detection problem in `evals/README.md`. That is the bulk of the
near-term work.

**Gets worse:**

- **I3 becomes load-bearing.** Promotion becomes the only sanctioned cross-run path, so the
  wrong-counter defect stops being a nice-to-have. Its priority rises.
- **I2 becomes permanent.** Cross-project memory stays an all-or-nothing choice between no
  feature and a known leak.
- **I4 keeps accruing.** Subagent fan-out keeps pooling into the parent run with no way to
  isolate without losing.

**Genuinely fine without it:** Target A — cross-session recall within a project, which is most
of what the product claims — needs nothing from linking.

So skipping Target C costs exactly two capabilities (a leak-free middle rung, and subagent
isolation) and raises the priority of one backend defect. It costs nothing on the critical
path to getting measurements running again.

---

## 8. What this kit should do

`checkRecallCanary` conflates three distinct states, and only two are a reason to refuse a
measurement:

| State | What it means | Should it block a sweep? |
| --- | --- | --- |
| retrieval outage | endpoint errors, `budget_exhausted` | **yes** — already handled correctly |
| project memory broken | a run cannot retrieve **its own** stored evidence | **yes** — not currently tested |
| instance-wide sharing off | a fresh run sees nothing from unrelated runs | **no** — this is the shipped default |

It tests only the third and blocks on it. Concretely:

1. **Split the check.** `recall-canary` becomes *same-run recall* — write a sentinel through
   the plugin's own path, then read it back **under the same `run_id`**. That is the product's
   actual contract, and red there is a genuine outage.
2. **Demote the current probe** to `cross-run-overlay`, reported as **informational** with a
   measured value (`0 sources in an unrelated run — instance-wide sharing is off; expected at
   mcpLessonScope=run`) rather than a FAIL. It stops being a reason to `--force`.
3. **Stop stamping `degraded: true`** for state 3. An A/B measured while instance-wide sharing
   is off is measuring the shipped configuration, and it is trustworthy.

Until (1) exists, `lab ab` measures **overhead only** — which remains a real, useful number,
and is what it was always measuring.

---

## 9. Next steps, in order

1. **Walk W2-01 unchanged, today.** It pins its run id, so it depends on none of this. The
   load-bearing experiment: if it passes with the canary red, I1 is confirmed and the severity
   of everything else drops sharply. If it fails, the problem is inside project memory and
   none of §5 is the answer.
2. **Fix I6.** `MUBIT_CC_RUN_STRATEGY=repo` → `git-branch` in W2-02.
3. **Re-point the canary** (§8.1–8.3). Unblocks measurement without changing any instance.
4. **Measure B1 in a bounded window.** `MUBIT_MCP_LESSON_SCOPE=global`, one
   `/mubit-memory:remember`, one fresh-run query. Confirms the egress-guard reading end to end
   and gives a green cross-run number for a demo. Unset it afterwards.
5. **Add a `/clear` scenario** under W2 for I5.
6. **Build Target C Tier 1** (subagents). No user-facing decision, closes I4, and proves the
   `link_run` path with the smallest possible surface.
7. **Then Tier 2/3** if cross-project memory is wanted, per §6.
8. **File the promotion-counter defect** (I3, correction 2) as its own backend issue.
   Independent of everything above, and it makes the ladder work as documented for whoever is
   relying on it.

Options A and B are recorded in §4 as rejected, with reasons. Neither should be applied to
`api.mubit.ai` to turn this kit's canary green.
