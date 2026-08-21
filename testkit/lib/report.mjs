// @ts-check
/**
 * Turning trial records into something a person can act on.
 *
 * Two rules run through this file. First, **every row names its source** — a Stop duration
 * mined from a transcript and a recall time mined from a debug log are different kinds of
 * fact and are never averaged together. Second, **the noise floor prints above the result**,
 * because a +40 ms delta under a ±180 ms floor is not a small effect, it is no effect, and
 * a table that does not say so invites the wrong conclusion.
 */

import { fmt, fmtDelta, pairedDelta, signTest, summarise } from './stats.mjs';

/* -------------------------------------------------------------------------- */
/* a plain ASCII table, same column style as scripts/mubit-inspect.mjs         */
/* -------------------------------------------------------------------------- */

/**
 * @param {{key: string, label: string, align?: 'l'|'r'}[]} cols
 * @param {Record<string, any>[]} rows
 * @returns {string[]}
 */
export function table(cols, rows) {
  const width = cols.map((c) => Math.max(c.label.length, ...rows.map((r) => String(r[c.key] ?? '').length)));
  const pad = (s, w, a) => (a === 'r' ? String(s).padStart(w) : String(s).padEnd(w));
  const out = [cols.map((c, i) => pad(c.label, width[i], c.align)).join('  ')];
  out.push(width.map((w) => '─'.repeat(w)).join('  '));
  for (const r of rows) out.push(cols.map((c, i) => pad(r[c.key] ?? '', width[i], c.align)).join('  '));
  return out;
}

/* -------------------------------------------------------------------------- */
/* A/B                                                                         */
/* -------------------------------------------------------------------------- */

/** The metrics the A/B reports on, and how each is read. */
export const AB_METRICS = [
  { key: 'ttft_ms', label: 'ttft ms', dp: 0, note: 'time to first token — what the user waits' },
  { key: 'span_s', label: 'wall s', dp: 1, note: 'end-to-end wall clock' },
  { key: 'cost_usd', label: 'cost $', dp: 4, note: 'billed, dominated by cache creation' },
  { key: 'output_tokens', label: 'out tok', dp: 0, note: 'model output' },
  { key: 'cache_creation_tokens', label: 'cache w', dp: 0, note: 'cache writes — the plugin\'s context cost lands here' },
  { key: 'cache_read_tokens', label: 'cache r', dp: 0, note: 'cache reads' },
  { key: 'steps', label: 'turns', dp: 0, note: 'agent turns' },
];

/** @param {any[]} trials @param {string} arm @param {string} key @returns {Map<string, number>} */
function byPair(trials, arm, key) {
  const m = new Map();
  for (const t of trials) {
    if (t.arm !== arm) continue;
    if (!t.scoreable) continue;
    m.set(`${t.case}#${t.rep}`, Number(t[key]));
  }
  return m;
}

/**
 * Discard rep 1 of every (arm, case).
 *
 * The first rep of a pair pays for cache creation the later ones read back, so it is
 * systematically more expensive in a way that has nothing to do with the arm. Keeping it
 * would put that difference into whichever arm happened to run first.
 *
 * @param {any[]} trials @returns {any[]}
 */
export function dropWarmup(trials) {
  return trials.filter((t) => Number(t.rep) > 1);
}

/**
 * @param {object} o
 * @param {any[]} o.trials @param {string} o.treatment @param {string} o.control
 * @returns {{rows: any[], pairs: number}}
 */
export function abTable({ trials, treatment = 'treatment', control = 'control' }) {
  const rows = [];
  let pairs = 0;
  for (const m of AB_METRICS) {
    const a = byPair(trials, treatment, m.key);
    const b = byPair(trials, control, m.key);
    const d = pairedDelta(a, b);
    const st = signTest(d.deltas);
    pairs = Math.max(pairs, d.pairs);
    const sa = summarise([...a.values()]);
    const sb = summarise([...b.values()]);
    rows.push({
      metric: m.label,
      on: fmt(sa.p50, m.dp),
      off: fmt(sb.p50, m.dp),
      delta: fmtDelta(d.medianDelta, m.dp),
      iqr: d.q1 == null ? '—' : `${fmt(d.q1, m.dp)}..${fmt(d.q3, m.dp)}`,
      n: String(d.pairs),
      p: st.p == null ? '—' : st.p.toFixed(3),
      verdict: st.underpowered ? `underpowered (need ${st.minPairsForSignificance} pairs)` : (st.p != null && st.p < 0.05 ? 'significant' : 'not significant'),
    });
  }
  return { rows, pairs };
}

