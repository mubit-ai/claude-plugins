// @ts-check
/**
 * The gate that decides whether a measurement is allowed to be recorded.
 *
 * This exists because of a specific failure that has already happened: the hosted backend
 * spent a window returning `server_error` on ingest and `no_evidence` on recall while
 * `mubit_status` still reported healthy. Every A/B run in that window would have produced
 * clean, plausible, reproducible numbers showing the plugin does nothing — and nothing in
 * the output would have said why. A health ping is not enough; the gate dials the real
 * recall path and refuses on the result.
 *
 * Every check returns the same shape and says what it measured, not just pass/fail. A gate
 * that only says "failed" gets bypassed with `--force` within a week.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ambientPlugins, buildRun, envLeaks, resolveCredentials } from './arms.mjs';
import { pluginManifest } from './paths.mjs';
import { claudeVersion } from './versions.mjs';
import { runClaude, readInit, pluginLoaded } from './metrics.mjs';

/**
 * One measurement, and how much authority it has.
 *
 * `severity` is the difference between a verdict and a reading. A check that omits it blocks
 * — every check written before the §8 split omits it, and a default of `info` would open all
 * of them at once. `info` says the row is measured and reported but never refuses a sweep, in
 * which case `ok` is the measured fact rather than a pass/fail: `renderChecks` labels it
 * `INFO` precisely so nobody reads it as a verdict.
 *
 * @typedef {{id: string, title: string, ok: boolean, measured: string, detail?: string, severity?: 'block'|'info'}} Check
 */

/**
 * @param {string} id @param {string} title @param {boolean} ok @param {string} measured
 * @param {string} [detail] @param {'block'|'info'} [severity] omitted means blocking
 * @returns {Check}
 */
const check = (id, title, ok, measured, detail, severity) => (
  severity ? { id, title, ok, measured, detail, severity } : { id, title, ok, measured, detail }
);

/**
 * The gate's verdict: every blocking check passed.
 *
 * Written as a reduce over `severity !== 'info'` rather than over `ok` alone, because the
 * informational rows are the ones that measure the *shipped* configuration — a fresh run
 * seeing nothing from unrelated runs is `mcpLessonScope: run` working as designed. A gate
 * that refuses the shipped configuration is red every day, gets bypassed with `--force`
 * within a week, and then protects nothing.
 *
 * @param {Check[]} checks @returns {boolean}
 */
export function gateOk(checks) {
  return checks.every((c) => c.severity === 'info' || c.ok);
}

/* -------------------------------------------------------------------------- */
/* 1 — host version                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The host's stream-json shape and its plugin-loading behaviour both move between releases,
 * so the version is part of a run's identity, not trivia. Pin it and two sweeps are
 * comparable; leave it and `compare` cannot know whether a delta is the plugin or the CLI.
 *
 * @param {string} [pinned] the version a previous run recorded
 */
export function checkClaudeVersion(pinned) {
  const v = claudeVersion();
  if (!v) return check('claude-version', 'claude CLI present', false, 'no `claude` on PATH');
  if (pinned && pinned !== v) {
    return check('claude-version', 'claude CLI version', false, `${v} (recorded runs used ${pinned})`,
      'Numbers from a different host version are not comparable. Re-record a baseline, or pass --allow-host-drift.');
  }
  return check('claude-version', 'claude CLI version', true, v);
}

/* -------------------------------------------------------------------------- */
/* 2 — env hygiene                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `lib/config.mjs` puts env above `credentials.json`. A leftover
 * `MUBIT_ENDPOINT=http://127.0.0.1:3100` from a local-server session therefore points the
 * whole sweep at the wrong instance, silently and successfully.
 */
export function checkEnvHygiene() {
  const leaks = envLeaks();
  if (!leaks.length) return check('env', 'no ambient MUBIT_*/CLAUDE_PLUGIN_* env', true, 'clean');
  return check('env', 'no ambient MUBIT_*/CLAUDE_PLUGIN_* env', false,
    leaks.map((l) => `${l.name}=${l.value}`).join(' '),
    'env beats credentials.json, so these silently redirect the run. Unset them in this shell.');
}

