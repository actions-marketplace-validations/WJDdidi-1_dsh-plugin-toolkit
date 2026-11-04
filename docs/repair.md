# Repair a failed install

`doctor` is the map from a failed install to a file to edit. Run it on the plugin
checkout and read the line that starts with `✗`:

```text
$ npx dsh-plugin-toolkit@latest doctor .
dsh-plugin doctor: 2 problem(s) in /Users/you/my-panel
  ✗ engines.dsh: engines.dsh is missing, so the market index cannot state the host requirement
  ✗ client declaration: client.js ships but dsh.client is not declared, so the harness never serves the bundle and the panel cannot appear
```

Each section below is one check: the exact text `doctor` prints, what the check
means, and the smallest edit that clears it. Make the edit, run `doctor` again,
and repeat until it exits `0`. That is the whole loop.

`doctor --remote owner/repo` prints the same lines for a repository you have not
cloned, but it cannot edit anything. For a missing host range, `fix owner/repo
--remote --patch repair.patch` saves the `engines.dsh` diff without a checkout;
apply it after cloning (or paste it into a pull request). The command creates
parent directories and refuses to replace an existing file unless `--force` is
passed. For every other check, clone the repository and run the commands here
against the checkout.

## The loop

1. Run the automatic repair, and let it re-check:

   ```sh
   npx dsh-plugin-toolkit@latest doctor --fix . --write
   ```

   It prints the plan first, writes only the edit it can make without guessing
   (`engines.dsh`), then runs every check again. A failure that needs a human
   edit stays in the output with a `manual:` line.

2. For each remaining `✗`, find the check name below and make the edit it names.
3. Run `npx dsh-plugin-toolkit@latest doctor .` again. Exit code `0` means the
   working copy passes.
4. Run `npx dsh-plugin-toolkit@latest verify .` before publishing. `doctor`
   reads the working copy; `verify` packs the tarball, installs it, and imports
   the installed copy — the step that catches a `files` list that looks right
   but does not actually ship the panel.

If a hub report gives you a log instead of a repository, `explain --log` names
the check to start with:

```sh
npx dsh-plugin-toolkit@latest explain --log ~/.dsh/logs/install.log ./my-panel
```

