/**
 * A root `.npmignore` is disabled when `package.json` has a `files` list, but a
 * `.npmignore` (or the `.gitignore` fallback) inside a subdirectory still
 * subtracts from it. `doctor` used to read only the manifest, so it called the
 * package clean while `npm pack` dropped the `lib/client.js` that
 * `exports["./client"]` names.
 *
 * The reported case is a committed fixture, not one written on the fly: the
 * same tree is handed to `npm pack --dry-run --json` and to the shipped
 * `doctor` on three consecutive runs, so the prediction cannot borrow state
 * from an earlier check or be tuned to a fixture only the test knows about.
 * A no-ignore copy of that same tree is the control. The remaining fixtures
 * keep the fix from becoming "any subdirectory ignore file fails": a rule for
 * an unrelated file, an explicit file in `files`, and a negation that puts the
 * client back all have to stay clean.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run as runCli } from '../lib/cli.mjs';
import { doctor } from '../lib/doctor.mjs';
import { run } from '../lib/exec.mjs';

// `npm pack` writes a cache; keep it under the temp directory so the test does
// not depend on the user's npm home being writable.
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-npmignore-'));
process.env.npm_config_cache = cache;
process.env.npm_config_logs_dir = path.join(cache, '_logs');
fs.mkdirSync(process.env.npm_config_logs_dir, { recursive: true });
process.on('exit', () => {
  try {
    fs.rmSync(cache, { recursive: true, force: true });
  } catch {
    // A leftover temp cache is not a test failure.
  }
});

const here = path.dirname(fileURLToPath(import.meta.url));
const COMMITTED_FIXTURE = path.join(here, 'fixtures', 'npmignore-client');
const DEFAULT_FILES = ['index.js', 'lib', 'cordis.patch.yml', 'README.md'];

/**
 * Build a plugin that passes every check except the files-list question under
 * test. `ignore.name` is written inside `lib/` and defaults to `.npmignore`;
 * `client` lets a fixture move the exported bundle into a nested folder.
 */
function writeFixture(root, name, { files = DEFAULT_FILES, ignore, ignoreDirectory = 'lib', client = 'lib/client.js' } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = {
    name,
    version: '1.0.0',
    description: `subdirectory npmignore fixture ${name}`,
    license: 'MIT',
    type: 'module',
    engines: { node: '>=18', dsh: '>=0.2.0' },
    main: 'index.js',
    files,
    exports: { '.': './index.js', './client': `./${client}` },
    dsh: {
      bundle: { patch: 'cordis.patch.yml' },
      client: { platform: 'web' },
    },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply() {}\n');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert:\n    - id: test-plugin\n      name: test-plugin\n      config: {}\n');
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    `# ${name}\n\n## Requirements\n\n- DeepSeek Harness \`>=0.2.0\`\n`,
  );

  fs.mkdirSync(path.join(dir, path.dirname(client)), { recursive: true });
  fs.writeFileSync(path.join(dir, client), 'export default 1;\n');
  // A second file proves the folder is still traversed and packed: a fixture
  // where the whole folder is empty would test something else.
  fs.writeFileSync(path.join(dir, path.dirname(client), 'other.js'), 'export default 2;\n');

  if (ignore !== undefined) {
    const ignoreRoot = path.join(dir, ignoreDirectory);
    fs.mkdirSync(ignoreRoot, { recursive: true });
    fs.writeFileSync(path.join(ignoreRoot, ignore.name), ignore.text);
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

function recorder() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

function filesListFailures(dir) {
  return doctor(dir).failures.filter((failure) => failure.check === 'files list');
}

async function runDoctor(dir) {
  const io = recorder();
  const code = await runCli(['doctor', dir], io);
  return {
    code,
    output: io.lines.join('\n'),
    failures: io.lines.filter((line) => line.includes('✗')),
  };
}

test('the committed lib/.npmignore fixture makes npm pack and doctor omit the exported client', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(COMMITTED_FIXTURE, 'package.json'), 'utf8'));
  assert.equal(manifest.exports['./client'], './lib/client.js');

  const shipped = packedFiles(COMMITTED_FIXTURE);
  const files = [...shipped].sort().join('\n');
  assert.equal(shipped.has('lib/client.js'), false, `npm pack unexpectedly ships the client:\n${files}`);
  // The folder is still traversed and packed, so this proves the ignore rule
  // removed one file rather than the whole `lib/` entry.
  assert.ok(shipped.has('lib/other.js'), `npm pack no longer traverses lib/:\n${files}`);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await runDoctor(COMMITTED_FIXTURE);
    assert.equal(result.code, 1, `run ${attempt} exited ${result.code}:\n${result.output}`);
    assert.equal(result.failures.length, 1, `run ${attempt} failures:\n${result.output}`);
    assert.match(
      result.failures[0],
      /✗ files list: files does not ship lib\/client\.js, which package\.json points at/u,
      `run ${attempt} reported ${result.failures[0]}`,
    );
  }
});

