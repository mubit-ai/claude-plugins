# W1-02 — A small feature over six turns

**Family** W1 everyday coding · **Moments** M2* · **Sessions** 1 · **Duration** ~10 min

**Backend** hosted · **Arms** plugin-on, plugin-off

Recall fires before **every** prompt, with no relevance gate. Six turns is where that becomes
a cost rather than a feature, and where the seen-set has to earn its place.

## What this proves

That injected tokens *fall* across a session as the seen-set degrades repeats into one-line
pointers, instead of re-paying full price for the same memories six times. This is the
difference between a plugin that costs 150 tokens a session and one that costs 900.

## Setup

W2-01's Setup, with `TK=/tmp/tk-w1-02` and `MUBIT_CC_RUN_ID=tk-w1-02`. Seed the account
first by walking W2-01 once, or this scenario has nothing to repeat.

## Steps

1. Open a session with `--debug-file "$TK/s1.log"`.
2. Six prompts, in order, each a small step on the same feature:
   - `Add a subtotal(items) function to cart.py.`
   - `Add a tax(subtotal, rate) function.`
   - `Make total() use both.`
   - `Add tests for the two new functions.`
   - `Run the tests.`
   - `Tidy up the docstrings.`
3. `/exit`, then read the per-prompt series:

```bash
node -e '
const t=require("fs").readFileSync(process.env.TK+"/s1.log","utf8");
for (const m of t.matchAll(/mubit: (\d+) memor\S+ · ([\d.]+k?) tok · (\d+)ms/g))
  console.log(`${m[1]} src  ${m[2]} tok  ${m[3]}ms`);'
node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --run tk-w1-02 --last 10
```

## Expect

Six `mubit:` lines. The `tok` column should be highest on turn 1 and lower by turn 6, with
the `pointers` column in `mubit-inspect` rising to explain why. A flat `tok` across six turns
means the seen-set is not being read.

## Touchpoints

```
hooks:  SessionStart, UserPromptSubmit*, PostToolUse, Stop, SessionEnd
tools:  —
skills: —
config: recallRepeatMode, recallTokenBudget, recallMaxPerSection, recallAsync
```

## Pass / fail

1. Six injections, one per prompt. **Hard** — a missing one means a hook was killed.
2. `tok` on turn 6 is not greater than `tok` on turn 1. **Hard.**
3. `pointers` in `mubit-inspect` is greater than zero by turn 3, and explains the fall.
4. Total injected tokens for the session are under `recallTokenBudget` × 6.

## Known-not-bugs

- **`tok` rises on turn 4.** A genuinely new topic can legitimately pull new memories. Read
  `pointers` alongside it before calling it a regression.
- **Turn 5 injects nothing.** `Run the tests` is short and generic; an empty block is
  cheaper than a bad one.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| flat `tok` | `--json` → `turns[].pointers` all 0 | the seen-set file is unreadable; `lib/seen.mjs` is total and fails to the expensive path |
| rising `tok` | `recallRepeatMode` | set to `full`, which is the upper-bound arm, not the default |

## Teardown

`rm -rf /tmp/tk-w1-02` and unset the `MUBIT_*` exports.
