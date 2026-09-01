#!/usr/bin/env node
// @ts-check
/**
 * `labs/runid.mjs` — ask the plugin's own modules which run this session belongs to.
 *
 *   node labs/runid.mjs
 *   node labs/runid.mjs '{"session_id":"abc","source":"clear"}'
 *
 * Same two functions every hook calls, same environment, no network, no side effect other
 * than the session-map write `deriveRunId` makes on purpose (see §4.3: the `/clear` counter
 * has to persist somewhere).
 */

import { loadConfig } from '../integrations/claude-code/lib/config.mjs';
import { deriveAgentId, deriveRunId } from '../integrations/claude-code/lib/runid.mjs';

const payload = parse(process.argv[2]);
const cfg = loadConfig();

out('strategy    ', cfg.runStrategy);
out('projectDir  ', cfg.projectDir);
out('endpoint    ', cfg.endpoint || '(unset — capture spools, recall returns nothing)');
try {
  out('run_id      ', deriveRunId(cfg, payload));
} catch (err) {
  out('run_id      ', `REFUSED: ${err instanceof Error ? err.message : String(err)}`);
}
out('agent_id    ', deriveAgentId(payload));

function out(k, v) { process.stdout.write(`${k}${v}\n`); }
function parse(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { process.stderr.write('payload is not JSON; using {}\n'); return {}; }
}
