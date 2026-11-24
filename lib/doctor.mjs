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

import { hostCompatibility, parsePartialVersion, parseRange, parseStrictVersion } from './compat.mjs';
import { resolvePath } from './paths.mjs';

export { hostCompatibility } from './compat.mjs';

/**
 * npm publishes and installs by `name`; a missing, empty or malformed one fails
 * at the publish/pack boundary, after every other check has already passed.
 *
 * The shape is npm's "valid for a new package" rule without a dependency:
 * lower-case URL-safe segments, no leading dot/hyphen/underscore, at most 214
 * characters, and not one of the two names npm reserves. `init` uses the same
 * predicate, so a scaffold's name and the preflight that blesses it cannot
 * drift apart.
 */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const MAX_NAME_LENGTH = 214;
const RESERVED_NAMES = new Set(['node_modules', 'favicon.ico']);

export function isValidPackageName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_NAME_LENGTH &&
    name === name.trim() &&
    NPM_NAME.test(name) &&
    RESERVED_NAMES.has(name.toLowerCase()) === false
  );
}

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

/**
 * Remove every UTF-8 BOM at the start of a text file.
 *
 * One BOM is what Notepad writes; more than one is what a botched repair can
 * leave behind. Stripping the run rather than a single character means a
 * manifest that was already damaged is still readable, and a writer that starts
 * from the stripped text cannot add another BOM on top.
 */
export function stripBom(text) {
  return String(text).replace(/^\uFEFF+/u, '');
}

/**
 * Read the one local manifest every command reads.
 *
 * Notepad and some VS Code configurations save UTF-8 with a BOM. JSON.parse
 * rejects it with a bare `Unexpected token`, so this is the single place that
 * strips the BOM and names the file on failure. `raw` is the bytes as written:
 * repair commands need it to keep the original indentation and line endings,
 * and returning it here means the reader and the writer cannot disagree about
 * which manifest is being edited.
 */
export function readManifestSource(dir) {
  // `doctor '~/my-panel'` arrives with a literal tilde from cmd/PowerShell.
  // Resolve it here too, because this is also a public entry point.
  const target = resolvePath(dir);
  const manifestPath = path.join(target, 'package.json');
  if (fs.existsSync(manifestPath) === false) {
    throw new Error(`no package.json in ${target}`);
  }
  const raw = String(fs.readFileSync(manifestPath, 'utf8'));
  const text = stripBom(raw).trim();
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  // npm's manifest is an object. A file holding `null`, a string or an array
  // parses as JSON but every check would then read a field off the wrong shape;
  // `doctor` used to fail with a bare `Cannot read properties of null` instead
  // of naming the file. Reject it once here so `doctor`, `doctor --fix` and the
  // installed-plugin audit all report the same actionable sentence.
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) === true) {
    throw new Error(`${manifestPath} does not hold a JSON object`);
  }
  return { manifest, manifestPath, raw, target };
}

export function readManifest(dir) {
  const { manifest, manifestPath } = readManifestSource(dir);
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

/**
 * `doctor` reads this before anything that needs a package name: `verify` packs
 * and installs the tarball under it, and the loader imports the bare name. An
 * empty string and a deleted field both mean "npm cannot publish this", so they
 * get the same actionable answer rather than being treated as present.
 */
export function checkName(manifest) {
  const name = manifest?.name;
  if (name === undefined || name === null) {
    return 'package.json has no "name", so npm cannot publish or install the package';
  }
  if (typeof name !== 'string') {
    return 'package.json "name" is not a string, so npm cannot publish or install the package';
  }
  if (name.trim() === '') {
    return 'package.json has an empty "name", so npm cannot publish or install the package';
  }
  if (isValidPackageName(name) === false) {
    return `package.json "name" ${JSON.stringify(name)} is not a valid npm package name; use lower-case letters, digits, dots, hyphens or underscores, for example my-plugin or @me/my-plugin`;
  }
  return null;
}

export function checkVersion(manifest) {
  const value = version(manifest);
  if (value === null) return 'package.json has no version';
  // The same strict parser the compatibility code uses for a package version,
  // so `doctor` and `release --dry-run` cannot accept different forms.
  if (parseStrictVersion(value) === null) return `version "${value}" is not semver`;
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
  const engines = manifest?.engines;
  if (engines !== undefined && engines !== null && (typeof engines !== 'object' || Array.isArray(engines) === true)) {
    // `"engines": ">=0.2.0"` is the string instead of the object npm reads.
    // Without this branch every caller falls through to hostRange() === null and
    // tells the author to add an `engines.dsh` field that is already present.
    return 'package.json "engines" is not an object, so it cannot declare a dsh range';
  }
  const dsh = engines?.dsh;
  if (typeof dsh !== 'undefined' && dsh !== null && typeof dsh !== 'string') {
    // A number or object here is malformed, not absent: quoting the value back
    // is the difference between "add the field" and "fix the field you wrote".
    return `engines.dsh ${JSON.stringify(dsh)} is not a string, so no host can compare its version against it`;
  }
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

/**
 * The README questions that do not depend on where the text came from: is there
 * a Requirements section, and does it name the range the manifest declares.
 *
 * Factored out because `doctor --remote` reads the same README over the GitHub
 * API; a second copy would drift and the two commands would disagree about the
 * same repository.
 */
export function checkReadmeText(text, manifest) {
  // A README saved by Notepad starts with a BOM, which would sit between the
  // start of the file and a first-line `## Requirements` heading. The heading
  // is there; strip the marker before deciding it is not.
  const readme = stripBom(text);
  if (/^#{1,3}\s*Requirements/im.test(readme) === false) {
    return 'README.md has no Requirements section, so users cannot tell which host it needs';
  }
  const range = hostRange(manifest);
  // ">= 0.2.0" and ">=0.2.0" are the same range; authors write both.
  const squeeze = (value) => value.replace(/\s+/g, '');
  if (range !== null && squeeze(readme).includes(squeeze(range)) === false) {
    return `README.md does not mention the host range "${range}" it declares`;
  }
  return null;
}

export function checkReadme(dir) {
  const readmePath = path.join(dir, 'README.md');
  if (fs.existsSync(readmePath) === false) return 'README.md is missing';
  return checkReadmeText(fs.readFileSync(readmePath, 'utf8'), readManifest(dir).manifest);
}

/** What a declared path is on disk, following symlinks the way Node's loader does. */
function declaredPathKind(target) {
  try {
    const stat = fs.statSync(target);
    if (stat.isFile() === true) return 'file';
    if (stat.isDirectory() === true) return 'directory';
    return 'other';
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'missing';
    return 'unreadable';
  }
}

/**
 * A manifest path is a path to a file to read or load, not merely a name that
 * exists. `existsSync` answered true for a directory, so a patch or client
 * path could point at a folder and every check would call the plugin clean.
 * The suffix fits both `which ...` and `<path> ...` sentences.
 */
function notRegularFile(kind) {
  return kind === 'directory' ? 'is a directory, not a regular file' : 'is not a regular file';
}

/**
 * Remove a YAML line comment, leaving a `#` inside a quoted scalar alone.
 *
 * The patch is read by a small row detector, not a general YAML parser. This is
 * the one piece of the grammar it needs to get right: a commented-out row must
 * not make an otherwise empty patch look applicable.
 */
function stripYamlComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === null) {
      if (char === '"' || char === "'") quote = char;
      else if (char === '#' && (index === 0 || /\s/u.test(line[index - 1]))) return line.slice(0, index);
    } else if (quote === '"' && char === '\\') {
      index += 1;
    } else if (char === quote) {
      if (quote === "'" && line[index + 1] === "'") index += 1;
      else quote = null;
    }
  }
  return line;
}

