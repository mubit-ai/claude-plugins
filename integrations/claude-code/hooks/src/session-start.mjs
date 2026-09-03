// @ts-check
/**
 * `hooks/src/session-start.mjs` — SessionStart (blocking, injection only).
 *
 * Matchers `startup|resume|clear|compact|fork`. **Budget 2500 ms internal against a 5 s hook
 * timeout**, with three sub-budgets: health half the envelope, register 600 ms, lessons
 * 900 ms. Missing a sub-budget degrades *that section only* — a slow lesson list costs the
 * lesson list, not the steer block. The one thing this hook may never do is fail to speak:
 * Claude Code waits for it, and a session that starts with nothing injected is a session where
 * the model has no idea memory exists.
 *
 * On `source === "compact"` it also carries the post-compaction re-anchor. That belongs to
 * §5.6 and used to ship from `checkpoint --post`, where the host discarded it on every
 * compaction: `PostCompact` is not a `hookSpecificOutput.hookEventName` Claude Code accepts,
 * and `SessionStart` is. See `hooks/src/checkpoint.mjs` and `test/hook-output.test.mjs`.
 *
 * The flow is §5.1 verbatim:
 *
 *   1. `loadConfig`; with capture AND recall both off there is nothing to say and nobody to
 *      say it to — emit `{}` and dial nothing.
 *   2. `deriveRunId` honouring the §4.3 `source` table (that module owns the whole table,
 *      including `/clear`'s counter and the session-map write).
 *   3. `marker.cold_start_until = now + coldStartGraceMs` (§4.7) — the grace window starts
 *      here, so a server still starting up does not read as "memory broken".
 *   4. `GET /v2/core/health` @`HEALTH_MS`. Not ok → skip 5-6 but **still steer**, saying memory
 *      is offline. Without that the model invents recall or apologises for its absence.
 *   5. `POST /v2/control/agents/register` @600 ms — or `/heartbeat` on `resume` and `fork`,
 *      because re-registering an agent that never left is noise the control plane reconciles.
 *   6. One page of `POST /v2/control/activity` @900 ms — lesson entries, full projection,
 *      newest first, across every run — filtered to `global` scope here. **No `run_id`**: a
 *      lesson another run widened past its own is the entire point of the section, so scoping
 *      the request to this run would return nothing on a brand-new one. Scope is not a field
 *      this route accepts, which is why the filter is client-side and the page is large.
 *   7. Assemble `additionalContext`, update the marker, emit — and, on `startup` and `resume`
 *      only, spawn the detached `session-resume` that assembles the resume briefing the first
 *      substantive prompt will render. Nothing here waits on it; `spawnResume` says why.
 *
 * The steer block does two jobs. It names the run and the mode, and it tells the model **when
 * to search and when not to**: recall is injected before every turn, so opening turn one with
 * a recall call is pure cost — but when the injected block falls short, searching is the right
 * move and the block names which tool for which shape of question.
 *
 * That balance is the fix for a defect this block used to carry on its own. It said only "do
 * not search for it preemptively" — a negative with no positive beside it — while the MCP tool
 * descriptions said nothing about when to use them either. Between them the trained behaviour
 * was to never call any memory tool at all, which made every measurement of those tools a
 * measurement of this paragraph. Change the two together or neither.
 */

import { join } from 'node:path';

import { endpointHash } from '../../lib/breaker.mjs';
import { isConfigured, loadConfig } from '../../lib/config.mjs';
import { runHook, spawnDetached, stashPayload } from '../../lib/hook.mjs';
import { listActivity } from '../../lib/activity.mjs';
import { normalizeActivityLesson } from '../../lib/dashboard-api.mjs';
import { health, heartbeat, registerAgent } from '../../lib/http.mjs';
import { log } from '../../lib/log.mjs';
import { updateMarker } from '../../lib/markers.mjs';
import { recordRules } from '../../lib/rules.mjs';
import { deriveAgentId, deriveRunId } from '../../lib/runid.mjs';
import { dataDir, readJson, resolveDataDir, writeJsonAtomic } from '../../lib/state.mjs';

/** §5.1: 2500 ms internal. The harness gets a slightly looser leash so the internal
 *  deadline — which still returns a steer block — is always the one that fires first. */
const BUDGET_MS = 2500;
const HARNESS_BUDGET_MS = 3200;

