/**
 * The checks a plugin has to pass before a release is worth starting.
 *
 * Every check answers a question that has actually gone wrong somewhere:
 * a tag that did not match package.json, a market entry missing `engines`, a
 * README that promised a host version the manifest did not require. Each one
 * returns either null (fine) or a line a human can act on.
 */
import fs from 'node:fs';
import path from 'node:path';

import { hostCompatibility, parsePartialVersion, parseRange } from './compat.mjs';

export { hostCompatibility } from './compat.mjs';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * A complete bare version is a comparator set, but it is not a range the market
 * index can repeat: it pins one version. The parser accepts it, so reject that
 * shape separately. Partial versions (`0.2`, `0.2.x`) and wildcards still name
 * a span and stay valid, and a multi-comparator range such as
 * `>=0.3.0 <0.4.0` is not a partial version of the whole string, so it reaches
 * `parseRange` unchanged.
 */
function isRangeExpression(value) {
  const bare = parsePartialVersion(value);
  if (bare !== null && bare.major !== null && bare.minor !== null && bare.patch !== null) return false;
  return parseRange(value) !== null;
}

export function readManifest(dir) {
  const manifestPath = path.join(dir, 'package.json');
  if (fs.existsSync(manifestPath) === false) {
    throw new Error(`no package.json in ${dir}`);
  }
  // Notepad and some VS Code configurations save UTF-8 with a BOM. JSON.parse
  // rejects it with a bare `Unexpected token`, so strip it and name the file
  // on failure instead of leaving the user to guess which manifest broke.
  const text = String(fs.readFileSync(manifestPath, 'utf8')).replace(/^\uFEFF/u, '').trim();
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { manifest, manifestPath };
}

export function version(manifest) {
  return typeof manifest.version === 'string' ? manifest.version : null;
}

/** The host range a version declares is the one the market index must repeat. */
export function hostRange(manifest) {
  const engines = manifest.engines;
  if (engines === undefined || engines === null) return null;
  const dsh = engines.dsh;
  return typeof dsh === 'string' && dsh.trim() !== '' ? dsh.trim() : null;
}

export function checkVersion(manifest) {
  const value = version(manifest);
  if (value === null) return 'package.json has no version';
  if (SEMVER.test(value) === false) return `version "${value}" is not semver`;
  return null;
}

export function checkDshField(manifest) {
  if (manifest.dsh === undefined || manifest.dsh === null) {
    return 'package.json has no "dsh" field, so the host will not load it as a plugin';
  }
  const bundle = manifest.dsh.bundle;
  if (bundle === undefined || bundle === null) {
    return 'dsh.bundle is missing; the host needs the patch file it points at';
  }
  if (typeof bundle.patch === 'string' && bundle.patch !== '') {
    return { patch: bundle.patch };
  }
  return 'dsh.bundle.patch is missing';
}

export function checkHostRange(manifest) {
  const range = hostRange(manifest);
  if (range === null) return 'engines.dsh is missing, so the market index cannot state the host requirement';
  if (isRangeExpression(range) === false) return `engines.dsh "${range}" is not a semver range`;
  return null;
}

/**
 * The `engines.dsh` answer for one host: compatible, incompatible, or unknown.
 * It starts from the same validity rule `doctor` applies, so a pin that npm
 * could compare is still unknown here — the manifest has not declared a range.
 */
export function checkHostCompatibility(manifest, hostVersion) {
  const range = hostRange(manifest);
  if (range === null || checkHostRange(manifest) !== null) return 'unknown';
  return hostCompatibility(range, hostVersion);
}

export function checkReadme(dir) {
  const readmePath = path.join(dir, 'README.md');
  if (fs.existsSync(readmePath) === false) return 'README.md is missing';
  const text = fs.readFileSync(readmePath, 'utf8');
  if (/^#{1,3}\s*Requirements/im.test(text) === false) {
    return 'README.md has no Requirements section, so users cannot tell which host it needs';
  }
  const { manifest } = readManifest(dir);
  const range = hostRange(manifest);
  // ">= 0.2.0" and ">=0.2.0" are the same range; authors write both.
  const squeeze = (value) => value.replace(/\s+/g, '');
  if (range !== null && squeeze(text).includes(squeeze(range)) === false) {
    return `README.md does not mention the host range "${range}" it declares`;
  }
  return null;
}

