// @ts-check
/**
 * `/mubit-memory:link` — SCOPE.md §6 Tier 3, the surface where a person declares the run graph.
 *
 * Two properties are worth more than the happy path, and they are what most of this file
 * asserts.
 *
 *   1. **No run id ever reaches the surface.** `cc-<slug>-<hash8>` is a hash of a git toplevel:
 *      nobody recognises their own project in one, and a command that prints one is a release
 *      away from a command that asks for one. Every case below that produces output re-checks
 *      it, human and `--json` alike, because this is the constraint the whole design rests on
 *      and it fails silently — a leaked hash still "works".
 *   2. **A group is linked pairwise, not through a hub.** `linked_runs_for` (ricedb
 *      `lib.rs:5654`) returns `scope.linked_run_ids` without walking them, so a star leaves the
 *      points of the star unable to see each other while every surface says they are linked.
 *      The assertion that catches a regression here is the request nobody would think to look
 *      for: the pair that does not involve the current run at all.
 *
 * No mocking. Real temp data dirs, real session-map files, real loopback HTTP through
 * `fakeMubit`, and the two git seams injected the way `bin/auth.src.mjs` injects its browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  baseEnv, fakeMubit, lib, makeDataDir, makeProjectDir, mod,
} from './helpers/harness.mjs';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * The shape `lib/runid.mjs` mints: `cc-`, a slug, and eight hex of the git toplevel. Written
 * out here rather than imported so that the thing being kept off the screen is described in
 * this file, in the terms a reader of the output would use.
 */
const RUN_ID_SHAPE = /\bcc-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}\b/;

const LINK_ROUTE = '/v2/control/runs/link';
const UNLINK_ROUTE = '/v2/control/runs/unlink';

/** A day, so `last_seen_at` offsets read the way the picker renders them. */
const DAY = 86400000;

/**
 * A §4.3 `SessionRecord` on disk. Written as a real file under `sessions/` because that is
 * where the command looks; there is no seam here and there should not be one.
 *
 * @param {string} dataDir
 * @param {string} sessionId
 * @param {Record<string, any>} over
 * @returns {Record<string, any>}
 */
function session(dataDir, sessionId, over) {
  const rec = {
    run_id: '',
    agent_id: 'claude-code',
    strategy: 'per-directory',
    project_dir: '',
    project_root: '',
    created_at: Date.now() - DAY,
    last_seen_at: Date.now(),
    mode: 'hosted',
    clear_count: 0,
    previous_run_id: '',
    endpoint_hash: '9f2a11c4',
    ...over,
  };
  if (!rec.project_root) rec.project_root = rec.project_dir;
  writeFileSync(join(dataDir, 'sessions', `${sessionId}.json`), JSON.stringify(rec));
  return rec;
}

/**
 * The git seams, answered from a table instead of a process. This is the same kind of seam
 * `bin/auth.src.mjs` uses for the browser: the code under test still does its own resolution,
 * matching and rendering, and the suite does not spawn `git` once per candidate per case.
 * `same remote` gets a real repository of its own, below.
 *
 * @param {Record<string, string>} [remotes]
 */
function gitSeams(remotes = {}) {
  return {
    remoteOf: (dir) => remotes[dir] ?? '',
    gitRootOf: (dir) => dir,
  };
}

/** Collect what a run prints, and the exit code it chose. */
function collector() {
  /** @type {string[]} */
  const lines = [];
  return { lines, log: (m) => lines.push(String(m)), text: () => lines.join('\n') };
}

/**
 * Every place a run id could have leaked: the human line, the JSON envelope, and the rendered
 * `detail` the JSON carries. Asserted against both the literal ids in play and the generic
 * shape, because the literals catch this change and the shape catches the next one.
 *
 * @param {string} out @param {string[]} runIds @param {string} what
 */
