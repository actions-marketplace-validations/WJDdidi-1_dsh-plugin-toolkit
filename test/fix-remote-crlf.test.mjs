/**
 * `fix --remote --patch` must produce a diff that applies to the checkout the
 * manifest came from, whatever its line endings are. A CRLF `package.json`
 * used to be planned against LF-normalized lines, so the saved patch failed
 * `git apply --check` on the very bytes it described and the documented batch
 * repair dead-ended on Windows checkouts.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../lib/cli.mjs';
import { fixRemote } from '../lib/remote.mjs';

const manifest = {
  name: 'crlf-plugin',
  version: '1.2.3',
  engines: { node: '>=18' },
  dsh: { bundle: { patch: 'cordis.patch.yml' } },
  files: ['index.js', 'cordis.patch.yml', 'README.md'],
};

/** Serve package.json from memory and answer every other path with 404. */
function github(raw) {
  return async (url) => {
    if (url.includes('/contents/package.json') === false) {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ encoding: 'base64', content: Buffer.from(raw, 'utf8').toString('base64') }),
    };
  };
}

function recorder() {
  const lines = [];
  return { lines, log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
}

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fix-remote-crlf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A checkout holding exactly the bytes the remote read served. */
function checkout(dir, raw) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), raw, 'utf8');
  fs.writeFileSync(path.join(dir, 'index.js'), '');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '');
  fs.writeFileSync(path.join(dir, 'README.md'), '# crlf-plugin\n');
  return dir;
}

function repair(t, raw, name) {
  const root = workspace(t);
  const target = checkout(path.join(root, name), raw);
  const patchFile = path.join(root, `${name}.patch`);
  const io = recorder();

  return run(['fix', 'acme/crlf-plugin', '--remote', '--patch', patchFile], io, {
    fetchImpl: github(raw),
  }).then((code) => ({ code, io, target, patchFile }));
}

test('a CRLF manifest produces a patch that git apply --check accepts', async (t) => {
  const raw = `${JSON.stringify(manifest, null, 2)}\n`.replace(/\n/gu, '\r\n');
  const { code, io, target, patchFile } = await repair(t, raw, 'crlf');

  assert.equal(code, 0, io.lines.join('\n'));
  assert.ok(fs.existsSync(patchFile), 'the patch file was not created');
  const written = fs.readFileSync(patchFile, 'utf8');
  assert.ok(written.includes('\r\n'), 'the patch lost the manifest’s CRLF body');

  execFileSync('git', ['apply', '--check', patchFile], { cwd: target, stdio: 'pipe' });
  execFileSync('git', ['apply', patchFile], { cwd: target, stdio: 'pipe' });

  const after = fs.readFileSync(path.join(target, 'package.json'), 'utf8');
  assert.equal(after.includes('\r\n'), true, 'the applied manifest is no longer CRLF');
  assert.equal(/(^|[^\r])\n/u.test(after), false, 'the applied manifest has a bare LF');
  assert.equal(JSON.parse(after).engines.dsh, '>=0.2.0');
});

test('a batch repair reuses the audited CRLF manifestText and applies its patch', async (t) => {
  // `audit --remote --patch-dir` hands `fixRemote` the manifest it already read
  // instead of spending a second GitHub request. That is the documented batch
  // repair, and it must use the same CRLF-safe diff as the single-repository
  // command rather than re-reading (or normalizing) the manifest.
  const raw = `${JSON.stringify(manifest, null, 2)}\n`.replace(/\n/gu, '\r\n');
  const root = workspace(t);
  const target = checkout(path.join(root, 'batch'), raw);
  const patchFile = path.join(root, 'batch.patch');
  let requests = 0;

  const result = await fixRemote('acme/crlf-plugin', {
    manifestText: raw,
    patch: patchFile,
    fetchImpl: async () => {
      requests += 1;
      throw new Error('the batch repair must reuse the manifest it was given');
    },
  });

  assert.equal(requests, 0, 'the batch repair issued a second GitHub read');
  assert.equal(result.patchWritten, true);
  const written = fs.readFileSync(patchFile, 'utf8');
  assert.equal(written, result.diff, 'the saved patch is not the diff the batch planned');
  assert.ok(written.includes('\r\n'), 'the patch lost the manifest’s CRLF body');

  execFileSync('git', ['apply', '--check', patchFile], { cwd: target, stdio: 'pipe' });
  execFileSync('git', ['apply', patchFile], { cwd: target, stdio: 'pipe' });

  const after = fs.readFileSync(path.join(target, 'package.json'), 'utf8');
  assert.equal(after.includes('\r\n'), true, 'the applied manifest is no longer CRLF');
  assert.equal(/(^|[^\r])\n/u.test(after), false, 'the applied manifest has a bare LF');
  assert.equal(JSON.parse(after).engines.dsh, '>=0.2.0');
});

