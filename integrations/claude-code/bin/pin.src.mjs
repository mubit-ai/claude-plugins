// @ts-check
/**
 * `bin/pin.src.mjs` — what `/mubit-memory:pin` runs. Bundled to `bin/pin.mjs`.
 *
 * ---------------------------------------------------------------------------
 * Why a script rather than an MCP tool
 * ---------------------------------------------------------------------------
 * Not a preference. The vendored server at `mcp/dist/server.js` registers twenty-one tools
 * and **none of them touches variables**, and that bundle cannot be rebuilt in this checkout.
 * So an allowlist entry was never available, and the surface is the one `auth` and `dashboard`
 * already use: a skill with a `Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/pin.mjs:*)` grant, and a
 * small binary that talks to the control plane itself.
 *
 * ---------------------------------------------------------------------------
 * A failed write leaves nothing behind
 * ---------------------------------------------------------------------------
 * The local cache is written **only after** `variables/set` has succeeded. The tempting
 * shortcut — write locally first so the pin renders immediately, let the next drain reconcile
 * — is wrong in a way the user cannot see: a pin that exists only on this machine is one they
 * believe is shared and is not. They would set it in one terminal, watch it render, and never
 * learn the other terminal never had it. Offline pinning needs a spool; that is a v2.
 *
 * ---------------------------------------------------------------------------
 * The caps are enforced here as well as at render time
 * ---------------------------------------------------------------------------
 * `lib/pins.mjs` refuses to render past five pins, 200 characters and 240 tokens, because
 * another client can write anything at all under the `cc.pin.` prefix. That path has nobody
 * to tell. This one does, and telling them is most of the value: "that is the sixth pin" is a
 * decision the user can make, and a sixth pin that silently never renders is not.
 *
 * Over-long pins are refused rather than truncated. Truncating changes somebody's words
 * behind their back, and the words are the whole content of a constraint.
 *
 * ---------------------------------------------------------------------------
 * `pickRun` observes the run; it does not re-derive it
 * ---------------------------------------------------------------------------
 * `lib/runid.mjs` owns a subtle derivation — strategies, the `SessionStart.source` table, a
 * session map, a `-c<n>` clear counter — and it needs a hook payload, which a command typed
 * by a person does not have. A second copy of those rules living in a binary would be a copy
 * that drifts, and a copy that drifts by one character writes pins to a run nothing reads,
 * which looks exactly like a pin that did not work.
 *
 * So this reads the newest `status/<run_id>.json` marker instead: the run whose hooks ran most
 * recently, which in the session that just invoked the skill is the run the skill is in. The
 * ambiguity — two sessions in two projects on one machine — is real and is why `--run` exists,
 * and it is a far smaller ambiguity than a drifted derivation.
 *
 * Deliberately not extracted into `lib/runid.mjs`: another ticket in this wave needs the same
 * thing, and two branches editing one subtle function is a guaranteed conflict. Duplicate
 * small, extract afterwards.
 *
 * Nothing here logs the API key, and no returned object contains it.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../lib/config.mjs';
import { MAX_PIN_CHARS, MAX_PINS, writePinsLocal } from '../lib/pins.mjs';
import { scanRunMarkers } from '../lib/runid.mjs';
import { deleteVariable, listVariables, PIN_NAMESPACE, setVariable } from '../lib/variables.mjs';

/** The run id that must never be written to, from any surface. */
const POISONED_RUN_ID = 'default';

/** How far back a marker may have been touched and still name "the run I am in". */
const MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

/**
 * Parse argv into an intent. Kept separate from `main` so it is testable without running
 * anything — the shape `bin/auth.src.mjs` uses.
 *
 * `list` is the default action rather than `add`, because it is the one that changes nothing.
 * A bare `pin` from a model that guessed at the interface should report, not write.
 *
 * @param {string[]} argv
 * @returns {{action: string, text: string, slug: string, runId: string, all: boolean, json: boolean}}
 */
