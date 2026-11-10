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
const mismatchFixture = path.join(here, 'fixtures', 'release-timestamp-mismatch');

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

/** A repository whose tag and index both already describe a finished release. */
function alreadyReleasedRepo(version = '1.0.0', timestamp = '2026-11-05T12:00:00.000Z') {
  const state = releaseRepo(version);
  const { dir, manifest } = state;
  const indexFile = path.join(dir, 'market/index.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  index.plugins.find((plugin) => plugin.name === manifest.name).versions = [{
    version,
    publishTimestamp: Math.floor(Date.parse(timestamp) / 1000),
    engines: { dsh: '>=0.2.0' },
    source: { type: 'npm' },
  }];
  fs.writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
  git(dir, ['add', 'market/index.json']);
  git(dir, ['commit', '-q', '-m', `market: ${version}`]);
  git(dir, ['tag', `plugin-v${version}`]);
  return { ...state, timestamp };
}

test('a release whose index already carries the version skips the PR sequence', async () => {
  const { dir, version, timestamp } = alreadyReleasedRepo();

  const result = await release({
    dir,
    pr: true,
    fetch: registryHit(version, timestamp),
    sleep: async () => {},
  });

  assert.equal(result.ok, true, JSON.stringify(result.failures ?? []));
  assert.equal(result.indexUpdate.unchanged, true);
  assert.equal(result.pullRequest, undefined);
  assert.equal(result.merged, undefined);
  // The unchanged index has nothing to commit, so no branch may be left behind.
  assert.equal(git(dir, ['branch', '--list', `market/${version}`]), '');
});

/** A repository whose index lists the version one second after the registry. */
function timestampMismatchRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-mismatch-'));
  const dir = path.join(root, 'plugin');
  fs.cpSync(mismatchFixture, dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'one']);
  git(dir, ['tag', 'plugin-v1.0.0']);
  return { dir, name: 'demo-plugin', version: '1.0.0' };
}

test('a publish time one second off the index still fails the release', async () => {
  const { dir, name, version } = timestampMismatchRepo();

  const result = await release({
    dir,
    pr: true,
    fetch: registryHit(version, '2026-01-01T00:00:00.000Z'),
    sleep: async () => {},
  });

  assert.equal(result.ok, false, JSON.stringify(result.failures ?? []));
  assert.equal(result.stage, 'index');
  const message = result.failures[0].message;
  assert.match(message, /already in the index with publishTimestamp 1767225601, not 1767225600/u);
  // A mismatch is not the same-timestamp resume path: nothing is committed and
  // no branch is left behind for a release that did not finish.
  assert.equal(result.indexUpdate, undefined);
  assert.equal(git(dir, ['branch', '--list', `market/${version}`]), '');
  assert.equal(readVersions(dir, name)[0].publishTimestamp, 1767225601);
});

test('the CLI exits 1 on a publish-time mismatch and creates no PR branch', async () => {
  const { dir, version } = timestampMismatchRepo();
  const lines = [];
  const errors = [];
  const originalFetch = globalThis.fetch;
  let code;
  try {
    globalThis.fetch = registryHit(version, '2026-01-01T00:00:00.000Z');
    code = await run(['release', dir, '--pr'], {
      log: (line) => lines.push(String(line)),
      error: (line) => errors.push(String(line)),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(code, 1, [...lines, ...errors].join('\n'));
  const errorText = errors.join('\n');
  assert.match(errorText, /dsh-plugin release stopped at index/u);
  assert.ok(errorText.includes('1767225601'), errorText);
  assert.ok(errorText.includes('1767225600'), errorText);
  assert.equal(git(dir, ['branch', '--list', `market/${version}`]), '');
});

test('the CLI exits 0 on a repeated release --pr and leaves git log -1 unchanged', async () => {
  const { dir, version, timestamp } = alreadyReleasedRepo();
  const headBefore = git(dir, ['log', '-1', '--format=%H']);
  const output = [];
  const originalFetch = globalThis.fetch;
  let code;
  try {
    globalThis.fetch = registryHit(version, timestamp);
    // Three runs: a release that is already finished stays finished, and none
    // of them may add a commit for an index entry that is already committed.
    for (let trial = 0; trial < 3; trial += 1) {
      code = await run(['release', dir, '--pr'], {
        log: (line) => output.push(String(line)),
        error: (line) => output.push(String(line)),
      });
      assert.equal(code, 0, output.join('\n'));
      assert.equal(git(dir, ['log', '-1', '--format=%H']), headBefore, 'a no-op release must not move HEAD');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  const text = output.join('\n');
  assert.match(text, /already carried 1\.0\.0; nothing to commit/u);
  assert.doesNotMatch(text, /opened https?:\/\//u);
  assert.equal(git(dir, ['branch', '--list', `market/${version}`]), '');
  assert.equal(git(dir, ['status', '--porcelain']), '');
});

test('a later release --pr commits an index entry an earlier run left uncommitted', async () => {
  const { dir, manifest, version } = releaseRepo();
  const timestamp = '2026-11-05T12:00:00.000Z';

  // The first run has no --pr: it writes the entry and leaves it in the working
  // tree. This is the resume path that must not be mistaken for "nothing to
  // commit" just because this release added no further index change.
  const first = await release({ dir, fetch: registryHit(version, timestamp), sleep: async () => {} });
  assert.equal(first.ok, true, JSON.stringify(first.failures ?? []));
  assert.equal(first.indexUpdate.unchanged, undefined);
  assert.equal(git(dir, ['status', '--porcelain']), 'M market/index.json');
  const headBefore = git(dir, ['log', '-1', '--format=%H']);

  let prArgs;
  const gh = (args) => {
    prArgs = args;
    return 'https://example.test/pr/resumed';
  };
  const second = await release({
    dir,
    pr: true,
    fetch: registryHit(version, timestamp),
    sleep: async () => {},
    gh,
  });

  assert.equal(second.ok, true, JSON.stringify(second.failures ?? []));
  assert.equal(second.pullRequest.url, 'https://example.test/pr/resumed');
  assert.match(prArgs.join(' '), /pr create .*--head market\/1\.0\.0/u);
  assert.notEqual(git(dir, ['log', '-1', '--format=%H']), headBefore);
  assert.equal(git(dir, ['status', '--porcelain']), '');
  assert.match(git(dir, ['branch', '--list', `market/${version}`]), /market\/1\.0\.0/u);
  assert.deepEqual(readVersions(dir, manifest.name).map((entry) => entry.version), [version]);
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
