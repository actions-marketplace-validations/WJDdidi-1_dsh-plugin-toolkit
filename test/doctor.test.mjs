import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { doctor, hostRange } from '../lib/doctor.mjs';
import { init } from '../lib/init.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', name);
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-doctor-'));

test('a manifest the host can load passes every check', () => {
  const report = doctor(fixture('good'));
  assert.deepEqual(report.failures, []);
  assert.equal(report.notes.version, '1.2.3');
  assert.equal(report.notes.hostRange, '>=0.2.0');
});

test('a missing engines.dsh is reported, because the index cannot state a host range without it', () => {
  const report = doctor(fixture('no-engines'));
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].check, 'engines.dsh');
  assert.match(report.failures[0].message, /market index/);
});

test('engines.dsh must be a range, not a pin or a sentence', () => {
  assert.equal(hostRange({ engines: { dsh: '>=0.2.0' } }), '>=0.2.0');
  assert.equal(hostRange({ engines: {} }), null);
  assert.equal(hostRange({}), null);
});

test('a README that never mentions the declared range is reported', () => {
  const dir = fixture('readme-mismatch');
  const report = doctor(dir);
  const checks = report.failures.map((failure) => failure.check);
  assert.ok(checks.includes('readme'), checks.join(','));
});

test('a package whose root export is the CLI is refused, because the row would apply nothing', async () => {
  const dir = path.join(scratch(), 'plugin');
  init({ dir, name: 'cli-shaped', title: 'CLI shaped' });
  const manifestPath = path.join(dir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // The shape 0.8.0 shipped: both halves in one package, root pointing at the CLI.
  manifest.bin = { 'dsh-plugin': 'bin/dsh-plugin.mjs' };
  manifest.main = 'bin/dsh-plugin.mjs';
  manifest.exports = { '.': './bin/dsh-plugin.mjs', './testkit': './lib/testkit/index.mjs' };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const report = doctor(dir);
  const failure = report.failures.find((entry) => entry.check === 'root export');
  assert.match(failure.message, /points at the CLI/);
});

test('a plugin without a bin has no root export problem', async () => {
  const dir = path.join(scratch(), 'plugin');
  init({ dir, name: 'plain-plugin' });
  assert.equal(doctor(dir).failures.some((entry) => entry.check === 'root export'), false);
});
