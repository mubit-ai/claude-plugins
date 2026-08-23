// @ts-check
/**
 * `lib/dashboard-data.mjs` — the local half of the dashboard, and the four traps in it.
 *
 * The property this file protects is that **looking at the plugin's state does not change it,
 * and does not publish it**. A dashboard is a reader; every way a reader can accidentally
 * become a writer or a leak is enumerated here:
 *
 *   1. **Redaction is not the user's to switch off here.** `redactText` honours
 *      `cfg.redact === false` by skipping the scrub entirely. That setting is consent to send
 *      one's own secrets to one's own instance over TLS; it is not consent to render them into
 *      an HTML page. The dashboard must pass a literal policy, never `cfg` — and the test for
 *      it sets `redact: false` and asserts the key is *still* gone.
 *   2. **Reading the spool must not drain it.** `spoolStats` is a `readdir`; `readBatch`
 *      unlinks anything it cannot parse. A health poll built on the wrong one deletes captures
 *      as a side effect of counting them.
 *   3. **Reading the breaker must not trip it.** `readBreaker` is pure; `allowRequest` spends
 *      the half-open probe and writes.
 *   4. **Runs are enumerated from `status/`, not `runs/`.** The marker is the only file
 *      guaranteed to exist. A run that recalled and never captured has no `runs/<id>/` at all.
 *
 * Plus the two that come with writing anything at all: the rollup writes only under
 * `<dataDir>/dashboard/`, and a run id from a query string cannot climb out of it.
 *
 * No network. Nothing in this module has a socket in it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { lib, baseEnv, makeDataDir, tempDir } from './helpers/harness.mjs';
import { SECRETS } from './helpers/fixtures.mjs';

/**
 * A data dir, a config resolved against it, and the module under test.
 *
 * `extra` reaches `loadConfig` as environment, which is how `redact: false` is set for the
 * trap test — through the same path a real user would use.
 *
 * @param {import('node:test').TestContext} t
 * @param {{extra?: Record<string, string>}} [o]
 */
async function setup(t, o = {}) {
  const dataDir = makeDataDir();
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(baseEnv({ dataDir, extra: o.extra }));
  const mod = await lib('dashboard-data.mjs');
  t.after(() => { /* makeDataDir cleans itself up at process exit */ });
  return { dataDir, cfg, mod };
}

/** Write a status marker, which is what makes a run exist. */
function writeMarker(dataDir, runId, patch = {}) {
  const p = join(dataDir, 'status', `${runId}.json`);
  writeFileSync(p, JSON.stringify({
    run_id: runId, mode: 'hosted', state: 'ready', updated_at: Date.now(), ...patch,
  }));
  return p;
}

