#!/usr/bin/env node
// @ts-check
/**
 * `labs/setup.mjs` — build the two directories every lab needs, and nothing else.
 *
 *   labs/.work/data      ${CLAUDE_PLUGIN_DATA} — the plugin's whole local state lives here
 *   labs/.work/demo-app  ${CLAUDE_PROJECT_DIR} — a real git repo, because the run id is
 *                        derived from `git rev-parse --show-toplevel`
 *
 *   node labs/setup.mjs            # create what is missing
 *   node labs/setup.mjs --reset    # delete labs/.work and start over
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAB_ROOT = dirname(fileURLToPath(import.meta.url));
const WORK = join(LAB_ROOT, '.work');
const DATA = join(WORK, 'data');
const PROJECT = join(WORK, 'demo-app');

if (process.argv.includes('--reset')) {
  rmSync(WORK, { recursive: true, force: true });
  say(`removed ${WORK}`);
}

// §7's state layout. The plugin creates these itself; pre-creating them just means the
// first `ls` after lab 1 shows the shape rather than one lonely directory.
for (const sub of ['sessions', 'runs', 'status', 'breaker', 'policy', 'logs', 'tmp']) {
  mkdirSync(join(DATA, sub), { recursive: true });
}
say(`data dir     ${DATA}`);

if (!existsSync(join(PROJECT, '.git'))) {
  mkdirSync(join(PROJECT, 'src'), { recursive: true });
  mkdirSync(join(PROJECT, 'build'), { recursive: true });

  writeFileSync(join(PROJECT, 'src', 'server.js'),
    "import { createServer } from 'node:http';\n\nexport const PORT = 3000;\n");
  writeFileSync(join(PROJECT, 'src', 'queue.js'),
    "export function enqueue(job) {\n  return { id: job.id, status: 'queued' };\n}\n");
  // Lab 4 reads this one. It is never captured — a redacted .env is still a map of which
  // secrets a project holds, so the denylist DROPS it rather than scrubbing it.
  writeFileSync(join(PROJECT, '.env'),
    'DATABASE_PASSWORD=hunter2\nSTRIPE_KEY=sk_live_notarealkey0123456789\n');
  writeFileSync(join(PROJECT, 'build', 'bundle.js'), '// generated\n');
  writeFileSync(join(PROJECT, '.gitignore'), 'build/\n.env\n');

  const git = (...args) => spawnSync('git', args, { cwd: PROJECT, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'lab@example.com');
  git('config', 'user.name', 'Lab');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-qm', 'demo app');
  say(`project dir  ${PROJECT} (git repo on ${branch()})`);
} else {
  say(`project dir  ${PROJECT} (already there, on ${branch()})`);
}

say('');
say('Next:  source labs/env.sh   (from the repo root)');

function branch() {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: PROJECT, encoding: 'utf8' });
  return (r.stdout ?? '').trim() || '(no branch)';
}
function say(s) { process.stdout.write(`${s}\n`); }
