/**
 * A DOM baseline: normalised markup in a file, compared on every run.
 *
 * Run: node examples/baseline.mjs
 * First run writes nothing; re-run with UPDATE_SNAPSHOTS=1 to create the file.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectSnapshot, mountClient } from 'dsh-plugin-toolkit/testkit';

// Resolve the bundle and its baseline from the package, not from the caller's
// cwd: the same command has to work in a checkout and in an installed package.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const panel = await mountClient({
  file: path.join(ROOT, 'fixtures/client-bundle/client.js'),
  resolveFrom: ROOT,
  copy: { demo: { title: 'Demo' } },
});

const result = expectSnapshot(
  panel.html(),
  path.join(ROOT, 'fixtures/client-bundle/__snapshots__'),
  'panel',
);
console.log(`baseline: ${result.status}`);

await panel.unmount();
