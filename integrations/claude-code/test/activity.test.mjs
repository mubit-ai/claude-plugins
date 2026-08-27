// @ts-check
/**
 * `lib/activity.mjs` — the audit question, and the two places it can be answered dishonestly.
 *
 * This file is written around one distinction, because everything else here follows from it.
 *
 * **A listing is a claim the client makes. An export is a record the server holds.** When a
 * caller asks for non-derived entries and we print the answer under an `--exclude-derived`
 * heading, we are asserting something about the bytes on screen — not about a field we put in
 * a request. If the instance ignored the flag and we relayed the result anyway, we would have
 * manufactured a false compliance artefact, which is the exact failure this module exists to
 * remove. So the listing is re-filtered and re-projected here, and the corrections are
 * reported: "the server did not honour this" is itself audit-relevant.
 *
 * The export is the mirror image. `/v2/control/activity/export` takes neither
 * `exclude_derived` nor `projection`, so there is nothing to distrust, and `content` is
 * written out byte for byte. A compliance artefact the client reshaped is not a record of what
 * the server holds. The asymmetry is forced by the wire shape, and the tests below pin both
 * halves of it.
 *
 * The other load-bearing property is that **asking a question about your own data must not
 * take recall down**. `lib/http.mjs` records an abort as `not_responding` unless the caller's
 * deadline was tighter than the 4000 ms default — and both deadlines here are looser, so
 * without `{record: false}` five slow exports in five minutes would open the breaker and stop
 * recall and the capture drain. That is asserted on the absence of a breaker file rather than
 * on the presence of an option, because an option that is passed and silently dropped looks
 * identical at the call site.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { lib, baseEnv, fakeMubit, makeDataDir } from './helpers/harness.mjs';

const RUN = 'cc-here-00000001';
const EXPORT_ROUTE = 'POST /v2/control/activity/export';
const LIST_ROUTE = 'POST /v2/control/activity';

/**
 * A fake instance, a config pointed at it, and the module under test.
 *
 * @param {import('node:test').TestContext} t
 * @param {{routes?: Record<string, any>, extra?: Record<string, string>}} [o]
 */
async function setup(t, o = {}) {
  const dataDir = makeDataDir();
  const server = await fakeMubit(o.routes ?? {});
  t.after(() => server.close());
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(baseEnv({ dataDir, endpoint: server.url, extra: o.extra }));
  const mod = await lib('activity.mjs');
  return { dataDir, server, cfg, mod };
}

/**
 * One `ActivityEntry`, as the server actually serialises it — all sixteen fields.
 *
 * `meta` is a convenience over `metadata_json`, and it serialises: the proto declares that
 * field a `string`, so a fixture handing over a bare object would be testing a shape the wire
 * cannot produce. The cases where the encoding *is* the point — double-encoded, empty,
 * unparseable — pass `metadata_json` directly, which still wins.
 */
function activityEntry(over = {}) {
  const { meta, ...rest } = over;
  return {
    id: 'a3c1f0de-0000-4000-8000-000000000001',
    run_id: RUN,
    user_id: '',
    actor_user_id: '',
    agent_id: '',
    entry_type: 'trace',
    content: 'ran the migration',
    source: 'claude-code',
    importance: 'medium',
    created_at: '2026-08-19T15:03:18Z',
    metadata_json: meta === undefined ? '{}' : JSON.stringify(meta),
    reference_id: 'ref_1',
    referenceable: true,
    upsert_key: '',
    retrieval_mode: '',
    origin_entry_type: 'trace',
    ...rest,
  };
}

/**
 * A lesson as the *activity* feed serialises one: `entry_type` is `lesson` and every field the
 * lessons route would have returned is inside the metadata instead. `id` and `reference_id` are
 * the same string because `lessonId()` prefers the second, and a fixture where they disagree
 * would pin the preference rather than the census.
 */
function lessonRow(id, over = {}) {
  return activityEntry({ id, reference_id: id, entry_type: 'lesson', ...over });
}

/** A page of the listing route. */
function listPage(entries, next = '', total = entries.length) {
  return { json: { entries, next_page_token: next, total_visible: total } };
}

/** The export route's reply. `format` and `entry_count` are the server's, not ours. */
function exportBody(content, over = {}) {
  return { json: { format: 'jsonl', content, entry_count: content ? content.split('\n').length : 0, ...over } };
}

// ===========================================================================
// The breaker must not move
// ===========================================================================

/**
 * The load-bearing one.
 *
 * `lib/http.mjs:557` tags an abort `abortedEarly` — and `settle()` at :592 then declines to
 * record it — *only* when the caller's deadline is tighter than the 4000 ms default. Both
 * deadlines in this module are looser, so a slow export is a full-budget abort and records
 * `not_responding` like any hook would. Five of those inside the breaker's window opens the
 * circuit, which stops recall and suppresses the capture drain — because the user asked a
 * question about their own data.
 */
test('audit: eight failed exports leave the breaker exactly as they found it', async (t) => {
  const { dataDir, cfg, mod } = await setup(t, {
    routes: {
      [EXPORT_ROUTE]: { status: 500, json: { error: 'boom' } },
      [LIST_ROUTE]: { status: 500, json: { error: 'boom' } },
    },
  });

  for (let i = 0; i < 8; i++) {
    await mod.exportActivity(cfg, { run: RUN });
    await mod.listActivity(cfg, { run: RUN });
  }

  assert.deepEqual(readdirSync(join(dataDir, 'breaker')), [],
    'sixteen failed audit calls opened the circuit the hooks depend on; asking what memory '
    + 'holds must never be able to stop memory working');
});

