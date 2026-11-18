# verify-prepack-missing

The control for `verify-prepack-generated`: its `prepack` hook runs but never
writes `client.js`, so the tarball really is missing the panel.

## Requirements

- DeepSeek Harness `>=0.2.0`
