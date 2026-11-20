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
 *      node scripts/compatibility-sample.mjs --json
 *      node scripts/compatibility-sample.mjs --host 0.1.5
 *
 * `--json` replays the same command with the flag CI reads, so the machine
 * form is checked against the executable too, not just described in prose.
 * `--host` asks the same frozen manifest about another DSH version, so a
 * reader can reproduce the answer for the host they actually run; the default
 * stays the canary from the reports. With an explicit host the script passes
 * the replayed command's exit status through, because that is the status a CI
 * step would gate on. Without it the wrapper exits 0 only after the known
 * incompatible replay exited 1.
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
const DEFAULT_HOST = '0.2.2-alpha.3';

function usage(message) {
  process.stderr.write(`compatibility-sample: ${message}\n`);
  process.exit(2);
}

let JSON_OUTPUT = false;
let HOST = DEFAULT_HOST;
let HOST_EXPLICIT = false;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--json') {
    JSON_OUTPUT = true;
  } else if (argument === '--host') {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--') === true) {
      usage('--host needs a complete DSH version, for example --host 0.2.2');
    }
    HOST = value;
    HOST_EXPLICIT = true;
    index += 1;
  } else if (argument.startsWith('--host=') === true) {
    const value = argument.slice('--host='.length);
    if (value.trim() === '') usage('--host needs a complete DSH version, for example --host 0.2.2');
    HOST = value;
    HOST_EXPLICIT = true;
  } else {
    usage(`unknown argument ${argument}; use --json or --host <version>`);
  }
}

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
    const command = ['--require', preload, BIN, 'audit', '--remote', TARGET, '--host', HOST];
    if (JSON_OUTPUT === true) command.push('--json');
    const result = spawnSync(process.execPath, command, {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_COMPATIBILITY_SAMPLE: SAMPLE,
        DSH_COMPATIBILITY_TARGET: TARGET,
      },
    });
    if (result.error !== undefined) throw result.error;
    const stderr = String(result.stderr ?? '').trim();
    // The CLI validates `--host` at the same boundary a real run uses. Forward
    // that usage refusal instead of turning it into a wrapper stack trace; a
    // typo in the version must not look like a successful replay.
    if (result.status === 2) {
      if (stderr === '') throw new Error('the compatibility sample exited 2 without saying why');
      return { stdout: String(result.stdout ?? ''), stderr, status: 2 };
    }
    if (HOST_EXPLICIT === false) {
      if (result.status !== 1) {
        throw new Error(
          `the compatibility sample answered ${result.status ?? 'no status'}; the documented incompatible answer exits 1${
            stderr === '' ? '' : `\n${stderr}`
          }`,
        );
      }
      if (stderr !== '') throw new Error(`the compatibility sample wrote to stderr:\n${stderr}`);
      // The wrapper's own 0 means the documented incompatible answer was
      // reproduced; the default command is a demonstration, not a gate.
      return { stdout: String(result.stdout ?? ''), stderr: '', status: 0 };
    }
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`the compatibility sample answered ${result.status ?? 'no status'}${stderr === '' ? '' : `\n${stderr}`}`);
    }
    if (stderr !== '') throw new Error(`the compatibility sample wrote to stderr:\n${stderr}`);
    // An explicit host is a question whose answer a reader may gate on, so the
    // wrapper exits with the replayed CLI's status.
    return { stdout: String(result.stdout ?? ''), stderr: '', status: result.status };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const replayed = replay();
if (replayed.stdout !== '') process.stdout.write(replayed.stdout);
if (replayed.stderr !== '') process.stderr.write(`${replayed.stderr}\n`);
process.exitCode = replayed.status;
