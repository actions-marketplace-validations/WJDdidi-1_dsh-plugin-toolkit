/**
 * A flag that takes a value must be followed by that value.
 *
 * The failure this pins is a false success: `fix --engines --range --write`
 * used to store `--write` as the range and fail later with a semver error, and
 * `release --dry-run --tag-prefix` silently planned the default `plugin-v`
 * tag. Every value-taking flag must stop at usage validation instead, name
 * itself, and exit `2` before it reads a file, plans a release, or consumes
 * the next option. A valid value still reaches the command.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const GOOD = path.join(here, 'fixtures', 'good');

function run(args, cwd = ROOT) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
}

// Each entry exercises a flag where the value is actually consumed. Some also
// follow the bare flag with another option: that option must not become the
// value, and the command must not reach its normal work.
const MISSING_CASES = [
  ['index', '--index'],
  ['index', '--index', '--json'],
  ['fix', GOOD, '--engines', '--range'],
  ['fix', GOOD, '--engines', '--range', '--write'],
  ['explain', '--log'],
  ['release', GOOD, '--dry-run', '--tag-prefix'],
  ['release', GOOD, '--dry-run', '--base'],
  ['release', GOOD, '--dry-run', '--market'],
  ['release', GOOD, '--budget'],
  ['audit', '--timeout'],
  ['audit', '--host'],
  ['audit', '--home'],
  ['audit', '--remote', '--from'],
  ['audit', '--remote', '--patch-dir'],
  ['audit', '--remote', '--jobs'],
  ['fix', 'demo/plugin', '--remote', '--patch'],
  ['mount', 'client.js', '--slot'],
  ['mount', 'client.js', '--surface'],
  ['dev', '.', '--dest'],
  ['dev', '.', '--entry'],
  ['dev', '.', '--build'],
  ['dev', '.', '--debounce'],
  ['init', '.', '--title'],
  ['init', '.', '--name'],
  ['init', '.', '--name', '--force'],
];

test('every value-taking flag rejects a missing value with exit 2 and its name', () => {
  for (const args of MISSING_CASES) {
    const result = run(args);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.error, undefined, args.join(' '));
    assert.equal(result.status, 2, `${args.join(' ')}\n${output}`);
    const flag = args.find((arg) => arg.startsWith('--') && arg !== '--engines' && arg !== '--dry-run' && arg !== '--remote' && arg !== '--force');
    assert.ok(flag !== undefined, `the case names no value flag: ${args.join(' ')}`);
    assert.ok(result.stderr.includes(flag), `${args.join(' ')} did not name ${flag}\n${output}`);
    assert.doesNotMatch(output, /would write|dry run:|opened |tagged /u, `${args.join(' ')} reached the command\n${output}`);
  }
});

test('a valid value still reaches the command', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-value-flag-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const log = path.join(scratch, 'install.log');
  fs.writeFileSync(log, 'plugin install failed\n');
  const emptyHome = path.join(scratch, 'home');
  fs.mkdirSync(emptyHome);

  const fix = run(['fix', GOOD, '--engines', '--range', '>=0.4.0']);
  assert.equal(fix.status, 0, fix.stderr);
  assert.match(fix.stdout, /would write engines\.dsh ">=0\.4\.0"/u);

  const release = run(['release', GOOD, '--dry-run', '--tag-prefix', 'release-']);
  assert.equal(release.status, 0, release.stderr);
  assert.match(release.stdout, /git tag release-1\.2\.3/u);

  const explain = run(['explain', '--log', log]);
  assert.equal(explain.status, 0, explain.stderr);
  assert.match(explain.stdout, /known cause/u);

  const audit = run(['audit', '--home', emptyHome, '--timeout', '50']);
  assert.equal(audit.status, 0, audit.stderr);
  assert.match(audit.stdout, /no plugins installed/u);
});

test('the bare --index contract keeps its dedicated message and reads no default index', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-index-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'market'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'market', 'index.json'), '{"plugins":[{"name":"default-plugin","versions":[]}]}\n');

  const result = run(['index', '--index'], dir);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 2, output);
  assert.match(result.stderr, /--index needs a path/u, output);
  assert.doesNotMatch(output, /default-plugin/u, 'the command read the default index');
});
