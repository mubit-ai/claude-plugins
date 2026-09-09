// @ts-check
/**
 * A headless Chrome, driven over the DevTools protocol with nothing but Node's built-ins.
 *
 * The dashboard page is one self-contained HTML file with inline script, and until this
 * existed nothing executed it: `dashboard-page.test.mjs` slices the pure regions out and runs
 * them in `node:vm`, and `dashboard-layout.test.mjs` reads the markup as text. Event wiring,
 * rendering, focus and layout were verified by opening the page. This closes that gap
 * without taking on a dependency — no playwright, no puppeteer, no jsdom — because a Chrome
 * is already on every machine this suite runs on: the developer's, and the `ubuntu-latest`
 * runner behind the `verify` workflow, which ships `google-chrome`.
 *
 * What it costs: one Chrome process per test file (`sharedChrome`), a few hundred
 * milliseconds to launch, and a suite that *skips* rather than fails where no browser is
 * found. A skip is reported as one, so a green run on a browserless machine still says the
 * browser cases did not run.
 *
 *   MUBIT_CC_CHROME=/path/to/chrome   use this binary
 *   MUBIT_CC_NO_BROWSER=1             skip every browser case
 *
 * The protocol client below is the minimum: one WebSocket to the browser endpoint, flat
 * sessions per page target, promise-per-command. Node 22's global `WebSocket` is the
 * transport, which is the other reason this needs nothing installed.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PATH_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

/** How long Chrome may take to publish its DevTools endpoint. */
const LAUNCH_MS = 15000;

/** The default `waitFor` deadline. Everything the page does is against a loopback server. */
const WAIT_MS = 8000;

/** Where a failing case's screenshot goes. Named in the error, so it can be found. */
const SHOT_DIR = process.env.MUBIT_CC_TEST_SHOTS || join(tmpdir(), 'mubit-browser-shots');

// ---------------------------------------------------------------------------
// Finding a browser
// ---------------------------------------------------------------------------

/**
 * The Chrome binary to use, or `''`.
 *
 * `MUBIT_CC_CHROME` wins outright, and a pinned path that does not exist is a configuration
 * error reported as "no browser" rather than silently falling through to whatever is on PATH.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function findChrome(env = process.env) {
  const pinned = String(env.MUBIT_CC_CHROME || '').trim();
  if (pinned) return existsSync(pinned) ? pinned : '';
  if (existsSync(MAC_CHROME)) return MAC_CHROME;
  for (const name of PATH_NAMES) {
    const hit = onPath(name);
    if (hit) return hit;
  }
  return '';
}

/** @param {string} name @returns {string} */
function onPath(name) {
  try {
    const out = execFileSync('which', [name], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split('\n')[0];
    return out && existsSync(out) ? out : '';
  } catch {
    return '';
  }
}

/**
 * Why the browser cases will not run here, or `''` when they will.
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function skipReason(env = process.env) {
  if (String(env.MUBIT_CC_NO_BROWSER || '') === '1') return 'MUBIT_CC_NO_BROWSER=1';
  if (typeof globalThis.WebSocket !== 'function') return 'no global WebSocket (Node < 22)';
  if (!findChrome(env)) return 'no Chrome or Chromium found (set MUBIT_CC_CHROME)';
  return '';
}

// ---------------------------------------------------------------------------
// The protocol client
// ---------------------------------------------------------------------------

/**
 * One WebSocket to the browser, commands multiplexed by id and by session.
 */
class Cdp {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void, method: string}>} */
    this.pending = new Map();
    /** @type {Set<(msg: any) => void>} */
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => this.receive(String(ev.data)));
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error(`${p.method}: the browser connection closed`));
      this.pending.clear();
    });
  }

  /**
   * @param {string} method @param {Record<string, any>} [params] @param {string} [sessionId]
   * @returns {Promise<any>}
   */
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const msg = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try { this.ws.send(JSON.stringify(msg)); } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** @param {string} data */
  receive(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = /** @type {any} */ (this.pending.get(msg.id));
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    for (const fn of this.listeners) {
      try { fn(msg); } catch { /* a listener's failure is its own */ }
    }
  }

  /** @param {(msg: any) => void} fn @returns {() => void} */
  on(fn) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
}

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Chrome
 * @property {string} wsUrl
 * @property {() => Promise<Page>} page
 * @property {() => Promise<void>} close
 */

