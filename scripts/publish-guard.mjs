// Refuse to publish a version the registry already serves, and refuse a tag that
// does not name the version in package.json.
//
// Run it locally with: node scripts/publish-guard.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? path.join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const problems = [];

const tag = process.env.GITHUB_REF_NAME ?? '';
if (tag.startsWith('plugin-v') === true && tag.slice('plugin-v'.length) !== manifest.version) {
  problems.push(`tag ${tag} does not match package.json ${manifest.version}`);
}

const response = await fetch(`https://registry.npmjs.org/${manifest.name}`, {
  headers: { accept: 'application/json' },
});
if (response.ok === true) {
  const doc = await response.json();
  if (Object.hasOwn(doc.versions ?? {}, manifest.version) === true) {
    problems.push(`${manifest.name}@${manifest.version} is already published; a published version is never overwritten`);
  } else {
    console.log(`${manifest.name}@${manifest.version} is not published yet`);
  }
} else if (response.status === 404) {
  console.log(`${manifest.name} is not on the registry yet`);
} else {
  problems.push(`the registry answered ${response.status}, so this is UNKNOWN_REMOTE_STATE`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exit(1);
}
