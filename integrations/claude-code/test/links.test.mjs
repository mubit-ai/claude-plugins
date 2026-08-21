// @ts-check
/**
 * `lib/links.mjs` — the local link ledger at `<dataDir>/links/<run_id>.json`.
 *
 * Guide sections under test: §7 (the state layout this file joins), §4.8 (`writeJsonAtomic`
 * and `safeSegment`), §4.9 / §12.1-F14 (nothing here throws; an unwritable
 * `${CLAUDE_PLUGIN_DATA}` costs the ledger entry and never the caller), §4.3 (a run id is
 * untrusted input to a path).
 *
 * The design this file protects is SCOPE.md Target C: **keep lessons at `run` scope and join
 * runs instead of widening scopes.** The ledger is the plugin's own record of the joins it
 * decided, not a cache of `run_scopes` — which is an in-memory map on the backend, durable
 * only through a checkpoint. Two things depend on that distinction and are asserted here:
 *
 *   1. **A decision is symmetric.** The user linked two projects; they did not link A to B.
 *      Recording only the initiating end would make `/mubit-memory:link list` claim there is
 *      no link from the second project while the backend happily serves one.
 *   2. **A decline is a decision too**, with a timestamp, so SC-10's Tier 2 offer can be made
 *      once rather than on every `SessionStart` forever.
 *
 * Written before `lib/links.mjs` exists. Failing with "lib/links.mjs does not exist yet" is
 * the expected red state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { lib, makeDataDir, makeProjectDir, readJsonFile, tempDir } from './helpers/harness.mjs';

/** Two runs in two directories — the shape §6 Tier 2 and Tier 3 both operate on. */
const A = 'cc-plugin-lab-43f3807e';
const B = 'cc-pre-main-1a2b3c4d';
const C = 'cc-ricedb-77e0b915';

/** A cfg is only ever read for its data dir here; nothing in this module dials. */
const cfgFor = (dataDir) => ({ dataDir });

/** @param {string} runId @param {string} [projectDir] */
const side = (runId, projectDir = '') => ({ runId, projectDir });

// ---------------------------------------------------------------------------
// The round trip — §7
// ---------------------------------------------------------------------------

// §7: `<dataDir>/links/<run_id>.json` holds the linked run ids, with the `project_dir` each
// was linked from and when. The directory is what `/mubit-memory:link list` renders — §6 is
// explicit that users never see run ids — so losing it would cost the whole Tier 3 surface.
test('links: a recorded link round-trips with its project_dir and a timestamp', async () => {
  const links = await lib('links.mjs');
  const dataDir = makeDataDir();
  const cfg = cfgFor(dataDir);
  const projA = makeProjectDir();
  const projB = makeProjectDir();
  const before = Date.now();

  const ok = links.recordLink(cfg, side(A, projA), side(B, projB));
  assert.equal(ok, true, 'a writable data dir must land the decision at both ends');

  const entries = links.readLinks(cfg, A);
  assert.equal(entries.length, 1, `A must hold exactly one decision, got ${JSON.stringify(entries)}`);
  assert.equal(entries[0].run_id, B, 'the entry names the OTHER run — a ledger of itself is useless');
  assert.equal(entries[0].decision, 'linked', 'a link is the "linked" decision, not an absent one');
  assert.equal(entries[0].project_dir, projB,
    'the entry carries the other run\'s directory: §6 renders directories, never run ids');
  assert.ok(entries[0].at >= before, `the decision is timestamped, got ${entries[0].at}`);
});

// The file is the plugin's own record and has to be readable by a human and by
// `/mubit-memory:link list --json`, so the on-disk shape is pinned rather than left to
// whatever the writer happened to spread in.
test('links: the ledger file is at links/<run_id>.json and names its own run verbatim', async () => {
  const links = await lib('links.mjs');
  const dataDir = makeDataDir();
  const cfg = cfgFor(dataDir);

  links.recordLink(cfg, side(A, '/x/a'), side(B, '/x/b'));

  const p = join(dataDir, 'links', `${A}.json`);
  assert.ok(existsSync(p), `expected the ledger at links/${A}.json, saw ${readdirSync(join(dataDir, 'links')).join(', ')}`);
  assert.equal(links.linksPath(cfg, A), p, 'linksPath must name the file the writer actually used');

  const stored = readJsonFile(p);
  assert.equal(stored.run_id, A,
    'the owning run id is stored verbatim — the filename is a flattened segment and cannot be reversed');
  assert.ok(Array.isArray(stored.links), 'the decisions live under `links`');
  assert.ok(stored.updated_at > 0, 'the file records when it was last written');
});

