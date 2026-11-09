/**
 * The README quotes a measured before/after for `audit --remote --from`.
 * A stale number is worse than no number: it tells a reader the batch is fast
 * after the default has quietly changed. These tests read the claim out of the
 * README and keep it tied to DEFAULT_JOBS, then run a short version of the same
 * harness so the measurement itself stays exercised.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_JOBS } from '../lib/audit.mjs';
import {
  BENCHMARK_LIMIT,
  formatBenchmark,
  readBenchmarkTargets,
  runBenchmark,
} from '../lib/benchmark.mjs';
import { run } from '../lib/exec.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readmeSection() {
  // A Windows checkout writes README.md with CRLF, so normalize before matching
  // line anchors; otherwise the heading exists but `\n` never follows it.
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/gu, '\n');
  const section = /^### Measured throughput\n([\s\S]*?)(?=^### |^## )/mu.exec(readme);
  assert.ok(section, 'README has no "### Measured throughput" section');
  return section[1];
}

function row(section, label) {
  const match = new RegExp(`^\\| ${label} \\| ([\\d.]+) s \\| ([\\d.]+) s \\|$`, 'mu').exec(section);
  assert.ok(match, `README has no "| ${label} | ... s | ... s |" row`);
  return { wall: Number(match[1]), perRepository: Number(match[2]) };
}

test('the README throughput claim stays in step with DEFAULT_JOBS', () => {
  const section = readmeSection();
  assert.match(section, new RegExp(`first (?:${BENCHMARK_LIMIT}|eight) repositories`, 'u'));
  assert.match(section, /docs\/ecosystem-audit-2026-11-03\.txt|3 November/u);
  assert.match(section, /610la\/dsh-notification-center/u, 'the named list is missing from the claim');
  assert.match(section, /npm run benchmark/u, 'the reproduction command is missing from the claim');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts?.benchmark, 'node scripts/benchmark-audit.mjs');

  const before = row(section, 'before \\(`--jobs 1`\\)');
  const afterMatch = /^\| after \(default `--jobs (\d+)`\) \| ([\d.]+) s \| ([\d.]+) s \|$/mu.exec(section);
  assert.ok(afterMatch, 'README has no "after (default `--jobs N`)" row');
  const afterJobs = Number(afterMatch[1]);
  const after = { wall: Number(afterMatch[2]), perRepository: Number(afterMatch[3]) };

  assert.equal(
    afterJobs,
    DEFAULT_JOBS,
    `README measures --jobs ${afterJobs}, but the audit default is now ${DEFAULT_JOBS}; update the table`,
  );

  // Eight repositories and four workers finish in exactly two waves, so the
  // per-repository cost is the sequential cost divided by the default width.
  // The small tolerance covers timer overhead in the measured run.
  const expected = before.perRepository / DEFAULT_JOBS;
  const tolerance = Math.max(0.01, expected * 0.1);
  assert.ok(
    Math.abs(after.perRepository - expected) <= tolerance,
    `README says ${after.perRepository} s/repository after, but ${before.perRepository} / ${DEFAULT_JOBS} is ${expected.toFixed(3)}`,
  );
  assert.ok(
    after.wall < before.wall,
    `README's after wall clock (${after.wall} s) is not faster than before (${before.wall} s)`,
  );
});

test('the benchmark measures the same work before and after --jobs', async () => {
  const targets = readBenchmarkTargets({ limit: 4 });
  assert.equal(targets.length, 4);
  assert.equal(targets[0], '610la/dsh-notification-center');

  const result = await runBenchmark({ limit: 4, latencyMs: 5 });
  assert.equal(result.before.jobs, 1);
  assert.equal(result.after.jobs, DEFAULT_JOBS);
  assert.deepEqual(result.targets, targets);
  assert.equal(result.before.result.summary.clean, 4);
  assert.equal(result.after.result.summary.clean, 4);

  // The invariant is the work, not the clock: batching must request the same
  // repositories and produce the same named rows, while actually overlapping
  // requests instead of walking the list one at a time. A loaded machine makes
  // the wall clock noisy but cannot change these counters.
  assert.deepEqual(
    result.after.result.reports,
    result.before.result.reports,
    '--jobs changed a named result or the order findings are reported in',
  );
  assert.equal(
    result.after.requests,
    result.before.requests,
    `--jobs changed the number of API requests: before ${result.before.requests}, after ${result.after.requests}`,
  );
  assert.equal(result.before.maxInFlight, 1, '--jobs 1 should never overlap API requests');
  assert.ok(
    result.after.maxInFlight > 1,
    `batching never overlapped a request: max in flight was ${result.after.maxInFlight}`,
  );
  assert.ok(
    result.after.maxInFlight <= result.after.jobs,
    `batching used ${result.after.maxInFlight} requests in flight with --jobs ${result.after.jobs}`,
  );

  const output = formatBenchmark(result);
  assert.match(output, /before\s+--jobs 1/u);
  assert.match(output, new RegExp(`after\\s+--jobs ${DEFAULT_JOBS}`, 'u'));
  assert.match(output, /s\/repository/u);
  // Timing stays visible as context, but nothing above asserted it.
  assert.match(output, /speedup\s+[\d.]+x \(wall clock, context only\)/u);
  assert.match(
    output,
    new RegExp(`requests ${result.before.requests} before, ${result.after.requests} after`, 'u'),
  );
});

test('the benchmark script honors --latency instead of silently using the default', () => {
  const output = run(process.execPath, ['scripts/benchmark-audit.mjs', '--limit', '1', '--latency', '1'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\\').join('/');
  assert.match(
    output,
    /benchmark: 1 repositories from .*ecosystem-audit-2026-11-03\.txt, 1 ms per API request/u,
    '--latency was parsed but not passed to the measured run',
  );
  assert.match(output, /max in flight 1 before, 1 after/u);
});
