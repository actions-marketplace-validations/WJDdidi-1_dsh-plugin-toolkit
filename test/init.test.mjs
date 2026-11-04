/**
 * The scaffold has one job: produce a plugin that already passes the checks
 * people hit after their first publish. So the test runs those checks on the
 * output instead of trusting the template.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/cli.mjs';
import { doctor } from '../lib/doctor.mjs';
import { init } from '../lib/init.mjs';
import { mountClient } from '../lib/testkit/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-init-'));
}

const YAML_ID = 'rows = YAML.safe_load(File.read(ARGV[0])); puts JSON.generate(rows.dig(0, "insert", 0, "id"))';

/**
 * Psych is the parser the harness's YAML loader is closest to. Return a parser
 * for the patch id, or null after skipping where Ruby is not installed, so the
 * suite does not depend on a Ruby toolchain.
 */
function yamlIdParser(t) {
  const ruby = spawnSync('ruby', ['-e', 'require "yaml"'], { encoding: 'utf8' });
  if (ruby.error !== undefined || ruby.status !== 0) {
    t.skip('ruby/Psych is not installed');
    return null;
  }
  return (file) => spawnSync('ruby', ['-ryaml', '-rjson', '-e', YAML_ID, file], { encoding: 'utf8' });
}

/** The generated files, without running the checks the other tests run. */
function scaffoldOf() {
  const dir = path.join(scratch(), 'plugin');
  const result = init({ dir, name: 'scaffold-check', title: 'Scaffold check' });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  return {
    packageJson: JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')),
    ci: fs.readFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'utf8'),
  };
}

test('the scaffold passes doctor, which is the point of it', () => {
  const dir = path.join(scratch(), 'plugin');
  const result = init({ dir, name: 'my-panel', title: 'My panel' });
  assert.equal(result.ok, true);
  const report = doctor(dir);
  assert.deepEqual(report.failures, []);
  assert.equal(report.notes.hostRange, '>=0.2.0');
});

test('a scoped, unscoped or numeric-like name writes a patch id YAML keeps as a string', (t) => {
  const parseId = yamlIdParser(t);
  if (parseId === null) return;

  for (const name of ['@me/my-panel', 'my-panel', '123-panel', '123']) {
    const dir = path.join(scratch(), 'plugin');
    assert.equal(init({ dir, name, title: 'Panel' }).ok, true, name);

    const parsed = parseId(path.join(dir, 'cordis.patch.yml'));
    assert.equal(parsed.status, 0, `${name} does not parse as YAML:\n${parsed.stderr}`);
    assert.equal(JSON.parse(parsed.stdout), name);
  }
});

test('init --name @me/my-panel writes a patch whose scoped id parses', async (t) => {
  const dir = path.join(scratch(), 'plugin');
  const io = {
    lines: [],
    log(line) {
      this.lines.push(String(line));
    },
    error(line) {
      this.lines.push(String(line));
    },
  };
  const code = await run(['init', dir, '--name', '@me/my-panel', '--title', 'My panel'], io);
  assert.equal(code, 0, io.lines.join('\n'));

  const file = path.join(dir, 'cordis.patch.yml');
  const patch = fs.readFileSync(file, 'utf8');
  // 0.19.0 wrote `id: @me/my-panel`, which is not a plain YAML scalar. Keep
  // this check independent of whether Ruby is installed here.
  assert.match(patch, /^\s*-\s+id: '@me\/my-panel'$/m);

  const parseId = yamlIdParser(t);
  if (parseId === null) return;
  const parsed = parseId(file);
  assert.equal(parsed.status, 0, `cordis.patch.yml does not parse:\n${parsed.stderr}`);
  assert.equal(JSON.parse(parsed.stdout), '@me/my-panel');

  // The scaffold doctor blesses now carries a patch that parses.
  assert.deepEqual(doctor(dir).failures, []);
});

test('the scaffolded client bundle renders without a browser', async () => {
  const dir = path.join(scratch(), 'plugin');
  init({ dir, name: 'my-panel', title: 'My panel' });
  const panel = await mountClient({
    file: path.join(dir, 'client.js'),
    copy: { 'my-panel': { tabTitle: 'My panel', title: 'My panel', body: 'This panel came from dsh-plugin init.', clicks: 'Clicks' } },
  });
  assert.match(panel.text(), /My panel/);
  await panel.click('button');
  assert.match(panel.text(), /Clicks: 1/);
  await panel.unmount();
});