function assertNoRunIds(out, runIds, what) {
  for (const id of runIds) {
    assert.ok(!out.includes(id),
      `${what} printed the run id ${JSON.stringify(id)}. §6: users never see run ids — a hash of a `
      + `git toplevel is not something anyone can recognise their own project in.\n${out}`);
  }
  const leak = RUN_ID_SHAPE.exec(out);
  assert.equal(leak, null,
    `${what} printed something shaped like a run id (${leak?.[0]}). Addressing is by directory `
    + `(§6); the diagnostic surface that prints ids is scripts/mubit-inspect.mjs --runs.\n${out}`);
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) { spawnSync('git', args, { cwd, stdio: 'ignore' }); }

/**
 * One fully-wired machine: a data dir, a fake instance, three project directories, and a
 * session record for each. Returns everything a case needs to drive `main` and read back both
 * the wire and the ledger.
 *
 * @param {{ routes?: Record<string, any> }} [opts]
 */
async function machine(opts = {}) {
  const dataDir = makeDataDir();
  const server = await fakeMubit(opts.routes ?? {});

  const here = makeProjectDir();
  const pricing = makeProjectDir();
  const analytics = makeProjectDir();

  const now = Date.now();
  const current = session(dataDir, 'sess-here', {
    run_id: 'cc-storefront-1a2b3c4d', project_dir: here, last_seen_at: now,
  });
  const a = session(dataDir, 'sess-pricing', {
    run_id: 'cc-pricing-2b3c4d5e', project_dir: pricing, last_seen_at: now - (2 * DAY),
  });
  const b = session(dataDir, 'sess-analytics', {
    run_id: 'cc-analytics-3c4d5e6f', project_dir: analytics, last_seen_at: now - (11 * DAY),
  });

  const env = baseEnv({ dataDir, projectDir: here, endpoint: server.url });
  const config = await lib('config.mjs');
  const links = await lib('links.mjs');
  const { main } = await mod('bin/link.src.mjs');

  return {
    dataDir,
    server,
    env,
    cfg: config.loadConfig(env),
    links,
    here,
    pricing,
    analytics,
    runIds: [current.run_id, a.run_id, b.run_id],
    current: current.run_id,
    a: a.run_id,
    b: b.run_id,
    /** @param {string[]} argv @param {Record<string, any>} [deps] */
    run: (argv, deps = {}) => {
      const out = collector();
      return main(argv, env, { log: out.log, ...gitSeams(), ...deps })
        .then((code) => ({ code, out: out.text(), json: () => JSON.parse(out.text()) }));
    },
  };
}

// ===========================================================================
// §6 — the picker: directories and dates, never hashes
// ===========================================================================

// §6: "users never see run ids." The list is where that is either true or false, and it is the
// single assertion this ticket exists to make executable.
test('list renders directories and relative dates, and leaks no run id', async () => {
  const m = await machine();

  const human = await m.run(['list']);
  assert.equal(human.code, 0, 'listing what a project can reach must not be an error path');
  assert.ok(human.out.includes(m.pricing),
    `list must name the project by its directory. Got:\n${human.out}`);
  assert.ok(human.out.includes(m.analytics),
    `every project with memory belongs in the picker, not just the linked ones. Got:\n${human.out}`);
  assert.match(human.out, /\bago\b/,
    'a picker sorted by recency has to show recency, or the ordering is unexplained');
  assertNoRunIds(human.out, m.runIds, 'list');

  const machineOut = await m.run(['list', '--json']);
  const j = machineOut.json();
  assert.equal(j.state, 'listed', '--json must carry a typed state the skill can branch on');
  assert.equal(j.projects.length, 2,
    'the two other projects on this machine are the pickable ones; the current project is not a target');
  assert.ok(j.projects.every((p) => typeof p.path === 'string' && p.path.startsWith('/')),
    'the machine-readable handle is the absolute directory — that is what `link` takes back');
  assertNoRunIds(machineOut.out, m.runIds, 'list --json');

  await m.server.close();
});

// §6/`lib/links.mjs`: "it has to answer offline." Making the one surface whose promise is that
// reach is inspectable depend on the network means an unreachable Mubit answers "you are linked
// to nothing", which is a lie rather than a degradation.
test('list answers from the local ledger and never dials', async () => {
  const m = await machine();

  const r = await m.run(['list']);

  assert.equal(r.code, 0, 'list must succeed with or without an instance');
  assert.equal(m.server.requests.length, 0,
    `list dialed the instance (${m.server.summary()}). It must answer from disk: a list that needs `
    + 'the network is wrong in exactly the case a user runs it');
  await m.server.close();
});

