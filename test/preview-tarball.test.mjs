/**
 * The README tells a reader to run `node scripts/preview.mjs`, including in the
 * installed package. `files` shipped the benchmark and compatibility scripts
 * but not the preview, so the command worked only in a checkout; the gap
 * appeared after `npm pack`, not in `npm test` against the working copy.
 *
 * The tarball is the unit here: run the documented command against the packed
 * file list, then install that tarball into a temp prefix and compare the
 * installed script byte for byte with the repository copy.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/exec.mjs';

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

test('the tarball ships the preview command the README cites, byte for byte', () => {
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
    // The preview only needs the package's own files to be present; skipping
    // optional peers keeps the test independent of the registry.
    run('npm', ['install', path.join(scratch, document.filename), '--prefix', prefix, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=peer'], {
      cwd: scratch,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const installed = path.join(prefix, 'node_modules', 'dsh-plugin-toolkit', scriptPath);
    assert.ok(fs.existsSync(installed), `the installed package has no ${scriptPath}`);
    const repository = fs.readFileSync(path.join(ROOT, scriptPath));
    const shipped = fs.readFileSync(installed);
    assert.ok(
      repository.equals(shipped),
      `the installed ${scriptPath} differs from the repository copy (${shipped.length} vs ${repository.length} bytes)`,
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
