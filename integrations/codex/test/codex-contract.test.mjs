// @ts-check
/**
 * The contract gates the suite did not have.
 *
 * Every check here exists because something the host enforces was going unasserted, and the
 * suite could not have told the difference. They are grouped by what they protect:
 *
 *   1. **One JSON object on stdout, and nothing else.** Codex injects non-JSON stdout into the
 *      model's context as *developer context*. A stray `console.log` on any hook path is
 *      therefore not a debugging artefact, it is text pasted into every turn of every session.
 *      Nothing gated this.
 *   2. **`additionalContextLimit`, declared where it applies and nowhere else.** The host
 *      defaults it to 2500 tokens and, over the limit, **spills rather than truncates** — the
 *      full text goes to `<temp>/hook_outputs/` and the model gets a head-and-tail stub. Only
 *      five events can emit context at all; setting it elsewhere is warned about and discarded.
 *   3. **`tool_response` is schema-`true`** — any JSON type — and the code handled the string
 *      and object cases it had seen.
 *   4. **The rule table's own extraction**, which had no count check and a recipe that
 *      truncated any message containing a hyphen.
 *   5. **`assertWithinBudget` was exported and called zero times.** A budget nothing measures
 *      is a comment.
 */

import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assert, assertOutputAccepted, assertValid, assertWithinBudget, baseEnv, CODEX_ROOT,
  CODEX_EVENTS, fakeMubit, makeDataDir, makeProjectDir, runHook, schemaSlug,
  postToolUse, preToolUse, permissionRequest, sessionStart, sessionEnd, stop, subagentStart,
  subagentStop, userPromptSubmit, preCompact, postCompact,
} from './helpers/codex-fixtures.mjs';
import { recordedAnswer } from './helpers/codex-oracle.mjs';

const RUN_ID = 'codex-contract-test';

function contractEnv(dataDir, projectDir, endpoint, extra = {}) {
  return baseEnv({
    dataDir,
    projectDir,
    endpoint,
    extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN_ID, ...extra },
  });
}

/**
 * Every registration in `hooks.json`, as something this file can actually run: the script, the
 * argv it is registered with, the event it answers, and a payload of that event's shape.
 *
 * Derived from the manifest rather than listed, so a registration added without a payload
 * builder fails here instead of going untested.
 */
function registrations() {
  const tpl = JSON.parse(readFileSync(join(CODEX_ROOT, 'hooks.json'), 'utf8'));
  const builders = {
    PreToolUse: preToolUse,
    PermissionRequest: permissionRequest,
    PostToolUse: postToolUse,
    PreCompact: preCompact,
    PostCompact: postCompact,
    SessionStart: sessionStart,
    SessionEnd: sessionEnd,
    UserPromptSubmit: userPromptSubmit,
    SubagentStart: subagentStart,
    SubagentStop: subagentStop,
    Stop: stop,
  };
  const out = [];
  for (const [event, groups] of Object.entries(tpl.hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        const m = /"[^"]*\/([a-z-]+)\.mjs"(.*)$/.exec(h.command);
        assert.ok(m, `cannot read a script name out of: ${h.command}`);
        assert.ok(builders[event], `no payload builder for ${event}`);
        out.push({
          event,
          script: m[1],
          args: m[2].trim() ? m[2].trim().split(/\s+/) : [],
          limit: h.additionalContextLimit,
          payload: builders[event](),
        });
      }
    }
  }
  return out;
}

// ===========================================================================
// 1. One JSON object on stdout, and nothing else
// ===========================================================================

test('every registered handler writes one JSON object and nothing else', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const projectDir = makeProjectDir({ git: true });

  for (const reg of registrations()) {
    const env = contractEnv(makeDataDir(), projectDir, server.url);
    const r = await runHook(reg.script, reg.payload, { env, args: reg.args });
    const what = `${reg.event} -> ${reg.script}${reg.args.length ? ` ${reg.args.join(' ')}` : ''}`;

    assert.equal(r.code, 0, `${what} exited ${r.code}. stderr:\n${r.stderr}`);
    const raw = r.stdout;
    if (!raw.trim()) continue;   // silence is a valid answer on every event

    // § Not `JSON.parse(raw.trim())`. That would accept `{"a":1}\nleaked line` if the leak
    //   happened to be dropped by trim, and would accept two concatenated objects on some
    //   inputs. The whole of stdout has to BE the object.
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      assert.fail(`${what} wrote stdout that is not a single JSON value. Codex injects `
        + `non-JSON stdout into the model's context as developer context, so this is pasted `
        + `into every turn:\n---\n${raw}\n---\n(${e.message})`);
    }
    assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed),
      `${what} wrote a JSON ${Array.isArray(parsed) ? 'array' : typeof parsed}, not an object:\n${raw}`);

    assertOutputAccepted(reg.event, parsed, what);
    if (reg.event !== 'SessionEnd') {
      assertValid(parsed, `${schemaSlug(reg.event)}.command.output`, what);
    }
  }
});

