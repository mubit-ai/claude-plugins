# Workflows on the published branch

This branch is the **artifact a user installs**, not the source it was built from. It carries
`hooks/dist`, `mcp/dist` and `bin/` and deliberately not `hooks/src`, `lib/` or `mcp/src` — see
`package.json`'s `files` list, which decides what ships.

That is why only `leak-scan.yml` runs here.

`verify.yml` lives on `pre-main` and cannot run on this branch: its first step is
`node --check hooks/src/*.mjs lib/*.mjs bin/*.mjs mcp/src/*.mjs`, and three of those four paths
do not exist in a published tree. Its central invariant — rebuild every bundle and fail if the
result differs from what is committed — is a statement about source that this branch does not
have. Running the plugin's test suite here is impossible for the same reason: `test/` is not
published either.

**So the checks that guard this branch are the leak scan and whatever ran on `pre-main` before
the release was cut.** A change made directly here is verified by neither. Make it on
`pre-main`, then cut the release again.
