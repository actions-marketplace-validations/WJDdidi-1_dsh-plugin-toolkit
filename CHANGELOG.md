## 0.20.24

- **`doctor` applies negated `files` entries instead of passing a package npm
  will publish without its client.** `files: ["lib", "!lib/secret.js"]` ships
  the folder but drops `lib/secret.js`; the check saw `lib` cover the exported
  client and exited `0`, so the installed plugin was missing code its own
  `exports["./client"]` named. A leading `!` now removes what the positive
  entries shipped — a file, a folder and its subtree, or a basename pattern at
  any depth — and a later positive entry can re-include a path. The same
  manifest without the `!` entry still passes. A committed fixture feeds one
  `files` list to both `npm pack` and `doctor`: the suite requires the packer to
  leave `lib/secret.js` out of the tarball and `doctor` to report it on three
  consecutive runs, so the check cannot drift from the packer.

- **A failed `market/<version>` push is named, not a raw exec error.** With
  `--pr`, a rejected or denied branch push used to surface only as
  `Command failed: git push -u origin market/<version>` from the exec wrapper.
  The `push` step now quotes git's own `stderr` (or `stdout` when that is where a
  wrapper wrote the reason), names the branch, and drops the wrapper's
  `Command failed:` line. The tag push uses the same helper, so a remote that
  writes its rejection on stdout is named too.

- **A failed push is checked against origin before the retry is blamed.** A
  push can exit non-zero after receive-pack already updated the ref (a
  post-receive hook, or a connection that drops after the reply). The retry
  path now reads `refs/tags/<tag>` from `origin` when `git push` fails: the same
  tag object means the tag landed and the release continues; a different object
  means origin owns that name at another commit, so the error names both object
  ids and says neither tag was moved instead of claiming "the tag is still
  local" and telling the user to re-run a push that cannot succeed. A test
  makes the push throw while the bare origin already carries the tag and
  requires exit `0`; a conflicting-tag test requires both ids in the `git`
  stage error and leaves origin's tag untouched.

## 0.20.23

- **A failed `git push` is reported as the `git` stage, not a raw exec error.**
  When `origin` was unreachable, `release` created the local tag and then let
  the `execFileSync` error escape, so the user saw a command line and stack
  instead of the stage and the tag that still needed pushing. Tag creation and
  the tag push now catch git's failure, return `stage: 'git'`, and print
  `release stopped at git` with the tag, git's own reason, and the fact that
  the tag exists only locally. With `origin` pointed at a missing path the CLI
  exits `1` and leaves `plugin-v<version>` at HEAD; after `git remote set-url
  origin` points at the bare repository, the same working tree re-runs, resumes
  from that tag, pushes it, and exits `0`. A process-level test covers the
  failed push and the corrected retry.

- **A retry pushes a tag that exists only locally.** When `release` created
  `plugin-v<version>` and then failed at `git push`, the next run saw the local
  tag at HEAD, took the resume path, skipped both the tag and the push, and
  could report success while the remote still had no tag. The resume path now
  pushes the existing tag before the registry wait. Pushing a tag the remote
  already has at the same commit is a no-op, so repeated retries leave exactly
  one tag on origin. A test reproduces the failed-push state, retries, and
  requires the bare origin to list the tag exactly once; a CLI test starts from
  a local-only tag and requires exit `0` with the tag on origin.

## 0.20.22

- **A missing `audit --home` value is refused before the scan, and a later
  `--home` cannot hide it.** The parser used to leave the missing path only in
  the value slot, so a second `--home <dir>` overwrote the typo and the command
  scanned anyway; every missing spelling is now recorded through the rest of
  parsing. `audit --home`, `audit --home --timeout 50`, `audit --home --json`
  and `audit --home --home <dir>` each exit `2` with `--home needs a directory
  path` on stderr and no profile report on stdout, while `audit --home <dir>`
  against the one-declared-plugin fixture still prints its `missing` row and
  exits `1`. The README says a bare `--home` is a usage error, not a request to
  scan `$HOME/.dsh` or a folder named after the next flag. A process-boundary
  test spawns the shipped CLI for all three missing spellings and requires exit
  `2` with no report, then runs the same binary against a checked-in clean home
  and requires exit `0` with its `clean-plugin` row, so the refusal cannot pass
  by breaking every scan.

## 0.20.21

- **`doctor --fix --write` repairs a manifest saved with a UTF-8 BOM.** `doctor`
  read the BOM away, but the repair write re-read the raw file with `JSON.parse`,
  so it printed the planned `engines.dsh` edit and then failed with a bare
  `Unexpected token` on the same manifest it had just accepted. Both repair
  entry points (`doctor --fix` and `fix --engines`) now read through `doctor`'s
  one BOM-aware manifest source, keep the existing indentation and line endings,
  and write through one shared helper that starts from the BOM-stripped source,
  so the rewritten file has no BOM (not a doubled one) and is valid JSON. A
  write failure is now reported as a `manifest` failure by both commands instead
  of escaping from `fix --engines`. Four process-level tests run the literal
  `doctor . --fix --write` and `fix . --engines --write` from a temp plugin with
  no `engines.dsh`: both repair a BOM copy and a no-BOM control, and both
  normalize a doubled BOM without adding another one.

## 0.20.20

- **A repeated `release --pr` is a no-op when the committed index already
  carries the version.** The resume path noticed that the same version with the
  same publish time needed no index write, but it still entered the PR
  sequence; `git commit` then failed because there was nothing staged, and the
  run stopped with a `market/<version>` branch left behind. An unchanged index
  that is already committed now ends the release after the registry wait: it
  prints `<index> already carried <version>; nothing to commit`, exits `0`,
  leaves `git log -1` alone, and creates no branch even with `--pr` or
  `--merge`. An entry that an earlier run without `--pr` wrote but did not
  commit still goes through the branch and PR so the release is finished. A
  different publish time still stops with both timestamps named. Three
  consecutive CLI runs now assert exit `0` and an unchanged `git log -1`, and a
  checked-in one-second-mismatch fixture pins the failure through the CLI as
  well: exit `1`, both timestamps in the error, and no `market/<version>`
  branch.

## 0.20.19

- **`audit --home` expands `~` and `~\` before the scan, and a bare flag is
  refused.** The local audit resolves its home like every other user-named
  path, so `audit --home '~/.dsh'` and `audit --home '~\.dsh'` read
  `$HOME/.dsh` on cmd and PowerShell instead of a folder literally named `~`.
  A checked-in home with one declared plugin whose `dsh.bundle.patch` names
  `./missing.yml` now pins both spellings through the shipped CLI: each prints
  the `broken` row, names the missing patch, exits `1`, and leaves no `~`
  directory in the working folder; the absolute-path control exits `1` with the
  same row. `--home` with no value exits `2` and says what it needs, rather
  than scanning the current folder and reporting "no plugins installed" with
  exit `0`. `--help` documents the flag.

## 0.20.18

- **`verify` resolves the installed root the way the loader does.** It used to
  import the file `main` named, so a tarball whose `exports` map had no `.`
  entry passed `verify --no-mount` even though `import("<name>")` failed with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`. The installed copy is now imported by its
  bare package name from a probe module beside it, so Node's own `exports`
  resolution decides. The missing `.` entry is reported as a `root export`
  failure and the command exits `1`; the same fixture with `exports["."]` exits
  `0` and prints `imported its host half`. A package that declares neither
  `exports` nor `main` still has no root module to import, so its success line
  keeps saying the host import was skipped. Two checked-in fixtures
  (`test/fixtures/verify-exports-no-dot` and `verify-exports-dot`) now pin both
  sides through the shipped CLI process, including the exit code, so `npm test`
  fails if the no-`.` tarball ever exits `0` again. The README states that the
  bare specifier, not a file path, is what `verify` imports.

## 0.20.17

