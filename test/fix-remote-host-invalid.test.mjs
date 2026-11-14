/**
 * `fix --remote --host` has to reject a value it cannot aim at before it reads
 * GitHub. The host is parsed to build the range, so fetching first turned a
 * typo into "cannot reach GitHub" when the network was down, spent the
 * unauthenticated quota when it was up, and only then named the real mistake.
 * The same pre-read check covers an explicit `--range` that is not a range.
 *
 * A leading `v` is still a version, so the control has to reach the plan and
 * print the same `>=0.3.0 <1.0.0` range the local writer applies.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const INVALID_HOSTS = ['banana', '0.3', '>=0.3.0', 'latest'];

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
    throw new Error(`the command read ${url} before rejecting the flag`);
  };
}

function manifest() {
  return {
    name: 'demo-plugin',
    version: '1.2.3',
    engines: { node: '>=18' },
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
    files: ['index.js', 'cordis.patch.yml', 'README.md'],
  };
}

function github(raw) {
  return async (url) => {
    const match = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\/([^?]+)/u.exec(url);
    if (match === null || match[1] !== 'package.json') {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ encoding: 'base64', content: Buffer.from(raw, 'utf8').toString('base64') }),
    };
  };
}

test('an invalid remote --host is refused before GitHub is read', async () => {
  for (const value of INVALID_HOSTS) {
    const io = recorder();
    const code = await run(['fix', 'demo/plugin', '--remote', '--engines', '--host', value], io, {
      fetchImpl: noRequest(),
    });
    const output = io.lines.join('\n');

    assert.equal(code, 2, `${value}\n${output}`);
    assert.match(output, /is not a semver host version/u, value);
    assert.doesNotMatch(output, /cannot reach GitHub|GitHub answered|rate-limited/u, `${value} read GitHub`);
    assert.doesNotMatch(output, /^--- a\/package\.json$/mu, `${value} printed a plan`);
  }
});

test('an explicit --range that is not a range is refused before GitHub is read', async () => {
  const io = recorder();
  const code = await run(
    ['fix', 'demo/plugin', '--remote', '--engines', '--range', 'banana', '--host', '0.3.0'],
    io,
    { fetchImpl: noRequest() },
  );
  const output = io.lines.join('\n');

  assert.equal(code, 2, output);
  assert.match(output, /is not a semver range/u);
  assert.doesNotMatch(output, /cannot reach GitHub|GitHub answered|rate-limited/u);
});

test('a leading v is still a host, so the plan names the same range the writer uses', async () => {
  const raw = `${JSON.stringify(manifest(), null, 2)}\n`;
  const io = recorder();
  const code = await run(
    ['fix', 'demo/plugin', '--remote', '--engines', '--host', 'v0.3.0'],
    io,
    { fetchImpl: github(raw) },
  );
  const output = io.lines.join('\n');

  assert.equal(code, 0, output);
  assert.match(output, /would write engines\.dsh ">=0\.3\.0 <1\.0\.0"/u);
  assert.match(output, /host 0\.3\.0 is inside/u);
  assert.match(output, /1\.0\.0 is excluded/u);
  assert.match(output, /^\+ {4}"dsh": ">=0\.3\.0 <1\.0\.0"$/mu);
});

test('the shipped CLI rejects an invalid host without attempting a request', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fix-remote-host-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, 'no-fetch.cjs');
  fs.writeFileSync(
    preload,
    `globalThis.fetch = async (url) => {
  throw new Error('the command read ' + url + ' before rejecting the host');
};
`,
  );

  const result = spawnSync(
    process.execPath,
    ['--require', preload, BIN, 'fix', 'demo/plugin', '--remote', '--engines', '--host', 'banana'],
    { cwd: ROOT, encoding: 'utf8' },
  );

  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /is not a semver host version/u);
  assert.doesNotMatch(result.stderr, /cannot reach GitHub|GitHub answered|rate-limited/u);
  assert.equal(result.stdout, '');
});
