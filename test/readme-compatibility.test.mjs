/**
 * The compatibility reports end with one question, and the README has to answer
 * it with output a reader can check. That means three things stay tied
 * together: the documented command, the flags it uses, and the sample under
 * `examples/compatibility-sample/` that reproduces the quoted line by running
 * the shipped CLI process against that folder.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HELP } from '../lib/cli.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const SAMPLE = path.join(ROOT, 'scripts', 'compatibility-sample.mjs');
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

test('the sample shows the same verdict in the JSON a CI reads', () => {
  const section = compatibilitySection();
  const block = fencedBlocks(section).find((entry) => entry.includes('$ node scripts/compatibility-sample.mjs --json'));
  assert.ok(block, 'the section does not show the machine-readable reproduction');
  const expected = commandOutput(block);
  const actual = execFileSync(
    process.execPath,
    [path.join('scripts', 'compatibility-sample.mjs'), '--json'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(actual, expected, 'the reproducible JSON no longer matches the README');

  const findings = JSON.parse(actual);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].target, 'L3n3L/dsh-resume');
  assert.equal(findings[0].host, '0.2.2-alpha.3');
  assert.equal(findings[0].compatibility, 'incompatible');
  assert.match(
    section,
    /not on `failures\.length` alone/u,
    'the section does not warn that the compatibility verdict is the finding',
  );
});

test('the sample answers for the host the reader runs, not only the canary', () => {
  const section = compatibilitySection();
  const block = fencedBlocks(section).find((entry) =>
    entry.includes('$ node scripts/compatibility-sample.mjs --host 0.1.5'),
  );
  assert.ok(block, 'the section does not show the sample answering for another host');
  const expected = commandOutput(block);
  const actual = execFileSync(process.execPath, [SAMPLE, '--host', '0.1.5'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(actual, expected, 'the documented host answer no longer matches the sample');
  assert.match(actual, /\[compatible with dsh 0\.1\.5/u);
  assert.match(actual, /^summary: 1 repository — 1 clean, 0 failing \(0 problems\)/mu);
});

test('an explicit host forwards the replayed command status', () => {
  const compatible = spawnSync(process.execPath, [SAMPLE, '--host', '0.1.5'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(compatible.status, 0, compatible.stderr);
  assert.match(compatible.stdout, /compatible with dsh 0\.1\.5/u);

  // The default wrapper exits 0 after proving the incompatible replay exited 1,
  // but an explicit host is a question a CI step can gate on, so its status is
  // the one the CLI answered with.
  const incompatible = spawnSync(process.execPath, [SAMPLE, '--host', '0.3.0'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(incompatible.status, 1, incompatible.stderr);
  assert.match(incompatible.stdout, /incompatible with dsh 0\.3\.0/u);

  // Naming the canary explicitly turns the demonstration into the same
  // question, so the wrapper must forward the CLI's 1 rather than the default
  // form's post-check 0.
  const explicitCanary = spawnSync(process.execPath, [SAMPLE, '--host', '0.2.2-alpha.3'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(explicitCanary.status, 1, explicitCanary.stderr);
});

test('an invalid --host reaches the CLI refusal and exits 2', () => {
  const result = spawnSync(process.execPath, [SAMPLE, '--host', 'banana'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--host needs a complete DSH version such as 0\.2\.2, got "banana"/u);
  assert.doesNotMatch(result.stdout, /clean|incompatible/u, 'a typo must not print a verdict');
});

test('the sample refuses an argument it does not understand', () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, [path.join('scripts', 'compatibility-sample.mjs'), '--jsn'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    (error) => error.status === 2 && /unknown argument --jsn/u.test(String(error.stderr)),
    'a typo should be a usage error, not a replay of the default form',
  );
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

test('the CLI parser accepts every documented compatibility flag, not just the help text', () => {
  const section = compatibilitySection();
  const documented = new Set([...section.matchAll(/(?<![\w-])--[a-z][a-z-]*/gu)].map((entry) => entry[0]));
  const values = new Map([
    ['--remote', 'demo/plugin'],
    ['--host', '0.2.2'],
    ['--from', 'repos.txt'],
    ['--jobs', '4'],
    ['--patch-dir', 'repairs'],
  ]);
  const argv = ['help'];
  for (const flag of documented) {
    argv.push(flag);
    // Every flag in this section takes a value except --json; a parser that
    // forgot one of the others would reject the invocation as an unknown flag
    // or consume the following token as that flag's value.
    if (values.has(flag) === true) argv.push(values.get(flag));
  }
  const result = spawnSync(process.execPath, [BIN, ...argv], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /unknown flag/u);
  assert.match(result.stdout, /^Flags$/mu, 'the parser did not reach --help');
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
