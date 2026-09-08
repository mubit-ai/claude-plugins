// @ts-check
/**
 * The committed `bin/import.mjs` — what the Codex `import` skill actually runs.
 *
 * The reader and the ingest loop are tested in the sibling's `import.test.mjs`, in-process.
 * What that cannot prove is this artifact under this host. The Codex skill says the default
 * is `--source codex`, and `bin/import.src.mjs` picks the default from `host(env)` — which is
 * `claude-code` unless something set `MUBIT_CC_HOST` before `lib/config.mjs` loaded. A
 * shell-run bundle without the boot shim therefore reads `~/.claude/projects` on a Codex
 * machine and says so in its scope line, contradicting the skill that ran it.
 *
 * Fixtures are synthetic on both sides: a Codex rollout in the `item_completed` shape the
 * host writes today, and a Claude Code transcript in the two-line `tool_use`/`tool_result`
 * shape. The roots are handed over by environment variable, so the developer's own history
 * is never read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fakeMubit, makeDataDir, makeProjectDir } from './helpers/codex-fixtures.mjs';
import { assertInertOnImport, cliEnv, runBundle } from './helpers/codex-cli.mjs';

const RUN_ID = 'codex-import-run';
const jsonl = (records) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;

// ---------------------------------------------------------------------------
// Two synthetic histories
// ---------------------------------------------------------------------------

/**
 * A Codex rollout in the shape the host writes since 0.149: `session_meta`, a `turn_context`
 * carrying the cwd, and one `item_completed` per tool call.
 */
function codexRoot(projectDir, o = {}) {
  const root = join(makeDataDir(), 'sessions');
  const day = join(root, '2026', '09', '07');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, 'rollout-2026-09-07T12-00-00-thread-a.jsonl'), jsonl([
    { type: 'session_meta', payload: { id: 'thread-a', cwd: projectDir, cli_version: '0.153.4', thread_source: o.threadSource ?? 'user' } },
    { type: 'turn_context', payload: { turn_id: 't1', cwd: projectDir } },
    { type: 'event_msg', payload: { type: 'item_completed', item: {
      type: 'CommandExecution', id: 'exec-1', command: ['/bin/zsh', '-lc', 'pwd'], status: 'completed',
      aggregated_output: projectDir, exit_code: 0, duration: { secs: 0, nanos: 1 },
    } } },
    ...(o.extra ?? []),
  ]));
  return root;
}

