/**
 * Only the npm family needs care on Windows:
 *
 * - `npm`, `npx`, `yarn` and `pnpm` are `.cmd` shims, so the bare name is
 *   `ENOENT`;
 * - and since Node 18.20/20.12 a `.cmd` cannot be spawned without a shell
 *   (`EINVAL`, the fix for CVE-2024-27980).
 *
 * `git` and `gh` are real executables (`git.exe`, `gh.exe`) and must *not* get
 * a `.cmd` suffix — `git.cmd` does not exist.
 */
import { execFileSync } from 'node:child_process';

const SHIMS = new Set(['npm', 'npx', 'yarn', 'pnpm']);

export function command(name) {
  return process.platform === 'win32' && SHIMS.has(name) ? `${name}.cmd` : name;
}

function quote(argument) {
  const text = String(argument);
  return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

export function run(name, args, options = {}) {
  if (process.platform === 'win32' && SHIMS.has(name)) {
    return execFileSync(command(name), args.map(quote), { ...options, shell: true });
  }
  return execFileSync(name, args, options);
}

/**
 * The command's own answer, without the thrown command line, stack, or the
 * `Command failed:` prefix execFileSync puts in front of it.
 *
 * A failed step in a release is not a crash: the caller has to be able to name
 * the stage and quote the remote's reason. Prefer stderr (where git writes
 * `fatal:` / `remote:`), then stdout (where some wrappers put it), and only
 * fall back to the exception message. Keeping the first six non-empty lines
 * preserves the useful lines and drops blank lines and trailing advice.
 */
export function commandFailureDetail(error, maxLines = 6) {
  let text = '';
  for (const candidate of [error?.stderr, error?.stdout, error?.message]) {
    const value = String(candidate ?? '').trim();
    if (value !== '') {
      text = value;
      break;
    }
  }
  if (text === '') return 'the command exited with an error.';

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  // execFileSync's `.message` starts with the command it ran. Once there is a
  // following line, that first line is noise, not the command's reason.
  if (lines.length > 1 && /^Command failed:/u.test(lines[0]) === true) lines.shift();
  const detail = lines.slice(0, maxLines).join('; ');
  // Callers append their own sentence after this, so give every detail a
  // sentence ending instead of producing "rejected The tag ...".
  return /[.!?]$/u.test(detail) === true ? detail : `${detail}.`;
}
