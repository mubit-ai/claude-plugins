// @ts-check
/**
 * `lib/codex-import.mjs` — the Codex source for the transcript backfill.
 *
 * ---------------------------------------------------------------------------
 * What has to be true
 * ---------------------------------------------------------------------------
 * 1. **The host's own words are not prompts.** From 0.149 the first `user` record of a thread
 *    is `<recommended_plugins>` and `<environment_context>`; importing it would file a plugin
 *    listing as the question every thread opened with.
 * 2. **A rollout says most things twice, and each is read once.** `event_msg/user_message`,
 *    `agent_message`, and the `UserMessage`/`AgentMessage` items are copies of the
 *    `response_item` messages; the `exec` script call is a copy of the commands it ran.
 * 3. **Both shapes yield the same items.** A 0.146 `function_call` pair and a 0.153
 *    `CommandExecution` item describe the same call, and the item they become has the same
 *    tool name, outcome and metadata keys. Only the id differs, and it differs on purpose.
 * 4. **A `.env` reached through a `FileChange` is dropped whole**, because that item names its
 *    paths with no patch body for the marker parser to see.
 *
 * Every fixture here is synthetic, built to the shapes counted in the module header. None is
 * copied from a real `~/.codex/sessions`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { baseEnv, fakeMubit, lib, makeDataDir, makeProjectDir, readJsonDir } from './helpers/harness.mjs';

let _mod;
const C = async () => (_mod ??= await lib('codex-import.mjs'));

const THREAD = '01a07bb6-9c25-73d3-a2f3-cd24dd5b3e5b';
const PARENT = '01a024f2-cb68-77b2-a34e-2dc31c7a4fc4';

// ---------------------------------------------------------------------------
// A rollout, built the way the host writes one
// ---------------------------------------------------------------------------

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** `session_meta`: the first line of every rollout. */
const meta = (o = {}) => ({
  timestamp: '2026-09-07T12:00:00.000Z',
  type: 'session_meta',
  payload: {
    session_id: o.parent ?? o.id ?? THREAD,
    id: o.id ?? THREAD,
    ...(o.parent ? { parent_thread_id: o.parent } : {}),
    timestamp: '2026-09-07T12:00:00.000Z',
    cwd: o.cwd ?? '/r/app',
    originator: 'codex-tui',
    cli_version: o.version ?? '0.153.4',
    source: o.source ?? 'cli',
    thread_source: o.threadSource ?? 'user',
    model_provider: 'openai',
  },
});

const turnContext = (cwd, turnId = 't1') => ({ type: 'turn_context', payload: { turn_id: turnId, cwd, model: 'x' } });

/** A `user` record with one `input_text` block per argument. */
const user = (...texts) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: texts.map((text) => ({ type: 'input_text', text })) },
});

const assistant = (text, phase = 'final_answer') => ({
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] },
});

const developer = (text) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] },
});

/** The UI's copies, which must never become items. */
const userEvent = (message) => ({ type: 'event_msg', payload: { type: 'user_message', message } });
const agentEvent = (message) => ({ type: 'event_msg', payload: { type: 'agent_message', message, phase: 'final_answer' } });

const completed = (item) => ({
  type: 'event_msg',
  payload: { type: 'item_completed', thread_id: THREAD, turn_id: 't1', item, started_at_ms: 1, completed_at_ms: 2 },
});

const commandItem = ({ id, cmd, out = '', exit = 0, status }) => ({
  type: 'CommandExecution', id, process_id: 'p1', command: ['/bin/zsh', '-lc', cmd], cwd: '/r/app',
  parsed_cmd: [{ type: 'unknown', cmd }], source: 'agent',
  status: status ?? (exit === 0 ? 'completed' : 'failed'),
  stdout: out, stderr: '', aggregated_output: out, exit_code: exit, duration: { secs: 0, nanos: 1000 },
});

const fileChangeItem = ({ id, changes, status = 'completed' }) => ({
  type: 'FileChange', id, changes, status,
  stdout: `Success. Updated the following files:\n${Object.keys(changes).map((p) => `M ${p}`).join('\n')}\n`,
  stderr: '',
});

const mcpItem = ({ id, server, tool, args = {}, result, error }) => ({
  type: 'McpToolCall', id, server, tool, arguments: args,
  status: error ? 'failed' : 'completed',
  ...(error ? { error } : { result: result ?? { content: [{ type: 'text', text: 'ok' }] } }),
  duration: { secs: 0, nanos: 1 },
});