/**
 * The deadline, stated rather than inherited.
 *
 * 4000 ms is a hook budget and belongs to a prompt's critical path. 20 s is the dashboard's,
 * and it is sized for a page render. An export is a scan of every entry in a run, serialised
 * into one string, with no `limit` on the route to bound it — so it gets its own number, and
 * that number is longer than both.
 */
test('audit: EXPORT_OPTS is frozen, records nothing, and outlasts both other budgets', async (t) => {
  const { mod } = await setup(t);
  const dash = await lib('dashboard-api.mjs');

  assert.ok(Object.isFrozen(mod.EXPORT_OPTS), 'a mutable options object is a shared global');
  assert.equal(mod.EXPORT_OPTS.record, false);
  assert.ok(mod.EXPORT_OPTS.timeoutMs > 4000,
    `the hook budget is 4000 ms; an export got ${mod.EXPORT_OPTS.timeoutMs}`);
  assert.ok(mod.EXPORT_OPTS.timeoutMs > dash.TIMEOUT_MS,
    `an export is a bigger job than a dashboard read (${dash.TIMEOUT_MS} ms); got ${mod.EXPORT_OPTS.timeoutMs}`);
});

// ===========================================================================
// The export route
// ===========================================================================

// `ROUTES` in `lib/http.mjs` is the frozen table of routes with a typed wrapper, a `capFor()`
// entry and a hook caller. This one has none of those, so it lives here — the precedent
// `lib/dashboard-api.mjs` set with `EXTRA_ROUTES` and `test/dashboard-api.test.mjs:573` pins.
// Naming the path in a test is what stops a typo becoming a 404 that reads as "no activity".
test('export: the route is dialled at exactly one path, and nothing else is', async (t) => {
  const { server, cfg, mod } = await setup(t, {
    routes: { [EXPORT_ROUTE]: exportBody('{"id":"a"}') },
  });

  const r = await mod.exportActivity(cfg, { run: RUN });
  assert.equal(r.ok, true, `the export failed: ${JSON.stringify(r)}`);

  server.assertCalled('POST', '/v2/control/activity/export', 1);
  assert.equal(server.requests.filter((q) => q.path.startsWith('/v2/')).length, 1,
    `an export called something else as well: ${server.summary()}`);
  assert.equal(mod.ACTIVITY_ROUTES.export, '/v2/control/activity/export');
  assert.ok(Object.isFrozen(mod.ACTIVITY_ROUTES));
});

/**
 * The route takes no `limit`, and `lib/http.mjs` caps *requests*, not responses: `dial()`
 * reads the whole body and parses it in one allocation. An empty `run_id` means "every run
 * this key can see", so the run scope is the only bound the response has. It is therefore
 * required, and a caller who omits it gets a refusal instead of an unbounded read.
 */
test('export: a missing run id dials nothing at all', async (t) => {
  const { server, cfg, mod } = await setup(t, {
    routes: { [EXPORT_ROUTE]: exportBody('{"id":"a"}') },
  });

  for (const params of [{}, { run: '' }, { run: '   ' }, { run: null }, { run: 42 }]) {
    const r = await mod.exportActivity(cfg, /** @type {any} */ (params));
    assert.equal(r.ok, false, `${JSON.stringify(params)} must refuse`);
    assert.equal(r.code, 'bad_request');
  }
  server.assertNotCalled('POST', '/v2/control/activity/export');
});

/**
 * `ExportActivityRequest` has seven fields — run_id, user_id, agent_id, entry_types,
 * created_after, created_before, sort — and none of them is `exclude_derived`, `projection`,
 * `limit` or `page_token`. Sending one is not an error: the handler deserialises with serde's
 * default, which drops unknown keys silently. That is precisely why it must not be sent. A
 * request carrying `exclude_derived` that nothing reads is a client believing it filtered.
 */
test('export: the body carries format and omits every field the route does not take', async (t) => {
  const { server, cfg, mod } = await setup(t, {
    routes: { [EXPORT_ROUTE]: exportBody('{"id":"a"}') },
  });

  await mod.exportActivity(cfg, {
    run: RUN,
    entryTypes: ['lesson'],
    createdAfter: '2026-01-01T00:00:00Z',
    createdBefore: '2026-12-31T23:59:59Z',
    userId: 'u1',
    agentId: 'a1',
    // Offered by the caller and dropped on the floor, because the route cannot honour them.
    excludeDerived: true,
    projection: 'compact',
    limit: 250,
    pageToken: '100',
  });

  const body = server.lastCall('POST', '/v2/control/activity/export')?.body;
  assert.equal(body.format, 'jsonl', 'the client states the format it will accept');
  for (const absent of ['exclude_derived', 'projection', 'limit', 'page_token']) {
    assert.ok(!(absent in body),
      `the export body carries \`${absent}\`, which this route ignores. A field that is sent `
      + 'and dropped is a filter the caller believes ran. Body: ' + JSON.stringify(body));
  }
  assert.equal(body.run_id, RUN);
  assert.deepEqual(body.entry_types, ['lesson']);
  assert.equal(body.created_after, '2026-01-01T00:00:00Z');
  assert.equal(body.created_before, '2026-12-31T23:59:59Z');
  assert.equal(body.user_id, 'u1');
  assert.equal(body.agent_id, 'a1');
});

/**
 * The whole point of the export. A compliance artefact the client reshaped is not a record of
 * what the server holds, so `content` crosses this module untouched — no re-parse, no
 * re-serialise, no trailing newline added, no CRLF normalisation.
 */
