import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/cli.mjs';
import { declaredPaths, isShipped } from '../lib/doctor.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', name);

function recorder() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

test('declaredPaths records manifest paths with or without a leading ./', () => {
  // npm treats these as the same tarball path, so the files-list check has to
  // see both spellings.
  assert.deepEqual(declaredPaths({ dsh: { bundle: { patch: 'cordis.patch.yml' } } }), ['cordis.patch.yml']);
  assert.deepEqual(declaredPaths({ main: 'index.js' }), ['index.js']);
  assert.deepEqual(declaredPaths({ dsh: { client: { entry: 'client.js' } } }), ['client.js']);
  assert.deepEqual(declaredPaths({ dsh: { bundle: { patch: './cordis.patch.yml' } } }), ['cordis.patch.yml']);
  assert.deepEqual(declaredPaths({ main: './index.js' }), ['index.js']);
  assert.deepEqual(declaredPaths({ dsh: { client: { entry: './client.js' } } }), ['client.js']);
});

test('a bare bundle patch omitted from files makes doctor exit 1 with a files list failure', async () => {
  const io = recorder();
  const code = await run(['doctor', fixture('bare-path')], io);

  const output = io.lines.join('\n');
  assert.equal(code, 1, output);
  const failures = io.lines.filter((line) => line.includes('✗'));
  assert.equal(failures.length, 1, output);
  assert.match(failures[0], /files list: files does not ship cordis\.patch\.yml/);
});

test('a root-level *.js glob does not ship a nested client export', async () => {
  const io = recorder();
  const code = await run(['doctor', fixture('glob-js')], io);

  const output = io.lines.join('\n');
  assert.equal(code, 1, output);
  const failures = io.lines.filter((line) => line.includes('✗'));
  assert.equal(failures.length, 1, output);
  assert.match(failures[0], /files list: files does not ship lib\/client\.js/);
});

test('files globs use npm path semantics instead of a prefix', () => {
  // `*.js` is root-level only, so it cannot stand in for lib/client.js.
  assert.equal(isShipped('client.js', ['*.js']), true);
  assert.equal(isShipped('lib/client.js', ['*.js']), false);
  // npm appends `*` to a `dir/*` entry, and `**` crosses directories.
  assert.equal(isShipped('lib/client.js', ['lib/*.js']), true);
  assert.equal(isShipped('lib/nested/deep.js', ['lib/*.js']), false);
  assert.equal(isShipped('lib/nested/deep.js', ['lib/*']), true);
  assert.equal(isShipped('lib/nested/deep.js', ['lib/**/*.js']), true);
});

test('a negated files entry removes paths the positive entries would ship', () => {
  // `files: ["lib", "!lib/secret.js"]` is npm's way to ship the folder without
  // the file the manifest points at, so doctor must not treat `lib` as enough.
  assert.equal(isShipped('lib/secret.js', ['lib']), true);
  assert.equal(isShipped('lib/secret.js', ['lib', '!lib/secret.js']), false);
  assert.equal(isShipped('lib/client.js', ['lib', '!lib/secret.js']), true);
  // A basename pattern ignores at any depth, while a slash pattern is relative
  // to the package root and `*` still stays inside one folder.
  assert.equal(isShipped('lib/secret.js', ['lib', '!*.js']), false);
  assert.equal(isShipped('lib/secret.js', ['lib', '!lib/*.js']), false);
  assert.equal(isShipped('lib/nested/secret.js', ['lib', '!lib/nested']), false);
  assert.equal(isShipped('lib/nested/secret.js', ['lib', '!lib/{secret,private}.js']), true);
  assert.equal(isShipped('lib/secret.js', ['lib', '!lib/{secret,private}.js']), false);
});
