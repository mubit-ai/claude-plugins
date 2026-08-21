# Why cross-session recall returns nothing, and how to fix it

Written 2026-08-20 against `api.mubit.ai`, plugin `0.10.0` (`05adfe0`), backend `ricedb`
`a84ff38`. This is a **backend** problem. The plugin is behaving correctly throughout, and no
change to it will help.

## The symptom

`lab preflight` fails one check and passes the rest:

```
PASS  backend health   187ms ok
FAIL  recall canary    scope, not retrieval: 0 sources in a fresh run,
                       3 for the SAME query pinned to run "…tb-full30-a-openssl…"
```

`POST /v2/control/query` returns **HTTP 200**, `degraded: false`, `evidence: []`,
`confidence: 0`. Nothing errors. Nothing times out. It simply finds nothing, in every mode
(`direct_bypass`, `direct`, `agent_routed`) and at rung 3 (`/v2/control/context`, which
reports `evidence_candidates_considered: 0`).

The decisive measurement. Identical query, identical body — only `run_id` differs:

| `run_id` | evidence | time |
| --- | --- | --- |
| the lesson's own `source_run_id` | **8** | 1381 ms |
| a fresh run id | **0** | 1073 ms |

So the index is healthy and the embeddings are fine. This is not a retrieval outage.

## The cause, end to end

**1. Lessons are born at `run` scope.** All ten lessons the `/v2/control/lessons` route
returns as "global lessons" are stored with `scope: "run"`, each bound to the
`source_run_id` of the session that produced it. `plugin.json`'s `mcpLessonScope` ceiling is
`run` by default and deliberately so — its own description says "reflection is still the path
that promotes one beyond it."

**2. Only one thing widens a scope.** From `hooks/src/session-end.mjs`:

> `POST /v2/control/reflect` here is the only thing in the entire system that lets a lesson
> outlive the run that produced it (§1.4).

**3. Reflect promotes on recurrence, not on merit.**
`crates/control/service/src/lib.rs`, the promotion block at ~10399:

```rust
if self.lesson_promotion_threshold > 0 {
    …
    if lesson.is_rule { continue; }                      // rules NEVER widen
    if lesson_statuses.get(li) != Some(&Active) { continue; }   // must pass validation
    if auto_reflected_keys.contains(&norm_key) { continue; }    // auto-reflection excluded
    let norm_key = lesson.content.chars().take(100).lowercase(); // the recurrence key
    let count = { *entry += 1; *entry };
    if count >= self.lesson_promotion_threshold {
        let promoted_scope = match lesson.scope {
            LessonScope::Run     => LessonScope::Session,
            LessonScope::Session => LessonScope::Global,
            LessonScope::Global  => /* → Org, tenant-keyed */
        };
        …
        self.lesson_recurrence_counts.insert(norm_key, 0);  // reset after each rung
    }
}
```

`lesson_promotion_threshold` comes from `MUBIT_CONTROL_LESSON_PROMOTION_THRESHOLD`,
**default 3**.

**4. Run-scoped lessons are excluded from cross-run retrieval by design.** The cross-run
lesson lane (`retrieval_mode: "lesson_overlay"`, ~line 9095) gates on exactly one line:

```rust
// Only surface session-scoped, global-scoped, and org-scoped lessons.
if scope == "run" { continue; }
```

`consulted_runs` in the response is a red herring — it lists only the caller's run because
the plugin does not send `include_linked_runs`. The overlay lane is the path that *should*
carry cross-session memory, and `run` scope is filtered out of it.

## Putting it together

A lesson must be reflected **3 times with the same first 100 characters, lowercased** before
it moves `run → session`. Only then does it become visible to any other session.

That threshold is almost unreachable in practice. Reflection is an LLM summarising a session,
so the same underlying insight comes back worded differently every time and the normalised key
rarely matches twice, let alone three times. The result is a system where the promotion path
exists, is correct, and effectively never fires — which is exactly what the instance shows:
**ten lessons, all at `run` scope, none promoted.**

## The fix

### Option A — lower the threshold (recommended; config only, no code, no deploy)

`MUBIT_CONTROL_LESSON_PROMOTION_THRESHOLD` is **explicitly allowlisted** for per-instance
override in `deploy/k8s/crd/mubitinstances.platform.mubit.ai.yaml`:

```yaml
# Per-instance continual-learning env overrides. Allowlisted by
# the operator to MUBIT_CL_* / MUBIT_CONTROL_LESSON_PROMOTION_
# THRESHOLD; other keys are dropped so infra env is never clobbered.
extraEnv:
  type: object
```

So on the `MubitInstance` resource backing `api.mubit.ai`:

```yaml
spec:
  extraEnv:
    MUBIT_CONTROL_LESSON_PROMOTION_THRESHOLD: "1"
```

Apply it, let the operator roll the instance, and the **first** explicit reflect moves a
lesson `run → session`. `session` already passes the overlay gate, so one reflect is enough
for cross-session recall.

Verify with `node testkit/bin/lab.mjs preflight --plugin-dir <target>` — the canary goes
green the moment a query in a fresh run returns evidence.

**Trade-off, stated plainly:** at `1`, every validated non-rule lesson widens on its first
reflect. More memory crosses sessions, and so does more noise. `2` is the conservative
choice; `1` is the right one while you are trying to demonstrate the feature works at all.

### Option B — backfill the ten existing lessons

Option A only affects lessons reflected *after* it lands. The ten already stored stay at
`run` scope and stay invisible. Rewriting their metadata `scope` / `lesson_scope` to
`"session"` makes them retrievable immediately — the same in-place rewrite the promotion code
already performs:

```rust
obj.insert("scope".to_string(), json!(promoted_scope.as_str()));
obj.insert("lesson_scope".to_string(), json!(promoted_scope.as_str()));
```

Worth doing only if you want the existing corpus usable for a demo; otherwise walk
`ux/scenarios/W2-01` once after Option A and generate a fresh one.

### Option C — decouple promotion from exact-prefix recurrence (the real fix)

The design intent is "a lesson earns wider scope by proving itself." The implementation keys
that on the first 100 characters of LLM-generated prose, which is not a stable identity. There
is already a similarity helper in the same file — `lesson_recurrence_similarity(...) >= 0.97`
at line 1486 — that is used elsewhere but **not** by the promotion counter, which uses the
exact normalised prefix.

Keying recurrence on semantic similarity rather than a prefix would make the ladder behave the
way it reads. That is a backend change and out of this kit's scope, but it is the thing that
makes Option A unnecessary.

## What this kit does about it

`lab preflight` refuses to record any measurement while the canary is red, and distinguishes
this from a genuine retrieval outage — the two need opposite responses. `lab ab --force`
records anyway and stamps `degraded: true`, which `compare` then refuses to place beside a
trusted run.

Until it is fixed: `lab ab` measures **overhead only** (which is still a real, useful number),
and every W2 scenario, W3-02, and moment M7 will fail for reasons that have nothing to do with
the plugin.
