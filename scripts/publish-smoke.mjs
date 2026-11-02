// Install a real tarball into an empty directory and drive the CLI the way a
// user would. The `audit --home` case is here because 0.13.10 shipped a crash
// in exactly that flag: the tarball installed, and the command died on
// `args is not defined`.
//
// Run it locally with: node scripts/publish-smoke.mjs <tarball>
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tarball = path.resolve(process.argv[2] ?? '');
if (!fs.existsSync(tarball)) {
  console.error(`no tarball at ${tarball}`);
  process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-smoke-'));
const run = (command, args, options = {}) =>
  spawnSync(command, args, { cwd: dir, encoding: 'utf8', ...options });

const failures = [];
const check = (name, ok, detail = '') => {
  if (ok === true) {
    console.log(`✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ''}`);
    console.error(`✗ ${name}${detail ? `: ${detail}` : ''}`);
  }
};

fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'smoke', private: true, version: '1.0.0' }, null, 2));
const installed = run('npm', ['install', tarball, '--no-audit', '--no-fund']);
check('the tarball installs in an empty directory', installed.status === 0, (installed.stderr || '').trim().slice(-300));

const cli = path.join(dir, 'node_modules', '.bin', 'dsh-plugin');

// 1. The host half imports, and it is a plugin rather than the CLI.
const host = run(process.execPath, ['-e', "import('dsh-plugin-toolkit').then((m) => { console.log(typeof m.apply, m.name); })"]);
check('the installed package exports apply', host.status === 0 && host.stdout.trim().startsWith('function'), host.stderr.trim().slice(-300));

// 2. The CLI answers.
const version = run(cli, ['--help']);
check('the CLI runs', version.status === 0 && /dsh-plugin/u.test(version.stdout), version.stderr.trim().slice(-300));

// 3. `audit --home` must reach the audit: a home with a broken plugin exits 1.
const home = path.join(dir, 'home');
const pluginDir = path.join(home, 'profiles', 'desktop', 'node_modules', 'demo-plugin');
fs.mkdirSync(pluginDir, { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0', dsh: {} }));
const broken = run(cli, ['audit', '--home', home]);
check('audit --home reads the flag it was given', !/args is not defined/u.test(broken.stdout + broken.stderr), (broken.stderr || '').trim().slice(-300));
check('audit --home exits 1 for a plugin with no bundle', broken.status === 1, `exit ${broken.status}`);

// 4. A home with nothing installed is a pass.
const emptyHome = path.join(dir, 'empty-home');
fs.mkdirSync(emptyHome, { recursive: true });
const clean = run(cli, ['audit', '--home', emptyHome]);
check('audit --home exits 0 when nothing is installed', clean.status === 0, `exit ${clean.status}`);

fs.rmSync(dir, { recursive: true, force: true });
if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed.`);
  process.exit(1);
}
console.log('\nthe tarball installs and its CLI works.');
