/**
 * `dsh-plugin fix --engines` — write the host range `doctor` asks for.
 *
 * The hub reports installs that fail because a plugin has no `engines.dsh`,
 * and `doctor` can only name the missing field. This writes it. The write is
 * opt-in (`--write`) because editing a manifest is not a read-only check: the
 * author sees the exact range first and the command prints it before touching
 * anything.
 *
 * A range that already passes `checkHostRange` is left alone even when it is
 * not the default. `>=0.3.0` is a deliberate statement about the host APIs a
 * plugin uses, and lowering it to `>=0.2.0` would be a worse fix than none.
 * `--range` explicitly asks for a different range and may replace one.
 */
import fs from 'node:fs';
import path from 'node:path';

import { hostRangePlan, satisfiesRange } from './compat.mjs';
import { checkHostRange, doctor, hostRange } from './doctor.mjs';
import { resolvePath } from './paths.mjs';

/** The oldest host the toolkit itself supports, and the range `init` writes. */
export const DEFAULT_ENGINES = '>=0.2.0';

/**
 * Turn `--range` and `--host` into the range a repair should propose.
 *
 * `--host` is the compatibility path: no hand-written range, just the version
 * the install rejected. `--range` still wins when both are passed, but the
 * host is kept so the caller can explain whether that explicit range includes
 * it. Without either flag the long-standing default is unchanged.
 */
export function resolveEnginesRange({ range, host } = {}) {
  const hasRange = range !== undefined && range !== null;
  const hasHost = host !== undefined && host !== null;
  let plan = null;
  if (hasHost === true) {
    const text = String(host).trim();
    if (text === '') {
      return { error: '--host needs a version, for example --host 0.3.0' };
    }
    plan = hostRangePlan(text);
    if (plan === null) {
      return { error: `"${text}" is not a semver host version, so there is no host to aim the range at` };
    }
  }

  const proposed = hasRange
    ? typeof range === 'string'
      ? range.trim()
      : ''
    : plan?.range ?? DEFAULT_ENGINES;

  let why = plan?.why ?? null;
  if (plan !== null && proposed !== plan.range) {
    const includes = satisfiesRange(proposed, plan.host);
    why =
      includes === true
        ? `host ${plan.host} is inside the explicit range "${proposed}"`
        : `host ${plan.host} is not inside the explicit range "${proposed}"; use a range that includes it`;
  }

  return {
    proposed,
    host: plan?.host ?? null,
    nextMajor: plan?.nextMajor ?? null,
    // Naming a host is as explicit as naming a range: it asks the fixer to
    // replace a valid-but-too-broad range with one aimed at that host.
    force: hasHost === true,
    why,
  };
}

const normalize = (value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, '') : '');

/** The same rule `doctor` applies, so anything written here clears that check. */
export function isHostRange(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return checkHostRange({ engines: { dsh: value } }) === null;
}

function failure(check, message) {
  return { ok: false, failures: [{ check, message }] };
}

/**
 * Decide what the `engines.dsh` edit should be for one manifest.
 *
 * The local fixer and the remote planner share this decision so the range a
 * `fix --remote` plan prints is exactly the range `--write` applies in a
 * checkout. `manifest` is the object after the edit when there is one;
 * `noop` means the current range already clears `doctor` and `force` does not
 * ask for a replacement.
 */
export function planEnginesEdit(manifest, { range, host, force = false } = {}) {
  const requested = resolveEnginesRange({ range, host });
  if (requested.error !== undefined) {
    return failure('host', requested.error);
  }
  const { proposed } = requested;
  if (isHostRange(proposed) === false) {
    return failure('engines.dsh', `"${proposed}" is not a semver range, so it would not clear the doctor check`);
  }

  const current = hostRange(manifest);
  const correct = current !== null && checkHostRange(manifest) === null;
  const same = normalize(current) === normalize(proposed);
  const forced = force === true || requested.force === true;
  const noop = correct === true && (forced !== true || same === true);
  const engines =
    manifest.engines !== null && typeof manifest.engines === 'object' && Array.isArray(manifest.engines) === false
      ? manifest.engines
      : {};
  const next = noop === true ? null : { ...manifest, engines: { ...engines, dsh: proposed } };

  return {
    ok: true,
    proposed,
    current,
    correct,
    same,
    forced,
    noop,
    manifest: next,
    reason: noop === true ? 'already-correct' : current === null ? 'missing' : correct === true ? 'different' : 'not-a-range',
    host: requested.host,
    nextMajor: requested.nextMajor,
    why: requested.why,
  };
}

