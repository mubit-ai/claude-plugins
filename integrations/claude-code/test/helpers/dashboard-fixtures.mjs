// @ts-check
/**
 * On-disk and upstream fixtures for the dashboard suites.
 *
 * Three files exercise the dashboard against the same shapes — `dashboard-server.test.mjs`
 * through HTTP, `dashboard-browser.test.mjs` through a real Chrome, and the data reader's own
 * suite — and a fixture that lives in one of them is a fixture the other two re-invent with a
 * slightly different field. Everything here writes exactly what the hooks write, in the
 * directory layout `lib/state.mjs` documents, so a row a test seeds is a row the plugin could
 * have produced.
 *
 * Node >= 20 built-ins only.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The run every fixture below is written under. */
export const RUN = 'cc-dash-00000001';
export const PROMPT = '11111111-2222-3333-4444-555555555555';
export const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** The host session mapped to `RUN`. A placeholder home, because fixtures are tracked files. */
export const PROJECT = '/home/user/proj';

/** The run `RUN` becomes after one `/clear`: same directory, a second id. */
export const RUN_C1 = `${RUN}-c1`;
export const PROMPT_C1 = '22222222-2222-3333-4444-555555555555';

/** `status/<run>.json`, as `lib/markers.mjs` writes it. */
export function writeMarker(dataDir, runId, patch = {}) {
  mkdirSync(join(dataDir, 'status'), { recursive: true });
  writeFileSync(join(dataDir, 'status', `${runId}.json`), JSON.stringify({
    run_id: runId, mode: 'hosted', state: 'ready', updated_at: Date.now(), ...patch,
  }));
}

/** `runs/<run>/turns/<prompt_id>.json`, as `stage-prompt` and `capture --stop` leave it. */
export function writeTurn(dataDir, runId, turn) {
  const dir = join(dataDir, 'runs', runId, 'turns');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${turn.prompt_id}.json`), JSON.stringify(turn));
}

/** `sessions/<host_session_id>.json`, as `lib/runid.mjs` records a host session. */
export function writeSession(dataDir, sid, patch = {}) {
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  writeFileSync(join(dataDir, 'sessions', `${sid}.json`), JSON.stringify({
    run_id: RUN, agent_id: 'claude-code', strategy: 'per-directory',
    project_dir: PROJECT, project_root: PROJECT,
    created_at: 1_700_000_000_000, last_seen_at: 1_700_000_000_000,
    mode: 'hosted', clear_count: 0, endpoint_hash: 'abc', ...patch,
  }));
}

/** One subagent record under `runId`, in the shape `subagent-start.mjs` writes it. */
export function writeSubagent(dataDir, runId, subId, patch = {}) {
  const dir = join(dataDir, 'runs', runId, 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}-sub-${subId}.json`), JSON.stringify({
    sub_run_id: `${runId}-sub-${subId}`, parent_run_id: runId, agent_id: subId,
    mubit_agent_id: `claude-code-sub-${subId}`, agent_type: 'Explore', session_id: SESSION,
    prompt_id: PROMPT, at: 1_700_000_005_000,
    recall: { rung: 1, sources: 1, tokens: 504, chars: 2013, dropped: 0, pointers: 0, empty_reason: '', ms: 384 },
    recalled: ['ref_lesson_1'], linked: false, ...patch,
  }));
}

/**
 * `runs/<run>/ledger.jsonl` — one JSON object per line, as `lib/ledger.mjs` appends them.
 * Rows are written verbatim: a test that wants a torn line writes the string itself.
 *
 * @param {string} dataDir @param {string} runId @param {Array<Record<string, any>|string>} rows
 */
export function writeLedger(dataDir, runId, rows) {
  const dir = join(dataDir, 'runs', runId);
  mkdirSync(dir, { recursive: true });
  const text = rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');
  writeFileSync(join(dir, 'ledger.jsonl'), text ? `${text}\n` : '');
}

/**
 * One run, seeded the way every cross-cutting sweep wants it: a marker, a session record, one
 * turn that injected a memory, one subagent under it, and a post-`/clear` sibling whose marker
 * is old so `RUN` stays the newest run.
 */
export function seedRun(dataDir, over = {}) {
  writeMarker(dataDir, RUN);
  writeSession(dataDir, SESSION);
  writeTurn(dataDir, RUN, {
    prompt: 'rebuild the bundle',
    prompt_id: PROMPT,
    session_id: SESSION,
    started_at: 1_700_000_000_000,
    recalled: ['ref_lesson_1'],
    recall: { tokens: 120, chars: 480, sources: 3, pointers: 1, rung: 1 },
    ...over,
  });
  writeSubagent(dataDir, RUN, 'abc');
  writeMarker(dataDir, RUN_C1, { updated_at: 1_700_000_000_000 });
  writeTurn(dataDir, RUN_C1, {
    prompt: 'and again after the clear',
    prompt_id: PROMPT_C1,
    session_id: SESSION,
    started_at: 1_700_000_100_000,
    recalled: [],
  });
}

/**
 * One `ActivityEntry` carrying the metadata a lesson actually has.
 *
 * `projection: 'full'` is what keeps `metadata_json` intact. Under the compact projection the
 * server overwrites it with `{entry_type, created_at}`, and every field the lessons route
 * would have returned — scope included — is gone. That is the whole reason the census asks for
 * `full`, and a fixture that fakes a compact row cannot catch it going wrong.
 *
 * @param {Record<string, any>} [meta] merged into `metadata_json`
 * @param {Record<string, any>} [over] merged onto the entry itself
 */
export function lessonActivity(meta = {}, over = {}) {
  return {
    id: 'a3c1f0de-0000-4000-8000-000000000001',
    run_id: 'cc-other-00000001',
    entry_type: 'lesson',
    content: 'Run the migration first.',
    source: 'reflection',
    created_at: '2026-08-19T15:03:18Z',
    reference_id: 'ref_lesson_1',
    referenceable: true,
    ...over,
    metadata_json: JSON.stringify({
      entry_type: 'lesson',
      lesson_type: 'rule',
      scope: 'global',
      importance: 'high',
      source_run_id: 'cc-other-00000001',
      ...meta,
    }),
  };
}

/** A page of the activity route, in the shape `fetchActivity` reads. */
export function activityPage(entries, next = '', total = entries.length) {
  return { json: { entries, next_page_token: next, total_visible: total } };
}

/**
 * The upstream routes that make the Lessons page render `entries`: one page of the census,
 * and a dereference that answers for any id among them. Spread into `fakeMubit(routes)`.
 *
 * @param {Array<Record<string, any>>} entries activity entries, typically from `lessonActivity`
 */
export function lessonsRoute(entries) {
  const byId = new Map();
  for (const e of entries) for (const k of [e.id, e.reference_id]) if (k) byId.set(String(k), e);
  return {
    'POST /v2/control/activity': activityPage(entries),
    'POST /v2/control/dereference': (rec) => {
      const id = String((rec.body && rec.body.reference_id) || '');
      const hit = byId.get(id);
      return hit
        ? { json: { found: true, evidence: hit } }
        : { json: { found: false } };
    },
  };
}