/* -------------------------------------------------------------------------- */
/* 3 — the arms are what they claim                                            */
/* -------------------------------------------------------------------------- */

/**
 * One real headless session per arm, reading `system/init` back out.
 *
 * A treatment that did not load the plugin and a control that did are both silent failures
 * that score as "no difference". This is the only check that can tell them apart, and it is
 * why it costs two model calls rather than reading a manifest.
 *
 * @param {object} o
 * @param {string} o.pluginDir @param {string} o.pluginName @param {string} o.model
 * @param {string} o.cwd @param {string[]} o.ambient
 * @returns {Promise<Check[]>}
 */
export async function checkArms({ pluginDir, pluginName, model, cwd, ambient }) {
  const tmp = mkdtempSync(join(tmpdir(), 'tk-preflight-'));
  /** @type {Check[]} */
  const out = [];
  try {
    for (const arm of ['treatment', 'control']) {
      const dataDir = join(tmp, arm, 'data');
      const debugFile = join(tmp, arm, 'debug.log');
      const { argv, env } = buildRun({
        arm,
        pluginDir,
        prompt: 'Reply with exactly: ok',
        model,
        dataDir,
        runId: `tk-preflight-${arm}`,
        debugFile,
        ambient,
      });
      const run = await runClaude({ argv, env, cwd, timeoutMs: 180_000 });
      const init = readInit(run.events);

      if (!init.found) {
        out.push(check(`arm-${arm}`, `${arm} arm loads correctly`, false,
          'no system/init event', run.stderr.slice(-300) || 'the session produced no init event — check `claude` auth'));
        continue;
      }

      const loaded = pluginLoaded(pluginName, init.plugins);
      const errs = init.pluginErrors.length;

      const mcpOk = init.mcpServers.some((s) => /mubit/.test(String(s?.name)) && String(s?.status) === 'connected');
      const toolCount = init.tools.filter((t) => t.startsWith('mcp__') && /mubit/.test(t)).length;
      const skillCount = init.skills.filter((t) => /mubit/.test(t)).length;
      const surface = `plugins=[${init.plugins.join(', ')}] mcp=${mcpOk ? 'connected' : 'absent'} tools=${toolCount} skills=${skillCount} errors=${errs}`;

      if (arm === 'treatment') {
        // Loading the plugin is not enough. The MCP surface is most of its context cost, so
        // an arm with the plugin but no server is a *different plugin* — and it is an easy
        // arm to build by accident (`--strict-mcp-config` alone does it).
        const ok = loaded && errs === 0 && mcpOk && toolCount > 0;
        out.push(check('arm-treatment', 'treatment arm loads the whole plugin', ok, surface,
          ok ? undefined
            : !loaded ? `"${pluginName}" is absent from plugins[]. --plugin-dir pointed somewhere the host would not load; a sweep from here measures nothing.`
            : errs ? JSON.stringify(init.pluginErrors).slice(0, 300)
            : 'the plugin loaded but its MCP server did not connect, so the arm is missing the tools that are most of its context cost. Check for --strict-mcp-config.'));
      } else {
        const ok = !loaded && errs === 0 && !mcpOk && toolCount === 0;
        out.push(check('arm-control', 'control arm is clean', ok, surface,
          ok ? undefined
            : loaded ? 'the ambient marketplace install leaked past --settings; both arms carry the plugin and every delta is noise.'
            : 'the control arm has mubit MCP tools without the plugin — an ambient server is leaking in.'));
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 4 — the backend answers                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `scripts/mcp-probe.mjs --call mubit_status` from the plugin under test: the same server
 * bundle the host would spawn, over real stdio MCP.
 *
 * @param {string} pluginDir @param {{endpoint: string, apiKey: string}} creds
 */
export function checkMcp(pluginDir, creds) {
  const script = join(pluginDir, 'scripts', 'mcp-probe.mjs');
  if (!existsSync(script)) {
    return check('mcp', 'MCP server answers mubit_status', false, 'scripts/mcp-probe.mjs absent',
      'this plugin version has no probe script; the MCP arm cannot be verified here');
  }
  try {
    const t0 = Date.now();
    const out = execFileSync(process.execPath, [script, '--call', 'mubit_status', '--args', '{}', '--json'], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MUBIT_ENDPOINT: creds.endpoint, MUBIT_API_KEY: creds.apiKey },
    });
    const ms = Date.now() - t0;
    const bad = /error|unreachable|auth_failed|server_error/i.test(out);
    return check('mcp', 'MCP server answers mubit_status', !bad, `${ms}ms`,
      bad ? out.slice(0, 400) : undefined);
  } catch (err) {
    return check('mcp', 'MCP server answers mubit_status', false, 'probe failed',
      String(/** @type {any} */ (err).message || err).slice(0, 400));
  }
}

/* -------------------------------------------------------------------------- */
/* 5 — the recall canary (the one that matters)                                */
/* -------------------------------------------------------------------------- */

/** The title both halves of the split share, so `renderChecks` keeps one column width. */
const CANARY_TITLE = 'recall canary: a run reads its own evidence';
const OVERLAY_TITLE = 'cross-run overlay';

/** The run the overlay probe asks from. It only ever reads, so a fixed literal leaves no junk. */
const UNRELATED_RUN = 'tk-preflight-canary';

/**
 * How long a written sentinel gets to become retrievable. Ingest answers `queued`, not
 * `stored`, so this covers the job *and* whatever indexing lag follows it. Twenty seconds is
 * long enough that a healthy hosted instance never trips it and short enough that a preflight
 * still feels like a preflight.
 */
const SENTINEL_LANDING_MS = 20_000;

/** Gap between job polls and between read-back attempts. */
const SENTINEL_POLL_MS = 500;

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, Math.max(0, ms)); t.unref?.(); });

