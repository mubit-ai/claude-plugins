# Mubit Memory — Quickstart

Persistent memory for **Claude Code** and the **Codex CLI**. It captures your work
automatically, injects the relevant past lessons before each prompt, and learns which
memories actually helped.

It is one plugin built twice. A Codex session and a Claude Code session started in the
**same directory are one Mubit run, sharing one memory** — that is the point, not a
side effect.

**Requirements:** Node >= 20, and Codex CLI >= 0.146.0 if you use that side. No build step,
no `npm install` — the bundles ship committed.

| Plugin | Version | Built for |
| --- | --- | --- |
| [`mubit-memory`](integrations/claude-code/) | 0.12.4 | [Claude Code](integrations/claude-code/) · [Codex CLI](integrations/codex/) |

You need two values before you start:

| Value | Example |
| --- | --- |
| endpoint | `https://api.mubit.ai` — your Mubit instance URL |
| API key | `mbt_...` — issued in the [Mubit console](https://console.mubit.ai) |

---

## Part 1 — Claude Code

### Install

```
/plugin marketplace add mubit-ai/plugins
/plugin install mubit-memory@mubit
/reload-plugins
```

Then **start a new Claude Code session.**

`/reload-plugins` registers the hooks but does not fire `SessionStart`, so until a new
session begins the plugin has never actually run — no run id, nothing on the status line.
It looks broken and it is fine.

### Connect it — enter your API key directly

Set the endpoint and key yourself, one of three ways.

**A. Plugin settings — recommended.** `/plugin` → **Mubit Memory** → **configure**, then fill
in `endpoint` and `apiKey`. The key field is marked sensitive, so it goes into your OS keychain
rather than any file. Best home for a long-lived install, and it takes precedence over
everything else.

**B. Environment variables — good for CI, containers, SSH.**

```bash
export MUBIT_ENDPOINT='https://api.mubit.ai'
export MUBIT_API_KEY='mbt_...'
```

Set these in your shell profile (or CI secrets) before starting Claude Code.

**C. Per-project file.** `${CLAUDE_PROJECT_DIR}/.mubit-cc.json`:

```json
{
  "endpoint": "https://api.mubit.ai",
  "apiKey": "mbt_..."
}
```

Lowest precedence of the three. Do not commit it — the key is a secret.

**Precedence, highest first:** plugin settings → `MUBIT_*` env vars → a stored
`credentials.json` → `.mubit-cc.json` → defaults.

---

## Part 2 — Codex CLI

### Install

Same shape as Claude Code — the marketplace is fetched straight from GitHub, no clone:

```bash
codex plugin marketplace add mubit-ai/plugins
codex plugin add mubit-memory@mubit
```

Requires Codex CLI >= 0.146.0, which is where Git marketplace sources landed. Pin a ref with
`--ref <tag>` if you want a specific release rather than `main`.

### Then run setup — this step is not optional

```bash
PLUGIN=$(ls -d ~/.codex/plugins/cache/mubit/mubit-memory/*/ | tail -1)
node "$PLUGIN/scripts/setup.mjs" "$PLUGIN"
```

(`codex plugin add` printed that path as `Installed plugin root:` — the glob just saves you
copying it. The version is whatever you installed, not a fixed number.)

(Or just ask a Codex session to run `mubit-memory:setup`.)

Skipping it gives you a plugin that installs perfectly and **captures nothing**. Two facts
about Codex make it necessary: a plugin-bundled `hooks.json` is inert — Codex copies it and
never reads it — and a plugin-declared MCP server cannot resolve its own entry point, since
there is no `${VAR}` substitution and relative paths resolve against the *project* directory.

So `hooks.json` and `.mcp.json` ship as **templates**, and `setup` installs them into the user
layer with absolute paths substituted: registrations merge into `$CODEX_HOME/hooks.json`, and
the server is registered with `codex mcp add mubit`. It merges rather than overwrites, backs up
what it touches to `<name>.before-mubit`, and is idempotent — **re-run it after every upgrade.**

**Trust the hooks.** A registered hook does not run until trusted, and under `codex exec` an
untrusted hook is skipped *silently* — no prompt, no warning, exit 0. `setup` offers to record
trust and asks first; otherwise run `/hooks` in the TUI and approve the Mubit entries. Trust
must be re-granted after an upgrade, because editing a registration changes its content hash.

### Connect it — enter your API key directly

A fresh install has no credentials. `setup` says so, and it is not an error:

```
no credentials.json here yet.
```

If you also run the Claude Code plugin, it already wrote a key into the shared data dir and
you are done. **From scratch, enter the key yourself.** Two ways.

**A. Store it once, verified — recommended.** `login` asks for the key, checks it against your
instance before writing anything, and puts it exactly where the hooks read:

```bash
PLUGIN=$(ls -d ~/.codex/plugins/cache/mubit/mubit-memory/*/ | tail -1)
node "$PLUGIN/scripts/login.mjs"
```

Paste your key at the prompt. Non-interactively, pass it instead:

```bash
node "$PLUGIN/scripts/login.mjs" --key=mbt_...
```

`--endpoint=<url>` is only needed if you are not on the default `https://api.mubit.ai`.

`Connected to https://api.mubit.ai.` means the key is valid and stored. Anything else is the
key or the endpoint, not the plugin — see the table in Part 3.

`--status` reports what is stored and which directory it came from; add `--json` for
machine-readable output. It reads the file and does **not** dial, so it tells you a key
exists, never that it works. Only `login` and `setup` actually reach the instance.

**Where it writes, and why that needed its own command.** Mubit state lives under
`~/.claude/plugins/data/` on both harnesses, deliberately — one directory is what makes a
Codex session and a Claude Code session in the same project one memory rather than two, so a
Codex-only user ends up with a `~/.claude/` they never asked for. Which subdirectory is not a
constant: the suffix varies with the install (`mubit-memory-<marketplace>`,
`mubit-memory-inline`, …). `setup` resolved it and **pinned** it as `MUBIT_CC_DATA_DIR` in the
registrations it wrote, so the hooks never guess — and `login` reads that same pin back out of
`$CODEX_HOME/hooks.json` rather than guessing on its own. Override it with `--data-dir=<path>`
if you must.

The generic `bin/auth.mjs` has no such pin and falls back to the bare
`~/.claude/plugins/data/mubit-memory`, which is often not the directory `setup` chose — the key
then lands where nothing reads it, silently, with no error. That is the whole reason `login`
exists; prefer it under Codex.

**B. Environment variables — nothing stored on disk.** Good for CI and containers, and it
outranks the stored file:

```bash
export MUBIT_ENDPOINT='https://api.mubit.ai'
export MUBIT_API_KEY='mbt_...'
```

Codex runs hook commands through a **login shell**, so anything exported in `.zshrc` or
`.bashrc` reaches the plugin. Convenient, and occasionally surprising: a stale
`MUBIT_ENDPOINT` left over from a local-server session outranks the key you signed in with.

Codex has no plugin settings UI, so configuration is three rungs, highest first:

1. `MUBIT_*` environment variables
2. `<data-dir>/credentials.json` — what option A writes
3. `<project>/.mubit-cc.json`

Either way, **start a new Codex session afterwards** — hooks and MCP servers are read at
session start.

### A few Codex-specific things

- **An unapproved command has no network.** Codex runs it inside seatbelt with networking off,
  where DNS fails first, so any plugin command you have not approved reports a connection
  failure against an endpoint that is perfectly fine. Approve it and run it again. See
  [`ENOTFOUND` under Codex](#enotfound-under-codex--usually-the-sandbox-not-the-endpoint).
- **State lives under `~/.claude/plugins/data/`** — yes, `.claude`, deliberately: that shared
  data dir is what makes one memory rather than two. Which subdirectory is not a constant
  (`mubit-memory-<marketplace>`, `mubit-memory-inline`, …); `setup` resolves it and pins it as
  `MUBIT_CC_DATA_DIR`. Getting it wrong is quiet and total — two half-memories, no error. Check
  with `ls ~/.claude/plugins/data/` and pass `--data-dir=<path>` if it picked wrong.
- **`SessionEnd` is clamped to three seconds** by Codex. The end-of-session flush is handed to a
  detached process, which is why `MUBIT_CC_SESSION_END_DETACH` defaults on. On a long session,
  run `mubit-memory:reflect` yourself rather than relying on the exit path.
- The status line defaults **off** under Codex — its status line is a fixed list of built-in
  items with nothing scriptable in it.

---

## Part 3 — Confirm it works (both)

Claude Code: `/mubit-memory:setup` · Codex: `mubit-memory:setup`

A `ready` state plus your endpoint and a run id means you are done. Anything else:

| Result | Meaning |
| --- | --- |
| `auth_failed` | Key missing, wrong, or revoked. Not a network problem. |
| `unreachable` | Wrong endpoint, the instance is not running — or, under Codex, the sandbox. See below. |
| `warming` | Instance still starting. Wait and retry — not a failure. |
| `not_responding` | Timeouts, usually load. Retry before concluding anything. |

Stuck? `mubit-memory:doctor` runs the full diagnosis, cheapest check first. Under Codex its
step 0 is the Codex-specific one: hooks that were never trusted.

### `ENOTFOUND` under Codex — usually the sandbox, not the endpoint

```
POST /v2/control/activity: this process has no network access — Codex ran it
inside its sandbox. Approve the command and run it again; the endpoint is
almost certainly fine
```

Codex runs a command you have not approved inside seatbelt with the network switched off, and
DNS is the first thing that fails in there. So a plugin command dialling a perfectly healthy
endpoint comes back `ENOTFOUND`, and the same command run again after you approve it succeeds.

**Approve the command.** Nothing needs fixing. The giveaway that memory itself is fine is in
the session you are already in: if `SessionStart` said `Mubit memory is active` and recall
injected anything at all, the hooks are connected and only this one sandboxed process was not.

Versions before 0.12.2 reported the same failure as `no such host — the endpoint name does not
resolve; check it for a typo`, which sends you to fix a URL that was never wrong. If you see
that wording against an endpoint you believe in, upgrade rather than editing your config.

Outside the sandbox `ENOTFOUND` does mean the name is wrong. Only `api.mubit.ai` is
provisioned — `eu.mubit.ai` and `us.mubit.ai` do not exist, so a stored endpoint naming one can
never answer. Re-run `login` with no `--endpoint` to reset it to the default, and check for a
stale `export MUBIT_ENDPOINT` in `.zshrc` or `.bashrc`: Codex runs hooks through a login shell,
so that variable outranks anything `login` stores.

### "no Mubit endpoint is configured"

```
POST /v2/control/activity: no Mubit endpoint is configured; nothing was dialed
```

The install worked and the key was never stored. Nothing reads an endpoint out of thin air:
a plugin command finds it in `credentials.json` inside the pinned data directory, or in
`MUBIT_*` env vars, and finds nothing otherwise. Go back to **Connect it** and run `login`.

Under Codex this can surface as `(no output)`: these commands write failures to **stderr** and
leave stdout empty, so a tool call that only surfaces stdout shows an empty result rather than
the reason. Re-run with `2>&1` to see it.

Confirm what is actually stored, and where it was read from:

```bash
node "$PLUGIN/scripts/login.mjs" --status
```

If your installed plugin predates `scripts/login.mjs`, upgrade it first — see below.

### Upgrading, or installing on a second machine

Claude Code:

```
/plugin marketplace add mubit-ai/plugins
/plugin install mubit-memory@mubit
/reload-plugins
```

Then start a **new** session, for the reason in Part 1.

Codex:

```bash
codex plugin marketplace upgrade      # refreshes the Git snapshot — this is what fetches new commits
codex plugin add mubit-memory@mubit

PLUGIN=$(ls -d ~/.codex/plugins/cache/mubit/mubit-memory/*/ | tail -1)
node "$PLUGIN/scripts/setup.mjs" "$PLUGIN"
```

Both hosts cache a plugin under its version, so an upgrade that did not change the version can
keep the old files. If a fix you expect is missing, check the version actually on disk:
`ls ~/.codex/plugins/cache/mubit/mubit-memory/`.

**Re-run `setup` after every upgrade.** Editing a hook registration changes its content hash,
which returns it to untrusted — and under `codex exec` an untrusted hook is skipped silently,
exit 0, no warning. An upgrade that skips this step leaves a plugin that installs perfectly and
captures nothing.

You only need `login` again if the key or endpoint is wrong; an upgrade does not disturb them.

### Sharing one run between Codex and Claude Code

A run id is what memory is scoped to, and by default it is derived from the project, not from
the harness: `cc-<directory-name>-<hash of the git root path>`. Codex and Claude Code opened on
the same checkout therefore already land on the same run and see each other's pins and lessons.

They diverge when the *path* diverges — a different clone, or the same repo on a second machine
where your home directory has another name. If you want one run regardless of path or harness,
pin it by name:

```bash
export MUBIT_CC_RUN_STRATEGY=static
export MUBIT_CC_RUN_ID=team-<project>
```

Set both in the same place for both tools (your shell profile, or the `--env` flags `setup`
writes), and re-run setup so the hooks inherit them. `static` will not fall back silently: with
no `MUBIT_CC_RUN_ID` it refuses rather than quietly writing into a different run.

Check which run either side is on with `/mubit-memory:doctor`, or `pin.mjs list --json`.

---

## Part 4 — Daily use

Most of it is automatic. After setup you should not have to think about memory:

- **Capture** — every tool call and turn is redacted and spooled, then sent in the background.
  Zero network per tool call.
- **Recall** — relevant lessons are injected before each prompt, at zero LLM cost.
- **Reflect** — at session end, lessons are extracted and promoted beyond the run.

Secrets are scrubbed before anything leaves the machine, and a denylisted subject (`.env`, a
key file) is dropped rather than scrubbed. No hook ever blocks, rewrites, or fails a tool call:
a dead server costs you a memory, never a turn.

### The commands you will actually use

In Claude Code these are `/mubit-memory:<name>`; in Codex, `mubit-memory:<name>`.

| Command | Use it for |
| --- | --- |
| `remember` | Save a durable lesson, rule, or standing preference. |
| `recall` | Search memory for detail beyond what was injected this turn. |
| `pin` | Pin a constraint for the rest of this run ("don't touch the vendored server"). |
| `forget` | Delete a lesson, or down-weight one that is merely wrong. |
| `dashboard` | Local page: browse lessons, recall cost per prompt, ingest health. Loopback only. |
| `doctor` | Diagnose connectivity and memory health when something looks off. |
| `setup` | Confirm endpoint and key are set and the instance answers. |

Less often: `reflect` (extract lessons mid-session), `strategies` (the pattern across many
lessons), `checkpoint` (named snapshot before risky work), `memory-health` (what is actually
stored), `activity` (audit and export the record as JSONL).

Claude Code only: `@mubit-memory:mubit-recall`, a subagent that searches memory in an isolated
context. Codex has no plugin-defined agent types — point a generic sub-agent at the `recall`
skill instead; the isolation is the part that mattered.

### The tools the model uses on its own

You do not call these — the model does, mid-task. Thirteen registered by default, the same on
both harnesses:

`mubit_recall` (search by topic) · `mubit_learned` (save a lesson) ·
`mubit_outcome` (credit what helped) · `mubit_diagnose` (match a failure against past ones) ·
`mubit_lessons` · `mubit_status` · `mubit_reflect` · `mubit_dereference` ·
`mubit_forget` · `mubit_archive` · `mubit_strategies` · `mubit_checkpoint` ·
`mubit_memory_health`

The bundled server carries 21; the other eight cost nothing until you name them in
`MUBIT_MCP_TOOLS` (a list you supply is used verbatim, not unioned with the default).

### Status line (Claude Code)

```
● mubit: cc-my-project-9f2a11c4 · hosted · recall 6/1.2k tok · saved 12t/1q · lessons 3g
```

Run id, connection, what recall cost this prompt, what has been saved.

---

## Worth knowing

- **Runs are per-directory by default.** One project = one memory — and it is what makes a
  Claude Code session and a Codex session in that directory share one. Change it with
  `runStrategy` / `MUBIT_CC_RUN_STRATEGY` (`git-branch`, `per-conversation`, `static`).
- **The recall token budget (default 1500)** is the largest recurring cost — the ceiling on
  tokens injected per prompt. Lower it if context is tight.
- **`recallAsync`** (Claude Code) makes recall never block a prompt, at the cost of one turn
  of staleness.
- **Which harness wrote an entry is recorded** as its agent role, `codex` or `claude-code`, so
  the two stay distinguishable where it matters.
- Full configuration and troubleshooting:
  [`integrations/claude-code/README.md`](integrations/claude-code/README.md) ·
  [`integrations/codex/README.md`](integrations/codex/README.md)

## This is a generated repository — do not edit it here

Contents are published from Mubit's source repository on release. Any commit made directly here
is overwritten by the next publish.

```
source repository
  ├── .claude-plugin/marketplace.json ──┐
  ├── integrations/claude-code/ ────────┤ published on release
  └── integrations/codex/ ──────────────┤
                                        ▼
mubit-ai/plugins (this repo)  →  fetched by Claude Code / Codex  →  a user's plugin dir
```

Claude Code fetches a GitHub marketplace with `git clone --depth 1`, using your own git
credentials — there is no separate plugin token. If your git is configured for SSH only, run
`gh auth setup-git` first; the clone URL is always HTTPS, even for sources written as `git@`.
Codex fetches the same repository as a Git snapshot, which is why `codex plugin marketplace
upgrade` is the step that actually pulls new commits.

The `integrations/<host>` paths are preserved deliberately: each marketplace entry's `source`
is a marketplace-relative path that resolves inside whichever repository served the catalog.
Keeping the same paths means `marketplace.json` needs no rewriting when it is published here,
so there is nothing that can drift between the two copies.

What is published is the plugin's tracked files, minus development-only scripts and QA
transcripts written against a developer's own checkout. What runs on your machine is exactly
what you see here — both hosts execute these directories as fetched, with no build step, which
is why `hooks/dist/`, `mcp/dist/` and `bin/` are committed artifacts rather than build output.

## Verifying what you are about to run

Everything here executes on your machine: the hooks run as Node processes on session events,
and the MCP server runs as a long-lived subprocess. Two things make that auditable:

- `integrations/claude-code/hooks/src/` and `lib/` are the readable source for every bundle in
  `hooks/dist/` and `bin/`. Diff them rather than trusting the bundles — `npm run build` in
  `integrations/claude-code` regenerates the bundles in place, so a clean `git diff` afterwards
  is proof the committed artifacts match their source. The codex integration builds the same
  sources; its `esbuild.config.mjs` names them.
- `integrations/claude-code/test/` carries the full suite, including the redaction cases —
  pattern scrub, path denylist, and byte caps applied after the scrub. Run it with `npm test`,
  and again with `MUBIT_CC_TEST_TARGET=dist` to run it against the code that actually ships.

```bash
claude plugin validate .
```

## License

Apache-2.0. The plugins are licensed by
[`integrations/claude-code/LICENSE`](integrations/claude-code/LICENSE), accompanied by
[`integrations/claude-code/THIRD_PARTY_NOTICES.md`](integrations/claude-code/THIRD_PARTY_NOTICES.md)
attributing the third-party code bundled into the MCP server. The root [`LICENSE`](LICENSE)
covers everything else in this repository: this README, the marketplace manifest, and the
publishing tooling.
