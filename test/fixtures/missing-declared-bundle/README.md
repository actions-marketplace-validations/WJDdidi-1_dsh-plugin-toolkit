# missing-declared-bundle

The 0.20.12 missing-install regression: `dsh.profile.bundles` still lists
`ghost-plugin`, but the profile has no `node_modules` folder at all, so there is
no installed copy for the loader to mount.

Run the shipped command against this home to see the reported row and the
failing exit code:

```sh
node bin/dsh-plugin.mjs audit --home test/fixtures/missing-declared-bundle
```
