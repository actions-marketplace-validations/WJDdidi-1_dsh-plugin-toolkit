#!/usr/bin/env node
/**
 * `dsh-plugin <command>` — small enough to read in one sitting, which is the
 * point: a release tool that hides what it does is worse than a checklist.
 */
import fs from 'node:fs';
import path from 'node:path';

import { doctor } from './doctor.mjs';
import { DEFAULT_ENGINES, doctorFix, fixEngines } from './fix.mjs';
import { auditRemote, fixRemote } from './remote.mjs';
import { expandHome, resolvePath } from './paths.mjs';
import { init } from './init.mjs';
import { verify } from './verify.mjs';
import { plan, release } from './release.mjs';
import { auditVersions, readIndex } from './index-file.mjs';
import { CAUSES, explain, lastCauseLine, verdict } from './explain.mjs';

export const HELP = `dsh-plugin — preflight and release DeepSeek Harness plugins

  dsh-plugin init <dir> --name <pkg>   scaffold a plugin that already passes doctor
      dsh-plugin init ./my-panel --name my-panel

  dsh-plugin doctor [dir]              check the manifest, README and bundle
      dsh-plugin doctor .

  dsh-plugin doctor --remote owner/repo   the same checks against a published repository
      dsh-plugin doctor --remote V1ki/dsh-plugin-subscriptions

  dsh-plugin doctor --fix [dir]        print the repair plan; write it only with --write
      dsh-plugin doctor --fix ./my-panel --write

  dsh-plugin fix <dir> --engines       print the host range doctor asks for; write it only with --write
      dsh-plugin fix ./my-panel --engines --write

  dsh-plugin fix <owner>/<repo> --remote   print the engines.dsh repair as a unified diff
      dsh-plugin fix V1ki/dsh-plugin-subscriptions --remote

  dsh-plugin fix <owner>/<repo> --remote --engines --host <version>   aim the range at the DSH that rejected it
      dsh-plugin fix V1ki/dsh-plugin-subscriptions --remote --engines --host 0.3.0

  dsh-plugin fix <owner>/<repo> --remote --patch <file>   save that diff for a checkout
      dsh-plugin fix V1ki/dsh-plugin-subscriptions --remote --patch repair.patch

  dsh-plugin explain "<error>" [dir]   map an install error to the check that finds its cause
      dsh-plugin explain "plugin install failed" ./my-panel

  dsh-plugin explain --log <file> [dir]  read a log and explain its last known failure
      dsh-plugin explain --log ~/.dsh/logs/install.log ./my-panel

  dsh-plugin verify [dir]              pack it, install the tarball, mount the installed panel
      dsh-plugin verify .

  dsh-plugin mount <client.js>         render a client bundle in Node and print what a user would see
      dsh-plugin mount ./client.js --html

  dsh-plugin audit [flags]              every installed plugin: valid, and loaded by the running app
      dsh-plugin audit --host http://127.0.0.1:54133
      dsh-plugin audit --home '~/.dsh'      the profile home; both tilde spellings expand

  dsh-plugin audit --remote --from <file>   audit a list and print one line per repository
      dsh-plugin audit --remote --from repos.txt
      dsh-plugin audit --remote --from -       the same list on standard input

  dsh-plugin audit --remote --from <file> --jobs <n>   read several repositories at once
      dsh-plugin audit --remote --from repos.txt --jobs 6
      a 403/429 stops the batch; unread entries print as rate-limited with the reset time

  dsh-plugin audit --remote --from <file> --patch-dir <dir>   save one repair per repository
      dsh-plugin audit --remote --from repos.txt --patch-dir repairs/

  dsh-plugin audit --remote --from <file> --host <version>   will every range accept the host you run?
      dsh-plugin audit --remote --from repos.txt --host 0.2.2-alpha.3

  dsh-plugin audit --remote <list> --json   machine-readable findings for owner/repo,owner/repo
      dsh-plugin audit --remote V1ki/dsh-plugin-subscriptions,demo/plugin --json

  dsh-plugin audit --remote <owner/repo> --host <version>   will it install on the host you run?
      dsh-plugin audit --remote V1ki/dsh-plugin-subscriptions --host 0.2.0

  dsh-plugin dev [dir] [flags]         copy a rebuilt bundle into the installed plugin and confirm the reload
      dsh-plugin dev . --host http://127.0.0.1:54133

  dsh-plugin release [dir] [flags]     tag, wait for npm, update the market index, open the PR
      dsh-plugin release . --pr --merge

  dsh-plugin index [dir]               audit every version in market/index.json
      dsh-plugin index market/index.json

Flags
  --dry-run                 show the steps without touching anything
  --fix                     with doctor: print the repair plan; write it only with --write
  --engines                 with fix: repair the host range in package.json
  --write                   with fix: write the change instead of only printing it
  --range <range>           with fix or doctor --fix: the range to write, default ${DEFAULT_ENGINES}
  --patch <file>            with fix --remote: write the diff to <file>, creating parent directories
  --log <file>              with explain: read a log and find its last known failure
  --remote <list>           with doctor: one owner/repo; with fix: one owner/repo, read-only on GitHub; with audit: owner/repo,owner/repo
  --from <file>             with audit --remote: read owner/repo entries from <file>, one per line; - means standard input
  --jobs <n>                with audit --remote: read n repositories at once, default 4, capped at 8
  --patch-dir <dir>         with audit --remote: write one .patch per repository that needs a repair
  --host <value>            with audit: the running app URL; with audit --remote or fix: the DSH version to compare or aim at
  --json                    with audit --remote: print the findings as JSON, one object per repository
  --index <path>            index file, default market/index.json
  --market <dir>            with release: a checkout of the repository that holds the index
  --publish                 with release: run npm publish here, for repos without a publish workflow
  --tag-prefix <prefix>     default plugin-v
  --budget <seconds>        how long to wait for npm, a positive number, default 480
  --pr                      commit the index on a branch, push it, open the pull request
  --merge                   with --pr: wait for checks, then squash-merge
  --home <dir>              with audit: the profile home to scan, default ~/.dsh
  --base <branch>           base branch for the pull request, default main
  --name <package-name>     with init: the npm name, required
  --title <text>            with init: the tab title, default "My panel"
  --force                   with init: write into a directory that is not empty; with fix --remote --patch or audit --patch-dir: overwrite an existing patch file
`;