/** Keep the indentation and the final newline the manifest already had. */
function formatting(raw) {
  const indent = /^[\t ]+"/m.exec(raw);
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  return {
    indent: indent === null ? 2 : indent[0].slice(0, -1),
    eol,
    trailing: raw.endsWith('\n') ? eol : '',
  };
}

/**
 * Render a manifest the way the file was already formatted.
 *
 * `fix --remote` uses the same rendering as the local fixer so the diff it
 * prints is the edit the local command would make.
 */
export function renderManifest(manifest, raw) {
  const { indent, eol, trailing } = formatting(raw);
  let text = JSON.stringify(manifest, null, indent);
  if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  return `${text}${trailing}`;
}

/** Split text for a diff without inventing a final empty line. */
function diffLines(text) {
  const normalized = String(text).replace(/\r\n/gu, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** A line-by-line edit script, equal lines first and deletions before additions. */
function lineOperations(before, after) {
  const left = diffLines(before);
  const right = diffLines(after);
  const common = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      common[i][j] =
        left[i] === right[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }

  const operations = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      operations.push({ type: ' ', text: left[i] });
      i += 1;
      j += 1;
    } else if (common[i + 1][j] >= common[i][j + 1]) {
      operations.push({ type: '-', text: left[i] });
      i += 1;
    } else {
      operations.push({ type: '+', text: right[j] });
      j += 1;
    }
  }
  while (i < left.length) operations.push({ type: '-', text: left[i++] });
  while (j < right.length) operations.push({ type: '+', text: right[j++] });
  return operations;
}

/**
 * A standard unified diff, used by `fix --remote` to show the manifest edit
 * without writing anything. Returns an empty string when the two texts match.
 */
