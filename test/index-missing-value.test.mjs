/**
 * `index --index` with no path must stop at usage validation, not read the
 * default market index.
 *
 * The failure this pins is a false clean: the parser stored `undefined`, the
 * command fell back to `./market/index.json`, and a CI step that named one
 * index could go green on another. A bare `--index` has to exit `2` before the
 * file is read, while the same command with a real path still audits it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');

function runIndex(args, cwd) {
  return spawnSync(process.execPath, [BIN, 'index', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

test('a bare --index exits 2 in every trial and a named index still exits 0', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-index-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // A clean index that the old fallback would audit and pass, so a green exit
  // here means the command read a file the caller never named.
  fs.mkdirSync(path.join(dir, 'market'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'market', 'index.json'),
    `${JSON.stringify(
      {
        plugins: [
          {
            name: 'default-plugin',
            versions: [{ version: '1.0.0', engines: { dsh: '>=0.2.0 <1.0.0' } }],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  for (let trial = 1; trial <= 3; trial += 1) {
    const result = runIndex(['--index'], dir);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 2, `trial ${trial}\n${output}`);
    assert.match(result.stderr, /--index/u, `trial ${trial} did not name the flag\n${output}`);
    assert.doesNotMatch(result.stdout, /default-plugin/u, `trial ${trial} read the default index\n${output}`);
  }

  // The same flag with a value, and the positional form that the help shows,
  // still audit the named file and exit 0.
  for (const args of [['--index', 'market/index.json'], ['market/index.json']]) {
    const result = runIndex(args, dir);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, `${args.join(' ')}\n${output}`);
    assert.match(result.stdout, /default-plugin/u, output);
  }
});

test('a bare --index does not swallow the next flag', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-index-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'market'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'market', 'index.json'), '{"plugins":[]}\n');

  const result = runIndex(['--index', '--dry-run'], dir);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 2, output);
  assert.match(result.stderr, /--index needs a path/u, output);
});
