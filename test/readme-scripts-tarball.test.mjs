/**
 * A command a shipped README tells a reader to run has to exist in the tarball
 * that reader installs. `scripts/preview.mjs` was documented but absent from
 * 0.20.12's `files` list, so `node scripts/preview.mjs` worked in a checkout
 * and failed with `MODULE_NOT_FOUND` in an installed copy.
 *
 * This gate reads the commands from the READMEs npm actually ships instead of
 * a copy in the test, then compares them with `npm pack --dry-run --json`. A
 * future `files` edit that drops a documented script fails here and names the
 * path before publication.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/exec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Both READMEs are in the published file list. A command documented only in the
// Chinese README is still a command an installed reader can try to run.
const SHIPPED_READMES = ['README.md', 'README.zh.md'];
const SCRIPT_COMMAND = /\bnode\s+(scripts\/[A-Za-z0-9._/-]+\.mjs)\b/gu;

/** Every distinct `scripts/<name>.mjs` the READMEs tell a reader to pass to node. */
function documentedScripts() {
  const found = new Map();
  for (const readme of SHIPPED_READMES) {
    const file = path.join(ROOT, readme);
    if (fs.existsSync(file) === false) continue;
    // A Windows checkout writes README.md with CRLF; the command is text, so
    // normalize before matching the line a reader copies.
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/gu, '\n');
    for (const match of text.matchAll(SCRIPT_COMMAND)) {
      if (found.has(match[1]) === false) found.set(match[1], readme);
    }
  }
  return found;
}

/** The paths `npm pack` would put in the published tarball. */
function packedFiles() {
  const [document] = JSON.parse(run('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  return document.files.map((entry) => entry.path);
}

/** Documented paths that the packed file list does not contain. */
function missingScripts(documented, shipped) {
  const files = new Set(shipped);
  return [...documented.keys()].filter((script) => files.has(script) === false);
}

test('every script a shipped README tells a reader to run is in the tarball', () => {
  const documented = documentedScripts();
  assert.ok(
    documented.size > 0,
    `neither ${SHIPPED_READMES.join(' nor ')} names a \`node scripts/<name>.mjs\` command; the gate would pass without checking anything`,
  );

  const packed = packedFiles();
  assert.ok(packed.includes('README.md'), '`npm pack --dry-run --json` no longer lists README.md');

  const missing = missingScripts(documented, packed);
  assert.deepEqual(
    missing,
    [],
    `\`npm pack --dry-run --json\` omits documented script(s):\n${missing
      .map((script) => `  ${script} (named in ${documented.get(script)})`)
      .join('\n')}\nAdd each path to package.json's "files" list, or stop documenting it as an installed command.`,
  );
});

test('the gate names the script 0.20.12 left out of its file list', () => {
  // 0.20.12 listed the benchmark and compatibility scripts but not preview.
  // Keeping the old file list as a control proves the comparison fails with the
  // missing path, not merely that today's list happens to be complete.
  const shippedIn02012 = new Set([
    'README.md',
    'scripts/benchmark-audit.mjs',
    'scripts/compatibility-sample.mjs',
  ]);
  const documented = new Map([
    ['scripts/benchmark-audit.mjs', 'README.md'],
    ['scripts/compatibility-sample.mjs', 'README.md'],
    ['scripts/preview.mjs', 'README.md'],
  ]);

  assert.deepEqual(missingScripts(documented, shippedIn02012), ['scripts/preview.mjs']);
});