test('export: content comes back byte for byte', async (t) => {
  // Deliberately awkward: a trailing space, a CRLF, a lone \n at the end, and a unicode
  // codepoint outside the BMP. Any of them would survive a re-serialise; together they do not.
  const content = '{"id":"a","c":"x "}\r\n{"id":"b","c":"\u{1F5C4}"}\n';
  const { cfg, mod } = await setup(t, { routes: { [EXPORT_ROUTE]: exportBody(content) } });

  const r = await mod.exportActivity(cfg, { run: RUN });
  assert.equal(r.ok, true);
  assert.equal(r.data.content, content, 'the export was reshaped in transit');
  assert.equal(r.data.bytes, Buffer.byteLength(content, 'utf8'));
  assert.equal(r.data.format, 'jsonl');
});

/**
 * A zero-byte export is the one answer that must never be reported as success.
 *
 * "Your instance holds nothing about this run" and "the export route answered with a field we
 * could not read" are the same empty file on disk and completely different facts. Writing the
 * first when the second happened is the failure this whole ticket exists to prevent, so all
 * three shapes of nothing are failures.
 */
test('export: an empty, absent or non-string content is a failure, never a zero-byte success', async (t) => {
  const rows = [
    ['', 'an empty string'],
    [undefined, 'an absent field'],
    [null, 'a null'],
    [42, 'a number'],
    [{ id: 'a' }, 'an object'],
    [['{"id":"a"}'], 'an array of lines'],
  ];

  for (const [content, why] of rows) {
    const { cfg, mod } = await setup(t, {
      routes: { [EXPORT_ROUTE]: { json: { format: 'jsonl', content, entry_count: 0 } } },
    });
    const r = await mod.exportActivity(cfg, { run: RUN });
    assert.equal(r.ok, false, `${why} must be a failure, not an empty export`);
    assert.match(r.message, /content/i, `the message has to name what was wrong: ${r.message}`);
  }
});

// The instance decides the format; we report what it said rather than what we asked for. An
// instance that answers `csv` has not produced the JSONL a caller is about to parse, and the
// caller needs to be able to see that rather than infer it from a parse failure.
test('export: the format the server reports is what is surfaced, not the one requested', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: { [EXPORT_ROUTE]: exportBody('id,content\n1,x', { format: 'csv' }) },
  });
  const r = await mod.exportActivity(cfg, { run: RUN });
  assert.equal(r.ok, true);
  assert.equal(r.data.format, 'csv');
  assert.equal(r.data.requestedFormat, 'jsonl');
});

// The dashboard's rule, inherited: an upstream error carries a snippet of the response that
// produced it, and a proxy error page can quote a request header.
test('export: an upstream error never carries the API key back to the caller', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: {
      [EXPORT_ROUTE]: (req) => ({
        status: 400,
        json: { error: `bad request with header ${req.headers.authorization}` },
      }),
    },
  });

  const r = await mod.exportActivity(cfg, { run: RUN });
  assert.equal(r.ok, false);
  assert.ok(cfg.apiKey && cfg.apiKey.length > 10, 'the fixture must have a key, or this proves nothing');
  assert.ok(!r.message.includes(cfg.apiKey), `the key reached the caller: ${r.message}`);
  assert.match(r.message, /REDACTED/, 'and the removal is visible rather than silent');
});

/**
 * No re-redaction of the content itself.
 *
 * The dashboard scrubs prompt text because rendering into a web page is a different consent
 * from sending it to your own instance. Here a person is asking their own instance, in their
 * own terminal, what it holds — and scrubbing that would defeat the compliance question
 * exactly. Errors are still scrubbed; the record is not.
 */
test('export: the content is not re-redacted on the way out', async (t) => {
  const content = '{"id":"a","content":"AKIAIOSFODNN7EXAMPLE and you@example.com"}';
  const { cfg, mod } = await setup(t, { routes: { [EXPORT_ROUTE]: exportBody(content) } });

  const r = await mod.exportActivity(cfg, { run: RUN });
  assert.equal(r.ok, true);
  assert.equal(r.data.content, content,
    'the user is asking their own instance what it holds about them; redacting the answer '
    + 'makes the answer useless for the only question it was asked');
});

// ===========================================================================
// Derived detection
// ===========================================================================

/**
 * What the server means by "derived", and the four spellings past it.
 *
 * `list_activity`'s own `exclude_derived` drops an entry when `metadata_json` parses to an
 * object carrying `promotion: true` or `derived: true` — as JSON booleans, via `as_bool()`.
 * That is a narrower test than the data warrants: recurrence promotion writes
 * `auto_promoted: true`, the A/B path writes `promoted`, a stringified boolean fails
 * `as_bool()` outright, and `metadata_json` reaches us double-encoded often enough to matter.
 *
 * Erring wide is the only safe direction. Over-filtering shows a caller fewer entries than
 * exist, which they can see; under-filtering prints a promoted fact under a heading that says
 * there are none, which they cannot.
 */
test('derived: every spelling a promoted entry arrives in is detected', async (t) => {
  const { mod } = await setup(t);

  const derived = [
    ['{"promotion":true,"promotion_confidence":0.8}', 'the promotion pipeline\'s own metadata'],
    ['{"derived":true}', 'the second half of the server\'s own filter'],
    ['{"promoted":true}', 'what the shadow-A/B promotion path writes'],
    ['{"auto_promoted":true}', 'recurrence promotion — which the server\'s exclude_derived misses'],
    ['{"derived":"true"}', 'a stringified boolean, which as_bool() rejects server-side'],
    ['"{\\"derived\\":true}"', 'metadata_json double-encoded: a JSON string holding JSON'],
  ];
  for (const [metadata_json, why] of derived) {
    assert.equal(mod.isDerived(activityEntry({ metadata_json })), true,
      `${why}: ${metadata_json}`);
  }

  // The seventh spelling is not a string at all: the dashboard has already parsed
  // `metadata_json` before it reaches a shared helper, and an object must not fall through.
  assert.equal(mod.isDerived(activityEntry({ metadata_json: { promotion: true } })), true,
    'metadata_json already parsed by the caller');

  // And the flag can arrive outside the metadata entirely.
  assert.equal(mod.isDerived(activityEntry({ derived: true })), true, 'a top-level flag');
});

