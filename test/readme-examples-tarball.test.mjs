/**
 * The README tells a reader to run four `node examples/*.mjs` commands. Those
 * files existed in the checkout but `files` only shipped the compatibility
 * sample, so a fresh install contained none of them.
 *
 * The tarball is the unit here: the commands are read from the READMEs npm
 * actually ships, then the packed tarball is installed into a temp prefix. The
 * installed copies must be byte-identical to the repository files, and each
 * one must run with the fixtures that shipped beside it. A future `files` edit
 * that drops an example or its fixture fails here and names the path before
 * publication.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/exec.mjs';
import { documentedRunCommands } from '../lib/readme-commands.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = [
  'examples/aria.mjs',
  'examples/baseline.mjs',
  'examples/mount-a-bundle.mjs',
  'examples/route-stubs.mjs',
];
const EXPECTED_OUTPUT = {
  'examples/aria.mjs': 'live region: polite -> "0"\nlabelled control: increment\n',
  'examples/baseline.mjs': 'baseline: same\n',
  'examples/mount-a-bundle.mjs': 'Demo panel Count 0 0\nDemo panel Count 1 1\n',
  'examples/route-stubs.mjs': 'Score 71\nasked for: 1 route(s), undeclared route answers 404\n',
};

/** Give the temp install the optional peers the README names, without a registry read. */
function linkPeers(prefix) {
  for (const name of ['jsdom', 'react', 'react-dom']) {
    const source = path.join(ROOT, 'node_modules', name);
    assert.ok(fs.existsSync(source), `npm ci did not install ${name}, so the examples cannot be run`);
    fs.symlinkSync(source, path.join(prefix, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir');
  }
}

/**
 * Every distinct `examples/<name>.mjs` the READMEs tell a reader to pass to
 * node. The shared reader also covers commands under `scripts/`; this test is
 * about what an installed reader can run from `examples/`.
 */
function documentedExamples() {
  return new Map(
    [...documentedRunCommands(ROOT)].filter(([command]) => command.startsWith('examples/')),
  );
}

test('a fresh install ships and runs the four examples the shipped README cites', () => {
  const documented = documentedExamples();
  const cited = [...documented.keys()].sort();
  assert.deepEqual(
    cited,
    REQUIRED,
    `the READMEs cite ${cited.join(', ') || 'no examples'}; the acceptance case is exactly the four examples`,
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const example of REQUIRED) {
    assert.ok(
      manifest.files.includes(example),
      `package.json files omits ${example} (named in ${documented.get(example)}), so npm pack will leave it out`,
    );
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-examples-tarball-'));
  try {
    const [document] = JSON.parse(run('npm', ['pack', '--pack-destination', scratch, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const shipped = new Set(document.files.map((entry) => entry.path));
    const missing = REQUIRED.filter((example) => shipped.has(example) === false);
    assert.deepEqual(
      missing,
      [],
      `the tarball omits README-cited example(s):\n${missing
        .map((example) => `  ${example} (named in ${documented.get(example)})`)
        .join('\n')}\nAdd each path to package.json's "files" list, or stop documenting it as an installed command.`,
    );

    const prefix = path.join(scratch, 'install');
    // The examples need optional peers (react, jsdom) to run; `--omit=peer`
    // keeps the install offline, and the peers are linked below.
    run('npm', ['install', path.join(scratch, document.filename), '--prefix', prefix, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=peer'], {
      cwd: scratch,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const installedRoot = path.join(prefix, 'node_modules', 'dsh-plugin-toolkit');
    for (const example of REQUIRED) {
      const installed = path.join(installedRoot, example);
      assert.ok(fs.existsSync(installed), `the installed package has no ${example}`);
      const repository = fs.readFileSync(path.join(ROOT, example));
      const copy = fs.readFileSync(installed);
      assert.ok(
        repository.equals(copy),
        `the installed ${example} differs from the repository copy (${copy.length} vs ${repository.length} bytes)`,
      );
    }
    assert.deepEqual(
      fs.readdirSync(path.join(installedRoot, 'examples')).filter((name) => name.endsWith('.mjs')).sort(),
      REQUIRED.map((example) => path.basename(example)).sort(),
      'the installed examples directory has a different set of .mjs files than the README cites',
    );

    // The fixtures the examples mount are part of the shipped package too. Run
    // each command from outside the install so a relative path cannot borrow
    // the checkout's copy and pass by accident.
    linkPeers(prefix);
    for (const example of REQUIRED) {
      const output = run(process.execPath, [path.join(installedRoot, example)], {
        cwd: scratch,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_PATH: '', HOME: prefix, USERPROFILE: prefix, UPDATE_SNAPSHOTS: '' },
      });
      assert.equal(output, EXPECTED_OUTPUT[example], `the installed ${example} printed something else`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
