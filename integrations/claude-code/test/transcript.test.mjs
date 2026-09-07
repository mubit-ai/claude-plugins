// @ts-check
/**
 * `lib/transcript.mjs` — reading a transcript forwards, from a resumable byte offset.
 *
 * ---------------------------------------------------------------------------
 * What is genuinely new here
 * ---------------------------------------------------------------------------
 * Every other transcript reader in this tree is a bounded **tail** (or head) on a hot path,
 * and all of them handle a truncated line by dropping it. That is the right half of the
 * problem for a window and the wrong half for an import: an importer reads a file end to end
 * and must lose nothing, but must also be able to stop and come back.
 *
 * So the contract under test is the **offset**: it is always just past a newline, and passing
 * the last one back as `from` resumes with nothing skipped and nothing seen twice. Most of
 * this file is that one property, put under the conditions that break it — a chunk boundary
 * landing inside a line, inside a multi-byte character, and on the newline itself; a file
 * that grew; a file that shrank; a line still being written.
 */

import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { lib, makeDataDir } from './helpers/harness.mjs';

let _mod;
const T = async () => (_mod ??= await lib('transcript.mjs'));

/** Write a transcript and hand back its path. */
function transcript(lines, { trailing = '\n' } = {}) {
  const path = join(makeDataDir(), 'transcript.jsonl');
  writeFileSync(path, lines.join('\n') + trailing);
  return path;
}

const line = (o) => JSON.stringify(o);
const userLine = (text) => line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const assistantLine = (text) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

/** Read a whole file and hand back the texts plus the last offset. */
async function readAll(path, opts = {}) {
  const { readForward } = await T();
  const out = [];
  let offset = 0;
  for (const l of readForward(path, opts)) { out.push(l); offset = l.offset; }
  return { lines: out, texts: out.map((l) => l.text), offset };
}

// ---------------------------------------------------------------------------
// The offset contract
// ---------------------------------------------------------------------------