// An empty picker is a state a fresh install is in for its whole first week. Printing a bare
// header there reads as a broken command rather than as "there is nothing to connect yet".
test('a machine with one project says so instead of printing an empty picker', async () => {
  const dataDir = makeDataDir();
  const here = makeProjectDir();
  session(dataDir, 'sess-only', { run_id: 'cc-only-11223344', project_dir: here });
  const { main } = await mod('bin/link.src.mjs');
  const out = collector();

  const code = await main(['list'], baseEnv({ dataDir, projectDir: here }),
    { log: out.log, ...gitSeams() });

  assert.equal(code, 0, 'having nothing to link is not a failure');
  assert.match(out.text(), /No other project/i,
    `an empty picker must say why it is empty. Got:\n${out.text()}`);
  assertNoRunIds(out.text(), ['cc-only-11223344'], 'the empty picker');
});

// §6 Tier 1 links a parent to each subagent it spawns, and a sub-run shares its parent's
// directory. Listing them would put the same path on screen several times and invite somebody
// to revoke a join nobody made by hand.
test('sub-runs are not offered in the picker', async () => {
  const m = await machine();
  session(m.dataDir, 'sess-sub', {
    run_id: `${m.a}-sub-abc123`, project_dir: m.pricing, last_seen_at: Date.now(),
  });

  const j = (await m.run(['list', '--json'])).json();

  assert.equal(j.projects.length, 2,
    'a subagent run is not a project to connect to — it is already linked, automatically (§6 Tier 1)');
  await m.server.close();
});

// §6 Tier 2's signal, shown rather than acted on: the git remote partitions projects the way a
// human would. Two directories that are not repositories both answer "" and must NOT be
// grouped, which is the case a naive equality check gets wrong.
test('same remote is annotated, and two non-repositories are not "the same"', async () => {
  const dataDir = makeDataDir();
  const here = makeProjectDir({ git: true });
  const sibling = makeProjectDir({ git: true });
  const stranger = makeProjectDir();
  git(here, ['remote', 'add', 'origin', 'git@github.com:acme/thing.git']);
  git(sibling, ['remote', 'add', 'origin', 'git@github.com:acme/thing.git']);

  session(dataDir, 's-here', { run_id: 'cc-here-aaaaaaaa', project_dir: here });
  session(dataDir, 's-sib', { run_id: 'cc-sib-bbbbbbbb', project_dir: sibling, last_seen_at: Date.now() - DAY });
  session(dataDir, 's-str', { run_id: 'cc-str-cccccccc', project_dir: stranger, last_seen_at: Date.now() - (2 * DAY) });

  const { main } = await mod('bin/link.src.mjs');
  const out = collector();
  await main(['list', '--json'], baseEnv({ dataDir, projectDir: here }), { log: out.log });
  const j = JSON.parse(out.text());

  const sib = j.projects.find((p) => p.path === sibling);
  const str = j.projects.find((p) => p.path === stranger);
  assert.equal(sib?.sameRemote, true,
    'a sibling checkout of the same repository is the signal §6 measured; not showing it makes the '
    + 'picker a list of directories rather than a proposal');
  assert.equal(str?.sameRemote, false,
    'a directory that is not a repository has no remote — calling two blanks a match would group '
    + 'every scratch directory on the machine');
});

// ===========================================================================
// §6 — mesh, not hub (ricedb lib.rs:5654 reads the graph one hop deep)
// ===========================================================================