test('derived: nothing that merely looks promoted is dropped', async (t) => {
  const { mod } = await setup(t);

  const kept = [
    ['{}', 'no metadata'],
    ['', 'an empty metadata string'],
    ['   ', 'whitespace'],
    ['not json at all', 'metadata that will not parse'],
    ['[1,2,3]', 'metadata that parses to an array'],
    ['null', 'metadata that parses to null'],
    ['{"promotion":false}', 'the flag, explicitly false'],
    ['{"derived":"no"}', 'a string that is not a truth value'],
    ['{"promotion_confidence":0.9,"promotion_tier":"stable_fact"}',
      'promotion-adjacent keys without the flag itself — an entry the promoter looked at and did not promote'],
  ];
  for (const [metadata_json, why] of kept) {
    assert.equal(mod.isDerived(activityEntry({ metadata_json })), false, `${why}: ${metadata_json}`);
  }

  // Totality: this runs over every entry of an export-sized listing and cannot be the thing
  // that throws.
  for (const junk of [null, undefined, 42, 'x', [], () => {}]) {
    assert.equal(mod.isDerived(/** @type {any} */ (junk)), false, `isDerived(${String(junk)})`);
  }
});

// ===========================================================================
// The compact projection
// ===========================================================================

/**
 * Five keys, and the reason there are five.
 *
 * The server's `compact` keeps all sixteen fields and only truncates content and rewrites
 * metadata — which is the right trade for a page render and the wrong one for reading a
 * listing in a terminal. These five answer the audit question in full: what is it, when did it
 * arrive, which run wrote it, what does it say, and how do I address it. Everything else is
 * what `--full` and the export are for.
 */
test('compact: the projection is exactly five keys, in a fixed order', async (t) => {
  const { mod } = await setup(t);

  assert.deepEqual([...mod.COMPACT_KEYS], ['id', 'created_at', 'entry_type', 'run_id', 'content']);
  assert.ok(Object.isFrozen(mod.COMPACT_KEYS));

  const out = mod.compactEntry(activityEntry({ content: 'short' }));
  assert.deepEqual(Object.keys(out), [...mod.COMPACT_KEYS],
    'the key order is what a terminal reader scans down; it is part of the shape');
  assert.equal(out.content, 'short');
  assert.equal(out.run_id, RUN);

  // Totality again, and a missing field is an empty string rather than an absent key: a
  // JSONL stream whose rows have different keys is not a table.
  assert.deepEqual(mod.compactEntry(/** @type {any} */ (null)),
    { id: '', created_at: '', entry_type: '', run_id: '', content: '' });
});

// The server truncates to 200 characters and appends `...`, so a compacted row is at most 203.
// Matching that exactly means a client truncation and a server one are the same bytes — the
// difference is reported as a flag rather than smuggled into the content.
test('compact: content is truncated at the same boundary the server uses', async (t) => {
  const { mod } = await setup(t);
  const long = 'x'.repeat(500);
  const out = mod.compactEntry(activityEntry({ content: long }));
  assert.equal(out.content.length, mod.COMPACT_CONTENT_CHARS + 3);
  assert.equal(out.content, `${'x'.repeat(200)}...`);
  assert.equal(mod.COMPACT_CONTENT_CHARS, 200);
});

// ===========================================================================
// The two corrections
// ===========================================================================

/**
 * "I asked for non-derived entries" is a claim about a request field. "These are the
 * non-derived entries" is a claim about bytes. This test is the difference.
 */
test('listing: an ignored exclude_derived is corrected here, and reported', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: {
      [LIST_ROUTE]: listPage([
        activityEntry({ id: 'plain' }),
        activityEntry({ id: 'promoted', metadata_json: '{"promotion":true}' }),
        activityEntry({ id: 'recurrence', metadata_json: '{"auto_promoted":true}' }),
      ], '', 3),
    },
  });

  const r = await mod.listActivity(cfg, { run: RUN, excludeDerived: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.entries.map((e) => e.id), ['plain'],
    'the instance returned promoted entries under a request that excluded them');
  assert.equal(r.data.excludeDerivedFallbackUsed, true,
    '"the server did not honour this" is itself audit-relevant and must reach the caller');
  assert.equal(r.data.droppedDerived, 2);

  // And `total_visible` is the server's count, over the server's filtering. It over-counts by
  // exactly what we dropped, which a caller can only reconcile if both numbers are present.
  assert.equal(r.data.totalVisible, 3);
});

test('listing: a server that honours exclude_derived reports no fallback', async (t) => {
  const { server, cfg, mod } = await setup(t, {
    routes: { [LIST_ROUTE]: listPage([activityEntry({ id: 'plain' })], '', 1) },
  });

  const r = await mod.listActivity(cfg, { run: RUN, excludeDerived: true });
  assert.equal(r.ok, true);
  assert.equal(r.data.excludeDerivedFallbackUsed, false);
  assert.equal(r.data.droppedDerived, 0);
  assert.equal(server.lastCall('POST', '/v2/control/activity')?.body.exclude_derived, true,
    'the flag is still sent — the client filter is a check on the server, not a replacement');
});

