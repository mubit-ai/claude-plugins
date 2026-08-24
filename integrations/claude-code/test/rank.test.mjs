// @ts-check
/**
 * `lib/rank.mjs` — the prompt-shape rule behind `rank_by` (§5.2, W1-2).
 *
 * ---------------------------------------------------------------------------
 * What is being claimed, and what would falsify it
 * ---------------------------------------------------------------------------
 * Ask the plugin "where were we?" and recall answers with whatever is most **similar**,
 * because `/v2/control/query` fuses at the default weights — semantic 1.0, lexical 0.25,
 * recency 0.10. A handoff question wants the opposite emphasis, and `rank_by: "freshness"`
 * is the server-side dial for it: semantic 0.40, lexical 0.10, recency 0.50.
 *
 * The rule that decides which of those two a prompt gets is the entire risk in this change,
 * and it fails in exactly two directions:
 *
 *   1. **Under-firing** — a real handoff question is ranked by similarity and the user gets
 *      last month's most-relevant lesson instead of yesterday's work. That is the bug we
 *      already have, so every phrase the ticket names has a row below.
 *   2. **Over-firing** — the rule degrades into a substring match, fires on half of all
 *      prompts, and quietly re-ranks ordinary questions by recency. There is no error and no
 *      log line when this happens; recall just gets worse for everyone. The negatives are
 *      what stop it, and the sharp one is **"what's the latest version of esbuild"**: it
 *      contains `latest` and is not a handoff question at all.
 *
 * So: a `FRESHNESS` table and a `RELEVANCE` table, one assertion each, and the second table
 * is the load-bearing one. Deleting a row from it is how this rule rots.
 *
 * `'balanced'` is deliberately unreachable here — the rule is a two-way decision, and the
 * third mode exists only for an operator who sets it explicitly. `rankForRecall` is where
 * that precedence lives, and it gets its own group.
 *
 * These tests are written before the implementation. Failing with
 * "lib/rank.mjs does not exist yet" is the expected red state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { lib } from './helpers/harness.mjs';

// Lazy, so each test fails on its own with the "does not exist yet" message rather than
// aborting the whole file at import time.
let _mod;
const R = async () => (_mod ??= await lib('rank.mjs'));

// ---------------------------------------------------------------------------
// Freshness — every phrase the ticket names, in a prompt someone would actually type
// ---------------------------------------------------------------------------

/** `[prompt, which trigger it is here to pin]` */
const FRESHNESS = [
  ['where were we on the ingest bug?', 'where were we'],
  ['where did we leave off yesterday', 'where did we leave off'],
  ['remind me where we left off', 'left off'],
  ['what changed in the recall ladder?', 'what changed'],
  ['what has changed about the spool since I looked', 'what has changed'],
  ['catch me up on this branch', 'catch me up'],
  ['pick up where we left off', 'pick up where'],
  ['picking up where I stopped', 'picking up where'],
  ['what did we decide last session?', 'last session'],
  ['what was I working on in the previous session', 'previous session'],
  ['which files did I touch recently?', 'recently'],
  ["what's the latest on the promotion fixes?", 'latest'],
  ['how far did we get so far?', 'so far'],
  ['what is the current state of the worktree?', 'current state'],
  ['what has broken since yesterday?', 'since yesterday'],
  ['is the drain test still failing?', 'still failing'],
  ['are the manifests still broken after that rename', 'still broken'],
];

for (const [prompt, trigger] of FRESHNESS) {
  test(`rankForPrompt: "${trigger}" is a handoff question → freshness`, async () => {
    const { rankForPrompt } = await R();
    assert.equal(rankForPrompt(prompt), 'freshness',
      `${JSON.stringify(prompt)} is temporal or handoff-shaped: ranking it by similarity is `
      + 'the bug this rule exists to fix');
  });
}

// ---------------------------------------------------------------------------
// Relevance — the near-misses, which are what keep this from being a substring match
// ---------------------------------------------------------------------------

/**
 * Two kinds of row, and both matter:
 *
 *   - **Ordinary questions** carry no trigger at all. They are here because a rule that
 *     fires on them is not a rule, and because `why is the ingest job stuck in queued?` is
 *     the fixture prompt the rest of the suite asserts request bodies against — if it ever
 *     resolved to `freshness`, half a dozen unrelated tests would start describing a
 *     different query than the one they mean to.
 *   - **Vetoed near-misses** contain a trigger word and are still not handoff questions.
 *     `latest`, `so far` and `current state` are the three ambiguous triggers, and each one
 *     is ambiguous in a specific, nameable way: `latest` points at someone else's release,
 *     `so far as` is the idiom "as far as", and `current state of the art` is a survey
 *     question. A rule that cannot tell those apart re-ranks ordinary questions by recency.
 *
 * `[prompt, why it must not fire]`
 */
const RELEVANCE = [
  ['why is the ingest job stuck in queued?', 'the suite-wide fixture prompt — a diagnosis, not a handoff'],
  ['write a test for lib/assemble.mjs', 'a plain instruction'],
  ['explain how the circuit breaker decides to open', 'a question about how code works'],
  ['refactor classifyTurn so it reads the prompt argument it is given', 'an instruction'],
  ['add a rank_by field to the rung-1 request body', 'an instruction'],
  ['what does esbuild do with a top-level await in a bundle?', 'a question about a tool'],

  ["what's the latest version of esbuild", 'THE near-miss: "latest" pointing at a release, not at our work'],
  ['bump esbuild to the latest release', '"latest release" is someone else\'s version, not our state'],
  ['how do I read the latest docs for node:test', '"latest docs" is a lookup'],
  ['upgrade the plugin to the latest esbuild', 'an upgrade instruction that happens to say "latest"'],
  ['the redaction pass is sound so far as I can tell', '"so far as" is the idiom "as far as"'],
  ['what does the current state of the art look like for hybrid retrieval', '"state of the art" is a survey'],
];