// The rule, on its own, with nothing else in the way: three nodes are three edges. A star would
// be two, and a reader "simplifying" this back into a star has to delete this test to do it.
test('pairsOf: three projects are three pairs, not two spokes', async () => {
  const { pairsOf } = await mod('bin/link.src.mjs');

  const pairs = pairsOf([{ runId: 'a' }, { runId: 'b' }, { runId: 'c' }]);

  assert.equal(pairs.length, 3,
    'C(3,2) = 3. Two would be a hub, and the backend does not walk a hub: from a spoke the '
    + 'consulted set is [spoke, hub] and the sibling is never reached (lib.rs:5654)');
  assert.deepEqual(pairs.map(([x, y]) => `${x.runId}${y.runId}`), ['ab', 'ac', 'bc'],
    'every unordered pair, once, in a stable order');
  assert.equal(pairsOf([{ runId: 'a' }, { runId: 'b' }, { runId: 'a' }]).length, 1,
    'a repeated side is one node — postLinkRun refuses a self-link outright, so a duplicate would '
    + 'fail the whole command rather than be ignored');
  assert.deepEqual(pairsOf([{ runId: 'a' }]), [],
    'one node is no edges, not an edge to itself');
});

// The assertion a regression to hub-and-spoke would actually trip: the request between the two
// projects the user named, neither of which is the one they typed the command in.
test('linking a group of three issues three pairwise links, including the one the hub would miss',
  async () => {
    const m = await machine();

    const r = await m.run(['link', m.pricing, m.analytics, '--json']);

    assert.equal(r.code, 0, `linking must succeed against a healthy instance. Got:\n${r.out}`);
    assert.equal(m.server.countOf('POST', LINK_ROUTE), 3,
      'three projects are three pairs; two calls means a star, and a star strands the two named '
      + 'projects from each other while reporting success');
    const bodies = m.server.calls('POST', LINK_ROUTE).map((c) => c.body);
    const has = (x, y) => bodies.some((body) => (body.run_id === x && body.linked_run_id === y)
      || (body.run_id === y && body.linked_run_id === x));
    assert.ok(has(m.current, m.a), 'this project must reach the first one named');
    assert.ok(has(m.current, m.b), 'this project must reach the second one named');
    assert.ok(has(m.a, m.b),
      'the two named projects must reach EACH OTHER. This is the edge a hub-and-spoke '
      + 'implementation silently omits, and the one the backend cannot reconstruct: it returns '
      + 'linked_run_ids without walking them (lib.rs:5654)');
    assert.equal(r.json().pairs, 3, '--json must report how many edges were made, not how many arguments');
    assertNoRunIds(r.out, m.runIds, 'link --json');

    await m.server.close();
  });

// `lib/links.mjs` writes both ends of every decision, so opening the other project tomorrow and
// asking what it is linked to gives the same answer. A mesh has to hold that for every pair.
test('every pair is recorded at both ends of the ledger', async () => {
  const m = await machine();

  await m.run(['link', m.pricing, m.analytics]);

  const reach = (runId) => m.links.linkedRunIds(m.cfg, runId).sort();
  assert.deepEqual(reach(m.current), [m.a, m.b].sort(),
    'this project records both of the projects it was joined to');
  assert.deepEqual(reach(m.a), [m.current, m.b].sort(),
    'the first named project records this one AND its sibling — one decision, recorded from every '
    + 'vantage point, is what stops `list` being silently wrong in the other repository');
  assert.deepEqual(reach(m.b), [m.current, m.a].sort(),
    'and the second, symmetrically');

  await m.server.close();
});

// The link is a decision; the server is state. Once it is made, `list` has to show it — this is
// the "reach is always inspectable" half of §6, and it is what makes offering a link safe.
test('a link becomes a checked box in the picker, at both ends', async () => {
  const m = await machine();

  await m.run(['link', m.pricing]);
  const j = (await m.run(['list', '--json'])).json();

  const pricing = j.projects.find((p) => p.path === m.pricing);
  const analytics = j.projects.find((p) => p.path === m.analytics);
  assert.equal(pricing?.linked, true, 'the project just linked must read as linked');
  assert.equal(analytics?.linked, false, 'and nothing else may have moved');
  assert.equal(j.linked, 1, 'the count is what a skill reports without parsing the picker');
  assert.match((await m.run(['list'])).out, /\[x\]/,
    'the human picker marks a link in force; §6 draws it as [x]');

  await m.server.close();
});

// ===========================================================================
// §6 — unlink, the thing that makes a link safe to offer at all
// ===========================================================================

