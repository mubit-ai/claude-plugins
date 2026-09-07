// @ts-check
/**
 * `bin/handoff.src.mjs` — what `/mubit-memory:handoff` runs. Bundled to `bin/handoff.mjs`.
 *
 * ---------------------------------------------------------------------------
 * Why a script rather than an MCP tool
 * ---------------------------------------------------------------------------
 * The same reason `pin` is one: the vendored server registers no handoff tool and cannot be
 * rebuilt here, and the allowlist stays at the seven tools a session pays for. So the surface
 * is a skill with a `Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/handoff.mjs:*)` grant and a small
 * binary that talks to the control plane itself.
 *
 * ---------------------------------------------------------------------------
 * Three verbs, and what each refuses
 * ---------------------------------------------------------------------------
 *   send      `--to <agent> [--action review|continue|approve|execute] [--task <id>] <text>`
 *   list      `[--open] [--run <id>] [--json]`
 *   feedback  `<handoff_id> --verdict approve|request_changes|block|acknowledge [--comments <text>]`
 *
 * `list` is the default, because it is the verb that changes nothing. A `send` with no `--to`
 * or no text is refused before anything is dialed, and so is an action or a verdict outside
 * the server's vocabulary: the server answers those with a 400, and a 400 reads like a fault
 * to everything downstream.
 *
 * ---------------------------------------------------------------------------
 * The run is the one the hooks are using
 * ---------------------------------------------------------------------------
 * `pickRun` reads the newest run marker rather than re-deriving the run — `bin/pin.src.mjs`
 * explains why at length — and refuses `default` (the shared fallback id) and an ambiguous
 * pair of live runs by name. A handoff filed under the wrong run is one nobody lists.
 *
 * The sender is this host's role (`claude-code` or `codex`) unless `--from` names one; a
 * subagent's note is filed by `capture --subagent`, not here, so the sub-agent form of the id
 * is never typed at this surface.
 *
 * Nothing here logs the API key, and no returned object contains it.
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../lib/config.mjs';
import {
  FEEDBACK_VERDICTS, HANDOFF_ACTIONS, listHandoffs, renderHandoff, sendHandoff, submitFeedback,
} from '../lib/handoff.mjs';
import { deriveAgentId } from '../lib/runid.mjs';
import { pickRun } from '../lib/runpick.mjs';
import { dataDirFlag } from '../lib/state.mjs';

const USAGE = `mubit-memory: hand work to another agent, list what is open, or answer a handoff.

  node bin/handoff.mjs send --to <agent> [--action review|continue|approve|execute] [--task <id>] <text>
  node bin/handoff.mjs list [--open] [--run <id>] [--json]
  node bin/handoff.mjs feedback <handoff_id> --verdict approve|request_changes|block|acknowledge [--comments <text>]

  --run <id>        the run to act in; the default is the run this session's hooks are using
  --from <agent>    the sending agent; the default is this host's role
  --data-dir <dir>  the plugin data directory the session's hooks write to
  --json            one JSON object on stdout
`;

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

/**
 * Parse argv into an intent. Only *known* flags are consumed, on `bin/pin.src.mjs`'s rule: a
 * note may itself start with `--`, and a blanket filter would swallow the user's first word.
 *
 * @param {string[]} argv
 * @returns {Record<string, any>}
 */
export function parseArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.map((a) => String(a ?? '')) : [];
  const flag = (f) => args.includes(f);
  const valueOf = (f) => {
    const i = args.indexOf(f);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : '';
  };

  const takesValue = new Set(['--to', '--action', '--task', '--from', '--run', '--data-dir', '--verdict', '--comments']);
  const known = new Set([...takesValue, '--open', '--json', '--help', '-h']);
  /** @type {string[]} */
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (takesValue.has(a)) { i++; continue; }
    if (known.has(a)) continue;
    positional.push(a);
  }

  const first = (positional[0] ?? '').toLowerCase();
  const verbs = new Set(['send', 'list', 'ls', 'feedback', 'answer']);
  const action = verbs.has(first)
    ? ({ ls: 'list', answer: 'feedback' }[first] ?? first)
    : 'list';
  const rest = verbs.has(first) ? positional.slice(1) : positional;

  return {
    action,
    text: rest.join(' ').trim(),
    to: valueOf('--to').trim(),
    requestedAction: valueOf('--action').trim().toLowerCase(),
    task: valueOf('--task').trim(),
    from: valueOf('--from').trim(),
    runId: valueOf('--run').trim(),
    dataDir: dataDirFlag(valueOf('--data-dir')),
    verdict: valueOf('--verdict').trim().toLowerCase(),
    comments: valueOf('--comments'),
    open: flag('--open'),
    json: flag('--json'),
    help: flag('--help') || flag('-h'),
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 * @param {{log?: (m: string) => void, cfg?: Record<string, any>}} [deps]
 * @returns {Promise<number>} process exit code
 */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const log = deps.log ?? console.log;
  const args = parseArgs(argv);
  /** @param {Record<string, any>} payload */
  const emit = (payload) => {
    log(args.json ? JSON.stringify(payload) : String(payload.detail ?? ''));
    return payload.ok ? 0 : 1;
  };
  if (args.help) { log(USAGE); return 0; }

  let cfg;
  try {
    cfg = deps.cfg ?? loadConfig(args.dataDir ? { ...env, MUBIT_CC_DATA_DIR: args.dataDir } : env);
  } catch (err) {
    return emit({ ok: false, state: 'config_error', detail: `Could not read the plugin configuration: ${messageOf(err)}` });
  }

  if (!str(cfg.endpoint)) {
    return emit({
      ok: false,
      state: 'unconfigured',
      detail: 'No Mubit endpoint is configured, so there is nowhere to hand off to. Run /mubit-memory:auth.',
    });
  }

  const run = pickRun(cfg, args.runId, { command: 'handoff' });
  if (!run.ok) return emit({ ok: false, state: run.state, detail: run.detail });
  const runId = run.runId;
  const from = args.from || attempt(() => deriveAgentId({}), '');

  if (args.action === 'send') return emit(await doSend(cfg, runId, from, args));
  if (args.action === 'feedback') return emit(await doFeedback(cfg, runId, from, args));
  return emit(await doList(cfg, runId, args));
}

