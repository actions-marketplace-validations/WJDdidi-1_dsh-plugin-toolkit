/**
 * `--host` says which DSH has to install the plugin; `--range` says what to
 * write. When both are passed they have to agree: the old planner printed
 * "host 0.3.0 is not inside the explicit range" and then wrote `>=0.5.0` with
 * exit 0, leaving a manifest that still rejects the host the repair was for.
 *
 * A conflicting pair is now a usage error at every entry point (local `fix`,
 * `doctor --fix`, remote `fix --remote`), and the remote path validates it
 * before its one GitHub request. The accepting pair remains a supported way to
 * write an exact range, and the applied patch is asserted against the
 * milestone's acceptance line: it accepts the host and rejects the next major.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../lib/cli.mjs';
import { satisfiesRange } from '../lib/compat.mjs';
import { fixRemote } from '../lib/remote.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-fix-conflict-'));

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

const rawOf = (dir) => fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
const manifestOf = (dir) => JSON.parse(rawOf(dir));

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

function noRequest() {
  return async (url) => {
    throw new Error(`the command read ${url} before rejecting the flags`);
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

const text = (io) => io.lines.join('\n');

test('a local --range that excludes the named host is refused and writes nothing', async () => {
  const dir = plugin({ node: '>=18' });
  const before = rawOf(dir);
  const io = recorder();

  const code = await run(['fix', dir, '--engines', '--host', '0.3.0', '--range', '>=0.5.0', '--write'], io);

  assert.equal(code, 1);
  assert.equal(rawOf(dir), before, 'a refused repair changed package.json');
  assert.equal(manifestOf(dir).engines.dsh, undefined);
});

test('the refusal names the range, the host and the way out', async () => {
  const dir = plugin({ node: '>=18' });
  const io = recorder();

  const code = await run(['fix', dir, '--engines', '--host', '0.3.0', '--range', '>=0.5.0'], io);

  assert.equal(code, 1);
  const output = text(io);
  assert.match(output, /--range ">=0\.5\.0" does not include host 0\.3\.0/u);
  assert.match(output, /drop --range to aim at the host automatically/u);
  assert.doesNotMatch(output, /would write engines\.dsh/u, 'the refused plan still printed a write');
});

test('a pre-release host excluded only by npm semantics gets the pre-release hint', async () => {
  const dir = plugin({ node: '>=18' });
  const io = recorder();

  const code = await run(
    ['fix', dir, '--engines', '--host', '0.2.2-alpha.3', '--range', '>=0.2.0', '--write'],
    io,
  );

  assert.equal(code, 1);
  const output = text(io);
  assert.match(output, /does not include host 0\.2\.2-alpha\.3/u);
  assert.match(output, /pre-release rule/u);
  assert.equal(manifestOf(dir).engines.dsh, undefined, 'the conflicting range was written anyway');
});

test('an explicit range that accepts the host is still written', async () => {
  const dir = plugin({ node: '>=18' });
  const io = recorder();

  const code = await run(
    ['fix', dir, '--engines', '--host', '0.3.0', '--range', '>=0.2.0 <1.0.0', '--write'],
    io,
  );

  assert.equal(code, 0);
  const written = manifestOf(dir).engines.dsh;
  assert.equal(written, '>=0.2.0 <1.0.0');
  assert.equal(satisfiesRange(written, '0.3.0'), true);
  assert.equal(satisfiesRange(written, '1.0.0'), false);
  assert.match(text(io), /host 0\.3\.0 is inside the explicit range/u);
});

test('a conflicting --range and --host is refused before GitHub is read', async () => {
  const io = recorder();

  const code = await run(
    ['fix', 'demo/plugin', '--remote', '--engines', '--host', '0.3.0', '--range', '>=0.5.0'],
    io,
    { fetchImpl: noRequest() },
  );

  assert.equal(code, 2);
  const output = text(io);
  assert.match(output, /does not include host 0\.3\.0/u);
  assert.doesNotMatch(output, /cannot reach GitHub|GitHub answered|rate-limited/u);
});

test('the library entry point refuses the same pair before it fetches', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('a refused repair read GitHub');
  };

  await assert.rejects(
    fixRemote('demo/plugin', { fetchImpl, host: '0.3.0', range: '>=0.5.0' }),
    /does not include host 0\.3\.0/u,
  );
  assert.equal(calls, 0);
});

test('doctor --fix refuses the same pair instead of writing one of the two', async () => {
  const dir = plugin({ node: '>=18' });
  const before = rawOf(dir);
  const io = recorder();

  const code = await run(['doctor', dir, '--fix', '--host', '0.3.0', '--range', '>=0.5.0', '--write'], io);

  assert.equal(code, 1);
  assert.match(text(io), /does not include host 0\.3\.0/u);
  assert.equal(rawOf(dir), before);
});

test('a bad --host is named even when --write is passed to --remote', async () => {
  const io = recorder();

  const code = await run(
    ['fix', 'demo/plugin', '--remote', '--engines', '--host', 'banana', '--write'],
    io,
    { fetchImpl: noRequest() },
  );

  assert.equal(code, 2);
  const output = text(io);
  assert.match(output, /is not a semver host version/u);
  assert.doesNotMatch(output, /remote repositories are read-only/u, 'the read-only refusal hid the bad host');
});

test('the read-only refusal names --patch as the way to apply the repair', async () => {
  const io = recorder();

  const code = await run(['fix', 'demo/plugin', '--remote', '--engines', '--host', '0.3.0', '--write'], io, {
    fetchImpl: noRequest(),
  });

  assert.equal(code, 2);
  const output = text(io);
  assert.match(output, /remote repositories are read-only/u);
  assert.match(output, /--patch <file>/u);
});

test('the remote plan plus patch still writes a range that accepts the host and rejects the next major', async (t) => {
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

  const written = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).engines.dsh;
  assert.equal(written, '>=0.3.0 <1.0.0');
  assert.equal(satisfiesRange(written, '0.3.0'), true, `the host is not accepted by ${written}`);
  assert.equal(satisfiesRange(written, '1.0.0'), false, `the next major is accepted by ${written}`);
});