export function checkPatchFile(dir, manifest) {
  const bundle = manifest.dsh?.bundle;
  if (bundle === undefined || typeof bundle.patch !== 'string') return null;
  const patchPath = path.join(dir, bundle.patch);
  if (fs.existsSync(patchPath) === true) return null;
  return `dsh.bundle.patch points at ${bundle.patch}, which does not exist`;
}

/** `exports['./client']` is a string in some packages and a conditions object in others. */
export function exportTarget(value) {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    for (const key of ['default', 'import', 'require']) {
      if (typeof value[key] === 'string') return value[key];
    }
  }
  return undefined;
}

export function checkClientEntry(dir, manifest) {
  const client = manifest.dsh?.client;
  if (client === undefined || client === null) return null;
  // The declared entry comes first, then the `./client` export (how a package
  // with a `dsh/` folder names its bundle), then the plain file names. A plugin
  // that ships `dsh/client.js` is not wrong for failing to also ship `client.js`.
  const exported = manifest.exports;
  const subpath = typeof exported === 'string' ? undefined : exportTarget(exported?.['./client']);
  const entries = [client.entry, subpath, 'client.js', 'lib/client.js', 'dist/client.js']
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
    .map((entry) => entry.replace(/^\.\//u, ''));
  const found = entries.some((entry) => fs.existsSync(path.join(dir, entry)));
  return found ? null : `dsh.client is declared but none of ${entries.join(', ')} exists`;
}

/**
 * A client bundle the harness will never serve is the same failure as a tarball
 * without one: the plugin loads, the row mounts, and no panel appears. The host
 * serves `client.js` only for packages declaring `dsh.client`, so shipping the
 * file by convention is not enough.
 */
const CLIENT_FILES = ['client.js', 'lib/client.js', 'dist/client.js'];

export function checkClientDeclaration(dir, manifest) {
  const client = manifest.dsh?.client;
  if (client !== undefined && client !== null) {
    const platform = client.platform;
    if (platform !== undefined && platform !== 'web') {
      return `dsh.client.platform is ${JSON.stringify(platform)}, but the harness serves client bundles on web`;
    }
    // The host reads the bundle path from exports["./client"] only — a
    // declaration without that subpath makes the host drop the row.
    const exported = manifest.exports;
    const subpath = typeof exported === 'string' ? undefined : exportTarget(exported?.['./client']);
    if (typeof subpath !== 'string') {
      return 'dsh.client is declared but exports has no "./client" bundle, so the host drops the row and the panel cannot appear';
    }
    const file = subpath.replace(/^\.\//u, '');
    return fs.existsSync(path.join(dir, file))
      ? null
      : `exports["./client"] points at ${subpath}, which does not exist`;
  }
  const exported = manifest.exports;
  const subpath = typeof exported === 'string' ? undefined : exportTarget(exported?.['./client']);
  const shipped = [subpath, ...CLIENT_FILES].find(
    (file) => typeof file === 'string' && fs.existsSync(path.join(dir, file.replace(/^\.\//u, ''))),
  );
  if (shipped === undefined) return null;
  return `${shipped.replace(/^\.\//u, '')} ships but dsh.client is not declared, so the harness never serves the bundle and the panel cannot appear`;
}

/** Every path the manifest points at: exports, the bundle patch, the client entry. */
export function declaredPaths(manifest) {
  const paths = new Set();
  const add = (value) => {
    if (typeof value !== 'string') return;
    // npm accepts `cordis.patch.yml` and `./cordis.patch.yml` alike, and both
    // name the same tarball path. Record the bare form so a files list that
    // omits either spelling is caught.
    const normalized = value.replace(/^\.\//u, '');
    if (normalized === '' || normalized === '.') return;
    paths.add(normalized);
  };
  const walk = (value) => {
    if (typeof value === 'string') add(value);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(manifest.exports);
  walk(manifest.dsh?.bundle?.patch);
  walk(manifest.dsh?.client?.entry);
  walk(manifest.main);
  walk(manifest.types);
  return [...paths];
}

const GLOB_MAGIC = /[*?{}[\]]/u;

/** npm compares tarball paths with forward slashes and no leading `./` or `/`. */
function packagePath(value) {
  return String(value)
    .replace(/\\/gu, '/')
    .replace(/^(?:\.\/)+/u, '')
    .replace(/^\/+/u, '');
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
}

/** `{a,b}` is the one brace form npm's minimatch accepts for `files` entries. */
function expandBraces(pattern) {
  const start = pattern.indexOf('{');
  if (start === -1) return [pattern];
  let depth = 0;
  let end = -1;
  for (let index = start; index < pattern.length; index += 1) {
    if (pattern[index] === '{') depth += 1;
    else if (pattern[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) return [pattern];
  const body = pattern.slice(start + 1, end);
  const parts = [];
  let current = '';
  depth = 0;
  for (const char of body) {
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  if (parts.length === 1) return [pattern];
  const prefix = pattern.slice(0, start);
  const suffix = pattern.slice(end + 1);
  return parts.flatMap((part) => expandBraces(`${prefix}${part}${suffix}`));
}

/** One glob alternative, with `*` kept inside a path segment and `**` crossing them. */
function globSource(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        while (pattern[index + 1] === '*') index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:[^/]+/)*';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close === -1) {
        source += '\\[';
      } else {
        let body = pattern.slice(index + 1, close);
        let negate = '';
        if (body.startsWith('!') || body.startsWith('^')) {
          negate = '^';
          body = body.slice(1);
        }
        source += `[${negate}${body.replace(/\\/gu, '\\\\')}]`;
        index = close;
      }
    } else if (char === '{' || char === '}') {
      source += `\\${char}`;
    } else {
      source += escapeRegExp(char);
    }
  }
  return source;
}

function globMatches(value, pattern) {
  const alternatives = expandBraces(pattern).map(globSource);
  const source = alternatives.length === 1 ? alternatives[0] : `(?:${alternatives.join('|')})`;
  return new RegExp(`^${source}$`, 'iu').test(value);
}

/**
 * A `files` entry covers a path when it is equal, a parent folder, or a glob
 * that npm's own packer would expand to that path. `*` does not cross a
 * directory separator: `"files": ["*.js"]` ships root-level JavaScript only,
 * while `lib/*.js` covers direct children of `lib` and `lib/**` (or npm's
 * `lib/*` shorthand) covers the subtree.
 */
export function isShipped(target, files) {
  const wanted = packagePath(target);
  return files.some((entry) => {
    if (typeof entry !== 'string') return false;
    let clean = packagePath(entry);
    if (clean === '' || clean === '.') return false;
    if (GLOB_MAGIC.test(clean) === false) {
      // npm treats a folder entry as "everything below it", with or without a
      // trailing slash: `"files": ["lib"]` ships lib/index.js.
      clean = clean.replace(/\/+$/u, '');
      if (clean === '') return false;
      return wanted === clean || wanted.startsWith(`${clean}/`);
    }
    // npm appends `*` to a `dir/*` entry, making it a subtree pattern.
    if (clean.endsWith('/*') === true) clean += '*';
    if (globMatches(wanted, clean) === true) return true;
    // minimatch's matchBase: a pattern with no slash can match a basename, but
    // ignore-walk still has to have traversed every parent directory first.
    if (clean.includes('/') === false) {
      const segments = wanted.split('/');
      return segments.length > 1 && segments.every((segment) => globMatches(segment, clean));
    }
    return false;
  });
}

/**
 * npm always puts these in the tarball whatever `files` says, so a `files` list
 * that omits them is not a packaging bug. `main` is on the same list: npm adds
 * the file the `main` field names even when `files` does not mention it.
 */
const ALWAYS_SHIPPED = (entry, manifest) => {
  if (entry === 'package.json') return true;
  if (/^readme(\.[a-z]+)?$/iu.test(entry)) return true;
  if (/^licen[cs]e(\.[a-z]+)?$/iu.test(entry)) return true;
  if (/^changelog(\.[a-z]+)?$/iu.test(entry)) return true;
  const main = typeof manifest.main === 'string' ? manifest.main.replace(/^\.\//u, '') : null;
  return main !== null && entry === main;
};

/** The paths `package.json` points at that its own `files` list would omit. */
export function missingDeclaredPaths(manifest) {
  const files = manifest.files;
  if (Array.isArray(files) === false) return [];
  const declared = declaredPaths(manifest).filter((entry) => ALWAYS_SHIPPED(entry, manifest) === false);
  return declared.filter((entry) => isShipped(entry, files) === false);
}

export function checkFilesList(manifest) {
  if (Array.isArray(manifest.files) === false) {
    return 'package.json has no "files" list, so the tarball ships whatever happens to be in the folder';
  }
  const missing = missingDeclaredPaths(manifest);
  if (missing.length > 0) {
    return `files does not ship ${missing.join(', ')}, which package.json points at, so the installed plugin would be missing its own code`;
  }
  return null;
}

/**
 * The loader starts a plugin by importing the bare package name. A package that
 * ships both a CLI and a panel is one `exports` edit away from having its root
 * point at the CLI — the row then mounts nothing, and pnpm reports success.
 */
/** The module the loader imports when it starts the bare package name. */
export function rootEntry(manifest) {
  const root = typeof manifest.exports === 'object' && manifest.exports !== null ? manifest.exports['.'] : undefined;
  const entry = typeof root === 'string' ? root : manifest.main;
  if (typeof entry !== 'string') return null;
  return entry.replace(/^\.\//, '');
}

export function checkRootExport(dir, manifest) {
  if (manifest.dsh === undefined || manifest.dsh === null) return null;
  const target = rootEntry(manifest);
  // A bundle that inserts a subpath plugin needs no root module at all.
  if (target === null) return null;
  const entry = target;
  const bins = Object.values(manifest.bin ?? {}).filter((value) => typeof value === 'string');
  if (bins.some((bin) => bin.replace(/^\.\//, '') === target) === true) {
    return `exports["."] points at the CLI (${entry}), so the loader's row has no plugin to apply; point it at the module that exports apply`;
  }

  const file = path.resolve(dir, target);
  if (fs.existsSync(file) === false) return null;
  const source = fs.readFileSync(file, 'utf8');
  if (exportsApply(source) === false) {
    return `the root export ${entry} does not export apply, so the loader imports the package and mounts nothing`;
  }
  return null;
}

/**
 * True when the module source exports `apply` in any of the forms a plugin
 * actually uses. Factored out because `doctor --remote` asks the same question
 * about a file it read over the API, and two copies would drift.
 */
export function exportsApply(source) {
  if (typeof source !== 'string') return false;
  return /export\s+(?:async\s+)?function\s+apply\b|export\s+(?:const|let|var)\s+apply\b|export\s*\{[^}]*\bapply\b|\bapply\s*[:=]\s*(?:async\s*)?(?:function|\()/.test(
    source,
  );
}

/** Runs every check and returns `{ failures, notes }`. */
export function doctor(dir, { installed = false } = {}) {
  const { manifest } = readManifest(dir);
  const checks = [
    ['version', checkVersion(manifest)],
    ['engines.dsh', checkHostRange(manifest)],
    ['readme', checkReadme(dir)],
    ['dsh field', checkDshField(manifest)],
    ['patch file', checkPatchFile(dir, manifest)],
    ['client entry', checkClientEntry(dir, manifest)],
    ['client declaration', checkClientDeclaration(dir, manifest)],
    // After install the tarball is already unpacked, so `files` cannot be used to
    // decide what shipped: npm always ships package.json and the README.
    ['files list', installed === true ? null : checkFilesList(manifest)],
    ['root export', checkRootExport(dir, manifest)],
  ];
  const failures = checks.filter(([, result]) => result !== null && typeof result === 'string');
  return {
    manifest,
    failures: failures.map(([name, message]) => ({ check: name, message })),
    notes: { hostRange: hostRange(manifest), version: version(manifest) },
  };
}
