# SC-10 — Tier 2: offer a link when a second repo shares a remote

**Branch:** `feat/link-offer` · **Worktree:** `/Users/eldaru/Mubit/scope-link-offer`
**Kind:** feat · **SCOPE.md:** §6 Tier 2 · **Depends on:** SC-06 (ledger), SC-09 (the `link` skill)

## The change

On `SessionStart`, if `git remote get-url origin` matches another run in the session map,
offer the link **once** and remember the answer either way.

Directories and dates, never hashes:

```
mubit: this repo shares a remote with a project you already have memory in.

  ~/Mubit/pre-main            last active 2 days ago, 47 entries

  Link them so recall in one can see the other?   /mubit-memory:link yes | no
```

## Why this is the right signal

**It is self-timing.** On a fresh machine with one repo there is nothing to offer, and the
prompt appears the first time a second run with a matching remote shows up — exactly when the
question becomes real. No configuration, no onboarding step, no nag on a machine where the
question does not apply.

**A decline is stored in the ledger** (SC-06 designed the entry shape for this) so it does not
ask again. Store the decline against the *pair*, not against the session: the user declined
linking these two projects, and that answer should survive a new session in either of them.

## The budget constraint, which shapes the implementation

`SessionStart` has pinned sub-budgets — 400/600/900 ms, held by `test/session-start.test.mjs`.
Shelling out to `git remote get-url origin` on every session start is exactly the kind of cost
that breaks them, and it is measured on a cold FS, not a warm one.

**So cache the remote on the session record** rather than shelling out per session.
`rememberRun` (`lib/runid.mjs:491-509`) already resolves and stores `project_root` for the
same reason — *"resolved here rather than left for a reader to work out"* — and this is the
same argument for the same reason. Follow that precedent: resolve once, store it, and let the
matching read the map.

The scan itself is over `<dataDir>/sessions/*.json`, which is a small directory of small
files, but it is still I/O on the spawn path — bound it, and make the whole offer
best-effort. `lib/hook.mjs` discipline applies: an unreadable data dir costs the offer, never
the session.

## Order of operations

The offer is rendered in the same preamble SC-05 writes to. Both are conditional, both are
one line, and they can co-occur (a cleared session in a repo that shares a remote). Decide
what that reads like rather than emitting two unrelated paragraphs.

## Tests (red first)

- two runs in the session map sharing an origin produce an offer; two with different origins
  produce none;
- the offer names **directories and a relative date**, never a run id — same executable
  assertion as SC-09;
- a stored decline suppresses the offer on the next session start, and the decline is keyed to
  the pair rather than the session;
- an already-linked pair produces no offer;
- the SessionStart sub-budgets still hold (`assertWithinBudget`), with the remote read from
  the cached record and **not** shelled out. Assert the caching rather than the timing alone —
  a budget test on a warm FS can pass while the shell-out is still there.

Use `makeProjectDir()` for real git repos rather than faking `git`; check its options — the
harness already knows how to make one with a remote, or is the right place to teach it.

## Verification

Full plugin suite plus the dist freshness gate, and `node bin/lab.mjs selftest` from
`testkit/` if any scenario moved.