function flags(argv) {
  const parsed = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run') parsed.dryRun = true;
    else if (token === '--engines') parsed.engines = true;
    else if (token === '--fix') parsed.fix = true;
    else if (token === '--write') parsed.write = true;
    else if (token === '--range') parsed.range = argv[++index];
    else if (token === '--patch') {
      // Leave the value blank when the next token is another flag; the fix
      // branch reports the missing path instead of swallowing that flag.
      const next = argv[index + 1];
      parsed.patch = next === undefined || next.startsWith('--') === true ? '' : argv[++index];
    }
    else if (token === '--log') parsed.log = argv[++index];
    else if (token === '--index') parsed.index = argv[++index];
    else if (token === '--tag-prefix') parsed.tagPrefix = argv[++index];
    else if (token === '--budget') {
      // A budget of `8m`, `0`, or `-1` is not a wait, and by the time the
      // registry loop notices, the tag is already pushed. Validate the flag
      // here, before any command can reach `git tag`.
      const raw = argv[++index];
      const seconds = Number(raw);
      if (raw === undefined || String(raw).trim() === '' || Number.isFinite(seconds) === false || seconds <= 0) {
        parsed.budgetError = raw;
      } else {
        parsed.budget = seconds;
      }
    }
    else if (token === '--slot') parsed.slot = argv[++index];
    else if (token === '--surface') parsed.surface = argv[++index];
    else if (token === '--html') parsed.html = true;
    else if (token === '--name') parsed.name = argv[++index];
    else if (token === '--title') parsed.title = argv[++index];
    else if (token === '--force') parsed.force = true;
    else if (token === '--no-mount') parsed.noMount = true;
    else if (token === '--dest') parsed.dest = argv[++index];
    else if (token === '--entry') parsed.entry = argv[++index];
    else if (token === '--build') parsed.build = argv[++index];
    else if (token === '--host') parsed.host = argv[++index];
    else if (token === '--jobs') {
      // A missing value is invalid, not a silent fall back to the default; the
      // audit branch names the flag in the error.
      const next = argv[index + 1];
      parsed.jobs = next === undefined || next.startsWith('--') === true ? '' : argv[++index];
    }
    else if (token === '--from') {
      // Leave the value blank when the next token is another flag; the audit
      // branch reports the missing path instead of swallowing that flag.
      const next = argv[index + 1];
      parsed.from = next === undefined || next.startsWith('--') === true ? '' : argv[++index];
    }
    else if (token === '--patch-dir') {
      // Same rule as --patch: a bare flag is a missing path, not permission to
      // swallow the next option.
      const next = argv[index + 1];
      parsed.patchDir = next === undefined || next.startsWith('--') === true ? '' : argv[++index];
    }
    else if (token === '--remote') {
      // `fix <owner>/<repo> --remote` puts the target first and leaves the flag
      // without a value, so a following flag (or the end of the line) means
      // "remote; use the positional target". Otherwise the value is the target,
      // or another entry in an audit list.
      const next = argv[index + 1];
      const value = next === undefined || next.startsWith('--') === true ? true : argv[++index];
      if (parsed.remote === undefined) parsed.remote = value;
      else if (value !== true) parsed.remote = parsed.remote === true ? value : `${parsed.remote},${value}`;
    } else if (token === '--json') parsed.json = true;
    else if (token === '--once') parsed.once = true;
    else if (token === '--debounce') parsed.debounce = Number(argv[++index]);
    else if (token === '--timeout') parsed.timeout = Number(argv[++index]);
    else if (token === '--pr') parsed.pr = true;
    else if (token === '--merge') parsed.merge = true;
    else if (token === '--publish') parsed.publish = true;
    else if (token === '--home') {
      // Like every other path flag: a bare `--home` is a missing path, not
      // permission to swallow the next option. Otherwise `audit --home
      // --timeout 50` would scan a folder literally named `--timeout` and
      // report "no plugins installed" with exit 0.
      const next = argv[index + 1];
      parsed.home = next === undefined || next.startsWith('--') === true ? '' : argv[++index];
    }
    else if (token === '--base') parsed.base = argv[++index];
    else if (token === '--market') parsed.market = argv[++index];
    else if (token.startsWith('--') === true) throw new Error(`unknown flag ${token}`);
    else parsed.positional.push(token);
  }
  return parsed;
}

