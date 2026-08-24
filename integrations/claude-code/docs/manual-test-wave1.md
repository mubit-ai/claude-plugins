# Manual test — Wave 1: actor attribution and freshness-aware recall

Two halves, and they are deliberately different in kind.

**Part A** proves the two features that landed in #18 and #19 by holding the **wire** still. It
runs offline against a stub on loopback, because both features are ultimately claims about what
is in a request body, and a stub is the only way to read one. Nothing dials `api.mubit.ai`;
nothing touches your memory.

**Part B** is the half a stub cannot do: a real session against hosted Mubit, where the server
tells you what weights it actually used, and where the one regression that matters — *does a
newly captured, attributed entry still come back from recall?* — can be answered at all.

**Time:** ~10 minutes for Part A, ~15 for Part B.

**Destroys:** Part A destroys nothing — every byte lives in two `/tmp` directories you delete in
§13. Part B writes into your **real** Mubit memory and your **real** data dir; §13 says exactly
what it leaves and how to remove it.

**Provenance of the Expect blocks.** Every block in **Part A** is a transcript from a real run of
this build on 2026-08-24. Epochs and the `at` field will differ; nothing else should. Blocks in
**Part B** are marked `Look for` where they depend on your account's memory, and `Expect` only
where the value is the server's and therefore fixed.

**What is under test**

| | |
| --- | --- |
| **#18** | An actor id detected without asking, stamped into `metadata_json` — and deliberately **not** into `user_id` |
| **#19** | `rank_by` on the recall query, chosen per prompt, so *"where were we?"* is answered by recency rather than similarity |

---

## §0 — Before you start: two traps, then the temp directories

**Trap 1 — your shell may already point at a different Mubit.** Config precedence is
`CLAUDE_PLUGIN_OPTION_*` → `MUBIT_*` env → `credentials.json` → `.mubit-cc.json` → default. A
`MUBIT_ENDPOINT` left exported from an earlier session **beats the hosted key you signed in
with**, and you will test the wrong instance without a single warning.

```bash
env | grep -iE '^(MUBIT|CLAUDE_PLUGIN)' | sed 's/\(MUBIT_API_KEY=.\{0,10\}\).*/\1…/' | sort
```

**Expect nothing at all.** If something prints, start from a clean shell:

```bash
env -u MUBIT_ENDPOINT -u MUBIT_API_KEY -u MUBIT_CC_DATA_DIR -u CLAUDE_PLUGIN_ROOT zsh
```

**Trap 2 — the data directory is not where the docs say.** A `--plugin-dir` session is documented
as writing to `~/.claude/plugins/data/mubit-memory-inline`; measured, it writes to
`~/.claude/plugins/data/mubit-memory`. Do not guess — `MUBIT_CC_DATA_DIR` has the highest
precedence of any data-dir input (`lib/state.mjs`), so pin it and everything lands in one
directory you own and can delete.

> **A trap specific to this file.** Part A's §3 and §4 set `GIT_CONFIG_GLOBAL=/dev/null` and
> friends so that *your* `~/.gitconfig` cannot decide a result. If you skip those exports the
> ladder will still work — it will just answer with your own name, and you will have proved
> nothing about which rung answered.

### Create the temp directories

