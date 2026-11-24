/**
 * A remote package.json must be a JSON object, and a manifest that is not one
 * must be reported by name.
 *
 * `null`, a string, a number and an array all parse as JSON, so the reader used
 * to move on and either crash inside the first manifest check
 * (`Cannot read properties of null`) or treat the array as an object with no
 * useful fields. The local reader already refuses those values with
 * "does not hold a JSON object"; the remote path now says the same thing, which
 * also means `audit --remote --host` stops at the manifest instead of failing
 * with a message that never names the file or the host question.
 *
 * The object control keeps the check honest: a real manifest still gets the
 * compatibility answer, unchanged.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { auditRemoteTargets, remoteFinding } from '../lib/audit.mjs';
import { auditRemote } from '../lib/remote.mjs';
import { run } from '../lib/cli.mjs';

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

const VALID_MANIFEST = JSON.stringify({
  name: 'demo-plugin',
  version: '1.2.3',
  main: 'index.js',
  engines: { dsh: '>=0.2.0' },
  dsh: { bundle: { patch: 'cordis.patch.yml' } },
  files: ['index.js', 'cordis.patch.yml', 'README.md'],
});

const VALID_FILES = {
  'package.json': VALID_MANIFEST,
  'index.js': 'export function apply() {}\n',
  'cordis.patch.yml': '- insert:\n    - id: test-plugin\n      name: test-plugin\n      config: {}\n',
  'README.md': '# demo\n\n## Requirements\n\nRequires dsh >=0.2.0.\n',
};

/**
 * Serve one raw package.json per target. The valid control also serves the
 * files its manifest names, so it can reach a compatibility verdict.
 */
function github(rawByTarget) {
  return async (url) => {
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)/u.exec(url);
    if (match === null) return { ok: false, status: 404, json: async () => ({}) };
    const [, owner, repo, file] = match;
    const target = `${owner}/${repo}`;
    const entry = rawByTarget[target];
    if (entry === undefined) return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    const files = typeof entry === 'string' ? { 'package.json': entry } : entry;
    if (Object.prototype.hasOwnProperty.call(files, file) === false) {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: encode(files[file]) }) };
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

const SHAPES = [
  ['null', 'null'],
  ['array', '[]'],
  ['string', '"not a manifest"'],
  ['number', '42'],
  ['boolean', 'true'],
];

test('a non-object package.json is a manifest failure naming the repository', async () => {
  const targets = Object.fromEntries(SHAPES.map(([name, raw]) => [`demo/${name}`, raw]));
  const fetchImpl = github(targets);

  for (const [name, raw] of SHAPES) {
    const report = await auditRemote(`demo/${name}`, { fetchImpl });
    assert.equal(report.manifest, null, `${name}: no manifest should survive the shape check`);
    assert.deepEqual(
      report.failures,
      [{ check: 'manifest', message: `package.json at demo/${name} does not hold a JSON object` }],
      `${name}: the file must be named instead of a field read from the wrong shape (${raw})`,
    );
    assert.deepEqual(report.checked, [], `${name}: no manifest check should run on a non-object`);
  }
});

test('audit --remote --host reports the shape instead of a fabricated host verdict', async () => {
  const targets = Object.fromEntries(SHAPES.map(([name, raw]) => [`demo/${name}`, raw]));
  const io = recorder();
  const code = await run(
    ['audit', '--remote', SHAPES.map(([name]) => `demo/${name}`).join(','), '--host', '0.2.2', '--json'],
    io,
    { fetchImpl: github(targets) },
  );

  assert.equal(code, 1);
  const rows = JSON.parse(io.lines.join('\n'));
  assert.equal(rows.length, SHAPES.length);
  for (const [index, [name]] of SHAPES.entries()) {
    const row = rows[index];
    assert.equal(row.target, `demo/${name}`);
    assert.equal(row.version, null);
    assert.equal(row.hostRange, null);
    assert.equal(row.host, undefined, `${name}: a row with no manifest must not claim a host`);
    assert.equal(row.compatibility, undefined, `${name}: a row with no manifest must not invent a verdict`);
    assert.deepEqual(row.failures, [
      { check: 'manifest', message: `package.json at demo/${name} does not hold a JSON object` },
    ]);
  }
});

test('the text row and doctor --remote name the file instead of a TypeError', async () => {
  const fetchImpl = github({ 'demo/null': 'null' });

  const audit = recorder();
  const auditCode = await run(['audit', '--remote', 'demo/null', '--host', '0.2.2'], audit, { fetchImpl });
  assert.equal(auditCode, 1);
  const auditOutput = audit.lines.join('\n');
  assert.match(auditOutput, /manifest: package\.json at demo\/null does not hold a JSON object/u);
  assert.doesNotMatch(auditOutput, /Cannot read properties/u);
  assert.doesNotMatch(auditOutput, /\[(compatible|incompatible|unknown) with dsh/u);

  const doctor = recorder();
  const doctorCode = await run(['doctor', '--remote', 'demo/null'], doctor, { fetchImpl });
  assert.equal(doctorCode, 1);
  const doctorOutput = doctor.lines.join('\n');
  assert.match(doctorOutput, /1 problem\(s\) in demo\/null/u);
  assert.match(doctorOutput, /manifest: package\.json at demo\/null does not hold a JSON object/u);
  assert.doesNotMatch(doctorOutput, /Cannot read properties/u);
});

test('a real object manifest still receives the host compatibility answer', async () => {
  const fetchImpl = github({ 'demo/valid': VALID_FILES });

  const report = await auditRemote('demo/valid', { fetchImpl, host: '0.2.2' });
  assert.deepEqual(report.failures, []);
  assert.equal(report.manifest.version, '1.2.3');
  assert.equal(report.compatibility, 'compatible');

  const finding = remoteFinding(report, '0.2.2');
  assert.equal(finding.hostRange, '>=0.2.0');
  assert.equal(finding.host, '0.2.2');
  assert.equal(finding.compatibility, 'compatible');

  const batch = await auditRemoteTargets('demo/valid', {
    fetchImpl,
    host: '0.2.2',
    io: { log: () => {}, error: () => {} },
  });
  assert.equal(batch.ok, true);
  assert.equal(batch.reports[0].compatibility, 'compatible');
});
