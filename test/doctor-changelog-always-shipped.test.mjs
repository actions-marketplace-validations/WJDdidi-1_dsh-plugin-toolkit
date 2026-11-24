/**
 * npm's always-included set is `package.json`, README, COPYING, LICENSE and the
 * `main` file -- not a changelog. `ALWAYS_SHIPPED` listed `CHANGELOG*` anyway,
 * so `doctor` skipped the `files` check for an `exports["./client"]` path that
 * named one and printed `ok` while `npm pack` omitted the client.
 *
 * The three failing fixtures are committed packages, and the same tree is
 * handed to `npm pack --dry-run --json` and to the installed tarball's CLI, so
 * the prediction cannot be tuned to a fixture only the test knows about. The
 * listed control adds `CHANGELOG.md` to `files`; the always-included fixture
 * declares README, LICENSE, COPYING, package.json and `main` while omitting
 * them from `files`, so correcting the set cannot become "reject every
 * unlisted path".
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { missingDeclaredPaths } from '../lib/doctor.mjs';
import { run } from '../lib/exec.mjs';
import { parsePackOutput } from '../lib/verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const fixture = (name) => path.join(HERE, 'fixtures', name);

const CHANGELOG_FIXTURES = [
  { dir: 'changelog-client', client: 'CHANGELOG.md' },
  { dir: 'changelog-client-plain', client: 'CHANGELOG' },
  { dir: 'changelog-client-txt', client: 'CHANGELOG.txt' },
];
const LISTED_CONTROL = 'changelog-client-listed';
const ALWAYS_CONTROL = 'always-included-client';
const ALWAYS_PACKED = ['README.md', 'LICENSE', 'COPYING', 'package.json', 'index.js'];
const ALWAYS_TRIALS = 5;

// Keep npm's cache and logs under the temp directory: the checkout can be in a
// sandbox whose `~/.npm` is not writable, and a failing pack would hide the
// behaviour this test checks.
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-changelog-npm-'));
process.env.npm_config_cache = cache;
process.env.npm_config_logs_dir = path.join(cache, '_logs');
fs.mkdirSync(process.env.npm_config_logs_dir, { recursive: true });
process.on('exit', () => {
  try {
    fs.rmSync(cache, { recursive: true, force: true });
  } catch {
    // A leftover temp cache is not a test failure.
  }
});

function readManifest(name) {
  return JSON.parse(fs.readFileSync(path.join(fixture(name), 'package.json'), 'utf8'));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function packedFixtureFiles(name) {
  const output = run('npm', ['pack', '--dry-run', '--json'], {
    cwd: fixture(name),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [document] = parsePackOutput(output);
  assert.ok(document, `npm pack --dry-run --json printed no tarball document for ${name}:\n${output}`);
  return new Set((document.files ?? []).map((entry) => entry.path));
}

function packToolkit(scratch) {
  const output = run('npm', ['pack', '--pack-destination', scratch, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [document] = parsePackOutput(output);
  assert.ok(document, `npm pack --json printed no tarball document:\n${output}`);
  return document;
}

function installToolkit(scratch, document) {
  const prefix = path.join(scratch, 'install');
  run(
    'npm',
    [
      'install',
      path.join(scratch, document.filename),
      '--prefix',
      prefix,
      '--no-save',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--omit=peer',
    ],
    {
      cwd: scratch,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const installedBin = path.join(prefix, 'node_modules', 'dsh-plugin-toolkit', 'bin', 'dsh-plugin.mjs');
  assert.ok(fs.existsSync(installedBin), `the tarball installed no CLI at ${installedBin}`);
  return installedBin;
}

function invoke(installedBin, scratch, args) {
  return spawnSync(process.execPath, [installedBin, ...args], {
    // Run outside the checkout and the install prefix: a command that only
    // works because it can borrow this repository's files is not the command a
    // user installs.
    cwd: scratch,
    encoding: 'utf8',
  });
}

test('a changelog is not in npm always-included set, while README, COPYING, LICENSE, package.json and main are', () => {
  const changelog = readManifest('changelog-client');
  assert.deepEqual(missingDeclaredPaths(changelog), ['CHANGELOG.md']);

  const always = readManifest(ALWAYS_CONTROL);
  assert.deepEqual(missingDeclaredPaths(always), []);
  for (const entry of ALWAYS_PACKED) {
    assert.ok(Object.values(always.exports).includes(`./${entry}`), `the control no longer declares ${entry}`);
  }
});

test('the installed tarball CLI reports the omitted CHANGELOG* clients 3/3 and keeps both controls clean', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-changelog-tarball-'));
  try {
    // Keep every fixture honest before the shipped runs. If npm starts adding
    // a changelog, or stops adding one of the always-included names, this test
    // should fail and be rewritten around the new packer rather than silently
    // stop reproducing the bug.
    for (const { dir, client } of CHANGELOG_FIXTURES) {
      const manifest = readManifest(dir);
      assert.equal(manifest.exports['./client'], `./${client}`, `${dir} no longer exports ${client}`);
      assert.equal(manifest.files.includes(client), false, `${dir} now lists ${client} in files`);
      const shipped = packedFixtureFiles(dir);
      assert.equal(shipped.has(client), false, `npm pack unexpectedly ships ${client}:\n${[...shipped].sort().join('\n')}`);
      assert.ok(shipped.has('index.js'), `npm pack no longer ships index.js from ${dir}`);
      assert.ok(shipped.has('cordis.patch.yml'), `npm pack no longer ships the patch from ${dir}`);
    }

    const listed = readManifest(LISTED_CONTROL);
    assert.equal(listed.exports['./client'], './CHANGELOG.md');
    assert.ok(listed.files.includes('CHANGELOG.md'), 'the listed control no longer adds CHANGELOG.md to files');
    assert.ok(packedFixtureFiles(LISTED_CONTROL).has('CHANGELOG.md'), 'npm pack no longer ships the listed control');

    const always = readManifest(ALWAYS_CONTROL);
    assert.deepEqual(always.files, ['cordis.patch.yml']);

    const toolkit = packToolkit(scratch);
    const toolkitFiles = new Set(toolkit.files.map((entry) => entry.path));
    for (const required of ['bin/dsh-plugin.mjs', 'lib/cli.mjs', 'lib/doctor.mjs']) {
      assert.ok(toolkitFiles.has(required), `the toolkit tarball does not ship ${required}`);
    }

    const installedBin = installToolkit(scratch, toolkit);
    assert.notEqual(
      path.resolve(installedBin),
      path.join(ROOT, 'bin', 'dsh-plugin.mjs'),
      'the installed CLI resolved back to the checkout copy',
    );

    const damagedStatuses = [];
    for (const { dir, client } of CHANGELOG_FIXTURES) {
      const result = invoke(installedBin, scratch, ['doctor', fixture(dir)]);
      const output = `${result.stdout}\n${result.stderr}`;
      damagedStatuses.push(result.status);

      assert.equal(result.status, 1, `${dir}, installed CLI:\n${output}`);
      assert.match(
        output,
        new RegExp(`✗ files list: files does not ship ${escapeRegExp(client)}, which package\\.json points at`, 'u'),
        `${dir}:\n${output}`,
      );
      assert.doesNotMatch(output, /^ok {2}/mu, `${dir} printed a clean line:\n${output}`);
    }
    assert.deepEqual(damagedStatuses, [1, 1, 1], 'all three changelog fixtures must fail the installed doctor');

    const listedRun = invoke(installedBin, scratch, ['doctor', fixture(LISTED_CONTROL)]);
    const listedOutput = `${listedRun.stdout}\n${listedRun.stderr}`;
    assert.equal(listedRun.status, 0, `listed control, installed CLI:\n${listedOutput}`);
    assert.match(listedOutput, /^ok {2}changelog-client-listed-fixture@1\.0\.0 /mu, listedOutput);
    assert.doesNotMatch(listedOutput, /✗ files list:/u, listedOutput);

    const alwaysStatuses = [];
    for (let trial = 1; trial <= ALWAYS_TRIALS; trial += 1) {
      const shipped = packedFixtureFiles(ALWAYS_CONTROL);
      for (const entry of ALWAYS_PACKED) {
        assert.ok(shipped.has(entry), `trial ${trial}: npm pack omits always-included ${entry}`);
      }

      const result = invoke(installedBin, scratch, ['doctor', fixture(ALWAYS_CONTROL)]);
      const output = `${result.stdout}\n${result.stderr}`;
      alwaysStatuses.push(result.status);
      assert.equal(result.status, 0, `always-included control, trial ${trial}:\n${output}`);
      assert.match(output, /^ok {2}always-included-client-fixture@1\.0\.0 /mu, `trial ${trial}:\n${output}`);
      assert.doesNotMatch(output, /✗ files list:/u, `trial ${trial}:\n${output}`);
    }
    assert.deepEqual(alwaysStatuses, Array(ALWAYS_TRIALS).fill(0), `${ALWAYS_TRIALS}/${ALWAYS_TRIALS} clean trials`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