```bash
export PLUG=/Users/eldaru/Mubit/codaph-port/integrations/claude-code
export SCRATCH=/tmp/mubit-w1
export DATA=/tmp/mubit-w1-data

rm -rf "$SCRATCH" "$DATA"          # idempotent: safe to re-run this whole file
mkdir -p "$SCRATCH" "$DATA"

cd "$SCRATCH" && git init -q . && echo "# scratch" > README.md
git -c user.email=you@example.com -c user.name=you add -A
git -c user.email=you@example.com -c user.name=you commit -qm init

# pin everything — never rely on the ambient environment
export MUBIT_CC_DATA_DIR="$DATA"
export MUBIT_ENDPOINT=http://127.0.0.1:3993
export MUBIT_API_KEY=mbt_stub_key
export MUBIT_CC_RUN_STRATEGY=static
export MUBIT_CC_RUN_ID=w1-run
export CLAUDE_PROJECT_DIR="$SCRATCH"
export S=c1111111-2222-3333-4444-555555555555

# a PostToolUse payload, with the host's own field names. $1 varies the tool_use_id so
# several captures can be told apart on the wire.
PTU() { echo "{\"session_id\":\"$S\",\"cwd\":\"$SCRATCH\",\"hook_event_name\":\"PostToolUse\",\"prompt_id\":\"p1\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"README.md\",\"old_string\":\"a\",\"new_string\":\"b\"},\"tool_response\":{\"type\":\"text\",\"text\":\"Applied 1 edit\"},\"tool_use_id\":\"tu_$1\",\"duration_ms\":42}"; }

# a UserPromptSubmit payload carrying $1 as the prompt
UPS() { echo "{\"session_id\":\"$S\",\"cwd\":\"$SCRATCH\",\"hook_event_name\":\"UserPromptSubmit\",\"prompt_id\":\"p9\",\"prompt\":\"$1\"}"; }

# what a spooled item says about attribution — the two fields this whole feature is about
ITEM() { python3 -c "
import json,glob,sys
fs=sorted(glob.glob('$DATA/runs/*/spool/*.json'))
if not fs: print('(no spooled item)'); sys.exit()
d=json.load(open(fs[-1])); it=d.get('item',d)
m=json.loads(it.get('metadata_json') or '{}')
print('user_id on item :', it.get('user_id','(absent)'))
print('metadata actor  :', m.get('actor','(absent)'))
"; }

echo "plugin   $PLUG"; echo "scratch  $SCRATCH"; echo "data     $DATA"
```

**Expect**

```
plugin   /Users/eldaru/Mubit/codaph-port/integrations/claude-code
scratch  /tmp/mubit-w1
data     /tmp/mubit-w1-data
```

> Every command in Part A assumes these exports. If you open a new terminal, paste the block
> again — shell state does not travel between windows.

---

## §1 — The stub Mubit

It answers the three routes the plugin dials and **appends every request body to
`calls.jsonl`**. That log is the point: both features under test are assertions about a request
body, and this is the only place you can read one without a server that talks back.

```bash
cat > "$SCRATCH/stub.mjs" <<'EOF'
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const LOG = new URL('./calls.jsonl', import.meta.url);
const EVIDENCE = [{ entry_id: 'ent_1', entry_type: 'lesson', content: 'Poll the job id until it reports indexed.', score: 0.9 }];
createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = null; try { body = JSON.parse(raw); } catch { /* not json */ }
    appendFileSync(LOG, JSON.stringify({ path: req.url, body }) + '\n');
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/v2/control/query')) return res.end(JSON.stringify({ evidence: EVIDENCE }));
    if (req.url.startsWith('/v2/control/ingest')) return res.end(JSON.stringify({ status: 'queued', job_id: 'job_1' }));
    if (req.url.startsWith('/v2/control/context')) return res.end(JSON.stringify({ context_block: 'stub block' }));
    res.end('{"ok":true}');
  });
}).listen(3993, '127.0.0.1', () => console.log('stub on 3993'));
EOF

cd "$SCRATCH" && node stub.mjs > stub.log 2>&1 &
sleep 1 && curl -s -m2 http://127.0.0.1:3993/health && echo " <- stub answers"
```

**Expect**

```
{"ok":true} <- stub answers
```

---

## §2 — #18: the actor lands in metadata, and never in `user_id`

**This is the regression the whole design of `lib/actor.mjs` exists to prevent**, and it is the
first thing to check because everything else is a refinement of it.

Server-side, `user_id` is a **retrieval scope, not an attribution tag**. On ingest it is stamped
into the entry's metadata; on query it is enforced as a *filter*, and a query that sends no
`user_id` does not opt out — the server substitutes `actor::<accountId>`. `lib/recall.mjs` never
sends one. So an actor written into `user_id` would scope every newly captured entry out of the
recall meant to find it: no error, no warning, `sources` simply reads 0 forever.

