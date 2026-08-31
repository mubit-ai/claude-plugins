#!/usr/bin/env node
// @ts-check
/**
 * `labs/fake-mubit.mjs` — a Mubit instance you can watch.
 *
 * The plugin only ever speaks eleven routes (see `lib/http.mjs` ROUTES). This stands all of
 * them up on 127.0.0.1, answers them the way a healthy instance would, and prints every
 * request in a shape that makes the workflow legible: which rung recall took, what the
 * capture pipeline actually put on the wire, which memories an outcome reinforced.
 *
 * Zero dependencies, like everything else here.
 *
 *   node labs/fake-mubit.mjs                       # healthy
 *   node labs/fake-mubit.mjs --scenario deny-direct   # 403 on rung 1 → recall descends
 *   node labs/fake-mubit.mjs --scenario reject-ingest # 422 → the drain quarantines the batch
 *   node labs/fake-mubit.mjs --scenario fail-ingest   # 503 → the batch stays spooled
 *   node labs/fake-mubit.mjs --scenario slow          # 2.5 s on everything → budgets bite
 *   node labs/fake-mubit.mjs --scenario truncate      # activity pages at 2 → "counts are a floor"
 *
 * Every request is also appended verbatim to `labs/.work/requests.ndjson`.
 */

import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAB_ROOT = dirname(fileURLToPath(import.meta.url));
const WORK = join(LAB_ROOT, '.work');
const LOG = join(WORK, 'requests.ndjson');

const SCENARIOS = new Set(['ok', 'deny-direct', 'reject-ingest', 'fail-ingest', 'slow', 'truncate']);

const argv = process.argv.slice(2);
const scenario = pick('--scenario') || process.env.LAB_SCENARIO || 'ok';
const port = Number(pick('--port') || process.env.LAB_PORT || 8787);

if (!SCENARIOS.has(scenario)) {
  process.stderr.write(`unknown scenario ${JSON.stringify(scenario)}; try: ${[...SCENARIOS].join(', ')}\n`);
  process.exit(1);
}

/** Batches already accepted, keyed by idempotency_key — this is what makes a retry a no-op. */
const seenBatches = new Map();
/**
 * Which run counts as "yours" when the feed serves a run-scoped lesson.
 *
 * The activity feed is asked for the whole account and filtered by the client, so its request
 * carries no run id at all — but the lab still has to serve "a lesson your run wrote" in a
 * checkout whose run id it cannot know ahead of time (the id is derived from the project
 * path, so it differs per worktree). `env.sh` exports `LAB_RUN_ID` for exactly this. Failing
 * that, take the last run id any request named: every other route carries one.
 */
let lastRunId = process.env.LAB_RUN_ID || 'cc-demo-app-00000000';
const runIdPinned = !!process.env.LAB_RUN_ID;
let n = 0;
let jobSeq = 0;

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const key = `${req.method} ${url.pathname}`;
    const body = parse(raw);
    n += 1;

    const reply = route(key, body, url);
    const send = () => {
      const status = reply.status ?? 200;
      if (typeof reply.text === 'string') {
        res.writeHead(status, { 'content-type': 'text/plain' });
        res.end(reply.text);
      } else {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.json ?? {}));
      }
      record(n, key, body, status, reply, req.headers);
    };
    if (scenario === 'slow') setTimeout(send, 2500).unref?.();
    else send();
  });
});

server.listen(port, '127.0.0.1', () => {
  mkdirSync(WORK, { recursive: true });
  line('');
  line(`  fake mubit   http://127.0.0.1:${port}`);
  line(`  scenario     ${scenario}${scenario === 'ok' ? '' : '   ← not the happy path, on purpose'}`);
  line(`  request log  ${LOG}`);
  line('');
  line('  waiting for hooks. Ctrl-C to stop.');
  line('');
});

// ---------------------------------------------------------------------------
// The route table — every route lib/http.mjs knows how to call
// ---------------------------------------------------------------------------

/**
 * @param {string} key `"<METHOD> <pathname>"`
 * @param {any} body
 * @param {URL} url
 */
