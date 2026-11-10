# audit-home-clean

The clean half of the `audit --home` process-boundary test: a profile home whose
one declared plugin is installed and valid. With the plugin copied into
`node_modules`, `audit --home <this home>/.dsh` prints the `clean-plugin` row and
exits `0`, so a test can compare the three missing-value spellings against a
real clean scan instead of only asserting that they fail.

The plugin package is checked in at `plugin/clean-plugin` rather than under
`home/.dsh/profiles/desktop/node_modules`, because git ignores every
`node_modules` folder. The test copies it into the installed shape inside a
temporary home before spawning the CLI:

```sh
mkdir -p /tmp/clean-home/.dsh/profiles/desktop/node_modules
cp -R home/.dsh /tmp/clean-home/
cp -R plugin/clean-plugin /tmp/clean-home/.dsh/profiles/desktop/node_modules/
node ../../../bin/dsh-plugin.mjs audit --home /tmp/clean-home/.dsh
```

That command prints `clean-plugin  1.0.0  ?  ok` and exits `0`.