// ---------------------------------------------------------------------------
// Symmetry — Target C, and the reason this is not a cache
// ---------------------------------------------------------------------------

// The backend maintains the join bidirectionally, and so does this. A user who links two
// projects from A and then opens B must see the link from B: the alternative is a `list` that
// says "not linked" about a run the server is already consulting, which is the one answer
// worse than no answer at all.
test('links: a decision is recorded at BOTH ends, so either project can list it', async () => {
  const links = await lib('links.mjs');
  const cfg = cfgFor(makeDataDir());

  links.recordLink(cfg, side(A, '/x/a'), side(B, '/x/b'));

  const fromB = links.readLinks(cfg, B);
  assert.equal(fromB.length, 1, `B must hold the mirror decision, got ${JSON.stringify(fromB)}`);
  assert.equal(fromB[0].run_id, A, 'B\'s entry names A');
  assert.equal(fromB[0].project_dir, '/x/a',
    'each end stores the OTHER end\'s directory, or the second project renders its own path back at itself');
});

// ---------------------------------------------------------------------------
// Idempotency — "linking A→B twice leaves one entry"
// ---------------------------------------------------------------------------

// The ledger's stated purpose is to let the plugin re-assert its links cheaply after a pod
// roll drops `run_scopes`. Re-assertion that grew the file every time would make the cheap
// half expensive.
test('links: linking the same pair twice leaves exactly one entry at each end', async () => {
  const links = await lib('links.mjs');
  const cfg = cfgFor(makeDataDir());

  links.recordLink(cfg, side(A, '/x/a'), side(B, '/x/b'));
  links.recordLink(cfg, side(A, '/x/a'), side(B, '/x/b'));

  assert.equal(links.readLinks(cfg, A).length, 1, 'A must not accumulate duplicates of one pair');
  assert.equal(links.readLinks(cfg, B).length, 1, 'and neither must B');
  assert.deepEqual(links.linkedRunIds(cfg, A), [B], 'the reach of A is still exactly one run');
});

// Re-linking is how the plugin re-asserts after a checkpoint loss, so the timestamp has to
// move: a decision whose `at` never advanced could not be told from one nobody has touched
// since the pod that held it died.
test('links: re-recording a decision refreshes its timestamp instead of appending', async () => {
  const links = await lib('links.mjs');
  const cfg = cfgFor(makeDataDir());

  links.recordLink(cfg, side(A), side(B));
  const first = links.readLinks(cfg, A)[0].at;
  await new Promise((r) => setTimeout(r, 5));
  links.recordLink(cfg, side(A), side(B));
  const second = links.readLinks(cfg, A)[0].at;

  assert.equal(links.readLinks(cfg, A).length, 1, 're-assertion is an update, not an append');
  assert.ok(second >= first, `the refreshed decision must not go backwards (${first} -> ${second})`);
});

// A later `link` must be able to overturn an earlier `no`, and it must leave one decision
// behind rather than two contradictory ones.
test('links: linking a pair that was previously declined replaces the decline', async () => {
  const links = await lib('links.mjs');
  const cfg = cfgFor(makeDataDir());

  links.recordDecline(cfg, side(A, '/x/a'), side(B, '/x/b'));
  links.recordLink(cfg, side(A, '/x/a'), side(B, '/x/b'));

  const entries = links.readLinks(cfg, A);
  assert.equal(entries.length, 1, 'a pair holds one decision, not a history of them');
  assert.equal(entries[0].decision, 'linked', 'the newer decision wins');
  assert.deepEqual(links.linkedRunIds(cfg, B), [A], 'and the mirror end agrees');
});

// ---------------------------------------------------------------------------
// A decline is a decision — SC-10's "declining is remembered, so it does not nag"
// ---------------------------------------------------------------------------