function route(key, body, url) {
  if (!runIdPinned && body && typeof body.run_id === 'string' && body.run_id !== '') lastRunId = body.run_id;

  if (key === 'GET /v2/core/health') {
    // Deliberately NOT JSON. The real handler returns the bare string "OK", which is why
    // lib/http.mjs reads this one route as text.
    return { text: 'OK' };
  }

  if (key === 'POST /v2/control/agents/register' || key === 'POST /v2/control/agents/heartbeat') {
    return { json: { success: true } };
  }

  if (key === 'POST /v2/control/lessons') {
    return {
      json: {
        lessons: [
          {
            lesson_id: 'les_g1',
            content: 'An ingest job answers "queued" when accepted, not when stored — poll the job id.',
            lesson_type: 'rule', scope: 'global', importance: 'high',
          },
          {
            lesson_id: 'les_g2',
            content: 'Run the migration before starting the demo server.',
            lesson_type: 'lesson', scope: 'global', importance: 'medium',
          },
        ],
      },
    };
  }

  if (key === 'POST /v2/control/activity') {
    return activityResponse(body);
  }

  if (key === 'POST /v2/control/query') {
    // Rung 1 is `direct_bypass` (0 LLM calls). An instance whose operator disabled the
    // direct lane answers 403 — a policy verdict, not a fault.
    if (scenario === 'deny-direct' && body?.mode === 'direct_bypass') {
      return { status: 403, json: { error: 'permission_denied', detail: 'direct_bypass disabled by policy' } };
    }
    return { json: queryResponse(body?.mode) };
  }

  if (key === 'POST /v2/control/context') {
    return {
      json: {
        context_block: '## Active rules\n- Poll the ingest job; "queued" is not "stored".\n',
        token_estimate: 21,
        sources: ['ref_rule_1'],
        section_summaries: [{ section: 'active_rules', count: 1 }],
        evidence_dropped_by_budget: 0,
        empty_reason: '',
      },
    };
  }

  if (key === 'POST /v2/control/ingest') {
    if (scenario === 'reject-ingest') {
      return { status: 422, json: { error: 'unprocessable', detail: 'items[0].intent is not a known intent' } };
    }
    if (scenario === 'fail-ingest') {
      return { status: 503, json: { error: 'unavailable', detail: 'indexer is restarting' } };
    }
    const idem = String(body?.idempotency_key ?? '');
    if (idem && seenBatches.has(idem)) {
      return { json: { accepted: true, job_id: seenBatches.get(idem), status: 'queued', deduplicated: true } };
    }
    const jobId = `job_lab_${++jobSeq}`;
    if (idem) seenBatches.set(idem, jobId);
    return { json: { accepted: true, job_id: jobId, status: 'queued', deduplicated: false } };
  }

  if (key.startsWith('GET /v2/control/ingest/jobs/')) {
    return {
      json: {
        job_id: key.split('/').pop(), run_id: url.searchParams.get('run_id'),
        status: 'completed', done: true, error: '',
      },
    };
  }

  if (key === 'POST /v2/control/outcome') {
    return { json: { success: true, reinforcement_count: (body?.entry_ids ?? []).length, updated_confidence: 0.71 } };
  }

  if (key === 'POST /v2/control/checkpoint') {
    return { json: { success: true, checkpoint_id: 'ckpt_lab_1', token_estimate: 3400 } };
  }

  if (key === 'POST /v2/control/reflect') {
    return {
      json: {
        lessons: [{
          lesson_id: 'les_lab_1', scope: 'run', lesson_type: 'failure', importance: 'high',
          content: 'cargo check fails until the tonic dependency is declared in Cargo.toml.',
        }],
        lessons_stored: 1, summary: 'one lesson from this run', confidence: 0.7, degraded: false,
      },
    };
  }

  // Anything else is a bug worth seeing rather than a 200 worth ignoring.
  return { status: 404, json: { error: 'no route', route: key } };
}

/** A realistic AgentQueryResponse. `reference_id` — not `id` — is what an outcome attributes to. */
/**
 * The activity feed, which is where a lesson's scope actually lives.
 *
 * Two things about this route are the whole reason the lab has it. First, `scope` is not a
 * column: it sits inside `metadata_json`, so a caller that asks for the compact projection
 * gets rows it cannot judge — this handler drops the field for anything but `projection:
 * "full"`, the same way the instance does. Second, the feed collects and sorts BEFORE it
 * pages, so a small `limit` costs you the oldest rows and never the newest. The lessons
 * route pages first, which is why a scoped read with a small limit there can answer zero on
 * an account that holds plenty.
 *
 * `--scenario truncate` caps the page at two rows and pads the corpus past what a census will
 * page through, so the "every count is a floor" path is reachable. Both halves are needed: a
 * client that pages until the feed is exhausted is not truncated no matter how small the
 * pages are, which is worth seeing for itself.
 *
 * @param {any} body
 */
