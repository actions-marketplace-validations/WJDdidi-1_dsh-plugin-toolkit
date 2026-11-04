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
