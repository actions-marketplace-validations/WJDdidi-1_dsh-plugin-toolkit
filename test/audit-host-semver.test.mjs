/**
 * The acceptance cases for `audit --remote --host`: a compatible range, an
 * incompatible range, a missing range, and a pre-release host.
 *
 * The pre-release host is not a corner case here — the 3 November compatibility
 * reports were against a canary, and npm's rule is that `>=0.2.0` does not
 * accept `0.2.2-alpha.3` unless the range names a pre-release of that same
 * version. The help text and the batch answer are pinned beside it so the
 * command a reader is told to run is the command the tests exercise.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HELP, run } from '../lib/cli.mjs';
import { hostCompatibility } from '../lib/compat.mjs';

const PRERELEASE_HOST = '0.2.2-alpha.3';

function manifest(range) {
  return {
    name: 'demo-plugin',
    version: '1.2.3',
    main: 'index.js',
    ...(range === undefined ? {} : { engines: { node: '>=18', dsh: range } }),
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
  'demo/compatible': files('>=0.2.0'),
  'demo/incompatible': files('>=0.3.0'),
  'demo/missing': files(undefined),
  'demo/pre-release-range': files('>=0.2.2-alpha.3'),
};

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

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-host-semver-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'repos.txt');
  fs.writeFileSync(file, contents);
  return file;
}

async function finding(args) {
  const io = recorder();
  const code = await run(args, io, { fetchImpl: github() });
  const output = io.lines.join('\n');
  return { code, output, rows: JSON.parse(output) };
}

test('--help documents --host for audit --remote, including the --from batch', async () => {
  const io = recorder();
  const code = await run(['--help'], io);

  assert.equal(code, 0);
  const help = io.lines.join('\n');
  assert.equal(help, HELP);
  assert.match(
    help,
    /^\s+dsh-plugin audit --remote <owner\/repo> --host <version>/mu,
    '--help does not show a single-repository audit with --host',
  );
  assert.match(
    help,
    /^\s+dsh-plugin audit --remote --from <file> --host <version>/mu,
    '--help does not show a batch audit with --host',
  );
  assert.match(
    help,
    /^\s+--host <value>\s+with audit: .*with audit --remote or fix/mu,
    '--help does not explain what --host means for audit --remote',
  );
});

test('a compatible range accepts a stable host', async () => {
  const { code, rows } = await finding(['audit', '--remote', 'demo/compatible', '--host', '0.2.2', '--json']);

  assert.equal(code, 0);
  assert.deepEqual(
    rows.map(({ target, host, hostRange, compatibility }) => ({ target, host, hostRange, compatibility })),
    [{ target: 'demo/compatible', host: '0.2.2', hostRange: '>=0.2.0', compatibility: 'compatible' }],
  );
});

test('a range that excludes the host is incompatible and exits 1', async () => {
  const { code, rows } = await finding(['audit', '--remote', 'demo/incompatible', '--host', '0.2.2', '--json']);

  assert.equal(code, 1);
  assert.equal(rows[0].compatibility, 'incompatible');
  assert.equal(rows[0].hostRange, '>=0.3.0');
});

test('a missing range is unknown rather than a guessed answer', async () => {
  const { code, rows } = await finding(['audit', '--remote', 'demo/missing', '--host', '0.2.2', '--json']);

  assert.equal(code, 1);
  assert.equal(rows[0].compatibility, 'unknown');
  assert.equal(rows[0].hostRange, null);
});

test('a pre-release host follows npm semver: only a range that names it accepts it', async () => {
  const excluded = await finding(['audit', '--remote', 'demo/compatible', '--host', PRERELEASE_HOST, '--json']);
  assert.equal(excluded.code, 1);
  assert.equal(excluded.rows[0].compatibility, 'incompatible');
  assert.equal(hostCompatibility('>=0.2.0', PRERELEASE_HOST), 'incompatible');

  const named = await finding(['audit', '--remote', 'demo/pre-release-range', '--host', PRERELEASE_HOST, '--json']);
  assert.equal(named.code, 0);
  assert.equal(named.rows[0].compatibility, 'compatible');
  assert.equal(named.rows[0].host, PRERELEASE_HOST);
  assert.equal(hostCompatibility('>=0.2.2-alpha.3', PRERELEASE_HOST), 'compatible');
});

test('audit --remote --from answers every case in input order', async (t) => {
  const list = listFile(t, 'demo/compatible\ndemo/incompatible\ndemo/missing\ndemo/pre-release-range\n');
  const io = recorder();
  const code = await run(['audit', '--remote', '--from', list, '--host', PRERELEASE_HOST, '--json'], io, {
    fetchImpl: github(),
  });

  assert.equal(code, 1, 'the batch contains an incompatible and an unknown range');
  const rows = JSON.parse(io.lines.join('\n'));
  assert.deepEqual(
    rows.map(({ target, host, hostRange, compatibility }) => ({ target, host, hostRange, compatibility })),
    [
      {
        target: 'demo/compatible',
        host: PRERELEASE_HOST,
        hostRange: '>=0.2.0',
        compatibility: 'incompatible',
      },
      {
        target: 'demo/incompatible',
        host: PRERELEASE_HOST,
        hostRange: '>=0.3.0',
        compatibility: 'incompatible',
      },
      {
        target: 'demo/missing',
        host: PRERELEASE_HOST,
        hostRange: null,
        compatibility: 'unknown',
      },
      {
        target: 'demo/pre-release-range',
        host: PRERELEASE_HOST,
        hostRange: '>=0.2.2-alpha.3',
        compatibility: 'compatible',
      },
    ],
  );
});
