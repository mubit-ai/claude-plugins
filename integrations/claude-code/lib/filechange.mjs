// @ts-check
/**
 * `lib/filechange.mjs` — the structured file-change lane, and `runs/<run_id>/files.json`.
 *
 * ---------------------------------------------------------------------------
 * What was there before
 * ---------------------------------------------------------------------------
 * A file path survived capture only as a substring of the prose episode —
 * `Write(file_path=…) -> …` — and only if it fell inside the first 24 rendered keys and the
 * 4096-byte param cap. `PATH_KEYS` existed in two modules and was read for nothing but two
 * drop checks. So "what changed in auth?" had no answer at all, and a recall could not be
 * filtered by the files actually in play.
 *
 * This module structures what capture already parses. It is not new capture.
 *
 * ---------------------------------------------------------------------------
 * Two hosts, two spellings, one record
 * ---------------------------------------------------------------------------
 * | | Claude Code | Codex |
 * | --- | --- | --- |
 * | where the path is | `tool_input.file_path` (and its aliases), `edits[]` under it | nowhere as a key — inside an `apply_patch` blob |
 * | how the kind is known | whether prior text is named | `*** Add/Delete/Update File:` markers |
 *
 * The data model is one row per path: `{path, kinds: ('add'|'delete'|'update')[],
 * occurrences}`, with `kinds` a set in first-seen order and `occurrences` counting every
 * change. A row is aggregated from the changes in hand — the items of one call, or the
 * run's index — and never from a replay of past events, because this plugin keeps no
 * event mirror to replay.
 *
 * ---------------------------------------------------------------------------
 * Where the kind comes from on Claude Code
 * ---------------------------------------------------------------------------
 * The *input* of a `Write` does not say whether it created a file or replaced one, and
 * capture runs after the write, so the filesystem cannot say either. The *result* does:
 * Claude Code's `Write` response is `{type: 'create'|'update', filePath, …}`, and that is
 * the one place the host states the kind outright. So the extractor takes the tool response
 * as an optional third argument and lets a `type` of `create` or `update` on it decide the
 * kind of the call's own subject. It decides only that: it is consulted after the input has
 * already said a change happened, so a `Read` result (`type: 'text'`) cannot promote a read
 * into a change, and it never reaches into `edits[]`, whose entries carry their own prior
 * text.
 *
 * Without a response — an importer reading only the call, a host that spells its result
 * differently — a change that names no prior text reads as `add`. That is what the tool
 * means, it is exactly right on the one input shape that is explicit (an `Edit` with an
 * empty `old_string`), and it is wrong only for an overwrite whose result was not handed in.
 *
 * **`delete` only ever comes from Codex.** Claude Code has no delete tool; a file is removed
 * with `Bash rm`, which carries no path key and is not parsed as a shell command here. A
 * Claude Code run's index therefore never holds a `delete`, and that is a property of the
 * host rather than a gap in this module.
 *
 * ---------------------------------------------------------------------------
 * Why the tool name is not the discriminator
 * ---------------------------------------------------------------------------
 * `hooks/src/capture.mjs` already explains at length why this plugin cannot keep an
 * allowlist of host-owned tool names correct: the host renames them underneath us
 * (`Task` → `Agent`, `KillShell` → `TaskStop`), and Codex renames its shell tool to `Bash`
 * in hook payloads. So the discriminator here is the *shape* of the input — a path key plus
 * something that says content moved, or a body carrying `*** Begin Patch` — and a tool that
 * does not exist yet is understood the day it ships, provided it spells its input like the
 * ones that do.
 *
 * ---------------------------------------------------------------------------
 * Constraints
 * ---------------------------------------------------------------------------
 * Shared with the rest of `lib/`: zero dependencies, Node >= 20 built-ins, no import outside
 * `lib/`, everything synchronous, and **nothing here throws**. Every caller is a hook on a
 * critical path, and the extractor's own input is model-authored text of a size an attacker
 * picks — so every scan is linear and every contribution is bounded.
 */

import { join } from 'node:path';

