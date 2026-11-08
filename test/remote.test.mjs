import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTarget, auditRemote } from '../lib/remote.mjs';
import { run } from '../lib/cli.mjs';

const manifest = (extra = {}) => ({
  name: 'demo-plugin',
  version: '1.2.3',
  main: 'index.js',
  engines: { dsh: '>=0.2.0' },
  dsh: { bundle: { patch: 'cordis.patch.yml' } },
  files: ['index.js', 'cordis.patch.yml', 'README.md'],
  ...extra,
});

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** A fetch that serves `files` from memory and answers 404 for anything else. */
function github(files) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const path = url.replace('https://api.github.com/repos/demo/plugin/contents/', '').split('?')[0];
    if (Object.prototype.hasOwnProperty.call(files, path) === false) {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: encode(files[path]) }) };
  };
  return { fetchImpl, calls };
}

const plugin = {
  'package.json': JSON.stringify(manifest()),
  'index.js': 'export function apply() {}\n',
  'cordis.patch.yml': '- insert: []\n',
  'README.md': '# demo\n\n## Requirements\n\nRequires dsh >=0.2.0.\n',
};

test('parseTarget accepts owner/repo, a URL, and a .git URL', () => {
  assert.deepEqual(parseTarget('WJDdidi-1/dsh-plugin-toolkit'), {
    owner: 'WJDdidi-1',
    repo: 'dsh-plugin-toolkit',
    slug: 'WJDdidi-1/dsh-plugin-toolkit',
  });
  assert.equal(parseTarget('https://github.com/a/b.git').slug, 'a/b');
  assert.equal(parseTarget('https://github.com/a/b/').slug, 'a/b');
  assert.throws(() => parseTarget('only-one-part'), /is a name, not owner\/repo/);
  assert.throws(() => parseTarget('.'), /is a folder on this machine/);
});

test('a repository that would load passes every remote check', async () => {
  const { fetchImpl } = github(plugin);
  const report = await auditRemote('demo/plugin', { fetchImpl });
  assert.deepEqual(report.failures, []);
});

test('an empty dsh field fails the same check local doctor runs, and the CLI exits 1', async () => {
  const files = { ...plugin, 'package.json': JSON.stringify(manifest({ dsh: {} })) };
  const { fetchImpl } = github(files);
  const report = await auditRemote('demo/plugin', { fetchImpl });
  assert.deepEqual(
    report.failures.map((entry) => entry.check),
    ['dsh field'],
  );
  assert.match(report.failures[0].message, /^dsh\.bundle is missing/u);

  const lines = [];
  const io = { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
  const code = await run(['doctor', '--remote', 'demo/plugin'], io, { fetchImpl });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /dsh field: dsh\.bundle is missing/u);
});

test('a remote manifest with a missing, empty or invalid name fails the same name check', async () => {
  for (const name of [undefined, '', 'My Plugin!']) {
    const files = { ...plugin, 'package.json': JSON.stringify(manifest({ name })) };
    const { fetchImpl } = github(files);
    const report = await auditRemote('demo/plugin', { fetchImpl });
    assert.deepEqual(
      report.failures.map((entry) => entry.check),
      ['name'],
      JSON.stringify(name),
    );
    assert.match(report.failures[0].message, /name/u);

    const lines = [];
    const io = { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
    const code = await run(['doctor', '--remote', 'demo/plugin'], io, { fetchImpl });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /name: .*name/u);
  }
});

test('a manifest without engines.dsh fails with the wording the installer uses', async () => {
  const files = { ...plugin, 'package.json': JSON.stringify(manifest({ engines: undefined })) };
  const { fetchImpl } = github(files);
  const report = await auditRemote('demo/plugin', { fetchImpl });
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].check, 'engines.dsh');
  assert.match(report.failures[0].message, /incompatible with dsh/);
});

test('a declared client with no exports["./client"] is reported as the dropped row', async () => {
  const files = {
    ...plugin,
    'package.json': JSON.stringify(
      manifest({ dsh: { bundle: { patch: 'cordis.patch.yml' }, client: { platform: 'web' } } }),
    ),
    'client.js': 'export const x = 1;\n',
  };
  const { fetchImpl } = github(files);
  const report = await auditRemote('demo/plugin', { fetchImpl });
  const failure = report.failures.find((entry) => entry.check === 'client declaration');
  assert.match(failure.message, /drops the row/);
});