- **`audit` reports a declared bundle whose folder is gone.** When a package
  name stayed in `dsh.profile.bundles` but its `node_modules/<name>` folder had
  been removed, the install scan never saw the package and `audit --home`
  printed only its healthy siblings, so the command exited `0` and hid the
  reason the loader could not mount it. The scan now starts from the profile's
  declared bundles and prints a `missing` row with an `install` failure naming
  the absent `node_modules/<name>` path; the valid siblings are still listed
  and the command exits `1`. A package that is absent but undeclared is still
  ignored, so ordinary dependencies do not appear. A regression test pins the
  module result and the spawned CLI exit code in both directions: the declared
  missing bundle exits `1`, and the same home with the name removed from the
  profile exits `0` without printing it. A checked-in home at
  `test/fixtures/missing-declared-bundle` also keeps the minimal case — one
  declared name and no `node_modules` directory at all — reproducible through
  `audit --home`, so the scan cannot fall back to "nothing installed" and exit
  clean again.

## 0.20.16

- **`doctor` names a root export that cannot be loaded.** A package whose
  `exports["."]` (or `main`) named a missing file printed `ok` and exited `0`,
  while the same package would fail when the loader imported it; a target that
  was a directory crashed `doctor` with a raw `EISDIR` from `readFileSync`. The
  `root export` check now asks the filesystem what the resolved path is and
  reports a missing file, a directory, or an unreadable file as a named failure
  before reading source. `verify --no-mount` stops at that same `doctor` check
  instead of reaching pack or install. Four fixtures pin the behavior through
  the shipped CLI: a string root, an `exports["."]` string and a conditions
  object naming `missing.js`, and an export naming the `lib` directory all exit
  `1` with a `root export:` line naming the target and no raw `EISDIR`, and
  `verify --no-mount` on the same fixtures exits `1` at `stopped at doctor`
  without a `pack:` failure, while the unmodified `init` scaffold still passes
  both commands.

## 0.20.15

- **A strict comparison against a wildcard major matches nothing.** `audit
  --remote <owner/repo> --host <version>` treated `>*`, `>x`, `<*` and `<x` as
  "any version" and called every host compatible, while npm reads them as an
  empty set that no release satisfies. The host-range parser now reports
  `incompatible` for those spellings; the inclusive `>=*` and `<=*` forms still
  span every stable host. Regression tests pin the parser, the printed CLI
  verdict and the `--json` row, including the major-only `>1`/`<=1` boundary:
  `>1` rejects 1.2.3 and `<=1` accepts it, in both the text line and
  `compatibility`.

## 0.20.14

- **The `--jobs` benchmark asserts work, not wall-clock speed.** The throughput
  test used to fail whenever the batched run was not at least 25% faster, which
  is noise when the whole measurement is tens of milliseconds on a loaded
  runner. It now checks what batching actually guarantees: the same named
  results and the same number of API requests at `--jobs 1` and the default
  width, no overlap at `--jobs 1`, and real overlap (never above the requested
  width) after batching. The benchmark still prints before/after wall clock and
  the speedup as context, but no assertion depends on them, so a slow machine
  can no longer block the publish gate.
- **`npm run benchmark -- --latency` reaches the measured run.** The script
  parsed the flag into `latency` while `runBenchmark` reads `latencyMs`, so the
  option was accepted and ignored and every run used the default 500 ms. Both
  names now agree, and a regression test runs the shipped script with
  `--limit 1 --latency 1` and checks the printed delay.
- **`doctor` reads the root export from code, not from prose.** A root module
  whose only `apply` was inside a comment, string, template or regex literal
  used to pass the `root export` check, while `verify --no-mount` rejected the
  installed package. The check now removes those non-code spans, without
  importing or running the plugin, and accepts only a real exported `apply`:
  `export function apply`, `export const apply = ...`, `export { apply }` and
  the CommonJS `module.exports` forms still pass, while
  `// TODO: export function apply() {}` is a failure. The same helper backs
  `doctor --remote`, so the checkout and the published repository agree.
- **`doctor` and `verify --no-mount` are pinned to one root-export verdict at
  the process boundary.** A regression test spawns the shipped CLI on the
  comment-only fixture and requires both commands to exit `1`, so the source
  parser and the installed import cannot disagree again. The README and
  `docs/repair.md` now state the exact rule: the resolved root is read as
  source, comments and string/template/regex contents are removed, and only a
  real `export function apply`, `export const apply = ...` (also `let` and
  `var`), `export { apply }` (including aliases), `exports.apply = ...` or
  `module.exports = { apply }` passes.

## 0.20.13

- **The compatibility sample says which snapshot it answers for.** The README
  now names the eight reports behind "will this plugin install on my DSH?" and
  states that the quoted `incompatible` line comes from the frozen 0.1.3 sample
  under `examples/compatibility-sample/`, not from whatever the upstream
  repository's default branch contains today. The sample README explains why it
  keeps a `## Requirements` heading even though the upstream README is
  localized: it isolates the host-range verdict, while a live audit also runs
  the README check and can add a `readme` failure to the same row.
- **A leading `~` expands in every user-named path, not just `--log`.** On
  `cmd` and PowerShell the shell leaves the tilde literal, so
  `init '~/my-panel' --name my-panel` used to create a directory literally
  named `~` in the current folder, and `doctor '~/my-panel'` then looked in
  the same wrong place. Both the CLI and the exported `init`/`doctor`/`fix`/
  `verify`/`dev`/`release` functions now expand `~/` and `~\` before any
  filesystem access, as do `--home`, `--market`, `--dest`, `--from`,
  `--patch-dir`, `--patch`, `--log` and `--index`. The scaffold lands in
  `$HOME/my-panel`, `doctor` exits `0` on it, and no literal `~` folder is
  created.
- **Major-only comparator ranges get npm's boundaries.** `audit --remote
  <owner/repo> --host <version>` filled a missing minor with 0 before deciding
  the edge of `<=1`, `>1` and hyphen ranges such as `1.2.3 - 2`, so it called
  1.2.3 compatible with `<=1` and incompatible with `>1` — the reverse of what
  the installer does. The same answer is used by `doctor --remote`, `--json`
  and `--patch-dir`. The older `~>` spelling of `~` is now parsed too, instead
  of being reported as unknown. Regression tests pin all four forms against npm
  semver.
- **`doctor --remote` reads the README the way a checkout does.** A published
  repository whose README has no `## Requirements` heading, or whose
  Requirements section omits the `engines.dsh` range it declares, used to print
  `ok` and exit `0`, while the same checkout failed the `readme` check. The
  remote audit now reports that failure and exits `1`; `audit --remote` shares
  the check, so both the single-repository and `--from` batch forms print the
  `failing` row and carry its `readme` failure in the `--json` finding. A README
  that states the declared range still exits `0`.
- **`dsh-plugin doctor` checks the package name before it packs anything.** A
  `package.json` whose `name` is missing, empty, or not a valid npm package name
  (for example `My Plugin!`) used to print `ok` and exit `0`, while
  `verify --no-mount` failed later at `npm pack`. The manifest preflight now
  reports a `name:` failure and exits `1`, and the same check reaches
  `doctor --remote` and `audit --remote` through the shared manifest check.
  `init` uses the same validator, so a scaffold's name and the check that blesses
  it stay in step. `npm test` pins the result through the shipped CLI: missing,
  empty and malformed names all exit `1` (`accepted=0/3`), while a valid plain or
  scoped name exits `0`.
- **`doctor --remote` runs the same `dsh` field check as local `doctor`.** A
  repository whose `package.json` has `dsh: {}` and no `dsh.bundle.patch` used
  to print `ok` and exit `0`, because the remote file checks only looked for a
  patch that was declared. It now reports `dsh field: dsh.bundle is missing` and
  exits `1`; the failure is also carried into `audit --remote`, and a clean
  repository still exits `0`.
