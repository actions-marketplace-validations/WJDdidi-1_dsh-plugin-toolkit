/**
 * `fix --host` aims the written range at the DSH that rejected the install.
 * The range has to include the host and stop before the next major; the plan
 * says that in words so the author does not have to reverse-engineer the diff.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../lib/cli.mjs';
import { satisfiesRange } from '../lib/compat.mjs';
import { fixEngines } from '../lib/fix.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-fix-host-'));

function plugin(engines) {
  const dir = path.join(scratch(), 'plugin');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    name: 'fix-me',
    version: '1.0.0',
    engines,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    files: ['index.js', 'README.md'],
  };
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

const manifestOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

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

test('--host writes a range that accepts the host and rejects the next major', () => {
  const dir = plugin({ node: '>=18' });

  const result = fixEngines({ dir, host: '0.3.0', write: true });

  assert.equal(result.ok, true);
  assert.equal(result.written, true);
  assert.match(result.why, /host 0\.3\.0/u);
  assert.match(result.why, /1\.0\.0/u);

  const written = manifestOf(dir).engines.dsh;
  assert.equal(satisfiesRange(written, '0.3.0'), true, `host is not accepted by ${written}`);
  assert.equal(satisfiesRange(written, '1.0.0'), false, `next major is accepted by ${written}`);
  assert.equal(satisfiesRange(written, '0.2.9'), false, `older minor is accepted by ${written}`);
  assert.equal(manifestOf(dir).engines.node, '>=18', 'the node engine is not the fixer’s to remove');
});

test('--host replaces a valid range that excludes the host, without a second flag', () => {
  const dir = plugin({ dsh: '>=0.5.0' });

  const result = fixEngines({ dir, host: '0.3.0', write: true });

  assert.equal(result.written, true);
  assert.equal(satisfiesRange(manifestOf(dir).engines.dsh, '0.3.0'), true);
  assert.equal(satisfiesRange(manifestOf(dir).engines.dsh, '1.0.0'), false);
});

test('the CLI prints the host, the range and why before writing it', async () => {
  const dir = plugin({ node: '>=18' });
  const io = recorder();

  const code = await run(['fix', dir, '--engines', '--host', '0.3.0', '--write'], io);

  assert.equal(code, 0);
  const output = io.lines.join('\n');
  assert.match(output, /wrote engines\.dsh/u);
  assert.match(output, />=0\.3\.0 <1\.0\.0/u);
  assert.match(output, /host 0\.3\.0 is inside/u);
  assert.match(output, /1\.0\.0 is excluded/u);

  const written = manifestOf(dir).engines.dsh;
  assert.equal(satisfiesRange(written, '0.3.0'), true);
  assert.equal(satisfiesRange(written, '1.0.0'), false);
});

test('fix --remote --engines --host plans the host range and prints why', async () => {
  const raw = `${JSON.stringify({ name: 'demo-plugin', version: '1.2.3', engines: { node: '>=18' } }, null, 2)}\n`;
  const io = recorder();

  const code = await run(['fix', 'demo/plugin', '--remote', '--engines', '--host', '0.3.0'], io, {
    fetchImpl: github(raw),
  });

  assert.equal(code, 0);
  const output = io.lines.join('\n');
  assert.match(output, /would write engines\.dsh ">=0\.3\.0 <1\.0\.0"/u);
  assert.match(output, /^\+ {4}"dsh": ">=0\.3\.0 <1\.0\.0"$/mu);
  assert.match(output, /host 0\.3\.0 is inside/u);
  assert.match(output, /1\.0\.0 is excluded/u);
});

test('an invalid --host is refused instead of writing a guessed range', async () => {
  const dir = plugin({ node: '>=18' });
  const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  const io = recorder();

  const code = await run(['fix', dir, '--engines', '--host', 'not-a-version'], io);

  assert.equal(code, 1);
  assert.match(io.lines.join('\n'), /not a semver host version/u);
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), before);
});
