// @ts-check
/**
 * `rules.local.example.mjs` — the template for rules that must not be published here.
 *
 * A denylist published in the repository it guards leaks its own denylist. Nearly every rule in
 * `rules.mjs` is a *shape* — `instanceId: '<prefix>-<hex>'`, `crates/<name>/…`, a home-directory
 * path — and a shape gives nothing away. A few cases are not shapes: the actual name of a vendor
 * behind our auth exchange, the actual filename of the script that filters this mirror, an
 * internal codename. Those go here.
 *
 * Copy this file to `rules.local.mjs` in the SOURCE repository, fill in the real names, and let
 * it stay gitignored. `leakcheck.mjs` merges it when present and does not care when it is not,
 * so the gate is strictest exactly where the work happens and still useful downstream.
 *
 * The shape of a rule is identical to `rules.mjs`; see its header for the field meanings.
 */

/** @type {Array<import('./rules.mjs').Rule|any>} */
export const RULES = [
  // {
  //   id: 'local-vendor-name',
  //   severity: 'block',
  //   kind: 'content',
  //   pattern: /\bexamplevendor\.(?:com|io)\b/gi,
  //   why: 'Names a third-party service in our own supply chain.',
  //   fix: 'Use a neutral host in fixtures; the plugin never needs the real one under test.',
  //   found: 'A test fixture reproduced a token-exchange response verbatim.',
  // },
];

export default { RULES };