/**
 * §5.1 sub-budgets. Each is a CEILING clamped by `budgetFor()` to whatever is left of
 * `BUDGET_MS` — not a reservation, and not time anything is made to wait.
 *
 * Health is derived from the envelope rather than pinned, and it gets the largest slice,
 * because it is the **gate**: steps 5-6 do not run at all unless it passes, so holding time
 * back from health to protect the steps it gates cannot help them and can only mislabel a
 * working instance. The previous 400 ms was below a realistic cold answer, and the cost was
 * not a missing section — it was the whole feature. A loaded instance answering correctly in
 * 700 ms read as `not_responding`; measured end to end on the same deployment, a healthy
 * recall round trip took 1091 ms. Every session opened by telling the model memory was offline
 * and recall unavailable, while recall itself worked normally, so the injected steer argued
 * against the very thing that was working.
 *
 * Half the envelope clears both marks with margin (1.8x the 700 ms case, 1.15x the observed
 * 1091 ms) and still leaves the hook comfortably inside `HARNESS_BUDGET_MS`. Raising a ceiling
 * costs a healthy instance nothing: a server that answers in 30 ms still answers in 30 ms.
 * It only buys time on the slow path — which is the one path that was being misread.
 */
const HEALTH_MS = Math.round(BUDGET_MS * 0.5);
const REGISTER_MS = 600;
const LESSONS_MS = 900;

/** §5.1: the register body, verbatim. */
const CAPABILITIES = ['code', 'shell', 'edit', 'search'];
const LESSON_LIMIT = 5;

/**
 * How many lesson entries one page of the feed asks for.
 *
 * Scope is not a request field on this route, so the standing set has to be filtered here —
 * which means the page has to be big enough to contain some. 200 rather than the route's 500
 * ceiling because these are full-projection rows, and five hundred of them do not arrive
 * inside a 900 ms section of a blocking hook.
 */
const LESSON_SCAN = 200;

/** U+00B7. The status line and this line share a separator; a hyphen here is a visible bug. */
const DOT = ' · ';

/** §16.2 step 2 — the marker `bin/statusline.mjs` stamps and this hook reads. */
const LIVENESS_FILE = 'statusline-installed.json';

/** A checkpoint id is quoted into the injected block; keep it boring, as `checkpoint.mjs` does. */
const MAX_ID_CHARS = 160;

/**
 * §16.2 step 3: "after two consecutive sessions with no status-line invocation".
 *
 * Two, not one: the first session after install writes the marker and cannot conclude
 * anything from it, because the status line has not been given a frame yet.
 */
const NAG_AFTER_SESSIONS = 2;

