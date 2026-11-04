#!/usr/bin/env node
/**
 * Run the test suite with a workspace-independent npm cache and log directory.
 *
 * Some tests pack and install a scaffold, which shells out to `npm`. When the
 * checkout is inside a sandbox that only allows writes below the workspace,
 * npm's default `~/.npm/_logs` and cache are not writable and `npm pack` fails
 * before the test's own assertion runs. Keeping both under the system temp
 * directory makes `npm test` depend on the code under test, not on where the
 * user's npm home happens to live.
 *
 * The file list is explicit. `node --test` with no arguments discovers files
 * with a version-dependent rule, and on Node 18 that rule includes everything
 * under `test/` — fixtures included. Those fixtures are inputs to other tests,
 * not tests: executed directly, five of them fail, which turned `npm test` red
 * on Node 18 on every platform while Node 20 and 22 stayed green.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-toolkit-test-'));
const logs = path.join(cache, '_logs');
fs.mkdirSync(logs, { recursive: true });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = fs
  .readdirSync(path.join(ROOT, 'test'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join('test', name));

const requested = process.argv.slice(2);
const files = requested.length > 0 ? requested : tests;
const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: ROOT,
  env: {
    ...process.env,
    npm_config_cache: cache,
    npm_config_logs_dir: logs,
  },
});

fs.rmSync(cache, { recursive: true, force: true });
process.exit(result.status ?? 1);