test('audit --remote --patch-dir writes the CRLF repair the batch claims', async (t) => {
  // The documented batch command is `audit --remote --from <list> --patch-dir`.
  // Pin the whole path, not just `fixRemote`: the audit has to carry the CRLF
  // bytes it read into the repair, and the patch it saves has to apply in the
  // checkout those bytes came from.
  const raw = `${JSON.stringify(manifest, null, 2)}\n`.replace(/\n/gu, '\r\n');
  const root = workspace(t);
  const target = checkout(path.join(root, 'audit-checkout'), raw);
  const list = path.join(root, 'repos.txt');
  fs.writeFileSync(list, 'acme/crlf-plugin\n');
  const patchDir = path.join(root, 'repairs');
  const io = recorder();

  const code = await run(['audit', '--remote', '--from', list, '--patch-dir', patchDir], io, {
    fetchImpl: github(raw),
  });

  assert.equal(code, 1, io.lines.join('\n'));
  assert.deepEqual(fs.readdirSync(patchDir), ['acme__crlf-plugin.patch']);
  const patchFile = path.join(patchDir, 'acme__crlf-plugin.patch');
  assert.ok(io.lines.join('\n').includes(patchFile), 'the batch did not name the patch it wrote');
  assert.ok(fs.readFileSync(patchFile, 'utf8').includes('\r\n'), 'the batch patch lost the manifest’s CRLF body');

  execFileSync('git', ['apply', '--check', patchFile], { cwd: target, stdio: 'pipe' });
  execFileSync('git', ['apply', patchFile], { cwd: target, stdio: 'pipe' });

  const after = fs.readFileSync(path.join(target, 'package.json'), 'utf8');
  assert.equal(after.includes('\r\n'), true, 'the applied manifest is no longer CRLF');
  assert.equal(JSON.parse(after).engines.dsh, '>=0.2.0');
});

test('the LF fixture still exits 0 and applies unchanged', async (t) => {
  const raw = `${JSON.stringify(manifest, null, 2)}\n`;
  const { code, io, target, patchFile } = await repair(t, raw, 'lf');

  assert.equal(code, 0, io.lines.join('\n'));
  const written = fs.readFileSync(patchFile, 'utf8');
  assert.equal(written.includes('\r'), false, 'the LF patch gained a carriage return');

  execFileSync('git', ['apply', '--check', patchFile], { cwd: target, stdio: 'pipe' });
  execFileSync('git', ['apply', patchFile], { cwd: target, stdio: 'pipe' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).engines.dsh, '>=0.2.0');
});

test('a CRLF manifest without a final newline applies and stays that way', async (t) => {
  // Put engines last so the hunk reaches EOF; without the standard marker git
  // refuses the patch because the final `}` has no terminating newline.
  const raw = JSON.stringify({ name: 'crlf-plugin', version: '1.2.3', engines: { node: '>=18' } }, null, 2).replace(
    /\n/gu,
    '\r\n',
  );
  const { code, io, target, patchFile } = await repair(t, raw, 'crlf-no-final-newline');

  assert.equal(code, 0, io.lines.join('\n'));
  assert.match(fs.readFileSync(patchFile, 'utf8'), /^\\ No newline at end of file$/mu);

  execFileSync('git', ['apply', '--check', patchFile], { cwd: target, stdio: 'pipe' });
  execFileSync('git', ['apply', patchFile], { cwd: target, stdio: 'pipe' });

  const after = fs.readFileSync(path.join(target, 'package.json'), 'utf8');
  assert.equal(after.endsWith('\n'), false, 'the applied manifest gained a final newline');
  assert.equal(after.includes('\r\n'), true, 'the applied manifest is no longer CRLF');
  assert.equal(JSON.parse(after).engines.dsh, '>=0.2.0');
});