await runHook('session-start', {
  budgetMs: HARNESS_BUDGET_MS,
  body: async (payload) => {
    const cfg = loadConfig();

    // §5.1 step 1 — both halves off: no steer block, no marker, no HTTP.
    if (!cfg.capture && !cfg.recall) return {};

    const deadline = Date.now() + BUDGET_MS;
    /**
     * Whatever is left of the whole-hook budget, capped at this section's sub-budget. Zero
     * means "skip": `lib/http.mjs` reads a non-positive `timeoutMs` as "unset" and would fall
     * back to the 4000 ms default, which is the whole budget spent on one dead section.
     */
    const budgetFor = (sub) => Math.max(0, Math.min(sub, deadline - Date.now()));

    // §4.3 — the source table lives in lib/runid.mjs, counter and session map included.
    let runId = '';
    let agentId = '';
    try {
      runId = deriveRunId(cfg, payload);
      agentId = deriveAgentId(payload);
    } catch (err) {
      // `static` with no pin is the only realistic path here. Steering with a run id we
      // refuse to stand behind would be worse than not steering at all.
      log(cfg, 'error', `session-start: no usable run id (${messageOf(err)})`);
      return {};
    }

    // §16.2 steps 2-3. Read once, here, so every return path below can carry it: whether the
    // shipped `settings.json` actually took effect is independent of whether Mubit is up.
    const statusLineHint = probeStatusLine(cfg);

    // §4.1 — no endpoint, nothing to dial, and nothing to diagnose about a server. Ahead of
    // the grace window and the health probe: arming a cold-start window would mask this
    // behind `◍ warming`, and probing would spend the budget on a `fetch` that throws
    // `ERR_INVALID_URL` before it opens a socket.
    if (!isConfigured(cfg)) {
      updateMarker(cfg, runId, { mode: cfg.mode, state: 'unconfigured', cold_start_until: 0, last_error: '' });
      log(cfg, 'debug', 'session-start: no endpoint configured', { run_id: runId });
      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: unconfiguredBlock(cfg, runId),
        },
        systemMessage: statusLineHint || `mubit: not configured${DOT}run /mubit-memory:auth`,
      };
    }

    // §4.7 — the grace window, armed once per endpoint rather than once per session. It
    // exists to cover an instance that is genuinely still starting, which is a property of
    // the instance and not of this session; re-arming it on entry meant the window was open
    // at the instant every probe failed, forever, and `◍ warming` became the only failure
    // state this hook could report. Persisted so the deadline survives the session that set
    // it, and keyed by endpoint so pointing at a new instance re-arms while pointing back at
    // an old one finds its expired record.
    const coldStartUntil = armColdStart(cfg);
    updateMarker(cfg, runId, { mode: cfg.mode, cold_start_until: coldStartUntil });

    // §5.1 step 4 — health is the gate. It returns the bare string `OK`, not JSON; reading
    // it as JSON would report every healthy server as down (lib/http.mjs owns that).
    const hres = await health(cfg, { timeoutMs: budgetFor(HEALTH_MS) });
    if (!hres.ok) {
      const state = connState(hres.state);
      const warming = coldStartUntil > Date.now();
      // The marker records what happened; `bin/statusline.mjs` decides how to show it, from
      // the `cold_start_until` written above. Persisting the lens here instead was the other
      // half of the stuck-`warming` bug: the string outlived the window that justified it,
      // and nothing that ran later ever corrected it.
      updateMarker(cfg, runId, {
        mode: cfg.mode,
        state,
        last_error: String(hres.error ?? '').slice(0, 300),
      });
      log(cfg, 'warn', `session-start: mubit is not reachable (${state})`, { run_id: runId });

      /** @type {Record<string, any>} */
      const out = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: offlineBlock(cfg, runId, state),
        },
      };
      // §4.7: inside the grace window the user is told nothing — they just started Mubit.
      if (!warming) out.systemMessage = `mubit: offline (${state})${DOT}capture buffered`;
      if (statusLineHint) out.systemMessage = statusLineHint;
      return out;
    }

    // §5.1 step 5 — register, or heartbeat on a resume.
    //
    // This is also the first call of the session that proves anything about the key. Health
    // reports reachability, not credentials, so on its own it cannot support the claim the
    // steer block makes.
    // A failure here that names the credential is therefore not just logged: it decides
    // which block the model gets.
    let authError = '';
    // `fork` sits on this side of the line with `resume`, and this is the only place in the
    // hook where the source distinction is load-bearing at all. `--fork-session`, `/fork` and
    // `/branch` continue a conversation that is already running under an agent this plugin
    // already announced — `deriveAgentId` returns the bare role for a parent session
    // (`lib/runid.mjs:287`), so the fork IS that agent. Re-announcing it is the same
    // reconciliation noise the `resume` case exists to avoid, and it would do it on a run the
    // fork inherited rather than one it opened.
    //
    // `compact` deliberately stays on the register side. That behaviour predates this change
    // and nothing measured says it is wrong, so moving it too would be a second, untested
    // decision riding along with this one.
    const src = sourceOf(payload);
    const resuming = src === 'resume' || src === 'fork';
    const identity = { run_id: runId, agent_id: agentId };
    const regBudget = budgetFor(REGISTER_MS);
    if (regBudget > 0) {
      const ires = resuming
        ? await heartbeat(cfg, { ...identity, status: 'active' }, { timeoutMs: regBudget })
        : await registerAgent(cfg, {
          ...identity,
          role: 'worker',
          status: 'active',
          capabilities: [...CAPABILITIES],
        }, { timeoutMs: regBudget });
      if (!ires.ok) {
        log(cfg, 'warn', `session-start: ${resuming ? 'heartbeat' : 'register'} failed (${ires.error})`,
          { run_id: runId });
        if (connState(ires.state) === 'auth_failed') authError = String(ires.error ?? '');
      }
    }

    // §5.1 step 6 — the standing set: lessons stored at `global` scope, by any run.
    //
    // One page of the activity feed, filtered to `global` here, rather than a request for
    // five global lessons. Asking for a handful at a named scope comes back empty against a
    // real instance — measured, reliably, on an instance that holds hundreds of lessons —
    // and an empty answer reads exactly like a project that has learned nothing. This section
    // and `runs/<run_id>/rules.json` were both starved by that one call.
    //
    // `projection: 'full'` is not optional: a lesson's scope lives in the metadata the
    // compact projection drops, so a compact page finds every lesson and knows the scope of
    // none of them. Past its sub-budget the whole section is dropped, not waited for.
    const lessonBudget = budgetFor(LESSONS_MS);
    /** @type {{id: string, type: string, content: string}[]} */
    let lessons = [];
    // A page that had more behind it cannot hide a NEWER standing lesson — the feed sorts
    // before it pages — but it can hide an older one, so "none found" is a weaker claim here
    // than it looks and the steer block says so instead of rendering a confident nothing.
    let lessonsPartial = false;
    if (lessonBudget > 0) {
      const lres = await listActivity(cfg, {
        allRuns: true,
        entryTypes: ['lesson'],
        projection: 'full',
        sort: 'desc',
        limit: LESSON_SCAN,
      }, { record: true, timeoutMs: lessonBudget });
      if (lres.ok) {
        const standing = globalLessons(lres.data.entries);
        lessons = readLessons({ lessons: standing });
        lessonsPartial = !!lres.data.nextPageToken && lessons.length < LESSON_LIMIT;
        // The `rule`-typed ones also go to `runs/<run_id>/rules.json`, for `pre-tool.mjs`
        // to read in front of a matching tool call. That hook may not dial, so its only
        // supply is a hook that has already paid for a round trip; this is one of the two,
        // and it is a pure side effect of a call that was made anyway. `recordRules` never
        // throws and never blocks (`lib/rules.mjs`).
        //
        // The WIRE-shaped array, not `lessons` above: `readLessons` renames `lesson_type` to
        // `type` on the way through, and the store reads the wire names so that one
        // normaliser can serve both producers. `globalLessons` exists to put those names
        // back — on the feed they arrive one level in, inside the metadata.
        recordRules(cfg, runId, standing);
      } else {
        log(cfg, 'info', `session-start: standing lessons unavailable (${lres.message})`, { run_id: runId });
        if (!authError && lres.code === 'auth_failed') authError = String(lres.message ?? '');
      }
    }

    // An authenticated call came back saying the credential is not good. Nothing this session
    // sends will land and nothing will be recalled, so saying "memory is active" would be a
    // straight falsehood — and the kind the model cannot check.
    if (authError) {
      updateMarker(cfg, runId, {
        mode: cfg.mode,
        state: 'auth_failed',
        last_error: authError.slice(0, 300),
      });
      log(cfg, 'warn', 'session-start: the API key was rejected', { run_id: runId });
      /** @type {Record<string, any>} */
      const out = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: unauthenticatedBlock(cfg, runId),
        },
      };
      out.systemMessage = statusLineHint || `mubit: auth failed${DOT}capture buffered`;
      return out;
    }

    // §5.1 step 7.
    updateMarker(cfg, runId, {
      mode: cfg.mode,
      state: 'ready',
      last_error: '',
      lessons: {
        global: lessons.length,
        checked_at: Date.now(),
        // The ids the first turn of this session credits. A standing lesson steered the
        // session as surely as a recalled one did, so it earns the same reinforcement — and
        // the same correction when the session fails. `prompt-recall` consumes this once and
        // stamps `credited_at`.
        injected_ids: lessons.map((l) => l.id).filter(Boolean),
        credited_at: 0,
      },
    });

    // The resume briefing. Everything above this line is what the session waits for;
    // this is emphatically not, and `spawnResume` is where that is argued.
    spawnResume(cfg, payload, runId, agentId, src);

    // §5.6 — the post-compaction re-anchor, on the one source that means "the host just
    // compacted this conversation". A local read of the file `checkpoint --pre` already wrote,
    // so it costs no budget and needs no round trip. It sits below the offline branch on
    // purpose rather than beside it: the anchor's only use is asking the server for detail
    // that was compacted away, and the offline block has just told the model not to try.
    const anchor = src === 'compact' ? latestCheckpointId(cfg, runId) : '';

    // The one line a user reads at a glance, so it carries a count only when there is one to
    // stand behind. A total printed off a listing that had more behind it is the number
    // somebody acts on, and "0" is the reading that costs the most: it says the project has
    // learned nothing, which is the claim this page cannot make.
    const standing = lessonsPartial
      ? 'global lessons: partial listing'
      : `${lessons.length} global lesson${lessons.length === 1 ? '' : 's'}`;
    const summary = `mubit: ${cfg.mode}${DOT}run ${runId}${DOT}${standing}`;

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: steerBlock(cfg, runId, lessons, anchor, lessonsPartial),
      },
      // §16.2's hint fires once, ever, per install, so on that one session it *takes* the
      // line rather than being appended to it: `systemMessage` is one line by contract, and
      // the run and mode it would displace are already named in the steer block above.
      systemMessage: statusLineHint || summary,
    };
  },
});

