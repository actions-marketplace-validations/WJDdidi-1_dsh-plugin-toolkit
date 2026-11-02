import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const guard = path.join(here, '..', 'scripts', 'publish-guard.mjs');
const preflight = path.join(here, '..', 'scripts', 'publish-preflight.mjs');

function scratch(manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-guard-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

const manifest = (version) => ({
  name: 'dsh-plugin-toolkit',
  version,
  repository: { type: 'git', url: 'git+https://github.com/WJDdidi-1/dsh-plugin-toolkit.git' },
  files: ['package.json'],
});

// Every guard run states the tag it is testing. Inheriting GITHUB_REF_NAME from
// the workflow made this file pass on pull requests and fail on the release tag
// it exists to protect: the tag run exported plugin-v0.13.12, the scratch
// manifest said 99.99.99, and the guard correctly refused.
function guardEnv(tag) {
  const env = { ...process.env };
  delete env.GITHUB_REF_NAME;
  if (tag !== undefined) env.GITHUB_REF_NAME = tag;
  return env;
}

test('the guard passes for a version the registry does not serve', () => {
  const dir = scratch(manifest('99.99.99'));
  const result = spawnSync(process.execPath, [guard, dir], { encoding: 'utf8', env: guardEnv() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /99\.99\.99 is not published yet/u);
});

test('the guard passes when the tag names that same version', () => {
  const dir = scratch(manifest('99.99.99'));
  const result = spawnSync(process.execPath, [guard, dir], {
    encoding: 'utf8',
    env: guardEnv('plugin-v99.99.99'),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /99\.99\.99 is not published yet/u);
});

test('the guard refuses a version the registry already serves', () => {
  const dir = scratch(manifest('0.13.11'));
  const result = spawnSync(process.execPath, [guard, dir], { encoding: 'utf8', env: guardEnv() });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already published; a published version is never overwritten/u);
});

test('the guard refuses a tag that does not name the version', () => {
  const dir = scratch(manifest('99.99.99'));
  const result = spawnSync(process.execPath, [guard, dir], {
    encoding: 'utf8',
    env: guardEnv('plugin-v1.2.3'),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tag plugin-v1\.2\.3 does not match package\.json 99\.99\.99/u);
});

test('preflight refuses a repository url that points somewhere else', () => {
  const result = spawnSync(process.execPath, [preflight], {
    encoding: 'utf8',
    cwd: path.join(here, '..'),
    env: { ...process.env, GITHUB_REPOSITORY: 'someone/else' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /repository\.url is .*expected https:\/\/github\.com\/someone\/else/u);
});