/**
 * §8.1 — the product's actual contract: write a sentinel through the plugin's own ingest
 * path under a fresh pinned run, then read it back under **that same `run_id`**.
 *
 * Red here is a real outage, which is what earns this check the right to stop a sweep. The
 * old canary asked the opposite question — whether a run that has never written anything can
 * retrieve what unrelated runs stored — and that is instance-wide sharing, which the plugin
 * deliberately keeps off. See `checkCrossRunOverlay` for where that question went.
 *
 * Three things the sentinel has to be:
 *   - **unmistakable**: a nonce in the text, so "the run answered" and "the run answered with
 *     the thing we wrote" are different observations.
 *   - **disposable**: the run id is minted per preflight. A fixed literal would accumulate one
 *     item per preflight on the instance, forever.
 *   - **patient about ingest, not about recall**: `POST /v2/control/ingest` returns `queued`.
 *     The job is polled to completion rather than slept on, and an ingest that never lands is
 *     reported as *that* — reporting it as a recall failure sends the reader to a vector index
 *     that is fine.
 *
 * @param {object} o
 * @param {any} o.httpMod @param {any} o.recallMod @param {Record<string,any>} o.cfg
 * @param {number} o.budgetMs @param {number} o.landingMs
 * @returns {Promise<Check>}
 */