test('a hook that fails still writes nothing but JSON', async (t) => {
  // § The path where a stray diagnostic is most likely, and where it does most harm: the
  //   plugin is already degraded and now it is also editing the model's context.
  const server = await fakeMubit({ 'POST /v2/control/query': { status: 500, json: { error: 'nope' } } });
  t.after(() => server.close());
  const projectDir = makeProjectDir({ git: true });

  for (const reg of registrations()) {
    const env = contractEnv(makeDataDir(), projectDir, 'http://127.0.0.1:1');   // nothing listening
    const r = await runHook(reg.script, reg.payload, { env, args: reg.args });
    const what = `${reg.event} -> ${reg.script} against a dead endpoint`;
    assert.equal(r.code, 0, `${what} exited ${r.code}`);
    if (!r.stdout.trim()) continue;
    try {
      JSON.parse(r.stdout);
    } catch (e) {
      assert.fail(`${what} leaked non-JSON to stdout:\n---\n${r.stdout}\n---\n(${e.message})`);
    }
  }
});

// ===========================================================================
// 2. additionalContextLimit
// ===========================================================================

/** The five events whose output schema carries `additionalContext` at all. */
const CAN_EMIT_CONTEXT = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SubagentStart', 'UserPromptSubmit'];

test('the five events that can emit context are the five the host says', () => {
  // § Read off the host's own output schemas rather than asserted from memory, so the list
  //   above cannot drift away from what Codex will accept.
  for (const event of CODEX_EVENTS) {
    if (event === 'SessionEnd') continue;               // no output wire type at all
    const schema = JSON.parse(readFileSync(
      join(CODEX_ROOT, 'test', 'fixtures', 'codex-hook-schemas', `${schemaSlug(event)}.command.output.json`),
      'utf8'));
    // § `hookSpecificOutput` is `{allOf: [{$ref}], default: null}` on most events and a bare
    //   `$ref` on others, so both spellings have to resolve — a resolver that handled only one
    //   would report "does not emit context" for half the list and look like a real finding.
    const hso = schema.properties?.hookSpecificOutput;
    const refOf = (n) => /#\/definitions\/(.+)$/.exec(String(n?.$ref ?? ''))?.[1];
    const name = refOf(hso) ?? (Array.isArray(hso?.allOf) ? hso.allOf.map(refOf).find(Boolean) : undefined);
    const def = name ? schema.definitions?.[name] : hso;
    const emits = !!def?.properties?.additionalContext;
    assert.equal(emits, CAN_EMIT_CONTEXT.includes(event),
      `${event}: the schema ${emits ? 'DOES' : 'does not'} carry additionalContext, and the `
      + `list in this file says ${CAN_EMIT_CONTEXT.includes(event) ? 'it does' : 'it does not'}.`);
  }
});

test('additionalContextLimit is declared on the handlers that emit, and nowhere else', () => {
  const rec = recordedAnswer();
  // The four handlers that actually build an additionalContext block. `capture` answers
  // PostToolUse — an event that *can* emit context — and never does, so a limit there would
  // declare a budget for something that does not exist.
  const EMITTERS = ['pre-tool.mjs', 'session-start.mjs', 'prompt-recall.mjs', 'subagent-start.mjs'];

  for (const h of rec.hooks) {
    const emits = EMITTERS.some((n) => h.command.includes(n));
    if (emits) {
      assert.equal(h.additionalContextLimit, 2500,
        `${h.eventName} emits additionalContext and the host reports no explicit limit for it. `
        + 'Over the limit Codex SPILLS rather than truncates — the full block goes to a temp '
        + 'file and the model gets a head-and-tail stub — so the margin above our own 1500-token '
        + 'budget is worth stating rather than inheriting.');
    } else {
      assert.equal(h.additionalContextLimit, null,
        `${h.eventName} -> ${h.command} declares additionalContextLimit and emits no context. `
        + 'On an event that cannot emit context at all the host warns and discards it.');
    }
  }
});

