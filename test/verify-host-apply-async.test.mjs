/**
 * A host half is allowed to be async. `verify --no-mount` used to call
 * `apply()` without awaiting it, so a rejecting promise produced the success
 * line and only then killed the process with an unhandled rejection. These
 * tests pin the failure at the API and at the process boundary, with the
 * synchronous throw as the control.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { verify } from '../lib/verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const fixture = (name) => path.join(ROOT, 'test', 'fixtures', name);

function runVerify(name) {
  const result = spawnSync(process.execPath, [BIN, 'verify', fixture(name), '--no-mount'], {
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function assertHostApplyFailure(result, message) {
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /dsh-plugin verify: stopped at install/, result.output);
  const line = result.output.split('\n').find((entry) => entry.includes('host apply:'));
  assert.ok(line, result.output);
  assert.match(line, new RegExp(message), line);
  // The bug printed the success line before the unhandled rejection surfaced.
  assert.doesNotMatch(result.output, /^ok {2}packed/m, result.output);
  assert.doesNotMatch(result.output, /^Node\.js v/m, result.output);
  assert.doesNotMatch(result.output, /imported its host half/, result.output);
}

test('a rejecting async host apply fails the CLI instead of printing success and crashing', () => {
  assertHostApplyFailure(runVerify('verify-host-apply-async'), 'async apply exploded');
});

test('a synchronous host apply throw keeps the same failure', () => {
  assertHostApplyFailure(runVerify('verify-host-apply-sync'), 'sync apply exploded');
});

test('verify awaits an async host apply and reports it as a host apply failure', async () => {
  const result = await verify({ dir: fixture('verify-host-apply-async'), mount: false });
  assert.equal(result.ok, false, JSON.stringify(result.failures));
  assert.equal(result.stage, 'install');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].check, 'host apply');
  assert.match(result.failures[0].message, /async apply exploded/);
});

test('a host apply that rejects without an Error still names the rejection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-host-string-'));
  try {
    fs.cpSync(fixture('verify-host-apply-async'), dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), `export async function apply() {
  throw 'string apply exploded';
}
`);
    const result = await verify({ dir, mount: false });
    assert.equal(result.ok, false, JSON.stringify(result.failures));
    assert.equal(result.failures[0].check, 'host apply');
    assert.match(result.failures[0].message, /string apply exploded/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
