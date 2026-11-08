import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditRemoteTargets, parseRemoteTargets, remoteFinding } from '../lib/audit.mjs';
import { auditRemote } from '../lib/remote.mjs';
import { run } from '../lib/cli.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Serve a checked-in fixture repository from memory, the way GitHub would. */
function fixtureFiles(name) {
  const root = path.join(here, 'fixtures', name);
  const files = {};
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else files[relative] = fs.readFileSync(path.join(dir, entry.name), 'utf8');
    }
  };
  walk(root);
  return files;
}

function manifest(extra = {}) {
  return {
    name: 'clean-plugin',
    version: '1.2.3',
    main: 'index.js',
    engines: { dsh: '>=0.2.0' },
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
    files: ['index.js', 'cordis.patch.yml', 'README.md'],
    ...extra,
  };
}

const cleanFiles = {
  'package.json': JSON.stringify(manifest()),
  'index.js': 'export function apply() {}\n',
  'cordis.patch.yml': '- insert: []\n',
  'README.md': '# clean\n\n## Requirements\n\nRequires dsh >=0.2.0.\n',
};

const brokenFiles = {
  ...cleanFiles,
  'package.json': JSON.stringify(manifest({ engines: undefined })),
};

// The manifest is valid, so only the README check can fail this repository.
// Its README states the host range but has no Requirements heading, the same
// repository `doctor --remote` rejects in test/doctor-remote-readme.test.mjs.
const noRequirementsFiles = {
  ...cleanFiles,
  'README.md': '# probe\n\nRequires dsh >=0.2.0.\n',
};

/**
 * Serve each repository from memory. A value of `'rate-limit'` answers the
 * package.json request with the 403 GitHub uses when the anonymous quota is
 * gone; every other path is a normal 404.
 */
function github(repositories) {
  return async (url) => {
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)/u.exec(url);
    if (match === null) return { ok: false, status: 404, json: async () => ({}) };
    const [, owner, repo, file] = match;
    const entry = repositories[`${owner}/${repo}`];
    if (entry === 'rate-limit') {
      return { ok: false, status: 403, json: async () => ({ message: 'rate limit' }) };
    }
    if (entry === undefined || Object.prototype.hasOwnProperty.call(entry, file) === false) {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: encode(entry[file]) }) };
  };
}

function recorder() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

test('a remote audit parses a comma-separated list and drops empty entries', () => {
  assert.deepEqual(parseRemoteTargets('demo/one, demo/two,, '), ['demo/one', 'demo/two']);
  assert.deepEqual(parseRemoteTargets(['demo/one', 'demo/two']), ['demo/one', 'demo/two']);
});

test('audit --remote --json prints one finding per repository and exits 1 for a broken one', async () => {
  const io = recorder();
  const code = await run(['audit', '--remote', 'demo/clean,demo/broken', '--json'], io, {
    fetchImpl: github({ 'demo/clean': cleanFiles, 'demo/broken': brokenFiles }),
  });

  assert.equal(code, 1);
  const reports = JSON.parse(io.lines.join('\n'));
  assert.equal(Array.isArray(reports), true);
  assert.equal(reports.length, 2);

  const clean = reports.find((report) => report.target === 'demo/clean');
  assert.equal(clean.version, '1.2.3');
  assert.equal(clean.hostRange, '>=0.2.0');
  assert.deepEqual(clean.failures, []);
  assert.deepEqual(clean.notes, []);

  const broken = reports.find((report) => report.target === 'demo/broken');
  assert.equal(broken.version, '1.2.3');
  assert.equal(broken.hostRange, null);
  assert.equal(broken.failures.some((failure) => failure.check === 'engines.dsh'), true);
  for (const failure of broken.failures) {
    assert.equal(typeof failure.check, 'string');
    assert.equal(typeof failure.message, 'string');
  }
});

test('audit --remote --json exits 0 when every repository is clean', async () => {
  const io = recorder();
  const code = await run(['audit', '--remote', 'demo/clean', '--json'], io, {
    fetchImpl: github({ 'demo/clean': cleanFiles }),
  });

  assert.equal(code, 0);
  const reports = JSON.parse(io.lines.join('\n'));
  assert.deepEqual(reports, [
    { target: 'demo/clean', version: '1.2.3', hostRange: '>=0.2.0', failures: [], notes: [] },
  ]);
});

