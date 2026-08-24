// @ts-check
/**
 * `lib/redact.mjs` — the three-stage sanitisation pipeline.
 *
 * Redaction is the plugin's headline differentiator, and the one promise where being
 * approximately right is the same as being wrong: capture runs on every tool call, so
 * anything this pipeline misses leaves the machine. Everything below is load-bearing.
 *
 * Pipeline order, which the tests pin explicitly:
 *   Stage 1  pattern scrub   →  each match becomes `[REDACTED:<kind>]`
 *   Stage 2  path denylist   →  matching captures are DROPPED, not scrubbed
 *   Stage 3  byte caps       →  params 4 KiB/field, output 8 KiB
 *
 * Nothing here touches the network or spawns a hook — these are pure unit
 * tests over `lib/redact.mjs`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { lib, makeDataDir, makeProjectDir, withEnv, PLUGIN_ROOT } from './helpers/harness.mjs';
import { SECRETS } from './helpers/fixtures.mjs';

// ---------------------------------------------------------------------------
// Module under test — loaded lazily so each test fails on its own with the
// "lib/redact.mjs does not exist yet" message rather than aborting the file.
// ---------------------------------------------------------------------------

let _mod;
const R = async () => (_mod ??= await lib('redact.mjs'));

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** The §4.4 placeholder. Note spec §6.4 writes it lowercase; §4.4 wins. */
const PH = (kind) => `[REDACTED:${kind}]`;

/** §6.1 defaults, as the frozen `Config` shape from §4.1. */
function cfg(over = {}) {
  const dataDir = over.dataDir ?? makeDataDir();
  return Object.freeze({
    endpoint: 'https://mubit.example.com',
    mode: 'local',
    apiKey: '',
    userId: '',
    runStrategy: 'per-directory',
    capture: true,
    recall: true,
    redact: true,               // MUBIT_CC_REDACT=1
    denyGlobs: [],              // MUBIT_CC_CAPTURE_DENY, appended not replaced
    respectGitignore: true,     // MUBIT_CC_RESPECT_GITIGNORE=1
    maxParamBytes: 4096,        // MUBIT_CC_MAX_PARAM_BYTES
    maxOutputBytes: 8192,       // MUBIT_CC_MAX_OUTPUT_BYTES
    timeoutMs: 4000,
    logLevel: 'error',
    dataDir,
    pluginRoot: PLUGIN_ROOT,
    projectDir: over.projectDir ?? dataDir,
    ...over,
  });
}

/** `\n…[truncated <N> bytes]` — the §4.4 stage-3 marker. */
const TRUNC = /\n…\[truncated (\d+) bytes\]$/;

/** Split a stage-3 result into `{body, dropped}` where dropped is the marker's N. */
function splitTruncation(text) {
  const m = text.match(TRUNC);
  return { body: m ? text.replace(TRUNC, '') : text, droppedBytes: m ? Number(m[1]) : 0, marked: !!m };
}

/** Assert `text` contains none of the fixture credentials. */
function assertNoSecrets(text) {
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.ok(!text.includes(value), `SECRETS.${name} leaked through redaction`);
  }
}

// ===========================================================================
// Stage 1 — pattern scrub
// ===========================================================================

