#!/usr/bin/env node
// @ts-check
/**
 * Speak real stdio MCP to the plugin's server and report what it exposes — build-guide §8.
 *
 * This is the manual counterpart to `test/launch.test.mjs`. The tests stub the server out to
 * assert the launcher's env ordering; this drives the whole chain the way Claude Code does:
 * spawn the entry point, `initialize`, `notifications/initialized`, then `tools/list` or
 * `tools/call`. What it prints is what `/mcp` would show.
 *
 * Usage:
 *
 *   node scripts/mcp-probe.mjs                          # tools/list through mcp/dist/index.js
 *   node scripts/mcp-probe.mjs --server <path>          # ...with ./server.js redirected
 *   node scripts/mcp-probe.mjs --entry  <path>          # ...running some other entry outright
 *   node scripts/mcp-probe.mjs --call mubit_status --args '{}'
 *   node scripts/mcp-probe.mjs --json                   # machine-readable
 *
 * `--server` swaps in a different server bundle without touching the committed one. It used
 * to be the flag that mattered most: `mcp/dist/server.js` was bundled from the *published*
 * `@mubit-ai/mcp`, which predated the §8.1 allowlist patch, so the committed server ignored
 * `MUBIT_MCP_TOOLS` and this probe printed all 21 tools. It is now built from the in-repo
 * package (`esbuild.config.mjs`) and prints ten. Use `--server` to compare against another
 * build — a published tarball, or a branch you are patching.
 *
 * Reads `MUBIT_ENDPOINT` / `MUBIT_API_KEY` from the environment, so a stored credential from
 * `/mubit-memory:auth` is not enough on its own — export them for this one command. Never
 * prints the key.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = join(PLUGIN_ROOT, 'mcp', 'dist', 'index.js');

const HANDSHAKE_MS = 20_000;

main().catch((err) => {
  process.stderr.write(`mcp-probe: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
});

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) return usage();

  const entry = opt.server ? stageLauncher(opt.server) : (opt.entry || LAUNCHER);
  const result = await probe(entry, opt);

  if (opt.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  report(result, opt);
}

// ---------------------------------------------------------------------------
// The MCP conversation
// ---------------------------------------------------------------------------

/**
 * @param {string} entry
 * @param {ReturnType<typeof parseArgs>} opt
 */
async function probe(entry, opt) {
  const child = spawn(process.execPath, [entry], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });

  /** @type {Map<number, (m: any) => void>} */
  const pending = new Map();
  let buf = '';
  let stderr = '';

  child.stderr.on('data', (d) => { stderr += String(d); });
  child.stdout.on('data', (d) => {
    buf += String(d);
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const fn = pending.get(msg.id);
        if (fn) { pending.delete(msg.id); fn(msg); }
      } catch {
        // Not a JSON-RPC frame. On a healthy stdio server there are none — anything the
        // server prints to stdout that is not protocol is itself the bug worth seeing.
        stderr += `[stdout, not protocol] ${line}\n`;
      }
    }
  });

  /** @param {any} msg */
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

  /**
   * @param {number} id
   * @param {string} method
   * @param {any} [params]
   * @returns {Promise<any>}
   */
  const rpc = (id, method, params) => new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(
      `timed out after ${HANDSHAKE_MS / 1000}s waiting for ${method}.\n`
      + `The server's stderr:\n${stderr || '(silent)'}`)), HANDSHAKE_MS);
    pending.set(id, (msg) => { clearTimeout(timer); res(msg); });
    send({ jsonrpc: '2.0', id, method, params });
  });

  try {
    const init = await rpc(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-probe', version: '1' },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const listed = await rpc(2, 'tools/list', {});
    const tools = (listed.result?.tools ?? []).map((/** @type {any} */ t) => t.name).sort();

    /** @type {any} */
    let called = null;
    if (opt.call) {
      const res = await rpc(3, 'tools/call', { name: opt.call, arguments: opt.args });
      called = res.result ?? res.error ?? null;
    }

    return { entry, server: init.result?.serverInfo ?? null, count: tools.length, tools, called, stderr };
  } finally {
    child.kill('SIGKILL');
  }
}

// ---------------------------------------------------------------------------
// --server: run the real launcher against a different server bundle
// ---------------------------------------------------------------------------

/**
 * Copy the launcher into a scratch directory beside a `server.js` that re-exports the
 * bundle you asked for. The launcher resolves `./server.js` relative to itself, so this
 * swaps the server without touching the committed one.
 * @param {string} serverPath
 * @returns {string} the staged entry point
 */
function stageLauncher(serverPath) {
  const abs = resolve(serverPath);
  const dir = mkdtempSync(join(tmpdir(), 'mubit-mcp-probe-'));
  const entry = join(dir, 'index.js');
  copyFileSync(LAUNCHER, entry);
  // Importing for side effects: the upstream module starts itself at module scope, which is
  // exactly the contract the launcher relies on.
  writeFileSync(join(dir, 'server.js'), `import ${JSON.stringify(abs)};\n`);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  return entry;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * @param {any} r
 * @param {ReturnType<typeof parseArgs>} opt
 */
function report(r, opt) {
  const name = r.server?.name ?? '(unnamed)';
  const version = r.server?.version ?? '(no version)';
  process.stdout.write(`server    ${name} ${version}\n`);
  process.stdout.write(`endpoint  ${process.env.MUBIT_ENDPOINT || '(unset)'}\n`);
  process.stdout.write(`tools     ${r.count}\n`);
  for (const t of r.tools) process.stdout.write(`  · ${t}\n`);

  if (version === '0.1.0') {
    process.stdout.write('\nnote: version "0.1.0" is the pre-§8.1 hardcode — this server predates the '
      + 'allowlist patch, so MUBIT_MCP_TOOLS is inert and every tool registers.\n');
  } else if (version === '0.0.0-unpackaged') {
    process.stdout.write('\nnote: "0.0.0-unpackaged" means the server could not read its own version. It '
      + 'reads `../package.json`, which does not resolve once bundled to mcp/dist/server.js, so the '
      + 'launcher passes MUBIT_MCP_VERSION in — and did not. Rebuild with `npm run build`.\n');
  }
  if (r.called) {
    process.stdout.write(`\n${opt.call} →\n`);
    const text = r.called?.content?.[0]?.text;
    process.stdout.write(`${typeof text === 'string' ? text : JSON.stringify(r.called, null, 2)}\n`);
  }
  if (r.stderr.trim()) process.stdout.write(`\nserver stderr:\n${r.stderr.trim()}\n`);
}

function usage() {
  process.stdout.write(`mcp-probe — speak real stdio MCP to the plugin's server (build-guide §8)

  --server <path>   run the plugin launcher with ./server.js redirected at <path>
  --entry  <path>   run <path> as the server outright (default: mcp/dist/index.js)
  --call <tool>     after listing, call this tool
  --args '<json>'   arguments for --call (default: {})
  --json            machine-readable output
  -h, --help        this

Environment: MUBIT_ENDPOINT, MUBIT_API_KEY, MUBIT_MCP_TOOLS, CLAUDE_PROJECT_DIR.
`);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { server: '', entry: '', call: '', args: {}, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--server') out.server = argv[++i] ?? '';
    else if (a === '--entry') out.entry = argv[++i] ?? '';
    else if (a === '--call') out.call = argv[++i] ?? '';
    else if (a === '--args') {
      const raw = argv[++i] ?? '{}';
      try { out.args = JSON.parse(raw); } catch { throw new Error(`--args is not valid JSON: ${raw}`); }
    } else throw new Error(`unknown argument ${JSON.stringify(a)} (try --help)`);
  }
  return out;
}
