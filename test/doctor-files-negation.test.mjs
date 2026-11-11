/**
 * The negation fixture is a committed package, not one the test writes on the
 * fly: the same `files` list is handed to `npm pack` and to `doctor`, so the
 * prediction cannot be tuned to a fixture that only the test knows about.
 *
 * `files: ["lib", "!lib/secret.js"]` keeps the folder entry but drops the file
 * that `exports["./client"]` names. npm leaves `lib/secret.js` out of the
 * tarball, and `doctor` has to report that on every run — a single passing run
 * could borrow state from a previous check.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run as runCli } from '../lib/cli.mjs';
import { run } from '../lib/exec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'negated-files');

function packedFiles() {
  const output = run('npm', ['pack', '--dry-run', '--json'], {
    cwd: fixture,
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

test('npm pack omits the negated client that exports["./client"] names', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8'));
  assert.equal(manifest.exports['./client'], './lib/secret.js');

  const shipped = packedFiles();
  const files = [...shipped].sort();
  assert.equal(
    shipped.has('lib/secret.js'),
    false,
    `npm pack unexpectedly ships the negated client:\n${files.join('\n')}`,
  );
  // The folder entry still ships its other files, so the fixture is exercising
  // the exclusion rather than a missing folder.
  assert.ok(shipped.has('lib/client.js'), `npm pack does not ship lib/client.js:\n${files.join('\n')}`);
});

test('doctor reports the negated client in 3 of 3 runs', async () => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const io = recorder();
    const code = await runCli(['doctor', fixture], io);
    const output = io.lines.join('\n');

    assert.equal(code, 1, `run ${attempt} exited ${code}:\n${output}`);
    const failures = io.lines.filter((line) => line.includes('✗'));
    assert.equal(failures.length, 1, `run ${attempt} failures:\n${output}`);
    assert.match(
      failures[0],
      /files list: files does not ship lib\/secret\.js, which package\.json points at/u,
      `run ${attempt} reported ${failures[0]}`,
    );
  }
});
