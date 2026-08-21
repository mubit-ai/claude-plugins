#!/usr/bin/env node
// @ts-check
/**
 * `scripts/setup.mjs` — install Mubit's registrations into the Codex user layer.
 *
 *   node scripts/setup.mjs <plugin-root> [--with-pre-tool] [--no-trust]
 *
 * This is the mechanical half of `mubit-memory:setup`, extracted so it can be read before it
 * is run and so the skill has one thing to invoke rather than a JSON-RPC handshake to
 * hand-roll. The skill still owns the judgement: which of these steps to take, whether the
 * user wants the `PreToolUse` warnings, and — the one that matters — asking before trust.
 *
 * ---------------------------------------------------------------------------
 * Why a Codex plugin needs an install step at all
 * ---------------------------------------------------------------------------
 * Codex ignores a `hooks.json` bundled in a plugin, and cannot resolve a path in a plugin's
 * `.mcp.json` — no `${VAR}` layer, and a relative path resolves against the project
 * directory. Both are recorded against a live host in `docs/harness-probe.md` §3-§4. So the
 * plugin ships both files as templates carrying `{{PLUGIN_ROOT}}`, and this substitutes the
 * real install path and writes them where Codex actually reads.
 *
 * ---------------------------------------------------------------------------
 * The three things it is careful about
 * ---------------------------------------------------------------------------
 * 1. **It merges, it does not overwrite.** `$CODEX_HOME/hooks.json` is the user's, and other
 *    tools register there. Every handler that is not ours is preserved; ours are replaced by
 *    path, so re-running is idempotent rather than additive.
 * 2. **It trusts only its own hooks.** The `hooks/list` result is filtered to commands under
 *    this plugin root before anything is written to `config.toml`. Trusting the whole file
 *    would silently approve another tool's hook on the user's behalf.
 * 3. **It backs up both files** it touches, to `<name>.before-mubit`, before touching them.
 *
 * `--no-trust` does everything except the `config.toml` write, for anyone who would rather
 * approve the hooks themselves in the TUI's `/hooks` screen. The result is identical; the
 * difference is who decided. `--data-dir=<path>` overrides step 0's resolution.
 *
 * Node >= 20 built-ins only, and it shells out to `codex` for the two things Codex owns.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { claudeCodeDataDir } from '../lib/boot.mjs';

const root = process.argv[2];
const withPreTool = process.argv.includes('--with-pre-tool');
const noTrust = process.argv.includes('--no-trust');
const dataArg = (process.argv.find((a) => a.startsWith('--data-dir=')) ?? '').slice('--data-dir='.length);
const HOME = process.env.CODEX_HOME || join(homedir(), '.codex');

if (!root || !existsSync(join(root, 'hooks.json'))) {
  console.error('usage: node scripts/setup.mjs <plugin-root> [--data-dir=<path>] [--with-pre-tool] [--no-trust]');
  console.error('  <plugin-root> is the directory containing hooks.json and .mcp.json');
  process.exit(2);
}
for (const need of ['hooks/dist/capture.mjs', 'mcp/dist/index.js', 'mcp/dist/server.js']) {
  if (!existsSync(join(root, need))) {
    console.error(`missing ${need} under ${root} — the install is damaged; reinstall the plugin.`);
    process.exit(2);
  }
}

/**
 * `config.toml` with every `[hooks.state."…"]` table removed, body and all.
 *
 * Line-based rather than a TOML parse, because this file is the user's: it carries their
 * project trust levels, their model choice, their notify hook. Round-tripping it through a
 * parser and a serialiser would reformat all of that to rewrite eleven tables. Removing the
 * lines leaves every byte we do not own exactly as it was.
 *
 * A `[hooks.state]` table's body is a single `trusted_hash` line, so the state machine only
 * has to survive that and the blank lines between tables; anything else ends the skip.
 *
 * @param {string} text
 * @returns {string}
 */