export function unifiedDiff(before, after, { file = 'package.json', context = 3 } = {}) {
  const operations = lineOperations(before, after);
  const changed = [];
  for (let index = 0; index < operations.length; index += 1) {
    if (operations[index].type !== ' ') changed.push(index);
  }
  if (changed.length === 0) return '';

  // Merge the context windows so nearby edits share one hunk.
  const hunks = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(operations.length, changed[0] + context + 1);
  for (const index of changed.slice(1)) {
    const nextStart = Math.max(0, index - context);
    const nextEnd = Math.min(operations.length, index + context + 1);
    if (nextStart <= end) {
      end = Math.max(end, nextEnd);
    } else {
      hunks.push([start, end]);
      start = nextStart;
      end = nextEnd;
    }
  }
  hunks.push([start, end]);

  const oldBefore = new Uint32Array(operations.length + 1);
  const newBefore = new Uint32Array(operations.length + 1);
  for (let index = 0; index < operations.length; index += 1) {
    oldBefore[index + 1] = oldBefore[index] + (operations[index].type === '+' ? 0 : 1);
    newBefore[index + 1] = newBefore[index] + (operations[index].type === '-' ? 0 : 1);
  }

  const lines = [`--- a/${file}`, `+++ b/${file}`];
  for (const [from, to] of hunks) {
    const oldCount = oldBefore[to] - oldBefore[from];
    const newCount = newBefore[to] - newBefore[from];
    const oldStart = oldCount === 0 ? oldBefore[from] : oldBefore[from] + 1;
    const newStart = newCount === 0 ? newBefore[from] : newBefore[from] + 1;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let index = from; index < to; index += 1) {
      lines.push(`${operations[index].type}${operations[index].text}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Inspect (and, with `write`, update) one plugin directory.
 *
 * Returns `{ ok, dir, manifestPath, before, after, range, changed, written,
 * reason, host, nextMajor, why }`. `reason` is `missing`, `not-a-range`,
 * `different` (only with `force` or a named host) or `already-correct`.
 *
 * `host` aims the range at the DSH that rejected the install. The written range
 * includes that version and excludes the next major, and `why` carries the
 * sentence the CLI prints so the author can see the decision, not just the
 * result.
 */
export function fixEngines({ dir = '.', range, host, write = false, force = false } = {}) {
  const target = resolvePath(dir);
  const manifestPath = path.join(target, 'package.json');
  if (fs.existsSync(manifestPath) === false) {
    return failure('manifest', `no package.json in ${target}`);
  }

  let raw;
  let manifest;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch (error) {
    return failure('manifest', `cannot read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) === true) {
    return failure('manifest', `${manifestPath} does not hold a JSON object`);
  }

  const planned = planEnginesEdit(manifest, { range, host, force });
  if (planned.ok !== true) return planned;

  const { proposed, current } = planned;
  if (planned.noop === true) {
    return {
      ok: true,
      dir: target,
      manifestPath,
      before: current,
      after: current,
      range: current,
      changed: false,
      written: false,
      reason: 'already-correct',
      host: planned.host,
      nextMajor: planned.nextMajor,
      why: planned.why,
    };
  }

  const content = renderManifest(planned.manifest, raw);

  let written = false;
  if (write === true) {
    fs.writeFileSync(manifestPath, content);
    written = true;
  }

  return {
    ok: true,
    dir: target,
    manifestPath,
    before: current,
    after: proposed,
    range: proposed,
    changed: true,
    written,
    reason: planned.reason,
    host: planned.host,
    nextMajor: planned.nextMajor,
    why: planned.why,
  };
}

/** The file a check names, and the edit a person still has to make by hand. */
function manualRepair(failure, dir, manifest) {
  const packageFile = path.join(dir, 'package.json');
  const at = (file) => ({ file, path: path.relative(dir, file) || path.basename(file) });
  switch (failure.check) {
    case 'name':
      return {
        ...at(packageFile),
        manual: 'set "name" to the npm package name, for example my-plugin or @me/my-plugin',
      };
    case 'version':
      return {
        ...at(packageFile),
        manual: 'set "version" to a semver value, for example "1.0.0"',
      };
    case 'readme':
      return {
        ...at(path.join(dir, 'README.md')),
        manual: 'add a "## Requirements" section that names the host range the manifest declares',
      };
    case 'dsh field':
      return {
        ...at(packageFile),
        manual: 'add a "dsh.bundle.patch" pointing at a patch file that exists, so the host has something to load',
      };
    case 'patch file': {
      const declared = manifest.dsh?.bundle?.patch;
      const file = typeof declared === 'string' ? path.resolve(dir, declared) : packageFile;
      return {
        ...at(file),
        manual:
          typeof declared === 'string'
            ? `create ${declared}, or point dsh.bundle.patch at the patch file that already exists`
            : 'create the patch file dsh.bundle.patch names',
      };
    }
    case 'client entry':
      return {
        ...at(packageFile),
        manual: 'ship the declared client bundle, or point dsh.client at the file that exists',
      };
    case 'client declaration':
      return {
        ...at(packageFile),
        manual: 'declare dsh.client and export "./client" so the host serves the bundle',
      };
    case 'files list': {
      const missing = failure.message.startsWith('files does not ship ')
        ? failure.message.slice('files does not ship '.length).split(', which package.json points at')[0]
        : 'the paths package.json points at';
      return {
        ...at(packageFile),
        manual: `add ${missing} to "files" so the tarball ships the code the manifest points at`,
      };
    }
    case 'root export':
      return {
        ...at(packageFile),
        manual: 'point exports["."] at the module that exports apply, not at the CLI',
      };
    default:
      return { ...at(packageFile), manual: 'repair this check by hand; doctor --fix has no automatic edit for it' };
  }
}

