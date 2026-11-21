/**
 * Partial ranges and the suffix npm accepts after them.
 *
 * npm reads a pre-release or build suffix only when the third version
 * component is present. `1.2+build` is therefore not a range, and the audit
 * must answer `unknown` instead of confidently accepting a host; `1.2.x+build`
 * is a range and ignores the suffix. A wildcard also makes every later
 * component wildcard (`1.x.3` is the whole 1.x line), which npm accepts and the
 * audit used to call `unknown`.
 *
 * The unit assertions pin the parser; the CLI cases pin the line a reader
 * actually sees, including the range quoted back for a malformed value.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { run } from '../lib/cli.mjs';
import { hostCompatibility } from '../lib/compat.mjs';

const REPOSITORIES = {
  'demo/build-on-partial': '>=0.2+build',
  'demo/wildcard-build': '1.2.x+build',
  'demo/wildcard-middle': '1.x.3',
  'demo/wildcard-head': 'x.2.3',
};

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function files(range) {
  return {
    'package.json': JSON.stringify({
      name: `partial-${range.replace(/[^a-z0-9]+/giu, '-')}`,
      version: '1.0.0',
      license: 'MIT',
      type: 'module',
      engines: { node: '>=18', dsh: range },
      main: 'index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      files: ['index.js', 'cordis.patch.yml', 'README.md'],
    }),
    'README.md': `# partial\n\n## Requirements\n\n| DSH | ${range} |\n`,
    'cordis.patch.yml': '- insert: []\n',
    'index.js': 'export function apply() {}\n',
  };
}

function github() {
  return async (url) => {
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)/u.exec(url);
    if (match === null) return { ok: false, status: 404, json: async () => ({}) };
    const [, owner, repo, file] = match;
    const entry = REPOSITORIES[`${owner}/${repo}`];
    if (entry === undefined) return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    const source = files(entry);
    if (Object.prototype.hasOwnProperty.call(source, file) === false) {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: encode(source[file]) }) };
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

async function audit(target, host) {
  const io = recorder();
  const code = await run(['audit', '--remote', target, '--host', host], io, { fetchImpl: github() });
  return { code, output: io.lines.join('\n') };
}

test('build metadata on a partial version is malformed, not a compatible range', async () => {
  const { code, output } = await audit('demo/build-on-partial', '0.2.5');

  assert.equal(code, 1);
  assert.match(output, /\[unknown with dsh 0\.2\.5; declares ">=0\.2\+build"\]/u);
  assert.equal(hostCompatibility('>=0.2+build', '0.2.5'), 'unknown');
  assert.equal(hostCompatibility('1.2+build', '1.2.5'), 'unknown');
});

test('a build suffix after a wildcard patch is valid and does not change the range', async () => {
  const { code, output } = await audit('demo/wildcard-build', '1.2.5');

  assert.equal(code, 0);
  assert.match(output, /\[compatible with dsh 1\.2\.5; declares "1\.2\.x\+build"\]/u);
  assert.equal(hostCompatibility('1.2.x+build', '1.2.5'), 'compatible');
  assert.equal(hostCompatibility('1.2.x+build', '1.3.0'), 'incompatible');
});

test('a wildcard middle component is the whole major line, not an unknown range', async () => {
  const accepted = await audit('demo/wildcard-middle', '1.5.0');
  assert.equal(accepted.code, 0);
  assert.match(accepted.output, /\[compatible with dsh 1\.5\.0; declares "1\.x\.3"\]/u);

  const rejected = await audit('demo/wildcard-middle', '2.0.0');
  assert.equal(rejected.code, 1);
  assert.match(rejected.output, /\[incompatible with dsh 2\.0\.0; declares "1\.x\.3"\]/u);
});

test('a wildcard major is every stable version, as npm reads it', async () => {
  const { code, output } = await audit('demo/wildcard-head', '99.4.2');

  assert.equal(code, 0);
  assert.match(output, /\[compatible with dsh 99\.4\.2; declares "x\.2\.3"\]/u);
  assert.equal(hostCompatibility('x.2.3', '0.2.2-alpha.3'), 'incompatible');
});
