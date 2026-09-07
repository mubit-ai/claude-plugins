// @ts-check
/**
 * `lib/filechange.mjs` — the structured file-change lane.
 *
 * ---------------------------------------------------------------------------
 * What this replaces
 * ---------------------------------------------------------------------------
 * Until now a file path survived capture only as a substring of the prose episode —
 * `Write(file_path=…) -> …` — and only if it fell inside the first 24 rendered keys and 4096
 * bytes. `PATH_KEYS` existed twice in the tree and was read for nothing but two drop checks.
 * So "what changed in auth?" had no answer at all, and "rank this recall by the files in
 * play" had nothing to rank against.
 *
 * ---------------------------------------------------------------------------
 * Why the table is an oracle
 * ---------------------------------------------------------------------------
 * The extractor is a function of the tool name and `tool_input` and nothing else — no clock,
 * no filesystem, no config — so every case is one row: input in, `{path, kind}[]` out. That
 * is deliberate. The two hosts spell a file change so differently that the only defensible
 * way to hold them to the same contract is to state both spellings side by side and read the
 * rows as a specification:
 *
 * | | Claude Code | Codex |
 * | --- | --- | --- |
 * | where the path is | `tool_input.file_path`, `edits[]` for `MultiEdit` | inside an `apply_patch` blob |
 * | how the kind is known | prior text named or not | `*** Add/Delete/Update File:` markers |
 *
 * ---------------------------------------------------------------------------
 * The one thing the input cannot say
 * ---------------------------------------------------------------------------
 * A `Write` that creates a file and a `Write` that overwrites one have the same input —
 * `file_path` and `content`, no prior text. The host says which on the *result*,
 * `{type: 'create'|'update'}`, so a row may carry the response as a fourth column and the
 * extractor reads its `type` for the call's own subject. Without a response, a change that
 * names no prior text reads as `add`: that is what the tool means, and it is wrong only for
 * an overwrite whose result nobody handed in — recorded here rather than hidden, because a
 * reader comparing this lane to Codex's, where the marker says so outright, will otherwise
 * think one of them is buggy.
 */

import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { lib, baseEnv, makeDataDir, readJsonFile } from './helpers/harness.mjs';

let _mod;
const F = async () => (_mod ??= await lib('filechange.mjs'));

const RUN = 'cc-filechange-test';

/** A resolved config over a fresh data dir. */
async function setup() {
  const dataDir = makeDataDir();
  const { loadConfig } = await lib('config.mjs');
  return { dataDir, cfg: loadConfig(baseEnv({ dataDir })) };
}

const filesPath = (dataDir) => join(dataDir, 'runs', RUN, 'files.json');

/** One Codex `apply_patch` body. */
const patch = (...body) => ['*** Begin Patch', ...body, '*** End Patch'].join('\n');

// ---------------------------------------------------------------------------
// The oracle table
// ---------------------------------------------------------------------------

/**
 * `[label, tool, tool_input, expected, tool_response?]`. The fifth column is the host's
 * result, present only on the rows where it changes the answer.
 * @type {Array<[string, string, Record<string, any>, Array<{path: string, kind: string}>, any?]>}
 */