- **`fix --remote` can aim the range at the host that rejected the install.**
  `fix <owner>/<repo> --remote --engines --host 0.3.0 --patch repair.patch`
  plans the same `>=0.3.0 <1.0.0` range that `fix . --engines --host 0.3.0
  --write` writes in a checkout. The remote planner and the local writer share
  one decision, so the patch both accepts the host and rejects the next major,
  prints why, and a non-semver `--host` exits `2` before creating a patch file.
- **`release` refuses a bad host range instead of throwing at the index step.**
  A malformed `engines.dsh` that reached the market-entry builder used to escape
  as an exception, outside the normal `{ ok: false, stage, failures }` result.
  `release` now reports that problem in the `index` stage and writes nothing; a
  manifest with the same bad range is already stopped by the preflight, so the
  command returns before a tag is created. The regression test checks that the
  index file is byte-for-byte unchanged and that the registry is never called.

## 0.20.12

- **`dsh-plugin fix <owner>/<repo> --remote` treats an already-correct range as
  success.** When `package.json` already declares an `engines.dsh` range that
  clears the check, the command still prints `ok engines.dsh is already
  "<range>"; nothing to apply` but now exits `0` instead of `1`, matching the
  local `fix --engines` no-op and the documented exit-code contract. No diff or
  patch file is written.
- **The remote repair keeps its diff and error paths.** A manifest with no
  `engines.dsh` still prints the unified diff and exits `0`; an invalid target
  and a network or HTTP read failure still exit `2`; and the command writes no
  local file unless `--patch` asks for one. Regression tests pin those paths
  beside the already-correct no-op.
- **The remote repair exit codes are covered at the process boundary.** `npm
  test` now spawns the real CLI for a remote manifest that is missing
  `engines.dsh` and one that already declares a valid range, asserting exit
  `0` for both. The README Exit codes table states the same contract.
- **A malformed `package.json` in an ordinary dependency still stays out of
  `audit`.** The unreadable-manifest exception only applies when the package
  name is in `dsh.profile.bundles`; a package that is neither declared there nor
  readable enough to expose its `dsh` field is skipped as before, so a broken
  transitive install does not turn every audit red.
- **A declared plugin with an unreadable `package.json` no longer disappears
  from `audit`.** When an interrupted install leaves a truncated manifest, the
  `dsh` field that marks the package as a plugin cannot be read. If the package
  name is still listed in `dsh.profile.bundles`, `audit` now reports a
  `manifest` failure naming the unreadable `package.json` and exits `1` instead
  of skipping the folder as an ordinary dependency. Valid sibling plugins on the
  same run are still listed.

## 0.20.11

- **`audit --remote --from` carries the `--host` answer through the whole
  batch.** Each repository is compared with the host you name even when
  `--jobs` runs several audits at once, so the printed verdict and the `--json`
  row carry the same `host` and `compatibility` fields, in input order,
  whatever order the responses arrive in. With `--patch-dir`, a host-targeted
  repair is written for a valid range that excludes the host, while a
  repository that already accepts it is skipped.
- **The batch host mode is documented where the batch commands are.** `--help`
  shows the `audit --remote --from <file> --host <version>` form, and the
  README and repair guide explain that npm's pre-release rule applies — for
  example, `>=0.2.0` does not accept `0.2.2-alpha.3` unless the range names a
  pre-release of that same version. The semver edge cases are pinned by
  regression tests.

## 0.20.10

- **`expectSnapshot()` writes the baseline when `UPDATE_SNAPSHOTS=1`.** The
  documented rerun now writes the normalised HTML and returns
  `{ status: "written" }` instead of failing with the same missing-baseline
  error. Without the variable, a missing or changed baseline still fails, so a
  snapshot is never written as a side effect of an ordinary test run.
  `panel.snapshot()` shares the same contract and names the same flag when the
  baseline is missing.

## 0.20.9

- **`dsh-plugin doctor` and `verify --no-mount` resolve a root export written as
  a conditions object.** `exports["."]` can be a string or a conditions object
  such as `{ "import": "./cli.mjs" }`; the loader still imports that target. It
  used to be treated as "no root export", so a plugin whose conditions object
  resolved to a CLI with no `apply` passed both checks. The failure now names
  the resolved file, and a string root that exports `apply` still passes.
- **`verify --no-mount` no longer claims it imported a host half when it
  skipped one.** A bundle that only inserts a subpath patch needs no root
  module, so there is nothing for the loader to import. The success line used
  to say "installed the tarball and imported its host half" anyway; it now says
  the host import was skipped, so the line matches the check that actually ran.
- **`dsh-plugin explain --log` covers the Windows spelling of `~` and keeps a
  missing log honest.** `~\.dsh\logs\install.log` expands the same way as
  `~/.dsh/logs/install.log`, so the documented command works in PowerShell and
  `cmd`; a log that cannot be read still exits `2` with the resolved absolute
  path it tried, never a directory literally named `~`.

## 0.20.8

- **`dsh-plugin release` resumes when the tag already points at HEAD.** A
  publish that stopped after the tag was pushed — at the registry wait, or at a
  later failure — can be re-run: the existing `plugin-v<version>` tag is reused
  rather than recreated, and the release continues with the registry wait and
  the index write. Because a resume creates no tag, the index entry left by the
  previous attempt may be the only uncommitted change and does not block it.
- **`dsh-plugin release` refuses a tag at another commit and prints the
  recovery.** When `plugin-v<version>` exists but points somewhere other than
  HEAD, the release exits `1` with the tag, the commit it points at, HEAD, and
  the exact `git tag -d` and `git push --delete` commands that remove the stale
  tag before a re-run.

## 0.20.7

- **`dsh-plugin release --budget` rejects a value that is not a positive
  number of seconds.** `--budget 8m`, `--budget 0`, `--budget -1` and a
  missing value now stop during flag parsing with `--budget needs a positive
  number of seconds`, exit `2`, and create neither a local nor a remote tag,
  instead of pushing the tag and then waiting on a nonsensical interval. A
  positive value still reaches the registry wait.

## 0.20.6

- **`dsh-plugin doctor` reads `files` globs the way `npm pack` does.** A
  `"files": ["*.js"]` entry covers root-level JavaScript only, so a nested
  `exports["./client"]` at `lib/client.js` now fails the files-list check with
  that path named instead of passing `doctor` and disappearing from the tarball.
  `lib/*.js`, `lib/*` and `lib/**` keep their npm meanings.
- **The remote audit applies that same files-list check.** A repository whose
  `"files": ["*.js"]` leaves its `exports["./client"]` out of the tarball now
  produces a `files list` finding from `doctor --remote` and `audit --remote`,
  and the audit exits 1 instead of printing `clean`.

## 0.20.5

- **`dsh-plugin doctor` reads a `package.json` saved with a UTF-8 BOM.**
  Notepad and some VS Code configurations write one; the manifest reader now
  strips it instead of failing with a bare `Unexpected token`. A manifest that
  is genuinely broken fails with `<path>/package.json is not valid JSON: …`,
  naming the file and the parse error so the user knows what to fix.
- **`dsh-plugin init --title` escapes `/` in the generated
  `test/panel.test.mjs`.** A title such as `Input/Output panel` is written into
  the generated assertion as one regex literal, so the scaffold's test parses
  and `init --title "Input/Output panel"` produces a plugin whose own `npm test`
  passes. The other title characters keep their previous escaping.

## 0.20.4

- **`dsh-plugin verify` removes its scratch install directory.** The temporary
  directory used to pack and install the tarball is deleted in a `finally`, so a
  passing run and one that stops at install or mount no longer leave a
  `dsh-plugin-verify-*` tree under `TMPDIR`; repeated CI runs no longer fill the
  runner's disk.

## 0.20.3

- **`dsh-plugin doctor` reads `engines.dsh` with the package's own semver
  parser.** A malformed value such as `>=banana`, or a complete version pinned
  to one release such as `0.2.0`, is reported as "not a semver range" instead
  of passing the check. Partial versions (`0.2`, `0.2.x`), wildcards and
  multi-comparator ranges such as `>=0.3.0 <0.4.0` still name a span and keep
  their previous verdict; the valid-range path is covered by a regression test.
