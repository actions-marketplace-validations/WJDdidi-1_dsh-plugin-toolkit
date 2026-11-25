/**
 * The real `release` runs the index preflight before it creates a tag.
 *
 * `release --dry-run` already refuses to print a tag step for an index that
 * `index` rejects. The real command has to stop at the same point: a tag is the
 * irreversible half of a release, so finding the malformed index afterwards
 * would mean patching a published release by hand. These tests pin the three
 * malformed shapes the dry-run test uses, confirm git is never asked to tag
 * when the index is rejected, and keep a valid index on the normal path.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { release } from '../lib/release.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const GOOD = path.join(here, 'fixtures', 'good');

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tags(dir) {
  const output = git(dir, ['tag', '--list']);
  return output === '' ? [] : output.split('\n').sort();
}

function pluginRepo(t, indexDocument) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-index-'));
  const dir = path.join(root, 'plugin');
  const origin = path.join(root, 'origin.git');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--bare', origin], { cwd: root, stdio: 'pipe' });
  fs.cpSync(GOOD, dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'market'), { recursive: true });
  const indexFile = path.join(dir, 'market', 'index.json');
  fs.writeFileSync(indexFile, `${JSON.stringify(indexDocument, null, 2)}\n`);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['remote', 'add', 'origin', origin]);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'one']);
  return { dir, origin, indexFile };
}

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8' });
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
      plugins: [{ name: 'demo-plugin', versions: '1.2.3' }],
    },
    finding: /"versions" is not an array/u,
  },
  {
    name: 'a version entry without engines.dsh',
    document: {
      formatVersion: 1,
      plugins: [{
        name: 'demo-plugin',
        versions: [{ version: '1.2.3', publishTimestamp: 1, source: { type: 'npm' } }],
      }],
    },
    finding: /no engines\.dsh/u,
  },
];

test('the real release stops at the index preflight and never calls git', async (t) => {
  for (const fixture of malformed) {
    const { dir, indexFile } = pluginRepo(t, fixture.document);
    const before = fs.readFileSync(indexFile, 'utf8');
    let gitCalls = 0;

    const result = await release({
      dir,
      git: () => {
        gitCalls += 1;
        return '';
      },
      fetch: async () => {
        throw new Error('the registry should not be reached');
      },
      sleep: async () => {},
    });

    assert.equal(result.ok, false, fixture.name);
    assert.equal(result.stage, 'index', fixture.name);
    assert.equal(result.indexReport.ok, false, fixture.name);
    assert.match(result.failures[0].message, fixture.finding, fixture.name);
    assert.equal(gitCalls, 0, `${fixture.name}: release must not create or inspect a tag`);
    assert.equal(fs.readFileSync(indexFile, 'utf8'), before, `${fixture.name}: the index must not be written`);
  }
});

test('the CLI exits 1 with the index finding and leaves git tag -l empty', (t) => {
  const { dir, indexFile } = pluginRepo(t, { formatVersion: 1 });

  const indexed = run(['index', indexFile]);
  assert.equal(indexed.status, 1, `${indexed.stdout}${indexed.stderr}`);

  const released = run(['release', dir]);
  const output = `${released.stdout}\n${released.stderr}`;
  assert.equal(released.status, 1, output);
  // The same lines `index` prints: the real release cannot disagree with the
  // command whose verdict it relies on.
  assert.equal(released.stderr, indexed.stderr);
  assert.deepEqual(tags(dir), []);
});

test('a clean index proceeds to the tag step and writes the entry', async (t) => {
  const { dir, indexFile } = pluginRepo(t, {
    formatVersion: 1,
    plugins: [{ name: 'demo-plugin', versions: [] }],
  });
  const timestamp = '2026-11-05T12:00:00.000Z';

  const result = await release({
    dir,
    fetch: async () => ({
      status: 200,
      ok: true,
      json: async () => ({ versions: { '1.2.3': {} }, time: { '1.2.3': timestamp } }),
    }),
    sleep: async () => {},
  });

  assert.equal(result.ok, true, JSON.stringify(result.failures ?? []));
  assert.equal(result.tag, 'plugin-v1.2.3');
  assert.deepEqual(tags(dir), ['plugin-v1.2.3']);
  const written = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  assert.equal(written.plugins[0].versions[0].version, '1.2.3');
});
