/**
 * `doctor`'s files-list check predicts what `npm pack` will ship. A glob does
 * not mean "anything under this prefix": `*.js` is root-level only, and
 * `lib/*.js` covers direct children of `lib` but not a nested client. These
 * fixtures pair `doctor` with npm's own file list so the two cannot drift.
 *
 * The folder-entry case is the control: `files: ["lib"]` really does ship the
 * nested client, so `doctor` has to accept it instead of rejecting every
 * package that names a directory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { doctor } from '../lib/doctor.mjs';
import { run } from '../lib/exec.mjs';

const FIXTURES = [
  {
    name: 'root-glob',
    files: ['*.js', 'cordis.patch.yml', 'README.md'],
    client: 'lib/client.js',
    onDisk: ['lib/client.js'],
    shipped: ['index.js'],
    omitted: ['lib/client.js'],
    failure: /files does not ship lib\/client\.js/u,
  },
  {
    // `lib/*.js` ships lib/client.js, but not the client one folder deeper.
    // The manifest points at the nested one, so doctor has to name it even
    // though the glob matches a different client-looking file.
    name: 'lib-glob',
    files: ['index.js', 'lib/*.js', 'cordis.patch.yml', 'README.md'],
    client: 'lib/nested/client.js',
    onDisk: ['lib/client.js', 'lib/nested/client.js'],
    shipped: ['index.js', 'lib/client.js'],
    omitted: ['lib/nested/client.js'],
    failure: /files does not ship lib\/nested\/client\.js/u,
  },
  {
    name: 'folder-entry',
    files: ['index.js', 'lib', 'cordis.patch.yml', 'README.md'],
    client: 'lib/nested/client.js',
    onDisk: ['lib/client.js', 'lib/nested/client.js'],
    shipped: ['index.js', 'lib/client.js', 'lib/nested/client.js'],
    omitted: [],
    failure: null,
  },
];

function writeFixture(root, fixture) {
  const dir = path.join(root, fixture.name);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = {
    name: fixture.name,
    version: '1.0.0',
    description: `files fixture ${fixture.name}`,
    license: 'MIT',
    type: 'module',
    engines: { node: '>=18', dsh: '>=0.2.0' },
    main: 'index.js',
    files: fixture.files,
    exports: { '.': './index.js', './client': `./${fixture.client}` },
    dsh: {
      bundle: { patch: 'cordis.patch.yml' },
      client: { platform: 'web' },
    },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply() {}\n');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert: []\n');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${fixture.name}\n\n## Requirements\n\n- DeepSeek Harness \`>=0.2.0\`\n`);
  for (const file of fixture.onDisk) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), 'export default 1;\n');
  }
  return dir;
}

function packedFiles(dir) {
  const output = run('npm', ['pack', '--dry-run', '--json'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [document] = JSON.parse(output);
  return new Set((document.files ?? []).map((entry) => entry.path));
}

test('doctor and npm pack agree about glob and folder entries in files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-files-glob-'));
  try {
    for (const fixture of FIXTURES) {
      const dir = writeFixture(root, fixture);
      const shipped = packedFiles(dir);

      for (const file of fixture.shipped) {
        assert.ok(shipped.has(file), `npm pack does not ship ${file} for ${fixture.name}:\n${[...shipped].sort().join('\n')}`);
      }
      for (const file of fixture.omitted) {
        assert.equal(shipped.has(file), false, `npm pack unexpectedly ships ${file} for ${fixture.name}`);
      }

      const failures = doctor(dir).failures;
      if (fixture.failure === null) {
        assert.deepEqual(failures, [], `${fixture.name} should pass doctor: ${JSON.stringify(failures)}`);
        continue;
      }

      assert.equal(failures.length, 1, `${fixture.name} failures: ${JSON.stringify(failures)}`);
      assert.equal(failures[0].check, 'files list', `${fixture.name} failed ${failures[0].check} instead of files list`);
      assert.match(failures[0].message, fixture.failure);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
