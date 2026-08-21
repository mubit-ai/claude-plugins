// @ts-check
/**
 * Skills and the subagent — build-guide §9.
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

/** §2/§9 — the skills the plugin ships. `auth` is the seventh, `link` the eighth. */
const SKILLS = ['recall', 'remember', 'reflect', 'forget', 'doctor', 'setup', 'auth', 'link'];

/**
 * The two skills that call no MCP tool, because each runs a bundled script instead.
 *
 *   - `auth` obtains a credential, which is precisely the thing that has to exist before
 *     any MCP tool works, so it cannot depend on one.
 *   - `link` declares the run graph (SCOPE.md §6 Tier 3). It is deliberately not an MCP
 *     tool: a model-callable link route would let an agent widen its own read reach, which
 *     is the same hole the MCP egress guard just closed in the other direction.
 *
 * Every tool-surface assertion below therefore skips them by name rather than by accident.
 *
 * `modelInvocable` is the one place the two differ, and it is §6's "Not the LLM" argument
 * in a single field: a user must be able to type `/mubit-memory:auth` when nothing is
 * configured, and a model must not be able to reach `link` at all.
 */
const SCRIPT_SKILLS = [
  { name: 'auth', bin: 'bin/auth.mjs', modelInvocable: true },
  { name: 'link', bin: 'bin/link.mjs', modelInvocable: false },
];

const MCP_SKILLS = SKILLS.filter((s) => !SCRIPT_SKILLS.some((k) => k.name === s));

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
    'Build-guide §9 defines the skill set: recall, remember, reflect, forget, doctor, setup, '
    + 'auth, link.');
  return parseFrontmatter(text, `skills/${name}/SKILL.md`);
}

function loadAgent() {
  const p = join(AGENTS_DIR, 'mubit-recall.md');
  const text = readOrFail(p, 'agents/mubit-recall.md', 'Build-guide §9.4 defines the Haiku recall subagent.');
  return parseFrontmatter(text, 'agents/mubit-recall.md');
}

/** The real MCP tool names, parsed from the server bundle the plugin ships. */
function realToolNames() {
  const src = readOrFail(SERVER_BUNDLE, 'mcp/dist/server.js',
    'The bundled MCP server (§1.9). Run `npm run build` — the plugin cannot start without it.');
  return [...src.matchAll(/name:\s*"(mubit_[a-z_0-9]+)"/g)].map((m) => m[1]);
}

/**
 * `{CODING_RULE: {lesson_type, lesson_scope}, ...}` — from `lib/classify.mjs`.
 *
 * The templates are not in the server bundle (they are a client-side table), and the
 * upstream TypeScript they were pinned from is not shipped. `lib/classify.mjs` is where the
 * plugin's own copy lives and is what the `remember` skill's prose has to agree with, so
 * comparing against it catches the drift that actually breaks a user: a skill documenting a
 * type/scope pair the plugin does not send. `test/classify.test.mjs` pins that copy in turn.
 */
async function lessonTemplates() {
  const { LESSON_TEMPLATES } = await lib('classify.mjs');
  /** @type {Record<string, {lesson_type: string, lesson_scope: string}>} */
  const out = {};
  for (const [name, t] of Object.entries(LESSON_TEMPLATES)) {
    out[name] = { lesson_type: t.lesson_type, lesson_scope: t.lesson_scope };
  }
  return out;
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
  assert.ok(existsSync(SKILLS_DIR), `skills/ does not exist yet: ${SKILLS_DIR} (build-guide §9)`);
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
  assert.ok(files.length > 0, `no skills or agents exist yet under ${PLUGIN_ROOT} (build-guide §9)`);

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
    `no skills or agents exist yet under ${PLUGIN_ROOT} (build-guide §9) — this check would otherwise pass vacuously`);

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

