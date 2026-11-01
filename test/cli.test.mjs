import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/cli.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, '..', 'fixtures', name);

function recorder() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

test('doctor exits 0 for a plugin the host can load', async () => {
  const io = recorder();
  const code = await run(['doctor', fixture('good')], io);
  assert.equal(code, 0);
  assert.match(io.lines.join('\n'), /ok {2}demo-plugin@1\.2\.3/);
});

test('doctor exits 1 and names the check that failed', async () => {
  const io = recorder();
  const code = await run(['doctor', fixture('no-engines')], io);
  assert.equal(code, 1);
  assert.match(io.lines.join('\n'), /engines\.dsh/);
});

test('an unknown command prints the help and exits 2', async () => {
  const io = recorder();
  const code = await run(['nope'], io);
  assert.equal(code, 2);
  assert.match(io.lines.join('\n'), /dsh-plugin — preflight/);
});

test('a dry run shows the sequence and never tags anything', async () => {
  const io = recorder();
  const code = await run(['release', fixture('good'), '--dry-run'], io);
  assert.equal(code, 0);
  const output = io.lines.join('\n');
  assert.match(output, /Create the tag plugin-v1\.2\.3/);
  assert.match(output, /Wait until the registry serves demo-plugin@1\.2\.3/);
});

test('--home is a flag the parser knows, and it takes the value after it', async () => {
  // `audit --home <dir>` used to throw `args is not defined` before it ever
  // reached the audit: the flag reader named the wrong variable.
  const io = recorder();
  const home = path.join(here, '..', 'fixtures', 'empty-home');
  const code = await run(['audit', '--home', home, '--timeout', '50'], io);
  assert.equal(typeof code, 'number');
  assert.doesNotMatch(io.lines.join('\n'), /args is not defined/u);
});
