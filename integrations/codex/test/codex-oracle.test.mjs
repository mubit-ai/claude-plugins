// @ts-check
/**
 * `hooks.json`, read back to us by the host.
 *
 * Every other manifest test in this suite compares our manifest against our own expectations,
 * which is a tautology dressed as a check: whatever shape `hooks.json` has, the constant
 * beside it will have too. The one file in the suite that was never vulnerable to that is
 * `codex-payload.test.mjs`, because it validates against schemas the *host* wrote.
 *
 * This is the same trick moved from the payload layer to the manifest layer. `codex
 * app-server` answers `hooks/list` by parsing a real `$CODEX_HOME/hooks.json` and echoing back
 * what it understood — the event it filed each handler under, the matcher it kept, the timeout
 * it will enforce, the key it will look the handler up by for trust, and any warnings it
 * raised. It is a config parse behind a JSON-RPC frame: no model call, no API quota, no
 * network. `scripts/setup.mjs` already drives exactly this call in production.
 *
 * Two layers, on purpose:
 *
 *   - **The recorded answer** (`test/fixtures/codex-hooks-list.json`) carries the host's reply
 *     with machine paths tokenised. Its invariants are asserted on every run, `codex` present
 *     or not, so a reviewer can read what the host said without installing anything.
 *   - **The live answer**, when `codex` is on PATH, must still equal it. That is what stops the
 *     recording going stale into a fiction.
 *
 * When `codex` is absent the live tests skip **by name**, printing what was not checked. A
 * silent skip is indistinguishable from a pass, and this is the file where that would matter
 * most.
 */

import test from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assert, CODEX_ROOT, CODEX_EVENTS } from './helpers/codex-fixtures.mjs';
import {
  askHost, codexVersion, installProbePlugins, normalize, recordedAnswer, seedCodexHome,
  HOME_TOKEN, ROOT_TOKEN, HASH_TOKEN,
} from './helpers/codex-oracle.mjs';

const CODEX = codexVersion();

/**
 * Skip loudly. `node:test` prints the reason beside the test name, so a run without `codex`
 * says which contract went unchecked rather than quietly reporting one fewer test.
 */
const needsCodex = {
  skip: CODEX.ok ? false
    : 'no `codex` on PATH — the host could not be asked. This contract is UNVERIFIED on this '
      + 'run; install codex-cli and re-run before trusting a green suite here.',
};

/** `PreToolUse` -> `pre_tool_use`, which is how the host spells an event inside a trust key. */
const snake = (e) => e.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
/** `PreToolUse` -> `preToolUse`, which is how the host spells it in `eventName`. */
const camel = (e) => e.charAt(0).toLowerCase() + e.slice(1);

/** Our shipped template — the manifest the host is being asked about. */
function ourRegistrations() {
  return JSON.parse(readFileSync(join(CODEX_ROOT, 'hooks.json'), 'utf8'));
}

// ===========================================================================
// The recorded answer, checked without the host
// ===========================================================================

test('the recorded hooks/list answer covers every registration, counted', () => {
  const rec = recordedAnswer();

  // § The count check the rule-table extraction did not have. A recording that silently
  //   captured three handlers instead of twelve would otherwise pass every test below it.
  assert.equal(rec.hooks.length, rec._provenance.handler_count,
    'the recorded answer disagrees with its own provenance block about how many handlers it '
    + 'holds, so one of the two was edited by hand.');

  const expected = expectedHandlers();
  assert.equal(rec.hooks.length, expected.length,
    `hooks.json registers ${expected.length} handler(s) and the host was recorded reporting `
    + `${rec.hooks.length}. Either a registration was added without re-recording `
    + '(`node test/helpers/codex-oracle.mjs --update`), or the host dropped one silently.');
});

test('the host raised no warning and no error on our manifest', () => {
  const rec = recordedAnswer();
  assert.deepEqual(rec.errors, [],
    'the host reported an error parsing our hooks.json. A registration it cannot read is a '
    + 'registration that never fires.');
  assert.deepEqual(rec.warnings, [],
    'the host warned about our hooks.json. Its warnings are how it reports a field it '
    + 'understood but discarded — `additionalContextLimit` on an event that cannot emit '
    + 'context, for one — so a warning here means a setting we wrote is not in effect.');
});

test('every Codex event we register appears under the host`s own name for it', () => {
  const rec = recordedAnswer();
  const seen = new Set(rec.hooks.map((h) => h.eventName));
  const tpl = ourRegistrations();

  for (const event of Object.keys(tpl.hooks)) {
    assert.ok(seen.has(camel(event)),
      `we register ${event} and the host reported no handler under \`${camel(event)}\`. `
      + `The host spells events in camelCase in \`eventName\` and in snake_case inside a trust `
      + `key; a manifest key it does not recognise is dropped without an error.`);
  }
  // § And nothing we did not ask for.
  for (const name of seen) {
    assert.ok(CODEX_EVENTS.some((e) => camel(e) === name),
      `the host reported a handler under \`${name}\`, which is not one of the eleven events `
      + 'this plugin knows about.');
  }
});

