/**
 * A root export that points at nothing is not an `ok`. Before this check,
 * `doctor` skipped a missing file silently and let a directory escape as a raw
 * `EISDIR` from `readFileSync`. Both shapes are a loader import that cannot
 * succeed, so they belong in the same `root export` line as an `apply` that is
 * absent. All three export spellings Node accepts reach the same check: a
 * string root, `exports["."]` as a string, and `exports["."]` as a conditions
 * object. The process-boundary assertions spawn the shipped CLI because that is
 * where users and CI see the verdict; `verify` is spawned too, because it must
 * stop at this same check instead of packing a package whose root cannot load.
 * The scaffold control makes sure the new failure does not turn a healthy
 * package red.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { doctor } from '../lib/doctor.mjs';
import { init } from '../lib/init.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const fixture = (name) => path.join(here, 'fixtures', name);

const FIXTURES = [
  { name: 'root-export-missing-file', target: 'missing.js', problem: /does not exist/u },
  { name: 'root-export-missing-conditions-file', target: 'missing.js', problem: /does not exist/u },
  { name: 'root-export-string-missing-file', target: 'missing.js', problem: /does not exist/u },
  { name: 'root-export-directory', target: 'lib', problem: /is a directory/u },
];

for (const { name, target, problem } of FIXTURES) {
  test(`doctor names ${target} as an unloadable root export in ${name}`, () => {
    const report = doctor(fixture(name));
    assert.equal(report.failures.length, 1, JSON.stringify(report.failures));
    assert.equal(report.failures[0].check, 'root export');
    assert.match(report.failures[0].message, problem);
    assert.ok(report.failures[0].message.includes(target), report.failures[0].message);
  });
}

test('the shipped CLI exits 1 on each unloadable root export and names the target', () => {
  for (const { name, target, problem } of FIXTURES) {
    const run = spawnSync(process.execPath, [BIN, 'doctor', fixture(name)], { encoding: 'utf8' });
    const output = `${run.stdout}\n${run.stderr}`;
    assert.equal(run.status, 1, `${name}:\n${output}`);
    const line = output.split('\n').find((entry) => entry.includes('root export:'));
    assert.ok(line, `${name} printed no root export line:\n${output}`);
    assert.match(line, problem, `${name}: ${line}`);
    assert.ok(line.includes(target), `${name} did not name ${target}: ${line}`);
    // 0.20.12 exited 0 for a missing file and escaped the directory case as a
    // raw EISDIR; neither is a verdict a user can act on.
    assert.doesNotMatch(output, /\bEISDIR\b/u, `${name} leaked a raw EISDIR:\n${output}`);
  }
});

test('verify --no-mount stops at the same doctor root-export check, not at pack', () => {
  // `verify` runs `doctor` first, so a root the loader cannot import has to stop
  // there. Reaching `npm pack` would spend time packing a package whose root is
  // already known to be unloadable, and would print a `pack:` failure instead of
  // the sentence that names the missing target.
  for (const { name, target, problem } of FIXTURES) {
    const run = spawnSync(process.execPath, [BIN, 'verify', fixture(name), '--no-mount'], { encoding: 'utf8' });
    const output = `${run.stdout}\n${run.stderr}`;
    assert.equal(run.status, 1, `${name}:\n${output}`);
    assert.match(output, /dsh-plugin verify: stopped at doctor/u, output);
    const line = output.split('\n').find((entry) => entry.includes('root export:'));
    assert.ok(line, `${name} printed no root export line:\n${output}`);
    assert.match(line, problem, `${name}: ${line}`);
    assert.ok(line.includes(target), `${name} did not name ${target}: ${line}`);
    assert.doesNotMatch(output, /\bEISDIR\b/u, `${name} leaked a raw EISDIR:\n${output}`);
    assert.doesNotMatch(output, /stopped at pack|✗ pack:/u, `${name} reached pack:\n${output}`);
  }
});

test('the unmodified scaffold still exits 0 with ok', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-missing-root-')), 'plugin');
  try {
    const scaffold = init({ dir, name: 'scaffold-ok', title: 'Scaffold OK' });
    assert.equal(scaffold.ok, true, JSON.stringify(scaffold.failures));

    const run = spawnSync(process.execPath, [BIN, 'doctor', dir], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /^ok {2}scaffold-ok@\d+\.\d+\.\d+ \(host >=0\.2\.0\)$/m, run.stdout);
    assert.doesNotMatch(run.stderr, /root export:/u, run.stderr);
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('the unmodified scaffold still passes verify --no-mount', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-missing-root-')), 'plugin');
  try {
    const scaffold = init({ dir, name: 'scaffold-verify', title: 'Scaffold Verify' });
    assert.equal(scaffold.ok, true, JSON.stringify(scaffold.failures));

    const run = spawnSync(process.execPath, [BIN, 'verify', dir, '--no-mount'], { encoding: 'utf8' });
    const output = `${run.stdout}\n${run.stderr}`;
    assert.equal(run.status, 0, output);
    assert.match(run.stdout, /^ok {2}packed \d+ file\(s\)/m, run.stdout);
    assert.doesNotMatch(output, /root export:/u, output);
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});
