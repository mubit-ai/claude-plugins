// @ts-check
/**
 * `lib/redact.mjs` — the three-stage sanitisation pipeline (
 * spec §6.4).
 *
 * This is the price of involuntary capture, and the reason it is defensible at
 * all: a hook that records every tool call without the model's participation
 * will, sooner or later, record the one that printed a `.env` file. Capturing
 * everything is only a good idea with the pipeline below in front of it.
 *
 *   Stage 1  pattern scrub   ->  each match becomes `[REDACTED:<kind>]`
 *   Stage 2  path denylist   ->  matching captures are DROPPED, not scrubbed
 *   Stage 3  byte caps       ->  params 4 KiB/field, output 8 KiB
 *
 * Order matters: **scrub before capping**, so truncation cannot slice a secret
 * in half and leave the recognizable prefix — which is enough to identify the
 * provider, the account, and often to brute-force the remainder.
 *
 * `MUBIT_CC_REDACT=0` (`cfg.redact === false`) disables stage 1 only. The
 * escape hatch exists for users whose output the entropy rule mangles; it must
 * not also disable the two stages that have no false-positive cost.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Placeholder
// ---------------------------------------------------------------------------

/**
 * §4.4 writes the placeholder uppercase; spec §6.4 writes it lowercase. The
 * build guide is the implementation contract, so uppercase wins and a test
 * explicitly rejects the lowercase form.
 * @param {string} kind
 */
const PH = (kind) => `[REDACTED:${kind}]`;

// ---------------------------------------------------------------------------
// The idempotency-key exception
// ---------------------------------------------------------------------------

/**
 * An idempotency key is not a secret and must survive the scrub.
 *
 * The plugin sets an idempotency key on EVERY ingest batch (§4.2 `postIngest`),
 * so redacting it destroys the only handle a human has on "did this batch get
 * sent twice?". Note that `idempotency_key=cc-<uuid8>-<epoch>` has a Shannon
 * entropy of ~4.32 bits/char, so without this guard the generic entropy rule
 * would swallow it even though no keyword rule would.
 */
const EXEMPT_RE = /idempotency[-_]key/i;

// ---------------------------------------------------------------------------
// Stage 1 — pattern scrub
// ---------------------------------------------------------------------------

/**
 * Kept aligned with the server's own redaction policy, so client and server
 * agree on what counts as a secret.
 */
const ASSIGNMENT_KEYWORDS = [
  'secret', 'token', 'password', 'credential', 'assertion', 'signature', 'apikey', 'api_key',
];

/**
 * `NAME<sep>VALUE`, where NAME is a whole `[A-Za-z0-9_-]` token.
 *
 * §4.4 sketches this with `\b`, but the canonical fixture is
 * `DATABASE_PASSWORD=…` — and `_` is a word character, so a literal `\b` never
 * fires before `PASSWORD`. Matching the whole name token and then testing it
 * with `includes()` mirrors the server (`lower.contains(s)`) and catches
 * `DATABASE_PASSWORD=`, `AWS_SECRET_ACCESS_KEY=` and `X_API_TOKEN=`, which is
 * the single most common shape of a leaked secret.
 *
 * The separator run is `[ \t]*` rather than `\s*` so an assignment can never
 * reach across a newline and swallow the following line.
 */
const ASSIGNMENT_RE = /(^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{1,64})([ \t]*[:=][ \t]*)(\S+)/g;

/** Maximal base64/hex-ish runs, the candidate set for the entropy rule. */
const ENTROPY_RUN_RE = /[A-Za-z0-9+/=_-]{32,}/g;

/* The detector's own parameters. leakcheck-allow: redaction-threshold — this is the client's
   implementation; the constants are two lines below, so hiding the prose would hide nothing. */
const ENTROPY_MIN_LEN = 32;
const ENTROPY_THRESHOLD = 4.0;

/**
 * The §4.4 pattern table, in application order.
 *
 * `assignment` runs FIRST so a keyword-anchored rule always wins the label over
 * the generic ones — `DATABASE_PASSWORD=<b64>` must report `assignment`, not
 * `high-entropy`. `high-entropy` runs LAST, by which point every credential
 * with a recognizable shape has already been replaced by a placeholder (which
 * contains `[`, `]` and `:`, none of them in the entropy charset, so the
 * placeholders cannot themselves become candidates).
 */
