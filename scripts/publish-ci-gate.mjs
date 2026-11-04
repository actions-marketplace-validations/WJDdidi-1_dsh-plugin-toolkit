// Publishing is not allowed unless the tagged commit is green.
//
// 0.20.0 went out while the same commit's Windows jobs were failing, because
// publish.yml only ran its own ubuntu job and never asked GitHub. The first
// version of this gate had three holes a reviewer caught:
//   - it guessed its own check by name, and the verify job is called
//     "build, test, pack, smoke", so the gate would have found itself pending
//     and blocked every future release;
//   - it read only the first page of check runs and called that "everything";
//   - it treated "cancelled" as one thing, so a GitHub capacity cancellation
//     (no runner was ever acquired) looked like a failing test.
// This version fixes all three: identity comes from the check suite, every page
// is read, and capacity is separated from failure with evidence.
//
// Local use:
//   GH_TOKEN=$(gh auth token) node scripts/publish-ci-gate.mjs WJDdidi-1/dsh-plugin-toolkit <sha> [--self-run <run-id>]
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const POLICY_FILE = path.join(HERE, '..', '.github', 'required-checks.json');

export const PASSING = new Set(['success', 'neutral', 'skipped']);
const FAILING = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);

export function loadPolicy(file = POLICY_FILE) {
  const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    workflow: policy.workflow ?? 'CI',
    required: policy.required ?? [],
    alternatives: policy.required_alternatives ?? [],
  };
}

/** The workflow run a check run belongs to, read from its URL, or null. */
export function runIdOf(run) {
  const url = run.html_url ?? run.details_url ?? '';
  const match = /\/actions\/runs\/(\d+)/u.exec(String(url));
  return match === null ? null : Number(match[1]);
}

/**
 * Does this check run belong to the publish workflow that is asking?
 * Identity comes from the run id in the URL: the check-suite id is not a
 * workflow run id (41852408760 vs suite 113408846199) and job names differ
 * between workflows, so neither suite nor name is a safe identity.
 */
export function isSelf(run, selfRunId) {
  if (selfRunId === undefined || selfRunId === null) return false;
  const id = runIdOf(run);
  return id !== null && Number(id) === Number(selfRunId);
}

export function capacityCancelled(run, job) {
  if (run.conclusion !== 'cancelled') return false;
  if (job === undefined || job === null) return false;
  // A job that never got a runner has no runner name and never ran a step.
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const neverStarted = steps.length === 0 && (job.runner_name === '' || job.runner_name == null);
  return neverStarted;
}

function findJob(jobs, name) {
  return (jobs ?? []).find((job) => job.name === name);
}

/**
 * @param {object[]} checkRuns every check run on the commit, all pages
 * @param {object} opts
 *   required        names that must exist and be green
 *   alternatives    groups where at least one member must be green
 *   selfRunId       the workflow run id of the publish workflow that is asking
 *   jobOf           (name) => the Actions job for that check, or null when unreadable
 */
export function evaluate(checkRuns, opts = {}) {
  const { required = [], alternatives = [], selfRunId = null, jobOf = () => null } = opts;
  const all = checkRuns ?? [];
  const foreign = all.filter((run) => isSelf(run, selfRunId) === false);
  const byName = new Map(foreign.map((run) => [run.name, run]));

  const warnings = [];
  const missing = required.filter((name) => byName.has(name) === false);
  const blocking = [];
  const capacity = [];
  const pending = [];
  const green = [];

  const judge = (run) => {
    if (run.status !== 'completed') {
      pending.push(run);
      return;
    }
    if (FAILING.has(run.conclusion ?? '')) {
      blocking.push({ ...run, why: run.conclusion });
      return;
    }
    if (run.conclusion === 'cancelled') {
      const job = jobOf(run.name);
      if (capacityCancelled(run, job) === true) {
        capacity.push(run);
        return;
      }
      const unreadable = job === undefined || job === null;
      blocking.push({ ...run, why: unreadable ? 'cancelled, and its job could not be read' : 'cancelled after it started' });
      return;
    }
    green.push(run);
  };

  for (const name of required) {
    const run = byName.get(name);
    if (run !== undefined) judge(run);
  }
  // Best-effort checks (the arm64 leg, which GitHub's free pool often refuses).
  // A missing or still-queued best-effort check is a warning, not a refusal:
  // its job cannot even start when no runner was acquired, and letting an
  // exhausted pool block every release is the failure mode the reviewer named.
  // A best-effort check that actually fails, or that was cancelled after it
  // started, still refuses.
  for (const group of alternatives) {
    const present = group.map((name) => byName.get(name)).filter((run) => run !== undefined);
    if (present.length === 0) {
      warnings.push(`${group.join(' or ')} is not present (best effort)`);
      continue;
    }
    const ok = present.some((run) => run.status === 'completed' && run.conclusion === 'success');
    if (ok === true) {
      for (const run of present) if (green.includes(run) === false) green.push(run);
      continue;
    }
    const decided = present.filter(
      (run) =>
        run.status === 'completed' &&
        (FAILING.has(run.conclusion ?? '') ||
          (run.conclusion === 'cancelled' && capacityCancelled(run, jobOf(run.name)) === false)),
    );
    if (decided.length > 0) {
      for (const run of decided) judge(run);
      continue;
    }
    warnings.push(
      `${group.join(' or ')} has no verdict yet (best effort): ${present
        .map((run) => `${run.name}=${run.status}${run.conclusion === null || run.conclusion === undefined ? '' : `/${run.conclusion}`}`)
        .join(', ')}`,
    );
  }

  if (missing.length > 0) {
    return { ok: false, why: `the commit is missing required checks: ${missing.join(', ')}`, missing, blocking, pending, capacity, green, warnings };
  }
  if (blocking.length > 0) {
    const named = blocking.map((run) => `${run.name}: ${run.why}`).join(', ');
    return { ok: false, why: `the commit is not green: ${named}`, missing, blocking, pending, capacity, green, warnings };
  }
  if (pending.length > 0) {
    return { ok: false, why: `the commit is still being checked: ${pending.map((run) => run.name).join(', ')}`, missing, blocking, pending, capacity, green, warnings };
  }
  return {
    ok: true,
    why: `${green.length} required check(s) green${capacity.length > 0 ? `, ${capacity.length} skipped for runner capacity` : ''}`,
    missing,
    blocking,
    pending,
    capacity,
    green,
    warnings,
  };
}

