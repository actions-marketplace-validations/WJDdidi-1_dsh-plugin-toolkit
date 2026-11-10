/**
 * `audit --home` must stop at usage validation when the flag has no path.
 *
 * The failure this pins is a false clean: the old parser let `--home` swallow
 * the next token, so `audit --home --timeout 50` scanned a folder literally
 * named `--timeout`, and `audit --home --json` scanned `--json`, then printed
 * "no plugins installed in any profile" and exited `0`. A bare `--home` also
 * fell back to `$HOME/.dsh`. Each spelling is a missing value, not a scan.
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
const FIXTURE_HOME = path.join(here, 'fixtures', 'missing-declared-bundle');
const CLEAN_FIXTURE_ROOT = path.join(here, 'fixtures', 'audit-home-clean');
const CLEAN_FIXTURE_HOME = path.join(CLEAN_FIXTURE_ROOT, 'home');
const CLEAN_FIXTURE_PLUGIN = path.join(CLEAN_FIXTURE_ROOT, 'plugin', 'clean-plugin');

function runAudit(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

/** Copy the clean home and install its declared plugin in the loader's shape. */
function materializeCleanHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-home-clean-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.cpSync(CLEAN_FIXTURE_HOME, home, { recursive: true });
  const dest = path.join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'clean-plugin');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(CLEAN_FIXTURE_PLUGIN, dest, { recursive: true });
  return path.join(home, '.dsh');
}

test('a missing --home value exits 2, while a clean fixture home exits 0 with its row', (t) => {
  const forms = [
    ['audit', '--home'],
    ['audit', '--home', '--timeout', '50'],
    ['audit', '--home', '--json'],
  ];

  for (const args of forms) {
    const result = runAudit(args);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 2, `${args.join(' ')}\n${output}`);
    assert.match(result.stderr, /--home needs a directory path/u, args.join(' '));
    assert.doesNotMatch(output, /no plugins installed/u, `${args.join(' ')} scanned a folder and reported it empty`);
    assert.equal(result.stdout, '', `${args.join(' ')} must not print a report`);
  }

  // The other side of the same boundary: a genuine clean scan still exits 0 and
  // names the plugin, so the assertions above are not satisfied by any failure.
  const home = materializeCleanHome(t);
  const control = runAudit(['audit', '--home', home, '--timeout', '50']);
  const controlOutput = `${control.stdout}\n${control.stderr}`;
  assert.equal(control.status, 0, controlOutput);
  assert.match(control.stdout, /^clean-plugin\s+1\.0\.0\s+\?\s+ok$/mu, controlOutput);
  assert.doesNotMatch(controlOutput, /no plugins installed/u, 'the clean fixture home was not scanned');
});

test('a later --home does not overwrite an earlier bare --home', () => {
  const result = runAudit(['audit', '--home', '--home', FIXTURE_HOME, '--timeout', '50']);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 2, output);
  assert.match(result.stderr, /--home needs a directory path/u);
  assert.doesNotMatch(output, /ghost-plugin/u, 'the scan ran despite the missing value');
});

test('a valid --home still prints the declared plugin row', () => {
  const result = runAudit(['audit', '--home', FIXTURE_HOME, '--timeout', '50']);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /^ghost-plugin\s+\?\s+missing\b/mu);
  assert.match(output, /node_modules\/ghost-plugin/u);
  assert.doesNotMatch(output, /no plugins installed/u);
});
