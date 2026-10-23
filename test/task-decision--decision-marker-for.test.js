'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { decisionMarkerFor } = require('../lib/task-decision');

test('decisionMarkerFor returns [decision] for each hold tag in the primary tag field', () => {
  for (const tag of ['needs-human', 'needshuman', 'decision']) {
    assert.strictEqual(decisionMarkerFor({ id: 't1', tag }), '[decision]', tag);
  }
});

test('decisionMarkerFor finds hold tags in tags[] and metadata.tags', () => {
  assert.strictEqual(decisionMarkerFor({ tags: ['build', 'decision'] }), '[decision]');
  assert.strictEqual(
    decisionMarkerFor({ metadata: { tags: ['ops', 'needs-human'] } }),
    '[decision]'
  );
});

test('decisionMarkerFor finds a hold tag written as #hashtag in the title', () => {
  assert.strictEqual(decisionMarkerFor({ title: 'Pick a vendor #decision' }), '[decision]');
  assert.strictEqual(decisionMarkerFor({ title: 'Pick a vendor #needs-human now' }), '[decision]');
});

test('decisionMarkerFor normalizes case, whitespace, and underscores', () => {
  assert.strictEqual(decisionMarkerFor({ tag: 'NEEDS_HUMAN' }), '[decision]');
  assert.strictEqual(decisionMarkerFor({ tags: ['  Decision  '] }), '[decision]');
  assert.strictEqual(decisionMarkerFor({ title: 'Ship it #Needs-Human' }), '[decision]');
});

test('decisionMarkerFor returns an empty string for tasks with no hold tag', () => {
  assert.strictEqual(decisionMarkerFor({ tag: 'build' }), '');
  assert.strictEqual(decisionMarkerFor({ tags: ['build', 'docs'], metadata: { tags: ['ops'] } }), '');
  assert.strictEqual(decisionMarkerFor({ title: 'Fix the parser #bug' }), '');
});

test('decisionMarkerFor does not match partial tags or the word in plain title text', () => {
  assert.strictEqual(decisionMarkerFor({ tag: 'decisions' }), '');
  assert.strictEqual(decisionMarkerFor({ tags: ['pre-decision'] }), '');
  assert.strictEqual(decisionMarkerFor({ title: 'Make a decision about the vendor' }), '');
});

test('decisionMarkerFor returns an empty string for missing or non-object input', () => {
  assert.strictEqual(decisionMarkerFor(), '');
  assert.strictEqual(decisionMarkerFor(null), '');
  assert.strictEqual(decisionMarkerFor('decision'), '');
  assert.strictEqual(decisionMarkerFor(42), '');
  assert.strictEqual(decisionMarkerFor({}), '');
});

test('decisionMarkerFor tolerates malformed tag fields without throwing', () => {
  assert.strictEqual(decisionMarkerFor({ tags: 'decision' }), '');
  assert.strictEqual(decisionMarkerFor({ metadata: { tags: 'decision' } }), '');
  assert.strictEqual(decisionMarkerFor({ metadata: null, tags: null, tag: null }), '');
  assert.strictEqual(decisionMarkerFor({ tags: [null, undefined, '', 7] }), '');
  assert.strictEqual(decisionMarkerFor({ title: 12345 }), '');
});
