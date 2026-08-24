// @ts-check
/**
 * `lib/rank.mjs` — is this prompt asking "what is true?" or "what happened lately?" (§5.2).
 *
 * ---------------------------------------------------------------------------
 * The dial this exists to turn
 * ---------------------------------------------------------------------------
 * `/v2/control/query` fuses three scores, and `rank_by` picks the weights server-side:
 *
 * | `rank_by` | semantic | lexical | recency |
 * | --- | --- | --- | --- |
 * | *(unset / `relevance`)* | 1.00 | 0.25 | 0.10 |
 * | `balanced` | 0.60 | 0.15 | 0.25 |
 * | `freshness` | 0.40 | 0.10 | **0.50** |
 *
 * **Those numbers are the Rust match arm, not the proto's comment.** The proto's own comment
 * on `freshness` transposes semantic and recency — it reads as though freshness were
 * 0.50/0.10/0.40. The server does what the match arm says. If you are ever tempted to
 * "correct" the table above against the proto, you would be correcting it against the
 * wrong source.
 *
 * Unknown values fall through to the defaults server-side, so a bad mode is inert rather
 * than an error — which is exactly why the client still whitelists before sending
 * (`lib/recall.mjs`): a typo that silently ranks at the default weights is a bug nobody
 * can see.
 *
 * ---------------------------------------------------------------------------
 * Why a rule, and why a two-way one
 * ---------------------------------------------------------------------------
 * Ask "where were we?" and default fusion answers with whatever is most *similar* to those
 * three words, which is close to nothing. The question is temporal: the user is asking about
 * the most recent state of a thing, not about the most on-topic memory ever stored. There is
 * real event time to rank on — the plugin already sends `occurrence_time` on every captured
 * item (`hooks/src/capture.mjs`, `hooks/src/checkpoint.mjs`) and the server stores it — so
 * the ranking is available and simply was never asked for.
 *
 * The rule answers **two** classes and no more. `balanced` is reachable only by an operator
 * setting `MUBIT_CC_RECALL_RANK_BY=balanced`, and deliberately so: a third class would need
 * the prompt text to justify "somewhat temporal", and nothing in a prompt says that. Inventing
 * one would replace a default we know is wrong with a default we cannot defend, which is
 * worse — the current failure at least has a clear story.
 *
 * ---------------------------------------------------------------------------
 * Why this is not in `lib/classify.mjs`
 * ---------------------------------------------------------------------------
 * The obvious home looks like `lib/classify.mjs`, "which already classifies prompts". **It
 * does not.** It classifies *tool names and turn events* off a static lookup table, and
 * `classifyTurn(prompt, …)` takes a `prompt` argument it never reads — the classification
 * there is a function of the event name alone. Prompt text is a different input, needs a
 * different table, and putting it there would hand `classifyTurn` a reason to start reading
 * the argument it deliberately ignores. So the rule lives where prompt text actually is.
 *
 * ---------------------------------------------------------------------------
 * The failure mode this file is shaped around
 * ---------------------------------------------------------------------------
 * Over-firing is silent. A rule that decays into a substring match fires on half of all
 * prompts, re-ranks ordinary questions by recency, and produces no error and no log line —
 * recall simply gets worse. That is why three of the triggers carry an `unless`: `latest`,
 * `so far` and `current state` each have a common, specific, non-temporal reading, and
 * "what's the latest version of esbuild" is the canonical one. `test/rank.test.mjs` pins
 * every negative; treat that table as part of the rule.
 *
 * Discipline shared with the rest of `lib/`: **zero imports**, synchronous, pure, and nothing
 * here throws (§4.9) — this runs in front of every prompt.
 */

/**
 * The temporal / handoff table. One row per shape, each with the ambiguity it has to survive.
 *
 * `when` fires the row; `unless` vetoes **that row only**, never the whole prompt — so
 * "catch me up on the latest version of esbuild" is still a handoff question, because the
 * `catch me up` row does not care what the `latest` row thinks.
 *
 * @type {ReadonlyArray<{id: string, when: RegExp, unless?: RegExp}>}
 */