/** `--remote owner/repo` and `owner/repo --remote` both name one target. */
function remoteTarget(options) {
  if (typeof options.remote === 'string') return options.remote.trim();
  const positional = options.positional[0];
  return typeof positional === 'string' ? positional.trim() : '';
}

function printFailures(failures, io = console) {
  for (const failure of failures) {
    io.error(`  ✗ ${failure.check}: ${failure.message}`);
  }
}

export async function run(argv, io = console, deps = {}) {
  const [command, ...rest] = argv;
  const options = flags(rest);
  const dir = resolvePath(options.positional[0] ?? '.');

  // `--budget` is validated while parsing, so an invalid value stops here:
  // before the release sequence reads the manifest, tags, or pushes anything.
  if (Object.prototype.hasOwnProperty.call(options, 'budgetError') === true) {
    const got = options.budgetError === undefined ? 'nothing' : JSON.stringify(options.budgetError);
    io.error(`dsh-plugin: --budget needs a positive number of seconds, got ${got}`);
    return 2;
  }

  if (command === undefined || command === 'help' || command === '--help') {
    io.log(HELP);
    return 0;
  }

  if (command === 'doctor' && options.remote !== undefined) {
    if (options.fix === true) {
      io.error('dsh-plugin doctor --fix: --remote is read-only, so it cannot repair; run --fix against a checkout');
      return 2;
    }
    const target = remoteTarget(options);
    if (target === '') {
      io.error('dsh-plugin doctor --remote needs owner/repo, for example: doctor --remote V1ki/dsh-plugin-subscriptions');
      return 2;
    }
    let report;
    try {
      report = await auditRemote(target, deps);
    } catch (error) {
      io.error(`dsh-plugin doctor --remote: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    if (report.notes?.built === true) io.log(`note: ${report.notes.message}`);
    if (report.failures.length === 0) {
      const name = report.manifest?.name ?? report.target.slug;
      const version = report.manifest?.version ?? '?';
      const host = report.manifest?.engines?.dsh ?? '?';
      io.log(`ok  ${name}@${version} (host ${host}) at ${report.target.slug}`);
      return 0;
    }
    io.error(`dsh-plugin doctor: ${report.failures.length} problem(s) in ${report.target.slug}`);
    printFailures(report.failures, io);
    return 1;
  }

  if (command === 'doctor' && options.fix === true) {
    let result;
    try {
      result = doctorFix({
        dir,
        range: options.range,
        // A dry run is the default, and --dry-run wins if somebody passes both.
        write: options.write === true,
        dryRun: options.dryRun === true,
      });
    } catch (error) {
      io.error(`dsh-plugin doctor --fix: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    if (result.ok !== true) {
      io.error(`dsh-plugin doctor --fix: ${result.failures[0].message}`);
      return 1;
    }

    if (result.plan.length === 0) {
      const { manifest, notes } = result.after;
      io.log(`ok  ${manifest.name}@${notes.version} (host ${notes.hostRange})`);
      io.log('nothing to fix');
      return 0;
    }

    io.log(`dsh-plugin doctor --fix: ${result.plan.length} failed check(s) in ${result.dir}`);
    for (const entry of result.plan) {
      if (entry.kind === 'edit') {
        io.log(`  ✗ ${entry.check}: ${entry.path} — would write ${entry.edit}`);
      } else {
        io.log(`  ✗ ${entry.check}: ${entry.path} — manual: ${entry.manual}`);
      }
    }

    if (result.written === true) {
      for (const entry of result.edits) {
        io.log(`dsh-plugin doctor --fix: wrote ${entry.field} "${entry.after}" in ${entry.path}`);
      }
    } else if (result.edits.length > 0) {
      io.log('nothing written; pass --write to apply');
    } else {
      io.log('nothing written; no automatic repair for these checks');
    }

    if (result.remaining.length === 0) {
      const { manifest, notes } = result.after;
      io.log(`ok  ${manifest.name}@${notes.version} (host ${notes.hostRange})`);
      return 0;
    }
    io.log(`dsh-plugin doctor --fix: ${result.remaining.length} problem(s) remain in ${result.dir}`);
    printFailures(result.remaining, io);
    return 1;
  }

  if (command === 'doctor') {
    const report = doctor(dir);
    if (report.failures.length === 0) {
      io.log(`ok  ${report.manifest.name}@${report.notes.version} (host ${report.notes.hostRange})`);
      return 0;
    }
    io.error(`dsh-plugin doctor: ${report.failures.length} problem(s) in ${dir}`);
    printFailures(report.failures, io);
    return 1;
  }

  if (command === 'fix') {
    if (options.patch !== undefined && options.remote === undefined) {
      io.error('dsh-plugin fix --patch is only for --remote: a local checkout is repaired with --engines --write');
      return 2;
    }
    if (options.remote !== undefined) {
      const target = remoteTarget(options);
      if (target === '') {
        io.error('dsh-plugin fix --remote needs owner/repo, for example: fix V1ki/dsh-plugin-subscriptions --remote');
        return 2;
      }
      if (options.patch !== undefined && String(options.patch).trim() === '') {
        io.error('dsh-plugin fix --remote --patch needs a file path, for example: --patch repair.patch');
        return 2;
      }
      if (options.write === true) {
        io.error('dsh-plugin fix --remote: remote repositories are read-only; apply the diff in a checkout');
        return 2;
      }
      let result;
      try {
        result = await fixRemote(target, {
          ...deps,
          range: options.range,
          host: options.host,
          force: options.range !== undefined || options.host !== undefined,
          patch: options.patch,
          overwrite: options.force === true,
          writePatch: options.dryRun !== true,
        });
      } catch (error) {
        io.error(`dsh-plugin fix --remote: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      }
      if (result.changed !== true) {
        // A manifest that already declares a range clearing the check is a
        // successful repair plan, exactly like the local `fix --engines` no-op:
        // there is no failure to report, so the documented exit code is 0.
        io.log(`ok  engines.dsh is already "${result.range}"; nothing to apply`);
        if (typeof result.why === 'string' && result.why.length > 0) io.log(`    ${result.why}`);
        return 0;
      }
      const was = result.before === null ? 'missing' : `"${result.before}"`;
      io.log(`dsh-plugin fix: would write engines.dsh "${result.range}" (was ${was}) in ${result.target.slug}`);
      if (typeof result.why === 'string' && result.why.length > 0) io.log(`    ${result.why}`);
      if (result.patchPath !== null) {
        io.log(
          result.patchWritten === true
            ? `dsh-plugin fix: wrote the diff to ${result.patchPath}`
            : `dsh-plugin fix: would write the diff to ${result.patchPath}`,
        );
        io.log(
          result.patchWritten === true
            ? '    the repository itself was not modified; apply this diff in your checkout'
            : '    dry run: nothing written',
        );
        return 0;
      }
      io.log(result.diff.trimEnd());
      io.log('    remote repositories are read-only; nothing written; apply this diff in your checkout');
      return 0;
    }
    if (options.engines !== true) {
      io.error('usage: dsh-plugin fix <dir> --engines [--write]');
      io.error('       --engines is required: the host range is the fix this command knows');
      return 2;
    }
    const result = fixEngines({
      dir,
      range: options.range,
      host: options.host,
      // A dry run is the default, and --dry-run wins if somebody passes both.
      write: options.write === true && options.dryRun !== true,
      force: options.range !== undefined || options.host !== undefined,
    });
    if (result.ok !== true) {
      io.error(`dsh-plugin fix: ${result.failures[0].message}`);
      return 1;
    }
    if (result.reason === 'already-correct') {
      io.log(`ok  engines.dsh is already "${result.range}"; nothing to write`);
      if (typeof result.why === 'string' && result.why.length > 0) io.log(`    ${result.why}`);
      return 0;
    }
    const was = result.before === null ? 'missing' : `"${result.before}"`;
    if (result.written === true) {
      io.log(`dsh-plugin fix: wrote engines.dsh "${result.range}" (was ${was})`);
    } else {
      io.log(`dsh-plugin fix: would write engines.dsh "${result.range}" (was ${was})`);
    }
    if (typeof result.why === 'string' && result.why.length > 0) io.log(`    ${result.why}`);
    io.log(`    ${result.manifestPath}`);
    if (result.written !== true) io.log('    nothing written; pass --write to apply');
    return 0;
  }

  if (command === 'explain') {
    let text = options.positional[0] ?? '';
    let checkout = options.positional[1];
    let result;

    if (options.log !== undefined) {
      const logFile = resolvePath(options.log);
      let log;
      try {
        log = fs.readFileSync(logFile, 'utf8');
      } catch (error) {
        io.error(`dsh-plugin explain: cannot read log ${logFile}: ${error.message}`);
        return 2;
      }
      const found = lastCauseLine(log);
      if (found.matched.length === 0) {
        const lookedFor = CAUSES.map((cause) => `${cause.id} (${cause.match.source.split('|')[0]})`).join(', ');
        io.error(`dsh-plugin explain: no known cause in ${logFile}`);
        io.error(`    looked for: ${lookedFor}`);
        io.error('    the log has no line matching one of those known causes');
        return 2;
      }
      text = found.text;
      result = explain(text);
      // With --log the first positional is the checkout, not the error text.
      checkout = options.positional[0];
    } else {
      if (text.trim() === '') {
        io.error('usage: dsh-plugin explain "<error text>" [dir]');
        io.error('       dsh-plugin explain --log <file> [dir]');
        return 2;
      }
      result = explain(text);
    }

    if (result.matched.length === 0) {
      io.error('dsh-plugin explain: no known cause for that text');
      io.log('    paste the whole error, or run `dsh-plugin doctor <dir>` and read the failing line');
      return 2;
    }
    io.log(`dsh-plugin explain: ${result.matched.length} known cause(s)`);
    for (const cause of result.matched) {
      io.log(`  cause: ${cause.cause}`);
      io.log(`  symptom: ${cause.symptom}`);
      io.log(`  check: ${cause.check}`);
      io.log(`  fix: ${cause.fix}`);
    }
    if (checkout !== undefined) {
      const report = doctor(resolvePath(checkout));
      const { hits } = verdict(result, report.failures);
      if (hits.length === 0) {
        io.log(`  in ${checkout}: none of those checks fail, so the cause is somewhere else`);
      } else {
        for (const hit of hits) io.error(`  in ${checkout}: ✗ ${hit.check}: ${hit.message}`);
      }
    }
    return 0;
  }

  if (command === 'verify') {
    const result = await verify({ dir, mount: options.noMount !== true });
    if (result.ok === true) {
      const what =
        result.stage === 'mount'
          ? 'installed the tarball, mounted the panel'
          : result.hostImported === true
            ? 'installed the tarball and imported its host half'
            : 'installed the tarball and skipped the host import, because there is no root export';
      io.log(`ok  packed ${result.files.length} file(s), ${what}`);
      if (typeof result.text === 'string') io.log(`    ${result.text}`);
      return 0;
    }
    io.error(`dsh-plugin verify: stopped at ${result.stage}`);
    printFailures(result.failures, io);
    return 1;
  }

  if (command === 'init') {
    if (options.name === undefined) {
      io.error('dsh-plugin init: --name <package-name> is required');
      return 2;
    }
    const result = init({ dir, name: options.name, title: options.title, force: options.force === true });
    if (result.ok !== true) {
      io.error(`dsh-plugin init: ${result.failures[0].message}`);
      return 1;
    }
    io.log(`created ${result.files.length} file(s) in ${result.dir}`);
    for (const file of result.files) io.log(`  ${file}`);
    io.log('');
    io.log('next: npm install && npm test && npm run doctor');
    return 0;
  }

  if (command === 'index') {
    const target =
      options.index === undefined
        ? dir.endsWith('.json') === true
          ? dir
          : path.join(dir, 'market/index.json')
        : resolvePath(options.index);
    const index = readIndex(target);
    let problems = 0;
    for (const plugin of index.plugins ?? []) {
      const audit = auditVersions(index, plugin.name);
      if (audit.length === 0) {
        io.log(`ok  ${plugin.name}: ${plugin.versions.length} version(s) all carry engines.dsh`);
        continue;
      }
      problems += audit.length;
      io.error(`dsh-plugin index: ${plugin.name}`);
      for (const finding of audit) {
        io.error(`  ✗ ${finding.version ?? ''} ${finding.problem}`);
      }
    }
    return problems === 0 ? 0 : 1;
  }

  if (command === 'audit') {
    const { audit, parseJobs } = await import('./audit.mjs');
    if (options.home !== undefined && String(options.home).trim() === '') {
      io.error('dsh-plugin audit --home needs a directory path');
      return 2;
    }
    if (options.remote !== undefined || options.from !== undefined || options.patchDir !== undefined) {
      let remote = remoteTarget(options);
      let from = options.from;
      let jobs;
      try {
        jobs = parseJobs(options.jobs);
      } catch (error) {
        io.error(`dsh-plugin audit --jobs: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      }
      if (from !== undefined && String(from).trim() === '') {
        io.error('dsh-plugin audit --remote --from needs a file path, or - to read the list from standard input');
        return 2;
      }
      if (options.patchDir !== undefined && String(options.patchDir).trim() === '') {
        io.error('dsh-plugin audit --patch-dir needs a directory path');
        return 2;
      }
      if (options.patchDir !== undefined && options.remote === undefined && options.from === undefined) {
        io.error('dsh-plugin audit --patch-dir needs --remote <list> or --from <file>');
        return 2;
      }
      // `--remote -` is a shorthand for the same stdin list as `--from -`.
      if (from === undefined && remote === '-') {
        remote = '';
        from = '-';
      }
      if (remote === '' && from === undefined) {
        io.error('dsh-plugin audit --remote needs owner/repo,owner/repo or --from <file>');
        return 2;
      }
      let result;
      try {
        result = await audit({
          ...deps,
          remote: remote === '' ? undefined : remote,
          from,
          patchDir: options.patchDir,
          force: options.force === true,
          json: options.json === true,
          jobs,
          host: options.host,
          io,
        });
      } catch (error) {
        io.error(`dsh-plugin audit --remote: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      }
      return result.ok === true ? 0 : 1;
    }
    const result = await audit({
      home: options.home === undefined ? undefined : resolvePath(options.home),
      host: options.host,
      timeoutMs: options.timeout,
      io,
    });
    return result.ok === true ? 0 : 1;
  }

  if (command === 'dev') {
    const { dev } = await import('./dev.mjs');
    return dev({
      dir: resolvePath(options.positional[0] ?? '.'),
      dest: options.dest,
      entry: options.entry,
      build: options.build,
      host: options.host,
      once: options.once === true,
      debounceMs: options.debounce,
      timeoutMs: options.timeout,
      io,
    });
  }

  if (command === 'mount') {
    const file = options.positional[0];
    if (file === undefined) {
      io.error('dsh-plugin mount: name the client bundle to render');
      return 2;
    }
    const { mountClient } = await import('./testkit/index.mjs');
    const panel = await mountClient({
      file: resolvePath(file),
      slot: options.slot ?? 'sidebar.right.pane.tab',
      surface: options.surface ?? 'sidebar',
    });
    io.log(panel.text());
    if (options.html === true) io.log(panel.html());
    await panel.unmount();
    return 0;
  }

  if (command === 'release') {
    const report = doctor(dir);
    const name = report.manifest?.name ?? '(no name)';
    const version = report.notes?.version ?? '(no version)';

    if (options.dryRun === true) {
      io.log(`dry run: ${name}@${version}`);
      const planned = plan({
        dir,
        version,
        name,
        tagPrefix: options.tagPrefix,
        indexFile: options.index === undefined ? undefined : expandHome(options.index),
      });
      for (const step of planned.steps) {
        io.log(`  ${step.runs === false ? '·' : '→'} ${step.title}`);
        io.log(`      ${step.command}`);
      }
      if (report.failures.length > 0) {
        io.error('  the real run would stop at preflight:');
        printFailures(report.failures, io);
        return 1;
      }
      return 0;
    }

    const result = await release({
      dir,
      indexFile: options.index === undefined ? undefined : expandHome(options.index),
      marketDir: options.market === undefined ? undefined : resolvePath(options.market),
      publish: options.publish === true,
      tagPrefix: options.tagPrefix,
      budgetMs: options.budget === undefined ? undefined : options.budget * 1000,
      pr: options.pr === true,
      merge: options.merge === true,
      base: options.base,
      onStep: (name) => io.log(`  → ${name}`),
      onWait: ({ attempts, waitedMs }) => {
        io.log(`  … ${name}@${version} not on the registry yet (${attempts} checks, ${Math.round(waitedMs / 1000)}s)`);
      },
    });

    if (result.ok === false) {
      io.error(`dsh-plugin release stopped at ${result.stage}`);
      printFailures(result.failures, io);
      return 1;
    }

    io.log(`tagged ${result.tag}, npm served ${name}@${version} after ${Math.round(result.waitedMs / 1000)}s`);
    if (result.indexUpdate !== null && result.pullRequest !== undefined) {
      io.log(`updated ${result.indexUpdate.file} on ${result.pullRequest.branch}`);
    } else if (result.indexUpdate !== null && result.indexUpdate.unchanged === true) {
      io.log(`${result.indexUpdate.file} already carried ${version}; nothing to commit`);
    } else if (result.indexUpdate !== null) {
      io.log(`updated ${result.indexUpdate.file} — commit it and open the PR:`);
      io.log(`  git add ${result.indexUpdate.file} && git commit -m "market: ${version}" && gh pr create --fill`);
    } else {
      io.log('no market/index.json here, so only the tag and the publish happened');
    }

    if (result.pullRequest !== undefined) {
      if (result.pullRequest.ok !== true) {
        io.error(`the pull request was not opened (${result.pullRequest.stage})`);
        return 1;
      }
      io.log(`opened ${result.pullRequest.url}`);
    }
    if (result.checks !== undefined) {
      io.log(`checks settled after ${Math.round(result.checks.waitedMs / 1000)}s (${result.checks.attempts} look(s))`);
    }
    if (result.merged !== undefined && result.merged.ok === true) {
      io.log('merged');
    }
    return 0;
  }

  io.error(`unknown command "${command}"\n`);
  io.error(HELP);
  return 2;
}
