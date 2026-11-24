/**
 * A negated `files` entry normally removes what the positive entries ship, and
 * a later positive entry can put a pattern back. An entry that names an
 * existing file is different: npm turns it into a strict rule and reverses the
 * order it applies those rules in, so the *first* explicit mention wins.
 *
 * A files list of a JavaScript glob, the patch, `!lib/client.js`, and
 * `lib/client.js` therefore still omits the client from the tarball. `doctor`
 * used to see the last entry and call the plugin clean, so the installed package was
 * missing the client its own `exports["./client"]` names. The test asks npm
 * what it really packs and requires the shipped CLI to agree; the folder-entry
 * control keeps the fix from rejecting every package that re-lists a file.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run as runCli } from '../lib/cli.mjs';
import { run } from '../lib/exec.mjs';

function writeFixture(root, files) {
  const dir = path.join(root, 'plugin');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });

  const manifest = {
    name: 'files-negated-reinclude-fixture',
    version: '1.0.0',
    description: 'A files list whose negation precedes an explicit re-inclusion',
    license: 'MIT',
    type: 'module',
    engines: { node: '>=18', dsh: '>=0.2.0' },
    main: 'index.js',
    files,
    exports: { '.': './index.js', './client': './lib/client.js' },
    dsh: {
      bundle: { patch: 'cordis.patch.yml' },
      client: { platform: 'web', entry: 'lib/client.js' },
    },
  };

  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply() {}\n');
  fs.writeFileSync(path.join(dir, 'lib', 'client.js'), 'export default 1;\n');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert:\n    - id: test-plugin\n      name: test-plugin\n      config: {}\n');
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    '# files-negated-reinclude-fixture\n\n## Requirements\n\n- DeepSeek Harness `>=0.2.0`\n',
  );
  return dir;
}

function packedFiles(dir) {
  const output = run('npm', ['pack', '--dry-run', '--json'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [document] = JSON.parse(output);
  return new Set((document.files ?? []).map((entry) => entry.path));
}

function recorder() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

test('doctor reports the client that npm omits after a negation and explicit re-inclusion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-files-reinclude-'));
  try {
    const dir = writeFixture(root, ['**/*.js', 'cordis.patch.yml', '!lib/client.js', 'lib/client.js']);
    const shipped = packedFiles(dir);
    const files = [...shipped].sort();

    const io = recorder();
    const code = await runCli(['doctor', dir], io);
    const output = io.lines.join('\n');

    if (shipped.has('lib/client.js') === false) {
      // This is the case npm 11 still produces: the tarball has no client, so
      // doctor must fail and must not print the `ok` line a clean package gets.
      assert.equal(code, 1, output);
      assert.doesNotMatch(output, /^ok {2}/m, output);
      assert.match(
        output,
        /files list: files does not ship lib\/client\.js, which package\.json points at/u,
        output,
      );
    } else {
      // A future npm that does pack the re-included file must make doctor pass,
      // so the check keeps following the packer instead of a fixed recipe.
      assert.ok(files.includes('lib/client.js'), files.join('\n'));
      assert.equal(code, 0, output);
      assert.match(output, /^ok {2}/m, output);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the plain folder-and-patch control has no negation and exits 0', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-files-reinclude-plain-control-'));
  try {
    const dir = writeFixture(root, ['lib', 'cordis.patch.yml']);
    const shipped = packedFiles(dir);
    assert.ok(
      shipped.has('lib/client.js'),
      `npm does not ship the client from a plain folder entry:\n${[...shipped].sort().join('\n')}`,
    );

    const io = recorder();
    const code = await runCli(['doctor', dir], io);
    const output = io.lines.join('\n');
    assert.equal(code, 0, output);
    assert.match(output, /^ok {2}/m, output);
    assert.doesNotMatch(output, /files does not ship lib\/client\.js/u, output);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an exact folder entry still lets npm and doctor ship the re-included client', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-files-reinclude-control-'));
  try {
    const dir = writeFixture(root, ['index.js', 'lib', 'cordis.patch.yml', '!lib/client.js', 'lib/client.js']);
    const shipped = packedFiles(dir);
    assert.ok(
      shipped.has('lib/client.js'),
      `npm no longer walks the lib entry that re-includes the client:\n${[...shipped].sort().join('\n')}`,
    );

    const io = recorder();
    const code = await runCli(['doctor', dir], io);
    const output = io.lines.join('\n');
    assert.equal(code, 0, output);
    assert.match(output, /^ok {2}/m, output);
    assert.doesNotMatch(output, /files does not ship lib\/client\.js/u, output);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
