// @ts-check
/**
 * `lib/import.mjs` — backfilling memory from the transcripts already on disk.
 *
 * ---------------------------------------------------------------------------
 * What this is for
 * ---------------------------------------------------------------------------
 * The plugin is hooks-only, so a fresh install knows nothing that happened before it, and a
 * hook that times out or is dropped loses that turn permanently. The transcripts are still
 * there. This reads them.
 *
 * ---------------------------------------------------------------------------
 * Four properties of the corpus that decided the design
 * ---------------------------------------------------------------------------
 * Measured against a real `~/.claude/projects`, not taken from a document.
 *
 * 1. **The directory name is lossy and not invertible.** `~/.claude/projects/<dir>` encodes a
 *    path with `/`, `.` and `_` all becoming `-`, so the name cannot be turned back into a
 *    directory. The authority for where a session happened is the `cwd` field *inside the
 *    records* — and `cwd` **changes mid-file**: one observed session held 458 records at a
 *    repo root and 565 under a subdirectory of it. One run id per file mis-attributes more
 *    than half of it, so the run id is resolved per record, the way `resolveProjectDir`
 *    already does for a live hook.
 *
 * 2. **A large share of the corpus is invisible to `projects/*​/*.jsonl`.** Subagent
 *    transcripts live under `<session-uuid>/subagents/agent-*.jsonl`, and large tool results
 *    are offloaded to `<session-uuid>/tool-results/*.txt` with only a truncated preview left
 *    in the transcript line. Both are walked; the offloaded bodies are deliberately *not*
 *    followed — see `PERSISTED_MARK`.
 *
 * 3. **A tool call and its result are on different lines**, joined by
 *    `tool_use.id` ↔ `tool_result.tool_use_id` — the call on an `assistant` line, the result
 *    on a `user` line. Nothing in this repository joined them before, because every live hook
 *    is handed both halves in one payload. **The join is mandatory rather than convenient:**
 *    `hasDeniedSubject` reads `PATH_KEYS` off the *call*, and a file's body arrives on the
 *    *result* line with no path field anywhere on it. A reader that walked lines
 *    independently would get the contents of a `.env` with no stage-2 protection at all.
 *
 * 4. **`tool_use_id` is in the transcripts verbatim**, so an imported item can carry the
 *    byte-identical `item_id` live capture would have written — `cc-<tool_use_id>`. That is
 *    the single most valuable property available here and the design is built around it.
 *
 * ---------------------------------------------------------------------------
 * Which side of the idempotency claim is being made
 * ---------------------------------------------------------------------------
 * Two different claims live under the word "idempotent" and only one of them is ours:
 *
 *   - **Ours, and tested.** A re-run imports nothing. The cursor for each file records the
 *     byte offset of the last complete line consumed, so a second run over an unchanged file
 *     reads zero lines and posts zero batches. This is bookkeeping this module owns.
 *   - **Not ours.** That the *server* stores one entry when it is sent `cc-<id>` twice. The
 *     ids are minted to make that possible and nothing here verifies it, because nothing here
 *     can. `lib/activity.mjs`'s note about the export is the same shape of statement.
 *
 * A third asymmetry, stated for the same reason: the **item id** of an imported tool call is
 * byte-identical to the live one by construction. Its **text** is not guaranteed to be —
 * `hooks/src/capture.mjs` owns the live renderer and `lib/` may not import a hook, so the
 * renderer below is a faithful copy rather than the same code. `test/import.test.mjs` pins
 * the id and the metadata shape, and says outright that it does not pin the text.
 *
 * ---------------------------------------------------------------------------
 * Why it does not use the ordinary spool
 * ---------------------------------------------------------------------------
 * `runs/<run_id>/spool/*.json` expires at 24 h. An import that spooled more than one drain
 * cycle's worth would silently lose its tail — the failure would look like a successful
 * import with less in it than the transcripts held. So this has its own ingest loop, its own
 * rate limiter and its own cursors, and posts directly.
 *
 * `{record: false}` throughout, for the reason the brief states as a rule: this runs on a
 * deadline looser than `MUBIT_CC_TIMEOUT_MS`, and thousands of calls that can vote on the
 * breaker would open it — which then suppresses recall and the capture drain — over a
 * background job nobody is waiting on.
 *
 * ---------------------------------------------------------------------------
 * Bounds are reported, never applied quietly
 * ---------------------------------------------------------------------------
 * Every limit here answers into `truncatedReason`, the contract `lib/activity.mjs` already
 * uses: a report that says "1,204 items" while having silently stopped at a cap is worse than
 * one that says it stopped, because the first one reads as completeness.
 *
 * Constraints shared with the rest of `lib/`: zero dependencies, Node >= 20 built-ins, no
 * import outside `lib/`, and nothing here throws.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { classifyTool, classifyTurn } from './classify.mjs';
import { envTags } from './config.mjs';
import { fileChanges } from './filechange.mjs';
import { postIngest } from './http.mjs';
import { log } from './log.mjs';
import { isDeniedPath, isSelfReference, redactParams, redactText, warmIgnoreCache } from './redact.mjs';
import { deriveRunId } from './runid.mjs';
import { ensureDir, readJson, resolveDataDir, writeJsonAtomic } from './state.mjs';
import { messageRecord, messageText, parseLine, readForward, statOf, toolBlocks } from './transcript.mjs';

// ---------------------------------------------------------------------------
// Where the transcripts are
// ---------------------------------------------------------------------------

/** The host's transcript root. Overridable so a test never reads the real one. */
export const TRANSCRIPT_ROOT_ENV = 'MUBIT_CC_TRANSCRIPT_ROOT';

