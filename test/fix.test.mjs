/**
 * The fixer is deliberately small: it exists for the most common install
 * failure in the hub, a plugin with no `engines.dsh`, and it must never edit a
 * manifest just because it was asked what it would do.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../lib/cli.mjs';
import { doctor } from '../lib/doctor.mjs';
import { DEFAULT_ENGINES, fixEngines } from '../lib/fix.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-fix-'));

function plugin(engines) {
  const dir = path.join(scratch(), 'plugin');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    name: 'fix-me',
    version: '1.0.0',
    files: ['index.js', 'README.md'],
    engines,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    exports: { '.': './index.js' },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

const manifestOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
const rawOf = (dir) => fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
const engineFailure = (dir) => doctor(dir).failures.some((failure) => failure.check === 'engines.dsh');

function recorder() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

test('a missing engines.dsh is proposed, and is not written without --write', () => {
  const dir = plugin({ node: '>=18' });
  const before = rawOf(dir);

  const result = fixEngines({ dir });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.written, false);
  assert.equal(result.reason, 'missing');
  assert.equal(result.range, DEFAULT_ENGINES);
  assert.equal(rawOf(dir), before, 'a dry run must leave package.json byte for byte alone');
  assert.deepEqual(manifestOf(dir).engines, { node: '>=18' });
  assert.equal(engineFailure(dir), true);

  const written = fixEngines({ dir, write: true });
  assert.equal(written.written, true);
  assert.equal(written.range, DEFAULT_ENGINES);
  assert.equal(manifestOf(dir).engines.dsh, DEFAULT_ENGINES);
  assert.equal(manifestOf(dir).engines.node, '>=18', 'the node engine is not the fixer’s to remove');
  assert.equal(engineFailure(dir), false);
});

test('a wrong range is replaced only with --write', () => {
  // A pin is the shape doctor rejects: the host cannot tell which versions it may use.
  const dir = plugin({ node: '>=18', dsh: '0.2.0' });
  const before = rawOf(dir);
  assert.equal(engineFailure(dir), true);

  const result = fixEngines({ dir });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'not-a-range');
  assert.equal(result.before, '0.2.0');
  assert.equal(result.range, DEFAULT_ENGINES);
  assert.equal(rawOf(dir), before);

  const written = fixEngines({ dir, write: true });
  assert.equal(written.written, true);
  assert.equal(manifestOf(dir).engines.dsh, DEFAULT_ENGINES);
  assert.equal(engineFailure(dir), false);
});

test('an already-correct range is left alone, even with --write', () => {
  const dir = plugin({ node: '>=18', dsh: DEFAULT_ENGINES });
  const before = rawOf(dir);

  const result = fixEngines({ dir, write: true });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.written, false);
  assert.equal(result.reason, 'already-correct');
  assert.equal(result.range, DEFAULT_ENGINES);
  assert.equal(rawOf(dir), before);
});

test('a valid range the author chose is not lowered to the default', () => {
  const dir = plugin({ node: '>=18', dsh: '>=0.3.0' });
  const result = fixEngines({ dir, write: true });
  assert.equal(result.changed, false);
  assert.equal(manifestOf(dir).engines.dsh, '>=0.3.0');

  // --range is an explicit request, so it may replace a valid range.
  const forced = fixEngines({ dir, range: '>=0.2.0', write: true, force: true });
  assert.equal(forced.written, true);
  assert.equal(manifestOf(dir).engines.dsh, '>=0.2.0');
});

test('the CLI prints the range and writes it only when --write is passed', async () => {
  const dir = plugin({ node: '>=18' });

  const dry = recorder();
  assert.equal(await run(['fix', dir, '--engines'], dry), 0);
  const printed = dry.lines.join('\n');
  assert.match(printed, /would write engines\.dsh/);
  assert.ok(printed.includes(DEFAULT_ENGINES), printed);
  assert.match(printed, /--write/);
  assert.equal(manifestOf(dir).engines.dsh, undefined);

  const wet = recorder();
  assert.equal(await run(['fix', dir, '--engines', '--write'], wet), 0);
  assert.match(wet.lines.join('\n'), /wrote engines\.dsh/);
  assert.equal(manifestOf(dir).engines.dsh, DEFAULT_ENGINES);
});

test('fix refuses a directory with no package.json instead of creating one', async () => {
  const dir = path.join(scratch(), 'empty');
  fs.mkdirSync(dir, { recursive: true });
  const io = recorder();
  const code = await run(['fix', dir, '--engines'], io);
  assert.equal(code, 1);
  assert.match(io.lines.join('\n'), /no package\.json/);
  assert.equal(fs.existsSync(path.join(dir, 'package.json')), false);
});

test('an invalid --range is refused and leaves package.json byte for byte alone', async () => {
  const dir = plugin({ node: '>=18', dsh: '>=0.2.0' });
  const before = rawOf(dir);

  const result = fixEngines({ dir, range: '>=banana', write: true, force: true });
  assert.equal(result.ok, false);
  assert.match(result.failures[0].message, /not a semver range/u);
  assert.equal(rawOf(dir), before);

  const io = recorder();
  assert.notEqual(await run(['fix', dir, '--engines', '--range', '>=banana', '--write'], io), 0);
  assert.equal(rawOf(dir), before);
});
