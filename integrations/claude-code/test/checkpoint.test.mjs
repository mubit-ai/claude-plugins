// @ts-check
/**
 * `hooks/src/checkpoint.mjs` — PreCompact (`--pre`, blocking) / PostCompact (`--post`).
 *
 * Guide sections under test:
 *   §5.6  the flow, the request body, both stdout shapes, the one visible failure
 *   §4.4  redaction — a transcript is the densest secret surface the plugin ever touches
 *   §7    `runs/<run_id>/checkpoints.json` holds the last 10 `{checkpoint_id, token_estimate, at}`
 *   §4.9  exit 0 always, even when the checkpoint is lost
 *
 * Budgets: PreCompact 5000 ms internal / 10 s hook timeout — the one place blocking is
 * justified, because after compaction the content is gone. PostCompact 800 ms, no network.
 *
 * Tests pin the run id with the `static` strategy (§6.1) so state paths under
 * `runs/<run_id>/` are known before the hook runs and can be seeded.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  runHook, assertHookContract, fakeMubit, makeDataDir, makeProjectDir,
  baseEnv, readJsonFile, spoolFiles,
} from './helpers/harness.mjs';
import * as fx from './helpers/fixtures.mjs';

const PROJECT_DIR = makeProjectDir({ git: true });
const RUN_ID = 'cc-checkpoint-test';

function env(dataDir, endpoint, extra = {}) {
  return baseEnv({
    dataDir,
    endpoint,
    projectDir: PROJECT_DIR,
    extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN_ID, ...extra },
  });
}

const runDir = (dataDir) => join(dataDir, 'runs', RUN_ID);
const checkpointsPath = (dataDir) => join(runDir(dataDir), 'checkpoints.json');

/** §7 stores the last 10 entries; read tolerantly so the assertion is about content. */
function readCheckpoints(dataDir) {
  const j = readJsonFile(checkpointsPath(dataDir));
  return Array.isArray(j) ? j : (j.checkpoints ?? j.items ?? []);
}

function seedCheckpoints(dataDir, entries) {
  mkdirSync(runDir(dataDir), { recursive: true });
  writeFileSync(checkpointsPath(dataDir), JSON.stringify(entries));
}

/**
 * A realistic transcript: JSONL, one message per line, big enough that the last 200 KB
 * is a strict tail. `head-marker-line` sits in the first line and must NOT survive;
 * `tail-marker-line` and the planted key sit at the end and must.
 */
function writeTranscript(dir, { bytes = 700 * 1024, secret = true, name = 'transcript.jsonl' } = {}) {
  const path = join(dir, name);
  const line = (role, text) =>
    JSON.stringify({ type: role, message: { role, content: [{ type: 'text', text }] } });

  const lines = [line('user', 'head-marker-line: the earliest message in this transcript.')];
  const filler = 'the quick brown fox jumps over the lazy dog. '.repeat(20);
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const l = line(i % 2 ? 'assistant' : 'user', `turn ${i}: ${filler}`);
    lines.push(l);
    size += l.length + 1;
  }
  if (secret) {
    lines.push(line('assistant', `I exported MUBIT_API_KEY=${fx.SECRETS.mubitKey} for the smoke test.`));
  }
  lines.push(line('assistant', 'tail-marker-line: the most recent message in this transcript.'));

  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

const preCompactPayload = (transcriptPath, over = {}) =>
  fx.preCompact({ transcript_path: transcriptPath, cwd: PROJECT_DIR, ...over });

// ---------------------------------------------------------------------------
// --pre
// ---------------------------------------------------------------------------

// §5.6 — the PreCompact request body, verbatim. `run_id` is the only mandatory field
// on a `POST /v2/control/checkpoint` body (§1.3), but the label is what makes the anchor findable.
test('--pre posts /v2/control/checkpoint with run_id, agent_id, label, snapshot and metadata', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const transcript = writeTranscript(dataDir, { bytes: 32 * 1024 });

  const r = await runHook('checkpoint', preCompactPayload(transcript),
    { env: env(dataDir, server.url), args: ['--pre'] });

  assertHookContract(r);
  server.assertCalled('POST', '/v2/control/checkpoint', 1);

  const body = server.lastCall('POST', '/v2/control/checkpoint').body;
  assert.equal(body.run_id, RUN_ID);
  assert.equal(body.agent_id, 'claude-code');
  assert.match(body.label, /^claude-code-precompact-\d+$/);
  assert.equal(typeof body.context_snapshot, 'string');
  assert.ok(body.context_snapshot.length > 0, 'the snapshot is the whole point');
  assert.ok(body.context_snapshot.includes('tail-marker-line'), 'the snapshot must hold the recent tail');

  const meta = JSON.parse(body.metadata_json);
  assert.equal(meta.source, 'PreCompact');
  assert.equal(meta.turn_number, 41);
  assert.ok(fx.SESSION_ID.startsWith(String(meta.session_id)), 'metadata carries the session id');
});