/** The 0.149+ script the model writes to drive its commands — a copy, never an item. */
const execScript = (callId, script) => ({
  type: 'response_item',
  payload: { type: 'custom_tool_call', status: 'completed', call_id: callId, name: 'exec', input: script },
});
const execScriptOut = (callId) => ({
  type: 'response_item',
  payload: { type: 'custom_tool_call_output', call_id: callId, output: [{ type: 'input_text', text: 'Script completed\n' }] },
});

// --- the pre-0.149 shape ------------------------------------------------------

const fnCall = (callId, name, args) => ({
  type: 'response_item', payload: { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId },
});
const fnOut = (callId, output) => ({
  type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output },
});
const customCall = (callId, name, input) => ({
  type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: callId, name, input },
});
const customOut = (callId, output) => ({
  type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output },
});
const patchEnd = (callId, changes, success = true) => ({
  type: 'event_msg',
  payload: { type: 'patch_apply_end', call_id: callId, turn_id: 't1', stdout: '', stderr: '', success, changes, status: success ? 'completed' : 'failed' },
});

const PREAMBLE = [
  '<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n</recommended_plugins>',
  '<environment_context>\n  <cwd>/r/app</cwd>\n  <shell>zsh</shell>\n</environment_context>',
];

const patch = (...body) => ['*** Begin Patch', ...body, '*** End Patch'].join('\n');

/**
 * A fake `~/.codex/sessions`: `{'2026/09/07/rollout-…jsonl': records}`.
 * @param {Record<string, any[]>} files
 */
function sessionsRoot(files) {
  const root = join(makeDataDir(), 'sessions');
  for (const [rel, records] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, jsonl(records));
  }
  return root;
}

const FILE = '2026/09/07/rollout-2026-09-07T12-00-00-01a07bb6-9c25-73d3-a2f3-cd24dd5b3e5b.jsonl';

async function setup(o = {}) {
  const dataDir = makeDataDir();
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(baseEnv({
    dataDir,
    endpoint: o.endpoint,
    projectDir: o.projectDir,
    extra: {
      ...(o.perDirectory ? {} : { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: 'cc-codex-import-test' }),
      ...(o.extra ?? {}),
    },
  }));
  return { dataDir, cfg };
}

const metaOf = (i) => JSON.parse(i.item.metadata_json);
const tools = (r) => r.items.filter((i) => metaOf(i).tool);
const turns = (r) => r.items.filter((i) => metaOf(i).hook_event === 'Stop');

// ---------------------------------------------------------------------------
// Where the rollouts are
// ---------------------------------------------------------------------------

describe('discovery', () => {
  it('rolloutRoot honours the override, then CODEX_HOME, then the home directory', async () => {
    const { rolloutRoot, CODEX_SESSIONS_ROOT_ENV } = await C();
    assert.equal(rolloutRoot({ [CODEX_SESSIONS_ROOT_ENV]: '/x/sessions', CODEX_HOME: '/y' }), '/x/sessions');
    assert.equal(rolloutRoot({ CODEX_HOME: '/y' }), join('/y', 'sessions'));
    assert.match(rolloutRoot({}), /\.codex[/\\]sessions$/);
  });

  it('walks the date tree and lists only rollouts, oldest first', async () => {
    const { discoverRollouts } = await C();
    const root = sessionsRoot({
      '2026/09/07/rollout-2026-09-07T12-00-00-b.jsonl': [meta()],
      '2026/08/21/rollout-2026-08-21T10-00-00-a.jsonl': [meta()],
      '2026/09/07/notes.txt': [],
      '2026/09/07/other-2026-09-07T12-00-00-c.jsonl': [],
    });
    const found = discoverRollouts({ root });
    assert.deepEqual(found.files.map((f) => f.dirName), ['2026/08/21', '2026/09/07']);
    assert.ok(found.files.every((f) => f.path.endsWith('.jsonl') && f.path.includes('rollout-')));
  });

  it('reports the file cap rather than applying it silently', async () => {
    const { discoverRollouts } = await C();
    const root = sessionsRoot({
      '2026/09/07/rollout-1.jsonl': [meta()],
      '2026/09/07/rollout-2.jsonl': [meta()],
      '2026/09/07/rollout-3.jsonl': [meta()],
    });
    const found = discoverRollouts({ root, maxFiles: 2 });
    assert.equal(found.files.length, 2);
    assert.match(found.truncatedReason, /more remain/);
  });
});

// ---------------------------------------------------------------------------
// 0.149 and later
// ---------------------------------------------------------------------------