const ROWS = [
  // --- Claude Code, the ordinary shapes -------------------------------------
  ['Edit names its prior text, so it is an update',
    'Edit', { file_path: '/r/src/lib.rs', old_string: 'a', new_string: 'b' },
    [{ path: '/r/src/lib.rs', kind: 'update' }]],

  ['Write with no result names no prior text, so it reads as add',
    'Write', { file_path: '/r/NOTES.md', content: 'hello' },
    [{ path: '/r/NOTES.md', kind: 'add' }]],

  // The result is the one place Claude Code states whether a `Write` created or replaced.
  ['Write whose result says create is an add',
    'Write', { file_path: '/r/NOTES.md', content: 'hello' },
    [{ path: '/r/NOTES.md', kind: 'add' }],
    { type: 'create', filePath: '/r/NOTES.md', content: 'hello' }],

  ['Write whose result says update is an update — the input alone could not tell',
    'Write', { file_path: '/r/NOTES.md', content: 'hello again' },
    [{ path: '/r/NOTES.md', kind: 'update' }],
    { type: 'update', filePath: '/r/NOTES.md', content: 'hello again', structuredPatch: [] }],

  // A result can settle add against update; it cannot turn a read into a change. `Read`
  // answers `{type: 'text'}` and nothing on it is a kind.
  ['the type on a Read result is not a kind',
    'Read', { file_path: '/r/src/lib.rs' },
    [],
    { type: 'text', file: { filePath: '/r/src/lib.rs', content: 'x' } }],

  // Only the call's own subject reads the result. `edits[]` entries carry their own prior
  // text, and a `MultiEdit` result carries no `type` anyway.
  ['a result does not reach into edits[]',
    'MultiEdit', { file_path: '/r/a.rs', edits: [{ old_string: 'a', new_string: 'b' }] },
    [{ path: '/r/a.rs', kind: 'update' }],
    { filePath: '/r/a.rs', edits: [{ old_string: 'a', new_string: 'b' }] }],

  // The host documents an empty `old_string` as the way to create a file, so this is the one
  // Claude Code shape where `add` is known rather than assumed.
  ['an Edit with an empty prior string is a create',
    'Edit', { file_path: '/r/new.rs', old_string: '', new_string: 'fn main() {}' },
    [{ path: '/r/new.rs', kind: 'add' }]],

  ['a Read changes nothing and yields nothing',
    'Read', { file_path: '/r/src/lib.rs' },
    []],

  ['a Glob changes nothing either, though it carries a path key',
    'Glob', { pattern: '**/*.rs', path: '/r/src' },
    []],

  ['a Bash command carries no path key and yields nothing',
    'Bash', { command: 'rm -rf /r/build' },
    []],

  // --- Claude Code, the nested shapes ---------------------------------------
  ['MultiEdit spreads one path across its edits',
    'MultiEdit', {
      file_path: '/r/src/lib.rs',
      edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }],
    },
    [{ path: '/r/src/lib.rs', kind: 'update' }]],

  // `hasDeniedSubject` already descends into `edits` looking for a denied path, and
  // `isSelfReference` does not. The extractor follows the descending one: an edit that names
  // its own subject is a change to that subject whatever the parent says.
  ['an edit that names its own path is credited to that path',
    'MultiEdit', {
      file_path: '/r/src/lib.rs',
      edits: [
        { file_path: '/r/src/a.rs', old_string: 'a', new_string: 'b' },
        { file_path: '/r/src/b.rs', old_string: '', new_string: 'new' },
      ],
    },
    [{ path: '/r/src/a.rs', kind: 'update' }, { path: '/r/src/b.rs', kind: 'add' }]],

  ['NotebookEdit spells its path and its content differently, and still counts',
    'NotebookEdit', { notebook_path: '/r/nb.ipynb', cell_id: '3', new_source: 'print(1)', edit_mode: 'replace' },
    [{ path: '/r/nb.ipynb', kind: 'add' }]],

  // --- Codex ----------------------------------------------------------------
  ['apply_patch: an add',
    'apply_patch', { command: patch('*** Add File: NOTES.md', '+probe note') },
    [{ path: 'NOTES.md', kind: 'add' }]],

  ['apply_patch: an update',
    'apply_patch', { command: patch('*** Update File: src/lib.rs', '@@', '-a', '+b') },
    [{ path: 'src/lib.rs', kind: 'update' }]],

  ['apply_patch: a delete — the only kind either host states outright',
    'apply_patch', { command: patch('*** Delete File: old.txt') },
    [{ path: 'old.txt', kind: 'delete' }]],

  ['apply_patch: three files in one call, in the order the patch states them',
    'apply_patch', {
      command: patch(
        '*** Update File: src/lib.rs', '@@', '-a', '+b',
        '*** Add File: NOTES.md', '+note',
        '*** Delete File: old.txt',
      ),
    },
    [
      { path: 'src/lib.rs', kind: 'update' },
      { path: 'NOTES.md', kind: 'add' },
      { path: 'old.txt', kind: 'delete' },
    ]],

  // A rename is an `Update File` followed by `Move to`. The destination did not exist before
  // the call and does after it, which is what `add` means everywhere else in this table.
  ['apply_patch: a rename credits both the source and the destination',
    'apply_patch', { command: patch('*** Update File: src/old.rs', '*** Move to: src/new.rs', '@@', '-a', '+b') },
    [{ path: 'src/old.rs', kind: 'update' }, { path: 'src/new.rs', kind: 'add' }]],

  // Codex renames its shell tool to `Bash` in hook payloads, and a patch can arrive through
  // it. The body is what identifies a patch, not the name on the envelope — the plugin does
  // not own either host's tool names and has been renamed under before.
  ['a patch body is recognised whatever the tool is called',
    'Bash', { command: patch('*** Add File: NOTES.md', '+note') },
    [{ path: 'NOTES.md', kind: 'add' }]],

  // --- Degenerate input -----------------------------------------------------
  ['a patch with no file markers yields nothing',
    'apply_patch', { command: patch('@@', '-a', '+b') },
    []],
  ['an empty tool_input yields nothing', 'Edit', {}, []],
  ['a non-string path is not a path', 'Edit', { file_path: 42, new_string: 'b' }, []],
  ['an empty path is not a path', 'Write', { file_path: '   ', content: 'x' }, []],
];

