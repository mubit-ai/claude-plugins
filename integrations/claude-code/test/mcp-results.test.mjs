// @ts-check
/**
 * What a tool result costs the conversation, and what it keeps.
 *
 * Every tool the vendored server exposes answered with `JSON.stringify(reply, null, 2)` of the
 * whole API response. Measured over fourteen days of real sessions a lesson list came back at
 * up to ~12k tokens and a recall at up to ~7k, in one turn, and then again with every turn
 * after it until the next compaction — the plugin's single largest context cost, paid for
 * fields the model never reads. `mcp/src/results.mjs` shapes the frame on its way out.
 *
 * Three promises, each with a test that would fail if it were broken:
 *
 *   1. A lesson list and an evidence list are ALWAYS rendered one line per item, with the id
 *      on the line — `mubit_dereference` and `mubit_outcome` need it, and so does the seen-set.
 *   2. A memory this run has already been shown renders as the same pointer the per-prompt
 *      injection uses, off the same set, and a memory first shown here is marked for it.
 *   3. Nothing goes over the ceiling, and whatever was cut is on disk at a path the result
 *      names. A frame the guard does not understand goes out byte for byte.
 *
 * The unit tests drive `shapeToolResult` and the stream wrapper directly. The last tests speak
 * real stdio to the committed `mcp/dist/index.js` against a `fakeMubit`, the way
 * `mcp-lessons.test.mjs` does: the launcher holding the right code proves nothing if the frame
 * the host reads is not the one that was shaped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  evidence, fakeMubit, makeDataDir, mcpCallTool, mod, queryResponse,
} from './helpers/harness.mjs';

const R = () => mod('mcp/src/results.mjs');
const A = () => mod('lib/assemble.mjs');
const SEEN = () => mod('lib/seen.mjs');

/** The host session the server was started under — what keys the seen-set (`lib/seen.mjs`). */
const SESSION = '4f21ab90-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One JSON-RPC tool-result frame, the shape `CallToolResult` has on the wire. */
function frame(text, over = {}) {
  return { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text }], ...over } };
}

/** @param {any} m */
const textOf = (m) => m.result.content[0].text;

const pretty = (v) => JSON.stringify(v, null, 2);

/** A lesson as the catalogue serves it: id twice, and the metadata the model never reads. */
function lesson(i, over = {}) {
  const id = `les-${String(i).padStart(3, '0')}-4c2c-8a2a-170bda484e6d`;
  return {
    id,
    lesson_id: id,
    content: `Lesson ${i}: when the daemon wedges, restart it before retrying the ingest, because `
      + 'a retry against a wedged daemon only queues behind the wedge.',
    lesson_type: 'rule',
    scope: 'run',
    importance: 'medium',
    conditions: ['when the daemon wedges', 'before a retry'],
    rationale: 'Measured twice; the retry never landed either time and the queue grew.',
    source: 'reflection:cc-results-test',
    source_run_id: 'cc-results-test',
    ...over,
  };
}

function catalogue(n) {
  return {
    lessons: Array.from({ length: n }, (_, i) => lesson(i + 1)),
    mubit_lessons_guard: { run_id: 'cc-results-test', showing: 'this run only', shown: n, matched: n },
  };
}

/** A spill stub that records what it was handed and answers with a fixed path. */
function spillStub(path = '/tmp/mubit-spill/result.json') {
  const calls = [];
  const spill = (text, shape) => { calls.push({ text, shape }); return path; };
  return { spill, calls, path };
}

// ---------------------------------------------------------------------------
// 1. The two compact shapes
// ---------------------------------------------------------------------------

