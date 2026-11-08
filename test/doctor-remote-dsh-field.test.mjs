/**
 * `doctor --remote` has to answer the same `dsh field` question as a local
 * `doctor`: a manifest with `dsh: {}` and no `dsh.bundle.patch`, and one with
 * no `dsh` field at all, are failures. A clean manifest still exits 0.
 *
 * The real bin runs with a `--require` shim that replaces global fetch with a
 * tiny mock of the GitHub contents API, so the assertions are on the exit code
 * and output a shell would see rather than on `run()`'s return value.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'dsh-plugin.mjs');

function manifest(extra = {}) {
  return {
    name: 'demo-plugin',
    version: '1.2.3',
    main: 'index.js',
    engines: { dsh: '>=0.2.0' },
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
    files: ['index.js', 'cordis.patch.yml', 'README.md'],
    ...extra,
  };
}

const support = {
  'index.js': 'export function apply() {}\n',
  'cordis.patch.yml': '- insert: []\n',
  'README.md': '# demo\n\n## Requirements\n\nRequires dsh >=0.2.0.\n',
};

function preload(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-remote-dsh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'github-fetch.cjs');
  fs.writeFileSync(
    file,
    `const files = JSON.parse(Buffer.from(process.env.DSH_DOCTOR_REMOTE_FILES ?? '', 'base64').toString('utf8'));
const prefix = '/repos/demo/plugin/contents/';
globalThis.fetch = async (url) => {
  const pathname = new URL(String(url)).pathname;
  if (pathname.startsWith(prefix) === false) {
    return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
  }
  const name = decodeURIComponent(pathname.slice(prefix.length));
  if (Object.prototype.hasOwnProperty.call(files, name) === false) {
    return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ encoding: 'base64', content: Buffer.from(files[name], 'utf8').toString('base64') }),
  };
};
`,
  );
  return file;
}

function runDoctor(t, manifestValue, extra = {}) {
  const files = {
    'package.json': JSON.stringify(manifest(manifestValue)),
    ...support,
    ...extra,
  };
  return spawnSync(process.execPath, ['--require', preload(t), CLI, 'doctor', '--remote', 'demo/plugin'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_DOCTOR_REMOTE_FILES: Buffer.from(JSON.stringify(files), 'utf8').toString('base64'),
    },
  });
}

test('doctor --remote reports an empty dsh field and exits 1', (t) => {
  const result = runDoctor(t, { dsh: {} });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /1 problem\(s\) in demo\/plugin/u);
  assert.match(result.stderr, /dsh field: dsh\.bundle is missing/u);
  assert.equal(result.stdout, '');
});

test('doctor --remote reports a missing dsh field and exits 1', (t) => {
  const result = runDoctor(t, { dsh: undefined });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /1 problem\(s\) in demo\/plugin/u);
  assert.match(result.stderr, /dsh field: package\.json has no "dsh" field/u);
  assert.equal(result.stdout, '');
});

test('doctor --remote still exits 0 for a clean manifest', (t) => {
  const result = runDoctor(t, {});

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok {2}demo-plugin@1\.2\.3 \(host >=0\.2\.0\) at demo\/plugin/u);
  assert.equal(result.stderr, '');
});
