/**
 * The market index is a list of versions with a host range per version.
 * Adding an entry is small; getting it right is what broke a release before —
 * a version object without `engines` makes the entry uninstallable, and the
 * validator only tells you after you have already opened the PR.
 */
import fs from 'node:fs';

import { parseStrictVersion } from './compat.mjs';
import { checkHostRange } from './doctor.mjs';
import { resolvePath } from './paths.mjs';

export function readIndex(file) {
  return JSON.parse(fs.readFileSync(resolvePath(file), 'utf8'));
}

export function findPlugin(index, name) {
  const plugins = Array.isArray(index.plugins) ? index.plugins : [];
  return plugins.find((entry) => entry.name === name) ?? null;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false;
}

/** True for a value the market index can use as a name or version. */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The index shape that has to be true before `auditVersions()` is meaningful.
 *
 * The command used to read `index.plugins ?? []` and audit each entry in
 * place. A plugin without `versions`, a `versions` string, or an entry with no
 * `version` either disappeared (the old code treated a non-array as an empty
 * list) or crashed on `plugin.name` and printed a raw TypeError. Every finding
 * names the plugin and, where one exists, the entry position or version, so a
 * CI log points at the JSON line to edit instead of at the command.
 */
export function validateIndex(index) {
  if (isRecord(index) === false) {
    return [{ entry: 'index', problem: 'the market index is not a JSON object' }];
  }
  if (Array.isArray(index.plugins) === false) {
    return [
      {
        entry: 'plugins',
        problem:
          index.plugins === undefined
            ? 'the market index has no "plugins" array'
            : '"plugins" is not an array; expected a list of plugin entries',
      },
    ];
  }

  const findings = [];
  index.plugins.forEach((plugin, pluginPosition) => {
    if (isRecord(plugin) === false) {
      findings.push({ entry: `plugins[${pluginPosition}]`, problem: 'the plugin entry is not an object' });
      return;
    }

    const name = nonEmptyString(plugin.name) ? plugin.name : `plugins[${pluginPosition}]`;
    if (nonEmptyString(plugin.name) === false) {
      findings.push({
        entry: name,
        problem:
          plugin.name === undefined
            ? 'the plugin entry has no "name"'
            : '"name" is not a non-empty string',
      });
    }

    if (Array.isArray(plugin.versions) === false) {
      findings.push({
        entry: name,
        problem:
          plugin.versions === undefined
            ? 'has no "versions" array; every plugin must list its published versions'
            : '"versions" is not an array; expected a list of version entries',
      });
      return;
    }

    plugin.versions.forEach((entry, entryPosition) => {
      const label = `${name} versions[${entryPosition}]`;
      if (isRecord(entry) === false) {
        findings.push({ entry: label, problem: 'the version entry is not an object' });
        return;
      }
      if (nonEmptyString(entry.version) === false) {
        findings.push({
          entry: label,
          problem:
            entry.version === undefined
              ? 'the version entry has no "version"'
              : '"version" is not a non-empty string',
        });
        return;
      }
      // The market index repeats the package's version, so it uses the same
      // strict SemVer parser `doctor` and `release` do. Build metadata is
      // valid SemVer and accepted; a range, a leading `v`, a partial version
      // or a malformed identifier is not.
      if (parseStrictVersion(entry.version) === null) {
        findings.push({
          entry: `${name}@${entry.version}`,
          problem: `version "${entry.version}" is not semver`,
        });
      }
    });
  });
  return findings;
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