```bash
rm -rf "$DATA"
PTU 1 | MUBIT_CC_ACTOR_ID=e1daru node "$PLUG/hooks/src/capture.mjs" >/dev/null 2>&1
ITEM
```

**Expect**

```
user_id on item : (absent)
metadata actor  : e1daru
```

`user_id` **absent** is the assertion. If it ever reads `e1daru`, stop — attribution has been
wired into the scope field and every memory captured from that build is invisible to recall.

The two fields are independent, and you can prove it in one command — `MUBIT_CC_USER_ID` still
does exactly what it always did, and setting it does not move the actor:

```bash
rm -rf "$DATA"
PTU 1 | MUBIT_CC_ACTOR_ID=e1daru MUBIT_CC_USER_ID=some-scope node "$PLUG/hooks/src/capture.mjs" >/dev/null 2>&1
ITEM
```

**Expect**

```
user_id on item : some-scope
metadata actor  : e1daru
```

---

## §3 — The detection ladder, rung by rung

Five rungs, cheapest first. Each one must **outrank** everything below it, so the test is not
"does rung 4 work" but "does rung 3 beat rung 4 when both are available".

`GIT_CONFIG_*` jails git so your own `~/.gitconfig` cannot answer for it.

```bash
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1

RUNG() { rm -f "$DATA/actor.json"; node -e "
import('$PLUG/lib/actor.mjs').then(({resolveActor}) => {
  const a = resolveActor({ dataDir: process.env.MUBIT_CC_DATA_DIR, actorId: process.env.MUBIT_CC_ACTOR_ID || '' }, '$SCRATCH');
  const c = JSON.parse(require('node:fs').readFileSync('$DATA/actor.json','utf8'));
  console.log((process.argv[1]||'').padEnd(22), '->', String(a).padEnd(12), 'source:', c.source);
});
" "$1"; }

cd "$SCRATCH"
git config --unset github.user 2>/dev/null; git config --unset user.email 2>/dev/null; git config --unset user.name 2>/dev/null
git config user.name  "Ada Lovelace";     RUNG "4 user.name"
git config user.email "ada@example.com";  RUNG "3 user.email"
git config github.user "adalovelace";     RUNG "2 github.user"
MUBIT_CC_ACTOR_ID=pinned                  RUNG "1 MUBIT_CC_ACTOR_ID"
```

**Expect**

```
4 user.name            -> Ada-Lovelace source: git-name
3 user.email           -> ada          source: git-email
2 github.user          -> adalovelace  source: git-github-user
1 MUBIT_CC_ACTOR_ID    -> pinned       source: config
```

Three things this pins beyond the ordering:

- **`Ada Lovelace` became `Ada-Lovelace`.** Every rung goes through the `TYPE:NAME` sanitiser,
  not just the display-name one — whitespace and colons are forbidden inside a NAME, and a value
  out of a config file is not guaranteed clean.
- **`ada@example.com` became `ada`.** The domain says where somebody works, not who they are, and
  it is identical on every colleague's machine.
- **`source` is recorded** so *"why does it think I am `root`?"* is answerable from the file alone.

Rung 5 needs a directory that is not a repo, since rungs 2–4 only ever shell out inside one:

```bash
mkdir -p /tmp/mubit-w1-nogit && rm -f "$DATA/actor.json"
node -e "
import('$PLUG/lib/actor.mjs').then(({resolveActor}) => {
  console.log('non-repo dir (rung 5) ->', resolveActor({ dataDir: '$DATA' }, '/tmp/mubit-w1-nogit'), '  \$USER =', process.env.USER);
});
"
```

**Look for** your own login on both sides of the line — the value is whatever `$USER` is on your
machine, so this one cannot be pinned to a transcript.

And the case where there is genuinely nothing to find:

```bash
rm -f "$DATA/actor.json"
env -u USER -u USERNAME -u LOGNAME node -e "
import('$PLUG/lib/actor.mjs').then(({resolveActor, readActor}) => {
  const cfg = { dataDir: '$DATA' };
  console.log('nothing to find     ->', JSON.stringify(resolveActor(cfg, '/tmp/mubit-w1-nogit')));
  console.log('cache written?      ->', require('node:fs').existsSync('$DATA/actor.json'));
  console.log('readActor on miss   ->', JSON.stringify(readActor(cfg)));
});
"
```