const RULES = [
  { kind: 'assignment', scrub: scrubAssignments },
  { kind: 'pem', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'mubit-key', re: /mbt_[A-Za-z0-9_-]{8,}/g },
  { kind: 'openai-key', re: /sk-[A-Za-z0-9_-]{16,}/g },
  { kind: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { kind: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g },
  { kind: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,}){2}/g },
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g },
  { kind: 'high-entropy', scrub: scrubHighEntropy },
];

/**
 * @param {string} text
 * @param {{n: number}} count
 * @returns {string}
 */
function scrubAssignments(text, count) {
  return text.replace(ASSIGNMENT_RE, (m, pre, name, _sep, _value) => {
    const lower = String(name).toLowerCase();
    if (EXEMPT_RE.test(lower)) return m;
    if (!ASSIGNMENT_KEYWORDS.some((k) => lower.includes(k))) return m;
    count.n += 1;
    return `${pre}${PH('assignment')}`;
  });
}

/**
 * @param {string} text
 * @param {{n: number}} count
 * @returns {string}
 */
function scrubHighEntropy(text, count) {
  return text.replace(ENTROPY_RUN_RE, (run) => {
    if (run.length < ENTROPY_MIN_LEN) return run;
    if (EXEMPT_RE.test(run)) return run;
    if (entropy(run) < ENTROPY_THRESHOLD) return run;
    count.n += 1;
    return PH('high-entropy');
  });
}

/**
 * @param {string} text
 * @param {{n: number}} count
 * @returns {string}
 */
function scrub(text, count) {
  let out = text;
  for (const rule of RULES) {
    if (rule.scrub) {
      out = rule.scrub(out, count);
      continue;
    }
    const re = rule.re;
    if (!re) continue;
    re.lastIndex = 0;
    out = out.replace(re, (m) => {
      if (EXEMPT_RE.test(m)) return m;
      count.n += 1;
      return PH(rule.kind);
    });
  }
  return out;
}

/**
 * Shannon entropy over the byte distribution, in bits per byte. leakcheck-allow: redaction-threshold
 *
 * Why hex can never trip the >= 4.0 threshold: entropy over a 16-symbol
 * alphabet is bounded by log2(16) = 4.0, and a 40-char git SHA cannot be
 * exactly uniform (40/16 = 2.5), so it is strictly below. That is a property of
 * the threshold, not a lucky fixture.
 *
 * @param {string} s
 * @returns {number}
 */
export function entropy(s) {
  if (s === null || s === undefined) return 0;
  const str = typeof s === 'string' ? s : String(s);
  if (str.length === 0) return 0;
  const buf = Buffer.from(str, 'utf8');
  const n = buf.length;
  if (n === 0) return 0;
  const counts = new Uint32Array(256);
  for (let i = 0; i < n; i++) counts[buf[i]] += 1;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    const c = counts[i];
    if (!c) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

// ---------------------------------------------------------------------------
// Stage 3 — byte caps
// ---------------------------------------------------------------------------

/** `\n…[truncated <N> bytes]` — U+2026, not three dots. */
const truncMarker = (n) => `\n…[truncated ${n} bytes]`;

/**
 * Cap `s` to `cap` bytes without ever slicing a UTF-8 character in half — a
 * sliced multi-byte char decodes to U+FFFD, which is both lossy and ugly in
 * recalled context.
 * @param {string} s
 * @param {number} cap
 * @returns {{text: string, truncated: boolean}}
 */
function capBytes(s, cap) {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= cap) return { text: s, truncated: false };

  // Walk back off any continuation bytes, then keep the leading character only
  // when its whole sequence fits inside the cap.
  let end = cap;
  while (end > 0 && (buf[end - 1] & 0xC0) === 0x80) end -= 1;
  if (end > 0) {
    const lead = buf[end - 1];
    let need = 1;
    if (lead >= 0xF0) need = 4;
    else if (lead >= 0xE0) need = 3;
    else if (lead >= 0xC0) need = 2;
    end = (end - 1 + need <= cap) ? end - 1 + need : end - 1;
  }

  const body = buf.subarray(0, end).toString('utf8');
  return { text: `${body}${truncMarker(buf.length - end)}`, truncated: true };
}