describe('readForward — the resumable offset', () => {
  it('yields every complete line in order', async () => {
    const path = transcript([userLine('one'), assistantLine('two'), userLine('three')]);
    const { texts } = await readAll(path);
    assert.equal(texts.length, 3);
    assert.deepEqual(texts.map((t) => JSON.parse(t).type), ['user', 'assistant', 'user']);
  });

  it('offsets are line boundaries, and the last one is the whole file', async () => {
    const path = transcript(['a', 'bb', 'ccc']);
    const { lines, offset } = await readAll(path);
    assert.deepEqual(lines.map((l) => l.offset), [2, 5, 9]);
    assert.equal(offset, 9, 'a=1+nl, bb=2+nl, ccc=3+nl');
  });

  it('resuming from a stored offset yields the rest and nothing else', async () => {
    const path = transcript(['a', 'bb', 'ccc']);
    const first = await readAll(path);
    const second = await readAll(path, { from: first.lines[0].offset });
    assert.deepEqual(second.texts, ['bb', 'ccc']);
  });

  // Nothing skipped, nothing seen twice — asserted line by line rather than in aggregate, so
  // a reader that loses one line in the middle cannot pass by getting the count right.
  it('resuming after every line reconstructs the file exactly once', async () => {
    const { readForward } = await T();
    const written = Array.from({ length: 40 }, (_, i) => userLine(`turn ${i}`));
    const path = transcript(written);

    const seen = [];
    let from = 0;
    for (;;) {
      const next = readForward(path, { from, chunkBytes: 64 }).next();
      if (next.done) break;
      seen.push(next.value.text);
      from = next.value.offset;
    }
    assert.deepEqual(seen, written);
  });

  // A host writing the current line is the ordinary state of a live transcript. The fragment
  // must not be yielded — half a JSON object is not a record — and, the half that matters,
  // must not be counted, or the next read starts past a line that was never seen.
  it('a trailing fragment with no newline is neither yielded nor counted', async () => {
    const path = transcript(['a', 'bb'], { trailing: '\n' });
    appendFileSync(path, '{"partial":');

    const { texts, offset } = await readAll(path);
    assert.deepEqual(texts, ['a', 'bb']);
    assert.equal(offset, 5, 'the offset stops at the last complete newline');

    appendFileSync(path, 'true}\n');
    const { texts: rest } = await readAll(path, { from: offset });
    assert.deepEqual(rest, ['{"partial":true}'], 'and the line arrives whole once it is finished');
  });

  it('a file with no trailing newline still yields its complete lines', async () => {
    const path = transcript(['a', 'bb'], { trailing: '' });
    const { texts } = await readAll(path);
    assert.deepEqual(texts, ['a'], 'bb has no newline yet, so it is not a complete line');
  });

  // The chunk boundary is where a byte-offset reader goes wrong, so it is walked across
  // every position in a small file rather than tested at one convenient size.
  it('every chunk size reads the same file identically', async () => {
    const written = [userLine('alpha'), assistantLine('beta'), userLine('gamma')];
    const path = transcript(written);
    for (let chunkBytes = 1; chunkBytes <= 64; chunkBytes++) {
      const { texts, offset } = await readAll(path, { chunkBytes });
      assert.deepEqual(texts, written, `chunkBytes=${chunkBytes} lost or split a line`);
      assert.equal(offset, Buffer.byteLength(written.join('\n') + '\n'), `chunkBytes=${chunkBytes}`);
    }
  });

  // Splitting on the newline BYTE rather than on a decoded string is what makes this safe.
  // A chunk boundary inside a multi-byte character would otherwise decode to a replacement
  // character on both sides of the split, silently corrupting the line.
  it('a chunk boundary inside a multi-byte character does not corrupt it', async () => {
    const text = 'héllo — naïve 日本語 🎈 done';
    const path = transcript([userLine(text)]);
    for (let chunkBytes = 1; chunkBytes <= 40; chunkBytes++) {
      const { texts } = await readAll(path, { chunkBytes });
      assert.equal(JSON.parse(texts[0]).message.content[0].text, text,
        `chunkBytes=${chunkBytes} corrupted a multi-byte character`);
    }
  });

  it('an offset past the end of the file yields nothing', async () => {
    const path = transcript(['a', 'bb']);
    assert.deepEqual((await readAll(path, { from: 5 })).texts, []);
    assert.deepEqual((await readAll(path, { from: 500 })).texts, [],
      'a file truncated below a stored cursor yields nothing — the caller starts over');
  });

  it('a missing, empty or nonsense path yields nothing and does not throw', async () => {
    const { readForward } = await T();
    for (const p of ['', '   ', join(makeDataDir(), 'no-such-file.jsonl'), makeDataDir(),
      null, undefined, 42]) {
      assert.deepEqual([...readForward(/** @type {any} */ (p))], [], `threw or yielded on ${p}`);
    }
  });
});

// ---------------------------------------------------------------------------
// The bound
// ---------------------------------------------------------------------------

