// @ts-check
/**
 * `lib/import.mjs` and `bin/import.src.mjs` — the transcript backfill.
 *
 * ---------------------------------------------------------------------------
 * The three things that have to be true, and which claim is whose
 * ---------------------------------------------------------------------------
 * 1. **A re-run is a no-op.** This is a claim about *this client's* bookkeeping — the cursor —
 *    and it is the one this file can actually verify. It is not the claim that the server
 *    collapses two sends of one id; nothing here can test that, and the skill is written not
 *    to assert it.
 * 2. **A `.env` read through a `tool_result` line is dropped, not scrubbed.** The path is on
 *    the `assistant` line and the body is on the `user` line, so a reader that walked lines
 *    independently would get the secret with no stage-2 protection at all. This is the single
 *    most important assertion in the file.
 * 3. **The breaker file is absent afterwards.** Thousands of calls that can vote would open
 *    the circuit, which then suppresses recall and the capture drain, over a background job.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately NOT asserted
 * ---------------------------------------------------------------------------
 * That an imported item's **text** is byte-identical to a live-captured one's. It is not
 * guaranteed to be: `hooks/src/capture.mjs` owns the live renderer, `lib/` may not import a
 * hook, and the copy in `lib/import.mjs` is faithful rather than shared. What *is* asserted is
 * the **id** — `cc-<tool_use_id>` — which is byte-identical by construction and is the
 * property the whole design rests on, plus the metadata keys a reader joins on.
 */

import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertHookContract, baseEnv, fakeMubit, lib, makeDataDir, makeProjectDir, readJsonDir,
  runHook, spoolFiles,
} from './helpers/harness.mjs';
import * as fx from './helpers/fixtures.mjs';

let _mod;
const I = async () => (_mod ??= await lib('import.mjs'));

const SESSION = '7a3088f2-e5c4-4308-b17f-863fd7889341';

// ---------------------------------------------------------------------------
// A transcript, built the way the host writes one
// ---------------------------------------------------------------------------

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** An `assistant` line carrying a tool call — where a path lives. */
const callLine = (id, name, input, cwd, text = '') => ({
  type: 'assistant', uuid: `u-${id}`, cwd, sessionId: SESSION, timestamp: '2026-08-20T10:00:00Z',
  message: {
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      { type: 'tool_use', id, name, input },
    ],
  },
});

/** A `user` line carrying the result — where the body lives, with no path field on it. */
const resultLine = (id, content, cwd, isError = false) => ({
  type: 'user', uuid: `r-${id}`, cwd, sessionId: SESSION, timestamp: '2026-08-20T10:00:01Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
});