test('an extglob lib/.npmignore drops the same files as npm pack and doctor reports the client on three runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-extglob-'));
  try {
    const extglob = writeFixture(root, 'extglob-ignore', {
      ignore: { name: '.npmignore', text: '@(client|other).js\n' },
    });

    const shipped = packedFiles(extglob);
    assert.equal(
      shipped.has('lib/client.js'),
      false,
      `npm pack unexpectedly ships the extglob client:\n${[...shipped].sort().join('\n')}`,
    );
    // The same extglob also names other.js, so both files in lib/ go away; a
    // matcher that only handled the first alternative would pass the client
    // check by accident while disagreeing with npm about the folder.
    assert.equal(
      shipped.has('lib/other.js'),
      false,
      `npm pack unexpectedly ships the extglob other file:\n${[...shipped].sort().join('\n')}`,
    );

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await runDoctor(extglob);
      assert.equal(result.code, 1, `run ${attempt} exited ${result.code}:\n${result.output}`);
      assert.equal(result.failures.length, 1, `run ${attempt} failures:\n${result.output}`);
      assert.match(
        result.failures[0],
        /✗ files list: files does not ship lib\/client\.js, which package\.json points at/u,
        `run ${attempt} reported ${result.failures[0]}`,
      );
    }

    // The literal control is the same tree and the same three runs, so the
    // extglob branch cannot be the only thing that makes doctor fail.
    const literal = writeFixture(root, 'literal-ignore', {
      ignore: { name: '.npmignore', text: 'client.js\n' },
    });
    const literalShipped = packedFiles(literal);
    assert.equal(literalShipped.has('lib/client.js'), false);
    assert.ok(literalShipped.has('lib/other.js'), 'npm pack no longer traverses lib/ for the literal control');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await runDoctor(literal);
      assert.equal(result.code, 1, `control run ${attempt} exited ${result.code}:\n${result.output}`);
      assert.match(result.failures.join('\n'), /files does not ship lib\/client\.js/u);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every extglob operator in a subdirectory ignore matches npm pack', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-extglob-operators-'));
  try {
    for (const [name, rule, otherShipped] of [
      ['at-extglob', '@(client|other).js', false],
      ['plus-extglob', '+(client|other).js', false],
      ['optional-extglob', '?(client|other).js', false],
      ['star-extglob', '*(client|other).js', false],
      // A leading `/` keeps ignore-walk from reading the `!` as a negation, so
      // the line reaches minimatch as a negative extglob: every `.js` file
      // except `other.js` goes away.
      ['negative-extglob', '/!(other).js', true],
    ]) {
      const dir = writeFixture(root, name, { ignore: { name: '.npmignore', text: `${rule}\n` } });
      const shipped = packedFiles(dir);
      assert.equal(
        shipped.has('lib/client.js'),
        false,
        `npm pack unexpectedly ships ${name}:\n${[...shipped].sort().join('\n')}`,
      );
      assert.equal(
        shipped.has('lib/other.js'),
        otherShipped,
        `npm pack disagrees with the ${name} rule about lib/other.js:\n${[...shipped].sort().join('\n')}`,
      );
      const failures = filesListFailures(dir);
      assert.equal(failures.length, 1, `${name} doctor failures: ${JSON.stringify(doctor(dir).failures)}`);
      assert.match(failures[0].message, /files does not ship lib\/client\.js/u, name);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('npm pack and doctor agree on the extglob, literal and no-ignore fixtures for three runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-npm-pack-parity-'));
  try {
    // The reported false green: npm's ignore-walk expands
    // `@(client|other).js` and drops both files, while a matcher that escaped
    // the parentheses saw one literal filename and called the package clean.
    const extglob = writeFixture(root, 'parity-extglob', {
      ignore: { name: '.npmignore', text: '@(client|other).js\n' },
    });

    // The committed literal fixture is the control that already failed on
    // 0.20.39, so it isolates this from subdirectory-ignore handling itself.
    // The same tree without lib/.npmignore is the other control: npm ships the
    // client, so doctor must not invent a files-list failure.
    const noIgnore = path.join(root, 'parity-no-ignore');
    fs.cpSync(COMMITTED_FIXTURE, noIgnore, { recursive: true });
    fs.rmSync(path.join(noIgnore, 'lib', '.npmignore'));

    const fixtures = [
      { name: 'extglob', dir: extglob },
      { name: 'literal', dir: COMMITTED_FIXTURE },
      { name: 'no-ignore', dir: noIgnore },
    ];

    const observed = [];
    for (const fixture of fixtures) {
      // npm pack is the oracle. Deriving the expected verdict here means the
      // test checks agreement even if a future npm changes its mind about one
      // of these fixtures, instead of only repeating a hard-coded answer.
      const shipped = packedFiles(fixture.dir);
      const npmShipsClient = shipped.has('lib/client.js');
      const runs = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        runs.push(await runDoctor(fixture.dir));
      }
      observed.push({ ...fixture, shipped, npmShipsClient, runs });
    }

    const byName = Object.fromEntries(observed.map((entry) => [entry.name, entry]));
    const falseGreens = byName.extglob.runs.filter((result) => result.code === 0).length;
    const literalFailures = byName.literal.runs.filter((result) => result.code === 1).length;
    const noIgnoreOK = byName['no-ignore'].runs.filter((result) => result.code === 0).length;
    const summary = `false_greens=${falseGreens}/3 literal_failures=${literalFailures}/3 no_ignore_ok=${noIgnoreOK}/3`;
    console.log(summary);

    for (const fixture of observed) {
      const files = [...fixture.shipped].sort().join('\n');
      assert.equal(
        fixture.npmShipsClient,
        fixture.name === 'no-ignore',
        `npm pack and the ${fixture.name} fixture disagree about lib/client.js:\n${files}`,
      );
    }

    // A build without the extglob fix printed `false_greens=3/3`: the packer
    // dropped the client, but doctor exited 0 on every run.
    assert.equal(
      summary,
      'false_greens=0/3 literal_failures=3/3 no_ignore_ok=3/3',
      [
        'doctor disagreed with npm pack; on 0.20.39 the extglob fixture was called clean on all three runs (false_greens=3/3)',
        ...observed.flatMap((fixture) =>
          fixture.runs.map(
            (result, index) =>
              `${fixture.name} run ${index + 1}: exit ${result.code} (npm ${fixture.npmShipsClient ? 'ships' : 'drops'} lib/client.js)\n${result.output}`,
          ),
        ),
      ].join('\n'),
    );

    for (const fixture of observed) {
      for (const [index, result] of fixture.runs.entries()) {
        const run = `${fixture.name} run ${index + 1}`;
        assert.equal(
          result.code,
          fixture.npmShipsClient ? 0 : 1,
          `${run} exited ${result.code}, but npm ${fixture.npmShipsClient ? 'ships' : 'drops'} lib/client.js:\n${result.output}`,
        );
        if (fixture.npmShipsClient === true) {
          assert.deepEqual(result.failures, [], `${run} found failures:\n${result.output}`);
        } else {
          assert.match(
            result.failures.join('\n'),
            /✗ files list: files does not ship lib\/client\.js, which package\.json points at/u,
            `${run} failures:\n${result.output}`,
          );
        }
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the same fixture without lib/.npmignore is packed and passes doctor on three consecutive runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-npmignore-control-'));
  try {
    const control = path.join(root, 'npmignore-client-control');
    fs.cpSync(COMMITTED_FIXTURE, control, { recursive: true });
    fs.rmSync(path.join(control, 'lib', '.npmignore'));

    const shipped = packedFiles(control);
    assert.ok(
      shipped.has('lib/client.js'),
      `npm pack unexpectedly drops the client without an ignore file:\n${[...shipped].sort().join('\n')}`,
    );

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await runDoctor(control);
      assert.equal(result.code, 0, `run ${attempt} exited ${result.code}:\n${result.output}`);
      assert.deepEqual(result.failures, [], `run ${attempt} failures:\n${result.output}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a lib/.npmignore naming an unrelated file still exits 0 with no files-list failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-npmignore-control-'));
  try {
    const dir = writeFixture(root, 'unrelated-ignore', {
      ignore: { name: '.npmignore', text: 'other.js\n' },
    });

    const shipped = packedFiles(dir);
    assert.ok(shipped.has('lib/client.js'), `npm pack unexpectedly drops the client:\n${[...shipped].sort().join('\n')}`);

    assert.deepEqual(filesListFailures(dir), []);

    const io = recorder();
    const code = await runCli(['doctor', dir], io);
    assert.equal(code, 0, io.lines.join('\n'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a lib/.gitignore is the fallback when lib has no .npmignore', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-gitignore-'));
  try {
    const dir = writeFixture(root, 'nested-gitignore', {
      ignore: { name: '.gitignore', text: 'client.js\n' },
    });

    const shipped = packedFiles(dir);
    assert.equal(shipped.has('lib/client.js'), false, `npm pack unexpectedly ships the client:\n${[...shipped].sort().join('\n')}`);

    const failures = filesListFailures(dir);
    assert.equal(failures.length, 1, `doctor failures: ${JSON.stringify(doctor(dir).failures)}`);
    assert.match(failures[0].message, /files does not ship lib\/client\.js/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit files entry keeps the client over a lib/.npmignore, so doctor stays quiet', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-explicit-'));
  try {
    const dir = writeFixture(root, 'explicit-file-entry', {
      files: ['index.js', 'lib/client.js', 'cordis.patch.yml', 'README.md'],
      ignore: { name: '.npmignore', text: 'client.js\n' },
    });

    const shipped = packedFiles(dir);
    assert.ok(
      shipped.has('lib/client.js'),
      `npm pack now drops an explicitly listed file:\n${[...shipped].sort().join('\n')}`,
    );
    assert.deepEqual(filesListFailures(dir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a negation in lib/.npmignore puts the client back, so doctor stays quiet', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-negation-'));
  try {
    const dir = writeFixture(root, 'nested-negation', {
      ignore: { name: '.npmignore', text: '*.js\n!client.js\n' },
    });

    const shipped = packedFiles(dir);
    assert.ok(
      shipped.has('lib/client.js'),
      `npm pack no longer honors a negation in a subdirectory ignore file:\n${[...shipped].sort().join('\n')}`,
    );
    assert.deepEqual(filesListFailures(dir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a nested lib/nested/.npmignore is honored too', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-nested-'));
  try {
    const dir = writeFixture(root, 'deep-npmignore', {
      client: 'lib/nested/client.js',
      ignore: { name: '.npmignore', text: 'client.js\n' },
      ignoreDirectory: 'lib/nested',
    });

    const shipped = packedFiles(dir);
    assert.equal(shipped.has('lib/nested/client.js'), false, `npm pack unexpectedly ships the client:\n${[...shipped].sort().join('\n')}`);

    const failures = filesListFailures(dir);
    assert.equal(failures.length, 1, `doctor failures: ${JSON.stringify(doctor(dir).failures)}`);
    assert.match(failures[0].message, /files does not ship lib\/nested\/client\.js/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an anchored lib/.npmignore rule applies to that folder, not to nested basenames', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-anchored-'));
  try {
    // `/client.js` is a direct child of lib, so it drops lib/client.js.
    const direct = writeFixture(root, 'anchored-direct', {
      ignore: { name: '.npmignore', text: '/client.js\n' },
    });
    assert.equal(packedFiles(direct).has('lib/client.js'), false);
    assert.match(filesListFailures(direct)[0]?.message ?? '', /files does not ship lib\/client\.js/u);

    // The same rule must not reach lib/nested/client.js, which npm still packs.
    const nested = writeFixture(root, 'anchored-nested', {
      client: 'lib/nested/client.js',
      ignore: { name: '.npmignore', text: '/client.js\n' },
    });
    assert.ok(
      packedFiles(nested).has('lib/nested/client.js'),
      'npm pack unexpectedly applies an anchored rule at a deeper level',
    );
    assert.deepEqual(filesListFailures(nested), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
