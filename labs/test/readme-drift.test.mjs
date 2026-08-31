// @ts-check
/**
 * The cheap canary: everything the walkthrough names must still exist. A renamed hook, a
 * dropped payload, a retired tool or a new route turns a lab into a dead end silently -
 * this file is what turns it into a red test instead.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { LAB_ROOT, REPO_ROOT, labState, startFake, driveMcp, deriveLabRunId } from './helpers.mjs';

const README = readFileSync(join(LAB_ROOT, 'README.md'), 'utf8');

test('every hooks/src file the README names exists', () => {
  const named = new Set([...README.matchAll(/hooks\/src\/([a-z-]+\.mjs)/g)].map((m) => m[1]));
  assert.ok(named.size >= 7, `the file map names the hooks (found ${named.size})`);
  for (const f of named) {
    assert.ok(existsSync(join(REPO_ROOT, 'integrations/claude-code/hooks/src', f)),
      `hooks/src/${f} is named in the README and must exist`);
  }
});

test('every lib module the README names exists', () => {
  const named = new Set([...README.matchAll(/lib\/([a-z-]+\.mjs)/g)].map((m) => m[1]));
  for (const f of named) {
    assert.ok(existsSync(join(REPO_ROOT, 'integrations/claude-code/lib', f)),
      `lib/${f} is named in the README and must exist`);
  }
});

test('every payload the README names exists and parses', () => {
  const named = new Set([...README.matchAll(/(\d\d-[a-z-]+\.json)/g)].map((m) => m[1]));
  assert.ok(named.size >= 9, `the labs use the payloads (found ${named.size})`);
  for (const f of named) {
    const p = join(LAB_ROOT, 'payloads', f);
    assert.ok(existsSync(p), `labs/payloads/${f} is named in the README and must exist`);
    assert.doesNotThrow(() => JSON.parse(readFileSync(p, 'utf8')), `${f} parses as JSON`);
  }
  assert.ok(existsSync(join(LAB_ROOT, 'payloads', 'transcript.jsonl')), 'the Lab 9 transcript exists');
});

test('every route the README shows is one the fake instance serves', () => {
  const fakeSrc = readFileSync(join(LAB_ROOT, 'fake-mubit.mjs'), 'utf8');
  const named = new Set([...README.matchAll(/\/v2\/[a-z/]+/g)].map((m) => m[0]));
  assert.ok(named.size >= 8, `the walkthrough shows the wire (found ${named.size} routes)`);
  for (const route of named) {
    assert.ok(fakeSrc.includes(route), `${route} appears in the README but not in fake-mubit's route table`);
  }
});

test('the fake instance covers every route lib/http.mjs can dial', () => {
  const httpSrc = readFileSync(join(REPO_ROOT, 'integrations/claude-code/lib/http.mjs'), 'utf8');
  const fakeSrc = readFileSync(join(LAB_ROOT, 'fake-mubit.mjs'), 'utf8');
  const dialable = new Set([...httpSrc.matchAll(/['"`](\/v2\/[a-z/]+)/g)].map((m) => m[1]));
  assert.ok(dialable.size >= 8, `lib/http.mjs names its routes (found ${dialable.size})`);
  for (const route of dialable) {
    assert.ok(fakeSrc.includes(route),
      `lib/http.mjs can dial ${route} but fake-mubit does not serve it - a lab would 404`);
  }
});

test('every mubit_* tool the README names is served, and the count the prose claims holds', async () => {
  const st = labState();
  st.env.LAB_RUN_ID = deriveLabRunId(st.env);
  const fake = await startFake(st);
  try {
    const list = driveMcp(st, '--list');
    assert.equal(list.code, 0, list.stderr);
    const served = new Set([...list.stdout.matchAll(/^ {2}· (\S+)/gm)].map((m) => m[1]));
    assert.equal(served.size, 13, 'the README prose pins 13 allowlisted tools');
    const named = new Set([...README.matchAll(/\bmubit_[a-z_]+\b/g)].map((m) => m[0]))
      // guard objects ride on results; they are fields, not tools
      .difference?.(new Set(['mubit_lessons_guard'])) ?? new Set();
    if (named.size === 0) {
      // Older Node without Set.difference: filter manually.
      for (const m of README.matchAll(/\bmubit_[a-z_]+\b/g)) {
        if (m[0] !== 'mubit_lessons_guard') named.add(m[0]);
      }
    }
    for (const tool of named) {
      assert.ok(served.has(tool), `${tool} is named in the README but the server does not serve it`);
    }
  } finally {
    await fake.stop();
    st.cleanup();
  }
});
