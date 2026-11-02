// After a publish, "npm publish returned 0" is not evidence. This waits for the
// registry to actually serve the version, then installs it by name in an empty
// directory and runs the CLI once.
//
// Run it locally with: node scripts/publish-registry.mjs dsh-plugin-toolkit 0.13.11
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [name, version] = process.argv.slice(2);
if (!name || !version) {
  console.error('usage: node scripts/publish-registry.mjs <package> <version>');
  process.exit(2);
}

const timeoutMs = Number(process.env.REGISTRY_TIMEOUT_MS ?? 900_000);
const intervalMs = Number(process.env.REGISTRY_INTERVAL_MS ?? 15_000);
const deadline = Date.now() + timeoutMs;

let served = false;
while (Date.now() < deadline) {
  const response = await fetch(`https://registry.npmjs.org/${name}`, {
    headers: { accept: 'application/json' },
  });
  if (response.ok === true) {
    const doc = await response.json();
    if (Object.hasOwn(doc.versions ?? {}, version) === true) {
      served = true;
      console.log(`the registry serves ${name}@${version} (published ${doc.time?.[version] ?? 'unknown'})`);
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
if (served === false) {
  console.error(`the registry never served ${name}@${version} within ${Math.round(timeoutMs / 1000)}s`);
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-smoke-'));
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'smoke', private: true, version: '1.0.0' }));
const install = spawnSync('npm', ['install', `${name}@${version}`, '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8' });
if (install.status !== 0) {
  console.error(`a clean install of ${name}@${version} failed: ${(install.stderr || '').trim().slice(-400)}`);
  process.exit(1);
}
const cli = spawnSync(path.join(dir, 'node_modules', '.bin', 'dsh-plugin'), ['--help'], { cwd: dir, encoding: 'utf8' });
fs.rmSync(dir, { recursive: true, force: true });
if (cli.status !== 0) {
  console.error(`the installed CLI failed: ${(cli.stderr || '').trim().slice(-400)}`);
  process.exit(1);
}
console.log(`a clean install of ${name}@${version} runs.`);
