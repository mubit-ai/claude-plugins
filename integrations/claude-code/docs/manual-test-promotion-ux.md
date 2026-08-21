# Manual test — the promotion fixes, and a full pass over the UX

Two halves, and they are deliberately different in kind.

**Part A** proves the three fixes that landed in #9 — the ones that make `SessionEnd` actually
promote. It runs **offline**, against a stub on loopback, because all three are about *timing*
and a stub is the only way to hold time still. Nothing dials `api.mubit.ai`; nothing touches
your memory.

**Part B** drives the plugin the way you actually meet it: a real Claude Code session against
the hosted Mubit, every surface once — injection, recall, capture, the status line, all seven
skills, all ten MCP tools, `mubit-inspect`, and the doctor.

**Time:** ~10 minutes for Part A, ~25 for Part B.

**Destroys:** Part A destroys nothing — every byte lives in two temp directories you delete in
§14. Part B writes into your **real** Mubit memory and your **real** data dir; §14 tells you
exactly what it leaves and how to remove it.

**Provenance of the Expect blocks.** Every block in **Part A** is a transcript from a real run
of this build on 2026-08-20 — timestamps and the `at` epochs will differ, nothing else should.
Blocks in **Part B** describe the *shape* to look for and are marked `Look for`, not `Expect`:
they depend on your account's memory and cannot be pinned to a transcript.

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

**Trap 2 — the data directory is not where the docs say.** A `--plugin-dir` session is
documented as writing to `~/.claude/plugins/data/mubit-memory-inline`; measured, it writes to
`~/.claude/plugins/data/mubit-memory`. Do not guess — `MUBIT_CC_DATA_DIR` has the highest
precedence of any data-dir input (`lib/state.mjs`), so pin it and everything lands in one
directory you own and can delete.

### Create the temp directories

Two of them: a **scratch** directory for the stub and its log, and a **data** directory standing
in for the plugin's state. Both live under `/tmp` and both are removed in §14.

```bash
export PLUG=/Users/eldaru/Mubit/pre-main/integrations/claude-code
export SCRATCH=/tmp/mubit-ux
export DATA=/tmp/mubit-ux-data

rm -rf "$SCRATCH" "$DATA"          # idempotent: safe to re-run this whole file
mkdir -p "$SCRATCH" "$DATA" "$DATA/tmp"

cd "$SCRATCH" && git init -q && echo "# scratch" > README.md
git add -A && git -c user.email=you@example.com -c user.name=you commit -qm init

# pin everything — never rely on the ambient environment
export MUBIT_CC_DATA_DIR="$DATA"
export MUBIT_ENDPOINT=http://127.0.0.1:3992
export MUBIT_API_KEY=mbt_stub_key
export MUBIT_CC_RUN_STRATEGY=static
export CLAUDE_PROJECT_DIR="$SCRATCH"
export S=b1111111-2222-3333-4444-555555555555

# the SessionEnd payload, with the host's own field names
SE() { echo "{\"session_id\":\"$S\",\"transcript_path\":\"$SCRATCH/t.jsonl\",\"cwd\":\"$SCRATCH\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"exit\"}"; }
# one spooled capture, so there is something to reflect over
seed() { mkdir -p "$DATA/runs/$1/spool"; echo '{"item_id":"cc-ux-1","content_type":"text","text":"Edit(file_path=src/lib.rs) -> Applied 1 edit","intent":"trace","importance":"medium","source":"agent","occurrence_time":1765000000,"env_tags":["tool:claude-code"],"metadata_json":"{}"}' > "$DATA/runs/$1/spool/1765000000000-aux000.json"; }
# the reflect block of a run's marker, which is what all of Part A is about
R() { python3 -c "import json;print(json.load(open('$DATA/status/$1.json'))['reflect'])" 2>/dev/null || echo "(no marker on disk yet)"; }

echo "plugin   $PLUG"; echo "scratch  $SCRATCH"; echo "data     $DATA"
```

**Expect**

```
plugin   /Users/eldaru/Mubit/pre-main/integrations/claude-code
scratch  /tmp/mubit-ux
data     /tmp/mubit-ux-data
```

> Every command in Part A assumes these exports. If you open a new terminal, paste the block
> again — shell state does not travel between windows.

---

## §1 — The stub Mubit

It reads its delays from a file **on every request**, so a scenario retunes it without a
restart. That matters: all three fixes are about what happens when the server is slow, and
restarting between scenarios is how you lose the thread.

