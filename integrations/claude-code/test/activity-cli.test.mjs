// @ts-check
/**
 * `bin/activity.src.mjs` — the surface a person actually reaches the audit question through.
 *
 * The design decision this file exists to pin is **stdout by default, `--out` opt-in**. A CLI
 * that prints composes: it pipes, it redirects, it goes into `less`, and it writes to nobody's
 * disk — which resolves the consent question by not having one. `--out` is then a deliberate
 * act, and it is guarded three ways: it refuses to overwrite, it refuses any path inside the
 * plugin data directory (an export there is an unbounded copy sitting outside `pruneStale`'s
 * TTL table, so it would live forever and nothing would ever mention it), and it says out loud
 * when the file it just wrote is inside a git working tree that is not ignoring it.
 *
 * The second is that **a failure writes nothing**. A half-written export is worse than none:
 * it is a file that looks like a record.
 *
 * No real network — every test drives `main()` against `fakeMubit`, capturing stdout and
 * stderr rather than letting them reach the terminal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { baseEnv, fakeMubit, makeDataDir, makeProjectDir, mod, tempDir } from './helpers/harness.mjs';

const RUN = 'cc-here-00000001';
const EXPORT_ROUTE = 'POST /v2/control/activity/export';
const LIST_ROUTE = 'POST /v2/control/activity';

function activityEntry(over = {}) {
  return {
    id: 'a3c1f0de-0000-4000-8000-000000000001',
    run_id: RUN,
    entry_type: 'trace',
    content: 'ran the migration',
    created_at: '2026-08-19T15:03:18Z',
    metadata_json: '{}',
    reference_id: 'ref_1',
    ...over,
  };
}

function listPage(entries, next = '', total = entries.length) {
  return { json: { entries, next_page_token: next, total_visible: total } };
}

function exportBody(content) {
  return { json: { format: 'jsonl', content, entry_count: content.split('\n').length } };
}

/** A marker for `<run>`, so the CLI's run resolver has something to find. */
function marker(dataDir, runId, updatedAt) {
  mkdirSync(join(dataDir, 'status'), { recursive: true });
  writeFileSync(join(dataDir, 'status', `${runId}.json`),
    JSON.stringify({ run_id: runId, state: 'ready', updated_at: updatedAt }));
}

/**
 * A fake instance, an env pointed at it, and the CLI, with both streams captured.
 *
 * @param {import('node:test').TestContext} t
 * @param {{routes?: Record<string, any>, dataDir?: string, extra?: Record<string, string>}} [o]
 */
async function cli(t, o = {}) {
  const dataDir = o.dataDir ?? makeDataDir();
  const server = await fakeMubit(o.routes ?? {});
  t.after(() => server.close());
  const env = baseEnv({ dataDir, endpoint: server.url, extra: o.extra });
  const bin = await mod('bin/activity.src.mjs');

  /** @type {string[]} */ const out = [];
  /** @type {string[]} */ const err = [];
  const run = (argv, over = {}) => bin.main(argv, { ...env, ...over }, {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });

  return { dataDir, server, env, bin, run, out, err, stdout: () => out.join(''), stderr: () => err.join('') };
}

// ===========================================================================
// Arguments
// ===========================================================================

// A typo in a flag is the one input where guessing is worse than refusing: `--exclude-derive`
// silently ignored produces an export that claims to be filtered and is not.
test('cli: an unknown flag exits 2 and dials nothing', async (t) => {
  const { server, run, stderr } = await cli(t, { routes: { [LIST_ROUTE]: listPage([]) } });

  for (const argv of [['--exclude-derive'], ['--nope'], ['-x'], ['--out'], ['--limit']]) {
    assert.equal(await run(argv), 2, `${argv.join(' ')} must exit 2`);
  }
  assert.match(stderr(), /unknown|missing|usage/i);
  server.assertNotCalled('POST', '/v2/control/activity');
  server.assertNotCalled('POST', '/v2/control/activity/export');
});