**Expect**

```
nothing to find     -> ""
cache written?      -> false
readActor on miss   -> ""
```

`cache written? false` is deliberate and worth understanding: a **failed** detection is never
cached. A 30-day negative would outlive the `git config` that fixes it, and a miss on a machine
with nothing to find costs no spawns anyway — the `hasGitDir` guard short-circuits first.

---

## §4 — Cold start: who writes the cache, and what the first item costs

`capture` only ever **reads** `${dataDir}/actor.json`. `drain` is the only thing that writes it,
because `drain` is detached and unbudgeted and the ladder shells out. The consequence is real and
is not worked around: **on a completely fresh data dir, the first captured item ships
unattributed.**

```bash
rm -rf "$DATA"; : > "$SCRATCH/calls.jsonl"

echo "1. first capture, cold data dir"
PTU 1 | node "$PLUG/hooks/src/capture.mjs" >/dev/null 2>&1
echo "   actor.json exists : $(test -f "$DATA/actor.json" && echo yes || echo no)"

echo "2. drain runs (the only cache writer)"
echo '{}' | node "$PLUG/hooks/src/drain.mjs" >/dev/null 2>&1
echo "   actor.json        : $(cat "$DATA/actor.json" 2>/dev/null || echo '(none)')"

echo "3. next capture reads it"
PTU 2 | node "$PLUG/hooks/src/capture.mjs" >/dev/null 2>&1
ITEM
```

**Expect** (the `at` epoch will differ)

```
1. first capture, cold data dir
   actor.json exists : no
2. drain runs (the only cache writer)
   actor.json        : {"v":1,"at":1787536737291,"actor":"adalovelace","source":"git-github-user"}
3. next capture reads it
user_id on item : (absent)
metadata actor  : adalovelace
```

Now read what actually left the machine. The drain in step 2 shipped the *first* item, captured
before the cache existed:

```bash
python3 -c "
import json
rows=[json.loads(l) for l in open('$SCRATCH/calls.jsonl') if l.strip()]
for r in [x for x in rows if 'ingest' in (x['path'] or '')]:
    b=r['body']
    print('envelope user_id:', b.get('user_id','(absent)'))
    for it in b.get('items',[]):
        m=json.loads(it.get('metadata_json') or '{}')
        print('  item', m.get('tool_use_id'), '| item user_id:', it.get('user_id','(absent)'), '| actor:', repr(m.get('actor','(absent)')))
"
```

**Expect**

```
envelope user_id: (absent)
  item tu_1 | item user_id: (absent) | actor: '(absent)'
```

That unattributed `tu_1` is the documented cost, not a bug: in a real session `stage-prompt`
spawns the drainer on `UserPromptSubmit`, which normally lands well before the first
`PostToolUse`. The alternative — letting `capture` detect — would put two `git` spawns on the
per-tool-call path to rescue one item.

Note also **`envelope user_id: (absent)`**. The `user_id` in `drain.mjs` and `session-end.mjs` is
the *batch envelope*, not per-item, and #18 correctly left both alone.

---

## §5 — The hot path never shells out

The load-bearing performance claim: `readActor` is a cache read, on every single PostToolUse. The
sharpest way to prove it is to take `git` away entirely and watch attribution still happen.

```bash
mkdir -p /tmp/mubit-w1-emptybin
PTU nogit | PATH=/tmp/mubit-w1-emptybin "$(command -v node)" "$PLUG/hooks/src/capture.mjs" >/dev/null 2>&1
ITEM
```

**Expect**

```
user_id on item : (absent)
metadata actor  : adalovelace
```

No `git` on `PATH` at all, and the item is still attributed. If this ever needs git, the ladder
has leaked onto the per-tool-call path.

---

## §6 — #19: `rank_by` on the wire

