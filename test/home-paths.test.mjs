/**
 * The tilde is the shell's job on POSIX, but not on cmd or PowerShell. Both
 * hand `~/my-panel` to the program unchanged, so the command has to expand it
 * before it touches the filesystem. These tests run at the process boundary:
 * that is where the literal string actually arrives.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { doctor } from '../lib/doctor.mjs';
import { init } from '../lib/init.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-path-'));
}

function envFor(home) {
  // Windows reads USERPROFILE rather than HOME in os.homedir(); set both so
  // the expansion points at the scratch directory on every runner.
  return { ...process.env, HOME: home, USERPROFILE: home };
}

function filesUnder(dir) {
  const found = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory() === true) walk(path.join(current, entry.name), relative);
      else found.push(relative);
    }
  };
  walk(dir, '');
  return found.sort();
}

/** Run the shipped bin exactly as a shell would, with no shell in between. */
function initViaBin(dir, home, cwd) {
  return spawnSync(process.execPath, [BIN, 'init', dir, '--name', 'my-panel'], {
    cwd,
    env: envFor(home),
    encoding: 'utf8',
  });
}

test("init '~/my-panel' writes under HOME and leaves no literal ~ directory", () => {
  const home = scratch();
  const cwd = scratch();
  const result = initViaBin('~/my-panel', home, cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^created 8 file\(s\) in /mu);

  const files = filesUnder(path.join(home, 'my-panel'));
  assert.equal(files.length, 8, files.join('\n'));

  // The shell-expanded spelling is the control: same scaffold, same files,
  // written only because this process resolved the absolute path itself.
  const controlHome = scratch();
  const control = initViaBin(path.join(controlHome, 'my-panel'), controlHome, cwd);
  assert.equal(control.status, 0, control.stderr);
  const controlFiles = filesUnder(path.join(controlHome, 'my-panel'));
  assert.deepEqual(files, controlFiles, 'the quoted path wrote a different scaffold than the expanded path');
  assert.equal(files.length, controlFiles.length, 'the two invocations wrote different file counts');
  assert.equal(fs.existsSync(path.join(cwd, '~')), false, 'the scaffold landed in a directory literally named ~');
});

test('the README states that the tool, not the shell, expands ~ for these path arguments', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/gu, '\n');
  assert.match(readme, /the tool, not the shell, expands `~` for these arguments/iu);
  assert.match(readme, /init '~\/my-panel' --name my-panel/u);
});

test("doctor '~/my-panel' exits 0 on that scaffold", () => {
  const home = scratch();
  const cwd = scratch();
  const created = spawnSync(process.execPath, [BIN, 'init', '~/my-panel', '--name', 'my-panel'], {
    cwd,
    env: envFor(home),
    encoding: 'utf8',
  });
  assert.equal(created.status, 0, created.stderr);

  const result = spawnSync(process.execPath, [BIN, 'doctor', '~/my-panel'], {
    cwd,
    env: envFor(home),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok\s+my-panel@0\.1\.0 \(host >=0\.2\.0\)$/m);
  assert.equal(fs.existsSync(path.join(cwd, '~')), false);
});

test('the Windows spelling ~\\my-panel expands on every platform', () => {
  const home = scratch();
  const cwd = scratch();
  const result = spawnSync(process.execPath, [BIN, 'init', '~\\my-panel', '--name', 'my-panel'], {
    cwd,
    env: envFor(home),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(filesUnder(path.join(home, 'my-panel')).length, 8);
  assert.equal(fs.existsSync(path.join(cwd, '~')), false);
});

test('the exported init and doctor functions expand the same path', () => {
  const home = scratch();
  const cwd = scratch();
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, cwd: process.cwd() };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.chdir(cwd);
  try {
    const result = init({ dir: '~/direct-panel', name: 'direct-panel' });
    assert.equal(result.ok, true, JSON.stringify(result.failures));
    assert.equal(result.dir, path.join(home, 'direct-panel'));
    assert.equal(filesUnder(result.dir).length, 8);
    assert.deepEqual(doctor('~/direct-panel').failures, []);
    assert.equal(fs.existsSync(path.join(cwd, '~')), false);
  } finally {
    process.chdir(previous.cwd);
    for (const name of ['HOME', 'USERPROFILE']) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
