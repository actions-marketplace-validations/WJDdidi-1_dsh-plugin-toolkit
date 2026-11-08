/**
 * Major-only comparators are a real npm range spelling, not a shorthand for
 * `1.0.0`: `<=1` covers the whole 1.x line, `>1` starts at 2.0.0, and a
 * hyphen range that ends at `2` includes every 2.x release.
 *
 * The compatibility answer used to fill the missing minor with 0 and compute
 * the boundary from it, so `<=1` rejected 1.2.3 and `>1` accepted it — the
 * opposite of what the installer does. These cases pin the missing-component
 * rule against npm semver, including `~>`, the older spelling of `~`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { hostCompatibility } from '../lib/compat.mjs';
import { checkHostRange } from '../lib/doctor.mjs';

test('<=1 includes every 1.x release and excludes the next major', () => {
  assert.equal(hostCompatibility('<=1', '1.2.3'), 'compatible');
  assert.equal(hostCompatibility('<=1', '1.9.9'), 'compatible');
  assert.equal(hostCompatibility('<=1', '2.0.0'), 'incompatible');
});

test('>1 starts at the next major, not at 1.1.0', () => {
  assert.equal(hostCompatibility('>1', '1.2.3'), 'incompatible');
  assert.equal(hostCompatibility('>1', '1.9.9'), 'incompatible');
  assert.equal(hostCompatibility('>1', '2.0.0'), 'compatible');
});

test('a hyphen range ending at a major-only version includes that whole line', () => {
  assert.equal(hostCompatibility('1.2.3 - 2', '2.3.4'), 'compatible');
  assert.equal(hostCompatibility('1.2.3 - 2', '2.9.9'), 'compatible');
  assert.equal(hostCompatibility('1.2.3 - 2', '3.0.0'), 'incompatible');
});

test('~> is the same range as ~', () => {
  assert.equal(hostCompatibility('~>1.2.3', '1.2.9'), 'compatible');
  assert.equal(hostCompatibility('~>1.2.3', '1.3.0'), 'incompatible');
});

test('doctor accepts ~> as a valid engines.dsh range', () => {
  assert.equal(checkHostRange({ engines: { dsh: '~>1.2.3' } }), null);
});
