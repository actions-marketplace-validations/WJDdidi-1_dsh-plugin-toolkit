/**
 * A host verdict needs a manifest to compare against.
 *
 * When GitHub answered 500 or the batch hit its quota, the row used to carry
 * `unknown` and the printed suffix said "declares no engines.dsh range" — a
 * statement about a package.json that was never read. The host fields belong
 * only on rows whose manifest was read; unreadable and rate-limited rows keep
 * their own verdict and do not invent a range or a compatibility answer.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../lib/cli.mjs';

const HOST = '0.2.2';

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function files(range = '>=0.2.0') {
  return {
    'package.json': JSON.stringify({
      name: 'demo-plugin',
      version: '1.2.3',
      main: 'index.js',
      engines: { node: '>=18', dsh: range },
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
      files: ['index.js', 'cordis.patch.yml', 'README.md'],
    }),
    'index.js': 'export function apply() {}\n',
    'cordis.patch.yml': '- insert:\n    - id: test-plugin\n      name: test-plugin\n      config: {}\n',
    'README.md': `# demo\n\n## Requirements\n\nRequires dsh ${range}.\n`,
  };
}

const REPOSITORIES = {
  'demo/readable': files(),
  'demo/unreadable': files(),
};

function github() {
  return async (url) => {
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)/u.exec(url);
    if (match === null) return { ok: false, status: 404, json: async () => ({}) };
    const [, owner, repo, file] = match;
    const target = `${owner}/${repo}`;
    if (target === 'demo/unreadable') {
      return { ok: false, status: 500, json: async () => ({ message: 'server error' }) };
    }
    const entry = REPOSITORIES[target];
    if (entry === undefined || Object.prototype.hasOwnProperty.call(entry, file) === false) {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: encode(entry[file]) }) };
  };
}

function rateLimited() {
  return async () => ({
    ok: false,
    status: 403,
    headers: { get: (name) => (name.toLowerCase() === 'x-ratelimit-reset' ? '1780000000' : null) },
    json: async () => ({ message: 'rate limit' }),
  });
}

function recorder() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

function listFile(t, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-host-unreadable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'repos.txt');
  fs.writeFileSync(file, contents);
  return file;
}

function jsonRow(io) {
  return JSON.parse(io.lines.join('\n'))[0];
}

test('an unreadable repository does not claim it declares no range', async () => {
  const text = recorder();
  const textCode = await run(['audit', '--remote', 'demo/unreadable', '--host', HOST], text, {
    fetchImpl: github(),
  });

  assert.equal(textCode, 1);
  const output = text.lines.join('\n');
  assert.match(output, /^unreadable\s+demo\/unreadable\b/mu);
  assert.doesNotMatch(output, /unknown with dsh/u);
  assert.doesNotMatch(output, /declares no engines\.dsh range/u);

  const json = recorder();
  const jsonCode = await run(['audit', '--remote', 'demo/unreadable', '--host', HOST, '--json'], json, {
    fetchImpl: github(),
  });

  assert.equal(jsonCode, 1);
  const row = jsonRow(json);
  assert.equal(row.unreadable, true);
  assert.equal(row.hostRange, null);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'host'), false, 'an unread row carried a host');
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'compatibility'), false, 'an unread row carried a verdict');
});

test('a rate-limited batch leaves every unread row without a host verdict', async (t) => {
  const list = listFile(t, 'demo/one\ndemo/two\n');
  const text = recorder();
  const textCode = await run(['audit', '--remote', '--from', list, '--host', HOST, '--jobs', '1'], text, {
    fetchImpl: rateLimited(),
  });

  assert.equal(textCode, 1);
  const output = text.lines.join('\n');
  assert.match(output, /^rate-limited\s+demo\/one\b/mu);
  assert.match(output, /^rate-limited\s+demo\/two\b/mu);
  assert.doesNotMatch(output, /unknown with dsh/u);
  assert.doesNotMatch(output, /declares no engines\.dsh range/u);

  const json = recorder();
  await run(['audit', '--remote', '--from', list, '--host', HOST, '--jobs', '1', '--json'], json, {
    fetchImpl: rateLimited(),
  });
  const rows = JSON.parse(json.lines.join('\n'));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.rateLimited, true);
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'host'), false, `${row.target} carried a host`);
    assert.equal(
      Object.prototype.hasOwnProperty.call(row, 'compatibility'),
      false,
      `${row.target} carried a verdict`,
    );
  }
});

test('a readable manifest still carries the host and its compatibility answer', async () => {
  const io = recorder();
  const code = await run(['audit', '--remote', 'demo/readable', '--host', HOST, '--json'], io, {
    fetchImpl: github(),
  });

  assert.equal(code, 0, io.lines.join('\n'));
  const row = jsonRow(io);
  assert.equal(row.host, HOST);
  assert.equal(row.hostRange, '>=0.2.0');
  assert.equal(row.compatibility, 'compatible');
});