// ---------------------------------------------------------------------------
// The resume briefing
// ---------------------------------------------------------------------------

/**
 * §5.1 step 7's last act: fire `session-resume` and forget about it.
 *
 * The whole feature turns on this call being fire-and-forget. `SessionStart` is a **blocking**
 * hook — Claude Code holds the session open for it, with a 5 s host timeout and a 2500 ms
 * internal budget — and the briefing costs a `/v2/control/context` round trip, which is two
 * LLM calls and a 20 s deadline. Awaiting any part of it here would open every session in the
 * world on a stalled hook, and would blow the budget often enough that the *steer block* would
 * start going missing too. `test/session-resume.test.mjs` pins the wall clock against a
 * `/context` that never answers.
 *
 * ---------------------------------------------------------------------------
 * Only `startup` and `resume`
 * ---------------------------------------------------------------------------
 * `SessionStart` fires on five sources and three of them already have the answer:
 *
 *   - **`clear`** asks for a blank slate and `lib/runid.mjs` gives it one — a brand-new run id
 *     with nothing under it. There is no "where we left off" to describe, and dialling for one
 *     spends two LLM calls to be told so.
 *   - **`compact`** is re-anchored for free a few lines above: the checkpoint id `checkpoint
 *     --pre` stored does the same job with no round trip and against a transcript that is
 *     actually there.
 *   - **`fork`** continues a conversation that is already in the model's window, so the
 *     briefing would describe context it can still read.
 *
 * That leaves the two where the window is empty and the run has history — which is exactly
 * what "resume" means, whichever of the two words the host used.
 *
 * ---------------------------------------------------------------------------
 * Why the identity goes on argv
 * ---------------------------------------------------------------------------
 * `--run` and `--agent`, the same handoff `cwd-changed` makes to `drain`. The child may not
 * re-derive: `deriveRunId` increments and persists `clear_count` on a `clear` source, so a
 * second process would produce `-c2` where this one produced `-c1` and write it back. The
 * payload rides along only because `lib/hook.mjs` needs a parseable object on stdin; nothing
 * in it is read for identity.
 *
 * A briefing that could not be started costs this session its summary and nothing else.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} payload
 * @param {string} runId
 * @param {string} agentId
 * @param {string} src  the normalised `SessionStart` source
 * @returns {void}
 */
