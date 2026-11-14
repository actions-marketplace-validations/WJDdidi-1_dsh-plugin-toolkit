/**
 * `audit --remote --host` needs a complete DSH version to compare against.
 *
 * A typo used to reach the compatibility parser, which answered `unknown` for
 * every range. An otherwise clean repository then exited 0 with a report that
 * looked successful but never answered the question the flag asked. The CLI
 * rejects the value before it reads a list file or contacts GitHub, exactly
 * like `fix --remote --host` refuses to aim a range at a version it cannot
 * parse. A leading `v` is still a version, so the control reaches the answer.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const INVALID = ['banana', '0.2', '>=0.2.0', 'latest'];

function recorder() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

/** A fetch that fails the test if the command reads GitHub before validating. */
function noRequest() {
  return async (url) => {
    throw new Error(`the command read ${url} before rejecting the --host value`);
  };
}

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** The same repository answers the control, so a rejected value is the only difference. */
function github() {
  return async (url) => {
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)/u.exec(url);
    if (match === null) return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    const files = {
      'package.json': JSON.stringify({
        name: 'demo-plugin',
        version: '1.2.3',
        main: 'index.js',
        engines: { dsh: '>=0.2.0' },
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
        files: ['index.js', 'cordis.patch.yml', 'README.md'],
      }),
      'index.js': 'export function apply() {}\n',
      'cordis.patch.yml': '- insert: []\n',
      'README.md': '# demo\n\n## Requirements\n\nRequires dsh >=0.2.0.\n',
    };
    const file = match[3];
    if (Object.prototype.hasOwnProperty.call(files, file) === false) {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ encoding: 'base64', content: encode(files[file]) }),
    };
  };
}

test('a remote audit rejects a value that is not a complete DSH version before reading anything', async () => {
  for (const value of INVALID) {
    const io = recorder();
    const code = await run(['audit', '--remote', 'demo/plugin', '--host', value], io, {
      fetchImpl: noRequest(),
    });
    const output = io.lines.join('\n');

    assert.equal(code, 2, `${value}\n${output}`);
    assert.match(output, /--host needs a complete DSH version such as 0\.2\.2/u, value);
    assert.doesNotMatch(output, /unknown|clean|incompatible|unreadable|cannot read/u, `${value} audited anyway`);
  }
});

test('the batch mode validates the host before it reads the list file', async () => {
  const io = recorder();
  const code = await run(['audit', '--remote', '--from', '/does/not/exist', '--host', 'banana'], io, {
    fetchImpl: noRequest(),
  });
  const output = io.lines.join('\n');

  assert.equal(code, 2, output);
  assert.match(output, /--host needs a complete DSH version such as 0\.2\.2/u);
  assert.doesNotMatch(output, /cannot read|ENOENT|unknown/u, 'the list was read before the host was validated');
});

test('the shipped CLI exits 2 for an unparseable host and prints nothing on stdout', () => {
  const result = spawnSync(process.execPath, [BIN, 'audit', '--remote', 'demo/plugin', '--host', 'banana'], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /--host needs a complete DSH version such as 0\.2\.2/u);
  assert.equal(result.stdout, '');
});

test('a leading v is a version, so the compatibility answer is still reached', async () => {
  const io = recorder();
  const code = await run(['audit', '--remote', 'demo/plugin', '--host', 'v0.2.2', '--json'], io, {
    fetchImpl: github(),
  });

  assert.equal(code, 0, io.lines.join('\n'));
  const [row] = JSON.parse(io.lines.join('\n'));
  assert.equal(row.host, 'v0.2.2');
  assert.equal(row.hostRange, '>=0.2.0');
  assert.equal(row.compatibility, 'compatible');
});
