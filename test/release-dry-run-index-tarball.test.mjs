/**
 * The index preflight in `release --dry-run` has to survive npm pack.
 *
 * The checkout test spawns this repository's `bin/dsh-plugin.mjs`; that is not
 * the file a user installs. A tarball that omitted `lib/release.mjs`,
 * `lib/index-file.mjs` or the CLI change could still pass the suite and ship a
 * dry run that exits `0` and prints `patch market/index.json` for an index the
 * installed `index` rejects. On the published 0.21.2 that is exactly what
 * happened: all three malformed shapes produced a false plan (false_plans=3/3).
 *
 * This test packs this repository, installs the tarball into a temp prefix, and
 * runs the *installed* CLI against three malformed and three valid index
 * shapes. Each malformed index has to be rejected by the installed `index`
 * first; the installed `release --dry-run` then has to exit `1` with the same
 * finding and no tag or patch step, so false_plans=0/3. Each valid index has to
 * keep the full plan, including the tag step and the patch line, so
 * clean_plans=3/3.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/exec.mjs';
import { parsePackOutput } from '../lib/verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GOOD = path.join(HERE, 'fixtures', 'good');

function packToolkit(scratch) {
  const output = run('npm', ['pack', '--pack-destination', scratch, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [document] = parsePackOutput(output);
  assert.ok(document, `npm pack --json printed no tarball document:\n${output}`);
  return document;
}

function installToolkit(scratch, document) {
  const prefix = path.join(scratch, 'install');
  run(
    'npm',
    [
      'install',
      path.join(scratch, document.filename),
      '--prefix',
      prefix,
      '--no-save',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--omit=peer',
    ],
    {
      cwd: scratch,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const installedBin = path.join(prefix, 'node_modules', 'dsh-plugin-toolkit', 'bin', 'dsh-plugin.mjs');
  assert.ok(fs.existsSync(installedBin), `the tarball installed no CLI at ${installedBin}`);
  return installedBin;
}

function invoke(installedBin, scratch, args) {
  return spawnSync(process.execPath, [installedBin, ...args], {
    // Run outside the checkout and the install prefix: a command that only
    // works because it can borrow this repository's files is not the command a
    // user installs.
    cwd: scratch,
    encoding: 'utf8',
  });
}

function pluginRepo(scratch, label, indexDocument) {
  const dir = path.join(scratch, label);
  fs.cpSync(GOOD, dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'market'), { recursive: true });
  const indexFile = path.join(dir, 'market', 'index.json');
  fs.writeFileSync(indexFile, `${JSON.stringify(indexDocument, null, 2)}\n`);
  return { dir, indexFile };
}

const ENTRY = {
  version: '1.2.2',
  publishTimestamp: 1730000000000,
  source: { type: 'npm' },
  engines: { dsh: '>=0.2.0' },
};

const malformed = [
  {
    name: 'missing-plugins',
    document: { formatVersion: 1 },
    finding: /no "plugins" array/u,
  },
  {
    name: 'versions-not-array',
    document: {
      formatVersion: 1,
      plugins: [{ name: 'demo-plugin', versions: '1.2.2' }],
    },
    finding: /"versions" is not an array/u,
  },
  {
    name: 'missing-engines',
    document: {
      formatVersion: 1,
      plugins: [{
        name: 'demo-plugin',
        versions: [{ version: '1.2.2', publishTimestamp: 1730000000000, source: { type: 'npm' } }],
      }],
    },
    finding: /no engines\.dsh/u,
  },
];

const valid = [
  {
    name: 'empty-versions',
    document: {
      formatVersion: 1,
      plugins: [{ name: 'demo-plugin', versions: [] }],
    },
  },
  {
    name: 'one-version',
    document: {
      formatVersion: 1,
      plugins: [{ name: 'demo-plugin', versions: [ENTRY] }],
    },
  },
  {
    name: 'two-plugins',
    document: {
      formatVersion: 1,
      plugins: [
        { name: 'demo-plugin', versions: [ENTRY] },
        { name: 'other-plugin', versions: [{ ...ENTRY, version: '2.0.0' }] },
      ],
    },
  },
];

test('the installed tarball CLI plans no tag for a rejected index and keeps valid indexes clean', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-dry-index-tarball-'));
  try {
    const toolkit = packToolkit(scratch);
    // A tarball without the CLI, release plan or index inspector cannot be the
    // boundary this test claims to exercise, so fail before the six runs.
    const toolkitFiles = new Set(toolkit.files.map((entry) => entry.path));
    for (const required of ['bin/dsh-plugin.mjs', 'lib/cli.mjs', 'lib/release.mjs', 'lib/index-file.mjs']) {
      assert.ok(toolkitFiles.has(required), `the toolkit tarball does not ship ${required}`);
    }

    const installedBin = installToolkit(scratch, toolkit);
    assert.notEqual(
      path.resolve(installedBin),
      path.join(ROOT, 'bin', 'dsh-plugin.mjs'),
      'the installed CLI resolved back to the checkout copy',
    );

    let false_plans = 0;
    const rejectedRuns = [];
    for (const fixture of malformed) {
      const { dir, indexFile } = pluginRepo(scratch, `bad-${fixture.name}`, fixture.document);

      // The installed `index` is the verdict the dry run has to follow. If this
      // command ever accepts a shape, the fixture is no longer malformed.
      const indexed = invoke(installedBin, scratch, ['index', indexFile]);
      assert.equal(indexed.status, 1, `${fixture.name}, installed CLI index:\n${indexed.stdout}${indexed.stderr}`);
      assert.match(indexed.stderr, fixture.finding, fixture.name);

      const released = invoke(installedBin, scratch, ['release', dir, '--dry-run']);
      const output = `${released.stdout}\n${released.stderr}`;
      // A false plan is the bug: exit 0 while telling the author to tag and
      // patch an index `index` just rejected. Count every fixture before
      // failing so the published 0.21.2 answer is the recorded 3/3.
      if (released.status === 0 && /\bpatch\b/u.test(released.stdout) === true) {
        false_plans += 1;
      }
      rejectedRuns.push({ fixture, indexed, released, output });
    }
    // Fail on the count first: on the published 0.21.2 this line reports
    // false_plans=3/3 instead of stopping at the first fixture.
    assert.equal(false_plans, 0, `false_plans=${false_plans}/3: a rejected index must never plan a tag or patch`);
    for (const { fixture, indexed, released, output } of rejectedRuns) {
      assert.equal(released.status, 1, `${fixture.name}, installed CLI release --dry-run:\n${output}`);
      assert.equal(released.stderr, indexed.stderr, `${fixture.name}: release and index must print the same finding`);
      assert.doesNotMatch(released.stdout, /\bgit tag\b/u, `${fixture.name}:\n${output}`);
      assert.doesNotMatch(released.stdout, /\bpatch\b/u, `${fixture.name}:\n${output}`);
    }

    let clean_plans = 0;
    const acceptedRuns = [];
    for (const fixture of valid) {
      const { dir, indexFile } = pluginRepo(scratch, `good-${fixture.name}`, fixture.document);

      const indexed = invoke(installedBin, scratch, ['index', indexFile]);
      assert.equal(indexed.status, 0, `${fixture.name}, installed CLI index:\n${indexed.stdout}${indexed.stderr}`);

      const released = invoke(installedBin, scratch, ['release', dir, '--dry-run']);
      const output = `${released.stdout}\n${released.stderr}`;
      if (
        released.status === 0 &&
        /git tag plugin-v1\.2\.3/u.test(released.stdout) === true &&
        released.stdout.includes(`patch ${indexFile}`) === true
      ) {
        clean_plans += 1;
      }
      acceptedRuns.push({ fixture, released, output, indexFile });
    }
    assert.equal(clean_plans, 3, `clean_plans=${clean_plans}/3: every valid index must keep the full plan`);
    for (const { fixture, released, output, indexFile } of acceptedRuns) {
      assert.equal(released.status, 0, `${fixture.name}, installed CLI release --dry-run:\n${output}`);
      assert.match(released.stdout, /Create the tag plugin-v1\.2\.3/u, `${fixture.name}:\n${output}`);
      assert.ok(
        released.stdout.includes(`patch ${indexFile}`),
        `${fixture.name}: the plan no longer patches ${indexFile}:\n${output}`,
      );
      assert.doesNotMatch(released.stderr, /✗/u, `${fixture.name}:\n${output}`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