async function checkSameRunSentinel({ httpMod, recallMod, cfg, budgetMs, landingMs }) {
  const nonce = `tk-sentinel-${randomBytes(6).toString('hex')}`;
  const runId = `tk-canary-${nonce}`;
  const text = `Preflight sentinel ${nonce}: the mubit testkit wrote this line to check that a run `
    + 'can read back its own evidence. It is disposable and means nothing to anyone else.';

  const t0 = Date.now();
  const landBy = t0 + landingMs;

  const ing = await httpMod.postIngest(cfg, {
    run_id: runId,
    agent_id: 'tk-preflight',
    items: [{
      item_id: `${nonce}-1`,
      content_type: 'text',
      text,
      intent: 'lesson',
      importance: 'medium',
      source: 'agent',
      occurrence_time: Math.floor(t0 / 1000),
      env_tags: ['tool:claude-code', 'test:tk-preflight'],
      metadata_json: JSON.stringify({ testkit: 'preflight-sentinel', nonce }),
    }],
  }, { timeoutMs: Math.max(budgetMs, 10_000) });

  const ingestMs = Date.now() - t0;
  if (!ing.ok) {
    return check('recall-canary', CANARY_TITLE, false,
      `ingest refused after ${ingestMs}ms — state=${ing.state || ing.status || '?'} error=${String(ing.error || '').slice(0, 120)}`,
      'the sentinel could never be written, so nothing below it can be measured. Health can be green while /v2/control/ingest is not — that is exactly what this check is for.');
  }

  // The job poll is a courtesy: `getIngestJob` has no other caller in the plugin, so an
  // instance that does not serve the route is a real possibility and must not fail the gate
  // on its own. The read-back below is the contract.
  //
  // `landed` is therefore claimed only on positive evidence that the write is no longer in
  // flight — `done: true` says so whatever the status string spells, and an absent or silent
  // jobs route says nothing at all. Guessing either way is the §8.1 mistake in one direction
  // or the other: an ingest lag reported as a dead index, or a dead index reported as a queue
  // to wait out. Where there is no evidence, the read-back decides.
  const jobId = String(ing.body?.job_id || '');
  let jobState = jobId ? String(ing.body?.status || 'queued') : 'no job id returned';
  let landed = !jobId;
  let polls = 0;
  while (jobId && Date.now() < landBy) {
    const job = await httpMod.getIngestJob(cfg, runId, jobId, { timeoutMs: Math.max(budgetMs, 5000) });
    polls += 1;
    if (!job.ok) {
      jobState = `job poll unavailable (${job.status || job.state || '?'})`;
      landed = true;
      break;
    }
    const st = String(job.body?.status || '');
    if (String(job.body?.error || '') || st === 'failed') {
      return check('recall-canary', CANARY_TITLE, false,
        `the store rejected the sentinel: job ${jobId} is "${st || 'failed'}" — ${String(job.body?.error || '').slice(0, 120)}`,
        'ingest accepted the item and the job then failed, so nothing this kit writes during a sweep will be stored either.');
    }
    if (job.body?.done === true || st === 'completed' || st === 'succeeded') {
      jobState = st || 'completed';
      landed = true;
      break;
    }
    jobState = st || 'queued';
    await sleep(Math.min(SENTINEL_POLL_MS, landBy - Date.now()));
  }

  // Indexing can lag the job, so the read-back is retried inside the same landing budget
  // rather than attempted once.
  let reads = 0;
  /** @type {any} */
  let last = { sources: 0, rung: 0, emptyReason: 'no_evidence' };
  for (;;) {
    const r0 = Date.now();
    last = await recallMod.recallBlock(cfg, {
      runId,
      agentId: 'tk-preflight',
      query: nonce,
      deadline: Date.now() + budgetMs,
      projectDir: process.cwd(),
    });
    reads += 1;

    if (last.failed) {
      return check('recall-canary', CANARY_TITLE, false,
        `recall failed after ${Date.now() - r0}ms — state=${last.state || '?'} error=${String(last.error || '').slice(0, 120)}`,
        'the recall path errored on a run this kit had just written to. Health can be green while /v2/control/query is not — that is exactly what this check is for.');
    }
    if (last.emptyReason === 'budget_exhausted') {
      return check('recall-canary', CANARY_TITLE, false,
        `budget_exhausted after ${Date.now() - r0}ms (budget ${budgetMs}ms)`,
        'the endpoint is alive but slower than recall\'s budget. A sweep from here measures timeouts. Raise MUBIT_CC_RECALL_BUDGET_MS only if you are deliberately measuring a slow instance.');
    }
    if (String(last.block || '').includes(nonce)) {
      return check('recall-canary', CANARY_TITLE, true,
        `sentinel read back in its own run · ${last.sources} sources · ${last.tokens} tok · rung ${last.rung} · ingest ${ingestMs}ms · ${reads} read${reads === 1 ? '' : 's'} · ${Date.now() - t0}ms`);
    }
    if (Date.now() + SENTINEL_POLL_MS >= landBy) break;
    await sleep(SENTINEL_POLL_MS);
  }

  const totalMs = Date.now() - t0;
  if (!landed) {
    return check('recall-canary', CANARY_TITLE, false,
      `ingest lag, not retrieval: the sentinel was accepted but its job is still "${jobState}" after ${totalMs}ms (${polls} polls)`,
      `the write never landed, so the read below it proves nothing. This is a slow or stalled ingest pipeline, not a dead index. If this instance is known to be slow, the landing budget is ${SENTINEL_LANDING_MS}ms.`);
  }
  if (last.sources > 0) {
    return check('recall-canary', CANARY_TITLE, false,
      `the run answered with ${last.sources} sources after ${totalMs}ms and none of them was its own sentinel`,
      'retrieval is returning something, but not the item this run just stored. A sweep from here measures a store that answers with the wrong evidence, which reads as a working plugin.');
  }
  return check('recall-canary', CANARY_TITLE, false,
    `0 sources for a query quoting its own sentinel verbatim, ${totalMs}ms after the store accepted it (rung ${last.rung})`,
    'project memory is broken: a run cannot retrieve its own evidence. This is the one empty result that is a genuine outage rather than a scoping default, and every W2 scenario depends on it.');
}