test('the host accepted every limit we set, silently', () => {
  const rec = recordedAnswer();
  assert.deepEqual(rec.warnings, [],
    'the host warned about our manifest. Its warnings are how it reports a setting it '
    + 'understood and threw away — `ignoring additionalContextLimit for <event> hook: this '
    + 'event cannot emit additionalContext` is the one this gate exists for.');
});

test('the block each hook emits fits under the limit it declared', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const projectDir = makeProjectDir({ git: true });
  const dataDir = makeDataDir();
  const env = contractEnv(dataDir, projectDir, server.url);

  // A staged parent turn, so `subagent-start` has something to query against — without it that
  // hook returns early and this test would measure nothing while passing.
  await runHook('stage-prompt', userPromptSubmit(), { env });

  const cases = [
    { script: 'session-start', payload: sessionStart(), event: 'SessionStart' },
    { script: 'prompt-recall', payload: userPromptSubmit(), event: 'UserPromptSubmit' },
    { script: 'subagent-start', payload: subagentStart(), event: 'SubagentStart' },
  ];
  let measured = 0;
  for (const c of cases) {
    const r = await runHook(c.script, c.payload, { env });
    const block = r.json?.hookSpecificOutput?.additionalContext;
    if (typeof block !== 'string' || !block) continue;
    measured += 1;

    // The plugin's own estimate: four characters to a token. The point is not precision, but
    // nothing here is anywhere near a limit that would make the host spill.
    const tokens = Math.ceil(block.length / 4);
    assert.ok(tokens < 2500,
      `${c.script} emitted about ${tokens} tokens against a declared limit of 2500. Over it, `
      + 'Codex writes the block to a temp file and hands the model a stub of it — so the '
      + 'memory is technically delivered and effectively gone.');
  }
  assert.ok(measured >= 2,
    `only ${measured} of ${cases.length} hooks emitted a block, so this measured almost `
    + 'nothing. Arrange the fixtures so at least the recall paths inject.');
});

// ===========================================================================
// 3. tool_response is any JSON type
// ===========================================================================

test('every JSON type of tool_response is survivable', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const projectDir = makeProjectDir({ git: true });

  // § `"tool_response": true` in post-tool-use.command.input — the bare `true` schema, which
  //   accepts any JSON value. The code handled the string and object shapes it had seen.
  const shapes = [
    ['a number', 42],
    ['zero', 0],
    ['an array', ['one', 2, { three: true }]],
    ['a boolean', false],
    ['null', null],
    ['an empty string', ''],
    ['a nested object', { stdout: 'out', nested: { deep: [1, 2, 3] } }],
  ];

  for (const [what, value] of shapes) {
    const payload = postToolUse({ tool_response: value });
    assertValid(payload, 'post-tool-use.command.input',
      `a PostToolUse carrying ${what} as tool_response`);

    const r = await runHook('capture', payload,
      { env: contractEnv(makeDataDir(), projectDir, server.url) });
    assert.equal(r.code, 0, `capture exited ${r.code} on ${what}. stderr:\n${r.stderr}`);
    if (r.stdout.trim()) {
      assertOutputAccepted('PostToolUse', JSON.parse(r.stdout), `capture on ${what}`);
    }
  }
});

// ===========================================================================
// 4. The rule table's own extraction
// ===========================================================================

const RULES_PATH = join(CODEX_ROOT, 'test', 'fixtures', 'codex-output-rules.json');
const rulesDoc = () => JSON.parse(readFileSync(RULES_PATH, 'utf8'));

test('the rule table holds the number of rules it says it holds', () => {
  const doc = rulesDoc();
  const all = Object.values(doc.rules).reduce((n, rs) => n + rs.length, 0);
  const named = Object.entries(doc.rules)
    .filter(([k]) => k !== '*').reduce((n, [, rs]) => n + rs.length, 0);

  // § The extraction had no count check at all, so a recipe that silently matched three lines
  //   instead of twenty would have produced a table that passed every test under it.
  assert.equal(all, doc._provenance.rule_count,
    'the table and its own provenance block disagree about how many rules it holds.');
  assert.equal(named, doc._provenance.rule_count_named_events);
  assert.ok(all >= 20, `only ${all} rules — the recorded extraction found 20.`);
});

