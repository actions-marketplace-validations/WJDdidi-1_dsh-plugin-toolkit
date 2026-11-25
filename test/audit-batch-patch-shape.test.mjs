/**
 * A batch audit must carry the patch finding the single-repository audit
 * already makes. `audit --remote` reads a list and prints one row per
 * repository, so a committed `cordis.patch.yml` with no usable insert row has
 * to fail its row, feed the summary, and appear in the repository's `--json`
 * object exactly as it does for `doctor` on a checkout. Without that, a
 * batched repair sweep would print `clean` for a repository whose plugin can
 * never mount.
 *
 * This runs the shipped bin with a `--require` shim that replaces global fetch
 * with one fake GitHub tree containing three malformed and three valid
 * repositories. Each malformed finding is compared with the sentence the local
 * `doctor()` gives the same bytes, so the two checks cannot drift.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { doctor } from '../lib/doctor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'dsh-plugin.mjs');

const MANIFEST = {
  name: 'demo-plugin',
  version: '1.2.3',
  main: 'index.js',
  engines: { dsh: '>=0.2.0' },
  dsh: { bundle: { patch: 'cordis.patch.yml' } },
  files: ['index.js', 'cordis.patch.yml', 'README.md'],
};

const SUPPORT = {
  'package.json': JSON.stringify(MANIFEST),
  'index.js': 'export function apply() {}\n',
  'README.md': '# demo\n\n## Requirements\n\nRequires dsh >=0.2.0.\n',
};

// The three shapes the demand names, each paired with the repository that
// serves it. The valid controls cover the block, indentless and inline insert
// spellings so the batch check cannot reject a working plugin.
const MALFORMED = [
  { repo: 'demo/patch-mapping', source: 'foo: bar\n' },
  { repo: 'demo/patch-empty-insert', source: '- insert: []\n' },
  { repo: 'demo/patch-empty', source: '' },
];

const VALID = [
  { repo: 'demo/patch-block', source: '- insert:\n    - id: row\n      name: row\n' },
  { repo: 'demo/patch-indentless', source: '- insert:\n  - id: row\n    name: row\n' },
  { repo: 'demo/patch-inline', source: '- insert: [{ id: row, name: row }]\n' },
];

function repoFiles(source) {
  return { ...SUPPORT, 'cordis.patch.yml': source };
}

const ORDER = [...MALFORMED, ...VALID].map(({ repo }) => repo);
const REPOSITORIES = Object.fromEntries([...MALFORMED, ...VALID].map(({ repo, source }) => [repo, repoFiles(source)]));

/** The local `doctor()` sentence for the same patch bytes. */
function localPatchFailure(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-batch-patch-local-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(repoFiles(source))) {
    fs.writeFileSync(path.join(dir, name), text);
  }
  const report = doctor(dir);
  assert.deepEqual(
    report.failures.map((failure) => failure.check),
    ['patch file'],
    JSON.stringify(report.failures),
  );
  return report.failures[0].message;
}

/**
 * A `--require` shim that serves the six-repository tree above. The contents
 * API path carries `owner/repo` and the file path, so one handler answers every
 * repository in the batch without a real request.
 */
function preload(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-batch-patch-fetch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'github-fetch.cjs');
  fs.writeFileSync(
    file,
    `const files = JSON.parse(Buffer.from(process.env.DSH_AUDIT_BATCH_FILES ?? '', 'base64').toString('utf8'));
globalThis.fetch = async (url) => {
  const pathname = new URL(String(url)).pathname;
  const match = /^\\/repos\\/([^/]+)\\/([^/]+)\\/contents\\/(.+)$/u.exec(pathname);
  if (match === null) return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
  const owner = match[1];
  const repo = match[2];
  const name = decodeURIComponent(match[3]);
  const entry = files[owner + '/' + repo];
  if (entry === undefined || Object.prototype.hasOwnProperty.call(entry, name) === false) {
    return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ encoding: 'base64', content: Buffer.from(entry[name], 'utf8').toString('base64') }),
  };
};
`,
  );
  return file;
}

function runBatch(t, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-batch-patch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const list = path.join(dir, 'repos.txt');
  fs.writeFileSync(list, `${ORDER.join('\n')}\n`);
  return spawnSync(process.execPath, ['--require', preload(t), CLI, 'audit', '--remote', '--from', list, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_AUDIT_BATCH_FILES: Buffer.from(JSON.stringify(REPOSITORIES), 'utf8').toString('base64'),
    },
  });
}

test('a batch of 3 malformed and 3 valid repositories prints 3 clean, 3 failing (3 problems) and exits 1', (t) => {
  const expected = Object.fromEntries(MALFORMED.map(({ repo, source }) => [repo, localPatchFailure(t, source)]));
  const result = runBatch(t);
  const output = `${result.stdout}\n${result.stderr}`;
  const lines = output.split(/\r?\n/u);
  const rowFor = (repo) => lines.find((line) => line.includes(`  ${repo}  `));

  assert.equal(result.status, 1, output);
  for (const { repo } of MALFORMED) {
    const line = rowFor(repo);
    assert.ok(line, output);
    assert.match(line, /^failing\s+/u, line);
    assert.match(line, /— patch file: dsh\.bundle\.patch points at cordis\.patch\.yml/u, line);
    assert.ok(line.includes(expected[repo]), line);
  }
  const cleanTargets = lines
    .filter((line) => line.startsWith('clean  '))
    .map((line) => line.trim().split(/\s{2,}/u)[1]);
  for (const { repo } of MALFORMED) assert.equal(cleanTargets.includes(repo), false, output);
  for (const { repo } of VALID) assert.equal(cleanTargets.includes(repo), true, output);
  assert.match(
    output,
    /summary: 6 repositories — 3 clean, 3 failing \(3 problems\), 0 unreadable, 0 rate-limited/u,
  );
});

test('each malformed batch row carries the patch file failure in its --json object', (t) => {
  const expected = Object.fromEntries(MALFORMED.map(({ repo, source }) => [repo, localPatchFailure(t, source)]));
  const result = runBatch(t, ['--json']);
  assert.equal(result.status, 1, result.stderr);

  const reports = JSON.parse(result.stdout);
  assert.deepEqual(reports.map((report) => report.target), ORDER);
  for (const { repo } of MALFORMED) {
    const finding = reports.find((report) => report.target === repo);
    assert.ok(finding, JSON.stringify(reports));
    assert.deepEqual(finding.failures, [{ check: 'patch file', message: expected[repo] }], JSON.stringify(finding));
  }
  for (const { repo } of VALID) {
    const finding = reports.find((report) => report.target === repo);
    assert.ok(finding, JSON.stringify(reports));
    assert.deepEqual(finding.failures, [], JSON.stringify(finding));
  }
});
