#!/usr/bin/env node
/**
 * Measure `audit --remote --from` before and after `--jobs`.
 *
 * The run is reproducible: the fake GitHub below waits a fixed delay for every
 * request, and the default list is the first eight repositories of the 3
 * November install-failure audit. See the "Measured throughput" section of the
 * README for the numbers this command produced.
 *
 *   node scripts/benchmark-audit.mjs
 *   node scripts/benchmark-audit.mjs --latency 250 --limit 8
 */
import { DEFAULT_JOBS } from '../lib/audit.mjs';
import {
  BENCHMARK_LATENCY_MS,
  BENCHMARK_LIMIT,
  BENCHMARK_LIST,
  formatBenchmark,
  runBenchmark,
} from '../lib/benchmark.mjs';

function positive(name, value) {
  if (/^\d+$/u.test(String(value)) === false || Number(value) < 1) {
    throw new Error(`${name} needs a positive whole number, got ${JSON.stringify(value)}`);
  }
  return Number(value);
}

const options = {
  list: BENCHMARK_LIST,
  limit: BENCHMARK_LIMIT,
  latencyMs: BENCHMARK_LATENCY_MS,
  jobs: DEFAULT_JOBS,
};

const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index];
  if (flag === '--help' || flag === '-h') {
    console.log(`usage: node scripts/benchmark-audit.mjs [--list <file>] [--limit <n>] [--latency <ms>] [--jobs <n>]

  --list <file>     owner/repo list, default ${BENCHMARK_LIST}
  --limit <n>       first n entries, default ${BENCHMARK_LIMIT}
  --latency <ms>    delay every fake API response, default ${BENCHMARK_LATENCY_MS}
  --jobs <n>        after width, default ${DEFAULT_JOBS} (the audit default)`);
    process.exit(0);
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--') === true) throw new Error(`${flag} needs a value`);
  index += 1;
  if (flag === '--list') options.list = value;
  else if (flag === '--limit') options.limit = positive(flag, value);
  else if (flag === '--latency') options.latencyMs = positive(flag, value);
  else if (flag === '--jobs') options.jobs = positive(flag, value);
  else throw new Error(`unknown flag ${flag}; run with --help`);
}

try {
  const result = await runBenchmark(options);
  console.log(formatBenchmark(result));
} catch (error) {
  console.error(`benchmark: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
