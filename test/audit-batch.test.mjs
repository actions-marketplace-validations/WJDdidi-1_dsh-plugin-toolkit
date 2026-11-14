import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../lib/cli.mjs';

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
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

// `dsh: {}` declares no patch for the host to load. The file checks cannot see
// that omission because no patch path is declared, so only the shared manifest
// check (`dsh field`) can fail this repository. A batch must carry that failure
// into both its printed verdict and its `--json` finding.
const noBundleFiles = {
  ...cleanFiles,
  'package.json': JSON.stringify(manifest({ dsh: {} })),
};

const twoProblemFiles = {
  ...cleanFiles,
  'package.json': JSON.stringify(
    manifest({
      engines: undefined,
      dsh: { bundle: { patch: 'cordis.patch.yml' }, client: { platform: 'web' } },
    }),
  ),
};

const threeProblemFiles = {
  'package.json': twoProblemFiles['package.json'],
  'index.js': cleanFiles['index.js'],
  'cordis.patch.yml': cleanFiles['cordis.patch.yml'],
  // No README, so the two missing manifest declarations above are joined by
  // the readme check.
};

function github(repositories) {
  return async (url) => {
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)/u.exec(url);
    if (match === null) return { ok: false, status: 404, json: async () => ({}) };
    const [, owner, repo, file] = match;
    const entry = repositories[`${owner}/${repo}`];
    if (entry === 'rate-limit') return { ok: false, status: 403, json: async () => ({ message: 'rate limit' }) };
    if (entry === 'unreadable') return { ok: false, status: 500, json: async () => ({ message: 'server error' }) };
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

function listFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-audit-'));
  const file = path.join(dir, 'repos.txt');
  fs.writeFileSync(file, contents);
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('audit --remote --from reads a file, prints one line per repository and a clean summary', async (t) => {
  const list = listFile('demo/one\ndemo/two\n');
  t.after(list.cleanup);
  const io = recorder();
  const code = await run(['audit', '--remote', '--from', list.file], io, {
    fetchImpl: github({ 'demo/one': cleanFiles, 'demo/two': cleanFiles }),
  });

  assert.equal(code, 0);
  const output = io.lines.join('\n');
  assert.equal(io.lines.filter((line) => line.startsWith('clean') && line.includes('demo/one')).length, 1);
  assert.equal(io.lines.filter((line) => line.startsWith('clean') && line.includes('demo/two')).length, 1);
  assert.match(output, /summary: 2 repositories — 2 clean, 0 failing \(0 problems\), 0 unreadable/u);
});

test('audit --remote --from exits 1 and names the failing repository', async (t) => {
  const list = listFile('demo/clean\ndemo/broken\n');
  t.after(list.cleanup);
  const io = recorder();
  const code = await run(['audit', '--remote', '--from', list.file], io, {
    fetchImpl: github({ 'demo/clean': cleanFiles, 'demo/broken': brokenFiles }),
  });

  assert.equal(code, 1);
  const output = io.lines.join('\n');
  assert.match(output, /failing\s+demo\/broken\s+— engines\.dsh:/u);
  assert.match(output, /1 clean, 1 failing \(1 problem\), 0 unreadable/u);
});

test('audit --remote --from carries an empty dsh field into the failing row and the JSON finding', async (t) => {
  const list = listFile('demo/no-bundle\n');
  t.after(list.cleanup);
  const fetchImpl = github({ 'demo/no-bundle': noBundleFiles });

  const text = recorder();
  const textCode = await run(['audit', '--remote', '--from', list.file], text, { fetchImpl });
  assert.equal(textCode, 1);
  const output = text.lines.join('\n');
  assert.match(output, /failing\s+demo\/no-bundle\s+— dsh field: dsh\.bundle is missing/u);
  assert.match(output, /summary: 1 repository — 0 clean, 1 failing \(1 problem\), 0 unreadable/u);

  const json = recorder();
  const jsonCode = await run(['audit', '--remote', '--from', list.file, '--json'], json, { fetchImpl });
  assert.equal(jsonCode, 1);
  const [finding] = JSON.parse(json.lines.join('\n'));
  assert.equal(finding.target, 'demo/no-bundle');
  assert.equal(finding.version, '1.2.3');
  assert.equal(finding.hostRange, '>=0.2.0');
  assert.deepEqual(finding.failures, [
    {
      check: 'dsh field',
      message: 'dsh.bundle is missing; the host needs the patch file it points at',
    },
  ]);
});

test('the summary counts failed checks rather than failing repositories', async (t) => {
  const list = listFile('demo/two-problems\n');
  t.after(list.cleanup);
  const io = recorder();
  const code = await run(['audit', '--remote', '--from', list.file], io, {
    fetchImpl: github({ 'demo/two-problems': twoProblemFiles }),
  });

  assert.equal(code, 1);
  const output = io.lines.join('\n');
  assert.match(output, /failing\s+demo\/two-problems\s+— engines\.dsh:/u);
  assert.match(output, /\(\+1 more\)/u);
  assert.match(output, /summary: 1 repository — 0 clean, 1 failing \(2 problems\), 0 unreadable, 0 rate-limited/u);
});

test('the batch summary parenthetical is the sum of every repository\'s failures', async (t) => {
  const repositories = {
    'demo/clean': cleanFiles,
    'demo/one-problem': brokenFiles,
    'demo/two-problems': twoProblemFiles,
    'demo/three-problems': threeProblemFiles,
  };
  const list = listFile(`${Object.keys(repositories).join('\n')}\n`);
  t.after(list.cleanup);

  const text = recorder();
  const textCode = await run(['audit', '--remote', '--from', list.file], text, {
    fetchImpl: github(repositories),
  });
  assert.equal(textCode, 1);
  const output = text.lines.join('\n');
  const summary = /summary: 4 repositories — 1 clean, 3 failing \((\d+) problems?\), 0 unreadable, 0 rate-limited/u.exec(
    output,
  );
  assert.ok(summary, `the summary line did not match:\n${output}`);

  // The JSON findings are the source of truth for how many checks failed; the
  // printed parenthetical is the claim under test.
  const json = recorder();
  const jsonCode = await run(['audit', '--remote', '--from', list.file, '--json'], json, {
    fetchImpl: github(repositories),
  });
  assert.equal(jsonCode, 1);
  const reports = JSON.parse(json.lines.join('\n'));
  const failures = reports.reduce((count, report) => count + report.failures.length, 0);
  assert.equal(failures, 6); // 0 + 1 + 2 + 3
  assert.equal(Number(summary[1]), failures);
});

test('audit --remote --from reports a rate-limited repository as rate-limited, never clean or unreadable', async (t) => {
  const list = listFile('demo/blocked\n');
  t.after(list.cleanup);
  const io = recorder();
  const code = await run(['audit', '--remote', '--from', list.file], io, {
    fetchImpl: github({ 'demo/blocked': 'rate-limit' }),
  });

  assert.equal(code, 1);
  const output = io.lines.join('\n');
  assert.match(output, /rate-limited\s+demo\/blocked\s+— GitHub rate-limited/u);
  assert.doesNotMatch(output, /^\s*clean\s+demo\/blocked/mu);
  assert.doesNotMatch(output, /^\s*unreadable\s+demo\/blocked/mu);
  assert.match(output, /0 clean, 0 failing \(0 problems\), 0 unreadable, 1 rate-limited/u);
});

test('audit --remote --from reports an unreadable repository as a note, never a clean pass', async (t) => {
  const list = listFile('demo/clean\ndemo/unreadable\n');
  t.after(list.cleanup);
  const fetchImpl = github({ 'demo/clean': cleanFiles, 'demo/unreadable': 'unreadable' });

  const text = recorder();
  const textCode = await run(['audit', '--remote', '--from', list.file], text, { fetchImpl });
  assert.equal(textCode, 1);
  const output = text.lines.join('\n');
  assert.match(output, /unreadable\s+demo\/unreadable\s+— GitHub answered 500 for package\.json/u);
  assert.doesNotMatch(output, /^clean\s+demo\/unreadable/mu);
  assert.match(output, /1 clean, 0 failing \(0 problems\), 1 unreadable/u);

  const json = recorder();
  const jsonCode = await run(['audit', '--remote', '--from', list.file, '--json'], json, { fetchImpl });
  assert.equal(jsonCode, 1);
  const reports = JSON.parse(json.lines.join('\n'));
  const unreadable = reports.find((report) => report.target === 'demo/unreadable');
  assert.equal(unreadable.unreadable, true);
  assert.equal(unreadable.rateLimited, undefined);
  assert.deepEqual(unreadable.failures, []);
  assert.match(unreadable.notes[0], /GitHub answered 500/u);
});

test('audit --remote --from --json prints the existing finding array', async (t) => {
  const list = listFile('demo/clean\ndemo/broken\ndemo/blocked\n');
  t.after(list.cleanup);
  const io = recorder();
  const code = await run(['audit', '--remote', '--from', list.file, '--json'], io, {
    fetchImpl: github({ 'demo/clean': cleanFiles, 'demo/broken': brokenFiles, 'demo/blocked': 'rate-limit' }),
  });

  assert.equal(code, 1);
  const reports = JSON.parse(io.lines.join('\n'));
  assert.equal(Array.isArray(reports), true);
  assert.deepEqual(reports.map((report) => report.target), ['demo/clean', 'demo/broken', 'demo/blocked']);
  assert.deepEqual(reports[0], {
    target: 'demo/clean',
    version: '1.2.3',
    hostRange: '>=0.2.0',
    failures: [],
    notes: [],
  });
  assert.equal(reports[1].failures.some((failure) => failure.check === 'engines.dsh'), true);
  assert.equal(reports[2].unreadable, undefined);
  assert.equal(reports[2].rateLimited, true);
  assert.equal(reports[2].notes.some((note) => /rate-limited/u.test(note)), true);
});

test('audit --remote --from - reads the list from standard input', async () => {
  const io = recorder();
  const code = await run(['audit', '--remote', '--from', '-'], io, {
    stdin: 'demo/clean\n',
    fetchImpl: github({ 'demo/clean': cleanFiles }),
  });

  assert.equal(code, 0);
  assert.match(io.lines.join('\n'), /clean\s+demo\/clean/u);
});

test('audit --remote --from accepts the JSON evidence shape as well as plain lines', async (t) => {
  const list = listFile(JSON.stringify({ rows: [{ repo: 'demo/clean' }, { repo: 'demo/broken' }] }));
  t.after(list.cleanup);
  const io = recorder();
  const code = await run(['audit', '--remote', '--from', list.file, '--json'], io, {
    fetchImpl: github({ 'demo/clean': cleanFiles, 'demo/broken': brokenFiles }),
  });

  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(io.lines.join('\n')).map((report) => report.target), ['demo/clean', 'demo/broken']);
});
