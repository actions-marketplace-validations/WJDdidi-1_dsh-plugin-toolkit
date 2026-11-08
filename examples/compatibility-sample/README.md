# dsh-resume

This folder is a frozen snapshot of the files the compatibility sample audits.
Its `engines.dsh` range is the real one from `L3n3L/dsh-resume@0.1.3`:

## Requirements

- DeepSeek Harness `>=0.1.0-rc.6 <0.2.0-0`

```json
"engines": {
  "dsh": ">=0.1.0-rc.6 <0.2.0-0"
}
```

The heading is here on purpose: the sample isolates the host-range verdict, and
the remote audit still checks README requirements. Upstream's localized README
does not use a `## Requirements` heading, so a live audit of the repository can
also add a `readme` failure to the same row.