test('unlink revokes one pair and leaves the others standing', async () => {
  const m = await machine();
  await m.run(['link', m.pricing, m.analytics]);
  m.server.reset();

  const r = await m.run(['unlink', m.pricing, '--json']);

  assert.equal(r.code, 0, `revoking a link the user made must succeed. Got:\n${r.out}`);
  assert.equal(m.server.countOf('POST', UNLINK_ROUTE), 1,
    'unlink is about THIS project\'s reach: one edge was named, one edge is revoked. Tearing down '
    + 'the edge between two other projects would revoke something nobody mentioned');
  assert.deepEqual(m.links.linkedRunIds(m.cfg, m.current), [m.b],
    'the revoked project is gone from this ledger and the other one is untouched');
  assert.deepEqual(m.links.linkedRunIds(m.cfg, m.a), [m.b],
    'the revoked project keeps the edge it has to its sibling — that edge was a separate decision');
  assertNoRunIds(r.out, m.runIds, 'unlink --json');

  await m.server.close();
});

// A revoked pair reads as *undecided*, not as declined: withdrawing a link is not the same act
// as refusing an offer, and conflating them would suppress a Tier 2 proposal the user might
// well accept next month.
test('a revoked pair is undecided again, not declined', async () => {
  const m = await machine();
  await m.run(['link', m.pricing]);

  await m.run(['unlink', m.pricing]);

  assert.equal(m.links.linkDecision(m.cfg, m.current, m.a), null,
    'no record at all is the state a revoked pair returns to; "declined" would silently stop the '
    + 'same-remote offer from ever proposing it again');
  await m.server.close();
});

// Naming nothing is not "unlink everything". Reach is easy to widen by accident and expensive
// to discover, but a surprise revocation is how a user loses a week of memory they still wanted.
test('unlink with no target refuses, and shows what there is to choose from', async () => {
  const m = await machine();
  await m.run(['link', m.pricing]);
  m.server.reset();

  const r = await m.run(['unlink']);

  assert.equal(r.code, 1, 'a bare unlink must not guess; exiting non-zero is what the skill reads');
  assert.equal(m.server.countOf('POST', UNLINK_ROUTE), 0,
    'nothing may be revoked before a target is named');
  assert.ok(r.out.includes(m.pricing),
    `the refusal must show the picker, or the user has to run a second command to answer the `
    + `question the first one asked. Got:\n${r.out}`);
  await m.server.close();
});

// ===========================================================================
// SC-05 — the `/clear` recovery, in one command with no argument
// ===========================================================================

// §4.3 gives `clear` the only row in the source table that abandons its mapping, and SC-05
// records where it went. This is what makes that recoverable: the session record already knows
// the answer, so the command must not make the user look it up.
test('a cleared run offers the run it came from first, and links it with no argument', async () => {
  const m = await machine();
  // The state a `/clear` leaves behind: the live run carries `-c1` and names its predecessor.
  session(m.dataDir, 'sess-here', {
    run_id: 'cc-storefront-1a2b3c4d-c1',
    project_dir: m.here,
    last_seen_at: Date.now(),
    clear_count: 1,
    previous_run_id: 'cc-storefront-1a2b3c4d',
  });
  session(m.dataDir, 'sess-before-clear', {
    run_id: 'cc-storefront-1a2b3c4d', project_dir: m.here, last_seen_at: Date.now() - 60000,
  });

  const listed = (await m.run(['list', '--json'])).json();
  assert.equal(listed.projects[0].previous, true,
    'the run the /clear moved away from is offered FIRST — it is the single most likely thing '
    + 'somebody running this command wants, and it is already on disk');
  assert.equal(listed.projects[0].path, m.here,
    'it is the same directory: after a reset one project holds two runs, and only the date and '
    + 'the note tell them apart');
  assert.match((await m.run(['list'])).out, /before \/clear/,
    'the picker has to say which line is the pre-reset run, or two identical paths are unreadable');

  const r = await m.run(['link', '--json']);

  assert.equal(r.code, 0, `bare \`link\` after a /clear must work. Got:\n${r.out}`);
  assert.equal(m.server.countOf('POST', LINK_ROUTE), 1,
    'one edge: the cleared run to the run it came from');
  const body = m.server.lastCall('POST', LINK_ROUTE)?.body;
  assert.equal(body.run_id, 'cc-storefront-1a2b3c4d-c1', 'linking FROM the live, cleared run');
  assert.equal(body.linked_run_id, 'cc-storefront-1a2b3c4d',
    'and TO the run previous_run_id names — not to a fresh derivation, which would never '
    + 'reproduce the -c1 suffix and would reconnect nothing');
  assertNoRunIds(r.out, [...m.runIds, 'cc-storefront-1a2b3c4d-c1'], 'link after a /clear');

  await m.server.close();
});