- **`dsh-plugin index` rejects a version whose `engines.dsh` is not a semver
  range.** The market audit now applies the same rule to every entry, so a
  malformed value such as `>=banana` and a pin such as `0.2.0` fail the command
  with exit `1` instead of printing `ok`; `buildEntry` refuses to create such an
  entry. `audit --remote` keeps the parser's "not a semver range" message rather
  than calling every engine failure a missing field, and `fix --engines --range
  '>=banana' --write` refuses the value without touching `package.json`.
- **The `audit --remote --from` summary counts failed checks instead of failing
  repositories.** A repository that fails both `engines.dsh` and its client
  declaration now prints `1 failing (2 problems)`, while a repository with one
  failure still prints `(1 problem)`; the JSON finding shape is unchanged.

## 0.20.2

- **`dsh-plugin init` writes a YAML-safe patch id.** A scoped package name such
  as `@me/my-panel` is quoted in `cordis.patch.yml`, so the file parses instead
  of failing on `id: @me/my-panel`; an id like `123` stays a string rather than
  becoming a number. Ruby/Psych parses the generated patch for scoped,
  unscoped and numeric-like names, and `insert[0].id` is the exact name.
- **`dsh-plugin verify` names a bundle patch the tarball would omit before
  installing it.** `dsh.bundle.patch` is recognized whether it is written
  `./cordis.patch.yml` or `cordis.patch.yml`, so a `files` list that leaves the
  patch out makes `verify --no-mount` stop at `pack` and exit `1` with
  `cordis.patch.yml` named, instead of spending an install on a plugin that
  cannot load. A scaffold that ships its patch still exits `0`.

## 0.20.1

- **`dsh-plugin init --title` escapes the title in every generated JavaScript
  file.** An apostrophe, backslash, newline or regular-expression character no
  longer breaks the scaffold: `init --title "Bob's panel"` writes a `client.js`
  and `test/panel.test.mjs` that pass `node --check`, and the scaffold's own
  `npm test` passes.

## 0.20.0

- **The README answers "will this plugin install on my DSH?" with a real
  incompatible plugin and its real output.** The new section runs
  `audit --remote L3n3L/dsh-resume --host 0.2.2-alpha.3`, shows the
  `incompatible` verdict and the range that caused it, and points at
  `scripts/compatibility-sample.mjs`, which replays the checked-in manifest
  through the same CLI path without a GitHub request. A test compares that
  output with the README and fails if the section names a flag the CLI does not
  document.
- **The tarball ships the throughput benchmark the README cites.**
  `scripts/benchmark-audit.mjs` and the 3 November list it reads are now in
  `files`, so `npm run benchmark` runs in an installed copy instead of exiting
  with `MODULE_NOT_FOUND`. A test packs the package, installs the tarball into a
  temp directory and runs the documented command there.
- **`dsh-plugin fix --host <version>` aims the `engines.dsh` repair at the DSH
  that rejected the install.** The proposed range includes that host and stops
  before the next major — `fix --remote <owner/repo> --engines --host 0.3.0`
  plans `>=0.3.0 <1.0.0` and prints why, and `--write` applies the same range in
  a local checkout. Naming a host is an explicit request, so a valid but too
  broad range is replaced; without `--host` the existing default and the
  leave-a-valid-range-alone rule are unchanged. `audit --remote --host
  --patch-dir` writes the host-targeted repair too, and an invalid host is
  refused rather than guessed at.
- **`dsh-plugin audit --remote <owner/repo> --host <version>` says whether the
  plugin will install on the DSH you run.** The line carries the range
  `package.json` declares and one of `compatible`, `incompatible` or `unknown`
  against the host version; `--json` findings add `host` and `compatibility`
  beside `hostRange`. A missing or malformed range is `unknown`, and a range
  that excludes the host is `incompatible`, fails the audit and exits `1`. The
  same answer prints in the `--from` batch mode, and range matching follows npm
  semver, including the pre-release rule behind the canary install failures.

## 0.19.0

- **A rate-limited batch audit stops and says so.** When GitHub answers `403`
  or `429` for any read, the audit stops starting new repositories and reports
  every entry it could not read as `rate-limited`, never as `clean` or
  `unreadable`. The reset time from `x-ratelimit-reset` (or `retry-after`) is
  printed in the verdict, `--json` findings carry `rateLimited: true` with a
  `rateLimit` object, and the summary counts them separately, so one exhausted
  quota no longer spends the rest of the list on identical failures.
- **`dsh-plugin audit --remote --from <file> --jobs <n>` reads several
  repositories at once.** The default is four, the hard ceiling is eight, and a
  value above the ceiling is capped rather than turned into a burst of GitHub
  requests. Output and `--json` findings keep the input order, and every verdict
  matches the sequential run; `--jobs 1` restores the old one-at-a-time timing.
  A non-numeric, zero or missing value is refused with exit `2` instead of
  quietly becoming the default.
- **The README records the measured batch throughput.** The first eight
  repositories from the 3 November install-failure list are replayed through a
  fixed-latency harness, so the measurement is reproducible instead of
  depending on GitHub's response time: 1.003 s per repository with `--jobs 1`
  and 0.251 s with the default `--jobs 4`. `npm run benchmark` runs the same
  list again, and a test reads the README table to keep it tied to the default
  `--jobs` value.

## 0.18.1

- **A `~` at the start of `--patch`, `--patch-dir` or `--from` expands to your
  home directory.** The documented example is `--patch ~/repair.patch`, and on
  Windows `cmd`/PowerShell leave the tilde alone, so the file was written to a
  directory literally named `~` inside the current working directory. Both
  `~/x` and the Windows spelling `~\x` now resolve to the same place, `~` on
  its own is the home directory, and paths without a leading tilde are left
  exactly as written. Found while auditing the batch commands on a Windows
  shell; the tests cover both separator spellings.

## 0.18.0

- **`dsh-plugin audit --remote --from <file>` audits the whole list at once.**
  It reads one `owner/repo` per line (or `-` for standard input), asks the
  read-only GitHub contents API about every entry, and prints one line per
  repository with its verdict: `clean`, `failing`, or `unreadable`. A counted
  summary follows, `--json` still prints the existing finding array, and the
  command exits `1` when anything is failing or unreadable and `0` only when
  every repository is clean. A repository GitHub could not read is reported as
  unreadable instead of being counted as a pass, and the same `--from` accepts
  the JSON evidence shape (an array, or an object with `rows`) that the old
  shell loop printed.
- **`dsh-plugin audit --remote --from <file> --patch-dir <dir>` writes the
  repairs, one file per repository.** The directory is created even when there
  is nothing to fix, each patch is named `owner__repo.patch`, and only a
  repository with a failing `engines.dsh` gets a file; clean and unreadable
  repositories leave none. The diff is the one `fix --remote --patch` would
  write, it reuses the `package.json` the audit already read, and the remote is
  still read-only. `--force` replaces an existing patch.
- **The README shows the batch audit on the 3 November install-failure list.**
  The list itself is checked in at `docs/ecosystem-audit-2026-11-03.txt`; the
  README runs one command over it, pastes the real per-repository output and
  summary, and shows a maintainer how to clone one of the named repositories
  and apply its generated patch with `git apply --check` and `git apply`.

## 0.17.0

- **`dsh-plugin fix <owner>/<repo> --remote` prints the `engines.dsh` repair
  for a repository you have not cloned.** It reads `package.json` through the
  GitHub API and shows the edit the local fixer would make as a unified diff;
  the only GitHub request is a read-only GET, and nothing is written. The
  target may come before or after `--remote`, and `--write` is refused because
  the repository is remote.
- **`dsh-plugin fix <owner>/<repo> --remote --patch <file>` saves that diff for
  a checkout.** Parent directories are created, the printed path names where
  it landed, and an existing file is left alone unless `--force` is passed.
  `--dry-run` reports the path without writing it. The repository itself is
  still never modified.
