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

import { checkHostCompatibility, doctor, hostRange, version as manifestVersion } from './doctor.mjs';
import { hostCompatibility } from './compat.mjs';
import { readGraph } from './dev.mjs';
import { auditRemote, fixRemote } from './remote.mjs';
import { resolvePath } from './paths.mjs';

export { hostCompatibility } from './compat.mjs';

const DEFAULT_HOME = path.join(os.homedir(), '.dsh');

/** How many repositories a batch audit reads at once when `--jobs` is absent. */
export const DEFAULT_JOBS = 4;
/** The most repositories a batch audit will read at once, whatever `--jobs` says. */
export const MAX_JOBS = 8;

/**
 * Turn `--jobs` into a worker count. Anything that is not a positive whole
 * number is refused rather than quietly becoming the default; a value above
 * the ceiling is capped, because "as parallel as possible" should never turn
 * into a hundred simultaneous GitHub requests and one rate-limit lockout.
 */
export function parseJobs(value) {
  if (value === undefined || value === null) return DEFAULT_JOBS;
  const text = typeof value === 'number' ? String(value) : String(value).trim();
  if (/^\d+$/u.test(text) === false) {
    throw new Error(
      `--jobs needs a positive whole number, got ${JSON.stringify(value)}; concurrency is capped at ${MAX_JOBS}`,
    );
  }
  const jobs = Number(text);
  if (Number.isSafeInteger(jobs) === false || jobs < 1) {
    throw new Error(
      `--jobs needs a positive whole number, got ${JSON.stringify(value)}; concurrency is capped at ${MAX_JOBS}`,
    );
  }
  return Math.min(jobs, MAX_JOBS);
}

/**
 * The loader mounts a package only when its name is in the profile's
 * `dsh.profile.bundles` list. `pnpm add` puts the package in `node_modules` but
 * does not edit that list, which is why "installed" and "mounted" are not the
 * same thing.
 */
