# SC-06 — `link_run` / `unlink_run` routes and a local link ledger

**Branch:** `feat/link-run-routes` · **Worktree:** `/Users/eldaru/Mubit/scope-routes`
**Kind:** feat · **SCOPE.md:** Target C, §6

## The gap

The mechanism is **already built on the backend and unused by the plugin**:

| Piece | Where |
| --- | --- |
| `link_run`, maintained bidirectionally | `crates/control/service/src/lib.rs:7852-7901` |
| `include_linked_runs` extends `consulted_runs` | `lib.rs:8709`, evidence loop `:8827` |
| `POST /v2/control/runs/link`, `/runs/unlink` | `crates/core/runtime/src/server/mod.rs:220-221` |
| `linked_runs_for` — **one hop, not transitive** | `lib.rs:5654` |

`lib/http.mjs:89-101` `ROUTES` is a frozen object of eleven entries with no link route. The
comment at `lib/runid.mjs:367` and the design note at `hooks/src/subagent-start.mjs:251-269`
both name its absence as the reason subagent isolation is local-only.

**No backend change is required.** The whole of Target C is client work.

## The change

### 1. Two routes

```js
linkRun:   '/v2/control/runs/link',
unlinkRun: '/v2/control/runs/unlink',
```

`ROUTES` is `Object.freeze`d; add the entries to the literal.

### 2. Two wrappers

`postLinkRun` / `postUnlinkRun`, following the shape of `postOutcome` (`lib/http.mjs:368`):

- a required non-empty `run_id` **and** `linked_run_id`, via the existing `requireString` /
  `firstOf` / `refuse` helpers — a missing field is a 422, not a default (§1.3);
- a **local** guard rejecting `run_id === linked_run_id`. The backend rejects it at
  `lib.rs:7861` and a round trip to learn that is waste. Refuse it the same way a missing
  field is refused, with a message that says why linking a run to itself is meaningless
  rather than merely that it is invalid.

Match the surrounding JSDoc discipline: every wrapper in this file says which server payload
type it satisfies and which section of the spec requires each field.

### 3. `lib/links.mjs` — the local ledger

`<dataDir>/links/<run_id>.json`, holding the linked run ids with the `project_dir` each was
linked from and when.

**This is not a cache of the server's truth — it is the plugin's own record.** `run_scopes` is
an in-memory `HashMap` on the backend (`lib.rs:2809`), durable only through the checkpoint
(`:3026` save, `:3179` restore). The ledger is what lets the plugin re-assert its links
cheaply and idempotently after a pod roll, and what lets `/mubit-memory:link list` answer
without a round trip.

It also has to hold a **decline** (SC-10 stores "the user said no" so the offer does not
nag), so design the shape for that now rather than bolting it on: an entry is a decision,
which happens to be either linked or declined, with a timestamp either way.

Discipline, the same as `persistSubRun` (`subagent-start.mjs:276-281`):

- every write through `writeJsonAtomic` and `safeSegment` from `lib/state.mjs`;
- an unwritable data dir costs the ledger entry, never the caller;
- a missing, empty or truncated file reads as "no record", never as a throw;
- zero dependencies, Node ≥ 20 built-ins only, standalone-importable ESM.

Reads and writes must be idempotent: linking A→B twice leaves one entry.

**Symmetry.** The backend maintains the join bidirectionally. Decide deliberately whether the
ledger mirrors both ends locally or records only the link this machine created, and write the
reason down in the module header — a later reader will otherwise assume the file is a mirror
of server state, which it is not.

## Tests (red first)

New `test/links.test.mjs` plus additions to `test/http.test.mjs`. Real loopback HTTP via
`fakeMubit()` — no mocking:

- `postLinkRun` with a missing `run_id` refuses without dialing;
- `postLinkRun` with `run_id === linked_run_id` refuses **without dialing** — assert the fake
  server received no request, or the guard is decorative;
- a successful link hits `/v2/control/runs/link` with both ids in the body;
- `postUnlinkRun` likewise against `/runs/unlink`;
- the ledger round-trips, is idempotent, survives a truncated file, and does not throw on an
  unwritable data dir.

## Verification

Full plugin suite plus the dist freshness gate. `lib/links.mjs` is new — confirm nothing else
needs to declare it (check `scripts/verify-manifests.mjs` and the bundling in
`esbuild.config.mjs`; `lib/` is bundled into the hook dists, so a new module ships only if
something imports it).