/**
 * §8.2 — the probe that used to be the canary, kept for its diagnosis and demoted to
 * informational.
 *
 * The ladder is good: it distinguishes an empty account from a broken index by asking a route
 * that does not go through retrieval (`/v2/control/lessons`) for text that is definitely
 * stored, feeding that text back as a query, and finally pinning the same query to the run
 * that owns the lesson. What it cannot do is *judge*, because the answer it most often gets —
 * a fresh run sees nothing from unrelated runs — is `mcpLessonScope: run` behaving exactly as
 * shipped. Reported as a FAIL it made the gate red every day; reported as a reading it stays
 * useful and stops being a reason to `--force`.
 *
 * Two branches keep the blocking `recall-canary` id, because they are not about scope at all:
 * a ladder that errors or exhausts its budget is a live outage, and a store whose content
 * cannot be found even from the run that owns it really is the retrieval path.
 *
 * @param {object} o
 * @param {any} o.httpMod @param {any} o.recallMod @param {Record<string,any>} o.cfg
 * @param {string} o.query @param {number} o.budgetMs
 * @returns {Promise<Check>}
 */
async function checkCrossRunOverlay({ httpMod, recallMod, cfg, query, budgetMs }) {
  const t0 = Date.now();
  const outcome = await recallMod.recallBlock(cfg, {
    runId: UNRELATED_RUN,
    agentId: 'tk-preflight',
    query,
    deadline: Date.now() + budgetMs,
    projectDir: process.cwd(),
  });
  const ms = Date.now() - t0;

  if (outcome.failed) {
    return check('recall-canary', CANARY_TITLE, false,
      `failed after ${ms}ms — state=${outcome.state || '?'} error=${String(outcome.error || '').slice(0, 120)}`,
      'the recall path errored. Health can be green while /v2/control/query is not — that is exactly what this check is for.');
  }

  if (outcome.emptyReason === 'budget_exhausted') {
    return check('recall-canary', CANARY_TITLE, false,
      `budget_exhausted after ${ms}ms (budget ${budgetMs}ms)`,
      'the endpoint is alive but slower than recall\'s budget. A sweep from here measures timeouts. Raise MUBIT_CC_RECALL_BUDGET_MS only if you are deliberately measuring a slow instance.');
  }

  if (outcome.sources > 0) {
    return check('cross-run-overlay', OVERLAY_TITLE, true,
      `${outcome.sources} sources in an unrelated run · ${outcome.tokens} tok · rung ${outcome.rung} · ${ms}ms — instance-wide sharing is ON`,
      'a run that has never written anything is being answered from other runs. That is not the default; something on this instance widens the scope, and an A/B recorded here is not measuring the shipped configuration.',
      'info');
  }

  /** @type {any[]} */
  let lessons = [];
  try {
    const r = await httpMod.postLessons(cfg, {}, {});
    lessons = r?.body?.lessons ?? r?.lessons ?? [];
  } catch { /* the distinguishing call is best-effort */ }

  if (!lessons.length) {
    return check('cross-run-overlay', OVERLAY_TITLE, false,
      `0 sources in an unrelated run after ${ms}ms; the store reports 0 global lessons — nothing to overlay`,
      'the account looks genuinely empty, so this row measures nothing either way. Walk ux/scenarios/W2-01 once if you want a reading here.',
      'info');
  }

  const lesson = lessons[0] || {};
  const seedText = String(lesson.content || lesson.text || '').split(/\s+/).slice(0, 12).join(' ');
  if (!seedText) {
    return check('cross-run-overlay', OVERLAY_TITLE, false,
      `0 sources in an unrelated run; ${lessons.length} lessons are stored but none carries readable text`,
      'the lesson objects have no `content`. The overlay cannot form a self-echo query, so it is declining to diagnose rather than guessing.',
      'info');
  }

  const echo = await recallMod.recallBlock(cfg, {
    runId: UNRELATED_RUN,
    agentId: 'tk-preflight',
    query: seedText,
    deadline: Date.now() + budgetMs,
    projectDir: process.cwd(),
  });

  if (echo.sources > 0) {
    return check('cross-run-overlay', OVERLAY_TITLE, true,
      `the generic query drew a blank, but a self-echo query found ${echo.sources} sources in an unrelated run — instance-wide sharing is ON`,
      'a run that has never written anything is being answered from other runs; an A/B recorded here is not measuring the shipped configuration.',
      'info');
  }

  // Same query, same mode, same everything — except the run it is asked in. If pinning the
  // query to the run that OWNS the lesson finds it, retrieval is working perfectly and the
  // answer is scope: every query is answered only from the run it names. That is not a defect
  // to fix here, it is `mcpLessonScope: run`, and reporting it as a failure sends whoever
  // reads this to go and look at a vector index that is fine.
  const owningRun = String(lesson.source_run_id || '');
  let scoped = null;
  if (owningRun) {
    scoped = await recallMod.recallBlock(cfg, {
      runId: owningRun,
      agentId: 'tk-preflight',
      query: seedText,
      deadline: Date.now() + Math.max(budgetMs, 5000),
      projectDir: process.cwd(),
    });
  }

  if (scoped && scoped.sources > 0) {
    return check('cross-run-overlay', OVERLAY_TITLE, false,
      '0 sources in an unrelated run — instance-wide sharing is off; expected at mcpLessonScope=run',
      `the search index is healthy: the SAME query found ${scoped.sources} sources pinned to run "${owningRun.slice(-40)}", the one that owns the lesson. Every lesson here is stored at scope "run" and every query is answered only from the run it names. Cross-session recall within a project rides the same run_id and is unaffected — see docs/SCOPE.md §1.2.`,
      'info');
  }

  return check('recall-canary', CANARY_TITLE, false,
    `${lessons.length} lessons stored, and a query quoting one verbatim finds nothing even when pinned to its own run`,
    'the store has content and cannot find it from any scope. This one really is the retrieval path, and it is a reason to stop.');
}