/** The non-empty lines of a patch, with indentation and comments removed. */
function patchLines(text) {
  const lines = [];
  for (const raw of stripBom(text).split(/\r?\n/u)) {
    const withoutComment = stripYamlComment(raw);
    const trimmed = withoutComment.trim();
    if (trimmed === '') continue;
    if (/^(?:---|\.\.\.)$/u.test(trimmed)) continue;
    const leading = withoutComment.match(/^[ \t]*/u)[0];
    lines.push({ indent: leading.replace(/\t/gu, '  ').length, text: trimmed });
  }
  return lines;
}

/** A `key:` line, with or without quotes around the key. */
function yamlKey(text) {
  const match = /^(['"]?)([A-Za-z0-9_.-]+)\1\s*:\s*(.*)$/u.exec(text);
  return match === null ? null : { key: match[2], value: match[3].trim() };
}

/** Split on a separator that is not nested in braces, brackets or quotes. */
function splitFlowValue(text, separator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (quote === '"' && char === '\\') index += 1;
      else if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** A YAML scalar without its surrounding quotes. */
function unquoteYamlScalar(text) {
  const value = text.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/gu, '$1');
  }
  return value;
}

/**
 * A `name:` value that can actually identify a loader row. `null`, booleans,
 * empty collections and an empty scalar all parse as an entry but name nothing.
 */
function yamlRowName(value) {
  const text = value.trim();
  if (text === '' || /^(?:null|Null|NULL|~|true|True|TRUE|false|False|FALSE|\[\]|\{\})$/u.test(text)) return false;
  if (text.startsWith('[') || text.startsWith('{')) return false;
  return unquoteYamlScalar(text) !== '';
}

/** The top-level `key: value` pairs of a flow mapping, or null when not one. */
function flowMappingPairs(text) {
  const value = text.trim();
  if (value.startsWith('[')) return null;
  let inner = value;
  if (value.startsWith('{')) {
    if (!value.endsWith('}')) return null;
    inner = value.slice(1, -1);
  } else if (value.startsWith('"') || value.startsWith("'")) {
    return null;
  }
  if (inner.trim() === '') return [];
  const pairs = [];
  for (const part of splitFlowValue(inner, ',')) {
    const colon = splitFlowValue(part, ':')[0].length;
    if (colon === 0 || colon === part.length) return null;
    const key = unquoteYamlScalar(part.slice(0, colon));
    if (key === '') return null;
    pairs.push({ key, value: part.slice(colon + 1).trim() });
  }
  return pairs;
}

/** Whether a flow mapping is a row that names something the loader can mount. */
function flowRowNamesLoader(text) {
  const pairs = flowMappingPairs(text);
  return pairs !== null && pairs.some((pair) => pair.key === 'name' && yamlRowName(pair.value));
}

/** Whether a block mapping at `indent` has a `name:` that can mount. */
function blockMappingNamesLoader(rows, indent) {
  return rows.some((line) => {
    if (line.indent !== indent) return false;
    const parsed = yamlKey(line.text);
    return parsed !== null && parsed.key === 'name' && yamlRowName(parsed.value);
  });
}

/** Whether a block `insert:` value has a list or mapping entry naming a row. */
function blockInsertNamesLoader(children) {
  if (children.length === 0) return false;
  const dashed = /^-(?:\s|$)/u.test(children[0].text);
  if (!dashed) return blockMappingNamesLoader(children, children[0].indent);

  const sequenceIndent = children[0].indent;
  const starts = children
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.indent === sequenceIndent && /^-(?:\s|$)/u.test(line.text))
    .map(({ index }) => index);
  for (let item = 0; item < starts.length; item += 1) {
    const start = starts[item];
    const end = item + 1 < starts.length ? starts[item + 1] : children.length;
    const first = children[start];
    const content = first.text.replace(/^-\s*/u, '');
    const contentIndent = first.indent + (first.text.length - content.length);
    const rest = children.slice(start + 1, end);

    if (content.startsWith('{')) {
      if (flowRowNamesLoader(content)) return true;
      continue;
    }
    if (content === '') {
      const keys = rest.filter((line) => line.indent > first.indent);
      if (keys.length > 0 && blockMappingNamesLoader(keys, keys[0].indent)) return true;
      continue;
    }
    const parsed = yamlKey(content);
    if (parsed === null) continue; // `null`, `false`, a number or another scalar
    const pairs = [{ ...parsed, indent: contentIndent }];
    for (const line of rest) {
      if (line.indent !== contentIndent) continue;
      const next = yamlKey(line.text);
      if (next !== null) pairs.push({ ...next, indent: line.indent });
    }
    if (pairs.some((pair) => pair.key === 'name' && yamlRowName(pair.value))) return true;
  }
  return false;
}

