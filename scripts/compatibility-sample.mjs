#!/usr/bin/env node
/**
 * Replay the README's "will this plugin install on my DSH?" sample without a
 * GitHub request.
 *
 * `examples/compatibility-sample/package.json` is a checked-in copy of the
 * manifest the README audits. The fake GitHub below serves that folder through
 * the real `audit --remote <owner/repo> --host <version>` code path, including
 * the CLI's flag parsing and output formatter, so the quoted line is a fact
 * about this repository rather than a hand-written example.
 *
 * Run: node scripts/compatibility-sample.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, '..', 'examples', 'compatibility-sample');
const TARGET = 'L3n3L/dsh-resume';
const HOST = '0.2.2-alpha.3';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function sampleFetch(url) {
  const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)/u.exec(String(url));
  if (match === null || `${match[1]}/${match[2]}` !== TARGET) return response(404, { message: 'Not Found' });

  const file = decodeURIComponent(match[3]).replace(/^\.\//u, '');
  const full = path.resolve(SAMPLE, file);
  // Keep the fake server inside the checked-in folder, even if a manifest ever
  // points at a path outside it.
  if (full.startsWith(`${SAMPLE}${path.sep}`) === false || fs.existsSync(full) === false) {
    return response(404, { message: 'Not Found' });
  }
  if (fs.statSync(full).isFile() === false) return response(404, { message: 'Not Found' });
  return response(200, {
    encoding: 'base64',
    content: fs.readFileSync(full).toString('base64'),
  });
}

const lines = [];
const io = {
  log: (line) => lines.push(String(line)),
  error: (line) => lines.push(String(line)),
};

const code = await run(['audit', '--remote', TARGET, '--host', HOST], io, {
  fetchImpl: sampleFetch,
  token: null,
});
if (code !== 1) {
  throw new Error(`the compatibility sample answered ${code}; the documented incompatible answer exits 1`);
}
console.log(lines.join('\n'));
