/**
 * Every plugin installed in a profile, checked in one pass.
 *
 * `doctor` answers "is this plugin correct?" for one folder you name. The
 * question that actually gets asked is "why is my plugin not in the sidebar?",
 * and the answer depends on three things a single folder cannot tell you: what
 * is installed, whether each installed copy is valid, and which of them the
 * running app actually loaded.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { doctor } from './doctor.mjs';
import { readGraph } from './dev.mjs';

const DEFAULT_HOME = path.join(os.homedir(), '.dsh');

/**
 * The loader mounts a package only when its name is in the profile's
 * `dsh.profile.bundles` list. `pnpm add` puts the package in `node_modules` but
 * does not edit that list, which is why "installed" and "mounted" are not the
 * same thing.
 */
export function readProfileBundles({ home = DEFAULT_HOME, profile } = {}) {
  const file = path.join(home, 'profiles', profile, 'package.json');
  if (fs.existsSync(file) === false) return { file, bundles: [] };
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bundles = manifest?.dsh?.profile?.bundles;
    return { file, bundles: Array.isArray(bundles) ? bundles : [] };
  } catch {
    // An unreadable profile is still a profile that did not list the plugin.
    return { file, bundles: [] };
  }
}

/**
 * Why the running app does not have this package, and what to do about it.
 * There are three different causes behind the same "not loaded" cell, and only
 * one of them is fixed by a restart.
 */
export function explainNotLoaded({ manifest, name, profileFile, bundles = [] } = {}) {
  if (manifest?.dsh?.bundle === undefined || manifest?.dsh?.bundle === null) {
    return {
      reason: 'package.json declares no dsh.bundle, so there is nothing for the loader to mount',
      action: 'add dsh.bundle.patch to package.json (and ship the patch file it names), then reinstall',
    };
  }
  if (bundles.includes(name) === false) {
    return {
      reason: `dsh.profile.bundles in ${profileFile} does not list it, and the loader mounts only listed bundles`,
      action: `add "${name}" to dsh.profile.bundles in ${profileFile} (or run \`dsh plugin add ${name}\`), then restart the app`,
    };
  }
  return {
    reason: 'it is listed in dsh.profile.bundles, but the running app started before it was installed',
    action: 'restart the app once to load it',
  };
}

/** Every package folder inside every profile, scoped names included. */
export function listInstalled({ home = DEFAULT_HOME } = {}) {
  const profiles = path.join(home, 'profiles');
  if (fs.existsSync(profiles) === false) return [];
  const found = [];
  for (const profile of fs.readdirSync(profiles).sort()) {
    const modules = path.join(profiles, profile, 'node_modules');
    if (fs.existsSync(modules) === false) continue;
    for (const entry of fs.readdirSync(modules).sort()) {
      if (entry.startsWith('.') === true) continue;
      const candidates = entry.startsWith('@')
        ? fs.readdirSync(path.join(modules, entry)).sort().map((name) => path.join(modules, entry, name))
        : [path.join(modules, entry)];
      for (const dir of candidates) {
        const manifestPath = path.join(dir, 'package.json');
        if (fs.existsSync(manifestPath) === false) continue;
        let manifest;
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch {
          // A package.json that does not parse is still an installed plugin, and
          // "it does not parse" is exactly what the author needs to hear.
          manifest = { name: path.basename(dir) };
        }
        // Only packages that declare themselves as plugins. node_modules is full
        // of ordinary dependencies, and auditing those is noise.
        if (manifest.dsh === undefined) continue;
        found.push({ dir, manifest, profile });
      }
    }
  }
  return found;
}

/**
 * `engines.dsh` and the README Requirements section are what the market index
 * needs. The loader does not read either, so a plugin without them still loads —
 * calling that "a problem" would bury the plugins that are actually broken.
 */
const ADVISORY = new Set(['engines.dsh', 'readme']);

function split(failures) {
  return {
    hard: failures.filter((failure) => ADVISORY.has(failure.check) === false),
    advisory: failures.filter((failure) => ADVISORY.has(failure.check) === true),
  };
}

function describe({ hard, advisory }) {
  if (hard.length === 0 && advisory.length === 0) return 'ok';
  const parts = [];
  if (hard.length > 0) parts.push(`${hard.length} problem${hard.length === 1 ? '' : 's'}: ${hard[0].check}`);
  if (advisory.length > 0) parts.push(`${advisory.length} advisor${advisory.length === 1 ? 'y' : 'ies'}`);
  return parts.join(', ');
}

export async function audit({ home, host, io = console, fetchImpl, timeoutMs = 3000 } = {}) {
  const installed = listInstalled({ home });
  if (installed.length === 0) {
    io.log('no plugins installed in any profile (a plugin declares a "dsh" field)');
    return { ok: true, plugins: [], graph: null };
  }

  let graph = null;
  if (typeof host === 'string' && host.length > 0) {
    graph = await readGraph({ host, timeoutMs, fetchImpl });
    if (graph.ok !== true) io.log(`could not read the plugin graph: ${graph.reason}`);
  }

  const profileFiles = new Map();
  const rows = installed.map(({ dir, manifest, profile }) => {
    let failures;
    try {
      ({ failures } = doctor(dir, { installed: true }));
    } catch (error) {
      failures = [{ check: 'manifest', message: error.message }];
    }
    const loaded = graph?.ok === true ? graph.ids.has(manifest.name) : null;
    let explanation = null;
    if (loaded === false) {
      if (profileFiles.has(profile) === false) {
        profileFiles.set(profile, readProfileBundles({ home, profile }));
      }
      const listed = profileFiles.get(profile);
      explanation = explainNotLoaded({
        manifest,
        name: manifest.name,
        profileFile: listed.file,
        bundles: listed.bundles,
      });
    }
    return {
      name: manifest.name,
      version: manifest.version ?? '?',
      profile,
      dir,
      failures,
      ...split(failures),
      loaded,
      reason: explanation?.reason ?? null,
      action: explanation?.action ?? null,
    };
  });

  const width = Math.max(...rows.map((row) => row.name.length), 6);
  const detailIndent = ' '.repeat(width + 24);
  for (const row of rows) {
    const state = row.loaded === null ? '?' : row.loaded === true ? 'loaded' : 'not loaded';
    const reason = row.loaded === false ? `  — ${row.reason}` : '';
    io.log(`${row.name.padEnd(width)}  ${String(row.version).padEnd(8)}  ${state.padEnd(10)}  ${describe(row)}${reason}`);
    for (const failure of row.failures) io.log(`${' '.repeat(width + 22)}${failure.check}: ${failure.message}`);
    if (row.loaded === false) io.log(`${detailIndent}fix: ${row.action}`);
  }

  const failed = rows.filter((row) => row.hard.length > 0);
  const advised = rows.filter((row) => row.hard.length === 0 && row.advisory.length > 0);
  const notLoaded = rows.filter((row) => row.loaded === false);
  if (notLoaded.length > 0) {
    io.log('');
    io.log(`${notLoaded.length} installed plugin(s) are not in the running app:`);
  }
  if (advised.length > 0) {
    io.log('');
    io.log(`${advised.length} plugin(s) load but are not ready for the market index (engines.dsh, README Requirements).`);
  }
  if (failed.length > 0) {
    io.log('');
    io.log(`${failed.length} of ${rows.length} installed plugin(s) have problems.`);
  }
  // A plugin the running app never loaded is the failure this command exists to
  // catch. When no graph was read, `loaded` is null for every row, so this only
  // holds the audit to what it actually observed.
  return { ok: failed.length === 0 && notLoaded.length === 0, plugins: rows, graph };
}