- **The README documents the remote repair loop.** A new *Repair a repository
  you have not cloned* section walks from `doctor --remote` through
  `fix --remote`, `--patch`, `git apply --check` and `doctor .`; `docs/repair.md`
  links the same flow.

## 0.16.0

- **`dsh-plugin doctor --fix <dir>` turns the failing checks into a repair
  plan.** It prints one line per failed check naming the file and the edit it
  would make, writes nothing unless `--write` is passed, applies exactly the
  planned edits, and runs `doctor` again to report what remains. A missing or
  non-range `engines.dsh` is the automatic edit; checks that need real file
  contents (a patch file, a client bundle, a root export) stay visible as
  `manual:` lines instead of being guessed. `--range` chooses the host range and
  `--dry-run` wins over `--write`. The existing `fix --engines` command is
  unchanged.
- **`dsh-plugin audit --remote owner/repo,owner/repo --json` audits a list and
  prints one machine-readable object per repository.** Each object carries
  `target`, `version`, `hostRange`, `failures` (`{ check, message }`) and
  `notes`; the command exits `1` as soon as any repository has a failure. A
  rate-limited or otherwise unreadable request becomes a note and still exits
  `1`, so a repository the tool could not read is never mistaken for a clean
  one. `--remote` also accepts repeated flags, and without `--json` the same
  findings print as the human lines `doctor --remote` already uses.
- **`docs/repair.md` is a repair guide with one section per `doctor` check.** It
  shows the exact line each check prints, what the check protects and the
  smallest edit that clears it, and the README links it from *When an install
  fails*. The loop starts with `doctor --fix . --write` for the automatic
  `engines.dsh` edit and ends when `doctor` exits `0`.
- **The README now says where a write can come from.** `doctor` on its own stays
  read-only and its checks are unchanged; `fix` and `doctor --fix` change the
  manifest only when `--write` is passed.
- **Published as `dsh-plugin-toolkit@0.16.0`.** The release tag is
  `plugin-v0.16.0`, and the registry serves that version.

## 0.15.0

- **`dsh-plugin fix <dir> --engines` writes the host range `doctor` asks for.**
  Most of the plugins the hub reports as failing to install have no
  `engines.dsh` at all, and `doctor` could only name the missing field. The new
  command prints the range it would write and leaves `package.json` untouched
  unless `--write` is passed; a missing or non-range value becomes `>=0.2.0`,
  while a range that already passes the check is left alone. `--range` asks for
  a different range explicitly. `doctor` is unchanged.

## 0.14.0

- `dsh-plugin doctor --remote owner/repo` audits a published plugin through the
  GitHub API — no clone, no install. It reports the same manifest problems the
  installer trips over, in the words the installer uses (`engines.dsh is
  missing, so a host that enforces the range rejects the install as
  "incompatible with dsh"`), because the plugin hub's failure reports name a
  symptom and never a file. Packages that build before they pack get their
  file-level checks marked skipped, not failed.
- `files` entries that name a folder (`"lib"`) now ship everything below it, as
  npm does; before, `lib/index.js` was reported as missing.
- `files` no longer has to mention `package.json`, the README, the LICENSE, the
  CHANGELOG or the `main` file: npm puts those in the tarball whatever `files`
  says, so flagging them was a false alarm.

## 0.13.13

- **`explain --log <file>` reads the log the hub points at.** A report names
  `~/.dsh/logs/…` instead of a pasteable sentence, so the reader had to open the
  file first. `--log` scans it from the bottom, explains the last line that
  matches a known cause, and prints the same cause, check and fix as pasted
  text. A log with no known cause exits 2 and lists what it looked for; a file
  that cannot be read exits 2 with its path.

## 0.13.12

- **`explain` maps a pasted install error to the check that finds its cause.**
  A plugin hub files failed installs back into each plugin's repository; 61
  repositories were carrying those reports on 2026-11-02, and every one opens
  with one of four sentences that name no file. `dsh-plugin explain "<error>"`
  prints the cause, the `doctor` check that verifies it and the fix; given a
  checkout it runs that check and reports whether it actually fails. Unknown
  text exits 2 rather than guessing.
- **The publish job names the tarball as a path, not as a GitHub shorthand.**
  `npm publish dist/*.tgz` resolved to `ssh://git@github.com/dist/…tgz.git` and
  died with `Permission denied (publickey)` after the artifact had downloaded
  correctly; `npm publish ./dist/*.tgz` is the same file read as a path. A step
  now fails loudly if `dist` does not hold exactly one tarball.
- **The publish guard test states the tag it is testing.** It inherited
  `GITHUB_REF_NAME` from the workflow, so it passed on pull requests and failed
  on the release tag it exists to protect — the tag run exported
  `plugin-v0.13.12` while the scratch manifest said `99.99.99`.

## 0.13.11

- `--home` is readable again: the flag reader named the wrong variable, so `dsh-plugin audit --home <dir>` failed with `args is not defined` before it ran.

## 0.13.10

- **`audit` now says why a plugin is not loaded.** One line covered three
  different causes: the package is not in the profile's `dsh.profile.bundles`
  (the loader mounts only listed bundles), it declares no `dsh.bundle` so there
  is nothing to mount, or the running app predates the install. Only the last
  one is a restart, and the first one cost this project hours.
- **A plugin the app never loaded now fails the exit code.** `audit` returned
  `ok` for a profile the running app had not picked up, so no script could gate
  on it. It still exits 0 when no graph was read, because then it observed
  nothing.

## 0.13.9

- **The README's own image was missing.** Both READMEs open with
  `docs/card.png`, which was never committed — this repository ignores `*.png`,
  and the card was the one asset that never got `git add -f`. The image now
  exists (1200x630), and `npm pack` ships it.
- **The DeepSeek Harness link was a 404.** `github.com/deepseek-ai/dsh` does not
  exist; the repository is `deepseek-ai/deepseek-harness`.

## 0.13.8

- **A screenshot of the panel** (`docs/panel.png`), taken from the preview render
  of a plugin that fails two checks, in both READMEs under a new *The panel*
  section. The card at the top of the README shows the CLI; the panel had no
  picture of its own.

## 0.13.7

- **`docs/pipeline.svg`**: the five steps `verify` runs, in order, with the
  failure each one catches and the two that only a running host shows. Linked
  from both READMEs under a new *What `verify` actually does* section.

## 0.13.6

- **The dock no longer leaves half the composer blank.** Its content stopped at
  `76ch` and was pinned to the left, so on a wide window the panel looked
  broken: a form in the left third and nothing beside it. The content is now one
  column of `760px`, centred, with equal margins — and the guide uses the width
  it does have as two columns, with the check table spanning both.
- The header (title, language switch, chevron) lines up with that column instead
  of sitting at the far right of the window.
- `scripts/preview.mjs` renders at the real conversation width (1120px), which
  is how this was found: at 720px the old layout looked fine.

## 0.13.5

- **A wildcard export no longer fails the pack check.** `exports` can name a
  pattern (`"./locale/*.json"`), while `npm pack` lists the files it shipped
  (`locale/en.json`). Comparing them as strings reported a correctly packed
  plugin as broken; the check now matches patterns by prefix and suffix.
- Found by running `verify` against the neighbour project's plugin, which ships
  exactly that export.

## 0.13.4

- **`docs/why-it-exists.md`**: the five failures that shaped these checks, each
  with the exact error text, the root cause, the check that catches it now, and
  how to reproduce it. Linked from both READMEs.
- **A release for the GitHub Action** (`v1.0.0`), so the action can be published
  to the Marketplace.

## 0.13.3

- **`verify` no longer fails a correct plugin.** The check that calls a client
  module's `apply()` before its services exist handed it `{}`, so
  `ctx.inject(...)` — the cordis API every plugin uses — threw
  `ctx.inject is not a function` and the plugin was reported as broken. The
  probe now models a real context: `inject`, `on`, `effect`, `logger`, `get`,
  `set` and `provide` exist; only the services are absent.
