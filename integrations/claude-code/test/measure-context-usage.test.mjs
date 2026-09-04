// @ts-check
/**
 * `scripts/measure-context-usage.mjs` — what the plugin actually cost, read off the transcripts.
 *
 * The static surface is measured by `measure-context-cost.mjs` and declared in the manifest.
 * This script measures the half that grows with a session — hook injections and tool results —
 * and it is the number every change in this series claims to move. So it has to attribute
 * correctly: an injection to the hook that made it, a tool result to its tool, a prompt only
 * when a person typed one, and nothing from another plugin's hooks.
 *
 * Transcripts are synthesised here in the shape Claude Code writes them: one JSON object per
 * line, hook output as an `attachment` line, tool results in the user message that follows
 * the call.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mod, tempDir } from './helpers/harness.mjs';

const M = () => mod('scripts/measure-context-usage.mjs');

const line = (o) => `${JSON.stringify(o)}\n`;
const prompt = (text) => line({ type: 'user', message: { role: 'user', content: text } });
const hook = (event, content) => line({ type: 'attachment', attachment: { type: 'hook_additional_context', hookName: event, hookEvent: event, content: [content] } });
const listing = () => line({ type: 'attachment', attachment: { type: 'skill_listing', content: '- mubit-memory:recall: search memory' } });
const call = (id, tool, args = {}) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: `mcp__plugin_mubit-memory_mubit__${tool}`, input: args }] } });
const result = (id, text) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });

const STEER = '# Mubit memory is active\n\nRun: cc-test (hosted)\n';
const RECALL = '<mubit-memory run="cc-test" sources="2" tokens="60">\n## Lessons\n- Poll the job.\n- Never force-push.\n</mubit-memory>';
const PINS_ONLY = '<mubit-memory run="cc-test" sources="0" tokens="0" pins="1">\n- pinned: stay on main\n</mubit-memory>';
const RESUME = '<mubit-resume run="cc-test" sources="3" tokens="200">\nWhere we were: mid-migration.\n</mubit-resume>';

/** A main-conversation transcript with two prompts, a steer, two recalls, a pins-only turn, a resume and two tool calls. */
function mainTranscript() {
  return [
    listing(),
    hook('SessionStart:startup', STEER),
    prompt('first'),
    hook('UserPromptSubmit', RESUME + '\n' + RECALL),
    call('t1', 'mubit_lessons', { limit: 30 }),
    result('t1', 'x'.repeat(4000)),
    prompt('second'),
    hook('UserPromptSubmit', RECALL),
    hook('UserPromptSubmit', PINS_ONLY),
    call('t2', 'mubit_recall', { query: 'q' }),
    result('t2', 'y'.repeat(800)),
    // Another plugin's hook output: never attributed, even when it talks about Mubit, because
    // it carries none of the markers our hooks emit.
    hook('UserPromptSubmit', 'some other plugin says hello'),
    hook('UserPromptSubmit', 'a note from a different hook about the mubit plugin, 400 chars of it '.repeat(6)),
    // A tool result from a tool that is not ours.
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Read', input: {} }] } }),
    result('t3', 'z'.repeat(9000)),
  ].join('');
}

function subagentTranscript() {
  return [
    hook('SubagentStart:Explore', RECALL),
    prompt('do the thing'),
  ].join('');
}

test('analyseTranscript attributes each injection to its hook and each result to its tool', async () => {
  const { analyseTranscript } = await M();
  const s = analyseTranscript(mainTranscript());

  assert.equal(s.prompts, 2, 'only the two typed prompts count; tool results are user-role too');
  assert.equal(s.loaded, true, 'a Mubit skill listing means the plugin was on');
  assert.deepEqual(Object.keys(s.injected).sort(), [
    'SessionStart steer block', 'UserPromptSubmit pins only', 'UserPromptSubmit recall', 'UserPromptSubmit resume briefing',
  ]);
  assert.equal(s.injected['UserPromptSubmit recall'].length, 2, 'two recalls, one of them split off a briefing');
  assert.equal(s.injected['UserPromptSubmit resume briefing'].length, 1);
  assert.ok(s.injected['UserPromptSubmit recall'][0] > s.injected['UserPromptSubmit pins only'][0]);
  assert.deepEqual(Object.keys(s.tools).sort(), ['mubit_lessons', 'mubit_recall']);
  assert.equal(s.tools.mubit_lessons[0], 1000, 'a 4000-char result is 1000 estimated tokens');
  assert.equal(s.tools.mubit_recall[0], 200);
});

test('a subagent transcript is attributed to SubagentStart', async () => {
  const { analyseTranscript } = await M();
  const s = analyseTranscript(subagentTranscript(), { subagent: true });
  assert.deepEqual(Object.keys(s.injected), ['SubagentStart recall']);
  assert.equal(s.subagent, true);
});

test('measure walks the root, keeps subagents out of the session count, and reports per-session totals', async () => {
  const { measure, render } = await M();
  const root = tempDir('mubit-usage-');
  const proj = join(root, '-Users-someone-project');
  mkdirSync(join(proj, 'abc', 'subagents'), { recursive: true });
  writeFileSync(join(proj, 'abc.jsonl'), mainTranscript());
  writeFileSync(join(proj, 'abc', 'subagents', 'agent-1.jsonl'), subagentTranscript());
  writeFileSync(join(proj, 'empty.jsonl'), listing());

  const r = measure(root, { days: 1 });
  assert.equal(r.files, 3);
  assert.equal(r.sessions, 1, 'a transcript with no prompt is not a session, and a subagent is not one either');
  assert.equal(r.loadedSessions, 1);
  assert.equal(r.prompts, 2);
  assert.equal(r.injected['UserPromptSubmit recall'].count, 2);
  assert.equal(r.injected['SubagentStart recall'].count, 1);
  assert.equal(r.tools.mubit_lessons.total, 1000);
  assert.equal(r.perSession.length, 1);
  const expected = Object.values(r.injected).filter((_, i, all) => true).reduce((a, s) => a + s.total, 0)
    - r.injected['SubagentStart recall'].total + r.tools.mubit_lessons.total + r.tools.mubit_recall.total;
  assert.equal(r.perSession[0], expected, 'the per-session total is the main transcript\'s injections plus its tool results');

  const text = render(r);
  assert.match(text, /1 sessions \(1 with the plugin loaded\), 2 prompts, 3 transcripts/);
  assert.match(text, /mubit_lessons\s+1\s+1,000\s+1,000\s+1,000\s+1,000/);
  assert.match(text, /UserPromptSubmit recall\s+2\s+/);
  assert.ok(!text.includes('someone-project'), 'no path below the root is printed');
  assert.ok(!text.includes('Poll the job'), 'no content is printed');
});

test('main: bad flags exit 2, --json is machine-readable', async () => {
  const { main } = await M();
  const root = tempDir('mubit-usage-empty-');
  let out = ''; let err = '';
  const deps = { stdout: (s) => { out += s; }, stderr: (s) => { err += s; } };
  assert.equal(await main(['--nope'], deps), 2);
  assert.match(err, /usage:/);
  assert.equal(await main(['--days', '0'], deps), 2);
  out = '';
  assert.equal(await main(['--projects', root, '--json'], deps), 0);
  const json = JSON.parse(out);
  assert.equal(json.sessions, 0);
  assert.deepEqual(json.perSession, { p50: 0, p90: 0, max: 0 });
});
