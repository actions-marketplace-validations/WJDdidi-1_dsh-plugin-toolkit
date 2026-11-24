# always-included-bin-browser-fixture

Exports its `bin` target and its `browser` file while leaving both out of
`files`. npm adds the `main`, `browser` and every `bin` target to the tarball
whatever `files` says, so this package must stay clean.

## Requirements

- DeepSeek Harness `>=0.2.0`