The bug: *"where were we?"* is answered by whatever is most **similar** to those three words,
because the server's default weighting barely counts recency. `rank_by: "freshness"` makes
recency dominant for that one query.

```bash
RANK() { : > "$SCRATCH/calls.jsonl"; UPS "$1" | node "$PLUG/hooks/src/prompt-recall.mjs" >/dev/null 2>&1
python3 -c "
import json
rows=[json.loads(l) for l in open('$SCRATCH/calls.jsonl') if l.strip()]
q=[r for r in rows if 'query' in (r['path'] or '')]
print(repr('''$1'''), '->', (q[-1]['body'].get('rank_by','(absent)') if q else '(no query)'))
"; }

RANK "where were we on the ingest bug?"
RANK "why is the ingest job stuck in queued?"
RANK "what's the latest version of esbuild"
RANK "catch me up"
```

**Expect**

```
'where were we on the ingest bug?' -> freshness
'why is the ingest job stuck in queued?' -> relevance
"what's the latest version of esbuild" -> relevance
'catch me up' -> freshness
```

Rows 2 and 3 are the ones that matter. **Over-firing is this feature's silent failure mode**: a
rule that decays into a substring match re-ranks ordinary questions by recency and produces no
error and no log line — recall just quietly gets worse. Row 3 in particular is the canonical
near-miss: it contains the trigger word `latest` and must still resolve to `relevance`.

---

## §7 — The rule's edges

`lib/rank.mjs` is table-driven, and three of its twelve rows carry a **row-scoped** veto. Worth
walking directly, because the vetoes are the half that is easy to break:

```bash
node -e "
import('$PLUG/lib/rank.mjs').then(({rankForPrompt: r}) => {
  for (const p of [
    'where were we',
    'catch me up on the latest version of esbuild',
    \"what's the latest version of esbuild\",
    'bump esbuild to the latest release',
    'the redaction pass is sound so far as I can tell',
    'what does the current state of the art look like for hybrid retrieval',
    'write a test for lib/assemble.mjs',
  ]) console.log(String(r(p)).padEnd(10), JSON.stringify(p));
});
"
```

**Expect**

```
freshness  "where were we"
freshness  "catch me up on the latest version of esbuild"
relevance  "what's the latest version of esbuild"
relevance  "bump esbuild to the latest release"
relevance  "the redaction pass is sound so far as I can tell"
relevance  "what does the current state of the art look like for hybrid retrieval"
relevance  "write a test for lib/assemble.mjs"
```

Row 2 is the reason the vetoes are row-scoped rather than global: *"catch me up on the latest
version of esbuild"* is still a handoff question, and the `catch me up` row does not care what
the `latest` row thinks.

> **Known, bounded over-fires.** `the debug flag was left off in production`, `print the current
> state of the reducer` and `use the latest esbuild` all resolve to `freshness`. This is accepted
> rather than fixed: an over-fire only reorders the same 8 candidates by recency — no error, no
> extra latency, no extra call — and for the middle one it is arguably the better answer. If you
> tighten these, tighten `test/rank.test.mjs` in the same commit.

---

## §8 — The setting overrides the rule, in both directions

`auto` **means** "run the rule"; it is not a stand-in for a missing setting. A mode an operator
named has to win, or the setting is a suggestion — and `balanced` becomes unreachable, since the
rule never produces it.

```bash
SHOW() { python3 -c "
import json
rows=[json.loads(l) for l in open('$SCRATCH/calls.jsonl') if l.strip()]
r=[x for x in rows if 'query' in (x['path'] or '') or 'context' in (x['path'] or '')]
print('$1'.ljust(26), '->', (r[-1]['path'] + ' | rank_by: ' + str(r[-1]['body'].get('rank_by','(absent)'))) if r else '(no call)')
"; }

for M in balanced relevance sideways; do
  : > "$SCRATCH/calls.jsonl"
  UPS "where were we?" | MUBIT_CC_RECALL_RANK_BY=$M node "$PLUG/hooks/src/prompt-recall.mjs" >/dev/null 2>&1
  SHOW "RANK_BY=$M"
done
```

