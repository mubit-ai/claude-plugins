// @ts-check
/**
 * Record what the host actually sends a hook, and what it makes of what one answers.
 *
 * This is the oracle for `codex-payload.test.mjs`, and the reason it exists is the reason
 * that file exists: **a fixture written beside an implementation cannot falsify that
 * implementation.** Whatever shape the code reads, the fixture will have — the two are
 * written by the same person in the same hour, and they agree by construction. What breaks
 * that circle is an artefact the implementation did not write, and the only one available is
 * a payload the host itself produced.
 *
 * So this drives a real session and writes down what arrived:
 *
 *   1. A throwaway `$CODEX_HOME` with a `hooks.json` registering one recorder on all eleven
 *      events. Nothing touches the real one.
 *   2. Trust granted the way `scripts/setup.mjs` grants it — `hooks/list` for each handler's
 *      key and current hash, then `[hooks.state."<key>"] trusted_hash` in `config.toml`.
 *      Untrusted hooks are skipped in silence, so an ungranted run records nothing and looks
 *      like a host that changed.
 *   3. One `codex exec` turn, prompted to make a single tool call, because a tool call is
 *      what puts `PreToolUse` and `PostToolUse` on the wire.
 *   4. Machine-specific values swapped for placeholders, so two machines record the same
 *      bytes. Ids, paths and the working directory go; every field name and every shape
 *      stays, and those are what the tests assert on.
 *
 * ---------------------------------------------------------------------------
 * What this replaces, and why
 * ---------------------------------------------------------------------------
 * The previous oracle was twenty-one JSON Schema documents lifted out of the host's compiled
 * binary. They were a stronger oracle than this one — closed schemas, both directions, every
 * event — and they were the vendor's own artefact, republished in a public tree along with
 * the recipe for lifting them out. That is not ours to publish however useful it is.
 *
 * A recording is the weaker instrument honestly obtained: it pins the fields an event was
 * *seen* to carry rather than the fields it *may* carry, so it cannot prove a field optional
 * and cannot reject one the host would. What it can still do is the thing that mattered —
 * catch a builder that invents a field the host has never sent, or drops one it always does.
 *
 * ---------------------------------------------------------------------------
 * Running it
 * ---------------------------------------------------------------------------
 *
 *     node test/helpers/codex-record.mjs --update
 *     node test/helpers/codex-record.mjs --update --probe suppressOutput
 *
 * The first re-records `test/fixtures/observed/payloads/`. The second additionally answers
 * every hook with `{"<key>": true}` and records whether the host took it, into
 * `output-acceptance.json`.
 *
 * **This costs a model turn**, which is why it is a script you run deliberately and not
 * something the suite does. It needs a logged-in `codex` on PATH.
 *
 * Node >= 20 built-ins only.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { askHost, codexVersion } from './codex-oracle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to `integrations/codex/`. */
export const CODEX_ROOT = resolve(HERE, '..', '..');

/** Where the recordings live. */
export const OBSERVED_DIR = join(CODEX_ROOT, 'test', 'fixtures', 'observed');
export const PAYLOAD_DIR = join(OBSERVED_DIR, 'payloads');
export const ACCEPTANCE_PATH = join(OBSERVED_DIR, 'output-acceptance.json');

/** The eleven events a `hooks.json` may register. */
export const ALL_EVENTS = [
  'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop',
];

/**
 * The events a recording session reaches, and therefore the ones with an oracle.
 *
 * The rest need a session shape one scripted turn does not produce: an approval the sandbox
 * actually refuses, a context window full enough to compact, or a spawned subagent. They are
 * listed as uncovered rather than assumed, so the gap is something a reader can see and close
 * instead of something the suite quietly passes over.
 */
export const RECORDED_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd',
];

/** Values that differ per machine and per run. The shape is the fixture; these are not. */
const PLACEHOLDERS = {
  session_id: '{{SESSION_ID}}',
  turn_id: '{{TURN_ID}}',
  transcript_path: '{{TRANSCRIPT_PATH}}',
  cwd: '{{CWD}}',
  tool_use_id: '{{TOOL_USE_ID}}',
};

/** One payload with its per-run values swapped out, key order preserved. */
export function normalizePayload(raw) {
  const out = {};
  for (const k of Object.keys(raw)) out[k] = k in PLACEHOLDERS ? PLACEHOLDERS[k] : raw[k];
  return out;
}

/** Read the recorded corpus. Absence is a caller's problem to report, not this file's. */
export function readObservedPayloads() {
  if (!existsSync(PAYLOAD_DIR)) return {};
  const out = {};
  for (const f of readdirSync(PAYLOAD_DIR)) {
    if (!f.endsWith('.json')) continue;
    out[f.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(PAYLOAD_DIR, f), 'utf8'));
  }
  return out;
}