// The mirror of the above for `projection`. Detection is structural rather than a guess: the
// server's compact output is at most 203 characters, so anything longer is proof the flag did
// not take effect.
test('listing: an ignored projection is corrected here, and reported', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: { [LIST_ROUTE]: listPage([activityEntry({ content: 'y'.repeat(4000) })], '', 1) },
  });

  const r = await mod.listActivity(cfg, { run: RUN });
  assert.equal(r.ok, true);
  assert.equal(r.data.entries[0].content.length, 203);
  assert.equal(r.data.projectionFallbackUsed, true);
});

test('listing: a server that honours projection reports no fallback', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: { [LIST_ROUTE]: listPage([activityEntry({ content: `${'y'.repeat(200)}...` })], '', 1) },
  });
  const r = await mod.listActivity(cfg, { run: RUN });
  assert.equal(r.ok, true);
  assert.equal(r.data.projectionFallbackUsed, false);
});

// `--full` is the escape hatch for someone who needs the other eleven fields, and it must not
// quietly get the five-key shape.
test('listing: the full projection passes entries through unreshaped', async (t) => {
  const { server, cfg, mod } = await setup(t, {
    routes: { [LIST_ROUTE]: listPage([activityEntry({ content: 'z'.repeat(1000) })], '', 1) },
  });

  const r = await mod.listActivity(cfg, { run: RUN, projection: 'full' });
  assert.equal(r.ok, true);
  assert.equal(r.data.entries[0].content.length, 1000, 'full means full');
  assert.ok('reference_id' in r.data.entries[0], 'and every field survives');
  assert.equal(r.data.projectionFallbackUsed, false, 'nothing was asked for, so nothing was ignored');
  assert.equal(server.lastCall('POST', '/v2/control/activity')?.body.projection, 'full');
});

