# `claude plugin eval` cases

The host's own plugin-ablation harness, used as the primary A/B path. This directory holds
only the cases; `lib/evals.mjs` holds the wrapper that makes them runnable against a plugin
in another worktree.

## The gate

`plugin eval` is in early access. `CLAUDE_CODE_WALNUT_SPIRE=1` gets past the front-door
check and the command runs its real code path — verified on `claude` 2.1.237:

```
$ claude plugin eval <plug> --case __testkit_probe__
`plugin eval` is currently in early access

$ CLAUDE_CODE_WALNUT_SPIRE=1 claude plugin eval <plug> --case __testkit_probe__
No eval cases found matching --case "__testkit_probe__" under …
```

`lab eval --probe` runs exactly that pair, classifies the result as
`gated | open | open-with-escape`, and writes `gate.json`. It costs nothing — a `--case` that
matches nothing exercises discovery and stops before spawning an agent. Re-probe on every
host upgrade; the escape hatch can close.

## Three things about this harness that are not obvious

All three were read out of the host binary rather than guessed, and each one changes how a
case must be written.

### 1. `--eval-dir` must be relative, below the plugin

```
$ claude plugin eval . --eval-dir /abs/path/to/testkit/evals
Error: --eval-dir must be a relative path inside the plugin (e.g. quality/evals), not absolute
```

A nested relative path **does** work (`--eval-dir testkit/evals` resolves and searches), and
discovery **does** follow a symlink — verified by planting a case with a bad front-matter key
and watching the loader report it through the link.

So `lab install-evals` symlinks this directory to `<plugin>/testkit-evals` and adds
`testkit-evals` to git's exclude file. Note that git reads `info/exclude` from the
**common** dir: writing it to `.git/worktrees/<name>/info/exclude` is silently ignored in a
linked worktree, which is why `uninstall` removes the line as well as the link.

### 2. `execution.env` cannot carry credentials — by design

Every run gets a fresh `HOME`, `CLAUDE_CONFIG_DIR`, `XDG_*` and
`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`. The plugin's stored `credentials.json` lives under the
real `HOME` and is therefore **not there**, so an unwrapped `with` arm carries an
*unconfigured* plugin that dials nothing — an ablation whose treatment is dead, reporting a
delta of zero.

The obvious fix is refused:

```
case "<name>" execution.env key "MUBIT_API_KEY" is not allowed — only EVAL_* keys can be
set from case.yaml. Anything else must come from the operator's shell.
```

`OZT = /^EVAL_[A-Z0-9_]*$/`. The env the sandbox builds is
`{...process.env}` minus a small denylist (`HOMESHARE`, `BASH_ENV`, `ENV`, `ZDOTDIR`, four
`CLAUDE_*` eval internals) plus the sandbox overrides — **`MUBIT_*` is not on any denylist**,
so the operator's shell is a working channel and is the one the error message points at.
`lab eval` is that operator: it exports `MUBIT_ENDPOINT`, `MUBIT_API_KEY`,
`MUBIT_CC_RUN_STRATEGY` and optionally `MUBIT_CC_DATA_DIR` when it spawns the suite.

### 3. The sandbox is stateless, so continuity cannot be proven here

Fresh `HOME` per run means no memory accumulates between runs. Every cross-session case would
be a guaranteed null — not a finding, an artefact. Two responses, and the second is the one
that matters:

- `case.yaml`'s `context.scaffold_script` can seed a data dir, but it needs `--scaffold`,
  which **runs author-supplied bash as you**. Only ever pass it for case files you wrote and
  have read.
- **Cases here are scoped to what a stateless sandbox can honestly prove**: the plugin
  loaded, an MCP tool reached the model, a block was injected, a skill fired, and none of
  that happened in the `without` arm. Continuity stays in `lab ab` and the hand-walked
  `ux/scenarios/W2-*`, where a shared data dir is possible.

## The cases