export function readProfileBundles({ home = DEFAULT_HOME, profile } = {}) {
  const root = resolvePath(home);
  const file = path.join(root, 'profiles', profile, 'package.json');
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

/**
 * A package whose `package.json` cannot be read is normally indistinguishable
 * from an ordinary dependency, because the `dsh` field that marks a plugin lives
 * in the file that failed to parse. The profile's `dsh.profile.bundles` list is
 * the other record of what the user installed, so it is what lets an
 * interrupted install be reported instead of disappearing from the audit.
 */
function unreadableInstalled({ dir, name, profile, manifestPath, message }) {
  return {
    dir,
    manifest: { name },
    profile,
    manifestPath,
    unreadable: true,
    error: message,
  };
}

/** Every package folder inside every profile, scoped names included. */
export function listInstalled({ home = DEFAULT_HOME } = {}) {
  const root = resolvePath(home);
  const profiles = path.join(root, 'profiles');
  if (fs.existsSync(profiles) === false) return [];
  const found = [];
  for (const profile of fs.readdirSync(profiles).sort()) {
    const modules = path.join(profiles, profile, 'node_modules');
    if (fs.existsSync(modules) === false) continue;
    const declared = new Set(readProfileBundles({ home, profile }).bundles);
    for (const entry of fs.readdirSync(modules).sort()) {
      if (entry.startsWith('.') === true) continue;
      const candidates = entry.startsWith('@')
        ? fs
            .readdirSync(path.join(modules, entry))
            .sort()
            .map((name) => ({ dir: path.join(modules, entry, name), name: `${entry}/${name}` }))
        : [{ dir: path.join(modules, entry), name: entry }];
      for (const { dir, name } of candidates) {
        // A broken package.json is only evidence of a plugin when the profile
        // says it mounts that name. Without that record an ordinary dependency
        // whose install was interrupted must stay out of the audit, or one bad
        // transitive package would turn every profile red.
        const listedInProfile = declared.has(name) === true;
        const manifestPath = path.join(dir, 'package.json');
        if (fs.existsSync(manifestPath) === false) {
          if (listedInProfile === true) {
            found.push(
              unreadableInstalled({
                dir,
                name,
                profile,
                manifestPath,
                message: `${manifestPath} is missing, so the installed copy has no manifest to read`,
              }),
            );
          }
          continue;
        }
        let manifest;
        try {
          // Strip the BOM the same way doctor does: a manifest saved by Notepad
          // is still readable, and treating it as unreadable would be a false
          // alarm in the other direction.
          const text = String(fs.readFileSync(manifestPath, 'utf8')).replace(/^\uFEFF/u, '').trim();
          manifest = JSON.parse(text);
        } catch (error) {
          // A package.json that is listed in the profile but does not parse is
          // still an installed plugin, and "it does not parse" is exactly what
          // the author needs to hear.
          if (listedInProfile === true) {
            found.push(
              unreadableInstalled({
                dir,
                name,
                profile,
                manifestPath,
                message: `${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
              }),
            );
          }
          continue;
        }
        if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) === true) {
          if (listedInProfile === true) {
            found.push(
              unreadableInstalled({
                dir,
                name,
                profile,
                manifestPath,
                message: `${manifestPath} is readable JSON but not a package object, so its dsh field cannot be checked`,
              }),
            );
          }
          continue;
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

/**
 * `audit --remote` takes a comma-separated list, so one call can cover the
 * repositories the hub reported in one sitting. Whitespace around entries is
 * ignored; repeated `--remote` flags are joined by the flag parser. The same
 * parser also accepts one target per line, which is what `--from` reads.
 */
export function parseRemoteTargets(value) {
  const values = Array.isArray(value) ? value : [value];
  const targets = [];
  for (const entry of values) {
    if (entry === undefined || entry === null) continue;
    for (const part of String(entry).replace(/^\uFEFF/u, '').split(/[\r\n,]+/u)) {
      let target = part.trim();
      if (target === '' || target.startsWith('#') === true) continue;
      // A file written by hand often explains an entry on the same line.
      const comment = target.search(/\s#/u);
      if (comment !== -1) target = target.slice(0, comment).trim();
      if (
        target.length >= 2 &&
        ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'")))
      ) {
        target = target.slice(1, -1).trim();
      }
      if (target !== '') targets.push(target);
    }
  }
  return targets;
}

function collectJsonTargets(value, found, depth = 0) {
  if (value === undefined || value === null || depth > 6) return;
  if (typeof value === 'string') {
    found.push(...parseRemoteTargets(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectJsonTargets(entry, found, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;

  // A list wrapper is the common shape: an evidence file keeps its rows under
  // `rows`, while an API response may call the same array `items`.
  for (const key of ['targets', 'repositories', 'repos', 'rows', 'plugins', 'items']) {
    if (value[key] !== undefined && value[key] !== value) collectJsonTargets(value[key], found, depth + 1);
  }

  const candidate = value.target ?? value.slug ?? value.repo ?? value.full_name ?? value.fullName ?? value.repository;
  if (candidate !== undefined && candidate !== value) collectJsonTargets(candidate, found, depth + 1);

  if (value.owner !== undefined && value.name !== undefined && typeof value.owner === 'string') {
    found.push(...parseRemoteTargets(`${value.owner}/${value.name}`));
  }
  if (value.owner !== undefined && value.name !== undefined && typeof value.owner === 'object') {
    const login = value.owner.login ?? value.owner.name;
    if (typeof login === 'string' && typeof value.name === 'string') {
      found.push(...parseRemoteTargets(`${login}/${value.name}`));
    }
  }
}

/**
 * A `--from` file may be the newline list a shell loop used before this
 * command existed, or the JSON evidence that loop printed. Both mean the same
 * thing to the audit, so both are accepted; anything else is an error rather
 * than a silently empty batch.
 */
export function parseRemoteList(text, source = 'the list') {
  if (Array.isArray(text) === true) return parseRemoteTargets(text);
  const clean = String(text ?? '').replace(/^\uFEFF/u, '').trim();
  if (clean === '') return [];
  if (clean.startsWith('[') === true || clean.startsWith('{') === true) {
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (error) {
      throw new Error(`${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const found = [];
    collectJsonTargets(parsed, found);
    const targets = [...new Set(parseRemoteTargets(found))];
    if (targets.length === 0) throw new Error(`${source} does not contain any owner/repo entries`);
    return targets;
  }
  return parseRemoteTargets(clean);
}

async function readStdin(stream) {
  if (typeof stream === 'string' || Buffer.isBuffer(stream) === true) return String(stream);
  if (stream === undefined || stream === null) throw new Error('--from - needs standard input');
  let text = '';
  for await (const chunk of stream) text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  return text;
}

/** Read the target list named by `--from`, with `-` meaning standard input. */
export async function readRemoteTargets({ from, stdin = process.stdin, readFile = fs.readFileSync } = {}) {
  const source = String(from ?? '').trim();
  if (source === '') throw new Error('--from needs a file path, or - to read the list from standard input');
  if (source === '-') {
    const text = await readStdin(stdin);
    return parseRemoteList(text, 'standard input');
  }
  const file = resolvePath(source);
  let text;
  try {
    text = readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseRemoteList(text, file);
}

/**
 * The file a batch repair writes for one repository. The owner and repository
 * are joined by `__`, which is not a character GitHub allows inside either
 * half of a slug, so `a/b-c` and `a-b/c` never land on the same path. The
 * directory is named by the caller; this only turns `owner/repo` (or the
 * github.com URL for it) into a basename. It deliberately does not consult the
 * filesystem the way `parseTarget` does: an existing local folder must not
 * change the name of a patch for the remote repository.
 */
export function patchFileName(target) {
  const raw = String(target ?? '').trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/.*)?$/iu.exec(raw);
  const slug = url === null ? raw : `${url[1]}/${url[2].replace(/\.git$/iu, '')}`;
  const parts = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(slug);
  if (parts === null) throw new Error(`${JSON.stringify(raw)} is not owner/repo, so it cannot name a patch file`);
  return `${parts[1]}__${parts[2]}.patch`;
}

function noteMessages(report) {
  if (Array.isArray(report?.notes)) return report.notes;
  const messages = report?.notes?.messages;
  if (Array.isArray(messages)) return messages;
  if (typeof report?.notes?.message === 'string') return [report.notes.message];
  return [];
}

/**
 * The machine-readable row for one repository. Keep this flat: a CI job can
 * read `target`, `version`, `hostRange`, `failures` and `notes` without knowing
 * anything about the GitHub response that produced them. A read that failed
 * carries `unreadable: true` so a consumer cannot mistake it for a pass.
 */
export function remoteFinding(report, host) {
  const manifest = report?.manifest ?? null;
  const finding = {
    target: report?.target?.slug ?? String(report?.target ?? ''),
    version: manifest === null ? null : manifestVersion(manifest),
    hostRange: manifest === null ? null : hostRange(manifest),
    failures: (report?.failures ?? []).map((failure) => ({
      check: failure.check,
      message: failure.message,
    })),
    notes: noteMessages(report)
      .map((note) => (typeof note === 'string' ? note : String(note?.message ?? '')))
      .filter((note) => note.length > 0),
  };
  if (report?.unreadable === true && report?.rateLimited !== true) finding.unreadable = true;
  if (report?.rateLimited === true) {
    finding.rateLimited = true;
    if (report.rateLimit !== undefined) finding.rateLimit = report.rateLimit;
  }
  return withHostCompatibility(finding, host);
}

/**
 * Add the answer to the question the reports ask: will this range install on
 * the host the reader is running? The field is only present when `--host`
 * names a version, so an audit of the manifest alone keeps its old shape.
 */
function withHostCompatibility(row, host) {
  const text = typeof host === 'string' ? host.trim() : '';
  if (text === '') return row;
  const range = row.hostRange ?? null;
  // `doctor` owns the definition of a range this project accepts. A pin that
  // npm could compare is still not an `engines.dsh` range here, so it is
  // unknown rather than a confident answer the manifest will not honour.
  const compatibility =
    typeof range === 'string' ? checkHostCompatibility({ engines: { dsh: range } }, text) : 'unknown';
  return {
    ...row,
    host: text,
    compatibility,
  };
}

function verdictOf(row, unreadable) {
  if (row?.rateLimited === true) return 'rate-limited';
  if (unreadable === true) return 'unreadable';
  if (row?.compatibility === 'incompatible') return 'incompatible';
  return row.failures.length > 0 ? 'failing' : 'clean';
}

function compatibilitySuffix(row) {
  if (typeof row?.host !== 'string') return '';
  const declared = row.hostRange === null ? 'no engines.dsh range' : JSON.stringify(row.hostRange);
  return ` [${row.compatibility} with dsh ${row.host}; declares ${declared}]`;
}

function oneLine(row, unreadable) {
  const suffix = compatibilitySuffix(row);
  if (row?.rateLimited === true) {
    const note = row.notes[0] ?? 'GitHub rate-limited the batch, so this repository was not read';
    const reset = row.rateLimit?.resetAt;
    const resetSuffix =
      typeof reset === 'string' && note.includes('resets at') === false ? `; the limit resets at ${reset}` : '';
    return `— ${note}${resetSuffix}${suffix}`;
  }
  if (unreadable === true) {
    return `— ${row.notes[0] ?? 'the repository could not be read'}${suffix}`;
  }
  if (row.failures.length > 0) {
    const first = row.failures[0];
    const more = row.failures.length === 1 ? '' : ` (+${row.failures.length - 1} more)`;
    return `— ${first.check}: ${first.message}${more}${suffix}`;
  }
  const note = row.notes.length === 0 ? '' : ` — note: ${row.notes[0]}`;
  return `${row.version ?? '?'} (host ${row.hostRange ?? '?'})${note}${suffix}`;
}

/**
 * Audit a list of published repositories. A read that failed is a note and an
 * explicitly unreadable repository, never an empty `failures` array that reads
 * as a pass. One bad target does not stop the rest of the list.
 */
export async function auditRemoteTargets(
  input,
  {
    fetchImpl,
    token,
    ref,
    io = console,
    json = false,
    from,
    stdin,
    patchDir,
    overwrite = false,
    jobs: jobsOption,
    host,
  } = {},
) {
  const hostVersion = typeof host === 'string' ? host.trim() : '';
  let targets;
  if (from !== undefined && from !== null) {
    targets = await readRemoteTargets({ from, stdin });
    if (input !== undefined && input !== null && input !== true) {
      targets = [...parseRemoteTargets(input), ...targets];
    }
  } else if (input === '-' || input === '') {
    targets = await readRemoteTargets({ from: '-', stdin });
  } else {
    targets = parseRemoteList(input);
  }
  if (targets.length === 0) throw new Error('audit --remote needs at least one owner/repo');
  const jobs = parseJobs(jobsOption);

  // The directory is created even when every repository is clean: a caller
  // that names an output directory should be able to rely on it existing, and
  // an empty directory is the honest answer to "no repairs needed".
  let patchRoot = null;
  if (patchDir !== undefined && patchDir !== null && String(patchDir).trim() !== '') {
    patchRoot = resolvePath(patchDir);
    fs.mkdirSync(patchRoot, { recursive: true });
  }

  // Audits overlap, but the list does not: each worker takes the next target,
  // and every result is stored at the target's own index. GitHub sees at most
  // `jobs` repositories at once, while the report below still reads in the
  // order the file listed them.
  //
  // A 403/429 means the shared quota is gone. One batch-wide state object is
  // handed to every running audit, and a worker checks it before taking another
  // repository, so the rest of the list is reported without being requested
  // against a limit that is already exhausted. Audits already in flight are
  // allowed to finish, because their reads were launched before the answer
  // came back.
  const rateLimitState = { limited: false, info: null };
  const skipped = (target) => {
    const reset = rateLimitState.info?.resetAt;
    const row = {
      target: String(target),
      version: null,
      hostRange: null,
      failures: [],
      notes: [
        `GitHub rate-limited the batch before this repository was read, so it was not requested${
          typeof reset === 'string' ? `; the limit resets at ${reset}` : ''
        }`,
      ],
      rateLimited: true,
      ...(rateLimitState.info === null ? {} : { rateLimit: rateLimitState.info }),
    };
    return {
      target,
      row: withHostCompatibility(row, hostVersion),
      problem: true,
      unreadable: false,
      rateLimited: true,
      manifestText: undefined,
    };
  };
  const auditOne = async (target) => {
    let row;
    let problem;
    let unreadable = false;
    let rateLimited = false;
    let manifestText;
    try {
      const report = await auditRemote(target, {
        fetchImpl,
        token,
        ref,
        readErrors: 'note',
        rateLimitState,
        // Keep the host answer on the report itself as well as the printed row.
        // A batch may schedule this read beside other repositories, but the
        // compatibility verdict must not depend on which worker finished first.
        ...(hostVersion === '' ? {} : { host: hostVersion }),
      });
      row = remoteFinding(report, hostVersion);
      manifestText = report.raw;
      rateLimited = row.rateLimited === true;
      unreadable = row.unreadable === true;
      problem = rateLimited || unreadable || row.failures.length > 0 || row.compatibility === 'incompatible';
    } catch (error) {
      row = withHostCompatibility(
        {
          target: String(target),
          version: null,
          hostRange: null,
          failures: [{ check: 'target', message: error instanceof Error ? error.message : String(error) }],
          notes: [],
        },
        hostVersion,
      );
      problem = true;
    }
    return { target, row, problem, unreadable, rateLimited, manifestText };
  };

  const rows = new Array(targets.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= targets.length) return;
      // Once the quota is gone, the remaining entries are reported without
      // another request. This is what keeps a batch from turning one 403 into
      // a five-minute run of identical failures.
      if (rateLimitState.limited === true) {
        rows[index] = skipped(targets[index]);
        continue;
      }
      const result = await auditOne(targets[index]);
      rows[index] = result;
      if (result.rateLimited === true && rateLimitState.limited !== true) {
        rateLimitState.limited = true;
        rateLimitState.info = result.row.rateLimit ?? null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, targets.length) }, () => worker()));

  // Patches are collected after the reads finish, in list order. The repository
  // read is what was slow; the repair itself reuses the manifest the audit
  // already holds, so keeping the writes in order also keeps duplicate targets
  // behaving exactly as they did in the sequential loop.
  const patches = [];
  let ok = true;
  for (const { target, row, problem, unreadable, rateLimited, manifestText } of rows) {
    if (problem) ok = false;

    // A patch is only possible for a repository that was readable and whose
    // manifest failed the engine check. A failure that needs a human edit (a
    // missing README, a patch file that is not in the tree) leaves no file
    // behind rather than pretending an empty diff is a repair. A rate-limited
    // repository has no manifest to repair from, so it is never patched.
    if (patchRoot !== null && problem === true && unreadable === false && rateLimited !== true) {
      const repairable =
        row.failures.some((failure) => failure.check === 'engines.dsh') || row.compatibility === 'incompatible';
      if (repairable === true) {
        const patchPath = path.join(patchRoot, patchFileName(target));
        try {
          const repair = await fixRemote(target, {
            fetchImpl,
            token,
            ref,
            manifestText,
            ...(hostVersion === '' ? {} : { host: hostVersion }),
            patch: patchPath,
            overwrite: overwrite === true,
          });
          if (repair.changed === true && repair.patchWritten === true) {
            row.patch = patchPath;
            patches.push({ target: row.target, path: patchPath, written: true });
          } else {
            patches.push({
              target: row.target,
              path: patchPath,
              written: false,
              reason: 'engines.dsh already clears the check',
            });
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          row.patchError = reason;
          patches.push({ target: row.target, path: patchPath, written: false, reason });
        }
      } else {
        const check = row.failures[0]?.check ?? 'this failure';
        patches.push({
          target: row.target,
          path: null,
          written: false,
          reason: `no automatic repair for ${check}`,
        });
      }
    }
  }

  const reports = rows.map(({ row }) => row);
  const failingRows = rows.filter(({ problem, unreadable, row }) => {
    return problem === true && unreadable === false && row.rateLimited !== true;
  });
  const summary = {
    total: rows.length,
    repositories: rows.length,
    clean: rows.filter(({ problem }) => problem === false).length,
    failing: failingRows.length,
    // A repository can fail more than one check, so the count in the summary
    // is the number of failed checks, not the number of failing repositories.
    // An incompatible host has no `failures` entry of its own, so it still
    // counts as one problem for its repository.
    problems: failingRows.reduce((count, { row }) => count + Math.max(1, row.failures.length), 0),
    unreadable: rows.filter(({ unreadable, row }) => unreadable === true && row.rateLimited !== true).length,
    rateLimited: rows.filter(({ row }) => row.rateLimited === true).length,
  };
  if (patchRoot !== null) summary.patches = patches.filter(({ written }) => written === true).length;

  if (json === true) {
    io.log(JSON.stringify(reports, null, 2));
  } else {
    const width = Math.max(
      'rate-limited'.length,
      'unreadable'.length,
      ...rows.map(({ row, unreadable }) => verdictOf(row, unreadable).length),
    );
    for (const { row, unreadable } of rows) {
      io.log(`${verdictOf(row, unreadable).padEnd(width)}  ${row.target}  ${oneLine(row, unreadable)}`);
    }
    const plural = summary.total === 1 ? 'repository' : 'repositories';
    const problems = summary.problems === 1 ? 'problem' : 'problems';
    io.log('');
    io.log(
      `summary: ${summary.total} ${plural} — ${summary.clean} clean, ${summary.failing} failing (${summary.problems} ${problems}), ${summary.unreadable} unreadable, ${summary.rateLimited} rate-limited`,
    );
    if (patchRoot !== null) {
      for (const patch of patches) {
        if (patch.written === true) io.log(`patch: ${patch.target} → ${patch.path}`);
        else io.log(`patch: ${patch.target} — not written: ${patch.reason}`);
      }
      const count = summary.patches === 1 ? 'patch' : 'patches';
      io.log(`${summary.patches} ${count} written to ${patchRoot}`);
    }
  }
  const outcome = { ok, reports, summary };
  if (patchRoot !== null) outcome.patches = patches;
  return outcome;
}

export async function audit({
  home,
  host,
  remote,
  from,
  patchDir,
  force = false,
  json = false,
  io = console,
  fetchImpl,
  token,
  ref,
  stdin,
  jobs,
  timeoutMs = 3000,
} = {}) {
  if ((remote !== undefined && remote !== null) || from !== undefined) {
    return auditRemoteTargets(remote, {
      fetchImpl,
      token,
      ref,
      io,
      json,
      from,
      stdin,
      patchDir,
      overwrite: force === true,
      jobs,
      host,
    });
  }
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
  const rows = installed.map(({ dir, manifest, profile, manifestPath, unreadable = false, error }) => {
    let failures;
    if (unreadable === true) {
      // doctor would throw on the same file; keep the read error the install
      // scan already recorded so the row names the unreadable package.json.
      failures = [{ check: 'manifest', message: error }];
    } else {
      try {
        ({ failures } = doctor(dir, { installed: true }));
      } catch (caught) {
        failures = [{ check: 'manifest', message: caught.message }];
      }
    }
    const loaded = graph?.ok === true ? graph.ids.has(manifest.name) : null;
    let explanation = null;
    if (unreadable === true) {
      explanation = {
        reason: `${manifestPath} is unreadable, so the loader cannot tell what to mount`,
        action: `reinstall ${manifest.name} so its package.json is written completely`,
      };
    } else if (loaded === false) {
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
      unreadable: unreadable === true,
      reason: explanation?.reason ?? null,
      action: explanation?.action ?? null,
    };
  });

  const width = Math.max(...rows.map((row) => row.name.length), 6);
  const detailIndent = ' '.repeat(width + 24);
  for (const row of rows) {
    const state =
      row.unreadable === true ? 'unreadable' : row.loaded === null ? '?' : row.loaded === true ? 'loaded' : 'not loaded';
    const reason = row.loaded === false || row.unreadable === true ? `  — ${row.reason}` : '';
    io.log(`${row.name.padEnd(width)}  ${String(row.version).padEnd(8)}  ${state.padEnd(10)}  ${describe(row)}${reason}`);
    for (const failure of row.failures) io.log(`${' '.repeat(width + 22)}${failure.check}: ${failure.message}`);
    if (row.loaded === false || row.unreadable === true) io.log(`${detailIndent}fix: ${row.action}`);
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
