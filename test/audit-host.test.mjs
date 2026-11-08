/**
 * The compatibility reports ask one question: will this package install on the
 * DSH I am running? `audit --remote --host <version>` answers it from the
 * repository's own `engines.dsh`, without cloning or installing anything.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../lib/cli.mjs';
import { hostCompatibility } from '../lib/compat.mjs';

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function manifest(range) {
  return {
    name: 'demo-plugin',
    version: '1.2.3',
    main: 'index.js',
    ...(range === undefined ? {} : { engines: { dsh: range } }),
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
    files: ['index.js', 'cordis.patch.yml', 'README.md'],
  };
}

function files(range) {
  return {
    'package.json': JSON.stringify(manifest(range)),
    'index.js': 'export function apply() {}\n',
    'cordis.patch.yml': '- insert: []\n',
    'README.md': `# demo\n\n## Requirements\n\n${range === undefined ? 'Requires dsh.' : `Requires dsh ${range}.`}\n`,
  };
}

const REPOSITORIES = {
  'demo/matches': files('>=0.2.0'),
  'demo/missing': files(undefined),
  'demo/excludes': files('>=0.5.0'),
  'demo/malformed': files('not-a-range'),
};

function github(repositories = REPOSITORIES) {
  return async (url) => {
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)/u.exec(url);
    if (match === null) return { ok: false, status: 404, json: async () => ({}) };
    const [, owner, repo, file] = match;
    const entry = repositories[`${owner}/${repo}`];
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

function listFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-compat-'));
  const file = path.join(dir, 'repos.txt');
  fs.writeFileSync(file, contents);
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a matching range prints the declared range and compatible', async () => {
  const io = recorder();
  const code = await run(['audit', '--remote', 'demo/matches', '--host', '0.3.0'], io, {
    fetchImpl: github(),
  });

  assert.equal(code, 0);
  const output = io.lines.join('\n');
  assert.match(output, />=0\.2\.0/u, 'the declared range is missing');
  assert.match(output, /\[compatible with dsh 0\.3\.0/u);
});

test('a range that excludes the host prints incompatible and exits 1', async () => {
  const io = recorder();
  const code = await run(['audit', '--remote', 'demo/excludes', '--host', '0.3.0'], io, {
    fetchImpl: github(),
  });

  assert.equal(code, 1);
  const output = io.lines.join('\n');
  assert.match(output, />=0\.5\.0/u, 'the declared range is missing');
  assert.match(output, /incompatible with dsh 0\.3\.0/u);
});

test('a missing range prints unknown rather than guessing a host', async () => {
  const io = recorder();
  const code = await run(['audit', '--remote', 'demo/missing', '--host', '0.3.0'], io, {
    fetchImpl: github(),
  });

  assert.equal(code, 1);
  const output = io.lines.join('\n');
  assert.match(output, /unknown with dsh 0\.3\.0/u);
  assert.match(output, /declares no engines\.dsh range/u);
});

test('a malformed range prints unknown and keeps the declared text visible', async () => {
  const io = recorder();
  const code = await run(['audit', '--remote', 'demo/malformed', '--host', '0.3.0'], io, {
    fetchImpl: github(),
  });

  assert.equal(code, 1);
  const output = io.lines.join('\n');
  assert.match(output, /not-a-range/u, 'the malformed value should be quoted back');
  assert.match(output, /unknown with dsh 0\.3\.0/u);
});

test('the batch mode prints the same compatibility answer for every repository', async (t) => {
  const list = listFile('demo/matches\ndemo/excludes\ndemo/missing\ndemo/malformed\n');
  t.after(list.cleanup);
  const io = recorder();
  const code = await run(['audit', '--remote', '--from', list.file, '--host', '0.3.0'], io, {
    fetchImpl: github(),
  });

  assert.equal(code, 1);
  const output = io.lines.join('\n');
  assert.match(output, /^clean\s+demo\/matches\s+.*\[compatible with dsh 0\.3\.0/mu);
  assert.match(output, /^incompatible\s+demo\/excludes\s+.*\[incompatible with dsh 0\.3\.0/mu);
  assert.match(output, /^failing\s+demo\/missing\s+.*\[unknown with dsh 0\.3\.0/mu);
  assert.match(output, /^failing\s+demo\/malformed\s+.*\[unknown with dsh 0\.3\.0/mu);
});

test('the batch JSON carries host and compatibility beside the declared range', async (t) => {
  const list = listFile('demo/matches\ndemo/excludes\ndemo/missing\ndemo/malformed\n');
  t.after(list.cleanup);
  const io = recorder();
  await run(['audit', '--remote', '--from', list.file, '--host', '0.3.0', '--json'], io, {
    fetchImpl: github(),
  });

  const reports = JSON.parse(io.lines.join('\n'));
  assert.deepEqual(
    reports.map(({ target, host, hostRange, compatibility }) => ({ target, host, hostRange, compatibility })),
    [
      { target: 'demo/matches', host: '0.3.0', hostRange: '>=0.2.0', compatibility: 'compatible' },
      { target: 'demo/excludes', host: '0.3.0', hostRange: '>=0.5.0', compatibility: 'incompatible' },
      { target: 'demo/missing', host: '0.3.0', hostRange: null, compatibility: 'unknown' },
      { target: 'demo/malformed', host: '0.3.0', hostRange: 'not-a-range', compatibility: 'unknown' },
    ],
  );
});

test('range matching follows npm semver at the edges', () => {
  assert.equal(hostCompatibility('^0.2.0', '0.2.9'), 'compatible');
  assert.equal(hostCompatibility('^0.2.0', '0.3.0'), 'incompatible');
  assert.equal(hostCompatibility('~0.2.3', '0.2.9'), 'compatible');
  assert.equal(hostCompatibility('~0.2.3', '0.3.0'), 'incompatible');
  assert.equal(hostCompatibility('0.2.x', '0.2.7'), 'compatible');
  assert.equal(hostCompatibility('0.2.x', '0.3.0'), 'incompatible');
  assert.equal(hostCompatibility('1.2.3 - 2.0.0', '2.0.0'), 'compatible');
  assert.equal(hostCompatibility('1.2.3 - 2.0.0', '2.0.1'), 'incompatible');
  assert.equal(hostCompatibility('>=0.2.0 <0.3.0', '0.2.5'), 'compatible');
  assert.equal(hostCompatibility('>=0.2.0 <0.3.0', '0.3.0'), 'incompatible');
  // npm excludes pre-releases unless the range names one; the canary reports
  // are exactly this case.
  assert.equal(hostCompatibility('>=0.2.0', '0.2.2-alpha.3'), 'incompatible');
  assert.equal(hostCompatibility('>=0.2.2-alpha.3', '0.2.2-alpha.4'), 'compatible');
  assert.equal(hostCompatibility('>= 0.2.0', '0.2.1'), 'compatible');
  assert.equal(hostCompatibility('not a range', '0.2.1'), 'unknown');
  assert.equal(hostCompatibility(null, '0.2.1'), 'unknown');
});
