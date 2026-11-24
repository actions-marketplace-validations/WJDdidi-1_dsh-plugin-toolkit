/**
 * A patch file that exists but cannot insert a loader row is the same install
 * failure as a missing one: the host reports success and the plugin never
 * mounts. `doctor` used to stop at "the path is a regular file", so an empty
 * file, a plain mapping, and `- insert: []` all printed `ok`. A later bug
 * accepted `- insert: [{}]`, `[null]` and `[false]`: the list was non-empty,
 * but none of those entries names a row the loader can mount.
 *
 * The fixtures are committed so the shipped CLI is judged on the same bytes a
 * user can inspect. `patch-valid` and `patch-insert-inline-valid` are controls:
 * the same manifest and code with one real `- insert:` row must still exit 0
 * from `doctor` and `verify --no-mount`, or the rejection would turn a working
 * plugin red.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkPatchFile, doctor } from '../lib/doctor.mjs';
import { repairPlan } from '../lib/fix.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const fixture = (name) => path.join(here, 'fixtures', name);

const INVALID = [
  'patch-empty',
  'patch-no-insert',
  'patch-empty-insert',
  'patch-insert-empty-object',
  'patch-insert-null',
  'patch-insert-false',
];

function run(command, args) {
  const result = spawnSync(process.execPath, [BIN, command, ...args], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

test('the invalid fixtures really carry the patch shape they name', () => {
  const read = (name) => fs.readFileSync(path.join(fixture(name), 'cordis.patch.yml'), 'utf8')
    .replace(/\r\n/gu, '\n'); // a Windows checkout is CRLF; the fixture content is LF
  assert.equal(read('patch-empty'), '');
  assert.equal(read('patch-no-insert'), 'foo: bar\n');
  assert.equal(read('patch-empty-insert'), '- insert: []\n');
  assert.equal(read('patch-insert-empty-object'), '- insert: [{}]\n');
  assert.equal(read('patch-insert-null'), '- insert: [null]\n');
  assert.equal(read('patch-insert-false'), '- insert: [false]\n');
  assert.match(
    read('patch-valid'),
    /^- insert:\n {4}- id: patch-valid$/mu,
  );
  assert.equal(read('patch-insert-inline-valid'), '- insert: [{ id: x, name: x, config: {} }]\n');
});

for (const name of INVALID) {
  test(`doctor reports ${name} as a patch file failure naming cordis.patch.yml`, () => {
    const report = doctor(fixture(name));
    assert.deepEqual(
      report.failures.map((failure) => failure.check),
      ['patch file'],
      JSON.stringify(report.failures),
    );
    const [failure] = report.failures;
    assert.match(failure.message, /no insert row the host can apply/u);
    assert.ok(failure.message.includes('cordis.patch.yml'), failure.message);
  });

  test(`the shipped CLI refuses ${name} from doctor and verify --no-mount at the doctor stage`, () => {
    const doctorRun = run('doctor', [fixture(name)]);
    assert.equal(doctorRun.status, 1, doctorRun.output);
    assert.doesNotMatch(doctorRun.output, /^ok {2}/mu, doctorRun.output);
    const doctorLine = doctorRun.output.split(/\r?\n/u).find((line) => line.includes('✗ patch file:'));
    assert.ok(doctorLine, doctorRun.output);
    assert.ok(doctorLine.includes('cordis.patch.yml'), doctorLine);
    assert.match(doctorLine, /no insert row the host can apply/u);

    const verifyRun = run('verify', [fixture(name), '--no-mount']);
    assert.equal(verifyRun.status, 1, verifyRun.output);
    assert.match(verifyRun.output, /dsh-plugin verify: stopped at doctor/u);
    assert.match(verifyRun.output, /✗ patch file: .*cordis\.patch\.yml/u);
    assert.doesNotMatch(verifyRun.output, /✗ pack:/u);
  });
}

test('the valid - insert: control still exits 0 from both commands', () => {
  const doctorRun = run('doctor', [fixture('patch-valid')]);
  assert.equal(doctorRun.status, 0, doctorRun.output);
  assert.match(doctorRun.output, /^ok {2}patch-valid@1\.0\.0 /mu);

  const verifyRun = run('verify', [fixture('patch-valid'), '--no-mount']);
  assert.equal(verifyRun.status, 0, verifyRun.output);
  assert.match(verifyRun.output, /^ok {2}packed \d+ file\(s\)/mu);
  assert.doesNotMatch(verifyRun.output, /stopped at doctor|no insert row/u);
});

test('the inline - insert: [{ id, name, config }] control still exits 0 from both commands', () => {
  const doctorRun = run('doctor', [fixture('patch-insert-inline-valid')]);
  assert.equal(doctorRun.status, 0, doctorRun.output);
  assert.match(doctorRun.output, /^ok {2}patch-insert-inline-valid@1\.0\.0 /mu);

  const verifyRun = run('verify', [fixture('patch-insert-inline-valid'), '--no-mount']);
  assert.equal(verifyRun.status, 0, verifyRun.output);
  assert.match(verifyRun.output, /^ok {2}packed \d+ file\(s\)/mu);
  assert.doesNotMatch(verifyRun.output, /stopped at doctor|no insert row/u);
});

test('doctor --fix asks for a row in the existing patch, not for a new file', () => {
  const plan = repairPlan({ dir: fixture('patch-empty-insert') });
  assert.equal(plan.ok, true);
  const patch = plan.plan.find((entry) => entry.check === 'patch file');
  assert.ok(patch, JSON.stringify(plan.plan));
  assert.match(patch.manual, /one "- insert:" row/u);
  assert.doesNotMatch(patch.manual, /^create/u);
  assert.ok(patch.path.endsWith('cordis.patch.yml'), patch.path);
});

test('the row detector accepts a valid inline or indentless insert and rejects a commented one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-shape-'));
  try {
    const manifest = { dsh: { bundle: { patch: 'cordis.patch.yml' } } };
    const cases = [
      { name: 'comments only', source: '# - insert:\n#     - id: ghost\n', valid: false },
      { name: 'inline list', source: '- insert: [{ id: row, name: row }]\n', valid: true },
      { name: 'indentless sequence', source: '- insert:\n  - id: row\n    name: row\n', valid: true },
      { name: 'inline empty list', source: '- insert: [ ]\n', valid: false },
      { name: 'empty block', source: '- insert:\n  # nothing follows\n', valid: false },
      { name: 'inline empty mapping', source: '- insert: [{}]\n', valid: false },
      { name: 'inline null', source: '- insert: [null]\n', valid: false },
      { name: 'inline false', source: '- insert: [false]\n', valid: false },
      { name: 'inline scalar', source: '- insert: [row]\n', valid: false },
      { name: 'inline row without a name', source: '- insert: [{ id: row, config: {} }]\n', valid: false },
      { name: 'inline null name', source: '- insert: [{ id: row, name: null }]\n', valid: false },
      { name: 'block empty mapping', source: '- insert:\n  - {}\n', valid: false },
      { name: 'block null', source: '- insert:\n  - null\n', valid: false },
      { name: 'block false', source: '- insert:\n  - false\n', valid: false },
      { name: 'block row with a name', source: '- insert:\n  - id: row\n    name: row\n', valid: true },
      { name: 'block row with a config list', source: '- insert:\n  - name: row\n    config:\n      - nested\n', valid: true },
      { name: 'block mapping with a config list', source: '- insert:\n    config:\n      - nested\n    name: row\n', valid: true },
      { name: 'second inline entry names a row', source: '- insert: [null, { id: row, name: row }]\n', valid: true },
    ];
    for (const entry of cases) {
      fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), entry.source);
      const failure = checkPatchFile(dir, manifest);
      if (entry.valid) assert.equal(failure, null, `${entry.name}: ${failure}`);
      else assert.match(failure, /no insert row the host can apply/u, entry.name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
