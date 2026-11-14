/**
 * The compatibility reports end with one question, and the README has to answer
 * it with output a reader can check. That means three things stay tied
 * together: the documented command, the flags it uses, and the sample under
 * `examples/compatibility-sample/` that reproduces the quoted line by running
 * the shipped CLI process against that folder.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HELP } from '../lib/cli.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// A Windows checkout writes README.md with CRLF; normalise before matching so the
// heading regex (which expects `\n` right after the title) works on every platform.
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/gu, '\n');

function compatibilitySection() {
  const match = /^### Will this plugin install on my DSH\?\n([\s\S]*?)(?=^### |^## )/mu.exec(README);
  assert.ok(match, 'README has no "### Will this plugin install on my DSH?" section');
  return match[1];
}

function fencedBlocks(section) {
  return [...section.matchAll(/```(?:sh|text)\n([\s\S]*?)```/gu)].map((entry) => entry[1]);
}

/** The output under the first non-empty shell line, without the `$ command`. */
function commandOutput(block) {
  const lines = block.split('\n');
  const start = lines.findIndex((line) => line.startsWith('$ ') === false);
  return lines.slice(start).join('\n');
}

test('the README shows a real incompatible plugin and its real output', () => {
  const section = compatibilitySection();
  assert.match(
    section,
    /^\$ dsh-plugin audit --remote L3n3L\/dsh-resume --host 0\.2\.2-alpha\.3$/mu,
    'the section does not show the documented command',
  );

  const command = fencedBlocks(section).find((block) => block.includes('$ dsh-plugin audit --remote L3n3L/dsh-resume'));
  assert.ok(command, 'the section does not show the documented command and its output');
  const output = commandOutput(command);
  assert.match(output, /^incompatible  L3n3L\/dsh-resume/u, 'the section does not show the incompatible verdict');
  assert.match(output, /\(host >=0\.1\.0-rc\.6 <0\.2\.0-0\)/u, 'the declared range is missing');
  assert.match(output, /\[incompatible with dsh 0\.2\.2-alpha\.3; declares ">=0\.1\.0-rc\.6 <0\.2\.0-0"\]/u);
  assert.match(output, /^summary: 1 repository — 0 clean, 1 failing \(1 problem\)/mu);
  assert.match(section, /exits `1`/u, 'the section does not say the incompatible answer exits 1');
});

test('the sample is reproducible from the checked-in manifest', () => {
  const section = compatibilitySection();
  assert.match(section, /node scripts\/compatibility-sample\.mjs/u, 'the reproduction command is missing');
  assert.match(section, /examples\/compatibility-sample\//u, 'the checked-in manifest is not named');

  const command = fencedBlocks(section).find((block) => block.includes('$ dsh-plugin audit --remote L3n3L/dsh-resume'));
  assert.ok(command, 'the section does not show the documented command and its output');
  const expected = commandOutput(command);
  const actual = execFileSync(process.execPath, [path.join('scripts', 'compatibility-sample.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(actual, expected, 'the reproducible sample no longer prints the README output');
});

test('every compatibility flag named in the README is a real CLI flag', () => {
  const section = compatibilitySection();
  const documented = new Set([...section.matchAll(/(?<![\w-])--[a-z][a-z-]*/gu)].map((entry) => entry[0]));
  const help = new Set([...HELP.matchAll(/^  (--[a-z][a-z-]*)/gmu)].map((entry) => entry[1]));

  assert.ok(documented.size >= 4, 'the section should document the compatibility flags it uses');
  for (const flag of documented) {
    assert.ok(help.has(flag), `${flag} is documented in the README but missing from --help's Flags list`);
  }
  for (const flag of ['--remote', '--host', '--from', '--json', '--jobs', '--patch-dir']) {
    assert.ok(documented.has(flag), `the compatibility section no longer documents ${flag}`);
    assert.ok(help.has(flag), `--help no longer lists ${flag}`);
  }
});

test('the sample launches the shipped CLI process instead of importing run()', () => {
  // The README says the quoted block is the executable's stdout. Calling the
  // exported `run()` would skip `bin/dsh-plugin.mjs`, so a regression there
  // would leave the sample green while the command a reader copies is broken.
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'compatibility-sample.mjs'), 'utf8');
  assert.match(source, /spawnSync\(/u, 'the sample no longer starts a child process');
  assert.match(source, /bin[\\/]dsh-plugin\.mjs|['"]bin['"],\s*['"]dsh-plugin\.mjs['"]/u, 'the sample does not launch bin/dsh-plugin.mjs');
});

test('the reproducible sample ships with the command it documents', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts?.compatibility, 'node scripts/compatibility-sample.mjs');
  for (const path of ['scripts/compatibility-sample.mjs', 'examples/compatibility-sample/']) {
    assert.ok(manifest.files.includes(path), `the tarball would omit ${path}, so the documented sample would fail`);
  }
});
