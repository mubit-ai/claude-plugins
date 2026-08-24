// @ts-check
/**
 * The skills, as data.
 *
 * Codex reads a skill's frontmatter for two fields and nothing else. There is no
 * `allowed-tools` anywhere in the 0.146.0 binary and no `tools:` grant — the string does not
 * exist — so a Claude Code skill copied across carries a key that grants nothing and reads
 * like a guarantee. What Codex does instead is list every skill's `name` and `description` to
 * the model up front and let it read the `SKILL.md` on demand, which makes the description
 * the entire routing decision.
 *
 * The second gate is the tool prefix. Under Claude Code the plugin's tools are
 * `mcp__plugin_mubit-memory_mubit__<tool>`; under Codex they are `mcp__mubit__<tool>` — the
 * server name, from `.mcp.json`, and nothing else. A skill telling the model to call a tool
 * name that does not exist is worse than one that says nothing: the model tries, fails, and
 * concludes the memory is broken.
 *
 * Everything here is structural or a content guard over prose that protects real behaviour.
 * Each guard has a comment saying what goes wrong without it; none of them is a style check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { CODEX_ROOT, SHARED_ROOT } from './helpers/codex-fixtures.mjs';

const SKILLS_DIR = join(CODEX_ROOT, 'skills');
/**
 * The skills this plugin ships, in the order they arrived and in lockstep with the Claude
 * Code tree — the last test in this file asserts the two sets are equal.
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
 * The two skills that call no MCP tool: `auth` runs `bin/auth.mjs` to get a key, and
 * `dashboard` runs `bin/dashboard.mjs` to open a local page. Both talk to the instance
 * themselves rather than through a tool the model holds.
 */
const MCP_SKILLS = SKILLS.filter((s) => s !== 'auth' && s !== 'dashboard');

/** The prefix a Codex model actually sees, from `.mcp.json`'s server name. */
const PREFIX = 'mcp__mubit__';

/** The prefix the Claude Code plugin uses. Present here is a copy-paste that was never adjusted. */
const CC_PREFIX = 'mcp__plugin_mubit-memory_mubit__';

/** The thirteen tools the plugin allowlists by default. */
const TOOLS = [
  'mubit_learned', 'mubit_recall', 'mubit_outcome', 'mubit_reflect', 'mubit_lessons',
  'mubit_diagnose', 'mubit_archive', 'mubit_dereference', 'mubit_forget', 'mubit_status',
  'mubit_strategies', 'mubit_checkpoint', 'mubit_memory_health',
];

// ---------------------------------------------------------------------------
// A frontmatter splitter — no YAML dependency, matching the plugin's own rule
// ---------------------------------------------------------------------------

function unquote(s) {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

function frontmatter(raw, label) {
  assert.ok(raw.startsWith('---\n'), `${label} does not open with YAML frontmatter — Codex lists a skill by it.`);
  const end = raw.indexOf('\n---', 4);
  assert.ok(end > 0, `${label} has an unterminated frontmatter block.`);
  const block = raw.slice(4, end);
  const body = raw.slice(end + 4);
  /** @type {Record<string, any>} */
  const meta = {};
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (m) meta[m[1]] = unquote(m[2]);
  }
  return { meta, body, block };
}

function read(skill) {
  const p = join(SKILLS_DIR, skill, 'SKILL.md');
  if (!existsSync(p)) assert.fail(`skills/${skill}/SKILL.md does not exist yet: ${p}`);
  const raw = readFileSync(p, 'utf8');
  return { raw, ...frontmatter(raw, `skills/${skill}/SKILL.md`), fenced: fencedBlocks(raw) };
}

/**
 * The fenced code blocks of a skill, joined.
 *
 * This is the half of a skill that gets *executed*: a model copies a fenced command and runs
 * it. Prose is the half that gets *read*, and the two want opposite tests — a string that must
 * never be run is very often a string the prose ought to name explicitly and warn about. A
 * flat substring search over the whole file cannot tell "do not write ${X}" from "write ${X}",
 * and would push the skill towards saying nothing, which is worse.
 */
