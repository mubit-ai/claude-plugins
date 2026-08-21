# SC-09 — Tier 3: the `/mubit-memory:link` surface

**Branch:** `feat/link-command` · **Worktree:** `/Users/eldaru/Mubit/scope-link-cmd`
**Kind:** feat · **SCOPE.md:** §6 Tier 3 · **Depends on:** SC-06 (routes + ledger), SC-05
(`previous_run_id`)

## The design constraint

**Users never see run ids.** `cc-plugin-lab-43f3807e` is a hash of a git toplevel. Any UX
that asks someone to name one is already wrong.

Two things the plugin already has make this tractable:

1. **The session map pairs runs with real paths.** Every entry under
   `<dataDir>/sessions/` carries `run_id`, `project_dir`, `last_seen_at`, `strategy`, `mode`
   (`lib/runid.mjs:413-428`).
2. **The git remote partitions projects correctly.** Measured on this machine: six
   directories, six run ids, two groups — and the grouping is the one a human would draw.

So the picker is over the session map, addressed **by directory**, resolved to run ids
internally.

## The change

### 1. `bin/link.src.mjs` → `bin/link.mjs`

Mirror `bin/auth.src.mjs` → `bin/auth.mjs` exactly, including the esbuild target
(`esbuild.config.mjs:162`).

Subcommands: `list`, `link`, `unlink`. Addressing is by directory. `--json` for machine
output, as `auth.mjs` does, because the skill reads exit codes and structured state.

Rendering, per §6 — directories and dates, never hashes:

```
Memory in this project:  ~/Mubit/plugin-lab

  [x] ~/Mubit/pre-main                    2d ago    same remote
  [ ] ~/Mubit/claude-plugins             11d ago    same remote
  [ ] ~/Mubit/Benchmarking/TBench        18d ago
```

The same surface lists what is currently linked, so reach is always inspectable.

### 2. Mesh, not hub

`linked_runs_for` (`lib.rs:5654`) returns `scope.linked_run_ids` **without walking them** — it
is one hop. So hub-and-spoke does not work as stated: from project A, `consulted_runs` is
`[A, root]` and sibling project B is never reached.

`link` against a group therefore links **each pair**. Same-remote sets are 2–4 in practice, so
O(n²) is a handful of calls. Say this in the module header, with the `lib.rs:5654` citation —
it is the kind of decision that gets "simplified" back into a star by the next reader.

### 3. Offer `previous_run_id` first

When the current run is a `-cN` (SC-05 recorded where it came from), offer that run at the top
of the picker. That is the `/clear` recovery path SC-05's preamble promises in one command,
and it is the single most likely thing the user wants.

### 4. `skills/link/SKILL.md`

One skill covering list / link / unlink. **`disable-model-invocation: true`**, granting only
`Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/link.mjs:*)` — exactly as `skills/auth/SKILL.md` grants
its own binary and nothing else.

§6's *"Not the LLM"* argument is load-bearing and this is what implements it. Put it in the
skill, in the plugin's own voice:

> A link widens what a run may **read**, durably, across future sessions. Handing that to the
> model is the same class of mistake the egress guard just closed in the other direction. The
> asymmetry matters: a bad recall costs one turn of noise; a bad link is silent and permanent
> until someone notices an unrelated project bleeding in.

The model may *notice* and suggest. **A human confirms.** `unlink` is one command.

## Four places that must move in lockstep or the suite fails

| File | Site | Change |
| --- | --- | --- |
| `test/skills.test.mjs` | `:43` `SKILLS` array | add `link` |
| `test/skills.test.mjs` | `:199-205` "exactly the documented skills ship" | 7 → 8 |
| repo-root `.claude-plugin/marketplace.json` | `contextCost` | **re-measure** with `npm run context-cost` |
| `testkit/test/coverage-and-evals.test.mjs` | `:30` | `skills.length` 7 → 8 |

`scripts/verify-manifests.mjs:453` checks that `contextCost` was **measured**, not inherited —
so hand-editing the number fails the check. Run the script.

And a new `testkit/ux/scenarios/W2-07-link-two-projects.md`, because
`testkit/test/coverage-and-evals.test.mjs:36-47` requires **total** scenario coverage of every
skill: an uncovered skill fails the suite even if everything else is green.

## Tests (red first)

`test/skills.test.mjs:43,199-205` and `testkit/test/coverage-and-evals.test.mjs:28-30` pin
today's seven-skill surface. Editing them is the red step.

Then:

- `link.mjs list` renders directories, never run ids — assert no `cc-` hash appears in the
  output, which is the design constraint made executable;
- `link` against a group of three issues three pairwise links, not two spokes;
- `unlink` revokes one pair and leaves the others;
- a `-cN` run offers its `previous_run_id` first;
- the skill's frontmatter carries `disable-model-invocation: true` and grants only its own
  binary. `test/skills.test.mjs` almost certainly has a frontmatter-shape test already —
  extend it rather than writing a second one.

## Verification

Full plugin suite, `npm run context-cost`, `node scripts/verify-manifests.mjs`, the dist
freshness gate, and `node bin/lab.mjs selftest` from `testkit/`.
