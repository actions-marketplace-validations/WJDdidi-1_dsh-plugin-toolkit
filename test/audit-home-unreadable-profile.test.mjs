/**
 * A profile whose `package.json` is truncated is not an empty profile.
 *
 * The old reader caught the parse failure and returned an empty
 * `dsh.profile.bundles` list. When the only plugin the profile declared also
 * had an unreadable manifest, the scan found nothing: `audit --home` printed
 * "no plugins installed in any profile" and exited `0`, hiding both the plugin
 * and the damaged profile. The profile file is the record the audit was asked
 * to read, so its parse failure must be a finding, not a silently empty list.
 *
 * The controls keep the fix honest: a valid profile with a healthy plugin still
 * exits `0`, an empty profile still prints the empty-profile line and exits
 * `0`, and a healthy sibling is still listed when another profile file is
 * broken.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { audit, listInstalled, readProfileBundles } from '../lib/audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const EMPTY = 'no plugins installed in any profile';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-home-unreadable-profile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runAudit(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function profileDir(home, name = 'desktop') {
  const dir = path.join(home, 'profiles', name);
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  return dir;
}

function writeProfile(dir, bundles, { bom = false } = {}) {
  const raw = JSON.stringify({ name: 'desktop', private: true, dsh: { profile: { bundles } } }, null, 2);
  // Notepad writes a UTF-8 BOM; the profile reader must keep reading that file
  // as a normal profile instead of reporting it as an unreadable one.
  fs.writeFileSync(path.join(dir, 'package.json'), `${bom === true ? '\uFEFF' : ''}${raw}`);
  return path.join(dir, 'package.json');
}

function writePlugin(dir, name, manifest) {
  const plugin = path.join(dir, 'node_modules', name);
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify(manifest, null, 2));
  return plugin;
}

function goodPlugin(dir, name) {
  const plugin = writePlugin(dir, name, {
    name,
    version: '1.0.0',
    files: ['index.js', 'client.js', 'cordis.patch.yml', 'README.md'],
    engines: { dsh: '>=0.2.0' },
    exports: { '.': './index.js', './client': './client.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
  });
  fs.writeFileSync(path.join(plugin, 'index.js'), 'export function apply() {}\n');
  fs.writeFileSync(
    path.join(plugin, 'client.js'),
    'window.__ModuleLoader__.load({ id: "x", factory: () => ({}) });\n',
  );
  fs.writeFileSync(path.join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: test-plugin\n      name: test-plugin\n      config: {}\n');
  fs.writeFileSync(path.join(plugin, 'README.md'), '# demo\n\n## Requirements\n\n`>=0.2.0`\n');
  return plugin;
}

/** The interrupted-write shape: valid prefix, no closing braces. */
function writeTruncatedProfile(dir) {
  const file = path.join(dir, 'package.json');
  fs.writeFileSync(
    file,
    '{\n  "name": "desktop",\n  "private": true,\n  "dsh": { "profile": { "bundles": ["ghost-plugin"] }\n',
  );
  return file;
}

test('a truncated profile with a hidden declared plugin exits 1 and names the parse failure', (t) => {
  const home = scratch(t);
  const dir = profileDir(home);
  const profileFile = writeTruncatedProfile(dir);
  // The declared plugin's own manifest is also truncated, so the old scan had
  // no readable dsh field to fall back on and printed the false clean.
  const ghost = path.join(dir, 'node_modules', 'ghost-plugin');
  fs.mkdirSync(ghost, { recursive: true });
  fs.writeFileSync(path.join(ghost, 'package.json'), '{"name": "ghost-plugin"');

  const result = runAudit(['audit', '--home', home, '--timeout', '50']);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.ok(output.includes(profileFile), `the finding must name ${profileFile}\n${output}`);
  assert.match(output, /is not valid JSON/u, 'the parse failure must be printed');
  assert.match(output, /unreadable profile/u, 'the profile must be reported as unreadable');
  assert.doesNotMatch(output, new RegExp(EMPTY, 'u'), 'the damaged profile was reported as empty');
});

test('the library reports the profile row and keeps a valid sibling plugin', async (t) => {
  const home = scratch(t);
  const dir = profileDir(home);
  const profileFile = writeTruncatedProfile(dir);
  goodPlugin(dir, 'good-plugin');

  const profile = readProfileBundles({ home, profile: 'desktop' });
  assert.deepEqual(profile.bundles, [], 'callers that only read bundles still get the empty list');
  assert.match(profile.error, /package\.json is not valid JSON/u);

  const found = listInstalled({ home });
  assert.ok(
    found.some((entry) => entry.profileUnreadable === true && entry.manifestPath === profileFile),
    'the scan must produce a profile row instead of only scanning node_modules',
  );

  const lines = [];
  const result = await audit({ home, io: { log: (line) => lines.push(line) } });
  assert.equal(result.ok, false);
  const broken = result.plugins.find((plugin) => plugin.profileUnreadable === true);
  assert.equal(broken.name, 'desktop');
  assert.equal(broken.failures[0].check, 'profile manifest');
  assert.match(broken.failures[0].message, /package\.json is not valid JSON/u);
  assert.equal(result.plugins.find((plugin) => plugin.name === 'good-plugin')?.hard.length, 0);

  const text = lines.join('\n');
  assert.match(text, /^desktop\s+\?\s+unreadable profile\b/mu);
  assert.match(text, /profile manifest: .*package\.json is not valid JSON/u);
  assert.match(text, /^good-plugin\s+1\.0\.0\s+\?\s+ok$/mu);
  assert.doesNotMatch(text, new RegExp(EMPTY, 'u'));
});