// §5.6 steps 1-2 + §4.4 — take the LAST 200 KB, and redact before sending. A transcript
// is the densest secret surface in the product: it contains every command and every
// file the user pasted.
test('--pre redacts the transcript and bounds the snapshot to the last 200 KB', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const transcript = writeTranscript(dataDir, { bytes: 700 * 1024, secret: true });

  const r = await runHook('checkpoint', preCompactPayload(transcript),
    { env: env(dataDir, server.url), args: ['--pre'] });

  assertHookContract(r);
  const call = server.lastCall('POST', '/v2/control/checkpoint');

  // The planted key must not appear ANYWHERE in the request body, redacted or reshaped.
  assert.ok(!call.raw.includes(fx.SECRETS.mubitKey),
    'the API key from the transcript reached the wire — redaction did not run before send');
  assert.match(call.body.context_snapshot, /\[REDACTED/,
    'the secret-bearing line must be scrubbed in place, not silently dropped');

  // Bounded: the last 200 KB, plus a little slack for a truncation notice.
  const bytes = Buffer.byteLength(call.body.context_snapshot, 'utf8');
  assert.ok(bytes <= 200 * 1024 + 4096, `context_snapshot is ${bytes} bytes, past the 200 KB tail`);

  // ...and it is the *tail*, not the head or a sample.
  assert.ok(call.body.context_snapshot.includes('tail-marker-line'));
  assert.ok(!call.body.context_snapshot.includes('head-marker-line'),
    'the snapshot must be the last 200 KB, not the first');
});

// §7 — `runs/<run_id>/checkpoints.json` keeps the last 10, so a long session's anchors
// do not grow without bound and the newest is always findable by PostCompact.
test('--pre persists {checkpoint_id, token_estimate, at} to checkpoints.json', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const transcript = writeTranscript(dataDir, { bytes: 16 * 1024 });

  const before = Date.now();
  const r = await runHook('checkpoint', preCompactPayload(transcript),
    { env: env(dataDir, server.url), args: ['--pre'] });
  assertHookContract(r);

  const list = readCheckpoints(dataDir);
  assert.equal(list.length, 1);
  assert.equal(list[0].checkpoint_id, 'ckpt_test_1');
  assert.equal(list[0].token_estimate, 3400);
  assert.ok(list[0].at >= before, 'entry carries the time it was taken');
});

// §7 — "Last 10". 12 seeded + 1 new must leave exactly 10, oldest evicted.
test('--pre keeps only the last 10 checkpoints', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const transcript = writeTranscript(dataDir, { bytes: 16 * 1024 });

  seedCheckpoints(dataDir, Array.from({ length: 12 }, (_, i) => ({
    checkpoint_id: `seed-${i}`, token_estimate: 100 + i, at: 1765000000000 + i,
  })));

  const r = await runHook('checkpoint', preCompactPayload(transcript),
    { env: env(dataDir, server.url), args: ['--pre'] });
  assertHookContract(r);

  const ids = readCheckpoints(dataDir).map((c) => c.checkpoint_id);
  assert.equal(ids.length, 10, `expected 10 retained checkpoints, got [${ids.join(', ')}]`);
  assert.ok(ids.includes('ckpt_test_1'), 'the new checkpoint is retained');
  assert.ok(ids.includes('seed-11'), 'the most recent seeded checkpoints are retained');
  for (const gone of ['seed-0', 'seed-1', 'seed-2']) {
    assert.ok(!ids.includes(gone), `${gone} should have been evicted`);
  }

  // The label counter follows the stored history, so anchors are distinguishable.
  const n = Number(server.lastCall('POST', '/v2/control/checkpoint').body.label.split('-').pop());
  assert.ok(n >= 2, `label counter did not advance past prior checkpoints, got ${n}`);
});

