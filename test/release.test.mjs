import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { plan, tagExists, tagName, workingTreeIsClean } from '../lib/release.mjs';

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-release-'));
  const run = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.2.3', engines: { dsh: '>=0.2.0' } }, null, 2));
  run(['add', '.']);
  run(['commit', '-q', '-m', 'one']);
  return { dir, run };
}

test('the tag carries the package version and the prefix the project uses', () => {
  assert.equal(tagName('1.2.3'), 'plugin-v1.2.3');
  assert.equal(tagName('1.2.3', 'v'), 'v1.2.3');
});

test('a clean repository is reported clean, and a tag that exists is seen', () => {
  const { dir, run } = tempRepo();
  assert.equal(workingTreeIsClean(dir), true);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  assert.equal(workingTreeIsClean(dir), false);
  fs.writeFileSync(path.join(dir, 'package.json'), fs.readFileSync(path.join(dir, 'package.json')));
  run(['checkout', '--', '.']);
  run(['clean', '-qfd']);
  assert.equal(tagExists(dir, 'plugin-v1.2.3'), false);
  run(['tag', 'plugin-v1.2.3']);
  assert.equal(tagExists(dir, 'plugin-v1.2.3'), true);
});

test('the plan lists every step that a release has to finish, in order', () => {
  const { dir } = tempRepo();
  const planned = plan({ dir, indexFile: path.join(dir, 'market/index.json') });
  assert.equal(planned.tag, 'plugin-v1.2.3');
  const titles = planned.steps.map((step) => step.title);
  assert.ok(titles.length >= 7, titles.join(' | '));
  assert.match(titles[0], /read the manifest/i);
  const at = (pattern) => titles.findIndex((title) => pattern.test(title));
  assert.ok(at(/create the tag/i) > 0);
  assert.ok(at(/push the tag/i) > at(/create the tag/i));
  assert.ok(at(/registry serves/i) > at(/push the tag/i));
  assert.ok(at(/market index/i) > at(/registry serves/i));
});

test('--market writes the entry into another repository, and opens the PR there', async () => {
  const { release } = await import('../lib/release.mjs');
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-plugin-'));
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({
    name: 'demo-plugin', version: '3.0.0', files: ['index.js', 'client.js', 'cordis.patch.yml'],
    engines: { dsh: '>=0.2.0' },
    exports: { './client': './client.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
  }, null, 2));
  fs.writeFileSync(path.join(plugin, 'README.md'), '# demo\n\n## Requirements\n\n| Harness |\n| --- |\n| `>=0.2.0` |\n');
  fs.writeFileSync(path.join(plugin, 'cordis.patch.yml'), '- insert: []\n');
  fs.writeFileSync(path.join(plugin, 'index.js'), 'export function apply() {}\n');
  fs.writeFileSync(path.join(plugin, 'client.js'), 'window.__ModuleLoader__.load({ id: "x", factory: () => ({}) });\n');

  // The market lives in a different repository, which is the normal case for
  // anyone listed in someone else's index.
  const market = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-market-'));
  fs.mkdirSync(path.join(market, 'market'));
  fs.writeFileSync(path.join(market, 'market/index.json'), JSON.stringify({
    format: 1, plugins: [{ name: 'demo-plugin', versions: [] }],
  }, null, 2));

  const document = { versions: { '3.0.0': {} }, time: { '3.0.0': '2026-10-31T05:00:00.000Z' } };
  const git = (args) => {
    if (args[0] === 'rev-parse') throw new Error('missing');
    return '';
  };
  const marketCalls = [];
  const marketGit = (args) => {
    marketCalls.push(args.join(' '));
    return '';
  };
  const ghCalls = [];
  const gh = (args) => {
    ghCalls.push(args.join(' '));
    return 'https://example.test/pr/11';
  };

  const result = await release({
    dir: plugin,
    marketDir: market,
    pr: true,
    git,
    marketGit,
    gh,
    fetch: async () => ({ status: 200, ok: true, json: async () => document }),
    sleep: async () => {},
  });

  assert.equal(result.ok, true, JSON.stringify(result.failures ?? []));
  assert.equal(result.indexUpdate.file, path.join(market, 'market/index.json'));
  const written = JSON.parse(fs.readFileSync(path.join(market, 'market/index.json'), 'utf8'));
  assert.equal(written.plugins[0].versions[0].version, '3.0.0');
  assert.equal(written.plugins[0].versions[0].engines.dsh, '>=0.2.0');
  assert.deepEqual(marketCalls.slice(0, 4), [
    'checkout -b market/3.0.0',
    'add market/index.json',
    'commit -m market: 3.0.0',
    'push -u origin market/3.0.0',
  ]);
  assert.match(ghCalls[0], /^pr create --base main --head market\/3\.0\.0/);
});