function activityResponse(body) {
  const corpus = lessonCorpus();
  const wanted = Array.isArray(body?.entry_types) ? body.entry_types.map(String) : [];
  const full = String(body?.projection ?? '') === 'full';
  const asc = String(body?.sort ?? 'desc') === 'asc';

  let rows = wanted.length ? corpus.filter((r) => wanted.includes(r.entry_type)) : corpus.slice();
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  if (asc) rows.reverse();

  const total = rows.length;
  const cap = scenario === 'truncate' ? 2 : Math.max(1, Number(body?.limit) || 50);
  const from = Number(body?.page_token) || 0;
  const page = rows.slice(from, from + cap);
  const nextFrom = from + page.length;

  return {
    json: {
      entries: page.map((r) => (full ? r : omitMetadata(r))),
      // Non-empty means "there is more". A client that reports a count off a page holding
      // this token is reporting a floor, and the honest ones say so.
      next_page_token: nextFrom < total ? String(nextFrom) : '',
      total_visible: total,
    },
  };
}

/** A row without its `metadata_json`, which is a row whose scope cannot be known. */
function omitMetadata(row) {
  const { metadata_json, ...rest } = row;
  return rest;
}

/**
 * Five lessons that between them cover every case a scope-aware read has to get right.
 *
 * `lastRunId` stands in for "the run asking", so the two rows below that belong to the caller
 * are the caller's in whatever checkout this is — the run id is derived from the project path
 * and differs per worktree.
 */