import { ensureDir, readJson, runDir, writeJsonAtomic } from './state.mjs';

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/** The kinds a change can have. @type {readonly string[]} */
export const FILE_CHANGE_KINDS = Object.freeze(['add', 'delete', 'update']);

/** §7: `runs/<run_id>/files.json`. */
export const FILES_FILE = 'files.json';

/** Bumped only if the on-disk shape changes; an unknown version reads as no data. */
const VERSION = 1;

/**
 * How many changes one tool call may contribute.
 *
 * A patch is model-authored text and a tool call is the one input whose size an attacker
 * picks, so the bound is stated rather than discovered. Thirty-two is far past what a real
 * `apply_patch` touches and matches `MAX_RENDER_ITEMS`, the bound capture already applies to
 * the same `edits[]` array.
 */
export const MAX_CHANGES_PER_EVENT = 32;

/**
 * How many distinct paths one run's index may hold.
 *
 * The file is read synchronously by a hook, and a long run touches a lot of files. The cap
 * drops the least recently touched, because the question this index answers — "what is in
 * play?" — is about now.
 */
export const MAX_INDEXED_PATHS = 256;

/** A path is untrusted input and a key in the stored map. */
const MAX_PATH_CHARS = 512;

/**
 * `tool_input` keys that name a file on disk.
 *
 * The same list `hooks/src/capture.mjs` and `lib/redact.mjs` each carry for their drop
 * checks. It is repeated a third time rather than imported from either, for the reason that
 * governs the whole of `lib/`: this module imports nothing outside `lib/`, and `redact.mjs`
 * would be an import cycle waiting to happen the moment the denylist consults this extractor.
 */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'notebookPath', 'target_file'];

/**
 * Keys naming the text a change *replaces*. Their presence is what separates an update from
 * a create, and their presence-but-empty is how the host spells "create this file".
 */
const PRIOR_KEYS = ['old_string', 'oldString', 'old_source', 'oldSource', 'old_str'];

/** Keys naming the text a change writes. Their presence is what makes it a change at all. */
const CONTENT_KEYS = ['content', 'new_string', 'newString', 'new_source', 'newSource', 'new_str'];

/** Keys that can carry a patch body. `content` is excluded — see `patchBody`. */
const PATCH_BODY_KEYS = ['command', 'patch', 'input'];

/** The marker a patch body must carry before it is parsed as one. */
const PATCH_SENTINEL = '*** Begin Patch';

/**
 * The apply_patch file markers.
 *
 * Anchored per line with `m` rather than split into an array: a patch body can be megabytes,
 * and `String.split` on one allocates the whole of it again. `(.*)$` under `m` is linear and
 * cannot backtrack across lines.
 */
const PATCH_FILE_RE = /^\*\*\* (Add|Delete|Update) File:[ \t]*(.*)$/gm;

/** The destination half of a rename, which follows an `Update File:` for the source. */
const PATCH_MOVE_RE = /^\*\*\* Move to:[ \t]*(.*)$/gm;

// ---------------------------------------------------------------------------
// fileChanges — the extractor
// ---------------------------------------------------------------------------

/**
 * @typedef {object} FileChange
 * @property {string} path
 * @property {'add'|'delete'|'update'} kind
 */

/**
 * Every file change one tool call describes, deduped on `kind` and `path` together and
 * capped at `MAX_CHANGES_PER_EVENT`.
 *
 * Deduped on the pair rather than on the path alone because the two say different things:
 * two edits to one file in one `MultiEdit` are one change, while an add and an update of the
 * same path in one patch are two facts about it. This is the granularity
 * `metadata_json.files` is stored at, so it is the granularity the dedupe has to match.
 *
 * A function of its arguments and nothing else — no clock, no filesystem, no config — so
 * the whole of its behaviour is a table, and `test/file-change.test.mjs` is that table.
 *
 * @param {string|undefined} toolName kept for callers and for the record; the discriminator
 *   is the shape of `toolInput`, for the reason in the header.
 * @param {Record<string, any>|undefined} toolInput
 * @param {any} [toolResponse] the host's result for the call, when the caller has it; only
 *   its `type` is read, and only to settle `add` against `update` for the call's own subject.
 * @returns {FileChange[]}
 */