test('every rule message is one the binary actually contains', () => {
  const doc = rulesDoc();
  const binary = resolveCodexBinary();
  if (!binary) {
    // § Loudly, and by name. A silent skip here is indistinguishable from a pass, and this is
    //   the check that keeps the table honest.
    t_skip('no codex binary found on this machine, so the rule table was NOT re-verified '
      + 'against it. The messages below are the ones a user sees; a stale table is a gate '
      + 'asserting yesterday`s contract.');
    return;
  }

  const extracted = extractMessages(binary);
  assert.ok(extracted.length >= 20,
    `the corrected recipe found only ${extracted.length} messages in ${binary}. The recipe is `
    + `in this file's _provenance block; read _provenance.recipe_note before widening it.`);

  for (const [event, rules] of Object.entries(doc.rules)) {
    if (event === '*') continue;    // its event name is interpolated at runtime
    for (const rule of rules) {
      // § A prefix, not an equality: three of the extracted lines carry trailing bytes from
      //   whatever string the linker packed next to them, because these have no separator.
      assert.ok(extracted.some((line) => line.startsWith(rule.message)),
        `the table claims Codex says "${rule.message}", and no string in the binary starts `
        + 'with it. Either the host changed its wording — in which case a user now sees a '
        + 'message this suite has never heard of — or the table was edited by hand.');
    }
  }
});

test('the recorded recipe is the corrected one', () => {
  const doc = rulesDoc();
  // § The old recipe ended the match at `[a-zA-Z:.,= ]`, which cut every message at its first
  //   hyphen — including `…deny without a non-empty permissionDecisionReason`, which lost
  //   everything from `non-` on. A recipe that cannot reproduce the table is not provenance.
  assert.doesNotMatch(doc._provenance.recipe, /\[a-zA-Z:\.,= \]/,
    'the provenance still records the truncating recipe.');
  assert.ok(doc.rules.PreToolUse.some((r) => r.message.includes('non-empty permissionDecisionReason')),
    'the hyphenated message is the one the old recipe lost; it must be in the table.');
});

// ===========================================================================
// 5. assertWithinBudget, actually called
// ===========================================================================

test('capture stays inside its budget', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const projectDir = makeProjectDir({ git: true });

  const run = async () => {
    const r = await runHook('capture', postToolUse(),
      { env: contractEnv(makeDataDir(), projectDir, server.url) });
    assert.equal(r.code, 0, r.stderr);
    return r.ms;
  };

  // § capture is budgeted at ~40 ms of its own work, on top of starting node. The helper
  //   subtracts a spawn floor it measures under the same load, so this is the hook's own cost
  //   and not the runner's. 120 ms is a gross-regression guard — a sleep, a retry loop, a
  //   directory walk — not a stopwatch. Note capture now reads a bounded transcript tail on
  //   this host, which is exactly the kind of addition worth a number.
  await assertWithinBudget('capture (PostToolUse)', 120, await run(), run);
});

test('prompt-recall stays inside its budget', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const projectDir = makeProjectDir({ git: true });

  const run = async () => {
    const r = await runHook('prompt-recall', userPromptSubmit(),
      { env: contractEnv(makeDataDir(), projectDir, server.url) });
    assert.equal(r.code, 0, r.stderr);
    return r.ms;
  };

  // § This one blocks the user's prompt, and the recall it performs is a network round trip
  //   against a server on loopback. Codex allows the registration 3 s; this asserts the hook
  //   is not spending them.
  await assertWithinBudget('prompt-recall (UserPromptSubmit)', 900, await run(), run);
});

// ---------------------------------------------------------------------------

/** Where the `codex` on PATH keeps its real binary, or `''`. */
function resolveCodexBinary() {
  const recorded = rulesDoc()._provenance.binary;
  const roots = ['/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules'];
  for (const root of roots) {
    const p = join(root, recorded);
    if (existsSync(p)) return p;
  }
  try {
    const which = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
    return which && existsSync(which) ? which : '';
  } catch {
    return '';
  }
}

/** The rejection messages the binary carries, by the corrected recipe. */
function extractMessages(binary) {
  const EVENTS = 'PreToolUse|PostToolUse|PermissionRequest|SessionStart|SessionEnd'
    + '|UserPromptSubmit|SubagentStart|SubagentStop|Stop|PreCompact|PostCompact';
  let strings;
  try {
    strings = execFileSync('strings', ['-n', '2', binary], { encoding: 'utf8', maxBuffer: 1 << 30 });
  } catch {
    return [];
  }
  const re = new RegExp(`(?:${EVENTS}) hook (?:returned|denied) [\\s\\S]*?(?=(?:${EVENTS}) hook |$)`, 'g');
  const out = new Set();
  for (const line of strings.split('\n')) {
    for (const m of line.matchAll(re)) out.add(m[0].trimEnd());
  }
  return [...out];
}

/** `node:test` has no bare `skip()` outside a context, so say it where it will be read. */
function t_skip(why) {
  console.error(`\n  SKIPPED (loudly): ${why}\n`);
}
