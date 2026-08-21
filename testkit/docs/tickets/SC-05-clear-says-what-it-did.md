# SC-05 — `/clear` says what it did, and the memory is recoverable

**Branch:** `fix/run-strategy-and-clear` · **Worktree:** `/Users/eldaru/Mubit/scope-runid`
**Kind:** fix · **SCOPE.md:** I5

## The defect

`lib/runid.mjs:155-159` appends an incrementing `-c1`, `-c2` on
`SessionStart.source === "clear"`, while `resume`, `compact` and `fork` all reuse the mapped
run. So `/clear` starts a session with **no project memory** and **no indication that it did**.

This is a real cross-session failure a user will hit — same machine, same repo, same person —
unlike the one the canary flags. Nothing in `testkit/ux/` covers it.

## The decision

**The reset is defensible; the silence is not.** `/clear` means "forget the thread", and a
user who typed it and then got the thread back would be right to complain. Keep the `-cN`
reset. Make it *said*, and make it recoverable in one command.

## The change

### 1. Record where the memory went

`rememberRun` (`:491-509`) writes the `SessionRecord`. On a clear, record `previous_run_id` —
the run the session was in before the counter incremented.

The record already inherits unknown keys via `...inherited`, so this is purely additive, and
old records read as "unknown" rather than as "moved". Follow the `project_root` field's
precedent (`runid.mjs:415-418`), which documents exactly that property for itself.

Watch the ordering: `rememberRun` receives `prev`, so the previous run id is
`prev.run_id` — but only when this derivation was a clear, and only when `prev` actually
exists. Do not write `previous_run_id` on `startup` (which deliberately discards the
mapping), and do not let a stale `previous_run_id` inherit forward through later non-clear
writes into the same record. A second `/clear` should point at the `-c1` run, not at the
original.

Add the field to the `SessionRecord` typedef (`:410-428`) and to `normaliseRecord`
(`:558-580`), so a record is never half a record.

### 2. Say it, once

`hooks/src/session-start.mjs` — on a cleared session, state it in the preamble, once, naming
the recovery:

> memory for this project was reset by `/clear` — `/mubit-memory:link` reconnects it.

Constraints: SessionStart has pinned sub-budgets (400/600/900 ms, `test/session-start.test.mjs`)
and this must cost nothing measurable — the fact is already in hand from the derivation. One
line, only on a clear, never on `startup`/`resume`/`compact`/`fork`.

### 3. A scenario

New `testkit/ux/scenarios/W2-06-clear-forgets-the-thread.md`, proving **both** halves:

- fresh by default — after `/clear`, the previous session's evidence does not come back;
- recoverable in one command — `/mubit-memory:link` reconnects it.

Match the shape of the existing W2 scenarios exactly (they are parsed by `lib/ux.mjs`; a
malformed one fails `coverage-and-evals.test.mjs`). Note that the second half depends on
SC-09 shipping the `link` skill; write the scenario against the intended surface and say in
its setup block which ticket delivers it.

## Independence

`previous_run_id` is **data only** — no route, no HTTP, nothing from `lib/links.mjs`. This
branch stays independent of `feat/link-run-routes`. SC-09 consumes the field.

## Tests (red first)

`test/runid.test.mjs` already has *"source=clear produces a NEW run id with an incrementing
`-c<n>`"*. Extend it, red first:

- the record written on a clear carries `previous_run_id` naming the run before the clear;
- a second clear points at the `-c1` run, not the original;
- a record written on `startup` / `resume` carries no `previous_run_id`;
- a record written before the field existed still loads, and reads as unknown.

Plus, in `test/session-start.test.mjs`: the preamble names the reset **only** on a clear, and
the sub-budgets still hold.

## Verification

Full plugin suite plus the dist freshness gate — see the register's Verification section.
