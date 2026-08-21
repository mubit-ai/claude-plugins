# SC-08 — Tier 1: subagents link automatically

**Branch:** `feat/subagent-link` · **Worktree:** `/Users/eldaru/Mubit/scope-subagent`
**Kind:** feat · **SCOPE.md:** I4, §6 Tier 1 · **Depends on:** SC-06 (`postLinkRun`)

## The gap

Everything needed is already on disk. `hooks/src/subagent-start.mjs:276-318` writes
`runs/<parent>/subagents/<sub_run_id>.json` holding **both ends of the join** — `sub_run_id`,
`parent_run_id`, both agent ids, the parent `prompt_id`, the exact `refIds` served — and ends
with `linked: false` at `:311`, described in its own header as a deliberate IOU:

> So the isolation is local for now, and the record is the thing that makes the gap
> recoverable later rather than lost […] `linked: false` states the gap in the data rather
> than leaving a reader to infer it from an absent field.

There is now a route. Pay the IOU.

**The topology fits the one-hop limit natively.** A parent with N subagents is a star and
every query originates at the hub, so `linked_runs_for(parent)` returns all N children in one
hop. No mesh needed here — that is SC-09's problem, not this one.

## The change

### 1. Link the sub-run to its parent

Call `postLinkRun(cfg, { run_id: parentRunId, linked_run_id: subRunId })` after the record is
written (`subagent-start.mjs:191`).

- **Flip `linked` to `true` only when the call returns ok**, so the field keeps meaning what
  it says. A record claiming a link that does not exist is worse than one admitting it does
  not — the whole value of this file is that a later reader can trust it.
- Fire-and-forget within the **existing** hook budget. Do not extend it; `SubagentStart` is on
  the spawn path and a slow link would be paid by every subagent.
- A failed link is a `warn`, never a hook failure. `lib/hook.mjs` discipline: never exit
  non-zero, never let a network fault cost the spawn.

The write ordering matters: the record must be on disk before the link is attempted, so a
crash mid-call leaves a recoverable `linked: false` rather than nothing.

### 2. Subagent evidence lands in its own lane

`hooks/src/capture.mjs:240` derives the **parent** run for `--subagent`:

```js
const runId = attempt(() => deriveRunId(cfg, payload), '');
```

Switch it to `deriveSubRunId(runId, payload)` for the `subagent` mode only, so a subagent's
evidence lands under its own run id — which is now rejoinable, because Tier 1 links it.

`deriveSubRunId` is idempotent and answers the parent unchanged when the payload carries no
subagent identity, so the fallback is already correct.

**Keep the identity in `metadata_json`** (`capture.mjs:430-455`). It is what makes a
`SubagentStop` matchable against the host's own `agent_id`, and it is independent of which run
the item is filed under.

### 3. The comments that say this cannot be done

Three places state the absence as a design fact and will be wrong once this lands:

- `lib/runid.mjs:363-368` — *"**Never query against it.** A sub-run id has no memory stored
  under it… until there is a route that can join it back up. There is not one today"*;
- `hooks/src/subagent-start.mjs:251-269` — the `linked: false` header;
- `hooks/src/subagent-start.mjs:168` — `runId, // the PARENT run: nothing is stored under a
  sub-run id (§4.3)`.

Update all three. A stale comment asserting the opposite of the code is worse than no comment,
and these are load-bearing ones that the next reader will believe.

Note that `subagent-start.mjs:167` **still queries the parent run** deliberately — a subagent
should read everything the parent can. It is the *write* side that moves. Say so, or the
updated comment will read as though recall moved too.

## Tests (invert first)

`test/subagent-start.test.mjs:522-548` asserts `linked === false`, and `:355` is the other
site. Invert them — that is the red step.

Then:

- a successful link flips `linked` to `true` and hits `/v2/control/runs/link` with parent and
  sub ids (assert the body `fakeMubit()` received);
- a **failed** link leaves `linked: false` and the hook still succeeds — assert the hook
  contract via `assertHookContract`, and that the exit code is 0;
- `capture.mjs --subagent` files under the sub-run id, and a payload with no subagent identity
  still files under the parent;
- the `SubagentStart` budget still holds (`assertWithinBudget`).

## Verification

Full plugin suite plus the dist freshness gate. Then the end-to-end drive in the register —
`runs/cc-scope-e2e/subagents/*.json` must carry `linked: true`.
