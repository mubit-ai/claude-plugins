#!/usr/bin/env node
// @ts-check
/**
 * `hooks/src/session-resume.mjs` — the detached half of the resume briefing.
 *
 * Not registered in `hooks.json`, for the same reason `drain.mjs` and `recall-refresh.mjs` are
 * not: it is spawned detached by `session-start`, exactly the way `prompt-recall` fires the
 * refresh. Nothing waits on it, and that is the entire point — `SessionStart` is a blocking
 * hook the host holds the session open for, and a briefing worth two LLM calls cannot be
 * bought with the user's time.
 *
 * ```
 * session-start (blocking, ~300 ms)             session-resume (detached, up to 20 s)
 *   health → register → lessons
 *   updateMarker
 *   spawn --run <id> --agent <id> ─────────────▶ resumeContext  (POST /v2/control/context)
 *   emit the steer block                         writeResume    → runs/<run>/resume.json
 *
 * prompt-recall, on the first substantive prompt
 *   takeResume → render above <mubit-memory>, markSeen, attribute
 * ```
 *
 * ---------------------------------------------------------------------------
 * Why this process must never call `deriveRunId`
 * ---------------------------------------------------------------------------
 * `lib/runid.mjs` is not a pure function. On `source: 'clear'` it increments `clear_count` and
 * **persists** the new SessionRecord (`lib/runid.mjs:155-159`), so a second process handed the
 * same payload does not merely recompute the parent's answer — it computes `-c2` where the
 * parent got `-c1`, writes it back over the parent's record, and leaves the briefing under a
 * run nothing will ever read. The next `/clear` then starts from a counter nobody set.
 *
 * So identity arrives on argv, `--run` and `--agent`, exactly as `drain.mjs` takes it from
 * `cwd-changed`. The payload still travels through a file, because `lib/hook.mjs`'s harness
 * needs a parseable object on the way in — but nothing in it is read for identity, and the
 * `clear` case is pinned by a test that drives this file with a `clear` payload directly.
 *
 * ---------------------------------------------------------------------------
 * What this process must NOT do
 * ---------------------------------------------------------------------------
 * It writes the **block** and nothing that describes what the model saw: no `markSeen`, no
 * `recalled[]`, and — unlike `recall-refresh` — no marker write either.
 * `recall-refresh.mjs:22-31` argues the first two at length and the argument is stronger here:
 * a carried block is rendered on the very next prompt, while a briefing has a whole session's
 * worth of ways never to be rendered at all. The session can end without a prompt, the first
 * prompt can be a slash command, a compaction can clear it. Recording entries as seen that the
 * model never received is `lib/seen.mjs`'s own worst case.
 *
 * The marker is the third, and it is where this file differs from its twin. `recall-refresh`
 * owns the connection state because with `recallAsync` on it is the *only* process that dials;
 * here `prompt-recall` is still dialling on every prompt and still writing `state`, so a
 * second writer would add nothing but a race — and the `recall` group it would land beside
 * describes what was *injected*, which this process does not do.
 *
 * ---------------------------------------------------------------------------
 * Budget
 * ---------------------------------------------------------------------------
 * `recallBudgetMs` is deliberately not consulted, for the reason `recall-refresh` gives:
 * that budget exists because a user is waiting, and here nobody is. The bound is
 * `lib/recall.mjs`'s own 20 s request deadline plus room for the write, and that request
 * carries `{record: false}` so nothing it learns can reach the breaker.
 *
 * Constraints shared with the rest of the plugin: zero dependencies, Node >= 20 built-ins,
 * and **exit code 0, always** (§4.9).
 */

import { isConfigured, loadConfig } from '../../lib/config.mjs';
import { runHook } from '../../lib/hook.mjs';
import { log } from '../../lib/log.mjs';
import { resumeContext } from '../../lib/recall.mjs';
import { writeResume } from '../../lib/resume.mjs';

/**
 * The harness's hard stop, set past `lib/recall.mjs`'s 20 s request deadline so the abort
 * lands first and the file write that follows it still happens. A detached child that never
 * exits is a leak; one that is killed a millisecond before it writes is worse, because it
 * costs the round trip and produces nothing.
 */
const HARNESS_BUDGET_MS = 22_000;

