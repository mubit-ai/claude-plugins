# Test suite — `mubit-memory` for Codex

**These tests were written before the implementation**, so the suite reads as a specification
rather than as a regression net. Every failure names the file that does not exist yet, or the
manifest key that drifted, and says what defines it.

The same house rules as `../../claude-code/test/README.md`: `// @ts-check`, a header comment
naming the claim each file defends, a `// §` comment above each test, assertion messages that
state the *consequence*, and absences asserted explicitly (`server.assertNotCalled(...)`,
`assert.equal(server.requests.length, 0)`) rather than inferred from timing.

## Running

```bash
cd integrations/codex

node --test 'test/**/*.test.mjs'          # everything
node --test test/codex-payload.test.mjs   # one gate

npm run test:dist                         # everything, against the committed bundles
```

**Both suites are one change.** `lib/`, `hooks/src/` and `mcp/src/` live in
`../claude-code` and are shared, so anything touching them has to be green in both:

```bash
cd ../claude-code && npm test    # 1067
cd ../codex       && npm test    # 243
```

## The load-bearing trick

`test/fixtures/codex-hook-schemas/*.json` are draft-07 JSON Schemas **extracted from the Codex
binary** — eleven inputs and ten outputs, one per hook event (`SessionEnd` has no output
schema). `codex-payload.test.mjs` validates every fixture and every hook's stdout against them,
in both directions.

The reason is worth stating, because it is why this suite is arranged differently from its
sibling: **a fixture written beside an implementation cannot falsify that implementation.**
Whatever shape the code reads, the fixture will have — the two are written by the same person
in the same hour, and they agree by construction. Nine tests can pass on a payload Codex would
never send. A schema the *host* wrote can say no, and every one of these is
`additionalProperties: false`.

It has already earned that twice. The first draft of `preCompact()` carried a
`permission_mode` — the two compaction events are the only turn-scoped events without one — and
`permissionRequest()` carried a `tool_use_id`, which it has none of, and which is precisely why
that event is treated as read-only.

Re-extract per `docs/harness-probe.md`, Appendix.

## Gate map

| File | Covers |
|---|---|
| `codex-manifests.test.mjs` | manifests as data: exactly the eleven events, no `if:` predicates, no `args` exec form, every command naming a committed bundle, version lockstep with the Claude Code plugin, and the absences — no `hooks`, no `mcpServers`, no `userConfig`, no `agents/`, no status line |
| `codex-payload.test.mjs` | every fixture and every hook's stdout against the host's own extracted schemas |
| `codex-boot.test.mjs` | env-before-import: what the shim fills in, what it refuses to overwrite, and the ordering assertion over every entry point |
| `codex-hooks.test.mjs` | end to end, one per event: real subprocess, real Codex payload, the emitted `hookEventName`, and zero HTTP where the contract says zero |
| `codex-runid.test.mjs` | the cross-harness claim — one directory, two harnesses, one run — the four-value `source` table, and `turnKey` |
| `codex-transcript.test.mjs` | `checkpoint.mjs`'s reader on a rollout fixture: same rendering, redacted, a real tail, and the Claude Code envelope still working |
| `codex-classify.test.mjs` | `shell`, `apply_patch`, `update_plan`, `view_image`, `web_search`, `collaborationspawn_agent`, `mcp__mubit__*` → real intents, never `unclassified` |
| `codex-skills.test.mjs` | Codex frontmatter (`name`, `description`, and none of the keys Codex does not read), `mcp__mubit__` prefixes, and the content guards |
| `codex-mcp.test.mjs` | real stdio `tools/list` against the committed bundle, the `instructions` frame, and that the two copies of the vendored server are byte-identical |
| `codex-failure.test.mjs` | F1–F15: unparseable stdin, absent env, unwritable data dir, a misbehaving endpoint, hostile payloads, the three-second SessionEnd → exit 0, a JSON object on stdout, **never exit 2** |

## `codex-failure.test.mjs` is the important one

Codex reads a hook's exit code exactly as Claude Code does: 0 parses stdout, **2 blocks** and
turns stderr into the reason shown to the model, anything else is an error surfaced to the
user. So the dangerous value is the one a naive error handler picks — a memory layer that threw
would start denying tool calls, and the user would experience it as the agent refusing to work.

Two Codex-specific failures get their own tests because neither has a Claude Code counterpart
and both are silent:

- **A registered hook that is not trusted never runs**, with no prompt and no warning. Nothing
  a hook can defend against — but the plugin must not be confusable with "capture is off", so
  every path leaves a local marker and `mubit-memory:doctor` reads it.
- **`SessionEnd` gets three seconds**, clamped by the host whatever the registration says, where
  the same hook asks for eight under Claude Code. `F11` asserts the hook *returns* inside it and
  `F12` asserts the detached child finishes the work after the hook process is killed.

## The harness

`helpers/codex-fixtures.mjs` — read it before writing a test.

It re-exports `../../claude-code/test/helpers/harness.mjs` wholesale, bound to this plugin's
root, and adds two things of its own: one builder per Codex event, and a small draft-07
validator plus the schemas to run it against. There is deliberately no second copy of
`makeDataDir` / `fakeMubit` / `runHook` / `assertHookContract` — the spawn protocol, the fake
server and the contract assertions are identical across the two hosts, and a fork of them would
be a second thing to keep true.

`rolloutJsonl()` builds a Codex rollout transcript, envelopes and all, for the checkpoint tests.

## House rules, in addition to the sibling's

- **Assert against the fenced blocks when a skill must not *run* something, and against the
  prose when it must *say* something.** A string that must never be executed is very often a
  string the prose ought to name explicitly and warn about; a flat substring search cannot tell
  "do not write `${X}`" from "write `${X}`", and pushes the skill towards saying nothing.
- **Say when a fixture was not observed.** `preCompact` and `postCompact` were never reached by
  the probe — a probe turn is far too small to compact — so they are built from the extracted
  schemas alone, and the builder's docblock says so. A fixture whose provenance is unstated
  reads as recorded when it was inferred.