export const AB_COLS = [
  { key: 'metric', label: 'metric' },
  { key: 'on', label: 'on (p50)', align: 'r' },
  { key: 'off', label: 'off (p50)', align: 'r' },
  { key: 'delta', label: 'Δ median', align: 'r' },
  { key: 'iqr', label: 'Δ IQR', align: 'r' },
  { key: 'n', label: 'pairs', align: 'r' },
  { key: 'p', label: 'sign p', align: 'r' },
  { key: 'verdict', label: '' },
];

/**
 * The integrity block. Printed above every A/B table, never folded into it.
 *
 * @param {any[]} trials @param {string} pluginName
 * @returns {{lines: string[], sound: boolean}}
 */
export function integrity(trials, pluginName) {
  const lines = [];
  let sound = true;

  const treatments = trials.filter((t) => t.arm === 'treatment');
  const controls = trials.filter((t) => t.arm === 'control');

  const deadTreatment = treatments.filter((t) => !t.mubit?.loaded);
  if (deadTreatment.length) {
    sound = false;
    lines.push(`VOID  ${deadTreatment.length}/${treatments.length} treatment runs did not load ${pluginName} — they are controls wearing a treatment label`);
  }
  const dirtyControl = controls.filter((t) => t.mubit?.loaded);
  if (dirtyControl.length) {
    sound = false;
    lines.push(`VOID  ${dirtyControl.length}/${controls.length} control runs DID load ${pluginName} — the ambient install leaked past --settings`);
  }
  const wroteControl = controls.filter((t) => (t.mubit?.data_dir_entries || []).length);
  if (wroteControl.length) {
    sound = false;
    lines.push(`VOID  ${wroteControl.length} control runs wrote to their data dir — something plugin-shaped ran in the control arm`);
  }
  const errored = trials.filter((t) => t.exception);
  if (errored.length) lines.push(`WARN  ${errored.length} runs errored (${[...new Set(errored.map((t) => t.exception))].join(', ')}) and are excluded from pairs`);

  const dry = treatments.filter((t) => (t.mubit?.recall_sources || []).every((s) => s === 0));
  if (dry.length === treatments.length && treatments.length) {
    lines.push(`WARN  every treatment run injected 0 sources — the plugin loaded but recall returned nothing. This measures overhead only.`);
  }

  const overruns = trials.flatMap((t) => t.mubit?.budget_overruns || []);
  if (overruns.length) lines.push(`WARN  ${overruns.length} hook budget overruns: ${[...new Set(overruns.map((o) => o.hook))].join(', ')}`);

  if (!lines.length) lines.push('OK    arms verified: every treatment loaded the plugin, no control did, no control wrote state');
  return { lines, sound };
}

/**
 * The noise floor from an A/A run — both arms as control.
 *
 * @param {any[]} trials @returns {Record<string, {medianDelta: number|null, q1: number|null, q3: number|null, pairs: number}>}
 */
export function noiseFloor(trials) {
  /** @type {any} */
  const out = {};
  for (const m of AB_METRICS) {
    const a = byPair(trials, 'controlA', m.key);
    const b = byPair(trials, 'controlB', m.key);
    const d = pairedDelta(a, b);
    out[m.key] = { medianDelta: d.medianDelta, q1: d.q1, q3: d.q3, pairs: d.pairs };
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* responsiveness                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {{surface: string, source: string, samples: number[], budgetMs?: number|null, note?: string}[]} groups
 * @returns {{rows: any[], cols: any[]}}
 */
export function latencyTable(groups) {
  const rows = groups.map((g) => {
    const s = summarise(g.samples);
    const over = g.budgetMs ? g.samples.filter((x) => x > /** @type {number} */ (g.budgetMs)).length : 0;
    return {
      surface: g.surface,
      source: g.source,
      n: String(s.n),
      p50: fmt(s.p50),
      p95: fmt(s.p95),
      max: fmt(s.max),
      budget: g.budgetMs ? String(g.budgetMs) : '—',
      over: g.budgetMs ? String(over) : '—',
      note: g.note || '',
    };
  });
  const cols = [
    { key: 'surface', label: 'surface' },
    { key: 'source', label: 'source' },
    { key: 'n', label: 'n', align: 'r' },
    { key: 'p50', label: 'p50 ms', align: 'r' },
    { key: 'p95', label: 'p95 ms', align: 'r' },
    { key: 'max', label: 'max ms', align: 'r' },
    { key: 'budget', label: 'budget', align: 'r' },
    { key: 'over', label: 'over', align: 'r' },
    { key: 'note', label: '' },
  ];
  return { rows, cols };
}
