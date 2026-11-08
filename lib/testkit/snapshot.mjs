/**
 * DOM snapshots, not pixels.
 *
 * A rasterised baseline needs a browser; the DOM does not. Normalising the
 * markup (class order, whitespace, generated ids) gives a baseline that fails
 * for the same reasons a screenshot would — a missing class, a lost label, a
 * control that stopped rendering — and can be reviewed in a diff.
 */
import fs from 'node:fs';
import path from 'node:path';

const NOISE = /\s+/g;

export function normalize(html) {
  return html
    .replace(/<!--.*?-->/g, '')
    .replace(/ data-react[a-z-]*="[^"]*"/g, '')
    .replace(/ aria-describedby="[^"]*"/g, '')
    .replace(/\s+class="([^"]*)"/g, (match, value) => ` class="${value.split(NOISE).filter(Boolean).sort().join(' ')}"`)
    .replace(/>\s+</g, '><')
    .replace(NOISE, ' ')
    .trim();
}

export function snapshotPath(dir, name) {
  return path.join(dir, `${name}.html`);
}

/** Compares, and on mismatch says which line moved instead of dumping two walls. */
export function compare(dir, name, html) {
  const file = snapshotPath(dir, name);
  const actual = normalize(html);
  if (fs.existsSync(file) === false) return { file, status: 'missing', actual };
  const expected = fs.readFileSync(file, 'utf8').trim();
  if (expected === actual) return { file, status: 'same', actual };
  const expectedLines = expected.split(/(?=<)/);
  const actualLines = actual.split(/(?=<)/);
  const index = expectedLines.findIndex((line, position) => line !== actualLines[position]);
  return { file, status: 'changed', expected, actual, firstDifference: Math.max(0, index) };
}

export function write(dir, name, html) {
  const file = snapshotPath(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${normalize(html)}\n`);
  return file;
}

/**
 * The assertion form of `compare`, so a baseline test reads like a test and
 * fails with the thing that moved rather than two walls of markup.
 */
export function expectSnapshot(html, dir, name) {
  const result = compare(dir, name, html);
  if (result.status === 'same') return result;
  // Writing is opt-in: an ordinary run must never turn a missing or changed
  // baseline into a pass. `UPDATE_SNAPSHOTS=1` is the documented decision.
  if (process.env.UPDATE_SNAPSHOTS === '1') {
    return { file: write(dir, name, html), status: 'written', actual: result.actual };
  }
  if (result.status === 'missing') {
    throw new Error(`no baseline at ${result.file}; run with UPDATE_SNAPSHOTS=1 to create it`);
  }
  const expected = result.expected.split(/(?=<)/);
  const actual = result.actual.split(/(?=<)/);
  const position = result.firstDifference;
  throw new Error([
    `${name} changed at element ${position}`,
    `  expected: ${expected[position] ?? '(nothing)'}`,
    `  actual:   ${actual[position] ?? '(nothing)'}`,
    `  baseline: ${result.file}`,
  ].join('\n'));
}
