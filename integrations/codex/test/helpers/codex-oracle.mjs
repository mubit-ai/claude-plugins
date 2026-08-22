// @ts-check
/**
 * The host, used as an oracle — offline.
 *
 * `codex app-server` answers `hooks/list` by **parsing a real `hooks.json` and echoing back
 * what it understood**: the event it filed each handler under, the matcher it kept, the
 * timeout it will enforce, the trust key it will look the handler up by, and the warnings and
 * errors it raised while reading the file. No model call, no API quota, no network — it is a
 * config parse behind a JSON-RPC frame, and `scripts/setup.mjs` already drives it in
 * production to discover exactly this.
 *
 * That single response answers the timeout, matcher, trust-key and plugin-discovery questions
 * at once, and answers them the way `codex-payload.test.mjs` answers the payload question:
 * with the host's own words rather than with ours. A fixture we wrote cannot falsify a
 * manifest we wrote. This can.
 *
 * ---------------------------------------------------------------------------
 * Regenerating the recorded answer
 * ---------------------------------------------------------------------------
 *
 *     node test/helpers/codex-oracle.mjs --update
 *
 * writes `test/fixtures/codex-hooks-list.json` from the `codex` on PATH. Do that when
 * `hooks.json` changes on purpose, and read the diff: it is the host telling you what your
 * change did.
 *
 * Node >= 20 built-ins only.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to `integrations/codex/`. */
export const CODEX_ROOT = resolve(HERE, '..', '..');

/** Where the recorded answer lives. */
export const FIXTURE_PATH = join(CODEX_ROOT, 'test', 'fixtures', 'codex-hooks-list.json');

/** The placeholders the recorded answer carries in place of machine-specific paths. */
export const HOME_TOKEN = '{{CODEX_HOME}}';
export const ROOT_TOKEN = '{{PLUGIN_ROOT}}';
export const HASH_TOKEN = '{{HASH}}';

/**
 * Is there a `codex` on PATH, and what version?
 *
 * @returns {{ok: boolean, version: string}}
 */
export function codexVersion() {
  const r = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return { ok: false, version: '' };
  return { ok: true, version: String(r.stdout || '').trim() };
}

/**
 * A throwaway `$CODEX_HOME` carrying our real `hooks.json`, substituted the way
 * `scripts/setup.mjs` substitutes it.
 *
 * The point of using the *real* template rather than a miniature is that the thing under test
 * is the manifest that ships. A hand-trimmed copy would be a third manifest to keep true.
 *
 * @param {{root?: string, transform?: (o: any) => any}} [opts]
 * @returns {{home: string, root: string, written: any}}
 */
export function seedCodexHome(opts = {}) {
  const root = opts.root ?? CODEX_ROOT;
  // § Resolved, not as `mkdtemp` returned it. On macOS `$TMPDIR` is a symlink into `/private`,
  //   and the host reports the resolved path — so an unresolved token leaves `/private` stuck
  //   in front of `{{CODEX_HOME}}` in every recorded key.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mubit-codex-home-')));
  const tpl = JSON.parse(readFileSync(join(root, 'hooks.json'), 'utf8'));

  const hooks = {};
  for (const [event, groups] of Object.entries(tpl.hooks)) {
    hooks[event] = groups.map((g) => ({
      ...g,
      hooks: g.hooks.map((h) => ({ ...h, command: String(h.command).split('{{PLUGIN_ROOT}}').join(root) })),
    }));
  }
  // § `description` is dropped deliberately: `hooks.json` accepts exactly `description` and
  //   `hooks`, and what setup.mjs writes into the user layer is the merge of the two files'
  //   `hooks` keys. Seeding what setup writes keeps the oracle answering about the real thing.
  let doc = { hooks };
  if (opts.transform) doc = opts.transform(doc);
  writeFileSync(join(home, 'hooks.json'), `${JSON.stringify(doc, null, 2)}\n`);
  return { home, root, written: doc };
}

