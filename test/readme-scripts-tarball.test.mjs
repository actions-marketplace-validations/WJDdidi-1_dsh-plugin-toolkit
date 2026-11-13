/**
 * A command a shipped README tells a reader to run has to exist in the tarball
 * that reader installs. Two releases shipped documented commands without the
 * files: `scripts/preview.mjs` was absent from 0.20.12's `files` list, and the
 * four `examples/*.mjs` commands were absent until 0.20.28.
 *
 * This gate reads the commands from the READMEs npm actually ships instead of
 * a copy in the test, then compares them with `npm pack --dry-run --json`. It
 * covers both `scripts/*.mjs` and `examples/*.mjs`; a future `files` edit that
 * drops a documented path fails here and names the path before publication.
 * The 0.20.12 file list is replayed as a control, so the gate is shown to fail
 * on the exact paths that release left out.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/exec.mjs';
import { documentedRunCommands, missingRunCommands } from '../lib/readme-commands.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The paths `npm pack` would put in the published tarball. */
function packedFiles() {
  const [document] = JSON.parse(run('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  return document.files.map((entry) => entry.path);
}

/** The published `files` list, which is the input npm turns into a tarball. */
function manifestFiles() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files;
}

test('every script and example a shipped README tells a reader to run is in the tarball', () => {
  const documented = documentedRunCommands(ROOT);
  const scripts = [...documented.keys()].filter((command) => command.startsWith('scripts/'));
  const examples = [...documented.keys()].filter((command) => command.startsWith('examples/'));

  assert.ok(
    scripts.length > 0,
    'no shipped README names a `node scripts/<name>.mjs` command; the gate would pass without checking the scripts',
  );
  assert.ok(
    examples.length > 0,
    'no shipped README names a `node examples/<name>.mjs` command; the gate would pass without checking the examples',
  );

  const packed = packedFiles();
  assert.ok(packed.includes('README.md'), '`npm pack --dry-run --json` no longer lists README.md');

  const missing = missingRunCommands(documented, packed);
  assert.deepEqual(
    missing,
    [],
    `\`npm pack --dry-run --json\` omits documented command(s):\n${missing
      .map((command) => `  ${command} (named in ${documented.get(command)})`)
      .join('\n')}\nAdd each path to package.json's "files" list, or stop documenting it as an installed command.`,
  );
});

test('the gate names the paths 0.20.12 left out of its file list', () => {
  // 0.20.12 listed the benchmark and compatibility scripts but not preview,
  // and shipped only examples/compatibility-sample/ rather than the four
  // runnable examples. Replaying that file list proves the comparison fails
  // with the missing paths, not merely that today's list happens to be complete.
  const shippedIn02012 = [
    'bin/',
    'lib/',
    'index.js',
    'client.js',
    'cordis.patch.yml',
    'README.md',
    'README.zh.md',
    'LICENSE',
    'CHANGELOG.md',
    'docs/badge.svg',
    'docs/card.png',
    'docs/ecosystem-audit-2026-11-03.txt',
    'scripts/benchmark-audit.mjs',
    'scripts/compatibility-sample.mjs',
    'examples/compatibility-sample/',
  ];
  const documented = documentedRunCommands(ROOT);

  assert.deepEqual(
    missingRunCommands(documented, shippedIn02012),
    [
      'examples/aria.mjs',
      'examples/baseline.mjs',
      'examples/mount-a-bundle.mjs',
      'examples/route-stubs.mjs',
      'scripts/preview.mjs',
    ],
    'the 0.20.12 replay has to name every documented path that release left out',
  );

  // Replaying the fixed list, not only the packer, keeps the acceptance case
  // explicit: the current `files` list resolves all documented commands.
  assert.deepEqual(
    missingRunCommands(documented, manifestFiles()),
    [],
    'the current package.json files list omits a command a shipped README tells a reader to run',
  );
});