// `listActivity` inherits the export's scope rule, for the same reason and one more: an
// instance-wide listing is a different question from "what does this run hold", and it should
// be asked out loud.
test('listing: a missing run id dials nothing unless allRuns was asked for', async (t) => {
  const { server, cfg, mod } = await setup(t, { routes: { [LIST_ROUTE]: listPage([]) } });

  const r = await mod.listActivity(cfg, {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_request');
  server.assertNotCalled('POST', '/v2/control/activity');

  const all = await mod.listActivity(cfg, { allRuns: true });
  assert.equal(all.ok, true);
  const body = server.lastCall('POST', '/v2/control/activity')?.body;
  assert.ok(!('run_id' in body), `allRuns means an absent run_id; body was ${JSON.stringify(body)}`);
});

// ===========================================================================
// The five new request fields
// ===========================================================================

// Each of these exists on `ListActivityRequest` and none of them was reachable from this
// plugin before. They are the difference between "show me activity" and the questions an audit
// actually asks: since when, until when, by whom, from which agent, and without the entries
// the instance derived for itself.
test('listing: the new filter fields reach the wire when set', async (t) => {
  const { server, cfg, mod } = await setup(t, { routes: { [LIST_ROUTE]: listPage([]) } });

  await mod.listActivity(cfg, {
    run: RUN,
    entryTypes: ['lesson', 'trace'],
    createdAfter: '2026-01-01T00:00:00Z',
    createdBefore: '2026-06-30T00:00:00Z',
    userId: 'u-1',
    agentId: 'agent-1',
    excludeDerived: true,
  });

  const body = server.lastCall('POST', '/v2/control/activity')?.body;
  assert.deepEqual(body.entry_types, ['lesson', 'trace']);
  assert.equal(body.created_after, '2026-01-01T00:00:00Z');
  assert.equal(body.created_before, '2026-06-30T00:00:00Z');
  assert.equal(body.user_id, 'u-1');
  assert.equal(body.agent_id, 'agent-1');
  assert.equal(body.exclude_derived, true);
});

/**
 * The additive half, which is the whole risk of touching `fetchActivity`.
 *
 * Every one of the five is emitted only when it is set. An unconditional `user_id: ''` would
 * be read server-side by `effective_logical_user_scope` and become a filter nobody asked for —
 * the same shape as the `user_id` trap on the ingest side, where filling the field made new
 * captures unrecallable.
 */
test('listing: an unset filter field is absent from the body, not empty', async (t) => {
  const { server, cfg, mod } = await setup(t, { routes: { [LIST_ROUTE]: listPage([]) } });
  await mod.listActivity(cfg, { run: RUN });

  const body = server.lastCall('POST', '/v2/control/activity')?.body;
  for (const key of ['user_id', 'agent_id', 'created_after', 'created_before', 'exclude_derived', 'entry_types']) {
    assert.ok(!(key in body),
      `\`${key}\` was sent unset. On this route an empty user_id is still read as a scope, and `
      + `a filter nobody asked for is the hardest kind to notice. Body: ${JSON.stringify(body)}`);
  }
});

// ===========================================================================
// The pagination loop
// ===========================================================================

/**
 * Written before the loop was, because this is the failure mode a paginating client has that a
 * single-shot one does not: an instance whose `next_page_token` never advances turns a scan
 * into an infinite request loop against the user's own server. The timeout on this test is the
 * assertion — without the guard it does not fail, it hangs.
 */
test('scan: a page token that never advances stops the scan instead of hanging it',
  { timeout: 10000 }, async (t) => {
    const { server, cfg, mod } = await setup(t, {
      // Always the same token, always a full page: the shape a buggy offset implementation has.
      routes: { [LIST_ROUTE]: listPage([activityEntry()], '0', 900) },
    });

    const r = await mod.scanActivity(cfg, { run: RUN, limit: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.data.truncated, true);
    assert.equal(r.data.truncatedReason, 'page_token_repeated');
    assert.ok(server.countOf('POST', '/v2/control/activity') <= 3,
      `a non-advancing token cost ${server.countOf('POST', '/v2/control/activity')} requests`);
  });

/**
 * Offset pagination is why the scan sorts ascending and the listing does not.
 *
 * The token is a numeric offset into a set the server re-derives on every request. Under
 * `desc`, a write that lands mid-scan shifts every subsequent offset by one: the next page
 * re-reads a row already read, and the row that moved past the boundary is never read at all.
 * Under `asc` new rows arrive at the end, past the offsets already consumed.
 */
test('scan: pages ascending, and a listing pages descending', async (t) => {
  const { server, cfg, mod } = await setup(t, {
    routes: {
      [LIST_ROUTE]: [
        listPage([activityEntry({ id: 'a' })], '1', 2),
        listPage([activityEntry({ id: 'b' })], '', 2),
      ],
    },
  });

  const r = await mod.scanActivity(cfg, { run: RUN, limit: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.entries.map((e) => e.id), ['a', 'b']);
  assert.equal(r.data.pages, 2);
  assert.equal(r.data.truncated, false);
  for (const call of server.calls('POST', '/v2/control/activity')) {
    assert.equal(call.body.sort, 'asc', 'a scan that sorts desc re-reads and misses rows');
  }
  assert.equal(server.calls('POST', '/v2/control/activity')[1].body.page_token, '1');

  server.reset();
  server.route(LIST_ROUTE, listPage([activityEntry()], '', 1));
  await mod.listActivity(cfg, { run: RUN });
  assert.equal(server.lastCall('POST', '/v2/control/activity')?.body.sort, 'desc',
    'a single page wants the newest entries, which is what a person asking "what just happened" means');
});

// The server clamps `limit` to 1..500 and clamps a zero *up to one* rather than to a default —
// so an omitted limit means one entry, not a hundred. Clamping here keeps the request honest
// and keeps a caller's `--limit 0` from turning a scan into one request per entry.
test('scan: the page size is clamped into 1..500 whatever the caller asked', async (t) => {
  const { server, cfg, mod } = await setup(t, { routes: { [LIST_ROUTE]: listPage([]) } });

  for (const asked of [undefined, 0, -5, NaN, 1.7, 10_000, '250']) {
    server.reset();
    await mod.scanActivity(cfg, { run: RUN, limit: /** @type {any} */ (asked) });
    const sent = server.lastCall('POST', '/v2/control/activity')?.body.limit;
    assert.equal(typeof sent, 'number', `limit must always be explicit; asked ${asked}`);
    assert.ok(Number.isInteger(sent) && sent >= 1 && sent <= 500,
      `asked ${asked}, sent ${sent}`);
  }
});

// A scan is bounded three ways, and every one of them reports rather than trims quietly. A
// short answer that says it is short is usable; a short answer that looks complete is the
// false artefact again.
test('scan: hitting the entry cap is reported, not silently trimmed', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: { [LIST_ROUTE]: listPage([activityEntry({ id: 'a' }), activityEntry({ id: 'b' })], '2', 900) },
  });

  const r = await mod.scanActivity(cfg, { run: RUN, limit: 2, maxEntries: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.data.truncated, true);
  assert.equal(r.data.truncatedReason, 'max_entries');
  assert.ok(r.data.entries.length >= 3, 'the cap is a floor on what was collected, not a slice');
});

test('scan: running out of wall clock is reported, not silently trimmed', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: { [LIST_ROUTE]: { delayMs: 60, json: { entries: [activityEntry()], next_page_token: '1', total_visible: 900 } } },
  });

  const r = await mod.scanActivity(cfg, { run: RUN, limit: 1, budgetMs: 80 });
  assert.equal(r.ok, true);
  assert.equal(r.data.truncated, true);
  assert.equal(r.data.truncatedReason, 'budget');
  assert.ok(r.data.elapsedMs >= 0);
});

/**
 * The bounds run the other way too, and getting that backwards is its own false artefact.
 *
 * A bound can only truncate something that was still coming. Checked before the page token,
 * a scan that read the feed to its very last page still reported `truncated` whenever it
 * happened to cross a bound on the way in — and a complete answer labelled partial is the same
 * failure as a partial one labelled complete, pointed the other way. Measured against a hosted
 * instance: 697 lessons, every one of them collected, reported as short.
 */
test('scan: reaching the last page is complete, even when a bound would have fired next', async (t) => {
  const { cfg, mod } = await setup(t, {
    // Two pages and then the end. Both bounds are already spent by the time the feed runs out.
    routes: {
      [LIST_ROUTE]: [
        { delayMs: 60, json: { entries: [activityEntry({ id: 'a' })], next_page_token: '1', total_visible: 2 } },
        { delayMs: 60, json: { entries: [activityEntry({ id: 'b' })], next_page_token: '', total_visible: 2 } },
      ],
    },
  });

  const r = await mod.scanActivity(cfg, { run: RUN, limit: 1, budgetMs: 80, maxEntries: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.data.entries.length, 2);
  assert.equal(r.data.truncated, false,
    `the feed ran out before any bound could cut it short; reason was ${r.data.truncatedReason}`);
  assert.equal(r.data.truncatedReason, '');
  assert.equal(r.data.nextPageToken, '');
});

// A failure mid-scan is a failure. Returning the pages that did arrive, as though the scan
// completed, is how a partial answer becomes a complete-looking one.
test('scan: a failed page fails the scan rather than returning a partial as complete', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: {
      [LIST_ROUTE]: [
        listPage([activityEntry({ id: 'a' })], '1', 900),
        { status: 503, json: { error: 'unavailable' } },
      ],
    },
  });

  const r = await mod.scanActivity(cfg, { run: RUN, limit: 1 });
  assert.equal(r.ok, false, 'a scan that lost a page in the middle did not see everything');
  assert.equal(r.code, 'upstream_unreachable');
});

