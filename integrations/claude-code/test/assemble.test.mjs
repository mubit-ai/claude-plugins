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
