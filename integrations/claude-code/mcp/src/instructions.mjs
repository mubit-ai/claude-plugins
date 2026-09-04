// @ts-check
/**
 * `mcp/src/instructions.mjs` — the server `instructions` the bundled server cannot set (§8.3).
 *
 * **Why this field matters more than it looks.** Claude Code defers MCP tool schemas: with
 * tool search on — the default — only tool *names* and the server's `instructions` string
 * load at session start, and a tool's description arrives only after the model has already
 * decided to go looking for it. So `instructions` carries the entire "when is Mubit worth
 * reaching for" argument, and it carries it for the one population that gets nothing else:
 * `hooks.json` registers `SessionStart` and `UserPromptSubmit` in the parent conversation
 * only, so a **subagent** is handed no steer block and no per-turn recall. For a subagent
 * this text is the only notice that a memory exists at all.
 *
 * **Why a wrapper and not a sixth env var.** The bundled server has no hook to set it. In
 * `mcp/dist/server.js`, `createServer()` is `new McpServer({ name, version })` with no
 * options object at all, and no `MUBIT_*` variable feeds `instructions` — the only three
 * occurrences in that 5.9 MB bundle are the SDK's own result schema, `Server._instructions`
 * (assigned from `options?.instructions`, which is never passed), and the spread in
 * `_oninitialize` that omits the key when it is unset. There is nothing to set from the
 * outside, so the field is filled in on the frame on its way out.
 *
 * **The seam.** This is `mcp/src/egress.mjs` applied one layer down. That file wraps
 * `globalThis.fetch` because the vendored bundle dials the endpoint itself; this one wraps
 * `process.stdout.write` because `initialize` never crosses the network — it is answered
 * from the server's own state and leaves through `StdioServerTransport.send`, which is
 * `this._stdout.write(serializeMessage(message))` and nothing else. `process.stdout` is
 * captured as a constructor default when the transport is built, so the same ordering rule
 * applies verbatim: install before `await import('./server.js')`, or wrap a handle nobody
 * is holding.
 *
 * **The one rule, inherited unchanged.** This code sits in the path of every byte the server
 * will ever put on the protocol channel, including frames it has never seen. It must never
 * be able to break one: every branch falls through to the original chunk on any surprise,
 * and a line it does not fully understand is passed through byte-for-byte rather than
 * re-serialised. After the first `initialize` result it stops inspecting altogether.
 */

/**
 * What every session — and every subagent — is told about Mubit before it does anything.
 *
 * Derived from the SessionStart steer block in `hooks/src/session-start.mjs`, minus the
 * run-specific lines it can state and this cannot: there is no run id or mode here, because
 * an MCP server is started once and this string is fixed at that moment.
 *
 * Three things earn their tokens, and nothing else is here:
 *
 *   1. **When searching is wasted, and when it is the only option.** The steer block's own
 *      balance, and its recorded defect: it once said only "do not search for it
 *      preemptively", a negative with no positive beside it, and the trained behaviour was
 *      to never call a memory tool at all (`session-start.mjs`). The subagent clause is the
 *      half the steer block cannot state, because it never reaches one.
 *   2. **Which retrieval tool for which shape of question.** Three of the curated seven
 *      answer a question the model is already holding, and the choice between them is
 *      deferred with their descriptions. The administrative verbs that left the surface are
 *      named as the skills that now reach them, so a model that wants the catalogue is not
 *      left searching for a tool that is not there.
 *   3. **What `mubit_learned` is for.** Its own description says what belongs in a lesson and
 *      never what does not, and this is the mistake a model makes unprompted: narrating the
 *      session into permanent memory, whose cost is paid by every future recall.
 *
 * Kept deliberately short. This is always-loaded surface — it is billed on every session
 * before the model has done anything, it is measured by `scripts/measure-context-cost.mjs`
 * into `scripts/context-cost.json`, and `marketplace.json` declares the total.
 */
export const INSTRUCTIONS = [
  "Mubit is this project's persistent memory: lessons, decisions and past work carried over "
    + 'from earlier sessions.',
  '',
  'When to search. In the main conversation Mubit injects the memory relevant to each turn '
    + 'before you see it, so opening a turn by searching for that is wasted work. Search when '
    + 'the injected memory falls short — and always search as a subagent, which receives no '
    + 'injection at all and otherwise begins with no memory of this project.',
  '',
  'Which tool. mubit_recall for a topic or question in words. mubit_diagnose when a command '
    + 'or test has just failed, which matches the error shape against past failures. '
    + 'mubit_dereference when you already hold a reference_id. Reviewing the whole catalogue, '
    + 'the pattern across many lessons, a named checkpoint, deleting a lesson and an explicit '
    + 'reflect are skills (/mubit-memory:strategies, :checkpoint, :forget, :reflect), not tools.',
  '',
  'What to write back. mubit_learned records one durable claim — a constraint, a fix that '
    + 'worked, a standing preference — stated so it is still true in a later session. It is '
    + 'not a session log: narrating what happened ("the user asked for X", "I refactored Y") '
    + 'is the common way this tool is misused, and every future recall pays for it. '
    + 'mubit_outcome credits the reference_ids that actually helped, which is what makes the '
    + 'memory that helps rank higher next time.',
].join('\n');

// ---------------------------------------------------------------------------
// The rewrite
// ---------------------------------------------------------------------------

/**
 * @typedef {object} FrameResult
 * @property {any} message  the frame to send — the ORIGINAL reference when nothing moved
 * @property {boolean} changed
 */

