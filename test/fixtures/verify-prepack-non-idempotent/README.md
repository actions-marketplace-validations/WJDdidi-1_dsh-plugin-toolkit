# verify-prepack-non-idempotent

A fixture whose `prepack` hook is not idempotent: the first invocation writes
`client.js`, every later invocation removes it. A `verify` that packs exactly
once must report on the tarball that invocation built, so the first run ships a
panel and the second run fails at `pack` naming `client.js`. An earlier verify
ran a dry run before the real pack and silently judged the dry run's file list,
which described a different tarball.

The generated panel registers a sidebar tab, so it can be mounted: the
regression test runs the shipped CLI's `verify` (which mounts) and
`verify --no-mount` on fresh copies, twice each. The first run must exit 0 after
one `prepack` invocation and leave `client.js` in the folder; the second must
exit 1 at `pack` with a `client.js` failure.

## Requirements

- DeepSeek Harness `>=0.2.0`
