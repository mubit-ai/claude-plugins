# SC-11 — bounded scope experiments: B1, B3, and the ten stranded lessons

**Branch:** integration (`plugin-scope-fix`) · **Kind:** docs
**SCOPE.md:** §5 B1/B3, I7 · **Depends on:** SC-03 (`KIT_OWNED_ENV`), SC-07 + SC-08 (for the §5 question)

## What to write

A runbook at `integrations/claude-code/docs/manual-test-scope.md`, in the shape of the
existing `manual-test-hs-*.md` files in that directory. Read one first and match it — these
are walked by a human with a terminal, and their value is that every step is copy-pasteable
and every expected result is stated before it is observed.

## B1 — `MUBIT_MCP_LESSON_SCOPE=global`

`mubit_learned` is the only lesson-writing tool a default install exposes, and the vendored
SDK hard-codes `lesson_scope: "session"` on every write. 0.10.0's egress guard clamps that to
the `mcpLessonScope` ceiling, default `run` (`mcp/src/launch.mjs:156`, `mcp/src/egress.mjs`).
Raise it, and cross-run recall works for agent-written lessons immediately.

The procedure: export it, one `/mubit-memory:remember`, one fresh-run query, **then unset**.

*This is the single fact that overturned the original SCOPE.md.* "No change to the plugin will
help" was written without reading the egress guard.

**State the cost in these words: this is I2's leak, deliberately re-opened for a bounded
window.** Anything `mubit_learned` writes becomes readable by every run on the instance. The
runbook says so, and says never to leave it on a benchmarking host — that is not a caveat at
the bottom, it belongs next to the export.

Depends on SC-03 adding `MUBIT_MCP_LESSON_SCOPE` to `KIT_OWNED_ENV`, or `checkEnvHygiene`
blocks the sweep the moment it is exported.

## B3 — the `userId` experiment

`metadata_matches_scope` (`lib.rs:3932`) filters candidates by `user_id`, so setting the
plugin's `userId` and writing at `global` would give cross-project, single-user memory with no
backend change.

The catch is in the code: it rejects only when the stored `user_id` is **non-empty**, so
entries written without one match every caller. Not retroactive, and a mixed corpus still
leaks the untagged half.

**Record the result; do not ship it as a recommendation.**

## I7 — the ten stranded lessons

All ten lessons `/v2/control/lessons` returns as "global lessons" are stored with
`scope: "run"`, bound to their `source_run_id`. Promotion does not touch them retroactively —
the promotion block iterates the lessons produced by *the current reflect call* only.

For a demo, **walk `testkit/ux/scenarios/W2-01` once to generate fresh content** rather than
rewriting the corpus in place. Rewriting ten records to make a demo work is the kind of thing
that is still true six months later and nobody remembers doing.

## The §5 open question

**Does `reflect` at `SessionEnd` see a linked run's evidence?** It runs against a single
`run_id`. If it does not, linking improves recall but not lesson extraction — fine either way,
but it must be known before it is promised.

Measure it once SC-07 and SC-08 are merged, and **write the answer down** in this runbook and
in SCOPE.md §5 where the question is posed. Do not assume either way; the point of the ticket
is the measurement.