// A session that was never cleared has no previous run, and bare `link` must say so rather than
// pick the most recent project and connect it to something.
test('bare link in a session that was never cleared refuses instead of guessing', async () => {
  const m = await machine();

  const r = await m.run(['link', '--json']);

  assert.equal(r.code, 1, 'guessing which project to connect is exactly the mistake unlink exists for');
  assert.equal(m.server.countOf('POST', LINK_ROUTE), 0, 'nothing may be joined without a target');
  assert.equal(r.json().state, 'no_target', 'the skill branches on the state, not on the prose');
  await m.server.close();
});

// ===========================================================================
// Addressing — a directory in, a project out
// ===========================================================================

// The picker renders `~/work/pricing`, so somebody reading it types the part that identifies
// it. Refusing on a technicality when exactly one project matches is pedantry.
test('a project is addressable by a trailing fragment of its path', async () => {
  const m = await machine();
  const tail = m.pricing.split('/').pop();

  const r = await m.run(['link', String(tail), '--json']);

  assert.equal(r.code, 0, `an unambiguous fragment must resolve. Got:\n${r.out}`);
  assert.equal(m.server.lastCall('POST', LINK_ROUTE)?.body.linked_run_id, m.a,
    'and it must resolve to the project whose path ends with it, not to the first one listed');
  await m.server.close();
});

test('a fragment matching two projects is refused by name rather than resolved arbitrarily', async () => {
  const dataDir = makeDataDir();
  const here = makeProjectDir();
  const root = makeProjectDir();
  const one = join(root, 'alpha', 'api');
  const two = join(root, 'beta', 'api');
  makeProjectDir(); // a third directory that matches nothing, so the refusal is about the two
  for (const [i, dir] of [one, two].entries()) {
    session(dataDir, `s-${i}`, { run_id: `cc-api${i}-1111111${i}`, project_dir: dir });
  }
  session(dataDir, 's-here', { run_id: 'cc-here-99999999', project_dir: here });
  const { main } = await mod('bin/link.src.mjs');
  const out = collector();

  const code = await main(['link', 'api', '--json'], baseEnv({ dataDir, projectDir: here }),
    { log: out.log, ...gitSeams() });

  assert.equal(code, 1, 'picking one of two matching projects would connect memory the user never named');
  const j = JSON.parse(out.text());
  assert.equal(j.state, 'ambiguous', 'the state distinguishes "which one?" from "no such project"');
  assert.ok(j.detail.includes(one) && j.detail.includes(two),
    `the refusal has to name both candidates as paths, or the user cannot answer it. Got:\n${j.detail}`);
  assertNoRunIds(out.text(), ['cc-api0-11111110', 'cc-api1-11111111'], 'the ambiguous refusal');
});

test('a directory Mubit has never seen is refused, and points at the picker', async () => {
  const m = await machine();

  const r = await m.run(['link', '/nowhere/at/all', '--json']);

  assert.equal(r.code, 1, 'linking to a project with no run would create an edge to nothing');
  assert.equal(r.json().state, 'unknown_project', 'a typed state, so the skill does not parse prose');
  assert.match(r.json().detail, /list/,
    'the message must name the command that answers "then what CAN I link?"');
  assert.equal(m.server.countOf('POST', LINK_ROUTE), 0, 'and nothing was dialed');
  await m.server.close();
});

