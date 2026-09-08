// @ts-check
/**
 * The committed `bin/handoff.mjs` — what the Codex `handoff` skill actually runs.
 *
 * The behaviour lives in the sibling's `bin/handoff.src.mjs` and `lib/handoff.mjs`, and every
 * verb is tested there in-process. What that cannot prove is this artifact under this host:
 * the skill runs `node <plugin-root>/bin/handoff.mjs` from a shell that carries no plugin
 * environment, so the bundle has to know on its own that it is Codex — or every note it
 * files says it came from a Claude Code session, and the receiving agent, the `list` join
 * and anything upstream counting distinct actors all read the wrong sender.
 *
 * The first test is the one this file was written for. The hook bundles go through
 * `lib/boot.mjs`; the command-line bundles, until this suite, did not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeMubit, makeDataDir } from './helpers/codex-fixtures.mjs';
import { KEY, assertInertOnImport, cliEnv, runBundle, seedMarker } from './helpers/codex-cli.mjs';

const RUN_ID = 'codex-handoff-run';

function routes(over = {}) {
  return {
    'POST /v2/control/handoff': { json: { success: true, handoff_id: 'hnd_01' } },
    'POST /v2/control/feedback': { json: { success: true, feedback_id: 'fb_01' } },
    'POST /v2/control/activity': { json: { entries: [], next_page_token: '', total_visible: 0 } },
    ...over,
  };
}

/** A fake instance and a data dir with this run's marker in it. */
async function harness(t, over = {}) {
  const server = await fakeMubit(routes(over));
  t.after(() => server.close());
  const dataDir = makeDataDir();
  seedMarker(dataDir, RUN_ID);
  return { server, dataDir, env: cliEnv({ dataDir, endpoint: server.url }) };
}

test('the bundle exists and stays inert on import', async () => {
  await assertInertOnImport('handoff');
});

// ---------------------------------------------------------------------------
// The sender — the reason this suite exists
// ---------------------------------------------------------------------------

test('send: the bundle knows it is Codex with no host in its environment', async (t) => {
  const { server, env } = await harness(t);

  const r = await runBundle('handoff', ['send', '--to', 'claude-code', 'look at the auth diff', '--json'], env);
  assert.equal(r.code, 0, r.out + r.err);

  const body = server.lastCall('POST', '/v2/control/handoff').body;
  // § `lib/runid.mjs` defaults the agent role to `claude-code` unless `MUBIT_CC_HOST=codex`
  //   is set before it loads. The hook bundles set it through `lib/boot.mjs`; a bin bundle
  //   built straight from the shared source has no shim, so a Codex user's handoff says it
  //   came from a Claude Code session. Nothing downstream can tell the difference.
  assert.equal(body.from_agent_id, 'codex',
    'the sender role must be `codex`: this bundle exists nowhere but the Codex plugin, and '
    + 'the skill that runs it cannot set MUBIT_CC_HOST for it.');
  assert.equal(body.to_agent_id, 'claude-code');
  assert.equal(body.run_id, RUN_ID);
  assert.equal(body.content, 'look at the auth diff');
  assert.ok(!r.out.includes(KEY), `the key reached stdout: ${r.out}`);
});