/** A Claude Code transcript: the call on an `assistant` line, the result on a `user` line. */
function claudeCodeRoot(projectDir) {
  const root = join(makeDataDir(), 'projects');
  const dir = join(root, projectDir.replace(/[/._]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const session = '7a3088f2-e5c4-4308-b17f-863fd7889341';
  writeFileSync(join(dir, `${session}.jsonl`), jsonl([
    { type: 'assistant', uuid: 'u-1', cwd: projectDir, sessionId: session, timestamp: '2026-08-20T10:00:00Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01A', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', uuid: 'r-1', cwd: projectDir, sessionId: session, timestamp: '2026-08-20T10:00:01Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01A', content: 'README.md', is_error: false }] } },
  ]));
  return root;
}

/**
 * A fake instance, a git project, both roots, and an env that names them — with the run
 * pinned static so the derivation never shells out.
 */
async function harness(t, o = {}) {
  const server = await fakeMubit();
  t.after(() => server.close());
  const projectDir = makeProjectDir({ git: true });
  const dataDir = makeDataDir();
  const env = cliEnv({
    dataDir,
    endpoint: server.url,
    extra: {
      MUBIT_CC_TRANSCRIPT_ROOT: o.ccRoot ?? claudeCodeRoot(projectDir),
      MUBIT_CC_CODEX_SESSIONS_ROOT: o.codexRoot ?? codexRoot(projectDir, o),
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: RUN_ID,
    },
  });
  const run = async (args) => {
    const r = await runBundle('import', ['--project', projectDir, '--pace', '0', ...args], env, { cwd: projectDir });
    return r;
  };
  return { server, projectDir, dataDir, env, run };
}

test('the bundle exists and stays inert on import', async () => {
  await assertInertOnImport('import');
});

// ---------------------------------------------------------------------------
// The default source — the reason this suite exists
// ---------------------------------------------------------------------------

test('a dry run with no --source reads the Codex rollouts, and says so', async (t) => {
  const { server, run } = await harness(t);

  const r = await run(['--json']);
  assert.equal(r.code, 0, r.err);
  const report = JSON.parse(r.out);
  // § The skill text promises `--source codex` is the default on this host. The default is
  //   `host(env)`, and with no shim in the bundle that is `claude-code`: the command reads a
  //   directory the skill never mentioned and reports a count for the wrong history.
  assert.deepEqual(Object.keys(report.sources), ['codex'],
    'with no --source the bundle must read its own host`s history. The skill that ran it '
    + 'cannot set MUBIT_CC_HOST, so the bundle has to know.');
  assert.equal(report.sources.codex.items, 1);
  assert.equal(server.requests.length, 0, `a dry run must dial nothing; saw ${server.summary()}`);
});

test('--help exits 0, names the default source as the host`s, and dials nothing', async (t) => {
  const { server, run } = await harness(t);
  const r = await run(['--help']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /--source <which>/);
  assert.match(r.out, /--send/);
  assert.equal(server.requests.length, 0);
});

test('--send: every item is tagged tool:codex, carries the live item id, and says it was imported', async (t) => {
  const { server, run } = await harness(t);
  const r = await run(['--send', '--json']);
  assert.equal(r.code, 0, r.err);
  const report = JSON.parse(r.out);
  assert.equal(report.dryRun, false);
  assert.equal(report.failed, 0);
  assert.equal(report.sources.codex.items, 1);

  const calls = server.calls('POST', '/v2/control/ingest');
  assert.ok(calls.length >= 1, `nothing was ingested; saw ${server.summary()}`);
  for (const c of calls) {
    assert.equal(c.body.run_id, RUN_ID);
    assert.match(String(c.body.idempotency_key), /^cc-import-[0-9a-f]{16}$/);
  }
  const items = calls.flatMap((c) => c.body.items);
  // § `envTags` leads with `tool:<host>`: the two histories stay tellable apart once stored,
  //   which is the whole reason a Codex item can be imported beside a Claude Code one.
  for (const i of items) {
    assert.equal(i.env_tags[0], 'tool:codex', `${i.item_id}: [${i.env_tags.join(', ')}]`);
    assert.equal(JSON.parse(i.metadata_json).imported, true, `${i.item_id} does not say it was imported`);
  }
  // § The id is what live capture would have minted for the same call — `cc-<item id>` —
  //   so the import and the live path address the same entry.
  assert.ok(items.some((i) => i.item_id === 'cc-exec-1'), items.map((i) => i.item_id).join(', '));
});

test('a second --send over unchanged rollouts sends nothing', async (t) => {
  const { server, run } = await harness(t);
  assert.equal((await run(['--send', '--json'])).code, 0);
  assert.ok(server.countOf('POST', '/v2/control/ingest') >= 1);
  server.reset();
  const again = await run(['--send', '--json']);
  assert.equal(again.code, 0, again.err);
  // § The cursor under `import/` in the data dir is the claim; the server collapsing two
  //   sends of one id is a separate claim nothing here can observe, and the skill says so.
  assert.equal(JSON.parse(again.out).items, 0);
  assert.equal(server.requests.length, 0, `a re-run dialled: ${server.summary()}`);
});

test('--source claude-code reads the transcript root and tags tool:claude-code; --source all reads both', async (t) => {
  const { server, run } = await harness(t);
  const cc = await run(['--source', 'claude-code', '--send', '--json']);
  assert.equal(cc.code, 0, cc.err);
  assert.deepEqual(Object.keys(JSON.parse(cc.out).sources), ['claude-code']);
  const items = server.calls('POST', '/v2/control/ingest').flatMap((c) => c.body.items);
  assert.ok(items.length >= 1);
  for (const i of items) {
    assert.equal(i.env_tags[0], 'tool:claude-code', 'a Claude Code transcript is Claude Code`s even when this plugin reads it');
    assert.ok(!i.env_tags.includes('tool:codex'), i.item_id);
  }

  const both = await run(['--source', 'all', '--json']);
  assert.equal(both.code, 0, both.err);
  const report = JSON.parse(both.out);
  assert.deepEqual(Object.keys(report.sources), ['claude-code', 'codex']);
  assert.equal(report.sources.codex.items, 1, 'the codex side is still unsent, so a dry run still counts it');
});

test('the injected preamble never becomes a prompt', async (t) => {
  const { server, run } = await harness(t, {
    extra: [
      // 0.149+: the first user record is the plugin listing in the user's voice; the prompt
      // the person typed is the record after it.
      { type: 'response_item', payload: { type: 'message', id: 'msg_1', role: 'user',
        content: [{ type: 'input_text', text: '<recommended_plugins>\n- something\n</recommended_plugins>' }] } },
      { type: 'response_item', payload: { type: 'message', id: 'msg_2', role: 'user',
        content: [{ type: 'input_text', text: 'what does the drain do on a 500?' }] } },
      { type: 'response_item', payload: { type: 'message', id: 'msg_3', role: 'assistant',
        content: [{ type: 'output_text', text: 'It leaves the spool in place and stops.' }] } },
    ],
  });
  const r = await run(['--send', '--json']);
  assert.equal(r.code, 0, r.err);
  const items = server.calls('POST', '/v2/control/ingest').flatMap((c) => c.body.items);
  const turn = items.find((i) => String(i.text ?? '').startsWith('Q:'));
  assert.ok(turn, `no turn was imported; items: ${items.map((i) => i.item_id).join(', ')}`);
  assert.match(String(turn.text), /what does the drain do on a 500\?/);
  for (const i of items) {
    assert.ok(!String(i.text ?? '').includes('recommended_plugins'),
      `the injected preamble was imported as a prompt: ${i.item_id}`);
  }
});

test('the approval reviewer\'s thread contributes nothing, even under --all', async (t) => {
  const { server, run, env } = await harness(t);
  const day = join(env.MUBIT_CC_CODEX_SESSIONS_ROOT, '2026', '09', '08');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, 'rollout-2026-09-08T09-00-00-reviewer.jsonl'), jsonl([
    { type: 'session_meta', payload: { id: 'reviewer', cwd: '/tmp/codex/proj', cli_version: '0.153.4', thread_source: 'guardian_review' } },
    { type: 'turn_context', payload: { turn_id: 't1', cwd: '/tmp/codex/proj' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: {
      type: 'CommandExecution', id: 'exec-reviewer', command: ['/bin/zsh', '-lc', 'cat /etc/hosts'], status: 'completed',
      aggregated_output: '127.0.0.1 localhost', exit_code: 0, duration: { secs: 0, nanos: 1 },
    } } },
  ]));
  const r = await run(['--send', '--all', '--json']);
  assert.equal(r.code, 0, r.err);
  const items = server.calls('POST', '/v2/control/ingest').flatMap((c) => c.body.items);
  // § `--all`, so scope cannot be what excluded it: the reviewer's thread is skipped for what
  //   it is, not where it ran. Its prompts are other threads' transcripts, and importing them
  //   would file every reviewed session twice under a reviewer's words.
  assert.ok(!items.some((i) => i.item_id === 'cc-exec-reviewer'),
    'the approval reviewer\'s thread was imported as the user\'s own history');
  assert.ok(items.some((i) => i.item_id === 'cc-exec-1'), 'the real thread still was');
});