describe('readForward — the line cap', () => {
  /**
   * A committed bundle's inline sourcemap is ~700 KB on one line and an offloaded tool
   * result's preview can be larger, so an unbounded reader's memory is a function of what the
   * model happened to paste. The cap is reported rather than applied silently: an import that
   * skipped a line should be able to say so.
   */
  it('a line over the cap is skipped, reported, and does not stop the file', async () => {
    const path = transcript([userLine('before'), `{"big":"${'x'.repeat(5000)}"}`, userLine('after')]);
    const { lines } = await readAll(path, { maxLineBytes: 1024, chunkBytes: 256 });

    assert.equal(lines.length, 3, 'the oversize line is reported, not dropped from the count');
    assert.equal(lines[1].oversize, true);
    assert.equal(lines[1].text, '', 'and is never materialised');
    assert.ok(lines[1].bytes > 5000, 'its size is still reported');
    assert.equal(JSON.parse(lines[2].text).message.content[0].text, 'after',
      'the reader resumes at the next line rather than giving up on the file');
  });

  it('the offset stays correct across an oversize line', async () => {
    const big = `{"big":"${'x'.repeat(5000)}"}`;
    const path = transcript([userLine('before'), big, userLine('after')]);
    const { lines } = await readAll(path, { maxLineBytes: 1024, chunkBytes: 256 });
    const resumed = await readAll(path, { from: lines[1].offset, maxLineBytes: 1024 });
    assert.equal(resumed.texts.length, 1);
    assert.equal(JSON.parse(resumed.texts[0]).message.content[0].text, 'after');
  });

  it('two oversize lines in a row are each reported', async () => {
    const big = (n) => `{"big":"${'x'.repeat(n)}"}`;
    const path = transcript([big(4000), big(6000), userLine('after')]);
    const { lines } = await readAll(path, { maxLineBytes: 512, chunkBytes: 128 });
    assert.deepEqual(lines.map((l) => l.oversize), [true, true, false]);
  });
});

// ---------------------------------------------------------------------------
// statOf
// ---------------------------------------------------------------------------

test('statOf reports size and mtime, and 0 for anything unreadable', async () => {
  const { statOf } = await T();
  const path = transcript(['a', 'bb']);
  const st = statOf(path);
  assert.equal(st.size, 5);
  assert.ok(st.mtimeMs > 0);
  assert.deepEqual(statOf(join(makeDataDir(), 'nope.jsonl')), { size: 0, mtimeMs: 0 });
  assert.deepEqual(statOf(/** @type {any} */ (null)), { size: 0, mtimeMs: 0 });
});

// ---------------------------------------------------------------------------
// The record inside a line
// ---------------------------------------------------------------------------

describe('messageRecord / messageText / renderEntry', () => {
  it('finds the record under message (Claude Code) and under payload (Codex)', async () => {
    const { messageRecord } = await T();
    assert.deepEqual(messageRecord({ message: { role: 'user', content: 'hi' } }),
      { role: 'user', content: 'hi' });
    assert.deepEqual(messageRecord({ type: 'response_item', payload: { role: 'user', content: 'hi' } }),
      { role: 'user', content: 'hi' });
  });

  // The Codex branch is taken on a positive signal, because a rollout is mostly machinery and
  // one of those payloads carries a base64 blob big enough to fill a read window on its own.
  it('a payload that is not conversation falls through to the envelope', async () => {
    const { messageRecord } = await T();
    const entry = { type: 'turn_context', payload: { cwd: '/r', model: 'x' }, role: 'system' };
    assert.equal(messageRecord(entry).role, 'system');
  });

  it('reads text, Codex text spellings and thinking blocks', async () => {
    const { messageText } = await T();
    assert.equal(messageText('bare'), 'bare');
    assert.equal(messageText([{ type: 'text', text: 'a' }, { type: 'input_text', text: 'b' },
      { type: 'output_text', text: 'c' }]), 'a\nb\nc');
    assert.equal(messageText({ type: 'thinking', thinking: 'hmm' }), 'hmm');
  });

  /**
   * The inverted rule, and the reason this module exists at all.
   *
   * `checkpoint.mjs` drops tool blocks because on a live session `capture.mjs` has already
   * stored them item by item. On a transcript from before the plugin was installed nothing
   * was ever captured, so those blocks are not a duplicate of the record — they are it.
   */
  it('drops tool blocks by default and renders results under includeTools', async () => {
    const { messageText } = await T();
    const content = [
      { type: 'text', text: 'running it' },
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'total 8\ndrwxr-xr-x' },
    ];
    assert.equal(messageText(content), 'running it',
      'the default is the two existing callers` behaviour, unchanged');
    assert.equal(messageText(content, { includeTools: true }),
      'running it\ntotal 8\ndrwxr-xr-x');
  });

  it('follows a tool_result whose content is itself a block array', async () => {
    const { messageText } = await T();
    assert.equal(messageText([{
      type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'nested' }],
    }], { includeTools: true }), 'nested');
  });

  /**
   * A `tool_use`'s parameters are deliberately NOT rendered, even under `includeTools`. They
   * go through `redactParams` first, and a renderer that produced the text before the
   * scrubber ran would be a redaction bypass with a comment on it.
   */
  it('never renders a tool_use input, whatever the options say', async () => {
    const { messageText } = await T();
    const content = [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'echo SECRET' } }];
    for (const opts of [{}, { includeTools: true }]) {
      assert.equal(messageText(content, opts), '', `rendered a raw tool input under ${JSON.stringify(opts)}`);
    }
  });

  it('renderEntry prefixes the role, and returns an unparseable line verbatim', async () => {
    const { renderEntry } = await T();
    assert.equal(renderEntry(userLine('hello')), 'user: hello');
    assert.equal(renderEntry('not json at all'), 'not json at all');
    assert.equal(renderEntry(''), '');
    assert.equal(renderEntry(line({ type: 'user', message: { role: 'user', content: [] } })), '',
      'a record with no text renders nothing rather than a bare role');
  });
});

