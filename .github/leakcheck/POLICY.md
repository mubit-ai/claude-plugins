# What may not be published from this repository

This repository is public and it is a **mirror**: it is the distribution point for a plugin
whose source lives elsewhere. Two consequences follow, and they are the whole reason this
policy exists.

**Nothing here can be unpublished.** A blob that was pushed stays reachable, a merged pull
request keeps its diff, and forks and clones are made within minutes of a push. Deleting a
file in a later commit removes it from the tip and from nothing else. The only leak that stays
cheap is the one that never lands.

**A client cannot keep the wire secret.** Anyone can read the code, watch the socket, or
decompile the bundle. Endpoint paths, request fields, response fields and error strings are
public the moment the plugin ships, and trying to hide them buys nothing. So this policy does
not ask anyone to obfuscate the client. It asks for one distinction to be held:

> Publish **what the client does**. Do not publish **what the server does with it**, **where
> the server's code lives**, **what we have not fixed yet**, or **whose machine this was run
> on**.

---

## The four categories

### 1. Mubit's closed source

Not published: crate and file paths inside the server (`crates/…`), internal package names,
verbatim comments or code copied out of the server, references to the private engineering
specification by name or section number, and internal ticket or document identifiers.

Published: the endpoints the client calls, the fields it sends and reads, and what a response
means to the client.

*Why it matters:* a single source path tells a reader the server's language, its workspace
layout, and exactly which file to ask an insider about. None of that is inferable from a
client, and none of it helps a user.

### 2. Server-side mechanism

Not published: how retrieval ranks or scores, tuned thresholds and gates, experiment
infrastructure, promotion and decay mechanics, storage key formats, or any sentence beginning
"the server then…".

Published: the client-visible consequence. "A lesson written at `run` scope is not read back by
another run" is a contract. "The cross-run overlay admits every lesson whose scope is not `run`"
is an implementation.

*Why it matters:* the mechanism is the product. The wire contract is a description of the
product's edge and it is unavoidably public; the mechanism behind it is not, and nothing in a
client needs to explain it in order to work.

### 3. Security posture, and defects we have not closed

**This is the category that is worse than reverse engineering**, and the one to be strictest
about.

Not published: descriptions of isolation weaknesses, statements that a safety property is
enforced only in the client, notes that the server trusts a client-supplied identifier, or any
narrative that amounts to "here is the call to make if you skip our client".

Published: the guarantee, once it holds. A clamp in the client may be documented as a local
setting — but not as *the* control, and not alongside the observation that nothing else
enforces it.

*Why it matters:* a comment explaining which value a client must not be allowed to send is a
working exploit note. It is read first by exactly the people it should not reach, and unlike
the rest of this policy it has a blast radius beyond us — it reaches the tenants on the
instance.

If you find such a defect: file it privately, fix it server-side, and only then describe the
guarantee here.

### 4. People, machines, and other people's software

Not published: home directory paths, real names and addresses, links to internal documents,
production identifiers pasted out of live output, the contents of anybody's stored memory, and
strings extracted from a third-party vendor's shipping binary.

Published: `$PLUG`, `/Users/you`, `you@example.com`, `<run id>`, and behaviour pinned against
payloads we observed rather than binaries we disassembled.

*Why it matters:* the first three name a person; the last publishes someone else's unannounced
roadmap under our name, and teaches the extraction technique next to it.

---

## Internal runbooks

Manual-test runbooks and handoff memos are written for the team, executed on the team's
machines, and pasted from the team's terminals. In practice every category above was found
inside one. They belong in the source repository.

`docs/user-guide.md` is the exception and stays: it is written for users, against a machine
that could be anybody's.

---

## How this is enforced

- `.github/scripts/leakcheck.mjs` — a deterministic scan of every tracked file, on every push
  and pull request. Rules live in `rules.mjs`, each one annotated with the real finding that
  motivated it.
- `.github/scripts/llm-leak-review.mjs` — a model reads the diff against this document, for the
  cases a regex cannot state: a paragraph that explains a mechanism without using any of the
  words a rule looks for.
- `baseline.json` — findings that were already in the tree when the gate went on. It exists so
  the gate could be enabled before the backlog was cleared. **Shrink it. Never grow it to make
  a build pass.**

Suppressing one line, when the rule is wrong and the line is right:

```js
const path = '/Users/x/repo/src/lib.rs'; // leakcheck-allow: dev-machine-path — fixture, not a real home
```

The reason is not parsed by anything. It is there for the reviewer, who should refuse a
suppression that does not carry one.