// §9.2 — the templates set lesson_type and lesson_scope for the writer. Getting a pair
// wrong writes a lesson at the wrong scope, which is the difference between a rule that
// follows the user everywhere and one that dies with the session.
test('remember/SKILL.md lists all 8 lesson templates with the exact type/scope pairs', async () => {
  const { body } = loadSkill('remember');
  const templates = await lessonTemplates();
  assert.equal(Object.keys(templates).length, 8,
    `expected 8 templates in lib/classify.mjs, got ${Object.keys(templates).length}`);

  for (const [name, { lesson_type, lesson_scope }] of Object.entries(templates)) {
    const line = body.split(/\r?\n/).find((l) => l.includes(name));
    assert.ok(line, `remember/SKILL.md does not mention the ${name} template (§9.2)`);
    assert.ok(line.includes(lesson_type),
      `remember/SKILL.md: ${name} must document lesson_type "${lesson_type}" (from lib/classify.mjs). Line: ${line.trim()}`);
    assert.ok(line.includes(lesson_scope),
      `remember/SKILL.md: ${name} must document lesson_scope "${lesson_scope}" (from lib/classify.mjs). Line: ${line.trim()}`);
  }
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
// `scripts/check-mirror-clean.mjs` keeps the denylist, and is not published.
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
 * A script-backed skill runs a bundled `.mjs` instead of calling an MCP tool, so its
 * permission grant is `allowed-tools`, not `tools`. Without a grant the host prompts for
 * approval on every run, which is a poor first impression from the command whose entire job
 * is to make the first five minutes work — and a *bare* `Bash` grant would hand the skill
 * the whole shell, which is the opposite trade.
 *
 * Written over the table rather than once per skill: the rule is the same for both, and the
 * next script-backed skill inherits it by adding one row instead of copying a test.
 */
for (const { name, bin } of SCRIPT_SKILLS) {
  test(`${name}/SKILL.md grants exactly the Bash permission it needs, and no MCP tools`, () => {
    const { fm } = loadSkill(name);

    const allowed = fm['allowed-tools'];
    assert.ok(allowed, `${name} must declare allowed-tools so the host does not prompt on every run`);
    const text = Array.isArray(allowed) ? allowed.join(' ') : String(allowed);

    assert.match(text, /Bash\(/, 'the grant is a Bash permission rule');
    assert.ok(text.includes(bin),
      `${name}: the rule must name ${bin}; a bare Bash grant hands the skill the whole shell`);
    assert.match(text, /\$\{CLAUDE_PLUGIN_ROOT\}/,
      'the plugin is installed at a path nobody can predict — a relative path resolves to the wrong place');

    const others = SCRIPT_SKILLS.filter((k) => k.name !== name).map((k) => k.bin);
    for (const other of others) {
      assert.ok(!text.includes(other),
        `${name} grants ${other} as well as its own binary — a skill's grant is its blast radius`);
    }

    assert.equal(toolsOf(fm), undefined,
      `${name} runs a bundled script precisely so it does not need an MCP tool; granting one `
      + 'would make it depend on the surface it exists beside');
  });
}

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
  assert.match(para, /\brun\b/,
    `remember/SKILL.md must say mubit_learned writes at run scope. Paragraph:\n${para}`);
  assert.doesNotMatch(para, /\bsession\b/,
    'remember/SKILL.md still says mubit_learned writes at session scope. It does not: the '
    + 'egress guard clamps it to run, and session is read across runs anyway, which is the '
    + `leak that clamp exists to close. Paragraph:\n${para}`);
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
// §9 — link (SCOPE.md §6 Tier 3)
// ---------------------------------------------------------------------------

/**
 * The single most load-bearing line in the file, and the one a later "make it more useful"
 * pass would delete first.
 *
 * A link widens what a run may **read**, durably, across every future session. Handing that
 * to the model is the same class of mistake the MCP egress guard closed on the write side:
 * an agent granting itself access to memory the user never connected. `disable-model-invocation`
 * is what makes that structural rather than advisory — without it the skill's own description
 * is an invitation, because it describes exactly the capability a stuck agent wants.
 */
test('link/SKILL.md is not model-invocable — a human declares the graph', () => {
  const { fm } = loadSkill('link');
  assert.equal(fm['disable-model-invocation'], true,
    'skills/link/SKILL.md must set `disable-model-invocation: true` (SCOPE.md §6 "Not the LLM"). '
    + 'A model-callable link route lets an agent widen its own read reach — the read-side twin '
    + 'of the egress hole the MCP guard closed');
});

/**
 * `disable-model-invocation` stops the model invoking it; the prose is what stops the model
 * — or the next reader — reintroducing it as an MCP tool "for convenience". The asymmetry is
 * the argument, so the argument has to be in the file rather than in a ticket nobody reads.
 */
test('link/SKILL.md carries the "Not the LLM" argument in the plugin\'s own voice', () => {
  const { body } = loadSkill('link');
  assert.match(body, /\bread\b/i,
    'link must say that a link widens what a run may READ — the write side is not what is at stake');
  assert.match(body, /durabl|permanent|future sessions|across sessions/i,
    'link must say the widening is durable across future sessions, not scoped to this one');
  assert.match(body, /\bnoise\b|one turn|costs? one/i,
    'link must state the asymmetry: a bad recall costs one turn of noise (§6)');
  assert.match(body, /silent|until (someone|somebody) notices|invisible/i,
    'link must state the other half: a bad link is silent until someone notices an unrelated '
    + 'project bleeding in (§6)');
  assert.match(body, /human confirms|a human|the user confirms/i,
    'link must say the model may notice and suggest, but a human confirms (§6)');
  assert.match(body, /unlink/,
    'link must name `unlink` as the revocation — the thing that makes a link safe to offer at all');
});

/**
 * §6's ruling constraint: users never see run ids. `cc-plugin-lab-43f3807e` is a hash of a
 * git toplevel, and a skill that told the model to pass one would push the hash straight back
 * into the surface the whole design keeps it out of.
 */
test('link/SKILL.md addresses projects by directory, never by run id', () => {
  const { body } = loadSkill('link');
  assert.match(body, /director(y|ies)|path/i,
    'link must say projects are addressed by directory (§6)');
  assert.doesNotMatch(body, /\bcc-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}\b/,
    'link/SKILL.md contains a literal run id. Users never see run ids (§6); putting one in the '
    + 'skill teaches the model to ask for one');
});

/**
 * The fact a user choosing *how many* projects to link needs, and the only place they will
 * be choosing: recall reads the whole link graph, and reflect reads a narrower slice of it
 * (ricedb `lib.rs:10309` — at most 3 linked runs x 20 traces). A mesh of four or more is
 * therefore fully visible to recall and only partly visible to lesson extraction, which is
 * a surprise worth spending two lines on rather than a bug report worth spending a day on.
 */
test('link/SKILL.md warns that reflect sees a narrower window than recall', () => {
  const { body } = loadSkill('link');
  assert.match(body, /reflect/i, 'link must mention reflect — it is the other reader of the graph');
  assert.match(body, /\b3\b|\bthree\b/,
    'link must name the ceiling: reflect consults at most three linked runs');
  assert.match(body, /narrow|fewer|smaller|partly|only part/i,
    'link must say the reflect window is narrower than recall\'s, or the number reads as a total');
});

/**
 * Mesh, not hub. `linked_runs_for` returns `scope.linked_run_ids` without walking them, so a
 * star leaves siblings unable to see each other while the surface says they are "linked".
 * The skill has to describe what linking a group actually does, because that is the sentence
 * a user checks their mental model against.
 */
test('link/SKILL.md says a group is linked pairwise, not through a hub', () => {
  const { body } = loadSkill('link');
  assert.match(body, /pair|mesh|each other|every pair/i,
    'link must say that linking a group links every pair — one hop is all the backend walks, so '
    + 'a hub-and-spoke graph strands the spokes from each other (SCOPE.md §6)');
});
