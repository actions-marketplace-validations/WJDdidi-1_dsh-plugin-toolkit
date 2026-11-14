/**
 * A batch that runs into GitHub's quota must stop, not keep asking. The fake
 * fetch below fails on the third request; the list is longer than that, so the
 * only way every later repository can appear in the report is if the runner
 * fills them without touching the network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { auditRemoteTargets } from '../lib/audit.mjs';
import { run } from '../lib/cli.mjs';

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

// A package that builds before it packs needs only package.json and README
// from the remote tree: the file-level checks are skipped. That keeps the
// failing request in the test the third one, without a pile of 404s first.
const cleanFiles = {
  'package.json': JSON.stringify({
    name: 'clean-plugin',
    version: '1.2.3',
    main: 'index.js',
    engines: { dsh: '>=0.2.0' },
    scripts: { build: 'node build.mjs' },
    dsh: { bundle: { patch: 'cordis.patch.yml' }, client: { platform: 'web' } },
    exports: { '.': './index.js', './client': './client.js' },
    files: ['index.js', 'client.js', 'cordis.patch.yml', 'README.md'],
  }),
  'README.md': '# clean\n\n## Requirements\n\nRequires dsh >=0.2.0.\n',
};

function listFile(t, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-rate-limit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'repos.txt');
  fs.writeFileSync(file, contents);
  return file;
}

function recorder() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

/** Serve clean repositories until call `failAt`, then answer 403 with a reset. */
function failingFetch(failAt, resetAt, status = 403) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, headers: options.headers });
    if (calls.length >= failAt) {
      return {
        ok: false,
        status,
        headers: { get: (name) => (name.toLowerCase() === 'x-ratelimit-reset' ? String(resetAt) : null) },
        json: async () => ({ message: 'rate limit' }),
      };
    }
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)/u.exec(url);
    const file = match?.[3];
    if (file === undefined || Object.prototype.hasOwnProperty.call(cleanFiles, file) === false) {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: encode(cleanFiles[file]) }) };
  };
  return { fetchImpl, calls };
}

test('a batch stops at the first 403 and reports the rest as rate-limited with the reset time', async (t) => {
  const list = listFile(t, 'demo/one\ndemo/two\ndemo/three\ndemo/four\ndemo/five\n');
  const resetSeconds = 1_780_000_000;
  const resetAt = new Date(resetSeconds * 1000).toISOString();
  const { fetchImpl, calls } = failingFetch(3, resetSeconds);
  const io = recorder();

  const code = await run(['audit', '--remote', '--from', list, '--jobs', '1'], io, { fetchImpl });

  assert.equal(code, 1);
  assert.equal(calls.length, 3, 'the batch kept asking after GitHub said 403');

  const output = io.lines.join('\n');
  assert.match(output, /^clean\s+demo\/one/mu);
  for (const target of ['demo/two', 'demo/three', 'demo/four', 'demo/five']) {
    assert.match(output, new RegExp(`^rate-limited\\s+${target}\\b`, 'mu'));
  }
  assert.match(output, /resets at/u);
  assert.ok(output.includes(resetAt), `the reset time ${resetAt} is missing from:\n${output}`);
  assert.match(output, /1 clean, 0 failing \(0 problems\), 0 unreadable, 4 rate-limited/u);
  assert.doesNotMatch(output, /^clean\s+demo\/(two|three|four|five)/mu);
  assert.doesNotMatch(output, /^unreadable\s+demo\/(two|three|four|five)/mu);
});

test('the JSON findings carry rateLimited and the reset time, and never unreadable', async (t) => {
  const list = listFile(t, 'demo/one\ndemo/two\ndemo/three\ndemo/four\n');
  const resetSeconds = 1_780_000_123;
  const { fetchImpl, calls } = failingFetch(3, resetSeconds);
  const io = recorder();

  const code = await run(['audit', '--remote', '--from', list, '--jobs', '1', '--json'], io, { fetchImpl });

  assert.equal(code, 1);
  assert.equal(calls.length, 3);
  const reports = JSON.parse(io.lines.join('\n'));
  assert.deepEqual(reports.map((report) => report.target), ['demo/one', 'demo/two', 'demo/three', 'demo/four']);
  assert.equal(reports[0].rateLimited, undefined);
  for (const report of reports.slice(1)) {
    assert.equal(report.rateLimited, true);
    assert.equal(report.unreadable, undefined);
    assert.equal(report.rateLimit.resetAt, new Date(resetSeconds * 1000).toISOString());
  }
});

test('a rate-limited batch reports URL entries with the same owner/repo target as the rows it read', async (t) => {
  const list = listFile(t, 'https://github.com/demo/one\nhttps://github.com/demo/two\n');
  const { fetchImpl } = failingFetch(1, 1_780_000_000);
  const io = recorder();

  const code = await run(['audit', '--remote', '--from', list, '--jobs', '1', '--json'], io, { fetchImpl });

  assert.equal(code, 1);
  const reports = JSON.parse(io.lines.join('\n'));
  // The first repository was read (and hit the limit); the second was skipped.
  // Both findings must name the repository the same way a successful read does,
  // so a consumer can join the list without rewriting GitHub URLs.
  assert.deepEqual(reports.map((report) => report.target), ['demo/one', 'demo/two']);
  assert.equal(reports[0].rateLimited, true);
  assert.equal(reports[1].rateLimited, true);
  assert.match(reports[1].notes[0], /before this repository was read/u);
});

test('429 is treated as a rate limit too, and retry-after supplies the reset time', async () => {
  const io = recorder();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: false,
      status: 429,
      headers: { 'retry-after': '60' },
      json: async () => ({ message: 'secondary rate limit' }),
    };
  };

  const result = await auditRemoteTargets('demo/one,demo/two', {
    fetchImpl,
    jobs: 1,
    io,
  });

  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.equal(result.summary.rateLimited, 2);
  for (const report of result.reports) {
    assert.equal(report.rateLimited, true);
    assert.equal(report.unreadable, undefined);
    assert.match(report.rateLimit.resetAt, /^\d{4}-\d{2}-\d{2}T/u);
  }
});
