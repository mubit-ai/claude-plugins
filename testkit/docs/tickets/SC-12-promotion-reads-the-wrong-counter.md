# SC-12 — backend: promotion reads the wrong recurrence counter

**Branch:** integration (`plugin-scope-fix`) · **Kind:** docs — **filed, not implemented**
**SCOPE.md:** I3

**Every citation below was verified against `/Users/eldaru/Mubit/ricedb` on 2026-08-21.**

## Why this is filed rather than fixed

The fix is Rust in `ricedb` and needs a deploy. It is recorded here so nobody re-derives it,
and so the reasoning survives with the tickets it came from. **Target C makes it
non-load-bearing either way** — that is the whole point of joining runs instead of widening
scopes.

## The defect

Promotion is the documented way a lesson earns wider scope. It is gated on an **in-memory,
exact-match, first-100-characters-lowercased `DashMap`** (`lib.rs:10437-10451`):

```rust
let norm_key: String = lesson.content.chars().take(100).collect::<String>().to_lowercase();
let count = { *entry += 1; *entry };
if count >= self.lesson_promotion_threshold { /* run → session → global */ }
```

Threshold default **3** (`:3577`). So a lesson must be reflected three times with the same
first 100 characters, lowercased, before it moves `run → session`. Reflection is an LLM
summarising a session, so the same insight comes back worded differently every time and the
key rarely matches twice. The instance shows the result: **ten lessons, all at `run` scope,
none promoted.**

Meanwhile a **persisted semantic** `recurrence_count` already sits on the entry:

| Piece | Where |
| --- | --- |
| `lesson_recurrence_similarity`, normalized-token Jaccard | `:1308` |
| `MUBIT_CL_RECONCILE_MIN_SIM`, default **0.5** | — |
| `MUBIT_CL_WRITE_RECONCILE`, **on** by default | `:1258` |
| unit test, three real paraphrases of one lesson | `:18348` |
| bumps `recurrence_count` in the entry's metadata | `:16785` |

It does not help promotion because `find_recurrent_lesson` (`:16729`) consults **`run_id`
only** — it passes `run_id.to_string()` straight into `nexus.consult(...)`, so it can never
see a paraphrase written by a different run:

```rust
let candidates = nexus.consult(Vec::new(), Some(lesson.content.clone()), 8, None,
                               run_id.to_string()).await          // :16739 — run_id only
...
obj.insert("recurrence_count".to_string(), json!(recurrences + 1));   // :16785 — the OTHER counter
```

**Two counters — one persisted, semantic and per-run; one in-memory, exact-match and
cross-run — and promotion reads the wrong one.** That is the actual defect, and it is far
smaller than "add similarity keying".

## Two corrections worth recording

Both make it *more* fixable than the original account suggested, and both cost an afternoon to
re-derive:

1. **The `DashMap` is checkpointed** — `lesson_recurrence_counts` is declared at `:2836`,
   saved at `:3135` and restored at `:3261`, so it is **not** process-local. A pod roll does
   not reset it if checkpointing is on for the instance.
2. **`MUBIT_CL_AUTO_PROMOTE` (`:998-1000`) is not a shortcut.** It is champion/challenger
   prompt-version promotion, unrelated to lesson scope.

## The fix, when someone takes it

Point promotion at the persisted `recurrence_count`, and widen `find_recurrent_lesson` beyond
the current run. A scoped patch, not a design project.

## Explicitly not the fix

**Option A** — lowering `MUBIT_CONTROL_LESSON_PROMOTION_THRESHOLD` on `api.mubit.ai`. SCOPE.md
§4 rejects it on four counts, the sharpest being that it changes a shared production backend
to make a local canary green, and re-opens instance-wide sharing for every writer at once.
