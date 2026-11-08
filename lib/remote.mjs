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
 * Everything here is read-only with respect to the repository: no token is
 * needed for public repositories, and the only GitHub request is a GET. The
 * network call is injectable so the tests never touch GitHub.
 */
import fs from 'node:fs';
import path from 'node:path';

import { expandHome } from './paths.mjs';
import {
  checkDshField,
  checkFilesList,
  checkHostCompatibility,
  checkHostRange,
  checkName,
  checkReadmeText,
  checkVersion,
  exportTarget,
  exportsApply,
  hostRange,
  rootEntry,
} from './doctor.mjs';
import { planEnginesEdit, renderManifest, unifiedDiff } from './fix.mjs';
import { parseTarget as classifyTarget } from './github.mjs';

const API = 'https://api.github.com';
const HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-plugin-toolkit',
};

/**
 * Read one response header without assuming which shape the fetch stand-in
 * uses. Node's `Headers`, a plain object and a `Map` all occur in the tests and
 * in the libraries this command runs beside, and a rate-limit reset that is
 * silently dropped is worse than no reset line at all.
 */
function headerValue(response, name) {
  const headers = response?.headers;
  if (headers === undefined || headers === null) return null;
  const wanted = name.toLowerCase();
  try {
    if (typeof headers.get === 'function') {
      // `Headers` is case-insensitive, but a small test double may not be.
      const common =
        wanted === 'x-ratelimit-reset' ? 'X-RateLimit-Reset' : wanted === 'retry-after' ? 'Retry-After' : name;
      for (const key of [wanted, name, common]) {
        const value = headers.get(key);
        if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
      }
      return null;
    }
    if (headers instanceof Map) {
      for (const [key, value] of headers) {
        if (String(key).toLowerCase() === wanted) return String(value).trim();
      }
      return null;
    }
    if (typeof headers === 'object') {
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === wanted && value !== undefined && value !== null) return String(value).trim();
      }
    }
  } catch {
    // A header bag that throws on an unknown name is still a response with a
    // status; the caller can report the limit without a reset time.
  }
  return null;
}

/**
 * GitHub says when the current quota comes back in `x-ratelimit-reset`
 * (epoch seconds); a secondary limit uses `retry-after` (seconds or an HTTP
 * date). Turn either into an ISO string once, so the human line and `--json`
 * agree and tests do not depend on the host's locale.
 */
function resetFromHeaders(response) {
  const reset = headerValue(response, 'x-ratelimit-reset');
  if (reset !== null) {
    const seconds = Number(reset);
    const date = Number.isFinite(seconds) ? new Date(seconds > 1e12 ? seconds : seconds * 1000) : new Date(reset);
    if (Number.isNaN(date.getTime()) === false) {
      return { resetAt: date.toISOString() };
    }
  }
  const retry = headerValue(response, 'retry-after');
  if (retry !== null) {
    const seconds = Number(retry);
    const date = Number.isFinite(seconds) ? new Date(Date.now() + seconds * 1000) : new Date(retry);
    if (Number.isNaN(date.getTime()) === false) {
      return { resetAt: date.toISOString() };
    }
  }
  return null;
}

function rateLimitInfo(response, status) {
  return { status, ...(resetFromHeaders(response) ?? {}) };
}

function resetSentence(info) {
  return typeof info?.resetAt === 'string' ? `; the limit resets at ${info.resetAt}` : '';
}

/**
 * A file read that failed for a reason other than "the file is not there".
 * A batch audit has to be able to tell "clean" from "could not look", so an
 * unreadable answer is carried as a note instead of being turned into a 404.
 */
const UNREADABLE = Symbol('unreadable');