/** Whether an inline `insert:` value has at least one entry naming a row. */
function yamlValueNamesRow(value) {
  const text = value.trim();
  if (text === '') return false;
  if (text.startsWith('[')) {
    const end = text.lastIndexOf(']');
    if (end === -1) return false;
    const inside = text.slice(1, end).trim();
    if (inside === '') return false;
    return splitFlowValue(inside, ',').some((entry) => flowRowNamesLoader(entry));
  }
  if (text.startsWith('{')) return flowRowNamesLoader(text);
  // `insert` names a row or a list of rows, never a scalar.
  return false;
}

/**
 * Whether a patch has a top-level loader row whose `insert` list has at least
 * one entry.
 *
 * A patch that exists but cannot insert anything is the same install failure as
 * a missing patch: the host reports success and the plugin never mounts. Real
 * bundle patches are a top-level YAML array of rows, so an empty file, a plain
 * mapping such as `foo: bar`, and `- insert: []` all have nothing to apply.
 * An entry also has to be a mapping with a non-empty `name:`, because
 * `- insert: [null]`, `[false]` or `[{}]` parse as a list yet give the loader
 * no row to mount. Several rows are allowed; one usable insert is enough.
 */
function patchInsertState(text) {
  const lines = patchLines(text);
  if (lines.length === 0) return 'empty';
  const rootIndent = Math.min(...lines.map((line) => line.indent));
  const rowStarts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].indent === rootIndent && /^-(?:\s|$)/u.test(lines[index].text)) rowStarts.push(index);
  }
  if (rowStarts.length === 0) return 'no-insert';

  let sawInsert = false;
  for (let row = 0; row < rowStarts.length; row += 1) {
    const start = rowStarts[row];
    const end = row + 1 < rowStarts.length ? rowStarts[row + 1] : lines.length;
    const first = lines[start].text.replace(/^-\s*/u, '');
    // Keys on the `- ...` line start where the text after the dash starts; keys
    // on the following lines use their own indentation.
    const inlineIndent = lines[start].indent + (lines[start].text.length - first.length);
    const firstKey =
      yamlKey(first) !== null
        ? { indent: inlineIndent, text: first, index: start }
        : lines.slice(start + 1, end).map((line, offset) => ({ ...line, index: start + 1 + offset })).find(
            (line) => line.indent > lines[start].indent && yamlKey(line.text) !== null,
          );
    if (firstKey === undefined) continue;

    for (let index = start; index < end; index += 1) {
      const text = index === start ? first : lines[index].text;
      const indent = index === start ? inlineIndent : lines[index].indent;
      if (indent !== firstKey.indent) continue;
      const parsed = yamlKey(text);
      if (parsed === null || parsed.key !== 'insert') continue;
      sawInsert = true;
      if (yamlValueNamesRow(parsed.value)) return 'valid';
      if (parsed.value !== '') continue;
      // A block value may be indented below the key, or be an indentless
      // sequence at the key's own indentation (`insert:` then `- id:`).
      const children = [];
      for (let child = index + 1; child < end; child += 1) {
        const line = lines[child];
        if (line.indent < firstKey.indent) break;
        if (line.indent === firstKey.indent && /^-(?:\s|$)/u.test(line.text) === false) break;
        children.push(line);
      }
      if (blockInsertNamesLoader(children)) return 'valid';
    }
  }
  return sawInsert ? 'empty-insert' : 'no-insert';
}

export function checkPatchFile(dir, manifest) {
  const bundle = manifest.dsh?.bundle;
  if (bundle === undefined || typeof bundle.patch !== 'string') return null;
  const patchPath = path.join(dir, bundle.patch);
  const kind = declaredPathKind(patchPath);
  if (kind === 'file') {
    let source;
    try {
      source = fs.readFileSync(patchPath, 'utf8');
    } catch {
      return `dsh.bundle.patch points at ${bundle.patch}, which cannot be read, so the host has no patch to apply`;
    }
    if (patchInsertState(source) === 'valid') return null;
    return `dsh.bundle.patch points at ${bundle.patch}, which has no insert row the host can apply, so the plugin never mounts`;
  }
  if (kind === 'missing') return `dsh.bundle.patch points at ${bundle.patch}, which does not exist`;
  if (kind === 'unreadable') {
    return `dsh.bundle.patch points at ${bundle.patch}, which cannot be read, so the host has no patch to apply`;
  }
  return `dsh.bundle.patch points at ${bundle.patch}, which ${notRegularFile(kind)}`;
}

/**
 * `exports['./client']` is a string in some packages and a conditions object in
 * others, and the root export can be either. Resolve the conditions Node or a
 * bundler would use, including a nested object such as
 * `{ node: { import: './index.mjs' } }`; an array's first resolvable
 * alternative wins.
 */
export function exportTarget(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = exportTarget(candidate);
      if (typeof target === 'string') return target;
    }
    return undefined;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of ['default', 'import', 'require', 'node', 'module-sync']) {
      const target = exportTarget(value[key]);
      if (typeof target === 'string') return target;
    }
  }
  return undefined;
}

/**
 * The paths `doctor` tries as the client entry, in order, with a leading `./`
 * removed.
 *
 * Exported because `verify` has to tell an absent entry a `prepack` hook can
 * still write from an entry that is already a directory: only the absent shape
 * may wait for the pack, and a second copy of this list would drift.
 */
