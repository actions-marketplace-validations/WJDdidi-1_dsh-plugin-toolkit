/**
 * `fix --remote --patch` turns the printed repair into a file the author can
 * apply without cloning. The diff has to be byte-for-byte the one the command
 * would print, parent directories have to appear, and an existing file is
 * never replaced without --force.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../lib/cli.mjs';

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function manifest(engines) {
  return {
    name: 'demo-plugin',
    version: '1.2.3',
    engines,
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
    files: ['index.js', 'cordis.patch.yml', 'README.md'],
  };
}

/** Serve package.json from memory and record every request method and URL. */
function github(value) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' });
    const file = url.replace('https://api.github.com/repos/demo/plugin/contents/', '').split('?')[0];
    if (file !== 'package.json') return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: encode(value) }) };
  };
  return { fetchImpl, calls };
}

function recorder() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

const text = (io) => io.lines.join('\n');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fix-remote-patch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function assertPatch(written) {
  assert.match(written, /^--- a\/package\.json$/mu);
  assert.match(written, /^\+\+\+ b\/package\.json$/mu);
  assert.match(written, /^@@ -\d+,\d+ \+\d+,\d+ @@$/mu);
  assert.match(written, /^- {4}"node": ">=18"$/mu);
  assert.match(written, /^\+ {4}"node": ">=18",$/mu);
  assert.match(written, /^\+ {4}"dsh": ">=0\.2\.0"$/mu);
}

test('--patch writes the same diff, creates parent directories, and prints the path', async (t) => {
  const raw = `${JSON.stringify(manifest({ node: '>=18' }), null, 2)}\n`;
  const { fetchImpl, calls } = github(raw);
  const io = recorder();
  const file = path.join(workspace(t), 'nested', 'reports', 'repair.patch');

  const code = await run(['fix', 'demo/plugin', '--remote', '--patch', file], io, { fetchImpl });

  assert.equal(code, 0);
  assert.ok(fs.existsSync(file), 'the patch file was not created');
  assertPatch(fs.readFileSync(file, 'utf8'));
  const output = text(io);
  assert.ok(output.includes(file), `output does not print the patch path: ${output}`);
  assert.match(output, /wrote the diff/u);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['GET'],
  );
});

test('an existing patch file is refused unless --force is passed', async (t) => {
  const raw = `${JSON.stringify(manifest({ node: '>=18' }), null, 2)}\n`;
  const { fetchImpl, calls } = github(raw);
  const io = recorder();
  const file = path.join(workspace(t), 'repair.patch');
  fs.writeFileSync(file, 'sentinel\n');

  const code = await run(['fix', 'demo/plugin', '--remote', '--patch', file], io, { fetchImpl });

  assert.equal(code, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), 'sentinel\n');
  const output = text(io);
  assert.match(output, /already exists/u);
  assert.match(output, /--force/u);
  assert.ok(output.includes(file), `output does not print the patch path: ${output}`);
  assert.equal(calls.length, 0, 'a refused patch never even reads the repository');
});

test('--force replaces an existing patch file', async (t) => {
  const raw = `${JSON.stringify(manifest({ node: '>=18' }), null, 2)}\n`;
  const { fetchImpl, calls } = github(raw);
  const io = recorder();
  const file = path.join(workspace(t), 'repair.patch');
  fs.writeFileSync(file, 'sentinel\n');

  const code = await run(['fix', 'demo/plugin', '--remote', '--patch', file, '--force'], io, { fetchImpl });

  assert.equal(code, 0);
  assertPatch(fs.readFileSync(file, 'utf8'));
  assert.match(text(io), /wrote the diff/u);
  assert.equal(calls.length, 1);
});

test('a repository that needs no repair leaves no patch file behind and exits 1', async (t) => {
  const raw = `${JSON.stringify(manifest({ dsh: '>=0.3.0' }), null, 2)}\n`;
  const { fetchImpl } = github(raw);
  const io = recorder();
  const file = path.join(workspace(t), 'repair.patch');

  const code = await run(['fix', 'demo/plugin', '--remote', '--patch', file], io, { fetchImpl });

  assert.equal(code, 1);
  assert.match(text(io), /nothing to apply/u);
  assert.equal(fs.existsSync(file), false);
});
