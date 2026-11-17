# npmignore-client-fixture

A package whose `files` list ships `lib/`, but whose `lib/.npmignore` removes
the `lib/client.js` that `exports["./client"]` names. `npm pack` leaves the
client out of the tarball, so the installed plugin has no panel to mount.

## Requirements

- DeepSeek Harness `>=0.2.0`
