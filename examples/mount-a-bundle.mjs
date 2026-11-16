/**
 * The shortest useful thing testkit does: mount a real client bundle and read
 * what a user would see.
 *
 * Run: node examples/mount-a-bundle.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mountClient } from 'dsh-plugin-toolkit/testkit';

// Resolve the bundle from the package, not from the caller's cwd: the same
// command has to work in a checkout and in an installed package.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const panel = await mountClient({
  file: path.join(ROOT, 'fixtures/client-bundle/client.js'),
  resolveFrom: ROOT,
  copy: { demo: { title: 'Demo' } },
});

console.log(panel.text());

await panel.click('[data-testid="inc"]');
console.log(panel.text());

await panel.unmount();
