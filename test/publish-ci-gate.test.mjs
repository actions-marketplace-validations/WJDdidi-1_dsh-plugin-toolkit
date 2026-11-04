import assert from 'node:assert/strict';
import test from 'node:test';

import {
  capacityCancelled,
  evaluate,
  fetchCheckRuns,
  isSelf,
  jobsByName,
  loadPolicy,
  runIdOf,
} from '../scripts/publish-ci-gate.mjs';

const policy = loadPolicy();
const REQUIRED = policy.required;

const green = (name, runId = 4185) => ({
  name,
  status: 'completed',
  conclusion: 'success',
  html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
});

const allGreen = (runId = 4185) => [
  ...REQUIRED.map((name) => green(name, runId)),
  green('arm64 job did not hide a test failure', runId),
];

const verdictOf = (runs, extra = {}) =>
  evaluate(runs, { required: REQUIRED, alternatives: policy.alternatives, ...extra });

test('the policy names the checks that actually exist in ci.yml', () => {
  assert.ok(REQUIRED.includes('node 20 on windows-latest'));
  assert.ok(REQUIRED.includes('node 22 on macos-15-intel'));
  assert.ok(REQUIRED.includes('the tool on a real plugin'));
  assert.equal(REQUIRED.some((name) => name.includes('arm64')), false);
  assert.deepEqual(policy.alternatives, [['arm64 job did not hide a test failure']]);
});

test('a fully green commit may publish', () => {
  const verdict = verdictOf(allGreen());
  assert.equal(verdict.ok, true, verdict.why);
  assert.equal(verdict.missing.length, 0);
});

test('the publish workflow does not block itself, whatever its jobs are called', () => {
  const mine = {
    name: 'build, test, pack, smoke',
    status: 'in_progress',
    conclusion: null,
    html_url: 'https://github.com/o/r/actions/runs/777/job/9',
  };
  const verdict = verdictOf([...allGreen(4185), mine], { selfRunId: 777 });
  assert.equal(verdict.ok, true, verdict.why);
  assert.equal(verdict.pending.length, 0);
});

test('identity comes from the run id in the URL, never from the job name', () => {
  assert.equal(runIdOf({ html_url: 'https://github.com/o/r/actions/runs/41852408760/job/1' }), 41852408760);
  assert.equal(runIdOf({ details_url: 'https://github.com/o/r/actions/runs/9/job/1' }), 9);
  assert.equal(runIdOf({ name: 'no url at all' }), null);
  assert.equal(isSelf({ html_url: 'https://github.com/o/r/actions/runs/777/job/1' }, 777), true);
  assert.equal(isSelf({ html_url: 'https://github.com/o/r/actions/runs/778/job/1' }, 777), false);
  assert.equal(isSelf({ name: 'build, test, pack, smoke' }, 777), false);
});

test('a failing Windows job blocks the publish', () => {
  const runs = allGreen().map((run) =>
    run.name === 'node 20 on windows-latest' ? { ...run, conclusion: 'failure' } : run,
  );
  const verdict = verdictOf(runs);
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /node 20 on windows-latest: failure/u);
});

test('a missing required check blocks the publish', () => {
  const runs = allGreen().filter((run) => run.name !== 'node 22 on macos-15-intel');
  const verdict = verdictOf(runs);
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /missing required checks: node 22 on macos-15-intel/u);
});

test('a check still running blocks the publish', () => {
  const runs = allGreen().map((run) =>
    run.name === 'the tool on a real plugin' ? { ...run, status: 'in_progress', conclusion: null } : run,
  );
  const verdict = verdictOf(runs);
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /still being checked: the tool on a real plugin/u);
});

test('the arm64 gate counts as an alternative, not as a required check', () => {
  const runs = allGreen().filter((run) => run.name !== 'arm64 job did not hide a test failure');
  assert.equal(verdictOf(runs).ok, false);

  const withArm = [...runs, { ...green('arm64 job did not hide a test failure'), conclusion: 'success' }];
  assert.equal(verdictOf(withArm).ok, true);
});

test('a cancelled job that never got a runner is capacity, not a failure', () => {
  const runs = allGreen().map((run) =>
    run.name === 'node 20 on macos-15-intel' ? { ...run, conclusion: 'cancelled' } : run,
  );
  const jobs = new Map([
    ['node 20 on macos-15-intel', { name: 'node 20 on macos-15-intel', runner_name: '', steps: [] }],
  ]);
  const verdict = verdictOf(runs, { jobOf: (name) => jobs.get(name) ?? null });
  assert.equal(verdict.ok, true, verdict.why);
  assert.equal(verdict.capacity.length, 1);
  assert.match(verdict.why, /capacity/u);
});

