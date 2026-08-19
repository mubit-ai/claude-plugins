// @ts-check
/**
 * Recorded Claude Code hook stdin payloads.
 *
 * Common fields on every payload: `session_id`, `prompt_id`, `transcript_path`,
 * `cwd`, `permission_mode`, `hook_event_name`, `agent_id`, `agent_type`.
 * `SessionStart` adds `model`.
 *
 * Every builder takes an overrides object so a test can vary one field without
 * restating the shape.
 */

export const SESSION_ID = '4f21ab90-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
export const PROMPT_ID = 'p_01HZXK8Q9N7M6P5R4S3T2U1V0W';
export const TOOL_USE_ID = 'toolu_01ABCDEFGHIJKLMNOPQRSTUV';

const base = (over = {}) => ({
  session_id: SESSION_ID,
  transcript_path: `/Users/x/.claude/projects/-Users-x-repo/${SESSION_ID}.jsonl`,
  cwd: '/Users/x/repo',
  permission_mode: 'default',
  agent_id: undefined,
  agent_type: undefined,
  ...over,
});

/** @param {{source?: 'startup'|'resume'|'clear'|'compact'|'fork'} & Record<string,any>} [over] */
export const sessionStart = (over = {}) => base({
  hook_event_name: 'SessionStart',
  source: 'startup',
  model: 'claude-opus-5',
  ...over,
});

/** @param {Record<string,any>} [over] */
export const userPromptSubmit = (over = {}) => base({
  hook_event_name: 'UserPromptSubmit',
  prompt_id: PROMPT_ID,
  prompt: 'why is the ingest job stuck in queued?',
  is_continuation: false,
  ...over,
});

/**
 * PostToolUse.
 *
 * The tool's result rides in **`tool_response`**, and the duration in **`duration_ms`**.
 * Those are the names the host emits, verbatim; they are not a guess. This fixture used to
 * say `tool_output` / `execution_time_ms`, `capture.mjs` read the same two invented names,
 * and the pair agreed with each other through 752 green tests while every memory the plugin
 * had ever shipped read `Read(file_path=X) -> ` with nothing after the arrow. A fixture
 * written beside the implementation cannot falsify it — so treat these names as recorded
 * evidence and do not "tidy" them.
 *
 * `postToolUseLegacyOutput` below covers the older `tool_output` shape, which capture still
 * accepts as a fallback.
 *
 * @param {Record<string,any>} [over]
 */
export const postToolUse = (over = {}) => base({
  hook_event_name: 'PostToolUse',
  prompt_id: PROMPT_ID,
  tool_name: 'Edit',
  tool_input: {
    file_path: '/Users/x/repo/src/lib.rs',
    old_string: 'let a = 1;',
    new_string: 'let a = 2;',
  },
  tool_response: { type: 'text', text: 'Applied 1 edit to src/lib.rs' },
  tool_use_id: TOOL_USE_ID,
  duration_ms: 42,
  ...over,
});

/**
 * The same call as it arrived from an older host: the result under `tool_output`, with no
 * `tool_response` at all. Nothing is gained by making an old payload shape fail, so capture
 * reads `tool_response ?? tool_output` and this fixture is what holds the second half of
 * that `??` honest.
 *
 * @param {Record<string,any>} [over]
 */
export const postToolUseLegacyOutput = (over = {}) => {
  const p = postToolUse(over);
  const legacy = p.tool_response;
  delete p.tool_response;
  return { ...p, tool_output: legacy };
};

/** @param {Record<string,any>} [over] */
export const postToolUseFailure = (over = {}) => base({
  hook_event_name: 'PostToolUseFailure',
  prompt_id: PROMPT_ID,
  tool_name: 'Bash',
  tool_input: { command: 'cargo check -p my-crate' },
  error: "error[E0433]: failed to resolve: use of undeclared crate or module `tonic`",
  tool_use_id: TOOL_USE_ID,
  duration_ms: 1893,
  ...over,
});

/**
 * `tool_response` bodies, copied off real transcripts rather than imagined — one per shape
 * the renderer has to survive. The point of the table is that no two of these look alike:
 * `Read` buries its payload under `file.content`, `Bash` splits it across `stdout`/`stderr`,
 * and the rest are flat result objects with no text field at all. Any of them rendering to
 * an empty string is defect F1 coming back.
 *
 * @type {Record<string, {tool_input: Record<string, any>, tool_response: any, expect: string}>}
 */
