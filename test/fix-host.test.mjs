/**
 * `fix --host` aims the written range at the DSH that rejected the install.
 * The range has to include the host and stop before the next major; the plan
 * says that in words so the author does not have to reverse-engineer the diff.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../lib/cli.mjs';
import { satisfiesRange } from '../lib/compat.mjs';
import { fixEngines } from '../lib/fix.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-fix-host-'));

function plugin(engines) {
  const dir = path.join(scratch(), 'plugin');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    name: 'fix-me',
    version: '1.0.0',
    engines,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    files: ['index.js', 'README.md'],
  };
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

const manifestOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function github(raw) {
  return async (url) => {
    if (url.includes('/contents/package.json') === false) {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: encode(raw) }) };
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

test('--host writes a range that accepts the host and rejects the next major', () => {
  const dir = plugin({ node: '>=18' });

  const result = fixEngines({ dir, host: '0.3.0', write: true });

  assert.equal(result.ok, true);
  assert.equal(result.written, true);
  assert.match(result.why, /host 0\.3\.0/u);
  assert.match(result.why, /1\.0\.0/u);

  const written = manifestOf(dir).engines.dsh;
  assert.equal(satisfiesRange(written, '0.3.0'), true, `host is not accepted by ${written}`);
  assert.equal(satisfiesRange(written, '1.0.0'), false, `next major is accepted by ${written}`);
  assert.equal(satisfiesRange(written, '0.2.9'), false, `older minor is accepted by ${written}`);
  assert.equal(manifestOf(dir).engines.node, '>=18', 'the node engine is not the fixer’s to remove');
});

test('--host replaces a valid range that excludes the host, without a second flag', () => {
  const dir = plugin({ dsh: '>=0.5.0' });

  const result = fixEngines({ dir, host: '0.3.0', write: true });

  assert.equal(result.written, true);
  assert.equal(satisfiesRange(manifestOf(dir).engines.dsh, '0.3.0'), true);
  assert.equal(satisfiesRange(manifestOf(dir).engines.dsh, '1.0.0'), false);
});

test('--host keeps a declared lower bound that already accepts the host', () => {
  const dir = plugin({ dsh: '>=0.2.0' });

  const result = fixEngines({ dir, host: '0.3.0', write: true });

  assert.equal(result.written, true);
  assert.equal(manifestOf(dir).engines.dsh, '>=0.2.0 <1.0.0');
  assert.equal(satisfiesRange(manifestOf(dir).engines.dsh, '0.2.0'), true, 'the declared 0.2.x support was dropped');
  assert.equal(satisfiesRange(manifestOf(dir).engines.dsh, '0.3.0'), true);
  assert.equal(satisfiesRange(manifestOf(dir).engines.dsh, '1.0.0'), false);
  assert.match(result.why, /keeping that lower bound/u);
});

test('--host caps every alternation branch instead of dropping the old one', () => {
  const dir = plugin({ dsh: '>=0.2.0 <0.4.0 || >=0.5.0' });

  const result = fixEngines({ dir, host: '0.3.0', write: true });

  assert.equal(result.written, true);
  assert.match(result.why, /keeping that lower bound/u);
  const written = manifestOf(dir).engines.dsh;
  assert.equal(written, '>=0.2.0 <0.4.0 || >=0.5.0 <1.0.0');
  assert.equal(satisfiesRange(written, '0.2.0'), true, 'the first branch was dropped');
  assert.equal(satisfiesRange(written, '0.3.0'), true, 'the host is not accepted');
  assert.equal(satisfiesRange(written, '0.5.0'), true, 'the second branch was dropped');
  assert.equal(satisfiesRange(written, '1.0.0'), false, 'the next major is accepted');
});

test('--host drops an alternation branch that the next-major ceiling empties', () => {
  const dir = plugin({ dsh: '>=0.2.0 <2.0.0 || >=2.0.0' });

  const result = fixEngines({ dir, host: '1.5.0', write: true });

  assert.equal(result.written, true);
  // The second branch starts at the ceiling, so `>=2.0.0 <2.0.0` would match
  // nothing. Keeping it would make the plan claim a supported line the host
  // cannot use, and every later reader would have to parse an empty range.
  assert.equal(manifestOf(dir).engines.dsh, '>=0.2.0 <2.0.0');
  assert.equal(satisfiesRange(result.range, '0.2.0'), true, 'the declared floor was dropped');
  assert.equal(satisfiesRange(result.range, '1.5.0'), true, 'the host is not accepted');
  assert.equal(satisfiesRange(result.range, '2.0.0'), false, 'the next major is accepted');
  assert.equal(satisfiesRange(result.range, '2.5.0'), false, 'the emptied branch is still in the range');
  assert.match(result.why, /keeping that lower bound/u);
});

test('--host leaves a range that already accepts the host and excludes the next major', () => {
  const dir = plugin({ dsh: '>=0.2.0 <1.0.0' });
  const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');

  const result = fixEngines({ dir, host: '0.3.0', write: true });

  assert.equal(result.changed, false);
  assert.equal(result.written, false);
  assert.equal(result.reason, 'already-correct');
  assert.match(result.why, /already inside/u);
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), before);
});

test('the CLI prints the host, the range and why before writing it', async () => {
  const dir = plugin({ node: '>=18' });
  const io = recorder();

  const code = await run(['fix', dir, '--engines', '--host', '0.3.0', '--write'], io);

  assert.equal(code, 0);
  const output = io.lines.join('\n');
  assert.match(output, /wrote engines\.dsh/u);
  assert.match(output, />=0\.3\.0 <1\.0\.0/u);
  assert.match(output, /host 0\.3\.0 is inside/u);
  assert.match(output, /1\.0\.0 is excluded/u);

  const written = manifestOf(dir).engines.dsh;
  assert.equal(satisfiesRange(written, '0.3.0'), true);
  assert.equal(satisfiesRange(written, '1.0.0'), false);
});

test('fix --remote --engines --host plans the host range and prints why', async () => {
  const raw = `${JSON.stringify({ name: 'demo-plugin', version: '1.2.3', engines: { node: '>=18' } }, null, 2)}\n`;
  const io = recorder();

  const code = await run(['fix', 'demo/plugin', '--remote', '--engines', '--host', '0.3.0'], io, {
    fetchImpl: github(raw),
  });

  assert.equal(code, 0);
  const output = io.lines.join('\n');
  assert.match(output, /would write engines\.dsh ">=0\.3\.0 <1\.0\.0"/u);
  assert.match(output, /^\+ {4}"dsh": ">=0\.3\.0 <1\.0\.0"$/mu);
  assert.match(output, /host 0\.3\.0 is inside/u);
  assert.match(output, /1\.0\.0 is excluded/u);
});

test('fix --remote --engines --host replaces a valid range that excludes the host', async () => {
  const raw = `${JSON.stringify(
    { name: 'demo-plugin', version: '1.2.3', engines: { dsh: '>=0.5.0' } },
    null,
    2,
  )}\n`;
  const io = recorder();

  const code = await run(['fix', 'demo/plugin', '--remote', '--engines', '--host', '0.3.0'], io, {
    fetchImpl: github(raw),
  });

  assert.equal(code, 0);
  const output = io.lines.join('\n');
  assert.match(output, /would write engines\.dsh ">=0\.3\.0 <1\.0\.0"/u);
  assert.match(output, /^\+ {4}"dsh": ">=0\.3\.0 <1\.0\.0"$/mu);
  assert.match(output, /host 0\.3\.0 is inside/u);
  assert.match(output, /1\.0\.0 is excluded/u);
  assert.equal(satisfiesRange('>=0.3.0 <1.0.0', '0.3.0'), true);
  assert.equal(satisfiesRange('>=0.3.0 <1.0.0', '1.0.0'), false);
});

test('fix --remote --engines --host keeps a compatible declared floor in the plan', async () => {
  const raw = `${JSON.stringify(
    { name: 'demo-plugin', version: '1.2.3', engines: { dsh: '>=0.2.0' } },
    null,
    2,
  )}\n`;
  const io = recorder();

  const code = await run(['fix', 'demo/plugin', '--remote', '--engines', '--host', '0.3.0'], io, {
    fetchImpl: github(raw),
  });

  assert.equal(code, 0);
  const output = io.lines.join('\n');
  assert.match(output, /would write engines\.dsh ">=0\.2\.0 <1\.0\.0"/u);
  assert.match(output, /keeping that lower bound/u);
  assert.match(output, /^\+ {4}"dsh": ">=0\.2\.0 <1\.0\.0"$/mu);
  assert.equal(satisfiesRange('>=0.2.0 <1.0.0', '0.3.0'), true);
  assert.equal(satisfiesRange('>=0.2.0 <1.0.0', '1.0.0'), false);
});

test('--host keeps a hyphen range’s floor instead of dropping it', () => {
  const dir = plugin({ dsh: '0.2.0 - 2.0.0' });

  const result = fixEngines({ dir, host: '0.3.0', write: true });

  assert.equal(result.written, true);
  assert.match(result.why, /keeping that lower bound/u);
  // The hyphen expression cannot carry an extra comparator, so it has to become
  // the equivalent comparator set; appending directly would not parse and the
  // planner would fall back to the host floor.
  assert.equal(manifestOf(dir).engines.dsh, '>=0.2.0 <1.0.0');
  assert.equal(satisfiesRange(manifestOf(dir).engines.dsh, '0.2.0'), true, 'the declared 0.2.x support was dropped');
  assert.equal(satisfiesRange(manifestOf(dir).engines.dsh, '0.3.0'), true, 'the host is not accepted');
  assert.equal(satisfiesRange(manifestOf(dir).engines.dsh, '1.0.0'), false, 'the next major is accepted');
});

test('--host caps a hyphen branch beside an alternation branch', () => {
  const dir = plugin({ dsh: '0.2 - 2 || >=3.0.0' });

  const result = fixEngines({ dir, host: '0.3.0', write: true });

  assert.equal(result.written, true);
  const written = manifestOf(dir).engines.dsh;
  assert.equal(written, '>=0.2.0 <1.0.0 || >=3.0.0');
  assert.equal(satisfiesRange(written, '0.2.9'), true, 'the declared 0.2.x support was dropped');
  assert.equal(satisfiesRange(written, '0.3.0'), true, 'the host is not accepted');
  assert.equal(satisfiesRange(written, '1.0.0'), false, 'the next major is accepted');
});

test('fix --remote --engines --host keeps a hyphen range’s floor in the plan', async () => {
  const raw = `${JSON.stringify(
    { name: 'demo-plugin', version: '1.2.3', engines: { dsh: '0.2.0 - 2.0.0' } },
    null,
    2,
  )}\n`;
  const io = recorder();

  const code = await run(['fix', 'demo/plugin', '--remote', '--engines', '--host', '0.3.0'], io, {
    fetchImpl: github(raw),
  });

  assert.equal(code, 0);
  const output = io.lines.join('\n');
  assert.match(output, /would write engines\.dsh ">=0\.2\.0 <1\.0\.0"/u);
  assert.match(output, /keeping that lower bound/u);
  assert.match(output, /^\+ {4}"dsh": ">=0\.2\.0 <1\.0\.0"$/mu);
  assert.equal(satisfiesRange('>=0.2.0 <1.0.0', '0.3.0'), true);
  assert.equal(satisfiesRange('>=0.2.0 <1.0.0', '1.0.0'), false);
});

test('fix --remote --engines --host does not print a ceiling-empty branch', async () => {
  const raw = `${JSON.stringify(
    { name: 'demo-plugin', version: '1.2.3', engines: { dsh: '>=0.2.0 <2.0.0 || >=2.0.0' } },
    null,
    2,
  )}\n`;
  const io = recorder();

  const code = await run(['fix', 'demo/plugin', '--remote', '--engines', '--host', '1.5.0'], io, {
    fetchImpl: github(raw),
  });

  assert.equal(code, 0);
  const output = io.lines.join('\n');
  assert.match(output, /would write engines\.dsh ">=0\.2\.0 <2\.0\.0"/u);
  assert.doesNotMatch(output, /2\.0\.0 <2\.0\.0/u, 'the plan printed an empty alternation branch');
  assert.match(output, /^\+ {4}"dsh": ">=0\.2\.0 <2\.0\.0"$/mu);
  assert.equal(satisfiesRange('>=0.2.0 <2.0.0', '1.5.0'), true);
  assert.equal(satisfiesRange('>=0.2.0 <2.0.0', '2.0.0'), false);
});

test('the remote patch keeps a compatible floor in the written manifest', async (t) => {
  const raw = `${JSON.stringify(
    { name: 'demo-plugin', version: '1.2.3', engines: { dsh: '>=0.2.0' } },
    null,
    2,
  )}\n`;
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(checkout, { recursive: true });
  const manifestPath = path.join(checkout, 'package.json');
  fs.writeFileSync(manifestPath, raw);
  const patchFile = path.join(root, 'repair.patch');
  const io = recorder();

  const code = await run(
    ['fix', 'demo/plugin', '--remote', '--engines', '--host', '0.3.0', '--patch', patchFile],
    io,
    { fetchImpl: github(raw) },
  );

  assert.equal(code, 0);
  execFileSync('git', ['apply', patchFile], { cwd: checkout, stdio: 'pipe' });
  const written = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(written.engines.dsh, '>=0.2.0 <1.0.0');
  assert.equal(satisfiesRange(written.engines.dsh, '0.2.0'), true, 'the declared 0.2.x support was dropped');
  assert.equal(satisfiesRange(written.engines.dsh, '0.3.0'), true, 'the host is not accepted');
  assert.equal(satisfiesRange(written.engines.dsh, '1.0.0'), false, 'the next major is accepted');
});

test('an invalid --host is refused instead of writing a guessed range', async () => {
  const dir = plugin({ node: '>=18' });
  const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  const io = recorder();

  const code = await run(['fix', dir, '--engines', '--host', 'not-a-version'], io);

  assert.equal(code, 1);
  assert.match(io.lines.join('\n'), /not a semver host version/u);
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), before);
});

test('the host-targeted remote patch applies to a checkout and that written range is the acceptance range', async (t) => {
  const raw = `${JSON.stringify(
    {
      name: 'demo-plugin',
      version: '1.2.3',
      engines: { node: '>=18' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      files: ['index.js', 'README.md'],
    },
    null,
    2,
  )}\n`;
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(checkout, { recursive: true });
  const manifestPath = path.join(checkout, 'package.json');
  fs.writeFileSync(manifestPath, raw);
  const patchFile = path.join(root, 'repair.patch');
  const io = recorder();

  const code = await run(
    ['fix', 'demo/plugin', '--remote', '--engines', '--host', '0.3.0', '--patch', patchFile],
    io,
    { fetchImpl: github(raw) },
  );

  assert.equal(code, 0);
  execFileSync('git', ['apply', patchFile], { cwd: checkout, stdio: 'pipe' });

  const written = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(written.engines.dsh, '>=0.3.0 <1.0.0');
  assert.equal(written.engines.node, '>=18', 'the node engine is not the fixer’s to remove');
  assert.equal(satisfiesRange(written.engines.dsh, '0.3.0'), true, `the host is not accepted by ${written.engines.dsh}`);
  assert.equal(satisfiesRange(written.engines.dsh, '1.0.0'), false, `the next major is accepted by ${written.engines.dsh}`);
  assert.match(io.lines.join('\n'), /host 0\.3\.0 is inside/u);
});

test('a remote --host that is not semver is refused before a patch file is created', async (t) => {
  const raw = `${JSON.stringify({ name: 'demo-plugin', version: '1.2.3', engines: { node: '>=18' } }, null, 2)}\n`;
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const patchFile = path.join(root, 'repair.patch');
  const io = recorder();

  const code = await run(
    ['fix', 'demo/plugin', '--remote', '--engines', '--host', '0.3', '--patch', patchFile],
    io,
    { fetchImpl: github(raw) },
  );

  assert.equal(code, 2);
  assert.match(io.lines.join('\n'), /not a semver host version/u);
  assert.equal(fs.existsSync(patchFile), false, 'a refused host still created a patch file');
});
