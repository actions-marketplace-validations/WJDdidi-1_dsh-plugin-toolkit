# verify-prepack-flip

A fixture whose working copy is complete but whose tarball is not: `client.js`
is committed and declared, and the `prepack` hook removes it. The old verify
could read the dry run (where the panel was still present) and report success
for a tarball with no panel. Packing once and judging that archive catches it.

## Requirements

- DeepSeek Harness `>=0.2.0`
