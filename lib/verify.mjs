/**
 * `doctor` reads the repository. Users install the tarball.
 *
 * `verify` closes that gap: pack it, install the tarball into a throwaway
 * directory, then mount the bundle *from the installed copy*. The failures this
 * catches — a `files` list that omits the entry, a patch file that is not
 * shipped, a bundle that only works next to its source — are the ones the
 * working copy cannot prove.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { doctor, declaredPaths, missingDeclaredPaths, rootEntry } from './doctor.mjs';
import { resolveEntry } from './dev.mjs';
import { resolvePath } from './paths.mjs';
import { run } from './exec.mjs';

function packJson(dir) {
  const output = run('npm', ['pack', '--json', '--dry-run'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [document] = JSON.parse(output);
  return { files: (document.files ?? []).map((entry) => entry.path), filename: document.filename, size: document.size };
}

function packTarball(dir, destination) {
  const output = run('npm', ['pack', '--pack-destination', destination, '--json'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [document] = JSON.parse(output);
  return path.join(destination, document.filename);
}

/**
 * What cordis hands a plugin that declares no `inject`: every undeclared
 * property read throws. A plain `{}` hides the bug this is looking for.
 */
// cordis itself is present on every context — `ctx.inject`, `ctx.on`,
// `ctx.effect` and the logger. What can be absent is the *services*.
function cordisApi() {
  const noop = () => () => {};
  const base = {
    inject: (list, callback) => {
      // A declared service may still be absent when apply runs: record nothing,
      // call nothing. That is exactly what the host does before a service mounts.
      void list;
      void callback;
      return () => {};
    },
    on: noop,
    effect: noop,
    logger: () => {},
    get: () => undefined,
    set: () => {},
    provide: noop,
    reflect: { get: () => undefined, set: () => {}, provide: noop },
  };
  return base;
}

/** A context whose services have not mounted yet; reading one gives undefined. */
function absentContext() {
  return cordisApi();
}

/** A context that also enforces cordis's rule: an undeclared read throws. */
function undeclaredContext() {
  const base = cordisApi();
  return new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === 'symbol') return undefined;
      throw new Error(`cannot get property "${String(key)}" without inject`);
    },
  });
}

/**
 * A rejected `apply()` is not required to reject with an Error. Reading
 * `.message` off a string (or `null`) either reports `undefined` or throws a
 * second TypeError inside the handler, which hides the plugin's own reason.
 */