// The shape has to hold a "no" now rather than gain one later, because the Tier 2 offer is
// the only thing that makes Target C reachable without a command and it is unusable if the
// answer is not durable.
test('links: a decline is stored as a decision with a timestamp, not as an absence', async () => {
  const links = await lib('links.mjs');
  const cfg = cfgFor(makeDataDir());
  const before = Date.now();

  assert.equal(links.recordDecline(cfg, side(A, '/x/a'), side(B, '/x/b')), true,
    'a decline must be recordable');

  const decision = links.linkDecision(cfg, A, B);
  assert.ok(decision, 'a declined pair has a record — that is what stops the offer repeating');
  assert.equal(decision.decision, 'declined');
  assert.ok(decision.at >= before, 'the decline is timestamped, so a later policy can age it out');
  assert.ok(links.linkDecision(cfg, B, A), 'the decline holds from either side, or the offer nags from the other');
});

// The leak-shaped mistake: a `declined` entry counted as reach would hand a project exactly
// the memory the user just said no to.
test('links: linkedRunIds returns only linked pairs, never declined ones', async () => {
  const links = await lib('links.mjs');
  const cfg = cfgFor(makeDataDir());

  links.recordLink(cfg, side(A), side(B));
  links.recordDecline(cfg, side(A), side(C));

  assert.deepEqual(links.linkedRunIds(cfg, A), [B],
    'a declined run must never appear as reach — that is the user\'s "no" being ignored');
  assert.equal(links.readLinks(cfg, A).length, 2, 'both decisions are still recorded');
});

// §6 Tier 2 asks the question once. "No record" is the only state that means "ask".
test('links: a pair with no record answers null, which is what makes the offer fire once', async () => {
  const links = await lib('links.mjs');
  const cfg = cfgFor(makeDataDir());

  assert.equal(links.linkDecision(cfg, A, B), null, 'an undecided pair has no decision');
  links.recordDecline(cfg, side(A), side(B));
  assert.notEqual(links.linkDecision(cfg, A, B), null, 'once answered, it stays answered');
  assert.equal(links.linkDecision(cfg, A, C), null, 'and answering one pair says nothing about another');
});

// ---------------------------------------------------------------------------
// Revocation — `/mubit-memory:unlink to revoke`
// ---------------------------------------------------------------------------

// Unlinking has to clear both ends for the same reason linking writes both: a half-cleared
// ledger would list a link from one project that the other says was revoked.
test('links: forgetLink clears both ends and leaves every other pair alone', async () => {
  const links = await lib('links.mjs');
  const cfg = cfgFor(makeDataDir());

  links.recordLink(cfg, side(A), side(B));
  links.recordLink(cfg, side(A), side(C));

  assert.equal(links.forgetLink(cfg, side(A), side(B)), true, 'revoking a recorded pair reports success');
  assert.deepEqual(links.linkedRunIds(cfg, A), [C], 'only the revoked pair is gone');
  assert.deepEqual(links.readLinks(cfg, B), [], 'and B no longer claims a link A has revoked');
  assert.equal(links.linkDecision(cfg, A, B), null,
    'a revoked pair reads as undecided, not as declined — the user revoked it, they did not refuse it');
});

// `/mubit-memory:unlink` on something that was never linked is a user typo, not a fault.
test('links: forgetLink on an unrecorded pair is a no-op that still reports success', async () => {
  const links = await lib('links.mjs');
  const cfg = cfgFor(makeDataDir());

  assert.equal(links.forgetLink(cfg, side(A), side(B)), true,
    'removal is idempotent: nothing to remove is the desired end state, not a failure');
  assert.deepEqual(links.readLinks(cfg, A), []);
});

// ---------------------------------------------------------------------------
// A run may not be linked to itself
// ---------------------------------------------------------------------------

// The same refusal `postLinkRun` makes on the wire, made here so a ledger written without a
// round trip cannot disagree with the one written after one. A run already consults itself.
test('links: a run cannot be linked to itself, and nothing is written', async () => {
  const links = await lib('links.mjs');
  const dataDir = makeDataDir();
  const cfg = cfgFor(dataDir);

  assert.equal(links.recordLink(cfg, side(A, '/x/a'), side(A, '/x/a')), false,
    'linking a run to itself adds no reach and must be refused');
  assert.deepEqual(links.readLinks(cfg, A), [], 'and it must not leave a self-entry behind');
  assert.equal(existsSync(join(dataDir, 'links', `${A}.json`)), false,
    'a refused decision writes no file at all');
});