const FRESHNESS_RULES = Object.freeze([
  // "where were we", "where did we leave off", "where we left off". The archetypal handoff.
  { id: 'where_were_we', when: /\bwhere\s+(?:were|was|are)\s+(?:we|i|you)\b|\bwhere\s+did\s+(?:we|i)\s+(?:leave|get|stop)\b/ },

  // "left off" on its own — it is a handoff phrase in every context it appears in.
  { id: 'left_off', when: /\bleft\s+off\b|\bstopped\s+off\b/ },

  // "what changed", "what's changed", "what has changed".
  { id: 'what_changed', when: /\bwhat(?:'s|s)?\s+(?:has\s+|have\s+|had\s+)?changed\b/ },

  { id: 'catch_me_up', when: /\bcatch\s+(?:me|us)\s+up\b/ },

  // "pick up where we left off", "picking up where I stopped".
  { id: 'pick_up_where', when: /\bpick(?:ing|ed)?\s+(?:this\s+|it\s+|things\s+|that\s+)?up\s+where\b/ },

  { id: 'last_session', when: /\b(?:last|previous|prior)\s+session\b/ },

  { id: 'recently', when: /\brecently\b/ },

  // AMBIGUOUS. "what's the latest on the migration" is our state; "the latest version of
  // esbuild" is somebody else's release. The veto covers both shapes it shows up in: a
  // release-flavoured noun after the word, and an upgrade instruction anywhere around it.
  {
    id: 'latest',
    when: /\blatest\b/,
    unless: /\blatest\s+(?:stable\s+|beta\s+|lts\s+|major\s+|minor\s+|patch\s+)?(?:version|release|tag|build|docs?|documentation|api|apis|sdk|spec|schema|node|npm)\b|\blatest\s+\w+\s+(?:version|release)\b|\b(?:upgrade|upgrading|bump|bumping|update\s+to|install|pin)\b[^.?!]*\blatest\b/,
  },

  // AMBIGUOUS. "so far as I can tell" is the idiom "as far as", not a progress question.
  { id: 'so_far', when: /\bso\s+far\b/, unless: /\bso\s+far\s+as\b/ },

  // AMBIGUOUS. "the current state of the art" is a survey question about a field.
  { id: 'current_state', when: /\bcurrent\s+state\b/, unless: /\bcurrent\s+state\s+of\s+the\s+art\b/ },

  // "since yesterday" and its neighbours. `since` alone is far too broad — it is a causal
  // conjunction at least as often as a temporal one ("since the parser returns null…") — so
  // only an explicitly temporal object counts.
  {
    id: 'since_temporal',
    when: /\bsince\s+(?:yesterday|today|this\s+(?:morning|afternoon|evening|week)|last\s+(?:night|week|session|time|run|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|the\s+last\s+\w+|(?:we|i)\s+last\b|(?:we|i)\s+(?:started|left|stopped|paused)|then)\b/,
  },

  // "still failing" — a question about whether a known-bad thing is bad *now*.
  { id: 'still_broken', when: /\bstill\s+(?:failing|broken|red|erroring|crashing|not\s+working|failing\?)\b/ },
]);

/**
 * The rule: `'freshness'` for a temporal or handoff-shaped prompt, `'relevance'` otherwise.
 *
 * Total by construction — anything that is not a non-empty string is, trivially, not a
 * handoff question, and answering `'relevance'` for it is both correct and the safe default
 * (it is what the server does when the field is absent).
 *
 * @param {string|null|undefined} prompt  the same text that goes out as `query`
 * @returns {'freshness'|'relevance'}
 */
export function rankForPrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return 'relevance';
  const text = prompt.toLowerCase();

  for (const rule of FRESHNESS_RULES) {
    if (!rule.when.test(text)) continue;
    if (rule.unless && rule.unless.test(text)) continue;
    return 'freshness';
  }
  return 'relevance';
}

/**
 * What `rank_by` a recall from this prompt should carry — the precedence rule, in one place.
 *
 * `auto` (the default) *means* "run the rule"; it is not a stand-in for a missing setting.
 * Anything else an operator has named wins outright, because a heuristic that overrode a
 * configured mode would make the setting a suggestion — and `balanced` would become
 * unreachable, since the rule never produces it.
 *
 * It lives here rather than being spelled out at each of the three recall call sites for the
 * reason `lib/outcome.mjs` records: a rule copied into three hooks is a rule that drifts in
 * two of them, and hooks are separate esbuild entry points that may not import one another.
 *
 * @param {Record<string, any>|null|undefined} cfg
 * @param {string|null|undefined} prompt
 * @returns {string} a concrete mode — never `'auto'`, so nothing downstream has to re-decide
 */
export function rankForRecall(cfg, prompt) {
  const mode = typeof cfg?.recallRankBy === 'string' ? cfg.recallRankBy.trim().toLowerCase() : '';
  // An unrecognised mode is treated as `auto` rather than passed along: `lib/config.mjs`
  // already clamps this key with `enumOf`, so a value that is neither `auto` nor one of the
  // three real modes can only come from a hand-written cfg, and the rule is a better answer
  // for it than a string the server will ignore.
  if (mode === 'relevance' || mode === 'balanced' || mode === 'freshness') return mode;
  return rankForPrompt(prompt);
}
