/**
 * `fix --remote` is the repair plan for a repository nobody has cloned: read
 * package.json over the GitHub API, print the engines.dsh edit as a unified
 * diff, and stop there. The tests use a fetch that serves the manifest from
 * memory, so the network is never involved.
 */
import assert from 'node:assert/strict';
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
    const path = url.replace('https://api.github.com/repos/demo/plugin/contents/', '').split('?')[0];
    if (path !== 'package.json') return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
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

test('a missing range prints a unified diff and exits 0 without writing anything', async () => {
  const raw = `${JSON.stringify(manifest({ node: '>=18' }), null, 2)}\n`;
  const { fetchImpl, calls } = github(raw);
  const io = recorder();

  const code = await run(['fix', 'demo/plugin', '--remote'], io, { fetchImpl });

  assert.equal(code, 0);
  const output = text(io);
  assert.match(output, /^--- a\/package\.json$/mu);
  assert.match(output, /^\+\+\+ b\/package\.json$/mu);
  assert.match(output, /^@@ -\d+,\d+ \+\d+,\d+ @@$/mu);
  assert.match(output, /^\+ {4}"dsh": ">=0\.2\.0"$/mu);
  assert.match(output, /would write engines\.dsh/u);
  assert.match(output, /nothing written/u);

  // The remote is read-only: one GET for package.json, no PUT or PATCH.
  assert.deepEqual(
    calls.map((call) => call.method),
    ['GET'],
  );
  assert.match(calls[0].url, /\/contents\/package\.json$/u);
});

test('an existing valid range prints no diff, says nothing to apply, and exits 1', async () => {
  const raw = `${JSON.stringify(manifest({ dsh: '>=0.3.0' }), null, 2)}\n`;
  const { fetchImpl, calls } = github(raw);
  const io = recorder();

  const code = await run(['fix', 'demo/plugin', '--remote'], io, { fetchImpl });

  assert.equal(code, 1);
  const output = text(io);
  assert.match(output, /nothing to apply/u);
  assert.doesNotMatch(output, /^--- a\//mu);
  assert.doesNotMatch(output, /^\+\+\+ b\//mu);
  assert.doesNotMatch(output, /^@@/mu);
  assert.equal(calls.length, 1);
});

test('an unreachable repository exits 2 with the network error and no diff', async () => {
  const io = recorder();
  const fetchImpl = async () => {
    throw new Error('connect ECONNREFUSED 140.82.112.5:443');
  };

  const code = await run(['fix', 'demo/plugin', '--remote'], io, { fetchImpl });

  assert.equal(code, 2);
  const output = text(io);
  assert.match(output, /cannot reach GitHub for package\.json/u);
  assert.match(output, /ECONNREFUSED/u);
  assert.doesNotMatch(output, /^--- a\//mu);
});

test('a pinned range is replaced in the printed diff', async () => {
  const raw = `${JSON.stringify(manifest({ dsh: '0.2.0' }), null, 2)}\n`;
  const { fetchImpl } = github(raw);
  const io = recorder();

  const code = await run(['fix', 'demo/plugin', '--remote'], io, { fetchImpl });

  assert.equal(code, 0);
  const output = text(io);
  assert.match(output, /^- {4}"dsh": "0\.2\.0"$/mu);
  assert.match(output, /^\+ {4}"dsh": ">=0\.2\.0"$/mu);
  assert.match(output, /was "0\.2\.0"/u);
});

test('--remote before the target and an explicit --range both work', async () => {
  const raw = `${JSON.stringify(manifest({ dsh: '>=0.3.0' }), null, 2)}\n`;
  const { fetchImpl } = github(raw);
  const io = recorder();

  const code = await run(
    ['fix', '--remote', 'demo/plugin', '--range', '>=0.4.0'],
    io,
    { fetchImpl },
  );

  assert.equal(code, 0);
  const output = text(io);
  assert.match(output, /^- {4}"dsh": ">=0\.3\.0"$/mu);
  assert.match(output, /^\+ {4}"dsh": ">=0\.4\.0"$/mu);
  assert.match(output, /was ">=0\.3\.0"/u);
});

test('--write is refused for a remote target', async () => {
  const raw = `${JSON.stringify(manifest({ node: '>=18' }), null, 2)}\n`;
  const { fetchImpl, calls } = github(raw);
  const io = recorder();

  const code = await run(['fix', 'demo/plugin', '--remote', '--write'], io, { fetchImpl });

  assert.equal(code, 2);
  assert.match(text(io), /remote repositories are read-only/u);
  assert.equal(calls.length, 0, 'a refused write never even reads the repository');
});
