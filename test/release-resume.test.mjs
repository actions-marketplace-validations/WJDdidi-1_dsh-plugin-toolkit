import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { release } from '../lib/release.mjs';
import { run } from '../lib/cli.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'good');

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function releaseRepo(version = '1.0.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-resume-'));
  const origin = path.join(root, 'origin.git');
  const dir = path.join(root, 'plugin');
  execFileSync('git', ['init', '-q', '--bare', origin], { cwd: root, stdio: 'pipe' });
  fs.cpSync(fixture, dir, { recursive: true });

  const manifestPath = path.join(dir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = version;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  fs.mkdirSync(path.join(dir, 'market'));
  fs.writeFileSync(path.join(dir, 'market/index.json'), `${JSON.stringify({
    format: 1,
    plugins: [{ name: manifest.name, versions: [] }],
  }, null, 2)}\n`);

  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['remote', 'add', 'origin', origin]);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'one']);
  return { dir, origin, manifest, version };
}

function tags(dir) {
  const output = git(dir, ['tag', '--list']);
  return output === '' ? [] : output.split('\n').sort();
}

function tagHash(dir, tag) {
  return git(dir, ['rev-parse', `refs/tags/${tag}`]);
}

function readVersions(dir, name) {
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'market/index.json'), 'utf8'));
  return index.plugins.find((plugin) => plugin.name === name).versions;
}

const registryMiss = async () => ({ status: 404, ok: false, json: async () => ({}) });
const registryHit = (version, timestamp) => async () => ({
  status: 200,
  ok: true,
  json: async () => ({ versions: { [version]: {} }, time: { [version]: timestamp } }),
});

test('a second release resumes when the existing tag points at HEAD', async () => {
  const { dir, origin, manifest, version } = releaseRepo();
  const tag = `plugin-v${version}`;
  const timestamp = '2026-11-05T12:00:00.000Z';

  // First run: the tag and push succeed, then the registry has no package yet.
  const first = await release({ dir, fetch: registryMiss, sleep: async () => {} });
  assert.equal(first.ok, false, JSON.stringify(first.failures ?? []));
  assert.equal(first.stage, 'registry');
  assert.deepEqual(tags(dir), [tag]);
  assert.deepEqual(tags(origin), [tag]);
  assert.deepEqual(readVersions(dir, manifest.name), []);

  const localTag = tagHash(dir, tag);
  const remoteTag = tagHash(origin, tag);

  // Second run: npm now serves the version. The tag must not move, and the
  // index must get exactly one entry for it.
  const second = await release({
    dir,
    fetch: registryHit(version, timestamp),
    sleep: async () => {},
  });
  assert.equal(second.ok, true, JSON.stringify(second.failures ?? []));
  assert.equal(second.tag, tag);
  assert.equal(second.indexUpdate.unchanged, undefined);

  const versions = readVersions(dir, manifest.name);
  assert.equal(versions.filter((entry) => entry.version === version).length, 1);
  assert.equal(versions[0].version, version);
  assert.equal(versions[0].publishTimestamp, Math.floor(Date.parse(timestamp) / 1000));
  assert.deepEqual(tags(dir), [tag]);
  assert.deepEqual(tags(origin), [tag]);
  assert.equal(tagHash(dir, tag), localTag);
  assert.equal(tagHash(origin, tag), remoteTag);
});

