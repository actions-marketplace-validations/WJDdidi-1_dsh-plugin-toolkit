/**
 * `audit --home` must not turn a declared bundle with a valid but dsh-less
 * package.json into a false clean.
 *
 * The profile's `dsh.profile.bundles` list is the record that the loader will
 * mount the package. When the folder exists and its package.json parses but has
 * no `dsh` field, the old scan skipped it as if it were an ordinary dependency:
 * the profile then printed "no plugins installed" and exited 0 even though the
 * app could not mount the bundle. The CLI-level trials below pin every side of
 * the boundary: the broken declared bundle fails with a `dsh field` row, a
 * declared bundle that does carry a `dsh` field still exits 0 as the healthy
 * control, and a profile with only undeclared ordinary dependencies still
 * reports no plugins and exits 0.
 *
 * The ghost trial's failure message names `ghost_rows` and `exit` because that
 * is the shape of the regression: on 0.20.42 the same home prints
 * `ghost_rows=0 exit=0`, so a future omission cannot pass as a clean profile.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');

function runAudit(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function outputOf(result) {
  return `${result.stdout}\n${result.stderr}`;
}

/** How many report rows the scan printed for one package name. */
function rowsFor(stdout, name) {
  return stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(`${name} `))
    .length;
}

function writeProfile(home, bundles) {
  const profile = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'desktop', private: true, dsh: { profile: { bundles } } }, null, 2),
  );
  return profile;
}

function writePackage(profile, name, manifest, files = {}) {
  const dir = path.join(profile, 'node_modules', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}

test('a declared bundle with no dsh field prints its row and exits 1', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-home-no-dsh-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = writeProfile(home, ['broken-bundle']);
  // Parses cleanly, so it is not an unreadable-install row; it simply has no
  // plugin declaration. The profile still says the loader mounts it.
  writePackage(profile, 'broken-bundle', { name: 'broken-bundle', version: '1.0.0' });

  const result = runAudit(['audit', '--home', home, '--timeout', '50']);
  const output = outputOf(result);
  // This is the regression signature from 0.20.42: the old scan omitted the
  // declared package, printed "no plugins installed", and exited 0. Keep both
  // numbers in the assertion message so a reintroduced omission reports itself
  // as ghost_rows=0 exit=0 instead of only a mismatched string.
  const ghostRows = rowsFor(result.stdout, 'broken-bundle');
  const diagnosis = `ghost_rows=${ghostRows} exit=${result.status}`;
  assert.equal(result.status, 1, `${diagnosis}\n${output}`);
  assert.equal(ghostRows, 1, `${diagnosis}\n${output}`);
  assert.match(result.stdout, /^broken-bundle\s+1\.0\.0\s+no dsh field\b/mu);
  assert.match(output, /dsh field: package\.json has no "dsh" field/u);
  assert.match(output, /1 of 1 installed plugin\(s\) have problems/u);
  assert.doesNotMatch(output, /no plugins installed/u);
});

test('a declared bundle with a dsh field is the healthy control and exits 0', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-home-no-dsh-valid-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = writeProfile(home, ['good-bundle']);
  // The accepting side of the same boundary: the profile declares the bundle
  // and the manifest carries the dsh field the loader needs, so the exact scan
  // that reports the ghost row above must leave this one clean.
  writePackage(
    profile,
    'good-bundle',
    {
      name: 'good-bundle',
      version: '1.0.0',
      engines: { dsh: '>=0.2.0' },
      exports: { '.': './index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    },
    {
      'index.js': 'export function apply() {}\n',
      'cordis.patch.yml': '- insert: []\n',
      'README.md': '# good-bundle\n\n## Requirements\n\n`>=0.2.0`\n',
    },
  );

  const result = runAudit(['audit', '--home', home, '--timeout', '50']);
  const output = outputOf(result);
  const validRows = rowsFor(result.stdout, 'good-bundle');
  const diagnosis = `valid_rows=${validRows} exit=${result.status}`;
  assert.equal(result.status, 0, `${diagnosis}\n${output}`);
  assert.equal(validRows, 1, `${diagnosis}\n${output}`);
  assert.match(result.stdout, /^good-bundle\s+1\.0\.0\s+\?\s+ok$/mu);
  assert.doesNotMatch(output, /dsh field/u);
  assert.doesNotMatch(output, /no plugins installed/u);
});

test('a profile with only undeclared ordinary dependencies still exits 0', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-home-no-dsh-clean-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = writeProfile(home, []);
  writePackage(profile, 'left-pad', { name: 'left-pad', version: '1.3.0' });
  writePackage(profile, 'another-dependency', { name: 'another-dependency', version: '2.0.0' });

  const result = runAudit(['audit', '--home', home, '--timeout', '50']);
  const output = outputOf(result);
  const unlistedRows = rowsFor(result.stdout, 'left-pad') + rowsFor(result.stdout, 'another-dependency');
  const diagnosis = `unlisted_rows=${unlistedRows} exit=${result.status}`;
  assert.equal(result.status, 0, `${diagnosis}\n${output}`);
  assert.equal(unlistedRows, 0, `${diagnosis}\n${output}`);
  assert.match(result.stdout, /no plugins installed/u);
  assert.doesNotMatch(output, /left-pad|another-dependency/u);
  assert.doesNotMatch(output, /dsh field/u);
});
