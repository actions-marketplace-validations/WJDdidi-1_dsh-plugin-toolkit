/**
 * The BOM acceptance cases, checked at the process boundary a user sees:
 * `doctor` exits `0` for a plain README and for one whose first line is
 * `## Requirements` after a UTF-8 BOM, and exits `1` for a BOM README with no
 * heading. The unit tests call `doctor()` directly; this one runs the real bin
 * so a regression in argument handling or output cannot hide behind them.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const fixture = (name) => path.join(here, 'fixtures', name);

function runDoctor(name) {
  return spawnSync(process.execPath, [CLI, 'doctor', fixture(name)], { encoding: 'utf8' });
}

test('the BOM fixtures are honest: each README really starts with U+FEFF', () => {
  for (const name of ['readme-bom', 'readme-bom-no-heading']) {
    const text = fs.readFileSync(path.join(fixture(name), 'README.md'), 'utf8');
    assert.equal(text.codePointAt(0), 0xfeff, `${name}/README.md has no UTF-8 BOM`);
  }
  const plain = fs.readFileSync(path.join(fixture('readme-plain'), 'README.md'), 'utf8');
  assert.notEqual(plain.codePointAt(0), 0xfeff, 'readme-plain/README.md must not start with a BOM');
});

test('doctor accepts a plain README whose Requirements heading is the first line', () => {
  const result = runDoctor('readme-plain');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok {2}readme-plain-fixture@1\.2\.3 \(host >=0\.2\.0\)$/mu);
  assert.equal(result.stderr, '');
});

test('doctor accepts a README whose Requirements heading is the first line after a BOM', () => {
  const result = runDoctor('readme-bom');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok {2}readme-bom-fixture@1\.2\.3 \(host >=0\.2\.0\)$/mu);
  assert.doesNotMatch(result.stderr, /has no Requirements section/u);
  assert.equal(result.stderr, '');
});

test('doctor rejects a BOM README that really has no Requirements heading', () => {
  const result = runDoctor('readme-bom-no-heading');

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /dsh-plugin doctor: 1 problem\(s\) in .*readme-bom-no-heading/u);
  assert.match(
    result.stderr,
    /readme: README\.md has no Requirements section, so users cannot tell which host it needs/u,
  );
});
