// @ts-check
/**
 * The claim this whole port's run-id decision rests on: **a Codex session and a Claude Code
 * session in the same directory are one Mubit run.**
 *
 * That is what makes the two harnesses share a memory. Work done in Codex is recalled in
 * Claude Code and vice versa, outcomes attributed in one are visible to the other, and a
 * lesson learned once is learned for the project rather than for the tool. If the two
 * derivations diverge by so much as a prefix, a user has two disjoint memories of one
 * codebase and no way to see that they are separate — the failure looks exactly like memory
 * that is merely thin.
 *
 * So the `cc-` prefix stays. It reads as "Claude Code" and no longer means that; it means
 * "the run for this directory", and renaming it would strand every run already stored. The
 * agent *role* is what distinguishes the harnesses, because a role is what upstream counts
 * when it asks whether a lesson has been confirmed by more than one actor.
 *
 * Also here: the `source` table without `fork`, and the rule that dominates lib/runid.mjs —
 * no input may ever make it answer `"default"`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sessionStart, subagentStop, userPromptSubmit, lib, makeDataDir, makeProjectDir, withEnv,
} from './helpers/codex-fixtures.mjs';

/** Codex's four sources. Claude Code has a fifth, `fork`. */
const CODEX_SOURCES = ['startup', 'resume', 'clear', 'compact'];

/**
 * A Claude Code payload for the same directory: `prompt_id` rather than `turn_id`, and a
 * host session id in Claude Code's own shape.
 */
function claudeCodePayload(cwd, over = {}) {
  return {
    session_id: 'b1f4c2ea-9d3c-4a17-8e55-2f0a6c7d1b93',
    prompt_id: 'p-2f0a6c7d1b93',
    transcript_path: `${cwd}/.claude/transcript.jsonl`,
    cwd,
    hook_event_name: 'SessionStart',
    source: 'startup',
    ...over,
  };
}

function env(dataDir, projectDir, over = {}) {
  return {
    HOME: dataDir,
    MUBIT_CC_DATA_DIR: dataDir,
    CLAUDE_PLUGIN_DATA: dataDir,
    CLAUDE_PROJECT_DIR: projectDir,
    MUBIT_ENDPOINT: 'https://mubit.example.com',
    MUBIT_CC_LOG_LEVEL: 'error',
    MUBIT_DEFAULT_SESSION_ID: '',
    ...over,
  };
}

// ===========================================================================
// The cross-harness claim
// ===========================================================================

test('one directory, two harnesses, one run id', async () => {
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir({ git: true });
  const { deriveRunId } = await lib('runid.mjs');
  const { loadConfig } = await lib('config.mjs');

  const cfg = loadConfig(env(dataDir, projectDir));
  const fromCodex = deriveRunId(cfg, sessionStart({ cwd: projectDir }));
  const fromClaudeCode = deriveRunId(cfg, claudeCodePayload(projectDir));

  // § The two payloads share nothing but `cwd`: different session ids, different turn keys,
  //   different transcript paths. `per-directory` hashes the git toplevel, so the directory is
  //   the only input that matters — and that is the property the decision is made of.
  assert.equal(fromCodex, fromClaudeCode,
    'a Codex session and a Claude Code session in the same directory must derive the same run. '
    + 'Two ids here means two disjoint memories of one project, and nothing anywhere would say so.');
  assert.match(fromCodex, /^cc-/,
    'the `cc-` prefix stays. It no longer reads as "Claude Code" — it means "the run for this '
    + 'directory" — and changing it would strand every run already stored under it.');
});

