/**
 * `verify` runs a plugin's `prepack` twice removed from this checkout: once
 * through the CLI a user installs from npm, and once through the plugin's own
 * `npm pack`. The stdout-contamination fix was pinned against `bin/`, which is
 * the checkout's copy, not the one npm puts under `node_modules`.
 *
 * This test closes that boundary. It packs this repository, installs the
 * tarball into a temp prefix, and spawns the *installed* CLI three times on an
 * `init` scaffold whose `prepack` prints one line and three times on the silent
 * control. Every run has to exit 0, because npm running a lifecycle hook before
 * its JSON is normal and must not turn a shipped plugin into a `pack` failure.
 * The stdout scaffold's own tarball is then packed and its file list checked
 * against the five files a reader installs: the four the scaffold declares plus
 * package.json.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/exec.mjs';
import { init } from '../lib/init.mjs';
import { parsePackOutput } from '../lib/verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The five files an installed `init` scaffold carries. */
const SCAFFOLD_FILES = ['README.md', 'client.js', 'cordis.patch.yml', 'index.js', 'package.json'];

function packToolkit(scratch) {
  const output = run('npm', ['pack', '--pack-destination', scratch, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [document] = parsePackOutput(output);
  assert.ok(document, `npm pack --json printed no tarball document:\n${output}`);
  return {
    document,
    files: new Set(document.files.map((entry) => entry.path)),
  };
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

/**
 * Create the same scaffold the shipped CLI generates, with a `prepack` build.
 * An empty `build.mjs` is the silent control; it still runs through npm's
 * lifecycle so the only difference from the noisy scaffold is what stdout says.
 */
function scaffold(parent, name, buildScript) {
  const dir = path.join(parent, name, 'plugin');
  const generated = init({ dir, name, title: `${name} panel` });
  assert.equal(generated.ok, true, JSON.stringify(generated.failures));

  fs.writeFileSync(path.join(dir, 'build.mjs'), buildScript);
  const manifestFile = path.join(dir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.scripts = { ...manifest.scripts, prepack: 'node build.mjs' };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

function fixtureTarballFiles(dir, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const output = run('npm', ['pack', '--pack-destination', destination, '--json'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [document] = parsePackOutput(output);
  assert.ok(document, `packing the stdout fixture printed no tarball document:\n${output}`);
  return document.files.map((entry) => entry.path);
}

test('the installed tarball CLI passes stdout and silent prepack scaffolds 3/3 times', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-prepack-tarball-'));
  try {
    const toolkit = packToolkit(scratch);
    // A tarball without its CLI or verify code cannot be the boundary this test
    // claims to exercise, so fail before the six runs rather than after them.
    for (const required of ['bin/dsh-plugin.mjs', 'lib/verify.mjs', 'lib/init.mjs']) {
      assert.ok(toolkit.files.has(required), `the toolkit tarball does not ship ${required}`);
    }

    const installedBin = installToolkit(scratch, toolkit.document);
    const noisy = scaffold(scratch, 'stdout-prepack-scaffold', "console.log('building panel');\n");
    const silent = scaffold(scratch, 'silent-prepack-scaffold', '');

    // Keep the fixture honest: the noisy build must actually contaminate npm's
    // stdout, and the control must actually be silent. Otherwise the runs pass
    // without reproducing the condition this test exists to pin.
    const noisyBuild = spawnSync(process.execPath, ['build.mjs'], { cwd: noisy, encoding: 'utf8' });
    assert.equal(noisyBuild.stdout, 'building panel\n', 'the stdout fixture no longer prints its line');
    const silentBuild = spawnSync(process.execPath, ['build.mjs'], { cwd: silent, encoding: 'utf8' });
    assert.equal(silentBuild.stdout, '', 'the silent control now prints to stdout');

    for (const [label, dir] of [['stdout', noisy], ['silent', silent]]) {
      for (let iteration = 1; iteration <= 3; iteration += 1) {
        const result = spawnSync(process.execPath, [installedBin, 'verify', dir, '--no-mount'], {
          // Run outside the checkout and the install prefix: a command that
          // only works because it can borrow this repository's files is not
          // the command a user installs.
          cwd: scratch,
          encoding: 'utf8',
        });
        const output = `${result.stdout}\n${result.stderr}`;
        assert.equal(result.status, 0, `${label} scaffold, installed CLI run ${iteration}:\n${output}`);
        assert.match(result.stdout, /^ok {2}packed 5 file\(s\)/m, `${label} scaffold, run ${iteration}:\n${output}`);
      }
    }

    const fixtureFiles = fixtureTarballFiles(noisy, path.join(scratch, 'fixture-pack'));
    assert.deepEqual(
      [...fixtureFiles].sort(),
      [...SCAFFOLD_FILES].sort(),
      `the stdout scaffold's tarball does not contain exactly the five files a reader installs:\n${fixtureFiles
        .slice()
        .sort()
        .join('\n')}`,
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
