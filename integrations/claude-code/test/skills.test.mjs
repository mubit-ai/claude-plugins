// @ts-check
/**
 * Skills and the subagent.
 *
 * A skill is markdown with YAML frontmatter, so it is testable as data. Two kinds of
 * assertion live here:
 *
 *   - Structural: every skill exists, the frontmatter parses, every `tools:` grant is
 *     fully qualified and names a tool that actually exists upstream. A malformed grant
 *     does not error at install time — it silently matches nothing.
 *   - Content guards: a handful of substring/regex checks over prose that protects real
 *     behaviour. Each one has a comment saying what goes wrong without it. These are not
 *     style checks; each guards a specific, observed failure mode.
 *
 * Frontmatter is parsed by a small local splitter — no YAML dependency, matching the
 * plugin's own zero-dependency rule.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PLUGIN_ROOT, lib } from './helpers/harness.mjs';

const SKILLS_DIR = join(PLUGIN_ROOT, 'skills');
const AGENTS_DIR = join(PLUGIN_ROOT, 'agents');

/**
 * The MCP server the plugin actually ships and runs. The tool table used to be parsed from
 * the upstream TypeScript, which is not part of the plugin: it sits outside `PLUGIN_ROOT`,
 * so an installed copy does not contain it and every assertion built on it failed in a
 * published checkout. The bundle is both present downstream and the thing whose tool names
 * a skill's `tools:` grant has to match at runtime — the stricter check, not just the
 * portable one. A grant can only resolve against what the running server registers.
 */
const SERVER_BUNDLE = join(PLUGIN_ROOT, 'mcp', 'dist', 'server.js');

/** §3.2 matcher note — `.mcp.json` names the server `mubit`. */
const QUALIFIED_PREFIX = 'mcp__plugin_mubit-memory_mubit__';

/**
 * §2/§9 — the skills the plugin ships, in the order they arrived. The first eight are the
 * original set. Of the rest, three grant an MCP tool that used to sit outside the default
 * allowlist — an allowlisted tool with nothing to invoke it is schema cost with no surface —
 * and `activity` runs a bundled script instead, the way `auth` and `dashboard` do.
 *
 * One name per line on purpose: four branches append to this list at once, and a single-line
 * array makes every one of those a conflict on the same line.
 */
const SKILLS = [
  'recall',
  'remember',
  'reflect',
  'forget',
  'doctor',
  'setup',
  'auth',
  'dashboard',
  'strategies',
  'checkpoint',
  'memory-health',
  'activity',
  'pin',
];

/**
 * The skills that call no MCP tool, and cannot.
 *
 * `auth` runs `bin/auth.mjs` to obtain a credential, which is precisely the thing that has to
 * exist before any MCP tool works. `dashboard` runs `bin/dashboard.mjs` and `activity` runs
 * `bin/activity.mjs`, both of which talk to the control API themselves — an MCP grant would be
 * a second, weaker path to the same data. `pin` runs `bin/pin.mjs` because the bundled server
 * registers twenty-one tools and not one of them touches variables, so there is no tool a
 * `tools:` grant could name. All four are skipped by name rather than by accident.
 */
const NO_MCP_SKILLS = ['auth', 'dashboard', 'activity', 'pin'];
const MCP_SKILLS = SKILLS.filter((s) => !NO_MCP_SKILLS.includes(s));

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function readOrFail(p, label, why) {
  if (!existsSync(p)) assert.fail(`${label} does not exist yet: ${p}\n  ${why}`);
  return readFileSync(p, 'utf8');
}

function unquote(s) {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function scalar(v) {
  const t = v.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith('[')) {
    try { return JSON.parse(t); } catch { /* fall through to a lenient split */ }
    return t.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean);
  }
  return unquote(t);
}

/**
 * Minimal `---` frontmatter splitter. Handles `key: value`, inline `[a, b]` lists and
 * block `- item` lists. That is the whole grammar these files use.
 * @returns {{fm: Record<string, any>, body: string}}
 */
function parseFrontmatter(text, label) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
  if (!m) assert.fail(`${label}: no YAML frontmatter block (a file must open with a --- fenced block)`);
  const body = text.slice(m[0].length);
  /** @type {Record<string, any>} */
  const fm = {};
  let lastKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && lastKey) {
      if (!Array.isArray(fm[lastKey])) fm[lastKey] = [];
      fm[lastKey].push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    lastKey = kv[1];
    fm[lastKey] = kv[2].trim() === '' ? [] : scalar(kv[2]);
  }
  return { fm, body };
}

/** Frontmatter `tools:` as a flat array, whatever spelling it used. */
function toolsOf(fm) {
  const t = fm.tools;
  if (t === undefined) return undefined;
  if (Array.isArray(t)) return t;
  return String(t).split(',').map((s) => unquote(s)).filter(Boolean);
}

function skillFile(name) {
  return join(SKILLS_DIR, name, 'SKILL.md');
}

function loadSkill(name) {
  const text = readOrFail(skillFile(name), `skills/${name}/SKILL.md`,
    `The plugin ships one skill each for: ${SKILLS.join(', ')}.`);
  return parseFrontmatter(text, `skills/${name}/SKILL.md`);
}

function loadAgent() {
  const p = join(AGENTS_DIR, 'mubit-recall.md');
  const text = readOrFail(p, 'agents/mubit-recall.md', 'The plugin ships a Haiku recall subagent at this path.');
  return parseFrontmatter(text, 'agents/mubit-recall.md');
}

