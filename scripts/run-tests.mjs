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
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-toolkit-test-'));
const logs = path.join(cache, '_logs');
fs.mkdirSync(logs, { recursive: true });

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    npm_config_cache: cache,
    npm_config_logs_dir: logs,
  },
});

fs.rmSync(cache, { recursive: true, force: true });
process.exit(result.status ?? 1);
