import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { audit, listInstalled } from '../lib/audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const MISSING_BUNDLE_FIXTURE = path.join(here, 'fixtures', 'missing-declared-bundle');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-missing-install-'));
}

function recorder() {
  const lines = [];
  return { lines, log: (line) => lines.push(String(line)) };
}

function goodManifest(name) {
  return {
    name,
    version: '1.0.0',
    files: ['index.js', 'client.js', 'cordis.patch.yml'],
    engines: { dsh: '>=0.2.0' },
    exports: { './client': './client.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
  };
}

const goodFiles = {
  'README.md': '# demo\n\n## Requirements\n\n| Harness |\n| --- |\n| `>=0.2.0` |\n',
  'cordis.patch.yml': '- insert: []\n',
  'index.js': 'export function apply() {}\n',
  'client.js': 'window.__ModuleLoader__.load({ id: "x", factory: () => ({}) });\n',
};

function writePlugin(root, name, manifest, files = {}) {
  const dir = path.join(root, 'profiles', 'desktop', 'node_modules', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

function writeProfile(root, bundles) {
  const dir = path.join(root, 'profiles', 'desktop');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-desktop', private: true, dsh: { profile: { bundles } } }, null, 2),
  );
}

function fixtureHome() {
  const home = scratch();
  writeProfile(home, ['ghost-plugin', 'good-plugin']);
  writePlugin(home, 'good-plugin', goodManifest('good-plugin'), goodFiles);
  return home;
}

test('a declared bundle whose node_modules folder is gone is reported by listInstalled', () => {
  const home = fixtureHome();
  const found = listInstalled({ home });
  assert.deepEqual(found.map((entry) => entry.manifest.name).sort(), ['ghost-plugin', 'good-plugin']);
  const ghost = found.find((entry) => entry.manifest.name === 'ghost-plugin');
  assert.equal(ghost.missing, true);
  assert.match(ghost.error, /node_modules\/ghost-plugin/u, 'the missing folder must be named');
});

test('audit reports the missing declared bundle, fails, and still lists the valid sibling', async () => {
  const home = fixtureHome();
  const io = recorder();
  const result = await audit({ home, io });

  assert.equal(result.ok, false, 'a declared but uninstalled plugin must fail the audit');
  const ghost = result.plugins.find((plugin) => plugin.name === 'ghost-plugin');
  assert.equal(ghost.missing, true);
  assert.deepEqual(ghost.failures.map((failure) => failure.check), ['install']);
  assert.match(ghost.failures[0].message, /node_modules\/ghost-plugin/u);

  const good = result.plugins.find((plugin) => plugin.name === 'good-plugin');
  assert.equal(good.missing, false);
  assert.equal(good.hard.length, 0, 'the healthy sibling must not be blamed for the missing install');

  const text = io.lines.join('\n');
  assert.match(text, /^ghost-plugin\s+\?\s+missing\b/mu);
  assert.match(text, /node_modules\/ghost-plugin/u);
  assert.match(text, /^good-plugin\b/mu, 'the valid plugin must still be printed');
  assert.match(text, /1 of 2 installed plugin\(s\) have problems/u);
});

test('the shipped CLI reports the missing declared bundle and exits 1', () => {
  const home = fixtureHome();
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'dsh-plugin.mjs'), 'audit', '--home', home, '--timeout', '50'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /^ghost-plugin\s+\?\s+missing\b/mu);
  assert.match(output, /node_modules\/ghost-plugin/u);
  assert.match(output, /^good-plugin\b/mu, 'the valid plugin must still be printed');
});

test('the checked-in declared-but-absent fixture prints the ghost row and exits 1', async () => {
  // This is the minimal 0.20.12 shape: one name in dsh.profile.bundles and no
  // node_modules directory at all. The scan must start from the profile, not
  // from whatever it happens to find on disk, or the only declared plugin
  // silently vanishes and the command reports a clean exit.
  const modules = path.join(MISSING_BUNDLE_FIXTURE, 'profiles', 'desktop', 'node_modules');
  assert.equal(fs.existsSync(modules), false, 'the fixture must keep node_modules absent');

  const io = recorder();
  const result = await audit({ home: MISSING_BUNDLE_FIXTURE, io });
  assert.equal(result.ok, false, 'a declared but uninstalled plugin must fail the audit');
  assert.deepEqual(result.plugins.map((plugin) => plugin.name), ['ghost-plugin']);
  const ghost = result.plugins[0];
  assert.equal(ghost.missing, true);
  assert.equal(ghost.version, '?');
  assert.deepEqual(ghost.failures.map((failure) => failure.check), ['install']);
  assert.match(ghost.failures[0].message, /node_modules\/ghost-plugin/u);
  assert.match(io.lines.join('\n'), /^ghost-plugin\s+\?\s+missing\b/mu);

  const run = spawnSync(
    process.execPath,
    [path.join(ROOT, 'bin', 'dsh-plugin.mjs'), 'audit', '--home', MISSING_BUNDLE_FIXTURE, '--timeout', '50'],
    { encoding: 'utf8' },
  );
  const output = `${run.stdout}\n${run.stderr}`;
  assert.equal(run.status, 1, output);
  assert.match(output, /^ghost-plugin\s+\?\s+missing\b/mu, 'the missing declared bundle needs its own row');
  assert.match(output, /node_modules\/ghost-plugin/u, 'the row must name the absent folder');
  assert.match(output, /fix: reinstall ghost-plugin/u);
  assert.match(output, /1 of 1 installed plugin\(s\) have problems/u);
});

test('an absent package that the profile never declared stays out of the audit', async () => {
  const home = scratch();
  writeProfile(home, ['good-plugin']);
  writePlugin(home, 'good-plugin', goodManifest('good-plugin'), goodFiles);

  assert.deepEqual(
    listInstalled({ home }).map((entry) => entry.manifest.name),
    ['good-plugin'],
  );
  const io = recorder();
  const result = await audit({ home, io });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plugins.map((plugin) => plugin.name), ['good-plugin']);
  assert.doesNotMatch(io.lines.join('\n'), /ghost-plugin/u);
});

test('the shipped CLI exits 0 and never mentions an absent undeclared package', () => {
  const home = scratch();
  writeProfile(home, ['good-plugin']);
  writePlugin(home, 'good-plugin', goodManifest('good-plugin'), goodFiles);

  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'bin', 'dsh-plugin.mjs'), 'audit', '--home', home, '--timeout', '50'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(output, /ghost-plugin/u, 'an ordinary absent dependency must not be invented as a missing install');
  assert.match(output, /^good-plugin\b/mu, 'the installed plugin must still be printed');
});