- Found by this repository's own example plugin, whose CI went red on the
  previous release. That is the whole point of the example.

## 0.13.2

- **A table of the four ways a plugin installs and still does nothing** — red
  dot with no panel, a row the host drops, an app that disables every plugin
  after one unguarded `apply()`, and a tab type nothing can open. Each row is a
  bug this toolkit shipped and then learned to catch, and each row names the
  check that catches it now.
- Both READMEs. Nothing in the code changed.

## 0.13.1

- **A badge you can put on a plugin that passes.** `docs/badge.svg` plus the
  snippet in both READMEs. It is a claim, not a decoration: the README says to
  add it only when `verify` exits 0.
- **Every scaffolded plugin links back.** `init` now writes the badge into the
  generated README, so a plugin created with the toolkit advertises the toolkit
  it was checked with.
- **README badges** for version, downloads, CI and license, and the repository
  homepage now points at the npm page.

## 0.13.0

Three more rounds of the panel, and one new thing to point it at.

- **The language switch is a real segmented control.** It used to be a bordered
  box with `overflow: hidden` and a filled button inside it: the fill was clipped
  by the container's radius and the 0.5px border left a hairline of background
  along two edges, which read as a missing colour block. Now the track is inset
  and the selected pill is its own rounded shape, so the fill is complete at
  every size and in both themes.
- **A repository name is enough.** The input takes a folder, `owner/repo`, or a
  GitHub URL. A bare name searches GitHub, lists the matches with their stars
  and descriptions, and checks the one you click — the picked repository is
  fetched as a tarball into a temp folder, so nothing is cloned and nothing is
  installed. Results name the repository and link to it instead of showing a
  temp path.
- **Candidates are a list you can act on.** Owner is muted, the repository name
  carries the weight, an arrow appears on the row, and the rows are keyboard
  reachable with a visible focus ring.
- **The guide says what changed.** The "before you trust it" note no longer
  claims there are no network calls: a local folder is still read-only, a
  repository is downloaded once, and the note now says so.

## 0.12.0

Five rounds of the panel's own UI, each one driven by looking at the rendered
thing rather than at the code.

- **The tool comes before the guide.** The input, the button and the result now
  sit directly under the header, and the guide moved below a rule into a
  foldable `使用说明`. It used to take a screen and a half of scrolling to reach
  the one control the panel exists for. The docked body is capped at `76ch`, and
  the language switch no longer wraps onto its own line in the sidebar tab.
- **Results answer first.** A summary bar states the verdict and the counts
  (`3 项里 1 项没过`), the checked folder is shown in monospace, failures come
  first with a tinted row and a left rule, and the passing checks fold into
  `<details>` — closed when something failed, open when everything passed.
- **No state renders as nothing.** Before the first check the panel says what to
  do; while a check runs the region is `aria-busy`; a request that never reaches
  the host still shows the folder it was asked about.
- **Keyboard and screen reader.** `Escape` closes the dock from anywhere inside
  it, the toggle carries `aria-controls`, and focus moves to the verdict when a
  check lands, so the answer is announced instead of the input keeping focus.
- **The outcome survives collapsing.** A chip in the collapsed row reads
  `1 项没过` / `通过`, so the result is visible without opening the panel again.
- `scripts/preview.mjs` renders the panel — collapsed, open, with a result, and
  the sidebar tab — to one static HTML file, using the same testkit the tests
  use. That is how these five rounds were reviewed; it reads the stylesheet from
  the injected `<style>`, because a regex over the source truncates at the first
  `;` inside a CSS string.
- Fixed in the testkit: passing both `host` and `fetch` to `mountClient` used to
  ignore the stub, so every request answered 404 and the failure looked like the
  panel's fault.

## 0.11.0

- **A language switch, in the panel.** 中文 / EN sits in the dock's header row and
  in the sidebar tab, opens in Chinese (the audience this plugin is written for),
  and remembers the choice in `localStorage` under `dsh-plugin-toolkit:lang`. The
  panel no longer follows the host's language silently: the app can be in English
  while the person reading it is not.
- `useLang()` is a tiny subscription store, so the dock, the tab and the tab
  type's `title()` all switch together.
- **The testkit hands a bundle the real `window`.** `loadBundle` used to pass a
  stand-in that carried only `__ModuleLoader__`, so `window.localStorage` was
  `undefined` and any preference silently failed to save. That bug was found by
  this feature failing its own persistence assertion.
- Fixed invalid markup: the switch was nested inside the dock's toggle button.
  React warns and drops the inner button, so it now sits beside it.

## 0.10.0

- **The checker is docked under the conversation.** It used to live only in the
  right sidebar, behind a guide list nobody opens; now it sits above the input
  bar as one collapsed row, and opens into the full guide: who it is for, how to
  use it, what each check catches, and the caveats (read-only, folder not
  profile, advisory vs hard, runtime behaviour is not provable).
- The dock and the sidebar tab share one `useChecker()` hook and one `Form` /
  `Result` pair, so the two cannot drift apart.
- `dsh.client.inject` now names `@deepseek-ai/dsh-client-ui-conversation`, the
  package that owns the dock seat.
- Three tests: the dock registers under `conversation.input.dock`, it opens onto
  the guide (and stays collapsed before that), and it runs the same request as
  the tab.

## 0.9.7

- **The tab type is now reachable.** Registering a tab *type* is not enough: the
  right sidebar's guide list is built from `tabs.guide()`, so a type with no
  `guide` entry is registered, has a body slot, and is still impossible to open —
  no tab appears anywhere. The type now contributes one guide entry
  (`id: 'doctor'`, `order: 60`, localized title and description), which is what
  puts "Plugin doctor" in the sidebar's guide.
- The title and description come from the panel's own dictionary through a
  module-level `translate()`, because the sidebar calls them from its guide list,
  outside this component.
- Regression test: mounting the bundle with a recording `sidebarRightTabs` now
  asserts the registered definition carries a guide entry with a title and an
  order.

## 0.9.6

- **The host half now survives a context it does not own.** `apply()` ended with
  an unguarded `installRoutes(ctx)`, and cordis does not return `undefined` for
  an undeclared service — it throws `cannot get property "webServer" without
  inject`. So the whole `apply` failed, no route was registered, and the plugin
  manager showed one red dot with no text: the exact symptom the 0.9.5 report
  channel was built to explain, caused by the code next to it.
- `verify` now calls the host face's `apply` with a context that throws on every
  undeclared property, the way cordis does. A plain `{}` hid this: reading
  `ctx.webServer` off it is just `undefined`. Message:
  `apply() throws when a service it never declared is read, which fails the row: …`
- The scaffold was never affected — its host half registers nothing.
- Regression tests: `test/host.test.mjs` (activation, deferred web server,
  method guard) and a `verify` case that builds a plugin whose `apply` reads
  `ctx.webServer` unguarded.

## 0.9.5

- The panel reports its own failures. When a row fails to activate the app shows
  one red dot and no text, so the bundle now posts what happened to
  `POST /toolkit/report`; the host appends it to `~/.dsh/toolkit-client-report.ndjson`.
  Every stage is reported — `apply`, `no-inject`, `no-sidebar`, `tab-registered`,
  `tab-failed` — so "did it run at all" is answerable without a debugger.
- The failure that motivated it: `ctx.inject` callbacks run *after* `apply()`
  returns, so the guards added in 0.9.4 could not see a throwing registration and
  the row still ended up failed. The callback body is now guarded and reported.
- The client module no longer sets `name` on its face; it is the package's name
  either way, and the face now matches the shape that works.
- `mountClient` accepts a `host`, so a test can hand the panel a service that
  throws on purpose. Without it "the service threw" — the failure mode that costs
  the most to debug in the app — was untestable.
- `README.zh.md`: the whole tour in Chinese, linked from the top of the README.
  The install examples now say `@latest` instead of a version that goes stale.

