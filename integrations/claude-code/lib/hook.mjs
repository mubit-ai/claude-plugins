// @ts-check
/**
 * `lib/hook.mjs` — the harness every hook in this plugin runs inside (§4.9).
 *
 * ---------------------------------------------------------------------------
 * Exit-code discipline is the whole point of this module
 * ---------------------------------------------------------------------------
 * Claude Code reads a hook's exit code first:
 *
 *   0            -> stdout is parsed as JSON
 *   2            -> the hook BLOCKS and stderr becomes the reason shown to the model
 *   other != 0   -> a non-blocking error surfaced to the user
 *
 * **This plugin never exits 2 and never exits non-zero, in any mode, including every
 * failure mode.** A memory layer has no business blocking a prompt or a tool call; the only
 * thing an internal failure should ever cost is the memory itself. `process.exitCode` is
 * therefore pinned to 0 on every path out of here — malformed stdin, a throwing body, a
 * rejected promise, a blown budget, an uncaught exception in a stray callback.
 *
 * Two smaller invariants that fall out of that:
 *
 *   - stdout is ALWAYS a JSON object. `undefined` from a body emits `{}`; a failure emits
 *     `{"suppressOutput": true}` — or, on the three Codex events that reject that field, `{}`.
 *     See `forHost`. Neither host parsing empty stdout is a contract we get to rely on, so we
 *     never produce it.
 *   - the emit is a *synchronous* `write(2)`, not `process.stdout.write`. A body that blew
 *     its deadline still has a live 5-second timer pending; the only way to get out of the
 *     process at that point is `process.exit(0)`, and an async stdout write to a pipe would
 *     be discarded by it.
 *
 * Zero dependencies, Node >= 20 built-ins only, and importable by absolute `file://` URL
 * from a fresh child process — a detached drain does exactly that.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { host, loadConfig } from './config.mjs';
import { log } from './log.mjs';
import { dataDir as resolveDataRoot } from './state.mjs';

/** A body that names no budget gets the most generous hook timeout in `hooks.json` minus slack. */
const DEFAULT_BUDGET_MS = 2500;

/**
 * Claude Code writes the payload and closes stdin immediately, so this only ever fires when
 * the host wedges. It exists so a hook can never hang a tool call waiting on an EOF that is
 * not coming.
 */
const STDIN_TIMEOUT_MS = 2000;

/** `spawnDetached` tells the child to read `--payload` instead of its (ignored) stdin. */
const DETACHED_ENV = 'MUBIT_CC_DETACHED';

/** @type {'timeout'} */
const TIMEOUT = 'timeout';

/**
 * The three Codex events that reject `suppressOutput` (§4.9).
 *
 * Codex checks a hook's stdout twice: against a generated JSON Schema, and then against a set
 * of semantic rules the schema does not carry. `suppressOutput` is a declared property of
 * *every* Codex output schema and is rejected at parse time on exactly these three:
 *
 *     PreToolUse hook returned unsupported suppressOutput
 *     PostToolUse hook returned unsupported suppressOutput
 *     PermissionRequest hook returned unsupported suppressOutput
 *
 * Rejection is not silent — Codex marks the hook failed in the user's transcript, which is a
 * memory layer making itself conspicuous while doing its job correctly. The field buys us
 * nothing on these three: we never attach a `systemMessage` or `additionalContext` to any of
 * them, so there is no output to suppress.
 *
 * Claude Code accepts the field on every event, so this is scoped to the Codex host and the
 * Claude Code suite is the net that says so.
 *
 * `test/fixtures/codex-output-rules.json` in the Codex plugin holds the full extracted table,
 * and `codex-payload.test.mjs` drives every hook against it.
 */
const CODEX_REJECTS_SUPPRESS_OUTPUT = Object.freeze([
  'PreToolUse', 'PostToolUse', 'PermissionRequest',
]);

/**
 * Drop fields the running host would reject. Claude Code gets its value back untouched.
 *
 * @param {any} value    what the body returned
 * @param {string} event `hook_event_name` from the payload, or '' if it never parsed
 * @returns {any}
 */
function forHost(value, event) {
  if (!isObject(value) || !('suppressOutput' in value)) return value;
  if (host(process.env) !== 'codex') return value;
  // An unparseable payload leaves the event unknown. Strip anyway: the field is cosmetic on
  // every Codex event and a visible hook failure on three of them, so the trade is one-sided.
  if (event && !CODEX_REJECTS_SUPPRESS_OUTPUT.includes(event)) return value;
  const { suppressOutput, ...rest } = value;
  return rest;
}

/** `hook_event_name` off a parsed payload, '' when it is missing or not a string. */
function eventNameOf(payload) {
  const v = isObject(payload) ? payload.hook_event_name : undefined;
  return typeof v === 'string' ? v.trim() : '';
}

