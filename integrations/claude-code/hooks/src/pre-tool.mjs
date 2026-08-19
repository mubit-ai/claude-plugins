#!/usr/bin/env node
// @ts-check
/**
 * `hooks/src/pre-tool.mjs` — PreToolUse, **warnings only** (HS-7 stage 1).
 *
 * ---------------------------------------------------------------------------
 * What this hook is allowed to do, and what it will never do
 * ---------------------------------------------------------------------------
 * Mubit's memory model defines `rule` as a hard constraint that always applies. Until now the
 * only place one could land in Claude Code was as prose inside a recall block, competing for
 * attention with everything else the model was reading. This hook gives it a second surface:
 * the moment the rule is about to be broken.
 *
 * **It surfaces. It does not decide.** The host offers this event two ways to stop a call and
 * this hook takes neither:
 *
 *   1. `hookSpecificOutput` accepts `permissionDecision` — four values, `allow`, `deny`,
 *      `ask`, `defer` — with a `permissionDecisionReason` shown to the model. It also accepts
 *      `updatedInput`, which rewrites the tool's arguments outright and is a *larger* power
 *      than denying: the call still runs, and runs as something the model did not write.
 *      Neither key is emitted on any path here, and `test/pre-tool.test.mjs` asserts their
 *      absence over every branch *and* over the built bundle — because the branch that would
 *      grow one is an error branch nobody drives by hand.
 *   2. **Exit code 2 blocks the call**, from the host's own registry entry:
 *      "Exit code 0 - stdout/stderr not shown / Exit code 2 - show stderr to model and block
 *      tool call / Other exit codes - show stderr to user only but continue with tool call".
 *      Note the asymmetry — every other non-zero code lets the call through. `lib/hook.mjs`
 *      pins `process.exitCode = 0` on every path out, including the uncaught-exception and
 *      blown-budget paths, and that is what makes this stage total rather than usually safe.
 *
 * Why it is capped there: a false deny costs more than a missed one. It interrupts work, it
 * is confusing, and it is blamed on the plugin rather than on the lesson that caused it.
 * Deciding needs the confidence signals to be trustworthy first — non-stale, above a
 * `knowledge_confidence` floor, verified in production — and this stage is how anyone finds
 * out whether the *matching* is good enough to build that on.
 *
 * ---------------------------------------------------------------------------
 * Zero network, necessarily
 * ---------------------------------------------------------------------------
 * The user is waiting on the tool call. A round trip here is latency on every matching
 * command in exchange for a reminder, and a slow Mubit would spend the whole 3 s host timeout
 * and inject nothing. So rules come off disk, from `runs/<run_id>/rules.json`, which
 * `session-start`'s lessons call and `prompt-recall`'s ladder fill in passing out of entries
 * they already fetched (`lib/rules.mjs`). This hook opens no socket on any path.
 *
 * ---------------------------------------------------------------------------
 * Cheapness lives in `hooks.json`, not here
 * ---------------------------------------------------------------------------
 * Without a filter this would be one node process per tool call for the whole session. The
 * registration therefore carries a `matcher` of `Bash` (the matcher field for this event is
 * `tool_name`) and an `if` permission-rule pattern per entry — `Bash(rm *)` and
 * `Bash(git push *)` — which the host describes as "Only runs if the tool call matches the
 * pattern. Avoids spawning hooks for non-matching commands."
 *
 * **Neither filter is a guarantee in either direction, and nothing here rests on one.** The
 * reference calls the filter best-effort and says outright to "use the permission system
 * rather than a hook to enforce a hard allow or deny". So this hook re-derives its own answer
 * from the payload it was handed and says nothing when no rule matches — which is also what
 * it must do if a future host widens the filter and hands it an `Edit`.
 *
 * Default OFF (`preToolWarnings`). Nothing changes for an existing user until they opt in.
 */

import { loadConfig } from '../../lib/config.mjs';
import { runHook } from '../../lib/hook.mjs';
import { log } from '../../lib/log.mjs';
import { readRules } from '../../lib/rules.mjs';
import { deriveRunId } from '../../lib/runid.mjs';

/**
 * Everything below is a `readFileSync` and a set intersection, so this is the hard stop
 * rather than the target — the deadline only matters if a filesystem hangs. It sits well
 * inside the 3 s registered timeout because a hook that overruns in front of a tool call is
 * a hook the user is watching.
 */
const BUDGET_MS = 250;

