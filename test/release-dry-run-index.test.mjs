/**
 * `release --dry-run` must not promise to patch an index that `index` rejects.
 *
 * The dry run used to print the whole sequence, including `git tag`, without
 * ever reading `market/index.json`. The three malformed indexes below are the
 * shapes the index command already rejects: a missing `plugins` array, a
 * plugin whose `versions` is not an array, and a version entry without
 * `engines.dsh`. For each one the dry run has to exit `1` with the exact
 * finding `index` prints, and it must not print a tag step. A valid index still
 * plans the release, including the tag step.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { plan } from '../lib/release.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const GOOD = path.join(here, 'fixtures', 'good');

function run(args, cwd = ROOT) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
}

function pluginRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-dry-index-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(GOOD, dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'market'), { recursive: true });
  return dir;
}

function writeIndex(dir, document) {
  const file = path.join(dir, 'market', 'index.json');
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  return file;
}

function validIndex() {
  return {
    formatVersion: 1,
    plugins: [{
      name: 'demo-plugin',
      versions: [{
        version: '1.2.0',
        publishTimestamp: 1,
        source: { type: 'npm' },
        engines: { dsh: '>=0.2.0' },
      }],
    }],
  };
}

const malformed = [
  {
    name: 'a missing plugins array',
    document: { formatVersion: 1 },
    finding: /no "plugins" array/u,
  },
  {
    name: 'a versions field that is not an array',
    document: {
      formatVersion: 1,
      plugins: [{ name: 'demo-plugin', versions: '1.2.0' }],
    },
    finding: /"versions" is not an array/u,
  },
  {
    name: 'a version entry without engines.dsh',
    document: {
      formatVersion: 1,
      plugins: [{
        name: 'demo-plugin',
        versions: [{ version: '1.2.0', publishTimestamp: 1, source: { type: 'npm' } }],
      }],
    },
    finding: /no engines\.dsh/u,
  },
];

test('a malformed market index stops the dry run with the index finding and no tag step', (t) => {
  for (const fixture of malformed) {
    const dir = pluginRepo(t);
    const indexFile = writeIndex(dir, fixture.document);

    const indexed = run(['index', indexFile]);
    assert.equal(indexed.status, 1, `${fixture.name}: ${indexed.stdout}${indexed.stderr}`);
    assert.match(indexed.stderr, fixture.finding, fixture.name);

    const release = run(['release', dir, '--dry-run']);
    const output = `${release.stdout}\n${release.stderr}`;
    assert.equal(release.status, 1, `${fixture.name}: ${output}`);
    // The same lines, not a second wording: the two commands cannot disagree
    // about which plugin or version is broken.
    assert.equal(release.stderr, indexed.stderr, fixture.name);
    assert.doesNotMatch(release.stdout, /\bgit tag\b/u, fixture.name);
    assert.doesNotMatch(output, /Create the tag/u, fixture.name);
  }
});

test('a valid market index still plans the release and its tag step', (t) => {
  const dir = pluginRepo(t);
  writeIndex(dir, validIndex());

  const indexed = run(['index', path.join(dir, 'market', 'index.json')]);
  assert.equal(indexed.status, 0, `${indexed.stdout}${indexed.stderr}`);

  const release = run(['release', dir, '--dry-run']);
  const output = `${release.stdout}${release.stderr}`;
  assert.equal(release.status, 0, output);
  assert.match(release.stdout, /Create the tag plugin-v1\.2\.3/u);
  assert.match(release.stdout, /git tag plugin-v1\.2\.3/u);
  assert.doesNotMatch(release.stderr, /✗/u);
});

test('--market validates the index it would patch, not a local one', (t) => {
  const dir = pluginRepo(t);
  fs.rmSync(path.join(dir, 'market'), { recursive: true, force: true });
  const market = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-dry-market-'));
  t.after(() => fs.rmSync(market, { recursive: true, force: true }));
  fs.mkdirSync(path.join(market, 'market'));
  const indexFile = path.join(market, 'market', 'index.json');
  fs.writeFileSync(indexFile, JSON.stringify({ formatVersion: 1 }));

  const indexed = run(['index', market]);
  assert.equal(indexed.status, 1, `${indexed.stdout}${indexed.stderr}`);

  const release = run(['release', dir, '--dry-run', '--market', market]);
  const output = `${release.stdout}\n${release.stderr}`;
  assert.equal(release.status, 1, output);
  assert.equal(release.stderr, indexed.stderr, 'the finding has to name the market index');
  assert.doesNotMatch(release.stdout, /\bgit tag\b/u);
  assert.ok(release.stderr.includes(indexFile), output);
});

test('an invalid --index is validated from the dry-run plan too', (t) => {
  const dir = pluginRepo(t);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-dry-named-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const indexFile = path.join(other, 'index.json');
  fs.writeFileSync(indexFile, JSON.stringify(validIndex()).replace('"engines":{"dsh":">=0.2.0"}', '"engines":{"dsh":"not-a-range"}'));

  const release = run(['release', dir, '--dry-run', '--index', indexFile]);
  const output = `${release.stdout}\n${release.stderr}`;
  assert.equal(release.status, 1, output);
  assert.match(release.stderr, /not a semver range/u, output);
  assert.doesNotMatch(release.stdout, /\bgit tag\b/u);
});

test('plan reports the rejected index instead of a tag sequence', (t) => {
  const dir = pluginRepo(t);
  writeIndex(dir, { formatVersion: 1 });

  const planned = plan({ dir });
  assert.equal(planned.tag, null);
  assert.deepEqual(planned.steps, []);
  assert.equal(planned.indexReport.ok, false);
  assert.match(planned.failures[0].message, /no "plugins" array/u);

  // A checkout with no index at all is not an index failure: the real release
  // also only writes an index that is present.
  const withoutIndex = pluginRepo(t);
  fs.rmSync(path.join(withoutIndex, 'market'), { recursive: true, force: true });
  const bare = plan({ dir: withoutIndex });
  assert.equal(bare.tag, 'plugin-v1.2.3');
  assert.ok(bare.steps.some((step) => step.command === 'git tag plugin-v1.2.3'));
});