// ---------------------------------------------------------------------------
// runHook
// ---------------------------------------------------------------------------

/**
 * Read the payload, run `body` under a hard deadline, emit JSON, exit 0.
 *
 * `body` is called as `body(payload, cfg, ctx)`:
 *   - `payload` — the parsed stdin (or `--payload` file) object
 *   - `cfg`     — a `loadConfig()` result, resolved once and shared
 *   - `ctx`     — `{name, args, detached, payloadPath, budgetMs, startedAt, deadlineAt}`
 *
 * Whatever `body` returns is stringified to stdout. `undefined`, `null`, and any non-object
 * become `{}` — stdout that does not parse as a JSON *object* is not something Claude Code
 * has a defined behaviour for.
 *
 * @param {string} name
 * @param {{budgetMs?: number, body?: (payload: any, cfg: any, ctx: any) => any}} [options]
 * @returns {Promise<void>}
 */
export async function runHook(name, options = {}) {
  const startedAt = Date.now();
  process.exitCode = 0;

  const opts = isObject(options) ? options : {};
  const budgetMs = positiveInt(opts.budgetMs, DEFAULT_BUDGET_MS);
  const args = process.argv.slice(2);
  const payloadPath = flagValue(args, '--payload');
  const cfg = safeConfig();

  let settled = false;
  /**
   * The event being answered, for `forHost`. Set the moment the payload parses; the paths
   * that emit before that (unparseable stdin, a body that threw on the way in) leave it '',
   * which `forHost` reads as "strip conservatively".
   */
  let hookEvent = '';
  /**
   * The single exit from this function. Emit, drop the handoff file, leave.
   * @param {any} value
   */
  const finish = (value) => {
    if (settled) return;
    settled = true;
    emit(forHost(value, hookEvent));
    if (payloadPath) {
      // §4.9: "the child unlinks the file when done". Done means here — after the body
      // has run — not at read time, or a crashed child would leave nothing to debug.
      try { unlinkSync(payloadPath); } catch { /* already gone, or never ours */ }
    }
    exitZero();
  };

  // A stray callback throwing after `body` resolved must not turn into exit 1.
  const rescue = (err) => {
    safely(() => log(cfg, 'error', `hook ${name} hit an unhandled failure`, {
      hook: name, detail: describe(err),
    }));
    finish({ suppressOutput: true });
  };
  safely(() => {
    process.on('uncaughtException', rescue);
    process.on('unhandledRejection', rescue);
    // Belt and braces: whatever else happened, this process reports success.
    process.on('exit', () => { process.exitCode = 0; });
  });

  try {
    const raw = payloadPath ? readFileText(payloadPath) : await readStdin();
    const parsed = parseObject(raw);
    if (!parsed.ok) {
      // Exactly one line, and it is the only thing this process says. §12.1 counts it.
      safely(() => log(cfg, 'warn',
        `hook ${name}: stdin payload was not parseable JSON; emitting {} and exiting 0`,
        { hook: name, bytes: raw.length }));
      finish({});
      return;
    }
    hookEvent = eventNameOf(parsed.value);

    /** @type {(p: any, c: any, x: any) => any} */
    const body = typeof opts.body === 'function' ? opts.body : () => undefined;
    const ctx = {
      name,
      args,
      detached: process.env[DETACHED_ENV] === '1',
      payloadPath,
      budgetMs,
      startedAt,
      deadlineAt: startedAt + budgetMs,
    };

    const outcome = await withDeadline(() => body(parsed.value, cfg, ctx), budgetMs);

    if (outcome.kind === TIMEOUT) {
      safely(() => log(cfg, 'warn', `hook ${name} exceeded its ${budgetMs}ms budget`, {
        hook: name, budget_ms: budgetMs, elapsed_ms: Date.now() - startedAt,
      }));
      finish({ suppressOutput: true });
      return;
    }
    if (outcome.kind === 'err') {
      safely(() => log(cfg, 'error', `hook ${name} body failed`, {
        hook: name, detail: describe(outcome.value),
      }));
      finish({ suppressOutput: true });
      return;
    }
    finish(outcome.value);
  } catch (err) {
    safely(() => log(cfg, 'error', `hook ${name} failed before its body could run`, {
      hook: name, detail: describe(err),
    }));
    finish({ suppressOutput: true });
  }
}

// ---------------------------------------------------------------------------
// spawnDetached
// ---------------------------------------------------------------------------

