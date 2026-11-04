// "npm test passed on the runner that packed it" is not the same as "this
// commit passed CI". 0.20.0 was published while the Windows and macOS jobs for
// the same commit were failing: the publish workflow only ran the single
// ubuntu job and never asked GitHub whether the commit was green.
//
// This gate asks GitHub for the commit's check runs and refuses to continue
// unless every check that is not this workflow itself has finished green.
//
// Run it locally with:
//   GH_TOKEN=$(gh auth token) node scripts/publish-ci-gate.mjs WJDdidi-1/dsh-plugin-toolkit <sha>
import process from 'node:process';

export const PASSING = new Set(['success', 'neutral', 'skipped']);

// The publish workflow's own check runs are in progress while this runs, so it
// has to ignore them; otherwise the gate would always find "still running".
export const OWN_WORKFLOW = /^(publish\b|publish to npm|the publish)/iu;

export function evaluate(checkRuns, { exclude = OWN_WORKFLOW } = {}) {
  const considered = (checkRuns ?? []).filter((run) => exclude.test(run.name ?? '') === false);
  const failing = considered.filter(
    (run) => run.status === 'completed' && PASSING.has(run.conclusion ?? '') === false,
  );
  const pending = considered.filter((run) => run.status !== 'completed');
  if (considered.length === 0) {
    return {
      ok: false,
      why: 'the commit has no check runs that are not this workflow; publishing must not be the first thing that runs on a commit',
      failing,
      pending,
      considered,
    };
  }
  if (failing.length > 0) {
    const named = failing.map((run) => `${run.name}: ${run.conclusion}`).join(', ');
    return { ok: false, why: `the commit is not green: ${named}`, failing, pending, considered };
  }
  if (pending.length > 0) {
    const named = pending.map((run) => run.name).join(', ');
    return { ok: false, why: `the commit is still being checked: ${named}`, failing, pending, considered };
  }
  return { ok: true, why: `${considered.length} check run(s) are green`, failing, pending, considered };
}

export async function fetchCheckRuns({
  repo,
  sha,
  token,
  api = process.env.GITHUB_API_URL ?? 'https://api.github.com',
  fetchImpl = fetch,
}) {
  const url = `${api}/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`;
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'dsh-plugin-ci-gate',
    },
  });
  if (response.ok === false) {
    throw new Error(`GitHub answered ${response.status} for ${url}`);
  }
  const body = await response.json();
  return body.check_runs ?? [];
}

async function main() {
  const repo = process.argv[2] ?? process.env.GITHUB_REPOSITORY;
  const sha = process.argv[3] ?? process.env.GITHUB_SHA;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (repo === undefined || sha === undefined || token === undefined) {
    console.error('usage: node scripts/publish-ci-gate.mjs <owner/repo> <sha>  (needs GH_TOKEN or GITHUB_TOKEN)');
    process.exit(2);
  }
  const checkRuns = await fetchCheckRuns({ repo, sha, token });
  const verdict = evaluate(checkRuns);
  for (const run of verdict.considered) {
    console.log(`${run.status === 'completed' && PASSING.has(run.conclusion ?? '') ? 'ok  ' : 'bad '} ${run.name}: ${run.conclusion ?? run.status}`);
  }
  if (verdict.ok === false) {
    console.error(`publish-ci-gate: ${verdict.why}`);
    process.exit(1);
  }
  console.log(`publish-ci-gate: ${verdict.why}`);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('publish-ci-gate.mjs') === true) {
  await main();
}
