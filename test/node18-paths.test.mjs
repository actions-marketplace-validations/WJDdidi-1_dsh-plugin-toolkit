/**
 * `engines.node` says 18, so every file the package ships has to run there.
 * `import.meta.dirname` and `import.meta.filename` were added in Node 20.11 /
 * 21.2; on Node 18 they are `undefined`, and `path.resolve(undefined, '..')`
 * throws before the command does any work.
 *
 * `scripts/preview.mjs` used `import.meta.dirname`, so the README's preview
 * command failed on the oldest Node the manifest promises to support. This
 * guard covers every source folder that ships and the two root modules, so the
 * next file cannot bring the unsupported property back one at a time.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRECTORIES = ['bin', 'examples', 'lib', 'scripts'];
const ROOT_MODULES = ['client.js', 'index.js'];
const MODERN_META = /\bimport\.meta\.(?:dirname|filename)\b/u;

function javascriptBelow(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...javascriptBelow(file));
    else if (/\.(?:cjs|js|mjs)$/u.test(entry.name)) found.push(file);
  }
  return found;
}

function shippedSource() {
  return [
    ...SOURCE_DIRECTORIES.flatMap((directory) => javascriptBelow(path.join(ROOT, directory))),
    ...ROOT_MODULES.map((file) => path.join(ROOT, file)),
  ];
}

/** Drop comments, so a file that merely explains the Node 20 property is not an offender. */
function executableText(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
}

test('shipped source avoids import.meta paths that Node 18 does not have', () => {
  const offenders = shippedSource()
    .filter((file) => MODERN_META.test(executableText(fs.readFileSync(file, 'utf8'))))
    .map((file) => path.relative(ROOT, file).split(path.sep).join('/'));

  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(', ')} use import.meta.dirname/filename (Node 20.11+), but package.json\n` +
      'declares engines.node >=18. Use path.dirname(fileURLToPath(import.meta.url)) instead.',
  );
});
