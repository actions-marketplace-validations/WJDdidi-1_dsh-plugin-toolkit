# `init --title` and apostrophes

[`lib/init.mjs`](../lib/init.mjs) writes the `--title` value directly into the
generated `client.js` and `test/panel.test.mjs`. A title containing an apostrophe
therefore closes the single-quoted JavaScript string early, so the scaffold does
not parse.

## Measured on `dsh-plugin-toolkit@0.19.0`

Measured on 2026-11-04 with Node.js `v24.15.0`, npm `11.12.1`, Darwin arm64.

The published tarball was packed and installed into a private temp prefix, then
one plugin was generated for each title:

```sh
set -e
d=$(mktemp -d)
export npm_config_cache="$d/npm-cache" npm_config_logs_dir="$d/npm-logs"
npm pack dsh-plugin-toolkit@0.19.0 --pack-destination "$d" >/dev/null 2>&1
npm install --prefix "$d/tool" "$d/dsh-plugin-toolkit-0.19.0.tgz" --ignore-scripts --no-audit --no-fund >/dev/null 2>&1
cli="$d/tool/node_modules/dsh-plugin-toolkit/bin/dsh-plugin.mjs"
fail=0
i=0
for t in "Bob's panel" "It's fine" "O'Brien"; do
  i=$((i+1))
  node "$cli" init "$d/p$i" --name "my-panel-$i" --title "$t" >/dev/null 2>&1
  node --check "$d/p$i/client.js" >/dev/null 2>&1 || fail=$((fail+1))
done
echo "$fail"
```

Output:

```text
3
```

All three generated `client.js` files fail `node --check`:

| trial | title | `node --check client.js` | scaffold `npm test` |
| --- | --- | --- | --- |
| 1 | `Bob's panel` | fail, exit 1 | fail, exit 1 |
| 2 | `It's fine` | fail, exit 1 | fail, exit 1 |
| 3 | `O'Brien` | fail, exit 1 | fail, exit 1 |

The first generated line reads:

```js
en: { tabTitle: 'Bob's panel', title: 'Bob's panel', body: 'This panel came from dsh-plugin init.', clicks: 'Clicks' },
```

and `node --check` reports:

```text
SyntaxError: Unexpected identifier 's'
```

The generated test has the same problem at its `copy` object:

```js
copy: { 'my-panel-1': { tabTitle: 'Bob's panel', title: 'Bob's panel', body: 'This panel came from dsh-plugin init.', clicks: 'Clicks' } },
```

so the scaffold's own `npm test` exits `1` before the panel is mounted.

## Fixed in 0.20.0

The title was interpolated at three places in `lib/init.mjs`:

- the `client.js` `COPY` entries (single-quoted JavaScript strings);
- the generated test's `copy` object (the same quoting problem);
- the generated test's assertion `assert.match(panel.text(), /${title}/)`, which
  also needs escaping for regular-expression metacharacters, not only quotes.

`init` now quotes the first two with a JavaScript string-literal escape
(`jsString`) and the assertion with a regular-expression source escape
(`jsRegExp`). Backslashes, quotes, newlines, other control characters and regex
metacharacters survive the template, so `init --title "Bob's panel"` writes a
`client.js` and `test/panel.test.mjs` that pass `node --check`, and the
scaffold's own `npm test` passes.

The metric was `3` against a threshold of `0`, so the defect reproduced.
