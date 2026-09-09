// @ts-check
/**
 * `bin/dashboard.html` in a real browser.
 *
 * The other two page suites read the file as text or run its pure regions in `node:vm`; this
 * one serves the shipped page from the real server, against `fakeMubit()` and a fixture data
 * directory, and drives it through Chrome over the DevTools protocol (`helpers/chrome.mjs`).
 * It is where event wiring, rendering, focus and layout become assertions.
 *
 * Every case is skipped, and reported as skipped, where no Chrome is found or
 * `MUBIT_CC_NO_BROWSER=1` is set.
 */

import assert from 'node:assert/strict';

import { lib, mod, baseEnv, fakeMubit, makeDataDir } from './helpers/harness.mjs';
import { browserTest } from './helpers/chrome.mjs';
import {
  RUN, SESSION, lessonActivity, lessonsRoute, seedRun, writeMarker, writeSession, writeSubagent, writeTurn,
} from './helpers/dashboard-fixtures.mjs';

const P1 = '11111111-2222-3333-4444-555555555555';
const P2 = '22222222-2222-3333-4444-555555555555';
const P3 = '33333333-2222-3333-4444-555555555555';
const P4 = '44444444-2222-3333-4444-555555555555';

/**
 * Three closed turns in one session, all today: one that injected a memory and echoed it, one
 * that injected two and was marked a failure, and one that injected nothing. The outcomes the
 * page must show are worked / failed / none.
 */
function seedTurns(dataDir) {
  const now = Date.now();
  writeMarker(dataDir, RUN);
  writeSession(dataDir, SESSION);
  writeTurn(dataDir, RUN, {
    prompt: 'rebuild the bundle', prompt_id: P1, session_id: SESSION, turn_number: 1,
    started_at: now - 3 * 60_000, ended_at: now - 2 * 60_000, outcome_pending: true,
    recalled: ['ref_lesson_1'], recall: { tokens: 120, chars: 480, sources: 1, pointers: 0, rung: 1, terms: ['migration'] },
    used_evidence: { method: 'memory-term-echo/v1', used: true, matched: 1, candidates: 1, terms: ['migration'] },
  });
  writeTurn(dataDir, RUN, {
    prompt: 'ship it', prompt_id: P2, session_id: SESSION, turn_number: 2,
    started_at: now - 2 * 60_000, ended_at: now - 60_000, outcome: 'failure', outcome_pending: true,
    recalled: ['ref_lesson_1', 'ref_lesson_2'], recall: { tokens: 300, chars: 1200, sources: 2, pointers: 0, rung: 1 },
    used_evidence: { method: 'memory-term-echo/v1', used: true, matched: 1, candidates: 2 },
  });
  writeTurn(dataDir, RUN, {
    prompt: 'and nothing was injected here', prompt_id: P3, session_id: SESSION, turn_number: 3,
    started_at: now - 60_000, ended_at: now - 30_000, recalled: [], recall: { tokens: 0, chars: 0, sources: 0, pointers: 0, rung: 1, empty_reason: 'no_match' },
  });
  writeSubagent(dataDir, RUN, 'abc', { prompt_id: P2, at: now - 90_000 });
}

/** Two lessons written by this directory's run: one with counters stamped, one without. */
function seedLessons() {
  return [
    lessonActivity({ source_run_id: RUN, success_count: 3, failure_count: 1, confidence: 0.7, last_outcome: 'success', last_outcome_at: '2026-09-08T10:00:00Z' },
      { id: 'a3c1f0de-0000-4000-8000-000000000001', reference_id: 'ref_lesson_1', run_id: RUN, content: 'Run the migration first.' }),
    lessonActivity({ source_run_id: RUN, scope: 'session' },
      { id: 'a3c1f0de-0000-4000-8000-000000000002', reference_id: 'ref_lesson_2', run_id: RUN, content: 'Never rebuild the mirror by hand.', created_at: '2026-09-07T09:00:00Z' }),
  ];
}

/**
 * The real page on a loopback port, with a fake instance behind it.
 *
 * `startServer` is called without `html`, so what the browser loads is the file that ships.
 *
 * @param {import('node:test').TestContext} t
 * @param {{routes?: Record<string, any>, endpoint?: string, extra?: Record<string, string>,
 *          seed?: (dataDir: string) => void}} [o]
 */