// The corrections survive the loop: a scan is the listing repeated, and a promoted entry on
// page four is exactly as wrong as one on page one.
test('scan: the client-side corrections apply across every page', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: {
      [LIST_ROUTE]: [
        listPage([activityEntry({ id: 'a' })], '1', 3),
        listPage([activityEntry({ id: 'promoted', metadata_json: '{"promotion":true}' })], '2', 3),
        listPage([activityEntry({ id: 'c', content: 'q'.repeat(900) })], '', 3),
      ],
    },
  });

  const r = await mod.scanActivity(cfg, { run: RUN, limit: 1, excludeDerived: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.entries.map((e) => e.id), ['a', 'c']);
  assert.equal(r.data.excludeDerivedFallbackUsed, true);
  assert.equal(r.data.projectionFallbackUsed, true);
  assert.equal(r.data.droppedDerived, 1);
});

// ===========================================================================
// The lesson census
// ===========================================================================

/**
 * Why the Memory tab counts lessons from the activity feed and not from the lessons route.
 *
 * `/v2/control/lessons` applies `limit` **before** it filters to `entry_type == "lesson"`, so
 * `limit: 200` means "take two hundred arbitrary facts and keep whichever happen to be
 * lessons". Measured against a hosted instance, seventeen thousand entries in, the newest three
 * hundred contained not a single one — a tab that is empty because of the order the server does
 * two operations in, not because the instance holds nothing.
 *
 * `/v2/control/activity` collects, filters by `entry_types`, sorts, and only then pages, and it
 * reports `total_visible` and `next_page_token`. It is also a strict superset: `list_lessons`
 * builds every field it returns out of `f.metadata`, which is the same map the activity route
 * serialises wholesale into `metadata_json`.
 *
 * The trap that makes the projection load-bearing is one line away in this very module.
 * `correct()` maps every row through `compactEntry` unless the projection is `full`, and
 * `compactEntry` keeps five keys — none of them `metadata_json`. A census at the default
 * projection would therefore find every lesson and know the scope of none of them.
 */
test('census: the feed is asked for lessons at full projection, because compact throws the metadata scope lives in away', async (t) => {
  const { server, cfg, mod } = await setup(t, { routes: { [LIST_ROUTE]: listPage([]) } });

  const r = await mod.lessonCensus(cfg, { run: RUN });
  assert.equal(r.ok, true);
  assert.equal(r.data.source, 'activity');

  const body = server.lastCall('POST', '/v2/control/activity')?.body;
  assert.deepEqual(body.entry_types, ['lesson'],
    'without this the census pages through traces and reports that the instance has no lessons');
  assert.equal(body.projection, 'full',
    'a compact row has no metadata_json, so every lesson would come back with an unknown scope');
});

// A census that stops at the first page is the lessons route's defect wearing a different
// route. The whole point of paying for the feed is that it pages honestly, and an id repeated
// across a page boundary is one lesson, not two.
test('census: every page is followed to the end, and a lesson seen twice is counted once', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: {
      [LIST_ROUTE]: [
        listPage([lessonRow('a', { created_at: '2026-08-19T15:03:18Z' }),
          lessonRow('b', { created_at: '2026-08-18T15:03:18Z' })], '2', 4),
        listPage([lessonRow('b', { created_at: '2026-08-18T15:03:18Z' }),
          lessonRow('c', { created_at: '2026-08-17T15:03:18Z' })], '', 4),
      ],
    },
  });

  const r = await mod.lessonCensus(cfg, { run: RUN, limit: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.data.pages, 2, 'a census that stopped at page one has the defect it was written to fix');
  assert.deepEqual(r.data.lessons.map((l) => l.id), ['a', 'b', 'c'],
    'deduped by id, and newest first because that is the order the tab renders');
  assert.equal(r.data.totalVisible, 4);
  assert.equal(r.data.truncated, false);
});

/**
 * The same liveness failure the scan has, inherited rather than rewritten.
 *
 * An instance whose `next_page_token` never advances turns a census into an infinite request
 * loop against the user's own server — and this one runs behind a page somebody left open. The
 * timeout is the assertion: without the guard this does not fail, it hangs.
 */
test('census: a page token that never advances stops the census instead of hanging it',
  { timeout: 10000 }, async (t) => {
    const { server, cfg, mod } = await setup(t, {
      routes: { [LIST_ROUTE]: listPage([lessonRow('a')], '0', 900) },
    });

    const r = await mod.lessonCensus(cfg, { run: RUN, limit: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.data.truncated, true);
    assert.equal(r.data.truncatedReason, 'page_token_repeated');
    assert.ok(server.countOf('POST', '/v2/control/activity') <= 3,
      `a non-advancing token cost ${server.countOf('POST', '/v2/control/activity')} requests`);
  });

// A page is not an audit, so the census stops sooner than a scan does — but a short answer that
// looks complete is the same lie either way. "You have four global lessons" over a census that
// gave up after two pages is a number a person will act on.
test('census: hitting the page cap is reported rather than rendered as a total', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: {
      [LIST_ROUTE]: [
        listPage([lessonRow('a')], '1', 900),
        listPage([lessonRow('b')], '2', 900),
        listPage([lessonRow('c')], '3', 900),
      ],
    },
  });

  const r = await mod.lessonCensus(cfg, { run: RUN, limit: 1, maxPages: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.data.pages, 2);
  assert.equal(r.data.truncated, true);
  assert.equal(r.data.truncatedReason, 'max_pages');
  assert.equal(r.data.lessons.length, 2, 'what did arrive is still returned; it is just labelled short');

  const { mod: fresh } = await setup(t);
  assert.ok(fresh.CENSUS_MAX_PAGES < fresh.SCAN_MAX_PAGES,
    'an interactive page must give up sooner than a terminal audit does');
  assert.ok(fresh.CENSUS_BUDGET_MS < fresh.SCAN_BUDGET_MS);
  assert.ok(fresh.CENSUS_MAX_ENTRIES < fresh.SCAN_MAX_ENTRIES);
});

