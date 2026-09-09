// @ts-check
/**
 * `bin/dashboard.html` in a real browser.
 *
 * The other two page suites read the file as text or run its pure regions in `node:vm`; this
 * one serves the shipped page from the real server, against `fakeMubit()` and a fixture data
 * directory, and drives it through Chrome over the DevTools protocol (`helpers/chrome.mjs`).
 * It is where event wiring, rendering, focus and layout — everything the module header of
 * `dashboard-page.test.mjs` lists as unverified — become assertions.
 *
 * Every case is skipped, and reported as skipped, where no Chrome is found or
 * `MUBIT_CC_NO_BROWSER=1` is set.
 */

import assert from 'node:assert/strict';

import { lib, mod, baseEnv, fakeMubit, makeDataDir } from './helpers/harness.mjs';
import { browserTest } from './helpers/chrome.mjs';
import { seedRun } from './helpers/dashboard-fixtures.mjs';

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
  const upstream = await fakeMubit(o.routes ?? {});
  t.after(() => upstream.close());
  (o.seed ?? seedRun)(dataDir);

  const { loadConfig } = await lib('config.mjs');
  const env = baseEnv({ dataDir, endpoint: o.endpoint ?? upstream.url, extra: o.extra });
  const cfg = loadConfig(env);
  const dash = await mod('bin/dashboard.src.mjs');
  const started = await dash.startServer({ cfg, env, idleMs: 0, onStop: () => {} });
  t.after(() => started.close());

  return {
    dataDir, upstream, started,
    /** The launch URL, token and all — the one navigation that carries it. */
    launchUrl: `${started.url}?token=${encodeURIComponent(started.token)}`,
  };
}

// ---------------------------------------------------------------------------
// 1 — the shell, and the token
// ---------------------------------------------------------------------------

browserTest('browser: the shell renders and the launch token is gone from the address bar', async (t, page) => {
  const { launchUrl, started } = await serve(t);
  await page.goto(launchUrl);

  // The token was lifted out and the URL rewritten before the first API call.
  const href = await page.eval('location.href');
  assert.ok(!href.includes(started.token), `the token is still in the URL: ${href}`);
  assert.equal(await page.eval('location.search'), '');

  // The page is talking to the server with the header it lifted: the pill leaves "connecting".
  assert.ok(await page.eval("!!document.querySelector('#rail')"), 'the rail is the shell');
  const conn = await page.waitFor(
    "(document.querySelector('#conn-text') || {}).textContent !== 'connecting' && document.querySelector('#conn-text').textContent",
    { label: 'the connection pill settles' },
  );
  assert.ok(String(conn).length > 0);

  assert.deepEqual(page.errors(), [], 'the page threw or logged an error while booting');
});