test('the timeout the host will enforce is the timeout we wrote', () => {
  const rec = recordedAnswer();
  for (const want of expectedHandlers()) {
    const got = rec.hooks.find((h) => h.command === want.command && h.eventName === camel(want.event));
    assert.ok(got, `the host reported no handler for ${want.event} -> ${want.command}`);
    assert.equal(got.timeoutSec, want.timeout,
      `we wrote timeout ${want.timeout} for ${want.event} and the host will enforce `
      + `${got.timeoutSec}. Codex clamps some events regardless of the manifest — SessionEnd to `
      + '3s — so a mismatch here is the host telling you your budget is not the one in effect.');
  }
});

test('every matcher survives the round trip exactly', () => {
  const rec = recordedAnswer();
  for (const want of expectedHandlers()) {
    const got = rec.hooks.find((h) => h.command === want.command && h.eventName === camel(want.event));
    assert.equal(got.matcher, want.matcher ?? null,
      `${want.event}'s matcher went in as ${JSON.stringify(want.matcher ?? null)} and came back `
      + `as ${JSON.stringify(got.matcher)}. \`*\` in particular is worth watching: it is the `
      + 'one matcher that would silently disable all capture if the host rejected it.');
  }
});

test('every command names a file that exists in this checkout', () => {
  const rec = recordedAnswer();
  for (const h of rec.hooks) {
    // § The host echoes the command as a shell string. The path is the first quoted argument,
    //   which is the shape `scripts/setup.mjs` writes and the only shape we ship.
    const m = /"([^"]+\.mjs)"/.exec(h.command);
    assert.ok(m, `cannot find a quoted script path in the host's echo of: ${h.command}`);
    const real = m[1].split(ROOT_TOKEN).join(CODEX_ROOT);
    assert.ok(existsSync(real),
      `${h.eventName} is registered to run ${real}, which does not exist. Codex resolves a hook `
      + 'command through `$SHELL -lc`; a missing file is a silent no-op, not an error.');
  }
});

test('the trust key is <sourcePath>:<snake_case event>:<group>:<index>', () => {
  const rec = recordedAnswer();
  for (const h of rec.hooks) {
    const expected = new RegExp(`^${escapeRe(h.sourcePath)}:([a-z_]+):(\\d+):(\\d+)$`);
    const m = expected.exec(h.key);
    assert.ok(m,
      `the trust key \`${h.key}\` is not <sourcePath>:<event>:<group>:<index>. setup.mjs writes `
      + '`[hooks.state."<key>"]` tables from this exact string, and TOML forbids redefining a '
      + 'table — so a key whose shape moved is how the config file stopped parsing once already.');
    assert.equal(m[1], snake(capitalise(h.eventName)),
      `the key spells the event \`${m[1]}\` where eventName is \`${h.eventName}\`.`);
  }
});

test('UserPromptSubmit`s two handlers are two separate trust decisions', () => {
  const rec = recordedAnswer();
  const ups = rec.hooks.filter((h) => h.eventName === 'userPromptSubmit');
  assert.equal(ups.length, 2, 'recall and prompt-staging are two handlers, by design.');

  const keys = new Set(ups.map((h) => h.key));
  assert.equal(keys.size, 2,
    'both UserPromptSubmit handlers share a trust key, so trusting one would trust the other. '
    + 'They do not: the key ends in the handler index.');
  assert.deepEqual([...ups].map((h) => h.key.split(':').pop()).sort(), ['0', '1'],
    'the two handlers are index 0 and 1 within group 0.');
  // § Why it matters: trusting only prompt-recall gives the user recall with nothing staged to
  //   attribute it against, and Codex skips the untrusted half in silence.
  assert.ok(ups.some((h) => h.command.includes('prompt-recall.mjs')));
  assert.ok(ups.some((h) => h.command.includes('stage-prompt.mjs')));
});

test('a freshly merged hooks.json is untrusted, and the host says so', () => {
  const rec = recordedAnswer();
  for (const h of rec.hooks) {
    assert.equal(h.trustStatus, 'untrusted',
      'a registration with no [hooks.state] entry must read as untrusted. This is the state '
      + 'setup.mjs exists to move off, and the state an edited command falls back to.');
    assert.equal(h.enabled, true);
    assert.equal(h.handlerType, 'command');
    assert.equal(h.source, 'user',
      'these are merged into the user layer, so the host attributes them to the user.');
    assert.equal(h.pluginId, null, 'a user-layer registration belongs to no plugin.');
  }
});

// ===========================================================================
// The live host, when there is one
// ===========================================================================

test('the live host still answers exactly what was recorded', needsCodex, async () => {
  const { home, root } = seedCodexHome();
  const answer = await askHost(home);
  const live = normalize(answer, { home, root });
  const rec = recordedAnswer();

  assert.deepEqual(live, { hooks: rec.hooks, warnings: rec.warnings, errors: rec.errors },
    `the host (${CODEX.version}) no longer answers what test/fixtures/codex-hooks-list.json `
    + 'records. Read the diff before updating it — it is the host telling you a manifest '
    + 'contract moved. Re-record with: node test/helpers/codex-oracle.mjs --update');
});