```bash
cat > "$SCRATCH/stub.mjs" <<'EOF'
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const CFG = new URL('./delays.json', import.meta.url);
const delay = (k) => { try { return Number(JSON.parse(readFileSync(CFG, 'utf8'))[k] || 0); } catch { return 0; } };
const LESSONS = [{ lesson_id: 'les_1', content: 'Poll the job id until it reports indexed.',
  lesson_type: 'lesson', scope: 'run', importance: 'high' }];
createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const u = req.url;
    process.stderr.write(`${new Date().toISOString().slice(11, 23)} ${req.method} ${u}\n`);
    if (u === '/v2/core/health') { res.writeHead(200); return res.end('OK'); }
    let ms = 0, body = { ok: true };
    if (u === '/v2/control/ingest') {
      ms = delay('ingest');
      body = { accepted: true, job_id: 'job_stub_1', deduplicated: false, status: 'queued' };
    } else if (u === '/v2/control/reflect') {
      ms = delay('reflect');
      body = { lessons: LESSONS, summary: 'ok', confidence: 0.7, degraded: false, lessons_stored: 1 };
    } else if (u === '/v2/control/agents/heartbeat') {
      ms = delay('heartbeat');
    }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    }, ms).unref?.();
  });
}).listen(3992, '127.0.0.1', () => process.stderr.write('stub up on 3992\n'));
EOF

echo '{"ingest":0,"reflect":0,"heartbeat":0}' > "$SCRATCH/delays.json"
node "$SCRATCH/stub.mjs" 2>"$SCRATCH/stub.log" &
sleep 1 && cat "$SCRATCH/stub.log"
```

**Expect**

```
stub up on 3992
```

Part A runs the **shipped `hooks/dist/*.mjs`**, which is what Claude Code actually executes —
not `hooks/src`.

---

# Part A — the three fixes

## §2 — MUB-15: reflect outlasts a real LLM tail

**The defect.** The three §5.7 budgets compose, and the innermost binds: reflect gets
`min(REFLECT_MS, BUDGET_MS − elapsed − HEARTBEAT_MS)`, measured *after* a drain that may have
spent its own time first. The detached child used to get ~8 s. The measured tail of a real
hosted reflect is **9626 ms**. So the client was hanging up on calls the server was still
answering — and because reflect is the only call that widens a lesson's scope past `run`, every
one of those was a session whose memory died with it.

Set the reflect to take 9 s and watch the marker:

```bash
echo '{"ingest":0,"reflect":9000,"heartbeat":0}' > "$SCRATCH/delays.json"
export MUBIT_CC_RUN_ID=cc-ux-demo && seed cc-ux-demo

start=$(date +%s)
SE | node "$PLUG/hooks/dist/session-end.mjs" >/dev/null
echo "hook returned after $(( $(date +%s) - start ))s"
for i in 0 2 4 6 8 10 12; do
  [ $i -gt 0 ] && sleep 2
  echo "t+${i}s  $(R cc-ux-demo)"
done
```

**Expect**

```
hook returned after 0s
t+0s  {'at': 0, 'lessons_stored': 0, 'status': 'detached'}
t+2s  {'at': 0, 'lessons_stored': 0, 'status': 'detached'}
t+4s  {'at': 0, 'lessons_stored': 0, 'status': 'detached'}
t+6s  {'at': 0, 'lessons_stored': 0, 'status': 'detached'}
t+8s  {'at': 0, 'lessons_stored': 0, 'status': 'detached'}
t+10s  {'at': 1787231807448, 'lessons_stored': 1, 'status': 'ok'}
t+12s  {'at': 1787231807448, 'lessons_stored': 1, 'status': 'ok'}
```

Three things to read here:

- **The hook returns in well under a second** while the work continues. That is the hand-off:
  the parent stashes, stamps, spawns and leaves. Nothing waits on the child, which is why it is
  allowed a 45 s reflect at all.
- **`detached` holds for the full nine seconds.** Before #9 this flipped to `failed` at ~8 s
  with `last_error: POST /v2/control/reflect: aborted after 8000ms`.
- **`lessons_stored: 1`.** The count is the point — it is the number the killed hook could
  never write.

> **Boundary check, optional and slow.** Set `reflect` to `46000` and re-run with a fresh
> `MUBIT_CC_RUN_ID`. It should reach `failed` at ~45 s. That is the new ceiling, and it is
> supposed to exist — the fix widens the budget, it does not remove it.

## §3 — F6: the client's own deadline is not a verdict about the server

**The defect.** `lib/http.mjs` exempts a caller who dials *tighter* than the configured default
— a 400 ms health slice learns nothing about a healthy server. Reflect is the mirror image: it
is LLM-backed and dials **wide** on purpose, and the exemption missed it, so its abort was
filed as `not_responding`. Five of those inside the window open the breaker, and **the breaker
gates the ingest drain** — so a merely slow reflection could escalate into capture stopping
altogether.

