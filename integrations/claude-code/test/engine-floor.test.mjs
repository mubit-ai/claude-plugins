// @ts-check
/**
 * `test/engine-floor.test.mjs` — the runtime floor guard (§11.1 engines, §11.2).
 *
 * The failure this pins is total and silent. On a Node older than the `engines` floor the
 * bundles do not fail — they never load: no marker, no log line, no MCP activity, which reads
 * exactly like a plugin that was never configured. A benchmark trial scored 1.0 while wearing
 * a plugin that had never parsed.
 *
 * Two properties have to hold together, and each is useless alone:
 *
 *   1. The file Claude Code executes must *parse* on the old runtime. A guard inside the real
 *      bundle cannot help — a module is parsed in full before its first statement runs — and
 *      the target cannot simply be lowered, because every entry point uses top-level await
 *      and node14.8 is the lowest target esbuild accepts for that.
 *   2. Having parsed, it must refuse in a sentence, honour the stdout contract, and exit 0.
 *      A misconfigured runtime must not fail the user's session.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Must match `LAUNCHER_TARGET` in esbuild.config.mjs. */
const FLOOR_TARGET = 'node12.20';

/** The Debian 11 runtime that produced the original SyntaxError. */
const OLD_NODE = '12.22.9';

/**
 * Every guarded entry point that a process actually execs. `drain.mjs` is deliberately
 * included and is deliberately absent from `hooks.json`: `capture` spawns it detached, so it
 * is exec'd by path like the rest and needs the same floor.
 */
function guardedScripts() {
  const hooks = ['session-start', 'cwd-changed', 'prompt-recall', 'stage-prompt', 'capture',
    'checkpoint', 'session-end', 'drain'].map((n) => `hooks/dist/${n}.mjs`);
  return [...hooks, 'bin/statusline.mjs'];
}

/** Every path Claude Code is registered to execute: the hooks, plus the status line. */
function registeredScripts() {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  /** @type {Set<string>} */
  const out = new Set();
  for (const group of Object.values(hooks.hooks ?? {})) {
    for (const matcher of /** @type {any[]} */ (group)) {
      for (const entry of matcher.hooks ?? []) {
        for (const arg of entry.args ?? []) {
          if (typeof arg === 'string' && arg.endsWith('.mjs')) {
            out.add(arg.replace('${CLAUDE_PLUGIN_ROOT}/', ''));
          }
        }
      }
    }
  }
  const settings = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'settings.json'), 'utf8'));
  for (const arg of settings.statusLine?.args ?? []) {
    if (typeof arg === 'string' && arg.endsWith('.mjs')) out.add(arg.replace('${CLAUDE_PLUGIN_ROOT}/', ''));
  }
  return [...out];
}

/**
 * Run a built script with `process.versions.node` faked, via a preload that rewrites it
 * before the module graph is evaluated.
 * @param {string} rel @param {string} version
 */
async function runAsNode(rel, version) {
  const dir = mkdtempSync(join(tmpdir(), 'mubit-floor-'));
  const preload = join(dir, 'fake-version.cjs');
  writeFileSync(preload,
    `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)}, configurable: true });\n`);

  const child = spawn(process.execPath, ['--require', preload, join(PLUGIN_ROOT, rel)],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MUBIT_CC_DATA_DIR: join(dir, 'data') } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.end('{}');

  const code = await new Promise((res, rej) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); rej(new Error(`${rel} never exited`)); }, 10_000);
    child.on('close', (c) => { clearTimeout(t); res(c); });
    child.on('error', rej);
  });
  return { code, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Property 1 — it parses on the old runtime
// ---------------------------------------------------------------------------

// The whole point. esbuild is the same parser the build uses, so "esbuild accepts this file at
// the floor target" is exactly "an interpreter at that version can read it". Note this must
// run against the BUILT file: the guarantee is about what ships, not about the template.
test('every guarded script parses at the engine floor', async () => {
  const { transform } = await import('esbuild');
  const scripts = guardedScripts();
  assert.equal(scripts.length, 9, 'the 8 hooks and the status line');

  for (const rel of scripts) {
    const abs = join(PLUGIN_ROOT, rel);
    assert.ok(existsSync(abs), `${rel} is registered but not built`);
    await assert.doesNotReject(
      () => transform(readFileSync(abs, 'utf8'), { target: FLOOR_TARGET, format: 'esm', loader: 'js' }),
      `${rel} does not parse at ${FLOOR_TARGET} — on an old Node it dies before any guard runs`,
    );
  }
});

// Belt and braces on the same property, in a form that survives someone swapping the parser:
// these three constructs are precisely what the original SyntaxError was made of.
test('no guarded script uses syntax newer than the floor', () => {
  for (const rel of guardedScripts()) {
    const src = readFileSync(join(PLUGIN_ROOT, rel), 'utf8');
    assert.ok(!/\?\?/.test(src), `${rel} contains ?? — Node 12 cannot parse it`);
    assert.ok(!/\?\./.test(src), `${rel} contains ?. — Node 12 cannot parse it`);
    assert.ok(!/^\s*await\s/m.test(src), `${rel} contains top-level await — Node 12 cannot parse it`);
  }
});

// A guard that protects a path nothing executes is decoration. This is the join between the
// two lists: whatever `hooks.json` and `settings.json` name must be a file that carries one.
test('every registered entry point is a guarded one', () => {
  for (const rel of registeredScripts()) {
    assert.ok(guardedScripts().includes(rel),
      `${rel} is registered but carries no runtime floor guard`);
  }
});

// ---------------------------------------------------------------------------
// Property 2 — having parsed, it refuses legibly
// ---------------------------------------------------------------------------

test('on an unsupported Node every hook refuses by name and exits 0', async () => {
  const hooks = guardedScripts().filter((s) => s.startsWith('hooks/'));
  assert.equal(hooks.length, 8);

  for (const rel of hooks) {
    const r = await runAsNode(rel, OLD_NODE);
    assert.equal(r.code, 0, `${rel} must exit 0 — a misconfigured runtime may not fail the session`);
    assert.match(r.stderr, /requires Node >= 20/, `${rel} must say why it refused`);
    assert.match(r.stderr, new RegExp(OLD_NODE.replace(/\./g, '\\.')), `${rel} must name the version it found`);
    // lib/hook.mjs: "stdout is ALWAYS a JSON object" — the refusal is not an excuse to break it.
    assert.doesNotThrow(() => JSON.parse(r.stdout.trim()), `${rel} wrote non-JSON to stdout: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout.trim()).suppressOutput, true);
  }
});

// The status line is not a hook: it writes a bare line, so silence is its correct no-op. It
// also runs on every UI frame, which makes an unguarded stack trace there the loudest possible
// version of this bug.
test('on an unsupported Node the status line refuses and prints nothing', async () => {
  const r = await runAsNode('bin/statusline.mjs', OLD_NODE);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /requires Node >= 20/);
  assert.equal(r.stdout, '', `the status line must print nothing, got ${JSON.stringify(r.stdout)}`);
});

// The guard must be a floor, not a wall: on a supported runtime it hands off silently and the
// real bundle does the work. Without this, "refuses on every version" would pass everything above.
test('on a supported Node the launcher hands off to the real bundle', async () => {
  const r = await runAsNode('hooks/dist/capture.mjs', process.versions.node);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stderr, /requires Node >= 20/, 'a supported runtime must not be refused');
});