test('the live currentHash is a sha256 the trust write can use', needsCodex, async () => {
  const { home } = seedCodexHome();
  const answer = await askHost(home);
  assert.ok(answer.hooks.length);
  for (const h of answer.hooks) {
    assert.match(h.currentHash, /^sha256:[0-9a-f]{64}$/,
      `currentHash came back as ${JSON.stringify(h.currentHash)}. setup.mjs writes it verbatim `
      + 'as `trusted_hash`, and a value the host cannot match leaves the hook untrusted and '
      + 'silently skipped.');
  }
  // § Tokenised out of the recording precisely because it is not stable across checkouts.
  assert.notEqual(answer.hooks[0].currentHash, HASH_TOKEN);
});

test('an edited command changes its hash, which is why trust has to be re-recorded', needsCodex, async () => {
  // § One home, edited in place. Two homes would move `sourcePath`, and the trust key is
  //   built from it — so the key comparison below would fail for a reason that has nothing to
  //   do with the command.
  const { home, written } = seedCodexHome();
  const a = await askHost(home);

  written.hooks.PostToolUse[0].hooks[0].command += ' --edited';
  writeFileSync(join(home, 'hooks.json'), `${JSON.stringify(written, null, 2)}\n`);
  const b = await askHost(home);

  const key = (hs) => hs.find((h) => h.eventName === 'postToolUse');
  assert.notEqual(key(a.hooks).currentHash, key(b.hooks).currentHash,
    'editing a command left its hash unchanged, which would mean a stale `trusted_hash` keeps '
    + 'trusting a command the user never approved.');
  assert.equal(key(a.hooks).key, key(b.hooks).key,
    'the trust KEY must not move when the command does — that is exactly why setup.mjs has to '
    + 'rewrite the [hooks.state] tables rather than append to them.');
});

// ===========================================================================
// The by-product: is the user-layer merge necessary at all?
// ===========================================================================

test('a plugin-bundled hooks.json IS discovered — under two of three layouts', needsCodex, async () => {
  const { home } = installProbePlugins();
  const answer = await askHost(home);

  const byTag = (tag) => answer.hooks.find((h) => h.command === `/bin/echo ${tag}`);

  // § The harness probe's "are plugin-bundled hooks honoured?" question concluded they are
  //   inert, having tested this one
  //   layout — a bare `hooks.json` at the plugin root with a manifest that does not name it.
  //   That conclusion is why scripts/setup.mjs, the {{PLUGIN_ROOT}} templating and the
  //   config.toml write all exist. It is correct only about this layout.
  assert.equal(byTag('root-bare'), undefined,
    'a bare hooks.json at the plugin root is ignored — which is the finding the original probe '
    + 'made, and generalised too far.');

  for (const layout of ['hooks-dir', 'root-declared']) {
    const got = byTag(layout);
    assert.ok(got,
      `the \`${layout}\` layout was not discovered either, so plugin hooks really are inert and `
      + 'the user-layer merge is load-bearing. Say so in the README.');
    assert.equal(got.source, 'plugin');
    assert.match(got.pluginId, /@mubit-probe-mkt$/,
      'a discovered plugin hook is attributed to its plugin, which is the field that would let '
      + 'a plugin install skip the merge entirely.');
  }

  // § Deliberately a finding and not a refactor. Acting on it means deleting the user-layer
  //   merge, and with it two of the install defects this branch fixes; that is a separate
  //   change, and it needs one more fact first — whether PLUGIN_ROOT/PLUGIN_DATA reach a
  //   plugin-sourced hook process, which only a live turn can answer.
});

// ---------------------------------------------------------------------------

/** Every handler `hooks.json` registers, flattened with the event it belongs to. */
function expectedHandlers() {
  const tpl = ourRegistrations();
  const out = [];
  for (const [event, groups] of Object.entries(tpl.hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        out.push({
          event,
          matcher: g.matcher ?? null,
          timeout: h.timeout,
          command: String(h.command).split('{{PLUGIN_ROOT}}').join(ROOT_TOKEN),
        });
      }
    }
  }
  return out;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Keep the unused-import checker honest about HOME_TOKEN: it is part of the recorded shape and
// is asserted here so a change to the tokeniser cannot go unnoticed.
test('the recorded answer is path-independent', () => {
  const rec = recordedAnswer();
  for (const h of rec.hooks) {
    assert.ok(h.sourcePath.startsWith(HOME_TOKEN),
      `the recording pinned a real path (${h.sourcePath}); it would only ever match the machine `
      + 'it was recorded on.');
    assert.ok(!/\/Users\/|\/home\//.test(JSON.stringify(h)),
      `the recording carries a home directory: ${JSON.stringify(h)}`);
  }
});