test('a lesson list is rendered one line per lesson: id and tags on the line, metadata off it', async () => {
  const { shapeToolResult } = await R();
  const { estimateTokens } = await A();
  const original = pretty(catalogue(30));
  const { spill, path } = spillStub();

  const out = shapeToolResult(frame(original), { spill });

  assert.equal(out.changed, true);
  assert.equal(out.shape, 'lessons');
  const text = textOf(out.message);
  const lines = text.split('\n');
  const item = lines.find((l) => l.startsWith('- [rule, medium, run] les-001-'));
  assert.ok(item, `no line carried the first lesson with its tags and id:\n${text}`);
  assert.ok(item.includes(' — Lesson 1: when the daemon wedges'), `the content is not on the line:\n${item}`);
  for (const gone of ['rationale', 'conditions', 'source_run_id', 'Measured twice']) {
    assert.ok(!text.includes(gone), `metadata "${gone}" survived into the compact form:\n${text}`);
  }
  assert.ok(text.includes('showing: this run only'), `the catalogue\'s own note was dropped:\n${text}`);
  assert.ok(text.includes('Lessons (30):'), `no count line:\n${text}`);
  assert.ok(text.includes(`Raw result: ${path}`), `the raw result is not named:\n${text}`);
  assert.equal(out.shown.length, 30);
  assert.equal(out.dropped, 0);
  assert.ok(estimateTokens(text) * 3 < estimateTokens(original),
    `the compact form is not materially smaller: ${estimateTokens(text)} against ${estimateTokens(original)}`);
});

test('an evidence list keeps the answer and renders each hit with its reference_id, without scores', async () => {
  const { shapeToolResult } = await R();
  const reply = queryResponse({
    final_answer: 'Poll the job.',
    evidence: [
      evidence({ reference_id: 'ref_rule_1', entry_type: 'rule', score: 0.91,
        content: 'Ingest returns when queued, not when stored; poll the job.' }),
      evidence({ reference_id: 'ref_fact_1', entry_type: 'fact', score: 0.55, is_stale: true,
        content: 'IngestAccepted.status is always "queued" on success.' }),
    ],
  });

  const out = shapeToolResult(frame(pretty(reply)), { spill: spillStub().spill });

  assert.equal(out.shape, 'evidence');
  const text = textOf(out.message);
  assert.ok(text.includes('final_answer: Poll the job.'), `the answer was dropped:\n${text}`);
  assert.ok(text.includes('Memories (2):'), `no count line:\n${text}`);
  assert.ok(text.includes('- [rule] ref_rule_1 — Ingest returns when queued'), `first hit:\n${text}`);
  assert.ok(text.includes('- [fact, stale] ref_fact_1 — IngestAccepted.status'),
    `a stale hit must say so on its line:\n${text}`);
  assert.ok(!text.includes('0.91'), `a retrieval score survived:\n${text}`);
  assert.deepEqual(out.shown, ['ref_rule_1', 'ref_fact_1']);
});

test('empty scalar fields and non-item arrays are not rendered', async () => {
  const { shapeToolResult } = await R();
  const reply = queryResponse({ final_answer: '', citations: [0, 1], consulted_runs: ['a', 'b'] });

  const text = textOf(shapeToolResult(frame(pretty(reply)), { spill: spillStub().spill }).message);

  assert.ok(!text.includes('final_answer'), `an empty answer earned a line:\n${text}`);
  assert.ok(!text.includes('citations'), `an index array earned a line:\n${text}`);
  assert.ok(!text.includes('consulted_runs'), `a run list earned a line:\n${text}`);
});

// ---------------------------------------------------------------------------
// 2. Repeats
// ---------------------------------------------------------------------------

test('a memory already seen this run renders as the injection\'s own pointer, id first', async () => {
  const { shapeToolResult } = await R();
  const { POINTER_MARK } = await A();
  const reply = queryResponse();

  const out = shapeToolResult(frame(pretty(reply)), {
    spill: spillStub().spill, seen: new Set(['ref_rule_1']),
  });

  const text = textOf(out.message);
  assert.ok(text.includes(`- ${POINTER_MARK} ref_rule_1 — Ingest returns when queued`),
    `the seen hit was not degraded to the shared pointer format:\n${text}`);
  assert.ok(!text.includes('not when stored; poll the job'),
    `the seen hit's full text was rendered anyway:\n${text}`);
  assert.deepEqual(out.pointed, ['ref_rule_1']);
  assert.deepEqual(out.shown, ['ref_lesson_1', 'ref_fact_1']);
  assert.ok(text.includes('Memories (3, 1 seen earlier):'), `the count line does not say so:\n${text}`);
  assert.ok(text.includes(`A line marked "${POINTER_MARK}"`) && text.includes('mubit_dereference'),
    `no note tells the model what a pointer is or how to expand it:\n${text}`);
});