/**
 * Start a headless Chrome on a private profile and connect to it.
 *
 * `--remote-debugging-port=0` lets the kernel choose the port, so two suites can run at once;
 * the endpoint is read off stderr, which is the only place Chrome publishes it before the
 * port file exists.
 *
 * @param {{bin?: string, width?: number, height?: number}} [opts]
 * @returns {Promise<Chrome>}
 */
export async function launchChrome(opts = {}) {
  const bin = opts.bin || findChrome();
  if (!bin) throw new Error('launchChrome: no Chrome found; see skipReason()');
  const profile = mkdtempSync(join(tmpdir(), 'mubit-chrome-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-features=Translate',
    `--window-size=${opts.width ?? 1440},${opts.height ?? 900}`,
    'about:blank',
  ];
  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => {
      reject(new Error(`Chrome did not publish a DevTools endpoint within ${LAUNCH_MS} ms:\n${err}`));
    }, LAUNCH_MS);
    child.stderr.on('data', (c) => {
      err += c.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited with ${code} before publishing an endpoint:\n${err}`));
    });
  });
  // Nothing after the endpoint is worth reading, and an unread pipe fills up.
  child.stderr.resume();

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(undefined), { once: true });
    ws.addEventListener('error', (e) => reject(new Error(`could not connect to ${wsUrl}: ${String(/** @type {any} */ (e).message ?? e)}`)), { once: true });
  });
  const cdp = new Cdp(ws);

  // A Chrome that dies mid-suite must fail the pending command loudly, not leave it hanging
  // until the event loop drains and node:test reports a promise that never settled.
  let exited = null;
  child.once('exit', (code, signal) => {
    exited = `Chrome exited (${signal || code})`;
    try { ws.close(); } catch { /* already closed */ }
  });
  const sendOrExplain = cdp.send.bind(cdp);
  cdp.send = (method, params, sessionId) => (exited
    ? Promise.reject(new Error(`${method}: ${exited}`))
    : sendOrExplain(method, params, sessionId));

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await withTimeout(cdp.send('Browser.close'), 2000); } catch { /* it may already be gone */ }
    try { ws.close(); } catch { /* ditto */ }
    try { child.kill('SIGKILL'); } catch { /* ditto */ }
    await new Promise((r) => { setTimeout(r, 50); });
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  return {
    wsUrl,
    page: () => openPage(cdp),
    close,
  };
}

/** @param {Promise<any>} p @param {number} ms */
function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Page
 * @property {(url: string) => Promise<void>} goto           navigate and wait for `load`
 * @property {() => Promise<void>} reload                   reload and wait for `load`
 * @property {(expr: string) => Promise<any>} eval          `Runtime.evaluate`, awaited, by value; throws on exception
 * @property {(expr: string, opts?: {timeoutMs?: number, label?: string}) => Promise<any>} waitFor
 *   poll `expr` until truthy; returns the value
 * @property {(selector: string) => Promise<void>} click    `element.click()` on the first match
 * @property {(selector: string, text: string) => Promise<void>} type  focus, then insert text as key input
 * @property {(key: string) => Promise<void>} press          one key down/up on the focused element
 * @property {(width: number, height: number) => Promise<void>} viewport  device-metrics emulation
 * @property {(path: string) => Promise<string>} screenshot  PNG to `path`; returns the path
 * @property {(source: string) => Promise<() => Promise<void>>} onNewDocument
 *   run `source` before every document this page loads from now on; returns the remover
 * @property {() => string[]} errors                        uncaught exceptions and console errors so far
 * @property {() => Promise<void>} close
 */

const KEYS = {
  Escape: { code: 'Escape', keyCode: 27 },
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
  Tab: { code: 'Tab', keyCode: 9 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
};

/**
 * @param {Cdp} cdp
 * @returns {Promise<Page>}
 */
async function openPage(cdp) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params = {}) => cdp.send(method, params, sessionId);

  /** @type {string[]} */
  const errors = [];
  const off = cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails ?? {};
      errors.push(`uncaught: ${d.exception?.description ?? d.text ?? 'exception'}`);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      const args = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      errors.push(`console.error: ${args}`);
    } else if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
      const e = msg.params.entry;
      errors.push(`log: ${e.text ?? ''}${e.url ? ` (${e.url})` : ''}`);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  const loaded = () => new Promise((resolve) => {
    const stop = cdp.on((msg) => {
      if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') { stop(); resolve(undefined); }
    });
  });

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page eval failed: ${d.exception?.description ?? d.text ?? 'exception'}\n  in: ${expr.slice(0, 200)}`);
    }
    return r.result ? r.result.value : undefined;
  };

  const page = {
    async goto(url) {
      const done = loaded();
      await send('Page.navigate', { url });
      await withTimeout(done, WAIT_MS);
    },
    async reload() {
      const done = loaded();
      await send('Page.reload', {});
      await withTimeout(done, WAIT_MS);
    },
    eval: evaluate,
    async onNewDocument(source) {
      const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source });
      return () => send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).then(() => undefined);
    },
    async waitFor(expr, opts = {}) {
      const deadline = Date.now() + (opts.timeoutMs ?? WAIT_MS);
      let last;
      while (Date.now() < deadline) {
        last = await evaluate(expr);
        if (last) return last;
        await new Promise((r) => { setTimeout(r, 40); });
      }
      throw new Error(`waitFor timed out${opts.label ? ` (${opts.label})` : ''}: ${expr.slice(0, 200)} — last value ${JSON.stringify(last)}`);
    },
    async click(selector) {
      await evaluate(`(() => {
        const n = document.querySelector(${JSON.stringify(selector)});
        if (!n) throw new Error('click: nothing matches ' + ${JSON.stringify(selector)});
        n.click();
        return true;
      })()`);
    },
    async type(selector, text) {
      await evaluate(`(() => {
        const n = document.querySelector(${JSON.stringify(selector)});
        if (!n) throw new Error('type: nothing matches ' + ${JSON.stringify(selector)});
        n.focus();
        return true;
      })()`);
      await send('Input.insertText', { text });
    },
    async press(key) {
      const spec = KEYS[key] || { code: key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, text: key.length === 1 ? key : undefined };
      const base = { key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode };
      await send('Input.dispatchKeyEvent', { type: spec.text ? 'keyDown' : 'rawKeyDown', ...base, ...(spec.text ? { text: spec.text } : {}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    async viewport(width, height) {
      await send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: width < 600,
      });
    },
    async screenshot(path) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, Buffer.from(r.data, 'base64'));
      return path;
    },
    errors: () => errors.slice(),
    async close() {
      off();
      try { await cdp.send('Target.closeTarget', { targetId }); } catch { /* already closed */ }
    },
  };
  return page;
}

