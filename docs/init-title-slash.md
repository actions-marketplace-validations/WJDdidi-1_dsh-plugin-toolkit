# `init --title` and slashes

[`lib/init.mjs`](../lib/init.mjs) writes the `--title` value into the generated
`test/panel.test.mjs` as both a JavaScript string and a regular-expression
literal:

```js
assert.match(panel.text(), /Input/Output panel/);
```

The `/` in the title is not a regex metacharacter, but it does end a regex
*literal*. In `dsh-plugin-toolkit@0.19.0` the title was interpolated raw, so the
generated test did not parse: Node read the rest of the title as regex flags and
reported `SyntaxError: Invalid regular expression flags`.

## Measured on `dsh-plugin-toolkit@0.19.0`

The published tarball was installed into a private temp prefix, then one plugin
was generated for each slash-containing title:

```sh
set -e
d=$(mktemp -d)
export npm_config_cache="$d/npm-cache" npm_config_logs_dir="$d/npm-logs"
npm pack dsh-plugin-toolkit@0.19.0 --pack-destination "$d" >/dev/null 2>&1
npm install --prefix "$d/tool" "$d/dsh-plugin-toolkit-0.19.0.tgz" --ignore-scripts --no-audit --no-fund >/dev/null 2>&1
cli="$d/tool/node_modules/dsh-plugin-toolkit/bin/dsh-plugin.mjs"
parse=0
i=0
for t in 'Input/Output panel' 'Read/Write panel' 'AC/DC panel'; do
  i=$((i+1))
  node "$cli" init "$d/p$i" --name "probe-panel-$i" --title "$t" >/dev/null 2>&1
  node --check "$d/p$i/test/panel.test.mjs" >/dev/null 2>&1 && parse=$((parse+1))
done
echo "parse=$parse/3"
```

Output:

```text
parse=0/3
```

All three generated `test/panel.test.mjs` files fail `node --check`. A control
scaffold titled `My panel` still parses, which is what makes the slash the
trigger rather than the generated file in general.

## Fixed by escaping the regex literal

The generated assertion already came from `jsRegExp`, the same helper that
escapes `*`, `(`, `?` and the other regex metacharacters. It now escapes `/`
explicitly as well, so the generated test contains:

```js
assert.match(panel.text(), /Input\/Output panel/);
```

That is still one JavaScript regex literal, and it matches the literal title.

## Verified in this checkout

Run against the local `bin/dsh-plugin.mjs` so the check uses the code in this
repository rather than a published version:

```sh
set -e
d=$(mktemp -d)
parse=0
i=0
for t in 'Input/Output panel' 'Read/Write panel' 'AC/DC panel'; do
  i=$((i+1))
  node bin/dsh-plugin.mjs init "$d/p$i" --name "probe-panel-$i" --title "$t" >/dev/null
  node --check "$d/p$i/test/panel.test.mjs" >/dev/null 2>&1 && parse=$((parse+1))
done
echo "parse=$parse/3"
node bin/dsh-plugin.mjs init "$d/control" --name probe-control --title 'My panel' >/dev/null
node --check "$d/control/test/panel.test.mjs"
```

Output:

```text
parse=3/3
```

The `node --check` for the `My panel` control exits `0` silently, so the control
passes too.
