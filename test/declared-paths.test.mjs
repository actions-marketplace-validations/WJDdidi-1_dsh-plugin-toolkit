import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/cli.mjs';
import { declaredPaths } from '../lib/doctor.mjs';

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