describe('stage 1 — pattern scrub (§4.4)', () => {
  /**
   * One row per kind in the §4.4 pattern table. `context` places the credential
   * in prose so the kind label is unambiguous — a credential wrapped in an
   * `NAME=value` assignment would legitimately match two rules.
   */
  const KINDS = [
    {
      kind: 'mubit-key',
      pattern: 'mbt_[A-Za-z0-9_-]{8,}',
      text: `rotated the instance key ${SECRETS.mubitKey} at 09:14 UTC`,
      secret: SECRETS.mubitKey,
    },
    {
      kind: 'openai-key',
      pattern: 'sk-[A-Za-z0-9_-]{16,}',
      text: `the model call used ${SECRETS.openaiKey} and returned 200`,
      secret: SECRETS.openaiKey,
    },
    {
      kind: 'github-token',
      pattern: 'gh[pousr]_[A-Za-z0-9]{20,}',
      text: `gh auth status reported ${SECRETS.githubToken} is still valid`,
      secret: SECRETS.githubToken,
    },
    {
      kind: 'aws-access-key',
      pattern: 'AKIA[0-9A-Z]{16}',
      text: `profile default resolves to ${SECRETS.awsKey} in us-east-1`,
      secret: SECRETS.awsKey,
    },
    {
      kind: 'jwt',
      pattern: 'eyJ[A-Za-z0-9_-]{8,}(\\.[A-Za-z0-9_-]{8,}){2}',
      text: `decoded claim ${SECRETS.jwt} expires in 3600s`,
      secret: SECRETS.jwt,
    },
    {
      kind: 'bearer',
      pattern: '\\bBearer\\s+[A-Za-z0-9._~+/=-]{12,}',
      text: `Authorization: ${SECRETS.bearer}`,
      secret: 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    },
    {
      kind: 'assignment',
      pattern: '(secret|token|password|credential|assertion|signature|apikey|api_key)\\s*[:=]\\s*\\S+',
      text: SECRETS.assignment,
      secret: 'hunter2correcthorsebattery',
    },
    {
      kind: 'high-entropy',
      // leakcheck-allow: redaction-threshold — the client's own detector, exercised right here.
      pattern: 'len >= 32, charset [A-Za-z0-9+/=_-], entropy >= 4.0',
      text: `cache blob ${SECRETS.highEntropy} written to disk`,
      secret: SECRETS.highEntropy,
    },
  ];

  for (const row of KINDS) {
    // §4.4 stage-1 table: every listed pattern is scrubbed to [REDACTED:<kind>].
    it(`scrubs ${row.kind} (${row.pattern})`, async () => {
      const { redactText } = await R();
      const r = redactText(row.text, cfg(), 'output');

      assert.ok(!r.text.includes(row.secret),
        `${row.kind}: credential survived. got:\n${r.text}`);
      assert.ok(r.text.includes(PH(row.kind)),
        `${row.kind}: expected ${PH(row.kind)} in:\n${r.text}`);
      assert.ok(r.redactions >= 1, `${row.kind}: redactions should count the match`);
    });
  }

  // §4.4 stage-1: `pem` spans lines — the whole BEGIN/END block goes, not one line.
  it('scrubs a multi-line pem block from BEGIN to END', async () => {
    const { redactText } = await R();
    const text = `wrote key material:\n${SECRETS.pem}\ndone`;
    const r = redactText(text, cfg(), 'output');

    assert.ok(r.text.includes(PH('pem')), `expected ${PH('pem')} in:\n${r.text}`);
    assert.ok(!r.text.includes('MIIEowIBAAKCAQEA1234567890abcdef'), 'pem body survived');
    assert.ok(!r.text.includes('BEGIN RSA PRIVATE KEY'), 'pem header survived');
    assert.ok(!r.text.includes('END RSA PRIVATE KEY'), 'pem footer survived');
    assert.ok(r.text.startsWith('wrote key material:'), 'surrounding prose must survive');
    assert.ok(r.text.trimEnd().endsWith('done'), 'surrounding prose must survive');
  });

  /**
   * §4.4: the `assignment` keyword list is seeded from the server's own policy
   *. The guide sketches the pattern with `\b`, but the
   * canonical fixture is `DATABASE_PASSWORD=…` — where the keyword is preceded
   * by `_`, a word character. A literal `\b` cannot match there, so the real
   * implementation must treat `_`/`-` separated names as word starts.
   */
  const ASSIGNMENTS = [
    ['secret',     'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['token',      'X_API_TOKEN=abc123def456ghi789jkl',                              'abc123def456ghi789jkl'],
    ['password',   SECRETS.assignment,                                               'hunter2correcthorsebattery'],
    ['credential', 'credential: swordfish-9182-oyster',                              'swordfish-9182-oyster'],
    ['assertion',  'assertion = c29tZS1hc3NlcnRpb24tdmFsdWU',                        'c29tZS1hc3NlcnRpb24tdmFsdWU'],
    ['signature',  'signature=deadbeef0123456789cafebabe',                           'deadbeef0123456789cafebabe'],
    ['apikey',     'apikey: ak-9182-oyster-swordfish',                               'ak-9182-oyster-swordfish'],
    ['api_key',    'api_key = pk-7261-halibut-mackerel',                             'pk-7261-halibut-mackerel'],
  ];

  for (const [keyword, text, value] of ASSIGNMENTS) {
    // §4.4 assignment keyword list, mirrored from the server's redaction policy.
    it(`scrubs an assignment keyed on "${keyword}"`, async () => {
      const { redactText } = await R();
      const r = redactText(text, cfg(), 'output');

      assert.ok(!r.text.includes(value), `"${keyword}" assignment leaked its value:\n${r.text}`);
      assert.ok(r.text.includes(PH('assignment')),
        `keyword-anchored rules must win over the generic entropy rule; got:\n${r.text}`);
    });
  }

  /**
   * The two ways a real secret gets past the assignment rule.
   *
   * Both were found by probing the shipped redactor rather than reading it, and
   * neither is about where on the line the assignment sits — an indented
   * `DATABASE_PASSWORD=` has always redacted correctly.
   *
   * **Shadowing.** The name group matches any `[A-Za-z0-9_-]` token and the value
   * group is `\S+`, so in `env: X_API_TOKEN=hunter2` the *first* match takes the
   * name `env` and the value `X_API_TOKEN=hunter2` — the whole secret. `env` holds
   * no keyword, the match is returned untouched, and the scan has already moved
   * past the thing it was looking for. Nothing about `env` is special: any word
   * plus a separator does it. It swallows exactly one assignment, which is why
   * the second of two on a line always redacted while the first never did.
   *
   * **URL credentials.** A password in a connection string is matched by no rule
   * at all: `DATABASE_URL` contains none of the keywords, and there is no
   * `user:pass@host` pattern. It leaks in every position, prose included.
   *
   * The entropy backstop hides both whenever the value is a real random key, so
   * what actually survives is the short human-chosen password — which is most of
   * what a pasted `.env` block is made of.
   */
  describe('secrets a neighbouring assignment used to hide', () => {
    it('redacts a keyword assignment shadowed by a plain one', async () => {
      const { redactText } = await R();
      const r = redactText('env: X_API_TOKEN=hunter2', cfg(), 'output');

      assert.ok(!r.text.includes('hunter2'), `shadowed secret leaked:\n${r.text}`);
      assert.ok(r.text.includes(PH('assignment')), `expected an assignment placeholder; got:\n${r.text}`);
      assert.ok(r.text.startsWith('env:'), `the shadowing name is not a secret and must survive:\n${r.text}`);
    });

    it('redacts every assignment on the line, not just the last', async () => {
      const { redactText } = await R();
      const r = redactText('env: A_TOKEN=alpha9182 B_SECRET=bravo7261', cfg(), 'output');

      assert.ok(!r.text.includes('alpha9182'), `first assignment leaked:\n${r.text}`);
      assert.ok(!r.text.includes('bravo7261'), `second assignment leaked:\n${r.text}`);
    });

    // The control. This shape already redacted before the fix, so it is what
    // proves the fix re-scanned the shadow rather than just widening the anchor.
    it('still redacts an assignment preceded by an unrelated one', async () => {
      const { redactText } = await R();
      const r = redactText('A=b X_API_TOKEN=hunter2', cfg(), 'output');

      assert.ok(!r.text.includes('hunter2'), `control case regressed:\n${r.text}`);
    });

    it('leaves a shadowing name that carries no secret alone', async () => {
      const { redactText } = await R();
      const r = redactText('note: the build is green', cfg(), 'output');

      assert.equal(r.text, 'note: the build is green');
      assert.equal(r.redactions, 0);
    });

    it('redacts the credentials in a connection string', async () => {
      const { redactText } = await R();
      const r = redactText('DATABASE_URL=postgres://admin:Tr0ub4dor@db.internal:5432/app', cfg(), 'output');

      assert.ok(!r.text.includes('Tr0ub4dor'), `URL password leaked:\n${r.text}`);
      assert.ok(r.text.includes(PH('url-credentials')), `expected a url-credentials placeholder; got:\n${r.text}`);
      assert.ok(r.text.includes('db.internal'), `the host is not a secret and must survive:\n${r.text}`);
    });

    it('redacts URL credentials in prose, where no assignment rule can reach', async () => {
      const { redactText } = await R();
      const r = redactText('try psql postgres://admin:Tr0ub4dor@db.internal/app and report back', cfg(), 'output');

      assert.ok(!r.text.includes('Tr0ub4dor'), `URL password leaked from prose:\n${r.text}`);
      assert.ok(r.text.startsWith('try psql'), `surrounding prose must survive:\n${r.text}`);
    });

    it('leaves a URL with no credentials alone', async () => {
      const { redactText } = await R();
      const r = redactText('see https://mubit.example.com/docs/a@b for the rest', cfg(), 'output');

      assert.equal(r.text, 'see https://mubit.example.com/docs/a@b for the rest');
      assert.equal(r.redactions, 0);
    });

    /*
     * The shape of both fixes is a scan that can be made to revisit what it has
     * already read, and a tool call is the one input an attacker picks the size
     * of. Each case below is a megabyte-scale run with no secret in it, chosen
     * so the pattern it stresses cannot match: a run of scheme-legal characters
     * for the URL rule, and separator-dense runs for the assignment rule. The
     * quadratic versions of both did not finish in two minutes.
     *
     * The budget is loose on purpose — it is here to separate linear from
     * quadratic, not to hold a millisecond figure that a slower machine would
     * fail. `capture` enforces the real one, end to end, at 15 s per hook.
     */
    it('scans a megabyte of adversarial text in linear time', async () => {
      const { redactText } = await R();
      const inputs = [
        'A'.repeat(2 * 1024 * 1024),
        ('http'.repeat(8) + '.').repeat(40_000),
        'a:b:c:d:'.repeat(32_768),
        'k=v;'.repeat(65_536),
      ];

      const started = Date.now();
      for (const text of inputs) assert.equal(redactText(text, cfg(), 'output').redactions, 0);
      const elapsed = Date.now() - started;

      assert.ok(elapsed < 5_000, `redaction is super-linear in input size: ${elapsed}ms for 4 inputs`);
    });
  });

  // §4.4: the placeholder format is exactly `[REDACTED:<kind>]` (spec §6.4 says
  // `[redacted:<kind>]`; the build guide is the implementation contract).
  it('uses the exact [REDACTED:<kind>] placeholder form', async () => {
    const { redactText } = await R();
    const r = redactText(`key=${SECRETS.mubitKey}`, cfg(), 'output');

    assert.match(r.text, /\[REDACTED:[a-z-]+\]/, `placeholder must be [REDACTED:<kind>]; got:\n${r.text}`);
    assert.ok(!/\[redacted:/.test(r.text), 'placeholder is uppercase REDACTED per §4.4');
  });

  // §4.4: `redactions` is the match count — capture.mjs writes it to metadata_json.
  it('counts every match in `redactions`', async () => {
    const { redactText } = await R();
    const text = [
      `mubit ${SECRETS.mubitKey}`,
      `openai ${SECRETS.openaiKey}`,
      `github ${SECRETS.githubToken}`,
    ].join('\n');
    const r = redactText(text, cfg(), 'output');

    assert.equal(r.redactions, 3, `expected 3 matches, got ${r.redactions} in:\n${r.text}`);
    assertNoSecrets(r.text);
  });

  // §4.4: the documented return shape is {text, redactions, dropped}.
  it('returns {text, redactions, dropped}', async () => {
    const { redactText } = await R();
    const r = redactText('nothing sensitive here', cfg(), 'output');

    assert.equal(typeof r.text, 'string');
    assert.equal(typeof r.redactions, 'number');
    assert.equal(typeof r.dropped, 'boolean');
    assert.equal(r.text, 'nothing sensitive here', 'clean text must pass through byte-identical');
    assert.equal(r.redactions, 0);
    assert.equal(r.dropped, false);
  });

  // §12.2: "a realistic .env body redacts every line".
  it('redacts every line of a realistic .env body', async () => {
    const { redactText } = await R();
    const dotenv = [
      `MUBIT_API_KEY=${SECRETS.mubitKey}`,
      `OPENAI_API_KEY=${SECRETS.openaiKey}`,
      `GITHUB_TOKEN=${SECRETS.githubToken}`,
      `AWS_ACCESS_KEY_ID=${SECRETS.awsKey}`,
      `SESSION_JWT=${SECRETS.jwt}`,
      SECRETS.assignment,
      `AUTH_HEADER=${SECRETS.bearer}`,
      `BACKUP_BLOB=${SECRETS.highEntropy}`,
    ].join('\n');

    const r = redactText(dotenv, cfg(), 'output');
    const lines = r.text.split('\n');

    assert.equal(lines.length, 8, 'line structure must be preserved');
    lines.forEach((line, i) => {
      assert.ok(line.includes('[REDACTED:'), `.env line ${i + 1} was not redacted: ${line}`);
    });
    assertNoSecrets(r.text);
    assert.ok(r.redactions >= 8, `expected >= 8 matches, got ${r.redactions}`);
  });
});

// ===========================================================================
// The idempotency-key exception
// ===========================================================================

describe('idempotency-key survives redaction', () => {
  /**
   * Idempotency keys are exempt from the scrub by design.
   * The plugin sets an idempotency key on EVERY ingest batch (§4.2
   * `postIngest`), so redacting it destroys the only handle a human has on
   * "did this batch get sent twice?".
   */
  const ID = 'cc-4f21ab90-1765000000';

  const SURVIVORS = [
    ['idempotency_key',   `POST /v2/control/ingest idempotency_key=${ID}`],
    ['idempotency-key',   `idempotency-key: ${ID}`],
    ['x-idempotency-key', `x-idempotency-key: ${ID}`],
  ];

  for (const [name, text] of SURVIVORS) {
    it(`keeps ${name}`, async () => {
      const { redactText } = await R();
      const r = redactText(text, cfg(), 'output');

      assert.ok(r.text.includes(ID), `${name} value was redacted:\n${r.text}`);
      assert.ok(r.text.includes(name), `${name} name was redacted:\n${r.text}`);
      assert.ok(!r.text.includes('[REDACTED:'), `nothing on this line is a credential:\n${r.text}`);
      assert.equal(r.redactions, 0);
    });
  }

  // The exception must be exactly two names, not "anything ending in _key".
  it('still redacts a sibling *_key that is NOT on the exception list', async () => {
    const { redactText } = await R();
    const text = `api_key=pk-7261-halibut-mackerel idempotency_key=${ID}`;
    const r = redactText(text, cfg(), 'output');

    assert.ok(!r.text.includes('pk-7261-halibut-mackerel'), 'api_key must still be scrubbed');
    assert.ok(r.text.includes(PH('assignment')));
    assert.ok(r.text.includes(ID), 'idempotency_key must survive alongside a redacted sibling');
  });
});

// ===========================================================================
// High-entropy false positives
// ===========================================================================

describe('high-entropy false-positive guard (spec §6.4)', () => {
  /**
   * Spec §6.4 argues the entropy rule should be CONJUNCTIVE — high entropy AND
   * within 40 chars of a key-ish token — because "an unconditional
   * high-entropy filter mangles ordinary build output, checksums and minified
   * code; that is a false-positive machine, and a redactor that destroys
   * legitimate content gets turned off."
   *
   * §4.4 states the rule unconditionally. These tests are written to §4.4 and
   * pass under BOTH readings, except where noted.
   */

  // Ordinary cargo output must pass through byte-identical.
  it('leaves ordinary build output untouched', async () => {
    const { redactText } = await R();
    const build = [
      '    Compiling acme-core v0.9.0 (/Users/x/repo/src/core)',
      '    Compiling acme-service v0.9.0 (/Users/x/repo/src/service)',
      'warning: unused variable `x`',
      "error[E0433]: failed to resolve: use of undeclared crate or module `tonic`",
      '    Finished dev [optimized + debuginfo] target(s) in 41.28s',
    ].join('\n');

    const r = redactText(build, cfg(), 'output');
    assert.equal(r.text, build, 'build output must survive byte-identical');
    assert.equal(r.redactions, 0);
  });

  /**
   * A git SHA survives because of what a 16-symbol alphabet can carry, not because of a
   * lucky fixture: no hex string can reach the bar, whatever its length. The assertion three
   * lines down is the statement of record; this comment only says why it is not a fluke.
   */
  it('leaves a git SHA intact, and entropy() proves why', async () => {
    const { redactText, entropy } = await R();
    const sha = '9f2c1a4b8e7d6c5f0a1b2c3d4e5f60718293a4b5';
    const line = `merged 04c3300 into ${sha} (fast-forward)`;

    assert.ok(sha.length >= 32, 'the SHA does clear the length gate');
    assert.ok(entropy(sha) < 4.0,
      `hex is capped at log2(16)=4.0 bits; got ${entropy(sha)}`);

    const r = redactText(line, cfg(), 'output');
    assert.equal(r.text, line, 'a git SHA is not a credential');
    assert.equal(r.redactions, 0);
  });

  /**
   * DOCUMENTED DIVERGENCE. A base64 literal inside minified code has entropy
   * ~5.0 over 64 chars, so §4.4's unconditional rule scrubs it while spec
   * §6.4's conjunctive rule does not. Whichever wins, the line must remain
   * legible — a redactor that turns source into `[REDACTED:high-entropy]` and
   * nothing else is the failure mode §6.4 is warning about.
   */
  it('does not mangle a minified base64 line into uselessness', async () => {
    const { redactText, entropy } = await R();
    const blob = 'TW96aWxsYS81LjAgKE1hY2ludG9zaDsgSW50ZWwgTWFjIE9TIFggMTBfMTVfNyk=';
    const line = `const ua = atob("${blob}");`;

    assert.ok(entropy(blob) > 4.0, 'this is genuinely high-entropy — hence the tension');

    const r = redactText(line, cfg(), 'output');
    assert.ok(r.text.startsWith('const ua = atob("'), `code prefix destroyed:\n${r.text}`);
    assert.ok(r.text.endsWith('");'), `code suffix destroyed:\n${r.text}`);
    assert.ok(r.text.includes('atob'), 'the identifier must survive either way');
    assert.ok(r.redactions <= 1,
      'at most the literal itself may be replaced, never the surrounding code');
  });

  // §4.4: the length gate is 32 — shorter high-entropy runs are left alone.
  it('leaves high-entropy runs shorter than 32 chars alone', async () => {
    const { redactText } = await R();
    const line = 'short blob Zm9vYmFyYmF6cXV4 in the log';
    const r = redactText(line, cfg(), 'output');
    assert.equal(r.text, line);
    assert.equal(r.redactions, 0);
  });
});

// ===========================================================================
// entropy()
// ===========================================================================

describe('entropy() — Shannon over the byte distribution (§4.4)', () => {
  it('is ~0 for a single repeated byte', async () => {
    const { entropy } = await R();
    assert.ok(entropy('aaaaaaaa') < 1e-9, `expected ~0, got ${entropy('aaaaaaaa')}`);
  });

  it('is exactly 1.0 for a balanced two-symbol string', async () => {
    const { entropy } = await R();
    assert.ok(Math.abs(entropy('ab'.repeat(16)) - 1.0) < 1e-9,
      `two equiprobable symbols is 1 bit; got ${entropy('ab'.repeat(16))}`);
  });

  it('is > 4 for a random-looking base64 run', async () => {
    const { entropy } = await R();
    assert.ok(entropy(SECRETS.highEntropy) > 4.0,
      `expected > 4.0, got ${entropy(SECRETS.highEntropy)}`);
  });

  it('does not throw on an empty string', async () => {
    const { entropy } = await R();
    assert.equal(entropy(''), 0);
  });
});

// ===========================================================================
// Order — scrub BEFORE cap. The single most important test in this file.
// ===========================================================================

describe('order — stage 1 runs before stage 3 (§4.4)', () => {
  /**
   * "Order matters: scrub before capping, so truncation cannot slice a secret
   * in half and leave the recognizable prefix." (§4.4)
   *
   * A cap-then-scrub implementation truncates mid-credential and the surviving
   * prefix — `sk-proj-AbCd…` — is never seen by the scrubber, because the
   * scrubber only ever ran on the already-shortened text. The leaked prefix is
   * enough to identify the provider, the account, and often to brute-force the
   * remainder.
   */
  it('fully removes a secret that straddles the byte-cap boundary', async () => {
    const { redactText } = await R();
    const c = cfg();
    // Place the key so it starts at byte 8180 and ends at 8224 — the 8192-byte
    // cap falls squarely inside it.
    const filler = 'x'.repeat(8180);
    const text = `${filler}${SECRETS.openaiKey} trailing context that will be cut`;
    assert.ok(filler.length < c.maxOutputBytes, 'sanity: the key starts inside the cap');
    assert.ok(filler.length + SECRETS.openaiKey.length > c.maxOutputBytes,
      'sanity: the key ends outside the cap — it straddles');

    const r = redactText(text, c, 'output');

    assert.ok(!r.text.includes(SECRETS.openaiKey), 'whole key survived');
    assert.ok(!r.text.includes('sk-'),
      `a sliced key prefix survived — stage 3 ran before stage 1:\n…${r.text.slice(8150)}`);
    assert.ok(!r.text.includes(SECRETS.openaiKey.slice(0, 12)), 'recognizable prefix survived');
    assert.ok(r.text.includes('[REDACTED:'),
      'the placeholder must be what occupies the boundary, not the key');
    assert.equal(r.redactions, 1, 'the scrubber must have seen the full key');
  });

  // Same property for the param cap, which is half the size and so easier to straddle.
  it('fully removes a secret straddling the 4 KiB param boundary', async () => {
    const { redactText } = await R();
    const text = 'y'.repeat(4090) + SECRETS.githubToken + ' tail';

    const r = redactText(text, cfg(), 'param');

    assert.ok(!r.text.includes(SECRETS.githubToken), 'whole token survived');
    assert.ok(!r.text.includes('ghp_'), 'a sliced token prefix survived');
    assert.equal(r.redactions, 1);
  });
});

// ===========================================================================
// Stage 2 — path denylist
// ===========================================================================

describe('stage 2 — path denylist (§4.4)', () => {
  // §4.4: matching captures are DROPPED entirely, not scrubbed.
  const DENIED = [
    '.env',
    '.env.local',
    '.env.production',
    'config/.env.test',
    'secrets/x.json',
    'secrets/nested/deep/token.txt',
    '~/.ssh/id_rsa',
    '/Users/x/.ssh/id_rsa.pub',
    '~/.ssh/id_ed25519',
    'deploy/id_ed25519',
    'certs/server.pem',
    'keys/private.key',
    'store/bundle.p12',
    'store/bundle.pfx',
    'vault/passwords.kdbx',
    'deploy/credentials',
    '~/.aws/credentials',
    '/home/u/.netrc',
    '.aws/config',
    '.gnupg/pubring.kbx',
  ];

  const ALLOWED = [
    'src/main.rs',
    'src/core/lib.rs',
    'README.md',
    'package.json',
    'docs/env-vars.md',
    'test/fixtures/environment.ts',
    '.github/workflows/ci.yml',
    'packages/app/src/templates.ts',
  ];

  for (const p of DENIED) {
    it(`denies ${p}`, async () => {
      const { isDeniedPath } = await R();
      const projectDir = makeProjectDir();
      assert.equal(isDeniedPath(p, cfg({ projectDir }), projectDir), true,
        `${p} must be dropped, not scrubbed`);
    });
  }

  for (const p of ALLOWED) {
    it(`allows ${p}`, async () => {
      const { isDeniedPath } = await R();
      const projectDir = makeProjectDir();
      assert.equal(isDeniedPath(p, cfg({ projectDir }), projectDir), false,
        `${p} is ordinary source and must be captured`);
    });
  }

  /**
   * §4.4 / spec §6.4: "plus everything git ignores". This is the high-yield
   * rule — the user already declared those paths as not-for-sharing, and
   * honouring that declaration costs them no new configuration.
   */
  it('denies anything the repo gitignores, and only that', async () => {
    const { isDeniedPath } = await R();
    const projectDir = makeProjectDir({
      git: true,
      files: {
        '.gitignore': 'build/\n*.log\n',
        'build/out.js': 'x',
        'debug.log': 'x',
        'src/main.rs': 'fn main() {}',
      },
    });
    const c = cfg({ projectDir });

    assert.equal(isDeniedPath('build/out.js', c, projectDir), true, 'gitignored path must drop');
    assert.equal(isDeniedPath('debug.log', c, projectDir), true, 'gitignored glob must drop');
    assert.equal(isDeniedPath('src/main.rs', c, projectDir), false, 'tracked source must be kept');
    assert.equal(isDeniedPath(join(projectDir, 'build/out.js'), c, projectDir), true,
      'absolute form of a gitignored path must drop too');
  });

  // §4.4 / §6.1: MUBIT_CC_CAPTURE_DENY *appends* globs; it does not replace.
  it('MUBIT_CC_CAPTURE_DENY appends to the built-in denylist', async () => {
    const { isDeniedPath } = await R();
    const projectDir = makeProjectDir();
    const extra = ['*.snap', 'fixtures/**'];

    withEnv({ MUBIT_CC_CAPTURE_DENY: extra.join(',') }, () => {
      const c = cfg({ projectDir, denyGlobs: extra });
      assert.equal(isDeniedPath('test/a.snap', c, projectDir), true, 'appended glob must deny');
      assert.equal(isDeniedPath('fixtures/data/x.json', c, projectDir), true, 'appended glob must deny');
      assert.equal(isDeniedPath('.env', c, projectDir), true,
        'built-in denylist must still apply — appended, not replaced');
      assert.equal(isDeniedPath('certs/server.pem', c, projectDir), true,
        'built-in denylist must still apply — appended, not replaced');
      assert.equal(isDeniedPath('src/main.rs', c, projectDir), false);
    });
  });
});

// ===========================================================================
// Stage 3 — byte caps
// ===========================================================================

describe('stage 3 — byte caps (§4.4)', () => {
  // §12.2: "100 KB output caps to 8 KB with metadata_json.truncated = true".
  it('caps 100 KB of output to 8 KiB and marks the truncation', async () => {
    const { redactText } = await R();
    const line = 'warning: unused variable `x` in src/core/runtime\n';
    const big = line.repeat(Math.ceil(102400 / line.length)).slice(0, 102400);
    assert.equal(Buffer.byteLength(big), 102400, 'sanity: exactly 100 KiB of ASCII');

    const r = redactText(big, cfg(), 'output');
    const { body, droppedBytes, marked } = splitTruncation(r.text);

    assert.ok(marked, `expected the \\n…[truncated <N> bytes] marker; got tail:\n${r.text.slice(-80)}`);
    assert.equal(Buffer.byteLength(body), 8192, 'body must be capped to exactly MUBIT_CC_MAX_OUTPUT_BYTES');
    assert.equal(droppedBytes, 102400 - 8192, 'the marker must report the real byte count');
    assert.ok(big.startsWith(body), 'the kept prefix must be a true prefix of the input');
    // capture.mjs §5.4 step 7 copies this straight into metadata_json.truncated
    // so the stored entry is honest about being partial.
    assert.equal(r.truncated, true, 'redactText must report truncation to its caller');
  });

  // §4.4: `kind` selects the cap — 4 KiB for params, 8 KiB for output.
  it('applies the 4 KiB param cap and the 8 KiB output cap by `kind`', async () => {
    const { redactText } = await R();
    const text = 'z'.repeat(5000);

    const asParam = splitTruncation(redactText(text, cfg(), 'param').text);
    const asOutput = redactText(text, cfg(), 'output');

    assert.equal(Buffer.byteLength(asParam.body), 4096, 'param fields cap at 4096');
    assert.ok(asParam.marked, 'a capped param must carry the marker');
    assert.equal(asOutput.text, text, '5000 bytes is under the 8192 output cap');
    assert.equal(asOutput.truncated, false);
  });

  // Boundary: text exactly at the cap is not truncated and carries no marker.
  it('does not mark text that is exactly at the cap', async () => {
    const { redactText } = await R();
    const exact = 'q'.repeat(8192);
    const r = redactText(exact, cfg(), 'output');

    assert.equal(r.text, exact, 'exactly-at-cap text must pass through untouched');
    assert.equal(r.truncated, false);
    assert.ok(!TRUNC.test(r.text), 'no marker at the boundary');
  });

  // A byte cap must not split a multi-byte character into replacement chars.
  it('never slices a UTF-8 character in half', async () => {
    const { redactText } = await R();
    const unit = 'héllo—wörld ';            // é/ö are 2 bytes, — is 3
    const text = unit.repeat(1200);
    assert.ok(Buffer.byteLength(text) > 8192, 'sanity: this overflows the cap');

    const r = redactText(text, cfg(), 'output');
    const { body } = splitTruncation(r.text);

    assert.ok(Buffer.byteLength(body) <= 8192, 'must not exceed the cap');
    assert.ok(!body.includes('�'), 'a sliced multi-byte char produced U+FFFD');
    assert.ok(text.startsWith(body), 'the kept prefix must be a true prefix of the input');
  });
});

// ===========================================================================
// Self-reference suppression
// ===========================================================================

describe('self-reference suppression (§4.4)', () => {
  /**
   * "Without this the plugin records its own traffic, recalls it, then records
   * the recall — and the store fills with
   * `curl https://eu.mubit.ai/v2/control/context`." (§4.4)
   */

  // Our own MCP tools, under the plugin-qualified prefix.
  const OWN_MCP = [
    'mcp__plugin_mubit-memory_mubit__mubit_recall',
    'mcp__plugin_mubit-memory_mubit__mubit_remember',
    'mcp__plugin_mubit-memory_mubit__mubit_context',
  ];

  for (const tool of OWN_MCP) {
    it(`drops our own MCP tool ${tool}`, async () => {
      const { isSelfReference } = await R();
      assert.equal(isSelfReference(tool, { query: 'why is ingest stuck' }, cfg()), true);
    });
  }

  /**
   * The easy-to-break case. A prefix test written as `startsWith('mcp__')` or
   * a substring test on `mubit` silently deletes every other MCP server's
   * output from the user's memory, and nothing surfaces the loss.
   */
  it('KEEPS a foreign MCP tool (mcp__github__create_issue)', async () => {
    const { isSelfReference } = await R();
    assert.equal(
      isSelfReference('mcp__github__create_issue', { title: 'bug', body: 'x' }, cfg()),
      false,
      'foreign MCP output is exactly the cross-tool memory this plugin exists to keep');
  });

  it('KEEPS other foreign MCP tools', async () => {
    const { isSelfReference } = await R();
    for (const tool of ['mcp__codaph__codaph_status', 'mcp__linear__list_issues', 'mcp__slack__post_message']) {
      assert.equal(isSelfReference(tool, {}, cfg()), false, `${tool} must be kept`);
    }
  });

  // §4.4: Bash whose command mentions the endpoint host:port, /v2/control/,
  // /v2/core/, `mubit`, or `MUBIT_`.
  const BASH_DROP = [
    ['the guide\'s own example', 'curl https://eu.mubit.ai/v2/control/context'],
    ['endpoint host:port', 'curl -s https://eu.mubit.ai/healthz'],
    ['/v2/control/ path', 'curl -X POST https://api.example.com/v2/control/ingest -d @body.json'],
    ['/v2/core/ path', 'curl https://api.example.com/v2/core/health'],
    ['the word mubit', 'the mubit endpoint'],
    ['a MUBIT_ env var', 'echo $MUBIT_API_KEY | head -c 8'],
    ['a mubit cargo target', 'cargo test -p mubit-demo'],
  ];

  for (const [why, command] of BASH_DROP) {
    it(`drops Bash mentioning ${why}`, async () => {
      const { isSelfReference } = await R();
      assert.equal(isSelfReference('Bash', { command }, cfg()), true, `should drop: ${command}`);
    });
  }

  const BASH_KEEP = [
    'ls -la',
    'cargo check -p tonic',
    'git status --porcelain',
    'curl http://127.0.0.1:9999/health',   // loopback, but not OUR host:port
    'npm run build',
  ];

  for (const command of BASH_KEEP) {
    it(`keeps Bash: ${command}`, async () => {
      const { isSelfReference } = await R();
      assert.equal(isSelfReference('Bash', { command }, cfg()), false, `should keep: ${command}`);
    });
  }

  // §4.4: a subject path inside ${CLAUDE_PLUGIN_DATA} or ${CLAUDE_PLUGIN_ROOT}.
  it('drops a subject path inside ${CLAUDE_PLUGIN_DATA}', async () => {
    const { isSelfReference } = await R();
    const dataDir = makeDataDir();
    const c = cfg({ dataDir });

    withEnv({ CLAUDE_PLUGIN_DATA: dataDir, MUBIT_CC_DATA_DIR: dataDir }, () => {
      const spool = join(dataDir, 'runs', 'cc-repo-1a2b3c4d', 'spool', '1765000000-a1b2c3.json');
      assert.equal(isSelfReference('Read', { file_path: spool }, c), true);
      assert.equal(isSelfReference('Bash', { command: `cat ${join(dataDir, 'status', 'state.json')}` }, c), true);
    });
  });

  it('drops a subject path inside ${CLAUDE_PLUGIN_ROOT}', async () => {
    const { isSelfReference } = await R();
    const c = cfg();

    withEnv({ CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }, () => {
      assert.equal(isSelfReference('Read', { file_path: join(PLUGIN_ROOT, 'lib', 'redact.mjs') }, c), true);
      assert.equal(isSelfReference('Edit', { file_path: join(PLUGIN_ROOT, 'hooks', 'src', 'capture.mjs') }, c), true);
    });
  });

  it('keeps an ordinary project path', async () => {
    const { isSelfReference } = await R();
    const projectDir = makeProjectDir();
    const c = cfg({ projectDir });

    assert.equal(isSelfReference('Read', { file_path: join(projectDir, 'src', 'main.rs') }, c), false);
    assert.equal(isSelfReference('Edit', { file_path: '/Users/x/repo/src/core/runtime/lib.rs' }, c), false);
  });

  it('does not throw on a missing or empty tool_input', async () => {
    const { isSelfReference } = await R();
    const c = cfg();
    assert.equal(isSelfReference('Bash', {}, c), false);
    assert.equal(isSelfReference('Bash', undefined, c), false);
    assert.equal(isSelfReference('', {}, c), false);
    assert.equal(isSelfReference(undefined, undefined, c), false);
  });
});

// ===========================================================================
// MUBIT_CC_REDACT=0
// ===========================================================================

describe('MUBIT_CC_REDACT=0 (§6.1)', () => {
  /**
   * "`0` disables the scrub stage; denylist and caps still apply." (§6.1)
   * The escape hatch exists for users whose tool output is mangled by the
   * entropy rule — it must not also disable the two stages that have no
   * false-positive cost.
   */
  it('skips the scrub stage', async () => {
    const { redactText } = await R();
    const text = `key=${SECRETS.openaiKey}`;

    withEnv({ MUBIT_CC_REDACT: '0' }, () => {
      const r = redactText(text, cfg({ redact: false }), 'output');
      assert.equal(r.text, text, 'scrub must be skipped verbatim');
      assert.equal(r.redactions, 0);
    });
  });

  it('still applies the byte caps', async () => {
    const { redactText } = await R();
    const big = 'w'.repeat(100 * 1024);

    withEnv({ MUBIT_CC_REDACT: '0' }, () => {
      const r = redactText(big, cfg({ redact: false }), 'output');
      const { body, marked } = splitTruncation(r.text);
      assert.equal(Buffer.byteLength(body), 8192, 'caps are not part of the scrub stage');
      assert.ok(marked);
      assert.equal(r.truncated, true);
    });
  });

  it('still applies the path denylist', async () => {
    const { isDeniedPath } = await R();
    const projectDir = makeProjectDir();

    withEnv({ MUBIT_CC_REDACT: '0' }, () => {
      const c = cfg({ redact: false, projectDir });
      assert.equal(isDeniedPath('.env', c, projectDir), true);
      assert.equal(isDeniedPath('~/.ssh/id_rsa', c, projectDir), true);
      assert.equal(isDeniedPath('src/main.rs', c, projectDir), false);
    });
  });
});

// ===========================================================================
// redactParams
// ===========================================================================

describe('redactParams — recursive, caps each field (§4.4)', () => {
  /** Symmetric with redactText; capture.mjs needs the count for metadata_json.redactions. */
  it('returns {params, redactions}', async () => {
    const { redactParams } = await R();
    const r = redactParams({ file_path: '/Users/x/repo/src/lib.rs' }, cfg());

    assert.equal(typeof r.redactions, 'number');
    assert.deepEqual(r.params, { file_path: '/Users/x/repo/src/lib.rs' });
  });

  it('recurses into nested objects and arrays', async () => {
    const { redactParams } = await R();
    const toolInput = {
      url: 'https://api.example.com/v1/issues',
      options: {
        headers: { authorization: SECRETS.bearer, 'content-type': 'application/json' },
        auth: { nested: { deeper: SECRETS.mubitKey } },
      },
      args: ['--token', SECRETS.githubToken, '--verbose'],
      env: [{ name: 'OPENAI_API_KEY', value: SECRETS.openaiKey }],
    };

    const r = redactParams(toolInput, cfg());
    const flat = JSON.stringify(r.params);

    assertNoSecrets(flat);
    assert.ok(r.redactions >= 4, `expected >= 4 matches, got ${r.redactions}`);
    assert.equal(r.params.url, 'https://api.example.com/v1/issues', 'benign fields survive');
    assert.equal(r.params.options.headers['content-type'], 'application/json');
    assert.ok(Array.isArray(r.params.args), 'array structure must be preserved');
    assert.equal(r.params.args.length, 3, 'array length must be preserved');
    assert.equal(r.params.args[0], '--token');
    assert.equal(r.params.args[2], '--verbose');
    assert.ok(Array.isArray(r.params.env));
    assert.equal(r.params.env[0].name, 'OPENAI_API_KEY');
  });

  it('passes non-string values through without throwing', async () => {
    const { redactParams } = await R();
    const toolInput = {
      timeout: 42,
      retries: 0,
      dry_run: false,
      nothing: null,
      missing: undefined,
      nested: { list: [1, 2, [3, { deep: true }]], flag: true },
      empty_obj: {},
      empty_arr: [],
    };

    const r = redactParams(toolInput, cfg());

    assert.equal(r.params.timeout, 42);
    assert.equal(r.params.retries, 0);
    assert.equal(r.params.dry_run, false);
    assert.equal(r.params.nothing, null);
    assert.deepEqual(r.params.nested.list, [1, 2, [3, { deep: true }]]);
    assert.equal(r.params.nested.flag, true);
    assert.deepEqual(r.params.empty_obj, {});
    assert.deepEqual(r.params.empty_arr, []);
    assert.equal(r.redactions, 0);
  });

  it('does not throw on null, undefined or a non-object tool_input', async () => {
    const { redactParams } = await R();
    const c = cfg();
    assert.doesNotThrow(() => redactParams(null, c));
    assert.doesNotThrow(() => redactParams(undefined, c));
    assert.doesNotThrow(() => redactParams('a bare string', c));
    assert.doesNotThrow(() => redactParams([SECRETS.mubitKey], c));
  });

  // §4.4: "caps each field" — 4 KiB per field, not 4 KiB shared across the object.
  it('caps each field independently at MUBIT_CC_MAX_PARAM_BYTES', async () => {
    const { redactParams } = await R();
    const toolInput = { old_string: 'a'.repeat(5000), new_string: 'b'.repeat(5000) };

    const r = redactParams(toolInput, cfg());
    const a = splitTruncation(r.params.old_string);
    const b = splitTruncation(r.params.new_string);

    assert.equal(Buffer.byteLength(a.body), 4096, 'old_string capped independently');
    assert.equal(Buffer.byteLength(b.body), 4096, 'new_string capped independently');
    assert.ok(a.marked && b.marked, 'both capped fields carry the marker');
  });

  // Order holds inside redactParams too: a straddling secret is fully removed.
  it('scrubs before capping inside a nested field', async () => {
    const { redactParams } = await R();
    const toolInput = { body: 'p'.repeat(4090) + SECRETS.mubitKey + ' tail' };

    const r = redactParams(toolInput, cfg());

    assert.ok(!r.params.body.includes(SECRETS.mubitKey), 'whole key survived');
    assert.ok(!r.params.body.includes('mbt_'), 'a sliced key prefix survived the param cap');
    assert.equal(r.redactions, 1);
  });
});