function spawnResume(cfg, payload, runId, agentId, src) {
  try {
    if (!cfg.resumeBlock || !cfg.recall) return;
    if (src !== 'startup' && src !== 'resume') return;

    const payloadPath = stashPayload(cfg, payload);
    if (!payloadPath) {
      log(cfg, 'warn', 'session-start: could not stage the resume payload; this session opens '
        + 'without a briefing', { run_id: runId });
      return;
    }
    spawnDetached(cfg, 'session-resume', ['--run', runId, '--agent', agentId], payloadPath);
    log(cfg, 'debug', 'session-start: resume briefing spawned', { run_id: runId });
  } catch (err) {
    log(cfg, 'warn', `session-start: could not start the resume briefing (${messageOf(err)})`,
      { run_id: runId });
  }
}

// ---------------------------------------------------------------------------
// The injected blocks
// ---------------------------------------------------------------------------

/**
 * §5.1 stdout. Two loads are carried here and nothing else: which run this session writes
 * to, and the instruction not to go looking for memory that arrives on its own.
 *
 * §5.6 adds a third on one source only. `anchor` is empty except immediately after a
 * compaction, and an empty one renders nothing — a session that never compacted has no
 * pre-compaction context, and claiming otherwise is a sentence the model would act on.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {{id: string, type: string, content: string}[]} lessons
 * @param {string} [anchor]  §5.6 checkpoint id, or '' when there is nothing to re-anchor to
 * @param {boolean} [partial]  the standing set was read off a page that had more behind it
 * @returns {string}
 */