export function fileChanges(toolName, toolInput, toolResponse) {
  /** @type {FileChange[]} */
  const out = [];
  try {
    const input = isObject(toolInput) ? toolInput : {};
    const seen = new Set();
    /** @param {string} path @param {'add'|'delete'|'update'} kind */
    const push = (path, kind) => {
      if (out.length >= MAX_CHANGES_PER_EVENT) return;
      const p = clampPath(path);
      if (!p) return;
      const key = `${kind}:${p}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ path: p, kind });
    };

    // Codex first: a patch body names its own kinds, so nothing below can improve on it.
    const body = patchBody(input);
    if (body) collectPatch(body, push);

    // Claude Code: a path key on the call itself…
    collectNode(input, '', push, responseKind(toolResponse));

    // …and one level down, which is where `MultiEdit` puts its subjects. `hasDeniedSubject`
    // already descends here and `isSelfReference` does not; this follows the descending one.
    // An edit that names its own path is a change to that path whatever the parent says, and
    // one that names none inherits the parent's — which is the ordinary `MultiEdit` shape.
    const parentPath = firstPath(input);
    const edits = Array.isArray(input.edits) ? input.edits.slice(0, MAX_CHANGES_PER_EVENT) : [];
    for (const e of edits) {
      if (!isObject(e)) continue;
      collectNode(e, parentPath, push);
    }
  } catch {
    // §4.9: a hostile `tool_input` costs the lane, never the item it was attached to.
  }
  return out;
}

/**
 * One node — the call's own input, or one element of `edits[]` — as at most one change.
 * @param {Record<string, any>} node
 * @param {string} fallbackPath used when the node names none of its own
 * @param {(path: string, kind: 'add'|'delete'|'update') => void} push
 * @param {''|'add'|'update'} [stated] the kind the host's result states, if it states one;
 *   consulted only once the node's own input says a change happened
 */
function collectNode(node, fallbackPath, push, stated = '') {
  const path = firstPath(node) || fallbackPath;
  if (!path) return;
  const kind = kindOf(node);
  if (kind) push(path, stated || kind);
}

/**
 * The kind a tool response states outright, or `''` when it states none.
 *
 * Claude Code's `Write` answers `{type: 'create'|'update', …}`. Nothing else on either host
 * spells a kind on the result: an `Edit` response has no `type`, a `Read` response's is
 * `text`, and Codex's `apply_patch` puts the kinds in the call. So the read is one field and
 * one two-way map, and anything else is "the result did not say".
 *
 * @param {any} response
 * @returns {''|'add'|'update'}
 */
function responseKind(response) {
  if (!isObject(response) || typeof response.type !== 'string') return '';
  if (response.type === 'create') return 'add';
  if (response.type === 'update') return 'update';
  return '';
}

/**
 * The kind a node describes, or `''` when it describes no change at all.
 *
 * The `''` case is the one that keeps `Read` and `Glob` out of the lane: both carry a path
 * key and neither says anything moved.
 *
 * @param {Record<string, any>} node
 * @returns {''|'add'|'update'}
 */
function kindOf(node) {
  const prior = firstStringKey(node, PRIOR_KEYS);
  const content = firstStringKey(node, CONTENT_KEYS);
  if (prior === null && content === null) return '';
  // Prior text that is present and non-empty means something was there to replace. Present
  // and empty is how the host spells "create this file", and is the one Claude Code *input*
  // shape where `add` is stated rather than assumed; a `Write` states it on the result
  // instead, which `responseKind` reads.
  if (typeof prior === 'string' && prior.trim() !== '') return 'update';
  return 'add';
}

/**
 * The patch body carried by this input, or `''`.
 *
 * Gated on `PATCH_SENTINEL` with an `indexOf` before any regex runs — a tool call is mostly
 * not a patch, and this is on the capture hook's critical path.
 *
 * `content` is deliberately not one of the keys searched: `Write(file_path=x, content=…)` is
 * already a change to `x`, and a document that happens to quote a patch would otherwise be
 * read as one and credited with changing files it only describes.
 *
 * @param {Record<string, any>} input
 * @returns {string}
 */
function patchBody(input) {
  for (const key of PATCH_BODY_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v.indexOf(PATCH_SENTINEL) !== -1) return v;
  }
  return '';
}

/**
 * @param {string} body
 * @param {(path: string, kind: 'add'|'delete'|'update') => void} push
 */
function collectPatch(body, push) {
  PATCH_FILE_RE.lastIndex = 0;
  let m;
  while ((m = PATCH_FILE_RE.exec(body)) !== null) {
    push(String(m[2]).trim(), /** @type {any} */ (String(m[1]).toLowerCase()));
  }
  // A rename is `*** Update File: <src>` followed by `*** Move to: <dst>`. The source is
  // already recorded as an update by the loop above; the destination did not exist before
  // the call and does after it, which is what `add` means everywhere else here.
  PATCH_MOVE_RE.lastIndex = 0;
  while ((m = PATCH_MOVE_RE.exec(body)) !== null) push(String(m[1]).trim(), 'add');
}

// ---------------------------------------------------------------------------
// summarize — one row per path
// ---------------------------------------------------------------------------

/**
 * @typedef {object} FileDiffSummary
 * @property {string} path
 * @property {string[]} kinds        set, in first-seen order
 * @property {number} occurrences
 */

/**
 * Collapse a list of changes into one row per path, sorted by path.
 *
 * The input is whatever list the caller holds — the changes of one call, or many calls
 * concatenated — and nothing is re-read to build the row: `kinds` is a set in first-seen
 * order and `occurrences` counts every change, both computed from the list alone.
 *
 * Sorted by path because a summary is something a human reads and two runs of the same work
 * should read alike. The per-run index below deliberately does not sort this way — see
 * `readFileChanges`.
 *
 * @param {FileChange[]} changes
 * @returns {FileDiffSummary[]}
 */
export function summarize(changes) {
  try {
    /** @type {Map<string, FileDiffSummary>} */
    const map = new Map();
    for (const c of Array.isArray(changes) ? changes : []) {
      if (!isObject(c)) continue;
      const path = clampPath(c.path);
      const kind = kindOrEmpty(c.kind);
      if (!path || !kind) continue;
      const cur = map.get(path) ?? { path, kinds: [], occurrences: 0 };
      if (!cur.kinds.includes(kind)) cur.kinds.push(kind);
      cur.occurrences += 1;
      map.set(path, cur);
    }
    return [...map.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// runs/<run_id>/files.json
// ---------------------------------------------------------------------------

/**
 * Merge `changes` into the run's index.
 *
 * **Merge, never replace**, for the same reason `lib/rules.mjs` merges: the file is written
 * once per tool call for the life of the run, and a whole-object write would drop everything
 * before it. There is no lock — the last writer wins on a collision, which costs one tool
 * call's worth of index and is repaired by the next one. A lock on the capture path would
 * cost more than the failure it prevents.
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @param {FileChange[]} changes
 * @returns {number} how many paths the index holds afterwards, or 0 on any failure
 */
export function recordFileChanges(cfg, runId, changes) {
  try {
    if (!runId) return 0;
    const incoming = Array.isArray(changes) ? changes : [];
    if (incoming.length === 0) return 0;

    const now = Date.now();
    /** @type {Map<string, {path: string, kinds: string[], occurrences: number, at: number}>} */
    const map = new Map();
    for (const row of readStored(cfg, runId)) map.set(row.path, row);

    /** Paths this call touched, in the order it touched them. */
    const touched = [];
    for (const c of incoming) {
      if (!isObject(c)) continue;
      const path = clampPath(c.path);
      const kind = kindOrEmpty(c.kind);
      if (!path || !kind) continue;
      const cur = map.get(path) ?? { path, kinds: [], occurrences: 0, at: now };
      if (!cur.kinds.includes(kind)) cur.kinds.push(kind);
      cur.occurrences += 1;
      cur.at = now;
      map.set(path, cur);
      if (!touched.includes(path)) touched.push(path);
    }

    // Most recently touched first, then capped — so the cap drops what the run has stopped
    // working on rather than whatever happens to sort last.
    //
    // The order is carried by the array itself rather than derived from `at`. Capture writes
    // here once per tool call and several calls land inside one millisecond, so a sort on the
    // timestamp is a sort on ties: it would reorder untouched rows arbitrarily and put this
    // call's own paths anywhere among the others. `at` stays on each row as data — it is what
    // "when was this last touched" means to a reader — and is not what orders them.
    const rest = [...map.values()].filter((f) => !touched.includes(f.path));
    const files = [...touched.map((p) => map.get(p)), ...rest].slice(0, MAX_INDEXED_PATHS);

    const dir = runDir(cfg, runId);
    // §12.1: a read-only ${CLAUDE_PLUGIN_DATA} costs the index, nothing else.
    if (!ensureDir(dir)) return 0;
    const ok = writeJsonAtomic(join(dir, FILES_FILE), {
      version: VERSION,
      updated_at: now,
      files,
    });
    return ok ? files.length : 0;
  } catch {
    return 0;
  }
}

/**
 * The run's index, most recently touched first.
 *
 * Ordered by when rather than by path, which is where this diverges from `summarize`: a
 * summary is a listing and this is a working set. A recall asking which files
 * are in play wants the ones the run just touched, and the cap has to drop from the other
 * end for the same reason. The order is the stored array's own — see `recordFileChanges` for
 * why it is not derived from the `at` timestamps.
 *
 * `[]` for every kind of absence and every kind of damage — no file, an unreadable one, a
 * torn write, a version this build does not know, a `files` key that is not an array. The
 * caller is a hook with no branch for "the store is broken" that differs from "nothing has
 * been changed yet".
 *
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {Array<{path: string, kinds: string[], occurrences: number, at: number}>}
 */
export function readFileChanges(cfg, runId) {
  return readStored(cfg, runId);
}

/**
 * @param {Record<string, any>} cfg
 * @param {string} runId
 * @returns {Array<{path: string, kinds: string[], occurrences: number, at: number}>}
 */
function readStored(cfg, runId) {
  try {
    if (!runId) return [];
    const stored = readJson(join(runDir(cfg, runId), FILES_FILE), null);
    if (!isObject(stored)) return [];
    if (stored.version !== VERSION) return [];
    if (!Array.isArray(stored.files)) return [];

    const out = [];
    for (const f of stored.files) {
      if (!isObject(f)) continue;
      const path = clampPath(f.path);
      if (!path) continue;
      const kinds = [];
      for (const k of Array.isArray(f.kinds) ? f.kinds : []) {
        const kind = kindOrEmpty(k);
        if (kind && !kinds.includes(kind)) kinds.push(kind);
      }
      if (kinds.length === 0) continue;
      out.push({
        path,
        kinds,
        occurrences: Math.max(1, Math.trunc(numOr(f.occurrences, 1))),
        at: Math.max(0, Math.trunc(numOr(f.at, 0))),
      });
      if (out.length >= MAX_INDEXED_PATHS) break;
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/** The first path key this node carries, clamped, or `''`. @param {Record<string, any>} node */
function firstPath(node) {
  for (const key of PATH_KEYS) {
    const v = node[key];
    if (typeof v === 'string' && v.trim()) return clampPath(v);
  }
  return '';
}

/**
 * The first of `keys` this node carries as a string, or `null` when it carries none.
 * `null` and `''` are different answers here: `''` is "the host said there was nothing
 * before", which is how a create is spelled.
 * @param {Record<string, any>} node @param {readonly string[]} keys @returns {string|null}
 */
function firstStringKey(node, keys) {
  for (const key of keys) {
    const v = node[key];
    if (typeof v === 'string') return v;
  }
  return null;
}

/** @param {any} v @returns {string} */
function clampPath(v) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return t.length > MAX_PATH_CHARS ? t.slice(0, MAX_PATH_CHARS) : t;
}

/** @param {any} v @returns {''|'add'|'delete'|'update'} */
function kindOrEmpty(v) {
  return typeof v === 'string' && FILE_CHANGE_KINDS.includes(v) ? /** @type {any} */ (v) : '';
}

/** @param {any} v @returns {boolean} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @param {any} v @param {number} d @returns {number} */
function numOr(v, d) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}
