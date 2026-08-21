# SC-08 end to end: subagents link themselves, and their evidence gets its own lane

Run 2026-08-21 against hosted `api.mubit.ai`, from the merged `plugin-scope-fix` build, with
the plan's end-to-end recipe. One deviation: a scratch `MUBIT_CC_DATA_DIR` plus explicit
credential exports, rather than pointing at `~/.claude/plugins/data/mubit-memory-mubit`. The
plan used the live data dir only so credentials would resolve; exporting them directly is
equivalent and keeps a test run out of the user's real plugin state.

```bash
echo "spawn two subagents in parallel, one to summarise alpha.py and one to summarise beta.py" | \
  claude --print --plugin-dir <branch>/integrations/claude-code \
    --settings '{"enabledPlugins":{"mubit-memory@mubit":false}}' \
    --permission-mode acceptEdits
```

The `--settings` override is required: `--plugin-dir` *adds* a plugin, so without it the
installed copy races the branch build against the same data dir.

## Before and after, same harness

Run once on the integration branch **before** SC-08 merged, and again after:

```
BEFORE   cc-scope-e2e-sub-a21cf4d75121 | linked: false | parent: cc-scope-e2e
         cc-scope-e2e-sub-a7dde3be2221 | linked: false | parent: cc-scope-e2e

AFTER    cc-scope-e2e-sub-a0680a6f5fff | linked: true  | parent: cc-scope-e2e
         cc-scope-e2e-sub-a5d7aaefdb67 | linked: true  | parent: cc-scope-e2e
```

`linked` flips only on a 200 from `POST /v2/control/runs/link`, so `true` here is the
server's answer and not the client's intention. The local ledger holds both ends of the star:

```
cc-scope-e2e.json                  -> linked:e-sub-a0680a6f5fff, linked:e-sub-a5d7aaefdb67
cc-scope-e2e-sub-a0680a6f5fff.json -> linked:cc-scope-e2e
cc-scope-e2e-sub-a5d7aaefdb67.json -> linked:cc-scope-e2e
```

## Each sub-run drains its own lane

```
cc-scope-e2e-sub-a0680a6f5fff: spool=0 jobs=1   job 24288897 items=1 -> completed
cc-scope-e2e-sub-a5d7aaefdb67: spool=0 jobs=1   job c5e4b197 items=1 -> completed
cc-scope-e2e:                  spool=0 jobs=3
```

This is the part the ticket got wrong and the branch caught. A `SubagentStop` is terminal for
its sub-run and the spool is keyed by run id, so neither `--stop` nor `session-end` can ever
see it — both drain the run they derived. One item is far below `batchMaxItems`, so without a
`--run`-pinned drain it would have waited for a trigger that cannot arrive, until `pruneStale`
deleted it at 24 h. `spool=0 jobs=1 completed` per sub-run is that fix working.

## The three queries that show the topology

Driven through `postQuery` directly rather than `recallBlock` — see the note below.

| pinned run | `include_linked_runs` | evidence | `consulted_runs` |
| --- | --- | --- | --- |
| a sub-run | false | 1 | `[sub-a0680a6f5fff]` |
| a sub-run | true | 10 | `[cc-scope-e2e, sub-a0680a6f5fff]` |
| the parent | true | 10 | `[cc-scope-e2e, sub-a0680a6f5fff, sub-a5d7aaefdb67]` |

Row 1 is the plan's assertion: **a query pinned to a sub-run id returns that subagent's own
evidence**, and nothing else. That is the isolation I4 said was impossible without a route —
subagent fan-out no longer pools six streams of work into one undifferentiated run.

Row 3 is the star topology paying off exactly as SCOPE.md I4 predicted: every query
originates at the hub, so `linked_runs_for(parent)` returns all N children **in one hop**, and
the one-hop limit that rules out hub-and-spoke for projects (§6, and why Tier 3 is a mesh) is
no constraint at all here.

Row 2 is worth noting for what it is not: a subagent reads its own lane *and* the parent, but
**not its siblings** — sibling reach would need a second hop. That is the correct behaviour
and the reason `subagent-start.mjs` still queries the parent run deliberately.

## Why `postQuery` and not `recallBlock`

`recallBlock` first returned 0 sources against the same sub-runs, which looked like a scoping
failure and was not. Two of its own filters were in the way, both correct in production and
both wrong for this check:

- it sends `entry_types: ['mental_model', 'rule', 'lesson', 'fact', 'trace']`, and the stored
  subagent item is none of those (`capture.mjs` files a subagent capture as `task_result`);
- the query text has to actually match. "summarise alpha.py and beta.py" retrieved nothing;
  "summarise the python files in this repo" retrieved the turn.

Recorded because the first reading of that zero was "the sub-run lane does not work", and it
would have been wrong. When checking *reach*, ask the route; `recallBlock` answers a different
and narrower question, which is its job.