const promptLine = (text, cwd) => ({
  type: 'user', uuid: `p-${text.length}`, cwd, sessionId: SESSION, timestamp: '2026-08-20T09:59:00Z',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

const answerLine = (text, cwd) => ({
  type: 'assistant', uuid: `a-${text.length}`, cwd, sessionId: SESSION, timestamp: '2026-08-20T10:00:02Z',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

/**
 * A fake `~/.claude/projects`, with the host's own lossy directory encoding and its
 * `<session-uuid>/subagents/` layout.
 * @param {Record<string, {records: any[], subagents?: Record<string, any[]>}>} byProject
 */
function transcriptRoot(byProject) {
  const root = join(makeDataDir(), 'projects');
  for (const [projectDir, spec] of Object.entries(byProject)) {
    const dir = join(root, projectDir.replace(/[/._]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SESSION}.jsonl`), jsonl(spec.records));
    for (const [agent, records] of Object.entries(spec.subagents ?? {})) {
      const sub = join(dir, SESSION, 'subagents');
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, `${agent}.jsonl`), jsonl(records));
    }
  }
  return root;
}

async function setup(o = {}) {
  const dataDir = makeDataDir();
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(baseEnv({
    dataDir,
    endpoint: o.endpoint,
    projectDir: o.projectDir,
    extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: 'cc-import-test', ...(o.extra ?? {}) },
  }));
  return { dataDir, cfg };
}

const breakerFiles = (dataDir) => readJsonDir(join(dataDir, 'breaker'));

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('discovery', () => {
  /**
   * The directory name is the host's lossy encoding of a path: `/`, `.` and `_` all become
   * `-`. It is used only to narrow which directories are worth opening, because it cannot be
   * decoded and two paths can encode alike. The `cwd` inside the records decides.
   */
  it('encodes a project directory the way the host does', async () => {
    const { encodeProjectDir } = await I();
    assert.equal(encodeProjectDir('/Users/x/src/app'), '-Users-x-src-app');
    assert.equal(encodeProjectDir('/a/b.c/d_e'), '-a-b-c-d-e', 'dots and underscores collapse too');
  });

  /**
   * Subagent transcripts sit one level down, under `<session-uuid>/subagents/`, and are a
   * large share of the corpus — 710 files against 574 sessions on the machine this was
   * measured on. A `projects/*​/*.jsonl` glob sees none of them, so an importer that used one
   * would report a successful backfill having skipped most of what the fan-outs did.
   */
  it('finds session transcripts and the subagent transcripts under them', async () => {
    const { discoverTranscripts } = await I();
    const root = transcriptRoot({
      '/r/app': { records: [promptLine('hi', '/r/app')], subagents: { 'agent-abc': [promptLine('sub', '/r/app')] } },
    });
    const found = discoverTranscripts({ root });
    assert.equal(found.files.length, 2);
    assert.deepEqual(found.files.map((f) => f.agentId).sort(), ['', 'agent-abc']);
    assert.ok(found.files.every((f) => f.sessionId === SESSION),
      'a subagent transcript is filed under its parent session, which is what rejoins them');
  });

  it('reports the file cap rather than applying it silently', async () => {
    const { discoverTranscripts } = await I();
    const root = transcriptRoot({
      '/r/a': { records: [promptLine('a', '/r/a')] },
      '/r/b': { records: [promptLine('b', '/r/b')] },
      '/r/c': { records: [promptLine('c', '/r/c')] },
    });
    const found = discoverTranscripts({ root, maxFiles: 2 });
    assert.equal(found.files.length, 2);
    assert.match(found.truncatedReason, /more remain/);
  });

  it('rootFor matches a directory and its children, never a sibling with a shared prefix', async () => {
    const { rootFor } = await I();
    assert.equal(rootFor('/r/app', ['/r/app']), '/r/app');
    assert.equal(rootFor('/r/app/src/lib', ['/r/app']), '/r/app');
    assert.equal(rootFor('/r/application', ['/r/app']), '',
      'prefix matching without a separator would import a different project');
    assert.equal(rootFor('', ['/r/app']), '');
  });
});

// ---------------------------------------------------------------------------
// The join, and the secret it protects
// ---------------------------------------------------------------------------

describe('the tool_use / tool_result join', () => {
  it('pairs a call with its result across two lines', async () => {
    const { importItems } = await I();
    const { cfg } = await setup({ projectDir: '/r/app' });
    const root = transcriptRoot({
      '/r/app': {
        records: [
          callLine('toolu_01A', 'Bash', { command: 'ls -la' }, '/r/app'),
          resultLine('toolu_01A', 'total 8\ndrwxr-xr-x', '/r/app'),
        ],
      },
    });
    const path = join(root, '-r-app', `${SESSION}.jsonl`);

    const r = importItems(cfg, path, { roots: ['/r/app'] });
    assert.equal(r.items.length, 1);
    assert.match(r.items[0].item.text, /^Bash\(command=ls -la\) -> total 8/,
      'the call gives the params and the result gives the tail; neither line has both');
  });

  // The `tool:` tag names the host that wrote the transcript, not the one running the import.
  // Under Codex `envTags` leads with `tool:codex`; a Claude Code session read there is still a
  // Claude Code session, so its items must not be filed under the other host.
  it('tags a Claude Code transcript tool:claude-code even when the plugin runs under Codex', async () => {
    const { importItems } = await I();
    const { cfg } = await setup({ projectDir: '/r/app', extra: { MUBIT_CC_HOST: 'codex' } });
    assert.equal(cfg.host, 'codex');
    const root = transcriptRoot({
      '/r/app': {
        records: [
          promptLine('list the tree', '/r/app'),
          callLine('toolu_01A', 'Bash', { command: 'ls -la' }, '/r/app'),
          resultLine('toolu_01A', 'total 8\ndrwxr-xr-x', '/r/app'),
          answerLine('Eight entries.', '/r/app'),
        ],
      },
    });

    const r = importItems(cfg, join(root, '-r-app', `${SESSION}.jsonl`), { roots: ['/r/app'] });
    assert.equal(r.items.length, 2, 'one tool item and one turn');
    for (const i of r.items) {
      assert.equal(i.item.env_tags[0], 'tool:claude-code', `${i.item.item_id}: [${i.item.env_tags.join(', ')}]`);
      assert.ok(!i.item.env_tags.includes('tool:codex'), i.item.item_id);
    }
  });

  /**
   * **The assertion this whole module was designed around.**
   *
   * `hasDeniedSubject` reads `PATH_KEYS` off the *call*. The file's body arrives on the
   * *result* line, which carries `tool_use_id`, `type` and `content` and no path field of any
   * kind. So a reader that walked lines independently would find a `.env`'s contents attached
   * to nothing it could check, and stage 2 — "a denied subject is DROPPED, never scrubbed",
   * because a scrubbed `.env` is still a map of which secrets a project holds — would never
   * fire.
   */
  /**
   * The input of a `Write` is the same whether it created or overwrote; the host says which
   * on the result line, as `toolUseResult.type`. The join carries it so the file-change lane
   * records an overwrite as `update` on import, the way live capture does from `tool_response`.
   */
  it('reads a Write\'s create-or-update from the toolUseResult beside the result', async () => {
    const { importItems } = await I();
    const { cfg } = await setup({ projectDir: '/r/app' });
    const root = transcriptRoot({
      '/r/app': {
        records: [
          callLine('toolu_01W', 'Write', { file_path: '/r/app/NOTES.md', content: 'a longer note' }, '/r/app'),
          {
            ...resultLine('toolu_01W', 'The file /r/app/NOTES.md has been updated successfully.', '/r/app'),
            toolUseResult: { type: 'update', filePath: '/r/app/NOTES.md', content: 'a longer note', structuredPatch: [] },
          },
          callLine('toolu_01C', 'Write', { file_path: '/r/app/NEW.md', content: 'new' }, '/r/app'),
          {
            ...resultLine('toolu_01C', 'File created successfully at: /r/app/NEW.md', '/r/app'),
            toolUseResult: { type: 'create', filePath: '/r/app/NEW.md', content: 'new' },
          },
        ],
      },
    });
    const r = importItems(cfg, join(root, '-r-app', `${SESSION}.jsonl`), { roots: ['/r/app'] });
    const kinds = Object.fromEntries(r.items.map((i) => [i.item.item_id, JSON.parse(i.item.metadata_json).files]));
    assert.deepEqual(kinds['cc-toolu_01W'], [{ path: '/r/app/NOTES.md', kind: 'update' }]);
    assert.deepEqual(kinds['cc-toolu_01C'], [{ path: '/r/app/NEW.md', kind: 'add' }]);
  });

  it('drops a .env read whole, body and all, because the join is what sees the path', async () => {
    const { importItems } = await I();
    const projectDir = makeProjectDir({ files: { '.env': 'OPENAI_API_KEY=sk-x\n' } });
    const { cfg } = await setup({ projectDir });
    const secret = `OPENAI_API_KEY=${fx.SECRETS.openaiKey}`;
    const root = transcriptRoot({
      [projectDir]: {
        records: [
          callLine('toolu_01ENV', 'Read', { file_path: join(projectDir, '.env') }, projectDir),
          resultLine('toolu_01ENV', secret, projectDir),
        ],
      },
    });
    const path = join(root, projectDir.replace(/[/._]/g, '-'), `${SESSION}.jsonl`);

    const r = importItems(cfg, path, { roots: [projectDir] });

    assert.equal(r.denied, 1, 'the denylist has to have seen it');
    assert.deepEqual(r.items, [], 'and dropped it whole');
    assert.ok(!JSON.stringify(r).includes(fx.SECRETS.openaiKey),
      'the key must not survive anywhere in the result, scrubbed or otherwise');
  });

  it('drops a result whose call it never saw, and counts it', async () => {
    const { importItems } = await I();
    const { cfg } = await setup({ projectDir: '/r/app' });
    const root = transcriptRoot({
      '/r/app': { records: [resultLine('toolu_ORPHAN', 'output with no call', '/r/app')] },
    });
    const r = importItems(cfg, join(root, '-r-app', `${SESSION}.jsonl`), { roots: ['/r/app'] });
    assert.deepEqual(r.items, [], 'a result with no call is output with no idea what produced it');
    assert.ok(r.skipped >= 1);
  });

  it('drops a call whose result never arrived', async () => {
    const { importItems } = await I();
    const { cfg } = await setup({ projectDir: '/r/app' });
    const root = transcriptRoot({
      '/r/app': { records: [callLine('toolu_01HANG', 'Bash', { command: 'sleep 999' }, '/r/app')] },
    });
    const r = importItems(cfg, join(root, '-r-app', `${SESSION}.jsonl`), { roots: ['/r/app'] });
    assert.deepEqual(r.items, [], 'the session ended mid-tool; half an episode is not a memory');
    assert.ok(r.skipped >= 1);
  });
});

// ---------------------------------------------------------------------------
// The item id, which is the point
// ---------------------------------------------------------------------------

describe('item ids', () => {
  /**
   * `tool_use_id` is in the transcripts verbatim, so an imported item can carry the
   * byte-identical `item_id` live capture would have written. This is asserted against the
   * *live hook*, not against a constant: a change to `capture.mjs`'s id scheme has to break
   * this test rather than silently split the two paths.
   *
   * The **text** is deliberately not compared. `lib/` may not import a hook, so the renderer
   * in `lib/import.mjs` is a faithful copy rather than the same code, and pinning the bytes
   * would make every wording change in one file a failure in the other.
   */
  it('mints the same item_id the live capture hook would', async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const dataDir = makeDataDir();
    const projectDir = makeProjectDir({ git: true });

    const live = await runHook('capture', fx.postToolUse({
      tool_use_id: 'toolu_01SHARED',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
      tool_response: { stdout: 'total 8', stderr: '' },
    }), {
      env: baseEnv({
        dataDir, endpoint: server.url, projectDir,
        extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: 'cc-import-test' },
      }),
    });
    assertHookContract(live);
    const captured = readJsonDir(join(dataDir, 'runs', 'cc-import-test', 'spool'))[0].json;

    const { importItems } = await I();
    const { cfg } = await setup({ projectDir, endpoint: server.url });
    const root = transcriptRoot({
      [projectDir]: {
        records: [
          callLine('toolu_01SHARED', 'Bash', { command: 'ls -la' }, projectDir),
          resultLine('toolu_01SHARED', 'total 8', projectDir),
        ],
      },
    });
    const r = importItems(cfg, join(root, projectDir.replace(/[/._]/g, '-'), `${SESSION}.jsonl`),
      { roots: [projectDir] });

    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].item.item_id, captured.item_id,
      'the id is the whole idempotency story; if these diverge the two paths store two entries');
    assert.equal(r.items[0].item.item_id, 'cc-toolu_01SHARED');

    // The shape a reader joins on, which does have to match.
    for (const key of ['item_id', 'content_type', 'text', 'intent', 'importance', 'source',
      'occurrence_time', 'env_tags', 'metadata_json']) {
      assert.ok(key in r.items[0].item, `an imported item is missing "${key}"`);
    }
    const meta = JSON.parse(r.items[0].item.metadata_json);
    assert.equal(meta.tool_use_id, JSON.parse(captured.metadata_json).tool_use_id);
    assert.equal(meta.imported, true,
      'and it says it was imported, so two entries about one call can be told apart');
  });
});

// ---------------------------------------------------------------------------
// cwd changes mid-file
// ---------------------------------------------------------------------------

describe('scope', () => {
  /**
   * Measured on a real session: 458 records at a repo root and 565 under a subdirectory, in
   * one file. One run id per file mis-attributes more than half of it.
   */
  it('follows cwd per record, not per file', async () => {
    const { importItems } = await I();
    const { cfg } = await setup({ projectDir: '/r/app' });
    const root = transcriptRoot({
      '/r/app': {
        records: [
          callLine('toolu_01ROOT', 'Bash', { command: 'ls' }, '/r/app'),
          resultLine('toolu_01ROOT', 'a', '/r/app'),
          callLine('toolu_01SUB', 'Bash', { command: 'ls' }, '/r/app/packages/web'),
          resultLine('toolu_01SUB', 'b', '/r/app/packages/web'),
        ],
      },
    });
    const r = importItems(cfg, join(root, '-r-app', `${SESSION}.jsonl`),
      { roots: ['/r/app'], projectDir: '/r/app' });
    assert.equal(r.items.length, 2);
    assert.deepEqual(r.items.map((i) => i.cwd), ['/r/app', '/r/app/packages/web'],
      'the second call happened somewhere else and the record says so');
  });

  it('skips records whose cwd is outside the scope', async () => {
    const { importItems } = await I();
    const { cfg } = await setup({ projectDir: '/r/app' });
    const root = transcriptRoot({
      '/r/app': {
        records: [
          callLine('toolu_01IN', 'Bash', { command: 'ls' }, '/r/app'),
          resultLine('toolu_01IN', 'in', '/r/app'),
          callLine('toolu_01OUT', 'Bash', { command: 'ls' }, '/elsewhere/other'),
          resultLine('toolu_01OUT', 'out', '/elsewhere/other'),
        ],
      },
    });
    const r = importItems(cfg, join(root, '-r-app', `${SESSION}.jsonl`), { roots: ['/r/app'] });
    assert.equal(r.items.length, 1);
    assert.match(r.items[0].item.text, /-> in/);
  });
});

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

describe('conversation', () => {
  it('pairs a prompt with every assistant message that followed it', async () => {
    const { importItems } = await I();
    const { cfg } = await setup({ projectDir: '/r/app' });
    const root = transcriptRoot({
      '/r/app': {
        records: [
          promptLine('why is the ingest job stuck?', '/r/app'),
          answerLine('Let me look.', '/r/app'),
          callLine('toolu_01T', 'Bash', { command: 'curl status' }, '/r/app'),
          resultLine('toolu_01T', 'queued', '/r/app'),
          answerLine('It stays queued until indexing completes.', '/r/app'),
        ],
      },
    });
    const r = importItems(cfg, join(root, '-r-app', `${SESSION}.jsonl`), { roots: ['/r/app'] });
    const turn = r.items.find((i) => i.item.item_id.startsWith('cc-import-turn-'));
    assert.ok(turn, 'a prompt and an answer are a turn');
    assert.match(turn.item.text, /^Q: why is the ingest job stuck\?\n\nA: Let me look\./);
    assert.match(turn.item.text, /indexing completes/,
      'the summary at the END of a turn is usually the best sentence in it, and pairing the '
      + 'prompt with the FIRST assistant message would throw it away');
  });

  /**
   * Of four `user` records carrying text on a real session, one was a prompt. The rest were a
   * `<local-command-caveat>`, a `<command-name>/clear</command-name>`, and
   * `[Request interrupted by user for tool use]`. An interrupt landing mid-turn would also
   * close the real turn early and split one episode in two.
   */
  it('ignores the things the host says in a user\'s voice', async () => {
    const { importItems } = await I();
    const { cfg } = await setup({ projectDir: '/r/app' });
    const root = transcriptRoot({
      '/r/app': {
        records: [
          promptLine('<local-command-caveat>Caveat: the messages below…</local-command-caveat>', '/r/app'),
          promptLine('<command-name>/clear</command-name>', '/r/app'),
          promptLine('/mubit-memory:recall the parser', '/r/app'),
          promptLine('the real question', '/r/app'),
          answerLine('the real answer', '/r/app'),
          promptLine('[Request interrupted by user for tool use]', '/r/app'),
        ],
      },
    });
    const r = importItems(cfg, join(root, '-r-app', `${SESSION}.jsonl`), { roots: ['/r/app'] });
    const turns = r.items.filter((i) => i.item.item_id.startsWith('cc-import-turn-'));
    assert.equal(turns.length, 1);
    assert.match(turns[0].item.text, /^Q: the real question\n\nA: the real answer$/);
  });

  it('drops a prompt with no answer and an answer with no prompt', async () => {
    const { importItems } = await I();
    const { cfg } = await setup({ projectDir: '/r/app' });
    const root = transcriptRoot({
      '/r/app': { records: [answerLine('orphan answer', '/r/app'), promptLine('orphan question', '/r/app')] },
    });
    const r = importItems(cfg, join(root, '-r-app', `${SESSION}.jsonl`), { roots: ['/r/app'] });
    assert.deepEqual(r.items, [], 'half a conversation is not a memory');
  });
});

// ---------------------------------------------------------------------------
// Cursors, and the re-run
// ---------------------------------------------------------------------------

describe('cursors', () => {
  it('a cursor round-trips, and an unknown version reads as none', async () => {
    const { readCursor, writeCursor, cursorPath } = await I();
    const { cfg } = await setup({});
    const path = '/r/app/transcript.jsonl';

    assert.deepEqual(readCursor(cfg, path),
      { offset: 0, lineCount: 0, sequence: 0, sizeBytes: 0, mtimeMs: 0, at: 0 });

    writeCursor(cfg, path, { offset: 120, lineCount: 4, sequence: 1, sizeBytes: 120, mtimeMs: 5 });
    const back = readCursor(cfg, path);
    assert.equal(back.offset, 120);
    assert.equal(back.lineCount, 4);
    assert.ok(back.at > 0);

    writeFileSync(cursorPath(cfg, path), JSON.stringify({ v: 99, offset: 500 }));
    assert.equal(readCursor(cfg, path).offset, 0, 'a shape this build does not know is no cursor');
  });

  // A file that has shrunk below its stored offset was rotated or replaced. Resuming into the
  // middle of a different file would read a line fragment as a record.
  it('a truncated file resets the cursor rather than resuming into it', async () => {
    const { readCursor, writeCursor } = await I();
    const { cfg } = await setup({});
    const dir = makeDataDir();
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path, jsonl([promptLine('a', '/r/app')]));

    writeCursor(cfg, path, { offset: 10_000, lineCount: 99, sequence: 3, sizeBytes: 10_000, mtimeMs: 1 });
    assert.equal(readCursor(cfg, path).offset, 0);
  });
});

