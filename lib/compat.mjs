/**
 * Does a plugin's `engines.dsh` range accept the host that is asking?
 *
 * `doctor` can only say whether a range is present and looks like a range: it
 * has no host to compare against. The compatibility reports are all one
 * question — "will this install on *my* DSH?" — so this module answers it with
 * the same semver rules npm applies when it enforces `engines`.
 *
 * The parser is deliberately self-contained. The toolkit has no runtime
 * dependencies, and a range that we cannot parse is reported as `unknown`
 * rather than guessed at: a wrong `compatible` sends a user back to the same
 * install failure the report was about.
 */

const CORE = '(0|[1-9]\\d*)';
const PRERELEASE = '(?:-([0-9A-Za-z.-]+))?';
const BUILD = '(?:\\+[0-9A-Za-z.-]+)?';
const FULL_VERSION = new RegExp(`^[v=]?${CORE}\\.${CORE}\\.${CORE}${PRERELEASE}${BUILD}$`, 'u');
const PARTIAL_VERSION = new RegExp(
  `^[v=]?(0|[1-9]\\d*|[xX*])(?:\\.(0|[1-9]\\d*|[xX*]))?(?:\\.(0|[1-9]\\d*|[xX*]))?${PRERELEASE}${BUILD}$`,
  'u',
);

function prereleaseOf(text) {
  if (text === undefined) return [];
  const identifiers = text.split('.');
  for (const identifier of identifiers) {
    if (identifier === '') return null;
    if (/^\d+$/u.test(identifier) === true && /^0\d+/u.test(identifier) === true) return null;
  }
  return identifiers;
}

/** A complete `major.minor.patch[-prerelease]` version, or null when malformed. */
export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = FULL_VERSION.exec(value.trim());
  if (match === null) return null;
  const prerelease = prereleaseOf(match[4]);
  if (prerelease === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function partialNumber(value) {
  if (value === undefined || value === null || value === '' || /^[xX*]$/u.test(value) === true) return null;
  if (/^\d+$/u.test(value) === false) return undefined;
  return Number(value);
}

/**
 * A range endpoint can be a partial version (`1`, `1.2`, `1.2.x`). Missing
 * components are significant: `1.2` means the whole `1.2.x` line, not the
 * single version `1.2.0`.
 */
export function parsePartialVersion(value) {
  if (typeof value !== 'string') return null;
  const match = PARTIAL_VERSION.exec(value.trim());
  if (match === null) return null;
  const major = partialNumber(match[1]);
  const minor = partialNumber(match[2]);
  const patch = partialNumber(match[3]);
  if (major === undefined || minor === undefined || patch === undefined) return null;
  if (major === null && (minor !== null || patch !== null)) return null;
  if (minor === null && patch !== null) return null;
  const prerelease = prereleaseOf(match[4]);
  if (prerelease === null) return null;
  // The wildcard spelling of a missing component is the same range as leaving
  // it off; a pre-release needs a complete version to belong to.
  if (prerelease.length > 0 && (minor === null || patch === null)) return null;
  return { major, minor, patch, prerelease };
}

function full(major, minor, patch, prerelease = []) {
  return { major, minor, patch, prerelease };
}

function filled(partial, overrides = {}) {
  return full(
    overrides.major ?? partial.major ?? 0,
    overrides.minor ?? partial.minor ?? 0,
    overrides.patch ?? partial.patch ?? 0,
    partial.prerelease,
  );
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric === true && rightNumeric === true) return Number(left) - Number(right);
  if (leftNumeric === true) return -1;
  if (rightNumeric === true) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Semver precedence, including the rule that a pre-release sorts before its release. */
export function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  const a = left.prerelease;
  const b = right.prerelease;
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    const order = compareIdentifiers(a[index], b[index]);
    if (order !== 0) return order < 0 ? -1 : 1;
  }
  return 0;
}

function comparator(op, version) {
  return { op, version };
}