// ---------------------------------------------------------------------------
// redactText / redactParams
// ---------------------------------------------------------------------------

/**
 * Stage 1 then stage 3, in that order.
 *
 * @param {any} text
 * @param {Record<string, any>} [cfg]
 * @param {'param'|'output'} [kind]
 * @returns {{text: string, redactions: number, dropped: boolean, truncated: boolean}}
 */
export function redactText(text, cfg = {}, kind = 'output') {
  /** @type {{text: string, redactions: number, dropped: boolean, truncated: boolean}} */
  const out = { text: '', redactions: 0, dropped: false, truncated: false };
  if (text === null || text === undefined) return out;

  let s;
  if (typeof text === 'string') s = text;
  else {
    try { s = typeof text === 'object' ? JSON.stringify(text) ?? '' : String(text); }
    catch { s = ''; }
  }

  const count = { n: 0 };
  if (!cfg || cfg.redact !== false) {
    try { s = scrub(s, count); } catch { /* a broken scrub must not lose the caller's text */ }
  }
  out.redactions = count.n;

  const cap = kind === 'param'
    ? numberOr(cfg?.maxParamBytes, 4096)
    : numberOr(cfg?.maxOutputBytes, 8192);
  const capped = capBytes(s, cap);
  out.text = capped.text;
  out.truncated = capped.truncated;
  return out;
}

/**
 * §4.4: recursive, and caps EACH field — 4 KiB per field, not 4 KiB shared
 * across the whole `tool_input`. Structure (arrays, nesting, non-string
 * scalars) is preserved exactly; only strings are touched.
 *
 * @param {any} toolInput
 * @param {Record<string, any>} [cfg]
 * @returns {{params: any, redactions: number}}
 */
export function redactParams(toolInput, cfg = {}) {
  const count = { n: 0 };
  let params;
  try {
    params = walk(toolInput, cfg, count, 0);
  } catch {
    params = null;
  }
  return { params, redactions: count.n };
}

/**
 * @param {any} v
 * @param {Record<string, any>} cfg
 * @param {{n: number}} count
 * @param {number} depth
 */
function walk(v, cfg, count, depth) {
  if (depth > 12) return v; // pathological nesting is not worth a stack overflow
  if (typeof v === 'string') {
    const r = redactText(v, cfg, 'param');
    count.n += r.redactions;
    return r.text;
  }
  if (Array.isArray(v)) return v.map((x) => walk(x, cfg, count, depth + 1));
  if (v && typeof v === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = walk(val, cfg, count, depth + 1);
    return out;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Stage 2 — path denylist
// ---------------------------------------------------------------------------

/**
 * §4.4 / spec §6.4. Matching captures are dropped entirely, not scrubbed —
 * a scrubbed `.env` is still a map of which secrets the project holds.
 * `MUBIT_CC_CAPTURE_DENY` appends to this floor; it never replaces it.
 */
const BUILTIN_DENY = [
  '.env', '.env.*',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.kdbx',
  'id_rsa*', 'id_ed25519*',
  'secrets/**', '.ssh/**', '.aws/**', '.gnupg/**',
  '**/credentials', '**/.netrc',
];

/** @type {Map<string, RegExp>} */
const _globCache = new Map();

/**
 * A minimal glob: `**` crosses `/`, `*` does not, `?` is one non-`/` char.
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  const hit = _globCache.get(glob);
  if (hit) return hit;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') { i += 1; re += '(?:.*/)?'; }
        else re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  const built = new RegExp(`^${re}$`);
  _globCache.set(glob, built);
  return built;
}

/**
 * Every string a glob may reasonably be matched against: the whole normalised
 * path plus each `/`-delimited tail. That is what lets `.ssh/**` recognise both
 * `~/.ssh/id_rsa` and `/Users/x/.ssh/id_rsa.pub`, and `*.pem` recognise
 * `certs/server.pem` by its basename.
 * @param {string} p
 * @returns {string[]}
 */
