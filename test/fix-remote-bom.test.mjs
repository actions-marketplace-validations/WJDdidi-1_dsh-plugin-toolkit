/**
 * A `package.json` saved with a UTF-8 BOM is the same manifest to npm, so the
 * remote reader has to strip it exactly like the local reader does. Before
 * this, `fix --remote --engines --host` refused the manifest the local fixer
 * would have repaired, and `audit --remote` reported it as invalid JSON.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../lib/cli.mjs';
import { satisfiesRange } from '../lib/compat.mjs';
import { auditRemote } from '../lib/remote.mjs';

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function github(raw) {
  return async (url) => {
    if (url.includes('/contents/package.json') === false) {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: encode(raw) }) };
  };
}

function recorder() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-fix-remote-bom-'));

test('a BOM manifest still plans the host range, and the applied patch accepts the host', async (t) => {
  const raw = `\uFEFF${JSON.stringify(
    {
      name: 'demo-plugin',
      version: '1.2.3',
      engines: { node: '>=18' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      files: ['index.js', 'README.md'],
    },
    null,
    2,
  )}\n`;
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(checkout, { recursive: true });
  const manifestPath = path.join(checkout, 'package.json');
  fs.writeFileSync(manifestPath, raw);
  const patchFile = path.join(root, 'repair.patch');
  const io = recorder();

  const code = await run(
    ['fix', 'demo/plugin', '--remote', '--engines', '--host', '0.3.0', '--patch', patchFile],
    io,
    { fetchImpl: github(raw) },
  );

  assert.equal(code, 0, io.lines.join('\n'));
  const output = io.lines.join('\n');
  assert.match(output, /would write engines\.dsh ">=0\.3\.0 <1\.0\.0"/u);
  assert.match(output, /host 0\.3\.0 is inside/u);
  assert.match(output, /1\.0\.0 is excluded/u);

  execFileSync('git', ['apply', patchFile], { cwd: checkout, stdio: 'pipe' });
  const written = fs.readFileSync(manifestPath, 'utf8');
  assert.notEqual(written.charCodeAt(0), 0xfeff, 'the patch put the BOM back');
  const manifest = JSON.parse(written);
  assert.equal(manifest.engines.dsh, '>=0.3.0 <1.0.0');
  assert.equal(manifest.engines.node, '>=18', 'the node engine is not the fixer’s to remove');
  assert.equal(satisfiesRange(manifest.engines.dsh, '0.3.0'), true, 'the host is not accepted');
  assert.equal(satisfiesRange(manifest.engines.dsh, '1.0.0'), false, 'the next major is accepted');
});

test('audit --remote reads a BOM manifest instead of calling it invalid JSON', async () => {
  const raw = `\uFEFF${JSON.stringify(
    {
      name: 'demo-plugin',
      version: '1.2.3',
      engines: { dsh: '>=0.2.0' },
    },
    null,
    2,
  )}\n`;

  const report = await auditRemote('demo/plugin', { fetchImpl: github(raw) });

  assert.equal(report.manifest?.name, 'demo-plugin');
  assert.equal(report.manifest?.engines?.dsh, '>=0.2.0');
  assert.equal(
    report.failures.some((failure) => failure.check === 'manifest'),
    false,
    `a BOM manifest was reported as unreadable: ${JSON.stringify(report.failures)}`,
  );
});
