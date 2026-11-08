/**
 * The market index is a list of versions with a host range per version.
 * Adding an entry is small; getting it right is what broke a release before —
 * a version object without `engines` makes the entry uninstallable, and the
 * validator only tells you after you have already opened the PR.
 */
import fs from 'node:fs';

import { checkHostRange } from './doctor.mjs';
import { resolvePath } from './paths.mjs';

export function readIndex(file) {
  return JSON.parse(fs.readFileSync(resolvePath(file), 'utf8'));
}

export function findPlugin(index, name) {
  const plugins = Array.isArray(index.plugins) ? index.plugins : [];
  return plugins.find((entry) => entry.name === name) ?? null;
}

/** The version objects the validator understands, newest first. */
export function buildEntry({ version, publishTimestamp, hostRange }) {
  const entry = {
    version,
    publishTimestamp,
    source: { type: 'npm' },
  };
  if (hostRange !== null && hostRange !== undefined) {
    // The index repeats a value the market validator has to parse. Writing an
    // entry that `doctor` would reject only moves the failure to the PR, after
    // the tag is already public.
    const problem = checkHostRange({ engines: { dsh: hostRange } });
    if (problem !== null) throw new Error(problem);
    entry.engines = { dsh: hostRange };
  }
  return entry;
}

export function addVersion(index, name, entry) {
  const plugin = findPlugin(index, name);
  if (plugin === null) {
    throw new Error(`the index has no plugin called "${name}"`);
  }
  const problem =
    entry === null || typeof entry !== 'object' ? 'the version entry is not an object' : checkHostRange(entry);
  if (problem !== null) {
    throw new Error(`${name}@${entry?.version ?? '?'}: ${problem}`);
  }
  const versions = Array.isArray(plugin.versions) ? plugin.versions : [];
  const existing = versions.find((candidate) => candidate.version === entry.version);
  if (existing !== undefined) {
    // Re-running a release after a failure is normal, so the same version with
    // the same publish time is a no-op; a different timestamp means the index
    // and the registry disagree, and that is worth stopping for.
    if (existing.publishTimestamp === entry.publishTimestamp) return index;
    throw new Error(
      `${name}@${entry.version} is already in the index with publishTimestamp ${existing.publishTimestamp}, not ${entry.publishTimestamp}`,
    );
  }
  return {
    ...index,
    plugins: index.plugins.map((candidate) => {
      if (candidate.name !== name) return candidate;
      return { ...candidate, versions: [entry, ...versions] };
    }),
  };
}

/** Every version must carry the host range, not just the newest one. */
export function auditVersions(index, name) {
  const plugin = findPlugin(index, name);
  if (plugin === null) return [{ problem: `no plugin called "${name}"` }];
  const versions = Array.isArray(plugin.versions) ? plugin.versions : [];
  return versions.flatMap((entry) => {
    const range = typeof entry?.engines?.dsh === 'string' ? entry.engines.dsh.trim() : '';
    if (range === '') return [{ version: entry?.version, problem: 'no engines.dsh' }];
    // The same rule `doctor` applies to package.json: a present but malformed
    // value, or a pin, is not a range the market index can repeat.
    const problem = checkHostRange({ engines: { dsh: range } });
    return problem === null ? [] : [{ version: entry.version, problem }];
  });
}

export function writeIndex(file, index) {
  fs.writeFileSync(resolvePath(file), `${JSON.stringify(index, null, 2)}\n`);
}
