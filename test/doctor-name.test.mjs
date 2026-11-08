import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { verify } from '../lib/verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const fixture = (name) => path.join(here, 'fixtures', name);
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-name-'));

/** A copy of the good fixture with `name` set to `name`, or deleted. */
function pluginWithName(name) {
  const dir = path.join(scratch(), 'plugin');
  fs.cpSync(fixture('good'), dir, { recursive: true });
  const manifestPath = path.join(dir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (name === undefined) delete manifest.name;
  else manifest.name = name;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

/** Run the shipped CLI, not just the run() helper or the predicate. */
function doctorCli(dir) {
  return spawnSync(process.execPath, [CLI, 'doctor', dir], { encoding: 'utf8' });
}

const invalid = [
  { label: 'missing', name: undefined, message: /has no "name"/u },
  { label: 'empty', name: '', message: /has an empty "name"/u },
  { label: 'not a valid npm name', name: 'My Plugin!', message: /not a valid npm package name/u },
];

test('experiment: doctor accepts 0/3 invalid package names at the process boundary', async (t) => {
  let accepted = 0;

  for (const { label, name, message } of invalid) {
    await t.test(label, () => {
      const result = doctorCli(pluginWithName(name));
      if (result.status === 0) accepted += 1;

      assert.equal(result.status, 1, `${label}: expected exit 1\n${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /✗ name:/u, `${label}: ${result.stderr}`);
      assert.match(result.stderr, message, `${label}: ${result.stderr}`);
      assert.doesNotMatch(result.stdout, /^ok\b/mu, `${label}: doctor printed ok\n${result.stdout}`);
    });
  }

  assert.equal(accepted, 0, `accepted=${accepted}/${invalid.length}`);
});

test('a valid plain or scoped name is the control doctor accepts', () => {
  for (const name of ['name-check', '@me/name-check']) {
    const result = doctorCli(pluginWithName(name));
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.ok(result.stdout.includes(`ok  ${name}@1.2.3`), `${name}: ${result.stdout}`);
  }
});

test('verify --no-mount stops at the same name preflight instead of npm pack', async () => {
  const result = await verify({ dir: pluginWithName(undefined), mount: false });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'doctor');
  assert.equal(result.failures[0].check, 'name');
});