**Expect**

```
RANK_BY=balanced           -> /v2/control/query | rank_by: balanced
RANK_BY=relevance          -> /v2/control/query | rank_by: relevance
RANK_BY=sideways           -> /v2/control/query | rank_by: freshness
```

The third row is the interesting one and is **not** a bug. An unusable value is a two-stage
answer: `lib/config.mjs` clamps the key with `enumOf` first, so `sideways` never reaches the
ladder as itself — it arrives as `auto`, and `auto` runs the rule, which sees a handoff prompt.
What must never appear on that line is the literal string `auto` or `sideways`: the server
ignores both while they sit in a request log looking like a decision.

---

## §9 — The rung-3 trap: `recallAssemble: server` silently loses ranking

`ContextRequest` has **no ranking field of any kind** — its 12 fields do not include one. So
turning rung 3 on does not fail, warn, or fall back. It quietly reverts every recall to the
server's default weights, and *"where were we?"* goes back to answering by similarity.

This is the same shape of trap as the scope line's *"turning rung 3 on narrows reach"*, and it is
the one cost of `recallAssemble: "server"` that nothing at runtime reports.

```bash
: > "$SCRATCH/calls.jsonl"
UPS "where were we?" | MUBIT_CC_RECALL_ASSEMBLE=server node "$PLUG/hooks/src/prompt-recall.mjs" >/dev/null 2>&1
SHOW "ASSEMBLE=server (rung 3)"
```

**Expect**

```
ASSEMBLE=server (rung 3)   -> /v2/control/context | rank_by: (absent)
```

Absent is the honest answer, not an omission: inventing a field the server does not read would
make rung 3 *look* ranked when it is not. The day `rank_by` is added to `ContextRequest`,
`test/prompt-recall.test.mjs`'s rung-3 test fails and points at the README row that says it is
missing.

Stop the stub before Part B:

```bash
pkill -f 'stub.mjs' ; unset MUBIT_ENDPOINT MUBIT_API_KEY MUBIT_CC_DATA_DIR MUBIT_CC_RUN_ID MUBIT_CC_RUN_STRATEGY
unset GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_NOSYSTEM
```

---

# Part B — against hosted Mubit

Two things a stub cannot prove: what weights the server *actually* used, and whether an attributed
entry is still reachable by recall. Both need a real backend.

## §10 — Load the build under test without your installed copy fighting it

`--plugin-dir` **adds** a plugin. `mubit-memory@mubit` is enabled in `~/.claude/settings.json` and
keeps running too, so both sets of hooks fire against the same data dir and race `claimOnce` — you
get half your results from the wrong build. Disable it inline; `--settings` takes a **JSON
string**, so this touches nothing of yours:

```bash
cd /tmp/mubit-w1
export LIVE="$HOME/.claude/plugins/data/mubit-memory"

claude --plugin-dir "$PLUG" \
  --settings '{"enabledPlugins":{"mubit-memory@mubit":false}}'
```

Credentials come from `<dataDir>/credentials.json`, so do **not** point `MUBIT_CC_DATA_DIR` at a
fresh directory for Part B — that is an unconfigured install and it will dial nothing.

Sanity-check you are on the build you think you are:

```bash
grep -c 'rank_by' "$PLUG/hooks/dist/impl/prompt-recall.mjs"
grep -c 'actor' "$PLUG/hooks/dist/impl/capture.mjs"
```

**Look for** non-zero from both. A zero means you are running a bundle built before Wave 1 and
everything below will measure it.

> If you are testing against the **local** server rather than hosted, raise the recall budget
> first: `export MUBIT_CC_RECALL_BUDGET_MS=8000`. The local server is slower than the default
> budget and you will otherwise measure the timeout.

## §11 — The regression that needs a real backend

Do two or three ordinary things in the session — read a file, edit one, run a command — so there
is something to attribute. Then confirm the actor rode along:

```bash
jq '.items[0] | {user_id, metadata_json}' "$LIVE"/runs/*/spool/*.json 2>/dev/null | head -20
```

