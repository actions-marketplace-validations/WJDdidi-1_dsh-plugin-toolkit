/**
 * `dsh-plugin fix --engines` — write the host range `doctor` asks for.
 *
 * The hub reports installs that fail because a plugin has no `engines.dsh`,
 * and `doctor` can only name the missing field. This writes it. The write is
 * opt-in (`--write`) because editing a manifest is not a read-only check: the
 * author sees the exact range first and the command prints it before touching
 * anything.
 *
 * A range that already passes `checkHostRange` is left alone even when it is
 * not the default. `>=0.3.0` is a deliberate statement about the host APIs a
 * plugin uses, and lowering it to `>=0.2.0` would be a worse fix than none.
 * `--range` explicitly asks for a different range and may replace one.
 */
import fs from 'node:fs';
import path from 'node:path';

import { checkHostRange, hostRange } from './doctor.mjs';

/** The oldest host the toolkit itself supports, and the range `init` writes. */
export const DEFAULT_ENGINES = '>=0.2.0';

const normalize = (value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, '') : '');

/** The same rule `doctor` applies, so anything written here clears that check. */
export function isHostRange(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return checkHostRange({ engines: { dsh: value } }) === null;
}

function failure(check, message) {
  return { ok: false, failures: [{ check, message }] };
}

/** Keep the indentation and the final newline the manifest already had. */
function formatting(raw) {
  const indent = /^[\t ]+"/m.exec(raw);
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  return {
    indent: indent === null ? 2 : indent[0].slice(0, -1),
    eol,
    trailing: raw.endsWith('\n') ? eol : '',
  };
}

function render(manifest, raw) {
  const { indent, eol, trailing } = formatting(raw);
  let text = JSON.stringify(manifest, null, indent);
  if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  return `${text}${trailing}`;
}

/**
 * Inspect (and, with `write`, update) one plugin directory.
 *
 * Returns `{ ok, dir, manifestPath, before, after, range, changed, written,
 * reason }`. `reason` is `missing`, `not-a-range`, `different` (only with
 * `force`) or `already-correct`.
 */
export function fixEngines({ dir = '.', range = DEFAULT_ENGINES, write = false, force = false } = {}) {
  const target = path.resolve(dir);
  const manifestPath = path.join(target, 'package.json');
  if (fs.existsSync(manifestPath) === false) {
    return failure('manifest', `no package.json in ${target}`);
  }

  let raw;
  let manifest;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch (error) {
    return failure('manifest', `cannot read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) === true) {
    return failure('manifest', `${manifestPath} does not hold a JSON object`);
  }

  const proposed = typeof range === 'string' ? range.trim() : '';
  if (isHostRange(proposed) === false) {
    return failure('engines.dsh', `"${proposed}" is not a semver range, so it would not clear the doctor check`);
  }

  const current = hostRange(manifest);
  const correct = current !== null && checkHostRange(manifest) === null;
  const same = normalize(current) === normalize(proposed);
  if (correct === true && (force !== true || same === true)) {
    return {
      ok: true,
      dir: target,
      manifestPath,
      before: current,
      after: current,
      range: current,
      changed: false,
      written: false,
      reason: 'already-correct',
    };
  }

  const engines =
    manifest.engines !== null && typeof manifest.engines === 'object' && Array.isArray(manifest.engines) === false
      ? manifest.engines
      : {};
  const next = { ...manifest, engines: { ...engines, dsh: proposed } };
  const content = render(next, raw);

  let written = false;
  if (write === true) {
    fs.writeFileSync(manifestPath, content);
    written = true;
  }

  return {
    ok: true,
    dir: target,
    manifestPath,
    before: current,
    after: proposed,
    range: proposed,
    changed: true,
    written,
    reason: current === null ? 'missing' : correct === true ? 'different' : 'not-a-range',
  };
}
