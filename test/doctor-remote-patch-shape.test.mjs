/**
 * `doctor --remote` has to read the declared patch body, not just find its
 * path. A committed `cordis.patch.yml` that is empty, a plain mapping such as
 * `foo: bar`, or `- insert: []` gives the loader nothing to mount; a local
 * `doctor` rejects that tree with a `patch file` failure, so the remote verdict
 * must print the same sentence instead of `ok`.
 *
 * The real bin runs with a `--require` shim that replaces global fetch with a
 * tiny mock of the GitHub contents API. Each remote run is compared with the
 * local `doctor()` sentence for the same bytes, so the two checks cannot drift.
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

// The three shapes the demand names. Each has to fail remotely with the same
// sentence the local checker produces for the same patch body.
const MALFORMED = [
  { name: 'a mapping', source: 'foo: bar\n' },
  { name: 'an empty insert list', source: '- insert: []\n' },
  { name: 'an empty file', source: '' },
];

// One usable insert row is enough. The three spellings exercise the block,
// indentless-sequence and inline-list shapes the parser accepts.
const VALID = [
  { name: 'a block insert', source: '- insert:\n    - id: row\n      name: row\n' },
  { name: 'an indentless insert', source: '- insert:\n  - id: row\n    name: row\n' },
  { name: 'an inline insert', source: '- insert: [{ id: row, name: row }]\n' },
];

function preload(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-remote-patch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'github-fetch.cjs');
  fs.writeFileSync(
    file,
    `const files = JSON.parse(Buffer.from(process.env.DSH_DOCTOR_REMOTE_FILES ?? '', 'base64').toString('utf8'));
const prefix = '/repos/acme/probe/contents/';
globalThis.fetch = async (url) => {
  const pathname = new URL(String(url)).pathname;
  if (pathname.startsWith(prefix) === false) {
    return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
  }
  const name = decodeURIComponent(pathname.slice(prefix.length));
  if (Object.prototype.hasOwnProperty.call(files, name) === false) {
    return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ encoding: 'base64', content: Buffer.from(files[name], 'utf8').toString('base64') }),
  };
};
`,
  );
  return file;
}

function runRemote(t, patchSource, args = ['doctor', '--remote', 'acme/probe']) {
  return spawnSync(process.execPath, ['--require', preload(t), CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_DOCTOR_REMOTE_FILES: Buffer.from(
        JSON.stringify({ ...SUPPORT, 'cordis.patch.yml': patchSource }),
        'utf8',
      ).toString('base64'),
    },
  });
}

/** The local `doctor()` sentence for the same patch bytes. */
function localPatchFailure(t, patchSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-local-patch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, source] of Object.entries({ ...SUPPORT, 'cordis.patch.yml': patchSource })) {
    fs.writeFileSync(path.join(dir, name), source);
  }
  const report = doctor(dir);
  assert.deepEqual(
    report.failures.map((failure) => failure.check),
    ['patch file'],
    JSON.stringify(report.failures),
  );
  return report.failures[0].message;
}

for (const { name, source } of MALFORMED) {
  test(`doctor --remote rejects ${name} with the local patch file sentence`, (t) => {
    const expected = localPatchFailure(t, source);
    assert.match(expected, /no insert row the host can apply/u);

    const result = runRemote(t, source);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /1 problem\(s\) in acme\/probe/u);
    assert.match(result.stderr, new RegExp(`✗ patch file: ${expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
    assert.equal(result.stdout, '');
  });
}

for (const { name, source } of VALID) {
  test(`doctor --remote still exits 0 for ${name} with a non-empty name`, (t) => {
    const result = runRemote(t, source);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ok {2}demo-plugin@1\.2\.3 \(host >=0\.2\.0\) at acme\/probe$/mu);
    assert.doesNotMatch(result.stderr, /patch file|no insert row/u);
  });
}

test('audit --remote carries the malformed patch into a failing JSON finding', (t) => {
  const source = MALFORMED[0].source;
  const expected = localPatchFailure(t, source);
  const result = runRemote(t, source, ['audit', '--remote', 'acme/probe', '--json']);

  assert.equal(result.status, 1, result.stderr);
  const [finding] = JSON.parse(result.stdout);
  assert.equal(finding.target, 'acme/probe');
  assert.deepEqual(finding.failures, [{ check: 'patch file', message: expected }]);
});