test('the same run holds even when the two sessions disagree about everything else', async () => {
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir({ git: true, branch: 'feature/x' });
  const { deriveRunId } = await lib('runid.mjs');
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(env(dataDir, projectDir, { MUBIT_CC_RUN_STRATEGY: 'git-branch' }));

  // § `git-branch` derives from root + branch, so the branch has to survive the crossing too:
  //   a Codex session on `feature/x` must land in the same run as a Claude Code session on
  //   `feature/x`, and in a different one from either on `main`.
  const a = deriveRunId(cfg, sessionStart({ cwd: projectDir, source: 'resume' }));
  const b = deriveRunId(cfg, claudeCodePayload(projectDir, { source: 'compact' }));
  assert.equal(a, b, 'git-branch must key on the directory and branch, not on the host.');
  assert.match(a, /feature-x|featurex/,
    `the branch is missing from ${a}, so every branch of this repo shares one run.`);
});

test('a different directory is a different run, on either host', async () => {
  const dataDir = makeDataDir();
  const one = makeProjectDir({ git: true });
  const two = makeProjectDir({ git: true });
  const { deriveRunId } = await lib('runid.mjs');
  const { loadConfig } = await lib('config.mjs');

  const codexOne = deriveRunId(loadConfig(env(dataDir, one)), sessionStart({ cwd: one }));
  const codexTwo = deriveRunId(loadConfig(env(dataDir, two)), sessionStart({ cwd: two }));
  // § The sharing is per directory, not global. A shim that collapsed every Codex session into
  //   one run would "share memory" by pooling every project the user has ever opened.
  assert.notEqual(codexOne, codexTwo,
    'two projects must not share a run. Sharing across harnesses is not sharing across repos.');
});

// ===========================================================================
// The agent role
// ===========================================================================

test('the harnesses share a run but not an identity', async () => {
  const { deriveAgentId } = await lib('runid.mjs');
  await withEnv({ MUBIT_CC_HOST: 'codex' }, () => {
    // § lib/runid.mjs's own comment on why the role is not per-session: anything upstream that
    //   counts *distinct actors* — to decide whether a lesson has been confirmed by more than
    //   one of them — counted one person's consecutive sessions as a crowd, and the count
    //   stopped meaning anything. The same argument says the two harnesses are two actors:
    //   a lesson that Codex and Claude Code both reached is genuinely better attested than one
    //   either reached twice.
    assert.equal(deriveAgentId({}), 'codex',
      'under the Codex host the agent role must be `codex`, or the two harnesses count as one '
      + 'actor and cross-harness corroboration is invisible upstream.');
  });
  await withEnv({ MUBIT_CC_HOST: undefined }, () => {
    assert.equal(deriveAgentId({}), 'claude-code',
      'with no host marker the role must stay `claude-code` — this change was additive.');
  });
});

test('a Codex subagent still gets a lane of its own', async () => {
  const { deriveAgentId, deriveSubRunId } = await lib('runid.mjs');
  const payload = subagentStop();
  await withEnv({ MUBIT_CC_HOST: 'codex' }, () => {
    const agent = deriveAgentId(payload);
    assert.match(agent, /^codex-sub-/,
      `a subagent identity must be derived from agent_id (${payload.agent_id}); two subagents `
      + 'working at once that share an identity cannot be told apart.');
    const sub = deriveSubRunId('cc-proj-deadbeef', payload);
    assert.match(sub, /-sub-/, 'the run-scoped subagent lane is what keeps a fan-out readable.');
    // § Idempotence matters because SubagentStart and SubagentStop both derive it: `-sub-ab-sub-ab`
    //   would be a second lane for one subagent, and the two halves of its record would split.
    assert.equal(deriveSubRunId(sub, payload), sub, 're-deriving a sub-run id must be a no-op.');
  });
});

// ===========================================================================
// The source table
// ===========================================================================

