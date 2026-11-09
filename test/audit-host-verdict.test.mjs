/**
 * The CLI has two ways to say the same host verdict: the first word of the
 * printed line and the `compatibility` field of the `--json` row. Both are
 * derived from the range parser, so a major-only range must produce the same
 * answer in both places:
 *
 *   >1  + 1.2.3  -> incompatible (exit 1)
 *   <=1 + 1.2.3  -> compatible   (exit 0)
 *
 * The parser tests already pin the boundary arithmetic. This file pins the
 * command a user runs, including the printed verdict that the compatibility
 * reports quote, so a formatter change cannot quietly turn an incompatible
 * range back into `clean`.
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

async function audit(target, host, json) {
  const io = recorder();
  const args = ['audit', '--remote', target, '--host', host];
  if (json === true) args.push('--json');
  const code = await run(args, io, { fetchImpl: github() });
  const output = io.lines.join('\n');
  return { code, output, row: json === true ? JSON.parse(output)[0] : null };
}

test('>1 prints incompatible for 1.2.3 and exits 1, and the JSON row agrees', async () => {
  const printed = await audit('demo/above-major', '1.2.3', false);
  assert.equal(printed.code, 1);
  assert.match(printed.output, /^incompatible\s+demo\/above-major\b/mu);
  assert.match(printed.output, /\[incompatible with dsh 1\.2\.3; declares ">1"\]/u);

  const machine = await audit('demo/above-major', '1.2.3', true);
  assert.equal(machine.code, 1);
  assert.equal(machine.row.hostRange, '>1');
  assert.equal(machine.row.host, '1.2.3');
  assert.equal(machine.row.compatibility, 'incompatible');
});

test('<=1 prints compatible for 1.2.3 and exits 0, and the JSON row agrees', async () => {
  const printed = await audit('demo/upto-major', '1.2.3', false);
  assert.equal(printed.code, 0);
  assert.match(printed.output, /^clean\s+demo\/upto-major\b/mu);
  assert.match(printed.output, /\[compatible with dsh 1\.2\.3; declares "<=1"\]/u);

  const machine = await audit('demo/upto-major', '1.2.3', true);
  assert.equal(machine.code, 0);
  assert.equal(machine.row.hostRange, '<=1');
  assert.equal(machine.row.host, '1.2.3');
  assert.equal(machine.row.compatibility, 'compatible');
});

test('the printed verdict follows the parser at the next-major boundary', async () => {
  const above = await audit('demo/above-major', '2.0.0', false);
  assert.equal(above.code, 0);
  assert.match(above.output, /\[compatible with dsh 2\.0\.0; declares ">1"\]/u);

  const upto = await audit('demo/upto-major', '2.0.0', false);
  assert.equal(upto.code, 1);
  assert.match(upto.output, /^incompatible\s+demo\/upto-major\b/mu);
  assert.match(upto.output, /\[incompatible with dsh 2\.0\.0; declares "<=1"\]/u);
});
