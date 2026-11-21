/**
 * `doctor` reads the working copy. `npm pack` runs `prepack` first and reads
 * what the hook wrote. A plugin whose `client.js` is generated in `prepack` is
 * therefore complete in the tarball and incomplete in the folder `doctor` sees
 * before the pack.
 *
 * `verify --no-mount` used to run `doctor` first, so it rejected that plugin at
 * the source-only `client entry` checks and never reached the pack that would
 * have produced the file. These tests spawn the shipped CLI where the verdict
 * is what a user or CI job sees: the generated-client fixture must exit 0 with
 * `ok packed`, npm's own file list must contain `client.js`, and a control
 * whose prepack does not generate the file must still exit 1 at `pack`, naming
 * `client.js`. The post-pack state is also asserted through `verify` directly,
 * where the stage and the failing check are easier to name.
 *
 * The file list has to come from the tarball `verify` installs, not from a
 * source-tree prediction. `verify` therefore packs exactly once: a separate dry
 * run would execute `prepack` a second time, and the second execution can see a
 * tree the first one changed. The flip fixture (panel committed, hook removes
 * it) and the non-idempotent fixture (hook writes it once, removes it later)
 * pin both directions: a tarball without the panel fails, and a tarball with it
 * passes even though a later run would produce a different one.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { doctor } from '../lib/doctor.mjs';
import { run } from '../lib/exec.mjs';
import { init } from '../lib/init.mjs';
import { parsePackOutput, verify } from '../lib/verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const fixture = (name) => path.join(here, 'fixtures', name);

/** Copy a committed fixture: packing it writes client.js into the copy. */
function copyFixture(name) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-prepack-'));
  const dir = path.join(parent, 'plugin');
  fs.cpSync(fixture(name), dir, { recursive: true });
  return dir;
}