// A project with no run has nothing to link *from*. Inventing a run id here would create an edge
// from a run no hook will ever derive again.
test('a project with no run of its own says so instead of inventing one', async () => {
  const dataDir = makeDataDir();
  const { main } = await mod('bin/link.src.mjs');
  const out = collector();

  const code = await main(['list', '--json'], baseEnv({ dataDir, projectDir: makeProjectDir() }),
    { log: out.log, ...gitSeams() });

  assert.equal(code, 1, 'having no run is a state the skill has to be able to detect');
  assert.equal(JSON.parse(out.text()).state, 'no_run', 'typed, so the skill can say what to do about it');
  assert.match(JSON.parse(out.text()).detail, /SessionStart|session/i,
    'the fix is starting a session here — the run is minted at SessionStart, and /reload-plugins '
    + 'does not fire one');
});

// ===========================================================================
// Degraded — the decision survives, the assertion does not
// ===========================================================================

// `lib/links.mjs` exists so that an unreachable instance costs the assertion and not the intent:
// the ledger is the record of what the user decided, re-assertion is idempotent, and the next
// session makes it for free. Reporting this as a plain failure would send somebody to fix a
// decision that is already recorded.
test('an instance that will not confirm costs the assertion, not the decision', async () => {
  const m = await machine({ routes: { [`POST ${LINK_ROUTE}`]: { status: 503, json: { error: 'down' } } } });

  const r = await m.run(['link', m.pricing, '--json']);

  assert.equal(r.code, 2,
    'exit 2 is "not confirmed", distinct from exit 1 "did not happen" — the same distinction '
    + '/mubit-memory:auth draws for a workspace that is still provisioning');
  assert.equal(r.json().state, 'not_asserted', 'the state says which half succeeded');
  assert.deepEqual(m.links.linkedRunIds(m.cfg, m.current), [m.a],
    'the decision is on disk, so `list` is right offline and the next run re-asserts it');
  assert.match(r.json().detail, /again|idempotent|re-assert/i,
    'the message has to say that re-running is safe, or the user undoes something that worked');
  await m.server.close();
});

// The asymmetry that matters: widening reach may wait for the network, and narrowing it may not.
// A revocation that silently did not happen is the one failure this surface cannot afford.
test('a revocation takes effect locally even when Mubit does not confirm it', async () => {
  const m = await machine();
  await m.run(['link', m.pricing]);
  m.server.route(`POST ${UNLINK_ROUTE}`, { status: 503, json: { error: 'down' } });

  const r = await m.run(['unlink', m.pricing, '--json']);

  assert.equal(r.code, 2, 'the user is told it is not confirmed');
  assert.deepEqual(m.links.linkedRunIds(m.cfg, m.current), [],
    'but the edge is gone from this machine regardless: a user narrowing their reach must never '
    + 'be blocked by an instance being down');
  assert.match(r.json().detail, /again|still/i,
    'and must be told the far end may still be readable until the instance takes the revocation');
  await m.server.close();
});

// §4.1: an install nobody has signed in to yet is an ordinary state. The decision is still
// recordable, so the command must not dead-end on it.
test('an unconfigured install still records the decision', async () => {
  const dataDir = makeDataDir();
  const here = makeProjectDir();
  const other = makeProjectDir();
  session(dataDir, 's-here', { run_id: 'cc-here-abcdef01', project_dir: here });
  session(dataDir, 's-other', { run_id: 'cc-other-abcdef02', project_dir: other });
  const env = baseEnv({ dataDir, projectDir: here, extra: { MUBIT_ENDPOINT: '', MUBIT_API_KEY: '' } });
  const { main } = await mod('bin/link.src.mjs');
  const links = await lib('links.mjs');
  const config = await lib('config.mjs');
  const out = collector();

  const code = await main(['link', other, '--json'], env, { log: out.log, ...gitSeams() });

  assert.equal(code, 2, 'unconfigured is "not asserted", not "refused"');
  assert.deepEqual(links.linkedRunIds(config.loadConfig(env), 'cc-here-abcdef01'), ['cc-other-abcdef02'],
    'the decision survives an install with no endpoint; the first configured session asserts it');
});

// ===========================================================================
// The CLI surface
// ===========================================================================

