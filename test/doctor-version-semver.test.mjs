import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkVersion, doctor } from '../lib/doctor.mjs';
import { run } from '../lib/exec.mjs';
import { init } from '../lib/init.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'bin', 'dsh-plugin.mjs');
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-version-'));

/** A clean `init` scaffold with its manifest version replaced. */
function scaffold(version) {
  const dir = path.join(scratch(), 'plugin');
  init({ dir, name: 'version-check-plugin', title: 'Version check' });
  const manifestPath = path.join(dir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = version;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

const valid = ['1.0.0+build.5', '2.3.4+sha.abc', '0.1.0+20261103'];
const invalid = ['1.0.0-..', '1.0.0-.', '1.0.0+build..1', '1.0.0-01'];

test('checkVersion accepts SemVer 2.0 build metadata', () => {
  for (const version of valid) {
    assert.equal(checkVersion({ version }), null, version);
  }
});

test('doctor exits 0 on a clean scaffold with build metadata', () => {
  for (const version of valid) {
    const dir = scaffold(version);
    const report = doctor(dir);
    assert.deepEqual(report.failures, [], `${version}: ${JSON.stringify(report.failures)}`);

    const result = runCli(['doctor', dir]);
    assert.equal(result.status, 0, `${version}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, new RegExp(`ok  version-check-plugin@${version.replace(/[.+]/gu, '\\$&')}`, 'u'));
  }
});

/** `npm pack --dry-run` in a scratch cache, so the test writes only under the temp dir. */
function packDryRun(dir) {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-version-npm-'));
  const logs = path.join(cache, '_logs');
  fs.mkdirSync(logs, { recursive: true });
  try {
    const stdout = run('npm', ['pack', '--dry-run', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, npm_config_cache: cache, npm_config_logs_dir: logs },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message),
    };
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
}

test('doctor, release --dry-run and npm pack agree on build metadata', (t) => {
  const rows = [];
  for (const version of valid) {
    const dir = scaffold(version);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const doctorResult = runCli(['doctor', dir]);
    const releaseResult = runCli(['release', dir, '--dry-run']);
    const packResult = packDryRun(dir);
    rows.push({ version, doctor: doctorResult, release: releaseResult, pack: packResult });
  }

  const ok = (kind) => rows.filter((row) => row[kind].status === 0).length;
  const summary = `doctor_ok=${ok('doctor')} release_ok=${ok('release')} pack_ok=${ok('pack')}`;
  console.log(summary);
  assert.equal(
    summary,
    'doctor_ok=3 release_ok=3 pack_ok=3',
    rows.map((row) => [
      `${row.version}: doctor=${row.doctor.status} release=${row.release.status} pack=${row.pack.status}`,
      row.doctor.stdout + row.doctor.stderr,
      row.release.stdout + row.release.stderr,
      row.pack.stdout + row.pack.stderr,
    ].join('\n')).join('\n'),
  );

  for (const row of rows) {
    assert.match(row.doctor.stdout, new RegExp(`ok  version-check-plugin@${row.version.replace(/[.+]/gu, '\\$&')}`, 'u'));
    assert.match(row.release.stdout, new RegExp(`Create the tag plugin-v${row.version.replace(/[.+]/gu, '\\$&')}`, 'u'));
    const [packed] = JSON.parse(row.pack.stdout);
    assert.equal(packed.name, 'version-check-plugin');
    assert.equal(packed.version, row.version);
  }
});

test('doctor still rejects malformed pre-release and build identifiers', () => {
  for (const version of invalid) {
    assert.match(checkVersion({ version }), /is not semver/u, version);

    const dir = scaffold(version);
    assert.equal(doctor(dir).failures.some(({ check }) => check === 'version'), true, version);

    const result = runCli(['doctor', dir]);
    assert.equal(result.status, 1, `${version}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /✗ version:/u, `${version}: ${result.stderr}`);
  }
});
