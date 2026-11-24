# not-always-shipped-dot-main-fixture

Writes `main` as `./index.js`. npm adds the field to its strict rules verbatim,
so the rule names `./index.js` and `npm pack` drops `index.js` when `files`
omits it. `doctor` must report the omission rather than printing `ok`.

## Requirements

- DeepSeek Harness `>=0.2.0`
