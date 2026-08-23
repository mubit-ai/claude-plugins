# Mubit's Claude Code marketplace

This repository is the distribution point for Mubit's Claude Code plugins. It holds one
plugin today:

| Plugin | Version | What it does |
| --- | --- | --- |
| [`mubit-memory`](integrations/claude-code/) | 0.10.0 | Persistent, typed, self-improving memory for Claude Code — involuntary capture, pre-prompt recall, and outcome attribution. |

## Install

```
/plugin marketplace add mubit-ai/claude-plugins
/plugin install mubit-memory@mubit
/reload-plugins
```

Then **start a new Claude Code session**. `/reload-plugins` registers the hooks but does not
fire `SessionStart`, so until a new session begins the plugin has never actually run: no run
id, no registered agent, nothing on the status line. It looks broken and is fine.

Full setup, configuration and troubleshooting: [`integrations/claude-code/README.md`](integrations/claude-code/README.md).

## Connect it to Mubit

```
/mubit-memory:auth
```

Opens the [Mubit console](https://console.mubit.ai), signs you in, and stores a key for this
machine after checking it against your instance. No browser — over SSH, say — is covered in the
plugin README.

## Contributing

**This repository is where the plugin is developed.** Open pull requests here; `main` is
protected and takes them through review. There is no other tree that this one is generated
from, and nothing here is regenerated on release — an edit made here is the edit that ships.

Claude Code fetches a GitHub marketplace with `git clone --depth 1`, using your own git
credentials — there is no separate plugin token. If your git is configured for SSH only, run
`gh auth setup-git` first; the clone URL is always HTTPS, even for sources written as `git@`.

The `integrations/claude-code` path is load-bearing: the marketplace entry's `source` is the
marketplace-relative path `./integrations/claude-code`, which resolves inside whichever
repository served the catalog. Moving the plugin to the repository root would mean rewriting
`marketplace.json`, so the path stays where it is.

What runs on your machine is exactly what you see here — Claude Code executes this directory
as fetched, with no build step and no `npm install`. That is why `hooks/dist/`, `mcp/dist/`
and `bin/statusline.mjs` are committed artifacts rather than build output, and why a change
to a hook or to `lib/` has to be committed together with the bundle it rebuilds. CI rebuilds
and runs `git diff --exit-code`, so the two cannot drift.

## Verifying what you are about to run

Everything here executes on your machine: nine hooks run as Node processes on Claude Code
events, and the MCP server runs as a long-lived subprocess. Two things make that auditable:

- `integrations/claude-code/hooks/src/` is the readable source for every bundle in
  `hooks/dist/`. Diff them rather than trusting the bundles — `npm run build` in
  `integrations/claude-code` regenerates the bundles in place, so a clean `git diff` afterwards
  is proof the committed artifacts match their source.
- `integrations/claude-code/test/` carries the full suite, including the redaction
  cases — pattern scrub, path denylist, and byte caps applied after the scrub. Run it with
  `npm test`.

```bash
claude plugin validate .
```

## License

Apache-2.0 — see [`integrations/claude-code/LICENSE`](integrations/claude-code/LICENSE).