describe('a 0.153 rollout', () => {
  async function read(records, o = {}) {
    const { rolloutItems } = await C();
    const { cfg } = await setup(o);
    const root = sessionsRoot({ [FILE]: records });
    return rolloutItems(cfg, join(root, FILE), { roots: o.roots ?? ['/r/app'], projectDir: '/r/app' });
  }

  it('skips the host\'s preamble and pairs the real prompt with the answer', async () => {
    const r = await read([
      meta(), developer('<app-context># Codex desktop</app-context>'),
      turnContext('/r/app'),
      user(...PREAMBLE),
      user('why does the drain stop on a 500?'),
      userEvent('why does the drain stop on a 500?'),
      completed({ type: 'UserMessage', id: 'um1', content: [{ type: 'text', text: 'why does the drain stop on a 500?' }] }),
      assistant('Let me look.', 'commentary'),
      assistant('It leaves the spool in place and stops.'),
      agentEvent('It leaves the spool in place and stops.'),
      completed({ type: 'AgentMessage', id: 'am1', content: [{ type: 'text', text: 'It leaves the spool in place and stops.' }], phase: 'final_answer' }),
    ]);
    const t = turns(r);
    assert.equal(t.length, 1, 'one prompt, one turn — the copies must not become turns');
    assert.match(t[0].item.text, /^Q: why does the drain stop on a 500\?\n\nA: Let me look\.\nIt leaves the spool/);
    assert.ok(!t[0].item.text.includes('recommended_plugins'), 'the preamble is not a prompt');
    assert.equal(t[0].item.env_tags[0], 'tool:codex');
    assert.equal(metaOf(t[0]).imported, true);
    assert.equal(metaOf(t[0]).session_id, THREAD);
  });

  it('turns a CommandExecution into the same item the live hook writes, outcome included', async () => {
    const r = await read([
      meta(), turnContext('/r/app'),
      user('run the tests'),
      execScript('call_1', 'await tools.exec_command({cmd: "npm test"})'),
      completed(commandItem({ id: 'exec-9b75f4a1', cmd: 'npm test', out: 'FAIL 1 test\n', exit: 1 })),
      execScriptOut('call_1'),
      assistant('One test fails.'),
    ]);
    const t = tools(r);
    assert.equal(t.length, 1, 'the exec script is a copy of the commands it ran, not a call of its own');
    const [i] = t;
    assert.equal(i.item.item_id, 'cc-exec-9b75f4a1', 'the item id is the host\'s own, as `capture` writes it');
    assert.equal(metaOf(i).tool, 'Bash', 'the shell is named as the Codex hook payload names it');
    assert.match(i.item.text, /^Bash\(command=npm test\) FAILED: FAIL 1 test/);
    assert.equal(metaOf(i).outcome, 'failure');
    assert.equal(metaOf(i).exit_code, 1);
    assert.equal(metaOf(i).hook_event, 'PostToolUseFailure');
    assert.equal(i.item.env_tags[0], 'tool:codex');
    assert.equal(i.runId, 'cc-codex-import-test');
  });

  it('a FileChange carries its kinds, delete included, with no patch body to parse', async () => {
    const r = await read([
      meta(), turnContext('/r/app'), user('remove the old notes'),
      completed(fileChangeItem({
        id: 'fc-1',
        changes: { '/r/app/OLD.md': { type: 'delete', content: '# old' }, '/r/app/NEW.md': { type: 'add', content: '# new' } },
      })),
    ]);
    const [i] = tools(r);
    assert.equal(metaOf(i).tool, 'apply_patch');
    assert.deepEqual(metaOf(i).files, [
      { path: '/r/app/OLD.md', kind: 'delete' }, { path: '/r/app/NEW.md', kind: 'add' },
    ]);
    assert.ok(!i.item.text.includes('# old'), 'the content under a change is the whole file and is not read');
  });

  it('an McpToolCall is named as the hook names it, and the plugin\'s own calls are dropped', async () => {
    const r = await read([
      meta(), turnContext('/r/app'), user('look it up'),
      completed(mcpItem({ id: 'mcp-1', server: 'mubit', tool: 'mubit_recall', args: { query: 'x' } })),
      completed(mcpItem({ id: 'mcp-2', server: 'linear', tool: 'list_issues', args: { team: 'ENG' } })),
      completed(mcpItem({ id: 'mcp-3', server: 'linear', tool: 'create_issue', args: {}, error: { message: 'forbidden' } })),
    ]);
    const t = tools(r);
    assert.deepEqual(t.map((i) => metaOf(i).tool), ['mcp__linear__list_issues', 'mcp__linear__create_issue'],
      'memory does not record itself recalling');
    assert.equal(metaOf(t[1]).outcome, 'failure');
    assert.match(t[1].item.text, /FAILED:.*forbidden/);
  });

  it('drops a FileChange to a denylisted path whole, and counts it', async () => {
    const projectDir = makeProjectDir({ git: true, files: { '.env': 'OPENAI_API_KEY=sk-live-nope\n' } });
    const r = await read([
      meta({ cwd: projectDir }), turnContext(projectDir), user('set the key'),
      completed(fileChangeItem({ id: 'fc-env', changes: { [join(projectDir, '.env')]: { type: 'update', content: 'OPENAI_API_KEY=sk-live-nope' } } })),
      completed(commandItem({ id: 'exec-ok', cmd: 'ls', out: 'README.md\n' })),
    ], { roots: [projectDir] });
    assert.equal(r.denied, 1);
    assert.deepEqual(tools(r).map((i) => metaOf(i).tool), ['Bash'], 'the ordinary call beside it is kept');
    assert.ok(!JSON.stringify(r.items).includes('sk-live-nope'));
  });

  it('follows cwd per turn, not per file', async () => {
    const r = await read([
      meta({ cwd: '/r/app' }), turnContext('/r/app', 't1'), user('one'),
      completed(commandItem({ id: 'exec-1', cmd: 'ls', out: 'a' })),
      turnContext('/r/app/packages/web', 't2'), user('two'),
      completed(commandItem({ id: 'exec-2', cmd: 'ls', out: 'b' })),
      turnContext('/elsewhere', 't3'), user('three'),
      completed(commandItem({ id: 'exec-3', cmd: 'ls', out: 'c' })),
    ]);
    assert.deepEqual(tools(r).map((i) => i.cwd), ['/r/app', '/r/app/packages/web'],
      'the third turn ran outside the scope and is skipped');
  });
});

