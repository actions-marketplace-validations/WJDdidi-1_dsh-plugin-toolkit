/**
 * `doctor` reads the repository; users install the tarball. These tests are
 * about that difference: the scaffold passes both, a `files` list that drops the
 * panel passes `doctor` and must fail `verify`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

import { init } from '../lib/init.mjs';
import { verify } from '../lib/verify.mjs';
import { run } from '../lib/cli.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function recorder() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

function scratchEntries(tmp) {
  return fs.readdirSync(tmp).filter((name) => name.startsWith('dsh-plugin-verify-'));
}

/** Run a callback with every temp-directory variable pointed at one empty dir. */
async function withIsolatedTmp(callback) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-tmp-'));
  const keys = ['TMPDIR', 'TEMP', 'TMP'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = tmp;
  try {
    return await callback(tmp);
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('the scaffold survives being packed, installed and mounted', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-')), 'plugin');
  init({ dir, name: 'verify-me', title: 'Verify me' });
  const result = await verify({ dir });
  assert.deepEqual(result.failures, []);
  assert.equal(result.stage, 'mount');
  assert.match(result.text, /Verify me/);
  assert.ok(result.files.includes('client.js'), 'the tarball has to contain the panel');
});

test('verify removes its scratch install directory, even when a stage fails', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-scratch-')), 'plugin');
  init({ dir, name: 'clean-scratch' });

  await withIsolatedTmp(async (tmp) => {
    const passed = await verify({ dir, mount: false });
    assert.equal(passed.ok, true, JSON.stringify(passed.failures));
    assert.deepEqual(scratchEntries(tmp), [], 'a successful run left its install tree behind');

    // The same plugin, now failing after the scratch install: the early return
    // still has to clean up, not only the successful path.
    fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply() {}\nthrow new Error("boom");\n');
    const manifestPath = path.join(dir, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.main = 'index.js';
    manifest.files = ['index.js', 'client.js', 'cordis.patch.yml', 'README.md'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const failed = await verify({ dir, mount: false });
    assert.equal(failed.ok, false);
    assert.equal(failed.stage, 'install');
    assert.deepEqual(scratchEntries(tmp), [], 'a failed run left its install tree behind');
  });
});

test('a files list that drops the panel is refused, and doctor now catches it too', async () => {
  const dir = path.join(root, 'fixtures', 'not-shipped');
  const result = await verify({ dir });
  assert.equal(result.ok, false);
  // This used to reach the tarball; reading package.json's own `files` list is
  // enough to see the omission, so it stops at the manifest stage now.
  assert.equal(result.stage, 'doctor');
  assert.match(result.failures[0].message, /files does not ship client\.js/);
});

test('verify can stop after packing when mounting is not wanted', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-')), 'plugin');
  init({ dir, name: 'pack-only' });
  const result = await verify({ dir, mount: false });
  assert.equal(result.ok, true);
  assert.equal(result.stage, 'pack');
  assert.equal(result.text, undefined);
});

test('the success line says the host import was skipped when there is no root export', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-no-root-')), 'plugin');
  init({ dir, name: 'subpath-only' });
  const manifestPath = path.join(dir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // A bundle that only inserts a subpath plugin needs no root module. There is
  // nothing for the loader to import, so verify must not claim it did.
  delete manifest.main;
  manifest.exports = { './client': './client.js' };
  manifest.files = ['client.js', 'cordis.patch.yml', 'README.md'];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.rmSync(path.join(dir, 'index.js'));

  const result = await verify({ dir, mount: false });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.hostImported, false);

  const io = recorder();
  const code = await run(['verify', dir, '--no-mount'], io);
  const output = io.lines.join('\n');
  assert.equal(code, 0, output);
  assert.match(output, /skipped the host import/);
  assert.doesNotMatch(output, /imported its host half/);
});

