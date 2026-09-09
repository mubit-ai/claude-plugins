# Security policy

## Reporting a vulnerability

Report it privately, through GitHub's
[private vulnerability reporting](https://github.com/mubit-ai/claude-plugins/security/advisories/new).
It is enabled on this repository, the report is visible only to the maintainers, and it stays
private until an advisory is published.

**Please do not open a public issue for a suspected vulnerability**, and please do not include a
working exploit in the first message. Describe the class of problem and how to reach it; we will
ask for more if we need it.

Useful to include: the plugin version on disk, which host it runs under, and what an attacker
would have to already control. Redacted log excerpts are welcome, whole transcripts are not.

Expect an acknowledgement within a few working days. If a report turns out to be valid we will
tell you what the fix is and when it ships, and credit you in the advisory unless you would
rather we did not.

## Supported versions

The current release is supported. Fixes ship forward in a new version rather than as patches to
an older one, so upgrading is the remedy for anything reported here.

| Version | Supported |
| --- | --- |
| 0.13.x | yes |
| < 0.13 | no, upgrade |

Both hosts cache a plugin under its version number, so an upgrade that did not change the
version can keep serving the old files. Check what is actually on disk before concluding a fix
did not land.

## What this plugin does with your data

Worth knowing before you assess anything, because most of the surface is local:

- Captured work is sent to **the Mubit endpoint you configure** and nowhere else. There is no
  telemetry channel and no second destination.
- Secrets are scrubbed before anything reaches even the local spool, and a file on the path
  denylist is dropped whole rather than redacted. The
  [full description of what leaves your machine](integrations/claude-code/README.md#what-leaves-your-machine-and-what-does-not)
  is in the Claude Code guide.
- The hooks run as Node processes and the MCP server as a long-lived subprocess, both from
  committed bundles. `hooks/src/` and `lib/` are their readable source, and rebuilding is how
  you prove the two match. See
  [Verifying what you are about to run](README.md#verifying-what-you-are-about-to-run).
- The dashboard binds to loopback on an ephemeral port behind a per-launch bearer token, and
  shuts down when idle. Your API key is proxied and never reaches the browser.

## In scope

Anything in this repository: the hooks, the libraries, the bundled MCP server, the shipped
skills, and the local dashboard. Redaction failures are especially in scope. If you can get a
credential past the scrub and into a capture, we want to know.

Out of scope: findings that require an attacker to already have write access to your machine or
your shell profile, and reports about the Mubit service itself rather than this client. For the
service, use the same private reporting link and say so in the report.