test('cli: --help exits 0, prints usage, and dials nothing', async (t) => {
  const { server, run, stdout } = await cli(t);
  assert.equal(await run(['--help']), 0);
  assert.match(stdout(), /--out/);
  assert.match(stdout(), /--export/);
  assert.equal(server.requests.length, 0);
});

// ===========================================================================
// stdout by default
// ===========================================================================

/**
 * The whole `--out` design in one assertion: without it, nothing anywhere on disk changes.
 * The temp directory is checked as a whole rather than one expected path, because the failure
 * being guarded against is a file appearing *somewhere*, not at a name we predicted.
 */
test('cli: with no --out, an export writes no file and prints to stdout', async (t) => {
  const dataDir = makeDataDir();
  const { run, stdout, stderr } = await cli(t, {
    dataDir,
    routes: { [EXPORT_ROUTE]: exportBody('{"id":"a"}\n{"id":"b"}') },
  });
  marker(dataDir, RUN, Date.now());

  const code = await run(['--export']);
  assert.equal(code, 0, stderr());
  assert.equal(stdout(), '{"id":"a"}\n{"id":"b"}',
    'the export content is the payload and owns stdout, byte for byte');
  assert.match(stderr(), /2 entries/, 'the summary goes to stderr so the payload stays pipeable');

  // Nothing new under the data dir but the config cache the CLI legitimately writes.
  const strays = ['activity.jsonl', 'export.jsonl', 'out.jsonl']
    .filter((n) => existsSync(join(dataDir, n)));
  assert.deepEqual(strays, []);
});

test('cli: a listing prints its rows to stdout and its summary to stderr', async (t) => {
  const dataDir = makeDataDir();
  const { run, stdout, stderr } = await cli(t, {
    dataDir,
    routes: { [LIST_ROUTE]: listPage([activityEntry(), activityEntry({ id: 'b', content: 'second' })], '', 2) },
  });
  marker(dataDir, RUN, Date.now());

  assert.equal(await run([]), 0, stderr());
  assert.match(stdout(), /ran the migration/);
  assert.match(stdout(), /second/);
  assert.match(stderr(), new RegExp(RUN));
});

// `--jsonl` is what makes this composable with everything else: one entry per line, parseable
// without the header the human format carries.
test('cli: --jsonl emits one parseable object per entry and nothing else on stdout', async (t) => {
  const dataDir = makeDataDir();
  const { run, stdout } = await cli(t, {
    dataDir,
    routes: { [LIST_ROUTE]: listPage([activityEntry(), activityEntry({ id: 'b' })], '', 2) },
  });
  marker(dataDir, RUN, Date.now());

  assert.equal(await run(['--jsonl']), 0);
  const lines = stdout().trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.deepEqual(Object.keys(parsed), ['id', 'created_at', 'entry_type', 'run_id', 'content']);
  }
});

// ===========================================================================
// The key
// ===========================================================================

/**
 * `--json` is the mode most likely to be piped somewhere durable — a file, a ticket, a paste.
 * The config carries the key; nothing this command emits may.
 */
test('cli: --json never prints the API key, on success or on failure', async (t) => {
  const dataDir = makeDataDir();
  const key = 'mbt_test_0123456789abcdef_deadbeefcafebabe0123456789abcdef';
  const { run, stdout, stderr } = await cli(t, {
    dataDir,
    routes: {
      [LIST_ROUTE]: (req) => ({ status: 400, json: { error: `rejected ${req.headers.authorization}` } }),
    },
  });
  marker(dataDir, RUN, Date.now());

  await run(['--json']);
  const all = stdout() + stderr();
  assert.ok(!all.includes(key), `the key reached the output:\n${all}`);
  assert.match(all, /REDACTED/, 'and the removal is visible rather than silent');
});

// ===========================================================================
// --out
// ===========================================================================