/** The one output shape for every path that has nothing to say. */
const SUPPRESS = Object.freeze({ suppressOutput: true });

/** At most this many rules are surfaced on one call, best match first. */
const MAX_SURFACED = 3;

/**
 * How many distinct terms a rule and the tool call must share before the rule surfaces.
 *
 * One is too loose: a rule about "the main branch" would fire on `rm -rf main.o`, and a
 * channel that is wrong the first few times a user sees it is a channel they stop reading.
 * Two is the floor at which a single incidental word cannot carry a match on its own, while
 * the cases this exists for still land comfortably — `git push --force origin main` against
 * a rule about force-pushing to main shares four.
 *
 * The asymmetry of the costs sets the direction to err in. A missed warning costs nothing
 * that was not already being missed; a spurious one costs ~20 tokens *and* credibility. So
 * this is tuned to be quiet, and stage 2 (if there ever is one) needs a stricter signal than
 * term overlap anyway.
 */
const MIN_OVERLAP = 2;

/**
 * A term: two to twenty-four characters, starting with a letter. Two is low on purpose —
 * `rm`, `rf` and `db` are exactly the tokens that make a command what it is — and the
 * stopword list below is what stops that lower bound from matching everything.
 */
const TERM_RE = /[a-z][a-z0-9_]{1,23}/g;

/**
 * Words that appear in almost every rule, in almost every command, or in both. Sharing one
 * of these says nothing about whether a rule is about this call.
 *
 * It is deliberately short. A long list is a second thing to keep correct, and the
 * `MIN_OVERLAP` floor already does most of the work — this only has to remove the terms
 * common enough to reach that floor two at a time.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'not', 'never', 'always', 'must', 'should', 'use', 'using',
  'run', 'runs', 'before', 'after', 'when', 'this', 'that', 'these', 'those', 'from', 'into',
  'any', 'all', 'you', 'your', 'its', 'are', 'was', 'were', 'has', 'have', 'been', 'will',
  'file', 'files', 'code', 'command', 'commands', 'first', 'instead', 'rather', 'than',
  'bash', 'tool', 'call', 'calls',
]);

/** How much of the tool input is scanned. A 10 MB heredoc is a tool input too. */
const MAX_INPUT_SCAN = 8 * 1024;

/** Depth cap for walking `tool_input`, which is arbitrary JSON from the model. */
const MAX_DEPTH = 4;

await runHook('pre-tool', {
  budgetMs: BUDGET_MS,
  body: async (payload) => {
    const cfg = loadConfig();

    // Off is off, and it is the shipped default. Nothing is read, nothing is derived, and no
    // rule can leak into a session that did not ask for one.
    if (!cfg.preToolWarnings) return SUPPRESS;

    let runId = '';
    try {
      runId = deriveRunId(cfg, payload);
    } catch (err) {
      // Same handling as `stage-prompt`: a misconfigured run strategy costs the warning.
      log(cfg, 'error', `pre-tool: no usable run id (${messageOf(err)})`);
      return SUPPRESS;
    }

    const rules = readRules(cfg, runId);
    if (rules.length === 0) return SUPPRESS;

    const call = callTerms(payload);
    const matched = match(rules, call);

    // One line per invocation, at `info`, whether or not anything matched — this is the
    // whole measurement surface for "how often does it fire, and on what". `grep -c
    // 'pre-tool:'` over `logs/mubit-cc.log` counts the fires, `matched: 0` counts the
    // misses, and no state is written for it. A `systemMessage` would have been the other
    // option and is deliberately not taken: it would put a line in the user's terminal in
    // the middle of a tool call, on a feature whose entire premise is that it is quiet.
    log(cfg, 'info', 'pre-tool: rule check', {
      run_id: runId,
      tool: str(payload?.tool_name),
      stored: rules.length,
      matched: matched.length,
      refs: matched.map((m) => m.ref).filter(Boolean),
    });

    if (matched.length === 0) return SUPPRESS;

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: block(matched),
      },
      suppressOutput: true,
    };
  },
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * The distinctive terms of the tool call: the tool's name, plus every string that appears
 * anywhere in `tool_input`.
 *
 * Walking the whole input rather than reading `tool_input.command` is what keeps this from
 * being Bash-only. The registration filters to Bash today; the *hook* should still behave
 * correctly the day a filter widens or a host renames a field, and a hook that only knows one
 * tool's argument shape fails silently rather than loudly when that happens.
 *
 * @param {Record<string, any>} payload
 * @returns {Set<string>}
 */