export const RECORDED_RESPONSES = {
  Read: {
    tool_input: { file_path: '/Users/x/repo/src/lib.rs' },
    tool_response: {
      type: 'text',
      file: {
        filePath: '/Users/x/repo/src/lib.rs',
        content: 'pub fn main() { println!("hello"); }\n',
        numLines: 1,
        startLine: 1,
        totalLines: 1,
      },
    },
    expect: 'pub fn main()',
  },
  Bash: {
    tool_input: { command: 'ls -la' },
    tool_response: {
      stdout: 'total 8\ndrwxr-xr-x  3 x  staff  96 Aug 17 09:00 .',
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    },
    expect: 'drwxr-xr-x',
  },
  Edit: {
    tool_input: { file_path: '/Users/x/repo/src/lib.rs', old_string: 'a', new_string: 'b' },
    tool_response: {
      filePath: '/Users/x/repo/src/lib.rs',
      oldString: 'let a = 1;',
      newString: 'let a = 2;',
      userModified: false,
      replaceAll: false,
    },
    expect: 'newString',
  },
  Agent: {
    tool_input: { description: 'Explore the matcher', subagent_type: 'Explore', prompt: 'where is it' },
    tool_response: {
      isAsync: true,
      status: 'async_launched',
      agentId: 'aa1ef5c824d2b9874',
      description: 'Explore the matcher',
    },
    expect: 'async_launched',
  },
  TaskUpdate: {
    tool_input: { task_id: '1', status: 'in_progress' },
    tool_response: {
      success: true,
      taskId: '1',
      updatedFields: ['status'],
      statusChange: { from: 'pending', to: 'in_progress' },
    },
    expect: 'in_progress',
  },
  Skill: {
    tool_input: { skill: 'artifact-design' },
    tool_response: { success: true, commandName: 'artifact-design' },
    expect: 'artifact-design',
  },
};

/** @param {Record<string,any>} [over] */
export const stop = (over = {}) => base({
  hook_event_name: 'Stop',
  prompt_id: PROMPT_ID,
  last_assistant_message:
    'The job stays queued until indexing completes.',
  turn_number: 7,
  ...over,
});

/**
 * StopFailure — the turn ended on an API error.
 *
 * The field names are the host's own, read out of the Claude Code 2.1.235 Zod schema rather
 * than from the published hook reference, which spells two of them differently:
 *
 *     strings -a ~/.local/share/claude/versions/2.1.235 \
 *       | grep -o 'hook_event_name:wt("StopFailure").\{0,160\}'
 *     → hook_event_name:wt("StopFailure"), error:Mzc(), error_details:N().optional(),
 *       last_assistant_message:N().optional()
 *
 * So the error kind rides in **`error`**, not `reason` and not `error_type`. That distinction
 * is the whole payload as far as this plugin is concerned — a fixture with the wrong name
 * would agree with an implementation reading the wrong name and both would be green while
 * every API-failed turn was recorded as `unknown`. See the warning at the head of
 * `postToolUse` for the last time that happened here.
 *
 * `error`'s vocabulary is the ten-value taxonomy plus a feature-flagged eleventh
 * (`account_on_hold`), and the host defaults a missing one to `"unknown"` on its way to the
 * matcher (`matchQuery: e.error ?? "unknown"`).
 *
 * @param {Record<string,any>} [over]
 */
export const stopFailure = (over = {}) => base({
  hook_event_name: 'StopFailure',
  prompt_id: PROMPT_ID,
  error: 'rate_limit',
  error_details: 'This request would exceed your organization\'s rate limit of 80,000 '
    + 'input tokens per minute.',
  last_assistant_message: 'Let me check the indexing queue',
  ...over,
});

/** @param {Record<string,any>} [over] */
export const subagentStop = (over = {}) => base({
  hook_event_name: 'SubagentStop',
  prompt_id: PROMPT_ID,
  agent_id: 'sub_01HZXK8Q9N7M',
  agent_type: 'Explore',
  last_assistant_message: 'Found three call sites in src/service/lib.rs.',
  turn_number: 2,
  ...over,
});

/** @param {Record<string,any>} [over] */
export const preCompact = (over = {}) => base({
  hook_event_name: 'PreCompact',
  trigger: 'auto',
  turn_number: 41,
  ...over,
});

/** @param {Record<string,any>} [over] */
export const postCompact = (over = {}) => base({
  hook_event_name: 'PostCompact',
  trigger: 'auto',
  ...over,
});

/** @param {Record<string,any>} [over] */
export const sessionEnd = (over = {}) => base({
  hook_event_name: 'SessionEnd',
  reason: 'exit',
  ...over,
});

/** A spooled ingest item, shaped as one element of the eventual `items[]` (§5.4). */
export const spoolItem = (over = {}) => ({
  item_id: `cc-${TOOL_USE_ID}-1765000000123`,
  content_type: 'text',
  text: 'Edit(file_path=src/lib.rs) -> Applied 1 edit to src/lib.rs',
  intent: 'trace',
  importance: 'medium',
  source: 'agent',
  occurrence_time: 1765000000,
  env_tags: ['tool:claude-code', 'repo:my-project', 'lang:rust'],
  metadata_json: JSON.stringify({ tool: 'Edit', tool_use_id: TOOL_USE_ID, truncated: false }),
  ...over,
});

/** Realistic secret-bearing text for redaction tests. Not a real credential. */
export const SECRETS = {
  mubitKey: 'mbt_acme_0123456789abcdef_deadbeefcafebabe0123456789abcdef',
  openaiKey: 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  githubToken: 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  awsKey: 'AKIAIOSFODNN7EXAMPLE',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  bearer: 'Bearer AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdef\n-----END RSA PRIVATE KEY-----',
  assignment: 'DATABASE_PASSWORD=hunter2correcthorsebattery',
  highEntropy: 'aG9yc2ViYXR0ZXJ5c3RhcGxlY29ycmVjdGhvcnNlYmF0dGVyeXN0YXBsZQ==',
};