function steerBlock(cfg, runId, lessons, anchor = '', partial = false) {
  // How a skill is invoked, which is the one line of this block that is not host-neutral.
  // Claude Code takes `/mubit-memory:recall` as a slash command; Codex lists the same skill as
  // `mubit-memory:recall` and has no slash form. Telling a Codex model to type a slash command
  // it does not have is a small lie in the one place it is most likely to be acted on — this
  // block is the only Mubit context a Codex session gets before its first turn, because the
  // MCP server's `instructions` frame does not appear to reach the model there at all.
  const skill = (name) => (cfg.host === 'codex' ? `mubit-memory:${name}` : `/mubit-memory:${name}`);

  const lines = [
    '# Mubit memory is active',
    '',
    `Run: ${runId} (${cfg.mode})`,
  ];
  // The three lines of guidance are the MCP server's `instructions` restated
  // (`mcp/src/instructions.mjs`). Claude Code puts those in the system prompt of every session,
  // so here they were paid twice — and this block fires on every startup, resume, clear and
  // compaction, which made it the most frequent injection the plugin makes. Codex has no such
  // frame: the instructions do not reach the model there, so this block stays the only steer.
  if (cfg.host === 'codex') {
    lines.push(
      'Relevant memory is injected automatically before each of your turns — no need to open a '
        + 'turn by searching for it.',
      'Do search when the injected memory falls short: mubit_recall for a topic, mubit_diagnose '
        + 'when a command has failed, mubit_dereference for a reference_id you already hold.',
      'Save what you learn with mubit_learned, and credit what helped with mubit_outcome. '
        + `${skill('remember')} and ${skill('recall')} are the explicit forms.`,
    );
  }
  if (anchor) {
    lines.push('', '## Compacted context',
      `Mubit checkpoint ${anchor} holds this run's context from before the compaction that `
      + `just happened. Ask ${skill('recall')} if you need detail that was compacted away.`);
  }
  if (lessons.length || partial) {
    lines.push('', '## Standing lessons (global)');
    // Same qualifier the per-turn injection carries. These were learned in other sessions,
    // possibly in another part of the codebase, and nothing re-checked them against this one.
    lines.push('Learned from earlier work — they may be out of date, so verify before relying '
      + 'on one.');
    for (const l of lessons) lines.push(`- [${l.type}] ${l.content}`);
    if (partial) {
      // Rendering "none" off a listing that had more behind it would state, as a fact, the
      // one thing this read cannot establish.
      lines.push(`This set may be incomplete — it was read from a listing with more than this `
        + `page in it. Ask ${skill('recall')} if a constraint seems to be missing.`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * §5.1, the "there is no instance" case — distinct from `offlineBlock` because the two are
 * different claims and the model acts on the difference. Offline means work is buffered and
 * will be sent when Mubit answers; here nothing is going to answer until a person runs one
 * command, and saying "unreachable" would blame a server that does not exist.
 *
 * Carries no endpoint, because there is none to name — the version this replaced interpolated
 * a blank one and rendered `Mubit at  is unreachable (server_error)`.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {string}
 */
function unconfiguredBlock(cfg, runId) {
  return [
    '# Mubit memory is not configured',
    '',
    `Run: ${runId} (${cfg.mode})`,
    'No Mubit endpoint is set on this machine, so no memory will be injected this session and '
      + 'recall is unavailable — do not search for it, and do not assume anything was recalled.',
    'Work is still captured and buffered locally. Run /mubit-memory:auth to sign in and set an '
      + 'endpoint; what has been buffered is sent once one is configured.',
    '',
  ].join('\n');
}

/**
 * §5.1 "Failure", the case health cannot see. The endpoint answers, so it is not offline and
 * it is not unconfigured — the key is simply not accepted. Naming that precisely is the
 * difference between a user who runs one command and a user who files a bug about memory
 * being empty.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {string}
 */
function unauthenticatedBlock(cfg, runId) {
  return [
    '# Mubit memory is not authenticated',
    '',
    `Run: ${runId} (${cfg.mode})`,
    'Mubit rejected this machine\'s API key, so no memory will be injected this session and '
      + 'recall is unavailable — do not search for it, and do not assume anything was recalled.',
    'Work is still captured and buffered locally. Run /mubit-memory:auth to sign in again; '
      + 'what has been buffered is sent once the key is accepted.',
    '',
  ].join('\n');
}

/**
 * §5.1 "Failure": the model is told, in the same channel it would have received memory in,
 * that there is none this session — and that its work is still being kept.
 *
 * Deliberately carries no lesson section: nothing was fetched, and an empty "Standing
 * lessons" heading reads as "this project has learned nothing", which is a different claim.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {string} state
 * @returns {string}
 */
function offlineBlock(cfg, runId, state) {
  return [
    '# Mubit memory is offline',
    '',
    `Run: ${runId} (${cfg.mode})`,
    `Mubit at ${cfg.endpoint} is unreachable (${state}), so no memory will be injected this `
      + 'session and recall is unavailable — do not search for it, and do not assume anything '
      + 'was recalled.',
    'Work is still captured and buffered locally; it is sent when Mubit answers again.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// §4.7 — the cold-start grace, armed per endpoint
// ---------------------------------------------------------------------------

/**
 * The deadline until which a failure displays as `◍ warming`, armed the first time this
 * endpoint is seen and reused unchanged after that.
 *
 * The record is keyed by `sha256(endpoint)[0:12]`, the same scheme as `breaker/` and
 * `policy/`, so the three join up for anyone reading the data directory. Keying it that way
 * is what gives the intended behaviour on a change of instance for free: a new endpoint has
 * no record and arms a fresh window, and switching back to a previous one finds a record
 * whose deadline is long past, so a familiar instance does not get a warm-up it has not
 * earned.
 *
 * Failing soft is deliberate. If the record cannot be read or written — a read-only data
 * dir, a truncated file — the answer is `0`, meaning "not warming". An unwritable disk must
 * not be able to pin the status line to `warming` forever, which is the failure this whole
 * function exists to end.
 *
 * @param {Record<string, any>} cfg
 * @returns {number} absolute epoch-ms deadline, or 0 when the grace is off or unavailable
 */
function armColdStart(cfg) {
  const grace = Math.max(0, intOr(cfg.coldStartGraceMs, 0));
  if (grace <= 0) return 0;
  try {
    const path = join(dataDir(cfg), 'coldstart', `${endpointHash(cfg)}.json`);
    const stored = readJson(path, null);
    const until = stored && typeof stored === 'object' ? intOr(stored.until, 0) : 0;
    if (until > 0) return until;

    const armed = Date.now() + grace;
    writeJsonAtomic(path, { endpoint: cfg.endpoint, armed_at: Date.now(), until: armed });
    return armed;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// §5.6 — the anchor `checkpoint --pre` left behind
// ---------------------------------------------------------------------------

/**
 * §7: the newest `checkpoint_id` in `runs/<run_id>/checkpoints.json`, or `''`.
 *
 * Read with the same tolerance `hooks/src/checkpoint.mjs` reads it with, and for the same
 * reason: a missing, empty or corrupt file is the normal state of a run that has never
 * compacted, not an error — and this one is on the path of every session that follows one.
 * The list is oldest-first, so the anchor is the last entry.
 *
 * `safeSegment` mirrors `lib/spool.mjs`'s flattening so `runs/<run_id>/` names one directory
 * to every module. A run id can come from a hand-written `.mubit-cc.json`, which makes it
 * untrusted input to a path.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {string}
 */
function latestCheckpointId(cfg, runId) {
  try {
    const path = join(resolveDataDir(cfg), 'runs', safeSegment(runId), 'checkpoints.json');
    const stored = readJson(path, []);
    const list = Array.isArray(stored)
      ? stored
      : (Array.isArray(stored?.checkpoints) ? stored.checkpoints : stored?.items);
    if (!Array.isArray(list)) return '';
    const id = list.at(-1)?.checkpoint_id;
    if (typeof id !== 'string') return '';
    // The id is quoted into a paragraph of `additionalContext`. A control character in a
    // server-assigned id would break out of that sentence, so it never gets the chance.
    return id.trim().replace(/[\u0000-\u001F\u007F]/g, '').slice(0, MAX_ID_CHARS);
  } catch {
    return '';
  }
}

/** @param {any} v @returns {string} */
function safeSegment(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * The standing lessons on one page of the activity feed, in the wire spelling.
 *
 * Two jobs, and the second is the one that is easy to get subtly wrong. Filtering to `global`
 * has to happen here because scope is not a field this route accepts. And the rows have to go
 * back into `{lesson_id, lesson_type, content}` before anything downstream sees them, because
 * both consumers — `readLessons` below and `recordRules` — read the wire names, while the
 * feed nests those fields one level in. A row handed over unmapped is a rule the pre-tool
 * store silently never learns about.
 *
 * @param {any[]} entries `ActivityEntry[]`
 * @returns {{lesson_id: string, lesson_type: string, content: string, scope: string}[]}
 */
function globalLessons(entries) {
  /** @type {{lesson_id: string, lesson_type: string, content: string, scope: string}[]} */
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const n = normalizeActivityLesson(e);
    if (n.scope !== 'global') continue;
    out.push({
      lesson_id: n.id, lesson_type: n.lessonType, content: n.content, scope: n.scope,
    });
  }
  return out;
}

/**
 * `ListLessonsResponse.lessons[]` — `{lesson_id, content, lesson_type, scope, importance}`.
 * A lesson with no content is not a lesson; rendering it would spend a line of the model's
 * context on a bullet with nothing after it.
 *
 * `lesson_id` is kept. It used to be dropped here, and dropping it is what made a standing
 * lesson permanently uncreditable: attribution runs on the ids in
 * `runs/<run_id>/turns/<prompt_id>.json:recalled[]`, so a lesson injected without one could
 * be reinforced by nothing and corrected by nothing. A wrong global lesson then steered
 * every session for good.
 *
 * @param {any} body
 * @returns {{id: string, type: string, content: string}[]}
 */
function readLessons(body) {
  const raw = body && typeof body === 'object' && Array.isArray(body.lessons) ? body.lessons : [];
  /** @type {{id: string, type: string, content: string}[]} */
  const out = [];
  for (const l of raw) {
    if (!l || typeof l !== 'object') continue;
    const content = typeof l.content === 'string' ? l.content.trim() : '';
    if (!content) continue;
    const type = typeof l.lesson_type === 'string' && l.lesson_type.trim()
      ? l.lesson_type.trim()
      : 'lesson';
    const id = typeof l.lesson_id === 'string' ? l.lesson_id.trim() : '';
    out.push({ id, type, content });
    if (out.length >= LESSON_LIMIT) break;
  }
  return out;
}

/**
 * §16.2 steps 2-3 — is the status line actually live, and should we say so once?
 *
 * Whether a plugin can own `statusLine` through a shipped `settings.json` is undocumented and
 * may be ignored by the host, so the plugin finds out by experiment: `bin/statusline.mjs`
 * stamps `last_invoked_at` on its first frame of each session, and this hook compares that
 * against the session-start that preceded it. Newer means the host is invoking it.
 *
 * Returns the one-time hint, or `''` — which is the answer for every case except the single
 * session on which the count reaches two. Never throws: an optional cosmetic feature does not
 * get to break the hook that carries recall.
 *
 * @param {Record<string, any>} cfg
 * @returns {string}
 */
function probeStatusLine(cfg) {
  try {
    // The user turned the widget off. Telling them how to turn on the thing they disabled is
    // the exact behaviour §16.2 is warning about.
    if (cfg.statusLine === false) return '';

    const p = join(dataDir(cfg), LIVENESS_FILE);
    const now = Date.now();
    const rec = readJson(p, null);

    // Step 2, first run: write the marker and conclude nothing. The status line has not had a
    // frame yet, so "no invocation recorded" carries no information on this session.
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      writeJsonAtomic(p, {
        first_seen_at: now,
        last_session_start_at: now,
        last_invoked_at: 0,
        sessions_without: 0,
        notified_at: 0,
      });
      return '';
    }

    const stamped = intOr(rec.last_invoked_at, 0);
    const live = stamped > 0 && stamped >= intOr(rec.last_session_start_at, 0);
    const without = live ? 0 : intOr(rec.sessions_without, 0) + 1;

    // Step 3: once, ever, per install — tracked in the same marker, so a reinstall is the
    // only thing that can ask again. A plugin that nags every session gets uninstalled.
    const notifiedAt = intOr(rec.notified_at, 0);
    const nag = !live && without >= NAG_AFTER_SESSIONS && notifiedAt === 0;

    writeJsonAtomic(p, {
      ...rec,
      last_session_start_at: now,
      sessions_without: without,
      notified_at: nag ? now : notifiedAt,
    });

    if (!nag) return '';
    log(cfg, 'info', 'session-start: status line never invoked; emitting the one-time §16.2 hint');
    return statusLineHint();
  } catch {
    return '';
  }
}

/** §16.2 step 3, verbatim. `<CLAUDE_PLUGIN_ROOT>` is resolved when the host exported it. */
function statusLineHint() {
  const root = String(process.env.CLAUDE_PLUGIN_ROOT ?? '').trim() || '<CLAUDE_PLUGIN_ROOT>';
  return 'mubit: status line not active. Add to your settings.json: '
    + `"statusLine": {"type":"command","command":"node","args":["${root}/bin/statusline.mjs"]}`;
}

/** §4.7 ConnState, rendered raw — `not_responding` is a different fact from `unreachable`. */
function connState(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return /^[a-z_]+$/.test(s) ? s : 'unreachable';
}

/** @param {Record<string, any>} payload */
function sourceOf(payload) {
  return payload && typeof payload.source === 'string' ? payload.source.trim().toLowerCase() : '';
}

function intOr(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

function messageOf(err) {
  if (err && typeof err === 'object' && typeof (/** @type {any} */ (err).message) === 'string') {
    return (/** @type {any} */ (err).message);
  }
  return String(err);
}
