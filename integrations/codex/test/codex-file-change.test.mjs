// @ts-check
/**
 * The structured file-change lane, on the host where the path is hardest to find.
 *
 * Claude Code names the file in `tool_input.file_path`. Codex names it nowhere: the paths are
 * inside an `apply_patch` blob, under no key at all, and the *kind* of change is stated only
 * by the `*** Add/Update/Delete File:` markers in that blob. So this is the host where the
 * lane is most likely to record nothing, and the one where it can assert a `delete` at all.
 *
 * Four properties, each end to end through the real `capture` hook on a real Codex payload:
 *
 *   1. one patch → `metadata_json.files`, kind and path from the markers, in marker order;
 *   2. two patches → `runs/<run>/files.json` merges kinds, counts occurrences, and orders by
 *      when — most recently touched first — because recall asks "what is in play now";
 *   3. a patch that touches `.env` is dropped **whole**: no spool item, no index row. A scrubbed
 *      `.env` is still a map of which secrets a project holds, and an index row naming it is
 *      the same map with the values removed;
 *   4. a shell command carries no `files` field, so a reader can trust the field's presence;
 *
 * and then the lane's whole reason: after `Stop` drains, the ingest body carries `files`, so
 * the instance can answer "what changed in auth?" from something other than prose.
 *
 * `lib/filechange.mjs` is the extractor and is oracle-tested next door; `codex-hooks.test.mjs`
 * carries the first assertion in passing. This file is the lane's contract under Codex.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  postToolUse, stop, userPromptSubmit,
  runHook, baseEnv, makeDataDir, makeProjectDir, fakeMubit, lib,
  assertHookContract, spoolFiles, readJsonDir, waitFor,
} from './helpers/codex-fixtures.mjs';

const RUN_ID = 'codex-files-test';

function env(dataDir, projectDir, endpoint, extra = {}) {
  return baseEnv({
    dataDir, projectDir, endpoint,
    extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN_ID, MUBIT_CC_SESSION_END_DETACH: '0', ...extra },
  });
}

async function harness(t) {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir({ git: true });
  return { server, dataDir, projectDir, e: env(dataDir, projectDir, server.url) };
}

/** An `apply_patch` call as Codex sends it: the blob in `tool_input.command`, a string reply. */
function patch(lines, response, over = {}) {
  return postToolUse({
    tool_name: 'apply_patch',
    tool_use_id: over.id ?? 'exec-patch-1',
    tool_input: { command: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') },
    tool_response: response,
  });
}

const spooled = (dataDir) => readJsonDir(join(dataDir, 'runs', RUN_ID, 'spool')).map((f) => f.json);
const filesOf = (item) => JSON.parse(item.metadata_json).files;

test('one apply_patch: add, update and delete, each named outright, in marker order', async (t) => {
  const { dataDir, e } = await harness(t);
  const r = await runHook('capture', patch([
    '*** Add File: NOTES.md', '+probe note',
    '*** Update File: src/lib.rs', '@@', '-let a = 1;', '+let a = 2;',
    '*** Delete File: old.txt',
  ], 'Success. Updated the following files:\nA NOTES.md\nM src/lib.rs\nD old.txt\n'), { env: e });

  assertHookContract(r);
  const items = spooled(dataDir);
  assert.equal(items.length, 1, 'the patch is one episode');
  // § The markers are the only place either host states the kind. Claude Code infers `add`
  //   from the absence of prior text; Codex says it. A reader comparing the two lanes has to
  //   see the same three words, or one lane looks buggy beside the other.
  assert.deepEqual(filesOf(items[0]), [
    { path: 'NOTES.md', kind: 'add' },
    { path: 'src/lib.rs', kind: 'update' },
    { path: 'old.txt', kind: 'delete' },
  ]);
});

test('two patches: the run index merges kinds, counts occurrences, and orders by recency', async (t) => {
  const { dataDir, e } = await harness(t);
  await runHook('capture', patch([
    '*** Add File: src/a.rs', '+fn a() {}',
    '*** Update File: src/b.rs', '@@', '-x', '+y',
  ], 'Success. Updated the following files:\nA src/a.rs\nM src/b.rs\n', { id: 'exec-patch-1' }), { env: e });
  await runHook('capture', patch([
    '*** Update File: src/a.rs', '@@', '-fn a() {}', '+fn a() { 1 }',
  ], 'Success. Updated the following files:\nM src/a.rs\n', { id: 'exec-patch-2' }), { env: e });

  const { loadConfig } = await lib('config.mjs');
  const { readFileChanges } = await lib('filechange.mjs');
  const files = readFileChanges(loadConfig(e), RUN_ID);
  // § `summarize` sorts by path because it renders a listing; the index exists so recall can
  //   ask what is in play *right now*, and that answer is ordered by when, not by name.
  assert.deepEqual(files.map((f) => f.path), ['src/a.rs', 'src/b.rs'], 'most recently touched first');
  const a = files.find((f) => f.path === 'src/a.rs');
  assert.deepEqual(a.kinds, ['add', 'update'], 'kinds is a set, in first-seen order');
  assert.equal(a.occurrences, 2);
  assert.deepEqual(files.find((f) => f.path === 'src/b.rs').kinds, ['update']);
  assert.equal(files.find((f) => f.path === 'src/b.rs').occurrences, 1);
});

test('a patch touching .env is dropped whole: no spool item, no index row', async (t) => {
  const { dataDir, e } = await harness(t);
  const r = await runHook('capture', patch([
    '*** Update File: src/lib.rs', '@@', '-let a = 1;', '+let a = 2;',
    '*** Update File: .env', '@@', '-KEY=old', '+KEY=new',
  ], 'Success. Updated the following files:\nM src/lib.rs\nM .env\n'), { env: e });

  assertHookContract(r);
  // § The denylist runs before anything is built, so the drop is total. Recording
  //   `src/lib.rs` from the same patch would be defensible; recording that `.env` was touched
  //   is not, and the lane cannot tell the two apart once it has started writing.
  assert.equal(spoolFiles(dataDir, RUN_ID).length, 0,
    'a patch whose subject includes a denylisted path must produce no item at all.');
  assert.ok(!existsSync(join(dataDir, 'runs', RUN_ID, 'files.json')),
    'and no index row: the path list of a denied patch is the very thing the denylist protects.');
});

test('a shell command carries no files field at all', async (t) => {
  const { dataDir, e } = await harness(t);
  await runHook('capture', postToolUse({
    tool_name: 'Bash', tool_input: { command: 'cat src/lib.rs' }, tool_response: 'fn a() {}\n',
  }), { env: e });

  const items = spooled(dataDir);
  assert.equal(items.length, 1);
  // § Absence, not an empty list: a reader keys on the field to know a record is a change.
  //   `[]` on every read would make "did this touch anything" a count rather than a check.
  assert.ok(!('files' in JSON.parse(items[0].metadata_json)),
    'a read is not a change; the field must be absent rather than empty.');
  assert.ok(!existsSync(join(dataDir, 'runs', RUN_ID, 'files.json')), 'nothing to index either');
});

test('Stop drains, and the ingest body carries the files the patch touched', async (t) => {
  const { server, dataDir, e } = await harness(t);
  await runHook('stage-prompt', userPromptSubmit(), { env: e });
  await runHook('capture', patch([
    '*** Update File: src/auth.rs', '@@', '-old', '+new',
  ], 'Success. Updated the following files:\nM src/auth.rs\n'), { env: e });
  assert.equal(server.countOf('POST', '/v2/control/ingest'), 0, 'capture itself dials nothing');

  const r = await runHook('capture', stop(), { args: ['--stop'], env: e });
  assertHookContract(r);
  // § `--stop` always drains — the turn is over, so its attribution can be recorded — in a
  //   detached process. The only proof the lane reaches the instance is the body it sends.
  await waitFor(() => server.countOf('POST', '/v2/control/ingest') > 0, 8000);

  const sent = server.calls('POST', '/v2/control/ingest').flatMap((c) => c.body?.items ?? []);
  const change = sent.find((i) => { try { return 'files' in JSON.parse(i.metadata_json); } catch { return false; } });
  assert.ok(change, `no ingested item carries files; sent: ${sent.map((i) => i.item_id).join(', ')}`);
  assert.deepEqual(JSON.parse(change.metadata_json).files, [{ path: 'src/auth.rs', kind: 'update' }]);
  assert.equal(change.env_tags?.[0], 'tool:codex', 'and the item says which host changed it');
});