test('a pointer longer than the memory it points at is not a saving, so the memory renders in full', async () => {
  const { shapeToolResult } = await R();
  const reply = queryResponse({
    evidence: [evidence({ reference_id: 'ref_short', entry_type: 'fact', content: 'Poll the job.' })],
  });

  const out = shapeToolResult(frame(pretty(reply)), {
    spill: spillStub().spill, seen: new Set(['ref_short']),
  });

  assert.deepEqual(out.pointed, []);
  assert.deepEqual(out.shown, ['ref_short']);
  assert.ok(textOf(out.message).includes('- [fact] ref_short — Poll the job.'));
});

// ---------------------------------------------------------------------------
// 3. The ceiling
// ---------------------------------------------------------------------------

test('the ceiling cuts a prefix of the ranked list, says how much, and stays under budget', async () => {
  const { shapeToolResult } = await R();
  const { estimateTokens } = await A();

  const out = shapeToolResult(frame(pretty(catalogue(60))), { budget: 600, spill: spillStub().spill });

  const text = textOf(out.message);
  assert.ok(out.dropped > 0, 'nothing was dropped from 60 lessons under a 600-token ceiling');
  assert.ok(estimateTokens(text) <= 600, `over the ceiling: ${estimateTokens(text)} tokens`);
  assert.match(text, new RegExp(`Showing ${out.shown.length} of 60\\.`));
  // A prefix, in order: "showing eight" means the first eight the server ranked.
  out.shown.forEach((id, i) => assert.equal(id, lesson(i + 1).id, `item ${i} is out of order`));
});

test('the ceiling never drops below MIN_RESULT_TOKENS, so the note always fits', async () => {
  const { shapeToolResult, MIN_RESULT_TOKENS } = await R();

  const out = shapeToolResult(frame(pretty(catalogue(5))), { budget: 10, spill: spillStub().spill });

  assert.ok(out.shown.length >= 1, 'a ceiling of 10 rendered nothing at all');
  assert.ok(MIN_RESULT_TOKENS >= 100);
});

test('the original is spilled for a compact shape even when nothing was dropped', async () => {
  const { shapeToolResult } = await R();
  const original = pretty(catalogue(3));
  const { spill, calls } = spillStub();

  const out = shapeToolResult(frame(original), { spill });

  assert.equal(calls.length, 1, 'the compact form drops metadata, so the original must be on disk');
  assert.equal(calls[0].text, original, 'what was spilled is not the server\'s own text');
  assert.equal(calls[0].shape, 'lessons');
  assert.equal(out.spilled, calls[0] && '/tmp/mubit-spill/result.json');
});

test('an unknown JSON shape under the ceiling passes by identity', async () => {
  const { shapeToolResult } = await R();
  const health = frame(pretty({ entry_counts: { lesson: 3 }, stale_entries: 0, promotion_candidates: [] }));
  const { spill, calls } = spillStub();

  const out = shapeToolResult(health, { spill });

  assert.equal(out.changed, false);
  assert.equal(out.message, health, 'not the same reference');
  assert.equal(calls.length, 0, 'nothing should be spilled for a result that went out untouched');
});

