# audit-home-truncated-profile

The damaged half of the `audit --home` installed-tarball boundary test: a
profile whose `package.json` was interrupted mid-write, so it still declares
`ghost-plugin` in the prefix that parses but never closes its JSON.

The plugin folder is checked in at `plugin/ghost-plugin` rather than under
`home/.dsh/profiles/desktop/node_modules`, because git ignores every
`node_modules` folder. Its own manifest is truncated too: that is the shape
where the old reader had no `dsh` field to fall back on, so the scan found
nothing and printed "no plugins installed in any profile" with exit `0`. The
test copies the home and the plugin into the installed shape inside a temporary
folder before spawning the CLI from the packed tarball:

```sh
mkdir -p /tmp/damaged-home/.dsh/profiles/desktop/node_modules
cp -R home/.dsh /tmp/damaged-home/
cp -R plugin/ghost-plugin /tmp/damaged-home/.dsh/profiles/desktop/node_modules/
node ../../../bin/dsh-plugin.mjs audit --home /tmp/damaged-home/.dsh
```

That command must exit `1`, name the profile `package.json`, and print
`unreadable profile` instead of the empty-profile line.

The clean control is `test/fixtures/audit-home-clean`, whose valid profile and
healthy plugin must keep exiting `0` with the `clean-plugin` row.