/**
 * Dial the real recall path, through the plugin's own `lib/recall.mjs`, and require evidence
 * back — from the run that wrote it.
 *
 * Importing the plugin's modules rather than reimplementing the request is deliberate: the
 * preflight then measures the same config precedence, the same breaker, and the same policy
 * cache the hooks will use, and it cannot drift from them by construction.
 *
 * §8 splits what used to be one check, because it conflated three states and only two of them
 * are a reason to refuse a measurement:
 *
 *   | state                     | what it means                                  | blocks |
 *   | retrieval outage          | the endpoint errors, or `budget_exhausted`     | yes    |
 *   | project memory broken     | a run cannot retrieve its OWN evidence         | yes    |
 *   | instance-wide sharing off | a fresh run sees nothing from unrelated runs   | no     |
 *
 * The first two are `recall-canary`; the third is `cross-run-overlay`, informational. The
 * overlay is skipped entirely when the sentinel is already red: diagnosing cross-run reach
 * after same-run recall is down spends round trips to explain the wrong thing.
 *
 * @param {object} o
 * @param {string} o.pluginDir @param {string} o.query @param {number} o.budgetMs
 * @param {{endpoint: string, apiKey: string}} o.creds
 * @param {number} [o.landingMs] how long the sentinel gets to become retrievable
 * @returns {Promise<Check[]>}
 */
