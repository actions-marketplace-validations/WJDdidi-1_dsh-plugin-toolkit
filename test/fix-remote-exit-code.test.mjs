/**
 * `fix <owner>/<repo> --remote` has to keep the documented exit-code contract
 * at the process boundary, not only in the `run()` helper: a missing range
 * prints a repair and exits 0, while a manifest that already declares a valid
 * range prints nothing to apply and exits 1.
 *
 * The child process gets a `--require` shim that replaces global fetch with a
 * package.json served from an environment variable, so the real bin runs and
 * the assertion is on the status code the shell would see.
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

function manifest(engines) {
  return {
    name: 'demo-plugin',
    version: '1.2.3',
    engines,
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
    files: ['index.js', 'cordis.patch.yml', 'README.md'],
  };
}

function preload(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fix-remote-exit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'github-fetch.cjs');
  fs.writeFileSync(
    file,
    `const raw = Buffer.from(process.env.DSH_FIX_REMOTE_MANIFEST ?? '', 'base64').toString('utf8');
globalThis.fetch = async (url) => {
  const pathname = new URL(String(url)).pathname;
  if (pathname.endsWith('/contents/package.json') !== true) {
    return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ encoding: 'base64', content: Buffer.from(raw, 'utf8').toString('base64') }),
  };
};
`,
  );
  return file;
}

function runFix(t, engines) {
  const raw = `${JSON.stringify(manifest(engines), null, 2)}\n`;
  const result = spawnSync(
    process.execPath,
    ['--require', preload(t), CLI, 'fix', 'demo/plugin', '--remote'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_FIX_REMOTE_MANIFEST: Buffer.from(raw, 'utf8').toString('base64'),
      },
    },
  );
  return result;
}

test('the CLI exits 0 for a remote manifest that is missing engines.dsh', (t) => {
  const result = runFix(t, { node: '>=18' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^--- a\/package\.json$/mu);
  assert.match(result.stdout, /^\+ {4}"dsh": ">=0\.2\.0"$/mu);
  assert.match(result.stdout, /would write engines\.dsh/u);
  assert.equal(result.stderr, '');
});

test('the CLI exits 1 for a remote manifest that already declares engines.dsh', (t) => {
  const result = runFix(t, { dsh: '>=0.2.0' });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /ok {2}engines\.dsh is already ">=0\.2\.0"; nothing to apply/u);
  assert.doesNotMatch(result.stdout, /^--- a\//mu);
  assert.doesNotMatch(result.stdout, /^@@/mu);
  assert.equal(result.stderr, '');
});
