/**
 * The truncated-profile finding is checked against the CLI npm installs, not
 * only against the checkout's `bin/dsh-plugin.mjs`. The earlier regression test
 * spawned the checkout copy, so a tarball that omitted the profile fix or a
 * file it needs could still pass the suite and ship the false clean.
 *
 * This test packs this repository, installs the tarball into a temp prefix, and
 * spawns the *installed* CLI three times on an `audit --home` fixture whose
 * profile `package.json` was truncated mid-write (and whose declared plugin's
 * manifest is truncated too), then three times on the clean fixture whose
 * profile and plugin are valid. All 3/3 damaged runs must exit 1, name the
 * profile file, and print the `unreadable profile` finding; all 3/3 controls
 * must exit 0 with the plugin row. Any run that prints the empty-profile line
 * with exit 0 is the bug this milestone exists to pin.
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

const TRUNCATED_ROOT = path.join(HERE, 'fixtures', 'audit-home-truncated-profile');
const TRUNCATED_PROFILE = path.join(TRUNCATED_ROOT, 'home', '.dsh', 'profiles', 'desktop', 'package.json');
const TRUNCATED_PLUGIN = path.join(TRUNCATED_ROOT, 'plugin', 'ghost-plugin');

const CLEAN_ROOT = path.join(HERE, 'fixtures', 'audit-home-clean');
const CLEAN_PROFILE = path.join(CLEAN_ROOT, 'home', '.dsh', 'profiles', 'desktop', 'package.json');
const CLEAN_PLUGIN = path.join(CLEAN_ROOT, 'plugin', 'clean-plugin');

const EMPTY = 'no plugins installed in any profile';
const RUNS = 3;

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

/**
 * Copy a fixture home into `scratch` and put its declared plugin in the
 * `node_modules` shape the loader installs, then return the `.dsh` home.
 */
function materialize(scratch, label, fixtureRoot, pluginSource, pluginName) {
  const home = path.join(scratch, `${label}-home`);
  fs.cpSync(path.join(fixtureRoot, 'home'), home, { recursive: true });
  const dest = path.join(home, '.dsh', 'profiles', 'desktop', 'node_modules', pluginName);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(pluginSource, dest, { recursive: true });
  return path.join(home, '.dsh');
}

function audit(installedBin, scratch, home) {
  return spawnSync(process.execPath, [installedBin, 'audit', '--home', home, '--timeout', '50'], {
    // Run outside the checkout and the install prefix: a command that only
    // works because it can borrow this repository's files is not the command a
    // user installs.
    cwd: scratch,
    encoding: 'utf8',
  });
}

test('the installed tarball CLI reports the truncated profile 3/3 times and keeps 3/3 controls clean', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-home-truncated-tarball-'));
  try {
    // Keep the fixtures honest before the shipped runs: the damaged profile and
    // its declared plugin must actually fail to parse, and the controls must
    // actually parse. Otherwise this test could pass without reproducing the
    // interrupted-write shape.
    assert.throws(
      () => JSON.parse(fs.readFileSync(TRUNCATED_PROFILE, 'utf8')),
      SyntaxError,
      'the truncated profile fixture now parses',
    );
    assert.throws(
      () => JSON.parse(fs.readFileSync(path.join(TRUNCATED_PLUGIN, 'package.json'), 'utf8')),
      SyntaxError,
      "the declared plugin's manifest fixture now parses",
    );
    assert.doesNotThrow(
      () => JSON.parse(fs.readFileSync(CLEAN_PROFILE, 'utf8')),
      'the clean control profile no longer parses',
    );

    const toolkit = packToolkit(scratch);
    // A tarball without its CLI or audit code cannot be the boundary this test
    // claims to exercise, so fail before the six runs rather than after them.
    for (const required of ['bin/dsh-plugin.mjs', 'lib/audit.mjs', 'lib/cli.mjs']) {
      assert.ok(
        toolkit.files.some((entry) => entry.path === required),
        `the toolkit tarball does not ship ${required}`,
      );
    }

    const installedBin = installToolkit(scratch, toolkit);
    const damagedHome = materialize(scratch, 'damaged', TRUNCATED_ROOT, TRUNCATED_PLUGIN, 'ghost-plugin');
    const cleanHome = materialize(scratch, 'clean', CLEAN_ROOT, CLEAN_PLUGIN, 'clean-plugin');
    const damagedProfileFile = path.join(damagedHome, 'profiles', 'desktop', 'package.json');

    const damagedStatuses = [];
    for (let iteration = 1; iteration <= RUNS; iteration += 1) {
      const result = audit(installedBin, scratch, damagedHome);
      const output = `${result.stdout}\n${result.stderr}`;
      damagedStatuses.push(result.status);

      assert.equal(result.status, 1, `damaged fixture, installed CLI run ${iteration}:\n${output}`);
      assert.ok(
        output.includes(damagedProfileFile),
        `run ${iteration} must name ${damagedProfileFile}:\n${output}`,
      );
      assert.match(output, /unreadable profile/u, `run ${iteration}:\n${output}`);
      assert.match(output, /profile manifest: .*is not valid JSON/u, `run ${iteration}:\n${output}`);
      assert.doesNotMatch(
        output,
        new RegExp(EMPTY, 'u'),
        `run ${iteration} reported the damaged profile as empty:\n${output}`,
      );
    }
    assert.deepEqual(damagedStatuses, [1, 1, 1], 'the damaged fixture must fail on all three shipped runs');

    const cleanStatuses = [];
    for (let iteration = 1; iteration <= RUNS; iteration += 1) {
      const result = audit(installedBin, scratch, cleanHome);
      const output = `${result.stdout}\n${result.stderr}`;
      cleanStatuses.push(result.status);

      assert.equal(result.status, 0, `clean control, installed CLI run ${iteration}:\n${output}`);
      assert.match(output, /^clean-plugin\s+1\.0\.0\s+\?\s+ok$/mu, `run ${iteration}:\n${output}`);
      assert.doesNotMatch(output, /unreadable profile/u, `run ${iteration}:\n${output}`);
      assert.doesNotMatch(output, new RegExp(EMPTY, 'u'), `run ${iteration}:\n${output}`);
      assert.equal(result.stderr, '', `run ${iteration}:\n${output}`);
    }
    assert.deepEqual(cleanStatuses, [0, 0, 0], 'the clean control must stay green on all three shipped runs');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