export function parseArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.map((a) => String(a ?? '')) : [];
  const flag = (f) => args.includes(f);
  const valueOf = (f) => {
    const i = args.indexOf(f);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : '';
  };

  // Only *known* flags are consumed. Anything else that happens to start with `--` is a pin:
  // `pin add "--force is banned while we finish this"` arrives as one argv element, and a
  // blanket `startsWith('--')` filter would silently swallow the user's first word.
  const takesValue = new Set(['--name', '--run']);
  const known = new Set([...takesValue, '--all', '--json']);
  /** @type {string[]} */
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (takesValue.has(a)) { i++; continue; }
    if (known.has(a)) continue;
    positional.push(a);
  }

  const first = (positional[0] ?? '').toLowerCase();
  const verbs = new Set(['add', 'set', 'list', 'ls', 'clear', 'rm', 'remove']);
  const action = verbs.has(first)
    ? ({ set: 'add', ls: 'list', rm: 'clear', remove: 'clear' }[first] ?? first)
    : (positional.length ? 'add' : 'list');
  // `pin "text"` with no verb is an add; `pin add "text"` drops the verb from the text.
  const rest = verbs.has(first) ? positional.slice(1) : positional;

  return {
    action,
    text: rest.join(' ').trim(),
    slug: valueOf('--name').trim(),
    runId: valueOf('--run').trim(),
    all: flag('--all'),
    json: flag('--json'),
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

  let cfg;
  try {
    cfg = deps.cfg ?? loadConfig(env);
  } catch (err) {
    return emit({ ok: false, state: 'config_error', detail: `Could not read the plugin configuration: ${messageOf(err)}` });
  }

  if (!str(cfg.endpoint)) {
    // Ahead of everything else: a connect error against an empty endpoint is a worse
    // description of "you have not signed in yet" than the sentence.
    return emit({
      ok: false,
      state: 'unconfigured',
      detail: 'No Mubit endpoint is configured, so there is nowhere to pin to. '
        + 'Run /mubit-memory:auth.',
    });
  }

  const run = pickRun(cfg, args.runId);
  if (!run.ok) return emit({ ok: false, state: run.state, detail: run.detail });
  const runId = run.runId;

  if (args.action === 'list') return emit(await doList(cfg, runId, args));
  if (args.action === 'clear') return emit(await doClear(cfg, runId, args));
  return emit(await doAdd(cfg, runId, args));
}

// ---------------------------------------------------------------------------
// The three actions
// ---------------------------------------------------------------------------

/**
 * List what the instance holds for this run, and refresh the local cache with it.
 *
 * The refresh is the point of running `list` at all beyond curiosity: it is the one command
 * that reconciles a cache the drainer has not got to yet.
 *
 * @param {Record<string, any>} cfg @param {string} runId @param {Record<string, any>} args
 */
async function doList(cfg, runId, args) {
  const res = await listVariables(cfg, runId);
  if (!res.ok) return failed('list', runId, res);

  const pins = toPins(res.variables);
  writePinsLocal(cfg, runId, pins);

  return {
    ok: true,
    state: 'listed',
    run_id: runId,
    pins: pins.map(publicPin),
    detail: pins.length
      ? [`${pins.length} pinned for ${runId}:`, ...pins.map((p) => `  ${p.slug}  ${p.text}`)].join('\n')
      : `No pins set for ${runId}.`,
  };
}

/**
 * Pin one line.
 *
 * The `list` up front is not decoration: the caps need a denominator, and replacing an
 * existing slug rather than appending needs to know what is already there. Between that read
 * and the `set` another terminal could add a pin, which would put the run one over the cap —
 * accepted, because the render path caps again and the alternative is a lock.
 *
 * @param {Record<string, any>} cfg @param {string} runId @param {Record<string, any>} args
 */
