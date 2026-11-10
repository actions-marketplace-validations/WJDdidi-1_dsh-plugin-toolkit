/**
 * `audit --home` has to expand a leading `~` itself, because cmd and PowerShell
 * pass the literal string through. The failure this pins is a false pass: the
 * scan reads a folder named `~` in the current directory, prints "no plugins
 * installed", and exits 0 while the real profile has a broken plugin.
 *
 * The checked-in fixture is one declared plugin whose `dsh.bundle.patch` names
 * `./missing.yml`, so a scan that reaches the real home must print the `broken`
 * row, name the missing patch, and exit 1.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { audit } from '../lib/audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const FIXTURE_ROOT = path.join(here, 'fixtures', 'audit-home-tilde');
const FIXTURE_HOME = path.join(FIXTURE_ROOT, 'home');
const FIXTURE_PLUGIN = path.join(FIXTURE_ROOT, 'plugin', 'broken');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-home-tilde-'));
}

/**
 * Copy the checked-in home and install its declared `broken` plugin as
 * `node_modules/broken`. A committed `node_modules` path is ignored by git, so
 * the fixture keeps the package beside the home and materialises the installed
 * shape here instead.
 */
function materializeHome(t) {
  const home = scratch();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.cpSync(FIXTURE_HOME, home, { recursive: true });
  const dest = path.join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'broken');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(FIXTURE_PLUGIN, dest, { recursive: true });
  return home;
}

function envFor(home) {
  // Windows reads USERPROFILE rather than HOME in os.homedir(); set both so
  // the expansion points at the fixture on every runner.
  return { ...process.env, HOME: home, USERPROFILE: home };
}

function runAudit(homeSpelling, cwd, home) {
  return spawnSync(process.execPath, [BIN, 'audit', '--home', homeSpelling, '--timeout', '50'], {
    cwd,
    env: envFor(home),
    encoding: 'utf8',
  });
}

function assertBrokenRow(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /^broken\s+1\.0\.0\s+\?\s+1 problem: patch file$/mu);
  assert.match(output, /dsh\.bundle\.patch points at \.\/missing\.yml, which does not exist/u);
  assert.doesNotMatch(output, /no plugins installed/u, 'the literal ~ path reported an empty home');
}

test('audit --home expands ~/ and ~\\ to the same real profile and exits 1', (t) => {
  const home = materializeHome(t);
  const cwd = scratch();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  for (const spelling of ['~/.dsh', '~\\.dsh']) {
    const result = runAudit(spelling, cwd, home);
    assertBrokenRow(result);
    assert.equal(fs.existsSync(path.join(cwd, '~')), false, `${spelling} created a directory literally named ~`);
  }
});

test('the absolute-path control reads the same profile and exits 1', (t) => {
  const home = materializeHome(t);
  const cwd = scratch();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const result = runAudit(path.join(home, '.dsh'), cwd, home);
  assertBrokenRow(result);
  assert.equal(fs.existsSync(path.join(cwd, '~')), false);
});

test('a bare --home is a usage error, not a scan of the current folder', (t) => {
  const cwd = scratch();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [BIN, 'audit', '--home', '--timeout', '50'], {
    cwd,
    env: envFor(FIXTURE_HOME),
    encoding: 'utf8',
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 2, output);
  assert.match(result.stderr, /--home needs a directory path/u);
  assert.doesNotMatch(output, /no plugins installed/u);
});

test('the exported audit expands ~/.dsh without a shell in between', async (t) => {
  const home = materializeHome(t);
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const lines = [];
  const result = await audit({ home: '~/.dsh', io: { log: (line) => lines.push(String(line)) } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.plugins.map((plugin) => plugin.name), ['broken']);
  assert.deepEqual(result.plugins[0].failures.map((failure) => failure.check), ['patch file']);
  assert.match(lines.join('\n'), /^broken\b.*1 problem: patch file$/mu);
});