function pathCandidates(p) {
  const norm = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = norm.split('/').filter(Boolean);
  const out = new Set([norm]);
  for (let i = 0; i < parts.length; i++) out.add(parts.slice(i).join('/'));
  return [...out];
}

/** @type {Map<string, string|null>} */
const _repoRootCache = new Map();

/** Nearest ancestor holding a `.git`, or null. @param {string} start */
function gitRootOf(start) {
  if (!start) return null;
  if (_repoRootCache.has(start)) return _repoRootCache.get(start) ?? null;
  let cur = resolve(start);
  let found = null;
  for (let i = 0; i < 24; i++) {
    if (existsSync(join(cur, '.git'))) { found = cur; break; }
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  _repoRootCache.set(start, found);
  return found;
}

/** @type {Map<string, boolean>} */
const _ignoreCache = new Map();

/**
 * "Plus everything git ignores" — the high-yield rule, because the user has
 * already declared those paths not-for-sharing and honouring that declaration
 * costs them no new configuration.
 *
 * Memoised per (repo, path): §4.4 wants one `git check-ignore` per drain batch,
 * never one per capture.
 *
 * @param {string} p
 * @param {string} projectDir
 * @returns {boolean}
 */
function isGitIgnored(p, projectDir) {
  const root = gitRootOf(projectDir);
  if (!root) return false;

  let rel = String(p).replace(/\\/g, '/');
  if (isAbsolute(rel)) {
    const abs = resolve(rel);
    for (const base of new Set([resolve(projectDir), root])) {
      if (abs === base) return false;
      if (abs.startsWith(base + sep)) { rel = abs.slice(base.length + 1); break; }
    }
    if (isAbsolute(rel)) return false; // outside the repo — git cannot speak to it
  }
  if (!rel || rel.startsWith('..')) return false;

  const key = `${root} ${rel}`;
  const hit = _ignoreCache.get(key);
  if (hit !== undefined) return hit;

  let ignored = false;
  try {
    const r = spawnSync('git', ['check-ignore', '-q', '--', rel], {
      cwd: root, stdio: ['ignore', 'ignore', 'ignore'], timeout: 2000,
    });
    ignored = r.status === 0;
  } catch {
    ignored = false;
  }
  _ignoreCache.set(key, ignored);
  return ignored;
}

/**
 * @param {string} p
 * @param {Record<string, any>} [cfg]
 * @param {string} [projectDir]
 * @returns {boolean}
 */
export function isDeniedPath(p, cfg = {}, projectDir = '') {
  try {
    if (!p || typeof p !== 'string') return false;
    const dir = projectDir || cfg?.projectDir || '';
    const candidates = pathCandidates(p);

    const globs = [...BUILTIN_DENY, ...normaliseGlobs(cfg?.denyGlobs), ...envGlobs()];
    for (const g of globs) {
      const re = globToRegExp(g);
      for (const c of candidates) if (re.test(c)) return true;
    }

    if (cfg?.respectGitignore === false) return false;
    return isGitIgnored(p, dir);
  } catch {
    return false;
  }
}

/** @param {any} v @returns {string[]} */
function normaliseGlobs(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x);
  if (typeof v === 'string' && v) return v.split(',').map((x) => x.trim()).filter(Boolean);
  return [];
}

/** `MUBIT_CC_CAPTURE_DENY` read live, for callers holding a partial cfg. */
function envGlobs() {
  return normaliseGlobs(process.env.MUBIT_CC_CAPTURE_DENY);
}

// ---------------------------------------------------------------------------
// Self-reference suppression
// ---------------------------------------------------------------------------

/**
 * Our own MCP tools arrive under the plugin-qualified prefix. A bare
 * `startsWith('mcp__')` test — or a substring test on `mubit` — silently
 * deletes every other MCP server's output from the user's memory, and nothing
 * surfaces the loss. Foreign MCP output is exactly the cross-tool memory this
 * plugin exists to keep.
 */
const OWN_MCP_PREFIX = 'mcp__plugin_mubit-memory_mubit__';

