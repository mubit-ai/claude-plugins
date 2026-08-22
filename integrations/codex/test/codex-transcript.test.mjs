// @ts-check
/**
 * `checkpoint.mjs`'s transcript reader, against a Codex rollout.
 *
 * This is the only real parser work in the port. The two hosts write conversation to disk in
 * different envelopes:
 *
 *   Claude Code  {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":…}]}}
 *   Codex        {"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":…}]}}
 *
 * Two differences, and both of them matter. The message sits under `payload` rather than
 * `message`, and the content item's own `type` is `input_text` / `output_text` where Claude
 * Code writes `text` — so a reader that keys off the item type drops every line even after it
 * finds the right envelope.
 *
 * What fails if this is wrong is quiet and expensive: `PreCompact` is the one event where the
 * plugin cannot recover later, because once the host compacts, the transcript is gone. A
 * reader that renders nothing produces a checkpoint that says "0 messages" and a session
 * whose pre-compaction context was never saved at all.
 *
 * The three properties that carry over unchanged from the Claude Code side, and are asserted
 * here rather than assumed: the window is a **tail**, it is bounded, and it is **scrubbed
 * before it is capped**.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  preCompact, runHook, baseEnv, makeDataDir, makeProjectDir, fakeMubit, tempDir,
  assertHookContract, rolloutJsonl,
} from './helpers/codex-fixtures.mjs';

const RUN_ID = 'codex-transcript-test';

/** Write a rollout file and hand back its path. */
function rollout(messages) {
  const path = join(tempDir('codex-rollout-'), 'rollout.jsonl');
  writeFileSync(path, rolloutJsonl(messages));
  return path;
}

function env(dataDir, projectDir, endpoint) {
  return baseEnv({
    dataDir, projectDir, endpoint,
    extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN_ID },
  });
}

async function checkpoint(t, messages, over = {}) {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir({ git: true });
  const path = rollout(messages);
  const r = await runHook('checkpoint', preCompact({ transcript_path: path, ...over }), {
    args: ['--pre'], env: env(dataDir, projectDir, server.url),
  });
  return { r, server, dataDir, path };
}

// ===========================================================================
// It reads a Codex rollout at all
// ===========================================================================

test('the reader renders a Codex rollout, not an empty snapshot', async (t) => {
  const { r, server } = await checkpoint(t, [
    { role: 'user', text: 'Port the plugin to Codex.' },
    { role: 'assistant', text: 'Starting with the probe spike.' },
  ]);

  assertHookContract(r);
  const call = server.lastCall('POST', '/v2/control/checkpoint');
  // § The failure this catches is silent: `renderEntry` finds no `message` key, falls back to
  //   the whole envelope, finds no `content` there either, and returns '' for every line. The
  //   hook exits 0, reports "no readable transcript text", and the session's pre-compaction
  //   context is gone for good.
  assert.ok(call, 'nothing was checkpointed. A Codex rollout read as zero messages is the '
    + 'default failure of this port, and PreCompact is the one event with no second chance.');
  const text = String(call.body?.context ?? call.body?.text ?? JSON.stringify(call.body));
  assert.match(text, /Port the plugin to Codex/, 'the user turn is missing from the snapshot.');
  assert.match(text, /Starting with the probe spike/, 'the assistant turn is missing.');
});

test('each line is rendered as "<role>: <text>", the same shape both hosts produce', async (t) => {
  const { server } = await checkpoint(t, [
    { role: 'user', text: 'alpha-marker' },
    { role: 'assistant', text: 'beta-marker' },
  ]);
  const body = JSON.stringify(server.lastCall('POST', '/v2/control/checkpoint')?.body ?? {});
  // § The rendering is what the server stores and what a later recall shows a model. Two hosts
  //   producing two shapes would make one project's checkpoints unreadable next to the other's.
  assert.match(body, /user: alpha-marker/, 'the user role prefix is missing.');
  assert.match(body, /assistant: beta-marker/, 'the assistant role prefix is missing.');
});

test('the content item type is input_text / output_text, and both are read', async (t) => {
  const path = join(tempDir('codex-rollout-'), 'rollout.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'in-marker' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'out-marker' }] } }),
  ].join('\n') + '\n');

  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  await runHook('checkpoint', preCompact({ transcript_path: path }), {
    args: ['--pre'], env: env(dataDir, makeProjectDir({ git: true }), server.url),
  });
  const body = JSON.stringify(server.lastCall('POST', '/v2/control/checkpoint')?.body ?? {});
  // § `messageText` rejects any block whose `type` it does not recognise — deliberately, so a
  //   tool_use or an image block does not spend the 200 KB window. `input_text`/`output_text`
  //   fall into that rejection unless they are named, which is the second half of the port's
  //   only parser change.
  assert.match(body, /in-marker/, 'input_text blocks were dropped — that is every user turn.');
  assert.match(body, /out-marker/, 'output_text blocks were dropped — that is every assistant turn.');
});

// ===========================================================================
// What it must NOT render
// ===========================================================================

