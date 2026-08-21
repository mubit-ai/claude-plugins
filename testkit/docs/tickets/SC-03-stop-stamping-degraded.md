# SC-03 — stop stamping `degraded: true` for the shipped configuration

**Branch:** `fix/testkit-canary-split` · **Worktree:** `/Users/eldaru/Mubit/scope-canary`
**Kind:** fix · **SCOPE.md:** §8.3 · **Depends on:** SC-02

## The defect

`degraded` is `!pre.ok` at `testkit/bin/lab.mjs:203`, `:393`, `:424`. While the canary is red
for a by-design reason, every recorded run is stamped degraded — and `compare` then treats it
as untrustworthy. An A/B measured while instance-wide sharing is off is measuring the
**shipped configuration**, and it is trustworthy.

Once SC-02 lands, `pre.ok` no longer goes false for state 3 and this mostly follows. Confirm
it does, and pin it with a test rather than assuming.

**Keep** the hard-coded `degraded: true` at `:421` — that is the eval VOID path, where the
arm genuinely did not measure what it claims, and it is correct.

## Two loose ends in the same file

1. **`README.md:112`** claims `compare` *"refuses to place that run beside a trusted one"*.
   `bin/lab.mjs:575` only WARNs — and `:627` merely stamps `trusted: !summary.degraded` on the
   index row. Make the doc match the code: the code is the honest behaviour here (refusing
   outright would strand a legitimately-degraded overhead measurement, which is a real and
   useful number), so change the prose, not the guard.

   The same claim is repeated in `bin/lab.mjs:18`'s header comment. Both must move together,
   or the next reader finds the corrected README and the stale comment and believes the
   comment.
2. **`lib/arms.mjs:207` `KIT_OWNED_ENV`** does not list `MUBIT_MCP_LESSON_SCOPE`. The SC-11
   B1 experiment exports it, and the moment it does, `checkEnvHygiene`
   (`lib/preflight.mjs:61-67`) reports it as a leak and blocks the sweep. Add it.

   This is not weakening the hygiene check: `KIT_OWNED_ENV` is the list of variables the kit
   sets deliberately, and B1 makes this one of them. The check still catches an ambient
   `MUBIT_ENDPOINT`, which is the leak it was built for.

## Tests (red first)

- `degraded` is false for a preflight whose only non-blocking check is `cross-run-overlay`;
- `degraded` stays true on the eval VOID path;
- `envLeaks()` does not report `MUBIT_MCP_LESSON_SCOPE`.

## Verification

`node bin/lab.mjs selftest`, and a `grep -n 'refuses to place' README.md` returning nothing.