test('a loaded plugin in a truncated profile is not told to edit a list it cannot read', async (t) => {
  const home = scratch(t);
  const dir = profileDir(home);
  writeTruncatedProfile(dir);
  goodPlugin(dir, 'good-plugin');

  const encoder = new TextEncoder();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"graph","graph":{"entries":[]}}\n\n'));
        controller.close();
      },
    }),
  });

  const lines = [];
  const result = await audit({
    home,
    host: 'http://127.0.0.1:9',
    fetchImpl,
    io: { log: (line) => lines.push(line) },
  });
  assert.equal(result.ok, false);
  const good = result.plugins.find((plugin) => plugin.name === 'good-plugin');
  assert.equal(good.loaded, false);
  assert.match(good.reason, /cannot be read/u, 'the cause is the unreadable profile, not the plugin');
  assert.match(good.action, /repair .*package\.json/u);
  assert.doesNotMatch(good.reason, /does not list it/u);
  const text = lines.join('\n');
  assert.doesNotMatch(text, /add "good-plugin" to dsh\.profile\.bundles/u);
});

test('a valid profile with a healthy plugin is still the green control', (t) => {
  const home = scratch(t);
  const dir = profileDir(home);
  writeProfile(dir, ['good-plugin']);
  goodPlugin(dir, 'good-plugin');

  const result = runAudit(['audit', '--home', home, '--timeout', '50']);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /^good-plugin\s+1\.0\.0\s+\?\s+ok$/mu);
  assert.doesNotMatch(output, /unreadable profile/u);
  assert.doesNotMatch(output, new RegExp(EMPTY, 'u'));
});

test('a valid profile with no plugins still prints the empty line and exits 0', (t) => {
  const home = scratch(t);
  const dir = profileDir(home);
  writeProfile(dir, []);

  const result = runAudit(['audit', '--home', home, '--timeout', '50']);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, new RegExp(EMPTY, 'u'));
  assert.doesNotMatch(output, /unreadable profile/u);
});

test('a BOM profile with a healthy plugin still exits 0 with its row', (t) => {
  const home = scratch(t);
  const dir = profileDir(home);
  writeProfile(dir, ['good-plugin'], { bom: true });
  goodPlugin(dir, 'good-plugin');

  const result = runAudit(['audit', '--home', home, '--timeout', '50']);
  const output = `${result.stdout}\n${result.stderr}`;
  // The new profile finding must not swallow the BOM support the reader
  // already had: a BOM profile is a valid profile with a plugin row, not a
  // damaged file.
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /^good-plugin\s+1\.0\.0\s+\?\s+ok$/mu);
  assert.doesNotMatch(output, /unreadable profile/u);
  assert.doesNotMatch(output, new RegExp(EMPTY, 'u'));
});

test('an empty home still exits 0 with the empty line, whether profiles exists or not', (t) => {
  const withoutProfiles = scratch(t);
  const withProfiles = scratch(t);
  fs.mkdirSync(path.join(withProfiles, 'profiles'));

  for (const [label, home] of [
    ['no profiles directory', withoutProfiles],
    ['empty profiles directory', withProfiles],
  ]) {
    const result = runAudit(['audit', '--home', home, '--timeout', '50']);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, `${label}\n${output}`);
    assert.match(result.stdout, new RegExp(EMPTY, 'u'), `${label}\n${output}`);
    assert.doesNotMatch(output, /unreadable profile/u, `${label}\n${output}`);
    assert.equal(result.stderr, '', `${label}\n${output}`);
  }
});

test('a malformed package.json in an undeclared dependency still adds no row', (t) => {
  const home = scratch(t);
  const dir = profileDir(home);
  writeProfile(dir, []);
  const ordinary = path.join(dir, 'node_modules', 'ordinary-dependency');
  fs.mkdirSync(ordinary, { recursive: true });
  // The profile never names this package and its dsh field cannot be read, so
  // there is no evidence that it was installed as a plugin. The profile
  // finding must not widen the exception to every broken transitive install.
  fs.writeFileSync(path.join(ordinary, 'package.json'), '{"name": "ordinary-dependency"');

  assert.deepEqual(listInstalled({ home }), [], 'the undeclared broken dependency must not be an installed plugin');

  const result = runAudit(['audit', '--home', home, '--timeout', '50']);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, new RegExp(EMPTY, 'u'));
  assert.doesNotMatch(output, /ordinary-dependency|unreadable profile/u);
});
