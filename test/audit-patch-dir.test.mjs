/**
 * `audit --remote --from <list> --patch-dir <dir>` is the batch repair: one
 * audit per repository, and one `.patch` for every repository the audit can
 * repair. The tests serve GitHub from memory and record the request method, so
 * "never writes to the remote" is asserted rather than assumed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../lib/cli.mjs';
import { patchFileName } from '../lib/audit.mjs';

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function manifest(extra = {}) {
  return {
    name: 'clean-plugin',
    version: '1.2.3',
    main: 'index.js',
    engines: { dsh: '>=0.2.0' },
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
    files: ['index.js', 'cordis.patch.yml', 'README.md'],
    ...extra,
  };
}

const cleanFiles = {
  'package.json': JSON.stringify(manifest()),
  'index.js': 'export function apply() {}\n',
  'cordis.patch.yml': '- insert: []\n',
  'README.md': '# clean\n\nRequires dsh >=0.2.0.\n',
};

const brokenFiles = {
  ...cleanFiles,
  'package.json': JSON.stringify(manifest({ engines: undefined })),
};

/** Serve each repository from memory and record every request method. */
function github(repositories) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' });
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)/u.exec(url);
    if (match === null) return { ok: false, status: 404, json: async () => ({}) };
    const [, owner, repo, file] = match;
    const entry = repositories[`${owner}/${repo}`];
    if (entry === 'rate-limit') return { ok: false, status: 403, json: async () => ({ message: 'rate limit' }) };
    if (entry === undefined || Object.prototype.hasOwnProperty.call(entry, file) === false) {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: encode(entry[file]) }) };
  };
  return { fetchImpl, calls };
}

function recorder() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-patch-dir-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function listFile(t, contents) {
  const file = path.join(workspace(t), 'repos.txt');
  fs.writeFileSync(file, contents);
  return file;
}

test('writes one named patch per repository that needs a repair and creates nested directories', async (t) => {
  const list = listFile(t, 'demo/clean\ndemo/broken\n');
  const patchDir = path.join(workspace(t), 'nested', 'repairs');
  const { fetchImpl, calls } = github({ 'demo/clean': cleanFiles, 'demo/broken': brokenFiles });
  const io = recorder();

  const code = await run(['audit', '--remote', '--from', list, '--patch-dir', patchDir], io, { fetchImpl });

  assert.equal(code, 1);
  assert.equal(fs.existsSync(patchDir), true, 'the patch directory was not created');
  assert.deepEqual(fs.readdirSync(patchDir).sort(), ['demo__broken.patch']);

  const written = fs.readFileSync(path.join(patchDir, 'demo__broken.patch'), 'utf8');
  assert.match(written, /^--- a\/package\.json$/mu);
  assert.match(written, /^\+\+\+ b\/package\.json$/mu);
  assert.match(written, /^\+ {4}"dsh": ">=0\.2\.0"$/mu);

  const output = io.lines.join('\n');
  assert.ok(output.includes(path.join(patchDir, 'demo__broken.patch')), `output does not name the patch: ${output}`);
  assert.match(output, /1 patch written/u);
  assert.equal(fs.existsSync(path.join(patchDir, 'demo__clean.patch')), false, 'a clean repository must not get a patch');

  // A patch is produced from GETs only; the batch never writes to GitHub.
  assert.ok(calls.length > 0, 'the audit made no requests');
  assert.deepEqual([...new Set(calls.map((call) => call.method))], ['GET']);
});

test('creates the patch directory and skips every repository with nothing to fix', async (t) => {
  const list = listFile(t, 'demo/clean\n');
  const patchDir = path.join(workspace(t), 'only-clean', 'patches');
  const { fetchImpl } = github({ 'demo/clean': cleanFiles });
  const io = recorder();

  const code = await run(['audit', '--remote', '--from', list, '--patch-dir', patchDir], io, { fetchImpl });

  assert.equal(code, 0);
  assert.equal(fs.existsSync(patchDir), true, 'an empty patch directory is still created');
  assert.deepEqual(fs.readdirSync(patchDir), []);
  assert.match(io.lines.join('\n'), /0 patches written/u);
});

test('a rate-limited repository gets no patch because there is nothing safe to repair', async (t) => {
  const list = listFile(t, 'demo/blocked\n');
  const patchDir = path.join(workspace(t), 'blocked', 'patches');
  const { fetchImpl, calls } = github({ 'demo/blocked': 'rate-limit' });
  const io = recorder();

  const code = await run(['audit', '--remote', '--from', list, '--patch-dir', patchDir], io, { fetchImpl });

  assert.equal(code, 1);
  assert.deepEqual(fs.readdirSync(patchDir), []);
  assert.match(io.lines.join('\n'), /rate-limited\s+demo\/blocked/u);
  assert.deepEqual([...new Set(calls.map((call) => call.method))], ['GET']);
});

test('patchFileName turns a repository slug into a safe, unique basename', () => {
  assert.equal(patchFileName('demo/broken'), 'demo__broken.patch');
  assert.equal(patchFileName('https://github.com/demo/broken'), 'demo__broken.patch');
  assert.notEqual(patchFileName('a/b-c'), patchFileName('a-b/c'));
});