**Look for** `user_id` **absent** and `metadata_json` containing `"actor"`. If the spool has
already drained it will be empty — that is fine, capture two more tool calls and look again
before the next drain.

Now the half that only hosted Mubit can answer. **Exit the session, start a fresh one, and ask
something your memory should know.** Then:

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --last 5
```

**Look for** a non-zero `sources`. This is the entire reason attribution went into
`metadata_json`: had the actor gone into `user_id`, this is where it would read **0** — and
nowhere earlier. Every check in Part A would still have passed.

## §11a — If recall reads 0 sources, check the budget before you blame the feature

**Measured on hosted Mubit, 2026-08-24: `/v2/control/query` took 2.0–2.6 s.** The per-prompt
recall budget is **1500 ms**. So on an ordinary session recall gives up before the server
answers, every prompt, and `mubit-inspect` reports it as a row of zeros:

```
prompt     when      rung  src  tok  chars  drop  ptr  empty_reason  used(m/c)
30855551…  10:31:30     —    0    0      0     0    0  —             —
totals      3 prompts · 0 tok injected · 0 sources · 0/3 prompts got an injection
last recall 0 sources · 0 tok · 1507 ms · rung 1 · dry_streak 3
```

**`ms: 1507` is the tell.** A number sitting on the budget is a timeout; a genuine empty result
comes back fast and carries an `empty_reason`. The marker's `state` reads `not_responding`,
which is the same fact wearing a different label — and `status/health.json` will happily say
`ok: true, state: ready`, because `/v2/core/health` is fast and the query path is not.

**Raising `MUBIT_CC_RECALL_BUDGET_MS` does not fix this**, and it is worth knowing why before
you spend an afternoon on it:

```js
const HARNESS_BUDGET_MS = Math.min(RECALL_BUDGET_MS + 400, 2800);   // hooks/src/prompt-recall.mjs
```

The harness stop is capped at **2800 ms** because the `UserPromptSubmit` hook timeout is 3 s.
Anything above roughly 2400 buys nothing at all.

**The fix is the async path**, which exists for exactly this:

```bash
export MUBIT_CC_RECALL_ASYNC=1
```

Recall then runs in a detached refresh with a **10 000 ms** budget
(`REFRESH_BUDGET_MS`, `hooks/src/recall-refresh.mjs`) — four times what any blocking hook can
ever be given. It costs one turn of staleness: the block you see was fetched just after your
*previous* prompt, and the first prompt of a session gets nothing.

To confirm the store is fine and it really is the budget, query outside the hook, where no
deadline applies:

```bash
D="$HOME/.claude/plugins/data/mubit-memory-mubit"
EP=$(python3 -c "import json;print(json.load(open('$D/credentials.json'))['endpoint'])")
KEY=$(python3 -c "import json;print(json.load(open('$D/credentials.json'))['apiKey'])")
curl -s -o /tmp/q.json -w "http %{http_code}  total %{time_total}s\n" -m 30 "$EP/v2/control/query" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"run_id":"<your run id>","query":"where were we","mode":"direct_bypass",
       "direct_lane":"semantic_search","evidence_only":true,"limit":5}'
python3 -c "import json;print('evidence:', len(json.load(open('/tmp/q.json')).get('evidence') or []))"
```

**Look for** a `total` above 1.5 s together with a non-zero evidence count. That combination is
the whole diagnosis: the memory is there, and the hook is not waiting long enough for it.

> This is not a Wave 1 regression, and the quickest way to prove that is `dry_streak` on a run
> that predates both features — it will show the same `ms: ~1505` and the same zeros.

---

## §12 — The weights the server actually used

`explain: true` makes the server report its own fusion weights per evidence item, which turns
#19 from a claim about a request body into a measurement.

```bash
curl -s "$MUBIT_ENDPOINT/v2/control/query" -H "Authorization: Bearer $MUBIT_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"run_id":"<a real run>","query":"where were we","mode":"direct_bypass",
       "direct_lane":"semantic_search","evidence_only":true,"limit":3,
       "rank_by":"freshness","explain":true}' \
  | jq '.evidence[0].explain_info | {rank_by_mode, fusion_weights_used}'