/** Write one turn record under `runs/<run>/turns/<prompt>.json`. */
function writeTurn(dataDir, runId, turn) {
  const dir = join(dataDir, 'runs', runId, 'turns');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${turn.prompt_id}.json`);
  writeFileSync(p, JSON.stringify(turn));
  return p;
}

/** A complete-enough turn: the five required fields plus whatever the test cares about. */
function turnFixture(over = {}) {
  return {
    prompt: 'rebuild the bundle and re-run the suite',
    prompt_id: '11111111-2222-3333-4444-555555555555',
    session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    started_at: 1_700_000_000_000,
    recalled: [],
    ...over,
  };
}

function writeSpoolItem(dataDir, runId, name) {
  const dir = join(dataDir, 'runs', runId, 'spool');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify({ item_id: name, content_type: 'tool_call' }));
}

// ---------------------------------------------------------------------------
// Data directories
// ---------------------------------------------------------------------------

// `MUBIT_CC_DATA_DIR` can point anywhere at all, including outside
// `~/.claude/plugins/data`. A picker that only scanned that root would show a user every
// directory except the one their session is actually writing to.
test('data dirs: the configured directory is listed even when it is outside the plugin data root', async (t) => {
  const { dataDir, cfg, mod } = await setup(t);
  writeMarker(dataDir, 'cc-alpha-00000001');

  const dirs = mod.listDataDirs({ cfg, env: { HOME: tempDir('mubit-cc-empty-home-') } });
  const paths = dirs.map((d) => d.path);
  assert.ok(paths.includes(dataDir),
    `the resolved cfg.dataDir must always be listed; got ${JSON.stringify(paths)}`);
});

// With no configured directory to prefer, the default is the one written to most recently —
// not the bare `mubit-memory`, which on a machine carrying a marketplace install and an inline
// install is usually the stale one.
test('data dirs: with nothing configured, the most recently written directory is the default', async (t) => {
  const { cfg, mod } = await setup(t);

  const home = tempDir('mubit-cc-home-');
  const root = join(home, '.claude', 'plugins', 'data');
  const old = join(root, 'mubit-memory');
  const fresh = join(root, 'mubit-memory-mubit');
  for (const d of [old, fresh]) mkdirSync(join(d, 'status'), { recursive: true });
  writeMarker(old, 'cc-old-00000001', { updated_at: 1_700_000_000_000 });
  writeMarker(fresh, 'cc-new-00000002', { updated_at: 1_800_000_000_000 });

  const dirs = mod.listDataDirs({ cfg: {}, env: { HOME: home } });
  assert.equal(dirs[0].path, fresh, 'newest lastWrite sorts first');
  assert.equal(dirs[0].isDefault, true);
  assert.equal(dirs[1].isDefault, false, 'exactly one directory is the default');
  assert.equal(dirs.length, 2, `expected both installs; got ${JSON.stringify(dirs.map((d) => d.name))}`);
});

/**
 * But a configured directory beats a recent one.
 *
 * The dashboard is launched from a session, and that session has a data dir. Ranking by
 * `lastWrite` alone means a second Claude Code session two directories over — updating its
 * marker on every prompt — wins the race every time, and the page opens on somebody else's
 * install while looking like it opened on yours.
 */
test('data dirs: the configured directory is the default even when another was written later', async (t) => {
  const { dataDir, cfg, mod } = await setup(t);
  writeMarker(dataDir, 'cc-mine-00000001', { updated_at: 1_000_000_000_000 });

  const home = tempDir('mubit-cc-home-');
  const busy = join(home, '.claude', 'plugins', 'data', 'mubit-memory-busy');
  mkdirSync(join(busy, 'status'), { recursive: true });
  writeMarker(busy, 'cc-theirs-0000001', { updated_at: Date.now() });

  const dirs = mod.listDataDirs({ cfg, env: { HOME: home } });
  assert.equal(dirs[0].path, busy, 'the picker still lists the most recent first');
  assert.equal(dirs.find((d) => d.isDefault).path, dataDir,
    'but the default is the directory this session is actually writing to');
  assert.equal(mod.resolveDirParam('', dirs), dataDir);
});

// `?dir=` is never joined onto a path. It is compared against a list this process built by
// reading the filesystem, so a `../` resolves to the default rather than to a directory.
test('data dirs: an unknown ?dir= value resolves to the default rather than to a path', async (t) => {
  const { dataDir, cfg, mod } = await setup(t);
  writeMarker(dataDir, 'cc-alpha-00000001');
  const dirs = mod.listDataDirs({ cfg, env: { HOME: tempDir('mubit-cc-empty-home-') } });

  for (const attempt of ['../../etc', '/etc/passwd', 'mubit-memory-nope', '']) {
    assert.equal(mod.resolveDirParam(attempt, dirs), dataDir,
      `${JSON.stringify(attempt)} must fall back to the default data dir, never resolve to itself`);
  }
});

// ---------------------------------------------------------------------------
// Run enumeration
// ---------------------------------------------------------------------------

// The marker is the only file guaranteed to exist. A session that recalled and never captured
// has no `runs/<id>/` at all, and one whose turns have aged past six hours has an empty one —
// so enumerating from `runs/` loses exactly the runs a user is most likely to be asking about.
test('runs: a run with a marker and no runs/ directory is still enumerated', async (t) => {
  const { dataDir, mod } = await setup(t);
  writeMarker(dataDir, 'cc-marker-only-0001');

  const runs = mod.runsIn(dataDir);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, 'cc-marker-only-0001');
  assert.equal(runs[0].turnCount, 0);
  assert.equal(runs[0].spoolDepth, 0);
});

// `status/health.json` is the endpoint probe cache, not a run. Listing it would put a run
// called "health" in the run rail on every install.
test('runs: status/health.json is not a run', async (t) => {
  const { dataDir, mod } = await setup(t);
  writeMarker(dataDir, 'cc-real-00000001');
  writeFileSync(join(dataDir, 'status', 'health.json'), JSON.stringify({ ok: true, at: Date.now() }));

  const ids = mod.runsIn(dataDir).map((r) => r.runId);
  assert.deepEqual(ids, ['cc-real-00000001']);
});

// Newest first, by the marker's own `updated_at` — the field every hook restamps.
test('runs: runs sort by marker updated_at, newest first', async (t) => {
  const { dataDir, mod } = await setup(t);
  writeMarker(dataDir, 'cc-oldest-000001', { updated_at: 1000 });
  writeMarker(dataDir, 'cc-newest-000003', { updated_at: 3000 });
  writeMarker(dataDir, 'cc-middle-000002', { updated_at: 2000 });

  assert.deepEqual(mod.runsIn(dataDir).map((r) => r.runId),
    ['cc-newest-000003', 'cc-middle-000002', 'cc-oldest-000001']);
});

test('runs: newestRun names the most recently updated run, and is empty when there are none', async (t) => {
  const { dataDir, mod } = await setup(t);
  assert.equal(mod.newestRun(dataDir), '');
  writeMarker(dataDir, 'cc-only-00000001', { updated_at: 5000 });
  assert.equal(mod.newestRun(dataDir), 'cc-only-00000001');
});

// ---------------------------------------------------------------------------
// Redaction — trap 1
// ---------------------------------------------------------------------------

/**
 * The load-bearing one.
 *
 * `redactText(text, cfg)` skips the scrub entirely when `cfg.redact === false`. A user sets
 * that so their own prompts reach their own instance intact; it says nothing about rendering
 * them into a web page, and the people most likely to have a live key in a prompt are exactly
 * the people who turned redaction off. So the dashboard passes a literal policy.
 *
 * The assertion is deliberately made through `loadConfig` with `MUBIT_CC_REDACT=0`, so it
 * covers the real path a user takes rather than a hand-built object.
 */
test('turns: a prompt containing a mubit key is redacted even when cfg.redact is false', async (t) => {
  const { dataDir, cfg, mod } = await setup(t, { extra: { MUBIT_CC_REDACT: '0' } });
  assert.equal(cfg.redact, false, 'the fixture must actually have redaction disabled, or this proves nothing');

  writeMarker(dataDir, 'cc-leak-00000001');
  writeTurn(dataDir, 'cc-leak-00000001', turnFixture({
    prompt: `deploy with ${SECRETS.mubitKey} then check the logs`,
  }));

  const rows = mod.turnRows(dataDir, 'cc-leak-00000001');
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].promptPreview.includes(SECRETS.mubitKey),
    `the key reached the browser payload: ${rows[0].promptPreview}`);
  assert.match(rows[0].promptPreview, /\[REDACTED/,
    'the scrub must leave its marker, so a reader can see something was removed');
});

// The same guarantee, stated over the module's own constant: a caller cannot get an
// unredacted render by handing it a config, because the policy is frozen and literal.
test('turns: BROWSER_REDACTION is frozen and always has redact true', async (t) => {
  const { mod } = await setup(t);
  assert.equal(mod.BROWSER_REDACTION.redact, true);
  assert.ok(Object.isFrozen(mod.BROWSER_REDACTION));
  try { mod.BROWSER_REDACTION.redact = false; } catch { /* strict mode throws; either is fine */ }
  assert.equal(mod.BROWSER_REDACTION.redact, true, 'the policy must not be reassignable by a caller');
});

// Table over the three shapes `test/redact.test.mjs` distinguishes, asserted here because the
// dashboard is a second consumer of the same scrub and a regression would surface as a leak
// rather than as a failed pattern test.
test('turns: every credential shape in the fixtures is scrubbed on the way to the browser', async (t) => {
  const { mod } = await setup(t);
  for (const [name, secret] of Object.entries(SECRETS)) {
    const { text } = mod.redactForBrowser(`before ${secret} after`, 4096);
    assert.ok(!text.includes(secret), `${name} survived redactForBrowser: ${text}`);
  }
});

// The cap is applied after the scrub, and it is the dashboard's own number rather than the
// user's `maxOutputBytes` — a preview that grew to a configured 64 KiB would be a list view
// that ships a megabyte per poll.
test('turns: the list preview is capped independently of the turn detail', async (t) => {
  const { dataDir, mod } = await setup(t);
  writeMarker(dataDir, 'cc-long-00000001');
  writeTurn(dataDir, 'cc-long-00000001', turnFixture({ prompt: 'x'.repeat(20_000) }));

  const [row] = mod.turnRows(dataDir, 'cc-long-00000001');
  assert.ok(row.promptPreview.length < 2000, 'the preview must be short enough to poll');
  assert.equal(row.promptTruncated, true);

  const detail = mod.turnDetail(dataDir, 'cc-long-00000001', turnFixture().prompt_id);
  assert.ok(detail.prompt.length > row.promptPreview.length,
    'the detail view is what the click is for; it must carry more than the preview');
});

// ---------------------------------------------------------------------------
// The turn record's optional fields
// ---------------------------------------------------------------------------

/**
 * `used_evidence.used` is tri-state and the third state is not `false`.
 *
 * Absent means the signal could not be measured — no reply to compare against, or no distinct
 * vocabulary to look for. `memory-term-echo/v1` is a proxy whose false negatives dominate, so
 * rendering an unmeasurable turn as "unused" would be the page libelling retrieval with the
 * one number it makes look authoritative.
 */
test('turns: used_evidence.used absent is null, not false', async (t) => {
  const { mod } = await setup(t);

  const absent = mod.usedSignal(turnFixture({
    used_evidence: { method: 'memory-term-echo/v1', matched: 0, candidates: 0, reason: 'no_reply' },
  }));
  assert.equal(absent.used, null, 'unmeasurable must not collapse to false');
  assert.equal(absent.measured, false);

  assert.equal(mod.usedSignal(turnFixture({ used_evidence: { used: false, matched: 0, candidates: 4 } })).used, false);
  assert.equal(mod.usedSignal(turnFixture({ used_evidence: { used: true, matched: 2, candidates: 4 } })).used, true);
  assert.equal(mod.usedSignal(turnFixture()).label, '',
    'a turn with no used_evidence at all renders as a blank, never as a zero');
});

// One assertion per row of the table `lib/outcome.mjs` spreads across five keys. `api:<error>`
// comes first because a turn the API killed is closed AND stays pending forever, and reading
// that as plain `pending` sends somebody hunting a flush that was suppressed on purpose.
test('turns: outcomeState collapses the five outcome keys to one word', async (t) => {
  const { mod } = await setup(t);
  const rows = [
    [{ outcome_abandoned: true }, 'dropped'],
    [{ outcome_sent_at: 1700000000000 }, 'sent'],
    [{ api_error: 'auth_failed' }, 'api:auth_failed'],
    [{ outcome_pending: true }, 'pending'],
    [{ ended_at: 1700000000001 }, 'none'],
    [{}, ''],
  ];
  for (const [patch, expected] of rows) {
    assert.equal(mod.outcomeState(turnFixture(patch)), expected,
      `outcomeState(${JSON.stringify(patch)}) must be ${JSON.stringify(expected)}`);
  }
});

// Four hooks write this record in read-modify-write merges with no ordering guarantee, so
// nearly every field is optional. A row built from the minimum must still be a complete row.
test('turns: a turn carrying only the five required fields still produces a full row', async (t) => {
  const { mod } = await setup(t);
  const row = mod.turnRow(turnFixture());
  for (const k of ['promptId', 'sessionId', 'startedAt', 'tok', 'chars', 'ptr', 'rung', 'recalledCount']) {
    assert.ok(k in row, `turnRow must always emit ${k}`);
  }
  assert.equal(row.tok, 0, 'an absent recall block reads as zero cost, not as NaN');
  assert.equal(row.endedAt, 0, 'a turn still open has no ended_at, and that is normal');
});

// There is no per-prompt latency anywhere on disk: `recall.ms` is written to the status marker
// only, so it describes the last prompt rather than each one. The row must not invent one.
test('turns: no per-prompt latency is reported, because none is recorded', async (t) => {
  const { mod } = await setup(t);
  const row = mod.turnRow(turnFixture({ recall: { tokens: 10, chars: 40, ms: 999 } }));
  assert.ok(!('ms' in row), 'a recall.ms on a turn record is not per-prompt latency; do not surface it');
  assert.ok(!('latency' in row));
});

/**
 * The disk poll's inner loop is bounded, and the bound must not change what is returned.
 *
 * A page open for half an hour at one poll a second, over a run with six hours of turns behind
 * it, would otherwise read and parse every file eighteen hundred times. The optimisation ranks
 * by mtime — a stat, not a read — before opening anything, and the risk it carries is that a
 * cheap filter quietly drops a turn the caller asked for. So this asserts the result, not the
 * mechanism: with far more files than the limit, the newest `limit` still come back in order.
 */
test('turns: the newest turns are returned in full even when the directory is far larger than the limit', async (t) => {
  const { dataDir, mod } = await setup(t);
  writeMarker(dataDir, 'cc-many-00000001');

  const base = 1_700_000_000_000;
  for (let i = 0; i < 60; i++) {
    writeTurn(dataDir, 'cc-many-00000001', turnFixture({
      prompt: `prompt number ${i}`,
      prompt_id: `${String(i).padStart(8, '0')}-1111-2222-3333-444444444444`,
      started_at: base + i * 1000,
      ended_at: base + i * 1000 + 500,
      recall: { tokens: i, chars: i * 4, sources: 1 },
    }));
  }

  const rows = mod.turnRows(dataDir, 'cc-many-00000001', { limit: 5 });
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.tok), [59, 58, 57, 56, 55],
    'newest first, and none of the newest may be filtered out by the mtime pre-pass');

  // And the rollup sample, which wants exactly one, still finds the same newest turn.
  const sample = mod.sampleFor(dataDir, 'cc-many-00000001');
  assert.equal(sample.tok, 59);
});

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

// `runDir` applies `safeSegment`, but `readMarker` does *not* — so a run id from a query
// string has to be flattened before it reaches either. This asserts the whole id surface.
test('turns: a ../ prompt id cannot read a file outside the run directory', async (t) => {
  const { dataDir, mod } = await setup(t);
  writeMarker(dataDir, 'cc-escape-000001');
  writeFileSync(join(dataDir, 'credentials.json'), JSON.stringify({ apiKey: SECRETS.mubitKey }));

  for (const attempt of ['../../credentials', '../../../credentials', '..', '.']) {
    const got = mod.turnDetail(dataDir, 'cc-escape-000001', attempt);
    assert.equal(got, null, `turnDetail(${JSON.stringify(attempt)}) must not resolve to a file`);
  }
});

test('turns: a ../ run id cannot read a marker outside the status directory', async (t) => {
  const { dataDir, cfg, mod } = await setup(t);
  const health = mod.localHealth(cfg, dataDir, '../../../../etc/hosts');
  assert.ok(!health.runId.includes('/'), 'a flattened segment can contain no separator');
  assert.ok(!/^\.\./.test(health.runId), 'a leading .. is what climbs out; it must be gone');
  assert.equal(health.spoolDepth, 0, 'a flattened id names a run that does not exist, which is the point');
  assert.equal(health.marker.state, 'unknown', 'and its marker is the default, not a file from elsewhere');
});

// `recall.terms` and `used_evidence.terms` are extracted from the prompt, so they carry
// whatever the prompt carried. Redacting the prompt and not the terms leaks by the side door.
test('turns: the recall and used-evidence term lists are redacted like the prompt', async (t) => {
  const { dataDir, mod } = await setup(t, { extra: { MUBIT_CC_REDACT: '0' } });
  writeMarker(dataDir, 'cc-terms-000001');
  writeTurn(dataDir, 'cc-terms-000001', turnFixture({
    prompt: 'rotate the key',
    recall: { terms: ['rotate', SECRETS.githubToken] },
    used_evidence: { method: 'memory-term-echo/v1', terms: [SECRETS.openaiKey], matched: 1, candidates: 2 },
  }));

  const detail = mod.turnDetail(dataDir, 'cc-terms-000001', turnFixture().prompt_id);
  const rendered = JSON.stringify(detail);
  assert.ok(!rendered.includes(SECRETS.githubToken), 'a recall term leaked a token');
  assert.ok(!rendered.includes(SECRETS.openaiKey), 'a used-evidence term leaked a key');
});

// ---------------------------------------------------------------------------
// Local health — traps 2 and 3
// ---------------------------------------------------------------------------

// `spoolStats` is a `readdir`. `readBatch` unlinks anything it cannot parse, and `commitBatch`
// removes what it sent. A health tile built on either would delete a user's captures as a side
// effect of counting them — and the user would see a number that got smaller every poll.
test('health: reading spool depth leaves every spool file where it was', async (t) => {
  const { dataDir, cfg, mod } = await setup(t);
  writeMarker(dataDir, 'cc-spool-000001');
  writeSpoolItem(dataDir, 'cc-spool-000001', '1700000000000-aaaaaa.json');
  writeSpoolItem(dataDir, 'cc-spool-000001', '1700000000001-bbbbbb.json');
  // A file that will not parse is the exact one `readBatch` deletes.
  writeFileSync(join(dataDir, 'runs', 'cc-spool-000001', 'spool', '1700000000002-cccccc.json'), '{ truncated');

  const before = readdirSync(join(dataDir, 'runs', 'cc-spool-000001', 'spool')).sort();
  const health = mod.localHealth(cfg, dataDir, 'cc-spool-000001');
  const after = readdirSync(join(dataDir, 'runs', 'cc-spool-000001', 'spool')).sort();

  assert.equal(health.spoolDepth, 3, 'the count includes the unparseable file — it is still spooled');
  assert.deepEqual(after, before, 'reading the spool must not remove anything from it');
});

// `readBreaker` is documented pure. `allowRequest` writes when it spends the half-open probe,
// so a dashboard poll built on it would keep re-arming a breaker it was only supposed to
// describe — and the state a user was looking at would be one the page itself created.
test('health: reading breaker state creates no breaker file and changes no existing one', async (t) => {
  const { dataDir, cfg, mod } = await setup(t);
  writeMarker(dataDir, 'cc-breaker-00001');
  const breakerDir = join(dataDir, 'breaker');
  assert.equal(readdirSync(breakerDir).length, 0, 'the fixture starts with no breaker state');

  const health = mod.localHealth(cfg, dataDir, 'cc-breaker-00001');
  assert.equal(readdirSync(breakerDir).length, 0,
    'a health read must not bring a breaker file into existence for an endpoint it never dialled');
  assert.equal(health.breaker.state, 'ready');
  assert.equal(health.breaker.open, false);
  assert.equal(health.breaker.phase, 'closed');
});

// `openedAt > 0` alone does not mean open: once the cooldown has elapsed the breaker is
// half-open and the next call goes through. A tile that read the field alone would report a
// permanently broken connection on an instance that recovered an hour ago.
test('health: an openedAt older than the cooldown reads as half-open, not open', async (t) => {
  const { dataDir, cfg, mod } = await setup(t, { extra: { MUBIT_CC_BREAKER_COOLDOWN_MS: '1000' } });
  writeMarker(dataDir, 'cc-cooled-000001');

  const { endpointHash } = await lib('breaker.mjs');
  const p = join(dataDir, 'breaker', `${endpointHash(cfg)}.json`);
  writeFileSync(p, JSON.stringify({
    state: 'unreachable', failures: [], openedAt: Date.now() - 60_000, probeAt: 0, lastOkAt: 0,
  }));

  const health = mod.localHealth(cfg, dataDir, 'cc-cooled-000001');
  assert.equal(health.breaker.phase, 'half-open');
  assert.equal(health.breaker.open, false, 'the next call would go through, so the tile must not say open');
});

// `http.health()` writes `status/health.json` as its 30-second verdict cache. A read-only tile
// must read that file, not refresh it — otherwise the dashboard is dialling on a timer nobody
// asked for and the cache is always its own.
test('health: the endpoint probe cache is read, never rewritten', async (t) => {
  const { dataDir, cfg, mod } = await setup(t);
  writeMarker(dataDir, 'cc-cache-000001');
  const p = join(dataDir, 'status', 'health.json');
  writeFileSync(p, JSON.stringify({ at: 12345, endpoint: 'https://example.invalid', ok: true, state: 'ready' }));
  const before = statSync(p).mtimeMs;

  const health = mod.localHealth(cfg, dataDir, 'cc-cache-000001');
  assert.equal(health.healthCache.at, 12345, 'the stale cache is reported as it is, stale timestamp included');
  assert.equal(statSync(p).mtimeMs, before, 'the health cache must not be restamped by a read');
});

test('health: rejected spool items are counted separately from pending ones', async (t) => {
  const { dataDir, cfg, mod } = await setup(t);
  writeMarker(dataDir, 'cc-reject-000001');
  writeSpoolItem(dataDir, 'cc-reject-000001', '1700000000000-aaaaaa.json');
  const rej = join(dataDir, 'runs', 'cc-reject-000001', 'spool', 'rejected');
  mkdirSync(rej, { recursive: true });
  writeFileSync(join(rej, 'bad.json'), '{}');

  const health = mod.localHealth(cfg, dataDir, 'cc-reject-000001');
  assert.equal(health.spoolDepth, 1, 'spool/rejected/ is a subdirectory and is not pending work');
  assert.equal(health.rejectedCount, 1);
});

// ---------------------------------------------------------------------------
// The rollup — the one thing the dashboard writes
// ---------------------------------------------------------------------------

// Turn files are pruned at six hours, so the raw series cannot carry a trend line and the
// dashboard has to keep its own. Everything it writes is confined to one subdirectory it owns.
test('rollup: the only path written is under <dataDir>/dashboard/', async (t) => {
  const { dataDir, mod } = await setup(t);
  writeMarker(dataDir, 'cc-roll-00000001');
  writeTurn(dataDir, 'cc-roll-00000001', turnFixture({ recall: { tokens: 120, chars: 480, sources: 3, pointers: 1, rung: 1 } }));

  const before = snapshot(dataDir);
  assert.equal(mod.appendRollup(dataDir, 'cc-roll-00000001', mod.sampleFor(dataDir, 'cc-roll-00000001')), true);
  const after = snapshot(dataDir);

  const added = after.filter((p) => !before.includes(p));
  assert.deepEqual(added, [join('dashboard', 'rollup-cc-roll-00000001.jsonl')],
    `the rollup must be the only new path; got ${JSON.stringify(added)}`);
});

test('rollup: a ../ run id cannot write outside the dashboard directory', async (t) => {
  const { dataDir, mod } = await setup(t);
  const p = mod.rollupPath(dataDir, '../../../../tmp/escape');
  assert.equal(dirname(p), join(dataDir, 'dashboard'),
    `a rollup path must stay under the dashboard directory; got ${p}`);
  assert.ok(!basename(p).includes('/'),
    'the separators are flattened into the filename rather than resolved as a path');
});

// The disk poll runs about once a second and turn files change only when a prompt is
// submitted. Without the dedup a quiet hour writes three thousand identical rows and the
// trend line becomes a flat run of one prompt repeated.
test('rollup: an unchanged sample is not appended twice', async (t) => {
  const { dataDir, mod } = await setup(t);
  writeMarker(dataDir, 'cc-dedup-000001');
  writeTurn(dataDir, 'cc-dedup-000001', turnFixture({ recall: { tokens: 100, chars: 400, sources: 2 } }));

  assert.equal(mod.appendRollup(dataDir, 'cc-dedup-000001', mod.sampleFor(dataDir, 'cc-dedup-000001')), true);
  assert.equal(mod.appendRollup(dataDir, 'cc-dedup-000001', mod.sampleFor(dataDir, 'cc-dedup-000001')), false,
    'the same prompt with the same numbers is one row, however often it is polled');
  assert.equal(mod.readRollup(dataDir, 'cc-dedup-000001').length, 1);

  writeTurn(dataDir, 'cc-dedup-000001', turnFixture({
    prompt_id: '99999999-8888-7777-6666-555555555555',
    started_at: 1_700_000_100_000,
    recall: { tokens: 220, chars: 880, sources: 5 },
  }));
  assert.equal(mod.appendRollup(dataDir, 'cc-dedup-000001', mod.sampleFor(dataDir, 'cc-dedup-000001')), true,
    'a new prompt is a new row');
  assert.equal(mod.readRollup(dataDir, 'cc-dedup-000001').length, 2);
});

// This file is outside `lib/state.mjs`'s TTL table — nothing prunes it but the dashboard — so
// an uncapped append is a file that grows for as long as the plugin is installed.
test('rollup: the file is capped and the newest rows are the ones kept', async (t) => {
  const { dataDir, mod } = await setup(t);
  const p = mod.rollupPath(dataDir, 'cc-cap-000000001');
  mkdirSync(join(dataDir, 'dashboard'), { recursive: true });

  const rows = [];
  for (let i = 0; i < mod.ROLLUP_MAX_ROWS + 10; i++) {
    rows.push(JSON.stringify({ at: 1_700_000_000_000 + i, run: 'cc-cap-000000001', prompt: `p${i}`, tok: i }));
  }
  writeFileSync(p, `${rows.join('\n')}\n`);

  mod.appendRollup(dataDir, 'cc-cap-000000001', {
    at: Date.now(), run: 'cc-cap-000000001', prompt: 'last', tok: 1, chars: 1, ptr: 0, rung: 1, sources: 1,
  });

  const kept = mod.readRollup(dataDir, 'cc-cap-000000001');
  assert.ok(kept.length <= mod.ROLLUP_MAX_ROWS, `expected <= ${mod.ROLLUP_MAX_ROWS} rows, got ${kept.length}`);
  assert.equal(kept[kept.length - 1].prompt, 'last', 'the newest row survives the trim');
});

// A row torn by a crash mid-append is normal on this file and must cost exactly itself.
test('rollup: a truncated line is skipped and the rest of the series still reads', async (t) => {
  const { dataDir, mod } = await setup(t);
  mkdirSync(join(dataDir, 'dashboard'), { recursive: true });
  writeFileSync(mod.rollupPath(dataDir, 'cc-torn-000000001'),
    `${JSON.stringify({ at: 1, tok: 10 })}\n{"at":2,"tok":\n${JSON.stringify({ at: 3, tok: 30 })}\n`);

  const rows = mod.readRollup(dataDir, 'cc-torn-000000001');
  assert.deepEqual(rows.map((r) => r.tok), [10, 30]);
});

test('rollup: since drops rows older than the window asked for', async (t) => {
  const { dataDir, mod } = await setup(t);
  mkdirSync(join(dataDir, 'dashboard'), { recursive: true });
  writeFileSync(mod.rollupPath(dataDir, 'cc-since-00000001'),
    [{ at: 100, tok: 1 }, { at: 200, tok: 2 }, { at: 300, tok: 3 }]
      .map((r) => JSON.stringify(r)).join('\n') + '\n');

  assert.deepEqual(mod.readRollup(dataDir, 'cc-since-00000001', 200).map((r) => r.at), [200, 300]);
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

// The rollup starts empty: it accrues from the first launch and cannot reconstruct the past.
// The first session's Analytics tab is sparse, and that has to be a valid state rather than a
// division by zero.
test('analytics: an empty rollup yields zeros rather than NaN', async (t) => {
  const { dataDir, mod } = await setup(t);
  const a = mod.analytics(dataDir, 'cc-empty-000001');
  assert.equal(a.points, 0);
  assert.equal(a.averages.tok, 0);
  assert.equal(a.pointerRatio, 0);
  assert.equal(a.latest, null);
  assert.deepEqual(a.series, []);
});

// The pointer ratio is what makes a falling token count attributable: a block that shrank
// because the seen-set worked reads exactly like one that shrank because recall found half as
// much, and only this number tells them apart.
test('analytics: the pointer ratio is repeats over injected memories', async (t) => {
  const { dataDir, mod } = await setup(t);
  mkdirSync(join(dataDir, 'dashboard'), { recursive: true });
  writeFileSync(mod.rollupPath(dataDir, 'cc-ratio-00000001'),
    [
      { at: 1, tok: 100, chars: 400, ptr: 1, rung: 1, sources: 4 },
      { at: 2, tok: 60, chars: 240, ptr: 3, rung: 1, sources: 4 },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');

  const a = mod.analytics(dataDir, 'cc-ratio-00000001');
  assert.equal(a.points, 2);
  assert.equal(a.totals.sources, 8);
  assert.equal(a.pointerRatio, 0.5, '4 pointers over 8 injected memories');
  assert.equal(a.averages.tok, 80);
  assert.equal(a.averages.sources, 4, 'memories per prompt is the number the seen-set moves');
});

/** Every path under a data dir, relative, sorted — for "what did that write?" assertions. */
function snapshot(root, prefix = '') {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(join(root, prefix))) {
    const rel = prefix ? join(prefix, name) : name;
    const full = join(root, rel);
    if (existsSync(full) && statSync(full).isDirectory()) out.push(...snapshot(root, rel));
    else out.push(rel);
  }
  return out.sort();
}

// A module that reads a user's memory must not be importable into a hook budget by accident:
// it is imported by `bin/dashboard.src.mjs` and by nothing else, and it reaches for no socket.
test('the module has no network surface at all', async () => {
  const src = readFileSync(new URL('../lib/dashboard-data.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['fetch(', 'node:http', 'node:net', 'node:https']) {
    assert.ok(!src.includes(forbidden),
      `lib/dashboard-data.mjs must stay offline; found ${forbidden}`);
  }
});