function lessonCorpus() {
  const base = realLessons();
  if (scenario !== 'truncate') return base;
  // Enough rows that a census giving up is the honest outcome rather than a page-size artefact.
  const filler = Array.from({ length: 40 }, (_, i) => ({
    id: `les_pad${String(i).padStart(2, '0')}`,
    created_at: `2025-12-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    entry_type: 'lesson',
    run_id: 'cc-other-project-11111111',
    content: `Filler lesson ${i}, so the feed outlasts a census.`,
    source: 'reflection:cc-other-project-11111111',
    metadata_json: JSON.stringify({
      source_run_id: 'cc-other-project-11111111', scope: 'run', lesson_type: 'lesson', importance: 'low',
    }),
  }));
  return base.concat(filler);
}

/** The five rows that carry the lesson; `lessonCorpus` decides whether they come padded. */
function realLessons() {
  const mine = lastRunId;
  const other = 'cc-other-project-11111111';
  const row = (id, at, runId, content, meta) => ({
    id,
    created_at: at,
    entry_type: 'lesson',
    run_id: runId,
    content,
    source: `reflection:${runId}`,
    metadata_json: JSON.stringify({ source_run_id: runId, ...meta }),
  });

  return [
    // Another run wrote this one and never widened it. It is the row that must NOT appear in
    // a default `mubit_lessons` read: run scope is the boundary, and this is the far side.
    row('les_r2', '2026-01-05T00:00:00Z', other,
      'The staging cluster needs the VPN before the smoke test will connect.',
      { scope: 'run', lesson_type: 'lesson', importance: 'low' }),
    // The caller's own run-scoped lesson. Present in a default read, because it is theirs.
    row('les_r1', '2026-01-04T00:00:00Z', mine,
      'The demo app listens on 3000, not 8080.',
      { scope: 'run', lesson_type: 'lesson', importance: 'low' }),
    row('les_s1', '2026-01-03T00:00:00Z', mine,
      'Reflect after a long debugging arc, not after every turn.',
      { scope: 'session', lesson_type: 'lesson', importance: 'medium' }),
    row('les_g2', '2026-01-02T00:00:00Z', other,
      'Run the migration before starting the demo server.',
      { scope: 'global', lesson_type: 'lesson', importance: 'medium' }),
    // A rule, and global. This is the row that has to reach `runs/<run>/rules.json`.
    row('les_g1', '2026-01-01T00:00:00Z', other,
      'An ingest job answers "queued" when accepted, not when stored — poll the job id.',
      { scope: 'global', lesson_type: 'rule', importance: 'high' }),
  ];
}

function queryResponse(mode) {
  const ev = (over) => ({
    id: 'e0', content: '', source: 'agent', score: 0.5, run_id: 'cc-lab',
    entry_type: 'fact', metadata_json: '{}', retrieval_mode: 'semantic_search',
    reference_id: 'ref_0', referenceable: true, origin_entry_type: '',
    is_stale: false, superseded_by: '', explain_info: '', knowledge_confidence: 0.5, ...over,
  });
  return {
    final_answer: '', confidence: 0.6, mode: mode ?? 'direct_bypass', degraded: false,
    consulted_runs: [], routing_summary: String(mode ?? 'direct_bypass'), signals: {}, citations: [],
    evidence: [
      ev({ id: 'e1', reference_id: 'ref_rule_1', entry_type: 'rule', score: 0.91,
        content: 'Ingest returns when queued, not when stored; poll the job id.' }),
      ev({ id: 'e2', reference_id: 'ref_lesson_1', entry_type: 'lesson', score: 0.84,
        content: 'A job stays queued until indexing completes — waiting is the fix, not retrying.' }),
      ev({ id: 'e3', reference_id: 'ref_fact_1', entry_type: 'fact', score: 0.55,
        content: 'IngestAccepted.status is always "queued" on success.' }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * @param {number} i @param {string} key @param {any} body
 * @param {number} status @param {any} reply @param {any} headers
 */
function record(i, key, body, status, reply, headers) {
  const tag = `#${String(i).padStart(2, '0')}`;
  const verdict = status >= 400 ? `\x1b[31m${status}\x1b[0m` : `\x1b[32m${status}\x1b[0m`;
  line(`${tag} ${key.padEnd(44)} → ${verdict}`);

  const auth = String(headers?.authorization ?? '');
  const detail = [];

  if (key === 'POST /v2/control/query') {
    detail.push(`mode=${body?.mode}  lane=${body?.direct_lane ?? '-'}  evidence_only=${body?.evidence_only}`);
    detail.push(`run=${body?.run_id}  agent=${body?.agent_id}`);
    detail.push(`query="${trim(body?.query, 70)}"`);
    detail.push(`env_tags=[${(body?.env_tags ?? []).join(' ')}]`);
    if (status === 200) detail.push(`replied evidence=${reply.json.evidence.length} (${reply.json.evidence.map((e) => e.reference_id).join(', ')})`);
  } else if (key === 'POST /v2/control/ingest') {
    detail.push(`run=${body?.run_id}  agent=${body?.agent_id}`);
    detail.push(`idempotency_key=${body?.idempotency_key}`);
    detail.push(`items=${(body?.items ?? []).length}`);
    for (const it of body?.items ?? []) {
      detail.push(`  · ${String(it.item_id).padEnd(34)} ${String(it.intent).padEnd(12)} ${String(it.importance).padEnd(7)} "${trim(it.text, 64)}"`);
    }
    if (status === 200) detail.push(`replied job_id=${reply.json.job_id} status=${reply.json.status} deduplicated=${reply.json.deduplicated}`);
  } else if (key === 'POST /v2/control/outcome') {
    detail.push(`outcome=${body?.outcome}  signal=${body?.signal}  reference_id=${body?.reference_id}`);
    detail.push(`entry_ids=[${(body?.entry_ids ?? []).join(', ')}]   ← the memories this turn reinforced`);
    detail.push(`idempotency_key=${body?.idempotency_key}`);
  } else if (key === 'POST /v2/control/reflect') {
    detail.push(`run=${body?.run_id}  last_n_items=${body?.last_n_items}  include_step_outcomes=${body?.include_step_outcomes}`);
    if (status === 200) detail.push(`replied lessons_stored=${reply.json.lessons_stored}`);
  } else if (key === 'POST /v2/control/agents/register' || key === 'POST /v2/control/agents/heartbeat') {
    detail.push(`run=${body?.run_id}  agent=${body?.agent_id}  status=${body?.status}`);
  } else if (key === 'POST /v2/control/lessons') {
    detail.push(`scope=${body?.scope}  limit=${body?.limit}  run_id=${body?.run_id ?? '(absent — absent means all runs)'}`);
  } else if (key === 'POST /v2/control/activity') {
    detail.push(`entry_types=${JSON.stringify(body?.entry_types ?? null)}  projection=${body?.projection ?? '(compact — scope will be missing)'}  limit=${body?.limit}`);
  } else if (key === 'POST /v2/control/checkpoint') {
    detail.push(`run=${body?.run_id}  bytes=${String(body?.content ?? '').length}`);
  }

  detail.push(`auth=${auth ? `${auth.slice(0, 18)}…` : '\x1b[31m(no Authorization header)\x1b[0m'}`);
  for (const d of detail) line(`    ${d}`);
  line('');

  try {
    mkdirSync(WORK, { recursive: true });
    appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), seq: i, key, status, body })}\n`);
  } catch { /* the log is a convenience, never the point */ }
}

function line(s) { process.stdout.write(`${s}\n`); }
function trim(v, max) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function parse(raw) { try { return raw ? JSON.parse(raw) : {}; } catch { return { _unparseable: raw }; } }
function pick(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] ?? '') : '';
}