test('a title with an apostrophe or regex metacharacter still parses, in every generated JavaScript file', async () => {
  const dir = path.join(scratch(), 'plugin');
  const title = "Bob's (panel)?";
  assert.equal(init({ dir, name: 'quoted-panel', title }).ok, true);

  for (const relative of ['client.js', 'test/panel.test.mjs']) {
    const checked = spawnSync(process.execPath, ['--check', path.join(dir, relative)], { encoding: 'utf8' });
    assert.equal(checked.status, 0, `${relative} does not parse:\n${checked.stderr}`);
  }

  const panel = await mountClient({ file: path.join(dir, 'client.js') });
  assert.match(panel.text(), /Bob's \(panel\)\?/);
  await panel.unmount();
});

test('init --title "Bob\'s panel" writes JavaScript that parses and a client that mounts', async () => {
  const dir = path.join(scratch(), 'plugin');
  const io = {
    lines: [],
    log(line) {
      this.lines.push(String(line));
    },
    error(line) {
      this.lines.push(String(line));
    },
  };
  const code = await run(['init', dir, '--name', 'quoted-panel', '--title', "Bob's panel"], io);
  assert.equal(code, 0, io.lines.join('\n'));

  for (const relative of ['client.js', 'test/panel.test.mjs']) {
    const checked = spawnSync(process.execPath, ['--check', path.join(dir, relative)], { encoding: 'utf8' });
    assert.equal(checked.status, 0, `${relative} does not parse:\n${checked.stderr}`);
  }

  const panel = await mountClient({ file: path.join(dir, 'client.js') });
  assert.match(panel.text(), /Bob's panel/);
  await panel.unmount();
});

test('the scaffold ships the test and the workflow it tells you to run', () => {
  const dir = path.join(scratch(), 'plugin');
  init({ dir, name: 'my-panel' });
  const spec = fs.readFileSync(path.join(dir, 'test/panel.test.mjs'), 'utf8');
  assert.match(spec, /dsh-plugin-toolkit\/testkit/);
  assert.match(spec, /mountClient/);
  const workflow = fs.readFileSync(path.join(dir, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /npm test/);
  // The workflow checks the tarball, not the working copy: `doctor .` cannot
  // see that `files` left the client bundle out.
  assert.match(workflow, /uses: WJDdidi-1\/dsh-plugin-toolkit@v1/);
});

test('an occupied directory is refused unless --force, so nothing is overwritten', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'notes.md'), 'mine\n');
  const refused = init({ dir, name: 'my-panel' });
  assert.equal(refused.ok, false);
  assert.match(refused.failures[0].message, /is not empty/);
  assert.equal(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8'), 'mine\n');

  const forced = init({ dir, name: 'my-panel', force: true });
  assert.equal(forced.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8'), 'mine\n');
});

test('a name that npm would reject is rejected here, not at publish time', () => {
  for (const name of ['My Panel', '', '../evil', 'UPPER', '@scope']) {
    const result = init({ dir: path.join(scratch(), 'x'), name });
    assert.equal(result.ok, false, `${name} should be refused`);
    assert.equal(result.failures[0].check, 'name');
  }
  assert.equal(init({ dir: path.join(scratch(), 'ok'), name: '@me/my-panel' }).ok, true);
});

test('the scaffold pins the toolkit that generated it, not a number typed once', () => {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const scaffold = scaffoldOf();
  assert.equal(scaffold.packageJson.devDependencies['dsh-plugin-toolkit'], `^${version}`);
  assert.match(scaffold.ci, /uses: WJDdidi-1\/dsh-plugin-toolkit@v1/);
  assert.match(scaffold.ci, new RegExp(`version: ${version.replace(/\./g, '\\.')}`));
  // doctor reads the working copy; the generated workflow has to check the tarball.
  assert.equal(/npx --yes dsh-plugin-toolkit@[\d.]+ doctor/.test(scaffold.ci), false);
});

test('the scaffolded README carries the badge, so every new plugin links back', async () => {
  const dir = path.join(scratch(), 'badged');
  const result = init({ dir, name: 'badged', title: 'Badged' });
  assert.equal(result.ok, true);
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.match(readme, /docs\/badge\.svg/);
  assert.match(readme, /dsh-plugin-toolkit/);
});
