/**
 * The last mile of a release: the index change is one line, but it still needs a
 * branch, a pull request, a green CI, and a merge.
 *
 * Every side effect goes through an injected runner, so the sequence can be
 * asserted without a network, a repository, or a `gh` login.
 */
import { commandFailureDetail, run } from './exec.mjs';

// stderr is piped, not inherited: git's "fatal: ambiguous argument" for a tag
// that does not exist yet and gh's "no checks reported" both arrive there, and
// both are expected misses that must not read as failures — but they still have
// to be readable by the caller.
export function defaultGit(dir) {
  return (args) => run('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function defaultGh(dir) {
  return (args) => run('gh', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function branchName(version, prefix = 'market/') {
  return `${prefix}${version}`;
}

/**
 * Commit the index on its own branch, push it, and open the pull request.
 * Returns `{ok, branch, url}` or `{ok:false, stage, reason}`.
 */
export async function openIndexPr(options) {
  const {
    dir,
    indexFile,
    version,
    base = 'main',
    branch = branchName(version),
    git = defaultGit(dir),
    gh = defaultGh(dir),
    title,
    body,
    onStep,
  } = options;
  const step = (name) => {
    if (typeof onStep === 'function') onStep(name);
  };

  try {
    step('branch');
    git(['checkout', '-b', branch]);
  } catch {
    // An existing branch means a previous run got this far; reuse it rather than
    // failing on the one step that is safe to repeat.
    try {
      git(['checkout', branch]);
    } catch (error) {
      return { ok: false, stage: 'branch', reason: `could not create or check out ${branch}: ${error.message}` };
    }
  }

  try {
    step('commit');
    git(['add', indexFile]);
    git(['commit', '-m', `market: ${version}`]);
  } catch (error) {
    return { ok: false, stage: 'commit', reason: error.message };
  }

  try {
    step('push');
    git(['push', '-u', 'origin', branch]);
  } catch (error) {
    return { ok: false, stage: 'push', reason: `could not push ${branch} to origin: ${commandFailureDetail(error)}` };
  }

  try {
    step('pr');
    const url = gh([
      'pr',
      'create',
      '--base',
      base,
      '--head',
      branch,
      '--title',
      title ?? `market: ${version}`,
      '--body',
      body ?? `Adds ${version} to the market index, with the publish time the registry reported.`,
    ]);
    return { ok: true, branch, url: url.split('\n').pop() ?? url };
  } catch (error) {
    return { ok: false, stage: 'pr', reason: error.message };
  }
}

/** Poll `gh pr checks` until every check has settled. */
export async function waitForChecks(options) {
  const {
    url,
    gh,
    budgetMs = 30 * 60 * 1000,
    intervalMs = 20 * 1000,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onWait,
  } = options;
  const started = now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    let output = '';
    try {
      output = gh(['pr', 'checks', url, '--json', 'state', '--jq', '.[].state']);
    } catch (error) {
      // `gh pr checks` exits non-zero while checks are still pending, and also
      // when the repository has no CI at all — the second case is not a wait.
      output = String(error.stdout ?? '');
      // `gh` writes "no checks reported on the 'x' branch" to stdout and exits 1.
      const message = `${error.message ?? ''}${error.stdout ?? ''}${error.stderr ?? ''}`;
      if (/no checks reported/i.test(message) === true) {
        return { ok: true, attempts, waitedMs: now() - started, states: [], noChecks: true };
      }
    }
    const states = output.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    const pending = states.filter((state) => ['PENDING', 'QUEUED', 'IN_PROGRESS', ''].includes(state));
    const failed = states.filter((state) => ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(state));
    if (failed.length > 0) return { ok: false, attempts, waitedMs: now() - started, states, reason: `${failed.length} check(s) failed` };
    if (states.length > 0 && pending.length === 0) return { ok: true, attempts, waitedMs: now() - started, states };
    if (now() - started >= budgetMs) {
      return { ok: false, attempts, waitedMs: now() - started, states, timedOut: true, reason: 'checks did not settle in time' };
    }
    if (typeof onWait === 'function') onWait({ attempts, waitedMs: now() - started, states });
    await sleep(intervalMs);
  }
}

export async function mergePr(options) {
  const { url, gh, method = 'squash' } = options;
  try {
    gh(['pr', 'merge', url, `--${method}`]);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}
