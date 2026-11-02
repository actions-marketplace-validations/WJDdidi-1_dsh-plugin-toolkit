# dsh-plugin-toolkit

[![npm](https://img.shields.io/npm/v/dsh-plugin-toolkit)](https://www.npmjs.com/package/dsh-plugin-toolkit)
[![downloads](https://img.shields.io/npm/dw/dsh-plugin-toolkit)](https://www.npmjs.com/package/dsh-plugin-toolkit)
[![CI](https://github.com/WJDdidi-1/dsh-plugin-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/WJDdidi-1/dsh-plugin-toolkit/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-plugin-toolkit)](LICENSE)


![dsh-plugin-toolkit](docs/card.png)

English · [中文](./README.zh.md)

Everything a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin needs between `init` and a version the market index accepts: scaffolding, a test harness for the client bundle, a way to see a change without restarting the app, and a release that does not depend on remembering fourteen steps.

```sh
npx dsh-plugin-toolkit@latest init ./my-panel --name my-panel   # a plugin that already passes the checks
npx dsh-plugin-toolkit@latest verify .                          # pack it, install the tarball, mount the panel
npx dsh-plugin-toolkit@latest release --pr --merge              # tag, wait for npm, update the index, open and merge the PR
```

## The panel

![The Plugin doctor tab, on a plugin that fails two checks](https://raw.githubusercontent.com/WJDdidi-1/dsh-plugin-toolkit/main/docs/panel.png)

The same checks, in the right sidebar: type a folder, an `owner/repo`, or a GitHub link, and it says which one would fail and why. Nothing is installed and nothing is written.

## Three paths

| You are… | Start with | Then |
| --- | --- | --- |
| writing your first plugin | [`init`](#1-write-a-plugin) | `doctor`, `verify` |
| changing a panel that is already installed | [`dev`](#2-develop-a-panel) | `mount`, the testkit, `audit` |
| shipping a version | [`verify`](#3-ship-a-version) | `release`, `index` |

It also installs as a plugin. `dsh plugin add dsh-plugin-toolkit` puts a
**插件体检 / Plugin doctor** panel under the conversation and a tab in the right
sidebar. Give it a folder that holds a plugin's `package.json`, or just
`owner/repo` — or a repository name, which it searches GitHub for and lists the
candidates to pick from. It then runs the same checks `verify` runs and says
which one would break the install, with the reason on the line — the same
answers as the CLI, without leaving the app.

```
$ dsh plugin add dsh-plugin-toolkit
```

### 1. Write a plugin

[`init`](#start-from-a-plugin-that-already-passes) writes the files whose absence shows up as a failed first publish — `engines.dsh`, the patch file, a `files` list that ships the code, a client bundle, a test for it, and the CI that runs both. `doctor` then checks the same things without writing anything, and [`verify`](#prove-the-tarball-works-not-just-the-repository) checks the tarball instead of the working copy.

```sh
npx dsh-plugin-toolkit@latest init ./my-panel --name my-panel
cd my-panel && npm install && npm test && npx dsh-plugin-toolkit@latest doctor .
```

### 2. Develop a panel

A plugin's client code is one file that calls `window.__ModuleLoader__.load({factory})` — there is no module to import, so the usual React test setup does not apply. [`testkit`](#test-a-panel-without-a-browser) supplies the missing half, and [`dev`](#edit-a-plugin-that-is-already-installed) pushes a rebuilt bundle into the running app.

```sh
npx dsh-plugin-toolkit@latest mount ./client.js     # what a user would see, without the app
npx dsh-plugin-toolkit@latest dev . --host http://127.0.0.1:54133
```

### 3. Ship a version

`verify` first (it is the only check that reads the tarball), then `release`, which tags, waits for the registry, writes the index entry with the publish time the registry reports, and — with `--pr --merge` — opens and merges the pull request.

```sh
npx dsh-plugin-toolkit@latest verify .
npx dsh-plugin-toolkit@latest release . --pr --merge
```

## What `verify` actually does

![Five steps, and the failure each one catches](https://raw.githubusercontent.com/WJDdidi-1/dsh-plugin-toolkit/main/docs/pipeline.svg)

The order matters. Packing first means the check reads the file list npm will publish, not the folder you have. Installing the tarball means the root export is imported the way the loader imports it. Mounting means the client bundle is actually executed, in jsdom, with a host that records what it registered.

Each step exists because a plugin once got past the step before it and still installed into nothing.

## Why this exists

Releasing one plugin fifteen times taught me three things the ecosystem's tooling does not cover:

1. **A version is not shipped when npm accepts it.** Registry propagation took two to eight minutes every time. `npm view` answered from a stale local cache, so I repeatedly believed a release had failed when it had not — and once believed it had succeeded when the market still could not see it.
2. **The market index is a second release, done by hand.** Each version needs an entry carrying `publishTimestamp` from the registry and `engines.dsh` from the manifest. Forget the range and the index validator rejects the PR with `Engines mismatch` — after the tag is already public.
3. **Reading a manifest is not the same as checking it.** A plugin can have a valid `package.json` and still be uninstallable: `files` that omit the entry the manifest points at, a bundle patch that does not exist, a README that never states the host range it declares.

The five failures behind these checks — a red dot with no panel, a row the host drops, an app that disables every plugin after one unguarded `apply()`, a tab nothing can open, and a checker that was wrong — are written up with their exact error text and how to reproduce each one: [Five plugins that installed and did nothing](https://github.com/WJDdidi-1/dsh-plugin-toolkit/blob/main/docs/why-it-exists.md).

### Four ways a plugin installs and still does nothing

Each of these shipped in a real version of this toolkit before the check below existed. A manifest check passes on all four.

| What you see | What it was | Caught by |
| --- | --- | --- |
| The tab is a red dot and the panel never opens | `exports["."]` pointed at the CLI, so the loader's row had no plugin to apply | `root export` |
| The plugin is installed, the app never serves it | `dsh.client` declared, `exports["./client"]` missing — the host drops the row | `client declaration` |
| The app says the third-party plugin is unsupported and disables all of them | `apply()` read `ctx.webServer` without declaring it; cordis throws instead of returning `undefined` | `verify` (calls `apply` on a context that has no services) |
| The tab registers, and nothing in the UI opens it | `sidebarRightTabs.register()` registers a *type*; the sidebar lists what `tabs.guide()` returns | a testkit test, not `doctor` |

The first three are static: `doctor` and `verify` catch them without the app running. The fourth is a UI contract, so it needs the panel mounted and the registration inspected — that is what [`testkit`](#test-a-panel-without-a-browser) is for.

## Requirements

- Node.js 18 or newer (the registry is read with `fetch`; no runtime dependencies)
- Git and `gh` on `PATH` for the steps that touch GitHub
- DeepSeek Harness `>=0.2.0` — the version whose market index carries `engines.dsh`, which is what makes the range check meaningful
- For `testkit`: `jsdom`, `react` and `react-dom` as dev dependencies (`npm install --save-dev jsdom react react-dom`)

## Start from a plugin that already passes

```sh
$ npx dsh-plugin-toolkit@latest init ./my-panel --name my-panel --title "My panel"
created 8 file(s) in /Users/you/my-panel
  .github/workflows/ci.yml
  .gitignore
  README.md
  client.js
  cordis.patch.yml
  index.js
  package.json
  test/panel.test.mjs

next: npm install && npm test && npm run doctor
```

What you get is not a snippet: it is a plugin whose `doctor` already passes (`engines.dsh`, the patch file, the `files` list), with a client bundle that registers a sidebar tab, a testkit test for it, and a CI workflow that runs both. `init` refuses a directory that is not empty unless you pass `--force`, and refuses a name npm would refuse — those are the two mistakes that cost the most time later.

## Where it lives

The checker is docked **under the conversation**, above the input bar: a single
row, collapsed by default. Open it and it carries the whole guide — who it is
for, how to use it, what each check means, and what it cannot tell you — plus
the folder field and the results. The same panel is also a **Plugin doctor** tab
in the right sidebar, for when the conversation is busy.

The panel speaks both languages and opens in Chinese; the 中文 / EN switch sits
in the dock's header row (and in the sidebar tab) and the choice is remembered.

Look at it without the app:

```sh
node scripts/preview.mjs /tmp/panel.html   # collapsed, open, with a result, and the tab
```

## Test a panel without a browser

A plugin's client code is one file that calls `window.__ModuleLoader__.load({factory})` — there is no module to import, so the usual React test setup does not apply. `testkit` supplies the missing half: a DOM, the real React, and a host context that records what the panel registers.

```sh
npm install --save-dev jsdom react react-dom
```

```js
import { mountClient, createFetch } from 'dsh-plugin-toolkit/testkit';

const panel = await mountClient({
  file: 'client.js',
  copy: { 'my-plugin': { title: 'My panel' } },
  fetch: createFetch({
    '/my-plugin/report': { body: { score: 71, noise: 3 } },
    '/my-plugin/apply': () => ({ status: 201, body: { score: 92 } }),
  }),
});

await panel.click('[data-testid="optimize"]');
console.assert(panel.text().includes('92'), 'the score on screen did not move');
console.assert(panel.must('[role="status"]').textContent.includes('92'));
await panel.unmount();
```

`unmount()` is async: it lets React finish the work its own unmount schedules before the DOM goes away. Skipping the `await` surfaces as `ReferenceError: window is not defined` *after* the test has already passed, which is a confusing way to learn it.

What you get back: `text()`, `html()`, `query(selector)`, `must(selector)` (throws with the rendered HTML when it misses), `click(selector)`, `type(selector, value)`, `press(selector, key)`, `focus`, `attributes(selector)`, `snapshot(dir, name)` for a normalised DOM baseline, and `host` for assertions about what the bundle registered.

### Keep a visual baseline

The DOM is the baseline: normalising class order and whitespace gives a file that fails for the reasons a screenshot would — a lost label, a control that stopped rendering — and can be reviewed in a diff instead of by eye.

```js
import { expectSnapshot } from 'dsh-plugin-toolkit/testkit';

const panel = await mountClient({ file: 'client.js' });
expectSnapshot(panel.html(), '__snapshots__', 'panel');   // throws with the element that moved
await panel.unmount();
```

First run writes nothing: it tells you to re-run with `UPDATE_SNAPSHOTS=1`, so a baseline is always a decision, never a side effect.

### Check what assistive tech sees

```js
panel.expectAria('[role="tab"][aria-selected="true"]', { label: 'Protection', selected: 'true' });
assert.match(panel.must('[role="status"]').textContent, /Score moved 71 → 77/);
```

`expectAria()` compares the attributes a screen reader actually reads — `role`,
`label`, `live`, `selected`, `expanded`, `checked`, `pressed`, `disabled` — and
names the one that differs:

```
[aria-live="polite"]: expected aria text to be "9", but it is "0"
```

A missing attribute is reported as `nothing`, not as an empty string, because
those are different bugs. `panel.aria(selector)` returns the same object when you
want to assert on it yourself.

`must()` throws with the rendered markup when the selector misses, which is the difference between "the assertion failed" and "here is what the user actually got".

Every example below is a file in this repository, run by CI, and the output shown is the output it prints:

| Example | What it shows |
| --- | --- |
| `node examples/mount-a-bundle.mjs` | mount a real bundle, read the text, click, read it again |
| `node examples/route-stubs.mjs` | answer the routes a panel asks for, and assert on the requests |
| `node examples/baseline.mjs` | a DOM baseline compared on every run |
| `node examples/aria.mjs` | what assistive tech sees |

```sh
$ node examples/mount-a-bundle.mjs
Demo panel Count 0 0
Demo panel Count 1 1
```

```sh
$ node examples/route-stubs.mjs
Score 71
asked for: 1 route(s), undeclared route answers 404
```

To look at a bundle by hand:

```sh
npx dsh-plugin mount ./client.js            # print the text a user would see
npx dsh-plugin mount ./client.js --html     # print the markup
```

That is how the AIignore panel was checked before release: the real bundle, mounted in Node, against a stubbed `/aiignore/*`:

```
$ npx dsh-plugin mount ../ai-context-doctor/plugin/client.js
AIignore No workspace yet Could not read the report …
```

## Put the badge on a plugin that passes

If `verify` passes on your plugin, this badge says so and links back here:

```md
[![checked with dsh-plugin-toolkit](https://raw.githubusercontent.com/WJDdidi-1/dsh-plugin-toolkit/main/docs/badge.svg)](https://github.com/WJDdidi-1/dsh-plugin-toolkit)
```

It is a claim, not a decoration: add it only when `dsh-plugin verify .` exits 0.

## Start from the example

[`dsh-plugin-example`](https://github.com/WJDdidi-1/dsh-plugin-example) is a ~70-line plugin: one sidebar tab, two languages, one behaviour test, CI that runs `verify` through the composite action. It is the shape this toolkit expects, so it is also the fastest way to see whether the toolkit fits your plugin. It is a GitHub template too: **Use this template** starts you on a plugin whose first publish already passes.

```sh
dsh plugin add dsh-plugin-example
```

## See what is installed, and what the app loaded

`doctor` checks one folder you name. The question that actually gets asked is
"why is my plugin not in the sidebar?", and the answer needs three things at once:
what is installed, whether each installed copy is valid, and which of them the
running app actually loaded.

```sh
$ dsh-plugin audit --host http://127.0.0.1:54133
dsh-aiignore           0.37.1    loaded       ok
demo-panel             0.3.0     not loaded   ok  — dsh.profile.bundles in /Users/me/.dsh/profiles/desktop/package.json does not list it, and the loader mounts only listed bundles
                                            fix: add "demo-panel" to dsh.profile.bundles in /Users/me/.dsh/profiles/desktop/package.json (or run `dsh plugin add demo-panel`), then restart the app

1 installed plugin(s) are not in the running app:
```

"Not loaded" has three different causes, and `audit` names the one that applies
instead of offering a blanket restart:

- **Not in `dsh.profile.bundles`.** `pnpm add` (or `npm install`) installs the
  package but does not tell the loader to mount it. Add the package name to
  `dsh.profile.bundles` in `~/.dsh/profiles/<profile>/package.json`, or run
  `dsh plugin add <name>`, then restart the app.
- **No `dsh.bundle`.** The package declares `dsh` but no patch file to mount.
  Add `dsh.bundle.patch` to its `package.json` and ship the patch file, then
  reinstall.
- **Listed, but the app predates the install.** The profile is already correct;
  restart the app once to read the new list.

Advisories (`engines.dsh`, README Requirements) are counted apart from problems:
the market index needs them, the loader does not, so they should not bury a plugin
that is actually broken.

`audit` exits `1` when an installed plugin has a hard failure **or** when the
running app did not load at least one installed plugin, so CI can gate on a
profile where the app silently skipped a plugin. It exits `0` when every
installed plugin is loaded and valid. If no graph was read (`--host` omitted),
the loaded column is `?` and only hard failures change the exit code.

Without `--host` the loaded column is `?`, because guessing would be worse than
saying nothing. Only packages that declare a `dsh` field are audited — the rest of
`node_modules` is ordinary dependencies, and auditing those is noise.

## Edit a plugin that is already installed

The host already swaps a rebuilt bundle without a page reload: it watches each plugin's entry artifact and reports a `rebuilt` frame on `/plugins/events`. `dev` puts the new file where the host is looking, then **proves** the frame arrived instead of asking you to check by eye.

```sh
npx dsh-plugin dev . --host http://127.0.0.1:54133
```

![dsh-plugin dev printing the revision the app reported](docs/dev.gif)

*Recorded from a real run against the running app: the last line is the revision the app sent back on `/plugins/events`, not a message the tool printed on faith.*

```
demo-aiignore: /work/plugin/client.js -> ~/.dsh/profiles/desktop/node_modules/dsh-aiignore/client.js
initial: copied 163647 bytes at 1:18:43 AM
reloaded dsh-aiignore (rev e0c0230c4fc9)
watching /work/plugin
```

That last line is the whole point: the revision came back from the app's own event stream, so "it reloaded" is a fact, not a hope.

A plugin the running app never loaded cannot be reloaded, and the app says so by leaving it out of the graph it sends first. `dev` reads that graph, so a freshly installed plugin gets the sentence that fixes it instead of a timeout:

```
copied, but not confirmed: the running app has not loaded demo-panel, so it will not report a reload; restart the app once after installing it
```

| Flag | Meaning |
|---|---|
| `--dest <dir>` | write into this installed copy instead of searching `~/.dsh/profiles/*/node_modules/<name>` |
| `--entry <file>` | copy this file instead of `dsh.client.entry`, `client.js`, `lib/client.js` |
| `--build <command>` | run this before each copy (a failed build copies nothing) |
| `--host <url>` | confirm the reload against the app at this URL; without it the copy still happens and the tool says it is unconfirmed |
| `--once` | copy once and exit, for scripts |

Two things it does not do, because the host does not: React state inside the reloaded plugin is lost, and a failed swap does not roll back to the previous bundle.

## Use it in CI

The same checks run as a GitHub Action, so a tag cannot go out on a plugin that would not install:

```yaml
- uses: actions/checkout@v4
- uses: WJDdidi-1/dsh-plugin-toolkit@v1
  with:
    dir: plugin        # the folder holding the plugin's package.json
    command: verify    # pack it, install the tarball, mount the panel
```

`verify` is the default because it is the only check that reads what a user
actually installs: `doctor` reads the working copy, so a `files` list that
forgets `client.js` passes it and fails only after `npm i`.

`command: doctor` stops at the manifest checks (fast, no install), and
`command: index` audits `market/index.json` instead, failing on any version that
cannot state a host range. Pin `version:` if you would rather not track the
latest release.

## Check a plugin you have not cloned

The panel takes three kinds of input: a folder, `owner/repo`, or a GitHub URL.
A bare name is a search, not a guess — it asks GitHub, lists the matches with
their stars, and checks the one you pick. A repository is downloaded once as a
tarball into a temp folder, so nothing is cloned into your workspace and
nothing is installed.

The CLI checks local folders only; for a repository, clone it or let the panel
do the download.

## What `doctor` checks

| Check | Why it matters |
| --- | --- |
| `version` | The tag is built from it; a malformed version produces a tag nobody can install |
| `engines.dsh` | The market index copies this into every version entry. Missing it fails the index PR |
| `readme` | A `Requirements` section that states the declared range, so an install failure is predictable |
| `dsh field` | `dsh.bundle.patch` must exist for the host to load the plugin |
| `patch file` | The path declared above must be a real file |
| `client entry` | If `dsh.client` is declared, the bundle has to be there |
| `files list` | Every path `package.json` points at (`exports`, patch, client) must be covered by `files` |
| `root export` | The loader imports the bare package name; if that module is the CLI (or exports no `apply`), the row mounts nothing while the install reports success |

Exit code is `0` when the plugin can be installed and `1` when it cannot, so it drops into CI unchanged.

## When an install fails

A plugin hub files failed installs back into the plugin's repository, and the
report always opens with the same sentence — `plugin install failed`,
`plugin distribution incomplete`, `plugin does not support the DSH version in
use`, `failed to apply loader entry`. None of them names a file, so the author
is left reading a symptom. Paste the sentence and get the cause:

```sh
$ npx dsh-plugin-toolkit explain "dsh: installation rejected: Plugin my-panel@1.0.0 is incompatible with dsh 0.2.1-rc.5"
dsh-plugin explain: 1 known cause(s)
  cause: engines.dsh is missing, or the range it declares excludes the host doing the install
  symptom: the installer rejects the plugin before unpacking it
  check: engines.dsh
  fix: declare the range you actually support: "engines": { "dsh": ">=0.2.0" }
```

When the report gives you a log path such as `logs: ~/.dsh/logs/…` instead of
a sentence, point `--log` at the file. It reads the log and explains the last
line that matches a known cause, so the installer's generic first line does not
hide the specific one underneath it:

```sh
$ npx dsh-plugin-toolkit explain --log ~/.dsh/logs/install.log
dsh-plugin explain: 1 known cause(s)
  cause: two plugins register the same id or slot, so the second one cannot apply
  symptom: the plugin is installed but the loader refuses its entry
  check: patch file
  fix: give the row in cordis.patch.yml a unique id, and do not re-register a slot another plugin owns
```

Add the checkout and it also tells you whether that check actually fails there:

```sh
$ npx dsh-plugin-toolkit explain "plugin install failed" ./my-panel
...
  in ./my-panel: ✗ engines.dsh: engines.dsh is missing, so the market index cannot state the host requirement
```

The same checkout argument works after the log:
`dsh-plugin explain --log ~/.dsh/logs/install.log ./my-panel`.

Text it does not recognise exits `2` instead of guessing: a wrong diagnosis
sends you editing the wrong file. A log with no known cause also exits `2` and
lists the causes it looked for.

## Prove the tarball works, not just the repository

`doctor` reads your working copy. Users install the tarball, and a `files` list can ship everything except the panel — `doctor` will not notice.

```sh
$ npx dsh-plugin-toolkit verify .
ok  packed 5 file(s), installed the tarball, mounted the panel
    My panel This panel came from dsh-plugin init. Clicks: 0
```

It packs, installs that tarball into a throwaway directory, then mounts the bundle **from the installed copy**. When the `files` list drops the panel:

```sh
$ npx dsh-plugin-toolkit verify .
dsh-plugin verify: stopped at pack
  ✗ pack: the tarball does not contain client.js, so the installed plugin has no panel
```

## When the panel does not appear

The first question is whether the host ever served your bundle. A package that
ships `client.js` but declares no `dsh.client` loads its host half and shows no
panel — `doctor` now fails that, because the host serves client bundles only for
packages that declare one:


The install reports success and nothing shows up. In this order:

1. **Did the host restart?** Client bundles are read at startup. `dsh plugin add`
   writes the profile; the running window still has the old bundle.
2. **Is the root export the plugin?**
   ```sh
   node -e "import('my-plugin').then((m) => console.log(typeof m.apply))"
   ```
   `function` is what the loader needs. `undefined` means `exports["."]` points
   at the CLI — `0.8.0` of this tool shipped exactly that.
3. **Does the tarball ship the panel?** `dsh-plugin verify .` installs what users
   get and mounts it. `doctor` cannot see this.
4. **Is the patch row shaped right?** `cordis.patch.yml` needs one `- insert:`
   entry with `id` and `name`:
   ```yaml
   - insert:
       - id: my-plugin
         name: my-plugin
         config: {}
   ```
5. **Did the client bundle throw?** The host logs the loader error with the
   plugin id; a bundle that throws at factory time looks identical to one that
   never loaded.

## What `release` does

`release` runs the sequence in the order that fails cheapest first:

1. Preflight (`doctor`) — stop before tagging anything.
2. Refuse to run on a dirty tree, or if the tag already exists.
3. Create and push the tag, which starts the plugin's release workflow.
4. Poll the registry until it actually serves that version, reporting each wait.
5. Write the index entry with the publish time **the registry reports**, not the local clock. It waits for `time[version]` specifically: the abbreviated registry document has no `time` field, and an entry with a null timestamp is rejected by the market checker.
6. With `--pr`: commit that entry on `market/<version>`, push it, and open the pull request. With `--merge` as well: wait for `gh pr checks` to settle, then squash-merge.

```sh
npx dsh-plugin release . --pr --merge
```

```
tagged plugin-v0.4.0, npm served my-plugin@0.4.0 after 82s
updated market/index.json on market/0.4.0
opened https://github.com/me/my-plugin/pull/3
checks settled after 1s (1 look(s))
merged
```

Without `--pr` it prints the `git add` / `gh pr create` commands instead of running them; `--dry-run` prints the whole sequence before anything happens. A re-run after a failure is safe: the same version with the same publish time is a no-op.

### When nothing publishes for you

`release` assumes a tag starts a workflow that publishes. Repositories without
one use `--publish`, which runs `npm publish` in the same step:

```sh
$ dsh-plugin release . --publish
```

### When the index lives in someone else's repository

Most plugins are listed in a central market repository, not their own. Point
`--market` at a checkout of that repository and the entry — and the pull
request — land there:

```sh
$ dsh-plugin release . --market ../market-repo --pr --merge
tagged plugin-v0.4.0, npm served my-plugin@0.4.0 after 92s
updated /Users/me/market-repo/market/index.json on market/0.4.0
merged
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done, or nothing to complain about |
| 1 | A check failed, an installed plugin was not loaded by the running app, or the release stopped (the failing stage is named) |
| 2 | Unknown command |

## What is not here yet

Honest list, so nobody plans around a feature that does not exist:

- **No `npm publish`.** `release` pushes the tag and waits for the registry, so publishing stays in the workflow where your token and provenance live. It never holds your npm credentials.
- **No check against a running app.** `verify` mounts the installed bundle in Node with a stubbed host. It cannot prove the panel appears in a real sidebar — only that the code the tarball ships renders.
- **`dev --host` is not covered by CI.** The unit tests use a synthetic event stream; the live path is exercised by hand against a running app, on macOS only.
- **No Windows testing of the `dev` file watcher.** The Windows CI job runs the whole suite, but the watcher is only asserted against a temp directory, not a real profile.

## License

Apache-2.0. See [LICENSE](LICENSE).