// ---------------------------------------------------------------------------
// Before 0.149
// ---------------------------------------------------------------------------

describe('a 0.146 rollout', () => {
  async function read(records) {
    const { rolloutItems } = await C();
    const { cfg } = await setup();
    const root = sessionsRoot({ [FILE]: records });
    return rolloutItems(cfg, join(root, FILE), { roots: ['/r/app'], projectDir: '/r/app' });
  }

  it('joins a function_call to its output by call_id and reads the exit code out of the text', async () => {
    const r = await read([
      meta({ version: '0.146.0' }), turnContext('/r/app'),
      user('run the tests'), userEvent('run the tests'),
      fnCall('call_A', 'exec_command', { cmd: 'npm test', workdir: '/r/app' }),
      fnOut('call_A', 'Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code 2\nOutput:\nFAIL\n'),
      assistant('Two failures.'), agentEvent('Two failures.'),
    ]);
    assert.equal(turns(r).length, 1, 'the user_message event is a copy of the prompt');
    const [i] = tools(r);
    assert.equal(i.item.item_id, 'cc-call_A', 'no item existed on this shape; the join key is the id');
    assert.equal(metaOf(i).tool, 'Bash');
    assert.match(i.item.text, /^Bash\(command=npm test\) FAILED:/);
    assert.equal(metaOf(i).exit_code, 2);
    assert.equal(metaOf(i).outcome, 'failure');
  });

  it('takes a patch\'s kinds from patch_apply_end and its outcome from the output', async () => {
    const r = await read([
      meta({ version: '0.146.0' }), turnContext('/r/app'), user('rename it'),
      customCall('call_P', 'apply_patch', patch('*** Update File: src/lib.rs', '@@', '-a', '+b', '*** Delete File: old.txt')),
      patchEnd('call_P', { '/r/app/src/lib.rs': { type: 'update', content: 'b' }, '/r/app/old.txt': { type: 'delete', content: 'x' } }),
      customOut('call_P', 'Exit code: 0\nWall time: 0.9 seconds\nOutput:\nSuccess. Updated the following files:\nM src/lib.rs\nD old.txt\n'),
    ]);
    const [i] = tools(r);
    assert.equal(metaOf(i).tool, 'apply_patch');
    assert.deepEqual(metaOf(i).files, [
      { path: '/r/app/src/lib.rs', kind: 'update' }, { path: '/r/app/old.txt', kind: 'delete' },
    ], 'patch_apply_end states the kinds with absolute paths, which the markers do not');
    assert.equal(metaOf(i).outcome, 'ok');
    assert.equal(metaOf(i).exit_code, 0);
  });

  it('falls back to the markers when no patch_apply_end arrived', async () => {
    const r = await read([
      meta({ version: '0.146.0' }), turnContext('/r/app'), user('add notes'),
      customCall('call_Q', 'apply_patch', patch('*** Add File: NOTES.md', '+note')),
      customOut('call_Q', 'Exit code: 0\nOutput:\nSuccess.\n'),
    ]);
    assert.deepEqual(metaOf(tools(r)[0]).files, [{ path: 'NOTES.md', kind: 'add' }]);
  });

  it('drops a call whose output never came, and an output whose call it never saw', async () => {
    const r = await read([
      meta({ version: '0.146.0' }), turnContext('/r/app'), user('x'),
      fnCall('call_lost', 'exec_command', { cmd: 'ls' }),
      fnOut('call_orphan', 'Process exited with code 0\n'),
    ]);
    assert.equal(tools(r).length, 0);
    assert.ok(r.skipped >= 2);
  });

  it('does not read function_call pairs on a thread that has items — the exec script would double every command', async () => {
    const r = await read([
      meta({ version: '0.153.4' }), turnContext('/r/app'), user('x'),
      execScript('call_1', 'await tools.exec_command({cmd: "ls"})'),
      completed(commandItem({ id: 'exec-1', cmd: 'ls', out: 'a' })),
      execScriptOut('call_1'),
    ]);
    assert.deepEqual(tools(r).map((i) => i.item.item_id), ['cc-exec-1']);
  });
});