function failureText(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * A declared path can be a pattern: `exports["./locale/*.json"]` names a folder
 * of files, and `npm pack` lists the files it actually shipped. Exact set
 * membership would report a correctly packed plugin as broken — which it did,
 * on this repository's own neighbour.
 */
function shipsPath(shipped, target) {
  if (target.includes('*') === false) return shipped.has(target);
  const [head, tail] = target.split('*');
  const suffix = tail ?? '';
  for (const file of shipped) {
    if (file.startsWith(head) === true && file.endsWith(suffix) === true) return true;
  }
  return false;
}

/**
 * `doctor`'s files-list check reads the manifest. When the bundle patch is the
 * path it says the tarball would omit, verify should confirm that against npm's
 * own file list instead: the pack stage names the missing patch rather than
 * stopping on the manifest alone. Any other manifest failure still stops first.
 */
function defersPatchToPack(report) {
  const patch = report.manifest.dsh?.bundle?.patch;
  if (typeof patch !== 'string') return false;
  const target = patch.replace(/^\.\//u, '');
  if (target === '' || target === '.') return false;
  return (
    report.failures.length > 0 &&
    report.failures.every((failure) => failure.check === 'files list') &&
    missingDeclaredPaths(report.manifest).includes(target)
  );
}

export async function verify({ dir, mount = true }) {
  const root = resolvePath(dir);
  const report = doctor(root);
  if (report.failures.length > 0 && defersPatchToPack(report) === false) {
    return { ok: false, stage: 'doctor', failures: report.failures, files: [] };
  }
  const failures = [];

  let packed;
  try {
    packed = packJson(root);
  } catch (error) {
    return {
      ok: false,
      stage: 'pack',
      failures: [{ check: 'pack', message: `npm pack failed: ${String(error.stderr ?? error.message).trim().split('\n').slice(-1)[0]}` }],
      files: [],
    };
  }

  // Everything package.json points at has to be inside the tarball, or the
  // installed plugin is missing its own code.
  const shipped = new Set(packed.files);
  for (const target of declaredPaths(report.manifest)) {
    if (shipsPath(shipped, target) === false) {
      failures.push({
        check: 'pack',
        message: `the tarball does not contain ${target}, so the installed plugin would be missing it`,
      });
    }
  }
  // The client bundle is usually found by convention (`client.js`), so it is
  // not in `declaredPaths` — but it still has to be in the tarball.
  const repoEntry = resolveEntry(root, report.manifest);
  if (repoEntry !== null) {
    const relative = path.relative(root, repoEntry).split(path.sep).join('/');
    if (shipsPath(shipped, relative) === false) {
      failures.push({
        check: 'pack',
        message: `the tarball does not contain ${relative}, so the installed plugin has no panel`,
      });
    }
  }

  if (failures.length > 0) return { ok: false, stage: 'pack', failures, files: packed.files };

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-verify-'));
  try {
    return await inspectScratch({ dir: root, mount, report, packed, scratch });
  } finally {
    // Verify runs repeatedly in CI; leaving a full install tree behind each
    // time fills the runner's disk. Remove it whether the run passed or failed.
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Import the installed package exactly as the loader does: `import(name)` from
 * a module that sits beside the installed copy. Resolving the bare specifier
 * here, rather than reading `main` or `exports["."]` ourselves, means Node's
 * own rules decide whether the root is importable. That is what catches an
 * `exports` map with no `.` entry: Node ignores `main` once `exports` exists,
 * so the bare import fails with ERR_PACKAGE_PATH_NOT_EXPORTED while the file
 * `main` names is still present.
 */
async function importInstalledRoot(name, scratch) {
  const { pathToFileURL } = await import('node:url');
  const probe = path.join(scratch, 'install', 'verify-root.mjs');
  fs.writeFileSync(probe, `export default await import(${JSON.stringify(name)});\n`);
  const loaded = await import(pathToFileURL(probe).href);
  return loaded.default;
}

/**
 * The part of `verify` that needs the installed copy. It runs inside the
 * scratch directory's try/finally, so every stage here is cleaned up whether
 * it succeeds or fails.
 */
async function inspectScratch({ dir, mount, report, packed, scratch }) {
  let installed;
  try {
    const tarball = packTarball(dir, scratch);
    run('npm', ['install', tarball, '--prefix', path.join(scratch, 'install'), '--no-save', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: scratch,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    installed = path.join(scratch, 'install', 'node_modules', report.manifest.name);
  } catch (error) {
    return {
      ok: false,
      stage: 'install',
      failures: [{ check: 'install', message: `installing the tarball failed: ${String(error.stderr ?? error.message).trim().split('\n').slice(-1)[0]}` }],
      files: packed.files,
    };
  }

  if (fs.existsSync(installed) === false) {
    return {
      ok: false,
      stage: 'install',
      failures: [{ check: 'install', message: `the tarball installed no package at ${report.manifest.name}` }],
      files: packed.files,
    };
  }

  // The loader starts the host half by importing the bare package name. Doing
  // the same import here is the only way to know the row will have an apply —
  // 0.8.0 shipped a package whose root export was the CLI, installed cleanly,
  // and mounted nothing.
  //
  // Importing the file `main` names would be a different question. Node ignores
  // `main` as soon as a package has an `exports` map, so a map with no `.` entry
  // fails `import(name)` with ERR_PACKAGE_PATH_NOT_EXPORTED even when `main`
  // points at a working module. The probe module below lives beside the
  // installed package, so the bare specifier is resolved by the same algorithm
  // the loader uses, not by the toolkit's own location.
  const rootFile = rootEntry(report.manifest);
  const declaredRoot =
    (report.manifest.exports !== undefined && report.manifest.exports !== null) ||
    typeof report.manifest.main === 'string';
  let hostFace = null;
  // A bundle that inserts a subpath plugin and declares no root at all needs no
  // root module, so there is nothing to import. The success line must not claim
  // it imported a host half that was skipped.
  let hostImported = false;
  if (declaredRoot === true) {
    let loaded;
    try {
      loaded = await importInstalledRoot(report.manifest.name, scratch);
    } catch (error) {
      if (error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
        return {
          ok: false,
          stage: 'install',
          failures: [{
            check: 'root export',
            message: 'the installed package has no exports["."], so importing its bare name fails with ERR_PACKAGE_PATH_NOT_EXPORTED; add a "." entry that names the module exporting apply',
          }],
          files: packed.files,
        };
      }
      return {
        ok: false,
        stage: 'install',
        failures: [{ check: 'root export', message: `the installed ${rootFile ?? report.manifest.name} does not import: ${error.message}` }],
        files: packed.files,
      };
    }
    hostFace = loaded;
    hostImported = true;
    if (typeof loaded.apply !== 'function') {
      return {
        ok: false,
        stage: 'install',
        failures: [{ check: 'root export', message: `the installed ${rootFile ?? report.manifest.name} exports no apply, so the loader's row mounts nothing` }],
        files: packed.files,
      };
    }
  }

  // A host face that reads a service it never declared does not get undefined
  // back: cordis throws "cannot get property ... without inject", the row fails,
  // and the plugin manager shows one red dot. This cost a real user several
  // restarts, so the activation itself is checked, not just the import.
  if (hostFace !== null) {
    try {
      // An `async apply()` rejects after the call returns, so a bare call here
      // used to print the success line and then take the whole CLI down with an
      // unhandled rejection. Awaiting puts a rejecting host half in the same
      // `host apply` failure path as a synchronous throw.
      await hostFace.apply(undeclaredContext());
    } catch (error) {
      return {
        ok: false,
        stage: 'install',
        failures: [{
          check: 'host apply',
          message: `apply() throws when a service it never declared is read, which fails the row (a rejecting async apply is awaited the same way): ${failureText(error)}`,
        }],
        files: packed.files,
      };
    }
  }

  // `--no-mount` skips the DOM, not the install: the host half is the half
  // that silently fails, and importing it needs nothing but Node.
  if (mount === false) {
    return { ok: true, stage: 'pack', failures: [], files: packed.files, size: packed.size, hostImported };
  }

  // Same convention the host uses: dsh.client.entry, then client.js.
  const entryFile = resolveEntry(installed, report.manifest);
  if (entryFile !== null) {
    if (fs.existsSync(entryFile) === false) {
      return {
        ok: false,
        stage: 'install',
        failures: [{ check: 'install', message: `the installed copy has no ${path.basename(entryFile)}` }],
        files: packed.files,
      };
    }
    try {
      const { mountClient } = await import('./testkit/index.mjs');
      // Resolve jsdom/React from the plugin's own folder: `verify` may be
      // running out of npx's cache, whose dependencies are not the panel's.
      const panel = await mountClient({ file: entryFile, resolveFrom: dir });
      const text = panel.text();
      // The web boot calls the module's apply() before every service exists. An
      // exception there fails the whole boot and takes the other plugins down
      // with it, so check the face and the bare-context call here.
      const { loadBundle } = await import('./testkit/index.mjs');
      const face = loadBundle(entryFile);
      const faceProblems = [];
      if (Array.isArray(face.inject) === false) {
        faceProblems.push('the client module declares no inject list, so the loader calls apply() before its services exist');
      }
      try {
        // An async client `apply()` rejects after the call returns, exactly like
        // the host half. Awaiting it here keeps a late rejection inside this
        // probe instead of letting it kill the process after the success line.
        await face.apply(absentContext());
      } catch (error) {
        faceProblems.push(`apply() throws when the services are absent, which fails the web boot (a rejecting async apply is awaited the same way): ${failureText(error)}`);
      }
      await panel.unmount();
      if (faceProblems.length > 0) {
        return {
          ok: false,
          stage: 'mount',
          failures: faceProblems.map((message) => ({ check: 'boot', message })),
          files: packed.files,
          installed,
        };
      }
      return {
        ok: true,
        stage: 'mount',
        failures: [],
        files: packed.files,
        size: packed.size,
        installed,
        text,
        hostImported,
      };
    } catch (error) {
      return {
        ok: false,
        stage: 'mount',
        failures: [{ check: 'mount', message: `the installed bundle does not mount: ${error.message}` }],
        files: packed.files,
        installed,
      };
    }
  }

  return { ok: true, stage: 'install', failures: [], files: packed.files, size: packed.size, installed, hostImported };
}