async function doAdd(cfg, runId, args) {
  const text = oneLine(args.text);
  if (!text) {
    return { ok: false, state: 'empty', run_id: runId, pins: [], detail: 'Nothing to pin. Give the constraint as the argument: pin "don\'t touch the vendored server".' };
  }
  if (text.length > MAX_PIN_CHARS) {
    // Refused rather than truncated. See the header.
    return {
      ok: false,
      state: 'too_long',
      run_id: runId,
      pins: [],
      detail: `That pin is ${text.length} characters; the limit is ${MAX_PIN_CHARS}. A pin is `
        + 'injected in full on every prompt of this run, so it has to be one line. Shorten it, '
        + 'or save the long version as a lesson with /mubit-memory:remember.',
    };
  }

  const current = await listVariables(cfg, runId);
  if (!current.ok) return failed('read the current pins for', runId, current);

  const existing = toPins(current.variables);
  // An explicit `--name` is a name and is kept as given; a slug derived from the pin's own
  // words goes through the prose rules.
  const slug = args.slug ? safeSlug(args.slug) : slugify(text);
  if (!slug) {
    return { ok: false, state: 'bad_name', run_id: runId, pins: [], detail: 'That pin has no letters or digits to name it by. Pass one with --name.' };
  }

  const replacing = existing.some((p) => p.slug === slug);
  if (!replacing && existing.length >= MAX_PINS) {
    return {
      ok: false,
      state: 'too_many',
      run_id: runId,
      pins: existing.map(publicPin),
      detail: `${runId} already has ${existing.length} pins, and ${MAX_PINS} is the limit. `
        + 'Every one of them is injected in full on every prompt, which is why there is a '
        + `limit at all. Clear one first: pin clear ${existing[0].slug}`,
    };
  }

  const res = await setVariable(cfg, runId, `${PIN_NAMESPACE}${slug}`, text);
  if (!res.ok) return failed('pin that to', runId, res);

  // Only now. See the header: a local cache written before the instance confirmed would be a
  // pin the user believes is shared and is not.
  const next = existing.filter((p) => p.slug !== slug).concat([{ slug, text, at: Date.now() }]);
  writePinsLocal(cfg, runId, next);

  return {
    ok: true,
    state: replacing ? 'replaced' : 'pinned',
    run_id: runId,
    pins: next.map(publicPin),
    detail: `${replacing ? 'Replaced' : 'Pinned'} for ${runId} (${next.length}/${MAX_PINS}): ${text}\n`
      + `  Clear it with: pin clear ${slug}`,
  };
}

/**
 * Remove one pin, or all of them.
 *
 * `--all` deletes only the `cc.pin.` namespace. Another client is entitled to keep state in
 * the same run, and a memory plugin clearing somebody else's orchestration variables because
 * a user typed "clear" would be indefensible.
 *
 * @param {Record<string, any>} cfg @param {string} runId @param {Record<string, any>} args
 */
async function doClear(cfg, runId, args) {
  const current = await listVariables(cfg, runId);
  if (!current.ok) return failed('read the current pins for', runId, current);
  const existing = toPins(current.variables);

  const targets = args.all
    ? existing
    : existing.filter((p) => p.slug === safeSlug(args.text || args.slug));

  if (!targets.length) {
    const named = safeSlug(args.text || args.slug);
    return {
      ok: false,
      state: 'not_pinned',
      run_id: runId,
      pins: existing.map(publicPin),
      detail: named
        ? `Nothing pinned as "${named}" in ${runId}.`
          + (existing.length ? ` Pinned now: ${existing.map((p) => p.slug).join(', ')}.` : '')
        : `Nothing pinned in ${runId}. Name a pin to clear, or pass --all.`,
    };
  }

  /** @type {string[]} */
  const failures = [];
  for (const pin of targets) {
    const res = await deleteVariable(cfg, runId, `${PIN_NAMESPACE}${pin.slug}`);
    if (!res.ok) failures.push(`${pin.slug}: ${res.error}`);
  }
  if (failures.length) {
    return {
      ok: false, state: 'upstream_failed', run_id: runId, pins: existing.map(publicPin),
      detail: `Could not clear ${failures.length} pin(s) from ${runId}:\n  ${failures.join('\n  ')}`,
    };
  }

  const cleared = new Set(targets.map((p) => p.slug));
  const next = existing.filter((p) => !cleared.has(p.slug));
  writePinsLocal(cfg, runId, next);

  return {
    ok: true,
    state: 'cleared',
    run_id: runId,
    pins: next.map(publicPin),
    detail: `Cleared ${targets.length} pin(s) from ${runId}. ${next.length} left.`,
  };
}

// ---------------------------------------------------------------------------
// pickRun — ~20 lines, and deliberately local
// ---------------------------------------------------------------------------

/**
 * Which run this command is pinning to. See the header for why it observes rather than
 * derives.
 *
 * @param {Record<string, any>} cfg
 * @param {string} explicit  `--run`
 * @returns {{ok: true, runId: string}|{ok: false, state: string, detail: string}}
 */
