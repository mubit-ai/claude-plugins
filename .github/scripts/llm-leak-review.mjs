#!/usr/bin/env node
// @ts-check
/**
 * `llm-leak-review` — the half of the gate that reads prose.
 *
 * `leakcheck.mjs` catches a leak that says a forbidden word. The expensive leaks do not: a
 * paragraph that explains how retrieval ranks, written entirely in ordinary English, matches no
 * pattern anyone would think to write. So this sends the diff — only the added lines — to a
 * model together with `.github/leakcheck/POLICY.md`, and asks one question: does anything here
 * publish something the policy says stays private?
 *
 * Three properties it is built to have:
 *
 *   **It only sees what is already public.** The diff is from a public repository, so nothing
 *   leaves that has not already left. That is worth stating because a leak-detection tool that
 *   uploads a private tree is a leak-detection tool that leaks.
 *
 *   **It fails open on infrastructure and closed on findings.** No key, a 500, a malformed
 *   response: warn and exit 0, because a review gate that goes red when a vendor has a bad
 *   afternoon gets disabled within a week. A parsed `block` finding exits 1.
 *
 *   **It never blocks on its own opinion alone.** The model returns severities; only `block`
 *   fails, and the prompt tells it to reserve that for the categories the policy calls
 *   unrecoverable. Everything else is a comment for a human.
 *
 * Configuration, all optional except the key:
 *
 *   LEAKCHECK_API_KEY / OPENAI_API_KEY / CODEX_API_KEY   the credential
 *   LEAKCHECK_BASE_URL   default https://api.openai.com/v1
 *   LEAKCHECK_MODEL      default gpt-5-codex
 *   LEAKCHECK_MAX_DIFF   default 180000 characters of added lines
 *
 * Usage: node .github/scripts/llm-leak-review.mjs --base <ref> [--json] [--comment]
 * Exit codes: 0 clean, or could not run · 1 blocking findings · 2 bad usage.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = (() => {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); }
  catch { return join(HERE, '../..'); }
})();

const API_KEY = process.env.LEAKCHECK_API_KEY || process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || '';
const BASE_URL = (process.env.LEAKCHECK_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const MODEL = process.env.LEAKCHECK_MODEL || 'gpt-5-codex';
const MAX_DIFF = Number(process.env.LEAKCHECK_MAX_DIFF || 180000);

/* -------------------------------------------------------------------------- */
/* args                                                                        */
/* -------------------------------------------------------------------------- */

const args = { base: '', json: false, comment: false };
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a === '--base') args.base = String(process.argv[++i] || '');
  else if (a === '--json') args.json = true;
  else if (a === '--comment') args.comment = true;
  else if (a === '-h' || a === '--help') {
    process.stdout.write('usage: llm-leak-review --base <ref> [--json] [--comment]\n');
    process.exit(0);
  } else { process.stderr.write(`llm-leak-review: unknown flag ${a}\n`); process.exit(2); }
}

const skip = (why) => {
  process.stdout.write(`llm-leak-review: skipped — ${why}\n`);
  note(`### llm-leak-review\n\nSkipped — ${why}\n`);
  process.exit(0);
};

function note(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown); } catch { /* a nicety */ }
}

if (!API_KEY) skip('no API key in LEAKCHECK_API_KEY / OPENAI_API_KEY / CODEX_API_KEY');

/* -------------------------------------------------------------------------- */
/* the diff                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Added lines only, with their file and line number. A leak is something that *arrives*;
 * sending removed lines back to a model wastes budget and invites findings on text that a
 * pull request is in the middle of deleting.
 */
