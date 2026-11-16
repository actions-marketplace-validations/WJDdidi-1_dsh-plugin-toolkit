/**
 * The README tells a reader to run `node scripts/preview.mjs`, including in the
 * installed package. `files` shipped the benchmark and compatibility scripts
 * but not the preview, so the command worked only in a checkout; the gap
 * appeared after `npm pack`, not in `npm test` against the working copy.
 *
 * The tarball is the unit here: run the documented command against the packed
 * file list, install that tarball into a temp prefix, compare every installed
 * README-cited command byte for byte with the repository copy, and then run
 * the installed preview the way the README shows. The peer dependencies are
 * linked from this checkout so the test stays offline while still using real
 * React and jsdom, and the preview is run from outside the install prefix so
 * it cannot accidentally borrow this checkout's `node_modules`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/exec.mjs';
import { documentedRunCommands } from '../lib/readme-commands.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREVIEW = 'scripts/preview.mjs';

function documentedPreviewScript() {
  // A Windows checkout writes README.md with CRLF; the fenced command is just
  // text, so normalize before matching the line a reader copies.
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/gu, '\n');
  const match = /^node (scripts\/preview\.mjs)\b/mu.exec(readme);
  assert.ok(match, `README no longer tells a reader to run \`node ${PREVIEW}\``);
  return match[1];
}

/** Give the temp install the optional peers the README names, without a registry read. */
function linkPeers(prefix) {
  for (const name of ['jsdom', 'react', 'react-dom']) {
    const source = path.join(ROOT, 'node_modules', name);
    assert.ok(fs.existsSync(source), `npm ci did not install ${name}, so the preview cannot be run`);
    fs.symlinkSync(source, path.join(prefix, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir');
  }
}

function packedFiles(scratch, dryRun) {
  const args = ['pack', '--json'];
  if (dryRun) args.push('--dry-run');
  else args.push('--pack-destination', scratch);
  const [document] = JSON.parse(run('npm', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  return { document, files: new Set(document.files.map((entry) => entry.path)) };
}

test('the installed tarball ships and runs the preview command the README cites', () => {
  const scriptPath = documentedPreviewScript();
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(
    manifest.files.includes(scriptPath),
    `package.json files omits ${scriptPath}, so npm pack will leave the documented command out`,
  );

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preview-tarball-'));
  try {
    const dryRun = packedFiles(scratch, true);
    assert.ok(
      dryRun.files.has(scriptPath),
      `\`npm pack --dry-run --json\` does not list ${scriptPath}:\n${[...dryRun.files].sort().join('\n')}`,
    );

    const { document, files } = packedFiles(scratch, false);
    assert.ok(files.has(scriptPath), `the packed tarball does not list ${scriptPath}`);

    const prefix = path.join(scratch, 'install');
    // Install only the tarball; the optional peers are linked below so the
    // test does not depend on the registry.
    run('npm', ['install', path.join(scratch, document.filename), '--prefix', prefix, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=peer'], {
      cwd: scratch,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const installedRoot = path.join(prefix, 'node_modules', 'dsh-plugin-toolkit');
    // Every `node <path>` command in the shipped READMEs, not just the preview,
    // has to be present and identical after a real install. This is the
    // acceptance case for the inquiry, kept next to the command it runs.
    const documented = documentedRunCommands(ROOT);
    for (const command of documented.keys()) {
      const installedFile = path.join(installedRoot, command);
      assert.ok(fs.existsSync(installedFile), `the installed package has no ${command} (named in ${documented.get(command)})`);
      const repository = fs.readFileSync(path.join(ROOT, command));
      const shippedFile = fs.readFileSync(installedFile);
      assert.ok(
        repository.equals(shippedFile),
        `the installed ${command} differs from the repository copy (${shippedFile.length} vs ${repository.length} bytes)`,
      );
    }

    const installed = path.join(installedRoot, scriptPath);
    const page = path.join(scratch, 'panel.html');

    // Without the optional peers (--omit=peer above), a bare install cannot
    // mount a panel. The failure should name the install command, not end in a
    // stack trace from the first `requireFrom`.
    const missingPeers = spawnSync(process.execPath, [installed, page], {
      // A cwd outside the install: the preview has to resolve its peers from
      // the package, not from wherever the reader happens to be standing.
      cwd: scratch,
      encoding: 'utf8',
      // Keep a developer's global modules out of the lookup: this run is the
      // bare install, and its answer must not depend on the host machine.
      env: { ...process.env, NODE_PATH: '', HOME: prefix, USERPROFILE: prefix },
    });
    assert.equal(missingPeers.status, 1, `a preview with no jsdom/react should exit 1:\n${missingPeers.stderr}`);
    assert.match(missingPeers.stderr, /preview: the testkit needs the optional peers jsdom, react and react-dom/u);
    assert.match(missingPeers.stderr, /npm install --save-dev jsdom react react-dom/u);
    assert.doesNotMatch(missingPeers.stderr, /^\s+at /mu, 'the missing peer was reported as a stack trace');

    linkPeers(prefix);
    const output = run(process.execPath, [installed, page], {
      // Run from outside the install, not from this checkout and not from the
      // package root: a command that only works because the repository's
      // node_modules happens to be above it is not shipped. The linked peers
      // are the ones the README tells a reader to install for the testkit.
      cwd: scratch,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.ok(output.includes(`wrote ${page}`), `the installed preview did not report the page it wrote:\n${output}`);
    const html = fs.readFileSync(page, 'utf8');
    assert.match(html, /^<!doctype html>/u, 'the preview did not write an HTML document');
    assert.match(html, /dock collapsed/u, 'the preview did not render the dock states');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
