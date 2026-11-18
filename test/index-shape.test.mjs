/**
 * `index` has to reject an index whose shape cannot be audited, before it
 * reads `engines.dsh` from the entries.
 *
 * The failure this pins is a false clean or a raw TypeError: a plugin without
 * `versions` used to disappear from the loop, a `versions` string was treated
 * as an empty array, and a top-level shape without `plugins` printed nothing
 * and exited `0`. The command must instead exit `1`, name the file, and name
 * the plugin or entry that needs fixing; a valid index still prints `ok`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateIndex } from '../lib/index-file.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');

function indexWith(plugin) {
  return { formatVersion: 1, plugins: [plugin] };
}

function validPlugin(name = 'demo-plugin') {
  return {
    name,
    versions: [
      {
        version: '1.2.0',
        publishTimestamp: 1,
        source: { type: 'npm' },
        engines: { dsh: '>=0.2.0' },
      },
    ],
  };
}

function runIndex(indexFile) {
  return spawnSync(process.execPath, [BIN, 'index', indexFile], { encoding: 'utf8' });
}

function writeIndex(dir, document) {
  const indexFile = path.join(dir, 'index.json');
  fs.writeFileSync(indexFile, `${JSON.stringify(document, null, 2)}\n`);
  return indexFile;
}

test('validateIndex accepts the valid shape and every valid SemVer form', () => {
  const valid = indexWith(validPlugin());
  valid.plugins[0].versions.push(
    { version: '1.2.3-rc.1', engines: { dsh: '>=0.2.0' } },
    { version: '1.2.3+build.5', engines: { dsh: '>=0.2.0' } },
    { version: '1.2.3-rc.1+sha.abc', engines: { dsh: '>=0.2.0' } },
  );
  assert.deepEqual(validateIndex(valid), []);
});

test('validateIndex names the top-level index and plugin shape problems', () => {
  const cases = [
    { document: null, entry: /^index$/u, problem: /not a JSON object/u },
    { document: [], entry: /^index$/u, problem: /not a JSON object/u },
    { document: {}, entry: /^plugins$/u, problem: /no "plugins" array/u },
    { document: { plugins: 'demo-plugin' }, entry: /^plugins$/u, problem: /not an array/u },
    { document: { plugins: [null] }, entry: /^plugins\[0\]$/u, problem: /not an object/u },
  ];
  for (const fixture of cases) {
    const findings = validateIndex(fixture.document);
    assert.equal(findings.length, 1, JSON.stringify(fixture.document));
    assert.match(findings[0].entry, fixture.entry);
    assert.match(findings[0].problem, fixture.problem);
  }

  const unnamed = validateIndex({ plugins: [{ versions: [] }] });
  assert.deepEqual(
    unnamed.map((finding) => finding.entry),
    ['plugins[0]'],
  );
  assert.match(unnamed[0].problem, /no "name"/u);
});

test('validateIndex names a plugin without a versions array and a versions string', () => {
  const missing = validateIndex(indexWith({ name: 'no-versions' }));
  assert.equal(missing.length, 1);
  assert.equal(missing[0].entry, 'no-versions');
  assert.match(missing[0].problem, /has no "versions" array/u);

  const stringly = validateIndex(indexWith({ name: 'stringly-versions', versions: '1.2.0' }));
  assert.equal(stringly.length, 1);
  assert.equal(stringly[0].entry, 'stringly-versions');
  assert.match(stringly[0].problem, /"versions" is not an array/u);
});

test('validateIndex names the entry when version is missing or not SemVer', () => {
  const missing = validateIndex(indexWith({ name: 'no-version', versions: [{ engines: { dsh: '>=0.2.0' } }] }));
  assert.equal(missing.length, 1);
  assert.equal(missing[0].entry, 'no-version versions[0]');
  assert.match(missing[0].problem, /no "version"/u);

  const nonString = validateIndex(indexWith({ name: 'number-version', versions: [{ version: 12 }] }));
  assert.equal(nonString.length, 1);
  assert.equal(nonString[0].entry, 'number-version versions[0]');
  assert.match(nonString[0].problem, /not a non-empty string/u);

  for (const version of ['banana', '1.2', '01.2.3', '1.2.3-01', 'v1.2.3', '1.2.3+build..1']) {
    const findings = validateIndex(indexWith({ name: 'bad-version', versions: [{ version }] }));
    assert.equal(findings.length, 1, version);
    assert.equal(findings[0].entry, `bad-version@${version}`);
    assert.match(findings[0].problem, /is not semver/u, version);
  }
});

test('the CLI exits 1 and names the file and plugin for a missing versions array', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-index-shape-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const indexFile = writeIndex(dir, indexWith({ name: 'no-versions' }));

  const result = runIndex(indexFile);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, output);
  assert.ok(result.stderr.includes(indexFile), output);
  assert.match(result.stderr, /no-versions/u);
  assert.match(result.stderr, /versions/u);
  assert.doesNotMatch(output, /TypeError/u);
  assert.doesNotMatch(result.stdout, /^ok\b/mu);
});

test('the CLI exits 1 and names the file and plugin when versions is a string', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-index-shape-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const indexFile = writeIndex(dir, indexWith({ name: 'stringly-versions', versions: '1.2.0' }));

  const result = runIndex(indexFile);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, output);
  assert.ok(result.stderr.includes(indexFile), output);
  assert.match(result.stderr, /stringly-versions/u);
  assert.match(result.stderr, /"versions" is not an array/u);
  assert.doesNotMatch(output, /TypeError/u);
  assert.doesNotMatch(result.stdout, /^ok\b/mu);
});

test('the CLI exits 1 and names the entry when version is missing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-index-shape-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const indexFile = writeIndex(
    dir,
    indexWith({ name: 'no-version', versions: [{ engines: { dsh: '>=0.2.0' } }] }),
  );

  const result = runIndex(indexFile);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, output);
  assert.ok(result.stderr.includes(indexFile), output);
  assert.match(result.stderr, /no-version/u);
  assert.match(result.stderr, /versions\[0\]/u);
  assert.match(result.stderr, /no "version"/u);
  assert.doesNotMatch(output, /TypeError/u);
  assert.doesNotMatch(result.stdout, /^ok\b/mu);
});

test('the CLI exits 1 and names the plugin and bad version when version is not SemVer', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-index-shape-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const indexFile = writeIndex(
    dir,
    indexWith({ name: 'bad-version', versions: [{ version: '1.2', engines: { dsh: '>=0.2.0' } }] }),
  );

  const result = runIndex(indexFile);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, output);
  assert.ok(result.stderr.includes(indexFile), output);
  assert.match(result.stderr, /bad-version@1\.2/u);
  assert.match(result.stderr, /is not semver/u);
  assert.doesNotMatch(output, /TypeError/u);
  assert.doesNotMatch(result.stdout, /^ok\b/mu);
});

test('the CLI exits 1 for a missing plugins array and invalid JSON instead of crashing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-index-shape-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let indexFile = writeIndex(dir, { formatVersion: 1 });
  let result = runIndex(indexFile);
  let output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, output);
  assert.ok(result.stderr.includes(indexFile), output);
  assert.match(result.stderr, /"plugins"/u);
  assert.doesNotMatch(output, /TypeError/u);

  indexFile = path.join(dir, 'invalid.json');
  fs.writeFileSync(indexFile, '{ not json\n');
  result = runIndex(indexFile);
  output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, output);
  assert.ok(result.stderr.includes(indexFile), output);
  assert.doesNotMatch(output, /TypeError/u);
});

test('the CLI exits 1 and names a missing index file instead of crashing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-index-shape-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const indexFile = path.join(dir, 'missing.json');

  const result = runIndex(indexFile);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, output);
  assert.ok(result.stderr.includes(indexFile), output);
  assert.match(result.stderr, /dsh-plugin index:/u);
  assert.doesNotMatch(output, /TypeError/u);
  assert.doesNotMatch(output, /\n\s+at /u);
  assert.doesNotMatch(result.stdout, /^ok\b/mu);
});

test('the CLI still exits 0 with its ok line for a valid market index', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-index-shape-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'market'), { recursive: true });
  const indexFile = path.join(dir, 'market', 'index.json');
  fs.writeFileSync(indexFile, `${JSON.stringify(indexWith(validPlugin()), null, 2)}\n`);

  const result = runIndex(indexFile);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /^ok\s+demo-plugin: 1 version\(s\) all carry engines\.dsh$/mu);
});