function addedLines(base) {
  let raw = '';
  try {
    raw = execFileSync('git', ['-C', REPO, 'diff', '--unified=0', '--no-color', `${base}...HEAD`],
      { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  } catch {
    try {
      raw = execFileSync('git', ['-C', REPO, 'diff', '--unified=0', '--no-color', base],
        { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    } catch { return []; }
  }

  const out = [];
  let file = '';
  let line = 0;
  for (const l of raw.split('\n')) {
    if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (l.startsWith('+') && !l.startsWith('+++')) {
      const text = l.slice(1);
      if (text.trim()) out.push({ file, line, text });
      line += 1;
    }
  }
  return out;
}

const base = args.base || process.env.GITHUB_BASE_REF || 'origin/main';
const added = addedLines(base.includes('/') ? base : `origin/${base}`);
if (added.length === 0) skip(`no added lines against ${base}`);

/** Rendered as `path:line: text`, so a finding can name a location the model actually saw. */
let payload = '';
let truncated = 0;
for (const a of added) {
  const row = `${a.file}:${a.line}: ${a.text}\n`;
  if (payload.length + row.length > MAX_DIFF) { truncated += 1; continue; }
  payload += row;
}

/* -------------------------------------------------------------------------- */
/* the ask                                                                     */
/* -------------------------------------------------------------------------- */

const policyPath = join(REPO, '.github/leakcheck/POLICY.md');
const policy = existsSync(policyPath) ? readFileSync(policyPath, 'utf8') : '';

const SYSTEM = `You review changes to a PUBLIC repository holding a plugin for a closed-source
product called Mubit. Your single job is to find text that publishes something the policy below
keeps private. You are not a code reviewer: ignore bugs, style, naming and test coverage.

${policy}

Additional judgement you must apply, because a regex cannot:

1. A sentence can leak a mechanism without using any special vocabulary. "Anything not marked
   as belonging to one run is shown to the others" is the same disclosure as naming the overlay.
   Judge the claim, not the wording.
2. Client behaviour is fine. A request field, an endpoint path, a retry policy, a response field
   and a local cache are all things a user can observe. Do not report them.
3. Report a security-relevant sentence at "block" even when it reads as an ordinary code comment.
   The test: could a reader use this sentence to decide what request to send without our client?
4. Do not report a finding you cannot anchor to a specific added line you were shown.
5. Prefer silence to noise. Zero findings is a normal, correct answer.

Return ONLY a JSON object, no prose, no code fence:
{"findings":[{"file":"...","line":123,"severity":"block"|"warn","category":"...","quote":"the exact text","why":"one sentence","fix":"one sentence"}]}

Use "block" only for: closed-source paths or internal spec references; server-side mechanism;
security posture or an unfixed defect; personal data, credentials, or third-party binary
extraction. Everything else is "warn".`;

const USER = `Added lines from this change${truncated ? ` (${truncated} lines omitted for size)` : ''}:

${payload}`;

/* -------------------------------------------------------------------------- */
/* the call                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Tries the Responses API and falls back to Chat Completions, so this works against OpenAI,
 * against a Codex-flavoured endpoint, and against any of the OpenAI-compatible gateways a
 * team ends up in front of. The shape of the reply is normalised to a single string.
 */
async function ask() {
  const attempts = [
    {
      url: `${BASE_URL}/responses`,
      body: { model: MODEL, input: [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER }] },
      read: (j) => j.output_text
        || (Array.isArray(j.output)
          ? j.output.flatMap((o) => (o.content || []).map((c) => c.text || '')).join('')
          : ''),
    },
    {
      url: `${BASE_URL}/chat/completions`,
      body: { model: MODEL, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER }] },
      read: (j) => j?.choices?.[0]?.message?.content || '',
    },
  ];

  let lastError = '';
  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify(attempt.body),
        signal: AbortSignal.timeout(300000),
      });
      if (!res.ok) { lastError = `${attempt.url} → ${res.status} ${(await res.text()).slice(0, 300)}`; continue; }
      const text = attempt.read(await res.json());
      if (text) return text;
      lastError = `${attempt.url} → empty response`;
    } catch (err) {
      lastError = `${attempt.url} → ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  throw new Error(lastError || 'no response');
}

/** Models add fences and preambles however firmly you ask them not to. */
function parseFindings(text) {
  const cleaned = String(text).replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch {
    return null;
  }
}

let raw;
try {
  raw = await ask();
} catch (err) {
  skip(`model call failed — ${err instanceof Error ? err.message : String(err)}`);
}

const findings = parseFindings(raw);
if (findings === null) skip(`could not parse the model's reply (${String(raw).slice(0, 200)}…)`);

/* -------------------------------------------------------------------------- */
/* report                                                                      */
/* -------------------------------------------------------------------------- */

const seen = new Set(added.map((a) => `${a.file}:${a.line}`));
const anchored = findings.filter((f) => f && f.file && seen.has(`${f.file}:${Number(f.line)}`));
const drifted = findings.length - anchored.length;

const blocking = anchored.filter((f) => f.severity === 'block');
const warnings = anchored.filter((f) => f.severity !== 'block');

if (args.json) {
  process.stdout.write(`${JSON.stringify({ model: MODEL, findings: anchored, drifted }, null, 2)}\n`);
} else {
  if (anchored.length === 0) {
    process.stdout.write(`llm-leak-review: clean (${MODEL}, ${added.length} added lines).\n`);
  }
  for (const f of anchored) {
    const level = f.severity === 'block' ? 'error' : 'warning';
    const msg = `${f.why} — ${f.fix}`.replace(/\r?\n/g, ' ').replace(/::/g, ':');
    process.stdout.write(`${f.file}:${f.line}  [${f.severity}] ${f.category}: ${f.why}\n`);
    if (process.env.GITHUB_ACTIONS === 'true') {
      process.stdout.write(`::${level} file=${f.file},line=${f.line},title=llm-leak-review: ${f.category}::${msg}\n`);
    }
  }
  if (drifted) process.stdout.write(`llm-leak-review: dropped ${drifted} finding(s) that named a line not in the diff.\n`);
}

const rows = [`### llm-leak-review (${MODEL})`, ''];
rows.push(anchored.length === 0
  ? `Reviewed ${added.length} added lines. No findings.`
  : `Reviewed ${added.length} added lines — **${blocking.length} blocking**, ${warnings.length} advisory.`);
if (anchored.length) {
  rows.push('', '| severity | file | line | why |', '| --- | --- | ---: | --- |');
  for (const f of anchored.slice(0, 40)) {
    rows.push(`| ${f.severity} | \`${f.file}\` | ${f.line} | ${String(f.why).replace(/\|/g, '\\|')} |`);
  }
}
note(`${rows.join('\n')}\n\n`);

process.exit(blocking.length ? 1 : 0);
