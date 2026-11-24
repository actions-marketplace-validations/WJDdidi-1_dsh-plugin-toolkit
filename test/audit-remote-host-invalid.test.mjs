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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/cli.mjs';
import { auditRemoteTargets } from '../lib/audit.mjs';
import { auditRemote } from '../lib/remote.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const INVALID = ['banana', '0.2', '>=0.2.0', 'latest', '', '   '];

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
      'cordis.patch.yml': '- insert:\n    - id: test-plugin\n      name: test-plugin\n      config: {}\n',
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

function listFile(t, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-host-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'repos.txt');
  fs.writeFileSync(file, contents);
  return file;
}

test('the batch form rejects --host banana from a real list without reading GitHub or printing a finding', async (t) => {
  const list = listFile(t, 'acme/clean\n');
  let requests = 0;
  const stdout = [];
  const stderr = [];
  const io = {
    log: (line) => stdout.push(String(line)),
    error: (line) => stderr.push(String(line)),
  };

  const code = await run(['audit', '--remote', '--from', list, '--host', 'banana', '--json'], io, {
    fetchImpl: async (url) => {
      requests += 1;
      throw new Error(`the command read ${url} before rejecting the --host value`);
    },
  });

  assert.equal(code, 2);
  assert.equal(requests, 0, 'an invalid host made a GitHub request');
  assert.deepEqual(stdout, [], 'an invalid host printed a JSON finding');
  assert.match(stderr.join('\n'), /--host needs a complete DSH version such as 0\.2\.2.*banana/u);
});

test('both forms give a blank remote host the library contract sentence, not the local-URL hint', async (t) => {
  const list = listFile(t, 'acme/clean\n');
  for (const args of [
    ['audit', '--remote', 'acme/clean', '--host', '   '],
    ['audit', '--remote', '--from', list, '--host', '   '],
  ]) {
    const io = recorder();
    const code = await run(args, io, { fetchImpl: noRequest() });

    assert.equal(code, 2, args.join(' '));
    assert.match(io.lines.join('\n'), /--host needs a complete DSH version such as 0\.2\.2, got "   "/u);
    assert.doesNotMatch(io.lines.join('\n'), /running app URL/u, 'a remote audit used the local URL hint');
  }
});

test('the batch valid-host control still exits 0 with a compatible finding', async (t) => {
  const list = listFile(t, 'acme/clean\n');
  const io = recorder();

  const code = await run(['audit', '--remote', '--from', list, '--host', '0.2.0'], io, {
    fetchImpl: github(),
  });

  assert.equal(code, 0, io.lines.join('\n'));
  assert.match(io.lines.join('\n'), /\[compatible with dsh 0\.2\.0; declares ">=0\.2\.0"\]/u);
});

test('the shipped CLI rejects the batch form before it opens the list', (t) => {
  const list = listFile(t, 'acme/clean\n');
  const result = spawnSync(process.execPath, [BIN, 'audit', '--remote', '--from', list, '--host', 'banana'], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /--host needs a complete DSH version such as 0\.2\.2.*banana/u);
  assert.equal(result.stdout, '');
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

test('the acceptance case names --host and banana, prints no finding and makes no request', async () => {
  let requests = 0;
  const stdout = [];
  const stderr = [];
  const io = {
    log: (line) => stdout.push(String(line)),
    error: (line) => stderr.push(String(line)),
  };

  const code = await run(['audit', '--remote', 'acme/clean', '--host', 'banana', '--json'], io, {
    fetchImpl: async (url) => {
      requests += 1;
      throw new Error(`the command read ${url} before rejecting the --host value`);
    },
  });

  assert.equal(code, 2);
  assert.equal(requests, 0, 'an invalid host made a GitHub request');
  assert.deepEqual(stdout, [], 'an invalid host printed a JSON finding');
  const message = stderr.join('\n');
  assert.match(message, /--host/u, 'the message did not name --host');
  assert.match(message, /banana/u, 'the message did not quote the rejected value');
});

test('the valid 0.2.0 control still exits 0 with a compatible finding', async () => {
  const io = recorder();
  const code = await run(['audit', '--remote', 'acme/clean', '--host', '0.2.0', '--json'], io, {
    fetchImpl: github(),
  });

  assert.equal(code, 0, io.lines.join('\n'));
  const [row] = JSON.parse(io.lines.join('\n'));
  assert.equal(row.host, '0.2.0');
  assert.equal(row.compatibility, 'compatible');
});

test('the exported single-target and batch audits hold the same host contract before a read', async () => {
  let requests = 0;
  const fetchImpl = async (url) => {
    requests += 1;
    throw new Error(`the library read ${url} before rejecting the --host value`);
  };

  await assert.rejects(() => auditRemote('acme/clean', { fetchImpl, host: 'banana' }), /--host.*banana/u);
  await assert.rejects(() => auditRemoteTargets('acme/clean', { fetchImpl, host: 'banana' }), /--host.*banana/u);
  await assert.rejects(() => auditRemote('acme/clean', { fetchImpl, host: '   ' }), /--host.*"   "/u);
  await assert.rejects(() => auditRemoteTargets('acme/clean', { fetchImpl, host: '' }), /--host.*""/u);
  await assert.rejects(
    () => auditRemoteTargets(undefined, { fetchImpl, from: '/does/not/exist', host: 'banana' }),
    /--host.*banana/u,
    'the list file was read before the host was validated',
  );
  assert.equal(requests, 0, 'an invalid host made a GitHub request');
});
