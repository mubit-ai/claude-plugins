// @ts-check
/**
 * `lib/codex-rollout.mjs` — the injected-text filter, and `firstUserText` reading through it.
 *
 * From Codex 0.149 the first `user` record of every thread is the host's own preamble — a
 * `<recommended_plugins>` listing and an `<environment_context>` block — and the prompt the
 * person typed is the record after it. `firstUserText` is the `Q:` of every Codex subagent
 * capture, so without the filter every subagent since that version has been stored as an
 * answer to a plugin listing. The outcome reader in this module is covered by the Codex
 * suite (`integrations/codex/test/codex-outcome.test.mjs`); this file is about the filter.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { lib, makeDataDir } from './helpers/harness.mjs';

let _mod;
const R = async () => (_mod ??= await lib('codex-rollout.mjs'));

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

const META = {
  type: 'session_meta',
  payload: { id: '01a0-thread', cwd: '/r/app', cli_version: '0.153.4', thread_source: 'subagent' },
};

/** A `user` record with one `input_text` block per argument, the way Codex writes one. */
const user = (...texts) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: texts.map((text) => ({ type: 'input_text', text })) },
});

const PREAMBLE = [
  '<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n</recommended_plugins>',
  '<environment_context>\n  <cwd>/r/app</cwd>\n  <shell>zsh</shell>\n</environment_context>',
];

function rollout(records) {
  const p = join(makeDataDir(), 'rollout-2026-09-07T12-00-00-01a0-thread.jsonl');
  writeFileSync(p, jsonl(records));
  return p;
}

describe('isInjectedUserText', () => {
  it('recognises every envelope the host writes in a user\'s voice', async () => {
    const { isInjectedUserText } = await R();
    for (const text of [
      '<environment_context>\n  <cwd>/r/app</cwd>\n</environment_context>',
      '<recommended_plugins>\nHere is a list',
      '<turn_aborted>\nThe previous turn was aborted',
      '<user_shell_command>ls -la</user_shell_command>',
      '<skill name="x">…',
      '<image src="…"/>',
      '# AGENTS.md instructions for /r/app\n\n…',
      '# Files mentioned by the user\n…',
      '  <environment_context>leading whitespace is still the host',
    ]) {
      assert.equal(isInjectedUserText(text), true, `should be injected: ${JSON.stringify(text.slice(0, 40))}`);
    }
  });

  it('leaves what a person typed alone, including a quoted tag mid-sentence', async () => {
    const { isInjectedUserText } = await R();
    for (const text of [
      'fix the auth bug',
      'why does <environment_context> show the wrong cwd?',
      'AGENTS.md says to run the linter first',
      '',
      /** @type {any} */ (null),
      /** @type {any} */ (42),
    ]) {
      assert.equal(isInjectedUserText(text), false, `should be a person: ${JSON.stringify(text)}`);
    }
  });

  it('stripInjectedBlocks removes whole blocks and keeps the rest in order', async () => {
    const { stripInjectedBlocks } = await R();
    const content = [
      { type: 'input_text', text: PREAMBLE[0] },
      { type: 'input_text', text: 'do the thing' },
      { type: 'input_text', text: PREAMBLE[1] },
      { type: 'input_image', image_url: 'data:…' },
    ];
    assert.deepEqual(stripInjectedBlocks(content), [content[1], content[3]]);
    assert.equal(stripInjectedBlocks(PREAMBLE[0]), '', 'a string is one block');
    assert.equal(stripInjectedBlocks('do the thing'), 'do the thing');
    assert.equal(stripInjectedBlocks(undefined), undefined, 'anything unrecognised passes through');
  });
});

describe('firstUserText', () => {
  it('skips the 0.149+ preamble and returns the task on the record after it', async () => {
    const { firstUserText } = await R();
    const path = rollout([META, user(...PREAMBLE), user('Find every call site of drain() and list them.')]);
    assert.equal(firstUserText(path), 'Find every call site of drain() and list them.');
  });

  it('keeps a task that shares its record with an injected block', async () => {
    const { firstUserText } = await R();
    const path = rollout([META, user(PREAMBLE[1], 'do the thing')]);
    assert.equal(firstUserText(path), 'do the thing');
  });

  it('answers nothing when the only user text is the host\'s', async () => {
    const { firstUserText } = await R();
    const path = rollout([META, user(...PREAMBLE)]);
    assert.equal(firstUserText(path), '', 'the caller falls back to the parent\'s staged prompt');
  });

  it('still reads a pre-0.149 rollout, whose first user record is the prompt', async () => {
    const { firstUserText } = await R();
    const path = rollout([
      { ...META, payload: { ...META.payload, cli_version: '0.146.0' } },
      user('Summarise the failing tests.'),
    ]);
    assert.equal(firstUserText(path), 'Summarise the failing tests.');
  });
});
