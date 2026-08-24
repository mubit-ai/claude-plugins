// @ts-check
/**
 * `bin/statusline.mjs` — build-guide §10 (the line, the glyph precedence, the cooldown and
 * the rung label) and §16.2 (the degradation ladder).
 *
 * ```
 * ● mubit: cc-my-project-9f2a11c4 · local · recall 6/1.2k tok · saved 12t/1q · lessons 3g
 * ```
 *
 * Three properties matter more than anything this prints:
 *
 *   1. **Network-free.** It reads `status/<run_id>.json` and `breaker/<hash>.json` and
 *      nothing else — no `lib/http.mjs`, no `fetch`, not even transitively. The status line
 *      renders on every frame of the host UI; one that dials Mubit turns a dead server into
 *      a visibly frozen terminal.
 *   2. **Fast.** The §10 budget is < 15 ms. Everything here is two small synchronous reads
 *      plus a config load that is itself cached on disk. The one avoidable cost — the
 *      `git rev-parse` inside `deriveRunId` — is skipped entirely whenever the session map
 *      already names the run, which is every frame after the first `SessionStart`.
 *   3. **It never throws, and it always exits 0.** On a fresh install there is no state at
 *      all, and that is the state every user is in for their first few seconds. A stack
 *      trace there is the first thing they would ever see of this plugin. Every path out of
 *      `render()` is wrapped; the worst outcome is an empty line.
 *
 * Bundled to `bin/statusline.mjs` by §11.2 and registered by `settings.json` (§3.4).
 */

import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONN_STATES, readBreaker } from '../lib/breaker.mjs';
import { loadConfig } from '../lib/config.mjs';
import { readMarker } from '../lib/markers.mjs';
import { deriveRunId, loadSessionMap } from '../lib/runid.mjs';
import { dataDir, readJson, writeJsonAtomic } from '../lib/state.mjs';

/**
 * §16.2 step 2 — the liveness probe. Whether a plugin may own `statusLine` through a shipped
 * `settings.json` is undocumented and may simply be ignored by the host, so the plugin has to
 * find out empirically: this process stamps the marker, and the *next* `session-start` reads
 * it. `session-start` owns the file's creation — a status line that created it would also be
 * asserting the install exists, and §16.2 wants a fresh install to touch nothing at all.
 */
const LIVENESS_FILE = 'statusline-installed.json';

/**
 * Consecutive dry recalls before the line says so, mirroring §4.7's `TIMEOUT_ESCALATION`.
 * The reasoning is the same one: a single empty recall is not a verdict — a fresh run has
 * nothing to recall, and a narrow prompt legitimately matches nothing. A run of them is.
 */
const RECALL_DRY_ESCALATION = 3;

/**
 * Claude Code writes the session blob and closes stdin immediately, so this only ever
 * fires when the host wedges — and even then we can still render, because the run id is
 * derivable without the payload. Short, because a per-frame widget may not stall a frame.
 */
const STDIN_TIMEOUT_MS = 300;

// ---------------------------------------------------------------------------
// §10 — glyph precedence, worst state wins, top to bottom
// ---------------------------------------------------------------------------

/**
 * The §10 table verbatim, ordered worst-first. `warming` is not a `ConnState` — it is a
 * *lens* the cold-start window puts over whatever the two sources agreed on — so it lives
 * here with the glyphs but is never read out of a state file.
 *
 * @type {Record<string, {rank: number, glyph: string, label: string}>}
 */
const DISPLAY = {
  unconfigured:   { rank: 0, glyph: '○', label: 'not configured' },
  auth_failed:    { rank: 1, glyph: '✖', label: 'auth failed' },
  unreachable:    { rank: 2, glyph: '✖', label: 'unreachable' },
  server_error:   { rank: 3, glyph: '▲', label: 'server error' },
  not_responding: { rank: 4, glyph: '◌', label: 'slow' },
  warming:        { rank: 5, glyph: '◍', label: 'warming' },
  ready:          { rank: 6, glyph: '●', label: '' },
};