export function pickRun(cfg, explicit = '') {
  const named = str(explicit) || (str(cfg?.runStrategy) === 'static' ? str(cfg?.runId) : '');
  if (named) {
    if (named === POISONED_RUN_ID) {
      return { ok: false, state: 'poisoned_run', detail: `"${POISONED_RUN_ID}" is the shared run every unconfigured client falls into — a pin written there would render in a stranger's session. Name a real run.` };
    }
    return { ok: true, runId: named };
  }

  const newest = newestMarker(cfg);
  if (newest) return { ok: true, runId: newest };

  return {
    ok: false,
    state: 'no_run',
    detail: 'Could not tell which Mubit run this session is using — no hook has written a run '
      + 'marker yet. Send one prompt first, or name the run: pin --run <run_id> "…". '
      + '/mubit-memory:doctor prints the current run id.',
  };
}

/**
 * The most recently updated `status/<run_id>.json`.
 *
 * `health.json` shares the directory and is not a run. A marker older than a day is not this
 * session either — answering with one would silently pin to a project the user left last week,
 * and "no run found, pass --run" is a far better failure than a pin nobody sees.
 *
 * @param {Record<string, any>} cfg
 * @returns {string}
 */
function newestMarker(cfg) {
  let best = '';
  let bestAt = 0;
  for (const m of scanRunMarkers(str(cfg?.dataDir))) {
    // The shared run every unconfigured client falls into is never this session's.
    if (m.runId === POISONED_RUN_ID) continue;
    if (m.at > bestAt) { bestAt = m.at; best = m.runId; }
  }
  return bestAt > 0 && Date.now() - bestAt < MARKER_MAX_AGE_MS ? best : '';
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/** @param {Array<{slug: string, value: any}>} variables */
function toPins(variables) {
  return (Array.isArray(variables) ? variables : [])
    // `safeSlug`, not `slugify`: these arrived as slugs already. Re-deriving one through the
    // prose rules would rewrite a name somebody chose — and would drop a short one entirely,
    // leaving a pin on the instance that `pin clear` could no longer address.
    .map((v) => ({ slug: safeSlug(v.slug), text: oneLine(v.value), at: Date.now() }))
    .filter((p) => p.slug && p.text);
}

/**
 * An existing slug, made safe to print and to send. The same shape `lib/pins.mjs` applies to
 * the cache, so a name survives a round trip through both unchanged.
 * @param {any} v @returns {string}
 */
export function safeSlug(v) {
  return String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
}

/** What a caller — a skill reading `--json` — is allowed to see. Never the config. */
function publicPin(p) {
  return { slug: p.slug, text: p.text };
}

/**
 * `cc.pin.<slug>`, derived from the pin's own words when the user did not name one.
 *
 * Human-typeable on purpose: the slug is what `pin clear` takes, and a hash suffix would make
 * every clear a copy-paste from a listing. Two pins whose first words agree therefore collide,
 * and a collision is a *replace* — which is the behaviour a user re-wording a constraint wants,
 * and is why `--name` exists for the case where it is not.
 *
 * @param {any} v @returns {string}
 */
export function slugify(v) {
  return String(v ?? '')
    .toLowerCase()
    // Apostrophes close up rather than splitting, or "don't touch …" slugs as `don-t-touch`
    // and the orphaned `t` eats one of the four words that were meant to identify the pin.
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter((w) => w.length > 1)
    .slice(0, 4)
    .join('-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
}

/**
 * One pin, one line — the same flattening `lib/pins.mjs` applies at render time.
 *
 * A newline in a pin would end the markdown bullet it renders as and let the rest open a
 * heading of its own, forging a section of the injected block.
 *
 * @param {any} v @returns {string}
 */
function oneLine(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** @param {string} what @param {string} runId @param {Record<string, any>} res */
function failed(what, runId, res) {
  return {
    ok: false,
    state: str(res?.state) || 'upstream_failed',
    run_id: runId,
    pins: [],
    // `res.error` has already been scrubbed of the API key by `lib/variables.mjs`.
    detail: `Could not ${what} ${runId}: ${str(res?.error) || 'the instance did not answer'}`,
  };
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

// Guarded exactly as `bin/auth.src.mjs` is: the tests import this module and drive `main()`
// with an injected logger, so it must not run itself on import.
const selfPath = fileURLToPath(import.meta.url);
const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';

if (entryPath === selfPath) {
  // A command a person typed is allowed to fail loudly — but a stack trace is never the right
  // output, so the exit code carries the verdict and the message stays a sentence.
  process.exitCode = await main().catch((err) => {
    console.log(`pin could not run: ${err?.message ?? err}`);
    return 1;
  });
}