export function clientEntryCandidates(manifest) {
  const client = manifest.dsh?.client;
  // The declared entry comes first, then the `./client` export (how a package
  // with a `dsh/` folder names its bundle), then the plain file names. A plugin
  // that ships `dsh/client.js` is not wrong for failing to also ship `client.js`.
  const exported = manifest.exports;
  const subpath = typeof exported === 'string' ? undefined : exportTarget(exported?.['./client']);
  return [client?.entry, subpath, 'client.js', 'lib/client.js', 'dist/client.js']
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
    .map((entry) => entry.replace(/^\.\//u, ''));
}

export function checkClientEntry(dir, manifest) {
  const client = manifest.dsh?.client;
  if (client === undefined || client === null) return null;
  const entries = clientEntryCandidates(manifest);
  const candidates = entries.map((entry) => ({ entry, kind: declaredPathKind(path.join(dir, entry)) }));
  if (candidates.some((candidate) => candidate.kind === 'file') === true) return null;
  const directory = candidates.find((candidate) => candidate.kind === 'directory');
  if (directory !== undefined) {
    return `dsh.client is declared but ${directory.entry} ${notRegularFile(directory.kind)}`;
  }
  const unreadable = candidates.find((candidate) => candidate.kind === 'unreadable');
  if (unreadable !== undefined) {
    return `dsh.client is declared but ${unreadable.entry} cannot be read, so the client bundle cannot be served`;
  }
  return `dsh.client is declared but none of ${entries.join(', ')} exists`;
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
    const kind = declaredPathKind(path.join(dir, file));
    if (kind === 'file') return null;
    if (kind === 'missing') return `exports["./client"] points at ${subpath}, which does not exist`;
    if (kind === 'unreadable') {
      return `exports["./client"] points at ${subpath}, which cannot be read, so the host has no client bundle to serve`;
    }
    return `exports["./client"] points at ${subpath}, which ${notRegularFile(kind)}`;
  }
  const exported = manifest.exports;
  const subpath = typeof exported === 'string' ? undefined : exportTarget(exported?.['./client']);
  const candidates = [subpath, ...CLIENT_FILES]
    .filter((file) => typeof file === 'string')
    .map((file) => ({ file: file.replace(/^\.\//u, ''), kind: declaredPathKind(path.join(dir, file.replace(/^\.\//u, ''))) }));
  const shipped = candidates.find((candidate) => candidate.kind === 'file');
  if (shipped !== undefined) {
    return `${shipped.file} ships but dsh.client is not declared, so the harness never serves the bundle and the panel cannot appear`;
  }
  const directory = candidates.find((candidate) => candidate.kind === 'directory');
  if (directory !== undefined) {
    return `${directory.file} ${notRegularFile(directory.kind)}, so there is no client bundle to serve`;
  }
  return null;
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

const GLOB_MAGIC = /[*?{}[\]]|[!+@]\(/u;

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

/**
 * Index of the `)` that closes the extglob opened at `open`, or -1 when the
 * pattern has no closing paren. Parentheses inside a bracket class, a nested
 * extglob or an escape do not count.
 */
function extglobEnd(pattern, open) {
  let depth = 0;
  let inClass = false;
  for (let index = open; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') {
      index += 1;
    } else if (inClass === true) {
      if (char === ']') inClass = false;
    } else if (char === '[') {
      inClass = true;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Split an extglob body on `|`, ignoring separators inside a nested group or class. */
function splitExtglobAlternatives(body) {
  const parts = [];
  let current = '';
  let depth = 0;
  let inClass = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\') {
      current += char;
      if (index + 1 < body.length) current += body[(index += 1)];
    } else if (inClass === true) {
      current += char;
      if (char === ']') inClass = false;
    } else if (char === '[') {
      inClass = true;
      current += char;
    } else if (char === '(') {
      depth += 1;
      current += char;
    } else if (char === ')') {
      depth -= 1;
      current += char;
    } else if (char === '|' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/** The regex source for one extglob operator and its `|`-separated body. */
function extglobSource(operator, body) {
  const alternatives = splitExtglobAlternatives(body).map(globSource);
  const inner = alternatives.length === 1 ? alternatives[0] : `(?:${alternatives.join('|')})`;
  switch (operator) {
    case '@':
      return `(?:${inner})`;
    case '+':
      return `(?:${inner})+`;
    case '?':
      return `(?:${inner})?`;
    case '*':
      return `(?:${inner})*`;
    default:
      // `!(...)` is minimatch's negative extglob: at this position no
      // alternative may match, and the lazy segment lets the rest of the
      // pattern decide where the group ends (`!(foo).js` still matches
      // `bar.js`, not `foo.js`).
      return `(?:(?!(?:${inner}))[^/]*?)`;
  }
}

/** One glob alternative, with `*` kept inside a path segment and `**` crossing them. */
function globSource(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if ('@+?!*'.includes(char) === true && pattern[index + 1] === '(') {
      const close = extglobEnd(pattern, index + 1);
      if (close !== -1) {
        source += extglobSource(char, pattern.slice(index + 2, close));
        index = close;
        continue;
      }
    }
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
 * Normalize one `files` entry the way npm-packlist does before it decides
 * whether the entry is a file, a folder or a pattern. npm strips one leading
 * `./` before it looks at a negation, so `./lib/client.js` and
 * `!lib/client.js` are not the same rule: only the positive spelling becomes a
 * clean tarball path. It also turns a `dir/*` entry into the `dir/**` subtree
 * pattern. `pattern` is the inverse (the include rule npm derives from the
 * entry) with its leading `!` markers removed; `negate` is how that inverse is
 * applied.
 */
function filesEntry(raw) {
  let file = String(raw);
  if (file.startsWith('./')) file = file.slice(1);
  if (file.endsWith('/*')) file += '*';
  const bangs = /^!*/u.exec(file)[0].length;
  const pattern = file.slice(bangs).replace(/\\/gu, '/');
  return {
    statPath: pattern,
    pattern,
    positive: bangs % 2 === 0,
    // An entry that starts with `!` gets one more marker in npm's inverse, so
    // it becomes an exclusion; a positive entry becomes an include.
    negate: bangs % 2 === 0,
  };
}

/**
 * Whether a `files` entry names a file, a folder, or a pattern. npm uses
 * `lstat` for this. Without a checkout (`doctor --remote`) there is no tree to
 * stat, so an exact path is treated as the file it names and a path that is an
 * ancestor of the one being checked is treated as a folder. Everything else
 * is a pattern.
 */
function filesEntryKind(entry, wanted, dir) {
  if (GLOB_MAGIC.test(entry.statPath) === true) return 'pattern';
  if (dir === undefined) {
    const clean = packagePath(entry.statPath).replace(/\/+$/u, '');
    if (clean === '' || clean === '.') return 'pattern';
    if (clean === wanted) return 'file';
    if (wanted.startsWith(`${clean}/`) === true) return 'directory';
    // A no-glob entry names one exact path. There is no tree to prove that it
    // is a folder, and npm would treat it as a strict file rule when it exists.
    return 'file';
  }
  try {
    const stat = fs.statSync(path.join(dir, entry.statPath));
    if (stat.isFile() === true) return 'file';
    if (stat.isDirectory() === true) return 'directory';
    return 'other';
  } catch {
    // npm treats a path that is not there as a pattern, not a required file.
    return 'pattern';
  }
}

/**
 * A small subset of minimatch's matching rules, enough for the patterns npm
 * derives from `files`. A pattern without a slash matches a basename
 * (`matchBase`); a leading slash anchors the pattern at the package root.
 */
function npmMatches(pattern, value) {
  const anchored = pattern.startsWith('/');
  const trimmed = anchored ? pattern.slice(1) : pattern;
  if (trimmed === '') return false;
  return trimmed.includes('/') === true
    ? globMatches(anchored ? `/${value}` : value, anchored ? pattern : trimmed)
    : globMatches(value.split('/').at(-1) ?? '', trimmed);
}

/**
 * ignore-walk asks a folder for a partial match while it decides whether to
 * walk it. A pattern with a trailing slash matches the folder name; a positive
 * pattern can also match something below the folder. An exclusion is only
 * tested against the folder name itself, so `!lib/secret.js` does not make
 * `lib` untraversable.
 */
function npmPartiallyMatches(pattern, value, explore) {
  if (npmMatches(pattern, value) === true) return true;
  if (npmMatches(pattern, `${value}/`) === true) return true;
  if (explore !== true) return false;
  // minimatch does not extend a matchBase pattern through child folders:
  // `*.js` alone never makes npm walk `lib`.
  const trimmed = pattern.startsWith('/') ? pattern.slice(1) : pattern;
  if (trimmed.includes('/') === false) return false;
  return patternsUnder(value, trimmed);
}

/**
 * Whether some path below `value` could match `pattern`. This is the segment
 * walker npm uses for a partial match: literal and glob segments must match the
 * folder's segments, `**` may absorb any number of them, and a remaining
 * pattern segment is what a child can still satisfy.
 */
function patternsUnder(value, pattern) {
  const valueSegments = value.split('/').filter((segment) => segment !== '');
  const patternSegments = pattern.split('/').filter((segment) => segment !== '');
  const memo = new Map();
  const walk = (valueIndex, patternIndex) => {
    const key = `${valueIndex}:${patternIndex}`;
    if (memo.has(key) === true) return memo.get(key);
    let answer;
    if (valueIndex === valueSegments.length) {
      // The folder itself is a prefix of whatever the remaining segments name.
      answer = patternIndex < patternSegments.length;
    } else if (patternIndex === patternSegments.length) {
      answer = false;
    } else if (patternSegments[patternIndex] === '**') {
      answer = walk(valueIndex, patternIndex + 1) || walk(valueIndex + 1, patternIndex);
    } else {
      answer =
        globMatches(valueSegments[valueIndex], patternSegments[patternIndex]) === true &&
        walk(valueIndex + 1, patternIndex + 1);
    }
    memo.set(key, answer);
    return answer;
  };
  return walk(0, 0);
}

/**
 * ignore-walk's filterEntry: a child folder first asks its parent whether the
 * full path passes, and when the parent says no the child can only continue if
 * the folder was explicitly matched (`exact`). Then the walker applies its own
 * rules. Child walkers intentionally do not carry the root `files` rules; that
 * is why a glob that includes `lib` also exposes `lib/other.js` only after
 * something makes npm walk `lib`.
 */
function filterEntry(walker, entry, partial) {
  let included = true;
  if (walker.parent !== null) {
    included = filterEntry(walker.parent, `${walker.basename}/${entry}`, partial);
    if (included === false && walker.exact !== true) return false;
  }
  for (const rule of walker.rules) {
    if (rule.negate === included) continue;
    const matches =
      partial === true
        ? npmPartiallyMatches(rule.pattern, entry, rule.negate === true)
        : npmMatches(rule.pattern, entry);
    if (matches === true) included = rule.negate;
  }
  return included;
}

/** The rules npm puts in strictRules for implied and explicitly required files. */
const STRICT_INCLUDES = [
  '/package.json',
  '/readme',
  '/license',
  '/licence',
  '/copying',
];

/** Paths npm always excludes, even when a `files` entry names them. */
const STRICT_EXCLUDES = ['/.git', '/node_modules', '.npmrc', '/package-lock.json', '/yarn.lock', '/pnpm-lock.yaml'];

/**
 * Whether a `files` list ships `target`.
 *
 * This follows npm-packlist rather than applying the entries as a simple last
 * match wins list. A files entry that names an existing file becomes a strict
 * rule, and npm prepends those strict rules, so the *first* explicit mention of
 * a path is applied last. A negated explicit entry therefore still wins over a
 * later positive re-listing. The re-listing can only restore the file through a
 * folder walk (`lib` or `lib/**`), because that is what makes npm walk the
 * folder and require the positive entry as a child. Patterns such as `*.js` are
 * evaluated by npm's walker too: they can reach a nested file once some other
 * entry has made npm traverse the parent folder, and they do not do so on their
 * own.
 *
 * `dir` is optional because the remote checks only have the manifest. Without a
 * tree there is nothing to stat, so exact paths are treated as files and folder
 * prefixes as folders, which keeps the manifest-only verdict useful.
 */
export function isShipped(target, files, dir = undefined) {
  const wanted = packagePath(target).replace(/\/+$/u, '');
  if (wanted === '') return false;
  const root = dir === undefined ? undefined : path.resolve(dir);
  const ordinary = [{ pattern: '*', negate: false }];
  const strict = [];
  const required = [];

  for (const raw of files) {
    if (typeof raw !== 'string') continue;
    const entry = filesEntry(raw);
    const kind = filesEntryKind(entry, wanted, root);
    if (kind === 'file') {
      // npm prepends each strict rule, so the first explicit entry is applied
      // last and wins. A positive entry also becomes a required child of its
      // folder.
      strict.unshift({ pattern: entry.pattern, negate: entry.negate });
      if (entry.positive === true) {
        required.push(entry.statPath.startsWith('/') ? entry.statPath.slice(1) : entry.statPath);
      }
    } else if (kind === 'directory') {
      ordinary.push({ pattern: entry.pattern, negate: entry.negate });
      ordinary.push({ pattern: `${entry.pattern.replace(/\/+$/u, '')}/**`, negate: entry.negate });
    } else {
      ordinary.push({ pattern: entry.pattern, negate: entry.negate });
    }
  }

  const rootWalker = {
    parent: null,
    basename: '',
    exact: true,
    required,
    rules: [
      ...ordinary,
      ...strict,
      ...STRICT_EXCLUDES.map((pattern) => ({ pattern, negate: false })),
      ...STRICT_INCLUDES.map((pattern) => ({ pattern, negate: true })),
    ],
  };

  const segments = wanted.split('/').filter((segment) => segment !== '');
  let walker = rootWalker;
  let prefix = '';
  for (let index = 0; index < segments.length; index += 1) {
    const entry = segments[index];
    if (index === segments.length - 1) return filterEntry(walker, entry, false);
    const filePass = filterEntry(walker, entry, false);
    const folderPass = filterEntry(walker, entry, true);
    // npm only recurses into a folder that its directory-mode check accepted.
    if (folderPass !== true) return false;
    const exact = filePass === true || filterEntry(walker, `${entry}/`, false);
    prefix = prefix === '' ? entry : `${prefix}/${entry}`;
    // npm hands each child only the required files whose direct parent it is.
    // It does not re-derive the list from the root, so a nested re-listing does
    // not bypass an earlier exclusion at a higher level.
    const nextRequired = walker.required
      .filter((file) => path.posix.relative(file, prefix) === '..')
      .map((file) => path.posix.relative(prefix, file));
    walker = {
      parent: walker,
      basename: entry,
      exact,
      required: nextRequired,
      rules: [
        ...STRICT_EXCLUDES.map((pattern) => ({ pattern, negate: false })),
        ...nextRequired.map((pattern) => ({ pattern, negate: true })),
      ],
    };
  }
  return false;
}

/**
 * Read the ignore file npm would use for a subdirectory. A `.npmignore` file
 * wins over `.gitignore` in the same directory, and a missing one falls through
 * to the next candidate. The root `.npmignore` is not consulted here: when a
 * `files` list exists npm disables the root ignore files, but a subdirectory
 * `.npmignore` (or the `.gitignore` fallback) still subtracts from it.
 */
function subdirectoryIgnoreFile(directory) {
  for (const name of ['.npmignore', '.gitignore']) {
    let text;
    try {
      text = fs.readFileSync(path.join(directory, name), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      // npm would stop packing on an unreadable ignore file. The files-list
      // check has no way to report that, so it keeps looking rather than
      // calling the package clean because of a filesystem error.
      return null;
    }
    return {
      file: path.join(directory, name),
      rules: text
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line !== '' && line.startsWith('#') === false)
        .map((line) => {
          const negate = line.startsWith('!');
          return { negate, pattern: negate ? line.slice(1) : line };
        })
        .filter((rule) => rule.pattern !== ''),
    };
  }
  return null;
}

/**
 * Whether one ignore-file rule names `relative`, a path below the directory
 * that owns the ignore file. A rule also removes a file when it names one of
 * its parent directories, which is how `nested/` drops `nested/client.js`.
 */
function ignoreRuleMatches(relative, pattern) {
  // Anchoring is decided before `packagePath` strips the leading slash that
  // spells it; `/client.js` names a direct child of the ignore file's folder,
  // not a basename at any depth.
  const anchored = String(pattern).startsWith('/');
  let clean = packagePath(pattern);
  const directoryOnly = clean.endsWith('/');
  if (directoryOnly === true) clean = clean.replace(/\/+$/u, '');
  if (clean === '' || clean === '.') return false;

  const segments = relative.split('/');
  for (let depth = 1; depth <= segments.length; depth += 1) {
    // A trailing slash names a directory. It removes the files below that
    // directory, not a file that happens to have the directory's name.
    if (directoryOnly === true && depth === segments.length) continue;
    const candidate = segments.slice(0, depth).join('/');
    if (anchored === true || clean.includes('/') === true) {
      if (globMatches(candidate, clean) === true) return true;
    } else {
      // npm compiles ignore rules with minimatch's matchBase: a pattern with
      // no slash matches a basename at any depth (`*.test.js`).
      const basename = candidate.slice(candidate.lastIndexOf('/') + 1);
      if (globMatches(basename, clean) === true) return true;
    }
  }
  return false;
}

/** Whether the last matching rule in one ignore file excludes `relative`. */
function ignoredByRules(relative, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (ignoreRuleMatches(relative, rule.pattern) === true) ignored = rule.negate === false;
  }
  return ignored;
}

/**
 * The subdirectory ignore file that makes `npm pack` drop `target`, or null.
 *
 * npm walks the tree and applies each directory's own ignore file to the paths
 * below it. The shallowest directory that excludes the path stops the walk, so
 * a deeper ignore file cannot re-include what a parent removed. An explicit
 * file entry in `files` is the one exception: npm marks it as required and
 * packs it even when a subdirectory `.npmignore` names it.
 */
function subdirectoryIgnoreFor(dir, target) {
  const root = path.resolve(dir);
  const wanted = packagePath(target);
  // A wildcard export names a set of files, not one path. npm decides that set
  // while packing, so a single ignore rule cannot say the whole export is gone.
  if (GLOB_MAGIC.test(wanted) === true) return null;
  const segments = wanted.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length < 2 || segments.includes('..') === true) return null;

  for (let depth = 1; depth < segments.length; depth += 1) {
    const directory = path.join(root, ...segments.slice(0, depth));
    if (directory.startsWith(`${root}${path.sep}`) === false) return null;
    const ignore = subdirectoryIgnoreFile(directory);
    if (ignore === null) continue;
    const relative = segments.slice(depth).join('/');
    if (ignoredByRules(relative, ignore.rules) === true) return ignore.file;
  }
  return null;
}

/** True when `files` names `target` as a file, which npm marks as required. */
function explicitlyListedFile(dir, target, files) {
  const wanted = packagePath(target);
  for (const entry of files) {
    if (typeof entry !== 'string' || entry.startsWith('!')) continue;
    const clean = packagePath(entry).replace(/\/+$/u, '');
    if (clean !== wanted || clean === '') continue;
    try {
      if (fs.statSync(path.join(dir, clean)).isFile() === true) return true;
    } catch {
      // npm treats a path that is not there as a pattern, so nothing is
      // required and a subdirectory ignore file still applies.
    }
  }
  return false;
}

/**
 * npm always puts these in the tarball whatever `files` says, so a `files` list
 * that omits them is not a packaging bug. `main`, `browser` and every `bin`
 * target are on the same list: npm adds the files those fields name even when
 * `files` does not mention them. A path can be both a published `bin` and an
 * `exports` subpath, and rejecting that package would tell the author to list a
 * file npm was going to pack anyway.
 *
 * The names follow npm-packlist's strict rules. README, COPYING, LICENSE and
 * LICENCE match with any suffix after a dot (npm's `{,.*[^~$]}`), and a
 * CHANGELOG is not on the list: `npm pack` drops a changelog the `files` list
 * omits. `main` and `browser` are added to the strict rules verbatim, so a
 * value written `./index.js` does not match the tarball path `index.js` and is
 * dropped when `files` omits it; only the exact spelling is always shipped.
 * npm normalises a `bin` target, so `./bin/cli.mjs` is still always shipped.
 *
 * A subdirectory `.npmignore` can still drop these files, so the caller has to
 * ask the ignore question separately; this predicate only covers the `files`
 * list part of npm's rules.
 */
const binPath = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/^(?:\.\/)+/u, '');
  return normalized === '' ? null : normalized;
};

const ALWAYS_SHIPPED = (entry, manifest) => {
  if (entry === 'package.json') return true;
  if (/^(?:readme|copying|licen[cs]e)(?:\.[^/]*[^/~$])?$/iu.test(entry)) return true;
  // npm writes the rule as `!/${main}` and `!/${browser}`, so the comparison is
  // against the raw field; stripping `./` here hid a file npm really drops.
  if (entry === manifest.main || entry === manifest.browser) return true;
  // npm treats a string `bin` as the single executable, and an object as the
  // command-to-file map. Read both shapes from the manifest rather than relying
  // on npm's normalisation, because `doctor` reads `package.json` raw.
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
  return bins.some((bin) => binPath(bin) === entry);
};

/**
 * The paths `package.json` points at that its own `files` list (or the
 * subdirectory ignore files npm applies on top of it) would omit.
 *
 * `dir` is optional because `doctor --remote` and `audit --remote` only have
 * the manifest GitHub serves. Without a tree there is nothing to read, so the
 * remote check keeps its manifest-only answer instead of guessing.
 */
export function missingDeclaredPaths(manifest, dir = undefined) {
  const files = manifest.files;
  if (Array.isArray(files) === false) return [];
  const declared = declaredPaths(manifest);
  const root = dir === undefined ? null : path.resolve(dir);
  return declared.filter((entry) => {
    const alwaysShipped = ALWAYS_SHIPPED(entry, manifest);
    if (alwaysShipped === false && isShipped(entry, files, root ?? undefined) === false) return true;
    if (root === null) return false;
    // npm's synthetic rule for an explicit file in `files` re-includes that
    // file, so a subdirectory `.npmignore` cannot drop it.
    if (explicitlyListedFile(root, entry, files) === true) return false;
    return subdirectoryIgnoreFor(root, entry) !== null;
  });
}

export function checkFilesList(manifest, dir = undefined) {
  if (Array.isArray(manifest.files) === false) {
    return 'package.json has no "files" list, so the tarball ships whatever happens to be in the folder';
  }
  const missing = missingDeclaredPaths(manifest, dir);
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
  const exported = manifest.exports;
  // A string `exports` is the root itself. A conditions object is only visible
  // through `exports["."]`, and treating it as "no root" let a plugin whose
  // root resolved to the CLI pass both doctor and verify.
  const root =
    typeof exported === 'string'
      ? exported
      : typeof exported === 'object' && exported !== null
        ? exported['.']
        : undefined;
  const entry = exportTarget(root) ?? manifest.main;
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

  // A root that cannot be loaded is the same failure as one that exports no
  // apply: the loader imports the bare package name and the row mounts nothing.
  // Missing files and directories are the two shapes a manifest actually ships
  // by accident, and the directory case used to escape as a raw EISDIR. Ask
  // the filesystem what the path is before reading it, so a directory, a
  // broken symlink and an unreadable file all become a named check failure.
  const file = path.resolve(dir, target);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return `the root export ${entry} does not exist, so the loader cannot import the package`;
    }
    return `the root export ${entry} cannot be read (${error?.code ?? 'filesystem error'}), so the loader cannot import the package`;
  }
  if (stat.isDirectory() === true) {
    return `the root export ${entry} is a directory, not a module, so the loader cannot import it`;
  }
  if (stat.isFile() === false) {
    return `the root export ${entry} is not a regular file, so the loader cannot import it`;
  }
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return `the root export ${entry} cannot be read (${error?.code ?? 'filesystem error'}), so the loader cannot import it`;
  }
  if (exportsApply(source) === false) {
    return `the root export ${entry} does not export apply, so the loader imports the package and mounts nothing`;
  }
  return null;
}

/**
 * Replace comments and the contents of string, template and regex literals
 * with spaces, keeping newlines. The export check is a source question, not an
 * execution: `doctor` must never import the plugin it is checking, and an
 * `apply` written in prose or a message is not an export. This is deliberately
 * a small lexer rather than a module evaluator or a new dependency.
 */
function codeOnly(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  const blank = (text) => text.replace(/[^\r\n]/gu, ' ');

  /** True when a `/` here starts a regex literal rather than a division. */
  const regexMayStart = () => {
    const trimmed = out.trimEnd();
    if (trimmed === '') return true;
    const last = trimmed.at(-1);
    if ('([{,;:=!?&|+-*%^~<>'.includes(last)) return true;
    const word = /([A-Za-z_$][\w$]*)$/u.exec(trimmed)?.[1];
    return (
      word !== undefined &&
      ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'yield', 'await', 'case', 'throw', 'else', 'do'].includes(word)
    );
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // A shebang is a comment line, even though it does not use `//`.
    if (i === 0 && ch === '#' && next === '!') {
      let end = source.indexOf('\n', i);
      if (end === -1) end = n;
      out += blank(source.slice(i, end));
      i = end;
      continue;
    }

    if (ch === '/' && next === '/') {
      let end = i + 2;
      while (end < n && source[end] !== '\n' && source[end] !== '\r') end++;
      out += blank(source.slice(i, end));
      i = end;
      continue;
    }

    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      out += blank(source.slice(i, end));
      i = end;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const start = i;
      i++;
      while (i < n) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === ch) {
          i++;
          break;
        }
        i++;
      }
      // Keep the delimiters so adjacent code does not become one token; the
      // literal's contents are not code and cannot export anything.
      out += ch + blank(source.slice(start + 1, source[i - 1] === ch ? i - 1 : i)) + (source[i - 1] === ch ? ch : '');
      continue;
    }

    if (ch === '/' && regexMayStart()) {
      const start = i;
      let inClass = false;
      i++;
      while (i < n) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '\n' || source[i] === '\r') break;
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && inClass === false) {
          i++;
          while (i < n && /[a-z]/iu.test(source[i])) i++;
          break;
        }
        i++;
      }
      out += blank(source.slice(start, i));
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/** The exported name of each specifier in `export { ... }`, comments removed. */
function exportedNames(code) {
  const names = [];
  for (const match of code.matchAll(/\bexport\s*\{([^}]*)\}/gu)) {
    for (const part of match[1].split(',')) {
      const specifier = /^\s*(?:([\w$]+)\s+as\s+)?([\w$]+)\s*$/u.exec(part);
      if (specifier === null) continue;
      // The second name is the exported one: `helper as apply` exports apply.
      names.push(specifier[2]);
    }
  }
  return names;
}

