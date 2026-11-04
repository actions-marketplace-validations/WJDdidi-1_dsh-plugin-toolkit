/**
 * `audit --remote --from <list> --jobs <n>` reads several repositories at
 * once. These tests serve GitHub from memory, slow individual repositories
 * down, and count how many requests are in flight: the report must stay in
 * input order even when the reads finish in a different order.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_JOBS, MAX_JOBS, auditRemoteTargets, parseJobs } from '../lib/audit.mjs';
import { run } from '../lib/cli.mjs';

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function manifest() {
  return {
    name: 'clean-plugin',
    version: '1.2.3',
    main: 'index.js',
    engines: { dsh: '>=0.2.0' },
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
    files: ['index.js', 'cordis.patch.yml', 'README.md'],
  };
}

const cleanFiles = {
  'package.json': JSON.stringify(manifest()),
  'index.js': 'export function apply() {}\n',
  'cordis.patch.yml': '- insert: []\n',
  'README.md': '# clean\n\nRequires dsh >=0.2.0.\n',
};

/**
 * Serve every repository from memory, optionally delaying a request. `active`
 * counts requests that have started but not answered; `maxActive` is the
 * concurrency the audit actually reached, not the concurrency it asked for.
 */
function github({ delayMs = 0, delayRepo = () => undefined } = {}) {
  let active = 0;
  let maxActive = 0;
  const completed = [];

  const fetchImpl = async (url) => {
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)/u.exec(url);
    if (match === null) return { ok: false, status: 404, json: async () => ({}) };
    const [, owner, repo, file] = match;
    const slug = `${owner}/${repo}`;
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      const wait = delayRepo(slug, file) ?? delayMs;
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      completed.push(slug);
      if (cleanFiles[file] === undefined) {
        return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
      }
      return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: encode(cleanFiles[file]) }) };
    } finally {
      active -= 1;
    }
  };
  return { fetchImpl, completed, stats: () => ({ active, maxActive }) };
}

function recorder() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

test('--jobs reads out of order but reports in the input order', async () => {
  const targets = ['demo/slow', 'demo/fast', 'demo/middle'];
  const { fetchImpl, completed } = github({
    delayRepo: (slug, file) => {
      if (file !== 'package.json') return 0;
      if (slug === 'demo/slow') return 80;
      if (slug === 'demo/middle') return 20;
      return 0;
    },
  });
  const io = recorder();

  const result = await auditRemoteTargets(targets.join(','), { fetchImpl, jobs: 3, io });

  // The slow repository really did finish last; ordering is not a coincidence
  // of every fake response taking the same amount of time.
  assert.equal(completed[0], 'demo/fast');
  assert.equal(completed.at(-1), 'demo/slow');
  assert.deepEqual(result.reports.map((report) => report.target), targets);
  assert.deepEqual(
    io.lines
      .filter((line) => line.startsWith('clean'))
      .map((line) => targets.find((target) => line.includes(target))),
    targets,
  );
});

test('--jobs N reads N repositories concurrently and --jobs 1 stays sequential', async () => {
  const targets = Array.from({ length: 8 }, (_, index) => `demo/r${index}`);
  const parallel = github({ delayMs: 15 });
  const parallelResult = await auditRemoteTargets(targets.join(','), {
    fetchImpl: parallel.fetchImpl,
    jobs: 3,
    io: recorder(),
  });

  assert.equal(parallel.stats().maxActive, 3);
  assert.deepEqual(parallelResult.reports.map((report) => report.target), targets);

  const sequential = github({ delayMs: 2 });
  await auditRemoteTargets(targets.slice(0, 3).join(','), {
    fetchImpl: sequential.fetchImpl,
    jobs: 1,
    io: recorder(),
  });
  assert.equal(sequential.stats().maxActive, 1);
});

test('--jobs above the hard ceiling never runs more than eight reads at once', async () => {
  assert.equal(MAX_JOBS, 8);
  assert.equal(parseJobs(99), MAX_JOBS);
  const targets = Array.from({ length: 12 }, (_, index) => `demo/c${index}`);
  const { fetchImpl, stats } = github({ delayMs: 12 });

  const io = recorder();
  const code = await run(['audit', '--remote', targets.join(','), '--jobs', '99', '--json'], io, { fetchImpl });

  assert.equal(code, 0);
  assert.equal(stats().maxActive, MAX_JOBS);
  assert.deepEqual(JSON.parse(io.lines.join('\n')).map((report) => report.target), targets);
});

test('an invalid --jobs value is refused before any repository is read', async () => {
  assert.equal(parseJobs(undefined), DEFAULT_JOBS);
  assert.equal(parseJobs('4'), 4);
  for (const value of ['0', '-1', '4.5', 'many', '']) {
    assert.throws(() => parseJobs(value), /positive whole number/u, `accepted invalid --jobs ${JSON.stringify(value)}`);
  }

  const io = recorder();
  const { fetchImpl, stats } = github();
  const code = await run(['audit', '--remote', 'demo/clean', '--jobs', '0'], io, { fetchImpl });

  assert.equal(code, 2);
  assert.equal(stats().maxActive, 0, 'an invalid value must not start a read');
  assert.match(io.lines.join('\n'), /--jobs needs a positive whole number/u);
});
