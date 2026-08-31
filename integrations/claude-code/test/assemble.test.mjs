// @ts-check
/**
 * `lib/assemble.mjs` — client-side section assembly (§4.10, test plan §12.5).
 *
 * Why this module exists at all: rungs 1 and 2 of the read ladder return `evidence[]`,
 * not a preassembled `context_block`. This module does what rung 3
 * (`POST /v2/control/context`) would have done server-side — for **zero LLM calls**
 * instead of two (§1.8). Every assertion below protects the property that makes that
 * substitution honest: the client must render the same shape, in the same order, with
 * the same `emptyReason` vocabulary the server would have used, so downstream code is
 * rung-agnostic.
 *
 * These tests are written before the implementation. Failing with
 * "lib/assemble.mjs does not exist yet" is the expected red state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { lib, evidence } from './helpers/harness.mjs';

const load = () => lib('assemble.mjs');

// ---------------------------------------------------------------------------
// Reference tables, transcribed from the guide
// ---------------------------------------------------------------------------

/** The 17 LTM entry types (§1.6). */
const ENTRY_TYPES = [
  'fact', 'trace', 'archive_block', 'lesson', 'rule', 'handoff', 'feedback',
  'observation', 'tool_output', 'tool_input', 'reflection', 'task_result', 'log',
  'checkpoint', 'step_outcome', 'mental_model', 'workflow',
];

/** Section keys (§1.3, `control.proto`). Nothing may be invented outside this set. */
const SECTION_KEYS = [
  'mental_models', 'active_rules', 'lessons', 'archive_blocks', 'handoffs', 'feedback',
  'facts', 'observations', 'working_memory', 'traces', 'goals', 'checkpoints', 'logs',
  'other',
];

/**
 * The §4.10 `entry_type → section` table, verbatim.
 *
 * NOTE for whoever implements this: the table's last row is literally "anything else →
 * `other`", so `handoff`, `feedback`, `reflection`, `log` and `workflow` land in `other`
 * even though §1.3 defines `handoffs`, `feedback` and `logs` section keys. If that is
 * ever changed, change it here first — this table is the spec.
 */
const SECTION_FOR = {
  mental_model: 'mental_models',
  rule: 'active_rules',
  lesson: 'lessons',
  fact: 'facts',
  observation: 'observations',
  working_memory: 'working_memory',
  goal: 'working_memory',
  trace: 'traces',
  tool_output: 'traces',
  tool_input: 'traces',
  task_result: 'traces',
  step_outcome: 'traces',
  archive_block: 'archive_blocks',
  checkpoint: 'checkpoints',
  handoff: 'other',
  feedback: 'other',
  reflection: 'other',
  log: 'other',
  workflow: 'other',
};

/** Server-fixed emission order (§1.3 / §4.10, `control.proto`). */
const EMISSION_ORDER = [
  'mental_models', 'active_rules', 'lessons', 'facts', 'observations',
  'working_memory', 'traces', 'goals',
];

/**
 * Markdown headings in the rendered block, normalized back to section keys:
 * "## Active rules" → "active_rules", "## Working memory" → "working_memory".
 */
function headingSections(block) {
  const out = [];
  for (const m of String(block).matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm)) {
    out.push(m[1].toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''));
  }
  return out;
}