// ---------------------------------------------------------------------------
// The three verbs
// ---------------------------------------------------------------------------

/** @param {Record<string, any>} cfg @param {string} runId @param {string} from @param {Record<string, any>} args */
async function doSend(cfg, runId, from, args) {
  if (!args.to) {
    return { ok: false, state: 'no_recipient', run_id: runId, detail: 'Say who this is for: handoff send --to <agent> "<note>".' };
  }
  const content = args.text.trim();
  if (!content) {
    return { ok: false, state: 'empty', run_id: runId, detail: 'Nothing to hand off. Give the note as the argument: handoff send --to codex "<what they should pick up>".' };
  }
  const action = args.requestedAction || 'continue';
  if (!HANDOFF_ACTIONS.includes(action)) {
    return {
      ok: false, state: 'bad_action', run_id: runId,
      detail: `--action must be one of ${HANDOFF_ACTIONS.join(', ')}; "${args.requestedAction}" is not something the instance accepts.`,
    };
  }

  const res = await sendHandoff(cfg, {
    run_id: runId, to_agent_id: args.to, from_agent_id: from, content, requested_action: action, task_id: args.task,
  });
  if (!res.ok) return failed('send that handoff in', runId, res);

  return {
    ok: true,
    state: 'sent',
    run_id: runId,
    handoff_id: res.id,
    to: args.to,
    from,
    action,
    detail: `Handed off to ${args.to} in ${runId} (${action}): ${res.id || '(no id returned)'}\n`
      + `  Answer it with: handoff feedback ${res.id || '<handoff_id>'} --verdict approve`,
  };
}

/** @param {Record<string, any>} cfg @param {string} runId @param {Record<string, any>} args */
async function doList(cfg, runId, args) {
  const res = await listHandoffs(cfg, runId, { open: args.open });
  if (!res.ok) return failed('list the handoffs in', runId, res);

  const which = args.open ? 'open' : '';
  return {
    ok: true,
    state: 'listed',
    run_id: runId,
    handoffs: res.handoffs,
    orphans: res.orphans,
    detail: res.handoffs.length
      ? [
        `${res.handoffs.length} ${which ? `${which} ` : ''}handoff(s) in ${runId}:`,
        ...res.handoffs.map(renderHandoff),
        ...(res.orphans ? [`  (${res.orphans} feedback entr${res.orphans === 1 ? 'y' : 'ies'} name a handoff outside this listing)`] : []),
      ].join('\n')
      : `No ${which ? `${which} ` : ''}handoffs in ${runId}.`,
  };
}

/** @param {Record<string, any>} cfg @param {string} runId @param {string} from @param {Record<string, any>} args */
async function doFeedback(cfg, runId, from, args) {
  const handoffId = args.text.split(/\s+/)[0] ?? '';
  if (!handoffId) {
    return { ok: false, state: 'no_handoff', run_id: runId, detail: 'Name the handoff: handoff feedback <handoff_id> --verdict approve. `handoff list --open` prints the ids.' };
  }
  if (!args.verdict) {
    return { ok: false, state: 'no_verdict', run_id: runId, detail: `A verdict is required: --verdict ${FEEDBACK_VERDICTS.join('|')}.` };
  }
  if (!FEEDBACK_VERDICTS.includes(args.verdict)) {
    return {
      ok: false, state: 'bad_verdict', run_id: runId,
      detail: `--verdict must be one of ${FEEDBACK_VERDICTS.join(', ')}; "${args.verdict}" is not something the instance accepts.`,
    };
  }

  const res = await submitFeedback(cfg, {
    run_id: runId, handoff_id: handoffId, verdict: args.verdict, comments: args.comments, from_agent_id: from,
  });
  if (!res.ok) return failed('record that feedback in', runId, res);

  return {
    ok: true,
    state: 'answered',
    run_id: runId,
    handoff_id: handoffId,
    feedback_id: res.id,
    verdict: args.verdict,
    detail: `Feedback ${args.verdict} on ${handoffId} in ${runId}: ${res.id || '(no id returned)'}`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @param {string} what @param {string} runId @param {{state?: string, error?: string}} res */
function failed(what, runId, res) {
  return {
    ok: false,
    state: str(res?.state) || 'upstream_failed',
    run_id: runId,
    // `res.error` has already been scrubbed of the API key by `lib/http.mjs`.
    detail: `Could not ${what} ${runId}: ${str(res?.error) || 'the instance did not answer'}`,
  };
}

function attempt(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/** @param {any} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** @param {any} err @returns {string} */
function messageOf(err) {
  try {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    return [err.name, err.message].filter(Boolean).join(': ') || String(err);
  } catch {
    return 'unknown error';
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** `p` with its symlinks resolved — `bin/pin.src.mjs` says why the guard needs it. */
function realPath(p) {
  try { return p ? realpathSync(p) : p; } catch { return p; }
}

const selfPath = fileURLToPath(import.meta.url);
const selfReal = realPath(selfPath);
const entryPath = process.argv[1] ? realPath(resolve(process.argv[1])) : '';

if (entryPath === selfReal) {
  process.exitCode = await main().catch((err) => {
    console.log(`handoff could not run: ${err?.message ?? err}`);
    return 1;
  });
}
