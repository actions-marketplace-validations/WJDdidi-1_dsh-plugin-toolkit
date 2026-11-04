/**
 * A reproducible throughput measurement for `audit --remote --from`.
 *
 * Wall clock against GitHub depends on DNS, TLS, the CDN and the host's
 * connection, so a single "twice as fast" number measured once cannot be
 * reproduced. This harness serves the same read-only API responses from memory
 * with a fixed latency on every request: the only variable left is how the
 * batch schedules those reads. `--jobs 1` reproduces the old one-at-a-time
 * loop, while the default run shows what the same list costs when
 * DEFAULT_JOBS repositories are in flight.
 *
 * The default list is the first eight entries of the 3 November install-failure
 * audit, so the measurement names real repositories instead of `demo/one`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_JOBS, auditRemoteTargets, parseRemoteList } from './audit.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** The checked-in install-failure list the README measures. */
export const BENCHMARK_LIST = path.join(ROOT, 'docs', 'ecosystem-audit-2026-11-03.txt');
/** The first N named repositories from that list. */
export const BENCHMARK_LIMIT = 8;
/** Delay every fake GitHub response by this much, so the run is comparable. */
export const BENCHMARK_LATENCY_MS = 500;

// A clean repository that builds before it packs: the file-level checks are
// skipped, which keeps each read to exactly two requests (package.json and
// README.md) and makes the per-repository cost easy to reason about.
const MANIFEST = {
  name: 'benchmark-plugin',
  version: '1.2.3',
  main: 'index.js',
  scripts: { build: 'node build.mjs' },
  engines: { dsh: '>=0.2.0' },
  dsh: { bundle: { patch: 'cordis.patch.yml' }, client: { platform: 'web' } },
  exports: { '.': './index.js', './client': './client.js' },
  files: ['index.js', 'client.js', 'cordis.patch.yml', 'README.md'],
};

const FILES = {
  'package.json': JSON.stringify(MANIFEST),
  'README.md': '# benchmark-plugin\n\nRequires dsh >=0.2.0.\n',
};

/** Read the named list, first `limit` entries, using the same parser `--from` uses. */
export function readBenchmarkTargets({
  list = BENCHMARK_LIST,
  limit = BENCHMARK_LIMIT,
  readFile = fs.readFileSync,
} = {}) {
  const text = readFile(list, 'utf8');
  const targets = parseRemoteList(text, list).slice(0, limit);
  if (targets.length === 0) throw new Error(`${list} does not contain any owner/repo entries to measure`);
  return targets;
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/**
 * A stand-in for the GitHub contents API. Every answer waits `latencyMs`, so
 * the measured wall clock is the batch's scheduling plus a fixed cost per
 * request, not the network's mood.
 */
export function createLatencyFetch({
  latencyMs = BENCHMARK_LATENCY_MS,
  files = FILES,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  return async (url) => {
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)/u.exec(String(url));
    if (latencyMs > 0) await sleep(latencyMs);
    if (match === null) return response(404, { message: 'Not Found' });
    const file = decodeURIComponent(match[3]);
    if (Object.prototype.hasOwnProperty.call(files, file) === false) {
      return response(404, { message: 'Not Found' });
    }
    return response(200, {
      encoding: 'base64',
      content: Buffer.from(files[file], 'utf8').toString('base64'),
    });
  };
}

const SILENT = { log() {}, error() {} };

/** Time one audit of the whole list at a fixed width. */
export async function measureAuditList({
  targets,
  jobs = DEFAULT_JOBS,
  latencyMs = BENCHMARK_LATENCY_MS,
  fetchImpl = createLatencyFetch({ latencyMs }),
  io = SILENT,
  now = () => performance.now(),
} = {}) {
  if (Array.isArray(targets) === false || targets.length === 0) {
    throw new Error('measureAuditList needs at least one target');
  }
  const started = now();
  const result = await auditRemoteTargets(targets.join(','), { fetchImpl, jobs, io });
  const elapsedMs = now() - started;
  return {
    jobs,
    targets: targets.length,
    elapsedMs,
    secondsPerRepository: elapsedMs / 1000 / targets.length,
    result,
  };
}

/**
 * Run the same named list with one worker (the old loop) and with `jobs`
 * workers (the default). The ratio is wall clock, so it includes the cost of
 * filling the last partial wave instead of only dividing by the worker count.
 */
export async function runBenchmark({
  list = BENCHMARK_LIST,
  limit = BENCHMARK_LIMIT,
  latencyMs = BENCHMARK_LATENCY_MS,
  jobs = DEFAULT_JOBS,
  readFile,
  now,
} = {}) {
  const targets = readBenchmarkTargets({ list, limit, ...(readFile === undefined ? {} : { readFile }) });
  const before = await measureAuditList({
    targets,
    jobs: 1,
    latencyMs,
    fetchImpl: createLatencyFetch({ latencyMs }),
    now,
  });
  const after = await measureAuditList({
    targets,
    jobs,
    latencyMs,
    fetchImpl: createLatencyFetch({ latencyMs }),
    now,
  });
  return {
    list,
    latencyMs,
    targets,
    before,
    after,
    speedup: before.elapsedMs / after.elapsedMs,
  };
}

/** The same lines the script prints, kept here so tests read one formatter. */
export function formatBenchmark(result, { root = ROOT } = {}) {
  const list = path.relative(root, result.list) || result.list;
  const seconds = (value) => `${value.toFixed(3)} s`;
  return [
    `benchmark: ${result.targets.length} repositories from ${list}, ${result.latencyMs} ms per API request`,
    `  before   --jobs 1           ${(result.before.elapsedMs / 1000).toFixed(2)} s wall   ${seconds(result.before.secondsPerRepository)}/repository`,
    `  after    --jobs ${String(result.after.jobs).padEnd(10)} ${(result.after.elapsedMs / 1000).toFixed(2)} s wall   ${seconds(result.after.secondsPerRepository)}/repository (default)`,
    `  speedup  ${result.speedup.toFixed(2)}x`,
  ].join('\n');
}