// ---------------------------------------------------------------------------
// toolBlocks — the join nothing in this tree did before
// ---------------------------------------------------------------------------

describe('toolBlocks', () => {
  /**
   * `tool_use` and `tool_result` are on different lines — the call on an `assistant` line,
   * the result on a `user` line — joined only by id. Every live hook is handed both halves in
   * one payload, so nothing here ever had to join them.
   *
   * The join is mandatory rather than convenient: `hasDeniedSubject` reads `PATH_KEYS` off
   * the *call*, and the file body arrives on the *result* line with no path field on it at
   * all. A reader that walks lines independently gets the contents of a `.env` with no
   * stage-2 protection.
   */
  it('reads the call off an assistant line and the result off a user line', async () => {
    const { toolBlocks, parseLine } = await T();

    const call = parseLine(line({
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'text', text: 'let me look' },
        { type: 'tool_use', id: 'toolu_01A', name: 'Read', input: { file_path: '/r/.env' } },
      ] },
    }));
    const result = parseLine(line({
      type: 'user',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_01A', content: 'OPENAI_API_KEY=sk-x' },
      ] },
    }));

    const a = toolBlocks(/** @type {any} */ (call));
    assert.deepEqual(a.uses, [{ id: 'toolu_01A', name: 'Read', input: { file_path: '/r/.env' } }]);
    assert.deepEqual(a.results, []);

    const b = toolBlocks(/** @type {any} */ (result));
    assert.deepEqual(b.uses, []);
    assert.equal(b.results.length, 1);
    assert.equal(b.results[0].id, 'toolu_01A', 'and the id is what joins them');
    assert.equal(b.results[0].content, 'OPENAI_API_KEY=sk-x');
  });

  it('carries is_error through, and ignores blocks with no id', async () => {
    const { toolBlocks } = await T();
    const r = toolBlocks({ message: { content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true },
      { type: 'tool_result', content: 'no id' },
      { type: 'tool_use', name: 'Bash', input: {} },
    ] } });
    assert.deepEqual(r.results, [{ id: 't1', content: 'boom', isError: true }]);
    assert.deepEqual(r.uses, [], 'a tool_use with no id cannot be joined to anything');
  });

  it('answers empty for every shape that is not a content array', async () => {
    const { toolBlocks } = await T();
    for (const e of [null, undefined, 42, {}, { message: {} }, { message: { content: 'text' } },
      { message: { content: [null, 3, 'x'] } }]) {
      assert.deepEqual(toolBlocks(/** @type {any} */ (e)), { uses: [], results: [] });
    }
  });
});
