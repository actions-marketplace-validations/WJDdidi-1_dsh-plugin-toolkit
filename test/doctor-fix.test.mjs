/**
 * `doctor --fix` is the repair loop around the checks: it says which file it
 * would edit, writes nothing until asked, and then runs the checks again.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../lib/cli.mjs';
import { doctor } from '../lib/doctor.mjs';
import { DEFAULT_ENGINES, doctorFix, repairPlan } from '../lib/fix.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-doctor-fix-'));

function plugin(engines) {
  const dir = path.join(scratch(), 'plugin');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    name: 'repair-me',
    version: '1.0.0',
    files: ['index.js', 'README.md', 'cordis.patch.yml'],
    engines,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    exports: { '.': './index.js' },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply() {}\n');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert: []\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# repair-me\n\n## Requirements\n\n- DeepSeek Harness >=0.2.0\n');
  return dir;
}

const rawOf = (dir) => fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
const manifestOf = (dir) => JSON.parse(rawOf(dir));

function recorder() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

test('a missing engines.dsh is planned against package.json and not written by default', async () => {
  const dir = plugin({ node: '>=18' });
  const before = rawOf(dir);
  const io = recorder();

  assert.equal(await run(['doctor', dir, '--fix'], io), 1);
  const output = io.lines.join('\n');
  assert.match(output, /engines\.dsh: package\.json/u);
  assert.match(output, /would write engines\.dsh/u);
  assert.ok(output.includes(DEFAULT_ENGINES), output);
  assert.match(output, /pass --write/u);
  assert.equal(rawOf(dir), before, 'a plan must leave package.json byte for byte alone');
  assert.deepEqual(manifestOf(dir).engines, { node: '>=18' });
});

test('a missing engines.dsh is written with --write, and the checks are re-run', async () => {
  const dir = plugin({ node: '>=18' });
  const io = recorder();

  assert.equal(await run(['doctor', dir, '--fix', '--write'], io), 0);
  const output = io.lines.join('\n');
  assert.match(output, /wrote engines\.dsh/u);
  assert.match(output, /ok {2}repair-me@1\.0\.0/u);
  assert.equal(manifestOf(dir).engines.dsh, DEFAULT_ENGINES);
  assert.equal(manifestOf(dir).engines.node, '>=18', 'the fixer does not remove the other engines');
  assert.equal(doctor(dir).failures.length, 0);
});

test('a wrong engines.dsh is replaced only with --write', async () => {
  const dir = plugin({ node: '>=18', dsh: '0.2.0' });
  const before = rawOf(dir);

  const plan = repairPlan({ dir });
  assert.equal(plan.ok, true);
  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0].check, 'engines.dsh');
  assert.equal(plan.edits[0].path, 'package.json');
  assert.equal(plan.edits[0].before, '0.2.0');
  assert.equal(plan.edits[0].after, DEFAULT_ENGINES);

  const dry = doctorFix({ dir });
  assert.equal(dry.written, false);
  assert.equal(rawOf(dir), before);

  const wet = doctorFix({ dir, write: true });
  assert.equal(wet.written, true);
  assert.equal(wet.remaining.length, 0);
  assert.equal(manifestOf(dir).engines.dsh, DEFAULT_ENGINES);
});

test('an already-correct manifest has no plan and is left alone even with --write', async () => {
  const dir = plugin({ node: '>=18', dsh: DEFAULT_ENGINES });
  const before = rawOf(dir);
  const io = recorder();

  assert.equal(await run(['doctor', dir, '--fix', '--write'], io), 0);
  const output = io.lines.join('\n');
  assert.match(output, /nothing to fix/u);
  assert.doesNotMatch(output, /would write/u);
  assert.equal(rawOf(dir), before);
});

test('--dry-run wins over --write, so a preview never edits the manifest', async () => {
  const dir = plugin({ node: '>=18' });
  const before = rawOf(dir);
  const io = recorder();

  assert.equal(await run(['doctor', dir, '--fix', '--write', '--dry-run'], io), 1);
  assert.match(io.lines.join('\n'), /would write engines\.dsh/u);
  assert.equal(rawOf(dir), before);
});

test('checks with no automatic edit stay in the plan and are reported after the write', async () => {
  const dir = plugin({ node: '>=18' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# repair-me\n\nNo requirements here.\n');
  const io = recorder();

  assert.equal(await run(['doctor', dir, '--fix', '--write'], io), 1);
  const output = io.lines.join('\n');
  assert.match(output, /readme: README\.md — manual:/u);
  assert.match(output, /problem\(s\) remain/u);
  assert.equal(manifestOf(dir).engines.dsh, DEFAULT_ENGINES);
  assert.equal(doctor(dir).failures.some((failure) => failure.check === 'readme'), true);
});

test('--host aims the engines repair at the DSH that rejected the install', async () => {
  const dir = plugin({ node: '>=18' });
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    '# repair-me\n\n## Requirements\n\n- DeepSeek Harness >=0.3.0 <1.0.0\n',
  );
  const preview = recorder();

  assert.equal(await run(['doctor', dir, '--fix', '--host', '0.3.0'], preview), 1);
  const output = preview.lines.join('\n');
  assert.match(output, /would write engines\.dsh ">=0\.3\.0 <1\.0\.0"/u);
  assert.match(output, /host 0\.3\.0 is inside ">=0\.3\.0 <1\.0\.0"/u);
  assert.deepEqual(manifestOf(dir).engines, { node: '>=18' }, 'naming a host must not write by itself');

  const written = recorder();
  assert.equal(await run(['doctor', dir, '--fix', '--host', '0.3.0', '--write'], written), 0);
  assert.match(written.lines.join('\n'), /wrote engines\.dsh ">=0\.3\.0 <1\.0\.0"/u);
  assert.equal(manifestOf(dir).engines.dsh, '>=0.3.0 <1.0.0');
  assert.equal(doctor(dir).failures.length, 0);
});

test('--host with an incomplete version stops before reading or writing the manifest', async () => {
  const dir = plugin({ node: '>=18' });
  const before = rawOf(dir);
  const io = recorder();

  assert.equal(await run(['doctor', dir, '--fix', '--host', '0.3'], io), 1);
  assert.match(io.lines.join('\n'), /"0\.3" is not a semver host version/u);
  assert.equal(rawOf(dir), before);
});

test('a package.json that is not a JSON object is named instead of crashing', async () => {
  const dir = path.join(scratch(), 'plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), 'null\n');
  const io = recorder();

  assert.equal(await run(['doctor', dir, '--fix'], io), 1);
  const output = io.lines.join('\n');
  assert.match(output, /package\.json does not hold a JSON object/u);
  assert.doesNotMatch(output, /Cannot read properties of null/u);
  assert.equal(rawOf(dir), 'null\n');
  assert.throws(() => doctor(dir), /does not hold a JSON object/u);
});

test('doctor --fix refuses a directory with no package.json instead of creating one', async () => {
  const dir = path.join(scratch(), 'empty');
  fs.mkdirSync(dir, { recursive: true });
  const io = recorder();

  assert.equal(await run(['doctor', dir, '--fix'], io), 1);
  assert.match(io.lines.join('\n'), /no package\.json/u);
  assert.equal(fs.existsSync(path.join(dir, 'package.json')), false);
});
