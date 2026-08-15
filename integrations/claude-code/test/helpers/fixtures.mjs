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

/** @param {Record<string,any>} [over] */
export const postToolUse = (over = {}) => base({
  hook_event_name: 'PostToolUse',
  prompt_id: PROMPT_ID,
  tool_name: 'Edit',
  tool_input: {
    file_path: '/Users/x/repo/src/lib.rs',
    old_string: 'let a = 1;',
    new_string: 'let a = 2;',
  },
  tool_output: { type: 'text', text: 'Applied 1 edit to src/lib.rs' },
  tool_use_id: TOOL_USE_ID,
  execution_time_ms: 42,
  ...over,
});

/** @param {Record<string,any>} [over] */
export const postToolUseFailure = (over = {}) => base({
  hook_event_name: 'PostToolUseFailure',
  prompt_id: PROMPT_ID,
  tool_name: 'Bash',
  tool_input: { command: 'cargo check -p my-crate' },
  error: "error[E0433]: failed to resolve: use of undeclared crate or module `tonic`",
  tool_use_id: TOOL_USE_ID,
  execution_time_ms: 1893,
  ...over,
});

/** @param {Record<string,any>} [over] */
export const stop = (over = {}) => base({
  hook_event_name: 'Stop',
  prompt_id: PROMPT_ID,
  last_assistant_message:
    'The job stays queued until indexing completes.',
  turn_number: 7,
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