test('parseArgs: list is the default, --json is positional-independent', async () => {
  const { parseArgs } = await mod('bin/link.src.mjs');

  assert.deepEqual(parseArgs([]), { command: 'list', targets: [], json: false },
    'the bare command answers a question rather than changing anything');
  assert.deepEqual(parseArgs(['--json']), { command: 'list', targets: [], json: true },
    'a flag alone must not be read as a subcommand');
  assert.deepEqual(parseArgs(['link', '~/a', '--json']), { command: 'link', targets: ['~/a'], json: true },
    'flags are stripped from the targets, wherever they appear');
  assert.deepEqual(parseArgs(['--json', 'unlink', '~/a']), { command: 'unlink', targets: ['~/a'], json: true },
    'and the subcommand is found whether or not a flag came first');
  assert.deepEqual(parseArgs(['~/a']).targets, ['~/a'],
    'a bare directory is a target, not an unknown subcommand — `link` is the whole verb set');
});

// The rendering rules, on their own: §6 draws paths the way a person writes them, and dates
// coarsely enough to skim.
test('paths render with ~ and ages render coarsely', async () => {
  const { tildify, relativeAge } = await mod('bin/link.src.mjs');
  const now = Date.parse('2026-08-21T12:00:00Z');

  assert.equal(tildify('/Users/me/work/api', '/Users/me'), '~/work/api',
    'the home prefix is noise in every line of the picker');
  assert.equal(tildify('/opt/src/api', '/Users/me'), '/opt/src/api',
    'a path outside home is left alone rather than mangled');
  assert.equal(tildify('/Users/me', '/Users/me/'), '~', 'a trailing slash on HOME is not a different home');

  assert.equal(relativeAge(now - 30_000, now), 'just now', 'a session from this minute is not "0m ago"');
  assert.equal(relativeAge(now - (5 * 60_000), now), '5m ago');
  assert.equal(relativeAge(now - (3 * 3600_000), now), '3h ago');
  assert.equal(relativeAge(now - (2 * DAY), now), '2d ago', '§6 renders exactly this');
  assert.equal(relativeAge(0, now), 'unknown',
    'a record with no timestamp is unknown, not "56 years ago"');
});

// The picker's date column answers "when was I last working there", so it comes from the
// session map. The ledger's timestamp is when the *decision* was recorded, and letting that win
// makes a project linked today read as though it were worked in today — the column would then
// mean two different things on two rows of the same list.
test('linking a project does not make it look recently used', async () => {
  const m = await machine();

  const before = (await m.run(['list', '--json'])).json()
    .projects.find((p) => p.path === m.pricing);
  await m.run(['link', m.pricing]);
  const after = (await m.run(['list', '--json'])).json()
    .projects.find((p) => p.path === m.pricing);

  assert.equal(after.age, '2d ago',
    `the age must still come from the session record. Got ${after.age}, which is when the link `
    + 'was written rather than when the project was last open');
  assert.equal(after.lastSeenAt, before.lastSeenAt,
    'the ledger does not overwrite what the session map knows about a project it has a record for');
  assert.equal(after.linked, true, 'and the link itself did land');

  await m.server.close();
});

// The other half of the same rule: a far end the session map has never heard of — a link made
// on another machine, or one whose session file was pruned — must still be listed, because a
// link in force that no surface shows is worse than one that needs the network.
test('a linked project with no session record is still listed, from the ledger', async () => {
  const m = await machine();
  const elsewhere = makeProjectDir();
  const links = await lib('links.mjs');
  links.recordLink(m.cfg, { runId: m.current, projectDir: m.here },
    { runId: 'cc-elsewhere-77778888', projectDir: elsewhere });

  const j = (await m.run(['list', '--json'])).json();

  const found = j.projects.find((p) => p.path === elsewhere);
  assert.ok(found, `a link in force must appear in the picker even with no session record. Got:\n${j.detail}`);
  assert.equal(found.linked, true, 'and it must read as linked, because it is');
  assertNoRunIds(j.detail, ['cc-elsewhere-77778888'], 'a ledger-only project');

  await m.server.close();
});
