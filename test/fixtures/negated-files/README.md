# negated-files-fixture

A package whose `files` list names `lib/` but excludes the file that
`exports["./client"]` points at. `npm pack` leaves `lib/secret.js` out of the
tarball, so the installed plugin has no client bundle.

## Requirements

- DeepSeek Harness `>=0.2.0`