// §5.6 step 5 — the spooled `checkpoint`-intent item is the belt to the checkpoint call's
// braces: it goes through the normal ingest path, so the anchor survives even when the
// dedicated endpoint fails. §1.5: intent is always set, or the server pays an LLM call.
test('--pre spools a checkpoint-intent item even when the checkpoint POST 500s', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/checkpoint': { status: 500, json: { error: 'boom' } } });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const transcript = writeTranscript(dataDir, { bytes: 16 * 1024 });

  const r = await runHook('checkpoint', preCompactPayload(transcript),
    { env: env(dataDir, server.url), args: ['--pre'] });
  assertHookContract(r);

  const spooled = spoolFiles(dataDir, RUN_ID);
  assert.equal(spooled.length, 1, 'the summary item must be spooled regardless of the HTTP result');
  const item = readJsonFile(spooled[0]);
  assert.equal(item.intent, 'checkpoint');
  assert.ok(item.item_id, 'item_id is required (§1.3)');
  assert.ok(item.content_type, 'content_type is required (§1.3)');
  assert.ok(!JSON.stringify(item).includes(fx.SECRETS.mubitKey), 'the spooled item is redacted too');
});

// §5.6 — PreCompact stdout carries the id so the user can find the anchor later.
test('--pre stdout carries the checkpoint id in systemMessage', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const transcript = writeTranscript(dataDir, { bytes: 16 * 1024 });

  const r = await runHook('checkpoint', preCompactPayload(transcript),
    { env: env(dataDir, server.url), args: ['--pre'] });

  assertHookContract(r);
  assert.equal(typeof r.json.systemMessage, 'string');
  assert.ok(r.json.systemMessage.includes('ckpt_test_1'),
    `systemMessage must name the checkpoint, got: ${r.json.systemMessage}`);
});

// §5.6 "Failure" — the ONE failure the user is shown, because it is the only one that
// loses data permanently: after compaction the context is gone. Still exit 0 (§4.9).
test('--pre failure emits the exact checkpoint-failed systemMessage and exits 0', async (t) => {
  const server = await fakeMubit({ 'POST /v2/control/checkpoint': { status: 500, json: { error: 'boom' } } });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const transcript = writeTranscript(dataDir, { bytes: 16 * 1024 });

  const r = await runHook('checkpoint', preCompactPayload(transcript),
    { env: env(dataDir, server.url), args: ['--pre'] });

  assertHookContract(r);
  assert.equal(r.code, 0);
  assert.equal(
    r.json.systemMessage,
    'mubit: checkpoint failed (server_error) — pre-compaction context not saved',
  );
});

// ---------------------------------------------------------------------------
// --post
// ---------------------------------------------------------------------------

// §5.6 — `--post` reads `checkpoints.json` and dials nothing; 800 ms is not a network budget.
//
// It also injects NOTHING, and that is the fix rather than a regression: `PostCompact` is not
// a `hookSpecificOutput.hookEventName` Claude Code accepts, so the re-anchor this hook used to
// emit failed validation and was discarded whole — silently, on every compaction, since the
// first release. `test/hook-output.test.mjs` holds the accepted set and the evidence. The
// re-anchor now ships from `session-start.mjs` on `source === "compact"`, which is the only
// hook that runs after a compaction AND has an event name the host will take.
test('--post reads the stored checkpoint, dials nothing, and injects nothing', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedCheckpoints(dataDir, [{ checkpoint_id: 'ckpt_seeded_9', token_estimate: 3400, at: Date.now() }]);

  const r = await runHook('checkpoint', fx.postCompact({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url), args: ['--post'] });

  assertHookContract(r);
  assert.equal(server.requests.length, 0,
    `--post must not dial: ${server.requests.map((q) => `${q.method} ${q.path}`).join(', ')}`);

  assert.equal(r.json?.hookSpecificOutput, undefined,
    'a PostCompact hookSpecificOutput is rejected by the host and takes the whole output with '
    + `it; got:\n${JSON.stringify(r.json)}`);
  assert.equal(r.json?.suppressOutput, true,
    `--post has nothing the host will accept, so it says nothing; got:\n${JSON.stringify(r.json)}`);
});

// §5.6 — with nothing stored there is nothing to anchor to, and the answer is the same
// suppression rather than a second shape. "checkpoint undefined holds your context" is worse
// than silence, and so is a payload the host throws away.
test('--post with no stored checkpoint degrades quietly', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('checkpoint', fx.postCompact({ cwd: PROJECT_DIR }),
    { env: env(dataDir, server.url), args: ['--post'] });

  assertHookContract(r);
  assert.equal(server.requests.length, 0);
  assert.equal(r.json?.hookSpecificOutput, undefined);
  assert.equal(r.json?.suppressOutput, true);
});

