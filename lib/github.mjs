/**
 * Check a plugin without cloning it first.
 *
 * A folder path is not the only thing people have in hand when they wonder
 * whether a plugin works: they have a name, or a GitHub URL they just saw. This
 * module turns either into a folder, and says which repositories a bare name
 * could mean before anything is downloaded.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec.mjs';
import { expandHome } from './paths.mjs';

const UA = 'dsh-plugin-toolkit';

/**
 * What the input is asking for. A local path wins over everything: an existing
 * directory is never a repository name, and guessing otherwise would send a
 * private folder to github.com.
 */
export function parseTarget(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === '') return { kind: 'empty' };
  // `~/kit` (and the Windows `~\kit`) is how a person writes a home folder;
  // `fs.existsSync` would call it a search and send the name to github.com.
  const expanded = expandHome(raw);
  if (fs.existsSync(expanded) === true) return { kind: 'local', dir: path.resolve(expanded) };

  const url = raw.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/.*)?$/i);
  if (url !== null) {
    const repo = url[2].replace(/\.git$/i, '');
    return { kind: 'repo', owner: url[1], repo };
  }
  const slug = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (slug !== null) return { kind: 'repo', owner: slug[1], repo: slug[2].replace(/\.git$/i, '') };
  // A bare name is a search, not a guess: `dsh-plugin-example` is a repository
  // name and also a word that matches forty of them.
  return { kind: 'search', query: raw };
}

function json(response, what) {
  if (response.ok !== true) {
    throw new Error(`${what} answered ${response.status}${response.status === 403 ? ' (GitHub rate limit: unauthenticated requests are limited per hour)' : ''}`);
  }
  return response.json();
}

export async function searchRepos(query, { fetchImpl = fetch, limit = 5 } = {}) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+in:name&sort=stars&per_page=${limit}`;
  const body = await json(await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } }), 'GitHub search');
  return (body.items ?? []).map((item) => ({
    fullName: item.full_name,
    description: item.description ?? '',
    stars: item.stargazers_count ?? 0,
    url: item.html_url,
  }));
}

export async function fetchRepo({ owner, repo }, { fetchImpl = fetch, dir, extract = extractTarball } = {}) {
  const target = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-toolkit-gh-'));
  const tarball = path.join(target, 'repo.tar.gz');
  const response = await fetchImpl(`https://codeload.github.com/${owner}/${repo}/tar.gz/HEAD`, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  });
  if (response.ok !== true) throw new Error(`github.com/${owner}/${repo} answered ${response.status}`);
  fs.writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
  const root = extract(tarball, path.join(target, 'repo'));
  fs.rmSync(tarball, { force: true });
  return { dir: root, repo: { owner, repo, fullName: `${owner}/${repo}`, url: `https://github.com/${owner}/${repo}` } };
}

/** GitHub tarballs carry one top-level directory; strip it so `package.json` is at the root. */
function extractTarball(file, into) {
  fs.mkdirSync(into, { recursive: true });
  run('tar', ['-xzf', file, '-C', into, '--strip-components=1'], { stdio: 'pipe' });
  return into;
}

/**
 * Everything the check route needs: a folder to check, or the candidates a name
 * could mean.
 */
export async function resolveTarget(input, options = {}) {
  const parsed = parseTarget(input);
  if (parsed.kind === 'empty') return { kind: 'empty' };
  if (parsed.kind === 'local') return { kind: 'local', dir: parsed.dir };
  if (parsed.kind === 'repo') {
    const fetched = await fetchRepo(parsed, options);
    return { kind: 'github', ...fetched };
  }
  const candidates = await searchRepos(parsed.query, options);
  return { kind: 'candidates', query: parsed.query, candidates };
}