// ---------------------------------------------------------------------------
// Threads that are not the user's
// ---------------------------------------------------------------------------

describe('threads', () => {
  it('a subagent thread is filed under its parent session and the parent\'s run', async () => {
    const { rolloutItems } = await C();
    const projectDir = makeProjectDir({ git: true });
    const { cfg } = await setup({ projectDir, perDirectory: true });
    const parentFile = '2026/09/07/rollout-2026-09-07T12-00-00-parent.jsonl';
    const subFile = '2026/09/07/rollout-2026-09-07T12-00-01-sub.jsonl';
    const root = sessionsRoot({
      [parentFile]: [
        meta({ id: PARENT, cwd: projectDir }), turnContext(projectDir), user('fan out'),
        completed(commandItem({ id: 'exec-parent', cmd: 'ls', out: 'a' })),
      ],
      [subFile]: [
        meta({ id: THREAD, parent: PARENT, cwd: projectDir, threadSource: 'subagent', source: { subagent: { other: 'explorer' } } }),
        turnContext(projectDir), user(...PREAMBLE), user('Find the call sites.'),
        completed(commandItem({ id: 'exec-sub', cmd: 'grep -rn drain', out: 'lib/drain.mjs:1' })),
        assistant('Three call sites.'),
      ],
    });
    const parent = rolloutItems(cfg, join(root, parentFile), { roots: [projectDir], projectDir });
    const sub = rolloutItems(cfg, join(root, subFile), { roots: [projectDir], projectDir });
    assert.equal(sub.items.length, 2, 'the tool call and the turn');
    assert.ok(sub.items.every((i) => metaOf(i).session_id === PARENT), 'filed under the parent session');
    assert.ok(sub.items.every((i) => i.runId === parent.items[0].runId), 'and under the parent\'s run');
    assert.match(turns(sub)[0].item.text, /^Q: Find the call sites\./);
  });

  it('a reviewer\'s thread contributes nothing and is read to its end', async () => {
    const { rolloutItems } = await C();
    const { cfg } = await setup();
    const records = [
      meta({ threadSource: 'guardian_review', source: { subagent: { other: 'guardian' } } }),
      turnContext('/r/app'),
      user('>>> TRANSCRIPT START\n[1] user: hi\n>>> TRANSCRIPT END\nAssess the exact planned action below.'),
      completed(commandItem({ id: 'exec-review', cmd: 'cat x', out: 'y' })),
      assistant('{"outcome":"allow"}'),
    ];
    for (const m of [records[0], meta({ version: '0.149.0', threadSource: 'subagent', source: { subagent: { other: 'guardian' } } })]) {
      const root = sessionsRoot({ [FILE]: [m, ...records.slice(1)] });
      const p = join(root, FILE);
      const r = rolloutItems(cfg, p, { roots: ['/r/app'], projectDir: '/r/app' });
      assert.equal(r.items.length, 0, `a reviewer's transcript is another thread's, twice: ${m.payload.thread_source}`);
      assert.equal(r.offset, statSync(p).size, 'the cursor lands at EOF so the file is never reopened');
    }
  });

  it('a resumed read recovers session_meta, so a grown legacy thread is still read as legacy', async () => {
    const { rolloutItems } = await C();
    const { cfg } = await setup();
    const root = sessionsRoot({ [FILE]: [
      meta({ version: '0.146.0' }), turnContext('/r/app'), user('one'),
      fnCall('call_1', 'exec_command', { cmd: 'ls' }), fnOut('call_1', 'Process exited with code 0\nOutput:\na\n'),
    ] });
    const p = join(root, FILE);
    const first = rolloutItems(cfg, p, { roots: ['/r/app'], projectDir: '/r/app' });
    assert.equal(tools(first).length, 1);

    appendFileSync(p, jsonl([
      fnCall('call_2', 'exec_command', { cmd: 'pwd' }), fnOut('call_2', 'Process exited with code 0\nOutput:\n/r/app\n'),
    ]));
    const second = rolloutItems(cfg, p, { from: first.offset, roots: ['/r/app'], projectDir: '/r/app' });
    assert.deepEqual(tools(second).map((i) => i.item.item_id), ['cc-call_2'],
      'without re-reading line one the version is unknown and the pair would be ignored as a modern thread\'s script');
    assert.equal(metaOf(tools(second)[0]).session_id, THREAD);
  });
});

