# files-negated-reinclude-fixture

A package whose `files` list re-lists `lib/client.js` after excluding it with
`!lib/client.js`. npm treats each explicit file entry as a strict rule and
applies the first mention last, so the tarball still omits the client that
`exports["./client"]` and `dsh.client.entry` name.

## Requirements

- DeepSeek Harness `>=0.2.0`
