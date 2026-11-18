/**
 * `audit --home` must read the profile home it was given, or say that it could
 * not.
 *
 * The failure this pins is a false clean: `listInstalled` looks for
 * `<home>/profiles`, finds none below a path that does not exist (or below a
 * regular file, or below a dangling symlink), and the command printed "no
 * plugins installed in any profile" with exit 0. A missing profile and an
 * unreadable one are not the same answer, and a CI gate that passes on a path
 * the audit never read is worse than a usage error.
 *
 * The controls keep the check honest: a real empty directory still reports
 * that there are no plugins, and omitting `--home` still falls back to
 * `$HOME/.dsh` instead of becoming a usage error.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const EMPTY = 'no plugins installed in any profile';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-home-not-directory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runAudit(args, env = process.env) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
}

test('--home names a missing path, a regular file or a dangling symlink and exits 2', (t) => {
  const dir = scratch(t);
  const missing = path.join(dir, 'missing-home');
  const file = path.join(dir, 'not-a-home.txt');
  fs.writeFileSync(file, 'this is a file, not a profile home\n');

  const dangling = path.join(dir, 'dangling-home');
  let hasDangling = true;
  try {
    fs.symlinkSync(path.join(dir, 'gone'), dangling, 'dir');
  } catch {
    // Windows without developer mode refuses symlinks; the other two shapes
    // still cover the boundary there.
    hasDangling = false;
  }

  const cases = [
    ['missing path', missing, /the path does not exist/u],
    ['regular file', file, /the path is a regular file/u],
  ];
  if (hasDangling === true) cases.push(['dangling symlink', dangling, /the path does not exist/u]);

  for (const [label, home, reason] of cases) {
    const result = runAudit(['audit', '--home', home, '--timeout', '50']);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 2, `${label}\n${output}`);
    assert.match(result.stderr, /--home/u, `${label} did not name --home\n${output}`);
    assert.ok(result.stderr.includes(home), `${label} did not name the resolved path ${home}\n${output}`);
    assert.match(result.stderr, /is not a directory/u, `${label} did not say why\n${output}`);
    assert.match(result.stderr, reason, `${label} gave the wrong reason\n${output}`);
    assert.doesNotMatch(output, new RegExp(EMPTY, 'u'), `${label} was reported as an empty profile`);
    assert.equal(result.stdout, '', `${label} printed a report\n${output}`);
  }
});

test('a symlink to an existing directory is still a valid profile home', (t) => {
  const dir = scratch(t);
  const realHome = path.join(dir, 'real-home');
  const linkedHome = path.join(dir, 'linked-home');
  fs.mkdirSync(realHome);
  try {
    fs.symlinkSync(realHome, linkedHome, 'dir');
  } catch {
    // Windows without developer mode refuses symlinks; the directory control
    // above still covers the accepting side there.
    t.skip('this platform does not allow unprivileged symlinks');
    return;
  }

  // `statSync` follows the link, so the audit reads the directory it names.
  // A fix that switched to `lstatSync` to recognize a dangling link would
  // start refusing real profile homes kept behind a symlink.
  const result = runAudit(['audit', '--home', linkedHome, '--timeout', '50']);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, new RegExp(EMPTY, 'u'), output);
  assert.equal(result.stderr, '', output);
});

test('an existing empty directory still exits 0 with the empty-profile line', (t) => {
  const dir = scratch(t);
  const emptyHome = path.join(dir, 'empty-home');
  fs.mkdirSync(emptyHome);

  const result = runAudit(['audit', '--home', emptyHome, '--timeout', '50']);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, new RegExp(EMPTY, 'u'), output);
  assert.equal(result.stderr, '', output);
});

test('omitting --home still scans the default home and exits 0 when it is empty', (t) => {
  const dir = scratch(t);
  const defaultHome = path.join(dir, 'default-home');
  fs.mkdirSync(defaultHome);
  // `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows, so point
  // both at the scratch directory and keep the runner's real profile out of
  // the control.
  const env = { ...process.env, HOME: defaultHome, USERPROFILE: defaultHome };

  const result = runAudit(['audit', '--timeout', '50'], env);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, new RegExp(EMPTY, 'u'), output);
  assert.equal(result.stderr, '', output);
});