test('a manifest that doctor rejects stops before npm is asked anything', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-')), 'plugin');
  init({ dir, name: 'broken' });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  delete manifest.engines.dsh;
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const result = await verify({ dir });
  assert.equal(result.stage, 'doctor');
  assert.match(result.failures[0].message, /engines\.dsh/);
});

test('only the npm family gets a Windows suffix, because git and gh are .exe', async () => {
  const { command } = await import('../lib/exec.mjs');
  const win = process.platform === 'win32';
  assert.equal(command('npm'), win ? 'npm.cmd' : 'npm');
  assert.equal(command('git'), 'git');
  assert.equal(command('gh'), 'gh');
});

test('verify mounts with dependencies resolved from the plugin, not from the tool', () => {
  // `npx dsh-plugin-toolkit verify` runs out of npx's cache; a bare import of
  // jsdom would look there and fail even though the plugin declared it.
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'verify.mjs'), 'utf8');
  assert.match(source, /mountClient\(\{ file: entryFile, resolveFrom: dir \}\)/);
});

test('a root module that throws on import is refused, which doctor cannot see', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-')), 'plugin');
  init({ dir, name: 'silent-plugin' });
  // doctor reads the source and sees an `apply` export; the module still
  // throws the moment the loader imports it.
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply() {}\nthrow new Error("boom");\n');
  const manifestPath = path.join(dir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.main = 'index.js';
  manifest.files = ['index.js', 'client.js', 'cordis.patch.yml', 'README.md'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const result = await verify({ dir, mount: false });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'install');
  assert.match(result.failures[0].message, /does not import: boom/);
});

test('a client face that throws on a bare context is refused, because it fails the whole boot', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-boot-')), 'plugin');
  init({ dir, name: 'boot-bomb' });
  // The shape that broke a real profile: apply() reaches for a service that the
  // web boot has not mounted yet, and no inject list makes the loader wait.
  fs.writeFileSync(path.join(dir, 'client.js'), `window.__ModuleLoader__.load({
  id: 'boot-bomb',
  factory: () => ({
    apply(ctx) {
      ctx.locale.register('boot-bomb', {});
      ctx.inject(['sidebarRightTabs', 'sidebarRight'], (tabCtx) => {
        tabCtx.slots.register({ name: 'sidebar.right.pane.tab', key: 'boot-bomb' }, () => null);
      });
    },
  }),
});
`);
  const result = await verify({ dir });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'mount');
  const messages = result.failures.map((failure) => failure.message).join('\n');
  assert.match(messages, /declares no inject list/);
  assert.match(messages, /apply\(\) throws when the services are absent/);
});

test('a host face that reads an undeclared service is refused, because the row fails silently', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-host-')), 'plugin');
  init({ dir, name: 'host-bomb' });
  // The shape that produced the red dot with no message: cordis throws on the
  // read itself, so the whole apply fails and no route is ever registered.
  fs.writeFileSync(path.join(dir, 'index.js'), `export function apply(ctx) {
  const server = ctx.webServer;
  if (server) server.register({ kind: 'exact', path: '/host-bomb/check', handler: () => {} });
}
`);
  const result = await verify({ dir, mount: false });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'install');
  assert.match(result.failures[0].message, /apply\(\) throws when a service it never declared is read/);
});

test('a client face that guards its services passes, which the example plugin proved', async () => {
  // Regression: the probe used to hand the face `{}`, so `ctx.inject(...)` — the
  // cordis API every plugin uses — threw "ctx.inject is not a function" and a
  // correct plugin was reported as broken. Caught by this repository's own
  // example plugin, which uses exactly this shape.
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-guarded-')), 'plugin');
  init({ dir, name: 'guarded-panel' });
  fs.writeFileSync(path.join(dir, 'client.js'), `window.__ModuleLoader__.load({
  id: 'guarded-panel',
  factory: () => ({
    inject: ['slots', 'locale'],
    apply(ctx) {
      try { ctx.inject(['sidebarRightTabs'], (tabCtx) => { tabCtx.slots.register({ name: 'sidebar.right.pane.tab' }, () => null); }); } catch {}
    },
  }),
});
`);
  const result = await verify({ dir });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.stage, 'mount');
});