/** A run id names a directory as well as a run, so an argv value is untrusted input. */
const MAX_ID = 128;

const SUPPRESS = Object.freeze({ suppressOutput: true });

await runHook('session-resume', {
  budgetMs: HARNESS_BUDGET_MS,
  body: async (payload, _hookCfg, ctx) => {
    const cfg = loadConfig();
    const started = Date.now();

    // The same gates `session-start` applies before spawning. Re-checked rather than trusted:
    // this process can also be started by hand while debugging, and a briefing assembled with
    // recall off would sit on disk waiting for a hook that is not allowed to inject it.
    if (!cfg.recall) return SUPPRESS;
    if (!cfg.resumeBlock) return SUPPRESS;
    if (!isConfigured(cfg)) return SUPPRESS;

    const argv = Array.isArray(ctx?.args) ? ctx.args : [];
    const runId = usableRunId(flagValue(argv, '--run'));
    if (!runId) {
      // Refusing is the honest answer. Deriving one here is the single thing this process may
      // not do (see the header), so there is no fallback to reach for.
      log(cfg, 'warn', 'session-resume: no usable --run on argv; assembling nothing');
      return SUPPRESS;
    }
    const agentId = safeId(flagValue(argv, '--agent'));

    const outcome = await resumeContext(cfg, { runId, agentId });
    const fetchMs = Date.now() - started;

    if (outcome.failed) {
      // `info`, not `warn`. Nothing is broken for the user: recall still runs on every prompt,
      // `session-start` has already steered, and the only cost is a session that opens without
      // a summary. Logging it at `warn` — the default level — would put a line on the console
      // of every session opened while an instance was slow.
      log(cfg, 'info',
        `session-resume: no briefing this session (${str(outcome.state) || 'unknown'})`,
        { run_id: runId, error: str(outcome.error).slice(0, 300) });
      return SUPPRESS;
    }

    if (!outcome.block) {
      // A correct answer, and a common one: a brand-new run has no history to summarise. An
      // empty file would render as a heading with nothing under it, which teaches the model
      // that the channel carries noise.
      log(cfg, 'debug', `session-resume: nothing to brief (${outcome.emptyReason || 'no_evidence'})`,
        { run_id: runId });
      return SUPPRESS;
    }

    const landed = writeResume(cfg, runId, outcome, {
      source: sourceOf(payload),
      fetchMs,
    });
    log(cfg, landed ? 'debug' : 'warn',
      landed
        ? `session-resume: briefed ${outcome.refIds.length} sources in ${fetchMs}ms`
        : 'session-resume: could not write the briefing; this session opens without one',
      { run_id: runId });

    return SUPPRESS;
  },
});

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

/**
 * `--flag value`, and `--flag=value`. Returns '' for a flag that is absent or bare. The same
 * three lines `drain.mjs` carries; hooks are separate esbuild entry points and may never
 * import one another (see `lib/outcome.mjs` for what happened the last time a rule lived in
 * two hooks), and a shared helper in `lib/` for two argv parsers would be a module.
 *
 * @param {string[]} argv @param {string} name @returns {string}
 */
function flagValue(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i] ?? '');
    if (a === name) {
      const next = argv[i + 1];
      return typeof next === 'string' && !next.startsWith('--') ? next : '';
    }
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return '';
}

/**
 * The same refusal `lib/runid.mjs` applies to a `static` pin, for a run id that arrived on
 * argv instead. `''` means "not a run id", and the caller briefs nothing — `"default"` is the
 * value that would collapse every user and project into one shared run (§4.3).
 * @param {string} raw @returns {string}
 */
function usableRunId(raw) {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id || id.toLowerCase() === 'default') return '';
  if (/[\\/]/.test(id) || /^\.+$/.test(id)) return '';
  return id.slice(0, MAX_ID);
}

/** An agent id goes on the wire, never into a path, so length is the only bound it needs. */
function safeId(v) {
  return typeof v === 'string' ? v.trim().slice(0, MAX_ID) : '';
}

/** Provenance only: which `SessionStart` source asked for this briefing. */
function sourceOf(payload) {
  return payload && typeof payload.source === 'string'
    ? payload.source.trim().toLowerCase().slice(0, 32)
    : '';
}

/** @param {any} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}
