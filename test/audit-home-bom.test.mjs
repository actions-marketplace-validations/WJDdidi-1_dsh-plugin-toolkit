/**
 * The six-trial experiment behind the profile-BOM inquiry, run at the CLI
 * boundary rather than against `readProfileBundles` directly.
 *
 * Three homes use the profile `package.json` Notepad writes (a leading UTF-8
 * BOM); three are the no-BOM controls. Every trial installs the same plugin,
 * lists it in `dsh.profile.bundles`, and points `audit --home` at a fake app
 * whose graph does not contain it. The only correct repair is therefore the
 * restart: "it is listed in dsh.profile.bundles, but the running app started
 * before it was installed".
 *
 * On 0.20.12 the BOM reached `JSON.parse`, the profile looked bundle-less, and
 * the three BOM trials printed `does not list it` plus `add "demo-plugin" to
 * dsh.profile.bundles` — a repair the user had already made. That is why this
 * test requires 6/6 restart sentences and zero occurrences of the wrong cause,
 * matching the metric `correct=N trials=6` from the experiment.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');

/** The experiment alternated a BOM profile with its no-BOM control. */
const VARIANTS = [true, false, true, false, true, false];

function writePlugin(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    name: 'demo-plugin',
    version: '1.0.0',
    files: ['index.js', 'client.js', 'cordis.patch.yml', 'README.md'],
    engines: { dsh: '>=0.2.0' },
    exports: { './client': './client.js' },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web' },
    },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply() {}\n');
  fs.writeFileSync(
    path.join(dir, 'client.js'),
    'window.__ModuleLoader__.load({ id: "x", factory: () => ({}) });\n',
  );
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert: []\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n\n## Requirements\n\n`>=0.2.0`\n');
}

function writeProfile(home, bom) {
  const profile = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
  writePlugin(path.join(profile, 'node_modules', 'demo-plugin'));
  const manifest = {
    name: 'desktop',
    private: true,
    dsh: { profile: { bundles: ['demo-plugin'] } },
  };
  const prefix = bom === true ? '\uFEFF' : '';
  fs.writeFileSync(path.join(profile, 'package.json'), `${prefix}${JSON.stringify(manifest, null, 2)}`);
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test('the 3 BOM + 3 no-BOM CLI trials all print the restart repair', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-home-bom-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"type":"graph","graph":{"entries":[]}}\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const trials = [];
  for (const [trial, bom] of VARIANTS.entries()) {
    const home = path.join(root, `home-${trial}`);
    writeProfile(home, bom);
    const result = await runCli(['audit', '--home', home, '--host', `http://127.0.0.1:${port}`]);
    const output = `${result.stdout}\n${result.stderr}`;
    const label = bom === true ? 'BOM' : 'no-BOM';
    trials.push({ trial, label, result, output });
  }

  for (const { trial, label, result, output } of trials) {
    assert.equal(result.status, 1, `trial ${trial} (${label}) must fail the not-loaded gate:\n${output}`);
    assert.match(
      output,
      /it is listed in dsh\.profile\.bundles, but the running app started before it was installed/u,
      `trial ${trial} (${label}) must read the BOM profile and name the restart cause:\n${output}`,
    );
    assert.match(
      output,
      /fix: restart the app once to load it/u,
      `trial ${trial} (${label}) must print the restart repair:\n${output}`,
    );
    assert.doesNotMatch(
      output,
      /does not list it/u,
      `trial ${trial} (${label}) must not call the listed plugin unlisted:\n${output}`,
    );
    assert.doesNotMatch(
      output,
      /add "demo-plugin" to dsh\.profile\.bundles/u,
      `trial ${trial} (${label}) must not ask for a profile edit it already has:\n${output}`,
    );
  }

  const restartSentences = trials.filter(({ output }) => output.includes('fix: restart the app once to load it')).length;
  assert.equal(restartSentences, 6, `correct=${restartSentences} trials=6`);
  const wrongCause = trials.filter(({ output }) => output.includes('does not list it')).length;
  assert.equal(wrongCause, 0, `${wrongCause} trial(s) printed the wrong repair`);
});
