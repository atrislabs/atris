'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { jobTakesAnyEngine } = require('../lib/engine-registry');

test('notes accepts any engine while ordinary and unknown jobs do not', () => {
  assert.strictEqual(jobTakesAnyEngine('notes'), true);
  for (const key of ['search', 'build', 'review', 'navigator', 'executor', 'validator', 'small-build', 'unknown-job']) {
    assert.strictEqual(jobTakesAnyEngine(key), false, key);
  }
});

test('job keys require exact spelling without trimming or case normalization', () => {
  for (const key of ['Notes', 'NOTES', ' notes', 'notes ', 'notes\n', 'note']) {
    assert.strictEqual(jobTakesAnyEngine(key), false, JSON.stringify(key));
  }
});

test('missing and empty inputs do not accept any engine', () => {
  assert.strictEqual(jobTakesAnyEngine(), false);
  for (const key of [undefined, null, '', false, 0, NaN]) {
    assert.strictEqual(jobTakesAnyEngine(key), false, String(key));
  }
});

test('inherited object property names are not registered jobs', () => {
  for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    assert.strictEqual(jobTakesAnyEngine(key), false, key);
  }
});