/**
 * §4.9: fire a sibling script and forget about it.
 *
 * ```js
 * const child = spawn(process.execPath, [scriptPath, ...args, '--payload', payloadPath], {
 *   detached: true, stdio: 'ignore', env: { ...process.env, MUBIT_CC_DETACHED: '1' },
 * });
 * child.unref();
 * ```
 *
 * The payload travels through `${CLAUDE_PLUGIN_DATA}/tmp/<uuid>.json` rather than inherited
 * stdin, because a detached child's inherited stdin is not reliably readable once the parent
 * exits — and the parent exits within milliseconds, which is the entire point.
 *
 * **Resolution order matters.** `'drain'` resolves to a `drain.mjs` *sibling of the calling
 * script* first, and only then to `${CLAUDE_PLUGIN_ROOT}/hooks/{src,dist}`. A hard-coded
 * `hooks/src/drain.mjs` breaks the shipped `hooks/dist` build, breaks a plugin installed to
 * a path `CLAUDE_PLUGIN_ROOT` does not describe, and breaks any test that drops a stub next
 * to its driver.
 *
 * @param {Record<string, any>} cfg
 * @param {string} scriptName        e.g. `'drain'` (with or without `.mjs`)
 * @param {string[]} [args]
 * @param {string} [payloadPath]     absolute path to the handoff file, or '' for none
 * @returns {import('node:child_process').ChildProcess|null}
 */
export function spawnDetached(cfg, scriptName, args = [], payloadPath = '') {
  try {
    const script = resolveScript(cfg, scriptName);
    if (!script) return null;

    const argv = [script, ...toStringList(args)];
    if (payloadPath) argv.push('--payload', String(payloadPath));

    const child = spawn(process.execPath, argv, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, [DETACHED_ENV]: '1' },
    });
    // Without this the parent's event loop stays alive until the child exits, and "detached"
    // buys nothing at all.
    child.unref();
    // An `error` event on an unref'd child with no listener is an uncaught exception.
    child.on('error', () => { /* a missing interpreter costs the drain, not the hook */ });
    return child;
  } catch {
    return null;
  }
}

/**
 * The handoff file for `spawnDetached`, at `${CLAUDE_PLUGIN_DATA}/tmp/<uuid-v4>.json`.
 * Returns '' when it could not be written — the caller then spawns without one, or not at all.
 * @param {Record<string, any>} cfg
 * @param {any} payload
 * @returns {string}
 */
export function stashPayload(cfg, payload) {
  try {
    const root = (cfg && typeof cfg.dataDir === 'string' && cfg.dataDir)
      ? cfg.dataDir
      : resolveDataRoot(cfg ?? {});
    const dir = join(root, 'tmp');
    mkdirSync(dir, { recursive: true });
    // §4.9 names the handoff file `<uuid>.json`, and a test pins the v4 shape: two hooks
    // firing in the same millisecond must not collide on it.
    const path = join(dir, `${randomUUID()}.json`);
    let body;
    try { body = JSON.stringify(payload ?? {}); } catch { body = '{}'; }
    writeFileSync(path, typeof body === 'string' ? body : '{}', 'utf8');
    return path;
  } catch {
    return '';
  }
}

/**
 * Candidate paths for a detached script, most specific first.
 * @param {Record<string, any>} cfg
 * @param {string} scriptName
 * @returns {string}
 */
function resolveScript(cfg, scriptName) {
  const base = String(scriptName ?? '').trim();
  if (!base) return '';
  const file = base.endsWith('.mjs') || base.endsWith('.js') ? base : `${base}.mjs`;

  /** @type {string[]} */
  const candidates = [];

  // 1. A sibling of the script that is calling us. In `hooks/src` during development, in
  //    `hooks/dist` once bundled, and next to the driver in a test.
  const self = typeof process.argv[1] === 'string' ? process.argv[1] : '';
  if (self) {
    try { candidates.push(join(dirname(resolve(self)), file)); } catch { /* unresolvable argv[1] */ }
  }

  // 2. ${CLAUDE_PLUGIN_ROOT}/hooks/{src,dist}.
  const root = firstString(cfg?.pluginRoot, process.env.CLAUDE_PLUGIN_ROOT);
  if (root) {
    candidates.push(join(root, 'hooks', 'src', file));
    candidates.push(join(root, 'hooks', 'dist', file));
  }

  // 3. Relative to this module, for a caller with neither an argv[1] nor a plugin root.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, '..', 'hooks', 'src', file));
    candidates.push(join(here, '..', 'hooks', 'dist', file));
  } catch { /* not a file: URL — nothing to add */ }

  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* unstat-able; try the next */ }
  }
  // Nothing on disk. Return the preferred path anyway: the spawn fails harmlessly in a
  // detached child, and returning '' here would make a broken install silently *look* fine.
  return candidates[0] ?? '';
}

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

