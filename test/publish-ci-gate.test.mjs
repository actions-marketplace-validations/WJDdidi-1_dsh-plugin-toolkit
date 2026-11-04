/**
 * 0.20.0 went out while the same commit's Windows and macOS jobs were failing.
 * The publish workflow only knew about its own ubuntu job, so "the tests pass"
 * meant "the tests pass where I looked". These cases pin the gate that closes
 * that hole: a commit is publishable only when GitHub says every other check on
 * it finished green.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluate, fetchCheckRuns } from '../scripts/publish-ci-gate.mjs';

const green = (name) => ({ name, status: 'completed', conclusion: 'success' });

test('a commit with green checks may publish', () => {
  const verdict = evaluate([green('node 20 on ubuntu-latest'), green('node 22 on windows-latest')]);
  assert.equal(verdict.ok, true);
  assert.match(verdict.why, /2 check run/u);
});

test('a failing check on another platform blocks the publish', () => {
  const verdict = evaluate([
    green('node 20 on ubuntu-latest'),
    { name: 'node 22 on windows-latest', status: 'completed', conclusion: 'failure' },
  ]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /node 22 on windows-latest: failure/u);
});

test('a check that is still running blocks the publish', () => {
  const verdict = evaluate([green('node 20 on ubuntu-latest'), { name: 'node 22 on macos-latest', status: 'in_progress' }]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /still being checked: node 22 on macos-latest/u);
});

test('a commit nobody checked is not publishable', () => {
  const verdict = evaluate([]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /no check runs/u);
});

test('the publish workflow does not count itself as a blocker', () => {
  const verdict = evaluate([
    green('node 20 on ubuntu-latest'),
    { name: 'publish to npm with provenance', status: 'in_progress' },
  ]);
  assert.equal(verdict.ok, true);
});

test('skipped and neutral checks are not failures', () => {
  const verdict = evaluate([
    green('node 20 on ubuntu-latest'),
    { name: 'arm64 job did not hide a test failure', status: 'completed', conclusion: 'skipped' },
    { name: 'a report nobody needs to block on', status: 'completed', conclusion: 'neutral' },
  ]);
  assert.equal(verdict.ok, true);
});

test('the gate reads every check run, not just the first page of one job', async () => {
  const seen = [];
  const runs = await fetchCheckRuns({
    repo: 'WJDdidi-1/dsh-plugin-toolkit',
    sha: 'abc123',
    token: 't',
    fetchImpl: async (url) => {
      seen.push(url);
      return { ok: true, json: async () => ({ check_runs: [green('a'), green('b')] }) };
    },
  });
  assert.equal(runs.length, 2);
  assert.match(seen[0], /commits\/abc123\/check-runs\?filter=latest&per_page=100/u);
});

test('a GitHub error is an error, not a green light', async () => {
  await assert.rejects(
    fetchCheckRuns({ repo: 'o/r', sha: 's', token: 't', fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /GitHub answered 503/u,
  );
});
