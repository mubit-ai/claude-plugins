# Contributing

The most useful thing you can send is a good bug report. Code in this repository is published
from Mubit's source repository on release, so a pull request opened against this tree cannot be
carried forward.

## Reporting a bug

[Open an issue](https://github.com/mubit-ai/claude-plugins/issues) and include:

- **Which host and version.** Claude Code or the Codex CLI, and the plugin version actually on
  disk — `ls ~/.claude/plugins/cache/mubit/mubit-memory/` or
  `ls ~/.codex/plugins/cache/mubit/mubit-memory/`. A cache can serve older files than you
  installed, so read the directory rather than trusting what you typed.
- **What `doctor` says.** `/mubit-memory:doctor` in Claude Code, `mubit-memory:doctor` in Codex.
  It reports connection state, memory health and stuck ingest in one pass.
- **The log.** `logs/mubit-cc.log` under the plugin's data directory. Every line is scrubbed by
  the same redaction rules that run before anything leaves your machine, so it is safe to
  attach. Raise the detail with `MUBIT_CC_LOG_LEVEL=debug` and reproduce once more.

Please do not report a suspected vulnerability in a public issue. See [SECURITY.md](SECURITY.md).

## Running the checks

Requires **Node 20 or newer**. Nothing else needs installing to run the tests: every hook,
library and script imports Node builtins and local files only.

```bash
cd integrations/claude-code

node --check hooks/src/*.mjs lib/*.mjs bin/*.mjs mcp/src/*.mjs   # syntax
npm test                                                         # against the sources
MUBIT_CC_TEST_TARGET=dist npm test                               # against the shipped bundles
node scripts/verify-manifests.mjs                                # manifests agree
```

The Codex integration carries its own suite. Run it on its own — running both at once inflates
the hook-timing assertions and produces failures that are about your machine, not the code.

```bash
cd integrations/codex && npm test
```

`npm ci` does not work here. `package.json` names a `file:../mcp` sibling that lives in the
source repository, so resolving the tree fails before it starts. One test needs a real parser
(`test/engine-floor.test.mjs` checks that the shipped bundle parses on the oldest Node we claim
to support), so install that single package out-of-tree and copy it in, the way CI does:

```bash
cd /tmp && mkdir -p ebuild && cd ebuild && npm init -y
npm install --no-save esbuild@0.28.2
cp -R node_modules/. /path/to/repo/integrations/claude-code/node_modules/
```

## The committed bundles

`hooks/dist/`, `mcp/dist/` and `bin/` are committed artifacts, not build output. Both hosts
install a plugin by fetching the repository and running it, with no build step, so whatever is
committed is what runs on a user's machine.

That makes staleness the thing to guard against: a comment edited in `hooks/src/` lives on
inside an old bundle's inline sourcemap until the bundle is rebuilt. If you change anything
under `hooks/src/`, `lib/` or `mcp/src/`, rebuild and commit the result.

```bash
cd integrations/claude-code
MUBIT_CC_BUILD_SKIP_SERVER=1 npm run build
git diff -- hooks/dist mcp/dist/index.js bin
```

A clean diff means the committed artifacts already match their source. `MUBIT_CC_BUILD_SKIP_SERVER=1`
skips the vendored MCP server, which is built from the private sibling package and cannot be
regenerated from this tree. Do not run `npm run clean` here: it deletes `mcp/dist/server.js`,
and nothing in this repository can rebuild it.

Anything under `integrations/claude-code/lib/` or `hooks/src/` is shared by both plugins, so a
change there means running both suites.

## Auditing the code

You do not have to contribute to check what runs on your machine. `hooks/src/` and `lib/` are
the readable source for every bundle, the rebuild above is how you prove the two match, and
`test/` carries the redaction cases in full. The README's
[Verifying what you are about to run](README.md#verifying-what-you-are-about-to-run) is the
short version.

## Licence

By contributing you agree that your contribution is licensed under
[Apache-2.0](LICENSE), the licence this project ships under.