/**
 * Read stdin to EOF as UTF-8. Never rejects; a read error yields whatever arrived first.
 * @returns {Promise<string>}
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
      res(text);
    };
    // Deliberately NOT unref'd: if this timer did not hold the loop open, a wedged host
    // could let the process exit with nothing on stdout, which breaks the contract.
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);

    try {
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

// ---------------------------------------------------------------------------
// The deadline
// ---------------------------------------------------------------------------

/**
 * Run `fn` and settle with the first of {value, throw, deadline}.
 * @param {() => any} fn
 * @param {number} ms
 * @returns {Promise<{kind: 'ok'|'err'|'timeout', value: any}>}
 */
function withDeadline(fn, ms) {
  return new Promise((res) => {
    let settled = false;
    const settle = (kind, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({ kind, value });
    };
    // Also not unref'd. A body that returns a never-settling promise must still produce
    // stdout, and an unref'd timer would let the process exit silently instead.
    const timer = setTimeout(() => settle(TIMEOUT, undefined), Math.max(1, ms));

    try {
      Promise.resolve(fn()).then(
        (v) => settle('ok', v),
        (e) => settle('err', e),
      );
    } catch (e) {
      settle('err', e);
    }
  });
}

// ---------------------------------------------------------------------------
// stdout
// ---------------------------------------------------------------------------

/**
 * Stringify and write synchronously. Anything that is not a plain object becomes `{}` —
 * an array or a bare string on stdout is not a shape Claude Code defines a meaning for.
 * @param {any} value
 */
function emit(value) {
  let text = '{}';
  if (isObject(value)) {
    try {
      const s = JSON.stringify(value);
      if (typeof s === 'string' && s) text = s;
    } catch {
      text = '{}'; // circular: say nothing rather than crash on the way out
    }
  }
  writeAllSync(`${text}\n`);
}

/**
 * `write(2)` in a loop. Synchronous on purpose: `process.exit(0)` immediately follows, and
 * it discards anything still buffered in `process.stdout`.
 * @param {string} text
 */
function writeAllSync(text) {
  let buf;
  try { buf = Buffer.from(text, 'utf8'); } catch { return; }
  let off = 0;
  for (let guard = 0; off < buf.length && guard < 10000; guard++) {
    try {
      off += writeSync(1, buf, off, buf.length - off);
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (code === 'EAGAIN') { pauseBriefly(); continue; }
      if (code === 'EPIPE') return;             // the host stopped listening
      // fd 1 is doing something exotic; fall back to the stream and hope.
      try { process.stdout.write(buf.subarray(off)); } catch { /* nothing left to try */ }
      return;
    }
  }
}

/** A ~1 ms sleep with no event loop involvement, for the EAGAIN retry. */
function pauseBriefly() {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  } catch {
    const until = Date.now() + 1;
    while (Date.now() < until) { /* spin */ }
  }
}

/** The only exit in this plugin. Always zero. */
function exitZero() {
  process.exitCode = 0;
  try {
    process.exit(0);
  } catch {
    /* `process.exit` is patched or unavailable: the exitCode above still stands */
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * @param {string} raw
 * @returns {{ok: true, value: Record<string, any>}|{ok: false, value: null}}
 */
function parseObject(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { ok: false, value: null };
  try {
    const v = JSON.parse(s);
    // An array or a bare scalar is not a hook payload; treating it as one would hand every
    // downstream `payload.session_id` an exception instead of a value.
    if (!isObject(v)) return { ok: false, value: null };
    return { ok: true, value: v };
  } catch {
    return { ok: false, value: null };
  }
}

/** @param {string} p @returns {string} */
function readFileText(p) {
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

/** @param {any} v @returns {boolean} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @param {any} v @param {number} d @returns {number} */
function positiveInt(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : d;
}

/** @param {string[]} argv @param {string} flag @returns {string} */
function flagValue(argv, flag) {
  if (!Array.isArray(argv)) return '';
  const i = argv.indexOf(flag);
  if (i < 0) return '';
  const v = argv[i + 1];
  return typeof v === 'string' && v && !v.startsWith('--') ? v : '';
}

/** @param {any} v @returns {string[]} */
function toStringList(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => x !== null && x !== undefined).map((x) => String(x));
}

/** @param {...any} vals @returns {string} */
function firstString(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v;
  return '';
}

/** @param {any} err @returns {string} */
function describe(err) {
  try {
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    if (typeof err === 'string') return err;
    return JSON.stringify(err) ?? String(err);
  } catch {
    return 'unserializable error';
  }
}

/** @param {() => any} fn */
function safely(fn) {
  try { return fn(); } catch { return undefined; }
}

/** `loadConfig` is total in practice, but `log` still needs somewhere to write if it is not. */
function safeConfig() {
  try {
    return loadConfig();
  } catch {
    return {
      logLevel: process.env.MUBIT_CC_LOG_LEVEL || 'warn',
      dataDir: safely(() => resolveDataRoot({})) ?? '',
      redact: true,
    };
  }
}
