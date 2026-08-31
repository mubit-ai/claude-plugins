#!/usr/bin/env node
// @ts-check
/**
 * `labs/mcp-drive.mjs` — call one MCP tool and show what it put on the wire.
 *
 * `scripts/mcp-probe.mjs` already speaks stdio MCP, and for asking a server what it exposes
 * it is the better tool. This one exists for the two things the probe deliberately does not
 * do, both of which turn out to be where the interesting bugs live.
 *
 * **It never needs the key.** The probe reads `MUBIT_ENDPOINT` / `MUBIT_API_KEY` out of the
 * environment, so pointing it at a real instance means exporting a real credential into a
 * shell — and then it is in your history, your scrollback, and whatever else reads that
 * shell. This driver sets `MUBIT_CC_DATA_DIR` and nothing else, and lets the launcher's own
 * `loadConfig()` resolve the stored credential the way it does in a real session. The key is
 * never read here, never printed, and never exported. That is what makes it safe to point at
 * production, which is the only place some of these behaviours are visible at all.
 *
 * **It shows which routes the call dialled.** A tool's answer tells you what it returned; it
 * does not tell you where it went. `--routes` diffs the fake instance's request log across
 * the call, so "this tool reads the activity feed, not the lessons route" becomes something
 * you observe rather than something you take on faith. Several of the plugin's guarantees are
 * only checkable this way — see Lab 11.
 *
 *   node labs/mcp-drive.mjs --list
 *   node labs/mcp-drive.mjs --tool mubit_status --args '{}'
 *   node labs/mcp-drive.mjs --tool mubit_lessons --args '{}' --routes
 *   node labs/mcp-drive.mjs --tool mubit_lessons --args '{"scope":"global"}' --routes
 *   node labs/mcp-drive.mjs --live --data-dir ~/.claude/plugins/data/mubit-memory-mubit \
 *     --tool mubit_lessons --args '{}'
 *
 * `--live` drops the lab's endpoint and key so the stored credential decides both. Everything
 * else is identical, which is the point: the same command shape against a fake instance you
 * can read and a real one you cannot.
 *
 * Zero dependencies, like everything else here.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAB_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(LAB_ROOT, '..');
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(REPO_ROOT, 'integrations', 'claude-code');
const LAUNCHER = join(PLUGIN_ROOT, 'mcp', 'dist', 'index.js');
const REQUEST_LOG = join(LAB_ROOT, '.work', 'requests.ndjson');

const HANDSHAKE_MS = 20_000;

main().catch((err) => {
  process.stderr.write(`mcp-drive: ${err?.message ?? err}\n`);
  process.exitCode = 1;
});

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) return usage();
  if (!opt.list && !opt.tool) return usage(1);

  const before = opt.routes ? logLines() : 0;
  const out = await drive(opt);

  if (opt.list) {
    line(`server    ${out.server.name} ${out.server.version}`);
    line(`tools     ${out.tools.length}`);
    for (const t of out.tools) line(`  · ${t}`);
  } else {
    line(`${opt.tool} →`);
    line(render(out.result));
  }

  if (opt.routes) {
    const dialled = logLines(before);
    line('');
    line(dialled.length ? 'routes dialled by that call:' : 'routes dialled by that call: (none — no request left the process)');
    for (const r of dialled) line(`  ${r.status === 404 ? '\x1b[31m' : ''}${r.key} → ${r.status}\x1b[0m`);
  }
}

/**
 * Spawn the launcher, shake hands, call one tool.
 *
 * The env is built by subtraction rather than addition: inherit the shell, then remove the
 * things that would override the stored credential under `--live`. `MUBIT_DEFAULT_SESSION_ID`
 * is always blanked — it is the server bundle's poisoned module-scope default, and leaving it
 * set is indistinguishable from the launcher having failed to derive a run id.
 *
 * @param {ReturnType<typeof parseArgs>} opt
 */
