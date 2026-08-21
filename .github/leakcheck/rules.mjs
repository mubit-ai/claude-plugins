// @ts-check
/**
 * `.github/leakcheck/rules.mjs` — what may not appear in this repository.
 *
 * This repository is **public**. Everything tracked here is readable by anyone, forever:
 * `git rm` in a later commit does not unpublish a blob that was pushed, and a merged pull
 * request keeps its diff. So the only leak that stays cheap is the one that never lands.
 *
 * Every rule below was written from something actually found in the tree, not imagined. The
 * `found` field on each names the case that motivated it, so a future reader can tell a live
 * rule from a speculative one, and so that widening a rule can be argued against a real
 * example rather than a hypothetical.
 *
 * Severities:
 *   `block` — fails CI. Publishing this costs something that cannot be taken back.
 *   `warn`  — reported, never fails. Hygiene, or a judgement call an owner should make.
 *
 * Suppressing a line: put `leakcheck-allow: <rule-id> — why` on the line itself or the line
 * above it. The reason is not optional in review; the scanner does not parse it, humans do.
 *
 * Existing findings are carried in `baseline.json` so the scanner can be turned on before the
 * backlog is cleared. The baseline suppresses *what is already there*; anything new fails.
 */

/* -------------------------------------------------------------------------- */
/* scan configuration                                                          */
/* -------------------------------------------------------------------------- */

export const CONFIG = {
  /**
   * Files above this size are scanned only by rules marked `heavy: true`. `mcp/dist/server.js`
   * is 5.9 MB of vendored bundle; running twenty-five regexes over 48 000 lines of it on every
   * push buys nothing that one structural rule does not already say.
   */
  maxTextBytes: 3 * 1024 * 1024,

  /** Tracked files larger than this are reported by `oversized-artifact`. */
  oversizedBytes: 2 * 1024 * 1024,

  /**
   * Extensions read as text no matter what bytes they contain. This is load-bearing, not
   * defensive: four tracked source files (`lib/config.mjs`, `lib/redact.mjs`, `lib/runid.mjs`,
   * `test/state.test.mjs`) hold literal NUL bytes in string fixtures, which makes git call them
   * binary and makes `git grep` skip them unless it is passed `-a`. `lib/config.mjs` is one of
   * the files with a real finding in it. A scanner that sniffed for NUL would be blind to
   * exactly the file that needed it most.
   */
  textExtensions: [
    '.mjs', '.js', '.cjs', '.ts', '.mts', '.json', '.md', '.yml', '.yaml', '.sh',
    '.txt', '.toml', '.html', '.css', '.gitignore', '.env', '.lock',
  ],

  /** Paths never scanned. Keep this list short and boring. */
  excludePaths: [
    '.github/leakcheck/baseline.json',
    '.github/leakcheck/rules.mjs',
    '.github/leakcheck/POLICY.md',
    '.github/scripts/leakcheck.mjs',
    '.github/scripts/llm-leak-review.mjs',
    'package-lock.json',
    '**/package-lock.json',
  ],

  /** Addresses that may appear. Anything else matching an email shape is a finding. */
  allowedEmails: [
    'you@example.com',
    'test@example.com',
    'user@example.com',
    'noreply@github.com',
  ],

  /**
   * Substrings that mark a credential-shaped string as an obvious placeholder. The runbooks
   * are full of deliberately fake keys and they should stay legible as fake.
   */
  placeholderMarkers: [
    'example', 'dontleak', 'stub', 'fake', 'dummy', 'placeholder', 'wrongkey', 'test',
    'deadbeef', 'xxxx', 'redacted', 'notarealkey', 'local', 'offline', 'manual',
    '0000000000', '1234567890', 'abcdef',
  ],

  /**
   * Credential-shaped strings that are themselves published documentation. The redaction
   * tests need vectors that look exactly like the real thing, and these are the ones the
   * issuing vendors print in their own docs — so they carry no placeholder marker and would
   * otherwise be the only two "live keys" the scanner ever finds.
   */
  knownPublicExamples: [
    'ghp_16C7e42F292c6912E7710c838347Ae178B4a',
    'AKIAIOSFODNN7EXAMPLE',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  ],
};

