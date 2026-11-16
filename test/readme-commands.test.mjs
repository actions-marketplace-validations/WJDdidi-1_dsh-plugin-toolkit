/**
 * The tarball gate is only as good as the commands it reads. The shipped
 * READMEs have so far used bare `scripts/...` and `examples/...` paths, but a
 * `node ./bin/...`, a quoted path, a nested folder or a `.js`/`.cjs` file is
 * the same promise to an installed reader. These cases go through the real
 * extractor so a future README edit cannot step outside the gate silently.
 *
 * The comparison also has to read `package.json`'s `files` list the way npm
 * does: folders and globs ship everything below them, and a later `!` entry
 * takes a path out again. Treating that list as exact strings would both
 * reject valid globs and ignore a negated path.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { documentedRunCommands, missingRunCommands } from '../lib/readme-commands.mjs';

function withReadmes(readmes, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-readme-commands-'));
  try {
    for (const [name, text] of Object.entries(readmes)) {
      fs.writeFileSync(path.join(root, name), text);
    }
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('every relative node <path> command is read from both shipped READMEs', () => {
  const documented = withReadmes(
    {
      'README.md': [
        'Run `node scripts/preview.mjs /tmp/panel.html` from the package root.',
        '$ node ./examples/mount-a-bundle.mjs',
        'node "bin/dsh-plugin.mjs" --help',
        "node 'lib/nested/tool.cjs'",
        'node `examples/aria.mjs`',
        'See node lib/util.js.',
        '`node --test` and `node -e "import(\'x\').then(() => {})"` are not file commands.',
        'node script.py is not a JavaScript command either.',
      ].join('\r\n'),
      'README.zh.md': [
        'node scripts/preview.mjs /tmp/panel.html',
        'node examples/route-stubs.mjs',
      ].join('\n'),
    },
    (root) => documentedRunCommands(root),
  );

  assert.deepEqual([...documented.keys()].sort(), [
    'bin/dsh-plugin.mjs',
    'examples/aria.mjs',
    'examples/mount-a-bundle.mjs',
    'examples/route-stubs.mjs',
    'lib/nested/tool.cjs',
    'lib/util.js',
    'scripts/preview.mjs',
  ]);
  // The first README that names a command is kept, even when the other one
  // repeats it. Otherwise a missing path could be blamed on the wrong file.
  assert.equal(documented.get('scripts/preview.mjs'), 'README.md');
  assert.equal(documented.get('examples/aria.mjs'), 'README.md');
});

test('the files comparison uses npm folder, glob and negation semantics', () => {
  const documented = new Map([
    ['bin/dsh-plugin.mjs', 'README.md'],
    ['examples/aria.mjs', 'README.md'],
    ['lib/tool.cjs', 'README.md'],
    ['scripts/preview.mjs', 'README.md'],
  ]);

  assert.deepEqual(
    missingRunCommands(documented, ['examples/', 'scripts/*.mjs', 'bin/dsh-plugin.mjs']),
    ['lib/tool.cjs'],
    'a folder or glob entry ships the commands below it; naming it an exact-string comparison would be wrong',
  );

  assert.deepEqual(
    missingRunCommands(documented, ['examples/', 'scripts/*.mjs', 'bin/', '!scripts/preview.mjs']),
    ['lib/tool.cjs', 'scripts/preview.mjs'],
    'a negated files entry removes the documented command it names, and every missing path is reported in sorted order',
  );
});