/** §7: `import/<hash>.json`, one cursor per transcript file. */
export const CURSOR_DIR = 'import';

/** Bumped only if the cursor shape changes; an unknown version reads as no cursor. */
const CURSOR_VERSION = 1;

/** The marker the host leaves where a large tool result was offloaded to its own file. */
const PERSISTED_MARK = '<persisted-output>';

/**
 * Text that arrives on a `user` line and is not something a user said.
 *
 * Measured on a real transcript: of four `user` records carrying text, **one** was a prompt.
 * The other three were a `<local-command-caveat>` the host prepends, a
 * `<command-name>/clear</command-name>` envelope around a slash command, and
 * `[Request interrupted by user for tool use]`. Importing those as prompts fills memory with
 * the harness talking to itself — and worse, an interrupt notice landing mid-turn would close
 * the real turn early and split one episode into two.
 *
 * A slash command is refused for the reason `hooks/src/prompt-recall.mjs` refuses one on the
 * live path: it is addressed to the harness, not to the model.
 */
const HOST_NOTICE_RE = /^(?:<(?:local-command-caveat|command-name|command-message|command-args|system-reminder|persisted-output)\b|\[Request interrupted|\/)/;

// ---------------------------------------------------------------------------
// Bounds — every one of them reported
// ---------------------------------------------------------------------------

/** Items in one ingest request. Matches `batchMaxItems`, which the drain also honours. */
const DEFAULT_BATCH = 32;

/** Milliseconds between ingest requests. A backfill must not look like an attack. */
const DEFAULT_PACE_MS = 200;

/** The per-request deadline. Far looser than `MUBIT_CC_TIMEOUT_MS`; hence `{record: false}`. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** The default ceiling on one invocation, so an unbounded corpus cannot become an unbounded run. */
const DEFAULT_MAX_ITEMS = 5000;

/** How much of a tool result is kept. `maxOutputBytes` governs the scrub; this bounds the read. */
const MAX_TAIL_CHARS = 4000;

/** How much of a prompt or answer is kept in one item. */
const MAX_TEXT_CHARS = 8000;

/** `renderParams`' bounds, copied from `hooks/src/capture.mjs` — see the header. */
const MAX_RENDER_ITEMS = 24;
const MAX_VALUE_CHARS = 400;
const MAX_RENDER_DEPTH = 2;
const MAX_ID_CHARS = 128;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * The host's own lossy encoding of a project directory: every `/`, `.` and `_` becomes `-`.
 *
 * Used only as a **filter**, never as an answer. Because three characters collapse onto one,
 * two different directories can encode to the same name and a name cannot be decoded back —
 * so this narrows which directories are worth opening and the `cwd` inside the records
 * decides what is actually imported.
 *
 * @param {string} dir
 * @returns {string}
 */
export function encodeProjectDir(dir) {
  return String(dir ?? '').replace(/[/._]/g, '-');
}

/** @returns {string} the transcript root, honouring the test override. */
export function transcriptRoot(env = process.env) {
  const override = typeof env?.[TRANSCRIPT_ROOT_ENV] === 'string' ? env[TRANSCRIPT_ROOT_ENV].trim() : '';
  return override || join(homedir(), '.claude', 'projects');
}

/**
 * @typedef {object} Transcript
 * @property {string} path
 * @property {string} sessionId  the file's own uuid; a subagent carries its parent's
 * @property {string} agentId    `agent-…` for a subagent transcript, `''` for a session
 * @property {string} dirName    the encoded project directory it was found under
 */

/**
 * Every transcript under the root, sessions and subagents alike.
 *
 * The subagent half is not optional. Those transcripts are a large share of the corpus and
 * are invisible to a `projects/*​/*.jsonl` glob — they sit one level down under
 * `<session-uuid>/subagents/`. An importer that missed them would report a successful backfill
 * having skipped most of what the fan-outs did.
 *
 * `tool-results/*.txt` is deliberately **not** collected. Those are the offloaded bodies of
 * results too large to inline, and the transcript keeps a preview of each. Importing the full
 * body would mean storing a megabyte of one tool's output as one memory, which is not a
 * memory — and it is exactly the material the byte caps exist to refuse.
 *
 * @param {{root?: string, dirFilter?: (dirName: string) => boolean, maxFiles?: number}} [opts]
 * @returns {{files: Transcript[], dirs: number, truncatedReason: string}}
 */
export function discoverTranscripts(opts = {}) {
  const root = typeof opts?.root === 'string' && opts.root ? opts.root : transcriptRoot();
  const maxFiles = posInt(opts?.maxFiles, 0);
  /** @type {Transcript[]} */
  const files = [];
  let dirs = 0;
  let truncatedReason = '';

  try {
    for (const dir of dirEntries(root)) {
      if (!dir.isDirectory()) continue;
      if (typeof opts?.dirFilter === 'function' && !opts.dirFilter(dir.name)) continue;
      dirs += 1;
      const dirPath = join(root, dir.name);

      for (const e of dirEntries(dirPath)) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          files.push({
            path: join(dirPath, e.name),
            sessionId: e.name.slice(0, -6),
            agentId: '',
            dirName: dir.name,
          });
          continue;
        }
        if (!e.isDirectory()) continue;
        const subDir = join(dirPath, e.name, 'subagents');
        for (const s of dirEntries(subDir)) {
          if (!s.isFile() || !s.name.endsWith('.jsonl')) continue;
          files.push({
            path: join(subDir, s.name),
            sessionId: e.name,
            agentId: s.name.slice(0, -6),
            dirName: dir.name,
          });
        }
      }
      if (maxFiles && files.length >= maxFiles) {
        truncatedReason = `stopped after ${maxFiles} transcript file(s); more remain`;
        break;
      }
    }
  } catch {
    // An unreadable root is an install with no transcripts, which is a real state.
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: maxFiles ? files.slice(0, maxFiles) : files, dirs, truncatedReason };
}

