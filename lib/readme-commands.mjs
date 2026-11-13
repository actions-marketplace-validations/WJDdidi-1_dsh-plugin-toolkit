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

// Both READMEs are in the published file list. A command documented only in
// the Chinese README is still a command an installed reader can try to run.
export const SHIPPED_READMES = ['README.md', 'README.zh.md'];

// Examples may live below a folder (examples/compatibility-sample/...); keep
// the capture broad enough for a nested path but restricted to the two
// directories the toolkit actually documents as runnable commands.
export const RUN_COMMAND = /\bnode\s+((?:scripts|examples)\/[A-Za-z0-9._/-]+\.mjs)\b/gu;

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
      if (found.has(match[1]) === false) found.set(match[1], readme);
    }
  }
  return found;
}

/** Documented paths that the given shipped-file list does not contain. */
export function missingRunCommands(documented, shipped) {
  const files = new Set(shipped);
  return [...documented.keys()].filter((command) => files.has(command) === false).sort();
}