for (const source of CODEX_SOURCES) {
  test(`SessionStart source=${source} derives a usable run`, async () => {
    const dataDir = makeDataDir();
    const projectDir = makeProjectDir({ git: true });
    const { deriveRunId } = await lib('runid.mjs');
    const { loadConfig } = await lib('config.mjs');
    const cfg = loadConfig(env(dataDir, projectDir));

    const runId = deriveRunId(cfg, sessionStart({ cwd: projectDir, source }));
    // § One row per source. `lib/runid.mjs` normalises an unrecognised source to '' — reuse
    //   rather than reset — so Codex's four being a subset of Claude Code's five is safe. What
    //   is not safe is a source Codex sends that the table has never seen, so each is driven.
    assert.ok(runId && runId !== 'default' && runId !== 'cc-',
      `source=${source} produced ${JSON.stringify(runId)}. The MCP server defaults its session `
      + 'id to the literal "default", which is a fallback rather than a run — no input may ever '
      + 'make this module emit it.');
  });
}

test('`clear` starts a new run, on Codex as on Claude Code', async () => {
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir({ git: true });
  const { deriveRunId } = await lib('runid.mjs');
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(env(dataDir, projectDir));

  const base = deriveRunId(cfg, sessionStart({ cwd: projectDir, source: 'startup' }));
  const cleared = deriveRunId(cfg, sessionStart({ cwd: projectDir, source: 'clear' }));
  const again = deriveRunId(cfg, sessionStart({ cwd: projectDir, source: 'clear' }));
  // § `per-directory` is stable per directory, so the clear counter is the only thing that can
  //   honour "forget the thread" — and it has to keep counting, or a second /clear lands back
  //   in the run the first one abandoned.
  assert.notEqual(cleared, base, 'a clear must not reuse the run it was asked to forget.');
  assert.notEqual(again, cleared, 'two successive clears must yield two runs, not one.');
});

test('there is no `fork` source to handle', async () => {
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir({ git: true });
  const { deriveRunId } = await lib('runid.mjs');
  const { loadConfig } = await lib('config.mjs');
  const cfg = loadConfig(env(dataDir, projectDir));

  const startup = deriveRunId(cfg, sessionStart({ cwd: projectDir, source: 'startup' }));
  // § Codex's session-start schema enumerates four sources (codex-payload.test.mjs pins the
  //   list). A payload carrying `fork` is not something Codex sends, and the shared table
  //   normalises anything it does not know to "no source" — reuse. Asserting the reuse
  //   behaviour is what makes the missing row safe rather than merely unnoticed.
  const forked = deriveRunId(cfg, sessionStart({ cwd: projectDir, source: 'resume' }));
  assert.equal(forked, startup,
    'an unknown or absent source must reuse the mapped run rather than mint a new one — that '
    + 'is the branch Codex`s missing `fork` falls into.');
});

// ===========================================================================
// The turn key
// ===========================================================================

test('the turn key is turn_id under Codex and prompt_id under Claude Code', async () => {
  const { turnKey } = await lib('runid.mjs');
  // § One function, both hosts, because every hook that names the turn file has to agree.
  //   `stage-prompt` writes it, `prompt-recall` adds the recalled ids to it, `capture --stop`
  //   pairs it with the answer, `drain --with-outcome` posts the attribution, and
  //   `session-end` sweeps whatever is left. Six readers, one key: a disagreement anywhere
  //   loses attribution silently.
  assert.equal(turnKey(userPromptSubmit()), '01a0240c-7f97-7ca3-a641-cf8d141498a0',
    'a Codex payload keys on turn_id.');
  assert.equal(turnKey(claudeCodePayload('/tmp/x', { prompt_id: 'p-1' })), 'p-1',
    'a Claude Code payload keys on prompt_id.');
  assert.equal(turnKey({ prompt_id: 'p-1', turn_id: 't-1' }), 'p-1',
    'when both are present prompt_id wins: it is the host the existing stored turns came from, '
    + 'and switching keys mid-run would orphan them.');
  assert.equal(turnKey({}), '', 'no key is a real answer — a SessionStart has no turn.');
  assert.equal(turnKey(null), '', 'and it never throws: every caller is on a hook`s critical path.');
});
