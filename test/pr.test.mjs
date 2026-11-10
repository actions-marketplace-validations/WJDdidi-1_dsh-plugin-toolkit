import assert from 'node:assert/strict';
import test from 'node:test';

import { branchName, mergePr, openIndexPr, waitForChecks } from '../lib/pr.mjs';

function recorder() {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    return '';
  };
  return { calls, run };
}

test('the index change gets a branch of its own, named after the version', async () => {
  assert.equal(branchName('1.2.3'), 'market/1.2.3');
  const git = recorder();
  const gh = recorder();
  gh.run = (args) => {
    gh.calls.push(args.join(' '));
    return 'https://github.com/o/r/pull/7';
  };

  const result = await openIndexPr({ dir: '.', indexFile: 'market/index.json', version: '1.2.3', git: git.run, gh: gh.run });

  assert.equal(result.ok, true);
  assert.equal(result.branch, 'market/1.2.3');
  assert.equal(result.url, 'https://github.com/o/r/pull/7');
  assert.deepEqual(git.calls, [
    'checkout -b market/1.2.3',
    'add market/index.json',
    'commit -m market: 1.2.3',
    'push -u origin market/1.2.3',
  ]);
  assert.match(gh.calls[0], /^pr create --base main --head market\/1\.2\.3 --title market: 1\.2\.3 --body /);
});

test('an existing branch is reused instead of failing the one step that is safe to repeat', async () => {
  const calls = [];
  const git = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'checkout' && args[1] === '-b') throw new Error('already exists');
    return '';
  };
  const gh = () => 'https://example.test/pr/1';

  const result = await openIndexPr({ dir: '.', indexFile: 'market/index.json', version: '0.0.2', git, gh });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.slice(0, 2), ['checkout -b market/0.0.2', 'checkout market/0.0.2']);
});

test('a failed push stops before opening a pull request', async () => {
  const git = (args) => {
    if (args[0] === 'push') throw new Error('rejected');
    return '';
  };
  let prCalls = 0;
  const gh = () => {
    prCalls += 1;
    return 'url';
  };

  const result = await openIndexPr({ dir: '.', indexFile: 'market/index.json', version: '0.0.3', git, gh });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'push');
  assert.match(result.reason, /rejected/);
  assert.equal(prCalls, 0);
});

test('checks are waited on until they settle, and a failure is reported not retried', async () => {
  const pending = () => {
    const error = new Error('pending');
    error.stdout = 'PENDING\nSUCCESS';
    throw error;
  };
  const settled = () => 'SUCCESS\nSUCCESS';
  const sequence = [pending, settled];
  let index = 0;
  const gh = () => sequence[Math.min(index++, sequence.length - 1)]();

  const ok = await waitForChecks({ url: 'https://example.test/pr/1', gh, sleep: async () => {}, intervalMs: 1, budgetMs: 60_000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.attempts, 2);

  const failing = await waitForChecks({
    url: 'https://example.test/pr/2',
    gh: () => 'SUCCESS\nFAILURE',
    sleep: async () => {},
    intervalMs: 1,
  });
  assert.equal(failing.ok, false);
  assert.match(failing.reason, /1 check\(s\) failed/);
});

test('merge is attempted only after the caller saw green checks', async () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    return '';
  };
  const merged = await mergePr({ url: 'https://example.test/pr/1', gh });
  assert.equal(merged.ok, true);
  assert.deepEqual(calls, ['pr merge https://example.test/pr/1 --squash']);
});

test('a release with --pr stops at the pull request, and with --merge goes to merged', async () => {
  const { release } = await import('../lib/release.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'demo-plugin', version: '2.0.0', files: ['index.js', 'client.js', 'cordis.patch.yml'],
    engines: { dsh: '>=0.2.0' },
    exports: { './client': './client.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n\n## Requirements\n\n| Harness |\n| --- |\n| `>=0.2.0` |\n');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert: []\n');
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply() {}\n');
  fs.writeFileSync(path.join(dir, 'client.js'), 'window.__ModuleLoader__.load({ id: "x", factory: () => ({}) });\n');
  fs.mkdirSync(path.join(dir, 'market'));
  fs.writeFileSync(path.join(dir, 'market/index.json'), JSON.stringify({
    format: 1, plugins: [{ name: 'demo-plugin', versions: [] }],
  }, null, 2));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'init'], { cwd: dir });

  const document = { versions: { '2.0.0': {} }, time: { '2.0.0': '2026-10-31T02:00:00.000Z' } };
  // Each scenario starts before the release wrote the entry: a repeated release
  // with an unchanged index deliberately stops before the PR sequence.
  const resetIndex = () => {
    fs.writeFileSync(path.join(dir, 'market/index.json'), JSON.stringify({
      format: 1, plugins: [{ name: 'demo-plugin', versions: [] }],
    }, null, 2));
  };
  const gitCalls = [];
  const git = (args) => {
    gitCalls.push(args.join(' '));
    if (args[0] === 'rev-parse') throw new Error('missing');
    return '';
  };
  const ghCalls = [];
  const gh = (args) => {
    ghCalls.push(args.join(' '));
    if (args[0] === 'pr' && args[1] === 'create') return 'https://example.test/pr/9';
    if (args[0] === 'pr' && args[1] === 'checks') return 'SUCCESS';
    return '';
  };

  const withoutPr = await release({
    dir, indexFile: 'market/index.json', git, gh,
    fetch: async () => ({ status: 200, ok: true, json: async () => document }),
    sleep: async () => {},
  });
  assert.equal(withoutPr.ok, true);
  assert.equal(withoutPr.pullRequest, undefined);
  assert.equal(ghCalls.length, 0);

  resetIndex();
  const prOnly = await release({
    dir, indexFile: 'market/index.json', pr: true, git, gh,
    fetch: async () => ({ status: 200, ok: true, json: async () => document }),
    sleep: async () => {},
  });
  assert.equal(prOnly.ok, true);
  assert.equal(prOnly.pullRequest.url, 'https://example.test/pr/9');
  assert.equal(prOnly.merged, undefined);

  resetIndex();
  const merged = await release({
    dir, indexFile: 'market/index.json', pr: true, merge: true, git, gh,
    fetch: async () => ({ status: 200, ok: true, json: async () => document }),
    sleep: async () => {},
  });
  assert.equal(merged.ok, true);
  assert.equal(merged.stage, 'merged');
  assert.equal(merged.merged.ok, true);
  assert.ok(ghCalls.some((call) => call.startsWith('pr merge https://example.test/pr/9')));
});

test('a repository without CI is settled, not waited on', async () => {
  const { waitForChecks } = await import('../lib/pr.mjs');
  const gh = () => {
    // `gh` prints this on stdout, and exits non-zero.
    const error = new Error('Command failed: gh pr checks');
    error.stdout = "no checks reported on the 'market/1.0.0' branch\n";
    throw error;
  };
  const result = await waitForChecks({ url: 'https://example.test/pr/3', gh, sleep: async () => {}, intervalMs: 1, budgetMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.noChecks, true);
  assert.equal(result.attempts, 1);
});