## 0.9.4

- The client module now declares `inject: ['slots', 'locale']` and guards every
  service it reads. Without the list the loader calls `apply()` before those
  services exist; the throw fails the **whole web boot**, and the app then reports
  that third-party plugins are unsupported and starts with them disabled. That is
  what one unguarded `ctx.locale.register` did to a real profile.
- `verify` now calls the client module's `apply()` with a bare context and refuses
  a face without an `inject` list, so this class of failure is caught before
  install instead of at boot.
- `init` scaffolds the same guards, for the same reason.

## 0.9.3

- The panel needed one more thing than `dsh.client`: the host resolves the bundle
  through `exports["./client"]` (`clientExportOf`), and drops the row when that
  subpath is missing. 0.9.2 declared `dsh.client` but its `exports` map had no
  `./client`, so the tab was still absent — this release exports `./client` and
  `doctor` now checks the same thing the host does.
- `init` scaffolds `exports: { '.': './index.js', './client': './client.js' }`.
  Every plugin generated before this release was missing it, so every generated
  panel was invisible for the same reason.
- `doctor` reports a `dsh.client` whose `exports["./client"]` file does not exist,
  and a `dsh.client` with no `./client` export at all. The `files`-list gap is now
  caught at the manifest stage instead of at pack time.

## 0.9.2

- `doctor` reports a shipped client bundle that no `dsh.client` declares. The host
  serves `client.js` only for packages declaring `dsh.client`, so a plugin could
  ship the bundle, mount it in `verify`, and still have no panel in the app — the
  same silent failure as a tarball without it.
- The toolkit's own manifest now declares `dsh.client` (`platform: web`,
  `inject: ['@deepseek-ai/dsh-client-ui-sidebar-right']`), which is what makes the
  Plugin doctor tab reachable at all.
- The `not-shipped` fixture declares its client entry, so it keeps demonstrating
  the `files` gap instead of tripping the new declaration check.

## 0.9.1

- `audit` separates problems from advisories. Running 0.9.0 on a real profile
  said "17 of 19 installed plugin(s) have problems" — 13 of those load fine and
  only lack `engines.dsh` or a README Requirements section, which the market index
  needs and the loader does not. Those are now counted separately, so the plugins
  that are actually broken stay visible.
- `client entry` and `dev` resolve a `./client` export written as a conditions
  object (`{ default: './lib/client.cjs' }`), not only as a string.

## 0.9.0

- `audit`: every plugin installed in a profile, in one pass — version, whether the
  installed copy passes the same checks `doctor` runs, and whether the running app
  loaded it (read from the graph frame on `/plugins/events`). Answers "why is my
  plugin not in the sidebar?" with the plugin named.
- `doctor --installed` (used by `audit`): skip the `files` check. After install the
  tarball is already unpacked, so `files` cannot decide what shipped — npm always
  ships `package.json` and the README, and the check reported false problems for
  every published plugin.
- `client entry` accepts the bundle named by the `./client` export, which is how a
  package with a `dsh/` folder names its bundle (`@liustack/modlens` was reported
  as missing its own client bundle).

## 0.8.8

- `dev` reads the plugin graph the app sends first, so a plugin the app never
  loaded is reported as that ("restart the app once after installing it") instead
  of as a timeout. Found by running `dev` against a real app, not a fake stream.

## 0.8.7

- `panel.aria(selector)` and `panel.expectAria(selector, expected)`: assert what a
  screen reader reads, and get the attribute that differs named in the failure.
  A missing attribute reports `nothing` rather than `""`.

## 0.8.6

- `release --publish`: run `npm publish` locally instead of waiting for a
  publish workflow. Plenty of small plugins have no release pipeline; before
  this, `release` tagged, pushed and then waited for a registry that would never
  receive the version.
- The publish failure reports the last line of npm's stderr, so a 403 reads like
  a 403.

## 0.8.5

- `release --market <dir>`: write the index entry into a checkout of the
  repository that owns the index, and open the pull request there. Before this,
  `release` only touched a `market/index.json` inside the plugin's own repo, so
  anyone listed in a central market had to patch the entry by hand — which is
  where the timestamp goes wrong.
- `--index` still names the file inside that repository.

## 0.8.4

- README: `## When the panel does not appear` — the five checks that explain a
  successful install with nothing on screen (restart, root export, tarball,
  patch row, a bundle that throws). Each one is a failure this tool has already
  hit. A test keeps the section from losing a step.
- `doctor` table lists the new `root export` check; the verify example no longer
  pins an old version in its own docs.

## 0.8.3

`verify` now imports the host half it just installed.

- After installing the tarball, `verify` imports the module the loader will
  import (`exports["."]`, else `main`) and requires an `apply` function. A root
  module that throws on import — which `doctor`'s static read cannot see — is
  now a failure: `the installed index.js does not import: boom`.
- `--no-mount` skips the DOM, not the install, so the host half is checked in
  both modes. The success line says which half ran.

## 0.8.2

`doctor` now refuses the failure that shipped in 0.8.0.

- New check `root export`: when a package declares `dsh.bundle`, its root module
  has to be the plugin. A root that is also a `bin` target — a CLI wearing a
  plugin's clothes — is reported, and so is a root module with no `apply`.
  pnpm reports success either way; the row just mounts nothing.
- `test/doctor.test.mjs` covers both shapes, and a bundle with no root module
  (a subpath plugin) stays legal.

## 0.8.1

`0.8.0` installed and then did nothing: the loader starts a plugin by importing
the bare package name, and `exports["."]` still pointed at the CLI, so the row
had no `apply` to run.

- `exports["."]` is `./index.js`; the CLI keeps `./cli` and `bin`, the testkit
  keeps `./testkit`.
- `test/entry.test.mjs` guards the shape: the root export is the plugin, the
  patch file names the package once as `- insert:`, and every path
  `package.json` points at is in `files`.

## 0.8.0

The toolkit can now be installed as a plugin, because a tool that cannot be
installed the way its users install things is asking them to take its word.

- A "Plugin doctor" tab in the right sidebar: name the folder that holds a
  plugin's `package.json`, and it runs the same checks the market runs
  (`doctor` plus the pack list) and says which one would fail.
- `index.js` registers `GET /toolkit/check?dir=`, read-only, same-origin only,
  and answers with `{ok, dir, checks:[{check, ok, message}]}`.
- `cordis.patch.yml` and `dsh.bundle` in `package.json`, so `dsh plugin add
  dsh-plugin-toolkit` installs the panel; the CLI keeps working from the same
  package.
- The panel is tested the way a user meets it: `mountClient` on the real
  `client.js`, with a stub answering the route the host half registers.

## 0.7.3

The scaffold was two minor versions behind the tool that wrote it.

- `init` pins the toolkit it was generated by (`^<its own version>`) instead of
  a number typed once, so `npm install` in a fresh scaffold gets the version
  whose README you just read.
- The generated workflow uses the composite action with `verify` instead of
  `npx dsh-plugin-toolkit@0.5.0 doctor .` — `doctor` reads the working copy and
  cannot see that `files` left the client bundle out.
- `test/init.test.mjs` guards both: the pinned range must equal the running
  version, and the workflow must not fall back to `doctor`.

## 0.7.2

`verify` runs from npx's cache, so it has to find jsdom and React where the
plugin is, not where the tool is.

- `testkit` resolves `jsdom`, `react` and `react-dom` from the plugin folder
  first, then the working directory, then the tool's own dependencies.
- `verify` passes the plugin folder through, so
  `uses: WJDdidi-1/dsh-plugin-toolkit@v1` works in a workflow that ran `npm ci`
  in the plugin: before this, the action failed with
  `testkit needs a DOM: npm install --save-dev jsdom react react-dom` even
  though the plugin declared them.

## 0.7.1

The action now checks the tarball, which is the only thing a user installs.

