/**
 * A panel that talks to its host: answer the routes it asks for, then assert on
 * what it did — including the requests themselves.
 *
 * Run: node examples/route-stubs.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFetch, mountClient } from 'dsh-plugin-toolkit/testkit';

// Resolve the bundle from the package, not from the caller's cwd: the same
// command has to work in a checkout and in an installed package.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = createFetch({
  '/demo/report': { body: { score: 71 } },
  '/demo/apply': () => ({ status: 201, body: { score: 92 } }),
});

const panel = await mountClient({
  file: path.join(ROOT, 'fixtures/fetching-bundle/client.js'),
  resolveFrom: ROOT,
  fetch: stub,
});

console.log(panel.text());
console.log(`asked for: ${stub.calls('/demo/report').length} route(s), undeclared route answers ${(await stub('/demo/nothing')).status}`);

await panel.unmount();