describe('fileChanges — the oracle table', () => {
  for (const [label, tool, input, expected, response] of ROWS) {
    it(label, async () => {
      const { fileChanges } = await F();
      assert.deepEqual(fileChanges(tool, input, response), expected);
    });
  }

  // §4.9's rule, applied here because this runs on the capture hook's critical path: a
  // hostile or simply unexpected `tool_input` costs the lane, never the item.
  it('never throws, whatever it is handed', async () => {
    const { fileChanges } = await F();
    const hostile = [
      null, undefined, 42, 'a string', [], { edits: 'not an array' },
      { file_path: { toString() { throw new Error('boom'); } }, content: 'x' },
      { edits: [null, 3, { file_path: [] }] },
    ];
    for (const input of hostile) {
      assert.ok(Array.isArray(fileChanges('Edit', /** @type {any} */ (input))),
        `threw or returned a non-array for ${JSON.stringify(input)}`);
    }
    for (const name of [null, undefined, 42, {}]) {
      assert.ok(Array.isArray(fileChanges(/** @type {any} */ (name), { file_path: '/r/a', content: 'x' })));
    }
    for (const response of [null, 42, 'Wrote it', [], { type: 42 }, { type: { toString() { throw new Error('boom'); } } }]) {
      assert.deepEqual(fileChanges('Write', { file_path: '/r/a', content: 'x' }, response),
        [{ path: '/r/a', kind: 'add' }], `a result that states no kind must change nothing: ${JSON.stringify(response)}`);
    }
  });

  // One event's list is deduped on `kind:path`, which is the granularity `metadata_json.files`
  // is stored at. Two updates to one file in one `MultiEdit` are one change; an add and an
  // update of the same path are two, because they say different things.
  it('dedupes one event on kind and path together', async () => {
    const { fileChanges } = await F();
    const r = fileChanges('apply_patch', {
      command: patch(
        '*** Update File: a.rs', '@@', '-x', '+y',
        '*** Update File: a.rs', '@@', '-p', '+q',
        '*** Add File: a.rs', '+z',
      ),
    });
    assert.deepEqual(r, [{ path: 'a.rs', kind: 'update' }, { path: 'a.rs', kind: 'add' }]);
  });

  // The bound is stated rather than discovered: a patch is model-authored text and a tool
  // call is the one input whose size an attacker picks.
  it('bounds what one event may contribute', async () => {
    const { fileChanges, MAX_CHANGES_PER_EVENT } = await F();
    const body = [];
    for (let i = 0; i < MAX_CHANGES_PER_EVENT * 4; i++) body.push(`*** Add File: f${i}.txt`, '+x');
    const r = fileChanges('apply_patch', { command: patch(...body) });
    assert.equal(r.length, MAX_CHANGES_PER_EVENT);
  });

  it('scans a megabyte of patch-shaped text without going quadratic', async () => {
    const { fileChanges } = await F();
    const started = Date.now();
    for (const body of ['*'.repeat(2 * 1024 * 1024), '*** '.repeat(262_144), 'a\n'.repeat(524_288)]) {
      assert.deepEqual(fileChanges('apply_patch', { command: body }), []);
    }
    assert.ok(Date.now() - started < 5_000, 'patch scanning is super-linear in input size');
  });
});

// ---------------------------------------------------------------------------
// summarize — one row per path
// ---------------------------------------------------------------------------

describe('summarize', () => {
  it('collapses changes into per-path kinds and occurrences', async () => {
    const { summarize } = await F();
    const r = summarize([
      { path: 'b.rs', kind: 'update' },
      { path: 'a.rs', kind: 'add' },
      { path: 'b.rs', kind: 'update' },
      { path: 'b.rs', kind: 'delete' },
    ]);
    assert.deepEqual(r, [
      { path: 'a.rs', kinds: ['add'], occurrences: 1 },
      { path: 'b.rs', kinds: ['update', 'delete'], occurrences: 3 },
    ]);
  });

  it('sorts by path, so two runs of the same work read alike', async () => {
    const { summarize } = await F();
    const r = summarize([{ path: 'z', kind: 'add' }, { path: 'a', kind: 'add' }, { path: 'm', kind: 'add' }]);
    assert.deepEqual(r.map((f) => f.path), ['a', 'm', 'z']);
  });

  it('returns [] for anything that is not a list of changes', async () => {
    const { summarize } = await F();
    for (const v of [null, undefined, 42, 'x', {}, [null, 3, { path: '' }]]) {
      assert.deepEqual(summarize(/** @type {any} */ (v)), []);
    }
  });
});

// ---------------------------------------------------------------------------
// runs/<run_id>/files.json
// ---------------------------------------------------------------------------