function lowerBounds(partial, inclusive) {
  const version = filled(partial);
  if (inclusive === true) return [comparator('>=', version)];
  // The missing component decides the next boundary: `>1` starts at 2.0.0,
  // while `>1.2` starts at 1.3.0. Check the major-only case first, or the
  // filled-in minor would turn `>1` into `>=1.1.0` and accept 1.2.3 — a
  // version npm rejects.
  if (partial.minor === null) {
    return [comparator('>=', full(version.major + 1, 0, 0))];
  }
  if (partial.patch === null) {
    return [comparator('>=', full(version.major, version.minor + 1, 0))];
  }
  return [comparator('>', version)];
}

function upperBounds(partial, inclusive) {
  const version = filled(partial);
  if (inclusive === true) {
    // `<=1` includes all of 1.x, so its exclusive ceiling is 2.0.0, not 1.1.0.
    if (partial.minor === null) return [comparator('<', full(version.major + 1, 0, 0))];
    if (partial.patch === null) return [comparator('<', full(version.major, version.minor + 1, 0))];
    return [comparator('<=', version)];
  }
  if (partial.minor === null) return [comparator('<', full(version.major, 0, 0))];
  if (partial.patch === null) return [comparator('<', full(version.major, version.minor, 0))];
  return [comparator('<', version)];
}

function caretBounds(partial) {
  const lower = filled(partial);
  let upper;
  if (partial.major > 0 || partial.minor === null) {
    upper = full(partial.major + 1, 0, 0);
  } else if (partial.minor > 0 || partial.patch === null) {
    upper = full(0, partial.minor + 1, 0);
  } else {
    upper = full(0, 0, partial.patch + 1);
  }
  return [comparator('>=', lower), comparator('<', upper)];
}

function tildeBounds(partial) {
  const lower = filled(partial);
  const upper = partial.minor === null ? full(partial.major + 1, 0, 0) : full(partial.major, partial.minor + 1, 0);
  return [comparator('>=', lower), comparator('<', upper)];
}

function plainBounds(partial) {
  if (partial.major === null) return [];
  if (partial.minor === null) {
    return [comparator('>=', filled(partial)), comparator('<', full(partial.major + 1, 0, 0))];
  }
  if (partial.patch === null) {
    return [comparator('>=', filled(partial)), comparator('<', full(partial.major, partial.minor + 1, 0))];
  }
  return [comparator('=', filled(partial))];
}

function expandToken(token) {
  // `~>` is npm's older spelling of `~`; package.json files in the wild still
  // use it, and npm accepts both, so the answer here has to as well.
  const match = /^(~>|\^|~|>=|<=|>|<|=)?(.*)$/u.exec(token);
  if (match === null) return null;
  const operator = match[1] ?? '=';
  const body = match[2].trim();
  if (body === '') return null;
  const partial = parsePartialVersion(body);
  if (partial === null) return null;
  if (operator === '^') {
    if (partial.major === null) return null;
    return caretBounds(partial);
  }
  if (operator === '~' || operator === '~>') {
    if (partial.major === null) return null;
    return tildeBounds(partial);
  }
  if (operator === '=') return plainBounds(partial);
  if (operator === '>=') return partial.major === null ? [] : [comparator('>=', filled(partial))];
  if (operator === '>') return partial.major === null ? [] : lowerBounds(partial, false);
  if (operator === '<=') return partial.major === null ? [] : upperBounds(partial, true);
  if (operator === '<') return partial.major === null ? [] : upperBounds(partial, false);
  return null;
}

function hyphenSet(text) {
  const match = /^(\S+)\s+-\s+(\S+)$/u.exec(text);
  if (match === null) return null;
  const start = parsePartialVersion(match[1]);
  const end = parsePartialVersion(match[2]);
  if (start === null || end === null) return null;
  const comparators = [];
  if (start.major !== null) comparators.push(comparator('>=', filled(start)));
  if (end.major !== null) comparators.push(...upperBounds(end, true));
  return comparators;
}

