#!/usr/bin/env node
/**
 * Replay the README's "will this plugin install on my DSH?" sample without a
 * GitHub request.
 *
 * `examples/compatibility-sample/package.json` is a checked-in copy of the
 * manifest the README audits. A preload installs a fake GitHub that serves that
 * folder, then this script runs the real `dsh-plugin audit --remote
 * <owner/repo> --host <version>` process. The quoted line therefore comes from
 * the same executable, flag parser, formatter and exit-code path a reader runs,
 * not from a hand-written example or a library-only shortcut.
 *
 * Run: node scripts/compatibility-sample.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SAMPLE = path.join(ROOT, 'examples', 'compatibility-sample');
const BIN = path.join(ROOT, 'bin', 'dsh-plugin.mjs');
const TARGET = 'L3n3L/dsh-resume';
const HOST = '0.2.2-alpha.3';

// A CommonJS preload works on every Node version the package supports; an
// `--import` hook would require a newer Node than `engines` promises.
const PRELOAD = `
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const sample = process.env.DSH_COMPATIBILITY_SAMPLE;
const target = process.env.DSH_COMPATIBILITY_TARGET;

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

globalThis.fetch = async (url) => {
  const match = /^https:\\/\\/api\\.github\\.com\\/repos\\/([^/]+)\\/([^/]+)\\/contents\\/([^?]+)/u.exec(String(url));
  if (match === null || match[1] + '/' + match[2] !== target) return response(404, { message: 'Not Found' });

  const file = decodeURIComponent(match[3]).replace(/^\\.\\//u, '');
  const full = path.resolve(sample, file);
  // Keep the fake server inside the checked-in folder, even if a manifest ever
  // points at a path outside it.
  if (full.startsWith(sample + path.sep) === false || fs.existsSync(full) === false) {
    return response(404, { message: 'Not Found' });
  }
  if (fs.statSync(full).isFile() === false) return response(404, { message: 'Not Found' });
  return response(200, {
    encoding: 'base64',
    content: fs.readFileSync(full).toString('base64'),
  });
};
`;

function replay() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compatibility-sample-'));
  const preload = path.join(scratch, 'github-preload.cjs');
  try {
    fs.writeFileSync(preload, PRELOAD);
    const result = spawnSync(
      process.execPath,
      ['--require', preload, BIN, 'audit', '--remote', TARGET, '--host', HOST],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          DSH_COMPATIBILITY_SAMPLE: SAMPLE,
          DSH_COMPATIBILITY_TARGET: TARGET,
        },
      },
    );
    if (result.error !== undefined) throw result.error;
    const stderr = String(result.stderr ?? '').trim();
    if (result.status !== 1) {
      throw new Error(
        `the compatibility sample answered ${result.status ?? 'no status'}; the documented incompatible answer exits 1${
          stderr === '' ? '' : `\n${stderr}`
        }`,
      );
    }
    if (stderr !== '') throw new Error(`the compatibility sample wrote to stderr:\n${stderr}`);
    return result.stdout;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

process.stdout.write(replay());
