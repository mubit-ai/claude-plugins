# SC-07 — read the link graph: `include_linked_runs` on recall and reflect

**Branch:** `feat/link-run-routes` · **Worktree:** `/Users/eldaru/Mubit/scope-routes`
**Kind:** feat · **SCOPE.md:** Target C

## The gap

Two fields, both currently pinned false, which makes the red step nearly free.

When `include_linked_runs` is set, `consulted_runs` extends with `linked_runs_for(run_id)`
(`lib.rs:8709`) and the evidence loop consults **every linked run** (`:8827`) with **no scope
filter at all** — `run`-scoped entries included. That is the whole reason Target C beats
widening scopes: reach becomes the link graph rather than a threshold's good behaviour.

## The change

| File | Site | Today | Wanted |
| --- | --- | --- | --- |
| `lib/recall.mjs` | `:157-175`, the rung-1/2 `ladder` body | absent | `include_linked_runs: true` |
| `lib/recall.mjs` | `:253-263`, the rung-3 `postContext` body | absent | `include_linked_runs: true` |
| `hooks/src/session-end.mjs` | `:568` | `include_linked_runs: false` | `true` |

**Watch the literal in `session-end.mjs`.** The long `record: false` comment block sits
*inside* the object literal, after the last field — a new field must go **above** it or the
comment ends up explaining the wrong thing.

Check whether `ContextRequest` (rung 3) actually accepts the flag before adding it there. §1.8
of `lib/http.mjs` already documents one field that exists on `AgentQueryRequest` but not on
`ContextRequest` (`env_tags`), so the two bodies are known not to be interchangeable. If rung
3 does not accept it, say so in a comment at the call site rather than adding a field the
server ignores — and record which it was, because SCOPE.md §5 leaves it open.

## Safety

The flag is **inert until something is linked** — an unlinked run's `linked_runs_for` is
empty, so `consulted_runs` is unchanged. That is what makes this safe to land ahead of Tiers
1–3, and it is worth stating at the call site: a reader who finds `include_linked_runs: true`
in a plugin that ships with no links wants to know it is not a leak.

## The open question

SCOPE.md §5 leaves unresolved whether `reflect` at `SessionEnd` — which runs against a single
`run_id` — sees a linked run's evidence. **Do not assume either way.** SC-11 measures it once
this and SC-08 are merged and writes the answer down.

## Tests (invert first)

`test/session-end.test.mjs:163` asserts `include_linked_runs === false` today. Invert it —
that is the red step, and it costs one line.

Then add, in the same style:

- the rung-1/2 query body carries the flag (assert against the body `fakeMubit()` actually
  received);
- the rung-3 body carries it, or deliberately does not, matching whatever the check above
  established;
- **an unlinked run's results are unchanged** — the inertness claim, tested rather than
  asserted in a comment.

## Verification

Full plugin suite plus the dist freshness gate.