test('an unknown JSON shape over the ceiling drops from the end of its longest array and says so', async () => {
  const { shapeToolResult } = await R();
  const { estimateTokens } = await A();
  const reply = {
    stale_entries: 3,
    promotion_candidates: Array.from({ length: 400 }, (_, i) => ({
      entry_id: `cand-${i}`, reason: 'recurs across sessions with the same prefix', count: i,
    })),
  };
  const { spill, path } = spillStub('/tmp/mubit-spill/health.json');

  const out = shapeToolResult(frame(pretty(reply)), { budget: 400, spill });

  assert.equal(out.shape, 'json');
  const text = textOf(out.message);
  const parsed = JSON.parse(text);
  assert.equal(parsed.stale_entries, 3, 'a scalar beside the array was lost');
  assert.ok(parsed.promotion_candidates.length < 400 && parsed.promotion_candidates.length > 0);
  assert.match(parsed._truncated, /^Showing \d+ of 400 promotion_candidates\. Raw result: /);
  assert.ok(parsed._truncated.endsWith(path));
  assert.ok(estimateTokens(text) <= 400, `over the ceiling: ${estimateTokens(text)}`);
});

test('prose over the ceiling is cut at a line and names the original', async () => {
  const { shapeToolResult } = await R();
  const { estimateTokens } = await A();
  const original = Array.from({ length: 800 }, (_, i) => `line ${i}: something the tool said`).join('\n');
  const { spill, path, calls } = spillStub('/tmp/mubit-spill/prose.txt');

  const out = shapeToolResult(frame(original), { budget: 300, spill });

  assert.equal(out.shape, 'text');
  const text = textOf(out.message);
  assert.ok(estimateTokens(text) <= 300, `over the ceiling: ${estimateTokens(text)}`);
  const [kept, note] = [text.slice(0, text.lastIndexOf('\n')), text.slice(text.lastIndexOf('\n') + 1)];
  assert.ok(original.startsWith(kept), 'the kept part is not a prefix of the original');
  assert.ok(kept.endsWith('something the tool said'), `not cut at a line boundary:\n${kept.slice(-60)}`);
  assert.match(note, /^… cut at \d+ of \d+ tokens\. Raw result: /);
  assert.ok(note.endsWith(path));
  assert.equal(calls[0].shape, 'text');
});

test('an error result is held under the ceiling but never re-rendered', async () => {
  const { shapeToolResult } = await R();
  const small = frame(pretty(catalogue(2)), { isError: true });
  const big = frame(pretty(catalogue(60)), { isError: true });

  const untouched = shapeToolResult(small, { spill: spillStub().spill });
  assert.equal(untouched.message, small, 'a small error result must go out exactly as written');

  const held = shapeToolResult(big, { budget: 300, spill: spillStub('/tmp/mubit-spill/err.txt').spill });
  assert.equal(held.shape, 'error');
  assert.ok(!textOf(held.message).includes('Lessons ('), 'an error result was re-rendered as a lesson list');
  assert.ok(textOf(held.message).includes('Raw result: /tmp/mubit-spill/err.txt'));
});

// ---------------------------------------------------------------------------
// Frames that are not tool results
// ---------------------------------------------------------------------------

test('every frame that is not a single-text tool result passes by identity', async () => {
  const { shapeToolResult } = await R();
  const opts = { spill: spillStub().spill, budget: 200 };
  const big = 'x '.repeat(5000);
  const frames = {
    initialize: { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'x' }, capabilities: {} } },
    toolsList: { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'mubit_recall', description: big }] } },
    request: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mubit_recall', arguments: { query: big } } },
    notification: { jsonrpc: '2.0', method: 'notifications/message', params: { data: big } },
    error: { jsonrpc: '2.0', id: 4, error: { code: -32601, message: big } },
    twoBlocks: { jsonrpc: '2.0', id: 5, result: { content: [{ type: 'text', text: big }, { type: 'text', text: big }] } },
    image: { jsonrpc: '2.0', id: 6, result: { content: [{ type: 'image', data: big, mimeType: 'image/png' }] } },
    notRpc: { id: 7, result: { content: [{ type: 'text', text: big }] } },
  };
  for (const [name, f] of Object.entries(frames)) {
    const out = shapeToolResult(f, opts);
    assert.equal(out.changed, false, `${name} was reported changed`);
    assert.equal(out.message, f, `${name} did not come back by identity`);
  }
});