function stripHookState(text) {
  const out = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    if (/^\[hooks\.state\./.test(line)) { skipping = true; continue; }
    if (skipping) {
      if (/^trusted_hash\s*=/.test(line)) continue;
      if (/^\s*$/.test(line)) continue;
      skipping = false;
    }
    out.push(line);
  }
  // Also drop the header this script writes, so re-running does not stack comment blocks.
  const kept = out.filter((l) => !/^# Mubit Memory — hook trust/.test(l)
    && !/^# Every \[hooks\.state\] table below is regenerated/.test(l));
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept.length ? `${kept.join('\n')}\n` : '';
}

// --- 0. resolve the data directory, and PIN it -----------------------------------
//
// This is the step whose absence made a Codex session and a Claude Code session in one
// directory derive the same run id and then write it to two different places. Claude Code
// names its data directory with a suffix — `mubit-memory-<marketplace>` for a marketplace
// install, `-inline` for `--plugin-dir` — so the bare default is only one of several, and
// picking wrong costs the user their credentials and every memory the other harness holds.
//
// `lib/boot.mjs` can find it at runtime, and does. But a search is a guess, and this is the
// one moment where the answer can be resolved once, shown to the user, and written down.
// Pinning it as MUBIT_CC_DATA_DIR in the registrations outranks every other input on both
// hosts, so nothing downstream ever has to guess again.
const dataDir = dataArg || claudeCodeDataDir(process.env);
const shared = existsSync(join(dataDir, 'credentials.json'));
console.log(`data directory: ${dataDir}`);
console.log(shared
  ? '  shared with your Claude Code install — same run ids, same memory, same credentials.'
  : '  no credentials.json here yet. If you already use the Claude Code plugin, check this is '
    + 'the same directory it uses (ls ~/.claude/plugins/data/) and pass --data-dir=<path> if not.');

// --- 1. merge the registrations ------------------------------------------------
const tpl = JSON.parse(readFileSync(join(root, 'hooks.json'), 'utf8'));
const target = join(HOME, 'hooks.json');
const existing = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : { hooks: {} };
if (existsSync(target)) {
  copyFileSync(target, `${target}.before-mubit`);
  console.log(`backed up ${target} -> ${target}.before-mubit`);
}
const isMubit = (h) => String(h?.command ?? '').includes('/hooks/dist/');
// Codex runs a hook command as a shell string, so the pin rides in front of `node` — which is
// also why it is quoted: a data directory with a space in it is otherwise two arguments.
const sub = (s) => `MUBIT_CC_DATA_DIR=${JSON.stringify(dataDir)} ${s.split('{{PLUGIN_ROOT}}').join(root)}`;
const merged = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
let added = 0;
for (const [event, groups] of Object.entries(tpl.hooks)) {
  if (event === 'PreToolUse' && !withPreTool) continue;
  const ours = groups.map((g) => ({ ...g, hooks: g.hooks.map((h) => ({ ...h, command: sub(h.command) })) }));
  const theirs = (merged.hooks[event] ?? [])
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isMubit(h)) }))
    .filter((g) => g.hooks.length);
  merged.hooks[event] = [...theirs, ...ours];
  added += ours.reduce((n, g) => n + g.hooks.length, 0);
}
// hooks.json accepts exactly `description` and `hooks`; anything else fails the whole file.
for (const k of Object.keys(merged)) if (k !== 'hooks' && k !== 'description') delete merged[k];
writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`merged ${added} handler(s) across ${Object.keys(tpl.hooks).length - (withPreTool ? 0 : 1)} events into ${target}`);
if (!withPreTool) console.log('  (PreToolUse omitted: the warnings it exists for are off by default)');

// --- 2. register the MCP server ------------------------------------------------
spawnSync('codex', ['mcp', 'remove', 'mubit'], { stdio: 'ignore' });
// `--env` matters as much here as the pin in the hook commands does. The MCP server derives
// the run id itself, with the same strategy the hooks use, so a server reading a different
// data directory would write /mubit-memory:remember into a run pre-prompt recall never reads.
const add = spawnSync('codex', [
  'mcp', 'add', 'mubit',
  '--env', `MUBIT_CC_DATA_DIR=${dataDir}`,
  '--', 'node', join(root, 'mcp/dist/index.js'),
], { encoding: 'utf8' });
console.log((add.stdout || add.stderr || '').trim());

// --- 3. trust ------------------------------------------------------------------
if (noTrust) {
  console.log('\nskipping trust (--no-trust). Run /hooks in the Codex TUI and approve the Mubit entries,');
  console.log('or Codex will silently skip every one of them.');
  process.exit(0);
}
const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const msgs = [];
child.stdout.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) { try { msgs.push(JSON.parse(line)); } catch { /* not a frame */ } }
  }
});
const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'mubit-setup', title: 'mubit-setup', version: '1' } } });
setTimeout(() => send({ jsonrpc: '2.0', method: 'initialized', params: {} }), 500);
setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'hooks/list', params: {} }), 900);
setTimeout(() => {
  child.kill();
  const hooks = (msgs.find((m) => m.id === 2)?.result?.data?.[0]?.hooks ?? [])
    .filter((h) => String(h.command ?? '').includes(join(root, 'hooks', 'dist')));
  if (!hooks.length) {
    console.error('\nno Mubit hooks found by `hooks/list` — nothing trusted. Check the merge above.');
    process.exit(1);
  }
  console.log(`\nAbout to record trust for ${hooks.length} hook(s) in ${join(HOME, 'config.toml')}:`);
  for (const h of hooks) console.log(`  ${h.eventName.padEnd(18)} ${h.command}`);

  const cfg = join(HOME, 'config.toml');
  if (existsSync(cfg)) copyFileSync(cfg, `${cfg}.before-mubit`);
  const before = existsSync(cfg) ? readFileSync(cfg, 'utf8') : '';

  // Replace, never append. A hook's trust key is `<sourcePath>:<event>:<group>:<index>` and
  // does not change when its command does — so re-running setup after any edit produces a
  // SECOND `[hooks.state."<same key>"]` table. TOML forbids redefining a table, so the file
  // stops parsing and Codex refuses to start at all: "failed to load bootstrap configuration".
  //
  // Not hypothetical. This is what the first version of this script did on its second run.
  const kept = stripHookState(before);
  let toml = '\n# Mubit Memory — hook trust, rewritten in full by scripts/setup.mjs.\n';
  toml += '# Every [hooks.state] table below is regenerated on each run; edits here are lost.\n';
  for (const h of hooks) toml += `[hooks.state."${h.key}"]\ntrusted_hash = "${h.currentHash}"\n`;
  writeFileSync(cfg, `${kept}${toml}`);

  const dupes = (`${kept}${toml}`.match(/^\[hooks\.state\./gm) ?? []).length;
  if (dupes !== hooks.length) {
    console.error(`\nrefusing to leave ${dupes} trust tables for ${hooks.length} hooks — restoring.`);
    writeFileSync(cfg, before);
    process.exit(1);
  }
  console.log(`\nrecorded ${hooks.length}. Start a NEW Codex session — hooks and MCP servers are read at session start.`);
  process.exit(0);
}, 3000);