/** Keys a tool_input may carry that name a file on disk. */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'notebookPath', 'target_file'];

/**
 * Shell-shaped tools, and the `tool_input` keys each one actually carries.
 *
 * Only `Bash` holds the command. The tools that read or stop a background task identify it
 * by handle — `{task_id, block, timeout}`, or `{bash_id, filter}` on an older host — so a
 * check that reads `input.command` for them is dead code, which is what this used to be:
 * the branch named `BashOutput` and then tested a field a `BashOutput` has never had.
 *
 * A handle is opaque, so what can carry a self-reference is what the model typed: the output
 * `filter`, or the name it gave the task (`task_id` also accepts an agent's *name*). The
 * command that started the shell was already judged at its own `Bash` PostToolUse.
 *
 * Both the current and legacy names are listed because the plugin sees whichever the running
 * host sends, and it does not get to choose.
 */
const SHELL_INPUT_KEYS = {
  Bash: ['command'],
  BashOutput: ['task_id', 'bash_id', 'shell_id', 'filter'],
  TaskOutput: ['task_id', 'bash_id', 'shell_id', 'filter'],
  KillShell: ['task_id', 'shell_id'],
  KillBash: ['task_id', 'shell_id'],
  TaskStop: ['task_id', 'shell_id'],
};

/**
 * §4.4. Without this the plugin records its own traffic, recalls it, then
 * records the recall — and the store fills with
 * `curl https://eu.mubit.ai/v2/control/context`.
 *
 * @param {string|undefined} toolName
 * @param {Record<string, any>|undefined} toolInput
 * @param {Record<string, any>} [cfg]
 * @returns {boolean}
 */
export function isSelfReference(toolName, toolInput, cfg = {}) {
  try {
    const name = typeof toolName === 'string' ? toolName : '';
    const input = (toolInput && typeof toolInput === 'object') ? toolInput : {};

    // 1. Our own MCP tools — and only ours.
    if (name.startsWith(OWN_MCP_PREFIX)) return true;

    const roots = selfRoots(cfg);

    // 2. A shell-shaped tool whose input mentions our endpoint or our own state.
    const shellKeys = Object.prototype.hasOwnProperty.call(SHELL_INPUT_KEYS, name)
      ? SHELL_INPUT_KEYS[name]
      : null;
    if (shellKeys) {
      for (const key of shellKeys) {
        const v = input[key];
        if (typeof v !== 'string' || !v) continue;
        if (v.includes('/v2/control/') || v.includes('/v2/core/')) return true;
        if (v.includes('MUBIT_')) return true;
        if (/mubit/i.test(v)) return true;
        const hp = endpointHostPort(cfg);
        if (hp && v.includes(hp)) return true;
        for (const root of roots) if (v.includes(root)) return true;
      }
    }

    // 3. A subject path inside ${CLAUDE_PLUGIN_DATA} or ${CLAUDE_PLUGIN_ROOT}.
    for (const key of PATH_KEYS) {
      const v = input[key];
      if (typeof v !== 'string' || !v) continue;
      const abs = isAbsolute(v) ? resolve(v) : v;
      for (const root of roots) {
        if (abs === root || abs.startsWith(root + sep)) return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/** `${CLAUDE_PLUGIN_DATA}` and `${CLAUDE_PLUGIN_ROOT}`, resolved. */
function selfRoots(cfg) {
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v) {
      try { out.push(resolve(v)); } catch { /* unresolvable */ }
    }
  };
  push(cfg?.dataDir);
  push(cfg?.pluginRoot);
  push(process.env.MUBIT_CC_DATA_DIR);
  push(process.env.CLAUDE_PLUGIN_DATA);
  push(process.env.CLAUDE_PLUGIN_ROOT);
  return [...new Set(out)];
}

/**
 * `host:port` of the configured endpoint. `curl http://127.0.0.1:9999/health`
 * is loopback but not OUR port, and must be kept.
 */
function endpointHostPort(cfg) {
  const ep = typeof cfg?.endpoint === 'string' ? cfg.endpoint : '';
  if (!ep) return '';
  try {
    const u = new URL(ep);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @param {any} v @param {number} d */
function numberOr(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
}