test('shapeChunk touches only the line that is a tool result and marks what it rendered', async () => {
  const { shapeChunk } = await R();
  const garbage = '{"jsonrpc":"2.0","id":9,"result":{"content":[{"type":"text","text":"{oops';
  const initLine = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '1', serverInfo: {}, instructions: 'hi' } });
  const toolLine = JSON.stringify(frame(pretty(queryResponse())));
  const marked = [];
  const ctx = { budget: 2000, seen: () => new Set(), spill: spillStub().spill, mark: (ids) => marked.push(...ids) };

  assert.equal(shapeChunk(`${garbage}\n`, ctx), null, 'a line that is not JSON must not move');
  assert.equal(shapeChunk(`${initLine}\n`, ctx), null, 'the initialize frame must not move');

  const out = shapeChunk(`${initLine}\n${toolLine}\n${garbage}\n`, ctx);
  assert.ok(out, 'a chunk with a tool result in it must be rewritten');
  const lines = out.split('\n');
  assert.equal(lines[0], initLine, 'the initialize line changed');
  assert.equal(lines[2], garbage, 'the unparseable line changed');
  assert.notEqual(lines[1], toolLine);
  assert.ok(JSON.parse(lines[1]).result.content[0].text.includes('Memories (3):'));
  assert.deepEqual(marked, ['ref_rule_1', 'ref_lesson_1', 'ref_fact_1']);
});

// ---------------------------------------------------------------------------
// The stream wrapper
// ---------------------------------------------------------------------------

function fakeStream() {
  const written = [];
  const stream = { write(chunk) { written.push(chunk); return true; } };
  return { stream, written, original: stream.write };
}

test('installResultsGuard wraps the stream once, shapes tool results, and leaves the rest alone', async () => {
  const { installResultsGuard } = await R();
  const { stream, written, original } = fakeStream();
  const opts = {
    cfg: {}, runId: 'r', sessionId: SESSION, budget: 2000, stream,
    seen: () => new Set(), spill: spillStub().spill, mark: () => {},
  };

  installResultsGuard(opts);
  installResultsGuard(opts);

  assert.equal(stream.write.mubitResultsGuardOriginal, original, 'the second install stacked instead of rewrapping');
  assert.deepEqual(stream.write.mubitResultsGuard, { budget: 2000, seen: 'session', repeat: 'pointer' },
    'the marker is what the launch tests observe, so it has to say how the set is keyed');

  const initLine = `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '1', serverInfo: {} } })}\n`;
  stream.write(initLine);
  assert.equal(written[0], initLine, 'the initialize frame did not go out byte for byte');

  stream.write(`${JSON.stringify(frame(pretty(queryResponse())))}\n`);
  assert.ok(JSON.parse(written[1]).result.content[0].text.includes('Memories (3):'));
});

test('a ceiling of 0 installs nothing', async () => {
  const { installResultsGuard } = await R();
  const { stream, original } = fakeStream();

  installResultsGuard({ cfg: {}, runId: 'r', budget: 0, stream });

  assert.equal(stream.write, original);
});