/**
 * Merge the two disagreeing sources and apply the cold-start lens.
 *
 * The marker was written by the last hook that ran; the breaker file was written by the
 * last call that failed. They can disagree, and §10 says the user gets the worse of the
 * two — a breaker that has seen five refusals is still the truth even if the last marker
 * write predates them, and a marker written by a hook that just got a 401 is still the
 * truth even if the breaker is closed (auth failures never open it, §4.7).
 *
 * **Cold start is resolved here rather than by `readBreaker().display`, deliberately.**
 * `lib/breaker.mjs:290-302` only reports `warming` when the *breaker's* own state is a
 * failure, because the breaker is keyed by endpoint and knows nothing about runs. But
 * `cold_start_until` is a property of the run, which the marker owns: a brand-new run whose
 * breaker is a clean `ready` is still warming. So the lens is applied to the merged view.
 *
 * ---------------------------------------------------------------------------
 * DECISION — `not_responding` vs `warming`, the one pair §10 and §4.7 disagree on.
 *
 * §10's table ranks `◌ slow` above `◍ warming`, which reads as "a timeout streak during
 * warm-up still shows ◌". §4.7's cold-start suppression says the opposite: inside
 * `coldStartGraceMs` a failure "is recorded but the status line shows ◍ warming".
 *
 * **`warming` wins.** Inside the grace window every failure except `auth_failed` displays
 * as `◍ warming`. Three reasons:
 *
 *   1. *Monotonicity.* The suite pins that `unreachable` — which §10 ranks strictly WORSE
 *      than `not_responding` — is suppressed to `◍` inside the window. A rule that
 *      suppressed the worse symptom but let the milder one through would mean a healthier
 *      server showed the scarier glyph. That is not a defensible line to draw.
 *   2. *§4.7 states the rule; §10 states a ranking.* The §10 table answers "which of two
 *      simultaneous facts do I show"; §4.7 answers "is this fact a verdict yet". Cold start
 *      is the second question, and it is asked first. `warming` is not competing with
 *      `not_responding` — it is the answer to whether `not_responding` counts yet.
 *   3. *A timeout is the single most likely thing to happen during warm-up.* Mubit spends
 *      its first seconds warming up; the request that lands there hangs
 *      and aborts. If `not_responding` escaped suppression, `◌ slow` would be the normal
 *      cold-start display and the ◍ glyph would be nearly unreachable — which inverts the
 *      whole point of §4.7 ("a user whose server is still starting must not be told memory
 *      is broken for fifteen seconds").
 *
 * `auth_failed` is the sole exception, and the suite pins it: §4.7 calls it sticky and says
 * it *pins* the status line. A server still warming up does not answer 401, so a 401
 * inside the grace window is a real verdict — and it is the one error the user can fix.
 * ---------------------------------------------------------------------------
 *
 * @param {string} markerState  `marker.state` (§4.8) — a ConnState, or `unknown`
 * @param {string} breakerState `readBreaker().state` (§4.7)
 * @param {boolean} coldStart   `marker.cold_start_until` is still in the future
 * @returns {{glyph: string, label: string}}
 */
function resolveDisplay(markerState, breakerState, coldStart) {
  let worst = 'ready';
  for (const s of [markerState, breakerState]) {
    if (!isConnState(s)) continue;                  // `unknown`, '', or junk: not a verdict
    if (DISPLAY[s].rank < DISPLAY[worst].rank) worst = s;
  }
  // The lens, and the two states it must not cover. `auth_failed` because a server still
  // warming up does not answer 401. `unconfigured` because nothing is warming up — there is
  // no endpoint, and `◍ warming` would promise that waiting fixes it when only the user can.
  if (coldStart && !NEVER_WARMING.has(worst)) worst = 'warming';
  return DISPLAY[worst] ?? DISPLAY.ready;
}

/**
 * The two states the cold-start lens never paints over. Mirrors the set `lib/breaker.mjs`
 * applies inside `readBreaker`; kept as its own copy because this file is bundled standalone
 * and the two lenses are applied to different views (the breaker's own state there, the
 * merged marker-and-breaker view here — see the DECISION note above).
 */
const NEVER_WARMING = new Set(['auth_failed', 'unconfigured']);

/** §4.7: the ConnState union is closed — anything else has no glyph and is not a verdict. */
function isConnState(v) {
  return typeof v === 'string' && /** @type {readonly string[]} */ (CONN_STATES).includes(v);
}

// ---------------------------------------------------------------------------
// The run id — the cheapest correct answer first
// ---------------------------------------------------------------------------

/**
 * Which `status/<run_id>.json` is this session's.
 *
 * The session map is tried first for two reasons. It is *correct* where a bare derivation
 * is not: after a `/clear` the run is `cc-<slug>-<hash>-c1` (§4.3) while a fresh derivation
 * still answers `cc-<slug>-<hash>`, whose 12-hour-TTL marker is still on disk — the status
 * line would happily render the pre-clear run's numbers. And it is *cheap*: `deriveRunId`
 * shells out to `git rev-parse --show-toplevel` inside a repo, which is a process spawn on
 * every frame of the UI.
 *
 * `deriveRunId(cfg, {})` is the fallback — an empty payload deliberately, so it takes the
 * "no host session id" path in `lib/runid.mjs` and never writes a `SessionRecord`. The
 * status line is a reader; a widget that rewrites the session map every frame is not.
 *
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} payload
 * @returns {string}
 */