test('audit --remote --from carries a missing Requirements heading into the failing row and JSON finding', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-readme-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const list = path.join(dir, 'repos.txt');
  fs.writeFileSync(list, 'acme/probe\n');
  const fetchImpl = github({ 'acme/probe': noRequirementsFiles });

  const text = recorder();
  const textCode = await run(['audit', '--remote', '--from', list], text, { fetchImpl });
  assert.equal(textCode, 1);
  const output = text.lines.join('\n');
  assert.match(output, /failing\s+acme\/probe\s+— readme: README\.md has no Requirements section/u);
  assert.match(output, /summary: 1 repository — 0 clean, 1 failing \(1 problem\), 0 unreadable/u);

  const json = recorder();
  const jsonCode = await run(['audit', '--remote', '--from', list, '--json'], json, { fetchImpl });
  assert.equal(jsonCode, 1);
  const [finding] = JSON.parse(json.lines.join('\n'));
  assert.equal(finding.target, 'acme/probe');
  assert.equal(finding.version, '1.2.3');
  assert.equal(finding.hostRange, '>=0.2.0');
  assert.deepEqual(finding.failures, [
    {
      check: 'readme',
      message: 'README.md has no Requirements section, so users cannot tell which host it needs',
    },
  ]);
  assert.deepEqual(finding.notes, []);
});

test('a rate-limited read is a note and a rate-limited repository, never a false pass', async () => {
  const io = recorder();
  const code = await run(['audit', '--remote', 'demo/clean,demo/blocked', '--json'], io, {
    fetchImpl: github({ 'demo/clean': cleanFiles, 'demo/blocked': 'rate-limit' }),
  });

  assert.equal(code, 1, 'an unread repository cannot make the audit pass');
  const reports = JSON.parse(io.lines.join('\n'));
  const blocked = reports.find((report) => report.target === 'demo/blocked');
  assert.deepEqual(blocked.failures, []);
  assert.equal(blocked.unreadable, undefined);
  assert.equal(blocked.rateLimited, true);
  assert.equal(blocked.notes.some((note) => /rate-limited/u.test(note)), true);
  assert.equal(blocked.notes.some((note) => /GH_TOKEN/u.test(note)), true);
});

test('a read error becomes a note in the library report as well', async () => {
  const report = await auditRemote('demo/blocked', {
    fetchImpl: github({ 'demo/blocked': 'rate-limit' }),
    readErrors: 'note',
  });
  assert.equal(report.rateLimited, true);
  assert.equal(report.unreadable, false);
  assert.deepEqual(report.failures, []);
  const finding = remoteFinding(report);
  assert.equal(finding.unreadable, undefined);
  assert.equal(finding.rateLimited, true);
  assert.equal(finding.notes.some((note) => /rate-limited/u.test(note)), true);
});

test('the list runner reports every target even when one cannot be read', async () => {
  const result = await auditRemoteTargets('demo/clean,demo/blocked,demo/missing', {
    fetchImpl: github({ 'demo/clean': cleanFiles, 'demo/blocked': 'rate-limit' }),
    io: { log: () => {}, error: () => {} },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.reports.map((report) => report.target), ['demo/clean', 'demo/blocked', 'demo/missing']);
  assert.equal(result.reports[2].failures[0].check, 'manifest');
});

test('a malformed engines.dsh is reported as a range, not as a missing field', async () => {
  const files = {
    ...cleanFiles,
    'package.json': JSON.stringify(manifest({ engines: { dsh: '>=banana' } })),
  };
  const report = await auditRemote('demo/malformed', { fetchImpl: github({ 'demo/malformed': files }) });
  const failure = report.failures.find((entry) => entry.check === 'engines.dsh');
  assert.match(failure.message, /not a semver range/u);
  assert.doesNotMatch(failure.message, /is missing/u);
});

test('the remote audit reads the same *.js glob as doctor, so an omitted client is not clean', async () => {
  // The fixture's `"files": ["*.js"]` ships root-level JavaScript only; its
  // `exports["./client"]` lives at lib/client.js, so npm would leave it out.
  // `doctor --remote` and `audit --remote` read the same manifest, and both
  // must report that omission instead of calling the repository clean.
  const io = recorder();
  const code = await run(['audit', '--remote', 'demo/glob-js', '--json'], io, {
    fetchImpl: github({ 'demo/glob-js': fixtureFiles('glob-js') }),
  });

  assert.equal(code, 1);
  const [report] = JSON.parse(io.lines.join('\n'));
  assert.equal(report.target, 'demo/glob-js');
  assert.deepEqual(
    report.failures.map((failure) => failure.check),
    ['files list'],
  );
  assert.match(report.failures[0].message, /files does not ship lib\/client\.js/u);
});