| Check | What it protects |
| --- | --- |
| [`version`](#version) | The tag and the registry version both come from this field |
| [`engines.dsh`](#enginesdsh) | The market index cannot state which host the plugin supports |
| [`patch file`](#patch-file) | The host has no patch to apply |
| [`client declaration`](#client-declaration) | The host has no bundle to serve, so the panel cannot appear |
| [`client entry`](#client-entry) | The declared bundle file is not in the checkout or the tarball |
| [`root export`](#root-export) | The loader imports the package and finds no `apply` |
| [`files list`](#files-list) | The published tarball is missing code `package.json` points at |

## version

**What it means.** `version` is both the npm version and the git tag the release
uses (`plugin-v<version>`). A missing or malformed value fails the check before a
tag is created, which is cheaper than discovering it after the tag is public.

**What you see.**

```text
  ✗ version: package.json has no version
  ✗ version: version "v1.2" is not semver
```

The quoted value in the second line is whatever is in `package.json` — `1.2`,
`0.2`, `latest`, and a leading `v` all fail.

**Smallest fix.** Write a normal semver value in `package.json`:

```json
{
  "version": "1.2.3"
}
```

A prerelease is allowed (`1.2.3-rc.1`). Do not use a leading `v`, a range, or a
`+build` suffix. If the package is already published at that version, bump the
patch number instead — the release tag has to be new too.

## engines.dsh

**What it means.** The plugin declares which DeepSeek Harness host versions it
supports. The market index copies this value into every version entry, and a host
that enforces the range uses it to reject an incompatible install. `doctor` needs
a string that looks like a semver range, not a pinned version.

This is the most common install failure: a plugin with no `engines.dsh` at all
looks installable until the index or the host asks for the range.

**What you see.**

```text
  ✗ engines.dsh: engines.dsh is missing, so the market index cannot state the host requirement
  ✗ engines.dsh: engines.dsh "0.2.0" is not a semver range
```

An empty string, a number, or a missing `engines` object produces the first
line. A pin such as `"0.2.0"` produces the second; `"0.2.0"` names one exact
version, not a range.

**Smallest fix.** Add the field under `engines`, keeping any other engines:

```json
{
  "engines": {
    "node": ">=18",
    "dsh": ">=0.2.0"
  }
}
```

`>=0.2.0` is the range `init` writes and the default the repair commands use.
Use a higher range only when the plugin actually needs host APIs from a later
release. The edit is one field; do not replace the whole `engines` object.

`doctor --fix . --write` makes this edit and re-runs the checks. If the host
range is the only thing you want to touch, the narrower command is:

```sh
npx dsh-plugin-toolkit@latest fix . --engines --write
```

When a failed install names the host version, pass `--host <version>` and the
fixer writes a range aimed at it: the host is accepted and the next major is
excluded (`>=0.3.0 <1.0.0` for `0.3.0`). The command prints that reasoning
beside the edit. Both commands leave a range that already passes alone unless
`--host` or `--range` explicitly asks for a different one. If `doctor` also reports
`readme`, put the same range text in the README's `## Requirements` section.

## patch file

**What it means.** `dsh.bundle.patch` points at the YAML file the host applies
when it loads the plugin. `doctor` checks that the path exists; if it does not,
the host has nothing to insert and the plugin never loads.

**What you see.**

```text
  ✗ patch file: dsh.bundle.patch points at ./cordis.patch.yml, which does not exist
```

The path after `points at` is the value from `package.json`, relative to the
plugin root. A leading `./` is fine; the check resolves it the same way.

**Smallest fix.** Either create the file at the path you declared, or point
`dsh.bundle.patch` at the file that already exists. A minimal patch file, the
same shape `init` writes, is:

```yaml
- insert:
    - id: my-panel
      name: 'my-panel'
      config: {}
```

and the manifest stays:

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

Use a unique `id` and the package's own name for `name`; a duplicate id is what
the `explain` conflict cause points at. Also make sure `files` ships the patch
file — see [files list](#files-list).

## client declaration

**What it means.** `dsh.client` tells the host that this package has a web
bundle. The host does not look for `client.js` by convention: it reads the
bundle path from `exports["./client"]`. If the declaration exists but that export
does not, the host drops the row and the panel can never appear. If a bundle
file ships but `dsh.client` is absent, the harness never serves it.

`dsh.client.platform`, when present, has to be `web`; that is what the host
serves today.

**What you see.**

```text
  ✗ client declaration: dsh.client.platform is "node", but the harness serves client bundles on web
  ✗ client declaration: dsh.client is declared but exports has no "./client" bundle, so the host drops the row and the panel cannot appear
  ✗ client declaration: exports["./client"] points at ./dist/client.js, which does not exist
  ✗ client declaration: client.js ships but dsh.client is not declared, so the harness never serves the bundle and the panel cannot appear
```

The last line names whichever bundle file exists — a conventional `client.js`,
`lib/client.js`, or `dist/client.js`, or the target of an existing
`exports["./client"]`.

**Smallest fix.** Declare the client and export the bundle the host should
serve:

```json
{
  "dsh": {
    "client": {
      "platform": "web"
    }
  },
  "exports": {
    "./client": "./client.js"
  }
}
```

`client.js` must exist, and `files` must ship it. If the bundle lives somewhere
else, use that path in both places:

```json
{
  "dsh": {
    "client": {
      "platform": "web"
    }
  },
  "exports": {
    "./client": "./dist/client.js"
  }
}
```

A conditions object is also accepted for `exports["./client"]`, for example
`{ "default": "./client.js" }`.

If the platform line is the failure, change `"platform": "node"` to
`"platform": "web"` (or remove `platform`; the host serves web either way).

If the failure says a bundle ships but `dsh.client` is not declared, choose one:
declare it as above if this is a panel, or delete/rename the bundle if the
package has no client half.

## client entry

**What it means.** `dsh.client` is declared, but none of the files `doctor` can
use as the entry exists. It looks, in order, at `dsh.client.entry`, the target of
`exports["./client"]`, then `client.js`, `lib/client.js`, and `dist/client.js`.
This check is about the checkout having a file to serve; the host still reads
`exports["./client"]`, so keep the declaration and the entry aligned.

**What you see.**

```text
  ✗ client entry: dsh.client is declared but none of dist/client.js, client.js, lib/client.js, dist/client.js exists
```

The list is the paths `doctor` tried, including the one from
`dsh.client.entry` and the one from `exports["./client"]` when they are set.

**Smallest fix.** Make one of the listed paths exist, or point both
`dsh.client.entry` and `exports["./client"]` at the file that does:

```json
{
  "dsh": {
    "client": {
      "platform": "web",
      "entry": "./dist/client.js"
    }
  },
  "exports": {
    "./client": "./dist/client.js"
  }
}
```

Then build or commit `dist/client.js` and add `dist/` to `files`. A bundle that
is produced by `prepare`/`build` is not in the checkout until you run that
build; run it before `doctor`, or point both fields at a committed file. If only
`dsh.client.entry` points at the new path, the next check
([client declaration](#client-declaration)) will still fail: the host reads
`exports["./client"]`, not `dsh.client.entry`.

## root export

**What it means.** The loader starts a plugin by importing the bare package name
and calling its `apply`. That module comes from `exports["."]` when it is a
string, otherwise from `main`. If it is the CLI instead of the plugin half, the
CLI runs or exports nothing and the row mounts nothing. If the module exists but
does not export `apply`, the loader imports the package and still mounts
nothing.

**What you see.**

```text
  ✗ root export: exports["."] points at the CLI (bin/demo.js), so the loader's row has no plugin to apply; point it at the module that exports apply
  ✗ root export: the root export lib/index.js does not export apply, so the loader imports the package and mounts nothing
```

The first line is printed even when `doctor` followed `main` rather than
`exports["."]`; the fix is the same. The path in the message is the target after
a leading `./` is removed.

**Smallest fix.** Give the package a plugin entry that exports `apply`, and point
the root at it while leaving `bin` on the CLI:

```js
// index.js
export function apply(ctx) {
  // register the host-side row here
}
```

```json
{
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js"
  },
  "bin": {
    "my-panel": "./bin/demo.js"
  }
}
```

Add `index.js` to `files`. `export const apply = ...` and
`export { apply }` are also recognized. A plugin that only inserts a subpath
patch and has no root module does not need a root export; do not point the root
at the CLI to satisfy the field.

If the root file named by `main`/`exports["."]` does not exist at all, `doctor`
has no source to inspect and does not report this check — `verify` imports the
installed package and will catch it.

## files list

**What it means.** `files` is npm's allowlist for the published tarball.
`doctor` collects every path the manifest points at — `exports`, the patch file,
`dsh.client.entry`, `main`, and `types` — and checks that `files` covers the
paths npm will not add on its own. A path can be covered by naming it, by naming
a parent folder (`lib/` covers `lib/client.js`), or by a glob (`dist/*`). This
check is about the manifest; `verify` is what proves the packed tarball actually
contains the file.

**What you see.**

```text
  ✗ files list: package.json has no "files" list, so the tarball ships whatever happens to be in the folder
  ✗ files list: files does not ship client.js, which package.json points at, so the installed plugin would be missing its own code
```

The second line names every path that is missing, separated by commas. npm always
adds `package.json`, the README, the license, the changelog, and the `main` file,
so `doctor` does not ask for those; everything else has to be listed.

**Smallest fix.** Add the missing path, or its parent folder, to `files`:

```json
{
  "files": [
    "index.js",
    "client.js",
    "cordis.patch.yml",
    "README.md"
  ]
}
```

For a built bundle, a folder entry is usually the smallest edit:

```json
{
  "files": [
    "dist/",
    "cordis.patch.yml",
    "README.md"
  ]
}
```

If there is no `files` list at all, add one containing the paths the manifest
points at. Keep `package.json` out of the list — npm includes it automatically —
and run `verify` after changing it, because a listed path that does not exist is
not caught by this check.

## Also checked

`doctor` runs two more checks. They are included here so that every line it
prints has an answer.

### readme

**What it means.** The market index expects a `## Requirements` section that
states the same host range the manifest declares. It is how a reader learns
which host the plugin needs before installing it.

**What you see.**

```text
  ✗ readme: README.md is missing
  ✗ readme: README.md has no Requirements section, so users cannot tell which host it needs
  ✗ readme: README.md does not mention the host range ">=0.2.0" it declares
```

**Smallest fix.** Add the section, and make sure the range text matches:

```markdown
## Requirements

- DeepSeek Harness `>=0.2.0`
```

The check ignores whitespace when comparing the range, so `>= 0.2.0` in a table
also matches `>=0.2.0`.

### dsh field

**What it means.** `dsh` is what makes the package a plugin rather than a plain
npm package. `dsh.bundle.patch` is the patch file the host applies.

**What you see.**

```text
  ✗ dsh field: package.json has no "dsh" field, so the host will not load it as a plugin
  ✗ dsh field: dsh.bundle is missing; the host needs the patch file it points at
  ✗ dsh field: dsh.bundle.patch is missing
```

**Smallest fix.** Add the field and point it at a patch file that exists:

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

Creating or fixing that file is covered by [patch file](#patch-file). Add the
same path to `files` as well.