test('the CLI finishes the release after the first run stopped at the registry', async () => {
  const { dir, origin, manifest, version } = releaseRepo();
  const tag = `plugin-v${version}`;
  const timestamp = '2026-11-05T12:00:00.000Z';

  // First run: the CLI tags and pushes, then the registry has no package. This
  // is the state the shipped 0.19.0 left behind: `plugin-v1.0.0` is public and
  // the index has no entry.
  const firstLines = [];
  const originalFetch = globalThis.fetch;
  let firstCode;
  try {
    globalThis.fetch = registryMiss;
    firstCode = await run(['release', dir], {
      log: (line) => firstLines.push(String(line)),
      error: (line) => firstLines.push(String(line)),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(firstCode, 1, firstLines.join('\n'));
  const firstOutput = firstLines.join('\n');
  assert.match(firstOutput, /dsh-plugin release stopped at registry/u);
  assert.match(firstOutput, /has no package named demo-plugin/u);
  assert.deepEqual(tags(dir), [tag]);
  assert.deepEqual(tags(origin), [tag]);
  assert.deepEqual(readVersions(dir, manifest.name), []);

  const localTag = tagHash(dir, tag);
  const remoteTag = tagHash(origin, tag);

  // Second run: npm now serves the version. The pre-existing tag must be
  // reused rather than treated as a reason to stop, and the index entry must
  // be written from the registry's publish time.
  const secondLines = [];
  let secondCode;
  try {
    globalThis.fetch = registryHit(version, timestamp);
    secondCode = await run(['release', dir], {
      log: (line) => secondLines.push(String(line)),
      error: (line) => secondLines.push(String(line)),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(secondCode, 0, secondLines.join('\n'));
  const secondOutput = secondLines.join('\n');
  assert.ok(secondOutput.includes(`tagged ${tag}, npm served ${manifest.name}@${version}`), secondOutput);
  assert.ok(secondOutput.includes(`updated ${path.join(dir, 'market/index.json')}`), secondOutput);

  const versions = readVersions(dir, manifest.name);
  assert.equal(versions.filter((entry) => entry.version === version).length, 1);
  assert.equal(versions[0].version, version);
  assert.equal(versions[0].publishTimestamp, Math.floor(Date.parse(timestamp) / 1000));
  assert.deepEqual(tags(dir), [tag]);
  assert.deepEqual(tags(origin), [tag]);
  assert.equal(tagHash(dir, tag), localTag);
  assert.equal(tagHash(origin, tag), remoteTag);
});

test('a tag that points at an older commit still stops the release and names the recovery', async () => {
  const { dir, origin, manifest, version } = releaseRepo();
  const tag = `plugin-v${version}`;
  git(dir, ['tag', tag]);
  const taggedAt = tagHash(dir, tag);
  fs.writeFileSync(path.join(dir, 'after-tag.txt'), 'new commit\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'after the tag']);
  const currentHead = git(dir, ['rev-parse', 'HEAD']);
  assert.notEqual(taggedAt, currentHead);

  let requests = 0;
  const result = await release({
    dir,
    fetch: async (...args) => {
      requests += 1;
      return registryHit(version, '2026-11-05T12:00:00.000Z')(...args);
    },
    sleep: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'tag');
  const message = result.failures[0].message;
  assert.match(message, /already exists and does not point at HEAD/u);
  // The tag and the commit it points at are named, not just "a tag exists".
  assert.ok(message.includes(tag), message);
  assert.ok(message.includes(taggedAt), message);
  assert.ok(message.includes(currentHead), message);
  // The recovery is copy-pasteable: remove the local and the remote tag, then
  // rerun. A tag at HEAD takes the resume path instead.
  assert.ok(message.includes(`git tag -d ${tag}`), message);
  assert.ok(message.includes(`git push --delete origin ${tag}`), message);
  assert.ok(message.includes('re-run release'), message);
  assert.equal(requests, 0);
  assert.deepEqual(readVersions(dir, manifest.name), []);
  assert.deepEqual(tags(origin), []);
});

test('the CLI exits 1 for a tag at another commit and prints the recovery', async () => {
  const { dir, origin, version } = releaseRepo();
  const tag = `plugin-v${version}`;
  git(dir, ['tag', tag]);
  const taggedAt = tagHash(dir, tag);
  fs.writeFileSync(path.join(dir, 'after-tag.txt'), 'new commit\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'after the tag']);

  const lines = [];
  const io = {
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
  const code = await run(['release', dir], io);

  assert.equal(code, 1);
  const output = lines.join('\n');
  assert.match(output, /dsh-plugin release stopped at tag/u);
  assert.ok(output.includes(tag), output);
  assert.ok(output.includes(taggedAt), output);
  assert.ok(output.includes(`git tag -d ${tag}`), output);
  assert.ok(output.includes(`git push --delete origin ${tag}`), output);
  assert.deepEqual(tags(origin), []);
});