function verifyNoMount(dir) {
  return spawnSync(process.execPath, [BIN, 'verify', dir, '--no-mount'], { encoding: 'utf8' });
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

/** How many times the non-idempotent fixture's prepack hook has run. */
function prepackInvocations(dir) {
  const file = path.join(dir, '.prepack-invocations');
  return fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
}

test('verify --no-mount packs a plugin whose prepack generates client.js', () => {
  const dir = copyFixture('verify-prepack-generated');
  try {
    assert.equal(fs.existsSync(path.join(dir, 'client.js')), false, 'the fixture must not commit the generated panel');

    const result = verifyNoMount(dir);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(result.stdout, /^ok {2}packed \d+ file\(s\)/m, output);
    assert.doesNotMatch(output, /stopped at doctor/u, output);
    // The pack ran the hook in the source tree, which is what let doctor see
    // the panel on its second pass.
    assert.ok(fs.existsSync(path.join(dir, 'client.js')), 'prepack did not run in the plugin folder');

    const files = packedFiles(dir);
    assert.ok(
      files.has('client.js'),
      `npm pack --dry-run --json does not list client.js:\n${[...files].sort().join('\n')}`,
    );
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('a prepack that does not generate client.js still fails at pack and names it', () => {
  const dir = copyFixture('verify-prepack-missing');
  try {
    // Keep the control honest: it must start without the panel, and doctor
    // must see that as the only missing piece the hook could have generated.
    assert.equal(fs.existsSync(path.join(dir, 'client.js')), false, 'the control fixture commits a panel');
    assert.ok(
      doctor(dir).failures.some((failure) => failure.check === 'client entry'),
      'the missing-panel fixture does not actually miss its client entry',
    );

    const result = verifyNoMount(dir);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /dsh-plugin verify: stopped at pack/u, output);
    const line = output.split('\n').find((entry) => entry.includes('pack:'));
    assert.ok(line, output);
    assert.match(line, /client\.js/u, line);
    assert.doesNotMatch(output, /stopped at doctor/u, output);
    assert.equal(fs.existsSync(path.join(dir, 'client.js')), false, 'the control prepack wrote a panel');
    assert.ok(packedFiles(dir).has('client.js') === false, 'the control tarball unexpectedly contains client.js');
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('verify packs a non-idempotent plugin once and judges the tarball it built', async () => {
  const dir = copyFixture('verify-prepack-non-idempotent');
  try {
    assert.equal(fs.existsSync(path.join(dir, 'client.js')), false, 'the fixture must start without a panel');

    // One invocation writes the panel, so that tarball does contain it and the
    // verdict is success. The old dry-run-then-pack sequence would have run the
    // hook twice and rejected a first run that shipped a working panel.
    const first = await verify({ dir, mount: false });
    assert.equal(first.ok, true, JSON.stringify(first.failures));
    assert.equal(prepackInvocations(dir), 1, 'verify ran prepack more than once');
    assert.ok(first.files.includes('client.js'), 'the first tarball should carry the generated panel');
    assert.ok(fs.existsSync(path.join(dir, 'client.js')), 'the first prepack did not write the panel');

    // The second invocation removes it. Verify must judge this run's archive,
    // not the panel it saw before packing, so it fails at pack and says why.
    const second = await verify({ dir, mount: false });
    assert.equal(second.ok, false, JSON.stringify(second.failures));
    assert.equal(second.stage, 'pack');
    assert.equal(second.failures[0].check, 'pack');
    assert.match(second.failures[0].message, /the tarball does not contain client\.js/u);
    assert.equal(second.files.includes('client.js'), false, 'the reported file list came from before the pack');
    assert.equal(prepackInvocations(dir), 2, 'a second verify should be exactly one more prepack');
    assert.equal(fs.existsSync(path.join(dir, 'client.js')), false, 'the second prepack did not remove the panel');
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('the shipped CLI runs a non-idempotent prepack once per verify, then rejects its tarball', () => {
  // `verify` and `verify --no-mount` both have to judge the archive their own
  // single pack produced. On a fresh copy the first invocation writes the
  // panel, so that run exits 0; a second run on the same copy removes it, so
  // that run must exit 1 at `pack` and name `client.js`. The old dry-run-then-
  // pack sequence ran the hook twice on the first run, which changed the folder
  // the tarball was checked against and could report success for a panel-less
  // archive.
  for (const args of [['verify'], ['verify', '--no-mount']]) {
    const label = args.join(' ');
    const dir = copyFixture('verify-prepack-non-idempotent');
    try {
      const first = spawnSync(process.execPath, [BIN, ...args, dir], { encoding: 'utf8' });
      const firstOutput = `${first.stdout}\n${first.stderr}`;
      assert.equal(first.status, 0, `${label} first run:\n${firstOutput}`);
      assert.match(first.stdout, /^ok {2}/m, `${label} first run:\n${firstOutput}`);
      assert.equal(prepackInvocations(dir), 1, `${label} first run ran prepack more than once:\n${firstOutput}`);
      assert.ok(fs.existsSync(path.join(dir, 'client.js')), `${label} first run removed the panel it packed`);

      const second = spawnSync(process.execPath, [BIN, ...args, dir], { encoding: 'utf8' });
      const secondOutput = `${second.stdout}\n${second.stderr}`;
      assert.equal(second.status, 1, `${label} second run:\n${secondOutput}`);
      assert.match(secondOutput, /dsh-plugin verify: stopped at pack/u, `${label} second run:\n${secondOutput}`);
      const line = secondOutput.split('\n').find((entry) => entry.includes('pack:'));
      assert.ok(line, `${label} second run:\n${secondOutput}`);
      assert.match(line, /client\.js/u, line);
      assert.doesNotMatch(secondOutput, /^ok {2}/m, `${label} second run:\n${secondOutput}`);
      assert.equal(prepackInvocations(dir), 2, `${label} second run should be exactly one more prepack`);
      assert.equal(fs.existsSync(path.join(dir, 'client.js')), false, `${label} second run did not remove the panel`);
    } finally {
      fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }
});

test('the shipped CLI rejects the flip fixture 3/3 times with and without --no-mount', () => {
  // The fixture's folder passes doctor (client.js is committed and declared)
  // and its prepack removes the panel while building the tarball. Each command
  // gets three fresh copies, so every iteration starts from the state a user
  // would see; all six runs must exit 1 and name client.js or the pack stage.
  for (const args of [['verify'], ['verify', '--no-mount']]) {
    for (let run = 1; run <= 3; run += 1) {
      const dir = copyFixture('verify-prepack-flip');
      try {
        // Keep the missing-panel control honest: every iteration must start
        // from a complete working copy that doctor accepts. Otherwise the
        // fixture could lose its committed panel and this test would still
        // pass for the wrong reason.
        assert.deepEqual(
          doctor(dir).failures,
          [],
          `${args.join(' ')} run ${run} did not start from a complete working copy`,
        );
        assert.ok(
          fs.existsSync(path.join(dir, 'client.js')),
          `${args.join(' ')} run ${run} fixture has no committed panel to remove`,
        );

        const result = spawnSync(process.execPath, [BIN, ...args, dir], { encoding: 'utf8' });
        const output = `${result.stdout}\n${result.stderr}`;
        assert.equal(result.status, 1, `${args.join(' ')} run ${run}:\n${output}`);
        assert.match(output, /dsh-plugin verify: stopped at pack/u, `${args.join(' ')} run ${run}:\n${output}`);
        const line = output.split('\n').find((entry) => entry.includes('pack:'));
        assert.ok(line, `${args.join(' ')} run ${run}:\n${output}`);
        assert.match(line, /client\.js/u, line);
        assert.doesNotMatch(output, /^ok {2}/m, `${args.join(' ')} run ${run}:\n${output}`);
        assert.equal(fs.existsSync(path.join(dir, 'client.js')), false, 'the prepack hook did not flip the panel off');
      } finally {
        fs.rmSync(path.dirname(dir), { recursive: true, force: true });
      }
    }
  }
});

test('a prepack-generated client.js that dsh.client does not declare is rejected after the pack', async () => {
  const dir = copyFixture('verify-prepack-generated');
  try {
    editManifest(dir, (manifest) => {
      delete manifest.dsh.client;
    });
    // Before the hook runs the folder looks clean: no client.js, and nothing
    // declares one. The tarball, however, will carry a panel the host never
    // serves, so the post-pack source checks have to run even after a clean
    // first pass.
    assert.deepEqual(doctor(dir).failures, []);

    const result = await verify({ dir, mount: false });
    assert.equal(result.ok, false, JSON.stringify(result.failures));
    assert.equal(result.stage, 'doctor');
    assert.equal(result.failures[0].check, 'client declaration');
    assert.match(result.failures[0].message, /is not declared/u);
    assert.ok(result.files.includes('client.js'), 'the tarball did not carry the generated panel');
    assert.ok(fs.existsSync(path.join(dir, 'client.js')), 'prepack did not run in the plugin folder');
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('pack output is read even when a lifecycle hook writes to stdout first', () => {
  const document = {
    filename: 'panel-1.0.0.tgz',
    size: 1234,
    files: [{ path: 'client.js' }, { path: 'package.json' }],
  };
  // The shape of the failure: prepack's line precedes npm's answer, so a flat
  // JSON.parse saw `building panel` where it expected `[`.
  assert.deepEqual(parsePackOutput(`building panel\n${JSON.stringify([document])}`), [document]);
  // A hook may print something that looks like the start of an answer, and npm
  // may write a notice after its document. Only the pack-shaped document is
  // accepted, and the scanner finds its own closing bracket.
  assert.deepEqual(parsePackOutput(`[hook] starting\n${JSON.stringify([document])}\nnpm notice`), [document]);
  assert.deepEqual(parsePackOutput(`[1, 2, 3]\n${JSON.stringify([document])}`), [document]);
  // A hook may write without a trailing newline, so npm's document can begin
  // in the middle of a line. Starting the scan only at line starts missed it.
  assert.deepEqual(parsePackOutput(`building panel${JSON.stringify([document])}`), [document]);
  assert.deepEqual(parsePackOutput(`building panel${JSON.stringify([document])}\nnpm notice`), [document]);
  // A hook is free to print a pack-shaped document of its own. The answer npm
  // writes after running the hook is the one that describes the tarball.
  const hookDocument = { filename: 'hook-1.0.0.tgz', size: 1, files: [{ path: 'client.js' }] };
  assert.deepEqual(
    parsePackOutput(`${JSON.stringify([hookDocument])}\n${JSON.stringify([document])}`),
    [document],
  );
  // An answer that was never contaminated still parses.
  assert.deepEqual(parsePackOutput(JSON.stringify([document])), [document]);
});

test('the shipped CLI passes an init scaffold whose prepack prints to stdout', () => {
  // Acceptance: the same freshly generated scaffold must exit 0 whether its
  // build is silent, says one line, or writes that line without a newline. The
  // line-separated case used to fail at `pack` with `Unexpected token 'b'`
  // because npm's lifecycle output came first; the unterminated case still did
  // until the scanner stopped requiring a newline before npm's answer.
  const builds = {
    silent: '',
    noisy: "console.log('building panel');\n",
    'no-newline': "process.stdout.write('building panel');\n",
  };
  for (const [label, buildScript] of Object.entries(builds)) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-verify-prepack-${label}-`));
    const dir = path.join(parent, 'plugin');
    try {
      const scaffold = init({ dir, name: `${label}-prepack-scaffold`, title: `${label} prepack` });
      assert.equal(scaffold.ok, true, JSON.stringify(scaffold.failures));

      fs.writeFileSync(path.join(dir, 'build.mjs'), buildScript);
      editManifest(dir, (manifest) => {
        manifest.scripts = { ...manifest.scripts, prepack: 'node build.mjs' };
      });
      if (label !== 'silent') {
        // Keep the fixture honest: if build.mjs stops printing, this test no
        // longer reproduces the stdout contamination it is here to pin.
        const expected = label === 'noisy' ? 'building panel\n' : 'building panel';
        const build = spawnSync(process.execPath, ['build.mjs'], { cwd: dir, encoding: 'utf8' });
        assert.equal(build.stdout, expected, `the ${label} build no longer prints the expected stdout`);
      }

      const result = verifyNoMount(dir);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.status, 0, `${label} prepack:\n${output}`);
      const okLines = result.stdout.match(/^ok {2}packed /gm) ?? [];
      assert.equal(okLines.length, 1, `${label} prepack must print one packed line:\n${output}`);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }
});

test('the unmodified scaffold still exits 0 with --no-mount', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-prepack-scaffold-'));
  const dir = path.join(parent, 'plugin');
  try {
    const scaffold = init({ dir, name: 'prepack-scaffold', title: 'Prepack scaffold' });
    assert.equal(scaffold.ok, true, JSON.stringify(scaffold.failures));

    const result = verifyNoMount(dir);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(result.stdout, /^ok {2}packed \d+ file\(s\)/m, output);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

/** Edit the scaffold manifest, keeping the test's change readable. */
function editManifest(dir, change) {
  const file = path.join(dir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(manifest);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Add a `prepack` hook that leaves a marker. A manifest-only failure must be
 * reported at `doctor`, so the marker staying absent proves no build hook ran.
 */
function addMarkerHook(dir) {
  const scripts = path.join(dir, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(
    path.join(scripts, 'prepack-marker.mjs'),
    "import fs from 'node:fs';\nimport { fileURLToPath } from 'node:url';\n\n" +
      "fs.writeFileSync(fileURLToPath(new URL('../prepack-ran.txt', import.meta.url)), 'ran');\n",
  );
  editManifest(dir, (manifest) => {
    manifest.scripts = { ...manifest.scripts, prepack: 'node scripts/prepack-marker.mjs' };
  });
}

test('a client platform mismatch stops at doctor before the pack hook runs', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-prepack-platform-'));
  const dir = path.join(parent, 'plugin');
  try {
    assert.equal(init({ dir, name: 'prepack-platform', title: 'Prepack platform' }).ok, true);
    addMarkerHook(dir);
    editManifest(dir, (manifest) => {
      manifest.dsh.client.platform = 'node';
    });

    const result = await verify({ dir, mount: false });
    assert.equal(result.ok, false, JSON.stringify(result.failures));
    assert.equal(result.stage, 'doctor');
    assert.match(result.failures[0].message, /platform is "node"/u);
    assert.equal(
      fs.existsSync(path.join(dir, 'prepack-ran.txt')),
      false,
      'a manifest-only client declaration failure ran the build hook before reporting itself',
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('a client file without the dsh.client declaration stops at doctor before the pack hook runs', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-prepack-undeclared-'));
  const dir = path.join(parent, 'plugin');
  try {
    assert.equal(init({ dir, name: 'prepack-undeclared', title: 'Prepack undeclared' }).ok, true);
    addMarkerHook(dir);
    editManifest(dir, (manifest) => {
      delete manifest.dsh.client;
    });

    const result = await verify({ dir, mount: false });
    assert.equal(result.ok, false, JSON.stringify(result.failures));
    assert.equal(result.stage, 'doctor');
    assert.equal(result.failures[0].check, 'client declaration');
    assert.match(result.failures[0].message, /is not declared/u);
    assert.equal(
      fs.existsSync(path.join(dir, 'prepack-ran.txt')),
      false,
      'a manifest-only client declaration failure ran the build hook before reporting itself',
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('a package with no files list stops at doctor without running the pack hook', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-prepack-nofiles-'));
  const dir = path.join(parent, 'plugin');
  try {
    assert.equal(init({ dir, name: 'prepack-nofiles', title: 'Prepack no files' }).ok, true);
    addMarkerHook(dir);
    editManifest(dir, (manifest) => {
      delete manifest.files;
    });

    const result = await verify({ dir, mount: false });
    assert.equal(result.ok, false, JSON.stringify(result.failures));
    assert.equal(result.stage, 'doctor');
    assert.equal(result.failures[0].check, 'files list');
    assert.match(result.failures[0].message, /no "files" list/u);
    assert.equal(
      fs.existsSync(path.join(dir, 'prepack-ran.txt')),
      false,
      'a missing files list is a manifest bug, not a file the pack hook can generate',
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
