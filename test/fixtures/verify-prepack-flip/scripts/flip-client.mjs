import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const client = path.join(here, '..', 'client.js');

// The folder looks complete to `doctor`: the panel is committed and declared.
// The pack hook then flips it off, so the tarball npm builds has no `client.js`
// at all. `verify` has to notice that in the archive it installs, not trust the
// source tree it read before the hook ran. It never recreates the panel, so a
// second run on the same folder fails at the source check instead.
fs.rmSync(client, { force: true });
