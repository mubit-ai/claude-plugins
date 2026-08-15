# Mubit's Claude Code marketplace

This repository is the distribution point for Mubit's Claude Code plugins. It holds one
plugin today:

| Plugin | Version | What it does |
| --- | --- | --- |
| [`mubit-memory`](integrations/claude-code/) | 0.9.0 | Persistent, typed, self-improving memory for Claude Code — involuntary capture, pre-prompt recall, and outcome attribution. |

## Install

```
/plugin marketplace add mubit-ai/claude-plugins
/plugin install mubit-memory@mubit
/reload-plugins
```

Then **start a new Claude Code session**. `/reload-plugins` registers the hooks but does not
fire `SessionStart`, so until a new session begins the plugin has never actually run: no run
id, no registered agent, nothing on the status line. It looks broken and is fine.

In that new session, sign in:

```
/mubit-memory:auth
```

It opens the Mubit console in your browser — sign in, or sign up on the same page — and the key
comes back over a loopback callback on `127.0.0.1`, so it never passes through the conversation
and never lands in a transcript. That is the whole of the setup; there is nothing else to
configure.

Full setup, configuration and troubleshooting: [`integrations/claude-code/README.md`](integrations/claude-code/README.md).

Claude Code fetches a GitHub marketplace with `git clone --depth 1
https://github.com/mubit-ai/claude-plugins.git`. If your git is configured for SSH only, run
`gh auth setup-git` first — the clone URL is always HTTPS, even for sources written as `git@`.

## This is a generated repository — do not edit it here

Contents are published from Mubit's source repository on release. Any commit made directly
here is overwritten by the next publish.

The `integrations/claude-code` path is deliberate: the marketplace entry's `source` is the
marketplace-relative path `./integrations/claude-code`, which resolves inside whichever
repository served the catalog. Keeping the same path means `marketplace.json` needs no
rewriting when it is published here, so there is nothing that can drift between the two copies.

What runs on your machine is exactly what you see here — Claude Code executes this directory
as fetched, with no build step, which is why `hooks/dist/`, `mcp/dist/` and
`bin/statusline.mjs` are committed artifacts rather than build output.

## Verifying what you are about to run

Everything here executes on your machine: nine hooks run as Node processes on Claude Code
events, and the MCP server runs as a long-lived subprocess. Two things make that auditable:

- `integrations/claude-code/hooks/src/` is the readable source for every bundle in
  `hooks/dist/`. Diff them rather than trusting the bundles — `npm run build` in
  `integrations/claude-code` regenerates the bundles in place, so a clean `git diff` afterwards
  is proof the committed artifacts match their source.
- `integrations/claude-code/test/` carries the full suite (650 tests), including the redaction
  cases — pattern scrub, path denylist, and byte caps applied after the scrub. Run it with
  `npm test`.

```bash
claude plugin validate .
```

## License

Apache-2.0. See the plugin directory for details.