/**
 * The three spellings a scope arrives in, all of which the server itself accepts.
 *
 * `list_lessons` reads `scope` and falls back to `lesson_scope`, so an instance that has both
 * conventions in its history serves both. The double-encoded case is not hypothetical either:
 * `metadata_json` is a JSON string by declaration, and an instance that round-trips it through
 * a second encoder hands over a string whose contents are themselves JSON.
 */
test('census: a scope stated as scope, as lesson_scope, or through a second encoder all read the same', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: {
      [LIST_ROUTE]: listPage([
        lessonRow('plain', { meta: { scope: 'global' } }),
        lessonRow('aliased', { meta: { lesson_scope: 'session' } }),
        lessonRow('wrapped', { metadata_json: JSON.stringify(JSON.stringify({ scope: 'org' })) }),
      ]),
    },
  });

  const r = await mod.lessonCensus(cfg, { run: RUN });
  assert.equal(r.ok, true);
  const byId = new Map(r.data.lessons.map((l) => [l.id, l]));
  assert.equal(byId.get('plain').scope, 'global');
  assert.equal(byId.get('aliased').scope, 'session', 'the server reads lesson_scope too');
  assert.equal(byId.get('wrapped').scope, 'org', 'a doubly-encoded metadata_json still has a scope in it');
  for (const id of ['plain', 'aliased', 'wrapped']) {
    assert.equal(byId.get(id).scopeKnown, true, `${id} named its scope out loud`);
  }
  assert.deepEqual(r.data.scopeCounts, { global: 1, session: 1, org: 1 });
  assert.equal(r.data.unknownScope, 0);
});

/**
 * The two facts an absent scope is made of, and why the row carries both.
 *
 * Such a lesson reads as `run` everywhere else it is asked for, so a page rendering a blank
 * would disagree with every other view of the same entry. But "it arrived saying run" and
 * "we never saw the metadata" are different facts, and only the second one should make somebody
 * doubt the number next to it.
 */
test('census: a row whose metadata did not survive reads as run-scoped and says the scope is unknown', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: {
      [LIST_ROUTE]: listPage([
        lessonRow('empty', { metadata_json: '' }),
        lessonRow('garbled', { metadata_json: 'not json at all' }),
        lessonRow('stated', { meta: { scope: 'run' } }),
      ]),
    },
  });

  const r = await mod.lessonCensus(cfg, { run: RUN });
  assert.equal(r.ok, true);
  const byId = new Map(r.data.lessons.map((l) => [l.id, l]));
  for (const id of ['empty', 'garbled']) {
    assert.equal(byId.get(id).scope, 'run', `${id}: the instance would call this a run lesson`);
    assert.equal(byId.get(id).scopeKnown, false, `${id}: and we are guessing, which the page must be able to show`);
    assert.equal(byId.get(id).leaksScope, false);
  }
  assert.equal(byId.get('stated').scopeKnown, true, 'a scope that was actually stated is not a guess');
  assert.equal(r.data.unknownScope, 2);
  assert.deepEqual(r.data.scopeCounts, { run: 3 }, 'a defaulted scope still counts as the scope it defaulted to');
});

// `repo:` is the project key, and an entry carrying no `repo:` tag is unconfined — it is not
// this project's. Bucketing the untagged ones under the current repo would invent a
// confinement the instance never recorded, which is the one answer this column must not give.
test('census: the repo tag names the project, and an untagged lesson belongs to no project rather than this one', async (t) => {
  const { cfg, mod } = await setup(t, {
    routes: {
      [LIST_ROUTE]: listPage([
        lessonRow('tagged', { meta: { scope: 'global', env_tags: ['lang:rust', 'repo:acme/ledger'] } }),
        lessonRow('other', { meta: { scope: 'global', env_tags: ['repo:acme/storefront'] } }),
        lessonRow('untagged', { meta: { scope: 'global', env_tags: ['lang:rust'] } }),
        lessonRow('bare', { meta: { scope: 'global' } }),
      ]),
    },
  });

  const r = await mod.lessonCensus(cfg, { run: RUN });
  assert.equal(r.ok, true);
  const byId = new Map(r.data.lessons.map((l) => [l.id, l]));
  assert.equal(byId.get('tagged').project, 'acme/ledger', 'the prefix is stripped; the slug is the key');
  assert.equal(byId.get('other').project, 'acme/storefront');
  assert.equal(byId.get('untagged').project, '', 'tags without a repo: one attribute nothing');
  assert.equal(byId.get('bare').project, '');
  assert.deepEqual(r.data.projectCounts,
    { 'acme/ledger': 1, 'acme/storefront': 1, '': 2 },
    'the empty key is the explicit "no project tag" bucket, not a hole in the table');
});
