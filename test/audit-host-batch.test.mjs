/**
 * The batch acceptance experiment for `audit --remote --from --host 0.2.2`.
 *
 * The host answer has to survive every knob the batch grew: the same three
 * repositories are audited three times at `--jobs 1` and three times at
 * `--jobs 3`, producing nine verdicts per width, and the host-targeted repair
 * must land only beside the one repository whose range excludes the host.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../lib/cli.mjs';

const HOST = '0.2.2';
const TARGETS = ['acme/ok', 'acme/tooNew', 'acme/narrow'];
const RANGES = {
  'acme/ok': '>=0.2.0',
  'acme/tooNew': '>=99.0.0',
  'acme/narrow': '>=0.2.0 <0.3.0',
};
const EXPECTED = {
  'acme/ok': 'compatible',
  'acme/tooNew': 'incompatible',
  'acme/narrow': 'compatible',
};

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function files(range) {
  return {
    'package.json': JSON.stringify({
      name: `compat-${range}`,
      version: '1.0.0',
      license: 'MIT',
      type: 'module',
      engines: { node: '>=18', dsh: range },
      main: 'index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      files: ['index.js', 'cordis.patch.yml', 'README.md'],
    }),
    'README.md': `# compat\n\n## Requirements\n\n| DSH | ${range} |\n`,
    'cordis.patch.yml': '- insert: []\n',
    'index.js': 'export function apply() {}\n',
  };
}

const REPOSITORIES = Object.fromEntries(Object.entries(RANGES).map(([target, range]) => [target, files(range)]));

/**
 * Serve the three repositories from memory. `delays` reverses the completion
 * order under `--jobs 3`, so an implementation that prints as responses arrive
 * cannot pass by accident.
 */
function github({ delays = {} } = {}) {
  return async (url) => {
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)/u.exec(url);
    if (match === null) return { ok: false, status: 404, json: async () => ({}) };
    const [, owner, repo, file] = match;
    const target = `${owner}/${repo}`;
    const entry = REPOSITORIES[target];
    if (entry === undefined || Object.prototype.hasOwnProperty.call(entry, file) === false) {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    const wait = file === 'package.json' ? delays[target] ?? 0 : 0;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: encode(entry[file]) }) };
  };
}

const DELAYS = {
  'acme/ok': 25,
  'acme/tooNew': 0,
  'acme/narrow': 10,
};

function recorder() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-compat-batch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function listFile(t, contents = `${TARGETS.join('\n')}\n`) {
  const file = path.join(workspace(t), 'repos.txt');
  fs.writeFileSync(file, contents);
  return file;
}

function verdictLines(io) {
  return io.lines.filter((line) => TARGETS.some((target) => line.includes(target)));
}

async function jsonRows(list, jobs) {
  const rows = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const io = recorder();
    const code = await run(['audit', '--remote', '--from', list, '--json', '--host', HOST, '--jobs', jobs], io, {
      fetchImpl: github({ delays: DELAYS }),
    });
    assert.equal(code, 1, `--jobs ${jobs} must fail a batch that contains an incompatible range`);
    rows.push(...JSON.parse(io.lines.join('\n')));
  }
  return rows;
}

test('--jobs 1 and --jobs 3 produce the same nine host verdicts in input order', async (t) => {
  const list = listFile(t);
  const sequential = await jsonRows(list, '1');
  const parallel = await jsonRows(list, '3');

  assert.equal(sequential.length, 9, 'three runs of three repositories should produce nine findings');
  assert.deepEqual(parallel, sequential, '--jobs changed a verdict or the order findings are reported in');
  for (const row of sequential) {
    assert.equal(row.host, HOST, `${row.target} did not carry the host it was compared against`);
    assert.equal(row.compatibility, EXPECTED[row.target], `${row.target} got the wrong compatibility verdict`);
  }
});

test('a three-repository --from batch prints one compatibility verdict per line in input order', async (t) => {
  const list = listFile(t);
  const outputs = [];
  for (const jobs of ['1', '3']) {
    const io = recorder();
    const code = await run(['audit', '--remote', '--from', list, '--host', HOST, '--jobs', jobs], io, {
      fetchImpl: github({ delays: DELAYS }),
    });

    assert.equal(code, 1);
    const verdicts = verdictLines(io);
    assert.equal(verdicts.length, TARGETS.length, `--jobs ${jobs} did not print exactly one line per repository`);
    assert.deepEqual(
      verdicts.map((line) => TARGETS.find((target) => line.includes(target))),
      TARGETS,
      `--jobs ${jobs} did not preserve the input order`,
    );
    assert.match(verdicts[0], /\[compatible with dsh 0\.2\.2;/u);
    assert.match(verdicts[1], /^incompatible\s+acme\/tooNew\b.*\[incompatible with dsh 0\.2\.2;/u);
    assert.match(verdicts[2], /\[compatible with dsh 0\.2\.2;/u);
    outputs.push(verdicts.join('\n'));
  }
  assert.equal(outputs[1], outputs[0], '--jobs 3 printed a different batch report than --jobs 1');
});

test('--patch-dir writes a host-targeted repair only for the incompatible repository', async (t) => {
  const list = listFile(t);
  const repairs = [];
  for (const jobs of ['1', '3']) {
    const patchDir = path.join(workspace(t), `repairs-${jobs}`);
    const io = recorder();
    const code = await run(
      ['audit', '--remote', '--from', list, '--host', HOST, '--jobs', jobs, '--patch-dir', patchDir],
      io,
      { fetchImpl: github({ delays: DELAYS }) },
    );

    assert.equal(code, 1);
    assert.deepEqual(
      fs.readdirSync(patchDir).sort(),
      ['acme__tooNew.patch'],
      `--jobs ${jobs} wrote a patch for a repository that already accepts the host`,
    );
    const patch = fs.readFileSync(path.join(patchDir, 'acme__tooNew.patch'), 'utf8');
    assert.match(patch, /^--- a\/package\.json$/mu);
    assert.match(patch, /^\+.*"dsh": ">=0\.2\.2 <1\.0\.0"$/mu, 'the patch did not aim the range at the host');
    assert.match(io.lines.join('\n'), /1 patch written/u);
    repairs.push(patch);
  }
  assert.equal(repairs[1], repairs[0], '--jobs 3 wrote a different host-targeted repair than --jobs 1');
});