function parseAlternative(text) {
  const clean = text.trim();
  if (clean === '') return null;
  if (/\s-\s/u.test(clean) === true) return hyphenSet(clean);

  // `>= 0.2.0` is the same comparator as `>=0.2.0`; joining the operator to its
  // version before splitting keeps the space inside the range from being read
  // as a second comparator.
  const squeezed = clean.replace(/(\^|~|>=|<=|>|<|=)\s+/gu, '$1');
  const comparators = [];
  for (const token of squeezed.split(/\s+/u)) {
    const expanded = expandToken(token);
    if (expanded === null) return null;
    comparators.push(...expanded);
  }
  return comparators;
}

/**
 * Parse an npm-style range into a union of comparator sets, or null when the
 * text is not a range this module understands. Each set is an intersection;
 * alternatives (`||`) are a union of sets.
 */
export function parseRange(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const sets = [];
  for (const part of value.split('||')) {
    const set = parseAlternative(part);
    if (set === null) return null;
    sets.push(set);
  }
  return sets;
}

function matchesComparator(version, { op, version: wanted }) {
  const order = compareVersions(version, wanted);
  if (op === '=') return order === 0;
  if (op === '>') return order > 0;
  if (op === '>=') return order >= 0;
  if (op === '<') return order < 0;
  if (op === '<=') return order <= 0;
  return false;
}

/**
 * npm's pre-release rule: a pre-release version satisfies a set only when one
 * of its comparators names a pre-release of the same major.minor.patch. This is
 * why `>=0.2.0` does not accept `0.2.2-alpha.3`, the exact canary failure the
 * compatibility reports describe.
 */
function prereleaseAllowed(version, set) {
  if (version.prerelease.length === 0) return true;
  return set.some(({ version: wanted }) => {
    return (
      wanted.prerelease.length > 0 &&
      wanted.major === version.major &&
      wanted.minor === version.minor &&
      wanted.patch === version.patch
    );
  });
}

/** True/false when the range is understood, null when it cannot be evaluated. */
export function satisfiesRange(range, hostVersion) {
  const sets = parseRange(range);
  const version = parseVersion(hostVersion);
  if (sets === null || version === null) return null;
  return sets.some((set) => {
    return prereleaseAllowed(version, set) && set.every((entry) => matchesComparator(version, entry));
  });
}

/**
 * The range `fix --host` aims at a host: that version, through the rest of its
 * major line, stopping before the next major.
 *
 * `>=0.3.0 <1.0.0` is deliberately explicit rather than `^0.3.0`: the command
 * has one job, and the printed text has to say exactly which version it
 * includes and which one it excludes. Returns null when the host is not a
 * complete semver version, because guessing at a partial version would write a
 * range the author did not ask for.
 */
export function hostRangePlan(hostVersion) {
  const version = parseVersion(hostVersion);
  if (version === null) return null;
  const core = `${version.major}.${version.minor}.${version.patch}`;
  const host = version.prerelease.length === 0 ? core : `${core}-${version.prerelease.join('.')}`;
  const nextMajor = `${version.major + 1}.0.0`;
  const range = `>=${host} <${nextMajor}`;
  return {
    host,
    range,
    nextMajor,
    why: `host ${host} is inside "${range}"; ${nextMajor} is excluded, so the range includes the host you run and stops before the next major`,
  };
}

/** The range string for a host, or null when the host is not a semver version. */
export function hostRangeFor(hostVersion) {
  return hostRangePlan(hostVersion)?.range ?? null;
}

/** Readable alias for callers that name the value rather than the operation. */
export const rangeForHost = hostRangeFor;

/**
 * The answer `audit --remote --host` prints for one repository. A missing or
 * malformed range is `unknown`: no statement about the package can be made,
 * whereas a present range that excludes the host is an `incompatible` install.
 */
export function hostCompatibility(range, hostVersion) {
  if (typeof range !== 'string' || range.trim() === '') return 'unknown';
  const answer = satisfiesRange(range, hostVersion);
  if (answer === null) return 'unknown';
  return answer === true ? 'compatible' : 'incompatible';
}
