/**
 * A profile whose `dsh.profile.bundles` is not a list of plugin names is not an
 * empty profile.
 *
 * The reader used to fall back to `[]` for any non-array value and for arrays
 * whose entries were not strings. A profile saved with `"bundles":
 * "ghost-plugin"`, `"bundles": {"ghost-plugin": true}` or `"bundles": [42]`
 * therefore scanned as a profile with no plugins: `audit --home` printed "no
 * plugins installed in any profile" and exited `0`, hiding the damaged profile.
 * The same empty list is now carried with an error so `listInstalled` emits an
 * `unreadable profile` row and the audit names the profile file and exits `1`.
 *
 * The valid `["ghost-plugin"]` control keeps the other half honest: a readable
 * list that names a missing install is still a `missing` row, not a profile
 * finding, so the new shape check does not swallow the existing repair.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { listInstalled, readProfileBundles } from '../lib/audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const EMPTY = 'no plugins installed in any profile';
const MALFORMED = [
  ['a string', '"ghost-plugin"'],
  ['an object', '{"ghost-plugin":true}'],
  ['a number inside an array', '[42]'],
];

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-home-malformed-bundles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeProfile(home, bundlesLiteral) {
  const dir = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  const file = path.join(dir, 'package.json');
  fs.writeFileSync(
    file,
    `{\n  "name": "desktop",\n  "private": true,\n  "dsh": { "profile": { "bundles": ${bundlesLiteral} } }\n}\n`,
  );
  return file;
}

function runAudit(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('each malformed bundles shape exits 1, names the profile, and prints no empty profile line', (t) => {
  const home = scratch(t);

  for (const [label, literal] of MALFORMED) {
    const profileFile = writeProfile(home, literal);
    const result = runAudit(['audit', '--home', home, '--timeout', '50']);
    const output = `${result.stdout}\n${result.stderr}`;
    const diagnosis = `${label}: exit=${result.status}\n${output}`;

    assert.equal(result.status, 1, diagnosis);
    assert.ok(output.includes(profileFile), `the finding must name ${profileFile}\n${diagnosis}`);
    assert.match(output, /unreadable profile/u, diagnosis);
    assert.match(output, /profile manifest:/u, diagnosis);
    assert.match(output, /does not hold a dsh\.profile\.bundles list of plugin names/u, diagnosis);
    assert.ok(
      output.includes(`got ${literal}`),
      `the finding must quote the malformed value ${literal}\n${diagnosis}`,
    );
    assert.doesNotMatch(output, new RegExp(EMPTY, 'u'), `the malformed profile was reported as empty\n${diagnosis}`);
  }
});

test('the library reports a malformed bundles list instead of an empty profile', (t) => {
  const home = scratch(t);

  for (const [label, literal] of MALFORMED) {
    const profileFile = writeProfile(home, literal);
    const profile = readProfileBundles({ home, profile: 'desktop' });
    assert.deepEqual(profile.bundles, [], `${label}: callers that only read bundles still get the empty list`);
    assert.match(profile.error, /does not hold a dsh\.profile\.bundles list of plugin names/u, label);

    const found = listInstalled({ home });
    assert.ok(
      found.some(
        (entry) => entry.profileUnreadable === true && entry.manifestPath === profileFile,
      ),
      `${label}: the scan must produce a profile row for ${profileFile}`,
    );
  }
});

test('a valid bundles list naming a missing install is still the missing-install control', (t) => {
  const home = scratch(t);
  writeProfile(home, '["ghost-plugin"]');
  const missingDir = path.join(home, 'profiles', 'desktop', 'node_modules', 'ghost-plugin');

  const result = runAudit(['audit', '--home', home, '--timeout', '50']);
  const output = `${result.stdout}\n${result.stderr}`;
  const diagnosis = `exit=${result.status}\n${output}`;

  assert.equal(result.status, 1, diagnosis);
  assert.match(output, /^ghost-plugin\s+\?\s+missing\b/mu, diagnosis);
  assert.match(output, /install:/u, diagnosis);
  assert.ok(output.includes(missingDir), `the missing install must name ${missingDir}\n${diagnosis}`);
  assert.doesNotMatch(output, /unreadable profile/u, diagnosis);
  assert.doesNotMatch(output, new RegExp(EMPTY, 'u'), diagnosis);
});

test('a valid empty bundles list still exits 0 with the empty-profile line', (t) => {
  const home = scratch(t);
  writeProfile(home, '[]');

  const result = runAudit(['audit', '--home', home, '--timeout', '50']);
  const output = `${result.stdout}\n${result.stderr}`;
  const diagnosis = `exit=${result.status}\n${output}`;

  assert.equal(result.status, 0, diagnosis);
  assert.match(result.stdout, new RegExp(EMPTY, 'u'), diagnosis);
  assert.doesNotMatch(output, /unreadable profile/u, diagnosis);
  assert.equal(result.stderr, '', diagnosis);
});
