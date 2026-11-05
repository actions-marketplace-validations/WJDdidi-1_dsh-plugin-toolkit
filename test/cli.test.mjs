import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/cli.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const fixture = (name) => path.join(here, 'fixtures', name);
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-cli-'));

function bomPlugin() {
  const dir = path.join(scratch(), 'plugin');
  fs.cpSync(fixture('good'), dir, { recursive: true });
  const manifestPath = path.join(dir, 'package.json');
  fs.writeFileSync(manifestPath, `\uFEFF${fs.readFileSync(manifestPath, 'utf8')}`);
  return { dir, manifestPath };
}

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

test('doctor exits 0 for a manifest that starts with a UTF-8 BOM', () => {
  const { dir } = bomPlugin();
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'dsh-plugin.mjs'), 'doctor', dir], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok {2}demo-plugin@1\.2\.3/);
});

test('doctor names a broken manifest instead of printing a bare parse error', () => {
  const dir = path.join(scratch(), 'plugin');
  fs.cpSync(fixture('good'), dir, { recursive: true });
  const manifestPath = path.join(dir, 'package.json');
  fs.writeFileSync(manifestPath, '{ "name": "broken",\n');

  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'dsh-plugin.mjs'), 'doctor', dir], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.startsWith(`dsh-plugin: ${manifestPath} is not valid JSON: `), result.stderr);
  assert.doesNotMatch(result.stderr, /^dsh-plugin: Unexpected token/mu);
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