function resolveRunId(cfg, payload) {
  const mapped = mappedRunId(cfg, payload);
  if (mapped) return mapped;
  try {
    return String(deriveRunId(cfg, {}) ?? '');
  } catch {
    // `static` with no pin is a config error (§4.3). It is a real one, but a status line is
    // not where a user should learn about it — `session-start.mjs` says so out loud.
    return '';
  }
}

/**
 * The run this host session is mapped to, when the mapping is safe to reuse. Mirrors
 * `reusableRun` in `lib/runid.mjs`: a record written under a different strategy is stale by
 * definition, and a record carrying the poisoned `default` literal is not a record at all.
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} payload
 * @returns {string}
 */
function mappedRunId(cfg, payload) {
  try {
    const sessionId = typeof payload?.session_id === 'string' ? payload.session_id.trim() : '';
    if (!sessionId) return '';
    const rec = loadSessionMap(sessionId);
    const id = typeof rec?.run_id === 'string' ? rec.run_id.trim() : '';
    if (!id || id.toLowerCase() === 'default') return '';
    const recorded = typeof rec?.strategy === 'string' ? rec.strategy.trim() : '';
    const wanted = typeof cfg?.runStrategy === 'string' ? cfg.runStrategy.trim() : '';
    if (recorded && wanted && recorded !== wanted) return '';
    return id;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

/**
 * The whole status line, or `''`.
 *
 * `''` — not a placeholder, not an error — is the answer for every empty state: the widget
 * turned off (§10), a fresh install with no data dir, a data dir with no marker yet, and a
 * marker truncated by a SIGKILL mid-rename (`readMarker` degrades a corrupt file to the
 * §4.8 default, which is indistinguishable from "never written", which is silence).
 *
 * @param {Record<string, any>} payload the host's session blob from stdin
 * @returns {string}
 */
export function render(payload = {}) {
  const cfg = loadConfig(process.env);

  // §10: `MUBIT_CC_STATUSLINE=0` or `statusLine: false` prints nothing and exits 0 — an
  // empty status line, not an error. Anything else makes the host draw a failed-command
  // banner on every frame, which is a worse outcome than the widget the user just disabled.
  if (cfg.statusLine === false) return '';

  // Before anything is rendered, and regardless of whether anything *is*: the question §16.2
  // asks is "did the host invoke this process", not "did it have something to say".
  stampLiveness(cfg);

  const runId = resolveRunId(cfg, payload);
  if (!runId) return '';

  const marker = readMarker(cfg, runId);

  // §16.2: no marker at all. `readMarker` cannot say "missing" — it returns the §4.8 default
  // — so the tell is that nothing has ever stamped it. `updateMarker` restamps `updated_at`
  // on every write, so `0` means no hook has run for this run yet.
  if (!(num(marker.updated_at) > 0)) return '';

  const now = Date.now();
  const coldStartUntil = num(marker.cold_start_until);

  // `coldStartUntil` is handed over even though `display` is not used: it is the documented
  // call shape (§4.7), and passing it keeps this call honest if a future reader trusts it.
  const breaker = readBreaker(cfg, { coldStartUntil });

  const { glyph, label } = resolveDisplay(
    str(marker.state), str(breaker.state), coldStartUntil > now,
  );

  /** @type {string[]} */
  const parts = [`${glyph} mubit: ${runId}`, mode(marker, cfg)];
  if (label) parts.push(label);

  // Each group is omitted while it is still all-zero rather than rendered as `recall 0/0
  // tok`. A marker missing a section (an older schema, a partial write that still parsed)
  // takes the same path, which is why nothing here can print `undefined` or `NaN`.
  const recall = group(marker.recall);
  const captured = group(marker.captured);
  const lessons = group(marker.lessons);

  const sources = num(recall.sources);
  const tokens = num(recall.tokens);
  // §16.2 — a recall path that is permanently dead must say so somewhere the user looks.
  // Until this, the worst case rendered as a green `●` beside `recall 0/0 tok`: every hook
  // firing, every call timing out, nothing injected, and no fault reported anywhere. That is
  // the failure that makes a memory plugin look useless rather than broken.
  //
  // Not a ConnState. `resolveDisplay` merges verdicts *about the connection*, and this is a
  // verdict about content — the connection may be perfectly healthy and the store simply
  // unreachable by policy. So it renders as its own segment and leaves the glyph alone.
  const dry = int(num(recall.dry_streak));
  if (dry >= RECALL_DRY_ESCALATION) {
    parts.push(`recall dry ${dry}`);
  } else if (sources > 0 || tokens > 0 || num(recall.ms) > 0) {
    parts.push(`recall ${int(sources)}/${compact(tokens)} tok`);
  }

  const tools = num(captured.tools);
  const turns = num(captured.turns);
  if (tools > 0 || turns > 0) parts.push(`saved ${int(tools)}t/${int(turns)}q`);

  const global = num(lessons.global);
  if (global > 0) parts.push(`lessons ${int(global)}g`);

  // §16.2 — the reflect verdict, for the same reason `recall dry` is above it.
  //
  // Reflect at session end is the only call that can widen a lesson past `run` scope, so a
  // reflect that fails costs the session its cross-session memory outright. It failed 12
  // times over four days and nobody noticed, because the failure logs at `warn` while the
  // success logs at `info`: at the default level a healthy instance and a broken one print
  // exactly the same nothing, and the only other record is a JSON marker nobody cats.
  //
  // Deliberately NOT a ConnState. `resolveDisplay` merges verdicts about the *connection*,
  // and this is a verdict about content — reflect can fail on an instance that is answering
  // everything else perfectly (it does: the failure is a timeout upstream of a healthy
  // service). So it takes a segment and leaves the glyph alone.
  //
  // `failed` only. The skip reasons are all deliberate — disabled, nothing ingested, spool
  // undrained — and a status line that reports intended behaviour as a fault teaches the
  // user to ignore it.
  if (str(group(marker.reflect).status) === 'failed') parts.push('reflect failed');

  // §10/§1.8: rung 1 is the free path at zero LLM calls and needs no label. `rung` is only
  // a label when it is a rung the user is *paying* for — `0` is the §4.8 default for "no
  // recall has happened yet", not a rung, and must never render as `rung 0`.
  const rung = int(num(recall.rung));
  if (rung > 1) parts.push(`rung ${rung}`);

  // §10: an open breaker recovers by itself. The remaining cooldown is the difference
  // between "it comes back in 94 seconds" and "this thing is dead". A closed breaker says
  // nothing at all — noise in a per-frame widget is worse than silence.
  const paused = pausedSeconds(breaker, cfg, now);
  if (paused > 0) parts.push(`paused ${paused}s`);

  return oneLine(parts.join(' · '));
}

/**
 * Seconds left on an open breaker's cooldown, or 0 while it is closed.
 * The clock runs from `openedAt` or from the last half-open probe it spent, whichever is
 * later — the same `Math.max` `allowRequest` uses, so the two never contradict each other.
 * @param {Record<string, any>} breaker
 * @param {Record<string, any>} cfg
 * @param {number} now
 * @returns {number}
 */
function pausedSeconds(breaker, cfg, now) {
  const openedAt = num(breaker?.openedAt);
  if (!(openedAt > 0)) return 0;
  const cooldownMs = num(cfg?.breaker?.cooldownMs);
  if (!(cooldownMs > 0)) return 0;
  const since = Math.max(openedAt, num(breaker?.probeAt));
  const remaining = cooldownMs - (now - since);
  return remaining > 0 ? Math.max(1, Math.ceil(remaining / 1000)) : 0;
}

/**
 * §4.1 derives `mode` from the endpoint host; the marker carries whatever the run was
 * started against. The marker wins so the line describes the run, not the current env.
 * @param {Record<string, any>} marker
 * @param {Record<string, any>} cfg
 * @returns {string}
 */
function mode(marker, cfg) {
  for (const v of [marker?.mode, cfg?.mode]) {
    const s = str(v).trim().toLowerCase();
    if (/^[a-z][a-z0-9-]{0,15}$/.test(s)) return s;
  }
  return 'hosted';
}

// ---------------------------------------------------------------------------
// Coercion — nothing below may throw, and nothing may reach the line as a placeholder
// ---------------------------------------------------------------------------

/** @param {any} v @returns {Record<string, any>} */
function group(v) {
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

/** @param {any} v @returns {number} 0 for `undefined`, `NaN`, `Infinity`, objects, strings */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** @param {any} v @returns {string} `''` rather than `"[object Object]"` or `"undefined"` */
function str(v) {
  return typeof v === 'string' ? v : '';
}

/** @param {number} n @returns {number} */
function int(n) {
  return Math.max(0, Math.trunc(n));
}

/**
 * `1187` -> `1.2k`, matching the §10 example. Whole thousands lose the `.0`, and past ten
 * thousand the decimal is noise in a widget this narrow.
 * @param {number} n
 * @returns {string}
 */
function compact(n) {
  const v = int(n);
  if (v < 1000) return String(v);
  if (v < 10000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(v / 1000)}k`;
}

/**
 * Record that the host invoked us, for the *next* `session-start` to read (§16.2 step 2).
 *
 * Written at most **once per session**, not once per frame: the stamp is skipped as soon as
 * it is newer than the session-start that preceded it, which is true from the second frame
 * onward. A per-frame write would be a filesystem round trip inside a 15 ms budget, spent on
 * a fact that stopped changing after the first frame.
 *
 * Does nothing when the marker is absent. `session-start` creates it (§16.2 step 2), and
 * until it has, this is a fresh install — where the contract is to touch nothing.
 *
 * @param {Record<string, any>} cfg
 */
function stampLiveness(cfg) {
  try {
    const p = join(dataDir(cfg), LIVENESS_FILE);
    const rec = readJson(p, null);
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return;
    if (num(rec.last_invoked_at) >= num(rec.last_session_start_at)) return;
    writeJsonAtomic(p, { ...rec, last_invoked_at: Date.now() });
  } catch { /* a probe that cost the user a frame would be worse than no probe */ }
}

/**
 * §10 renders exactly one line. A run id or a mode carrying a newline — neither should be
 * possible, both come from files this process does not own — must not become two.
 * @param {string} s
 * @returns {string}
 */
function oneLine(s) {
  return s.replace(/[\r\n\t\v\f\u2028\u2029]+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The host's session blob, or `{}`. Never rejects, and never waits on an EOF that is not
 * coming: the payload is a nicety here (it only names the session for the run-id lookup),
 * so a wedged host costs at most `STDIN_TIMEOUT_MS` and a slightly less precise run id.
 * @returns {Promise<Record<string, any>>}
 */
function readStdin() {
  return new Promise((res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { process.stdin.pause(); } catch { /* already closed */ }
      let text = '';
      try { text = Buffer.concat(chunks).toString('utf8'); } catch { text = ''; }
      let parsed = {};
      try {
        const v = JSON.parse(text);
        if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v;
      } catch { /* the status line has no use for a payload it cannot read */ }
      res(parsed);
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);

    try {
      if (process.stdin.isTTY) { finish(); return; }
      const s = process.stdin;
      s.on('data', (c) => {
        try { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8')); } catch { /* skip */ }
      });
      s.on('end', finish);
      s.on('close', finish);
      s.on('error', finish);
      s.resume();
    } catch {
      finish();
    }
  });
}

/**
 * The one line, or `''`. Swallows everything: §16.2 makes "prints nothing, exits 0" the
 * contract for every state this process cannot make sense of.
 * @returns {Promise<string>}
 */
export async function main() {
  let payload = {};
  try { payload = await readStdin(); } catch { payload = {}; }
  try { return render(payload); } catch { return ''; }
}

const selfPath = fileURLToPath(import.meta.url);
const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
// The built status line sits behind a runtime-floor launcher (esbuild.config.mjs §11.1):
// `settings.json` names `bin/statusline.mjs`, which checks the Node version and then imports
// `bin/impl/statusline.mjs`. That handoff is still "run as the entry point" as far as the
// user is concerned, but `process.argv[1]` names the launcher, so the identity check above
// cannot see it. The launcher sets this flag immediately before the import; a test that
// imports this module as a library sets nothing and still gets no side effects.
const launched = typeof globalThis.__mubitLauncherEntry === 'string'
  && basename(selfPath) === basename(globalThis.__mubitLauncherEntry);

if (entryPath === selfPath || launched) {
  process.exitCode = 0;
  // An unhandled rejection or a stray throw from anything above would print a stack trace
  // onto the user's prompt line and exit non-zero. §16.2 forbids both, so both are pinned
  // here as well as inside `main()`.
  process.on('uncaughtException', () => { process.exit(0); });
  process.on('unhandledRejection', () => { process.exit(0); });
  const line = await main();
  if (line) {
    try { process.stdout.write(`${line}\n`); } catch { /* the host closed the pipe */ }
  }
}
