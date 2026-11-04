/**
 * `dsh-plugin doctor --remote owner/repo` — the same questions doctor asks a
 * folder, asked of a published repository over the GitHub API.
 *
 * It exists because the install failures we see in the wild (the hub files the
 * same "plugin install failed" issue in dozens of plugin repositories) are
 * almost always visible in `package.json` alone: a missing `engines.dsh`, a
 * `dsh.client` with no `exports["./client"]`, a root export that points at the
 * CLI. A maintainer should not have to clone the tree — or install the plugin
 * into a throwaway profile — to learn which of those it is.
 *
 * Everything here is read-only and needs no token for public repositories. The
 * network call is injectable so the tests never touch GitHub.
 */
import { checkFilesList, checkHostRange, checkVersion, exportTarget, exportsApply, rootEntry } from './doctor.mjs';
import { parseTarget as classifyTarget } from './github.mjs';

const API = 'https://api.github.com';
const HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-plugin-toolkit',
};

/**
 * A token is optional for public repositories, but the unauthenticated limit
 * is 60 requests per hour — enough for one repository, not for an afternoon of
 * auditing. `GH_TOKEN` is what the GitHub CLI reads, so it is the one people
 * already have exported.
 */
export function tokenOf(env = process.env) {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * `owner/repo` and GitHub URLs become an API target. A local folder or a bare
 * name is refused with the command that does handle it — `lib/github.mjs`
 * already decides what an input means, and two copies of that decision would
 * drift.
 */
export function parseTarget(target) {
  const parsed = classifyTarget(target);
  if (parsed.kind === 'repo') {
    const { owner, repo } = parsed;
    return { owner, repo, slug: `${owner}/${repo}` };
  }
  if (parsed.kind === 'local') {
    throw new Error(`${JSON.stringify(target)} is a folder on this machine; run \`dsh-plugin doctor ${target}\` instead`);
  }
  if (parsed.kind === 'search') {
    throw new Error(
      `${JSON.stringify(target)} is a name, not owner/repo; run \`dsh-plugin doctor --remote <owner>/<repo>\` with the slug GitHub shows`,
    );
  }
  throw new Error('expected owner/repo or a github.com URL, got nothing');
}

async function readFile(owner, repo, file, { fetchImpl, ref, token }) {
  const query = ref === undefined ? '' : `?ref=${encodeURIComponent(ref)}`;
  const url = `${API}/repos/${owner}/${repo}/contents/${file}${query}`;
  let response;
  try {
    const headers = token === null || token === undefined ? HEADERS : { ...HEADERS, authorization: `Bearer ${token}` };
    response = await fetchImpl(url, { headers });
  } catch (error) {
    throw new Error(`cannot reach GitHub for ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response === undefined || response === null) throw new Error(`no response for ${file}`);
  if (response.status === 404) return null;
  if (response.status === 403 || response.status === 429) {
    throw new Error(
      `GitHub rate-limited this request (${response.status}) for ${file}; set GH_TOKEN or GITHUB_TOKEN to raise the limit`,
    );
  }
  if (response.ok !== true) throw new Error(`GitHub answered ${response.status} for ${file}`);
  const body = await response.json();
  if (body === null || typeof body !== 'object' || typeof body.content !== 'string' || body.encoding !== 'base64') {
    throw new Error(`${file} came back without base64 content`);
  }
  return Buffer.from(body.content.replace(/\n/gu, ''), 'base64').toString('utf8');
}

const CLIENT_FILES = ['client.js', 'lib/client.js', 'dist/client.js'];

/**
 * Reads `package.json` from the default branch (or `ref`) and runs the checks
 * that only need the manifest plus "is this file in the tree".
 *
 * Returns `{ target, manifest, failures, checked }`; a failure has the same
 * `{ check, message }` shape `doctor` produces so the CLI can print both.
 */
export async function auditRemote(target, { fetchImpl = globalThis.fetch, ref, token = tokenOf() } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('auditRemote needs a fetch implementation');
  const parsed = parseTarget(target);
  const { owner, repo, slug } = parsed;
  const failures = [];
  const checked = [];
  const cache = new Map();
  const exists = (file) => {
    const clean = file.replace(/^\.\//u, '');
    if (cache.has(clean) === false) cache.set(clean, readFile(owner, repo, clean, { fetchImpl, ref, token }));
    return cache.get(clean);
  };
  const fail = (check, message) => failures.push({ check, message });

  const raw = await exists('package.json');
  if (raw === null) {
    fail('manifest', `no package.json at the root of ${slug}, so the host has no manifest to read`);
    return { target: parsed, manifest: null, failures, checked };
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    fail('manifest', `package.json at ${slug} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return { target: parsed, manifest: null, failures, checked };
  }

  checked.push(['version', checkVersion(manifest)]);
  checked.push(['engines.dsh', checkHostRange(manifest)]);
  checked.push(['files list', checkFilesList(manifest)]);
  for (const [check, message] of checked) if (typeof message === 'string' && message.length > 0) fail(check, message);

  // A repository that builds before it packs does not contain the files the
  // tarball will contain: `lib/` is output, not source. Asking GitHub whether
  // those paths exist would call a working plugin broken, so the file-level
  // checks are reported as skipped instead of failed.
  const BUILD_HOOKS = ['prepack', 'prepublishOnly', 'prepare', 'build'];
  const builds = BUILD_HOOKS.filter((hook) => typeof manifest.scripts?.[hook] === 'string');
  const built = builds.length > 0;

  // `engines.dsh` deserves the wording the installer actually uses: a host that
  // enforces the range refuses the install outright, which is the issue text
  // maintainers paste into their own tracker.
  if (checkHostRange(manifest) !== null) {
    const index = failures.findIndex((entry) => entry.check === 'engines.dsh');
    if (index !== -1) {
      failures[index] = {
        check: 'engines.dsh',
        message:
          'engines.dsh is missing, so a host that enforces the range rejects the install as "incompatible with dsh"; declare the range you support, e.g. "engines": { "dsh": ">=0.2.0" }',
      };
    }
  }

  const patch = manifest.dsh?.bundle?.patch;
  if (built === false && typeof patch === 'string' && patch.length > 0) {
    if ((await exists(patch)) === null) {
      fail('patch file', `dsh.bundle.patch points at ${patch}, which is not in the repository`);
    }
  }

  const exported = manifest.exports;
  const clientDecl = manifest.dsh?.client;
  const clientSubpath = typeof exported === 'string' ? undefined : exportTarget(exported?.['./client']);
  if (clientDecl !== undefined && clientDecl !== null) {
    if (clientDecl.platform !== undefined && clientDecl.platform !== 'web') {
      fail('client declaration', `dsh.client.platform is ${JSON.stringify(clientDecl.platform)}, but the harness serves client bundles on web`);
    } else if (typeof clientSubpath !== 'string') {
      fail(
        'client declaration',
        'dsh.client is declared but exports has no "./client" bundle, so the host drops the row and the panel cannot appear',
      );
    } else if (built === false && (await exists(clientSubpath)) === null) {
      fail('client declaration', `exports["./client"] points at ${clientSubpath}, which is not in the repository`);
    }
  } else if (typeof clientSubpath === 'string') {
    fail(
      'client declaration',
      `${clientSubpath.replace(/^\.\//u, '')} is exported as "./client" but dsh.client is not declared, so the harness never serves it`,
    );
  } else {
    for (const file of CLIENT_FILES) {
      if ((await exists(file)) !== null) {
        fail(
          'client declaration',
          `${file} ships but dsh.client is not declared, so the harness never serves the bundle and the panel cannot appear`,
        );
        break;
      }
    }
  }

  const entry = rootEntry(manifest);
  if (manifest.dsh !== undefined && manifest.dsh !== null && entry !== null) {
    const bins = Object.values(manifest.bin ?? {}).filter((value) => typeof value === 'string');
    const asBin = bins.some((bin) => bin.replace(/^\.\//u, '') === entry);
    const source = asBin === true || built === true ? null : await exists(entry);
    if (asBin === true) {
      fail(
        'root export',
        `exports["."] points at the CLI (${entry}), so the loader's row has no plugin to apply; point it at the module that exports apply`,
      );
    } else if (built === false && source === null) {
      fail('root export', `exports["."] points at ${entry}, which is not in the repository`);
    } else if (built === false && exportsApply(source) === false) {
      fail('root export', `the root export ${entry} does not export apply, so the loader imports the package and mounts nothing`);
    }
  }

  const readme = (await exists('README.md')) ?? (await exists('README'));
  if (readme === null) fail('readme', 'the repository has no README, so a reader cannot tell how to install it or what it needs');

  const notes = built
    ? {
        built: true,
        skipped: ['patch file', 'client declaration (file)', 'root export (file)'],
        message: `package.json runs "${builds.join('/')}" before it publishes, so the files it ships are built rather than committed; the checks that need those files were skipped`,
      }
    : { built: false, skipped: [] };
  return { target: parsed, manifest, failures, checked, notes };
}
