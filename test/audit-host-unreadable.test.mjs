/**
 * `audit --host` asks the running app which plugins it loaded. If the app
 * cannot be reached, the command has not observed the graph it was asked for,
 * so it must not report the profile as clean and exit `0`: the documented CI
 * gate would pass without checking anything.
 *
 * The regression is pinned at the process boundary: the shipped CLI exits `2`,
 * prints the URL it could not read, and prints no clean row or summary. Two
 * controls keep the gate from becoming "always fail": the same profile without
 * `--host` stays the `?` control that exits `0`, and a reachable app that
 * loaded the plugin is the `loaded` control that also exits `0`. The exported
 * audit separately returns the operational failure and the URL.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { audit } from '../lib/audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const CLEAN_FIXTURE_HOME = path.join(here, 'fixtures', 'audit-home-clean', 'home');
const CLEAN_FIXTURE_PLUGIN = path.join(here, 'fixtures', 'audit-home-clean', 'plugin', 'clean-plugin');
const HOST = 'http://127.0.0.1:9';

/** Copy the clean home and install its declared plugin in the loader's shape. */
function materializeCleanHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-host-unreadable-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.cpSync(CLEAN_FIXTURE_HOME, home, { recursive: true });
  const dest = path.join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'clean-plugin');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(CLEAN_FIXTURE_PLUGIN, dest, { recursive: true });
  return path.join(home, '.dsh');
}

function runAudit(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10000,
  });
}

/** Spawn without blocking the event loop, so a local graph server can answer. */
function runAuditAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

test('an unreadable requested graph is an exit-2 audit, not a clean report', (t) => {
  const home = materializeCleanHome(t);
  const result = runAudit(['audit', '--home', home, '--host', HOST, '--timeout', '200']);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 2, output);
  assert.match(output, /could not read the plugin graph/u, output);
  assert.match(output, /http:\/\/127\.0\.0\.1:9\/plugins\/events/u, 'the URL that failed must be named');
  assert.doesNotMatch(output, /^clean-plugin\s+1\.0\.0\s+\?\s+ok$/mu, 'an unreachable app must not print a clean plugin row');
  assert.doesNotMatch(output, /^summary:/mu, 'an unreachable app must not print a clean summary');

  // The control the CI gate distinguishes: without --host nothing was
  // requested, so the loaded column stays unknown and the clean plugin passes.
  const control = runAudit(['audit', '--home', home, '--timeout', '200']);
  const controlOutput = `${control.stdout}\n${control.stderr}`;
  assert.equal(control.status, 0, controlOutput);
  assert.match(control.stdout, /^clean-plugin\s+1\.0\.0\s+\?\s+ok$/mu, controlOutput);
});

test('a reachable app that loaded the one plugin is the exit-0 control', { timeout: 15_000 }, async (t) => {
  const home = materializeCleanHome(t);
  const server = http.createServer((request, response) => {
    if (request.url !== '/plugins/events') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"type":"graph","graph":{"entries":[{"id":"clean-plugin"}]}}\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const result = await runAuditAsync(['audit', '--home', home, '--host', `http://127.0.0.1:${port}`]);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /^clean-plugin\s+1\.0\.0\s+loaded\s+ok$/mu, output);
  assert.doesNotMatch(output, /not in the running app/u, output);
});

test('the exported audit names the graph URL and returns exitCode 2', async (t) => {
  const home = materializeCleanHome(t);
  const lines = [];
  const result = await audit({
    home,
    host: HOST,
    timeoutMs: 50,
    fetchImpl: async (url) => {
      throw new Error(`connect ECONNREFUSED ${url}`);
    },
    io: { log: (line) => lines.push(String(line)) },
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.graph.ok, false);
  assert.equal(result.graph.url, `${HOST}/plugins/events`);
  assert.deepEqual(result.plugins, [], 'no plugin row is produced before the graph is read');
  const output = lines.join('\n');
  assert.match(output, /could not read the plugin graph: GET http:\/\/127\.0\.0\.1:9\/plugins\/events/u);
});
