/**
 * What assistive tech sees, asserted the same way the rest of the panel is.
 *
 * Run: node examples/aria.mjs
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

// expectAria names the attribute that differs, so a failure reads like a bug
// report instead of "expected true to equal false".
const live = panel.expectAria('[aria-live="polite"]', { live: 'polite', text: '0' });
console.log(`live region: ${live.live} -> "${live.text}"`);

const button = panel.expectAria('[aria-label]', { label: 'increment' });
console.log(`labelled control: ${button.label}`);

await panel.unmount();
