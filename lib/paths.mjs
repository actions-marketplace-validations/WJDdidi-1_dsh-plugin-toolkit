/**
 * User-supplied paths, before they reach the filesystem.
 *
 * A POSIX shell expands `~/my-panel` before the program starts. `cmd` and
 * PowerShell do not: they hand the literal string to the program, so
 * `path.resolve('~/my-panel')` quietly creates a directory literally named `~`
 * in the current working directory. Every command that accepts a folder or a
 * file from a person has to expand the tilde itself, or the documented example
 * writes somewhere surprising on Windows.
 */
import os from 'node:os';
import path from 'node:path';

/**
 * Expand a leading `~` the way a POSIX shell would.
 *
 * `~\x` is the Windows spelling of a child path, so both separators are
 * treated as separators here; `path.join` then uses the host one. `~someone`
 * is a different user, not this home directory, and is left alone.
 */
export function expandHome(value, home = os.homedir()) {
  const text = String(value ?? '').trim();
  if (text === '' || /^~($|[\\/])/u.test(text) === false) {
    return text;
  }
  const rest = text.slice(1).replace(/^[\\/]+/u, '').split(/[\\/]+/u).join('/');
  return path.join(home, rest);
}

/**
 * Expand a leading `~` and make the result absolute against the current
 * working directory. This is the one step every filesystem-facing command
 * applies to a user-named path, so `init`, `doctor`, `fix`, `verify`, `dev`,
 * `release` and the audit flags all resolve the same way.
 */
export function resolvePath(value, { home = os.homedir(), cwd = process.cwd() } = {}) {
  return path.resolve(cwd, expandHome(value, home));
}