async function serve(t, o = {}) {
  const dataDir = makeDataDir();
  const upstream = await fakeMubit(o.routes ?? lessonsRoute(seedLessons()));
  t.after(() => upstream.close());
  (o.seed ?? seedTurns)(dataDir);

  const { loadConfig } = await lib('config.mjs');
  const env = baseEnv({ dataDir, endpoint: o.endpoint ?? upstream.url, extra: o.extra });
  const cfg = loadConfig(env);
  const dash = await mod('bin/dashboard.src.mjs');
  const started = await dash.startServer({ cfg, env, idleMs: 0, onStop: () => {} });
  t.after(() => started.close());

  return {
    dataDir, upstream, started,
    /** The launch URL, token and all — the one navigation that carries it. */
    launchUrl: (hash = '') => `${started.url}?token=${encodeURIComponent(started.token)}${hash}`,
  };
}

const ROWS = "Array.from(document.querySelectorAll('#turn-rows tr[tabindex]'))";
const PILLS = `${ROWS}.map((tr) => tr.querySelector('td[data-k=outcome] .pill').className)`;
const LESSON_ROWS = "Array.from(document.querySelectorAll('#lesson-rows tr[tabindex]'))";

// ---------------------------------------------------------------------------
// 1 — the shell, and the token
// ---------------------------------------------------------------------------

browserTest('browser: the shell renders and the launch token is gone from the address bar', async (t, page) => {
  const { launchUrl, started } = await serve(t, { seed: seedRun });
  await page.goto(launchUrl());
  const href = await page.eval('location.href');
  assert.ok(!href.includes(started.token), `the token is still in the URL: ${href}`);
  assert.equal(await page.eval('location.search'), '');
  assert.ok(await page.eval("!!document.querySelector('#rail')"), 'the rail is the shell');
  const conn = await page.waitFor(
    "(document.querySelector('#conn-text') || {}).textContent !== 'connecting' && document.querySelector('#conn-text').textContent",
    { label: 'the connection pill settles' },
  );
  assert.ok(String(conn).length > 0);
  assert.deepEqual(page.errors(), [], 'the page threw or logged an error while booting');
});

// ---------------------------------------------------------------------------
// 2 — navigation and the hash
// ---------------------------------------------------------------------------

