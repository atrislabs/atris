const test = require('node:test');
const assert = require('node:assert/strict');
const { checkSpec } = require('../lib/deck-schema');

// checkSpec only runs the taste lint when the shape is sane. A spec with no
// slides or a non-object root must return just the shape finding and never
// call the lint. A sane spec with no lint function must return [] instead of
// throwing.

function recordingLint(findings) {
  const calls = [];
  const fn = (spec) => {
    calls.push(spec);
    return findings;
  };
  return { fn, calls };
}

const TASTE_FINDING = { severity: 'warn', slide: 1, rule: 'fake-taste', message: 'taste ran' };

test('checkSpec skips the taste lint when the spec has no slides', () => {
  const lint = recordingLint([TASTE_FINDING]);
  const out = checkSpec({ slides: [] }, lint.fn);
  assert.equal(lint.calls.length, 0);
  assert.deepStrictEqual(out, [
    { severity: 'error', slide: 0, rule: 'no-slides', message: 'Spec needs a non-empty "slides" array' },
  ]);
});

test('checkSpec skips the taste lint when the spec root is not an object', () => {
  const lint = recordingLint([TASTE_FINDING]);
  const out = checkSpec('not a spec', lint.fn);
  assert.equal(lint.calls.length, 0);
  assert.deepStrictEqual(out, [
    { severity: 'error', slide: 0, rule: 'spec-shape', message: 'Spec must be a JSON object' },
  ]);
});

test('checkSpec returns no taste findings when a sane spec has no lint function', () => {
  const spec = { slides: [{ type: 'title', headline: 'Hello' }] };
  assert.deepStrictEqual(checkSpec(spec, undefined), []);
});

test('checkSpec merges taste findings after schema findings for a sane spec', () => {
  const lint = recordingLint([TASTE_FINDING]);
  const spec = { slides: [{ type: 'title', headline: 'Hello' }] };
  const out = checkSpec(spec, lint.fn);
  assert.equal(lint.calls.length, 1);
  assert.deepStrictEqual(out, [TASTE_FINDING]);
});
