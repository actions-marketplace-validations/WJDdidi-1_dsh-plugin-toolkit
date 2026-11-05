import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { addVersion, auditVersions, buildEntry, findPlugin } from '../lib/index-file.mjs';
import { run } from '../lib/cli.mjs';

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
