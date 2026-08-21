#!/usr/bin/env node
// @ts-check
/**
 * `leakcheck` — the deterministic half of the leak gate.
 *
 * It scans every **tracked** file, because tracked is what gets published, and applies the
 * catalogue in `.github/leakcheck/rules.mjs`. It needs no dependencies and no network: node
 * builtins and `git ls-files`, so it runs identically on a laptop and on a runner, and it
 * cannot be defeated by an `npm ci` that fails.
 *
 * Two design decisions are worth knowing before changing anything here.
 *
 * **It never sniffs for binary.** Four tracked source files in this repository contain literal
 * NUL bytes in string fixtures. Git calls them binary and `git grep` skips them without `-a`;
 * one of them holds a real finding. Text-ness is decided by extension, never by content.
 *
 * **It fails only on what is new.** `baseline.json` records the findings that already exist,
 * keyed by rule, path and matched text rather than by line number, so reflowing a paragraph
 * does not resurrect a finding and moving a leak to a new file does not hide it. That lets the
 * gate go on today and the backlog come down on its own schedule. `--strict` ignores the
 * baseline, which is what the release job runs.
 *
 * Usage:
 *
 *   node .github/scripts/leakcheck.mjs                  # gate: fail on new blocking findings
 *   node .github/scripts/leakcheck.mjs --strict         # fail on every blocking finding
 *   node .github/scripts/leakcheck.mjs --update-baseline
 *   node .github/scripts/leakcheck.mjs --json           # machine-readable
 *   node .github/scripts/leakcheck.mjs --sarif out.sarif
 *   node .github/scripts/leakcheck.mjs --paths a.md b.md
 *
 * Exit codes: 0 clean · 1 blocking findings · 2 bad usage.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = repoRoot();
const RULES_PATH = join(REPO, '.github/leakcheck/rules.mjs');
const BASELINE_PATH = join(REPO, '.github/leakcheck/baseline.json');

const { CONFIG, RULES } = await import(pathToFileURL(RULES_PATH).href);

/**
 * A denylist published in the repository it guards leaks its own denylist. Most rules here are
 * shapes rather than names and are safe in the open — but a few have to match one specific
 * private string, and those belong in `rules.local.mjs`, which is gitignored: present in the
 * source repository, absent from this one. Missing is the normal case, not an error.
 */
const LOCAL_RULES_PATH = join(REPO, '.github/leakcheck/rules.local.mjs');
if (existsSync(LOCAL_RULES_PATH)) {
  const local = await import(pathToFileURL(LOCAL_RULES_PATH).href);
  if (Array.isArray(local.RULES)) RULES.push(...local.RULES);
}

/* -------------------------------------------------------------------------- */
/* args                                                                        */
/* -------------------------------------------------------------------------- */

const HELP = `leakcheck — what may not be published from this repository

  --strict              fail on every blocking finding, ignoring the baseline
  --update-baseline     rewrite baseline.json from the current tree, then exit 0
  --json                machine-readable findings on stdout
  --sarif <path>        also write SARIF 2.1.0 for the GitHub Security tab
  --rev <ref>           scan the tree of a commit instead of the working tree
  --paths <p...>        scan only these paths (still must be tracked)
  --quiet               blocking findings in full; warnings as one line
  --no-annotations      suppress ::error/::warning workflow commands
  -h, --help            this
`;