test('the machinery lines are skipped', async (t) => {
  const { server } = await checkpoint(t, [{ role: 'user', text: 'a real turn' }]);
  const body = JSON.stringify(server.lastCall('POST', '/v2/control/checkpoint')?.body ?? {});
  // § A rollout is mostly not conversation: session_meta, turn_context, world_state,
  //   token_count, and a `reasoning` item carrying an encrypted blob. Rendering them spends the
  //   window on the one part of the session that is not being thrown away — and the encrypted
  //   reasoning payload is a base64 wall that would fill 200 KB on its own.
  assert.doesNotMatch(body, /session_meta|turn_context|world_state|token_count/,
    'rollout machinery was rendered into the snapshot.');
  assert.doesNotMatch(body, /gAAAA/,
    'the encrypted reasoning blob was rendered. It carries no readable content and would fill '
    + 'the whole window.');
});

test('a Claude Code transcript still reads correctly', async (t) => {
  const path = join(tempDir('cc-transcript-'), 'transcript.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'cc-user-marker' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'cc-assistant-marker' }] } }),
  ].join('\n') + '\n');

  const server = await fakeMubit();
  t.after(() => server.close());
  await runHook('checkpoint', preCompact({ transcript_path: path }), {
    args: ['--pre'], env: env(makeDataDir(), makeProjectDir({ git: true }), server.url),
  });
  const body = JSON.stringify(server.lastCall('POST', '/v2/control/checkpoint')?.body ?? {});
  // § The sniff is per line, not per file, and it has to leave the existing shape alone. The
  //   1067-test Claude Code suite is the real net for this; the assertion is here because this
  //   is the file that introduced the branch — and because a Codex session and a Claude Code
  //   session share a data directory, so one run really can hold both kinds of checkpoint.
  assert.match(body, /user: cc-user-marker/, 'the Claude Code envelope stopped rendering.');
  assert.match(body, /assistant: cc-assistant-marker/, 'the Claude Code envelope stopped rendering.');
});

// ===========================================================================
// Redaction and bounds
// ===========================================================================

test('a secret in the rollout never reaches the wire', async (t) => {
  const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
  const { server } = await checkpoint(t, [
    { role: 'user', text: `deploy with OPENAI_API_KEY=${key}` },
    { role: 'assistant', text: 'done' },
  ]);
  const raw = server.lastCall('POST', '/v2/control/checkpoint')?.raw ?? '';
  // § The transcript is the densest secret surface the plugin ever touches (§4.4), and a
  //   rollout is no different — Codex records the same shell commands. Every stage of the
  //   snapshot is individually caught, and a stage that fails yields no snapshot at all: an
  //   unredacted transcript is not an acceptable degraded mode.
  assert.ok(!raw.includes(key),
    'an API key from the rollout reached the wire. Nothing about the Codex envelope may skip '
    + 'the scrub — the redaction runs after the tail is picked and before it is capped.');
});

test('the snapshot is a tail, and it is bounded', async (t) => {
  const filler = 'x'.repeat(2_000);
  const messages = [];
  for (let i = 0; i < 200; i++) messages.push({ role: 'user', text: `msg-${i} ${filler}` });
  messages.push({ role: 'assistant', text: 'LAST-MESSAGE-MARKER' });

  const { server } = await checkpoint(t, messages);
  const body = JSON.stringify(server.lastCall('POST', '/v2/control/checkpoint')?.body ?? {});
  // § Backwards is what makes it a tail. A forward walk with a cap yields the beginning of the
  //   session, which is the half compaction is least likely to throw away.
  assert.match(body, /LAST-MESSAGE-MARKER/, 'the newest message is missing — this is not a tail.');
  assert.doesNotMatch(body, /msg-0 /, 'the oldest message survived a 400 KB transcript with a 200 KB window.');
  assert.ok(body.length < 400_000,
    `the snapshot is ${body.length} bytes. The window is 200 KB, and PreCompact is a hook the `
    + 'user is waiting on.');
});

// ===========================================================================
// Degenerate transcripts
// ===========================================================================

const DEGENERATE = [
  ['an absent file', '/tmp/definitely-not-a-file-8f3a2b.jsonl'],
  ['a directory where a file is expected', '/tmp'],
];

for (const [label, path] of DEGENERATE) {
  test(`${label} costs the checkpoint, not the compaction`, async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const r = await runHook('checkpoint', preCompact({ transcript_path: path }), {
      args: ['--pre'], env: env(makeDataDir(), makeProjectDir({ git: true }), server.url),
    });
    // § The compaction happens whatever this hook does. Exiting non-zero would surface an
    //   error to the user in the middle of it, over a checkpoint they did not ask for.
    assertHookContract(r);
    server.assertNotCalled('POST', '/v2/control/checkpoint');
    assert.match(String(r.json?.systemMessage ?? ''), /\S/,
      'a checkpoint that could not be saved must say so: systemMessage is the only channel '
      + 'PreCompact has under Codex, and losing the context silently is the worse failure.');
  });
}

test('a rollout of nothing but machinery is reported, not invented', async (t) => {
  const path = join(tempDir('codex-rollout-'), 'rollout.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'x' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
  ].join('\n') + '\n');

  const server = await fakeMubit();
  t.after(() => server.close());
  const r = await runHook('checkpoint', preCompact({ transcript_path: path }), {
    args: ['--pre'], env: env(makeDataDir(), makeProjectDir({ git: true }), server.url),
  });
  assertHookContract(r);
  // § "No messages" and "a snapshot of zero messages" have to be different outcomes. Posting
  //   the second tells the user their context was saved when it was not.
  server.assertNotCalled('POST', '/v2/control/checkpoint');
});
