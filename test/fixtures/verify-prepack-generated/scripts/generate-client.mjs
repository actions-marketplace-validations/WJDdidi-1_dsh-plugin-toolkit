import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const client = path.join(here, '..', 'client.js');

// The panel is generated, not committed: the source tree has no client.js
// until this file runs. `npm pack` runs prepack, so the tarball has it.
fs.writeFileSync(client, `window.__ModuleLoader__.load({
  id: 'verify-prepack-generated',
  factory: () => ({
    inject: [],
    apply() {},
  }),
});
`);