for (const [prompt, why] of RELEVANCE) {
  test(`rankForPrompt: ${JSON.stringify(prompt.slice(0, 48))} → relevance`, async () => {
    const { rankForPrompt } = await R();
    assert.equal(rankForPrompt(prompt), 'relevance',
      `${JSON.stringify(prompt)} must NOT be re-ranked by recency — ${why}`);
  });
}

// ---------------------------------------------------------------------------
// Totality — this runs on the critical path of every prompt
// ---------------------------------------------------------------------------

// §4.9: recall must never take a prompt down, and this is the first thing that touches the
// prompt text. Anything that is not a string is simply not a handoff question.
test('rankForPrompt: junk in, "relevance" out, and never a throw', async () => {
  const { rankForPrompt } = await R();
  for (const junk of [undefined, null, '', '   ', 42, true, {}, [], Symbol('x')]) {
    assert.equal(rankForPrompt(/** @type {any} */ (junk)), 'relevance',
      `${String(junk)} must be answered, not thrown on`);
  }
});

// The rule is a two-way decision, and saying so in a test is what stops a later maintainer
// from quietly adding a third class the prompt text cannot justify.
test('rankForPrompt: only ever answers "freshness" or "relevance"', async () => {
  const { rankForPrompt } = await R();
  for (const [prompt] of [...FRESHNESS, ...RELEVANCE]) {
    assert.ok(['freshness', 'relevance'].includes(rankForPrompt(prompt)),
      `${JSON.stringify(prompt)} produced a third class; "balanced" is reachable only by `
      + 'explicit config, never by the rule');
  }
});

// Case and surrounding punctuation are not signal. A prompt is whatever the user typed.
test('rankForPrompt: the rule is case-insensitive', async () => {
  const { rankForPrompt } = await R();
  assert.equal(rankForPrompt('WHERE WERE WE?'), 'freshness');
  assert.equal(rankForPrompt('Catch Me Up, please'), 'freshness');
  assert.equal(rankForPrompt("WHAT'S THE LATEST VERSION OF ESBUILD"), 'relevance');
});

// The hooks hand it up to `MAX_QUERY_CHARS` (2000) of prompt. A trigger buried at the end of
// a long paste is still a trigger, and a long paste must not become a cost.
test('rankForPrompt: a long prompt is still classified', async () => {
  const { rankForPrompt } = await R();
  const long = `${'lorem ipsum dolor sit amet '.repeat(200)}so where were we?`;
  assert.equal(rankForPrompt(long), 'freshness');
  assert.equal(rankForPrompt('x'.repeat(4000)), 'relevance');
});

// ---------------------------------------------------------------------------
// `rankForRecall` — the auto gate, which is the whole precedence rule in one place
// ---------------------------------------------------------------------------

// The heuristic is what `auto` MEANS. It is not a fallback for a missing setting.
test('rankForRecall: auto runs the rule over the query text', async () => {
  const { rankForRecall } = await R();
  assert.equal(rankForRecall({ recallRankBy: 'auto' }, 'where were we?'), 'freshness');
  assert.equal(rankForRecall({ recallRankBy: 'auto' }, 'why is the ingest job stuck?'), 'relevance');
});

// An operator who names a mode has made a decision; a heuristic that overrode it would make
// the setting a suggestion. This is the assertion that keeps `balanced` reachable at all.
test('rankForRecall: an explicit mode wins over the rule, in both directions', async () => {
  const { rankForRecall } = await R();
  assert.equal(rankForRecall({ recallRankBy: 'balanced' }, 'where were we?'), 'balanced',
    'a configured mode must survive a prompt the rule would have re-ranked');
  assert.equal(rankForRecall({ recallRankBy: 'relevance' }, 'catch me up'), 'relevance',
    'pinning relevance is how an operator turns the rule off');
  assert.equal(rankForRecall({ recallRankBy: 'freshness' }, 'write a test'), 'freshness',
    'pinning freshness is how an operator turns it always-on');
});

// A cfg from an older cached `config.json`, or no cfg at all. `auto` is the default, so the
// absent key must behave as `auto` rather than as "off".
test('rankForRecall: a missing or unusable setting behaves as auto', async () => {
  const { rankForRecall } = await R();
  for (const cfg of [undefined, null, {}, { recallRankBy: '' }, { recallRankBy: 'nonsense' }]) {
    assert.equal(rankForRecall(/** @type {any} */ (cfg), 'where were we?'), 'freshness',
      `${JSON.stringify(cfg)} must fall back to the rule, not to silence`);
  }
});

// ---------------------------------------------------------------------------
// Where the rule does NOT live
// ---------------------------------------------------------------------------

// `lib/classify.mjs` looks like the obvious home — it "already classifies prompts". It does
// not: it classifies tool names and turn events off a static table, and `classifyTurn` takes
// a `prompt` argument it never reads. This asserts the rule stayed out of it, so nobody
// merges the two on the strength of the name.
test('the rule is not in lib/classify.mjs, which never reads a prompt', async () => {
  const classify = await lib('classify.mjs');
  assert.equal(typeof (/** @type {any} */ (classify).rankForPrompt), 'undefined',
    'lib/classify.mjs classifies tool names and turn events; prompt text is a different '
    + 'input with a different table, and merging them would give classifyTurn a reason to '
    + 'read the argument it deliberately ignores');
});