// `expandHome` used to live here, and the path tests import it from this
// module. Keep that export while the shared implementation lives in paths.mjs.
export { expandHome };


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
    const failure = new Error(`cannot reach GitHub for ${file}: ${error instanceof Error ? error.message : String(error)}`);
    failure.code = 'network';
    throw failure;
  }
  if (response === undefined || response === null) {
    const failure = new Error(`no response for ${file}`);
    failure.code = 'network';
    throw failure;
  }
  if (response.status === 404) return null;
  if (response.status === 403 || response.status === 429) {
    const info = rateLimitInfo(response, response.status);
    const failure = new Error(
      `GitHub rate-limited this request (${response.status}) for ${file}; set GH_TOKEN or GITHUB_TOKEN to raise the limit${resetSentence(info)}`,
    );
    failure.code = 'rate-limit';
    failure.status = response.status;
    failure.rateLimit = info;
    if (typeof info.resetAt === 'string') failure.resetAt = info.resetAt;
    throw failure;
  }
  if (response.ok !== true) {
    const failure = new Error(`GitHub answered ${response.status} for ${file}`);
    failure.code = 'http';
    failure.status = response.status;
    throw failure;
  }
  const body = await response.json();
  if (body === null || typeof body !== 'object' || typeof body.content !== 'string' || body.encoding !== 'base64') {
    const failure = new Error(`${file} came back without base64 content`);
    failure.code = 'malformed-response';
    throw failure;
  }
  return Buffer.from(body.content.replace(/\n/gu, ''), 'base64').toString('utf8');
}

const CLIENT_FILES = ['client.js', 'lib/client.js', 'dist/client.js'];

/**
 * Reads `package.json` from the default branch (or `ref`) and runs the checks
 * that only need the manifest plus "is this file in the tree".
 *
 * Returns `{ target, manifest, failures, checked, notes, unreadable }`; a
 * failure has the same `{ check, message }` shape `doctor` produces so the CLI
 * can print both. With `readErrors: 'note'` an API read that failed (a rate
 * limit, a network error, a 500) becomes a note and `unreadable: true` instead
 * of throwing: a batch audit must never turn "could not look" into "clean".
 */
