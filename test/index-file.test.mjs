import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { addVersion, auditVersions, buildEntry, findPlugin } from '../lib/index-file.mjs';
import { run } from '../lib/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'dsh-plugin.mjs');

const index = () => ({
  formatVersion: 1,
  plugins: [
    {
      name: 'demo-plugin',
      title: 'Demo',
      metadata: { labels: ['no-network'] },
      versions: [
        { version: '1.2.0', publishTimestamp: 1790000000, source: { type: 'npm' }, engines: { dsh: '>=0.2.0' } },
      ],
    },
  ],
});

test('a new version goes to the front, with the host range attached', () => {
  const next = addVersion(index(), 'demo-plugin', buildEntry({ version: '1.2.3', publishTimestamp: 1793400000, hostRange: '>=0.2.0' }));
  const versions = findPlugin(next, 'demo-plugin').versions;
  assert.equal(versions[0].version, '1.2.3');
  assert.equal(versions[0].engines.dsh, '>=0.2.0');
  assert.equal(versions[0].publishTimestamp, 1793400000);
  assert.deepEqual(versions[0].source, { type: 'npm' });
});

test('publishing the same version twice is refused', () => {
  assert.throws(() => addVersion(index(), 'demo-plugin', buildEntry({ version: '1.2.0', publishTimestamp: 1, hostRange: '>=0.2.0' })), /already/);
});

test('the audit finds versions that cannot state a host requirement', () => {
  const stale = index();
  stale.plugins[0].versions.push({ version: '1.2.1', publishTimestamp: 2, source: { type: 'npm' } });
  assert.deepEqual(auditVersions(stale, 'demo-plugin').map((version) => version.version), ['1.2.1']);
  assert.deepEqual(auditVersions(index(), 'demo-plugin'), []);
});

test('an unknown plugin name is an error, not a silent no-op', () => {
  assert.throws(() => addVersion(index(), 'other-plugin', buildEntry({ version: '1.0.0', publishTimestamp: 1, hostRange: '>=0.2.0' })), /other-plugin/);
});

test('a version whose engines.dsh is not a semver range is a finding', () => {
  const malformed = index();
  malformed.plugins[0].versions[0].engines.dsh = '>=banana';
  const pinned = index();
  pinned.plugins[0].versions[0].engines.dsh = '0.2.0';

  for (const fixture of [malformed, pinned]) {
    const findings = auditVersions(fixture, 'demo-plugin');
    assert.deepEqual(findings.map((finding) => finding.version), ['1.2.0']);
    assert.match(findings[0].problem, /not a semver range/u);
  }
  assert.throws(
    () => buildEntry({ version: '1.2.3', publishTimestamp: 1793400000, hostRange: '>=banana' }),
    /not a semver range/u,
  );
  assert.throws(
    () =>
      addVersion(index(), 'demo-plugin', {
        version: '1.2.3',
        publishTimestamp: 1793400000,
        engines: { dsh: '>=banana' },
      }),
    /not a semver range/u,
  );
});

test('the index command exits 1 for a market entry whose engines.dsh is not a range', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-index-'));
  fs.mkdirSync(path.join(dir, 'market'), { recursive: true });
  const indexFile = path.join(dir, 'market', 'index.json');
  fs.writeFileSync(
    indexFile,
    JSON.stringify({
      formatVersion: 1,
      plugins: [
        {
          name: 'bad-plugin',
          versions: [
            { version: '1.0.0', publishTimestamp: 1, source: { type: 'npm' }, engines: { dsh: '>=banana' } },
          ],
        },
      ],
    }),
  );
  const lines = [];
  const io = { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
  assert.equal(await run(['index', dir], io), 1);
  assert.match(lines.join('\n'), /not a semver range/u);
});

test('the index command accepts a file path and names the version and value it rejects', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-index-file-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const indexFile = path.join(dir, 'index.json');
  const writeIndexFile = (range) => {
    fs.writeFileSync(
      indexFile,
      JSON.stringify({
        formatVersion: 1,
        plugins: [
          {
            name: 'demo-plugin',
            versions: [
              { version: '1.2.0', publishTimestamp: 1, source: { type: 'npm' }, engines: { dsh: range } },
            ],
          },
        ],
      }),
    );
  };
  const runIndex = async () => {
    const lines = [];
    const io = { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
    return { code: await run(['index', indexFile], io), output: lines.join('\n') };
  };

  // The acceptance case: the file itself is the argument, not its directory.
  writeIndexFile('>=banana');
  let result = await runIndex();
  assert.equal(result.code, 1);
  assert.match(result.output, /demo-plugin/u);
  assert.match(result.output, /1\.2\.0/u);
  assert.match(result.output, /engines\.dsh ">=banana" is not a semver range/u);

  // A pin is a complete version, not a span the index can repeat.
  writeIndexFile('0.2.0');
  result = await runIndex();
  assert.equal(result.code, 1);
  assert.match(result.output, /1\.2\.0/u);
  assert.match(result.output, /engines\.dsh "0\.2\.0" is not a semver range/u);

  // The same entry with a real range is clean and exits 0.
  writeIndexFile('>=0.2.0');
  result = await runIndex();
  assert.equal(result.code, 0);
  assert.match(result.output, /ok\s+demo-plugin: 1 version\(s\) all carry engines\.dsh/u);
});

test('creating a market entry with a pinned range is refused, like the audit', () => {
  assert.throws(
    () => buildEntry({ version: '1.2.3', publishTimestamp: 1793400000, hostRange: '0.2.0' }),
    /not a semver range/u,
  );
  assert.throws(
    () =>
      addVersion(index(), 'demo-plugin', {
        version: '1.2.3',
        publishTimestamp: 1793400000,
        engines: { dsh: '0.2.0' },
      }),
    /not a semver range/u,
  );
});

test('the shipped CLI process answers the index question, not just the run() helper', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-index-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const indexFile = path.join(dir, 'market', 'index.json');
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  const writeIndexFile = (range) => {
    fs.writeFileSync(
      indexFile,
      JSON.stringify({
        formatVersion: 1,
        plugins: [
          {
            name: 'demo-plugin',
            versions: [
              { version: '1.2.0', publishTimestamp: 1, source: { type: 'npm' }, engines: { dsh: range } },
            ],
          },
        ],
      }),
    );
  };
  const runIndex = () => spawnSync(process.execPath, [CLI, 'index', indexFile], { encoding: 'utf8' });

  // The malformed value has to fail the process, not just produce a finding.
  writeIndexFile('>=banana');
  let result = runIndex();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /engines\.dsh ">=banana" is not a semver range/u);
  assert.doesNotMatch(result.stdout, /^ok\b/mu);

  // A pinned version is not a range the index can repeat either.
  writeIndexFile('0.2.0');
  result = runIndex();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /engines\.dsh "0\.2\.0" is not a semver range/u);
  assert.doesNotMatch(result.stdout, /^ok\b/mu);

  // The same entry with a real range prints ok and exits 0.
  writeIndexFile('>=0.2.0');
  result = runIndex();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok\s+demo-plugin: 1 version\(s\) all carry engines\.dsh$/mu);
});
