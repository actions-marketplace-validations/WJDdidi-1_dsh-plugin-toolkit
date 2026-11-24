/**
 * The patch-shape rejection was pinned against the checkout's
 * `bin/dsh-plugin.mjs`, which is not the file npm installs. A tarball that
 * omitted the fix, or a module it needs, could still pass the suite and ship
 * the false clean.
 *
 * This test packs this repository, installs the tarball into a temp prefix, and
 * spawns the *installed* CLI on each committed patch fixture: `doctor` and
 * `verify --no-mount` once per fixture. The empty file, `foo: bar` mapping,
 * `- insert: []` list, and the `- insert: [{}]`, `[null]` and `[false]` lists
 * must all be rejected 6/6 with the `patch file` line naming
 * `cordis.patch.yml`; both valid `- insert:` controls must stay clean 2/2.
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
const fixture = (name) => path.join(HERE, 'fixtures', name);

const INVALID = [
  'patch-empty',
  'patch-no-insert',
  'patch-empty-insert',
  'patch-insert-empty-object',
  'patch-insert-null',
  'patch-insert-false',
];
const CONTROLS = ['patch-valid', 'patch-insert-inline-valid'];
const NO_INSERT = /no insert row the host can apply/u;

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

test('the installed tarball CLI rejects every unnameable insert 6/6 and keeps both controls clean 2/2', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-shape-tarball-'));
  try {
    // Keep the fixtures honest before the shipped runs. If a fixture stops
    // carrying the shape it names, this test must be rewritten around the new
    // fixture rather than pass without reproducing the bug.
    const readPatch = (name) => fs.readFileSync(path.join(fixture(name), 'cordis.patch.yml'), 'utf8')
      .replace(/\r\n/gu, '\n'); // a Windows checkout is CRLF; the fixture content is LF
    assert.equal(readPatch('patch-empty'), '');
    assert.equal(readPatch('patch-no-insert'), 'foo: bar\n');
    assert.equal(readPatch('patch-empty-insert'), '- insert: []\n');
    assert.equal(readPatch('patch-insert-empty-object'), '- insert: [{}]\n');
    assert.equal(readPatch('patch-insert-null'), '- insert: [null]\n');
    assert.equal(readPatch('patch-insert-false'), '- insert: [false]\n');
    assert.match(readPatch('patch-valid'), /^- insert:\n {4}- id: patch-valid$/mu);
    assert.equal(readPatch('patch-insert-inline-valid'), '- insert: [{ id: x, name: x, config: {} }]\n');

    const toolkit = packToolkit(scratch);
    // A tarball without its CLI, doctor, or verify code cannot be the boundary
    // this test claims to exercise, so fail before the shipped runs.
    const toolkitFiles = new Set(toolkit.files.map((entry) => entry.path));
    for (const required of ['bin/dsh-plugin.mjs', 'lib/cli.mjs', 'lib/doctor.mjs', 'lib/verify.mjs']) {
      assert.ok(toolkitFiles.has(required), `the toolkit tarball does not ship ${required}`);
    }

    const installedBin = installToolkit(scratch, toolkit);
    assert.notEqual(
      path.resolve(installedBin),
      path.join(ROOT, 'bin', 'dsh-plugin.mjs'),
      'the installed CLI resolved back to the checkout copy',
    );

    const doctorStatuses = [];
    const verifyStatuses = [];
    for (const name of INVALID) {
      const doctorRun = invoke(installedBin, scratch, ['doctor', fixture(name)]);
      const doctorOutput = `${doctorRun.stdout}\n${doctorRun.stderr}`;
      doctorStatuses.push(doctorRun.status);
      assert.equal(doctorRun.status, 1, `${name}, installed CLI doctor:\n${doctorOutput}`);
      assert.doesNotMatch(doctorOutput, /^ok {2}/mu, `${name} printed a clean line:\n${doctorOutput}`);
      const doctorLine = doctorOutput.split(/\r?\n/u).find((line) => line.includes('✗ patch file:'));
      assert.ok(doctorLine, `${name} printed no patch file line:\n${doctorOutput}`);
      assert.ok(doctorLine.includes('cordis.patch.yml'), doctorLine);
      assert.match(doctorLine, NO_INSERT, doctorLine);

      const verifyRun = invoke(installedBin, scratch, ['verify', fixture(name), '--no-mount']);
      const verifyOutput = `${verifyRun.stdout}\n${verifyRun.stderr}`;
      verifyStatuses.push(verifyRun.status);
      assert.equal(verifyRun.status, 1, `${name}, installed CLI verify --no-mount:\n${verifyOutput}`);
      assert.match(verifyOutput, /dsh-plugin verify: stopped at doctor/u, `${name}:\n${verifyOutput}`);
      assert.match(verifyOutput, /✗ patch file: .*cordis\.patch\.yml/u, `${name}:\n${verifyOutput}`);
      assert.match(verifyOutput, NO_INSERT, `${name}:\n${verifyOutput}`);
      assert.doesNotMatch(verifyOutput, /✗ pack:/u, `${name} packed instead of stopping at doctor:\n${verifyOutput}`);
    }
    assert.deepEqual(doctorStatuses, [1, 1, 1, 1, 1, 1], 'all six unnameable fixtures must fail the installed doctor');
    assert.deepEqual(verifyStatuses, [1, 1, 1, 1, 1, 1], 'all six unnameable fixtures must fail the installed verify');

    for (const control of CONTROLS) {
      const doctorControl = invoke(installedBin, scratch, ['doctor', fixture(control)]);
      const doctorControlOutput = `${doctorControl.stdout}\n${doctorControl.stderr}`;
      assert.equal(doctorControl.status, 0, `installed CLI doctor on ${control}:\n${doctorControlOutput}`);
      assert.match(doctorControlOutput, new RegExp(`^ok {2}${control}@1\\.0\\.0 `, 'mu'), doctorControlOutput);
      assert.doesNotMatch(doctorControlOutput, NO_INSERT, doctorControlOutput);

      const verifyControl = invoke(installedBin, scratch, ['verify', fixture(control), '--no-mount']);
      const verifyControlOutput = `${verifyControl.stdout}\n${verifyControl.stderr}`;
      assert.equal(verifyControl.status, 0, `installed CLI verify --no-mount on ${control}:\n${verifyControlOutput}`);
      assert.match(verifyControlOutput, /^ok {2}packed \d+ file\(s\)/mu, verifyControlOutput);
      assert.doesNotMatch(verifyControlOutput, /stopped at doctor|no insert row/u, verifyControlOutput);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