describe('the per-run index', () => {
  test('recordFileChanges writes runs/<run_id>/files.json with a version', async () => {
    const { recordFileChanges } = await F();
    const { cfg, dataDir } = await setup();

    recordFileChanges(cfg, RUN, [{ path: '/r/a.rs', kind: 'update' }]);

    const raw = readJsonFile(filesPath(dataDir));
    assert.equal(raw.version, 1);
    assert.equal(typeof raw.updated_at, 'number');
    assert.deepEqual(raw.files.map((f) => f.path), ['/r/a.rs']);
  });

  // Merge, never replace: a run writes here once per tool call for the life of the run.
  test('recordFileChanges accumulates across calls', async () => {
    const { recordFileChanges, readFileChanges } = await F();
    const { cfg } = await setup();

    recordFileChanges(cfg, RUN, [{ path: '/r/a.rs', kind: 'add' }]);
    recordFileChanges(cfg, RUN, [{ path: '/r/a.rs', kind: 'update' }]);
    recordFileChanges(cfg, RUN, [{ path: '/r/b.rs', kind: 'update' }]);

    const files = readFileChanges(cfg, RUN);
    const a = files.find((f) => f.path === '/r/a.rs');
    assert.deepEqual(a.kinds, ['add', 'update'], 'kinds is a set, in first-seen order');
    assert.equal(a.occurrences, 2);
    assert.equal(files.length, 2);
  });

  // Most-recently-touched first. `summarize` sorts by path because it renders a listing;
  // this index exists so recall can ask "what is in play right now", and the answer to that
  // is ordered by when, not by name.
  test('readFileChanges returns the most recently touched first', async () => {
    const { recordFileChanges, readFileChanges } = await F();
    const { cfg } = await setup();

    recordFileChanges(cfg, RUN, [{ path: '/r/first.rs', kind: 'add' }]);
    recordFileChanges(cfg, RUN, [{ path: '/r/second.rs', kind: 'add' }]);

    assert.deepEqual(readFileChanges(cfg, RUN).map((f) => f.path), ['/r/second.rs', '/r/first.rs']);
  });

  test('the index is bounded, and the cap drops the least recently touched', async () => {
    const { recordFileChanges, readFileChanges, MAX_INDEXED_PATHS } = await F();
    const { cfg } = await setup();

    for (let i = 0; i < MAX_INDEXED_PATHS + 10; i++) {
      recordFileChanges(cfg, RUN, [{ path: `/r/f${i}.rs`, kind: 'update' }]);
    }
    const files = readFileChanges(cfg, RUN);
    assert.equal(files.length, MAX_INDEXED_PATHS);
    assert.equal(files[0].path, `/r/f${MAX_INDEXED_PATHS + 9}.rs`);
    assert.ok(!files.some((f) => f.path === '/r/f0.rs'), 'the oldest path was dropped');
  });

  // The `lib/rules.mjs` contract, which every per-run store in this tree shares: a file from
  // a version this build does not know reads as no data rather than as data of an unknown
  // shape. The caller is a hook and has no branch for "the store is broken".
  test('an unknown version reads as no data', async () => {
    const { readFileChanges, recordFileChanges } = await F();
    const { cfg, dataDir } = await setup();
    recordFileChanges(cfg, RUN, [{ path: '/r/a.rs', kind: 'update' }]);

    const { writeFileSync } = await import('node:fs');
    const raw = readJsonFile(filesPath(dataDir));
    writeFileSync(filesPath(dataDir), JSON.stringify({ ...raw, version: 99 }));

    assert.deepEqual(readFileChanges(cfg, RUN), []);
  });

  test('every kind of absence and damage reads as no data', async () => {
    const { readFileChanges } = await F();
    const { cfg, dataDir } = await setup();
    const { mkdirSync, writeFileSync } = await import('node:fs');

    assert.deepEqual(readFileChanges(cfg, RUN), [], 'no file');
    assert.deepEqual(readFileChanges(cfg, ''), [], 'no run id');

    mkdirSync(join(dataDir, 'runs', RUN), { recursive: true });
    for (const body of ['', '{', '[]', '{"version":1}', '{"version":1,"files":"nope"}']) {
      writeFileSync(filesPath(dataDir), body);
      assert.deepEqual(readFileChanges(cfg, RUN), [], `damage: ${JSON.stringify(body)}`);
    }
  });

  test('recordFileChanges never throws and reports what it stored', async () => {
    const { recordFileChanges } = await F();
    const { cfg } = await setup();
    assert.equal(recordFileChanges(cfg, RUN, []), 0);
    assert.equal(recordFileChanges(cfg, '', [{ path: '/r/a', kind: 'add' }]), 0);
    assert.equal(recordFileChanges(cfg, RUN, /** @type {any} */ (null)), 0);
    assert.equal(recordFileChanges(cfg, RUN, [{ path: '/r/a', kind: 'add' }]), 1);
  });
});