```

**Look for** `rank_by_mode: "freshness"` — the mode you sent, echoed back — and a
`fusion_weights_used` map in which **`recency` is the largest of the three**.

The weights themselves are your instance's and are operator-tunable, so they are deliberately
not pinned here: `explain: true` *is* the authoritative source, which is the whole reason this
check exists rather than a table in a document.

Re-run with `"rank_by":"relevance"` and look for the emphasis inverted — `semantic` largest,
`recency` smallest. With the field removed entirely, expect the same numbers as `relevance`:
absent *is* `relevance` server-side, which is why the client omits rather than invents.

> **One nuance worth carrying.** `recency_score` is min-max normalised across the candidate set,
> so `freshness` **reorders within** the candidates the query already found. It does not go and
> fetch newer ones. A run whose memories were all written in the same hour will re-rank barely at
> all, and that is correct behaviour rather than a broken dial.

---

## §13 — Teardown

### Part A — self-contained

```bash
pkill -f 'stub.mjs'
rm -rf /tmp/mubit-w1 /tmp/mubit-w1-data /tmp/mubit-w1-nogit /tmp/mubit-w1-emptybin
ls -d /tmp/mubit-w1 /tmp/mubit-w1-data 2>&1
```

**Expect**

```
ls: /tmp/mubit-w1: No such file or directory
ls: /tmp/mubit-w1-data: No such file or directory
```

Confirm nothing is still listening and no stray child survived:

```bash
lsof -nP -iTCP:3993 -sTCP:LISTEN 2>/dev/null | tail -n +1
pgrep -fl 'stub.mjs|drain.mjs'
```

**Expect** no output from either.

Also unset the git jail, or every repo you touch in this shell will look unconfigured:

```bash
unset GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_NOSYSTEM
```

### Part B — what it actually leaves

Part B is not self-contained, and pretending otherwise is how people lose data they wanted.

**In your real data dir** (`~/.claude/plugins/data/mubit-memory`): a run directory, a status
marker per session, and — new in Wave 1 — **`actor.json` at the top level**. The first two are
pruned by §7's TTL sweep. `actor.json` is **not**: it owns its own 30-day TTL and `pruneStale`
deliberately never touches it. To remove it:

```bash
rm -f "$LIVE/actor.json"
rm -rf "$LIVE/runs/<your-run-id>" "$LIVE/status/<your-run-id>.json"
```

**In your real Mubit memory:** every entry captured during §11, each now carrying an `actor` key
in its metadata. These are **server-side and survive the directory deletion.** Nothing in Wave 1
adds a way to strip attribution from an entry after the fact — if that matters to you, delete the
entries:

```
mubit_lessons   → find the ids
mubit_forget    → delete, or supersede
```

Prefer a **negative outcome** for a lesson that is merely wrong; deletion cannot be undone.

**Never deleted by anything above:** your `credentials.json`, your installed `mubit-memory@mubit`
plugin, and its data. §10 disabled the installed copy for the length of one session with
`--settings`; nothing on disk changed.

---

## What this file does not cover

- **The automated suite.** `npm test` and `npm run test:dist` are 1140/1140 on this build and
  cover far more than this file does. This is the half a green suite cannot claim: what the wire
  actually carries, and what the server does with it.
- **`npm run verify`.** Do not run it here — its `clean` step deletes the tracked, vendored
  `mcp/dist/server.js`, which cannot be rebuilt in this checkout. Build with
  `MUBIT_CC_BUILD_SKIP_SERVER=1 npm run build`.
- **Whether freshness ranking makes recall *better*.** Everything above proves the dial is
  connected and turns. Whether a freshness-ranked block is more useful than a relevance-ranked one
  is a question about your memory, not about this build, and it needs an A/B over real sessions
  rather than a transcript.
- **`plugin-scope-fix`.** PR #11 was closed unmerged; Wave 1 does not depend on it. Linked-run
  behaviour is not exercised anywhere in this file.