browserTest('browser: a nav click switches the page and sets the hash, and a reload keeps it', async (t, page) => {
  const { launchUrl } = await serve(t);
  await page.goto(launchUrl());
  await page.waitFor("document.querySelector('#nav-overview').getAttribute('aria-current') === 'page'");
  await page.click('#nav-turns');
  assert.equal(await page.eval("document.querySelector('#page-turns').hidden"), false);
  assert.equal(await page.eval("document.querySelector('#page-overview').hidden"), true);
  assert.equal(await page.eval("document.querySelector('#nav-turns').getAttribute('aria-current')"), 'page');
  assert.equal(await page.eval("document.querySelector('#page-title').textContent"), 'Turns');
  // The run lands in the hash once the first fetch has resolved it; the click may come first.
  const hash = await page.waitFor("/^#\\/turns\\?dir=.*&run=cc-dash-00000001$/.test(location.hash) && location.hash",
    { label: 'the hash names the page, the directory and the run' });
  assert.match(String(hash), /^#\/turns\?dir=.*&run=cc-dash-00000001$/, hash);

  await page.reload();
  await page.waitFor("!document.querySelector('#page-turns').hidden");
  assert.equal(await page.eval("document.querySelector('#page-overview').hidden"), true);
  assert.equal(await page.eval("document.querySelector('#page-title').textContent"), 'Turns');
  assert.ok((await page.waitFor(`${ROWS}.length`)) >= 3, 'the turns table filled in after the reload');
  assert.deepEqual(page.errors(), []);
});

// ---------------------------------------------------------------------------
// 3 — the Overview
// ---------------------------------------------------------------------------

browserTest('browser: the Overview has five KPI tiles, a chart with bars, and names its history', async (t, page) => {
  const { launchUrl } = await serve(t);
  await page.goto(launchUrl());
  await page.waitFor("document.querySelectorAll('#kpis .kpi').length === 5", { label: 'five tiles' });
  // The tiles render once with nothing and again when /api/overview lands.
  const turns = await page.waitFor("(function () { const v = document.querySelector('#kpis .kpi[data-kpi=turns] .v'); return v && v.firstChild.textContent !== '0' && v.firstChild.textContent; })()", { label: 'the turns tile fills in' });
  assert.equal(turns, '3', 'the turns tile counts today\'s three turns');
  assert.match(String(await page.eval("document.querySelector('#kpis .kpi[data-kpi=turns] .u').textContent")), /in 7 days/);
  const marks = await page.waitFor("document.querySelectorAll('#chart svg .marks > *:not(.hit)').length");
  assert.ok(marks >= 3, `expected the three outcomes as segments; found ${marks}`);
  assert.ok(await page.eval("document.querySelectorAll('#chart-legend span').length >= 2"), 'two or more series get a legend');
  const note = await page.eval("document.querySelector('#overview-note').textContent");
  assert.match(String(note), /No turn history yet|History starts/, note);
  // The chart tabs switch the plot and are a keyboard tablist.
  await page.click('#ctab-injected');
  await page.waitFor("document.querySelector('#chart svg .series-line')");
  assert.equal(await page.eval("document.querySelector('#chart-legend').children.length"), 0, 'one series needs no legend');
  assert.equal(await page.eval("document.querySelector('#ctab-injected').getAttribute('aria-selected')"), 'true');
  await page.eval("document.querySelector('#ctab-injected').focus()");
  await page.press('ArrowRight');
  await page.waitFor("document.querySelector('#ctab-cost').getAttribute('aria-selected') === 'true'");
  assert.equal(await page.eval('document.activeElement.id'), 'ctab-cost');
  assert.match(String(await page.eval('location.hash')), /chart=cost/);
  assert.deepEqual(page.errors(), []);
});

// ---------------------------------------------------------------------------
// 4–7 — Turns: rows, the drawer, the verdict, the keyboard
// ---------------------------------------------------------------------------

browserTest('browser: Turns shows one row per prompt with worked, failed and none pills', async (t, page) => {
  const { launchUrl } = await serve(t);
  await page.goto(launchUrl('#/turns'));
  const n = await page.waitFor(`${ROWS}.length >= 3 && ${ROWS}.length`);
  assert.equal(n, 3);
  const pills = await page.eval(PILLS);
  assert.deepEqual(pills, ['pill muted', 'pill bad', 'pill ok'], 'newest first: none, failed, worked');
  const texts = await page.eval(`${ROWS}.map((tr) => tr.querySelector('td[data-k=outcome]').textContent)`);
  assert.deepEqual(texts, ['none', 'failed', 'worked']);
  assert.equal(await page.eval(`${ROWS}[1].querySelector('td[data-k=agents]').textContent`), 'main + 1 sub (Explore)');
  assert.equal(await page.eval(`${ROWS}[1].querySelector('td[data-k=injected]').textContent`), '2');
  assert.deepEqual(page.errors(), []);
});

browserTest('browser: a row click opens the drawer and resolves an injected lesson through one dereference call', async (t, page) => {
  const { launchUrl, upstream } = await serve(t);
  await page.goto(launchUrl('#/turns'));
  await page.waitFor(`${ROWS}.length >= 3`);
  await page.eval(`${ROWS}[2].click()`);
  await page.waitFor("!document.querySelector('#drawer').hidden");
  assert.match(String(await page.eval("document.querySelector('#drawer-title').textContent")), /^Prompt 11111111/);
  const content = await page.waitFor("(document.querySelector('#drawer-body .injected li .c') || {}).textContent");
  assert.equal(content, 'Run the migration first.');
  assert.equal(upstream.countOf('POST', '/v2/control/dereference'), 1, `dereference calls: ${upstream.summary()}`);
  assert.equal(upstream.lastCall('POST', '/v2/control/dereference').body.reference_id, 'ref_lesson_1');
  assert.match(String(await page.eval("document.querySelector('#drawer-body .injected li .m').textContent")), /3 worked · 1 failed/,
    'the injected lesson shows its own counters');
  assert.match(String(await page.eval('location.hash')), /turn=11111111/);
  assert.deepEqual(page.errors(), []);
});

browserTest('browser: the per-turn Worked posts one outcome crediting every injected id under a key unique to the turn', async (t, page) => {
  const { launchUrl, upstream } = await serve(t);
  await page.goto(launchUrl('#/turns'));
  await page.waitFor(`${ROWS}.length >= 3`);
  await page.eval(`${ROWS}[1].click()`);
  await page.waitFor("!document.querySelector('#drawer').hidden");
  await page.eval("Array.from(document.querySelectorAll('#drawer-body button')).find((b) => b.textContent === 'Worked').click()");
  await page.waitFor("!document.querySelector('#toast').hidden");
  assert.match(String(await page.eval("document.querySelector('#toast').textContent")), /Recorded: worked · 2 memories credited/);
  assert.equal(upstream.countOf('POST', '/v2/control/outcome'), 1, upstream.summary());
  const body = upstream.lastCall('POST', '/v2/control/outcome').body;
  assert.deepEqual(body.entry_ids, ['ref_lesson_1', 'ref_lesson_2']);
  assert.equal(body.reference_id, 'global');
  assert.equal(body.outcome, 'success');
  assert.equal(body.signal, 1);
  assert.ok(!('agent_id' in body), 'a verdict is the user\'s, not a hook\'s');
  assert.ok(!('success' in body), 'the field the backend never read is gone');
  assert.ok(body.idempotency_key.includes(P2), body.idempotency_key);
  // The row and the drawer now say so, and it is the verdict that wins over the failure signal.
  await page.waitFor(`${ROWS}[1].querySelector('td[data-k=outcome]').textContent === 'worked'`);
  await page.waitFor("(document.querySelector('#drawer-body .pill') || {}).textContent === 'worked'",
    { label: 'the drawer shows the verdict' });

  // A second turn's verdict is a second key.
  await page.click('#drawer-close');
  await page.eval(`${ROWS}[2].click()`);
  await page.waitFor("!document.querySelector('#drawer').hidden && document.querySelector('#drawer-title').textContent.startsWith('Prompt 11111111')");
  await page.eval("Array.from(document.querySelectorAll('#drawer-body button')).find((b) => b.textContent === 'Did not work').click()");
  await page.waitFor(`${ROWS}[2].querySelector('td[data-k=outcome]').textContent === 'did not work'`);
  assert.equal(upstream.countOf('POST', '/v2/control/outcome'), 2);
  const second = upstream.lastCall('POST', '/v2/control/outcome').body;
  assert.notEqual(second.idempotency_key, body.idempotency_key);
  assert.equal(second.outcome, 'failure');
  assert.equal(second.signal, -1);
  assert.deepEqual(page.errors(), []);
});

browserTest('browser: Enter opens a turn from the keyboard, the drawer traps focus, and Escape returns it to the row', async (t, page) => {
  const { launchUrl } = await serve(t);
  await page.goto(launchUrl('#/turns'));
  await page.waitFor(`${ROWS}.length >= 3`);
  await page.eval(`${ROWS}[0].focus()`);
  await page.press('Enter');
  await page.waitFor("!document.querySelector('#drawer').hidden");
  assert.equal(await page.eval('document.activeElement.id'), 'drawer-close', 'focus moves into the drawer');
  await page.press('Tab');
  assert.ok(await page.eval("document.querySelector('#drawer').contains(document.activeElement)"), 'Tab stays inside the drawer');
  await page.press('Escape');
  await page.waitFor("document.querySelector('#drawer').hidden");
  assert.equal(await page.eval("document.activeElement.getAttribute('data-focus-id')"), `turn:${P3}`, 'focus returns to the row that opened it');
  assert.ok(!String(await page.eval('location.hash')).includes('turn='), 'the drawer left the hash too');
  assert.deepEqual(page.errors(), []);
});

browserTest('browser: a turn that lands under a focused row keeps the keyboard on that row', async (t, page) => {
  const { dataDir, launchUrl } = await serve(t);
  await page.goto(launchUrl('#/turns'));
  await page.waitFor(`${ROWS}.length === 3`);
  await page.eval(`${ROWS}[1].focus()`);
  assert.equal(await page.eval("document.activeElement.getAttribute('data-focus-id')"), `turn:${P2}`);
  const now = Date.now();
  writeTurn(dataDir, RUN, {
    prompt: 'one more', prompt_id: P4, session_id: SESSION, turn_number: 4,
    started_at: now - 10_000, ended_at: now - 5_000, recalled: [],
    recall: { tokens: 0, chars: 0, sources: 0, pointers: 0, rung: 1, empty_reason: 'no_match' },
  });
  await page.waitFor(`${ROWS}.length === 4`, { label: 'the poll picked up the fourth turn' });
  assert.equal(await page.eval("document.activeElement.getAttribute('data-focus-id')"), `turn:${P2}`, 'the rebuild handed focus back to the same row');
  await page.press('Enter');
  await page.waitFor("!document.querySelector('#drawer').hidden");
  assert.equal(await page.eval("document.querySelector('#drawer-body').textContent.includes('ship it')"), true, 'and Enter opened that row');
  assert.deepEqual(page.errors(), []);
});

// ---------------------------------------------------------------------------
// 8–11 — Lessons: counters, sorting, filters, actions
// ---------------------------------------------------------------------------

browserTest('browser: Lessons shows worked and failed counts, and blanks — not zeros — where nothing was stamped', async (t, page) => {
  const { launchUrl } = await serve(t);
  await page.goto(launchUrl('#/lessons'));
  await page.waitFor(`${LESSON_ROWS}.length === 2`, { label: 'two lesson rows' });
  const cells = await page.eval(`${LESSON_ROWS}.map((tr) => ['injected', 'worked', 'failed', 'confidence', 'last'].map((k) => tr.querySelector('td[data-k=' + k + ']').textContent.trim()))`);
  // Newest saved first: ref_lesson_1 (2026-08-19) is older than ref_lesson_2 (2026-09-07).
  // "injected" is counted from the turns on disk: ref_lesson_1 went into two of them.
  assert.deepEqual(cells, [
    ['1', '', '', '', ''],
    ['2', '3', '1', '0.70', 'worked'],
  ]);
  assert.equal(await page.eval("document.querySelector('#nav-lessons-n').textContent"), '2');
  assert.deepEqual(page.errors(), []);
});

browserTest('browser: a header click cycles aria-sort and reorders the rows', async (t, page) => {
  const { launchUrl } = await serve(t);
  await page.goto(launchUrl('#/lessons'));
  await page.waitFor(`${LESSON_ROWS}.length === 2`);
  const th = "document.querySelector('#lesson-table th[data-key=worked]')";
  assert.equal(await page.eval(`${th}.getAttribute('aria-sort')`), 'none');
  await page.click('#lesson-table th[data-key=worked]');
  assert.equal(await page.eval(`${th}.getAttribute('aria-sort')`), 'descending');
  assert.equal(await page.eval("document.querySelector('#lesson-table th[data-key=saved]').getAttribute('aria-sort')"), 'none', 'one sort at a time');
  assert.equal(await page.eval(`${LESSON_ROWS}[0].querySelector('td[data-k=worked]').textContent`), '3');
  await page.click('#lesson-table th[data-key=worked]');
  assert.equal(await page.eval(`${th}.getAttribute('aria-sort')`), 'ascending');
  assert.equal(await page.eval(`${LESSON_ROWS}[0].querySelector('td[data-k=worked]').textContent`), '3', 'a blank sorts last in both directions');
  assert.deepEqual(page.errors(), []);
});

browserTest('browser: the text and scope filters narrow the rows, and the empty message names the filter', async (t, page) => {
  const { launchUrl } = await serve(t);
  await page.goto(launchUrl('#/lessons'));
  await page.waitFor(`${LESSON_ROWS}.length === 2`);
  await page.type('#lesson-q', 'mirror');
  await page.waitFor(`${LESSON_ROWS}.length === 1`);
  assert.match(String(await page.eval(`${LESSON_ROWS}[0].textContent`)), /mirror/);
  await page.type('#lesson-q', 'zzz');
  const empty = await page.waitFor("(document.querySelector('#lesson-rows .empty') || {}).textContent");
  assert.match(String(empty), /No lesson in the 2 loaded matches the text “mirrorzzz”/, empty);
  await page.eval("const q = document.querySelector('#lesson-q'); q.value = ''; q.dispatchEvent(new Event('input'))");
  await page.waitFor(`${LESSON_ROWS}.length === 2`);
  await page.eval("const s = document.querySelector('#scope-filter'); s.value = 'run'; s.dispatchEvent(new Event('change'))");
  const scoped = await page.waitFor("(document.querySelector('#lesson-rows .empty') || {}).textContent");
  assert.match(String(scoped), /scope run/, scoped);
  assert.match(String(await page.eval("document.querySelector('#lesson-footer').textContent")), /^0 shown · 2 hidden/);
  assert.deepEqual(page.errors(), []);
});

browserTest('browser: the kebab posts a lesson outcome, and deletion needs the id typed and posts lesson_id', async (t, page) => {
  const { launchUrl, upstream } = await serve(t);
  await page.goto(launchUrl('#/lessons'));
  await page.waitFor(`${LESSON_ROWS}.length === 2`);
  await page.eval(`${LESSON_ROWS}[1].querySelector('.kebab').click()`);
  await page.waitFor("!document.querySelector('#menu').hidden");
  await page.eval("Array.from(document.querySelectorAll('#menu button')).find((b) => b.textContent === 'Did not work').click()");
  await page.waitFor("!document.querySelector('#toast').hidden");
  assert.equal(upstream.countOf('POST', '/v2/control/outcome'), 1, upstream.summary());
  const body = upstream.lastCall('POST', '/v2/control/outcome').body;
  assert.equal(body.reference_id, 'ref_lesson_1');
  assert.equal(body.outcome, 'failure');
  assert.deepEqual(body.entry_ids, ['ref_lesson_1']);
  await page.waitFor(`${LESSON_ROWS}[1].querySelector('td[data-k=failed]').textContent === '2'`);

  await page.eval(`${LESSON_ROWS}[1].click()`);
  await page.waitFor("!document.querySelector('#drawer').hidden");
  await page.eval("document.querySelector('#drawer-body .confirm input').focus()");
  assert.equal(await page.eval("document.querySelector('#drawer-body .confirm .btn.danger').disabled"), true);
  await page.type('#drawer-body .confirm input', 'ref_lesson_1');
  await page.waitFor("!document.querySelector('#drawer-body .confirm .btn.danger').disabled");
  await page.click('#drawer-body .confirm .btn.danger');
  await page.waitFor(`${LESSON_ROWS}.length === 1`);
  assert.equal(upstream.countOf('POST', '/v2/control/lessons/delete'), 1);
  assert.deepEqual(upstream.lastCall('POST', '/v2/control/lessons/delete').body, { lesson_id: 'ref_lesson_1' });
  assert.equal(await page.eval("document.querySelector('#drawer').hidden"), true);
  assert.deepEqual(page.errors(), []);
});

// ---------------------------------------------------------------------------
// 12–13 — theme
// ---------------------------------------------------------------------------

browserTest('browser: the theme toggle persists across a reload and applies the light tokens', async (t, page) => {
  const { launchUrl } = await serve(t);
  await page.goto(launchUrl());
  await page.waitFor("document.querySelector('#conn-text').textContent !== 'connecting'");
  const before = await page.eval("document.documentElement.getAttribute('data-theme')");
  await page.click('#theme');
  const after = await page.eval("document.documentElement.getAttribute('data-theme')");
  assert.ok(after === 'light' || after === 'dark', `the toggle sets an explicit theme: ${after}`);
  assert.notEqual(after, before);
  await page.reload();
  await page.waitFor("document.querySelector('#conn-text').textContent !== 'connecting'");
  assert.equal(await page.eval("document.documentElement.getAttribute('data-theme')"), after, 'the choice survived the reload');
  await page.eval("document.documentElement.setAttribute('data-theme', 'light')");
  const bg = await page.eval("getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()");
  assert.equal(bg, 'hsl(32 36% 97%)', 'the light block is what applies under data-theme=light');
  assert.equal(await page.eval("getComputedStyle(document.documentElement).getPropertyValue('--warning').trim()"), 'hsl(31 92% 46%)');
  await page.eval("document.documentElement.setAttribute('data-theme', 'dark')");
  assert.equal(await page.eval("getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()"), 'hsl(28 9% 8%)');
  assert.deepEqual(page.errors(), []);
});

// ---------------------------------------------------------------------------
// 14 — narrow layout
// ---------------------------------------------------------------------------

browserTest('browser: at 375px no page overflows horizontally, and the rail opens behind its toggle', async (t, page) => {
  const { launchUrl } = await serve(t);
  await page.viewport(375, 800);
  await page.goto(launchUrl());
  await page.waitFor("document.querySelector('#conn-text').textContent !== 'connecting'");
  for (const p of ['overview', 'turns', 'lessons', 'feed', 'health']) {
    await page.click(`#nav-${p}`);
    await page.waitFor(`!document.querySelector('#page-${p}').hidden`);
    if (p === 'turns') await page.waitFor(`${ROWS}.length >= 3`);
    if (p === 'lessons') await page.waitFor(`${LESSON_ROWS}.length === 2`);
    const widths = await page.eval('[document.documentElement.scrollWidth, document.documentElement.clientWidth, document.body.scrollWidth]');
    assert.ok(widths[0] <= widths[1] && widths[2] <= widths[1], `${p} overflows: scrollWidth ${widths[0]}/${widths[2]} vs ${widths[1]}`);
  }
  assert.equal(await page.eval("document.querySelector('#rail').offsetParent"), null, 'the rail is collapsed at 375px');
  assert.notEqual(await page.eval("document.querySelector('#rail-toggle').offsetParent"), null, 'behind a visible toggle');
  await page.click('#rail-toggle');
  assert.notEqual(await page.eval("document.querySelector('#rail').offsetParent"), null, 'the toggle opens it');
  assert.equal(await page.eval("document.querySelector('#rail-toggle').getAttribute('aria-expanded')"), 'true');
  assert.ok(await page.eval('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), 'still no horizontal overflow with the rail open');
  assert.deepEqual(page.errors(), []);
});

// ---------------------------------------------------------------------------
// 15 — offline
// ---------------------------------------------------------------------------

browserTest('browser: an unreachable instance shows the banner while Turns still renders from disk', async (t, page) => {
  const { launchUrl } = await serve(t, { endpoint: 'http://127.0.0.1:1' });
  await page.goto(launchUrl('#/turns'));
  await page.waitFor("!document.querySelector('#banner').hidden");
  assert.equal(await page.eval("document.querySelector('#banner-title').textContent"), 'Instance unreachable');
  assert.equal(await page.eval("document.querySelector('#conn-text').textContent"), 'unreachable');
  assert.equal(await page.waitFor(`${ROWS}.length >= 3 && ${ROWS}.length`), 3);
  await page.click('#nav-lessons');
  const empty = await page.waitFor("(document.querySelector('#lesson-rows .empty') || {}).textContent");
  assert.match(String(empty), /Could not load lessons from the instance/, 'a failed fetch is not an empty instance');
  await page.click('#nav-overview');
  await page.waitFor("document.querySelectorAll('#kpis .kpi').length === 5");
  assert.equal(await page.eval("document.querySelector('#kpis .kpi[data-kpi=saved] .v').firstChild.textContent"), '—', 'a tile that needs the instance says so');
});

// ---------------------------------------------------------------------------
// 16 — the Feed
// ---------------------------------------------------------------------------

browserTest('browser: the Feed lists every entry under day headers, and a row resolves by id into the drawer', async (t, page) => {
  const { launchUrl, upstream } = await serve(t);
  await page.goto(launchUrl('#/feed'));
  const rows = await page.waitFor("document.querySelectorAll('#feed-rows tr[tabindex]').length === 2 && 2");
  assert.equal(rows, 2);
  const groups = await page.eval("Array.from(document.querySelectorAll('#feed-rows tr.group td')).map((td) => td.textContent)");
  assert.deepEqual(groups, ['2026-09-07 (1)', '2026-08-19 (1)'], 'one header per day, newest first');
  assert.equal(await page.eval("document.querySelector('#feed-rows tr[tabindex] td[data-k=origin]').textContent"), 'reflection');
  const before = upstream.countOf('POST', '/v2/control/dereference');
  await page.eval("document.querySelectorAll('#feed-rows tr[tabindex]')[1].click()");
  await page.waitFor("!document.querySelector('#drawer').hidden");
  await page.waitFor("(document.querySelector('#drawer-body .prose') || {}).textContent === 'Run the migration first.'");
  assert.equal(upstream.countOf('POST', '/v2/control/dereference'), before + 1, 'the row resolves through one dereference');
  assert.equal(upstream.lastCall('POST', '/v2/control/dereference').body.reference_id, 'a3c1f0de-0000-4000-8000-000000000001');
  assert.match(String(await page.eval('location.hash')), /entry=a3c1f0de-0000-4000-8000-000000000001/);
  assert.ok(await page.eval("Array.from(document.querySelectorAll('#drawer-body button')).some((b) => b.textContent === 'Open in Lessons')"), 'a lesson row links across');
  assert.deepEqual(page.errors(), []);
});

// ---------------------------------------------------------------------------
// Races the CI runner found: the first fetch and the drawer's detail are slower there
// ---------------------------------------------------------------------------

/** Hold every fetch whose URL contains `needle` back by `ms`, from before the page boots. */
function delayFetch(page, needle, ms) {
  return page.onNewDocument(`(() => {
    const real = window.fetch;
    window.fetch = (url, init) => String(url).includes(${JSON.stringify(needle)})
      ? new Promise((r) => setTimeout(() => r(real(url, init)), ${ms}))
      : real(url, init);
  })();`);
}

browserTest('browser: a page change made before the runs arrive still ends with the run in the hash', async (t, page) => {
  const { launchUrl } = await serve(t);
  await delayFetch(page, '/api/runs?', 800);
  await page.goto(launchUrl());
  await page.click('#nav-turns');
  assert.equal(await page.eval("document.querySelector('#page-turns').hidden"), false);
  const early = String(await page.eval('location.hash'));
  assert.ok(early.startsWith('#/turns'), early);
  assert.ok(!early.includes('run=cc-dash-00000001'), `the runs were held back, yet the hash already names one: ${early}`);
  await page.waitFor("/^#\\/turns\\?dir=.*&run=cc-dash-00000001$/.test(location.hash)",
    { label: 'the hash gained the run once it resolved' });
  await page.reload();
  await page.waitFor("!document.querySelector('#page-turns').hidden");
  assert.ok((await page.waitFor(`${ROWS}.length`)) >= 3, 'the reload landed on the same run');
  assert.deepEqual(page.errors(), []);
});

browserTest('browser: a verdict given while the turn\'s detail is still loading is not undone when it arrives', async (t, page) => {
  const { launchUrl, upstream } = await serve(t);
  await delayFetch(page, '/api/turn?', 1200);
  await page.goto(launchUrl('#/turns'));
  await page.waitFor(`${ROWS}.length >= 3`);
  await page.eval(`${ROWS}[1].click()`);
  await page.waitFor("!document.querySelector('#drawer').hidden");
  assert.equal(await page.eval("document.querySelector('#drawer-body').getAttribute('data-detail')"), 'loading',
    'the button is pressed against the table row alone');
  await page.eval("Array.from(document.querySelectorAll('#drawer-body button')).find((b) => b.textContent === 'Worked').click()");
  await page.waitFor("!document.querySelector('#toast').hidden");
  assert.equal(upstream.countOf('POST', '/v2/control/outcome'), 1, upstream.summary());
  await page.waitFor("(document.querySelector('#drawer-body .pill') || {}).textContent === 'worked'");
  // The detail lands after the verdict. It carries no verdict of its own, and must not win.
  await page.waitFor("document.querySelector('#drawer-body').getAttribute('data-detail') === 'loaded'",
    { label: 'the held-back detail arrived' });
  assert.equal(await page.eval("document.querySelector('#drawer-body .pill').textContent"), 'worked');
  assert.equal(await page.eval(`${ROWS}[1].querySelector('td[data-k=outcome]').textContent`), 'worked');
  assert.deepEqual(page.errors(), []);
});
