# W2-02 — Switching branch or directory mid-session

**Family** W2 cross-session continuity · **Moments** M2* · **Sessions** 1 · **Duration** ~7 min

**Backend** hosted · **Arms** plugin-on, plugin-off

## What this proves

That `CwdChanged` re-derives the run identity when the ground moves, and that memory follows
the new location — or deliberately does not — rather than continuing to answer about the old
one. A recall scored against `repo:` tags from the wrong repository is worse than one scored
against no tags at all.

## Setup

W2-01's Setup, with `TK=/tmp/tk-w2-02` and `MUBIT_CC_RUN_ID` **unset** — this scenario is
about run derivation, so pinning the run id would defeat it. Set
`MUBIT_CC_RUN_STRATEGY=git-branch`. Create a second repo:

```bash
mkdir -p "$TK/repo2" && cd "$TK/repo2" && git init -q
printf 'def greet(n):\n    return f"hi {n}"\n' > greet.py
git add -A && git -c user.email=t@example.com -c user.name=t commit -qm init
```

## Steps

1. Open a session in `$REPO` with `--debug-file "$TK/s1.log"`.
2. Prompt: `What is this project?`
3. `/cwd $TK/repo2` (or use `cd` through the host's directory switch).
4. Prompt: `And what is this one?`
5. `/exit`, then `node "$PLUG/scripts/mubit-inspect.mjs" --data "$DATA" --runs`

## Expect

Two runs listed, one per repository, and the step-4 injection scoped to `repo2`. A single run
spanning both is the failure this scenario looks for.

## Touchpoints

```
hooks:  SessionStart, CwdChanged*, UserPromptSubmit, PostToolUse, Stop, SessionEnd
tools:  —
skills: —
config: runStrategy
```

## Pass / fail

1. `--runs` lists two runs after step 5. **Hard** under `runStrategy=git-branch`.
2. The step-4 injection contains nothing about the first repository. **Hard.**
3. `CwdChanged` does not overrun its 5 s budget.

## Known-not-bugs

- **One run under `runStrategy=static`.** That is what static means. `git-branch` and
  `per-directory` are the two that split on a directory change, because both hash the
  repository root; only `git-branch` also splits on a branch change within one repo.
- **This scenario used to be configured with `runStrategy=repo`, which is not a strategy.**
  `lib/runid.mjs:53` allows only `per-directory`, `git-branch`, `per-conversation` and
  `static`, and `normaliseStrategy` mapped the unrecognised value onto the `per-directory`
  default with no error and no log line. So every run of this scenario was made under
  `per-directory`, where switching branch does **not** move the run id, and it would have
  passed while demonstrating the opposite of its own claim. SC-04 fixed both halves: the
  value here is now `git-branch`, and the plugin warns once — naming the value and the four
  legal strategies — the first time a session derives a run id from an unrecognised one.

## If it fails

| Symptom | Check | Cause |
| --- | --- | --- |
| one run | `MUBIT_CC_RUN_ID` still exported | a leftover pin from another scenario |
| cross-repo memories in step 4 | `mubit-inspect --cross-run` | `env_tags` derived from the session's launch directory rather than the prompt's |

## Teardown

`rm -rf /tmp/tk-w2-02` and unset the `MUBIT_*` exports.