/**
 * Fill `instructions` into an `initialize` result.
 *
 * Synchronous, pure, and inert on anything it does not understand: a frame it cannot read is
 * returned **by identity**, not cloned, so the caller can tell "nothing to do" from
 * "rewritten to the same value" without comparing fields — and, more to the point, knows
 * when it may leave the original bytes on the wire untouched.
 *
 * A frame qualifies only when it is a JSON-RPC 2.0 message carrying a `result` object with
 * both `protocolVersion` and `serverInfo`. That is the `initialize` result and only that:
 * every other reply this server sends has a `result` too, and none of them has a field this
 * text belongs in.
 *
 * Fills, never replaces. If a rebuilt `@mubit-ai/mcp` ever starts passing its own
 * `instructions` to `new McpServer(...)`, that text wins — this guard exists to fill a hole
 * in the bundle, not to take the field over from it.
 *
 * @param {any} message
 * @param {string} instructions
 * @returns {FrameResult}
 */
export function guardInitialize(message, instructions) {
  const noop = { message, changed: false };
  try {
    const text = typeof instructions === 'string' ? instructions : '';
    if (text.trim() === '') return noop;

    if (!message || typeof message !== 'object' || Array.isArray(message)) return noop;
    if (message.jsonrpc !== '2.0') return noop;

    const result = message.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return noop;
    if (typeof result.protocolVersion !== 'string') return noop;
    if (!result.serverInfo || typeof result.serverInfo !== 'object') return noop;

    if (typeof result.instructions === 'string' && result.instructions.trim() !== '') return noop;

    return {
      message: { ...message, result: { ...result, instructions: text } },
      changed: true,
    };
  } catch {
    // A frame shaped in a way this function did not anticipate is not a reason to damage
    // somebody else's handshake.
    return noop;
  }
}

// ---------------------------------------------------------------------------
// The stdout wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap `process.stdout.write` so the server's `initialize` result carries `instructions`.
 *
 * Must be called **before** `await import('./server.js')`. `StdioServerTransport` takes
 * `process.stdout` as a constructor default and holds it for the life of the process, so a
 * wrapper installed afterwards is a wrapper on a handle nobody is holding — the same
 * ordering rule every `MUBIT_*` env var in the launcher obeys, and the same one
 * `installFetchGuard` obeys, for the same reason.
 *
 * Idempotent. Re-installing rewraps the original `write` rather than stacking a second layer
 * on the first, so a double call cannot inspect the same frame twice.
 *
 * @param {{instructions: string, stream?: any}} opts
 *   `stream` overrides the target for tests; production always wraps `process.stdout`.
 * @returns {void}
 */
export function installInstructionsGuard(opts) {
  const instructions = typeof opts?.instructions === 'string' ? opts.instructions : '';
  // Nothing to say is not a reason to sit in the protocol path.
  if (instructions.trim() === '') return;

  const stream = opts?.stream ?? process.stdout;
  const current = stream?.write;
  if (typeof current !== 'function') return;
  const base = typeof current.mubitInstructionsGuardOriginal === 'function'
    ? current.mubitInstructionsGuardOriginal
    : current;

  // `initialize` is answered once per connection. After it has been seen this guard stops
  // looking, so it is a pure pass-through for every tool result that follows — the frames
  // that carry the volume.
  let looking = true;

  /**
   * @param {any} chunk
   * @param {...any} rest  encoding / callback, forwarded untouched
   */
  const wrapped = function write(chunk, ...rest) {
    if (looking && typeof chunk === 'string') {
      try {
        const filled = fill(chunk, instructions);
        if (filled !== null) {
          looking = false;
          chunk = filled;
        }
      } catch {
        // Anything unexpected about the chunk means it goes out exactly as the server wrote
        // it. A guard that can corrupt the protocol channel is far worse than a missing
        // field: one stray byte makes the whole server unparseable to the host.
      }
    }
    return base.call(this, chunk, ...rest);
  };

  Object.defineProperty(wrapped, 'mubitInstructionsGuardOriginal', {
    value: base, writable: true, configurable: true, enumerable: false,
  });
  // The launch tests read this off `process.stdout.write` from inside the stub server and
  // JSON-serialise it, so it stays plain data.
  wrapped.mubitInstructionsGuard = { chars: instructions.length };

  stream.write = wrapped;
}

/**
 * Fill `instructions` into whichever line of a chunk is the `initialize` result.
 *
 * Returns `null` when nothing moved — the identity signal, so the caller forwards the
 * original string rather than one this file rebuilt.
 *
 * The transport writes exactly one frame per call (`serializeMessage` is
 * `JSON.stringify(message) + "\n"`), so the split is a formality — but it is a lossless one
 * (`split('\n')` then `join('\n')` reproduces the input byte-for-byte), and only the single
 * line that actually changed is re-serialised. Every other line, including one this file
 * cannot parse, keeps the exact bytes the server produced.
 *
 * @param {string} chunk
 * @param {string} instructions
 * @returns {string|null}
 */
function fill(chunk, instructions) {
  if (!chunk.includes('"result"')) return null;

  const parts = chunk.split('\n');
  let changed = false;
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].trim() === '') continue;
    /** @type {any} */
    let frame;
    try { frame = JSON.parse(parts[i]); } catch { continue; }
    const out = guardInitialize(frame, instructions);
    if (!out.changed) continue;
    parts[i] = JSON.stringify(out.message);
    changed = true;
  }
  return changed ? parts.join('\n') : null;
}
