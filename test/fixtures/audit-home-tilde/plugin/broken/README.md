# broken

A fixture plugin that is installed and declared, but whose `dsh.bundle.patch`
points at `./missing.yml`. Every other check passes, so the only row the audit
can print is the missing patch file.

## Requirements

| Harness |
| --- |
| `>=0.2.0` |