/**
 * Ask the host what it made of a `$CODEX_HOME/hooks.json`.
 *
 * The handshake is `initialize` → `initialized` → `hooks/list`, which is the same one
 * `scripts/setup.mjs` performs. It is driven on wall-clock delays rather than on the replies
 * because that is what setup does in production, and a divergence here would test a protocol
 * nothing uses.
 *
 * @param {string} home
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{hooks: any[], warnings: any[], errors: any[], cwd: string, raw: any, stderr: string}>}
 */
export async function askHost(home, opts = {}) {
  const child = spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home },
  });

  let buf = '', stderr = '';
  /** @type {any[]} */ const msgs = [];
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) { try { msgs.push(JSON.parse(line)); } catch { /* not a frame */ } }
    }
  });

  const send = (m) => { try { child.stdin.write(`${JSON.stringify(m)}\n`); } catch { /* gone */ } };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'mubit-oracle', title: 'mubit-oracle', version: '1' } } });
  await sleep(400);
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  await sleep(400);
  send({ jsonrpc: '2.0', id: 2, method: 'hooks/list', params: {} });

  const deadline = Date.now() + (opts.timeoutMs ?? 6000);
  let reply;
  while (Date.now() < deadline) {
    reply = msgs.find((m) => m.id === 2);
    if (reply) break;
    await sleep(100);
  }
  try { child.kill(); } catch { /* already gone */ }

  if (!reply) {
    throw new Error(`codex app-server did not answer hooks/list within ${opts.timeoutMs ?? 6000}ms.\n`
      + `  stderr: ${stderr.slice(0, 500)}`);
  }
  const entry = reply.result?.data?.[0] ?? {};
  return {
    hooks: entry.hooks ?? [],
    warnings: entry.warnings ?? [],
    errors: entry.errors ?? [],
    cwd: entry.cwd ?? '',
    raw: reply,
    stderr,
  };
}

/**
 * The host's answer with this machine's paths replaced by placeholders, so two machines
 * record the same bytes.
 *
 * `currentHash` becomes `{{HASH}}`: it is a digest of the handler *including its absolute
 * command string*, so it differs on every machine by construction. Its shape is asserted
 * live instead — pinning the value would pin the checkout path.
 *
 * @param {{hooks: any[], warnings: any[], errors: any[]}} answer
 * @param {{home: string, root: string}} paths
 */
export function normalize(answer, paths) {
  const swap = (v) => (typeof v === 'string'
    ? v.split(paths.home).join(HOME_TOKEN).split(paths.root).join(ROOT_TOKEN)
    : v);
  return {
    hooks: answer.hooks.map((h) => {
      const out = {};
      for (const k of Object.keys(h).sort()) out[k] = swap(h[k]);
      if ('currentHash' in out) out.currentHash = HASH_TOKEN;
      return out;
    }),
    warnings: answer.warnings.map(swap),
    errors: answer.errors.map(swap),
  };
}

/**
 * Install throwaway plugins into a fresh `$CODEX_HOME`, one per hook-manifest layout, and
 * return the home so `askHost` can be asked which of them it found.
 *
 * This is the experiment that settles whether a plugin has to merge into the user layer at
 * all. The harness probe concluded plugin hooks are inert — the whole reason
 * `scripts/setup.mjs`, the `{{PLUGIN_ROOT}}` templating and the `config.toml` write exist —
 * and it reached that conclusion having tested exactly one of the three layouts.
 *
 * Each layout registers one `PostToolUse` handler whose command echoes its own name, so the
 * answer names the layout.
 *
 * @param {{layouts?: string[]}} [opts]
 * @returns {{home: string, ids: string[], installed: any[]}}
 */
