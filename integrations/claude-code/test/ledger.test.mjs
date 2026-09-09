// @ts-check
/**
 * `lib/ledger.mjs` — the per-turn ledger, and the four things it must never do.
 *
 * Turn files are pruned six hours after they are written, so everything the dashboard could
 * say about a turn — what was injected, whether the reply echoed it, what outcome it earned —
 * used to expire with them. The ledger is one appended line per closed turn, kept for a month
 * and capped by size, written by the Stop hook whether or not a dashboard is open.
 *
 * Because it is written by a hook on a five-second budget and read by a page, the traps are:
 *
 *   1. **It records a decision, never a post.** The row carries the outcome the turn *would*
 *      earn, computed the same way both hooks compute it, and nothing here has a socket.
 *   2. **Redaction is a literal, never `cfg`.** A user who set `redact: false` consented to
 *      send their own secrets to their own instance over TLS, not to keep them on disk for a
 *      month under a different name. The preview is scrubbed and capped at 240 bytes.
 *   3. **A torn line costs itself and nothing else.** A crash mid-append leaves a partial
 *      line; the reader skips it and the next append starts a fresh line.
 *   4. **A path from a run id cannot climb.** `safeSegment`, like every other write.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { lib, makeDataDir } from './helpers/harness.mjs';
import { SECRETS } from './helpers/fixtures.mjs';

const RUN = 'cc-ledger-00000001';
const PROMPT = '11111111-2222-3333-4444-555555555555';

/** A closed turn as `capture --stop` leaves it, with everything the row reads present. */
function closedTurn(over = {}) {
  return {
    prompt: 'why is the ingest job stuck in queued?',
    prompt_id: PROMPT,
    session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    turn_number: 3,
    started_at: 1_700_000_000_000,
    ended_at: 1_700_000_012_000,
    recalled: ['ref_rule_1', 'ref_rule_2'],
    recall: { at: 1_700_000_000_500, rung: 1, sources: 2, tokens: 88, chars: 350, pointers: 1, dropped: 0, empty_reason: '', terms: ['indexing', 'queued'] },
    used_evidence: { method: 'memory-term-echo/v1', at: 1_700_000_012_000, candidates: 2, matched: 1, terms: ['queued'], answer_chars: 400, used: true },
    outcome_pending: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

test('ledger: the path is runs/<run>/ledger.jsonl, and a traversal run id is flattened', async () => {
  const L = await lib('ledger.mjs');
  const dir = makeDataDir();
  assert.equal(L.ledgerPath(dir, RUN), join(dir, 'runs', RUN, L.LEDGER_FILE));
  assert.equal(L.LEDGER_FILE, 'ledger.jsonl');
  const p = L.ledgerPath(dir, '../../etc/passwd');
  assert.ok(p.startsWith(join(dir, 'runs')), `a traversal id escaped the runs directory: ${p}`);
  const segment = p.slice(join(dir, 'runs').length + 1).split('/')[0];
  assert.ok(!segment.includes('/') && segment !== '..' && !segment.startsWith('.'), `the run segment is ${segment}`);
});

test('ledger: the module has no network surface and imports only state, redact and outcome', async () => {
  const { PLUGIN_ROOT } = await import('./helpers/harness.mjs');
  const src = readFileSync(join(PLUGIN_ROOT, 'lib', 'ledger.mjs'), 'utf8');
  const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
  for (const i of imports) {
    assert.ok(i.startsWith('node:') || ['./state.mjs', './redact.mjs', './outcome.mjs'].includes(i),
      `lib/ledger.mjs imports ${i}; a hook-side module must not pull in the transport`);
  }
  assert.ok(!/node:http|fetch\(/.test(src), 'nothing here dials anything');
  assert.match(src, /--subagent/, 'the header must say subagent stops never write rows');
});

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

test('ledger: turnLedgerRow records the decision the turn would earn, and posts nothing', async () => {
  const L = await lib('ledger.mjs');
  const now = 1_700_000_020_000;

  const echoed = L.turnLedgerRow(closedTurn(), RUN, now);
  assert.equal(echoed.v, 1);
  assert.equal(echoed.kind, 'turn');
  assert.equal(echoed.at, now);
  assert.equal(echoed.run_id, RUN);
  assert.equal(echoed.prompt_id, PROMPT);
  assert.equal(echoed.session_id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(echoed.turn_number, 3);
  assert.equal(echoed.started_at, 1_700_000_000_000);
  assert.equal(echoed.ended_at, 1_700_000_012_000);
  assert.deepEqual(echoed.recalled, ['ref_rule_1', 'ref_rule_2']);
  assert.deepEqual(echoed.recall, { rung: 1, sources: 2, tokens: 88, chars: 350, pointers: 1, dropped: 0, empty_reason: '' });
  assert.ok(!('terms' in echoed.recall), 'the staged terms are prompt-derived and stay off the ledger');
  assert.equal(echoed.used, true);
  assert.equal(echoed.api_error, '');
  assert.equal(echoed.outcome, 'success');
  assert.equal(echoed.signal, 0.2);
  assert.equal(echoed.prompt, 'why is the ingest job stuck in queued?');
  assert.equal(echoed.prompt_truncated, false);
  assert.equal(echoed.prompt_redactions, 0);

  // Injected, no echo: neutral at zero — and `used` is the measured false, not a null.
  const unused = L.turnLedgerRow(closedTurn({ used_evidence: { candidates: 2, matched: 0, used: false } }), RUN, now);
  assert.equal(unused.outcome, 'neutral');
  assert.equal(unused.signal, 0);
  assert.equal(unused.used, false);

  // Unmeasured: absent `used` is null on the row, never false.
  const unmeasured = L.turnLedgerRow(closedTurn({ used_evidence: { candidates: 0, matched: 0, reason: 'no_distinct_terms' } }), RUN, now);
  assert.equal(unmeasured.used, null);
  assert.equal(unmeasured.outcome, 'success', 'an unmeasured turn keeps the old completed reading');
  const noEvidence = L.turnLedgerRow(closedTurn({ used_evidence: undefined }), RUN, now);
  assert.equal(noEvidence.used, null);

  // A turn marked failed.
  const failed = L.turnLedgerRow(closedTurn({ outcome: 'failure' }), RUN, now);
  assert.equal(failed.outcome, 'failure');
  assert.equal(failed.signal, -0.3);

  // The API killed it: the error is on the row and the outcome is none.
  const killed = L.turnLedgerRow(closedTurn({ api_error: 'rate_limit', used_evidence: undefined }), RUN, now);
  assert.equal(killed.api_error, 'rate_limit');
  assert.equal(killed.outcome, 'none');
  assert.equal(killed.signal, 0);

  // Nothing injected: none.
  const empty = L.turnLedgerRow(closedTurn({ recalled: [], used_evidence: undefined }), RUN, now);
  assert.equal(empty.outcome, 'none');
  assert.deepEqual(empty.recalled, []);

  // Already posted by a drain: the row still says what the turn earned, not "already sent".
  const sent = L.turnLedgerRow(closedTurn({ outcome_sent_at: now - 5, outcome_attempts: 1 }), RUN, now);
  assert.equal(sent.outcome, 'success');
  const exhausted = L.turnLedgerRow(closedTurn({ outcome_attempts: 3 }), RUN, now);
  assert.equal(exhausted.outcome, 'success');

  // A garbage turn is still a row rather than a throw.
  const bad = L.turnLedgerRow(null, RUN, now);
  assert.equal(bad.kind, 'turn');
  assert.equal(bad.outcome, 'none');
  assert.deepEqual(bad.recalled, []);
});

test('ledger: no secret reaches the row, and the preview is capped at 240 bytes whatever cfg says', async () => {
  const L = await lib('ledger.mjs');
  assert.ok(Object.isFrozen(L.LEDGER_REDACTION));
  assert.equal(L.LEDGER_REDACTION.redact, true);
  assert.equal(L.LEDGER_REDACTION.maxOutputBytes, 240);
  assert.equal(L.LEDGER_PREVIEW_BYTES, 240);

  const prompt = `deploy with ${Object.values(SECRETS).join(' and ')} then ${'x'.repeat(600)}`;
  const row = L.turnLedgerRow(closedTurn({ prompt }), RUN, 1);
  const text = JSON.stringify(row);
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.ok(!text.includes(value), `${name} reached the ledger row`);
  }
  // `redactText` caps the text at 240 bytes and then appends its own `…[truncated N bytes]`
  // marker, which is what tells a reader the row is a preview rather than the prompt.
  const body = row.prompt.replace(/\n…\[truncated \d+ bytes\]$/, '');
  assert.notEqual(body, row.prompt, 'a long prompt carries the truncation marker');
  assert.ok(Buffer.byteLength(body, 'utf8') <= 240, `preview is ${Buffer.byteLength(body, 'utf8')} bytes`);
  assert.equal(row.prompt_truncated, true);
  assert.ok(row.prompt_redactions > 0);
  // The staged terms and the reply are never on the row at all.
  assert.ok(!('terms' in (row.recall || {})));
  assert.ok(!('answer' in row) && !('used_evidence' in row));
});

// ---------------------------------------------------------------------------
// Append and read
// ---------------------------------------------------------------------------

test('ledger: append writes one line per row, and a torn line is skipped without losing the next', async () => {
  const L = await lib('ledger.mjs');
  const dir = makeDataDir();
  assert.equal(L.appendLedger(dir, RUN, { v: 1, kind: 'turn', at: 1, prompt_id: 'a' }), true);
  assert.equal(L.appendLedger(dir, RUN, { v: 1, kind: 'turn', at: 2, prompt_id: 'b' }), true);
  const p = L.ledgerPath(dir, RUN);
  assert.equal(readFileSync(p, 'utf8').split('\n').length, 3, 'two rows and a trailing newline');

  // A crash mid-append.
  writeFileSync(p, `${readFileSync(p, 'utf8')}{"v":1,"kind":"turn","at":3,"prom`);
  assert.deepEqual(L.readLedger(dir, RUN).map((r) => r.prompt_id), ['a', 'b']);

  // The next append does not glue itself onto the torn line.
  assert.equal(L.appendLedger(dir, RUN, { v: 1, kind: 'outcome', at: 4, prompt_id: 'c' }), true);
  assert.deepEqual(L.readLedger(dir, RUN).map((r) => r.prompt_id), ['a', 'b', 'c']);

  // Never throws: an unwritable target is `false`.
  assert.equal(L.appendLedger('', RUN, { v: 1 }), false);
  assert.equal(L.appendLedger(dir, '', { v: 1 }), false);
  assert.equal(L.appendLedger(dir, RUN, null), false);
  assert.deepEqual(L.readLedger(dir, 'cc-nothing-here'), []);
});

test('ledger: since, limit and kinds narrow the read; order is oldest first', async () => {
  const L = await lib('ledger.mjs');
  const dir = makeDataDir();
  for (let i = 1; i <= 6; i += 1) {
    L.appendLedger(dir, RUN, { v: 1, kind: i % 3 === 0 ? 'outcome' : 'turn', at: i * 1000, prompt_id: `p${i}` });
  }
  assert.deepEqual(L.readLedger(dir, RUN).map((r) => r.at), [1000, 2000, 3000, 4000, 5000, 6000]);
  assert.deepEqual(L.readLedger(dir, RUN, { since: 4000 }).map((r) => r.at), [4000, 5000, 6000]);
  assert.deepEqual(L.readLedger(dir, RUN, { limit: 2 }).map((r) => r.at), [5000, 6000], 'limit keeps the newest');
  assert.deepEqual(L.readLedger(dir, RUN, { kinds: ['outcome'] }).map((r) => r.at), [3000, 6000]);
  assert.deepEqual(L.readLedger(dir, RUN, { kinds: ['turn'], since: 2000, limit: 2 }).map((r) => r.at), [4000, 5000]);
});

// ---------------------------------------------------------------------------
// The cap
// ---------------------------------------------------------------------------

test('ledger: a trim keeps the newest bytes and drops rows past the row TTL, through a tmp file', async () => {
  const L = await lib('ledger.mjs');
  const dir = makeDataDir();
  const now = 10_000_000_000_000;
  const p = L.ledgerPath(dir, RUN);
  mkdirSync(join(dir, 'runs', RUN), { recursive: true });
  const rows = [];
  // Ten aged rows, then forty fresh ones, each ~100 bytes.
  for (let i = 0; i < 10; i += 1) rows.push({ v: 1, kind: 'turn', at: now - L.LEDGER_ROW_TTL_MS - i * 1000 - 1, prompt_id: `old${i}`, pad: 'x'.repeat(60) });
  for (let i = 0; i < 40; i += 1) rows.push({ v: 1, kind: 'turn', at: now - 40_000 + i * 1000, prompt_id: `new${i}`, pad: 'x'.repeat(60) });
  writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

  assert.equal(L.trimLedger(p, { keepBytes: 1200, ttlMs: L.LEDGER_ROW_TTL_MS, now }), true);
  const kept = L.readLedger(dir, RUN);
  assert.ok(kept.length > 0 && kept.length < 40, `kept ${kept.length}`);
  assert.ok(kept.every((r) => r.prompt_id.startsWith('new')), 'aged rows are dropped first');
  assert.equal(kept[kept.length - 1].prompt_id, 'new39', 'the newest row survives');
  assert.ok(statSync(p).size <= 1200);
  assert.ok(!existsSync(`${p}.tmp-${process.pid}`), 'the tmp file was renamed into place');

  // A TTL-only trim leaves fresh rows alone whatever their size.
  writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  assert.equal(L.trimLedger(p, { keepBytes: 1024 * 1024, ttlMs: L.LEDGER_ROW_TTL_MS, now }), true);
  assert.equal(L.readLedger(dir, RUN).length, 40);
});

test('ledger: append trims the file once it passes LEDGER_MAX_BYTES', async () => {
  const L = await lib('ledger.mjs');
  const dir = makeDataDir();
  const p = L.ledgerPath(dir, RUN);
  mkdirSync(join(dir, 'runs', RUN), { recursive: true });
  assert.equal(L.LEDGER_MAX_BYTES, 1024 * 1024);
  assert.equal(L.LEDGER_KEEP_BYTES, 512 * 1024);
  const line = JSON.stringify({ v: 1, kind: 'turn', at: Date.now(), prompt_id: 'p', pad: 'x'.repeat(1000) });
  const n = Math.ceil(L.LEDGER_MAX_BYTES / (line.length + 1)) + 5;
  writeFileSync(p, `${Array.from({ length: n }, () => line).join('\n')}\n`);
  assert.ok(statSync(p).size > L.LEDGER_MAX_BYTES);

  assert.equal(L.appendLedger(dir, RUN, { v: 1, kind: 'turn', at: Date.now(), prompt_id: 'last' }), true);
  assert.ok(statSync(p).size <= L.LEDGER_KEEP_BYTES, `after the trim the file is ${statSync(p).size} bytes`);
  const rows = L.readLedger(dir, RUN);
  assert.equal(rows[rows.length - 1].prompt_id, 'last', 'the row that triggered the trim survives it');
});