/** The real MCP tool names, parsed from the server bundle the plugin ships. */
function realToolNames() {
  const src = readOrFail(SERVER_BUNDLE, 'mcp/dist/server.js',
    'The bundled MCP server (§1.9). Run `npm run build` — the plugin cannot start without it.');
  return [...src.matchAll(/name:\s*"(mubit_[a-z_0-9]+)"/g)].map((m) => m[1]);
}

/** Every skill + agent markdown file that exists, for the cross-cutting checks. */
function allMarkdown() {
  /** @type {Array<{rel: string, text: string}>} */
  const files = [];
  if (existsSync(SKILLS_DIR)) {
    for (const d of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = join(SKILLS_DIR, d.name, 'SKILL.md');
      if (existsSync(p)) files.push({ rel: `skills/${d.name}/SKILL.md`, text: readFileSync(p, 'utf8') });
    }
  }
  if (existsSync(AGENTS_DIR)) {
    for (const f of readdirSync(AGENTS_DIR)) {
      if (f.endsWith('.md')) files.push({ rel: `agents/${f}`, text: readFileSync(join(AGENTS_DIR, f), 'utf8') });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// §9 — structure
// ---------------------------------------------------------------------------

// §9 — every skill is namespaced /mubit-memory:<skill>. The frontmatter `name` is the
// invocation name; if it disagrees with the directory the skill is unreachable by the
// name the docs give it.
for (const name of SKILLS) {
  test(`skills/${name}/SKILL.md exists with a name matching its directory and a real description`, () => {
    const { fm } = loadSkill(name);
    assert.equal(fm.name, name,
      `skills/${name}/SKILL.md frontmatter name is ${JSON.stringify(fm.name)} — it must match the directory (§9)`);
    assert.equal(typeof fm.description, 'string', `skills/${name}: description must be a string`);
    assert.ok(String(fm.description).trim().length >= 40,
      `skills/${name}: description is what the model reads when deciding whether to invoke the skill; ` +
      'it is always loaded and counts against contextCost (§3.5), so it must actually describe the trigger');
  });
}

// §2/§9 — exactly this set. An extra skill is extra always-loaded context that §3.5's
// contextCost estimate does not account for.
test('exactly the documented skills ship — no more, no fewer', () => {
  assert.ok(existsSync(SKILLS_DIR), `skills/ does not exist yet: ${SKILLS_DIR}`);
  const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual(dirs, [...SKILLS].sort(),
    'the plugin ships exactly this skill set (§2 file tree); contextCost in marketplace.json is sized for it');
});

// §9.4 — Haiku with maxTurns 3 is the right shape: the work is retrieval and
// summarisation. An unbounded loop against a memory tool is how you get twenty queries.
test('agents/mubit-recall.md is a bounded Haiku subagent (model, effort, maxTurns, tools)', () => {
  const { fm } = loadAgent();
  assert.equal(fm.name, 'mubit-recall', 'agent name must be mubit-recall (§9.4)');
  assert.equal(fm.model, 'haiku', 'the recall subagent runs on haiku (§9.4) — retrieval and summarisation, not reasoning');
  assert.equal(fm.effort, 'low', 'effort: low (§9.4)');
  assert.equal(fm.maxTurns, 3,
    'maxTurns must be 3 (§9.4) — an unbounded loop against a memory tool is how you get twenty queries');
  const tools = toolsOf(fm);
  assert.ok(Array.isArray(tools) && tools.length > 0,
    'the agent must declare an explicit tools list (§9.4); an unrestricted subagent can do far more than search memory');
});

// §9.4 — "Plugin agents cannot declare hooks, mcpServers, or permissionMode." Declaring
// one is not an error the host reports; it is silently ignored, so the file reads as
// though it grants something it does not.
test('agents/mubit-recall.md declares none of hooks, mcpServers, permissionMode', () => {
  const { fm } = loadAgent();
  for (const forbidden of ['hooks', 'mcpServers', 'permissionMode']) {
    assert.ok(!(forbidden in fm),
      `agents/mubit-recall.md declares "${forbidden}" — plugin agents cannot declare it (§9.4); it will be silently ignored`);
  }
});

// §3.2 matcher note ("will bite you") — a bare `mcp__<server>__<tool>` grant does not
// match a plugin-provided server, so the skill loses the tool it was written around.
test('every tools: entry across skills and agents is fully qualified', () => {
  const files = allMarkdown();
  assert.ok(files.length > 0, `no skills or agents exist yet under ${PLUGIN_ROOT}`);

  let granted = 0;
  for (const { rel, text } of files) {
    const { fm } = parseFrontmatter(text, rel);
    const tools = toolsOf(fm);
    if (tools === undefined) continue;
    for (const t of tools) {
      granted++;
      assert.ok(t.startsWith(QUALIFIED_PREFIX),
        `${rel}: tools entry ${JSON.stringify(t)} must use the ${QUALIFIED_PREFIX} prefix — ` +
        'bare mcp__<server>__<tool> does not match a plugin-provided server (§3.2)');
    }
  }
  assert.ok(granted > 0, 'no skill or agent granted any MCP tool — at least recall/remember/forget need them (§9)');
});

// §12.7 — the rename trap: an MCP tool renamed upstream silently drops out of every
// skill that referenced it, and the skill stops working with no error anywhere.
test('every tool named by a skill or agent exists in the bundled MCP server', () => {
  const real = new Set(realToolNames());
  assert.ok(real.size > 0, 'parsed no tool names from mcp/dist/server.js');

  const files = allMarkdown();
  assert.ok(files.length > 0,
    `no skills or agents exist yet under ${PLUGIN_ROOT} — this check would otherwise pass vacuously`);

  for (const { rel, text } of files) {
    const tools = toolsOf(parseFrontmatter(text, rel).fm) ?? [];
    for (const t of tools) {
      const bare = t.replace(QUALIFIED_PREFIX, '');
      assert.ok(real.has(bare),
        `${rel}: grants "${bare}", which does not exist upstream. Real tools: ${[...real].join(', ')}`);
    }
  }
});

// ---------------------------------------------------------------------------
// §9 — content guards
// ---------------------------------------------------------------------------

// §9.1 — the anti-fan-out paragraph is not stylistic. Without it a model treats a memory
// tool the way it treats grep and issues six queries at ~0.6s each, for a question the
// injected context already answered.
test('recall/SKILL.md carries the anti-fan-out guidance', () => {
  const { body } = loadSkill('recall');
  assert.match(body, /\bone\b[\s\S]{0,60}\b(broad|mubit_recall)\b/i,
    'recall must instruct one broad call, not several narrow ones (§9.1)');
  assert.match(body, /two calls[\s\S]{0,40}ceiling/i,
    'recall must state that two calls is the ceiling (§9.1)');
  assert.match(body, /never fan out|do not fan out|fan-out/i,
    'recall must forbid fanning out across sub-topics (§9.1)');
  assert.match(body, /parallel/i,
    'recall must name parallel sub-topic searches as the thing not to do (§9.1)');
  // The injected context is the reason most invocations are unnecessary at all.
  assert.match(body, /already[\s\S]{0,20}inject/i,
    'recall must say memory was already injected this turn, so the model reads before searching (§9.1)');
});

// §1.5/§9.2 — ingest returns when the write is QUEUED, not stored. Without this warning
// the model saves a lesson, immediately searches for it, finds nothing, and concludes
// memory is broken.
test('remember/SKILL.md warns that mubit_learned returns when the write is queued, not stored', () => {
  const { body } = loadSkill('remember');
  assert.match(body, /queued/i, 'remember must say the write is queued (§9.2)');
  assert.match(body, /not stored|not[\s\S]{0,20}\bstored\b/i,
    'remember must say queued is NOT stored (§9.2)');
  assert.match(body, /do not|don't/i,
    'remember must tell the model not to immediately search for what it just saved (§9.2)');
});

// §1.4/§9.3 — Mubit extracts lessons on its own as it ingests, but those keep the scope they
// were extracted at. Only the explicit reflect path widens scope, which is the entire reason
// this skill (and reflectOnEnd) exist. Without that paragraph the model sees lessons
// accumulating and concludes the explicit call is redundant.
//
// This pins the consequence, not the mechanism. It used to require the skill to name a
// server-side flag verbatim — a term that is in neither the proto nor the public docs, so the
// assertion forced an internal identifier into a shipped file and would have kept forcing it
// back after any scrub. What a user can act on is the scope gap.
test('reflect/SKILL.md explains that background extraction never widens scope', () => {
  const { body } = loadSkill('reflect');
  assert.match(body, /\brun\b[\s\S]{0,120}\bscope\b|\bscope\b[\s\S]{0,120}\brun\b/i,
    'reflect must say that background-extracted lessons stay at run scope (§1.4)');
  assert.match(body, /invisible to the next session|not visible|next session/i,
    'reflect must state the consequence: a run-scoped lesson does not reach the next session (§1.4)');
  assert.match(body, /only[\s\S]{0,80}explicit|explicit[\s\S]{0,80}(widen|promot|reserved)/i,
    'reflect must say that only the explicit path widens a lesson\'s scope (§1.4)');
});

// The published plugin describes a hosted instance and nothing else. Self-hosting is not a
// documented path.
//
// This asserts what setup MUST contain rather than listing components it must not name. A
// denylist of backend nouns has to spell out the internals in order to forbid them, which
// makes the guard itself the disclosure once it ships — and it only ever catches the terms
// someone thought to enumerate. Pinning the whole configuration story to two hosted settings
// leaves no room for a local-stack walkthrough to be correct, without naming one.
// The denylist itself lives outside this repository, where enumerating the terms is not
// itself the disclosure.
test('setup/SKILL.md configures a hosted instance in two settings, and installs nothing', () => {
  const { body } = loadSkill('setup');
  assert.match(body, /endpoint/i, 'setup must tell the user to set an endpoint');
  assert.match(body, /mbt_|api\s*key/i, 'setup must tell the user to set an API key');
  assert.match(body, /never\s+(attempt\s+to\s+)?install|do not install|don't install/i,
    'setup must state that it never installs anything — a memory plugin running installers is a trust failure (§9.3)');

  // Where the two settings come from, and how they get set: a Mubit account reached through
  // `/mubit-memory:auth` or the `/plugin` config UI. If setup ever grows a third path, it has
  // to come from somewhere other than a hosted account, and this stops being true.
  assert.match(body, /\/mubit-memory:auth|\/plugin\b/,
    'setup must route the user through `/mubit-memory:auth` or the `/plugin` config UI — those are '
    + 'the only two ways the plugin accepts configuration');
  assert.match(body, /console\.mubit\.ai|mubit\.ai|account|sign\s*[- ]?\s*(in|up)/i,
    'setup must say where an API key comes from: a Mubit account, not a component the user runs');
});

// §9.3/§4.7 — each ConnState has a distinct fix, so doctor reports the typed state
// verbatim instead of paraphrasing it into "something went wrong".
test('doctor/SKILL.md names all five typed connection states verbatim', () => {
  const { body } = loadSkill('doctor');
  for (const state of ['ready', 'unreachable', 'server_error', 'auth_failed', 'not_responding']) {
    assert.ok(body.includes(state),
      `doctor/SKILL.md must report the typed ConnState "${state}" verbatim — each has a distinct fix (§4.7, §9.3)`);
  }
});

// §9.3 — forget deletes irreversibly, and a *wrong* lesson is usually better handled with
// a negative mubit_outcome, which the promotion pipeline acts on.
test('forget/SKILL.md warns that deletion is not undoable and offers mubit_outcome instead', () => {
  const { body } = loadSkill('forget');
  assert.match(body, /not undoable|cannot be undone|irreversible|no undo/i,
    'forget must warn that deletion is not undoable (§9.3)');
  assert.match(body, /mubit_outcome/,
    'forget must point at mubit_outcome as the better tool for a wrong (rather than unwanted) lesson (§9.3)');
});

// ---------------------------------------------------------------------------
// §9 — auth
// ---------------------------------------------------------------------------

/**
 * `auth` runs a bundled script instead of calling an MCP tool, so its permission grant
 * is `allowed-tools`, not `tools`. Without a grant the host prompts for approval on
 * every run, which is a poor first impression from the command whose entire job is to
 * make the first five minutes work.
 */
test('auth/SKILL.md grants exactly the Bash permission it needs, and no MCP tools', () => {
  const { fm } = loadSkill('auth');

  const allowed = fm['allowed-tools'];
  assert.ok(allowed, 'auth must declare allowed-tools so the host does not prompt on every run');
  const text = Array.isArray(allowed) ? allowed.join(' ') : String(allowed);

  assert.match(text, /Bash\(/, 'the grant is a Bash permission rule');
  assert.match(text, /bin\/auth\.mjs/,
    'the rule must name the script; a bare Bash grant hands the skill the whole shell');
  assert.match(text, /\$\{CLAUDE_PLUGIN_ROOT\}/,
    'the plugin is installed at a path nobody can predict — a relative path resolves to the wrong place');

  assert.equal(toolsOf(fm), undefined,
    'auth exists to create the credential every MCP tool needs; it cannot depend on one');
});

// The credential has to exist before anything else works, so this is the one skill a
// user runs when nothing is configured. It must be reachable by name at that point.
test('auth/SKILL.md is user-invocable', () => {
  const { fm } = loadSkill('auth');
  assert.notEqual(fm['disable-model-invocation'], true,
    'a user typing /mubit-memory:auth must reach it');
});

/**
 * The §9.3 trust rule, which `setup` states and `auth` now has more reason to: this is
 * the skill that talks to a browser and writes a credential, and it is exactly where a
 * "helpfully" installed package would be hardest to notice.
 */
test('auth/SKILL.md says it never installs anything', () => {
  const { body } = loadSkill('auth');
  assert.match(body, /never\s+(attempt\s+to\s+)?install|do not install|don't install/i,
    'a memory plugin running installers is a trust failure (§9.3)');
});

// §12.1: the three outcomes have different fixes, and the exit codes exist so the skill
// can tell them apart without parsing prose.
test('auth/SKILL.md maps the exit codes to what the user should do', () => {
  const { body } = loadSkill('auth');
  assert.match(body, /provisioning/i, 'exit 2 means wait and re-run, not "something is broken"');
  assert.match(body, /MUBIT_AUTH_KEY/,
    'the manual fallback must be documented where the user hits the failure');
});

// The counter-intuitive fact that generates the most "it did not work" reports, already
// pinned for setup: the reload does not start a session.
test('auth/SKILL.md warns that /reload-plugins does not fire SessionStart', () => {
  const { body } = loadSkill('auth');
  assert.match(body, /reload-plugins/,
    'authenticating mid-session leaves no run id until a new session starts (§9.3)');
  assert.match(body, /SessionStart/,
    'naming the event is what makes the advice checkable rather than folklore');
});

// The whole reason the browser flow exists: a key pasted into the conversation is in the
// transcript forever, and transcripts get shared.
test('auth/SKILL.md prefers the browser flow and says why', () => {
  const { body } = loadSkill('auth');
  assert.match(body, /browser/i);
  assert.match(body, /transcript|conversation|paste/i,
    'the skill must say why the browser route is preferred, or the model will pick either');
});

/**
 * The command line has to fall back the way the runtime does: env pin first, host
 * interpolation second.
 *
 * Every hook, the MCP launcher and the auth binary's own resolver all read
 * `MUBIT_CC_DATA_DIR` before `CLAUDE_PLUGIN_DATA` — and the `--data-dir` flag outranks
 * both. So a skill that hard-passes `--data-dir "${CLAUDE_PLUGIN_DATA}"` defeats an
 * env-pinned data dir on exactly the machines that pin one: the sign-in reports success
 * and writes the key where no hook will ever read it. Observed live as the launcher
 * split-brain — the harness pinned `MUBIT_CC_DATA_DIR`, auth wrote elsewhere, and every
 * later session was unauthenticated.
 *
 * `${CLAUDE_PLUGIN_DATA}` is interpolated by the host *inside* the shell default, so the
 * fixed spelling degrades exactly as before on machines with nothing pinned.
 */
test('auth/SKILL.md lets an env-pinned MUBIT_CC_DATA_DIR outrank the host interpolation', () => {
  const { body } = loadSkill('auth');
  const flags = [...body.matchAll(/--data-dir\s+("[^"]*")/g)].map((m) => m[1]);
  assert.ok(flags.length >= 3,
    `every auth command in the skill carries --data-dir; found only ${flags.length}`);
  for (const flag of flags) {
    assert.equal(flag, '"${MUBIT_CC_DATA_DIR:-${CLAUDE_PLUGIN_DATA}}"',
      `--data-dir ${flag} hard-pins the host interpolation; a set MUBIT_CC_DATA_DIR must win, `
      + 'the way it does for every hook and the MCP launcher');
  }
});

// ---------------------------------------------------------------------------
// §9 — dashboard
// ---------------------------------------------------------------------------

/**
 * Like `auth`, this skill runs a bundled script rather than calling an MCP tool, so its grant
 * is `allowed-tools` (a Bash permission rule) and not `tools` (the MCP grant). The two are
 * easy to confuse and the failure is silent: a `tools:` entry naming a Bash command matches
 * nothing, and the host then prompts for approval on every run.
 */
test('dashboard/SKILL.md grants exactly the Bash permission it needs, and no MCP tools', () => {
  const { fm } = loadSkill('dashboard');

  const allowed = fm['allowed-tools'];
  assert.ok(allowed, 'dashboard must declare allowed-tools so the host does not prompt on every run');
  const text = Array.isArray(allowed) ? allowed.join(' ') : String(allowed);

  assert.match(text, /Bash\(/, 'the grant is a Bash permission rule');
  assert.match(text, /bin\/dashboard\.mjs/, 'the rule must name the script, not hand the skill a shell');
  assert.match(text, /\$\{CLAUDE_PLUGIN_ROOT\}/,
    'the plugin is installed at a path nobody can predict — a relative path resolves elsewhere');

  assert.equal(toolsOf(fm), undefined,
    'the dashboard proxies the control API itself; an MCP grant would be a second, weaker path to it');
});

/**
 * The one skill in the set that the model may not invoke.
 *
 * Opening a web page is a thing a person decides to do. It is also what makes this skill free:
 * a `disable-model-invocation: true` skill's description is not loaded into context, so the
 * eighth skill costs nothing until somebody types it.
 */
test('dashboard/SKILL.md is user-invocable but never model-invocable', () => {
  const { fm } = loadSkill('dashboard');
  assert.equal(fm['disable-model-invocation'], true,
    'nothing in a conversation should decide on its own to open a browser window');
});

// The three facts a user will otherwise misread off the page. Each one is a number that looks
// authoritative and is not, and the skill is where the model learns to say so.
test('dashboard/SKILL.md states what the page cannot measure', () => {
  const { body } = loadSkill('dashboard');
  assert.match(body, /no per-prompt latency|not recorded|last-write-wins/i,
    'per-prompt latency is not recorded anywhere; the skill must say so rather than let the absence read as a gap');
  assert.match(body, /not measurable|never "not used"|proxy/i,
    'a blank in the used column is unmeasurable, not unused — the false negatives dominate');
  assert.match(body, /pruned|starts empty|cannot reconstruct/i,
    'the rollup accrues from first launch; a sparse first session is by construction, not a fault');
});

// The posture is the reason this is safe to ship, and the model is what a user asks about it.
test('dashboard/SKILL.md states the loopback bind, the token and the key boundary', () => {
  const { body } = loadSkill('dashboard');
  assert.match(body, /127\.0\.0\.1/, 'the bind address is the whole network story');
  assert.match(body, /token/i, 'every request needs one');
  assert.match(body, /never leaves|proxied/i, 'the API key does not reach the browser');
  assert.match(body, /never\s+(attempt\s+to\s+)?install|do not install|don't install/i,
    'a memory plugin running installers is a trust failure (§9.3)');
});

// §9.3 — setup is the diagnostic; auth is the fix. Setup pointing at the console alone
// leaves the user doing seven manual steps the plugin can do for them.
test('setup/SKILL.md sends the user to /mubit-memory:auth', () => {
  const { body } = loadSkill('setup');
  assert.match(body, /\/mubit-memory:auth/,
    'setup diagnoses; auth fixes. Setup must name it (§9.3)');
});

// §9.2 — what `mubit_learned` actually writes.
//
// This paragraph was true and is now false. The bundled SDK hard-codes
// `lesson_scope: "session"`, and the control plane reads every scope but `run` across runs —
// so the skill was telling the model that a saved lesson "stays with related sessions" while
// it was in fact reaching every other run on the instance. The MCP egress guard clamps it to
// `run`; the skill has to say the same thing, because this paragraph is the model's only
// account of where its lesson went.
//
// Asserted on the paragraph rather than the file: the template table two sections up
// legitimately contains the word `session` for DEBUG_SUCCESS and API_PATTERN.
test('remember/SKILL.md states the scope mubit_learned actually writes', () => {
  const { body } = loadSkill('remember');
  const para = body
    .split(/\n\s*\n/)
    .find((p) => /mubit_learned/.test(p) && /\bwrit/i.test(p) && /\bscope\b|`run`|`session`/.test(p));

  assert.ok(para,
    'remember/SKILL.md no longer has a paragraph saying what scope mubit_learned writes at — '
    + 'that sentence is the model\'s only account of where its lesson went (§9.2)');

  // The scope is a setting, not a constant, and the paragraph has to say so: naming one value
  // as if it were fixed is how this sentence went stale the last time. It must name the
  // setting, state the default, and say what the other values do.
  assert.match(para, /mcpLessonScope|MUBIT_MCP_LESSON_SCOPE/,
    `the scope is whatever the ceiling is set to, and the paragraph must say which setting '
    + 'that is. Paragraph:\n${para}`);
  assert.match(para, /`session`/,
    `remember/SKILL.md must state the default the model's write will actually get. `
    + `Paragraph:\n${para}`);
  assert.match(para, /`run`/,
    `remember/SKILL.md must say what a ceiling of run does — it is the setting a user who `
    + `wants per-run isolation reaches for. Paragraph:\n${para}`);
});

/**
 * "Lessons never reach another session" is a scope question wearing a connectivity costume:
 * every step of the doctor's ladder comes back clean while a `run` ceiling is the whole
 * cause. At the shipped default the tool result no longer carries a clamp note either — the
 * write is not clamped — so this skill is the surface that has to name the setting.
 */
test('doctor/SKILL.md routes a cross-session lesson complaint at the scope ceiling', () => {
  const { body } = loadSkill('doctor');

  assert.match(body, /mcpLessonScope|MUBIT_MCP_LESSON_SCOPE/,
    'doctor/SKILL.md does not name the setting that decides whether a written lesson can '
    + 'ever leave the run that wrote it');
  assert.match(body, /scope-audit/,
    'doctor/SKILL.md does not point at the audit that answers "what is actually stored, by '
    + 'scope" — without it the step is advice with no measurement behind it');
});

// A ceiling with no documented way to raise it reads as a limitation rather than a setting,
// and the next person to want a cross-project rule reaches for `mubit_remember` instead —
// which is exactly the tool that leaked in the first place.
test('remember/SKILL.md names the setting that widens what an agent may write', () => {
  const { body } = loadSkill('remember');
  assert.match(body, /mcpLessonScope|MUBIT_MCP_LESSON_SCOPE/,
    'remember/SKILL.md does not name the setting that raises the scope ceiling (§6.2)');
});

// ---------------------------------------------------------------------------
// §9 — the three skills that carry a promoted tool
// ---------------------------------------------------------------------------

/**
 * Each of these three exists so that a tool promoted into the default allowlist has somewhere
 * to be invoked from. That makes one sentence in each of them load-bearing: the sentence that
 * separates the new tool from the neighbour it will otherwise be confused with. Without it the
 * skill is a second, vaguer route to a tool the model already had, and the promotion has
 * bought a schema in every session for nothing.
 */

// The tool's own description says it clusters lessons and to "prefer mubit_lessons to read the
// individual lessons themselves". A skill that only says "finds patterns" sends the model here
// for single-lesson questions, which is the one thing it answers badly.
test('strategies/SKILL.md separates the pattern from the lessons it is a pattern over', () => {
  const { body } = loadSkill('strategies');
  assert.match(body, /across/i,
    'strategies must say the answer is a pattern *across* lessons, not one of them (§9)');
  assert.match(body, /mubit_lessons/,
    'strategies must name mubit_lessons as the tool that reads the individual lessons — '
    + 'the two are near-synonyms until one of them says so');
});

// `snapshot` is stored byte-for-byte with nothing extracting from it, so a model that writes a
// headline has written a checkpoint that restores nothing.
test('checkpoint/SKILL.md says the snapshot is stored verbatim, and is run state not knowledge', () => {
  const { body } = loadSkill('checkpoint');
  assert.match(body, /verbatim/i, 'checkpoint must say the snapshot is stored verbatim (§9)');
  assert.match(body, /unsummaris|unsummariz|not summaris|not summariz/i,
    'checkpoint must say nothing summarises it — a one-line snapshot restores nothing');
  assert.match(body, /run state, not knowledge/i,
    'checkpoint must draw the line in those words: a checkpoint is run state, not knowledge');
  assert.match(body, /\/mubit-memory:remember/,
    'checkpoint must send knowledge to /mubit-memory:remember, or the two writes get swapped '
    + 'and memory fills with state that expires');
});

// The split this skill exists to state. Both tools fail as "memory is not working" and their
// fixes are opposites: an empty store behind a healthy connection and a full store behind a
// dead endpoint look identical from the status line.
test('memory-health/SKILL.md states the store/connection split against mubit_status', () => {
  const { body } = loadSkill('memory-health');
  assert.match(body, /mubit_status/,
    'memory-health must name mubit_status — it is the tool it will be confused with (§9)');
  assert.match(body, /store/i, 'memory-health must say it inspects the store');
  assert.match(body, /connection/i,
    'memory-health must say mubit_status inspects the connection; without the second half the '
    + 'first half is not a distinction');
});

// ---------------------------------------------------------------------------
// §9 — activity
// ---------------------------------------------------------------------------

/**
 * Like `auth` and `dashboard`, this skill runs a bundled script rather than calling an MCP
 * tool, so its grant is `allowed-tools` (a Bash permission rule) and not `tools` (the MCP
 * grant). A `tools:` entry naming a Bash command matches nothing and fails silently, and the
 * host then prompts for approval on every run.
 */
test('activity/SKILL.md grants exactly the Bash permission it needs, and no MCP tools', () => {
  const { fm } = loadSkill('activity');

  const allowed = fm['allowed-tools'];
  assert.ok(allowed, 'activity must declare allowed-tools so the host does not prompt on every run');
  const text = Array.isArray(allowed) ? allowed.join(' ') : String(allowed);

  assert.match(text, /Bash\(/, 'the grant is a Bash permission rule');
  assert.match(text, /bin\/activity\.mjs/, 'the rule must name the script, not hand the skill a shell');
  assert.match(text, /\$\{CLAUDE_PLUGIN_ROOT\}/,
    'the plugin is installed at a path nobody can predict — a relative path resolves elsewhere');

  assert.equal(toolsOf(fm), undefined,
    'the command talks to the control API itself; an MCP grant would be a second, weaker path to it');
});

/**
 * The second skill in the set the model may not invoke, for the same two reasons as the first.
 *
 * Pulling a copy of everything an instance holds into a transcript is a thing a person decides
 * to do. It is also what makes this skill free: a `disable-model-invocation: true` skill's
 * description is not loaded into context, so it costs nothing until somebody types it — and
 * `/mubit-memory:doctor` already owns the cheaper, model-facing "is capture working" question.
 */
test('activity/SKILL.md is user-invocable but never model-invocable', () => {
  const { fm } = loadSkill('activity');
  assert.equal(fm['disable-model-invocation'], true,
    'nothing in a conversation should decide on its own to export somebody\'s memory');
});

/**
 * The guard that matters most, because without it the model will describe an export as
 * "filtered activity" — the exact false claim the module's design exists to prevent.
 *
 * `/v2/control/activity/export` accepts neither `exclude_derived` nor `projection`. An export
 * is therefore always everything in scope, and a user who asked for "an export of my
 * non-derived entries" is asking for two different operations. A skill that blurs the two
 * produces a reply asserting a filter that never ran.
 */
test('activity/SKILL.md keeps the listing and the export distinguishable', () => {
  const { body } = loadSkill('activity');
  assert.match(body, /never filtered|not filtered|accepts no `?exclude_derived/i,
    'the skill must say outright that an export carries no filter');
  assert.match(body, /verbatim|byte for byte/i,
    'and that its content is what the instance holds rather than something this client shaped');
  assert.match(body, /never describe an export as/i,
    'the instruction has to be an instruction, not an implication — this is the sentence that '
    + 'stops "here is your filtered export"');
});

/**
 * Writing a file is the only irreversible thing this command does, and the model is what
 * decides whether it happens.
 */
test('activity/SKILL.md forbids --out unless the user asked for a file, and requires naming the path', () => {
  const { body } = loadSkill('activity');
  assert.match(body, /Do not pass `--out` unless/i,
    'an export is a complete copy of somebody\'s memory; creating one is their decision');
  assert.match(body, /absolute path/i,
    'a file the user cannot find is a file they cannot delete — the reply has to name it');
  assert.match(body, /refuses to overwrite/i, 'the second run of this command is the first one again');
  assert.match(body, /data dir/i,
    'an export inside the data dir sits outside the TTL sweep and is never mentioned again');
});

/**
 * The corrections are worth nothing if they stop at the terminal. When the instance ignores a
 * filter, that fact is the finding — and the model is the thing that decides whether the user
 * ever hears it.
 */
test('activity/SKILL.md tells the model to relay the findings rather than summarise them away', () => {
  const { body } = loadSkill('activity');
  assert.match(body, /did not honour/i,
    'the skill must name the "the instance ignored this" line as something to pass on');
  assert.match(body, /incomplete|prefix/i,
    'a truncated scan reported as a complete answer is the same lie as an unhonoured filter');
  assert.match(body, /Relay|rather than summaris/i,
    'the model\'s default is to compress a note out of existence; this is what stops it');
});

// `scripts/mubit-inspect.mjs` is not in `files` and is not shipped: it carries untested copies
// of data-dir discovery and the marker/turn join that `lib/dashboard-data.mjs` now owns with
// tests behind it, and its HTTP paths have neither breaker discipline nor a deadline. The
// question it answers — per-prompt cost — is real, so the skill has to route the reader at the
// surface that does ship it rather than leaving a gap somebody fills with the unshipped script.
test('activity/SKILL.md routes the per-prompt question at the dashboard, not at a script that does not ship', () => {
  const { body } = loadSkill('activity');
  assert.match(body, /Turns/,
    'per-prompt cost lives in the dashboard\'s Turns tab; this skill cannot answer it');
  assert.ok(!body.includes('mubit-inspect'),
    'mubit-inspect.mjs is not in package.json `files` — naming it sends a user to a path that '
    + 'does not exist in an installed plugin');
});

// ---------------------------------------------------------------------------
// §9 — pin
// ---------------------------------------------------------------------------

/**
 * Like `auth` and `dashboard`, this skill runs a bundled script rather than calling an MCP
 * tool — and here that is not a choice. The bundled server registers twenty-one tools and not
 * one of them touches variables, so there is no tool a `tools:` grant could name.
 */
test('pin/SKILL.md grants exactly the Bash permission it needs, and no MCP tools', () => {
  const { fm } = loadSkill('pin');

  const allowed = fm['allowed-tools'];
  assert.ok(allowed, 'pin must declare allowed-tools so the host does not prompt on every run');
  const text = Array.isArray(allowed) ? allowed.join(' ') : String(allowed);

  assert.match(text, /Bash\(/, 'the grant is a Bash permission rule');
  assert.match(text, /bin\/pin\.mjs/, 'the rule must name the script, not hand the skill a shell');
  assert.match(text, /\$\{CLAUDE_PLUGIN_ROOT\}/,
    'the plugin is installed at a path nobody can predict — a relative path resolves elsewhere');

  assert.equal(toolsOf(fm), undefined,
    'there is no variables tool in the bundled server; a tools: entry here would name nothing');
});

/**
 * **The one thing this skill exists to do, and the one it can get wrong.**
 *
 * Unlike `dashboard`, `pin` is model-invocable — deliberately. When the user says "for the
 * rest of this, don't touch the vendored server", the model is who notices, and if it cannot
 * reach `pin` it writes a *lesson* instead: a durable, cross-session claim about a project
 * where the sentence stops being true the moment the task ends. That is the exact failure this
 * skill was built to remove, so the description has to draw the line hard enough that a model
 * choosing between the two commands chooses correctly from the description alone.
 */
test('pin/SKILL.md is model-invocable and draws the line against remember', () => {
  const { fm, body } = loadSkill('pin');

  assert.notEqual(fm['disable-model-invocation'], true,
    'the model is who notices a standing constraint; a user-only skill would never be reached '
    + 'in the moment that matters, and a lesson would be written instead');

  const description = String(fm.description ?? '');
  assert.match(description, /run\b/i,
    'the description must say a pin is scoped to this run — that is the whole distinction');
  assert.match(description, /remember/,
    'the description is where a model chooses between the two commands, so it has to name the '
    + 'other one; without it a durable lesson gets written as a pin, or worse, the reverse');

  assert.match(body, /cross-session|every future session/i,
    'the body must say what a lesson is, or "durable" is an adjective with no consequence');
  assert.match(body, /\bclear/i,
    'a pin that outlives its task spends tokens enforcing a rule that is no longer true');
});

// The caps are refusals a user will hit, and a refusal with no reason reads as a bug. The
// reason is specific and is the whole argument for the feature being cheap.
test('pin/SKILL.md states the caps and why a pin is expensive', () => {
  const { body } = loadSkill('pin');
  assert.match(body, /\b5\b|\bfive\b/i, 'the pin count cap must be stated');
  assert.match(body, /200/, 'the per-pin character cap must be stated');
  assert.match(body, /every prompt|each prompt/i,
    'a pin is paid in full on every prompt — that is why the caps are tight, and a cap with no '
    + 'reason gets worked around by shortening the user\'s words');
});

// §9.3 — the trust rule every script-running skill states.
test('pin/SKILL.md says it never installs anything, and is not a permission boundary', () => {
  const { body } = loadSkill('pin');
  assert.match(body, /never\s+(attempt\s+to\s+)?install|do not install|don't install/i,
    'a memory plugin running installers is a trust failure (§9.3)');
  assert.match(body, /permission/i,
    'a pin is text in front of the model, not a boundary — a user who reads it as one will '
    + 'stop using the permission system for something that actually has to hold');
});

// ---------------------------------------------------------------------------
// Host shell pre-execution
// ---------------------------------------------------------------------------

/**
 * The host expands shell patterns inside a skill body *before the model reads it*, and runs
 * whatever it finds from the user's cwd. Two forms are scanned, mirrored here from the host's
 * own matcher:
 *
 *   ```!            a fenced block whose info string is a bare `!`
 *   !`cmd`          at a line start or after whitespace
 *
 * Inline `code` spans are blanked before the second regex runs, which is why an ordinary
 * backticked command is safe. A **fenced** block is not blanked and is therefore not an
 * escape — a worked example of the form inside ```markdown fences still fires.
 *
 * `setup` shipped exactly that: a template for a personal `/dashboard` alias containing
 * !-backtick plus the placeholder `<the absolute path to bin/dashboard.mjs>`. Every
 * `/mubit-memory:setup` ran the placeholder as a command and the skill died on
 * MODULE_NOT_FOUND before it could check anybody's credentials.
 */
const HOST_SHELL_PATTERNS = [
  { name: 'a ```! fenced block', re: /```!\s*\n?([\s\S]*?)\n?```/g },
  { name: 'the !-backtick form', re: /(?<=^|\s)!`([^`]+)`/gm },
];

/** The host blanks inline `code` spans before scanning for the !-backtick form. */
function blankInlineCode(text) {
  return text.replace(/`[^`\n]+`/g, (span, at) => {
    const before = text[at - 1];
    return before === '!' || before === '`' ? span : `\`${' '.repeat(span.length - 2)}\``;
  });
}

function hostShellCommands(text) {
  const found = [];
  for (const { name, re } of HOST_SHELL_PATTERNS) {
    const scanned = re.source.startsWith('```') ? text : blankInlineCode(text);
    for (const m of scanned.matchAll(re)) {
      const command = m[1]?.trim();
      if (command) found.push(`${name}: ${command}`);
    }
  }
  return found;
}

test('no skill or agent body carries a shell command the host pre-executes', () => {
  const files = [
    ...SKILLS.map((name) => [`skills/${name}/SKILL.md`, join(SKILLS_DIR, name, 'SKILL.md')]),
    ...readdirSync(AGENTS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => [`agents/${f}`, join(AGENTS_DIR, f)]),
  ];

  for (const [label, path] of files) {
    const found = hostShellCommands(readFileSync(path, 'utf8'));
    assert.deepEqual(found, [],
      `${label} contains a pattern the host runs before the skill is read:\n`
      + found.map((f) => `    ${f}`).join('\n')
      + '\n  Document a command as an inline `code` span or a ```bash block instead. Those are '
      + 'never executed. A ```markdown fence is not an escape.');
  }
});

// The alias this skill offers to write is the one place the plugin hands somebody a file
// containing a command line, so it is the one place the pattern could come back.
test('setup/SKILL.md offers the /dashboard alias without a pre-executed command', () => {
  const { body } = loadSkill('setup');

  assert.match(body, /~\/\.claude\/commands\/dashboard\.md/,
    'the alias path is the whole offer; without it the step cannot be followed');
  assert.match(body, /allowed-tools/,
    'the alias must grant Bash for the dashboard script, or it prompts on every use — which is '
    + 'the friction the shim exists to remove');
  assert.match(body, /exclamation mark/i,
    'the body must say why the pre-execution form is absent, or the next edit puts it back');
});
