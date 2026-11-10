/**
 * Both repair entry points have to apply the `engines.dsh` edit to the same
 * UTF-8-BOM manifest `doctor` can read. They are separate CLI paths, so a fix
 * in one does not prove the other, and a writer that keeps the BOM can turn it
 * into a doubled one on the next repair.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_ENGINES } from '../lib/fix.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-doctor-fix-bom-'));

/**
 * The two commands the acceptance names, run from the plugin directory with
 * the literal `.` argument users are told to type.
 */
const ENTRY_POINTS = [
  ['doctor --fix --write', ['doctor', '.', '--fix', '--write']],
  ['fix . --engines --write', ['fix', '.', '--engines', '--write']],
];

/** A temp plugin with no `engines.dsh`, optionally saved the way Notepad does. */
function plugin({ bom = false, doubledBom = false } = {}) {
  const dir = path.join(scratch(), 'plugin');
  fs.cpSync(path.join(here, 'fixtures', 'good'), dir, { recursive: true });
  const manifestPath = path.join(dir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // Keep a sibling engine so the repair has to preserve the rest of the object.
  manifest.engines = { node: '>=18' };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const prefix = doubledBom === true ? '\uFEFF\uFEFF' : bom === true ? '\uFEFF' : '';
  fs.writeFileSync(manifestPath, `${prefix}${text}`);
  return { dir, manifestPath };
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

function assertRepaired({ manifestPath }, result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /wrote engines\.dsh/u);

  const raw = fs.readFileSync(manifestPath, 'utf8');
  assert.equal(raw.includes('\uFEFF'), false, 'the rewritten manifest must contain no BOM, doubled or otherwise');
  assert.equal(raw.startsWith('{'), true, 'the repaired file starts with plain JSON');
  const manifest = JSON.parse(raw);
  assert.equal(manifest.engines.dsh, DEFAULT_ENGINES);
  assert.equal(manifest.engines.node, '>=18', 'the repair keeps the rest of engines');
  assert.equal(manifest.name, 'demo-plugin', 'the repair leaves the rest of the manifest alone');
}

for (const [name, args] of ENTRY_POINTS) {
  test(`${name} repairs a BOM manifest from the plugin root`, () => {
    const target = plugin({ bom: true });
    assertRepaired(target, runCli(args, target.dir));
  });
}

test('the no-BOM control takes both repair paths', () => {
  for (const [name, args] of ENTRY_POINTS) {
    const target = plugin();
    const result = runCli(args, target.dir);
    assert.equal(result.status, 0, `${name}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /wrote engines\.dsh/u);
    const raw = fs.readFileSync(target.manifestPath, 'utf8');
    assert.equal(raw.includes('\uFEFF'), false);
    assert.equal(JSON.parse(raw).engines.dsh, DEFAULT_ENGINES);
  }
});

test('a doubled BOM is repaired, not doubled again', () => {
  for (const [name, args] of ENTRY_POINTS) {
    const target = plugin({ doubledBom: true });
    const result = runCli(args, target.dir);
    assert.equal(result.status, 0, `${name}: ${result.stdout}\n${result.stderr}`);
    assertRepaired(target, result);
  }
});