/** Assign a dotted field (`engines.dsh`) without discarding the object around it. */
function setField(target, field, value) {
  const parts = field.split('.');
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (cursor[part] === null || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

/**
 * Read a directory and turn every failed `doctor` check into a plan line.
 *
 * `kind: 'edit'` means `doctor --fix --write` can make the change; `kind:
 * 'manual'` means the check failed but guessing the right file contents would
 * be worse than saying so. A plan is pure: it never writes.
 */
export function repairPlan({ dir = '.', range, host } = {}) {
  const target = resolvePath(dir);
  const manifestPath = path.join(target, 'package.json');
  const requested = resolveEnginesRange({ range, host });
  if (requested.error !== undefined) {
    return failure('host', requested.error);
  }
  const { proposed } = requested;
  if (isHostRange(proposed) === false) {
    return failure('engines.dsh', `"${proposed}" is not a semver range, so it would not clear the doctor check`);
  }

  let report;
  try {
    report = doctor(target);
  } catch (error) {
    return failure('manifest', error instanceof Error ? error.message : String(error));
  }

  const plan = report.failures.map((entry) => {
    if (entry.check === 'engines.dsh') {
      const current = hostRange(report.manifest);
      const reason = current === null ? 'missing' : 'not-a-range';
      return {
        check: entry.check,
        kind: 'edit',
        file: manifestPath,
        path: path.basename(manifestPath),
        field: 'engines.dsh',
        before: current,
        after: proposed,
        reason,
        edit: `engines.dsh "${proposed}" (was ${current === null ? 'missing' : `"${current}"`})`,
        message: entry.message,
      };
    }
    return {
      check: entry.check,
      kind: 'manual',
      message: entry.message,
      ...manualRepair(entry, target, report.manifest),
    };
  });

  return {
    ok: true,
    dir: target,
    manifestPath,
    report,
    plan,
    edits: plan.filter((entry) => entry.kind === 'edit'),
    manual: plan.filter((entry) => entry.kind === 'manual'),
    host: requested.host,
    nextMajor: requested.nextMajor,
    why: requested.why,
  };
}

/**
 * `dsh-plugin doctor --fix`: plan the edits, apply only the automatic ones when
 * `write` is true, then run `doctor` again so the caller can report what is
 * still wrong.
 */
export function doctorFix({ dir = '.', range, host, write = false, dryRun = false, force = false } = {}) {
  const planned = repairPlan({ dir, range, host });
  if (planned.ok !== true) return planned;

  const manifestEdits = planned.edits.filter((entry) => entry.file === planned.manifestPath);
  const files = [];
  if (write === true && dryRun !== true && manifestEdits.length > 0) {
    try {
      const raw = fs.readFileSync(planned.manifestPath, 'utf8');
      const next = JSON.parse(raw);
      for (const entry of manifestEdits) setField(next, entry.field, entry.after);
      fs.writeFileSync(planned.manifestPath, renderManifest(next, raw));
      files.push(planned.manifestPath);
    } catch (error) {
      return failure(
        'manifest',
        `cannot write ${planned.manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Re-read the directory rather than subtracting failures from the old report:
  // an edit can reveal a check that was already failing for another reason.
  const after = doctor(planned.dir);
  return {
    ok: true,
    dir: planned.dir,
    manifestPath: planned.manifestPath,
    before: planned.report,
    after,
    report: after,
    plan: planned.plan,
    edits: planned.edits,
    manual: planned.manual,
    changed: planned.edits.length > 0,
    written: files.length > 0,
    files,
    remaining: after.failures,
    range: planned.edits.find((entry) => entry.field === 'engines.dsh')?.after ?? null,
    host: planned.host,
    nextMajor: planned.nextMajor,
    why: planned.why,
    dryRun: dryRun === true,
    force: force === true,
  };
}

/** Readable aliases for callers that name the operation rather than the command. */
export const planRepairs = repairPlan;
export const fixDoctor = doctorFix;
