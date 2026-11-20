import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const marker = path.join(root, '.prepack-invocations');
const client = path.join(root, 'client.js');

// A build hook that only works once. The first invocation writes the panel;
// every later invocation removes it, so the dry run and the tarball npm packs
// next disagree about whether `client.js` ships.
const invocations = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) || 0 : 0;
fs.writeFileSync(marker, `${invocations + 1}\n`);

if (invocations === 0) {
  // The panel has to be mountable: the CLI regression runs both `verify` and
  // `verify --no-mount` on a fresh copy, and the full command must reach the
  // mount stage on the run whose tarball carries this file. Registering a slot
  // also keeps the bare-boot probe happy: `ctx.slots` is absent there.
  fs.writeFileSync(client, `window.__ModuleLoader__.load({
  id: 'verify-prepack-non-idempotent',
  factory: () => ({
    inject: ['slots'],
    apply(ctx) {
      if (!ctx.slots) return;
      ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: 'verify-prepack-non-idempotent' },
        () => null,
      );
    },
  }),
});
`);
} else {
  fs.rmSync(client, { force: true });
}