/** True when a CommonJS module assigns an `apply` function to its exports. */
function commonJsExportsApply(code) {
  if (/\b(?:module\s*\.\s*)?exports\s*\.\s*apply\s*=/u.test(code)) return true;
  for (const match of code.matchAll(/\bmodule\s*\.\s*exports\s*=\s*\{([^}]*)\}/gu)) {
    if (/(?:^|,)\s*(?:async\s+)?apply\s*(?::|\(|,|$)/mu.test(match[1])) return true;
  }
  return false;
}

/**
 * True when the module source exports `apply` in any of the forms a plugin
 * actually uses. Factored out because `doctor --remote` asks the same question
 * about a file it read over the API, and two copies would drift.
 *
 * Comments, strings and regex literals are removed first, so a comment saying
 * "TODO: export function apply() {}" is not mistaken for the export it tells
 * the author to write.
 */
export function exportsApply(source) {
  if (typeof source !== 'string') return false;
  const code = codeOnly(source);
  if (/\bexport\s+(?:async\s+)?function\s*\*?\s*apply\b/u.test(code)) return true;
  if (/\bexport\s+(?:const|let|var)\s+apply\b/u.test(code)) return true;
  if (exportedNames(code).includes('apply')) return true;
  return commonJsExportsApply(code);
}

/** Runs every check and returns `{ failures, notes }`. */
export function doctor(dir, { installed = false } = {}) {
  const target = resolvePath(dir);
  const { manifest } = readManifest(target);
  const checks = [
    ['name', checkName(manifest)],
    ['version', checkVersion(manifest)],
    ['engines.dsh', checkHostRange(manifest)],
    ['readme', checkReadme(target)],
    ['dsh field', checkDshField(manifest)],
    ['patch file', checkPatchFile(target, manifest)],
    ['client entry', checkClientEntry(target, manifest)],
    ['client declaration', checkClientDeclaration(target, manifest)],
    // After install the tarball is already unpacked, so `files` cannot be used to
    // decide what shipped: npm always ships package.json and the README.
    ['files list', installed === true ? null : checkFilesList(manifest, target)],
    ['root export', checkRootExport(target, manifest)],
  ];
  const failures = checks.filter(([, result]) => result !== null && typeof result === 'string');
  return {
    manifest,
    failures: failures.map(([name, message]) => ({ check: name, message })),
    notes: { hostRange: hostRange(manifest), version: version(manifest) },
  };
}
