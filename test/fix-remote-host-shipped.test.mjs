/**
 * The host-aimed remote repair has to work in the file npm ships, not only in
 * the `run()` helper the other tests call. This spawns `bin/dsh-plugin.mjs`
 * with a fetch shim, saves the planned patch, applies it to a checkout with
 * `git apply`, and asserts the written range — the milestone's acceptance
 * line: the host version is accepted and one major above it is not.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { satisfiesRange } from '../lib/compat.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'dsh-plugin.mjs');

function manifest() {
  return {
    name: 'demo-plugin',
    version: '1.2.3',
    engines: { node: '>=18' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    files: ['index.js', 'README.md'],
  };
}

function preload(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fix-remote-host-shipped-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'github-fetch.cjs');
  fs.writeFileSync(
    file,
    `const raw = Buffer.from(process.env.DSH_HOST_REMOTE_MANIFEST ?? '', 'base64').toString('utf8');
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
  const checkout = path.join(dir, 'checkout');
  fs.mkdirSync(checkout, { recursive: true });
  fs.writeFileSync(path.join(checkout, 'package.json'), `${JSON.stringify(manifest(), null, 2)}\n`);
  return { file, dir, checkout };
}

test('the shipped CLI plans, saves and applies the host-aimed range', (t) => {
  const { file, dir, checkout } = preload(t);
  const patch = path.join(dir, 'repair.patch');
  const raw = `${JSON.stringify(manifest(), null, 2)}\n`;

  const result = spawnSync(
    process.execPath,
    [
      '--require',
      file,
      CLI,
      'fix',
      'demo/plugin',
      '--remote',
      '--engines',
      '--host',
      '0.3.0',
      '--patch',
      patch,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_HOST_REMOTE_MANIFEST: Buffer.from(raw, 'utf8').toString('base64'),
      },
    },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /would write engines\.dsh ">=0\.3\.0 <1\.0\.0"/u);
  assert.match(result.stdout, /host 0\.3\.0 is inside/u);
  assert.match(result.stdout, /1\.0\.0 is excluded/u);
  assert.match(result.stdout, /wrote the diff to/u);
  assert.ok(fs.existsSync(patch), 'the shipped CLI did not write the planned patch');

  const checked = spawnSync('git', ['apply', '--check', patch], { cwd: checkout, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  const applied = spawnSync('git', ['apply', patch], { cwd: checkout, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);

  const written = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json'), 'utf8')).engines;
  assert.equal(written.dsh, '>=0.3.0 <1.0.0');
  assert.equal(written.node, '>=18', 'the node engine is not the fixer’s to remove');
  assert.equal(satisfiesRange(written.dsh, '0.3.0'), true, `the host is not accepted by ${written.dsh}`);
  assert.equal(satisfiesRange(written.dsh, '1.0.0'), false, `the next major is accepted by ${written.dsh}`);
});
