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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ambientPlugins, buildRun, envLeaks, resolveCredentials } from './arms.mjs';
import { pluginManifest } from './paths.mjs';
import { claudeVersion } from './versions.mjs';
import { runClaude, readInit, pluginLoaded } from './metrics.mjs';

/** @typedef {{id: string, title: string, ok: boolean, measured: string, detail?: string, fatal?: boolean}} Check */

/** @param {string} id @param {string} title @param {boolean} ok @param {string} measured @param {string} [detail] @returns {Check} */
const check = (id, title, ok, measured, detail) => ({ id, title, ok, measured, detail });

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

/**
 * Dial the real recall ladder, through the plugin's own `lib/recall.mjs`, and require
 * evidence back.
 *
 * Importing the plugin's modules rather than reimplementing the request is deliberate: the
 * preflight then measures the same config precedence, the same breaker, and the same
 * policy cache the hooks will use, and it cannot drift from them by construction.
 *
 * The failure modes are reported apart because they need different responses:
 *   - `failed`            the endpoint errored — nothing will work; stop.
 *   - `budget_exhausted`  the endpoint is alive but slower than the recall budget; a sweep
 *                         would measure timeouts, not the plugin.
 *   - `no_evidence`       the path is healthy and the store returned nothing. Either the
 *                         account is empty (fine — seed it) or retrieval is down (not fine).
 *                         The check reports which, rather than guessing.
 *
 * @param {object} o
 * @param {string} o.pluginDir @param {string} o.query @param {number} o.budgetMs
 * @param {{endpoint: string, apiKey: string}} o.creds
 * @returns {Promise<Check[]>}
 */
export async function checkRecallCanary({ pluginDir, query, budgetMs, creds }) {
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

    const t0 = Date.now();
    const outcome = await recallMod.recallBlock(cfg, {
      runId: 'tk-preflight-canary',
      agentId: 'tk-preflight',
      query,
      deadline: Date.now() + budgetMs,
      projectDir: process.cwd(),
    });
    const ms = Date.now() - t0;

    /** @type {Check[]} */
    const checks = [check('health', 'backend health', healthOk, `${healthMs}ms ${healthOk ? 'ok' : 'not ok'}`,
      healthOk ? undefined : 'health itself is failing; nothing below this will be meaningful')];

    if (outcome.failed) {
      checks.push(check('recall-canary', 'recall canary returns evidence', false,
        `failed after ${ms}ms — state=${outcome.state || '?'} error=${String(outcome.error || '').slice(0, 120)}`,
        'the recall path errored. Health can be green while /v2/control/query is not — that is exactly what this check is for.'));
      return checks;
    }

    if (outcome.emptyReason === 'budget_exhausted') {
      checks.push(check('recall-canary', 'recall canary returns evidence', false,
        `budget_exhausted after ${ms}ms (budget ${budgetMs}ms)`,
        'the endpoint is alive but slower than recall\'s budget. A sweep from here measures timeouts. Raise MUBIT_CC_RECALL_BUDGET_MS only if you are deliberately measuring a slow instance.'));
      return checks;
    }

    if (outcome.sources > 0) {
      checks.push(check('recall-canary', 'recall canary returns evidence', true,
        `${outcome.sources} sources · ${outcome.tokens} tok · rung ${outcome.rung} · ${ms}ms`));
      return checks;
    }

    // Healthy path, empty result. "The account is empty" and "retrieval is broken" look
    // identical from here, and they need opposite responses — seed it, versus stop. So ask a
    // route that does not go through retrieval (`/v2/control/lessons`) for text that is
    // definitely stored, then feed that text back in as a query. A store with content that
    // cannot find its own content is not empty; it is broken, and this says so in one line
    // instead of leaving the operator to guess.
    /** @type {any[]} */
    let lessons = [];
    try {
      const r = await httpMod.postLessons(cfg, {}, {});
      lessons = r?.body?.lessons ?? r?.lessons ?? [];
    } catch { /* the distinguishing call is best-effort */ }

    if (!lessons.length) {
      checks.push(check('recall-canary', 'recall canary returns evidence', false,
        `no_evidence after ${ms}ms (rung ${outcome.rung}); the store reports 0 global lessons`,
        'the account looks genuinely empty, which is a seeding problem, not an outage. Walk ux/scenarios/W2-01 once, then re-run preflight.'));
      return checks;
    }

    const lesson = lessons[0] || {};
    const seedText = String(lesson.content || lesson.text || '').split(/\s+/).slice(0, 12).join(' ');
    if (!seedText) {
      checks.push(check('recall-canary', 'recall canary returns evidence', false,
        `no_evidence after ${ms}ms; ${lessons.length} lessons are stored but none carries readable text`,
        'the lesson objects have no `content`. The canary cannot form a self-echo query, so it is declining to diagnose rather than guessing.'));
      return checks;
    }

    const echo = await recallMod.recallBlock(cfg, {
      runId: 'tk-preflight-canary',
      agentId: 'tk-preflight',
      query: seedText,
      deadline: Date.now() + budgetMs,
      projectDir: process.cwd(),
    });

    if (echo.sources > 0) {
      checks.push(check('recall-canary', 'recall canary returns evidence', true,
        `the generic query drew a blank, but the self-echo query found ${echo.sources} sources`));
      return checks;
    }

    // Same query, same mode, same everything — except the run it is asked in. If pinning the
    // query to the run that OWNS the lesson finds it, retrieval is working perfectly and the
    // problem is scope: every query is answered only from the run it names, so a lesson is
    // reachable only by the session that wrote it. That is a completely different bug from
    // "retrieval is down", it needs a completely different fix, and reporting the wrong one
    // sends whoever reads this to go and look at a vector index that is fine.
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
      checks.push(check('recall-canary', 'recall canary returns evidence', false,
        `scope, not retrieval: 0 sources in a fresh run, ${scoped.sources} for the SAME query pinned to run "${owningRun.slice(-40)}"`,
        'the search index is healthy. Every lesson here is stored at scope "run" and every query is answered only from the run it names, so a lesson is reachable only by the session that created it — cross-session recall cannot work by construction. Fix the scope lessons are promoted to, not the retrieval path.'));
      return checks;
    }

    checks.push(check('recall-canary', 'recall canary returns evidence', false,
      `no_evidence after ${ms}ms (rung ${outcome.rung}); ${lessons.length} lessons stored, and a query quoting one verbatim finds nothing even when pinned to its own run`,
      'the store has content and cannot find it from any scope. This one really is the retrieval path.'));
    return checks;
  } catch (err) {
    return [check('recall-canary', 'recall canary returns evidence', false, 'canary threw',
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
    ok: checks.every((c) => c.ok),
    checks,
    creds: { endpoint: creds.endpoint, from: creds.from },
    ambient,
  };
}

/** @param {Check[]} checks @returns {string} */
export function renderChecks(checks) {
  const w = Math.max(...checks.map((c) => c.title.length));
  const out = [];
  for (const c of checks) {
    out.push(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.title.padEnd(w)}  ${c.measured}`);
    if (!c.ok && c.detail) out.push(`        ${' '.repeat(w)}  ↳ ${c.detail}`);
  }
  return out.join('\n');
}