This scenario runs the hook **inline** (`MUBIT_CC_SESSION_END_DETACH=0`), which is also how you
confirm the inline branch was left alone: it still gets 4000 ms, and still gives up there.

```bash
echo '{"ingest":0,"reflect":9000,"heartbeat":2000}' > "$SCRATCH/delays.json"
export MUBIT_CC_RUN_ID=cc-ux-inline && seed cc-ux-inline

start=$(date +%s)
SE | MUBIT_CC_SESSION_END_DETACH=0 node "$PLUG/hooks/dist/session-end.mjs" >/dev/null
echo "inline hook returned after $(( $(date +%s) - start ))s"

python3 -c "import json;d=json.load(open('$DATA/status/cc-ux-inline.json'));print(d['reflect']);print('last_error:',d.get('last_error'))"
python3 -c "
import json,glob
for f in glob.glob('$DATA/breaker/*.json'):
    d=json.load(open(f)); print('failures:',d['failures'],'| state:',d['state'],'| timeoutStreak:',d['timeoutStreak'])
"
```

**Expect**

```
inline hook returned after 5s
{'at': 1787231833821, 'lessons_stored': 0, 'status': 'failed'}
last_error: POST /v2/control/reflect: aborted after 4000ms
failures: [] | state: ready | timeoutStreak: 0
```

The two halves of the assertion:

- **`failed`, `aborted after 4000ms`** — the failure is still reported. This fix hides nothing;
  the marker and `last_error` say exactly what happened.
- **`failures: []`** — and it is not recorded against the server. Before #9 this array held one
  `not_responding` entry per slow reflect.

> **Why the heartbeat is also stalled here.** §5.7's idle heartbeat runs *after* reflect, and a
> successful one calls `recordSuccess`, which empties `failures` outright — so against a
> responsive stub the patched and unpatched builds leave byte-identical state and this check
> proves nothing. Stalling it does not hide anything either: the heartbeat dials 1000 ms, which
> is *tighter* than the 4000 ms default, so its own abort was already exempt. What is left in
> the window is exactly the one call under test.

## §4 — MUB-18: `handoff` says the parent got that far

**The defect.** `stashPayload` runs inside the host's ~1 s kill window. A parent killed there
left `reflect: {at: 0, status: ""}` — byte-identical to a session where `SessionEnd` never fired
at all. Two very different failures, one indistinguishable marker.

Make the hand-off fail by taking away the directory it writes to. The body then falls back to
running inline, which is what lets you read the marker while the work is still going:

```bash
echo '{"ingest":2500,"reflect":0,"heartbeat":0}' > "$SCRATCH/delays.json"
export MUBIT_CC_RUN_ID=cc-ux-handoff && seed cc-ux-handoff
chmod 0500 "$DATA/tmp"      # the hand-off now has nowhere to write

SE | node "$PLUG/hooks/dist/session-end.mjs" >/dev/null &
for i in 1 2 3 4 5; do sleep 0.6; echo "t+$(echo "$i*0.6" | bc)s  $(R cc-ux-handoff)"; done
wait
chmod 0700 "$DATA/tmp"      # put it back, or §14's rm complains
```

**Expect**

```
t+.6s  {'at': 0, 'lessons_stored': 0, 'status': 'handoff'}
t+1.2s  {'at': 0, 'lessons_stored': 0, 'status': 'handoff'}
t+1.8s  {'at': 0, 'lessons_stored': 0, 'status': 'handoff'}
t+2.4s  {'at': 0, 'lessons_stored': 0, 'status': 'handoff'}
t+3.0s  {'at': 1787232058089, 'lessons_stored': 1, 'status': 'ok'}
```

Before #9 the first four rows read `(no marker on disk yet)` — nothing on disk, and therefore
nothing to distinguish a hook that was killed from one that never ran. The four `reflect.status`
values now partition cleanly:

| value | written by | means |
| --- | --- | --- |
| `""` | nobody — the marker default | session-end never ran |
| `handoff` | the parent, before any work | started, then killed in the host's ~1 s window |
| `detached` | the parent, before spawning | handed over; no child has reported yet |
| `ok` / `failed` / `skipped:*` | whichever process ran the body | terminal |

Note the fallback path is correct here: `handoff` stands until the inline body writes a terminal
status. That run was never detached, so it never claims to be.

**Stop the stub — Part A is done:**

```bash
pkill -f "$SCRATCH/stub.mjs"; grep -c . "$SCRATCH/stub.log"
```

---

# Part B — the whole UX, against the real thing

