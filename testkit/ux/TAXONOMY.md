# The UX taxonomy

Testing this plugin has, until now, been organised by **plugin feature**: 13 hook
registrations, 10 MCP tools, 7 skills, each with a runbook section proving it fires. That
answers "does the surface work". It cannot answer "is the product good", because no user has
ever sat down to exercise a hook.

This directory is organised the other way round: by **what the user came to do**. The two
axes below turn that into a grid, and a grid is the only shape in which a gap is visible.
A list of eighteen scenarios looks complete no matter what is missing from it; a grid with a
blank cell does not.

## Axis A — workflow family

What the user is actually doing when the plugin is running.

| ID | Family | The representative session |
| --- | --- | --- |
| **W1** | Everyday coding | a bugfix or small feature in a repo you already know |
| **W2** | Cross-session continuity | session 1 teaches, a fresh session 2 should already know |
| **W3** | Onboarding | first contact with a repo you have never seen |
| **W4** | Non-code | design, planning, docs, research |

## Axis B — the memory moment

The eight points at which the plugin can help, annoy, or do nothing. These come from the
plugin's own lifecycle rather than from a taxonomy of user feelings, so every one of them is
observable on disk.

| # | Moment | The question it asks | Surface |
| --- | --- | --- | --- |
| **M1** | Session opening | did it start knowing anything | `SessionStart` steer block + global lessons |
| **M2** | Pre-prompt recall | did it come back unasked | `UserPromptSubmit` → `<mubit-memory>`, blocking |
| **M3** | Mid-task warning | did it stop me doing something wrong | `PreToolUse` `<mubit-rules>` — **off by default** |
| **M4** | Capture | did anything worth keeping get kept | `PostToolUse` / `Stop` / failures — invisible, and must stay so |
| **M5** | Compaction | did it survive the context being thrown away | `PreCompact` checkpoint — the only user-visible failure message |
| **M6** | Session end | did this session's knowledge escape this session | `SessionEnd` detached reflect — the only promotion path |
| **M7** | Cross-session payoff | did the promotion actually pay off later | recall in a *later* session returning what M6 promoted |
| **M8** | Degraded | what happens when it cannot work | offline / auth failed / policy denied / dry streak |

Every scenario declares exactly one **primary** moment, marked `*`, and any number of
secondary ones. A family with no scenario at a moment has an untested path through the
product — which is a more interesting fact than the scenario count, and is why the generated
grid below leads with moments rather than with scenarios.

## Two deliberate negatives

W3-01 (a cold repo, where recall correctly returns nothing) and W4-03 (a planning session
that calls no tools) are **negative** scenarios. A suite made only of happy paths cannot
distinguish "works" from "reports success unconditionally", and the two most common real
sessions — the first hour, and thinking without editing — are both cases where the right
behaviour is to do very little, visibly and cheaply.

W3-04 is a third: it needs no working backend at all, which makes it the only scenario that
can still be walked on a day when the hosted instance is down and everything else is void.

## Scenario file format

Fixed, so scenarios are diffable across plugin versions and machine-checkable. Nine sections:

```
# <id> — <title>
**Family** … · **Moments** …* · **Sessions** … · **Duration** …
## What this proves
## Setup            one copy-paste block ending in a known-good state
## Steps            numbered; each is an exact paste or an exact prompt
## Expect           per step; a recorded transcript where one exists
## Touchpoints      a fenced block: hooks / tools / skills / config, `*` marks the primary
## Pass / fail      numbered, each independently checkable, marked Hard or Soft
## Known-not-bugs   things that look wrong and are not
## If it fails      the two or three known causes, with the check that distinguishes them
## Teardown
```

`Expect` blocks should be **recorded transcripts, not predictions** — the standard the
existing runbooks in `docs/manual-test-*.md` already set. Numbers that vary per machine are
marked `(varies)`.

The `## Touchpoints` fence is parsed by `lab ux --check`, which cross-references it against
the plugin's own `hooks/hooks.json`, `scripts/context-cost.json` and `skills/`. A scenario
naming something the plugin does not have **fails the check**. That is the drift alarm: when
0.11.0 renames a hook, this breaks the same day rather than quietly reporting coverage of a
surface that moved.

## Seeding

W2 and W3-02 need memory that already exists. Two mechanisms:

- **The honest path** — walk W2-01 once and let `SessionEnd` promote. Slower, and it
  exercises M6 as a side effect.
- **The fast path** — a scripted `mubit_learned` write. Each scenario states which it uses,
  and the fast path is marked as **not** exercising M6.

## Relationship to the existing runbooks