export function installProbePlugins(opts = {}) {
  const layouts = opts.layouts ?? ['root-bare', 'hooks-dir', 'root-declared'];
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mubit-codex-plughome-')));
  const mkt = realpathSync(mkdtempSync(join(tmpdir(), 'mubit-codex-mkt-')));
  mkdirSync(join(mkt, '.agents', 'plugins'), { recursive: true });

  const doc = (tag) => `${JSON.stringify({
    hooks: {
      PostToolUse: [{
        matcher: '*',
        hooks: [{ type: 'command', timeout: 3, command: `/bin/echo ${tag}` }],
      }],
    },
  }, null, 2)}\n`;

  const entries = [];
  for (const layout of layouts) {
    const dir = join(mkt, 'plugins', layout);
    mkdirSync(join(dir, '.codex-plugin'), { recursive: true });
    /** @type {any} */
    const manifest = {
      name: layout, version: '0.0.1', description: `hook-discovery probe: ${layout}`,
      author: { name: 'Mubit' }, license: 'Apache-2.0',
    };
    if (layout === 'hooks-dir') {
      mkdirSync(join(dir, 'hooks'), { recursive: true });
      writeFileSync(join(dir, 'hooks', 'hooks.json'), doc(layout));
    } else {
      writeFileSync(join(dir, 'hooks.json'), doc(layout));
      if (layout === 'root-declared') manifest.hooks = './hooks.json';
    }
    writeFileSync(join(dir, '.codex-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    entries.push({
      name: layout,
      source: { source: 'local', path: `./plugins/${layout}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
      category: 'Productivity',
    });
  }
  writeFileSync(join(mkt, '.agents', 'plugins', 'marketplace.json'), `${JSON.stringify({
    name: 'mubit-probe-mkt', interface: { displayName: 'Mubit hook-discovery probe' }, plugins: entries,
  }, null, 2)}\n`);

  const env = { ...process.env, CODEX_HOME: home };
  const add = spawnSync('codex', ['plugin', 'marketplace', 'add', mkt], { env, encoding: 'utf8' });
  if (add.status !== 0) {
    throw new Error(`codex plugin marketplace add failed: ${add.stderr || add.stdout}`);
  }
  const installed = [];
  for (const layout of layouts) {
    const r = spawnSync('codex', ['plugin', 'add', `${layout}@mubit-probe-mkt`, '--json'], { env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`codex plugin add ${layout} failed: ${r.stderr || r.stdout}`);
    try { installed.push(JSON.parse(r.stdout)); } catch { installed.push({ raw: r.stdout }); }
  }
  return { home, ids: layouts.map((l) => `${l}@mubit-probe-mkt`), installed };
}

/** The recorded answer. */
export function recordedAnswer() {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(`no recorded hooks/list answer at ${FIXTURE_PATH}\n`
      + '  Regenerate it: node test/helpers/codex-oracle.mjs --update');
  }
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ---------------------------------------------------------------------------
// `--update`
// ---------------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (!process.argv.includes('--update')) {
    console.error('usage: node test/helpers/codex-oracle.mjs --update');
    process.exit(2);
  }
  const v = codexVersion();
  if (!v.ok) {
    console.error('no `codex` on PATH — nothing to ask.');
    process.exit(1);
  }
  const { home, root } = seedCodexHome();
  const answer = await askHost(home);
  const doc = {
    _comment: [
      'What `codex app-server` answered to `hooks/list` when $CODEX_HOME/hooks.json held the',
      'registrations scripts/setup.mjs writes from our hooks.json. This is the HOST describing',
      'our manifest back to us: the event it filed each handler under, the matcher it kept, the',
      'timeout it will enforce, and the key it will look the handler up by when deciding trust.',
      '',
      'Machine-specific paths are replaced with {{CODEX_HOME}} and {{PLUGIN_ROOT}}.',
      '`currentHash` is {{HASH}} because it digests the absolute command string and so differs',
      'on every checkout; codex-oracle.test.mjs asserts its shape against the live host instead.',
      '',
      'Regenerate: node test/helpers/codex-oracle.mjs --update',
    ],
    _provenance: {
      codex_version: v.version,
      recorded: new Date().toISOString().slice(0, 10),
      handler_count: answer.hooks.length,
    },
    ...normalize(answer, { home, root }),
  };
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${FIXTURE_PATH} — ${answer.hooks.length} handler(s), `
    + `${answer.warnings.length} warning(s), ${answer.errors.length} error(s)`);
}