test('--publish runs the publish here, for repositories without a publish workflow', async () => {
  const { release } = await import('../lib/release.mjs');
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-publish-'));
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({
    name: 'demo-plugin', version: '4.0.0', files: ['index.js', 'client.js', 'cordis.patch.yml'],
    engines: { dsh: '>=0.2.0' },
    exports: { './client': './client.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
  }, null, 2));
  fs.writeFileSync(path.join(plugin, 'README.md'), '# demo\n\n## Requirements\n\n| Harness |\n| --- |\n| `>=0.2.0` |\n');
  fs.writeFileSync(path.join(plugin, 'cordis.patch.yml'), '- insert: []\n');
  fs.writeFileSync(path.join(plugin, 'index.js'), 'export function apply() {}\n');
  fs.writeFileSync(path.join(plugin, 'client.js'), 'window.__ModuleLoader__.load({ id: "x", factory: () => ({}) });\n');

  const git = (args) => {
    if (args[0] === 'rev-parse') throw new Error('missing');
    return '';
  };
  const document = { versions: { '4.0.0': {} }, time: { '4.0.0': '2026-10-31T06:00:00.000Z' } };
  const published = [];
  const publishPackage = (dir) => {
    published.push(dir);
  };

  const result = await release({
    dir: plugin, publish: true, git, publishPackage,
    fetch: async () => ({ status: 200, ok: true, json: async () => document }),
    sleep: async () => {},
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures ?? []));
  assert.deepEqual(published, [plugin]);

  // Without the flag the registry wait is the only thing that runs.
  published.length = 0;
  await release({
    dir: plugin, git, publishPackage,
    fetch: async () => ({ status: 200, ok: true, json: async () => document }),
    sleep: async () => {},
  });
  assert.deepEqual(published, []);
});

test('release refuses a malformed engines.dsh and leaves the index untouched', async (t) => {
  const { release } = await import('../lib/release.mjs');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-bad-range-'));
  const market = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-bad-range-market-'));
  t.after(() => {
    fs.rmSync(plugin, { recursive: true, force: true });
    fs.rmSync(market, { recursive: true, force: true });
  });

  fs.cpSync(path.join(here, 'fixtures', 'good'), plugin, { recursive: true });
  const manifestPath = path.join(plugin, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.engines.dsh = '>=banana';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  fs.mkdirSync(path.join(market, 'market'));
  const indexFile = path.join(market, 'market', 'index.json');
  const before = `${JSON.stringify({
    format: 1,
    plugins: [{ name: manifest.name, versions: [] }],
  }, null, 2)}\n`;
  fs.writeFileSync(indexFile, before);

  let gitCalls = 0;
  let fetchCalls = 0;
  const result = await release({
    dir: plugin,
    marketDir: market,
    git: () => {
      gitCalls += 1;
      return '';
    },
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('the registry should not be reached');
    },
    sleep: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'preflight');
  assert.ok(
    result.failures.some(
      ({ check, message }) => check === 'engines.dsh' && /not a semver range/u.test(message),
    ),
    JSON.stringify(result.failures),
  );
  assert.equal(gitCalls, 0, 'release must not tag a manifest it will refuse');
  assert.equal(fetchCalls, 0, 'release must stop before the registry wait');
  assert.equal(fs.readFileSync(indexFile, 'utf8'), before, 'the index must not be written');
});