// ---------------------------------------------------------------------------
// Through runImport
// ---------------------------------------------------------------------------

describe('as a source of runImport', () => {
  const corpus = (projectDir) => ({
    [FILE]: [
      meta({ cwd: projectDir }), turnContext(projectDir), user(...PREAMBLE), user('what changed?'),
      completed(commandItem({ id: 'exec-1', cmd: 'git status', out: 'clean' })),
      assistant('Nothing.'),
    ],
  });

  it('sends Codex items under tool:codex with an import idempotency key, and re-runs are no-ops', async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const projectDir = makeProjectDir({ git: true });
    const { cfg, dataDir } = await setup({ projectDir, endpoint: server.url });
    const { codexSource } = await C();
    const { runImport } = await lib('import.mjs');
    const root = sessionsRoot(corpus(projectDir));

    const r = await runImport(cfg, { roots: [projectDir], sources: [codexSource], sourceRoots: { codex: root }, paceMs: 0 });
    assert.equal(r.failed, 0);
    assert.equal(r.items, 2);
    assert.deepEqual(Object.keys(r.sources), ['codex']);
    assert.equal(r.sources.codex.items, 2);
    assert.equal(r.sources.codex.root, root);

    const body = server.lastCall('POST', '/v2/control/ingest').body;
    assert.match(String(body.idempotency_key), /^cc-import-[0-9a-f]{16}$/);
    assert.ok(body.items.every((i) => i.env_tags[0] === 'tool:codex'));
    assert.equal(readJsonDir(join(dataDir, 'import')).length, 1, 'one cursor for the one rollout');

    const again = await runImport(cfg, { roots: [projectDir], sources: [codexSource], sourceRoots: { codex: root }, paceMs: 0 });
    assert.equal(again.files, 0);
    assert.equal(again.items, 0);
  });

  it('walks both sources against one budget and counts each', async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const projectDir = makeProjectDir({ git: true });
    const { cfg } = await setup({ projectDir, endpoint: server.url });
    const { codexSource } = await C();
    const { runImport, claudeCodeSource } = await lib('import.mjs');

    const ccRoot = join(makeDataDir(), 'projects');
    const dir = join(ccRoot, projectDir.replace(/[/._]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${PARENT}.jsonl`), jsonl([
      { type: 'assistant', cwd: projectDir, sessionId: PARENT, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', cwd: projectDir, sessionId: PARENT, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'a' }] } },
    ]));

    const r = await runImport(cfg, {
      roots: [projectDir], sources: [claudeCodeSource, codexSource],
      sourceRoots: { 'claude-code': ccRoot, codex: sessionsRoot(corpus(projectDir)) }, paceMs: 0, dryRun: true,
    });
    assert.deepEqual(Object.keys(r.sources), ['claude-code', 'codex']);
    assert.equal(r.sources['claude-code'].items, 1);
    assert.equal(r.sources.codex.items, 2);
    assert.equal(r.items, 3);
    assert.equal(server.requests.length, 0, 'a dry run dials nothing');
  });
});