export async function fetchCheckRuns({ repo, sha, token, api = process.env.GITHUB_API_URL ?? 'https://api.github.com', fetchImpl = fetch, perPage = 100, maxPages = 20 }) {
  const runs = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${api}/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=${perPage}&page=${page}`;
    const response = await fetchImpl(url, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'dsh-plugin-ci-gate' },
    });
    if (response.ok === false) throw new Error(`GitHub answered ${response.status} for ${url}`);
    const body = await response.json();
    const page_runs = body.check_runs ?? [];
    runs.push(...page_runs);
    const total = Number(body.total_count ?? runs.length);
    if (runs.length >= total || page_runs.length < perPage) return runs;
  }
  throw new Error(`more than ${maxPages} pages of check runs; refusing to claim the commit is green from a partial read`);
}

export async function fetchJobs({ repo, runId, token, api = process.env.GITHUB_API_URL ?? 'https://api.github.com', fetchImpl = fetch }) {
  const url = `${api}/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`;
  const response = await fetchImpl(url, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'dsh-plugin-ci-gate' },
  });
  if (response.ok === false) return null;
  const body = await response.json();
  return body.jobs ?? null;
}

export async function fetchRuns({ repo, sha, token, api = process.env.GITHUB_API_URL ?? 'https://api.github.com', fetchImpl = fetch }) {
  const url = `${api}/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`;
  const response = await fetchImpl(url, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'dsh-plugin-ci-gate' },
  });
  if (response.ok === false) throw new Error(`GitHub answered ${response.status} for ${url}`);
  const body = await response.json();
  return body.workflow_runs ?? [];
}

/** Every job name on this commit, so "cancelled" can be told apart from "failed". */
export async function jobsByName({ repo, sha, token, selfRunId, api, fetchImpl = fetch, deps = {} }) {
  const runs = await (deps.fetchRuns ?? fetchRuns)({ repo, sha, token, api, fetchImpl });
  const out = new Map();
  for (const run of runs) {
    if (selfRunId !== undefined && Number(run.id) === Number(selfRunId)) continue;
    const jobs = await (deps.fetchJobs ?? fetchJobs)({ repo, runId: run.id, token, api, fetchImpl });
    for (const job of jobs ?? []) {
      // A later run for the same commit wins: it is the one the gate is judging.
      out.set(job.name, job);
    }
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  let selfArg;
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--self-run') {
      selfArg = argv[index + 1];
      index += 1;
      continue;
    }
    if (argv[index].startsWith('--')) continue;
    positional.push(argv[index]);
  }
  const repo = positional[0] ?? process.env.GITHUB_REPOSITORY;
  const sha = positional[1] ?? process.env.GITHUB_SHA;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const selfRunId = selfArg ?? process.env.GITHUB_RUN_ID;
  if (repo === undefined || sha === undefined || token === undefined) {
    console.error('usage: node scripts/publish-ci-gate.mjs <owner/repo> <sha> [--self-run <run-id>]  (needs GH_TOKEN or GITHUB_TOKEN)');
    process.exit(2);
  }
  const policy = loadPolicy();
  const checkRuns = await fetchCheckRuns({ repo, sha, token });
  // Check suites are not workflow runs: the check_suite id of an Actions job is
  // not accepted by /actions/runs/<id>/jobs (404). Go the reliable way: list the
  // workflow runs for this commit, then read each run's jobs.
  const jobs = await jobsByName({ repo, sha, token, selfRunId });
  const verdict = evaluate(checkRuns, {
    required: policy.required,
    alternatives: policy.alternatives,
    selfRunId,
    jobOf: (name) => jobs.get(name) ?? null,
  });
  for (const run of verdict.green) console.log(`ok      ${run.name}`);
  for (const run of verdict.capacity) console.log(`skip    ${run.name}: cancelled, no runner was ever acquired (capacity)`);
  for (const warning of verdict.warnings ?? []) console.log(`warn    ${warning}`);
  for (const run of verdict.pending) console.log(`wait    ${run.name}`);
  for (const run of verdict.blocking) console.error(`bad     ${run.name}: ${run.why}`);
  for (const name of verdict.missing) console.error(`missing ${name}`);
  if (verdict.ok === false) {
    console.error(`publish-ci-gate: ${verdict.why}`);
    process.exit(1);
  }
  console.log(`publish-ci-gate: ${verdict.why}`);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('publish-ci-gate.mjs') === true) {
  await main();
}