/** Read the observed accept/reject table. */
export function readOutputAcceptance() {
  if (!existsSync(ACCEPTANCE_PATH)) return null;
  return JSON.parse(readFileSync(ACCEPTANCE_PATH, 'utf8'));
}

// ---------------------------------------------------------------------------
// Recording — only reached under `--update`
// ---------------------------------------------------------------------------

const RECORDER = `
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const OUT = process.env.REC_OUT;
const KEY = process.env.REC_PROBE_KEY || '';
let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch {}
let name = 'unknown';
try { name = JSON.parse(raw).hook_event_name || 'unknown'; } catch {}
try {
  mkdirSync(OUT, { recursive: true });
  let p = join(OUT, name + '.json');
  let n = 1;
  while (existsSync(p)) p = join(OUT, name + '.' + (n++) + '.json');
  writeFileSync(p, raw);
} catch {}
process.stdout.write(KEY ? JSON.stringify({ [KEY]: true }) : '{}');
process.exit(0);
`;

/** A `$CODEX_HOME` of our own, with one recorder on every event and trust already granted. */
async function seedRecorderHome(probeKey) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mubit-record-home-')));
  const recorder = join(home, 'recorder.mjs');
  writeFileSync(recorder, RECORDER);

  const hooks = {};
  for (const e of ALL_EVENTS) {
    hooks[e] = [{ hooks: [{ type: 'command', timeout: 10, command: `node ${recorder}` }] }];
  }
  // § The one matcher the real manifest carries. Without it SessionStart never fires.
  hooks.SessionStart[0].matcher = 'startup|resume|clear|compact';
  writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks }, null, 2));

  // § Auth is per-CODEX_HOME, so the throwaway home needs the real one's credential to reach
  //   a model at all. Copied rather than symlinked: a session must not be able to write back.
  const realAuth = join(process.env.HOME || '', '.codex', 'auth.json');
  if (existsSync(realAuth)) writeFileSync(join(home, 'auth.json'), readFileSync(realAuth));

  const answer = await askHost(home, { timeoutMs: 15_000 });
  const lines = ['[hooks]', 'enabled = true', ''];
  for (const h of answer.hooks) {
    lines.push(`[hooks.state."${h.key}"]`, `trusted_hash = "${h.currentHash}"`, '');
  }
  writeFileSync(join(home, 'config.toml'), lines.join('\n'));
  return { home, granted: answer.hooks.length, probeKey };
}

async function update(probeKey) {
  const v = codexVersion();
  if (!v.ok) throw new Error('no `codex` on PATH — this script records against the real host.');

  const { home, granted } = await seedRecorderHome(probeKey);
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'mubit-record-proj-')));
  const out = join(home, 'recorded');
  writeFileSync(join(project, 'note.txt'), 'hello\n');
  spawnSync('git', ['init', '-q'], { cwd: project });

  process.stderr.write(`[record] ${v.version}, ${granted} handlers trusted\n`);
  const run = spawnSync('codex', [
    'exec', '-s', 'read-only', '--skip-git-repo-check', '-C', project,
    'Use the shell tool to run: head note.txt   — then reply with just the word it printed. '
    + 'Do nothing else.',
  ], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: home, REC_OUT: out, REC_PROBE_KEY: probeKey || '' },
  });

  if (!existsSync(out)) throw new Error(`no hook fired. Host said:\n${run.stdout}\n${run.stderr}`);

  mkdirSync(PAYLOAD_DIR, { recursive: true });
  const seen = [];
  for (const f of readdirSync(out).filter((n) => n.endsWith('.json')).sort()) {
    const raw = JSON.parse(readFileSync(join(out, f), 'utf8'));
    const event = raw.hook_event_name;
    if (!event || seen.includes(event)) continue;
    seen.push(event);
    writeFileSync(join(PAYLOAD_DIR, `${event}.json`),
      `${JSON.stringify(normalizePayload(raw), null, 2)}\n`);
  }
  process.stderr.write(`[record] payloads: ${seen.sort().join(', ')}\n`);

  if (probeKey) {
    // § `hook: <Event> Completed` / `… Failed` is the host's verdict on what the hook answered.
    const verdict = {};
    for (const m of String(run.stdout).matchAll(/^hook: (\w+) (Completed|Failed)$/gm)) {
      verdict[m[1]] = m[2] === 'Failed' ? 'rejected' : 'accepted';
    }
    process.stderr.write(`[record] ${probeKey}: ${JSON.stringify(verdict)}\n`);
  }

  rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  if (!argv.includes('--update')) {
    process.stderr.write('usage: node test/helpers/codex-record.mjs --update [--probe <key>]\n');
    process.exit(2);
  }
  const i = argv.indexOf('--probe');
  await update(i === -1 ? '' : argv[i + 1] || '');
}
