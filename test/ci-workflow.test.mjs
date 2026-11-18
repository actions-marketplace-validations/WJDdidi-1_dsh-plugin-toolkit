import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// actions/checkout on Windows can hand this file back with CRLF line endings.
// Normalise first so the job parser below finds the same markers on every OS.
const workflow = fs
  .readFileSync(path.join(here, '..', '.github', 'workflows', 'ci.yml'), 'utf8')
  .replace(/\r\n/gu, '\n');

/** The text of one two-space-indented job, without the jobs that follow it. */
function job(name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) return null;
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/\n  [A-Za-z0-9_-]+:\n/u);
  return next === -1 ? rest : rest.slice(0, next);
}

test('the arm64 leg runs where a runner can actually be acquired', () => {
  const arm = job('linux-arm64');
  assert.ok(arm !== null, 'ci.yml keeps a dedicated arm64 job');
  assert.match(arm, /runs-on: ubuntu-24\.04-arm/u);
  assert.match(arm, /run: npm test/u);

  // Asking for an arm64 label is not the same as getting one. The job proves
  // its architecture, and the gate treats an unproven architecture as a
  // failure, so "arm64 coverage" cannot quietly become an x64 run.
  assert.match(arm, /id: arch/u);
  assert.match(arm, /node -p 'process\.arch'/u);

  // Hosted macOS arm64 jobs that never acquire a runner are cancelled, and a
  // cancelled job fails the workflow even with continue-on-error. Do not put
  // the arm64 leg back on that pool, and do not paper over it with an escape
  // hatch that cannot work when no runner starts.
  assert.doesNotMatch(arm, /runs-on: macos-(?:latest|15|26)\b/u);
  assert.doesNotMatch(arm, /continue-on-error:/u);
});

test('the arm64 gate still refuses a leg that started but did not finish its tests', () => {
  const gate = job('arm64-gate');
  assert.ok(gate !== null, 'the required arm64 check keeps its name');
  assert.match(gate, /name: arm64 job did not hide a test failure/u);
  assert.match(gate, /needs: linux-arm64/u);
  assert.match(gate, /RUNNER_OUTCOME: \$\{\{ needs\.linux-arm64\.outputs\.runner \}\}/u);
  assert.match(gate, /ARCH_OUTCOME: \$\{\{ needs\.linux-arm64\.outputs\.arch \}\}/u);
  assert.match(gate, /TESTS_OUTCOME: \$\{\{ needs\.linux-arm64\.outputs\.tests \}\}/u);
});

test('the macOS matrix keeps the Intel image the release policy requires', () => {
  assert.match(workflow, /os: \[ubuntu-latest, macos-15-intel, windows-latest\]/u);
  assert.match(workflow, /node: \[18, 20, 22\]/u);
});