export async function checkRecallCanary({ pluginDir, query, budgetMs, creds, landingMs }) {
  const tmp = mkdtempSync(join(tmpdir(), 'tk-canary-'));
  try {
    const cfgMod = await import(pathToFileURL(join(pluginDir, 'lib', 'config.mjs')).href);
    const recallMod = await import(pathToFileURL(join(pluginDir, 'lib', 'recall.mjs')).href);
    const httpMod = await import(pathToFileURL(join(pluginDir, 'lib', 'http.mjs')).href);

    const cfg = cfgMod.loadConfig({
      ...process.env,
      MUBIT_ENDPOINT: creds.endpoint,
      MUBIT_API_KEY: creds.apiKey,
      MUBIT_CC_DATA_DIR: tmp,
      MUBIT_CC_LOG_LEVEL: 'error',
    });

    const h0 = Date.now();
    const h = await httpMod.health(cfg, {});
    const healthMs = Date.now() - h0;
    const healthOk = Boolean(h?.ok);

    /** @type {Check[]} */
    const checks = [check('health', 'backend health', healthOk, `${healthMs}ms ${healthOk ? 'ok' : 'not ok'}`,
      healthOk ? undefined : 'health itself is failing; nothing below this will be meaningful')];

    const sentinel = await checkSameRunSentinel({
      httpMod, recallMod, cfg, budgetMs, landingMs: landingMs ?? SENTINEL_LANDING_MS,
    });
    checks.push(sentinel);
    if (!sentinel.ok) return checks;

    checks.push(await checkCrossRunOverlay({ httpMod, recallMod, cfg, query, budgetMs }));
    return checks;
  } catch (err) {
    return [check('recall-canary', CANARY_TITLE, false, 'canary threw',
      String(/** @type {any} */ (err).message || err).slice(0, 400))];
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* the whole gate                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} o
 * @param {string} o.pluginDir @param {string} o.model @param {string} o.cwd
 * @param {string} [o.canary] @param {number} [o.budgetMs] @param {string} [o.pinnedClaude]
 * @param {boolean} [o.skipArms] skip the two model calls — for offline tests only
 * @returns {Promise<{ok: boolean, checks: Check[], creds: {endpoint: string, from: string}, ambient: string[]}>}
 */
export async function preflight(o) {
  const manifest = pluginManifest(o.pluginDir);
  const pluginName = String(manifest.name || 'mubit-memory');
  const ambient = ambientPlugins(o.cwd);
  const creds = resolveCredentials();

  /** @type {Check[]} */
  const checks = [checkClaudeVersion(o.pinnedClaude), checkEnvHygiene()];

  checks.push(check('creds', 'credentials resolved', Boolean(creds.endpoint && creds.apiKey),
    `${creds.endpoint || '(none)'} from ${creds.from}`,
    creds.apiKey ? undefined : 'no API key found. Run /mubit-memory:auth, or export MUBIT_ENDPOINT and MUBIT_API_KEY.'));

  if (creds.endpoint && creds.apiKey) {
    checks.push(...await checkRecallCanary({
      pluginDir: o.pluginDir,
      query: o.canary || 'what conventions and constraints apply to this project',
      budgetMs: o.budgetMs ?? 3000,
      creds,
    }));
    checks.push(checkMcp(o.pluginDir, creds));
  }

  if (!o.skipArms) {
    checks.push(...await checkArms({ pluginDir: o.pluginDir, pluginName, model: o.model, cwd: o.cwd, ambient }));
  }

  return {
    ok: gateOk(checks),
    checks,
    creds: { endpoint: creds.endpoint, from: creds.from },
    ambient,
  };
}

/**
 * An informational row is labelled `INFO`, never PASS or FAIL, because it is a reading and
 * not a verdict — and it prints its `detail` whether or not it "passed", since the
 * explanation is the entire reason the row exists. A blocking row keeps the old behaviour:
 * PASS/FAIL, and detail only when there is something to answer for.
 *
 * @param {Check[]} checks @returns {string}
 */
export function renderChecks(checks) {
  const w = Math.max(...checks.map((c) => c.title.length));
  const out = [];
  for (const c of checks) {
    const info = c.severity === 'info';
    out.push(`  ${info ? 'INFO' : c.ok ? 'PASS' : 'FAIL'}  ${c.title.padEnd(w)}  ${c.measured}`);
    if (c.detail && (info || !c.ok)) out.push(`        ${' '.repeat(w)}  ↳ ${c.detail}`);
  }
  return out.join('\n');
}
