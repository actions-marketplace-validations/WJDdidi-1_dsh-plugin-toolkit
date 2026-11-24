/**
 * npm always ships `package.json`, README, COPYING, LICENSE and the `main`
 * file whatever `files` says. The combined always-included fixture in
 * `doctor-changelog-always-shipped.test.mjs` proves the set as a whole; these
 * five committed packages isolate one declaration each, so a regression in a
 * single name cannot hide behind another path that is still always shipped.
 *
 * Every fixture is handed to `npm pack --dry-run --json` and to the doctor from
 * an installed tarball of this toolkit. Each target has to appear in the pack
 * output and stay clean in five consecutive trials, which is the acceptance
 * line for the milestone: the verdict is pinned at the tarball boundary, not
 * against a helper only the test can call.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { declaredPaths, missingDeclaredPaths } from '../lib/doctor.mjs';
import { run } from '../lib/exec.mjs';
import { parsePackOutput } from '../lib/verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TRIALS = 5;

const TARGETS = [
  {
    dir: 'always-included-readme',
    file: 'README.md',
    packageName: 'always-included-readme-fixture',
    declaration: 'exports["./readme"]',
    exportKey: './readme',
  },
  {
    dir: 'always-included-license',
    file: 'LICENSE',
    packageName: 'always-included-license-fixture',
    declaration: 'exports["./license"]',
    exportKey: './license',
  },
  {
    dir: 'always-included-copying',
    file: 'COPYING',
    packageName: 'always-included-copying-fixture',
    declaration: 'exports["./copying"]',
    exportKey: './copying',
  },
  {
    dir: 'always-included-manifest',
    file: 'package.json',
    packageName: 'always-included-manifest-fixture',
    declaration: 'exports["./manifest"]',
    exportKey: './manifest',
  },
  {
    dir: 'always-included-main',
    file: 'index.js',
    packageName: 'always-included-main-fixture',
    declaration: 'main',
    exportKey: null,
  },
];

// Keep npm's cache and logs under the temp directory: the checkout can be in a
// sandbox whose `~/.npm` is not writable, and a failing pack would hide the
// behaviour this test checks.
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-always-included-npm-'));
process.env.npm_config_cache = cache;
process.env.npm_config_logs_dir = path.join(cache, '_logs');
fs.mkdirSync(process.env.npm_config_logs_dir, { recursive: true });
process.on('exit', () => {
  try {
    fs.rmSync(cache, { recursive: true, force: true });
  } catch {
    // A leftover temp cache is not a test failure.
  }
});

const fixture = (dir) => path.join(HERE, 'fixtures', dir);

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(fixture(dir), 'package.json'), 'utf8'));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function packedFixtureFiles(dir) {
  const output = run('npm', ['pack', '--dry-run', '--json'], {
    cwd: fixture(dir),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [document] = parsePackOutput(output);
  assert.ok(document, `npm pack --dry-run --json printed no tarball document for ${dir}:\n${output}`);
  return new Set((document.files ?? []).map((entry) => entry.path));
}

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
    // works because it can borrow this repository's files is not the command
    // a user installs.
    cwd: scratch,
    encoding: 'utf8',
  });
}

test('each fixture declares exactly one always-included path and omits it from files', () => {
  for (const target of TARGETS) {
    const manifest = readManifest(target.dir);
    const label = `${target.dir}: ${target.declaration}`;

    assert.equal(manifest.name, target.packageName, `${target.dir} changed its name`);
    assert.equal(manifest.files.includes(target.file), false, `${label} now lists ${target.file} in files`);
    assert.ok(manifest.files.length > 0, `${target.dir} lost its files list`);

    if (target.exportKey === null) {
      assert.equal(manifest.main, target.file, `${label} no longer declares ${target.file} as main`);
    } else {
      assert.equal(manifest.exports[target.exportKey], `./${target.file}`, `${label} no longer exports ${target.file}`);
    }
    assert.ok(declaredPaths(manifest).includes(target.file), `${label} is not a declared path`);

    assert.ok(fs.statSync(path.join(fixture(target.dir), target.file)).isFile(), `${label} names a missing file`);
    assert.deepEqual(
      missingDeclaredPaths(manifest, fixture(target.dir)),
      [],
      `${label} is reported missing even though npm always ships it`,
    );
  }
});

test(`the installed CLI keeps every always-included declaration clean ${TRIALS}/${TRIALS} and npm ships it ${TRIALS}/${TRIALS}`, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-always-included-tarball-'));
  try {
    const toolkit = packToolkit(scratch);
    const toolkitFiles = new Set(toolkit.files.map((entry) => entry.path));
    for (const required of ['bin/dsh-plugin.mjs', 'lib/cli.mjs', 'lib/doctor.mjs']) {
      assert.ok(toolkitFiles.has(required), `the toolkit tarball does not ship ${required}`);
    }

    const installedBin = installToolkit(scratch, toolkit);
    assert.notEqual(
      path.resolve(installedBin),
      path.join(ROOT, 'bin', 'dsh-plugin.mjs'),
      'the installed CLI resolved back to the checkout copy',
    );

    for (const target of TARGETS) {
      const manifest = readManifest(target.dir);
      const statuses = [];
      for (let trial = 1; trial <= TRIALS; trial += 1) {
        const shipped = packedFixtureFiles(target.dir);
        assert.ok(
          shipped.has(target.file),
          `trial ${trial}: npm pack omits always-included ${target.file} from ${target.dir}:\n${[...shipped].sort().join('\n')}`,
        );

        const result = invoke(installedBin, scratch, ['doctor', fixture(target.dir)]);
        const output = `${result.stdout}\n${result.stderr}`;
        statuses.push(result.status);
        assert.equal(result.status, 0, `${target.dir}, trial ${trial}, installed CLI:\n${output}`);
        assert.match(
          output,
          new RegExp(`^ok {2}${escapeRegExp(manifest.name)}@1\\.0\\.0 `, 'mu'),
          `${target.dir}, trial ${trial}:\n${output}`,
        );
        assert.doesNotMatch(output, /✗ files list:/u, `${target.dir}, trial ${trial}:\n${output}`);
      }
      assert.deepEqual(
        statuses,
        Array(TRIALS).fill(0),
        `${target.dir}: ${statuses.filter((status) => status === 0).length}/${TRIALS} clean trials`,
      );
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
