import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { expandHome } from '../lib/remote.mjs';

const HOME = '/home/someone';

test('a leading ~ expands to the home directory', () => {
  assert.equal(expandHome('~/repair.patch', HOME), path.join(HOME, 'repair.patch'));
  assert.equal(expandHome('~/a/b/c.patch', HOME), path.join(HOME, 'a/b/c.patch'));
});

test('a windows-style leading ~ backslash expands too, because cmd leaves it alone', () => {
  assert.equal(expandHome('~\\repair.patch', HOME), path.join(HOME, 'repair.patch'));
  assert.equal(expandHome('~\\patches\\x.patch', HOME), path.join(HOME, 'patches/x.patch'));
});

test('a bare ~ is the home directory itself', () => {
  assert.equal(expandHome('~', HOME), path.join(HOME));
});

test('paths without a leading tilde are left exactly as written', () => {
  assert.equal(expandHome('/abs/x.patch', HOME), '/abs/x.patch');
  assert.equal(expandHome('rel/x.patch', HOME), 'rel/x.patch');
  assert.equal(expandHome('./~/x.patch', HOME), './~/x.patch');
  assert.equal(expandHome('~someone/x.patch', HOME), '~someone/x.patch');
  assert.equal(expandHome('', HOME), '');
});

test('surrounding whitespace from a pasted path is dropped', () => {
  assert.equal(expandHome('  ~/x.patch  ', HOME), path.join(HOME, 'x.patch'));
});

test('a patch written to ~/ lands in the home directory, not in a literal ~ folder', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const { fixRemote } = await import('../lib/remote.mjs');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'));
  // Windows does not use HOME for the home directory; os.homedir() reads
  // USERPROFILE there, so a test that only sets HOME would write to the real
  // profile on the windows-latest runners.
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
  try {
    const text = JSON.stringify({ name: 'p', version: '1.0.0' });
    // The GitHub contents API answers with the file base64-encoded.
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64' }),
      text: async () => text,
    });
    const result = await fixRemote('owner/repo', {
      fetchImpl: fakeFetch,
      token: 'x',
      patch: '~/repair.patch',
      writePatch: true,
    });
    assert.equal(result.patchPath, path.join(scratch, 'repair.patch'));
    assert.equal(fs.existsSync(path.join(scratch, 'repair.patch')), true);
    assert.equal(fs.existsSync(path.join(process.cwd(), '~')), false);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
