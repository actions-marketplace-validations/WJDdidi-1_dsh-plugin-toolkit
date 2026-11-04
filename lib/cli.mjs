#!/usr/bin/env node
/**
 * `dsh-plugin <command>` — small enough to read in one sitting, which is the
 * point: a release tool that hides what it does is worse than a checklist.
 */
import fs from 'node:fs';
import path from 'node:path';

import { doctor } from './doctor.mjs';
import { DEFAULT_ENGINES, fixEngines } from './fix.mjs';
import { auditRemote } from './remote.mjs';
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

  dsh-plugin fix <dir> --engines       print the host range doctor asks for; write it only with --write
      dsh-plugin fix ./my-panel --engines --write

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
  dsh-plugin dev [dir] [flags]         copy a rebuilt bundle into the installed plugin and confirm the reload
      dsh-plugin dev . --host http://127.0.0.1:54133

  dsh-plugin release [dir] [flags]     tag, wait for npm, update the market index, open the PR
      dsh-plugin release . --pr --merge

  dsh-plugin index [dir]               audit every version in market/index.json
      dsh-plugin index market/index.json

Flags
  --dry-run                 show the steps without touching anything
  --engines                 with fix: repair the host range in package.json
  --write                   with fix: write the change instead of only printing it
  --range <range>           with fix: the range to write, default ${DEFAULT_ENGINES}
  --log <file>              with explain: read a log and find its last known failure
  --index <path>            index file, default market/index.json
  --market <dir>            with release: a checkout of the repository that holds the index
  --publish                 with release: run npm publish here, for repos without a publish workflow
  --tag-prefix <prefix>     default plugin-v
  --budget <seconds>        how long to wait for npm, default 480
  --pr                      commit the index on a branch, push it, open the pull request
  --merge                   with --pr: wait for checks, then squash-merge
  --base <branch>           base branch for the pull request, default main
  --name <package-name>     with init: the npm name, required
  --title <text>            with init: the tab title, default "My panel"
  --force                   with init: write into a directory that is not empty
`;

function flags(argv) {
  const parsed = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run') parsed.dryRun = true;
    else if (token === '--engines') parsed.engines = true;
    else if (token === '--write') parsed.write = true;
    else if (token === '--range') parsed.range = argv[++index];
    else if (token === '--log') parsed.log = argv[++index];
    else if (token === '--index') parsed.index = argv[++index];
    else if (token === '--tag-prefix') parsed.tagPrefix = argv[++index];
    else if (token === '--budget') parsed.budget = Number(argv[++index]);
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
    else if (token === '--remote') parsed.remote = argv[++index];
    else if (token === '--once') parsed.once = true;
    else if (token === '--debounce') parsed.debounce = Number(argv[++index]);
    else if (token === '--timeout') parsed.timeout = Number(argv[++index]);
    else if (token === '--pr') parsed.pr = true;
    else if (token === '--merge') parsed.merge = true;
    else if (token === '--publish') parsed.publish = true;
    else if (token === '--home') parsed.home = argv[++index];
    else if (token === '--base') parsed.base = argv[++index];
    else if (token === '--market') parsed.market = argv[++index];
    else if (token.startsWith('--') === true) throw new Error(`unknown flag ${token}`);
    else parsed.positional.push(token);
  }
  return parsed;
}

function printFailures(failures, io = console) {
  for (const failure of failures) {
    io.error(`  ✗ ${failure.check}: ${failure.message}`);
  }
}

export async function run(argv, io = console, deps = {}) {
  const [command, ...rest] = argv;
  const options = flags(rest);
  const dir = path.resolve(options.positional[0] ?? '.');

  if (command === undefined || command === 'help' || command === '--help') {
    io.log(HELP);
    return 0;
  }

  if (command === 'doctor' && options.remote !== undefined) {
    const target = String(options.remote ?? '').trim();
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
    if (options.engines !== true) {
      io.error('usage: dsh-plugin fix <dir> --engines [--write]');
      io.error('       --engines is required: the host range is the fix this command knows');
      return 2;
    }
    const result = fixEngines({
      dir,
      range: options.range,
      // A dry run is the default, and --dry-run wins if somebody passes both.
      write: options.write === true && options.dryRun !== true,
      force: options.range !== undefined,
    });
    if (result.ok !== true) {
      io.error(`dsh-plugin fix: ${result.failures[0].message}`);
      return 1;
    }
    if (result.reason === 'already-correct') {
      io.log(`ok  engines.dsh is already "${result.range}"; nothing to write`);
      return 0;
    }
    const was = result.before === null ? 'missing' : `"${result.before}"`;
    if (result.written === true) {
      io.log(`dsh-plugin fix: wrote engines.dsh "${result.range}" (was ${was})`);
    } else {
      io.log(`dsh-plugin fix: would write engines.dsh "${result.range}" (was ${was})`);
    }
    io.log(`    ${result.manifestPath}`);
    if (result.written !== true) io.log('    nothing written; pass --write to apply');
    return 0;
  }

  if (command === 'explain') {
    let text = options.positional[0] ?? '';
    let checkout = options.positional[1];
    let result;

    if (options.log !== undefined) {
      const logFile = path.resolve(options.log);
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
      const report = doctor(path.resolve(checkout));
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
      const what = result.stage === 'mount' ? 'installed the tarball, mounted the panel' : 'installed the tarball and imported its host half';
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
    const target = options.index ?? (dir.endsWith('.json') === true ? dir : path.join(dir, 'market/index.json'));
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
    const { audit } = await import('./audit.mjs');
    const result = await audit({ home: options.home, host: options.host, timeoutMs: options.timeout, io });
    return result.ok === true ? 0 : 1;
  }

  if (command === 'dev') {
    const { dev } = await import('./dev.mjs');
    return dev({
      dir: path.resolve(options.positional[0] ?? '.'),
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
      file: path.resolve(file),
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
      const planned = plan({ dir, version, name, tagPrefix: options.tagPrefix, indexFile: options.index });
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
      indexFile: options.index,
      marketDir: options.market,
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
    if (result.indexUpdate !== null && result.indexUpdate.unchanged === true) {
      io.log(`${result.indexUpdate.file} already carried ${version}; nothing to commit`);
    } else if (result.indexUpdate !== null && result.pullRequest === undefined) {
      io.log(`updated ${result.indexUpdate.file} — commit it and open the PR:`);
      io.log(`  git add ${result.indexUpdate.file} && git commit -m "market: ${version}" && gh pr create --fill`);
    } else if (result.indexUpdate !== null) {
      io.log(`updated ${result.indexUpdate.file} on ${result.pullRequest.branch}`);
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
