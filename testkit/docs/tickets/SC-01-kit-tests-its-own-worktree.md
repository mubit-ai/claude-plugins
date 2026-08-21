# SC-01 — the kit must test the plugin in its own worktree

**Branch:** integration (`plugin-scope-fix`) · **Kind:** fix · **Status:** done (`b293318`)

## The defect

Three call sites hard-coded `/Users/eldaru/Mubit/pre-main` as the plugin under test:

| File | Line | Call |
| --- | --- | --- |
| `testkit/test/coverage-and-evals.test.mjs` | 20 | `resolvePluginDir('/Users/eldaru/Mubit/pre-main')` |
| `testkit/test/negative-controls.test.mjs` | 135 | `resolvePluginDir('/Users/eldaru/Mubit/pre-main')` |
| `testkit/test/parsers.test.mjs` | 91 | `hookBudgets('/Users/eldaru/Mubit/pre-main/integrations/claude-code')` |

In any worktree other than `pre-main` the kit therefore measured a plugin nobody was editing.

## Why it blocks everything else

The coverage matrix exists to fail on the day the plugin surface moves. Pointed at a stale
worktree it reports full coverage of the **old** surface — so SC-09, which adds a skill, would
have passed its `skills.length` assertion against a seven-skill plugin in a different
directory. Every subsequent ticket's testkit assertions would have been silently wrong.

Measured in the integration worktree before the fix:

```
LAB_ROOT              = /Users/eldaru/Mubit/plugin_scope_fix
resolvePluginDir(LAB) = /Users/eldaru/Mubit/plugin_scope_fix/integrations/claude-code
hardcoded today       = /Users/eldaru/Mubit/pre-main/integrations/claude-code
same worktree?        = false
```

## The change

All three read `resolvePluginDir(process.env.MUBIT_LAB_PLUGIN_DIR || LAB_ROOT)`.

No new machinery: `LAB_ROOT` is already exported from `testkit/lib/paths.mjs`, and
`resolvePluginDir` already probes `[base, join(base,'integrations','claude-code')]`, so the
sibling plugin in the same worktree resolves on the second candidate. `MUBIT_LAB_PLUGIN_DIR`
stays as the override for pointing the kit at a plugin elsewhere.

## Verification

`node bin/lab.mjs selftest` — 46/46.

Must land **before** the sub-branches are cut, or they inherit the defect.
