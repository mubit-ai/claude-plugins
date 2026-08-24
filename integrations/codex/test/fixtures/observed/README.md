# Observed host behaviour

Everything here was produced by running the real `codex` binary and writing down what it did.
Nothing here was read out of it.

| | |
| --- | --- |
| host | `codex-cli 0.149.0` |
| recorded | 2026-08-24 |
| regenerate | `node test/helpers/codex-record.mjs --update` |

## `payloads/`

One file per event, exactly as the host wrote it to a hook's stdin, with the values that
differ per run replaced by `{{PLACEHOLDER}}` tokens — ids, the transcript path and the working
directory. Every field name and every nested shape is verbatim.

These are the oracle for `codex-payload.test.mjs`. The point of having one at all is that a
fixture written beside an implementation cannot falsify that implementation: whatever shape
the code reads, the fixture will have. A recording can, because the host wrote it.

## `output-acceptance.json`

What the host did with an output a hook returned, per event. `codex exec` reports
`hook: <Event> Completed` or `hook: <Event> Failed`, which is the verdict.

This is the externally-verified subset of `../codex-output-rules.json`. That file states the
constraints this plugin holds its own output to; this one records the ones a real session has
confirmed, and `codex-payload.test.mjs` cross-checks them so the two cannot drift apart
silently.

## What is not covered

Five of the eleven events do not fire in a scripted one-turn session, so there is no recording
of them:

| Event | What it would take |
| --- | --- |
| `PermissionRequest` | an approval the sandbox actually refuses; `--approve-for-me` resolves it without asking |
| `PreCompact`, `PostCompact` | a context window full enough to compact |
| `SubagentStart`, `SubagentStop` | a spawned subagent |

Their builders in `test/helpers/codex-fixtures.mjs` are still the plugin's best record of what
those payloads look like — they are simply not falsifiable by anything in this directory, and
`codex-payload.test.mjs` says so by name rather than passing over it. Closing one of these
gaps means extending `codex-record.mjs` to drive a session that reaches the event, not
hand-writing a file here.

## Why this and not the host's own schemas

The previous oracle was twenty-one schema documents that came out of the host's own build
rather than off its wire. They were a stronger instrument than this one — closed schemas, both
directions, all eleven events, able to reject a field as well as require one — and they were
the vendor's, republished here along with enough detail to obtain more of them. That is not
ours to publish, however useful it was.

A recording pins the fields an event was *seen* to carry rather than the fields it *may*
carry. It cannot prove a field optional and it cannot reject one the host would accept. It
still catches the failure that matters: a builder that invents a field the host has never
sent, or drops one it always sends.
