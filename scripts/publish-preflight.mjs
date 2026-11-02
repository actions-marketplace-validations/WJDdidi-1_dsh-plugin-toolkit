// Preflight for the publish workflow: everything that must be true before a
// tarball is allowed near the registry, checked from the working tree.
//
// Run it locally with: node scripts/publish-preflight.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const problems = [];

// 1. The repository field must point at the repo the workflow runs in, or
//    provenance would attest to the wrong place.
const url = String(manifest.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
const expected = process.env.GITHUB_REPOSITORY
  ? `https://github.com/${process.env.GITHUB_REPOSITORY}`
  : 'https://github.com/WJDdidi-1/dsh-plugin-toolkit';
if (url !== expected) problems.push(`repository.url is ${url || 'missing'}, expected ${expected}`);

// 2. No credential-shaped strings in anything the tarball would ship.
const SECRETS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
  /\bsk-[A-Za-z0-9]{20,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
];
const shipped = (manifest.files ?? []).flatMap((entry) => {
  const full = path.join(root, entry);
  if (entry.endsWith('/')) {
    return fs.readdirSync(full, { recursive: true })
      .map((name) => path.join(full, String(name)))
      .filter((file) => fs.statSync(file).isFile());
  }
  return fs.existsSync(full) ? [full] : [];
});
for (const file of shipped) {
  const text = fs.readFileSync(file, 'utf8');
  for (const pattern of SECRETS) {
    if (pattern.test(text)) problems.push(`${path.relative(root, file)} looks like it contains a credential`);
  }
}

// 3. The pack list must contain what package.json points at.
// On Windows `npm` is `npm.cmd`, and spawning a `.cmd` needs a shell.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packed = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
}));
const names = new Set(packed[0].files.map((file) => file.path));
for (const required of ['package.json', 'index.js', 'client.js', 'bin/dsh-plugin.mjs', 'lib/cli.mjs', 'cordis.patch.yml']) {
  if (!names.has(required)) problems.push(`the tarball does not ship ${required}`);
}
for (const name of names) {
  if (/(^|\/)\.env($|\.)/u.test(name) || name.endsWith('.npmrc') || name.endsWith('.pem') || name.endsWith('.key')) {
    problems.push(`the tarball ships ${name}, which must never be published`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  console.error(`\n${problems.length} problem(s): refusing to publish.`);
  process.exit(1);
}
console.log(`ok ${manifest.name}@${manifest.version}, ${names.size} file(s) packed, repository ${url}`);