test('in production the spill lives under the run and the seen set under the session, shared with the hooks', async () => {
  const { installResultsGuard, SPILL_DIR } = await R();
  const { readSeen } = await SEEN();
  const dataDir = makeDataDir();
  const cfg = { dataDir };
  const runId = 'cc-results-unit';
  const { stream, written } = fakeStream();
  installResultsGuard({ cfg, runId, sessionId: SESSION, stream });
  const original = pretty(queryResponse());

  stream.write(`${JSON.stringify(frame(original))}\n`);

  const first = JSON.parse(written[0]).result.content[0].text;
  const m = first.match(/Raw result: (\S+)/);
  assert.ok(m, `no path in the result:\n${first}`);
  const spillDir = join(dataDir, 'runs', runId, SPILL_DIR);
  assert.ok(m[1].startsWith(spillDir), `spilled outside the run directory: ${m[1]}`);
  assert.ok(existsSync(m[1]), `the named file does not exist: ${m[1]}`);
  assert.equal(readFileSync(m[1], 'utf8'), original, 'the file is not the server\'s own text');

  const seen = readSeen(cfg, runId, SESSION);
  assert.deepEqual([...seen.ids].sort(), ['ref_fact_1', 'ref_lesson_1', 'ref_rule_1'],
    'the ids shown in full were not marked in the conversation\'s seen-set');
  assert.ok(existsSync(join(dataDir, 'runs', runId, 'seen', `${SESSION}.json`)),
    'the set is the hooks\' own file for this session, so it has to be at their path');

  stream.write(`${JSON.stringify(frame(original))}\n`);
  const second = JSON.parse(written[1]).result.content[0].text;
  assert.ok(second.includes('(seen earlier) ref_rule_1'),
    `the second result did not degrade what the first one showed:\n${second}`);
});

// A launcher with no session id is not a conversation. The host hands `CLAUDE_CODE_SESSION_ID`
// to every MCP server it starts, but a server started by hand, by another host, or before the
// id existed has nothing to key on — and a pointer it wrote would name text nobody was shown.
test('with no session id, every result renders in full and no seen-set is written', async () => {
  const { installResultsGuard } = await R();
  const dataDir = makeDataDir();
  const cfg = { dataDir };
  const runId = 'cc-results-nosession';
  const { stream, written } = fakeStream();
  installResultsGuard({ cfg, runId, stream });
  assert.deepEqual(stream.write.mubitResultsGuard, { budget: 2000, seen: 'off', repeat: 'pointer' });

  const original = pretty(queryResponse());
  stream.write(`${JSON.stringify(frame(original))}\n`);
  stream.write(`${JSON.stringify(frame(original))}\n`);

  for (const w of written) {
    const text = JSON.parse(w).result.content[0].text;
    assert.ok(text.includes('Memories (3):') && !text.includes('(seen earlier)'),
      `a server that is not a conversation pointed at text it cannot know the model has:\n${text}`);
  }
  assert.equal(existsSync(join(dataDir, 'runs', runId, 'seen')), false,
    'nothing without a session may write a seen-set');
});

// `recallRepeatMode: full` is the documented opt-out for the injection; the tool results
// have to honour it too, or the setting turns pointers off in one place and leaves them on
// in the other.
test('repeatMode "full" renders a seen memory in full and reads no set', async () => {
  const { installResultsGuard } = await R();
  const { markSeen } = await SEEN();
  const dataDir = makeDataDir();
  const cfg = { dataDir };
  const runId = 'cc-results-full';
  markSeen(cfg, runId, ['ref_rule_1'], SESSION);
  const { stream, written } = fakeStream();
  installResultsGuard({ cfg, runId, sessionId: SESSION, repeatMode: 'full', stream });
  assert.deepEqual(stream.write.mubitResultsGuard, { budget: 2000, seen: 'session', repeat: 'full' });

  stream.write(`${JSON.stringify(frame(pretty(queryResponse())))}\n`);
  const text = JSON.parse(written[0]).result.content[0].text;
  assert.ok(text.includes('Memories (3):') && !text.includes('(seen earlier)'),
    `the opt-out was ignored:\n${text}`);
});

// ---------------------------------------------------------------------------
// Through the shipped bundle
// ---------------------------------------------------------------------------

/** Forty hits of ~300 characters: a recall the way a rich memory answers one. */
function richQuery() {
  return queryResponse({
    final_answer: 'Poll the job until it reports done.',
    evidence: Array.from({ length: 40 }, (_, i) => evidence({
      reference_id: `ref-e2e-${String(i).padStart(2, '0')}`,
      entry_type: i % 3 === 0 ? 'rule' : 'lesson',
      score: 1 - i / 100,
      content: `Hit ${i}: the ingest endpoint answers when the job is queued and not when the row `
        + 'is stored, so a caller that reads straight back sees nothing and must poll the job '
        + 'id it was handed until the status reports done, which takes about a second.',
    })),
  });
}

