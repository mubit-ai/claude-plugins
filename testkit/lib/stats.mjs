// @ts-check
/**
 * The smallest statistics that can honestly describe n=3..10.
 *
 * No means: a single 40-second outlier owns the mean at n=5, and this kit measures wall
 * clock against a hosted backend, which produces exactly that outlier. Medians, an IQR to
 * show spread, a paired delta, and an exact binomial sign test — which needs no
 * distributional assumption and is the only test that is honest at this n.
 *
 * Everything here is pure and takes plain arrays, so `test/stats.test.mjs` can pin it
 * against hand-computed values.
 */

/** @param {number[]} xs @returns {number[]} sorted ascending, NaN and non-finite dropped */
function clean(xs) {
  return xs.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
}

/** @param {number[]} xs @returns {number|null} */
export function median(xs) {
  const s = clean(xs);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Nearest-rank percentile. Deliberately not linear interpolation: at n=5 the interpolated
 * p95 is a number no run produced, and the whole point of these tables is that every cell
 * is a thing that actually happened.
 *
 * @param {number[]} xs @param {number} p 0..1 @returns {number|null}
 */
export function percentile(xs, p) {
  const s = clean(xs);
  if (!s.length) return null;
  const rank = Math.ceil(Math.min(1, Math.max(0, p)) * s.length);
  return s[Math.max(0, rank - 1)];
}

/** @param {number[]} xs @returns {{q1: number, q3: number, iqr: number}|null} */
export function iqr(xs) {
  const s = clean(xs);
  if (s.length < 2) return null;
  const q1 = percentile(s, 0.25);
  const q3 = percentile(s, 0.75);
  if (q1 == null || q3 == null) return null;
  return { q1, q3, iqr: q3 - q1 };
}

/** @param {number[]} xs @returns {{n: number, p50: number|null, p95: number|null, min: number|null, max: number|null, q1: number|null, q3: number|null}} */
export function summarise(xs) {
  const s = clean(xs);
  const q = iqr(s);
  return {
    n: s.length,
    p50: median(s),
    p95: percentile(s, 0.95),
    min: s.length ? s[0] : null,
    max: s.length ? s[s.length - 1] : null,
    q1: q ? q.q1 : null,
    q3: q ? q.q3 : null,
  };
}

/**
 * Pair two arms by key, then report the median of the per-pair differences.
 *
 * Pairing matters more than the test does. Prompt A costing twice prompt B swamps any arm
 * effect if you compare unpaired pools; differencing within a pair cancels it.
 *
 * @param {Map<string, number>} a treatment, keyed by `<case>#<rep>`
 * @param {Map<string, number>} b control, same keys
 * @returns {{pairs: number, deltas: number[], medianDelta: number|null, q1: number|null, q3: number|null}}
 */
export function pairedDelta(a, b) {
  /** @type {number[]} */
  const deltas = [];
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (Number.isFinite(va) && Number.isFinite(vb)) deltas.push(va - /** @type {number} */ (vb));
  }
  const q = iqr(deltas);
  return {
    pairs: deltas.length,
    deltas,
    medianDelta: median(deltas),
    q1: q ? q.q1 : null,
    q3: q ? q.q3 : null,
  };
}

/** @param {number} n @param {number} k */
function binom(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return r;
}

/**
 * Exact two-sided binomial sign test on the non-zero deltas.
 *
 * Returns `p`, the count of discordant pairs, and `minPairsForSignificance` — the number of
 * non-tied pairs you would need before p < 0.05 is even reachable. That last field is what
 * stops the report claiming a null result: at n=4 the smallest attainable two-sided p is
 * 0.125, so "no significant difference" means "we could not have found one".
 *
 * @param {number[]} deltas
 * @returns {{n: number, positive: number, negative: number, ties: number, p: number|null, underpowered: boolean, minPairsForSignificance: number}}
 */
export function signTest(deltas) {
  const nz = deltas.filter((d) => Number.isFinite(d) && d !== 0);
  const positive = nz.filter((d) => d > 0).length;
  const negative = nz.length - positive;
  const n = nz.length;

  // Smallest n whose two-sided extreme (all one way) clears 0.05: 2 * 0.5^n < 0.05 → n >= 6.
  const minPairsForSignificance = 6;

  if (!n) {
    return { n: 0, positive, negative, ties: deltas.length, p: null, underpowered: true, minPairsForSignificance };
  }
  const k = Math.min(positive, negative);
  let tail = 0;
  for (let i = 0; i <= k; i += 1) tail += binom(n, i);
  const p = Math.min(1, (2 * tail) / 2 ** n);

  return {
    n,
    positive,
    negative,
    ties: deltas.length - n,
    p,
    underpowered: n < minPairsForSignificance,
    minPairsForSignificance,
  };
}

/** @param {number|null} x @param {number} [dp] @returns {string} */
export function fmt(x, dp = 0) {
  if (x == null || !Number.isFinite(x)) return '—';
  return dp ? x.toFixed(dp) : String(Math.round(x));
}

/** @param {number|null} x @returns {string} a signed number, so a delta column reads as one */
export function fmtDelta(x, dp = 0) {
  if (x == null || !Number.isFinite(x)) return '—';
  const s = dp ? Math.abs(x).toFixed(dp) : String(Math.round(Math.abs(x)));
  return x < 0 ? `-${s}` : `+${s}`;
}