/* -------------------------------------------------------------------------- */
/* rules                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} Rule
 * @property {string}   id        stable identifier; used by baseline and by suppressions
 * @property {'block'|'warn'} severity
 * @property {'content'|'path'|'structural'} kind
 * @property {RegExp}  [pattern]  for `kind: 'content'` and `kind: 'path'`
 * @property {string[]}[include]  globs this rule applies to (default: everything)
 * @property {string[]}[exclude]  globs this rule skips
 * @property {boolean} [heavy]    run on files above `maxTextBytes`
 * @property {string}   why       what publishing this costs
 * @property {string}   fix       what to do instead
 * @property {string}   found     the real case that motivated the rule
 */

/** @type {Rule[]} */
export const RULES = [
  /* ---------------------------------------------------------------- */
  /* 1. Mubit's own closed source                                      */
  /* ---------------------------------------------------------------- */
  {
    id: 'private-source-path',
    severity: 'block',
    kind: 'content',
    pattern: /\bcrates\/[a-z0-9_-]+\/[a-z0-9_\/-]*|\bmubit-[a-z-]*(?:control|core|engine|server)[a-z-]*\b|\bcontrol\/service\/src\b|\bpackages\/server\/src\b/gi,
    why: 'Names a file or crate inside the closed-source server. It tells a reader the server is Rust, how its workspace is laid out, and which file to ask about — none of which is inferable from a client.',
    fix: 'Describe the behaviour without citing where it lives. "The control plane widens a lesson beyond its run" says the same thing and names nothing.',
    found: 'A script header cited a source file inside the server by path, and quoted a comment out of it.',
  },
  {
    id: 'internal-doc-reference',
    severity: 'block',
    kind: 'content',
    pattern: /\bbuild-guide\b|\bphase \d+ §|\bsee §\d+(?:\.\d+)* of the [a-z-]+ guide/gi,
    why: 'Cites a private engineering document by section. It is useless to a user and it maps the internal spec for everyone else.',
    fix: 'Inline the fact. If a section number is genuinely load-bearing for a maintainer, it belongs in the source repository, not the published mirror.',
    found: 'About sixty citations of the private design guide, by section, across scripts, lib and tests.',
  },
  {
    id: 'internal-spec-section',
    severity: 'warn',
    kind: 'content',
    pattern: /§\d+(?:\.\d+)*/g,
    include: ['**/lib/**', '**/hooks/**', '**/mcp/**', '**/bin/**', '**/scripts/**', '**/test/**', '**/skills/**'],
    why: 'A bare section symbol in shipped source points at a document the reader does not have. Individually harmless; at scale it is a table of contents for the private specification, reconstructible by anyone who reads the tree.',
    fix: 'Say the rule, not its address. In docs, a `§` that refers to a heading in the same file is fine — that is why this rule does not apply there.',
    found: '1 790 of them in lib, hooks, scripts, bin and test. In docs the same symbol is usually a self-reference, so docs are excluded.',
  },

  /* ---------------------------------------------------------------- */
  /* 2. How the hosted service behaves, beyond the wire contract       */
  /* ---------------------------------------------------------------- */
  {
    id: 'server-internal-mechanics',
    severity: 'block',
    kind: 'content',
    pattern: /shadow A\/B|validation gate|cross-run overlay|promotion(?:-only)? \(§|state::<?tenant|lesson\.is_rule|AgentRouted|clamps? `?limit`? to \d+ server-side|the control (?:plane|service) (?:surfaces|admits|defaults)|the server (?:prefers|trusts|defaults|ranks|scores)/gi,
    why: 'Describes what the server does with a request after it arrives. The wire contract is unavoidably public — a client makes it so — but the mechanism behind it is the product, and nothing in a client needs to explain it.',
    fix: 'State the client-visible consequence and stop there.',
    found: 'A runbook listed the ranking mechanisms an outcome feeds, by name, in a single sentence.',
  },
  {
    id: 'server-tuning-constant',
    severity: 'block',
    kind: 'content',
    pattern: /\b\d\.\d{1,2} ?\/ ?\d\.\d{1,2} (?:validation |confidence |scoring )?(?:gate|threshold|split)|confidence (?:floor|threshold) of \d\.\d/gi,
    why: 'A tuned threshold from the ranking side. Two numbers are enough to work out the shape of the model behind them, and they change without notice.',
    fix: 'Say "above the confidence floor" and leave the number where it is set.',
    found: 'Two runbooks printed a pair of tuned thresholds as one figure.',
  },
  {
    id: 'wire-field-explanation',
    severity: 'warn',
    kind: 'content',
    pattern: /knowledge_confidence|routing_summary|consulted_runs|explain_info/g,
    why: 'A response field. It is client-visible by construction, so its name is not a secret — but a cluster of these usually means a paragraph nearby is explaining the ranking behind them, which is not client-visible.',
    fix: 'Nothing, if it is a field access or a stub fixture. Read the surrounding prose before allowing it.',
    found: 'Stub servers returned the full response envelope, which is fine; the prose around them was not.',
  },

  {
    id: 'hosted-infrastructure',
    severity: 'block',
    kind: 'content',
    pattern: /spec\.policy\.[A-Za-z]+|pod restart|the pods? (?:read|restart)|kubectl|helm |CRD field/g,
    why: 'Names how the hosted instance is deployed and which operator switch changes its behaviour. That is the shape of our infrastructure, and it is a starting point for anyone probing it.',
    fix: 'Say "an operator can enable direct search on your instance" and leave the mechanism out.',
    found: 'A runbook named the deployment field an operator flips, and how the process picks it up.',
  },
  {
    id: 'llm-cost-model',
    severity: 'warn',
    kind: 'content',
    pattern: /(?:zero|no|one|two|three|\d+) LLM calls?|LLM-free|pays? two LLM|incurs? .{0,20}LLM/gi,
    why: 'The number of model calls each retrieval path costs is our unit economics, per rung, in public. It also tells a reader which path to force in order to make a tenant expensive.',
    fix: 'Describe latency the user can observe. A config table saying what a setting costs the user is fine — informed consent, and they are the ones paying for it. A comparison of the internal retrieval paths by call count is not, and that distinction is why this is a warning a human reads rather than a hard block.',
    found: 'A runbook compared the internal retrieval paths by how many model calls each costs.',
  },
  {
    id: 'reinforcement-arithmetic',
    severity: 'block',
    kind: 'content',
    pattern: /relevance floor|counts any signal[^.\n]{0,32}reinforcement|reinforcements?=\d|moves? the stored (?:score|confidence) by/gi,
    why: 'How the server turns a submitted outcome into a change in ranking, and whether anything filters a weak hit. The signal the client sends is public by construction — the plugin exports it as a constant and puts it on the wire — but what the server does with it on arrival is not.',
    fix: 'Document the signal the client sends, which a user can observe anyway. Leave the arithmetic that consumes it server-side.',
    found: 'A runbook printed the amount an outcome moves a stored score, and noted that nothing filters weak hits.',
  },
  /* ---------------------------------------------------------------- */
  /* 3. Security posture and unfixed defects                           */
  /* ---------------------------------------------------------------- */
  {
    id: 'unauthenticated-surface',
    severity: 'block',
    kind: 'content',
    pattern: /allowlisted before auth|before authentication|answers .{0,24}(?:for|with) (?:a )?wrong key|no auth(?:entication)? (?:is )?required|without a key at all|for a wrong key|the (?:access|core access) policy allowlists/gi,
    why: 'Points at the one route on the production control plane that answers without a credential. That is a free liveness and enumeration probe for anyone who reads it.',
    fix: 'Do not document the auth boundary from the outside. If a health route must be open, that is an infrastructure decision, not a published one.',
    found: 'A runbook described which route answers before the credential is checked.',
  },
  {
    id: 'credential-shape-disclosure',
    severity: 'block',
    kind: 'content',
    pattern: /mbt_[A-Za-z0-9]{2,10}\u2026|\(\d{2,4} chars\)|key\s+mbt_[A-Za-z0-9]{4,}/g,
    why: 'A real key\'s prefix and its exact length. Neither is the key, and together they remove most of the search space anyone brute-forcing the format would otherwise have to cover.',
    fix: 'Print `key  (set)`. The runbooks never needed the prefix to prove a key was loaded.',
    found: 'Five runbooks printed a live key\'s leading characters together with its exact length.',
  },
  {
    id: 'credential-extraction-recipe',
    severity: 'block',
    kind: 'content',
    pattern: /credentials\.json["'`)\]]*\s*\)?\.apiKey|require\([^)]*credentials\.json|cat .{0,60}credentials\.json/g,
    why: 'A copy-pasteable one-liner that reads the stored API key off disk, naming the exact path. It is a working credential-theft snippet that also tells a reader where to look on any machine with the plugin installed.',
    fix: 'Read the key from the environment in runbooks, and leave the on-disk path to the code that needs it.',
    found: 'Eight runbooks shared one copy-pasteable line that reads the stored key off disk.',
  },
  {
    id: 'redaction-threshold',
    severity: 'block',
    kind: 'content',
    pattern: /Shannon entropy|entropy (?:\u2265|>=|of at least|above) ?\d|\d{2}\+ (?:base64|hex) characters/gi,
    why: 'The exact threshold the secret detector fires at. Published, it is a recipe for shaping a secret that passes through capture unredacted — which is the one promise capture makes.',
    fix: 'Say "a high-entropy catch-all". The number belongs in the code and its tests.',
    found: 'A user-facing guide printed the exact cutoff the secret detector fires at.',
  },

  {
    id: 'isolation-defect-disclosure',
    severity: 'block',
    kind: 'content',
    pattern: /tenant-wide|cross-run leak|write into any run(?: it can name)?|blast radius|(?:leak|leaks|leaked|leaking|injected) into (?:other|five unrelated|unrelated)|the whole tenant/gi,
    why: 'Describes a live isolation weakness in the hosted service, in public, with enough precision to reproduce it. This is not reverse engineering — it is a disclosure, and it is worse than the code it guards.',
    fix: 'Fix it server-side, then describe the guarantee rather than the gap. Until then the note belongs in the private tracker.',
    found: 'Two source comments described, precisely, what an unguarded client could write and where.',
  },
  {
    id: 'client-side-only-control',
    severity: 'block',
    kind: 'content',
    pattern: /guard(?:s|ed)? (?:it )?at the wire|clamps? (?:that|it) at the wire|(?:the )?(?:only|missing) (?:egress|guard) stage|the vendored bundle stays byte-identical|nothing (?:else )?enforces it|there is no server-side check/gi,
    why: 'Says out loud that a safety property is enforced in the client. A client-side clamp is a usability feature; publishing that it is the only one tells a reader precisely which call to make without the client.',
    fix: 'Enforce the ceiling server-side and let the client note say only what it does locally.',
    found: 'A module header explained that it was the only thing enforcing a scope ceiling.',
  },

  {
    id: 'server-internal-symbol',
    severity: 'block',
    kind: 'content',
    pattern: /enforce_[a-z_]+_policy|\bState[A-Za-z]+Payload\b|\b(?:AgentQuery|Context|RecordOutcome|ListLessons)Request\b|#\[serde/g,
    why: 'Internal type and function names from the server, and the serialisation attribute that identifies its language. A client never needs to name the struct on the other side of the wire; naming it hands over the shape of the private codebase.',
    fix: 'Describe the request by its route and its fields, which are observable, not by the type that receives it.',
    found: 'One module named a server authorisation function, five internal payload types, and the serialisation attribute that identifies the language.',
  },
  {
    id: 'tenancy-collapse',
    severity: 'block',
    kind: 'content',
    pattern: /one shared run|collapses every (?:user|project|machine)|every (?:MCP )?user writes every project|writes every project on every machine/g,
    why: 'Describes a live defect in which unrelated users, projects and machines land in the same run, and names the exact value that triggers it. That is a cross-tenant data-mixing bug published together with its reproduction.',
    fix: 'Fix it, then say nothing about the shape it used to have.',
    found: 'Two modules described a defect that puts unrelated users in one bucket, and named the value that causes it.',
  },
  {
    id: 'server-cap-or-threshold',
    severity: 'block',
    kind: 'content',
    pattern: /\d+ ?(?:KiB|MiB|GiB) server-side|server-side cap|clamps? [^.\n]{0,24} server-side|threshold defaults to \d|reflection threshold|negative-streak/gi,
    why: 'Server-side limits and trigger thresholds. Each one is a knob an outsider can aim at: a cap tells them where to sit just underneath, a trigger threshold tells them how many events to send to fire it.',
    fix: 'Handle the limit in the client and let the error message be the documentation.',
    found: 'Three files stated a server-side trigger threshold, a per-route body cap, and a pagination clamp.',
  },
  {
    id: 'server-latency-profile',
    severity: 'warn',
    kind: 'content',
    pattern: /measured median \d+ ?ms|hosted tail (?:at|of) [\d,]+|~?\d+[-\u2013]\d+ ?ms server-side|answers? in ~\d+|granted in \d+ ?ms/gi,
    why: 'Measured production latency of the backend, by route. Some of it is genuinely useful to a user choosing a timeout; the distribution and the tail are ours.',
    fix: 'Publish the default timeout and why it was chosen. Keep the measured distribution in the source repository.',
    found: 'A module and the README both published the measured latency distribution of the backend, by path.',
  },
  {
    id: 'internal-ticket-id',
    severity: 'block',
    kind: 'content',
    pattern: /\bMUB-\d+\b|\bHS-\d\b|\baudit [A-Z]\d\b|\bF\d:\s/g,
    why: 'Issue-tracker and audit identifiers from a private tracker. They are unresolvable to a reader and they let an outsider count and correlate our internal work.',
    fix: 'Say what changed. A tracker id in shipped source is a note to yourself in someone else\'s house.',
    found: 'Seven source files and several runbooks carried identifiers from a private tracker.',
  },
  {
    id: 'mirror-process-disclosure',
    severity: 'block',
    kind: 'content',
    pattern: /the built mirror|sanitised mirror|which the mirror excludes|denylist[^.\n]{0,40}(?:not published|withheld|excluded)/gi,
    why: 'Announces that this repository is a filtered copy of a private one and names the script that does the filtering. It tells a reader that content was removed, which is an invitation to work out what.',
    fix: 'The mirror should be silent about being a mirror beyond the one line in the README that stops people editing it here.',
    found: 'A script comment announced that this tree is a filtered copy, and named the script that filters it.',
  },
  {
    id: 'internal-benchmark',
    severity: 'warn',
    kind: 'content',
    pattern: /Terminal-Bench|tbench|benchmark harness|A\/B rig/gi,
    why: 'Names an internal evaluation harness and, where it is quoted, the numbers it produced. Competitive information, and none of it is reproducible by a reader.',
    fix: 'Cite the behaviour the benchmark established, not the benchmark.',
    found: 'A hook comment cited an internal evaluation sweep and the production figure it produced.',
  },
  /* ---------------------------------------------------------------- */
  /* 4. Third-party internals — other people's closed source           */
  /* ---------------------------------------------------------------- */
  {
    id: 'host-binary-extraction',
    severity: 'block',
    kind: 'content',
    pattern: /strings\s+-a\b|\.local\/share\/claude\/versions|matcherMetadata|hookEventName:[A-Za-z0-9_$]+\(|\bfOr\(\)\?|read out of the (?:shipping|host) binary|the 2\.\d+\.\d+ binary|the host's own registry|hook_event_name:\s*[a-z]{1,2}\(|isolatedContext|ASYNC_REWAKE[A-Z_]+|matchQuery:|decompil/g,
    why: 'Extracts and republishes strings from a vendor\'s shipping binary, including unannounced features and a feature-flagged error list. It publishes someone else\'s roadmap under our name and teaches the technique alongside it.',
    fix: 'Pin the behaviour with a test against observed payloads, and cite the public reference. Where the public reference is wrong, say what was observed, not where it was carved out of.',
    found: 'Four files carried extraction recipes against the installed host binary, plus verbatim minified fragments of it.',
  },

  {
    id: 'upstream-vendor-disclosure',
    severity: 'block',
    kind: 'content',
    pattern: /instanceId:\s*['"`][a-z]{2,6}-[a-z0-9]{4,}|(?:vendor|upstream|provider)Url:\s*['"`]https?:\/\//gi,
    why: 'Names a third-party service sitting behind our auth exchange, together with its instance-id format and the fields we exchange with it. Our supply chain is not ours alone to publish, and it hands an attacker a second door to look at.',
    fix: 'Fixture the token-exchange response with neutral field values. The plugin never needs the upstream\'s real host to be under test.',
    found: 'A test fixture reproduced a token-exchange response verbatim, third-party host and instance-id format included.',
  },
  {
    id: 'unpublished-file-reference',
    severity: 'block',
    kind: 'content',
    pattern: /probes\/[a-z0-9-]+\.mjs|scripts\/(?:set-version|measure-mcp-live)\.mjs|release\.test\.mjs|phase-\d+-[a-z-]+\.md|manual-verification\.md/g,
    why: 'Cites a file that exists only in the private repository. Each one is a labelled gap: it tells a reader something was held back and gives it a name to ask about.',
    fix: 'Remove the citation, or publish the file. A reference a reader cannot follow is worse than no reference.',
    found: 'Three test files cited a probe harness, a filtering script and a release suite, none of which exist here.',
  },
  {
    id: 'competitor-claim',
    severity: 'warn',
    kind: 'content',
    pattern: /\bcognee\b|\bmem0\b|\bzep\b|\bletta\b|has no redaction layer at all/gi,
    why: 'An unqualified security claim about a named competitor, published under our name and dated the moment it was written. It ages badly and it is the kind of sentence that gets quoted back.',
    fix: 'Argue for what this plugin does. Say nothing about anyone else\'s.',
    found: 'A test header made an unqualified security claim about a named competitor.',
  },
  {
    id: 'shipped-defect-confession',
    severity: 'warn',
    kind: 'content',
    pattern: /shipped past \d+ green tests|through \d{3,} green tests|for a year every shipped|its whole shipped life|has been (?:broken|dead) since|permanently dead/gi,
    why: 'A note that something was broken in released builds for a long time, usually with a test count attached. It is honest engineering writing and it is also a durable, quotable statement about our release quality.',
    fix: 'Keep the archaeology in the commit message and the private post-mortem; keep the regression test.',
    found: 'Five of them across the suite, each pairing a long-lived defect with the green test count that missed it.',
  },
  /* ---------------------------------------------------------------- */
  /* 5. People, machines and private links                             */
  /* ---------------------------------------------------------------- */
  {
    id: 'dev-machine-path',
    severity: 'block',
    kind: 'content',
    pattern: /(?:\/Users\/|\/home\/)(?!you\b|user\b|runner\b|me\b|someone\b)[a-z][a-z0-9._-]+|~\/Mubit\b/gi,
    why: 'A real home directory names a real person and the private worktrees on their laptop. It is also the single most reliable sign that a transcript was pasted rather than written.',
    fix: 'Use `$PLUG`, `~/`, or `/Users/you`. A one-character home (`/Users/x`, `/home/u`) reads as synthetic and does not fire — real usernames are longer than that.',
    found: 'About thirty real home-directory paths across the runbooks, naming a person and their private worktrees.',
  },
  {
    id: 'private-link',
    severity: 'block',
    kind: 'content',
    pattern: /claude\.ai\/(?:code\/artifact|chat|share)|notion\.so|linear\.app|\.atlassian\.net|docs\.google\.com|drive\.google\.com|slack\.com\/archives|app\.slack\.com/gi,
    why: 'Points at an internal document. The link may be private today; a link in a public repository is an invitation to find out.',
    fix: 'Summarise the memo in the commit or the PR body. If the argument matters enough to cite, it matters enough to restate.',
    found: 'A handoff memo opened by linking the private document it summarised.',
  },
  {
    id: 'personal-data',
    severity: 'block',
    kind: 'content',
    pattern: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,4}\.[A-Za-z]{2,24}/g,
    why: 'An address that is not a documented placeholder is either a real person or a real account. Both belong out of a public tree.',
    fix: 'Use `you@example.com`. Author attribution belongs in `plugin.json` and `LICENSE`, which are allowlisted.',
    found: 'A test used a real address as a fixture value.',
    exclude: ['**/LICENSE', '**/plugin.json', '**/marketplace.json'],
  },
  {
    id: 'recalled-memory-content',
    severity: 'warn',
    kind: 'content',
    pattern: /\[(?:fact|rule|lesson|preference) conf \d\.\d{1,2}\]|The user \([A-Z]/g,
    why: 'A pasted recall block carries the contents of somebody\'s memory. Today that is a founder\'s home country; the next runbook written against a customer instance would carry theirs.',
    fix: 'Redact the text of every resolved memory in a pasted transcript, or run the section against the loopback stub, which is what most of the runbooks already do.',
    found: 'A runbook printed a resolved memory in full, personal fact included.',
  },

  /* ---------------------------------------------------------------- */
  /* 6. Credentials                                                    */
  /* ---------------------------------------------------------------- */
  {
    id: 'credential-material',
    severity: 'block',
    kind: 'content',
    pattern: /\b(?:mbt_(?:live|test|sk)_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,})\b/g,
    why: 'A live key in a public repository is compromised the moment it is pushed, and rotating it is the cheap half of the cleanup.',
    fix: 'Keep secrets in Actions secrets and in `credentials.json`. Fixtures should read as fake — the scanner allows any key carrying a placeholder marker.',
    found: 'Nothing live. Every key in the tree is a legible placeholder, and the rule exists to keep it that way.',
    heavy: true,
  },
  {
    id: 'assigned-secret',
    severity: 'warn',
    kind: 'content',
    pattern: /\b(?:api[_-]?key|auth[_-]?key|secret|password|passwd|token|bearer)\s*[=:]\s*["'`]?([A-Za-z0-9_\-+/]{16,})["'`]?/gi,
    why: 'A long opaque value assigned to a secret-shaped name. Usually a fixture; occasionally not.',
    fix: 'Make fixtures obviously fake.',
    found: 'The runbooks’ `export MUBIT_API_KEY=…` lines, all placeholders.',
  },

  /* ---------------------------------------------------------------- */
  /* 7. Internal process leaking through                               */
  /* ---------------------------------------------------------------- */
  {
    id: 'internal-runbook',
    severity: 'block',
    kind: 'path',
    pattern: /(?:^|\/)docs\/(?:handoff-|manual-test-|manual-verification)/,
    why: 'Internal runbooks and handoff memos are written for the team, against the team\'s machines, and they carry unshipped plans, private paths and pasted production output. Every other finding in this catalogue was found inside one.',
    fix: 'Keep them in the source repository and leave them out of the published file set. `docs/user-guide.md` is the one users need and it stays.',
    found: 'Twelve such files, 7 700 lines, added to the public tree in one release cycle.',
  },
  {
    id: 'unshipped-plan',
    severity: 'warn',
    kind: 'content',
    pattern: /Nothing here is implemented|the next step of [A-Z]{2}-\d|worth clearing a day for|before anything speculative|is the one worth clearing/gi,
    why: 'Roadmap. A competitor reads what is coming; a user reads a promise nobody made.',
    fix: 'Plans belong in the tracker.',
    found: 'A handoff memo whose own first page said none of it was built yet.',
  },
  {
    id: 'experimental-branch-name',
    severity: 'warn',
    kind: 'content',
    pattern: /\b(?:exp|lab|spike|wip)\/[a-z0-9][a-z0-9-]{2,}/g,
    why: 'Names an experiment branch that was never published. Mild on its own, and a reliable marker that the sentence around it was written for an internal reader.',
    fix: 'Cite the merged commit instead.',
    found: 'A memo cited a measurement script on an experiment branch, neither of which exists here.',
  },
  {
    id: 'production-identifier',
    severity: 'warn',
    kind: 'content',
    pattern: /\bcc-[a-z0-9][a-z0-9-]{4,}-[0-9a-f]{8}\b/g,
    why: 'A real run id on the hosted instance. Opaque and key-gated, so the exposure is small — but it is production data in a public tree, and it dates the tenant it came from.',
    fix: 'Replace with `<run id>` in pasted output; the runbooks already do this in most places.',
    found: 'Runbooks pasted real run ids out of live output.',
    include: ['**/*.md'],
  },

  /* ---------------------------------------------------------------- */
  /* 8. Structural — shape of the published tree                       */
  /* ---------------------------------------------------------------- */
  {
    id: 'session-recording-tracked',
    severity: 'block',
    kind: 'path',
    pattern: /(?:^|\/)\.codaph\/|\.ndjson$|(?:^|\/)transcripts?\//,
    why: 'Codaph session recordings hold verbatim tool calls, file contents and command output from private repositories. Tens of megabytes of it sit in this worktree; one `git add -f` publishes it.',
    fix: 'It is already ignored at the root. This rule is the second lock, because the `.gitignore` is itself overwritten on every publish and there is a window where it is not there.',
    found: 'Nothing tracked today, and forty-odd session recordings sitting untracked in the working tree.',
  },
  {
    id: 'inline-sourcemap-sources',
    severity: 'block',
    kind: 'structural',
    why: 'An inline sourcemap with `sourcesContent` embeds the original source of everything it was built from. When the build ran against a private sibling package, that is the private package\'s source — comments intact — pasted into a public bundle in base64, where no reviewer will ever see it.',
    fix: "Build the shipped bundle with `sourcemap: false`, or `'external'` and do not commit the map. Only sources that are themselves tracked in this repository are ignored by this rule.",
    found: 'A committed bundle carried a 4.2 MB inline map holding 67 KB of a private package\'s TypeScript, published nowhere else.',
  },
  {
    id: 'oversized-artifact',
    severity: 'warn',
    kind: 'structural',
    why: 'A multi-megabyte committed bundle is unreviewable: nobody reads a 5.9 MB diff, so anything inside it ships unread. It is also the one file in the tree whose contents no rule here has actually checked line by line.',
    fix: 'Minify the vendored server, or fetch it at build time from the published package rather than committing it.',
    found: 'A 5.9 MB committed bundle, unminified, that no line-oriented rule here had ever actually read.',
  },
  {
    id: 'private-package-dependency',
    severity: 'warn',
    kind: 'content',
    pattern: /"file:\.\.?\/[a-z0-9_-]+"/gi,
    why: 'A `file:` dependency names a private sibling package that does not exist in this repository. It tells a reader the layout of the source monorepo, and it makes `npm ci` fail here.',
    fix: 'Depend on the published package, or move the dependency behind the build.',
    found: 'A `file:` devDependency on a sibling package that does not exist in this repository.',
  },
];

export default { CONFIG, RULES };
