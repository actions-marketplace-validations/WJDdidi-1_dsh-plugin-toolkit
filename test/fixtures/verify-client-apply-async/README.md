# verify-client-apply-async

The async client rejection fixture: the installed client half exports an
`async function apply()` that rejects on the bare boot context verify probes,
while it succeeds on the full host.

## Requirements

- DeepSeek Harness `>=0.2.0`