test('an exports["./client"] pointing outside the repository is caught', async () => {
  const files = {
    ...plugin,
    'package.json': JSON.stringify(
      manifest({
        exports: { '.': './index.js', './client': './dist/client.js' },
        dsh: { bundle: { patch: 'cordis.patch.yml' }, client: { platform: 'web' } },
      }),
    ),
  };
  const { fetchImpl } = github(files);
  const report = await auditRemote('demo/plugin', { fetchImpl });
  const failure = report.failures.find((entry) => entry.check === 'client declaration');
  assert.match(failure.message, /which is not in the repository/);
});

test('a root export that exists but does not export apply is caught', async () => {
  const files = { ...plugin, 'index.js': 'export const name = "demo";\n' };
  const { fetchImpl } = github(files);
  const report = await auditRemote('demo/plugin', { fetchImpl });
  const failure = report.failures.find((entry) => entry.check === 'root export');
  assert.match(failure.message, /does not export apply/);
});

test('a repository without package.json is not reported as clean', async () => {
  const { fetchImpl } = github({ 'README.md': '# demo\n' });
  const report = await auditRemote('demo/plugin', { fetchImpl });
  assert.equal(report.manifest, null);
  assert.equal(report.failures[0].check, 'manifest');
});

test('the CLI prints the failures and exits 1', async () => {
  const files = { ...plugin, 'package.json': JSON.stringify(manifest({ engines: undefined })) };
  const { fetchImpl } = github(files);
  const lines = [];
  const io = { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
  const code = await run(['doctor', '--remote', 'demo/plugin'], io, { fetchImpl });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /1 problem\(s\) in demo\/plugin/);
  assert.match(lines.join('\n'), /engines\.dsh/);
});

test('the CLI exits 0 and names the plugin when every check passes', async () => {
  const { fetchImpl } = github(plugin);
  const lines = [];
  const io = { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
  const code = await run(['doctor', '--remote', 'demo/plugin'], io, { fetchImpl });
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /ok {2}demo-plugin@1\.2\.3 \(host >=0\.2\.0\) at demo\/plugin/);
});

test('a malformed target is a usage error, not a crash', async () => {
  const lines = [];
  const io = { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
  const code = await run(['doctor', '--remote', 'not-a-repo'], io, { fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.equal(code, 2);
  assert.match(lines.join('\n'), /is a name, not owner\/repo/);
});

test('a package that builds before it packs skips the file checks and says so', async () => {
  const files = {
    ...plugin,
    'package.json': JSON.stringify(
      manifest({ scripts: { prepack: 'tsc', build: 'tsc' }, engines: { dsh: '>=0.2.0' } }),
    ),
  };
  const { fetchImpl } = github(files);
  const lines = [];
  const io = { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
  const code = await run(['doctor', '--remote', 'demo/plugin'], io, { fetchImpl });
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /note: .*built rather than committed/);
});

test('a rate-limited response names the limit and the token to set', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ message: 'rate limit' }) });
  await assert.rejects(
    () => auditRemote('demo/plugin', { fetchImpl, token: null }),
    /rate-limited this request \(403\).*GH_TOKEN/,
  );
});

test('GH_TOKEN is sent as a bearer token when it is set', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(options.headers.authorization);
    if (url.endsWith('package.json') === false) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: encode(JSON.stringify(manifest())) }) };
  };
  await auditRemote('demo/plugin', { fetchImpl, token: 'secret-token' });
  assert.equal(seen.every((value) => value === 'Bearer secret-token'), true);
});

test('a folder entry in files ships everything below it, as npm does', async () => {
  const { isShipped } = await import('../lib/doctor.mjs');
  assert.equal(isShipped('lib/index.js', ['lib']), true);
  assert.equal(isShipped('src/client.js', ['src']), true);
  assert.equal(isShipped('dist/other.js', ['lib']), false);
});
