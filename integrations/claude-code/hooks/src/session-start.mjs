// @ts-check
/**
 * `hooks/src/session-start.mjs` — SessionStart (blocking, injection only). Build-guide §5.1.
 *
 * Matchers `startup|resume|clear|compact`. **Budget 2500 ms internal against a 5 s hook
 * timeout**, with three sub-budgets: health 400 ms, register 600 ms, lessons 900 ms.
 * Missing a sub-budget degrades *that section only* — a slow lesson list costs the lesson
 * list, not the steer block. The one thing this hook may never do is fail to speak: Claude
 * Code waits for it, and a session that starts with nothing injected is a session where the
 * model has no idea memory exists.
 *
 * The flow is §5.1 verbatim:
 *
 *   1. `loadConfig`; with capture AND recall both off there is nothing to say and nobody to
 *      say it to — emit `{}` and dial nothing.
 *   2. `deriveRunId` honouring the §4.3 `source` table (that module owns the whole table,
 *      including `/clear`'s counter and the session-map write).
 *   3. `marker.cold_start_until = now + coldStartGraceMs` (§4.7) — the grace window starts
 *      here, so a server still starting up does not read as "memory broken".
 *   4. `GET /v2/core/health` @400 ms. Not ok → skip 5-6 but **still steer**, saying memory is
 *      offline. Without that the model invents recall or apologises for its absence.
 *   5. `POST /v2/control/agents/register` @600 ms — or `/heartbeat` when `source === "resume"`,
 *      because re-registering an agent that never left is noise the control plane reconciles.
 *   6. `POST /v2/control/lessons {scope:"global", limit:5}` @900 ms. **No `run_id`**:
 *      `ListLessonsRequest.run_id` is optional and empty means all runs, which is exactly what
 *      "global lessons" wants — scoping it to this run returns nothing on a brand-new one.
 *   7. Assemble `additionalContext`, update the marker, emit.
 *
 * The steer block does two jobs. It names the run and the mode, and it tells the model
 * **not to search for memory preemptively**, because recall is injected before every turn.
 * Without that second sentence the model helpfully calls the recall tool on turn one, every
 * time, and pays for it every time.
 */

import { join } from 'node:path';

import { endpointHash } from '../../lib/breaker.mjs';
import { isConfigured, loadConfig } from '../../lib/config.mjs';
import { runHook } from '../../lib/hook.mjs';
import { health, heartbeat, postLessons, registerAgent } from '../../lib/http.mjs';
import { log } from '../../lib/log.mjs';
import { updateMarker } from '../../lib/markers.mjs';
import { deriveAgentId, deriveRunId } from '../../lib/runid.mjs';
import { dataDir, readJson, writeJsonAtomic } from '../../lib/state.mjs';

/** §5.1: 2500 ms internal. The harness gets a slightly looser leash so the internal
 *  deadline — which still returns a steer block — is always the one that fires first. */
const BUDGET_MS = 2500;
const HARNESS_BUDGET_MS = 3200;

/** §5.1 sub-budgets. Each is clamped to whatever is left of BUDGET_MS. */
const HEALTH_MS = 400;
const REGISTER_MS = 600;
const LESSONS_MS = 900;

/** §5.1: the register body, verbatim. */
const CAPABILITIES = ['code', 'shell', 'edit', 'search'];
const LESSON_LIMIT = 5;

/** U+00B7. The status line and this line share a separator; a hyphen here is a visible bug. */
const DOT = ' · ';

/** §16.2 step 2 — the marker `bin/statusline.mjs` stamps and this hook reads. */
const LIVENESS_FILE = 'statusline-installed.json';

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
    const resuming = sourceOf(payload) === 'resume';
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
      }
    }

    // §5.1 step 6 — global lessons. No run_id: empty means all runs (control.proto).
    // Past its sub-budget this section is dropped, not waited for.
    const lessonBudget = budgetFor(LESSONS_MS);
    /** @type {{type: string, content: string}[]} */
    let lessons = [];
    if (lessonBudget > 0) {
      const lres = await postLessons(cfg, { scope: 'global', limit: LESSON_LIMIT },
        { timeoutMs: lessonBudget });
      if (lres.ok) lessons = readLessons(lres.body);
      else log(cfg, 'info', `session-start: global lessons unavailable (${lres.error})`, { run_id: runId });
    }

    // §5.1 step 7.
    updateMarker(cfg, runId, {
      mode: cfg.mode,
      state: 'ready',
      last_error: '',
      lessons: { global: lessons.length, checked_at: Date.now() },
    });

    const summary = `mubit: ${cfg.mode}${DOT}run ${runId}${DOT}`
      + `${lessons.length} global lesson${lessons.length === 1 ? '' : 's'}`;

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: steerBlock(cfg, runId, lessons),
      },
      // §16.2's hint fires once, ever, per install, so on that one session it *takes* the
      // line rather than being appended to it: `systemMessage` is one line by contract, and
      // the run and mode it would displace are already named in the steer block above.
      systemMessage: statusLineHint || summary,
    };
  },
});

// ---------------------------------------------------------------------------
// The injected blocks
// ---------------------------------------------------------------------------

/**
 * §5.1 stdout. Two loads are carried here and nothing else: which run this session writes
 * to, and the instruction not to go looking for memory that arrives on its own.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {{type: string, content: string}[]} lessons
 * @returns {string}
 */
function steerBlock(cfg, runId, lessons) {
  const lines = [
    '# Mubit memory is active',
    '',
    `Run: ${runId} (${cfg.mode})`,
    'Relevant memory is injected automatically before each of your turns — do not search for '
      + 'it preemptively.',
    'Use /mubit-memory:remember to save a durable lesson, /mubit-memory:recall for a targeted '
      + 'search.',
  ];
  if (lessons.length) {
    lines.push('', '## Standing lessons (global)');
    for (const l of lessons) lines.push(`- [${l.type}] ${l.content}`);
  }
  return `${lines.join('\n')}\n`;
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
// Small helpers
// ---------------------------------------------------------------------------

/**
 * `ListLessonsResponse.lessons[]` — `{lesson_id, content, lesson_type, scope, importance}`.
 * A lesson with no content is not a lesson; rendering it would spend a line of the model's
 * context on a bullet with nothing after it.
 * @param {any} body
 * @returns {{type: string, content: string}[]}
 */
function readLessons(body) {
  const raw = body && typeof body === 'object' && Array.isArray(body.lessons) ? body.lessons : [];
  /** @type {{type: string, content: string}[]} */
  const out = [];
  for (const l of raw) {
    if (!l || typeof l !== 'object') continue;
    const content = typeof l.content === 'string' ? l.content.trim() : '';
    if (!content) continue;
    const type = typeof l.lesson_type === 'string' && l.lesson_type.trim()
      ? l.lesson_type.trim()
      : 'lesson';
    out.push({ type, content });
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