// ---------------------------------------------------------------------------
// One Chrome per test file
// ---------------------------------------------------------------------------

/** @type {Promise<Chrome>|null} */
let shared = null;
let hooked = false;

/**
 * The file's Chrome, launched on first use.
 *
 * The `after` hook that closes it is registered by `browserTest` at declaration time, never
 * from inside a running test: a hook registered while a test runs attaches to *that test*, and
 * Chrome was being killed after the first case while the second waited on it.
 *
 * @returns {Promise<Chrome>}
 */
export function sharedChrome() {
  if (!shared) shared = launchChrome();
  return shared;
}

function hookClose() {
  if (hooked) return;
  hooked = true;
  after(async () => {
    if (!shared) return;
    const c = await shared.catch(() => null);
    if (c) await c.close();
  });
}

/** @param {string} s */
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

/**
 * A `node:test` case that runs in a real page, or is reported as skipped when there is no
 * browser to run it in. The page is fresh per case and closed afterwards; on failure a
 * screenshot is written and its path is appended to the error.
 *
 * @param {string} name
 * @param {(t: import('node:test').TestContext, page: Page, chrome: Chrome) => Promise<void>} fn
 * @param {{timeoutMs?: number}} [opts]
 */
export function browserTest(name, fn, opts = {}) {
  const skip = skipReason();
  if (skip) {
    test(name, { skip }, () => {});
    return;
  }
  hookClose();
  test(name, { timeout: opts.timeoutMs ?? 30000 }, async (t) => {
    const chrome = await sharedChrome();
    const page = await chrome.page();
    try {
      await fn(t, page, chrome);
    } catch (err) {
      const shot = join(SHOT_DIR, `${slug(name)}.png`);
      let where = '';
      try { await page.screenshot(shot); where = `\n  screenshot: ${shot}`; } catch { /* the page may be gone */ }
      const errs = page.errors();
      const e = err instanceof Error ? err : new Error(String(err));
      e.message += where + (errs.length ? `\n  page errors:\n    ${errs.join('\n    ')}` : '');
      throw e;
    } finally {
      await page.close();
    }
  });
}