/** One evidence item with a unique, short, hard-to-truncate-away marker in its content. */
function item(i, over = {}) {
  return evidence({
    id: `e${i}`,
    reference_id: `ref_${i}`,
    entry_type: 'fact',
    score: 0.5,
    content: `zzq${i} an accepted ingest job stays queued until indexing completes`,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// sectionFor
// ---------------------------------------------------------------------------

// §12.5 + §4.10: every one of the 17 LTM entry types maps to a section; nothing lands in
// `other` unless the §4.10 table genuinely has no row for it.
test('sectionFor maps all 17 LTM entry types per the §4.10 table', async () => {
  const { sectionFor } = await load();
  for (const et of ENTRY_TYPES) {
    assert.equal(sectionFor(et), SECTION_FOR[et], `entry_type "${et}" mapped wrong`);
  }
  const inOther = ENTRY_TYPES.filter((et) => SECTION_FOR[et] === 'other');
  assert.deepEqual(inOther, ['handoff', 'feedback', 'reflection', 'log', 'workflow'],
    'the set of unmapped types is a spec decision — change the table, not the test');
});

// §4.10: `working_memory` and `goal` are intent/section inputs that both collapse onto
// the single `working_memory` section.
test('sectionFor collapses working_memory and goal onto working_memory', async () => {
  const { sectionFor } = await load();
  assert.equal(sectionFor('working_memory'), 'working_memory');
  assert.equal(sectionFor('goal'), 'working_memory');
});

// §4.10: the five trace-shaped types share one section, so a turn's tool traffic renders
// as one block rather than five near-empty headings.
test('sectionFor folds every trace-shaped type into traces', async () => {
  const { sectionFor } = await load();
  for (const et of ['trace', 'tool_output', 'tool_input', 'task_result', 'step_outcome']) {
    assert.equal(sectionFor(et), 'traces', `${et} must render under traces`);
  }
});

// §1.3: the section vocabulary is fixed by control.proto — the client may never invent a key.
test('sectionFor only ever returns a documented section key', async () => {
  const { sectionFor } = await load();
  for (const et of [...ENTRY_TYPES, 'working_memory', 'goal', '', 'not_a_type', 'RULE']) {
    const s = sectionFor(et);
    assert.equal(typeof s, 'string', `sectionFor(${JSON.stringify(et)}) must return a string`);
    assert.ok(SECTION_KEYS.includes(s),
      `sectionFor(${JSON.stringify(et)}) returned "${s}", which is not a control.proto section key`);
  }
});

// §4.10: unknown/blank types fall through to `other` rather than throwing — this runs
// inside a 1500 ms blocking budget and must never take the prompt down with it.
test('sectionFor sends unknown and blank entry types to other', async () => {
  const { sectionFor } = await load();
  assert.equal(sectionFor('some_future_type'), 'other');
  assert.equal(sectionFor(''), 'other');
});

// §4.10: "maps entry_type (or origin_entry_type when the entry came through an overlay)".
// The overlay's own type is bookkeeping; the origin is what the user needs to read.
test('an overlay entry routes by origin_entry_type, not entry_type', async () => {
  const { assembleContext } = await load();
  const r = assembleContext(
    [item(1, { entry_type: 'trace', origin_entry_type: 'rule' })],
    { tokenBudget: 1500 },
  );
  const sections = r.sections.map((s) => s.section);
  assert.ok(sections.includes('active_rules'),
    `origin_entry_type "rule" must render under active_rules; got ${JSON.stringify(sections)}`);
  assert.ok(!sections.includes('traces'), 'the overlay type must not win');
});

// ---------------------------------------------------------------------------
// Emission order
// ---------------------------------------------------------------------------

// §1.3/§4.10 (control.proto): response order is server-fixed, so a user who
// switches rungs (or whose operator flips the instance's direct-search policy) sees the exact
// same shape. Input order must be irrelevant.
test('sections emit in the server-fixed order regardless of input order', async () => {
  const { assembleContext } = await load();
  // Deliberately fed in reverse of the documented order.
  const ev = [
    item(1, { entry_type: 'trace', reference_id: 'ref_trace' }),
    item(2, { entry_type: 'working_memory', reference_id: 'ref_wm' }),
    item(3, { entry_type: 'observation', reference_id: 'ref_obs' }),
    item(4, { entry_type: 'fact', reference_id: 'ref_fact' }),
    item(5, { entry_type: 'lesson', reference_id: 'ref_lesson' }),
    item(6, { entry_type: 'rule', reference_id: 'ref_rule' }),
    item(7, { entry_type: 'mental_model', reference_id: 'ref_mm' }),
  ];
  const expected = [
    'mental_models', 'active_rules', 'lessons', 'facts', 'observations',
    'working_memory', 'traces',
  ];

  const r = assembleContext(ev, { tokenBudget: 4000 });

  assert.deepEqual(
    r.sections.map((s) => s.section).filter((s) => EMISSION_ORDER.includes(s)),
    expected,
    'SectionSummary[] must follow the server order');
  assert.deepEqual(
    headingSections(r.block).filter((h) => EMISSION_ORDER.includes(h)),
    expected,
    'rendered headings must follow the server order');
});

// SectionSummary mirrors the server's `section_summaries` ({section, count}) so the status
// line and the doctor skill read one shape whichever rung served.
test('each SectionSummary carries a section key and a positive count', async () => {
  const { assembleContext } = await load();
  const r = assembleContext(
    [item(1, { entry_type: 'rule' }), item(2, { entry_type: 'rule' }), item(3, { entry_type: 'fact' })],
    { tokenBudget: 4000 },
  );
  for (const s of r.sections) {
    assert.ok(SECTION_KEYS.includes(s.section), `unknown section key "${s.section}"`);
    assert.equal(typeof s.count, 'number');
    assert.ok(s.count > 0, 'empty sections must not be summarized');
  }
  const rules = r.sections.find((s) => s.section === 'active_rules');
  assert.equal(rules.count, 2);
});

// ---------------------------------------------------------------------------
// Token budget
// ---------------------------------------------------------------------------

// §4.10: budget enforcement is what keeps MUBIT_CC_RECALL_TOKENS meaningful now that the
// server no longer applies max_token_budget for us on rungs 1-2.
test('a 100-token budget against 50 items renders under budget and reports drops', async () => {
  const { assembleContext, estimateTokens } = await load();
  const ev = Array.from({ length: 50 }, (_, i) => item(i, { score: 1 - i / 100 }));

  const r = assembleContext(ev, { tokenBudget: 100 });

  assert.ok(r.tokenEstimate <= 100, `tokenEstimate ${r.tokenEstimate} exceeds the 100-token budget`);
  assert.ok(estimateTokens(r.block) <= 100, 'the rendered block itself must fit the budget');
  assert.ok(r.dropped > 0, 'dropped must be reported so the status line can say "truncated", not "empty"');
  assert.equal(r.dropped, 50 - r.sourceRefIds.length,
    'dropped + rendered must account for every evidence item');
});

// §4.10: "Fill sections in the order above, items within a section by descending score."
// Section order outranks score — a low-scoring rule beats a high-scoring trace.
test('sections fill in the fixed order before score is considered', async () => {
  const { assembleContext } = await load();
  const ev = [
    ...Array.from({ length: 5 }, (_, i) => item(i, {
      entry_type: 'trace', reference_id: `ref_trace_${i}`, score: 0.99, content: `zzt${i} ${'T'.repeat(200)}`,
    })),
    item(9, { entry_type: 'rule', reference_id: 'ref_rule_low', score: 0.10, content: `zzr ${'R'.repeat(200)}` }),
  ];

  const r = assembleContext(ev, { tokenBudget: 120 });

  assert.equal(r.sourceRefIds[0], 'ref_rule_low',
    'active_rules precedes traces, so the 0.10-scored rule renders before any 0.99 trace');
  assert.ok(r.dropped > 0, 'a 120-token budget cannot hold six ~50-token items');
});

// §4.10: within a section, descending score — the best evidence survives the trim.
test('items inside a section are ordered by descending score', async () => {
  const { assembleContext } = await load();
  const ev = [
    item(1, { reference_id: 'ref_mid', score: 0.50 }),
    item(2, { reference_id: 'ref_low', score: 0.20 }),
    item(3, { reference_id: 'ref_high', score: 0.90 }),
  ];

  const r = assembleContext(ev, { tokenBudget: 4000 });

  assert.deepEqual(r.sourceRefIds, ['ref_high', 'ref_mid', 'ref_low']);
});

// §4.10: "prefer non-is_stale entries when trimming — the server returns stale entries for
// transparency but marks them" (control.proto).
test('a stale entry loses to a fresh entry of equal score', async () => {
  const { assembleContext } = await load();
  const ev = [
    item(1, { reference_id: 'ref_stale', score: 0.70, is_stale: true, content: `zzs ${'S'.repeat(400)}` }),
    item(2, { reference_id: 'ref_fresh', score: 0.70, is_stale: false, content: `zzf ${'F'.repeat(400)}` }),
  ];

  // ~100 tokens per item; 150 holds exactly one of them.
  const r = assembleContext(ev, { tokenBudget: 150 });

  assert.deepEqual(r.sourceRefIds, ['ref_fresh'], 'the fresh entry must win the last slot');
  assert.equal(r.dropped, 1);
});

/**
 * The mark has to reach the model. The server sends `is_stale` "for transparency", and this
 * module used it only as a sort key — so an entry it knew was stale was rendered
 * indistinguishably from a fresh one, under a heading like "Active rules". A qualifier the
 * client never renders qualifies nothing.
 */
test('a stale entry is rendered marked, and a fresh one is not', async () => {
  const { assembleContext } = await load();
  const ev = [
    item(1, { reference_id: 'ref_stale', score: 0.70, is_stale: true, content: 'old truth' }),
    item(2, { reference_id: 'ref_fresh', score: 0.90, is_stale: false, content: 'current truth' }),
  ];

  const r = assembleContext(ev, { tokenBudget: 4000 });

  assert.match(r.block, /- \(stale\) old truth/);
  assert.match(r.block, /- current truth/);
  assert.ok(!/\(stale\) current truth/.test(r.block), 'a fresh entry must not be marked');
});

// Same rule with room for both: the fresh entry still sorts first.
test('a fresh entry outranks a stale entry of equal score even when both fit', async () => {
  const { assembleContext } = await load();
  const ev = [
    item(1, { reference_id: 'ref_stale', score: 0.70, is_stale: true }),
    item(2, { reference_id: 'ref_fresh', score: 0.70, is_stale: false }),
  ];

  const r = assembleContext(ev, { tokenBudget: 4000 });

  assert.deepEqual(r.sourceRefIds, ['ref_fresh', 'ref_stale']);
  assert.equal(r.dropped, 0);
});

// ---------------------------------------------------------------------------
// emptyReason — the server's vocabulary, reproduced client-side
// ---------------------------------------------------------------------------

// §4.10: emptyReason reproduces the server's vocabulary so downstream code is rung-agnostic.
test('empty evidence yields emptyReason "no_evidence" and an empty block', async () => {
  const { assembleContext } = await load();
  const r = assembleContext([], { tokenBudget: 1500 });
  assert.equal(r.emptyReason, 'no_evidence');
  assert.equal(r.block, '');
  assert.deepEqual(r.sourceRefIds, []);
  assert.equal(r.dropped, 0);
  assert.equal(r.tokenEstimate, 0);
});

// §4.10: evidence existed but nothing fit — distinct from "there was nothing to say".
// prompt-recall needs the distinction to report "budget-truncated" rather than "empty".
test('evidence that cannot fit the budget yields "budget_exhausted"', async () => {
  const { assembleContext } = await load();
  const ev = [item(1), item(2), item(3)];

  const r = assembleContext(ev, { tokenBudget: 1 });

  assert.equal(r.emptyReason, 'budget_exhausted');
  assert.deepEqual(r.sourceRefIds, []);
  assert.equal(r.dropped, 3);
});

// §4.10: `""` when something rendered — the same sentinel ContextResponse.empty_reason uses.
test('a rendered block yields an empty emptyReason', async () => {
  const { assembleContext } = await load();
  const r = assembleContext([item(1)], { tokenBudget: 1500 });
  assert.equal(r.emptyReason, '');
  assert.ok(r.block.length > 0);
});

// §4.10: "recency_fallback is server-only and never produced here." Emitting it client-side
// would make the status line claim a server behaviour that never happened.
test('recency_fallback is never produced by the client assembler', async () => {
  const { assembleContext } = await load();
  const cases = [
    assembleContext([], { tokenBudget: 1500 }),
    assembleContext([item(1)], { tokenBudget: 1 }),
    assembleContext([item(1), item(2)], { tokenBudget: 1500 }),
  ];
  for (const r of cases) {
    assert.notEqual(r.emptyReason, 'recency_fallback');
    assert.ok(['', 'no_evidence', 'budget_exhausted'].includes(r.emptyReason),
      `emptyReason "${r.emptyReason}" is outside the documented vocabulary`);
  }
});

// ---------------------------------------------------------------------------
// sourceRefIds — the attribution surface
// ---------------------------------------------------------------------------

// §4.10/§5.5: sourceRefIds is what Stop attributes against. A rendered item missing from it
// is a memory that silently never gets reinforced — the learning loop breaks with no error.
test('sourceRefIds contains exactly the rendered items, and nothing else', async () => {
  const { assembleContext } = await load();
  const ev = Array.from({ length: 12 }, (_, i) => item(i, {
    reference_id: `ref_${i}`,
    score: 1 - i / 100,
    content: `zzq${i} ${'x'.repeat(100)}`,
  }));

  const r = assembleContext(ev, { tokenBudget: 60 });

  assert.ok(r.dropped > 0, 'this fixture is only meaningful when the budget actually trims');
  for (let i = 0; i < ev.length; i++) {
    const rendered = r.block.includes(`zzq${i}`);
    const attributed = r.sourceRefIds.includes(`ref_${i}`);
    assert.equal(attributed, rendered,
      `ref_${i}: rendered=${rendered} but sourceRefIds membership=${attributed}`);
  }
  assert.equal(new Set(r.sourceRefIds).size, r.sourceRefIds.length, 'no duplicate reference ids');
});

// reference_id, not id — the field that RecordOutcome.entry_ids consumes
// (control.proto). The fixture gives them different values on purpose.
test('sourceRefIds carries reference_id, never the evidence id', async () => {
  const { assembleContext } = await load();
  const r = assembleContext(
    [evidence({ id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule', content: 'poll the job' })],
    { tokenBudget: 1500 },
  );
  assert.deepEqual(r.sourceRefIds, ['ref_rule_1']);
  assert.ok(!r.sourceRefIds.includes('e1'), 'the `id` field must never reach attribution');
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

// §4.10: "~4 chars per token. Deliberately cheap — this runs inside a 1500 ms blocking
// budget." Roughly right beats exactly right here; a real tokenizer would blow the budget.
test('estimateTokens is monotonic in input length', async () => {
  const { estimateTokens } = await load();
  let prev = -1;
  for (const n of [0, 1, 4, 10, 100, 1000, 10000]) {
    const t = estimateTokens('x'.repeat(n));
    assert.equal(typeof t, 'number');
    assert.ok(Number.isFinite(t), `estimateTokens(${n} chars) must be finite`);
    assert.ok(t >= prev, `estimateTokens regressed at ${n} chars: ${t} < ${prev}`);
    prev = t;
  }
});

test('estimateTokens is roughly four characters per token', async () => {
  const { estimateTokens } = await load();
  assert.equal(estimateTokens(''), 0);
  const small = estimateTokens('y'.repeat(400));
  assert.ok(small >= 70 && small <= 140, `400 chars estimated at ${small} tokens`);
  const big = estimateTokens('y'.repeat(4000));
  assert.ok(big >= 700 && big <= 1400, `4000 chars estimated at ${big} tokens`);
});

// ---------------------------------------------------------------------------
// The cross-turn seen-set — a repeat is degraded, never dropped
// ---------------------------------------------------------------------------

/*
 * §4.10 renders one block. Nothing in it knew about the *previous* block, so a lesson that
 * stays relevant for twenty prompts was rendered twenty times at full price and all twenty
 * copies sat in the transcript competing with each other.
 *
 * `seen` is the set of `reference_id`s already injected in this run (`lib/seen.mjs`). An
 * entry in it renders as a pointer — the id plus its first clause — instead of its whole
 * content.
 *
 * **The single most important property in this section:** a pointer still pushes its
 * `reference_id` into `sourceRefIds`. That array is what `Stop` attributes against and what
 * becomes `RecordOutcome.entry_ids` (control.proto). Dropping a repeat would silently stop
 * reinforcing precisely the memories that are helping most, which is the exact opposite of
 * what `record_outcome` is for.
 */

/** ~200 tokens — the per-memory size a 1500-token budget over six memories implies. */
const longContent = (tag, ch) => `${tag} because ${ch.repeat(760)} TAIL_${tag}`;

const RULE = () => evidence({
  id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule', score: 0.91,
  content: 'Ingest returns when queued, not when stored; poll the job until it completes.',
});

test('a seen entry renders as a pointer instead of its whole content', async () => {
  const { assembleContext } = await load();
  const ev = [evidence({
    id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule',
    content: longContent('RULE', 'r'),
  })];

  const first = assembleContext(ev, { tokenBudget: 1500 });
  const repeat = assembleContext(ev, { tokenBudget: 1500, seen: new Set(['ref_rule_1']) });

  assert.ok(first.block.includes('TAIL_RULE'), 'the first injection carries the whole entry');
  assert.ok(!repeat.block.includes('TAIL_RULE'),
    'the repeat must not re-send the body the model has already been given');
  assert.ok(repeat.block.includes('ref_rule_1'),
    'the pointer names the reference id, which is the handle mubit_dereference takes');
  assert.ok(repeat.block.includes('RULE because'),
    'the first clause is what lets the model recognise which memory is being pointed at');
});

// THE assertion of this section. See the note above: attribution is the reason to degrade
// rather than drop.
test('a pointer still reaches sourceRefIds, so Stop can attribute against it', async () => {
  const { assembleContext } = await load();
  const ev = [
    evidence({ id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule', content: longContent('RULE', 'r') }),
    evidence({ id: 'e2', reference_id: 'ref_lesson_1', entry_type: 'lesson', content: longContent('LESSON', 'l') }),
  ];

  const r = assembleContext(ev, { tokenBudget: 1500, seen: ['ref_rule_1', 'ref_lesson_1'] });

  assert.deepEqual(r.sourceRefIds, ['ref_rule_1', 'ref_lesson_1'],
    'every pointed-at memory must still be reinforceable — dropping it would stop crediting '
    + 'exactly the entries that stayed relevant longest');
  assert.equal(r.emptyReason, '', 'a block of pointers is a rendered block, not an empty one');
  assert.equal(r.dropped, 0, 'a degraded entry is not a dropped one');
});

test('a seen entry is far cheaper as a pointer than in full', async () => {
  const { assembleContext } = await load();
  const ev = [evidence({
    id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule',
    content: longContent('RULE', 'r'),
  })];

  const full = assembleContext(ev, { tokenBudget: 1500 }).tokenEstimate;
  const pointed = assembleContext(ev, { tokenBudget: 1500, seen: ['ref_rule_1'] }).tokenEstimate;

  assert.ok(pointed * 3 < full,
    `a pointer cost ${pointed} tokens against ${full} for the full entry — the saving is the `
    + 'whole reason this path exists, and under 3x it is not worth the complexity');
});

test('the rendered result reports how many entries were degraded', async () => {
  const { assembleContext } = await load();
  const ev = [
    evidence({ id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule', content: longContent('RULE', 'r') }),
    evidence({ id: 'e2', reference_id: 'ref_lesson_1', entry_type: 'lesson', content: longContent('LESSON', 'l') }),
  ];

  assert.equal(assembleContext(ev, { tokenBudget: 1500 }).pointers, 0);
  assert.equal(assembleContext(ev, { tokenBudget: 1500, seen: ['ref_rule_1'] }).pointers, 1,
    'the count is what tells a reader the saving came from this mechanism and not from an '
    + 'empty recall');
});

test('an unseen entry in the same block still renders in full', async () => {
  const { assembleContext } = await load();
  const ev = [
    evidence({ id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule', content: longContent('RULE', 'r') }),
    evidence({ id: 'e2', reference_id: 'ref_lesson_1', entry_type: 'lesson', content: longContent('LESSON', 'l') }),
  ];

  const r = assembleContext(ev, { tokenBudget: 1500, seen: ['ref_rule_1'] });
  assert.ok(!r.block.includes('TAIL_RULE'), 'the seen rule is pointed at');
  assert.ok(r.block.includes('TAIL_LESSON'), 'the unseen lesson is new to the model and pays in full');
  assert.equal(r.pointers, 1);
});

// The opt-out. `recallRepeatMode: "full"` is the pre-seen-set behaviour, byte for byte.
test('repeatMode "full" ignores the seen set entirely', async () => {
  const { assembleContext } = await load();
  const ev = [evidence({
    id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule',
    content: longContent('RULE', 'r'),
  })];

  const baseline = assembleContext(ev, { tokenBudget: 1500 });
  const forced = assembleContext(ev, {
    tokenBudget: 1500, seen: ['ref_rule_1'], repeatMode: 'full',
  });

  assert.equal(forced.block, baseline.block,
    'repeatMode "full" must reproduce the block a pre-seen-set release rendered, byte for byte');
  assert.equal(forced.pointers, 0);
});

// A pointer that costs more than the thing it points at is a pessimisation wearing the
// costume of an optimisation. One-line lessons are common and are already cheap.
test('an entry shorter than its own pointer is rendered in full', async () => {
  const { assembleContext } = await load();
  const ev = [evidence({
    id: 'e1', reference_id: 'ref_a_rather_long_reference_id_here', entry_type: 'rule',
    content: 'Poll the job.',
  })];

  const r = assembleContext(ev, { tokenBudget: 1500, seen: ['ref_a_rather_long_reference_id_here'] });
  assert.ok(r.block.includes('Poll the job.'),
    'degrading a 13-character entry into a 40-character pointer spends tokens to save them');
  assert.equal(r.pointers, 0, 'a line that was not shortened was not degraded');
});

// §4.10: the server marks an entry stale for transparency, and a mark the client renders
// nowhere is a mark that does nothing. A pointer is still a rendered entry.
test('a seen entry that is stale keeps its stale mark on the pointer', async () => {
  const { assembleContext } = await load();
  const ev = [evidence({
    id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule', is_stale: true,
    content: longContent('RULE', 'r'),
  })];

  const r = assembleContext(ev, { tokenBudget: 1500, seen: ['ref_rule_1'] });
  assert.ok(r.block.includes('(stale)'),
    'staleness survives the second showing; the model still has to know not to trust it');
});

// The budget is the point: pointers are how a run with more relevant memory than budget
// stops choosing between "show the new one" and "keep showing the old one".
test('pointers free budget for entries that would otherwise be dropped', async () => {
  const { assembleContext } = await load();
  const ev = [
    evidence({ id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule', content: longContent('RULE', 'r') }),
    evidence({ id: 'e2', reference_id: 'ref_lesson_1', entry_type: 'lesson', content: longContent('LESSON', 'l') }),
  ];

  const tight = { tokenBudget: 250 };
  const cold = assembleContext(ev, tight);
  assert.equal(cold.dropped, 1, 'a 250-token budget holds one ~200-token entry, not two');

  const warm = assembleContext(ev, { ...tight, seen: ['ref_rule_1'] });
  assert.equal(warm.dropped, 0,
    'pointing at the entry the model already has is what makes room for the one it does not');
  assert.deepEqual(warm.sourceRefIds, ['ref_rule_1', 'ref_lesson_1']);
});

// The seam `prompt-recall.mjs` uses to keep a pointer's vocabulary out of the used-signal.
// See `test/attribution.test.mjs`: counting a reference id as "memory vocabulary" would make
// every degraded turn look like an ignored injection.
test('isPointerLine names the lines a caller must not tokenise', async () => {
  const { assembleContext, isPointerLine } = await load();
  const ev = [
    evidence({ id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule', content: longContent('RULE', 'r') }),
    evidence({ id: 'e2', reference_id: 'ref_lesson_1', entry_type: 'lesson', content: longContent('LESSON', 'l') }),
  ];

  const r = assembleContext(ev, { tokenBudget: 1500, seen: ['ref_rule_1'] });
  const lines = r.block.split('\n').filter((l) => l.startsWith('- '));

  assert.equal(lines.filter(isPointerLine).length, 1,
    'exactly the degraded line is recognisable as a pointer');
  assert.equal(isPointerLine('- Ingest returns when queued.'), false);
  assert.equal(isPointerLine('## Lessons'), false);
});

// `seen` arrives from `readSeen(...).ids`, but a caller with an array must not silently get
// full-price rendering — that failure is invisible until someone measures the tokens.
test('the seen set is accepted as a Set or an array, and a bad value is ignored', async () => {
  const { assembleContext } = await load();
  const ev = [evidence({
    id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule', content: longContent('RULE', 'r'),
  })];

  const asSet = assembleContext(ev, { tokenBudget: 1500, seen: new Set(['ref_rule_1']) });
  const asArray = assembleContext(ev, { tokenBudget: 1500, seen: ['ref_rule_1'] });
  assert.equal(asSet.block, asArray.block);

  for (const bad of [null, undefined, 'ref_rule_1', 42, {}]) {
    const r = assembleContext(ev, { tokenBudget: 1500, seen: /** @type {any} */ (bad) });
    assert.equal(r.pointers, 0, `seen=${JSON.stringify(bad)} must degrade nothing`);
    assert.ok(r.block.includes('TAIL_RULE'));
  }
});

// An entry with no `reference_id` can never be pointed at: there is no handle to print and
// nothing that could have put it in the seen set.
test('an entry with no reference_id is never rendered as a pointer', async () => {
  const { assembleContext } = await load();
  const ev = [evidence({
    id: 'e1', reference_id: '', entry_type: 'rule', content: longContent('RULE', 'r'),
  })];

  const r = assembleContext(ev, { tokenBudget: 1500, seen: [''] });
  assert.equal(r.pointers, 0);
  assert.ok(r.block.includes('TAIL_RULE'));
});

// §4.10's ordering rules are not suspended by the seen set: two runs with the same evidence
// and the same seen set must still produce the same block.
test('degrading an entry does not move it out of its section or its order', async () => {
  const { assembleContext } = await load();
  const ev = [
    RULE(),
    evidence({ id: 'e2', reference_id: 'ref_lesson_1', entry_type: 'lesson', content: longContent('LESSON', 'l') }),
    evidence({ id: 'e3', reference_id: 'ref_fact_1', entry_type: 'fact', content: longContent('FACT', 'f') }),
  ];

  const r = assembleContext(ev, { tokenBudget: 1500, seen: ['ref_lesson_1'] });
  assert.deepEqual(r.sections.map((s) => s.section), ['active_rules', 'lessons', 'facts'],
    'a pointer occupies the same slot in the same section as the entry it replaces');
  assert.deepEqual(r.sourceRefIds, ['ref_rule_1', 'ref_lesson_1', 'ref_fact_1']);
});
