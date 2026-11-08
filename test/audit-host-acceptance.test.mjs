/**
 * The acceptance experiment for `audit --remote --from --host 0.2.2`.
 *
 * Three repositories are audited three times, producing nine JSON findings.
 * Every finding must carry the host it was compared against and the semver
 * answer for its declared range: `>=0.2.0` and `>=0.2.0 <0.3.0` accept 0.2.2,
 * while `>=99.0.0` excludes it and therefore fails the batch with exit 1.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../lib/cli.mjs';

const HOST = '0.2.2';
const RANGES = {
  ok: '>=0.2.0',
  tooNew: '>=99.0.0',
  narrow: '>=0.2.0 <0.3.0',
};
const EXPECTED = {
  ok: 'compatible',
  tooNew: 'incompatible',
  narrow: 'compatible',
};

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function files(range) {
  return {
    'package.json': JSON.stringify({
      name: `compat-${range}`,
      version: '1.0.0',
      license: 'MIT',
      type: 'module',
      engines: { node: '>=18', dsh: range },
      main: 'index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      files: ['index.js', 'cordis.patch.yml', 'README.md'],
    }),
    'README.md': `# compat\n\n## Requirements\n\n| DSH | ${range} |\n`,
    'cordis.patch.yml': '- insert: []\n',
    'index.js': 'export function apply() {}\n',
  };
}

const REPOSITORIES = Object.fromEntries(
  Object.entries(RANGES).map(([name, range]) => [`acme/${name}`, files(range)]),
);

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

function listFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-compat-acceptance-'));
  const file = path.join(dir, 'repos.txt');
  fs.writeFileSync(file, contents);
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the acceptance experiment prints compat=9/9 with host and compatibility on every finding', async (t) => {
  const list = listFile('acme/ok\nacme/tooNew\nacme/narrow\n');
  t.after(list.cleanup);

  const codes = [];
  const rows = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const io = recorder();
    codes.push(
      await run(['audit', '--remote', '--from', list.file, '--json', '--host', HOST], io, {
        fetchImpl: github(),
      }),
    );
    rows.push(...JSON.parse(io.lines.join('\n')));
  }

  assert.deepEqual(codes, [1, 1, 1], 'a range that excludes the host must fail every run');
  assert.equal(rows.length, 9, 'three runs of three repositories should produce nine findings');
  for (const row of rows) {
    assert.equal(row.host, HOST, `${row.target} did not carry the host it was compared against`);
    const expected = EXPECTED[String(row.target).split('/').pop()];
    assert.equal(row.compatibility, expected, `${row.target} got the wrong compatibility verdict`);
  }
  const matching = rows.filter((row) => row.compatibility === EXPECTED[String(row.target).split('/').pop()]);
  assert.equal(matching.length, 9, 'every finding must match its declared range, so the experiment prints compat=9/9');
});