/**
 * The directories an import defaults to: the project it is run in, plus every git worktree
 * linked to the same repository.
 *
 * A worktree is a different absolute path and therefore a different project directory to the
 * host, but it is the same work — and `worktree-state` / `relocated` records are the only
 * thing in a transcript that ties one back to its origin. Defaulting to the current project
 * alone would miss most of a multi-worktree project's history; defaulting to everything would
 * ship the whole machine, which is why `--all` is a flag somebody types.
 *
 * @param {string} projectDir
 * @returns {string[]} absolute directories, the first of which is `projectDir`
 */
export function linkedRoots(projectDir) {
  const start = typeof projectDir === 'string' ? projectDir.trim() : '';
  if (!start) return [];
  const out = [resolve(start)];
  try {
    const r = spawnSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: start, encoding: 'utf8', timeout: 5000,
    });
    if (r.status !== 0 || typeof r.stdout !== 'string') return out;
    for (const line of r.stdout.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const p = resolve(line.slice('worktree '.length).trim());
      if (p && !out.includes(p)) out.push(p);
    }
  } catch {
    // No git, no worktrees, or a repository this process cannot read: the current directory
    // on its own is a correct answer, just a narrower one.
  }
  return out;
}

/**
 * Is `cwd` inside one of `roots`? Prefix matching on a resolved path with a separator, so
 * `/r/app` does not match `/r/application`.
 * @param {string} cwd @param {string[]} roots @returns {string}
 */
