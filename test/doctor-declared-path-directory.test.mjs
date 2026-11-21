/**
 * A directory is not a file, even though it exists.
 *
 * `doctor` used `fs.existsSync` for the bundle patch and the client export, so
 * a manifest that declared `"patch": "./bundle"` or `"exports": { "./client":
 * "./bundle" }` passed every path check when `bundle/` was a folder. The host
 * then had no patch to apply and no client module to serve. These fixtures pin
 * three spellings of each declaration, and the shipped CLI is spawned because
 * that is where users and CI read the verdict.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkClientDeclaration, checkClientEntry, checkPatchFile, doctor, exportTarget, readManifest } from '../lib/doctor.mjs';

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

test('every fixture really declares a directory that exists', () => {
  for (const { name } of PATCH_FIXTURES) {
    const dir = fixture(name);
    const { manifest } = readManifest(dir);
    const declared = manifest.dsh.bundle.patch;
    assert.equal(fs.statSync(path.join(dir, declared)).isDirectory(), true, `${name}: ${declared}`);
  }
  for (const { name } of CLIENT_FIXTURES) {
    const dir = fixture(name);
    const { manifest } = readManifest(dir);
    const declared = exportTarget(manifest.exports['./client']);
    assert.equal(fs.statSync(path.join(dir, declared)).isDirectory(), true, `${name}: ${declared}`);
  }
});

for (const { name, declared } of PATCH_FIXTURES) {
  test(`doctor reports ${name} because its bundle patch is a directory`, () => {
    const report = doctor(fixture(name));
    assert.deepEqual(
      report.failures.map((failure) => failure.check),
      ['patch file'],
      JSON.stringify(report.failures),
    );
    const [failure] = report.failures;
    assert.match(failure.message, /is a directory, not a regular file/u);
    assert.ok(failure.message.includes(declared), failure.message);
  });
}

for (const { name, declared } of CLIENT_FIXTURES) {
  test(`doctor reports ${name} because its ./client export is a directory`, () => {
    const report = doctor(fixture(name));
    assert.deepEqual(
      report.failures.map((failure) => failure.check),
      ['client entry', 'client declaration'],
      JSON.stringify(report.failures),
    );
    const entry = report.failures.find((failure) => failure.check === 'client entry');
    assert.match(entry.message, /is a directory, not a regular file/u);
    assert.ok(entry.message.includes('bundle'), entry.message);
    const declaration = report.failures.find((failure) => failure.check === 'client declaration');
    assert.match(declaration.message, /is a directory, not a regular file/u);
    assert.ok(declaration.message.includes(declared), declaration.message);
  });
}

test('the shipped CLI exits 1 and names every directory in the declared-path checks', () => {
  const all = [
    ...PATCH_FIXTURES.map((fixtureEntry) => ({ ...fixtureEntry, checks: ['patch file'] })),
    ...CLIENT_FIXTURES.map((fixtureEntry) => ({ ...fixtureEntry, checks: ['client entry', 'client declaration'] })),
  ];
  for (const { name, checks } of all) {
    const run = spawnSync(process.execPath, [BIN, 'doctor', fixture(name)], { encoding: 'utf8' });
    const output = `${run.stdout}\n${run.stderr}`;
    assert.equal(run.status, 1, `${name}:\n${output}`);
    assert.doesNotMatch(output, /^ok {2}/mu, `${name} printed an ok line:\n${output}`);
    for (const check of checks) {
      const line = run.stderr.split(/\r?\n/u).find((entry) => entry.includes(`✗ ${check}:`));
      assert.ok(line, `${name} printed no ${check} line:\n${output}`);
      assert.match(line, /is a directory, not a regular file/u, `${name}: ${line}`);
      assert.ok(line.includes('bundle'), `${name} did not name the directory: ${line}`);
    }
  }
});

test('a missing declared path keeps the missing wording', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-declared-path-missing-'));
  try {
    assert.match(
      checkPatchFile(dir, { dsh: { bundle: { patch: './missing.yml' } } }),
      /dsh\.bundle\.patch points at \.\/missing\.yml, which does not exist/u,
    );
    assert.match(
      checkClientDeclaration(dir, {
        dsh: { client: { platform: 'web' } },
        exports: { './client': './missing.js' },
      }),
      /exports\["\.\/client"\] points at \.\/missing\.js, which does not exist/u,
    );
    assert.match(
      checkClientEntry(dir, {
        dsh: { client: { platform: 'web' } },
        exports: { './client': './missing.js' },
      }),
      /dsh\.client is declared but none of .* exists/u,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