export async function auditRemote(
  target,
  {
    fetchImpl = globalThis.fetch,
    ref,
    token = tokenOf(),
    readErrors = 'throw',
    tolerant = false,
    // A batch passes one shared object so the first 403/429 stops every worker
    // from starting another read, not only the repository that saw it.
    rateLimitState,
    onRateLimit,
    host,
  } = {},
) {
  if (typeof fetchImpl !== 'function') throw new Error('auditRemote needs a fetch implementation');
  const parsed = parseTarget(target);
  const { owner, repo, slug } = parsed;
  const hostVersion = typeof host === 'string' ? host.trim() : '';
  const withHost = (report) => {
    if (hostVersion === '') return report;
    return {
      ...report,
      host: hostVersion,
      compatibility: report.manifest === null ? 'unknown' : checkHostCompatibility(report.manifest, hostVersion),
    };
  };
  const failures = [];
  const checked = [];
  const cache = new Map();
  const lenient = readErrors === 'note' || tolerant === true;
  const readNotes = [];
  let unreadable = false;
  let rateLimited = false;
  let rateLimit = null;
  const shared = rateLimitState ?? null;
  // A repository already in flight is allowed to finish the requests it had
  // started: those responses are already on the wire, and stopping halfway
  // would make a repository that is actually readable look unverified. The
  // batch-level flag is what stops workers from starting another repository.
  const stopped = () => rateLimited === true;
  const markRateLimit = (error) => {
    const info =
      error?.rateLimit ??
      ({ status: error?.status, ...(typeof error?.resetAt === 'string' ? { resetAt: error.resetAt } : {}) });
    rateLimited = true;
    if (rateLimit === null) rateLimit = info;
    if (shared !== null && shared.limited !== true) {
      shared.limited = true;
      shared.info = info;
    }
    if (typeof onRateLimit === 'function') onRateLimit(error);
  };
  const exists = (file) => {
    const clean = file.replace(/^\.\//u, '');
    if (stopped()) {
      if (rateLimit === null && shared?.info !== undefined) rateLimit = shared.info;
      if (readNotes.length === 0) {
        readNotes.push(
          `GitHub rate-limited this repository before all of its files could be read${resetSentence(rateLimit)}`,
        );
      }
      return UNREADABLE;
    }
    if (cache.has(clean) === false) {
      const pending = readFile(owner, repo, clean, { fetchImpl, ref, token });
      cache.set(
        clean,
        lenient
          ? pending.catch((error) => {
              if (error?.code === 'rate-limit') markRateLimit(error);
              else unreadable = true;
              readNotes.push(error instanceof Error ? error.message : String(error));
              return UNREADABLE;
            })
          : pending,
      );
    }
    return cache.get(clean);
  };
  const fail = (check, message) => failures.push({ check, message });
  const notesFor = (built = false, builds = []) => {
    const skipped = built ? ['patch file', 'client declaration (file)', 'root export (file)'] : [];
    const messages = [...readNotes];
    if (built) {
      messages.unshift(
        `package.json runs "${builds.join('/')}" before it publishes, so the files it ships are built rather than committed; the checks that need those files were skipped`,
      );
    }
    return {
      built,
      skipped,
      messages,
      ...(built ? { message: messages[0] } : {}),
    };
  };

  const raw = await exists('package.json');
  if (raw === UNREADABLE) {
    return withHost({
      target: parsed,
      manifest: null,
      raw: null,
      failures,
      checked,
      unreadable,
      ...(rateLimited ? { rateLimited: true, rateLimit } : {}),
      notes: notesFor(false),
    });
  }
  if (raw === null) {
    fail('manifest', `no package.json at the root of ${slug}, so the host has no manifest to read`);
    return withHost({
      target: parsed,
      manifest: null,
      raw: null,
      failures,
      checked,
      unreadable,
      ...(rateLimited ? { rateLimited: true, rateLimit } : {}),
      notes: notesFor(false),
    });
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    fail('manifest', `package.json at ${slug} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return withHost({
      target: parsed,
      manifest: null,
      raw,
      failures,
      checked,
      unreadable,
      ...(rateLimited ? { rateLimited: true, rateLimit } : {}),
      notes: notesFor(false),
    });
  }

  checked.push(['name', checkName(manifest)]);
  checked.push(['version', checkVersion(manifest)]);
  const enginesCheck = checkHostRange(manifest);
  checked.push(['engines.dsh', enginesCheck]);
  // `doctor` reads this field before it looks at the tree: a manifest with
  // `dsh: {}` has no patch for the host to load, and the file checks below only
  // find a missing patch when one is declared. Run the same manifest-only check
  // here so a remote repository cannot pass with an empty `dsh` field.
  checked.push(['dsh field', checkDshField(manifest)]);
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
  if (enginesCheck !== null && hostRange(manifest) === null) {
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
      const found = await exists(file);
      if (found === UNREADABLE) continue;
      if (found !== null) {
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
    } else if (built === false && source !== UNREADABLE && exportsApply(source) === false) {
      fail('root export', `the root export ${entry} does not export apply, so the loader imports the package and mounts nothing`);
    }
  }

  // `doctor` reads the README text too: a repository can have a README with no
  // Requirements section, or one that omits the host range it declares. Ask the
  // same questions here so the remote verdict matches a checkout. A fallback
  // `README` (no extension) is still read, but the shared message names
  // README.md because that is the file the market convention expects.
  const readme = (await exists('README.md')) ?? (await exists('README'));
  if (readme === null) {
    fail('readme', 'the repository has no README, so a reader cannot tell how to install it or what it needs');
  } else if (readme !== UNREADABLE) {
    const message = checkReadmeText(readme, manifest);
    if (message !== null) fail('readme', message);
  }

  return withHost({
    target: parsed,
    manifest,
    raw,
    failures,
    checked,
    unreadable,
    ...(rateLimited ? { rateLimited: true, rateLimit } : {}),
    notes: notesFor(built, builds),
  });
}

/**
 * `dsh-plugin fix <owner>/<repo> --remote` — read the manifest over the GitHub
 * API and show the `engines.dsh` edit as a unified diff.
 *
 * This stays a plan for the repository: the only GitHub request it makes is the
 * read-only `GET /contents/package.json`. With `patch`, the same diff is saved
 * to a local file so an author can apply it without cloning; `overwrite` is the
 * `--force` that permits replacing that file. A range that already clears
 * `checkHostRange` produces no diff; `force` (from an explicit `--range`) may
 * still replace one, matching the local fixer.
 *
 * With `host`, the proposed range is aimed at that DSH version: it accepts the
 * host and stops before the next major. Naming the host is an explicit request,
 * so it may replace a valid range that was too broad for the install that
 * failed. `why` carries the sentence the CLI prints.
 */
export async function fixRemote(
  target,
  {
    fetchImpl = globalThis.fetch,
    ref,
    token = tokenOf(),
    range,
    host,
    force = false,
    patch,
    overwrite = false,
    writePatch = true,
    // A batch audit already holds the package.json it just read. Passing it
    // here keeps the patch in step with that read and saves a second GitHub
    // request per repository.
    manifestText,
  } = {},
) {
  if (typeof fetchImpl !== 'function') throw new Error('fixRemote needs a fetch implementation');
  const parsed = parseTarget(target);
  const patchPath =
    patch === undefined || patch === null || String(patch).trim() === '' ? null : path.resolve(expandHome(patch));
  if (patchPath !== null && overwrite !== true && fs.existsSync(patchPath)) {
    throw new Error(`patch file ${patchPath} already exists; pass --force to overwrite it`);
  }

  const raw =
    typeof manifestText === 'string'
      ? manifestText
      : await readFile(parsed.owner, parsed.repo, 'package.json', { fetchImpl, ref, token });
  if (raw === null) throw new Error(`no package.json at the root of ${parsed.slug}`);

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `package.json at ${parsed.slug} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) === true) {
    throw new Error(`package.json at ${parsed.slug} does not hold a JSON object`);
  }

  const planned = planEnginesEdit(manifest, { range, host, force });
  if (planned.ok !== true) {
    throw new Error(planned.failures[0].message);
  }
  const { proposed, current } = planned;
  if (planned.noop === true) {
    return {
      ok: true,
      target: parsed,
      manifest,
      before: current,
      after: current,
      range: current,
      changed: false,
      written: false,
      patchPath,
      patchWritten: false,
      reason: 'already-correct',
      host: planned.host,
      nextMajor: planned.nextMajor,
      why: planned.why,
      diff: '',
    };
  }

  const content = renderManifest(planned.manifest, raw);
  const diff = unifiedDiff(raw, content, { file: 'package.json' });

  let patchWritten = false;
  if (patchPath !== null && writePatch === true) {
    fs.mkdirSync(path.dirname(patchPath), { recursive: true });
    try {
      // `wx` makes the no-overwrite promise atomic: a file created between the
      // check above and this write still fails instead of being replaced.
      fs.writeFileSync(patchPath, diff, { encoding: 'utf8', flag: overwrite === true ? 'w' : 'wx' });
    } catch (error) {
      if (overwrite !== true && error?.code === 'EEXIST') {
        throw new Error(`patch file ${patchPath} already exists; pass --force to overwrite it`);
      }
      throw error;
    }
    patchWritten = true;
  }

  return {
    ok: true,
    target: parsed,
    manifest,
    before: current,
    after: proposed,
    range: proposed,
    changed: true,
    written: false,
    patchPath,
    patchWritten,
    reason: planned.reason,
    host: planned.host,
    nextMajor: planned.nextMajor,
    why: planned.why,
    diff,
  };
}