Everything below runs against `api.mubit.ai` with your own key, in a real session. The blocks
are marked **Look for** rather than **Expect**: what comes back depends on your account's
memory.

## §5 — Load the build under test without your installed copy fighting it

`--plugin-dir` **adds** a plugin. `mubit-memory@mubit` is enabled in `~/.claude/settings.json`
and keeps running too, so both sets of hooks fire against the same data dir and race
`claimOnce` — you get half your results from the wrong build. Disable it inline; `--settings`
takes a **JSON string**, so this touches nothing of yours:

```bash
cd /tmp/mubit-ux
unset MUBIT_ENDPOINT MUBIT_API_KEY MUBIT_CC_DATA_DIR   # back to your real config
export LIVE="$HOME/.claude/plugins/data/mubit-memory"

claude --plugin-dir "$PLUG" \
  --settings '{"enabledPlugins":{"mubit-memory@mubit":false}}'
```

Credentials come from `<dataDir>/credentials.json`, so do **not** point `MUBIT_CC_DATA_DIR` at a
fresh directory for Part B — that is an unconfigured install and it will dial nothing.

> If the local server is what you are testing against rather than hosted, raise the recall
> budget first: `export MUBIT_CC_RECALL_BUDGET_MS=8000`. The local server is slower than the
> default budget and you will otherwise measure the timeout, not the server.

## §6 — Session start: the steer block and the lessons

**Look for**, in the first thing the session shows you: a short block saying memory is active,
naming the run id and whether it is hosted, telling the model it need not open a turn by
searching, and listing the tool to reach for when injected memory falls short. Up to **5** global
lessons ride along with it (`README.md:95`).

Sanity-check that the session is on the build you think it is:

```bash
ls -la "$PLUG/hooks/dist/impl/session-end.mjs"
grep -o 'DETACHED ? 45e3 : 4e3' "$PLUG/hooks/dist/impl/session-end.mjs"
```

`45e3` is #9's build. `8e3` means you are running the old bundle and the rest of Part B will
measure it.

## §7 — Recall, on an ordinary prompt

Ask something your memory should know. In this session:

> `why is the ingest job stuck in queued?`

**Look for** an injected block *before* the model answers, with no tool call — recall is a
pre-prompt hook, not something the model chooses. Then read what it cost:

```bash
node "$PLUG/scripts/mubit-inspect.mjs" --last 5
```

**Look for** a per-prompt table with `rung 1` (`direct_bypass`, zero LLM calls), a non-zero
`sources`, and a `tok` figure. Rung 2 (`agent_routed`) means the fast path was denied and you
are paying a routing LLM call — check `empty_reason`.

Add `--resolve` to turn the recalled ids into text, and `--cross-run` to see which injected
memories came from a *different* run.

## §8 — Capture, and the drain

Do two or three ordinary things — read a file, edit one, run a command. Capture is on every tool
call. Then:

```bash
node "$PLUG/scripts/mubit-inspect.mjs" | sed -n '/capture/p'
```

**Look for** `tools` climbing, and `pending`/`spool` returning to 0 as the drain lands the batch.
A `jobs` line records the ingest job and its last status.

## §9 — Promotion, at the end of a real session

This is §2–§4 with the training wheels off. Exit the session, then:

```bash
watch -n1 "python3 -c \"import json;print(json.load(open('$LIVE/status/<your-run-id>.json'))['reflect'])\""
```

**Look for** the sequence `handoff` → `detached` → `ok`, with `lessons_stored` non-zero on a
session that did real work. `detached` sitting there minutes later means the child was reaped —
the container or terminal went away before the reflect came back. That is MUB-16, it is
server-side, and it is the one failure the plugin cannot fix from here.

## §10 — The status line

If you have it wired into your prompt it renders itself. To see it directly:

```bash
echo "{\"session_id\":\"$S\",\"cwd\":\"$PWD\",\"workspace\":{\"current_dir\":\"$PWD\"},\"model\":{\"display_name\":\"Opus\"}}" \
  | MUBIT_CC_DATA_DIR="$LIVE" node "$PLUG/bin/statusline.mjs"
```

**Look for** one line: a state glyph, the run id, and the mode — e.g.
`● mubit: cc-ux-handoff · hosted`. The glyph is the breaker's verdict, so this is where a
failing instance shows up first. Note it does **not** render `reflect.status`; the doctor table
in §14 is that field's only consumer.

## §11 — The seven skills

Run each once. They are the explicit forms of things the plugin otherwise does silently.

