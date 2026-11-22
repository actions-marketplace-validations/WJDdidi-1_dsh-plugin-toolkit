/**
 * The re-inclusion verdict was pinned against the checkout's `bin/dsh-plugin.mjs`,
 * which is not the file npm installs. A tarball that omitted the files-list fix
 * or a file it needs could still pass the suite and ship the false clean.
 *
 * This test packs this repository, installs the tarball into a temp prefix, and
 * spawns the *installed* CLI three times on a committed fixture whose `files`
 * list re-lists `lib/client.js` after `!lib/client.js`. npm's strict file rules
 * still omit the client, so all 3/3 runs must exit 1 and print the `files list`
 * line. The CLI also generates an unmodified `init` scaffold, which must stay
 * clean on all 3/3 runs: a fix that rejects every package mentioning a `!` entry
 * would break the first plugin a user creates.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/exec.mjs';
import { parsePackOutput } from '../lib/verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURE = path.join(HERE, 'fixtures', 'files-reinclude');
const RUNS = 3;
const FILES_LIST_FAILURE =
  /✗ files list: files does not ship lib\/client\.js, which package\.json points at, so the installed plugin would be missing its own code/u;

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

function packedFixtureFiles() {
  const output = run('npm', ['pack', '--dry-run', '--json'], {
    cwd: FIXTURE,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [document] = parsePackOutput(output);
  assert.ok(document, `npm pack --dry-run --json printed no tarball document:\n${output}`);
  return new Set((document.files ?? []).map((entry) => entry.path));
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

test('the installed tarball CLI reports the re-included client 3/3 times and keeps the init scaffold clean', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-files-reinclude-tarball-'));
  try {
    // Keep the fixture honest before the shipped runs. If npm starts packing
    // the re-included client, this test should fail and be rewritten around the
    // new packer behavior rather than silently stop reproducing the bug.
    const fixtureManifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'package.json'), 'utf8'));
    assert.equal(fixtureManifest.exports['./client'], './lib/client.js');
    assert.ok(fixtureManifest.files.includes('!lib/client.js'), 'the fixture no longer excludes the client');
    assert.ok(fixtureManifest.files.includes('lib/client.js'), 'the fixture no longer re-includes the client');
    const fixtureShipped = packedFixtureFiles();
    assert.equal(
      fixtureShipped.has('lib/client.js'),
      false,
      `npm pack unexpectedly ships the re-included client:\n${[...fixtureShipped].sort().join('\n')}`,
    );
    assert.ok(fixtureShipped.has('index.js'), 'npm no longer ships index.js from the fixture');
    assert.ok(fixtureShipped.has('cordis.patch.yml'), 'npm no longer ships the patch from the fixture');

    const toolkit = packToolkit(scratch);
    // A tarball without its CLI or doctor code cannot be the boundary this test
    // claims to exercise, so fail before the shipped runs rather than after them.
    const toolkitFiles = new Set(toolkit.files.map((entry) => entry.path));
    for (const required of ['bin/dsh-plugin.mjs', 'lib/cli.mjs', 'lib/doctor.mjs', 'lib/init.mjs']) {
      assert.ok(toolkitFiles.has(required), `the toolkit tarball does not ship ${required}`);
    }

    const installedBin = installToolkit(scratch, toolkit);

    const damagedStatuses = [];
    for (let iteration = 1; iteration <= RUNS; iteration += 1) {
      const result = invoke(installedBin, scratch, ['doctor', FIXTURE]);
      const output = `${result.stdout}\n${result.stderr}`;
      damagedStatuses.push(result.status);

      assert.equal(result.status, 1, `damaged fixture, installed CLI run ${iteration}:\n${output}`);
      assert.match(output, FILES_LIST_FAILURE, `run ${iteration}:\n${output}`);
      assert.doesNotMatch(output, /^ok {2}/mu, `run ${iteration} printed a clean line:\n${output}`);
    }
    assert.deepEqual(damagedStatuses, [1, 1, 1], 'the damaged fixture must fail on all three shipped runs');

    const scaffold = path.join(scratch, 'scaffold');
    const generated = invoke(installedBin, scratch, ['init', scaffold, '--name', 'reinclude-control-panel']);
    assert.equal(generated.status, 0, `the installed CLI could not generate an init scaffold:\n${generated.stdout}\n${generated.stderr}`);

    // The control is the scaffold exactly as `init` wrote it: no fixture-only
    // edit removes a negation or adds a file, so this is the package a new
    // author publishes first.
    const scaffoldManifest = JSON.parse(fs.readFileSync(path.join(scaffold, 'package.json'), 'utf8'));
    assert.deepEqual(
      scaffoldManifest.files,
      ['index.js', 'client.js', 'cordis.patch.yml', 'README.md'],
      'the init scaffold manifest changed; the control is no longer the unmodified scaffold',
    );

    const cleanStatuses = [];
    for (let iteration = 1; iteration <= RUNS; iteration += 1) {
      const result = invoke(installedBin, scratch, ['doctor', scaffold]);
      const output = `${result.stdout}\n${result.stderr}`;
      cleanStatuses.push(result.status);

      assert.equal(result.status, 0, `init scaffold, installed CLI run ${iteration}:\n${output}`);
      assert.match(result.stdout, /^ok {2}reinclude-control-panel@0\.1\.0/mu, `run ${iteration}:\n${output}`);
      assert.doesNotMatch(output, /files list/u, `run ${iteration} reported the clean scaffold:\n${output}`);
      assert.equal(result.stderr, '', `run ${iteration}:\n${output}`);
    }
    assert.deepEqual(cleanStatuses, [0, 0, 0], 'the unmodified init scaffold must stay green on all three shipped runs');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