// ---------------------------------------------------------------------------
// Transcript problems
// ---------------------------------------------------------------------------

// §4.9 — a compaction the plugin cannot snapshot must still not break compaction.
test('--pre with a missing transcript_path exits 0 without crashing', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();

  const r = await runHook('checkpoint', preCompactPayload(join(dataDir, 'no-such-transcript.jsonl')),
    { env: env(dataDir, server.url), args: ['--pre'] });

  assertHookContract(r);
  assert.equal(r.code, 0);
});

// §4.9 — same for an unreadable path (here: a directory where a file is expected).
test('--pre with an unreadable transcript_path exits 0 without crashing', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const notAFile = join(dataDir, 'transcript-dir.jsonl');
  mkdirSync(notAFile, { recursive: true });
  assert.ok(existsSync(notAFile));

  const r = await runHook('checkpoint', preCompactPayload(notAFile),
    { env: env(dataDir, server.url), args: ['--pre'] });

  assertHookContract(r);
  assert.equal(r.code, 0);
});

// ---------------------------------------------------------------------------
// --post clears the cross-turn seen-set — §5.2 / `lib/seen.mjs`
// ---------------------------------------------------------------------------

/*
 * Compaction resets the model's window, not the file.
 *
 * `hooks/src/prompt-recall.mjs` degrades a memory it has already injected into a one-line
 * pointer, on the strength of `runs/<run_id>/seen.json` saying the model has it. After a
 * compaction that is no longer true of anything: the transcript the entries were injected
 * into is gone. A pointer surviving a compaction names a memory that exists nowhere in the
 * conversation — strictly worse than paying full price, because the model is told a memory
 * applies and is given no way to read it.
 *
 * `--post` already runs on exactly that event, reads one file and dials nothing, so it is
 * where the reset belongs.
 */

const seenPath = (dataDir) => join(runDir(dataDir), 'seen.json');

function seedSeen(dataDir, refs = ['ref_rule_1', 'ref_lesson_1']) {
  mkdirSync(runDir(dataDir), { recursive: true });
  const now = Date.now();
  const entries = {};
  for (const id of refs) entries[id] = { first: now, last: now, count: 3 };
  writeFileSync(seenPath(dataDir), JSON.stringify({ run_id: RUN_ID, updated_at: now, refs: entries }));
}

test('--post clears the seen-set, so the next prompt re-expands every memory in full', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedCheckpoints(dataDir, [{ checkpoint_id: 'ckpt_prior', token_estimate: 3400, at: Date.now() }]);
  seedSeen(dataDir);

  const r = await runHook('checkpoint', fx.postCompact(), {
    env: env(dataDir, server.url), args: ['--post'],
  });

  assertHookContract(r);
  assert.equal(existsSync(seenPath(dataDir)), false,
    'a pointer that outlives the transcript it points into names a memory the model cannot read');
  assert.equal(server.requests.length, 0, '--post still dials nothing (§5.6)');
});

// The clear cannot be gated on the checkpoint call having worked. A compaction with no
// stored anchor still emptied the model's window, and that is the fact the seen-set tracks.
test('--post clears the seen-set even when there is no checkpoint to re-anchor to', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedSeen(dataDir);

  const r = await runHook('checkpoint', fx.postCompact(), {
    env: env(dataDir, server.url), args: ['--post'],
  });

  assertHookContract(r);
  assert.equal(existsSync(seenPath(dataDir)), false,
    'the reset follows the compaction, not the anchor — `--pre` failing does not un-compact '
    + 'the transcript');
});

// §5.6: `--pre` runs before the compaction, while the model still has everything. Clearing
// there would re-expand one block for no reason, and would leave the set live across the
// compaction if `--post` never fired.
test('--pre leaves the seen-set alone', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const transcript = writeTranscript(dataDir, { bytes: 32 * 1024 });
  seedSeen(dataDir);

  const r = await runHook('checkpoint', preCompactPayload(transcript), {
    env: env(dataDir, server.url), args: ['--pre'],
  });

  assertHookContract(r);
  assert.equal(existsSync(seenPath(dataDir)), true,
    'the model still has the whole transcript when --pre runs');
});