// ---------------------------------------------------------------------------
// runImport — end to end against a fake instance
// ---------------------------------------------------------------------------

describe('runImport', () => {
  async function corpus(projectDir) {
    return transcriptRoot({
      [projectDir]: {
        records: [
          promptLine('what does the drain do on a 500?', projectDir),
          callLine('toolu_01A', 'Bash', { command: 'grep -n 500 drain.mjs' }, projectDir),
          resultLine('toolu_01A', '262: // leave the spool in place', projectDir),
          answerLine('It leaves the spool in place and stops.', projectDir),
        ],
        subagents: {
          'agent-abc': [
            callLine('toolu_01S', 'Read', { file_path: `${projectDir}/lib/drain.mjs` }, projectDir),
            resultLine('toolu_01S', 'export function drain() {}', projectDir),
          ],
        },
      },
    });
  }

  it('a dry run dials nothing and still reports what it would send', async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const projectDir = makeProjectDir({ git: true });
    const { cfg } = await setup({ projectDir, endpoint: server.url });
    const { runImport } = await I();

    const r = await runImport(cfg, {
      roots: [projectDir], root: await corpus(projectDir), dryRun: true, paceMs: 0,
    });

    assert.equal(r.dryRun, true);
    assert.ok(r.items > 0, 'a dry run still counts');
    assert.equal(server.requests.length, 0, `a dry run must dial nothing; saw ${server.summary()}`);
  });

  it('sends the items and reports the runs it wrote to', async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const projectDir = makeProjectDir({ git: true });
    const { cfg, dataDir } = await setup({ projectDir, endpoint: server.url });
    const { runImport } = await I();

    const r = await runImport(cfg, {
      roots: [projectDir], root: await corpus(projectDir), paceMs: 0,
    });

    assert.equal(r.failed, 0);
    assert.ok(r.items >= 3, `expected the tool calls and the turn, got ${r.items}`);
    assert.equal(r.runs.length, 1);
    server.assertCalled('POST', '/v2/control/ingest');

    const body = server.lastCall('POST', '/v2/control/ingest').body;
    assert.equal(body.run_id, r.runs[0]);
    assert.ok(Array.isArray(body.items) && body.items.length > 0);
    assert.match(String(body.idempotency_key), /^cc-import-[0-9a-f]{16}$/);

    // Claim 3: the breaker must not have a file at all.
    assert.equal(breakerFiles(dataDir).length, 0,
      'an import that can vote on the breaker opens it, which then suppresses recall and the '
      + 'capture drain — over a background job nobody is waiting on');
  });

  /**
   * Claim 1, and the one this file can actually verify: the *cursor* makes a re-run a no-op.
   * The separate claim — that the server collapses two sends of one `item_id` — is not tested
   * here and is not asserted anywhere, because nothing on this side can observe it.
   */
  it('a second run over unchanged transcripts sends nothing', async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const projectDir = makeProjectDir({ git: true });
    const { cfg } = await setup({ projectDir, endpoint: server.url });
    const { runImport } = await I();
    const root = await corpus(projectDir);

    const first = await runImport(cfg, { roots: [projectDir], root, paceMs: 0 });
    assert.ok(first.items > 0);
    const after = server.requests.length;

    const second = await runImport(cfg, { roots: [projectDir], root, paceMs: 0 });
    assert.equal(second.items, 0, 'the cursor is at the end of every file');
    assert.equal(second.files, 0, 'and nothing was even opened');
    assert.equal(server.requests.length, after, 'so nothing was dialled either');
  });

  it('resumes rather than restarts when a transcript has grown', async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const projectDir = makeProjectDir({ git: true });
    const { cfg } = await setup({ projectDir, endpoint: server.url });
    const { runImport } = await I();

    const dir = join(makeDataDir(), 'projects', projectDir.replace(/[/._]/g, '-'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${SESSION}.jsonl`);
    const root = join(dir, '..');

    writeFileSync(file, jsonl([
      callLine('toolu_01A', 'Bash', { command: 'one' }, projectDir),
      resultLine('toolu_01A', 'first', projectDir),
    ]));
    const first = await runImport(cfg, { roots: [projectDir], root, paceMs: 0 });
    assert.equal(first.items, 1);

    writeFileSync(file, jsonl([
      callLine('toolu_01A', 'Bash', { command: 'one' }, projectDir),
      resultLine('toolu_01A', 'first', projectDir),
      callLine('toolu_01B', 'Bash', { command: 'two' }, projectDir),
      resultLine('toolu_01B', 'second', projectDir),
    ]));
    const second = await runImport(cfg, { roots: [projectDir], root, paceMs: 0 });
    assert.equal(second.items, 1, 'only the new call, not the file again');
  });

  /**
   * The cursor advances only on a clean pass. Re-sending an item is free — it carries the same
   * `item_id` — and losing one is not, so a partial run leaves the cursor where it was and
   * says the answer is incomplete.
   */
  it('an ingest failure stops, reports, and does not advance the cursor', async (t) => {
    const server = await fakeMubit({ 'POST /v2/control/ingest': { status: 500, json: { error: 'boom' } } });
    t.after(() => server.close());
    const projectDir = makeProjectDir({ git: true });
    const { cfg, dataDir } = await setup({ projectDir, endpoint: server.url });
    const { runImport } = await I();
    const root = await corpus(projectDir);

    const failed = await runImport(cfg, { roots: [projectDir], root, paceMs: 0 });
    assert.equal(failed.failed, 1);
    assert.equal(failed.items, 0);
    assert.match(failed.truncatedReason, /cursor was not advanced/);
    assert.equal(breakerFiles(dataDir).length, 0,
      'and a 5xx here still must not vote — a plain non-2xx is recorded unconditionally '
      + 'unless the caller declines');

    // The proof that the cursor did not move: a second run against a healthy server sends it.
    const ok = await fakeMubit();
    t.after(() => ok.close());
    const { loadConfig } = await lib('config.mjs');
    const cfg2 = loadConfig(baseEnv({
      dataDir, endpoint: ok.url, projectDir,
      extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: 'cc-import-test' },
    }));
    const retry = await runImport(cfg2, { roots: [projectDir], root, paceMs: 0 });
    assert.ok(retry.items > 0, 'the work was still there to do');
  });

  it('reports the item cap rather than stopping quietly', async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const projectDir = makeProjectDir({ git: true });
    const { cfg } = await setup({ projectDir, endpoint: server.url });
    const { runImport } = await I();

    const r = await runImport(cfg, {
      roots: [projectDir], root: await corpus(projectDir), paceMs: 0, maxItems: 1,
    });
    assert.ok(r.truncatedReason, 'a bound that does not report itself reads as completeness');
    assert.match(r.truncatedReason, /1 item/);
  });

  it('paces its requests', async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const projectDir = makeProjectDir({ git: true });
    const { cfg } = await setup({ projectDir, endpoint: server.url });
    const { runImport } = await I();

    const waits = [];
    await runImport(cfg, {
      roots: [projectDir], root: await corpus(projectDir), batchSize: 1, paceMs: 50,
      sleep: async (ms) => { waits.push(ms); },
    });
    assert.ok(waits.length >= 1, 'a backfill that fires every batch at once looks like an attack');
    assert.ok(waits.every((w) => w === 50));
  });

  // The ordinary spool expires at 24 h, so an import that used it would silently lose its tail
  // — a failure that looks like a successful import with less in it than the transcripts held.
  it('writes nothing to the ordinary spool', async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const projectDir = makeProjectDir({ git: true });
    const { cfg, dataDir } = await setup({ projectDir, endpoint: server.url });
    const { runImport } = await I();

    const r = await runImport(cfg, { roots: [projectDir], root: await corpus(projectDir), paceMs: 0 });
    for (const runId of r.runs) {
      assert.equal(spoolFiles(dataDir, runId).length, 0,
        'the spool expires at 24 h; an import that spooled more than one drain cycle loses its tail');
    }
  });
});

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

describe('bin/import', () => {
  const B = async () => import('../bin/import.src.mjs');

  it('refuses an unknown flag rather than guessing', async () => {
    const { parseArgs } = await B();
    assert.match(parseArgs(['--sned']).error, /unknown flag/);
    assert.match(parseArgs(['--max']).error, /needs a value/);
    assert.match(parseArgs(['--max', '0']).error, /positive/);
    assert.equal(parseArgs(['--send', '--json']).error, '');
  });

  /**
   * The safe mode is the default, inverting the usual CLI convention on purpose: the cost of a
   * surprise dry run is a wasted minute, and the cost of a surprise send is a copy of a year of
   * somebody's work on an instance they had not decided to put it on.
   */
  it('sends nothing without --send', async () => {
    const { parseArgs } = await B();
    assert.equal(parseArgs([]).send, false);
    assert.equal(parseArgs(['--dry-run']).send, false, '--dry-run is accepted and is the default');
    assert.equal(parseArgs(['--send']).send, true);
  });

  /**
   * `--source` names a host's transcripts. The default is the host this copy runs under,
   * which is the history the person in front of it most plausibly means; `all` is typed.
   */
  it('--source names claude-code, codex or all, and refuses anything else', async () => {
    const { parseArgs } = await B();
    assert.equal(parseArgs([]).source, '', 'unset means "this host", decided at run time');
    assert.equal(parseArgs(['--source', 'codex']).source, 'codex');
    assert.equal(parseArgs(['--source', 'Claude-Code']).source, 'claude-code');
    assert.equal(parseArgs(['--source', 'all']).source, 'all');
    assert.match(parseArgs(['--source', 'gemini']).error, /--source must be/);
    assert.match(parseArgs(['--source']).error, /needs a value/);
  });

  it('reads the host\'s own transcripts by default and both with --source all', async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const projectDir = makeProjectDir({ git: true });
    const { main } = await B();
    const ccRoot = transcriptRoot({
      [projectDir]: { records: [callLine('toolu_01A', 'Bash', { command: 'ls' }, projectDir), resultLine('toolu_01A', 'out', projectDir)] },
    });
    const codexRoot = join(makeDataDir(), 'sessions');
    mkdirSync(join(codexRoot, '2026/09/07'), { recursive: true });
    writeFileSync(join(codexRoot, '2026/09/07/rollout-2026-09-07T12-00-00-x.jsonl'), jsonl([
      { type: 'session_meta', payload: { id: 'x', cwd: projectDir, cli_version: '0.153.4', thread_source: 'user' } },
      { type: 'turn_context', payload: { turn_id: 't1', cwd: projectDir } },
      { type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'CommandExecution', id: 'exec-1', command: ['/bin/zsh', '-lc', 'pwd'], status: 'completed',
        aggregated_output: projectDir, exit_code: 0, duration: { secs: 0, nanos: 1 },
      } } },
    ]));

    const run = async (argv, extra = {}) => {
      let out = '', err = '';
      const code = await main(['--project', projectDir, '--pace', '0', '--json', ...argv], {
        stdout: (s) => { out += s; },
        stderr: (s) => { err += s; },
        env: baseEnv({
          dataDir: makeDataDir(), endpoint: server.url, projectDir,
          extra: {
            MUBIT_CC_TRANSCRIPT_ROOT: ccRoot, MUBIT_CC_CODEX_SESSIONS_ROOT: codexRoot,
            MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: 'cc-import-test', ...extra,
          },
        }),
      });
      assert.equal(code, 0, err);
      return JSON.parse(out);
    };

    assert.deepEqual(Object.keys((await run([])).sources), ['claude-code'], 'under Claude Code, its own transcripts');
    assert.deepEqual(Object.keys((await run([], { MUBIT_CC_HOST: 'codex' })).sources), ['codex'], 'under Codex, its rollouts');
    const both = await run(['--source', 'all']);
    assert.deepEqual(Object.keys(both.sources), ['claude-code', 'codex']);
    assert.equal(both.sources['claude-code'].items, 1);
    assert.equal(both.sources.codex.items, 1);
    assert.equal(both.items, 2);
  });

  it('prints the scope before it reads anything, and dials nothing on a dry run', async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const projectDir = makeProjectDir({ git: true });
    const dataDir = makeDataDir();
    const { main } = await B();

    const root = transcriptRoot({
      [projectDir]: {
        records: [
          callLine('toolu_01A', 'Bash', { command: 'ls' }, projectDir),
          resultLine('toolu_01A', 'out', projectDir),
        ],
      },
    });

    let out = '', err = '';
    const code = await main(['--project', projectDir, '--pace', '0'], {
      stdout: (s) => { out += s; },
      stderr: (s) => { err += s; },
      env: baseEnv({
        dataDir, endpoint: server.url, projectDir,
        extra: { MUBIT_CC_TRANSCRIPT_ROOT: root, MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: 'cc-import-test' },
      }),
    });

    assert.equal(code, 0);
    assert.match(err, /scope:/, 'which projects is the one thing to check BEFORE a bulk upload');
    assert.match(out, /would send \d+ item/);
    assert.match(err, /nothing was sent/);
    assert.equal(server.requests.length, 0);
  });

  it('refuses when nothing is configured', async () => {
    const { main } = await B();
    let err = '';
    const code = await main([], {
      stdout: () => {}, stderr: (s) => { err += s; },
      env: { ...baseEnv({ dataDir: makeDataDir() }), MUBIT_ENDPOINT: '' },
    });
    assert.equal(code, 1);
    assert.match(err, /setup/, 'an import against nothing wastes the time and says nothing');
  });
});

// ---------------------------------------------------------------------------
// warmIgnoreCache — the fork that would otherwise dominate
// ---------------------------------------------------------------------------

test('warmIgnoreCache answers a whole list in one git call', async () => {
  const { warmIgnoreCache, isDeniedPath } = await lib('redact.mjs');
  const projectDir = makeProjectDir({ git: true, files: { '.gitignore': 'build/\n*.log\n' } });

  const paths = ['src/main.rs', 'build/out.o', 'notes.log', 'README.md'];
  const n = warmIgnoreCache(paths.map((p) => join(projectDir, p)), projectDir);
  assert.equal(n, 4, 'every path asked about is resolved, ignored or not');

  assert.equal(isDeniedPath(join(projectDir, 'build/out.o'), { respectGitignore: true }, projectDir), true);
  assert.equal(isDeniedPath(join(projectDir, 'notes.log'), { respectGitignore: true }, projectDir), true);
  assert.equal(isDeniedPath(join(projectDir, 'src/main.rs'), { respectGitignore: true }, projectDir), false);
});

test('warmIgnoreCache caches nothing when it cannot answer', async () => {
  const { warmIgnoreCache } = await lib('redact.mjs');
  // A directory that is not a repository: there is no `git check-ignore` to run, and caching
  // "not ignored" from a failed warm is the direction in which a `.env` gets captured.
  assert.equal(warmIgnoreCache(['a', 'b'], makeDataDir()), 0);
  assert.equal(warmIgnoreCache(/** @type {any} */ (null), makeProjectDir({ git: true })), 0);
});
