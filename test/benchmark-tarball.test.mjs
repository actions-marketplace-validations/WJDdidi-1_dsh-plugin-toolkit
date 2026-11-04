/**
 * The README tells readers to run `npm run benchmark`, so that command has to
 * work in the copy a reader actually installs. `files` used to omit both the
 * script and the list it reads, which only showed up after `npm pack`.
 *
 * The command comes from the README rather than a copy in this test: if the
 * "Measured throughput" section stops citing a command the manifest has, the
 * failure happens here instead of in a reader's temp directory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_JOBS } from '../lib/audit.mjs';
import { BENCHMARK_LIMIT, BENCHMARK_LIST } from '../lib/benchmark.mjs';
import { run } from '../lib/exec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function throughputSection() {
  // A Windows checkout writes README.md with CRLF, so normalize before matching
  // the fenced shell block; otherwise the heading exists but `\n` never follows.
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/gu, '\n');
  const section = /^### Measured throughput\n([\s\S]*?)(?=^### |^## )/mu.exec(readme);
  assert.ok(section, 'README has no "### Measured throughput" section');
  return section[1];
}

function relativeToRoot(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

test('the installed tarball runs the benchmark the README cites', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const section = throughputSection();
  const documented = /^\$ (npm run ([a-z][\w:-]*))$/mu.exec(section);
  assert.ok(documented, 'the Measured throughput section no longer shows an `npm run ...` command');
  const [, documentedCommand, scriptName] = documented;
  assert.equal(scriptName, 'benchmark', `the Measured throughput section documents \`${documentedCommand}\`, not \`npm run benchmark\``);

  const direct = /`node (scripts\/benchmark-audit\.mjs)`/u.exec(section);
  assert.ok(direct, 'the Measured throughput section no longer names the script npm runs directly');
  const scriptPath = direct[1];
  assert.equal(
    manifest.scripts?.[scriptName],
    `node ${scriptPath}`,
    `package.json runs \`${manifest.scripts?.[scriptName]}\`, but the README names \`node ${scriptPath}\``,
  );
  const listPath = relativeToRoot(BENCHMARK_LIST);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-benchmark-tarball-'));
  try {
    const packed = JSON.parse(run('npm', ['pack', '--pack-destination', scratch, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const [document] = packed;
    const shipped = new Set(document.files.map((entry) => entry.path));
    assert.ok(shipped.has(scriptPath), `the tarball does not ship ${scriptPath}, so \`${documentedCommand}\` cannot run`);
    assert.ok(shipped.has(listPath), `the tarball does not ship ${listPath}, the list the benchmark reads`);

    const prefix = path.join(scratch, 'install');
    // `--omit=peer` keeps the guard offline: the benchmark only needs lib/, and
    // installing the optional peers would make the test depend on the registry.
    run('npm', ['install', path.join(scratch, document.filename), '--prefix', prefix, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=peer'], {
      cwd: scratch,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const installed = path.join(prefix, 'node_modules', 'dsh-plugin-toolkit');
    const output = run('npm', ['run', scriptName], {
      cwd: installed,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.ok(
      output.includes(`benchmark: ${BENCHMARK_LIMIT} repositories from ${listPath}`),
      `\`${documentedCommand}\` in the installed tarball did not read ${listPath}:\n${output}`,
    );
    assert.match(output, new RegExp(`after\\s+--jobs ${DEFAULT_JOBS}\\b`, 'u'));
    assert.doesNotMatch(output, /MODULE_NOT_FOUND|ENOENT/u);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