- `uses: WJDdidi-1/dsh-plugin-toolkit@v1` defaults to `command: verify` instead
  of `doctor`. `doctor` reads the working copy, so a `files` list that omits
  `client.js` passes it and the plugin installs without a panel.
- The action fetches the published package with `npx` rather than shipping
  `node_modules` in the repository — `verify` mounts the panel, which needs
  jsdom and React, and those belong to the caller's dev dependencies.
- New `version` input (default `latest`) so a workflow can pin the tool.
- `test/action.test.mjs` guards the three things that break silently: the
  default command, the commands it offers existing in the CLI, and the README
  showing the action the way a consumer writes it.

# Changelog

## 0.7.0

Documentation, restructured around what you are trying to do rather than what the tool contains.

- README opens with **Three paths** — write a plugin, develop a panel, ship a version — and each path shows the commands it needs.
- `--help` gives every command one example line that can be pasted as-is, instead of syntax with placeholders.
- The stale `Roadmap` (which still described `dev` as unbuilt, two releases after it shipped) is replaced by **What is not here yet**: no `npm publish`, no check against a running app, `dev --host` not covered by CI, no Windows test of the watcher.
- `test/help.test.mjs` keeps all three honest: every command needs an example without placeholders, the three paths must show each command, and the README may not call a shipped feature unbuilt.

## 0.6.3

- `git` and `gh` are `.exe` on Windows, not `.cmd`; 0.6.2 renamed them too and `git.cmd` does not exist. Only the npm family is a shim now.

## 0.6.2

- 0.6.1 named the Windows shim but spawned `npm.cmd` directly, which Node 18.20/20.12 reject with `EINVAL` (the fix for CVE-2024-27980). `lib/exec.mjs` now runs through the shell on Windows and quotes each argument; elsewhere nothing changes.

## 0.6.1

- `npm`, `git` and `gh` are `.cmd` shims on Windows; `execFileSync('npm', …)` fails there with `spawnSync npm ENOENT`. One helper (`lib/exec.mjs`) now maps the name, instead of a `shell: true` at every call site. Caught by the Windows CI job that 0.6.0 added tests to.

## 0.6.0

`dsh-plugin verify` — the check that reads the tarball instead of the working copy.

- Packs, installs that tarball into a throwaway directory, and mounts the bundle **from the installed copy**, so "works in the repo, broken after `npm i`" is caught before publishing.
- Fails when the tarball omits the client bundle (found by convention, so it is not in the `files` check doctor runs) or anything else `package.json` points at.
- `--no-mount` stops after packing, for plugins whose panel needs a host to be meaningful.

## 0.5.0

`dsh-plugin init` — scaffolding that already passes the checks people hit after their first publish.

- Writes eight files: `package.json` (with `engines.dsh`, the patch file and a `files` list that actually ships the code), `cordis.patch.yml`, `index.js`, `client.js` (a sidebar tab), a testkit test for that tab, a CI workflow that runs both, `README.md` and `.gitignore`.
- Refuses a directory that is not empty unless `--force`, and refuses a name npm would refuse — the two mistakes that cost the most time later.
- The template is embedded, so `init` works offline.

## 0.4.1

- `examples/`: four runnable files (`mount-a-bundle`, `route-stubs`, `baseline`, `aria`), each showing one thing testkit does.
- `test/examples.test.mjs` runs every example and asserts it prints exactly what the README shows, and that the README names each one. An example that does not run teaches a shape that no longer exists.
- `fixtures/fetching-bundle/`: a bundle that calls its host on mount, so the route-stub example asserts something real instead of printing zeros.

## 0.4.0

`release` can now finish the job instead of printing the next command.

- `--pr` commits the index on `market/<version>`, pushes it, and opens the pull request with `gh`.
- `--merge` (with `--pr`) waits for `gh pr checks` to settle and squash-merges.
- A repository with no CI is treated as settled rather than waited on; `gh` prints "no checks reported" on **stderr** and exits 1, which is why stderr is now piped instead of dropped.
- Re-running a release after a failure no longer throws: the same version with the same publish time is a no-op, and a different timestamp stops with both values in the message.
- A package the registry has never heard of fails immediately (`the registry has no package named …`) instead of polling for eight minutes.
- `release` forwards `fetch`, so a caller can answer instead of npm.

Verified end to end against a throwaway package: tag → publish → registry wait → index write → PR #3 → checks → merged.

## 0.3.5

Four bugs found by running `release` for real against a throwaway package, instead of only `--dry-run`:

- The index entry came out with `publishTimestamp: null`. The registry was asked for the abbreviated packument (`application/vnd.npm.install-v1+json`), which has no `time` field at all — so the tool could see the version and still have no publish date. It now asks for the full document, and waits for `time[version]` before writing the entry.
- `git rev-parse` on a tag that does not exist yet printed `fatal: ambiguous argument …` in the middle of a successful release; stderr is now dropped for that call.
- "the working tree has uncommitted changes" now names up to three paths.
- A folder without `package.json` raised a stack trace instead of returning a preflight failure.

## 0.3.4

- CI now runs on Windows as well as Linux and macOS; two tests assumed a POSIX temp path (`/tmp/…`) and were rewritten with `path.join`.
- Verified `mount`, `doctor` and `release --dry-run` on Node 18.20.8 (not just the version CI installs), and the SSE wait against a stream shaped like the app's.

## 0.3.3

- `mount` on a path that is missing, or that is a directory, now says what to pass instead of raising `ENOENT: no such file or directory, open '…'`. Found by running the three commands in a clean HOME with a fresh clone.

## 0.3.2

- `expectSnapshot(html, dir, name)`: the assertion form of `compare`, so a baseline test reads like a test and fails with the element that moved.
- README: how to keep a DOM baseline, and how to assert what assistive tech sees.

## 0.3.1

- `unmount()` now waits one macrotask before the DOM goes away. React schedules work during its own unmount, and closing jsdom first turned that into `ReferenceError: window is not defined` after a passing test. Found by the example plugin's second test.
- The README links `dsh-plugin-example` and documents that `unmount()` is async.

## 0.3.0

- `dsh-plugin dev`: copy a rebuilt bundle into the installed plugin, then confirm the reload from the host's `/plugins/events` stream. Subscribing happens *before* the write, because a copy made first is reported to nobody.
- Without `--host` the copy still happens and the tool says the reload is unconfirmed — no guessed port, no false negative.
- A failed `--build` copies nothing.

## 0.2.2

- `unmount()` closes the jsdom window, so a panel that polls does not keep the test process alive.
- The first paint waits for the panel's own fetches inside `act`, which removes the flood of "not wrapped in act" warnings that buried real failures.

## 0.2.1

- A missing peer dependency now names the install command instead of failing with `ERR_MODULE_NOT_FOUND`.

## 0.2.0

- `dsh-plugin-toolkit/testkit`: mount a single-file client bundle in jsdom with the real React and a recording host context — `click`, `type`, `press`, `must`, `attributes`, and normalised DOM baselines.
- `createFetch(routes)`: route stubs for the panel's own endpoints, with a request log; an undeclared route answers 404 rather than hanging.
- `dsh-plugin mount <client.js>`: render a bundle in Node and print the text a user would see, or the markup with `--html`.
- The host merges locale registrations per namespace and understands both a flat table and a `{en, zh}` language map, which is what real plugins register.

## 0.1.1

- Ship a composite GitHub Action (`action.yml`), so a plugin repository can run the same checks with `uses: WJDdidi-1/dsh-plugin-toolkit@v1`.

## 0.1.0

First cut: `doctor`, `index`, `release`.

- `doctor` checks the manifest, the README's stated host range, the bundle patch, the client entry, and whether `files` ships everything `package.json` points at.
- `index` audits `market/index.json` and names every version that cannot state a host range.
- `release` runs preflight → tag → registry wait → index entry, prints every GitHub step, and refuses to run on a dirty tree or an existing tag.
- Registry checks read the registry's own document (and `time`), because `npm view` answers from a cache.
