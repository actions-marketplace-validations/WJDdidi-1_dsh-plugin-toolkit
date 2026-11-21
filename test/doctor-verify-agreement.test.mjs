/**
 * `doctor` and `verify` must reach the same verdict on a declared path that is
 * a directory.
 *
 * `doctor` reads the checkout. `verify` packs and installs it, and it defers
 * file checks to the pack when `prepack` may generate the file. A directory is
 * not an absent file: a hook cannot make it a regular file without deleting it
 * first, so `verify` has to stop at `doctor` with the same sentence instead of
 * packing and reporting `the tarball does not contain bundle`. These six
 * fixtures cover a bare patch path, a `./`-prefixed one and a nested one, plus
 * the same three spellings for the client export; the shipped CLI is spawned
 * because that is where users and CI read the verdict. The unmodified scaffold
 * is the control: the new agreement must not turn a healthy package red.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { init } from '../lib/init.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const fixture = (name) => path.join(here, 'fixtures', name);

const PATCH_FIXTURES = [
  { name: 'patch-directory', declared: 'bundle' },
  { name: 'patch-directory-dot-slash', declared: './bundle' },
  { name: 'patch-directory-nested', declared: './dist/bundle' },
];

const CLIENT_FIXTURES = [
  { name: 'client-export-directory', declared: './bundle' },
  { name: 'client-export-directory-plain', declared: 'bundle' },
  { name: 'client-export-directory-conditions', declared: './bundle' },
];

/** Each fixture's expected `doctor` checks, with the path its line must name. */
const DEFECTS = [
  ...PATCH_FIXTURES.map(({ name, declared }) => ({
    name,
    declared,
    checks: [['patch file', declared]],
  })),
  ...CLIENT_FIXTURES.map(({ name, declared }) => ({
    name,
    declared,
    checks: [
      ['client entry', declared.replace(/^\.\//u, '')],
      ['client declaration', declared],
    ],
  })),
];

function run(command, args) {
  const result = spawnSync(process.execPath, [BIN, command, ...args], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function assertDirectoryLines(output, { name, checks }) {
  assert.doesNotMatch(output, /^ok {2}/mu, `${name} printed an ok line:\n${output}`);
  const failureLines = output.split(/\r?\n/u).filter((entry) => entry.includes('✗ '));
  assert.equal(failureLines.length, checks.length, `${name} printed unexpected failures:\n${output}`);
  for (const [check, needle] of checks) {
    const line = output.split(/\r?\n/u).find((entry) => entry.includes(`✗ ${check}:`));
    assert.ok(line, `${name} printed no ${check} line:\n${output}`);
    assert.match(line, /is a directory, not a regular file/u, `${name}: ${line}`);
    assert.ok(line.includes(needle), `${name} did not name ${needle}: ${line}`);
  }
}

test('every fixture really declares a directory that exists', () => {
  for (const { name, declared } of [...PATCH_FIXTURES, ...CLIENT_FIXTURES]) {
    const target = path.join(fixture(name), declared);
    assert.equal(fs.statSync(target).isDirectory(), true, `${name}: ${declared}`);
  }
});

for (const defect of DEFECTS) {
  test(`doctor and verify both reject ${defect.name} at the same declared-path check`, () => {
    const dir = fixture(defect.name);

    const doctor = run('doctor', [dir]);
    assert.equal(doctor.status, 1, `${defect.name} doctor:\n${doctor.output}`);
    assertDirectoryLines(doctor.output, defect);

    const verify = run('verify', [dir]);
    assert.equal(verify.status, 1, `${defect.name} verify:\n${verify.output}`);
    assert.match(verify.output, /dsh-plugin verify: stopped at doctor/u, verify.output);
    assert.doesNotMatch(verify.output, /stopped at pack|✗ pack:/u, verify.output);
    assertDirectoryLines(verify.output, defect);
  });
}

test('the unmodified scaffold still exits 0 from both commands', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-verify-agreement-')), 'plugin');
  try {
    const scaffold = init({ dir, name: 'scaffold-agreement', title: 'Scaffold Agreement' });
    assert.equal(scaffold.ok, true, JSON.stringify(scaffold.failures));

    const doctor = run('doctor', [dir]);
    assert.equal(doctor.status, 0, doctor.output);
    assert.match(doctor.output, /^ok {2}scaffold-agreement@\d+\.\d+\.\d+ \(host >=0\.2\.0\)$/mu, doctor.output);
    assert.doesNotMatch(doctor.output, /is a directory, not a regular file/u, doctor.output);

    const verify = run('verify', [dir, '--no-mount']);
    assert.equal(verify.status, 0, verify.output);
    assert.match(verify.output, /^ok {2}packed \d+ file\(s\)/mu, verify.output);
    assert.doesNotMatch(verify.output, /stopped at doctor|is a directory, not a regular file/u, verify.output);
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});
