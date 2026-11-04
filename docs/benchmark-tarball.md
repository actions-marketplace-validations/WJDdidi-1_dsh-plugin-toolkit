# The tarball ships the benchmark

[`README.md`](../README.md#measured-throughput) tells readers to run
`npm run benchmark`, whose script is `node scripts/benchmark-audit.mjs`. The
checkout has always had the script, but the published `0.19.0` tarball did not:
`package.json`'s `files` list left out `scripts/`, so the command failed inside a
fresh install with `MODULE_NOT_FOUND`.

## What went wrong in 0.19.0

Measured on 2026-11-04 with Node.js `v24.15.0` and npm `11.12.1`:

```sh
$ tmp=$(mktemp -d)
$ cd "$tmp"
$ npm init -y
$ npm install dsh-plugin-toolkit@0.19.0
added 1 package in 6s
$ cd node_modules/dsh-plugin-toolkit
$ npm run benchmark

> dsh-plugin-toolkit@0.19.0 benchmark
> node scripts/benchmark-audit.mjs

Error: Cannot find module '/tmp/.../node_modules/dsh-plugin-toolkit/scripts/benchmark-audit.mjs'
  code: 'MODULE_NOT_FOUND'
$ echo $?
1
```

The README measured the first eight entries of the 3 November install-failure
list, but `docs/ecosystem-audit-2026-11-03.txt` was not shipped either, so even a
script that packed would have had no sample to read.

### The 3-trial measurement

The defect was measured by packing the installed `0.19.0` copy, installing that
tarball into a private temp prefix and running the documented command three
times. The metric was the number of trials that exited nonzero, with a threshold
of `0`:

| trial | exit code |
| --- | --- |
| 1 | 1 |
| 2 | 1 |
| 3 | 1 |

All three failed with `MODULE_NOT_FOUND` on the same missing
`scripts/benchmark-audit.mjs`, so the metric was `3` against a threshold of `0`.
The packed tarball had 34 files and no `scripts/` entry; `lib/benchmark.mjs` was
present.

## What ships now

`package.json` ships both files the command needs:

- `scripts/benchmark-audit.mjs`, the file `scripts.benchmark` names;
- `docs/ecosystem-audit-2026-11-03.txt`, the list `lib/benchmark.mjs` reads.

`lib/benchmark.mjs` and the rest of `lib/` were already in the tarball. Running
`npm run benchmark` in an installed copy now measures the same eight
repositories the README names, with the same fixed 500 ms delay per API request.

## Keeping it working

`test/benchmark-tarball.test.mjs` packs this package, installs the tarball into a
temp directory and runs the documented command there. The test asserts that the
script and its sample are in the packed file list, so a future `files` edit that
drops one of them fails before publication.