// An empty id is a caller bug — usually a run id that failed to derive — and writing
// `links/.json` for it would be a file nothing can ever read back.
test('links: an empty run id on either side is refused', async () => {
  const links = await lib('links.mjs');
  const cfg = cfgFor(makeDataDir());

  assert.equal(links.recordLink(cfg, side(''), side(B)), false, 'no owning run, no ledger entry');
  assert.equal(links.recordLink(cfg, side(A), side('   ')), false, 'a blank other side is not a run');
  assert.deepEqual(links.readLinks(cfg, ''), [], 'and reading one answers no record rather than throwing');
});

// ---------------------------------------------------------------------------
// §4.9 — every kind of absence and every kind of damage reads as "no record"
// ---------------------------------------------------------------------------

// A missing file is the normal state of a fresh install, not an error to report.
test('links: a run with no ledger reads as no record', async () => {
  const links = await lib('links.mjs');
  const cfg = cfgFor(makeDataDir());

  assert.deepEqual(links.readLinks(cfg, A), [], 'no file means no decisions');
  assert.deepEqual(links.linkedRunIds(cfg, A), [], 'and therefore no reach');
});

// §4.8: a truncated, empty or foreign file is normal after a SIGKILL. Every caller is on a
// hook's critical path and has no branch for "the ledger is broken" that differs from "there
// are no links".
test('links: an empty, truncated or foreign ledger reads as no record and never throws', async () => {
  const links = await lib('links.mjs');
  const dataDir = makeDataDir();
  const cfg = cfgFor(dataDir);
  const p = join(dataDir, 'links', `${A}.json`);

  for (const body of ['', '   ', '{"run_id":"cc-a","links":[{"run_id":', '[]', 'null', '{"links":"nope"}',
    '{"links":[null,7,"x",{"decision":"linked"}]}']) {
    links.recordLink(cfg, side(A), side(B)); // ensure links/ exists, then damage the file
    writeFileSync(p, body);
    assert.doesNotThrow(() => links.readLinks(cfg, A),
      `readLinks threw on a ledger containing ${JSON.stringify(body)} (§4.9)`);
    assert.deepEqual(links.readLinks(cfg, A), [],
      `a ledger containing ${JSON.stringify(body)} must read as no record, not as a partial one`);
    assert.doesNotThrow(() => links.recordLink(cfg, side(A), side(C)),
      `recordLink threw over a ledger containing ${JSON.stringify(body)}`);
  }
});

// §12.1-F14: an unwritable `${CLAUDE_PLUGIN_DATA}` costs the ledger entry, never the caller.
// The caller here is `SubagentStart`, on the spawn path.
test('links: an unwritable data dir costs the entry, never the caller', async () => {
  const links = await lib('links.mjs');
  const file = join(tempDir('mubit-cc-links-notadir-'), 'data');
  writeFileSync(file, 'a file where a directory should be');
  const cfg = cfgFor(file);

  assert.doesNotThrow(() => links.recordLink(cfg, side(A), side(B)),
    '§12.1-F14: an unwritable ${CLAUDE_PLUGIN_DATA} costs the ledger, nothing else');
  assert.equal(links.recordLink(cfg, side(A), side(B)), false,
    'a write that could not land must say so rather than claim a link that does not exist');
  assert.deepEqual(links.readLinks(cfg, A), [], 'and the read side answers no record');
  assert.doesNotThrow(() => links.forgetLink(cfg, side(A), side(B)), 'revocation is total too');
});

// ---------------------------------------------------------------------------
// §4.3 — a run id is untrusted input to a path
// ---------------------------------------------------------------------------

// A run id normally arrives from `lib/runid.mjs`, but it can be pinned by hand in a settings
// file or an environment variable. `safeSegment` is the one definition of a segment this
// plugin will write, and the ledger uses it like every other writer.
test('links: a path-climbing run id is flattened, never followed', async () => {
  const links = await lib('links.mjs');
  const dataDir = makeDataDir();
  const cfg = cfgFor(dataDir);
  const hostile = '../../etc/passwd';

  links.recordLink(cfg, side(hostile, '/x/a'), side(B, '/x/b'));

  const written = links.linksPath(cfg, hostile);
  assert.ok(written.startsWith(join(dataDir, 'links')),
    `the ledger escaped its directory: ${written}`);
  assert.ok(!written.includes('..'), `a climbing segment survived into the path: ${written}`);
  assert.equal(links.readLinks(cfg, hostile)[0]?.run_id, B,
    'the flattened name still round-trips for the run that owns it');
});