test('through the shipped bundle: mubit_recall comes back compact, under the ceiling, raw result on disk', async () => {
  const { estimateTokens } = await A();
  const fake = await fakeMubit({ 'POST /v2/control/query': { json: richQuery() } });
  const dataDir = makeDataDir();
  const runId = 'cc-results-e2e';
  const keyed = { endpoint: fake.url, dataDir, runId, extra: { CLAUDE_CODE_SESSION_ID: SESSION } };
  try {
    const r = await mcpCallTool('mubit_recall', { query: 'ingest' }, keyed);

    assert.equal(r.isError, false, `the tool failed: ${r.text}\n${r.stderr}`);
    assert.equal(r.json, null, 'the result is still raw JSON — the guard is not on the shipped frame');
    assert.ok(r.text.includes('final_answer: Poll the job until it reports done.'), r.text);
    assert.ok(r.text.includes('Memories (40'), `no count line:\n${r.text}`);
    assert.ok(r.text.includes('- [rule] ref-e2e-00 — Hit 0:'), `first hit missing or reshaped:\n${r.text}`);
    assert.ok(estimateTokens(r.text) <= 2000, `over the default ceiling: ${estimateTokens(r.text)}`);
    assert.match(r.text, /Showing \d+ of 40\./);

    const m = r.text.match(/Raw result: (\S+)/);
    assert.ok(m && existsSync(m[1]), `the raw result is not where the note says: ${m && m[1]}`);
    const raw = JSON.parse(readFileSync(m[1], 'utf8'));
    assert.equal(raw.evidence.length, 40, 'the file on disk is not the whole reply');
    assert.equal(raw.evidence[1].score, 0.99, 'the file on disk lost the metadata the line dropped');

    // The seen-set is the hooks' own file for this session, so a second process started
    // under the same host session id reads it.
    const again = await mcpCallTool('mubit_recall', { query: 'ingest' }, keyed);
    assert.ok(again.text.includes('(seen earlier) ref-e2e-00'),
      `a second call on the same session rendered the same hit in full again:\n${again.text}`);
    assert.ok(existsSync(join(dataDir, 'runs', runId, 'seen', `${SESSION}.json`)),
      'the set is keyed by the host session, at the path the hooks read');

    // …and a process the host gave no session id to is not a conversation: full, and no file.
    const anonymous = await mcpCallTool('mubit_recall', { query: 'ingest' }, { endpoint: fake.url, dataDir, runId });
    assert.ok(anonymous.text.includes('- [rule] ref-e2e-00 — Hit 0:') && !anonymous.text.includes('(seen earlier)'),
      `a server with no session id pointed at text it cannot know the model has:\n${anonymous.text}`);
  } finally {
    await fake.close();
  }
});

test('through the shipped bundle: the ceiling is the configured one, and 0 returns the raw JSON', async () => {
  const fake = await fakeMubit({ 'POST /v2/control/query': { json: richQuery() } });
  try {
    const raw = await mcpCallTool('mubit_recall', { query: 'ingest' }, {
      endpoint: fake.url, extra: { MUBIT_CC_MCP_RESULT_TOKENS: '0' },
    });
    assert.ok(raw.json && Array.isArray(raw.json.evidence) && raw.json.evidence.length === 40,
      `with the ceiling off the result should be the server\'s own JSON:\n${raw.text.slice(0, 300)}`);

    const tight = await mcpCallTool('mubit_recall', { query: 'ingest' }, {
      endpoint: fake.url, extra: { MUBIT_CC_MCP_RESULT_TOKENS: '400' },
    });
    const shown = (tight.text.match(/^- /gm) ?? []).length;
    assert.ok(shown > 0 && shown < 10, `a 400-token ceiling rendered ${shown} hits:\n${tight.text}`);
  } finally {
    await fake.close();
  }
});
