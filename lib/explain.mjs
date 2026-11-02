/**
 * `explain` turns the error text people actually paste into a cause.
 *
 * The demand for this came from the ecosystem, not from imagination: a plugin
 * hub files a failed install back into the plugin's own repository, and 61
 * repositories were carrying those reports on 2026-11-02. Each report starts
 * with the same four sentences, and every one of them is a symptom whose cause
 * `doctor` already knows how to find — but nothing connected the two. An author
 * who reads "plugin install failed" has no way to learn that it means their
 * tarball ships no `client.js`.
 *
 * The patterns are deliberately narrow. A wrong diagnosis sends someone editing
 * the wrong file, so text that matches nothing gets "no known cause" and the
 * exit code 2, not a guess.
 */

export const CAUSES = [
  {
    id: 'version',
    symptom: 'the installer rejects the plugin before unpacking it',
    match: /does not support the DSH version in use|incompatible with dsh|no matching version|unsupported engine/i,
    cause: 'engines.dsh is missing, or the range it declares excludes the host doing the install',
    check: 'engines.dsh',
    fix: 'declare the range you actually support: "engines": { "dsh": ">=0.2.0" }',
  },
  {
    id: 'packaging',
    symptom: 'the install fails while preparing or building the package',
    match: /distribution incomplete|prepare\/build script failed|prepublish|prepare script|build script failed/i,
    cause: 'the published tarball does not contain the files package.json points at',
    check: 'files list',
    fix: 'list every entry point in "files" (index.js, client.js, cordis.patch.yml) and re-publish',
  },
  {
    id: 'conflict',
    symptom: 'the plugin is installed but the loader refuses its entry',
    match: /failed to apply loader entry|already registered|duplicate (id|entry|registration)/i,
    cause: 'two plugins register the same id or slot, so the second one cannot apply',
    check: 'patch file',
    fix: 'give the row in cordis.patch.yml a unique id, and do not re-register a slot another plugin owns',
  },
  {
    id: 'install',
    symptom: 'the install command exits non-zero without saying why',
    match: /plugin install failed|installation failed/i,
    cause: 'the generic wrapper message: the real cause is one of the three above, or a network/proxy failure',
    check: 'version, files list, patch file',
    fix: 'run `dsh-plugin doctor <dir>` on the plugin checkout; the failing line names the cause',
  },
];

export function explain(text) {
  const input = typeof text === 'string' ? text : '';
  const matched = CAUSES.filter((cause) => cause.match.test(input));
  return {
    text: input,
    matched: matched.map(({ match, ...rest }) => rest),
  };
}

/**
 * A hub report points at its log file rather than at one pasteable sentence, so
 * `explain --log` scans the file from the bottom. The bottom is deliberate: the
 * installer often prints the generic `plugin install failed` first and the
 * specific reason after it, so the last known line is the one worth explaining.
 */
export function lastCauseLine(text) {
  const input = typeof text === 'string' ? text : '';
  const lines = input.split(/\r\n|\n|\r/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line === '') continue;
    const result = explain(line);
    if (result.matched.length > 0) {
      return { ...result, lineNumber: index + 1 };
    }
  }
  return { text: '', lineNumber: null, matched: [] };
}

/**
 * `verdict` adds what the checkout says about the predicted cause, so the answer
 * is "your tarball is missing client.js" rather than "it might be packaging".
 */
export function verdict(result, failures) {
  const wanted = new Set(result.matched.flatMap((cause) => cause.check.split(', ')));
  const hits = (failures ?? []).filter((failure) => wanted.has(failure.check));
  return { wanted: [...wanted], hits };
}
