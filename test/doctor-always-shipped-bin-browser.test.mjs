/**
 * npm-packlist's strict rules also add `main`, `browser` and every `bin` target
 * to the tarball whatever `files` says. `ALWAYS_SHIPPED` only knew `main`, so a
 * plugin that published its `bin` or `browser` file and also exported the same
 * path was told to add it to `files` even though `npm pack` had already
 * included it. The fixture exports both paths and leaves them out of `files`,
 * and the installed CLI must keep it clean while npm's own dry run ships both.
 *
 * The installed-tarball run also packs a second fixture whose `main` is written
 * `./index.js`: npm puts the field in its strict rules verbatim, so the tarball
 * omits `index.js` and the same CLI must reject it. The unit test keeps the
 * predicate honest in the other direction: a path that only `exports` names is
 * still a files-list failure, so this cannot become "ignore every unlisted
 * export".
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
const FIXTURE = path.join(HERE, 'fixtures', 'always-included-bin-browser');
const DOT_MAIN = path.join(HERE, 'fixtures', 'not-always-shipped-dot-main');

// Keep npm's cache under the temp directory: the checkout can be in a sandbox
// whose `~/.npm` is not writable, and that must not hide the packer's verdict.
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bin-browser-npm-'));
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

function readManifest(dir = FIXTURE) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

function packedFixtureFiles(dir = FIXTURE) {
  const output = run('npm', ['pack', '--dry-run', '--json'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [document] = parsePackOutput(output);
  assert.ok(document, `npm pack --dry-run --json printed no tarball document for ${dir}:\n${output}`);
  return new Set((document.files ?? []).map((entry) => entry.path));
}

test('a main, browser or bin target is always shipped, but a bare export is not', () => {
  const manifest = readManifest();
  const declared = new Set(declaredPaths(manifest));
  for (const entry of ['index.js', 'browser.js', 'bin/cli.mjs']) {
    assert.ok(declared.has(entry), `the fixture no longer declares ${entry}`);
    assert.equal(manifest.files.includes(entry), false, `the fixture now lists ${entry} in files`);
  }

  assert.deepEqual(missingDeclaredPaths(manifest), [], 'bin/browser targets are always shipped');
  assert.deepEqual(
    missingDeclaredPaths({ ...manifest, bin: './bin/cli.mjs' }),
    [],
    'a string bin is the single executable npm always ships',
  );

  // npm writes `!/${main}` and `!/${browser}` verbatim. A leading `./` makes
  // the strict rule name a path that is not in the tarball, so these files
  // really are dropped unless `files` lists them.
  assert.deepEqual(
    missingDeclaredPaths({ ...manifest, main: './index.js' }),
    ['index.js'],
    'a main written ./index.js is not in npm always-included set',
  );
  assert.deepEqual(
    missingDeclaredPaths({ ...manifest, browser: './browser.js' }),
    ['browser.js'],
    'a browser written ./browser.js is not in npm always-included set',
  );

  const bareExport = {
    ...manifest,
    exports: { ...manifest.exports, './extra': './extra.js' },
  };
  assert.deepEqual(
    missingDeclaredPaths(bareExport),
    ['extra.js'],
    'an export that is not a main, browser or bin target still has to be listed',
  );
});

test('the installed tarball CLI keeps a bin/browser export clean, and npm ships both', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bin-browser-tarball-'));
  try {
    const shipped = packedFixtureFiles();
    for (const required of ['bin/cli.mjs', 'browser.js']) {
      assert.ok(shipped.has(required), `npm pack no longer ships ${required}:\n${[...shipped].sort().join('\n')}`);
    }

    const packOutput = run('npm', ['pack', '--pack-destination', scratch, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const [toolkit] = parsePackOutput(packOutput);
    assert.ok(toolkit, `npm pack --json printed no tarball document:\n${packOutput}`);
    const toolkitFiles = new Set(toolkit.files.map((entry) => entry.path));
    for (const required of ['bin/dsh-plugin.mjs', 'lib/cli.mjs', 'lib/doctor.mjs']) {
      assert.ok(toolkitFiles.has(required), `the toolkit tarball does not ship ${required}`);
    }

    const prefix = path.join(scratch, 'install');
    run(
      'npm',
      [
        'install',
        path.join(scratch, toolkit.filename),
        '--prefix',
        prefix,
        '--no-save',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--omit=peer',
      ],
      { cwd: scratch, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const installedBin = path.join(prefix, 'node_modules', 'dsh-plugin-toolkit', 'bin', 'dsh-plugin.mjs');
    assert.ok(fs.existsSync(installedBin), `the tarball installed no CLI at ${installedBin}`);

    const result = spawnSync(process.execPath, [installedBin, 'doctor', FIXTURE], {
      // Run outside the checkout and the install prefix: a command that only
      // works because it can borrow this repository's files is not the command
      // a user installs.
      cwd: scratch,
      encoding: 'utf8',
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, `installed CLI:\n${output}`);
    assert.match(output, /^ok {2}always-included-bin-browser-fixture@1\.0\.0 /mu, output);
    assert.doesNotMatch(output, /✗ files list:/u, output);

    // The other direction: npm drops a `./index.js` main, so the same installed
    // CLI must reject the fixture instead of trusting the field name.
    const dotMain = readManifest(DOT_MAIN);
    assert.equal(dotMain.main, './index.js');
    assert.equal(dotMain.files.includes('index.js'), false);
    const dotShipped = packedFixtureFiles(DOT_MAIN);
    assert.equal(dotShipped.has('index.js'), false, `npm pack unexpectedly ships index.js:\n${[...dotShipped].sort().join('\n')}`);
    assert.ok(dotShipped.has('cordis.patch.yml'), 'npm pack no longer ships the dot-main patch');

    const dotResult = spawnSync(process.execPath, [installedBin, 'doctor', DOT_MAIN], {
      cwd: scratch,
      encoding: 'utf8',
    });
    const dotOutput = `${dotResult.stdout}\n${dotResult.stderr}`;
    assert.equal(dotResult.status, 1, `dot-main fixture, installed CLI:\n${dotOutput}`);
    assert.match(
      dotOutput,
      /✗ files list: files does not ship index\.js, which package\.json points at/u,
      dotOutput,
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