test('a cancelled job that had started is a failure', () => {
  const runs = allGreen().map((run) =>
    run.name === 'node 20 on macos-15-intel' ? { ...run, conclusion: 'cancelled' } : run,
  );
  const jobs = new Map([
    [
      'node 20 on macos-15-intel',
      { name: 'node 20 on macos-15-intel', runner_name: 'GitHub Actions 1', steps: [{ name: 'npm test' }] },
    ],
  ]);
  const verdict = verdictOf(runs, { jobOf: (name) => jobs.get(name) ?? null });
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /cancelled after it started/u);
});

test('a cancelled job whose job list cannot be read is a failure, not capacity', () => {
  const runs = allGreen().map((run) =>
    run.name === 'node 20 on macos-15-intel' ? { ...run, conclusion: 'cancelled' } : run,
  );
  const verdict = verdictOf(runs, { jobOf: () => null });
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /could not be read/u);
  assert.equal(capacityCancelled({ conclusion: 'cancelled' }, null), false);
});

test('every page of check runs is read before claiming the commit is green', async () => {
  const first = Array.from({ length: 100 }, (_, index) => green(`filler ${index}`));
  const second = [green('node 20 on windows-latest')];
  const pages = [first, second];
  let calls = 0;
  const runs = await fetchCheckRuns({
    repo: 'o/r',
    sha: 'abc',
    token: 't',
    fetchImpl: async () => {
      const body = { total_count: 101, check_runs: pages[calls] ?? [] };
      calls += 1;
      return { ok: true, json: async () => body };
    },
  });
  assert.equal(runs.length, 101);
  assert.equal(calls, 2);
});

test('an API error is an error, not a green light', async () => {
  await assert.rejects(
    fetchCheckRuns({
      repo: 'o/r',
      sha: 'abc',
      token: 't',
      fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'rate limited' }),
    }),
    /403/u,
  );
});

test('too many pages is refused instead of treated as complete', async () => {
  await assert.rejects(
    fetchCheckRuns({
      repo: 'o/r',
      sha: 'abc',
      token: 't',
      maxPages: 2,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ total_count: 500, check_runs: Array.from({ length: 100 }, (_, i) => green(`f${i}`)) }),
      }),
    }),
    /partial read/u,
  );
});

test('jobs are found through the workflow runs of the commit, not its check suite', async () => {
  const seen = [];
  const jobs = await jobsByName({
    repo: 'o/r',
    sha: 'abc',
    token: 't',
    selfRunId: 999,
    deps: {
      fetchRuns: async () => [{ id: 999 }, { id: 1234 }],
      fetchJobs: async ({ runId }) => {
        seen.push(runId);
        return [
          { name: 'node 22 on macos-15-intel', runner_name: '', steps: [] },
          { name: 'node 20 on windows-latest', runner_name: 'r', steps: [{ name: 'npm test' }] },
        ];
      },
    },
  });
  assert.deepEqual(seen, [1234]);
  assert.equal(jobs.get('node 22 on macos-15-intel').steps.length, 0);
});

test('every job ci.yml actually runs is required, and nothing else is', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workflow = fs.readFileSync(path.join(here, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

  // The job-level matrix this workflow expands into.
  const osBlock = /os: \[([^\]]+)\]/u.exec(workflow);
  const nodeBlock = /node: \[([^\]]+)\]/u.exec(workflow);
  assert.ok(osBlock !== null && nodeBlock !== null, 'ci.yml keeps its os and node matrices');
  const oses = osBlock[1].split(',').map((value) => value.trim());
  const nodes = nodeBlock[1].split(',').map((value) => value.trim());
  const expanded = nodes.flatMap((node) => oses.map((os) => `node ${node} on ${os}`));

  // Non-matrix jobs that are required (arm64 stays optional on purpose).
  assert.ok(workflow.includes('name: the tool on a real plugin'));

  const missingFromPolicy = expanded.filter((name) => REQUIRED.includes(name) === false);
  assert.deepEqual(missingFromPolicy, [], 'the policy covers every matrix leg');

  const extra = REQUIRED.filter((name) => expanded.includes(name) === false && name !== 'the tool on a real plugin');
  assert.deepEqual(extra, [], 'the policy invents no job that ci.yml does not run');
});