function fencedBlocks(raw) {
  return [...raw.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
}

// ===========================================================================
// Frontmatter
// ===========================================================================

test('the skill set is exactly the skill directories', () => {
  const dirs = existsSync(SKILLS_DIR)
    ? readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    : [];
  assert.deepEqual(dirs, [...SKILLS].sort(),
    'the Codex plugin ships the same skills as the Claude Code one; a missing one is a '
    + 'command the user types and nothing answers.');
});

for (const skill of SKILLS) {
  test(`${skill}: frontmatter carries the two fields Codex reads`, () => {
    const { meta } = read(skill);
    // § Codex lists `<plugin>:<name>` to the model. A name that does not match its directory
    //   is a skill the user cannot type by the name they see in the tree.
    assert.equal(meta.name, skill,
      `frontmatter name is "${meta.name}", directory is "${skill}". Codex namespaces skills as `
      + '`mubit-memory:<name>`, so these have to agree.');
    assert.ok(String(meta.description ?? '').trim().length > 30,
      `${skill} has no usable description. Codex puts every skill's name and description in `
      + 'front of the model and nothing else — the description IS the routing decision, and a '
      + 'thin one means a skill that is never chosen.');
    assert.ok(/\b(Use|use) when\b/.test(String(meta.description)),
      `${skill}'s description does not say when to use it. A description that only says what a `
      + 'skill is gives the model nothing to route on.');
  });

  test(`${skill}: no Claude-Code-only frontmatter keys`, () => {
    const { meta } = read(skill);
    for (const key of ['tools', 'allowed-tools', 'disable-model-invocation', 'visibility', 'model', 'effort']) {
      // § None of these exists in the Codex binary. A `tools:` key in particular reads exactly
      //   like a capability grant and confers nothing, which is worse than its absence: it
      //   makes a reviewer believe the skill is sandboxed when it is not.
      assert.equal(meta[key], undefined,
        `${skill} carries \`${key}:\`, which Codex does not read. Leaving it in claims a `
        + 'guarantee the host does not provide.');
    }
  });
}

// ===========================================================================
// Tool names in prose
// ===========================================================================

for (const skill of MCP_SKILLS) {
  test(`${skill}: every tool it names is fully qualified for Codex`, () => {
    const { body } = read(skill);
    const bare = [];
    for (const tool of TOOLS) {
      // Find each mention that is NOT already prefixed.
      const re = new RegExp(`(?<!${PREFIX})\\b${tool}\\b`, 'g');
      if (re.test(body)) bare.push(tool);
    }
    // § Under Claude Code the `tools:` grant told the model the qualified name and the prose
    //   could stay readable. Codex has no grant, so the prose is the only place the model
    //   learns what to call — and `mubit_recall` is not a tool that exists there.
    assert.deepEqual(bare, [],
      `${skill} names ${bare.join(', ')} without the ${PREFIX} prefix. Codex has no tools: `
      + 'grant, so the prose is the only place the qualified name appears. A model that calls '
      + 'the bare name gets a tool-not-found and concludes the memory is broken.');
  });

  test(`${skill}: carries no Claude Code prefix`, () => {
    const { raw } = read(skill);
    // § The likeliest way this file gets written is copy-and-adjust, and this is the line the
    //   adjustment misses.
    assert.ok(!raw.includes(CC_PREFIX),
      `${skill} still names ${CC_PREFIX}… — that is the Claude Code prefix. Under Codex the `
      + 'server is named `mubit` in .mcp.json, so every tool is `mcp__mubit__<tool>`.');
  });

  test(`${skill}: every qualified name is a tool the plugin actually allowlists`, () => {
    const { raw } = read(skill);
    const named = [...raw.matchAll(new RegExp(`${PREFIX}([a-z_]+)`, 'g'))].map((m) => m[1]);
    for (const tool of new Set(named)) {
      // § A malformed or renamed grant does not error at install time — it silently matches
      //   nothing. This is the check that turns that into a test failure.
      assert.ok(TOOLS.includes(tool),
        `${skill} names ${PREFIX}${tool}, which is not in the default allowlist `
        + `(${TOOLS.join(', ')}). The model will call it and get nothing back.`);
    }
  });
}

// ===========================================================================
// Content guards — each protects an observed failure
// ===========================================================================

test('auth: no runnable command interpolates ${CLAUDE_PLUGIN_ROOT}', () => {
  const { body, fenced } = read('auth');
  // § docs/harness-probe.md §4: Codex exports no plugin-root variable of any spelling, and
  //   there is no ${...} substitution layer. The Claude Code skill's
  //   `node ${CLAUDE_PLUGIN_ROOT}/bin/auth.mjs` expands to `node /bin/auth.mjs` in the login
  //   shell Codex runs commands in — a path that does not exist, failing with ENOENT on the
  //   one skill a user reaches for when nothing else works.
  //
  //   Tested against the fenced blocks rather than the whole file, because the prose names the
  //   variable on purpose in order to warn about it, and a flat substring search would push
  //   the skill towards saying nothing.
  assert.ok(!fenced.includes('${CLAUDE_PLUGIN_ROOT}'),
    'a runnable command in the auth skill interpolates ${CLAUDE_PLUGIN_ROOT}, which is empty '
    + 'under Codex. Every command has to carry a path resolved from this SKILL.md`s own '
    + 'location.');
  assert.match(body, /Do not write .*CLAUDE_PLUGIN_ROOT|no plugin-root variable/,
    'the skill should say so outright as well — this is the mistake anyone porting from the '
    + 'Claude Code skill makes, and prose is what stops it being made again.');
  assert.match(fenced, /bin\/auth\.mjs/, 'the auth skill must still name the binary it runs.');
  assert.match(body, /SKILL\.md|this file|skill directory/i,
    'the skill has to tell the model how to resolve the path — Codex lists each skill with its '
    + 'absolute SKILL.md path, which is the anchor that works.');
});

test('auth: still refuses to install anything', () => {
  const { body } = read('auth');
  // § Carried over verbatim from the Claude Code skill, and for the same reason: a memory
  //   plugin that runs installers is a trust failure, and this sentence is what a reviewer
  //   reads first.
  assert.match(body, /never installs anything/i,
    'the refusal-to-install sentence is load-bearing prose, not decoration.');
});

test('setup: documents the Codex install path, not the Claude Code one', () => {
  const { body } = read('setup');
  // § This is the single biggest behavioural difference of the port, and setup is where a user
  //   meets it. A plugin-bundled hooks.json is inert under Codex; the registrations have to be
  //   merged into $CODEX_HOME/hooks.json, with absolute paths, and then trusted.
  assert.match(body, /hooks\.json/,
    'setup must explain that the registrations are merged into the user layer — without that '
    + 'step the plugin installs cleanly and captures nothing at all.');
  assert.match(body, /CODEX_HOME|~\/\.codex/,
    'setup must name where the merged file goes.');
  assert.match(body, /trust/i,
    'setup must cover hook trust. An untrusted hook is skipped silently under `codex exec` — '
    + 'no prompt, no warning, exit 0 — so a user who skips this sees a plugin that installed '
    + 'perfectly and does nothing.');
  // § Codex has no plugin option mechanism — the strings PLUGIN_OPTION and userConfig appear
  //   nowhere in its 0.146.0 binary — so Claude Code's `/plugin` → configure route does not
  //   exist here. The skill may name it to rule it out; it may not tell anyone to use it.
  assert.match(body, /does not exist here|no plugin settings UI|Do not send a Codex user/,
    'setup must rule out Claude Code`s /plugin configure UI explicitly. A Codex user sent '
    + 'there finds nothing and concludes the plugin is broken.');
  const steps = body.split('\n').filter((l) => /\/plugin\b/.test(l));
  for (const line of steps) {
    assert.match(line, /not|no |does not/i,
      `setup points at /plugin without ruling it out: ${line.trim()}`);
  }
});

test('setup: does not promise to self-trust without asking', () => {
  const { body } = read('setup');
  // § Trust can be written non-interactively — `[hooks.state."<key>"] trusted_hash = …` in
  //   config.toml, with both values from the app-server's `hooks/list`. That it *can* be is
  //   not a reason to. Codex asks a human before running a hook for the first time; a setup
  //   skill that quietly answers that question on the user's behalf has defeated the control,
  //   whatever its intentions.
  assert.match(body, /ask|confirm|permission|approve/i,
    'setup writes hook trust into config.toml, which is the control Codex uses to stop a hook '
    + 'running unreviewed. It has to show the user what it will trust and ask first.');
});

test('doctor: reads the local marker before it dials anything', () => {
  const { body } = read('doctor');
  // § The cheap steps answer most questions. A doctor that opens with a network call cannot
  //   diagnose the case where the network is the problem.
  assert.match(body, /status\//,
    'the doctor skill must start from the local status marker; it is the only diagnosis that '
    + 'works when the endpoint is the thing that is broken.');
});

test('recall: tells the model the memory was already injected', () => {
  const { body } = read('recall');
  // § Recall injection happens before every prompt. A skill that does not say so produces a
  //   model that opens each turn by searching for what it was just handed — paying twice and
  //   spending its first tool call on it.
  assert.match(body, /already been injected|already injected/i,
    'without this sentence the model opens every turn by re-fetching the memory it was just given.');
});

test('remember: keeps the model from logging the session into memory', () => {
  const { body } = read('remember');
  // § The commonest way this tool is misused is as a session log — "the user asked for X", "I
  //   refactored Y". Every future recall pays for that, forever.
  assert.match(body, /captured automatically|do not use this for/i,
    'the "routine work is captured automatically" warning is what keeps mubit_learned from '
    + 'becoming a session log that every later recall pays for.');
});

test('forget: refuses to delete without confirming first', () => {
  const { body } = read('forget');
  // § There is no dry run and no undo.
  assert.match(body, /confirm/i, 'deletion cannot be undone and has no dry run.');
});

// ===========================================================================
// Drift against the Claude Code skills
// ===========================================================================

test('the two plugins ship the same skill names', () => {
  const ccDirs = readdirSync(join(SHARED_ROOT, 'skills'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const codexDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  // § The two are separate files on purpose — different frontmatter, different tool prefixes,
  //   a different install story in `setup` — but a skill that exists on one host and not the
  //   other is a gap somebody meant to fill and forgot.
  assert.deepEqual(codexDirs, ccDirs,
    'the skill sets have diverged. The files differ by host; the set should not.');
});

// ===========================================================================
// The three skills that carry a promoted tool
// ===========================================================================

/**
 * Each of these three exists so that a tool promoted into the default allowlist has somewhere
 * to be invoked from, which makes one sentence in each of them load-bearing: the one that
 * separates the new tool from the neighbour it will otherwise be confused with.
 *
 * The stake is higher here than next door. Under Claude Code the `tools:` grant narrows what
 * the skill can reach; Codex has no grant at all, so the prose is the only thing standing
 * between the model and the wrong tool.
 */

test('strategies: separates the pattern from the lessons it is a pattern over', () => {
  const { body } = read('strategies');
  // § The tool clusters lessons. Asked for one lesson it returns a summary of the cluster that
  //   lesson sits in, which reads like an answer and is not one.
  assert.match(body, /across/i,
    'strategies must say the answer is a pattern *across* lessons, not one of them.');
  assert.match(body, new RegExp(`${PREFIX}mubit_lessons`),
    'strategies must name mcp__mubit__mubit_lessons as the tool that reads the individual '
    + 'lessons. The two are near-synonyms until one of them says so.');
});

test('checkpoint: says the snapshot is stored verbatim, and is run state not knowledge', () => {
  const { body } = read('checkpoint');
  // § `snapshot` is stored byte-for-byte and nothing extracts from it, so a model that writes a
  //   headline has written a checkpoint that restores nothing.
  assert.match(body, /verbatim/i, 'checkpoint must say the snapshot is stored verbatim.');
  assert.match(body, /unsummaris|unsummariz|not summaris|not summariz/i,
    'checkpoint must say nothing summarises it — a one-line snapshot restores nothing.');
  assert.match(body, /run state, not knowledge/i,
    'checkpoint must draw the line in those words: a checkpoint is run state, not knowledge.');
  assert.match(body, /mubit-memory:remember/,
    'checkpoint must send knowledge to mubit-memory:remember. Swap the two writes and memory '
    + 'fills with state that expired the same afternoon.');
});

test('memory-health: states the store/connection split against mubit_status', () => {
  const { body } = read('memory-health');
  // § Both tools fail as "memory is not working" and their fixes are opposites: an empty store
  //   behind a healthy connection and a full store behind a dead endpoint look identical.
  assert.match(body, new RegExp(`${PREFIX}mubit_status`),
    'memory-health must name mcp__mubit__mubit_status — it is the tool it is confused with.');
  assert.match(body, /store/i, 'memory-health must say it inspects the store.');
  assert.match(body, /connection/i,
    'memory-health must say mubit_status inspects the connection; without the second half the '
    + 'first half is not a distinction.');
});

// ===========================================================================
// activity
// ===========================================================================

test('activity: no runnable command interpolates ${CLAUDE_PLUGIN_ROOT}', () => {
  const { body, fenced } = read('activity');
  // § docs/harness-probe.md §4: Codex exports no plugin-root variable of any spelling. The
  //   Claude Code copy's `node ${CLAUDE_PLUGIN_ROOT}/bin/activity.mjs` expands to
  //   `node /bin/activity.mjs` in the login shell Codex runs commands in — ENOENT, on the one
  //   command whose entire job is to prove the plugin can show its work.
  assert.ok(!fenced.includes('${CLAUDE_PLUGIN_ROOT}'),
    'a runnable command in the activity skill interpolates ${CLAUDE_PLUGIN_ROOT}, which is '
    + 'empty under Codex.');
  assert.match(body, /Do not write .*CLAUDE_PLUGIN_ROOT|no plugin-root variable/,
    'the skill should say so outright as well — this is the mistake anyone porting from the '
    + 'Claude Code skill makes.');
  assert.match(fenced, /bin\/activity\.mjs/, 'the activity skill must still name the binary it runs.');
  assert.match(body, /SKILL\.md|this file|skill directory/i,
    'Codex lists each skill with its absolute SKILL.md path, which is the anchor that works.');
});

/**
 * The `disable-model-invocation: true` that the Claude Code copy carries has no equivalent
 * here — the key does not exist in the Codex binary — so the rule has to survive as prose or
 * not at all. Without it a model that reads "list what memory holds" will do exactly that,
 * unprompted, and pull somebody's whole memory into a transcript.
 */
test('activity: keeps the do-not-invoke-yourself rule that Codex cannot enforce', () => {
  const { body } = read('activity');
  assert.match(body, /own initiative|only then|never on your own/i,
    'Codex reads no disable-model-invocation key, so this paragraph is the whole control.');
});

/**
 * The guard that matters most, and the reason it is duplicated across both hosts: without it
 * the model will describe an export as "filtered activity", which is the precise false claim
 * the design prevents. `/v2/control/activity/export` accepts neither `exclude_derived` nor
 * `projection`, so an export is always everything in scope.
 */
test('activity: keeps the listing and the export distinguishable', () => {
  const { body } = read('activity');
  assert.match(body, /never filtered|not filtered|accepts no `?exclude_derived/i,
    'the skill must say outright that an export carries no filter');
  assert.match(body, /verbatim|byte for byte/i,
    'and that its content is what the instance holds rather than something this client shaped');
  assert.match(body, /never describe an export as/i,
    'the instruction has to be an instruction — this is the sentence that stops "here is your '
    + 'filtered export"');
});

test('activity: forbids --out unless the user asked for a file', () => {
  const { body } = read('activity');
  // § Writing a file is the only irreversible thing the command does, and the model decides
  //   whether it happens. An export is a complete copy of what the instance holds.
  assert.match(body, /Do not pass `--out` unless/i, 'creating the copy is the user\'s decision');
  assert.match(body, /absolute path/i,
    'a file the user cannot find is a file they cannot delete — the reply has to name it');
});

test('activity: tells the model to relay the findings rather than summarise them away', () => {
  const { body } = read('activity');
  // § A correction that stops at the terminal is no correction. "The instance ignored the
  //   filter you asked for" is the finding, and compressing it out is the model's default.
  assert.match(body, /did not honour/i);
  assert.match(body, /incomplete|prefix/i,
    'a truncated scan reported as a complete answer is the same lie as an unhonoured filter');
  assert.match(body, /Relay|rather than summaris/i);
});

test('activity: does not name a script this plugin does not ship', () => {
  const { body } = read('activity');
  // § `scripts/mubit-inspect.mjs` is Claude-Code-side, untested, and not in either plugin's
  //   `files`. The question it answers is real, so the skill routes at the surface that ships.
  assert.ok(!body.includes('mubit-inspect'),
    'naming it sends a user to a path that does not exist in an installed plugin');
  assert.match(body, /Turns/,
    'per-prompt cost lives in the dashboard\'s Turns tab; this skill cannot answer it');
});

// ===========================================================================
// pin
// ===========================================================================

/**
 * Codex reads a skill's `name` and `description` and nothing else, so the description IS the
 * routing decision — and this is the one skill where routing wrongly does damage rather than
 * nothing. When the user says "for the rest of this, don't touch the vendored server", the
 * alternative to reaching `pin` is writing a *lesson*: a durable, cross-session claim about a
 * project where that sentence stops being true when the task ends.
 */
test('pin: the description draws the line against remember', () => {
  const { meta, body } = read('pin');
  const description = String(meta.description ?? '');

  assert.match(description, /\brun\b/i,
    'a pin is scoped to this run — that is the whole distinction, and it belongs in the one '
    + 'field Codex actually puts in front of the model.');
  assert.match(description, /remember/,
    'the description is where the model chooses between the two commands, so it has to name '
    + 'the other one.');
  assert.match(body, /cross-session|every future session/i,
    '"durable" with no consequence attached is an adjective, not a rule.');
});

// § The Codex copy cannot say `${CLAUDE_PLUGIN_ROOT}`: the host sets no plugin-root variable
//   of any spelling, so the shell expands it to nothing and `node /bin/pin.mjs` is an ENOENT.
test('pin: the commands resolve the binary the way Codex requires', () => {
  const { fenced, body } = read('pin');
  assert.ok(!fenced.includes('CLAUDE_PLUGIN_ROOT'),
    'a fenced command carrying ${CLAUDE_PLUGIN_ROOT} runs as `node /bin/pin.mjs` under Codex.');
  assert.match(body, /plugin-root/i, 'the skill must tell the model how to find its own binary.');
  assert.match(fenced, /bin\/pin\.mjs/, 'and the commands have to name it.');
});

// § The caps are refusals a user will hit. A refusal with no reason reads as a bug, and gets
//   worked around by shortening the user's words — which changes the constraint.
test('pin: states the caps and why a pin is expensive', () => {
  const { body } = read('pin');
  assert.match(body, /\b5\b|\bfive\b/i);
  assert.match(body, /200/);
  assert.match(body, /every prompt|each prompt/i);
  assert.match(body, /never\s+(attempt\s+to\s+)?install|do not install|don't install/i,
    'a memory plugin running installers is a trust failure.');
});