| Case | Proves | Graders |
| --- | --- | --- |
| `plugin-tools-available` | the MCP server boots in-sandbox and its tools reach the model | `regex` on the reply (with-only) + a baseline `not_contains` |
| `recall-block-injected` | `UserPromptSubmit` puts `<mubit-memory>` in front of the model | `regex` on **`target: trace`** (with-only) |
| `remember-skill-fires` | an explicit standing preference routes to a skill | `tool_used: Skill` (with-only) |
| `doctor-on-empty-memory` | a memory-is-broken complaint reaches a diagnostic | `tool_used: Skill` (with-only) |
| `capture-stays-invisible` | M4 does not surface in the reply | `llm`, scored in **both** arms |

`arm: with-only` marks a grader as a plugin-fired *indicator* rather than part of the score —
the host's own convention under `--ablation with-without`, and the right one: "the plugin's
tool appeared" is not something the baseline arm can be marked down for failing.

`target: trace` is what makes `recall-block-injected` honest. The injected block goes into
context, not into the reply, so a grader reading `last_message` would be scoring whether the
model *mentioned* memory rather than whether memory *arrived*.

`capture-stays-invisible` is scored in both arms on purpose. It is the one case where the
plugin's correct behaviour is to change nothing the user can see, so a delta of zero is a
pass and any delta is the finding.

## Case format

`prompt.md` front matter accepts, verbatim from the loader's own error message:

```
top-level:  schema_version, name, description, tags, plugins, runs, expected_outcome
execution:  model, max_turns, timeout_seconds, allowed_tools, artifact_publish,
            growthbook_overrides, append_system_prompt, env
```

Graders are `graders/<name>.md`; the file name is the grader name and the body is the
`criteria` for `llm` and `baseline`. Types: `llm`, `regex`, `tool_used`, `tool_order`,
`file_exists`, `baseline`. `target`/`focus` is `trace | last_message | files | {source: file,
path}`. `arm` is `with-only | both`.

## Status: wired, not yet detecting

The pipeline is proven end to end — install, run, ablate, write `aggregate-result.json`,
uninstall — over three real runs on `claude` 2.1.237. What is **not** yet proven is that any
case detects the plugin. All three runs came back:

```
score 1 · pass rate 1 · meanDelta 0
  SILENT   plugin-tools-available · calls-the-status-tool — called 0x (expected 1..∞)
```

`meanDelta 0` with every indicator silent is **not** a null result, and `lab eval` now exits
non-zero and prints `VOID` rather than letting it read as one. Two causes were ruled out
along the way:

- **Not the sandbox.** Reproducing the eval's exact environment (fresh `HOME`,
  `CLAUDE_CONFIG_DIR`, `XDG_*`, `--setting-sources user`) shows the plugin loading normally:
  `mcp_servers: [{name: "plugin:mubit-memory:mubit", status: "connected"}]`, 10 tools, 7
  skills.
- **Not a missing grant** — though it was *a* bug. `--allow-tools mcp__*` is **refused**
  ("a wildcard tool name it does not support"), so the first two runs really did hand the
  model no MCP tools. `mcpToolNames()` now derives the concrete
  `mcp__plugin_<plugin>_<server>__<tool>` names offline and the selftest pins them against
  names captured from a real `system/init`. The indicator stayed silent after the fix, so
  this was necessary but not sufficient.

The remaining suspect is case design under `--permission-mode dontAsk`, which the harness
sets unconditionally. Diagnosing it needs the trace, which is why `lab eval` now always
writes `--debug-file eval-debug.log` and takes `--keep-temp` (the harness deletes the temp
dir that `tracePath` points into).

Until an indicator fires, **treat every number from this path as unproven** and use
`lab ab`, whose arm verification is independently confirmed.

## Running it

```bash
node ../bin/lab.mjs eval --probe                    # free
node ../bin/lab.mjs eval --plugin-dir "$V"          # preflight-gated, installs and cleans up
```

`lab eval` passes `--threshold 0` deliberately. The default of `1.0` exits non-zero whenever
any case scores below perfect, which turns a partial-credit ablation into a hard failure and
hides the numbers the run was for. The gate that *does* matter is
`suite.plugins[].problem` — `manifest_invalid`, `disabled_by_default`, `will_not_load` — and
`lab eval` refuses the result outright when it is set, because a delta measured with a plugin
that never loaded is not a null result.
