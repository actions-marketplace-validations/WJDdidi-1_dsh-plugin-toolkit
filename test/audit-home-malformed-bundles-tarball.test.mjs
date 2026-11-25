/**
 * The malformed-`dsh.profile.bundles` verdict is checked against the CLI npm
 * actually installs, not only against the checkout's `bin/dsh-plugin.mjs`.
 *
 * The earlier regression test spawned the checkout copy, so a tarball that
 * omitted `lib/audit.mjs` (or a module it reads) could still pass the suite and
 * ship a false clean: a profile whose `dsh.profile.bundles` is a string, an
 * object, or an array with a non-string entry scanned as a profile with no
 * plugins, printed "no plugins installed in any profile", and exited `0`.
 *
 * This test packs this repository, installs the tarball into a temp prefix, and
 * spawns the *installed* CLI once on each of the three malformed profile shapes
 * and once on the valid `["ghost-plugin"]` control. All three malformed runs
 * must exit `1`, name the profile `package.json`, and print the `unreadable
 * profile` finding; the control must still report the declared but absent
 * install as a `missing` row and exit `1` (not as an unreadable profile). The
 * counters are printed so a failure says which boundary regressed, and the test
 * requires `false_cleans=0/3` and `control_exit1=1/1`. Against the published
 * 0.22.0 tarball the same test records `false_cleans=3/3`.
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

const EMPTY = 'no plugins installed in any profile';
const MALFORMED = [
  ['a string', '"ghost-plugin"'],
  ['an object', '{"ghost-plugin":true}'],
  ['a number inside an array', '[42]'],
];

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
 * Write a home with one profile whose `dsh.profile.bundles` is `literal`, and
 * return the profile file and the matching missing-install folder. The plugin
 * is deliberately not created for the control: a readable list naming an
 * absent package is the missing-install path, not a malformed-profile path.
 */
function writeProfile(scratch, label, literal) {
  const home = path.join(scratch, `${label}-home`);
  const profileDir = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
  const profileFile = path.join(profileDir, 'package.json');
  fs.writeFileSync(
    profileFile,
    `{\n  "name": "dsh-profile-desktop",\n  "private": true,\n  "dsh": { "profile": { "bundles": ${literal} } }\n}\n`,
  );
  return {
    home,
    profileFile,
    missingDir: path.join(profileDir, 'node_modules', 'ghost-plugin'),
  };
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

test('the installed tarball reports all three malformed bundles profiles and keeps the valid control a missing row', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-home-malformed-bundles-tarball-'));
  try {
    const toolkit = packToolkit(scratch);
    // A tarball without its CLI or the reader that carries the profile error
    // cannot be the boundary this test claims to exercise, so fail before the
    // four shipped runs rather than after them.
    for (const required of ['bin/dsh-plugin.mjs', 'lib/audit.mjs', 'lib/cli.mjs']) {
      assert.ok(
        toolkit.files.some((entry) => entry.path === required),
        `the toolkit tarball does not ship ${required}`,
      );
    }

    const installedBin = installToolkit(scratch, toolkit);

    // Run every shape before asserting: against the published 0.22.0 tarball
    // the same test then records false_cleans=3/3 in one summary instead of
    // stopping on the first false clean. A clean exit is the false clean this
    // milestone pins.
    const malformedRuns = MALFORMED.map(([label, literal]) => {
      const { home, profileFile } = writeProfile(scratch, label.replaceAll(' ', '-'), literal);
      const result = audit(installedBin, scratch, home);
      return { label, literal, profileFile, result, output: `${result.stdout}\n${result.stderr}` };
    });
    const falseCleans = malformedRuns.filter(({ result }) => result.status === 0).length;

    const control = writeProfile(scratch, 'valid-missing', '["ghost-plugin"]');
    const controlResult = audit(installedBin, scratch, control.home);
    const controlOutput = `${controlResult.stdout}\n${controlResult.stderr}`;
    const controlDiagnosis = `valid control: exit=${controlResult.status}\n${controlOutput}`;
    const controlExit1 = controlResult.status === 1 ? 1 : 0;

    t.diagnostic(`false_cleans=${falseCleans}/3 control_exit1=${controlExit1}/1`);
    assert.equal(falseCleans, 0, `false_cleans=${falseCleans}/3: a malformed profile must not exit 0`);
    assert.equal(controlExit1, 1, `control_exit1=${controlExit1}/1: the valid control must still report the missing install`);

    for (const { label, literal, profileFile, result, output } of malformedRuns) {
      const diagnosis = `${label}: exit=${result.status}\n${output}`;

      assert.equal(result.status, 1, diagnosis);
      assert.ok(output.includes(profileFile), `the finding must name ${profileFile}\n${diagnosis}`);
      assert.match(output, /unreadable profile/u, diagnosis);
      assert.match(output, /profile manifest:/u, diagnosis);
      assert.match(output, /does not hold a dsh\.profile\.bundles list of plugin names/u, diagnosis);
      assert.ok(
        output.includes(`got ${literal}`),
        `the finding must quote the malformed value ${literal}\n${diagnosis}`,
      );
      assert.doesNotMatch(output, new RegExp(EMPTY, 'u'), `the malformed profile was reported as empty\n${diagnosis}`);
    }

    assert.match(controlOutput, /^ghost-plugin\s+\?\s+missing\b/mu, controlDiagnosis);
    assert.match(controlOutput, /install:/u, controlDiagnosis);
    assert.ok(
      controlOutput.includes(control.missingDir),
      `the missing install must name ${control.missingDir}\n${controlDiagnosis}`,
    );
    assert.doesNotMatch(controlOutput, /unreadable profile/u, controlDiagnosis);
    assert.doesNotMatch(controlOutput, new RegExp(EMPTY, 'u'), controlDiagnosis);
    assert.equal(controlResult.stderr, '', controlDiagnosis);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
