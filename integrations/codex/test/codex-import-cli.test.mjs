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