export function rootFor(cwd, roots) {
  const c = typeof cwd === 'string' && cwd.trim() ? resolve(cwd.trim()) : '';
  if (!c) return '';
  for (const r of Array.isArray(roots) ? roots : []) {
    const base = resolve(String(r));
    if (c === base || c.startsWith(base + sep)) return base;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Cursors — `import/<hash>.json`
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Cursor
 * @property {number} offset      byte offset of the end of the last consumed line
 * @property {number} lineCount   lines consumed so far
 * @property {number} sequence    ingest batches posted for this file
 * @property {number} sizeBytes   the file's size when the cursor was written
 * @property {number} mtimeMs
 * @property {number} at
 */

/** @param {Record<string, any>} cfg @param {string} path @returns {string} */
export function cursorPath(cfg, path) {
  const h = createHash('sha256').update(String(path ?? ''), 'utf8').digest('hex').slice(0, 16);
  return join(resolveDataDir(cfg), CURSOR_DIR, `${h}.json`);
}

/**
 * The stored cursor, or a zero one.
 *
 * A file that has shrunk below its stored offset was rotated or replaced, and the honest
 * answer is to start over: resuming into the middle of a different file would import a line
 * fragment as a record. A file that has merely grown resumes.
 *
 * @param {Record<string, any>} cfg @param {string} path @returns {Cursor}
 */
export function readCursor(cfg, path) {
  const zero = { offset: 0, lineCount: 0, sequence: 0, sizeBytes: 0, mtimeMs: 0, at: 0 };
  try {
    const raw = readJson(cursorPath(cfg, path), null);
    if (!isObject(raw) || raw.v !== CURSOR_VERSION) return zero;
    const cur = {
      offset: nonNeg(raw.offset),
      lineCount: nonNeg(raw.lineCount),
      sequence: nonNeg(raw.sequence),
      sizeBytes: nonNeg(raw.sizeBytes),
      mtimeMs: nonNeg(raw.mtimeMs),
      at: nonNeg(raw.at),
    };
    // A file that has SHRUNK below its stored offset was rotated or replaced, and resuming
    // into the middle of a different file would read a line fragment as a record. A file that
    // cannot be read at all (`size: 0`) is a different thing and must not clobber the cursor:
    // a transient read error would otherwise re-import the whole file on the next run.
    const now = statOf(path);
    if (now.size > 0 && now.size < cur.offset) return zero;
    return cur;
  } catch {
    return zero;
  }
}

/** @param {Record<string, any>} cfg @param {string} path @param {Cursor} cur @returns {boolean} */
export function writeCursor(cfg, path, cur) {
  try {
    const p = cursorPath(cfg, path);
    if (!ensureDir(join(resolveDataDir(cfg), CURSOR_DIR))) return false;
    return writeJsonAtomic(p, {
      v: CURSOR_VERSION,
      path: String(path ?? ''),
      offset: nonNeg(cur?.offset),
      lineCount: nonNeg(cur?.lineCount),
      sequence: nonNeg(cur?.sequence),
      sizeBytes: nonNeg(cur?.sizeBytes),
      mtimeMs: nonNeg(cur?.mtimeMs),
      at: Date.now(),
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// One file → items
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ImportedItem
 * @property {string} runId    which run this item belongs to, from the record's own `cwd`
 * @property {string} cwd
 * @property {Record<string, any>} item  an ingest item, shaped as `hooks/src/capture.mjs` shapes one
 */

/**
 * Read one transcript from its cursor and turn it into items.
 *
 * The loop holds one piece of state that a live hook never needs: **pending tool calls**. A
 * call is seen on an `assistant` line and its result arrives some lines later on a `user`
 * line, so a call is held until its result appears and only then becomes an item. A call
 * whose result never arrives — the session ended mid-tool — is dropped rather than stored as
 * half an episode, which is the same rule `capture --stop-failure` applies to a turn.
 *
 * @param {Record<string, any>} cfg
 * @param {string} path
 * @param {{from?: number, roots?: string[], maxItems?: number, projectDir?: string}} [opts]
 * @returns {{items: ImportedItem[], offset: number, lines: number, skipped: number,
 *            denied: number, oversize: number, truncatedReason: string}}
 */
export function importItems(cfg, path, opts = {}) {
  /** @type {ImportedItem[]} */
  const items = [];
  const roots = Array.isArray(opts?.roots) ? opts.roots : [];
  const maxItems = posInt(opts?.maxItems, 0);
  let offset = nonNeg(opts?.from);
  let lines = 0;
  let skipped = 0;
  let denied = 0;
  let oversize = 0;
  let truncatedReason = '';

  /** `tool_use.id` → the call, until its result turns up. */
  const pending = new Map();
  /** The directory the records are currently in. It changes mid-file; see the header. */
  let cwd = '';
  let sessionId = '';
  /** The turn being accumulated: one prompt and every assistant message that follows it. */
  let turn = null;

  for (const line of readForward(path, { from: offset })) {
    lines += 1;
    offset = line.offset;
    if (line.oversize) { oversize += 1; continue; }

    const entry = parseLine(line.text);
    if (!entry) { skipped += 1; continue; }

    if (typeof entry.cwd === 'string' && entry.cwd.trim()) cwd = entry.cwd.trim();
    if (typeof entry.sessionId === 'string' && entry.sessionId.trim()) sessionId = entry.sessionId.trim();

    // The scope decision, made per record rather than per file, because `cwd` changes mid-file.
    const root = roots.length ? rootFor(cwd, roots) : (cwd || opts?.projectDir || '');
    if (roots.length && !root) { skipped += 1; continue; }

    const { uses, results } = toolBlocks(entry);
    for (const u of uses) pending.set(u.id, { ...u, cwd, root, sessionId });

    for (const r of results) {
      const call = pending.get(r.id);
      pending.delete(r.id);
      // A result with no call is the far side of a window that started mid-conversation, or a
      // call whose line was over the reader's cap. Storing it would be a result with no idea
      // what produced it.
      if (!call) { skipped += 1; continue; }
      const built = toolItem(cfg, call, r, opts);
      if (built === 'denied') { denied += 1; continue; }
      if (built) items.push(built);
    }

    // Conversation, accumulated into turns rather than emitted per message.
    //
    // A live `Stop` stores one item per turn — `Q: <prompt>\n\nA: <answer>` — and a turn is
    // several transcript lines: the prompt, then any number of assistant messages with tool
    // calls between them. Pairing the prompt with the *first* assistant message would throw
    // away the summary at the end, which is usually the most useful sentence in the turn. So
    // an answer accumulates until the next prompt closes it.
    const said = spoken(entry);
    if (said.role === 'user' && said.text) {
      const done = closeTurn(cfg, turn, opts);
      if (done) items.push(done);
      turn = { prompt: said.text, answer: [], cwd, root, sessionId };
    } else if (said.role === 'assistant' && said.text && turn) {
      if (turn.answer.join('\n').length < MAX_TEXT_CHARS) turn.answer.push(said.text);
    }

    if (maxItems && items.length >= maxItems) {
      truncatedReason = `stopped at ${maxItems} item(s) from this transcript; it holds more`;
      break;
    }
  }

  // The last turn in the file has no following prompt to close it, so it is closed here.
  const last = closeTurn(cfg, turn, opts);
  if (last) items.push(last);

  // Calls with no result are dropped, deliberately and countably: half an episode stored as a
  // whole one is the failure `capture --stop-failure` refuses for the same reason.
  skipped += pending.size;
  return { items, offset, lines, skipped, denied, oversize, truncatedReason };
}

/**
 * One joined call+result as an ingest item, `null` when there is nothing worth storing, and
 * the string `'denied'` when stage 2 refused it.
 *
 * The three gates are `capture.mjs`'s, in its order and for its reasons: bookkeeping tools are
 * dropped, the plugin's own traffic is dropped so memory does not record itself, and a
 * denylisted subject is **dropped rather than scrubbed** — a scrubbed `.env` is still a map of
 * which secrets the project holds.
 *
 * The denylist gets both halves. That is the whole point of the join: the path is on the call
 * and the body is on the result, so a reader with only one of them cannot apply this rule.
 *
 * @param {Record<string, any>} cfg
 * @param {{id: string, name: string, input: Record<string, any>, cwd: string, root: string, sessionId: string}} call
 * @param {{id: string, content: any, isError: boolean}} result
 * @param {{projectDir?: string}} opts
 * @returns {ImportedItem|null|'denied'}
 */
function toolItem(cfg, call, result, opts) {
  try {
    const projectDir = call.root || call.cwd || str(opts?.projectDir) || str(cfg?.projectDir);
    if (isSelfReference(call.name, call.input, { ...cfg, projectDir })) return null;
    if (deniedSubject(call, cfg, projectDir)) return 'denied';

    const failed = result.isError === true;
    const cls = attempt(
      () => classifyTool(call.name, call.input, failed ? 'failure' : 'ok'),
      { intent: 'tool_output', importance: 'low' },
    );

    const scrubbed = attempt(() => redactParams(call.input, cfg), { params: null, redactions: 0 });
    const params = attempt(
      () => redactText(renderParams(scrubbed.params), cfg, 'param'),
      { text: '', redactions: 0, truncated: false },
    );
    const rawTail = resultText(result.content).slice(0, MAX_TAIL_CHARS);
    const tail = attempt(
      () => redactText(rawTail, cfg, 'output'),
      { text: '', redactions: 0, truncated: false },
    );
    if (!params.text.trim() && !tail.text.trim()) return null;

    const toolName = clamp(str(call.name) || 'Tool', 128);
    const text = failed
      ? `${toolName}(${params.text}) FAILED: ${tail.text}`
      : `${toolName}(${params.text}) -> ${tail.text}`;

    const changes = failed ? [] : attempt(() => fileChanges(call.name, call.input), []);
    const runId = runIdFor(cfg, projectDir);
    if (!runId) return null;

    return {
      runId,
      cwd: call.cwd,
      item: item(cfg, {
        // The property the whole design is built on: byte-identical to what live capture
        // would have written for this call, so the two paths dedupe against each other.
        id: `cc-${clamp(str(call.id), MAX_ID_CHARS)}`,
        text,
        intent: cls.intent,
        importance: cls.importance,
        projectDir,
        metadata: {
          tool: toolName,
          tool_use_id: str(call.id),
          hook_event: failed ? 'PostToolUseFailure' : 'PostToolUse',
          session_id: call.sessionId,
          outcome: failed ? 'failure' : 'ok',
          truncated: !!(params.truncated || tail.truncated),
          redactions: num(scrubbed.redactions) + num(params.redactions) + num(tail.redactions),
          ...(changes.length ? { files: changes } : {}),
          // The one field a live item does not carry, and the reason it is here: an imported
          // memory is evidence about the past reconstructed after the fact, and a reader
          // comparing two entries about the same call should be able to tell which is which.
          imported: true,
        },
      }),
    };
  } catch {
    return null;
  }
}

/**
 * `hasDeniedSubject`'s rule, applied to a joined call — and to the paths `fileChanges` finds
 * inside an `apply_patch` body, which no key names.
 * @returns {boolean}
 */
function deniedSubject(call, cfg, projectDir) {
  const input = isObject(call.input) ? call.input : {};
  for (const key of PATH_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v && isDeniedPath(v, cfg, projectDir)) return true;
  }
  const edits = Array.isArray(input.edits) ? input.edits.slice(0, MAX_RENDER_ITEMS) : [];
  for (const e of edits) {
    if (!isObject(e)) continue;
    for (const key of PATH_KEYS) {
      const v = e[key];
      if (typeof v === 'string' && v && isDeniedPath(v, cfg, projectDir)) return true;
    }
  }
  for (const c of attempt(() => fileChanges(call.name, input), [])) {
    if (isDeniedPath(c.path, cfg, projectDir)) return true;
  }
  return false;
}

/** `tool_input` keys that name a file on disk. The same list `capture.mjs` and `redact.mjs` hold. */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'notebookPath', 'target_file'];

/**
 * What one line says, and who said it. Tool blocks are excluded — they become items of their
 * own through the join — so this uses the renderer's default rather than `includeTools`. An
 * assistant message that was nothing but tool calls therefore renders empty, which is right:
 * its episode is the calls.
 *
 * @param {Record<string, any>} entry
 * @returns {{role: string, text: string}}
 */
function spoken(entry) {
  try {
    const record = messageRecord(entry);
    const role = str(record.role) || str(entry.type);
    if (role !== 'user' && role !== 'assistant') return { role: '', text: '' };
    const body = messageText(record.content ?? entry.content ?? entry.text).trim();
    if (!body) return { role, text: '' };
    // The host writes `<persisted-output>` where it moved a large result to its own file, and
    // the rest of `HOST_NOTICE_RE` covers the other things it says in a user's voice.
    if (role === 'user' && HOST_NOTICE_RE.test(body)) return { role, text: '' };
    if (body.startsWith(PERSISTED_MARK)) return { role, text: '' };
    return { role, text: body };
  } catch {
    return { role: '', text: '' };
  }
}

/**
 * One accumulated turn as an item, or `null`.
 *
 * Shaped as a live `Stop` shapes one — `Q: <prompt>\n\nA: <answer>`, graded through
 * `classifyTurn` — because a reader should not be able to tell an imported turn from a
 * captured one by looking at it. Both halves are required, on `capture.mjs`'s rule that half
 * a conversation is not a memory.
 *
 * **The id is content-addressed, and this is the one place the import cannot match live
 * capture's.** A live turn item is `cc-stop-<prompt_id>`. The transcript does carry a
 * `promptId`, and it is not a turn key: measured on a real session it was present on 42 of
 * 109 conversational records and held **two** distinct values across the whole file. Using it
 * would collapse a session's turns into two items. Hashing the text keeps the property the id
 * exists for — the same turn twice is one item — and gives up matching the live path, which
 * `test/import.test.mjs` states rather than leaves to be discovered.
 *
 * @param {Record<string, any>} cfg
 * @param {{prompt: string, answer: string[], cwd: string, root: string, sessionId: string}|null} turn
 * @param {{projectDir?: string}} opts
 * @returns {ImportedItem|null}
 */
function closeTurn(cfg, turn, opts) {
  try {
    if (!turn || !turn.prompt) return null;
    const answer = turn.answer.join('\n').trim();
    if (!answer) return null;

    const projectDir = turn.root || turn.cwd || str(opts?.projectDir) || str(cfg?.projectDir);
    const runId = runIdFor(cfg, projectDir);
    if (!runId) return null;

    const q = attempt(() => redactText(turn.prompt.slice(0, MAX_TEXT_CHARS), cfg, 'output'),
      { text: '', redactions: 0, truncated: false });
    const a = attempt(() => redactText(answer.slice(0, MAX_TEXT_CHARS), cfg, 'output'),
      { text: '', redactions: 0, truncated: false });
    if (!q.text.trim() && !a.text.trim()) return null;

    const cls = attempt(() => classifyTurn('', '', { event: 'Stop' }),
      { intent: 'task_result', importance: 'medium' });

    const digest = sha16(`${turn.sessionId}|${q.text}|${a.text}`);
    return {
      runId,
      cwd: turn.cwd,
      item: item(cfg, {
        id: `cc-import-turn-${digest}`,
        text: `Q: ${q.text}\n\nA: ${a.text}`,
        intent: cls.intent,
        importance: cls.importance,
        projectDir,
        metadata: {
          hook_event: 'Stop',
          session_id: turn.sessionId,
          truncated: !!(q.truncated || a.truncated),
          redactions: num(q.redactions) + num(a.redactions),
          imported: true,
        },
      }),
    };
  } catch {
    return null;
  }
}

/** The ingest item shape, as `hooks/src/capture.mjs` builds one. */
function item(cfg, o) {
  return {
    item_id: clamp(o.id, MAX_ID_CHARS),
    content_type: 'text',
    text: o.text,
    intent: o.intent || 'tool_output',
    importance: o.importance || 'low',
    source: 'agent',
    // Unix SECONDS. Milliseconds here date every memory to the year 57000.
    occurrence_time: Math.floor(Date.now() / 1000),
    env_tags: attempt(() => envTags(cfg, o.projectDir), ['tool:claude-code']),
    metadata_json: safeJson(o.metadata),
  };
}

/** @type {Map<string, string>} */
const _runIdCache = new Map();

/**
 * The run id a live hook would have derived for this directory.
 *
 * Passing only `{cwd}` — no `session_id` — is deliberate: with no host session there is no
 * session map, so `deriveRunId` takes its fresh per-directory derivation, which is the stable
 * base id that directory always gets. A live session may carry a `-cN` clear counter on top
 * of it; an import has no way to know which clear a historical turn belonged to, and
 * inventing one would scatter a session across runs that never existed.
 *
 * Memoised because it can shell out to git and `cwd` changes many times per file.
 */
function runIdFor(cfg, projectDir) {
  const dir = str(projectDir);
  if (!dir) return '';
  const key = `${str(cfg?.dataDir)}|${dir}`;
  const hit = _runIdCache.get(key);
  if (hit !== undefined) return hit;
  let runId = '';
  try {
    runId = deriveRunId({ ...cfg, projectDir: dir }, { cwd: dir });
  } catch {
    runId = '';
  }
  _runIdCache.set(key, runId);
  return runId;
}

// ---------------------------------------------------------------------------
// The import itself
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ImportReport
 * @property {number} files       transcripts opened
 * @property {number} lines       lines consumed
 * @property {number} items       items posted
 * @property {number} batches     ingest requests made
 * @property {number} denied      items dropped by the path denylist
 * @property {number} skipped     lines that produced nothing
 * @property {number} oversize    lines over the reader's cap
 * @property {number} failed      batches the server refused
 * @property {number} ms
 * @property {boolean} dryRun
 * @property {string} truncatedReason  `''` when nothing was bounded away
 * @property {string[]} runs      run ids written to
 */

/**
 * Walk the transcripts and ingest what they hold.
 *
 * @param {Record<string, any>} cfg
 * @param {{roots?: string[], all?: boolean, dryRun?: boolean, maxItems?: number,
 *          maxFiles?: number, batchSize?: number, paceMs?: number, timeoutMs?: number,
 *          root?: string, sleep?: (ms: number) => Promise<void>}} [opts]
 * @returns {Promise<ImportReport>}
 */
export async function runImport(cfg, opts = {}) {
  const started = Date.now();
  const dryRun = opts?.dryRun === true;
  const batchSize = posInt(opts?.batchSize, posInt(cfg?.batchMaxItems, DEFAULT_BATCH));
  const paceMs = Math.max(0, Math.trunc(numOr(opts?.paceMs, DEFAULT_PACE_MS)));
  const timeoutMs = posInt(opts?.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxItems = posInt(opts?.maxItems, DEFAULT_MAX_ITEMS);
  const sleep = typeof opts?.sleep === 'function' ? opts.sleep : defaultSleep;

  const roots = opts?.all === true
    ? []
    : (Array.isArray(opts?.roots) && opts.roots.length
      ? opts.roots.map((r) => resolve(String(r)))
      : linkedRoots(str(cfg?.projectDir) || process.cwd()));

  // The encoded names are a filter and nothing more — two directories can encode alike and a
  // name cannot be decoded, so a candidate that passes here is still decided by its records.
  const prefixes = roots.map(encodeProjectDir);
  const dirFilter = prefixes.length
    ? (name) => prefixes.some((p) => name === p || name.startsWith(p))
    : undefined;

  const found = discoverTranscripts({ root: opts?.root, dirFilter, maxFiles: posInt(opts?.maxFiles, 0) });

  /** @type {ImportReport} */
  const report = {
    files: 0, lines: 0, items: 0, batches: 0, denied: 0, skipped: 0, oversize: 0, failed: 0,
    ms: 0, dryRun, truncatedReason: found.truncatedReason, runs: [],
  };
  const runs = new Set();
  let budget = maxItems;

  for (const t of found.files) {
    if (budget <= 0) {
      report.truncatedReason = report.truncatedReason
        || `stopped at ${maxItems} item(s); ${found.files.length - report.files} transcript(s) not read`;
      break;
    }

    const cursor = readCursor(cfg, t.path);
    const before = statOf(t.path);
    if (before.size <= cursor.offset) continue; // nothing new — the re-run no-op

    report.files += 1;
    const read = importItems(cfg, t.path, {
      from: cursor.offset, roots, maxItems: budget, projectDir: roots[0],
    });
    report.lines += read.lines;
    report.skipped += read.skipped;
    report.denied += read.denied;
    report.oversize += read.oversize;
    if (read.truncatedReason && !report.truncatedReason) report.truncatedReason = read.truncatedReason;

    // One `git check-ignore` for the whole file's worth of paths, before anything asks about
    // one. Without this the import is dominated by `git` forks — see `warmIgnoreCache`.
    if (roots.length) {
      attempt(() => warmIgnoreCache(read.items.flatMap((i) => filesOf(i)), roots[0]), 0);
    }

    let sequence = cursor.sequence;
    let posted = 0;
    let ok = true;

    for (const [runId, batch] of batches(read.items, batchSize)) {
      runs.add(runId);
      report.batches += 1;
      if (dryRun) { posted += batch.length; continue; }

      if (paceMs > 0 && report.batches > 1) await sleep(paceMs);
      const res = await postIngest(cfg, {
        run_id: runId,
        idempotency_key: `cc-import-${sha16(`${runId}|${batch.map((i) => i.item_id).join('|')}`)}`,
        parallel: true,
        items: batch,
      }, { timeoutMs, record: false });

      sequence += 1;
      if (!res.ok) {
        report.failed += 1;
        ok = false;
        log(cfg, 'warn', `import: ingest failed (${str(res.state) || 'unknown'})`,
          { run_id: runId, error: str(res.error).slice(0, 300) });
        break;
      }
      posted += batch.length;
    }

    report.items += posted;
    budget -= posted;

    // The cursor advances only on a clean pass. A partial one leaves it where it was, so the
    // next run re-reads the file from the last known-good point: re-sending an item is free —
    // it carries the same `item_id` — and losing one is not.
    if (ok && !dryRun) {
      writeCursor(cfg, t.path, {
        offset: read.offset,
        lineCount: cursor.lineCount + read.lines,
        sequence,
        sizeBytes: before.size,
        mtimeMs: before.mtimeMs,
        at: Date.now(),
      });
    }
    if (!ok) {
      report.truncatedReason = report.truncatedReason
        || 'stopped after an ingest failure; the cursor was not advanced, so a re-run resumes here';
      break;
    }
  }

  report.runs = [...runs].sort();
  report.ms = Date.now() - started;
  return report;
}

/**
 * Items grouped by run and cut into batches. Grouped because `run_id` is a field of the
 * *request*, not of an item: a batch that spanned two runs would file half of it under the
 * wrong one.
 * @param {ImportedItem[]} items @param {number} size
 * @returns {Array<[string, Record<string, any>[]]>}
 */
function batches(items, size) {
  /** @type {Map<string, Record<string, any>[]>} */
  const byRun = new Map();
  for (const i of Array.isArray(items) ? items : []) {
    if (!i || !i.runId || !i.item) continue;
    const list = byRun.get(i.runId) ?? [];
    list.push(i.item);
    byRun.set(i.runId, list);
  }
  /** @type {Array<[string, Record<string, any>[]]>} */
  const out = [];
  for (const [runId, list] of byRun) {
    for (let i = 0; i < list.length; i += size) out.push([runId, list.slice(i, i + size)]);
  }
  return out;
}

/** Every path an item's `metadata_json.files` names, for the batched ignore warm. */
function filesOf(imported) {
  try {
    const meta = JSON.parse(imported?.item?.metadata_json ?? '{}');
    return Array.isArray(meta.files) ? meta.files.map((f) => str(f?.path)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Rendering — a faithful copy of `hooks/src/capture.mjs`'s, see the header
// ---------------------------------------------------------------------------

/** `key=value, key=value`, flat, human-readable, bounded in every dimension. */
function renderParams(params) {
  if (params === null || params === undefined) return '';
  if (typeof params !== 'object') return renderValue(params, MAX_RENDER_DEPTH);
  if (Array.isArray(params)) return renderValue(params, 1);

  const parts = [];
  let n = 0;
  for (const [k, v] of Object.entries(params)) {
    if (n >= MAX_RENDER_ITEMS) { parts.push('…'); break; }
    n += 1;
    parts.push(`${clamp(String(k), 64)}=${clamp(renderValue(v, 1), MAX_VALUE_CHARS)}`);
  }
  return parts.join(', ');
}

function renderValue(v, depth) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const t = typeof v;
  if (t === 'string') return v;
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
  if (t === 'function' || t === 'symbol') return `[${t}]`;
  if (depth >= MAX_RENDER_DEPTH) return Array.isArray(v) ? '[…]' : '{…}';
  if (Array.isArray(v)) return `[${v.slice(0, MAX_RENDER_ITEMS).map((x) => renderValue(x, depth + 1)).join(', ')}]`;
  const parts = [];
  let n = 0;
  for (const [k, val] of Object.entries(v)) {
    if (n >= MAX_RENDER_ITEMS) { parts.push('…'); break; }
    n += 1;
    parts.push(`${k}=${renderValue(val, depth + 1)}`);
  }
  return `{${parts.join(', ')}}`;
}

/** A `tool_result.content`, which is a string on some hosts and a block array on others. */
function resultText(content) {
  if (typeof content === 'string') return content;
  return messageText(content, { includeTools: true });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function dirEntries(p) {
  try {
    return existsSync(p) && statSync(p).isDirectory() ? readdirSync(p, { withFileTypes: true }) : [];
  } catch {
    return [];
  }
}

const defaultSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function sha16(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return '{}';
  }
}

function attempt(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function clamp(v, max) {
  const s = typeof v === 'string' ? v : String(v ?? '');
  return s.length > max ? s.slice(0, max) : s;
}

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOr(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

function nonNeg(v) {
  const n = numOr(v, 0);
  return n > 0 ? Math.trunc(n) : 0;
}

function posInt(v, d) {
  const n = numOr(v, NaN);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : d;
}