These scenarios do not restate the feature-axis suites, they cross-link to them.
`docs/manual-test-0.10.0.md` remains the authority on individual surfaces — its §3, §9 and
§10 are the source for the M8 and M5 expectations here — and `manual-test-all.md` with
`hs-1..7` remains the offline hook-surface suite. What is new here is only what the workflow
axis has no existing coverage for, which is most of W1, W3 and W4.

---

<!-- generated: coverage -->

## Coverage — generated against 0.10.0 (05adfe0)

### Moments × families

A blank cell is an untested path, not an omission. `*` marks the scenario whose
primary moment this is.

```
moment                        W1                   W2                    W3                   W4                  
──────  ────────────────────  ───────────────────  ────────────────────  ───────────────────  ────────────────────
M1      Session opening       W1-01                W2-01                 —                    —                   
M2      Pre-prompt recall     W1-01 W1-02* W1-05*  W2-01* W2-02* W2-04*  W3-01*               —                   
M3      Mid-task warning      W1-04*               —                     —                    —                   
M4      Capture               W1-01* W1-03*        W2-01 W2-05*          —                    W4-01* W4-02* W4-03*
M5      Compaction            —                    W2-03*                —                    —                   
M6      Session end           W1-01 W1-03          W2-01                 —                    W4-04*              
M7      Cross-session payoff  —                    W2-01                 W3-02*               —                   
M8      Degraded              —                    —                     W3-01 W3-03* W3-04*  —                   
```

### Touchpoints × scenarios

`X` is the scenario primarily about that touchpoint; `x` merely exercises it.

```
touchpoint                 kind    1-01  1-02  1-03  1-04  1-05  2-01  2-02  2-03  2-04  2-05  3-01  3-02  3-03  3-04  4-01  4-02  4-03  4-04
─────────────────────────  ──────  ────  ────  ────  ────  ────  ────  ────  ────  ────  ────  ────  ────  ────  ────  ────  ────  ────  ────
CwdChanged                 hooks                                       X                                                                     
PostCompact                hooks                                             x                                                               
PostToolUse                hooks   x     x     x     x     x     x     x     x     x     x     x     x     x     x     X     X           x   
PostToolUseFailure         hooks   X                                                                       x                                 
PreCompact                 hooks                                             X                                                               
PreToolUse                 hooks                     X                                                     x                                 
SessionEnd                 hooks   x     x     x                 x     x     x           x     x     x           x     x     x     x     x   
SessionStart               hooks   x     x                       x     x     x     x           X     x           X     x           x         
Stop                       hooks   x     x     x     x     x     x     x     x     x     x     x     x     x     x     x     x     X     x   
StopFailure                hooks   x                                                                                                         
SubagentStart              hooks                                                   X                                                         
SubagentStop               hooks                                                   x                                                         
UserPromptSubmit           hooks   x     X     x     x     x     X     x     x     x     x     x     X     x     x     x     x     x     x   
mubit_archive              tools                                                         x                                                   
mubit_dereference          tools                           x                                                                                 
mubit_diagnose             tools                                                                           X                                 
mubit_forget               tools                                                         X                                                   
mubit_learned              tools               X                                                                                             
mubit_lessons              tools                                                                                                         x   
mubit_outcome              tools                                                         x                                                   
mubit_recall               tools                           X                                                                                 
mubit_reflect              tools                                                                                                         X   
mubit_status               tools                                                                           x     x                           
auth                       skills                                                                                x                           
doctor                     skills                                                                          x                                 
forget                     skills                                                        x                                                   
recall                     skills                          x                                                                                 
reflect                    skills                                                                                                        x   
remember                   skills              x                                                                                             
setup                      skills                                                                                x                           
apiKey                     config                                                                          x     x                           
capture                    config  x                                         x                                         x     x     x         
endpoint                   config                                                                          x     x                           
mcpLessonScope             config              x                                                                                             
outcomeMode                config                                                        x                                                   
preToolWarnings            config                    x                                                                                       
recallAsync                config        x                       x           x                 x                                             
recallMaxPerSection        config        x                                                                                                   
recallRepeatMode           config        x                       x                                                                           
recallTokenBudget          config        x                 x                       x                                                         
redact                     config  x                                                                                   x     x               
reflectOnEnd               config              x                 x                                   x                             x     x   
runStrategy                config                                x     x                                                                     
sessionEndDetach           config                                x                                   x                                       
statusLine                 config                                                              x                                             
subagentRecallTokenBudget  config                                                  x                                                         
```

18 scenarios · hooks 13/13 · tools 10/10 · skills 7/7

**Untested:** `mcpTools`, `recall`, `recallAssemble`, `userId`. Config keys with no scenario are a deliberate tail — they are levers, not surfaces, and the A/B arms in `lib/arms.mjs` cover the ones that move a number.

<!-- /generated -->

Regenerate the block above with:

```bash
node testkit/bin/lab.mjs ux --plugin-dir <target> --check --write
```
