# demo-plugin

## Requirements

- DeepSeek Harness `>=0.2.0`

## Fixture: the index and the registry disagree about the publish time

`market/index.json` lists `1.0.0` with `publishTimestamp` `1767225601`, one
second after the registry's `2026-01-01T00:00:00.000Z` (`1767225600`). A
`release --pr` on this repository must stop at the index with both timestamps
in the error, exit `1`, leave the index untouched, and create no
`market/1.0.0` branch.
