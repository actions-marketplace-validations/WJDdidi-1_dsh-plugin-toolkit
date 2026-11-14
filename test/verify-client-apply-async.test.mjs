/**
 * The client half has the same rejection hazard as the host half. `verify`
 * calls a client face's `apply()` on a bare boot context; when that apply is
 * async the returned promise used to escape the probe, so a plugin that
 * rejected there killed the process with an unhandled rejection and a stack
 * trace instead of a named `boot` failure. These tests pin the awaited boot
 * probe at the API and at the process boundary.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { verify } from '../lib/verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'verify-client-apply-async');

function runVerify() {
  const result = spawnSync(process.execPath, [BIN, 'verify', FIXTURE], {
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

test('a rejecting async client apply fails the CLI with a boot failure instead of an unhandled rejection', () => {
  const result = runVerify();
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /dsh-plugin verify: stopped at mount/, result.output);
  const line = result.output.split('\n').find((entry) => entry.includes('boot:'));
  assert.ok(line, result.output);
  assert.match(line, /async client apply exploded/, line);
  // The bug let the rejection reach Node instead of printing a named failure.
  assert.doesNotMatch(result.output, /^ok {2}packed/m, result.output);
  assert.doesNotMatch(result.output, /^Node\.js v/m, result.output);
});

test('verify awaits an async client apply and reports it as a boot failure', async () => {
  const result = await verify({ dir: FIXTURE });
  assert.equal(result.ok, false, JSON.stringify(result.failures));
  assert.equal(result.stage, 'mount');
  assert.ok(result.failures.some((failure) => failure.check === 'boot'), JSON.stringify(result.failures));
  assert.match(
    result.failures.map((failure) => failure.message).join('\n'),
    /async client apply exploded/,
  );
});