function parseArgs(argv) {
  const out = { strict: false, updateBaseline: false, json: false, sarif: '', paths: [], annotations: true, rev: '', quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--strict') out.strict = true;
    else if (a === '--update-baseline') out.updateBaseline = true;
    else if (a === '--json') out.json = true;
    else if (a === '--no-annotations') out.annotations = false;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--sarif') out.sarif = String(argv[++i] || '');
    else if (a === '--rev') out.rev = String(argv[++i] || '');
    else if (a === '--paths') { while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.paths.push(argv[++i]); }
    else if (a === '-h' || a === '--help') { process.stdout.write(HELP); process.exit(0); }
    else { process.stderr.write(`leakcheck: unknown flag ${a}\n${HELP}`); process.exit(2); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/* -------------------------------------------------------------------------- */
/* repository                                                                  */
/* -------------------------------------------------------------------------- */

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return resolve(HERE, '../..');
  }
}

/**
 * Where the bytes come from. Two sources, one interface.
 *
 * The working tree is the default and is what a developer means by "scan this". `--rev` reads a
 * commit's tree instead, which is what a `pre-push` hook needs: the thing being published is the
 * commit, not whatever happens to be checked out beside it. Pushing a branch you are not
 * standing on is ordinary, and scanning the working tree in that case would check the wrong
 * code and pass.
 */
function source(rev) {
  if (!rev) {
    return {
      list: () => execFileSync('git', ['-C', REPO, 'ls-files', '-z'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean),
      size: (p) => { try { return statSync(join(REPO, p)).size; } catch { return -1; } },
      read: (p) => { try { return readFileSync(join(REPO, p), 'utf8'); } catch { return null; } },
    };
  }
  const git = (args, enc) => execFileSync('git', ['-C', REPO, ...args],
    { encoding: enc, maxBuffer: 256 * 1024 * 1024 });
  return {
    list: () => git(['ls-tree', '-r', '-z', '--name-only', rev], 'utf8').split('\0').filter(Boolean),
    size: (p) => { try { return Number(git(['cat-file', '-s', `${rev}:${p}`], 'utf8').trim()); } catch { return -1; } },
    read: (p) => { try { return git(['show', `${rev}:${p}`], 'utf8'); } catch { return null; } },
  };
}

/* -------------------------------------------------------------------------- */
/* globs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A deliberately small glob: `**` crosses separators, `*` does not, `?` is one character.
 * Everything else is literal. Anything a rule needs beyond this belongs in a real predicate,
 * not in a pattern language nobody can read.
 */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i += 1; if (glob[i + 1] === '/') i += 1; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

const globCache = new Map();
function matchesGlob(path, glob) {
  let re = globCache.get(glob);
  if (!re) { re = globToRegExp(glob); globCache.set(glob, re); }
  return re.test(path);
}

const matchesAny = (path, globs) => Array.isArray(globs) && globs.some((g) => matchesGlob(path, g));

/**
 * One RegExp per rule for the whole run. Building them per line looks harmless and is not:
 * twenty rules across eighty thousand lines is 1.6 million constructions, and it turns a
 * two-second scan into a two-minute one.
 */
const compiledRules = new Map();
function compile(rule) {
  let re = compiledRules.get(rule.id);
  if (!re) {
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`;
    re = new RegExp(rule.pattern.source, flags);
    compiledRules.set(rule.id, re);
  }
  return re;
}

/* -------------------------------------------------------------------------- */
/* findings                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A finding's identity is the rule, the file and the matched text — never the line number.
 * A paragraph reflow moves every line in a runbook; none of that is a new leak. Moving the
 * same string into a different file *is* new, and this keys on the path so it is caught.
 */
function fingerprint(rule, path, match) {
  const normalized = String(match).replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha1').update(`${rule}\u0000${path}\u0000${normalized}`).digest('hex').slice(0, 16);
}

/** `leakcheck-allow: <rule-id>` on the line, or on the line above it. */
function suppressed(lines, index, ruleId) {
  const check = (s) => {
    if (!s) return false;
    const m = /leakcheck-allow:\s*([A-Za-z0-9_*,\s-]+)/.exec(s);
    if (!m) return false;
    return m[1].split(/[,\s]+/).filter(Boolean).some((t) => t === '*' || t === ruleId);
  };
  return check(lines[index]) || check(lines[index - 1]);
}

const isPlaceholder = (s) => {
  const low = String(s).toLowerCase();
  return CONFIG.placeholderMarkers.some((marker) => low.includes(marker));
};

/**
 * Rule-specific judgement that a regex should not be asked to carry. Returning false drops
 * the match silently — these are the cases where the pattern is right and the hit is not.
 */
function keepMatch(rule, matched) {
  if (rule.id === 'personal-data') {
    return !CONFIG.allowedEmails.includes(matched.toLowerCase());
  }
  if (rule.id === 'credential-material' || rule.id === 'assigned-secret') {
    if (CONFIG.knownPublicExamples.some((ex) => matched.includes(ex) || ex.includes(matched))) return false;
    return !isPlaceholder(matched);
  }
  if (rule.id === 'production-identifier') {
    // A run id is only production data if it looks minted rather than typed. `cc-parent-11112222`
    // is a fixture; `cc-mubit-ux-ba269335` is a real run. Two or three distinct characters in the
    // suffix is a human at a keyboard, and every id carrying a placeholder word is one too.
    if (isPlaceholder(matched)) return false;
    const suffix = matched.slice(-8);
    return new Set(suffix).size > 3;
  }
  return true;
}

function isTextPath(path) {
  const ext = extname(path).toLowerCase();
  if (CONFIG.textExtensions.includes(ext)) return true;
  // Extensionless files that are conventionally text.
  return ['LICENSE', 'README', 'Makefile', 'Dockerfile'].includes(path.split('/').pop() || '');
}

function ruleApplies(rule, path) {
  if (rule.include && !matchesAny(path, rule.include)) return false;
  if (rule.exclude && matchesAny(path, rule.exclude)) return false;
  return true;
}

/**
 * Runs of consecutive comment lines, joined into one string with their leading markers and
 * indentation stripped, so a sentence that wraps across three lines is one haystack. The line
 * number reported is the first line of the run — where a reader will start looking.
 *
 * @param {string[]} lines
 * @returns {Array<{line:number, text:string}>}
 */
function commentBlocks(lines) {
  const isComment = (l) => /^\s*(?:\*|\/\/|#|--)/.test(l) && !/^\s*\/\/\s*$/.test(l);
  const strip = (l) => l.replace(/^\s*(?:\*\/|\/\*+|\*|\/\/+|#|--)\s?/, '').trim();
  const out = [];
  let start = -1;
  let buf = [];
  const flush = () => {
    if (start !== -1 && buf.length > 1) out.push({ line: start + 1, text: buf.join(' ') });
    start = -1; buf = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    if (isComment(lines[i])) {
      if (start === -1) start = i;
      buf.push(strip(lines[i]));
    } else flush();
  }
  flush();
  return out;
}

/* -------------------------------------------------------------------------- */
/* inline sourcemaps                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A bundler asked for an inline sourcemap will happily base64 the *original source* of every
 * module it consumed into the artifact, under `sourcesContent`. When some of those modules came
 * from a private sibling package, their source is now in a public repository — comments and all
 * — inside a single four-megabyte line that no reviewer will ever open.
 *
 * The test is not "does this file have a sourcemap". Most of the committed bundles do, and
 * theirs only carry sources that are themselves tracked here, which leaks nothing. The test is
 * whether the map carries content for a source this repository does not have.
 *
 * @returns {string[]} source paths whose original text is embedded but not tracked here
 */
function embeddedForeignSources(path, src, tracked) {
  if (!/\.(?:js|mjs|cjs)$/.test(path)) return [];
  const text = src.read(path);
  if (text === null) return [];
  const at = text.lastIndexOf('sourceMappingURL=data:');
  if (at === -1) return [];
  const encoded = /base64,([A-Za-z0-9+/=]+)/.exec(text.slice(at));
  if (!encoded) return [];

  let map;
  try { map = JSON.parse(Buffer.from(encoded[1], 'base64').toString('utf8')); } catch { return []; }
  const sources = Array.isArray(map.sources) ? map.sources : [];
  const contents = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
  if (contents.length === 0) return [];

  const basenames = new Set(tracked.map((p) => p.split('/').pop()));
  const foreign = [];
  for (let i = 0; i < sources.length; i += 1) {
    if (!contents[i]) continue;
    const src = String(sources[i]);
    if (src.includes('node_modules/')) continue;          // third-party, published already
    if (basenames.has(src.split('/').pop() || '')) continue; // we ship this source ourselves
    foreign.push(src);
  }
  return foreign;
}

/* -------------------------------------------------------------------------- */
/* scan                                                                        */
/* -------------------------------------------------------------------------- */

function scan(paths, allTracked, src) {
  /** @type {Array<{rule:string,severity:string,path:string,line:number,match:string,why:string,fix:string,fingerprint:string}>} */
  const findings = [];
  const contentRules = RULES.filter((r) => r.kind === 'content');
  const pathRules = RULES.filter((r) => r.kind === 'path');

  for (const path of paths) {
    if (matchesAny(path, CONFIG.excludePaths)) continue;

    const size = src.size(path);
    if (size < 0) continue;

    /* --- path rules: about the shape of the tree, not its contents --- */
    for (const rule of pathRules) {
      if (!ruleApplies(rule, path)) continue;
      const re = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', ''));
      if (re.test(path)) {
        findings.push(record(rule, path, 1, path));
      }
    }

    /* --- structural rules --- */
    if (size > CONFIG.oversizedBytes) {
      const rule = RULES.find((r) => r.id === 'oversized-artifact');
      if (rule) findings.push(record(rule, path, 1, `${(size / 1024 / 1024).toFixed(1)} MB`));
    }

    const foreign = embeddedForeignSources(path, src, allTracked);
    if (foreign.length) {
      const rule = RULES.find((r) => r.id === 'inline-sourcemap-sources');
      // One finding per embedded source, so removing some and not others is visible.
      if (rule) for (const src of foreign) findings.push(record(rule, path, 1, src));
    }

    /* --- content rules --- */
    if (!isTextPath(path)) continue;
    const heavy = size > CONFIG.maxTextBytes;
    const applicable = contentRules.filter((r) => (heavy ? r.heavy : true) && ruleApplies(r, path));
    if (applicable.length === 0) continue;
    const compiled = applicable.map((rule) => ({ rule, re: compile(rule) }));

    const text = src.read(path);
    if (text === null) continue;
    const lines = text.split('\n');

    /**
     * Two passes over the same file.
     *
     * The first is line by line, which is what a reader expects. The second joins each run of
     * consecutive comment lines into one string and matches against that, because prose wraps
     * and a rule anchored to a line is defeated by a line break — "collapses every user,
     * project and machine into one\n * run" matched nothing until this existed. Findings are
     * deduplicated by fingerprint, so a phrase that fits on one line is reported once.
     */
    const seen = new Set();
    const consider = (rule, re, haystack, lineNo) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(haystack)) !== null) {
        if (m[0] === '') { re.lastIndex += 1; continue; }
        if (!keepMatch(rule, m[0])) continue;
        if (suppressed(lines, lineNo - 1, rule.id)) continue;
        const f = record(rule, path, lineNo, m[0]);
        if (seen.has(f.fingerprint)) continue;
        seen.add(f.fingerprint);
        findings.push(f);
      }
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) continue;
      for (const { rule, re } of compiled) consider(rule, re, line, i + 1);
    }

    for (const block of commentBlocks(lines)) {
      for (const { rule, re } of compiled) consider(rule, re, block.text, block.line);
    }
  }

  findings.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path)));
  return findings;
}

function record(rule, path, line, match) {
  return {
    rule: rule.id,
    severity: rule.severity,
    path,
    line,
    match: String(match).slice(0, 200),
    why: rule.why,
    fix: rule.fix,
    fingerprint: fingerprint(rule.id, path, match),
  };
}

/* -------------------------------------------------------------------------- */
/* baseline                                                                    */
/* -------------------------------------------------------------------------- */

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return { entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

function writeBaseline(findings) {
  // Only blocking findings are carried. A warning never fails a build, so recording one buys
  // nothing and would put 1 800 section references in a file nobody can read.
  // Deliberately NOT the matched text. The fingerprint already hashes it, so the baseline
  // stays stable without it — and this file is committed to a public repository, where a list
  // of every leaked string would be a better index of them than anything an attacker could
  // build by hand.
  const entries = {};
  for (const f of findings.filter((x) => x.severity === 'block')) {
    entries[f.fingerprint] = { rule: f.rule, path: f.path };
  }
  const body = {
    _comment: [
      'Findings that already exist in the tree, so the gate can be enforced before the backlog',
      'is cleared. Anything not listed here fails CI. Entries are keyed by rule + path + matched',
      'text, so a reflow does not resurrect one and moving a leak to another file does not hide it.',
      'Shrink this file; never grow it to make a build pass. Regenerate: node .github/scripts/leakcheck.mjs --update-baseline',
    ].join(' '),
    generated_from: `${Object.keys(entries).length} findings`,
    entries,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(body, null, 2)}\n`);
}

/* -------------------------------------------------------------------------- */
/* output                                                                      */
/* -------------------------------------------------------------------------- */

const RESET = '[0m';
const paint = (code, s) => (process.stdout.isTTY ? `[${code}m${s}${RESET}` : s);

function report(findings, baseline) {
  const isNew = (f) => !baseline.entries[f.fingerprint];
  const blocking = findings.filter((f) => f.severity === 'block' && (args.strict || isNew(f)));
  const carried = findings.filter((f) => f.severity === 'block' && !args.strict && !isNew(f));
  const warnings = findings.filter((f) => f.severity === 'warn');

  const byRule = (list) => {
    const map = new Map();
    for (const f of list) map.set(f.rule, [...(map.get(f.rule) || []), f]);
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  };

  const lines = [];
  const section = (title, list, colour) => {
    if (list.length === 0) return;
    lines.push('', paint(colour, `${title} — ${list.length}`), '');
    for (const [ruleId, group] of byRule(list)) {
      const rule = RULES.find((r) => r.id === ruleId);
      lines.push(paint('1', `  ${ruleId}`) + paint('2', ` (${group.length})`));
      lines.push(paint('2', `    why: ${rule?.why || ''}`));
      lines.push(paint('2', `    fix: ${rule?.fix || ''}`));
      for (const f of group.slice(0, 12)) {
        lines.push(`      ${f.path}:${f.line}  ${paint('33', truncate(f.match, 90))}`);
      }
      if (group.length > 12) lines.push(paint('2', `      … and ${group.length - 12} more`));
      lines.push('');
    }
  };

  section('BLOCKING', blocking, '31');
  // A push gate that prints six hundred advisory lines is a push gate people learn to scroll
  // past. Blocking findings are the ones that stop the push, so they are the ones with detail.
  if (args.quiet) {
    if (warnings.length) {
      const kinds = new Set(warnings.map((f) => f.rule)).size;
      lines.push(paint('2', `  ${warnings.length} warning${warnings.length === 1 ? '' : 's'} across ${kinds} rule${kinds === 1 ? '' : 's'} — see them with: node .github/scripts/leakcheck.mjs --strict`));
    }
  } else {
    section('WARNING', warnings, '33');
  }
  if (carried.length) {
    lines.push(paint('2', `Carried in baseline — ${carried.length} blocking findings already in the tree.`));
    lines.push(paint('2', 'Run with --strict to see them, and shrink baseline.json as they are cleared.'), '');
  }
  if (blocking.length === 0 && warnings.length === 0) {
    lines.push('', paint('32', 'leakcheck: clean.'), '');
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  if (args.annotations && process.env.GITHUB_ACTIONS === 'true') {
    for (const f of blocking) annotate('error', f);
    for (const f of warnings.slice(0, 50)) annotate('warning', f);
  }
  if (process.env.GITHUB_STEP_SUMMARY) summary(blocking, warnings, carried);

  return { blocking, warnings, carried };
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Workflow commands must be one line; newlines are escaped or the annotation is dropped. */
function annotate(level, f) {
  const msg = `${f.why} — ${f.fix}`.replace(/\r?\n/g, '%0A').replace(/::/g, ':');
  process.stdout.write(`::${level} file=${f.path},line=${f.line},title=leakcheck: ${f.rule}::${msg}\n`);
}

function summary(blocking, warnings, carried) {
  const rows = [];
  rows.push('## leakcheck', '');
  rows.push(blocking.length ? `**${blocking.length} blocking finding(s).** This tree must not be published as it stands.`
    : '**No new blocking findings.**');
  rows.push('', `| | count |`, `| --- | ---: |`,
    `| blocking (new) | ${blocking.length} |`,
    `| warnings | ${warnings.length} |`,
    `| blocking (baselined debt) | ${carried.length} |`, '');
  if (blocking.length) {
    rows.push('### Blocking', '', '| rule | file | line | match |', '| --- | --- | ---: | --- |');
    for (const f of blocking.slice(0, 60)) {
      rows.push(`| \`${f.rule}\` | \`${f.path}\` | ${f.line} | \`${truncate(f.match.replace(/\|/g, '\\|'), 60)}\` |`);
    }
    rows.push('');
  }
  try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${rows.join('\n')}\n`); } catch { /* summary is a nicety */ }
}

function sarif(findings) {
  const rules = [...new Set(findings.map((f) => f.rule))].map((id) => {
    const r = RULES.find((x) => x.id === id);
    return {
      id,
      shortDescription: { text: r?.why?.slice(0, 120) || id },
      fullDescription: { text: `${r?.why || ''}\n\nFix: ${r?.fix || ''}` },
      defaultConfiguration: { level: r?.severity === 'block' ? 'error' : 'warning' },
    };
  });
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'leakcheck', informationUri: 'https://github.com/mubit-ai/claude-plugins', rules } },
      results: findings.map((f) => ({
        ruleId: f.rule,
        level: f.severity === 'block' ? 'error' : 'warning',
        message: { text: `${f.why} Fix: ${f.fix}` },
        locations: [{ physicalLocation: {
          artifactLocation: { uri: f.path },
          region: { startLine: Math.max(1, f.line) },
        } }],
        partialFingerprints: { leakcheck: f.fingerprint },
      })),
    }],
  };
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

const src = source(args.rev);
const tracked = src.list();
const targets = args.paths.length ? tracked.filter((p) => args.paths.includes(p)) : tracked;
const findings = scan(targets, tracked, src);

if (args.updateBaseline) {
  writeBaseline(findings);
  process.stdout.write(`leakcheck: baseline written — ${findings.filter((f) => f.severity === 'block').length} blocking findings carried (of ${findings.length} total) in .github/leakcheck/baseline.json\n`);
} else {

  if (args.sarif) writeFileSync(args.sarif, `${JSON.stringify(sarif(findings), null, 2)}\n`);

  /**
   * Set `exitCode` rather than calling `process.exit()`. Exiting outright truncates a pending
   * write when stdout is a pipe, which is exactly how CI consumes `--json` — the reader gets a
   * JSON string that ends mid-token and a scanner that looks like it crashed.
   */
  if (args.json) {
    const baseline = readBaseline();
    process.stdout.write(`${JSON.stringify({
      scanned: targets.length,
      findings: findings.map((f) => ({ ...f, baselined: Boolean(baseline.entries[f.fingerprint]) })),
    }, null, 2)}\n`);
    const blocking = findings.filter((f) => f.severity === 'block' && (args.strict || !baseline.entries[f.fingerprint]));
    process.exitCode = blocking.length ? 1 : 0;
  } else {
    const { blocking } = report(findings, readBaseline());
    process.exitCode = blocking.length ? 1 : 0;
  }
}
