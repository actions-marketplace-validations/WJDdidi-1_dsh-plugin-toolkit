/**
 * A `node <path>` command printed in a shipped README is a promise about the
 * installed package. The READMEs are in `files`, but the paths they name are
 * not automatically packed: `scripts/preview.mjs` and the four
 * `examples/*.mjs` commands were documented while `files` left them out.
 *
 * The tarball gate reads the promise from the shipped READMEs instead of a
 * copy in the test, so a command added to a README and a path dropped from
 * `files` cannot drift apart between releases.
 */
import fs from 'node:fs';
import path from 'node:path';

import { isShipped } from './doctor.mjs';

// Both READMEs are in the published file list. A command documented only in
// the Chinese README is still a command an installed reader can try to run.
export const SHIPPED_READMES = ['README.md', 'README.zh.md'];

// Any relative JavaScript path a reader could run, not only the folders the
// README happens to use today. A later `node bin/...` or `node ./scripts/...`
// command must not slip past the gate because its directory or spelling was
// not on a list. `node --test` and `node -e "..."` are not file commands, and
// an optional quote keeps a path copied from a fenced or inline block intact.
export const RUN_COMMAND = /\bnode[ \t]+["'`]?((?:\.\/)?[A-Za-z0-9_@.][A-Za-z0-9._@/-]*\.(?:mjs|cjs|js))["'`]?(?![A-Za-z0-9_])/gu;

/** Normalize a captured command to the path npm would store in the tarball. */
function packageRelative(value) {
  // `path.posix` keeps the comparison platform-independent; npm tarball paths
  // always use forward slashes and never a leading `./`.
  const normalized = path.posix.normalize(value).replace(/^(?:\.\/)+/u, '');
  // A path outside the package root is not a claim about the tarball.
  if (normalized === '' || normalized === '.' || normalized.startsWith('../') || normalized.startsWith('/')) {
    return null;
  }
  return normalized;
}

/** Every distinct runnable path the shipped READMEs tell a reader to pass to node. */
export function documentedRunCommands(root, readmes = SHIPPED_READMES) {
  const found = new Map();
  for (const readme of readmes) {
    const file = path.join(root, readme);
    if (fs.existsSync(file) === false) continue;
    // A Windows checkout writes README.md with CRLF; the command is text, so
    // normalize before matching the line a reader copies.
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/gu, '\n');
    for (const match of text.matchAll(RUN_COMMAND)) {
      const command = packageRelative(match[1]);
      if (command !== null && found.has(command) === false) found.set(command, readme);
    }
  }
  return found;
}

/**
 * Documented paths that the given shipped-file list does not contain.
 *
 * Both `npm pack --dry-run --json` output and `package.json`'s `files` list
 * are accepted. The latter may use npm's folder, glob and negation entries, so
 * judging it as a set of exact strings would report a path missing even when
 * npm packs it (and miss a negated entry that drops it).
 */
export function missingRunCommands(documented, shipped) {
  return [...documented.keys()].filter((command) => isShipped(command, shipped) === false).sort();
}