| Skill | Try | Look for |
| --- | --- | --- |
| `/mubit-memory:remember` | "always run the migration before starting the server" | confirmation that a lesson was stored, with its scope |
| `/mubit-memory:recall` | "what do we know about ingest jobs?" | lessons and evidence beyond what was auto-injected |
| `/mubit-memory:reflect` | — | what it extracted from *this* session, reported back |
| `/mubit-memory:doctor` | — | connectivity, memory health, stuck ingest jobs; see §14 |
| `/mubit-memory:forget` | the lesson you just wrote | deletion, or a supersede — it warns that deletion cannot be undone |
| `/mubit-memory:setup` | — | endpoint and key confirmed, instance answers |
| `/mubit-memory:auth` | — | sign-in state for this machine |

Do `remember` **before** `recall` and leave a prompt or two between them: the interesting result
is the lesson coming back *without* a tool call, which is the whole product.

## §12 — The ten MCP tools

The allowlist is 10 tools, not 21 — that is what makes `contextCost` 3316 rather than 5382. Ask
the model to call each once:

`mubit_recall` · `mubit_learned` · `mubit_outcome` · `mubit_status` · `mubit_diagnose` ·
`mubit_lessons` · `mubit_forget` · `mubit_archive` · `mubit_dereference` · `mubit_reflect`

**Look for**, specifically:

- **`mubit_status`** — the same verdict the status line renders, in full.
- **`mubit_diagnose`** — run it after a command fails; it is the "why did that break" path.
- **`mubit_outcome`** — credits a memory that helped. Watch a lesson's confidence move.
- **`mubit_dereference`** — turns a `reference_id` you already hold into its text, no search.
- **`mubit_learned`** — note its scope. This is the tool that used to leak across runs; the
  egress guard in `mcp/src/egress.mjs` is what stops `session` scope behaving as a quiet
  `global`.

## §13 — The doctor, and the new row

```
/mubit-memory:doctor
```

**Look for** it reading `reflect.status` and naming the value. The table it consults now carries
a `handoff` row above `detached`, which is the §4 fix reaching the surface a human actually
looks at:

```bash
grep -A2 '`handoff`' "$PLUG/skills/doctor/SKILL.md" | head -3
```

---

## §14 — Teardown

### Part A — complete removal, nothing left behind

```bash
pkill -f /tmp/mubit-ux/stub.mjs 2>/dev/null
chmod 0700 /tmp/mubit-ux-data/tmp 2>/dev/null   # §4 left it read-only if you stopped early
rm -rf /tmp/mubit-ux /tmp/mubit-ux-data
ls -d /tmp/mubit-ux /tmp/mubit-ux-data 2>&1
```

**Expect**

```
ls: /tmp/mubit-ux: No such file or directory
ls: /tmp/mubit-ux-data: No such file or directory
```

Confirm nothing is still listening and no stray child survived:

```bash
lsof -nP -iTCP:3992 -sTCP:LISTEN 2>/dev/null | tail -n +1
pgrep -fl 'session-end.mjs|stub.mjs'
```

**Expect** no output from either.

### Part B — what it actually leaves

Part B is not self-contained, and pretending otherwise is how people lose data they wanted.

**In your real data dir** (`~/.claude/plugins/data/mubit-memory`): a run directory and a status
marker per session. Harmless, and §7's TTL sweep prunes them, but to remove one by hand:

```bash
rm -rf "$LIVE/runs/<your-run-id>" "$LIVE/status/<your-run-id>.json"
```

**In your real Mubit memory:** every lesson §11's `remember` and §9's reflect stored. These are
**server-side and survive the directory deletion.** Remove them deliberately:

```
/mubit-memory:forget
```

or list first, then delete what you recognise:

```
mubit_lessons   → find the ids
mubit_forget    → delete, or supersede
```

Prefer a **negative outcome** for a lesson that is merely wrong; deletion cannot be undone.

**Never deleted by anything above:** your `credentials.json`, your installed
`mubit-memory@mubit` plugin, and its data. Part B disabled the installed copy for the length of
one session with `--settings`; nothing on disk changed.

---

## What this file does not cover

- **The automated suite.** `npm test` and `MUBIT_CC_TEST_TARGET=dist npm test` are 1067/1067 on
  this build and cover far more than this file does. This is the half a green suite cannot
  claim: what a host process does to a hook it is about to kill.
- **`npm run verify`.** Do not run it here — its `clean` step deletes the tracked, vendored
  `mcp/dist/server.js`, which cannot be rebuilt in this checkout.
- **The three server-side findings** — the global-lesson overlay answering unrelated queries,
  the detached child dying with its container, and the `source` stamp that names the extraction
  mode rather than the caller. None is fixable from the client, and each is written up for the
  backend team rather than worked around here.
