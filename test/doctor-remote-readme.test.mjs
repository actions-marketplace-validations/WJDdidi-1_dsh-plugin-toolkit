/**
 * `doctor --remote` has to ask the same README questions as a local `doctor`:
 * a repository whose README has no `Requirements` heading used to print `ok`
 * and exit `0`, even though the same checkout failed the `readme` check. It
 * also has to catch a Requirements section that omits the host range the
 * manifest declares.
 *
 * The real bin runs with a `--require` shim that replaces global fetch with a
 * tiny mock of the GitHub contents API, so the assertions are on the exit code
 * and output a shell would see rather than on `auditRemote()`'s return value.
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
  'package.json': JSON.stringify(manifest()),
  'index.js': 'export function apply() {}\n',
  'cordis.patch.yml': '- insert: []\n',
};

function preload(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-remote-readme-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'github-fetch.cjs');
  fs.writeFileSync(
    file,
    `const files = JSON.parse(Buffer.from(process.env.DSH_DOCTOR_REMOTE_FILES ?? '', 'base64').toString('utf8'));
const prefix = '/repos/acme/probe/contents/';
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

function runDoctor(t, files) {
  return spawnSync(process.execPath, ['--require', preload(t), CLI, 'doctor', '--remote', 'acme/probe'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_DOCTOR_REMOTE_FILES: Buffer.from(JSON.stringify({ ...support, ...files }), 'utf8').toString('base64'),
    },
  });
}

test('doctor --remote reports a README with no Requirements heading and exits 1', (t) => {
  const result = runDoctor(t, {
    'README.md': '# probe\n\nRequires dsh >=0.2.0.\n',
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /1 problem\(s\) in acme\/probe/u);
  assert.match(
    result.stderr,
    /readme: README\.md has no Requirements section, so users cannot tell which host it needs/u,
  );
  assert.equal(result.stdout, '');
});

test('doctor --remote reports a Requirements section that omits the declared range', (t) => {
  const result = runDoctor(t, {
    'README.md': '# probe\n\n## Requirements\n\n- DeepSeek Harness `>=0.3.0`\n',
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /readme: README\.md does not mention the host range ">=0\.2\.0"/u);
});

test('doctor --remote still exits 0 when the README states the declared range', (t) => {
  const result = runDoctor(t, {
    'README.md': '# probe\n\n## Requirements\n\n- DeepSeek Harness `>=0.2.0`\n',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok {2}demo-plugin@1\.2\.3 \(host >=0\.2\.0\) at acme\/probe/u);
  assert.equal(result.stderr, '');
});
