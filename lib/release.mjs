/**
 * The release sequence, as a function instead of a checklist in my head.
 *
 * Order matters: verify the manifest first (cheap), then tag, then wait for the
 * registry, then touch the index — the index entry carries the publish time the
 * registry reported, so writing it earlier would mean guessing.
 */
import { commandFailureDetail, run as runCommand } from './exec.mjs';
import fs from 'node:fs';
import path from 'node:path';

import { doctor } from './doctor.mjs';
import { expandHome, resolvePath } from './paths.mjs';
import { addVersion, buildEntry, readIndex, writeIndex } from './index-file.mjs';
import { publishedAt, waitForVersion } from './registry.mjs';
import { defaultGh, mergePr, openIndexPr, waitForChecks } from './pr.mjs';

function publishPackage(dir) {
  runCommand('npm', ['publish'], { cwd: dir, stdio: 'pipe' });
}

function git(dir, args) {
  // stderr is dropped on purpose: `rev-parse` on a tag that does not exist yet is
  // an expected miss, and git prints "fatal: ambiguous argument" for it, which
  // reads like a failure in the middle of a successful release.
  return runCommand('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The object this checkout's tag names, or null when it cannot be read. */
function localTagObject(run, tag) {
  try {
    return run(['rev-parse', `refs/tags/${tag}`]);
  } catch {
    return null;
  }
}

/**
 * The object `origin` advertises for this tag, or null when origin has no such
 * tag (or cannot be read). `ls-remote` asks the remote directly without
 * fetching, which is what lets a failed push be checked against the state it
 * may already have written.
 */
function remoteTagObject(run, tag) {
  try {
    const output = String(run(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]) ?? '');
    const ref = `refs/tags/${tag}`;
    for (const line of output.split('\n')) {
      const [object, name] = line.trim().split('\t');
      if (name === ref && object !== undefined && object !== '') return object;
    }
    return null;
  } catch {
    return null;
  }
}

export function tagName(version, prefix = 'plugin-v') {
  return `${prefix}${version}`;
}

export function tagExists(dir, tag, run) {
  try {
    (run ?? ((args) => git(dir, args)))(['rev-parse', `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
}

/** The commit a tag names, or null when it cannot be resolved. */
export function tagCommit(dir, tag, run) {
  const runGit = run ?? ((args) => git(dir, args));
  try {
    // `^{commit}` resolves an annotated tag to the commit it points at.
    return runGit(['rev-parse', `refs/tags/${tag}^{commit}`]);
  } catch {
    try {
      return runGit(['rev-parse', `refs/tags/${tag}`]);
    } catch {
      return null;
    }
  }
}

/** The current HEAD commit, or null when it cannot be resolved. */
export function headCommit(dir, run) {
  const runGit = run ?? ((args) => git(dir, args));
  try {
    return runGit(['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

/**
 * True when the tag exists and names the same commit as HEAD. A re-run after a
 * failure has to be able to finish the release without moving the tag: the tag
 * is what started the publish, so recreating it would be both unnecessary and
 * wrong.
 */
export function tagPointsAtHead(dir, tag, run) {
  const runGit = run ?? ((args) => git(dir, args));
  const head = headCommit(dir, runGit);
  if (head === null) return false;
  return tagCommit(dir, tag, runGit) === head;
}

export function workingTreeIsClean(dir, run) {
  return (run ?? ((args) => git(dir, args)))(['status', '--porcelain']) === '';
}

/**
 * True when the index file has a staged, unstaged, or untracked change.
 *
 * "The index already carries the version" and "the index has nothing to
 * commit" are different states: a run without `--pr` writes the entry and
 * leaves it uncommitted, and a later `--pr` run must carry that entry into the
 * pull request rather than skipping it as a no-op.
 */
function indexHasChanges(dir, indexFile, run) {
  try {
    const status = (run ?? ((args) => git(dir, args)))(['status', '--porcelain', '--', indexFile]);
    return status !== '';
  } catch {
    // If git cannot answer, do not claim there is nothing to commit: let the PR
    // sequence report the real failure instead of silently dropping the entry.
    return true;
  }
}

/** True when the repository has a remote with this name. */
function hasRemote(dir, name, run) {
  try {
    (run ?? ((args) => git(dir, args)))(['remote', 'get-url', name]);
    return true;
  } catch {
    return false;
  }
}

/** The paths git would carry into the tag, so the message can name them. */
export function dirtyPaths(dir, limit = 3, run) {
  const status = (run ?? ((args) => git(dir, args)))(['status', '--porcelain']);
  if (status === '') return [];
  const paths = status.split('\n').map((line) => line.slice(3).trim()).filter((line) => line !== '');
  return paths.slice(0, limit);
}

/**
 * Steps a human must do, and steps the tool can do. Returning this list before
 * anything runs is what makes `--dry-run` useful: it shows the whole sequence
 * and the exact commands.
 */
export function plan({ dir = process.cwd(), version, name, tagPrefix = 'plugin-v', indexFile = 'market/index.json', marketDir }) {
  const report = doctor(resolvePath(dir));
  const resolvedName = name ?? report.manifest.name ?? 'this-plugin';
  const resolvedVersion = version ?? report.manifest.version ?? '0.0.0';
  const tag = tagName(resolvedVersion, tagPrefix);
  const steps = [
    { title: 'Read the manifest and check it can be loaded', command: 'dsh-plugin doctor', runs: true },
    { title: `Create the tag ${tag}`, command: `git tag ${tag}`, runs: true },
    { title: 'Push the tag, which starts the release workflow', command: `git push origin ${tag}`, runs: true },
    { title: `Wait until the registry serves ${resolvedName}@${resolvedVersion}`, command: `GET /${resolvedName}`, runs: true },
    {
      title: marketDir === undefined
        ? 'Write the version into the market index, with the publish time the registry reported'
        : `Write the version into the market index at ${marketDir}`,
      command: `patch ${path.join(marketDir ?? '', indexFile)}`,
      runs: true,
    },
    { title: 'Open the index pull request', command: 'gh pr create', runs: false },
    { title: 'Re-read the live index and confirm the version is listed', command: 'GET market/index.json', runs: false },
  ];
  return { tag, name: resolvedName, version: resolvedVersion, indexFile, steps };
}

export async function release(options) {
  const {
    dir = process.cwd(),
    registry,
    tagPrefix = 'plugin-v',
    indexFile = 'market/index.json',
    marketDir,
    budgetMs,
    intervalMs,
    sleep,
    now,
    onChange,
  } = options;

  const root = resolvePath(dir);
  const indexPathFile = expandHome(indexFile);
  const gitRun = options.git ?? ((args) => git(root, args));

  let report;
  try {
    report = doctor(root);
  } catch (error) {
    // A folder without package.json is a preflight failure, not a crash: the
    // command's job is to say what is wrong, and a stack trace is not an answer.
    return { ok: false, stage: 'preflight', failures: [{ check: 'manifest', message: error.message }] };
  }
  if (report.failures.length > 0) {
    return { ok: false, stage: 'preflight', failures: report.failures };
  }

  const name = report.manifest.name;
  const version = report.manifest.version;
  const tag = tagName(version, tagPrefix);

  const resuming = tagExists(root, tag, gitRun) === true;
  if (resuming === true && tagPointsAtHead(root, tag, gitRun) === false) {
    // A tag at another commit is not a resume: moving it would rewrite what the
    // earlier release published. Name where it points, where HEAD is, and the
    // exact commands that remove it so the next attempt can tag this commit.
    const target = tagCommit(root, tag, gitRun);
    const head = headCommit(root, gitRun);
    const targetText = target ?? 'an unknown commit';
    const headText = head ?? 'an unknown commit';
    return {
      ok: false,
      stage: 'tag',
      failures: [{
        check: 'tag',
        message: `${tag} already exists and does not point at HEAD: tag ${tag} is at ${targetText}, HEAD is ${headText}. Delete the stale tag with \`git tag -d ${tag}\` and \`git push --delete origin ${tag}\`, then re-run release.`,
      }],
    };
  }

  // Push the tag even when reusing an existing one. The local tag may be the
  // only copy: the previous attempt can have failed at `git push` after
  // creating it. A push of a tag that is already on the remote at the same
  // commit is a no-op, so this is safe to repeat and is what lets a retry
  // finish the release instead of reporting success while origin still has no
  // tag. A checkout with no origin has nowhere to push, so it keeps the old
  // local resume behavior.
  const pushTag = () => {
    try {
      gitRun(['push', 'origin', tag]);
      return null;
    } catch (error) {
      const detail = commandFailureDetail(error);
      // A push can exit non-zero after the remote already updated the ref (a
      // post-receive hook, a dropped connection after receive-pack replied).
      // The release's goal is the tag on origin, so ask origin what it has
      // instead of treating every non-zero exit as "not pushed".
      const localObject = localTagObject(gitRun, tag);
      const remoteObject = remoteTagObject(gitRun, tag);
      if (localObject !== null && remoteObject !== null && localObject === remoteObject) {
        return null;
      }
      if (localObject !== null && remoteObject !== null) {
        // The name is taken by a different object. Re-running cannot fix this,
        // so name both tags and leave the decision to the user: moving a
        // published tag silently would rewrite what the earlier release said.
        return {
          ok: false,
          stage: 'git',
          failures: [{
            check: 'git',
            message: `could not run \`git push origin ${tag}\`: ${detail}. origin already has ${tag} at ${remoteObject}, but this checkout's tag is at ${localObject}; neither tag was moved. Delete the tag you do not want and re-run release.`,
          }],
        };
      }
      // Keep the failure in the release's own vocabulary. Letting the raw
      // execFileSync error escape hides both the stage and the fact that the
      // tag now exists only locally, which is exactly what the retry needs.
      return {
        ok: false,
        stage: 'git',
        failures: [{
          check: 'git',
          message: `could not run \`git push origin ${tag}\`: ${detail} The tag is still local; fix the remote and re-run release to push it.`,
        }],
      };
    }
  };

  if (resuming === false) {
    // A resume does not create a tag, so the clean-tree rule that protects the
    // tag does not apply: the index write from a previous attempt is allowed to
    // be the only uncommitted change.
    if (workingTreeIsClean(root, gitRun) === false) {
      const dirty = dirtyPaths(root, 3, gitRun);
      const listed = dirty.length > 0 ? ` (${dirty.join(', ')})` : '';
      return {
        ok: false,
        stage: 'git',
        failures: [{ check: 'git', message: `the working tree has uncommitted changes${listed}` }],
      };
    }

    try {
      gitRun(['tag', tag]);
    } catch (error) {
      return {
        ok: false,
        stage: 'git',
        failures: [{
          check: 'git',
          message: `could not run \`git tag ${tag}\`: ${commandFailureDetail(error)}`,
        }],
      };
    }
    const failedPush = pushTag();
    if (failedPush !== null) return failedPush;
  } else if (hasRemote(root, 'origin', gitRun) === true) {
    const failedPush = pushTag();
    if (failedPush !== null) return failedPush;
  }

  // Not every plugin publishes from CI. `--publish` runs the publish here, so
  // the same command covers both kinds of repository.
  if (options.publish === true) {
    try {
      (options.publishPackage ?? publishPackage)(root);
    } catch (error) {
      const detail = String(error.stderr ?? error.message).trim().split('\n').slice(-1)[0];
      return { ok: false, stage: 'publish', failures: [{ check: 'publish', message: `npm publish failed: ${detail}` }] };
    }
  }

  const waited = await waitForVersion(name, version, {
    // Wait for the publish *time* as well: `versions` can appear a moment before
    // `time`, and an index entry with a null timestamp fails the market checker.
    requireTime: true,
    // Forwarded so a caller (and the tests) can answer instead of npm.
    fetch: options.fetch,
    registry,
    budgetMs,
    intervalMs,
    sleep,
    now,
    onWait: options.onWait,
  });
  if (waited.missingPackage === true) {
    return {
      ok: false,
      stage: 'registry',
      failures: [
        {
          check: 'registry',
          message: `the registry has no package named ${name} (tag ${tag} is pushed; publish it, then re-run)`,
        },
      ],
    };
  }
  if (waited.timedOut === true) {
    return {
      ok: false,
      stage: 'registry',
      failures: [
        {
          check: 'registry',
          message: `${name}@${version} is not on the registry after ${Math.round(waited.waitedMs / 1000)}s (tag ${tag} is pushed; re-run when npm catches up)`,
        },
      ],
    };
  }

  const timestamp = publishedAt(waited.document, version);
  // Building the entry can fail before the index is even read (a malformed
  // `engines.dsh` is normally caught by doctor, but a caller that reaches this
  // point must still get a result, not an exception). Keep the failure in the
  // same `index` stage as an `addVersion` rejection and never write anything.
  let entry;
  try {
    entry = buildEntry({ version, publishTimestamp: timestamp, hostRange: report.notes.hostRange });
  } catch (error) {
    return { ok: false, stage: 'index', failures: [{ check: 'index', message: error.message }] };
  }
  // Most plugins are listed in someone else's index: `--market` points at a
  // checkout of that repository, and the entry plus the pull request land there.
  const indexRoot = typeof marketDir === 'string' && marketDir.length > 0 ? resolvePath(marketDir) : root;
  const indexPath = path.join(indexRoot, indexPathFile);
  let indexUpdate = null;
  if (fs.existsSync(indexPath) === true) {
    try {
      const before = readIndex(indexPath);
      const after = addVersion(before, name, entry);
      if (after !== before) {
        writeIndex(indexPath, after);
        indexUpdate = { file: indexPath, version, entry };
        if (typeof onChange === 'function') onChange(indexUpdate);
      } else {
        indexUpdate = { file: indexPath, version, entry, unchanged: true };
      }
    } catch (error) {
      return { ok: false, stage: 'index', failures: [{ check: 'index', message: error.message }] };
    }
  }

  const result = {
    ok: true,
    stage: 'index',
    tag,
    version,
    attempts: waited.attempts,
    waitedMs: waited.waitedMs,
    indexUpdate,
  };

  // The index change is one line, but it still needs a branch, a pull request,
  // a green CI and a merge; doing that by hand is where "forgot to open the PR"
  // happens.
  const ghRunner = options.gh ?? defaultGh(indexRoot);
  const marketGit = options.marketGit ?? (indexRoot === root ? options.git : ((args) => git(indexRoot, args)));

  if (options.pr !== true || indexUpdate === null) return result;

  // An unchanged index is the resume path: a previous run already wrote the
  // same version with the same publish time. When that entry is committed there
  // is nothing to commit, so opening a branch would fail at `git commit` and
  // leave a branch behind for a release that is already finished. An entry
  // written by a run without `--pr` is still uncommitted, so it must go through
  // the PR sequence even though this run did not change the file again.
  // Git accepts `/` on every platform; `path.relative` uses `\` on Windows and
  // a backslash in a pathspec is an escape, so normalise before passing it on.
  const indexPathForGit = (path.relative(indexRoot, indexPath) || indexPathFile).split(path.sep).join('/');
  if (indexUpdate.unchanged === true && indexHasChanges(indexRoot, indexPathForGit, marketGit) === false) return result;

  const pull = await openIndexPr({
    dir: indexRoot,
    git: marketGit,
    indexFile: indexPathFile,
    version,
    base: options.base ?? 'main',
    branch: options.branch,
    title: options.prTitle,
    body: options.prBody,
    gh: ghRunner,
    onStep: options.onStep,
  });
  result.pullRequest = pull;
  if (pull.ok !== true) {
    return { ...result, ok: false, stage: `pr:${pull.stage}`, failures: [{ check: 'pr', message: pull.reason }] };
  }

  if (options.merge !== true) return result;

  const checks = await waitForChecks({
    url: pull.url,
    gh: ghRunner,
    budgetMs: options.checksBudgetMs,
    intervalMs: options.checksIntervalMs,
    sleep: options.sleep,
    now: options.now,
    onWait: options.onChecks,
  });
  result.checks = checks;
  if (checks.ok !== true) {
    return { ...result, ok: false, stage: 'checks', failures: [{ check: 'checks', message: checks.reason }] };
  }

  const merged = await mergePr({ url: pull.url, gh: ghRunner, method: options.mergeMethod });
  result.merged = merged;
  if (merged.ok !== true) {
    return { ...result, ok: false, stage: 'merge', failures: [{ check: 'merge', message: merged.reason }] };
  }
  return { ...result, stage: 'merged' };
}