test('a wildcard export is shipped by its wildcard files entry', async () => {
  // `exports["./locale/*.json"]` names a folder of files; `npm pack` lists the
  // files, not the pattern. Comparing them as strings reported a correctly
  // packed plugin as broken — which is how the neighbour plugin was flagged.
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-glob-')), 'plugin');
  init({ dir, name: 'glob-locale' });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  manifest.exports = { ...manifest.exports, './locale/*.json': './locale/*.json' };
  manifest.files = [...manifest.files, 'locale/*.json'];
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.mkdirSync(path.join(dir, 'locale'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'locale', 'en.json'), '{}\n');

  const result = await verify({ dir, mount: false });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.ok(result.files.includes('locale/en.json'));
});

test('a bare bundle patch omitted from files fails verify at pack, before install', async () => {
  // `doctor` now catches the manifest omission too, but verify answers the
  // stronger question: is the patch in the file list npm will actually publish?
  const dir = path.join(root, 'test', 'fixtures', 'bare-path');
  const result = await verify({ dir, mount: false });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'pack');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].check, 'pack');
  assert.match(result.failures[0].message, /cordis\.patch\.yml/);
});

test('the CLI reports the bare-patch omission at pack and exits 1', async () => {
  const io = recorder();
  const code = await run(['verify', path.join(root, 'test', 'fixtures', 'bare-path'), '--no-mount'], io);
  const output = io.lines.join('\n');
  assert.equal(code, 1, output);
  assert.match(output, /stopped at pack/);
  assert.match(output, /cordis\.patch\.yml/);
});

test('the scaffold with the patch in files still exits 0 with --no-mount', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-patch-')), 'plugin');
  const scaffold = init({ dir, name: 'patch-shipped' });
  assert.equal(scaffold.ok, true, JSON.stringify(scaffold.failures));
  const io = recorder();
  const code = await run(['verify', dir, '--no-mount'], io);
  const output = io.lines.join('\n');
  assert.equal(code, 0, output);
  assert.match(output, /^ok  packed \d+ file\(s\)/m);
});

const conditionalRootFixtures = [
  ['import', 'root-export-conditions-cli'],
  ['default', 'root-export-conditions-default-cli'],
  ['require', 'root-export-conditions-require-cli'],
];

for (const [condition, fixture] of conditionalRootFixtures) {
  test(`doctor and verify --no-mount both refuse the ${condition} conditions-object root that resolves to the CLI`, async () => {
    const dir = path.join(root, 'test', 'fixtures', fixture);

    const doctorIo = recorder();
    assert.equal(await run(['doctor', dir], doctorIo), 1, doctorIo.lines.join('\n'));
    const doctorOutput = doctorIo.lines.join('\n');
    assert.match(doctorOutput, /root export: the root export cli\.mjs does not export apply/);

    const verifyIo = recorder();
    const code = await run(['verify', dir, '--no-mount'], verifyIo);
    const verifyOutput = verifyIo.lines.join('\n');
    assert.equal(code, 1, verifyOutput);
    assert.match(verifyOutput, /stopped at doctor/);
    assert.match(verifyOutput, /root export: the root export cli\.mjs does not export apply/);
  });
}

test('doctor and verify --no-mount both accept a string root export that names apply', async () => {
  const dir = path.join(root, 'test', 'fixtures', 'root-export-string-apply');

  const doctorIo = recorder();
  assert.equal(await run(['doctor', dir], doctorIo), 0, doctorIo.lines.join('\n'));

  const verifyIo = recorder();
  const code = await run(['verify', dir, '--no-mount'], verifyIo);
  const output = verifyIo.lines.join('\n');
  assert.equal(code, 0, output);
  assert.match(output, /^ok  packed \d+ file\(s\)/m);
});