test('cli: --out writes the file and reports the absolute path and byte count', async (t) => {
  const dataDir = makeDataDir();
  const dest = join(tempDir('mubit-out-'), 'audit.jsonl');
  const content = '{"id":"a"}\n{"id":"b"}';
  const { run, stdout, stderr } = await cli(t, { dataDir, routes: { [EXPORT_ROUTE]: exportBody(content) } });
  marker(dataDir, RUN, Date.now());

  assert.equal(await run(['--export', '--out', dest]), 0, stderr());
  assert.equal(readFileSync(dest, 'utf8'), content, 'the file is the content, byte for byte');
  // With `--out` the payload went to the file, so the summary is the output and takes stdout.
  assert.match(stdout(), new RegExp(dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the absolute path has to be in the output — the skill has to be able to name it');
  assert.match(stdout(), new RegExp(String(Buffer.byteLength(content))));
});

/**
 * Refusing to overwrite is not politeness. The single most likely second run of this command
 * is the same command again, and the file it would clobber is the artefact somebody kept.
 */
test('cli: --out refuses to overwrite an existing file, and dials nothing', async (t) => {
  const dataDir = makeDataDir();
  const dest = join(tempDir('mubit-out-'), 'audit.jsonl');
  writeFileSync(dest, 'the artefact somebody kept');

  const { server, run, stderr } = await cli(t, { dataDir, routes: { [EXPORT_ROUTE]: exportBody('{"id":"a"}') } });
  marker(dataDir, RUN, Date.now());

  assert.equal(await run(['--export', '--out', dest]), 1);
  assert.equal(readFileSync(dest, 'utf8'), 'the artefact somebody kept');
  assert.match(stderr(), /exists/i);
  server.assertNotCalled('POST', '/v2/control/activity/export',);
});

/**
 * An export inside the plugin data directory is an unbounded copy of the instance's memory
 * sitting where nothing looks: `pruneStale`'s TTL table names the directories it sweeps, and
 * this would not be one of them. It would live forever, grow with every run, and never appear
 * in anything the user reads.
 */
test('cli: --out refuses any path inside the plugin data directory', async (t) => {
  const dataDir = makeDataDir();
  const { server, run, stderr } = await cli(t, { dataDir, routes: { [EXPORT_ROUTE]: exportBody('{"id":"a"}') } });
  marker(dataDir, RUN, Date.now());

  for (const dest of [
    join(dataDir, 'audit.jsonl'),
    join(dataDir, 'runs', 'audit.jsonl'),
    join(dataDir, 'runs', RUN, 'deep', 'audit.jsonl'),
    // Resolved before it is compared, so a path that only *looks* like it leaves does not.
    join(dataDir, 'runs', '..', 'audit.jsonl'),
  ]) {
    assert.equal(await run(['--export', '--out', dest]), 1, `must refuse ${dest}`);
    assert.ok(!existsSync(dest), `${dest} was written anyway`);
  }
  assert.match(stderr(), /data dir/i);
  server.assertNotCalled('POST', '/v2/control/activity/export');
});

/**
 * Not a refusal — a warning. Writing an export into a repo is a perfectly reasonable thing to
 * do deliberately and a very bad thing to do accidentally, and the difference is whether git
 * is about to offer it up for commit.
 */
test('cli: --out warns when the destination is inside a git tree and not ignored', async (t) => {
  const dataDir = makeDataDir();
  const repo = makeProjectDir({ git: true });
  const dest = join(repo, 'audit.jsonl');
  const { run, stdout, stderr } = await cli(t, { dataDir, routes: { [EXPORT_ROUTE]: exportBody('{"id":"a"}') } });
  marker(dataDir, RUN, Date.now());

  assert.equal(await run(['--export', '--out', dest]), 0, stderr());
  assert.ok(existsSync(dest), 'a warning is not a refusal — the file is still written');
  assert.match(stdout() + stderr(), /git|ignore/i);
});

test('cli: --out says nothing about git for a path that is ignored', async (t) => {
  const dataDir = makeDataDir();
  const repo = makeProjectDir({ git: true, files: { '.gitignore': 'audit.jsonl\n' } });
  const dest = join(repo, 'audit.jsonl');
  const { run, stdout, stderr } = await cli(t, { dataDir, routes: { [EXPORT_ROUTE]: exportBody('{"id":"a"}') } });
  marker(dataDir, RUN, Date.now());

  assert.equal(await run(['--export', '--out', dest]), 0, stderr());
  assert.doesNotMatch(stdout() + stderr(), /not ignored/i);
});

/**
 * A half-written export is worse than no export: it is a file that looks like a record. The
 * file is opened only after the whole response is in hand.
 */
test('cli: a failed upstream writes no file at all', async (t) => {
  const dataDir = makeDataDir();
  const dest = join(tempDir('mubit-out-'), 'audit.jsonl');
  const { run, stderr } = await cli(t, {
    dataDir,
    routes: { [EXPORT_ROUTE]: { status: 503, json: { error: 'unavailable' } } },
  });
  marker(dataDir, RUN, Date.now());

  assert.equal(await run(['--export', '--out', dest]), 1);
  assert.equal(existsSync(dest), false, 'a partial file is a record of nothing that reads as a record');
  assert.match(stderr(), /503|unreachable|unavailable/i);
});

// An empty export is a failure upstream, and it stays a failure here: the command must not
// create a zero-byte file that a reader would take for "the instance holds nothing".
test('cli: an empty export writes no file and fails', async (t) => {
  const dataDir = makeDataDir();
  const dest = join(tempDir('mubit-out-'), 'audit.jsonl');
  const { run } = await cli(t, {
    dataDir,
    routes: { [EXPORT_ROUTE]: { json: { format: 'jsonl', content: '', entry_count: 0 } } },
  });
  marker(dataDir, RUN, Date.now());

  assert.equal(await run(['--export', '--out', dest]), 1);
  assert.equal(existsSync(dest), false);
});

// ===========================================================================
// Run resolution
// ===========================================================================

test('cli: --run wins over anything on disk', async (t) => {
  const dataDir = makeDataDir();
  const { server, run } = await cli(t, { dataDir, routes: { [LIST_ROUTE]: listPage([]) } });
  marker(dataDir, 'cc-somewhere-else', Date.now());

  assert.equal(await run(['--run', RUN]), 0);
  assert.equal(server.lastCall('POST', '/v2/control/activity')?.body.run_id, RUN);
});

/**
 * The `-c<n>` case, which is the whole reason this cannot be "the first marker in the
 * directory". After a `/clear` the run is `cc-<slug>-<hash>-c1` while the pre-clear marker is
 * still on disk under its twelve-hour TTL — so a resolver that ignores the counter answers
 * with the run the user just cleared, and reports its activity as though it were this
 * session's.
 */
test('cli: the newest marker wins, and a clear counter breaks a tie', async (t) => {
  const dataDir = makeDataDir();
  const { server, bin, run } = await cli(t, { dataDir, routes: { [LIST_ROUTE]: listPage([]) } });

  const now = Date.now();
  marker(dataDir, 'cc-proj-aaaa', now - 60_000);
  marker(dataDir, 'cc-proj-aaaa-c1', now);
  assert.equal(bin.pickRun(dataDir, ''), 'cc-proj-aaaa-c1');

  // Same instant — which happens, because both markers can be stamped inside one tick. The
  // counter is then the only thing that says which run this session is writing to.
  const tie = makeDataDir();
  marker(tie, 'cc-proj-bbbb', now);
  marker(tie, 'cc-proj-bbbb-c2', now);
  marker(tie, 'cc-proj-bbbb-c1', now);
  assert.equal(bin.pickRun(tie, ''), 'cc-proj-bbbb-c2');

  assert.equal(await run([]), 0);
  assert.equal(server.lastCall('POST', '/v2/control/activity')?.body.run_id, 'cc-proj-aaaa-c1');
});

test('cli: health.json is not a run, and an empty data dir resolves to nothing', async (t) => {
  const dataDir = makeDataDir();
  const { bin, run, stderr } = await cli(t, { dataDir, routes: { [LIST_ROUTE]: listPage([]) } });

  writeFileSync(join(dataDir, 'status', 'health.json'), JSON.stringify({ ok: true, at: Date.now() }));
  assert.equal(bin.pickRun(dataDir, ''), '');
  assert.equal(bin.pickRun('/nope/not/a/dir', ''), '');

  // And a command with no run to work on says so rather than listing the whole instance.
  assert.equal(await run([]), 1);
  assert.match(stderr(), /run/i);
});

// The escape hatch, and it has to be typed. An instance-wide question is a different question.
test('cli: --all-runs sends no run_id, and is refused for an export', async (t) => {
  const dataDir = makeDataDir();
  const { server, run, stderr } = await cli(t, {
    dataDir,
    routes: { [LIST_ROUTE]: listPage([]), [EXPORT_ROUTE]: exportBody('{"id":"a"}') },
  });

  assert.equal(await run(['--all-runs']), 0);
  const body = server.lastCall('POST', '/v2/control/activity')?.body;
  assert.ok(!('run_id' in body), `body was ${JSON.stringify(body)}`);

  // The export route has no `limit`, so scope is its only bound and "every run" is unbounded.
  assert.equal(await run(['--all-runs', '--export']), 2);
  assert.match(stderr(), /--scan|scope|bound/i);
  server.assertNotCalled('POST', '/v2/control/activity/export');
});

// ===========================================================================
// The corrections reach the user
// ===========================================================================

/**
 * The last mile of the design. Re-filtering client-side is worth nothing if the correction
 * stops at the library boundary: the person reading the output is the one who has to know
 * their instance ignored the flag they asked for.
 */
test('cli: an unhonoured exclude-derived is reported in the output, not swallowed', async (t) => {
  const dataDir = makeDataDir();
  const { run, stdout, stderr } = await cli(t, {
    dataDir,
    routes: {
      [LIST_ROUTE]: listPage([
        activityEntry({ id: 'plain' }),
        activityEntry({ id: 'promoted', metadata_json: '{"promotion":true}' }),
      ], '', 2),
    },
  });
  marker(dataDir, RUN, Date.now());

  assert.equal(await run(['--exclude-derived']), 0, stderr());
  const all = stdout() + stderr();
  assert.doesNotMatch(stdout(), /promoted/, 'the derived entry must not be listed');
  assert.match(all, /did not honour|dropped|filtered locally/i,
    'the user asked for non-derived entries and the instance sent one; that is the finding');
});

test('cli: --json carries every flag a caller would need to audit the answer', async (t) => {
  const dataDir = makeDataDir();
  const { run, stdout } = await cli(t, {
    dataDir,
    routes: { [LIST_ROUTE]: listPage([activityEntry()], '', 1) },
  });
  marker(dataDir, RUN, Date.now());

  assert.equal(await run(['--json', '--exclude-derived']), 0);
  const payload = JSON.parse(stdout());
  for (const key of ['ok', 'mode', 'run', 'entries', 'totalVisible', 'droppedDerived',
    'excludeDerivedFallbackUsed', 'projectionFallbackUsed']) {
    assert.ok(key in payload, `--json is missing \`${key}\`: ${Object.keys(payload).join(', ')}`);
  }
});

// A scan reports its own truncation into the output for the same reason the library reports it
// at all: a short answer that says it is short is usable.
test('cli: a truncated scan says so', async (t) => {
  const dataDir = makeDataDir();
  const { run, stdout, stderr } = await cli(t, {
    dataDir,
    routes: { [LIST_ROUTE]: listPage([activityEntry()], '1', 900) },
  });
  marker(dataDir, RUN, Date.now());

  assert.equal(await run(['--scan', '--limit', '1', '--max', '2']), 0, stderr());
  assert.match(stdout() + stderr(), /truncat|max_entries|incomplete/i);
});
