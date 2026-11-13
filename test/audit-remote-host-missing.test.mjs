/**
 * `audit --remote --host` must stop when the flag has no version.
 *
 * The old parser read the next argv entry unconditionally. A bare `--host`
 * therefore turned the compatibility question into an audit without one, and
 * `--host --json` compared every repository against the literal version
 * `--json` instead of printing JSON. Either way the user asked for an answer
 * that the command silently did not give. The missing value is a usage error,
 * reported before a repository or a list file is read.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/cli.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');

function recorder() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

/** A fetch that fails the test if the command reads GitHub before validation. */
function noRequest() {
  return async (url) => {
    throw new Error(`the command read ${url} before rejecting the missing --host value`);
  };
}

function scratchPlugin(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-host-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'demo-plugin', version: '1.0.0', engines: { node: '>=18' } }, null, 2)}\n`,
  );
  return dir;
}

test('a bare --host exits 2 with the flag named and never reads a repository', async () => {
  for (const args of [
    ['audit', '--remote', 'demo/plugin', '--host'],
    ['audit', '--remote', 'demo/plugin', '--host', '--json'],
    ['audit', '--remote', '--from', '/does/not/exist', '--host'],
  ]) {
    const io = recorder();
    const code = await run(args, io, { fetchImpl: noRequest() });
    const output = io.lines.join('\n');
    assert.equal(code, 2, `${args.join(' ')}\n${output}`);
    assert.match(output, /--host needs the running app URL, or the DSH version with --remote/u, args.join(' '));
    assert.doesNotMatch(output, /unreadable|not found|cannot read/u, `${args.join(' ')} read further than the flag`);
  }
});

test('fix refuses a bare --host instead of planning the default range', async (t) => {
  const dir = scratchPlugin(t);
  const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  const io = recorder();

  const code = await run(['fix', dir, '--engines', '--host'], io);

  assert.equal(code, 2);
  assert.match(io.lines.join('\n'), /--host needs the DSH version to aim at/u);
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), before);
});

test('a valid --host still reaches the compatibility answer', async () => {
  const manifest = {
    name: 'demo-plugin',
    version: '1.2.3',
    main: 'index.js',
    engines: { dsh: '>=0.2.0' },
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
    files: ['index.js', 'cordis.patch.yml', 'README.md'],
  };
  const files = {
    'package.json': JSON.stringify(manifest),
    'index.js': 'export function apply() {}\n',
    'cordis.patch.yml': '- insert: []\n',
    'README.md': '# demo\n\n## Requirements\n\nRequires dsh >=0.2.0.\n',
  };
  const fetchImpl = async (url) => {
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)/u.exec(url);
    const file = match?.[3];
    if (file === undefined || Object.prototype.hasOwnProperty.call(files, file) === false) {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ encoding: 'base64', content: Buffer.from(files[file], 'utf8').toString('base64') }),
    };
  };
  const io = recorder();

  const code = await run(['audit', '--remote', 'demo/plugin', '--host', '0.2.2', '--json'], io, { fetchImpl });

  assert.equal(code, 0);
  const [row] = JSON.parse(io.lines.join('\n'));
  assert.equal(row.host, '0.2.2');
  assert.equal(row.hostRange, '>=0.2.0');
  assert.equal(row.compatibility, 'compatible');
});

test('the shipped CLI exits 2 for a trailing bare --host', () => {
  const result = spawnSync(process.execPath, [BIN, 'audit', '--remote', 'demo/plugin', '--host'], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /--host needs the running app URL, or the DSH version with --remote/u);
  assert.equal(result.stdout, '');
});
