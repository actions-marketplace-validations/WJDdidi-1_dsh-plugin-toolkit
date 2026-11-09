/**
 * The four-case acceptance probe for major-only comparators, through the real
 * CLI path that users run: `audit --remote <owner/repo> --host <version>`.
 *
 * npm reads a missing component as a boundary, not as zero: `>1` starts at
 * 2.0.0 (so it rejects 1.2.3), while `<=1` covers all of 1.x (so it accepts
 * 1.2.3). The unit tests pin the parser; this file pins the command that a
 * reader actually types, including the exit code.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { run } from '../lib/cli.mjs';

function manifest(range) {
  return {
    name: 'demo-plugin',
    version: '1.2.3',
    main: 'index.js',
    engines: { node: '>=18', dsh: range },
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
    files: ['index.js', 'cordis.patch.yml', 'README.md'],
  };
}

function files(range) {
  return {
    'package.json': JSON.stringify(manifest(range)),
    'index.js': 'export function apply() {}\n',
    'cordis.patch.yml': '- insert: []\n',
    'README.md': `# demo\n\n## Requirements\n\nRequires dsh ${range}.\n`,
  };
}

const REPOSITORIES = {
  'demo/above-major': files('>1'),
  'demo/upto-major': files('<=1'),
};

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function github() {
  return async (url) => {
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)/u.exec(url);
    if (match === null) return { ok: false, status: 404, json: async () => ({}) };
    const [, owner, repo, file] = match;
    const entry = REPOSITORIES[`${owner}/${repo}`];
    if (entry === undefined || Object.prototype.hasOwnProperty.call(entry, file) === false) {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: encode(entry[file]) }) };
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

async function finding(target, host) {
  const io = recorder();
  const code = await run(['audit', '--remote', target, '--host', host, '--json'], io, { fetchImpl: github() });
  return { code, row: JSON.parse(io.lines.join('\n'))[0] };
}

test('>1 rejects 1.2.3 and accepts 2.0.0 through the CLI', async () => {
  const rejected = await finding('demo/above-major', '1.2.3');
  assert.equal(rejected.code, 1);
  assert.equal(rejected.row.hostRange, '>1');
  assert.equal(rejected.row.compatibility, 'incompatible');

  const accepted = await finding('demo/above-major', '2.0.0');
  assert.equal(accepted.code, 0);
  assert.equal(accepted.row.compatibility, 'compatible');
});

test('<=1 accepts 1.2.3 and rejects 2.0.0 through the CLI', async () => {
  const accepted = await finding('demo/upto-major', '1.2.3');
  assert.equal(accepted.code, 0);
  assert.equal(accepted.row.hostRange, '<=1');
  assert.equal(accepted.row.compatibility, 'compatible');

  const rejected = await finding('demo/upto-major', '2.0.0');
  assert.equal(rejected.code, 1);
  assert.equal(rejected.row.compatibility, 'incompatible');
});