function callTerms(payload) {
  /** @type {{parts: string[], size: number}} */
  const acc = { parts: [str(payload?.tool_name)], size: 0 };
  collectStrings(payload?.tool_input, acc, 0);
  return terms(acc.parts.join(' '));
}

/**
 * Every string leaf of an arbitrary JSON value, bounded in depth and in total size.
 *
 * The running `size` is what keeps the bound cheap: re-joining the accumulator to measure it
 * would make this quadratic in the number of leaves, on the one path in this plugin that
 * blocks a tool call.
 *
 * @param {any} value @param {{parts: string[], size: number}} acc @param {number} depth
 */
function collectStrings(value, acc, depth) {
  if (depth > MAX_DEPTH || acc.size > MAX_INPUT_SCAN) return;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const s = String(value);
    acc.parts.push(s);
    acc.size += s.length + 1;
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      if (acc.size > MAX_INPUT_SCAN) return;
      collectStrings(v, acc, depth + 1);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (acc.size > MAX_INPUT_SCAN) return;
      // The key is a term too: `file_path`, `command` and `old_string` are what a rule about
      // a tool rather than about a command would name.
      acc.parts.push(k);
      acc.size += k.length + 1;
      collectStrings(v, acc, depth + 1);
    }
  }
}

/**
 * Lowercase, split on anything that is not a letter, digit or underscore, drop stopwords.
 *
 * Splitting on punctuation is what makes `git push --force origin main` and a rule that
 * writes it as `` `git push --force` `` agree: both reduce to the same four terms.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function terms(text) {
  /** @type {Set<string>} */
  const out = new Set();
  const s = String(text ?? '').toLowerCase();
  for (const m of s.matchAll(TERM_RE)) {
    const t = m[0];
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/**
 * The rules worth surfacing, best overlap first, capped.
 *
 * Ties break on stored order, which `lib/rules.mjs` keeps newest-first — so where two rules
 * are equally on-topic the one this run recalled most recently wins. Deterministic, because
 * the same call must produce the same block twice.
 *
 * @param {{ref: string, text: string}[]} rules
 * @param {Set<string>} call
 * @returns {{ref: string, text: string, score: number}[]}
 */
function match(rules, call) {
  if (call.size === 0) return [];

  /** @type {{ref: string, text: string, score: number, at: number}[]} */
  const hits = [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    let score = 0;
    for (const t of terms(r.text)) if (call.has(t)) score++;
    if (score >= MIN_OVERLAP) hits.push({ ref: r.ref, text: r.text, score, at: i });
  }

  hits.sort((a, b) => (b.score - a.score) || (a.at - b.at));
  return hits.slice(0, MAX_SURFACED).map(({ ref, text, score }) => ({ ref, text, score }));
}

// ---------------------------------------------------------------------------
// The injected block
// ---------------------------------------------------------------------------

/**
 * What the model reads, immediately before the call runs.
 *
 * Three things have to be in it and the third is the one that is easy to leave out:
 *
 *   1. The rule, in full, so it is actionable without a second call.
 *   2. Its `reference_id`, so `mubit_dereference` can fetch the whole entry and its
 *      provenance. A rule with no id is a claim with no way to check it.
 *   3. **That nothing here blocked anything.** A model that meets a standing rule at the
 *      exact moment of a tool call will otherwise read it as enforcement, conclude the
 *      guardrail is holding, and stop checking — which is worse than never having warned,
 *      because it converts a reminder into a false assurance. It is also simply true: this
 *      hook has no decision field on any path.
 *
 * @param {{ref: string, text: string}[]} matched
 * @returns {string}
 */
function block(matched) {
  const lines = [
    `<mubit-rules matched="${matched.length}">`,
    'Standing rules from Mubit memory that mention this command. This is a reminder, not a '
      + 'permission check — nothing here has blocked or changed the call, and the rules may '
      + 'be out of date. Judge whether each one applies before acting on it.',
    '',
  ];
  for (const m of matched) {
    lines.push(m.ref ? `- [${m.ref}] ${m.text}` : `- ${m.text}`);
  }
  lines.push('</mubit-rules>');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** @param {any} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v : '';
}

function messageOf(err) {
  if (err && typeof err === 'object' && typeof (/** @type {any} */ (err).message) === 'string') {
    return (/** @type {any} */ (err).message);
  }
  return String(err);
}