async function drive(opt) {
  if (!existsSync(LAUNCHER)) throw new Error(`no launcher at ${LAUNCHER}`);

  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, MUBIT_DEFAULT_SESSION_ID: '' };
  if (opt.dataDir) env.MUBIT_CC_DATA_DIR = expand(opt.dataDir);
  if (opt.live) {
    // Let the stored credential decide both. Deleting is the whole trick: an empty string is
    // still a value, and `loadConfig` would take it.
    delete env.MUBIT_API_KEY;
    delete env.MUBIT_ENDPOINT;
  }

  const child = spawn(process.execPath, [LAUNCHER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', (c) => stderr.push(String(c)));

  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += String(chunk);
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!raw) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      const seat = pending.get(msg.id);
      if (seat) { pending.delete(msg.id); seat(msg); }
    }
  });

  let seq = 0;
  const send = (method, params) => new Promise((ok, no) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); no(new Error(`${method} timed out`)); }, HANDSHAKE_MS);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) return no(new Error(`${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      ok(msg.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  try {
    const init = await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mubit-lab-drive', version: '1' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const server = {
      name: init?.serverInfo?.name ?? '(unnamed)',
      version: init?.serverInfo?.version ?? '?',
    };

    if (opt.list) {
      const listed = await send('tools/list', {});
      return { server, tools: (listed?.tools ?? []).map((t) => String(t.name)).sort(), result: null };
    }

    const result = await send('tools/call', { name: opt.tool, arguments: opt.args });
    return { server, tools: [], result };
  } finally {
    child.stdin.end();
    child.kill();
    // The launcher explains itself on stderr — a run id it had to fall back on, a credential
    // it could not find. Worth surfacing, because both are silent successes otherwise.
    const noise = stderr.join('').trim();
    if (noise && process.env.LAB_MCP_QUIET !== '1') {
      for (const l of noise.split('\n')) process.stderr.write(`  · ${l}\n`);
    }
  }
}

/** MCP wraps tool output in content parts; unwrap the JSON one when there is exactly one. */
function render(result) {
  const parts = result?.content;
  if (Array.isArray(parts) && parts.length === 1 && typeof parts[0]?.text === 'string') {
    try { return JSON.stringify(JSON.parse(parts[0].text), null, 2); } catch { return parts[0].text; }
  }
  return JSON.stringify(result, null, 2);
}

/**
 * The fake instance's request log, as a count or as the rows added since one.
 *
 * @param {number} [since] when given, return the rows after this many lines
 */
function logLines(since) {
  let lines = [];
  try {
    lines = readFileSync(REQUEST_LOG, 'utf8').split('\n').filter(Boolean);
  } catch { /* no fake instance running, or nothing logged yet */ }
  if (since === undefined) return lines.length;
  return lines.slice(since).map((l) => {
    try {
      const d = JSON.parse(l);
      return { key: String(d.key ?? '?'), status: Number(d.status ?? 0) };
    } catch { return { key: '(unparseable log line)', status: 0 }; }
  });
}

function parseArgs(argv) {
  const opt = { tool: '', args: {}, list: false, routes: false, live: false, dataDir: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opt.help = true;
    else if (a === '--list') opt.list = true;
    else if (a === '--routes') opt.routes = true;
    else if (a === '--live') opt.live = true;
    else if (a === '--tool') opt.tool = argv[++i] ?? '';
    else if (a === '--data-dir') opt.dataDir = argv[++i] ?? '';
    else if (a === '--args') {
      const raw = argv[++i] ?? '{}';
      try { opt.args = JSON.parse(raw); } catch { throw new Error(`--args is not JSON: ${raw}`); }
    } else throw new Error(`unknown flag ${a}`);
  }
  return opt;
}

function expand(p) { return p.startsWith('~/') ? join(process.env.HOME ?? '', p.slice(2)) : p; }
function line(s) { process.stdout.write(`${s}\n`); }

function usage(code = 0) {
  line('node labs/mcp-drive.mjs --list');
  line('node labs/mcp-drive.mjs --tool <name> --args \'<json>\' [--routes] [--live] [--data-dir <path>]');
  line('');
  line('  --routes    diff the fake instance request log across the call');
  line('  --live      drop the lab endpoint and key; let the stored credential decide');
  process.exitCode = code;
}
